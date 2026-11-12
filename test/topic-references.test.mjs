import test from 'node:test';
import assert from 'node:assert/strict';
import { expandTopicReferences, loadTopicReferenceTargets, publicReferenceWeights } from '../topic-reference-service.js';
import { scoreModels, scoreComparison } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { absorbReferenceGraph } from '../topic-reference-graph.js';

const closeEntries = (actual, expected) => {
    assert.deepEqual(actual.map(item => item.conditionID), expected.map(item => item.conditionID));
    actual.forEach((item, index) => assert.ok(Math.abs(item.weightBasisPoints - expected[index].weightBasisPoints) < 1e-9));
};

const entry = (conditionID, weightBasisPoints = 10000) => ({ conditionID, weightBasisPoints });

test('reference discovery keeps older public and personal weights available without leaking private targets', async () => {
    const calls = [];
    const db = { execute: async (sql, args) => {
        calls.push({ sql, args });
        return [[{ context_ID: '10', category_ID: 7, scene_ID: '10', topic_name: 'Images',
            public_ID: 7, scene_number: 2, slug: 'images', scene_name: 'Vectors', is_default: '0', has_weights: '1', owner_user_ID: null }]];
    } };
    const targets = await loadTopicReferenceTargets(db, '123');
    assert.deepEqual(calls[0].args, ['123']);
    assert.doesNotMatch(calls[0].sql, /p\.updated_at|INTERVAL 14 DAY/);
    assert.match(calls[0].sql, /c.owner_user_ID IS NULL OR c.owner_user_ID = \?/);
    assert.equal(targets[0].url, '/7/2');
    assert.equal(targets[0].isDefault, false);
    assert.equal(targets[0].hasWeights, true);
});
const node = (contextID, entries, extra = {}) => ({ contextID, entries, ...extra });

test('reference discovery uses stored scene paths for punctuation-bearing programming languages', async () => {
    const db = { execute: async () => [[{ context_ID: '10', category_ID: 180, scene_ID: '10', topic_name: 'Coding',
        public_ID: 180, scene_number: 3, slug: 'coding', scene_name: 'C++', scene_slug: 'c-plus-plus', owner_user_ID: null }]] };
    const [target] = await loadTopicReferenceTargets(db);
    assert.equal(target.url, '/180/3');
});

test('references multiply path shares and combine identical leaf benchmarks', async () => {
    const nodes = new Map([[2, node(2, [entry(10, 6000), entry(11, 4000)])],
        [3, node(3, [entry(-2, 5000), entry(11, 5000)])]]);
    const result = await expandTopicReferences(node(1, [entry(-2, 4000), entry(-3, 4000), entry(10, 2000)]),
        { loadTarget: async ID => nodes.get(ID) });
    closeEntries(result.entries, [entry(10, 5600), entry(11, 4400)]);
    assert.deepEqual(result.issues, []);
});

test('different fallback chains for the same leaf remain weighted alternatives', async () => {
    const target = node(2, [entry(10)], { fallbackRules: [{ primaryConditionID: 10,
        familyID: 100, entries: [{ conditionID: 20 }] }] });
    const result = await expandTopicReferences(node(1, [entry(-2, 2500), entry(10, 7500)]),
        { loadTarget: async () => target });
    assert.deepEqual(result.entries, [entry(10)]);
    assert.deepEqual(result.familyComposition[0].families.map(family => [family.entries, family.weightBasisPoints]),
        [[[], 7500], [[{ conditionID: 20 }], 2500]]);
});

test('an explicit no-fallback choice overrides community fallback inside a reference', async () => {
    const target = node(2, [entry(10)], { fallbackRules: [{ primaryConditionID: 10, entries: [] }],
        familyComposition: [{ primaryConditionID: 10, families: [{ entries: [{ conditionID: 20 }], weightBasisPoints: 10000 }] }] });
    const result = await expandTopicReferences(node(1, [entry(-2)]), { loadTarget: async () => target });
    assert.deepEqual(result.familyComposition[0].families[0].entries, []);
});

test('empty and inaccessible references keep their original missing weight', async () => {
    const result = await expandTopicReferences(node(1, [entry(-2, 4000), entry(-3, 2000), entry(10, 4000)]),
        { loadTarget: async ID => ID === 2 ? node(2, [], { name: 'Empty topic' }) : null });
    assert.equal(result.entries.reduce((sum, item) => sum + item.weightBasisPoints, 0), 10000);
    assert.equal(result.entries.find(item => item.conditionID === 10).weightBasisPoints, 4000);
    assert.deepEqual(result.issues.map(item => item.reason).sort(), ['empty', 'unavailable']);
});

test('a closed topic-only class retains its entire weight as missing', async () => {
    const result = await expandTopicReferences(node(1, [entry(-2)]), {
        loadTarget: async ID => node(ID, [entry(-1)])
    });
    assert.equal(result.issues[0].reason, 'closed_cycle');
    assert.deepEqual(result.issues[0].contextIDs, [1, 2]);
    assert.deepEqual(result.entries, [entry(-1)]);
    assert.deepEqual(result.familyComposition, []);
    const models = [{ ID: 7, modelID: 7, modelName: 'Unrelated evidence', condition: { parameters: {} },
        results: new Map([['10', { normalizedScore: 100 }]]) }];
    for (const scoreMode of ['range', 'available']) {
        const [score] = scoreComparison(models, result.entries, 10000, { scoreMode }, comparisonOptions(models));
        assert.equal(score.coverage, 0); assert.equal(score.resultCount, 0);
        assert.equal(score.comparable, false); assert.equal(score.lower, null);
    }
});

test('diamond graphs resolve a shared node only once', async () => {
    const calls = [];
    const result = await expandTopicReferences(node(1, [entry(-2, 5000), entry(-3, 5000)]), {
        loadTarget: async ID => {
            calls.push(ID);
            return ID === 4 ? node(4, [entry(10)]) : node(ID, [entry(-4)]);
        }
    });
    assert.deepEqual(calls.slice().sort((a, b) => a - b), [2, 3, 4]);
    assert.deepEqual(result.entries, [entry(10)]);
});

test('graph resource bounds retain unresolved share and do not load unbounded targets', async () => {
    const calls = [];
    const result = await expandTopicReferences(node(1, [entry(-2)]), { maxNodes: 3,
        loadTarget: async ID => { calls.push(ID); return node(ID, [entry(-(ID + 1))]); } });
    assert.deepEqual(calls, [2, 3]);
    assert.equal(result.issues[0].reason, 'size_limit');
    assert.equal(result.entries[0].weightBasisPoints, 10000);
});

test('an unavailable reference affects range and coverage without being estimated as a benchmark', () => {
    const model = { ID: 1, modelID: 1, name: 'Model', condition: {},
        results: new Map([['10', { normalizedScore: 80 }]]) };
    const weights = [entry(10, 5000), entry(-20, 5000)];
    const [range] = scoreModels([model], weights, 10000, { scoreMode: 'range' });
    assert.equal(range.lower, 40);
    assert.equal(range.upper, 90);
    assert.equal(range.coverage, 50);
    let predictions = 0;
    const [estimated] = scoreModels([model], weights, 10000, { scoreMode: 'available',
        percentileReference: { estimate: () => ({ percentile: null, sourceCount: 1 }),
            predict() { predictions++; throw new Error('Do not infer a topic as a benchmark'); } } });
    assert.equal(predictions, 0);
    assert.equal(estimated.coverage, 50);
    assert.equal(estimated.lower, 66.67);
});

test('public references preserve sub-basis-point shares and rounded zero references cannot create NaN', async () => {
    const entries = publicReferenceWeights({ participantCount: 201,
        scoringEntries: [entry(10, 2009900), entry(-2, 100)] });
    const result = await expandTopicReferences(node(1, entries), { loadTarget: async () => node(2, [entry(11)]) });
    assert.ok(Math.abs(result.entries.find(item => item.conditionID === 11).weightBasisPoints - 100 / 201) < 1e-12);
    assert.ok(result.familyComposition.every(group => group.families.every(family => Number.isFinite(family.weightBasisPoints))));
    const models = [{ ID: 1, modelID: 1, name: 'Model', condition: {},
        results: new Map([['10', { normalizedScore: 20 }], ['11', { normalizedScore: 80 }]]) }];
    const scores = scoreModels(models, result.entries, 10000, { scoreMode: 'range',
        familyComposition: result.familyComposition, fallbackScope: 'public' });
    assert.equal(scores.length, 1); assert.ok(Number.isFinite(scores[0].lower));
    const zero = await expandTopicReferences(node(1, [entry(10), entry(-2, 0)]), {
        loadTarget: async () => { throw new Error('Zero shares must not load a target'); }
    });
    assert.deepEqual(zero.entries, [entry(10)]);
    assert.deepEqual(zero.issues, []);
});

test('deep shared paths have no recursion cutoff and are independent of reference ordering', async () => {
    const loadTarget = async ID => ID === 2 ? node(2, [entry(10)]) : node(ID, [entry(-(ID === 100 ? 2 : ID + 1))]);
    const first = await expandTopicReferences(node(1, [entry(-2, 5000), entry(-3, 5000)]), { loadTarget });
    const second = await expandTopicReferences(node(1, [entry(-3, 5000), entry(-2, 5000)]), { loadTarget });
    assert.deepEqual(first, second);
    assert.deepEqual(first.entries, [entry(10)]);
    assert.deepEqual(first.issues, []);
});

test('empty and inaccessible shared targets are loaded at most once and count against the node budget', async () => {
    for (const empty of [true, false]) {
        const calls = new Map();
        const result = await expandTopicReferences(node(1, Array.from({ length: 100 }, (_, i) => entry(-i - 2, 100))), {
            loadTarget: async ID => {
                calls.set(ID, (calls.get(ID) ?? 0) + 1);
                return ID >= 102 ? empty ? node(ID, []) : null
                    : node(ID, Array.from({ length: 100 }, (_, i) => entry(-i - 102, 100)));
            }
        });
        assert.equal(calls.size, 200);
        assert.ok([...calls.values()].every(count => count === 1));
        assert.ok(Math.abs(result.entries.reduce((sum, item) => sum + item.weightBasisPoints, 0) - 10000) < 1e-8);
        assert.equal(result.issues.length, 100);
    }
    let calls = 0;
    const bounded = await expandTopicReferences(node(1, Array.from({ length: 100 }, (_, i) => entry(-i - 2, 100))), {
        maxNodes: 10, loadTarget: async () => { calls++; return null; }
    });
    assert.equal(calls, 9);
    assert.ok(bounded.issues.some(issue => issue.reason === 'size_limit'));
});

test('cyclic contexts absorb benchmarks and preserve each target composition', async () => {
    const result = await expandTopicReferences(node(1, [entry(-2, 5000), entry(10, 5000)]), {
        loadTarget: async ID => node(ID, [entry(-1, 7500), entry(11, 2500)])
    });
    assert.deepEqual(result.entries, [entry(10, 8000), entry(11, 2000)]);
    closeEntries(result.referenceCompositions[0].entries, [entry(10, 6000), entry(11, 4000)]);
    assert.deepEqual(result.issues, []);
});

test('tiny absorbing exits remain finite even when self loops round to 100 percent', async () => {
    for (const exit of [1, 1e-8, 1e-200]) {
        const result = await expandTopicReferences(node(1, [entry(-1, 10000 - exit), entry(10, exit)]), {
            loadTarget: async () => { throw new Error('Root state must retain the draft composition'); }
        });
        assert.deepEqual(result.entries, [entry(10)]);
        assert.deepEqual(result.issues, []);
    }
    for (const exit of [1e-8, 1e-200, 1e-320]) {
        const result = await expandTopicReferences(node(1, [entry(-2, 10000 - exit), entry(10, exit)]), {
            loadTarget: async ID => node(ID, [entry(-1, 10000 - 2 * exit), entry(11, 2 * exit)])
        });
        assert.ok(Math.abs(result.entries[0].weightBasisPoints - 10000 / 3) < 1e-7);
        assert.ok(Math.abs(result.entries.reduce((sum, item) => sum + item.weightBasisPoints, 0) - 10000) < 1e-9);
    }
});

test('absorbing cycles can also lose weight to a closed class or deleted target', async () => {
    for (const deleted of [false, true]) {
        const result = await expandTopicReferences(node(1, [entry(-2, 5000), entry(-3, 3000), entry(10, 2000)]), {
            loadTarget: async ID => ID === 2 ? node(2, [entry(-1)]) : deleted ? null : node(3, [entry(-3)])
        });
        assert.equal(result.entries.find(item => item.conditionID === 10).weightBasisPoints, 4000);
        assert.ok(Math.abs(result.entries.find(item => item.conditionID < 0).weightBasisPoints - 6000) < 1e-9);
        assert.equal(result.issues[0].reason, deleted ? 'unavailable' : 'closed_cycle');
        const [score] = scoreModels([{ ID: 1, name: 'A', results: new Map([['10', { normalizedScore: 80 }]]) }],
            result.entries, 10000, { familyComposition: result.familyComposition, fallbackScope: 'public' });
        assert.equal(score.lower, 32); assert.equal(score.coverage, 40);
    }
});

test('cyclic paths merge repeated benchmarks while retaining fallback alternatives', async () => {
    const result = await expandTopicReferences(node(1, [entry(-2, 5000), entry(10, 5000)], {
        fallbackRules: [{ primaryConditionID: 10, entries: [{ conditionID: 12 }] }]
    }), { loadTarget: async ID => node(ID, [entry(-1, 5000), entry(10, 5000)], {
        fallbackRules: [{ primaryConditionID: 10, entries: [{ conditionID: 13 }] }]
    }) });
    assert.deepEqual(result.entries, [entry(10)]);
    const choices = result.familyComposition[0].families;
    assert.ok(Math.abs(choices[0].weightBasisPoints - 20000 / 3) < 1e-9);
    assert.ok(Math.abs(choices[1].weightBasisPoints - 10000 / 3) < 1e-9);
    const [score] = scoreModels([{ ID: 1, name: 'A', results: new Map([['12', { normalizedScore: 60 }]]) }],
        result.entries, 10000, { familyComposition: result.familyComposition, fallbackScope: 'public' });
    assert.equal(score.lower, 40); assert.equal(score.coverage, 66.67);
});

test('scenes are separate graph states and target selection is specific to each index mode', async () => {
    const root = node(1, [entry(-20, 5000), entry(-21, 5000)]);
    const choices = { public: new Map([[20, node(20, [entry(10)])], [21, node(21, [entry(11)])]]),
        personal: new Map([[20, node(20, [entry(-1, 5000), entry(12, 5000)])], [21, node(21, [entry(11)])]]) };
    const publicResult = await expandTopicReferences(root, { loadTarget: async ID => choices.public.get(ID) });
    const personalResult = await expandTopicReferences(root, { loadTarget: async ID => choices.personal.get(ID) });
    assert.deepEqual(publicResult.entries, [entry(10, 5000), entry(11, 5000)]);
    assert.ok(Math.abs(personalResult.entries.find(item => item.conditionID === 11).weightBasisPoints - 20000 / 3) < 1e-9);
    assert.ok(Math.abs(personalResult.entries.find(item => item.conditionID === 12).weightBasisPoints - 10000 / 3) < 1e-9);
});

test('a dense cyclic graph conserves mass and satisfies each absorbing-chain equation', () => {
    const count = 20, nodes = new Map();
    for (let ID = 0; ID < count; ID++) nodes.set(ID, {
        edges: new Map([[ID, 7 + ID], [(ID + 1) % count, 11], [(ID + 7) % count, 2 + ID % 5]]),
        absorbed: new Map([['A', 1 + ID % 3], ['B', 1 + ID % 7]])
    });
    const result = absorbReferenceGraph(nodes, () => { throw new Error('Every state can reach a benchmark'); });
    for (const [ID, node] of nodes) {
        const values = [...result.get(ID).values()];
        assert.ok(values.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
        assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
        const total = [...node.edges.values(), ...node.absorbed.values()].reduce((sum, value) => sum + value, 0);
        for (const key of ['A', 'B']) {
            const expected = (node.absorbed.get(key) + [...node.edges].reduce((sum, [next, weight]) =>
                sum + weight * result.get(next).get(key), 0)) / total;
            assert.ok(Math.abs(result.get(ID).get(key) - expected) < 1e-12);
        }
    }
});
