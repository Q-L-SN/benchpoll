import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { request } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { normalizeRankingResume } from '../public/js/shared/ranking-resume.js';

const source = await readFile(process.env.RANKING_DISCONNECT_BASELINE
    ? resolve(process.env.RANKING_DISCONNECT_BASELINE, 'server.js') : new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf("API.post('/get_weighted_workspace'");
const end = source.indexOf("API.post('/get_ranking_page'", start);
assert.ok(start > 0 && end > start);
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

for (const repetition of [1, 2]) for (const phase of ['identity', 'workspace', 'access', 'normal']) {
    test(`real HTTP ${phase} lifetime avoids snapshots after disconnection (${repetition})`, { timeout: 10000 }, async () => {
        const blocked = deferred(), entered = deferred(), finished = deferred(), closed = deferred();
        const calls = { identity: 0, builds: 0, access: 0, snapshots: 0, json: 0 };
        let handler, server, client, seenResponse;
        const workspace = { context: { categoryID: 1, isPrivate: false }, benchmarks: [], exact: ['same', -2, null] };
        const context = vm.createContext({ API: { post(path, value) { assert.equal(path, '/get_weighted_workspace'); handler = value; } },
            db: {}, normalizeRankingResume, AbortController, rankingCache: null,
            async activeSessionUserID() { calls.identity++; if (phase === 'identity') { entered.resolve(); await blocked.promise; } return null; },
            async assertTopicAccess(_db, userID, IDs) {
                calls.access++;
                assert.equal(userID, null);
                assert.deepEqual(Array.from(IDs), [1]);
                if (phase === 'access') { entered.resolve(); await blocked.promise; }
            },
            async getRankingWorkspace(_db, options) {
                calls.builds++;
                assert.equal(options.scoreMode, 'range');
                assert.equal(options.userID, null);
                if (phase === 'workspace') { entered.resolve(); await blocked.promise; }
                return workspace;
            },
            rankingPager: { create(value, options) {
                calls.snapshots++;
                assert.equal(value, workspace);
                assert.equal(options.initialMode, 'public');
                return { result: value.exact };
            } } });
        vm.runInContext(source.slice(start, end), context);
        const app = express();
        app.use(express.json());
        app.post('/get_weighted_workspace', (req, res, next) => {
            seenResponse = res;
            res.on('close', closed.resolve);
            const original = res.json;
            res.json = function (...args) { calls.json++; return original.apply(this, args); };
            handler(req, res).then(finished.resolve, error => { finished.reject(error); next(error); });
        });
        try {
            await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
            const body = '{"scoreMode":"range"}';
            const received = deferred();
            client = request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/get_weighted_workspace',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
                let data = '';
                res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
                res.on('end', () => received.resolve({ status: res.statusCode, data }));
            });
            client.on('error', () => {});
            client.end(body);
            if (phase === 'normal') {
                const result = await received.promise;
                await finished.promise;
                assert.equal(result.status, 200);
                assert.deepEqual(JSON.parse(result.data), { result: workspace.exact });
                assert.deepEqual(calls, { identity: 1, builds: 1, access: 1, snapshots: 1, json: 1 });
            } else {
                await entered.promise;
                client.destroy();
                await closed.promise;
                assert.equal(seenResponse.destroyed, true, 'Use actual response-close state, not a synthetic flag');
                blocked.resolve();
                await finished.promise;
                assert.equal(calls.builds, phase === 'identity' ? 0 : 1);
                assert.equal(calls.access, phase === 'access' ? 1 : 0);
                assert.equal(calls.snapshots, 0, 'A disconnected client must not consume snapshot capacity');
                assert.equal(calls.json, 0, 'Do not attempt to serialize or send a closed response');
            }
        } finally {
            blocked.resolve();
            client?.destroy();
            if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        }
    });
}
