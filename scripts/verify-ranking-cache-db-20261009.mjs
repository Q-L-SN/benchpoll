import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

async function verifyOrigin() {
    const assert = (await import('node:assert/strict')).default;
    process.chdir('/home/ubuntu/benchpoll');
    await import('/home/ubuntu/benchpoll/node_modules/dotenv/config.js');
    const database = await import('/home/ubuntu/benchpoll/db.js');
    const { rankingCacheTriggers } = await import('/home/ubuntu/benchpoll/ranking-cache-schema.js');
    database.initPool(process.env.DB_PASSWORD);
    const connection = await database.pool.getConnection();
    let transaction = false;
    try {
        const [triggers] = await connection.query('SHOW TRIGGERS');
        assert.deepEqual(triggers.filter(row => row.Trigger.startsWith('bp_rank_')).map(row => row.Trigger).sort(),
            rankingCacheTriggers.map(row => row.name).sort());
        await connection.query('START TRANSACTION'); transaction = true;
        const [before] = await connection.query('SELECT * FROM ranking_cache_revisions ORDER BY ID FOR UPDATE');
        assert.equal(before.length, 2);
        assert.ok(before.every(row => Number(row.ready) === 1));
        await connection.query('SAVEPOINT cache_probe');
        const [[result]] = await connection.query('SELECT ID FROM benchmark_results ORDER BY ID LIMIT 1');
        const [[category]] = await connection.query('SELECT ID FROM categories ORDER BY ID LIMIT 1');
        await connection.execute('UPDATE benchmark_results SET raw_score = raw_score WHERE ID = ?', [result.ID]);
        const [afterScore] = await connection.query('SELECT * FROM ranking_cache_revisions ORDER BY ID');
        assert.equal(Number(afterScore[0].data_revision), Number(before[0].data_revision) + 1);
        assert.equal(Number(afterScore[1].catalogue_revision), Number(before[1].catalogue_revision));
        await connection.execute('UPDATE categories SET name = name WHERE ID = ?', [category.ID]);
        const [afterCatalogue] = await connection.query('SELECT * FROM ranking_cache_revisions ORDER BY ID');
        assert.equal(Number(afterCatalogue[0].data_revision), Number(afterScore[0].data_revision));
        assert.equal(Number(afterCatalogue[1].catalogue_revision), Number(before[1].catalogue_revision) + 1);
        await connection.query('ROLLBACK TO SAVEPOINT cache_probe');
        const [restored] = await connection.query('SELECT * FROM ranking_cache_revisions ORDER BY ID');
        assert.deepEqual(restored, before);
        await connection.query('ROLLBACK'); transaction = false;
        console.log(JSON.stringify({ passed: true, triggers: rankingCacheTriggers.length,
            ready: true, dataAndCatalogueRevisionsIsolated: true, revisionsRollbackWithBusinessTransaction: true,
            committedBusinessWrites: 0 }));
    } finally {
        if (transaction) await connection.query('ROLLBACK');
        connection.release(); await database.pool.end();
    }
}

const report = JSON.parse(execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', [
    '-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    'ubuntu@18.226.222.18', 'node --input-type=module'
], { input: `await (${verifyOrigin.toString()})();`, encoding: 'utf8', windowsHide: true, timeout: 60000 }));
assert.equal(report.passed, true);
await writeFile('artifacts/performance-20261009/cache-invalidation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
