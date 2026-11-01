import { pathToFileURL } from 'node:url';

export const migrationID = 'write_request_replay_20261008';
export const writeRequestsDDL = `CREATE TABLE IF NOT EXISTS write_requests (
    actor_user_ID BIGINT UNSIGNED NOT NULL,
    request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    owner_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    response_status SMALLINT UNSIGNED NULL,
    response_body JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (actor_user_ID, request_key),
    CONSTRAINT fk_write_requests_actor FOREIGN KEY (actor_user_ID) REFERENCES users (ID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export async function verifyWriteRequestSchema(connection) {
    const [[table]] = await connection.execute(`SELECT ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'write_requests'`);
    if (String(table?.engine).toLowerCase() !== 'innodb') throw new Error('Write requests require InnoDB.');
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type,
        IS_NULLABLE AS nullable, COLLATION_NAME AS collation FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'write_requests'`);
    const expected = new Map([
        ['actor_user_ID', ['bigint unsigned', false]], ['request_key', ['char(36)', false, 'ascii_bin']],
        ['action', ['varchar(64)', false, 'ascii_bin']], ['payload_hash', ['char(64)', false, 'ascii_bin']],
        ['owner_token', ['char(36)', false, 'ascii_bin']], ['response_status', ['smallint unsigned', true]],
        ['response_body', ['json', true]], ['created_at', ['datetime(3)', false]]
    ]);
    for (const [name, [type, nullable, collation]] of expected) {
        const column = columns.find(item => item.name === name);
        if (column?.type !== type || (column.nullable === 'YES') !== nullable
            || (collation && column.collation !== collation)) throw new Error(`Invalid write request column: ${name}`);
    }
    const [indexes] = await connection.execute(`SELECT INDEX_NAME AS name, COLUMN_NAME AS columnName,
        SEQ_IN_INDEX AS position FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'write_requests' ORDER BY INDEX_NAME, SEQ_IN_INDEX`);
    const primary = indexes.filter(index => index.name === 'PRIMARY').map(index => index.columnName);
    if (primary.join(',') !== 'actor_user_ID,request_key') throw new Error('Write request uniqueness is not actor-scoped.');
    const [keys] = await connection.execute(`SELECT kcu.COLUMN_NAME AS columnName,
        kcu.REFERENCED_TABLE_NAME AS targetTable, kcu.REFERENCED_COLUMN_NAME AS targetColumn,
        rc.DELETE_RULE AS deletion FROM information_schema.KEY_COLUMN_USAGE kcu
        JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
          ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = 'write_requests'`);
    if (!keys.some(key => key.columnName === 'actor_user_ID' && key.targetTable === 'users'
        && key.targetColumn === 'ID' && key.deletion === 'CASCADE')) throw new Error('Write request actor cleanup is missing.');
}

export async function ensureWriteRequestSchema(connection) {
    await connection.query(writeRequestsDDL);
    await verifyWriteRequestSchema(connection);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!process.argv.includes('--apply')) {
        console.log(JSON.stringify({ migration: migrationID, dryRun: true,
            creates: ['write_requests'], destructiveChanges: false }));
    } else {
        const { config } = await import('dotenv');
        config({ quiet: true });
        const { default: mysql } = await import('mysql2/promise');
        const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
            host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
            user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
            database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
        let locked = false;
        try {
            const [[lock]] = await connection.query('SELECT GET_LOCK(?, 20) AS acquired', ['benchpoll_write_requests_migration']);
            if (Number(lock.acquired) !== 1) throw new Error('Write request migration lock unavailable.');
            locked = true;
            await ensureWriteRequestSchema(connection);
            await connection.execute('INSERT IGNORE INTO schema_migrations (migration_id) VALUES (?)', [migrationID]);
            console.log(JSON.stringify({ migration: migrationID, verified: true, destructiveChanges: false }));
        } finally {
            if (locked) await connection.query('SELECT RELEASE_LOCK(?)', ['benchpoll_write_requests_migration']);
            await connection.end();
        }
    }
}
