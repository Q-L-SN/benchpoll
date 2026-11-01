import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { planTopicScenes, topicScenesDDL, topicSceneCacheTriggers, CONTEXTUAL_OFFICIAL_TOPIC_IDS,
    ensureTopicScenesSchema, verifyTopicScenesSchema, verifyTopicScenesMigration, migrateTopicScenes } from '../scripts/migrate-topic-scenes-20261031.mjs';
import { PIE_MIN_ITEM_BASIS_POINTS, PIE_TOTAL_BASIS_POINTS } from '../ranking-service.js';
import { sceneSchemaDatabase } from './helpers/topic-scenes-schema-fixture-20261031.mjs';

const taxonomy = JSON.parse(readFileSync(new URL('../ops/topic-taxonomy-20261026.json', import.meta.url), 'utf8'));
const context = (ID, categoryID, values) => {
    const ordered = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
    const serialized = JSON.stringify(ordered);
    return { ID, category_ID: categoryID, context_values: serialized, context_hash: createHash('sha256').update(serialized).digest('hex') };
};
function state() {
    let ID = 1;
    const dimensions = [], options = [];
    for (const topic of taxonomy.categories) for (const [index, dimension] of (taxonomy.dimensions[topic.key] ?? []).entries()) {
        const dimensionID = ID++;
        dimensions.push({ ID: dimensionID, scope_category_ID: topic.ID, dimension_key: dimension.key,
            name: dimension.name, position: index * 10, is_active: 1 });
        for (const [position, option] of [taxonomy.neutralOption, ...dimension.options].entries()) {
            options.push({ ID: ID++, dimension_ID: dimensionID, option_key: option.key, name: option.name,
                position, is_neutral: Number(position === 0), is_default: Number(position === 0) });
        }
    }
    return { categories: taxonomy.categories.map(topic => ({ ...topic, is_active: 1, description: `Assess ${topic.name}.` })),
        dimensions, options, contexts: [context(1095, 172, { output: 'any', realtime: 'any', reference_image: 'any' }), context(70, 54, {})],
        pies: [{ ID: 42, context_ID: 1095 }], posts: [] };
}

test('official migration creates one-level option scenes, preserving all selectable languages without a Cartesian product', () => {
    const before = state(), plan = planTopicScenes(before), contextual = plan.topics.filter(topic => topic.scenes.length);
    assert.deepEqual(contextual.map(topic => topic.categoryID).sort((a, b) => a - b), [...CONTEXTUAL_OFFICIAL_TOPIC_IDS].sort((a, b) => a - b));
    const image = contextual.find(topic => topic.categoryID === 172);
    assert.equal(image.scenes.length, 8); assert.equal(image.scenes[0].contextID, 1095); assert.equal(image.scenes[0].name, 'General');
    const language = contextual.find(topic => topic.categoryID === 219);
    const languageOptions = taxonomy.dimensions.language.find(dimension => dimension.key === 'language').options;
    assert.equal(languageOptions.length, 184); assert.equal(language.scenes.length, 186);
    assert.equal(plan.topics.reduce((sum, topic) => sum + topic.scenes.length, 0), 215);
    for (const topic of contextual) {
        assert.equal(topic.scenes.filter(scene => scene.isDefault).length, 1);
        assert.ok(topic.scenes.every(scene => Object.values(scene.legacyValues).filter(value => value !== 'any').length <= 1));
        assert.equal(new Set(topic.scenes.map(scene => scene.slug)).size, topic.scenes.length);
    }
    assert.equal(plan.topics.find(topic => topic.categoryID === 54).rootContextID, 70);
    assert.equal(plan.generatesCartesianCombinations, false);
    assert.deepEqual(state(), before, 'Pure planning does not mutate source contexts, weights or options');
});

test('configured combinations and discussions become named scenes with their original IDs, including unknown legacy options', () => {
    const snapshot = state();
    snapshot.contexts.push(context(2000, 172, { output: 'vector', realtime: 'yes', reference_image: 'multiple' }),
        context(2001, 219, { language: 'zh', task: 'translation_target' }), context(2002, 172, { old_field: 'previous' }));
    snapshot.pies.push({ context_ID: 2000 }, { context_ID: 2001 }); snapshot.posts.push({ context_ID: 2002 });
    const plan = planTopicScenes(snapshot), image = plan.topics.find(topic => topic.categoryID === 172);
    assert.equal(image.scenes.find(scene => scene.contextID === 2000).name, 'Vector output / Real-time / Multiple reference images');
    assert.deepEqual(image.scenes.find(scene => scene.contextID === 2000).legacyValues, { output: 'vector', realtime: 'yes', reference_image: 'multiple' });
    assert.ok(image.scenes.find(scene => scene.contextID === 2002));
    assert.ok(plan.topics.find(topic => topic.categoryID === 219).scenes.find(scene => scene.contextID === 2001));
    assert.equal(snapshot.pies[1].context_ID, 2000); assert.equal(snapshot.posts[0].context_ID, 2002);
});

test('single-option existing IDs are reused and alternate configured neutral contexts are not merged away', () => {
    const snapshot = state();
    snapshot.contexts.push(context(1096, 172, { realtime: 'yes', output: 'any', reference_image: 'any' }), context(1097, 172, {}));
    snapshot.pies.push({ context_ID: 1097 });
    const image = planTopicScenes(snapshot).topics.find(topic => topic.categoryID === 172);
    assert.equal(image.scenes.find(scene => scene.name === 'Real-time').contextID, 1096);
    assert.equal(image.scenes[0].contextID, 1095);
    assert.equal(image.scenes.find(scene => scene.contextID === 1097).isDefault, false);
    assert.match(image.scenes.find(scene => scene.contextID === 1097).name, /^General /);
});

test('unconfigured combinations remain untouched and inactive topics are not reactivated', () => {
    const snapshot = state();
    snapshot.contexts.push(context(3000, 172, { output: 'vector', realtime: 'yes', reference_image: 'single' }));
    snapshot.categories.push({ ID: 999, name: 'Retired', is_active: 0 });
    assert.equal(planTopicScenes(snapshot).topics.some(topic => topic.categoryID === 999), false);
    assert.equal(planTopicScenes(snapshot).topics.flatMap(topic => topic.scenes).some(scene => scene.contextID === 3000), false);
    assert.ok(snapshot.contexts.some(row => row.ID === 3000));
});

test('migration refuses corrupt stored hashes instead of losing their identity', () => {
    const snapshot = state(); snapshot.contexts[0].context_hash = 'incorrect';
    assert.throws(() => planTopicScenes(snapshot), /hash mismatch/);
});

test('DDL pins scenes to same-topic context IDs and enforces one default, reference bounds and singleton graph locking', () => {
    const ddl = topicScenesDDL().join('\n');
    assert.match(ddl, /PRIMARY KEY \(context_ID\)/);
    assert.match(ddl, /FOREIGN KEY \(context_ID, category_ID\) REFERENCES ranking_contexts \(ID, category_ID\)/);
    assert.match(ddl, /UNIQUE KEY uq_topic_scene_default \(default_category_ID\)/);
    assert.ok(ddl.includes(`weight_basis_points BETWEEN ${PIE_MIN_ITEM_BASIS_POINTS} AND ${PIE_TOTAL_BASIS_POINTS}`));
    assert.match(ddl, /CHECK \(ID = 1\)/);
    assert.doesNotMatch(ddl, /parent_scene|parent_ID|CROSS JOIN/);
    assert.throws(() => topicScenesDDL({ categories: 'INT; DROP TABLE users', ranking_contexts: 'BIGINT UNSIGNED', personal_pies: 'BIGINT UNSIGNED' }));
});

test('all scene/reference mutations invalidate the ranking catalogue cache', () => {
    const triggers = topicSceneCacheTriggers();
    assert.equal(triggers.length, 6);
    assert.equal(new Set(triggers.map(trigger => trigger.name)).size, 6);
    for (const table of ['topic_scenes', 'personal_pie_topic_weights']) {
        assert.deepEqual(triggers.filter(trigger => trigger.table === table).map(trigger => trigger.event), ['INSERT', 'UPDATE', 'DELETE']);
    }
    assert.ok(triggers.every(trigger => /catalogue_revision = catalogue_revision \+ 1 WHERE ID = 2/.test(trigger.statement)));
});

test('schema verification inspects actual FK targets, generated defaults, checks, engines and trigger timing', async () => {
    assert.deepEqual(await verifyTopicScenesSchema(sceneSchemaDatabase().db), { schemaReady: true });
    const corruptions = [
        h => { h.schema.tables.find(row => row.name === 'topic_proposals').engine = 'MyISAM'; },
        h => { h.schema.columns.find(row => row.name === 'context_ID').type = 'int unsigned'; },
        h => { h.schema.columns.find(row => row.name === 'default_category_ID').extra = ''; },
        h => { h.schema.columns.find(row => row.name === 'default_category_ID').generation = 'category_ID'; },
        h => { h.schema.indexes.find(row => row.name === 'uq_topic_scene_default').nonUnique = 1; },
        h => { h.schema.foreignKeys.find(row => row.name === 'fk_scene_proposal_context').referencedTable = 'categories'; },
        h => { h.schema.foreignKeys.find(row => row.name === 'fk_topic_scene_context').referencedColumn = 'category_ID'; },
        h => { h.schema.foreignKeys.find(row => row.name === 'fk_topic_weight_pie').deleteRule = 'RESTRICT'; },
        h => { h.schema.checks.find(row => row.name === 'ck_scene_proposal_identity').enforced = 'NO'; },
        h => { h.schema.checks.find(row => row.name === 'ck_topic_proposal_state').clause = '1 = 1'; },
        h => { h.schema.checks.find(row => row.name === 'ck_topic_weight_basis_points').clause = 'weight_basis_points BETWEEN 1 AND 10000'; },
        h => { h.schema.triggers[0].timing = 'BEFORE'; },
        h => { h.schema.cache = false; }
    ];
    for (const corrupt of corruptions) {
        const h = sceneSchemaDatabase(); corrupt(h);
        await assert.rejects(verifyTopicScenesSchema(h.db));
        assert.ok(h.calls.every(call => /^SELECT/.test(call.sql)), 'Verification never repairs or mutates data');
    }
});

test('schema verification accepts MySQL escaped CHECK literal delimiters without accepting different states', async () => {
    const h = sceneSchemaDatabase();
    const stateCheck = h.schema.checks.find(row => row.name === 'ck_topic_proposal_state');
    stateCheck.clause = stateCheck.clause.replace(/'/g, "\\'");
    assert.deepEqual(await verifyTopicScenesSchema(h.db), { schemaReady: true });
    stateCheck.clause = stateCheck.clause.replace('approved', 'open');
    await assert.rejects(verifyTopicScenesSchema(h.db), /Invalid scene schema check definition/);
});

test('migration verification retains registered retired scenes but rejects unregistered configured contexts', async () => {
    const h = sceneSchemaDatabase();
    assert.equal((await verifyTopicScenesMigration(h.db)).verified, true);
    const query = h.calls.find(call => call.sql.startsWith('SELECT rc.ID FROM ranking_contexts rc')).sql;
    assert.match(query, /LEFT JOIN topic_scenes s ON s.context_ID = rc.ID WHERE/);
    assert.doesNotMatch(query, /s\.is_active/);
    h.schema.orphanContexts = [{ ID: 999 }];
    await assert.rejects(verifyTopicScenesMigration(h.db), /Configured legacy context is missing its scene/);
});

test('schema retry upgrades the old 1bp CHECK exactly once, including a lost DDL acknowledgement', async () => {
    const h = sceneSchemaDatabase();
    h.schema.checks.find(row => row.name === 'ck_topic_weight_basis_points').clause = 'weight_basis_points BETWEEN 1 AND 10000';
    h.loseNextDDLAcknowledgement();
    await assert.rejects(ensureTopicScenesSchema(h.db), /ddl_ack_lost/);
    assert.equal((await ensureTopicScenesSchema(h.db)).schemaReady, true);
    assert.equal((await ensureTopicScenesSchema(h.db)).schemaReady, true);
    assert.equal(h.calls.filter(call => call.sql.startsWith('ALTER TABLE personal_pie_topic_weights')).length, 1);
    assert.equal(h.calls.some(call => /^(UPDATE|DELETE) personal_pie_topic_weights/.test(call.sql)), false);
});

test('invalid stored sub-minimum references block the CHECK upgrade without silently changing weights', async () => {
    const h = sceneSchemaDatabase();
    h.schema.checks.find(row => row.name === 'ck_topic_weight_basis_points').clause = 'weight_basis_points BETWEEN 1 AND 10000';
    h.schema.invalidWeights.push({ pie_ID: 1, target_context_ID: 2, weight_basis_points: 99 });
    await assert.rejects(ensureTopicScenesSchema(h.db), /require review/);
    assert.equal(h.schema.invalidWeights[0].weight_basis_points, 99);
    assert.equal(h.calls.some(call => /^(ALTER TABLE|UPDATE|DELETE) personal_pie_topic_weights/.test(call.sql)), false);
});

test('a completed migration retry verifies invariants without recreating scenes or resetting defaults', async () => {
    const h = sceneSchemaDatabase();
    for (let retry = 0; retry < 2; retry++) assert.deepEqual(await migrateTopicScenes(h.db),
        { applied: false, verified: true, scenes: 0, topicsWithScenes: 0 });
    assert.equal(h.calls.filter(call => call.sql === 'COMMIT').length, 2);
    assert.equal(h.calls.some(call => /^(INSERT INTO|UPDATE|DELETE FROM) (topic_scenes|ranking_contexts|ranking_dimensions|schema_migrations)\b/.test(call.sql)), false);
    h.schema.triggers[0].timing = 'BEFORE';
    await assert.rejects(migrateTopicScenes(h.db), /trigger differs/);
    assert.equal(h.calls.filter(call => call.sql === 'COMMIT').length, 2, 'Migration markers never bypass schema verification');
});
