import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import express from 'express';
import { createSearchPresentation, searchHead, discoveryRobots, discoverySitemap, discoveryText,
    renderTopicDirectory, renderPublicTopic, renderPublicSnapshot, selectSearchScene,
    replaceSearchSlot, searchIndexingHeaders, PUBLIC_DOCUMENTS, escapeHTML } from '../search-presentation.js';
import { topicSearchMetadata, updateTopicSearchMetadata } from '../public/js/shared/search-metadata.js';

const origin = 'https://benchpoll.com';
const topic = { ID: 54, name: 'Intelligence', url: '/intelligence', description: 'Reasoning and knowledge.',
    isPrivate: false, hasWeights: true, scenes: [
        { ID: 101, name: 'Overall', description: 'Overall capability.', isDefault: true },
        { ID: 102, name: 'Real-time', description: 'Real-time capability.', isDefault: false }
    ] };
const privateTopic = { ...topic, ID: 55, name: 'Secret project', url: '/personal/55', isPrivate: true };
const snapshot = { models: [
    { modelName: 'Model A', lower: 75.32, coverage: 82.5, comparable: true },
    { modelName: 'Unranked', lower: 0, coverage: 0, comparable: false },
    { modelName: 'Invalid', lower: NaN, coverage: 0, comparable: true }
], weights: [{ name: 'Test A', conditionName: 'v1', weightBasisPoints: 10000 }] };

test('all scenes have named canonical paths, including the default', () => {
    assert.equal(topicSearchMetadata(topic).path, '/intelligence/overall');
    assert.equal(topicSearchMetadata(topic, 101).path, '/intelligence/overall');
    assert.equal(topicSearchMetadata(topic, 102).path, '/intelligence/real-time');
    assert.equal(topicSearchMetadata(topic, 102).title, 'Intelligence: Real-time AI Index | BenchPoll');
    assert.match(topicSearchMetadata(topic, 102).description, /^Real-time capability/);
    assert.equal(selectSearchScene(topic, new URLSearchParams()).ID, 101);
    assert.equal(selectSearchScene(topic, new URLSearchParams(), 'real-time').ID, 102);
    for (const query of ['scene=102', 'context_scene=101', 'scene=', 'scene=0', 'scene=103', 'scene=101&scene=102', 'scene=01', 'scene=-1', 'scene=9007199254740993']) {
        assert.throws(() => selectSearchScene(topic, new URLSearchParams(query)), error => error.status === 404, query);
    }
});

test('public discovery excludes private records and emits only canonical scene addresses', () => {
    for (const render of [discoverySitemap, discoveryText, renderTopicDirectory]) {
        const text = render([topic, privateTopic], origin);
        assert.doesNotMatch(text, /Secret project|personal\/55/);
        assert.match(text, /intelligence\/real-time/);
        assert.doesNotMatch(text, /scene=101/);
    }
    const xml = discoverySitemap([topic], origin);
    assert.equal([...xml.matchAll(/<url>/g)].length, PUBLIC_DOCUMENTS.length + 2);
    assert.match(xml, /<lastmod>2026-11-04<\/lastmod>/);
    const robots = discoveryRobots(origin);
    assert.match(robots, /Disallow: \/personal\//);
    assert.match(robots, /Sitemap: https:\/\/benchpoll.com\/sitemap.xml/);
    assert.doesNotMatch(robots, /Disallow: \/(?:js|css|assets)/);
    assert.match(discoveryText([topic], origin), /Benchmark evidence supplies measured results/);
});

test('HTML, XML and JSON-LD treat user-provided text as data, not markup', () => {
    const hostile = { ...topic, name: '</script><script>alert(1)</script>', description: 'x & "y" <b>', scenes: [] };
    const head = searchHead(topicSearchMetadata(hostile), origin);
    assert.equal([...head.matchAll(/<script\b/g)].length, 1);
    assert.match(head, /&lt;\/script&gt;/);
    const data = JSON.parse(head.match(/type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.match(data['@graph'][2].name, /<script>/);
    assert.doesNotMatch(renderTopicDirectory([hostile]), /<script>/);
    assert.match(renderTopicDirectory([hostile]), /x &amp; &quot;y&quot; &lt;b&gt;/);
    assert.throws(() => replaceSearchSlot('<html></html>', 'metadata', ''), /Missing search presentation slot/);
});

test('public snapshot uses percentage units and only eligible comparable rows in visible text and structured data', async () => {
    const html = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    const result = renderPublicTopic(html, topic, topic.scenes[1], snapshot, origin);
    assert.match(result, /Measured coverage/);
    assert.match(result, />82.5%<\/td>/);
    assert.doesNotMatch(result, /8250%|Unranked|Invalid|NaN/);
    assert.match(result, /href="https:\/\/benchpoll.com\/intelligence\/real-time"/);
    assert.match(result, /Test A<small>v1<\/small>/);
    const graph = JSON.parse(result.match(/type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
    assert.deepEqual(graph.find(item => item['@type'] === 'ItemList').itemListElement.map(item => item.name), ['Model A']);
    assert.throws(() => renderPublicTopic(html, privateTopic, null, snapshot, origin), /Only public topics/);
    assert.deepEqual(renderPublicSnapshot(null), { models: '', weights: '' });
});

test('public catalogue caches with single flight, expires, invalidates and retries errors', async () => {
    let calls = 0, now = 0, fail = false;
    const service = createSearchPresentation({ origin, now: () => now, loadTopics: async () => {
        calls++; if (fail) throw new Error('offline'); return { topics: [topic, privateTopic] };
    } });
    const [a, b] = await Promise.all([service.topics(), service.topics()]);
    assert.deepEqual(a, [topic]); assert.equal(a, b); assert.equal(calls, 1);
    now = 60001; await service.topics(); assert.equal(calls, 2);
    service.invalidate(); fail = true; await assert.rejects(service.topics(), /offline/);
    fail = false; await service.topics(); assert.equal(calls, 4);
    assert.throws(() => createSearchPresentation({ origin: 'ftp://example.com' }), /HTTP/);
});

test('crawler previews are public-only, bounded, deduplicated and do not block on slow rankings', async () => {
    const pending = [], calls = [];
    const service = createSearchPresentation({ origin, snapshotWaitMs: 10, loadPreview: body => {
        calls.push(body); return new Promise(resolve => pending.push(resolve));
    } });
    assert.equal(await service.snapshot(privateTopic, null), null);
    assert.equal(await service.snapshot({ ...topic, hasWeights: false }, null), null);
    const first = service.snapshot(topic, topic.scenes[0]);
    const duplicate = service.snapshot(topic, topic.scenes[0]);
    const second = service.snapshot(topic, topic.scenes[1]);
    assert.equal(await service.snapshot({ ...topic, ID: 60 }, null), null);
    assert.deepEqual(await Promise.all([first, duplicate, second]), [null, null, null]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { categoryID: 54, sceneID: 101, scoreMode: 'available', reasoning: false, harness: false });
    pending.forEach(resolve => resolve(snapshot));
    await new Promise(resolve => setImmediate(resolve));
    const third = service.snapshot({ ...topic, ID: 60 }, null);
    await new Promise(resolve => setImmediate(resolve));
    pending[2](snapshot);
    assert.equal(await third, snapshot);
});

test('private/action pages send noindex while public pages and assets remain crawlable', () => {
    for (const path of ['/personal/5', '/account/privacy', '/api/get_weights', '/contribute', '/sign-in', '/topic-proposals', '/dialogPage', '/adminlogin', '/github_callback']) {
        const headers = {};
        searchIndexingHeaders({ path }, { set: (key, value) => { headers[key] = value; } }, () => {});
        assert.equal(headers['X-Robots-Tag'], 'noindex, nofollow, nosnippet', path);
    }
    for (const path of ['/', '/intelligence', '/terms', '/js/topics-home.js']) {
        searchIndexingHeaders({ path }, { set() { assert.fail(path); } }, () => {});
    }
});

test('metadata follows scene navigation without retaining a stale ranking or breadcrumb', () => {
    const nodes = new Map();
    const canonical = { href: origin + '/intelligence' };
    const structured = { textContent: JSON.stringify({ '@graph': [
        { '@type': 'WebPage', '@id': canonical.href + '#page', url: canonical.href, mainEntity: {}, breadcrumb: {} },
        { '@type': 'ItemList' }, { '@type': 'BreadcrumbList' }, { '@type': 'Organization' }
    ] }) };
    nodes.set('link[rel="canonical"]', canonical); nodes.set('#bp-search-structured-data', structured);
    const root = { querySelector: selector => nodes.get(selector) };
    updateTopicSearchMetadata(topic, 102, root);
    assert.equal(root.title, 'Intelligence: Real-time AI Index | BenchPoll');
    assert.equal(canonical.href, origin + '/intelligence/real-time');
    const graph = JSON.parse(structured.textContent)['@graph'];
    assert.equal(graph.length, 2); assert.equal(graph[0].mainEntity, undefined); assert.equal(graph[0].breadcrumb, undefined);
    updateTopicSearchMetadata(topic, 101, root);
    assert.equal(canonical.href, origin + '/intelligence/overall');
});

test('legal and methodology pages have canonical social metadata without changing their no-script content', async () => {
    for (const item of PUBLIC_DOCUMENTS.filter(item => item.path !== '/')) {
        const html = await readFile(new URL('../private' + item.path + '.html', import.meta.url), 'utf8');
        assert.match(html, new RegExp('<link rel="canonical" href="' + origin + item.path + '"'));
        assert.match(html, /name="twitter:card" content="summary_large_image"/);
        assert.match(html, /property="og:image"/);
        assert.match(html, /<h1>/);
    }
});

test('real error handler returns crawlable error status rather than redirecting into a soft 404', async t => {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const pageErrorHTML = await readFile(new URL('../private/dialogPage.html', import.meta.url), 'utf8');
    const start = source.lastIndexOf('app.use((err, req, res, next)');
    const app = express();
    app.get('/missing/:status', (req, _res, next) => { req.errorFrom = 'page'; next({ status: Number(req.params.status) }); });
    vm.runInNewContext(source.slice(start, source.indexOf('\nconst options = {', start)), {
        app, pageErrorHTML, escapeHTML, URLSearchParams, databaseErrorResponse: () => null, console: { error() {} }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    for (const status of [404, 410, 503]) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/missing/${status}`, { redirect: 'manual' });
        assert.equal(response.status, status);
        assert.equal(response.headers.get('location'), null);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('x-robots-tag'), /noindex/);
        const html = await response.text();
        assert.match(html, /name="benchpoll-page-error"/);
        assert.match(html, /src="\/js\/dialogPage.js/);
        assert.doesNotMatch(html, /src="\.\//);
    }
});

test('discovery routes support HEAD, remain session-free and do not intercept regular pages', async t => {
    const service = createSearchPresentation({ origin, loadTopics: async () => ({ topics: [topic, privateTopic] }) });
    const app = express();
    app.use(service.middleware);
    app.use((_req, res) => res.status(418).end());
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/robots.txt', '/sitemap.xml', '/llms.txt']) {
        const response = await fetch(url + path);
        assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
        assert.match(response.headers.get('cache-control'), /public/);
        assert.doesNotMatch(await response.text(), /Secret project/);
        const head = await fetch(url + path, { method: 'HEAD' });
        assert.equal(head.status, 200); assert.equal(await head.text(), '');
    }
    assert.equal((await fetch(url + '/ordinary')).status, 418);
});
