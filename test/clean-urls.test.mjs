import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readRankingContext, rankingContextURL } from '../public/js/shared/ranking-url.js';
import { contributionPath, contributionRoute } from '../public/js/shared/contribution-navigation.js';
import { canonicalRankingEntryURL } from '../ranking-entry-url.js';
import { FEATURED_TOPIC_ID, topicURL, scenePath, parseTopicPath } from '../public/js/shared/topics.js';
import { searchHead, replaceSearchSlot, renderTopicDirectory, PUBLIC_DOCUMENTS } from '../search-presentation.js';

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
    assert.equal(FEATURED_TOPIC_ID, 1);
});

test('contribution identity and operation round trip in paths without metadata', () => {
    for (const [mode, values] of [
        ['new_benchmark', {}], ['new_model', {}], ['benchmark_result', {}], ['feedback', {}],
        ['edit_benchmark', { targetBenchmarkID: '1027' }], ['edit_model', { targetModelID: '42', operation: 'delete' }],
        ['edit_result', { targetResultID: '20' }], ['report', { postID: '50' }],
        ['topic_report', { targetCategoryID: '54' }]
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


test('topic labels cannot change numeric public or opaque private addresses', () => {
    for (const name of ['api', 'privacy', 'Part/Other', '<script>', '../api?next=https://evil.test/#fragment', '中文']) {
        assert.equal(topicURL({ publicID: 17, name }), '/17');
        assert.equal(topicURL({ publicID: 17, privateID: 'AbCdEf123456', isPrivate: true, name }), '/private/AbCdEf123456');
    }
    for (const ID of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '../17', null, {}]) assert.throws(() => topicURL(ID, 'Name'));
    assert.throws(() => topicURL({ publicID: 17, isPrivate: true }));
    assert.equal(scenePath('/17', { ID: 300, sceneNumber: 2, name: 'C++' }), '/17/2');
    assert.equal(scenePath('/private/AbCdEf123456/3', { ID: 301, sceneNumber: 4 }), '/private/AbCdEf123456/4');
});

test('only numeric topic paths and numeric local scenes are parsed', () => {
    assert.deepEqual(parseTopicPath('/17/2'), { publicID: 17, sceneNumber: 2 });
    assert.deepEqual(parseTopicPath('/private/AbCdEf123456/2'), { privateID: 'AbCdEf123456', sceneNumber: 2 });
    for (const path of ['/topics/17', '/personal/17', '/intelligence', '/17/overall', '/01', '/17/0', '/17?scene=2']) {
        assert.equal(parseTopicPath(path), null, path);
    }
    assert.match(serverSource, /page\.get\('\/\*any_path', createTopicPageHandler/);
    assert.doesNotMatch(serverSource, /findTopicBySlug|resolveLegacyTopic|page\.get\('\/personal|page\.get\(\['\/topics/);
});

test('ranking links use local scene numbers while retaining unrelated intent parameters', () => {
    const scenes = [{ ID: 300, sceneNumber: 1 }, { ID: 400, sceneNumber: 2 }];
    const next = rankingContextURL('https://benchpoll.com/17/1?focusModel=42', [], { scene: '400' }, scenes);
    assert.equal(next.pathname, '/17/2');
    assert.equal(next.search, '?focusModel=42');
    assert.deepEqual(readRankingContext(next.search), {});
    assert.throws(() => rankingContextURL('https://benchpoll.com/17', [], { scene: '999' }, scenes));
    for (const search of ['?scene=300', '?context_scene=300', '?context_web=allowed']) {
        assert.throws(() => readRankingContext(search));
    }
    assert.throws(() => rankingContextURL('https://benchpoll.com/intelligence'));
});
