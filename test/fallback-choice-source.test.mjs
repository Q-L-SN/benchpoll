import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { savePersonalPie, loadPersonalPie, scoreModels } from '../ranking-service.js';
import { createPieSaveDatabase } from '../scripts/personal-pie-save-fixture.mjs';
import { fallbackStatusLabel, COMMUNITY_FALLBACK_EXPLANATION } from '../public/js/shared/fallback-choice.js';
import { migrateFallbackChoiceSource } from '../scripts/migrate-fallback-choice-source-20261031.mjs';

test('fallback labels reflect the local choice, including an empty or unsaved custom configuration', () => {
    assert.equal(fallbackStatusLabel(null), 'Follow community');
    assert.equal(fallbackStatusLabel({ entries: [], selectionSource: 'custom' }), 'Custom');
    assert.equal(fallbackStatusLabel({ entries: [{ conditionID: 2 }], selectionSource: 'custom' }), 'Custom');
    assert.equal(fallbackStatusLabel({ entries: [], selectionSource: 'selected' }), 'No fallback');
    assert.equal(fallbackStatusLabel({ entries: [{ conditionID: 2 }], selectionSource: 'selected' }), 'Selected configuration');
    assert.match(COMMUNITY_FALLBACK_EXPLANATION, /Only people who explicitly choose/);
    assert.match(COMMUNITY_FALLBACK_EXPLANATION, /weighted by their allocation/);
    assert.match(COMMUNITY_FALLBACK_EXPLANATION, /If nobody has made a choice, no fallback is used/);
});

for (const selectionSource of ['custom', 'selected']) for (const backups of [[], [{ conditionID: 2 }]]) {
    test(`selection source survives save, receipt replay and reload: ${selectionSource}, ${backups.length} backups`, async () => {
        const db = createPieSaveDatabase();
        const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
        const rule = { primaryConditionID: 1, mode: 'ordered', entries: backups, selectionSource };
        const body = { userID: '7', writeIdentity: randomUUID(), categoryID: 1, contextValues: {}, expectedRevision: 1,
            entries, fallbackRules: [rule] };
        const receipt = await savePersonalPie(db, body);
        assert.deepEqual(receipt.personalPie.fallbackRules, [rule]);
        assert.deepEqual(await savePersonalPie(db, body), receipt);
        const pie = await loadPersonalPie(db, 10, '7');
        assert.equal(pie.fallbackRules[0].selectionSource, selectionSource);
        assert.deepEqual(pie.fallbackRules[0].entries, backups);
        assert.deepEqual(pie.entries, entries);
    });
}

test('unsupported selection sources fail before changing weights or casting a choice', async () => {
    for (const selectionSource of ['community', '', null, 1]) {
        const db = createPieSaveDatabase(), before = db.stored;
        await assert.rejects(savePersonalPie(db, { userID: '7', writeIdentity: randomUUID(), categoryID: 1,
            contextValues: {}, expectedRevision: 1, entries: [{ conditionID: 1, weightBasisPoints: 10000 }],
            fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [], selectionSource }] }),
        error => error.body?.error === 'invalid_personal_pie_fallback_rule');
        assert.deepEqual(db.stored, before);
    }
});

test('source metadata has no effect on fallback scoring', () => {
    const models = [{ ID: 1, name: 'Model', results: new Map([['2', { normalizedScore: 65 }]]) }];
    const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
    const base = { primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 2 }] };
    assert.equal(scoreModels(models, entries, 10000, { fallbackRules: [base] })[0].lower, 65);
    assert.deepEqual(scoreModels(models, entries, 10000, { fallbackRules: [{ ...base, selectionSource: 'custom' }], fallbackScope: 'personal' }),
        scoreModels(models, entries, 10000, { fallbackRules: [{ ...base, selectionSource: 'selected' }], fallbackScope: 'personal' }));
});

test('source migration is additive and idempotent, including dry-run and lock release', async () => {
    let exists = false;
    const statements = [];
    const connection = { async execute(sql) {
        statements.push(sql);
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        if (sql.includes('information_schema.COLUMNS')) return [exists
            ? [{ type: "enum('selected','custom')", defaultValue: 'selected', nullable: 'NO' }] : []];
        assert.match(sql, /^ALTER TABLE personal_pie_score_rules\s+ADD COLUMN selection_source/);
        assert.match(sql, /ALGORITHM=INSTANT/);
        exists = true;
        return [{}];
    } };
    assert.deepEqual(await migrateFallbackChoiceSource(connection), { applied: false, missing: true });
    assert.equal(exists, false);
    assert.deepEqual(await migrateFallbackChoiceSource(connection, { apply: true }), { applied: true, changed: true, missing: false });
    assert.deepEqual(await migrateFallbackChoiceSource(connection, { apply: true }), { applied: true, changed: false, missing: false });
    assert.equal(statements.filter(sql => sql.startsWith('ALTER TABLE')).length, 1);
    assert.equal(statements.filter(sql => sql.includes('RELEASE_LOCK')).length, 2);
    assert.equal(statements.some(sql => /DELETE|UPDATE|DROP|TRUNCATE/.test(sql)), false);
});
