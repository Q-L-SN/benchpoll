#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const retiredKeys = new Set(['web', 'code', 'scope']);

function databaseConfig() {
    return {
        socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_SOCKET ? undefined : process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        charset: 'utf8mb4'
    };
}

async function renameCategory(connection, parentID, oldName, newName) {
    const [rows] = await connection.execute(`
        SELECT ID, name, is_active FROM categories
        WHERE parent_ID <=> ? AND name IN (?, ?) FOR UPDATE`, [parentID, oldName, newName]);
    if (rows.length !== 1 || !rows[0].is_active) {
        throw new Error(`Expected one active category named ${oldName} or ${newName} below ${parentID}`);
    }
    const row = rows[0];
    if (apply && row.name !== newName) {
        await connection.execute('UPDATE categories SET name = ? WHERE ID = ?', [newName, row.ID]);
    }
    return { ID: Number(row.ID), from: row.name, to: newName };
}

async function verifyCategory(connection, parentID, name) {
    const [rows] = await connection.execute(`
        SELECT ID, is_active FROM categories
        WHERE parent_ID <=> ? AND name = ? FOR UPDATE`, [parentID, name]);
    if (rows.length !== 1 || !rows[0].is_active) throw new Error(`Expected one active ${name} category`);
    return Number(rows[0].ID);
}

async function renameReferenceDimension(connection, categoryID) {
    const [dimensions] = await connection.execute(`
        SELECT ID, name, position, is_active FROM ranking_dimensions
        WHERE scope_category_ID = ? AND dimension_key = 'reference' FOR UPDATE`, [categoryID]);
    if (dimensions.length !== 1 || !dimensions[0].is_active || Number(dimensions[0].position) !== 1
        || !['参考方式', 'Reference'].includes(dimensions[0].name)) {
        throw new Error(`Unexpected reference dimension for category ${categoryID}`);
    }
    const dimension = dimensions[0];
    const expected = [
        { key: 'with_reference', old: '带参考', name: 'With Reference', position: 10, default: 0, neutral: 0 },
        { key: 'without_reference', old: '不带参考', name: 'Without Reference', position: 20, default: 0, neutral: 0 },
        { key: 'any', old: '不限', name: 'Any', position: 30, default: 1, neutral: 1 }
    ];
    const [options] = await connection.execute(`
        SELECT ID, option_key, name, position, is_default, is_neutral
        FROM ranking_dimension_options WHERE dimension_ID = ? FOR UPDATE`, [dimension.ID]);
    if (options.length !== expected.length) throw new Error(`Unexpected reference options for category ${categoryID}`);
    for (const item of expected) {
        const option = options.find(row => row.option_key === item.key);
        if (!option || ![item.old, item.name].includes(option.name)
            || Number(option.position) !== item.position
            || Number(option.is_default) !== item.default
            || Number(option.is_neutral) !== item.neutral) {
            throw new Error(`Unexpected ${item.key} option for category ${categoryID}`);
        }
        if (apply && option.name !== item.name) {
            await connection.execute('UPDATE ranking_dimension_options SET name = ? WHERE ID = ?',
                [item.name, option.ID]);
        }
    }
    if (apply && dimension.name !== 'Reference') {
        await connection.execute('UPDATE ranking_dimensions SET name = ? WHERE ID = ?',
            ['Reference', dimension.ID]);
    }
    return Number(dimension.ID);
}

async function retiredTemplateState(connection) {
    const [dimensions] = await connection.execute(`
        SELECT ID, dimension_key FROM ranking_dimensions
        WHERE scope_category_ID = 0 AND dimension_key IN ('web', 'code', 'scope') FOR UPDATE`);
    if (dimensions.length !== 0 && (dimensions.length !== 3
        || new Set(dimensions.map(row => row.dimension_key)).size !== 3)) {
        throw new Error('Legacy global template dimensions are incomplete or duplicated');
    }
    const [contexts] = await connection.execute(`
        SELECT rc.ID, rc.context_values, c.is_active
        FROM ranking_contexts rc JOIN categories c ON c.ID = rc.category_ID FOR UPDATE`);
    const oldContexts = contexts.filter(row => {
        const values = typeof row.context_values === 'string'
            ? JSON.parse(row.context_values) : row.context_values;
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
            throw new Error(`Invalid ranking context ${row.ID}`);
        }
        return Object.keys(values).some(key => retiredKeys.has(key));
    });
    if (oldContexts.some(row => row.is_active)) {
        throw new Error('An active category still has a context using a retired template');
    }
    if (oldContexts.length) {
        const ids = oldContexts.map(row => Number(row.ID));
        const placeholders = ids.map(() => '?').join(', ');
        const [[pieRefs]] = await connection.execute(`
            SELECT COUNT(*) AS count FROM personal_pies WHERE context_ID IN (${placeholders})`, ids);
        const [[discussionRefs]] = await connection.execute(`
            SELECT COUNT(*) AS count FROM discussion_posts WHERE context_ID IN (${placeholders})`, ids);
        if (Number(pieRefs.count) || Number(discussionRefs.count)) {
            throw new Error('Retired template contexts still have personal pie or discussion references');
        }
    }
    return {
        dimensionIDs: dimensions.map(row => Number(row.ID)),
        contextIDs: oldContexts.map(row => Number(row.ID))
    };
}

async function deleteRetiredTemplates(connection, state) {
    if (state.contextIDs.length) {
        const placeholders = state.contextIDs.map(() => '?').join(', ');
        await connection.execute(`DELETE FROM ranking_contexts WHERE ID IN (${placeholders})`, state.contextIDs);
    }
    if (state.dimensionIDs.length) {
        const placeholders = state.dimensionIDs.map(() => '?').join(', ');
        await connection.execute(`DELETE FROM ranking_dimension_options WHERE dimension_ID IN (${placeholders})`,
            state.dimensionIDs);
        await connection.execute(`DELETE FROM ranking_dimensions WHERE ID IN (${placeholders})`,
            state.dimensionIDs);
    }
}

async function main() {
    const connection = await mysql.createConnection(databaseConfig());
    try {
        await connection.beginTransaction();
        const root = await renameCategory(connection, null, '智能', 'Intelligence');
        await verifyCategory(connection, root.ID, 'AGI');
        const research = await renameCategory(connection, root.ID, '研究', 'Research');
        const categories = [
            root, research,
            await renameCategory(connection, research.ID, '数学', 'Mathematics'),
            await renameCategory(connection, research.ID, '物理学', 'Physics'),
            await renameCategory(connection, research.ID, '生物学与医学', 'Biology and Medicine'),
            await renameCategory(connection, null, '文学写作', 'Literary Writing'),
            await renameCategory(connection, null, '图片', 'Image'),
            await renameCategory(connection, null, '视频', 'Video')
        ];
        const referenceDimensions = [];
        for (const category of categories.filter(row => ['Image', 'Video'].includes(row.to))) {
            referenceDimensions.push(await renameReferenceDimension(connection, category.ID));
        }
        const retired = await retiredTemplateState(connection);
        if (apply) {
            await deleteRetiredTemplates(connection, retired);
            await connection.commit();
        } else {
            await connection.rollback();
        }
        console.log(JSON.stringify({ applied: apply, categories, referenceDimensions,
            retiredGlobalDimensionIDs: retired.dimensionIDs, retiredContextCount: retired.contextIDs.length }, null, 2));
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        await connection.end();
    }
}

await main();
