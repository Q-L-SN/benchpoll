import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from './topics-home-fixtures.mjs';
import { startPreview } from './server.mjs';
import { COVERAGE_PENALTY_STORAGE_KEY } from '../../public/js/shared/coverage-penalty.js';

const output = resolve(process.env.TOPIC_IDENTITY_OUTPUT || 'D:/Codex-artifacts/website1/topic-identity-ui-20261026/identity-browser');
await mkdir(output, { recursive: true });
const home = await startTopicsPreview();
const configuration = await startPreview();
const report = { verified: false, checks: [], errors: [] };

async function choosePenalty(page, label) {
    await page.getByRole('combobox', { name: 'Coverage penalty', exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
}

async function checkIconToggle(page, selector) {
    const button = page.locator(selector);
    if (!await button.isEnabled()) return;
    const off = await button.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    await button.click();
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', selector);
    await page.waitForFunction(({ selector, color }) => getComputedStyle(document.querySelector(selector)).color !== color, { selector, color: off.color });
    const on = await button.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    assert.notEqual(off.color, on.color);
    assert.equal(off.background, 'rgba(0, 0, 0, 0)'); assert.equal(on.background, off.background);
    await button.hover();
    assert.equal(await button.evaluate(node => getComputedStyle(node).backgroundColor), off.background);
}

try {
    for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
        if (process.argv.includes('--webkit') && engineName !== 'webkit') continue;
        const browser = await engine.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
            http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
        try {
            for (const width of [1440, 768, 390, 320]) {
                const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 761, hasTouch: width < 761 });
                const page = await context.newPage();
                page.on('pageerror', error => report.errors.push({ engineName, width, message: error.message }));
                page.setDefaultTimeout(20000);
                try {
                    await page.goto(home.url);
                    await page.locator('.th-card.is-featured[data-preview-state="loaded"]').waitFor();
                    const identity = await page.locator('.th-card.is-featured').evaluate(card => {
                        const summary = card.querySelector('.th-topic-summary');
                        return { summary: summary.textContent, by: card.querySelector('.bp-topic-byline-prefix').textContent,
                            arrow: Boolean(card.querySelector('.th-topic-link > .fa-arrow-right')),
                            summaryBottom: summary.getBoundingClientRect().bottom, chartTop: card.querySelector('.th-visual').getBoundingClientRect().top,
                            overflow: document.documentElement.scrollWidth - innerWidth };
                    });
                    assert.ok(identity.summary); assert.equal(identity.by, 'by'); assert.ok(identity.arrow);
                    assert.ok(identity.summaryBottom <= identity.chartTop + 1); assert.ok(identity.overflow < 1);
                    await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
                    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
                    await choosePenalty(page, 'Rational (a=5)');
                    await page.waitForFunction(() => localStorage.getItem('benchpoll-coverage-penalty-experiment-v1') === 'rational');
                    await page.locator('.th-card.is-featured[data-preview-state="loaded"]').waitFor();
                    assert.ok(home.state.requests.some(request => request.path === '/api/get_topic_preview' && request.body.availableInferenceVersion === 5));
                    await checkIconToggle(page, '[data-comparison="reasoning"]');
                    await page.getByRole('button', { name: 'Score range', exact: true }).click();
                    assert.equal(await page.locator('.bp-coverage-experiment').isVisible(), false);
                    await page.getByRole('button', { name: 'Available results', exact: true }).click();
                    assert.equal(await page.locator('#home-coverage-penalty').inputValue(), 'rational');
                    await page.getByRole('tab', { name: 'Mine', exact: true }).click();
                    await page.getByRole('button', { name: 'New public topic', exact: true }).click();
                    assert.equal(await page.locator('#new-topic-description').evaluate(node => node.required), true);
                    await page.locator('#new-topic-name').fill('Summary required');
                    await page.getByRole('button', { name: 'Create topic', exact: true }).click();
                    assert.equal(await page.locator('#new-topic-description').evaluate(node => node.validity.valueMissing), true);
                    await page.getByRole('button', { name: 'Close new topic', exact: true }).click();
                    await page.screenshot({ path: join(output, `${engineName}-${width}-home.png`) });

                    await context.addInitScript(({ key }) => localStorage.setItem(key, 'rational'), { key: COVERAGE_PENALTY_STORAGE_KEY });
                    await page.goto(configuration.url + '/Language-models');
                    await page.waitForFunction(() => document.querySelectorAll('#model-rows .bp-model-row').length > 0);
                    await page.locator('#workspace-topic-summary').waitFor({ state: 'visible' });
                    assert.equal(await page.locator('#workspace-coverage-penalty').inputValue(), 'rational');
                    assert.ok(configuration.state.requests.some(request => request.path === '/api/get_weighted_workspace' && request.body.availableInferenceVersion === 5));
                    assert.equal(await page.locator('#bp-breadcrumb .bp-topic-byline-prefix').textContent(), 'by');
                    if (width < 761) await page.locator('[data-taxonomy-trigger]').first().click();
                    const rows = page.locator('#tree-content .bp-topic-row');
                    await rows.first().waitFor({ state: 'visible' });
                    const cards = await rows.evaluateAll(nodes => nodes.map(node => ({ summary: node.querySelector('.bp-topic-summary')?.textContent,
                        border: getComputedStyle(node).borderTopWidth, height: node.getBoundingClientRect().height })));
                    assert.ok(cards.length > 0); assert.ok(cards.every(card => card.summary && card.border === '1px' && card.height >= 76));
                    if (width < 761) {
                        await page.locator('#taxonomy-close').click();
                        await page.getByRole('button', { name: 'Model ranking', exact: true }).click();
                    }
                    const powerResponse = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                        && response.request().postDataJSON()?.availableInferenceVersion === 4);
                    await choosePenalty(page, 'Power 0.35');
                    await powerResponse;
                    assert.equal(await page.locator('#workspace-coverage-penalty').inputValue(), 'power');
                    await checkIconToggle(page, '[data-quick-comparison="reasoning"]');
                    await page.screenshot({ path: join(output, `${engineName}-${width}-configuration.png`) });
                    report.checks.push({ engineName, width, identity, sidebarCards: cards.length, penalties: ['power', 'rational'] });
                } catch (error) {
                    await page.screenshot({ path: join(output, `${engineName}-${width}-failed.png`) }).catch(() => {});
                    report.failure = { engineName, width, message: error.message, page: await page.locator('body').innerText(),
                        recentRequests: home.state.requests.slice(-8) };
                    throw error;
                } finally { await context.close(); }
            }
        } finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []);
    report.verified = true;
} finally {
    await home.close(); await configuration.close();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ verified: report.verified, checks: report.checks.length, output }));
