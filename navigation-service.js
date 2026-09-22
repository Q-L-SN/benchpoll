import { normalizeUserID, selectScopedDimensions, decorateDimensions, canonicalizeContextValues } from './ranking-service.js';
import { entryFromContext, compareLocations } from './public/js/navigation/model.js';

// Build only location metadata. This never computes public pies or model scores.
export function buildPersonalNavigation(rows, categories, dimensionRows, optionRows) {
    const byID = new Map(categories.map(category => [Number(category.ID), category]));
    const parents = new Set(categories.filter(category => category.is_active).map(category => Number(category.parent_ID)));
    return rows.filter(row => Number(row.weightCount) > 0).map(row => {
        const categoryID = Number(row.categoryID);
        let available = true;
        let cursor = byID.get(categoryID);
        const lineage = [];
        const visited = new Set();
        while (cursor) {
            const ID = Number(cursor.ID);
            if (visited.has(ID) || lineage.length >= 64) { available = false; break; }
            visited.add(ID);
            lineage.unshift({ ID, name: String(cursor.name) });
            if (!cursor.is_active) available = false;
            if (cursor.parent_ID === null) break;
            cursor = byID.get(Number(cursor.parent_ID));
            if (!cursor) available = false;
        }
        if (!lineage.length || lineage.at(-1).ID !== categoryID) {
            lineage.push({ ID: categoryID, name: `Category #${categoryID}` });
            available = false;
        }
        let values = {};
        let dimensions = [];
        try {
            values = typeof row.contextValues === 'string' ? JSON.parse(row.contextValues) : row.contextValues;
            if (!values || typeof values !== 'object' || Array.isArray(values)
                || Object.values(values).some(value => typeof value !== 'string')) throw new TypeError('Invalid context');
            const category = { lineage, isLeaf: !parents.has(categoryID) };
            dimensions = decorateDimensions(selectScopedDimensions(dimensionRows, category), optionRows);
            canonicalizeContextValues(values, dimensions, { requireAllDimensions: true });
        } catch {
            available = false;
            if (!values || typeof values !== 'object' || Array.isArray(values)) values = {};
            values = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
            dimensions = [];
        }
        const entry = entryFromContext({ ID: Number(row.contextID), categoryID, lineage, dimensions, contextValues: values });
        if (!dimensions.length && Object.keys(values).length) {
            entry.contextLabel = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}: ${value}`).join(' · ');
        }
        if (Number(row.totalBasisPoints) !== 10000 || Number(row.unavailableConditions) > 0) available = false;
        return { ...entry, available };
    }).sort(compareLocations);
}

export async function getPersonalNavigation(db, userID) {
    const owner = normalizeUserID(userID);
    if (!owner) throw { status: 401, body: { error: 'authentication_required' } };
    const connection = await db.getConnection();
    try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ?
            AND deleted_at IS NULL AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW()))`, [owner]);
        if (!users.length) throw { status: 401, body: { error: 'authentication_required' } };
        const [rows] = await connection.execute(`
            SELECT rc.ID AS contextID, rc.category_ID AS categoryID, rc.context_values AS contextValues,
                   COUNT(w.benchmark_condition_ID) AS weightCount, SUM(w.weight_basis_points) AS totalBasisPoints,
                   SUM(CASE WHEN bc.ID IS NULL OR bc.is_active = 0 OR b.ID IS NULL OR b.is_active = 0
                            THEN 1 ELSE 0 END) AS unavailableConditions
            FROM personal_pies pp
            JOIN ranking_contexts rc ON rc.ID = pp.context_ID
            JOIN personal_pie_weights w ON w.pie_ID = pp.ID
            LEFT JOIN benchmark_conditions bc ON bc.ID = w.benchmark_condition_ID
            LEFT JOIN benchmarks b ON b.ID = bc.benchmark_ID
            WHERE pp.user_ID = ?
            GROUP BY pp.ID, rc.ID, rc.category_ID, rc.context_values
            ORDER BY rc.category_ID, rc.ID`, [owner]);
        const [categories] = await connection.execute('SELECT ID, parent_ID, name, is_active FROM categories ORDER BY ID');
        const [dimensions] = await connection.execute(`SELECT ID, scope_category_ID, dimension_key, name, position
            FROM ranking_dimensions WHERE is_active = 1 ORDER BY position, ID`);
        const [options] = await connection.execute(`SELECT dimension_ID, option_key, name, position, is_default, is_neutral
            FROM ranking_dimension_options ORDER BY dimension_ID, position, ID`);
        const items = buildPersonalNavigation(rows, categories, dimensions, options);
        await connection.commit();
        return { userID: owner, items };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}
