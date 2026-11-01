import mysql from 'mysql2/promise';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function migrateDynamicFamilies(connection) {
    const [[column]] = await connection.execute(`SELECT IS_NULLABLE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'benchmark_family_members' AND COLUMN_NAME = 'benchmark_condition_ID'`);
    if (!column) throw new Error('Ordered benchmark family schema is missing');
    if (column.IS_NULLABLE === 'YES') return { applied: false };
    await connection.query(`ALTER TABLE benchmark_family_members MODIFY benchmark_condition_ID BIGINT UNSIGNED NULL
        COMMENT 'NULL represents an automatic group of other versions of the preceding benchmark'`);
    return { applied: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', user: process.env.BENCHPOLL_DB_USER || 'root',
        password: process.env.BENCHPOLL_DB_PASSWORD, database: process.env.BENCHPOLL_DB_NAME || 'benchmarks' });
    try { console.log(JSON.stringify(await migrateDynamicFamilies(connection))); }
    finally { await connection.end(); }
}
