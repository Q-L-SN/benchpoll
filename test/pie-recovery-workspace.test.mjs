import assert from 'node:assert/strict';
import test from 'node:test';
import { createPieRecoveryHarness, createRecoveryMemoryStorage } from '../scripts/pie-recovery-harness.mjs';
import { createFixtureState, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const draft = weight => ({ entries: [{ conditionID: 1, weightBasisPoints: weight },
    { conditionID: 2, weightBasisPoints: 10000 - weight }], fallbackRules: [] });
const plain = value => JSON.parse(JSON.stringify(value));
const weights = h => h.state.personalEntries.map(row => row.weightBasisPoints);
const context = { scene: '101' }, key = '1:[["scene","101"]]';

for (let repetition = 1; repetition <= 2; repetition++) {
    test(`actual failed save is invisible after reload as a different account or anonymously (${repetition})`, async t => {
        const a = await createPieRecoveryHarness(); t.after(() => a.close()); await a.load();
        a.edit(draft(6000)); const saving = a.save(); await a.drain(); await a.fail(0); assert.equal(await saving, false);
        assert.equal(a.guestDrafts.get(key), null);
        for (const ownerID of ['8', null]) {
            const next = await createPieRecoveryHarness({ ownerID, storage: a.storage }); t.after(() => next.close()); await next.load();
            assert.equal(next.reads.some(body => body.previewPersonalPie), false);
            assert.equal(next.state.usingGuestDraft, false); assert.equal(next.state.recoveredPersonalDraft, false);
            assert.equal(next.writes.length, 0); assert.equal(next.errors.length, 0);
        }
        assert.deepEqual(a.recovery.lookup('7', 1, context).value.draft, draft(6000));
    });
    test(`actual schedule checkpoints authenticated edits before debounce or transport (${repetition})`, async t => {
        const a = await createPieRecoveryHarness(); t.after(() => a.close()); await a.load(); a.edit(draft(6000));
        assert.equal(a.writes.length, 0);
        const next = await createPieRecoveryHarness({ storage: a.storage }); t.after(() => next.close()); await next.load();
        assert.deepEqual(plain(weights(next)), [6000, 4000]); assert.equal(next.state.recoveredPersonalDraft, true);
        assert.equal(next.state.usingGuestDraft, true); assert.equal(next.state.personalSavePending, false);
        assert.equal(next.writes.length, 0); assert.equal(next.errors.length, 0);
    });
    test(`actual unresolved save survives reload and only explicit confirmation sends its original body/UUID (${repetition})`, async t => {
        const a = await createPieRecoveryHarness(); t.after(() => a.close()); await a.load(); a.edit(draft(6000));
        const saving = a.save(); await a.drain(); a.commit(0);
        a.edit(draft(7000));
        const next = await createPieRecoveryHarness({ storage: a.storage, fixture: a.fixture, receipts: a.receipts });
        t.after(() => next.close()); await next.load();
        assert.deepEqual(plain(weights(next)), [7000, 3000]); assert.equal(next.writes.length, 0);
        assert.equal(next.state.personalSaveRequest.key, a.writes[0].key);
        const confirmed = next.confirm(); await next.drain();
        assert.equal(next.writes.length, 1); assert.equal(next.writes[0].key, a.writes[0].key);
        assert.deepEqual(next.writes[0].body, a.writes[0].body);
        await next.acknowledge(0);
        assert.equal(next.writes.length, 2); assert.notEqual(next.writes[1].key, next.writes[0].key);
        assert.equal(next.writes[1].body.expectedRevision, 2);
        assert.deepEqual(next.writes[1].body.entries, draft(7000).entries);
        await next.acknowledge(1); await confirmed;
        assert.equal(next.fixture.revision, 3); assert.equal(next.recovery.lookup('7', 1, context), null);
        await a.fail(0); assert.equal(await saving, false);
        assert.equal(a.state.personalRecoveryBlocked, true); assert.equal(a.recovery.lookup('7', 1, context), null);
    });
    test(`actual old delete replay cannot delete a later recreated Pie after reload (${repetition})`, async t => {
        const a = await createPieRecoveryHarness(); t.after(() => a.close()); await a.load();
        a.edit({ entries: [], fallbackRules: [] }); const saving = a.save(); await a.drain(); a.commit(0);
        a.fixture.personalEntries = weightedEntries([{ conditionID: 2, weightBasisPoints: 10000 }]); a.fixture.revision = 1;
        const next = await createPieRecoveryHarness({ storage: a.storage, fixture: a.fixture, receipts: a.receipts });
        t.after(() => next.close()); await next.load(); assert.equal(next.state.personalEntries.length, 0);
        const confirmed = next.confirm(); await next.drain(); await next.acknowledge(0); await confirmed;
        assert.equal(next.writes.length, 1); assert.equal(next.fixture.revision, 1);
        assert.equal(next.fixture.personalEntries[0].conditionID, 2);
        assert.equal(next.state.personalEntries[0].conditionID, 2);
        await a.fail(0); await saving;
    });
    test(`actual healthy guest draft remains an explicit preview after login (${repetition})`, async t => {
        const store = createRecoveryMemoryStorage();
        const guest = await createPieRecoveryHarness({ storage: store, ownerID: null }); t.after(() => guest.close());
        await guest.load(); guest.edit(draft(6000)); await guest.save();
        const signed = await createPieRecoveryHarness({ storage: store }); t.after(() => signed.close()); await signed.load();
        assert.deepEqual(plain(weights(signed)), [6000, 4000]); assert.equal(signed.writes.length, 0);
        const confirmed = signed.confirm(); await signed.drain();
        assert.equal(signed.guestDrafts.get(key), null);
        await signed.fail(0); await confirmed;
        const anonymous = await createPieRecoveryHarness({ storage: store, ownerID: null }); t.after(() => anonymous.close()); await anonymous.load();
        assert.equal(anonymous.reads.some(body => body.previewPersonalPie), false);
    });
    test(`actual legacy ownerless drafts require explicit ownership confirmation (${repetition})`, async t => {
        const store = createRecoveryMemoryStorage();
        store.setItem('benchpoll-guest-weights-v2-ordered', JSON.stringify([[key, draft(6000)]]));
        const h = await createPieRecoveryHarness({ storage: store }); t.after(() => h.close()); await h.load();
        assert.equal(h.reads.some(body => body.previewPersonalPie), false); assert.equal(h.state.legacyDraftAvailable, true);
        await h.confirm();
        assert.deepEqual(plain(weights(h)), [6000, 4000]); assert.equal(h.writes.length, 0);
        assert.equal(h.state.recoveredPersonalDraft, true); assert.equal(h.guestDrafts.getLegacy(key), null);
        assert.deepEqual(h.recovery.lookup('7', 1, context).value.draft, draft(6000));
    });
    test(`actual explicit discard removes only this owner's selected context (${repetition})`, async t => {
        const a = await createPieRecoveryHarness(); t.after(() => a.close()); await a.load(); a.edit(draft(6000));
        const b = await createPieRecoveryHarness({ ownerID: '8', storage: a.storage }); t.after(() => b.close()); await b.load(); b.edit(draft(7000));
        const next = await createPieRecoveryHarness({ storage: a.storage }); t.after(() => next.close()); await next.load(); await next.discard();
        assert.equal(next.recovery.lookup('7', 1, context), null);
        assert.deepEqual(b.recovery.lookup('8', 1, context).value.draft, draft(7000)); assert.equal(next.writes.length, 0);
    });
    test(`actual unavailable-version preview cannot erase owner recovery or submit its hidden contents (${repetition})`, async t => {
        const a = await createPieRecoveryHarness(); t.after(() => a.close()); await a.load(); a.edit(draft(6000));
        const saving = a.save(); await a.drain(); await a.fail(0); await saving;
        const next = await createPieRecoveryHarness({ storage: a.storage }); t.after(() => next.close());
        next.setReadHook(body => {
            if (body.previewPersonalPie) throw Object.assign(Error('unavailable'), { status: 400, payload: { error: 'pie_benchmark_condition_not_found' } });
        });
        await next.load(); assert.equal(next.state.personalDraftUnavailable, true); assert.equal(next.state.personalRecoveryBlocked, true);
        assert.deepEqual(next.recovery.lookup('7', 1, context).value.draft, draft(6000));
        assert.equal(await next.save({ forceSave: true }), false); assert.equal(next.writes.length, 0);
        next.setReadHook(null); await next.load(); assert.equal(next.state.personalRecoveryBlocked, false);
        assert.deepEqual(plain(weights(next)), [6000, 4000]); assert.equal(next.writes.length, 0);
    });
    test(`actual failed stored-identity write restores only an explicit review against the fresh saved revision (${repetition})`, async t => {
        const store = createRecoveryMemoryStorage(); let quota = false;
        const setItem = store.setItem;
        store.setItem = (key, value) => { if (quota) throw Error('quota'); return setItem(key, value); };
        const a = await createPieRecoveryHarness({ storage: store }); t.after(() => a.close()); await a.load();
        a.edit(draft(6000)); quota = true;
        const saving = a.save(); await a.drain(); a.commit(0); await a.fail(0); await saving;
        assert.equal(a.state.guestDraftStorageAvailable, false); quota = false;
        const next = await createPieRecoveryHarness({ storage: store, fixture: a.fixture, receipts: a.receipts }); t.after(() => next.close());
        await next.load(); assert.equal(next.state.personalSaveRequest, null); assert.equal(next.writes.length, 0);
        assert.equal(next.state.recoveredPersonalDraft, true); assert.equal(next.state.personalRevision, 2);
        const confirmed = next.confirm(); await next.drain();
        assert.notEqual(next.writes[0].key, a.writes[0].key); assert.equal(next.writes[0].body.expectedRevision, 2);
        await next.acknowledge(0); await confirmed;
    });
    test(`discarding an old delete makes an identical later deletion a distinct intent (${repetition})`, async t => {
        const a = await createPieRecoveryHarness(); t.after(() => a.close()); await a.load();
        a.edit({ entries: [], fallbackRules: [] }); const oldSave = a.save(); await a.drain(); a.commit(0); await a.fail(0); await oldSave;
        a.fixture.personalEntries = weightedEntries([{ conditionID: 2, weightBasisPoints: 10000 }]); a.fixture.revision = 1;
        const next = await createPieRecoveryHarness({ storage: a.storage, fixture: a.fixture, receipts: a.receipts }); t.after(() => next.close());
        await next.load(); await next.discard();
        assert.equal(next.state.personalEntries[0].conditionID, 2);
        next.edit({ entries: [], fallbackRules: [] }); const newSave = next.save(); await next.drain();
        assert.deepEqual(next.writes[0].body, a.writes[0].body); assert.notEqual(next.writes[0].key, a.writes[0].key);
        await next.acknowledge(0); await newSave;
        assert.equal(next.fixture.personalEntries.length, 0); assert.equal(next.fixture.revision, 0);
    });
}

test('an account switch between verified read phases cannot restore or write either account recovery', async t => {
    const h = await createPieRecoveryHarness(); t.after(() => h.close()); await h.load(); h.edit(draft(6000));
    const next = await createPieRecoveryHarness({ storage: h.storage, fixture: h.fixture }); t.after(() => next.close());
    const original = next.fixture.userID;
    Object.defineProperty(next.fixture, 'userID', { get() { return next.reads.length < 2 ? original : '8'; }, configurable: true });
    await next.load(); assert.equal(next.errors.length, 1); assert.equal(next.errors[0].payload.error, 'account_changed');
    assert.equal(next.applied.length, 0); assert.equal(next.writes.length, 0);
    assert.deepEqual(h.recovery.lookup('7', 1, context).value.draft, draft(6000));
});

test('weight recovery replays its request while preserving the newest global ballot', async t => {
    const oppose = { targetConditionID: 1, sourceConditionID: 901, vote: 'oppose' };
    const fixture = createFixtureState({ userID: '7', communityVersions: true, secondaryBenchmark: true,
        personalEstimationVotes: [{ ...oppose, vote: 'support' }] });
    const first = await createPieRecoveryHarness({ fixture }); t.after(() => first.close()); await first.load();
    first.edit(draft(6000));
    const saving = first.save(); await first.drain(); first.commit(0);
    const alternate = { ...draft(6000), entries: [{ conditionID: 901, weightBasisPoints: 6000 }, ...draft(6000).entries.slice(1)] };
    first.edit(alternate);
    fixture.personalEstimationVotes = [oppose];
    const next = await createPieRecoveryHarness({ fixture, storage: first.storage, receipts: first.receipts });
    t.after(() => next.close()); await next.load();
    assert.deepEqual(plain(next.state.personalEstimationVotes), [oppose]);
    assert.deepEqual(plain(next.state.communityEstimationVotes), [
        { targetConditionID: 1, sourceConditionID: 901, supportCount: 0, opposeCount: 1 }]);
    assert.deepEqual(next.recovery.lookup('7', 1, context).value.draft, alternate);
    assert.deepEqual(next.reads.at(-1).previewPersonalPie, alternate);
    assert.equal(next.writes.length, 0);
    const confirm = next.confirm(); await next.drain();
    assert.equal(next.writes[0].key, first.writes[0].key);
    assert.deepEqual(next.writes[0].body, first.writes[0].body);
    assert.equal(Object.hasOwn(next.writes[0].body, 'estimationVotes'), false);
    await next.acknowledge(0);
    assert.notEqual(next.writes[1].key, first.writes[0].key);
    assert.equal(next.writes[1].body.expectedRevision, 2);
    assert.deepEqual(next.writes[1].body.entries, alternate.entries);
    assert.equal(Object.hasOwn(next.writes[1].body, 'estimationVotes'), false);
    await next.acknowledge(1); await confirm;
    assert.deepEqual(plain(next.state.personalEstimationVotes), [oppose]);
    assert.equal(next.recovery.lookup('7', 1, context), null);
    await first.fail(0); assert.equal(await saving, false);
});

test('an authenticated vote writes independently of weight undo, scene changes and draft discard', async t => {
    const vote = { targetConditionID: 1, sourceConditionID: 901, vote: 'oppose' };
    const fixture = createFixtureState({ userID: '7', communityVersions: true, secondaryBenchmark: true, personalEstimationVotes: [] });
    const h = await createPieRecoveryHarness({ fixture }); t.after(() => h.close()); await h.load();
    const snapshot = h.snapshot(), revision = h.state.personalRevision;
    assert.equal(h.vote(101, 1, 901, 'oppose'), true); await h.drain();
    assert.equal(h.writes[0].route, '/api/save_estimation_vote');
    assert.deepEqual(h.writes[0].body, { expectedUserID: '7', ...vote, nominate: false });
    await h.acknowledge(0);
    assert.equal(h.state.personalRevision, revision);
    assert.equal(h.recovery.lookup('7', 1, context), null);
    h.edit(draft(6000)); h.restore(snapshot);
    assert.deepEqual(plain(h.state.personalEstimationVotes), [vote]);
    const next = await createPieRecoveryHarness({ fixture, storage: h.storage }); t.after(() => next.close());
    next.state.selectedContextValues = { scene: '102' }; await next.load();
    assert.deepEqual(plain(next.state.personalEstimationVotes), [vote]);
    assert.equal(next.state.recoveredPersonalDraft, false);
    next.state.selectedContextValues = context; await next.load();
    assert.equal(next.state.recoveredPersonalDraft, true);
    await next.discard();
    assert.deepEqual(plain(next.state.personalEstimationVotes), [vote]);
    assert.equal(next.recovery.lookup('7', 1, context), null);
    assert.equal(next.writes.length, 0);
    assert.equal(h.writes.length, 1);
});

test('guest votes survive scene changes and replay only after explicit account confirmation', async t => {
    const storage = createRecoveryMemoryStorage();
    const fixture = createFixtureState({ authenticated: false, communityVersions: true, secondaryBenchmark: true,
        sparseBenchmark: true, personalEstimationVotes: [] });
    const guest = await createPieRecoveryHarness({ storage, fixture, ownerID: null }); t.after(() => guest.close()); await guest.load();
    const estimationVotes = [{ targetConditionID: 1, sourceConditionID: 900, vote: 'support' },
        { targetConditionID: 1, sourceConditionID: 901, vote: 'oppose' }];
    guest.edit(draft(6000)); assert.equal(await guest.save(), true);
    const draftVersion = guest.state.personalEditVersion;
    assert.equal(guest.vote(101, 1, 901, 'oppose'), true);
    assert.equal(guest.vote(101, 1, 900, 'support'), true);
    assert.equal(guest.state.personalEditVersion, draftVersion);
    assert.deepEqual(guest.guestDrafts.get(key), draft(6000));
    assert.deepEqual(plain(guest.guestBallots.guestEstimationVotes()), estimationVotes);
    assert.deepEqual(plain(guest.state.communityEstimationVotes), []);
    assert.equal(guest.writes.length, 0);

    guest.state.selectedContextValues = { scene: '102' }; await guest.load();
    assert.equal(guest.state.usingGuestDraft, false);
    assert.deepEqual(plain(guest.state.personalEstimationVotes), estimationVotes);
    guest.state.selectedContextValues = context; await guest.load();
    assert.equal(guest.state.usingGuestDraft, true);
    assert.deepEqual(plain(weights(guest)), [6000, 4000]);

    const prior = { targetConditionID: 900, sourceConditionID: 901, vote: 'support' };
    const accountFixture = { ...fixture, authenticated: true, userID: '7', personalEstimationVotes: [prior] };
    const signed = await createPieRecoveryHarness({ storage, fixture: accountFixture });
    t.after(() => signed.close()); await signed.load();
    assert.deepEqual(plain(signed.state.personalEstimationVotes), [...estimationVotes, prior]);
    assert.deepEqual(accountFixture.personalEstimationVotes, [prior]);
    assert.equal(signed.writes.length, 0);
    const confirm = signed.confirm(); await signed.drain();
    assert.equal(signed.guestDrafts.get(key), null);
    assert.equal(signed.writes[0].route, '/api/save_personal_pie');
    assert.deepEqual(signed.writes[0].body.estimationVotes, estimationVotes);
    assert.deepEqual(signed.writes[0].body.entries, draft(6000).entries);
    signed.commit(0);
    await signed.fail(0); await confirm;
    assert.deepEqual(plain(signed.guestBallots.guestEstimationVotes()), estimationVotes);
    signed.guestBallots.setGuestEstimationVote(901, 1, 'support');

    const next = await createPieRecoveryHarness({ storage, fixture: accountFixture, receipts: signed.receipts });
    t.after(() => next.close()); await next.load();
    assert.deepEqual(next.recovery.lookup('7', 1, context).value.draft, draft(6000));
    assert.equal(next.writes.length, 0);
    const retry = next.confirm(); await next.drain();
    assert.equal(next.writes[0].key, signed.writes[0].key);
    assert.deepEqual(next.writes[0].body, signed.writes[0].body);
    await next.acknowledge(0); await retry;
    assert.deepEqual(plain(next.state.personalEstimationVotes), [...estimationVotes, prior]);
    assert.deepEqual(plain(next.guestBallots.guestEstimationVotes()), [{ ...estimationVotes[1], vote: 'support' }]);
    assert.equal(next.recovery.lookup('7', 1, context), null);
    assert.equal(next.writes.length, 1);
});

test('recovery keeps weights from a retired source-only pending save and starts a fresh confirmed write', async t => {
    const fixture = createFixtureState({ userID: '7', secondaryBenchmark: true, personalEstimationVotes: [] });
    const first = await createPieRecoveryHarness({ fixture }); t.after(() => first.close()); await first.load();
    first.edit(draft(6000));
    const lost = first.save(); await first.drain(); await first.fail(0); await lost;
    const slot = `benchpoll:owned-pie:v1:${encodeURIComponent(`7:${key}`)}`;
    const record = JSON.parse(first.storage.getItem(slot));
    const sourceOnlyVotes = [{ conditionID: 901, vote: 'oppose' }];
    record.value.draft.estimationVotes = sourceOnlyVotes;
    record.value.pending.body.estimationVotes = sourceOnlyVotes;
    first.storage.setItem(slot, JSON.stringify(record));
    fixture.revision = 2;

    const next = await createPieRecoveryHarness({ fixture, storage: first.storage }); t.after(() => next.close()); await next.load();
    assert.deepEqual(plain(weights(next)), [6000, 4000]);
    assert.deepEqual(plain(next.state.personalEstimationVotes), []);
    assert.equal(next.state.personalSaveRequest, null);
    assert.equal(next.writes.length, 0);
    assert.equal(JSON.parse(first.storage.getItem(slot)).value.pending.key, record.value.pending.key);
    const confirmed = next.confirm(); await next.drain();
    assert.notEqual(next.writes[0].key, record.value.pending.key);
    assert.equal(Object.hasOwn(next.writes[0].body, 'estimationVotes'), false);
    assert.equal(next.writes[0].body.expectedRevision, 2);
    await next.acknowledge(0); await confirmed;
    assert.equal(fixture.revision, 3);
});

test('an unavailable scoring version keeps its draft and leaves global votes intact', async t => {
    const storage = createRecoveryMemoryStorage();
    const ballot = { targetConditionID: 1, sourceConditionID: 901, vote: 'support' };
    const fixture = createFixtureState({ userID: '7', communityVersions: true, secondaryBenchmark: true, personalEstimationVotes: [ballot] });
    const first = await createPieRecoveryHarness({ fixture, storage }); t.after(() => first.close()); await first.load();
    const edit = { entries: [{ conditionID: 901, weightBasisPoints: 6000 }, draft(6000).entries[1]], fallbackRules: [] };
    first.edit(edit);
    const next = await createPieRecoveryHarness({ fixture, storage }); t.after(() => next.close());
    next.setReadHook(body => {
        if (body.previewPersonalPie) throw Object.assign(Error('unavailable'), { status: 400,
            payload: { error: 'pie_benchmark_condition_not_found' } });
    });
    await next.load();
    assert.equal(next.state.personalDraftUnavailable, true);
    assert.equal(next.state.personalRecoveryBlocked, true);
    assert.deepEqual(plain(next.state.personalEstimationVotes), [ballot]);
    assert.deepEqual(plain(next.recovery.lookup('7', 1, context).value.draft), edit);
    assert.equal(await next.save({ forceSave: true }), false);
    assert.equal(next.writes.length, 0);
});

test('correcting a legacy scoring mix leaves the global ballot intact', async t => {
    const entries = [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 901, weightBasisPoints: 4000 }];
    const ballot = { targetConditionID: 1, sourceConditionID: 901, vote: 'oppose' };
    const fixture = createFixtureState({ userID: '7', communityVersions: true, secondaryBenchmark: true,
        personalEntries: weightedEntries(entries), personalEstimationVotes: [ballot] });
    const h = await createPieRecoveryHarness({ fixture }); t.after(() => h.close()); await h.load();
    const edit = { entries, fallbackRules: [] };
    h.edit(edit);
    const invalid = h.save(); await h.drain(); await h.fail(0, 400, 'pie_benchmark_version_conflict');
    assert.equal(await invalid, false);
    assert.match(h.state.personalSaveError, /Choose one scoring version/);
    assert.deepEqual(plain(h.recovery.lookup('7', 1, context).value.draft), edit);

    h.edit({ ...edit, entries: [{ conditionID: 1, weightBasisPoints: 10000 }] });
    const corrected = h.save(); await h.drain(); await h.acknowledge(1);
    assert.equal(await corrected, true);
    assert.deepEqual(plain(h.state.personalEstimationVotes), [ballot]);
    assert.equal(h.recovery.lookup('7', 1, context), null);
});
