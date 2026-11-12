import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { savePrivateTopic, readPrivateTopicEditor, deletePrivateTopic, setTopicVisibility, setTopicFavorite } from '../private-topic-service.js';
import { getTopic, resolveTopicLocation } from '../topic-service.js';
import { loadPersonalPie, savePersonalPie } from '../ranking-service.js';

const rejects = code => error => error.body?.error === code;
const edit = topic => ({ categoryID: topic.ID, expectedRevision: topic.editRevision, name: topic.name,
    description: topic.description, scenes: topic.scenes.map(scene => ({ key: 's' + scene.ID, ID: scene.ID,
        name: scene.name, description: scene.description })), defaultSceneKey: topic.hasScenes ? 's' + topic.defaultContextID : null });

test('private editing, publication cap, persistent aliases and favorites in isolated MySQL', { skip: !process.env.LIFECYCLE_MYSQL_ENV_FILE }, async t => {
    const database = await createLifecycleDatabase(); t.after(() => database.close());
    const db = database.pool; await seedLifecycleEvidence(db);
    const create = (name, scenes = true) => savePrivateTopic(db, '42', { name, description: 'Evaluate useful work.',
        scenes: scenes ? [{ key: 'general', name: 'General', description: '' }, { key: 'research', name: 'Research', description: '' }] : [],
        defaultSceneKey: scenes ? 'general' : null }, randomUUID());
    let topic = await create('Work index');
    await assert.rejects(readPrivateTopicEditor(db, '43', { categoryID: topic.ID }), rejects('private_topic_not_found'));
    const initialScenes = topic.scenes.map(scene => ({ ID: scene.ID, number: scene.sceneNumber }));
    const changes = edit(topic); changes.scenes.reverse(); changes.scenes[0].name = 'Deep research'; changes.defaultSceneKey = changes.scenes[0].key;
    const key = randomUUID();
    const saved = await Promise.all([savePrivateTopic(db, '42', changes, key), savePrivateTopic(db, '42', changes, key)]);
    assert.deepEqual(saved[0], saved[1]); topic = saved[0];
    assert.deepEqual(topic.scenes.map(scene => ({ ID: scene.ID, number: scene.sceneNumber })), initialScenes.reverse());
    assert.equal(topic.scenes[0].url, `/private/${topic.privateID}/2`);
    await assert.rejects(savePrivateTopic(db, '42', changes, randomUUID()), rejects('private_topic_changed'));
    await savePersonalPie(db, { userID: '42', writeIdentity: randomUUID(), categoryID: topic.ID,
        contextValues: { scene: String(topic.defaultContextID) }, expectedRevision: 0,
        entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [] });
    topic = await setTopicVisibility(db, '42', { categoryID: topic.ID, isPublic: true }, randomUUID());
    assert.equal(topic.isPrivate, false);
    assert.equal((await loadPersonalPie(db, topic.defaultContextID, '42')).entries[0].conditionID, 1);
    assert.equal((await resolveTopicLocation(db, null, { privateID: topic.privateID })).path, `/${topic.publicID}/2`);
    const other = await create('Other', false); await setTopicVisibility(db, '42', { categoryID: other.ID, isPublic: true }, randomUUID());
    const candidates = [await create('Third', false), await create('Fourth', false)];
    const attempts = await Promise.allSettled(candidates.map(item => setTopicVisibility(db, '42', { categoryID: item.ID, isPublic: true }, randomUUID())));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.body.error, 'public_topic_limit');
    const favoriteKey = randomUUID();
    const favorites = await Promise.all([1, 2].map(() => setTopicFavorite(db, '43', { categoryID: topic.ID, isFavorited: true }, favoriteKey)));
    assert.equal(favorites[0].favoriteCount, 1); assert.deepEqual(favorites[0], favorites[1]);
    topic = await setTopicVisibility(db, '42', { categoryID: topic.ID, isPublic: false }, randomUUID());
    await assert.rejects(getTopic(db, '43', topic.ID), rejects('topic_not_found'));
    await assert.rejects(resolveTopicLocation(db, '42', { publicID: topic.publicID }), rejects('topic_not_found'));
    assert.equal((await resolveTopicLocation(db, '42', { privateID: topic.privateID })).path, `/private/${topic.privateID}/2`);
    topic = await savePrivateTopic(db, '42', { ...edit(topic), scenes: [], defaultSceneKey: null }, randomUUID());
    assert.equal(topic.scenes.length, 0); assert.equal((await loadPersonalPie(db, topic.defaultContextID, '42')).entries[0].conditionID, 1);
    await deletePrivateTopic(db, '42', { categoryID: topic.ID, expectedRevision: topic.editRevision }, randomUUID());
    await assert.rejects(getTopic(db, '42', topic.ID), rejects('topic_not_found'));
});
