import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import mysql from 'mysql2/promise';

const stage = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/topics-taxonomy-20261026\/topics-taxonomy-20261026-\d+$/.test(stage)) throw new Error('Unsafe taxonomy rehearsal stage');
if (process.env.BENCHPOLL_DB_USER !== 'root') throw new Error('Use the operational account for metadata rehearsal');
const source = 'benchmarks', target = 'benchpoll_taxonomy_rehearsal_' + stage.split('-').at(-1);
if (!/^benchpoll_taxonomy_rehearsal_\d+$/.test(target)) throw new Error('Unsafe rehearsal database');
const settings = { user: 'root', socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    password: process.env.DB_PASSWORD, supportBigNumbers: true, bigNumberStrings: true };
const db = await mysql.createConnection(settings);
const migration = await import(join(stage, 'candidate/scripts/migrate-topic-taxonomy-20261026.mjs'));
const { applyTopicTaxonomy, readTaxonomyState, taxonomyPreservation, topicTaxonomy, TOPIC_TAXONOMY_MIGRATION } = migration;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let created = false, copy;
const report = { verified: false, metadataOnly: true, scenarios: [], temporaryDatabaseRemoved: false };

try {
    const [[exists]] = await db.execute('SELECT COUNT(*) AS count FROM information_schema.schemata WHERE schema_name = ?', [target]);
    if (Number(exists.count)) throw new Error('Never overwrite an existing rehearsal database');
    await db.query('SET SESSION sql_log_bin = 0');
    const sourceConnection = await mysql.createConnection({ ...settings, database: source });
    const productionBefore = await readTaxonomyState(sourceConnection);
    const productionDigest = sha(productionBefore);
    await sourceConnection.end();
    const [protectedTables] = await db.query(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'benchmarks' AND (table_name IN ('users', 'user_public_profiles', 'personal_pies',
            'benchmark_families', 'benchmark_family_members', 'discussion_posts', 'discussion_mentions', 'discussion_votes')
            OR LEFT(table_name, 13) = 'personal_pie_') ORDER BY table_name`);
    const tables = [...new Set(['categories', 'ranking_dimensions', 'ranking_dimension_options', 'ranking_contexts',
        'topic_legacy_routes', 'schema_migrations', 'topic_migration_archive', ...protectedTables.map(row => row.name)])];
    if (tables.some(table => !/^[a-z_]+$/.test(table))) throw new Error('Unexpected metadata table');
    await db.query(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); created = true;
    for (const table of tables) await db.query(`CREATE TABLE \`${target}\`.\`${table}\` LIKE \`${source}\`.\`${table}\``);
    copy = await mysql.createConnection({ ...settings, database: target });
    await copy.query('SET SESSION sql_log_bin = 0');
    const columns = new Map();
    for (const table of tables) {
        const [rows] = await db.execute(`SELECT column_name AS name FROM information_schema.columns
            WHERE table_schema = ? AND table_name = ? AND EXTRA NOT LIKE '%VIRTUAL GENERATED%'
                AND EXTRA NOT LIKE '%STORED GENERATED%' ORDER BY ordinal_position`, [source, table]);
        columns.set(table, rows.map(row => '`' + row.name.replaceAll('`', '``') + '`').join(', '));
    }
    async function reset() {
        await copy.query('SET FOREIGN_KEY_CHECKS = 0');
        try {
            for (const table of tables) await copy.query(`DELETE FROM \`${table}\``);
            for (const table of tables) {
                const fields = columns.get(table);
                await copy.query(`INSERT INTO \`${table}\` (${fields}) SELECT ${fields} FROM \`${source}\`.\`${table}\``);
            }
        } finally { await copy.query('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await reset();
    // CREATE LIKE omits foreign keys; exercise the real context/identity boundaries explicitly.
    for (const [table, sql] of [
        ['categories', 'FOREIGN KEY (parent_ID) REFERENCES categories(ID), FOREIGN KEY (owner_user_ID) REFERENCES users(ID), FOREIGN KEY (created_by_user_ID) REFERENCES users(ID)'],
        ['ranking_contexts', 'FOREIGN KEY (category_ID) REFERENCES categories(ID)'],
        ['personal_pies', 'FOREIGN KEY (context_ID) REFERENCES ranking_contexts(ID), FOREIGN KEY (user_ID) REFERENCES users(ID)'],
        ['discussion_posts', 'FOREIGN KEY (category_ID) REFERENCES categories(ID), FOREIGN KEY (context_ID) REFERENCES ranking_contexts(ID), FOREIGN KEY (parent_ID) REFERENCES discussion_posts(ID), FOREIGN KEY (author_ID) REFERENCES users(ID)'],
        ['topic_legacy_routes', 'FOREIGN KEY (category_ID) REFERENCES categories(ID)']
    ]) await copy.query(`ALTER TABLE ${table} ADD ${sql.replaceAll(', FOREIGN KEY', ', ADD FOREIGN KEY')}`);

    const before = await taxonomyPreservation(copy);
    const applied = await applyTopicTaxonomy(copy);
    assert.equal(applied.officialTopics, 30); assert.equal(applied.pies, 11); assert.equal(applied.discussions, 9);
    assert.equal(applied.preservedPies.length, 0); assert.deepEqual(applied.deletedContexts, [1087]);
    assert.deepEqual(await taxonomyPreservation(copy), before);
    const after = await readTaxonomyState(copy);
    assert.equal(Number(after.contexts.find(row => Number(row.ID) === 1094).category_ID), 167);
    assert.equal(Number(after.contexts.find(row => Number(row.ID) === 1093).category_ID), 231);
    assert.equal(after.posts.filter(row => Number(row.context_ID) === 1088).length, 5);
    const [aliasRows] = await copy.query('SELECT route_key, category_ID FROM topic_legacy_routes ORDER BY route_key');
    const firstDigest = sha({ state: after, aliases: aliasRows });
    assert.equal((await applyTopicTaxonomy(copy)).applied, false);
    const [secondAliases] = await copy.query('SELECT route_key, category_ID FROM topic_legacy_routes ORDER BY route_key');
    assert.equal(sha({ state: await readTaxonomyState(copy), aliases: secondAliases }), firstDigest);
    report.scenarios.push('actual metadata migration', 'idempotent second apply', 'context foreign keys and retained discussions');
    report.result = applied;

    await copy.execute('DELETE FROM topic_legacy_routes WHERE route_key = ?', ['software']);
    await assert.rejects(applyTopicTaxonomy(copy), /route ownership/);
    report.scenarios.push('marked rerun rejects missing route ownership');

    await reset();
    await copy.query('CREATE TABLE unexpected_context_reference (context_ID BIGINT UNSIGNED, FOREIGN KEY (context_ID) REFERENCES ranking_contexts(ID) ON DELETE CASCADE)');
    await assert.rejects(applyTopicTaxonomy(copy), /Unreviewed/);
    await copy.query('DROP TABLE unexpected_context_reference');
    report.scenarios.push('unreviewed cascading reference rejected');

    await reset();
    const [[owner]] = await copy.query('SELECT user_ID AS ID FROM personal_pies WHERE context_ID = 1088');
    const [[originalPie]] = await copy.query('SELECT * FROM personal_pies WHERE context_ID = 1088');
    const [extraPie] = await copy.execute(`INSERT INTO personal_pies (user_ID, context_ID, revision, created_at, updated_at)
        VALUES (?, 1087, ?, ?, ?)`, [owner.ID, originalPie.revision, originalPie.created_at, originalPie.updated_at]);
    await copy.execute(`INSERT INTO personal_pie_weights (pie_ID, benchmark_condition_ID, weight_basis_points, created_at, updated_at)
        SELECT ?, benchmark_condition_ID, weight_basis_points, created_at, updated_at FROM personal_pie_weights WHERE pie_ID = ?`, [extraPie.insertId, originalPie.ID]);
    await copy.execute('INSERT INTO categories (ID, name, slug, owner_user_ID, created_by_user_ID) VALUES (900001, ?, ?, ?, ?)',
        ['Coding', 'coding', owner.ID, owner.ID]);
    await copy.execute(`INSERT INTO ranking_contexts (ID, category_ID, context_values, context_hash) VALUES (900001, 900001, '{}', ?)`,
        [createHash('sha256').update('{}').digest('hex')]);
    await copy.execute('INSERT INTO categories (ID, name, slug, created_by_user_ID) VALUES (900002, ?, ?, ?)', ['Custom research', 'custom-research', owner.ID]);
    const privateBefore = (await copy.query('SELECT * FROM categories WHERE ID IN (900001,900002) ORDER BY ID'))[0];
    const collisionBefore = await taxonomyPreservation(copy);
    const collision = await applyTopicTaxonomy(copy);
    assert.equal(collision.preservedPies.length, 1); assert.equal(collision.pies, 12);
    assert.deepEqual(await taxonomyPreservation(copy), collisionBefore);
    assert.deepEqual((await copy.query('SELECT * FROM categories WHERE ID IN (900001,900002) ORDER BY ID'))[0], privateBefore);
    const [[preserved]] = await copy.execute(`SELECT c.owner_user_ID, p.ID FROM personal_pies p JOIN ranking_contexts rc ON rc.ID = p.context_ID
        JOIN categories c ON c.ID = rc.category_ID WHERE p.ID = ?`, [extraPie.insertId]);
    assert.equal(String(preserved.owner_user_ID), String(owner.ID));
    report.scenarios.push('conflicting Pie preserved privately', 'private same-name URL isolation', 'user-created public topic untouched');

    await reset();
    const rollbackState = await readTaxonomyState(copy), rollbackData = await taxonomyPreservation(copy);
    const failing = new Proxy(copy, { get(targetConnection, property) {
        if (property === 'execute') return async (sql, args) => {
            if (sql.startsWith('INSERT INTO schema_migrations')) throw new Error('Injected final marker failure');
            return targetConnection.execute(sql, args);
        };
        const value = Reflect.get(targetConnection, property);
        return typeof value === 'function' ? value.bind(targetConnection) : value;
    } });
    await assert.rejects(applyTopicTaxonomy(failing), /Injected final marker failure/);
    assert.deepEqual(await readTaxonomyState(copy), rollbackState);
    assert.deepEqual(await taxonomyPreservation(copy), rollbackData);
    const [markers] = await copy.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [TOPIC_TAXONOMY_MIGRATION]);
    const [archive] = await copy.execute('SELECT migration_id FROM topic_migration_archive WHERE migration_id = ?', [TOPIC_TAXONOMY_MIGRATION]);
    assert.equal(markers.length, 0); assert.equal(archive.length, 0);
    report.scenarios.push('late write failure fully rolls back');

    await reset();
    await copy.execute('INSERT INTO categories (ID, name, slug, created_by_user_ID) VALUES (900003, ?, ?, ?)', ['Coding', 'coding', owner.ID]);
    const foreignBefore = await readTaxonomyState(copy);
    await assert.rejects(applyTopicTaxonomy(copy), /another topic/);
    assert.deepEqual(await readTaxonomyState(copy), foreignBefore);
    report.scenarios.push('foreign public URL conflict rejected');

    await reset();
    await copy.execute('INSERT INTO topic_legacy_routes (route_hash, route_key, category_ID) VALUES (UNHEX(?), ?, 54)',
        [createHash('sha256').update('coding').digest('hex'), 'coding']);
    const aliasBefore = await readTaxonomyState(copy);
    await assert.rejects(applyTopicTaxonomy(copy), /retained link/);
    assert.deepEqual(await readTaxonomyState(copy), aliasBefore);
    report.scenarios.push('foreign retained-link conflict rejected');

    const checkProduction = await mysql.createConnection({ ...settings, database: source });
    try { assert.equal(sha(await readTaxonomyState(checkProduction)), productionDigest); }
    finally { await checkProduction.end(); }
    report.sourceMetadataUnchanged = true; report.scoreTablesNotCloned = true;
    report.foreignKeysExercised = true; report.expectedDimensions = topicTaxonomy.dimensions;
    report.verified = true;
} catch (error) { report.failure = error.stack; throw error; }
finally {
    if (copy) await copy.end();
    if (created) { await db.query(`DROP DATABASE \`${target}\``); report.temporaryDatabaseRemoved = true; }
    await db.end();
    await writeFile(join(stage, 'taxonomy-rehearsal.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ ...report, expectedDimensions: undefined }));
