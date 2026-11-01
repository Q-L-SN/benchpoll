import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, webkit, devices } from 'playwright';
import { startAccountPrivacyFixture } from './fixtures/account-privacy-server.mjs';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../privacy-headers.js';
import { LEGAL_VERSIONS } from '../public/js/shared/legal-versions.js';

const artifacts = join(tmpdir(), 'benchpoll-inline-legal-20261031');
let chrome, safari;
before(async () => {
    await mkdir(artifacts, { recursive: true });
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*' };
    chrome = await chromium.launch({ headless: true, env });
    safari = await webkit.launch({ headless: true, env });
});
after(async () => { await chrome?.close(); await safari?.close(); });

const harness = `import '/js/global.js';
import { postJSON } from '/js/shared/http.js';
import { pageAccountWriteScope } from '/js/shared/account-identity.js';
const send = () => pageAccountWriteScope.write(postJSON, '/api/legal-test-write', { text: document.querySelector('textarea').value });
window.trySave = async () => {
    try { await send(); document.querySelector('output').textContent = 'Saved'; }
    catch (error) { document.querySelector('output').textContent = error.message; }
};
document.querySelector('#save').addEventListener('click', () => { void window.trySave(); });
window.tryConcurrent = () => Promise.all([window.trySave(), window.trySave(), window.trySave()]);
window.tryUnhandled = () => { void send(); };
window.harnessReady = true;`;

async function pageFor(t, { accepted = false, authenticated = true, engine = 'chromium', mobile = false, setup = () => {} } = {}) {
    const fixture = await startAccountPrivacyFixture({ authenticated, accepted, privateCategoryResearch: true });
    setup(fixture.state);
    const context = await (engine === 'webkit' ? safari : chrome).newContext(mobile
        ? { ...devices['iPhone 13'], reducedMotion: 'reduce' }
        : { viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [], writes = [], diagnostics = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', item => { if (item.type() === 'error') diagnostics.push(item.text()); });
    page.on('requestfailed', request => diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`));
    const origin = new URL(fixture.url).origin;
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/inline-legal') return route.fulfill({ contentType: 'text/html',
            headers: { 'content-security-policy': PRIVACY_CONTENT_SECURITY_POLICY },
            body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">
                <link rel="stylesheet" href="/css/global.css"><link rel="stylesheet" href="/css/site-palette.css">
                <link rel="stylesheet" href="/css/ui/components.css"><title>Inline legal acceptance test</title></head>
                <body><label>Draft<textarea>Keep my unsaved contribution.</textarea></label>
                <button id="save" type="button">Save</button><output></output>
                <script type="module" src="/legal-acceptance-harness.js"></script></body></html>` });
        if (url.pathname === '/legal-acceptance-harness.js') return route.fulfill({ contentType: 'text/javascript', body: harness });
        if (url.pathname === '/api/legal-test-write') {
            writes.push(route.request().postDataJSON());
            const ok = fixture.state.status.accepted;
            return route.fulfill({ status: ok ? 200 : 409, contentType: 'application/json',
                body: JSON.stringify(ok ? { saved: true } : { error: 'legal_acceptance_required' }) });
        }
        return route.continue();
    });
    t.after(async () => {
        try { assert.deepEqual(errors, []); }
        finally { await context.close(); await fixture.close(); }
    });
    try {
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith('/api/get_privacy_status')),
            page.goto(`${origin}/inline-legal`).then(() => page.waitForFunction(() => window.harnessReady))
        ]);
    } catch (error) {
        t.diagnostic(JSON.stringify({ url: page.url(), diagnostics, errors }));
        throw error;
    }
    return { page, state: fixture.state, writes, context, origin };
}

const ready = page => page.locator('#legal-acceptance-submit').waitFor({ state: 'visible' });
const accepted = page => page.waitForFunction(() => document.querySelector('#legal-acceptance-close')?.textContent === 'Done');
const acceptanceWrites = state => state.requests.filter(request => request.path === '/api/accept_legal_terms');
const statusReads = state => state.requests.filter(request => request.path === '/api/get_privacy_status');

for (const [engine, mobile] of [['chromium', false], ['chromium', true], ['webkit', true]]) {
    test(`${engine} ${mobile ? 'mobile' : 'desktop'}: returning account accepts explicitly in two clicks without navigation`, async t => {
        const { page, state, writes, origin } = await pageFor(t, { engine, mobile });
        await ready(page);
        assert.equal(acceptanceWrites(state).length, 0);
        assert.match(await page.locator('.bp-legal-acceptance-body').textContent(), /at least 16/);
        assert.match(await page.locator('.bp-legal-acceptance-documents').textContent(), new RegExp(LEGAL_VERSIONS.privacy));
        for (const path of ['/terms', '/privacy']) {
            const link = page.locator(`.bp-legal-acceptance-documents a[href="${path}"]`);
            assert.equal(await link.getAttribute('target'), '_blank');
            assert.equal(await link.getAttribute('rel'), 'noopener');
        }
        const geometry = await page.locator('#legal-acceptance-notice').evaluate(element => {
            const box = element.shadowRoot.querySelector('.dialog-content').getBoundingClientRect();
            return { left: box.left, right: box.right, bottom: box.bottom, top: box.top, width: innerWidth, height: innerHeight };
        });
        assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height);
        await page.screenshot({ path: join(artifacts, `${engine}-${mobile ? 'mobile' : 'desktop'}.png`) });
        await page.locator('#legal-acceptance-submit').click();
        await accepted(page);
        assert.equal(acceptanceWrites(state).length, 1);
        assert.deepEqual(acceptanceWrites(state)[0].body, { csrfToken: 'local-fixture-csrf-1', termsVersion: LEGAL_VERSIONS.terms,
            privacyVersion: LEGAL_VERSIONS.privacy, acceptedTerms: true, eligibleAge: true, expectedUserID: '9007199254740993' });
        assert.equal(state.historicalResearchChoice, true);
        assert.equal(state.requests.some(request => request.path === '/api/save_privacy_preferences'), false);
        assert.equal(writes.length, 0);
        await page.locator('#legal-acceptance-close').click();
        assert.equal(await page.locator('#legal-acceptance-notice').isVisible(), false);
        assert.equal(page.url(), `${origin}/inline-legal`);
        assert.equal(await page.locator('textarea').inputValue(), 'Keep my unsaved contribution.');
    });
}

test('current accounts and guests are never asked to accept or written to automatically', async t => {
    for (const options of [{ accepted: true }, { authenticated: false }]) {
        const { page, state } = await pageFor(t, options);
        assert.equal(await page.locator('#legal-acceptance-notice').count(), 0);
        assert.equal(acceptanceWrites(state).length, 0);
    }
});

for (const code of [401, 503]) test(`a passive ${code} status failure never mounts a policy modal`, async t => {
    const { page, state } = await pageFor(t, { setup(state) {
        state.responses.set('/api/get_privacy_status', [{ code, body: { error: 'fixture_unavailable' } }]);
    } });
    assert.equal(await page.locator('#legal-acceptance-notice').count(), 0);
    assert.equal(acceptanceWrites(state).length, 0);
});

test('returning from the page cache checks current versions without losing the draft', async t => {
    const { page, state } = await pageFor(t, { accepted: true });
    await page.locator('textarea').fill('A draft retained by Back.');
    state.status.accepted = false;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await ready(page);
    assert.equal(await page.locator('textarea').inputValue(), 'A draft retained by Back.');
    assert.equal(acceptanceWrites(state).length, 0);
});

test('Not now and Escape preserve the draft and never accept', async t => {
    const { page, state } = await pageFor(t);
    await ready(page);
    await page.locator('#legal-acceptance-close').click();
    await page.locator('textarea').fill('My draft after cancelling.');
    await page.locator('#save').click();
    await ready(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#legal-acceptance-notice').isVisible(), false);
    assert.equal(await page.locator('textarea').inputValue(), 'My draft after cancelling.');
    assert.equal(acceptanceWrites(state).length, 0);
});

test('concurrent rejected actions share one notice and one read; acceptance never replays writes', async t => {
    const { page, state, writes } = await pageFor(t, { accepted: true });
    await page.evaluate(async () => {
        const { pageAccountWriteScope } = await import('/js/shared/account-identity.js');
        pageAccountWriteScope.bind('9007199254740993');
    });
    state.status.accepted = false;
    const before = statusReads(state).length;
    let release;
    state.holds.set('/api/get_privacy_status', new Promise(resolve => { release = resolve; }));
    await page.evaluate(() => window.tryConcurrent());
    await page.waitForFunction(() => !document.querySelector('#legal-acceptance-notice').hidden);
    assert.equal(await page.locator('#legal-acceptance-notice').count(), 1);
    assert.equal(statusReads(state).length, before + 1);
    assert.equal(writes.length, 3);
    release();
    state.holds.delete('/api/get_privacy_status');
    await ready(page);
    await page.locator('#legal-acceptance-submit').click();
    await accepted(page);
    assert.equal(writes.length, 3);
    await page.locator('#legal-acceptance-close').click();
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('output').textContent === 'Saved');
    assert.equal(writes.length, 4);
});

test('an otherwise unhandled acceptance gate cannot navigate away and discard a draft', async t => {
    const { page, state, origin, writes } = await pageFor(t);
    await ready(page);
    await page.locator('#legal-acceptance-close').click();
    await page.locator('textarea').fill('Keep this even without a local catch.');
    await page.evaluate(() => window.tryUnhandled());
    await ready(page);
    assert.equal(page.url(), `${origin}/inline-legal`);
    assert.equal(await page.locator('textarea').inputValue(), 'Keep this even without a local catch.');
    assert.equal(writes.length, 1);
    assert.equal(acceptanceWrites(state).length, 0);
});

test('double clicks during acceptance produce one request and Escape does not imply cancellation of an in-flight write', async t => {
    const { page, state } = await pageFor(t);
    await ready(page);
    let release;
    state.holds.set('/api/accept_legal_terms', new Promise(resolve => { release = resolve; }));
    await page.locator('#legal-acceptance-submit').evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => document.querySelector('#legal-acceptance-submit').disabled);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#legal-acceptance-notice').isVisible(), true);
    release();
    await accepted(page);
    assert.equal(acceptanceWrites(state).length, 1);
});

test('network/server failure stays inline and a status read confirms a lost response without resubmitting', async t => {
    const { page, state, writes } = await pageFor(t);
    await ready(page);
    state.responses.set('/api/accept_legal_terms', [{ code: 503, body: { error: 'fixture_unavailable' } }]);
    await page.locator('#legal-acceptance-submit').click();
    await page.locator('#legal-acceptance-refresh').waitFor();
    assert.match(await page.locator('#legal-acceptance-status').textContent(), /could not be confirmed/);
    assert.equal(acceptanceWrites(state).length, 1);
    assert.equal(await page.locator('textarea').inputValue(), 'Keep my unsaved contribution.');
    state.status.accepted = true;
    await page.locator('#legal-acceptance-refresh').click();
    await accepted(page);
    assert.equal(acceptanceWrites(state).length, 1);
    assert.equal(writes.length, 0);
});

test('a malformed or unconfirmed acceptance response never reports success', async t => {
    const { page, state } = await pageFor(t);
    await ready(page);
    state.responses.set('/api/accept_legal_terms', [{ body: structuredClone(state.status) }]);
    await page.locator('#legal-acceptance-submit').click();
    await page.locator('#legal-acceptance-refresh').waitFor();
    assert.equal(await page.locator('#legal-acceptance-close').textContent(), 'Not now');
    assert.equal(acceptanceWrites(state).length, 1);
});

test('expired CSRF refreshes the notice but requires another explicit acceptance click', async t => {
    const { page, state } = await pageFor(t);
    await ready(page);
    state.responses.set('/api/accept_legal_terms', [{ code: 403, body: { error: 'privacy_form_expired' } }]);
    await page.locator('#legal-acceptance-submit').click();
    await page.waitForFunction(() => document.querySelector('#legal-acceptance-status').textContent.includes('security check was refreshed'));
    assert.equal(acceptanceWrites(state).length, 1);
    await page.locator('#legal-acceptance-submit').click();
    await accepted(page);
    assert.equal(acceptanceWrites(state).length, 2);
});

test('a newer legal version is displayed and is not automatically accepted', async t => {
    const { page, state } = await pageFor(t);
    await ready(page);
    state.responses.set('/api/accept_legal_terms', [{ code: 409, body: { error: 'legal_version_changed' } }]);
    state.status.versions.privacy = '2026-11-02';
    await page.locator('#legal-acceptance-submit').click();
    await page.waitForFunction(() => document.querySelector('#legal-acceptance-status').textContent.includes('documents changed again'));
    assert.match(await page.locator('.bp-legal-acceptance-documents').textContent(), /2026-11-02/);
    assert.equal(acceptanceWrites(state).length, 1);
    assert.equal(acceptanceWrites(state)[0].body.privacyVersion, LEGAL_VERSIONS.privacy);
    assert.equal(await page.locator('#legal-acceptance-submit').isEnabled(), true);
});

for (const expired of [true, false]) test(`${expired ? 'session expiry' : 'account switching'} never accepts for another account or loses the draft`, async t => {
    const { page, state } = await pageFor(t);
    await ready(page);
    state.status.userID = expired ? null : '9007199254740992';
    state.status.authenticated = !expired;
    await page.locator('#legal-acceptance-submit').click();
    await page.locator('#legal-acceptance-sign-in').waitFor();
    assert.equal(await page.locator('#legal-acceptance-submit').isVisible(), false);
    assert.equal(await page.locator('textarea').inputValue(), 'Keep my unsaved contribution.');
    assert.equal(acceptanceWrites(state).length, 1);
    assert.equal(state.status.accepted, false);
    assert.equal(await page.locator('#legal-acceptance-sign-in').getAttribute('target'), '_blank');
    await page.locator('#legal-acceptance-close').click();
    assert.equal(await page.locator('#legal-acceptance-notice').isVisible(), false);
});

test('an expired acceptance session can refresh for the same owner without reloading or autoaccepting', async t => {
    const { page, state, writes, origin } = await pageFor(t);
    await ready(page);
    const owner = state.status.userID;
    state.status.userID = null;
    state.status.authenticated = false;
    await page.locator('#legal-acceptance-submit').click();
    await page.locator('#legal-acceptance-sign-in').waitFor();
    state.status.userID = owner;
    state.status.authenticated = true;
    state.status.csrfToken = 'replacement-fixture-csrf';
    await page.locator('#legal-acceptance-refresh').click();
    await ready(page);
    assert.equal(acceptanceWrites(state).length, 1);
    assert.equal(page.url(), `${origin}/inline-legal`);
    assert.equal(await page.locator('textarea').inputValue(), 'Keep my unsaved contribution.');
    await page.locator('#legal-acceptance-submit').click();
    await accepted(page);
    assert.equal(acceptanceWrites(state).length, 2);
    assert.equal(acceptanceWrites(state)[1].body.expectedUserID, owner);
    assert.equal(acceptanceWrites(state)[1].body.csrfToken, 'replacement-fixture-csrf');
    assert.equal(writes.length, 0);
    await page.locator('#legal-acceptance-close').click();
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('output').textContent === 'Saved');
    assert.equal(writes.length, 1);
});

test('refreshing after a session failure cannot bind a different account', async t => {
    const { page, state } = await pageFor(t);
    await ready(page);
    state.status.userID = null;
    state.status.authenticated = false;
    await page.locator('#legal-acceptance-submit').click();
    await page.locator('#legal-acceptance-sign-in').waitFor();
    state.status.userID = '9007199254740992';
    state.status.authenticated = true;
    await page.locator('#legal-acceptance-refresh').click();
    await page.locator('#legal-acceptance-sign-in').waitFor();
    assert.equal(await page.locator('#legal-acceptance-submit').isVisible(), false);
    assert.equal(acceptanceWrites(state).length, 1);
    assert.equal(await page.locator('textarea').inputValue(), 'Keep my unsaved contribution.');
});

test('cancelling a pending status read ignores its late response', async t => {
    const { page, state } = await pageFor(t, { accepted: true });
    state.status.accepted = false;
    let release;
    state.holds.set('/api/get_privacy_status', new Promise(resolve => { release = resolve; }));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('benchpoll:legal-acceptance-required')));
    await page.locator('#legal-acceptance-close').click();
    release();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#legal-acceptance-notice').isVisible(), false);
    assert.equal(acceptanceWrites(state).length, 0);
});

test('the dedicated privacy page keeps its existing flow; header test drift also exists with the installer disabled', async t => {
    const results = [];
    for (const enabled of [false, true]) {
        const fixture = await startAccountPrivacyFixture();
        const page = await chrome.newPage();
        t.after(async () => { await page.close(); await fixture.close(); });
        if (!enabled) await page.route('**/js/global.js', async route => {
            const source = await readFile(new URL('../public/js/global.js', import.meta.url), 'utf8');
            return route.fulfill({ contentType: 'text/javascript', body: source.replace('installLegalAcceptance();', '') });
        });
        const profile = page.waitForResponse(response => response.url().endsWith('/api/get_user_profile'));
        await page.goto(fixture.url);
        await profile;
        await page.waitForFunction(() => document.getElementById('privacy-status').textContent.startsWith('Not signed in'));
        results.push({ requests: fixture.state.requests.map(item => item.path).sort(),
            inlineModals: await page.locator('#legal-acceptance-notice').count(),
            legacyHeaderImages: await page.locator('.ap-header img').count() });
    }
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[1], { requests: ['/api/get_privacy_status', '/api/get_user_profile'], inlineModals: 0, legacyHeaderImages: 0 });
});
