import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const output = process.env.BP_SETTINGS_ARTIFACTS ?? 'artifacts/advanced-benchmark-settings';
let bundle, css;
const browsers = new Map();
before(async () => {
    await mkdir(output, { recursive: true });
    css = (await Promise.all(['tokens', 'components', 'evidence', 'disclosure', 'tooltip', 'fallback', 'choice-pager', 'fallback-picker']
        .map(name => read(`public/css/ui/${name}.css`)))).join('\n');
    const result = await build({ stdin: { resolveDir: root, contents: `
        import { createBenchmarkSettings } from './public/js/workspace/benchmark-settings.js';
        globalThis.setupReview = (options = {}) => {
            const member = ID => ({ ID, conditionID: ID, benchmarkID: 1000 + ID, name: 'Benchmark ' + ID, conditionName: 'Default' });
            const versions = Array.from({ length: 42 }, (_, i) => ({ ID: i + 1, conditionID: i + 1, benchmarkID: 101,
                name: 'Review benchmark', conditionName: 'Evaluation ' + (i + 1), scoreCount: 42 - i,
                selectionBasisPoints: i ? 0 : 10000, isPrimaryCondition: i === 0, fallbackConfigCount: 18 }));
            const group = { benchmarkID: 101, name: 'Review benchmark', primaryConditionID: 1, versions };
            const featured = [{ familyID: 1, familyEntries: Array.from({ length: 8 }, (_, i) => member(101 + i)) }];
            const remaining = Array.from({ length: 16 }, (_, i) => ({ familyID: i + 2,
                familyEntries: Array.from({ length: 1 + i % 4 }, (_, j) => member(201 + i * 10 + j)) }));
            const state = { group, scope: options.readOnly ? 'public' : 'personal', readOnly: options.readOnly === true,
                entries: [{ conditionID: 1, ...(options.selected ? {} : { followCommunityVersion: true }) }],
                rule: options.rule ? { entries: [member(999)], selectionSource: 'custom' } : null,
                calls: [], loads: [], items: [], loading: false, hasMore: true };
            let settings;
            const catalogue = { view: () => ({ featured, items: state.items, loaded: state.items.length > 0,
                    loading: state.loading, hasMore: state.hasMore, error: '', suspended: false }),
                async load(ID) {
                    if (state.loading || !state.hasMore) return;
                    state.loads.push(ID); state.loading = true; settings.refresh();
                    await new Promise(resolve => setTimeout(resolve, 5));
                    state.items.push(...remaining.slice(state.items.length, state.items.length + 2));
                    state.hasMore = state.items.length < remaining.length; state.loading = false; settings.refresh();
                } };
            settings = createBenchmarkSettings({ host: document.getElementById('settings'),
                selectedHeader: document.getElementById('selected-header'), getScope: () => state.scope,
                getData: () => ({ group, entries: state.entries, rule: state.rule, readOnly: state.readOnly,
                    editable: !state.readOnly, editing: false, busy: false }),
                onVersion(group, ID) {
                    state.calls.push({ version: ID }); state.rule = null;
                    state.entries = [{ conditionID: ID ?? 1, ...(ID === null ? { followCommunityVersion: true } : {}) }];
                    settings.refresh(); return true;
                },
                editor: document.getElementById('editor'), onEdit: () => false,
                fallbackPickerOptions: { catalogue, getScope: () => state.scope,
                    getPrimary: ID => versions.find(version => version.ID === ID), getCurrent: () => state.rule,
                    getComposition: () => ({ configuredPieCount: 2, families: [
                        { familyID: 1, entries: featured[0].familyEntries, weightBasisPoints: 9000 },
                        { entries: [], weightBasisPoints: 1000 } ] }),
                    canApply: () => !state.readOnly,
                    onApply(primary, choice) { state.calls.push({ fallback: choice.key, community: choice.community === true });
                        state.rule = choice.community ? null : { entries: choice.entries, familyID: choice.familyID };
                        settings.refresh(); return true; },
                    getMemberURL: entry => '/benchmark/' + entry.conditionID }
            });
            state.settings = settings; state.primary = versions[0];
            globalThis.review = state; settings.open(versions[0]);
        };
    ` }, bundle: true, format: 'iife', write: false, logLevel: 'silent' });
    bundle = result.outputFiles[0].text;
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function pageFor(t, engine, width, options = {}) {
    if (!browsers.has(engine.name())) browsers.set(engine.name(), await engine.launch({ headless: true,
        ...(engine === chromium ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) }));
    const page = await browsers.get(engine.name()).newPage({ viewport: { width, height: 900 },
        isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1"><style>
        * { box-sizing: border-box; } body { margin: 0; padding: 12px; font-family: sans-serif; background: #f8fafc; }
        .review-panel { width: min(100%, 620px); height: calc(100dvh - 24px); overflow: auto; margin: auto; background: white; padding: 12px; }
        #selected-header { display: flex; align-items: center; gap: 12px; position: sticky; top: -12px; background: white; z-index: 5; min-height: 52px; }
        #selected-header h2 { margin: 0; font-size: 16px; } [hidden] { display: none !important; }
        </style></head><body><div class="review-panel"><header id="selected-header"><h2>Review benchmark</h2><button>Information</button></header>
        <section id="settings" class="bp-benchmark-settings" hidden></section><div id="editor" hidden></div></div></body></html>` }));
    const install = async () => {
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(value => setupReview(value), options);
    };
    await page.goto('http://settings.test'); await install();
    return { page, install };
}

async function scrollChoices(page, position) {
    await page.locator('#settings').evaluate((node, value) => {
        let root = node.parentElement;
        while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
        if (value === 'end') root.scrollTop = root.scrollHeight;
        else if (value === 'start') root.scrollTop += node.querySelector('.bp-benchmark-settings-scroll').getBoundingClientRect().top
            - root.getBoundingClientRect().top - document.getElementById('selected-header').getBoundingClientRect().height;
        else root.scrollTop += value;
    }, position);
}

for (const [engine, width] of process.env.BP_SETTINGS_WEBKIT === '1'
    ? [[chromium, 1440], [webkit, 390]] : [[chromium, 1440], [chromium, 390]]) {
    test(`${engine.name()} ${width}: vertical pages preload neighbors and cap only long chains`, async t => {
        const { page } = await pageFor(t, engine, width);
        const settings = page.locator('#settings'), versionPages = page.locator('.bp-benchmark-settings-versions .bp-choice-pager');
        assert.equal(await settings.getAttribute('data-style'), 'pages');
        assert.equal(await settings.locator('.bp-version-choice:visible').count(), 6);
        assert.equal(await settings.locator('.bp-version-choice').count(), 24, 'The first page preloads exactly three neighboring pages');
        assert.equal(await versionPages.locator('.fa-chevron-up').count(), 1);
        assert.equal(await versionPages.locator('.fa-chevron-down').count(), 1);
        for (let i = 0; i < 3; i++) await versionPages.getByRole('button', { name: 'Next versions page' }).click();
        assert.equal(await settings.locator('.bp-version-choice').count(), 42, 'A middle page retains three pages on both sides');
        assert.deepEqual(await settings.locator('.bp-version-choice:visible').evaluateAll(nodes => nodes.map(node => Number(node.dataset.conditionId))), [19, 20, 21, 22, 23, 24]);
        await settings.locator('.bp-version-choice[data-condition-id="19"]').click();
        await page.waitForFunction(() => review.items.length >= 6 && !review.loading);
        assert.equal(await page.evaluate(() => review.loads.length), 3, 'The next three fallback pages are prefetched and loading then stops');
        const cards = settings.locator('.bp-fallback-picker-column:visible');
        assert.equal(await cards.count(), 2);
        assert.equal(await cards.first().locator('.bp-fallback-chain-step').count(), 5);
        const boxes = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
        assert.ok(boxes[0].bottom <= boxes[1].top && boxes[0].height > boxes[1].height, JSON.stringify(boxes));
        const firstCard = cards.first();
        await firstCard.getByRole('button', { name: /Expand fallback chain/ }).click();
        assert.equal(await firstCard.locator('.bp-fallback-chain-step').count(), 9);
        assert.equal(await firstCard.locator('.bp-fallback-picker-expand').count(), 0);
        assert.equal(await settings.locator('.bp-fallback-picker-column-title').allTextContents().then(names => names.every(name => name === 'No fallback')), true);
        assert.equal(await settings.locator('.bp-benchmark-settings-fallback > .bp-benchmark-settings-section-heading .bp-help-trigger').count(), 1);
        assert.doesNotMatch(await settings.locator('.bp-fallback-picker-body').innerText(), /Community share|explicit choices|Your configuration|Order \d/);
        const metrics = await settings.evaluate(node => ({ overflow: node.scrollWidth - node.clientWidth,
            scrollLists: [...node.querySelectorAll('.bp-version-choices, .bp-fallback-picker-columns, .bp-fallback-picker-steps')]
                .some(list => /auto|scroll/.test(getComputedStyle(list).overflowY)) }));
        assert.ok(metrics.overflow <= 1); assert.equal(metrics.scrollLists, false);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-pages.png` });
    });

    test(`${engine.name()} ${width}: exclusive Accordion locks fallback and keeps closed headers visible`, async t => {
        const { page, install } = await pageFor(t, engine, width);
        const settings = page.locator('#settings'), versionTrigger = page.locator('#settings-versions-trigger'), fallbackTrigger = page.locator('#settings-fallback-trigger');
        await settings.getByRole('button', { name: 'Accordion', exact: true }).click();
        assert.equal(await versionTrigger.getAttribute('aria-expanded'), 'true');
        assert.equal(await fallbackTrigger.getAttribute('aria-expanded'), 'false');
        assert.equal(await fallbackTrigger.getAttribute('aria-disabled'), 'true');
        assert.match(await fallbackTrigger.getAttribute('data-tooltip'), /Select a version first/);
        await fallbackTrigger.click({ force: true });
        assert.equal(await versionTrigger.getAttribute('aria-expanded'), 'true');
        await versionTrigger.click();
        assert.equal(await versionTrigger.getAttribute('aria-expanded'), 'true', 'The last open panel cannot collapse');
        await page.waitForFunction(() => document.querySelectorAll('.bp-version-choice').length >= 12);
        const initialVersions = await settings.locator('.bp-version-choice').count();
        if (initialVersions < 42) {
            await scrollChoices(page, 'end');
            await page.waitForFunction(count => document.querySelectorAll('.bp-version-choice').length > count, initialVersions);
        }
        const footer = await settings.evaluate(node => {
            const scroll = node.closest('.review-panel').getBoundingClientRect();
            const header = node.querySelector('.bp-benchmark-settings-fallback .bp-benchmark-settings-section-heading').getBoundingClientRect();
            return { scroll: scroll.toJSON(), header: header.toJSON() };
        });
        assert.ok(footer.header.bottom <= footer.scroll.bottom + 1 && footer.header.top >= footer.scroll.top, JSON.stringify(footer));
        assert.equal(await settings.locator('.bp-choice-pagination:visible').count(), 0);
        await scrollChoices(page, 'start');
        await settings.locator('.bp-version-choice[data-condition-id="1"]').click();
        assert.equal(await fallbackTrigger.getAttribute('aria-expanded'), 'true');
        assert.equal(await versionTrigger.getAttribute('aria-expanded'), 'false');
        assert.equal(await fallbackTrigger.evaluate(node => node === document.activeElement), true, 'Auto-opening moves focus to the visible fallback header');
        assert.match(await versionTrigger.textContent(), /Choose versionEvaluation 1/);
        const cards = settings.locator('.bp-fallback-picker-column:visible');
        assert.equal(await cards.first().locator('.bp-fallback-chain-step').count(), 9);
        assert.equal(await settings.locator('.bp-fallback-picker-expand').count(), 0);
        await scrollChoices(page, 300);
        const pinned = await settings.evaluate(node => ({
            header: node.querySelector('.bp-benchmark-settings-versions .bp-benchmark-settings-section-heading').getBoundingClientRect().top,
            selected: document.getElementById('selected-header').getBoundingClientRect().toJSON() }));
        assert.ok(Math.abs(pinned.selected.bottom - pinned.header) <= 1, JSON.stringify(pinned));
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-accordion.png` });
        const none = settings.locator('[data-family-key="[1]"] .bp-fallback-picker-card-toggle');
        await none.click();
        assert.match(await fallbackTrigger.textContent(), /configurationSelected/);
        await none.click();
        assert.match(await fallbackTrigger.textContent(), /Not selected/);
        await scrollChoices(page, 'end');
        await page.waitForFunction(() => review.items.length > 0);
        await versionTrigger.click();
        await settings.locator('.bp-version-choice[data-condition-id="2"]').click();
        assert.equal(await fallbackTrigger.getAttribute('aria-expanded'), 'true', 'Changing a concrete version advances to fallback');
        await versionTrigger.click();
        await settings.locator('.bp-version-choice[data-condition-id="2"]').click();
        assert.equal(await versionTrigger.getAttribute('aria-expanded'), 'true');
        assert.equal(await fallbackTrigger.getAttribute('aria-expanded'), 'false');
        assert.match(await versionTrigger.textContent(), /Not selected/);
        assert.deepEqual(await page.evaluate(() => review.calls), [{ version: 1 }, { fallback: '[1]', community: false },
            { fallback: undefined, community: true }, { version: 2 }, { version: null }]);
        assert.equal(await page.evaluate(() => localStorage.getItem('benchpoll:benchmark-settings-style')), 'accordion');
        await page.reload(); await install();
        assert.equal(await settings.getAttribute('data-style'), 'accordion', 'The test style persists across reloads');
        assert.equal(await versionTrigger.getAttribute('aria-expanded'), 'true');
    });

    test(`${engine.name()} ${width}: public settings inspect versions without personal accents or writes`, async t => {
        const { page } = await pageFor(t, engine, width, { readOnly: true, selected: true, rule: true });
        const settings = page.locator('#settings');
        assert.match(await settings.locator('.bp-benchmark-settings-readonly').innerText(), /^Read-only/);
        assert.equal(await settings.getByRole('button', { name: /Configure in Personal Weights/ }).count(), 0);
        assert.equal(await settings.locator('.bp-version-choice[aria-pressed="true"]').count(), 0);
        assert.equal(await settings.locator('.bp-version-choice:disabled').count(), 0);
        assert.match(await page.locator('#settings-versions-trigger').textContent(), /Not selected/);
        await settings.getByRole('button', { name: 'Accordion', exact: true }).click();
        await settings.locator('.bp-version-choice[data-condition-id="1"]').click();
        assert.equal(await page.locator('#settings-fallback-trigger').getAttribute('aria-expanded'), 'true');
        assert.equal(await settings.locator('.bp-version-choice[aria-pressed="true"], .bp-fallback-picker-column.is-selected').count(), 0);
        assert.equal(await settings.locator('.bp-fallback-picker-card-toggle, .bp-fallback-picker-customize:visible').count(), 0);
        assert.equal(await settings.locator('[data-family-key="[1,999]"]').count(), 0, 'A personal custom chain is not shown as a public configuration');
        assert.match(await page.locator('#settings-fallback-trigger').textContent(), /Not selected/);
        assert.deepEqual(await page.evaluate(() => review.calls), []);
        assert.equal(await settings.locator('.bp-fallback-picker-column').first().evaluate(node => getComputedStyle(node).opacity), '1');
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-public.png` });
    });
}
