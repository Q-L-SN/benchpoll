import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const output = resolve('artifacts/performance-20261009');
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const sha = value => createHash('sha256').update(value).digest('hex');

async function profileOrigin(accelerated = false) {
    process.chdir('/home/ubuntu/benchpoll');
    await import('/home/ubuntu/benchpoll/node_modules/dotenv/config.js');
    const database = await import('/home/ubuntu/benchpoll/db.js');
    const ranking = await import('/home/ubuntu/benchpoll/ranking-service.js');
    const rankingCache = accelerated ? (await import('/home/ubuntu/benchpoll/ranking-read-cache.js')).createRankingReadCache() : null;
    const { createRankingPager } = await import('/home/ubuntu/benchpoll/ranking-pagination.js');
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const { Session } = await import('node:inspector');
    const session = new Session(); session.connect();
    const inspect = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params,
        (error, result) => error ? reject(error) : resolve(result)));
    database.initPool(process.env.DB_PASSWORD);
    const pool = database.pool;
    const report = { createdAt: new Date().toISOString(), databaseWrites: 0, cases: [] };
    const queries = [];
    const db = { getConnection: async () => {
        const connection = await pool.getConnection();
        return new Proxy(connection, { get(target, key) {
            const value = target[key];
            if (key === 'query' || key === 'execute') return async (...args) => {
                const started = performance.now();
                try {
                    const result = await value.apply(target, args);
                    queries.push({ sql: args[0].replace(/\s+/g, ' ').trim().slice(0, 250),
                        ms: Math.round(performance.now() - started), rows: Array.isArray(result[0]) ? result[0].length : 0 });
                    return result;
                } catch (error) { error.message = `${args[0].slice(0, 50)}: ${error.message}`; throw error; }
            };
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } };
    try {
        report.sourceHash = createHash('sha256').update(await readFile('ranking-service.js')).digest('hex');
        report.counts = (await pool.query('SELECT COUNT(*) AS results, MAX(ID) AS lastID FROM benchmark_results'))[0][0];
        const connection = await pool.getConnection();
        let conditions;
        try { conditions = await ranking.loadBenchmarkConditions(connection); }
        finally { connection.release(); }
        report.conditionIDs = conditions.sort((a, b) => b.scoredModelCount - a.scoredModelCount || a.conditionID - b.conditionID)
            .slice(0, 100).map(row => row.conditionID);
        if (accelerated) {
            const start = performance.now();
            await ranking.getRankingWorkspace(db, { rankingCache, scoreMode: 'available' });
            report.coldWarmupMs = Math.round(performance.now() - start);
        }
        await inspect('Profiler.enable'); await inspect('Profiler.start');
        for (const size of [0, 10, 100]) for (const scoreMode of ['range', 'available']) for (const repeat of [1, 2]) {
            queries.length = 0;
            const request = { comparison: { mode: 'best', keys: ['model'] }, scoreMode, rankingCache,
                ...(size ? { previewPersonalPie: { entries: report.conditionIDs.slice(0, size)
                    .map(conditionID => ({ conditionID, weightBasisPoints: 10000 / size })), fallbackRules: [] } } : {}) };
            const started = performance.now(), workspace = await ranking.getRankingWorkspace(db, request);
            const computeMs = Math.round(performance.now() - started);
            const pager = createRankingPager().create(workspace, { initialMode: size ? 'personal' : 'public' });
            const serialized = JSON.stringify(pager), totalMs = Math.round(performance.now() - started);
            delete workspace.serverTime;
            report.cases.push({ size, scoreMode, repeat, computeMs, totalMs, responseBytes: Buffer.byteLength(serialized),
                models: workspace.modelLeaderboards[size ? 'personal' : 'public'].length,
                digest: createHash('sha256').update(JSON.stringify(workspace)).digest('hex'), queries: structuredClone(queries) });
        }
        const { profile } = await inspect('Profiler.stop');
        const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame])), cpu = new Map();
        profile.samples.forEach((id, index) => {
            const node = nodes.get(id), key = `${node.functionName} ${node.url}:${node.lineNumber + 1}`;
            cpu.set(key, (cpu.get(key) ?? 0) + profile.timeDeltas[index] / 1000);
        });
        report.cpu = [...cpu].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([functionName, ms]) => ({ functionName, ms: Math.round(ms) }));
        report.memoryMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.log(JSON.stringify(report));
    } finally { session.disconnect(); await pool.end(); }
}

async function inspectOrigin() {
    process.chdir('/home/ubuntu/benchpoll');
    await import('/home/ubuntu/benchpoll/node_modules/dotenv/config.js');
    const mysql = await import('/home/ubuntu/benchpoll/node_modules/mysql2/promise.js');
    const { execFileSync } = await import('node:child_process');
    const connection = await mysql.default.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock',
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks' });
    try {
        const schema = (await connection.query('SHOW CREATE TABLE benchmark_results'))[0];
        const indexes = (await connection.query('SHOW INDEX FROM benchmark_results'))[0];
        const triggers = (await connection.query('SHOW TRIGGERS'))[0].map(row => ({ name: row.Trigger, table: row.Table }));
        const nginx = execFileSync('sudo', ['nginx', '-T'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        console.log(JSON.stringify({ schema, indexes, triggers,
            nginx: nginx.split('\n').filter(line => /configuration file|gzip|listen .*443|root /.test(line)) }));
    } finally { await connection.end(); }
}

await mkdir(output, { recursive: true });
if (process.argv.includes('--capture')) {
    const sourcePaths = ['ranking-service.js', 'model-comparison.js', 'ranking-pagination.js', 'server.js',
        'private/home.html', 'package.json', 'package-lock.json', 'ops/nginx/benchpoll.conf'];
    const files = [];
    for (const path of sourcePaths) {
        const content = await readFile(path), target = join(output, 'before', path);
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
        files.push({ path, sha256: sha(content) });
    }
    await cp('public/js', join(output, 'before/public/js'), { recursive: true });
    await cp('public/css', join(output, 'before/public/css'), { recursive: true });
    await writeFile(join(output, 'baseline-sources.json'), JSON.stringify(files, null, 2));
    console.log(JSON.stringify({ captured: true, files: files.length, publicSourceTrees: 2 }));
} else if (process.argv.includes('--inspect')) {
    const raw = execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', ['-n', ...options, 'ubuntu@18.226.222.18',
        'node --input-type=module -e ' + quote(`await (${inspectOrigin.toString()})();`)],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(join(output, 'origin-inspection.json'), raw); console.log(raw);
} else {
    const name = process.argv.includes('--after') ? 'after-origin.json' : 'before-origin.json';
    const raw = execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', ['-n', ...options, 'ubuntu@18.226.222.18',
        'node --input-type=module -e ' + quote(`await (${profileOrigin.toString()})(${process.argv.includes('--after')});`)],
    { encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    const report = JSON.parse(raw); assert.equal(report.cases.length, 12);
    await writeFile(join(output, name), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: name, counts: report.counts,
        cases: report.cases.map(({ size, scoreMode, repeat, computeMs, totalMs, responseBytes }) =>
            ({ size, scoreMode, repeat, computeMs, totalMs, responseBytes })), cpu: report.cpu.slice(0, 16) }, null, 2));
}
