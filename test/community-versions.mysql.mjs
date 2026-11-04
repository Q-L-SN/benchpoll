import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { savePersonalPie, getRankingWorkspace, loadPersonalPie } from '../ranking-service.js';
import { ensureTopicRootContext } from '../topic-scenes-service.js';
import { inspectCommunityVersions, migrateCommunityVersions } from '../scripts/migrate-community-versions-20261103.mjs';
import { createRankingPager } from '../ranking-pagination.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { savePrivateTopic } from '../private-topic-service.js';
import { captureTopicSnapshot, createProposalPreviewService, seedSnapshotTopic } from '../topic-snapshot-service.js';
import { createTopicProposalService, readProposal } from '../topic-proposal-service.js';

test('real MySQL saves abstention, recalculates inherited versions, and expands topic references', { timeout: 60000 }, async t => {
    const database = await createLifecycleDatabase(); t.after(() => database.close());
    const db = database.pool;
    await seedLifecycleEvidence(db);
    await db.execute(`INSERT INTO benchmark_conditions
        (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_default, is_primary)
        VALUES (4, 1, 'extended', 'Extended', 'higher', 1, 0, 0)`);
    for (let ID = 1; ID <= 3; ID++) await db.execute(`INSERT INTO benchmark_results
        (model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, benchmark_condition_snapshot, score_fields)
        VALUES (?, 1, 4, ?, 'https://example.test/extended', 'vendor_official', '{}', '[]')`, [ID, ID * 15]);
    const topics = [];
    for (const name of ['Version choices', 'Referenced choices']) {
        const [result] = await db.execute('INSERT INTO categories (name, slug) VALUES (?, ?)', [name, name.toLowerCase().replaceAll(' ', '-')]);
        const ID = Number(result.insertId), context = await ensureTopicRootContext(db, ID);
        topics.push({ ID, contextID: context.ID ?? context });
    }
    const [topic, reference] = topics;
    const save = (userID, entries, revision = 0, categoryID = topic.ID, fallbackRules = []) => savePersonalPie(db, {
        userID, categoryID, writeIdentity: randomUUID(), expectedRevision: revision, entries, fallbackRules, scoreMode: 'range'
    });
    await assert.rejects(save('1000', [{ conditionID: 1, weightBasisPoints: 5000, followCommunityVersion: true },
        { conditionID: 4, weightBasisPoints: 5000 }]), error => error.body?.error === 'pie_benchmark_version_conflict');
    await save('42', [{ conditionID: 1, weightBasisPoints: 10000, followCommunityVersion: true }]);
    await save('43', [{ conditionID: 4, weightBasisPoints: 10000 }]);
    const read = () => getRankingWorkspace(db, { categoryID: topic.ID, userID: '42', scoreMode: 'range' });
    const first = await read();
    validateWorkspacePayload(createRankingPager().create(first));
    assert.equal(first.personalPie.entries[0].followCommunityVersion, true);
    assert.deepEqual(first.personalPie.effectiveEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]), [[4, 10000]]);
    assert.equal(first.versionComposition.find(group => group.benchmarkID === 1).configuredPieCount, 1);
    const scores = first.modelLeaderboards.personal.map(model => model.lower).sort((a, b) => a - b);
    assert.deepEqual(scores, [15, 30, 45]);
    await save('43', [{ conditionID: 1, weightBasisPoints: 10000 }], 1);
    const changed = await read();
    validateWorkspacePayload(createRankingPager().create(changed));
    assert.deepEqual(changed.personalPie.effectiveEntries.map(entry => entry.conditionID), [1]);
    assert.equal(changed.personalPie.revision, 1, 'inherited versions do not rewrite the follower’s pie');
    const contextID = changed.context.ID;
    await save('42', [{ conditionID: -contextID, weightBasisPoints: 10000 }], 0, reference.ID);
    await save('43', [{ conditionID: 4, weightBasisPoints: 10000 }], 2);
    const nested = await getRankingWorkspace(db, { categoryID: reference.ID, userID: '42', scoreMode: 'range' });
    validateWorkspacePayload(createRankingPager().create(nested));
    assert.deepEqual(nested.personalPie.effectiveEntries.map(entry => entry.conditionID), [4]);
    assert.deepEqual(nested.modelLeaderboards.personal.map(model => model.lower).sort((a, b) => a - b), scores);
    const stored = await loadPersonalPie(db, contextID, '42');
    assert.equal(stored.entries[0].followCommunityVersion, true);
    const connection = await db.getConnection();
    try {
        assert.equal((await inspectCommunityVersions(connection)).missing, false);
        assert.equal((await migrateCommunityVersions(connection, { apply: true })).changed, false);
    } finally { connection.release(); }
});

test('snapshot capture, copy and publication seeding reject conflicting version choices before writes', { timeout: 60000 }, async t => {
    const database = await createLifecycleDatabase(); t.after(() => database.close());
    const db = database.pool; await seedLifecycleEvidence(db);
    await db.execute(`INSERT INTO benchmark_conditions
        (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_default, is_primary)
        VALUES (4, 1, 'extended', 'Extended', 'higher', 1, 0, 0)`);
    const create = name => savePrivateTopic(db, '42', { name, description: 'Version validation fixture.',
        scenes: [], defaultSceneKey: null }, randomUUID());
    const source = await create('Snapshot source'), target = await create('Snapshot target');
    await savePersonalPie(db, { userID: '42', categoryID: source.ID, expectedRevision: 0, writeIdentity: randomUUID(),
        entries: [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 4, weightBasisPoints: 5000 }], fallbackRules: [] });
    const snapshot = await captureTopicSnapshot(db, '42', source.ID);
    const invalid = structuredClone(snapshot);
    invalid.scenes[0].entries[0].followCommunityVersion = true;
    const conflict = error => error.status === 409 && error.body?.error === 'pie_benchmark_version_conflict';
    const counts = async () => {
        const values = {};
        for (const table of ['categories', 'personal_pies', 'personal_pie_weights']) {
            const [[row]] = await db.query('SELECT COUNT(*) AS count FROM ' + table); values[table] = Number(row.count);
        }
        return values;
    };
    const proposals = createTopicProposalService({ pool: db, queueForReview: async () => { throw new Error('Review is not part of this fixture'); } });
    const proposal = await proposals.propose('42', { sourceTopicID: source.ID }, randomUUID());
    const previews = createProposalPreviewService({ db, readProposal });
    const before = await counts();
    await assert.rejects(previews.copy('42', { proposalID: proposal.proposalID, revision: proposal.revision,
        name: 'Invalid copy', sceneDrafts: [{ key: snapshot.scenes[0].key, entries: invalid.scenes[0].entries }] }, randomUUID()), conflict);
    assert.deepEqual(await counts(), before, 'Failed copies roll back the new private topic');
    await assert.rejects(seedSnapshotTopic(db, target, '42', invalid), conflict);
    assert.deepEqual(await counts(), before, 'Publication seeding rejects the snapshot before writing scenes or weights');
    const copied = await previews.copy('42', { proposalID: proposal.proposalID, revision: proposal.revision,
        name: 'Valid inherited copy', sceneDrafts: [{ key: snapshot.scenes[0].key,
            entries: [{ conditionID: 1, weightBasisPoints: 10000, followCommunityVersion: true }] }] }, randomUUID());
    assert.ok(copied.categoryID);
    const stored = await loadPersonalPie(db, source.defaultContextID, '42');
    await db.execute('UPDATE personal_pie_weights SET follow_community_version = 1 WHERE pie_ID = ? AND benchmark_condition_ID = 1', [stored.ID]);
    await assert.rejects(captureTopicSnapshot(db, '42', source.ID), conflict);
});
