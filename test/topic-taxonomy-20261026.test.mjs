import test from 'node:test';
import assert from 'node:assert/strict';
import { topicTaxonomy, topicTaxonomyPlan, taxonomyContextPlan, taxonomyDimensions, verifyTaxonomyReferences } from '../scripts/migrate-topic-taxonomy-20261026.mjs';
import { topicSlug } from '../public/js/shared/topics.js';
import { serializeRankingContextValues, canonicalizeContextValues } from '../ranking-service.js';

const categories = () => [...topicTaxonomy.categories.map(node => ({ ID: node.ID, name: node.previousName,
    slug: topicSlug(node.previousName), is_active: 1, parent_ID: null, owner_user_ID: null, created_by_user_ID: null })),
...topicTaxonomy.retiredCategories.map(node => ({ ...node, slug: topicSlug(node.name), is_active: 1,
    parent_ID: null, owner_user_ID: null, created_by_user_ID: null }))];
const context = (ID, category_ID, values = {}) => ({ ID, category_ID, context_values: values,
    context_hash: serializeRankingContextValues(values).contextHash });

test('official plan changes only the declared IDs and keeps custom/public/private topics out of scope', () => {
    const custom = { ID: 8000, name: 'Custom research', slug: 'custom-research', created_by_user_ID: '42', is_active: 1 };
    const personal = { ID: 8001, name: 'Coding', slug: 'coding', owner_user_ID: '42', is_active: 1 };
    const input = [...categories(), custom, personal], before = structuredClone(input);
    const plan = topicTaxonomyPlan(input);
    assert.equal(plan.topics.length, 30); assert.equal(plan.retired.length, 24);
    assert.deepEqual(plan.topics.map(row => row.ID), topicTaxonomy.categories.map(row => row.ID));
    assert.equal(plan.topics.some(row => row.ID >= 8000), false);
    assert.deepEqual(input, before);
    for (const row of plan.topics) assert.equal(row.slug, topicSlug(row.name));
});

for (const [label, change] of [
    ['changed official identity', rows => { rows.find(row => row.ID === 180).name = 'Unrelated'; }],
    ['private takeover', rows => { rows.find(row => row.ID === 180).owner_user_ID = '42'; }],
    ['user-created takeover', rows => { rows.find(row => row.ID === 180).created_by_user_ID = '42'; }],
    ['retained inactive topic', rows => { rows.find(row => row.ID === 180).is_active = 0; }],
    ['extra active official topic', rows => { rows.push({ ID: 8000, name: 'Unexpected official', slug: 'unexpected-official', is_active: 1 }); }],
    ['missing retired identity', rows => rows.filter(row => row.ID !== 168)],
    ['foreign public URL', rows => { rows.push({ ID: 8000, name: 'Coding', slug: 'coding', owner_user_ID: null }); }]
]) test('official plan refuses ' + label, () => {
    let rows = categories(); rows = change(rows) ?? rows;
    assert.throws(() => topicTaxonomyPlan(rows));
});

test('foreign-key preflight allows the reviewed boundaries and refuses unknown or cross-schema references', async () => {
    const known = { tableName: 'personal_pies', columnName: 'context_ID', target: 'ranking_contexts', localReference: 1 };
    await verifyTaxonomyReferences({ async query() { return [[known]]; } });
    for (const row of [{ ...known, tableName: 'new_cascading_table' }, { ...known, localReference: 0 }]) {
        await assert.rejects(verifyTaxonomyReferences({ async query() { return [[row]]; } }), /Unreviewed/);
    }
});

test('contexts consolidate Coding into its neutral context without retaining removed language/framework keys', () => {
    const rows = [context(1087, 180, { language_framework: 'javascript' }), context(1088, 180, { language_framework: 'any' }),
        context(1094, 168), context(1093, 207), context(8000, 8000, { custom: 'unchanged' })];
    const before = structuredClone(rows), result = taxonomyContextPlan(rows, topicTaxonomyPlan(categories()));
    assert.equal(result.groups.length, 3);
    const coding = result.groups.find(group => group.categoryID === 180);
    assert.equal(coding.keeperID, 1088); assert.deepEqual(coding.values, {});
    assert.deepEqual(coding.contexts.map(row => row.ID), [1088, 1087]);
    assert.equal(result.groups.find(group => group.categoryID === 167).keeperID, 1094);
    assert.equal(result.groups.find(group => group.categoryID === 231).keeperID, 1093);
    assert.deepEqual(rows, before);
});

test('a previously canonical context wins before a neutral old context to avoid unique-key collisions', () => {
    const result = taxonomyContextPlan([context(1, 180, { language_framework: 'any' }), context(2, 180)], topicTaxonomyPlan(categories()));
    assert.equal(result.groups[0].keeperID, 2);
});

test('multimodal consolidation distinguishes live AV from unrestricted understanding', () => {
    const result = taxonomyContextPlan([context(1, 210), context(2, 211, { count: 'any', task: 'any' }),
        context(3, 214, { task: 'any' })], topicTaxonomyPlan(categories()));
    assert.equal(result.groups.length, 2);
    assert.deepEqual(result.groups.map(group => group.values), [{ realtime: 'any' }, { realtime: 'yes' }]);
    assert.deepEqual(result.groups[0].contexts.map(row => row.ID), [1, 2]);
});

test('remaining generation contexts keep exact explicit values and neutral/reference semantics', () => {
    const values = { realtime: 'no', output: 'vector', reference_image: 'none' };
    const result = taxonomyContextPlan([context(1, 172, values)], topicTaxonomyPlan(categories()));
    assert.deepEqual(result.groups[0].values, values);
    assert.equal(result.groups[0].hash, serializeRankingContextValues(values).contextHash);
    for (const topic of topicTaxonomy.categories) {
        const dimensions = taxonomyDimensions(topic.key);
        const canonical = canonicalizeContextValues({}, dimensions);
        assert.ok(Object.values(canonical.contextValues).every(value => value === 'any'));
        assert.ok(dimensions.every(dimension => dimension.options.filter(option => option.isDefault).length === 1
            && dimension.options.filter(option => option.isNeutral).length === 1));
    }
});

test('corrupt hashes and invalid values fail closed; independent downstream options remain valid', () => {
    const plan = topicTaxonomyPlan(categories());
    assert.throws(() => taxonomyContextPlan([{ ...context(1, 180), context_hash: 'invalid' }], plan), /hash mismatch/);
    assert.throws(() => taxonomyContextPlan([context(1, 172, { realtime: 'invalid' })], plan));
    const independent = taxonomyContextPlan([context(1, 172, { realtime: 'any', output: 'vector' })], plan);
    assert.equal(independent.groups[0].values.output, 'vector');
});

test('removed umbrella contexts are explicit preservation work, not silently mixed into another topic', () => {
    const result = taxonomyContextPlan([context(1, 186), context(2, 175), context(3, 189)], topicTaxonomyPlan(categories()));
    assert.equal(result.groups.length, 0);
    assert.deepEqual(result.removed.map(row => row.ID), [1, 2, 3]);
});
