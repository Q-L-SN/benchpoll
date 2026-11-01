import test from 'node:test';
import { TOPIC_SCENE_SQL_PREVIEW } from '../topic-scenes-service.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import mysql from 'mysql2';
import { createTopicProposalService, normalizeTopicProposalRequest, approveTopicSceneProposal,
    lockTopicProposalForReview, finishTopicProposalReview } from '../topic-proposal-service.js';
import { sceneDatabase } from './helpers/topic-scenes-fixture-20261031.mjs';

const errorIs = code => error => error.body?.error === code;
function harness() {
    const h = sceneDatabase(), queued = [];
    h.seedContext(172, 1095); h.seedContext(173, 1096);
    const service = createTopicProposalService({ pool: h.pool, queueForReview: async (_connection, proposal) => {
        queued.push(structuredClone(proposal)); return 5000 + proposal.ID;
    } });
    return { ...h, service, queued };
}
const request = (parentTopicID = 172) => ({ parentTopicID, name: 'General', description: 'Overall capability.' });

test('proposal shape accepts a topic parent, rejects a scene parent and preserves ordinary topic normalization', () => {
    assert.deepEqual(normalizeTopicProposalRequest(request()), request());
    assert.deepEqual(normalizeTopicProposalRequest({ name: 'New field', description: 'Useful capability.' }),
        { name: 'New field', description: 'Useful capability.' });
    for (const patch of [{ parentTopicID: '172' }, { parentSceneID: 42 }, { isDefault: true }, { children: [] }]) {
        assert.throws(() => normalizeTopicProposalRequest({ ...request(), ...patch }));
    }
});

test('scene proposals use per-parent reservations and share the existing author quota', async () => {
    const h = harness();
    const first = await h.service.propose('42', request(), randomUUID());
    assert.equal(first.kind, 'scene'); assert.equal(first.parentTopicID, 172); assert.equal(first.status, 'open');
    assert.equal(first.sceneID, null); assert.equal(first.url, null);
    assert.equal(h.state.scenes.length, 0, 'Proposing never publishes a scene');
    await assert.rejects(h.service.propose('42', request(173), randomUUID()), errorIs('active_topic_proposal_limit'));
    const other = await h.service.propose('43', request(173), randomUUID());
    assert.equal(other.name, 'General'); assert.equal(other.parentTopicID, 173);
    await assert.rejects(h.service.propose('100', request(), randomUUID()), errorIs('topic_proposal_exists'));
    assert.ok(h.state.proposals.every(row => row.reservation_name === null && row.scene_reservation_name === 'General'));
});

test('guests, private parents and non-topic identities cannot create public scenes', async () => {
    const h = harness();
    await assert.rejects(h.service.propose(null, request(), randomUUID()), errorIs('authentication_required'));
    await assert.rejects(h.service.propose('42', request(501), randomUUID()), errorIs('topic_not_found'));
    await assert.rejects(h.service.propose('42', request(1095), randomUUID()), errorIs('topic_not_found'));
    assert.equal(h.state.proposals.length, 0);
});

test('thirty supports enqueue one review with parent identity, then approved scene retains context identity and URL', async () => {
    const h = harness();
    const proposal = await h.service.propose('42', request(), randomUUID());
    for (let index = 0; index < 30; index++) {
        await h.service.support(String(100 + index), { proposalID: proposal.proposalID, revision: 1 }, randomUUID());
    }
    assert.equal(h.queued.length, 1); assert.equal(h.queued[0].parent_topic_ID, 172);
    const row = h.state.proposals[0], connection = await h.pool.getConnection();
    await connection.beginTransaction();
    const created = await approveTopicSceneProposal(connection, { ...request(), proposalID: row.ID },
        { moderationLogID: row.moderation_log_ID, submittedBy: '42' });
    await connection.commit(); connection.release();
    assert.equal(created.sceneID, 1095); assert.equal(row.status, 'approved');
    assert.equal(row.scene_context_ID, 1095); assert.equal(row.topic_ID, null);
    const page = await h.service.list('42');
    assert.equal(page.proposals[0].url, '/image-generation?scene=1095');
});

test('editing a scene proposal resets support without changing its parent, and reviewer edits are respected', async () => {
    const h = harness(), proposal = await h.service.propose('42', request(), randomUUID());
    await h.service.support('100', { proposalID: proposal.proposalID, revision: 1 }, randomUUID());
    const edited = await h.service.edit('42', { proposalID: proposal.proposalID, revision: 1,
        name: 'Vector output', description: 'Create vector images.' }, randomUUID());
    assert.equal(edited.parentTopicID, 172); assert.equal(edited.supportCount, 0); assert.equal(edited.revision, 2);
    const row = h.state.proposals[0]; row.status = 'pending'; row.moderation_log_ID = 99;
    h.state.votes = Array.from({ length: 30 }, (_, index) => ({ proposal_ID: row.ID, user_ID: String(100 + index) }));
    const connection = await h.pool.getConnection(); await connection.beginTransaction();
    const created = await approveTopicSceneProposal(connection, { proposalID: row.ID, parentTopicID: 172,
        name: 'Vector graphics', description: 'Produce editable vector graphics.' }, { moderationLogID: 99, submittedBy: '42' });
    await connection.commit(); connection.release();
    assert.equal(h.state.scenes.find(scene => scene.context_ID === created.sceneID).name, 'Vector graphics');
    assert.equal(h.state.scenes.filter(scene => scene.category_ID === 172 && scene.is_default).length, 1);
});

test('review mismatch, missing supports and mistaken ordinary-topic completion are rejected', async () => {
    const h = harness(), proposal = await h.service.propose('42', request(), randomUUID());
    const row = h.state.proposals[0]; row.status = 'pending'; row.moderation_log_ID = 99;
    const metadata = { moderationLogID: 99, submittedBy: '42' };
    await assert.rejects(lockTopicProposalForReview(h.pool, { ...request(173), proposalID: proposal.proposalID }, metadata), errorIs('topic_proposal_review_mismatch'));
    await assert.rejects(lockTopicProposalForReview(h.pool, { ...request(), proposalID: proposal.proposalID }, metadata), errorIs('topic_proposal_threshold_required'));
    await assert.rejects(finishTopicProposalReview(h.pool, row, 'approved', 172), errorIs('invalid_topic_proposal_decision'));
    await finishTopicProposalReview(h.pool, row, 'rejected');
    assert.equal(row.status, 'rejected'); assert.equal(row.scene_context_ID, null);
});

test('read-only moderation preview supports synthetic negative INSERT IDs without changing state', async () => {
    const h = harness(), proposal = await h.service.propose('42', { ...request(), name: 'Vector output' }, randomUUID());
    const row = h.state.proposals[0]; row.status = 'pending'; row.moderation_log_ID = 99;
    h.state.votes = Array.from({ length: 30 }, (_, index) => ({ proposal_ID: row.ID, user_ID: String(100 + index) }));
    const before = structuredClone(h.state), recorded = [];
    let ID = -1;
    const recorder = { [TOPIC_SCENE_SQL_PREVIEW]: true, async execute(sql, args) {
        recorded.push({ sql, args });
        if (/^\s*SELECT/.test(sql)) return h.pool.execute(sql.replace(/\s+FOR (UPDATE|SHARE)\s*$/i, ''), args);
        return [{ affectedRows: 1, insertId: /^\s*INSERT/.test(sql) ? ID-- : 0 }];
    } };
    const result = await approveTopicSceneProposal(recorder, { ...request(), name: 'Vector output', proposalID: proposal.proposalID },
        { moderationLogID: 99, submittedBy: '42' });
    assert.ok(result.sceneID < 0); assert.deepEqual(h.state, before);
    assert.ok(recorded.some(row => row.sql.includes('scene_context_ID = ?') && row.args[1] === result.sceneID));
});

test('real connections and JSON-shaped preview flags cannot approve or persist negative context identities', async () => {
    const h = harness(), body = { ...request(), name: 'Vector output' }, proposal = await h.service.propose('42', body, randomUUID());
    const row = h.state.proposals[0]; row.status = 'pending'; row.moderation_log_ID = 99;
    h.state.votes = Array.from({ length: 30 }, (_, index) => ({ proposal_ID: row.ID, user_ID: String(100 + index) }));
    for (const flags of [{}, { allowSynthetic: true }, { TOPIC_SCENE_SQL_PREVIEW: true }, { preview: true, simulation: true }]) {
        const writes = [];
        const connection = { ...flags, async execute(sql, args = []) {
            if (/^\s*SELECT/.test(sql)) return h.pool.execute(sql.replace(/\s+FOR (UPDATE|SHARE)\s*$/i, ''), args);
            writes.push({ sql, args });
            return [{ affectedRows: 1, insertId: /^\s*INSERT/.test(sql) ? -1 : 0 }];
        } };
        await assert.rejects(approveTopicSceneProposal(connection, { ...body, proposalID: proposal.proposalID },
            { moderationLogID: 99, submittedBy: '42', preview: true }), errorIs('invalid_scene_id'));
        assert.equal(writes.some(write => write.args.includes(-1) || write.args.includes('{"scene":"-1"}')), false);
        await assert.rejects(finishTopicProposalReview(connection, row, 'approved', null, { sceneID: -1 }), errorIs('invalid_topic_proposal_decision'));
        await assert.rejects(finishTopicProposalReview(connection, { ...row, parent_topic_ID: null }, 'approved', -1), errorIs('invalid_topic_proposal_decision'));
    }
    assert.equal(row.status, 'pending'); assert.equal(h.state.scenes.length, 0);
});

test('the actual server preview recorder marks only its non-writing connection for scene approval', async () => {
    const h = harness(), body = { ...request(), name: 'Vector output' };
    const proposal = await h.service.propose('42', body, randomUUID());
    const row = h.state.proposals[0]; row.status = 'pending'; row.moderation_log_ID = 99;
    h.state.votes = Array.from({ length: 30 }, (_, index) => ({ proposal_ID: row.ID, user_ID: String(100 + index) }));
    const before = structuredClone(h.state), source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function buildExecutedModerationSQLPreview(');
    const end = source.indexOf('function moderationTimestamp(', start);
    assert.ok(start >= 0 && end > start);
    const context = vm.createContext({ mysql, TOPIC_SCENE_SQL_PREVIEW, applyModerationContent: approveTopicSceneProposal });
    vm.runInContext(source.slice(start, end), context);
    const connection = { async execute(sql, args) {
        assert.match(sql, /^SELECT/);
        assert.doesNotMatch(sql, /FOR (UPDATE|SHARE)\s*$/i);
        return h.pool.execute(sql, args);
    } };
    const sql = await context.buildExecutedModerationSQLPreview(connection, 99, { ...body, proposalID: proposal.proposalID }, false, '42');
    assert.match(sql, /INSERT INTO topic_scenes/);
    assert.match(sql, /scene_context_ID = -[1-9]\d*/);
    assert.equal(connection[TOPIC_SCENE_SQL_PREVIEW], undefined, 'The real connection never receives the preview capability');
    assert.deepEqual(h.state, before);
});
