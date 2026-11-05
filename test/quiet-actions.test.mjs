import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');

test('Discussions and sidebar utilities share a quiet secondary-action treatment', () => {
    const html = read('private/home.html'), styles = read('public/css/ui/components.css');
    for (const ID of ['how-it-works-link', 'discussion-entry', 'config-sidebar-toggle']) {
        assert.match(html, new RegExp(`id="${ID}"[^>]*class="[^"]*bp-quiet-action`));
    }
    const rule = styles.match(/\[data-ui-variant="quiet"\]\) \{([^}]+)\}/)[1];
    assert.match(rule, /border: 0;/);
    assert.match(rule, /background: transparent;/);
    assert.match(rule, /text-decoration: none;/);
    assert.match(styles, /> span \{ color: inherit; \}/);
    assert.match(styles, /:is\(:hover, :focus-visible, \[aria-expanded="true"\]\):not\(:disabled\)/);
    assert.match(styles, /:focus-visible \{\s*outline: 2px solid/);
    assert.match(styles, /\[hidden\] \{ display: none; \}/);
    assert.match(read('public/js/shared/ui-components.js'), /\.bp-quiet-action[^\n]+, 'quiet'/);
    assert.doesNotMatch(read('public/css/ui/control-policy.css'), /bp-model-fallback-toggle|border: 1px solid/);
    assert.doesNotMatch(read('public/css/site-palette.css'), /\.bp-discussion-entry/);
});

test('Home Beta feedback remains a visible quiet link rather than a sidebar or primary action', () => {
    const html = read('private/index.html'), styles = read('public/css/topics-home.css');
    const intro = html.match(/<section id="home-hero"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    assert.ok(intro);
    assert.match(intro, /id="beta-feedback-link"[^>]*class="[^"]*th-quiet[^>]*href="\/contribute\/feedback"/);
    assert.match(intro, /BenchPoll is in beta\. Tell us what to improve\./);
    assert.doesNotMatch(html, /<footer class="th-footer/);
    const shared = read('public/js/shared/site-header.js');
    for (const href of ['/terms', '/privacy', '/cookies', '/community-guidelines']) assert.ok(shared.includes(`href="${href}"`));
    assert.doesNotMatch(read('private/home.html'), /id="beta-feedback-link"/);
    const rule = styles.match(/\.th-quiet\s*\{([^}]+)\}/)?.[1];
    assert.ok(rule);
    assert.match(rule, /min-height: 44px/);
    assert.match(rule, /border: 0; background: none/);
    assert.match(rule, /text-decoration: none/);
    assert.match(styles, /\.th-quiet:hover, \.th-quiet:hover i \{ color: var\(--bp-accent\); \}/);
    assert.match(read('public/css/ui/tokens.css'), /:focus-visible\s*\{\s*outline: 2px solid/);
});

test('Public composition stays retired while public fallback inspection and quiet actions remain', () => {
    const html = read('private/home.html'), workspace = read('public/js/home-workspace.js');
    assert.doesNotMatch(html, /public-composition-(?:toggle|pie|list)/);
    assert.doesNotMatch(workspace, /createPublicComposition|publicComposition(?:Toggle|Visible|Svg|List)/);
    assert.match(html, /id="public-fallback-toggle"[^>]+aria-controls="benchmark-settings"/);
    assert.match(workspace, /createFallbackPicker/);
    assert.match(workspace, /publicFamilyComposition/);
    assert.doesNotMatch(read('public/css/ui/navigation.css'), /\.bp-beta-link:hover span\s*\{/);
    assert.doesNotMatch(read('public/css/ui/workspace.css'), /\.bp-public-pie-summary button:hover span\s*\{/);
    assert.match(read('public/css/ui/fallback.css'), /bp-fallback-add-actions > button[^}]+border: 0;[^}]+border-radius: 0/);
});
