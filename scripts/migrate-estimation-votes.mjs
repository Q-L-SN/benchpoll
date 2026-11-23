import { pathToFileURL } from 'node:url';

async function inspectEstimationVotes(connection) {
    const [[column]] = await connection.execute(`SELECT DATA_TYPE AS type, IS_NULLABLE AS nullable,
        COLUMN_DEFAULT AS defaultValue FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'personal_pies' AND COLUMN_NAME = 'estimation_votes'`);
    if (column && (column.type !== 'json' || column.nullable !== 'YES' || column.defaultValue !== null)) {
        throw new Error('Unexpected personal_pies.estimation_votes definition');
    }
    return { missing: !column };
}

export async function migrateEstimationVotes(connection, { apply = false } = {}) {
    if (!apply) return { applied: false, ...await inspectEstimationVotes(connection) };
    const lock = 'benchpoll_estimation_votes';
    const [[row]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
    if (Number(row?.acquired) !== 1) throw new Error('Estimation votes migration is busy');
    try {
        const { missing } = await inspectEstimationVotes(connection);
        if (missing) await connection.execute(`ALTER TABLE personal_pies
            ADD COLUMN estimation_votes JSON NULL, ALGORITHM=INSTANT`);
        return { applied: true, changed: missing, ...await inspectEstimationVotes(connection) };
    } finally {
        await connection.execute('SELECT RELEASE_LOCK(?)', [lock]);
    }
}

async function main(args = process.argv.slice(2)) {
    if (args.some(arg => arg !== '--apply')) throw new Error('Unknown estimation votes migration flag');
    if (!args.includes('--apply')) {
        console.log(JSON.stringify({ add: ['personal_pies.estimation_votes'], businessRowsChanged: 0 }));
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
