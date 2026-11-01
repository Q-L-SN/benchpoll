import { config } from 'dotenv';
import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const root = '/home/ubuntu/benchpoll';
const stage = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/(?:flat-topics-20261022\/topics-20261022|topics-polish-20261023\/topics-polish-20261023|topics-policy-20261026\/topics-policy-20261026|topics-taxonomy-20261026\/topics-taxonomy-20261026|topics-identity-ui-20261026\/topics-identity-ui-20261026|topics-account-20261027\/topics-account-20261027|audit-fixes-20261030\/audit-fixes-20261030)-\d+$/.test(stage)) throw new Error('Unsafe migration stage');
const auditFixes = stage.includes('/audit-fixes-20261030/');
const accountFlow = stage.includes('/topics-account-20261027/') || auditFixes;
const taxonomy = stage.includes('/topics-taxonomy-20261026/');
const taxonomyMigration = taxonomy ? await import(join(stage, 'candidate/scripts/migrate-topic-taxonomy-20261026.mjs')) : null;
const applicationEnvironment = config({ path: join(root, '.env'), quiet: true }).parsed || {};
const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
const clone = process.env.BENCHPOLL_REHEARSAL_DB || 'benchpoll_topics_rehearsal_20261022';
if (!/^[a-zA-Z0-9_]+$/.test(database) || !/^benchpoll_topics_rehearsal_[a-z0-9_]+$/.test(clone)
    || database === clone) throw new Error('Unexpected production or rehearsal database');
const settings = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD,
    database, supportBigNumbers: true, bigNumberStrings: true };
const db = await mysql.createConnection(settings);
const mode = process.argv[3] || 'inspect';
const preservedTables = ['categories', 'ranking_contexts', 'personal_pies', 'personal_pie_weights',
    'benchmarks', 'benchmark_conditions', 'benchmark_results', 'models', 'discussion_posts',
    ...(accountFlow ? ['topic_proposals', 'topic_proposal_votes'] : [])];
const checksum = async path => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
};
const counts = async connection => {
    const result = {};
    for (const table of preservedTables) {
        const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
        result[table] = Number(row.count);
    }
    return result;
};
const configurationDigests = async connection => {
    const digests = {};
    for (const [table, order] of Object.entries({ users: 'ID', personal_pies: 'ID',
        personal_pie_weights: 'pie_ID, benchmark_condition_ID', personal_pie_score_rules: 'pie_ID, primary_benchmark_condition_ID',
        benchmark_families: 'ID', benchmark_family_members: 'family_ID, position', discussion_posts: 'ID', user_public_profiles: 'user_ID',
        ...(accountFlow ? { topic_proposals: 'ID', topic_proposal_votes: 'proposal_ID, user_ID' } : {}) })) {
        const [[exists]] = await connection.execute('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [table]);
        const projection = accountFlow && table === 'user_public_profiles'
            ? 'user_ID, display_name, avatar_data_url, updated_at' : accountFlow && table === 'topic_proposals'
                ? 'ID, user_ID, name, slug, description, status, moderation_log_ID, topic_ID, promoted_at, decided_at, created_at, updated_at'
                    + (auditFixes ? ', revision, withdrawn_at' : '') : '*';
        const [rows] = Number(exists.count) ? await connection.query(`SELECT ${projection} FROM \`${table}\` ORDER BY ${order}`) : [[]];
        digests[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    return digests;
};
const child = (file, args) => {
    const process = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    process.stdin.on('error', () => {});
    let diagnostic = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-4000); });
    const completed = new Promise((resolveChild, reject) => {
        process.on('error', reject);
        process.on('close', code => code === 0 ? resolveChild() : reject(new Error(`${file} failed (${code}): ${diagnostic}`)));
    });
    // A pipeline can fail before the caller gets to await process completion.
    completed.catch(() => {});
    return { process, completed };
};
const iniValue = value => '"' + String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
async function withClientConfig(run) {
    const path = join(stage, '.mysql-client.cnf');
    const lines = ['[client]', `user=${iniValue(settings.user)}`, `password=${iniValue(settings.password)}`,
        settings.socketPath ? `socket=${iniValue(settings.socketPath)}` : `host=${iniValue(settings.host)}`,
        `port=${settings.port}`];
    await writeFile(path, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    try { return await run(path); } finally { await unlink(path); }
}
const dumpArguments = path => [`--defaults-extra-file=${path}`, '--single-transaction', '--quick', '--hex-blob',
    '--no-tablespaces', '--set-gtid-purged=OFF', '--default-character-set=utf8mb4'];
try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await chmod(stage, 0o700);
    if (mode === 'inspect') {
        const [triggers] = await db.query(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA = ? AND ACTION_STATEMENT LIKE ?`, [database, `%${database}.%`]);
        console.log(JSON.stringify({ database, counts: await counts(db), crossDatabaseTriggers: triggers.length,
            protectedTablesVerified: Object.keys(await configurationDigests(db)) }));
    } else if (mode === 'backup') {
        const path = join(stage, `database-${Date.now()}.sql.gz`);
        await withClientConfig(async configPath => {
            const dump = child('mysqldump', [...dumpArguments(configPath), '--routines', '--events', '--triggers', database]);
            dump.process.stdin.end();
            await Promise.all([pipeline(dump.process.stdout, createGzip({ level: 6 }), createWriteStream(path, { mode: 0o600, flags: 'wx' })), dump.completed]);
        });
        const check = child('gzip', ['-t', path]); check.process.stdin.end(); await check.completed;
        const manifest = { database, path, bytes: (await stat(path)).size, sha256: await checksum(path),
            createdAt: new Date().toISOString(), counts: await counts(db), configurationDigests: await configurationDigests(db) };
        if (taxonomy) manifest.taxonomyPreservation = await taxonomyMigration.taxonomyPreservation(db);
        await writeFile(join(stage, 'database-backup.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ backup: path, bytes: manifest.bytes, verified: true }));
    } else if (mode === 'verify-production') {
        const backup = JSON.parse(await readFile(join(stage, 'database-backup.json'), 'utf8'));
        if (backup.database !== database || !backup.configurationDigests) throw new Error('Missing protected-data backup evidence');
        if (taxonomy) {
            const changes = JSON.parse(await readFile(join(stage, 'migration-result.json'), 'utf8'));
            if (!changes.applied || !changes.protectedDataUnchanged || !backup.taxonomyPreservation) throw new Error('Missing taxonomy migration evidence');
            const expected = { ...backup.counts,
                categories: backup.counts.categories + changes.preservedPies.length,
                ranking_contexts: backup.counts.ranking_contexts - changes.deletedContexts.length + changes.preservedPies.length };
            if (JSON.stringify(await counts(db)) !== JSON.stringify(expected)
                || JSON.stringify(await taxonomyMigration.taxonomyPreservation(db)) !== JSON.stringify(backup.taxonomyPreservation)) {
                throw new Error('Taxonomy migration changed protected content, scores or weights');
            }
            await taxonomyMigration.verifyTopicTaxonomy(db);
        } else {
            if (JSON.stringify(await counts(db)) !== JSON.stringify(backup.counts)
                || JSON.stringify(await configurationDigests(db)) !== JSON.stringify(backup.configurationDigests)) {
                throw new Error('Migration changed protected records; leave the write freeze in place');
            }
        }
        console.log(JSON.stringify({ verified: true, productionCountsUnchanged: !taxonomy,
            intentionalContextConsolidationVerified: taxonomy, privateConfigurationAndIdentityDigestsUnchanged: true }));
    } else if (mode === 'clone') {
        if (settings.user !== 'root') throw new Error('Use the operational account for an isolated unlogged rehearsal copy');
        const space = await statfs(root);
        const [[size]] = await db.execute(`SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes
            FROM information_schema.tables WHERE table_schema = ?`, [database]);
        if (space.bavail * space.bsize < Number(size.bytes) * 2 + 2 * 1024 ** 3) {
            throw new Error('Insufficient disk headroom for a second full-size copy and import overhead');
        }
        const [[exists]] = await db.execute('SELECT COUNT(*) AS count FROM information_schema.schemata WHERE schema_name = ?', [clone]);
        if (Number(exists.count)) throw new Error('Rehearsal database already exists; never overwrite it implicitly');
        const [triggers] = await db.query(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA = ? AND ACTION_STATEMENT LIKE ?`, [database, `%${database}.%`]);
        if (triggers.length) throw new Error('Review cross-database trigger references before cloning');
        await db.query(`CREATE DATABASE \`${clone}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
        const applicationUser = applicationEnvironment.BENCHPOLL_DB_USER || 'root';
        if (applicationUser !== settings.user) {
            if (!/^[a-zA-Z0-9_]+$/.test(applicationUser)) throw new Error('Unexpected application database account');
            await db.query(`GRANT ALL PRIVILEGES ON \`${clone}\`.* TO ${db.escape(applicationUser)}@'localhost'`);
        }
        await withClientConfig(async configPath => {
            const dump = child('mysqldump', [...dumpArguments(configPath), '--skip-events', '--skip-routines', '--triggers', database]);
            const restore = child('mysql', [`--defaults-extra-file=${configPath}`, '--init-command=SET SESSION sql_log_bin=0',
                '--default-character-set=utf8mb4', clone]);
            dump.process.stdin.end(); restore.process.stdout.resume();
            await Promise.all([pipeline(dump.process.stdout, restore.process.stdin), dump.completed, restore.completed]);
        });
        const connection = await mysql.createConnection({ ...settings, database: clone });
        try {
            const actual = await counts(connection), expected = await counts(db);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Clone counts do not match production');
            await writeFile(join(stage, 'rehearsal-before.json'), JSON.stringify(actual, null, 2), { mode: 0o600 });
            console.log(JSON.stringify({ database: clone, counts: actual, eventsCopied: false }));
        } finally { await connection.end(); }
    } else if (mode === 'reset-clone') {
        const connection = await mysql.createConnection({ ...settings, database: clone });
        try {
            const expected = JSON.parse(await readFile(join(stage, 'rehearsal-before.json'), 'utf8'));
            if (JSON.stringify(await counts(connection)) !== JSON.stringify(expected)) throw new Error('Rehearsal has unexpected business changes');
            const [rows] = await connection.execute('SELECT payload FROM topic_migration_archive WHERE migration_id = ?', ['flat_topics_home_20261022']);
            if (rows.length !== 1) throw new Error('Missing original rehearsal metadata archive');
            const archived = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
            const [[constraint]] = await connection.query(`SELECT COUNT(*) AS count FROM information_schema.table_constraints
                WHERE constraint_schema = DATABASE() AND table_name = 'categories' AND constraint_name = 'chk_topics_flat'`);
            if (Number(constraint.count)) await connection.query('ALTER TABLE categories DROP CHECK chk_topics_flat');
            await connection.beginTransaction();
            try {
                for (const category of archived.categories) await connection.execute('UPDATE categories SET name = ?, parent_ID = ? WHERE ID = ?',
                    [category.name, category.parent_ID, category.ID]);
                await connection.query('DELETE FROM ranking_dimension_options');
                await connection.query('DELETE FROM ranking_dimensions');
                for (const dimension of archived.dimensions) await connection.execute(`INSERT INTO ranking_dimensions
                    (ID, scope_category_ID, dimension_key, name, position, is_active, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [dimension.ID, dimension.scope_category_ID, dimension.dimension_key, dimension.name, dimension.position, dimension.is_active, dimension.notes]);
                for (const option of archived.options) await connection.execute(`INSERT INTO ranking_dimension_options
                    (ID, dimension_ID, option_key, name, position, is_default, is_neutral) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [option.ID, option.dimension_ID, option.option_key, option.name, option.position, option.is_default, option.is_neutral]);
                await connection.query('DELETE FROM topic_legacy_routes');
                await connection.execute('DELETE FROM schema_migrations WHERE migration_id = ?', ['flat_topics_home_20261022']);
                await connection.execute('DELETE FROM topic_migration_archive WHERE migration_id = ?', ['flat_topics_home_20261022']);
                await connection.commit();
            } catch (error) { await connection.rollback(); throw error; }
            console.log(JSON.stringify({ database: clone, originalMetadataRestored: true, businessRecordsChanged: false }));
        } finally { await connection.end(); }
    } else if (mode === 'cleanup-clone') {
        const expected = JSON.parse(await readFile(join(stage, 'rehearsal-before.json'), 'utf8'));
        const connection = await mysql.createConnection({ ...settings, database: clone });
        try {
            if (JSON.stringify(await counts(connection)) !== JSON.stringify(expected)) throw new Error('Unexpected rehearsal data; cleanup aborted');
            const [[marker]] = await connection.execute('SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_id = ?', ['flat_topics_home_20261022']);
            if (Number(marker.count) !== 1) throw new Error('Not a completed rehearsal database');
        } finally { await connection.end(); }
        await db.query(`DROP DATABASE \`${clone}\``);
        const applicationUser = applicationEnvironment.BENCHPOLL_DB_USER || 'root';
        if (applicationUser !== settings.user && /^[a-zA-Z0-9_]+$/.test(applicationUser)) {
            await db.query(`REVOKE ALL PRIVILEGES ON \`${clone}\`.* FROM ${db.escape(applicationUser)}@'localhost'`);
        }
        console.log(JSON.stringify({ removedRehearsalDatabase: clone, productionDatabaseUnchanged: true }));
    } else if (mode === 'verify-clone') {
        const expected = JSON.parse(await readFile(join(stage, 'rehearsal-before.json'), 'utf8'));
        const connection = await mysql.createConnection({ ...settings, database: clone });
        try {
            const actual = await counts(connection);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Migration changed preserved row counts');
            console.log(JSON.stringify({ database: clone, preservedCounts: actual, verified: true }));
        } finally { await connection.end(); }
    } else throw new Error('Unknown database operation');
} finally { await db.end(); }
