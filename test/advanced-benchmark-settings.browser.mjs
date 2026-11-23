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
        globalThis.mountSettings = readOnly => {
            const versions = Array.from({ length: 42 }, (_, i) => ({
                conditionID: i + 1, benchmarkID: 101, conditionName: 'Evaluation ' + (i + 1),
                scoreCount: 42 - i, selectionBasisPoints: i ? 0 : 10000
            }));
            const state = { group: { benchmarkID: 101, name: 'Review benchmark', primaryConditionID: 1, versions },
                entries: [{ conditionID: 1, ...(readOnly ? {} : { followCommunityVersion: true }) }],
                personalEstimationVotes: readOnly ? [{ conditionID: 1, vote: 'support' }] : [],
                communityEstimationVotes: [{ conditionID: 1, supportCount: 4, opposeCount: 2 }],
                readOnly, editable: !readOnly, busy: false, calls: [] };
            const settings = createBenchmarkSettings({ host: document.getElementById('settings'),
                getScope: () => readOnly ? 'public' : 'personal', getData: () => state,
                onVersion(group, conditionID) {
                    state.calls.push({ scoringVersion: conditionID });
                    state.entries = [{ conditionID: conditionID ?? group.primaryConditionID,
                        ...(conditionID === null ? { followCommunityVersion: true } : {}) }];
                    return true;
                },
                onVote(group, conditionID, vote) {
                    state.calls.push({ conditionID, vote });
                    state.personalEstimationVotes = state.personalEstimationVotes.filter(item => item.conditionID !== conditionID);
                    if (vote) state.personalEstimationVotes.push({ conditionID, vote });
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
        const support = conditionID => settings.getByRole('button', { name: `Support Evaluation ${conditionID} for score estimation`, exact: true });
        const oppose = conditionID => settings.getByRole('button', { name: `Oppose Evaluation ${conditionID} for score estimation`, exact: true });
        assert.equal(await settings.getByRole('listitem').count(), 42);
        assert.equal(await settings.locator('[aria-pressed="true"], .bp-choice-pagination, .bp-fallback-picker-embedded').count(), 0);
        assert.match(await settings.getByRole('status').textContent(), /Following community/);
        assert.equal(await support(1).textContent(), '4');
        assert.equal(await oppose(1).textContent(), '2');

        await score(1).click();
        await support(1).focus();
        await support(1).press('Space');
        assert.equal(await support(1).getAttribute('aria-pressed'), 'true');
        assert.equal(await support(1).evaluate(button => button.matches(':focus')), true);
        assert.equal(await score(1).getAttribute('aria-pressed'), 'true');

        await oppose(1).click();
        await support(2).click();
        await score(2).click();
        assert.equal(await score(1).getAttribute('aria-pressed'), 'false');
        assert.equal(await score(2).getAttribute('aria-pressed'), 'true');
        assert.equal(await support(1).getAttribute('aria-pressed'), 'false');
        assert.equal(await oppose(1).getAttribute('aria-pressed'), 'true');
        assert.equal(await support(2).getAttribute('aria-pressed'), 'true');
        await score(2).click();
        await oppose(1).click();
        assert.equal(await score(2).getAttribute('aria-pressed'), 'false');
        assert.equal(await oppose(1).getAttribute('aria-pressed'), 'false');
        assert.equal(await support(2).getAttribute('aria-pressed'), 'true');

        await support(42).click();
        assert.equal(await support(42).getAttribute('aria-pressed'), 'true');
        assert.equal(await settings.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        assert.deepEqual(await page.evaluate(() => settingsFixture.state.calls), [
            { scoringVersion: 1 }, { conditionID: 1, vote: 'support' }, { conditionID: 1, vote: 'oppose' },
            { conditionID: 2, vote: 'support' }, { scoringVersion: 2 }, { scoringVersion: null },
            { conditionID: 1, vote: null }, { conditionID: 42, vote: 'support' }
        ]);
    });

    test(`${engine.name()} ${width}: public settings show neutral community counts and version shares`, async t => {
        const page = await pageFor(t, engine, width);
        await page.evaluate(() => mountSettings(true));
        const settings = page.locator('#settings');
        assert.equal(await settings.getByRole('status').textContent(), 'Read-only');
        assert.equal(await settings.getByRole('button').count(), 1);
        assert.equal(await settings.locator('[aria-pressed], [aria-current]').count(), 0);
        assert.equal(await settings.getByRole('img', { name: '4 votes supporting Evaluation 1 for score estimation', exact: true }).textContent(), '4');
        assert.equal(await settings.getByRole('img', { name: '2 votes opposing Evaluation 1 for score estimation', exact: true }).textContent(), '2');
        assert.equal(await settings.getByRole('img', { name: '0 votes opposing Evaluation 2 for score estimation', exact: true }).textContent(), '0');
        assert.equal(await settings.getByRole('img', { name: '100% community scoring version share', exact: true }).textContent(), '100%');
        await settings.locator('.bp-version-choice').first().click();
        await settings.locator('.bp-estimation-vote').first().click();
        assert.deepEqual(await page.evaluate(() => settingsFixture.state.calls), []);
    });
}
