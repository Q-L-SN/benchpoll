import 'dotenv/config';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { topicSlug, isReservedTopicSlug } from '../public/js/shared/topics.js';
// Historical migration identity; independent of the current public URL catalogue.
const FEATURED_TOPIC_ID = 54;

export const TOPIC_SLUG_MIGRATION = 'topic_short_urls_20261023';
const validSlug = slug => typeof slug === 'string' && slug.length <= 80
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && !isReservedTopicSlug(slug);
const comparePriority = (a, b) => Number(Number(b.ID) === FEATURED_TOPIC_ID) - Number(Number(a.ID) === FEATURED_TOPIC_ID)
    || Number(Boolean(b.is_active)) - Number(Boolean(a.is_active)) || Number(a.ID) - Number(b.ID);

export function shortTopicSlugPlan(categories) {
    const used = new Set();
    const publicTopics = categories.filter(row => row.owner_user_ID == null).sort(comparePriority);
    const assigned = new Map();
    // Keep valid existing addresses before allocating names for collisions or reserved routes.
    for (const row of publicTopics) if (validSlug(row.slug) && !used.has(row.slug)) {
        assigned.set(Number(row.ID), row.slug); used.add(row.slug);
    }
    for (const row of publicTopics) if (!assigned.has(Number(row.ID))) {
        const normalized = topicSlug(row.name);
        const base = isReservedTopicSlug(normalized) ? `${normalized.slice(0, 64)}-benchmarks` : normalized;
        let slug = base, suffix = 2;
        while (used.has(slug)) {
            const ending = `-${suffix++}`;
            slug = base.slice(0, 80 - ending.length).replace(/-+$/, '') + ending;
        }
        assigned.set(Number(row.ID), slug); used.add(slug);
    }
    return categories.map(row => ({ ID: Number(row.ID), before: row.slug ?? null,
        slug: row.owner_user_ID == null ? assigned.get(Number(row.ID)) : row.slug || topicSlug(row.name),
        isPrivate: row.owner_user_ID != null }));
}

export async function verifyShortTopicSlugs(db) {
    const [rows] = await db.query('SELECT ID, name, slug, owner_user_ID, is_active FROM categories ORDER BY ID');
    const publicRows = rows.filter(row => row.owner_user_ID == null);
    if (publicRows.some(row => !validSlug(row.slug)) || new Set(publicRows.map(row => row.slug)).size !== publicRows.length) {
        throw new Error('Public topic addresses are not unique, valid and unreserved');
    }
    const [[index]] = await db.query(`SELECT COUNT(*) AS count FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'categories' AND index_name = 'uq_topics_public_slug' AND non_unique = 0`);
    if (Number(index.count) !== 1) throw new Error('Public topic address uniqueness is not enforced');
    return { verified: true, topics: rows.length, publicTopics: publicRows.length };
}

export async function applyShortTopicSlugs(db) {
    const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [TOPIC_SLUG_MIGRATION]);
    if (markers.length) return { applied: false, ...await verifyShortTopicSlugs(db) };
    const [rows] = await db.query('SELECT ID, name, slug, owner_user_ID, is_active FROM categories ORDER BY ID');
    const plan = shortTopicSlugPlan(rows);
    await db.beginTransaction();
    try {
        await db.execute('INSERT IGNORE INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)',
            [TOPIC_SLUG_MIGRATION, JSON.stringify({ slugs: rows.map(row => ({ ID: row.ID, slug: row.slug })) })]);
        for (const row of plan) if (row.before !== row.slug) {
            const [result] = await db.execute('UPDATE categories SET slug = ? WHERE ID = ? AND slug <=> ?', [row.slug, row.ID, row.before]);
            if (result.affectedRows !== 1) throw new Error('Topic address changed during migration: ' + row.ID);
        }
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    const [[column]] = await db.execute(`SELECT COUNT(*) AS count FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'categories' AND column_name = 'public_slug'`);
    if (!Number(column.count)) await db.query(`ALTER TABLE categories ADD COLUMN public_slug VARCHAR(80)
        GENERATED ALWAYS AS (CASE WHEN owner_user_ID IS NULL THEN slug ELSE NULL END) VIRTUAL`);
    const [[index]] = await db.query(`SELECT COUNT(*) AS count FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'categories' AND index_name = 'uq_topics_public_slug'`);
    if (!Number(index.count)) await db.query('ALTER TABLE categories ADD UNIQUE INDEX uq_topics_public_slug (public_slug)');
    const verified = await verifyShortTopicSlugs(db);
    await db.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [TOPIC_SLUG_MIGRATION]);
    return { applied: true, changedSlugs: plan.filter(row => row.before !== row.slug).map(row => ({ ID: row.ID, slug: row.slug })), ...verified };
}

export async function verifySlugBackup(path, database) {
    if (!path) throw new Error('A fresh backup manifest is required');
    const manifest = JSON.parse(await readFile(resolve(path), 'utf8'));
    const time = Date.parse(manifest.createdAt);
    if (manifest.database !== database || typeof manifest.path !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)
        || !Number.isFinite(time) || time > Date.now() || Date.now() - time > 7200000) throw new Error('Invalid migration backup manifest');
    const info = await stat(manifest.path);
    if (!info.isFile() || info.size !== manifest.bytes || info.size < 1000 || info.mode & 0o077) throw new Error('Invalid migration backup file');
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(manifest.path)) hash.update(chunk);
    if (hash.digest('hex') !== manifest.sha256) throw new Error('Migration backup integrity check failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    const apply = process.argv.includes('--apply'), rehearse = process.argv.includes('--rehearse');
    if (rehearse && !/^benchpoll_slug_rehearsal_[a-z0-9_]+$/.test(database)) throw new Error('Rehearsal requires an isolated database');
    if (apply && !rehearse) await verifySlugBackup(process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD, database,
        supportBigNumbers: true, bigNumberStrings: true });
    try {
        const [[lock]] = await db.query('SELECT GET_LOCK(?, 30) AS acquired', [TOPIC_SLUG_MIGRATION]);
        if (Number(lock.acquired) !== 1) throw new Error('Topic URL migration is already running');
        try {
            const [rows] = await db.query('SELECT ID, name, slug, owner_user_ID, is_active FROM categories ORDER BY ID');
            console.log(JSON.stringify(apply || rehearse ? await applyShortTopicSlugs(db)
                : { dryRun: true, changes: shortTopicSlugPlan(rows).filter(row => row.before !== row.slug) }));
        } finally { await db.query('SELECT RELEASE_LOCK(?)', [TOPIC_SLUG_MIGRATION]); }
    } finally { await db.end(); }
}
