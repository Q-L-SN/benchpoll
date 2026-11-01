import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = new URL('../../artifacts/taxonomy-private-pies-20261002/', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('browser-fixture.json', output), 'utf8'));
const origin = 'https://benchpoll.com';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { privateCategoryIDs: [], checks: [] };
const post = (context, path, data = {}) => context.request.post(`${origin}/api/${path}`, { data, headers: { Origin: origin } });
const ready = page => page.locator('#benchmark-card[aria-busy="false"]').waitFor({ timeout: 90000 });
try {
    const guest = await browser.newContext();
    const other = await browser.newContext();
    await other.addCookies(fixture.accounts[1].cookies);
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 },
            hasTouch: width === 390, isMobile: width === 390 });
        await context.addCookies(fixture.accounts[0].cookies);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(20000);
        try {
            const navigation = await (await post(context, 'get_personal_navigation')).json();
            const preserved = navigation.items.find(item => item.categoryName === 'Retired browser test category');
            assert.ok(preserved?.isPrivate && preserved.available);
            await page.goto(`${origin}/Intelligence/Business`);
            await ready(page);
            assert.match(await page.locator('#bp-breadcrumb').innerText(), /Intelligence/);
            if (width === 390) await page.locator('#taxonomy-toggle').click();
            await page.locator('[data-navigation-view="configured"]').click();
            await page.locator('#private-category-create-toggle').click();
            await page.locator('#private-category-name').fill(`Browser private ${width}`);
            const created = page.waitForResponse(response => response.url().endsWith('/api/create_private_category'));
            await page.locator('#private-category-create-form [type="submit"]').click();
            const response = await created;
            assert.equal(response.status(), 201);
            const entry = await response.json();
            report.privateCategoryIDs.push(entry.categoryID);
            await page.waitForURL(`${origin}/personal/${entry.categoryID}`);
            await ready(page);
            assert.equal(await page.locator('.bp-mode-switch').isVisible(), false);
            assert.equal(await page.locator('#discussion-entry').isVisible(), false);
            assert.equal(await page.locator('.bp-benchmark-public-order').isVisible(), false);
            const foreign = await post(other, 'get_private_category', { categoryID: entry.categoryID });
            assert.equal(foreign.status(), 404);
            const anonymous = await post(guest, 'get_private_category', { categoryID: entry.categoryID });
            assert.equal(anonymous.status(), 401);
            for (const requester of [guest, other]) assert.equal((await post(requester, 'get_weighted_workspace', {
                categoryID: entry.categoryID, contextValues: {} })).status(), 404);
            assert.equal((await post(context, 'get_discussion', { categoryID: entry.categoryID, contextValues: {} })).status(), 404);
            assert.equal((await post(context, 'create_private_category', { name: 'Invalid owner', owner_user_ID: fixture.accounts[1].userID })).status(), 400);
            const workspace = await (await post(context, 'get_weighted_workspace', { categoryID: entry.categoryID, contextValues: {} })).json();
            assert.equal(workspace.context.isPrivate, true);
            assert.deepEqual(workspace.publicPie.entries, []);
            assert.equal(workspace.publicPie.participantCount, 0);
            for (const requester of [guest, other]) assert.equal((await post(requester, 'get_ranking_page', {
                snapshotID: workspace.rankingPagination.snapshotID, list: 'benchmarks', group: 'primary', offset: 0 })).status(), 403);
            const first = page.locator('.bp-benchmark-row').first();
            const saved = page.waitForResponse(res => res.url().endsWith('/api/save_personal_pie') && res.request().method() === 'POST');
            await first.click();
            const savedResponse = await saved;
            assert.equal(savedResponse.status(), 200);
            const savedWorkspace = await savedResponse.json();
            assert.equal(savedWorkspace.context.isPrivate, true);
            assert.equal(savedWorkspace.personalPie.entries.length, 1);
            assert.deepEqual(savedWorkspace.publicPie.entries, []);
            assert.deepEqual(savedWorkspace.modelLeaderboards.public, []);
            assert.ok(savedWorkspace.modelLeaderboards.personal.length > 0);
            await page.locator('.bp-personal-weight-remove').waitFor();
            const cleared = page.waitForResponse(res => res.url().endsWith('/api/save_personal_pie') && res.request().method() === 'POST');
            await page.locator('.bp-personal-weight-remove').click();
            assert.equal((await cleared).status(), 200);
            await page.reload();
            await ready(page);
            const after = await (await post(context, 'get_personal_navigation')).json();
            assert.ok(after.items.some(item => item.categoryID === entry.categoryID && item.isPrivate && item.available));
            assert.equal(await page.locator('.bp-mode-switch').isVisible(), false);
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: new URL(`private-${width}.png`, output).pathname.replace(/^\/(?=[A-Z]:)/, ''), fullPage: true });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            assert.deepEqual(errors, []);
            report.checks.push(`Private create/add/remove/reload, ownership and pagination isolation at ${width}px`);
            console.log(`PASS private categories and isolation at ${width}px`);
        } catch (error) {
            await page.screenshot({ path: new URL(`live-failed-${width}.png`, output).pathname.replace(/^\/(?=[A-Z]:)/, '') });
            console.log(JSON.stringify({ width, url: page.url(), errors }));
            throw error;
        } finally { await context.close(); }
    }
    const publicNavigation = await (await post(guest, 'get_category_navigation')).json();
    assert.equal(publicNavigation.items.length, 55);
    assert.equal(publicNavigation.items.some(item => report.privateCategoryIDs.includes(item.categoryID)), false);
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(`${origin}/AGI`);
            await ready(page);
            assert.equal(await page.locator('#agi-promo').isVisible(), true);
            assert.match(await page.locator('#agi-promo').innerText(), /80%/);
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: new URL(`agi-${width}.png`, output).pathname.replace(/^\/(?=[A-Z]:)/, ''), fullPage: true });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            if (width === 390) await page.locator('#taxonomy-toggle').click();
            await page.locator('[data-navigation-view="configured"]').click();
            assert.equal(await page.locator('#configured-browse').isVisible(), false);
            assert.equal(await page.locator('#private-category-create-toggle').isVisible(), false);
            assert.deepEqual(errors, []);
            report.checks.push(`AGI milestone and guest Configured controls at ${width}px`);
        } finally { await context.close(); }
    }
    const locked = await post(guest, 'get_weighted_workspace', { categoryID: publicNavigation.items.find(item => item.lineage.map(c => c.name).join('/') === 'Creation/Media/Image').categoryID,
        contextValues: { realtime: 'any', output: 'vector', reference_image: 'any' } });
    assert.equal(locked.status(), 400);
    assert.equal((await locked.json()).error, 'context_dimension_locked');
    report.checks.push('55 public categories, private visibility exclusions, server rejects Any bypass');
    await writeFile(new URL('live-verification.json', output), JSON.stringify(report, null, 2));
    await guest.close(); await other.close();
    console.log('PASS public AGI/Configured mobile+desktop, full Intelligence prefix, public/private separation and Any bypass rejection');
} finally { await browser.close(); }
