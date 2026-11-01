import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

export async function rehearseProposalLimits(connection, settings, createService) {
    const [[database]] = await connection.query('SELECT DATABASE() AS name');
    if (!/^benchpoll_accounts_rehearsal_\d+$/.test(database.name)) throw new Error('Business rehearsal requires a release-owned isolated database');
    const [[clock]] = await connection.query('SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) AS seconds');
    const seconds = Number(clock.seconds);
    await connection.query('SET timestamp = ?', [seconds]);
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COALESCE(GENERATION_EXPRESSION, '') = '' ORDER BY ORDINAL_POSITION`);
    if (!columns.length || columns.some(column => !/^[a-zA-Z0-9_]+$/.test(column.name))) throw new Error('Unsafe rehearsal user columns');
    const fields = columns.map(column => `\`${column.name}\``).join(', ');
    const ids = Array.from({ length: 45 }, (_, index) => String(900000000000000001n + BigInt(index)));
    const expressions = columns.map(column => ['ID', 'name', 'email'].includes(column.name) ? '?'
        : column.name === 'email_verified_at' ? 'CURRENT_TIMESTAMP(3)'
            : ['deleted_at', 'banned_at', 'banned_until', 'banned_reason'].includes(column.name) ? 'NULL' : `\`${column.name}\``).join(', ');
    for (const [index, id] of ids.entries()) {
        const values = columns.flatMap(column => column.name === 'ID' ? [id]
            : column.name === 'name' ? [`Proposal fixture ${index}`] : column.name === 'email' ? [`fixture-${index}@example.invalid`] : []);
        const [inserted] = await connection.execute(`INSERT INTO users (${fields}) SELECT ${expressions} FROM users ORDER BY ID LIMIT 1`, values);
        assert.equal(Number(inserted.affectedRows), 1, 'An existing account template is required');
    }
    const pool = mysql.createPool({ ...settings, database: database.name, connectionLimit: 12 });
    const fixturePool = {
        async getConnection() { const lease = await pool.getConnection(); await lease.query('SET timestamp = ?', [seconds]); return lease; },
        async execute(sql, values) {
            const lease = await this.getConnection();
            try { return await lease.execute(sql, values); } finally { lease.release(); }
        }
    };
    let failQueue = false;
    const service = createService({ pool: fixturePool, async queueForReview(db, proposal) {
        const [inserted] = await db.execute('INSERT INTO moderation_logs (content, report_count, user_id) VALUES (?, 1, ?)',
            [JSON.stringify({ type: 'new_topic', proposalID: Number(proposal.ID), name: proposal.name, description: proposal.description }), proposal.user_ID]);
        if (failQueue) throw new Error('Isolated queue failure');
        return Number(inserted.insertId);
    } });
    const draft = name => ({ name: `Fixture ${name}`, description: 'An isolated proposal limits check.' });
    const vote = (userID, proposal, key = randomUUID()) => service.support(userID, { proposalID: proposal.proposalID, revision: proposal.revision }, key);
    const cancel = (userID, proposal) => service.cancelSupport(userID, { proposalID: proposal.proposalID, revision: proposal.revision }, randomUUID());
    const withdraw = (userID, proposal) => service.withdraw(userID, { proposalID: proposal.proposalID, revision: proposal.revision }, randomUUID());
    const expect = (error, code) => error.body?.error === code;
    try {
        const creations = await Promise.allSettled(['parallel one', 'parallel two'].map(name => service.propose(ids[0], draft(name), randomUUID())));
        assert.equal(creations.filter(result => result.status === 'fulfilled').length, 1);
        assert.ok(creations.some(result => result.status === 'rejected' && expect(result.reason, 'active_topic_proposal_limit')));
        const own = creations.find(result => result.status === 'fulfilled').value;
        await withdraw(ids[0], own);
        const targets = await Promise.all(ids.slice(1, 5).map((id, index) => service.propose(id, draft(`target ${index}`), randomUUID())));
        const keys = targets.map(() => randomUUID());
        const votes = await Promise.allSettled(targets.map((proposal, index) => vote(ids[8], proposal, keys[index])));
        assert.equal(votes.filter(result => result.status === 'fulfilled').length, 3);
        assert.ok(votes.some(result => result.status === 'rejected' && expect(result.reason, 'topic_proposal_support_limit')));
        assert.equal((await service.list(ids[8])).account.activeSupports, 3);
        const supported = votes.findIndex(result => result.status === 'fulfilled');
        const blocked = votes.findIndex(result => result.status === 'rejected');
        await cancel(ids[8], targets[supported]);
        await vote(ids[8], targets[blocked]);
        assert.equal((await service.list(ids[8])).account.activeSupports, 3);

        const edited = await service.edit(ids[blocked + 1], { proposalID: targets[blocked].proposalID,
            revision: 1, ...draft('edited target') }, randomUUID());
        assert.equal(edited.expiresAt, targets[blocked].expiresAt);
        assert.equal(edited.revision, 2); assert.equal(edited.supportCount, 0);
        assert.equal((await service.list(ids[8])).account.activeSupports, 2);
        await assert.rejects(vote(ids[8], targets[blocked]), error => expect(error, 'topic_proposal_changed'));
        await vote(ids[8], edited);
        const staleReplay = await vote(ids[8], targets[supported], keys[supported]);
        assert.equal(staleReplay.supported, false, 'A prior intent cannot reapply a canceled support');

        const boundary = await service.propose(ids[5], draft('deadline boundary'), randomUUID());
        await connection.execute('UPDATE topic_proposals SET created_at = FROM_UNIXTIME(?), updated_at = updated_at WHERE ID = ?',
            [seconds - 14 * 86400 + .001, boundary.proposalID]);
        await vote(ids[9], boundary);
        await connection.execute('UPDATE topic_proposals SET created_at = FROM_UNIXTIME(?), updated_at = updated_at WHERE ID = ?',
            [seconds - 14 * 86400, boundary.proposalID]);
        await assert.rejects(vote(ids[10], boundary), error => expect(error, 'topic_proposal_expired'));
        assert.equal((await service.list(ids[5])).account.activeProposalID, null);
        assert.equal((await service.list(ids[9])).account.activeSupports, 0);
        assert.equal((await service.list(null)).proposals.find(row => row.proposalID === boundary.proposalID).status, 'expired');
        await service.propose(ids[5], draft('after expiration'), randomUUID());

        const pending = await service.propose(ids[0], draft('review boundary'), randomUUID());
        const promoted = await Promise.allSettled(ids.slice(10, 42).map(id => vote(id, pending)));
        assert.equal(promoted.filter(result => result.status === 'fulfilled').length, 30);
        const state = (await service.list(ids[0])).proposals.find(row => row.proposalID === pending.proposalID);
        assert.equal(state.status, 'pending'); assert.equal(state.supportCount, 30);
        assert.equal((await service.list(ids[0])).account.activeProposalID, null);
        assert.equal((await service.list(ids[10])).account.activeSupports, 0);
        await assert.rejects(cancel(ids[10], pending), error => expect(error, 'topic_proposal_not_open'));
        await service.propose(ids[0], draft('after review promotion'), randomUUID());

        const rollback = await service.propose(ids[6], draft('queue rollback'), randomUUID());
        for (const id of ids.slice(10, 39)) await vote(id, rollback);
        failQueue = true;
        const retryKey = randomUUID();
        await assert.rejects(vote(ids[39], rollback, retryKey), /Isolated queue failure/);
        const beforeRetry = (await service.list(ids[6])).proposals.find(row => row.proposalID === rollback.proposalID);
        assert.equal(beforeRetry.status, 'open'); assert.equal(beforeRetry.supportCount, 29);
        failQueue = false;
        assert.equal((await vote(ids[39], rollback, retryKey)).status, 'pending');
        return { passed: true, checks: ['one concurrent proposal', 'three concurrent supports', 'cancel releases quota',
            'edits reset votes without extension', 'stale revision and intent safety', 'exact 14-day boundary',
            'pending releases both quotas', 'one threshold promotion', 'queue failure rollback and retry'] };
    } finally { await pool.end(); }
}
