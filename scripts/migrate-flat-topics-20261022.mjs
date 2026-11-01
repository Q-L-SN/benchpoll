import 'dotenv/config';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { topicSlug, FEATURED_TOPIC_ID } from '../public/js/shared/topics.js';
import { legacyTopicRouteKey } from '../topic-service.js';
import { canonicalizeContextValues, decorateDimensions, selectScopedDimensions, serializeRankingContextValues } from '../ranking-service.js';

export const FLAT_TOPICS_MIGRATION = 'flat_topics_home_20261022';
const names = new Map([[172, 'Image Generation'], [173, 'Video Generation'], [190, 'Audio Generation'],
    [211, 'Image Understanding'], [212, 'Video Understanding'], [213, 'Audio Understanding']]);

export function flatTopicsPlan(categories, dimensions, options) {
    const byID = new Map(categories.map(row => [Number(row.ID), row]));
    const parents = new Set(categories.filter(row => row.is_active).map(row => Number(row.parent_ID)));
    const aliases = new Map();
    const plan = categories.map(row => {
        const ID = Number(row.ID), lineage = [], seen = new Set();
        let cursor = row;
        while (cursor) {
            if (seen.has(Number(cursor.ID))) throw new Error('Cannot migrate a cyclic topic hierarchy');
            seen.add(Number(cursor.ID)); lineage.unshift(cursor);
            if (cursor.parent_ID == null) break;
            cursor = byID.get(Number(cursor.parent_ID));
            if (!cursor) throw new Error('Cannot migrate a missing topic ancestor');
        }
        const name = row.owner_user_ID == null ? names.get(ID) ?? row.name : row.name;
        let alias = null;
        if (row.owner_user_ID == null && row.is_active) {
            alias = legacyTopicRouteKey(lineage.map(part => encodeURIComponent(part.name)).join('/'));
            if (aliases.has(alias) && aliases.get(alias) !== ID) throw new Error('Ambiguous old topic path');
            aliases.set(alias, ID);
        }
        const scopes = [0, ...lineage.map(part => Number(part.ID))];
        const chosen = new Map();
        if (row.owner_user_ID == null && row.is_active && !parents.has(ID)) {
            for (const scope of scopes) for (const dimension of dimensions) {
                if (dimension.is_active && Number(dimension.scope_category_ID) === scope) {
                    chosen.set(dimension.dimension_key, dimension);
                }
            }
        }
        return { ID, name, slug: topicSlug(name), alias, isPrivate: row.owner_user_ID != null,
            dimensions: [...chosen.values()].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0) || Number(a.ID) - Number(b.ID))
                .map((dimension, index) => ({ ...dimension, position: index * 10,
                options: options.filter(option => Number(option.dimension_ID) === Number(dimension.ID)) })) };
    });
    if (!plan.some(topic => topic.ID === FEATURED_TOPIC_ID && !topic.isPrivate)) throw new Error('Featured topic ID is missing');
    return plan;
}

async function hasColumn(db, table, column) {
    const [[row]] = await db.execute(`SELECT COUNT(*) AS count FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
    return Number(row.count) > 0;
}

export async function ensureFlatTopicSchema(db) {
    if (!await hasColumn(db, 'categories', 'slug')) await db.query('ALTER TABLE categories ADD COLUMN slug VARCHAR(80) NULL');
    if (!await hasColumn(db, 'categories', 'description')) await db.query('ALTER TABLE categories ADD COLUMN description TEXT NULL');
    if (!await hasColumn(db, 'categories', 'created_by_user_ID')) {
        const [[user]] = await db.query(`SELECT COLUMN_TYPE AS type FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'ID'`);
        if (!/^(?:bigint|int)(?: unsigned)?$/.test(user.type)) throw new Error('Unsupported account ID type');
        await db.query(`ALTER TABLE categories ADD COLUMN created_by_user_ID ${user.type} NULL,
            ADD CONSTRAINT fk_topics_creator FOREIGN KEY (created_by_user_ID) REFERENCES users(ID) ON DELETE SET NULL,
            ADD INDEX idx_topics_creator_created (created_by_user_ID, created_at)`);
    }
    await db.query(`CREATE TABLE IF NOT EXISTS topic_legacy_routes (
        route_hash BINARY(32) NOT NULL PRIMARY KEY, route_key VARCHAR(2048) NOT NULL,
        category_ID INT UNSIGNED NOT NULL,
        CONSTRAINT fk_topic_legacy_category FOREIGN KEY (category_ID) REFERENCES categories(ID) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await db.query(`CREATE TABLE IF NOT EXISTS topic_migration_archive (
        migration_id VARCHAR(128) NOT NULL PRIMARY KEY, payload JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id VARCHAR(128) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

export async function inspectFlatTopics(db) {
    const [categories] = await db.query('SELECT * FROM categories ORDER BY ID');
    const [dimensions] = await db.query('SELECT * FROM ranking_dimensions ORDER BY ID');
    const [options] = await db.query('SELECT * FROM ranking_dimension_options ORDER BY ID');
    return { categories, dimensions, options, plan: flatTopicsPlan(categories, dimensions, options) };
}

export async function verifyFlatTopics(db) {
    const [[nonflat]] = await db.query('SELECT COUNT(*) AS count FROM categories WHERE parent_ID IS NOT NULL');
    if (Number(nonflat.count)) throw new Error('Topic hierarchy was not flattened');
    const [[missing]] = await db.query('SELECT COUNT(*) AS count FROM categories WHERE slug IS NULL OR slug = \'\'');
    if (Number(missing.count)) throw new Error('Topic slugs were not populated');
    const [[invalid]] = await db.query(`SELECT COUNT(*) AS count FROM ranking_contexts rc
        JOIN categories c ON c.ID = rc.category_ID
        WHERE c.is_active = 1 AND JSON_LENGTH(rc.context_values) !=
            (SELECT COUNT(*) FROM ranking_dimensions d WHERE d.scope_category_ID = c.ID AND d.is_active = 1)`);
    if (Number(invalid.count)) throw new Error('Context dimensions do not match independent topic scopes');
    const [contexts] = await db.query(`SELECT rc.ID, rc.category_ID, rc.context_values, rc.context_hash
        FROM ranking_contexts rc JOIN categories c ON c.ID = rc.category_ID WHERE c.is_active = 1`);
    const [dimensions] = await db.query('SELECT * FROM ranking_dimensions WHERE is_active = 1 ORDER BY position, ID');
    const [options] = await db.query('SELECT * FROM ranking_dimension_options ORDER BY position, ID');
    for (const context of contexts) {
        const values = typeof context.context_values === 'string' ? JSON.parse(context.context_values) : context.context_values;
        const selected = decorateDimensions(selectScopedDimensions(dimensions,
            { ID: Number(context.category_ID), isLeaf: true }), options);
        const canonical = canonicalizeContextValues(values, selected, { requireAllDimensions: true });
        if (serializeRankingContextValues(canonical.contextValues).contextHash !== context.context_hash) {
            throw new Error('Stored topic context hash does not match its values: ' + context.ID);
        }
    }
    const [[constraint]] = await db.query(`SELECT COUNT(*) AS count FROM information_schema.table_constraints
        WHERE constraint_schema = DATABASE() AND table_name = 'categories' AND constraint_name = 'chk_topics_flat'`);
    if (!Number(constraint.count)) await db.query('ALTER TABLE categories ADD CONSTRAINT chk_topics_flat CHECK (parent_ID IS NULL)');
    return { verified: true };
}

export async function applyFlatTopics(db) {
    await ensureFlatTopicSchema(db);
    const { ensureUserProfileSchema } = await import('../user-profile-service.js');
    await ensureUserProfileSchema(db);
    const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [FLAT_TOPICS_MIGRATION]);
    if (markers.length) return { applied: false, ...await verifyFlatTopics(db) };
    const snapshot = await inspectFlatTopics(db);
    await db.beginTransaction();
    try {
        await db.execute('INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)',
            [FLAT_TOPICS_MIGRATION, JSON.stringify({ categories: snapshot.categories, dimensions: snapshot.dimensions, options: snapshot.options })]);
        await db.query('UPDATE ranking_dimensions SET is_active = 0 WHERE is_active = 1');
        for (const topic of snapshot.plan) {
            if (topic.alias) await db.execute(`INSERT INTO topic_legacy_routes (route_hash, route_key, category_ID)
                VALUES (UNHEX(?), ?, ?)`, [crypto.createHash('sha256').update(topic.alias).digest('hex'), topic.alias, topic.ID]);
            await db.execute(`UPDATE categories SET name = ?, slug = ?, parent_ID = NULL,
                created_by_user_ID = COALESCE(created_by_user_ID, owner_user_ID) WHERE ID = ?`, [topic.name, topic.slug, topic.ID]);
            for (const dimension of topic.dimensions) {
                if (Number(dimension.scope_category_ID) === topic.ID) {
                    await db.execute('UPDATE ranking_dimensions SET is_active = 1, position = ? WHERE ID = ?', [dimension.position, dimension.ID]);
                    continue;
                }
                const [existing] = await db.execute('SELECT ID FROM ranking_dimensions WHERE scope_category_ID = ? AND dimension_key = ?',
                    [topic.ID, dimension.dimension_key]);
                let ID;
                if (existing.length) {
                    ID = existing[0].ID;
                    await db.execute('UPDATE ranking_dimensions SET name = ?, position = ?, is_active = 1, notes = ? WHERE ID = ?',
                        [dimension.name, dimension.position, dimension.notes ?? null, ID]);
                    await db.execute('DELETE FROM ranking_dimension_options WHERE dimension_ID = ?', [ID]);
                } else {
                    const [result] = await db.execute(`INSERT INTO ranking_dimensions
                        (scope_category_ID, dimension_key, name, position, is_active, notes) VALUES (?, ?, ?, ?, 1, ?)`,
                    [topic.ID, dimension.dimension_key, dimension.name, dimension.position, dimension.notes ?? null]);
                    ID = result.insertId;
                }
                for (const option of dimension.options) await db.execute(`INSERT INTO ranking_dimension_options
                    (dimension_ID, option_key, name, position, is_default, is_neutral) VALUES (?, ?, ?, ?, ?, ?)`,
                [ID, option.option_key, option.name, option.position, option.is_default, option.is_neutral]);
            }
        }
        await db.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [FLAT_TOPICS_MIGRATION]);
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    return { applied: true, topics: snapshot.plan.length,
        aliases: snapshot.plan.filter(topic => topic.alias).length, discardedRecords: 0, ...await verifyFlatTopics(db) };
}

export async function verifyBackup(path, database) {
    if (!path) throw new Error('A fresh backup manifest is required before applying');
    const manifest = JSON.parse(await readFile(resolve(path), 'utf8'));
    const createdAt = Date.parse(manifest.createdAt);
    if (manifest.database !== database || typeof manifest.path !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)
        || !Number.isFinite(createdAt) || Date.now() - createdAt > 7200000 || createdAt > Date.now()) {
        throw new Error('Backup manifest does not match this migration');
    }
    const info = await stat(manifest.path);
    if (!info.isFile() || info.size !== manifest.bytes || info.size < 1000 || info.mode & 0o077) throw new Error('Backup file is missing, unsafe, or incomplete');
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(manifest.path)) hash.update(chunk);
    if (hash.digest('hex') !== manifest.sha256) throw new Error('Backup integrity check failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const apply = process.argv.includes('--apply'), rehearse = process.argv.includes('--rehearse');
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    if (rehearse && !/^benchpoll_topics_rehearsal_[a-z0-9_]+$/.test(database)) throw new Error('Rehearsal must use an isolated database');
    if (apply && !rehearse) await verifyBackup(process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD, database,
        supportBigNumbers: true, bigNumberStrings: true });
    try {
        const [[lock]] = await db.query('SELECT GET_LOCK(?, 30) AS acquired', [FLAT_TOPICS_MIGRATION]);
        if (Number(lock.acquired) !== 1) throw new Error('Could not acquire topic migration lock');
        try {
            const result = apply || rehearse ? await applyFlatTopics(db) : await inspectFlatTopics(db);
            console.log(JSON.stringify({ migration: FLAT_TOPICS_MIGRATION, dryRun: !apply && !rehearse,
                ...(apply || rehearse ? result : { topics: result.plan.length,
                    renamed: result.plan.filter(topic => result.categories.find(row => Number(row.ID) === topic.ID).name !== topic.name)
                        .map(topic => ({ ID: topic.ID, name: topic.name })),
                    dimensionsToMaterialize: result.plan.flatMap(topic => topic.dimensions.filter(dimension => Number(dimension.scope_category_ID) !== topic.ID)).length }) }));
        } finally { await db.query('SELECT RELEASE_LOCK(?)', [FLAT_TOPICS_MIGRATION]); }
    } finally { await db.end(); }
}
