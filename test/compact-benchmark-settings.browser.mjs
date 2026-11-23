import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { benchmarks, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = process.env.BP_SETTINGS_ARTIFACTS ?? 'artifacts/compact-benchmark-settings-20261104';
await mkdir(output, { recursive: true });
for (const [engine, width, height] of built ? [[chromium, 1440, 900], [chromium, 320, 568]]
    : [[chromium, 1440, 900], [chromium, 390, 844], [chromium, 320, 568], [webkit, 390, 660]]) {
    test(`${engine.name()} ${width}x${height}: a long version catalogue fits one scrollable workspace ${built ? 'built' : 'source'}`, async t => {
        const variants = ['Thinking', 'Verified', 'Short', 'Full', 'Overall', 'Task-macro rubric pass rate, model-specific conditions',
            ...Array.from({ length: 20 }, (_, index) => `Evaluation ${index + 1}`)].map((name, index) => ({
            ...benchmarks[0], ID: 100 + index, conditionID: 100 + index, isPrimaryCondition: false,
            isDefaultCondition: false, conditionKey: `variant-${index}`, conditionName: name, scoreCount: 25 - index,
            publicWeight: 0, personalWeight: null }));
        const fixture = await startPreview({ communityVersions: true, additionalBenchmarkVersions: variants, communityEstimationVotes: [],
            personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000, followCommunityVersion: true },
                { conditionID: 2, weightBasisPoints: 4000 }]) });
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 760, isMobile: width < 760, reducedMotion: 'reduce' });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        page.setDefaultTimeout(10000);
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        if (built) await page.route(fixture.url + '/1', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
        await page.goto(fixture.url + '/1');
        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        await page.locator('#inline-fallback-toggle').click();
        const settings = page.locator('#benchmark-settings'); await settings.waitFor();
        const list = settings.getByRole('list', { name: 'Benchmark versions' });
        const rows = list.getByRole('listitem');
        assert.equal(await rows.count(), 27);
        assert.equal(await settings.locator('.bp-choice-pagination, .bp-choice-load-sentinel').count(), 0);
        assert.equal(await list.evaluate(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)), false);
        assert.equal(await settings.locator('.bp-estimation-rate, button[data-vote]').count(), 0);
        const score = settings.getByRole('button', { name: 'Use Default evaluation for scoring', exact: true });
        const scoringSave = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
        await score.click();
        await scoringSave;
        assert.equal(await settings.locator('.bp-estimation-rate').count(), 26);
        const geometry = await settings.evaluate(node => {
            const longChoice = node.querySelector('.bp-version-choice[data-condition-id="105"]');
            const first = node.querySelector('.bp-version-choice');
            return { overflow: node.scrollWidth - node.clientWidth,
                viewportOverflow: document.documentElement.scrollWidth - innerWidth,
                width: longChoice.clientWidth, longChoiceOverflow: longChoice.scrollWidth - longChoice.clientWidth,
                fits: longChoice.clientHeight >= first.clientHeight };
        });
        assert.ok(geometry.overflow <= 1 && geometry.viewportOverflow <= 1 && geometry.width > 80
            && geometry.longChoiceOverflow <= 1 && geometry.fits, JSON.stringify(geometry));
        for (const value of await settings.locator('.bp-evidence-count-value').allTextContents()) assert.match(value, /^\d+$/);
        const last = rows.last().locator('button[data-vote="support"]');
        const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
        await last.click();
        const { estimationVotes, fallbackRules } = (await saved).request().postDataJSON();
        assert.deepEqual(estimationVotes, [{
            targetConditionID: 1, sourceConditionID: Number(await rows.last().getAttribute('data-condition-id')), vote: 'support'
        }]);
        assert.deepEqual(fallbackRules, []);
        assert.equal(await last.getAttribute('aria-pressed'), 'true');
        assert.equal(await score.getAttribute('aria-pressed'), 'true');
        const longChoice = settings.locator('.bp-version-choice[data-condition-id="105"]');
        await longChoice.evaluate(node => node.scrollIntoView({ block: 'center' }));
        await page.mouse.move(1, 1);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${height}-${built ? 'built' : 'source'}.png` });
    });
}
