import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { migrateOrderedFamilies, convertWeightedRules } from './migrate-ordered-benchmark-families.mjs';
import { ensureBenchmarkFamily, loadBenchmarkFamilies } from '../benchmark-family-service.js';
import { getRankingWorkspace, loadPersonalPie, savePersonalPie } from '../ranking-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const config = { socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', charset: 'utf8mb4' };
const db = await mysql.createConnection({ ...config, database: 'benchmarks' });
const rehearsal = 'benchpoll_family_rehearsal_' + Date.now();
const requiredTables = new Set(['benchmark_results', 'benchmark_conditions', 'benchmarks', 'models', 'organizations',
    'categories', 'ranking_contexts', 'ranking_dimensions', 'ranking_dimension_options', 'users',
    'personal_pies', 'personal_pie_weights', 'personal_pie_score_rules', 'personal_pie_score_rule_components',
    'score_fields', 'score_field_options', 'benchmark_tags', 'benchmark_tag_links', 'schema_migrations']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let created = false, pool;
async function evidence() {
    const [[scores]] = await db.query(`SELECT COUNT(*) count, SUM(ID) idSum,
        SUM(CRC32(CONCAT_WS(':',ID,benchmark_ID,benchmark_condition_ID,model_ID,raw_score,status,
            source_url,CAST(score_fields AS CHAR),notes))) checksum FROM benchmark_results`);
    const [weights] = await db.query('SELECT * FROM personal_pie_weights ORDER BY pie_ID,benchmark_condition_ID');
    return { scores, weights: digest(weights), weightValues: digest(weights.map(row => ({
        pieID: row.pie_ID, conditionID: row.benchmark_condition_ID, weight: row.weight_basis_points
    }))) };
}
try {
    await db.query('CREATE DATABASE `' + rehearsal + '`'); created = true;
    console.log(JSON.stringify({ stage: 'cloning', database: rehearsal }));
    const [tables] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='benchmarks' AND TABLE_TYPE='BASE TABLE'");
    for (const { TABLE_NAME: table } of tables) {
        if (!/^[a-zA-Z0-9_]+$/.test(table)) throw Error('Unsafe table name');
        await db.query(`CREATE TABLE ${rehearsal}.\`${table}\` LIKE benchmarks.\`${table}\``);
        if (!requiredTables.has(table)) continue;
        const [columns] = await db.query(`SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema='benchmarks'
            AND table_name=? AND GENERATION_EXPRESSION='' ORDER BY ORDINAL_POSITION`, [table]);
        const names = columns.map(column => '`' + column.COLUMN_NAME + '`').join(',');
        await db.query(`INSERT INTO ${rehearsal}.\`${table}\` (${names}) SELECT ${names} FROM benchmarks.\`${table}\``);
        console.log(JSON.stringify({ stage: 'copied', table }));
    }
    await db.query('USE `' + rehearsal + '`');
    const before = await evidence();
    const [oldRules] = await db.query('SELECT * FROM personal_pie_score_rules');
    const [oldMembers] = await db.query('SELECT * FROM personal_pie_score_rule_components');
    const converted = convertWeightedRules(oldRules, oldMembers);
    const migration = await migrateOrderedFamilies(db, { apply: true, backupDirectory: '/var/backups/benchpoll/' + rehearsal });
    console.log(JSON.stringify({ stage: 'migrated', migration }));
    assert.deepEqual(await evidence(), before, 'Migration must not change weights or scores');
    assert.equal((await migrateOrderedFamilies(db)).alreadyApplied, true);
    for (const original of converted) {
        const [[pie]] = await db.execute('SELECT user_ID,context_ID FROM personal_pies WHERE ID=?', [original.pie_ID]);
        const loaded = await loadPersonalPie(db, Number(pie.context_ID), pie.user_ID);
        const restored = loaded.fallbackRules.find(rule => rule.primaryConditionID === Number(original.primary_benchmark_condition_ID));
        assert.deepEqual(restored.entries, original.entries);
    }
    const [[context]] = await db.query(`SELECT rc.*, p.user_ID, p.revision, p.ID AS pie_ID
        FROM personal_pies p JOIN ranking_contexts rc ON rc.ID=p.context_ID LIMIT 1`);
    assert.ok(context, 'This rehearsal expects at least one saved production pie');
    pool = mysql.createPool({ ...config, database: rehearsal, connectionLimit: 3 });
    const current = await loadPersonalPie(db, Number(context.ID), context.user_ID);
    const [conditions] = await db.query(`SELECT c.ID FROM benchmark_conditions c JOIN benchmarks b ON b.ID=c.benchmark_ID
        WHERE c.deleted_at IS NULL AND b.is_active=1 ORDER BY c.ID LIMIT 1100`);
    const primary = current.entries[0].conditionID;
    const alternatives = conditions.map(row => Number(row.ID)).filter(ID => ID !== primary);
    assert.ok(alternatives.length >= 2);
    const entries = alternatives.slice(0, 2).map(conditionID => ({ conditionID }));
    const settings = { categoryID: Number(context.category_ID), contextValues: typeof context.context_values === 'string'
        ? JSON.parse(context.context_values) : context.context_values, userID: context.user_ID };
    const report = [];
    for (const scoreMode of ['range', 'available']) {
        const workspace = await getRankingWorkspace(pool, { ...settings, scoreMode });
        validateWorkspacePayload(createRankingPager().create(workspace, { userID: settings.userID }));
        report.push({ scoreMode, personalModels: workspace.modelLeaderboards.personal.length, publicModels: workspace.modelLeaderboards.public.length });
    }
    await savePersonalPie(pool, { ...settings, expectedRevision: current.revision, entries: current.entries.map(entry => ({
        conditionID: entry.conditionID, weightBasisPoints: entry.weightBasisPoints })), fallbackRules: [
        { primaryConditionID: primary, mode: 'ordered', entries }
    ] });
    const saved = await loadPersonalPie(db, Number(context.ID), context.user_ID);
    assert.deepEqual(saved.fallbackRules[0].entries, entries);
    const sharedID = saved.fallbackRules[0].familyID;
    await db.beginTransaction();
    assert.equal(await ensureBenchmarkFamily(db, primary, entries), sharedID);
    assert.notEqual(await ensureBenchmarkFamily(db, primary, [...entries].reverse()), sharedID);
    await db.commit();
    // Establish an old snapshot before another transaction creates an identical chain.
    const first = await pool.getConnection(), second = await pool.getConnection();
    try {
        await first.beginTransaction(); await second.beginTransaction();
        await first.query('SELECT COUNT(*) FROM benchmark_families');
        await second.query('SELECT COUNT(*) FROM benchmark_families');
        const longChain = alternatives.slice(0, 1000).map(conditionID => ({ conditionID }));
        const ID = await ensureBenchmarkFamily(first, primary, longChain);
        const waiting = ensureBenchmarkFamily(second, primary, longChain);
        await first.commit();
        assert.equal(await waiting, ID);
        await second.commit();
    } finally { await first.rollback(); await second.rollback(); first.release(); second.release(); }
    const catalogue = await loadBenchmarkFamilies(db);
    assert.ok(catalogue.some(family => family.entries.length === 1000));
    await assert.rejects(db.execute('DELETE FROM benchmark_conditions WHERE ID=?', [primary]), error => error.code === 'ER_ROW_IS_REFERENCED_2');
    const after = await evidence();
    assert.deepEqual(after.scores, before.scores);
    assert.equal(after.weightValues, before.weightValues, 'Saving a chain must not change entrance weights');
    console.log(JSON.stringify({ migration, sourceEvidenceUnchanged: true, sharedIdentity: true,
        concurrentReuse: true, unlimitedChain: 1000, saveRoundTrip: true, views: report }));
} finally {
    if (pool) await pool.end();
    await db.query('USE benchmarks');
    if (created && /^benchpoll_family_rehearsal_\d+$/.test(rehearsal)) await db.query('DROP DATABASE `' + rehearsal + '`');
    await db.end();
}
