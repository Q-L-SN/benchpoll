import { databaseOperationError, runDatabaseOperation, releaseTransactionConnection,
    destroyTransactionConnection } from './db-transaction.js';

const defaults = { acquireTimeoutMs: 5000, queryTimeoutMs: 30000, pendingLimit: 100 };

function positiveInteger(value, fallback, maximum) {
    const parsed = value === undefined || value === '' ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error('Invalid database deadline configuration');
    return parsed;
}

export function databaseDeadlineOptions(env = process.env) {
    return {
        acquireTimeoutMs: positiveInteger(env.BENCHPOLL_DB_ACQUIRE_TIMEOUT_MS, defaults.acquireTimeoutMs, 600000),
        queryTimeoutMs: positiveInteger(env.BENCHPOLL_DB_QUERY_TIMEOUT_MS, defaults.queryTimeoutMs, 600000),
        pendingLimit: positiveInteger(env.BENCHPOLL_DB_PENDING_LIMIT, defaults.pendingLimit, 1000)
    };
}

function busyError() {
    return Object.assign(new Error('database_busy'), { code: 'DATABASE_ACQUIRE_TIMEOUT', status: 503,
        body: { error: 'database_busy', retryable: true } });
}

function deadlineConnection(connection, { queryTimeoutMs }) {
    let closed = false, pending = 0, lease;
    const methods = {};
    const destroy = () => {
        if (closed) return;
        closed = true;
        destroyTransactionConnection(connection, 'database lease');
    };
    for (const method of ['query', 'execute', 'beginTransaction', 'commit', 'rollback']) {
        methods[method] = async (...args) => {
            if (closed) throw databaseOperationError('DATABASE_CONNECTION_DISCARDED');
            pending++;
            try {
                return await runDatabaseOperation(lease, `database ${method}`, () => {
                    if (closed) throw databaseOperationError('DATABASE_CONNECTION_DISCARDED');
                    return connection[method](...args);
                },
                    ['query', 'execute'].includes(method) ? queryTimeoutMs : 5000);
            } finally { pending--; }
        };
    }
    methods.destroy = destroy;
    methods.release = () => {
        if (closed) return;
        if (pending) return destroy();
        closed = true;
        releaseTransactionConnection(connection, 'database lease');
    };
    lease = new Proxy(connection, { get(target, property) {
        if (Object.hasOwn(methods, property)) return methods[property];
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' && !['constructor', 'Promise'].includes(property) ? value.bind(target) : value;
    } });
    return lease;
}

export function createDeadlinePool(pool, options = {}) {
    const configuration = {
        acquireTimeoutMs: positiveInteger(options.acquireTimeoutMs, defaults.acquireTimeoutMs, 600000),
        queryTimeoutMs: positiveInteger(options.queryTimeoutMs, defaults.queryTimeoutMs, 600000),
        pendingLimit: positiveInteger(options.pendingLimit, defaults.pendingLimit, 1000)
    };
    let pendingAcquisitions = 0;
    const getConnection = () => {
        if (pendingAcquisitions >= configuration.pendingLimit) return Promise.reject(busyError());
        pendingAcquisitions++;
        return new Promise((resolve, reject) => {
            let expired = false;
            const timer = setTimeout(() => { expired = true; reject(busyError()); }, configuration.acquireTimeoutMs);
            // A timed-out mysql2 acquisition still owns a queued callback until it settles.
            Promise.resolve().then(() => pool.getConnection()).then(connection => {
                pendingAcquisitions--; clearTimeout(timer);
                if (expired) releaseTransactionConnection(connection, 'expired database acquisition');
                else resolve(deadlineConnection(connection, configuration));
            }, error => { pendingAcquisitions--; clearTimeout(timer); reject(error); });
        });
    };
    const methods = { getConnection };
    for (const method of ['query', 'execute']) methods[method] = async (...args) => {
        const connection = await getConnection();
        try { return await connection[method](...args); }
        catch (error) {
            // Match mysql2's automatic pool policy after a server read-only/failover error.
            if ([1792, 1290, 1836].includes(error?.errno)) connection.destroy();
            throw error;
        }
        finally { connection.release(); }
    };
    return new Proxy(pool, { get(target, property) {
        if (Object.hasOwn(methods, property)) return methods[property];
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' && !['constructor', 'Promise'].includes(property) ? value.bind(target) : value;
    } });
}
