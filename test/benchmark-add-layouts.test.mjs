import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
test('chosen layouts are fixed in markup and old preferences cannot override them', async () => {
    const html = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    assert.match(html, /data-contribution-layout="heading"/);
    assert.match(html, /data-add-layout="label"/);
    assert.doesNotMatch(html, /workspace-style|bp-style-menu|data-layout-option|contribution-tools|contribution-footer/);
    assert.match(html, /<h2 id="benchmark-heading">Evaluation items<\/h2>\s*<a id="contribute-button"/);
});

test('unused layout alternatives are removed rather than hidden', async () => {
    await assert.rejects(readFile(new URL('../public/js/workspace/style-previews.js', import.meta.url)), { code: 'ENOENT' });
    for (const path of ['benchmark-add-layouts', 'contribution-layouts']) {
        const css = await readFile(new URL(`../public/css/ui/${path}.css`, import.meta.url), 'utf8');
        assert.doesNotMatch(css, /bp-style-menu|data-add-layout="(?:rail|below)"|data-contribution-layout="(?:toolbar|footer)"/);
    }
});

test('fixed layouts preserve separate add and inspection actions', async () => {
    const workspace = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const html = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    assert.doesNotMatch(workspace, /stylePreviews|createWorkspaceStylePreviews/);
    assert.match(workspace, /addObjectToFallbackChain\(object\)/);
    assert.match(workspace, /addObjectToPersonalPie\(object\)/);
    assert.doesNotMatch(html, /id="inline-fallback-count"/);
    assert.doesNotMatch(html, /benchmark-(?:add|chain)-layout-toggle/);
    assert.doesNotMatch(html, /data-style-kind="chain"|data-chain-layout/);
});

test('no page uses left accent stripes or crescent borders', async () => {
    const root = new URL('../public/css/', import.meta.url);
    const paths = [...(await readdir(root)).filter(path => path.endsWith('.css')),
        ...(await readdir(new URL('ui/', root))).filter(path => path.endsWith('.css')).map(path => `ui/${path}`)];
    for (const path of paths) {
        const css = await readFile(new URL(path, root), 'utf8');
        assert.doesNotMatch(css, /border-(?:left|inline-start)(?:-color)?\s*:[^;]*var\(--bp-(?:accent|purple|fill|family-color)/i, path);
        assert.doesNotMatch(css, /box-shadow\s*:[^;]*inset\s+[23456789]\d*px\s+0\s/i, path);
    }
    assert.match(await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8'), /全站永远不要使用重点色的“月牙边框”或单侧色条/);
});
