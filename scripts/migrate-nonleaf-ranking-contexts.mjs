#!/usr/bin/env node

import crypto from 'node:crypto';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '009_nonleaf_ranking_context_integrity';
const LOCK_NAME = 'benchpoll_nonleaf_ranking_context_migration';
const EMPTY_TEMPLATE_VALUES = JSON.stringify({});
const EMPTY_TEMPLATE_HASH = crypto
    .createHash('sha256')
    .update(EMPTY_TEMPLATE_VALUES)
    .digest('hex');

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are unavailable.');
    return {
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        charset: 'utf8mb4'
    };
}

function parseTemplateValues(value, contextID) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(`Ranking context ${contextID} has invalid template values.`);
    }
    return parsed;
}

async function loadNonleafContexts(connection, lockRows = false) {
    const [rows] = await connection.query(`
        SELECT ranking_contexts.ID, ranking_contexts.category_ID,
               ranking_contexts.template_values
        FROM ranking_contexts
        WHERE EXISTS (
            SELECT 1
            FROM categories AS child
            WHERE child.parent_ID = ranking_contexts.category_ID
        )
        ORDER BY ranking_contexts.category_ID, ranking_contexts.ID${lockRows ? ' FOR UPDATE' : ''}`);
    return rows.map(row => ({
        ID: Number(row.ID),
        categoryID: Number(row.category_ID),
        templateValues: parseTemplateValues(row.template_values, Number(row.ID))
    }));
}

async function verifyPostconditions(connection) {
    const contexts = await loadNonleafContexts(connection);
    const invalid = contexts.filter(context => Object.keys(context.templateValues).length > 0);
    if (invalid.length > 0) {
        throw new Error(`${invalid.length} non-leaf ranking contexts still contain template dimensions.`);
    }
}

async function ensureEmptyContext(connection, categoryID, contexts) {
    const existing = contexts.find(context => Object.keys(context.templateValues).length === 0);
    if (existing) return existing.ID;
    const [result] = await connection.execute(`
        INSERT INTO ranking_contexts (category_ID, template_values, template_hash)
        VALUES (?, ?, ?)`, [categoryID, EMPTY_TEMPLATE_VALUES, EMPTY_TEMPLATE_HASH]);
    return Number(result.insertId);
}

async function movePersonalPies(connection, sourceContextID, targetContextID) {
    const [pies] = await connection.execute(`
        SELECT ID, user_ID
        FROM personal_pies
        WHERE context_ID = ?
        FOR UPDATE`, [sourceContextID]);
    for (const pie of pies) {
        const [targetPies] = await connection.execute(`
            SELECT ID
            FROM personal_pies
            WHERE user_ID = ? AND context_ID = ?
            FOR UPDATE`, [pie.user_ID, targetContextID]);
        if (targetPies.length > 0) {
            throw new Error(
                `User ${pie.user_ID} has personal pies in both contexts ${sourceContextID} and ${targetContextID}; manual resolution is required.`
            );
        }
        await connection.execute(
            'UPDATE personal_pies SET context_ID = ? WHERE ID = ?',
            [targetContextID, pie.ID]
        );
    }
    return pies.length;
}

async function applyMigration(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id VARCHAR(128) NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (migration_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [existing] = await connection.execute(
        'SELECT applied_at FROM schema_migrations WHERE migration_id = ?',
        [MIGRATION_ID]
    );
    if (existing.length > 0) {
        await verifyPostconditions(connection);
        return { applied: false, verified: true, alreadyAppliedAt: existing[0].applied_at };
    }

    await connection.beginTransaction();
    try {
        const contexts = await loadNonleafContexts(connection, true);
        const contextsByCategoryID = new Map();
        for (const context of contexts) {
            if (!contextsByCategoryID.has(context.categoryID)) {
                contextsByCategoryID.set(context.categoryID, []);
            }
            contextsByCategoryID.get(context.categoryID).push(context);
        }

        let contextsRemoved = 0;
        let piesMoved = 0;
        for (const [categoryID, categoryContexts] of contextsByCategoryID) {
            const invalidContexts = categoryContexts.filter(
                context => Object.keys(context.templateValues).length > 0
            );
            if (invalidContexts.length === 0) continue;
            const targetContextID = await ensureEmptyContext(connection, categoryID, categoryContexts);
            for (const sourceContext of invalidContexts) {
                const [[resultCount]] = await connection.execute(`
                    SELECT COUNT(*) AS count
                    FROM evaluation_results
                    WHERE ranking_context_ID = ?`, [sourceContext.ID]);
                if (Number(resultCount.count) > 0) {
                    throw new Error(
                        `Ranking context ${sourceContext.ID} has evaluation results; manual context migration is required.`
                    );
                }
                piesMoved += await movePersonalPies(connection, sourceContext.ID, targetContextID);
                await connection.execute('DELETE FROM ranking_contexts WHERE ID = ?', [sourceContext.ID]);
                contextsRemoved += 1;
            }
        }

        await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
        await verifyPostconditions(connection);
        await connection.commit();
        return { applied: true, contextsRemoved, piesMoved };
    } catch (error) {
        await connection.rollback();
        throw error;
    }
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        changes: [
            'collapse non-leaf ranking contexts to the only valid empty template context',
            'move non-conflicting personal pies to that context'
        ],
        behavior: 'fails when results or conflicting personal pies require a human decision'
    }, null, 2));
    process.exit(0);
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 20) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire the database migration lock.');
    try {
        console.log(JSON.stringify({ migration: MIGRATION_ID, ...await applyMigration(connection) }, null, 2));
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
} finally {
    await connection.end();
}
