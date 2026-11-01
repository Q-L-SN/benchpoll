import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeTopicSummary } from '../public/js/shared/topics.js';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const TOPIC_SUMMARY_MIGRATION = 'topic_summaries_20261026';
export const OFFICIAL_TOPIC_SUMMARIES = Object.freeze({
    54: 'Reasoning, knowledge, and getting useful work done.',
    180: 'Build, debug, and improve software.',
    196: 'Work with documents, spreadsheets, and everyday data.',
    197: 'Recognize conditions and reason through clinical cases.',
    198: 'Find, interpret, and apply legal information.',
    199: 'Find vulnerabilities, defend systems, and solve cryptographic problems.',
    232: "Improve an AI system's own capabilities through research and iteration.",
    216: 'Explain ideas, guide learning, and check understanding.',
    231: 'Complete real workplace tasks using digital tools.',
    202: 'Organize people, resources, and business decisions.',
    167: 'Investigate questions and solve problems across academic disciplines.',
    176: 'Operate software through interfaces, browsers, and desktop environments.',
    178: 'Perceive, plan, and act in the physical world.',
    234: 'Anticipate outcomes and choose well under uncertainty.',
    184: 'Turn goals into workable steps and adapt as conditions change.',
    204: 'Work effectively with people and other AI systems.',
    208: 'Learn new skills from experience and feedback.',
    209: 'Find relevant information and use it accurately.',
    182: 'Stay grounded in facts and acknowledge uncertainty.',
    215: 'Remember, retrieve, and connect information across long interactions.',
    210: 'Understand images, video, audio, and live inputs.',
    172: 'Create bitmap and vector images from prompts or references.',
    173: 'Create videos and editable projects from prompts or references.',
    190: 'Create speech, music, and other audio.',
    191: 'Create three-dimensional assets with or without references.',
    192: 'Design interactive interfaces from prompts or references.',
    193: 'Communicate clearly and respond thoughtfully to people.',
    187: 'Write, edit, and shape ideas for different audiences.',
    219: 'Understand, produce, and translate languages.',
    166: 'Track progress toward broad, adaptable human-level intelligence.'
});

export function topicSummaryPlan(rows) {
    return rows.map(row => {
        const ID = Number(row.ID);
        if (!Number.isSafeInteger(ID) || ID < 1 || typeof row.name !== 'string' || !row.name.trim()) throw new Error('Invalid topic identity');
        const before = row.description;
        // Existing authored text is never shortened or replaced by this backfill.
        if (typeof before === 'string' && before.trim()) {
            try { normalizeTopicSummary(before); }
            catch { throw new Error(`Review the existing summary before migrating topic ${ID}`); }
            return { ID, name: row.name, before, description: before };
        }
        if (before != null && typeof before !== 'string') throw new Error(`Invalid summary for topic ${ID}`);
        const known = row.owner_user_ID == null && row.created_by_user_ID == null ? OFFICIAL_TOPIC_SUMMARIES[ID] : null;
        return { ID, name: row.name, before, description: normalizeTopicSummary(known
            || `${row.is_active ? 'Benchmarks' : 'Archived benchmarks'} for ${row.name}.`) };
    });
}

export async function verifyTopicSummaries(db) {
    const [rows] = await db.query('SELECT ID, name, description, is_active, owner_user_ID, created_by_user_ID FROM categories ORDER BY ID');
    const missing = rows.filter(row => row.description == null || !row.description.trim());
    if (missing.length) throw new Error('Topics are missing summaries: ' + missing.map(row => row.ID).join(','));
    topicSummaryPlan(rows);
    return { verified: true, topics: rows.length, activeTopics: rows.filter(row => row.is_active).length };
}

export async function applyTopicSummaries(db) {
    await db.beginTransaction();
    try {
        const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ? FOR UPDATE', [TOPIC_SUMMARY_MIGRATION]);
        if (markers.length) {
            const result = await verifyTopicSummaries(db); await db.commit();
            return { applied: false, ...result };
        }
        const [rows] = await db.query('SELECT ID, name, description, is_active, owner_user_ID, created_by_user_ID FROM categories ORDER BY ID FOR UPDATE');
        const changes = topicSummaryPlan(rows).filter(row => row.before !== row.description);
        for (const row of changes) {
            const [result] = await db.execute('UPDATE categories SET description = ?, updated_at = updated_at WHERE ID = ? AND name = ? AND description <=> ?',
                [row.description, row.ID, row.name, row.before]);
            if (result.affectedRows !== 1) throw new Error('Topic changed during summary migration: ' + row.ID);
        }
        await db.execute('INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)', [TOPIC_SUMMARY_MIGRATION, JSON.stringify({ changes })]);
        const result = await verifyTopicSummaries(db);
        await db.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [TOPIC_SUMMARY_MIGRATION]);
        await db.commit();
        return { applied: true, changedSummaries: changes.length, ...result };
    } catch (error) { await db.rollback(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    const apply = process.argv.includes('--apply'), rehearse = process.argv.includes('--rehearse');
    if (rehearse && !/^benchpoll_summary_rehearsal_[a-z0-9_]+$/.test(database)) throw new Error('Rehearsal requires an isolated metadata database');
    if (apply && !rehearse) await verifySlugBackup(process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD, database,
        supportBigNumbers: true, bigNumberStrings: true });
    try {
        const [[lock]] = await db.query('SELECT GET_LOCK(?, 30) AS acquired', [TOPIC_SUMMARY_MIGRATION]);
        if (Number(lock.acquired) !== 1) throw new Error('Topic summary migration is already running');
        try {
            const [rows] = await db.query('SELECT ID, name, description, is_active, owner_user_ID, created_by_user_ID FROM categories ORDER BY ID');
            console.log(JSON.stringify(apply || rehearse ? await applyTopicSummaries(db)
                : { dryRun: true, changes: topicSummaryPlan(rows).filter(row => row.before !== row.description) }));
        } finally { await db.query('SELECT RELEASE_LOCK(?)', [TOPIC_SUMMARY_MIGRATION]); }
    } finally { await db.end(); }
}
