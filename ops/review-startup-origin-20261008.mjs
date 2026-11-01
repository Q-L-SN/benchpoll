import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { request, Agent } from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const output = process.argv.find(value => value.startsWith('--output='))?.slice(9);
assert.ok(output?.startsWith('/home/ubuntu/'), 'A diagnostic output outside the application is required');
const serviceProperties = () => Object.fromEntries(execFileSync('systemctl', ['show', 'benchpoll.service',
    '--property=MainPID', '--property=ActiveState', '--property=SubState', '--property=MemoryCurrent',
    '--property=CPUUsageNSec', '--property=TasksCurrent'], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.split('=')));
async function runtime() {
    const service = serviceProperties();
    assert.match(service.MainPID, /^[1-9]\d*$/);
    const selected = async (path, names) => Object.fromEntries((await readFile(path, 'utf8')).split('\n')
        .map(line => /^([^:]+):\s*(.*)$/.exec(line)).filter(match => match && names.includes(match[1]))
        .map(match => [match[1], match[2]]));
    return { service, process: await selected(`/proc/${service.MainPID}/status`, ['Name', 'VmRSS', 'VmSwap', 'Threads']),
        memory: await selected('/proc/meminfo', ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']),
        load: os.loadavg(), logicalCPUs: os.cpus().length };
}
async function nginxSettings() {
    for (const path of ['/etc/nginx/sites-enabled/benchpoll', '/etc/nginx/sites-enabled/benchpoll.conf']) {
        try {
            const source = await readFile(path, 'utf8');
            return { path, directives: source.split('\n').map(line => line.trim()).filter(line =>
                /^(gzip(?:_[a-z_]+)?|keepalive(?:_timeout)?|proxy_(?:http_version|connect_timeout|send_timeout|read_timeout))\s/.test(line)) };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { unavailable: true };
}

function fetchPublic(port, path, body, agent) {
    assert.ok([443, 1337].includes(port));
    assert.ok(['/Intelligence', '/js/shared/write-intent.js?v=write-replay-20261008',
        '/js/home-workspace.js?v=review-pagination-20261008', '/api/get_page/Intelligence',
        '/api/get_weighted_workspace'].includes(path));
    return new Promise((resolve, reject) => {
        const start = performance.now(), data = body === undefined ? undefined : JSON.stringify(body);
        const req = request({ hostname: '127.0.0.1', port, servername: 'benchpoll.com', path,
            method: data === undefined ? 'GET' : 'POST', rejectUnauthorized: false, agent,
            signal: AbortSignal.timeout(20000), headers: { Host: 'benchpoll.com', 'Accept-Encoding': 'gzip, br, deflate',
                ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } }, res => {
            const ttfb = performance.now() - start, chunks = [];
            let bytes = 0;
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > 8 * 1024 * 1024) req.destroy(new Error('Diagnostic response size exceeded'));
                else chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
                try {
                    const encoded = Buffer.concat(chunks), encoding = res.headers['content-encoding'];
                    const decoded = encoding === 'gzip' ? gunzipSync(encoded) : encoding === 'br'
                        ? brotliDecompressSync(encoded) : encoding === 'deflate' ? inflateSync(encoded) : encoded;
                    const item = { port, path, status: res.statusCode, ttfbMs: ttfb,
                        totalMs: performance.now() - start, wireBytes: bytes, decodedBytes: decoded.length,
                        encoding: encoding ?? 'identity', cacheControl: res.headers['cache-control'] };
                    let json;
                    if (res.headers['content-type']?.includes('application/json')) json = JSON.parse(decoded.toString('utf8'));
                    resolve({ item, json });
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject); req.end(data);
    });
}

const report = { createdAt: new Date().toISOString(), node: process.version,
    scope: 'Read-only public origin requests through loopback TLS, without sessions, cookies, credentials or database imports. TLS verification is disabled only for 127.0.0.1. No application/data changes.',
    runtimeBefore: await runtime(), nginx: await nginxSettings(), results: [] };
for (const port of [1337, 443]) {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
        const tree = await fetchPublic(port, '/api/get_page/Intelligence', { treeOnly: true }, agent);
        assert.equal(tree.item.status, 200);
        const categoryID = tree.json.currentCategoryID;
        assert.ok(Number.isInteger(Number(categoryID)) && Number(categoryID) > 0);
        report.results.push({ ...tree.item, categoryID });
        for (let repetition = 1; repetition <= 3; repetition++) {
            for (const path of ['/Intelligence', '/js/shared/write-intent.js?v=write-replay-20261008',
                '/js/home-workspace.js?v=review-pagination-20261008', '/api/get_weighted_workspace']) {
                const result = await fetchPublic(port, path, path.startsWith('/api/') ? { categoryID,
                    contextValues: {}, comparison: { mode: 'best', keys: ['model'] }, scoreMode: 'range',
                    initialMode: 'public', benchmarkQuery: '', pinPersonal: false, groupVersions: false } : undefined, agent);
                assert.equal(result.item.status, 200, `${port}${path}`);
                report.results.push({ ...result.item, repetition, publicArrayCounts: result.json
                    ? Object.fromEntries(Object.entries(result.json).filter(([, value]) => Array.isArray(value))
                        .map(([key, value]) => [key, value.length])) : undefined });
                console.log(JSON.stringify({ port, repetition, path, ttfbMs: result.item.ttfbMs,
                    totalMs: result.item.totalMs, wireBytes: result.item.wireBytes }));
            }
        }
    } finally { agent.destroy(); }
}
report.runtimeAfter = await runtime();
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ saved: output, samples: report.results.length,
    service: report.runtimeAfter.service.ActiveState, schemaChanged: false, productionDataChanged: false }));
