import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as immediate } from 'node:timers/promises';
import { request } from 'node:http';
import vm from 'node:vm';
import express from 'express';
import { createDeadlinePool } from '../db-deadlines.js';
import { normalizeRankingResume } from '../public/js/shared/ranking-resume.js';

let ranking;
if (process.env.RANKING_READ_BASELINE) {
    // Keep the recorded service intact; resolve its relative imports to the repo.
    const source = await readFile(resolve(process.env.RANKING_READ_BASELINE, 'ranking-service.js'), 'utf8');
    const absoluteImports = source.replace(/from '(\.\/[^']+)'/g,
        (_all, path) => `from '${pathToFileURL(resolve(path)).href}'`);
    ranking = await import('data:text/javascript;base64,' + Buffer.from(absoluteImports).toString('base64'));
} else ranking = await import('../ranking-service.js');

const budget = 45000;
const serverSource = await readFile(process.env.RANKING_READ_BASELINE
    ? resolve(process.env.RANKING_READ_BASELINE, 'server.js') : new URL('../server.js', import.meta.url), 'utf8');
const routeStart = serverSource.indexOf("API.post('/get_weighted_workspace'");
const routeEnd = serverSource.indexOf("API.post('/get_ranking_page'", routeStart);
assert.ok(routeStart > 0 && routeEnd > routeStart);
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function fixture({ execute, query, commit, acquire } = {}) {
    const events = [];
    const rows = sql => {
        if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) return [[{ ID: 1, parent_ID: null,
            name: 'Intelligence', slug: 'intelligence', public_ID: 1, private_ID: null, is_official: 1, description: 'Compare general intelligence benchmarks.',
            position: 0, owner_user_ID: null, created_by_user_ID: null, creator_name: null, creator_avatar: null }], []];
        if (sql.includes('COUNT(*) AS count FROM categories')) return [[{ count: 1 }], []];
        if (sql.includes('FROM categories') && sql.includes('WHERE parent_ID IS NULL')) return [[{
            ID: 1, parent_ID: null, name: 'Intelligence', slug: 'intelligence', public_ID: 1, private_ID: null, is_official: 1, description: 'Compare general intelligence benchmarks.',
            position: 0, owner_user_ID: null, created_by_user_ID: null, creator_name: null, creator_avatar: null }], []];
        return [[], []];
    };
    const connection = {
        async query(sql, ...args) { events.push(['query', sql]); return query ? query(sql, ...args) : [[], []]; },
        async execute(sql, ...args) { events.push(['execute', sql]); return execute ? execute(sql, ...args) : rows(sql); },
        async commit() { events.push(['commit']); return commit?.(); },
        async rollback() { events.push(['rollback']); },
        release() { events.push(['release']); },
        destroy() { events.push(['destroy']); }
    };
    const db = { async getConnection() { events.push(['acquire']); return acquire ? acquire(connection) : connection; } };
    return { db, connection, events, rows };
}
const isCancellation = error => error.code === 'RANKING_READ_CANCELLED';
const isTimeout = error => error.status === 503 && error.body?.error === 'ranking_read_timeout'
    && error.body.retryable === true && !error.body.outcomeUnknown;
function observe(promise) {
    const result = { settled: false, value: null, error: null };
    result.done = promise.then(value => { result.settled = true; result.value = value; },
        error => { result.settled = true; result.error = error; });
    return result;
}

for (const repetition of [1, 2]) {
    test(`already cancelled read never acquires a lease (${repetition})`, async () => {
        const controller = new AbortController(); controller.abort();
        const { db, events } = fixture();
        const result = observe(ranking.getRankingWorkspace(db, { categoryID: 1, signal: controller.signal }));
        await result.done;
        assert.deepEqual(events, []);
        assert.ok(isCancellation(result.error));
    });

    test(`cancelled queued acquisition releases a late unused lease exactly once (${repetition})`, async () => {
        const work = deferred(), controller = new AbortController();
        const { db, connection, events } = fixture({ acquire: () => work.promise });
        const result = observe(ranking.getRankingWorkspace(db, { categoryID: 1, signal: controller.signal }));
        await flush(); controller.abort(); await flush();
        const stoppedBeforeDriver = result.settled;
        work.resolve(connection); await result.done; await flush();
        assert.equal(stoppedBeforeDriver, true, 'Cancellation must not wait for mysql2 acquisition');
        assert.ok(isCancellation(result.error));
        assert.deepEqual(events, [['acquire'], ['release']]);
    });

    for (const outcome of ['resolve', 'reject']) test(`cancelled query handles late ${outcome} without more SQL (${repetition})`, async () => {
        const work = deferred(), controller = new AbortController();
        const { db, events } = fixture({ execute: () => work.promise });
        const result = observe(ranking.getRankingWorkspace(db, { categoryID: 1, signal: controller.signal }));
        await flush(); assert.equal(events.filter(event => event[0] === 'execute').length, 1);
        controller.abort(); await flush(); const stoppedBeforeDriver = result.settled;
        work[outcome](outcome === 'resolve' ? [[], []] : new Error('late query failure'));
        await result.done; await flush();
        assert.equal(stoppedBeforeDriver, true, 'Discard and finish without waiting for an old driver');
        assert.ok(isCancellation(result.error));
        assert.equal(events.filter(event => event[0] === 'destroy').length, 1);
        assert.equal(events.filter(event => ['release', 'rollback', 'commit'].includes(event[0])).length, 0);
        assert.equal(events.filter(event => event[0] === 'execute').length, 1);
    });

    test(`total read deadline ends a stuck query with retryable read semantics (${repetition})`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const work = deferred(), { db, events } = fixture({ execute: () => work.promise });
        const result = observe(ranking.getRankingWorkspace(db, { categoryID: 1 }));
        await flush(); t.mock.timers.tick(budget); await flush();
        const stoppedBeforeDriver = result.settled;
        work.resolve([[], []]); await result.done; await flush();
        assert.equal(stoppedBeforeDriver, true);
        assert.ok(isTimeout(result.error));
        assert.equal(events.filter(event => event[0] === 'destroy').length, 1);
        assert.equal(events.filter(event => ['release', 'rollback', 'commit'].includes(event[0])).length, 0);
    });

    test(`consecutive individually bounded queries still obey a single total budget (${repetition})`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let delayed = 0;
        const { db, events, rows } = fixture({ execute: sql => {
            if (delayed++ < 2) return new Promise(resolve => setTimeout(() => resolve(rows(sql)), 25000));
            return rows(sql);
        } });
        const pool = createDeadlinePool(db, { acquireTimeoutMs: 5000, queryTimeoutMs: 30000 });
        const result = observe(ranking.getRankingWorkspace(pool, { categoryID: 1 }));
        await flush(); t.mock.timers.tick(25000); await flush();
        assert.equal(events.filter(event => event[0] === 'execute').length, 2);
        t.mock.timers.tick(20000); await flush(); const stoppedAtBudget = result.settled;
        t.mock.timers.tick(5000); await flush(); await result.done;
        assert.equal(stoppedAtBudget, true, 'Per-query deadlines alone are not an overall read budget');
        assert.ok(isTimeout(result.error));
        assert.equal(events.filter(event => event[0] === 'destroy').length, 1);
        assert.equal(events.filter(event => event[0] === 'execute').length, 2);
    });

    test(`completed actual workspace remains unchanged and a late abort cannot destroy its reused lease (${repetition})`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const controller = new AbortController(), { db, events } = fixture();
        const workspace = await ranking.getRankingWorkspace(db, { categoryID: 1, signal: controller.signal });
        assert.equal(workspace.context.categoryPath, '1');
        assert.equal(workspace.authenticated, false);
        assert.deepEqual(workspace.personalPie.entries, []);
        assert.deepEqual(workspace.modelLeaderboards, { personal: [], public: [] });
        assert.deepEqual(events.slice(-2), [['commit'], ['release']]);
        const before = structuredClone(events);
        controller.abort(); t.mock.timers.tick(90000); await flush();
        assert.deepEqual(events, before);
    });

    for (const phase of ['snapshot SET', 'snapshot START', 'commit']) {
        test(`cancelled ${phase} never continues its transaction (${repetition})`, async () => {
            const work = deferred(), controller = new AbortController();
            const { db, events } = fixture({
                query: sql => (phase === 'snapshot SET' && sql.startsWith('SET'))
                    || (phase === 'snapshot START' && sql.startsWith('START')) ? work.promise : [[], []],
                commit: () => phase === 'commit' ? work.promise : undefined
            });
            const result = observe(ranking.getRankingWorkspace(db, { categoryID: 1, signal: controller.signal }));
            await flush(); controller.abort(); await flush(); const stopped = result.settled;
            const before = structuredClone(events);
            work.resolve([[], []]); await result.done; await flush();
            assert.equal(stopped, true);
            assert.ok(isCancellation(result.error));
            assert.equal(events.filter(event => event[0] === 'destroy').length, 1);
            assert.deepEqual(events, before, 'No late transaction acknowledgement may start more work');
        });
    }

    test(`expired acquisition releases its late unused lease without starting a transaction (${repetition})`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const work = deferred(), { db, connection, events } = fixture({ acquire: () => work.promise });
        const result = observe(ranking.getRankingWorkspace(db, { categoryID: 1 }));
        await flush(); t.mock.timers.tick(budget); await flush(); const stopped = result.settled;
        work.resolve(connection); await result.done; await flush();
        assert.equal(stopped, true);
        assert.ok(isTimeout(result.error));
        assert.deepEqual(events, [['acquire'], ['release']]);
    });

    test(`monotonic deadline rejects overdue work before the timer callback gets a turn (${repetition})`, async t => {
        let elapsed = 0;
        t.mock.method(performance, 'now', () => elapsed);
        const data = fixture({ execute: sql => { elapsed += 25000; return data.rows(sql); } });
        const result = observe(ranking.getRankingWorkspace(data.db, { categoryID: 1 }));
        await result.done;
        assert.ok(isTimeout(result.error));
        assert.equal(data.events.filter(event => event[0] === 'execute').length, 2);
        assert.equal(data.events.filter(event => event[0] === 'destroy').length, 1);
    });

    test(`ordinary driver rejection preserves identity and cleans up its read transaction (${repetition})`, async () => {
        const failure = new Error('ordinary read failure'), controller = new AbortController();
        const { db, events } = fixture({ execute() { throw failure; } });
        await assert.rejects(ranking.getRankingWorkspace(db, { categoryID: 1, signal: controller.signal }), error => error === failure);
        assert.deepEqual(events.slice(-2), [['rollback'], ['release']]);
        const before = structuredClone(events); controller.abort(); await immediate();
        assert.deepEqual(events, before);
    });

    test(`abort triggered while returning a raw lease cannot destroy a new borrower (${repetition})`, async () => {
        const controller = new AbortController(), { db, connection, events } = fixture();
        connection.release = () => { events.push(['release']); controller.abort(); };
        const result = observe(ranking.getRankingWorkspace(db, { categoryID: 1, signal: controller.signal }));
        await result.done; await flush();
        assert.equal(events.filter(event => event[0] === 'release').length, 1);
        assert.equal(events.filter(event => event[0] === 'destroy').length, 0);
    });

    for (const phase of ['normal', 'disconnect', 'deadline']) {
        test(`actual HTTP and actual service ${phase} read lifetime (${repetition})`, { timeout: 10000 }, async t => {
            if (phase === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
            const work = deferred(), entered = deferred(), closed = deferred(), received = deferred();
            let blockingSQL, first = true, handler, finished, server, client, seenRequest, seenResponse, baselineListeners;
            let snapshots = 0;
            const data = fixture({ execute: sql => {
                if (phase !== 'normal' && first) { first = false; blockingSQL = sql; entered.resolve(); return work.promise; }
                return data.rows(sql);
            } });
            const context = vm.createContext({ API: { post(_path, value) { handler = value; } }, db: data.db,
                AbortController, normalizeRankingResume, getRankingWorkspace: ranking.getRankingWorkspace, rankingCache: null,
                activeSessionUserID: async () => null,
                async assertTopicAccess(_db, userID, IDs) { assert.equal(userID, null); assert.deepEqual(Array.from(IDs), [1]); },
                rankingPager: { create(workspace) { snapshots++; return { context: workspace.context.categoryPath }; } } });
            vm.runInContext(serverSource.slice(routeStart, routeEnd), context);
            const app = express(); app.use(express.json());
            app.post('/get_weighted_workspace', (req, res) => {
                seenRequest = req; seenResponse = res; res.on('close', closed.resolve);
                baselineListeners = { aborted: req.listenerCount('aborted'), close: res.listenerCount('close') };
                finished = observe(handler(req, res));
                finished.done.then(() => {
                    if (finished.error && !res.destroyed) res.status(finished.error.status ?? 500).json(finished.error.body ?? {});
                });
            });
            try {
                await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
                const body = '{"categoryID":1,"scoreMode":"range"}';
                client = request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/get_weighted_workspace',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
                    let data = ''; res.setEncoding('utf8'); res.on('data', value => { data += value; });
                    res.on('end', () => received.resolve({ status: res.statusCode, body: JSON.parse(data) }));
                });
                client.on('error', () => {}); client.end(body);
                if (phase === 'normal') {
                    assert.deepEqual(await received.promise, { status: 200, body: { context: '1' } });
                    await finished.done;
                    assert.equal(snapshots, 1);
                    assert.deepEqual(data.events.slice(-2), [['commit'], ['release']]);
                } else {
                    await entered.promise;
                    if (phase === 'disconnect') { client.destroy(); await closed.promise; }
                    else t.mock.timers.tick(budget);
                    await immediate(); await flush(); const stopped = finished.settled;
                    work.resolve(data.rows(blockingSQL)); await finished.done; await flush();
                    assert.equal(stopped, true, 'The actual route must terminate before a late SQL reply');
                    assert.equal(snapshots, 0);
                    assert.equal(data.events.filter(event => event[0] === 'destroy').length, 1);
                    assert.equal(data.events.filter(event => event[0] === 'execute').length, 1);
                    if (phase === 'deadline') {
                        const result = await received.promise;
                        assert.equal(result.status, 503);
                        assert.equal(result.body.error, 'ranking_read_timeout');
                        assert.equal(result.body.retryable, true);
                        assert.ok(!result.body.outcomeUnknown);
                    }
                }
                assert.equal(seenRequest.listenerCount('aborted'), baselineListeners.aborted);
                assert.ok(seenResponse.listenerCount('close') <= baselineListeners.close,
                    'The route must not retain a cancellation listener after completion');
            } finally {
                work.resolve(data.rows(blockingSQL ?? ''));
                client?.destroy();
                if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
            }
        });
    }
}

test('service cancellation settles with real event-loop turns through a fake driver', async () => {
    // This control verifies microtask finalization independently of mocked clocks.
    const controller = new AbortController(), work = deferred();
    const { db, events } = fixture({ execute: () => work.promise });
    const result = observe(ranking.getRankingWorkspace(db, { categoryID: 1, signal: controller.signal }));
    await immediate(); controller.abort(); await immediate();
    const stopped = result.settled;
    work.resolve([[], []]); await result.done;
    assert.equal(stopped, true);
    assert.equal(events.filter(event => event[0] === 'destroy').length, 1);
});
