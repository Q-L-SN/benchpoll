import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { ensureBenchmarkFamily, loadBenchmarkFamilies } from '../benchmark-family-service.js';

export const MIGRATION_ID = '050_ordered_benchmark_families';

export function convertWeightedRules(rules, components, { allowWeightedConversion = false } = {}) {
    const used = new Set();
    const converted = rules.map(rule => {
        const members = components.filter(member => member.pie_ID === rule.pie_ID
            && member.primary_benchmark_condition_ID === rule.primary_benchmark_condition_ID)
            .sort((a, b) => Number(b.weight_basis_points) - Number(a.weight_basis_points)
                || Number(a.fallback_benchmark_condition_ID) - Number(b.fallback_benchmark_condition_ID));
        if (rule.mode !== 'fallback_if_missing' || !members.length
            || members.some(member => !Number.isInteger(Number(member.weight_basis_points)) || Number(member.weight_basis_points) <= 0)
            || members.reduce((sum, member) => sum + Number(member.weight_basis_points), 0) !== 10000) {
            throw new Error('Invalid legacy fallback; migration stopped.');
        }
        if (members.length !== 1 && !allowWeightedConversion) throw new Error('Multi-member weighted fallback needs an explicit conversion decision.');
        members.forEach(member => used.add(member));
        return { ...rule, entries: members.map(member => ({ conditionID: Number(member.fallback_benchmark_condition_ID) })) };
    });
    if (used.size !== components.length) throw new Error('Unattached legacy fallback components; migration stopped.');
    return converted;
}

export async function migrateOrderedFamilies(connection, { apply = false, backupDirectory, allowWeightedConversion = false } = {}) {
    const [marks] = await connection.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [MIGRATION_ID]);
    if (marks.length) {
        const families = await loadBenchmarkFamilies(connection);
        const [oldColumns] = await connection.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_pie_score_rules' AND COLUMN_NAME = 'mode'`);
        const [oldTables] = await connection.query(`SELECT TABLE_NAME FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_pie_score_rule_components'`);
        if (oldColumns.length || oldTables.length) throw new Error('Ordered-family migration marker does not match the schema.');
        return { alreadyApplied: true, familyCount: families.length };
    }
    const [partial] = await connection.query(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('benchmark_families','benchmark_family_members','ordered_personal_pie_score_rules','legacy_weighted_pie_score_rules')`);
    if (partial.length) throw new Error('Unmarked partial family migration; restore the pre-migration backup before retrying.');
    const [rules] = await connection.query('SELECT * FROM personal_pie_score_rules ORDER BY pie_ID,primary_benchmark_condition_ID');
    const [components] = await connection.query('SELECT * FROM personal_pie_score_rule_components ORDER BY pie_ID,primary_benchmark_condition_ID,fallback_benchmark_condition_ID');
    const converted = convertWeightedRules(rules, components, { allowWeightedConversion });
    if (!apply) return { dryRun: true, rules: rules.length, components: components.length,
        chains: converted.map(rule => ({ pieID: rule.pie_ID, primaryConditionID: rule.primary_benchmark_condition_ID, entries: rule.entries })) };
    if (!backupDirectory) throw new Error('A backup directory is required. Stop application writes before applying this migration.');
    const backup = { migration: MIGRATION_ID, capturedAt: new Date().toISOString(), rules, components, schemas: {} };
    for (const table of ['personal_pie_score_rules', 'personal_pie_score_rule_components']) {
        const [rows] = await connection.query(`SHOW CREATE TABLE ${table}`);
        backup.schemas[table] = rows[0]['Create Table'];
    }
    fs.mkdirSync(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory, 'weighted-fallback-before.json');
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
    if (JSON.parse(fs.readFileSync(backupPath, 'utf8')).components.length !== components.length) throw new Error('Backup verification failed');
    await connection.query(`CREATE TABLE benchmark_families (
        ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        primary_benchmark_condition_ID BIGINT UNSIGNED NOT NULL,
        chain_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ID), UNIQUE KEY uq_family_chain (chain_hash),
        UNIQUE KEY uq_family_entrance (ID,primary_benchmark_condition_ID),
        CONSTRAINT fk_family_primary FOREIGN KEY (primary_benchmark_condition_ID) REFERENCES benchmark_conditions(ID) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`CREATE TABLE benchmark_family_members (
        family_ID BIGINT UNSIGNED NOT NULL, position INT UNSIGNED NOT NULL, benchmark_condition_ID BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (family_ID,position), UNIQUE KEY uq_family_member (family_ID,benchmark_condition_ID),
        CONSTRAINT fk_family_member_family FOREIGN KEY (family_ID) REFERENCES benchmark_families(ID) ON DELETE CASCADE,
        CONSTRAINT fk_family_member_condition FOREIGN KEY (benchmark_condition_ID) REFERENCES benchmark_conditions(ID) ON DELETE RESTRICT,
        CONSTRAINT chk_family_position CHECK (position > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`CREATE TABLE ordered_personal_pie_score_rules (
        pie_ID BIGINT UNSIGNED NOT NULL, primary_benchmark_condition_ID BIGINT UNSIGNED NOT NULL, family_ID BIGINT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (pie_ID,primary_benchmark_condition_ID),
        CONSTRAINT fk_ordered_rule_weight FOREIGN KEY (pie_ID,primary_benchmark_condition_ID)
            REFERENCES personal_pie_weights(pie_ID,benchmark_condition_ID) ON DELETE CASCADE,
        CONSTRAINT fk_ordered_rule_family FOREIGN KEY (family_ID,primary_benchmark_condition_ID)
            REFERENCES benchmark_families(ID,primary_benchmark_condition_ID) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.beginTransaction();
    try {
        for (const rule of converted) {
            const familyID = await ensureBenchmarkFamily(connection, Number(rule.primary_benchmark_condition_ID), rule.entries);
            await connection.execute(`INSERT INTO ordered_personal_pie_score_rules
                (pie_ID,primary_benchmark_condition_ID,family_ID,created_at,updated_at) VALUES (?,?,?,?,?)`,
            [rule.pie_ID,rule.primary_benchmark_condition_ID,familyID,rule.created_at,rule.updated_at]);
        }
        const [[count]] = await connection.query('SELECT COUNT(*) count FROM ordered_personal_pie_score_rules');
        if (Number(count.count) !== rules.length) throw new Error('Family associations changed during migration');
        await loadBenchmarkFamilies(connection);
        await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    await connection.query(`RENAME TABLE personal_pie_score_rules TO legacy_weighted_pie_score_rules,
        ordered_personal_pie_score_rules TO personal_pie_score_rules`);
    await connection.query('DROP TABLE personal_pie_score_rule_components');
    await connection.query('DROP TABLE legacy_weighted_pie_score_rules');
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, convertedRules: rules.length, familyCount: (await loadBenchmarkFamilies(connection)).length, backupPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const connection = await mysql.createConnection({
        socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined, host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4'
    });
    try {
        const [[lock]] = await connection.query("SELECT GET_LOCK('benchpoll_ordered_families',30) acquired");
        if (Number(lock.acquired) !== 1) throw new Error('Family migration lock unavailable');
        try { console.log(JSON.stringify(await migrateOrderedFamilies(connection, {
            apply: process.argv.includes('--apply'), backupDirectory: process.env.BENCHPOLL_FAMILY_BACKUP_DIR,
            allowWeightedConversion: process.argv.includes('--convert-by-weight')
        }), null, 2)); } finally { await connection.query("SELECT RELEASE_LOCK('benchpoll_ordered_families')"); }
    } finally { await connection.end(); }
}
