import 'dotenv/config';
import mysql from 'mysql2/promise';
import { registerScoreSync, TRUSTED_SCORE_SOURCES } from '../score-sync-service.js';
import { destroyTransactionConnection, isTransactionConnectionDiscarded } from '../db-transaction.js';

async function endRegistrationConnection(connection) {
    if (isTransactionConnectionDiscarded(connection)) return;
    let timer;
    try {
        await Promise.race([
            connection.end(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error('registration_end_timeout'), {
                    code: 'END_TIMEOUT'
                })), 5000);
            })
        ]);
    } catch (error) {
        try { console.error('[Score sync registration CLI] end failed', error?.code ?? 'UNKNOWN'); }
        catch { /* Cleanup logging must not replace the registration result or error. */ }
        destroyTransactionConnection(connection, 'Score sync registration CLI');
    } finally { clearTimeout(timer); }
}

if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Score-source registration requires the server operator (root)');
const argument = name => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
};
const sourceKey = argument('--source');
const intervalSeconds = Number(argument('--interval') ?? TRUSTED_SCORE_SOURCES[sourceKey]?.intervalSeconds);
const connection = await mysql.createConnection({
    socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4', timezone: 'Z'
});
try {
    console.log(JSON.stringify(await registerScoreSync(connection, {
        sourceKey, intervalSeconds, operator: argument('--operator'), enabled: !process.argv.includes('--disable')
    })));
} finally { await endRegistrationConnection(connection); }
