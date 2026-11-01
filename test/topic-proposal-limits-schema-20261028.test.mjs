import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureTopicProposalLimitsSchema, serializeTopicProposal } from '../topic-proposal-service.js';
import { TOPIC_PROPOSAL_LIMITS_MIGRATION, verifyTopicProposalLimitsSchema } from '../scripts/migrate-topic-proposal-limits-20261028.mjs';

function migrationFixture({ base = true, revision = false, withdrawn = false } = {}) {
    const columns = new Map(base ? [
        ['ID', { name: 'ID', type: 'int unsigned', nullable: 'NO', defaultValue: null }],
        ['created_at', { name: 'created_at', type: 'datetime(3)', nullable: 'NO', defaultValue: 'CURRENT_TIMESTAMP(3)' }]
    ] : []);
    if (revision) columns.set('revision', { name: 'revision', type: 'int unsigned', nullable: 'NO', defaultValue: '1' });
    if (withdrawn) columns.set('withdrawn_at', { name: 'withdrawn_at', type: 'datetime(3)', nullable: 'YES', defaultValue: null });
    const proposals = ['open', 'pending', 'approved', 'rejected'].map((status, index) => ({ ID: index + 1,
        user_ID: '9007199254740993', name: `Preserved proposal ${index}`, status,
        created_at: '2026-10-10T00:00:00.000Z', moderation_log_ID: index ? index + 10 : null,
        topic_ID: status === 'approved' ? 20 : null, ...(revision ? { revision: 2 } : {}), ...(withdrawn ? { withdrawn_at: null } : {}) }));
    const votes = [{ proposal_ID: 1, user_ID: '9007199254740992' }, { proposal_ID: 2, user_ID: '99' }], calls = [];
    const db = {
        async execute(sql) {
            const statement = sql.replace(/\s+/g, ' ').trim(); calls.push(statement);
            if (statement.includes('information_schema.COLUMNS')) {
                return [[...columns.values()].filter(column => !statement.includes('AND COLUMN_NAME IN')
                    || ['revision', 'withdrawn_at'].includes(column.name)).map(column => structuredClone(column))];
            }
            if (statement.startsWith('SELECT COUNT(*) AS count FROM topic_proposals')) {
                return [[{ count: proposals.filter(proposal => proposal.revision < 1
                    || proposal.withdrawn_at != null && proposal.status !== 'open').length }]];
            }
            assert.fail(`Unexpected migration query: ${statement}`);
        },
        async query(sql) {
            calls.push(sql);
            if (sql === 'ALTER TABLE topic_proposals ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 1') {
                assert.equal(columns.has('revision'), false);
                columns.set('revision', { name: 'revision', type: 'int unsigned', nullable: 'NO', defaultValue: 1 });
                for (const proposal of proposals) proposal.revision = 1;
            } else if (sql === 'ALTER TABLE topic_proposals ADD COLUMN withdrawn_at DATETIME(3) NULL') {
                assert.equal(columns.has('withdrawn_at'), false);
                columns.set('withdrawn_at', { name: 'withdrawn_at', type: 'datetime(3)', nullable: 'YES', defaultValue: null });
                for (const proposal of proposals) proposal.withdrawn_at = null;
            } else assert.fail(`Unexpected migration mutation: ${sql}`);
            return [{}];
        }
    };
    return { db, columns, calls, proposals, votes };
}

test('limits migration adds exactly revision and withdrawal metadata while preserving proposals, decisions and votes', async () => {
    const h = migrationFixture(), before = structuredClone({ proposals: h.proposals, votes: h.votes });
    const result = await ensureTopicProposalLimitsSchema(h.db);
    assert.deepEqual(result, { migration: TOPIC_PROPOSAL_LIMITS_MIGRATION, addedColumns: ['revision', 'withdrawn_at'],
        verified: true, columns: ['revision', 'withdrawn_at'] });
    assert.deepEqual(h.proposals, before.proposals.map(proposal => ({ ...proposal, revision: 1, withdrawn_at: null })));
    assert.deepEqual(h.votes, before.votes);
    assert.equal(h.calls.filter(sql => sql.startsWith('ALTER TABLE')).length, 2);
    assert.ok(h.calls.every(sql => /^(SELECT|ALTER TABLE topic_proposals ADD COLUMN)\b/.test(sql)));
    const second = await ensureTopicProposalLimitsSchema(h.db);
    assert.equal(second.verified, true); assert.deepEqual(second.addedColumns, []);
    assert.equal(h.calls.filter(sql => sql.startsWith('ALTER TABLE')).length, 2);
});

test('a partially applied limits migration adds only the absent column and preserves existing revisions', async () => {
    for (const options of [{ revision: true }, { withdrawn: true }]) {
        const h = migrationFixture(options), before = structuredClone(h.proposals);
        const result = await ensureTopicProposalLimitsSchema(h.db);
        assert.deepEqual(result.addedColumns, options.revision ? ['withdrawn_at'] : ['revision']);
        assert.equal(h.calls.filter(sql => sql.startsWith('ALTER TABLE')).length, 1);
        assert.deepEqual(h.proposals, before.map(proposal => options.revision ? { ...proposal, withdrawn_at: null } : { ...proposal, revision: 1 }));
    }
});

test('the limits hook refuses a missing base schema without attempting DDL', async () => {
    const h = migrationFixture({ base: false });
    await assert.rejects(ensureTopicProposalLimitsSchema(h.db), /Base topic proposal schema must be prepared first/);
    assert.equal(h.calls.length, 1); assert.equal(h.calls.some(sql => sql.startsWith('ALTER')), false);
});

test('limits verification rejects missing metadata and incompatible types, defaults or nullability', async () => {
    const patches = [
        columns => columns.delete('revision'), columns => columns.delete('withdrawn_at'),
        columns => { columns.get('revision').type = 'int'; },
        columns => { columns.get('revision').type = 'bigint unsigned'; },
        columns => { columns.get('revision').defaultValue = 0; },
        columns => { columns.get('revision').nullable = 'YES'; },
        columns => { columns.get('withdrawn_at').type = 'datetime'; },
        columns => { columns.get('withdrawn_at').nullable = 'NO'; }
    ];
    for (const patch of patches) {
        const h = migrationFixture({ revision: true, withdrawn: true }); patch(h.columns);
        await assert.rejects(verifyTopicProposalLimitsSchema(h.db), /schema is missing or incompatible/);
        assert.equal(h.calls.length, 1, 'Reject incompatible columns before reading proposal data');
    }
    const h = migrationFixture({ revision: true, withdrawn: true });
    h.columns.get('revision').type = 'INT(10) UNSIGNED';
    assert.equal((await verifyTopicProposalLimitsSchema(h.db)).verified, true);
});

test('limits verification rejects zero revisions and withdrawals on reviewed or pending proposals', async () => {
    for (const status of ['pending', 'approved', 'rejected']) {
        const h = migrationFixture({ revision: true, withdrawn: true });
        h.proposals.find(proposal => proposal.status === status).withdrawn_at = '2026-10-28T00:00:00.000Z';
        await assert.rejects(verifyTopicProposalLimitsSchema(h.db), /Invalid proposal revision or withdrawal state/);
    }
    const h = migrationFixture({ revision: true, withdrawn: true }); h.proposals[0].revision = 0;
    await assert.rejects(verifyTopicProposalLimitsSchema(h.db), /Invalid proposal revision or withdrawal state/);
    h.proposals[0].revision = 1; h.proposals[0].withdrawn_at = '2026-10-28T00:00:00.000Z';
    assert.equal((await verifyTopicProposalLimitsSchema(h.db)).verified, true);
});

test('limits migration defaults to a disconnected plan and fails apply without a backup before connecting', () => {
    const script = fileURLToPath(new URL('../scripts/migrate-topic-proposal-limits-20261028.mjs', import.meta.url));
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8',
        env: { ...process.env, BENCHPOLL_DB_NAME: 'not_a_rehearsal_database', BENCHPOLL_DB_HOST: 'invalid.example.test' } });
    const plan = run([]); assert.equal(plan.status, 0);
    assert.deepEqual(JSON.parse(plan.stdout), { migration: TOPIC_PROPOSAL_LIMITS_MIGRATION, dryRun: true,
        alters: ['topic_proposals.revision', 'topic_proposals.withdrawn_at'], dataRewritten: false });
    const apply = run(['--apply']); assert.notEqual(apply.status, 0); assert.match(apply.stderr, /fresh backup manifest is required/);
    const conflict = run(['--apply', '--check']); assert.notEqual(conflict.status, 0); assert.match(conflict.stderr, /Choose --check or --apply/);
});

test('serializer fails closed on missing or invalid deadline and revision metadata', () => {
    const row = { ID: 1, user_ID: '42', name: 'Clinical reasoning', description: 'A summary.', support_count: 0,
        supported: 0, status: 'open', revision: 1, created_at: new Date('2026-10-28T00:00:00.000Z'),
        withdrawn_at: null, moderation_log_ID: null, topic_ID: null };
    for (const patch of [{ revision: undefined }, { revision: null }, { revision: 0 }, { revision: -1 }, { revision: 1.5 },
        { revision: Number.MAX_SAFE_INTEGER + 1 }, { created_at: undefined }, { created_at: 'not-a-date' }, { expires_at_ms: NaN }]) {
        assert.throws(() => serializeTopicProposal({ ...row, ...patch }), error => error.status === 503
            && error.body?.error === 'topic_proposal_metadata_invalid');
    }
    const result = serializeTopicProposal({ ...row, created_at: undefined, revision: '2',
        expires_at_ms: Date.parse('2026-11-11T00:00:00.000Z'), effective_status: 'expired' }, '42');
    assert.equal(result.revision, 2); assert.equal(result.expiresAt, '2026-11-11T00:00:00.000Z');
    assert.equal(result.isMine, true); assert.equal(result.canEdit, false); assert.equal(result.canWithdraw, false);
});

test('both schema hooks remain explicit offline delegations with no runtime invocation', async () => {
    const service = await readFile(new URL('../topic-proposal-service.js', import.meta.url), 'utf8');
    const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    for (const hook of ['ensureTopicProposalSchema', 'ensureTopicProposalLimitsSchema']) {
        assert.equal((service.match(new RegExp(`${hook}\\(`, 'g')) ?? []).length, 2);
        assert.doesNotMatch(server, new RegExp(`${hook}\\(`));
    }
    assert.match(service, /export async function ensureTopicProposalSchema\(connection\)[\s\S]*?migrate-topic-proposals-20261027\.mjs/);
    assert.match(service, /export async function ensureTopicProposalLimitsSchema\(connection\)[\s\S]*?migrate-topic-proposal-limits-20261028\.mjs/);
});
