import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const migration = '024_score_providers';
const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
if (password === undefined) throw new Error('Database credentials are required.');
const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root',
    password, database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
const has = async (table, column = null) => {
    const [rows] = await connection.execute(column
        ? 'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        : 'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', column ? [table, column] : [table]);
    return rows.length > 0;
};
function upgradeContent(content) {
    const upgradeSource = result => {
        if (!result?.source) throw new Error('Missing historical source; migration stopped.');
        result.source.providerID = null;
        result.source.providerRef = null;
    };
    if (content.schemaVersion !== 6) return false;
    if (content.type === 'benchmark_result') content.results.forEach(upgradeSource);
    else if (content.type === 'entity_change' && content.targetKind === 'result') {
        upgradeSource(content.before.result);
        if (content.operation === 'update') upgradeSource(content.after.result);
        if (content.operation === 'merge') upgradeSource(content.after.destinationBefore.result);
    } else return false;
    content.schemaVersion = 7;
    return true;
}
try {
    const [locks] = await connection.execute("SELECT GET_LOCK('benchpoll_score_providers', 10) AS acquired");
    if (Number(locks[0].acquired) !== 1) throw new Error('Migration is already running.');
    if (!apply) {
        const [counts] = await connection.execute('SELECT COUNT(*) AS historicalScores FROM benchmark_results');
        console.log(JSON.stringify({ dryRun: true, ...counts[0], organizationsExist: await has('organizations') }));
    } else {
        const [retired] = await connection.execute("SELECT 1 FROM schema_migrations WHERE migration_id = '025_remove_score_providers'");
        if (retired.length) throw new Error('Score providers have been retired; this historical migration cannot be reapplied.');
        if (await has('vendors')) {
            if (await has('organizations')) throw new Error('Both identity tables exist; manual inspection required.');
            await connection.query('RENAME TABLE vendors TO organizations');
        }
        if (!await has('organizations', 'is_model_vendor')) {
            await connection.query(`ALTER TABLE organizations
                ADD COLUMN is_model_vendor TINYINT(1) NOT NULL DEFAULT 0,
                ADD COLUMN is_score_provider TINYINT(1) NOT NULL DEFAULT 0,
                ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1,
                ADD COLUMN introduction_url VARCHAR(2048) NULL`);
            await connection.execute('UPDATE organizations SET is_model_vendor = 1, is_score_provider = 1');
        }
        const [foreignKeys] = await connection.execute(`SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'models' AND REFERENCED_TABLE_NAME = 'organizations' AND DELETE_RULE <> 'RESTRICT'`);
        for (const key of foreignKeys) {
            await connection.query(`ALTER TABLE models DROP FOREIGN KEY ${mysql.escapeId(key.CONSTRAINT_NAME)},
                ADD CONSTRAINT fk_models_organization FOREIGN KEY (vendor_ID) REFERENCES organizations(ID) ON DELETE RESTRICT`);
        }
        if (!await has('benchmark_results', 'provider_organization_ID')) {
            await connection.query(`ALTER TABLE benchmark_results ADD COLUMN provider_organization_ID INT UNSIGNED NULL,
                ADD CONSTRAINT fk_results_provider FOREIGN KEY (provider_organization_ID) REFERENCES organizations(ID) ON DELETE RESTRICT`);
        }
        await connection.beginTransaction();
        const [logs] = await connection.execute('SELECT ID, content FROM moderation_logs FOR UPDATE');
        let upgradedLogs = 0;
        for (const row of logs) {
            const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
            if (upgradeContent(content)) {
                await connection.execute('UPDATE moderation_logs SET content = ? WHERE ID = ?', [JSON.stringify(content), row.ID]);
                upgradedLogs++;
            }
        }
        await connection.execute('INSERT INTO schema_migrations (migration_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_id = ?)', [migration, migration]);
        await connection.commit();
        console.log(JSON.stringify({ applied: true, upgradedLogs, historicalProviders: 'unattributed; not inferred' }));
    }
} catch (error) {
    await connection.rollback();
    console.error(JSON.stringify({ error: error.code || error.message }));
    process.exitCode = 1;
} finally {
    await connection.execute("SELECT RELEASE_LOCK('benchpoll_score_providers')");
    await connection.end();
}
