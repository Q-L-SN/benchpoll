import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

async function verifyOrigin(conditionIDs) {
    const assert = (await import('node:assert/strict')).default;
    const https = await import('node:https');
    const { gunzipSync } = await import('node:zlib');
    function post(body) {
        return new Promise((resolve, reject) => {
            const start = performance.now(), bytes = Buffer.from(JSON.stringify(body));
            const request = https.request({ hostname: 'benchpoll.com', servername: 'benchpoll.com', port: 443,
                lookup: (_, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4),
                path: '/api/get_weighted_workspace', method: 'POST', agent: false,
                headers: { Origin: 'https://benchpoll.com', 'Content-Type': 'application/json',
                    'Content-Length': bytes.length, 'Accept-Encoding': 'gzip' } }, response => {
                const headersMs = Math.round(performance.now() - start), chunks = [];
                response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
                response.on('end', () => {
                    try {
                        const bytes = Buffer.concat(chunks);
                        const payload = JSON.parse(response.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes);
                        assert.equal(response.statusCode, 200, payload.error);
                        resolve({ ms: Math.round(performance.now() - start), headersMs, compressedBytes: bytes.length, payload });
                    } catch (error) { reject(error); }
                });
            });
            request.setTimeout(30000, () => request.destroy(new Error('Origin ranking request timed out')));
            request.on('error', reject); request.end(bytes);
        });
    }
    const report = { createdAt: new Date().toISOString(), committedBusinessWrites: 0,
        transport: 'Complete loopback HTTPS request through production Nginx, fresh TLS, gzip', cases: [] };
    for (const size of [10, 100]) for (const scoreMode of ['range', 'available']) for (const repeat of [1, 2, 3]) {
        const { payload, ...metrics } = await post({ comparison: { mode: 'best', keys: ['model'] }, scoreMode,
            initialMode: 'personal', previewPersonalPie: { entries: conditionIDs.slice(0, size)
                .map(conditionID => ({ conditionID, weightBasisPoints: 10000 / size })), fallbackRules: [] } });
        assert.equal(payload.authenticated, false);
        assert.equal(payload.personalPie.entries.length, size);
        assert.ok(payload.modelLeaderboards.personal.length > 0 && payload.modelLeaderboards.personal.length <= 25);
        assert.equal(payload.personalPie.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        report.cases.push({ size, scoreMode, repeat, ...metrics });
    }
    report.passed = true; console.log(JSON.stringify(report));
}

const baseline = JSON.parse(await readFile('artifacts/performance-20261009/before-origin.json', 'utf8'));
const report = JSON.parse(execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', [
    '-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    'ubuntu@18.226.222.18', 'node --input-type=module'
], { input: `await (${verifyOrigin.toString()})(${JSON.stringify(baseline.conditionIDs)});`, encoding: 'utf8',
    windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024 }));
assert.equal(report.passed, true);
await writeFile('artifacts/performance-20261009/after-api.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
