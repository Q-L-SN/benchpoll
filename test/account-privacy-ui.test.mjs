import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePrivacyStatus, consentPayload, safeGitHubAuthorizationURL,
    validPrivacyEmail, privacyRequestPayload, normalizePrivacyQueue, privacyRequestUpdatePayload } from '../public/js/account-privacy.js';
import { LEGAL_VERSIONS, privacyEmail, normalizePrivacyRequest, publicPrivacyOperator,
    ensurePrivacyCSRF, assertPrivacyCSRF, validateLegalChoice } from '../privacy-controls.js';

const status = overrides => ({ userID: null, authenticated: false, isSenior: false, accepted: false,
    privateCategoryResearch: false, csrfToken: 'csrf-test', versions: { ...LEGAL_VERSIONS },
    operator: { displayName: 'BenchPoll operator', email: null, identityPending: true }, ...overrides });

test('status validates exact string identity, senior scope, CSRF and supported legal versions', () => {
    assert.equal(normalizePrivacyStatus(status()).userID, null);
    const member = normalizePrivacyStatus(status({ authenticated: true, userID: '9007199254740993', isSenior: true }));
    assert.equal(member.userID, '9007199254740993');
    assert.equal(member.isSenior, true);
    for (const invalid of [status({ authenticated: true, userID: 7 }), status({ authenticated: true, userID: '07' }),
        status({ userID: '7' }), status({ csrfToken: '' }), status({ isSenior: true }), status({ isSenior: undefined }),
        status({ privateCategoryResearch: true })]) {
        assert.throws(() => normalizePrivacyStatus(invalid), /invalid_privacy_status/);
    }
    assert.throws(() => normalizePrivacyStatus(status({ versions: { ...LEGAL_VERSIONS, terms: '2027-01-01' } })), /unsupported_legal_version/);
    for (const document of ['terms', 'privacy']) {
        assert.throws(() => normalizePrivacyStatus(status({ versions: { ...LEGAL_VERSIONS, [document]: '2026-10-17' } })), /unsupported_legal_version/);
    }
});

test('operator identity is pending by default and never invents an active email address', () => {
    assert.deepEqual(normalizePrivacyStatus(status()).operator, { displayName: 'BenchPoll operator', email: null, identityPending: true });
    assert.equal(normalizePrivacyStatus(status({ operator: {} })).operator.identityPending, true);
    assert.equal(normalizePrivacyStatus(status({ operator: { displayName: 'Configured name', identityPending: false, email: 'invalid' } })).operator.email, null);
    assert.equal(normalizePrivacyStatus(status({ operator: { identityPending: false } })).operator.identityPending, false);
});

test('explicit legal and age confirmations never send a research choice', () => {
    const choices = { acceptedTerms: true, eligibleAge: true };
    assert.deepEqual(consentPayload(status(), choices), { csrfToken: 'csrf-test', termsVersion: LEGAL_VERSIONS.terms,
        privacyVersion: LEGAL_VERSIONS.privacy, acceptedTerms: true, eligibleAge: true });
    for (const name of ['acceptedTerms', 'eligibleAge']) {
        for (const value of [false, undefined, 'true', 1]) assert.throws(() => consentPayload(status(), { ...choices, [name]: value }));
    }
    assert.equal(Object.hasOwn(consentPayload(status(), { ...choices, privateCategoryResearch: true }), 'privateCategoryResearch'), false);
});

test('OAuth allows only the exact HTTPS GitHub authorization endpoint', () => {
    const safe = 'https://github.com/login/oauth/authorize?client_id=abc&state=xyz';
    assert.equal(safeGitHubAuthorizationURL(safe), safe);
    for (const unsafe of [undefined, {}, 'javascript:alert(1)', '//github.com/login/oauth/authorize', '/account/privacy',
        'http://github.com/login/oauth/authorize', 'https://github.com.evil.test/login/oauth/authorize',
        'https://evil.test/?next=https://github.com/login/oauth/authorize', 'https://github.com@evil.test/login/oauth/authorize',
        'https://user:pass@github.com/login/oauth/authorize', 'https://github.com:8443/login/oauth/authorize',
        'https://github.com/login/oauth/access_token', 'https://github.com/login/oauth/authorize/extra',
        'https://github.com/login/oauth/authorize#fragment']) assert.throws(() => safeGitHubAuthorizationURL(unsafe), /unsafe_provider_redirect/);
});

test('email validation is minimal, capped at 254 and requires a dotted domain', () => {
    for (const email of ['a+b@example.test', 'name@sub.example.test', `${'a'.repeat(241)}@example.test`]) assert.equal(validPrivacyEmail(email), true, email);
    for (const email of ['', 'name@localhost', '@example.test', 'a@@example.test', 'a b@example.test', 'a@example.',
        `${'a'.repeat(242)}@example.test`]) assert.equal(validPrivacyEmail(email), false, email);
});

test('client fields align with the parent implementation without using its database', () => {
    assert.deepEqual(normalizePrivacyStatus(status()).versions, LEGAL_VERSIONS);
    assert.deepEqual(normalizePrivacyStatus(status()).operator, publicPrivacyOperator({}));
    const session = {};
    const csrfToken = ensurePrivacyCSRF(session);
    const normalized = normalizePrivacyStatus(status({ csrfToken }));
    const legalPayload = consentPayload(normalized, { acceptedTerms: true, eligibleAge: true });
    assert.doesNotThrow(() => assertPrivacyCSRF(session, legalPayload.csrfToken));
    const legalChoice = validateLegalChoice(legalPayload, { hashes: { terms: 'a'.repeat(64), privacy: 'b'.repeat(64) } });
    assert.equal(legalChoice.privateCategoryResearch, null);
    assert.throws(() => assertPrivacyCSRF(session, 'invalid-token'));
    for (const email of ['a@example.test', 'name@localhost', 'a+b@sub.example.test', 'a@@example.test', 'a b@example.test',
        `${'a'.repeat(241)}@example.test`, `${'a'.repeat(242)}@example.test`]) {
        assert.equal(validPrivacyEmail(email), Boolean(privacyEmail(email)), email);
    }
    const input = { email: ' a@example.test ', requestType: 'access', message: ' x ' };
    assert.deepEqual(privacyRequestPayload('csrf', input), { csrfToken: 'csrf', ...normalizePrivacyRequest(input) });
    for (const message of ['', ' ', '\0', 'x'.repeat(4001)]) {
        assert.throws(() => privacyRequestPayload('csrf', { ...input, message }));
        assert.throws(() => normalizePrivacyRequest({ ...input, message }));
    }
});

test('anonymous requests contain only CSRF, contact, type and minimal request details', () => {
    const values = { email: ' a@example.test ', requestType: 'erasure', message: ' x ', expectedUserID: 'foreign', password: 'not-forwarded' };
    assert.deepEqual(privacyRequestPayload('csrf', values), { csrfToken: 'csrf', email: 'a@example.test', requestType: 'erasure', message: 'x' });
    assert.equal(values.message, ' x ', 'Validation never modifies the draft');
    assert.equal(privacyRequestPayload('csrf', { ...values, message: 'x'.repeat(4000) }).message.length, 4000);
    for (const change of [{ requestType: '__proto__' }, { requestType: 'constructor' }, { message: ' ' }, { message: 'x'.repeat(4001) }, { email: 'a@localhost' }]) {
        assert.throws(() => privacyRequestPayload('csrf', { ...values, ...change }));
    }
});

test('queue subjects remain exact strings and HTML-like content remains data', () => {
    const item = { reference: 'PR-1', userID: '9007199254740993', email: '<img>@example.test', requestType: 'access',
        message: '<img src=x onerror=alert(1)>', status: 'open', resolution: '', createdAt: '2026-10-17T00:00:00Z', dueAt: '2026-11-16T00:00:00Z' };
    const queue = normalizePrivacyQueue({ requests: [item], nextCursor: 'PR-1' });
    assert.deepEqual(queue.requests[0], item);
    assert.equal(queue.requests[0].userID, '9007199254740993');
    for (const change of [{ userID: 7 }, { status: 'constructor' }, { requestType: '__proto__' }, { dueAt: 'not a date' }, { resolution: null }]) {
        assert.throws(() => normalizePrivacyQueue({ requests: [{ ...item, ...change }], nextCursor: null }));
    }
});

test('closing requires a nonblank handling record and updates are capped at 2000 characters', () => {
    assert.deepEqual(privacyRequestUpdatePayload('csrf', 'PR-1', 'in_review', ''), { csrfToken: 'csrf', reference: 'PR-1', status: 'in_review', resolution: '' });
    assert.equal(privacyRequestUpdatePayload('csrf', 'PR-1', 'closed', 'Verified and handled.').status, 'closed');
    for (const text of ['', ' \n ']) assert.throws(() => privacyRequestUpdatePayload('csrf', 'PR-1', 'closed', text), /resolution_required_when_closed/);
    assert.throws(() => privacyRequestUpdatePayload('csrf', 'PR-1', 'closed', 'x'.repeat(2001)), /invalid_resolution/);
});

test('markup and source enforce safe form defaults and integration anchors', async () => {
    const html = await readFile(new URL('../private/account-privacy.html', import.meta.url), 'utf8');
    const js = await readFile(new URL('../public/js/account-privacy.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/css/account-privacy.css', import.meta.url), 'utf8');
    assert.match(html, /id="request"/);
    assert.match(html, /href="\/privacy#providers"/);
    assert.match(html, /href="\/privacy#operator"/);
    assert.doesNotMatch(html, /<select\b|\bchecked\s*[=>]|type="(?:password|date)"|#international|#contact/);
    assert.match(html, /href="mailto:privacy@benchpoll\.com"/);
    assert.match(html, /href="mailto:support@benchpoll\.com"/);
    assert.match(html, /at least 16 and legally eligible/);
    assert.match(html, /How your account data is handled/);
    assert.match(html, /even when you previously opted in/);
    assert.match(html, /operate, support and secure the service/);
    assert.match(html, /Past choices and any past research records are not automatically erased/);
    assert.doesNotMatch(html + js, /private-category-research|preferences-form|save_privacy_preferences/);
    assert.doesNotMatch(html, /mainland China/);
    assert.match(html, /<dt>Review by \(internal target\)<\/dt>/);
    assert.match(html, /Review dates are internal handling targets/);
    assert.doesNotMatch(html, /<dt>Due<\/dt>/);
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|location\.(?:search|hash)|URLSearchParams/);
    assert.match(js, /scope\.write\(send, '\/api\/list_privacy_requests'/);
    assert.match(js, /scope\.write\(send, '\/api\/update_privacy_request'/);
    assert.doesNotMatch(css, /border-(?:left|right|inline-start|inline-end)\s*:|linear-gradient|box-shadow/);
});

test('privacy request titles omit required badges while required controls remain enforced', async () => {
    const html = await readFile(new URL('../private/account-privacy.html', import.meta.url), 'utf8');
    assert.match(html, /<label for="request-email">Contact email<\/label>/);
    assert.match(html, /<legend>Request type<\/legend>/);
    assert.match(html, /<label for="request-message">Request details<\/label>/);
    assert.doesNotMatch(html, /<(?:span|small)\b[^>]*>\s*\(?required\)?\s*<\/(?:span|small)>/i);
    for (const ID of ['request-email', 'request-message', 'accepted-terms-check', 'eligible-age']) {
        assert.match(html, new RegExp(`<(?:input|textarea)\\b[^>]*\\bid="${ID}"[^>]*\\srequired(?:\\s|>)`));
    }
    assert.match(html, /<input\b[^>]*name="requestType"[^>]*\srequired(?:\s|>)/);
    assert.match(html, /This acknowledgment is not blanket consent to optional processing or data transfers\./);
});
