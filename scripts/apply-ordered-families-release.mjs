import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { migrateOrderedFamilies, convertWeightedRules } from './migrate-ordered-benchmark-families.mjs';
import { loadPersonalPie } from '../ranking-service.js';

const root = '/home/ubuntu/benchpoll';
const stage = '/home/ubuntu/benchpoll-ordered-families-20261004';
const backup = `/var/backups/benchpoll/ordered-families-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 60000, ...options });
const active = unit => { try { return run('systemctl', ['is-active', unit]).trim() === 'active'; } catch { return false; } };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const config = { socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks', charset: 'utf8mb4' };
if (process.getuid() !== 0 || !process.argv.includes('--apply')) throw new Error('Requires root and explicit --apply');
run('/usr/bin/node', [`${stage}/scripts/prepare-ordered-families-release.mjs`, '--check-live']);
if (active('benchpoll-score-sync.service')) throw new Error('A score sync is running; retry after it completes');
const manifest = JSON.parse(fs.readFileSync(`${stage}/release-manifest.json`, 'utf8'));
const files = manifest.files.filter(file => !file.path.startsWith('test/') && !file.path.startsWith('scripts/frontend/'));
fs.mkdirSync(backup, { mode: 0o700, recursive: true });
for (const file of files) {
    if (file.expected === null) continue;
    const target = `${backup}/files/${file.path}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(`${root}/${file.path}`, target);
}
fs.writeFileSync(`${backup}/release-manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
let db, stopped = false, migrationStarted = false, dumpReady = false;
const timerWasActive = active('benchpoll-score-sync.timer');
async function evidence() {
    const [[scores]] = await db.query(`SELECT COUNT(*) count, SUM(ID) idSum,
        SUM(CRC32(CONCAT_WS(':',ID,benchmark_ID,benchmark_condition_ID,model_ID,raw_score,status,
            source_url,CAST(score_fields AS CHAR),notes))) checksum FROM benchmark_results`);
    const [weights] = await db.query('SELECT * FROM personal_pie_weights ORDER BY pie_ID,benchmark_condition_ID');
    const [pies] = await db.query('SELECT * FROM personal_pies ORDER BY ID');
    return { scores, weights: digest(weights), pies: digest(pies) };
}
try {
    run('systemctl', ['stop', 'benchpoll-score-sync.timer', 'benchpoll']); stopped = true;
    db = await mysql.createConnection(config);
    const [[lock]] = await db.query("SELECT GET_LOCK('benchpoll_ordered_families',30) acquired");
    assert.equal(Number(lock.acquired), 1);
    const [oldRules] = await db.query('SELECT * FROM personal_pie_score_rules');
    const [oldMembers] = await db.query('SELECT * FROM personal_pie_score_rule_components');
    const converted = convertWeightedRules(oldRules, oldMembers);
    const before = await evidence();
    fs.writeFileSync(`${backup}/evidence-before.json`, JSON.stringify(before, null, 2), { mode: 0o600 });
    const descriptor = fs.openSync(`${backup}/affected-tables.sql`, 'wx', 0o600);
    try {
        run('mysqldump', ['--socket=/var/run/mysqld/mysqld.sock', '--user=root', '--single-transaction',
            '--no-tablespaces', '--set-gtid-purged=OFF', '--column-statistics=0', 'benchmarks',
            'schema_migrations', 'personal_pies', 'personal_pie_weights', 'personal_pie_score_rules',
            'personal_pie_score_rule_components'], { stdio: ['ignore', descriptor, 'inherit'] });
    } finally { fs.closeSync(descriptor); }
    assert.ok(fs.statSync(`${backup}/affected-tables.sql`).size > 1000); dumpReady = true;
    migrationStarted = true;
    const migration = await migrateOrderedFamilies(db, { apply: true, backupDirectory: backup });
    assert.deepEqual(await evidence(), before, 'Migration changed score evidence or existing pies');
    for (const rule of converted) {
        const [[pie]] = await db.execute('SELECT user_ID,context_ID FROM personal_pies WHERE ID=?', [rule.pie_ID]);
        const restored = await loadPersonalPie(db, Number(pie.context_ID), pie.user_ID);
        assert.deepEqual(restored.fallbackRules.find(item => item.primaryConditionID === Number(rule.primary_benchmark_condition_ID)).entries, rule.entries);
    }
    const deployed = JSON.parse(run('/usr/bin/node', [`${stage}/scripts/prepare-ordered-families-release.mjs`, '--deploy']));
    await db.query("SELECT RELEASE_LOCK('benchpoll_ordered_families')");
    await db.end(); db = null;
    run('systemctl', ['start', 'benchpoll']);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const html = run('curl', ['--silent', '--fail', '--insecure', '--location', '--max-time', '2', 'https://127.0.0.1:1337/']);
            if (html.includes('ordered-families-20261004')) { ready = true; break; }
        } catch { /* The service can take a moment to bind its port. */ }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready && active('benchpoll'), 'Updated web service did not start');
    if (timerWasActive) run('systemctl', ['start', 'benchpoll-score-sync.timer']);
    const report = { deployed, migration, evidenceUnchanged: true, backup, serviceActive: true };
    fs.writeFileSync(`${backup}/deployment-result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
} catch (error) {
    console.error('Release failed:', error);
    if (stopped) {
        run('systemctl', ['stop', 'benchpoll']);
        if (migrationStarted && dumpReady) {
            if (!db) db = await mysql.createConnection(config);
            await db.query('SET FOREIGN_KEY_CHECKS=0');
            for (const table of ['personal_pie_score_rule_components', 'personal_pie_score_rules',
                'ordered_personal_pie_score_rules', 'legacy_weighted_pie_score_rules', 'benchmark_family_members', 'benchmark_families']) {
                await db.query('DROP TABLE IF EXISTS `' + table + '`');
            }
            await db.query('SET FOREIGN_KEY_CHECKS=1');
            const descriptor = fs.openSync(`${backup}/affected-tables.sql`, 'r');
            try { run('mysql', ['--socket=/var/run/mysqld/mysqld.sock', '--user=root', 'benchmarks'], { stdio: [descriptor, 'inherit', 'inherit'] }); }
            finally { fs.closeSync(descriptor); }
        }
        for (const file of files) {
            if (file.expected !== null) fs.copyFileSync(`${backup}/files/${file.path}`, `${root}/${file.path}`);
            else if (fs.existsSync(`${root}/${file.path}`)) {
                const current = createHash('sha256').update(fs.readFileSync(`${root}/${file.path}`)).digest('hex');
                assert.equal(current, file.sha256, 'Refusing to remove an unexpected file');
                fs.unlinkSync(`${root}/${file.path}`);
            }
        }
        run('systemctl', ['start', 'benchpoll']);
        if (timerWasActive) run('systemctl', ['start', 'benchpoll-score-sync.timer']);
    }
    throw error;
} finally { if (db) await db.end(); }
