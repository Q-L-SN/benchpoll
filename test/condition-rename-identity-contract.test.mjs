import { normalizeScoreFieldRequests, normalizeFieldContribution } from '../score-field-service.js';
import { assertPrimaryCondition } from '../benchmark-primary-condition.js';
import { normalizeModelParameters, modelParameterLabel, parameterRowsToObject } from '../public/js/shared/model-parameters.js';
import { frontendSource } from './helpers/frontend-source.mjs';
import { selectableBenchmarkConditionSQL } from '../benchmark-condition-visibility.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const client = frontendSource('public/js/contribute.js');
const reviewerClient = frontendSource('public/js/censor.js');

function between(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
    assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
    return source.slice(start, end);
}

function loadContributionContract() {
    const sandbox = vm.createContext({ assertPrimaryCondition, normalizeScoreFieldRequests, normalizeFieldContribution, normalizeModelParameters, modelParameterLabel, parameterRowsToObject, URL, crypto, structuredClone });
    const normalization = between(server, 'function normalizeString(', 'function parseModerationContent(');
    const changeDiff = between(server, 'function canonicalChangeValue(', 'function entityChildSetChanges(');
    const moderationEdit = between(
        server,
        'function validateEditedContributionClientRefs(',
        'function referencedContributionEntry('
    );
    vm.runInContext(`${normalization}\n${changeDiff}\n${moderationEdit}\nthis.contract = {
        buildContributionContent,
        describeEntityChanges,
        normalizeStoredModerationContent,
        prepareEditedModerationContent
    };`, sandbox);
    return sandbox.contract;
}

function benchmarkCondition({ ID = 101, name = 'pass@1', isPrimary = ID === 101 } = {}) {
    return {
        ID,
        name,
        scoreDirection: 'higher',
        targetValue: null,
        usesPercentageScale: true,
        scoreMin: null,
        scoreMax: null,
        isDefault: name.trim().toLowerCase() === 'default',
        isPrimary
    };
}

function benchmarkChangeRequest(condition = benchmarkCondition()) {
    return {
        type: 'entity_change',
        targetKind: 'benchmark',
        targetID: 12,
        operation: 'update',
        reviewNotes: '',
        proposed: {
            name: 'IdentityBench',
            introductionURL: '',
            conditions: [condition]
        }
    };
}

function modelChangeRequest() {
    return {
        type: 'entity_change',
        targetKind: 'model',
        targetID: 22,
        operation: 'update',
        reviewNotes: '',
        proposed: {
            name: 'IdentityModel',
            introductionURL: '',
            vendor: {
                existingVendorID: 7,
                existingVendorRef: null
            }
        }
    };
}

function contextTemplateRequest() {
    return {
        type: 'new_category',
        requestKind: 'context',
        clientRef: 'context-budget',
        name: 'Budget',
        parentPath: 'topics/54/reasoning',
        parentCategoryID: 54,
        parentCategoryRef: null,
        pageURL: 'https://benchpoll.com/topics/54/reasoning',
        details: 'Keep these topic-specific context notes during moderation.',
        contextOrder: [{ clientRef: 'new-budget', dimensionID: null, dimensionRef: null, isNew: true }],
        options: [
            { key: 'any', name: 'Any', isDefault: true, isNeutral: true },
            { key: 'standard', name: 'Standard', isDefault: false, isNeutral: false }
        ]
    };
}

function storedEntityChange(contract, request, beforeConditionName) {
    const normalized = contract.buildContributionContent(request);
    const before = structuredClone(normalized.after);
    if (request.targetKind === 'model') before.name = beforeConditionName;
    else {
        before.conditions[0].name = beforeConditionName;
        before.conditions[0].isDefault = beforeConditionName.trim().toLowerCase() === 'default';
    }
    return {
        ...normalized,
        before,
        changes: contract.describeEntityChanges(before, normalized.after)
    };
}

test('benchmark changes preserve condition IDs and model changes preserve identity', () => {
    const contract = loadContributionContract();
    const benchmarkRequest = benchmarkChangeRequest();
    benchmarkRequest.proposed.conditions = [
        benchmarkCondition({ ID: 102, name: 'pass@2' }),
        benchmarkCondition({ ID: 101, name: 'pass@1' })
    ];
    const benchmark = contract.buildContributionContent(benchmarkRequest);
    const model = contract.buildContributionContent(modelChangeRequest());

    assert.equal(benchmark.after.conditions[0].ID, 102);
    assert.equal(benchmark.after.conditions[0].name, 'pass@2');
    assert.equal(benchmark.after.conditions[1].ID, 101);
    assert.equal(benchmark.after.conditions[1].name, 'pass@1');
    assert.equal(Object.hasOwn(model.after, 'conditions'), false);
    assert.equal(model.after.vendorID, 7);

});

test('primary changes support imported benchmark families larger than a new-submission batch', () => {
    const contract = loadContributionContract();
    const request = benchmarkChangeRequest();
    request.proposed.conditions = Array.from({ length: 2000 }, (_, index) => benchmarkCondition({
        ID: index + 1, name: `condition ${index + 1}`, isPrimary: index === 1999
    }));
    const content = contract.buildContributionContent(request);
    assert.equal(content.after.conditions.length, 2000);
    assert.equal(content.after.conditions.find(condition => condition.isPrimary).ID, 2000);
    request.proposed.conditions = Array.from({ length: 4097 }, (_, index) => benchmarkCondition({
        ID: index + 1, name: `condition ${index + 1}`, isPrimary: index === 0
    }));
    assert.throws(() => contract.buildContributionContent(request), error => error.body.error === 'invalid_benchmark_condition_count');
});

test('client change proposal builders keep each hydrated condition ID on that condition', () => {
    const sandbox = vm.createContext({ normalizeScoreFieldRequests, normalizeFieldContribution, normalizeModelParameters, modelParameterLabel, parameterRowsToObject,
        normalizedText: value => String(value ?? '').trim(),
        isLiteralDefaultCondition: value => String(value ?? '').trim().toLowerCase() === 'default',
        integerOrNull: value => Number.isInteger(Number(value)) ? Number(value) : null,
        evaluationScoreFieldsChanged: () => false,
        profileUsesPercentage: profile => Boolean(profile.usesPercentageScale),
        finiteOrNull: value => value === null ? null : Number(value),
        evaluationScoreBounds: () => ({ min: null, max: null }),
        evaluationStoredTargetValue: () => null
    });
    vm.runInContext(`${between(
        client,
        'function evaluationProfileChangeProposal(',
        'function evaluationChangeProposal('
    )}\nthis.benchmarkCondition = evaluationProfileChangeProposal({
        ID: 101,
        name: 'pass@2',
        usesPercentageScale: true,
        scoreMin: null,
        scoreMax: null,
        scoreDirection: 'higher',
        targetValue: null
    }, {});`, sandbox);

    assert.equal(sandbox.benchmarkCondition.ID, 101);
    assert.equal(sandbox.benchmarkCondition.name, 'pass@2');

});

test('change-form restoration follows condition IDs after another row is removed', () => {
    const sandbox = vm.createContext({ normalizeScoreFieldRequests, normalizeFieldContribution, structuredClone });
    vm.runInContext(`${between(
        client,
        'function setNested(',
        'function currentChangeDraftView('
    )}\nthis.baseline = {
        evaluation: { conditions: [
            { ID: 101, name: 'pass@1' },
            { ID: 102, name: 'pass@2' }
        ] }
    };
    this.current = {
        evaluation: { conditions: [{ ID: 102, name: 'renamed' }] }
    };
    this.originalValue = changePathValue(this.baseline, 'evaluation.conditions[102].name');
    this.updated = setChangePathValue(
        this.current,
        'evaluation.conditions[102].name',
        this.originalValue
    );`, sandbox);

    assert.equal(sandbox.originalValue, 'pass@2');
    assert.equal(sandbox.updated, true);
    assert.equal(sandbox.current.evaluation.conditions[0].ID, 102);
    assert.equal(sandbox.current.evaluation.conditions[0].name, 'pass@2');
});

test('model change submission converts vendorID to the one allowed external vendor locator', () => {
    const sandbox = vm.createContext({ normalizeScoreFieldRequests, normalizeFieldContribution,
        mode: 'edit_model',
        currentChangeProposal: () => ({
            vendorID: 7,
            name: 'IdentityModel',
            introductionURL: ''
        })
    });
    vm.runInContext(`${between(
        client,
        'function entityChangeSubmissionProposal(',
        'function currentChangeProposal('
    )}\nthis.proposal = entityChangeSubmissionProposal();`, sandbox);

    assert.equal('vendorID' in sandbox.proposal, false);
    assert.equal(sandbox.proposal.vendor.existingVendorID, 7);
    assert.deepEqual(Object.keys(sandbox.proposal.vendor).sort(), [
        'existingVendorID',
        'existingVendorRef'
    ]);
    assert.equal(Object.hasOwn(sandbox.proposal, 'conditions'), false);
});

test('model changes reject unused vendor fields instead of silently discarding them', () => {
    const contract = loadContributionContract();
    const request = modelChangeRequest();
    request.proposed.vendor.name = 'Ignored vendor name';

    assert.throws(
        () => contract.buildContributionContent(request),
        error => error?.body?.error === 'unknown_vendor_field'
            && error?.body?.field === 'name'
    );
});

test('canonical moderation records revalidate without using the external request shape', () => {
    const contract = loadContributionContract();
    const contextTemplate = contextTemplateRequest();
    const canonicalRecords = [
        contract.buildContributionContent({
            type: 'feedback',
            pageURL: 'https://benchpoll.com/',
            details: 'The feedback body is long enough.'
        }),
        contract.buildContributionContent({
            type: 'report_issue',
            issueType: 'correct_or_add_info',
            targetName: 'IdentityBench',
            targetKind: 'benchmark',
            targetBenchmarkID: 12,
            categoryPath: '',
            pageURL: 'https://benchpoll.com/',
            sourceURL: 'https://example.com/source',
            details: 'The benchmark metadata needs a correction.'
        }),
        contract.buildContributionContent(contextTemplate),
        contract.buildContributionContent({
            type: 'new_benchmark',
            benchmarks: [{
                clientRef: 'benchmark-one',
                existingBenchmarkID: null,
                existingBenchmarkRef: null,
                name: 'CanonicalBench',
                introductionURL: '',
                reviewerNotes: '',
                conditions: [{
                    clientRef: 'condition-one',
                    name: 'default',
                    scoreDirection: 'higher',
                    targetValue: null,
                    usesPercentageScale: true,
                    scoreMin: null,
                    scoreMax: null,
                    isDefault: true,
                    isPrimary: true
                }]
            }]
        }),
        contract.buildContributionContent({
            type: 'new_model',
            models: [{
                clientRef: 'model-one',
                existingModelID: null,
                existingModelRef: null,
                name: 'CanonicalModel',
                introductionURL: '',
                reviewerNotes: '',
                vendor: {
                    existingVendorID: 7,
                    existingVendorRef: null,
                    name: '',
                    logoKey: ''
                }
            }]
        }),
        contract.buildContributionContent({
            type: 'benchmark_result',
            reviewerNotes: '',
            results: [{
                clientRef: 'result-one',
                modelID: 22,
                modelRef: null,
                scoreFields: [],
                benchmarkID: 12,
                benchmarkRef: null,
                benchmarkConditionID: 101,
                benchmarkConditionRef: null,
                rawScore: 81,
                source: {
                    type: 'vendor_official',
                    url: 'https://example.com/result',
                    title: ''
                }
            }]
        })
    ];

    for (const record of canonicalRecords) {
        const revalidated = contract.normalizeStoredModerationContent(record);
        assert.equal(revalidated.type, record.type);
        assert.equal(revalidated.schemaVersion, record.schemaVersion);
        if (record.type === 'new_category') {
            assert.equal(revalidated.requestKind, 'context');
            assert.equal(revalidated.schemaVersion, 5);
            assert.equal(revalidated.parentCategoryID, contextTemplate.parentCategoryID);
            assert.equal(revalidated.details, contextTemplate.details);
            assert.deepEqual(structuredClone(revalidated), structuredClone(record));
            assert.throws(
                () => contract.normalizeStoredModerationContent({ ...record, schemaVersion: 4 }),
                error => error?.status === 409 && error?.body?.error === 'stored_submission_schema_mismatch'
            );
        }
    }
});

test('legacy category creation is retired for both external and canonical moderation records', () => {
    const contract = loadContributionContract();
    const request = { ...contextTemplateRequest(), requestKind: 'category', contextOrder: [], options: [] };
    for (const validate of [
        () => contract.buildContributionContent(request),
        () => contract.normalizeStoredModerationContent({ ...request, schemaVersion: 5 })
    ]) {
        assert.throws(validate, error => error?.status === 410
            && error?.body?.error === 'topic_hierarchy_removed'
            && error?.body?.url === '/#new-topic');
    }
});

test('external requests and canonical moderation records cannot be silently interchanged', () => {
    const contract = loadContributionContract();
    const raw = {
        type: 'feedback',
        pageURL: 'https://benchpoll.com/',
        details: 'The feedback body is long enough.'
    };
    const canonical = contract.buildContributionContent(raw);

    assert.throws(
        () => contract.normalizeStoredModerationContent(raw),
        error => error?.body?.error === 'stored_submission_schema_mismatch'
    );
    assert.throws(
        () => contract.buildContributionContent(canonical),
        error => error?.body?.error === 'unknown_submission_field'
            && error?.body?.field === 'schemaVersion'
    );
});

test('the reviewer simple-field editor retains the canonical schema version', () => {
    const fields = new Map([
        ['[name="contentJSON"]', null],
        ['[name="details"]', { value: 'Updated reviewer feedback.' }]
    ]);
    const sandbox = vm.createContext({ normalizeScoreFieldRequests, normalizeFieldContribution,
        editorFields: { querySelector: selector => fields.get(selector) ?? null },
        editorType: { value: 'feedback' },
        editorDrafts: { feedback: { schemaVersion: 1, type: 'feedback' } },
        requestFields: { feedback: [{ name: 'details', type: 'textarea' }] }
    });
    vm.runInContext(`${between(
        reviewerClient,
        'function collectEditorContent(',
        'function openEditor('
    )}\nthis.content = collectEditorContent();`, sandbox);

    assert.equal(sandbox.content.schemaVersion, 1);
    assert.equal(sandbox.content.type, 'feedback');
    assert.equal(sandbox.content.details, 'Updated reviewer feedback.');
});

test('canonical entity changes revalidate and reviewer edits recompute their change summary', () => {
    const contract = loadContributionContract();
    const original = storedEntityChange(
        contract,
        benchmarkChangeRequest(benchmarkCondition({ name: 'pass@2' })),
        'pass@1'
    );
    const revalidated = contract.normalizeStoredModerationContent(original);
    assert.equal(revalidated.after.conditions[0].ID, 101);

    const edited = structuredClone(original);
    edited.after.conditions[0].name = 'pass@3';
    const prepared = contract.prepareEditedModerationContent(
        original,
        edited,
        167495513,
        '2026-09-02T00:00:00.000Z'
    );
    assert.equal(prepared.after.conditions[0].ID, 101);
    assert.equal(prepared.after.conditions[0].name, 'pass@3');
    assert.equal(prepared.changes.some(change => change.after === 'pass@3'), true);
});

test('reviewer JSON editing cannot swap, remove, or recreate persisted condition identities', () => {
    const contract = loadContributionContract();
    const original = storedEntityChange(
        contract,
        benchmarkChangeRequest(benchmarkCondition({ name: 'pass@2' })),
        'pass@1'
    );
    const edited = structuredClone(original);
    edited.after.conditions[0].ID = 999;

    assert.throws(
        () => contract.prepareEditedModerationContent(
            original,
            edited,
            167495513,
            '2026-09-02T00:00:00.000Z'
        ),
        error => error?.body?.error === 'moderation_change_condition_identity_immutable'
    );
});

test('an in-use benchmark condition may be renamed because only removal requires dependency checks', async () => {
    const statements = [];
    const connection = {
        async execute(sql) {
            const statement = String(sql).replace(/\s+/g, ' ').trim();
            statements.push(statement);
            if (statement.startsWith('SELECT ID, condition_key AS conditionKey FROM benchmark_conditions')) {
                return [[{ ID: 101, conditionKey: 'pass-1' }], []];
            }
            throw new Error(`Unexpected dependency query during a rename: ${statement}`);
        }
    };
    const sandbox = vm.createContext({ normalizeScoreFieldRequests, normalizeFieldContribution,
        slugifyIdentifier: value => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    });
    vm.runInContext(`${between(server, 'function assertBenchmarkConditionNameLengths(', 'function normalizeBenchmarkCondition(')}\n${between(server, 'function assertUniqueChangeConditionNames(', 'function normalizeBenchmarkChangeCondition(')}\n${between(
        server,
        'function entityChildSetChanges(',
        'async function validateEntityChangeProposal('
    )}\nthis.validateRename = assertBenchmarkConditionSetCanChange;`, sandbox);

    await sandbox.validateRename(
        connection,
        12,
        { conditions: [benchmarkCondition({ ID: 101, name: 'pass@1' })] },
        { conditions: [benchmarkCondition({ ID: 101, name: 'pass@2' })] }
    );

    assert.equal(
        statements.some(statement => statement.includes('FROM benchmark_results')),
        false
    );
    assert.equal(
        statements.some(statement => statement.includes('FROM personal_pie_weights')),
        false
    );
});

test('new scores reject archived benchmarks even if a condition can be selected', async () => {
    const sandbox = vm.createContext({ normalizeScoreFieldRequests, normalizeFieldContribution,
        selectableBenchmarkConditionSQL });
    vm.runInContext(`${between(
        server,
        'async function validateModelResultForSubmission(',
        'async function loadContributionReferenceSource('
    )}\nthis.validateResult = validateModelResultForSubmission;`, sandbox);
    const connection = {
        async execute(sql) {
            const statement = String(sql).replace(/\s+/g, ' ').trim();
            if (statement.startsWith('SELECT ID FROM organizations')) return [[{ ID: 1 }], []];
            if (statement.startsWith('SELECT ID, is_active FROM models')) {
                return [[{ ID: 22, is_active: 1 }], []];
            }
            if (statement.startsWith('SELECT ID, is_active FROM benchmarks')) {
                return [[{ ID: 12, is_active: 0 }], []];
            }
            if (statement.startsWith('SELECT benchmark_conditions.ID, benchmark_conditions.benchmark_ID')) {
                return [[{
                    ID: 101,
                    benchmark_ID: 12,
                    uses_percentage_scale: 1,
                    selectable: 1,
                    benchmarkActive: 0
                }], []];
            }
            throw new Error(`Unexpected score validation query: ${statement}`);
        }
    };

    await assert.rejects(
        sandbox.validateResult(connection, {
            type: 'benchmark_result',
            results: [{
                modelID: 22,
                scoreFields: [],
                benchmarkID: 12,
                benchmarkConditionID: 101,
                rawScore: 80, source: {  }
            }]
        }),
        error => error?.body?.error === 'benchmark_not_found'
    );
});

test('changing primary preserves distinct stored keys for unchanged duplicate labels, but rejects newly introduced duplicates', async () => {
    const sandbox = vm.createContext({
        slugifyIdentifier: value => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    });
    vm.runInContext(`${between(server, 'function assertBenchmarkConditionNameLengths(', 'function normalizeBenchmarkCondition(')}\n${between(server, 'function assertUniqueChangeConditionNames(', 'function normalizeBenchmarkChangeCondition(')}\n${between(
        server, 'function entityChildSetChanges(', 'async function validateEntityChangeProposal('
    )}\nthis.validate = assertBenchmarkConditionSetCanChange;`, sandbox);
    const before = { conditions: [benchmarkCondition({ ID: 101, name: 'same display label' }),
        benchmarkCondition({ ID: 102, name: 'same display label', isPrimary: false })] };
    const connection = { async execute() { return [[{ ID: 101, conditionKey: 'imported-a' },
        { ID: 102, conditionKey: 'imported-b' }], []]; } };
    const after = { conditions: before.conditions.map(condition => ({ ...condition, isPrimary: condition.ID === 102 })) };
    const plan = await sandbox.validate(connection, 12, before, after);
    assert.equal(plan.conditionKeys.get(101), 'imported-a');
    assert.equal(plan.conditionKeys.get(102), 'imported-b');
    const differentBefore = { conditions: [before.conditions[0], { ...before.conditions[1], name: 'another label' }] };
    await assert.rejects(sandbox.validate(connection, 12, differentBefore, after),
        error => error.body.error === 'duplicate_benchmark_condition');
    const added = { conditions: [...before.conditions, benchmarkCondition({ ID: null, name: 'same display label', isPrimary: false })] };
    await assert.rejects(sandbox.validate(connection, 12, before, added),
        error => error.body.error === 'duplicate_benchmark_condition');
});

function loadApplyContract(state) {
    const sandbox = vm.createContext({ normalizeScoreFieldRequests, normalizeFieldContribution, crypto, normalizeModelParameters,
        loadBenchmarkChangeTarget: async () => structuredClone(state.benchmarkCurrent),
        loadModelChangeTarget: async () => structuredClone(state.modelCurrent),
        assertEntityChangeIsCurrent() {},
        validateEntityChangeProposal: async (connection, content, before) => {
            if (!Object.hasOwn(before, 'conditions')) return;
            return { conditionKeys: new Map(content.after.conditions.map(condition => [condition.ID,
                before.conditions.find(row => row.ID === condition.ID)?.name === condition.name
                    ? connection.benchmarkRows.find(row => row.ID === condition.ID)?.conditionKey
                    : String(condition.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')])) };
        },
        slugifyIdentifier: value => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        insertSubmittedBenchmarkCondition: async () => {
            state.benchmarkInserts += 1;
        }
    });
    vm.runInContext(`${between(server, 'function canonicalChangeValue(', 'function entityChildSetChanges(')}
    ${between(server, 'function withoutLegacyBenchmarkTags(', 'function assertSingleConditionMutation(')}
    ${between(
        server,
        'function assertSingleConditionMutation(',
        'function entityChangeResultContent('
    )}\nthis.contract = { applyBenchmarkChange, applyModelChange };`, sandbox);
    return sandbox.contract;
}

function mutationResult(affectedRows = 1) {
    return [{ affectedRows, changedRows: affectedRows }, []];
}

function createChangeConnection({ benchmarkRows = [], modelRows = [] } = {}) {
    const statements = [];
    return {
        statements,
        benchmarkRows,
        modelRows,
        async execute(sql, params = []) {
            const statement = String(sql).replace(/\s+/g, ' ').trim();
            statements.push({ statement, params: structuredClone(params) });
            if (statement.startsWith('UPDATE benchmarks ')) return mutationResult();
            if (statement.startsWith('UPDATE benchmark_conditions SET condition_key = ?, is_default = 0, is_primary = 0 WHERE')) {
                const row = benchmarkRows.find(candidate => candidate.ID === params[1] && candidate.benchmarkID === params[2]);
                if (!row) return mutationResult(0);
                row.conditionKey = params[0];
                row.isDefault = false;
                row.isPrimary = false;
                return mutationResult();
            }
            if (statement.startsWith('UPDATE benchmark_conditions SET condition_key = ?, name = ?')) {
                const row = benchmarkRows.find(candidate => candidate.ID === params[10] && candidate.benchmarkID === params[11]);
                if (!row) return mutationResult(0);
                row.conditionKey = params[0];
                row.name = params[1];
                row.differenceExplanation = params[2];
                row.isDefault = Boolean(params[8]);
                row.isPrimary = Boolean(params[9]);
                return mutationResult();
            }
            throw new Error(`Unexpected SQL in condition identity test: ${statement}`);
        }
    };
}

test('benchmark rename updates the existing row and leaves score and pie foreign keys intact', async () => {
    const before = {
        name: 'IdentityBench',
        introductionURL: '',
        tags: ['Benchmark'],
        conditions: [benchmarkCondition({ name: 'pass@1' })]
    };
    const state = {
        benchmarkCurrent: before,
        modelCurrent: null,
        benchmarkInserts: 0,
        modelInserts: 0
    };
    const connection = createChangeConnection({
        benchmarkRows: [{ ID: 101, benchmarkID: 12, conditionKey: 'pass-1', name: 'pass@1' }]
    });
    const scores = [{ benchmarkConditionID: 101 }];
    const weights = [{ benchmarkConditionID: 101, weight: 10000 }];
    const contract = loadApplyContract(state);

    await contract.applyBenchmarkChange(connection, {
        targetID: 12,
        operation: 'update',
        before,
        after: {
            ...before,
            conditions: [benchmarkCondition({ name: 'pass@2' })]
        }
    });

    assert.equal(connection.benchmarkRows[0].ID, 101);
    assert.equal(connection.benchmarkRows[0].name, 'pass@2');
    assert.equal(scores[0].benchmarkConditionID, 101);
    assert.equal(weights[0].benchmarkConditionID, 101);
    assert.equal(state.benchmarkInserts, 0);
    assert.equal(connection.statements.some(item => /DELETE FROM benchmark_conditions/i.test(item.statement)), false);
});

test('two benchmark conditions can exchange names without exchanging identities', async () => {
    const before = {
        name: 'IdentityBench',
        introductionURL: '',
        tags: ['Benchmark'],
        conditions: [
            benchmarkCondition({ ID: 101, name: 'pass@1' }),
            benchmarkCondition({ ID: 102, name: 'pass@2' })
        ]
    };
    const state = {
        benchmarkCurrent: before,
        modelCurrent: null,
        benchmarkInserts: 0,
        modelInserts: 0
    };
    const connection = createChangeConnection({
        benchmarkRows: [
            { ID: 101, benchmarkID: 12, conditionKey: 'pass-1', name: 'pass@1' },
            { ID: 102, benchmarkID: 12, conditionKey: 'pass-2', name: 'pass@2' }
        ]
    });
    const contract = loadApplyContract(state);

    await contract.applyBenchmarkChange(connection, {
        targetID: 12,
        operation: 'update',
        before,
        after: {
            ...before,
            conditions: [
                benchmarkCondition({ ID: 101, name: 'pass@2' }),
                benchmarkCondition({ ID: 102, name: 'pass@1' })
            ]
        }
    });

    assert.deepEqual(
        connection.benchmarkRows.map(row => ({ ID: row.ID, name: row.name })),
        [{ ID: 101, name: 'pass@2' }, { ID: 102, name: 'pass@1' }]
    );
    assert.equal(state.benchmarkInserts, 0);
});

test('model rename updates identity without altering score assignments', async () => {
    const before = { vendorID: 7, name: 'Before', introductionURL: '', notes: '' };
    const state = { modelCurrent: before };
    const calls = [];
    const db = { async execute(sql, params) {
        calls.push({ sql, params });
        if (sql.includes('SELECT name FROM organizations')) return [[{ name: 'Lab' }]];
        if (sql.includes('SELECT ID FROM models WHERE slug')) return [[]];
        if (sql.includes('UPDATE models')) return mutationResult();
        throw Error(sql);
    } };
    await loadApplyContract(state).applyModelChange(db, { targetID: 22, operation: 'update', before, after: { ...before, name: 'After' } });
    assert.equal(calls.filter(call => call.sql.includes('UPDATE models')).length, 1);
    assert.ok(calls.every(call => !/benchmark_results|model_conditions/.test(call.sql)));
});

test('condition updates fail explicitly when the persisted row is not matched', async () => {
    const before = {
        name: 'IdentityBench',
        introductionURL: '',
        tags: [],
        conditions: [benchmarkCondition({ name: 'pass@1' })]
    };
    const state = {
        benchmarkCurrent: before,
        modelCurrent: null,
        benchmarkInserts: 0,
        modelInserts: 0
    };
    const contract = loadApplyContract(state);
    const connection = createChangeConnection({ benchmarkRows: [] });

    await assert.rejects(
        contract.applyBenchmarkChange(connection, {
            targetID: 12,
            operation: 'update',
            before,
            after: {
                ...before,
                conditions: [benchmarkCondition({ name: 'pass@2' })]
            }
        }),
        error => error?.body?.error === 'benchmark_condition_update_missed'
    );
});
