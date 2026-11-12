import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTopicVisibility, setTopicFavorite, readPrivateTopicEditor } from '../private-topic-service.js';
import { resolveTopicLocation, getTopic, readProfileTopics, listTopics } from '../topic-service.js';
import { parseTopicPath, topicURL, scenePath } from '../public/js/shared/topics.js';
import { insertTopicScene, serializeTopicScene } from '../topic-scenes-service.js';
import { OFFICIAL_TOPIC_CATALOGUE } from '../official-topic-catalogue.js';
import { platformFixture, makeTopic } from './helpers/topic-platform-fixture.mjs';

const failure = code => error => error.body?.error === code;

test('public and private paths accept numeric local scenes and reject all old URLs', () => {
    assert.deepEqual(parseTopicPath('/12/2'), { publicID: 12, sceneNumber: 2 });
    assert.deepEqual(parseTopicPath('/private/AbCdEf123456/2'), { privateID: 'AbCdEf123456', sceneNumber: 2 });
    for (const path of ['/coding', '/coding/general', '/topics/12', '/personal/12', '/12?scene=2', '/12?context_scene=2',
        '/12?context_language=en', '/01', '/1/0', '/1/1/2', '//host/1', '/1%2f2', '/private/123']) assert.equal(parseTopicPath(path), null, path);
    assert.equal(topicURL({ publicID: 12, isPrivate: false }), '/12');
    assert.equal(topicURL({ privateID: 'AbCdEf123456', isPrivate: true }), '/private/AbCdEf123456');
    assert.equal(scenePath('/12', { ID: 999, sceneNumber: 2 }), '/12/2');
    assert.equal(scenePath('/12', { ID: 999, name: 'General' }), null);
});

test('concurrent publications enforce exactly three public topics and replay is idempotent', async () => {
    const db = platformFixture([makeTopic(1, '1', true), makeTopic(2, '1', true), makeTopic(3), makeTopic(4)]);
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled([3, 4].map((categoryID, i) => setTopicVisibility(db, '1', { categoryID, isPublic: true }, keys[i])));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.body.error, 'public_topic_limit');
    assert.equal(db.state().topics.filter(topic => topic.owner_user_ID == null).length, 3);
    const index = results.findIndex(result => result.status === 'fulfilled');
    assert.deepEqual(await setTopicVisibility(db, '1', { categoryID: index + 3, isPublic: true }, keys[index]), results[index].value);
    assert.ok(db.queries.find(row => /SELECT ID FROM users.*FOR UPDATE/.test(row.sql)));
});

test('only creator may publish or unpublish, and official topics cannot be changed', async () => {
    const db = platformFixture([makeTopic(1), makeTopic(2, '1', true, { is_official: 1 })]);
    await assert.rejects(setTopicVisibility(db, '2', { categoryID: 1, isPublic: true }, randomUUID()), failure('private_topic_not_found'));
    await assert.rejects(setTopicVisibility(db, '1', { categoryID: 2, isPublic: false }, randomUUID()), failure('private_topic_not_found'));
    assert.equal(db.state().topics[0].owner_user_ID, '1');
});

test('private alias persists through publication; retired public URLs fail for everyone', async () => {
    const db = platformFixture(), privateID = db.state().topics[0].private_ID;
    await assert.rejects(resolveTopicLocation(db, null, { privateID }), failure('topic_not_found'));
    assert.equal((await resolveTopicLocation(db, '1', { privateID })).path, `/private/${privateID}`);
    await setTopicVisibility(db, '1', { categoryID: 1, isPublic: true }, randomUUID());
    const alias = await resolveTopicLocation(db, null, { privateID });
    assert.equal(alias.path, '/1'); assert.equal(alias.topic.privateID, undefined);
    await setTopicVisibility(db, '1', { categoryID: 1, isPublic: false }, randomUUID());
    for (const viewer of [null, '1', '2']) await assert.rejects(resolveTopicLocation(db, viewer, { publicID: 1 }), failure('topic_not_found'));
    assert.equal((await resolveTopicLocation(db, '1', { privateID })).path, `/private/${privateID}`);
    await assert.rejects(getTopic(db, '2', 1), failure('topic_not_found'));
});

test('missing scene selects default numeric scene and scene IDs remain topic-local', async () => {
    const scenes = [{ context_ID: 801, scene_number: 1, name: 'General', slug: 'general', is_default: 1, is_active: 1 },
        { context_ID: 999, scene_number: 2, name: 'Frontend', slug: 'frontend', is_default: 0, is_active: 1 }];
    const db = platformFixture([makeTopic(1, '1', true, { scenes })]);
    assert.equal((await resolveTopicLocation(db, null, { publicID: 1 })).path, '/1/1');
    assert.equal((await resolveTopicLocation(db, null, { publicID: 1, sceneNumber: 2 })).scene.ID, 999);
    await assert.rejects(resolveTopicLocation(db, null, { publicID: 1, sceneNumber: 999 }), failure('topic_scene_not_found'));
});

test('favorites toggle once per account, preserve first activity, and reject private access', async () => {
    const db = platformFixture([makeTopic(1, '1', true), makeTopic(2)]), key = randomUUID();
    assert.deepEqual(await setTopicFavorite(db, '2', { categoryID: 1, isFavorited: true }, key), { categoryID: 1, isFavorited: true, favoriteCount: 1 });
    assert.equal((await setTopicFavorite(db, '2', { categoryID: 1, isFavorited: true }, key)).favoriteCount, 1);
    const first = db.state().favorites.get('1:2').first;
    await setTopicFavorite(db, '2', { categoryID: 1, isFavorited: false }, randomUUID());
    assert.equal((await setTopicFavorite(db, '2', { categoryID: 1, isFavorited: true }, randomUUID())).favoriteCount, 1);
    assert.equal(db.state().favorites.get('1:2').first, first);
    assert.equal((await setTopicFavorite(db, '3', { categoryID: 1, isFavorited: true }, randomUUID())).favoriteCount, 2);
    await assert.rejects(setTopicFavorite(db, '2', { categoryID: 2, isFavorited: true }, randomUUID()), failure('topic_not_found'));
    assert.equal(db.state().favorites.has('2:2'), false);
});

test('owner editor metadata preserves favorites and the public creator identity', async () => {
    const db = platformFixture([makeTopic(1, '1', true)]);
    await setTopicFavorite(db, '1', { categoryID: 1, isFavorited: true }, randomUUID());
    const editor = await readPrivateTopicEditor(db, '1', { categoryID: 1 });
    assert.equal(editor.isFavorited, true); assert.equal(editor.favoriteCount, 1);
    assert.equal(editor.creator.handle, '1'); assert.equal(editor.creator.url, '/@1');
    assert.equal(editor.url, '/1'); assert.equal(editor.isPrivate, false);
    assert.match(editor.editRevision, /^[a-f0-9]{64}$/);
});

test('public profile omits private topics and does not query hidden tabs', async () => {
    const db = platformFixture([makeTopic(1), makeTopic(2, '1', true)]);
    const result = await readProfileTopics(db, { userID: '1', viewerID: '1' });
    assert.deepEqual(result.published.map(topic => topic.ID), [2]);
    assert.equal(Object.hasOwn(result, 'favorites'), false); assert.equal(Object.hasOwn(result, 'configured'), false);
    assert.equal(db.queries.filter(row => row.sql.startsWith('SELECT c.ID, c.name')).length, 1);
});

test('featured topic identity is the official Intelligence storage ID regardless of its public number', async () => {
    const db = platformFixture([makeTopic(1, '1', true, { name: 'Intelligence' }),
        makeTopic(54, null, true, { name: 'Intelligence', is_official: 1, public_ID: 3 })]);
    assert.equal((await listTopics(db, null)).featuredTopicID, 54);
    assert.equal((await listTopics(db, null, { query: 'not a topic' })).featuredTopicID, 54);
    assert.equal((await listTopics(platformFixture([makeTopic(1, '1', true)]), null)).featuredTopicID, null);
});

test('scene URL number survives reinsert and creation allocates monotonically', async () => {
    let next = 4; const inserts = [];
    const connection = { execute: async (sql, args = []) => {
        if (sql.startsWith('SELECT next_scene_number')) return [[{ next_scene_number: next }]];
        if (sql.startsWith('UPDATE categories SET next_scene_number')) { next++; return [{ affectedRows: 1 }]; }
        if (sql.startsWith('INSERT INTO topic_scenes')) inserts.push(args);
        return [{ affectedRows: 1 }];
    } };
    await insertTopicScene(connection, 1, { name: 'Retained', description: '', isDefault: true }, { contextID: 111, sceneNumber: 2 });
    await insertTopicScene(connection, 1, { name: 'New', description: '', isDefault: false }, { contextID: 999 });
    assert.equal(inserts[0][2], 2); assert.equal(inserts[1][2], 4); assert.equal(next, 5);
    assert.equal(serializeTopicScene({ context_ID: 999, category_ID: 1, scene_number: 4, name: 'Renamed', is_default: 1 }, { publicID: 7 }).url, '/7/4');
});

test('official catalogue contains all requested topics and retains ten coding/eight language scenes', () => {
    assert.deepEqual(OFFICIAL_TOPIC_CATALOGUE.map(topic => topic.name), [
        'Intelligence', 'Agents', 'Coding', 'ASI', 'Professional Work', 'Academic Research', 'Natural Language', 'RSI',
        'Image Generation', 'Video Generation', 'Cybersecurity', 'Medicine', 'Knowledge Retrieval', 'Engineering Design',
        'Multimodal Understanding', 'GUI Operation', 'Robotics', 'Creative Writing', 'Business Management', 'Law', 'Finance',
        '3D Generation', 'Long Context', 'Foresight', 'Factual Accuracy', 'Probabilistic Decision-Making'
    ]);
    const find = name => OFFICIAL_TOPIC_CATALOGUE.find(topic => topic.name === name);
    assert.deepEqual(find('Coding').scenes.map(scene => scene.name), ['General', 'Frontend', 'Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'PHP']);
    assert.deepEqual(find('Natural Language').scenes.map(scene => scene.name), ['General', 'English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Arabic']);
    assert.deepEqual(find('Image Generation').scenes.map(scene => scene.name), ['General', 'Single Reference Image', 'Multiple Reference Images']);
    assert.deepEqual(find('Video Generation').scenes.map(scene => scene.name), ['General', 'With Reference Video', 'With Reference Image']);
    for (const topic of OFFICIAL_TOPIC_CATALOGUE.filter(topic => topic.scenes.length)) assert.equal(topic.scenes.filter(scene => scene.isDefault).length, 1);
});
