import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { ensureTopicSnapshotSchema } from '../../scripts/migrate-topic-snapshots-20261102.mjs';
import { migrateCommunityVersions } from '../../scripts/migrate-community-versions-20261103.mjs';

// Explicitly opt-in, loopback-only, synthetic schema. Never connect to an application database.
export async function createLifecycleDatabase() {
    const file = process.env.LIFECYCLE_MYSQL_ENV_FILE;
    if (!file) throw new Error('Set LIFECYCLE_MYSQL_ENV_FILE to the disposable local MySQL env file.');
    const env = await readFile(file, 'utf8');
    const password = env.match(/^MYSQL_ROOT_PASSWORD=(.+)$/m)?.[1];
    if (!password) throw new Error('The local MySQL password is missing.');
    const config = { host: '127.0.0.1', port: Number(process.env.LIFECYCLE_MYSQL_PORT || 33306),
        user: 'root', password, supportBigNumbers: true, bigNumberStrings: true };
    const database = 'benchpoll_lifecycle_test_' + randomUUID().replaceAll('-', '');
    const admin = await mysql.createConnection(config);
    await admin.query('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    const pool = mysql.createPool({ ...config, database, connectionLimit: 8 });
    try {
        const connection = await pool.getConnection();
        try {
            const sql = await readFile(new URL('../../docs/cloud/schema-20261101.sql', import.meta.url), 'utf8');
            if (/^\s*(?:INSERT|REPLACE|LOAD\s+DATA|USE|DROP)\b/im.test(sql)) throw new Error('Expected schema-only development input.');
            let delimiter = ';', statement = '';
            for (const line of sql.split('\n')) {
                if (line.startsWith('DELIMITER ')) { delimiter = line.slice(10).trim(); continue; }
                statement += line + '\n';
                if (statement.trimEnd().endsWith(delimiter)) {
                    await connection.query(statement.trimEnd().slice(0, -delimiter.length)); statement = '';
                }
            }
            await ensureTopicSnapshotSchema(connection);
            await migrateCommunityVersions(connection, { apply: true });
            await connection.query('INSERT INTO topic_reference_lock (ID) VALUES (1)');
            await connection.query('INSERT INTO ranking_cache_revisions (ID, epoch, ready) VALUES (1, UUID(), 1), (2, UUID(), 1)');
            for (const ID of ['42', '43', ...Array.from({ length: 31 }, (_, index) => String(1000 + index))]) {
                await connection.execute(`INSERT INTO users (ID, name, profile_picture_URL, followers_count, email, email_verified_at)
                    VALUES (?, ?, '/assets/benchpoll-mark.svg', 1, ?, NOW(3))`, [ID, 'Example ' + ID, 'user' + ID + '@example.test']);
            }
        } finally { connection.release(); }
        return { pool, database, async close() { await pool.end(); await admin.query('DROP DATABASE ' + database); await admin.end(); } };
    } catch (error) { await pool.end(); await admin.query('DROP DATABASE ' + database); await admin.end(); throw error; }
}

export async function seedLifecycleEvidence(pool) {
    await pool.execute("INSERT INTO organizations (ID, slug, name, is_model_vendor) VALUES (1, 'example', 'Example', 1)");
    for (let ID = 1; ID <= 3; ID++) {
        await pool.execute('INSERT INTO models (ID, vendor_ID, slug, name) VALUES (?, 1, ?, ?)', [ID, 'model-' + ID, 'Model ' + ID]);
        await pool.execute('INSERT INTO benchmarks (ID, name) VALUES (?, ?)', [ID, 'Benchmark ' + ID]);
        await pool.execute(`INSERT INTO benchmark_conditions
            (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_default, is_primary)
            VALUES (?, ?, 'default', 'Default', 'higher', 1, 1, 1)`, [ID, ID]);
    }
    for (let model = 1; model <= 3; model++) for (let condition = 1; condition <= 3; condition++) {
        await pool.execute(`INSERT INTO benchmark_results (model_ID, benchmark_ID, benchmark_condition_ID, raw_score,
            source_url, source_type, benchmark_condition_snapshot, score_fields)
            VALUES (?, ?, ?, ?, 'https://example.test/results', 'vendor_official', '{}', '[]')`,
        [model, condition, condition, condition === 1 ? 100 - model * 20 : model * 20]);
    }
}
