import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolveTopicScene, serializeTopicScene, sceneContext, loadTopicScenes,
    createPrivateTopicScene, updatePrivateTopicScene, setPrivateTopicDefaultScene,
    normalizeTopicSceneRequest, loadTopicSceneCatalog, ensureTopicRootContext, topicSceneURL, TOPIC_SCENE_SQL_PREVIEW } from '../topic-scenes-service.js';
import { searchTopicsAndScenes } from '../topic-service.js';
import { buildCategoryNavigation, buildPersonalNavigation } from '../navigation-service.js';
import { selectSearchScene } from '../search-presentation.js';
import { scenePath, topicSlug } from '../public/js/shared/topics.js';
import { sceneDatabase } from './helpers/topic-scenes-fixture-20261031.mjs';

const errorIs = code => error => error.body?.error === code;
const raw = (contextID, defaults = {}) => ({ context_ID: contextID, category_ID: 172, name: `Scene ${contextID}`,
    slug: `scene-${contextID}`, description: 'A useful scene.', position: contextID, is_default: 0, is_active: 1, ...defaults });
const scenes = () => [serializeTopicScene(raw(101, { name: 'Vector output', legacy_context_values: { output: 'vector', realtime: 'any' } })),
    serializeTopicScene(raw(1095, { name: 'General', is_default: 1, legacy_context_values: { output: 'any', realtime: 'any' } }))];

test('accepted long scene names serialize and resolve legacy truncated slugs without colliding with shorter names', async () => {
    const h = sceneDatabase(), prefix = 'a'.repeat(79), name = prefix + ' b';
    const request = normalizeTopicSceneRequest({ categoryID: 172, name, description: 'A long scene name.' });
    const storedSlug = topicSlug(request.name), expectedSlug = storedSlug + 'scene';
    assert.equal(storedSlug, prefix + '-');
    for (const categoryID of [172, 501]) {
        const ID = categoryID + 1000, siblingID = ID + 1;
        h.seedContext(categoryID, ID, { scene: String(ID) });
        h.seedContext(categoryID, siblingID, { scene: String(siblingID) });
        h.state.scenes.push(raw(ID, { category_ID: categoryID, name, slug: storedSlug, is_default: 1 }),
            raw(siblingID, { category_ID: categoryID, name: prefix, slug: prefix }));
        const catalog = (await loadTopicSceneCatalog(h.pool, [categoryID])).get(categoryID);
        const topic = { ...h.state.categories.find(row => row.ID === categoryID), scenes: catalog.scenes };
        const base = categoryID === 172 ? '/image-generation' : '/personal/501';
        const scene = catalog.scenes.find(item => item.ID === ID);
        assert.equal(scene.name, name);
        assert.equal(scene.slug, expectedSlug);
        assert.equal(scene.url, `${base}/${expectedSlug}`);
        assert.equal(topicSceneURL(topic, { name, slug: storedSlug }), scene.url);
        assert.equal(topicSceneURL(topic, { name }), scene.url);
        assert.equal(scenePath(base, scene), scene.url);
        assert.equal(selectSearchScene(topic, new URLSearchParams(), expectedSlug).ID, ID);
        assert.equal(selectSearchScene(topic, new URLSearchParams(), prefix).ID, siblingID);
        assert.equal((await resolveTopicScene(h.pool, topic, { scene: String(ID) })).ID, ID);
        assert.equal(h.state.scenes.find(item => item.context_ID === ID).slug, storedSlug, 'Reading does not rewrite stored identities');
    }
});

test('creating and renaming accepted long scenes returns resolvable canonical paths', async () => {
    const h = sceneDatabase();
    for (const prefix of ['b'.repeat(79), 'c'.repeat(79)]) {
        const name = prefix + ' tail', slug = prefix + '-scene';
        const existing = h.state.scenes.find(scene => scene.name !== 'General');
        const result = existing
            ? await updatePrivateTopicScene(h.pool, '42', { categoryID: 501, sceneID: existing.context_ID, name, description: 'Renamed scene.' })
            : await createPrivateTopicScene(h.pool, '42', { categoryID: 501, name, description: 'New scene.' });
        assert.equal(result.scene.name, name);
        assert.equal(result.scene.slug, slug);
        assert.equal(result.scene.url, `/personal/501/${slug}`);
        assert.equal(selectSearchScene({ scenes: result.scenes }, new URLSearchParams(), slug).ID, result.sceneID);
        assert.equal((await resolveTopicScene(h.pool, { ID: 501 }, { scene: String(result.sceneID) })).ID, result.sceneID);
    }
});

test('browsing selects exactly one default first, while writes and references pin explicit scene identities', async () => {
    const options = { scenes: scenes() }, topic = { ID: 172 };
    const result = await resolveTopicScene(null, topic, {}, options);
    assert.equal(result.ID, 1095); assert.deepEqual(result.contextValues, { scene: '1095' });
    assert.deepEqual(result.contextDisplayValues, { scene: 'General' }); assert.deepEqual(result.dimensions, []);
    assert.equal(result.contextHash, sceneContext(1095).contextHash);
    assert.deepEqual(result.scenes.map(scene => scene.ID), [1095, 101]);
    for (const flag of ['requireExplicit', 'forReference', 'requireAllDimensions']) {
        await assert.rejects(resolveTopicScene(null, topic, {}, { ...options, [flag]: true }), errorIs('topic_scene_required'));
    }
    assert.equal((await resolveTopicScene(null, topic, { scene: '101' }, { ...options, forReference: true })).ID, 101);
    assert.equal((await resolveTopicScene(null, topic, {}, { ...options, forReference: true, contextID: 101 })).ID, 101);
});

test('legacy context mapping is exact and never invents Cartesian combinations', async () => {
    const options = { scenes: scenes(), requireAllDimensions: true };
    assert.equal((await resolveTopicScene(null, { ID: 172 }, { realtime: 'any', output: 'vector' }, options)).ID, 101);
    assert.equal((await resolveTopicScene(null, { ID: 172 }, { realtime: 'any', output: 'any' }, options)).ID, 1095);
    for (const values of [{ output: 'vector' }, { output: 'vector', realtime: 'yes' }, { output: 'missing', realtime: 'any' }]) {
        await assert.rejects(resolveTopicScene(null, { ID: 172 }, values, options), errorIs('topic_scene_not_found'));
    }
    await assert.rejects(resolveTopicScene(null, { ID: 172 }, { realtime: 'any', output: 'vector' }, { ...options, forReference: true }), errorIs('topic_scene_not_found'));
});

test('malformed, inactive, cross-topic and mismatched scene selections fail closed', async () => {
    for (const values of [{ scene: '0' }, { scene: '-1' }, { scene: '0101' }, { scene: 101 }, { scene: '101', output: 'vector' }, []]) {
        await assert.rejects(resolveTopicScene(null, { ID: 172 }, values, { scenes: scenes() }));
    }
    await assert.rejects(resolveTopicScene(null, { ID: 173 }, { scene: '101' }, { scenes: scenes() }), errorIs('topic_scene_not_found'));
    await assert.rejects(resolveTopicScene(null, { ID: 172 }, { scene: '999' }, { scenes: scenes() }), errorIs('topic_scene_not_found'));
    await assert.rejects(resolveTopicScene(null, { ID: 172 }, { scene: '101' }, { scenes: scenes(), contextID: 1095 }), errorIs('ranking_context_values_mismatch'));
    await assert.rejects(resolveTopicScene(null, { ID: 172 }, {}, { scenes: [scenes()[0]] }), errorIs('topic_scene_default_invalid'));
    assert.equal(await resolveTopicScene(null, { ID: 54 }, {}, { scenes: [] }), null);
    await assert.rejects(resolveTopicScene(null, { ID: 54 }, { scene: '101' }, { scenes: [] }), errorIs('topic_scene_not_found'));
});

test('private creation preserves root identity, uses canonical URLs and takes graph lock before user locks', async () => {
    const h = sceneDatabase();
    const created = await createPrivateTopicScene(h.pool, '42', { categoryID: 501, name: 'Coding', description: 'Write useful software.' });
    assert.equal(created.defaultContextID, 99);
    assert.deepEqual(created.scenes.map(scene => scene.name), ['General', 'Coding']);
    assert.equal(created.scenes[0].url, '/personal/501/general');
    assert.equal(h.state.contexts.find(row => row.ID === 99).context_values, '{"scene":"99"}');
    const graph = h.events.findIndex(event => event.sql.includes('topic_reference_lock'));
    const user = h.events.findIndex(event => event.sql.includes('FROM users'));
    assert.ok(graph < user);
    assert.deepEqual(h.events.slice(-2).map(event => event.sql), ['COMMIT', 'RELEASE']);
});

test('a first General scene reuses the root without creating a duplicate General', async () => {
    const h = sceneDatabase();
    const result = await createPrivateTopicScene(h.pool, '42', { categoryID: 501, name: 'General', description: 'Overall work.' });
    assert.equal(result.sceneID, 99); assert.equal(result.scenes.length, 1); assert.equal(result.scene.isDefault, true);
});

test('private owner authentication, public restrictions and one-level shape are enforced', async () => {
    const h = sceneDatabase(), request = { categoryID: 501, name: 'Coding', description: 'Write software.' };
    await assert.rejects(createPrivateTopicScene(h.pool, null, request), errorIs('authentication_required'));
    await assert.rejects(createPrivateTopicScene(h.pool, '43', request), errorIs('private_topic_not_found'));
    await assert.rejects(createPrivateTopicScene(h.pool, '42', { ...request, categoryID: 172 }), errorIs('private_topic_not_found'));
    for (const extra of [{ parentSceneID: 99 }, { scenes: [] }, { categoryID: '501' }, { isDefault: 'yes' }]) {
        assert.throws(() => normalizeTopicSceneRequest({ ...request, ...extra }));
    }
    assert.equal(h.state.scenes.length, 0);
});

test('scene updates and default changes retain identity and never remove the last default', async () => {
    const h = sceneDatabase();
    const created = await createPrivateTopicScene(h.pool, '42', { categoryID: 501, name: 'Coding', description: 'Write software.' });
    const result = await updatePrivateTopicScene(h.pool, '42', { categoryID: 501, sceneID: created.sceneID,
        name: 'Programming', description: 'Build programs.', isDefault: true });
    assert.equal(result.scenes[0].ID, created.sceneID); assert.equal(result.scene.name, 'Programming');
    await assert.rejects(updatePrivateTopicScene(h.pool, '42', { categoryID: 501, sceneID: created.sceneID,
        name: 'Programming', description: 'Build programs.', isDefault: false }), errorIs('topic_scene_default_required'));
    assert.equal((await setPrivateTopicDefaultScene(h.pool, '42', { categoryID: 501, sceneID: 99 })).defaultContextID, 99);
    await assert.rejects(setPrivateTopicDefaultScene(h.pool, '42', { categoryID: 501, sceneID: 172 }), errorIs('topic_scene_not_found'));
});

test('scene mutation is atomic and retries cannot create duplicate scenes', async () => {
    const h = sceneDatabase(), body = { categoryID: 501, name: 'Coding', description: 'Write software.', isDefault: true };
    const key = randomUUID(), first = await createPrivateTopicScene(h.pool, '42', body, key);
    assert.deepEqual(await createPrivateTopicScene(h.pool, '42', body, key), first);
    assert.equal(h.state.scenes.length, 2);
    const before = structuredClone(h.state);
    h.failWhen(sql => sql.startsWith('INSERT INTO topic_scenes'));
    await assert.rejects(createPrivateTopicScene(h.pool, '42', { ...body, name: 'Writing' }), /injected_failure/);
    assert.deepEqual(h.state, before);
});

test('concurrent defaults serialize on the shared graph lock and leave exactly one default', async () => {
    const h = sceneDatabase();
    const result = await createPrivateTopicScene(h.pool, '42', { categoryID: 501, name: 'Coding', description: 'Write software.' });
    await Promise.all([setPrivateTopicDefaultScene(h.pool, '42', { categoryID: 501, sceneID: result.sceneID }),
        setPrivateTopicDefaultScene(h.pool, '42', { categoryID: 501, sceneID: 99 })]);
    assert.equal(h.state.scenes.filter(scene => scene.is_default).length, 1);
});

test('committed scene retries survive lost acknowledgements without repeating or undoing later edits/default changes', async () => {
    const h = sceneDatabase(), body = { categoryID: 501, name: 'Coding', description: 'Write software.', isDefault: true };
    const key = randomUUID();
    h.failWhen(sql => sql === 'COMMIT_ACK');
    await assert.rejects(createPrivateTopicScene(h.pool, '42', body, key), /commit_ack_lost/);
    assert.equal(h.state.scenes.length, 2);
    const createdID = h.state.scenes.find(scene => scene.name === 'Coding').context_ID;
    h.failWhen(null);
    await updatePrivateTopicScene(h.pool, '42', { categoryID: 501, sceneID: createdID,
        name: 'Programming', description: 'Build software.' }, randomUUID());
    await setPrivateTopicDefaultScene(h.pool, '42', { categoryID: 501, sceneID: 99 }, randomUUID());
    const retry = await createPrivateTopicScene(h.pool, '42', body, key);
    assert.equal(retry.sceneID, createdID); assert.equal(retry.scene.name, 'Programming');
    assert.equal(retry.defaultContextID, 99); assert.equal(h.state.scenes.length, 2);
    await assert.rejects(createPrivateTopicScene(h.pool, '42', { ...body, name: 'Other' }, key),
        error => error.status === 409 && error.body.error === 'write_identity_reused');
});

test('root creation rejects synthetic insert IDs unless the connection is the explicitly marked preview recorder', async () => {
    const connection = { async execute(sql) { return /^SELECT/.test(sql) ? [[]] : [{ insertId: -1 }]; } };
    await assert.rejects(ensureTopicRootContext(connection, 172, { allowSynthetic: true }), errorIs('invalid_topic_context_insert'));
    assert.equal(await ensureTopicRootContext({ ...connection, [TOPIC_SCENE_SQL_PREVIEW]: true }, 172), -1);
});

test('scene discovery is batched, includes roots, and search returns exact scene destinations', async () => {
    const h = sceneDatabase();
    await createPrivateTopicScene(h.pool, '42', { categoryID: 501, name: 'Vector graphics', description: 'Scalable drawings.' });
    h.seedContext(172, 1095);
    const catalog = await loadTopicSceneCatalog(h.pool, [501, 172]);
    assert.equal(catalog.get(172).rootContextID, 1095);
    const topics = [{ ID: 501, name: 'My work', description: 'My daily work.', ...catalog.get(501) }];
    const matches = searchTopicsAndScenes(topics, 'scalable');
    assert.equal(matches.length, 1); assert.equal(matches[0].searchMatches[0].name, 'Vector graphics');
    assert.match(matches[0].searchMatches[0].url, /^\/personal\/501\/vector-graphics$/);
    const parentMatch = searchTopicsAndScenes(topics, 'My work');
    assert.deepEqual(parentMatch[0].searchMatches, [], 'parent matches are not attributed to every child');
    assert.equal(parentMatch[0].scenes.length, topics[0].scenes.length, 'full catalogue remains available for explicit expansion');
    assert.equal(searchTopicsAndScenes(topics, 'My work scalable')[0].searchMatches[0].name, 'Vector graphics');
    const nav = buildCategoryNavigation([{ ...h.state.categories[0], position: 0 }], catalog);
    assert.equal(nav[0].rootContextID, 1095);
    const configured = buildPersonalNavigation([{ contextID: 99, categoryID: 501, contextValues: '{"scene":"99"}',
        weightCount: 2, totalBasisPoints: 10000, unavailableConditions: 0, unavailableReferences: 0 }], h.state.categories, [], [], catalog);
    assert.equal(configured[0].contextLabel, 'General'); assert.equal(configured[0].available, true);
    assert.equal(configured[0].url, '/personal/501/general');
    assert.equal((await loadTopicScenes(h.pool, 501))[0].ID, 99);
});
