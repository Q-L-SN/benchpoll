import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedAA, buildTargets } from '../ops/archive-aa-catalogue-20261104.mjs';

const benchmark = (ID, overrides = {}) => ({
    ID, name: `Benchmark ${ID}`, is_active: 1, aaBenchmark: false, ...overrides
});
const version = (ID, parent, overrides = {}) => ({
    ID, benchmark_ID: parent.ID, name: `Version ${ID}`, condition_key: `version-${ID}`,
    deleted_at: null, is_default: 0, is_primary: 0,
    aaBenchmark: parent.aaBenchmark, policyAA: parent.aaBenchmark,
    exclusivelyAAProvenance: false, totalScores: 0, acceptedScores: 0,
    scoredModels: 0, aaScores: 0, aaAcceptedScores: 0, provenanceReasons: [],
    ...overrides
});
const IDs = rows => rows.map(row => Number(row.ID));
const noTargets = { targetBenchmarks: [], targetVersions: [], needDefault: [], primaryChanges: [] };

test('confirmedAA accepts confirmed benchmark, direct-source, and mirrored evidence', () => {
    for (const reason of ['aa_specific_benchmark', 'aa_direct_source', 'aa_mirrored_result']) {
        assert.equal(confirmedAA(reason), true, reason);
    }
});

test('confirmedAA rejects possibly derived evidence and absent reasons', () => {
    for (const reason of ['possibly_aa_derived_result', null, undefined, '', false]) {
        assert.equal(confirmedAA(reason), false, String(reason));
    }
});

test('whole AA parents archive all live versions without replacement defaults', () => {
    const parent = benchmark(30, { name: 'APEX-Agents-AA', aaBenchmark: true });
    const versions = [
        version(301, parent, { name: 'default', condition_key: 'default', is_default: 1, is_primary: 1 }),
        version(302, parent, { name: 'Overall', acceptedScores: 5 }),
        version(303, parent, { deleted_at: '2026-11-01 00:00:00' })
    ];
    const plan = buildTargets([parent], versions);
    assert.deepEqual(IDs(plan.targetBenchmarks), [30]);
    assert.deepEqual(IDs(plan.targetVersions), [301, 302]);
    assert.deepEqual(plan.needDefault, []);
    assert.deepEqual(plan.primaryChanges, []);
});

test('AA parent identity from version inventory still prevents a non-AA replacement default', () => {
    const parent = benchmark('30');
    const plan = buildTargets([parent], [version('301', parent, { aaBenchmark: true, policyAA: true })]);
    assert.deepEqual(IDs(plan.targetBenchmarks), [30]);
    assert.deepEqual(IDs(plan.targetVersions), [301]);
    assert.deepEqual(plan.needDefault, []);
});

test('an AA parent with no live versions is still archived', () => {
    const parent = benchmark(30, { aaBenchmark: true });
    const plan = buildTargets([parent], []);
    assert.deepEqual(IDs(plan.targetBenchmarks), [30]);
    assert.deepEqual(plan.targetVersions, []);
    assert.deepEqual(plan.needDefault, []);
    assert.deepEqual(plan.primaryChanges, []);
});

test('non-AA parents whose only live versions are AA receive empty-default requests', () => {
    const telecom = benchmark(1328, { name: 'tau2-Bench Telecom' });
    const exam = benchmark(2227, { name: 'humanitys-last-exam' });
    const unaffected = benchmark(4000);
    const versions = [
        version(10, telecom, { policyAA: true, is_primary: 1 }),
        version(11, telecom, { deleted_at: '2026-11-01 00:00:00' }),
        version(20, exam, { policyAA: true, is_primary: 1 }),
        version(21, exam, { policyAA: true })
    ];
    const plan = buildTargets([telecom, exam, unaffected], versions);
    assert.deepEqual(plan.targetBenchmarks, []);
    assert.deepEqual(IDs(plan.targetVersions), [10, 20, 21]);
    assert.deepEqual(IDs(plan.needDefault), [1328, 2227]);
    assert.deepEqual(plan.primaryChanges, []);
});

test('mixed parents preserve independent versions and their existing primary', () => {
    const parent = benchmark(1334, { name: 'SciCode' });
    const versions = [
        version(10, parent, { policyAA: true }),
        version(11, parent, { name: 'default', condition_key: 'default', is_default: 1, is_primary: 1 }),
        version(12, parent, { name: 'Overall', acceptedScores: 100, scoredModels: 100 })
    ];
    const plan = buildTargets([parent], versions);
    assert.deepEqual(IDs(plan.targetVersions), [10]);
    assert.deepEqual(plan.targetBenchmarks, []);
    assert.deepEqual(plan.needDefault, []);
    assert.deepEqual(plan.primaryChanges, []);
});

test('a renamed policy-AA version is targeted without AA display text or provenance', () => {
    const parent = benchmark(1428, { name: 'Tau3-Banking' });
    const renamed = version(2255, parent, {
        name: 'Banking', condition_key: 'crawl-151562e6b464d951cfafd948', policyAA: true, is_primary: 1
    });
    const plan = buildTargets([parent], [renamed]);
    assert.deepEqual(IDs(plan.targetVersions), [2255]);
    assert.deepEqual(plan.targetBenchmarks, []);
    assert.deepEqual(IDs(plan.needDefault), [1428]);
});

test('exclusively confirmed AA provenance can target a version without a policy-name match', () => {
    const parent = benchmark(100);
    const plan = buildTargets([parent], [version(10, parent, {
        exclusivelyAAProvenance: true, totalScores: 2, acceptedScores: 2,
        aaScores: 2, aaAcceptedScores: 2, provenanceReasons: ['aa_mirrored_result']
    })]);
    assert.deepEqual(IDs(plan.targetVersions), [10]);
    assert.deepEqual(plan.targetBenchmarks, []);
    assert.deepEqual(IDs(plan.needDefault), [100]);
});

test('possibly derived provenance alone preserves independent versions even when every score is flagged', () => {
    const exploit = benchmark(100, { name: 'ExploitGym' });
    const swe = benchmark(101, { name: 'SWE-Bench Pro' });
    const ambiguous = {
        totalScores: 5, acceptedScores: 5, aaScores: 5, aaAcceptedScores: 5,
        exclusivelyAAProvenance: false, provenanceReasons: ['possibly_aa_derived_result']
    };
    const versions = [
        version(7881, exploit, { ...ambiguous, is_primary: 1 }),
        version(14413, exploit, ambiguous),
        version(15641, swe, { ...ambiguous, is_primary: 1 })
    ];
    assert.deepEqual(buildTargets([exploit, swe], versions), noTargets);
});

test('deleted AA versions are ignored and an applied plan is idempotent', () => {
    const aa = benchmark(30, { aaBenchmark: true });
    const independent = benchmark(1328);
    const benchmarks = [aa, independent];
    const versions = [
        version(10, aa, { is_primary: 1 }),
        version(20, independent, { policyAA: true, is_primary: 1 })
    ];
    const first = buildTargets(benchmarks, versions);
    assert.deepEqual(IDs(first.targetVersions), [10, 20]);
    assert.deepEqual(IDs(first.needDefault), [1328]);
    const archivedBenchmarks = new Set(IDs(first.targetBenchmarks));
    const archivedVersions = new Set(IDs(first.targetVersions));
    const afterBenchmarks = benchmarks.map(row => archivedBenchmarks.has(row.ID) ? { ...row, is_active: 0 } : row);
    const afterVersions = versions.map(row => archivedVersions.has(row.ID) ? {
        ...row, deleted_at: '2026-11-04 08:00:00', is_default: 0, is_primary: 0
    } : row);
    afterVersions.push(version(21, independent, {
        name: 'default', condition_key: 'default', is_default: 1, is_primary: 1
    }));
    assert.deepEqual(buildTargets(afterBenchmarks, afterVersions), noTargets);
});

test('inactive parents are never resurrected or assigned defaults or replacement primaries', () => {
    const aa = benchmark('30', { is_active: '0', aaBenchmark: true });
    const independent = benchmark('100', { is_active: '0' });
    const empty = benchmark('101', { is_active: '0' });
    const versions = [
        version('10', aa),
        version('20', independent, { policyAA: true, is_primary: 1 }),
        version('21', independent),
        version('30', empty, { policyAA: true })
    ];
    const plan = buildTargets([aa, independent, empty], versions);
    assert.deepEqual(IDs(plan.targetVersions), [10, 20, 30]);
    assert.deepEqual(plan.targetBenchmarks, []);
    assert.deepEqual(plan.needDefault, []);
    assert.deepEqual(plan.primaryChanges, []);
});

test('archiving a primary selects the highest-priority retained live version', () => {
    const parent = benchmark('100');
    const versions = [
        version('10', parent, { policyAA: true, is_primary: '1' }),
        version('11', parent, { name: 'default', condition_key: 'default', is_default: '1', scoredModels: 100 }),
        version('12', parent, { name: 'Overall', scoredModels: 1, acceptedScores: 1 }),
        version('13', parent, { name: 'Overall', scoredModels: 200, deleted_at: '2026-11-01 00:00:00' }),
        version('14', parent, { name: 'General', scoredModels: 300 })
    ];
    const plan = buildTargets([parent], versions);
    assert.deepEqual(IDs(plan.targetVersions), [10]);
    assert.deepEqual(plan.primaryChanges, [12]);
    assert.deepEqual(plan.needDefault, []);
    assert.deepEqual(plan.targetBenchmarks, []);
});

test('replacement primary ties use retained evidence and then numeric identity', () => {
    const parent = benchmark(100);
    const versions = [
        version(10, parent, { policyAA: true, is_primary: 1 }),
        version(11, parent, { scoredModels: 1, acceptedScores: 100, aaAcceptedScores: 99 }),
        version(14, parent, { scoredModels: 1, acceptedScores: 8, aaAcceptedScores: 1 }),
        version('12', parent, { scoredModels: 1, acceptedScores: 8, aaAcceptedScores: 1 }),
        version(13, parent, { scoredModels: 0, acceptedScores: 100 })
    ];
    assert.deepEqual(buildTargets([parent], versions).primaryChanges, [12]);
});

test('planning does not repair unrelated parents or mutate the inventory', () => {
    const affected = benchmark(100);
    const unaffected = benchmark(101);
    const benchmarks = [affected, unaffected];
    const versions = [
        version(10, affected, { policyAA: true, is_primary: 1 }),
        version(11, affected, { name: 'default', is_default: 1, condition_key: 'default' }),
        version(20, unaffected, { name: 'Overall' })
    ];
    const before = structuredClone({ benchmarks, versions });
    const plan = buildTargets(benchmarks, versions);
    assert.deepEqual(plan.primaryChanges, [11]);
    assert.deepEqual(plan.needDefault, []);
    assert.deepEqual(plan.targetBenchmarks, []);
    assert.deepEqual({ benchmarks, versions }, before);
});

test('empty inventory produces no mutations', () => {
    assert.deepEqual(buildTargets([], []), noTargets);
});
