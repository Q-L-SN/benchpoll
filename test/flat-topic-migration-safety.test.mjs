import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBackup } from '../scripts/migrate-flat-topics-20261022.mjs';

test('a malformed or wrong-database backup manifest fails before opening the backup', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'benchpoll-topic-backup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'manifest.json');
    const manifest = { database: 'benchmarks', path: join(directory, 'intentionally-missing.sql.gz'),
        sha256: 'a'.repeat(64), createdAt: new Date().toISOString(), bytes: 2000 };
    for (const change of [{ createdAt: 'invalid' }, { createdAt: null }, { createdAt: '2000-01-01T00:00:00Z' },
        { createdAt: new Date(Date.now() + 86400000).toISOString() }, { database: 'other' }, { sha256: 'bad' }]) {
        await writeFile(path, JSON.stringify({ ...manifest, ...change }));
        await assert.rejects(verifyBackup(path, 'benchmarks'), /Backup manifest does not match/);
    }
    await assert.rejects(verifyBackup(undefined, 'benchmarks'), /fresh backup manifest is required/);
});
