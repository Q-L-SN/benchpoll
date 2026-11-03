import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBenchmarkList } from '../ranking-service.js';
import { referenceCondition } from '../topic-reference-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createTopicHomeService } from '../topic-home-service.js';
import { sceneSummary } from '../public/js/shared/topics.js';

test('topic references share evaluation ordering, search, pagination and row contracts with benchmarks', () => {
    const raw = workspace(createFixtureState(), { categoryID: 1 }, { paginate: false });
    const target = referenceCondition({ contextID: 300, categoryID: 3, sceneID: 300, name: 'Research / Physics',
        topicName: 'Research', sceneName: 'Physics', hasWeights: true, isPrivate: false, url: '/research/physics' });
    raw.benchmarks = buildBenchmarkList([...raw.benchmarks, target], [
        { conditionID: 1, weightBasisPoints: 7000 }, { conditionID: -300, weightBasisPoints: 2000 },
        { conditionID: 2, weightBasisPoints: 1000 }
    ], raw.personalPie.entries);
    assert.deepEqual(raw.benchmarks.slice(0, 3).map(row => row.conditionID), [1, -300, 2]);
    const pager = createRankingPager();
    const page = pager.create(raw, { userID: raw.userID, initialMode: 'public' });
    validateWorkspacePayload(page);
    const search = pager.getPage({ snapshotID: page.rankingPagination.snapshotID, userID: raw.userID,
        list: 'benchmarks', group: 'primary', query: 'Physics', offset: 0 });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].conditionID, -300);
    assert.equal(search.items[0].ID, -300, 'The row can be added to personal weights with the same reference identity');
    assert.equal(search.items[0].fallbackConfigCount, 0);
});

test('total coverage includes all models before pagination and counts 100 percent as one', async () => {
    const models = Array.from({ length: 30 }, (_, i) => ({ ID: i + 1, modelID: i + 1, name: `Model ${i + 1}`,
        lower: 30 - i, upper: 30 - i, coverage: i === 0 || i === 29 ? 100 : i === 1 ? 50 : 0 }));
    const service = createTopicHomeService({ db: {}, loadTopic: async () => ({ ID: 54, isPrivate: false }),
        loadFields: async () => [], loadWorkspace: async () => ({ context: { contextValues: {} },
            comparison: { keys: ['model'], fields: [], availableKeys: ['model'] }, publicPie: { entries: [] },
            modelLeaderboards: { public: models } }) });
    const result = await service.preview(null, { categoryID: 54, scoreMode: 'range' });
    assert.equal(result.models.length, 25);
    assert.equal(result.totalCoverageIndex, 2.5);
});

test('scene summaries inherit the topic sentence only when their own text is empty or a legacy name placeholder', () => {
    const topic = { name: 'Research', description: 'Compare models on scientific research tasks.' };
    for (const description of ['', 'Research: Physics.', 'Physics', 'Research / Physics']) {
        assert.equal(sceneSummary(topic, { name: 'Physics', description }), topic.description);
    }
    assert.equal(sceneSummary(topic, { name: 'Physics', description: 'Solve experimental physics problems.' }),
        'Solve experimental physics problems.');
});
