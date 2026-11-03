import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { savePrivateTopic, readPrivateTopicEditor, deletePrivateTopic } from '../private-topic-service.js';
import { savePersonalPie } from '../ranking-service.js';
import { createTopicProposalService, readProposal } from '../topic-proposal-service.js';
import { createDiscussionPost, listDiscussion, voteDiscussion, deleteDiscussionPost,
    validateDiscussionReport, applyDiscussionReport } from '../discussion-service.js';
import { migrateProposalDiscussions } from '../scripts/migrate-proposal-discussions-20261103.mjs';

const rejects = code => error => error.body?.error === code;
test('proposal discussion scopes, deletion phases and all-scene feeds in isolated MySQL', async t => {
    const database = await createLifecycleDatabase(); t.after(() => database.close());
    const db = database.pool; await seedLifecycleEvidence(db);
    const service = createTopicProposalService({ pool: db, queueForReview: async (connection, proposal) => {
        const [result] = await connection.execute('INSERT INTO moderation_logs (content, report_count, user_id) VALUES (?, 1, ?)',
            [JSON.stringify({ type: 'new_topic', proposalID: proposal.ID }), proposal.user_ID]);
        return Number(result.insertId);
    } });
    const create = async (name, owner = '42') => {
        const topic = await savePrivateTopic(db, owner, { name, description: 'A synthetic evaluation topic.',
            scenes: [{ key: 'a', name: 'General' }, { key: 'b', name: 'Research' }], defaultSceneKey: 'a' }, randomUUID());
        for (const scene of topic.scenes) await savePersonalPie(db, { userID: owner, writeIdentity: randomUUID(), categoryID: topic.ID,
            contextValues: { scene: String(scene.ID) }, expectedRevision: 0,
            entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [] });
        return topic;
    };
    const post = async (owner, body) => {
        await db.execute('UPDATE discussion_posts SET created_at = NOW(3) - INTERVAL 1 MINUTE WHERE author_ID = ?', [owner]);
        return createDiscussionPost(db, owner, { text: 'Useful discussion about the proposal.', mentions: [], ...body });
    };
    const source = await create('Collecting topic'), otherSource = await create('Review topic', '43');
    const proposal = await service.propose('42', { sourceTopicID: source.ID }, randomUUID());
    const other = await service.propose('43', { sourceTopicID: otherSource.ID }, randomUUID());
    let root, reply;

    await t.test('migration is repeatable and keeps existing feed identities', async () => {
        assert.equal((await migrateProposalDiscussions(db, { apply: true })).changed, false);
        assert.deepEqual(await migrateProposalDiscussions(db), { applied: false, missingColumn: false, missingKey: false, needsNullableScope: false });
    });
    await t.test('public comments, replies and votes stay in their proposal without exposing a private topic', async () => {
        root = await post('42', { proposalID: proposal.proposalID });
        reply = await post('43', { proposalID: proposal.proposalID, parentID: root.ID });
        await post('1000', { proposalID: other.proposalID });
        await assert.rejects(post('1001', { proposalID: other.proposalID, parentID: root.ID }), rejects('discussion_scope_mismatch'));
        await assert.rejects(post('1001', { proposalID: proposal.proposalID, categoryID: source.ID }), rejects('discussion_scope_mismatch'));
        await assert.rejects(listDiscussion(db, null, { proposalID: other.proposalID, threadID: reply.ID }), rejects('discussion_post_unavailable'));
        const feed = await listDiscussion(db, null, { proposalID: proposal.proposalID });
        assert.equal(feed.total, 1); assert.equal(feed.posts[0].replyCount, 1);
        assert.equal(feed.posts[0].categoryID, null); assert.equal(feed.posts[0].contextID, null);
        assert.deepEqual(feed.posts[0].contextValues, {});
        assert.equal(feed.posts[0].proposalID, proposal.proposalID);
        const thread = await listDiscussion(db, '43', { proposalID: proposal.proposalID, threadID: reply.ID });
        assert.equal(thread.root.ID, root.ID); assert.equal(thread.posts[0].ID, reply.ID); assert.equal(thread.posts[0].isOwn, true);
        await assert.rejects(voteDiscussion(db, '42', { postID: root.ID, value: 1 }), rejects('discussion_self_vote'));
        await voteDiscussion(db, '1002', { postID: root.ID, value: 1 });
        assert.equal((await listDiscussion(db, '1002', { proposalID: proposal.proposalID })).posts[0].myVote, 1);
    });
    await t.test('author deletion retains replies and existing reports moderate proposal messages', async () => {
        await assert.rejects(deleteDiscussionPost(db, '42', { postID: reply.ID }), rejects('discussion_delete_forbidden'));
        await deleteDiscussionPost(db, '42', { postID: root.ID });
        const feed = await listDiscussion(db, null, { proposalID: proposal.proposalID });
        assert.equal(feed.posts[0].isDeleted, true); assert.equal(feed.posts[0].text, '');
        const report = { postID: reply.ID };
        await validateDiscussionReport(db, report);
        assert.equal(report.pageURL, `/topic-proposals/${proposal.proposalID}/preview?threadID=${root.ID}#discussion`);
        await applyDiscussionReport(db, report);
        assert.equal((await listDiscussion(db, null, { proposalID: proposal.proposalID })).total, 0);
    });
    await t.test('source deletion withdraws collecting proposals and cascades only their discussion', async () => {
        assert.equal((await readPrivateTopicEditor(db, '42', { categoryID: source.ID })).hasCollectingProposal, true);
        const request = { categoryID: source.ID, expectedRevision: source.editRevision }, key = randomUUID();
        await deletePrivateTopic(db, '42', request, key);
        assert.deepEqual(await deletePrivateTopic(db, '42', request, key), { categoryID: source.ID, deleted: true });
        await assert.rejects(readProposal(db, proposal.proposalID, null), rejects('topic_proposal_not_found'));
        await assert.rejects(listDiscussion(db, null, { proposalID: proposal.proposalID }), rejects('topic_proposal_not_found'));
        assert.equal((await db.execute('SELECT ID FROM discussion_posts WHERE proposal_ID = ?', [proposal.proposalID]))[0].length, 0);
        assert.equal((await listDiscussion(db, null, { proposalID: other.proposalID })).total, 1);
    });
    await t.test('review snapshots and their discussion survive source deletion', async () => {
        for (let i = 0; i < 30; i++) await service.support(String(1000 + i), { proposalID: other.proposalID, revision: 1 }, randomUUID());
        assert.equal((await readPrivateTopicEditor(db, '43', { categoryID: otherSource.ID })).hasCollectingProposal, false);
        await deletePrivateTopic(db, '43', { categoryID: otherSource.ID, expectedRevision: otherSource.editRevision }, randomUUID());
        assert.equal((await readProposal(db, other.proposalID, null)).status, 'pending');
        assert.equal((await listDiscussion(db, null, { proposalID: other.proposalID })).total, 1);
    });
    await t.test('all-scenes removes the scene filter while retaining the topic boundary', async () => {
        const topic = await create('Public scenes'), second = await create('Other public topic');
        await db.execute('UPDATE categories SET owner_user_ID = NULL WHERE ID IN (?, ?)', [topic.ID, second.ID]);
        const general = await post('1001', { categoryID: topic.ID, contextValues: { scene: String(topic.scenes[0].ID) } });
        const research = await post('1002', { categoryID: topic.ID, contextValues: { scene: String(topic.scenes[1].ID) } });
        await post('1003', { categoryID: second.ID, contextValues: { scene: String(second.scenes[0].ID) } });
        const body = { categoryID: topic.ID, contextValues: { scene: String(topic.scenes[0].ID) }, sort: 'new' };
        assert.deepEqual((await listDiscussion(db, null, body)).posts.map(post => post.ID), [general.ID]);
        const all = await listDiscussion(db, null, { ...body, allScenes: true });
        assert.deepEqual(all.posts.map(post => post.ID), [research.ID, general.ID]);
        assert.equal(all.context.sceneID, topic.scenes[0].ID);
        assert.equal((await listDiscussion(db, null, { ...body, allScenes: true, threadID: research.ID })).root.ID, research.ID);
        await assert.rejects(listDiscussion(db, null, { ...body, allScenes: 'true' }), rejects('invalid_discussion_scope'));
    });
    await t.test('deletion racing the final support either withdraws collection or preserves review atomically', async () => {
        const topic = await create('Race at review');
        const proposed = await service.propose('42', { sourceTopicID: topic.ID }, randomUUID());
        for (let i = 0; i < 29; i++) await service.support(String(1000 + i), { proposalID: proposed.proposalID, revision: 1 }, randomUUID());
        const [support, deletion] = await Promise.allSettled([
            service.support('1029', { proposalID: proposed.proposalID, revision: 1 }, randomUUID()),
            deletePrivateTopic(db, '42', { categoryID: topic.ID, expectedRevision: topic.editRevision }, randomUUID())
        ]);
        assert.equal(deletion.status, 'fulfilled');
        const [rows] = await db.execute('SELECT status FROM topic_proposals WHERE ID = ?', [proposed.proposalID]);
        if (support.status === 'fulfilled') { assert.equal(support.value.status, 'pending'); assert.equal(rows[0].status, 'pending'); }
        else { assert.equal(support.reason.body?.error, 'topic_proposal_not_found'); assert.equal(rows.length, 0); }
    });
});
