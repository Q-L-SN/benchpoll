import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = process.env.WORKSPACE_UI_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/workspace-ui-20261013/browser-new';
await mkdir(output, { recursive: true });
const fields = [
    { ID: 20, name: 'Effort', type: 'enum', revision: 2, allowEmpty: false, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 3, label: 'high', excluded: false }, { ID: 4, label: 'low', excluded: false }, { ID: 5, label: 'max', excluded: false }] },
    { ID: 1, name: 'Harness', type: 'enum', revision: 2, allowEmpty: false, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 100, label: 'Claude Code', excluded: false }, { ID: 101, label: 'Codex CLI', excluded: false }] },
    { ID: 33, name: 'Temperature', type: 'number', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false, options: [] }
];
const reports = [];
for (const [engine, launcher, width, height] of [['chromium', chromium, 1440, 900], ['chromium', chromium, 390, 844], ['chromium', chromium, 320, 640], ['webkit', webkit, 390, 844]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const app = await startPreview({ comparisonFields: fields, rankingStress: true });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = `${engine}-${width}`;
    try {
        if (engine === 'webkit') await page.route(`${app.url}/**`, async route => {
            const response = await route.fetch(); await route.fulfill({ response, body: await response.body() });
        });
        await page.goto(`${app.url}/contribute/scores/new`);
        await page.locator('[data-score-fields-editor="0"] .score-field-row').first().waitFor();
        const editor = page.locator('[data-score-fields-editor="0"]');
        assert.deepEqual(await editor.locator('.score-field-row > span').allTextContents(), ['Effort', 'Harness']);
        assert.equal(await editor.locator('.fa-brain').count(), 1); assert.equal(await editor.locator('.fa-puzzle-piece').count(), 1);
        const model = page.locator('[data-result-model-query]').first(); await model.fill('Cedar');
        await page.locator('[data-select-result-model]').first().click();
        await page.locator('[data-result-object-query]').first().fill('Reasoning');
        await page.locator('[data-select-result-object]').first().click();
        await page.locator('[data-score-value-input]').fill('81.5');
        await page.locator('[data-field="sourceURL"]').fill('https://example.com/result');
        await editor.locator('select[aria-label="Effort value"]').selectOption('3', { force: true });
        await editor.locator('select[aria-label="Harness value"]').selectOption('100', { force: true });
        assert.equal(await editor.locator('.fa-brain').count(), 1); assert.equal(await editor.locator('.fa-puzzle-piece').count(), 1);
        await page.screenshot({ path: join(output, `${label}-presets.png`), fullPage: true });
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-success-dialog:not([hidden])').waitFor();
        const submission = app.state.requests.filter(request => request.path === '/api/submit_contribution').at(-1).body;
        assert.deepEqual(submission.results[0].scoreFields, [{ fieldID: 20, value: 3 }, { fieldID: 1, value: 100 }]);
        await page.goto(`${app.url}/contribute/feedback`); const feedback = page.locator('.feedback-editor textarea'); await feedback.waitFor();
        const feedbackHeight = await feedback.evaluate(node => node.getBoundingClientRect().height);
        assert.ok(feedbackHeight >= 260 && feedbackHeight <= 350, String(feedbackHeight));
        await page.goto(`${app.url}/Language-models`);
        await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready');
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => {
            const s = document.getElementById('showcase');
            scrollTo({ top: (s.offsetHeight - document.documentElement.clientHeight - s.querySelector('.bp-showcase-stage').offsetHeight) * .55, behavior: 'instant' });
        });
        await page.waitForTimeout(200);
        const weights = await page.locator('.bp-weight-bar-row').evaluateAll(rows => rows.map(row => ({
            visible: getComputedStyle(row).display !== 'none', position: row.querySelector('.bp-weight-bar-value').getBoundingClientRect().right,
            fill: row.querySelector('.bp-weight-bar-fill').getBoundingClientRect().right,
            background: getComputedStyle(row.querySelector('.bp-weight-bar-track')).backgroundColor
        })));
        assert.ok(weights.length >= 5); assert.ok(weights.every(row => row.visible && row.background === 'rgba(0, 0, 0, 0)'));
        assert.ok(weights[1].position < weights[0].position - 5, JSON.stringify(weights));
        if (width < 760) {
            const scroll = await page.locator('#weight-bars').evaluate(node => {
                const before = scrollY; node.scrollTop = node.scrollHeight;
                return { scrollable: node.scrollHeight > node.clientHeight, moved: node.scrollTop, before, after: scrollY };
            });
            assert.ok(scroll.scrollable && scroll.moved > 0); assert.equal(scroll.before, scroll.after);
        }
        const logos = await page.locator('.bp-model-column-identity > .bp-vendor-mark').evaluateAll(nodes => nodes.every(node => {
            const child = node.querySelector('img, svg'); if (!child) return true;
            const parent = node.getBoundingClientRect(), image = child.getBoundingClientRect();
            return image.left >= parent.left - .5 && image.right <= parent.right + .5 && image.top >= parent.top - .5 && image.bottom <= parent.bottom + .5;
        }));
        assert.equal(logos, true);
        await page.screenshot({ path: join(output, `${label}-charts.png`) });
        await page.locator('#showcase-enter').click(); await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        await page.waitForTimeout(850); assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase-handoff')), false);
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        await page.locator('[data-score-mode="available"]').click();
        await page.waitForFunction(() => document.querySelector('[data-score-mode="available"]').getAttribute('aria-pressed') === 'true'
            && document.querySelector('.bp-model-row.is-leader-relative'));
        await page.waitForTimeout(400);
        const modelBars = await page.locator('.bp-model-row.is-leader-relative').evaluateAll(rows => rows.map(row => {
            const track = row.querySelector('.bp-score-track'), score = row.querySelector('.bp-model-score').getBoundingClientRect();
            const bounds = track.getBoundingClientRect();
            return { scoreRight: score.right, left: score.left, track: bounds.toJSON(), background: getComputedStyle(track).backgroundColor };
        }));
        assert.ok(modelBars.length > 1); assert.ok(modelBars.every(row => row.background === 'rgba(0, 0, 0, 0)' && row.left >= row.track.left - 1 && row.scoreRight <= row.track.right + 1));
        assert.ok(modelBars[1].scoreRight < modelBars[0].scoreRight - 5, JSON.stringify(modelBars));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: join(output, `${label}-available.png`) });
        assert.deepEqual(errors, []);
        reports.push({ label, feedbackHeight, weights, logos, modelBars, errors }); console.log(JSON.stringify({ label, passed: true }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true }).catch(() => {}); throw error;
    } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
