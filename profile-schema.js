import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { publicProfileID } from './public/js/shared/profile-identity.js';

const fail = (status, error) => { throw Object.assign(new Error(error), { status, body: { error } }); };

// This new migration is explicit; importing this module never changes the schema.
export async function ensureProfilePagesSchema(connection) {
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_public_profiles'`);
    if (!columns.length) throw new Error('The base user_public_profiles table must exist.');
    const existing = new Set(columns.map(column => column.name));
    const addedColumns = [];
    for (const [name, definition] of [
        ['public_id', 'VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL'],
        ['bio', "VARCHAR(280) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT ''"],
        ['publish_favorites', 'TINYINT(1) NOT NULL DEFAULT 0'],
        ['publish_configured_topics', 'TINYINT(1) NOT NULL DEFAULT 0']
    ]) if (!existing.has(name)) {
        await connection.query(`ALTER TABLE user_public_profiles ADD COLUMN ${name} ${definition}`);
        addedColumns.push(name);
    }
    const [indexes] = await connection.execute(`SELECT INDEX_NAME AS name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_public_profiles' AND INDEX_NAME = 'uq_profile_public_id'`);
    if (!indexes.length) await connection.query('ALTER TABLE user_public_profiles ADD UNIQUE KEY uq_profile_public_id (public_id)');
    await connection.query(`CREATE TABLE IF NOT EXISTS profile_id_sequence (
        ID TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        next_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
        CONSTRAINT chk_profile_sequence_singleton CHECK (ID = 1)
    ) ENGINE=InnoDB`);
    await connection.execute('INSERT IGNORE INTO profile_id_sequence (ID, next_id) VALUES (1, 1)');
    await connection.query(`CREATE TABLE IF NOT EXISTS user_profile_visits (
        user_ID BIGINT UNSIGNED NOT NULL,
        category_ID INT UNSIGNED NOT NULL,
        context_ID BIGINT UNSIGNED NOT NULL,
        visited_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_ID, context_ID),
        KEY idx_profile_visits_recent (user_ID, visited_at),
        CONSTRAINT fk_profile_visit_user FOREIGN KEY (user_ID) REFERENCES users(ID) ON DELETE CASCADE,
        CONSTRAINT fk_profile_visit_category FOREIGN KEY (category_ID) REFERENCES categories(ID) ON DELETE CASCADE,
        CONSTRAINT fk_profile_visit_context FOREIGN KEY (context_ID) REFERENCES ranking_contexts(ID) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    return { addedColumns };
}

async function lockAllocator(connection) {
    const [[row]] = await connection.execute('SELECT CAST(next_id AS CHAR) AS nextID FROM profile_id_sequence WHERE ID = 1 FOR UPDATE');
    const id = canonicalAccountID(row?.nextID);
    if (!id) fail(503, 'profile_allocator_unavailable');
    return BigInt(id);
}

// Caller owns the transaction and locks the user first. All allocations and edits
// share this lock, including explicit numeric handles, so signups cannot collide.
export async function ensureUserPublicID(connection, rawUserID) {
    const userID = canonicalAccountID(rawUserID);
    if (!userID) fail(400, 'profile_identity_invalid');
    const [profiles] = await connection.execute('SELECT public_id FROM user_public_profiles WHERE user_ID = ? FOR UPDATE', [userID]);
    if (profiles[0]?.public_id) return profiles[0].public_id;
    let candidate = await lockAllocator(connection);
    while (candidate < 18446744073709551615n) {
        const id = String(candidate);
        const [occupied] = await connection.execute('SELECT user_ID FROM user_public_profiles WHERE public_id = ? LIMIT 1', [id]);
        candidate++;
        if (occupied.length) continue;
        try {
            if (profiles.length) await connection.execute('UPDATE user_public_profiles SET public_id = ? WHERE user_ID = ?', [id, userID]);
            else await connection.execute('INSERT INTO user_public_profiles (user_ID, public_id) VALUES (?, ?)', [userID, id]);
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') continue;
            throw error;
        }
        await connection.execute('UPDATE profile_id_sequence SET next_id = ? WHERE ID = 1', [String(candidate)]);
        return id;
    }
    fail(503, 'profile_id_exhausted');
}

export async function updateUserPublicID(connection, userID, value) {
    const id = publicProfileID(value);
    if (!id) fail(400, 'profile_public_id_invalid');
    await lockAllocator(connection);
    const [occupied] = await connection.execute('SELECT CAST(user_ID AS CHAR) AS userID FROM user_public_profiles WHERE public_id = ? LIMIT 1', [id]);
    if (occupied.length && canonicalAccountID(occupied[0].userID) !== userID) fail(409, 'profile_public_id_taken');
    try { await connection.execute('UPDATE user_public_profiles SET public_id = ? WHERE user_ID = ?', [id, userID]); }
    catch (error) { if (error.code === 'ER_DUP_ENTRY') fail(409, 'profile_public_id_taken'); throw error; }
    return id;
}

export async function backfillProfileIDs(connection, registrationOrder = null) {
    const [rows] = await connection.execute(`SELECT CAST(u.ID AS CHAR) AS userID FROM users u
        LEFT JOIN user_public_profiles p ON p.user_ID = u.ID WHERE p.public_id IS NULL ORDER BY u.ID`);
    const missing = new Set(rows.map(row => canonicalAccountID(row.userID)));
    // Historical users have no signup timestamp. The default is a deterministic
    // bootstrap by stored ID; only new allocations represent signup order.
    const ids = (registrationOrder ?? rows.map(row => row.userID)).map(canonicalAccountID);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length
        || ids.length !== missing.size || ids.some(id => !missing.has(id))) {
        throw new Error('Provide every unassigned user ID exactly once in verified registration order. The users table has no signup timestamp.');
    }
    for (const id of ids) await ensureUserPublicID(connection, id);
    return { assigned: ids.length, ordering: registrationOrder === null ? 'bootstrap-stored-user-id' : 'supplied-registration-order' };
}
