import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuestDraftStore } from '../public/js/workspace/guest-drafts.js';

function memoryStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, value); }
    };
}

test('temporary personal weights stay isolated by category and context', () => {
    const storage = memoryStorage();
    const store = createGuestDraftStore(() => storage);
    store.set('1:[["budget","standard"]]', { entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [] });
    store.set('1:[["budget","extended"]]', { entries: [{ conditionID: 2, weightBasisPoints: 10000 }], fallbackRules: [] });
    const restored = createGuestDraftStore(() => storage);
    assert.equal(restored.get('1:[["budget","standard"]]').entries[0].conditionID, 1);
    assert.equal(restored.get('1:[["budget","extended"]]').entries[0].conditionID, 2);
    const draft = restored.get('1:[["budget","standard"]]');
    draft.entries[0].weightBasisPoints = 0;
    assert.equal(restored.get('1:[["budget","standard"]]').entries[0].weightBasisPoints, 10000);
    restored.delete('1:[["budget","standard"]]');
    assert.equal(createGuestDraftStore(() => storage).get('1:[["budget","standard"]]'), null);
});

test('unavailable browser storage is reported rather than silently promising persistence through login', () => {
    const store = createGuestDraftStore(() => { throw new Error('blocked'); });
    assert.equal(store.set('context', { entries: [], fallbackRules: [] }), false);
    assert.equal(store.storageAvailable, false);
    assert.deepEqual(store.get('context'), { entries: [], fallbackRules: [] });
});

test('guest weight drafts reject bundled estimation votes', () => {
    const storage = memoryStorage();
    const store = createGuestDraftStore(() => storage);
    const draft = { entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [] };
    assert.throws(() => store.set('scene', { ...draft,
        estimationVotes: [{ targetConditionID: 1, sourceConditionID: 901, vote: 'oppose' }] }), /Invalid guest draft/);
    assert.equal(store.get('scene'), null);
});

test('stored guest weights recover even when obsolete scene votes repeated a pair', () => {
    const storage = memoryStorage();
    const store = createGuestDraftStore(() => storage);
    const draft = { entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [] };
    store.set('scene', draft);
    const slot = 'benchpoll:guest-pie:v3:scene';
    const record = JSON.parse(storage.getItem(slot));
    const retiredVotes = [{ conditionID: 900, vote: 'oppose' },
        { targetConditionID: 1, sourceConditionID: 901, vote: 'oppose' },
        { targetConditionID: 901, sourceConditionID: 1, vote: 'support' }];
    record.value.estimationVotes = retiredVotes;
    storage.setItem(slot, JSON.stringify(record));
    const restored = createGuestDraftStore(() => storage);
    assert.deepEqual(restored.get('scene'), draft);
    assert.equal(restored.token('scene'), record.token);

    storage.setItem('benchpoll-guest-weights-v2-ordered', JSON.stringify([['scene', { ...draft, estimationVotes: retiredVotes }]]));
    const legacy = restored.getLegacy('scene');
    assert.deepEqual(legacy, draft);
    assert.equal(restored.discardLegacy('scene', legacy), true);
    assert.equal(restored.getLegacy('scene'), null);
});

test('every successfully saved guest context survives reloading beyond fifty drafts', () => {
    const storage = memoryStorage();
    const store = createGuestDraftStore(() => storage);
    for (let context = 1; context <= 75; context += 1) {
        assert.equal(store.set(`${context}:[]`, {
            entries: [{ conditionID: context, weightBasisPoints: 10000 }],
            fallbackRules: []
        }), true);
    }

    const restored = createGuestDraftStore(() => storage);
    assert.equal(restored.storageAvailable, true);
    for (let context = 1; context <= 75; context += 1) {
        assert.deepEqual(restored.get(`${context}:[]`), {
            entries: [{ conditionID: context, weightBasisPoints: 10000 }],
            fallbackRules: []
        });
    }
});
