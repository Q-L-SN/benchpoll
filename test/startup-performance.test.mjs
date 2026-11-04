import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadModels } from '../ranking-service.js';
import { createRankingPager } from '../ranking-pagination.js';

const espree = createRequire(import.meta.url)('espree');
const origin = 'https://startup.invalid';
const html = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
const links = [...html.matchAll(/<link\s+rel="([^"]+)"\s+href="([^"]+)"[^>]*>/g)]
    .map(([, rel, href]) => ({ rel, href }));

test('missing-score help distinguishes whole-index adjustment from fixed measured range scenarios', () => {
    const help = html.match(/<button class="bp-scoring-help[^>]*data-help-text="([^"]+)"/)?.[1];
    assert.ok(help);
    assert.match(help, /Estimated score combines available results and estimates/);
    assert.match(help, /Score range keeps measured results fixed/);
    assert.match(help, /adjusts the whole index for measured coverage/);
    assert.match(help, /fills gaps with 0 or 100/);
});

test('homepage preload hints exactly match reachable module URL identities without executing new modules', async () => {
    const hints = links.filter(link => link.rel === 'modulepreload').map(link => link.href);
    assert.equal(new Set(hints).size, hints.length);
    assert.equal(hints.length, 17);
    assert.equal(hints.some(href => /comparison-profile-menu/.test(href)), false);
    const reachable = new Set();
    const walk = async href => {
        if (reachable.has(href)) return;
        reachable.add(href);
        const url = new URL(href, origin);
        assert.equal(url.origin, origin);
        const source = await readFile(new URL(`../public${url.pathname}`, import.meta.url), 'utf8');
        const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        for (const node of ast.body) {
            if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue;
            const dependency = new URL(node.source.value, url);
            await walk(dependency.pathname + dependency.search);
        }
    };
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"\s+type="module"/g)].map(([, href]) => href);
    assert.deepEqual(scripts, ['/js/discussion.js?v=discussion-replies-20261016',
        '/js/home.js?v=comparison-experiment-20261007', '/js/home-workspace.js?v=fallback-controls-20261009']);
    for (const href of scripts) await walk(href);
    for (const href of hints) assert.ok(reachable.has(href), `Unreachable preload creates a duplicate or unnecessary fetch: ${href}`);
    assert.ok(hints.includes('/js/shared/write-intent.js?v=write-replay-20261008'));
    assert.ok(hints.includes('/js/vendor/fuse-7.5.0.js'));
});

test('direct homepage stylesheet links preserve the original cascade and URL identity', async () => {
    const wrapper = await readFile(new URL('../public/css/home-v2.css', import.meta.url), 'utf8');
    const imports = [...wrapper.matchAll(/@import\s+url\(['"]([^'"]+)['"]\)/g)].map(([, href]) => {
        const url = new URL(href, `${origin}/css/home-v2.css`);
        return url.pathname + url.search;
    });
    const styles = links.filter(link => link.rel === 'stylesheet' && link.href !== '/css/ui/private-topic-editor.css').map(link => link.href);
    assert.equal(new Set(styles).size, styles.length);
    assert.equal(styles.includes('/css/home-v2.css?v=comparison-experiment-20261007'), false);
    const start = styles.indexOf(imports[0]);
    assert.deepEqual(styles.slice(start, start + imports.length), imports);
    assert.deepEqual(styles.slice(0, start), ['/vendor/fontawesome/css/all.min.css', '/css/global.css?v=help-popovers-20261008']);
    assert.equal(styles.filter(href => href !== '/css/ui/private-topic-editor.css')[start + imports.length], '/css/discussion.css?v=discussion-replies-20261016');
});

function pagerFixture(onIndex) {
    const row = (conditionID, name) => ({ conditionID, ID: conditionID,
        name: { toString() { onIndex(); return name; }, localeCompare(other) { return name.localeCompare(String(other)); } },
        conditionName: 'default', lowCoverage: false, isPrimaryCondition: true, scoreCount: 3, publicWeightBasisPoints: 0 });
    const entrance = row(1, 'Alpha');
    return { scoreMode: 'range', personalPie: { entries: [], fallbackRules: [] },
        benchmarks: [entrance, row(2, 'Beta'), { ...entrance, isFamily: true, familyID: 9,
            familyKey: 'family-nine', familyEntries: [{ name: 'Unique family token', conditionName: 'default' }] }],
        modelLeaderboards: { personal: [], public: [] } };
}

test('unfiltered pages skip search indexing; first search builds once and cleanup invalidates it', () => {
    let visits = 0;
    const pager = createRankingPager();
    const first = pager.create(pagerFixture(() => visits++));
    const snapshotID = first.rankingPagination.snapshotID;
    assert.equal(visits, 0);
    const search = query => pager.getPage({ snapshotID, list: 'benchmarks', group: 'primary', query });
    search(''); search('   ');
    pager.getPage({ snapshotID, list: 'public' });
    assert.equal(visits, 0);
    assert.deepEqual(search('unique family token').items.map(row => row.conditionID), [1]);
    assert.equal(visits, 2);
    assert.deepEqual(search('beta').items.map(row => row.conditionID), [2]);
    assert.equal(visits, 2);
    pager.retainReferencedFamilies([]);
    assert.equal(visits, 2);
    assert.equal(search('unique family token').items.length, 0);
    assert.equal(visits, 4);
    search('beta');
    assert.equal(visits, 4);
});

test('a nonempty initial query creates the index before returning the correct first page', () => {
    let visits = 0;
    const first = createRankingPager().create(pagerFixture(() => visits++), { query: 'beta' });
    assert.equal(visits, 2);
    assert.deepEqual(first.benchmarks.map(row => row.conditionID), [2]);
});

const conditions = [
    { benchmark_condition_ID: 1, uses_percentage_scale: true, score_direction: 'higher', score_min: null, score_max: null, target_value: null },
    { benchmark_condition_ID: 2, uses_percentage_scale: false, score_direction: 'lower', score_min: '-10', score_max: '30', target_value: null },
    { benchmark_condition_ID: 3, uses_percentage_scale: false, score_direction: 'closer_to_target', score_min: '-2', score_max: '2', target_value: '0' }
];
const observations = [
    { result_ID: 11, benchmark_condition_ID: 1, raw_score: '30' },
    { result_ID: 12, benchmark_condition_ID: 1, raw_score: '30.00' },
    { result_ID: 13, benchmark_condition_ID: 1, raw_score: '80' },
    { result_ID: 14, benchmark_condition_ID: 2, raw_score: '-20' },
    { result_ID: 15, benchmark_condition_ID: 3, raw_score: '0.5' },
    { result_ID: 16, benchmark_condition_ID: 3, raw_score: '-0.5' },
    { result_ID: 17, benchmark_condition_ID: 3, raw_score: '1.5' }
].map(row => ({ ...row, model_ID: 1, score_fields: [] }));
function modelFixture() {
    const queries = [];
    return { queries, async execute(sql, params = []) {
        queries.push(sql);
        if (sql.includes('FROM models JOIN')) return [[{ model_ID: 1, model_name: 'Scored', vendor_name: 'Lab' },
            { model_ID: 2, model_name: 'No scores', vendor_name: 'Lab' }]];
        if (sql.includes('FROM benchmark_conditions')) return [structuredClone(conditions.filter(condition =>
            !sql.includes('0 = 1') && (!sql.includes('IN (') || params.includes(condition.benchmark_condition_ID))))];
        if (sql.includes('MIN(benchmark_results.ID)')) return [[{ model_ID: 1, result_ID: 11, score_fields: [] }]];
        if (sql.includes('FROM benchmark_results')) return [structuredClone(observations.filter(row =>
            !sql.includes('0 = 1') && (!sql.includes(' IN (') || params.includes(row.benchmark_condition_ID))))];
        throw new Error(`Unexpected query: ${sql}`);
    } };
}

for (const scope of [null, [], [1], [1, 2, 3]]) {
    test(`snapshot-local metadata preserves normalized medians, identities and evidence for scope ${JSON.stringify(scope)}`, async () => {
        const baseline = await loadModels(modelFixture(), [], { conditionIDs: scope, evidenceConditionIDs: [1, 3] });
        const db = modelFixture();
        const definitions = structuredClone(conditions.filter(condition => scope === null || scope.includes(condition.benchmark_condition_ID)));
        const immutable = structuredClone(definitions);
        const result = await loadModels(db, [], { conditionIDs: scope, evidenceConditionIDs: [1, 3], conditionDefinitions: definitions });
        assert.deepEqual(result, baseline);
        assert.deepEqual(definitions, immutable);
        assert.ok(db.queries.every(sql => !sql.includes('FROM benchmark_conditions')));
        assert.equal(result.find(model => model.modelID === 2).results.size, 0);
    });
}

test('invalid snapshot-local definitions fail before SQL; missing result metadata fails closed', async () => {
    const db = { execute() { throw new Error('Validation must precede SQL'); } };
    for (const conditionDefinitions of [{}, [null], [{}], [{ benchmark_condition_ID: '1' }],
        [{ benchmark_condition_ID: 0 }], [conditions[0], conditions[0]]]) {
        await assert.rejects(loadModels(db, [], { conditionDefinitions }),
            error => error.body?.error === 'invalid_condition_definitions');
    }
    await assert.rejects(loadModels(modelFixture(), [], { conditionIDs: [1], conditionDefinitions: [] }),
        error => error.body?.error === 'accepted_result_condition_unavailable');
});
