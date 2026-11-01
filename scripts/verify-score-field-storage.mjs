import 'dotenv/config';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { applyFieldContribution, loadScoreFieldCatalog, normalizeFieldContribution, resolveScoreFields } from '../score-field-service.js';
import { loadModels } from '../ranking-service.js';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';

const database = process.env.BENCHPOLL_DB_NAME;
if (!database?.endsWith('_score_fields_rehearsal')) throw Error('Storage verification requires the isolated rehearsal database');
const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET,
    user: process.env.BENCHPOLL_DB_USER, password: process.env.BENCHPOLL_DB_PASSWORD, database });
await db.beginTransaction();
try {
    const definition = { name: 'Rehearsal harness', type: 'enum', allowEmpty: true, excludeMissing: true,
        excludeEmpty: true, options: [{ label: 'A', excluded: false }, { label: 'Unknown', excluded: true }] };
    await applyFieldContribution(db, normalizeFieldContribution({ type: 'score_field', operation: 'create', definition, notes: '' }), { moderationLogID: null });
    let fields = await loadScoreFieldCatalog(db);
    const field = fields.find(item => item.name === definition.name);
    const option = field.options.find(item => item.label === 'A');
    const assignments = [{ fieldID: field.ID, value: option.ID }];
    assert.deepEqual(await resolveScoreFields(db, assignments, null, { apply: true }), assignments);
    await applyFieldContribution(db, normalizeFieldContribution({ type: 'score_field_option', operation: 'update',
        targetID: option.ID, revision: option.revision, fieldID: field.ID, label: 'Renamed A', excluded: false, notes: '' }), {});
    fields = await loadScoreFieldCatalog(db);
    assert.equal(fields.find(item => item.ID === field.ID).options.find(item => item.ID === option.ID).label, 'Renamed A');
    const [rows] = await db.execute("SELECT ID FROM benchmark_results WHERE status = 'accepted' ORDER BY ID LIMIT 1");
    assert.ok(rows.length);
    await db.execute('UPDATE benchmark_results SET score_fields = ? WHERE ID = ?', [JSON.stringify(assignments), rows[0].ID]);
    const models = await loadModels(db, fields);
    const options = comparisonOptions(models, { mode: 'best', keys: [], filters: [{ key: `field:${field.ID}`, operator: 'eq', value: option.ID }] }, fields);
    const selected = groupComparisonModels(models, options, []);
    assert.equal(selected.length, 1);
    assert.ok(selected[0].results.size > 0);
    await assert.rejects(applyFieldContribution(db, normalizeFieldContribution({ type: 'score_field_option', operation: 'delete',
        targetID: option.ID, revision: option.revision + 1, fieldID: field.ID, label: 'Renamed A', excluded: false, notes: 'Delete' }), {}),
    error => error.body.error === 'field_still_used_by_scores');
    console.log(JSON.stringify({ storageVerified: true, stableOptionIdentity: true, valueFilteredModels: selected.length, scoreReferencesProtected: true }));
} finally { await db.rollback(); await db.end(); }
