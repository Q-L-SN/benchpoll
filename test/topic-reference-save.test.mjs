import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadPersonalPie, savePersonalPie } from '../ranking-service.js';
import { createPieSaveDatabase } from '../scripts/personal-pie-save-fixture.mjs';

const weight = (conditionID, weightBasisPoints = 10000) => ({ conditionID, weightBasisPoints });
const request = (extra = {}) => ({ userID: '7', writeIdentity: randomUUID(), categoryID: 1,
    contextValues: {}, expectedRevision: 1, entries: [weight(-20)], fallbackRules: [], ...extra });
const error = code => value => {
    assert.equal(value.body?.error, code, value.message ?? JSON.stringify(value)); return true;
};
const order = entries => [...entries].sort((a, b) => a.conditionID - b.conditionID);

function database({ seedReferences = true, ...options } = {}) {
    const sourcePies = options.pies ?? (options.revision === 0 ? [] : [{ ID: 70, user_ID: '7', context_ID: 10,
        revision: options.revision ?? 1, weights: [weight(1)] }]);
    const targetPies = seedReferences ? [20, 50, 51, 70].map(contextID => ({
        ID: 900 + contextID, user_ID: contextID === 70 ? '7' : '9', context_ID: contextID,
        weights: [weight(1)]
    })) : [];
    return createPieSaveDatabase({
        users: [{ ID: '7' }, { ID: '8' }, { ID: '9' }],
        topics: [{ ID: 1 }, { ID: 2 }, { ID: 3, owner_user_ID: '7' }, { ID: 4, owner_user_ID: '8' },
            { ID: 5 }, { ID: 6, is_active: 0 }, { ID: 7, owner_user_ID: '7' }],
        contexts: [1, 2, 3, 4, 6, 7].map(ID => ({ ID: ID * 10, category_ID: ID, context_values: {} })).concat([
            { ID: 50, category_ID: 5, context_values: { scene: '50' } },
            { ID: 51, category_ID: 5, context_values: { scene: '51' } },
            { ID: 52, category_ID: 5, context_values: {} },
            { ID: 53, category_ID: 5, context_values: { scene: '53' } }
        ]),
        scenes: [{ context_ID: 50, category_ID: 5, name: 'General', is_default: 1 },
            { context_ID: 51, category_ID: 5, name: 'Focused' },
            { context_ID: 53, category_ID: 5, name: 'Retired', is_active: 0 }],
        ...options, pies: [...sourcePies, ...targetPies]
    });
}

test('mixed weights commit to separate tables and loadPersonalPie projects stable negative context IDs', async () => {
    const db = database(), entries = [weight(1, 6000), weight(-20, 2500), weight(-51, 1500)];
    const fallbackRules = [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 2 }] }];
    const receipt = await savePersonalPie(db, request({ entries, fallbackRules }));
    assert.equal(receipt.personalPie.revision, 2);
    assert.deepEqual(db.stored.weights, [weight(1, 6000)]);
    assert.deepEqual(db.stored.topicWeights, [{ targetContextID: 20, weightBasisPoints: 2500 },
        { targetContextID: 51, weightBasisPoints: 1500 }]);
    const loaded = await loadPersonalPie(db, 10, '7');
    assert.deepEqual(order(loaded.entries), order(entries));
    assert.equal(loaded.revision, 2);
    assert.deepEqual(loaded.fallbackRules.map(({ primaryConditionID, mode, entries }) => ({ primaryConditionID, mode, entries })), fallbackRules);
    assert.equal(await loadPersonalPie(db, 10, '8'), null);
    assert.equal(await loadPersonalPie(db, 20, '7'), null);
});

test('a pure-reference pie is stored without fabricated benchmark weights or fallback rules', async () => {
    const db = database({ revision: 0 }), body = request({ expectedRevision: 0 });
    const result = await savePersonalPie(db, body);
    assert.equal(result.personalPie.revision, 1);
    assert.deepEqual(db.stored.weights, []);
    assert.deepEqual(db.stored.topicWeights, [{ targetContextID: 20, weightBasisPoints: 10000 }]);
    assert.deepEqual(db.stored.rules, []);
    assert.deepEqual((await loadPersonalPie(db, 10, '7')).entries, body.entries);
    assert.equal(db.statements.some(({ sql }) => sql.includes('INSERT INTO personal_pie_weights ')), false);
});

test('replacement clears old reference rows, cascades entrance fallback choices, and prunes only unused families', async () => {
    const db = database();
    const fallbackRules = [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 2 }] }];
    await savePersonalPie(db, request({ entries: [weight(1, 5000), weight(-20, 5000)], fallbackRules }));
    const familyID = db.stored.rules[0].familyID;
    assert.ok(db.stored.families.has(familyID));
    const replacement = await savePersonalPie(db, request({ expectedRevision: 2, entries: [weight(-51)] }));
    assert.deepEqual(db.stored.weights, []);
    assert.deepEqual(db.stored.topicWeights, [{ targetContextID: 51, weightBasisPoints: 10000 }]);
    assert.deepEqual(db.stored.rules, []);
    assert.equal(db.stored.families.size, 0);
    assert.deepEqual((await loadPersonalPie(db, 10, '7')).entries, replacement.personalPie.entries);
    await savePersonalPie(db, request({ expectedRevision: 3, entries: [weight(3)] }));
    assert.deepEqual(db.stored.topicWeights, []);
    assert.deepEqual(db.stored.weights, [weight(3)]);
});

test('fallback cleanup preserves a shared family used by another mixed pie', async () => {
    const db = database();
    const entries = [weight(1, 5000), weight(-51, 5000)];
    const fallbackRules = [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 2 }] }];
    await savePersonalPie(db, request({ entries, fallbackRules }));
    await savePersonalPie(db, request({ categoryID: 2, userID: '8', expectedRevision: 0, entries, fallbackRules }));
    const familyID = db.stored.rules[0].familyID;
    await savePersonalPie(db, request({ expectedRevision: 2, entries: [weight(-51)] }));
    assert.equal(db.stored.families.size, 1);
    assert.equal(db.getPie('8', 20).rules[0].familyID, familyID);
    assert.equal((await loadPersonalPie(db, 20, '8')).fallbackRules[0].entries[0].conditionID, 2);
});

for (const [name, options, message] of [
    ['reference insertion', { failReferenceInsert: true }, /reference insert failed after mutation/],
    ['receipt completion', { failCompletion: true }, /completion failed/]
]) test(`${name} failure rolls back both weight tables, revision, families, and write intent`, async () => {
    const db = database({ ...options, pies: [{ ID: 70, user_ID: '7', context_ID: 10, revision: 4,
        weights: [weight(1, 6000)], topicWeights: [{ targetContextID: 20, weightBasisPoints: 4000 }],
        rules: [{ primaryConditionID: 1, familyID: null }] }] }), before = db.stored;
    await assert.rejects(savePersonalPie(db, request({ expectedRevision: 4, entries: [weight(3, 6000), weight(-51, 4000)],
        fallbackRules: [{ primaryConditionID: 3, mode: 'ordered', entries: [{ conditionID: 2 }] }] })), message);
    assert.deepEqual(db.stored, before);
    assert.equal(db.mutations, 0); assert.equal(db.commits, 0);
    assert.equal(db.events.at(-2), 'rollback');
});

test('lost commit acknowledgement replays the exact reference receipt without repeating the write', async () => {
    const db = database({ loseCommit: true }), body = request({ entries: [weight(1, 6000), weight(-20, 4000)] });
    await assert.rejects(savePersonalPie(db, body), /acknowledgement lost/);
    assert.equal(db.stored.receipts.size, 1);
    const before = db.stored, receipt = await savePersonalPie(db, body);
    assert.deepEqual(db.stored, before);
    assert.equal(db.mutations, 1); assert.equal(receipt.personalPie.revision, 2);
    assert.deepEqual(receipt.personalPie.entries, body.entries);
    assert.equal(db.events.includes('destroy'), true);
});

test('concurrent identical reference deliveries persist once and reject reuse with a different target', async () => {
    const db = database(), body = request();
    const receipts = await Promise.all(Array.from({ length: 8 }, () => savePersonalPie(db, body)));
    for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
    assert.equal(db.mutations, 1); assert.equal(db.stored.receipts.size, 1);
    assert.equal(db.stored.topicWeights.length, 1);
    const before = db.stored;
    await assert.rejects(savePersonalPie(db, { ...body, entries: [weight(-51)] }), error('write_identity_reused'));
    assert.deepEqual(db.stored, before);
});

test('clearing a mixed pie cascades both tables; its old receipt cannot delete a recreated reference pie', async () => {
    const db = database();
    await savePersonalPie(db, request({ entries: [weight(1, 5000), weight(-20, 5000)] }));
    const deletion = request({ expectedRevision: 2, entries: [] }), receipt = await savePersonalPie(db, deletion);
    assert.equal(receipt.personalPie.revision, 0);
    assert.equal(db.stored.pie, null); assert.deepEqual(db.stored.topicWeights, []);
    assert.equal(await loadPersonalPie(db, 10, '7'), null);
    await savePersonalPie(db, request({ expectedRevision: 0, entries: [weight(-51)] }));
    const before = db.stored;
    assert.deepEqual(await savePersonalPie(db, deletion), receipt);
    assert.deepEqual(db.stored, before);
    assert.deepEqual((await loadPersonalPie(db, 10, '7')).entries, [weight(-51)]);
});

for (const reverse of [false, true]) test(`concurrent opposing references both commit (${reverse})`, async () => {
    const db = database();
    const bodies = [request(), request({ categoryID: 2, userID: '8', expectedRevision: 0, entries: [weight(-10)] })];
    if (reverse) bodies.reverse();
    const results = await Promise.allSettled(bodies.map(body => savePersonalPie(db, body)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    assert.ok(db.peakTransactions > 1, 'Transactions overlap before the graph row lock');
    assert.deepEqual(db.graphReads, []);
    assert.equal([...db.stored.pies.values()].reduce((count, pie) => count + pie.topicWeights.length, 0), 2);
    assert.equal(db.stored.receipts.size, 2); assert.equal(db.mutations, 2);
});

test('transitive references across topics can be saved with stable scene identities', async () => {
    const db = database();
    await savePersonalPie(db, request());
    await savePersonalPie(db, request({ categoryID: 2, userID: '8', expectedRevision: 0, entries: [weight(-51)] }));
    await savePersonalPie(db, request({ categoryID: 5, contextValues: { scene: '51' }, expectedRevision: 0,
        entries: [weight(-10)] }));
    assert.deepEqual((await loadPersonalPie(db, 51, '7')).entries, [weight(-10)]);
});

for (const [label, extra, code] of [
    ['direct self topic', { entries: [weight(-10)] }, 'topic_reference_self'],
    ['direct self scene', { categoryID: 5, contextValues: { scene: '51' }, expectedRevision: 0, entries: [weight(-51)] }, 'topic_reference_self'],
    ['missing target', { entries: [weight(-999)] }, 'topic_reference_not_found'],
    ['topic ID instead of context ID', { entries: [weight(-2)] }, 'topic_reference_not_found'],
    ['inactive topic', { entries: [weight(-60)] }, 'topic_reference_not_found'],
    ['retired scene', { entries: [weight(-53)] }, 'topic_reference_not_found'],
    ['umbrella context of a topic with scenes', { entries: [weight(-52)] }, 'topic_reference_not_found'],
    ['own private target in a public composition', { entries: [weight(-30)] }, 'private_topic_reference_not_public'],
    ['another account private target', { entries: [weight(-40)] }, 'topic_reference_not_found'],
    ['another account private source', { categoryID: 4, expectedRevision: 0 }, 'category_not_found'],
    ['a scene belonging to another topic', { contextValues: { scene: '51' } }, 'topic_scene_not_found'],
    ['a scene from another topic for a scene source', { categoryID: 5, contextValues: { scene: '20' } }, 'topic_scene_not_found']
]) test(`save rejects ${label} atomically`, async () => {
    const db = database(), before = db.stored;
    await assert.rejects(savePersonalPie(db, request(extra)), error(code));
    assert.deepEqual(db.stored, before);
    assert.equal(db.mutations, 0); assert.equal(db.stored.receipts.size, 0);
});

test('empty references are rejected without changing the source pie or saving a receipt', async () => {
    const db = database({ seedReferences: false }), before = db.stored;
    await assert.rejects(savePersonalPie(db, request()), error('topic_reference_empty'));
    assert.deepEqual(db.stored, before);
    assert.equal(db.mutations, 0); assert.equal(db.stored.receipts.size, 0);
});

test('own private topics can reference own private and public targets, but not another owner private target', async () => {
    const db = database();
    const receipt = await savePersonalPie(db, request({ categoryID: 3, expectedRevision: 0,
        entries: [weight(-70, 5000), weight(-20, 5000)] }));
    assert.equal(receipt.personalPie.revision, 1);
    assert.deepEqual(order((await loadPersonalPie(db, 30, '7')).entries), order(receipt.personalPie.entries));
    const before = db.stored;
    await assert.rejects(savePersonalPie(db, request({ categoryID: 3, entries: [weight(-40)] })), error('topic_reference_not_found'));
    assert.deepEqual(db.stored, before);
});

test('scene writes require an explicit stable identity and never create an umbrella pie', async () => {
    const db = database();
    const before = db.stored;
    await assert.rejects(savePersonalPie(db, request({ categoryID: 5, expectedRevision: 0 })), error('topic_scene_required'));
    assert.deepEqual(db.stored, before);
    const general = await savePersonalPie(db, request({ categoryID: 5, contextValues: { scene: '50' }, expectedRevision: 0 }));
    assert.deepEqual(general.contextValues, { scene: '50' });
    assert.equal(db.getPie('7', 50).revision, 1); assert.equal(db.getPie('7', 52), null);
    const next = await savePersonalPie(db, request({ categoryID: 5, contextValues: { scene: '50' }, entries: [weight(2)] }));
    assert.equal(next.personalPie.revision, 2);
    await savePersonalPie(db, request({ categoryID: 5, contextValues: { scene: '51' }, expectedRevision: 0 }));
    assert.equal(db.getPie('7', 51).revision, 1);
    assert.equal(db.getPie('7', 50).revision, 2);
    assert.equal(db.getPie('7', 52), null);
});

for (const user of [{ ID: '7', deleted_at: new Date() }, { ID: '7', banned_at: new Date(), banned_until: null }]) {
    test(`unavailable account cannot mutate references (${user.deleted_at ? 'deactivated' : 'banned'})`, async () => {
        const db = database({ users: [user] }), before = db.stored;
        await assert.rejects(savePersonalPie(db, request()), error('account_unavailable'));
        assert.deepEqual(db.stored, before);
        assert.equal(db.stored.receipts.size, 0);
    });
}

test('mixed totals, duplicate reference IDs and reference fallbacks are validated before opening a transaction', async () => {
    for (const [extra, code] of [
        [{ entries: [weight(1, 6000), weight(-20, 5000)] }, 'pie_total_must_equal_100_percent'],
        [{ entries: [weight(-20, 5000), weight(-20, 5000)] }, 'invalid_pie_entry'],
        [{ entries: [weight(0)] }, 'invalid_pie_entry'],
        [{ fallbackRules: [{ primaryConditionID: -20, mode: 'ordered', entries: [] }] }, 'invalid_personal_pie_fallback_rule'],
        [{ entries: [weight(1)], fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: -20 }] }] },
            'invalid_personal_pie_fallback_component']
    ]) {
        const db = database();
        await assert.rejects(savePersonalPie(db, request(extra)), error(code));
        assert.equal(db.borrows, 0); assert.equal(db.mutations, 0);
    }
});

test('stale revision cannot replace references or retain a write intent', async () => {
    const db = database();
    await savePersonalPie(db, request());
    const before = db.stored;
    await assert.rejects(savePersonalPie(db, request({ entries: [weight(-51)] })), error('pie_revision_conflict'));
    assert.deepEqual(db.stored, before);
});
