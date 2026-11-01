import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { normalizeUserProfile, userAvatarDataURL } from '../user-profile-service.js';
import { requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../privacy-headers.js';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const root = fileURLToPath(new URL('../public', import.meta.url));
const output = resolve('D:/Codex-artifacts/website1/topics-polish-20261023/account-center');
const browserTemp = resolve('D:/Codex-artifacts/website1/showcase-composition-20261021/tmp');
const owner = '9007199254740993';
const initial = { userID: owner, userName: 'Default member', userProfilePictureURL: null,
    defaultUserName: 'Default member', defaultUserProfilePictureURL: null, hasCustomDisplayName: false, hasCustomAvatar: false };
const engine = process.env.ACCOUNT_CENTER_BROWSER === 'webkit' ? webkit : chromium;
let browser;
before(async () => {
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = browserTemp;
    await mkdir(browserTemp, { recursive: true });
    await mkdir(output, { recursive: true });
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    browser = await engine.launch({ headless: true, env });
});
after(async () => { await browser?.close(); });

async function fixture(t, { guest = false, width = 1280 } = {}) {
    const state = { profile: structuredClone(initial), owner, requests: [], deviceCount: 3, failure: null, gate: null, countGate: null };
    const server = createServer(async (req, res) => {
        const send = (status, body) => {
            if (res.destroyed) return;
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
            res.end(status === 204 ? '' : JSON.stringify(body));
        };
        try {
            const url = new URL(req.url, 'http://localhost');
            res.setHeader('Content-Security-Policy', PRIVACY_CONTENT_SECURITY_POLICY);
            if (url.pathname.startsWith('/api/')) {
                let raw = '';
                for await (const bytes of req) raw += bytes;
                const body = JSON.parse(raw || '{}');
                state.requests.push({ path: url.pathname + url.search, body: structuredClone(body) });
                if (url.pathname === '/api/get_device_count') {
                    await state.countGate;
                    if (state.countFailure) return send(500, { error: 'device_read_failed' });
                    return send(200, { deviceCount: state.deviceCount });
                }
                const request = { session: { userID: state.owner }, body };
                let failure;
                requireAccountWriteOwner(request, {}, error => { failure = error; });
                if (failure) throw failure;
                await state.gate;
                if (state.failure) return send(state.failure.status, { error: state.failure.error });
                if (url.pathname === '/api/save_user_profile') {
                    const saved = normalizeUserProfile(request.body);
                    if (Object.hasOwn(saved, 'displayName')) Object.assign(state.profile, { userName: saved.displayName, hasCustomDisplayName: true });
                    if (Object.hasOwn(saved, 'avatar')) Object.assign(state.profile, { userProfilePictureURL: saved.avatar,
                        hasCustomAvatar: saved.avatar !== null });
                    return send(200, state.profile);
                }
                return send(204);
            }
            if (url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                    + '<link rel="stylesheet" href="/css/ui/tokens.css"><link rel="stylesheet" href="/css/ui/components.css">'
                    + '<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css"><title>Account center fixture</title></head><body>'
                    + '<button id="home">Home account</button><button id="config">Config account</button><script type="module" src="/fixture.js"></script></body></html>');
            }
            if (url.pathname === '/fixture.js') {
                res.writeHead(200, { 'Content-Type': 'text/javascript' });
                return res.end("import { openAccountCenter } from '/js/shared/account-center.js';"
                    + "import { pageAccountWriteScope } from '/js/shared/account-identity.js';"
                    + 'window.profile = ' + JSON.stringify(guest ? null : initial) + ';'
                    + 'window.saved = []; window.signedOut = []; window.results = []; window.errors = [];'
                    + 'window.invalidate = () => pageAccountWriteScope.invalidate();'
                    + 'window.openCenter = () => openAccountCenter({ profile: window.profile,'
                    + 'onProfileSaved: profile => { window.profile = profile; window.saved.push(profile); },'
                    + 'onSignedOut: detail => { window.signedOut.push(detail); if (window.holdSignedOut) return new Promise(() => {}); }'
                    + '}).then(value => window.results.push(value)).catch(error => window.errors.push(error.message));'
                    + "for (const id of ['home', 'config']) document.getElementById(id).addEventListener('click', window.openCenter);");
            }
            const path = resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!path.startsWith(root + sep)) return send(403, {});
            res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[extname(path)] || 'application/octet-stream' });
            res.end(await readFile(path));
        } catch (error) { send(error.status ?? 500, error.body ?? { error: error.message }); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], csp = [];
    let disposed = false;
    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        state.release?.(); state.releaseCount?.();
        try { await context.close(); }
        finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(csp, []);
    };
    t.after(dispose);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('cspFailure', value => csp.push(value));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => window.cspFailure(event.effectiveDirective)));
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => typeof window.openCenter === 'function');
    return { page, state, dispose };
}
const center = page => page.locator('.bp-account-center');
const writes = state => state.requests.filter(request => request.path !== '/api/get_device_count');
async function open(page, entry = 'home') {
    await page.locator('#' + entry).focus();
    await page.locator('#' + entry).press('Enter');
    await page.getByRole('dialog', { name: 'Your account', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('link[data-bp-account-center]')?.sheet);
}

test('both account entries show identical authenticated/guest UI with bounded layout and restored keyboard focus', async t => {
    for (const width of [1440, 390, 320]) for (const guest of [false, true]) {
        const { page, state, dispose } = await fixture(t, { guest, width });
        let first;
        for (const entry of ['home', 'config']) {
            await open(page, entry);
            const html = await center(page).innerHTML();
            if (first) assert.equal(html, first); else first = html;
            assert.equal(await center(page).evaluate(node => node.matches(':modal')), true);
            assert.ok(!(await center(page).innerText()).includes(owner));
            assert.equal(await center(page).getByRole('button', { name: 'Edit profile', exact: true }).count(), guest ? 0 : 1);
            assert.equal(await center(page).getByRole('link', { name: 'Privacy & account choices' }).getAttribute('href'), '/account/privacy');
            if (guest) assert.equal(await center(page).getByRole('link', { name: 'Sign in with GitHub' }).getAttribute('href'), '/github_login');
            for (let index = 0; index < 10; index++) {
                await page.keyboard.press(index < 5 ? 'Tab' : 'Shift+Tab');
                assert.equal(await center(page).evaluate(node => node.contains(document.activeElement)), true);
            }
            assert.equal(await center(page).evaluate(node => node.scrollWidth <= node.clientWidth), true);
            const gaps = await center(page).locator('.bp-account-center-operations .bp-ui-action').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).columnGap));
            assert.ok(gaps.length && gaps.every(gap => gap === '8px'), 'Account operations use the shared action gap');
            if (!guest) {
                const alignment = await center(page).evaluate(node => {
                    const edit = node.querySelector('#edit-profile-button');
                    const github = node.querySelector('.bp-account-center-github');
                    return ['i', '.bp-ui-action-label'].map(selector => [edit, github].map(item => item.querySelector(selector).getBoundingClientRect().left));
                });
                assert.ok(alignment.every(([a, b]) => Math.abs(a - b) < 1), JSON.stringify(alignment));
            }
            const bounds = await center(page).boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
            await page.screenshot({ path: join(output, engine.name() + '-' + width + '-' + (guest ? 'guest' : 'member') + '.png') });
            await page.keyboard.press('Escape');
            await center(page).waitFor({ state: 'detached' });
            assert.equal(await page.locator('#' + entry).evaluate(node => node === document.activeElement), true);
        }
        assert.equal(await page.locator('link[data-bp-account-center]').count(), 1);
        assert.equal(state.requests.length, 0);
        await dispose();
    }
});

test('nested editor saves name/avatar through the real validator/owner guard and returns focus to personal center', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    await center(page).getByRole('button', { name: 'Edit profile' }).click();
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('New public name');
    const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 300;
        canvas.getContext('2d').fillRect(0, 0, 900, 300);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByLabel('Avatar', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await page.waitForFunction(() => document.querySelector('.bp-profile-editor form').getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: 'Save', exact: true }).focus();
    await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
    await page.waitForFunction(() => window.saved.length === 1);
    assert.equal(await page.locator('#account-dialog-name').textContent(), 'New public name');
    assert.equal(await page.locator('#edit-profile-button').evaluate(node => node === document.activeElement), true);
    assert.equal(await center(page).evaluate(node => node.matches(':modal')), true);
    const request = writes(state)[0].body;
    assert.equal(request.expectedUserID, owner);
    assert.equal(request.displayName, 'New public name');
    const bytes = Buffer.from(userAvatarDataURL(request.avatar).split(',')[1], 'base64');
    assert.equal(bytes.readUInt32BE(16), 256);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) < 300 * 1024);
    await center(page).getByRole('button', { name: 'Edit profile' }).click();
    await page.getByRole('button', { name: 'Reset avatar' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
    await page.waitForFunction(() => window.saved.length === 2);
    assert.deepEqual(writes(state)[1].body, { avatar: null, expectedUserID: owner });
    assert.equal(await page.locator('#account-dialog-picture').evaluate(node => node.style.backgroundImage), '');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#home').evaluate(node => node === document.activeElement), true);
});

test('editor cancellation returns to the same personal center without sending a save', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    await page.locator('#edit-profile-button').click();
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Unsaved name');
    await page.keyboard.press('Escape');
    await page.locator('.bp-profile-editor').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#account-dialog-name').textContent(), initial.userName);
    assert.equal(await page.locator('#edit-profile-button').evaluate(node => node === document.activeElement), true);
    assert.equal(state.requests.length, 0);
});

for (const all of [false, true]) test('logout ' + (all ? 'all devices' : 'this device') + ' requires confirmation and exact account transport', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    await page.locator('#logout-button').click();
    await center(page).getByRole('button', { name: 'Log out on all 3 devices' }).waitFor();
    assert.equal(writes(state).length, 0);
    await center(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(writes(state).length, 0);
    await page.locator('#logout-button').click();
    await center(page).getByRole('button', { name: all ? 'Log out on all 3 devices' : 'Log out on this device', exact: true }).click();
    await page.waitForFunction(() => window.signedOut.length === 1);
    assert.deepEqual(writes(state), [{ path: all ? '/api/logout?all' : '/api/logout', body: { expectedUserID: owner } }]);
    assert.equal(await page.evaluate(() => window.signedOut[0].action), all ? 'logout-all' : 'logout');
    const dismiss = center(page).getByRole('button', { name: 'Close', exact: true });
    assert.equal(await dismiss.getAttribute('data-ui-variant'), 'primary');
    assert.equal(await dismiss.locator('i,svg').count(), 0, 'Dismissal must not look like a selected checkmark state');
    assert.notEqual(await dismiss.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    if (!all) await page.screenshot({ path: join(output, engine.name() + '-logout-confirmed.png') });
    await dismiss.click();
    await page.waitForFunction(() => window.results.length === 1);
    assert.equal(await page.evaluate(() => window.results[0].action), all ? 'logout-all' : 'logout');
});

test('deactivation retains honest data/erasure disclosure and only writes after explicit confirmation', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    await page.locator('#delete-account-button').click();
    assert.match(await center(page).innerText(), /Weights, private topics and review records are retained/);
    assert.equal(await center(page).getByRole('link').getAttribute('href'), '/privacy#rights');
    assert.equal(writes(state).length, 0);
    await center(page).getByRole('button', { name: 'Deactivate account', exact: true }).click();
    await page.waitForFunction(() => window.signedOut.length === 1);
    assert.deepEqual(writes(state), [{ path: '/api/delete_account', body: { expectedUserID: owner } }]);
    assert.match(await center(page).innerText(), /not been completely erased/);
    assert.match(await center(page).getByRole('link', { name: 'Revoke GitHub access' }).getAttribute('href'), /^https:\/\/github\.com\/settings\/connections\/applications\//);
});

test('device read failures retry without writes; a single-device logout does not wait on an application refresh callback', async t => {
    const { page, state } = await fixture(t);
    state.countFailure = true;
    await open(page);
    await page.locator('#logout-button').click();
    await center(page).getByRole('button', { name: 'Retry device count' }).waitFor();
    assert.equal(writes(state).length, 0);
    state.countFailure = false; state.deviceCount = 1;
    await center(page).getByRole('button', { name: 'Retry device count' }).click();
    await center(page).getByText('This signs you out on this device.', { exact: true }).waitFor();
    assert.equal(await center(page).getByRole('button', { name: /Log out on all/ }).count(), 0);
    await page.evaluate(() => { window.holdSignedOut = true; });
    await center(page).getByRole('button', { name: 'Log out on this device', exact: true }).click();
    await page.waitForFunction(() => window.signedOut.length === 1);
    await center(page).getByRole('button', { name: 'Close', exact: true }).click();
    await center(page).waitFor({ state: 'detached' });
    assert.equal(writes(state).length, 1);
});

test('updated Terms block the write outcome and retain a real account choices recovery link', async t => {
    const { page, state } = await fixture(t);
    state.failure = { status: 409, error: 'legal_acceptance_required' };
    await open(page);
    await page.locator('#delete-account-button').click();
    await center(page).getByRole('button', { name: 'Deactivate account', exact: true }).click();
    await center(page).getByRole('link', { name: 'Privacy & account choices' }).waitFor();
    assert.equal(await page.evaluate(() => window.signedOut.length), 0);
    assert.equal(await center(page).getByRole('link', { name: 'Privacy & account choices' }).getAttribute('href'), '/account/privacy');
    assert.equal(await center(page).getByRole('button', { name: 'Deactivate account', exact: true }).isEnabled(), true);
});

test('failed actions keep their confirmation and retry; foreign account writes cannot report success', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    await page.locator('#delete-account-button').click();
    state.failure = { status: 500, error: 'fixture_failure' };
    await center(page).getByRole('button', { name: 'Deactivate account', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bp-account-center-status').textContent.includes('try again'));
    assert.equal(await page.evaluate(() => window.signedOut.length), 0);
    state.failure = null; state.owner = '8';
    await center(page).getByRole('button', { name: 'Deactivate account', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bp-account-center-status').textContent.includes('account changed'));
    assert.equal(await page.evaluate(() => window.signedOut.length), 0);
    assert.equal(await center(page).getByRole('button', { name: 'Deactivate account', exact: true }).isDisabled(), true);
    assert.ok(writes(state).every(request => request.body.expectedUserID === owner));
    await center(page).getByRole('button', { name: 'Close your account' }).click();
});

test('late device reads cannot replace the returned account view; pending writes are single flight and not dismissed', async t => {
    const { page, state } = await fixture(t);
    state.countGate = new Promise(resolve => { state.releaseCount = resolve; });
    await open(page);
    await page.locator('#logout-button').click();
    await center(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    state.releaseCount();
    await page.waitForTimeout(50);
    assert.equal(await center(page).getByRole('heading').textContent(), 'Your account');
    assert.equal(await center(page).getByRole('button', { name: 'Log out on all 3 devices' }).count(), 0);
    state.gate = new Promise(resolve => { state.release = resolve; });
    await page.locator('#delete-account-button').click();
    await center(page).getByRole('button', { name: 'Deactivate account', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await center(page).getByRole('button', { name: 'Close your account' }).isDisabled(), true);
    assert.equal(writes(state).length, 1);
    state.release();
    await page.waitForFunction(() => window.signedOut.length === 1);
    assert.equal(writes(state).length, 1);
});

test('real configuration header and sidebar both open the shared dialog and apply effective profile updates', async t => {
    const preview = await startConfigSidebarPreview();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'false'));
    t.after(async () => { try { await context.close(); } finally { await preview.close(); } });
    const logouts = [];
    await context.route(url => url.pathname === '/api/logout', async route => {
        const body = route.request().postDataJSON();
        const request = { session: { userID: preview.state.userID }, body };
        let failure;
        requireAccountWriteOwner(request, {}, error => { failure = error; });
        if (failure) return route.fulfill({ status: failure.status, contentType: 'application/json', body: JSON.stringify(failure.body) });
        logouts.push(structuredClone(body));
        preview.setAccount(null);
        return route.fulfill({ status: 204 });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(preview.url + '/intelligence');
    page.setDefaultTimeout(6000);
    await page.locator('#header-user-profile:not([hidden])').waitFor({ state: 'attached' });
    await page.locator('#config-sidebar-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('config-sidebar-collapsed')
        && document.body.dataset.configSidebarPhase === 'idle');
    await page.locator('#header-user-profile').click();
    await center(page).waitFor();
    assert.equal(await center(page).evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: join(output, engine.name() + '-configuration.png') });
    await page.locator('#edit-profile-button').click();
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Shared account');
    await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
    await page.waitForFunction(() => document.getElementById('account-dialog-name')?.textContent === 'Shared account');
    assert.equal(await page.locator('#user-profile-name').textContent(), 'Shared account');
    assert.match(await page.locator('#header-user-profile').getAttribute('aria-label'), /Shared account/);
    await page.keyboard.press('Escape');
    await center(page).waitFor({ state: 'detached' });
    assert.equal(await page.locator('#header-user-profile').evaluate(node => node === document.activeElement), true);
    await page.locator('#config-sidebar-toggle').click();
    await page.waitForFunction(() => !document.body.classList.contains('config-sidebar-collapsed')
        && document.body.dataset.configSidebarPhase === 'idle');
    await page.locator('#user-profile').click();
    await center(page).waitFor();
    assert.equal(await page.locator('#account-dialog-name').textContent(), 'Shared account');
    assert.equal(await page.locator('#user-account-dialog').count(), 1);
    await page.keyboard.press('Escape');
    await center(page).waitFor({ state: 'detached' });
    assert.equal(await page.locator('#user-profile').evaluate(node => node === document.activeElement), true);
    await page.locator('#user-profile').click();
    await page.locator('#logout-button').click();
    await center(page).getByRole('button', { name: 'Log out on this device', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('header-user-profile').hidden
        && !document.getElementById('header-login-button').hidden);
    assert.deepEqual(logouts, [{ expectedUserID: '1' }]);
    await center(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForLoadState('load');
    await page.waitForFunction(() => document.getElementById('header-user-profile').hidden
        && !document.getElementById('header-login-button').hidden);
    assert.deepEqual(errors, []);
});

test('actual Home uses the same account dialog and saves public profile before guarded all-device logout', async t => {
    const home = await startTopicsPreview({ previewDelay: 0 });
    home.state.profile.canShowGitHubProfile = true;
    home.state.profile.showGitHubProfile = false;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    t.after(async () => { try { await context.close(); } finally { await home.close(); } });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(home.url);
    const privateTopics = home.state.topics.filter(topic => topic.isPrivate);
    assert.ok(privateTopics.length);
    for (const topic of privateTopics) await page.locator('[data-topic-id="' + topic.ID + '"]').waitFor({ state: 'attached' });
    await page.locator('#topics-account[aria-haspopup="dialog"]').waitFor({ state: 'attached' });
    if (!(await page.locator('#topics-account').isVisible())) await page.locator('#topics-more summary').click();
    await page.locator('#topics-account').click();
    await center(page).waitFor();
    assert.equal(await center(page).getByRole('heading').textContent(), 'Your account');
    assert.deepEqual(await center(page).locator('.bp-account-center-operations .bp-ui-action').allTextContents(),
        ['Edit profile', 'Privacy & account choices', 'Log out', 'Deactivate account']);
    assert.equal(await center(page).evaluate(node => node.matches(':modal') && node.scrollWidth <= node.clientWidth), true);
    await page.locator('#edit-profile-button').click();
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Home public profile');
    const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
        canvas.getContext('2d').fillRect(0, 0, 128, 128);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByLabel('Avatar', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await page.waitForFunction(() => document.querySelector('.bp-profile-editor form').getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: 'Save', exact: true }).press('Enter');
    await page.waitForFunction(() => document.getElementById('account-dialog-name')?.textContent === 'Home public profile'
        && document.getElementById('topics-account').textContent.includes('Home public profile'));
    assert.equal(await page.locator('#edit-profile-button').evaluate(node => node === document.activeElement), true);
    const saved = home.state.requests.find(request => request.path === '/api/save_user_profile');
    assert.equal(saved.body.expectedUserID, '42');
    assert.equal(saved.body.displayName, 'Home public profile');
    const verifiedAvatar = Buffer.from(userAvatarDataURL(saved.body.avatar).split(',')[1], 'base64');
    assert.equal(verifiedAvatar.readUInt32BE(16), 128);
    assert.equal(verifiedAvatar.readUInt32BE(20), 128);
    assert.equal(await page.locator('#topics-account img').getAttribute('src'), saved.body.avatar);
    await page.waitForFunction(() => {
        const image = document.querySelector('#topics-account img');
        return image?.complete && image.naturalWidth > 0;
    });
    await page.screenshot({ path: join(output, engine.name() + '-home-account.png') });
    await page.keyboard.press('Escape');
    await center(page).waitFor({ state: 'detached' });
    assert.equal(await page.locator('#topics-account').evaluate(node => node === document.activeElement), true);
    await page.locator('#topics-account').click();
    await page.locator('#logout-button').click();
    const logoutRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/logout' && request.method() === 'POST');
    await center(page).getByRole('button', { name: 'Log out on all 2 devices', exact: true }).click();
    assert.equal(new URL((await logoutRequest).url()).searchParams.has('all'), true);
    await page.waitForFunction(() => document.getElementById('topics-account').getAttribute('href') === '/login');
    const loggedOut = home.state.requests.find(request => request.path === '/api/logout');
    assert.equal(loggedOut.body.expectedUserID, '42');
    assert.equal(home.state.authenticated, false);
    for (const topic of privateTopics) assert.equal(await page.locator('[data-topic-id="' + topic.ID + '"]').count(), 0);
    await center(page).getByRole('button', { name: 'Close', exact: true }).click();
    await center(page).waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
});

test('actual guest Home and configuration expose sign-in, not profile editing or account mutations', async t => {
    const home = await startTopicsPreview({ authenticated: false, previewDelay: 0 });
    const configuration = await startConfigSidebarPreview();
    configuration.setAccount(null);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    t.after(async () => {
        try { await context.close(); }
        finally { await home.close(); await configuration.close(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(home.url);
    await page.locator('#topics-account').getByText('Sign in', { exact: true }).waitFor();
    assert.equal(await page.locator('#topics-account').getAttribute('href'), '/login');
    assert.equal(await center(page).count(), 0);
    await page.goto(configuration.url + '/intelligence');
    await page.waitForFunction(() => !document.getElementById('header-login-button').hidden
        && document.getElementById('header-user-profile').hidden);
    assert.equal(await page.locator('#edit-profile-button').count(), 0);
    assert.equal(await center(page).count(), 0);
    for (const state of [home.state, configuration.state]) {
        assert.equal(state.requests.some(request => /\/(?:save_user_profile|logout|delete_account)$/.test(request.path)), false);
    }
});
