import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const dialog = fs.readFileSync(new URL('../public/js/dialogPage.js', import.meta.url), 'utf8');

test('GitHub OAuth uses the canonical form-encoded token exchange', () => {
    const callback = server.slice(
        server.indexOf("page.get('/github_callback'"),
        server.indexOf('async function ensureAuthenticated')
    );

    assert.match(callback, /const tokenRequest = new URLSearchParams\(/);
    assert.match(callback, /'Content-Type': 'application\/x-www-form-urlencoded'/);
    assert.match(callback, /body: tokenRequest/);
    assert.doesNotMatch(callback, /body: JSON\.stringify\(\{\s*client_id:/);
});

test('GitHub OAuth entry and callback responses are never cached', () => {
    const login = server.slice(
        server.indexOf("page.get('/github_login'"),
        server.indexOf("page.get('/github_callback'")
    );
    const callback = server.slice(
        server.indexOf("page.get('/github_callback'"),
        server.indexOf("API.post('/logout'")
    );

    assert.match(login, /res\.set\('Cache-Control', 'no-store'\)/);
    assert.match(callback, /res\.set\('Cache-Control', 'no-store'\)/);
});

test('GitHub API requests pin a version and retain safe upstream status diagnostics', () => {
    assert.match(server, /const githubAPIVersion = '2022-11-28'/);
    assert.ok((server.match(/'X-GitHub-Api-Version': githubAPIVersion/g) ?? []).length >= 2);
    assert.match(server, /error: 'github_profile_failed',[\s\S]*upstreamStatus: userResponse\.status/);
    assert.match(server, /'github_email_failed',[\s\S]*upstreamStatus: response\.status/);
});

test('OAuth callback errors are diagnosable without logging callback secrets', () => {
    const errorHandler = server.slice(server.lastIndexOf('app.use((err, req, res, next)'), server.length);

    assert.match(dialog, /G\.params\.get\('error'\)/);
    assert.match(dialog, /Diagnostic code:/);
    assert.match(errorHandler, /req\.path/);
    assert.doesNotMatch(errorHandler, /console\.error\([^;]*req\.originalUrl/);
});
