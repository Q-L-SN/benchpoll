import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { workspace, createFixtureState, weightedEntries } from './fixtures.mjs';
import { entryFromContext, contextKey } from '../../public/js/navigation/model.js';

const output = new URL('../../artifacts/navigation/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const categories = [
    { ID: 1, parentID: null, name: 'AI Evaluation' },
    { ID: 2, parentID: 1, name: 'Language models' },
    { ID: 3, parentID: 2, name: 'Coding' },
    { ID: 4, parentID: 3, name: 'Code generation' },
    { ID: 5, parentID: 2, name: 'Reasoning' },
    { ID: 6, parentID: 5, name: 'Mathematics' },
    { ID: 7, parentID: 1, name: 'Vision' },
    { ID: 8, parentID: 7, name: 'Image understanding' },
    { ID: 9, parentID: 1, name: 'Unconfigured' }
];
function lineage(ID) {
    const result = [];
    let category = categories.find(item => item.ID === Number(ID));
    while (category) { result.unshift({ ID: category.ID, name: category.name }); category = categories.find(item => item.ID === category.parentID); }
    return result;
}
function categoryPath(ID) { return lineage(ID).map(item => item.name.replace(/\s+/g, '-')).join('/'); }
function contextFor(ID, values = {}) {
    const isLeaf = !categories.some(item => item.parentID === Number(ID));
    const selected = values.budget ?? 'standard';
    if (isLeaf && !['standard', 'extended'].includes(selected)) throw new Error('Invalid test context');
    return {
        ID: Number(ID) * 10 + (selected === 'extended' ? 1 : 0), categoryID: Number(ID), categoryPath: categoryPath(ID),
        categoryName: categories.find(item => item.ID === Number(ID)).name, lineage: lineage(ID),
        contextValues: isLeaf ? { budget: selected } : {},
        dimensions: isLeaf ? [{ key: 'budget', name: 'Budget', selectedKey: selected,
            options: [{ key: 'standard', name: 'Standard', isDefault: true, isNeutral: true }, { key: 'extended', name: 'Extended' }] }] : []
    };
}
function treeFor(ID) {
    const expanded = new Set(lineage(ID).map(item => item.ID));
    const node = category => {
        const children = categories.filter(item => item.parentID === category.ID);
        return { ...category, hasChildren: children.length > 0, expanded: expanded.has(category.ID),
            ...(expanded.has(category.ID) && children.length ? { children: children.map(node) } : {}) };
    };
    return categories.filter(item => item.parentID === null).map(node);
}
const pie = (categoryID, values = {}, entries = [{ conditionID: 1, weightBasisPoints: 10000 }]) => ({
    context: contextFor(categoryID, values), revision: 1, entries: weightedEntries(entries), fallbackRules: []
});
function createState() {
    const initial = [pie(3), pie(4), pie(4, { budget: 'extended' }), pie(6), pie(8)];
    return { owner: '1', pies: new Map(initial.map(item => [contextKey(item.context.categoryID, item.context.contextValues), item])),
        requests: [], indexDelay: 0, indexFailure: null, saveDelay: 0, saveFailure: null, workspaceDelay: 0, unavailable: new Set() };
}
async function fixture(page, state) {
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const body = route.request().postDataJSON() ?? {};
        state.requests.push({ path, body });
        const send = (json, status = 200) => route.fulfill({ status, json, headers: { 'cache-control': 'no-store' } });
        if (path === '/api/get_user_profile') {
            if (!state.owner) return route.fulfill({ status: 204, body: '' });
            return send({ userID: state.owner, userName: `User ${state.owner}`, hasVerifiedEmail: true, role: 'reviewer' });
        }
        if (path.startsWith('/api/get_page')) {
            const categoryPathPart = decodeURIComponent(path.slice('/api/get_page'.length)).replace(/^\/rankings\//, '').replace(/^\/$/, '');
            const category = categoryPathPart ? categories.find(item => categoryPath(item.ID) === categoryPathPart) : categories[0];
            if (!category) return send({ error: 'category_not_found' }, 404);
            return send({ categoryTree: treeFor(category.ID), currentCategoryID: category.ID });
        }
        if (path === '/api/load_benchmarks_and_subcategories') {
            return send({ subcategories: categories.filter(item => item.parentID === body.targetCategory.ID)
                .map(item => ({ ...item, hasChildren: categories.some(child => child.parentID === item.ID) })) });
        }
        if (path === '/api/get_personal_navigation') {
            if (!state.owner) return send({ error: 'authentication_required' }, 401);
            const captured = { userID: state.owner, items: [...state.pies.values()].map(item => ({ ...entryFromContext(item.context),
                available: !state.unavailable.has(contextKey(item.context.categoryID, item.context.contextValues)) })) };
            await delay(state.indexDelay);
            if (state.indexFailure) return send({ error: 'index_failure' }, state.indexFailure);
            return send(captured);
        }
        if (path === '/api/get_weighted_workspace' || path === '/api/save_personal_pie') {
            const ID = body.categoryID ?? 1;
            const context = contextFor(ID, body.contextValues);
            const key = contextKey(ID, context.contextValues);
            if (path === '/api/save_personal_pie') {
                await delay(state.saveDelay);
                if (state.saveFailure) return send({ error: state.saveFailure === 409 ? 'pie_revision_conflict' : 'save_failed' }, state.saveFailure);
                const previous = state.pies.get(key);
                if (!state.owner) return send({ error: 'authentication_required' }, 401);
                if ((previous?.revision ?? 0) !== body.expectedRevision) return send({ error: 'pie_revision_conflict' }, 409);
                if (body.entries.length) state.pies.set(key, { context, revision: (previous?.revision ?? 0) + 1,
                    entries: weightedEntries(body.entries), fallbackRules: body.fallbackRules.map(rule => ({ ...rule, entries: weightedEntries(rule.entries) })) });
                else state.pies.delete(key);
            } else await delay(state.workspaceDelay);
            const stored = state.owner ? state.pies.get(key) : null;
            const payload = workspace(createFixtureState({ authenticated: Boolean(state.owner), userID: state.owner,
                personalEntries: stored?.entries ?? [], fallbackRules: stored?.fallbackRules ?? [] }), {});
            payload.context = context;
            payload.personalPie.revision = stored?.revision ?? 0;
            payload.personalPie.isDraft = !stored;
            return send(payload);
        }
        if (path === '/api/logout' || path === '/api/delete_account') { state.owner = null; return send({}); }
        return route.continue();
    });
}
async function until(condition, message) {
    for (let index = 0; index < 200; index++) { if (await condition()) return; await delay(25); }
    throw new Error(message);
}
const savedRows = page => page.locator('.bp-configured-row[data-configured="true"]');
const currentRow = page => page.locator('.bp-configured-row[aria-current="page"]');
const config = (page, ID, budget) => page.locator(`.bp-configured-row[data-location-category-id="${ID}"]`)
    .filter({ hasText: budget ? `Budget: ${budget}` : categories.find(item => item.ID === ID).name }).first();
async function ready(page, ID) {
    await page.waitForFunction(ID => document.getElementById('benchmark-card')?.getAttribute('aria-busy') === 'false'
        && document.querySelector(`#tree-content [data-category-id="${ID}"]`)?.getAttribute('aria-current') === 'page', ID);
}
async function mode(page, expected) {
    assert.equal(await page.locator(`#pie-mode-${expected}`).getAttribute('aria-selected'), 'true');
}
async function goConfigured(page) { await page.locator('[data-navigation-view="configured"]').click(); }
async function check(name, action, browserOptions = {}) {
    const app = await startPreview();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce', ...browserOptions });
    const page = await context.newPage();
    const state = createState(), errors = [];
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    try {
        await fixture(page, state);
        await page.goto(app.url);
        await ready(page, 1);
        await until(async () => await savedRows(page).count() === 5, 'Account index did not load');
        await action({ page, context, state, app });
        assert.deepEqual(errors, []);
        results.push({ name, passed: true });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, passed: false, error: error.message, pageErrors: errors });
        console.error(`FAIL ${name}: ${error.message}`);
        await page.screenshot({ path: new URL(name.replaceAll(/[^a-z0-9]+/gi, '-') + '-failure.png', output).pathname, fullPage: true }).catch(() => {});
    } finally { await context.close(); await app.close(); }
}
try {
    await check('both navigation views preserve pie mode and exact saved context', async ({ page, state }) => {
        const before = state.requests.filter(item => item.path === '/api/get_weighted_workspace').length;
        await goConfigured(page);
        assert.equal(state.requests.filter(item => item.path === '/api/get_weighted_workspace').length, before);
        await config(page, 4, 'Extended').click(); await ready(page, 4);
        await mode(page, 'public');
        assert.equal(await page.locator('.bp-template-value').textContent(), 'Extended');
        await page.locator('#public-fallback-toggle').click();
        await page.locator('#pie-mode-personal').click();
        assert.equal(await page.locator('[data-navigation-view="configured"]').getAttribute('aria-pressed'), 'true');
        await page.locator('[data-navigation-view="all"]').click();
        await mode(page, 'personal');
        await goConfigured(page);
        await config(page, 6, 'Standard').click(); await ready(page, 6); await mode(page, 'personal');
        await page.locator('#pie-mode-public').click();
        assert.equal(await page.locator('#public-fallback-toggle').getAttribute('aria-expanded'), 'true');
        await page.reload(); await ready(page, 6);
        await mode(page, 'public');
        assert.equal(await page.locator('[data-navigation-view="configured"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await currentRow(page).count(), 1);
        assert.equal(await currentRow(page).getAttribute('data-configured'), 'true');
    });
    await check('lazy tree marks only directly configured categories across all template contexts', async ({ page }) => {
        const expand = async ID => {
            await page.locator(`#tree-content [data-category-id="${ID}"] .icon-folder`).click();
            await page.waitForFunction(ID => document.querySelector(`#tree-content [data-category-id="${ID}"] .icon-folder`)?.getAttribute('aria-expanded') === 'true', ID);
        };
        assert.equal(await page.locator('#tree-content [data-category-id="1"] .bp-config-mark').count(), 0);
        assert.equal(await page.locator('#tree-content [data-category-id="2"] .bp-config-mark').count(), 0);
        await expand(2);
        assert.equal(await page.locator('#tree-content [data-category-id="3"] .bp-config-mark').count(), 1);
        await expand(3);
        assert.equal(await page.locator('#tree-content [data-category-id="4"] .bp-config-mark').count(), 1);
        await expand(5);
        assert.equal(await page.locator('#tree-content [data-category-id="5"] .bp-config-mark').count(), 0);
        assert.equal(await page.locator('#tree-content [data-category-id="6"] .bp-config-mark').count(), 1);
        await page.locator('#tree-content [data-category-id="4"]').click(); await ready(page, 4);
        await page.locator('.bp-template-control').click();
        await page.getByRole('option', { name: 'Extended', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.bp-template-value').textContent === 'Extended');
        assert.equal(await page.locator('#tree-content [data-category-id="4"] .bp-config-mark').count(), 1);
        await page.locator('#tree-content [data-category-id="3"] .icon-folder').click();
        await page.reload(); await ready(page, 4);
        assert.equal(await page.locator('#tree-content [data-category-id="3"] .icon-folder').getAttribute('aria-expanded'), 'false');
    });
    await check('expanded tree order has gaps only between saved roots and temporary ancestors never merge groups', async ({ page }) => {
        await goConfigured(page);
        assert.deepEqual(await savedRows(page).evaluateAll(rows => rows.map(row => Number(row.dataset.locationCategoryId))), [3, 4, 4, 6, 8]);
        assert.deepEqual(await page.locator('.bp-configured-row.is-group-start').evaluateAll(rows => rows.map(row => Number(row.dataset.locationCategoryId))), [6, 8]);
        assert.equal(await page.locator('#configured-content .icon-folder, #configured-content [aria-expanded]').count(), 0);
        await page.locator('[data-navigation-view="all"]').click();
        await page.locator('#tree-content [data-category-id="2"]').click(); await ready(page, 2);
        await goConfigured(page);
        assert.equal(await currentRow(page).getAttribute('data-configured'), 'false');
        assert.equal(await currentRow(page).getAttribute('data-location-category-id'), '2');
        assert.deepEqual(await page.locator('.bp-configured-row.is-group-start').evaluateAll(rows => rows.map(row => Number(row.dataset.locationCategoryId))), [6, 8]);
        assert.equal(await page.locator('.bp-configured-row[data-configured="false"]').count(), 1);
        assert.ok(!/Not configured|Saving|Currently browsing/.test(await page.locator('#configured-content').innerText()));
        assert.equal(await currentRow(page).locator('.bp-config-mark.is-configured').count(), 0);
        await page.screenshot({ path: new URL('sidebar-desktop.png', output).pathname, fullPage: true });
    });
    await check('successful first save and clear update the same row without changing views or inheriting fallback', async ({ page, state }) => {
        await goConfigured(page); await config(page, 3).click(); await ready(page, 3);
        await page.locator('#pie-mode-personal').click();
        await page.locator('[data-navigation-view="all"]').click();
        await page.locator('#tree-content [data-category-id="2"]').click(); await ready(page, 2);
        await goConfigured(page); await mode(page, 'personal');
        state.saveDelay = 250;
        await page.getByRole('button', { name: 'Add General knowledge to Personal Weights and focus it', exact: true }).click();
        assert.equal(await currentRow(page).getAttribute('data-configured'), 'false');
        await until(async () => await currentRow(page).getAttribute('data-configured') === 'true', 'First save did not mark location');
        assert.equal(await currentRow(page).count(), 1);
        assert.deepEqual(await page.locator('.bp-configured-row.is-group-start').evaluateAll(rows => rows.map(row => Number(row.dataset.locationCategoryId))), [8]);
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await until(async () => await currentRow(page).getAttribute('data-configured') === 'false', 'Clear did not unmark location');
        assert.deepEqual(await page.locator('.bp-configured-row.is-group-start').evaluateAll(rows => rows.map(row => Number(row.dataset.locationCategoryId))), [6, 8]);
        await mode(page, 'personal');
        assert.equal(await page.locator('[data-navigation-view="configured"]').getAttribute('aria-pressed'), 'true');
    });
    await check('queued saves finish in the original context before configured navigation and failed saves do not create markers', async ({ page, state }) => {
        await goConfigured(page); await config(page, 3).click(); await ready(page, 3);
        await page.locator('#pie-mode-personal').click();
        state.saveDelay = 250;
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await config(page, 4, 'Extended').click(); await ready(page, 4);
        const save = state.requests.findIndex(item => item.path === '/api/save_personal_pie');
        const next = state.requests.findIndex(item => item.path === '/api/get_weighted_workspace' && item.body.categoryID === 4);
        assert.ok(save >= 0 && save < next);
        assert.equal(state.requests[save].body.categoryID, 3);
        assert.equal(state.requests[next].body.contextValues.budget, 'extended');
        await page.locator('[data-navigation-view="all"]').click();
        await page.locator('#tree-content [data-category-id="2"]').click(); await ready(page, 2);
        await goConfigured(page);
        state.saveFailure = 500;
        await page.getByRole('button', { name: 'Add General knowledge to Personal Weights and focus it', exact: true }).click();
        await page.getByText('Your change was not saved', { exact: true }).waitFor();
        assert.equal(await currentRow(page).getAttribute('data-configured'), 'false');
    });
    await check('search keeps context identity, unavailable entries cannot navigate, and index failures are not empty states', async ({ page, state }) => {
        await goConfigured(page);
        await page.locator('#configured-search').fill('Coding extended');
        assert.equal(await page.locator('.bp-configured-row').count(), 1);
        assert.equal(await page.locator('.bp-configured-context').textContent(), 'Budget: Extended');
        await page.locator('#configured-search').fill('');
        state.unavailable.add(contextKey(8, { budget: 'standard' }));
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await until(async () => await config(page, 8).getAttribute('aria-disabled') === 'true', 'Retired configuration was not marked unavailable');
        const before = page.url();
        await config(page, 8).click(); assert.equal(page.url(), before);
        state.indexFailure = 503;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.locator('#navigation-retry').waitFor();
        assert.equal(await page.locator('#configured-empty').isVisible(), false);
        assert.ok(await savedRows(page).count() > 0);
        state.indexFailure = null;
        await page.locator('#navigation-retry').click();
        await page.locator('#navigation-retry').waitFor({ state: 'hidden' });
    });
    await check('logout clears account index immediately and delayed old responses cannot restore it', async ({ page, state }) => {
        await goConfigured(page);
        state.indexDelay = 500;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await delay(80);
        await page.locator('#user-profile').click(); await page.locator('#logout-button').click();
        await page.locator('.dialog-logout-this-device-button').click();
        await page.locator('#logout-success-dialog').waitFor();
        assert.equal(await savedRows(page).count(), 0);
        await delay(600);
        assert.equal(await savedRows(page).count(), 0);
        assert.equal(await page.locator('#tree-content .bp-config-mark').count(), 0);
        assert.equal(await page.locator('.bp-configured-row[data-configured="false"]').count(), 1);
    });
    await check('account switching replaces the index and rejects delayed data from the previous account', async ({ page, state }) => {
        await goConfigured(page);
        const previousDocument = await page.evaluate(() => performance.timeOrigin);
        state.indexDelay = 450;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await delay(80);
        state.owner = '2';
        const only = pie(9);
        state.pies = new Map([[contextKey(9, only.context.contextValues), only]]);
        state.indexDelay = 0;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await until(async () => await savedRows(page).count() === 1 && await config(page, 9).count() === 1, 'New account index did not replace old data');
        await delay(500);
        assert.deepEqual(await savedRows(page).evaluateAll(rows => rows.map(row => Number(row.dataset.locationCategoryId))), [9]);
        assert.equal(await page.locator('#tree-content [data-configured="true"]').count(), 1);
        assert.notEqual(await page.evaluate(() => performance.timeOrigin), previousDocument, 'The old account workspace must not remain editable');
    });
    await check('configured scroll and keyboard focus survive view switches reload and index refresh', async ({ page, state }) => {
        const added = Array.from({ length: 45 }, (_, index) => ({ ID: 100 + index, parentID: 1, name: `Extra ${index}` }));
        categories.push(...added);
        try {
            for (const category of added) {
                const item = pie(category.ID);
                state.pies.set(contextKey(category.ID, item.context.contextValues), item);
            }
            await goConfigured(page);
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await until(async () => await savedRows(page).count() === 50, 'Long index did not load');
            const viewport = page.locator('.bp-taxonomy');
            await viewport.evaluate(element => { element.scrollTop = 600; });
            await delay(100);
            await page.locator('[data-navigation-view="all"]').click();
            await goConfigured(page);
            assert.ok(Math.abs(await viewport.evaluate(element => element.scrollTop) - 600) < 2);
            await page.reload(); await ready(page, 1);
            await until(async () => await savedRows(page).count() === 50, 'Reloaded index did not load');
            assert.ok(Math.abs(await viewport.evaluate(element => element.scrollTop) - 600) < 2, 'Reload lost configured scroll position');
            const target = config(page, 110);
            await target.focus();
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await delay(200);
            assert.equal(await target.evaluate(element => element === document.activeElement), true, 'Index refresh lost keyboard focus');
        } finally { categories.splice(categories.length - added.length, added.length); }
    });
    await check('back and forward restore exact locations without resetting either selected mode', async ({ page }) => {
        await goConfigured(page); await config(page, 4, 'Extended').click(); await ready(page, 4);
        await page.locator('#pie-mode-personal').click();
        await config(page, 6, 'Standard').click(); await ready(page, 6);
        await page.goBack(); await ready(page, 4);
        assert.equal(await page.locator('.bp-template-value').textContent(), 'Extended');
        await mode(page, 'personal');
        await page.goForward(); await ready(page, 6); await mode(page, 'personal');
        assert.equal(await page.locator('[data-navigation-view="configured"]').getAttribute('aria-pressed'), 'true');
    });
    for (const width of [390, 320]) {
        await check(`mobile navigation ${width} keeps every saved context visible without overflow`, async ({ page }) => {
            await page.locator('#taxonomy-toggle').click(); await goConfigured(page);
            assert.equal(await savedRows(page).count(), 5);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            const sidebar = page.locator('.bp-sidebar');
            assert.equal(await sidebar.evaluate(element => element.scrollWidth <= element.clientWidth), true);
            await page.screenshot({ path: new URL(`sidebar-mobile-${width}.png`, output).pathname, fullPage: true });
            await config(page, 4, 'Extended').click(); await ready(page, 4);
            assert.equal(await page.locator('#taxonomy-toggle').getAttribute('aria-expanded'), 'false');
            assert.equal(await page.locator('.bp-template-value').textContent(), 'Extended');
            await mode(page, 'public');
            await page.locator('#taxonomy-toggle').click();
            assert.equal(await page.locator('[data-navigation-view="configured"]').getAttribute('aria-pressed'), 'true');
        }, { viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    }
} finally {
    await browser.close();
    await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2) + '\n');
}
console.log(`${results.filter(item => item.passed).length}/${results.length} navigation checks passed`);
if (results.some(item => !item.passed)) process.exitCode = 1;
