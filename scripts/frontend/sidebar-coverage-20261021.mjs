import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../../privacy-headers.js';

const live = process.argv.includes('--live');
const smoke = process.argv.includes('--smoke');
const builtRoot = process.env.BUILT_APP_ROOT;
const output = resolve(process.env.FRONTEND_OUTPUT ?? 'D:/Codex-artifacts/website1/sidebar-coverage-20261021/source');
await mkdir(output, { recursive: true });
const results = [];
const cases = [
    ['chromium', chromium, 1440], ['chromium', chromium, 761], ['chromium', chromium, 760],
    ['chromium', chromium, 390], ['chromium', chromium, 320],
    ['webkit', webkit, 1440], ['webkit', webkit, 390], ['webkit', webkit, 320]
];

async function ready(page, charts = false) {
    await page.locator(charts ? '.bp-model-column' : '.bp-model-row').first().waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#model-card')?.getAttribute('aria-busy') === 'false');
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function assertGuideGroup(page, mobile) {
    const group = page.locator('.bp-sidebar-brand-links');
    await group.waitFor();
    assert.deepEqual(await group.locator('a').evaluateAll(nodes => nodes.map(node => node.id)),
        ['how-it-works-link', 'beta-feedback-link']);
    const brand = await page.locator('.bp-sidebar > .bp-brand').boundingBox();
    let previousBottom = brand.y + brand.height;
    const styles = [];
    for (const id of ['how-it-works-link', 'beta-feedback-link']) {
        const link = page.locator('#' + id);
        const data = await link.evaluate(node => {
            const style = getComputedStyle(node);
            const text = node.querySelector('span').getBoundingClientRect();
            const icon = node.querySelector('i').getBoundingClientRect();
            return { box: node.getBoundingClientRect().toJSON(), gap: icon.left - text.right,
                style: { background: style.backgroundColor, border: style.borderTopWidth,
                    shadow: style.boxShadow, decoration: style.textDecorationLine, font: style.fontSize },
                colors: [style.color, getComputedStyle(node.querySelector('span')).color, getComputedStyle(node.querySelector('i')).color] };
        });
        assert.ok(data.box.y >= previousBottom - 1);
        assert.ok(Math.abs(data.box.x - brand.x) <= 1);
        assert.ok(data.gap >= 5 && data.gap <= 12, 'The trailing icon has a consistent visible gap');
        assert.ok(data.box.height >= (mobile ? 44 : 30));
        assert.equal(data.style.background, 'rgba(0, 0, 0, 0)');
        assert.equal(data.style.border, '0px');
        assert.equal(data.style.shadow, 'none');
        assert.equal(data.style.decoration, 'none');
        assert.ok(data.colors.every(color => color === data.colors[0]));
        styles.push(data.style);
        previousBottom = data.box.y + data.box.height;
        if (!mobile) {
            await link.hover();
            await page.waitForFunction(({ id, before }) => getComputedStyle(document.getElementById(id)).color !== before,
                { id, before: data.colors[0] });
            const hover = await link.evaluate(node => {
                const style = getComputedStyle(node);
                return { color: style.color, icon: getComputedStyle(node.querySelector('i')).color,
                    background: style.backgroundColor, decoration: style.textDecorationLine };
            });
            assert.equal(hover.color, hover.icon);
            assert.equal(hover.background, 'rgba(0, 0, 0, 0)');
            assert.equal(hover.decoration, 'none');
            await page.mouse.move(0, 0);
        }
    }
    assert.equal(styles[0].font, styles[1].font);
    await page.keyboard.press('Tab');
    await page.locator('#how-it-works-link').focus();
    assert.equal(await page.locator('#how-it-works-link').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    await page.locator('#how-it-works-link').evaluate(node => node.blur());
}

async function assertCoverage(page) {
    const comparable = page.locator('.bp-model-row:not(.is-incomparable)');
    const pies = page.locator('.bp-model-row .bp-model-coverage');
    assert.ok(await comparable.count() > 0);
    assert.equal(await pies.count(), await comparable.count());
    const info = await pies.evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect(), row = node.closest('.bp-model-row').getBoundingClientRect();
        const name = node.parentElement.firstElementChild.getBoundingClientRect();
        return { width: box.width, height: box.height, inside: box.left >= row.left && box.right <= row.right,
            withName: node.parentElement.matches('.bp-model-name-with-coverage'), gap: box.left - name.right,
            aligned: Math.abs(box.y + box.height / 2 - name.y - name.height / 2) < 1,
            background: style.backgroundImage, text: node.textContent, role: node.getAttribute('role'),
            label: node.getAttribute('aria-label'), title: node.title, share: node.style.getPropertyValue('--coverage-share') };
    }));
    for (const pie of info) {
        assert.equal(pie.width, 16);
        assert.equal(pie.height, 16);
        assert.ok(pie.inside);
        assert.ok(pie.withName, 'Coverage stays attached to the model name');
        assert.ok(Math.abs(pie.gap - 6) < 1, 'Coverage does not drift into the score column');
        assert.ok(pie.aligned);
        assert.ok(pie.background.startsWith('conic-gradient('));
        assert.equal(pie.text, '');
        assert.equal(pie.role, 'img');
        assert.equal(pie.label, pie.title);
        assert.match(pie.label, /Recorded scores cover .+% of this ranking's weight\./);
        assert.ok(Number.parseFloat(pie.share) >= 0 && Number.parseFloat(pie.share) <= 100);
    }
    assert.doesNotMatch(await page.locator('#model-rows').innerText(), /\d+% covered/);
    return info;
}

for (const [engine, launcher, width] of cases) {
    if (live && (width !== 1440 && width !== 390 || engine === 'webkit' && width !== 390)) continue;
    if (process.env.UI_TEST_WIDTH && !process.env.UI_TEST_WIDTH.split(',').map(Number).includes(width)) continue;
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    const mobile = width <= 760;
    const label = `${engine}-${width}`;
    const app = live ? { url: 'https://benchpoll.com', close: async () => {} } : await startPreview({ rankingStress: true });
    const path = live ? '/Intelligence' : '/Language-models';
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile,
        reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(live ? 60000 : 30000);
    const errors = [];
    const network = [];
    page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) network.push({ event: 'request', path: new URL(request.url()).pathname, time: Date.now() });
    });
    page.on('response', response => {
        if (new URL(response.url()).pathname.startsWith('/api/')) network.push({ event: 'response', path: new URL(response.url()).pathname, status: response.status(), time: Date.now() });
    });
    page.on('requestfailed', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) network.push({ event: 'failed', path: new URL(request.url()).pathname, error: request.failure()?.errorText, time: Date.now() });
    });
    page.on('pageerror', error => errors.push(error.message));
    try {
        if (live) {
            const userAgent = await page.evaluate(() => navigator.userAgent);
            await context.setExtraHTTPHeaders({ 'User-Agent': `${userAgent} BenchPoll-QA/sidebar-coverage-20261021` });
        }
        if (builtRoot) await page.route(`${app.url}/**`, async route => {
            const pathname = new URL(route.request().url()).pathname;
            if (route.request().resourceType() === 'document' && [path, '/'].includes(pathname)) {
                return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': PRIVACY_CONTENT_SECURITY_POLICY },
                    body: await readFile(resolve(builtRoot, 'private/home-built.html')) });
            }
            if (pathname.startsWith('/build/home/')) return route.fulfill({
                contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
                body: await readFile(resolve(builtRoot, 'public', '.' + pathname)) });
            return route.fallback();
        });
        await page.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
        await page.goto(app.url + path, { waitUntil: 'domcontentloaded' });
        await ready(page);
        for (const id of ['how-it-works-link', 'beta-feedback-link']) assert.equal(await page.locator('#' + id).isVisible(), !mobile);
        if (mobile) {
            await page.screenshot({ path: resolve(output, `${label}-header.png`) });
            await page.locator('#taxonomy-toggle').click();
        }
        await assertGuideGroup(page, mobile);
        await page.screenshot({ path: resolve(output, `${label}-sidebar.png`) });
        if (smoke) {
            if (mobile) await page.locator('#taxonomy-close').click();
            if (mobile) await page.locator('[data-mobile-panel="models"]').click();
            const coverage = await assertCoverage(page);
            await page.screenshot({ path: resolve(output, `${label}-coverage.png`) });
            await page.locator('.bp-model-coverage').first().click();
            const search = page.locator('#model-scores-search');
            await search.click();
            assert.equal(await search.getAttribute('placeholder'), 'Search scores in this ranking');
            assert.deepEqual(await search.evaluate(node => ({
                input: getComputedStyle(node).backgroundColor,
                frame: getComputedStyle(node.closest('.bp-ui-field')).backgroundColor,
                outline: getComputedStyle(node).outlineStyle
            })), { input: 'rgba(0, 0, 0, 0)', frame: 'rgb(246, 247, 249)', outline: 'none' });
            await search.locator('..').screenshot({ path: resolve(output, `${label}-score-search.png`) });
            assert.deepEqual(errors, []);
            results.push({ label, passed: true, smoke: true, coverage, errors });
            console.log(JSON.stringify({ label, passed: true, smoke: true, pies: coverage.length }));
            continue;
        }
        await page.locator('#how-it-works-link').press('Enter');
        await page.waitForURL(url => url.pathname === '/how-it-works', { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor();
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await ready(page);
        if (mobile) await page.locator('#taxonomy-toggle').click();
        assert.equal(await page.locator('#beta-feedback-link').getAttribute('href'), '/contribute/feedback');
        if (!live) {
            await page.locator('#beta-feedback-link').click();
            await page.waitForURL(url => url.pathname === '/contribute/feedback');
            await page.locator('#feedback-guidance').waitFor();
            assert.match(await page.locator('#feedback-guidance').textContent(), /Describe the change you want/);
            assert.equal(await page.locator('.feedback-editor textarea').inputValue(), '');
            await page.goBack({ waitUntil: 'domcontentloaded' });
            await ready(page);
        } else if (mobile) await page.locator('#taxonomy-close').click();
        if (mobile) await page.locator('[data-mobile-panel="models"]').click();
        const coverage = await assertCoverage(page);
        await page.screenshot({ path: resolve(output, `${label}-coverage.png`) });
        await page.locator('.bp-model-coverage').first().click();
        await page.locator('#model-scores-dialog').waitFor();
        await page.locator('#model-scores-dialog .dialog-close-button').click();
        await page.locator('[data-score-mode="range"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.bp-model-coverage').length === 0);
        await ready(page);
        await page.locator('[data-score-mode="available"]').click();
        await page.locator('.bp-model-coverage').first().waitFor();
        await ready(page);
        await assertCoverage(page);

        await page.goto(app.url + path + '?view=showcase', { waitUntil: 'domcontentloaded' });
        await ready(page, true);
        for (const id of ['how-it-works-link', 'beta-feedback-link']) assert.equal(await page.locator('#' + id).isVisible(), false);
        await page.locator('#showcase-categories').click();
        await assertGuideGroup(page, mobile);
        await page.screenshot({ path: resolve(output, `${label}-overview-sidebar.png`) });
        await page.locator('#taxonomy-close').click();
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
        for (const id of ['how-it-works-link', 'beta-feedback-link']) assert.equal(await page.locator('#' + id).isVisible(), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        if (app.state) assert.equal(app.state.requests.some(request => ['/api/save_personal_pie', '/api/submit_contribution'].includes(request.path)), false);
        assert.deepEqual(errors, []);
        results.push({ label, passed: true, coverage, errors });
        console.log(JSON.stringify({ label, passed: true, pies: coverage.length }));
    } catch (error) {
        await page.screenshot({ path: resolve(output, `${label}-error.png`) }).catch(() => {});
        await writeFile(resolve(output, `${label}-failure.json`), JSON.stringify({ url: page.url(), network, errors, error: error.message }, null, 2));
        throw error;
    } finally { await context.close(); await browser.close(); await app.close(); }
}
assert.ok(results.length);
await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
