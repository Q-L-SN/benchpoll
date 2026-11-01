import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { createPersonalPieRecovery, pieRecoveryContextKey } from '../public/js/workspace/pie-recovery.js';
import { createGuestDraftStore } from '../public/js/workspace/guest-drafts.js';
import { createRetryableWrite } from '../public/js/shared/write-intent.js';

const context = { budget: 'standard' };
const draft = weight => ({ entries: [{ conditionID: 1, weightBasisPoints: weight },
    { conditionID: 2, weightBasisPoints: 10000 - weight }], fallbackRules: [] });
function storage() {
    const values = new Map();
    return { values, blocked: false, quota: false,
        getItem(key) { if (this.blocked) throw Error('blocked'); return values.get(key) ?? null; },
        setItem(key, value) { if (this.quota || this.blocked) throw Error('quota'); values.set(key, value); },
        removeItem(key) { if (this.quota || this.blocked) throw Error('quota'); values.delete(key); } };
}
function harness(store = storage(), ownerID = '7', categoryID = 1, contextValues = context) {
    const state = Object.assign(createWorkspaceState(), { userID: ownerID, authenticated: ownerID !== null,
        categoryID, selectedContextValues: { ...contextValues }, personalRevision: 1, personalEditVersion: 1,
        personalEntries: draft(6000).entries });
    const guestDrafts = createGuestDraftStore(() => store);
    const recovery = createPersonalPieRecovery({ state, guestDrafts, getStorage: () => store,
        snapshot: () => ({ entries: state.personalEntries, fallbackRules: state.personalFallbackRules }) });
    const request = () => ({ body: { expectedUserID: state.userID, categoryID, contextValues,
        expectedRevision: state.personalRevision, entries: structuredClone(state.personalEntries), fallbackRules: [] },
    editVersion: state.personalEditVersion, snapshot: { entries: structuredClone(state.personalEntries), fallbackRules: [] } });
    return { store, state, guestDrafts, recovery, request };
}

for (let repetition = 1; repetition <= 2; repetition++) {
    test(`owner recovery never appears to another owner or an anonymous reader (${repetition})`, () => {
        const h = harness(); h.recovery.checkpoint();
        for (const owner of ['8', null, '9007199254740993', '18446744073709551615']) {
            const next = harness(h.store, owner);
            assert.equal(next.recovery.lookup(owner, 1, context), null);
            assert.equal(next.guestDrafts.get(pieRecoveryContextKey(1, context)), null);
        }
        assert.deepEqual(harness(h.store).recovery.lookup('7', 1, context).value.draft, draft(6000));
    });
    test(`latest edits and the original pending body/identity survive independent reload (${repetition})`, () => {
        const h = harness(), request = h.request(), key = randomUUID();
        h.state.personalSaveRequest = request; h.recovery.capture(request, key);
        h.state.personalEntries = draft(7000).entries; h.state.personalEditVersion++;
        h.recovery.checkpoint();
        const next = harness(h.store), record = next.recovery.lookup('7', 1, context);
        assert.deepEqual(record.value.draft, draft(7000));
        assert.deepEqual(record.value.pending.body, request.body);
        assert.equal(record.value.pending.key, key);
        next.recovery.bind(record);
        assert.equal(next.state.personalEditVersion, 2);
        assert.equal(next.state.personalSaveRequest.editVersion, 1);
        assert.equal(next.state.personalSaveRequest.key, key);
    });
    test(`late acknowledgements and stale documents cannot remove or overwrite newer recovery (${repetition})`, () => {
        const old = harness(), request = old.request();
        old.state.personalSaveRequest = request; old.recovery.capture(request, randomUUID());
        const next = harness(old.store); next.recovery.bind(next.recovery.lookup('7', 1, context));
        next.state.personalEntries = draft(7000).entries; next.state.personalEditVersion++; next.recovery.checkpoint();
        assert.throws(() => old.recovery.acknowledge(request, 2), error => error.code === 'pie_recovery_changed');
        assert.throws(() => old.recovery.checkpoint(), error => error.code === 'pie_recovery_changed');
        assert.throws(() => old.recovery.discard(), error => error.code === 'pie_recovery_changed');
        assert.deepEqual(next.recovery.lookup('7', 1, context).value.draft, draft(7000));
    });
    test(`acknowledgement removes only the acknowledged generation and owner/context (${repetition})`, () => {
        const h = harness(), other = harness(h.store, '8'), elsewhere = harness(h.store, '7', 2);
        other.recovery.checkpoint(); elsewhere.recovery.checkpoint();
        const request = h.request(); h.state.personalSaveRequest = request; h.recovery.capture(request, randomUUID());
        h.recovery.acknowledge(request, 2);
        assert.equal(h.recovery.lookup('7', 1, context), null);
        assert.ok(other.recovery.lookup('8', 1, context)); assert.ok(elsewhere.recovery.lookup('7', 2, context));
    });
    test(`acknowledging an older edit keeps the latest draft, without its confirmed pending request (${repetition})`, () => {
        const h = harness(), request = h.request();
        h.state.personalSaveRequest = request; h.recovery.capture(request, randomUUID());
        h.state.personalEntries = draft(7000).entries; h.state.personalEditVersion++; h.recovery.checkpoint();
        h.recovery.acknowledge(request, 2);
        const record = harness(h.store).recovery.lookup('7', 1, context).value;
        assert.deepEqual(record.draft, draft(7000)); assert.equal(record.pending, null); assert.equal(record.revision, 2);
    });
    test(`guest adoption removes anonymous recovery before starting an account save (${repetition})`, () => {
        const h = harness(), key = pieRecoveryContextKey(1, context);
        h.guestDrafts.set(key, draft(6000)); h.state.usingGuestDraft = true;
        h.recovery.adoptGuest();
        assert.equal(h.guestDrafts.get(key), null);
        assert.deepEqual(h.recovery.lookup('7', 1, context).value.draft, draft(6000));
        assert.equal(h.state.recoveredPersonalDraft, true);
    });
}

test('canonical unsigned BIGINT accounts are exact, and invalid owner representations are never accepted', () => {
    for (const owner of ['9007199254740993', '18446744073709551615']) {
        const h = harness(storage(), owner); h.recovery.checkpoint();
        assert.equal(harness(h.store, owner).recovery.lookup(owner, 1, context).value.ownerID, owner);
    }
    for (const owner of [7, '07', '0', '', '18446744073709551616', '1.5']) {
        const h = harness(storage(), owner);
        assert.throws(() => h.recovery.checkpoint(), /Invalid account draft/);
        assert.equal(h.recovery.lookup(owner, 1, context), null);
    }
});

test('corrupt current records are quarantined while other owners and contexts remain readable', () => {
    const h = harness(), other = harness(h.store, '8'); other.recovery.checkpoint(); h.recovery.checkpoint();
    const key = [...h.store.values.keys()].find(key => key.includes('7%3A'));
    h.store.values.set(key, '{broken');
    const next = harness(h.store), record = next.recovery.lookup('7', 1, context);
    assert.equal(record.invalid, true); next.recovery.bind(record);
    assert.equal(next.state.personalRecoveryBlocked, true);
    assert.equal(next.state.personalSaveRequest, null);
    assert.ok(next.recovery.lookup('8', 1, context));
    assert.equal(next.recovery.discard(), true);
    assert.equal(next.recovery.lookup('7', 1, context), null);
});

test('tampered request scope, precision, UUID, revision and generation are rejected before restoration', () => {
    const changes = [
        record => { record.ownerID = '8'; }, record => { record.categoryID = 2; },
        record => { record.contextValues = { budget: 'extended' }; }, record => { record.editVersion = 1.5; },
        record => { record.pending.key = 'bad'; }, record => { record.pending.body.expectedUserID = '8'; },
        record => { record.pending.body.categoryID = 2; }, record => { record.pending.body.contextValues = {}; },
        record => { record.pending.body.expectedRevision = -1; }, record => { record.pending.body.expectedRevision = 2; },
        record => { record.pending.editVersion = 2; }, record => { record.pending.body.entries[0].conditionID = 9007199254740992; },
        record => { record.pending.body.entries = draft(7000).entries; }, record => { record.pending.body.unexpected = true; }
    ];
    for (const change of changes) {
        const h = harness(), request = h.request(); h.state.personalSaveRequest = request; h.recovery.capture(request, randomUUID());
        const [key, text] = [...h.store.values].find(([key]) => key.startsWith('benchpoll:owned-pie'));
        const record = JSON.parse(text); change(record.value); h.store.values.set(key, JSON.stringify(record));
        const next = harness(h.store), restored = next.recovery.lookup('7', 1, context);
        assert.equal(restored.invalid, true); next.recovery.bind(restored);
        assert.equal(next.state.personalSaveRequest, null); assert.equal(next.state.personalRecoveryBlocked, true);
    }
});

test('legacy ownerless drafts are preserved but never automatically returned as guest drafts', () => {
    const h = harness(), key = pieRecoveryContextKey(1, context);
    const raw = JSON.stringify([[key, draft(6000)], ['2:[]', draft(7000)], ['bad', null]]);
    h.store.values.set('benchpoll-guest-weights-v2-ordered', raw);
    assert.equal(h.guestDrafts.get(key), null);
    assert.equal(h.recovery.lookup('7', 1, context), null);
    assert.deepEqual(h.guestDrafts.getLegacy(key), draft(6000));
    assert.equal(h.store.values.get('benchpoll-guest-weights-v2-ordered'), raw);
    h.guestDrafts.discardLegacy(key, draft(6000));
    assert.deepEqual(h.guestDrafts.getLegacy('2:[]'), draft(7000));
});

for (const mode of ['blocked', 'quota']) test(`storage ${mode} retains in-document recovery and reports that it is not durable`, () => {
    const h = harness(); h.store[mode] = true;
    const request = h.request(); h.state.personalSaveRequest = request;
    h.recovery.capture(request, randomUUID());
    assert.equal(h.state.guestDraftStorageAvailable, false);
    assert.equal(h.recovery.storageAvailable, false);
    assert.deepEqual(h.recovery.lookup('7', 1, context).value.draft, draft(6000));
    assert.equal(h.state.guestDraftStorageAvailable, false);
    h.store[mode] = false; h.recovery.checkpoint();
    assert.equal(h.state.guestDraftStorageAvailable, true);
    assert.ok(harness(h.store).recovery.lookup('7', 1, context).value.pending.key);
});

test('guest binding must be durable or transport remains forbidden', () => {
    const h = harness(), key = pieRecoveryContextKey(1, context);
    h.guestDrafts.set(key, draft(6000)); h.state.usingGuestDraft = true; h.store.quota = true;
    assert.throws(() => h.recovery.adoptGuest(), error => error.code === 'pie_guest_binding_unavailable');
    assert.equal(h.state.recoveredPersonalDraft, false); assert.deepEqual(h.guestDrafts.get(key), draft(6000));
    h.store.quota = false; h.recovery.adoptGuest(); assert.equal(h.guestDrafts.get(key), null);
});

test('retained identity and body are captured before transport; callback failures cannot send a mutation', async () => {
    const key = randomUUID(), calls = [], body = { value: 1 };
    const writer = createRetryableWrite(async (_route, sent, options) => {
        calls.push(['transport', sent, options.headers['Idempotency-Key']]); return { saved: true };
    }, { storage: null, digest: async () => 'fixture' });
    await assert.rejects(writer('/write', body, { requestKey: 'invalid' }), /Invalid retained write identity/);
    await assert.rejects(writer('/write', body, { requestKey: key, onIdentity() { throw Error('refuse'); } }), /refuse/);
    assert.equal(calls.length, 0);
    await writer('/write', body, { requestKey: key, onIdentity(identity, captured) { calls.push(['capture', captured, identity]); } });
    assert.deepEqual(calls, [['capture', body, key], ['transport', body, key]]);
});
