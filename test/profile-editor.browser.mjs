import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
import { normalizeUserProfile, userAvatarDataURL } from '../user-profile-service.js';
import { requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../privacy-headers.js';

const publicRoot = fileURLToPath(new URL('../public', import.meta.url));
const ownerID = '9007199254740993';
const initialProfile = { userID: ownerID, userName: 'Default member', userProfilePictureURL: null,
    defaultUserName: 'Default member', defaultUserProfilePictureURL: null, hasCustomDisplayName: false, hasCustomAvatar: false };
const policy = PRIVACY_CONTENT_SECURITY_POLICY.replace(/img-src[^;]+/, "img-src 'self' data: https://avatars.githubusercontent.com");
const evidence = join(tmpdir(), 'benchpoll-profile-editor-20261022');
const engine = process.env.PROFILE_EDITOR_BROWSER === 'webkit' ? webkit : chromium;
let browser;
before(async () => {
    // Windows WebKit otherwise proxies loopback requests in this development environment.
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    browser = await engine.launch({ headless: true, ...(engine === webkit ? { env } : {}) });
    await mkdir(evidence, { recursive: true });
});
after(async () => { await browser?.close(); });

async function fixture(t, viewport = { width: 1440, height: 1000 }) {
    const state = { profile: structuredClone(initialProfile), requests: [], accountID: ownerID, responses: [], gate: null };
    const server = createServer(async (req, res) => {
        const send = (status, body) => {
            if (res.destroyed) return;
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
            res.end(JSON.stringify(body));
        };
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            res.setHeader('Content-Security-Policy', policy);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (url.pathname === '/api/save_user_profile') {
                let raw = '';
                for await (const bytes of req) raw += bytes;
                const body = JSON.parse(raw);
                state.requests.push(structuredClone(body));
                const guarded = { session: { userID: state.accountID }, body };
                let problem;
                requireAccountWriteOwner(guarded, {}, error => { problem = error; });
                if (problem) throw problem;
                await state.gate;
                const response = state.responses.shift();
                if (response) return send(response.status ?? 200, response.body);
                const saved = normalizeUserProfile(guarded.body);
                if (Object.hasOwn(saved, 'displayName')) {
                    state.profile.userName = saved.displayName;
                    state.profile.hasCustomDisplayName = true;
                }
                if (Object.hasOwn(saved, 'avatar')) {
                    state.profile.userProfilePictureURL = saved.avatar ?? state.profile.defaultUserProfilePictureURL;
                    state.profile.hasCustomAvatar = saved.avatar !== null;
                }
                return send(200, state.profile);
            }
            if (url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
                    <meta name="viewport" content="width=device-width,initial-scale=1">
                    <link rel="stylesheet" href="/css/ui/tokens.css"><link rel="stylesheet" href="/css/ui/components.css">
                    <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
                    <title>Profile editor fixture</title></head><body><button id="edit">Edit profile</button>
                    <script type="module" src="/fixture.js"></script></body></html>`);
            }
            if (url.pathname === '/fixture.js') {
                res.writeHead(200, { 'Content-Type': 'text/javascript' });
                return res.end(`import { openProfileEditor } from '/js/shared/profile-editor.js';
                    import { pageAccountWriteScope } from '/js/shared/account-identity.js';
                    window.profile = ${JSON.stringify(initialProfile)};
                    window.savedProfiles = []; window.profileEvents = []; window.editorResults = []; window.editorErrors = [];
                    window.invalidateAccount = () => pageAccountWriteScope.invalidate();
                    window.openEditor = () => openProfileEditor({ profile: window.profile,
                        onSaved: profile => { window.savedProfiles.push(profile); if (window.failCallback) throw Error('refresh failed'); }
                    }).then(result => window.editorResults.push(result)).catch(error => window.editorErrors.push(error.message));
                    document.addEventListener('benchpoll:profile-updated', event => window.profileEvents.push(event.detail));
                    document.getElementById('edit').addEventListener('click', () => { void window.openEditor(); });`);
            }
            const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
            if (!path.startsWith(publicRoot + sep)) return send(403, {});
            const body = await readFile(path);
            const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[extname(path)] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(body);
        } catch (error) { send(error.status ?? 500, error.body ?? { error: error.message }); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.profileCSPViolations = [];
        document.addEventListener('securitypolicyviolation', event => window.profileCSPViolations.push(event.effectiveDirective));
    });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    t.after(async () => {
        try {
            assert.deepEqual(errors, []);
            assert.deepEqual(await page.evaluate(() => window.profileCSPViolations), []);
        } finally {
            state.release?.();
            await context.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => typeof window.openEditor === 'function');
    return { page, state };
}

async function open(page, profile = null) {
    if (profile) await page.evaluate(value => { window.profile = value; }, profile);
    await page.getByRole('button', { name: 'Edit profile', exact: true }).focus();
    await page.getByRole('button', { name: 'Edit profile', exact: true }).press('Enter');
    await page.getByRole('dialog', { name: 'Public profile' }).waitFor();
    await page.waitForFunction(() => document.querySelector('link[data-bp-profile-editor]')?.sheet);
}
async function saved(page) {
    await page.waitForFunction(() => window.profileEvents.length === 1 || document.querySelector('[role="alert"]')?.textContent);
    const result = await page.evaluate(() => ({ count: window.profileEvents.length, error: document.querySelector('[role="alert"]')?.textContent }));
    assert.equal(result.count, 1, result.error || 'Profile did not save.');
}
async function raster(page, mime = 'image/png') {
    const data = await page.evaluate(type => {
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 300;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fa0000'; context.fillRect(0, 0, 300, 300);
        context.fillStyle = '#0044ee'; context.fillRect(300, 0, 300, 300);
        context.fillStyle = '#00cc00'; context.fillRect(600, 0, 300, 300);
        return canvas.toDataURL(type).split(',')[1];
    }, mime);
    return { name: mime === 'image/jpeg' ? 'avatar.jpg' : mime === 'image/webp' ? 'avatar.webp' : 'avatar.png', mimeType: mime,
        buffer: Buffer.from(data, 'base64') };
}
async function upload(page, payload) {
    await page.getByLabel('Avatar', { exact: true }).setInputFiles(payload);
    await page.waitForFunction(() => document.querySelector('.bp-profile-editor-form').getAttribute('aria-busy') === 'false');
}

test('native dialog has labels, contained keyboard focus, focus restoration, no account IDs and responsive screenshots', async t => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
        const { page, state } = await fixture(t, viewport);
        await open(page);
        assert.equal(await page.getByLabel('Display name', { exact: true }).evaluate(node => node === document.activeElement), true);
        assert.equal(await page.getByRole('dialog').evaluate(node => node.matches(':modal')), true);
        assert.ok(!(await page.getByRole('dialog').innerText()).includes(ownerID));
        assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
        for (let index = 0; index < 12; index++) {
            await page.keyboard.press(index < 6 ? 'Tab' : 'Shift+Tab');
            assert.equal(await page.getByRole('dialog').evaluate(node => node.contains(document.activeElement)), true);
        }
        assert.equal(await page.getByRole('dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
        const box = await page.getByRole('dialog').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height);
        await page.screenshot({ path: join(evidence, `profile-${engine.name()}-${viewport.width}.png`) });
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => window.editorResults.length === 1);
        assert.equal(await page.evaluate(() => window.editorResults[0]), null);
        assert.equal(await page.locator('#edit').evaluate(node => node === document.activeElement), true);
        assert.equal(state.requests.length, 0);
    }
});

test('Unicode save uses the standard exact-owner transport, preserves defaults and fires one callback/event', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    const name = '😀'.repeat(60);
    await page.getByLabel('Display name', { exact: true }).fill(name);
    assert.equal(await page.locator('.bp-profile-editor-count').textContent(), '60 / 60');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved(page);
    assert.deepEqual(state.requests, [{ displayName: name, expectedUserID: ownerID }]);
    assert.equal(await page.evaluate(() => window.savedProfiles.length), 1);
    assert.equal(await page.evaluate(() => window.editorResults[0].userName), name);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(state.profile.hasCustomAvatar, false);
});

test('PNG/JPEG/WebP uploads are center-cropped to a valid <=256 PNG without CSP violations', async t => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
        const { page, state } = await fixture(t);
        await open(page);
        await upload(page, await raster(page, mime));
        await page.getByRole('img', { name: 'Avatar preview' }).waitFor();
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await saved(page);
        const request = state.requests[0];
        assert.equal(Object.hasOwn(request, 'displayName'), false);
        assert.ok(Buffer.byteLength(JSON.stringify(request)) < 300 * 1024);
        const verified = userAvatarDataURL(request.avatar);
        const bytes = Buffer.from(verified.split(',')[1], 'base64');
        assert.equal(bytes.readUInt32BE(16), 256);
        assert.equal(bytes.readUInt32BE(20), 256);
        const center = await page.evaluate(async value => {
            const image = new Image(); image.src = value; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
        }, verified);
        assert.ok(center[2] > 200 && center[0] < 20 && center[1] < 100);
    }
});

test('reset explicitly sends null without pinning an unchanged default display name', async t => {
    const { page, state } = await fixture(t);
    const source = await raster(page);
    const avatar = `data:image/png;base64,${source.buffer.toString('base64')}`;
    state.profile = { ...state.profile, userProfilePictureURL: avatar, hasCustomAvatar: true };
    await open(page, state.profile);
    await page.getByRole('button', { name: 'Reset avatar' }).click();
    assert.equal(await page.getByRole('img', { name: 'Avatar preview' }).count(), 0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved(page);
    assert.deepEqual(state.requests, [{ avatar: null, expectedUserID: ownerID }]);
    assert.equal(state.profile.hasCustomDisplayName, false);
});

test('invalid uploads and names keep the dialog editable and never submit', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    const name = page.getByLabel('Display name', { exact: true });
    await name.fill('😀'.repeat(61));
    assert.equal(await name.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await name.fill('Valid draft');
    await upload(page, { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    assert.match(await page.getByRole('alert').textContent(), /valid PNG, JPEG or WebP/);
    assert.equal(await page.getByLabel('Avatar', { exact: true }).getAttribute('aria-invalid'), 'true');
    await upload(page, { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) });
    assert.match(await page.getByRole('alert').textContent(), /valid PNG, JPEG or WebP/);
    assert.equal(await name.inputValue(), 'Valid draft');
    assert.equal(state.requests.length, 0);
});

test('server errors retain name/avatar drafts and retry without duplicate events', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    await page.getByLabel('Display name', { exact: true }).fill('Retained draft');
    await upload(page, await raster(page));
    state.responses.push({ status: 503, body: { error: 'temporary_failure' } });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]').textContent.includes('changes are kept'));
    assert.equal(await page.getByLabel('Display name', { exact: true }).inputValue(), 'Retained draft');
    assert.equal(await page.getByRole('img', { name: 'Avatar preview' }).isVisible(), true);
    assert.equal(await page.evaluate(() => window.profileEvents.length), 0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved(page);
    assert.deepEqual(state.requests[0], state.requests[1]);
    assert.equal(await page.evaluate(() => window.savedProfiles.length), 1);
});

test('cancelling an in-flight save ignores late success and restores focus', async t => {
    const { page, state } = await fixture(t);
    state.gate = new Promise(resolve => { state.release = resolve; });
    await open(page);
    await page.getByLabel('Display name', { exact: true }).fill('Pending save');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bp-profile-editor-form').getAttribute('aria-busy') === 'true');
    assert.equal(await page.getByLabel('Display name', { exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    state.release();
    await page.waitForFunction(() => window.editorResults.length === 1);
    assert.deepEqual(await page.evaluate(() => ({ results: window.editorResults, events: window.profileEvents, callbacks: window.savedProfiles })),
        { results: [null], events: [], callbacks: [] });
    assert.equal(await page.locator('#edit').evaluate(node => node === document.activeElement), true);
});

test('a superseded upload or closed editor cannot overwrite the current preview or send a save', async t => {
    const { page, state } = await fixture(t);
    const source = await raster(page);
    await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function () {
            if (this.name !== 'slow.png') return original.call(this);
            return new Promise(resolve => { window.releaseUpload = async () => resolve(await original.call(this)); });
        };
    });
    await open(page);
    await page.getByLabel('Avatar', { exact: true }).setInputFiles({ ...source, name: 'slow.png' });
    await page.waitForFunction(() => typeof window.releaseUpload === 'function');
    await page.getByRole('button', { name: 'Reset avatar' }).click();
    await page.evaluate(() => window.releaseUpload());
    assert.equal(await page.getByRole('img', { name: 'Avatar preview' }).count(), 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(state.requests.length, 0);
    await open(page);
    await page.getByLabel('Avatar', { exact: true }).setInputFiles({ ...source, name: 'slow.png' });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => window.releaseUpload());
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => window.profileEvents.length), 0);
});

test('account-change errors block further writes while retaining the draft', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    await page.getByLabel('Display name', { exact: true }).fill('Account draft');
    state.accountID = '9007199254740995';
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]').textContent.includes('account changed'));
    assert.equal(await page.getByLabel('Display name', { exact: true }).inputValue(), 'Account draft');
    assert.equal(state.requests.length, 1);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal(state.requests.length, 1);
    assert.equal(await page.evaluate(() => window.profileEvents.length), 0);
});

test('invalid successful responses stay retryable and callback failures cannot turn a committed save into an error', async t => {
    const { page, state } = await fixture(t);
    await open(page);
    await page.getByLabel('Display name', { exact: true }).fill('Confirmed name');
    state.responses.push({ body: {} });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]').textContent.includes('could not be confirmed'));
    await page.evaluate(() => { window.failCallback = true; });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await saved(page);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => window.savedProfiles.length), 1);
    assert.equal(await page.evaluate(() => window.editorErrors.length), 0);
});

test('account invalidation during a held save suppresses stale success notifications', async t => {
    const { page, state } = await fixture(t);
    state.gate = new Promise(resolve => { state.release = resolve; });
    await open(page);
    await page.getByLabel('Display name', { exact: true }).fill('Invalidated draft');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bp-profile-editor-form').getAttribute('aria-busy') === 'true');
    await page.evaluate(() => window.invalidateAccount());
    state.release();
    await page.waitForFunction(() => document.querySelector('[role="alert"]').textContent.includes('account changed'));
    assert.equal(await page.evaluate(() => window.profileEvents.length), 0);
    assert.equal(await page.getByLabel('Display name', { exact: true }).inputValue(), 'Invalidated draft');
});

test('a timed-out save keeps the draft, clears the busy state and can be dismissed', async t => {
    const { page, state } = await fixture(t);
    state.gate = new Promise(resolve => { state.release = resolve; });
    await open(page);
    await page.clock.install();
    await page.getByLabel('Display name', { exact: true }).fill('Timed out draft');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.clock.fastForward(20001);
    await page.waitForFunction(() => document.querySelector('[role="alert"]').textContent.includes('too long'));
    assert.equal(await page.getByLabel('Display name', { exact: true }).isDisabled(), false);
    assert.equal(await page.getByLabel('Display name', { exact: true }).inputValue(), 'Timed out draft');
    assert.equal(await page.evaluate(() => window.profileEvents.length), 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    state.release();
});
