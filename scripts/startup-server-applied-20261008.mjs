import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as currentRanking from '../ranking-service.js';
import { createRankingPager as currentPager } from '../ranking-pagination.js';
import { familyKey } from '../public/js/shared/benchmark-families.js';

assert.equal(typeof vm.SourceTextModule, 'function',
    'Run: node --experimental-vm-modules scripts/startup-server-applied-20261008.mjs');
assert.equal(process.argv.length, 2, 'This bounded comparison accepts no arguments.');
const repoURL = new URL('../', import.meta.url);
const root = fileURLToPath(repoURL);
const beforeDirectory = 'D:/BenchPoll-artifacts/review-20261008/startup-production-before';
const output = path.join(root, 'artifacts/review-20261008');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const round = value => Math.round(value * 1000) / 1000;
const clean = value => JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === 'serverTime' || key === 'snapshotID') return undefined;
    return Object.prototype.toString.call(item) === '[object Map]' ? { map: [...item] } : item;
}));
const digest = value => hash(JSON.stringify(clean(value)));
const equal = (a, b, message) => assert.deepEqual(clean(a), clean(b), message);
const originals = new Map();
const currentSources = new Map();
for (const file of ['ranking-service.js', 'ranking-pagination.js']) {
    originals.set(file, await readFile(path.join(beforeDirectory, file), 'utf8'));
    currentSources.set(file, await readFile(path.join(root, file), 'utf8'));
}

// Reuse the exact existing ten fixtures without importing/running the old diagnostic.
const helperPath = path.join(root, 'scripts/review-startup-server-20261008.mjs');
const helperSource = await readFile(helperPath, 'utf8');
const definitionsStart = helperSource.indexOf('function dataFixture(');
const definitionsEnd = helperSource.indexOf('const phases = ', definitionsStart);
const casesStart = helperSource.indexOf('const draft = ');
const casesEnd = helperSource.indexOf('for (const [label, options] of cases)', casesStart);
assert.ok(definitionsStart >= 0 && definitionsEnd > definitionsStart && casesStart > definitionsEnd && casesEnd > casesStart,
    'Existing fixture boundaries changed; do not silently substitute another fixture.');
const protectedFiles = [helperPath, ...['context-map.md', 'baseline-sources.json', 'results.json', 'report.md', 'validation.md']
    .map(suffix => path.join(output, `startup-server-${suffix}`))];
const protectedFingerprints = new Map();
for (const file of protectedFiles) protectedFingerprints.set(file, hash(await readFile(file, 'utf8')));
const dependencyFingerprints = new Map();

function fixtureFactory() {
    const context = vm.createContext({ assert, hash, round, familyKey, ranking: currentRanking,
        performance, structuredClone, settings: { models: 8, conditions: 12 },
        pause: async ms => { assert.equal(ms, 0, 'Applied comparison has no simulated latency'); } });
    new vm.Script(`${helperSource.slice(definitionsStart, definitionsEnd)}\n${helperSource.slice(casesStart, casesEnd)}
        globalThis.__fixtures = { dataFixture, sqlFixture, cases };`, { filename: 'saved-sidecar-fixtures' }).runInContext(context);
    assert.equal(context.__fixtures.cases.length, 10);
    return context.__fixtures;
}

async function installedExports() {
    const context = vm.createContext({ console, setTimeout, clearTimeout, structuredClone });
    const dependencies = new Map();
    const modules = new Map();
    const linker = async (specifier, referencingModule) => {
        assert.ok(specifier === 'node:crypto' || specifier.startsWith('./'), `Unexpected saved-source import: ${specifier}`);
        const sourceFile = referencingModule.identifier.endsWith('ranking-service.js') ? 'ranking-service.js' : 'ranking-pagination.js';
        const dependencyURL = specifier === 'node:crypto' ? specifier : new URL(specifier, new URL(sourceFile, repoURL)).href;
        if (!dependencies.has(dependencyURL)) {
            if (specifier !== 'node:crypto') {
                const filename = fileURLToPath(dependencyURL);
                const fingerprint = hash(await readFile(filename, 'utf8'));
                if (dependencyFingerprints.has(filename)) assert.equal(fingerprint, dependencyFingerprints.get(filename), 'Dependency changed between repetitions');
                dependencyFingerprints.set(filename, fingerprint);
            }
            const namespace = await import(dependencyURL);
            const names = Object.keys(namespace);
            const dependency = new vm.SyntheticModule(names, function () {
                for (const name of names) this.setExport(name, namespace[name]);
            }, { context, identifier: dependencyURL });
            dependencies.set(dependencyURL, dependency);
        }
        return dependencies.get(dependencyURL);
    };
    for (const [file, source] of originals) {
        const module = new vm.SourceTextModule(source, { context,
            identifier: path.join(beforeDirectory, file) });
        await module.link(linker);
        await module.evaluate();
        modules.set(file, module.namespace);
    }
    return { ranking: modules.get('ranking-service.js'), pager: modules.get('ranking-pagination.js').createRankingPager };
}

async function workspace(api, fixtures, options) {
    const data = fixtures.dataFixture({ models: 8, conditions: 12 });
    const before = digest(data);
    const db = fixtures.sqlFixture(data);
    const start = performance.now();
    const result = await api.getRankingWorkspace(db, structuredClone(options));
    const elapsedMs = round(performance.now() - start);
    assert.equal(digest(data), before, 'Source fixture was mutated');
    const trace = db.summary();
    assert.equal(trace.maxConcurrentExecute, 1);
    equal(trace.lifecycle.map(event => event.kind), ['acquire', 'query', 'query', 'commit', 'release'], 'Snapshot lease lifecycle');
    equal(trace.lifecycle.filter(event => event.kind === 'query').map(event => event.label),
        ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'], 'Same consistent read-only snapshot');
    return { result, elapsedMs, trace, digest: digest(result) };
}

function pageWorkspace(seed) {
    const plain = seed.benchmarks.find(row => !row.isFamily);
    const result = { ...seed, benchmarks: Array.from({ length: 21325 }, (_, index) => ({ ...plain,
        ID: index + 1000, conditionID: index + 1000, benchmarkID: index + 1000,
        name: `Synthetic benchmark ${String(index).padStart(5, '0')}`, rank: index + 1,
        publicWeightBasisPoints: 0, publicWeight: 0, personalWeightBasisPoints: null, personalWeight: null
    })) };
    result.benchmarks.push(...seed.benchmarks.filter(row => row.isFamily || row.conditionID <= 4));
    return result;
}

function continuations(pager, first) {
    const items = [];
    const query = args => pager.getPage({ snapshotID: first.rankingPagination.snapshotID, userID: '7', ...args });
    for (const args of [{ list: 'benchmarks', group: 'primary', offset: 40 }, { list: 'public', offset: 0 }, { list: 'personal', offset: 0 },
        { list: 'benchmarks', group: 'primary', query: 'Synthetic benchmark 21200' },
        { list: 'benchmarks', group: 'primary', query: 'synthetik' },
        { list: 'benchmarks', group: 'primary', query: 'Benchmark 0001', pinPersonal: true, groupVersions: true },
        { list: 'fallbacks', conditionID: 1 }]) items.push(query(args));
    pager.retainReferencedFamilies([101]);
    items.push(query({ list: 'benchmarks', group: 'primary', query: 'Benchmark 0001' }));
    items.push(query({ list: 'fallbacks', conditionID: 1 }));
    assert.equal(items.length, 9);
    assert.equal(items[3].items[0].name, 'Synthetic benchmark 21200');
    return items;
}

const report = { createdAt: new Date().toISOString(), node: process.version, repetitions: 2,
    comparison: 'Real current exports versus unmodified saved original installed ESM source. No repair transforms.',
    originalDirectory: beforeDirectory, dependencyPolicy: 'Both sides use the same current read-only dependency exports; saved directory contains only the two compared JS modules, not dependency copies.',
    sources: [...originals].map(([file, source]) => ({ file, installedBeforeSHA256: hash(source),
        currentSHA256: hash(currentSources.get(file)), different: hash(source) !== hash(currentSources.get(file)) })),
    fixtureSourceSHA256: hash(helperSource), fixtures: [], sampleGuards: [], pager: [], assertions: [
        'Ten identical structured SQL fixtures in two independent repetitions; fresh installed ESM context, fixture objects and leases each repetition.',
        'Exact full workspace JSON equality and SHA-256; omit only serverTime and random snapshotID.',
        'Current workspace executes one fewer SELECT in every case; only the scoped normalization metadata SELECT is removed.',
        'All other SQL labels, normalized statements, parameters, returned-row counts and ordering remain identical.',
        'Same acquire, repeatable-read consistent/read-only START, commit and release; no rollback/destroy or concurrent fixture execute.',
        'Fixture input is not mutated; public participantCount 32, composition counts 12/20/0, weights 5042/4958.',
        'Direct loadModels results match including global IDs, canonical assignments, distinct-raw medians/sampleCount=3, hash scope and the model without scores.',
        'Exact paged first payload and nine continuation/search/pinning/grouping/fallback/cleanup payloads with output SHA-256.',
        'Fresh original/current pagers per repetition; subsequent searches observe family cleanup after query-only lazy initialization.',
        'All original sidecar files, saved installed source, current compared modules and linked dependencies retain their hashes throughout.'
    ] };

for (let repetition = 1; repetition <= 2; repetition++) {
    const fixtures = fixtureFactory();
    const original = await installedExports();
    let originalSeed, currentSeed;
    for (const [name, options] of fixtures.cases) {
        const first = repetition % 2 ? await workspace(original.ranking, fixtures, options) : await workspace(currentRanking, fixtures, options);
        const second = repetition % 2 ? await workspace(currentRanking, fixtures, options) : await workspace(original.ranking, fixtures, options);
        const before = repetition % 2 ? first : second;
        const after = repetition % 2 ? second : first;
        equal(after.result, before.result, `${name}/${repetition}: exact actual-versus-installed workspace`);
        assert.equal(after.digest, before.digest);
        assert.equal(before.trace.executeCount - after.trace.executeCount, 1);
        assert.equal(before.trace.reads.filter(read => read.label === 'models.condition-metadata').length, 1);
        assert.equal(after.trace.reads.filter(read => read.label === 'models.condition-metadata').length, 0);
        const comparableReads = trace => trace.reads.filter(read => read.label !== 'models.condition-metadata').map(({ kind, label, sql, params, rows }) => ({ kind, label, sql, params, rows }));
        equal(comparableReads(after.trace), comparableReads(before.trace), `${name}/${repetition}: no additional SQL changes`);
        if (name === 'guest-range') {
            assert.equal(after.result.publicPie.participantCount, 32);
            equal(after.result.publicPie.composition.map(item => item.pieCount), [12, 20, 0]);
            equal(after.result.publicPie.entries.map(item => [item.conditionID, item.weightBasisPoints]), [[1, 5042], [3, 4958]]);
        }
        if (name === 'member-range') { originalSeed = before.result; currentSeed = after.result; }
        report.fixtures.push({ name, repetition, digest: after.digest, equal: true,
            original: { ms: before.elapsedMs, ...before.trace }, current: { ms: after.elapsedMs, ...after.trace } });
    }
    for (const [variant, api] of [['installed-before', original.ranking], ['current-export', currentRanking]]) {
        const data = fixtures.dataFixture({ models: 8, conditions: 12 });
        const db = fixtures.sqlFixture(data);
        const models = await api.loadModels(db.connection, null, { conditionIDs: [1, 2, 3, 4], evidenceConditionIDs: [1, 3] });
        for (const model of models) for (const [conditionID, score] of model.results) {
            assert.equal(score.sampleCount, 3);
            assert.equal(typeof score.evidenceHash, ['1', '3'].includes(conditionID) ? 'string' : 'undefined');
        }
        assert.equal(models.length, 17);
        assert.ok(models.some(model => model.ID < 0 && model.results.size === 0));
        const counterpart = report.sampleGuards.find(item => item.repetition === repetition);
        if (counterpart) assert.equal(digest(models), counterpart.digest, 'Loaded identities/medians/samples/evidence equality');
        report.sampleGuards.push({ variant, repetition, configurations: models.length, digest: digest(models), ...db.summary() });
    }
    const originalPager = original.pager();
    const appliedPager = currentPager();
    const originalFirst = originalPager.create(pageWorkspace(originalSeed), { userID: '7' });
    const appliedFirst = appliedPager.create(pageWorkspace(currentSeed), { userID: '7' });
    equal(appliedFirst, originalFirst, `Pager ${repetition}: identical first response`);
    const originalPages = continuations(originalPager, originalFirst);
    const appliedPages = continuations(appliedPager, appliedFirst);
    equal(appliedPages, originalPages, `Pager ${repetition}: all nine continuations identical`);
    const pageDigest = { repetition, catalogueRows: pageWorkspace(currentSeed).benchmarks.length,
        firstDigest: digest(appliedFirst), continuationDigests: appliedPages.map(digest), allEqual: true };
    report.pager.push(pageDigest);
    console.log(JSON.stringify({ repetition, exactFixtures: 10, pagerContinuations: 9,
        defaultQueriesBefore: report.fixtures.find(item => item.repetition === repetition && item.name === 'guest-range').original.executeCount,
        defaultQueriesAfter: report.fixtures.find(item => item.repetition === repetition && item.name === 'guest-range').current.executeCount }));
}

assert.equal(report.fixtures.length, 20);
for (const item of report.fixtures.slice(0, 10)) {
    const repeat = report.fixtures.find(other => other.name === item.name && other.repetition === 2);
    assert.equal(repeat.digest, item.digest, `${item.name}: independent repetitions agree`);
}
assert.equal(report.pager[0].firstDigest, report.pager[1].firstDigest);
equal(report.pager[0].continuationDigests, report.pager[1].continuationDigests, 'Pager hashes repeat independently');
for (const [file, fingerprint] of protectedFingerprints) assert.equal(hash(await readFile(file, 'utf8')), fingerprint, 'Original sidecar artifact changed');
for (const [file, source] of originals) assert.equal(await readFile(path.join(beforeDirectory, file), 'utf8'), source, 'Saved installed source changed');
for (const [file, source] of currentSources) assert.equal(await readFile(path.join(root, file), 'utf8'), source, 'Current app source changed during comparison');
for (const [file, fingerprint] of dependencyFingerprints) assert.equal(hash(await readFile(file, 'utf8')), fingerprint, 'Linked semantic dependency changed');
report.originalSidecarFilesUnchanged = [...protectedFingerprints].map(([file, sha256]) => ({ file, sha256 }));
report.linkedDependencyFingerprints = [...dependencyFingerprints].map(([file, sha256]) => ({ file, sha256 }));
report.result = 'pass';
const lines = ['# Applied Startup Comparison', '',
    `Generated: ${report.createdAt}; ${process.version}. Result: PASS.`, '',
    '## Command', '', '```powershell',
    'node --experimental-vm-modules scripts/startup-server-applied-20261008.mjs', '```', '',
    `Saved original installed source: \`${beforeDirectory}\`. Its two modules are evaluated as unmodified ESM with SourceTextModule; real current exports are imported normally. The backup does not contain dependencies, so both sides share current read-only dependency exports, with hashes checked between repetitions and at completion. No speculative repair transform is executed.`, '',
    '## Exact Assertions', '', ...report.assertions.map(item => `- ${item}`), '',
    '## Fixture Results', '', '| Case | Original SELECTs | Current SELECTs | Repetitions | Exact Hash |',
    '| --- | ---: | ---: | ---: | --- |',
    ...report.fixtures.filter(item => item.repetition === 1).map(item => `| ${item.name} | ${item.original.executeCount} | ${item.current.executeCount} | 2 | ${item.digest} |`), '',
    'Both independent repetitions agree on all workspace and continuation hashes. The comparison omits only timestamps and random pager snapshot IDs. Public sampling and direct model-result sample/evidence checks also pass.', '',
    '## Source Identity', '',
    ...report.sources.flatMap(item => [`- ${item.file} original: \`${item.installedBeforeSHA256}\`.`, `- ${item.file} current: \`${item.currentSHA256}\`.`]), '',
    'The original VM baseline/candidate runner, reports, results, validation receipt and captured-source artifact were hash-checked and left unchanged. This new runner writes only startup-server-applied-results.json and startup-server-applied-report.md.', '',
    'No production/database/network/browser probes or application edits. Fixture timing is not origin timing; the parent owns full-suite testing, browser verification, live performance and rollout.', ''
];
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'startup-server-applied-results.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
await writeFile(path.join(output, 'startup-server-applied-report.md'), lines.join('\n'), 'utf8');
console.log(JSON.stringify({ result: 'pass', workspaceComparisons: 20, pagerComparisons: 20,
    originalArtifactsPreserved: true, applicationEdits: 0, productionQueries: 0 }));
