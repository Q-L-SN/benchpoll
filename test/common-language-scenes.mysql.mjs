import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { seedCommonLanguageScenes } from './helpers/common-language-scenes-fixture.mjs';
import { migrateCommonLanguageScenes, readCommonLanguageSceneState, verifyCommonLanguageScenes,
    COMMON_LANGUAGE_SCENES_MIGRATION } from '../scripts/migrate-common-language-scenes-20261104.mjs';
import { getTopic } from '../topic-service.js';
import { loadPersonalPie } from '../ranking-service.js';
import { listDiscussion } from '../discussion-service.js';
import { loadTopicReferenceTargets } from '../topic-reference-service.js';
import { savePrivateTopic } from '../private-topic-service.js';
import { randomUUID } from 'node:crypto';

test('common Language/Coding scene migration in disposable MySQL', async t => {
    const database = await createLifecycleDatabase();
    t.after(() => database.close());
    await seedLifecycleEvidence(database.pool);
    const fixture = await seedCommonLanguageScenes(database.pool), db = await database.pool.getConnection();
    t.after(() => db.release());
    const before = await readCommonLanguageSceneState(db), plan = await migrateCommonLanguageScenes(db);
    const protectedTables = ['personal_pies', 'personal_pie_weights', 'personal_pie_topic_weights', 'discussion_posts', 'benchmark_results'];
    const readProtected = async () => Object.fromEntries(await Promise.all(protectedTables.map(async name => [name, (await db.query('SELECT * FROM ' + name))[0]])));
    const protectedBefore = await readProtected();
    assert.equal(protectedBefore.personal_pie_topic_weights.length, 2);

    await t.test('inspection and missing apply prerequisites perform no writes', async () => {
        assert.equal(plan.dryRun, true); assert.equal(plan.retired.length, 176);
        await assert.rejects(migrateCommonLanguageScenes(db, { apply: true, rehearsal: true }), /reviewed --expect-plan/);
        await assert.rejects(migrateCommonLanguageScenes(db, { apply: true, expectedPlanHash: plan.planHash }), /backup manifest/);
        await assert.rejects(migrateCommonLanguageScenes(db, { apply: true, rehearsal: true, expectedPlanHash: '0'.repeat(64) }), /Scene plan changed/);
        assert.deepEqual(await readCommonLanguageSceneState(db), before);
    });
    await t.test('transaction rolls back after retiring languages if a new Coding insert fails', async () => {
        const failing = new Proxy(db, { get(target, key) {
            if (key === 'execute') return async (sql, args) => {
                if (sql.startsWith('INSERT INTO ranking_contexts')) throw new Error('Synthetic insertion failure');
                return target.execute(sql, args);
            };
            const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        } });
        await assert.rejects(migrateCommonLanguageScenes(failing, { apply: true, rehearsal: true, expectedPlanHash: plan.planHash }), /Synthetic insertion failure/);
        assert.deepEqual(await readCommonLanguageSceneState(db), before);
        assert.deepEqual(await readProtected(), protectedBefore);
        assert.equal((await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [COMMON_LANGUAGE_SCENES_MIGRATION]))[0].length, 0);
    });
    await t.test('apply preserves user data and exposes only the intended scene lists', async () => {
        const result = await migrateCommonLanguageScenes(db, { apply: true, rehearsal: true, expectedPlanHash: plan.planHash });
        assert.equal(result.applied, true); assert.equal(result.protectedDataUnchanged, true);
        assert.equal(result.codingGeneralContextID, fixture.codingRootID);
        assert.deepEqual(await readProtected(), protectedBefore);
        const language = await getTopic(db, null, 219), coding = await getTopic(db, null, 180);
        assert.deepEqual(language.scenes.map(scene => scene.name), plan.retained.map(scene => scene.name));
        assert.deepEqual(coding.scenes.map(scene => scene.name), plan.added.map(scene => scene.name));
        assert.equal(coding.defaultContextID, fixture.codingRootID);
        assert.equal(coding.scenes[0].url, '/coding/general');
        assert.deepEqual(coding.scenes.slice(5, 8).map(scene => scene.url), ['/coding/c', '/coding/c-plus-plus', '/coding/c-sharp']);
        assert.equal(language.scenes.find(scene => scene.name === 'English').ID, fixture.english.ID);
        assert.equal(language.scenes.some(scene => scene.ID === fixture.retired.ID), false);
        for (const scene of coding.scenes.slice(1)) assert.equal((await db.execute('SELECT ID FROM personal_pies WHERE context_ID = ?', [scene.ID]))[0].length, 0);
    });
    await t.test('saved Coding weights, discussions and references resolve through General', async () => {
        const pie = await loadPersonalPie(db, fixture.codingRootID, '42');
        assert.equal(pie.entries[0].conditionID, 1);
        const discussion = await listDiscussion(database.pool, null, { categoryID: 180, contextValues: {} });
        assert.equal(discussion.posts[0].ID, fixture.discussion.ID);
        const targets = await loadTopicReferenceTargets(db, '43');
        assert.equal(targets.find(row => row.contextID === fixture.codingRootID).sceneName, 'General');
        assert.equal(targets.some(row => row.contextID === fixture.retired.ID), false);
        assert.equal(targets.find(row => row.sceneName === 'C++').url, '/coding/c-plus-plus');
        assert.equal(targets.find(row => row.sceneName === 'C#').url, '/coding/c-sharp');
    });
    await t.test('repeat execution verifies without rewriting data or cache revisions', async () => {
        const state = await readCommonLanguageSceneState(db), [[revision]] = await db.query('SELECT * FROM ranking_cache_revisions WHERE ID = 2');
        const repeat = await migrateCommonLanguageScenes(db, { apply: true, rehearsal: true, expectedPlanHash: plan.planHash });
        assert.equal(repeat.applied, false); assert.equal(repeat.alreadyApplied, true);
        assert.deepEqual(await readCommonLanguageSceneState(db), state);
        assert.deepEqual((await db.query('SELECT * FROM ranking_cache_revisions WHERE ID = 2'))[0][0], revision);
        assert.equal((await verifyCommonLanguageScenes(db)).verified, true);
    });
    await t.test('the same programming-language scenes can be created and edited together in a private topic', async () => {
        const topic = await savePrivateTopic(database.pool, '42', { name: 'My coding', description: 'My coding evaluation.',
            scenes: ['General', 'C', 'C++', 'C#'].map((name, index) => ({ key: 's' + index, name })), defaultSceneKey: 's0' }, randomUUID());
        assert.deepEqual(topic.scenes.map(scene => scene.slug), ['general', 'c', 'c-plus-plus', 'c-sharp']);
        const edited = await savePrivateTopic(database.pool, '42', { categoryID: topic.ID, expectedRevision: topic.editRevision,
            name: topic.name, description: topic.description, scenes: topic.scenes.map(scene => ({ key: 's' + scene.ID, ID: scene.ID, name: scene.name })),
            defaultSceneKey: 's' + topic.scenes[0].ID }, randomUUID());
        assert.deepEqual(edited.scenes.map(scene => scene.url), topic.scenes.map(scene => scene.url));
    });
});
