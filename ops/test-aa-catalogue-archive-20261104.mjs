import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { loadInventory, inventoryDigest, applyArchive, restoreArchive } from './archive-aa-catalogue-20261104.mjs';

const appRoot = '/home/ubuntu/benchpoll';
const require = createRequire(appRoot + '/package.json');
const db = await require('mysql2/promise').createConnection({ user: 'root', socketPath: '/var/run/mysqld/mysqld.sock', dateStrings: true, timezone: 'Z' });
const database = 'benchpoll_lifecycle_test_' + randomBytes(16).toString('hex');
const tables = ['benchmarks', 'benchmark_conditions', 'benchmark_results', 'score_fields', 'score_field_options',
    'aa_data_archive_runs', 'aa_data_archive_items', 'ranking_cache_revisions', 'personal_pies', 'personal_pie_weights',
    'personal_pie_topic_weights', 'personal_pie_score_rules', 'benchmark_families', 'benchmark_family_members',
    'discussion_posts', 'discussion_mentions', 'discussion_votes', 'topic_proposals', 'topic_proposal_votes',
    'topic_proposal_snapshots', 'moderation_email_outbox', 'arena_import_rows'];
try {
    if (!/^benchpoll_lifecycle_test_[a-f0-9]{32}$/.test(database)) throw new Error('Unsafe fixture name');
    await db.query(`CREATE DATABASE ${database}`);
    await db.query(`USE ${database}`);
    for (const table of tables) await db.query(`CREATE TABLE ${table} LIKE benchmarks.${table}`);
    await db.query('INSERT INTO ranking_cache_revisions (ID, epoch) VALUES (1, UUID()),(2, UUID())');
    await db.query("INSERT INTO benchmarks (ID,name) VALUES (1,'AA synthetic'),(2,'Independent empty'),(3,'Mixed synthetic'),(4,'Independent shared'),(5,'Unknown derived'),(6,'AA no versions')");
    await db.query(`INSERT INTO benchmark_conditions (ID,benchmark_ID,condition_key,name,score_direction,uses_percentage_scale,is_primary,is_default,score_source) VALUES
        (1,1,'default','default','higher',1,1,1,NULL),
        (2,2,'default','default','higher',1,1,1,'aa'),
        (3,3,'aa-variant','AA run','higher',1,1,0,NULL),
        (4,3,'standard','Standard','higher',1,0,0,NULL),
        (5,4,'default','default','higher',1,1,1,NULL),
        (6,5,'default','default','higher',1,1,1,NULL)`);
    await db.query(`INSERT INTO benchmark_results (ID,model_ID,benchmark_ID,benchmark_condition_ID,raw_score,source_url,source_type,benchmark_condition_snapshot,score_fields,notes) VALUES
        (1,1,1,1,90,'https://example.org','paper','{}','[]',NULL),
        (2,1,2,2,12,'https://artificialanalysis.ai/evaluations/test','third_party_lab','{}','[]',NULL),
        (3,1,3,3,50,'https://example.org','paper','{}','[]',NULL),
        (4,1,3,4,60,'https://example.org','paper','{}','[]',NULL),
        (5,1,4,5,30,'https://artificialanalysis.ai/evaluations/test','third_party_lab','{}','[]',NULL),
        (6,2,4,5,25,'https://example.org','paper','{}','[]',NULL),
        (7,1,5,6,70,'https://example.org','paper','{}','[]','tps sourced from Artificial Analysis')`);
    await db.query('INSERT INTO personal_pies (ID,user_ID,context_ID) VALUES (1,1,1)');
    await db.query('INSERT INTO personal_pie_weights (pie_ID,benchmark_condition_ID,weight_basis_points) VALUES (1,3,10000)');
    const initial = await loadInventory(db, appRoot);
    const digest = inventoryDigest(initial);
    assert.equal(initial.targetBenchmarks.length, 2);
    assert.equal(initial.targetVersions.length, 3);
    assert.deepEqual(initial.needDefault.map(row => row.ID), [2]);
    assert.deepEqual(initial.primaryChanges, [4]);
    assert.equal(initial.results.length, 4);
    await assert.rejects(applyArchive(db, { appRoot, expectedDigest: 'changed', backupPath: 'fixture' }), /candidates changed/);
    assert.equal(inventoryDigest(await loadInventory(db, appRoot)), digest);
    await db.query(`INSERT INTO arena_import_rows (row_key,result_ID,source_hash,source_revision,config,category,model_key,source_date)
        VALUES (REPEAT('a',64),1,REPEAT('b',64),REPEAT('c',40),'fixture','fixture','fixture','2026-11-04')`);
    await assert.rejects(applyArchive(db, { appRoot, expectedDigest: digest, backupPath: 'fixture' }), /tracked Arena imports/);
    await db.query('DELETE FROM arena_import_rows');
    await assert.rejects(applyArchive(db, { appRoot, expectedDigest: digest, backupPath: 'fixture', beforeCommit() { throw new Error('forced failure'); } }), /forced failure/);
    assert.equal(inventoryDigest(await loadInventory(db, appRoot)), digest);
    const receipt = await applyArchive(db, { appRoot, expectedDigest: digest, backupPath: 'fixture' });
    assert.equal(receipt.createdDefaults.length, 1);
    assert.equal(receipt.createdDefaults[0].key, 'default-independent-20261104');
    assert.equal(receipt.archivedResultCount, 4);
    const after = await loadInventory(db, appRoot);
    assert.equal(after.targetVersions.length, 0);
    assert.equal(after.results.length, 0);
    const [[independent]] = await db.query('SELECT status FROM benchmark_results WHERE ID=6');
    const [[derived]] = await db.query('SELECT status FROM benchmark_results WHERE ID=7');
    assert.equal(independent.status, 'accepted');
    assert.equal(derived.status, 'accepted');
    await assert.rejects(applyArchive(db, { appRoot, expectedDigest: digest, backupPath: 'fixture' }), /already ran/);
    await db.query('UPDATE benchmarks SET name=\'changed after archive\' WHERE ID=1');
    await assert.rejects(restoreArchive(db, receipt.archiveStateDigest), /state changed/);
    await db.query("UPDATE benchmarks SET name='AA synthetic', updated_at=(SELECT JSON_UNQUOTE(JSON_EXTRACT(original_state, '$.updated_at')) FROM aa_data_archive_items WHERE batch_id='aa-catalogue-archive-20261104' AND entity_type='benchmark' AND object_id=1) WHERE ID=1");
    // The original timestamp differs from the archived timestamp; use the committed snapshot for the guard.
    await db.query('UPDATE benchmarks SET updated_at=? WHERE ID=1', [after.benchmarks.find(row => Number(row.ID) === 1).updated_at]);
    await restoreArchive(db, receipt.archiveStateDigest);
    assert.equal(inventoryDigest(await loadInventory(db, appRoot)), digest);
    console.log(JSON.stringify({ passed: true, checks: ['classification', 'default-key-collision', 'primary-replacement', 'score-preservation', 'pie-removal', 'drift-refusal', 'arena-sync-guard', 'transaction-rollback', 'duplicate-refusal', 'guarded-restoration'] }));
} finally {
    if (/^benchpoll_lifecycle_test_[a-f0-9]{32}$/.test(database)) await db.query(`DROP DATABASE IF EXISTS ${database}`);
    await db.end();
}
