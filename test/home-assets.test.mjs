import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHomeAssetRenderer } from '../home-assets.js';
import { buildHomeAssets } from '../scripts/build-home-assets.mjs';

test('home bundles keep independent module entry points, styles and source identities', async () => {
    await buildHomeAssets();
    const manifest = JSON.parse(await readFile(new URL('../private/home-assets.json', import.meta.url), 'utf8'));
    assert.ok(manifest.sources.length > 60);
    const html = await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8');
    assert.equal([...html.matchAll(/<script src="\/build\/home\//g)].length, 3);
    assert.equal([...html.matchAll(/rel="stylesheet"/g)].length, 1);
    assert.doesNotMatch(html, /modulepreload.*\/js\//);
    assert.match(html, /<script>.*__benchpollInitialReads/);
    assert.doesNotMatch(html, /src="\/js\/home-startup\.js/);
    assert.equal(createHash('sha256').update(html).digest('hex'), manifest.htmlHash);
    for (const file of manifest.files) assert.ok((await stat(new URL('../' + file, import.meta.url))).isFile());
});

test('a concurrent source edit immediately selects current HTML instead of the old compiled UI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchpoll-home-assets-'));
    await mkdir(join(root, 'private')); await mkdir(join(root, 'public/js'), { recursive: true });
    const source = '<html>current source</html>', compiled = '<html><head></head><body>built source</body></html>', module = 'export const version = 1;';
    const hash = value => createHash('sha256').update(value).digest('hex');
    await writeFile(join(root, 'private/home.html'), source);
    await writeFile(join(root, 'private/home-built.html'), compiled);
    await writeFile(join(root, 'public/js/home.js'), module);
    const manifest = { version: 1, htmlHash: hash(compiled), files: ['private/home-built.html'],
        sources: [{ path: 'private/home.html', sha256: hash(source) }, { path: 'public/js/home.js', sha256: hash(module) }] };
    await writeFile(join(root, 'private/home-assets.json'), JSON.stringify(manifest));
    let sent, fallback;
    const response = { type() { return this; }, send(bytes) { sent = bytes.toString(); }, sendFile(path) { fallback = path; } };
    const render = createHomeAssetRenderer(root);
    await render(response); assert.equal(sent, compiled); assert.equal(fallback, undefined);
    await render(response, { categoryID: 54, guest: true });
    assert.match(sent, /<head><meta name="benchpoll-startup-category" content="54" data-guest="true">/);
    await render(response, { categoryID: 'unsafe"', guest: true }); assert.equal(sent, compiled);
    await writeFile(join(root, 'public/js/home.js'), 'export const version = 2;');
    sent = null; await render(response); assert.equal(sent, null); assert.equal(fallback, join(root, 'private/home.html'));
    await writeFile(join(root, 'public/js/home.js'), module);
    sent = null; fallback = null; await render(response); assert.equal(sent, compiled); assert.equal(fallback, null);
});

test('no build is required for the source-only development server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchpoll-home-unbuilt-'));
    let fallback;
    await createHomeAssetRenderer(root)({ sendFile(path) { fallback = path; } });
    assert.equal(fallback, join(root, 'private/home.html'));
});
