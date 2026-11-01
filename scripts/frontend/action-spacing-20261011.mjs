import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = resolve(process.env.ACTION_SPACING_OUTPUT ?? 'artifacts/action-spacing-20261011/browser');
const builtRoot = process.env.HOME_BUILT_ROOT;
const record = process.argv.includes('--record');
const reports = [];
const cases = [['chromium', chromium, 1440], ['chromium-repeat', chromium, 1440],
    ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
await mkdir(output, { recursive: true });

async function geometry(action) {
    return action.evaluate(node => {
        const icon = node.querySelector(':scope > i, :scope > svg');
        const label = node.querySelector(':scope > .bp-ui-action-label');
        const range = document.createRange();
        const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
        let bounds;
        if (label) bounds = label.getBoundingClientRect();
        else if (text) { range.selectNode(text); bounds = range.getBoundingClientRect(); }
        const glyph = icon?.getBoundingClientRect();
        const styles = getComputedStyle(node);
        return { shared: node.classList.contains('bp-ui-action'), variant: node.dataset.uiVariant,
            gap: glyph && bounds ? Math.max(bounds.left - glyph.right, glyph.left - bounds.right) : null,
            iconWidth: glyph?.width, font: styles.fontSize, height: node.getBoundingClientRect().height,
            border: styles.borderTopWidth, background: styles.backgroundColor,
            decoration: styles.textDecorationLine, overflow: node.scrollWidth > node.clientWidth + 1 };
    });
}

function verify(metrics, variant, mobile) {
    assert.equal(metrics.shared, true);
    assert.equal(metrics.variant, variant);
    assert.ok(metrics.gap >= 7.5 && metrics.gap <= 8.5, JSON.stringify(metrics));
    assert.equal(metrics.iconWidth, 16);
    assert.equal(metrics.font, '13px');
    assert.ok(metrics.height >= (mobile ? 44 : 36));
    assert.equal(metrics.decoration, 'none');
    assert.equal(metrics.overflow, false);
    if (variant === 'quiet') {
        assert.equal(metrics.border, '0px');
        assert.equal(metrics.background, 'rgba(0, 0, 0, 0)');
    }
}

for (const [engine, launcher, width] of cases) {
    const app = await startPreview();
    const browser = await launcher.launch({ headless: true, env });
    const mobile = width <= 760;
    const context = await browser.newContext({ viewport: { width, height: 900 },
        isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const name = `${engine}-${width}`;
    try {
        if (builtRoot) await context.route('**/*', async route => {
            const path = new URL(route.request().url()).pathname;
            if (route.request().resourceType() === 'document' && path === '/') return route.fulfill({
                body: await readFile(join(builtRoot, 'private/home-built.html')), contentType: 'text/html'
            });
            if (/^\/(?:css|js|build\/home)\//.test(path)) return route.fulfill({
                body: await readFile(join(builtRoot, 'public', path)),
                contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript'
            });
            return route.fallback();
        });
        await page.goto(app.url, { waitUntil: 'domcontentloaded' });
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        if (mobile) await page.locator('#taxonomy-toggle').click();
        await page.locator('[data-navigation-view="configured"]').click();
        const create = page.locator('#private-category-create-toggle');
        await create.waitFor();
        const initial = await geometry(create);
        await page.locator('#configured-panel').screenshot({ path: join(output, name + '-configured.png') });
        if (!record) {
            verify(initial, 'quiet', mobile);
            await create.hover();
            verify(await geometry(create), 'quiet', mobile);
            assert.equal(await create.evaluate(node => getComputedStyle(node).color),
                await create.locator('i').evaluate(node => getComputedStyle(node).color));
            await create.focus();
            assert.ok(await create.evaluate(node => Number.parseFloat(getComputedStyle(node).outlineWidth) >= 2));
        }
        await create.click();
        const form = page.locator('#private-category-create-form');
        await form.waitFor();
        const submit = await geometry(form.locator('[type="submit"]'));
        await form.screenshot({ path: join(output, name + '-form.png') });
        if (!record) {
            verify(submit, 'primary', mobile);
            assert.equal(await form.locator('[data-cancel]').getAttribute('data-ui-variant'), 'quiet');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        }
        await form.locator('[data-cancel]').click();
        await form.waitFor({ state: 'hidden' });
        if (!record) verify(await geometry(create), 'quiet', mobile);
        assert.deepEqual(errors, []);
        assert.equal(app.state.requests.some(request => request.path === '/api/create_private_category'), false);
        reports.push({ name, passed: !record, record, compiled: Boolean(builtRoot), create: initial, submit, productionWrites: 0 });
        console.log(JSON.stringify(reports.at(-1)));
    } catch (error) {
        reports.push({ name, passed: false, error: String(error), errors });
        await page.screenshot({ path: join(output, name + '-FAILED.png') }).catch(() => {});
        throw error;
    } finally {
        await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
        await context.close(); await browser.close(); await app.close();
    }
}
