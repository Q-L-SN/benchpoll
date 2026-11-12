import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
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

test('the default cache can retain the production-sized evidence pipeline without repeated eviction', async () => {
    const cache = createRankingReadCache();
    let loads = 0;
    for (let pass = 0; pass < 3; pass++) {
        for (const [key, cells] of [['models', 156160], ['groups', 124799], ['inference', 124799]]) {
            await cache.read(key, () => { loads++; return cells; }, value => value);
        }
    }
    assert.equal(loads, 3);
});

test('lazy ranking snapshots do not keep the source score matrices alive', () => {
    const serviceURL = new URL('../ranking-service.js', import.meta.url).href;
    const comparisonURL = new URL('../model-comparison.js', import.meta.url).href;
    execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { scoreModels, scoreComparison } from ${JSON.stringify(serviceURL)};
        import { comparisonOptions } from ${JSON.stringify(comparisonURL)};
        function snapshot(comparison) {
            const results = new Map([['10', { normalizedScore: 50 }]]);
            const model = { ID: 1, modelID: 1, modelName: 'Model', name: 'Model',
                condition: { ID: 1, parameters: {} }, results };
            const entries = [{ conditionID: 10, weightBasisPoints: 10000 }];
            const rows = comparison
                ? scoreComparison([model], entries, 10000, { scoreMode: 'range', jsonMemberMetadata: true }, comparisonOptions([model]))
                : scoreModels([model], entries, 10000, { scoreMode: 'range', deferMetadata: true });
            return { rows, ref: new WeakRef(results) };
        }
        const snapshots = [snapshot(false), snapshot(true)];
        for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise(resolve => setImmediate(resolve));
            global.gc();
        }
        for (const { rows, ref } of snapshots) {
            assert.equal(ref.deref(), undefined, 'A lazy snapshot retained its input score matrix');
            const wire = JSON.parse(JSON.stringify(rows));
            assert.equal(wire[0].lower, 50);
            assert.equal(wire[0].calculationScores[0].normalizedScore, 50);
        }
    `], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
});

function runPreparedRankingGCCheck(check) {
    const moduleURL = path => JSON.stringify(new URL(path, import.meta.url).href);
    execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { scoreModels, scoreComparison } from ${moduleURL('../ranking-service.js')};
        import { comparisonOptions, groupComparisonModels } from ${moduleURL('../model-comparison.js')};
        import { createPairwiseReference } from ${moduleURL('../pairwise-score.js')};
        import { createRankingPager, rankModels } from ${moduleURL('../ranking-pagination.js')};
        import { createRankingReadCache, cachedRankingRead, cachedRankingCalculation,
            withRankingReadCache } from ${moduleURL('../ranking-read-cache.js')};

        function preparedRanking(count = 3) {
            const models = Array.from({ length: count * 2 }, (_, index) => {
                const modelID = Math.floor(index / 2) + 1;
                return { ID: index + 1, modelID, modelName: 'Model ' + modelID,
                    name: 'Model ' + modelID + ' run ' + index,
                    condition: { parameters: { run: index % 2 } },
                    results: new Map([
                        ['10', { normalizedScore: 49 + modelID, evidenceHash: 'weighted-' + index }],
                        ['20', { normalizedScore: 69 + modelID, evidenceHash: 'unweighted-' + index }]
                    ]) };
            });
            const options = comparisonOptions(models);
            const groups = groupComparisonModels(models, options, []);
            const reference = createPairwiseReference(groups);
            const indexes = new WeakMap(groups.map(group => [group,
                new Map(group.comparisonScores.map(score => [score.conditionID, score]))]));
            return { models, groups, options, reference, indexes,
                entries: [{ conditionID: 10, weightBasisPoints: 10000 }] };
        }
        function sourceReferences(fixture) {
            const unusedScore = fixture.groups[0].comparisonScores.find(score => score.conditionID === 20);
            return Object.fromEntries(Object.entries({
                models: fixture.models, rawResults: fixture.models[0].results,
                groups: fixture.groups, selectedGroup: fixture.groups[0],
                selectedResults: fixture.groups[0].results,
                otherGroup: fixture.groups.at(-1), otherResults: fixture.groups.at(-1).results,
                selectedComparisonScores: fixture.groups[0].comparisonScores,
                otherComparisonScores: fixture.groups.at(-1).comparisonScores,
                unusedScore, unusedMemberEvidence: unusedScore.memberEvidence,
                unusedMemberWeights: unusedScore.memberWeights,
                reference: fixture.reference, indexes: fixture.indexes,
                selectedIndex: fixture.indexes.get(fixture.groups[0]),
                otherIndex: fixture.indexes.get(fixture.groups.at(-1))
            }).map(([key, value]) => [key, new WeakRef(value)]));
        }
        function scoreFixture(fixture, comparison, deferred) {
            const rules = { scoreMode: 'available', percentileReference: fixture.reference,
                comparisonScoreIndexes: fixture.indexes };
            return comparison
                ? scoreComparison(fixture.models, fixture.entries, 10000,
                    { ...rules, jsonMemberMetadata: deferred }, fixture.options, fixture.groups)
                : scoreModels(fixture.groups, fixture.entries, 10000, { ...rules, deferMetadata: deferred });
        }
        async function collect() {
            // WeakRef targets stay alive within a job; yield before each forced collection.
            for (let attempt = 0; attempt < 5; attempt++) {
                await new Promise(resolve => setImmediate(resolve));
                global.gc();
            }
        }
        function assertCollected(refs, label) {
            for (const [key, ref] of Object.entries(refs)) {
                assert.equal(ref.deref(), undefined, label + ' retained ' + key);
            }
        }
        ${check}
    `], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('standalone deferred getters release prepared groups, pairwise references and score indexes', () => {
    runPreparedRankingGCCheck(`
        function heldGetter(comparison, key) {
            const fixture = preparedRanking();
            const rows = scoreFixture(fixture, comparison, true);
            const getter = Object.getOwnPropertyDescriptor(rows[0], key).get;
            assert.equal(typeof getter, 'function');
            const expected = JSON.parse(JSON.stringify(scoreFixture(fixture, comparison, false)[0][key]));
            return { getter, expected, refs: sourceReferences(fixture),
                label: (comparison ? 'scoreComparison.' : 'scoreModels.') + key };
        }
        const held = [false, true].flatMap(comparison =>
            (comparison ? ['condition', 'calculationScores', 'members', 'comparisonScores']
                : ['condition', 'calculationScores']).map(key => heldGetter(comparison, key)));
        await collect();
        for (const item of held) {
            assertCollected(item.refs, item.label);
            const receiver = {};
            const value = item.getter.call(receiver);
            assert.deepEqual(JSON.parse(JSON.stringify(value)), item.expected, item.label);
            assert.equal(Object.getOwnPropertyDescriptor(receiver, item.label.split('.')[1]).get, undefined);
            const second = item.getter.call({});
            assert.deepEqual(second, value);
            assert.notEqual(second, value, item.label + ' must clone metadata for each receiver');
        }
    `);
});

test('cached pager snapshots release prepared graphs before the final lazy page is serialized', () => {
    runPreparedRankingGCCheck(`
        async function snapshot(pager, cache) {
            const fixture = preparedRanking(26);
            const refs = sourceReferences(fixture);
            const expectedLast = JSON.parse(JSON.stringify(rankModels(scoreFixture(fixture, true, false)).at(-1)));
            const connection = { execute: async () => [[{
                epoch: 'gc-fixture', data_revision: 1, catalogue_revision: 1, ready: 1
            }]] };
            const rows = await withRankingReadCache(connection, cache, async () => {
                await cachedRankingRead(connection, 'data', 'groups', () => fixture.groups);
                await cachedRankingRead(connection, 'data', 'indexes', () => fixture.indexes);
                await cachedRankingRead(connection, 'data', 'reference', () => fixture.reference);
                return cachedRankingCalculation(connection, 'gc-fixture', () => scoreFixture(fixture, true, true));
            });
            const response = pager.create({ scoreMode: 'available', benchmarks: [], versionComposition: [],
                personalPie: { entries: [] }, comparison: fixture.options,
                modelLeaderboards: { personal: [], public: rows } });
            assert.equal(response.modelLeaderboards.public.length, 25);
            JSON.stringify(response);
            return { refs, expectedLast, snapshotID: response.rankingPagination.snapshotID };
        }
        const pager = createRankingPager({ now: () => 0 });
        const cache = createRankingReadCache();
        const state = await snapshot(pager, cache);
        cache.clear();
        assert.deepEqual(cache.stats, { entries: 0, cells: 0 });
        await collect();
        assertCollected(state.refs, 'unexpired pager snapshot');
        const next = pager.getPage({ snapshotID: state.snapshotID, list: 'public', offset: 25 });
        assert.equal(next.items.length, 1);
        for (const key of ['condition', 'calculationScores', 'members', 'comparisonScores']) {
            assert.equal(typeof Object.getOwnPropertyDescriptor(next.items[0], key).get, 'function', key);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(next)).items, [state.expectedLast]);
    `);
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
                    ID: 1, public_ID: 1, parent_ID: null, name: 'Intelligence', slug: 'intelligence', description: 'Compare general intelligence benchmarks.',
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
    assert.equal(result.value.context.categoryPath, '1');
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
