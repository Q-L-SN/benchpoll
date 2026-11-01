import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankingPager, searchRankedModels } from '../ranking-pagination.js';

const comparison = { keys: ['model', 'field:1'],
    fields: [{ ID: 1, name: 'Thinking effort', type: 'text' }], models: [] };
const model = (ID, effort, score) => ({ ID, modelID: ID, modelName: `Model ${ID}`, name: `Model ${ID}`,
    comparisonIdentity: JSON.stringify([['model', true, ID], ['field:1', true, effort]]),
    comparable: true, lower: score, upper: score, coverage: 100 });

test('model search includes enabled parameter values and preserves exact variant identity', () => {
    const rows = [model(1, 'low', 99), model(1, 'high', 98), model(2, 'high', 97)];
    const matches = searchRankedModels(rows, comparison, 'model 1 high');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].targetModel, rows[1].comparisonIdentity);
    assert.equal(matches[0].offset, 1);
    assert.ok(matches[0].parts.some(part => part.text === 'high'));
    assert.equal(searchRankedModels(rows, { ...comparison, keys: ['model'] }, 'high').length, 0);
});

test('model search covers unloaded rows and enforces snapshot ownership', () => {
    const rows = Array.from({ length: 40 }, (_, index) => model(index + 1, 'high', 100 - index));
    const pager = createRankingPager();
    const first = pager.create({ scoreMode: 'range', benchmarks: [], comparison,
        personalPie: { entries: [] }, modelLeaderboards: { public: rows, personal: [] } }, { userID: 7 });
    const snapshotID = first.rankingPagination.snapshotID;
    assert.equal(first.modelLeaderboards.public.length, 25);
    const result = pager.searchModels({ snapshotID, userID: 7, list: 'public', query: 'model 38' });
    assert.equal(result.items[0].offset, 37);
    assert.equal(result.items[0].targetModel, rows[37].comparisonIdentity);
    assert.throws(() => pager.searchModels({ snapshotID, userID: 8, list: 'public', query: 'model' }), error => error.status === 403);
    assert.throws(() => pager.searchModels({ snapshotID, userID: 7, list: 'public', query: 'x'.repeat(121) }), error => error.status === 400);
});
