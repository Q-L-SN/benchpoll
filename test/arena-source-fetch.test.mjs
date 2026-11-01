import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildArenaSourceManifest, fetchArenaConfigs, verifyArenaSourceFile } from '../arena-source-fetch.js';

const revision = 'a'.repeat(40);
const bytes = new TextEncoder().encode('Parquet fixture').buffer;
const sha256 = createHash('sha256').update(Buffer.from(bytes)).digest('hex');

function metadata() {
    return { sha: revision, cardData: { license: 'cc-by-4.0', configs: [
        { config_name: 'text', data_files: [{ split: 'latest', path: 'text/latest-*' }] },
        { config_name: 'vision', data_files: [{ split: 'latest', path: 'vision/latest-*' }] }
    ] }, siblings: [
        { rfilename: 'vision/latest-00000-of-00001.parquet', size: bytes.byteLength, lfs: { sha256, size: bytes.byteLength } },
        { rfilename: 'README.md' },
        { rfilename: 'text/full-00000-of-00001.parquet' },
        { rfilename: 'text/latest-00001-of-00002.parquet', size: bytes.byteLength, lfs: { sha256, size: bytes.byteLength } },
        { rfilename: 'text/latest-00000-of-00002.parquet', size: bytes.byteLength, lfs: { sha256, size: bytes.byteLength } }
    ] };
}

test('Arena files are pinned to an immutable revision and exclude every historical shard', () => {
    const manifest = buildArenaSourceManifest(metadata(), revision);
    assert.deepEqual(manifest.configs, ['text', 'vision']);
    assert.deepEqual(manifest.files.map(file => file.sourcePath), [
        'text/latest-00000-of-00002.parquet', 'text/latest-00001-of-00002.parquet',
        'vision/latest-00000-of-00001.parquet'
    ]);
    assert.deepEqual(manifest.files.map(file => file.filename), ['0000.parquet', '0001.parquet', '0000.parquet']);
    for (const file of manifest.files) {
        assert.match(file.url, new RegExp(`/resolve/${revision}/`));
        assert.equal(file.url.includes('convert'), false);
        assert.equal(file.sha256, sha256);
    }
});

test('revision races, changed license or changed source-file layout fail explicitly', () => {
    for (const mutate of [
        value => { value.sha = 'b'.repeat(40); },
        value => { value.cardData.license = 'unknown'; },
        value => { value.cardData.configs[0].data_files[0].path = 'https://example.com/file'; },
        value => { value.cardData.configs[0].data_files = {}; },
        value => { value.cardData.configs.push(value.cardData.configs[0]); },
        value => { value.siblings[0].rfilename = 'unknown/latest-00000-of-00001.parquet'; },
        value => { value.siblings[0].rfilename = 'vision/latest-broken.parquet'; }
    ]) {
        const value = metadata();
        mutate(value);
        assert.throws(() => buildArenaSourceManifest(value, revision));
    }
});

test('missing, duplicate, misnumbered and inconsistent shards cannot form a partial manifest', () => {
    for (const mutate of [
        value => { value.siblings.pop(); },
        value => { value.siblings.shift(); },
        value => { value.siblings.push(value.siblings[0]); },
        value => { value.siblings[3].rfilename = 'text/latest-00002-of-00002.parquet'; },
        value => { value.siblings[3].rfilename = 'text/latest-00001-of-00003.parquet'; },
        value => { value.siblings[0].size = 0; },
        value => { value.siblings[0].lfs.size += 1; },
        value => { value.siblings[0].lfs.sha256 = 'broken'; }
    ]) {
        const value = metadata();
        mutate(value);
        assert.throws(() => buildArenaSourceManifest(value, revision));
    }
});

test('download bytes must match both the declared size and the revision-pinned LFS checksum', () => {
    const source = buildArenaSourceManifest(metadata(), revision).files[0];
    assert.equal(verifyArenaSourceFile(source, bytes).sha256, sha256);
    assert.throws(() => verifyArenaSourceFile(source, bytes.slice(1)), /Truncated/);
    const altered = bytes.slice(0);
    new Uint8Array(altered)[0] ^= 1;
    assert.throws(() => verifyArenaSourceFile(source, altered), /checksum mismatch/);
});

test('a failed download does not cancel or omit another feed, even with a serial fetch schedule', async () => {
    const attempted = [];
    const feeds = await fetchArenaConfigs(['text', 'vision', 'webdev'], async config => {
        attempted.push(config);
        if (config === 'vision') throw new Error('503 downloading vision');
        return { config, rows: [1] };
    }, { concurrency: 1 });
    assert.deepEqual(attempted, ['text', 'vision', 'webdev']);
    assert.deepEqual(feeds, [
        { config: 'text', rows: [1] }, { config: 'vision', fetchError: '503 downloading vision' },
        { config: 'webdev', rows: [1] }
    ]);
});

test('all concurrent work is awaited and each feed failure is retained', async () => {
    const feeds = await fetchArenaConfigs(['text', 'vision', 'webdev'], async config => {
        if (config === 'text') await new Promise(resolve => setTimeout(resolve, 10));
        if (config === 'webdev') throw new Error('Bad parquet');
        return { config, rows: [] };
    });
    assert.deepEqual(feeds.map(feed => feed.config), ['text', 'vision', 'webdev']);
    assert.equal(feeds[2].fetchError, 'Bad parquet');
    assert.equal(feeds[0].fetchError, undefined);
});

test('mislabeled output cannot be applied to another feed and invalid schedules fail', async () => {
    const [feed] = await fetchArenaConfigs(['text'], async () => ({ config: 'vision' }));
    assert.match(feed.fetchError, /different config/);
    await assert.rejects(fetchArenaConfigs(['text', 'text'], async () => ({})), /Invalid Arena fetch schedule/);
    await assert.rejects(fetchArenaConfigs(['text'], async () => ({}), { concurrency: 0 }), /Invalid Arena fetch schedule/);
});
