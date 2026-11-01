import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';

const connection = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root',
    database: 'benchmarks', supportBigNumbers: true, bigNumberStrings: true });
try {
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const [weights] = await connection.query('SELECT pie_ID, benchmark_condition_ID, weight_basis_points FROM personal_pie_weights ORDER BY pie_ID, benchmark_condition_ID');
    const [pies] = await connection.query('SELECT ID, user_ID, context_ID, created_at, updated_at FROM personal_pies ORDER BY ID');
    const [[counts]] = await connection.query(`SELECT (SELECT COUNT(*) FROM personal_pie_score_rules) AS choices,
        (SELECT COUNT(*) FROM benchmark_families) AS chains, (SELECT COUNT(*) FROM benchmark_family_members) AS chainMembers,
        (SELECT COUNT(*) FROM schema_migrations WHERE migration_id='community_fallback_20261030') AS migrated`);
    console.log(JSON.stringify({ ...counts, weightCount: weights.length, pieCount: pies.length,
        protectedHash: createHash('sha256').update(JSON.stringify([pies, weights])).digest('hex') }));
    await connection.commit();
} finally { await connection.end(); }
