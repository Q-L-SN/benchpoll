import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import * as ranking from '../ranking-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';
import { createPercentileReference } from '../public/js/shared/available-score.js';
import { familyKey } from '../public/js/shared/benchmark-families.js';
import { assertCategoryName } from '../public/js/shared/category-route.js';
import * as shared from '../public/js/shared.js';

// Offline only: never import server.js, db.js, dotenv or a live-DB profiler.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts/review-20261008');
const settings = { repeat: 2, models: 180, conditions: 240, pagerRows: 21325, delayMs: 2 };
for (const argument of process.argv.slice(2)) {
    const match = /^--(repeat|models|conditions|pager-rows|delay-ms)=(\d+)$/.exec(argument);
    assert.ok(match, `Unknown argument: ${argument}`);
    const key = { 'pager-rows': 'pagerRows', 'delay-ms': 'delayMs' }[match[1]] ?? match[1];
    settings[key] = Number(match[2]);
}
assert.ok(settings.repeat >= 2 && settings.repeat <= 8);
assert.ok(settings.models >= 8 && settings.models <= 500);
assert.ok(settings.conditions >= 12 && settings.conditions <= 1000 && settings.conditions % 2 === 0);
assert.ok(settings.pagerRows >= 80 && settings.pagerRows <= 30000);
assert.ok(settings.delayMs <= 20);
const pause = ms => ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
const round = value => Math.round(value * 1000) / 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clean = value => JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === 'serverTime' || key === 'snapshotID') return undefined;
    return Object.prototype.toString.call(item) === '[object Map]' ? { map: [...item] } : item;
}));
const digest = value => hash(JSON.stringify(clean(value)));
const same = (left, right, label) => assert.deepEqual(clean(left), clean(right), label);
const sourceFiles = [
    'scripts/review-startup-server-20261008.mjs',
    'server.js', 'ranking-service.js', 'ranking-pagination.js', 'model-comparison.js',
    'benchmark-family-service.js', 'benchmark-version-preferences.js', 'score-field-service.js',
    'public/js/shared/score-fields.js', 'public/js/shared/available-score.js',
    'public/js/shared/search.js', 'public/js/shared/benchmark-families.js',
    'benchmark-condition-visibility.js', 'score-aggregation.js', 'score-evidence.js',
    'db.js', 'db-deadlines.js', 'db-transaction.js', 'public/js/home.js', 'public/js/home-workspace.js'
];
const sources = new Map();
for (const file of sourceFiles) sources.set(file, await readFile(path.join(root, file), 'utf8'));
const capturedFiles = ['ranking-service.js', 'ranking-pagination.js'];
const baselineFile = path.join(output, 'startup-server-baseline-sources.json');
let baselineCapture;
try { baselineCapture = JSON.parse(await readFile(baselineFile, 'utf8')); }
catch (error) {
    if (error.code !== 'ENOENT') throw error;
    baselineCapture = { schemaVersion: 1, capturedAt: new Date().toISOString(),
        files: capturedFiles.map(file => ({ file, sha256: hash(sources.get(file)), source: sources.get(file) })),
        dependencyFingerprints: [...sources].filter(([file]) => !capturedFiles.includes(file)
            && !['server.js', 'db.js', 'db-deadlines.js', 'public/js/home.js', 'public/js/home-workspace.js'].includes(file)
            && !file.startsWith('scripts/')).map(([file, source]) => ({ file, sha256: hash(source) })) };
    await mkdir(output, { recursive: true });
    await writeFile(baselineFile, JSON.stringify(baselineCapture, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}
assert.equal(baselineCapture.schemaVersion, 1);
same(baselineCapture.files.map(item => item.file), capturedFiles, 'Recorded baseline file set');
const baselineSources = new Map(sources);
for (const item of baselineCapture.files) {
    assert.equal(hash(item.source), item.sha256, 'Recorded baseline source hash');
    baselineSources.set(item.file, item.source);
}
for (const item of baselineCapture.dependencyFingerprints) assert.equal(hash(sources.get(item.file)), item.sha256,
    `Semantic dependency changed: ${item.file}; do not silently compare incompatible baselines`);
const evidence = (file, needle) => {
    const source = baselineSources.get(file);
    const offset = source.indexOf(needle);
    assert.ok(offset >= 0, `Evidence anchor disappeared: ${file}: ${needle}`);
    return { file, line: source.slice(0, offset).split('\n').length, anchor: needle };
};
const replaceOnce = (source, before, after) => {
    assert.equal(source.split(before).length, 2, `Candidate anchor must occur once: ${before.slice(0, 100)}`);
    return source.replace(before, after);
};

function meter() {
    const calls = [];
    return { calls, measure(name, operation) {
        const item = { name, start: performance.now() };
        calls.push(item);
        const end = () => { item.end = performance.now(); item.ms = round(item.end - item.start); };
        try {
            const result = operation();
            if (result && typeof result.then === 'function') return result.finally(end);
            end();
            return result;
        } catch (error) { end(); throw error; }
    } };
}

// Only the observed import/declaration syntax is supported; unknown syntax fails closed.
async function moduleVM(file, { transform = source => source, phases = [], metrics = meter(), sourceSnapshot = baselineSources } = {}) {
    let source = transform(sourceSnapshot.get(file));
    const bindings = {};
    const declaration = /^import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2;[^\n]*/gm;
    for (const match of source.matchAll(declaration)) {
        const reference = match[3];
        assert.ok(reference.startsWith('./') || reference === 'node:crypto', `Unexpected dependency: ${reference}`);
        const namespace = await import(reference.startsWith('.')
            ? new URL(reference, new URL(file, new URL('../', import.meta.url))).href : reference);
        const names = match[1].trim();
        const selections = names.startsWith('{') ? names.slice(1, -1).split(',').map(name => {
            const parts = name.trim().split(/\s+as\s+/);
            return [parts[1] ?? parts[0], parts[0]];
        }) : [[names, 'default']];
        for (const [local, imported] of selections) {
            assert.match(local, /^[A-Za-z_$][\w$]*$/);
            assert.ok(Object.hasOwn(namespace, imported), `${file}: missing ${imported}`);
            bindings[local] = ['createPercentileReference', 'groupComparisonModels', 'createSearchIndex',
                'loadScoreFieldCatalog', 'loadBenchmarkFamilies', 'loadFamilyPreferenceDefinitions'].includes(local)
                ? (...args) => metrics.measure(local, () => namespace[imported](...args)) : namespace[imported];
        }
    }
    const exports = [...source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map(match => match[1]);
    source = source.replace(declaration, '').replace(/^export\s+\{[^}]+\};\s*/gm, '').replace(/^export\s+/gm, '');
    for (const name of phases) {
        const definition = new RegExp(`(^|\\n)(async )?function ${name}\\(`, 'g');
        assert.equal([...source.matchAll(definition)].length, 1, `Missing phase ${name}`);
        source = source.replace(definition, `$1$2function __original_${name}(`);
        source += `\nfunction ${name}(...args) { return __measure('${name}', () => __original_${name}(...args)); }\n`;
    }
    const context = vm.createContext({ ...bindings, console, setTimeout, clearTimeout,
        __measure: metrics.measure.bind(metrics) });
    new vm.Script(`${source}\nglobalThis.__exports = { ${exports.join(', ')} };`, { filename: file }).runInContext(context);
    return { exports: context.__exports, metrics };
}

function metadataReuse(source) {
    source = replaceOnce(source, '{ conditionIDs = null, evidenceConditionIDs = null } = {}) {',
        '{ conditionIDs = null, evidenceConditionIDs = null, conditionDefinitions = null } = {}) {');
    const start = source.indexOf('    const [conditionRows] = await connection.execute(`');
    const end = source.indexOf('    const [rows] = await connection.execute(`', start);
    assert.ok(start >= 0 && end > start);
    const original = source.slice(start, end).trim().replace('const [conditionRows] = ', '').replace(/;$/, '');
    source = source.slice(0, start)
        + `    const conditionRows = conditionDefinitions === null ? (${original})[0] : conditionDefinitions;\n`
        + source.slice(end);
    return replaceOnce(source, 'evidenceConditionIDs: scoringConditionIDs });',
        `evidenceConditionIDs: scoringConditionIDs, conditionDefinitions: [...conditionsByID.values()].map(condition => ({
            benchmark_condition_ID: condition.conditionID, uses_percentage_scale: condition.usesPercentageScale,
            score_min: condition.scoreMin, score_max: condition.scoreMax,
            score_direction: condition.scoreDirection, target_value: condition.targetValue
        })) });`);
}

function emptyScopeReads(source) {
    for (const [name, next] of [['conditionRows', '    const [rows]'], ['rows', '    // Configuration IDs']]) {
        const start = source.indexOf(`    const [${name}] = await connection.execute(`, source.indexOf('export async function loadModels('));
        const end = source.indexOf(next, start);
        assert.ok(start >= 0 && end > start);
        const original = source.slice(start, end).trim().replace(`const [${name}] = `, '').replace(/;$/, '');
        source = source.slice(0, start)
            + `    const ${name} = conditionIDs?.length === 0 ? [] : (${original})[0];\n`
            + source.slice(end);
    }
    return source;
}

function lazySearch(source) {
    source = replaceOnce(source, 'snapshot.search = benchmarkSearchIndex(snapshot.benchmarks, familiesByEntrance);', 'snapshot.search = null;');
    return replaceOnce(source, 'const matches = query ? snapshot.search.rank(query) : [];',
        'const matches = query ? (snapshot.search ??= benchmarkSearchIndex(snapshot.benchmarks, snapshot.familiesByEntrance)).rank(query) : [];');
}

function indexedFamilyLookup(source) {
    source = replaceOnce(source, '    const publicFamilies = new Map(familyComposition.flatMap',
        '    const rowsByCondition = new Map(rows.map(row => [row.conditionID, row]));\n    const publicFamilies = new Map(familyComposition.flatMap');
    return replaceOnce(source, 'const primary = rows.find(row => row.conditionID === family.primaryConditionID);',
        'const primary = rowsByCondition.get(family.primaryConditionID);');
}

function dataFixture({ models = settings.models, conditions = settings.conditions } = {}) {
    const modelRows = Array.from({ length: models + 1 }, (_, index) => ({ model_ID: index + 1,
        model_name: `Model ${String(index + 1).padStart(4, '0')}`, introductionURL: null,
        vendor_name: index % 2 ? 'Lab B' : 'Lab A', vendor_slug: index % 2 ? 'lab-b' : 'lab-a', logo_key: null }));
    const conditionRows = Array.from({ length: conditions }, (_, index) => ({ condition_ID: index + 1,
        benchmark_ID: Math.floor(index / 2) + 1, condition_key: index % 2 ? 'legacy' : 'default',
        condition_name: index % 2 ? 'Legacy' : 'default', name: `Benchmark ${String(Math.floor(index / 2) + 1).padStart(4, '0')}`,
        introduction_url: null, is_default: Number(index % 2 === 0), is_primary: Number(index % 2 === 0),
        uses_percentage_scale: Number(index % 2 === 0), score_min: index % 2 ? 0 : null,
        score_max: index % 2 ? 100 : null, score_direction: ['higher', 'lower', 'closer_to_target'][index % 3],
        target_value: index % 3 === 2 ? 50 : null, tags: 'reasoning\nsynthetic', approved_score_count: 0, scored_model_count: 0 }));
    const fields = [{ ID: 1, name: 'Effort', type: 'number', allowEmpty: 0, excludeMissing: 0, excludeEmpty: 0, revision: 1 },
        { ID: 2, name: 'Harness', type: 'text', allowEmpty: 0, excludeMissing: 0, excludeEmpty: 0, revision: 1 },
        { ID: 3, name: 'Format', type: 'enum', allowEmpty: 0, excludeMissing: 0, excludeEmpty: 0, revision: 1 }];
    const fieldOptions = [1, 2].map(ID => ({ ID, fieldID: 3, label: `Format ${ID}`, excluded: 0, revision: 1 }));
    const results = [], rawIdentities = new Map();
    for (const condition of conditionRows) {
        const seen = new Set();
        for (let modelID = 1; modelID <= models; modelID++) for (const configuration of [1, 2]) {
            if ((modelID + condition.condition_ID + configuration) % 5 >= (condition.is_primary ? 3 : 2)) continue;
            seen.add(modelID);
            const values = [20 + modelID % 5, `${20 + modelID % 5}.0`, 80 - modelID % 5, 90];
            for (const [sample, raw_score] of values.entries()) {
                const assignments = [{ fieldID: 1, value: sample % 2 ? `${configuration}e0` : String(configuration) },
                    { fieldID: 2, value: 'same harness' }, { fieldID: 3, value: configuration }];
                const score_fields = JSON.stringify(sample % 2 ? [...assignments].reverse() : assignments);
                const row = { result_ID: results.length + 1, model_ID: modelID,
                    benchmark_condition_ID: condition.condition_ID, raw_score, score_fields };
                results.push(row);
                const key = JSON.stringify([modelID, score_fields]);
                if (!rawIdentities.has(key)) rawIdentities.set(key, { result_ID: row.result_ID, model_ID: modelID, score_fields });
            }
        }
        condition.approved_score_count = results.filter(row => row.benchmark_condition_ID === condition.condition_ID).length;
        condition.scored_model_count = seen.size;
    }
    const categories = [{ ID: 1, parent_ID: null, name: 'Intelligence', position: 1, owner_user_ID: null },
        { ID: 2, parent_ID: 1, name: 'Reasoning', position: 1, owner_user_ID: null },
        { ID: 3, parent_ID: 2, name: 'Logic', position: 1, owner_user_ID: null },
        { ID: 4, parent_ID: 1, name: 'Coding', position: 2, owner_user_ID: null }];
    const contexts = [{ ID: 10, category_ID: 1, context_values: {} }, { ID: 20, category_ID: 2, context_values: {} },
        { ID: 30, category_ID: 3, context_values: { budget: 'standard' } },
        { ID: 31, category_ID: 3, context_values: { budget: 'extended' } }, { ID: 40, category_ID: 4, context_values: {} }];
    const families = [{ familyID: 100, primaryConditionID: 1, entries: [{ kind: 'other_versions' }] },
        { familyID: 101, primaryConditionID: 3, entries: [{ conditionID: 4 }] },
        { familyID: 102, primaryConditionID: 1, entries: [{ conditionID: 2 }] }];
    const pies = [];
    for (const [contextID, count, recent, influence] of [[10, 12, 2, 12], [20, 15, 12, 14], [30, 3, 0, 2], [31, 4, 4, 4], [40, 2, 0, 0]]) {
        for (let index = 0; index < count; index++) {
            const ID = contextID * 100 + count - index;
            const primaryWeight = index % 2 ? 3000 : 7000;
            pies.push({ ID, contextID, userID: contextID === 10 && index === 0 ? '7' : String(ID),
                revision: 3, updatedAt: new Date(Date.UTC(2026, 9, 8, 0, 0, 0)
                    - (index < recent ? 0 : index < influence ? 5 : 20) * 86400000 - index * 1000),
                isRecent: index < recent, isInfluential: index < influence,
                entries: [{ conditionID: 1, weightBasisPoints: primaryWeight }, { conditionID: 3, weightBasisPoints: 10000 - primaryWeight }],
                familyID: index % 3 === 0 ? 100 : index % 3 === 1 ? 101 : 102 });
        }
    }
    pies.push({ ID: 4099, contextID: 40, userID: '4099', revision: 1, updatedAt: new Date('2026-10-08T00:00:00Z'),
        isRecent: true, isInfluential: true, entries: [], familyID: null });
    return { modelRows, conditionRows, fields, fieldOptions, results: results.reverse(),
        identities: [...rawIdentities.values()].reverse(), categories, contexts, families, pies };
}

function sqlFixture(data, { delayMs = 0, noPies = false, fail = null } = {}) {
    const events = [];
    let acquired = false, released = false, active = 0, maxActive = 0;
    const fallbackRows = (family, pieID) => family.entries.map((entry, index) => ({ pie_ID: pieID,
        family_ID: family.familyID, primary_benchmark_condition_ID: family.primaryConditionID,
        chain_hash: hash(familyKey(family.primaryConditionID, family.entries)), position: index + 1,
        fallback_benchmark_condition_ID: entry.conditionID ?? null }));
    const scopeRows = categoryID => {
        const descendants = new Map([[categoryID, categoryID]]);
        for (const category of data.categories) if (category.ID !== categoryID && descendants.has(category.parent_ID)) {
            descendants.set(category.ID, category.parent_ID === categoryID ? category.ID : descendants.get(category.parent_ID));
        }
        return data.contexts.filter(context => descendants.has(context.category_ID)).map(context => ({ ...context,
            context_values: JSON.stringify(context.context_values), source_category_ID: descendants.get(context.category_ID),
            source_category_name: data.categories.find(category => category.ID === descendants.get(context.category_ID)).name }));
    };
    function select(sql, params) {
        if (sql.includes('FROM categories') && sql.includes('categories.parent_ID <=> ?')) {
            return ['tree.children', data.categories.filter(category => category.parent_ID === params[0]).map(category => ({
                ID: category.ID, parentID: category.parent_ID, name: category.name, position: category.position,
                hasChildren: Number(data.categories.some(child => child.parent_ID === category.ID)) }))];
        }
        if (sql.startsWith('SELECT ID, parent_ID, name, position, owner_user_ID FROM categories WHERE ID = ?')) return ['context.lineage', data.categories.filter(row => row.ID === params[0])];
        if (sql.includes('SELECT COUNT(*) AS count FROM categories')) return ['context.children', [{ count: data.categories.filter(row => row.parent_ID === params[0]).length }]];
        if (sql.includes("name = 'Intelligence'")) return ['context.root', data.categories.filter(row => row.parent_ID === null)];
        if (sql.includes('FROM ranking_dimensions')) return ['context.dimensions', [{ ID: 1, scope_category_ID: 0, dimension_key: 'budget', name: 'Budget', position: 1 }]];
        if (sql.includes('FROM ranking_dimension_options')) return ['context.options', [{ dimension_ID: 1, option_key: 'standard', name: 'Standard', position: 1, is_default: 1, is_neutral: 1 },
            { dimension_ID: 1, option_key: 'extended', name: 'Extended', position: 2, is_default: 0, is_neutral: 0 }]];
        if (sql.includes('FROM ranking_contexts WHERE')) return ['context.identity', data.contexts.filter(context => context.category_ID === params[0]
            && ranking.serializeRankingContextValues(context.context_values).contextHash === params[1]).map(context => ({ ID: context.ID }))];
        if (sql.includes('WITH model_coverage AS')) {
            assert.ok(params[0] === 3 && !sql.includes('category_ID = ?'));
            return ['catalog.coverage', data.conditionRows];
        }
        if (sql.includes('WITH RECURSIVE category_scope AS')) return ['public.contexts', scopeRows(params[0])];
        if (sql.includes('FROM personal_pies') && sql.includes('JOIN users')) {
            const pies = noPies ? [] : data.pies.filter(pie => params.includes(pie.contextID))
                .sort((left, right) => left.contextID - right.contextID || right.updatedAt - left.updatedAt || right.ID - left.ID);
            return ['public.weights', pies.flatMap(pie => (pie.entries.length ? pie.entries : [{ conditionID: null, weightBasisPoints: null }]).map(entry => ({
                pie_ID: pie.ID, context_ID: pie.contextID, is_recent: Number(pie.isRecent), is_influence_recent: Number(pie.isInfluential),
                benchmark_condition_ID: entry.conditionID, weight_basis_points: entry.weightBasisPoints })))];
        }
        if (sql.includes('FROM personal_pies WHERE user_ID')) return ['personal.identity', (noPies ? [] : data.pies).filter(pie => pie.userID === params[0]
            && pie.contextID === params[1]).map(pie => ({ ID: pie.ID, revision: pie.revision, updated_at: pie.updatedAt }))];
        if (sql.includes('FROM personal_pie_weights')) return ['personal.weights', data.pies.find(pie => pie.ID === params[0]).entries.map(entry => ({
            benchmark_condition_ID: entry.conditionID, weight_basis_points: entry.weightBasisPoints })).sort((a, b) => b.weight_basis_points - a.weight_basis_points || a.benchmark_condition_ID - b.benchmark_condition_ID)];
        if (sql.includes('FROM personal_pie_score_rules rules')) return ['pie.fallbacks', (noPies ? [] : data.pies).filter(pie => params.includes(pie.ID) && pie.familyID !== null)
            .sort((a, b) => a.ID - b.ID).flatMap(pie => fallbackRows(data.families.find(family => family.familyID === pie.familyID), pie.ID))];
        if (sql.includes('SELECT DISTINCT p.user_ID, r.family_ID')) return ['family.preferences', (noPies ? [] : data.pies).filter(pie => pie.familyID !== null)
            .map(pie => ({ user_ID: pie.userID, family_ID: pie.familyID })).sort((a, b) => Number(a.user_ID) - Number(b.user_ID) || a.family_ID - b.family_ID)];
        if (sql.includes('FROM benchmark_families f LEFT JOIN')) return ['family.catalog', (noPies ? [] : data.families).flatMap(family => fallbackRows(family, undefined))];
        if (sql.includes('FROM score_fields WHERE')) return ['fields.definitions', [...data.fields].sort((a, b) => a.name.localeCompare(b.name) || a.ID - b.ID)];
        if (sql.includes('FROM score_field_options WHERE')) return ['fields.options', data.fieldOptions];
        if (sql.includes('FROM models JOIN organizations')) return ['models.metadata', data.modelRows];
        if (sql.includes('FROM benchmark_conditions') && sql.includes('uses_percentage_scale')) {
            assert.ok(sql.includes('WHERE ID IN (') || sql.includes('WHERE 0 = 1') || params.length === 0);
            return ['models.condition-metadata', data.conditionRows.filter(row => !sql.includes('0 = 1') && (!sql.includes(' IN (') || params.includes(row.condition_ID)))
                .map(row => ({ benchmark_condition_ID: row.condition_ID, uses_percentage_scale: row.uses_percentage_scale,
                    score_min: row.score_min, score_max: row.score_max, score_direction: row.score_direction, target_value: row.target_value }))];
        }
        if (sql.includes('MIN(benchmark_results.ID)')) {
            assert.ok(!sql.includes('benchmark_condition_ID IN'));
            return ['models.global-identities', data.identities];
        }
        if (sql.includes('FROM benchmark_results') && sql.includes('raw_score')) {
            assert.ok(sql.includes("benchmark_results.status = 'accepted'"));
            return ['models.scoped-scores', data.results.filter(row => !sql.includes('0 = 1') && (!sql.includes(' IN (') || params.includes(row.benchmark_condition_ID)))];
        }
        if (sql === 'SELECT DISTINCT family_ID FROM personal_pie_score_rules') return ['family.referenced-ids', (noPies ? [] : data.families).map(row => ({ family_ID: row.familyID }))];
        throw new Error(`Unrecognized fixture SQL: ${sql}`);
    }
    const connection = {
        async query(sql) {
            assert.ok(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'].includes(sql));
            const event = { kind: 'query', label: sql, start: performance.now() };
            events.push(event); await pause(delayMs); event.end = performance.now(); event.ms = round(event.end - event.start);
            return [[], []];
        },
        async execute(sql, params = []) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            assert.match(normalized, /^(SELECT|WITH)\b/);
            assert.doesNotMatch(normalized, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|FOR UPDATE)\b/i);
            assert.ok(!released, 'SQL after release');
            const [label, rows] = select(normalized, params);
            const event = { kind: 'execute', label, sql: normalized, params: [...params], rows: rows.length, start: performance.now() };
            events.push(event); active++; maxActive = Math.max(maxActive, active);
            try {
                await pause(delayMs);
                if (fail === label) throw new Error(`Injected ${label}`);
                return [structuredClone(rows), []];
            } finally { active--; event.end = performance.now(); event.ms = round(event.end - event.start); }
        },
        async commit() { events.push({ kind: 'commit', start: performance.now() }); await pause(delayMs); },
        async rollback() { events.push({ kind: 'rollback', start: performance.now() }); },
        release() { assert.ok(!released); released = true; events.push({ kind: 'release', start: performance.now() }); },
        destroy() { events.push({ kind: 'destroy', start: performance.now() }); }
    };
    return { connection, events, async getConnection() {
        assert.ok(!acquired); acquired = true; events.push({ kind: 'acquire', start: performance.now() }); return connection;
    }, summary() {
        const reads = events.filter(event => event.kind === 'execute');
        const acquire = events.find(event => event.kind === 'acquire');
        const release = events.find(event => event.kind === 'release');
        const commit = events.find(event => event.kind === 'commit');
        return { executeCount: reads.length, maxConcurrentExecute: maxActive, rowsReturned: reads.reduce((sum, event) => sum + event.rows, 0),
            lastReadToCommitMs: commit && reads.length ? round(commit.start - reads.at(-1).end) : null,
            leaseMs: acquire && release ? round(release.start - acquire.start) : null,
            reads: reads.map(({ start: _start, end: _end, ...event }) => event), lifecycle: events.filter(event => event.kind !== 'execute') };
    } };
}

const phases = ['resolveRankingContext', 'loadBenchmarkConditions', 'loadPublicPie', 'loadPersonalPie',
    'loadModels', 'buildBenchmarkList', 'scoreComparison', 'scoreModels', 'buildRankingWorkspace'];
const baseVM = await moduleVM('ranking-service.js', { phases });
const reuseVM = await moduleVM('ranking-service.js', { phases, transform: metadataReuse });
const emptyVM = await moduleVM('ranking-service.js', { phases, transform: emptyScopeReads });
const familyVM = await moduleVM('ranking-service.js', { phases, transform: indexedFamilyLookup });
const integratedVM = await moduleVM('ranking-service.js', { phases, transform: source => indexedFamilyLookup(metadataReuse(source)) });
const pagerVM = await moduleVM('ranking-pagination.js');
const lazyPagerVM = await moduleVM('ranking-pagination.js', { transform: lazySearch });
const currentPagerVM = await moduleVM('ranking-pagination.js', { sourceSnapshot: sources });
const small = dataFixture({ models: 8, conditions: 12 });
const large = dataFixture();
const report = { createdAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform,
    os: os.release(), architecture: process.arch, cpus: os.cpus().length, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    tree: 'dirty; inspected current working files, not only HEAD', target: 'offline fixtures; no real DB or network' }, settings,
    sourceFingerprints: [...sources].map(([file, source]) => ({ file, sha256: hash(source), bytes: Buffer.byteLength(source) })),
    baselineDetection: { baselineArtifact: 'startup-server-baseline-sources.json', capturedAt: baselineCapture.capturedAt,
        files: baselineCapture.files.map(item => ({ file: item.file, capturedSHA256: item.sha256,
            currentSHA256: hash(sources.get(item.file)), currentMatchesBaseline: hash(sources.get(item.file)) === item.sha256 })),
        rule: 'actual-export always executes current files; vm-baseline and candidate transforms execute recorded pre-fix sources. Changed hashes alone do not prove a fix; output parity and current work counts must pass.',
        baselineImmutable: true },
    fixture: { models: large.modelRows.length, conditions: large.conditionRows.length, results: large.results.length,
        rawConfigurationIdentities: large.identities.length, pies: large.pies.length, contexts: large.contexts.length },
    anchors: [evidence('server.js', "API.post('/get_page{/*path}'"), evidence('server.js', "API.post('/get_weighted_workspace'"),
        evidence('ranking-service.js', 'WITH model_coverage AS'), evidence('ranking-service.js', 'const [conditionRows] = await connection.execute'),
        evidence('ranking-service.js', '// Configuration IDs stay global'), evidence('ranking-service.js', 'export async function getRankingWorkspace'),
        evidence('ranking-service.js', 'const reference = scoreMode'), evidence('ranking-pagination.js', 'snapshot.search = benchmarkSearchIndex'),
        evidence('ranking-pagination.js', 'const MAX_SNAPSHOTS'), evidence('ranking-service.js', 'const primary = rows.find'),
        evidence('ranking-service.js', 'const storedFamilies = await loadBenchmarkFamilies'),
        evidence('ranking-service.js', 'const models = await loadModels(db, fields'),
        evidence('ranking-service.js', "await commitTransactionConnection(connection, 'RANKING WORKSPACE')"),
        evidence('public/js/home-workspace.js', 'const URLContextValues')],
    parentObservedSample: { source: 'User supplied public Chromium fresh sample; not measured by this sidecar',
        domContentLoadedMs: 3150, rankingsReadyMs: 6070, treeProfileComparisonResponsesMs: [258, 264],
        workspaceTTFBMs: 2398, workspaceTotalMs: 2532, wireKB: 110, renderingAfterResponseMs: 110 },
    parentOriginSample: { source: 'User supplied origin baseline; no probes performed here', loopbackWorkspaceSamples: 6,
        loopbackWorkspaceMs: [1330, 1990], publicOnlyOriginProbes: 26, staticMs: [1, 19], swapInUse: false,
        availableGiB: 2.3, load: 0.02 },
    parity: [], workspaceRuns: [], tree: [], pager: [], familyLookup: [], guards: [] };

async function runWorkspace(label, api, data, options, fixtureOptions = {}, metrics = null) {
    const db = sqlFixture(data, fixtureOptions);
    const first = metrics?.calls.length ?? 0;
    const start = performance.now();
    const workspace = await api.getRankingWorkspace(db, options);
    const ms = round(performance.now() - start);
    const trace = { label, ms, digest: digest(workspace), ...db.summary(),
        phases: metrics?.calls.slice(first).map(({ name, ms }) => ({ name, ms })) ?? [] };
    assert.equal(trace.lifecycle.filter(event => event.kind === 'commit').length, 1);
    assert.equal(trace.lifecycle.filter(event => event.kind === 'release').length, 1);
    assert.equal(trace.lifecycle.filter(event => event.kind === 'rollback' || event.kind === 'destroy').length, 0);
    return { workspace, trace };
}

const draft = { entries: [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 3, weightBasisPoints: 5000 }],
    fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ kind: 'other_versions' }] }] };
const cases = [
    ['guest-range', { categoryID: 1 }], ['member-range', { categoryID: 1, userID: '7' }],
    ['guest-draft-available', { categoryID: 1, previewPersonalPie: draft, scoreMode: 'available' }],
    ['member-available', { categoryID: 1, userID: '7', scoreMode: 'available' }],
    ['model-filter-available', { categoryID: 1, previewPersonalPie: draft, scoreMode: 'available', comparison: { mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: 1 }] } }],
    ['combined-config-available', { categoryID: 1, previewPersonalPie: draft, scoreMode: 'available', comparison: { mode: 'best', keys: ['model', 'field:1'] } }],
    ['matched-range', { categoryID: 1, userID: '7', comparison: { mode: 'matched', keys: ['model'] } }],
    ['matched-available', { categoryID: 1, userID: '7', scoreMode: 'available', comparison: { mode: 'matched', keys: ['model'] } }],
    ['leaf-context', { categoryID: 3, contextValues: { budget: 'extended' } }],
    ['omitted-category', {}]
];
for (const [label, options] of cases) {
    const actual = await runWorkspace(label, ranking, small, options);
    const baseline = await runWorkspace(label, baseVM.exports, small, options, {}, baseVM.metrics);
    const candidate = await runWorkspace(label, reuseVM.exports, small, options, {}, reuseVM.metrics);
    const family = await runWorkspace(label, familyVM.exports, small, options, {}, familyVM.metrics);
    const integrated = await runWorkspace(label, integratedVM.exports, small, options, {}, integratedVM.metrics);
    same(actual.workspace, baseline.workspace, `${label}: actual export / VM parity`);
    same(actual.workspace, candidate.workspace, `${label}: metadata reuse parity`);
    same(actual.workspace, family.workspace, `${label}: indexed family metadata parity`);
    same(actual.workspace, integrated.workspace, `${label}: combined narrow fixes preserve exact output`);
    if (label === 'guest-range') {
        assert.equal(actual.workspace.publicPie.participantCount, 32);
        same(actual.workspace.publicPie.composition.map(item => item.pieCount), [12, 20, 0], 'Independent fourteen-day influence');
        same(actual.workspace.publicPie.entries.map(item => [item.conditionID, item.weightBasisPoints]), [[1, 5042], [3, 4958]], 'Recent/all-or-top-ten sample weights');
        const sampled = actual.trace.reads.find(read => read.label === 'pie.fallbacks').params;
        same(sampled, [1012, 1011, 1010, 1009, 1008, 1007, 1006, 1005, 1004, 1003,
            2015, 2014, 2013, 2012, 2011, 2010, 2009, 2008, 2007, 2006, 2005, 2004,
            3003, 3002, 3001, 3104, 3103, 3102, 3101], 'Recent versus latest-ten selection');
    }
    if (label === 'guest-draft-available') assert.equal(actual.workspace.personalPie.fallbackRules[0].entries[0].versions[0].conditionID, 2);
    assert.equal(baseline.trace.executeCount - candidate.trace.executeCount, 1);
    report.parity.push({ label, digest: actual.trace.digest, actualExportMatchesVM: true, metadataReuseEqual: true,
        familyLookupEqual: true, savedMetadataReads: 1, currentExecuteCount: actual.trace.executeCount,
        currentNormalizationMetadataSQL: actual.trace.reads.filter(read => read.label === 'models.condition-metadata').length,
        integratedFixesEqual: true, integratedExecuteCount: integrated.trace.executeCount });
}
console.log(`Parity: ${report.parity.length} startup scenarios passed.`);
const simulatedIntegrated = await runWorkspace('post-fix-runnability-check', integratedVM.exports, small, { categoryID: 1 });
const simulatedPager = lazyPagerVM.exports.createRankingPager();
const beforeSimulation = lazyPagerVM.metrics.calls.length;
simulatedPager.create(simulatedIntegrated.workspace);
assert.equal(lazyPagerVM.metrics.calls.slice(beforeSimulation).filter(call => call.name === 'createSearchIndex').length, 0);
assert.equal(simulatedIntegrated.trace.executeCount, 14);
report.baselineDetection.postFixSimulation = { exactOutputCases: report.parity.length, defaultExecuteCount: 14,
    defaultNormalizationMetadataSQL: simulatedIntegrated.trace.reads.filter(read => read.label === 'models.condition-metadata').length,
    initialSearchBuilds: 0, usesCapturedBaselineAnchors: true, applicationFilesChanged: false };

for (let repeat = 1; repeat <= settings.repeat; repeat++) {
    for (const [label, options] of cases.slice(0, 1)) {
        for (const [variant, api, metrics] of [['actual-export', ranking, null], ['vm-baseline', baseVM.exports, baseVM.metrics],
            ['reuse-metadata', reuseVM.exports, reuseVM.metrics], ['indexed-family', familyVM.exports, familyVM.metrics]]) {
            const result = await runWorkspace(`${label}/${variant}/${repeat}`, api, large, options, {}, metrics);
            const prior = report.workspaceRuns.find(item => item.scenario === label);
            if (prior) assert.equal(result.trace.digest, prior.digest);
            report.workspaceRuns.push({ scenario: label, variant, repeat, ...result.trace });
            console.log(JSON.stringify({ scenario: label, variant, repeat, ms: result.trace.ms,
                reads: result.trace.executeCount, cpuHeldAfterLastSQLMs: result.trace.lastReadToCommitMs }));
        }
    }
}

const emptyBaseline = await runWorkspace('empty-scope/recorded-baseline', baseVM.exports, small, { categoryID: 1 }, { noPies: true, delayMs: settings.delayMs }, baseVM.metrics);
const emptyCandidate = await runWorkspace('empty-scope/skip-empty-reads', emptyVM.exports, small, { categoryID: 1 }, { noPies: true, delayMs: settings.delayMs }, emptyVM.metrics);
same(emptyBaseline.workspace, emptyCandidate.workspace, 'Empty scope must preserve global configurations and comparison catalog');
assert.equal(emptyBaseline.trace.executeCount - emptyCandidate.trace.executeCount, 2);
report.emptyScope = { baseline: emptyBaseline.trace, candidate: emptyCandidate.trace, fullOutputEqual: true };
const delayedBaseline = await runWorkspace('round-trip/recorded-baseline', baseVM.exports, small, cases[1][1], { delayMs: settings.delayMs }, baseVM.metrics);
const delayedCandidate = await runWorkspace('round-trip/reuse-metadata', reuseVM.exports, small, cases[1][1], { delayMs: settings.delayMs }, reuseVM.metrics);
same(delayedBaseline.workspace, delayedCandidate.workspace, 'Simulated latency must not change scores');
report.simulatedRoundTrip = { baseline: delayedBaseline.trace, candidate: delayedCandidate.trace,
    note: 'Delay is injected per fixture statement; not a MySQL latency or speedup measurement.' };

const loaded = await ranking.loadModels(sqlFixture(small).connection, null, { conditionIDs: [1, 2, 3, 4], evidenceConditionIDs: [1, 3] });
for (const model of loaded) for (const [conditionID, score] of model.results) {
    assert.equal(score.sampleCount, 3, 'Numeric duplicates count once; distinct normalized-equal raw scores remain distinct');
    assert.equal(typeof score.evidenceHash, ['1', '3'].includes(conditionID) ? 'string' : 'undefined');
}
assert.ok(loaded.some(model => model.ID < 0 && model.results.size === 0));
const full = await ranking.loadModels(sqlFixture(small).connection, null);
const scoped = await ranking.loadModels(sqlFixture(small).connection, null, { conditionIDs: [1, 3] });
same(scoped, full.map(model => ({ ...model, results: new Map([...model.results].filter(([ID]) => ['1', '3'].includes(ID))) })), 'Scoped evidence keeps global IDs, medians, hashes and metadata');
const referenceModels = await ranking.loadModels(sqlFixture(small).connection, null, { conditionIDs: small.conditionRows.map(row => row.condition_ID) });
const availableOptions = comparisonOptions(referenceModels);
const projected = groupComparisonModels(referenceModels, availableOptions, []);
const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
same(ranking.scoreComparison(referenceModels, entries, 10000, { scoreMode: 'available' }, availableOptions, projected),
    ranking.scoreComparison(referenceModels, entries, 10000, { scoreMode: 'available', percentileReference: createPercentileReference(projected) }, availableOptions, projected),
    'Explicit reference injection keeps inferred contribution and comparison evidence');
report.guards.push('Numeric aliases, unique-raw sample counts, stable global identities, evidence scope and no-score models retained.');

// Compile only the observed route text, never the server's startup/import body.
function treeRoute(db) {
    const source = sources.get('server.js');
    const start = source.indexOf('function normalizeURLPart(');
    const end = source.indexOf("API.post('/load_benchmarks_and_subcategories'", start);
    assert.ok(start > 0 && end > start);
    let route;
    const context = vm.createContext({ db, S: shared, assertCategoryName, API: { post(name, handler) {
        assert.equal(name, '/get_page{/*path}'); route = handler;
    } } });
    new vm.Script(source.slice(start, end), { filename: 'server.js:treeOnly-route' }).runInContext(context);
    return route;
}
for (const categoryPath of [[], ['Intelligence'], ['Intelligence', 'Reasoning', 'Logic'], ['Intelligence', 'Reasoning', 'Missing']]) {
    const db = sqlFixture(small, { delayMs: settings.delayMs });
    let response, failure;
    await treeRoute(db.connection)({ body: { treeOnly: true }, params: { path: categoryPath } }, { json(value) { response = value; } }, error => { failure = error; });
    const trace = db.summary();
    assert.ok(trace.reads.every(read => read.label === 'tree.children'));
    assert.equal(trace.executeCount, categoryPath.length === 0 ? 1 : categoryPath.at(-1) === 'Intelligence' ? 2 : 3);
    assert.equal(trace.lifecycle.length, 0, 'Tree has no explicit snapshot transaction');
    report.tree.push({ path: categoryPath.join('/'), status: failure?.status ?? 200,
        currentCategoryID: response?.currentCategoryID ?? null, ...trace });
}
const cleanup = sqlFixture(small, { fail: 'models.global-identities' });
await assert.rejects(ranking.getRankingWorkspace(cleanup, { categoryID: 1 }), /Injected/);
assert.deepEqual(cleanup.events.filter(event => ['commit', 'rollback', 'release', 'destroy'].includes(event.kind)).map(event => event.kind), ['rollback', 'release']);
report.guards.push('Injected SQL failure rolls back and releases; no fixture mutations are accepted.');

// Run the actual default routes with a guest session, excluding HTTP/session middleware.
const { loadReferencedBenchmarkFamilyIDs } = await import('../benchmark-family-service.js');
const routeLeases = [];
const routeDB = {
    async getConnection() {
        const fixture = sqlFixture(small);
        routeLeases.push(fixture);
        return fixture.getConnection();
    },
    async execute(sql, params) {
        const lease = await this.getConnection();
        try { return await lease.execute(sql, params); }
        finally { lease.release(); }
    }
};
const routePager = createRankingPager();
const routes = new Map();
const routeSource = sources.get('server.js');
const routeStart = routeSource.indexOf("API.post('/get_weighted_workspace'");
const routeEnd = routeSource.indexOf("API.post('/get_model_score_configurations'", routeStart);
assert.ok(routeStart > 0 && routeEnd > routeStart);
new vm.Script(routeSource.slice(routeStart, routeEnd), { filename: 'server.js:actual-default-workspace-and-pagination-routes' }).runInContext(vm.createContext({
    db: routeDB, activeSessionUserID: async () => null, getRankingWorkspace: ranking.getRankingWorkspace,
    rankingPager: routePager, loadReferencedBenchmarkFamilyIDs, API: { post(name, handler) { routes.set(name, handler); } }
}));
const routePayloads = [];
for (let repeat = 1; repeat <= 2; repeat++) {
    const headers = {};
    await routes.get('/get_weighted_workspace')({ body: { categoryID: 1, scoreMode: 'range', comparison: { mode: 'best', keys: ['model'] },
        initialMode: 'public', benchmarkQuery: '', pinPersonal: false, groupVersions: false } }, {
        set(name, value) { headers[name] = value; }, json(payload) { routePayloads.push(payload); }
    });
    assert.equal(headers['Cache-Control'], 'private, no-store');
}
same(routePayloads[0], routePayloads[1], 'Two actual unfiltered public default routes return equal contents');
assert.notEqual(routePayloads[0].rankingPagination.snapshotID, routePayloads[1].rankingPagination.snapshotID);
assert.deepEqual(routeLeases.map(lease => lease.summary().executeCount),
    Array(2).fill(report.parity.find(item => item.label === 'guest-range').currentExecuteCount));
const beforeContinuation = routeLeases.length;
await routes.get('/get_ranking_page')({ body: { snapshotID: routePayloads[1].rankingPagination.snapshotID, list: 'public', offset: 0 } }, { set() {}, json() {} });
assert.equal(routeLeases.length, beforeContinuation, 'Model continuation uses the pager, no workspace SQL');
await routes.get('/get_ranking_page')({ body: { snapshotID: routePayloads[1].rankingPagination.snapshotID, list: 'benchmarks', group: 'primary', offset: 0 } }, { set() {}, json() {} });
assert.equal(routeLeases.length, beforeContinuation + 1, 'Benchmark continuation checks referenced families, not full workspace');
assert.equal(routeLeases.at(-1).summary().reads[0].label, 'family.referenced-ids');
report.actualDefaultRoute = { session: 'Explicit guest stub; HTTP/session middleware is intentionally excluded', repeatedWorkspaces: routeLeases.slice(0, 2).map(lease => lease.summary()),
    exactPayloadEqualExceptSnapshotAndTime: true, distinctSnapshotIDs: true,
    modelContinuationSQL: 0, benchmarkContinuationSQL: 1, benchmarkContinuationLabel: 'family.referenced-ids' };

const familyConditions = Array.from({ length: Math.min(settings.pagerRows, 16000) }, (_, index) => ({
    conditionID: index + 1000, benchmarkID: index + 1000, name: `Family benchmark ${index}`,
    isPrimaryCondition: true, conditionName: 'default', isDefaultCondition: true, scoreCount: 100,
    scoredModelCount: 20, tags: ['synthetic']
}));
const familyRows = Array.from({ length: Math.min(Math.floor(familyConditions.length / 3), 3000) }, (_, index) => ({
    familyID: index + 2000, primaryConditionID: familyConditions[familyConditions.length - index - 1].conditionID,
    entries: [{ conditionID: familyConditions[index].conditionID }]
}));
for (let repeat = 1; repeat <= settings.repeat; repeat++) {
    const reference = ranking.buildBenchmarkList(familyConditions, [], [], familyRows);
    for (const [variant, api] of [['actual-export', ranking], ['vm-baseline', baseVM.exports], ['indexed-family', familyVM.exports]]) {
        const start = performance.now();
        const rows = api.buildBenchmarkList(familyConditions, [], [], familyRows);
        const ms = round(performance.now() - start);
        same(rows, reference, `${variant}: family primary metadata, ranks and order`);
        report.familyLookup.push({ variant, repeat, conditions: familyConditions.length, families: familyRows.length, ms,
            digest: digest(rows), baselinePredicateVisits: familyRows.reduce((sum, row) => sum + row.primaryConditionID - 999, 0),
            candidateMapLookups: familyRows.length,
            note: 'Synthetic scale test; current production referenced-family count is unknown.' });
    }
}

const seed = (await runWorkspace('pager-seed', ranking, small, { categoryID: 1, userID: '7' })).workspace;
const pagerWorkspace = { ...seed, benchmarks: Array.from({ length: settings.pagerRows }, (_, index) => ({
    ...seed.benchmarks.find(row => !row.isFamily), ID: index + 1000, conditionID: index + 1000,
    benchmarkID: index + 1000, name: `Synthetic benchmark ${String(index).padStart(5, '0')}`, rank: index + 1,
    publicWeightBasisPoints: 0, publicWeight: 0, personalWeightBasisPoints: null, personalWeight: null
})) };
pagerWorkspace.benchmarks.push(...seed.benchmarks.filter(row => row.isFamily || row.conditionID <= 4));
for (let repeat = 1; repeat <= settings.repeat; repeat++) {
    const baselines = [];
    for (const [variant, factory, metrics] of [['actual-export', createRankingPager, null], ['current-vm', currentPagerVM.exports.createRankingPager, currentPagerVM.metrics],
        ['vm-baseline', pagerVM.exports.createRankingPager, pagerVM.metrics],
        ['lazy-search', lazyPagerVM.exports.createRankingPager, lazyPagerVM.metrics]]) {
        const firstCall = metrics?.calls.length ?? 0;
        const pager = factory();
        const start = performance.now();
        const first = pager.create(pagerWorkspace, { userID: '7' });
        const createMs = round(performance.now() - start);
        const initialBuilds = metrics?.calls.slice(firstCall).filter(call => call.name === 'createSearchIndex').length;
        const pages = [];
        for (const args of [{ list: 'benchmarks', group: 'primary', offset: 40 }, { list: 'public', offset: 0 }, { list: 'personal', offset: 0 },
            { list: 'benchmarks', group: 'primary', query: 'Synthetic benchmark 21200' }, { list: 'benchmarks', group: 'primary', query: 'synthetik' },
            { list: 'benchmarks', group: 'primary', query: 'Benchmark 0001', pinPersonal: true, groupVersions: true },
            { list: 'fallbacks', conditionID: 1 }]) {
            pages.push(pager.getPage({ snapshotID: first.rankingPagination.snapshotID, userID: '7', ...args }));
        }
        pager.retainReferencedFamilies([101]);
        pages.push(pager.getPage({ snapshotID: first.rankingPagination.snapshotID, userID: '7', list: 'benchmarks', group: 'primary', query: 'Benchmark 0001' }));
        pages.push(pager.getPage({ snapshotID: first.rankingPagination.snapshotID, userID: '7', list: 'fallbacks', conditionID: 1 }));
        if (baselines.length) { same(first, baselines[0].first, `${variant}: initial first-page equality`); same(pages, baselines[0].pages, `${variant}: continuation/search/pin/family-cleanup equality`); }
        baselines.push({ first, pages });
        report.pager.push({ variant, repeat, catalogueRows: pagerWorkspace.benchmarks.length, createMs,
            initialSearchBuilds: initialBuilds ?? null, firstPageDigest: digest(first), pagesDigest: digest(pages),
            responseBytes: Buffer.byteLength(JSON.stringify(first)), calls: metrics?.calls.slice(firstCall).map(({ name, ms }) => ({ name, ms })) ?? [] });
    }
}
const boundedPager = createRankingPager();
const ids = Array.from({ length: 13 }, () => boundedPager.create(seed).rankingPagination.snapshotID);
assert.throws(() => boundedPager.getPage({ snapshotID: ids[0], list: 'public' }), error => error.body?.error === 'ranking_snapshot_expired');
assert.doesNotThrow(() => boundedPager.getPage({ snapshotID: ids[1], list: 'public' }));
report.snapshotCapacity = { created: 13, retained: 12, firstEvicted: true,
    meaning: 'Deterministic bounded global cache policy; live retry frequency is unmeasured, not a proven startup incident.' };
report.baselineDetection.currentWork = {
    defaultExecuteCount: report.parity.find(item => item.label === 'guest-range').currentExecuteCount,
    defaultNormalizationMetadataSQL: report.parity.find(item => item.label === 'guest-range').currentNormalizationMetadataSQL,
    initialSearchBuildCounts: report.pager.filter(item => item.variant === 'current-vm').map(item => item.initialSearchBuilds),
    legacyLinearFamilyLookupPresent: sources.get('ranking-service.js').includes('const primary = rows.find(row => row.conditionID === family.primaryConditionID);')
};

// Fingerprints catch parent edits that would make a mixed-source run misleading.
for (const [file, original] of sources) assert.equal(await readFile(path.join(root, file), 'utf8'), original, `Source changed during run: ${file}; rerun against one revision`);
report.guards.push('All inspected source fingerprints stayed unchanged during the run.');
const byScenario = (scenario, variant) => report.workspaceRuns.filter(run => run.scenario === scenario && run.variant === variant).map(run => run.ms).join(', ');
const lines = [
    '# Startup Server Offline Review', '',
    `Generated: ${report.createdAt}. Node ${process.version}; ${process.platform}/${process.arch}; commit ${report.environment.commit} plus dirty working files.`, '',
    'No real database, production query, browser/network request, application edit or deployment was performed.', '',
    '## Reproduce', '',
    '```powershell', 'node scripts/review-startup-server-20261008.mjs', '```', '',
    'Optional bounded arguments: `--repeat=2 --models=180 --conditions=240 --pager-rows=21325 --delay-ms=2`.', '',
    '## Reuse After Integration', '',
    '`startup-server-baseline-sources.json` stores immutable pre-fix source text and SHA-256 for ranking-service.js and ranking-pagination.js. It is created only when absent (exclusive create), never refreshed by ordinary reruns. Keep it with the runner.', '',
    'The same command remains runnable after the three narrow fixes. Actual imports and current-vm execute current application files; vm-baseline and all transforms execute the recorded pre-fix source. Baseline/current detection compares per-file hashes, then measures current normalization SELECT count, first-page search-index builds and the legacy family rows.find marker. A changed hash alone is reported as changed source, not a successful fix. Exact current-vs-baseline output assertions remain mandatory; changed semantic dependency hashes fail explicitly.', '',
    'The three fixes were also composed in VM: ten exact-output cases pass, default fixture reads become 14, first-page search builds become zero. No application file was changed to perform this post-fix check.', '',
    `Current work detection: ${JSON.stringify(report.baselineDetection.currentWork)}.`, '',
    `Structured fixture: ${report.fixture.results} accepted observations, ${report.fixture.models} active models (one without scores), ${report.fixture.conditions} conditions, ${report.fixture.rawConfigurationIdentities} raw configuration identities, ${report.fixture.pies} pies in five contexts. These are synthetic counts, not a production inventory.`, '',
    '## Deterministic Findings', '',
    '### 1. Eager full-catalog search index on an unfiltered first page', '',
    `Source: ranking-pagination.js:${evidence('ranking-pagination.js', 'snapshot.search = benchmarkSearchIndex').line} (eager build), :${evidence('ranking-pagination.js', 'const matches = query').line} (empty query does not use it), :${evidence('ranking-pagination.js', 'updateBenchmarkCatalogue(snapshot, workspace.benchmarks)').line} (every snapshot).`, '',
    '`ranking-pagination.js` builds the search index during every snapshot creation, although an empty query never reads it. The VM-only lazy candidate builds on first nonempty query and invalidates on family cleanup. Exact initial pages and nine continuation/search/fallback results match the real export, including ordering, pinning, version grouping and evidence.', '',
    '| Variant | Repeat | Initial create ms | Initial index builds | Catalog rows |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.pager.map(run => `| ${run.variant} | ${run.repeat} | ${run.createMs} | ${run.initialSearchBuilds ?? 'uninstrumented'} | ${run.catalogueRows} |`), '',
    'This shifts first-search work; it does not remove full-catalog ranking/ordering. A nonempty initial search still needs the index.', '',
    '### 2. Repeated normalization metadata SELECT in the same snapshot', '',
    `Source: ranking-service.js:${evidence('ranking-service.js', 'SELECT benchmark_conditions.ID AS condition_ID').line} (initial metadata) and :${evidence('ranking-service.js', 'const [conditionRows] = await connection.execute').line} (repeated scoped SELECT).`, '',
    '`loadBenchmarkConditions` already returns percentage/range/direction/target metadata for every eligible condition. `loadModels` later issues a second SELECT of those fields for the exact scoring scope. Reusing this snapshot-local map removes one statement in all ten scenarios, with exact workspace equality. No global cache or schema is required. Public/personal fallback expansion and available-mode reference scope remain intact.', '',
    '### 3. Linear primary-row lookup for every global referenced family', '',
    `Source: ranking-service.js:${evidence('ranking-service.js', 'const storedFamilies = await loadBenchmarkFamilies').line} (global referenced catalog) and :${evidence('ranking-service.js', 'const primary = rows.find').line} (per-family scan).`, '',
    '`buildBenchmarkList` calls rows.find for each referenced family even though the base condition rows have unique condition IDs and never change. A request-local Map removes this O(conditions * families) lookup component. VM-only indexing preserves all ten workspace outputs and exact family metadata/ranks/order in the scale test. Applicability depends on the live global referenced-family count; it is not evidence of a current multi-second cause.', '',
    '| Variant | Repeat | Conditions | Families | Build ms |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.familyLookup.map(item => `| ${item.variant} | ${item.repeat} | ${item.conditions} | ${item.families} | ${item.ms} |`), '',
    '### Conditional Empty-Score-Scope Work', '',
    '`loadModels` sends `WHERE 0 = 1` metadata and `AND 0 = 1` evidence SELECTs when no personal/public weights exist. VM-only short-circuiting removes these two statements and preserves all global identity, field-validation and comparison-model metadata work. Entire workspace output remains equal.', '',
    '## Startup Path And Lifetime', '',
    '- The actual tree-only route executes only category-child queries: empty path one; Intelligence two; Intelligence/Reasoning/Logic three. It reads no score or benchmark catalog and creates no transaction snapshot. Path depth makes these queries sequential. A category-only bulk-read rewrite would need privacy/inactive/category-path proof; no such patch is proposed here.',
    '- Each workspace acquires one connection, sends SET isolation and START consistent read-only snapshot, then sequential reads. Commit follows complete ranking assembly; release is in finally. Fixture max concurrent execute is one. Promise.all on the same MySQL connection is not a justified round-trip saving.',
    '- The last identity SELECT is followed by sample aggregation, evidence hashes, grouping and scoring before commit. The measured last-read-to-commit interval is CPU held inside the lease, not a lock or DB time claim. The configured pool limit is ten. Splitting read/assembly could release earlier but is not validated as a repair by this sidecar.',
    '- Pager rank/search/index/serialization work is outside the DB lease. The server calls pager.create only after getRankingWorkspace returns. Snapshots cache continuations, not get_weighted_workspace; repeated requests still repeat all workspace queries.',
    `- The extracted actual unfiltered public default route was run twice: both do ${report.actualDefaultRoute.repeatedWorkspaces[0].executeCount} reads and create different snapshot IDs with equal payload contents. Model continuation does zero SQL; benchmark continuation does one referenced-family-ID query. The guest/session stub excludes Express/session-store middleware from this proof.`,
    '- Thirteen sequential snapshots evict the first of a globally bounded twelve. This may contribute to retries under load, but no current live eviction rate or startup impact was measured.', '',
    '## Synthetic CPU Measurements', '',
    '| Scenario | Actual export ms | VM baseline ms | Reuse metadata ms | Indexed family ms |',
    '| --- | --- | --- | --- | --- |',
    `| guest-range | ${byScenario('guest-range', 'actual-export')} | ${byScenario('guest-range', 'vm-baseline')} | ${byScenario('guest-range', 'reuse-metadata')} | ${byScenario('guest-range', 'indexed-family')} |`, '',
    'These CPU samples are taken after small parity cases have warmed the process. They are not cold-process or cold-DB startup measurements. Each workspace still has fresh request-local structures and a new read-only fixture lease.', '',
    'Read-return time includes fixture selection and structuredClone. No fake MySQL execution plan or row-scan cost is inferred. VM transforms and instrumentation add overhead; work-count reduction is stronger evidence than small wall-time differences. Explicit delay cases are simulated statement round trips only.', '',
    '## Preserve These Semantics', '',
    '- Global MIN(result ID) identities must survive scoped scores and canonical numeric/field-order aliases. Models without scores remain visible in comparison metadata. They cannot be arbitrarily LIMITed to the first 25 ranked rows.',
    '- Range mode is already evidence-scoped. Available mode intentionally loads other catalog scores for mean-percentile inference; scoring-only pruning can change estimates. Evidence hashes remain limited to actual scoring/fallback scope.',
    '- Public samples use all 72-hour valid pies when there are at least ten; otherwise latest-ten valid pies, including old samples. Influence is a separate 14-day count. The fixture covers 2/12, 12/14, 0/2, 4/4 and inactive/empty contexts. A plain 72-hour/14-day WHERE cut would change output or invariant checking.',
    '- Referenced families, all-user automatic-version preferences, first-present ordered chains, raw-score deduplication before median, and distinct-raw equal-normalized samples are retained.',
    '- Full benchmark coverage catalog and model/field catalogs serve search/add controls and comparison metadata. Pagination of the response is not permission to omit them from the underlying snapshot.', '',
    '## Remaining Unknowns', '',
    'The parent supplied a fresh public Chromium sample: DOMContentLoaded 3.15 s, rankings ready 6.07 s, tree/profile/comparison about 258-264 ms, workspace TTFB 2398 ms / total 2532 ms / wire 110 KB, rendering after response about 110 ms. This sidecar did not measure that sample. The parent independently owns read-only loopback/origin measurements, browser traces and rollout.', '',
    'Subsequent parent baseline: six loopback workspace requests 1.33-1.99 s; 26 public-only origin probes with static responses 1-19 ms; no VM swap, about 2.3 GiB available memory and load about 0.02. These are parent-supplied observations, not measurements made here. They do not identify a particular SQL or CPU phase.', '',
    'No current origin phase timings, query plans, DB buffer-cache warmth, table cardinalities, referenced-family count, pool pressure or middleware/session-store duration were collected here. URL-context/draft ordering and available-mode work were not pursued as causes of the latest unfiltered public Model/ScoreRange sample.', '',
    'Candidate integration priority: validate lazy search indexing and request-local normalization metadata reuse against observed origin phases. Indexed family lookup has exact-output proof, but expected benefit requires the live family count. Do not introduce a cross-request cache without an invalidation/security/freshness contract.', '',
    '## Source Evidence', '',
    'For the two captured application modules, the following lines refer to the recorded pre-fix source, even when current source hashes differ after integration.', '',
    ...report.anchors.map(anchor => `- ${anchor.file}:${anchor.line}: \`${anchor.anchor}\`.`), '',
    'SQL traces, CPU phases, output digests, lifecycle checks and UTF-8 source hashes are in `startup-server-results.json`. Structured fixture generation and candidate transforms are executable in the single owned script; they do not write application files.', ''
];
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'startup-server-results.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
await writeFile(path.join(output, 'startup-server-report.md'), lines.join('\n'), 'utf8');
console.log(JSON.stringify({ result: 'pass', parityCases: report.parity.length, workspaceRuns: report.workspaceRuns.length,
    artifacts: ['startup-server-results.json', 'startup-server-report.md'], realDatabaseQueries: 0, applicationEdits: 0 }));
