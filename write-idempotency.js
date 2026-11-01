import { createHash, randomUUID } from 'node:crypto';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { canonicalWritePayload } from './public/js/shared/write-intent.js';

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = (error, status = 409) => ({ status, body: { error } });

export function readWriteIdentity(req) {
    const key = req.get?.('Idempotency-Key') ?? req.headers?.['idempotency-key'];
    if (typeof key !== 'string' || !keyPattern.test(key)) throw failure('write_identity_required', 400);
    return key.toLowerCase();
}

export async function claimWriteIntent(connection, { userID, key, action, payload }) {
    const actor = canonicalAccountID(userID);
    if (!actor || typeof key !== 'string' || !keyPattern.test(key)
        || !/^[a-z_]{1,64}$/.test(action)) throw failure('invalid_write_identity', 400);
    key = key.toLowerCase();
    const payloadHash = createHash('sha256').update(canonicalWritePayload(payload)).digest('hex');
    const owner = randomUUID();
    // The unique-key upsert serializes concurrent deliveries without a second pool borrow.
    await connection.execute(`INSERT INTO write_requests
        (actor_user_ID, request_key, action, payload_hash, owner_token)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE request_key = request_key`, [actor, key, action, payloadHash, owner]);
    const [rows] = await connection.execute(`SELECT action, payload_hash, owner_token, response_status, response_body
        FROM write_requests WHERE actor_user_ID = ? AND request_key = ? FOR UPDATE`, [actor, key]);
    if (rows.length !== 1) throw new Error('Write identity claim disappeared.');
    const row = rows[0];
    if (row.action !== action || row.payload_hash !== payloadHash) throw failure('write_identity_reused');
    if (row.owner_token === owner) return { actor, key, owner, response: null };
    if (![200, 204].includes(Number(row.response_status))) throw failure('write_identity_incomplete');
    let body = row.response_body;
    if (typeof body === 'string') body = JSON.parse(body);
    return { actor, key, owner: null, response: { status: Number(row.response_status), body } };
}

export async function completeWriteIntent(connection, intent, { status, body = null }) {
    if (!intent.owner || intent.response || ![200, 204].includes(status)) throw new Error('Invalid write completion.');
    const [result] = await connection.execute(`UPDATE write_requests SET response_status = ?, response_body = ?
        WHERE actor_user_ID = ? AND request_key = ? AND owner_token = ? AND response_status IS NULL`,
    [status, body === null ? null : JSON.stringify(body), intent.actor, intent.key, intent.owner]);
    if (Number(result.affectedRows) !== 1) throw new Error('Write completion lost its request ownership.');
}
