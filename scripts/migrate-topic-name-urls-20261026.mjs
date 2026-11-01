import 'dotenv/config';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { topicSlug, isReservedTopicSlug } from '../public/js/shared/topics.js';
import { legacyTopicRouteKey } from '../topic-service.js';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const TOPIC_NAME_URL_MIGRATION = 'topic_name_urls_20261026';

export function topicNameURLPlan(rows) {
    const owners = new Map(), current = new Map();
    for (const row of rows) if (row.owner_user_ID == null) current.set(row.slug, Number(row.ID));
    return rows.filter(row => row.owner_user_ID == null).map(row => {
        const ID = Number(row.ID), slug = topicSlug(row.name);
        if (!Number.isSafeInteger(ID) || ID < 1 || isReservedTopicSlug(slug)) throw new Error('Invalid or reserved topic name: ' + ID);
        if (owners.has(slug)) throw new Error('Topic names normalize to the same URL: ' + slug);
        owners.set(slug, ID);
        if (current.has(slug) && current.get(slug) !== ID) throw new Error('Topic URL belongs to another topic: ' + slug);
        return { ID, name: row.name, before: row.slug, slug };
    });
}

export async function verifyTopicNameURLs(db) {
    const [rows] = await db.query('SELECT ID, name, slug, owner_user_ID, is_active FROM categories ORDER BY ID');
    const plan = topicNameURLPlan(rows);
    if (plan.some(row => row.before !== row.slug)) throw new Error('Topic name and canonical URL differ');
    return { verified: true, topics: rows.length, publicTopics: plan.length };
}

export async function applyTopicNameURLs(db) {
    await db.beginTransaction();
    try {
        const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ? FOR UPDATE', [TOPIC_NAME_URL_MIGRATION]);
        if (markers.length) {
            const verified = await verifyTopicNameURLs(db);
            await db.commit();
            return { applied: false, ...verified };
        }
        const [rows] = await db.query('SELECT ID, name, slug, owner_user_ID, is_active FROM categories ORDER BY ID FOR UPDATE');
        const plan = topicNameURLPlan(rows), changed = plan.filter(row => row.before !== row.slug);
        const [aliases] = await db.query('SELECT route_key, category_ID FROM topic_legacy_routes FOR UPDATE');
        const byKey = new Map(aliases.map(row => [row.route_key, Number(row.category_ID)]));
        for (const row of plan) {
            const key = legacyTopicRouteKey(row.slug);
            if (byKey.has(key) && byKey.get(key) !== row.ID) throw new Error('Topic URL conflicts with a retained link: ' + row.slug);
        }
        const inserted = [];
        for (const row of changed) {
            if (!row.before) throw new Error('Cannot retain an empty old topic URL');
            const key = legacyTopicRouteKey(row.before);
            if (byKey.has(key) && byKey.get(key) !== row.ID) throw new Error('Old topic link belongs to another topic: ' + row.before);
            if (!byKey.has(key)) {
                await db.execute('INSERT INTO topic_legacy_routes (route_hash, route_key, category_ID) VALUES (UNHEX(?), ?, ?)',
                    [crypto.createHash('sha256').update(key).digest('hex'), key, row.ID]);
                inserted.push({ key, ID: row.ID }); byKey.set(key, row.ID);
            }
            const [result] = await db.execute('UPDATE categories SET slug = ? WHERE ID = ? AND name = ? AND slug <=> ?',
                [row.slug, row.ID, row.name, row.before]);
            if (result.affectedRows !== 1) throw new Error('Topic changed during URL migration: ' + row.ID);
        }
        await db.execute('INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)',
            [TOPIC_NAME_URL_MIGRATION, JSON.stringify({ changes: changed, insertedAliases: inserted })]);
        const verified = await verifyTopicNameURLs(db);
        await db.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [TOPIC_NAME_URL_MIGRATION]);
        await db.commit();
        return { applied: true, changedSlugs: changed, insertedAliases: inserted.length, ...verified };
    } catch (error) { await db.rollback(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    const apply = process.argv.includes('--apply'), rehearse = process.argv.includes('--rehearse');
    if (rehearse && !/^benchpoll_slug_rehearsal_[a-z0-9_]+$/.test(database)) throw new Error('Rehearsal requires an isolated metadata database');
    if (apply && !rehearse) await verifySlugBackup(process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD, database,
        supportBigNumbers: true, bigNumberStrings: true });
    try {
        const [[lock]] = await db.query('SELECT GET_LOCK(?, 30) AS acquired', [TOPIC_NAME_URL_MIGRATION]);
        if (Number(lock.acquired) !== 1) throw new Error('Topic name URL migration is already running');
        try {
            const [rows] = await db.query('SELECT ID, name, slug, owner_user_ID, is_active FROM categories ORDER BY ID');
            console.log(JSON.stringify(apply || rehearse ? await applyTopicNameURLs(db)
                : { dryRun: true, changes: topicNameURLPlan(rows).filter(row => row.before !== row.slug) }));
        } finally { await db.query('SELECT RELEASE_LOCK(?)', [TOPIC_NAME_URL_MIGRATION]); }
    } finally { await db.end(); }
}
