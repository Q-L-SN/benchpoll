import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const [rootArgument, outputArgument] = process.argv.slice(2);
if (!rootArgument || !outputArgument) throw new Error('Usage: node export-schema.mjs <application-root> <new-output.sql>');
const root = resolve(rootArgument), output = resolve(outputArgument);
const { config } = await import(pathToFileURL(join(root, 'node_modules/dotenv/lib/main.js')));
const { default: mysql } = await import(pathToFileURL(join(root, 'node_modules/mysql2/promise.js')));
config({ path: join(root, '.env'), quiet: true });
const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks' });
try {
    const [objects] = await db.query(`SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`);
    const [[extra]] = await db.query(`SELECT
        (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()) AS routines,
        (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()) AS triggers,
        (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()) AS events`);
    const temporary = await mkdtemp(join(tmpdir(), 'benchpoll-schema-'));
    let schema;
    try {
        const configFile = join(temporary, 'mysql.cnf');
        const values = { host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: process.env.BENCHPOLL_DB_PORT || '3306',
            user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
            ...(process.env.BENCHPOLL_DB_SOCKET ? { socket: process.env.BENCHPOLL_DB_SOCKET } : {}) };
        await writeFile(configFile, '[client]\n' + Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n',
            { flag: 'wx', mode: 0o600 });
        schema = execFileSync('mysqldump', [`--defaults-extra-file=${configFile}`, '--no-data', '--routines', '--triggers', '--events',
            '--skip-add-drop-table', '--skip-comments', '--single-transaction', '--no-tablespaces', '--set-gtid-purged=OFF',
            '--column-statistics=0', '--default-character-set=utf8mb4', process.env.BENCHPOLL_DB_NAME || 'benchmarks'],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } finally { await rm(temporary, { recursive: true, force: true }); }
    const header = ['-- BenchPoll schema only. No production rows or credentials.',
        '-- Import ONLY into a NEW EMPTY development database, never production.',
        '-- Includes views, stored routines and triggers. Review DEFINER privileges before importing.',
        `-- Exported ${new Date().toISOString()}`, ''].join('\n');
    await writeFile(output, header + schema.replace(/ AUTO_INCREMENT=\d+/g, ''), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ tables: objects.filter(row => row.type === 'BASE TABLE').length,
        views: objects.filter(row => row.type === 'VIEW').length, productionRowsExported: 0,
        bytes: (await readFile(output)).length, ...extra }));
} finally { await db.end(); }
