import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionImpact } from '../condition-impact.js';

test('impact counts distinct personal mixes and checks condition ownership before counting', async () => {
    const statements = [];
    const connection = { async execute(sql, params) {
        statements.push({ sql, params });
        if (sql.startsWith('SELECT ID FROM benchmark_conditions')) return [[{ ID: 1 }], []];
        if (sql.includes('COUNT(DISTINCT pie_ID)')) return [[{ count: 2 }], []];
        if (sql.includes('COUNT(*)')) return [[{ count: 5 }], []];
        throw Error('Unexpected query');
    } };
    assert.deepEqual(await conditionImpact(connection, 'benchmark', 10, 1), { resultCount: 5, pieCount: 2 });
    assert.deepEqual(statements[0].params, [1, 10]);
    assert.ok(statements[2].sql.includes('personal_pie_score_rule_components'));
});
