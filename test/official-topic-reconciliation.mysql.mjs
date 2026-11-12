import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { allocateTopicIdentity } from '../topic-platform-schema.js';
import { OFFICIAL_TOPIC_CATALOGUE, initializeOfficialTopics } from '../official-topic-catalogue.js';
import { ensureTopicRootContext, insertTopicScene, EMPTY_TOPIC_CONTEXT_HASH } from '../topic-scenes-service.js';
import { readOfficialTopicState, planOfficialTopicReconciliation, reconcileOfficialTopics } from '../official-topic-reconciliation.js';
import { loadPersonalPie, resolveRankingContext } from '../ranking-service.js';
import { getTopic, resolveTopicLocation } from '../topic-service.js';
import { loadGlobalConditionWeights } from '../global-topic-weights.js';

test('existing official catalogue reconciles transactionally while retaining saved context identities in MySQL',
    { skip: !process.env.LIFECYCLE_MYSQL_ENV_FILE }, async t => {
    const database = await createLifecycleDatabase();
    await seedLifecycleEvidence(database.pool);
    const connection = await database.pool.getConnection(); t.after(async () => { connection.release(); await database.close(); });
    async function add(name, scenes = [], { owner = null, creator = null } = {}) {
        const identity = await allocateTopicIdentity(connection);
        const [inserted] = await connection.execute(`INSERT INTO categories
            (name, slug, description, public_ID, private_ID, is_official, owner_user_ID, created_by_user_ID)
            VALUES (?, ?, 'Original description.', ?, ?, ?, ?, ?)`,
        [name, name.toLowerCase().replaceAll(' ', '-'), identity.publicID, identity.privateID, creator == null ? 1 : 0, owner, creator]);
        const ID = Number(inserted.insertId), root = await ensureTopicRootContext(connection, ID);
        for (const [index, sceneName] of scenes.entries()) await insertTopicScene(connection, ID,
            { name: sceneName, description: '', isDefault: index === 0 }, { contextID: index === 0 ? root : null, position: index });
        return { ID, root, publicID: identity.publicID };
    }
    await connection.beginTransaction();
    const privateTopic = await add('Language', [], { owner: '42', creator: '42' });
    const publicTopic = await add('Natural Language', [], { creator: '43' });
    const intelligence = await add('Intelligence');
    const coding = await add('Coding', ['General', 'Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'PHP']);
    await add('Language', ['General', 'English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Arabic']);
    const creation = await add('3D Generation', ['General', 'With Reference Image', 'No Reference Image']);
    await add('Multimodal Understanding', ['General', 'Non-Real-Time', 'Real-Time']);
    await add('Image Generation', ['General', 'No Reference Image', 'Single Reference Image', 'Multiple Reference Images']);
    const vector = await add('Vector Graphics', ['General', 'No Reference Image', 'With Reference Image']);
    await add('Video Generation', ['General', 'No Reference Image', 'With Reference Image']);
    const teaching = await add('Teaching');
    const renamed = new Map();
    for (const [from, to] of [['Office', 'Professional Work'], ['AGI', 'ASI'], ['Medical Diagnosis', 'Medicine'],
        ['Writing', 'Creative Writing'], ['Knowledge & Retrieval', 'Knowledge Retrieval'],
        ['Low Hallucination', 'Factual Accuracy'], ['Memory & Long Context', 'Long Context']]) {
        renamed.set(to, await add(from));
    }
    await connection.execute('INSERT INTO discussion_posts (category_ID, context_ID, author_ID, body) VALUES (?, ?, ?, ?)',
        [intelligence.ID, intelligence.root, '42', 'A discussion that should retain its topic.']);
    await connection.execute('INSERT INTO topic_favorites (category_ID, user_ID) VALUES (?, ?)', [intelligence.ID, '43']);
    const [[retiredScene]] = await connection.execute("SELECT context_ID FROM topic_scenes WHERE category_ID = ? AND name = 'No Reference Image'", [creation.ID]);
    const [retiredPie] = await connection.execute('INSERT INTO personal_pies (user_ID, context_ID) VALUES (?, ?)', ['43', retiredScene.context_ID]);
    await connection.execute('INSERT INTO personal_pie_weights (pie_ID, benchmark_condition_ID, weight_basis_points) VALUES (?, 2, 10000)', [retiredPie.insertId]);
    for (const root of [intelligence.root, creation.root]) {
        const [pie] = await connection.execute('INSERT INTO personal_pies (user_ID, context_ID) VALUES (?, ?)', ['42', root]);
        await connection.execute('INSERT INTO personal_pie_weights (pie_ID, benchmark_condition_ID, weight_basis_points) VALUES (?, 1, 10000)', [pie.insertId]);
    }
    await connection.commit();
    const [protectedBefore] = await connection.execute('SELECT * FROM categories WHERE ID IN (?, ?) ORDER BY ID', [privateTopic.ID, publicTopic.ID]);
    const [scenesBefore] = await connection.execute('SELECT context_ID, scene_number, name FROM topic_scenes WHERE category_ID = ? ORDER BY context_ID', [coding.ID]);
    const before = await readOfficialTopicState(connection);
    const dryRun = planOfficialTopicReconciliation(before);
    assert.equal(dryRun.topics.find(topic => topic.name === 'Intelligence').publicID, 1);
    assert.equal(dryRun.topics.find(topic => topic.name === 'Intelligence').previousPublicID, intelligence.publicID);
    assert.ok(dryRun.retireTopics.some(topic => topic.categoryID === teaching.ID));
    assert.deepEqual(await readOfficialTopicState(connection), before, 'Planning performs no writes');
    const [sequenceBefore] = await connection.query('SELECT next_public_ID FROM topic_id_sequence WHERE ID = 1');
    await connection.beginTransaction(); await reconcileOfficialTopics(connection); await connection.rollback();
    assert.deepEqual(await readOfficialTopicState(connection), before, 'All catalogue mutations roll back together');
    assert.deepEqual((await connection.query('SELECT next_public_ID FROM topic_id_sequence WHERE ID = 1'))[0], sequenceBefore);
    await connection.beginTransaction();
    const applied = await reconcileOfficialTopics(connection);
    await connection.commit();
    assert.equal(applied.topics.length, 26);
    assert.ok(applied.renumberedTopics > 0);
    const defaultContext = await resolveRankingContext(connection, {});
    assert.equal(defaultContext.categoryID, intelligence.ID);
    assert.notEqual(intelligence.publicID, 1);
    const [officials] = await connection.query('SELECT ID, name, public_ID FROM categories WHERE is_official = 1 AND is_active = 1 ORDER BY position');
    assert.deepEqual(officials.map(row => row.name), applied.topics.map(topic => topic.name));
    assert.deepEqual(officials.map(row => Number(row.public_ID)), Array.from({ length: 26 }, (_, index) => index + 1));
    for (const [name, original] of renamed) assert.equal(Number(officials.find(topic => topic.name === name).ID), original.ID);
    assert.equal(Number((await connection.execute('SELECT is_active FROM categories WHERE ID = ?', [vector.ID]))[0][0].is_active), 0);
    const [protectedAfter] = await connection.execute('SELECT * FROM categories WHERE ID IN (?, ?) ORDER BY ID', [privateTopic.ID, publicTopic.ID]);
    assert.deepEqual(protectedAfter.map(({ public_ID, updated_at, ...row }) => row), protectedBefore.map(({ public_ID, updated_at, ...row }) => row),
        'User-owned content and private identifiers survive public renumbering');
    assert.deepEqual(protectedAfter.map(row => Number(row.public_ID)), [27, 28]);
    assert.equal((await resolveTopicLocation(connection, null, { publicID: 1 })).topic.ID, intelligence.ID);
    assert.equal((await resolveTopicLocation(connection, '42', { privateID: protectedBefore[0].private_ID })).topic.ID, privateTopic.ID);
    assert.equal((await resolveTopicLocation(connection, null, { privateID: protectedBefore[1].private_ID })).path, '/28');
    assert.equal((await getTopic(connection, '43', intelligence.ID)).favoriteCount, 1);
    assert.equal(Number((await connection.query('SELECT category_ID FROM discussion_posts'))[0][0].category_ID), intelligence.ID);
    const [scenesAfter] = await connection.execute('SELECT context_ID, scene_number, name FROM topic_scenes WHERE category_ID = ? AND is_active = 1 ORDER BY context_ID', [coding.ID]);
    assert.equal(scenesAfter.length, 12);
    assert.deepEqual(scenesAfter.filter(row => row.name !== 'Frontend'), scenesBefore);
    assert.equal(scenesAfter.find(row => row.name === 'Frontend').scene_number, 12);
    for (const root of [intelligence.root, creation.root]) {
        assert.equal((await loadPersonalPie(connection, root, '42')).entries[0].weightBasisPoints, 10000);
        const [[row]] = await connection.execute('SELECT context_hash FROM ranking_contexts WHERE ID = ?', [root]);
        assert.equal(row.context_hash, EMPTY_TOPIC_CONTEXT_HASH);
    }
    assert.equal(Number((await connection.execute('SELECT COUNT(*) AS count FROM topic_scenes WHERE category_ID = ? AND is_active = 1', [creation.ID]))[0][0].count), 0);
    assert.equal((await loadPersonalPie(connection, Number(retiredScene.context_ID), '43')).entries[0].weightBasisPoints, 10000);
    const creationMetadata = await getTopic(connection, '43', creation.ID);
    assert.equal(creationMetadata.configured, false); assert.equal(creationMetadata.configurationCount, 1);
    assert.deepEqual(await loadGlobalConditionWeights(connection), new Map([[1, 20000]]), 'Retired scene weights do not influence current defaults');
    const identities = await connection.query('SELECT ID, public_ID, private_ID, next_scene_number FROM categories ORDER BY ID');
    await connection.beginTransaction(); const repeated = await reconcileOfficialTopics(connection); await connection.commit();
    assert.equal(repeated.renumberedTopics, 0);
    assert.deepEqual((await connection.query('SELECT ID, public_ID, private_ID, next_scene_number FROM categories ORDER BY ID'))[0], identities[0], 'Reapplication allocates no new identities');
    const [[highest]] = await connection.query('SELECT MAX(public_ID) AS publicID FROM categories');
    await connection.beginTransaction();
    assert.equal((await allocateTopicIdentity(connection)).publicID, Number(highest.publicID) + 1);
    await connection.rollback();
});

test('fresh initialization assigns requested official numbers and reference scenes in MySQL',
    { skip: !process.env.LIFECYCLE_MYSQL_ENV_FILE }, async t => {
    const database = await createLifecycleDatabase();
    const connection = await database.pool.getConnection(); t.after(async () => { connection.release(); await database.close(); });
    await connection.beginTransaction();
    const topics = await initializeOfficialTopics(connection);
    await connection.commit();
    assert.deepEqual(topics.map(topic => topic.name), OFFICIAL_TOPIC_CATALOGUE.map(topic => topic.name));
    assert.deepEqual(topics.map(topic => topic.publicID), Array.from({ length: 26 }, (_, index) => index + 1));
    for (const [index, definition] of OFFICIAL_TOPIC_CATALOGUE.entries()) {
        const resolved = await resolveTopicLocation(connection, null, { publicID: index + 1 });
        assert.equal(resolved.topic.name, definition.name);
        assert.equal(resolved.topic.description, definition.description);
        assert.equal(resolved.path, `/${index + 1}${definition.scenes.length ? '/1' : ''}`);
        assert.deepEqual(resolved.topic.scenes.map(scene => scene.name), definition.scenes.map(scene => scene.name));
    }
    await connection.beginTransaction();
    assert.equal((await reconcileOfficialTopics(connection)).renumberedTopics, 0);
    await connection.commit();
});
