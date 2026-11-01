import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = new URL('../../artifacts/organization-logos-20261006/ui/', import.meta.url);
await mkdir(output, { recursive: true });
const checks = [];
const brands = [
    { name: 'OpenAI', slug: 'openai', logoKey: 'openai', key: 'openai' },
    { name: 'Anthropic', slug: 'anthropic', logoKey: null, key: 'anthropic' },
    { name: 'Z AI', slug: 'z-ai', logoKey: null, key: 'zai' },
    { name: 'Zhipu AI', slug: 'zhipu', logoKey: null, key: 'zhipu' },
    { name: 'Moonshot AI', slug: 'moonshot-ai', logoKey: null, key: 'moonshot' },
    { name: 'MiniMax', slug: 'minimax', logoKey: null, key: 'minimax' },
    { name: 'Google DeepMind', slug: 'google-alt', logoKey: 'google-alt', key: 'google' },
    { name: 'Unknown studio', slug: 'unknown-studio', logoKey: null, key: null }
];
const modelBrand = (model, index) => {
    const vendor = brands[index % brands.length];
    return { ...model, vendorName: vendor.name, vendorSlug: vendor.slug, logoKey: vendor.logoKey };
};
async function routeFixture(page) {
    await page.route('**/api/**', async route => {
        const response = await route.fetch();
        if (response.status() !== 200) return route.fulfill({ response });
        const data = await response.json();
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/get_weighted_workspace') {
            for (const mode of ['public', 'personal']) data.modelLeaderboards[mode] = data.modelLeaderboards[mode].map(modelBrand);
        } else if (path === '/api/get_benchmark_scores') {
            data.scores = data.scores.map(modelBrand);
        } else if (path === '/api/get_contribution_catalog') {
            data.vendors = brands.map((vendor, index) => ({ ID: index + 1, name: vendor.name, slug: vendor.slug, logoKey: vendor.logoKey }));
            data.models = data.models.map((model, index) => ({ ...modelBrand(model, index), vendorID: index + 1 }));
        }
        await route.fulfill({ response, json: data });
    });
}
async function decoded(page, selector) {
    const values = await page.locator(selector).evaluateAll(async images => {
        await Promise.all(images.map(image => image.decode()));
        return images.map(image => {
            const rectangle = image.getBoundingClientRect();
            return { src: image.getAttribute('src'), width: rectangle.width, height: rectangle.height,
                alt: image.alt, complete: image.complete, naturalWidth: image.naturalWidth };
        });
    });
    assert.ok(values.length > 0, selector + ' contains artwork');
    for (const value of values) {
        assert.ok(value.complete && value.naturalWidth > 0, value.src);
        assert.ok(Math.abs(value.width - 20) < 0.01); assert.ok(Math.abs(value.height - 20) < 0.01); assert.equal(value.alt, '');
        assert.match(value.src, /^\/assets\/vendors\/[^/]+\.(svg|webp|png|jpg)\?v=organization-logos-20261006$/);
    }
    return values;
}
async function gallery(browser, engine, colorScheme) {
    const app = await startPreview();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
        await page.route('**/logo-audit', route => route.fulfill({ contentType: 'text/html', body: '<html lang="en"><title>Logo audit</title></html>' }));
        await page.goto(app.url + '/logo-audit');
        await page.setContent('<html lang="en"><head><title>Organization artwork audit</title><style>body{margin:24px;font:12px Arial;background:#fff;color:#222}main{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:16px}article{display:grid;place-items:center;gap:8px;min-height:105px}img{width:64px;height:64px;object-fit:contain}span{width:64px;height:64px;display:grid;place-items:center;color-scheme:light}</style></head><body><main></main></body></html>');
        const render = await page.evaluate(async () => {
            const { ORGANIZATION_LOGOS, createOrganizationMark } = await import('/js/shared/organization-logos.js?v=organization-logos-20261006');
            const results = [];
            for (const [key, file] of Object.entries(ORGANIZATION_LOGOS)) {
                const article = document.createElement('article');
                const mark = createOrganizationMark(key, 'audit-mark');
                const label = document.createElement('b'); label.textContent = key;
                article.append(mark, label); document.querySelector('main').append(article);
                const image = mark.querySelector('img');
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 64; canvas.style.colorScheme = 'light';
                const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 64, 64);
                const pixels = context.getImageData(0, 0, 64, 64).data;
                let ink = 0;
                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index + 3] > 40 && Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 230) ink++;
                }
                results.push({ key, file, width: image.naturalWidth, height: image.naturalHeight, ink });
            }
            const unknown = createOrganizationMark({ name: '<img src=x onerror=alert(1)>', slug: 'unknown' }, 'audit-mark');
            if (unknown.querySelector('img') || unknown.querySelector('svg')) throw Error('Unknown artwork must not parse user HTML');
            return results;
        });
        for (const item of render) {
            assert.ok(item.ink > 30, `${engine}-${colorScheme}: nonblank ${item.key}`);
            if (!item.file.endsWith('.svg')) assert.ok(Math.min(item.width, item.height) >= 96, `${item.key}: minimum raster resolution`);
        }
        await page.screenshot({ path: new URL(`${engine}-gallery-${colorScheme}.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });
        checks.push({ name: `${engine}-gallery-${colorScheme}`, passed: true, logos: render });
        console.log(`PASS ${engine}-gallery-${colorScheme}: ${render.length} decoded, nonblank images`);
    } finally { await context.close(); await app.close(); }
}
async function surfaces(browser, engine, width) {
    const app = await startPreview();
    const context = await browser.newContext({ viewport: { width, height: 950 },
        isMobile: width < 500, hasTouch: width < 500, deviceScaleFactor: width < 500 ? 3 : 1, colorScheme: 'dark' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [], failures = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
        if (response.url().includes('/assets/vendors/') && !response.ok()) failures.push(response.url());
    });
    await routeFixture(page);
    try {
        await page.goto(app.url);
        await page.locator('#model-rows .bp-model-row').first().waitFor({ state: 'attached' });
        if (width < 500) await page.locator('[data-mobile-panel="models"]').click();
        await page.locator('#model-rows .bp-model-row').first().waitFor();
        assert.equal(await page.locator('#model-rows .bp-vendor-mark img').count(), 7);
        const marks = await page.locator('#model-rows .bp-vendor-mark').evaluateAll(marks => marks.map(mark => mark.dataset.organization ?? null));
        assert.deepEqual(marks, brands.map(vendor => vendor.key));
        assert.equal(await page.locator('#model-rows .bp-vendor-mark.fallback').textContent(), 'U');
        await decoded(page, '#model-rows .bp-vendor-mark img');
        await page.screenshot({ path: new URL(`${engine}-ranking-${width}.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });
        if (width < 500) await page.locator('[data-mobile-panel="mix"]').click();
        await page.locator('.bp-benchmark-information-link').first().click();
        await page.locator('#benchmark-scores-open').click();
        await page.locator('.benchmark-score-row').first().waitFor();
        await decoded(page, '.benchmark-score-vendor img');
        assert.equal(await page.locator('.benchmark-score-vendor[data-organization="zai"]').count(), 6);
        await page.screenshot({ path: new URL(`${engine}-scores-${width}.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });

        await page.goto(app.url + '/contribute/scores/new');
        const input = page.locator('[data-result-model-query]').first();
        await input.fill('Meridian');
        const option = page.locator('[data-select-result-model="303"]').first();
        await option.waitFor();
        assert.equal(await option.locator('.vendor-mark').getAttribute('data-organization'), 'zai');
        await decoded(page, '[data-select-result-model="303"] .vendor-mark img');
        await option.click();
        await page.locator('.evaluation-combobox > .vendor-mark[data-organization="zai"]').waitFor();
        await decoded(page, '.evaluation-combobox > .vendor-mark img');
        assert.equal(await page.locator('.evaluation-combobox > .vendor-mark').evaluate(mark => getComputedStyle(mark).backgroundColor), 'rgba(0, 0, 0, 0)');
        await page.screenshot({ path: new URL(`${engine}-score-form-${width}.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });

        await page.goto(app.url + '/contribute/models/new');
        await page.locator('.vendor-picker summary').click();
        await page.locator('[data-select-vendor="4"] .vendor-mark[data-organization="zhipu"]').waitFor();
        await decoded(page, '.vendor-picker .picker-option .vendor-mark img');
        await page.locator('[data-select-vendor="4"]').click();
        await page.locator('.vendor-picker summary .vendor-mark[data-organization="zhipu"]').waitFor();
        await decoded(page, '.vendor-picker summary .vendor-mark img');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: new URL(`${engine}-vendor-form-${width}.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });
        assert.deepEqual(errors, []); assert.deepEqual(failures, []);
        checks.push({ name: `${engine}-surfaces-${width}`, passed: true });
        console.log(`PASS ${engine}-surfaces-${width}: ranking, scores, suggestions, selected values`);
    } catch (error) {
        await page.screenshot({ path: new URL(`${engine}-failure-${width}.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });
        checks.push({ name: `${engine}-surfaces-${width}`, passed: false, error: error.stack, errors, failures });
        throw error;
    } finally { await context.close(); await app.close(); }
}

try {
    for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
        const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
            http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
        try {
            await gallery(browser, engine, 'light'); await gallery(browser, engine, 'dark');
            for (const width of engine === 'chromium' ? [1440, 390, 320] : [390]) await surfaces(browser, engine, width);
        } finally { await browser.close(); }
    }
} finally { await writeFile(new URL('checks.json', output), JSON.stringify(checks, null, 2)); }
