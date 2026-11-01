import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = '/home/ubuntu/benchpoll';
const moduleURL = path => pathToFileURL(`${root}/${path}`).href;
const dotenv = await import(moduleURL('node_modules/dotenv/lib/main.js'));
dotenv.config({ path: `${root}/.env`, quiet: true });
const { default: mysql } = await import(moduleURL('node_modules/mysql2/index.js'));
// This pool is separate from the running service and never queries permanent application tables.
const pool = mysql.createPool({
    socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', waitForConnections: true,
    connectionLimit: 1, queueLimit: 0
}).promise();
const server = await readFile(`${root}/server.js`, 'utf8');
const transactionCleanup = server.includes("from './db-transaction.js'") ? await import(moduleURL('db-transaction.js')) : {};
const helpers = server.slice(server.indexOf('function directMutationAuditError('),
    server.indexOf("API.post('/send_admin_message'"));
assert.ok(helpers.includes('connection: auditConnection'), 'Installed helper must accept the caller-owned rolled-back connection');
const statements = [], logs = [];
const context = vm.createContext({
    ...transactionCleanup,
    db: { getConnection() { throw new Error('Failure audit must not borrow a nested connection'); } },
    structuredClone, console: { error: (...values) => logs.push(values.map(String).join(' ')) },
    createModerationAuditRecorder: () => ({ statements: [], elapsedMs: () => 0 }),
    insertModerationAuditLog: async (connection, _recorder, details) => {
        assert.equal(details.outcome, 'failure');
        await connection.execute("INSERT INTO benchpoll_failure_audit_probe (kind) VALUES ('audit')");
        statements.push('audit inserted');
        if (details.error.message === 'Synthetic audit failure') throw new Error('Synthetic audit insert failure');
    }
});
vm.runInContext(helpers, context);
const results = [];
try {
    for (const failAudit of [false, true]) for (let repetition = 1; repetition <= 2; repetition++) {
        const connection = await pool.getConnection();
        let timer;
        try {
            await connection.execute('CREATE TEMPORARY TABLE benchpoll_failure_audit_probe (kind VARCHAR(32) NOT NULL) ENGINE=InnoDB');
            await connection.beginTransaction();
            await connection.execute("INSERT INTO benchpoll_failure_audit_probe (kind) VALUES ('business')");
            assert.equal(await context.rollbackModerationConnection(connection, 'ISOLATED REVIEW'), true);
            const task = context.persistFailedModerationAction({ connection, reviewerUserID: '1', actionType: 'approve',
                requestBefore: { content: { type: 'feedback' } }, error: new Error(failAudit ? 'Synthetic audit failure' : 'Synthetic business failure') });
            await Promise.race([task, new Promise((_resolve, reject) => {
                timer = setTimeout(() => { connection.destroy(); reject(new Error('Isolated failure audit exceeded 5 seconds')); }, 5000);
            })]);
            clearTimeout(timer);
            const [rows] = await connection.execute('SELECT kind, COUNT(*) AS total FROM benchpoll_failure_audit_probe GROUP BY kind');
            const counts = Object.fromEntries(rows.map(row => [row.kind, Number(row.total)]));
            assert.equal(counts.business ?? 0, 0, 'Business work remains rolled back');
            assert.equal(counts.audit ?? 0, failAudit ? 0 : 1,
                'Failure audit is independently committed or independently rolled back');
            assert.equal((await connection.execute('SELECT 1 AS usable'))[0][0].usable, 1);
            results.push({ failAudit, repetition, counts, connectionUsable: true, passed: true });
        } finally {
            clearTimeout(timer);
            await connection.execute('DROP TEMPORARY TABLE IF EXISTS benchpoll_failure_audit_probe').catch(() => {});
            connection.release();
        }
    }
    console.log(JSON.stringify({ passed: results.length, total: results.length, results,
        helperSource: 'Installed production server.js', actualDriverAndTransactions: true,
        privatePoolLimit: 1, temporaryTablesOnly: true, permanentApplicationTablesRead: false,
        permanentApplicationTablesWritten: false, realModerationHandlersInvoked: false,
        auditErrorLogs: logs, auditInsertAttempts: statements.length }));
} finally { await pool.end(); }
