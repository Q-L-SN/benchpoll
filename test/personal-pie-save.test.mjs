import { estimationRequest, normalizeEstimationAlgorithm } from '../public/js/shared/estimation-algorithms.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import express from 'express';
import { savePersonalPie } from '../ranking-service.js';
import { saveEstimationVote } from '../estimation-ballots.js';
import { readWriteIdentity } from '../write-idempotency.js';
import { createPieSaveDatabase as createTransactionalPieSaveDatabase } from '../scripts/personal-pie-save-fixture.mjs';
import { pieConditionRows } from '../scripts/personal-pie-save-fixture.mjs';
import { createRetryableWrite } from '../public/js/shared/write-intent.js';
import { postJSON } from '../public/js/shared/http.js';
import { validatePersonalPieSave } from '../public/js/workspace/pie-save.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { createGuestDraftStore } from '../public/js/workspace/guest-drafts.js';
import { createPersonalPieRecovery } from '../public/js/workspace/pie-recovery.js';
import { accountWriteError, isAccountWriteError, requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { cloneEntries, cloneFallbackRules } from '../public/js/workspace/weights.js';
import { topicReferenceError } from '../public/js/workspace/topic-references.js';
import { familyKey, portableFamilyEntry, FALLBACK_CONFIGURATION_VERSION } from '../public/js/shared/benchmark-families.js';
import { createFixtureState, workspace, weightedEntries } from '../scripts/frontend/fixtures.mjs';
import { recoveryScene, withRecoveryScenes } from './helpers/workspace-scene-fixture.mjs';

const request = (extra = {}) => ({ userID: '7', writeIdentity: randomUUID(), categoryID: 1,
    contextValues: {}, expectedRevision: 1, entries: [], fallbackRules: [], ...extra });
const plain = value => JSON.parse(JSON.stringify(value));
const error = code => value => value.body?.error === code;
const siblingConditionRows = pieConditionRows.map(row => row.condition_ID === 2 ? {
    ...row, benchmark_ID: 1, name: pieConditionRows[0].name, condition_key: 'extended', condition_name: 'Extended',
    is_default: 0, is_primary: 0
} : row);
const thirdVersion = { ...siblingConditionRows[1], condition_ID: 4, condition_key: 'third', condition_name: 'Third' };
const estimationVote = (targetConditionID, sourceConditionID, vote) => ({ targetConditionID, sourceConditionID, vote });

function createPieSaveDatabase(options) {
    const db = createTransactionalPieSaveDatabase(options);
    const getConnection = db.getConnection.bind(db);
    db.getConnection = async () => {
        const connection = await getConnection();
        const execute = connection.execute.bind(connection);
        const begin = connection.beginTransaction.bind(connection);
        let active = false;
        connection.beginTransaction = async () => { await begin(); active = true; };
        for (const method of ['commit', 'rollback', 'destroy']) {
            const original = connection[method].bind(connection);
            connection[method] = (...args) => { active = false; return original(...args); };
        }
        // This test's public topic has no template. Keep the shared fixture's durable journal unchanged.
        connection.execute = (sql, parameters = []) => {
            if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) {
                assert.equal(active, true);
                assert.equal(sql.replace(/\s+/g, ' ').trim(), 'SELECT c.ID, c.name, c.slug, c.public_ID, c.private_ID, c.is_official, c.description, c.position, c.owner_user_ID, '
                    + "c.created_by_user_ID, p.public_id AS creator_public_id, COALESCE(NULLIF(p.display_name, ''), creator.name) AS creator_name, "
                    + 'COALESCE(p.avatar_data_url, creator.profile_picture_URL) AS creator_avatar '
                    + 'FROM categories c LEFT JOIN users creator ON creator.ID = c.created_by_user_ID AND creator.deleted_at IS NULL '
                    + 'LEFT JOIN user_public_profiles p ON p.user_ID = creator.ID WHERE c.ID = ? AND c.is_active = 1');
                assert.deepEqual(parameters, [1]);
                return Promise.resolve([[{ ID: 1, public_ID: 1, name: 'Fixture topic', slug: 'fixture-topic', description: 'Compare fixture benchmarks.',
                    position: 0, owner_user_ID: null, created_by_user_ID: null, creator_name: null, creator_avatar: null }], []]);
            }
            if (/COUNT\(\*\) AS count FROM categories/.test(sql)) assert.fail('Flat topic saves must not inspect child categories');
            if (sql.includes('FROM ranking_dimensions')) {
                assert.equal(active, true, 'Template reads stay inside the save transaction');
                assert.match(sql, /WHERE is_active = 1\s+AND scope_category_ID IN \(\?\)/);
                assert.deepEqual(parameters, [1]);
                return Promise.resolve([[], []]);
            }
            return execute(sql, parameters);
        };
        return connection;
    };
    return db;
}

test('benchmark-only saves take the graph lock before accounts and use the stable internal root context', async () => {
    const db = createPieSaveDatabase();
    const receipt = await savePersonalPie(db, request({ entries: [{ conditionID: 1, weightBasisPoints: 10000 }] }));
    assert.match(db.statements[0].sql, /^SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE$/);
    assert.match(db.statements[1].sql, /SELECT ID FROM users/);
    assert.deepEqual(receipt.contextValues, {});
    assert.equal(db.stored.pie.context_ID, 10);
    assert.deepEqual(db.stored.topicWeights, []);
});

test('an unavailable graph lock schema fails without claiming a write or changing existing weights', async () => {
    const db = createPieSaveDatabase({ graphSchema: false }), before = db.stored;
    await assert.rejects(savePersonalPie(db, request()), error('topic_reference_schema_unavailable'));
    assert.deepEqual(db.stored, before);
    assert.equal(db.mutations, 0); assert.equal(db.commits, 0);
    assert.deepEqual(db.events, ['begin', 'rollback', 'release']);
});

test('scoring changes, community following and deleting the Pie preserve global estimation votes', async () => {
    const db = createPieSaveDatabase({ conditionRows: [...siblingConditionRows, thirdVersion], requireGraphLock: false });
    const vote = estimationVote(1, 2, 'oppose');
    const identity = randomUUID();
    const ballot = await saveEstimationVote(db, '7', identity, estimationVote(2, 1, 'oppose'));
    assert.deepEqual(ballot, { saved: true, userID: '7', requestKey: identity, ...vote, nominate: false });
    assert.deepEqual(await saveEstimationVote(db, '7', identity, vote), ballot);
    assert.equal(db.stored.pie.revision, 1);

    for (const [expectedRevision, entries] of [
        [1, [{ conditionID: 4, weightBasisPoints: 10000 }]],
        [2, [{ conditionID: 2, weightBasisPoints: 10000, followCommunityVersion: true }]],
        [3, [{ conditionID: 1, weightBasisPoints: 10000 }]],
        [4, [{ conditionID: 3, weightBasisPoints: 10000 }]],
        [5, []]
    ]) {
        const receipt = await savePersonalPie(db, request({ expectedRevision, entries }));
        assert.deepEqual(receipt.personalPie.estimationVotes, []);
        assert.deepEqual(db.stored.weights, entries);
        assert.deepEqual([...db.stored.ballots], [['7:1:2', vote]]);
    }
    assert.equal(db.stored.pie, null);

    const updated = estimationVote(1, 2, 'support');
    await assert.rejects(saveEstimationVote(db, '7', identity, updated), error('write_identity_reused'));
    await saveEstimationVote(db, '7', randomUUID(), updated);
    assert.deepEqual([...db.stored.ballots], [['7:1:2', updated]]);
    await saveEstimationVote(db, '7', randomUUID(), estimationVote(2, 1, null));
    assert.equal(db.stored.ballots.size, 0);
});

for (const failures of [1, Infinity]) test(`deadlock retry is bounded and reuses the same request identity (${failures})`, async () => {
    const db = createPieSaveDatabase({ revision: 0 });
    let attempts = 0;
    const wrapped = { async getConnection() {
        const connection = await db.getConnection(); const execute = connection.execute;
        connection.execute = (sql, parameters) => {
            if (sql.includes('INSERT INTO personal_pies') && ++attempts <= failures) throw Object.assign(Error('InnoDB rolled back this deadlock victim'), { code: 'ER_LOCK_DEADLOCK' });
            return execute(sql, parameters);
        };
        return connection;
    } };
    const body = request({ expectedRevision: 0, entries: [{ conditionID: 1, weightBasisPoints: 10000 }] });
    if (failures === Infinity) {
        await assert.rejects(savePersonalPie(wrapped, body), error => error.code === 'ER_LOCK_DEADLOCK');
        assert.equal(attempts, 3); assert.equal(db.borrows, 3); assert.equal(db.stored.receipts.size, 0); assert.equal(db.mutations, 0);
    } else {
        const receipt = await savePersonalPie(wrapped, body);
        assert.equal(receipt.requestKey, body.writeIdentity); assert.equal(receipt.personalPie.revision, 1);
        assert.equal(attempts, 2); assert.equal(db.borrows, 2); assert.equal(db.stored.receipts.size, 1); assert.equal(db.mutations, 1);
    }
});

for (const kind of ['scoring version', 'estimation source', 'estimation target']) test(`server refuses an AA ${kind} even when directly submitted`, async () => {
    const conditionRows = siblingConditionRows.map(row => row.condition_ID === 2
        ? { ...row, condition_key: 'aa-run', condition_name: 'AA run' } : row);
    const db = createPieSaveDatabase({ conditionRows });
    const body = kind === 'scoring version' ? request({ entries: [{ conditionID: 2, weightBasisPoints: 10000 }] })
        : request({ entries: [{ conditionID: 1, weightBasisPoints: 10000 }],
            estimationVotes: [kind === 'estimation source' ? estimationVote(1, 2, 'support') : estimationVote(2, 1, 'support')] });
    await assert.rejects(savePersonalPie(db, body), error(kind === 'scoring version'
        ? 'pie_benchmark_condition_excluded' : 'estimation_vote_condition_unavailable'));
    assert.equal(db.mutations, 0);
    assert.equal(db.stored.receipts.size, 0);
});

test('guest import accepts available pairs beyond the weighted benchmark and rejects unavailable versions', async () => {
    const independentSibling = { ...siblingConditionRows[1], condition_ID: 5, benchmark_ID: 3, name: pieConditionRows[2].name };
    const db = createPieSaveDatabase({ conditionRows: [...siblingConditionRows, thirdVersion, independentSibling] });
    const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
    const votes = [estimationVote(1, 4, 'support'), estimationVote(3, 5, 'oppose')];
    for (const missing of [estimationVote(999, 2, 'support'), estimationVote(1, 999, 'oppose')]) {
        await assert.rejects(savePersonalPie(db, request({ entries, estimationVotes: [votes[0], missing] })),
            error('estimation_vote_condition_unavailable'));
    }
    assert.equal(db.mutations, 0);
    assert.equal(db.stored.receipts.size, 0);
    assert.equal(db.stored.ballots.size, 0);
    const receipt = await savePersonalPie(db, request({ entries, estimationVotes: votes }));
    assert.deepEqual(receipt.personalPie.estimationVotes, votes);
    assert.deepEqual([...db.stored.ballots.values()], votes);
});

test('a personal save rejects assigning weight to two scoring versions of one benchmark', async () => {
    const db = createPieSaveDatabase({ conditionRows: siblingConditionRows });
    await assert.rejects(savePersonalPie(db, request({ entries: [
        { conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }
    ] })), value => value.status === 400 && value.body?.error === 'pie_benchmark_version_conflict');
    assert.equal(db.mutations, 0);
});

test('the actual save route enforces owner and identity then sends a private JSON receipt over HTTP', async t => {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const start = source.indexOf("API.post('/save_personal_pie'");
    assert.ok(start >= 0);
    const db = createPieSaveDatabase({ conditionRows: siblingConditionRows }), app = express(), invalidated = [];
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userID: req.get('Fixture-User') ?? null }; next(); });
    const assertDurableSave = () => {
        assert.ok(db.stored.receipts.size > 0);
        assert.ok([...db.stored.receipts.values()].every(row => row.response_status === 200), 'Cache invalidation follows a durable save');
    };
    vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), {
        API: app, db, savePersonalPie, readWriteIdentity, requireAccountWriteOwner,
        topicHome: { invalidate(ID) { assertDurableSave(); invalidated.push(ID); } },
        searchPresentation: { invalidate: assertDurableSave },
        requireCurrentTermsForAPI(_req, _res, next) { next(); },
        requireAuthForAPI(req, res, next) { if (!req.session.userID) return res.status(401).json({ error: 'authentication_required' }); next(); }
    });
    app.use((error, _req, res, _next) => res.status(error.status ?? 500).json(error.body ?? { error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const body = { expectedUserID: '7', categoryID: 1, contextValues: {}, expectedRevision: 1,
        entries: [{ conditionID: 1, weightBasisPoints: 10000 }] };
    const key = randomUUID();
    const send = (extraHeaders = {}, extraBody = {}) => fetch(`http://127.0.0.1:${server.address().port}/save_personal_pie`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify({ ...body, ...extraBody })
    });
    for (const [headers, extra, status, code] of [
        [{}, {}, 401, 'authentication_required'], [{ 'Fixture-User': '8' }, {}, 409, 'account_changed'],
        [{ 'Fixture-User': '7' }, { expectedUserID: 7 }, 409, 'account_identity_required'],
        [{ 'Fixture-User': '7' }, {}, 400, 'write_identity_required']
    ]) {
        const rejected = await send(headers, extra); assert.equal(rejected.status, status); assert.equal((await rejected.json()).error, code);
    }
    assert.equal(db.borrows, 0); assert.equal(db.mutations, 0);
    assert.deepEqual(invalidated, []);
    const headers = { 'Fixture-User': '7', 'Idempotency-Key': key };
    const first = await send(headers);
    const receipt = await first.json();
    assert.equal(first.status, 200, JSON.stringify(receipt)); assert.equal(first.headers.get('cache-control'), 'private, no-store');
    validatePersonalPieSave(receipt, body, key);
    assert.deepEqual(receipt.personalPie.estimationVotes, []);
    assert.equal(db.borrows, 1); assert.equal(db.mutations, 1);
    assert.deepEqual(invalidated, [1]);
    const duplicate = await send(headers); assert.deepEqual(await duplicate.json(), receipt);
    assert.equal(db.borrows, 2); assert.equal(db.mutations, 1);
    assert.deepEqual(invalidated, [1, 1]);
    assert.equal(receipt.modelLeaderboards, undefined);

    const importKey = randomUUID();
    const guestVotes = [estimationVote(2, 1, 'support')];
    const importBody = { ...body, expectedRevision: 2, estimationVotes: guestVotes };
    const guestImport = await send({ ...headers, 'Idempotency-Key': importKey }, importBody);
    const imported = await guestImport.json();
    assert.equal(guestImport.status, 200, JSON.stringify(imported));
    validatePersonalPieSave(imported, importBody, importKey);
    assert.deepEqual([...db.stored.ballots.values()], [estimationVote(1, 2, 'support')]);
    assert.deepEqual(invalidated, [1, 1, undefined]);
});

for (let repetition = 1; repetition <= 2; repetition++) {
    test(`committed deletion returns its receipt without borrowing a ranking lease (${repetition})`, async () => {
        const db = createPieSaveDatabase(), body = request();
        const receipt = await savePersonalPie(db, body);
        assert.equal(receipt.saved, true); assert.equal(receipt.requestKey, body.writeIdentity);
        assert.equal(receipt.personalPie.revision, 0); assert.deepEqual(receipt.personalPie.entries, []);
        assert.equal(db.borrows, 1); assert.equal(db.mutations, 1); assert.equal(db.stored.pie, null);
        assert.equal(db.stored.receipts.size, 1);
        assert.deepEqual(await savePersonalPie(db, body), receipt);
        assert.equal(db.mutations, 1);
    });
    test(`lost commit acknowledgement replays the durable outcome, not the mutation (${repetition})`, async () => {
        const db = createPieSaveDatabase({ loseCommit: true }), body = request();
        await assert.rejects(savePersonalPie(db, body), /acknowledgement lost/);
        assert.equal(db.stored.pie, null); assert.equal(db.stored.receipts.size, 1);
        assert.equal((await savePersonalPie(db, body)).saved, true); assert.equal(db.mutations, 1);
        assert.ok(db.events.includes('destroy'));
    });
    test(`an old delete replay cannot delete a recreated pie at revision 1 (${repetition})`, async () => {
        const db = createPieSaveDatabase(), deletion = request();
        const old = await savePersonalPie(db, deletion);
        const created = await savePersonalPie(db, request({ expectedRevision: 0,
            entries: [{ conditionID: 2, weightBasisPoints: 10000 }] }));
        assert.equal(created.personalPie.revision, 1);
        assert.deepEqual(await savePersonalPie(db, deletion), old);
        assert.deepEqual(db.stored.weights, created.personalPie.entries);
        assert.equal(db.stored.pie.revision, 1); assert.equal(db.mutations, 2);
    });
    test(`receipt completion failure rolls back both business data and request claim (${repetition})`, async () => {
        const db = createPieSaveDatabase({ failCompletion: true });
        await assert.rejects(savePersonalPie(db, request()), /completion failed/);
        assert.equal(db.stored.pie.revision, 1); assert.equal(db.stored.receipts.size, 0);
        assert.equal(db.mutations, 0); assert.equal(db.commits, 0);
    });
    test(`concurrent identical deliveries save once; different content cannot reuse the key (${repetition})`, async () => {
        const db = createPieSaveDatabase(), body = request();
        const outcomes = await Promise.all(Array.from({ length: 8 }, () => savePersonalPie(db, body)));
        assert.ok(outcomes.every(value => JSON.stringify(value) === JSON.stringify(outcomes[0])));
        assert.equal(db.mutations, 1);
        await assert.rejects(savePersonalPie(db, { ...body, entries: [{ conditionID: 1, weightBasisPoints: 10000 }] }), error('write_identity_reused'));
        assert.equal(db.mutations, 1);
    });
    test(`guest imports commit and replay canonical pairs without replacing other global ballots (${repetition})`, async () => {
        const db = createPieSaveDatabase({ conditionRows: [...siblingConditionRows, thirdVersion], requireGraphLock: false });
        const prior = estimationVote(1, 4, 'support');
        await saveEstimationVote(db, '7', randomUUID(), prior);
        await saveEstimationVote(db, '7', randomUUID(), estimationVote(1, 2, 'oppose'));
        const duplicatePair = [estimationVote(1, 2, 'support'), estimationVote(2, 1, 'oppose')];
        const body = request({ entries: [{ conditionID: 1, weightBasisPoints: 10000 }],
            estimationVotes: [estimationVote(4, 2, 'oppose'), estimationVote(2, 1, 'support')] });
        await assert.rejects(savePersonalPie(db, { ...body, estimationVotes: duplicatePair }), error('invalid_estimation_votes'));
        const result = await savePersonalPie(db, body);
        const canonical = [estimationVote(1, 2, 'support'), estimationVote(2, 4, 'oppose')];
        assert.deepEqual(result.personalPie.estimationVotes, canonical);
        assert.deepEqual(db.stored.ballots, new Map([['7:1:4', prior], ['7:1:2', canonical[0]], ['7:2:4', canonical[1]]]));
        assert.deepEqual(await savePersonalPie(db, { ...body, estimationVotes: canonical }), result);
        assert.equal(db.mutations, 1);
    });
    test(`revision conflicts roll back their request claim without changing weights (${repetition})`, async () => {
        const db = createPieSaveDatabase();
        await assert.rejects(savePersonalPie(db, request({ expectedRevision: 0 })), error('pie_revision_conflict'));
        assert.equal(db.stored.receipts.size, 0); assert.equal(db.mutations, 0);
        assert.equal(db.stored.weights[0].conditionID, 1);
    });
}

test('save receipts reject missing, mismatched and malformed confirmations before forgetting the replay key', async () => {
    const calls = [], body = { expectedUserID: '7', categoryID: 1, contextValues: {}, expectedRevision: 1, entries: [], fallbackRules: [] };
    const receipt = key => ({ saved: true, requestKey: key, userID: '7', categoryID: 1,
        contextValues: {}, personalPie: { revision: 0, entries: [], fallbackRules: [] } });
    const write = createRetryableWrite(async (_path, _body, options) => {
        calls.push(options); return calls.length === 1 ? null : receipt(options.headers['Idempotency-Key']);
    }, { storage: null, digest: async value => createHash('sha256').update(value).digest('hex') });
    await assert.rejects(write('/api/save_personal_pie', body, { timeoutMs: 60000, validateResponse: validatePersonalPieSave }),
        failure => failure.code === 'invalid_personal_pie_receipt');
    await write('/api/save_personal_pie', body, { timeoutMs: 60000, validateResponse: validatePersonalPieSave });
    assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
    assert.equal(calls[0].timeoutMs, 60000); assert.equal(calls[0].requireJSON, true);
    for (const changed of [null, {}, { ...receipt('key'), userID: '8' }, { ...receipt('key'), requestKey: 'other' },
        { ...receipt('key'), personalPie: { revision: 1, entries: [], fallbackRules: [] } },
        { ...receipt('key'), contextValues: { budget: 'other' } }]) assert.throws(() => validatePersonalPieSave(changed, body, 'key'));
});

test('a vote-bearing save receipt must confirm every requested ballot independently of order', () => {
    const body = { expectedUserID: '7', categoryID: 1, contextValues: {}, expectedRevision: 1,
        entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [],
        estimationVotes: [{ targetConditionID: 901, sourceConditionID: 900, vote: 'oppose' },
            { targetConditionID: 1, sourceConditionID: 900, vote: 'support' }] };
    const receipt = estimationVotes => ({ saved: true, requestKey: 'key', userID: '7', categoryID: 1, contextValues: {},
        personalPie: { revision: 2, entries: body.entries, fallbackRules: [], estimationVotes } });
    const sorted = [estimationVote(1, 900, 'support'), estimationVote(900, 901, 'oppose')];
    assert.deepEqual(validatePersonalPieSave(receipt(sorted), body, 'key').personalPie.estimationVotes, sorted);
    assert.deepEqual(validatePersonalPieSave(receipt(body.estimationVotes), body, 'key').personalPie.estimationVotes, body.estimationVotes);
    for (const votes of [undefined, null, [], [...sorted, sorted[0]], [{ ...sorted[0], vote: 'oppose' }, sorted[1]],
        [estimationVote(1, 901, 'support'), sorted[1]]]) {
        assert.throws(() => validatePersonalPieSave(receipt(votes), body, 'key'), error => error.code === 'invalid_personal_pie_receipt');
    }
});

const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
function block(start, end) {
    const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
    assert.ok(left >= 0 && right > left, start); return source.slice(left, right);
}
const code = [block('function snapshotPersonalPie()', 'function resetPieVisualState()'),
    block('async function flushPendingPersonalPieSave()', 'function adjustSelectedWeight('),
    block('async function persistPersonalPie(', 'async function applyWorkspaceState('),
    '({ persist: persistPersonalPie, flush: flushPendingPersonalPieSave })'].join('\n');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const drain = async () => { for (let turn = 0; turn < 80; turn++) await Promise.resolve(); };
const response = (value, status = 200) => ({ status, ok: status < 400,
    headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => value });

test('a retained request from another context cannot be submitted under the current UI', async t => {
    const h = browserHarness(t);
    h.state.personalSaveRequest = { body: { expectedUserID: '7', categoryID: 2, contextValues: {}, expectedRevision: 0,
        entries: [], fallbackRules: [] }, snapshot: { entries: [], fallbackRules: [] }, editVersion: 0 };
    const task = h.start(); await drain();
    assert.equal(await task.promise, false);
    assert.equal(h.requests.length, 0);
    assert.match(h.state.personalSaveError, /another context/);
    assert.deepEqual(plain(h.state.personalEntries).map(row => row.weightBasisPoints), [6000, 4000]);
    assert.equal(h.historyClears, 0);
});

function browserHarness(t, { gesture = null } = {}) {
    const state = createWorkspaceState(), fixture = createFixtureState({ userID: '7' });
    const draft = [6000, 4000].map((weightBasisPoints, index) => ({ conditionID: index + 1, weightBasisPoints }));
    Object.assign(state, { authenticated: true, userID: '7', categoryID: 1, mode: 'personal',
        selectedContextValues: { scene: recoveryScene.standard }, personalEditVersion: 1, personalRevision: fixture.revision,
        personalEntries: cloneEntries(draft), serverPersonalEntries: cloneEntries(draft), personalSavePending: true,
        personalRankingDirty: true, comparisonRequest: { mode: 'best', keys: ['model'], filters: [] } });
    const values = new Map(), timers = new Map(), requests = [], applied = [], tasks = [], receipts = new Map();
    let now = 0, timerID = 0, historyClears = 0;
    const setTimeout = (callback, milliseconds) => { const ID = ++timerID; timers.set(ID, { callback, at: now + milliseconds }); return ID; };
    const clearTimeout = ID => timers.delete(ID);
    t.mock.method(globalThis, 'setTimeout', setTimeout); t.mock.method(globalThis, 'clearTimeout', clearTimeout);
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const guestDrafts = createGuestDraftStore(() => storage);
    const pieRecovery = createPersonalPieRecovery({ state, guestDrafts, getStorage: () => storage,
        snapshot: () => ({ entries: state.personalEntries.map(({ conditionID, weightBasisPoints }) => ({ conditionID, weightBasisPoints })),
            fallbackRules: state.personalFallbackRules.map(rule => ({ primaryConditionID: rule.primaryConditionID, mode: 'ordered', entries: rule.entries.map(portableFamilyEntry) })) }) });
    const writer = createRetryableWrite(postJSON, { storage,
        digest: async value => createHash('sha256').update(value).digest('hex') });
    const globals = { estimationRequest, normalizeEstimationAlgorithm, state, Number, Map, Set, guestDrafts, pieRecovery, structuredClone,
        window: { setTimeout, clearTimeout }, postJSON, postWriteJSON: writer, validatePersonalPieSave,
        validateWorkspacePayload, cloneEntries, cloneFallbackRules, portableFamilyEntry,
        accountWriteError, isAccountWriteError, topicReferenceError, FALLBACK_CONFIGURATION_VERSION, FALLBACK_RULE_MODE: 'ordered',
        pendingFallbackSave: false, fallbackSaveFailed: false,
        currentBenchmarkFilters: () => ({ benchmarkQuery: '', pinPersonal: false, groupVersions: false }),
        fallbackSignature: rules => rules.map(rule => familyKey(rule.primaryConditionID, rule.entries)).join('\n'),
        setStatus(message) { state.statusMessage = message; }, renderAll() {}, renderModels() {}, renderInlineFallback() {}, updateUndoState() {}, updateLastUpdated() {},
        requestLogin() {}, waitForGestureToSettle: () => gesture?.promise ?? Promise.resolve(),
        refreshChangedBenchmarkFilters() {},
        applyServerWorkspace(payload) {
            applied.push(payload); state.personalEntries = cloneEntries(payload.personalPie.entries);
            state.personalFallbackRules = cloneFallbackRules(payload.personalPie.fallbackRules);
            state.personalSavePending = false; state.personalSaveRequest = null; state.personalSaveError = '';
            state.personalSaveConflict = false; state.personalRankingRefreshNeeded = false;
            state.personalRankingDirty = false; state.personalRankingError = '';
        } };
    state.editHistory.clear = () => { historyClears += 1; };
    t.mock.method(globalThis, 'fetch', async (path, options) => {
        const item = { ...deferred(), path, body: JSON.parse(options.body), key: options.headers['Idempotency-Key'], signal: options.signal };
        assert.ok(['/api/save_personal_pie', '/api/get_weighted_workspace'].includes(path));
        if (path.endsWith('save_personal_pie')) {
            assert.equal(item.body.expectedUserID, '7');
            assert.equal(item.body.fallbackConfigurationVersion, 2);
        }
        requests.push(item); return item.promise;
    });
    const api = vm.runInNewContext(code, globals);
    const h = { state, fixture, requests, applied, guestDrafts, pieRecovery, draft, values,
        get historyClears() { return historyClears; },
        start() {
            const task = { settled: false, value: null }; task.promise = api.persist();
            task.promise.then(value => { task.settled = true; task.value = value; }, error => { task.settled = true; task.error = error; });
            tasks.push(task); return task;
        }, flush: api.flush,
        tick(ms) { now += ms; for (const [ID, timer] of [...timers]) if (timer.at <= now) { timers.delete(ID); timer.callback(); } },
        commit(index) {
            const item = requests[index];
            if (!receipts.has(item.key)) {
                fixture.personalEntries = weightedEntries(item.body.entries); fixture.fallbackRules = item.body.fallbackRules;
                fixture.revision = item.body.entries.length ? item.body.expectedRevision + 1 : 0;
                receipts.set(item.key, { saved: true, requestKey: item.key, userID: '7', categoryID: item.body.categoryID,
                    contextValues: item.body.contextValues, personalPie: { revision: fixture.revision,
                        entries: item.body.entries, fallbackRules: item.body.fallbackRules } });
            }
            return receipts.get(item.key);
        },
        async save(index) { requests[index].resolve(response(h.commit(index))); await drain(); },
        async read(index) { const body = requests[index].body;
            requests[index].resolve(response(withRecoveryScenes(workspace(fixture, body), body.contextValues))); await drain(); },
        async fail(index, status = 503, code = 'fixture_failure') { requests[index].resolve(response({ error: code }, status)); await drain(); },
        async stallBody(index) { const item = requests[index]; item.bodyRead = deferred();
            item.resolve({ ...response(h.commit(index)), json: () => item.bodyRead.promise }); await drain(); }
    };
    t.after(async () => {
        gesture?.resolve();
        for (let turn = 0; turn < 20 && tasks.some(task => !task.settled); turn++) {
            for (const item of requests) {
                const value = item.path.endsWith('save_personal_pie') ? h.commit(requests.indexOf(item))
                    : withRecoveryScenes(workspace(fixture, item.body), item.body.contextValues);
                item.resolve(response(value)); item.bodyRead?.resolve(value);
            }
            await drain();
        }
        assert.ok(tasks.every(task => task.settled && !task.error), 'No retained operation or unhandled rejection');
    });
    return h;
}

for (let repetition = 1; repetition <= 2; repetition++) {
    for (const phase of ['headers', 'body']) test(`a lost ${phase} response settles, keeps edits, then replays before newer edits (${repetition})`, async t => {
        const h = browserHarness(t), first = h.start(); await drain();
        assert.equal(h.requests.length, 1); h.commit(0);
        if (phase === 'body') await h.stallBody(0);
        h.state.personalEntries[0].weightBasisPoints = 7000; h.state.personalEntries[1].weightBasisPoints = 3000; h.state.personalEditVersion += 1;
        h.tick(60000); await drain();
        assert.equal(first.settled, true); assert.equal(first.value, false); assert.equal(h.requests[0].signal.aborted, true);
        assert.match(h.state.statusMessage, /confirm saving/); assert.equal(h.historyClears, 0);
        assert.deepEqual(plain(h.state.personalEntries).map(row => row.weightBasisPoints), [7000, 3000]);
        assert.equal(h.state.saving, false); assert.equal(h.state.persistPromise, null);
        const second = h.start(); await drain(); assert.equal(h.requests[1].key, h.requests[0].key);
        assert.deepEqual(h.requests[1].body, h.requests[0].body); await h.save(1);
        assert.equal(h.requests[2].body.expectedRevision, 2); assert.notEqual(h.requests[2].key, h.requests[1].key);
        assert.deepEqual(h.requests[2].body.entries.map(row => row.weightBasisPoints), [7000, 3000]);
        await h.save(2); assert.equal(h.requests[3].path, '/api/get_weighted_workspace'); await h.read(3);
        assert.equal(await second.promise, true); assert.equal(h.applied.length, 1); assert.equal(h.state.personalRevision, 3);
        h.requests[0].resolve(response(h.commit(0))); h.requests[0].bodyRead?.resolve(h.commit(0)); await drain();
        assert.equal(h.state.personalRevision, 3); assert.equal(h.applied.length, 1);
    });
    test(`ranking failure after a receipt never rolls back the pie or repeats the write (${repetition})`, async t => {
        const h = browserHarness(t), task = h.start(); await drain(); await h.save(0); await h.fail(1);
        assert.equal(await task.promise, true); assert.equal(h.state.personalRevision, 2);
        assert.equal(h.state.personalSavePending, false); assert.equal(h.state.personalSaveRequest, null);
        assert.equal(h.historyClears, 0); assert.match(h.state.statusMessage, /^Saved\./);
        const retry = h.start(); await drain(); assert.equal(h.requests[2].path, '/api/get_weighted_workspace');
        await h.read(2); assert.equal(await retry.promise, true);
        assert.equal(h.requests.filter(item => item.path.endsWith('save_personal_pie')).length, 1);
    });
    test(`a revision conflict retains the draft, deletion visibility and undo history (${repetition})`, async t => {
        const h = browserHarness(t); h.state.personalEntries = [];
        const task = h.start(); await drain(); await h.fail(0, 409, 'pie_revision_conflict');
        assert.equal(await task.promise, false); assert.equal(h.state.personalSaveConflict, true);
        assert.equal(h.state.personalEntries.length, 0); assert.equal(h.historyClears, 0);
        assert.equal(h.state.personalSaveRequest, null); assert.equal(h.state.personalSavePending, true);
        assert.match(h.state.statusMessage, /changes are kept/);
        assert.equal(h.pieRecovery.lookup('7', 1, { scene: recoveryScene.standard }).value.draft.entries.length, 0);
        assert.equal(h.guestDrafts.get('1:[["scene","101"]]'), null);
    });
    for (const responseType of ['failure', 'success']) test(`old-context ${responseType} cannot touch the replacement context (${repetition})`, async t => {
        const h = browserHarness(t), task = h.start(); await drain();
        h.state.categoryID = 2; h.state.statusMessage = 'Replacement ready';
        if (responseType === 'failure') await h.fail(0); else await h.save(0);
        assert.equal(await task.promise, true); assert.equal(h.state.statusMessage, 'Replacement ready');
        assert.equal(h.state.personalSaveError, ''); assert.equal(h.applied.length, 0); assert.equal(h.requests.length, 1);
    });
    test(`context change while a post-save gesture settles never applies old data (${repetition})`, async t => {
        const gesture = deferred(), h = browserHarness(t, { gesture }), task = h.start(); await drain(); await h.save(0);
        h.state.categoryID = 2; h.state.statusMessage = 'Replacement ready'; gesture.resolve(); await drain();
        assert.equal(await task.promise, true); assert.equal(h.requests.length, 1); assert.equal(h.applied.length, 0);
        assert.equal(h.state.statusMessage, 'Replacement ready');
    });
    test(`changed comparison reloads its calculation without saving the same pie twice (${repetition})`, async t => {
        const h = browserHarness(t), task = h.start(); await drain(); await h.save(0);
        h.state.comparisonRequest = { mode: 'best', keys: ['model', 'field:1'], filters: [] };
        await h.read(1); assert.equal(h.requests[2].path, '/api/get_weighted_workspace');
        assert.deepEqual(h.requests[2].body.comparison.keys, ['model', 'field:1']); await h.read(2);
        assert.equal(await task.promise, true); assert.equal(h.applied.length, 1);
        assert.equal(h.requests.filter(item => item.path.endsWith('save_personal_pie')).length, 1);
    });
    test(`account change prevents applying the receipt and blocks subsequent writes (${repetition})`, async t => {
        const h = browserHarness(t), task = h.start(); await drain(); h.state.userID = '8'; await h.save(0);
        assert.equal(await task.promise, false); assert.equal(h.state.accountWriteBlocked, true); assert.equal(h.applied.length, 0);
        assert.equal(await h.start().promise, false); assert.equal(h.requests.length, 1);
    });
}
