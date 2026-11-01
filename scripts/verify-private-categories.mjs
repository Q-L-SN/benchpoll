#!/usr/bin/env node
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { getPrivateCategory, insertPrivateCategory, retirePublicCategory } from '../private-category-service.js';
import { resolveRankingContext, loadPublicPie } from '../ranking-service.js';
import { getCategoryNavigation } from '../navigation-service.js';

const db = await mysql.createConnection({ socketPath: process.env.DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: 'root', database: 'benchmarks', supportBigNumbers: true, bigNumberStrings: true });
const owner = '81000220261002', other = '81000320261002';
try {
    await db.beginTransaction();
    for (const ID of [owner, other]) await db.execute(`INSERT INTO users
        (ID, name, profile_picture_URL, followers_count) VALUES (?, 'Private category test', '/assets/favicon-32x32.png', 0)`, [ID]);
    const privateLocation = await insertPrivateCategory(db, owner, 'Integration test private');
    const entry = await getPrivateCategory(db, owner, privateLocation.categoryID);
    assert.equal(entry.isPrivate, true);
    for (const userID of [null, other]) {
        await assert.rejects(resolveRankingContext(db, { categoryID: privateLocation.categoryID, userID }), e => e.status === 404);
        await assert.rejects(getPrivateCategory(db, userID, privateLocation.categoryID), e => [401, 404].includes(e.status));
    }
    const context = await resolveRankingContext(db, { categoryID: privateLocation.categoryID, userID: owner });
    assert.deepEqual(context.dimensions, []);
    assert.deepEqual((await loadPublicPie(db, context, new Map())).entries, []);
    assert.equal((await getCategoryNavigation(db)).items.some(item => item.categoryID === privateLocation.categoryID), false);
    const [category] = await db.execute("INSERT INTO categories (parent_ID,name,position) VALUES (NULL,'Retirement integration test',999)");
    const [source] = await db.execute(`INSERT INTO ranking_contexts (category_ID,context_values,context_hash)
        VALUES (?, '{}', SHA2('{}',256))`, [category.insertId]);
    const [pie] = await db.execute(`INSERT INTO personal_pies (user_ID,context_ID,revision,created_at,updated_at)
        VALUES (?,?,7,'2026-09-01 00:00:00','2026-09-02 00:00:00')`, [owner, source.insertId]);
    const [conditions] = await db.query('SELECT ID FROM benchmark_conditions WHERE deleted_at IS NULL ORDER BY ID LIMIT 2');
    for (const row of conditions) await db.execute(`INSERT INTO personal_pie_weights
        (pie_ID,benchmark_condition_ID,weight_basis_points) VALUES (?,?,5000)`, [pie.insertId, row.ID]);
    await db.execute(`INSERT INTO personal_pie_score_rules (pie_ID,primary_benchmark_condition_ID,mode)
        VALUES (?,?,'fallback_if_missing')`, [pie.insertId, conditions[0].ID]);
    await db.execute(`INSERT INTO personal_pie_score_rule_components
        (pie_ID,primary_benchmark_condition_ID,fallback_benchmark_condition_ID,weight_basis_points) VALUES (?,?,?,6000)`,
    [pie.insertId, conditions[0].ID, conditions[1].ID]);
    const [[before]] = await db.execute('SELECT * FROM personal_pies WHERE ID=?', [pie.insertId]);
    const [weightsBefore] = await db.execute('SELECT * FROM personal_pie_weights WHERE pie_ID=? ORDER BY benchmark_condition_ID', [pie.insertId]);
    const [fallbackBefore] = await db.execute('SELECT * FROM personal_pie_score_rule_components WHERE pie_ID=?', [pie.insertId]);
    const moved = await retirePublicCategory(db, category.insertId);
    assert.equal(moved.length, 1);
    assert.equal(moved[0].pieID, Number(pie.insertId));
    const [[after]] = await db.execute('SELECT * FROM personal_pies WHERE ID=?', [pie.insertId]);
    assert.deepEqual({ ...after, context_ID: before.context_ID }, before);
    assert.deepEqual((await db.execute('SELECT * FROM personal_pie_weights WHERE pie_ID=? ORDER BY benchmark_condition_ID', [pie.insertId]))[0], weightsBefore);
    assert.deepEqual((await db.execute('SELECT * FROM personal_pie_score_rule_components WHERE pie_ID=?', [pie.insertId]))[0], fallbackBefore);
    assert.equal((await getPrivateCategory(db, owner, moved[0].categoryID)).isPrivate, true);
    assert.equal((await getCategoryNavigation(db)).items.some(item => item.categoryID === Number(category.insertId)), false);
    await db.rollback();
    console.log('PASS private ownership, no public aggregation/navigation, category retirement preserves Pie ID, revision, timestamps, weights and fallback. All fixtures rolled back.');
} catch (error) { await db.rollback(); throw error; }
finally { await db.end(); }
