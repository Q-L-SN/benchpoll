import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rehearseProposalLimits } from '../ops/rehearse-topic-proposal-limits-20261028.mjs';

test('business fixtures reject production and unrelated databases before any write or pool creation', async () => {
    for (const name of ['benchmarks', 'benchpoll_accounts_rehearsal_other', 'benchpoll_accounts_rehearsal_12_other']) {
        const calls = [];
        await assert.rejects(rehearseProposalLimits({ async query(sql) {
            calls.push(sql); return [[{ name }]];
        } }, {}, () => assert.fail('No service may be created')), /release-owned isolated database/);
        assert.deepEqual(calls, ['SELECT DATABASE() AS name']);
    }
});

test('schema preparation refuses unknown stage names before opening a database connection', () => {
    const script = fileURLToPath(new URL('../ops/prepare-topic-proposal-limits-20261028.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '/home/ubuntu/benchpoll', 'rehearse'], { encoding: 'utf8',
        env: { ...process.env, BENCHPOLL_DB_HOST: 'invalid.example.test' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe proposal limits stage/);
});

test('rehearsal retains foreign keys and generated columns and removes only its own created database', async () => {
    const source = await readFile(new URL('../ops/prepare-topic-proposal-limits-20261028.mjs', import.meta.url), 'utf8');
    assert.match(source, /SHOW CREATE TABLE/);
    assert.match(source, /COALESCE\(GENERATION_EXPRESSION, ''\) = ''/);
    assert.match(source, /CREATE DATABASE/);
    assert.doesNotMatch(source, /CREATE DATABASE IF NOT EXISTS/);
    assert.match(source, /if \(created\) await source\.query\(`DROP DATABASE/);
    assert.match(source, /businessRules\?\.passed !== true/);
    assert.match(source, /await fileHash\(backup\.path\) !== backup\.sha256/);
    assert.match(source, /JSON\.stringify\(await preserved\(source\)\) !== JSON\.stringify\(before\)/);
});
