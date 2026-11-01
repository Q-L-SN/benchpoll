import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('reply view has return navigation before the original message and a separate replies heading', () => {
    const html = read('private/home.html');
    assert.ok(html.indexOf('id="all-threads"') < html.indexOf('id="thread-root"'));
    assert.ok(html.indexOf('id="thread-root"') < html.indexOf('class="discussion-replies-heading"'));
    assert.ok(html.indexOf('class="discussion-replies-heading"') < html.indexOf('id="discussion-feed"'));
    assert.match(html, /aria-label="Original message"/);
    assert.equal((html.match(/id="all-threads"/g) ?? []).length, 1);
});

test('reply composer uses the shared primary action and quiet secondary controls', () => {
    const html = read('private/home.html');
    assert.match(html, /id="post-discussion" class="discussion-primary bp-ui-action" data-ui-variant="primary"/);
    assert.match(html, /id="mention-button" class="bp-quiet-action"/);
    const css = read('public/css/discussion.css');
    assert.match(css, /discussion-thread-origin \{ display: block/);
    assert.match(css, /\.discussion-filterbar \{ display: none/);
    assert.match(css, /#discussion-feed \.discussion-context-badge \{ display: none/);
    assert.doesNotMatch(css, /border-(left|right):[^;}]*(?:accent|purple)|#436c58|#61977c/);
});
