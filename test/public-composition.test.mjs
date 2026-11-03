import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicPie, scoreModels } from '../ranking-service.js';
import { expandTopicReferences, publicReferenceWeights } from '../topic-reference-service.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';

const contextRow = (ID, category = 1, values = '{}', extra = {}) => ({
    ID, category_ID: category, context_values: values, is_active: 1, owner_user_ID: null, ...extra
});
const weight = (pie, context, condition = 1, amount = 10000) => ({
    pie_ID: pie, context_ID: context, benchmark_condition_ID: condition, weight_basis_points: amount,
    is_recent: 1, is_fallback_recent: 1
});
function database(contexts, weights) {
    const sampled = [];
    return { sampled, async execute(sql, params) {
        assert.doesNotMatch(sql, /\bIN\s*\(\s*\)/i, 'Empty electorates must not generate invalid SQL');
        if (sql.includes('FROM ranking_contexts rc')) {
            assert.match(sql, /JOIN categories c ON c.ID = rc.category_ID/);
            assert.match(sql, /WHERE rc.category_ID = \? AND c.is_active = 1 AND c.owner_user_ID IS NULL/);
            assert.doesNotMatch(sql, /WITH RECURSIVE|parent_ID|source_category/);
            assert.equal(params.length, 1);
            return [contexts.filter(row => row.category_ID === params[0] && row.is_active === 1 && row.owner_user_ID == null), []];
        }
        if (sql.includes('FROM personal_pies')) {
            assert.match(sql, /personal_pies.context_ID IN/);
            assert.match(sql, /users.deleted_at IS NULL/);
            assert.match(sql, /users.banned_at IS NULL/);
            assert.match(sql, /INTERVAL 72 HOUR AS is_recent/);
            assert.match(sql, /INTERVAL 14 DAY AS is_fallback_recent/);
            assert.match(sql, /ORDER BY personal_pies.context_ID, personal_pies.updated_at DESC,\s+personal_pies.ID DESC/);
            assert.doesNotMatch(sql.slice(sql.indexOf('WHERE')), /updated_at\s*[><=]/);
            return [weights.filter(row => params.includes(row.context_ID))
                .sort((a, b) => a.context_ID - b.context_ID || b.pie_ID - a.pie_ID), []];
        }
        if (sql.includes('FROM personal_pie_score_rules')) {
            sampled.push([...params]);
            return [[], []];
        }
        throw Error('Unexpected SQL: ' + sql);
    } };
}
const conditions = new Map([[1, {}], [2, {}]]);
const topic = { categoryID: 1, dimensions: [], contextValues: {} };
const filteredTopic = { categoryID: 1, contextValues: { tools: 'any' },
    dimensions: [{ key: 'tools', options: [{ key: 'any', isNeutral: true }, { key: 'allowed' }, { key: 'blocked' }] }] };
const matchingContexts = () => [contextRow(10, 1, '{"tools":"any"}'), contextRow(20, 1, '{"tools":"allowed"}'),
    contextRow(30, 1, '{"tools":"blocked"}')];

test('each public topic uses its own Pies, never legacy descendants, private topics or inactive topics', async () => {
    const db = database([
        contextRow(10), contextRow(20, 2, '{}', { parent_ID: 1 }),
        contextRow(50, 5, '{}', { parent_ID: 2 }),
        contextRow(51, 5, '{"tools":"allowed"}', { parent_ID: 2 }),
        contextRow(30, 3, '{}', { owner_user_ID: 99 }),
        contextRow(40, 4, '{}', { is_active: 0 })
    ], [weight(1, 10, 1, 6000), weight(1, 10, 2, 4000), weight(2, 20), weight(3, 50),
        weight(4, 51), weight(5, 30, 99), weight(6, 40, 99)]);
    const first = await loadPublicPie(db, topic, conditions);
    assert.equal(first.participantCount, 1);
    assert.deepEqual(first.entries, [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }]);
    assert.deepEqual(first.contextIDs, [10]);
    assert.deepEqual(db.sampled[0], [1]);
    const second = await loadPublicPie(db, { ...topic, categoryID: 2 }, conditions);
    assert.equal(second.participantCount, 1);
    assert.deepEqual(second.entries, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    assert.deepEqual(second.contextIDs, [20]);
    assert.deepEqual(db.sampled[1], [2]);
    for (const pie of [first, second]) assert.equal(Object.hasOwn(pie, 'composition'), false);
});

test('topic-local options filter matching configurations without matching another topic with the same option', async () => {
    const db = database([contextRow(20, 2, '{"tools":"allowed"}'), contextRow(21, 2, '{"tools":"blocked"}'),
        contextRow(22, 7, '{"tools":"allowed"}')], [weight(1, 20), weight(2, 21, 2), weight(3, 22, 99)]);
    const specific = await loadPublicPie(db, { ...filteredTopic, categoryID: 2, contextValues: { tools: 'allowed' } }, conditions);
    assert.equal(specific.participantCount, 1);
    assert.deepEqual(specific.contextIDs, [20]);
    assert.deepEqual(specific.entries, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    const neutral = await loadPublicPie(db, { ...filteredTopic, categoryID: 2 }, conditions);
    assert.equal(neutral.participantCount, 2);
    assert.deepEqual(neutral.contextIDs, [20, 21]);
    assert.deepEqual(neutral.entries, [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }]);
});

test('no contexts, only empty Pies, and only another topic produce no public weights', async () => {
    for (const [contexts, rows, contextIDs] of [
        [[], [], []],
        [[contextRow(10)], [weight(1, 10, null, null)], [10]],
        [[contextRow(20, 2)], [weight(1, 20)], []]
    ]) {
        const pie = await loadPublicPie(database(contexts, rows), topic, conditions);
        assert.equal(pie.participantCount, 0);
        assert.deepEqual(pie.entries, []);
        assert.deepEqual(pie.familyComposition, []);
        assert.deepEqual(pie.scoringEntries, []);
        assert.deepEqual(pie.contextIDs, contextIDs);
        assert.equal(Object.hasOwn(pie, 'composition'), false);
    }
});

test('sparse matching contexts count their selected Pies equally regardless of age', async () => {
    const rows = [
        weight(3, 10, 1), weight(2, 10, 2),
        { ...weight(1, 10, 1), is_recent: 0, is_fallback_recent: 0 },
        ...[8, 7, 6, 5, 4].map(ID => weight(ID, 20, 2)),
        { ...weight(9, 30, 1), is_recent: 0, is_fallback_recent: 0 },
        weight(10, 40, 99)
    ];
    const db = database([...matchingContexts(), contextRow(40, 2)], rows);
    const pie = await loadPublicPie(db, filteredTopic, conditions);
    assert.equal(pie.participantCount, 9);
    assert.deepEqual(pie.entries, [{ conditionID: 1, weightBasisPoints: 3333 }, { conditionID: 2, weightBasisPoints: 6667 }]);
    assert.deepEqual(pie.scoringEntries.map(({ contextID, conditionID }) => [contextID, conditionID]), [[10, 1], [10, 2], [20, 2], [30, 1]]);
    assert.deepEqual(db.sampled[0], [3, 2, 8, 7, 6, 5, 4], 'Fallback electorate excludes expired top-up samples');
    assert.equal(Object.hasOwn(pie, 'composition'), false);
});

test('an empty fallback electorate skips SQL while an older Pie still supplies public weights', async () => {
    const db = database([contextRow(10)], [{ ...weight(1, 10), is_recent: 0, is_fallback_recent: 0 }]);
    const pie = await loadPublicPie(db, topic, conditions);
    assert.equal(pie.participantCount, 1);
    assert.deepEqual(pie.entries, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    assert.equal(pie.familyComposition[0].configuredPieCount, 0);
    assert.equal(pie.familyComposition[0].isDefault, true);
    assert.deepEqual(db.sampled, [], 'No fallback query is issued for an empty electorate');
});

test('zero to nine 72-hour Pies top up to ten total, not ten additional Pies', async () => {
    for (const recentCount of [0, 1, 2, 3, 9]) {
        const rows = Array.from({ length: 12 }, (_, index) => ({
            ...weight(12 - index, 10, index < recentCount ? 1 : 2),
            is_recent: Number(index < recentCount), is_fallback_recent: Number(index < recentCount)
        }));
        rows.push(weight(100, 20, 1), weight(101, 10, null, null), weight(102, 40, 99));
        const db = database([...matchingContexts(), contextRow(40, 2)], rows);
        const pie = await loadPublicPie(db, filteredTopic, conditions);
        assert.equal(pie.participantCount, 11, 'Ten samples in the first context plus one in the second');
        const expected = (recentCount + 1) / 11 * 10000;
        assert.equal(pie.entries.find(entry => entry.conditionID === 1).weightBasisPoints, Math.round(expected));
        assert.equal(pie.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        assert.deepEqual(db.sampled[0], [...Array.from({ length: recentCount }, (_, index) => 12 - index), 100]);
    }
});

test('at least ten recent Pies uses every 72-hour Pie without adding older Pies', async () => {
    for (const recentCount of [10, 12]) {
        const rows = Array.from({ length: recentCount + 2 }, (_, index) => ({
            ...weight(recentCount + 2 - index, 10, index < recentCount ? 1 : 2),
            is_recent: Number(index < recentCount), is_fallback_recent: 1
        }));
        const db = database([contextRow(10)], rows);
        const pie = await loadPublicPie(db, topic, conditions);
        assert.equal(pie.participantCount, recentCount);
        assert.deepEqual(db.sampled[0], Array.from({ length: recentCount + 2 }, (_, index) => recentCount + 2 - index));
        assert.deepEqual(pie.entries, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    }
});

test('unsampled Pies do not affect context shares but recent explicit fallback choices remain eligible', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
        ...weight(12 - index, 10, index === 0 ? 1 : 2),
        is_recent: Number(index === 0), is_fallback_recent: 1
    }));
    rows.push(...[21, 22, 23, 24].map(ID => weight(ID, 20, 1)));
    const db = database(matchingContexts(), rows);
    const pie = await loadPublicPie(db, filteredTopic, conditions);
    assert.equal(pie.participantCount, 14);
    assert.deepEqual(pie.scoringEntries, [
        { contextID: 10, conditionID: 1, weightBasisPoints: 10000 },
        { contextID: 10, conditionID: 2, weightBasisPoints: 90000 },
        { contextID: 20, conditionID: 1, weightBasisPoints: 40000 }
    ]);
    assert.deepEqual(pie.entries, [{ conditionID: 1, weightBasisPoints: 3571 }, { conditionID: 2, weightBasisPoints: 6429 }]);
    assert.equal(db.sampled[0].length, 16, 'Fallback choices use the whole active electorate, independently of the weight sample');
});

test('fewer than ten available Pies all contribute even with no 72-hour activity', async () => {
    const rows = [
        { ...weight(3, 10, 1), is_recent: 0, is_fallback_recent: 1 },
        { ...weight(2, 10, 2), is_recent: 0, is_fallback_recent: 1 },
        { ...weight(1, 10, 2), is_recent: 0, is_fallback_recent: 0 }
    ];
    const db = database([contextRow(10)], rows);
    const pie = await loadPublicPie(db, topic, conditions);
    assert.equal(pie.participantCount, 3);
    assert.deepEqual(db.sampled[0], [3, 2]);
    assert.deepEqual(pie.entries, [{ conditionID: 1, weightBasisPoints: 3333 }, { conditionID: 2, weightBasisPoints: 6667 }]);
});

test('aging past fourteen days keeps a referenced public index and its parent score available', async () => {
    const model = { ID: 1, results: new Map([['1', { normalizedScore: 80 }], ['2', { normalizedScore: 80 }]]) };
    for (const recent of [1, 0]) {
        const target = await loadPublicPie(database([contextRow(10)], [{ ...weight(1, 10, 2),
            is_recent: recent, is_fallback_recent: recent }]), topic, conditions);
        const expanded = await expandTopicReferences({ contextID: 20, entries: [
            { conditionID: 1, weightBasisPoints: 5000 }, { conditionID: -10, weightBasisPoints: 5000 }
        ] }, { loadTarget: async () => ({ contextID: 10, entries: publicReferenceWeights(target) }) });
        const [score] = scoreModels([model], expanded.entries, 10000, { scoreMode: 'available' });
        assert.deepEqual(expanded.issues, []);
        assert.equal(score.lower, 80);
        assert.equal(score.coverage, 100);
    }
});

test('missing or inconsistent independent recency flags fail instead of reusing the 72-hour flag', async () => {
    for (const row of [
        { ...weight(1, 10), is_fallback_recent: undefined },
        { ...weight(1, 10), is_fallback_recent: 0 },
        { ...weight(1, 10), is_recent: 2 },
        { ...weight(1, 10), is_fallback_recent: 2 }
    ]) {
        await assert.rejects(loadPublicPie(database([contextRow(10)], [row]), topic, conditions),
            error => error.body?.error === 'personal_pie_recency_invalid');
    }
});

test('invalid totals, weights, duplicates and unavailable conditions still fail before aggregation', async () => {
    for (const [rows, code] of [
        [[weight(1, 10, 1, 9900)], 'personal_pie_total_invalid'],
        [[weight(1, 10, 1, 50), weight(1, 10, 2, 9950)], 'personal_pie_weight_invalid'],
        [[weight(1, 10, 1, 5000), weight(1, 10, 1, 5000)], 'personal_pie_condition_duplicate'],
        [[weight(1, 10, 99)], 'personal_pie_references_unavailable_condition']
    ]) {
        await assert.rejects(loadPublicPie(database([contextRow(10)], rows), topic, conditions),
            error => error.status === 409 && error.body?.error === code);
    }
});

test('the flat workspace needs no category composition and still rejects invalid public fallback shares', () => {
    const good = workspace(createFixtureState(), { categoryID: 1 });
    // The shared preview fixture still has the retired field; exercise the flat wire shape.
    delete good.publicPie.composition;
    validateWorkspacePayload(good);
    assert.equal(Object.hasOwn(good.publicPie, 'composition'), false);
    for (const change of [
        pie => { pie.participantCount = -1; },
        pie => { pie.participantCount = .5; },
        pie => { delete pie.entries; },
        pie => { delete pie.familyComposition; },
        pie => { pie.familyComposition.push(structuredClone(pie.familyComposition[0])); },
        pie => { pie.familyComposition[0].families[0].weightBasisPoints += 1; },
        pie => { pie.familyComposition[0].primaryConditionID = 999999; },
        pie => { pie.familyComposition.pop(); }
    ]) {
        const bad = structuredClone(good);
        change(bad.publicPie);
        assert.throws(() => validateWorkspacePayload(bad), error => error.code === 'invalid_workspace_response');
    }
});
