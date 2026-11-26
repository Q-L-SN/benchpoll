import { pathToFileURL } from 'node:url';

const migration = 'global_estimation_pairs_20261126';

async function inspectEstimationVotes(connection) {
    const [applied] = await connection.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migration]);
    return { missing: !applied.length };
}

export async function migrateEstimationVotes(connection, { apply = false } = {}) {
    if (!apply) return { applied: false, ...await inspectEstimationVotes(connection) };
    const [[row]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [migration]);
    if (Number(row?.acquired) !== 1) throw new Error('Estimation votes migration is busy');
    try {
        if (!(await inspectEstimationVotes(connection)).missing) return { applied: true, changed: false, missing: false };
        await connection.execute(`CREATE TABLE IF NOT EXISTS estimation_pair_votes (
            user_ID BIGINT UNSIGNED NOT NULL, first_ID BIGINT UNSIGNED NOT NULL, second_ID BIGINT UNSIGNED NOT NULL,
            vote ENUM('support','oppose') NOT NULL, updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            PRIMARY KEY (user_ID, first_ID, second_ID), INDEX recent_pair (first_ID, second_ID, updated_at DESC, user_ID),
            CHECK (first_ID < second_ID), FOREIGN KEY (user_ID) REFERENCES users(ID) ON DELETE CASCADE,
            FOREIGN KEY (first_ID) REFERENCES benchmark_conditions(ID), FOREIGN KEY (second_ID) REFERENCES benchmark_conditions(ID)
        ) ENGINE=InnoDB`);
        const [old] = await connection.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'personal_pies' AND COLUMN_NAME = 'estimation_votes'`);
        await connection.beginTransaction();
        try {
            if (old.length) {
                // A user's most recent explicit position wins. Simultaneous contradictory positions abstain.
                await connection.execute(`INSERT INTO estimation_pair_votes (user_ID, first_ID, second_ID, vote, updated_at)
                    WITH positions AS (
                        SELECT p.user_ID, LEAST(v.a,v.b) AS lo, GREATEST(v.a,v.b) AS hi, v.choice, p.updated_at,
                            DENSE_RANK() OVER (PARTITION BY p.user_ID, LEAST(v.a,v.b), GREATEST(v.a,v.b) ORDER BY p.updated_at DESC) AS recency
                        FROM personal_pies p JOIN JSON_TABLE(IFNULL(p.estimation_votes,JSON_ARRAY()), '$[*]' COLUMNS (
                            a BIGINT PATH '$.targetConditionID', b BIGINT PATH '$.sourceConditionID', choice VARCHAR(16) PATH '$.vote'
                        )) v ON TRUE
                        JOIN benchmark_conditions a ON a.ID=v.a AND a.deleted_at IS NULL
                        JOIN benchmark_conditions b ON b.ID=v.b AND b.deleted_at IS NULL AND b.benchmark_ID=a.benchmark_ID
                        WHERE v.a<>v.b AND v.choice IN ('support','oppose')
                    ) SELECT user_ID, lo, hi, MIN(choice), MAX(updated_at) FROM positions WHERE recency=1
                    GROUP BY user_ID, lo, hi HAVING COUNT(DISTINCT choice)=1`);
            }
            await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [migration]);
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        return { applied: true, changed: true, missing: false };
    } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [migration]); }
}
async function main(args = process.argv.slice(2)) {
    if (args.some(arg => arg !== '--apply')) throw new Error('Unknown estimation votes migration flag');
    if (!args.includes('--apply')) {
        console.log(JSON.stringify({ add: ['estimation_pair_votes'], import: 'one ballot per account and unordered pair' }));
        return;
    }
    const database = process.env.BENCHPOLL_MIGRATION_DATABASE;
    if (!database) throw new Error('Set BENCHPOLL_MIGRATION_DATABASE explicitly');
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_MIGRATION_HOST ?? '127.0.0.1',
        port: Number(process.env.BENCHPOLL_MIGRATION_PORT ?? 3306), database,
        user: process.env.BENCHPOLL_MIGRATION_USER, password: process.env.BENCHPOLL_MIGRATION_PASSWORD });
    try { console.log(JSON.stringify(await migrateEstimationVotes(connection, { apply: true }))); }
    finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
