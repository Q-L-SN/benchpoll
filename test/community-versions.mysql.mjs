import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { savePersonalPie, getRankingWorkspace, loadPersonalPie } from '../ranking-service.js';
import { ensureTopicRootContext } from '../topic-scenes-service.js';
import { allocateTopicIdentity } from '../topic-platform-schema.js';

async function createPublicTopic(pool, name) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { publicID, privateID } = await allocateTopicIdentity(connection);
        const [result] = await connection.execute('INSERT INTO categories (name, slug, public_ID, private_ID) VALUES (?, ?, ?, ?)',
            [name, name.toLowerCase().replaceAll(' ', '-'), publicID, privateID]);
        const ID = Number(result.insertId), contextID = await ensureTopicRootContext(connection, ID);
        await connection.commit(); return { ID, contextID };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
}
import { inspectCommunityVersions, migrateCommunityVersions } from '../scripts/migrate-community-versions-20261103.mjs';
import { createRankingPager } from '../ranking-pagination.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

test('a restricted primary does not block saving an independent version or its community default', { timeout: 60000 }, async t => {
    const database = await createLifecycleDatabase(); t.after(() => database.close());
    const db = database.pool;
    await seedLifecycleEvidence(db);
    await db.execute("UPDATE benchmark_conditions SET score_source = 'aa' WHERE ID IN (1, 2)");
    await db.execute(`INSERT INTO benchmark_conditions
        (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_default, is_primary)
        VALUES (4, 1, 'independent', 'Independent', 'higher', 1, 0, 0)`);
    for (let ID = 1; ID <= 3; ID++) await db.execute(`INSERT INTO benchmark_results
        (model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, benchmark_condition_snapshot, score_fields)
        VALUES (?, 1, 4, ?, 'https://example.test/independent', 'vendor_official', '{}', '[]')`, [ID, ID * 15]);
    const topic = await createPublicTopic(db, 'Available versions');
    const categoryID = topic.ID;
    const read = () => getRankingWorkspace(db, { categoryID, userID: '42', scoreMode: 'range' });
    const initial = await read();
    const page = createRankingPager().create(initial);
    validateWorkspacePayload(page);
    const available = page.benchmarks.find(row => row.benchmarkID === 1);
    assert.equal(available.conditionID, 4);
    assert.equal(available.excludedFromRanking, false);
    assert.equal(page.benchmarks.find(row => row.benchmarkID === 2).excludedFromRanking, true);
    assert.equal(page.versionComposition.find(group => group.benchmarkID === 1).primaryConditionID, 4);
    const save = (entries, fallbackRules = []) => savePersonalPie(db, { userID: '42', categoryID,
        writeIdentity: randomUUID(), expectedRevision: 0, entries, fallbackRules, scoreMode: 'range' });
    const excluded = error => error.body?.error === 'pie_benchmark_condition_excluded';
    await assert.rejects(save([{ conditionID: 1, weightBasisPoints: 10000 }]), excluded);
    await assert.rejects(save([{ conditionID: 2, weightBasisPoints: 10000, followCommunityVersion: true }]), excluded);
    await assert.rejects(save([{ conditionID: 4, weightBasisPoints: 10000 }],
        [{ primaryConditionID: 4, mode: 'ordered', entries: [{ conditionID: 1 }] }]), excluded);
    await save([{ conditionID: available.conditionID, weightBasisPoints: 10000, followCommunityVersion: true }]);
    const saved = await read();
    validateWorkspacePayload(createRankingPager().create(saved));
    assert.deepEqual(saved.personalPie.effectiveEntries.map(entry => entry.conditionID), [4]);
    assert.deepEqual(saved.modelLeaderboards.personal.map(model => model.lower).sort((a, b) => a - b), [15, 30, 45]);
    const stored = await loadPersonalPie(db, saved.context.ID, '42');
    assert.equal(stored.entries[0].conditionID, 4);
    assert.equal(stored.entries[0].followCommunityVersion, true);
});

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
        topics.push(await createPublicTopic(db, name));
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
