import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { assertPrimaryCondition } from '../benchmark-primary-condition.js';
import { normalizeDiscussionReport } from '../discussion-service.js';
import { scoreEvidenceKey } from '../score-aggregation.js';
import { loadScoreFieldCatalog, normalizeContributionScoreFields, normalizeFieldContribution,
    normalizeScoreFieldRequests, resolveScoreFields } from '../score-field-service.js';
import { modelParameterLabel, normalizeModelParameters, parameterRowsToObject } from '../public/js/shared/model-parameters.js';
import { contributionPath, contributionRoute } from '../public/js/shared/contribution-navigation.js';
import { moderationAuditSnapshot } from '../moderation-admin.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const fields = [
    { ID: 20, name: 'Effort', type: 'enum', allowEmpty: false, options: [{ ID: 101, label: 'High' }, { ID: 102, label: 'Low' }] },
    { ID: 1, name: 'Harness', type: 'enum', allowEmpty: true, options: [{ ID: 11, label: 'Agent A' }, { ID: 12, label: 'Unknown', excluded: true }] },
    { ID: 2, name: 'Harness version', type: 'text', options: [] },
    { ID: 3, name: 'Token budget', type: 'number', options: [] },
    { ID: 4, name: 'Thinking', type: 'presence', options: [] },
    { ID: 5, name: 'Custom enum', type: 'enum', options: [{ ID: 51, label: 'A' }] },
    { ID: 6, name: 'Reasoning effort', type: 'enum', options: [{ ID: 61, label: 'High' }] }
];
const fixed = [{ fieldID: 1, value: 11 }, { fieldID: 20, value: 101 }];
const result = (scoreFields = fixed) => ({
    clientRef: 'score-one', modelID: 4, modelRef: null, benchmarkID: 6, benchmarkRef: null,
    benchmarkConditionID: 7, benchmarkConditionRef: null, rawScore: 82.5, scoreFields,
    notes: '', source: { type: 'other', url: 'https://example.com/scores', title: '' }
});
const scoreSubmission = assignments => ({ type: 'benchmark_result', results: [result(assignments)], reviewerNotes: '' });
const correction = assignments => ({ type: 'entity_change', targetKind: 'result', targetID: 42,
    operation: 'update', reviewNotes: '', proposed: { results: [{ ...result(assignments), rawScore: 83 }] } });

function between(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Source markers: ${start}, ${end}`);
    return source.slice(from, to);
}

function harness({ senior = false, historical = [], targetFields = fixed, replay = false } = {}) {
    const state = { connections: 0, claims: 0, completed: 0, catalogReads: 0, writes: [], stored: [], applied: [], scoreWrites: [],
        emailEnqueues: [], emailKicks: [] };
    const original = { result: { ...result([...targetFields, ...historical]) } };
    delete original.result.clientRef;
    delete original.result.modelRef;
    delete original.result.benchmarkRef;
    delete original.result.benchmarkConditionRef;
    const connection = { async execute(sql, values) {
        if (sql.includes('FROM score_fields')) { state.catalogReads++; return [fields.map(field => ({ ...field, revision: 1, isActive: 1 }))]; }
        if (sql.includes('FROM score_field_options')) return [fields.flatMap(field => field.options.map(option => ({ ...option, fieldID: field.ID, revision: 1 })))];
        if (sql.startsWith('SELECT email FROM users')) return [[{ email: 'review@example.test',
            email_verified_at: new Date('2026-10-08T00:00:00Z'), deleted_at: null, banned_at: null, banned_until: null }]];
        if (sql.startsWith('SELECT ID FROM users')) return [[{ ID: '7', deleted_at: null, banned_at: null, banned_until: null }]];
        if (sql.startsWith('SELECT ID FROM models') || sql.startsWith('SELECT source_url, raw_score, score_fields')) return [[]];
        if (sql.startsWith('INSERT INTO benchmark_results')) {
            state.scoreWrites.push(JSON.parse(values[9]));
            return [{ insertId: 100 }];
        }
        if (sql.startsWith('INSERT INTO moderation_logs')) {
            state.writes.push(sql);
            state.stored.push(JSON.parse(values[0]));
            return [{ insertId: 99 }];
        }
        if (sql.startsWith('UPDATE moderation_logs SET status')) { state.writes.push(sql); return [{}]; }
        throw Error(`Unexpected database operation: ${sql}`);
    } };
    let submit;
    const noop = async () => {};
    const sandbox = vm.createContext({
        URL, crypto, structuredClone, normalizeScoreFieldRequests, normalizeFieldContribution,
        normalizeContributionScoreFields, loadScoreFieldCatalog, resolveScoreFields,
        assertPrimaryCondition, normalizeDiscussionReport, modelParameterLabel, normalizeModelParameters, parameterRowsToObject,
        API: { post(_path, ...handlers) { submit = handlers.at(-1); } },
        requireAuthForAPI() {}, requireAccountWriteOwner() {},
        requireCurrentTermsForAPI(_req, _res, next) { next(); },
        db: { async getConnection() { state.connections++; return connection; } },
        startTransactionConnection: noop, commitTransactionConnection: noop,
        rollbackModerationConnection: noop, releaseTransactionConnection() {},
        createModerationAuditRecorder: () => ({ connection }),
        async claimWriteIntent() { state.claims++; return replay ? { response: { status: 204 } } : {}; },
        readWriteIdentity: () => 'fixture', completeWriteIntent: async () => { state.completed++; },
        loadEntityChangeTarget: async () => structuredClone(original), validateEntityChangeProposal: noop,
        materializeResultReferences: async (_connection, result) => result,
        resolveResultBenchmarkCondition: async () => ({ ID: 7, benchmark_ID: 6 }),
        assertScoreSourcePolicy: async () => false, loadResultModel: async () => 4,
        currentScoreSQL: () => '1 = 1', scoreEvidenceKey, benchmarkConditionSnapshot: () => ({}),
        markBenchmarkScoresUpdated: noop, recordSyncedScoreEdit: noop,
        validateDiscussionReport: noop, validateContributionReferences: noop,
        validateContributionStructureForSubmission: noop, validateContributionEntitiesForSubmission: noop, validateModelResultForSubmission: noop,
        applyModerationContent: async (_connection, content) => state.applied.push(plain(content)),
        moderationAuditSnapshot, insertModerationAuditLog: noop,
        moderationEmailService: {
            async enqueue(_connection, details) { state.emailEnqueues.push(plain(details)); return { ID: 123 }; },
            kick(ID) { state.emailKicks.push(ID); }
        }
    });
    vm.runInContext(between('function normalizeString(', 'function parseModerationContent('), sandbox);
    vm.runInContext(between('function canonicalChangeValue(', 'function entityChildSetChanges('), sandbox);
    vm.runInContext(between('async function prepareEntityChangeForSubmission(', 'function validateEditedContributionClientRefs('), sandbox);
    vm.runInContext(between('async function applyBenchmarkResult(', 'async function applyModerationContent('), sandbox);
    vm.runInContext(between('async function enqueueModerationDecisionEmail(', 'function getModerationStatus('), sandbox);
    vm.runInContext(between("API.post('/submit_contribution'", 'function pendingCatalogReference('), sandbox);
    return { state, original, sandbox,
        async applyScore(content) {
            await vm.runInContext('applyBenchmarkResult', sandbox)(connection, { type: 'benchmark_result', results: [content.after.result] },
                { submittedBy: 7, moderationLogID: 99, editingResultID: 42 });
        }, async submit(body) {
        let status;
        const response = { status(value) { status = value; return this; }, end() {} };
        await submit({ body: { ...body, expectedUserID: '7' }, session: { userID: 7 }, user: { ID: 7, isSenior: senior } }, response);
        return status;
    } };
}

test('fixed score fields accept approved options, optional omission and permitted empty values', () => {
    assert.deepEqual(normalizeContributionScoreFields([...fixed].reverse(), fields), fixed);
    assert.deepEqual(normalizeContributionScoreFields([], fields), []);
    assert.deepEqual(normalizeContributionScoreFields([{ fieldID: 1, value: null }], fields), [{ fieldID: 1, value: null }]);
    assert.deepEqual(normalizeContributionScoreFields([{ fieldID: 1, value: 12 }], fields), [{ fieldID: 1, value: 12 }]);
    for (const assignments of [[{ fieldID: 20, value: null }], [{ fieldID: 1, value: 'Agent A' }], [{ fieldID: 1, value: 101 }], [...fixed, fixed[0]]]) {
        assert.throws(() => normalizeContributionScoreFields(assignments, fields), error => error.status === 400);
    }
});

for (const senior of [false, true]) {
    test(`crafted score submissions cannot assign custom fields or mutate options (${senior ? 'senior' : 'ordinary'})`, async () => {
        const attacks = [
            { fieldID: 2, value: 'v2' }, { fieldID: 3, value: 1000 }, { fieldID: 4, value: null },
            { fieldID: 5, value: 51 }, { fieldID: 6, value: 61 }, { fieldID: 999, value: 'crafted' },
            { fieldRequestID: 99, value: null }, { fieldRequestID: 99, optionIndex: 0 },
            { fieldID: 1, optionRequestID: 99 }, { fieldID: 1, newOption: 'New harness' },
            { fieldID: 20, newOption: 'Ultra' }, { fieldID: 1, value: 999 }
        ];
        for (const assignment of attacks) {
            for (const payload of [scoreSubmission([assignment]), correction([assignment]), scoreSubmission([...fixed, assignment])]) {
                const api = harness({ senior });
                await assert.rejects(api.submit(payload), error => error.status === 400, JSON.stringify(assignment));
                assert.deepEqual(api.state.writes, []);
                assert.equal(api.state.completed, 0, 'Never commit a rejected contribution');
                assert.deepEqual(api.state.emailEnqueues, []);
                assert.deepEqual(api.state.emailKicks, []);
            }
        }
    });

    test(`all crafted field/option mutation types return 410 without a database connection (${senior ? 'senior' : 'ordinary'})`, async () => {
        for (const type of ['score_field', 'score_field_option']) {
            for (const operation of ['create', 'update', 'delete']) {
                const api = harness({ senior });
                await assert.rejects(api.submit({ type, operation, targetID: 1, revision: 1,
                    fieldID: 1, label: 'Crafted', excluded: false, notes: 'Crafted request',
                    definition: { name: 'Custom field', type: 'text', options: [], allowEmpty: false, excludeMissing: true, excludeEmpty: false } }),
                error => error.status === 410 && error.body.error === 'score_field_contribution_retired');
                assert.equal(api.state.connections, 0);
                assert.deepEqual(api.state.writes, []);
            }
        }
    });

    test(`approved fixed choices still reach the real submission handler (${senior ? 'senior' : 'ordinary'})`, async () => {
        for (const assignments of [fixed, [], [{ fieldID: 1, value: null }], [{ fieldID: 1, value: 12 }]]) {
            const api = harness({ senior });
            assert.equal(await api.submit(scoreSubmission(assignments)), 204);
            assert.deepEqual(api.state.stored[0].results[0].scoreFields, assignments);
            assert.equal(api.state.applied.length, senior ? 1 : 0);
            assert.ok(api.state.writes.every(sql => sql.includes('moderation_logs')));
            assert.equal(api.state.emailEnqueues.length, senior ? 1 : 0);
            assert.deepEqual(api.state.emailKicks, senior ? [123] : []);
            if (senior) assert.deepEqual(api.state.emailEnqueues[0], { moderationLogID: 99, userID: '7',
                decision: 'approved', contributionType: 'benchmark_result' });
        }
    });
}

test('a successful write replay is returned before consulting potentially changed field metadata', async () => {
    const api = harness({ replay: true });
    assert.equal(await api.submit(scoreSubmission(fixed)), 204);
    assert.equal(api.state.catalogReads, 0);
    assert.equal(api.state.claims, 1);
    assert.deepEqual(api.state.writes, []);
});

test('corrections preserve server-owned historical fields without accepting their values from clients', async () => {
    const historical = [{ fieldID: 2, value: 'v1.2' }, { fieldID: 3, value: '1e3' }, { fieldID: 4, value: null }, { fieldID: 5, value: 51 }];
    const api = harness({ historical });
    const before = structuredClone(api.original);
    assert.equal(await api.submit(correction([{ fieldID: 20, value: 102 }])), 204);
    const stored = api.state.stored[0];
    assert.deepEqual(stored.before, before);
    assert.deepEqual(stored.after.result.scoreFields, [...historical, { fieldID: 20, value: 102 }]);
    assert.deepEqual(api.original, before);
    const roundTrip = vm.runInContext('normalizeStoredModerationContent', api.sandbox)(stored);
    assert.deepEqual(plain(roundTrip.after.result.scoreFields), stored.after.result.scoreFields);
    await api.applyScore(stored);
    assert.deepEqual(api.state.scoreWrites, [stored.after.result.scoreFields], 'Applying the correction also preserves historical assignments');
    for (const assignments of [[{ fieldID: 2, value: 'v9' }], [{ fieldID: 5, value: 51 }]]) {
        await assert.rejects(harness({ historical }).submit(correction(assignments)), error => error.status === 400);
    }
});

test('pending fixed fields and pending options cannot be used as approved choices', () => {
    const catalog = structuredClone(fields);
    catalog[0].pending = true;
    catalog[1].options.push({ ID: 99, label: 'Unapproved', pending: true });
    for (const assignment of [{ fieldID: 20, value: 101 }, { fieldID: 1, value: 99 }]) {
        assert.throws(() => normalizeContributionScoreFields([assignment], catalog), error => error.status === 400);
    }
});

test('full catalog reads retain historical custom field definitions and ranking policies', async () => {
    const api = harness();
    const catalog = await loadScoreFieldCatalog(await vm.runInContext('db.getConnection()', api.sandbox));
    assert.deepEqual(catalog.map(field => field.ID).sort((a, b) => a - b), fields.map(field => field.ID).sort((a, b) => a - b));
    assert.equal(catalog.find(field => field.ID === 1).options.find(option => option.ID === 12).excluded, true);
    assert.equal(catalog.find(field => field.ID === 3).type, 'number');
    assert.deepEqual(api.state.writes, []);
});

test('withdrawn form paths and legacy query modes return 410; ordinary forms remain served', async () => {
    let route;
    vm.runInNewContext(between("page.get(['/contribute'", "page.get('/adminlogin'"), {
        currentDir: '/fixture', page: { get(_paths, handler) { route = handler; } }
    });
    for (const path of ['/contribute/score-fields', '/contribute/score-fields/', '/contribute/score-fields/edit',
        '/contribute/score-field-options', '/contribute/score-field-options/']) {
        const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, send() {}, sendFile() { assert.fail('Retired form served'); } };
        await route({ path, query: {} }, response);
        assert.equal(response.statusCode, 410);
        assert.equal(contributionRoute(path), null);
    }
    for (const mode of ['score_field', 'score_field_option']) {
        assert.throws(() => contributionPath(mode));
        const response = { status(value) { assert.equal(value, 410); return this; }, send() {}, sendFile() { assert.fail('Legacy retired form served'); } };
        await route({ path: '/contribute', query: { mode } }, response);
    }
    for (const path of ['/contribute/scores/new', '/contribute/scores/42/edit']) {
        let served = false;
        await route({ path, query: {} }, { sendFile(file) { served = file.endsWith('/private/contribute.html'); } });
        assert.equal(served, true);
    }
});
