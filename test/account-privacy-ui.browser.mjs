import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startAccountPrivacyFixture } from './fixtures/account-privacy-server.mjs';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../privacy-headers.js';
import { LEGAL_VERSIONS } from '../public/js/shared/legal-versions.js';

let browser;
const evidence = join(tmpdir(), 'benchpoll-account-privacy-20261017');
before(async () => { browser = await chromium.launch({ headless: true }); await mkdir(evidence, { recursive: true }); });
after(async () => { await browser?.close(); });

async function pageFor(t, options = {}, setup = () => {}, viewport = { width: 1440, height: 1000 }) {
    const fixture = await startAccountPrivacyFixture(options);
    setup(fixture.state);
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(fixture.url).origin) return route.continue();
        if (url.hostname === 'github.com') return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Local intercepted OAuth destination.</p>' });
        return route.abort();
    });
    await context.addInitScript(() => {
        Storage.prototype.setItem = () => { throw new Error('Privacy UI must not persist drafts'); };
        globalThis.privacyCSPViolations = [];
        document.addEventListener('securitypolicyviolation', event => {
            globalThis.privacyCSPViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
        });
    });
    t.after(async () => {
        try {
            if (new URL(page.url()).origin === new URL(fixture.url).origin) {
                assert.deepEqual(await page.evaluate(() => globalThis.privacyCSPViolations), []);
            }
            assert.deepEqual(errors, []);
        } finally { await context.close(); await fixture.close(); }
    });
    const response = await page.goto(`${fixture.url}?expectedUserID=8&userID=7`);
    assert.equal(response.headers()['content-security-policy'], PRIVACY_CONTENT_SECURITY_POLICY);
    assert.equal(response.headers()['x-content-type-options'], 'nosniff');
    return { page, state: fixture.state, fixture };
}

async function loaded(page) {
    await page.waitForFunction(() => /^(Not signed in|Signed in as account)/.test(document.getElementById('privacy-status').textContent));
    await page.waitForFunction(() => !document.getElementById('consent-fields').disabled);
}

async function fillRequest(page, message = 'Please provide the data for account reference test-7.') {
    await page.locator('#request-email').fill('requester@example.test');
    await page.locator('input[name="requestType"][value="access"]').check();
    await page.locator('#request-message').fill(message);
}

test('guest defaults are unchecked, operator identity is pending and nothing writes on load', async t => {
    const { page, state } = await pageFor(t);
    await loaded(page);
    for (const id of ['accepted-terms-check', 'eligible-age']) assert.equal(await page.locator(`#${id}`).isChecked(), false);
    assert.equal(await page.locator('#private-category-research, #preferences-form').count(), 0);
    assert.deepEqual(state.requests.map(item => item.path), ['/api/get_privacy_status']);
    assert.deepEqual(state.requests[0].body, {});
    assert.match(await page.locator('#operator-name').textContent(), /operator has not published a legal name or postal address/);
    assert.equal(await page.locator('#operator-email').isVisible(), false);
    assert.equal(await page.locator('#senior-queue-section').isVisible(), false);
    await page.locator('#submit-consent').click();
    await page.waitForFunction(() => document.activeElement.id === 'accepted-terms-check');
    assert.match(await page.locator('#consent-result').textContent(), /Terms of Use/);
    assert.equal(state.requests.length, 1);
    await page.locator('#accepted-terms-check').check();
    await page.locator('#submit-consent').click();
    await page.waitForFunction(() => document.activeElement.id === 'eligible-age');
    assert.equal(state.requests.length, 1);
});

test('explicit Terms acceptance proceeds to the exact GitHub OAuth endpoint without a research choice', async t => {
    const { page, state } = await pageFor(t);
    await loaded(page);
    await page.locator('#accepted-terms-check').check();
    await page.locator('#eligible-age').check();
    const navigation = page.waitForURL('https://github.com/login/oauth/authorize?*');
    await page.locator('#submit-consent').click();
    await navigation;
    const login = state.requests.find(item => item.path === '/api/prepare_github_login');
    assert.deepEqual(login.body, { csrfToken: 'local-fixture-csrf-1', termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy,
        acceptedTerms: true, eligibleAge: true });
    assert.equal(state.requests.length, 2);
});

test('unsafe redirects and missing login URLs never navigate', async t => {
    const { page, state, fixture } = await pageFor(t);
    await loaded(page);
    state.responses.set('/api/prepare_github_login', [{ body: { url: 'https://github.com.evil.test/login/oauth/authorize' } }]);
    await page.locator('#accepted-terms-check').check();
    await page.locator('#eligible-age').check();
    await page.locator('#submit-consent').click();
    await page.waitForFunction(() => document.getElementById('consent-result').textContent.includes('unsafe address'));
    assert.equal(new URL(page.url()).origin, new URL(fixture.url).origin);
    assert.equal(await page.locator('#accepted-terms-check').isChecked(), true);
    state.responses.set('/api/prepare_github_login', [{ body: {} }]);
    await page.locator('#submit-consent').click();
    await page.waitForFunction(() => document.getElementById('consent-result').textContent.includes('unsafe address'));
    assert.equal(new URL(page.url()).origin, new URL(fixture.url).origin);
});

test('authenticated confirmation keeps historical opt-ins inactive and uses the exact bound account', async t => {
    const { page, state } = await pageFor(t, { authenticated: true, privateCategoryResearch: true });
    await loaded(page);
    await page.locator('#accepted-terms-check').check();
    await page.locator('#eligible-age').check();
    await page.locator('#submit-consent').click();
    await page.locator('#accepted-terms').waitFor();
    const accept = state.requests.find(item => item.path === '/api/accept_legal_terms');
    assert.equal(accept.body.expectedUserID, '9007199254740993');
    assert.equal(Object.hasOwn(accept.body, 'privateCategoryResearch'), false);
    assert.equal(await page.locator('#consent-form').isVisible(), false);
    assert.equal(state.historicalResearchChoice, true);
    assert.equal(state.status.privateCategoryResearch, false);
    assert.equal(state.requests.some(item => item.path === '/api/save_privacy_preferences'), false);
});

test('an unconfirmed Terms acceptance never reports success', async t => {
    const { page, state } = await pageFor(t, { authenticated: true });
    await loaded(page);
    state.responses.set('/api/accept_legal_terms', [{ body: structuredClone(state.status) }]);
    await page.locator('#accepted-terms-check').check();
    await page.locator('#eligible-age').check();
    await page.locator('#submit-consent').click();
    await page.waitForFunction(() => document.getElementById('consent-result').dataset.tone === 'error');
    assert.equal(await page.locator('#accepted-terms-check').isChecked(), true);
    assert.equal(await page.locator('#submit-consent').isEnabled(), true);
    assert.match(await page.locator('#consent-result').textContent(), /did not confirm/);
});

test('account switching blocks all further account writes but not a privacy request', async t => {
    const { page, state } = await pageFor(t, { authenticated: true });
    await loaded(page);
    state.status.userID = '9007199254740992';
    await page.locator('#accepted-terms-check').check();
    await page.locator('#eligible-age').check();
    await page.locator('#submit-consent').click();
    await page.waitForFunction(() => document.getElementById('privacy-status').textContent.includes('sign-in changed'));
    assert.equal(await page.locator('#consent-fields').evaluate(element => element.disabled), true);
    await page.locator('#consent-form').evaluate(form => form.requestSubmit());
    assert.equal(state.requests.filter(item => item.path === '/api/accept_legal_terms').length, 1);
    await fillRequest(page);
    await page.locator('#submit-request').click();
    await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'success');
    assert.equal(ownKey(state.requests.at(-1).body, 'expectedUserID'), false);
});

const ownKey = (value, key) => Object.hasOwn(value, key);

test('anonymous validation is minimal and request text survives server errors and retry', async t => {
    const { page, state } = await pageFor(t);
    await loaded(page);
    await fillRequest(page, 'x');
    await page.locator('#request-email').fill('name@localhost');
    await page.locator('#submit-request').click();
    await page.waitForFunction(() => document.activeElement.id === 'request-email');
    assert.equal(state.requests.length, 1);
    await page.locator('#request-email').fill('requester@example.test');
    state.responses.set('/api/submit_privacy_request', [{ code: 503, body: { error: 'fixture_unavailable' } }]);
    await page.locator('#submit-request').click();
    await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'error');
    assert.equal(await page.locator('#request-message').inputValue(), 'x');
    assert.equal(await page.locator('#request-email').inputValue(), 'requester@example.test');
    await page.locator('#submit-request').click();
    await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'success');
    assert.match(await page.locator('#request-result').textContent(), /Reference: PR-FIXTURE-1.*not email delivery or data erasure/);
    assert.equal(state.recorded.length, 1);
    assert.equal(await page.locator('#submit-request').isEnabled(), false);
    assert.equal(state.requests.some(item => item.path.includes('github')), false);
});

test('transport failure and HTML error pages preserve text and cannot confirm a request', async t => {
    const { page, state } = await pageFor(t);
    await loaded(page);
    await fillRequest(page, 'Keep this request through transport and MIME errors.');
    let attempt = 0;
    await page.route('**/api/submit_privacy_request', route => {
        attempt += 1;
        if (attempt === 1) return route.abort('failed');
        if (attempt === 2) return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><p>Not a receipt.</p></html>' });
        return route.fallback();
    });
    for (let index = 0; index < 2; index += 1) {
        await page.locator('#submit-request').click();
        await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'error');
        assert.equal(await page.locator('#request-message').inputValue(), 'Keep this request through transport and MIME errors.');
        assert.equal(state.recorded.length, 0);
    }
    await page.locator('#submit-request').click();
    await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'success');
    assert.equal(state.recorded.length, 1);
});

test('CSRF recovery refreshes in place and never automatically replays a request', async t => {
    const { page, state } = await pageFor(t);
    await loaded(page);
    await fillRequest(page, 'Keep this exact message.');
    state.status.csrfToken = 'local-fixture-csrf-2';
    await page.locator('#submit-request').click();
    await page.waitForFunction(() => document.getElementById('request-result').textContent.includes('Nothing was automatically resubmitted'));
    assert.equal(state.requests.filter(item => item.path === '/api/submit_privacy_request').length, 1);
    assert.equal(await page.locator('#request-message').inputValue(), 'Keep this exact message.');
    await page.locator('#submit-request').click();
    await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'success');
    assert.equal(state.requests.at(-1).body.csrfToken, 'local-fixture-csrf-2');
});

test('status failure permits drafting, then a successful refresh preserves the draft', async t => {
    const { page } = await pageFor(t, {}, state => {
        state.responses.set('/api/get_privacy_status', [{ code: 503, body: {} }]);
    });
    await page.waitForFunction(() => document.getElementById('privacy-status').dataset.tone === 'error');
    await fillRequest(page, 'Draft while status is unavailable.');
    assert.equal(await page.locator('#submit-request').isEnabled(), false);
    await page.locator('#refresh-status').click();
    await loaded(page);
    assert.equal(await page.locator('#request-message').inputValue(), 'Draft while status is unavailable.');
    assert.equal(await page.locator('#submit-request').isEnabled(), true);
});

test('neither a pending response nor a response without a reference is success', async t => {
    const { page, state } = await pageFor(t);
    await loaded(page);
    await fillRequest(page);
    let release;
    state.holds.set('/api/submit_privacy_request', new Promise(resolve => { release = resolve; }));
    state.responses.set('/api/submit_privacy_request', [{ body: {} }]);
    await page.locator('#submit-request').click();
    await page.waitForFunction(() => document.getElementById('request-form').getAttribute('aria-busy') === 'true');
    assert.notEqual(await page.locator('#request-result').getAttribute('data-tone'), 'success');
    assert.equal(await page.locator('#submit-request').isEnabled(), false);
    release();
    await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'error');
    assert.equal(state.recorded.length, 0);
    assert.equal(await page.locator('#request-message').inputValue(), 'Please provide the data for account reference test-7.');
});

test('senior queue is lazy, owner protected and accessible before accepting Terms', async t => {
    const { page, state } = await pageFor(t, { authenticated: true, isSenior: true, accepted: false });
    await loaded(page);
    assert.equal(await page.locator('#senior-queue-section').isVisible(), true);
    assert.equal(await page.locator('#privacy-queue').getAttribute('open'), null);
    assert.equal(state.requests.length, 1);
    await page.locator('#privacy-queue summary').click();
    await page.locator('.ap-queue-entry').first().waitFor();
    assert.equal(state.requests.at(-1).body.expectedUserID, '9007199254740993');
    assert.equal(state.requests.some(item => item.path === '/api/accept_legal_terms'), false);
    await page.locator('.ap-queue-entry').first().click();
    assert.match(await page.locator('.ap-queue-entry').first().textContent(), /Review by .*\(internal target\)/);
    assert.equal(await page.locator('.ap-request-metadata dt').last().textContent(), 'Review by (internal target)');
    assert.match(await page.locator('#queue-message').textContent(), /<img src=x onerror=/);
    assert.equal(await page.locator('#queue-message img').count(), 0);
    assert.equal(await page.locator('#queue-email').textContent(), '<img>@example.test');
    assert.equal(await page.evaluate(() => globalThis.privacyXSS), undefined);
    await page.locator('#more-requests').click();
    await page.waitForFunction(() => document.querySelectorAll('.ap-queue-entry').length === 3);
    assert.equal(state.requests.at(-1).body.before, 'PR-LOCAL-0002');
    assert.equal(await page.locator('#more-requests').isVisible(), false);
});

test('senior closure requires resolution, preserves unsaved drafts and confirms only an updated response', async t => {
    const { page, state } = await pageFor(t, { authenticated: true, isSenior: true });
    await loaded(page);
    await page.locator('#privacy-queue summary').click();
    await page.locator('.ap-queue-entry').first().click();
    await page.locator('input[name="handlingStatus"][value="closed"]').check();
    await page.locator('#update-request').click();
    await page.waitForFunction(() => document.getElementById('queue-update-result').textContent.includes('before closing'));
    assert.equal(state.requests.some(item => item.path === '/api/update_privacy_request'), false);
    await page.locator('#queue-resolution').fill('Verified through an established channel; request handled manually.');
    await page.locator('.ap-queue-entry').nth(1).click();
    await page.locator('.ap-queue-entry').first().click();
    assert.equal(await page.locator('#queue-resolution').inputValue(), 'Verified through an established channel; request handled manually.');
    state.responses.set('/api/update_privacy_request', [{ body: { updated: false } }]);
    await page.locator('#update-request').click();
    await page.waitForFunction(() => document.getElementById('queue-update-result').dataset.tone === 'error');
    assert.equal(await page.locator('#queue-resolution').inputValue(), 'Verified through an established channel; request handled manually.');
    await page.locator('#update-request').click();
    await page.waitForFunction(() => document.getElementById('queue-update-result').dataset.tone === 'success');
    assert.match(await page.locator('#queue-update-result').textContent(), /No email was sent and no data was automatically erased/);
    assert.equal(state.requests.at(-1).body.expectedUserID, '9007199254740993');
    assert.equal(state.entries[0].status, 'closed');
});

test('non-senior cannot load a queue and lost senior permission removes sensitive queue contents', async t => {
    const member = await pageFor(t, { authenticated: true });
    await loaded(member.page);
    await member.page.locator('#privacy-queue').evaluate(details => { details.open = true; });
    assert.equal(member.state.requests.some(item => item.path === '/api/list_privacy_requests'), false);
    const { page, state } = await pageFor(t, { authenticated: true, isSenior: true });
    await loaded(page);
    await page.locator('#privacy-queue summary').click();
    await page.locator('.ap-queue-entry').first().click();
    state.status.isSenior = false;
    await page.locator('#refresh-queue').click();
    await page.waitForFunction(() => document.getElementById('senior-queue-section').hidden);
    assert.equal(await page.locator('#queue-message').textContent(), '');
    assert.equal(await page.locator('.ap-queue-entry').count(), 0);
});

const displayStates = [
    { name: 'guest', options: {} },
    { name: 'authenticated', options: { authenticated: true, accepted: true } },
    { name: 'old-terms', options: { authenticated: true, accepted: false } },
    { name: 'senior', options: { authenticated: true, isSenior: true, accepted: false } }
];
for (const display of displayStates) for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
    test(`${display.name}: CSP, layout, requests and keyboard focus at ${viewport.width}px`, async t => {
        const { page, state } = await pageFor(t, display.options, undefined, viewport);
        await loaded(page);
        for (const id of ['accepted-terms-check', 'eligible-age']) assert.equal(await page.locator(`#${id}`).isChecked(), false);
        assert.equal(await page.locator('#private-category-research, #preferences-form').count(), 0);
        assert.equal(await page.locator('#consent-form').isVisible(), !display.options.accepted);
        assert.equal(await page.locator('#senior-queue-section').isVisible(), display.name === 'senior');
        if (display.name === 'senior') {
            await page.locator('#privacy-queue summary').click();
            await page.locator('.ap-queue-entry').first().click();
            await page.locator('#queue-resolution').fill('A long reference '.repeat(20));
        }
        await fillRequest(page, 'Please provide the data associated with minimal reference sample-1.');
        state.responses.set('/api/submit_privacy_request', [{ code: 503, body: { error: 'fixture_unavailable' } }]);
        await page.locator('#submit-request').click();
        await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'error');
        assert.equal(await page.locator('#request-message').inputValue(), 'Please provide the data associated with minimal reference sample-1.');
        assert.equal(await page.locator('#request-email').inputValue(), 'requester@example.test');
        await page.locator('#submit-request').click();
        await page.waitForFunction(() => document.getElementById('request-result').dataset.tone === 'success');
        assert.equal(await page.locator('#request-message').inputValue(), 'Please provide the data associated with minimal reference sample-1.');
        assert.equal(await page.locator('#request-email').inputValue(), 'requester@example.test');
        assert.equal(state.requests.some(item => item.path === '/api/prepare_github_login'), false);
        await page.locator('#request-email').focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        const measurements = await page.evaluate(() => {
            const input = document.getElementById('request-email');
            const style = getComputedStyle(input);
            const image = document.querySelector('.ap-header img');
            const overflowing = [...document.querySelectorAll('main *')].filter(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
            }).map(element => element.id || element.className || element.tagName);
            const collidingLabels = [...document.querySelectorAll('.ap-choice')].filter(label => {
                const input = label.querySelector('input').getBoundingClientRect();
                const text = label.querySelector('span').getBoundingClientRect();
                return input.width > 0 && input.right > text.left;
            }).length;
            return { overflow: document.documentElement.scrollWidth > innerWidth, overflowing,
                inputHeight: input.getBoundingClientRect().height, inputOutline: style.outlineStyle,
                inputShadow: style.boxShadow, imageLoaded: image.complete && image.naturalWidth > 0,
                focus: document.activeElement.id, fonts: document.fonts.check('14px Manrope'), collidingLabels };
        });
        assert.equal(measurements.overflow, false);
        assert.deepEqual(measurements.overflowing, []);
        assert.equal(measurements.inputHeight, 44);
        assert.equal(measurements.inputOutline, 'none');
        assert.equal(measurements.inputShadow, 'none');
        assert.equal(measurements.imageLoaded, true);
        assert.equal(measurements.focus, 'request-email');
        assert.equal(measurements.fonts, true);
        assert.equal(measurements.collidingLabels, 0);
        if (!display.options.accepted) {
            await page.locator('#accepted-terms-check').focus();
            const focusStyle = await page.locator('label[for="accepted-terms-check"]').evaluate(node => ({
                outline: getComputedStyle(node).outlineStyle,
                text: getComputedStyle(node.querySelector('span')).textDecorationLine,
                background: getComputedStyle(node).backgroundColor
            }));
            assert.equal(focusStyle.outline, 'none');
            assert.equal(focusStyle.text, 'underline');
            assert.notEqual(focusStyle.background, 'rgba(0, 0, 0, 0)');
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(evidence, `${display.name}-${viewport.width}.png`), fullPage: true });
        await page.screenshot({ path: join(evidence, `${display.name}-${viewport.width}-viewport.png`) });
        if (display.name === 'senior') await page.locator('#privacy-queue').screenshot({ path: join(evidence, `senior-${viewport.width}-queue.png`) });
        t.diagnostic(`Screenshots: ${join(evidence, `${display.name}-${viewport.width}{,-viewport}.png`)}`);
    });
}
