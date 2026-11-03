import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readRankingContext, rankingContextURL } from '../public/js/shared/ranking-url.js';
import { contributionPath, contributionRoute } from '../public/js/shared/contribution-navigation.js';
import { canonicalRankingEntryURL } from '../ranking-entry-url.js';
import { FEATURED_TOPIC_ID, topicSlug, topicURL, scenePath } from '../public/js/shared/topics.js';
import { searchHead, replaceSearchSlot, renderTopicDirectory, renderPublicTopic, selectSearchScene, PUBLIC_DOCUMENTS } from '../search-presentation.js';

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function routeSource(prefix) {
    const start = serverSource.indexOf(prefix), end = serverSource.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start, `Missing route: ${prefix}`);
    return serverSource.slice(start, end + 4);
}

test('the site root renders the topic index without redirecting to a default topic or losing query parameters', async () => {
    let route, renders = 0;
    const response = { redirect() { assert.fail('The index must not redirect into a topic'); } };
    vm.runInNewContext(routeSource("page.get('/'"), {
        page: { get(path, callback) { assert.equal(path, '/'); route = callback; } },
        searchPresentation: { topics: async () => [] },
        renderIndex: async (res, options) => {
            assert.equal(res, response); renders++;
            const html = options.transformHTML(readFileSync(new URL('../private/index.html', import.meta.url), 'utf8'));
            assert.match(html, /rel="canonical" href="https:\/\/benchpoll.com\/"/);
        }, searchHead, replaceSearchSlot, renderTopicDirectory, PUBLIC_DOCUMENTS, publicOrigin: 'https://benchpoll.com'
    });
    for (const originalUrl of ['/', '/?discussion=42&context_tools=allowed']) {
        await route({ originalUrl }, response);
        assert.equal(canonicalRankingEntryURL(originalUrl, 'https://benchpoll.com'), originalUrl);
    }
    assert.equal(renders, 2);
    assert.equal(FEATURED_TOPIC_ID, 54);
});

test('topic routes canonicalize the slug and retire view mode without discarding context or trusting caller identities', async () => {
    const canonical = topicURL(FEATURED_TOPIC_ID, 'Language models');
    let route;
    const owners = [], renders = [], redirects = [];
    const db = {};
    vm.runInNewContext(routeSource("page.get(['/topics/:categoryID'"), {
        page: { get(paths, callback) { assert.deepEqual([...paths], ['/topics/:categoryID', '/topics/:categoryID/:slug']); route = callback; } },
        db, publicOrigin: 'https://benchpoll.com', URL, selectSearchScene,
        activeSessionUserID: async req => req.session.userID,
        getTopic: async (actualDB, owner, ID) => {
            assert.equal(actualDB, db); assert.equal(ID, FEATURED_TOPIC_ID); owners.push(owner);
            return { ID, url: canonical };
        },
        renderHome: async (_res, options) => renders.push(options)
    });
    const res = { redirect(status, url) { redirects.push({ status, url }); } };
    for (const originalUrl of ['/topics/54?allowed&discussion=1', '/topics/54/old-slug?allowed&discussion=1',
        canonical + '?view=showcase&allowed&discussion=1']) {
        await route({ originalUrl, params: { categoryID: '54' }, session: { userID: null }, query: { userID: '8' } }, res);
        const redirect = redirects.at(-1), target = new URL(redirect.url, 'https://benchpoll.com');
        assert.equal(redirect.status, 302); assert.equal(target.pathname, canonical);
        assert.deepEqual([...target.searchParams], [['allowed', ''], ['discussion', '1']]);
        assert.deepEqual(readRankingContext(target.search, dimensions), { web: 'allowed' });
    }
    await route({ originalUrl: canonical + '?allowed', params: { categoryID: '54' }, session: { userID: '7' } }, res);
    assert.equal(renders.length, 1); assert.equal(renders[0].categoryID, FEATURED_TOPIC_ID); assert.equal(renders[0].guest, false);
    assert.deepEqual(owners, [null, null, null, '7']);
    for (const categoryID of ['0', '01', '-1', '1e2', 'api']) {
        await assert.rejects(route({ params: { categoryID } }, res), error => error.status === 404);
    }
    assert.equal(owners.length, 4, 'Malformed IDs must fail before account/topic lookups');
    assert.equal(canonicalRankingEntryURL(canonical + '?allowed', 'https://benchpoll.com'), canonical + '?allowed');
    assert.equal(serverSource.includes("page.get('/rankings"), false);
});

test('slug-addressed topic labels cannot inject paths and private URLs stay owner-scoped', () => {
    for (const name of ['api', 'privacy', 'terms', 'how-it-works', 'personal', 'topics', 'js', 'css',
        'Language & Writing', 'Part/Other', '<script> Two words', '../api?next=https://evil.test/#fragment', '中文']) {
        const url = new URL(topicURL(17, name), 'https://benchpoll.com');
        assert.equal(url.origin, 'https://benchpoll.com');
        assert.equal(url.pathname, `/${topicSlug(name)}`);
        assert.equal(url.pathname.split('/').length, 2);
        assert.equal(url.search, ''); assert.equal(url.hash, '');
        assert.equal(topicURL(17, name, true), '/personal/17');
    }
    for (const ID of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '../17', null, {}]) assert.throws(() => topicURL(ID, 'Name'));
});

test('short topic pages render directly and retain ranking intent while old taxonomy links redirect', async () => {
    let route;
    const renders = [], redirects = [], lookups = [];
    const topic = { ID: 54, name: 'Intelligence', description: 'Reasoning.', url: '/intelligence', isPrivate: false, scenes: [] };
    vm.runInNewContext(routeSource("page.get('/*any_path'"), {
        page: { get(_path, callback) { route = callback; } }, URL, db: {}, publicOrigin: 'https://benchpoll.com',
        activeSessionUserID: async req => req.session?.userID ?? null,
        findTopicBySlug: async (_db, slug) => { lookups.push(slug); return slug === 'intelligence' ? topic : null; },
        resolveLegacyTopic: async (_db, path) => path === '/Intelligence/Old' ? topic : null,
        searchPresentation: { snapshot: async () => null }, selectSearchScene, renderPublicTopic, scenePath,
        renderHome: async (_res, options) => {
            renders.push(options);
            const html = options.transformHTML(readFileSync(new URL('../private/home.html', import.meta.url), 'utf8'));
            assert.match(html, /Intelligence AI Index/);
        }
    });
    const res = { redirect(status, url) { redirects.push({ status, url }); } };
    const req = originalUrl => ({ originalUrl, session: { userID: null } });
    await route(req('/intelligence?focusModel=42&scoreMode=available&discussion=1'), res, assert.fail);
    assert.equal(renders.length, 1);
    assert.equal(renders[0].categoryID, 54);
    assert.equal(renders[0].guest, true);
    assert.equal(redirects.length, 0);
    for (const path of ['/INTELLIGENCE', '/intelligence/']) {
        await route(req(path + '?focusModel=42'), res, assert.fail);
        assert.equal(redirects.at(-1).url, '/intelligence?focusModel=42');
        assert.equal(redirects.at(-1).status, 308);
    }
    await assert.rejects(route(req('/Intelligence/Old'), res, assert.fail), error => error.status === 404);
    await route(req('/intelligence?view=showcase'), res, assert.fail);
    assert.equal(redirects.at(-1).url, '/');
    let status;
    await route(req('/missing'), res, error => { status = error.status; });
    assert.equal(status, 404);
    assert.ok(lookups.includes('intelligence'));
});

const dimensions = [
    { key: 'web', options: [{ key: 'any', isDefault: true, isNeutral: true }, { key: 'allowed' }] },
    { key: 'code', options: [{ key: 'any', isDefault: true, isNeutral: true }, { key: 'sandboxed' }] },
    { key: 'scope', options: [{ key: 'any', isDefault: true, isNeutral: true }, { key: 'open' }] }
];
test('public roots append the current named default, scene paths render, and old scene queries are rejected', async () => {
    let route;
    const topic = { ID: 54, name: 'Intelligence', url: '/intelligence', scenes: [
        { ID: 10, name: 'Overall', slug: 'overall', isDefault: true },
        { ID: 20, name: 'Real-time', slug: 'real-time', isDefault: false }
    ] };
    const redirects = [], renders = [];
    vm.runInNewContext(routeSource("page.get('/*any_path'"), {
        page: { get(_path, callback) { route = callback; } }, URL, db: {}, publicOrigin: 'https://benchpoll.com',
        findTopicBySlug: async (_db, slug) => slug === 'intelligence' ? topic : null,
        resolveLegacyTopic: async () => null, activeSessionUserID: async () => null,
        selectSearchScene, scenePath, searchPresentation: { snapshot: async () => null },
        renderHome: async (_res, options) => renders.push(options), renderPublicTopic
    });
    const res = { redirect(status, path) { redirects.push({ status, path }); } };
    const request = originalUrl => route({ originalUrl }, res, error => { throw error; });
    await request('/intelligence?focusModel=42&discussion=1');
    assert.deepEqual(redirects.pop(), { status: 302, path: '/intelligence/overall?focusModel=42&discussion=1' });
    await request('/intelligence/overall'); await request('/intelligence/real-time');
    assert.equal(renders.length, 2); assert.equal(redirects.length, 0);
    for (const path of ['/intelligence?scene=10', '/intelligence/overall?scene=10', '/intelligence?context_scene=10', '/intelligence/10', '/intelligence/missing']) {
        await assert.rejects(request(path), error => error.status === 404, path);
    }
    topic.scenes[0].isDefault = false; topic.scenes[1].isDefault = true;
    await request('/intelligence');
    assert.deepEqual(redirects.pop(), { status: 302, path: '/intelligence/real-time' });
});
test('ranking links use bare options and omit neutral defaults without changing selections', () => {
    const old = 'https://benchpoll.com/topics/54/language-models?context_web=allowed&context_code=sandboxed&context_scope=any';
    const values = readRankingContext(new URL(old).search, dimensions);
    const next = rankingContextURL(old, dimensions, values);
    assert.equal(next.search, '?allowed&sandboxed');
    assert.equal(next.pathname, new URL(old).pathname);
    assert.deepEqual(readRankingContext(next.search, dimensions), { web: 'allowed', code: 'sandboxed' });
    assert.equal(rankingContextURL(next.href, dimensions, { web: 'any', code: 'any', scope: 'any' }).search, '');
});
test('shared option names remain explicit and invalid or repeated selections fail', () => {
    const dims = dimensions.slice(0, 2).map(d => ({ ...d, options: [...d.options, { key: 'enabled' }] }));
    const url = rankingContextURL('https://benchpoll.com/?discussion=1', dims, { web: 'enabled', code: 'enabled' });
    assert.equal(url.search, '?web=enabled&code=enabled&discussion=1');
    assert.deepEqual(readRankingContext(url.search, dims), { web: 'enabled', code: 'enabled' });
    for (const query of ['?enabled', '?missing', '?web=bad', '?allowed&context_web=allowed']) {
        assert.throws(() => readRankingContext(query, dims));
    }
});
test('non-default neutral options and URL-encoded names round trip faithfully', () => {
    const dims = [{ key: 'name', options: [{ key: 'any', isNeutral: true, isDefault: false }, { key: 'a&b + c', isDefault: true }] }];
    for (const name of ['any', 'a&b + c']) {
        const url = rankingContextURL('https://benchpoll.com/', dims, { name });
        assert.deepEqual(readRankingContext(url.search, dims), { name });
    }
});
test('contribution identity and operation round trip in paths without metadata', () => {
    for (const [mode, values] of [
        ['new_benchmark', {}], ['new_model', {}], ['benchmark_result', {}], ['feedback', {}],
        ['edit_benchmark', { targetBenchmarkID: '1027' }], ['edit_model', { targetModelID: '42', operation: 'delete' }],
        ['edit_result', { targetResultID: '20' }], ['report', { postID: '50' }]
    ]) {
        const path = contributionPath(mode, values);
        assert.ok(!path.includes('?'));
        assert.deepEqual(contributionRoute(path), { mode, ...values });
    }
    assert.equal(contributionRoute('/contribute/unknown'), null);
    assert.equal(contributionRoute('/contribute/categories/new'), null);
    assert.equal(contributionRoute('/contribute/categories/edit'), null);
    assert.throws(() => contributionPath('new_category'));
    assert.throws(() => contributionPath('delete_or_migrate_category'));
    assert.throws(() => contributionPath('edit_model', { targetModelID: '../20' }));
});
