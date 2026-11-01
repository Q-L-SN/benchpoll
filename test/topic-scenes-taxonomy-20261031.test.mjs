import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sceneContext } from '../topic-scenes-service.js';
import { legacyTopicRouteKey } from '../topic-service.js';
import { verifyTopicScenesMigration } from '../scripts/migrate-topic-scenes-20261031.mjs';
import { topicScenesTaxonomy, validateSceneTaxonomy, planSceneTaxonomy, verifySceneTaxonomySchema,
    migrateTopicScenesTaxonomy, verifyTopicScenesTaxonomy, assertTaxonomyRehearsalSpace,
    TOPIC_SCENES_TAXONOMY_MIGRATION } from '../scripts/migrate-topic-scenes-taxonomy-20261031.mjs';
import { sceneTaxonomyFixtureState, sceneTaxonomyDatabase } from './helpers/topic-scenes-taxonomy-fixture-20261031.mjs';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const clone = value => structuredClone(value);
const legacy = (state, categoryID, match) => state.scenes.find(row => Number(row.category_ID) === categoryID && row.legacy_context_values != null
    && JSON.stringify(Object.fromEntries(Object.entries(parse(row.legacy_context_values)).filter(([, value]) => value !== 'any').sort()))
        === JSON.stringify(Object.fromEntries(Object.entries(match).sort())));
const active = (state, categoryID) => state.scenes.filter(row => Number(row.category_ID) === categoryID && row.is_active)
    .sort((a, b) => b.is_default - a.is_default || a.position - b.position);
const apply = h => migrateTopicScenesTaxonomy(h.db, { rehearsal: true });

test('the complete official topic list uses the requested order, stable IDs and three database-assigned IDs', () => {
    assert.deepEqual(validateSceneTaxonomy(), { topics: 32, activeScenes: 209, languages: 184 });
    assert.deepEqual(topicScenesTaxonomy.topics.map(row => [row.ID, row.name]), [
        [54, 'Intelligence'], [180, 'Coding'], [197, 'Medical Diagnosis'], [198, 'Law'], [199, 'Cybersecurity & Cryptography'],
        [232, 'RSI'], [216, 'Teaching'], [196, 'Office'], [202, 'Management'], [167, 'Academic Research'], [176, 'GUI Operation'],
        [178, 'Robot Operation'], [234, 'Foresight'], [184, 'Planning'], [204, 'Collaboration'], [208, 'Self-Learning'],
        [209, 'Knowledge & Retrieval'], [182, 'Low Hallucination'], [215, 'Memory & Long Context'], [210, 'Multimodal Understanding'],
        [null, 'Real-Time Visual Output'], [172, 'Image Generation'], [null, 'Vector Graphics'], [173, 'Video Generation'],
        [null, 'Video Projects'], [190, 'Audio Generation'], [191, '3D Generation'], [192, 'Interface Generation'],
        [193, 'Communication & EQ'], [187, 'Writing'], [219, 'Language'], [166, 'AGI']
    ]);
    assert.deepEqual(topicScenesTaxonomy.topics.map(row => row.position), Array.from({ length: 32 }, (_, index) => (index + 1) * 10));
    assert.deepEqual(topicScenesTaxonomy.retiredTopics, [{ ID: 231, name: 'Computer Work', targetID: 196 }]);
    assert.ok(topicScenesTaxonomy.topics.every(row => row.description.length > 0 && row.description.length <= 180));
});

test('the complete scene list contains no extra selector dimensions or Cartesian combinations', () => {
    assert.deepEqual(Object.fromEntries(topicScenesTaxonomy.topics.filter(row => row.scenes.length && row.ID !== 219)
        .map(row => [row.name, row.scenes.map(scene => scene.name)])), {
        'Multimodal Understanding': ['General', 'Non-Real-Time', 'Real-Time'],
        'Image Generation': ['General', 'No Reference Image', 'Single Reference Image', 'Multiple Reference Images'],
        'Vector Graphics': ['General', 'No Reference Image', 'With Reference Image'],
        'Video Generation': ['General', 'No Reference Image', 'With Reference Image'],
        'Video Projects': ['General', 'No Reference Video', 'With Reference Video'],
        'Audio Generation': ['Non-Real-Time Audio', 'Real-Time Audio'],
        '3D Generation': ['General', 'With Reference Image', 'No Reference Image'],
        'Interface Generation': ['General', 'With Reference Image', 'No Reference Image']
    });
    assert.equal(topicScenesTaxonomy.topics.filter(row => !row.scenes.length).length, 23);
});

test('specification validation rejects lost language IDs/order, wrong official IDs and missing summaries', () => {
    const mutations = [
        spec => { spec.topics[0].ID = 55; },
        spec => { spec.topics[3].ID = 180; },
        spec => { spec.topics[6].position = 81; },
        spec => { spec.topics[20].description = ''; },
        spec => { spec.topics[20].name = 'Settings'; },
        spec => { spec.topics.find(row => row.ID === 219).scenes.reverse(); },
        spec => { spec.topics.find(row => row.ID === 219).scenes[1].match.language = 'other'; }
    ];
    for (const mutate of mutations) { const spec = clone(topicScenesTaxonomy); mutate(spec); assert.throws(() => validateSceneTaxonomy(spec)); }
});

test('pure planning keeps exact single-option context IDs and does not mutate any source record', () => {
    const state = sceneTaxonomyFixtureState(), before = clone(state), plan = planSceneTaxonomy(state);
    assert.equal(plan.topics.find(row => row.ID === 172).scenes[0].contextID, 1095);
    assert.deepEqual(plan.moveScenes, [
        { contextID: legacy(state, 172, { output: 'vector' }).context_ID, sourceCategoryID: 172, targetKey: 'vector' },
        { contextID: legacy(state, 173, { output: 'project_file' }).context_ID, sourceCategoryID: 173, targetKey: 'video_projects' }
    ]);
    assert.equal(plan.retireSceneIDs.length, 14);
    for (const ID of [190, 191, 192, 219]) assert.ok(plan.retireSceneIDs.some(sceneID => state.scenes.some(row => row.context_ID === sceneID && row.category_ID === ID)));
    assert.deepEqual(state, before);
});

test('an existing composite scene is retained as retired history rather than relabeled as a single-option scene', () => {
    const state = sceneTaxonomyFixtureState(), context = sceneContext(12001);
    state.contexts.push({ ID: 12001, category_ID: 172, context_values: context.serialized, context_hash: context.contextHash });
    state.scenes.push({ context_ID: 12001, category_ID: 172, name: 'Vector plus live', slug: 'vector-plus-live', description: 'Historical compound scope.',
        position: 800, is_default: 0, is_active: 1, legacy_context_values: '{"output":"vector","realtime":"yes","reference_image":"any"}' });
    state.pies.push({ ID: 70, context_ID: 12001, user_ID: 5 });
    state.posts.push({ ID: 70, context_ID: 12001, category_ID: 172, body: 'Keep this exact scope.' });
    const plan = planSceneTaxonomy(state);
    assert.ok(plan.retireSceneIDs.includes(12001));
    assert.equal(plan.topics.flatMap(row => row.scenes).some(row => row.contextID === 12001), false);
});

test('all 184 language contexts keep their original IDs, names remain unique and Translation is retired', async () => {
    const h = sceneTaxonomyDatabase(), before = clone(h.state);
    const options = topicScenesTaxonomy.topics.find(row => row.ID === 219).scenes.slice(1);
    const languageIDs = options.map(row => legacy(before, 219, { language: row.language }).context_ID);
    const translationID = legacy(before, 219, { task: 'translation_target' }).context_ID;
    await apply(h);
    const scenes = active(h.state, 219);
    assert.equal(scenes.length, 185);
    assert.equal(scenes[0].name, 'General'); assert.equal(scenes[0].is_default, 1);
    assert.deepEqual(scenes.slice(1).map(row => row.context_ID), languageIDs);
    assert.deepEqual(scenes.slice(1).map(row => parse(row.legacy_context_values).language), options.map(row => row.language));
    assert.equal(new Set(scenes.map(row => row.name.toLowerCase())).size, 185);
    assert.equal(new Set(scenes.map(row => row.slug)).size, 185);
    assert.equal(h.state.scenes.find(row => row.context_ID === translationID).is_active, 0);
    assert.deepEqual(h.state.pies.filter(row => row.context_ID === translationID), before.pies.filter(row => row.context_ID === translationID));
    assert.deepEqual(h.state.posts.filter(row => row.context_ID === translationID), before.posts.filter(row => row.context_ID === translationID));
});

test('every default is first, Audio deliberately has no General, and base --check still accepts retained history', async () => {
    const h = sceneTaxonomyDatabase(), result = await apply(h);
    assert.equal(result.officialTopics, 32); assert.equal(result.activeScenes, 209); assert.equal(result.languages, 184);
    assert.equal(result.baseCompatible, true); assert.equal(result.protectedDataUnchanged, true);
    for (const topic of topicScenesTaxonomy.topics) {
        const scenes = active(h.state, result.topicIDs[topic.key]);
        assert.equal(scenes.length, topic.scenes.length);
        if (scenes.length) {
            assert.equal(scenes.filter(row => row.is_default).length, 1); assert.equal(scenes[0].is_default, 1);
            assert.equal(scenes[0].position, 0);
        }
    }
    assert.deepEqual(active(h.state, 190).map(row => row.name), ['Non-Real-Time Audio', 'Real-Time Audio']);
    assert.equal(h.state.scenes.find(row => row.category_ID === 190 && row.name === 'General').is_active, 0);
    assert.equal((await verifyTopicScenesMigration(h.db)).verified, true);
    assert.equal((await verifyTopicScenesTaxonomy(h.db)).verified, true);
});

test('vector/project moves preserve context IDs, hashes, all weights and references while updating discussion categories', async () => {
    const h = sceneTaxonomyDatabase(), before = clone(h.state), result = await apply(h);
    for (const [sourceID, match, key] of [[172, { output: 'vector' }, 'vector'], [173, { output: 'project_file' }, 'video_projects']]) {
        const oldScene = legacy(before, sourceID, match), newScene = active(h.state, result.topicIDs[key])[0];
        assert.equal(newScene.context_ID, oldScene.context_ID); assert.equal(newScene.name, 'General');
        const oldContext = before.contexts.find(row => row.ID === oldScene.context_ID), newContext = h.state.contexts.find(row => row.ID === oldScene.context_ID);
        assert.deepEqual(newContext, { ...oldContext, category_ID: result.topicIDs[key] });
        for (const post of before.posts.filter(row => row.context_ID === oldScene.context_ID)) {
            assert.deepEqual(h.state.posts.find(row => row.ID === post.ID), { ...post, category_ID: result.topicIDs[key] });
        }
    }
    for (const key of ['pies', 'weights', 'references', 'fallbackRules', 'mentions', 'discussionVotes', 'proposals', 'proposalVotes']) assert.deepEqual(h.state[key], before[key]);
    assert.equal(h.state.contexts.length, before.contexts.length + 9, 'Eight new scenes and one standalone real-time visual root; no copied contexts');
    assert.equal(h.calls.some(row => /FOREIGN_KEY_CHECKS|ALTER TABLE|TRUNCATE/.test(row.sql)), false);
    for (const move of result.moveScenes) {
        const remove = h.calls.findIndex(row => row.sql.startsWith('DELETE FROM topic_scenes') && row.args[0] === move.contextID);
        const update = h.calls.findIndex(row => row.sql.startsWith('UPDATE ranking_contexts SET category_ID') && row.args[1] === move.contextID);
        const insert = h.calls.findIndex(row => row.sql.startsWith('INSERT INTO topic_scenes') && row.args[0] === move.contextID);
        assert.ok(remove < update && update < insert);
    }
});

test('Office retirement redirects current and historical slugs without mixing weights, contexts or discussions', async () => {
    const h = sceneTaxonomyDatabase(), before = clone(h.state);
    await apply(h);
    const office = h.state.categories.find(row => row.ID === 196), work = h.state.categories.find(row => row.ID === 231), gui = h.state.categories.find(row => row.ID === 176);
    assert.equal(office.name, 'Office'); assert.equal(office.slug, 'office'); assert.equal(office.position, 80);
    assert.equal(work.is_active, 0); assert.equal(gui.name, 'GUI Operation'); assert.equal(gui.slug, 'gui-operation');
    for (const slug of ['computer-work', 'professional-work', 'customer-service', 'office-documents-data-processing', 'office-data']) {
        assert.equal(h.state.aliases.find(row => row.route_key === legacyTopicRouteKey(slug))?.category_ID, 196, slug);
    }
    assert.equal(h.state.aliases.find(row => row.route_key === legacyTopicRouteKey('computer-use'))?.category_ID, 176);
    assert.deepEqual(h.state.contexts.filter(row => [196, 231].includes(row.category_ID)), before.contexts.filter(row => [196, 231].includes(row.category_ID)));
    assert.deepEqual(h.state.pies.filter(row => [1090, 1093].includes(row.context_ID)), before.pies.filter(row => [1090, 1093].includes(row.context_ID)));
    assert.deepEqual(h.state.posts.filter(row => row.category_ID === 231), before.posts.filter(row => row.category_ID === 231));
});

test('generic reference-content scopes are never silently reused as reference-image scopes', async () => {
    const h = sceneTaxonomyDatabase(), before = clone(h.state); await apply(h);
    for (const categoryID of [191, 192]) for (const value of ['none', 'present']) {
        const previous = legacy(before, categoryID, { reference_content: value });
        assert.equal(h.state.scenes.find(row => row.context_ID === previous.context_ID).is_active, 0);
        assert.equal(active(h.state, categoryID).some(row => row.context_ID === previous.context_ID), false);
        assert.deepEqual(h.state.contexts.find(row => row.ID === previous.context_ID), before.contexts.find(row => row.ID === previous.context_ID));
    }
});

test('private, user-created public and unlisted official topics remain byte-for-byte unchanged', async () => {
    const h = sceneTaxonomyDatabase(), before = clone(h.state); await apply(h);
    for (const ID of [9000, 9002, 9004]) {
        assert.deepEqual(h.state.categories.find(row => row.ID === ID), before.categories.find(row => row.ID === ID));
        assert.deepEqual(h.state.contexts.filter(row => row.category_ID === ID), before.contexts.filter(row => row.category_ID === ID));
        assert.deepEqual(h.state.scenes.filter(row => row.category_ID === ID), before.scenes.filter(row => row.category_ID === ID));
    }
    assert.deepEqual(h.state.options, before.options); assert.deepEqual(h.state.dimensions, before.dimensions);
    assert.deepEqual(h.state.aliases.find(row => row.category_ID === 9002), before.aliases.find(row => row.category_ID === 9002));
});

test('a committed retry only verifies, does not duplicate auto IDs and does not mutate the catalogue again', async () => {
    const h = sceneTaxonomyDatabase(), first = await apply(h), after = clone(h.state), start = h.calls.length;
    for (let attempt = 0; attempt < 2; attempt++) {
        const retry = await apply(h); assert.equal(retry.applied, false); assert.deepEqual(retry.topicIDs, first.topicIDs);
    }
    assert.deepEqual(h.state, after);
    assert.equal(h.calls.slice(start).some(row => /^(INSERT|UPDATE|DELETE|CREATE|ALTER) /.test(row.sql)), false);
    assert.equal(h.state.markers.filter(row => row.migration_id === TOPIC_SCENES_TAXONOMY_MIGRATION).length, 1);
    assert.equal(h.state.archives.length, 1);
});

test('a lost COMMIT acknowledgement is safely verified on retry instead of applying a second migration', async () => {
    const h = sceneTaxonomyDatabase(); h.loseCommitAcknowledgement();
    await assert.rejects(apply(h), /commit_ack_lost/);
    const after = clone(h.state);
    const retry = await apply(h); assert.equal(retry.applied, false); assert.deepEqual(h.state, after);
});

for (const [name, pattern] of [['discussion move', /^UPDATE discussion_posts SET/], ['scene reinsertion', /^INSERT INTO topic_scenes/],
    ['archive insertion', /^INSERT INTO topic_migration_archive/], ['marker insertion', /^INSERT INTO schema_migrations/]]) {
    test(`failure during ${name} rolls back every category, scene, alias and identity change`, async () => {
        const h = sceneTaxonomyDatabase(), before = clone(h.state); h.failNext(pattern);
        await assert.rejects(apply(h), /injected_taxonomy_failure/);
        assert.deepEqual(h.state, before); assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
        assert.equal((await apply(h)).applied, true);
    });
}

test('a forged official ID, unexpected new-topic slug owner or proposal reservation is rejected before mutation', async () => {
    const mutations = [
        state => { state.categories.find(row => row.ID === 196).owner_user_ID = 5; },
        state => { state.categories.find(row => row.ID === 176).created_by_user_ID = 5; },
        state => { state.categories.find(row => row.ID === 54).name = 'Other'; },
        state => { state.categories.find(row => row.ID === 9002).slug = 'vector-graphics'; },
        state => { state.proposals.push({ ID: 3, status: 'pending', reservation_slug: 'video-projects', reservation_name: 'Video Projects' }); }
    ];
    for (const mutate of mutations) {
        const state = sceneTaxonomyFixtureState(); mutate(state); const h = sceneTaxonomyDatabase(state);
        await assert.rejects(apply(h)); assert.deepEqual(h.state, state);
        assert.equal(h.calls.some(row => /^(INSERT|UPDATE|DELETE) /.test(row.sql)), false);
    }
});

test('hyphenated canonical slugs cannot steal a space-normalized legacy alias', async () => {
    for (const slug of ['real-time-visual-output', 'vector-graphics', 'video-projects', 'gui-operation']) {
        const state = sceneTaxonomyFixtureState();
        state.aliases.push({ route_key: legacyTopicRouteKey(slug), category_ID: 9002 });
        assert.throws(() => planSceneTaxonomy(state), /already reserved/);
        const h = sceneTaxonomyDatabase(state); await assert.rejects(apply(h), /already reserved/);
        assert.deepEqual(h.state, state);
    }
});

test('existing aliases owned by the same renamed official topic do not block its canonical address', () => {
    const state = sceneTaxonomyFixtureState();
    state.aliases.push({ route_key: legacyTopicRouteKey('gui-operation'), category_ID: 176 });
    assert.equal(planSceneTaxonomy(state).topics.find(row => row.ID === 176).slug, 'gui-operation');
});

test('a scene attached to an approved proposal cannot be moved through an unchecked composite FK', async () => {
    const state = sceneTaxonomyFixtureState(), scene = legacy(state, 172, { output: 'vector' });
    state.proposals.push({ ID: 1, status: 'approved', scene_context_ID: scene.context_ID, parent_topic_ID: 172 });
    const h = sceneTaxonomyDatabase(state);
    await assert.rejects(apply(h), /attached proposal/); assert.deepEqual(h.state, state);
});

test('missing, corrupt or ambiguous legacy identities are rejected instead of silently retargeting references', () => {
    const corrupt = sceneTaxonomyFixtureState();
    corrupt.contexts.find(row => row.ID === 1095).context_hash = 'wrong'; assert.throws(() => planSceneTaxonomy(corrupt), /identity/);
    const ambiguous = sceneTaxonomyFixtureState(), original = legacy(ambiguous, 172, { reference_image: 'single' });
    const context = sceneContext(12001);
    ambiguous.contexts.push({ ID: 12001, category_ID: 172, context_values: context.serialized, context_hash: context.contextHash });
    ambiguous.scenes.push({ ...original, context_ID: 12001, name: 'Duplicate semantic scope', slug: 'duplicate-semantic-scope' });
    assert.throws(() => planSceneTaxonomy(ambiguous), /Ambiguous legacy scene/);
});

test('schema checks require the completed base migration and reject unknown context references without repair', async () => {
    const absent = sceneTaxonomyDatabase(); absent.state.markers = [];
    await assert.rejects(verifySceneTaxonomySchema(absent.db), /base topic scene migration first/);
    const h = sceneTaxonomyDatabase();
    h.extraForeignKeys.push({ tableName: 'unreviewed_cache', columnName: 'context_ID', target: 'ranking_contexts', targetColumn: 'ID', localReference: 1 });
    await assert.rejects(verifySceneTaxonomySchema(h.db), /Unreviewed/);
    assert.ok(h.calls.every(row => /^SELECT/.test(row.sql)));
});

test('write authorization is backup-first; rehearsal cannot target production and disables binlog only in an isolated DB', async () => {
    const ordinary = sceneTaxonomyDatabase();
    await assert.rejects(migrateTopicScenesTaxonomy(ordinary.db), /fresh backup manifest/);
    assert.deepEqual(ordinary.calls.map(row => row.sql), ['SELECT DATABASE() AS name']);
    const production = sceneTaxonomyDatabase(); production.state.database = 'benchmarks';
    await assert.rejects(apply(production), /isolated database/);
    assert.equal(production.calls.some(row => row.sql === 'SET SESSION sql_log_bin = 0' || row.sql === 'BEGIN'), false);
    const h = sceneTaxonomyDatabase(); await apply(h);
    const logOff = h.calls.findIndex(row => row.sql === 'SET SESSION sql_log_bin = 0');
    const begin = h.calls.findIndex(row => row.sql === 'BEGIN'); assert.ok(logOff >= 0 && logOff < begin);
    assert.equal(h.calls[begin + 1].sql, 'SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE');
    assert.equal(h.calls.some(row => /CREATE DATABASE|DROP DATABASE|INSERT INTO .* SELECT|CREATE TABLE/.test(row.sql)), false, 'Taxonomy rehearsal never clones a database');
});

test('rehearsal statfs guard enforces two GiB of free database-volume space', () => {
    const blocks = 2n * 1024n ** 3n / 4096n;
    assert.throws(() => assertTaxonomyRehearsalSpace({ bsize: 4096n, bavail: blocks - 1n }), /2 GiB/);
    assert.deepEqual(assertTaxonomyRehearsalSpace({ bsize: 4096n, bavail: blocks }), { availableBytes: '2147483648', requiredBytes: '2147483648' });
});

test('post-migration verification remains read-only and rejects lost aliases, drifted defaults and stale context identities', async () => {
    const original = sceneTaxonomyDatabase(); await apply(original);
    const mutations = [
        state => { state.scenes.find(row => row.category_ID === 190 && row.is_default).is_default = 0; },
        state => { state.scenes.find(row => row.category_ID === 219 && row.is_active && row.position === 10).position = 9000; },
        state => { state.contexts.find(row => row.ID === 1095).category_ID = 54; },
        state => { state.aliases = state.aliases.filter(row => row.route_key !== legacyTopicRouteKey('computer-work')); },
        state => { state.scenes.find(row => row.category_ID === 219 && row.is_active === 0).name = 'Other meaning'; },
        state => { state.archives[0].payload = JSON.stringify({ ...parse(state.archives[0].payload), specHash: 'wrong' }); }
    ];
    for (const mutate of mutations) {
        const state = clone(original.state); mutate(state); const h = sceneTaxonomyDatabase(state);
        await assert.rejects(verifyTopicScenesTaxonomy(h.db)); assert.deepEqual(h.state, state);
        assert.ok(h.calls.every(row => /^SELECT/.test(row.sql)));
    }
});

test('script exposes separate apply/check/rehearsal modes and does not include broad destructive migration SQL', () => {
    const source = readFileSync(new URL('../scripts/migrate-topic-scenes-taxonomy-20261031.mjs', import.meta.url), 'utf8');
    assert.match(source, /--backup-manifest=/); assert.match(source, /--check/); assert.match(source, /--apply/); assert.match(source, /--rehearse/);
    assert.doesNotMatch(source, /FOREIGN_KEY_CHECKS|TRUNCATE|DROP TABLE|DELETE FROM (?:ranking_contexts|personal_pies|personal_pie_weights|discussion_posts|categories)\b/);
});
