#!/usr/bin/env node

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { assertCategoryName } from '../public/js/shared/category-route.js';
import { preserveContextPies, retirePublicCategory } from '../private-category-service.js';
import { canonicalizeContextValues } from '../ranking-service.js';

export const taxonomy = JSON.parse(readFileSync(new URL('../ops/capability-taxonomy-20260930.json', import.meta.url), 'utf8'));

export function planCategories(rows, specification = taxonomy) {
    rows = rows.filter(row => row.owner_user_ID == null);
    const byKey = new Map();
    const usedIDs = new Set();
    const siblings = new Set();
    const plan = [];
    for (const node of specification.categories) {
        assertCategoryName(node.name);
        if (byKey.has(node.key) || (node.parent !== null && !byKey.has(node.parent))) {
            throw new Error(`Invalid taxonomy order or duplicate key: ${node.key}`);
        }
        if (!/^[\x20-\x7e]{1,128}$/.test(node.name) || !Number.isSafeInteger(node.position) || node.position < 1) {
            throw new Error(`Invalid category definition: ${node.key}`);
        }
        const siblingKey = `${node.parent}:${node.name.toLowerCase()}`;
        if (siblings.has(siblingKey)) throw new Error(`Duplicate category name: ${node.name}`);
        siblings.add(siblingKey);
        const parent = node.parent === null ? null : byKey.get(node.parent);
        const matches = node.existingID
            ? rows.filter(row => Number(row.ID) === node.existingID)
            : rows.filter(row => (node.parent === null ? row.parent_ID === null
                : parent.ID !== null && Number(row.parent_ID) === parent.ID) && row.name === node.name);
        if (matches.length > 1 || (node.existingID && matches.length !== 1)) {
            throw new Error(`Category identity is missing or duplicated: ${node.name}`);
        }
        const current = matches[0];
        if (current && (!current.is_active || ![node.name, node.previousName].includes(current.name))) {
            throw new Error(`Unexpected existing category: ${node.name}`);
        }
        const entry = { ...node, ID: current ? Number(current.ID) : null,
            previous: current ? { name: current.name, parentID: current.parent_ID === null ? null : Number(current.parent_ID),
                position: current.position === undefined ? null : Number(current.position) } : null };
        if (entry.ID !== null) {
            if (usedIDs.has(entry.ID)) throw new Error(`Category ID reused: ${entry.ID}`);
            usedIDs.add(entry.ID);
        }
        byKey.set(node.key, entry);
        plan.push(entry);
    }
    const retiredIDs = new Set();
    for (const retired of specification.retiredCategories ?? []) {
        if (!Number.isSafeInteger(retired.ID) || retiredIDs.has(retired.ID) || usedIDs.has(retired.ID)) {
            throw new Error(`Invalid retired category identity: ${retired.ID}`);
        }
        const current = rows.find(row => Number(row.ID) === retired.ID);
        if (current && current.name !== retired.name) throw new Error(`Unexpected retired category: ${retired.ID}`);
        retiredIDs.add(retired.ID);
    }
    const unexpected = rows.filter(row => row.is_active && !usedIDs.has(Number(row.ID)) && !retiredIDs.has(Number(row.ID)));
    if (unexpected.length) throw new Error(`Unplanned active categories: ${unexpected.map(row => row.name).join(', ')}`);
    if (!byKey.has(specification.defaultCategory) || byKey.get(specification.defaultCategory).parent !== null) {
        throw new Error('The default category must be a root');
    }
    for (const key of Object.keys(specification.dimensions)) {
        if (!byKey.has(key) || plan.some(node => node.parent === key)) {
            throw new Error(`Context dimensions must belong to a leaf category: ${key}`);
        }
    }
    return plan;
}

export function desiredDimensions(key, specification = taxonomy) {
    return (specification.dimensions[key] ?? []).map((dimension, index) => {
        const options = [specification.neutralOption, ...dimension.options];
        if (new Set(options.map(option => option.key)).size !== options.length) {
            throw new Error(`Duplicate context option: ${key}/${dimension.key}`);
        }
        return { key: dimension.key, name: dimension.name, position: (index + 1) * 10,
            options: options.map((option, optionIndex) => ({ ...option, position: optionIndex * 10,
                isDefault: optionIndex === 0, isNeutral: optionIndex === 0 })) };
    });
}

function storedDimensions(categoryID, dimensions, options) {
    return dimensions.filter(row => Number(row.scope_category_ID) === categoryID)
        .sort((a, b) => Number(a.position) - Number(b.position) || Number(a.ID) - Number(b.ID))
        .map(row => ({ key: row.dimension_key, name: row.name, position: Number(row.position),
            options: options.filter(option => Number(option.dimension_ID) === Number(row.ID))
                .sort((a, b) => Number(a.position) - Number(b.position) || Number(a.ID) - Number(b.ID))
                .map(option => ({ key: option.option_key, name: option.name, position: Number(option.position),
                    isDefault: Boolean(option.is_default), isNeutral: Boolean(option.is_neutral) })) }));
}

async function inspect(connection, specification, { lock = false } = {}) {
    const suffix = lock ? ' FOR UPDATE' : '';
    const [allCategories] = await connection.query(`SELECT * FROM categories ORDER BY ID${suffix}`);
    const categories = allCategories.filter(row => row.owner_user_ID == null);
    const plan = planCategories(categories, specification);
    const [dimensions] = await connection.query(`SELECT * FROM ranking_dimensions ORDER BY ID${suffix}`);
    const [options] = await connection.query(`SELECT * FROM ranking_dimension_options ORDER BY ID${suffix}`);
    const [contexts] = await connection.query(`SELECT * FROM ranking_contexts ORDER BY ID${suffix}`);
    const activeIDs = new Set(plan.filter(row => row.ID !== null).map(row => row.ID));
    const retirements = (specification.retiredCategories ?? [])
        .filter(retired => categories.some(row => Number(row.ID) === retired.ID && row.is_active)).map(retired => ({ ...retired }));
    for (const retired of retirements) activeIDs.add(retired.ID);
    if (dimensions.some(row => row.is_active && !activeIDs.has(Number(row.scope_category_ID)))) {
        throw new Error('Unplanned active context dimension outside the requested taxonomy');
    }
    const changes = [];
    for (const node of plan) {
        const desired = desiredDimensions(node.key, specification);
        const current = node.ID === null ? [] : storedDimensions(node.ID, dimensions, options);
        if (JSON.stringify(current) === JSON.stringify(desired)) continue;
        const existingDimensions = dimensions.filter(row => Number(row.scope_category_ID) === node.ID);
        if (existingDimensions.some(row => !row.is_active)) {
            throw new Error(`Unexpected inactive dimension for ${node.name}`);
        }
        const affectedContexts = contexts.filter(row => Number(row.category_ID) === node.ID);
        const retainedContextIDs = [], invalidContexts = [];
        for (const context of affectedContexts) {
            const [[counts]] = await connection.execute(`SELECT
                (SELECT COUNT(*) FROM personal_pies WHERE context_ID = ?) AS pies,
                (SELECT COUNT(*) FROM discussion_posts WHERE context_ID = ?) AS discussions`, [context.ID, context.ID]);
            if (!specification.preservePersonalPies && (Number(counts.pies) || Number(counts.discussions))) {
                throw new Error(`Cannot replace contexts used by personal pies or discussions: ${node.name} #${context.ID}`);
            }
            let valid = false;
            try { canonicalizeContextValues(typeof context.context_values === 'string' ? JSON.parse(context.context_values) : context.context_values,
                desired, { requireAllDimensions: true }); valid = true; }
            catch (error) { if (!error.body) throw error; }
            if (valid || Number(counts.discussions)) retainedContextIDs.push(Number(context.ID));
            if (!valid) invalidContexts.push({ ID: Number(context.ID), pieCount: Number(counts.pies) });
        }
        changes.push({ key: node.key, previous: current, desired,
            dimensionIDs: existingDimensions.map(row => Number(row.ID)), contextIDs: affectedContexts.map(row => Number(row.ID)),
            retainedContextIDs, invalidContexts });
    }
    for (const retired of retirements) {
        const [[counts]] = await connection.execute(`SELECT
            (SELECT COUNT(*) FROM personal_pies p JOIN ranking_contexts c ON c.ID = p.context_ID WHERE c.category_ID = ?) AS pies,
            (SELECT COUNT(*) FROM discussion_posts WHERE category_ID = ?) AS discussions`, [retired.ID, retired.ID]);
        const retainedChild = categories.some(row => Number(row.parent_ID) === retired.ID
            && !plan.some(node => node.ID === Number(row.ID))
            && !retirements.some(node => node.ID === Number(row.ID)));
        if (!specification.preservePersonalPies && (Number(counts.pies) || Number(counts.discussions) || retainedChild)) {
            throw new Error(`Cannot remove a category with retained data: ${retired.name}`);
        }
        retired.contextIDs = contexts.filter(row => Number(row.category_ID) === retired.ID).map(row => Number(row.ID));
        retired.dimensionIDs = dimensions.filter(row => Number(row.scope_category_ID) === retired.ID).map(row => Number(row.ID));
    }
    return { categories: plan, dimensions: changes, retirements };
}

async function writePlan(connection, plan, specification) {
    const ids = new Map();
    for (const node of plan.categories) {
        const parentID = node.parent === null ? null : ids.get(node.parent);
        if (node.ID === null) {
            const [insert] = await connection.execute(
                'INSERT INTO categories (parent_ID, name, position) VALUES (?, ?, ?)', [parentID, node.name, node.position]);
            ids.set(node.key, Number(insert.insertId));
        } else {
            if (node.previous.parentID !== parentID || node.previous.name !== node.name || node.previous.position !== node.position) {
                await connection.execute('UPDATE categories SET parent_ID = ?, name = ?, position = ? WHERE ID = ?',
                    [parentID, node.name, node.position, node.ID]);
            }
            ids.set(node.key, node.ID);
        }
    }
    for (const change of plan.dimensions) {
        if (specification.preservePersonalPies) {
            const node = plan.categories.find(node => node.key === change.key);
            for (const context of change.invalidContexts) {
                if (context.pieCount) await preserveContextPies(connection, context.ID, node.name, node.name);
            }
        }
        for (const ID of change.contextIDs.filter(ID => !change.retainedContextIDs.includes(ID))) {
            await connection.execute('DELETE FROM ranking_contexts WHERE ID = ?', [ID]);
        }
        for (const ID of change.dimensionIDs) await connection.execute('DELETE FROM ranking_dimensions WHERE ID = ?', [ID]);
        for (const dimension of change.desired) {
            const [insert] = await connection.execute(`INSERT INTO ranking_dimensions
                (scope_category_ID, dimension_key, name, position) VALUES (?, ?, ?, ?)`,
            [ids.get(change.key), dimension.key, dimension.name, dimension.position]);
            for (const option of dimension.options) {
                await connection.execute(`INSERT INTO ranking_dimension_options
                    (dimension_ID, option_key, name, position, is_default, is_neutral) VALUES (?, ?, ?, ?, ?, ?)`,
                [insert.insertId, option.key, option.name, option.position, Number(option.isDefault), Number(option.isNeutral)]);
            }
        }
    }
    for (const retired of [...plan.retirements].reverse()) {
        if (specification.preservePersonalPies) {
            await retirePublicCategory(connection, retired.ID);
            await connection.execute('UPDATE ranking_dimensions SET is_active = 0 WHERE scope_category_ID = ?', [retired.ID]);
            continue;
        }
        for (const ID of retired.contextIDs) await connection.execute('DELETE FROM ranking_contexts WHERE ID = ?', [ID]);
        for (const ID of retired.dimensionIDs) await connection.execute('DELETE FROM ranking_dimensions WHERE ID = ?', [ID]);
        await connection.execute('DELETE FROM categories WHERE ID = ?', [retired.ID]);
    }
    return ids;
}

function databaseConfig() {
    return {
        socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_SOCKET ? undefined : process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4'
    };
}

async function main() {
    const apply = process.argv.includes('--apply');
    const rehearse = process.argv.includes('--rehearse');
    const specificationPath = process.argv.find(argument => argument.startsWith('--spec='))?.slice(7);
    const specification = specificationPath ? JSON.parse(readFileSync(resolve(specificationPath), 'utf8')) : taxonomy;
    const connection = await mysql.createConnection(databaseConfig());
    try {
        const preliminary = await inspect(connection, specification);
        if (!apply && !rehearse) {
            console.log(JSON.stringify({ applied: false, ...preliminary }, null, 2));
            return;
        }
        const [columns] = await connection.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories' AND COLUMN_NAME = 'position'`);
        if (!columns.length) await connection.query('ALTER TABLE categories ADD COLUMN position SMALLINT UNSIGNED NOT NULL DEFAULT 0');
        await connection.beginTransaction();
        const plan = await inspect(connection, specification, { lock: true });
        const ids = await writePlan(connection, plan, specification);
        const verified = await inspect(connection, specification, { lock: true });
        if (verified.dimensions.length || verified.retirements.length || verified.categories.some(node => node.ID === null
            || node.previous.name !== node.name || node.previous.position !== node.position
            || node.previous.parentID !== (node.parent === null ? null : ids.get(node.parent)))) {
            throw new Error('Taxonomy verification failed before commit');
        }
        if (apply) await connection.commit();
        else await connection.rollback();
        console.log(JSON.stringify({ applied: apply, rehearsed: rehearse, categoryCount: ids.size,
            categories: plan.categories.map(node => ({ ID: ids.get(node.key), parentID: node.parent === null ? null : ids.get(node.parent),
                name: node.name, position: node.position })), changedDimensionScopes: plan.dimensions.map(item => item.key),
            removedCategoryIDs: plan.retirements.map(item => item.ID) }, null, 2));
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        await connection.end();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
