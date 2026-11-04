import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAcyclicReferences, expandTopicReferences, loadTopicReferenceTargets, publicReferenceWeights } from '../topic-reference-service.js';
import { scoreModels } from '../ranking-service.js';

const entry = (conditionID, weightBasisPoints = 10000) => ({ conditionID, weightBasisPoints });

test('reference discovery keeps older public and personal weights available without leaking private targets', async () => {
    const calls = [];
    const db = { execute: async (sql, args) => {
        calls.push({ sql, args });
        return [[{ context_ID: '10', category_ID: 7, scene_ID: '10', topic_name: 'Images',
            slug: 'images', scene_name: 'Vectors', is_default: '0', has_weights: '1', owner_user_ID: null }]];
    } };
    const targets = await loadTopicReferenceTargets(db, '123');
    assert.deepEqual(calls[0].args, ['123']);
    assert.doesNotMatch(calls[0].sql, /p\.updated_at|INTERVAL 14 DAY/);
    assert.match(calls[0].sql, /c.owner_user_ID IS NULL OR c.owner_user_ID = \?/);
    assert.equal(targets[0].url, '/images/vectors');
    assert.equal(targets[0].isDefault, false);
    assert.equal(targets[0].hasWeights, true);
});
const node = (contextID, entries, extra = {}) => ({ contextID, entries, ...extra });

test('reference discovery uses stored scene paths for punctuation-bearing programming languages', async () => {
    const db = { execute: async () => [[{ context_ID: '10', category_ID: 180, scene_ID: '10', topic_name: 'Coding',
        slug: 'coding', scene_name: 'C++', scene_slug: 'c-plus-plus', owner_user_ID: null }]] };
    const [target] = await loadTopicReferenceTargets(db);
    assert.equal(target.url, '/coding/c-plus-plus');
});

test('references multiply path shares and combine identical leaf benchmarks', async () => {
    const nodes = new Map([[2, node(2, [entry(10, 6000), entry(11, 4000)])],
        [3, node(3, [entry(-2, 5000), entry(11, 5000)])]]);
    const result = await expandTopicReferences(node(1, [entry(-2, 4000), entry(-3, 4000), entry(10, 2000)]),
        { loadTarget: async ID => nodes.get(ID) });
    assert.deepEqual(result.entries, [entry(10, 5600), entry(11, 4400)]);
    assert.deepEqual(result.issues, []);
});

test('different fallback chains for the same leaf remain weighted alternatives', async () => {
    const target = node(2, [entry(10)], { fallbackRules: [{ primaryConditionID: 10,
        familyID: 100, entries: [{ conditionID: 20 }] }] });
    const result = await expandTopicReferences(node(1, [entry(-2, 2500), entry(10, 7500)]),
        { loadTarget: async () => target });
    assert.deepEqual(result.entries, [entry(10)]);
    assert.deepEqual(result.familyComposition[0].families.map(family => [family.entries, family.weightBasisPoints]),
        [[[{ conditionID: 20 }], 2500], [[], 7500]]);
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

test('cycles are rejected even when they cross multiple topics and scenes', () => {
    const edges = [{ source_context_ID: 2, target_context_ID: 3 }, { source_context_ID: 3, target_context_ID: 1 }];
    assert.throws(() => assertAcyclicReferences(edges, 1, [2]), error => error.body.error === 'topic_reference_cycle');
    assert.throws(() => assertAcyclicReferences([], 1, [1]), error => error.body.error === 'topic_reference_cycle');
    assert.doesNotThrow(() => assertAcyclicReferences(edges, 4, [2]));
});

test('read-time cycle protection returns a notice instead of recurring or dropping weight', async () => {
    const result = await expandTopicReferences(node(1, [entry(-2)]), {
        loadTarget: async ID => node(ID, [entry(-1)])
    });
    assert.equal(result.issues[0].reason, 'cycle');
    assert.equal(result.entries[0].weightBasisPoints, 10000);
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
    const result = await expandTopicReferences(node(1, [entry(-2)]), { maxDepth: 2,
        loadTarget: async ID => { calls.push(ID); return node(ID, [entry(-(ID + 1))]); } });
    assert.deepEqual(calls, [2, 3]);
    assert.equal(result.issues[0].reason, 'depth_limit');
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
    assert.equal(result.entries.find(item => item.conditionID === 11).weightBasisPoints, 100 / 201);
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

test('deep shared paths have identical validation and missing weight regardless of reference ordering', async () => {
    const edges = Array.from({ length: 16 }, (_, index) => ({ source_context_ID: index + 3,
        target_context_ID: index === 15 ? 2 : index + 4 }));
    for (const targets of [[2, 3], [3, 2]]) assert.throws(() => assertAcyclicReferences(edges, 1, targets),
        error => error.body.error === 'topic_reference_depth_limit');
    const loadTarget = async ID => ID === 2 ? node(2, [entry(10)]) : node(ID, [entry(-(ID === 18 ? 2 : ID + 1))]);
    const first = await expandTopicReferences(node(1, [entry(-2, 5000), entry(-3, 5000)]), { loadTarget });
    const second = await expandTopicReferences(node(1, [entry(-3, 5000), entry(-2, 5000)]), { loadTarget });
    assert.deepEqual(first, second);
    assert.equal(first.entries.find(item => item.conditionID === 10).weightBasisPoints, 5000);
    assert.equal(first.entries.find(item => item.conditionID < 0).weightBasisPoints, 5000);
    assert.equal(first.issues[0].reason, 'depth_limit');
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
