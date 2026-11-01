import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankingReadCache, cachedRankingRead, cachedRankingCalculation, cloneRankingMetadata, cloneRankingMembersForJSON, deferRankingMetadata, hasRankingReadCache, withRankingReadCache } from '../ranking-read-cache.js';
import { rankingCacheTriggers, RANKING_DATA_TABLES, RANKING_CATALOGUE_TABLES } from '../ranking-cache-schema.js';
import { getRankingWorkspace } from '../ranking-service.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('metadata copies retain values while isolating nested evidence and prototype-shaped JSON keys', () => {
    const metadata = JSON.parse('{"members":[{"condition":{"parameters":{"field:1":"high"}}}],"__proto__":{"unsafe":true}}');
    metadata.timestamp = new Date('2026-10-09T00:00:00Z');
    metadata.empty = undefined;
    const copy = cloneRankingMetadata(metadata);
    assert.deepEqual(copy, structuredClone(metadata));
    assert.equal(Object.getPrototypeOf(copy), Object.prototype);
    assert.equal(copy.unsafe, undefined);
    copy.members[0].condition.parameters['field:1'] = 'low';
    assert.equal(metadata.members[0].condition.parameters['field:1'], 'high');
});

test('identical snapshot reads share one in-flight computation; errors never poison the cache', async () => {
    const cache = createRankingReadCache();
    let calls = 0;
    const load = async () => { calls++; return { value: 42 }; };
    const first = cache.read('same', load), second = cache.read('same', load);
    assert.equal(await first, await second); assert.equal(calls, 1);
    await assert.rejects(cache.read('failure', async () => { throw new Error('failure'); }));
    assert.equal(await cache.read('failure', async () => 12), 12);
});

test('metadata collection copies retain shared references and cycles without exposing cached evidence', () => {
    const evidence = { value: 42 }, timestamp = new Date('2026-10-09T00:00:00Z');
    const original = { evidence, timestamp, sameTimestamp: timestamp, members: new Map(), selected: new Set([evidence]) };
    original.members.set(evidence, original);
    original.members.set('score', evidence);
    const copy = cloneRankingMetadata(original);
    assert.deepEqual(copy, structuredClone(original));
    assert.equal(copy.members.get(copy.evidence), copy);
    assert.equal(copy.members.get('score'), copy.evidence);
    assert.equal(copy.timestamp, copy.sameTimestamp);
    copy.evidence.value = 0;
    copy.members.clear();
    assert.equal(evidence.value, 42);
    assert.equal(original.members.size, 2);
});

test('JSON member metadata omits only score Map copies, retains identical wire data and isolates fields', () => {
    const results = new Map([['1', { normalizedScore: 80, evidenceHash: 'evidence' }]]);
    const members = [{ ID: 1, modelID: 7, condition: { parameters: { 'field:1': 'high' } }, results }];
    const wire = cloneRankingMembersForJSON(members);
    assert.equal(JSON.stringify(wire), JSON.stringify(members));
    assert.deepEqual(wire[0].results, {});
    wire[0].condition.parameters['field:1'] = 'low';
    assert.equal(members[0].condition.parameters['field:1'], 'high');
    assert.equal(results.size, 1);
    assert.deepEqual(cloneRankingMembersForJSON([{ results: { realData: 1 } }]), [{ results: { realData: 1 } }]);
});

test('LRU, age and score-cell capacity bound retained material', async () => {
    let time = 0;
    const cache = createRankingReadCache({ maxEntries: 2, maxCells: 3, maxAgeMs: 10, now: () => time });
    let loads = 0;
    const read = key => cache.read(key, async () => ++loads, () => 2);
    await read('a'); await read('b');
    assert.equal(cache.stats.entries, 1);
    await read('a'); assert.equal(loads, 3);
    time = 11; await read('a'); assert.equal(loads, 4);
    cache.clear(); assert.deepEqual(cache.stats, { entries: 0, cells: 0 });
});

test('data and catalogue revisions are isolated; old snapshot results cannot fill a newer revision', async () => {
    const cache = createRankingReadCache(); let revision = { epoch: 'a', data_revision: '1', catalogue_revision: '1', ready: 1 };
    const connection = { execute: async () => [[{ ...revision }]] }; let calls = 0;
    const read = domain => withRankingReadCache(connection, cache, () => cachedRankingRead(connection, domain, 'test', () => ++calls));
    assert.equal(await read('data'), 1); assert.equal(await read('data'), 1);
    revision.catalogue_revision = '2'; assert.equal(await read('data'), 1); assert.equal(await read('catalogue'), 2);
    revision.data_revision = '2'; assert.equal(await read('data'), 3);
    revision.epoch = 'new-installation'; assert.equal(await read('data'), 4);
    assert.equal(hasRankingReadCache(connection), false);
});

test('a missing or incomplete migration disables the accelerator, not the ranking', async () => {
    const cache = createRankingReadCache(); let calls = 0;
    for (const connection of [{ execute: async () => { throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' }); } },
        { execute: async () => [[{ ready: 0 }]] }]) {
        for (let i = 0; i < 2; i++) await withRankingReadCache(connection, cache,
            () => cachedRankingRead(connection, 'data', 'test', () => ++calls));
    }
    assert.equal(calls, 4);
    await assert.rejects(withRankingReadCache({ execute: async () => { throw new Error('database failure'); } }, cache, () => 1));
});

test('all evidence and eligibility writes invalidate caches, including cascade parents', () => {
    assert.equal(rankingCacheTriggers.length, (RANKING_DATA_TABLES.length + RANKING_CATALOGUE_TABLES.length) * 3);
    assert.equal(new Set(rankingCacheTriggers.map(trigger => trigger.name)).size, rankingCacheTriggers.length);
    for (const table of ['benchmark_results', 'benchmark_conditions', 'benchmarks', 'models', 'score_field_options', 'organizations']) {
        assert.ok(RANKING_DATA_TABLES.includes(table));
    }
    for (const table of ['users', 'personal_pies', 'personal_pie_weights', 'benchmark_families']) assert.ok(RANKING_CATALOGUE_TABLES.includes(table));
    assert.ok(rankingCacheTriggers.every(trigger => /AFTER (INSERT|UPDATE|DELETE).*FOR EACH ROW UPDATE ranking_cache_revisions/s.test(trigger.sql)));
});

test('a cancelled single-flight producer is retried on the surviving reader lease', async () => {
    const cache = createRankingReadCache();
    const revision = { epoch: 'a', data_revision: 1, catalogue_revision: 1, ready: 1 };
    const producer = { execute: async () => [[revision]] }, survivor = { execute: async () => [[revision]] };
    let rejectProducer, loaded = false, cancelled = false;
    const error = Object.assign(new Error('cancelled'), { code: 'RANKING_READ_CANCELLED' });
    const first = withRankingReadCache(producer, cache, () => cachedRankingRead(producer, 'data', 'same',
        () => new Promise((resolve, reject) => { rejectProducer = reject; })), () => { if (cancelled) throw error; });
    const failure = assert.rejects(first, error);
    await new Promise(resolve => setImmediate(resolve));
    const second = withRankingReadCache(survivor, cache, () => cachedRankingRead(survivor, 'data', 'same', () => { loaded = true; return 42; }));
    await new Promise(resolve => setImmediate(resolve));
    cancelled = true; rejectProducer(error);
    assert.equal(await second, 42); assert.equal(loaded, true);
    await failure;
});

for (const code of ['RANKING_READ_CANCELLED', 'RANKING_READ_TIMEOUT']) {
    test(`a surviving reader recovers after consecutive single-flight ${code} producers`, async () => {
        const cache = createRankingReadCache();
        const revision = { epoch: 'consecutive', data_revision: 1, catalogue_revision: 1, ready: 1 };
        const readers = Array.from({ length: 3 }, () => ({
            connection: { execute: async () => [[revision]] }, failure: null, loads: 0
        }));
        const pending = [deferred(), deferred()];
        const outcomes = readers.map((reader, index) => withRankingReadCache(reader.connection, cache,
            () => cachedRankingRead(reader.connection, 'data', 'shared', () => {
                reader.loads++;
                return pending[index]?.promise ?? 42;
            }), () => { if (reader.failure) throw reader.failure; })
            .then(value => ({ value }), error => ({ error })));
        await new Promise(resolve => setImmediate(resolve));
        for (const index of [0, 1]) {
            readers[index].failure = Object.assign(new Error(`producer ${index} stopped`), { code });
            pending[index].reject(readers[index].failure);
            await new Promise(resolve => setImmediate(resolve));
        }
        const result = await Promise.all(outcomes);
        assert.equal(result[0].error, readers[0].failure);
        assert.equal(result[1].error, readers[1].failure);
        assert.deepEqual(result[2], { value: 42 });
        assert.deepEqual(readers.map(reader => reader.loads), [1, 1, 1]);
        assert.ok(readers.every(reader => !hasRankingReadCache(reader.connection)));
    });
}

test('a cancelled cache subscriber cannot consume a successful producer result', async () => {
    const cache = createRankingReadCache();
    const revision = { epoch: 'subscriber', data_revision: 1, catalogue_revision: 1, ready: 1 };
    const producer = { execute: async () => [[revision]] }, subscriber = { execute: async () => [[revision]] };
    const pending = deferred();
    let failure = null, subscriberLoads = 0;
    const first = withRankingReadCache(producer, cache,
        () => cachedRankingRead(producer, 'data', 'shared', () => pending.promise));
    const second = withRankingReadCache(subscriber, cache,
        () => cachedRankingRead(subscriber, 'data', 'shared', () => { subscriberLoads++; return 0; }),
        () => { if (failure) throw failure; });
    const stopped = assert.rejects(second, error => error === failure);
    await new Promise(resolve => setImmediate(resolve));
    failure = Object.assign(new Error('subscriber stopped'), { code: 'RANKING_READ_CANCELLED' });
    pending.resolve(42);
    assert.equal(await first, 42);
    await stopped;
    assert.equal(subscriberLoads, 0);
});

for (const code of ['RANKING_READ_CANCELLED', 'RANKING_READ_TIMEOUT', 'ER_LOCK_DEADLOCK']) {
    test(`a reader never retries its own ${code} failure`, async () => {
        const cache = createRankingReadCache();
        const connection = { execute: async () => [[{ epoch: 'own', data_revision: 1, catalogue_revision: 1, ready: 1 }]] };
        const failure = Object.assign(new Error('own load failed'), { code });
        let loads = 0;
        await assert.rejects(withRankingReadCache(connection, cache,
            () => cachedRankingRead(connection, 'data', 'failure', () => { loads++; throw failure; })),
        error => error === failure);
        assert.equal(loads, 1);
        assert.equal(hasRankingReadCache(connection), false);
        assert.equal(await withRankingReadCache(connection, cache,
            () => cachedRankingRead(connection, 'data', 'failure', () => 42)), 42);
    });
}

test('an actual cancelled workspace producer cannot pass a late driver error to another workspace', async () => {
    const cache = createRankingReadCache(), pending = deferred(), entered = deferred();
    const controller = new AbortController();
    const readers = [0, 1].map(index => {
        const events = [], reader = { events, loads: 0 };
        reader.connection = {
            async query(sql) { events.push(['query', sql]); return [[], []]; },
            async execute(sql) {
                events.push(['execute', sql]);
                if (sql.includes('FROM ranking_cache_revisions')) return [[{
                    epoch: 'workspace', data_revision: 1, catalogue_revision: 1, ready: 1
                }]];
                if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) return [[{
                    ID: 1, parent_ID: null, name: 'Intelligence', slug: 'intelligence', description: 'Compare general intelligence benchmarks.',
                    position: 0, owner_user_ID: null, created_by_user_ID: null, creator_name: null, creator_avatar: null
                }]];
                if (sql.includes('COUNT(*) AS count FROM categories')) return [[{ count: 1 }]];
                if (sql.includes('SELECT benchmark_conditions.ID AS condition_ID')) {
                    reader.loads++;
                    if (!index) { entered.resolve(); return pending.promise; }
                }
                return [[], []];
            },
            async commit() { events.push(['commit']); },
            async rollback() { events.push(['rollback']); },
            release() { events.push(['release']); },
            destroy() { events.push(['destroy']); }
        };
        return reader;
    });
    let nextLease = 0;
    const db = { getConnection: async () => readers[nextLease++].connection };
    const first = getRankingWorkspace(db, { categoryID: 1, rankingCache: cache, signal: controller.signal });
    const stopped = assert.rejects(first, error => error.code === 'RANKING_READ_CANCELLED');
    await entered.promise;
    const second = getRankingWorkspace(db, { categoryID: 1, rankingCache: cache });
    const survived = second.then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readers[1].loads, 0, 'The survivor must join the first producer');
    controller.abort();
    await stopped;
    pending.reject(Object.assign(new Error('late socket failure'), { code: 'PROTOCOL_CONNECTION_LOST' }));
    const result = await survived;
    assert.equal(result.error, undefined);
    assert.equal(result.value.context.categoryPath, 'intelligence');
    assert.deepEqual(readers.map(reader => reader.loads), [1, 1]);
    assert.equal(readers[0].events.filter(([event]) => event === 'destroy').length, 1);
    assert.deepEqual(readers[1].events.slice(-2), [['commit'], ['release']]);
});

test('exact calculation memo is revision-bound and returns isolated metadata on every read', async () => {
    const cache = createRankingReadCache();
    const revision = { epoch: 'one', data_revision: 1, catalogue_revision: 1, ready: 1 };
    const connection = { execute: async () => [[{ ...revision }]] };
    let calls = 0;
    const load = () => {
        calls++;
        const row = { resultCount: 1, fallbackUsageCount: 0, availableInference: { percentile: .5 },
            fallbackResolutions: [{ conditionID: 1 }], lower: 50 };
        deferRankingMetadata(row, 'members', () => [{ condition: { parameters: {} } }]);
        return [row];
    };
    const read = key => withRankingReadCache(connection, cache, () => cachedRankingCalculation(connection, key, load));
    const first = await read('same-input');
    first[0].availableInference.percentile = 0;
    first[0].fallbackResolutions[0].conditionID = 999;
    first[0].members[0].condition.parameters.unsafe = true;
    const second = await read('same-input');
    assert.equal(calls, 1);
    assert.equal(second[0].availableInference.percentile, .5);
    assert.equal(second[0].fallbackResolutions[0].conditionID, 1);
    assert.deepEqual(second[0].members[0].condition.parameters, {});
    await read('changed-weight-or-owner'); assert.equal(calls, 2);
    revision.data_revision = 2;
    await read('same-input'); assert.equal(calls, 3);
    cache.clear(); await read('same-input'); assert.equal(calls, 4);
});
