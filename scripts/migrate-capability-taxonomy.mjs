#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const archiveExisting = process.argv.includes('--archive-existing');
const legacyNames = [
    'Web Search and Computer Use', 'Agentic Workflows and Tool Use',
    'Judging and Evaluation Protocols', 'Coding and Software Engineering',
    'Medical and Life Sciences', 'Domain Expert Work',
    'Reasoning Math and Knowledge', 'Conversation and Instruction Following',
    'Factuality and Hallucination', 'Multimodal Vision and Video',
    'Safety Security and Robustness', 'Long Context and Memory',
    'Embodied Robotics and World Models', 'Embeddings and Retrieval',
    'Multilingual and Cultural', 'Audio Speech and Music'
];

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

async function category(connection, parentID, name) {
    const [rows] = await connection.execute(
        'SELECT ID, is_active FROM categories WHERE parent_ID <=> ? AND name = ? FOR UPDATE',
        [parentID, name]
    );
    if (rows.length > 1) throw new Error(`Duplicate category: ${name}`);
    if (rows.length) {
        if (!rows[0].is_active) throw new Error(`Desired category is inactive: ${name}`);
        return Number(rows[0].ID);
    }
    const [result] = await connection.execute(
        'INSERT INTO categories (parent_ID, name) VALUES (?, ?)', [parentID, name]
    );
    return Number(result.insertId);
}

async function addReferenceDimension(connection, categoryID) {
    const [existing] = await connection.execute(
        'SELECT ID, position, is_active FROM ranking_dimensions WHERE scope_category_ID = ? AND dimension_key = ? FOR UPDATE',
        [categoryID, 'reference']
    );
    let dimensionID;
    if (existing.length) {
        if (!existing[0].is_active || Number(existing[0].position) !== 1) {
            throw new Error(`Existing reference dimension has a conflicting definition for category ${categoryID}`);
        }
        dimensionID = Number(existing[0].ID);
    } else {
        const [result] = await connection.execute(
            'INSERT INTO ranking_dimensions (scope_category_ID, dimension_key, name, position) VALUES (?, ?, ?, ?)',
            [categoryID, 'reference', '参考方式', 1]
        );
        dimensionID = Number(result.insertId);
    }
    const options = [
        ['with_reference', '带参考', 10, 0, 0],
        ['without_reference', '不带参考', 20, 0, 0],
        ['any', '不限', 30, 1, 1]
    ];
    for (const [key, name, position, isDefault, isNeutral] of options) {
        const [rows] = await connection.execute(
            'SELECT ID, name, position, is_default, is_neutral FROM ranking_dimension_options WHERE dimension_ID = ? AND option_key = ? FOR UPDATE',
            [dimensionID, key]
        );
        if (rows.length) {
            const row = rows[0];
            if (row.name !== name || Number(row.position) !== position
                || Number(row.is_default) !== isDefault || Number(row.is_neutral) !== isNeutral) {
                throw new Error(`Existing reference option conflicts with ${key} on category ${categoryID}`);
            }
        } else {
            await connection.execute(
                'INSERT INTO ranking_dimension_options (dimension_ID, option_key, name, position, is_default, is_neutral) VALUES (?, ?, ?, ?, ?, ?)',
                [dimensionID, key, name, position, isDefault, isNeutral]
            );
        }
    }
    const [[count]] = await connection.execute(
        'SELECT COUNT(*) AS count FROM ranking_dimension_options WHERE dimension_ID = ?', [dimensionID]
    );
    if (Number(count.count) !== options.length) throw new Error(`Unexpected reference options on category ${categoryID}`);
}

async function main() {
    const connection = await mysql.createConnection(databaseConfig());
    try {
        await connection.beginTransaction();
        const [roots] = await connection.execute(
            'SELECT ID, name, is_active FROM categories WHERE parent_ID IS NULL ORDER BY ID FOR UPDATE'
        );
        const originalRoot = roots.find(row => row.name === 'AI Evaluation' || row.name === '智能');
        if (!originalRoot || !originalRoot.is_active || roots.filter(row => row.name === originalRoot.name).length !== 1) {
            throw new Error('Expected one active AI Evaluation/智能 root');
        }
        const intelligentID = Number(originalRoot.ID);
        const [legacy] = await connection.execute(
            `SELECT ID, name, is_active FROM categories WHERE parent_ID = ? ORDER BY ID FOR UPDATE`,
            [intelligentID]
        );
        const legacyRows = legacy.filter(row => legacyNames.includes(row.name) && row.is_active);
        if (archiveExisting) {
            const candidates = legacyRows.map(row => Number(row.ID));
            if (candidates.length) {
                const placeholders = candidates.map(() => '?').join(', ');
                const [[references]] = await connection.execute(`
                    SELECT
                        (SELECT COUNT(*) FROM personal_pies p JOIN ranking_contexts rc ON rc.ID = p.context_ID
                         WHERE rc.category_ID IN (${placeholders})) AS pie_count,
                        (SELECT COUNT(*) FROM discussion_posts WHERE category_ID IN (${placeholders})) AS discussion_count`,
                    [...candidates, ...candidates]
                );
                if (Number(references.pie_count) || Number(references.discussion_count)) {
                    throw new Error('Cannot archive legacy categories with personal pies or discussions');
                }
            }
        }
        const plan = {
            rootID: intelligentID,
            oldRootName: originalRoot.name,
            legacyCategoriesToArchive: archiveExisting ? legacyRows.map(row => ({ ID: row.ID, name: row.name })) : [],
            requestedCategories: ['智能/AGI', '智能/研究/数学', '智能/研究/物理学', '智能/研究/生物学与医学',
                '文学写作', '图片', '视频'],
            referenceDimensions: ['图片', '视频']
        };
        if (!apply) {
            console.log(JSON.stringify({ applied: false, ...plan }, null, 2));
            await connection.rollback();
            return;
        }
        if (originalRoot.name !== '智能') {
            const [conflict] = await connection.execute(
                'SELECT ID FROM categories WHERE parent_ID IS NULL AND name = ? LIMIT 1', ['智能']
            );
            if (conflict.length) throw new Error('An unrelated 智能 root already exists');
            await connection.execute('UPDATE categories SET name = ? WHERE ID = ?', ['智能', intelligentID]);
        }
        if (archiveExisting) {
            for (const row of legacyRows) {
                await connection.execute('UPDATE categories SET is_active = 0 WHERE ID = ?', [row.ID]);
            }
        }
        await category(connection, intelligentID, 'AGI');
        const researchID = await category(connection, intelligentID, '研究');
        for (const name of ['数学', '物理学', '生物学与医学']) await category(connection, researchID, name);
        await category(connection, null, '文学写作');
        const imageID = await category(connection, null, '图片');
        const videoID = await category(connection, null, '视频');
        await addReferenceDimension(connection, imageID);
        await addReferenceDimension(connection, videoID);
        await connection.commit();
        console.log(JSON.stringify({ applied: true, ...plan, imageID, videoID }, null, 2));
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        await connection.end();
    }
}

await main();
