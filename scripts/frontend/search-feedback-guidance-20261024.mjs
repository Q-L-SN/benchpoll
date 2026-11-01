import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { startTopicsPreview } from './topics-home-fixtures.mjs';
import { betaFeedbackTemplate, bulkImportTemplate, mergeRequestTemplate, privacyRequestTemplate,
    feedbackGuidance, feedbackMessageLimit, feedbackSubmission } from '../../public/js/shared/feedback-templates.js';

const origin = process.argv.find(arg => arg.startsWith('--origin='))?.slice(9);
const engineOnly = process.argv.find(arg => arg.startsWith('--engine='))?.slice(9);
const output = resolve(process.env.SEARCH_FEEDBACK_OUTPUT || `D:/Codex-artifacts/website1/search-feedback-guidance-20261024/${origin ? 'public-assets' : 'browser'}`);
await mkdir(output, { recursive: true });
process.env.TEMP = process.env.TMP = 'D:/Codex-artifacts/website1/showcase-composition-20261021/tmp';
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const report = { origin: origin || 'local fixtures', api: 'Isolated fixtures only; no production API requests or writes', cases: [], errors: [], passed: false };

async function newPage(browser, fixture, width, entry) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500,
        reducedMotion: 'reduce', ignoreHTTPSErrors: Boolean(origin) });
    if (entry) await context.addInitScript(({ token, details }) => {
        localStorage.setItem('benchpoll:contribution-entry:' + token, JSON.stringify({ path: '/contribute/feedback',
            expiresAt: Date.now() + 600000, values: { details, pageURL: location.origin + '/test-topic' } }));
    }, entry);
    const page = await context.newPage();
    let closing = false;
    page.setDefaultTimeout(origin ? 45000 : 15000);
    page.setDefaultNavigationTimeout(origin ? 60000 : 15000);
    page.on('pageerror', error => report.errors.push(error.message));
    // Even in public-asset mode, every API operation goes to the isolated fixture.
    await page.route('**/api/**', async route => {
        try {
            const request = route.request(), url = new URL(request.url());
            const response = await fetch(fixture.url + url.pathname + url.search, { method: request.method(),
                headers: { 'content-type': 'application/json' }, body: request.postData() || undefined });
            await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
        } catch (error) {
            if (!closing) report.errors.push(`Fixture request: ${error.message}`);
            await route.abort().catch(() => {});
        }
    });
    return { page, base: origin || fixture.url, close: async () => { closing = true; await context.close(); } };
}

async function searchCase(browser, engine, width) {
    const app = await startTopicsPreview();
    const { page, close, base } = await newPage(browser, app, width);
    try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.locator('#topics-grid[aria-busy="false"]').waitFor();
        await page.locator('#topics-recent').click();
        await page.locator('#topic-search-toggle').click();
        const input = page.locator('#topic-search'), action = page.locator('#topic-search-close');
        assert.equal(await action.getAttribute('aria-label'), 'Close search');
        await input.fill('sefeafaf');
        assert.equal(await action.getAttribute('aria-label'), 'Clear search');
        assert.equal(await page.locator('.th-search button').count(), 1);
        const style = await input.evaluate(node => ({
            nativeClearSuppressed: [...document.styleSheets].some(sheet => {
                try { return [...sheet.cssRules].some(rule => rule.selectorText?.includes('.th-search input::-webkit-search-cancel-button') && rule.style.display === 'none'); }
                catch { return false; }
            }),
            innerBorder: getComputedStyle(node.parentElement).borderTopWidth,
            outline: getComputedStyle(node).outlineStyle,
            actionWidth: document.getElementById('topic-search-close').getBoundingClientRect().width,
            overflow: document.documentElement.scrollWidth - innerWidth
        }));
        assert.equal(style.nativeClearSuppressed, true);
        assert.equal(style.innerBorder, '0px'); assert.equal(style.outline, 'none');
        assert.equal(style.actionWidth, 44); assert.ok(style.overflow <= 1);
        await page.evaluate(() => document.fonts.ready);
        await page.locator('.th-island').screenshot({ path: join(output, `${engine}-${width}-search.png`) });
        await action.click();
        assert.equal(await input.inputValue(), '');
        assert.equal(await input.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('body').getAttribute('data-collection'), 'search');
        assert.equal(await action.getAttribute('aria-label'), 'Close search');
        await action.click();
        assert.equal(await page.locator('body').getAttribute('data-collection'), 'recent');
        await page.locator('#topic-search-toggle').click();
        await input.fill('  '); await input.press('Tab'); await action.press('Enter');
        assert.equal(await input.inputValue(), '');
        assert.equal(await page.locator('body').getAttribute('data-collection'), 'search');
        await input.fill('Math'); await input.press('Escape');
        assert.equal(await page.locator('body').getAttribute('data-collection'), 'recent');
        report.cases.push({ engine, width, kind: 'search', style, passed: true });
    } finally { await close(); await app.close(); }
}

const templates = [
    ['default', ''], ['beta', betaFeedbackTemplate()],
    ['bulk', bulkImportTemplate({ query: 'CyberGym', categoryPath: 'Security', contextValues: { operating_system: 'Linux' } })],
    ['merge', mergeRequestTemplate({ name: 'Example benchmark', kind: 'benchmark', ID: 7 })],
    ['privacy', privacyRequestTemplate()],
    ['legacy', 'Bulk import request\n\nBenchmarks:\nCyberGym\n\nOfficial sources:\n[Links]\n\nScores to include:\n[Models]\n\nCategory: Security\nTask options: operating system: Linux']
];

async function feedbackCase(browser, engine, width, kind, details) {
    const app = await startPreview();
    const token = randomUUID();
    const { page, close, base } = await newPage(browser, app, width, { token, details });
    const payloads = [];
    let attempts = 0;
    await page.route('**/api/submit_contribution', async route => {
        attempts++; payloads.push(route.request().postDataJSON());
        if (kind === 'bulk' && attempts === 1) return route.fulfill({ status: 503, json: { error: 'synthetic_failure' } });
        return route.fallback();
    });
    try {
        await page.goto(`${base}/contribute/feedback#entry=${token}`, { waitUntil: 'domcontentloaded' });
        const input = page.locator('.feedback-editor textarea'), instructions = page.locator('#feedback-guidance');
        await input.waitFor();
        const canonical = feedbackGuidance(details);
        assert.equal(new URL(page.url()).hash, '');
        assert.equal(await input.inputValue(), '');
        assert.equal(await instructions.textContent(), canonical);
        assert.equal(await instructions.getAttribute('translate'), 'yes');
        assert.equal(await input.getAttribute('aria-describedby'), 'feedback-guidance');
        assert.equal(Number(await input.getAttribute('maxlength')), feedbackMessageLimit(canonical));
        assert.equal(await page.locator('#contribute-subtitle').isVisible(), false);
        const fit = await instructions.evaluate(node => {
            const rect = node.getBoundingClientRect(), editor = node.nextElementSibling.querySelector('textarea').getBoundingClientRect();
            return { above: rect.bottom <= editor.top, fits: rect.left >= 0 && rect.right <= innerWidth,
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.equal(fit.above, true); assert.equal(fit.fits, true); assert.ok(fit.overflow <= 1);
        const rejectShortMessage = async () => {
            await page.locator('#submit-contribution').click();
            await page.waitForFunction(() => !document.getElementById('submit-contribution').disabled);
            assert.equal(payloads.length, 0, 'instructions alone must not submit');
            if (await page.locator('#submit-error-dialog').isVisible()) {
                assert.match(await page.locator('#submit-error-copy').textContent(), /more detail/);
                await page.locator('#submit-error-dialog .dialog-close-button').click();
            }
        };
        await rejectShortMessage();
        await input.fill('short'); await rejectShortMessage();
        const message = kind === 'privacy' ? 'x'.repeat(feedbackMessageLimit(canonical))
            : 'Please review this request and retain the official source links.\nThe source should remain visible.';
        await input.fill(message);
        if (kind === 'bulk' || kind === 'merge' || kind === 'default') {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: join(output, `${engine}-${width}-${kind}.png`) });
        }
        // Translators edit ordinary DOM text, not the canonical payload or the user's draft.
        await instructions.evaluate(node => { node.textContent = 'Indica los datos que quieres enviar.'; });
        await page.locator('#submit-contribution').click();
        if (kind === 'bulk') {
            await page.locator('#submit-error-dialog:not([hidden])').waitFor();
            assert.equal(await input.inputValue(), message);
            await page.locator('#submit-error-dialog .dialog-close-button').click();
            await page.locator('#submit-contribution').click();
        }
        await page.locator('#submit-success-dialog:not([hidden])').waitFor();
        assert.ok(payloads.length > 0);
        for (const payload of payloads) {
            assert.equal(payload.type, 'feedback');
            assert.equal(payload.details, feedbackSubmission(canonical, message));
            assert.ok(payload.details.length <= 4000);
        }
        assert.equal(await input.inputValue(), message, 'submission must not insert the prefix into the draft');
        if (kind === 'privacy') assert.equal(payloads[0].details.length, 4000);
        report.cases.push({ engine, width, kind, attempts, payloadLength: payloads.at(-1).details.length, fit, passed: true });
    } finally { await close(); await app.close(); }
}

async function edgeFeedbackCase(browser, engine) {
    const app = await startPreview();
    const token = randomUUID(), details = bulkImportTemplate({ query: 'CyberGym <img src=x onerror=alert(1)>' });
    const { page, close, base } = await newPage(browser, app, 390, { token, details });
    try {
        await page.goto(`${base}/contribute/feedback#entry=${token}`, { waitUntil: 'domcontentloaded' });
        const input = page.locator('.feedback-editor textarea'); await input.waitFor();
        assert.match(await page.locator('#feedback-guidance').textContent(), /<img src=x/);
        assert.equal(await page.locator('#feedback-guidance img').count(), 0);
        await input.evaluate(node => { node.value = 'x'.repeat(node.maxLength + 1); node.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-error-dialog:not([hidden])').waitFor();
        assert.match(await page.locator('#submit-error-copy').textContent(), /too long/);
        await page.locator('#submit-error-dialog .dialog-close-button').click();
        if (!await page.locator('#contribution-bulk-import').isVisible()) await page.locator('#contribution-taxonomy-toggle').click();
        await page.locator('#contribution-bulk-import').click();
        await page.waitForFunction(value => document.getElementById('feedback-guidance')?.textContent === value, bulkImportTemplate());
        assert.equal(await page.locator('.feedback-editor textarea').inputValue(), '', 'same-form handoff must start a fresh request');
        assert.equal(new URL(page.url()).hash, '');
        const oversizedToken = randomUUID();
        await page.evaluate(({ entry, value }) => localStorage.setItem('benchpoll:contribution-entry:' + entry,
            JSON.stringify({ path: '/contribute/feedback', expiresAt: Date.now() + 600000, values: { details: value } })),
        { entry: oversizedToken, value: 'x'.repeat(4000) });
        await page.goto(`${base}/contribute/feedback#entry=${oversizedToken}`, { waitUntil: 'domcontentloaded' });
        await page.waitForURL(url => url.hash === '');
        await page.locator('#submit-error-dialog:not([hidden])').waitFor();
        assert.match(await page.locator('#submit-error-copy').textContent(), /prefilled instructions are too long/);
        assert.equal(app.state.requests.filter(request => request.path === '/api/submit_contribution').length, 0);
        report.cases.push({ engine, kind: 'escaped-context-and-oversize-guards', passed: true });
    } finally { await close(); await app.close(); }
}

try {
    for (const [engine, launcher] of [['chrome', chromium], ['webkit', webkit]]) {
        if (engineOnly && engine !== engineOnly) continue;
        const browser = await launcher.launch({ headless: true, env: origin ? process.env : env });
        try {
            for (const width of [1440, 390, 320]) {
                await searchCase(browser, engine, width);
                for (const [kind, details] of templates) await feedbackCase(browser, engine, width, kind, details);
                console.log(`PASS ${engine} ${width}: one search action; six translatable form entries, retry and full payload bounds`);
            }
            await edgeFeedbackCase(browser, engine);
        } finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
} catch (error) {
    report.failure = error.stack;
    throw error;
} finally {
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, output }));
