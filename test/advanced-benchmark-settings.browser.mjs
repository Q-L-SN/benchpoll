import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
let bundle, css;
before(async () => {
    css = (await Promise.all(['tokens', 'components', 'tooltip', 'evidence-count', 'fallback-picker']
        .map(name => readFile(new URL(`../public/css/ui/${name}.css`, import.meta.url), 'utf8')))).join('\n');
    const result = await build({ stdin: { resolveDir: root, contents: `
        import { createBenchmarkSettings } from './public/js/workspace/benchmark-settings.js';
        import { withEstimationVote } from './public/js/shared/estimation-votes.js';
        globalThis.mountSettings = readOnly => {
            const versions = Array.from({ length: 42 }, (_, i) => ({
                conditionID: i + 1, benchmarkID: 101, conditionName: 'Evaluation ' + (i + 1),
                scoreCount: 42 - i, selectionBasisPoints: i ? 0 : 10000
            }));
            const state = { group: { benchmarkID: 101, name: 'Review benchmark', primaryConditionID: 1, versions },
                entries: [{ conditionID: 1, ...(readOnly ? {} : { followCommunityVersion: true }) }],
                estimationVoting: true,
                personalEstimationVotes: readOnly ? [{ targetConditionID: 1, sourceConditionID: 2, vote: 'support' }] : [],
                communityEstimationVotes: [
                    { targetConditionID: 1, sourceConditionID: 2, supportCount: 4, opposeCount: 2 },
                    { targetConditionID: 1, sourceConditionID: 4, supportCount: 0, opposeCount: 2 },
                    { targetConditionID: 3, sourceConditionID: 2, supportCount: 1, opposeCount: 3 }
                ],
                readOnly, editable: !readOnly, busy: false, calls: [] };
            const settings = createBenchmarkSettings({ host: document.getElementById('settings'),
                getScope: () => readOnly ? 'public' : 'personal', getData: () => state,
                onVersion(group, conditionID) {
                    state.calls.push({ scoringVersion: conditionID });
                    state.entries = [{ conditionID: conditionID ?? group.primaryConditionID,
                        ...(conditionID === null ? { followCommunityVersion: true } : {}) }];
                    return true;
                },
                onVote(group, targetConditionID, sourceConditionID, vote) {
                    const pair = { targetConditionID, sourceConditionID, vote };
                    state.calls.push(pair);
                    state.personalEstimationVotes = withEstimationVote(state.personalEstimationVotes, targetConditionID, sourceConditionID, vote);
                    return true;
                }
            });
            globalThis.settingsFixture = { settings, state };
            settings.refresh(versions[0], true);
        };
    ` }, bundle: true, format: 'iife', write: false, logLevel: 'silent' });
    bundle = result.outputFiles[0].text;
});

async function pageFor(t, engine, width) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: width < 760 ? 568 : 900 },
        isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1"><style>
        * { box-sizing: border-box; } body { margin: 0; padding: 12px; font-family: sans-serif; }
        main { width: min(100%, 520px); margin: auto; }
        </style></head><body><main><section id="settings" class="bp-benchmark-settings" hidden></section></main></body></html>` }));
    await page.goto('http://settings.test');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });
    return page;
}

for (const [engine, width] of [[chromium, 1440], [chromium, 320], [webkit, 390]]) {
    test(`${engine.name()} ${width}: independent scoring and estimation controls use one flat list`, async t => {
        const page = await pageFor(t, engine, width);
        await page.evaluate(() => mountSettings(false));
        const settings = page.locator('#settings');
        const score = conditionID => settings.getByRole('button', { name: `Use Evaluation ${conditionID} for scoring`, exact: true });
        const vote = (action, source, target) => settings.getByRole('button', {
            name: `${action} mutual estimation between Evaluation ${target} and Evaluation ${source}`, exact: true
        });
        const row = conditionID => settings.locator(`.bp-version-choice-row[data-condition-id="${conditionID}"]`);
        const rates = settings.locator('.bp-estimation-rate:visible');
        const rate = conditionID => row(conditionID).locator('.bp-estimation-rate');
        assert.equal(await settings.getByRole('listitem').count(), 42);
        assert.equal(await settings.locator('[aria-pressed="true"], .bp-choice-pagination, .bp-fallback-picker-embedded').count(), 0);
        assert.equal(await settings.locator('.bp-version-choice-share').count(), 42);
        assert.equal(await rates.count(), 0);
        assert.equal(await settings.locator('button[data-vote]').count(), 0);
        assert.match(await settings.getByRole('status').textContent(), /Following community/);

        await score(1).press('Enter');
        assert.equal(await score(1).getAttribute('aria-pressed'), 'true');
        assert.equal(await rates.count(), 2);
        assert.equal(await row(1).locator('[data-vote], .bp-estimation-rate').count(), 0);
        assert.equal(await rate(2).textContent(), '66.67%');
        assert.equal(await rate(3).isVisible(), false);
        for (const action of ['Support', 'Oppose']) {
            const button = vote(action, 3, 1);
            assert.equal(await button.isEnabled(), true);
            assert.equal(await button.textContent(), '0');
        }
        assert.equal(await rate(4).textContent(), '0%');
        const support = vote('Support', 2, 1);
        assert.equal(await support.textContent(), '4');
        assert.equal(await vote('Oppose', 2, 1).textContent(), '2');
        await support.press('Space');
        assert.equal(await support.getAttribute('aria-pressed'), 'true');
        assert.equal(await support.evaluate(button => button.matches(':focus')), true);

        await score(2).click();
        assert.equal(await rate(1).textContent(), '66.67%');
        assert.equal(await vote('Support', 1, 2).getAttribute('aria-pressed'), 'true');
        await score(3).click();
        assert.equal(await score(1).getAttribute('aria-pressed'), 'false');
        assert.equal(await score(3).getAttribute('aria-pressed'), 'true');
        assert.equal(await rate(2).textContent(), '25%');
        assert.equal(await vote('Support', 2, 3).getAttribute('aria-pressed'), 'false');
        await vote('Oppose', 2, 3).click();
        assert.equal(await vote('Oppose', 2, 3).getAttribute('aria-pressed'), 'true');
        await score(3).click();
        assert.equal(await score(3).getAttribute('aria-pressed'), 'false');
        assert.equal(await rates.count(), 0);
        assert.equal(await settings.locator('button[data-vote]').count(), 0);

        await score(1).click();
        assert.equal(await support.getAttribute('aria-pressed'), 'true');
        await support.click();
        assert.equal(await support.getAttribute('aria-pressed'), 'false');
        await vote('Support', 42, 1).click();
        assert.equal(await vote('Support', 42, 1).getAttribute('aria-pressed'), 'true');
        assert.equal(await settings.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        assert.deepEqual(await page.evaluate(() => settingsFixture.state.calls), [
            { scoringVersion: 1 }, { targetConditionID: 1, sourceConditionID: 2, vote: 'support' },
            { scoringVersion: 2 }, { scoringVersion: 3 }, { targetConditionID: 3, sourceConditionID: 2, vote: 'oppose' },
            { scoringVersion: null }, { scoringVersion: 1 }, { targetConditionID: 1, sourceConditionID: 2, vote: null },
            { targetConditionID: 1, sourceConditionID: 42, vote: 'support' }
        ]);
    });

    test(`${engine.name()} ${width}: public settings inspect mutual community rates without editing`, async t => {
        const page = await pageFor(t, engine, width);
        await page.evaluate(() => mountSettings(true));
        const settings = page.locator('#settings');
        const inspect = conditionID => settings.getByRole('button', { name: `Inspect estimation sources for Evaluation ${conditionID}`, exact: true });
        const rate = conditionID => settings.locator(`.bp-version-choice-row[data-condition-id="${conditionID}"] .bp-estimation-rate`);
        assert.match(await settings.getByRole('status').textContent(), /^Read-only\. Choose a version to inspect/);
        assert.equal(await settings.locator('.bp-version-choice-share').first().textContent(), '100%');
        assert.equal(await settings.locator('.bp-estimation-rate, [aria-pressed="true"]').count(), 0);

        if (width < 760) await inspect(1).tap();
        else await inspect(1).press('Space');
        assert.equal(await inspect(1).getAttribute('aria-pressed'), 'true');
        assert.match(await settings.getByRole('status').textContent(), /^Read-only\. Inspecting estimation sources for Evaluation 1/);
        assert.equal(await rate(1).count(), 0);
        assert.equal(await rate(2).textContent(), '66.67%');
        assert.match(await rate(2).getAttribute('aria-label'), /4 in support, 2 opposed/);
        assert.equal(await rate(3).isVisible(), false);
        assert.equal(await settings.locator('.bp-estimation-vote').count(), 0);
        await inspect(2).click();
        assert.equal(await rate(1).textContent(), '66.67%');
        await inspect(3).click();
        assert.equal(await inspect(1).getAttribute('aria-pressed'), 'false');
        assert.equal(await rate(2).textContent(), '25%');
        assert.equal(await rate(3).count(), 0);
        await inspect(3).click();
        assert.equal(await settings.locator('.bp-estimation-rate, [aria-pressed="true"]').count(), 0);
        assert.deepEqual(await page.evaluate(() => settingsFixture.state.calls), []);
    });
}
