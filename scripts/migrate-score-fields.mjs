import 'dotenv/config';
import mysql from 'mysql2/promise';
import { fieldNameKey } from '../public/js/shared/score-fields.js';

const apply = process.argv.includes('--apply');
const db = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
try {
    const [[lock]] = await db.execute("SELECT GET_LOCK('benchpoll_score_fields', 10) AS acquired");
    if (Number(lock.acquired) !== 1) throw Error('Another score-field migration is running');
    const [done] = await db.execute("SELECT migration_id FROM schema_migrations WHERE migration_id = '029_score_fields'");
    if (done.length) { console.log('Score-field migration already applied'); }
    else {
        const [prepared] = await db.execute("SELECT migration_id FROM schema_migrations WHERE migration_id = '029_score_fields_prepared'");
        const [pending] = await db.execute(`SELECT ID FROM moderation_logs WHERE status = 'pending' AND
            (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) IN ('new_model', 'benchmark_result')
            OR (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'entity_change' AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.targetKind')) IN ('model', 'result')))`);
        const [conditions] = prepared.length ? [[], []] : await db.execute('SELECT * FROM model_conditions ORDER BY ID');
        const [scores] = prepared.length
            ? await db.execute("SELECT object_ID AS ID FROM score_field_migration_archive WHERE kind = 'score' ORDER BY object_ID")
            : await db.execute('SELECT * FROM benchmark_results ORDER BY ID');
        const [dependents] = await db.execute(`SELECT TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'model_conditions'`);
        if (dependents.some(row => row.TABLE_NAME !== 'benchmark_results' || row.COLUMN_NAME !== 'model_condition_ID')) throw Error('Unexpected references to model_conditions; inspect before migrating');
        const conditionMap = new Map(conditions.map(row => [Number(row.ID), row]));
        const names = new Map();
        for (const condition of conditions) for (const key of Object.keys(parse(condition.parameters) ?? {})) {
            if (!key.trim() || key.length > 80) throw Error('Legacy field name exceeds the new field contract');
            if (fieldNameKey(key) === 'model') throw Error('Reserved field name in existing parameters');
            const normalized = fieldNameKey(key);
            if (names.has(normalized) && names.get(normalized) !== key) throw Error(`Ambiguous legacy field names: ${names.get(normalized)} / ${key}`);
            names.set(normalized, key);
        }
        for (const score of prepared.length ? [] : scores) {
            const condition = conditionMap.get(Number(score.model_condition_ID));
            if (!condition || Number(condition.model_ID) !== Number(score.model_ID)) throw Error(`Invalid condition reference on score ${score.ID}`);
            if (score.status === 'accepted' && !condition.is_active) throw Error(`Accepted score ${score.ID} references a retired condition; resolve before migrating`);
            const parameters = parse(condition.parameters);
            if (parameters !== null && (Array.isArray(parameters) || typeof parameters !== 'object')) throw Error(`Invalid parameters on condition ${condition.ID}`);
            for (const value of Object.values(parameters ?? {})) if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw Error(`Invalid legacy parameter on condition ${condition.ID}`);
        }
        console.log(JSON.stringify({ dryRun: !apply, scores: scores.length, legacyConditions: conditions.length,
            fields: [...names.values()], prepared: Boolean(prepared.length), blockingPendingRequests: pending.map(row => row.ID) }));
        if (apply) {
            if (pending.length) throw Error('Resolve the listed pending model/score requests before migrating. Nothing was changed.');
            await db.query(`CREATE TABLE IF NOT EXISTS score_fields (
                ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(80) NOT NULL, name_key VARCHAR(80) COLLATE utf8mb4_bin NOT NULL UNIQUE,
                field_type ENUM('presence','text','number','enum') NOT NULL,
                allow_empty BOOLEAN NOT NULL DEFAULT 0, exclude_missing BOOLEAN NOT NULL DEFAULT 1,
                exclude_empty BOOLEAN NOT NULL DEFAULT 0, revision INT UNSIGNED NOT NULL DEFAULT 1,
                is_active BOOLEAN NOT NULL DEFAULT 1, created_request_ID BIGINT UNSIGNED NULL,
                INDEX (created_request_ID))`);
            await db.query(`CREATE TABLE IF NOT EXISTS score_field_options (
                ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, field_ID BIGINT UNSIGNED NOT NULL,
                label VARCHAR(160) NOT NULL, label_key VARCHAR(160) COLLATE utf8mb4_bin NOT NULL,
                excluded BOOLEAN NOT NULL DEFAULT 0, revision INT UNSIGNED NOT NULL DEFAULT 1,
                is_active BOOLEAN NOT NULL DEFAULT 1, created_request_ID BIGINT UNSIGNED NULL,
                created_option_index INT UNSIGNED NULL,
                UNIQUE KEY field_label (field_ID, label_key), INDEX (created_request_ID),
                FOREIGN KEY (field_ID) REFERENCES score_fields(ID))`);
            await db.query(`CREATE TABLE IF NOT EXISTS score_field_migration_archive (
                kind VARCHAR(32) NOT NULL, object_ID BIGINT UNSIGNED NOT NULL, snapshot JSON NOT NULL,
                PRIMARY KEY (kind, object_ID))`);
            const [columns] = await db.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'benchmark_results' AND COLUMN_NAME = 'score_fields'");
            if (!columns.length) await db.query('ALTER TABLE benchmark_results ADD COLUMN score_fields JSON NULL');
            if (!prepared.length) {
            await db.beginTransaction();
            const IDs = new Map();
            for (const [key, name] of names) {
                const [insert] = await db.execute("INSERT INTO score_fields (name, name_key, field_type) VALUES (?, ?, 'text')", [name, key]);
                IDs.set(key, Number(insert.insertId));
            }
            for (const condition of conditions) await db.execute("INSERT INTO score_field_migration_archive (kind, object_ID, snapshot) VALUES ('condition', ?, ?)", [condition.ID, JSON.stringify(condition)]);
            for (const score of scores) {
                await db.execute("INSERT INTO score_field_migration_archive (kind, object_ID, snapshot) VALUES ('score', ?, ?)", [score.ID, JSON.stringify(score)]);
                const parameters = parse(conditionMap.get(Number(score.model_condition_ID)).parameters);
                const assignments = Object.entries(parameters ?? {}).map(([key, value]) => ({ fieldID: IDs.get(fieldNameKey(key)), value: String(value) })).sort((a, b) => a.fieldID - b.fieldID);
                await db.execute('UPDATE benchmark_results SET score_fields = ? WHERE ID = ?', [JSON.stringify(assignments), score.ID]);
            }
            const [[counts]] = await db.execute('SELECT COUNT(*) AS n, SUM(score_fields IS NULL) AS missing FROM benchmark_results');
            if (Number(counts.n) !== scores.length || Number(counts.missing)) throw Error('Score migration verification failed');
            await db.execute("INSERT INTO schema_migrations (migration_id) VALUES ('029_score_fields_prepared')");
            await db.commit();
            }
            // DDL auto-commits. Keep the archive and make every cleanup step restartable.
            const [foreignKeys] = await db.execute(`SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'benchmark_results' AND COLUMN_NAME = 'model_condition_ID' AND REFERENCED_TABLE_NAME IS NOT NULL`);
            for (const row of foreignKeys) await db.query(`ALTER TABLE benchmark_results DROP FOREIGN KEY ${mysql.escapeId(row.CONSTRAINT_NAME)}`);
            const [[verification]] = await db.execute(`SELECT COUNT(*) AS n, SUM(score_fields IS NULL) AS missing FROM benchmark_results`);
            if (Number(verification.n) !== scores.length || Number(verification.missing)) throw Error('Prepared migration changed; stop writes before resuming');
            const [oldColumns] = await db.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'benchmark_results' AND COLUMN_NAME IN ('model_condition_ID', 'model_condition_snapshot')");
            const drops = oldColumns.map(row => `DROP COLUMN ${mysql.escapeId(row.COLUMN_NAME)}`);
            await db.query(`ALTER TABLE benchmark_results MODIFY score_fields JSON NOT NULL${drops.length ? ', ' + drops.join(', ') : ''}`);
            await db.query('DROP TABLE IF EXISTS model_conditions');
            await db.execute("INSERT INTO schema_migrations (migration_id) VALUES ('029_score_fields')");
            console.log(JSON.stringify({ applied: true, scoresPreserved: scores.length, archivePreserved: true }));
        }
    }
} catch (error) {
    await db.rollback(); console.error(error.message); process.exitCode = 1;
} finally {
    await db.execute("SELECT RELEASE_LOCK('benchpoll_score_fields')"); await db.end();
}
