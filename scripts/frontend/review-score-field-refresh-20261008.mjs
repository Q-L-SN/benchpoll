import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const modulePath = 'public/js/contribution/score-fields.js';
const allowedModules = new Set([
    modulePath, 'public/js/shared/score-fields.js', 'public/js/shared/score-field-presets.js',
    'public/js/shared/ui-components.js', 'public/js/shared/custom-select.js', 'public/js/shared/input-clear.js',
    'public/js/shared/disclosure-chevron.js', 'public/js/shared/textarea-autosize.js'
]);
const fixtureHTML = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixed score fields</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#242424;font:16px Arial,sans-serif}
main{max-width:760px;margin:24px auto;padding:0 16px}h3{font-size:16px}
.score-field-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.score-field-row>span{flex:0 1 28%;display:inline-flex;align-items:center;gap:8px}
.score-field-value{flex:1;min-width:0}.score-field-value .bp-ui-select{width:100%}
.score-field-error{color:#a21c36}.score-field-error:empty{display:none}#outside{margin-top:16px}
</style><main><section id="editor" class="score-field-editor"></section>
<button id="outside" type="button">Outside editor</button></main></html>`;

export const scoreFieldRefreshScenarios = [
    'fixed-fields-only', 'approved-option-selection', 'optional-and-empty', 'pending-options-hidden',
    'option-renamed', 'selected-option-removed', 'option-restored', 'unrelated-history',
    'stale-failure', 'superseded-success', 'current-failure-retry', 'detached-editor',
    'remounted-editor', 'retired-field', 'field-restored'
];

async function bundleModule(path, sourceRoot, cache, modules) {
    if (cache.has(path)) return cache.get(path);
    const relative = path.slice(resolve(sourceRoot).length + 1).replaceAll(sep, '/');
    assert.ok(allowedModules.has(relative), `Unexpected editor dependency: ${relative}`);
    let source = await readFile(path, 'utf8');
    for (const match of [...source.matchAll(/\bfrom\s+(['"])(\.[^'"]+)\1/g)]) {
        const dependency = fileURLToPath(new URL(match[2], pathToFileURL(path)));
        const url = await bundleModule(dependency, sourceRoot, cache, modules);
        source = source.replace(match[0], `from '${url}'`);
    }
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    cache.set(path, url);
    modules.push(relative);
    return url;
}

async function setup(page, moduleURL, css) {
    await page.setContent(fixtureHTML);
    await page.addStyleTag({ content: css });
    await page.evaluate(async moduleURL => {
        const { mountScoreFields, contributionScoreFields } = await import(moduleURL);
        let fields = [
            { ID: 20, name: 'Effort', type: 'enum', allowEmpty: false,
                options: [{ ID: 101, label: 'High' }, { ID: 102, label: 'Low' }, { ID: 103, label: 'Pending effort', pending: true }] },
            { ID: 7, name: 'Harness', type: 'enum', allowEmpty: true,
                options: [{ ID: 30, label: 'Agent A' }, { ID: 31, label: 'Agent Z' }, { ID: null, requestID: 99, label: 'Pending harness', pending: true }] },
            { ID: 8, name: 'Token budget', type: 'number', options: [] },
            { ID: 9, name: 'Harness version', type: 'text', options: [] },
            { ID: 10, name: 'Reasoning effort', type: 'enum', options: [{ ID: 50, label: 'Alias' }] },
            { ID: null, requestID: 99, name: 'Custom pending field', type: 'presence', pending: true, options: [] }
        ];
        const initial = structuredClone(fields);
        const assignments = [{ fieldID: 20, value: 101 }, { fieldID: 7, value: 30 }, { fieldID: 8, value: '9001' }];
        const gates = [];
        const writes = [];
        let requestID = 0;
        let changes = 0;
        const refresh = async () => {
            const sequence = ++requestID;
            const next = await new Promise((resolve, reject) => gates.push({ resolve, reject }));
            if (sequence !== requestID) return false;
            fields = next;
            return true;
        };
        window.fetch = async (...args) => { writes.push(args); throw Error('Editor must not submit requests'); };
        window.reviewMount = () => mountScoreFields(document.getElementById('editor'), {
            assignments, getFields: () => fields, refresh, onChange: () => changes++
        });
        window.reviewFinish = (index, action = 'none', failed = false) => {
            const gate = gates[index];
            if (!gate) throw Error('Missing refresh gate ' + index);
            if (failed) { gate.reject(Error('Synthetic refresh failure')); return; }
            const next = structuredClone(initial);
            if (action === 'rename') next[0].options[0].label = 'High revised';
            if (action === 'remove-option') next[0].options = next[0].options.filter(option => option.ID !== 101);
            if (action === 'remove-field') next.splice(0, 1);
            gate.resolve(next);
        };
        window.reviewState = () => ({
            assignments: structuredClone(assignments), payload: contributionScoreFields(assignments, fields),
            changes, writes: writes.length, refreshCount: gates.length,
            labels: [...document.querySelectorAll('.score-field-row > span')].map(node => node.textContent),
            status: document.querySelector('#editor > .score-field-error')?.textContent ?? '',
            options: [...document.querySelectorAll('.score-field-value select')].map(select => ({
                name: select.getAttribute('aria-label'), value: select.value, invalid: !select.validity.valid,
                options: [...select.options].map(option => ({ value: option.value, label: option.text, disabled: option.disabled }))
            })),
            sameControl: window.originalEffort === document.querySelector('select[aria-label="Effort value"]'),
            mounted: Boolean(document.getElementById('editor'))
        });
        window.reviewMount();
        window.originalEffort = document.querySelector('select[aria-label="Effort value"]');
    }, moduleURL);
}

async function exercise(page, scenario) {
    const failedChecks = [];
    const check = (name, actual, expected) => {
        try { assert.deepEqual(actual, expected); }
        catch { failedChecks.push({ name, actual, expected }); }
    };
    const read = () => page.evaluate(() => window.reviewState());
    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const focus = async name => { await page.getByRole('combobox', { name: `${name} value`, exact: true }).focus(); await settle(); };
    const finish = async (index, action = 'none', failed = false) => {
        await page.evaluate(({ index, action, failed }) => window.reviewFinish(index, action, failed), { index, action, failed });
        await settle();
    };
    const select = async (name, value) => {
        await page.getByRole('combobox', { name: `${name} value`, exact: true }).click();
        await page.getByRole('option', { name: value, exact: true }).click();
        await settle();
    };
    const initial = await read();
    let expectedAssignments = initial.assignments;
    let expectedChanges = 0;
    if (scenario === 'approved-option-selection' || scenario === 'unrelated-history') {
        await select('Effort', 'Low');
        expectedAssignments[0].value = 102;
        expectedChanges = 1;
        check('Approved choice updates the payload', (await read()).payload[0], { fieldID: 20, value: 102 });
    } else if (scenario === 'optional-and-empty') {
        await select('Effort', 'Not recorded');
        await select('Harness', 'Empty');
        expectedAssignments = [{ fieldID: 7, value: null }, initial.assignments[2]];
        expectedChanges = 2;
        check('Optional fields may be omitted and permitted empty values recorded', (await read()).payload, [{ fieldID: 7, value: null }]);
    } else if (scenario === 'pending-options-hidden') {
        await page.getByRole('combobox', { name: 'Harness value', exact: true }).click();
        check('Pending choices never appear in the picker', await page.getByRole('option', { name: /Pending/ }).count(), 0);
        check('Approved choices remain selectable', await page.getByRole('option', { name: 'Agent Z', exact: true }).count(), 1);
    } else if (['option-renamed', 'selected-option-removed', 'option-restored', 'retired-field', 'field-restored'].includes(scenario)) {
        await focus('Effort');
        const action = scenario === 'option-renamed' ? 'rename' : ['retired-field', 'field-restored'].includes(scenario) ? 'remove-field' : 'remove-option';
        await finish(0, action);
        let state = await read();
        if (scenario === 'option-renamed') {
            check('Selected option label refreshes by stable ID', state.options[0].options.find(option => option.value === '101').label, 'High revised');
            check('Refresh preserves the control node and focus', state.sameControl, true);
            check('Refreshed selected value remains valid', state.options[0].invalid, false);
        } else if (scenario === 'retired-field' || scenario === 'field-restored') {
            check('A retired fixed field cannot remain editable', state.labels, ['Harness']);
            check('An unavailable field cannot enter a fresh payload', state.payload, [{ fieldID: 7, value: 30 }]);
            if (scenario === 'field-restored') {
                await focus('Harness');
                await finish(1);
                check('Restored fixed fields return in canonical order', (await read()).labels, ['Effort', 'Harness']);
            }
        } else {
            check('Unavailable selection blocks submission without changing its identity', state.options[0].invalid, true);
            check('Unavailable selection is read-only', state.options[0].options.find(option => option.value === '101'),
                { value: '101', label: 'Value unavailable', disabled: true });
            if (scenario === 'option-restored') {
                await focus('Harness');
                await finish(1);
                state = await read();
                check('Restoring an approved choice clears stale validity', state.options[0].invalid, false);
                check('Restoring options preserves the existing control', state.sameControl, true);
            }
        }
    } else if (scenario === 'stale-failure' || scenario === 'superseded-success') {
        await focus('Effort');
        await focus('Harness');
        if (scenario === 'stale-failure') {
            await finish(0, 'none', true);
            check('An obsolete failure cannot replace current status', (await read()).status, '');
            await finish(1);
        } else {
            await finish(1, 'rename');
            await finish(0);
            check('An obsolete success cannot replace newer catalog options',
                (await read()).options[0].options.find(option => option.value === '101').label, 'High revised');
        }
    } else if (scenario === 'current-failure-retry') {
        await focus('Effort');
        await finish(0, 'none', true);
        check('Current refresh failure is visible', (await read()).status, 'Could not refresh options. Your draft has been kept.');
        await focus('Harness');
        await finish(1);
        check('Successful retry clears the error', (await read()).status, '');
    } else if (scenario === 'detached-editor' || scenario === 'remounted-editor') {
        await focus('Effort');
        await page.evaluate(detach => detach ? document.getElementById('editor').remove() : window.reviewMount(), scenario === 'detached-editor');
        await finish(0, 'none', true);
        check('A detached or replaced editor ignores obsolete errors', (await read()).status, '');
    }
    const actual = await read();
    if (!['retired-field', 'detached-editor'].includes(scenario)) check('Only fixed fields are editable', actual.labels, ['Effort', 'Harness']);
    check('Custom history remains untouched', actual.assignments.find(assignment => assignment.fieldID === 8), { fieldID: 8, value: '9001' });
    check('Draft changes only through an explicit selection', actual.assignments, expectedAssignments);
    check('Refresh cannot synthesize changes', actual.changes, expectedChanges);
    check('No field or option submissions', actual.writes, 0);
    check('No arbitrary field search or edit/create entry points',
        await page.locator('#editor input, #editor a, #editor .picker-create-link').count(), 0);
    check('Outgoing assignments contain only fixed field IDs', actual.payload.every(assignment => [7, 20].includes(assignment.fieldID)), true);
    return { failedChecks, observations: [initial, actual] };
}

export async function runScoreFieldRefreshReview({ baseline, output, engines = ['chromium', 'webkit'], widths = [1440, 390],
    scenarios = scoreFieldRefreshScenarios } = {}) {
    const sourceRoot = baseline ? resolve(baseline) : root;
    const source = await readFile(join(sourceRoot, modulePath), 'utf8');
    const css = (await readFile(join(sourceRoot, 'public/css/ui/components.css'), 'utf8'))
        .replace("@import url('./disclosure.css');", await readFile(join(sourceRoot, 'public/css/ui/disclosure.css'), 'utf8'));
    const modules = [];
    // Import the editor directly; its public entry no longer has account-write dependencies.
    const moduleURL = await bundleModule(resolve(sourceRoot, modulePath), sourceRoot, new Map(), modules);
    const results = [];
    if (output) await mkdir(resolve(output), { recursive: true });
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
    for (const engine of engines) {
        const browser = await ({ chromium, webkit })[engine].launch({ headless: true, env });
        try {
            for (const width of widths) {
                for (const scenario of scenarios) {
                    const context = await browser.newContext({ viewport: { width, height: 900 },
                        isMobile: width < 500, hasTouch: width < 500, offline: true, serviceWorkers: 'block' });
                    const errors = [], unexpectedRequests = [];
                    const page = await context.newPage();
                    page.setDefaultTimeout(4000);
                    page.on('pageerror', error => errors.push(error.message));
                    await context.route('**/*', async route => { unexpectedRequests.push(route.request().url()); await route.abort('blockedbyclient'); });
                    let result;
                    try {
                        await setup(page, moduleURL, css);
                        result = await exercise(page, scenario);
                        if (errors.length) result.failedChecks.push({ name: 'No script errors', actual: errors, expected: [] });
                        if (unexpectedRequests.length) result.failedChecks.push({ name: 'No network requests', actual: unexpectedRequests, expected: [] });
                        const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
                            overflowing: [...document.querySelectorAll('.bp-ui-select-trigger')].some(node => node.scrollWidth > node.clientWidth + 1) }));
                        if (layout.width > layout.viewport || layout.overflowing) result.failedChecks.push({ name: 'Controls fit the viewport', actual: layout });
                        if (output && ['fixed-fields-only', 'selected-option-removed'].includes(scenario)) {
                            await page.screenshot({ path: join(output, `${engine}-${width}-${scenario}.png`), fullPage: true });
                        }
                    } catch (error) {
                        result = { failedChecks: [{ name: 'Fixture execution', error: error.stack }],
                            observations: await page.evaluate(() => window.reviewState?.()).catch(() => null) };
                    } finally { await context.close(); }
                    const report = { engine, width, scenario, passed: result.failedChecks.length === 0, ...result, errors, unexpectedRequests, bundledModules: modules };
                    results.push(report);
                    console.log(`${report.passed ? 'PASS' : 'FAIL'} ${engine} ${width} ${scenario}: ${result.failedChecks.map(check => check.name).join('; ')}`);
                }
            }
        } finally { await browser.close(); }
    }
    const report = { generatedAt: new Date().toISOString(), baseline: baseline ?? null,
        node: process.version, sourceSHA256: createHash('sha256').update(source).digest('hex'),
        offline: true, realNetworkRequests: 0, appServerStarted: false,
        total: results.length, passed: results.filter(result => result.passed).length,
        failed: results.filter(result => !result.passed).length, results };
    if (output) await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
    const output = resolve(arg('output') ?? `artifacts/fixed-score-fields-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
    const report = await runScoreFieldRefreshReview({ baseline: arg('baseline'), output,
        engines: arg('engines')?.split(','), widths: arg('widths')?.split(',').map(Number), scenarios: arg('scenarios')?.split(',') });
    console.log(`${report.passed}/${report.total} passed; ${report.failed} failed; report: ${join(output, 'results.json')}`);
    if (report.failed) process.exitCode = 1;
}
