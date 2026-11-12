import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMON_LANGUAGE_SCENES, planCommonLanguageScenes } from '../scripts/migrate-common-language-scenes-20261104.mjs';
import { sceneContext, EMPTY_TOPIC_CONTEXT_HASH } from '../topic-scenes-service.js';
import { topicSlug, sceneSlug, scenePath } from '../public/js/shared/topics.js';

const historical = JSON.parse(readFileSync(new URL('../ops/topic-scenes-taxonomy-20261031.json', import.meta.url), 'utf8'));
function fixture() {
    const topics = [COMMON_LANGUAGE_SCENES.language, COMMON_LANGUAGE_SCENES.coding].map(topic => ({ ID: topic.ID, name: topic.name,
        slug: topic.slug, description: 'A synthetic topic.', owner_user_ID: null, created_by_user_ID: null, parent_ID: null, is_active: 1 }));
    const contexts = [{ ID: 1088, category_ID: 180, context_hash: EMPTY_TOPIC_CONTEXT_HASH, context_values: {} }];
    const scenes = historical.topics.find(topic => topic.ID === 219).scenes.map((scene, index) => {
        const ID = 1162 + index, context = sceneContext(ID);
        contexts.push({ ID, category_ID: 219, context_hash: context.contextHash, context_values: context.contextValues });
        return { context_ID: ID, category_ID: 219, name: scene.name, slug: topicSlug(scene.name), position: index * 10,
            is_default: Number(index === 0), is_active: 1, legacy_context_values: { language: scene.language ?? 'any', task: 'any' } };
    });
    return { topics, contexts, scenes };
}

test('common scene plan retains language identities and reuses Coding root without mutating its input', () => {
    const state = fixture(), before = structuredClone(state), plan = planCommonLanguageScenes(state);
    assert.equal(plan.retired.length, 176);
    assert.deepEqual(plan.retained.map(row => row.name), ['General', 'English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Arabic']);
    assert.deepEqual(plan.added.map(row => row.name), ['General', 'Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'PHP']);
    assert.equal(plan.added[0].contextID, 1088);
    assert.equal(plan.added.filter(row => row.contextID === null).length, 10);
    assert.equal(new Set(plan.added.map(row => row.slug)).size, 11);
    assert.deepEqual(plan.added.slice(5, 8).map(row => row.slug), ['c', 'c-plus-plus', 'c-sharp']);
    assert.deepEqual(state, before);
    assert.equal(plan.planHash, planCommonLanguageScenes(structuredClone(state)).planHash);
});

test('scene plan rejects changed ownership, defaults, identities and reserved Coding paths', () => {
    const variants = [
        state => { state.topics[0].owner_user_ID = '42'; },
        state => { state.topics[1].name = 'Other coding'; },
        state => { state.scenes[0].is_default = 0; },
        state => { state.scenes[1].is_active = 0; },
        state => { state.contexts[0].context_values = { changed: true }; },
        state => { state.contexts[1].context_hash = EMPTY_TOPIC_CONTEXT_HASH; },
        state => { state.scenes.push({ category_ID: 180, context_ID: 9999, name: 'Python', slug: 'python', is_active: 0 }); }
    ];
    for (const change of variants) { const state = fixture(); change(state); assert.throws(() => planCommonLanguageScenes(state)); }
});

test('reviewed plan changes when scoped metadata changes', () => {
    const state = fixture(), hash = planCommonLanguageScenes(state).planHash;
    state.topics[0].description = 'A changed summary.';
    assert.notEqual(planCommonLanguageScenes(state).planHash, hash);
});

test('scene labels retain language distinctions while URLs use local numeric identity', () => {
    assert.deepEqual(['C', 'C++', 'C#'].map(sceneSlug), ['c', 'c-plus-plus', 'c-sharp']);
    assert.equal(scenePath('/2', { name: 'C++', sceneNumber: 8 }), '/2/8');
    assert.equal(scenePath('/2', { name: 'C#', sceneNumber: 9 }), '/2/9');
    assert.equal(scenePath('/private/AbCdEf123456', { name: 'C++', sceneNumber: 1, slug: 'existing-path' }), '/private/AbCdEf123456/1');
    assert.equal(topicSlug('C++'), 'c');
});
