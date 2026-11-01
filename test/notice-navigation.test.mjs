import assert from 'node:assert/strict';
import test from 'node:test';
import { noticeNavigationTarget } from '../public/js/shared/notice-navigation.js';

const origin = 'https://benchpoll.com';
test('notice navigation keeps same-origin paths, query strings and anchors', () => {
    for (const input of ['/Intelligence?windows#scores', `${origin}/contribute/scores/new`, '/']) {
        const expected = new URL(input, origin);
        assert.equal(noticeNavigationTarget(input, origin), expected.pathname + expected.search + expected.hash);
    }
});
test('notice navigation rejects script URLs, external origins and credentials', () => {
    for (const input of [null, '', '   ', 'javascript:alert(1)', 'data:text/html,test', 'file:///test',
        'https://example.com/path', '//example.com/path', 'http://benchpoll.com/path',
        'https://benchpoll.com@example.com/', 'https://user:password@benchpoll.com/', 'http://[invalid']) {
        assert.equal(noticeNavigationTarget(input, origin), null, String(input));
    }
});
