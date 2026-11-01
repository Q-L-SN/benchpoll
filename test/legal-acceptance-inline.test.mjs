import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { legalAcceptancePayload, legalAcceptanceStatus } from '../public/js/shared/legal-acceptance.js';

const status = () => ({ authenticated: true, accepted: false, userID: '9007199254740993',
    csrfToken: 'a'.repeat(43), versions: { terms: '2026-11-02', privacy: '2026-11-03', research: 'ignored' },
    privateCategoryResearch: true, marketing: true });

test('inline acceptance uses the server versions, including changes after the page loaded', () => {
    assert.deepEqual(legalAcceptanceStatus(status()), { authenticated: true, accepted: false,
        userID: '9007199254740993', csrfToken: 'a'.repeat(43), versions: { terms: '2026-11-02', privacy: '2026-11-03' } });
});

test('explicit acceptance sends only the required terms and eligibility choice', () => {
    assert.deepEqual(legalAcceptancePayload(status()), { csrfToken: 'a'.repeat(43), termsVersion: '2026-11-02',
        privacyVersion: '2026-11-03', acceptedTerms: true, eligibleAge: true });
});

for (const [description, patch] of [
    ['numeric account ID', { userID: 7 }], ['noncanonical account ID', { userID: '007' }],
    ['anonymous acceptance', { authenticated: false, userID: null, accepted: true }],
    ['unbound authenticated account', { userID: null }], ['missing CSRF', { csrfToken: '' }],
    ['missing version', { versions: { terms: '2026-11-02' } }],
    ['unsafe version text', { versions: { terms: '<img src=x>', privacy: '2026-11-03' } }],
    ['unconfirmed acceptance flag', { accepted: 1 }]
]) test(`inline acceptance rejects ${description}`, () => {
    assert.throws(() => legalAcceptanceStatus({ ...status(), ...patch }));
});

test('guests can be read but cannot produce an acceptance request', () => {
    const anonymous = { ...status(), authenticated: false, accepted: false, userID: null };
    assert.equal(legalAcceptanceStatus(anonymous).authenticated, false);
    assert.throws(() => legalAcceptancePayload(anonymous));
});

test('global integration replaces the account-page detour and transport never replays the rejected action', async () => {
    const globalSource = await readFile(new URL('../public/js/global.js', import.meta.url), 'utf8');
    const httpSource = await readFile(new URL('../public/js/shared/http.js', import.meta.url), 'utf8');
    const inlineSource = await readFile(new URL('../public/js/shared/legal-acceptance.js', import.meta.url), 'utf8');
    assert.match(globalSource, /installLegalAcceptance\(\)/);
    assert.doesNotMatch(globalSource, /review\.href = '\/account\/privacy'/);
    assert.match(httpSource, /detail: \{ expectedUserID: body\?\.expectedUserID \}/);
    assert.match(httpSource, /error\.payload = payload;\s*throw error;/);
    assert.doesNotMatch(inlineSource, /location\.(?:assign|replace|reload)|privateCategoryResearch\s*:/);
    assert.equal((inlineSource.match(/'\/api\/accept_legal_terms'/g) ?? []).length, 1);
});
