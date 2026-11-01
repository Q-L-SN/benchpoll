import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../privacy-headers.js';
import { fixtureProposal, PROPOSAL_OWNER, startProposalFixture } from './fixtures/topic-proposals-server.mjs';

const output = resolve(process.env.TOPIC_PROPOSALS_ARTIFACTS ?? 'D:/Codex-artifacts/website1/topic-proposals-20261028');
const browsers = new Map();
const publishPath = '/api/propose_topic', supportPath = '/api/vote_topic_proposal', listPath = '/api/get_topic_proposals';
const cancelPath = '/api/cancel_topic_proposal_support', editPath = '/api/edit_topic_proposal', withdrawPath = '/api/withdraw_topic_proposal';
const requests = (state, path) => state.requests.filter(request => request.path === path);
const writes = state => state.requests.filter(request => [publishPath, supportPath, cancelPath, editPath, withdrawPath].includes(request.path));

before(async () => {
    const temp = join(output, 'tmp');
    await mkdir(temp, { recursive: true });
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function pageFor(t, { engine = 'chromium', viewport = { width: 1440, height: 1000 }, profile,
    proposals, setup = () => {}, expectedFailures = [], wait = true, blockedStorage = false } = {}) {
    const fixture = await startProposalFixture({ ...(profile !== undefined ? { profile } : {}), ...(proposals ? { proposals } : {}) });
    setup(fixture.state);
    const context = await browsers.get(engine).newContext({ viewport, reducedMotion: 'reduce',
        hasTouch: viewport.width <= 480, serviceWorkers: 'block' });
    const errors = [], violations = [], blocked = [], failures = [], navigation = [];
    const expected = failure => expectedFailures.some(item => item.path === failure.path && item.code === failure.code);
    t.after(async () => {
        await context.close();
        await fixture.close();
        assert.deepEqual(errors.filter(error => error.type !== 'console' || !/^Failed to load resource:/.test(error.message)
            || !failures.some(failure => expected(failure) && failure.url === error.url && error.message.includes(String(failure.code)))), [], 'No unexpected browser errors');
        assert.deepEqual(violations, [], 'No CSP violations');
        assert.deepEqual(blocked, [], 'No external or production requests');
        assert.deepEqual(failures.filter(failure => !expected(failure)), [], 'No unexpected HTTP failures');
        assert.deepEqual(fixture.state.failures.filter(failure => !expected(failure)), [], 'Fixture is strict about payloads and assets');
    });
    await context.exposeFunction('__proposalCSPViolation', violation => violations.push(violation));
    await context.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
        void globalThis.__proposalCSPViolation({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    }));
    if (blockedStorage) await context.addInitScript(() => Object.defineProperty(window, 'sessionStorage', {
        get() { throw new DOMException('Storage unavailable', 'SecurityError'); }
    }));
    context.on('page', page => {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }));
        page.on('console', message => {
            if (message.type() === 'error') errors.push({ type: 'console', message: message.text(), url: message.location().url });
        });
        page.on('response', response => {
            if (response.status() >= 400) failures.push({ path: new URL(response.url()).pathname, code: response.status(), url: response.url() });
        });
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigation.push(frame.url()); });
    });
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
        blocked.push(route.request().url());
        return route.abort();
    });
    const page = await context.newPage();
    const response = await page.goto(fixture.url);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['content-security-policy'], PRIVACY_CONTENT_SECURITY_POLICY);
    if (wait) await ready(page);
    return { page, context, fixture, state: fixture.state, navigation };
}

async function ready(page) {
    await page.waitForFunction(() => document.getElementById('proposals-list-region')?.getAttribute('aria-busy') === 'false'
        && (!document.getElementById('proposals-account').disabled || !document.getElementById('proposals-account-status').hidden));
}
async function requestCount(state, path, count) {
    const deadline = Date.now() + 8000;
    while (requests(state, path).length < count && Date.now() < deadline) await delay(10);
    assert.equal(requests(state, path).length, count);
}
async function openDraft(page, name = 'Multilingual analysis', description = 'Comparing model reasoning across languages.') {
    await page.locator('#open-proposal').click();
    await page.locator('#proposal-name').fill(name);
    await page.locator('#proposal-description').fill(description);
}
const row = (page, id = 104) => page.locator(`#proposal-${id}`);
const support = (page, id = 104) => row(page, id).locator('[data-support-id]');
const screenshot = (page, name, fullPage = true) => page.screenshot({ path: join(output, `${name}.png`), fullPage });
const ownerAction = (page, action, id = 105) => row(page, id).locator(`[data-action="${action}"]`);
const makeCollecting = state => {
    Object.assign(state.proposals.find(proposal => proposal.proposalID === 105), { status: 'open', supportCount: 12, submissionID: null });
};
async function quotaIs(page, supports, proposals) {
    await page.waitForFunction(({ supports, proposals }) => document.getElementById('proposals-quota').textContent
        === `${supports} / 3 active supports; ${proposals} / 1 collecting proposal`, { supports, proposals });
    await ready(page);
}

async function assertLayout(page, modal = false) {
    await page.evaluate(() => document.fonts.ready);
    const findings = await page.evaluate(modal => {
        const scope = modal ? document.getElementById('proposal-dialog') : document.querySelector('main');
        const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
        const invalid = [];
        if (document.documentElement.scrollWidth > innerWidth + 1) invalid.push('horizontal document overflow');
        for (const node of scope.querySelectorAll('h1,h2,h3,p,input,textarea,button')) {
            if (!visible(node)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width > innerWidth + 1 || rect.left < -1 || rect.right > innerWidth + 1) invalid.push(`${node.id || node.tagName}: viewport overflow`);
            if (!node.matches('input') && node.scrollWidth > node.clientWidth + 2) invalid.push(`${node.id || node.tagName}: text overflow`);
            if (node.matches('button') && rect.height < 43) invalid.push(`${node.id || node.tagName}: touch target too short`);
            if (Number.parseFloat(getComputedStyle(node).borderRadius) > 8) invalid.push(`${node.id || node.tagName}: oversized radius`);
        }
        if (modal) {
            const rect = scope.getBoundingClientRect();
            if (rect.top < -1 || rect.bottom > innerHeight + 1) invalid.push('dialog outside viewport');
        }
        return invalid;
    }, modal);
    assert.deepEqual(findings, []);
    assert.equal(await page.locator('.bp-site-brand img').evaluate(image => image.complete && image.naturalWidth > 0), true);
    assert.notEqual(await page.locator('#open-proposal i').evaluate(icon => getComputedStyle(icon, '::before').content), 'none');
}

for (const engine of ['chromium', 'webkit']) for (const viewport of [
    { width: 1440, height: 1000 }, { width: 768, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }
]) test(`${engine}: usable hall and keyboard dialog at ${viewport.width}px`, async t => {
    const { page, state } = await pageFor(t, { engine, viewport, setup: state => {
        state.proposals.unshift(fixtureProposal({ proposalID: 106, name: 'Long'.repeat(32),
            description: 'Comparing evidence across long documents, languages, code and scientific tasks.', supportCount: 1,
            creator: { name: 'Hidden proposal creator' } }));
    } });
    assert.equal(await page.locator('.tp-row').count(), 7);
    assert.equal(await page.getByRole('heading', { level: 1, name: 'Topic proposals', exact: true }).count(), 1);
    assert.doesNotMatch(await page.locator('main').innerText(), /Hidden proposal creator|Sponsored|Payment|Created by/);
    assert.equal(await row(page, 101).getByRole('link', { name: 'View Topic' }).getAttribute('href'), '/visual-reasoning');
    assert.equal(await support(page, 105).isDisabled(), true, 'Own proposal cannot be supported');
    await assertLayout(page);
    await screenshot(page, `${engine}-${viewport.width}-hall`);
    await openDraft(page, 'Long'.repeat(32), 'Evidence and reasoning across documents and languages.');
    assert.equal(await page.locator('#proposal-name').evaluate(input => input === document.activeElement), false, 'Summary is focused after filling');
    assert.equal(await page.locator('input[type="checkbox"],input[type="email"]').count(), 0);
    assert.equal(await page.locator('select').count(), 1, 'The only select chooses the proposal target, not privacy or context dimensions');
    assert.equal(await page.locator('#proposal-target').inputValue(), '');
    assert.equal(await page.locator('#proposal-target option').first().textContent(), 'New topic');
    assert.equal(await page.locator('#proposal-email-notice').textContent(), 'You will receive the review result by email. We will use the verified address linked to your GitHub account.');
    await assertLayout(page, true);
    for (let index = 0; index < 14; index++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.contains(document.activeElement)), true, 'Modal contains keyboard focus');
    }
    await screenshot(page, `${engine}-${viewport.width}-proposal`, false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), false);
    assert.equal(await page.locator('#open-proposal').evaluate(button => button === document.activeElement), true);
    await page.locator('#open-proposal').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Long'.repeat(32));
    assert.equal(await page.locator('#proposal-name').evaluate(input => input === document.activeElement), true);
    await page.locator('#proposal-cancel').click();
    assert.deepEqual(writes(state), []);
});

for (const engine of ['chromium', 'webkit']) test(`${engine}: review tab filters proposals and keeps the shared header`, async t => {
    const { page, state } = await pageFor(t, { engine, viewport: { width: 390, height: 844 } });
    const header = page.locator('.bp-site-header');
    assert.equal(await header.evaluate(node => getComputedStyle(node).position), 'sticky');
    await header.getByRole('button', { name: 'More information' }).click();
    for (const name of ['BenchPoll on X', 'Proposal hall', 'How it works']) {
        assert.equal(await header.getByRole('link', { name }).isVisible(), true);
    }
    assert.equal(await header.getByRole('button', { name: /account center/i }).isVisible(), true);
    assert.equal(await header.getByRole('link', { name: 'Privacy', exact: true }).isVisible(), true);
    await header.getByRole('button', { name: 'More information' }).press('Escape');
    assert.equal(await page.locator('.tp-footer').count(), 0);
    await page.getByRole('tab', { name: 'In review' }).click();
    await ready(page);
    assert.equal(await page.locator('.tp-row').count(), 2);
    assert.deepEqual(await page.locator('.tp-row').evaluateAll(rows => rows.map(row => row.dataset.status)), ['pending', 'pending']);
    assert.equal(requests(state, listPath).at(-1).body.view, 'review');
    await page.getByRole('tab', { name: 'In review' }).press('ArrowLeft');
    await ready(page);
    assert.equal(await page.locator('.tp-row').count(), 6);
    assert.equal(requests(state, listPath).at(-1).body.view, 'all');
});

test('publish requires a valid Unicode summary, is single flight, cannot be dismissed pending, and starts at zero', async t => {
    const { page, state } = await pageFor(t);
    await openDraft(page, 'Multilingual analysis', '');
    await page.locator('#proposal-submit').click();
    assert.equal(await page.locator('#proposal-description').getAttribute('aria-invalid'), 'true');
    await page.locator('#proposal-description').fill('\u{1F9EA}'.repeat(181));
    await page.locator('#proposal-submit').click();
    assert.equal(await page.locator('#proposal-description-count').textContent(), '181 / 180');
    assert.deepEqual(writes(state), []);
    await page.locator('#proposal-description').fill('\u{1F9EA}'.repeat(180));
    const release = state.hold(publishPath);
    await page.locator('#proposal-submit').click();
    await requestCount(state, publishPath, 1);
    assert.equal(await page.locator('#proposal-cancel').isDisabled(), true);
    assert.equal(await page.locator('#proposal-close').isDisabled(), true);
    assert.equal(await page.locator('#proposal-name').evaluate(input => input.readOnly), true);
    await page.keyboard.press('Escape');
    await page.locator('#proposal-form').evaluate(form => {
        form.requestSubmit();
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(requests(state, publishPath).length, 1);
    release();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    assert.match(await page.locator('#proposals-feedback').textContent(), /Proposal published with 0 supports/);
    assert.match(await row(page, 106).textContent(), /0 \/ 30 supports/);
    assert.equal(await support(page, 106).isDisabled(), true);
    const request = requests(state, publishPath)[0];
    assert.deepEqual(request.body, { name: 'Multilingual analysis', description: '\u{1F9EA}'.repeat(180),
        csrfToken: state.csrfToken, expectedUserID: PROPOSAL_OWNER });
    assert.match(request.key, /^[0-9a-f-]{36}$/);
    assert.equal(requests(state, '/api/get_privacy_status').length, 1);
    assert.equal(state.staticRequests.some(request => request.path === '/multilingual-analysis'), false);
    await screenshot(page, 'published-zero-supports');
});

test('30th support updates only after server confirmation, closes support and enters official review', async t => {
    const { page, state } = await pageFor(t);
    const release = state.hold(supportPath);
    await support(page).click();
    await requestCount(state, supportPath, 1);
    assert.equal(await support(page).isDisabled(), true);
    assert.match(await row(page).textContent(), /29 \/ 30 supports/);
    await support(page).evaluate(button => button.dispatchEvent(new Event('click', { bubbles: true })));
    assert.equal(requests(state, supportPath).length, 1);
    release();
    await row(page).getByText('In official review', { exact: true }).waitFor();
    assert.equal(await support(page).isDisabled(), true);
    assert.match(await row(page).textContent(), /30 \/ 30 supports/);
    assert.match(await page.locator('#proposals-feedback').textContent(), /now in official review/);
    assert.equal(await row(page).getByRole('link').count(), 0);
    assert.deepEqual(requests(state, supportPath)[0].body, { proposalID: 104, revision: 1, csrfToken: state.csrfToken, expectedUserID: PROPOSAL_OWNER });
    await screenshot(page, 'thirtieth-support-review');
});

test('guest popup sign-in retains the modal draft and document and never auto-publishes or auto-supports', async t => {
    const { page, state, fixture } = await pageFor(t, { profile: null, viewport: { width: 320, height: 780 } });
    await page.evaluate(() => { window.proposalDocumentMarker = 'same-document'; });
    await openDraft(page);
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#proposal-submit').click();
    const popup = await popupPromise;
    await popup.getByRole('button', { name: 'Complete local sign-in' }).click();
    await page.waitForFunction(() => document.getElementById('proposal-submit').textContent.includes('Publish proposal')
        && !document.getElementById('proposal-submit').disabled);
    await ready(page);
    assert.equal(page.url(), fixture.url);
    assert.equal(await page.evaluate(() => window.proposalDocumentMarker), 'same-document');
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Multilingual analysis');
    assert.deepEqual(writes(state), []);
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    assert.equal(requests(state, publishPath).length, 1);
    assert.equal(requests(state, supportPath).length, 0);
    await screenshot(page, 'guest-signed-in-published');
});

test('a guest support click requires a fresh explicit click after sign-in', async t => {
    const { page, state } = await pageFor(t, { profile: null });
    const popupPromise = page.waitForEvent('popup');
    await support(page).click();
    const popup = await popupPromise;
    await popup.getByRole('button', { name: 'Complete local sign-in' }).click();
    await page.waitForFunction(() => document.getElementById('proposals-account').hasAttribute('aria-haspopup'));
    await ready(page);
    assert.deepEqual(writes(state), []);
    await support(page).click();
    await row(page).getByText('In official review', { exact: true }).waitFor();
    assert.equal(requests(state, supportPath).length, 1);
});

test('manual pagination uses only the cursor, keeps rows on failure and retries the same page', async t => {
    const proposals = Array.from({ length: 65 }, (_, index) => fixtureProposal({ proposalID: 200 - index,
        name: `Reasoning area ${index}`, supportCount: 0 }));
    const { page, state } = await pageFor(t, { proposals,
        expectedFailures: [{ path: listPath, code: 503 }] });
    assert.equal(await page.locator('.tp-row').count(), 30);
    assert.deepEqual(requests(state, listPath)[0].body, { view: 'all' });
    state.responses.set(listPath, [{ code: 503, body: { error: 'unavailable' } }]);
    await page.locator('#proposals-load-more').click();
    await page.locator('#proposals-page-error').waitFor();
    assert.equal(await page.locator('.tp-row').count(), 30);
    const release = state.hold(listPath);
    await page.locator('#proposals-load-more').click();
    await requestCount(state, listPath, 3);
    assert.equal(await page.locator('#proposals-load-more').isDisabled(), true);
    release();
    await page.waitForFunction(() => document.querySelectorAll('.tp-row').length === 60);
    await page.locator('#proposals-load-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.tp-row').length === 65);
    assert.equal(await page.locator('#proposals-load-more').isVisible(), false);
    assert.deepEqual(requests(state, listPath).map(request => request.body), [{ view: 'all' }, { view: 'all', before: 171 }, { view: 'all', before: 171 }, { view: 'all', before: 141 }]);
    assert.deepEqual(writes(state), []);
});

for (const variant of ['loading', 'empty', 'error', 'invalid']) test(`list ${variant} is real, recoverable and never writes`, async t => {
    let release;
    const { page, state } = await pageFor(t, { wait: variant !== 'loading',
        ...(variant === 'empty' ? { proposals: [] } : {}),
        expectedFailures: variant === 'error' ? [{ path: listPath, code: 503 }] : [],
        setup: state => {
            if (variant === 'loading') release = state.hold(listPath);
            if (variant === 'error') state.responses.set(listPath, [{ code: 503, body: { error: 'unavailable' } }]);
            if (variant === 'invalid') state.responses.set(listPath, [{ body: { authenticated: true,
                proposals: [fixtureProposal({ canSupport: 'yes' })], nextCursor: null, threshold: 30 } }]);
        } });
    if (variant === 'loading') {
        await page.locator('#proposals-list-status').getByText('Loading proposals...', { exact: true }).waitFor();
        await screenshot(page, 'loading');
        release();
        await ready(page);
    } else if (variant === 'empty') {
        await page.getByText('No Topic proposals yet.', { exact: true }).waitFor();
        await screenshot(page, 'empty');
    } else {
        await page.getByRole('button', { name: 'Retry proposals', exact: true }).waitFor();
        await screenshot(page, `list-${variant}`);
        await page.getByRole('button', { name: 'Retry proposals', exact: true }).click();
        await row(page).waitFor();
    }
    assert.deepEqual(writes(state), []);
});

for (const [code, status, text, recovery] of [
    ['verified_email_required', 409, /verified email/, 'Verify GitHub email'],
    ['legal_acceptance_required', 409, /updated Terms/, 'Privacy & account choices'],
    ['topic_proposal_exists', 409, /proposal already uses/, null],
    ['topic_creation_limit', 429, /proposal limit/, null]
]) test(`publish ${code} keeps the draft and truthful recovery`, async t => {
    const { page, state } = await pageFor(t, { expectedFailures: [{ path: publishPath, code: status }] });
    state.responses.set(publishPath, [{ code: status, body: { error: code } }]);
    await openDraft(page);
    await page.locator('#proposal-submit').click();
    await page.locator('#proposal-form-status').waitFor();
    assert.match(await page.locator('#proposal-form-status').innerText(), text);
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Multilingual analysis');
    assert.equal(await page.locator('#proposal-submit').isEnabled(), true);
    assert.equal(state.proposals.some(proposal => proposal.name === 'Multilingual analysis'), false);
    if (recovery) assert.equal(await page.locator('#proposal-form-status').getByRole(code === 'legal_acceptance_required' ? 'link' : 'button', { name: recovery, exact: true }).isVisible(), true);
    await screenshot(page, code);
});

test('uncertain publication retries the same payload/key and confirms only one proposal', async t => {
    const { page, state } = await pageFor(t);
    state.responses.set(publishPath, [{ commit: true, contentType: 'text/html; charset=utf-8', raw: '<html>Unconfirmed response</html>' }]);
    await openDraft(page);
    await page.locator('#proposal-submit').click();
    await page.locator('#proposal-form-status').waitFor();
    assert.match(await page.locator('#proposal-form-status').innerText(), /Could not confirm publication/);
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#proposals-feedback').isVisible(), false);
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    const [first, second] = requests(state, publishPath);
    assert.equal(first.key, second.key);
    assert.deepEqual(first.body, second.body);
    assert.equal(state.proposals.filter(proposal => proposal.name === 'Multilingual analysis').length, 1);
    assert.equal(requests(state, '/api/get_privacy_status').length, 1);
});

test('expired CSRF requires an explicit retry with newly read security state', async t => {
    const { page, state } = await pageFor(t, { expectedFailures: [{ path: publishPath, code: 403 }] });
    state.responses.set(publishPath, [{ code: 403, body: { error: 'privacy_form_expired' } }]);
    await openDraft(page);
    await page.locator('#proposal-submit').click();
    await page.locator('#proposal-form-status').waitFor();
    assert.equal(requests(state, publishPath).length, 1);
    state.csrfToken = 'local-refreshed-proposal-csrf';
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    assert.equal(requests(state, '/api/get_privacy_status').length, 2);
    const [first, second] = requests(state, publishPath);
    assert.notEqual(first.key, second.key);
    assert.equal(second.body.csrfToken, state.csrfToken);
});

test('failed support retains its count and the same write identity for an explicit retry', async t => {
    const { page, state } = await pageFor(t, { expectedFailures: [{ path: supportPath, code: 503 }] });
    state.responses.set(supportPath, [{ code: 503, body: { error: 'unavailable' } }]);
    await support(page).click();
    await row(page).locator('.tp-row-error').waitFor();
    assert.match(await row(page).textContent(), /29 \/ 30 supports/);
    assert.equal(await support(page).isEnabled(), true);
    await support(page).click();
    await row(page).getByText('In official review', { exact: true }).waitFor();
    const [first, second] = requests(state, supportPath);
    assert.equal(first.key, second.key);
    assert.deepEqual(first.body, second.body);
});

test('a malformed 200 publication is not success and retains the retry identity', async t => {
    const { page, state } = await pageFor(t);
    state.responses.set(publishPath, [{ body: fixtureProposal({ proposalID: 106, name: 'Multilingual analysis',
        description: 'Comparing model reasoning across languages.', status: 'pending', supportCount: 30,
        canSupport: false, submissionID: 90 }) }]);
    await openDraft(page);
    await page.locator('#proposal-submit').click();
    await page.locator('#proposal-form-status').waitFor();
    assert.match(await page.locator('#proposal-form-status').innerText(), /Could not confirm publication/);
    assert.equal(await page.locator('#proposals-feedback').isVisible(), false);
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await row(page, 106).count(), 0);
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    assert.equal(requests(state, publishPath)[0].key, requests(state, publishPath)[1].key);
});

test('a malformed 200 support cannot change the count or consume a successful UI outcome', async t => {
    const { page, state } = await pageFor(t);
    state.responses.set(supportPath, [{ body: fixtureProposal({ supported: true, canSupport: false, revision: '1' }) }]);
    await support(page).click();
    await row(page).locator('.tp-row-error').waitFor();
    assert.equal(await page.locator('#proposals-feedback').isVisible(), false);
    assert.match(await row(page).textContent(), /29 \/ 30 supports/);
    assert.equal(await support(page).isEnabled(), true);
    await support(page).click();
    await row(page).getByText('In official review', { exact: true }).waitFor();
    assert.equal(requests(state, supportPath)[0].key, requests(state, supportPath)[1].key);
});

test('failed account reads have an explicit retry and do not enable writes', async t => {
    const path = '/api/get_user_profile';
    const { page, state } = await pageFor(t, { expectedFailures: [{ path, code: 503 }],
        setup: state => state.responses.set(path, [{ code: 503, body: { error: 'unavailable' } }]) });
    assert.equal(await support(page).isDisabled(), true);
    await openDraft(page);
    assert.equal(await page.locator('#proposal-submit').isDisabled(), true);
    await page.locator('#proposal-cancel').click();
    await page.locator('#proposals-account-status').getByRole('button', { name: 'Retry account', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('proposals-account').hasAttribute('aria-haspopup'));
    assert.equal(await support(page).isEnabled(), true);
    assert.deepEqual(writes(state), []);
    await page.locator('#open-proposal').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Multilingual analysis');
});

test('foreign CSRF account blocks before mutation and preserves the modal draft', async t => {
    const { page, state } = await pageFor(t, { setup: state => { state.privacyUserID = '9007199254740994'; } });
    await openDraft(page);
    await page.locator('#proposal-submit').click();
    await page.locator('#proposal-form-status').waitFor();
    assert.match(await page.locator('#proposal-form-status').innerText(), /account changed/);
    assert.deepEqual(writes(state), []);
    assert.equal(await page.locator('#proposal-submit').isDisabled(), true);
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Multilingual analysis');
    assert.equal(await page.locator('#proposal-form-status').getByRole('link', { name: 'Refresh page' }).getAttribute('href'), '/topic-proposals');
});

test('late account replacement never reports a successful pending write for the wrong account', async t => {
    const { page, state } = await pageFor(t, { expectedFailures: [{ path: publishPath, code: 409 }] });
    const release = state.hold(publishPath);
    await openDraft(page);
    await page.locator('#proposal-submit').click();
    await requestCount(state, publishPath, 1);
    state.profile = { userID: '9007199254740994', userName: 'Changed local account', userProfilePictureURL: null };
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', {
        key: 'user-profile-update', newValue: JSON.stringify({ date: new Date().toISOString() })
    })));
    await page.locator('#proposals-account-status').waitFor();
    release();
    await page.locator('#proposal-form-status').waitFor();
    assert.equal(await page.locator('#proposals-feedback').isVisible(), false);
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#proposal-submit').isDisabled(), true);
    assert.equal(state.proposals.some(proposal => proposal.name === 'Multilingual analysis'), false);
});

test('header uses the real shared account center and restores focus without mutations', async t => {
    const { page, state } = await pageFor(t);
    await page.locator('#proposals-account').click();
    await page.getByRole('dialog', { name: 'Your account', exact: true }).waitFor();
    assert.equal(await page.locator('#account-dialog-name').textContent(), 'Local account');
    assert.equal(await page.getByRole('button', { name: 'Edit profile', exact: true }).isVisible(), true);
    await page.getByRole('button', { name: 'Close your account', exact: true }).click();
    assert.equal(await page.locator('#proposals-account').evaluate(button => button === document.activeElement), true);
    assert.deepEqual(writes(state), []);
});

for (const engine of ['chromium', 'webkit']) for (const viewport of [
    { width: 1440, height: 1000 }, { width: 390, height: 844 }
]) test(`${engine} ${viewport.width}px: cancel, edit/reset, withdraw and publish refresh quotas without losing a separate draft`, async t => {
    const { page, state } = await pageFor(t, { engine, viewport, setup: state => {
        makeCollecting(state);
        state.voters.set(103, new Set([PROPOSAL_OWNER]));
        state.proposals.push(fixtureProposal({ proposalID: 99, name: 'Expired idea', status: 'expired', supportCount: 2, canSupport: false }),
            fixtureProposal({ proposalID: 98, name: 'Withdrawn idea', status: 'withdrawn', supportCount: 0, canSupport: false }));
    } });
    const expiry = state.proposals.find(proposal => proposal.proposalID === 105).expiresAt;
    await quotaIs(page, 1, 1);
    assert.match(await page.locator('.tp-rules').innerText(), /3 active supports[\s\S]*1 collecting proposal[\s\S]*14 days/);
    assert.equal(await support(page, 99).isDisabled(), true);
    assert.equal(await row(page, 98).count(), 0);
    assert.equal(await support(page, 102).isDisabled(), true);
    assert.equal(await row(page, 99).getByText('Expired', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Withdrawn idea', { exact: true }).count(), 0);
    await openDraft(page, 'Independent draft', 'A draft kept while managing another proposal.');
    assert.equal(await page.locator('#proposal-submit').isDisabled(), true, 'One collecting proposal blocks another, not drafting');
    assert.match(await page.locator('#proposal-form-status').innerText(), /already have a collecting proposal/);
    await page.locator('#proposal-cancel').click();
    await support(page, 103).click();
    await quotaIs(page, 0, 1);
    assert.deepEqual(requests(state, cancelPath)[0].body, { proposalID: 103, revision: 1, csrfToken: state.csrfToken, expectedUserID: PROPOSAL_OWNER });
    assert.match(await row(page, 103).textContent(), /11 \/ 30 supports/);
    await support(page, 104).click();
    await row(page, 104).getByText('In official review', { exact: true }).waitFor();
    await quotaIs(page, 0, 1);
    assert.equal(await support(page, 104).isDisabled(), true, 'Review locks support but releases its active place');
    await ownerAction(page, 'edit').click();
    assert.match(await page.locator('#proposal-edit-notice').textContent(), /resets all supports[\s\S]*deadline stays/);
    await page.locator('#proposal-name').fill('Document evidence analysis');
    await page.locator('#proposal-description').fill('Comparing evidence and reasoning across documents.');
    const releaseEdit = state.hold(editPath);
    await page.locator('#proposal-submit').click();
    await requestCount(state, editPath, 1);
    assert.equal(await page.locator('#proposal-cancel').isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.locator('#proposal-form').evaluate(form => form.requestSubmit());
    assert.equal(requests(state, editPath).length, 1);
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), true);
    releaseEdit();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    await quotaIs(page, 0, 1);
    assert.equal(await row(page, 105).getAttribute('data-revision'), '2');
    assert.match(await row(page, 105).textContent(), /0 \/ 30 supports/);
    assert.equal(await row(page, 105).locator('time').getAttribute('datetime'), expiry);
    assert.equal(state.proposals.find(proposal => proposal.proposalID === 105).expiresAt, expiry);
    assert.equal(requests(state, editPath)[0].body.revision, 1);
    await assertLayout(page);
    await screenshot(page, `${engine}-${viewport.width}-edited-reset`);
    await ownerAction(page, 'withdraw').click();
    for (let index = 0; index < 5; index++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#proposal-withdraw-dialog').evaluate(dialog => dialog.contains(document.activeElement)), true);
    }
    await page.locator('#proposal-withdraw-cancel').click();
    assert.equal(requests(state, withdrawPath).length, 0);
    await ownerAction(page, 'withdraw').click();
    await screenshot(page, `${engine}-${viewport.width}-withdraw-confirm`, false);
    const releaseWithdraw = state.hold(withdrawPath);
    await page.locator('#proposal-withdraw-confirm').click();
    await requestCount(state, withdrawPath, 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#proposal-withdraw-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#proposal-withdraw-cancel').isDisabled(), true);
    releaseWithdraw();
    await page.waitForFunction(() => !document.getElementById('proposal-withdraw-dialog').open);
    await quotaIs(page, 0, 0);
    assert.equal(await row(page, 105).count(), 0);
    assert.equal(await ownerAction(page, 'edit').count(), 0);
    assert.deepEqual(requests(state, withdrawPath)[0].body, { proposalID: 105, revision: 2, csrfToken: state.csrfToken, expectedUserID: PROPOSAL_OWNER });
    await page.locator('#open-proposal').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Independent draft');
    assert.equal(await page.locator('#proposal-description').inputValue(), 'A draft kept while managing another proposal.');
    assert.equal(await page.locator('#proposal-submit').isEnabled(), true);
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    await quotaIs(page, 0, 1);
    const published = state.proposals.find(proposal => proposal.name === 'Independent draft');
    assert.ok(Math.abs(Date.parse(published.expiresAt) - Date.now() - 14 * 86400000) < 5000);
    assert.ok(requests(state, listPath).length >= 6, 'Every mutation refreshes list and account quota');
});

for (const engine of ['chromium', 'webkit']) for (const viewport of [
    { width: 1440, height: 1000 }, { width: 390, height: 844 }
]) test(`${engine} ${viewport.width}px: three-support quota requires explicit cancellation before moving support`, async t => {
    const proposals = Array.from({ length: 6 }, (_, index) => fixtureProposal({ proposalID: 210 - index, name: `Support area ${index}`, supportCount: 2 }));
    const { page, state } = await pageFor(t, { engine, viewport, proposals, setup: state => {
        state.authors.clear();
        for (const id of [210, 209, 208]) state.voters.set(id, new Set([PROPOSAL_OWNER]));
    } });
    await quotaIs(page, 3, 0);
    assert.equal(await support(page, 207).isDisabled(), true);
    assert.equal(await support(page, 210).isEnabled(), true);
    assert.match(await page.locator('#proposals-quota-note').textContent(), /Cancel a collecting support/);
    await support(page, 207).evaluate(button => button.dispatchEvent(new Event('click', { bubbles: true })));
    assert.deepEqual(writes(state), [], 'Synthetic clicks cannot bypass the displayed limit');
    await screenshot(page, `${engine}-${viewport.width}-support-limit`);
    await support(page, 210).click();
    await quotaIs(page, 2, 0);
    assert.equal(await support(page, 207).isEnabled(), true);
    assert.equal(requests(state, supportPath).length, 0, 'Canceling never automatically supports another proposal');
    await support(page, 207).click();
    await quotaIs(page, 3, 0);
    assert.equal(await support(page, 210).isDisabled(), true);
    assert.equal(await support(page, 207).isEnabled(), true, 'The replacement support can be canceled');
    assert.equal(requests(state, supportPath).length, 1);
    await assertLayout(page);
});

for (const engine of ['chromium', 'webkit']) test(`${engine}: stale vote refreshes text and requires a fresh explicit vote with a new revision`, async t => {
    const { page, state } = await pageFor(t, { engine, viewport: { width: 390, height: 844 },
        expectedFailures: [{ path: supportPath, code: 409 }] });
    Object.assign(state.proposals.find(proposal => proposal.proposalID === 104), {
        name: 'Revised clinical reasoning', description: 'The revised collection scope.', revision: 2, supportCount: 0
    });
    await support(page).click();
    await row(page).getByRole('heading', { name: 'Revised clinical reasoning', exact: true }).waitFor();
    await ready(page);
    assert.match(await row(page).locator('.tp-row-error').textContent(), /proposal changed/);
    assert.equal(await page.locator('#proposals-feedback').isVisible(), false);
    assert.equal(requests(state, supportPath).length, 1);
    assert.equal(requests(state, supportPath)[0].body.revision, 1);
    assert.match(await row(page).textContent(), /0 \/ 30 supports/);
    await screenshot(page, `${engine}-revision-conflict`);
    await support(page).click();
    await quotaIs(page, 1, 0);
    const [oldIntent, newIntent] = requests(state, supportPath);
    assert.equal(newIntent.body.revision, 2);
    assert.notEqual(oldIntent.key, newIntent.key);
});

for (const engine of ['chromium', 'webkit']) test(`${engine}: conflicting edit keeps its draft and requires review of the latest version before saving`, async t => {
    const { page, state } = await pageFor(t, { engine, viewport: { width: 390, height: 844 }, setup: makeCollecting,
        expectedFailures: [{ path: editPath, code: 409 }] });
    await ownerAction(page, 'edit').click();
    await page.locator('#proposal-description').fill('My unsaved revised summary.');
    Object.assign(state.proposals.find(proposal => proposal.proposalID === 105), {
        name: 'Changed in another tab', description: 'The other tab summary.', revision: 2, supportCount: 0
    });
    await page.locator('#proposal-submit').click();
    await page.locator('#proposal-form-status').getByRole('button', { name: 'Review latest version', exact: true }).waitFor();
    await ready(page);
    assert.equal(await page.locator('#proposal-submit').isDisabled(), true);
    assert.equal(await page.locator('#proposal-description').inputValue(), 'My unsaved revised summary.');
    await page.locator('#proposal-form').evaluate(form => form.requestSubmit());
    assert.equal(requests(state, editPath).length, 1);
    await page.locator('#proposal-form-status').getByRole('button', { name: 'Review latest version', exact: true }).click();
    await page.locator('#proposal-latest-version').waitFor();
    assert.match(await page.locator('#proposal-latest-version').textContent(), /Changed in another tab[\s\S]*The other tab summary/);
    assert.equal(await page.locator('#proposal-description').inputValue(), 'My unsaved revised summary.');
    assert.equal(await page.locator('#proposal-submit').isEnabled(), true);
    await assertLayout(page, true);
    await screenshot(page, `${engine}-edit-conflict-recovery`, false);
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    await quotaIs(page, 0, 1);
    assert.equal(requests(state, editPath)[1].body.revision, 2);
    assert.notEqual(requests(state, editPath)[0].key, requests(state, editPath)[1].key);
    assert.equal(await row(page, 105).getAttribute('data-revision'), '3');
});

for (const engine of ['chromium', 'webkit']) test(`${engine}: same-key support replay returns current edited content and never reapplies the old vote`, async t => {
    const { page, state } = await pageFor(t, { engine });
    state.responses.set(supportPath, [{ commit: true, contentType: 'text/html; charset=utf-8', raw: '<html>Unconfirmed</html>' }]);
    await support(page).click();
    await row(page).locator('.tp-row-error').waitFor();
    const proposal = state.proposals.find(proposal => proposal.proposalID === 104);
    Object.assign(proposal, { status: 'open', submissionID: null, revision: 2, name: 'New clinical scope', supportCount: 0 });
    state.voters.delete(104);
    await support(page).click();
    await row(page).getByRole('heading', { name: 'New clinical scope', exact: true }).waitFor();
    await ready(page);
    assert.equal(await page.locator('#proposals-feedback').isVisible(), false);
    assert.match(await row(page).locator('.tp-row-error').textContent(), /proposal changed/);
    assert.equal(requests(state, supportPath).length, 2);
    assert.equal(requests(state, supportPath)[0].key, requests(state, supportPath)[1].key);
    assert.equal(state.voters.has(104), false);
    await support(page).click();
    await quotaIs(page, 1, 0);
    assert.equal(proposal.supportCount, 1);
    assert.equal(requests(state, supportPath)[2].body.revision, 2);
    assert.notEqual(requests(state, supportPath)[2].key, requests(state, supportPath)[0].key);
});

for (const operation of ['cancel', 'edit', 'withdraw']) test(`${operation}: uncertain mutation retries the exact revision/key and commits only once`, async t => {
    const path = operation === 'cancel' ? cancelPath : operation === 'edit' ? editPath : withdrawPath;
    const { page, state } = await pageFor(t, { setup: state => {
        makeCollecting(state);
        state.voters.set(103, new Set([PROPOSAL_OWNER]));
    } });
    state.responses.set(path, [{ commit: true, contentType: 'text/html; charset=utf-8', raw: '<html>Unconfirmed</html>' }]);
    const click = async () => {
        if (operation === 'cancel') await support(page, 103).click();
        else await page.locator(operation === 'edit' ? '#proposal-submit' : '#proposal-withdraw-confirm').click();
    };
    if (operation === 'edit') {
        await ownerAction(page, 'edit').click();
        await page.locator('#proposal-description').fill('An updated summary for this proposal.');
    } else if (operation === 'withdraw') await ownerAction(page, 'withdraw').click();
    await click();
    await page.locator(operation === 'edit' ? '#proposal-form-status' : operation === 'withdraw' ? '#proposal-withdraw-status' : '#proposal-103 .tp-row-error').waitFor();
    assert.equal(await page.locator('#proposals-feedback').isVisible(), false);
    await click();
    await quotaIs(page, operation === 'cancel' ? 0 : 1, operation === 'withdraw' ? 0 : 1);
    assert.equal(requests(state, path).length, 2);
    assert.equal(requests(state, path)[0].key, requests(state, path)[1].key);
    assert.deepEqual(requests(state, path)[0].body, requests(state, path)[1].body);
    assert.equal(requests(state, path)[0].body.revision, 1);
    const changed = state.proposals.find(proposal => proposal.proposalID === (operation === 'cancel' ? 103 : 105));
    if (operation === 'withdraw') assert.equal(changed, undefined);
    else {
        assert.equal(changed.supportCount, operation === 'edit' ? 0 : 11);
        assert.equal(changed.revision, operation === 'edit' ? 2 : 1);
    }
});

for (const engine of ['chromium', 'webkit']) test(`${engine}: refreshing a mutation keeps loaded pages, visible row position, focus and draft`, async t => {
    const proposals = Array.from({ length: 65 }, (_, index) => fixtureProposal({ proposalID: 200 - index,
        name: `Paginated reasoning ${index}`, supportCount: 2 }));
    const { page, state } = await pageFor(t, { engine, viewport: { width: 390, height: 844 }, proposals });
    await openDraft(page, 'Kept pagination draft', 'A draft independent of support changes.');
    await page.locator('#proposal-cancel').click();
    await page.locator('#proposals-load-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.tp-row').length === 60);
    await row(page, 150).evaluate(row => row.scrollIntoView({ block: 'center' }));
    const top = await row(page, 150).evaluate(row => row.getBoundingClientRect().top);
    await support(page, 150).click();
    await quotaIs(page, 1, 0);
    assert.equal(await page.locator('.tp-row').count(), 60);
    assert.ok(Math.abs(await row(page, 150).evaluate(row => row.getBoundingClientRect().top) - top) <= 2, 'Visible row stays anchored');
    assert.equal(await row(page, 150).evaluate(row => row.contains(document.activeElement)), true);
    assert.deepEqual(requests(state, listPath).slice(-2).map(request => request.body), [{ view: 'all' }, { view: 'all', before: 171 }]);
    await screenshot(page, `${engine}-pagination-anchor`, false);
    await page.locator('#open-proposal').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Kept pagination draft');
});

for (const engine of ['chromium', 'webkit']) test(`${engine}: a visible proposal expires at its deadline and refreshes the freed support place`, async t => {
    const deadline = new Date(Date.now() + 4000).toISOString();
    const { page, state } = await pageFor(t, { engine, viewport: { width: 390, height: 844 },
        proposals: [fixtureProposal({ expiresAt: deadline, supportCount: 2 })], setup: state => {
            state.voters.set(104, new Set([PROPOSAL_OWNER]));
        } });
    await quotaIs(page, 1, 0);
    const release = state.hold(listPath);
    await row(page).getByText('Expired', { exact: true }).waitFor();
    assert.equal(await support(page).isDisabled(), true);
    assert.equal(await row(page).locator('time').getAttribute('datetime'), deadline);
    assert.deepEqual(writes(state), []);
    release();
    await quotaIs(page, 0, 0);
    await screenshot(page, `${engine}-deadline-expired`);
});

test('a failed success refresh keeps confirmed rows and draft but blocks writes until quotas are re-read', async t => {
    const { page, state } = await pageFor(t, { expectedFailures: [{ path: listPath, code: 503 }] });
    await openDraft(page);
    await page.locator('#proposal-cancel').click();
    state.responses.set(listPath, [{ code: 503, body: { error: 'unavailable' } }]);
    await support(page, 103).click();
    await page.locator('#proposals-page-error').waitFor();
    assert.match(await page.locator('#proposals-feedback').textContent(), /Support recorded/);
    assert.match(await row(page, 103).textContent(), /13 \/ 30 supports/);
    assert.equal(await support(page, 104).isDisabled(), true);
    await page.locator('#proposals-load-more').click();
    await quotaIs(page, 1, 0);
    assert.equal(await support(page, 104).isEnabled(), true);
    await page.locator('#open-proposal').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Multilingual analysis');
});

for (const [code, status, text] of [
    ['topic_proposal_support_limit', 409, /All 3 active supports/],
    ['topic_proposal_revision_required', 400, /version could not be confirmed/],
    ['topic_proposal_expired', 409, /14-day collection period/]
]) test(`${code}: actionable row recovery refreshes reads and never automatically repeats a mutation`, async t => {
    const { page, state } = await pageFor(t, { expectedFailures: [{ path: supportPath, code: status }] });
    state.responses.set(supportPath, [{ code: status, body: { error: code } }]);
    await support(page).click();
    await row(page).locator('.tp-row-error').waitFor();
    await ready(page);
    assert.match(await row(page).locator('.tp-row-error').textContent(), text);
    await row(page).getByRole('button', { name: 'Refresh hall', exact: true }).click();
    await ready(page);
    assert.equal(requests(state, supportPath).length, 1);
    assert.equal(await page.locator('#proposals-feedback').isVisible(), false);
});

for (const engine of ['chromium', 'webkit']) for (const viewport of [
    { width: 1440, height: 1000 }, { width: 320, height: 568 }
]) test(`${engine} ${viewport.width}px: off-page activeProposal can be edited and withdrawn without pagination or a duplicate row`, async t => {
    const proposals = Array.from({ length: 65 }, (_, index) => fixtureProposal({ proposalID: 200 - index,
        name: `Newer proposal ${index}`, supportCount: 2 }));
    proposals.push(fixtureProposal({ proposalID: 5, name: 'My older proposal', supportCount: 9 }));
    const { page, state } = await pageFor(t, { engine, viewport, proposals, setup: state => {
        state.authors.clear();
        state.authors.set(5, PROPOSAL_OWNER);
    } });
    await quotaIs(page, 0, 1);
    assert.equal(await page.locator('.tp-row').count(), 30);
    assert.equal(await row(page, 5).count(), 0);
    await page.locator('#proposals-find-own').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'My older proposal');
    assert.equal(requests(state, listPath).length, 1, 'Opening management uses activeProposal, not cursor requests');
    await page.locator('#proposal-description').fill('Revised while the proposal is outside the loaded page.');
    await assertLayout(page, true);
    await screenshot(page, `${engine}-${viewport.width}-off-page-edit`, false);
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    await quotaIs(page, 0, 1);
    assert.equal(await page.locator('.tp-row').count(), 30);
    assert.equal(await row(page, 5).count(), 0);
    assert.equal(requests(state, editPath)[0].body.proposalID, 5);
    assert.equal(state.proposals.find(proposal => proposal.proposalID === 5).supportCount, 0);
    await page.locator('#proposals-find-own').click();
    await page.locator('#proposal-editor-withdraw').click();
    assert.equal(await page.locator('#proposal-dialog').evaluate(dialog => dialog.open), false);
    await page.locator('#proposal-withdraw-confirm').click();
    await quotaIs(page, 0, 0);
    assert.equal(await page.locator('#proposals-find-own').isVisible(), false);
    assert.equal(state.proposals.some(proposal => proposal.proposalID === 5), false);
    assert.equal(requests(state, withdrawPath)[0].body.revision, 2);
    assert.equal(requests(state, listPath).every(request => !Object.hasOwn(request.body, 'before')), true);
    assert.equal(await page.locator('.tp-row').count(), 30);
});

test('no-op edits preserve supports, revision and expiry rather than claiming votes were reset', async t => {
    const { page, state } = await pageFor(t, { setup: makeCollecting });
    const original = structuredClone(state.proposals.find(proposal => proposal.proposalID === 105));
    await ownerAction(page, 'edit').click();
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    await quotaIs(page, 0, 1);
    assert.match(await page.locator('#proposals-feedback').textContent(), /Proposal unchanged[\s\S]*supports and the deadline are kept/);
    assert.equal(await row(page, 105).getAttribute('data-revision'), String(original.revision));
    assert.equal(state.proposals.find(proposal => proposal.proposalID === 105).supportCount, 12);
    assert.equal(await row(page, 105).locator('time').getAttribute('datetime'), original.expiresAt);
});

test('a newly consumed proposal place refreshes the quota, retains the create draft, and offers direct management', async t => {
    const { page, state } = await pageFor(t, { expectedFailures: [{ path: publishPath, code: 409 }] });
    await openDraft(page);
    makeCollecting(state);
    await page.locator('#proposal-submit').click();
    await page.locator('#proposal-form-status').waitFor();
    await ready(page);
    assert.equal(await page.locator('#proposal-submit').isDisabled(), true);
    assert.match(await page.locator('#proposal-form-status').textContent(), /already have a collecting proposal/);
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Multilingual analysis');
    assert.equal(requests(state, publishPath).length, 1);
    await page.locator('#proposal-cancel').click();
    await page.locator('#proposals-find-own').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Long-context document analysis');
    assert.equal(requests(state, publishPath).length, 1);
});

for (const operation of ['cancel', 'edit', 'withdraw']) test(`${operation}: foreign security identity blocks before any mutation and preserves drafts`, async t => {
    const { page, state } = await pageFor(t, { setup: state => {
        makeCollecting(state);
        state.voters.set(103, new Set([PROPOSAL_OWNER]));
        state.privacyUserID = '9007199254740994';
    } });
    if (operation === 'cancel') {
        await support(page, 103).click();
        await row(page, 103).locator('.tp-row-error').waitFor();
    } else if (operation === 'edit') {
        await ownerAction(page, 'edit').click();
        await page.locator('#proposal-description').fill('A protected draft for my proposal.');
        await page.locator('#proposal-submit').click();
        await page.locator('#proposal-form-status').waitFor();
        assert.equal(await page.locator('#proposal-description').inputValue(), 'A protected draft for my proposal.');
    } else {
        await ownerAction(page, 'withdraw').click();
        await page.locator('#proposal-withdraw-confirm').click();
        await page.locator('#proposal-withdraw-status').waitFor();
    }
    assert.deepEqual(writes(state), []);
    assert.match(await page.locator('#proposals-account-status').textContent(), /account changed/);
});

test('editing a proposal after ownership loss shows bounded author-only recovery and never changes its text', async t => {
    const { page, state } = await pageFor(t, { setup: makeCollecting, expectedFailures: [{ path: editPath, code: 403 }] });
    await ownerAction(page, 'edit').click();
    await page.locator('#proposal-description').fill('A local draft to retain.');
    state.authors.set(105, '9007199254740994');
    await page.locator('#proposal-submit').click();
    await page.locator('#proposal-form-status').waitFor();
    await ready(page);
    assert.equal(requests(state, editPath).length, 1);
    assert.equal(await page.locator('#proposal-submit').isDisabled(), true);
    assert.equal(await page.locator('#proposal-description').inputValue(), 'A local draft to retain.');
    assert.notEqual(state.proposals.find(proposal => proposal.proposalID === 105).description, 'A local draft to retain.');
});

test('separate create/edit drafts survive storage failure and switching dialogs without any implicit writes', async t => {
    const { page, state } = await pageFor(t, { blockedStorage: true, setup: makeCollecting });
    await openDraft(page, 'In-memory create draft', 'Creation text retained without session storage.');
    await page.locator('#proposal-cancel').click();
    await ownerAction(page, 'edit').click();
    await page.locator('#proposal-description').fill('An in-memory edit draft, kept separately.');
    await page.locator('#proposal-cancel').click();
    await page.locator('#open-proposal').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'In-memory create draft');
    assert.equal(await page.locator('#proposal-description').inputValue(), 'Creation text retained without session storage.');
    await page.locator('#proposal-cancel').click();
    await ownerAction(page, 'edit').click();
    assert.equal(await page.locator('#proposal-description').inputValue(), 'An in-memory edit draft, kept separately.');
    assert.deepEqual(writes(state), []);
});
