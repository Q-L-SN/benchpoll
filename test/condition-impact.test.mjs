import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionImpact } from '../condition-impact.js';

test('impact counts distinct personal mixes and checks condition ownership before counting', async () => {
    const statements = [];
    const connection = { async execute(sql, params) {
        statements.push({ sql, params });
        if (sql.startsWith('SELECT ID FROM benchmark_conditions')) return [[{ ID: 1 }], []];
        if (sql.includes('AS linked_pies')) return [[{ resultCount: 5, pieCount: 2 }], []];
        throw Error('Unexpected query');
    } };
    assert.deepEqual(await conditionImpact(connection, 'benchmark', 10, 1), { resultCount: 5, pieCount: 2 });
    assert.deepEqual(statements[0].params, [1, 10]);
    assert.match(statements[1].sql, /UNION SELECT ID AS pie_ID FROM personal_pies/);
    assert.match(statements[1].sql, /JSON_CONTAINS\(estimation_votes, JSON_OBJECT\('conditionID', CAST\(\? AS UNSIGNED\)\)\)/);
    assert.deepEqual(statements[1].params, [1, 1, 1]);
});
