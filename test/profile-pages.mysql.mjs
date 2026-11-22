import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { loadUserProfile, saveUserProfile, loadPublicUserProfile, saveProfilePrivacy } from '../user-profile-service.js';
import { savePrivateTopic, setTopicVisibility, setTopicFavorite } from '../private-topic-service.js';
import { getTopic, readProfileTopics } from '../topic-service.js';
import { savePersonalPie } from '../ranking-service.js';
import { recordProfileVisit, loadProfileHistory, clearProfileHistory } from '../profile-history-service.js';
import { listDiscussion, listProfileDiscussion } from '../discussion-service.js';

const errorCode = code => error => error.body?.error === code;
const topicIDs = topics => topics.map(topic => topic.ID).sort((a, b) => a - b);
const tab = (result, key) => result.tabs.find(item => item.key === key);

test('real profile SQL keeps editable IDs unique, collections private and history owner scoped in isolated MySQL', {
    skip: !process.env.LIFECYCLE_MYSQL_ENV_FILE, timeout: 90000
}, async t => {
    const database = await createLifecycleDatabase();
    t.after(() => database.close());
    const db = database.pool;
    const [[version]] = await db.query('SELECT VERSION() AS version');
    assert.match(version.version, /^8\.4\./);
    await seedLifecycleEvidence(db);

    const originalOwner = await loadUserProfile(db, '42'), originalOther = await loadUserProfile(db, '43');
    assert.equal(originalOwner.publicID, '1');
    assert.equal(originalOther.publicID, '2');
    const edited = await saveUserProfile(db, '42', { publicID: 'Synthetic-Owner', displayName: 'Synthetic profile owner',
        bio: 'Comparing synthetic model evidence.' });
    assert.equal(edited.publicID, 'synthetic-owner');
    assert.equal(edited.profileURL, '/@synthetic-owner');
    assert.equal(edited.bio, 'Comparing synthetic model evidence.');
    await assert.rejects(saveUserProfile(db, '43', { publicID: 'SYNTHETIC-OWNER', displayName: 'Must roll back' }),
        errorCode('profile_public_id_taken'));
    assert.equal((await loadUserProfile(db, '43')).userName, originalOther.userName, 'a collision rolls back the whole edit');
    await assert.rejects(db.execute('UPDATE user_public_profiles SET public_id = ? WHERE user_ID = ?', ['synthetic-owner', '43']),
        error => error.code === 'ER_DUP_ENTRY');
    await saveUserProfile(db, '42', { publicID: 'owner-updated' });
    await assert.rejects(loadPublicUserProfile(db, { publicID: 'synthetic-owner' }, readProfileTopics), errorCode('profile_not_found'));

    const create = (owner, name) => savePrivateTopic(db, owner, { name, description: 'Evaluate synthetic benchmark evidence.',
        scenes: [], defaultSceneKey: null }, randomUUID());
    const published = await create('42', 'Published profile topic');
    await setTopicVisibility(db, '42', { categoryID: published.ID, isPublic: true }, randomUUID());
    const privateTopic = await create('42', 'Private profile topic');
    const favorite = await create('43', 'Favorited configured topic');
    await setTopicVisibility(db, '43', { categoryID: favorite.ID, isPublic: true }, randomUUID());
    for (const topic of [favorite, privateTopic]) {
        await setTopicFavorite(db, '42', { categoryID: topic.ID, isFavorited: true }, randomUUID());
        await savePersonalPie(db, { userID: '42', writeIdentity: randomUUID(), categoryID: topic.ID,
            contextValues: {}, expectedRevision: 0, entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [] });
    }

    const load = viewerID => loadPublicUserProfile(db, { publicID: 'owner-updated', viewerID }, readProfileTopics);
    const own = await loadPublicUserProfile(db, { self: true, viewerID: '42' }, readProfileTopics);
    assert.equal(own.isSelf, true);
    assert.deepEqual(own.tabs.map(item => [item.key, item.private]), [['created', false], ['favorites', true], ['configured', true]]);
    assert.deepEqual(topicIDs(tab(own, 'created').topics), topicIDs([published, privateTopic]));
    for (const key of ['favorites', 'configured']) assert.deepEqual(topicIDs(tab(own, key).topics), topicIDs([favorite, privateTopic]));
    const anonymous = await load(null);
    assert.equal(anonymous.isSelf, false);
    assert.deepEqual(anonymous.tabs.map(item => item.key), ['published']);
    assert.deepEqual(topicIDs(tab(anonymous, 'published').topics), [published.ID]);
    for (const field of ['userID', 'email', 'role', 'githubUsername', 'publishFavorites', 'publishConfiguredTopics']) {
        assert.equal(Object.hasOwn(anonymous.profile, field), false);
    }

    await saveProfilePrivacy(db, '42', { publishFavorites: true, publishConfiguredTopics: false });
    const favoritesOnly = await load('43');
    assert.deepEqual(favoritesOnly.tabs.map(item => item.key), ['published', 'favorites']);
    assert.deepEqual(topicIDs(tab(favoritesOnly, 'favorites').topics), [favorite.ID]);
    await saveProfilePrivacy(db, '42', { publishFavorites: true, publishConfiguredTopics: true });
    const shared = await load(null);
    assert.deepEqual(shared.tabs.map(item => [item.key, item.private]), [['published', false], ['favorites', false], ['configured', false]]);
    for (const key of ['favorites', 'configured']) assert.deepEqual(topicIDs(tab(shared, key).topics), [favorite.ID],
        'public sharing never exposes the owner\'s private topic');
    assert.equal(tab(shared, 'published').topics[0].creator.url, '/@owner-updated');
    assert.deepEqual(topicIDs(tab(await load('42'), 'configured').topics), topicIDs([favorite, privateTopic]));

    const favoriteInfo = await getTopic(db, '42', favorite.ID), privateInfo = await getTopic(db, '42', privateTopic.ID);
    await recordProfileVisit(db, '42', { categoryID: favorite.ID, contextID: favoriteInfo.rootContextID }, getTopic);
    await recordProfileVisit(db, '42', { categoryID: favorite.ID, contextID: favoriteInfo.rootContextID }, getTopic);
    await recordProfileVisit(db, '42', { categoryID: privateTopic.ID, contextID: privateInfo.rootContextID }, getTopic);
    await recordProfileVisit(db, '43', { categoryID: published.ID }, getTopic);
    await assert.rejects(recordProfileVisit(db, '43', { categoryID: privateTopic.ID }, getTopic), errorCode('topic_not_found'));
    const history = await loadProfileHistory(db, '42', {}, getTopic);
    assert.deepEqual(history.entries.map(item => item.categoryID).sort((a, b) => a - b), topicIDs([favorite, privateTopic]));
    assert.equal(history.entries.find(item => item.categoryID === privateTopic.ID).isPrivate, true);
    assert.equal((await loadProfileHistory(db, '43', {}, getTopic)).entries.length, 1);
    await assert.rejects(loadProfileHistory(db, '43', { userID: '42' }, getTopic), errorCode('profile_history_query_invalid'));

    await setTopicVisibility(db, '43', { categoryID: favorite.ID, isPublic: false }, randomUUID());
    const unavailable = await load(null);
    assert.deepEqual(tab(unavailable, 'favorites').topics, []);
    assert.deepEqual(tab(unavailable, 'configured').topics, []);
    assert.deepEqual((await loadProfileHistory(db, '42', {}, getTopic)).entries.map(item => item.categoryID), [privateTopic.ID]);
    await clearProfileHistory(db, '42', {});
    assert.deepEqual((await loadProfileHistory(db, '42', {}, getTopic)).entries, []);
    assert.equal((await loadProfileHistory(db, '43', {}, getTopic)).entries.length, 1, 'clearing one account preserves another account\'s history');
    t.diagnostic('MySQL 8.4: profile edits, unique IDs, three collection tabs, private-topic filtering and owner-scoped history passed.');
});

test('profile discussion lists only visible posts and replies, with stable pages and scene links', {
    skip: !process.env.LIFECYCLE_MYSQL_ENV_FILE, timeout: 90000
}, async t => {
    const database = await createLifecycleDatabase();
    t.after(() => database.close());
    const db = database.pool;
    const createTopic = name => savePrivateTopic(db, '42', {
        name, description: 'A topic for discussion activity tests.',
        scenes: [{ key: 'general', name: 'General' }, { key: 'focused', name: 'Focused' }],
        defaultSceneKey: 'general'
    }, randomUUID());
    const draft = await createTopic('Published discussion fixture');
    const topic = await setTopicVisibility(db, '42', { categoryID: draft.ID, isPublic: true }, randomUUID());
    const privateTopic = await createTopic('Private discussion fixture');
    const scene = topic.scenes.find(scene => scene.name === 'Focused');
    const createdAt = new Date('2026-11-12T12:00:00.123Z');
    async function post(body, { author = '42', parent = null, hidden = false, deleted = false,
        categoryID = topic.ID, contextID = scene.ID, date = createdAt } = {}) {
        const [insert] = await db.execute(`INSERT INTO discussion_posts
            (category_ID, context_ID, author_ID, parent_ID, body, created_at, hidden_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [categoryID, contextID, author, parent, body, date,
            hidden ? date : null, deleted ? date : null]);
        return Number(insert.insertId);
    }
    const main = await post('My own thread');
    const parent = await post('', { author: '43', deleted: true });
    const replies = [];
    for (let i = 0; i < 21; i++) replies.push(await post(`Reply ${i}`, { parent }));
    const hiddenParent = await post('Hidden parent', { author: '43', hidden: true });
    await post('Reply under a hidden parent', { parent: hiddenParent });
    await post('Hidden post', { hidden: true });
    await post('Removed post', { deleted: true });
    await post('Private post', { categoryID: privateTopic.ID, contextID: privateTopic.scenes[0].ID });
    await post('Someone else’s post', { author: '43' });

    const page = await listProfileDiscussion(db, { publicID: '1' });
    assert.deepEqual(page.posts.map(post => post.ID), replies.slice(1).reverse());
    assert.equal(page.posts[0].sceneName, 'Focused');
    assert.equal(page.posts[0].parentID, parent, 'Deleting a thread opener still allows visible replies');
    assert.equal(page.posts[0].url, `${scene.url}?discussion=1&threadID=${parent}`);
    const thread = await listDiscussion(db, null, { categoryID: topic.ID, threadID: parent });
    assert.equal(thread.root.ID, parent);
    assert.equal(thread.posts[0].ID, replies[0]);

    const newer = await post('A new thread', { date: new Date('2026-11-13T12:00:00.123Z') });
    await db.execute('UPDATE discussion_posts SET hidden_at = NOW(3) WHERE ID = ?', [page.nextCursor.ID]);
    const older = await listProfileDiscussion(db, { publicID: '1', before: page.nextCursor });
    assert.deepEqual(older.posts.map(post => post.ID), [replies[0], main]);
    assert.equal(older.posts[1].url, `${scene.url}?discussion=1&threadID=${main}`);
    assert.equal(older.nextCursor, null);
    assert.equal((await listProfileDiscussion(db, { publicID: '1' })).posts[0].ID, newer);

    await db.execute('UPDATE users SET banned_at = NOW(3), banned_until = NULL WHERE ID = 42');
    assert.deepEqual((await listProfileDiscussion(db, { publicID: '1' })).posts, []);
    await db.execute('UPDATE users SET banned_at = NULL WHERE ID = 42');
    await setTopicVisibility(db, '42', { categoryID: topic.ID, isPublic: false }, randomUUID());
    assert.deepEqual((await listProfileDiscussion(db, { publicID: '1' })).posts, []);
});
