import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { serializeRankingContextValues } from '../ranking-service.js';

const source = await readFile(new URL('../ranking-service.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function requestError('), source.indexOf('function parseFiniteNumber('));
const contextFunctions = source.slice(source.indexOf('async function findContext('), source.indexOf('function parseContextValues('));
function harness(results) {
    const calls = [];
    const context = vm.createContext({ serializeRankingContextValues });
    vm.runInContext(`${helpers}\n${contextFunctions}`, context);
    const connection = { async execute(sql, args) {
        calls.push({ sql, args: Array.from(args) });
        const result = results.shift();
        assert.notEqual(result, undefined, `Unexpected SQL: ${sql}`);
        return [result];
    } };
    return { ensure: () => context.ensureContext(connection, 1, {}), calls };
}

for (let attempt = 1; attempt <= 2; attempt++) {
    test(`existing contexts are reused without trigger-bearing upserts (${attempt})`, async () => {
        const { ensure, calls } = harness([[{ ID: 7 }]]);
        assert.equal((await ensure()).ID, 7);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, [1, serializeRankingContextValues({}).contextHash]);
        assert.doesNotMatch(calls[0].sql, /INSERT|UPDATE|FOR SHARE/);
    });
    test(`a concurrent upsert returning zero uses a current locking read (${attempt})`, async () => {
        const { ensure, calls } = harness([[], { insertId: 0 }, [{ ID: 8 }]]);
        assert.equal((await ensure()).ID, 8);
        assert.match(calls[1].sql, /ON DUPLICATE KEY/);
        assert.match(calls[2].sql, /LIMIT 1 FOR SHARE/);
        assert.deepEqual(calls[0].args, calls[2].args);
    });
}
test('a newly inserted context uses its safe ID without extra queries', async () => {
    const { ensure, calls } = harness([[], { insertId: 9 }]);
    assert.equal((await ensure()).ID, 9); assert.equal(calls.length, 2);
});
test('a missing context after upsert still fails rather than posting without a context', async () => {
    const { ensure } = harness([[], { insertId: 0 }, []]);
    await assert.rejects(ensure(), error => error.status === 500 && error.body.error === 'ranking_context_upsert_failed');
});
