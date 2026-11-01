import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseURL = process.env.BENCHPOLL_VERIFY_URL ?? 'https://benchpoll.com';
const output = 'artifacts/arena-current-scores-20261003/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = {};
async function post(path, body) {
    const response = await page.request.post(`${baseURL}/api/${path}`, { data: body, timeout: 120000 });
    assert.equal(response.status(), 200, `${path}: ${await response.text()}`);
    return response.json();
}
try {
    const loaded = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'), { timeout: 120000 });
    const home = await page.goto(baseURL, { waitUntil: 'commit', timeout: 60000 });
    assert.equal(home.status(), 200);
    const workspaceResponse = await loaded;
    assert.equal(workspaceResponse.status(), 200);
    const workspace = await workspaceResponse.json();
    const catalog = await post('get_contribution_catalog', {});
    const managed = catalog.benchmarks.flatMap(benchmark => benchmark.conditions
        .filter(condition => condition.scoreSource === 'arena_official').map(condition => ({ benchmark, condition })));
    assert.ok(managed.length > 0);
    assert.ok(catalog.benchmarks.every(benchmark => benchmark.conditions.every(condition => Object.hasOwn(condition, 'scoreSource'))));
    const selected = managed.find(item => item.condition.scoreCount >= 3);
    assert.ok(selected);
    const results = [];
    for (const scoreMode of ['range', 'available']) {
        const ranking = await post('get_weighted_workspace', { categoryID: workspace.context.categoryID,
            contextValues: {}, initialMode: 'personal', scoreMode,
            previewPersonalPie: { entries: [{ conditionID: selected.condition.ID, weightBasisPoints: 10000 }], fallbackRules: [] } });
        const models = ranking.modelLeaderboards.personal;
        assert.ok(models.length > 0, 'A synced condition must produce a ranking');
        assert.ok(models[0].calculationScores.some(score => score.conditionID === selected.condition.ID));
        if (scoreMode === 'available') assert.equal(models[0].lower, models[0].upper);
        const pageData = await post('get_ranking_page', { snapshotID: ranking.rankingPagination.snapshotID,
            list: 'personal', offset: 0 });
        assert.ok(pageData.items.length > 0);
        results.push({ scoreMode, returnedModels: models.length, totalModels: pageData.total,
            firstModel: models[0].name, firstScore: models[0].lower });
    }
    const evidence = await post('get_approved_benchmark_results', { modelID: catalog.models[0].ID, scoreFields: [] });
    assert.ok(Array.isArray(evidence.scoreGroups));
    const rules = await page.request.get(`${baseURL}/how-it-works`);
    assert.equal(rules.status(), 200);
    assert.match(await rules.text(), /Do historical Arena scores affect today's ranking/);
    const contribution = await page.request.get(`${baseURL}/contribute/scores/new`);
    assert.equal(contribution.status(), 200);
    assert.match(await contribution.text(), /arena-current-scores-20261003/);
    await page.locator('.bp-benchmark-row').first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
    Object.assign(report, { passed: true, catalogManagedConditions: managed.length,
        previewBenchmark: selected.benchmark.name, modes: results, evidenceGroups: evidence.scoreGroups.length,
        browserErrors: errors, productionSubmissions: 0 });
    await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
} finally { await context.close(); await browser.close(); }
