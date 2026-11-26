import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionImpact } from '../condition-impact.js';

test('impact checks condition ownership and counts distinct personal pies and estimation pairs separately', async () => {
    const statements = [];
    const connection = { async execute(sql, params) {
        statements.push({ sql, params });
        if (sql.startsWith('SELECT ID FROM benchmark_conditions')) return [[{ ID: 1 }], []];
        if (sql.includes('AS estimation_pairs')) return [[{ resultCount: '5', pieCount: '2', estimationPairCount: '3' }], []];
        throw Error('Unexpected query');
    } };
    assert.deepEqual(await conditionImpact(connection, 'benchmark', 10, 1), { resultCount: 5, pieCount: 2, estimationPairCount: 3 });
    assert.deepEqual(statements[0].params, [1, 10]);
    assert.match(statements[1].sql, /COUNT\(DISTINCT pie_ID\) FROM personal_pie_weights WHERE benchmark_condition_ID = \?/);
    assert.match(statements[1].sql, /SELECT DISTINCT first_ID, second_ID FROM estimation_pair_votes WHERE first_ID=\? OR second_ID=\?/);
    assert.deepEqual(statements[1].params, [1, 1, 1, 1]);
});
