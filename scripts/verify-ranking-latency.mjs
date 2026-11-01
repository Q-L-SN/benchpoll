import assert from 'node:assert/strict';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const [output, address = '18.226.222.18', connectionMode = 'new'] = process.argv.slice(2);
assert.ok(output, 'Usage: output.json [origin-ip] [new|keep-alive]');
assert.ok(['new', 'keep-alive'].includes(connectionMode));
const agent = connectionMode === 'keep-alive' ? new https.Agent({ keepAlive: true, maxSockets: 1 }) : false;
const samples = JSON.parse(await readFile(new URL('../artifacts/ranking-speed-20261006/before.json', import.meta.url), 'utf8'));
function post(body) {
    return new Promise((resolve, reject) => {
        const bytes = Buffer.from(JSON.stringify(body));
        const start = performance.now();
        const timings = {};
        const request = https.request({ hostname: 'benchpoll.com', servername: 'benchpoll.com', port: 443,
            path: '/api/get_weighted_workspace', method: 'POST', agent,
            lookup: (_, options, callback) => callback(null, options.all ? [{ address, family: 4 }] : address, 4),
            headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Origin: 'https://benchpoll.com',
                'Accept-Encoding': 'gzip', 'User-Agent': 'BenchPoll read-only ranking verification' } }, response => {
            timings.headersMs = Math.round(performance.now() - start);
            const chunks = [];
            response.on('data', chunk => {
                timings.firstBodyMs ??= Math.round(performance.now() - start);
                chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => {
                try {
                    timings.receivedMs = Math.round(performance.now() - start);
                    const compressed = Buffer.concat(chunks);
                    const data = response.headers['content-encoding'] === 'gzip' ? gunzipSync(compressed) : compressed;
                    const payload = JSON.parse(data);
                    assert.equal(response.statusCode, 200, JSON.stringify(payload));
                    validateWorkspacePayload(payload);
                    resolve({ ms: Math.round(performance.now() - start), compressedBytes: compressed.length,
                        responseBytes: data.length, reusedSocket: request.reusedSocket,
                        ...timings, payload });
                } catch (error) { reject(error); }
            });
        });
        request.on('socket', socket => {
            if (!request.reusedSocket) socket.once('secureConnect', () => {
                timings.tlsMs = Math.round(performance.now() - start);
            });
        });
        request.setTimeout(30000, () => request.destroy(new Error('Ranking request timed out')));
        request.on('error', reject); request.end(bytes);
    });
}
const report = { createdAt: new Date().toISOString(), transport: `HTTPS gzip, ${connectionMode} connections`,
    originIP: address, writes: false, cases: [] };
try {
    for (const size of [10, 100]) for (const scoreMode of ['range', 'available']) for (const repeat of [1, 2, 3]) {
        const entries = samples.conditionIDs.slice(0, size).map(conditionID => ({ conditionID, weightBasisPoints: 10000 / size }));
        const { payload, ...metrics } = await post({ categoryID: samples.categoryID,
            comparison: { mode: 'best', keys: ['model'] }, scoreMode, initialMode: 'personal',
            previewPersonalPie: { entries, fallbackRules: [] } });
        assert.equal(payload.personalPie.entries.length, size);
        assert.ok(payload.modelLeaderboards.personal.length > 0);
        assert.ok(payload.modelLeaderboards.personal.length <= 25);
        assert.equal(payload.authenticated, false);
        report.cases.push({ size, scoreMode, repeat, ...metrics, models: payload.modelLeaderboards.personal.length });
        console.log(JSON.stringify(report.cases.at(-1)));
    }
    report.hundredSlicesUnderEightSeconds = report.cases.filter(item => item.size === 100).every(item => item.ms < 8000);
    report.tenSlicesUnderOnePointSevenSeconds = report.cases.filter(item => item.size === 10).every(item => item.ms < 1700);
    assert.ok(report.hundredSlicesUnderEightSeconds, '100-slice HTTPS requests exceeded eight seconds');
    report.passed = true;
} finally {
    if (agent) agent.destroy();
    await writeFile(output, JSON.stringify(report, null, 2));
}
