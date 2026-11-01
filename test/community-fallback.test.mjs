import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPersonalPie, scoreModels } from '../ranking-service.js';
import { fallbackPickerChoices } from '../public/js/workspace/fallback-picker.js';
import { createGuestDraftStore } from '../public/js/workspace/guest-drafts.js';
import { createPersonalPieRecovery } from '../public/js/workspace/pie-recovery.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { inspectCommunityFallback, migrateCommunityFallback } from '../scripts/migrate-community-fallback-20261030.mjs';

const none = { primaryConditionID: 1, mode: 'ordered', entries: [] };
const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

test('saved NULL-family rows load as explicit none; missing rows stay unconfigured', async () => {
    for (const configured of [true, false]) {
        const db = { async execute(sql) {
            if (sql.includes('FROM personal_pies')) return [[{ ID: 1, revision: 2 }]];
            if (sql.includes('FROM personal_pie_weights')) return [[{ benchmark_condition_ID: 1, weight_basis_points: 10000 }]];
            if (sql.includes('FROM personal_pie_score_rules')) return [configured ? [{ pie_ID: 1,
                primary_benchmark_condition_ID: 1, selected_family_ID: null, family_ID: null, chain_hash: null,
                position: null, fallback_benchmark_condition_ID: null }] : []];
            throw new Error(sql);
        } };
        const pie = await loadPersonalPie(db, 1, '7');
        assert.deepEqual(pie.fallbackRules, configured ? [{ ...none, familyID: null }] : []);
    }
});

test('the temporary primary-only default is never displayed as a 100% no-fallback vote', () => {
    const choices = fallbackPickerChoices({ ID: 1 }, { action: 'replace', catalogue: { featured: [], items: [] },
        composition: { configuredPieCount: 0, isDefault: true, families: [{ entries: [], weightBasisPoints: 10000 }] } });
    assert.deepEqual(choices.map(choice => [choice.key, choice.shareBasisPoints]), [['[1]', 0]]);
});

test('guest drafts retain the difference between explicit none and community', () => {
    const saved = storage(), drafts = createGuestDraftStore(() => saved);
    for (const fallbackRules of [[none], []]) {
        drafts.set('topic', { entries, fallbackRules });
        assert.deepEqual(createGuestDraftStore(() => saved).get('topic'), { entries, fallbackRules });
    }
    const state = { ...createWorkspaceState(), authenticated: true, userID: '7', categoryID: 1,
        selectedContextValues: {}, personalEntries: entries, personalFallbackRules: [none] };
    const recovery = createPersonalPieRecovery({ state, guestDrafts: drafts, getStorage: () => saved,
        snapshot: () => ({ entries: state.personalEntries, fallbackRules: state.personalFallbackRules }) });
    recovery.checkpoint();
    assert.deepEqual(recovery.lookup('7', 1, {}).value.draft.fallbackRules, [none]);
    state.personalFallbackRules = [];
    state.personalEditVersion++;
    recovery.checkpoint();
    assert.deepEqual(recovery.lookup('7', 1, {}).value.draft.fallbackRules, []);
});

test('inherited chains remain flat and recalculate when the community changes', () => {
    const model = { ID: 1, results: new Map([['2', { normalizedScore: 20 }], ['3', { normalizedScore: 80 }]]) };
    const composition = conditionID => [{ primaryConditionID: 1, families: [{ primaryConditionID: 1,
        familyID: conditionID, entries: [{ conditionID }], weightBasisPoints: 10000 }] }];
    const score = (id, fallbackRules = []) => scoreModels([model], entries, 10000,
        { familyComposition: composition(id), fallbackRules })[0];
    assert.equal(score(2).lower, 20);
    assert.equal(score(3).lower, 80);
    assert.equal(score(3, [none]).coverage, 0);
    model.results.set('1', { normalizedScore: 0 });
    assert.equal(score(3).lower, 0);
    assert.equal(score(3).fallbackUsageCount, 0);
});

function migrationFixture() {
    const state = { nullable: 'NO', memberNullable: 'YES', marked: false, rules: 3, families: 2, revision: 4,
        pies: [{ ID: 1, user_ID: 7, context_ID: 2, created_at: '2026-10-20', updated_at: '2026-10-29' }],
        weights: [{ pie_ID: 1, benchmark_condition_ID: 8, weight_basis_points: 10000 }],
        failMarker: false, failFinalDDL: false, writes: [] };
    let transaction;
    return { state,
        async beginTransaction() { transaction = structuredClone(state); },
        async commit() { transaction = null; },
        async rollback() { Object.assign(state, transaction); transaction = null; },
        async execute(sql) {
            if (sql.includes('information_schema.COLUMNS')) return [[
                { tableName: 'personal_pie_score_rules', type: 'bigint unsigned', nullable: state.nullable },
                { tableName: 'benchmark_family_members', type: 'bigint unsigned', nullable: state.memberNullable }
            ]];
            if (sql.startsWith('SELECT migration_id')) return [state.marked ? [{ migration_id: 'community_fallback_20261030' }] : []];
            if (sql.startsWith('INSERT INTO schema_migrations')) {
                if (state.failMarker) throw new Error('marker failed');
                state.marked = true; return [{ affectedRows: 1 }];
            }
            throw new Error(sql);
        },
        async query(sql) {
            if (sql.includes('FROM personal_pie_weights')) return [structuredClone(state.weights)];
            if (sql.includes('FROM personal_pies ORDER BY')) return [structuredClone(state.pies)];
            state.writes.push(sql);
            if (sql.startsWith('ALTER TABLE personal_pie_score_rules')) { state.nullable = 'YES'; return []; }
            if (sql.startsWith('ALTER TABLE benchmark_family_members')) {
                if (state.failFinalDDL) throw new Error('DDL interrupted');
                state.memberNullable = 'NO'; return [];
            }
            if (sql.startsWith('UPDATE personal_pies')) { if (state.rules) state.revision++; return []; }
            if (sql === 'DELETE FROM personal_pie_score_rules') { const affectedRows = state.rules; state.rules = 0; return [{ affectedRows }]; }
            if (sql === 'DELETE FROM benchmark_families') { const affectedRows = state.families; state.families = 0; return [{ affectedRows }]; }
            throw new Error(sql);
        }
    };
}

test('authorized reset removes all legacy choices once while preserving weights and activity', async () => {
    const db = migrationFixture(), before = structuredClone(db.state);
    assert.equal((await inspectCommunityFallback(db)).ready, false);
    const result = await migrateCommunityFallback(db);
    assert.equal(result.ready, true);
    assert.equal(result.clearedRules, 3);
    assert.equal(result.clearedFamilies, 2);
    assert.equal(result.protectedDataUnchanged, true);
    assert.deepEqual(db.state.weights, before.weights);
    assert.deepEqual(db.state.pies, before.pies);
    assert.equal(db.state.revision, 5);
    db.state.rules = 1; db.state.families = 1;
    assert.equal((await migrateCommunityFallback(db)).applied, false);
    assert.equal(db.state.rules, 1);
    assert.equal(db.state.families, 1);
});

test('failed reset rolls back choices and marker together', async () => {
    const db = migrationFixture(); db.state.failMarker = true;
    await assert.rejects(migrateCommunityFallback(db), /marker failed/);
    assert.equal(db.state.rules, 3);
    assert.equal(db.state.families, 2);
    assert.equal(db.state.revision, 4);
    assert.equal(db.state.marked, false);
    db.state.failMarker = false;
    assert.equal((await migrateCommunityFallback(db)).ready, true);
});

test('retry after final DDL failure cannot delete newly chosen fallback configurations', async () => {
    const db = migrationFixture(); db.state.failFinalDDL = true;
    await assert.rejects(migrateCommunityFallback(db), /DDL interrupted/);
    assert.equal(db.state.marked, true);
    db.state.rules = 2; db.state.families = 2; db.state.failFinalDDL = false;
    assert.equal((await migrateCommunityFallback(db)).ready, true);
    assert.equal(db.state.rules, 2);
    assert.equal(db.state.families, 2);
    assert.equal(db.state.revision, 5);
});

test('no community choices calculates exactly like no fallback, including zero and negative results', () => {
    for (const fallbackScope of ['public', 'personal']) for (const scoreMode of ['available', 'range']) {
        for (const value of [null, 0, -5, 30]) {
            const model = { ID: 1, results: new Map(value === null ? [] : [['1', { normalizedScore: value }]]) };
            const automatic = scoreModels([model], entries, 10000, { fallbackScope, scoreMode });
            const explicit = scoreModels([model], entries, 10000, { fallbackScope: 'personal', scoreMode, fallbackRules: [none] });
            assert.deepEqual(automatic, explicit);
        }
    }
});

test('legacy browser drafts lose only fallback choices and keep their exact weights', () => {
    const saved = storage();
    const key = 'benchpoll:guest-pie:v3:topic';
    saved.setItem(key, JSON.stringify({ token: 'e1111111-1111-4111-8111-111111111111',
        value: { entries, fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ kind: 'other_versions' }] }] } }));
    const store = createGuestDraftStore(() => saved);
    assert.deepEqual(store.get('topic'), { entries, fallbackRules: [] });
    assert.equal(JSON.parse(saved.getItem(key)).value.fallbackConfigurationVersion, 2);
    store.set('topic', { entries, fallbackRules: [none] });
    assert.deepEqual(createGuestDraftStore(() => saved).get('topic').fallbackRules, [none]);
});
