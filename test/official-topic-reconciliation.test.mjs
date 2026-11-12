import test from 'node:test';
import assert from 'node:assert/strict';
import { planOfficialTopicReconciliation } from '../official-topic-reconciliation.js';
import { EMPTY_TOPIC_CONTEXT_HASH, sceneContext } from '../topic-scenes-service.js';

const category = (ID, name, extra = {}) => ({ ID, name, slug: name.toLowerCase().replaceAll(' ', '-'),
    is_official: 1, is_active: 1, public_ID: ID + 10, owner_user_ID: null, created_by_user_ID: null, ...extra });
const context = (ID, category_ID, root = false) => ({ ID, category_ID,
    context_hash: root ? EMPTY_TOPIC_CONTEXT_HASH : sceneContext(ID).contextHash });
const scene = (context_ID, category_ID, name, extra = {}) => ({ context_ID, category_ID, name,
    scene_number: context_ID, is_default: 0, is_active: 1, ...extra });

test('reconciliation retains semantic identities, preserves General configuration and ignores authored topics', () => {
    const state = { categories: [category(54, 'Intelligence'), category(219, 'Language'), category(191, '3D Generation'),
        category(216, 'Teaching'), category(500, 'Language', { is_official: 0, owner_user_ID: '42', created_by_user_ID: '42' }),
        category(501, 'Natural Language', { is_official: 0, created_by_user_ID: '43' })],
    contexts: [context(1, 54, true), context(2, 219), context(3, 219), context(4, 191), context(5, 191)],
    scenes: [scene(2, 219, 'General', { is_default: 1 }), scene(3, 219, 'English'),
        scene(4, 191, 'General', { is_default: 1 }), scene(5, 191, 'With Reference Image')] };
    const before = structuredClone(state), plan = planOfficialTopicReconciliation(state);
    assert.equal(plan.topics.length, 23); assert.equal(plan.untouchedUserTopicCount, 2);
    const intelligence = plan.topics.find(topic => topic.name === 'Intelligence');
    assert.equal(intelligence.categoryID, 54); assert.equal(intelligence.publicID, 64); assert.equal(intelligence.rootContextID, 1);
    const language = plan.topics.find(topic => topic.name === 'Natural Language');
    assert.equal(language.categoryID, 219); assert.equal(language.slug, 'natural-language-official');
    assert.equal(language.scenes[0].contextID, 2); assert.equal(language.scenes[1].contextID, 3);
    assert.equal(language.scenes[1].sceneNumber, 3);
    const creation = plan.topics.find(topic => topic.name === '3D Creation');
    assert.equal(creation.categoryID, 191); assert.equal(creation.rootContextID, 4);
    assert.deepEqual(creation.retireSceneIDs, [4, 5]); assert.deepEqual(creation.scenes, []);
    assert.deepEqual(plan.retireTopics, [{ categoryID: 216, name: 'Teaching' }]);
    assert.deepEqual(state, before);
});

test('read-only pre-schema plans derive official ownership without changing current IDs', () => {
    const plan = planOfficialTopicReconciliation({ categories: [category(54, 'Intelligence', { is_official: undefined, public_ID: undefined }),
        category(100, 'Mine', { is_official: undefined, created_by_user_ID: '42' })], contexts: [], scenes: [] });
    assert.equal(plan.topics[0].categoryID, 54); assert.equal(plan.topics[0].publicID, null);
    assert.equal(plan.untouchedUserTopicCount, 1);
});

test('ambiguous official matches stop the plan rather than silently replacing configuration', () => {
    assert.throws(() => planOfficialTopicReconciliation({ categories: [category(1, 'Language'), category(2, 'Natural Language')],
        contexts: [], scenes: [] }), /Ambiguous official topic/);
});
