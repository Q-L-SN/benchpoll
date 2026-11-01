import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

export const MAX_USER_PROFILE_BYTES = 300 * 1024;
export const MAX_USER_AVATAR_SIZE = 256;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, body: { error: code } }); };

export async function ensureUserProfileSchema(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS user_public_profiles (
        user_ID BIGINT UNSIGNED NOT NULL,
        display_name VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
        avatar_data_url MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NULL,
        github_username VARCHAR(39) CHARACTER SET ascii COLLATE ascii_bin NULL,
        show_github_profile TINYINT(1) NOT NULL DEFAULT 0,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_ID),
        CONSTRAINT fk_public_profile_user FOREIGN KEY (user_ID) REFERENCES users(ID) ON DELETE CASCADE,
        CONSTRAINT chk_public_profile_avatar_size CHECK (avatar_data_url IS NULL OR OCTET_LENGTH(avatar_data_url) <= 307200)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

export async function ensurePublicGitHubProfileSchema(connection) {
    await ensureUserProfileSchema(connection);
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_public_profiles'`);
    const existing = new Set(columns.map(column => column.name));
    const addedColumns = [];
    for (const [name, definition] of [
        ['github_username', 'VARCHAR(39) CHARACTER SET ascii COLLATE ascii_bin NULL'],
        ['show_github_profile', 'TINYINT(1) NOT NULL DEFAULT 0']
    ]) if (!existing.has(name)) {
        await connection.query(`ALTER TABLE user_public_profiles ADD COLUMN ${name} ${definition}`);
        addedColumns.push(name);
    }
    return { addedColumns };
}

export function githubProfileUsername(value) {
    return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)
        && !value.includes('--') ? value : null;
}

export function publicGitHubProfile(username, { enabled = false, active = false } = {}) {
    const login = githubProfileUsername(username);
    return enabled === true && active === true && login ? { githubURL: `https://github.com/${login}` } : {};
}

// Called only with the authenticated provider response, inside the OAuth login transaction.
export async function recordGitHubProfile(connection, userID, login) {
    userID = canonicalAccountID(userID);
    const username = githubProfileUsername(login);
    if (!userID || !username) fail(502, 'github_profile_invalid');
    const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL
        AND (banned_at IS NULL OR banned_until <= NOW()) FOR UPDATE`, [userID]);
    if (!users.length || canonicalAccountID(users[0].ID) !== userID) fail(403, 'profile_account_unavailable');
    await connection.execute(`INSERT INTO user_public_profiles (user_ID, github_username, show_github_profile) VALUES (?, ?, 0)
        ON DUPLICATE KEY UPDATE github_username = VALUES(github_username)`, [userID, username]);
}

export function userDisplayName(value) {
    if (typeof value !== 'string' || value.length > 240
        || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) {
        fail(400, 'profile_display_name_invalid');
    }
    const name = value.normalize('NFC').trim();
    if (!name || [...name].length > 60 || !name.replace(/[\p{Cf}\p{M}\s]/gu, '')) fail(400, 'profile_display_name_invalid');
    return name;
}

function pngChunk(type, data) {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
}

// Support one completely checked storage format, rather than partial JPEG/WebP decoders.
export function userAvatarDataURL(value) {
    if (value === null) return null;
    if (typeof value !== 'string') fail(400, 'profile_avatar_invalid');
    if (value.length > MAX_USER_PROFILE_BYTES) fail(413, 'profile_payload_too_large');
    if (!value.startsWith(PNG_PREFIX)) fail(400, 'profile_avatar_invalid');
    const base64 = value.slice(PNG_PREFIX.length);
    if (!base64.length || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail(400, 'profile_avatar_invalid');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail(400, 'profile_avatar_invalid');

    let offset = 8, header = null, width = 0, height = 0, channels = 0, ended = false;
    const compressed = [];
    for (let count = 0; offset < bytes.length && count < 128; count++) {
        if (offset + 12 > bytes.length) fail(400, 'profile_avatar_invalid');
        const length = bytes.readUInt32BE(offset);
        const end = offset + length + 12;
        if (end > bytes.length) fail(400, 'profile_avatar_invalid');
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, end - 4);
        if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail(400, 'profile_avatar_invalid');
        if (!header) {
            if (type !== 'IHDR' || length !== 13) fail(400, 'profile_avatar_invalid');
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            if (!width || !height || width > MAX_USER_AVATAR_SIZE || height > MAX_USER_AVATAR_SIZE
                || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) {
                fail(400, 'profile_avatar_invalid');
            }
            channels = data[9] === 6 ? 4 : 3;
            header = data;
        } else if (type === 'IDAT') {
            compressed.push(data);
        } else if (type === 'IEND' && length === 0 && compressed.length && end === bytes.length) {
            ended = true;
        } else {
            // No APNG, executable/ancillary metadata, unknown chunks or appended content.
            fail(400, 'profile_avatar_invalid');
        }
        offset = end;
        if (ended) break;
    }
    if (!ended) fail(400, 'profile_avatar_invalid');
    const input = Buffer.concat(compressed);
    const stride = width * channels + 1;
    const expected = stride * height;
    let pixels;
    try {
        const result = inflateSync(input, { maxOutputLength: expected, info: true });
        pixels = result.buffer;
        if (pixels.length !== expected || result.engine.bytesWritten !== input.length) fail(400, 'profile_avatar_invalid');
    } catch { fail(400, 'profile_avatar_invalid'); }
    for (let row = 0; row < height; row++) {
        if (pixels[row * stride] > 4) fail(400, 'profile_avatar_invalid');
    }
    const canonical = PNG_PREFIX + Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
    if (canonical.length > MAX_USER_PROFILE_BYTES) fail(413, 'profile_payload_too_large');
    return canonical;
}

export function normalizeUserProfile(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) fail(400, 'invalid_profile_body');
    const keys = Object.keys(body);
    if (!keys.length || keys.some(key => !['displayName', 'avatar', 'showGitHubProfile'].includes(key))) fail(400, 'unknown_profile_field');
    const result = {};
    if (Object.hasOwn(body, 'displayName')) result.displayName = userDisplayName(body.displayName);
    if (Object.hasOwn(body, 'avatar')) result.avatar = userAvatarDataURL(body.avatar);
    if (Object.hasOwn(body, 'showGitHubProfile')) {
        if (typeof body.showGitHubProfile !== 'boolean') fail(400, 'profile_github_visibility_invalid');
        result.showGitHubProfile = body.showGitHubProfile;
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_USER_PROFILE_BYTES
        || Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_USER_PROFILE_BYTES) fail(413, 'profile_payload_too_large');
    return result;
}

function defaultAvatar(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com'
            && !url.username && !url.password && !url.port ? url.href : null;
    } catch { return null; }
}

export async function loadUserProfile(db, userID) {
    userID = canonicalAccountID(userID);
    if (!userID) return null;
    const [rows] = await db.execute(`SELECT CAST(u.ID AS CHAR) AS userID,
        COALESCE(p.display_name, u.name) AS userName,
        COALESCE(p.avatar_data_url, u.profile_picture_URL) AS userProfilePictureURL,
        (p.display_name IS NOT NULL) AS hasCustomDisplayName,
        (p.avatar_data_url IS NOT NULL) AS hasCustomAvatar,
        p.github_username AS githubUsername, p.show_github_profile AS showGitHubProfile,
        u.name AS defaultUserName, u.profile_picture_URL AS defaultUserProfilePictureURL,
        u.role, (u.email_verified_at IS NOT NULL AND NULLIF(TRIM(u.email), '') IS NOT NULL) AS hasVerifiedEmail
        FROM users u LEFT JOIN user_public_profiles p ON p.user_ID = u.ID
        WHERE u.ID = ? AND u.deleted_at IS NULL
            AND (u.banned_at IS NULL OR u.banned_until <= NOW())`, [userID]);
    if (!rows.length) return null;
    const row = rows[0];
    if (canonicalAccountID(row.userID) !== userID) fail(503, 'profile_identity_mismatch');
    const hasCustomDisplayName = Number(row.hasCustomDisplayName) === 1;
    const hasCustomAvatar = Number(row.hasCustomAvatar) === 1;
    const canShowGitHubProfile = githubProfileUsername(row.githubUsername) !== null;
    const showGitHubProfile = Number(row.showGitHubProfile) === 1;
    return { userID, userName: row.userName, userProfilePictureURL: hasCustomAvatar
        ? row.userProfilePictureURL : defaultAvatar(row.userProfilePictureURL),
    hasCustomDisplayName, hasCustomAvatar, defaultUserName: row.defaultUserName,
    defaultUserProfilePictureURL: defaultAvatar(row.defaultUserProfilePictureURL),
    role: row.role, hasVerifiedEmail: Number(row.hasVerifiedEmail) === 1,
    canShowGitHubProfile, showGitHubProfile,
    ...publicGitHubProfile(row.githubUsername, { enabled: showGitHubProfile, active: true }) };
}

export async function saveUserProfile(db, userID, body) {
    userID = canonicalAccountID(userID);
    if (!userID) fail(401, 'authentication_required');
    const profile = normalizeUserProfile(body);
    const connection = await db.getConnection();
    const label = 'SAVE USER PROFILE';
    try {
        await startTransactionConnection(connection, label);
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL
            AND (banned_at IS NULL OR banned_until <= NOW()) FOR UPDATE`, [userID]);
        if (!users.length || canonicalAccountID(users[0].ID) !== userID) fail(403, 'profile_account_unavailable');
        const hasName = Object.hasOwn(profile, 'displayName');
        const hasAvatar = Object.hasOwn(profile, 'avatar');
        const hasGitHubVisibility = Object.hasOwn(profile, 'showGitHubProfile');
        if (profile.showGitHubProfile === true) {
            const [stored] = await connection.execute('SELECT github_username FROM user_public_profiles WHERE user_ID = ? FOR UPDATE', [userID]);
            if (!githubProfileUsername(stored[0]?.github_username)) fail(409, 'profile_github_reauthentication_required');
        }
        await connection.execute(`INSERT INTO user_public_profiles (user_ID, display_name, avatar_data_url, show_github_profile)
            VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE
            display_name = IF(?, VALUES(display_name), display_name),
            avatar_data_url = IF(?, VALUES(avatar_data_url), avatar_data_url),
            show_github_profile = IF(?, VALUES(show_github_profile), show_github_profile)`,
        [userID, profile.displayName ?? null, profile.avatar ?? null, profile.showGitHubProfile ?? false,
            hasName, hasAvatar, hasGitHubVisibility]);
        const effective = await loadUserProfile(connection, userID);
        if (!effective) fail(403, 'profile_account_unavailable');
        await commitTransactionConnection(connection, label);
        return effective;
    } catch (error) {
        await rollbackTransactionConnection(connection, label, error);
        throw error;
    } finally { releaseTransactionConnection(connection, label); }
}
