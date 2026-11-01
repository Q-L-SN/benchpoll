import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
import { normalizeUserProfile } from '../user-profile-service.js';
import { requireAccountWriteOwner } from '../public/js/shared/account-identity.js';

const root = fileURLToPath(new URL('../public', import.meta.url));
const output = resolve('D:/Codex-artifacts/website1/public-github-profile-20261027');
const owner = '9007199254740993';
const githubURL = 'https://github.com/Verified-Login';
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQSQv4DwADZgHaE5klaQAAAABJRU5ErkJggg==';
const initial = { userID: owner, userName: 'Public display name', userProfilePictureURL: avatar,
    hasCustomDisplayName: true, hasCustomAvatar: true, showGitHubProfile: false, canShowGitHubProfile: true };
const discussion = await readFile(new URL('../public/js/discussion.js', import.meta.url), 'utf8');
const authorRenderer = discussion.slice(discussion.indexOf('let currentPublicProfile = null;'), discussion.indexOf('function renderPost('));
let browser;
before(async () => {
    await mkdir(output, { recursive: true });
    browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(t, { width = 1280, profile = initial } = {}) {
    const state = { profile: structuredClone(profile), owner, requests: [], failure: null, gate: null, response: null };
    const server = createServer(async (req, res) => {
        const send = (status, body) => {
            if (res.destroyed) return;
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
            res.end(JSON.stringify(body));
        };
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname === '/api/save_user_profile') {
                let raw = '';
                for await (const bytes of req) raw += bytes;
                const body = JSON.parse(raw);
                state.requests.push(body);
                const request = { body, session: { userID: state.owner } };
                let failed;
                requireAccountWriteOwner(request, {}, error => { failed = error; });
                if (failed) throw failed;
                const saved = normalizeUserProfile(request.body);
                await state.gate;
                if (state.failure) return send(state.failure.status, { error: state.failure.error });
                if (Object.hasOwn(saved, 'showGitHubProfile')) {
                    state.profile.showGitHubProfile = saved.showGitHubProfile;
                    if (saved.showGitHubProfile) state.profile.githubURL = githubURL;
                    else delete state.profile.githubURL;
                }
                return send(200, state.response ?? state.profile);
            }
            if (url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                    + '<link rel="stylesheet" href="/css/ui/tokens.css"><link rel="stylesheet" href="/css/ui/components.css">'
                    + '<link rel="stylesheet" href="/css/ui/profile-editor.css"><link rel="stylesheet" href="/css/ui/topic-identity.css">'
                    + '<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">'
                    + '<title>GitHub profile preference fixture</title><button id="account">Your account</button>'
                    + '<div><span id="self" class="bp-discussion-author" data-profile-self="true"></span></div>'
                    + '<div><span id="other" class="bp-discussion-author"></span></div><div id="creator"></div>'
                    + '<script type="module" src="/fixture.js"></script></html>');
            }
            if (url.pathname === '/fixture.js') {
                res.writeHead(200, { 'Content-Type': 'text/javascript' });
                return res.end("import { openAccountCenter } from '/js/shared/account-center.js';"
                    + "import { pageAccountWriteScope } from '/js/shared/account-identity.js';"
                    + "import { publicGitHubURL, createTopicCreator } from '/js/shared/topic-identity.js';"
                    + "import { profileAvatarURL } from '/js/shared/profile-editor.js';"
                    + 'const node = (tag, className = "", text) => { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };'
                    + authorRenderer
                    + 'window.profile = ' + JSON.stringify(profile) + ';window.saved = [];window.events = [];window.errors = [];'
                    + 'document.addEventListener("benchpoll:profile-updated", event => window.events.push(event.detail));'
                    + 'window.openCenter = () => openAccountCenter({ profile: window.profile, onProfileSaved: saved => {window.profile = saved; window.saved.push(saved);} }).catch(error => window.errors.push(error.message));'
                    + 'document.getElementById("account").addEventListener("click", window.openCenter);'
                    + 'window.renderOther = value => renderAuthorIdentity(document.getElementById("other"), value.userName, value.userProfilePictureURL, value.githubURL);'
                    + 'window.renderCreator = value => document.getElementById("creator").replaceChildren(createTopicCreator(value));'
                    + 'renderAuthorIdentity(document.getElementById("self"), window.profile.userName, window.profile.userProfilePictureURL, window.profile.showGitHubProfile ? window.profile.githubURL : null);');
            }
            const path = resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!path.startsWith(root + sep)) return send(403, {});
            res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(path)] || 'application/octet-stream' });
            res.end(await readFile(path));
        } catch (error) { send(error.status ?? 500, error.body ?? { error: error.message }); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors = [], outside = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
        outside.push(route.request().url()); return route.abort();
    });
    t.after(async () => {
        state.release?.();
        await context.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []);
        assert.deepEqual(outside, [], 'No real provider lookups or external navigation');
    });
    page.setDefaultTimeout(6000);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => typeof window.openCenter === 'function');
    const open = async () => {
        await page.locator('#account').click();
        await page.getByRole('dialog', { name: 'Your account', exact: true }).waitFor();
    };
    return { page, state, open, toggle: page.getByRole('switch', { name: 'Show my GitHub profile', exact: true }) };
}

test('the account checkbox defaults off, saves only its exact owner and confirms state before publishing links', async t => {
    const { page, state, open, toggle } = await fixture(t, { width: 390 });
    await open();
    assert.equal(await toggle.isChecked(), false);
    assert.equal(state.requests.length, 0);
    assert.equal(await page.locator('#self a').count(), 0);
    state.gate = new Promise(resolve => { state.release = resolve; });
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('.bp-account-center')?.getAttribute('aria-busy') === 'true');
    assert.equal(await page.locator('.bp-account-center-status').textContent(), '');
    assert.ok(await page.locator('.bp-account-center-live').evaluate(node => node.getBoundingClientRect().width <= 1));
    assert.equal(await toggle.isChecked(), false, 'The control retains the last confirmed state while saving');
    assert.equal(await toggle.isDisabled(), true);
    assert.equal(await page.locator('#self a').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.bp-account-center').count(), 1);
    state.release();
    await page.waitForFunction(() => window.saved.length === 1);
    assert.equal(await page.locator('.bp-account-center-status').textContent(), '');
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await page.locator('#self a').getAttribute('href'), githubURL);
    assert.deepEqual(state.requests, [{ showGitHubProfile: true, expectedUserID: owner }]);
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('.bp-account-center').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: resolve(output, 'account-enabled-mobile.png') });
    await toggle.press('Space');
    await page.waitForFunction(() => window.saved.length === 2);
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await page.locator('#self a').count(), 0);
    assert.equal(await page.evaluate(() => Object.hasOwn(window.profile, 'githubURL')), false);
    await page.keyboard.press('Escape');
    await open();
    assert.equal(await toggle.isChecked(), false);
    assert.equal(state.requests.length, 2);
});

test('failure, mismatched confirmation and missing identity never turn an unconfirmed preference on', async t => {
    const { page, state, open, toggle } = await fixture(t);
    await open();
    state.failure = { status: 500, error: 'save_failed' };
    await toggle.click();
    await page.getByRole('alert').filter({ hasText: 'Could not confirm' }).waitFor();
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await page.locator('#self a').count(), 0);
    state.failure = null;
    state.response = { ...initial, userID: '42', showGitHubProfile: true, githubURL };
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('.bp-account-center')?.getAttribute('aria-busy') === 'false');
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await page.evaluate(() => window.events.length), 0);
    assert.equal(await page.locator('#self a').count(), 0);
});

test('current Terms and exact server-side owner checks also guard visibility writes', async t => {
    const { page, state, open, toggle } = await fixture(t);
    await open();
    state.failure = { status: 403, error: 'legal_acceptance_required' };
    await toggle.click();
    await page.getByRole('alert').filter({ hasText: 'Terms' }).waitFor();
    assert.equal(await toggle.isChecked(), false);
    assert.equal(state.profile.showGitHubProfile, false);
    assert.equal(await page.getByRole('link', { name: 'Privacy & account choices' }).count(), 1);
    state.failure = null;
    state.owner = '42';
    await toggle.click();
    await page.locator('.bp-account-center').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.events.length), 0);
    assert.equal(state.profile.showGitHubProfile, false);
    assert.equal(await page.locator('#self a').count(), 0);
});

test('account changes abort pending visibility saves and prevent stale responses from updating any identity', async t => {
    const { page, state, open, toggle } = await fixture(t);
    await open();
    state.gate = new Promise(resolve => { state.release = resolve; });
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('.bp-account-center')?.getAttribute('aria-busy') === 'true');
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'user-profile-update', newValue: 'other-account' })));
    await page.locator('.bp-account-center').waitFor({ state: 'detached' });
    state.release();
    assert.equal(await page.evaluate(() => window.events.length), 0);
    assert.equal(await page.locator('#self a').count(), 0);
    await page.evaluate(() => { window.profile = { ...window.profile, userID: '42' }; void window.openCenter(); });
    await page.waitForFunction(() => window.errors.length === 1);
    assert.equal(state.requests.length, 1);
});

test('unverified existing sessions have an off disabled checkbox without publishing or inferring a login', async t => {
    const { page, state, open, toggle } = await fixture(t, { profile: { ...initial, canShowGitHubProfile: false } });
    await open();
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await toggle.isDisabled(), true);
    assert.equal(await page.getByRole('link', { name: 'Sign in again to connect GitHub' }).getAttribute('href'), '/github_login');
    assert.equal(state.requests.length, 0);
    assert.equal(await page.locator('#self a').count(), 0);
});

test('public name and avatar share one exact link with blue hover, and null creators reveal no identity', async t => {
    const { page } = await fixture(t);
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(profile => {
            window.renderOther(profile);
            window.renderCreator({ name: profile.userName, avatarURL: profile.userProfilePictureURL, githubURL: profile.githubURL });
        }, { ...initial, githubURL });
        const link = page.locator('#other a');
        assert.equal(await link.getAttribute('href'), githubURL);
        assert.equal(await link.locator('img').count(), 1);
        assert.equal(await link.locator('strong').textContent(), initial.userName);
        assert.equal(await link.getAttribute('target'), '_blank');
        assert.match(await link.getAttribute('rel'), /noopener/);
        await link.hover();
        assert.equal(await link.locator('strong').evaluate(node => getComputedStyle(node).color), 'rgb(9, 105, 218)');
        assert.equal(await link.evaluate(node => getComputedStyle(node).cursor), 'pointer');
        assert.equal(await page.locator('#creator a').getAttribute('href'), githubURL);
        await page.screenshot({ path: resolve(output, 'public-link-' + width + '.png') });
    }
    await page.evaluate(profile => { window.renderOther(profile); window.renderCreator(null); }, initial);
    assert.equal(await page.locator('#other a, #creator a').count(), 0);
    assert.equal(await page.locator('#creator').textContent(), '');
    assert.equal(await page.locator('#other').evaluate(node => getComputedStyle(node).cursor), 'auto');
    await page.evaluate(profile => window.renderOther(profile), { ...initial, githubURL: 'https://github.com.evil.test/Verified-Login' });
    assert.equal(await page.locator('#other a').count(), 0);
});
