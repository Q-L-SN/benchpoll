import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { openSignIn, installSignInLinks, listenAccountChange, completeSignIn } from '../public/js/shared/sign-in.js';

function view() {
    const events = new Map(), navigations = [], notifications = [];
    const popup = { focus() { notifications.push('focus'); } };
    return { events, navigations, notifications, popup, screenLeft: 10, screenTop: 20,
        innerWidth: 1440, innerHeight: 900,
        addEventListener(name, listener) { events.set(name, listener); },
        open(...args) { notifications.push(args); return popup; },
        location: { origin: 'https://benchpoll.test', assign(path) { navigations.push(path); }, replace(path) { navigations.push(path); } } };
}

test('every login entry uses the compact popup and a blocked popup has a real same-window fallback', () => {
    const normal = view(); openSignIn(normal);
    assert.equal(normal.notifications[0][0], '/github_login');
    assert.match(normal.notifications[0][2], /width=480,height=620/);
    assert.equal(normal.notifications[1], 'focus');
    assert.deepEqual(normal.navigations, []);
    for (const open of [() => null, () => { throw new Error('blocked'); }]) {
        const blocked = view(); blocked.open = open; openSignIn(blocked);
        assert.deepEqual(blocked.navigations, ['/github_login']);
    }
});

test('delegated sign-in links do not hijack modified clicks, external targets or handled events', () => {
    const page = view(); const root = { defaultView: page, addEventListener: page.addEventListener };
    installSignInLinks(root); installSignInLinks(root);
    const link = { target: '', hasAttribute: () => false };
    let stopped = 0;
    const event = changes => ({ button: 0, target: { closest: () => link }, preventDefault() { stopped++; }, ...changes });
    for (const changes of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) page.events.get('click')(event(changes));
    link.target = '_blank'; page.events.get('click')(event());
    assert.equal(stopped, 0);
    link.target = ''; page.events.get('click')(event());
    assert.equal(stopped, 1);
    assert.equal(page.notifications[0][0], '/github_login');
});

test('completion notifications require the correct opener source and origin, parse safely and deduplicate channels', () => {
    const page = view(), signals = [];
    openSignIn(page); listenAccountChange(value => signals.push(value), page);
    const signal = JSON.stringify({ date: '2026-10-27T00:00:00.000Z' });
    const event = { origin: page.location.origin, source: page.popup, data: { type: 'benchpoll:sign-in-complete', signal } };
    for (const bad of [{ ...event, source: {} }, { ...event, origin: 'https://other.test' },
        { ...event, data: { type: 'other', signal } }]) page.events.get('message')(bad);
    assert.equal(signals.length, 0);
    for (const newValue of ['broken', '{}', '{"date":3}', '{"date":"invalid"}']) page.events.get('storage')({ key: 'user-profile-update', newValue });
    assert.equal(signals.length, 0);
    page.events.get('message')(event);
    page.events.get('storage')({ key: 'user-profile-update', newValue: signal });
    assert.deepEqual(signals, [{ date: '2026-10-27T00:00:00.000Z' }]);
    page.events.get('storage')({ key: 'user-profile-update', newValue: 'null' });
    assert.equal(signals.at(-1), null);
});

test('successful callbacks work with blocked storage and without an opener', () => {
    const page = view(), messages = [];
    page.localStorage = { setItem() { throw new Error('blocked'); } };
    page.opener = { closed: false, postMessage(...args) { messages.push(args); } };
    page.close = () => messages.push('closed');
    assert.doesNotThrow(() => completeSignIn(page));
    assert.equal(messages[0][0].type, 'benchpoll:sign-in-complete');
    assert.equal(messages[0][1], page.location.origin);
    assert.equal(messages[1], 'closed');
    page.opener = null; completeSignIn(page);
    assert.deepEqual(page.navigations, ['/']);
});

test('completion route checks the actual active account before any success page is served', async () => {
    const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const start = server.indexOf("page.get('/login'");
    const source = server.slice(start, server.indexOf('\n});', start) + 4);
    let handler, active = null;
    vm.runInNewContext(source, { page: { get(_path, callback) { handler = callback; } }, currentDir: '/app',
        activeUserRecord: async ID => { assert.equal(ID, '123'); return active; } });
    const calls = [], response = { set(...args) { calls.push(args); }, redirect(url) { calls.push(['redirect', url]); },
        sendFile(path) { calls.push(['file', path]); } };
    await handler({ query: { complete: '1' }, session: { userID: '123' } }, response);
    assert.deepEqual(calls.at(-1), ['redirect', '/github_login']);
    assert.equal(calls.some(([kind]) => kind === 'file'), false);
    active = { ID: '123' }; await handler({ session: { userID: '123' } }, response);
    assert.deepEqual(calls.at(-1), ['file', '/app/private/loginCallback.html']);
});

test('sign-in success refreshes workspace auth and no longer requires an OK modal', () => {
    const source = readFileSync(new URL('../public/js/home.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../private/home.html', import.meta.url), 'utf8');
    assert.match(source, /await loadUserProfile\(\);\s*await publishWorkspaceState\(\{ accountRefresh: true \}\)/);
    assert.doesNotMatch(source + html, /login-success-dialog/);
});

test('sign-in page has no continue-browsing control', () => {
    const html = readFileSync(new URL('../private/sign-in.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /(?:keep|continue) browsing|class="si-back"/i);
    assert.match(html, /id="sign-in-submit"/);
});

test('canonical GitHub username is recorded inside the authenticated login transaction', () => {
    const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const start = source.indexOf("page.get('/github_callback'");
    const code = source.slice(start, source.indexOf("API.post('/logout'", start));
    const record = code.indexOf('await recordGitHubProfile(loginConnection, userID, userData.login)');
    assert.ok(record > code.indexOf('userRows[0].deleted_at'));
    assert.ok(record < code.indexOf("commitTransactionConnection(loginConnection, 'github-login')"));
    assert.ok(record < code.indexOf('regenerateSession(req)'));
});
