import test from 'node:test';
import assert from 'node:assert/strict';
import { readRankingContext, rankingContextURL } from '../public/js/shared/ranking-url.js';
import { contributionPath, contributionRoute } from '../public/js/shared/contribution-navigation.js';

const dimensions = [
    { key: 'web', options: [{ key: 'any', isDefault: true, isNeutral: true }, { key: 'allowed' }] },
    { key: 'code', options: [{ key: 'any', isDefault: true, isNeutral: true }, { key: 'sandboxed' }] },
    { key: 'scope', options: [{ key: 'any', isDefault: true, isNeutral: true }, { key: 'open' }] }
];
test('ranking links use bare options and omit neutral defaults without changing selections', () => {
    const old = 'https://benchpoll.com/rankings/AI-Evaluation/Agentic-Workflows-and-Tool-Use?context_web=allowed&context_code=sandboxed&context_scope=any';
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
    assert.throws(() => contributionPath('edit_model', { targetModelID: '../20' }));
});
