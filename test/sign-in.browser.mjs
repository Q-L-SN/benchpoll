import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../privacy-headers.js';
import { LEGAL_VERSIONS } from '../public/js/shared/legal-versions.js';
import { SIGN_IN_AUTHORIZATION_URL, startSignInFixture } from './fixtures/sign-in-server.mjs';

const output = resolve('D:/Codex-artifacts/website1/sign-in-simplification-20261027');
const statusPath = '/api/get_privacy_status';
const loginPath = '/api/prepare_github_login';
const browsers = new Map();
const viewports = [
    { width: 1440, height: 1000 }, { width: 480, height: 720 },
    { width: 390, height: 844 }, { width: 320, height: 780 }
];

before(async () => {
    const temp = join(output, 'tmp');
    await mkdir(temp, { recursive: true });
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

const requestsFor = (state, path) => state.requests.filter(request => request.path === path);
const loginBody = status => ({ csrfToken: status.csrfToken, termsVersion: status.versions.terms,
    privacyVersion: status.versions.privacy, acceptedTerms: true, eligibleAge: true });

async function requestCount(state, path, count) {
    const deadline = Date.now() + 7000;
    while (requestsFor(state, path).length < count && Date.now() < deadline) await delay(10);
    assert.equal(requestsFor(state, path).length, count, `Expected ${count} request(s) to ${path}`);
}

async function ready(page) {
    await page.waitForFunction(() => !document.getElementById('sign-in-submit').disabled
        && document.getElementById('sign-in-form').getAttribute('aria-busy') !== 'true');
}

async function noAutomaticLogin(page, state, count = 0) {
    await page.waitForLoadState('networkidle');
    assert.equal(requestsFor(state, loginPath).length, count, 'Login requires a fresh explicit submit');
}

async function submitAgainWhilePending(page) {
    await page.locator('#sign-in-form').evaluate(form => {
        form.requestSubmit();
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await delay(100);
}

async function screenshot(page, name) {
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
}

async function pageFor(t, engine, { viewport = viewports[0], status, setup = () => {}, expectedFailures = [] } = {}) {
    const fixture = await startSignInFixture({ status });
    setup(fixture.state);
    let context;
    const errors = [], csp = [], navigation = [], blocked = [], failedResponses = [];
    let disposed = false;
    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try { await context?.close(); }
        finally { await fixture.close(); }
        const expected = failure => expectedFailures.some(item => item.path === failure.path && item.code === failure.code);
        const unexpectedConsole = errors.filter(error => {
            if (error.type !== 'console' || !/^Failed to load resource:/.test(error.text)) return true;
            return !failedResponses.some(failure => failure.url === error.url && expected(failure)
                && error.text.includes(String(failure.code)));
        });
        assert.deepEqual(unexpectedConsole, [], 'No unexpected console errors or uncaught exceptions');
        assert.deepEqual(csp, [], 'Real privacyHeaders must not block the sign-in page');
        assert.deepEqual(blocked, [], 'No unapproved external requests');
        assert.deepEqual(failedResponses.filter(failure => !expected(failure)), [], 'No unexpected HTTP errors');
        assert.deepEqual(fixture.state.failures.filter(failure => !expected(failure)), [], 'No unexpected fixture errors');
    };
    t.after(dispose);
    context = await browsers.get(engine).newContext({ viewport, reducedMotion: 'reduce',
        hasTouch: viewport.width <= 480, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push({ type: 'pageerror', text: error.message }));
    page.on('console', message => {
        if (message.type() === 'error') errors.push({ type: 'console', text: message.text(), url: message.location().url });
    });
    page.on('response', response => {
        if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname,
            code: response.status(), url: response.url() });
    });
    await page.exposeFunction('__signInCSPViolation', violation => csp.push(violation));
    await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', event => {
            void globalThis.__signInCSPViolation({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
        });
    });
    await context.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).origin === fixture.origin) return route.continue();
        if (request.isNavigationRequest()) navigation.push(request.url());
        if (request.url() === SIGN_IN_AUTHORIZATION_URL && request.isNavigationRequest()) {
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
                body: '<!doctype html><title>Intercepted local OAuth destination</title><p>No GitHub request was sent.</p>' });
        }
        blocked.push(request.url());
        return route.abort();
    });
    const response = await page.goto(fixture.url);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['content-security-policy'], PRIVACY_CONTENT_SECURITY_POLICY);
    assert.equal(response.headers()['x-content-type-options'], 'nosniff');
    assert.equal(response.headers()['referrer-policy'], 'no-referrer');
    assert.match(response.headers()['cache-control'], /no-store/);
    return { page, state: fixture.state, fixture, navigation, dispose };
}

async function assertCompactPage(page, viewport) {
    assert.match(await page.title(), /Sign in.*BenchPoll/i);
    assert.equal(await page.getByRole('heading', { level: 1, name: /Sign in.*BenchPoll/i }).count(), 1);
    assert.equal(await page.locator('#sign-in-form').count(), 1);
    assert.equal(await page.locator('input[type="checkbox"], [role="checkbox"]').count(), 0);
    assert.equal(await page.locator('textarea, input[type="email"], #request-form, #preferences-form, #private-category-research').count(), 0);
    assert.equal(await page.getByRole('link', { name: /(?:keep|continue) browsing/i }).count(), 0);
    assert.equal(await page.locator('button[type="submit"], input[type="submit"]').count(), 1);
    assert.equal(await page.getByRole('button').count(), 1);
    assert.equal(await page.locator('#sign-in-retry').isVisible(), false);
    const body = await page.locator('body').innerText();
    assert.doesNotMatch(body, /\b(?:China|Chinese|PRC|research)\b|privacy requests?|中国|中华人民共和国/iu);
    assert.match(body, /\b16\b/);
    assert.match(body, /agree|accept/i);
    assert.match(body, /acknowledg/i);
    assert.match(body, /GitHub/i);
    for (const [name, href] of [['Terms of Use', '/terms'], ['Privacy Policy', '/privacy']]) {
        const link = page.getByRole('link', { name, exact: true });
        assert.equal(await link.isVisible(), true);
        assert.equal(await link.getAttribute('href'), href);
        if (await link.getAttribute('target') === '_blank') assert.match(await link.getAttribute('rel'), /\bnoopener\b/);
        await page.keyboard.press('Tab');
        await link.focus();
        assert.equal(await link.evaluate(node => node === document.activeElement && node.matches(':focus-visible')), true);
        assert.notEqual(await link.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    }
    const submit = page.locator('#sign-in-submit');
    assert.match(await submit.innerText(), /GitHub/i);
    await submit.focus();
    const layout = await page.evaluate(() => {
        const visible = node => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const main = document.querySelector('main');
        const submit = document.getElementById('sign-in-submit');
        const rect = submit.getBoundingClientRect();
        const style = getComputedStyle(submit);
        const blocks = [...main.querySelectorAll('h1, p, button')].filter(visible);
        const overlaps = [];
        blocks.forEach((first, index) => blocks.slice(index + 1).forEach(second => {
            if (first.contains(second) || second.contains(first)) return;
            const a = first.getBoundingClientRect(), b = second.getBoundingClientRect();
            if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
                && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
                overlaps.push([first.id || first.tagName, second.id || second.tagName]);
            }
        }));
        const label = submit.querySelector('span').getBoundingClientRect();
        const icon = submit.querySelector('i').getBoundingClientRect();
        return {
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            outside: [...main.querySelectorAll('*')].filter(visible).filter(node => {
                const box = node.getBoundingClientRect();
                return box.left < -1 || box.right > innerWidth + 1;
            }).map(node => node.id || node.tagName),
            clipped: [...main.querySelectorAll('h1, p, button')].filter(visible)
                .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.id || node.tagName),
            overlaps, button: { x: rect.x, right: rect.right, bottom: rect.bottom, height: rect.height },
            labelFits: label.left >= rect.left && label.right <= rect.right && icon.right <= label.left,
            focus: submit === document.activeElement && submit.matches(':focus-visible'),
            focusStyle: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
            images: [...document.images].map(image => image.complete && image.naturalWidth > 0)
        };
    });
    assert.equal(layout.overflow, false);
    assert.deepEqual(layout.outside, []);
    assert.deepEqual(layout.clipped, []);
    assert.deepEqual(layout.overlaps, []);
    assert.ok(layout.button.height >= 44 && layout.button.x >= 0 && layout.button.right <= viewport.width + 1);
    assert.ok(layout.button.bottom <= viewport.height, 'The primary action is in the first viewport');
    assert.equal(layout.labelFits, true);
    assert.equal(layout.focus, true);
    assert.equal(layout.focusStyle, true);
    assert.ok(layout.images.length > 0 && layout.images.every(Boolean), 'The real brand asset renders');
}

for (const engine of ['chromium', 'webkit']) {
    for (const viewport of viewports) test(`${engine} ${viewport.width}px: compact accessible page, read-only load and no overflow`, async t => {
        let release;
        const { page, state, fixture } = await pageFor(t, engine, { viewport,
            setup: state => { release = state.hold(statusPath); } });
        await requestCount(state, statusPath, 1);
        assert.equal(await page.locator('#sign-in-submit').isDisabled(), true);
        await submitAgainWhilePending(page);
        assert.deepEqual(state.requests, [{ path: statusPath, method: 'POST', body: {} }]);
        release();
        await ready(page);
        await page.evaluate(() => document.fonts.ready);
        await noAutomaticLogin(page, state);
        await assertCompactPage(page, viewport);
        assert.equal(page.url(), fixture.url);
        for (const href of ['/terms', '/privacy']) {
            const response = await page.request.get(fixture.origin + href);
            assert.equal(response.status(), 200);
            assert.equal(response.headers()['content-security-policy'], PRIVACY_CONTENT_SECURITY_POLICY);
            assert.match(response.headers()['content-type'], /text\/html/);
        }
        assert.deepEqual(state.requests.map(request => request.path), [statusPath]);
        await screenshot(page, `${engine}-${viewport.width}-ready`);
        await page.screenshot({ path: join(output, `${engine}-${viewport.width}-viewport.png`) });
        t.diagnostic(`Screenshots: ${output}`);
    });

    test(`${engine}: one explicit click sends only mandatory assent and opens the exact GitHub authorization URL`, async t => {
        const { page, state, navigation } = await pageFor(t, engine);
        await ready(page);
        await noAutomaticLogin(page, state);
        const expected = loginBody(state.status);
        await page.locator('#sign-in-submit').click();
        await page.waitForURL(SIGN_IN_AUTHORIZATION_URL);
        assert.deepEqual(state.requests, [{ path: statusPath, method: 'POST', body: {} },
            { path: loginPath, method: 'POST', body: expected }]);
        assert.equal(Object.hasOwn(state.requests[1].body, 'privateCategoryResearch'), false);
        assert.equal(state.status.privateCategoryResearch, false);
        assert.deepEqual(navigation, [SIGN_IN_AUTHORIZATION_URL]);
    });

    test(`${engine}: pending submission disables controls and ignores duplicate form submissions`, async t => {
        const { page, state, navigation } = await pageFor(t, engine);
        await ready(page);
        const release = state.hold(loginPath);
        await page.locator('#sign-in-submit').click();
        await requestCount(state, loginPath, 1);
        assert.equal(await page.locator('#sign-in-submit').isDisabled(), true);
        assert.equal(await page.locator('#sign-in-retry').isDisabled(), true);
        assert.equal(await page.locator('#sign-in-form').getAttribute('aria-busy'), 'true');
        await submitAgainWhilePending(page);
        assert.equal(requestsFor(state, loginPath).length, 1);
        assert.deepEqual(navigation, []);
        await screenshot(page, `${engine}-submitting`);
        release();
        await page.waitForURL(SIGN_IN_AUTHORIZATION_URL);
        assert.equal(requestsFor(state, loginPath).length, 1);
    });

    test(`${engine}: invalid or missing provider URLs never navigate and remain explicitly retryable`, async t => {
        const { page, state, fixture, navigation } = await pageFor(t, engine);
        await ready(page);
        const invalid = [
            'https://github.com.evil.test/login/oauth/authorize', 'https://evil.test/login/oauth/authorize',
            'http://github.com/login/oauth/authorize', 'https://github.com/login/oauth/authorize/extra',
            'https://github.com:8443/login/oauth/authorize', 'https://user:password@github.com/login/oauth/authorize',
            'https://github.com/login/oauth/authorize#fragment', 'javascript:alert(1)',
            '/login/oauth/authorize', '', null, 42, {}
        ];
        for (const [index, url] of invalid.entries()) {
            state.responses.set(loginPath, [{ body: { url } }]);
            await page.locator('#sign-in-submit').click();
            await requestCount(state, loginPath, index + 1);
            await ready(page);
            assert.equal(await page.locator('#sign-in-status').isVisible(), true);
            assert.match(await page.locator('#sign-in-status').innerText(), /could not|unsafe|invalid|try again/i);
            assert.equal(page.url(), fixture.url, `Unsafe value: ${JSON.stringify(url)}`);
            assert.deepEqual(navigation, []);
        }
        state.responses.set(loginPath, [{ body: {} }]);
        await page.locator('#sign-in-submit').click();
        await requestCount(state, loginPath, invalid.length + 1);
        await ready(page);
        await noAutomaticLogin(page, state, invalid.length + 1);
        assert.equal(page.url(), fixture.url);
        assert.deepEqual(navigation, []);
        await screenshot(page, `${engine}-invalid-provider`);
    });

    test(`${engine}: failed status exposes retry, and refreshing status never prepares login`, async t => {
        const { page, state, navigation } = await pageFor(t, engine, { viewport: viewports[3],
            setup: state => state.responses.set(statusPath, [{ code: 503, body: { error: 'fixture_status_unavailable' } }]),
            expectedFailures: [{ path: statusPath, code: 503 }] });
        await page.locator('#sign-in-retry').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#sign-in-submit').isDisabled(), true);
        assert.match(await page.locator('#sign-in-status').innerText(), /could not|try again/i);
        await submitAgainWhilePending(page);
        await noAutomaticLogin(page, state);
        await screenshot(page, `${engine}-320-status-error`);
        const release = state.hold(statusPath);
        await page.locator('#sign-in-retry').click();
        await requestCount(state, statusPath, 2);
        await page.locator('#sign-in-retry').evaluate(button => { button.click(); button.click(); });
        await submitAgainWhilePending(page);
        assert.equal(requestsFor(state, statusPath).length, 2);
        assert.equal(await page.locator('#sign-in-submit').isDisabled(), true);
        release();
        await ready(page);
        await noAutomaticLogin(page, state);
        assert.deepEqual(navigation, []);
        assert.equal(await page.locator('#sign-in-retry').isVisible(), false);
        await screenshot(page, `${engine}-320-status-recovered`);
        await page.locator('#sign-in-submit').click();
        await page.waitForURL(SIGN_IN_AUTHORIZATION_URL);
        assert.equal(requestsFor(state, loginPath).length, 1);
        assert.ok(requestsFor(state, statusPath).every(request => Object.keys(request.body).length === 0));
    });

    test(`${engine}: malformed and unsupported-version status cannot authorize sign-in`, async t => {
        const { page, state, navigation } = await pageFor(t, engine, { setup: state => {
            state.responses.set(statusPath, [{ body: { ...state.status, csrfToken: '' } },
                { body: { ...state.status, versions: { ...LEGAL_VERSIONS, terms: 'unsupported-fixture-version' } } }]);
        } });
        for (let count = 1; count <= 2; count += 1) {
            await page.locator('#sign-in-retry').waitFor({ state: 'visible' });
            await requestCount(state, statusPath, count);
            assert.equal(await page.locator('#sign-in-submit').isDisabled(), true);
            await submitAgainWhilePending(page);
            await noAutomaticLogin(page, state);
            await page.locator('#sign-in-retry').click();
        }
        await ready(page);
        await requestCount(state, statusPath, 3);
        await noAutomaticLogin(page, state);
        assert.deepEqual(navigation, []);
    });

    for (const code of [403, 409]) test(`${engine}: ${code} expiry refreshes status but requires a NEW explicit submit`, async t => {
        const { page, state, fixture, navigation } = await pageFor(t, engine, {
            expectedFailures: [{ path: loginPath, code }] });
        await ready(page);
        const original = loginBody(state.status);
        state.status.csrfToken = `local-sign-in-refreshed-${code}`;
        if (code === 409) state.responses.set(loginPath, [{ code, body: { error: 'legal_version_mismatch' } }]);
        const release = state.hold(statusPath);
        await page.locator('#sign-in-submit').click();
        await requestCount(state, loginPath, 1);
        await requestCount(state, statusPath, 2);
        assert.deepEqual(requestsFor(state, loginPath)[0].body, original);
        assert.equal(await page.locator('#sign-in-submit').isDisabled(), true);
        await submitAgainWhilePending(page);
        assert.equal(requestsFor(state, loginPath).length, 1);
        release();
        await ready(page);
        await noAutomaticLogin(page, state, 1);
        assert.equal(page.url(), fixture.url);
        assert.deepEqual(navigation, []);
        assert.match(await page.locator('#sign-in-status').innerText(), /refresh|again|continue/i);
        await screenshot(page, `${engine}-${code}-fresh-click-required`);
        await page.locator('#sign-in-submit').focus();
        await page.keyboard.press('Enter');
        await page.waitForURL(SIGN_IN_AUTHORIZATION_URL);
        assert.deepEqual(requestsFor(state, loginPath).map(request => request.body), [original, loginBody(state.status)]);
        assert.deepEqual(state.requests.map(request => request.path), [statusPath, loginPath, statusPath, loginPath]);
    });

    test(`${engine}: failed expiry refresh stays blocked until a manual status retry and another submit`, async t => {
        const { page, state, navigation } = await pageFor(t, engine, { expectedFailures: [
            { path: loginPath, code: 403 }, { path: statusPath, code: 503 }
        ] });
        await ready(page);
        state.status.csrfToken = 'local-sign-in-after-refresh-failure';
        state.responses.set(statusPath, [{ code: 503, body: { error: 'fixture_refresh_unavailable' } }]);
        await page.locator('#sign-in-submit').click();
        await page.locator('#sign-in-retry').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#sign-in-submit').isDisabled(), true);
        await submitAgainWhilePending(page);
        await noAutomaticLogin(page, state, 1);
        assert.deepEqual(navigation, []);
        await page.locator('#sign-in-retry').click();
        await ready(page);
        await noAutomaticLogin(page, state, 1);
        assert.equal(requestsFor(state, statusPath).length, 3);
        await page.locator('#sign-in-submit').click();
        await page.waitForURL(SIGN_IN_AUTHORIZATION_URL);
        assert.equal(requestsFor(state, loginPath).length, 2);
        assert.deepEqual(requestsFor(state, loginPath)[1].body, loginBody(state.status));
    });
}
