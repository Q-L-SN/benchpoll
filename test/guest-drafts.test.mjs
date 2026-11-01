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
