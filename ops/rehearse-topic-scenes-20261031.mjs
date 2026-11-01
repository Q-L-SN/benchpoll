import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createHash, randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { migrateTopicScenes, verifyTopicScenesMigration } from '../scripts/migrate-topic-scenes-20261031.mjs';
import { migrateTopicScenesTaxonomy, verifyTopicScenesTaxonomy } from '../scripts/migrate-topic-scenes-taxonomy-20261031.mjs';
import { createTopic, getTopic, listTopics } from '../topic-service.js';
import { createPrivateTopicScene, setPrivateTopicDefaultScene } from '../topic-scenes-service.js';
import { loadTopicReferenceTargets } from '../topic-reference-service.js';
import { getRankingWorkspace, savePersonalPie } from '../ranking-service.js';

const source = 'benchmarks', database = `benchpoll_scenes_rehearsal_${Date.now()}`;
const admin = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: source });
const copied = new Set(['schema_migrations', 'topic_migration_archive', 'topic_legacy_routes', 'users', 'user_public_profiles',
    'categories', 'ranking_contexts', 'ranking_dimensions', 'ranking_dimension_options', 'personal_pies', 'personal_pie_weights',
    'personal_pie_score_rules', 'benchmark_families', 'benchmark_family_members', 'benchmarks', 'benchmark_conditions',
    'benchmark_results', 'models', 'organizations', 'score_fields', 'score_field_options', 'ranking_cache_revisions',
    'topic_proposals', 'topic_proposal_votes', 'discussion_posts', 'discussion_mentions', 'discussion_votes']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceFingerprint = async () => {
    const records = [];
    for (const table of ['categories', 'ranking_contexts', 'personal_pies', 'personal_pie_weights', 'topic_proposals']) {
        const [rows] = await admin.query(`SELECT * FROM \`${source}\`.\`${table}\``);
        records.push([table, rows]);
    }
    return hash(records);
};
let created = false, pool, phase = 'clone';
try {
    await admin.query('SET SESSION sql_log_bin = 0');
    const [[logging]] = await admin.query('SELECT @@SESSION.sql_log_bin AS enabled, @@datadir AS directory');
    assert.equal(Number(logging.enabled), 0, 'Isolated rehearsal must not enter production binary logs');
    const [[size]] = await admin.query(`SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [source]);
    const sourceBytes = Number(size.bytes), space = await statfs(logging.directory);
    assert.ok(space.bavail * space.bsize >= sourceBytes * 2 + 2 ** 31,
        'Insufficient free space for an isolated database rehearsal and recovery reserve');
    const original = await sourceFingerprint();
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    await admin.query(`USE \`${database}\``);
    await admin.query('SET FOREIGN_KEY_CHECKS=0');
    const [tables] = await admin.query(`SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'`, [source]);
    for (const { TABLE_NAME: table } of tables) {
        assert.match(table, /^[a-zA-Z0-9_]+$/);
        const [[definition]] = await admin.query(`SHOW CREATE TABLE \`${source}\`.\`${table}\``);
        await admin.query(definition['Create Table']);
        if (!copied.has(table)) continue;
        const [columns] = await admin.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND GENERATION_EXPRESSION='' ORDER BY ORDINAL_POSITION`, [source, table]);
        const names = columns.map(column => `\`${column.COLUMN_NAME}\``).join(',');
        await admin.query(`INSERT INTO \`${database}\`.\`${table}\` (${names}) SELECT ${names} FROM \`${source}\`.\`${table}\``);
    }
    await admin.query('SET FOREIGN_KEY_CHECKS=1');
    phase = 'migration';
    const migration = await migrateTopicScenes(admin);
    assert.equal(migration.applied, true);
    assert.equal((await migrateTopicScenes(admin)).applied, false);
    assert.equal((await verifyTopicScenesMigration(admin)).verified, true);
    phase = 'taxonomy';
    const taxonomy = await migrateTopicScenesTaxonomy(admin, { rehearsal: true });
    assert.equal(taxonomy.applied, true);
    assert.equal(taxonomy.officialTopics, 32);
    assert.equal(taxonomy.activeScenes, 209);
    assert.equal((await migrateTopicScenesTaxonomy(admin, { rehearsal: true })).applied, false);
    assert.equal((await verifyTopicScenesTaxonomy(admin)).verified, true);
    pool = mysql.createPool({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database,
        connectionLimit: 5, supportBigNumbers: true, bigNumberStrings: true });
    pool.on('connection', connection => {
        connection.query('SET SESSION sql_log_bin = 0', error => { if (error) connection.destroy(); });
    });
    const [[poolLogging]] = await pool.query('SELECT @@SESSION.sql_log_bin AS enabled');
    assert.equal(Number(poolLogging.enabled), 0);
    phase = 'actor';
    const [[user]] = await pool.query('SELECT ID FROM users WHERE ID > 0 AND deleted_at IS NULL AND banned_at IS NULL ORDER BY ID LIMIT 1');
    assert.ok(user, 'Rehearsal requires an active actor');
    const userID = String(user.ID);
    const make = name => createTopic(pool, userID, { name, description: 'An isolated reference migration test.', isPrivate: true });
    const save = (topic, contextValues, entries, expectedRevision = 0) => savePersonalPie(pool, {
        userID, categoryID: topic.ID, contextValues, entries, expectedRevision, fallbackRules: [], writeIdentity: randomUUID()
    });
    const [weighted] = await pool.query(`SELECT DISTINCT w.benchmark_condition_ID AS ID FROM personal_pie_weights w
        JOIN personal_pies p ON p.ID=w.pie_ID JOIN ranking_contexts rc ON rc.ID=p.context_ID
        WHERE rc.category_ID=180 ORDER BY w.benchmark_condition_ID LIMIT 2`);
    assert.equal(weighted.length, 2);
    const first = Number(weighted[0].ID), second = Number(weighted[1].ID);
    phase = 'create-private-topics';
    const target = await make('Rehearsal target'), sourceTopic = await make('Rehearsal index');
    phase = 'save-reference';
    await save(target, {}, [{ conditionID: first, weightBasisPoints: 10000 }]);
    const targetID = (await loadTopicReferenceTargets(pool, userID)).find(item => item.categoryID === target.ID).contextID;
    await save(sourceTopic, {}, [{ conditionID: -targetID, weightBasisPoints: 10000 }]);
    let workspace = await getRankingWorkspace(pool, { categoryID: sourceTopic.ID, userID });
    assert.deepEqual(workspace.personalPie.effectiveEntries.map(item => item.conditionID), [first]);
    assert.deepEqual(workspace.personalPie.referenceIssues, []);
    phase = 'default-scene-change';
    const added = await createPrivateTopicScene(pool, userID, { categoryID: target.ID,
        name: 'Alternative', description: 'An alternative evaluation scenario.' }, randomUUID());
    assert.equal(added.scenes[0].ID, targetID, 'Root identity becomes General without retargeting references');
    await setPrivateTopicDefaultScene(pool, userID, { categoryID: target.ID, sceneID: added.sceneID }, randomUUID());
    const updated = await getTopic(pool, userID, target.ID);
    assert.equal(updated.scenes[0].ID, added.sceneID);
    workspace = await getRankingWorkspace(pool, { categoryID: sourceTopic.ID, userID });
    assert.deepEqual(workspace.personalPie.effectiveEntries.map(item => item.conditionID), [first]);
    await save(target, { scene: String(targetID) }, [{ conditionID: second, weightBasisPoints: 10000 }], 1);
    workspace = await getRankingWorkspace(pool, { categoryID: sourceTopic.ID, userID });
    assert.deepEqual(workspace.personalPie.effectiveEntries.map(item => item.conditionID), [second]);
    const sceneSearch = await listTopics(pool, userID, { query: 'Alternative' });
    assert.ok(sceneSearch.topics.some(item => item.ID === target.ID));
    await assert.rejects(save(target, { scene: String(targetID) }, [{ conditionID: -sourceTopic.rootContextID, weightBasisPoints: 10000 }], 2),
        error => error.body?.error === 'topic_reference_cycle');
    await assert.rejects(save({ ID: 54 }, {}, [{ conditionID: -targetID, weightBasisPoints: 10000 }], 0),
        error => error.body?.error === 'private_topic_reference_not_public');
    await assert.rejects(getRankingWorkspace(pool, { categoryID: target.ID, userID: null }),
        error => error.status === 404);
    phase = 'concurrent-cycle';
    const a = await make('Concurrent scene index A'), b = await make('Concurrent scene index B');
    const attempts = await Promise.allSettled([
        save(a, {}, [{ conditionID: -b.rootContextID, weightBasisPoints: 10000 }]),
        save(b, {}, [{ conditionID: -a.rootContextID, weightBasisPoints: 10000 }])
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.body?.error, 'topic_reference_cycle');
    const winner = attempts[0].status === 'fulfilled' ? a : b;
    workspace = await getRankingWorkspace(pool, { categoryID: winner.ID, userID });
    assert.equal(workspace.personalPie.referenceIssues[0].reason, 'empty');
    assert.equal(workspace.personalPie.effectiveEntries[0].weightBasisPoints, 10000);
    assert.equal(await sourceFingerprint(), original, 'Production metadata/weights must be unchanged');
    console.log(JSON.stringify({ database, sourceBytes, migration, taxonomy, preservedReferencesAfterDefaultChange: true,
        dynamicRecalculation: true, scenesSearchable: true, privateScopeEnforced: true,
        concurrentCyclesRejected: true, missingReferenceWeightPreserved: true, sourceUnchanged: true }));
} catch (error) {
    console.error(JSON.stringify({ phase, code: error.code, message: error.message, status: error.status, error: error.body?.error }));
    throw error;
} finally {
    if (pool) await pool.end();
    await admin.query(`USE \`${source}\``);
    if (created && /^benchpoll_scenes_rehearsal_\d+$/.test(database)) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
}
