import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
    checkRankingIntegrity, countInvalidPersonalPieTotals, inspectTopicSceneIntegrity, readTopicReferenceSchema,
    runRankingIntegrityAudit
} from '../scripts/check-ranking-integrity.mjs';

function context(ID, categoryID, values = {}) {
    const serialized = JSON.stringify(Object.fromEntries(Object.keys(values).sort().map(key => [key, values[key]])));
    return { ID, category_ID: categoryID, context_values: values,
        context_hash: crypto.createHash('sha256').update(serialized).digest('hex') };
}

function sceneState() {
    return {
        categories: [
            { ID: 10, parent_ID: null, name: 'Intelligence', is_active: 1 },
            { ID: 20, parent_ID: null, name: 'Image generation', is_active: 1 }
        ],
        contexts: [context(100, 10), context(200, 20, { scene: '200' }), context(201, 20, { scene: '201' })],
        scenes: [
            { context_ID: 200, category_ID: 20, is_active: 1, is_default: 1 },
            { context_ID: 201, category_ID: 20, is_active: 1, is_default: 0 }
        ],
        referencedContextIDs: [100, 200, 201]
    };
}

function checkNamed(checks, name) {
    const check = checks.find(row => row.name === name);
    assert.ok(check, `Missing integrity check: ${name}`);
    return check;
}

function inspect(state, name) {
    return checkNamed(inspectTopicSceneIntegrity(state), name);
}

// New-schema data queries, including aggregation, run as SQL against in-memory rows.
// Metadata and the unrelated legacy score/catalogue audits are outside this fixture's scope.
function integrityDatabase(t, state = sceneState(), options = {}) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const tables = options.tables ?? ['topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock'];
    db.exec(`
        CREATE TABLE categories (ID INTEGER, parent_ID INTEGER, name TEXT, is_active INTEGER);
        CREATE TABLE ranking_contexts (ID INTEGER, category_ID INTEGER, context_values TEXT, context_hash TEXT);
        CREATE TABLE ranking_dimensions (ID INTEGER, scope_category_ID INTEGER, dimension_key TEXT, is_active INTEGER);
        CREATE TABLE ranking_dimension_options (dimension_ID INTEGER, option_key TEXT);
        CREATE TABLE personal_pies (ID INTEGER, user_ID INTEGER, context_ID INTEGER);
        CREATE TABLE personal_pie_weights (pie_ID INTEGER, benchmark_condition_ID INTEGER, weight_basis_points INTEGER);
        CREATE TABLE personal_pie_score_rules (pie_ID INTEGER, primary_benchmark_condition_ID INTEGER, family_ID INTEGER);
        CREATE TABLE benchmark_families (ID INTEGER, primary_benchmark_condition_ID INTEGER, chain_hash TEXT);
        CREATE TABLE benchmark_family_members (family_ID INTEGER, position INTEGER, benchmark_condition_ID INTEGER);
    `);
    if (tables.includes('topic_scenes')) db.exec('CREATE TABLE topic_scenes (context_ID INTEGER, category_ID INTEGER, is_active INTEGER, is_default INTEGER)');
    if (tables.includes('personal_pie_topic_weights')) db.exec('CREATE TABLE personal_pie_topic_weights (pie_ID INTEGER, target_context_ID INTEGER, weight_basis_points INTEGER)');
    if (tables.includes('topic_reference_lock')) {
        db.exec('CREATE TABLE topic_reference_lock (ID INTEGER)');
        for (const ID of options.lockIDs ?? [1]) db.prepare('INSERT INTO topic_reference_lock VALUES (?)').run(ID);
    }
    for (const row of state.categories) db.prepare('INSERT INTO categories VALUES (?, ?, ?, ?)')
        .run(row.ID, row.parent_ID, row.name, row.is_active);
    for (const row of state.contexts) db.prepare('INSERT INTO ranking_contexts VALUES (?, ?, ?, ?)')
        .run(row.ID, row.category_ID, typeof row.context_values === 'string' ? row.context_values : JSON.stringify(row.context_values), row.context_hash);
    if (tables.includes('topic_scenes')) {
        for (const row of state.scenes) db.prepare('INSERT INTO topic_scenes VALUES (?, ?, ?, ?)')
            .run(row.context_ID, row.category_ID, row.is_active, row.is_default);
    }
    const statements = [];
    const connection = {
        async execute(sql, params = []) {
            const query = sql.replace(/\s+/g, ' ').trim();
            statements.push(query);
            assert.match(query, /^(SELECT|WITH)\b/, 'Integrity audits must be read-only');
            if (query.includes('information_schema.TABLES')) {
                return [db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").all(params[0])];
            }
            if (query.includes('information_schema.REFERENTIAL_CONSTRAINTS') || query.includes('information_schema.STATISTICS')) {
                return [[{ count: (options.missingSchemaObjects ?? []).includes(params[1]) ? 0 : 1 }]];
            }
            if (query.includes('information_schema.COLUMNS')) return [[{ count: 0 }]];
            if (query.includes('topic_scenes_references_20261031')) return [[{ count: Number(options.migrated ?? tables.length > 0) }]];
            if (query.includes('FROM schema_migrations')) return [[{ count: 0 }]];
            if (query.includes(') invalid_pies') || query.includes('FROM personal_pie_topic_weights')
                || query.includes('FROM topic_reference_lock') || query.includes('FROM topic_scenes')
                || /^SELECT (ID, parent_ID|ID, category_ID|ID, scope_category_ID|dimension_ID, option_key|context_ID, COUNT)/.test(query)
                || query.includes('FROM personal_pie_score_rules rules') && query.includes('families.ID IS NULL')) {
                return [db.prepare(query).all(...params)];
            }
            if (query.includes('COUNT(')) return [[{ count: 0 }]];
            if (/FROM (score_fields|score_field_options|benchmark_results|benchmark_families f)\b/.test(query)) return [[]];
            throw new Error('Unexpected integrity query: ' + query);
        }
    };
    return { db, connection, statements };
}

test('flat topics may have no scenes or exactly one default among multiple scenes', () => {
    assert.equal(inspectTopicSceneIntegrity(sceneState()).every(check => check.passed), true);
});

test('retired scenes, inactive topics and unused legacy contexts retain their identity', () => {
    const state = sceneState();
    state.scenes.push({ context_ID: 202, category_ID: 20, is_active: 0, is_default: 0 });
    state.contexts.push(context(202, 20, { scene: '202' }), context(203, 20, { output: 'image', realtime: 'yes' }));
    state.categories.push({ ID: 30, parent_ID: null, name: 'Retired topic', is_active: 0 });
    state.contexts.push(context(300, 30, { legacy: 'preserved' }));
    state.referencedContextIDs.push(202, 300);
    assert.equal(inspectTopicSceneIntegrity(state).every(check => check.passed), true);
});

for (const [label, change] of [
    ['no default', state => { state.scenes[0].is_default = 0; }],
    ['two defaults', state => { state.scenes[1].is_default = 1; }]
]) {
    test(`rejects ${label} for a topic with active scenes`, () => {
        const state = sceneState(); change(state);
        assert.deepEqual(inspect(state, 'topics without exactly one active default scene').details, [20]);
    });
}

test('an inactive default and nonbinary scene flags are invalid', () => {
    const state = sceneState();
    state.scenes[0].is_active = 0;
    state.scenes[1].is_default = 2;
    assert.deepEqual(inspect(state, 'scenes with invalid active/default flags').details, [200, 201]);
});

test('nullable scene flags are not silently treated as false', () => {
    const state = sceneState();
    state.scenes[0].is_active = null;
    state.scenes[1].is_default = null;
    assert.deepEqual(inspect(state, 'scenes with invalid active/default flags').details, [200, 201]);
});

test('a topic without active scenes still needs its own root context', () => {
    const state = sceneState();
    state.contexts = state.contexts.filter(row => row.ID !== 100);
    assert.deepEqual(inspect(state, 'active topics without scenes lack a root context').details, [10]);
});

test('nested topics cannot host another scene level', () => {
    const state = sceneState();
    state.categories[1].parent_ID = 10;
    assert.equal(inspect(state, 'topics with nested parents').count, 1);
    assert.deepEqual(inspect(state, 'scenes without a root topic').details, [200, 201]);
});

test('scenes with missing topics are rejected', () => {
    const state = sceneState(); state.categories.pop();
    assert.equal(inspect(state, 'scenes without a root topic').count, 2);
});

for (const [label, replace] of [
    ['different category', row => ({ ...row, category_ID: 10 })],
    ['different scene ID', () => context(200, 20, { scene: '201' })],
    ['numeric instead of canonical string identity', () => context(200, 20, { scene: 200 })],
    ['nested legacy dimension', () => context(200, 20, { scene: '200', realtime: 'yes' })],
    ['root identity on a scene', () => context(200, 20)],
    ['wrong hash', row => ({ ...row, context_hash: 'bad-hash' })],
    ['invalid JSON', row => ({ ...row, context_values: '{' })],
    ['array JSON', row => ({ ...row, context_values: [] })]
]) {
    test(`scene identity rejects ${label}`, () => {
        const state = sceneState(); state.contexts[1] = replace(state.contexts[1]);
        assert.deepEqual(inspect(state, 'scenes with mismatched context identity').details, [200]);
    });
}

test('a deleted context cannot leave a scene pointing at it', () => {
    const state = sceneState(); state.contexts.splice(1, 1);
    assert.deepEqual(inspect(state, 'scenes with mismatched context identity').details, [200]);
});

test('scene identities accept JSON strings returned by database drivers', () => {
    const state = sceneState();
    state.contexts = state.contexts.map(row => ({ ...row, context_values: JSON.stringify(row.context_values) }));
    assert.equal(inspectTopicSceneIntegrity(state).every(check => check.passed), true);
});

test('duplicate scene context identities and unregistered scene contexts are rejected', () => {
    const state = sceneState();
    state.scenes.push({ ...state.scenes[0] });
    state.contexts.push(context(999, 20, { scene: '999' }));
    assert.deepEqual(inspect(state, 'duplicate scene context identities').details, [200]);
    assert.deepEqual(inspect(state, 'scene contexts without a scene record').details, [999]);
});

test('configured legacy combinations and umbrella roots cannot stand in for concrete scenes', () => {
    const state = sceneState();
    state.contexts.push(context(202, 20), context(203, 20, { output: 'image' }));
    state.referencedContextIDs.push(202, 203, 999, 202);
    assert.deepEqual(inspect(state, 'referenced contexts are not a concrete topic or scene').details, [202, 203, 999]);
});

test('new-schema metadata checks pass only with every table, FK, identity index and graph lock', async t => {
    const { connection } = integrityDatabase(t);
    const schema = await readTopicReferenceSchema(connection);
    assert.equal(schema.enabled, true);
    assert.equal(schema.checks.every(check => check.passed), true);
});

for (const missing of ['topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock']) {
    test(`partial migration reports missing ${missing} instead of reverting to legacy mode`, async t => {
        const { connection } = integrityDatabase(t, sceneState(), {
            tables: ['topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock'].filter(table => table !== missing),
            migrated: true
        });
        const schema = await readTopicReferenceSchema(connection);
        assert.equal(schema.enabled, true);
        assert.equal(checkNamed(schema.checks, `topic reference table missing: ${missing}`).count, 1);
        const report = await checkRankingIntegrity(connection);
        assert.equal(report.status, 'failed');
    });
}

test('a migration marker without tables remains a failed new-schema audit', async t => {
    const { connection } = integrityDatabase(t, sceneState(), { tables: [], migrated: true });
    const schema = await readTopicReferenceSchema(connection);
    assert.equal(schema.enabled, true);
    assert.equal(schema.checks.filter(check => check.name.startsWith('topic reference table missing') && !check.passed).length, 3);
});

test('new tables without a completed migration marker are reported', async t => {
    const { connection } = integrityDatabase(t, sceneState(), { migrated: false });
    assert.equal(checkNamed((await readTopicReferenceSchema(connection)).checks, 'topic scenes migration missing').count, 1);
});

test('metadata read failures cannot silently select legacy mode', async () => {
    const failure = new Error('Metadata unavailable');
    await assert.rejects(readTopicReferenceSchema({ async execute() { throw failure; } }), error => error === failure);
});

for (const lockIDs of [[], [2], [1, 2]]) {
    test(`graph lock singleton rejects rows ${JSON.stringify(lockIDs)}`, async t => {
        const { connection } = integrityDatabase(t, sceneState(), { lockIDs });
        assert.equal(checkNamed((await readTopicReferenceSchema(connection)).checks, 'topic reference graph lock missing or invalid').passed, false);
    });
}

test('missing scene identity constraints are reported', async t => {
    const { connection } = integrityDatabase(t, sceneState(), {
        missingSchemaObjects: ['fk_topic_scene_context', 'fk_topic_weight_context', 'uq_topic_scene_default', 'uq_ranking_context_identity']
    });
    assert.equal((await readTopicReferenceSchema(connection)).checks.filter(check => !check.passed).length, 4);
});

test('combined totals count benchmarks and references once, including duplicate weight amounts', async t => {
    const { db, connection } = integrityDatabase(t);
    db.exec(`
        INSERT INTO personal_pies VALUES (1, 7, 100), (2, 8, 100), (3, 9, 100), (4, 10, 100);
        INSERT INTO personal_pie_weights VALUES (1, 1, 2500), (1, 2, 2500), (2, 1, 10000);
        INSERT INTO personal_pie_topic_weights VALUES (1, 200, 2500), (1, 201, 2500), (3, 200, 10000);
    `);
    assert.equal(await countInvalidPersonalPieTotals(connection, true), 0);
    assert.equal(await countInvalidPersonalPieTotals(connection, false), 1);
});

test('combined totals catch underweight, overweight and benchmark-only false positives', async t => {
    const { db, connection } = integrityDatabase(t);
    db.exec(`
        INSERT INTO personal_pies VALUES (1, 7, 100), (2, 8, 100), (3, 9, 100), (4, 10, 100);
        INSERT INTO personal_pie_weights VALUES (1, 1, 10000), (3, 1, 4000), (4, 1, 6000);
        INSERT INTO personal_pie_topic_weights VALUES (1, 200, 1), (2, 200, 9999), (3, 200, 5999), (4, 200, 4001);
    `);
    assert.equal(await countInvalidPersonalPieTotals(connection, true), 4);
});

test('legacy totals work without a references table', async t => {
    const { db, connection } = integrityDatabase(t, sceneState(), { tables: [], migrated: false });
    db.exec('INSERT INTO personal_pies VALUES (1, 7, 100), (2, 8, 100); INSERT INTO personal_pie_weights VALUES (1, 1, 10000)');
    assert.equal((await readTopicReferenceSchema(connection)).enabled, false);
    assert.equal(await countInvalidPersonalPieTotals(connection, false), 0);
    db.exec('UPDATE personal_pie_weights SET weight_basis_points = 9999');
    assert.equal(await countInvalidPersonalPieTotals(connection, false), 1);
});

test('the full checker uses scene semantics and combined totals without legacy dimension false alarms', async t => {
    const { db, connection } = integrityDatabase(t);
    db.exec(`
        INSERT INTO personal_pies VALUES (1, 7, 100), (2, 7, 200);
        INSERT INTO personal_pie_weights VALUES (1, 1, 5000), (2, 1, 10000);
        INSERT INTO personal_pie_topic_weights VALUES (1, 200, 5000);
    `);
    const report = await checkRankingIntegrity(connection);
    for (const name of [
        'ranking contexts with missing or unknown dimensions', 'ranking contexts with unavailable option values',
        'scenes with mismatched context identity', 'topics without exactly one active default scene',
        'personal pies with totals other than zero or 100 percent', 'referenced contexts are not a concrete topic or scene'
    ]) assert.equal(checkNamed(report.checks, name).passed, true, name);
    db.exec('UPDATE personal_pie_topic_weights SET weight_basis_points = 4000');
    const next = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(next.checks, 'personal pies with totals other than zero or 100 percent').count, 1);
    assert.equal(next.checks.length, report.checks.length, 'Repeated audits do not accumulate prior checks');
});

test('the full checker reports missing reference targets/owners and out-of-range weights', async t => {
    const { db, connection } = integrityDatabase(t);
    db.exec(`
        INSERT INTO personal_pies VALUES (1, 7, 100);
        INSERT INTO personal_pie_topic_weights VALUES (1, 999, 0), (99, 200, 10001), (1, 201, NULL), (1, 200, 1), (1, 201, 99);
    `);
    const report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'topic reference weights with missing pie or target context').count, 2);
    assert.equal(checkNamed(report.checks, 'topic reference weights outside 100 to 10000 basis points').count, 5);
    assert.deepEqual(checkNamed(report.checks, 'referenced contexts are not a concrete topic or scene').details, [999]);
});

test('reference weight bounds include the API minimum of 100 basis points', async t => {
    const { db, connection } = integrityDatabase(t);
    db.exec(`
        INSERT INTO personal_pies VALUES (1, 7, 100), (2, 8, 100);
        INSERT INTO personal_pie_weights VALUES (1, 1, 9900);
        INSERT INTO personal_pie_topic_weights VALUES (1, 200, 100), (2, 201, 10000);
    `);
    const report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'topic reference weights outside 100 to 10000 basis points').count, 0);
    assert.equal(checkNamed(report.checks, 'personal pies with totals other than zero or 100 percent').count, 0);
});

test('the full checker rejects a reference targeting an umbrella root when scenes exist', async t => {
    const state = sceneState(); state.contexts.push(context(202, 20));
    const { db, connection } = integrityDatabase(t, state);
    db.exec('INSERT INTO personal_pies VALUES (1, 7, 100); INSERT INTO personal_pie_topic_weights VALUES (1, 202, 10000)');
    const report = await checkRankingIntegrity(connection);
    assert.deepEqual(checkNamed(report.checks, 'referenced contexts are not a concrete topic or scene').details, [202]);
});

test('legacy schemas retain dimension validation instead of silently adopting scenes', async t => {
    const state = sceneState();
    state.categories.pop(); state.contexts = [context(100, 10, { output: 'image' })]; state.scenes = [];
    const { connection } = integrityDatabase(t, state, { tables: [], migrated: false });
    const report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'ranking contexts with missing or unknown dimensions').count, 1);
    assert.equal(report.checks.some(check => check.name === 'scenes with mismatched context identity'), false);
});

test('legacy contexts still validate their configured option values', async t => {
    const state = sceneState();
    state.categories.pop(); state.contexts = [context(100, 10, { output: 'image' })]; state.scenes = [];
    const { db, connection } = integrityDatabase(t, state, { tables: [], migrated: false });
    db.exec(`
        INSERT INTO ranking_dimensions VALUES (1, 10, 'output', 1);
        INSERT INTO ranking_dimension_options VALUES (1, 'image');
    `);
    let report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'ranking contexts with missing or unknown dimensions').count, 0);
    assert.equal(checkNamed(report.checks, 'ranking contexts with unavailable option values').count, 0);
    db.exec("UPDATE ranking_dimension_options SET option_key = 'video'");
    report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'ranking contexts with unavailable option values').count, 1);
});

test('the new schema rejects active old selectors without rejecting unused canonical legacy contexts', async t => {
    const state = sceneState(); state.contexts.push(context(202, 20, { output: 'image' }));
    const { db, connection } = integrityDatabase(t, state);
    db.exec("INSERT INTO ranking_dimensions VALUES (1, 20, 'output', 1)");
    let report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'legacy context selectors remain active on current topics').count, 1);
    assert.equal(checkNamed(report.checks, 'ranking contexts with missing or unknown dimensions').count, 0);
    assert.equal(checkNamed(report.checks, 'referenced contexts are not a concrete topic or scene').count, 0);
    db.exec("UPDATE ranking_contexts SET context_hash = 'invalid' WHERE ID = 100");
    report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'ranking contexts with noncanonical hashes').count, 1);
});

test('explicit no-fallback is valid while missing non-null families still fail', async t => {
    const { db, connection } = integrityDatabase(t);
    db.exec('INSERT INTO personal_pie_score_rules VALUES (1, 1, NULL)');
    let report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'family associations referencing a different entrance').count, 0);
    db.exec('INSERT INTO personal_pie_score_rules VALUES (1, 2, 99)');
    report = await checkRankingIntegrity(connection);
    assert.equal(checkNamed(report.checks, 'family associations referencing a different entrance').count, 1);
});

test('CLI audit takes a single read-only repeatable-read snapshot and releases it', async t => {
    const { connection } = integrityDatabase(t);
    const boundaries = [];
    connection.query = async sql => { boundaries.push(sql); };
    connection.rollback = async () => { boundaries.push('ROLLBACK'); };
    await runRankingIntegrityAudit(connection);
    assert.deepEqual(boundaries, [
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
        'ROLLBACK'
    ]);
});

test('failed audits also release their read-only transaction and propagate the error', async () => {
    const failure = new Error('Database read failed'), boundaries = [];
    const connection = {
        async query(sql) { boundaries.push(sql); },
        async execute() { throw failure; },
        async rollback() { boundaries.push('ROLLBACK'); }
    };
    await assert.rejects(runRankingIntegrityAudit(connection), error => error === failure);
    assert.equal(boundaries.at(-1), 'ROLLBACK');
});
