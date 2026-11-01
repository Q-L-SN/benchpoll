import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import vm from 'node:vm';
import mysql from 'mysql2/promise';
import { assertPrimaryCondition } from '../benchmark-primary-condition.js';
import { selectableBenchmarkConditionSQL } from '../benchmark-condition-visibility.js';
import { normalizeScoreFieldRequests, normalizeFieldContribution } from '../score-field-service.js';
import { normalizeModelParameters, modelParameterLabel, parameterRowsToObject } from '../public/js/shared/model-parameters.js';

const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks' });
const baselinePath = '/var/backups/benchpoll/primary-condition-integrity-20261002.json';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function integrity() {
    const [[scores]] = await db.query(`SELECT COUNT(*) count, SUM(ID) idSum,
        SUM(CRC32(CONCAT_WS(':',ID,benchmark_ID,benchmark_condition_ID,model_ID,raw_score,status,
            source_url,CAST(score_fields AS CHAR),notes))) checksum FROM benchmark_results`);
    const [[conditions]] = await db.query('SELECT COUNT(*) count, SUM(ID) idSum FROM benchmark_conditions');
    const [[benchmarks]] = await db.query('SELECT COUNT(*) count, SUM(ID) idSum FROM benchmarks');
    const pies = {};
    for (const table of ['personal_pies', 'personal_pie_weights', 'personal_pie_score_rules', 'personal_pie_score_rule_components']) {
        const [rows] = await db.query(`SELECT * FROM ${table} ORDER BY 1,2`);
        pies[table] = { count: rows.length, sha256: digest(rows) };
    }
    return { scores, conditions, benchmarks, pies };
}

try {
    if (process.argv.includes('--baseline')) {
        const baseline = await integrity();
        await writeFile(baselinePath, JSON.stringify(baseline, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ baselinePath, ...baseline }));
    } else {
        const before = JSON.parse(await readFile(baselinePath, 'utf8'));
        assert.deepEqual(await integrity(), before);
        const [[invalid]] = await db.query(`SELECT COUNT(*) count FROM (
            SELECT b.ID FROM benchmarks b LEFT JOIN benchmark_conditions c ON c.benchmark_ID=b.ID AND c.deleted_at IS NULL
            GROUP BY b.ID HAVING SUM(COALESCE(c.is_primary,0)) <> 1
        ) invalid`);
        assert.equal(Number(invalid.count), 0);
        const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
        const between = (start, end) => {
            const first = source.indexOf(start), last = source.indexOf(end, first);
            assert.ok(first >= 0 && last > first);
            return source.slice(first, last);
        };
        const sandbox = vm.createContext({ assertPrimaryCondition, selectableBenchmarkConditionSQL, URL, crypto, structuredClone,
            normalizeScoreFieldRequests, normalizeFieldContribution, normalizeModelParameters, modelParameterLabel, parameterRowsToObject });
        vm.runInContext([
            between('function normalizeString(', 'function parseModerationContent('),
            between('function canonicalChangeValue(', 'function entityChildSetChanges('),
            between('function entityChangeLockClause(', 'async function loadModelChangeTarget('),
            between('function entityChildSetChanges(', 'function validateEditedContributionClientRefs('),
            between('async function insertSubmittedBenchmarkCondition(', 'async function applyModelBatch('),
            between('function assertEntityChangeIsCurrent(', 'async function applyModelChange('),
            '\nthis.api = { buildContributionContent, normalizeStoredModerationContent, loadBenchmarkChangeTarget, applyBenchmarkBatch, applyBenchmarkChange };'
        ].join('\n'), sandbox);
        const [logs] = await db.query(`SELECT ID,status,content FROM moderation_logs
            WHERE JSON_UNQUOTE(JSON_EXTRACT(content,'$.type')) = 'new_benchmark'
               OR (JSON_UNQUOTE(JSON_EXTRACT(content,'$.type')) = 'entity_change'
                   AND JSON_UNQUOTE(JSON_EXTRACT(content,'$.targetKind')) = 'benchmark')`);
        const historicalContentIssues = [];
        let primarySnapshotsValidated = 0;
        for (const log of logs) {
            const content = typeof log.content === 'string' ? JSON.parse(log.content) : log.content;
            if (content.type === 'new_benchmark') {
                for (const benchmark of content.benchmarks) {
                    assertPrimaryCondition(benchmark.conditions, {
                        appended: benchmark.existingBenchmarkID !== null || benchmark.existingBenchmarkRef !== null
                    });
                    primarySnapshotsValidated += 1;
                }
            } else {
                for (const state of [content.before, ...(content.after ? [content.after] : [])]) {
                    assertPrimaryCondition(state.conditions);
                    primarySnapshotsValidated += 1;
                }
            }
            try {
                sandbox.api.normalizeStoredModerationContent(content);
            } catch (error) {
                // Completed audit snapshots are not replayed as new submissions.
                if (log.status === 'pending') throw error;
                historicalContentIssues.push({ ID: log.ID, status: log.status, error: error.body?.error ?? error.message });
            }
        }
        const [[largest]] = await db.query(`SELECT benchmark_ID,COUNT(*) count FROM benchmark_conditions
            WHERE deleted_at IS NULL GROUP BY benchmark_ID ORDER BY count DESC,benchmark_ID LIMIT 1`);
        const largeForm = await sandbox.api.loadBenchmarkChangeTarget(db, Number(largest.benchmark_ID));
        const largeRequest = sandbox.api.buildContributionContent({ type: 'entity_change', targetKind: 'benchmark',
            targetID: Number(largest.benchmark_ID), operation: 'update', reviewNotes: '', proposed: {
                ...largeForm, conditions: largeForm.conditions.map((condition, index) => ({ ...condition,
                    isPrimary: index === largeForm.conditions.length - 1 }))
            } });
        assert.equal(largeRequest.after.conditions.length, Number(largest.count));
        assert.deepEqual(largeRequest.after.conditions.map(condition => condition.ID), largeForm.conditions.map(condition => condition.ID));
        await db.beginTransaction();
        try {
            const [largeKeysBefore] = await db.execute('SELECT ID,condition_key FROM benchmark_conditions WHERE benchmark_ID=? ORDER BY ID', [Number(largest.benchmark_ID)]);
            await sandbox.api.applyBenchmarkChange(db, { ...largeRequest, before: largeForm });
            const [largeKeysAfter] = await db.execute('SELECT ID,condition_key FROM benchmark_conditions WHERE benchmark_ID=? ORDER BY ID', [Number(largest.benchmark_ID)]);
            assert.deepEqual(largeKeysAfter, largeKeysBefore);
            const largeChangedForm = await sandbox.api.loadBenchmarkChangeTarget(db, Number(largest.benchmark_ID));
            assert.equal(largeChangedForm.conditions.find(condition => condition.isPrimary).ID, largeForm.conditions.at(-1).ID);
            const condition = (name, isPrimary) => ({ clientRef: name, name, scoreDirection: 'higher', targetValue: null,
                usesPercentageScale: true, scoreMin: null, scoreMax: null, isDefault: name === 'default', isPrimary });
            const name = 'primary-condition-transaction-' + Date.now();
            const content = sandbox.api.buildContributionContent({ type: 'new_benchmark', benchmarks: [{ clientRef: 'benchmark',
                name, existingBenchmarkID: null, existingBenchmarkRef: null, tags: [], introductionURL: '', reviewerNotes: '',
                conditions: [condition('default', false), condition('overall', true)] }] });
            await sandbox.api.applyBenchmarkBatch(db, content);
            const [[benchmark]] = await db.execute('SELECT ID FROM benchmarks WHERE name = ?', [name]);
            let form = await sandbox.api.loadBenchmarkChangeTarget(db, benchmark.ID);
            const primaryID = Number(form.conditions.find(row => row.isPrimary).ID);
            const defaultID = Number(form.conditions.find(row => !row.isPrimary).ID);
            const originalIDs = form.conditions.map(row => row.ID).sort((a, b) => a - b);
            const change = async proposed => {
                const request = sandbox.api.buildContributionContent({ type: 'entity_change', targetKind: 'benchmark',
                    targetID: benchmark.ID, operation: 'update', reviewNotes: '', proposed });
                await sandbox.api.applyBenchmarkChange(db, { ...request, before: form });
                form = await sandbox.api.loadBenchmarkChangeTarget(db, benchmark.ID);
            };
            await change({ ...form, conditions: form.conditions.map(row => ({ ...row, isPrimary: row.ID === defaultID })) });
            assert.equal(form.conditions.find(row => row.isPrimary).ID, defaultID);
            assert.deepEqual(form.conditions.map(row => row.ID).sort((a,b) => a-b), originalIDs);
            await change({ ...form, conditions: form.conditions.map(row => row.ID === primaryID ? { ...row, name: 'renamed overall' } : row) });
            assert.equal(form.conditions.find(row => row.ID === primaryID).name, 'renamed overall');
            await change({ ...form, conditions: form.conditions.filter(row => row.ID !== defaultID).map(row => ({ ...row, isPrimary: true })) });
            assert.equal(form.conditions.length, 1);
            assert.equal(form.conditions[0].ID, primaryID);
            assert.equal(form.conditions[0].isPrimary, true);
            await assert.rejects(db.execute('INSERT INTO benchmark_conditions (benchmark_ID,condition_key,name,score_direction,uses_percentage_scale,is_primary) VALUES (?,?,?,\'higher\',1,1)',
                [benchmark.ID, 'duplicate-primary', 'duplicate-primary']), error => error.code === 'ER_DUP_ENTRY');
        } finally { await db.rollback(); }
        assert.deepEqual(await integrity(), before);
        console.log(JSON.stringify({ intact: true, benchmarks: before.benchmarks.count, conditions: before.conditions.count,
            scores: before.scores.count, primarySnapshotsValidated,
            currentContractLogsValidated: logs.length - historicalContentIssues.length,
            historicalContentIssues, largestEditableFamily: Number(largest.count),
            primarySwitchRenameDelete: true, duplicatePrimaryRejected: true }));
    }
} finally { await db.end(); }
