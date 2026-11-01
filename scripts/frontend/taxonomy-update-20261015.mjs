import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, request } from 'playwright';

const origin = 'https://benchpoll.com';
const specification = JSON.parse(await readFile(new URL('../../ops/task-taxonomy-20261015.json', import.meta.url), 'utf8'));
const allocatedIDs = { work: 231, training: 232, driving: 233, forecast: 234, investing: 236, culture: 237, support: 238 };
const byKey = new Map(specification.categories.map(node => [node.key, node]));
const identity = node => node.existingID ?? allocatedIDs[node.key];
const lineage = node => node.parent === null ? [node] : [...lineage(byKey.get(node.parent)), node];
const expected = specification.categories.map(node => ({
    categoryID: identity(node), categoryName: node.name,
    lineage: lineage(node).map(parent => ({ ID: identity(parent), name: parent.name, position: parent.position })),
    path: '/' + lineage(node).map(parent => encodeURIComponent(parent.name.replace(/\s+/g, '-'))).join('/')
}));
const retiredIDs = new Set(specification.retiredCategories.map(node => node.ID));
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = join('D:/Codex-artifacts/website1/taxonomy-20261015', `public-verification-${timestamp}`);
const report = { origin, startedAt: new Date().toISOString(), output, specificationVersion: specification.version,
    specificationSHA256: createHash('sha256').update(JSON.stringify(specification)).digest('hex'),
    scope: 'Anonymous public APIs and browser only; no database access, credentials, deployment, or application writes.',
    coverage: { publicAPI: !process.argv.includes('--browser-only'), widthSelection: process.argv.find(arg => arg.startsWith('--width=')) ?? 'all' },
    checks: [], retries: [], api: [], viewports: [], failures: [] };
await mkdir(output, { recursive: true });
const saveJSON = (name, data) => writeFile(join(output, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
const readOnlyAPI = path => /^\/api\/get_page(?:\/|$)/.test(path) || new Set([
    '/api/get_category_navigation', '/api/load_benchmarks_and_subcategories', '/api/get_user_profile',
    '/api/get_weighted_workspace', '/api/get_ranking_page', '/api/get_comparison_profiles',
    '/api/get_discussion_summary', '/api/get_personal_navigation'
]).has(path);
const check = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const apiProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin }, timeout: 30000,
    ...(apiProxy ? { proxy: { server: apiProxy } } : {}) });

async function readAPI(path, data = {}) {
    assert.ok(readOnlyAPI(path), `Not an allowed read API: ${path}`);
    if (path.startsWith('/api/get_page') || path === '/api/load_benchmarks_and_subcategories') assert.equal(data.treeOnly, true);
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await api.post(path, { data, maxRetries: 2 });
            const text = await response.text();
            let body;
            try { body = JSON.parse(text); } catch { body = text; }
            const result = { path, data, status: response.status(), cacheControl: response.headers()['cache-control'], body };
            report.api.push(result);
            await saveJSON('api-progress.json', { responses: report.api, retries: report.retries });
            if ([502, 503, 504].includes(response.status()) && attempt < 3) {
                report.retries.push({ path, attempt, status: response.status() });
                continue;
            }
            return result;
        } catch (error) {
            report.retries.push({ path, attempt, error: error.message });
            console.warn(`RETRY ${path}, attempt ${attempt}: ${error.message.split('\n')[0]}`);
            if (attempt === 3) throw error;
        }
    }
}

async function verifyAPI() {
    assert.equal(expected.length, 54);
    assert.ok(expected.every(node => Number.isSafeInteger(node.categoryID)));
    const navigation = await readAPI('/api/get_category_navigation');
    assert.equal(navigation.status, 200);
    await saveJSON('public-navigation.json', navigation);
    const normalized = navigation.body.items.map(item => ({ categoryID: item.categoryID, categoryName: item.categoryName,
        lineage: item.lineage, path: '/' + item.lineage.map(node => encodeURIComponent(node.name.replace(/\s+/g, '-'))).join('/') }));
    assert.deepEqual(normalized, expected, 'Complete ordered public navigation must match the dated specification');
    assert.ok(navigation.body.items.every(item => item.available && !item.isPrivate && !retiredIDs.has(item.categoryID)
        && Object.keys(item.contextValues).length === 0));
    check('All 54 public categories match exact IDs, English names, ancestry and sibling positions');
    for (const item of expected) {
        console.log(`CHECK public page ${item.categoryID}: ${item.path}`);
        const result = await readAPI(`/api/get_page${item.path}`, { treeOnly: true });
        assert.equal(result.status, 200, item.path);
        assert.equal(result.body.currentCategoryID, item.categoryID, item.path);
        let nodes = result.body.categoryTree;
        for (const parent of item.lineage) {
            const actual = nodes.find(node => node.ID === parent.ID);
            assert.ok(actual, `Missing ${parent.ID} on ${item.path}`);
            assert.equal(actual.name, parent.name);
            assert.equal(actual.position, parent.position);
            nodes = actual.children ?? [];
        }
    }
    check('All 54 English paths resolve to their original category IDs through the public page API');
    const forecast = await readAPI('/api/load_benchmarks_and_subcategories', {
        targetCategory: { ID: 234 }, doNotGetChildren: false, treeOnly: true
    });
    assert.equal(forecast.status, 200);
    assert.deepEqual(forecast.body.subcategories.map(node => [node.ID, node.parentID, node.name, node.position]),
        [[236, 234, 'Live Investing', 10]]);
    check('Forecast & Decide 234 has only Live Investing 236 at position 10');
    for (const path of ['/Intelligence/Business', '/Intelligence/Long-Context', '/Intelligence/Forecast-%26-Decide/Real-World']) {
        const result = await readAPI(`/api/get_page${path}`, { treeOnly: true });
        assert.equal(result.status, 404, `Legacy or retired path must not resolve: ${path}`);
        const html = await api.get(path, { maxRedirects: 0 });
        const location = html.headers().location;
        report.api.push({ path, method: 'GET', status: html.status(), location });
        // Page errors use the existing shared dialog; this is not a category alias.
        assert.equal(html.status(), 302, `Legacy or retired HTML route must use the shared error page: ${path}`);
        const errorPage = new URL(location, origin);
        assert.equal(errorPage.pathname, '/dialogPage');
        assert.equal(errorPage.searchParams.get('errorCode'), '404');
    }
    const retired = await readAPI('/api/load_benchmarks_and_subcategories', { targetCategory: { ID: 235 }, treeOnly: true });
    assert.equal(retired.status, 404);
    check('Real World 235 is absent and unavailable; old URLs return API 404 and the existing shared 404 page, not category redirects');
    const root = await api.get('/', { maxRedirects: 0 });
    report.root = { status: root.status(), location: root.headers().location };
    assert.equal(root.status(), 302);
    assert.equal(new URL(root.headers().location, origin).pathname, '/Intelligence');
    check('Public root still redirects to Intelligence');
}

async function waitReady(page, categoryID) {
    await page.waitForFunction(ID => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && document.querySelector(`#tree-content [data-category-id="${ID}"]`)?.getAttribute('aria-current') === 'page', categoryID,
    { timeout: 90000 });
    await page.evaluate(() => document.fonts.ready);
}

async function closeOverview(page) {
    if (await page.locator('body').evaluate(node => node.classList.contains('is-showcase'))) {
        await page.locator('#showcase-enter').click();
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
    }
    const welcome = page.locator('#welcome-close');
    if (await welcome.isVisible()) await welcome.click();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

async function openSidebar(page, width) {
    if (width < 760 && !await page.locator('body').evaluate(node => node.classList.contains('taxonomy-open'))) {
        await page.locator('#taxonomy-toggle').click();
        await page.waitForFunction(() => document.body.classList.contains('taxonomy-open'));
    }
    await page.locator('#tree-content').waitFor({ state: 'visible' });
}

async function bounds(page) {
    return page.evaluate(() => {
        const sidebar = document.querySelector('.bp-sidebar');
        const viewport = document.querySelector('.bp-taxonomy');
        const tree = document.getElementById('tree-content');
        const rect = element => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
        };
        const panel = rect(sidebar);
        const rows = [...tree.querySelectorAll('[data-category-id]')].filter(row => row.getClientRects().length).map(row => {
            const box = rect(row);
            const label = [...row.children].find(child => child.tagName === 'SPAN'
                && !child.classList.contains('icon-folder') && !child.classList.contains('bp-config-mark'));
            const labelBox = rect(label);
            const range = document.createRange(); range.selectNodeContents(label);
            const textOutside = [...range.getClientRects()].some(part => part.left < labelBox.x - 1 || part.right > labelBox.right + 1);
            return { ID: Number(row.dataset.categoryId), name: label.textContent, ...box,
                outsidePanel: box.x < panel.x - 1 || box.right > panel.right + 1,
                labelClientWidth: label.clientWidth, labelScrollWidth: label.scrollWidth, textOutside };
        });
        const overlaps = rows.slice(1).filter((row, index) => row.y < rows[index].bottom - 1).map(row => row.ID);
        return { innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
            panel, viewport: viewport && { ...rect(viewport), clientWidth: viewport.clientWidth, scrollWidth: viewport.scrollWidth },
            tree: { ...rect(tree), clientWidth: tree.clientWidth, scrollWidth: tree.scrollWidth }, rows, overlaps };
    });
}

function verifyBounds(result, width, complete = false) {
    assert.equal(result.innerWidth, width);
    assert.ok(result.documentWidth <= width + 1, `Document overflow: ${result.documentWidth}/${width}`);
    assert.ok(result.bodyWidth <= width + 1, `Body overflow: ${result.bodyWidth}/${width}`);
    assert.ok(result.panel.x >= -1 && result.panel.right <= width + 1, 'Sidebar must fit the viewport');
    assert.ok(result.tree.scrollWidth <= result.tree.clientWidth + 1, 'Tree must not overflow horizontally');
    if (result.viewport) assert.ok(result.viewport.scrollWidth <= result.viewport.clientWidth + 1, 'Sidebar scroll viewport overflow');
    assert.deepEqual(result.rows.filter(row => row.outsidePanel || row.textOutside || row.labelScrollWidth > row.labelClientWidth + 1), []);
    assert.deepEqual(result.overlaps, []);
    if (complete) assert.equal(result.rows.length, 54, 'All expanded rows must be measurable');
}

async function verifyBrowser(browser, width, height) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', reducedMotion: 'reduce',
        hasTouch: width < 760, isMobile: width < 760, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);
    const result = { width, height, checks: [], pageErrors: [], consoleErrors: [], blockedMutationRequests: [],
        blockedAuxiliaryRequests: [], networkFailures: [], responses: [], captures: [], routes: [] };
    const pending = new Set();
    page.on('pageerror', error => result.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
    page.on('requestfailed', req => result.networkFailures.push({ url: req.url(), method: req.method(), error: req.failure()?.errorText }));
    page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (!path.startsWith('/api/')) return;
        const entry = { path, status: response.status(), request: response.request().postDataJSON() };
        result.responses.push(entry);
        if (path === '/api/get_weighted_workspace' || path.startsWith('/api/get_page')) {
            const task = response.json().then(body => {
                entry.body = path === '/api/get_weighted_workspace' ? { context: body.context,
                    authenticated: body.authenticated, error: body.error } : body;
            }).catch(error => { entry.bodyError = error.message; });
            pending.add(task); task.finally(() => pending.delete(task));
        }
    });
    await context.route('**/*', route => {
        const req = route.request();
        const url = new URL(req.url());
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.continue();
        if (url.origin === origin && req.method() === 'POST' && readOnlyAPI(url.pathname)) {
            const data = req.postDataJSON();
            if ((url.pathname.startsWith('/api/get_page') || url.pathname === '/api/load_benchmarks_and_subcategories')
                && data?.treeOnly !== true) {
                result.blockedMutationRequests.push({ path: url.pathname, reason: 'Tree-only required' });
                return route.abort('blockedbyclient');
            }
            return route.continue();
        }
        const entry = { url: req.url(), method: req.method() };
        if (url.origin === origin && url.pathname.startsWith('/api/')) result.blockedMutationRequests.push(entry);
        else result.blockedAuxiliaryRequests.push(entry);
        return route.abort('blockedbyclient');
    });
    const screenshot = async name => {
        const filename = `${width}-${name}.png`;
        await page.screenshot({ path: join(output, filename), fullPage: false });
        result.captures.push(filename);
    };
    try {
        const response = await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        assert.equal(response.status(), 200);
        await waitReady(page, 54);
        assert.equal(new URL(page.url()).pathname, '/Intelligence');
        await screenshot('default-intelligence');
        await closeOverview(page);
        await openSidebar(page, width);
        for (const item of expected.filter(node => expected.some(child => child.lineage.at(-2)?.ID === node.categoryID))) {
            const row = page.locator(`#tree-content [data-category-id="${item.categoryID}"]`);
            const toggle = row.locator('.icon-folder');
            if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
            const children = expected.filter(child => child.lineage.at(-2)?.ID === item.categoryID);
            for (const child of children) await page.locator(`#tree-content [data-category-id="${child.categoryID}"]`).waitFor({ state: 'attached' });
        }
        const actualTree = await page.locator('#tree-content [data-category-id]').evaluateAll(rows => rows.map(row => {
            const IDs = [Number(row.dataset.categoryId)];
            let parent = row.closest('.tree-children');
            while (parent) {
                const ancestor = parent.parentElement.querySelector(':scope > .tree-root-item');
                IDs.unshift(Number(ancestor.dataset.categoryId));
                parent = ancestor.closest('.tree-children');
            }
            const label = [...row.children].find(child => child.tagName === 'SPAN'
                && !child.classList.contains('icon-folder') && !child.classList.contains('bp-config-mark'));
            return { categoryID: Number(row.dataset.categoryId), categoryName: label.textContent,
                path: '/' + row.dataset.path, lineageIDs: IDs };
        }));
        assert.deepEqual(actualTree, expected.map(node => ({ categoryID: node.categoryID, categoryName: node.categoryName,
            path: node.path, lineageIDs: node.lineage.map(parent => parent.ID) })));
        assert.equal(actualTree.some(node => retiredIDs.has(node.categoryID) || ['Business', 'Long Context', 'Real World'].includes(node.categoryName)), false);
        result.expandedTree = actualTree;
        result.expandedBounds = await bounds(page);
        verifyBounds(result.expandedBounds, width, true);
        await page.locator('.bp-taxonomy').evaluate(node => { node.scrollTop = 0; });
        await screenshot('tree-top');
        await page.locator('.bp-taxonomy').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await screenshot('tree-bottom');
        result.checks.push('All 54 ordered DOM rows match the specification, including actual DOM ancestry; no retired or old names');
        result.checks.push('Complete sidebar, labels and document fit without horizontal overflow or row overlaps');
        check(`Full public sidebar and bounds at ${width}px`);

        for (const categoryID of [202, 215, 236]) {
            const item = expected.find(node => node.categoryID === categoryID);
            await openSidebar(page, width);
            await page.locator(`#tree-content [data-category-id="${categoryID}"]`).click();
            await waitReady(page, categoryID);
            assert.equal(new URL(page.url()).pathname, item.path);
            assert.match(await page.locator('#bp-breadcrumb').innerText(), new RegExp(item.categoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            const reload = await page.reload({ waitUntil: 'domcontentloaded' });
            assert.equal(reload.status(), 200);
            await waitReady(page, categoryID);
            await closeOverview(page);
            assert.equal(new URL(page.url()).pathname, item.path);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await screenshot(`route-${categoryID}`);
            await openSidebar(page, width);
            await page.locator(`#tree-content [data-category-id="${categoryID}"]`).scrollIntoViewIfNeeded();
            await screenshot(`sidebar-${categoryID}`);
            const geometry = await bounds(page);
            verifyBounds(geometry, width);
            result.routes.push({ categoryID, name: item.categoryName, path: item.path, reloadStatus: reload.status(),
                breadcrumb: await page.locator('#bp-breadcrumb').innerText(), bounds: geometry });
            check(`Sidebar navigation and direct reload: ${item.path} at ${width}px`);
        }
        await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
        await waitReady(page, 54);
        assert.equal(new URL(page.url()).pathname, '/Intelligence');
        await Promise.all([...pending]);
        const workspaces = result.responses.filter(entry => entry.path === '/api/get_weighted_workspace' && entry.status === 200);
        for (const ID of [54, 202, 215, 236]) assert.ok(workspaces.some(entry => entry.body?.context?.categoryID === ID), `Missing actual workspace response for ${ID}`);
        assert.deepEqual(result.pageErrors, []);
        assert.deepEqual(result.blockedMutationRequests, []);
        assert.deepEqual(result.responses.filter(entry => entry.status >= 400), []);
        result.unexpectedNetworkFailures = result.networkFailures.filter(entry =>
            !result.blockedAuxiliaryRequests.some(blocked => blocked.url === entry.url)
            && !(new URL(entry.url).pathname === '/api/get_user_profile' && entry.error === 'net::ERR_ABORTED'));
        assert.deepEqual(result.unexpectedNetworkFailures, []);
        result.checks.push('New English routes work by sidebar navigation and direct reload, with successful category-specific workspace responses');
        result.checks.push('Returning to / after navigation still selects Intelligence 54');
        result.passed = true;
        check(`Default remains Intelligence 54 before and after navigation at ${width}px`);
    } catch (error) {
        result.passed = false;
        result.error = error.stack;
        report.failures.push({ stage: `browser-${width}`, error: error.message });
        await screenshot('failure').catch(() => {});
        console.error(`FAIL ${width}px: ${error.message}`);
    } finally {
        await Promise.all([...pending]);
        await saveJSON(`browser-${width}.json`, result);
        report.viewports.push(result);
        await context.close();
    }
}

console.log(`Evidence: ${output}`);
try {
    try { if (!process.argv.includes('--browser-only')) await verifyAPI(); }
    catch (error) { report.failures.push({ stage: 'public-api', error: error.stack }); console.error(`FAIL API: ${error.message}`); }
    const browser = await chromium.launch({ headless: true });
    try {
        report.browserVersion = browser.version();
        for (const [width, height] of [[1440, 1000], [390, 844], [320, 800]]) {
            const selection = process.argv.find(arg => arg.startsWith('--width='));
            if (!selection || Number(selection.split('=')[1]) === width) await verifyBrowser(browser, width, height);
        }
    } finally { await browser.close(); }
} catch (error) {
    report.failures.push({ stage: 'runner', error: error.stack });
    console.error(error.message);
} finally {
    await api.dispose();
    report.finishedAt = new Date().toISOString();
    report.passed = report.failures.length === 0;
    await saveJSON('report.json', report);
    console.log(`${report.passed ? 'PASS' : 'FAIL'} verification; report: ${join(output, 'report.json')}`);
    if (!report.passed) process.exitCode = 1;
}
