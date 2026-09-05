import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    ADMIN_EXPLORER_ENTITIES,
    createModerationAuditRecorder,
    insertModerationAuditLog,
    moderationAuditSnapshot,
    moderationRequestSummary,
    queryAdminDataExplorer,
    queryAdminDataRecord,
    queryModerationAuditLogDetail,
    queryModerationAuditLogs
} from '../moderation-admin.js';

const source = fs.readFileSync(new URL('../moderation-admin.js', import.meta.url), 'utf8');

test('admin explorer exposes only canonical strict-schema entities', () => {
    const keys = ADMIN_EXPLORER_ENTITIES.map(entity => entity.key);
    assert.deepEqual(keys, [
        'benchmarks',
        'benchmark_conditions',
        'models',
        'model_conditions',
        'benchmark_results',
        'benchmark_tags',
        'vendors',
        'categories',
        'ranking_dimensions',
        'ranking_contexts',
        'personal_pies',
        'personal_pie_weights'
    ]);
    assert.doesNotMatch(source, /evaluation_profiles|evaluation_results|model_configurations|\bobjects\b|template_values|template_hash/);
});

test('moderation request summaries use canonical contribution names', () => {
    assert.equal(moderationRequestSummary({
        type: 'new_benchmark',
        benchmarks: [{ name: 'BrowseComp' }, { name: 'PaperBench' }]
    }), 'BrowseComp + 1 more');
    assert.equal(moderationRequestSummary({
        type: 'benchmark_result',
        results: [{}, {}]
    }), '2 benchmark results');
    assert.equal(moderationRequestSummary({
        type: 'entity_change',
        targetKind: 'benchmark',
        targetID: 12,
        operation: 'delete',
        before: { name: 'Old benchmark' }
    }), 'Delete benchmark: Old benchmark');
});

test('audit recorder captures rendered SQL and database response metadata', async () => {
    const connection = {
        async execute() {
            return [{ affectedRows: 1, changedRows: 1 }, []];
        },
        async query() {
            return [[{ ID: 1 }], []];
        }
    };
    const recorder = createModerationAuditRecorder(connection);
    await recorder.connection.execute('UPDATE benchmarks SET name = ? WHERE ID = ?', ['StrictBench', 7]);
    await recorder.connection.query('SELECT ID FROM benchmarks WHERE ID = ?', [7]);
    assert.equal(recorder.statements.length, 2);
    assert.equal(recorder.statements[0].success, true);
    assert.match(recorder.statements[0].sql, /UPDATE benchmarks SET name = 'StrictBench' WHERE ID = 7/);
    assert.deepEqual(recorder.statements[0].response, { affectedRows: 1, changedRows: 1 });
    assert.deepEqual(recorder.statements[1].response, { rowCount: 1 });
});

test('successful moderation audit entries require recorded SQL and persist reviewer identity', async () => {
    const writes = [];
    const connection = {
        async execute(sql, params) {
            writes.push({ sql, params });
            return [{ insertId: 44 }, []];
        }
    };
    const recorder = {
        statements: [{
            method: 'execute',
            sql: 'INSERT INTO benchmarks (name) VALUES (\'StrictBench\')',
            success: true,
            durationMs: 1,
            response: { affectedRows: 1, insertId: 9 }
        }],
        elapsedMs: () => 3
    };
    const auditID = await insertModerationAuditLog(connection, recorder, {
        moderationLogID: 8,
        reviewerUserID: 167495513,
        actionType: 'approve',
        statusBefore: 'pending',
        statusAfter: 'approved',
        requestBefore: { content: { type: 'new_benchmark', benchmarks: [{ name: 'StrictBench' }] } },
        requestAfter: { content: { type: 'new_benchmark', benchmarks: [{ name: 'StrictBench' }] } }
    });
    assert.equal(auditID, 44);
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /INSERT INTO moderation_audit_logs/);
    assert.equal(writes[0].params[1], 167495513);
    assert.match(writes[0].params[9], /INSERT INTO benchmarks/);
});

test('successful moderation audit entries cannot silently omit database work', async () => {
    await assert.rejects(insertModerationAuditLog({ execute() {} }, {
        statements: [],
        elapsedMs: () => 0
    }, {
        moderationLogID: 8,
        reviewerUserID: 1,
        actionType: 'approve',
        statusBefore: 'pending',
        statusAfter: 'approved',
        requestBefore: { content: { type: 'new_benchmark' } }
    }), /cannot be committed without recorded SQL/);
});

test('data explorer applies allowlisted SQL and returns only declared list columns', async () => {
    const calls = [];
    const connection = {
        async execute(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('COUNT(*) AS total')) return [[{ total: 1 }], []];
            return [[{
                id: 7,
                name: 'StrictBench',
                conditionCount: 2,
                resultCount: 3,
                isActive: 1,
                updatedAt: '2026-08-29',
                introductionURL: 'https://example.com',
                secretColumn: 'must not leak'
            }], []];
        }
    };
    const data = await queryAdminDataExplorer(connection, {
        entity: 'benchmarks',
        search: 'Strict',
        page: 1,
        pageSize: 25
    });
    assert.equal(data.total, 1);
    assert.deepEqual(data.rows[0], {
        id: 7,
        name: 'StrictBench',
        conditionCount: 2,
        resultCount: 3,
        isActive: 1,
        updatedAt: '2026-08-29'
    });
    assert.deepEqual(calls[0].params, ['%Strict%']);
    assert.match(calls[1].sql, /FROM benchmarks/);
    assert.doesNotMatch(calls[1].sql, /\bobjects\b/);
});

test('data explorer rejects arbitrary table names', async () => {
    await assert.rejects(
        queryAdminDataExplorer({ execute() { throw new Error('must not run'); } }, { entity: 'users' }),
        error => error?.status === 400 && error?.body?.error === 'invalid_explorer_entity'
    );
});

test('record detail reads a canonical benchmark row by ID', async () => {
    const connection = {
        async execute(sql, params) {
            assert.match(sql, /FROM benchmarks/);
            assert.deepEqual(params, [7]);
            return [[{ id: 7, name: 'StrictBench', introductionURL: null }], []];
        }
    };
    const record = await queryAdminDataRecord(connection, { entity: 'benchmarks', id: 7 });
    assert.equal(record.row.name, 'StrictBench');
});

test('ordinary reviewers cannot query senior-only message audit actions', async () => {
    const calls = [];
    const connection = {
        async execute(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('COUNT(*)')) return [[{ total: 0 }], []];
            return [[], []];
        }
    };
    const result = await queryModerationAuditLogs(connection, {}, { includeSeniorActions: false });
    assert.equal(result.actions.includes('admin_message'), false);
    assert.match(calls[0].sql, /action_type NOT IN/);
    assert.deepEqual(calls[0].params, ['admin_message']);
});

test('audit detail parses immutable request and database response JSON', async () => {
    const connection = {
        async execute() {
            return [[{
                ID: 3,
                action_type: 'approve',
                request_before: '{"status":"pending"}',
                request_after: '{"status":"approved"}',
                database_response: '{"statementCount":2}'
            }], []];
        }
    };
    const detail = await queryModerationAuditLogDetail(connection, { ID: 3 }, { includeSeniorActions: true });
    assert.deepEqual(detail.request_before, { status: 'pending' });
    assert.deepEqual(detail.request_after, { status: 'approved' });
    assert.deepEqual(detail.database_response, { statementCount: 2 });
});

test('audit snapshots retain moderation request content and reviewer-visible status', () => {
    assert.deepEqual(moderationAuditSnapshot({
        ID: 8,
        status: 'pending',
        user_id: 99,
        report_count: 2,
        created_at: 'created',
        updated_at: 'updated'
    }, { type: 'new_benchmark' }), {
        moderationLogID: 8,
        status: 'pending',
        submittedBy: 99,
        reportCount: 2,
        createdAt: 'created',
        updatedAt: 'updated',
        content: { type: 'new_benchmark' }
    });
});
