import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { encryptHandoff, decryptHandoff } from '../scripts/cloud/secure-handoff.mjs';

const entry = (path, text) => ({ path, content: Buffer.from(text).toString('base64'),
    sha256: createHash('sha256').update(text).digest('hex') });
const key = () => randomBytes(32).toString('base64');

test('authenticated handoff encryption restores exact bytes without plaintext in the envelope', () => {
    const secret = key(), files = [entry('access/test.key', 'test-private-content\n'), entry('notes/operations.md', 'Notes')];
    const encrypted = encryptHandoff(files, secret);
    assert.ok(!JSON.stringify(encrypted).includes('test-private-content'));
    assert.notEqual(encryptHandoff(files, secret).nonce, encrypted.nonce);
    assert.deepEqual(decryptHandoff(encrypted, secret).map(file => [file.path, file.bytes.toString()]),
        [['access/test.key', 'test-private-content\n'], ['notes/operations.md', 'Notes']]);
});

test('wrong keys, damaged ciphertext and authentication tags fail closed', () => {
    const secret = key(), encrypted = encryptHandoff([entry('test.txt', 'content')], secret);
    assert.throws(() => decryptHandoff(encrypted, key()), /Cannot decrypt/);
    const data = Buffer.from(encrypted.ciphertext, 'base64'); data[0] ^= 1;
    assert.throws(() => decryptHandoff({ ...encrypted, ciphertext: data.toString('base64') }, secret), /Cannot decrypt/);
    assert.throws(() => decryptHandoff({ ...encrypted, tag: randomBytes(16).toString('base64') }, secret), /Cannot decrypt/);
    for (const length of [4, 8, 12, 13, 14, 15]) {
        const tag = Buffer.from(encrypted.tag, 'base64').subarray(0, length).toString('base64');
        assert.throws(() => decryptHandoff({ ...encrypted, tag }, secret), /Invalid encrypted package/);
    }
    assert.throws(() => decryptHandoff({ ...encrypted, nonce: randomBytes(16).toString('base64') }, secret), /Invalid encrypted package/);
    assert.throws(() => decryptHandoff({ ...encrypted, ciphertext: encrypted.ciphertext + '\n' }, secret), /Invalid encrypted package/);
});

test('unsafe paths, duplicate names and malformed keys or content are rejected', () => {
    for (const path of ['../escape', '/absolute', 'C:/key', 'safe/../../key', '.git/config', '.GIT/config', 'a//b', 'a\\b']) {
        assert.throws(() => encryptHandoff([entry(path, 'x')], key()), /path/);
    }
    assert.throws(() => encryptHandoff([entry('key', 'x'), entry('KEY', 'y')], key()), /duplicate/);
    assert.throws(() => encryptHandoff([entry('key', 'x')], 'not-a-key'), /32-byte/);
    assert.throws(() => encryptHandoff([{ ...entry('key', 'x'), sha256: 'wrong' }], key()), /contents/);
});

test('CLI restores outside Git and refuses overwrite or extraction into a repository', async t => {
    const root = await mkdtemp(join(tmpdir(), 'benchpoll-handoff-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = resolve('scripts/cloud/secure-handoff.mjs'), bundle = join(root, 'package.enc.json'), secret = key();
    await writeFile(bundle, JSON.stringify(encryptHandoff([entry('access/test.key', 'fixture only')], secret)));
    const run = output => spawnSync(process.execPath, [script, 'unpack', '--bundle', bundle, '--output-dir', output],
        { encoding: 'utf8', env: { ...process.env, BENCHPOLL_HANDOFF_KEY: secret } });
    const output = join(root, 'restored');
    assert.equal(run(output).status, 0);
    assert.equal(await readFile(join(output, 'access/test.key'), 'utf8'), 'fixture only');
    assert.notEqual(run(output).status, 0);
    const repo = join(root, 'repo'); await mkdir(join(repo, '.git'), { recursive: true });
    const blocked = run(join(repo, 'private'));
    assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /outside every Git worktree/);
});
