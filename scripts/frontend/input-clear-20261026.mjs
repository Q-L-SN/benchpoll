import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from './topics-home-fixtures.mjs';
import { startConfigSidebarPreview } from '../../test/helpers/config-sidebar-fixture-20261022.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require(join(dirname(require.resolve('playwright-core')), 'lib/utilsBundle.js'));
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(process.env.INPUT_CLEAR_OUTPUT || 'D:/Codex-artifacts/website1/topic-identity-ui-20261026/input-clear');
await mkdir(join(output, 'tmp'), { recursive: true });
process.env.TEMP = join(output, 'tmp');
process.env.TMP = join(output, 'tmp');
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const report = { passed: false, cases: [], errors: [] };
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/global.css"><link rel="stylesheet" href="/css/site-palette.css">
<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
<style>main { max-width: 620px; padding: 16px; margin: auto; } form { display: grid; gap: 12px; }
label, fieldset { display: grid; gap: 4px; min-width: 0; } fieldset { padding: 8px; }
#dynamic { display: grid; gap: 12px; margin-block: 12px; }
button:hover, button:active { background: red; box-shadow: 0 0 0 5px red; }
dialog { width: min(90vw, 460px); margin: auto; padding: 16px; }</style>
</head><body><main><form id="fields">
<label>Standalone search<input id="plain" name="query" type="search" value="Initial query" required autocomplete="off"></label>
<label class="bp-ui-field"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="framed" type="search" aria-label="Framed search" value="Frame query"></label>
<label>Explicit text<input id="text" type="text" name="title" data-ui-clearable required value="A title"></label>
<label>Read only<input id="readonly" type="search" readonly value="Protected"></label>
<label>Disabled<input id="disabled" type="search" disabled value="Disabled"></label>
<fieldset id="group" disabled><legend>Disabled group</legend><label>Group search<input id="fieldset" type="search" value="Group"></label></fieldset>
<label>Opted out<input id="optout" type="search" data-ui-clearable="false" value="Native"></label>
<label>Ordinary text<input id="ordinary" name="ordinary" value="Unrelated"></label>
<input id="number" type="number" data-ui-clearable value="2"><input id="password" type="password" data-ui-clearable value="secret">
<button id="unrelated" type="button"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span>Unrelated command</span></button>
<button id="reset-button" type="reset">Reset form</button><button id="submit-button" type="submit">Submit</button>
</form><div id="dynamic"></div><dialog id="modal"><form method="dialog"><label>Modal search<input id="modal-search" type="search" value="Modal query"></label><button id="modal-close">Close</button></form></dialog></main>
<script type="module">import { enhanceUI, mountInputClear, observeInputClears } from '/js/shared/ui-components.js';
window.clearFixture = { events: [], blurs: 0, submits: 0, resets: 0, escapes: 0, mountInputClear, observeInputClears };
document.addEventListener('input', record); document.addEventListener('change', record);
for (const type of ['pointerdown', 'click']) document.addEventListener(type, event => { window.clearFixture.lastPointer = { type, target: event.target.outerHTML, x: event.clientX, y: event.clientY }; }, true);
function record(event) { if (event.target.matches('input')) window.clearFixture.events.push([event.type, event.target.id, event.target.value, event.bubbles, event.composed]); }
document.getElementById('plain').addEventListener('blur', () => window.clearFixture.blurs++);
document.getElementById('fields').addEventListener('submit', event => { event.preventDefault(); window.clearFixture.submits++; });
document.getElementById('fields').addEventListener('reset', () => window.clearFixture.resets++);
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.clearFixture.escapes++; });
enhanceUI(); window.clearFixture.ready = true;</script></body></html>`;

async function startFields() {
    const publicRoot = resolve(root, 'public');
    const types = { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff' };
    const server = createServer(async (request, response) => {
        try {
            const pathname = new URL(request.url, 'http://localhost').pathname;
            if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(fixture); return; }
            const path = resolve(publicRoot, '.' + decodeURIComponent(pathname));
            if (!path.startsWith(publicRoot + sep)) { response.writeHead(404); response.end(); return; }
            response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
            response.end(await readFile(path));
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function fieldButton(page, id) {
    await page.waitForFunction(id => document.getElementById(id)?.classList.contains('bp-ui-clear-input'), id);
    return page.locator('#' + id).locator('..').locator('> .bp-ui-field-clear');
}

async function appearance(button) {
    return button.evaluate(node => {
        const css = getComputedStyle(node);
        return { background: css.backgroundColor, image: css.backgroundImage, shadow: css.boxShadow,
            color: css.color, transform: css.transform, border: css.borderWidth };
    });
}

async function target(page, button) {
    await button.scrollIntoViewIfNeeded();
    const result = await button.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const samples = [2, 22, 42].flatMap(x => [2, 22, 42].map(y => {
            const target = document.elementFromPoint(rect.left + x, rect.top + y);
            return target === node || node.contains(target);
        }));
        const icon = node.querySelector('i').getBoundingClientRect();
        return { width: rect.width, height: rect.height, samples, glyph: { width: icon.width, height: icon.height },
            before: getComputedStyle(node.querySelector('i'), '::before').content };
    });
    assert.equal(result.width, 44);
    assert.equal(result.height, 44);
    assert.ok(result.samples.every(Boolean), 'All nine points inside the 44px target must hit the control: ' + JSON.stringify(result));
    assert.deepEqual(result.glyph, { width: 16, height: 16 });
    assert.ok(!['none', 'normal', '""'].includes(result.before), 'Font Awesome cross is rendered');
    return result;
}

async function transparentStates(page, button) {
    await button.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const rest = await appearance(button);
    assert.equal(rest.background, 'rgba(0, 0, 0, 0)');
    assert.equal(rest.image, 'none');
    assert.equal(rest.shadow, 'none');
    assert.equal(rest.border, '0px');
    const rect = await button.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert.deepEqual(await appearance(button), rest, 'Hover must not change the clear skin');
    await page.mouse.down();
    assert.equal(await button.evaluate(node => node.matches(':active')), true);
    assert.deepEqual(await appearance(button), rest, 'Pressed must not change the clear skin');
    await page.mouse.move(0, 0);
    await page.mouse.up();
    return rest;
}

async function activate(page, button, touch, position = { x: 2, y: 2 }) {
    if (touch) await button.tap({ position });
    else await button.click({ position });
}

async function nativeClearSuppressed(page, input, button, name) {
    await input.focus();
    await input.scrollIntoViewIfNeeded();
    await button.evaluate(node => node.style.visibility = 'hidden');
    try {
        const rect = await input.boundingBox();
        const bytes = await page.screenshot({ clip: { x: rect.x + rect.width - 35, y: rect.y + 6, width: 30, height: rect.height - 12 } });
        await writeFile(join(output, name + '-native-cancel-suppressed.png'), bytes);
        const png = PNG.sync.read(bytes), reference = [...png.data.subarray(0, 3)];
        let ink = 0;
        for (let i = 0; i < png.data.length; i += 4) if (reference.some((channel, index) => Math.abs(channel - png.data[i + index]) > 12)) ink++;
        assert.equal(ink, 0, 'Hiding the custom glyph must leave no second native cancel glyph');
        return { sampledPixels: png.width * png.height, unexpectedInkPixels: ink };
    } finally { await button.evaluate(node => node.style.removeProperty('visibility')); }
}

async function fieldsCase(page, touch, name) {
    await page.goto(fields.url);
    await page.waitForFunction(() => window.clearFixture?.ready);
    await page.evaluate(() => document.fonts.ready);
    const input = page.locator('#plain'), clear = await fieldButton(page, 'plain');
    const measured = { standalone: await target(page, clear), skin: await transparentStates(page, clear) };
    const frame = await fieldButton(page, 'framed');
    measured.framed = await target(page, frame);
    assert.equal(await input.locator('..').locator('.bp-ui-field-clear').count(), 1);
    measured.nativeCancel = await nativeClearSuppressed(page, input, clear, name);
    for (const id of ['readonly', 'disabled', 'fieldset']) {
        const button = await fieldButton(page, id);
        assert.equal(await button.isVisible(), false);
        assert.equal(await button.isDisabled(), true);
        const value = await page.locator('#' + id).inputValue();
        await button.evaluate(node => node.click());
        assert.equal(await page.locator('#' + id).inputValue(), value);
    }
    for (const id of ['optout', 'ordinary', 'number', 'password']) assert.equal(await page.locator('#' + id).getAttribute('class'), 'bp-ui-input');
    assert.equal(await page.locator('#unrelated').getAttribute('class'), null);
    await input.fill('Clear by pointer');
    await page.evaluate(() => { window.clearFixture.events = []; window.clearFixture.blurs = 0; });
    await activate(page, clear, touch);
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    assert.equal(await clear.isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.clearFixture.events), [['input', 'plain', '', true, true], ['change', 'plain', '', true, true]]);
    assert.equal(await page.evaluate(() => window.clearFixture.blurs), 0);
    assert.equal(await page.evaluate(() => window.clearFixture.submits), 0);
    assert.equal(await input.evaluate(node => node.validity.valueMissing), true);
    assert.equal(await input.evaluate(node => new FormData(node.form).get('query')), '');

    await input.fill('Keyboard clear');
    await input.press('Tab');
    assert.equal(await clear.evaluate(node => node === document.activeElement && node.matches(':focus-visible')), true);
    assert.equal(await clear.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    assert.equal(await clear.evaluate(node => getComputedStyle(node).outlineWidth), '2px');
    await page.evaluate(() => { window.clearFixture.events = []; });
    await clear.press('Space');
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => window.clearFixture.events), [['input', 'plain', '', true, true], ['change', 'plain', '', true, true]]);

    await page.evaluate(() => { const input = document.getElementById('plain'); input.value = 'Programmatic'; });
    assert.equal(await clear.isVisible(), true);
    await page.evaluate(() => document.getElementById('plain').value = '');
    assert.equal(await clear.isVisible(), false);
    await page.evaluate(() => document.getElementById('fields').reset());
    assert.equal(await input.inputValue(), 'Initial query');
    assert.equal(await clear.isVisible(), true);
    await input.fill('');
    await page.evaluate(() => {
        const form = document.getElementById('fields');
        form.addEventListener('reset', event => event.preventDefault(), { once: true });
        form.reset();
    });
    assert.equal(await input.inputValue(), '');
    assert.equal(await clear.isVisible(), false);
    await page.evaluate(() => document.getElementById('group').disabled = false);
    assert.equal(await (await fieldButton(page, 'fieldset')).isVisible(), true);
    await page.evaluate(() => document.getElementById('plain').readOnly = true);
    await page.evaluate(() => document.getElementById('plain').value = 'Readonly race');
    await clear.evaluate(node => node.click());
    assert.equal(await input.inputValue(), 'Readonly race');
    assert.equal(await clear.isVisible(), false);
    await page.evaluate(() => document.getElementById('plain').readOnly = false);
    assert.equal(await clear.isVisible(), true);

    await page.evaluate(() => {
        document.getElementById('dynamic').innerHTML = '<div class="bp-ui-select"><div class="bp-ui-field bp-ui-select-search"><input id="select-search" type="search" aria-label="Dynamic select search" value="Dynamic query"></div></div>';
    });
    const dynamic = page.locator('#select-search'), dynamicClear = await fieldButton(page, 'select-search');
    assert.equal(await dynamic.locator('..').locator('.bp-ui-field-clear').count(), 1);
    await dynamic.fill('Dynamic select');
    measured.dynamic = await target(page, dynamicClear);
    await activate(page, dynamicClear, touch);
    assert.equal(await dynamic.inputValue(), '');
    assert.equal(await dynamic.evaluate(node => node === document.activeElement), true);
    await page.evaluate(() => {
        const host = document.getElementById('dynamic');
        host.append(host.firstElementChild.cloneNode(true));
        host.lastElementChild.querySelector('input').id = 'cloned-search';
    });
    const cloned = page.locator('#cloned-search'), clonedClear = await fieldButton(page, 'cloned-search');
    await cloned.fill('Cloned query');
    assert.equal(await cloned.locator('..').locator('.bp-ui-field-clear').count(), 1);
    await activate(page, clonedClear, touch);
    assert.equal(await cloned.inputValue(), '');
    await page.evaluate(() => document.getElementById('dynamic').append(document.getElementById('select-search')));
    await page.waitForFunction(() => document.getElementById('select-search').parentElement.matches('.bp-ui-input-shell'));
    await dynamic.fill('Moved query');
    await activate(page, await fieldButton(page, 'select-search'), touch);
    assert.equal(await dynamic.inputValue(), '');
    await page.evaluate(() => {
        const input = document.createElement('input'); input.id = 'changed-type'; input.value = 'Type change';
        document.getElementById('dynamic').append(input); input.type = 'search';
    });
    await fieldButton(page, 'changed-type');
    await page.evaluate(() => document.getElementById('changed-type').type = 'number');
    await page.waitForFunction(() => !document.getElementById('changed-type').classList.contains('bp-ui-clear-input'));
    await page.evaluate(() => document.getElementById('modal').showModal());
    const modalSearch = page.locator('#modal-search'), modalClear = await fieldButton(page, 'modal-search');
    measured.modal = await target(page, modalClear);
    await activate(page, modalClear, touch);
    assert.equal(await modalSearch.inputValue(), '');
    assert.equal(await modalSearch.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#modal').evaluate(node => node.open), true);
    await modalSearch.press('Escape');
    await page.waitForFunction(() => !document.getElementById('modal').open);
    assert.equal(await page.evaluate(() => window.clearFixture.escapes), 1, 'Field behavior does not swallow Escape');
    await page.evaluate(() => { document.getElementById('plain').value = 'Search Escape'; document.getElementById('plain').focus(); });
    await input.press('Escape');
    assert.equal(await page.evaluate(() => window.clearFixture.escapes), 2);
    measured.nativeEscapeValue = await input.inputValue();
    assert.equal(await page.evaluate(() => window.clearFixture.submits), 0);
    await page.screenshot({ path: join(output, name + '-fields.png'), fullPage: true });
    return measured;
}

async function homeCase(page, touch, name) {
    await page.goto(home.url);
    await page.locator('#topics-grid .th-card').first().waitFor();
    await page.locator('#topic-search-toggle').click();
    const input = page.locator('#topic-search'), button = page.locator('#topic-search-close');
    await page.waitForFunction(() => document.getElementById('topic-search-close').classList.contains('bp-ui-field-clear'));
    const measured = { target: await target(page, button), skin: await transparentStates(page, button) };
    assert.equal(await input.locator('..').locator('.bp-ui-field-clear').count(), 1);
    assert.equal(await input.locator('..').locator('[data-ui-clear-generated]').count(), 0);
    assert.equal(await button.getAttribute('aria-label'), 'Close search');
    await input.fill('Nothing matches this query');
    assert.equal(await button.getAttribute('aria-label'), 'Clear search');
    await activate(page, button, touch);
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.isVisible(), true);
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    assert.equal(await button.getAttribute('aria-label'), 'Close search');
    await page.screenshot({ path: join(output, name + '-home.png') });
    await activate(page, button, touch);
    assert.equal(await input.isVisible(), false);
    assert.equal(await page.locator('#topic-search-toggle').evaluate(node => node === document.activeElement), true);
    await page.locator('#topic-search-toggle').click();
    await input.fill('Escape closes this search');
    await input.press('Escape');
    assert.equal(await input.isVisible(), false);
    assert.equal(await page.locator('#topic-search-toggle').evaluate(node => node === document.activeElement), true);
    return measured;
}

async function configurationCase(page, touch, name) {
    await page.goto(configuration.url + '/intelligence');
    if (touch) {
        await page.locator('#taxonomy-toggle').click();
    }
    await page.locator('#navigation-search-toggle').click();
    const input = page.locator('#configured-search'), button = page.locator('#navigation-search-close');
    await page.waitForFunction(() => document.getElementById('navigation-search-close').classList.contains('bp-ui-field-clear'));
    const measured = { target: await target(page, button), skin: await transparentStates(page, button) };
    await input.fill('Intelligence');
    assert.equal(await input.locator('..').locator('[data-ui-clear-generated]').count(), 0);
    assert.equal(await button.getAttribute('aria-label'), 'Close topic search');
    await page.screenshot({ path: join(output, name + '-configuration.png') });
    await activate(page, button, touch);
    assert.equal(await input.isVisible(), false);
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.locator('#navigation-search-toggle').evaluate(node => node === document.activeElement), true);
    await page.locator('#navigation-search-toggle').click();
    await input.fill('Escape retains close semantics');
    await input.press('Escape');
    assert.equal(await input.isVisible(), false);
    assert.equal(await page.locator('#navigation-search-toggle').evaluate(node => node === document.activeElement), true);
    if (touch) await page.locator('#taxonomy-close').click();
    const benchmark = page.locator('#benchmark-search'), benchmarkClear = await fieldButton(page, 'benchmark-search');
    await benchmark.fill('zz');
    measured.benchmark = await target(page, benchmarkClear);
    await activate(page, benchmarkClear, touch);
    assert.equal(await benchmark.inputValue(), '');
    assert.equal(await benchmark.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#benchmark-leaderboard-close').evaluate(node => node.classList.contains('bp-ui-field-clear')), false);
    if (touch) await page.locator('[data-mobile-panel="models"]').click();
    await page.locator('.bp-model-row').first().click();
    await page.locator('#model-scores-dialog').waitFor();
    await page.waitForFunction(() => document.getElementById('model-scores-dialog').contains(document.activeElement));
    const scores = page.locator('#model-scores-search'), scoresClear = await fieldButton(page, 'model-scores-search');
    await scores.fill('zz');
    measured.scoresModal = await target(page, scoresClear);
    await transparentStates(page, scoresClear);
    await activate(page, scoresClear, touch);
    assert.equal(await scores.inputValue(), '');
    assert.equal(await scores.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#model-scores-dialog').isVisible(), true);
    await page.screenshot({ path: join(output, name + '-scores-modal.png') });
    await scores.press('Escape');
    assert.equal(await page.locator('#model-scores-dialog').isVisible(), false);
    return measured;
}

const fields = await startFields();
let home, configuration;
try {
    if (!process.argv.includes('--fields-only')) {
        home = await startTopicsPreview({ previewDelay: 0 });
        configuration = await startConfigSidebarPreview();
        // The shared fixture predates canonical name/slug identity for its second Research topic.
        const duplicate = configuration.topics.find(topic => topic.ID === 190 && topic.name === 'Research' && topic.slug === 'research-190');
        if (duplicate) duplicate.name = 'Research 190';
    }
    const engineOnly = process.argv.find(arg => arg.startsWith('--engine='))?.split('=')[1];
    const widthOnly = process.argv.find(arg => arg.startsWith('--width='))?.split('=')[1]?.split(',').map(Number);
    for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
        if (engineOnly && engine !== engineOnly) continue;
        const browser = await launcher.launch({ headless: true, env });
        try {
            for (const width of engine === 'chromium' ? [1440, 768, 390, 320] : [390]) {
                if (widthOnly && !widthOnly.includes(width)) continue;
                const name = `${engine}-${width}`, touch = width < 760;
                const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' });
                const page = await context.newPage();
                page.setDefaultTimeout(10000);
                page.on('pageerror', error => report.errors.push({ name, error: error.message }));
                const entry = { name, passed: false };
                report.cases.push(entry);
                try {
                    if (!process.argv.includes('--pages-only')) entry.fields = await fieldsCase(page, touch, name);
                    if (home) { entry.home = await homeCase(page, touch, name); entry.configuration = await configurationCase(page, touch, name); }
                    assert.deepEqual(report.errors, []);
                    entry.passed = true;
                    console.log(name + ': clear controls passed');
                } catch (error) {
                    entry.error = error.stack;
                    entry.lastPointer = await page.evaluate(() => window.clearFixture?.lastPointer);
                    await page.screenshot({ path: join(output, name + '-failure.png'), fullPage: true }).catch(() => {});
                    throw error;
                } finally { await context.close(); }
            }
        } finally { await browser.close(); }
    }
    assert.ok(report.cases.length);
    report.passed = true;
} finally {
    await fields.close();
    await home?.close();
    await configuration?.close();
    await mkdir(dirname(join(output, 'report.json')), { recursive: true });
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
