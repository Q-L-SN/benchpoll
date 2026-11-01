const discardedConnections = new WeakSet();
const ROLLBACK_TIMEOUT_MS = 5000;
const TRANSACTION_TIMEOUT_MS = 5000;

export function databaseOperationError(code = 'DATABASE_OPERATION_TIMEOUT') {
    return Object.assign(new Error(code.toLowerCase()), { code, fatal: true, status: 503,
        body: { error: 'database_operation_timeout', outcomeUnknown: true } });
}

export async function runDatabaseOperation(connection, label, operation, timeoutMs = 30000) {
    if (isTransactionConnectionDiscarded(connection)) throw databaseOperationError('DATABASE_CONNECTION_DISCARDED');
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(databaseOperationError()), timeoutMs);
            })
        ]);
    } catch (error) {
        if (error?.fatal || error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') destroyTransactionConnection(connection, label);
        throw error;
    } finally { clearTimeout(timer); }
}

function logCleanup(label, action, error) {
    try { console.error(`[${label}] ${action} failed`, error?.code ?? 'UNKNOWN'); }
    catch { /* Cleanup must never replace the operation result. */ }
}

export function isTransactionConnectionDiscarded(connection) {
    return discardedConnections.has(connection);
}

export function destroyTransactionConnection(connection, label) {
    if (isTransactionConnectionDiscarded(connection)) return;
    discardedConnections.add(connection);
    try { connection.destroy(); }
    catch (error) { logCleanup(label, 'destroy', error); }
}

export async function startTransactionConnection(connection, label, { readOnlySnapshot = false } = {}) {
    try {
        await runDatabaseOperation(connection, label, async () => {
            if (readOnlySnapshot) {
                await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
                if (isTransactionConnectionDiscarded(connection)) throw databaseOperationError('DATABASE_CONNECTION_DISCARDED');
                await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            } else await connection.beginTransaction();
        }, TRANSACTION_TIMEOUT_MS);
    } catch (error) {
        destroyTransactionConnection(connection, label);
        throw error;
    }
}

export async function commitTransactionConnection(connection, label) {
    try { await runDatabaseOperation(connection, label, () => connection.commit(), TRANSACTION_TIMEOUT_MS); }
    catch (error) {
        // A lost acknowledgement leaves the outcome unknown; never reuse this lease.
        destroyTransactionConnection(connection, label);
        throw error;
    }
}

export async function rollbackTransactionConnection(connection, label, originalError) {
    if (isTransactionConnectionDiscarded(connection)) return false;
    if (originalError?.fatal || ['PROTOCOL_SEQUENCE_TIMEOUT', 'AbortError', 'TimeoutError'].includes(originalError?.code)
        || ['AbortError', 'TimeoutError'].includes(originalError?.name)) {
        destroyTransactionConnection(connection, label);
        return false;
    }
    let timer;
    try {
        await Promise.race([
            connection.rollback(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error('rollback_timeout'), {
                    code: 'ROLLBACK_TIMEOUT'
                })), ROLLBACK_TIMEOUT_MS);
            })
        ]);
        return true;
    } catch (error) {
        logCleanup(label, 'rollback', error);
        destroyTransactionConnection(connection, label);
        return false;
    } finally { clearTimeout(timer); }
}

export function releaseTransactionConnection(connection, label) {
    if (isTransactionConnectionDiscarded(connection)) return;
    let pool, core, returned = false;
    const observedRelease = released => { if (released === core) returned = true; };
    try {
        core = connection.connection;
        pool = core?._pool;
        pool?.prependListener('release', observedRelease);
    } catch (error) { logCleanup(label, 'observe release', error); }
    try { connection.release(); }
    catch (error) {
        logCleanup(label, 'release', error);
        // mysql2 emits release after making the lease available to another borrower.
        if (returned) discardedConnections.add(connection);
        else destroyTransactionConnection(connection, label);
    } finally {
        try { pool?.removeListener('release', observedRelease); }
        catch (error) { logCleanup(label, 'remove release observer', error); }
    }
}
