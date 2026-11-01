import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { LEGAL_VERSIONS } from '../public/js/shared/legal-versions.js';

const output = 'D:/Codex-artifacts/website1/showcase-view-20261012/compliance-20261017/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const errors = [], rumRequests = [], violations = [];
        const observedScripts = new Set();
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            const url = new URL(request.url());
            if (url.pathname === '/cdn-cgi/rum') rumRequests.push(url.pathname);
        });
        await context.addInitScript(() => {
            globalThis.privacyViolations = [];
            document.addEventListener('securitypolicyviolation', event => {
                globalThis.privacyViolations.push({ directive: event.effectiveDirective,
                    blockedURI: event.blockedURI === 'inline' ? 'inline' : (() => {
                        try { return new URL(event.blockedURI).origin; } catch { return event.blockedURI; }
                    })() });
            });
        });
        try {
            const response = await page.goto('https://benchpoll.com/account/privacy', { waitUntil: 'domcontentloaded', timeout: 30000 });
            assert.equal(response.status(), 200);
            assert.ok(response.headers()['content-security-policy']?.includes("script-src-attr 'none'"));
            await page.waitForFunction(() => document.getElementById('privacy-status').textContent.startsWith('Not signed in.'), { timeout: 30000 });
            await page.evaluate(() => document.fonts.ready);
            for (const id of ['accepted-terms-check', 'eligible-age']) {
                assert.equal(await page.locator('#' + id).isChecked(), false);
            }
            assert.equal(await page.locator('#private-category-research, #preferences-form').count(), 0);
            assert.equal(await page.locator('#senior-queue-section').isVisible(), false);
            assert.equal(await page.locator('#operator-email').isVisible(), true);
            assert.equal(await page.locator('#operator-email').textContent(), 'privacy@benchpoll.com');
            assert.equal(await page.locator('#operator-contact-note a').textContent(), 'support@benchpoll.com');
            assert.equal(await page.evaluate(() => localStorage.length), 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            const cookies = await context.cookies();
            assert.ok(cookies.some(cookie => cookie.name === 'sid' && cookie.httpOnly && cookie.secure && cookie.sameSite === 'Lax'));
            await page.locator('#submit-consent').click();
            await page.waitForFunction(() => document.activeElement.id === 'accepted-terms-check');
            assert.equal(await page.locator('label[for="accepted-terms-check"]').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
            await page.screenshot({ path: `${output}/account-privacy-${viewport.width}.png`, fullPage: true });
            const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => new URL(node.src).origin));
            scripts.forEach(origin => observedScripts.add(origin));
            violations.push(...await page.evaluate(() => globalThis.privacyViolations));
            await page.goto('https://benchpoll.com/privacy', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.locator(`time[datetime="${LEGAL_VERSIONS.privacy}"]`).waitFor();
            assert.ok(await page.locator('a[href="/account/privacy#request"]').count());
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            violations.push(...await page.evaluate(() => globalThis.privacyViolations));
            await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForFunction(() => document.querySelector('#benchmark-rows')?.children.length > 0, { timeout: 30000 });
            assert.equal(await page.locator('#weight-pie .bp-pie-slice-lift').first()
                .evaluate(node => getComputedStyle(node).getPropertyValue('--bp-pie-hover-scale').trim()), '1.08');
            const handoffs = await page.evaluate(() => Object.keys(localStorage)
                .filter(key => key.startsWith('benchpoll:contribution-entry:')).length);
            assert.equal(handoffs, 0, 'Rendering contribution links must not write handoffs');
            violations.push(...await page.evaluate(() => globalThis.privacyViolations));
            await page.screenshot({ path: `${output}/workspace-${viewport.width}.png` });
            assert.deepEqual(errors, []);
            assert.deepEqual(rumRequests, []);
            assert.ok(violations.every(event => event.blockedURI === 'https://static.cloudflareinsights.com'),
                'Only the deliberately blocked analytics source may violate CSP');
            results.push({ viewport, passed: true, pageErrors: 0, rumRequests: 0,
                blockedAnalyticsEvents: violations.length, scriptOrigins: [...observedScripts],
                unrequestedHandoffWrites: 0, accountActions: 0, privacyRequestsSubmitted: 0 });
        } finally { await context.close(); }
    }
    await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
    console.log(JSON.stringify({ passed: results.length, results }));
} finally { await browser.close(); }
