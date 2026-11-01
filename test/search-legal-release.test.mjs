import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SEARCH_LEGAL_SOURCES, isSearchLegalPath } from '../ops/search-legal-paths-20261101.mjs';

test('search/legal release is restricted to reviewed sources and generated home assets', async () => {
    for (const path of SEARCH_LEGAL_SOURCES) assert.equal(isSearchLegalPath(path), true, path);
    for (const path of ['public/build/home/chunk-ABC.js', 'public/build/index/styles-ABC.css', 'private/home-assets.json', 'private/index-built.html']) {
        assert.equal(isSearchLegalPath(path), true, path);
    }
    for (const path of ['.env', 'db.js', 'ranking-service.js', 'package.json', 'private/censor.html', 'public/js/home.js',
        'public/build/home/../attack.js', 'public/build/home/key.pem', '/server.js', 'scripts/migration.mjs']) {
        assert.equal(isSearchLegalPath(path), false, path);
    }
    for (const path of ['ops/launch-release.mjs', 'ops/flat-topics-stage-20261022.mjs']) {
        const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
        assert.match(source, /search-legal-20261101/);
        assert.match(source, /isSearchLegalPath/);
        assert.match(source, /migration !== null/);
    }
});

test('release exporter overlays partial manifests without losing unchanged baseline files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'benchpoll-release-baselines-'));
    const sources = [];
    for (const path of SEARCH_LEGAL_SOURCES) {
        const bytes = await readFile(new URL('../' + path, import.meta.url));
        sources.push({ path, before: createHash('sha256').update(bytes).digest('hex') });
    }
    const changed = sources.find(row => row.path === 'private/home.html');
    const old = join(directory, 'older.json'), recent = join(directory, 'recent.json');
    await writeFile(old, JSON.stringify({ sources: sources.map(row => row === changed ? { ...row, before: '0'.repeat(64) } : row), files: [] }));
    await writeFile(recent, JSON.stringify({ sources: [], files: [{ path: changed.path, after: changed.before }] }));
    const output = join(directory, 'export');
    const result = spawnSync(process.execPath, ['ops/export-search-legal-20261101.mjs', output, old, recent], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(output, 'request.json'), 'utf8')), { migration: null, files: [] });
});
