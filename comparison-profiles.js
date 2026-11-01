import { comparisonOptions } from './model-comparison.js';
import { loadScoreFieldCatalog } from './score-field-service.js';
import { comparisonProfileKey } from './public/js/shared/comparison-profile-key.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

const MAX_PROFILES = 25;
const fail = (status, error) => { throw { status, body: { error } }; };
const parseJSON = value => typeof value === 'string' ? JSON.parse(value) : value;

export function comparisonProfileName(value) {
    if (typeof value !== 'string') fail(400, 'comparison_profile_name_required');
    const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) fail(400, 'invalid_comparison_profile_name');
    return { name, key: `named:${name.toLowerCase()}` };
}

export async function validateComparisonProfile(connection, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || JSON.stringify(input).length > 16384) fail(400, 'invalid_comparison_profile');
    const fields = await loadScoreFieldCatalog(connection);
    const [rows] = await connection.execute('SELECT ID, name FROM models WHERE is_active = 1');
    const models = rows.map(row => ({ modelID: Number(row.ID), modelName: row.name,
        condition: { parameters: {} } }));
    const { mode, keys, filters } = comparisonOptions(models, input, fields);
    return { mode, keys, filters };
}

export async function listComparisonProfiles(connection, userID) {
    const [rows] = await connection.execute(`SELECT profile_key, name, comparison
        FROM user_comparison_profiles WHERE user_ID = ? ORDER BY name`, [userID]);
    return {
        authenticated: true,
        userID: String(userID),
        last: parseJSON(rows.find(row => row.profile_key === 'last')?.comparison ?? null),
        profiles: rows.filter(row => row.profile_key !== 'last').map(row => ({
            name: row.name, comparison: parseJSON(row.comparison)
        }))
    };
}

export async function saveComparisonProfile(pool, userID, input) {
    const named = input?.name !== undefined;
    const profile = named ? comparisonProfileName(input.name) : { name: '', key: 'last' };
    const comparison = await validateComparisonProfile(pool, input?.comparison);
    const connection = await pool.getConnection();
    try {
        await startTransactionConnection(connection, 'SAVE COMPARISON PROFILE');
        const [users] = await connection.execute('SELECT ID FROM users WHERE ID = ? FOR UPDATE', [userID]);
        if (!users.length) fail(401, 'authentication_required');
        if (named) {
            const [existing] = await connection.execute(`SELECT profile_key, name, comparison FROM user_comparison_profiles
                WHERE user_ID = ? AND profile_key LIKE 'named:%' FOR UPDATE`, [userID]);
            const duplicate = existing.find(row => comparisonProfileKey(parseJSON(row.comparison)) === comparisonProfileKey(comparison));
            if (duplicate) throw { status: 409, body: { error: 'comparison_profile_duplicate', name: duplicate.name } };
            if (existing.some(row => row.profile_key === profile.key)) fail(409, 'comparison_profile_name_exists');
            if (existing.length >= MAX_PROFILES) fail(400, 'comparison_profile_limit_reached');
        }
        await connection.execute(`INSERT INTO user_comparison_profiles
            (user_ID, profile_key, name, comparison) VALUES (?, ?, ?, ?)
            ${named ? '' : 'ON DUPLICATE KEY UPDATE name = VALUES(name), comparison = VALUES(comparison)'}`,
        [userID, profile.key, profile.name, JSON.stringify(comparison)]);
        await commitTransactionConnection(connection, 'SAVE COMPARISON PROFILE');
        return { name: profile.name, comparison };
    } catch (error) {
        await rollbackTransactionConnection(connection, 'SAVE COMPARISON PROFILE', error);
        if (named && error.code === 'ER_DUP_ENTRY') fail(409, 'comparison_profile_name_exists');
        throw error;
    } finally {
        releaseTransactionConnection(connection, 'SAVE COMPARISON PROFILE');
    }
}

export async function deleteComparisonProfile(connection, userID, name) {
    const profile = comparisonProfileName(name);
    const [result] = await connection.execute(`DELETE FROM user_comparison_profiles
        WHERE user_ID = ? AND profile_key = ?`, [userID, profile.key]);
    if (result.affectedRows !== 1) fail(404, 'comparison_profile_not_found');
    return { deleted: true };
}

export async function renameComparisonProfile(pool, userID, name, newName) {
    const from = comparisonProfileName(name), to = comparisonProfileName(newName);
    const connection = await pool.getConnection();
    try {
        await startTransactionConnection(connection, 'RENAME COMPARISON PROFILE');
        const [users] = await connection.execute('SELECT ID FROM users WHERE ID = ? FOR UPDATE', [userID]);
        if (!users.length) fail(401, 'authentication_required');
        const [rows] = await connection.execute(`SELECT profile_key FROM user_comparison_profiles
            WHERE user_ID = ? AND profile_key IN (?, ?) FOR UPDATE`, [userID, from.key, to.key]);
        if (!rows.some(row => row.profile_key === from.key)) fail(404, 'comparison_profile_not_found');
        if (from.key !== to.key && rows.some(row => row.profile_key === to.key)) fail(409, 'comparison_profile_name_exists');
        await connection.execute(`UPDATE user_comparison_profiles SET profile_key = ?, name = ?
            WHERE user_ID = ? AND profile_key = ?`, [to.key, to.name, userID, from.key]);
        await commitTransactionConnection(connection, 'RENAME COMPARISON PROFILE');
        return { name: to.name };
    } catch (error) {
        await rollbackTransactionConnection(connection, 'RENAME COMPARISON PROFILE', error);
        if (error.code === 'ER_DUP_ENTRY') fail(409, 'comparison_profile_name_exists');
        throw error;
    }
    finally { releaseTransactionConnection(connection, 'RENAME COMPARISON PROFILE'); }
}
