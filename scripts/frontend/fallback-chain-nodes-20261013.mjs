import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models, familyEntries, weightedEntries } from './fixtures.mjs';
import { familyKey } from '../../public/js/shared/benchmark-families.js';

const output = resolve(process.env.FALLBACK_CHAIN_NODES_OUTPUT ?? 'artifacts/fallback-chain-nodes-20261013/browser');
await mkdir(output, { recursive: true });
const reports = [];
const rule = { primaryConditionID: 1, familyID: 701, mode: 'ordered',
    entries: familyEntries([{ conditionID: 901 }, { kind: 'other_versions' }, { conditionID: 3 }, { conditionID: 2 }]) };
const alternative = { primaryConditionID: 1, familyID: 702, mode: 'ordered', entries: familyEntries([{ conditionID: 4 }, { conditionID: 5 }]) };
const addRule = { primaryConditionID: 4, familyID: 703, mode: 'ordered', entries: familyEntries([{ conditionID: 5 }, { conditionID: 6 }], 4) };
const long = { primaryConditionID: 1, familyID: 704, mode: 'ordered', entries: Array.from({ length: 30 }, (_, index) => ({
    ...benchmarks[1], ID: index + 1001, conditionID: index + 1001, benchmarkID: index + 2001,
    name: `Alternative benchmark ${index + 1}`, conditionName: `Extended evaluation version ${index + 1}`,
    conditionKey: `extended-${index + 1}`, isDefaultCondition: false })) };
const comparisonModels = models.slice(0, 2).map((model, index) => ({ ...model, modelName: model.name,
    vendor: model.vendorName, results: new Map([2, 3, 6].map(ID => [String(ID), { normalizedScore: 75 - index * 5 }])) }));
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const matrix = [['chromium', chromium, 1440], ['chromium', chromium, 1024], ['chromium', chromium, 390],
    ['chromium', chromium, 320], ['webkit', webkit, 1440], ['webkit', webkit, 390], ['webkit', webkit, 320]];
const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
    && document.querySelectorAll('.bp-model-row').length);
const order = app => app.state.fallbackRules.find(item => item.primaryConditionID === 1)?.entries.map(entry => entry.kind ?? entry.conditionID) ?? [];
const writes = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
async function saved(page, app, expected) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
    for (let attempt = 0; attempt < 600 && JSON.stringify(order(app)) !== JSON.stringify(expected); attempt++) await page.waitForTimeout(25);
    assert.deepEqual(order(app), expected); await ready(page);
}
async function selectPrimary(page) {
    if (await page.locator('button[data-mobile-panel="mix"]').isVisible()) await page.locator('button[data-mobile-panel="mix"]').click();
    await page.locator('#weight-pie g[data-object-id="1"]').click();
    const adjustment = page.locator('#pie-adjustment-dismiss');
    if (await adjustment.isVisible() && await adjustment.isEnabled()) await adjustment.click();
}
async function inspect(page, link, app) {
    const conditionID = Number(new URL(await link.getAttribute('href'), app.url).searchParams.get('conditionID'));
    const before = writes(app);
    await link.click(); await page.locator('body.discussion-open').waitFor();
    await page.waitForFunction(() => document.querySelector('#benchmark-information')?.getAttribute('aria-busy') === 'false');
    assert.equal(app.state.requests.filter(request => request.path === '/api/get_benchmark_information').at(-1).body.conditionID, conditionID);
    assert.equal(writes(app), before);
    await page.locator('#discussion-close').click(); await page.locator('body:not(.discussion-open)').waitFor();
}
async function chain(scope, expected) {
    const geometry = await scope.evaluate(list => ({
        role: list.getAttribute('role'), marker: getComputedStyle(list).listStyleType,
        rows: [...list.children].map(row => {
            const rect = row.getBoundingClientRect();
            const line = getComputedStyle(row, '::before'), dot = getComputedStyle(row, '::after');
            const step = row.classList.contains('bp-fallback-chain-step');
            const identity = row.querySelector('.bp-family-member-name, .bp-fallback-picker-step-name, .bp-benchmark-information-link, .bp-auto-version-button');
            return { step, top: rect.top, bottom: rect.bottom, x: rect.left + parseFloat(line.left),
                start: rect.top + parseFloat(line.top), end: rect.bottom - parseFloat(line.bottom),
                line: line.content, lineWidth: line.width, lineColor: line.backgroundColor,
                dot: dot.content, dotWidth: dot.width, dotHeight: dot.height, dotRadius: dot.borderRadius,
                dotColor: dot.borderColor, dotBackground: dot.backgroundColor,
                dotX: rect.left + parseFloat(dot.left) + parseFloat(dot.width) / 2,
                identityLeft: (row.querySelector('.bp-benchmark-link-name, .bp-auto-version-button') ?? identity)?.getBoundingClientRect().left,
                overflow: row.scrollWidth > row.clientWidth + 1 };
        })
    }));
    assert.equal(geometry.role, 'list'); assert.equal(geometry.marker, 'none');
    const steps = geometry.rows.filter(row => row.step);
    assert.equal(steps.length, expected);
    for (const row of geometry.rows) {
        assert.notEqual(row.line, 'none'); assert.equal(row.lineWidth, '1px'); assert.equal(row.lineColor, 'rgb(199, 203, 209)');
        assert.equal(row.overflow, false, JSON.stringify(row));
        if (!row.step) continue;
        assert.notEqual(row.dot, 'none'); assert.equal(row.dotWidth, '8px'); assert.equal(row.dotHeight, '8px');
        assert.equal(row.dotRadius, '50%'); assert.equal(row.dotColor, 'rgb(146, 154, 163)');
        assert.ok(Math.abs(row.dotX - row.x - .5) < .1, JSON.stringify(row));
        assert.ok(row.identityLeft > row.dotX + 8, JSON.stringify(row));
    }
    for (let index = 1; index < geometry.rows.length; index++) {
        const before = geometry.rows[index - 1], after = geometry.rows[index];
        assert.ok(Math.abs(before.x - after.x) < .1, JSON.stringify({ before, after }));
        assert.ok(Math.abs(before.end - after.start) <= 1, JSON.stringify({ before, after }));
    }
    return { steps: steps.length, line: '1px neutral', nodes: '8px hollow', continuous: true };
}
async function drag(page, key, target) {
    const handle = page.locator(`#inline-fallback-chart [data-family-focus="drag-${key}"]`);
    await handle.scrollIntoViewIfNeeded();
    const from = await handle.boundingBox();
    const targetHandle = page.locator(`#inline-fallback-chart [data-family-focus="drag-${target}"]`);
    const before = await targetHandle.boundingBox();
    const direction = before.y < from.y ? -1 : 1;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + direction * 10);
    await page.locator('#inline-fallback-chart .bp-family-chain.is-reordering').waitFor();
    const targetRow = page.locator(`#inline-fallback-chart .bp-family-member[data-condition-id="${target}"]`);
    const to = await targetRow.boundingBox();
    let y = to.y + to.height / 2 + direction * to.height / 4;
    await page.mouse.move(from.x + from.width / 2, y, { steps: 12 });
    for (let attempt = 0; attempt < 4 && !await targetRow.evaluate(node => node.classList.contains('is-drop-target')); attempt++) {
        y += direction * 8; await page.mouse.move(from.x + from.width / 2, y);
    }
    assert.equal(await targetRow.evaluate(node => node.classList.contains('is-drop-target')), true, 'Drag must reach the intended visible drop target');
    await page.mouse.up();
}

async function retainedRenderers(page, app, label) {
    await page.route(`${app.url}/fallback-chain-contract`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css"><link rel="stylesheet" href="/css/ui/tokens.css">
        <link rel="stylesheet" href="/css/ui/fallback.css"><link rel="stylesheet" href="/css/ui/benchmark-families.css">
        <link rel="stylesheet" href="/css/ui/benchmark-chain-layouts.css"></head>
        <body style="margin:16px; font-family:Arial,sans-serif; color:#1f2937; background:white">
        <main style="width:100%; max-width:420px; margin:auto"><div id="public-renderer"></div><div id="compatibility"></div></main></body></html>` }));
    await page.goto(`${app.url}/fallback-chain-contract`);
    await page.evaluate(async ({ primary, rule }) => {
        const { createFamilyView } = await import('/js/workspace/family-view.js');
        const host = document.getElementById('public-renderer');
        createFamilyView({ container: host, getMemberURL: member => `/dialogPage?conditionID=${member.conditionID ?? member.ID}`,
            onMove() {}, onRemove() {}, onInspectGroup: entry => { host.dataset.inspectedGroup = entry.name; },
            onInspectVersion: event => { event.preventDefault(); host.dataset.inspectedVersion = event.currentTarget.href; }
        }).renderPublic({ primary, families: [{ ...rule, weightBasisPoints: 10000, overallWeightBasisPoints: 2600 }] });
        for (const layout of ['inline', 'numbered', 'vertical', 'wrap']) {
            const card = document.createElement('section'); card.className = 'bp-benchmark-card'; card.dataset.chainLayout = layout;
            const list = document.createElement('ol'); list.className = 'bp-benchmark-family-chain';
            ['General knowledge', 'All other versions', 'Code generation'].forEach((name, index) => {
                const item = document.createElement('li');
                const unit = document.createElement('span'); unit.className = 'bp-fallback-unit';
                const number = document.createElement('span'); number.className = 'bp-fallback-step-number'; number.textContent = String(index + 1);
                const connector = document.createElement('i'); connector.className = 'bp-fallback-connector fa-solid fa-chevron-right';
                const step = document.createElement('span'); step.className = 'bp-fallback-step'; step.textContent = name;
                unit.append(number, connector, step); item.append(unit); list.append(item);
            });
            card.append(list); document.getElementById('compatibility').append(card);
        }
    }, { primary: benchmarks[0], rule });
    await page.locator('#public-renderer .bp-family-summary').click();
    const publicChain = page.locator('#public-renderer .bp-family-expanded-chain');
    await publicChain.waitFor(); const publicEvidence = await chain(publicChain, 5);
    await publicChain.locator('.bp-auto-version-button').click();
    assert.equal(await page.locator('#public-renderer').getAttribute('data-inspected-group'), 'General knowledge');
    await publicChain.locator('a').first().click();
    assert.match(await page.locator('#public-renderer').getAttribute('data-inspected-version'), /conditionID=1$/);
    const compatibility = await page.locator('#compatibility .bp-benchmark-card').evaluateAll(cards => cards.map(card => ({
        layout: card.dataset.chainLayout,
        numbers: [...card.querySelectorAll('.bp-fallback-step-number, .bp-fallback-connector')].map(node => getComputedStyle(node).display),
        units: [...card.querySelectorAll('.bp-fallback-unit')].map(node => {
            const box = node.getBoundingClientRect(), line = getComputedStyle(node, '::before'), dot = getComputedStyle(node, '::after');
            return { top: box.top, bottom: box.bottom, x: box.left + parseFloat(line.left), line: line.width,
                color: line.backgroundColor, dot: dot.width, radius: dot.borderRadius };
        })
    })));
    for (const card of compatibility) {
        assert.ok(card.numbers.every(value => value === 'none'));
        for (const unit of card.units) {
            assert.equal(unit.line, '1px'); assert.equal(unit.color, 'rgb(199, 203, 209)');
            assert.equal(unit.dot, '8px'); assert.equal(unit.radius, '50%');
        }
        for (let index = 1; index < card.units.length; index++) {
            assert.ok(Math.abs(card.units[index].top - card.units[index - 1].bottom) <= 1);
            assert.ok(Math.abs(card.units[index].x - card.units[index - 1].x) < .1);
        }
    }
    await page.screenshot({ path: join(output, `${label}-retained-renderers.png`) });
    return { publicExpanded: publicEvidence, legacyLayouts: compatibility.map(card => card.layout), numbersHidden: true };
}

for (const [engine, launcher, width] of matrix) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const browser = await launcher.launch({ headless: true, env });
    const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true, comparisonModels,
        personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 6, weightBasisPoints: 4000 }]),
        fallbackRules: [structuredClone(rule)], families: [rule, alternative, addRule, long],
        publicFamilyComposition: [{ primaryConditionID: 1, families: [
            { ...rule, weightBasisPoints: 6000, overallWeightBasisPoints: 1560 },
            { ...alternative, weightBasisPoints: 4000, overallWeightBasisPoints: 1040 }
        ] }] });
    const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 1000 },
        isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = `${engine}-${width}`;
    const evidence = {};
    const picker = page.locator('#fallback-picker');
    try {
        await context.addInitScript(() => {
            localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            localStorage.setItem('benchpoll-fallback-appearance-v1', 'rail');
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', personalFallbackExpanded: true }));
        });
        await page.goto(app.url, { waitUntil: 'domcontentloaded' }); await ready(page); await page.evaluate(() => document.fonts.ready);
        await selectPrimary(page); await page.locator('#inline-fallback-preview').waitFor();
        const initialWrites = writes(app), weights = structuredClone(app.state.personalEntries);
        const preview = page.locator('#inline-fallback-preview-sequence .bp-family-chain');
        evidence.preview = await chain(preview, 4);
        assert.equal(await preview.locator('.bp-family-actions').count(), 0);
        assert.equal(await preview.locator('.bp-family-attachment .fa-link').count(), 1);
        await page.locator('#inline-fallback-settings').screenshot({ path: join(output, `${label}-browse.png`) });
        await preview.locator('.bp-auto-version-button').click();
        await page.locator('#version-group-dialog .bp-version-group-body[aria-busy="false"]').waitFor();
        assert.equal(await page.locator('.bp-version-group-introduction strong').innerText(), 'General knowledge');
        evidence.priority = await chain(page.locator('.bp-version-priority-list'), 1);
        assert.equal(await page.locator('.bp-version-group-introduction .fa-layer-group').count(), 1);
        await page.screenshot({ path: join(output, `${label}-priority.png`) });
        await inspect(page, page.locator('.bp-version-priority-list a').first(), app);
        await selectPrimary(page);
        assert.equal(await preview.locator('a').count(), 0);
        const informationReads = app.state.requests.filter(request => request.path === '/api/get_benchmark_information').length;
        await preview.locator('.bp-benchmark-link-name').first().click(); await picker.waitFor();
        assert.equal(app.state.requests.filter(request => request.path === '/api/get_benchmark_information').length, informationReads);
        await picker.locator('.bp-fallback-picker-cancel').click();
        await selectPrimary(page); await page.locator('#inline-fallback-edit').click();
        const editing = page.locator('#inline-fallback-chart .bp-family-chain');
        evidence.editor = await chain(editing, 4);
        assert.equal(await editing.locator('a').count(), 0);
        assert.equal(await editing.locator('[data-family-focus="up-901"]').isDisabled(), true);
        assert.equal(await editing.locator('[data-family-focus="down-2"]').isDisabled(), true);
        assert.equal(writes(app), initialWrites);
        await page.locator('#inline-fallback-settings').screenshot({ path: join(output, `${label}-editor.png`) });
        await editing.locator('[data-family-focus="up-3"]').click(); await saved(page, app, [901, 3, 'other_versions', 2]);
        assert.deepEqual(await editing.locator('.bp-family-attachment > span').allTextContents(), ['Code generation']);
        assert.match(await editing.locator('.bp-auto-version-button').getAttribute('aria-label'), /Code generation/);
        await editing.locator('[data-family-focus="down-3"]').click(); await saved(page, app, [901, 'other_versions', 3, 2]);
        await drag(page, 2, 3); await saved(page, app, [901, 'other_versions', 2, 3]);
        await drag(page, 2, 3); await saved(page, app, [901, 'other_versions', 3, 2]);
        evidence.reordered = await chain(editing, 4);
        await editing.locator('[data-family-focus="remove-2"]').click(); await saved(page, app, [901, 'other_versions', 3]);
        await page.locator('#workspace-undo').click(); await saved(page, app, [901, 'other_versions', 3, 2]);
        await page.locator('#workspace-redo').click(); await saved(page, app, [901, 'other_versions', 3]);
        await page.locator('#workspace-undo').click(); await saved(page, app, [901, 'other_versions', 3, 2]);
        assert.deepEqual(app.state.personalEntries, weights);
        if (await page.locator('#inline-fallback-done').isVisible()) await page.locator('#inline-fallback-done').click();
        await selectPrimary(page); await page.locator('#inline-fallback-preview').press('Enter'); await picker.waitFor();
        assert.equal(await picker.getAttribute('data-action'), 'replace');
        evidence.choose = await chain(picker.locator('.bp-fallback-picker-steps').first(), 5);
        assert.equal(await picker.locator('.bp-fallback-picker-column').first().locator('input').isChecked(), true);
        const beforeBrowsing = writes(app);
        const more = picker.locator('.bp-fallback-picker-more');
        for (let count = 0; count < 5 && await more.isVisible(); count++) {
            await page.waitForFunction(() => !document.querySelector('.bp-fallback-picker-more').disabled); await more.click();
            await page.waitForFunction(() => !document.querySelector('.bp-fallback-picker-more').disabled);
        }
        const longList = picker.locator(`[data-family-key='${familyKey(1, long.entries)}'] .bp-fallback-picker-steps`);
        await longList.waitFor(); evidence.longOrder = await chain(longList, 31);
        assert.ok(await longList.evaluate(node => node.scrollHeight > node.clientHeight));
        const appearance = await picker.locator('.bp-fallback-picker-column').first().evaluate(node => ({
            border: getComputedStyle(node).borderTopWidth, background: getComputedStyle(node).backgroundColor,
            dotBackground: getComputedStyle(node.querySelector('li'), '::after').backgroundColor }));
        assert.equal(appearance.border, '0px'); assert.equal(appearance.dotBackground, appearance.background);
        await page.screenshot({ path: join(output, `${label}-choose.png`) });
        await longList.scrollIntoViewIfNeeded(); await longList.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.screenshot({ path: join(output, `${label}-long-order.png`) });
        await picker.locator('.bp-fallback-picker-cancel').click();
        await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="4"] .bp-benchmark-add').click(); await picker.waitFor();
        assert.equal(await picker.getAttribute('data-action'), 'add');
        evidence.add = await chain(picker.locator('.bp-fallback-picker-steps').first(), 3);
        await page.screenshot({ path: join(output, `${label}-add.png`) });
        await picker.locator('.bp-fallback-picker-cancel').click();
        assert.equal(writes(app), beforeBrowsing);
        await page.locator('#pie-mode-public').click(); await ready(page); await selectPrimary(page);
        await page.locator('#public-fallback-toggle').click(); await picker.waitFor();
        assert.equal(await picker.locator('input, .is-selected').count(), 0);
        assert.ok(await picker.locator('.bp-fallback-picker-badge').count() > 0);
        evidence.public = await chain(picker.locator('.bp-fallback-picker-steps').first(), 5);
        await picker.locator('.bp-auto-version-button').first().click();
        await page.locator('#version-group-dialog .bp-version-group-body[aria-busy="false"]').waitFor();
        await page.locator('#version-group-dialog .bp-version-group-close').click(); assert.equal(await picker.isVisible(), true);
        await page.screenshot({ path: join(output, `${label}-public.png`) });
        await picker.locator('.bp-fallback-picker-cancel').click();
        await page.locator('#pie-mode-personal').click(); await ready(page);
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        await page.locator('.bp-model-row').first().click(); await page.locator('#model-scores-dialog').waitFor();
        await page.locator('.bp-model-fallback-toggle').first().click();
        const actual = page.locator('.bp-model-fallback-path:not([hidden])').first();
        evidence.actual = await chain(actual, 3);
        assert.deepEqual(await actual.locator('li').evaluateAll(nodes => nodes.map(node => Number(node.dataset.conditionId))), [901, 900, 3]);
        assert.deepEqual(await actual.locator('li > small').allTextContents(), ['No score', 'No score', 'Used']);
        assert.doesNotMatch(await actual.innerText(), /Advanced reasoning/);
        await page.screenshot({ path: join(output, `${label}-actual-path.png`) });
        await inspect(page, actual.locator('a').last(), app);
        assert.equal(await page.locator('.bp-family-order, .bp-fallback-picker-step-number, .bp-version-priority-number').count(), 0);
        assert.deepEqual(app.state.personalEntries, weights);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        evidence.retained = await retainedRenderers(page, app, label);
        assert.deepEqual(errors, []);
        reports.push({ name: label, passed: true, evidence, pageErrors: errors,
            interactions: ['dynamic priority and link', 'preview information link', 'move earlier/later and re-anchor', 'drag both directions', 'remove', 'undo/redo',
                'Choose/Popular/long order', 'Add cancel', 'read-only Public and nested dialog', 'actual attempted prefix and link'],
            databaseAccess: false });
        console.log(JSON.stringify({ name: label, passed: true, evidence }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true });
        reports.push({ name: label, passed: false, error: error.stack, evidence, pageErrors: errors }); throw error;
    } finally {
        await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
        await context.close(); await browser.close(); await app.close();
    }
}
