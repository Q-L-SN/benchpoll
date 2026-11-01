import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const output = resolve('D:/Codex-artifacts/website1/available-score-upgrade-20261012');
const report = { checkedAt: new Date().toISOString(), businessWrites: 0, cases: [], browsers: [] };
async function check(name, body, { method, status = 200 } = {}) {
    const start = performance.now(), response = await fetch('https://benchpoll.com/api/get_weighted_workspace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
    });
    assert.equal(response.status, status, name);
    const payload = await response.json();
    if (status === 200) {
        validateWorkspacePayload(payload, { initialMode: body.initialMode ?? 'public' });
        if (method) assert.ok(payload.modelLeaderboards[body.initialMode ?? 'public']
            .filter(row => row.availableInference).every(row => row.availableInference.method === method));
        await writeFile(join(output, `${name}.json`), JSON.stringify(payload));
    }
    report.cases.push({ name, status, totalMs: performance.now() - start });
    return payload;
}
const baseline = await check('live-range', { scoreMode: 'range', availableInferenceVersion: 2 });
await check('live-legacy', { scoreMode: 'available' }, { method: 'mean-percentile' });
await check('live-pairwise', { scoreMode: 'available', availableInferenceVersion: 2 }, { method: 'pairwise-anchored' });
await check('live-invalid-version', { scoreMode: 'available', availableInferenceVersion: 3 }, { status: 400 });
const reference = JSON.parse(await readFile(join(output, 'reference.json'), 'utf8'));
const IDs = [...new Set([...baseline.benchmarks.map(b => b.conditionID), ...reference.versions.map(v => v.ID)])];
for (const size of [10, 100]) await check(`live-preview-${size}`, { scoreMode: 'available', availableInferenceVersion: 2,
    initialMode: 'personal', previewPersonalPie: { entries: IDs.slice(0, size).map(conditionID => ({ conditionID, weightBasisPoints: 10000 / size })), fallbackRules: [] }
}, { method: 'pairwise-anchored' });
const keys = baseline.comparison.fields.filter(field => /reasoning|harness/i.test(field.name)).map(field => `field:${field.ID}`);
await check('live-basic-keys', { scoreMode: 'available', availableInferenceVersion: 2,
    comparison: { mode: 'best', keys: ['model', ...keys] } }, { method: 'pairwise-anchored' });
const browser = await chromium.launch({ headless: true });
try {
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 } }), page = await context.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        const requests = [];
        page.on('request', r => { if (r.url().endsWith('/api/get_weighted_workspace')) requests.push(r.postDataJSON()); });
        try {
            await page.goto('https://benchpoll.com/Intelligence');
            await page.locator('.bp-benchmark-row').first().waitFor({ timeout: 60000 });
            if (width === 390) await page.locator('button[data-mobile-panel="models"]').click();
            await page.locator('.bp-model-row').first().waitFor({ timeout: 60000 });
            const response = page.waitForResponse(r => r.url().endsWith('/api/get_weighted_workspace')
                && r.request().postDataJSON().scoreMode === 'available', { timeout: 60000 });
            await page.locator('[data-score-mode="available"]').click();
            const payload = await (await response).json();
            validateWorkspacePayload(payload);
            assert.ok(payload.modelLeaderboards.public.every(row => row.availableInference?.method === 'pairwise-anchored'));
            await page.waitForFunction(() => document.querySelector('[data-score-mode="available"]')?.getAttribute('aria-pressed') === 'true'
                && document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
            await page.waitForFunction(() => !document.querySelector('#model-card')?.getAnimations({ subtree: true })
                .some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity));
            assert.ok(requests.every(r => r.availableInferenceVersion === 2));
            const help = page.getByRole('button', { name: 'About missing scores', exact: true });
            assert.match(await help.getAttribute('data-help-text'), /shared tests/);
            await help.click();
            await page.waitForTimeout(600);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.screenshot({ path: join(output, `live-${width}.png`), fullPage: true });
            await page.goto('https://benchpoll.com/how-it-works');
            await page.getByText('Full calculation rules', { exact: true }).click();
            const faq = page.getByText('How does Available results estimate a missing score?', { exact: true });
            await faq.click(); assert.match(await faq.locator('..').textContent(), /tests they share/);
            assert.deepEqual(errors, []);
            report.browsers.push({ width, passed: true });
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
await writeFile(join(output, 'production-checks.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
