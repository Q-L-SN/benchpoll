import assert from 'node:assert/strict';
import https from 'node:https';

const origin = 'https://127.0.0.1:1337';
const checks = [];
let cookie = '';
function request(path, { method = 'GET', body, foreign = false } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = https.request(origin + path, { method, rejectUnauthorized: false, timeout: 15000,
            headers: { Host: 'benchpoll.com', Origin: foreign ? 'https://foreign.example.test' : 'https://benchpoll.com',
                ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text,
                json: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }));
        });
        req.on('timeout', () => req.destroy(new Error('Origin verification timeout')));
        req.on('error', reject);
        req.end(data);
    });
}
function policy(response) {
    const value = response.headers['content-security-policy'];
    assert.ok(value?.includes("script-src 'self'"));
    assert.ok(value.includes("script-src-attr 'none'"));
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

for (const path of ['/Intelligence', '/privacy', '/terms', '/cookies', '/community-guidelines', '/account/privacy']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.text, /BenchPoll/);
    assert.equal(response.headers['set-cookie'], undefined, 'Unrequested browsing must not create a session cookie');
    policy(response);
    if (path === '/privacy' || path === '/terms') {
        const version = '2026-10-18';
        assert.ok(response.text.includes(`datetime="${version}"`));
        assert.match(response.text, /\/account\/privacy#request/);
        assert.match(response.text, /mailto:privacy@benchpoll\.com/);
        assert.match(response.text, /mailto:support@benchpoll\.com/);
    }
    checks.push(`GET ${path}`);
}
const publicInfo = await request('/api/privacy_information');
assert.equal(publicInfo.status, 200);
assert.equal(publicInfo.json.operator.email, 'privacy@benchpoll.com');
assert.equal(publicInfo.json.operator.identityPending, true);
assert.equal(publicInfo.headers['set-cookie'], undefined);
checks.push('Public metadata has owner-confirmed privacy email, no invented legal identity');

const status = await request('/api/get_privacy_status', { method: 'POST', body: {} });
assert.equal(status.status, 200);
assert.equal(status.json.authenticated, false);
assert.equal(status.json.userID, null);
assert.equal(status.json.accepted, false);
assert.equal(status.json.privateCategoryResearch, false);
assert.equal(status.json.isSenior, false);
assert.match(status.json.csrfToken, /^[a-zA-Z0-9_-]{43}$/);
assert.match(status.headers['cache-control'], /no-store/);
cookie = status.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') ?? '';
assert.ok(cookie.startsWith('sid='));
assert.ok(status.headers['set-cookie'].every(value => /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value)));
checks.push('Anonymous privacy form has a protected session, no inferred consent');
const csrfToken = status.json.csrfToken;
const versions = { termsVersion: status.json.versions.terms, privacyVersion: status.json.versions.privacy };
for (const [name, body, expected, foreign] of [
    ['submit_privacy_request', { email: 'invalid', requestType: 'access', message: 'Synthetic validation only' }, 403, false],
    ['submit_privacy_request', { csrfToken, email: 'invalid', requestType: 'access', message: 'Synthetic validation only' }, 400, false],
    ['submit_privacy_request', { csrfToken }, 403, true],
    ['accept_legal_terms', { csrfToken, ...versions, acceptedTerms: true, eligibleAge: true, privateCategoryResearch: false }, 401, false],
    ['save_privacy_preferences', { csrfToken, privateCategoryResearch: true }, 401, false],
    ['list_privacy_requests', { csrfToken }, 401, false],
    ['update_privacy_request', { csrfToken }, 401, false],
    ['prepare_github_login', { csrfToken, ...versions, acceptedTerms: false, eligibleAge: true, privateCategoryResearch: false }, 400, false],
    ['prepare_github_login', { csrfToken, ...versions, termsVersion: 'old', acceptedTerms: true, eligibleAge: true, privateCategoryResearch: false }, 409, false]
]) {
    const result = await request('/api/' + name, { method: 'POST', body, foreign });
    assert.equal(result.status, expected, name);
    policy(result);
    checks.push(`${name} rejects invalid/unauthorized input (${expected})`);
}
const prepared = await request('/api/prepare_github_login', { method: 'POST', body: {
    csrfToken, ...versions, acceptedTerms: true, eligibleAge: true, privateCategoryResearch: false
} });
assert.equal(prepared.status, 200);
const target = new URL(prepared.json.url);
assert.equal(target.origin, 'https://github.com');
assert.equal(target.pathname, '/login/oauth/authorize');
assert.equal(target.searchParams.get('scope'), 'user:email');
assert.equal(target.searchParams.get('redirect_uri'), 'https://benchpoll.com/github_callback');
assert.ok(target.searchParams.get('state'));
checks.push('Prepared login has bound OAuth state; provider not contacted');
const legacy = await request('/github_login');
assert.equal(legacy.status, 302);
assert.equal(legacy.headers.location, '/account/privacy?login=1');
checks.push('Login starts at explicit choices');
const css = await request('/css/account-privacy.css', { method: 'HEAD' });
assert.equal(css.status, 200);
policy(css);
checks.push('Static assets receive the same privacy headers');

console.log(JSON.stringify({ passed: checks.length, checks, realAccountActions: 0,
    privacyRequestsCreated: 0, notificationsSent: 0, providerCalls: 0 }));
