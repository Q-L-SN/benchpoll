#!/usr/bin/env node
import { normalizeScoreFields } from '../public/js/shared/score-fields.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { DEFAULT_RANKING_CATEGORY_NAME } from '../ranking-entry-url.js';
import { loadBenchmarkFamilies } from '../benchmark-family-service.js';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';

function readCredentialFile() {
    const environmentPassword = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (environmentPassword !== undefined) {
        return {
            socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
            host: process.env.BENCHPOLL_DB_HOST || 'localhost',
            port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
            user: process.env.BENCHPOLL_DB_USER || 'root',
            password: environmentPassword,
            database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
            charset: 'utf8mb4'
        };
    }
    const credentialPath = path.resolve('db-credentials.local.md');
    if (!fs.existsSync(credentialPath)) {
        throw new Error('Database credentials are unavailable.');
    }
    const content = fs.readFileSync(credentialPath, 'utf8');
    const readValue = key => content
        .match(new RegExp(`^${key}\\s*[:=]\\s*[\\x60\"]?(.+?)[\\x60\"]?\\s*$`, 'mi'))?.[1]
        ?.trim();
    const config = {
        host: readValue('host') || 'localhost',
        port: Number(readValue('port') || 3306),
        user: readValue('user'),
        password: readValue('password'),
        database: readValue('database') || 'benchmarks',
        charset: 'utf8mb4'
    };
    if (!config.user || config.password === undefined || !Number.isInteger(config.port)) {
        throw new Error('Database credentials are incomplete.');
    }
    return config;
}

async function scalar(connection, sql, params = []) {
    const [rows] = await connection.execute(sql, params);
    return Number(Object.values(rows[0] ?? { value: 0 })[0]);
}

async function hasColumn(connection, table, column) {
    return await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]) === 1;
}

async function hasTable(connection, table) {
    return await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]) === 1;
}

async function hasIndex(connection, table, index) {
    return await scalar(connection, `
        SELECT COUNT(DISTINCT INDEX_NAME) AS count
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, index]) === 1;
}

async function hasConstraint(connection, table, constraint) {
    return await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [table, constraint]) === 1;
}

function integrityCheck(name, count, details = undefined, severity = 'error') {
    return {
        name,
        count: Number(count),
        severity,
        passed: Number(count) === 0,
        ...(details === undefined ? {} : { details })
    };
}

function contextValues(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
}

export async function readTopicReferenceSchema(connection) {
    const tables = {};
    for (const table of ['topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock']) {
        tables[table] = await hasTable(connection, table);
    }
    const migrated = await scalar(connection, `SELECT COUNT(*) AS count FROM schema_migrations
        WHERE migration_id = 'topic_scenes_references_20261031'`) === 1;
    const enabled = migrated || Object.values(tables).some(Boolean);
    const checks = [];
    if (enabled) {
        checks.push(integrityCheck('topic scenes migration missing', migrated ? 0 : 1));
        for (const [table, exists] of Object.entries(tables)) {
            checks.push(integrityCheck(`topic reference table missing: ${table}`, exists ? 0 : 1));
        }
        for (const [table, constraint] of [
            ['topic_scenes', 'fk_topic_scene_context'],
            ['topic_scenes', 'fk_topic_scene_category'],
            ['personal_pie_topic_weights', 'fk_topic_weight_pie'],
            ['personal_pie_topic_weights', 'fk_topic_weight_context']
        ]) {
            if (tables[table]) checks.push(integrityCheck(`topic reference foreign key missing: ${constraint}`,
                await hasConstraint(connection, table, constraint) ? 0 : 1));
        }
        for (const [table, index] of [
            ['ranking_contexts', 'uq_ranking_context_identity'],
            ['topic_scenes', 'uq_topic_scene_default']
        ]) {
            if (table === 'ranking_contexts' || tables[table]) {
                checks.push(integrityCheck(`scene identity index missing: ${index}`,
                    await hasIndex(connection, table, index) ? 0 : 1));
            }
        }
        if (tables.topic_reference_lock) {
            checks.push(integrityCheck('topic reference graph lock missing or invalid', await scalar(connection,
                'SELECT ABS(COUNT(*) - 1) + COALESCE(SUM(ID <> 1), 0) AS count FROM topic_reference_lock')));
        }
    }
    return { enabled, tables, checks };
}

export function inspectTopicSceneIntegrity({ categories, contexts, scenes, referencedContextIDs = [] }) {
    const categoryByID = new Map(categories.map(row => [Number(row.ID), row]));
    const contextByID = new Map(contexts.map(row => [Number(row.ID), row]));
    const sceneByContextID = new Map();
    const activeScenesByCategoryID = new Map();
    const invalidParents = [], invalidIdentities = [], invalidFlags = [], duplicateIdentities = [];
    for (const scene of scenes) {
        const contextID = Number(scene.context_ID), categoryID = Number(scene.category_ID);
        const category = categoryByID.get(categoryID), context = contextByID.get(contextID);
        const values = contextValues(context?.context_values);
        const expected = JSON.stringify({ scene: String(contextID) });
        if (!category || category.parent_ID !== null) invalidParents.push(contextID);
        if (!Number.isSafeInteger(contextID) || contextID <= 0 || !context
            || Number(context.category_ID) !== categoryID || !values
            || Object.keys(values).length !== 1 || values.scene !== String(contextID)
            || context.context_hash !== crypto.createHash('sha256').update(expected).digest('hex')) {
            invalidIdentities.push(contextID);
        }
        if (sceneByContextID.has(contextID)) duplicateIdentities.push(contextID);
        sceneByContextID.set(contextID, scene);
        if (scene.is_active == null || scene.is_default == null
            || ![0, 1].includes(Number(scene.is_active)) || ![0, 1].includes(Number(scene.is_default))
            || (Number(scene.is_default) === 1 && Number(scene.is_active) !== 1)) invalidFlags.push(contextID);
        if (Number(scene.is_active) === 1) {
            if (!activeScenesByCategoryID.has(categoryID)) activeScenesByCategoryID.set(categoryID, []);
            activeScenesByCategoryID.get(categoryID).push(scene);
        }
    }
    const invalidDefaults = [...activeScenesByCategoryID].filter(([, rows]) =>
        rows.filter(row => Number(row.is_default) === 1).length !== 1).map(([ID]) => ID);
    const rootCategoryIDs = new Set(contexts.filter(context => {
        const values = contextValues(context.context_values);
        return values && Object.keys(values).length === 0 && !sceneByContextID.has(Number(context.ID));
    }).map(context => Number(context.category_ID)));
    const missingRoots = categories.filter(category => Number(category.is_active) === 1
        && !activeScenesByCategoryID.has(Number(category.ID)) && !rootCategoryIDs.has(Number(category.ID)))
        .map(category => Number(category.ID));
    const unregisteredScenes = contexts.filter(context => {
        const values = contextValues(context.context_values);
        return values && Object.hasOwn(values, 'scene') && !sceneByContextID.has(Number(context.ID));
    }).map(context => Number(context.ID));
    // Retired scenes and unused legacy contexts keep their stable identity for historical data.
    const invalidReferencedContexts = [...new Set(referencedContextIDs.map(Number))].filter(ID => {
        const context = contextByID.get(ID);
        if (!context) return true;
        const category = categoryByID.get(Number(context.category_ID));
        if (!category) return true;
        if (Number(category.is_active) !== 1 || sceneByContextID.has(ID)) return false;
        const values = contextValues(context.context_values);
        return activeScenesByCategoryID.has(Number(category.ID)) || !values || Object.keys(values).length !== 0;
    });
    return [
        integrityCheck('topics with nested parents', categories.filter(row => row.parent_ID !== null).length),
        integrityCheck('scenes without a root topic', invalidParents.length, invalidParents),
        integrityCheck('scenes with invalid active/default flags', invalidFlags.length, invalidFlags),
        integrityCheck('topics without exactly one active default scene', invalidDefaults.length, invalidDefaults),
        integrityCheck('active topics without scenes lack a root context', missingRoots.length, missingRoots),
        integrityCheck('scenes with mismatched context identity', invalidIdentities.length, invalidIdentities),
        integrityCheck('duplicate scene context identities', duplicateIdentities.length, duplicateIdentities),
        integrityCheck('scene contexts without a scene record', unregisteredScenes.length, unregisteredScenes),
        integrityCheck('referenced contexts are not a concrete topic or scene', invalidReferencedContexts.length, invalidReferencedContexts)
    ];
}

export async function countInvalidPersonalPieTotals(connection, includeTopicReferences) {
    // UNION ALL preserves equal weights and avoids multiplying rows in mixed configurations.
    return scalar(connection, `
        SELECT COUNT(*) AS count FROM (
            SELECT personal_pies.ID FROM personal_pies
            LEFT JOIN (
                SELECT pie_ID, weight_basis_points FROM personal_pie_weights
                ${includeTopicReferences ? 'UNION ALL SELECT pie_ID, weight_basis_points FROM personal_pie_topic_weights' : ''}
            ) weights ON weights.pie_ID = personal_pies.ID
            GROUP BY personal_pies.ID
            HAVING COALESCE(SUM(weights.weight_basis_points), 0) NOT IN (0, 10000)
        ) invalid_pies`);
}

export async function checkRankingIntegrity(connection) {
    const checks = [];
    const record = (name, count, severity = 'error', details = undefined) => {
        checks.push(integrityCheck(name, count, details, severity));
    };
    const topicSchema = await readTopicReferenceSchema(connection);
    checks.push(...topicSchema.checks);
    record('strict benchmark schema migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations
            WHERE migration_id = '015_strict_benchmark_schema'
        ) THEN 0 ELSE 1 END AS count`));
    record('obsolete benchmark-condition active column',
        await hasColumn(connection, 'benchmark_conditions', 'is_active') ? 1 : 0);
    record('benchmark-condition deletion column missing',
        await hasColumn(connection, 'benchmark_conditions', 'deleted_at') ? 0 : 1);
    record('required score ranges migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations
            WHERE migration_id = '017_required_score_ranges'
        ) THEN 0 ELSE 1 END AS count`));
    record('result median migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations
            WHERE migration_id = '020_result_medians'
        ) THEN 0 ELSE 1 END AS count`));
    record('context-free result migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations
            WHERE migration_id = '021_context_free_results'
        ) THEN 0 ELSE 1 END AS count`));
    record('ordered benchmark families migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(SELECT 1 FROM schema_migrations
            WHERE migration_id = '050_ordered_benchmark_families') THEN 0 ELSE 1 END AS count`));
    const fallbackRuleTableExists = await hasTable(connection, 'personal_pie_score_rules');
    const familyTableExists = await hasTable(connection, 'benchmark_families');
    const familyMemberTableExists = await hasTable(connection, 'benchmark_family_members');
    record('personal family association table missing', fallbackRuleTableExists ? 0 : 1);
    record('benchmark family catalogue missing', familyTableExists ? 0 : 1);
    record('benchmark family member table missing', familyMemberTableExists ? 0 : 1);
    record('obsolete weighted component table remains', await hasTable(connection, 'personal_pie_score_rule_components') ? 1 : 0);
    record('obsolete fallback mode column remains', await hasColumn(connection, 'personal_pie_score_rules', 'mode') ? 1 : 0);
    if (fallbackRuleTableExists && familyTableExists && familyMemberTableExists) {
        for (const [table, constraint] of [
            ['personal_pie_score_rules', 'fk_ordered_rule_weight'],
            ['personal_pie_score_rules', 'fk_ordered_rule_family'],
            ['benchmark_families', 'fk_family_primary'],
            ['benchmark_family_members', 'fk_family_member_family'],
            ['benchmark_family_members', 'fk_family_member_condition']
        ]) record('family foreign key missing: ' + table + '.' + constraint,
            await hasConstraint(connection, table, constraint) ? 0 : 1);
    }
    for (const legacyTable of [
        'objects', 'evaluation_profiles', 'evaluation_tags', 'evaluation_object_tags',
        'evaluation_results', 'model_configurations', 'votes', 'category_templates', 'model_conditions'
    ]) {
        record(`legacy table remains: ${legacyTable}`, await hasTable(connection, legacyTable) ? 1 : 0);
    }
    for (const [table, column] of [
        ['categories', 'template'], ['categories', 'is_folder'],
        ['benchmark_results', 'model_condition_ID'], ['benchmark_results', 'model_condition_snapshot'],
        ['users', 'vote_quota'], ['users', 'vote_used'], ['models', 'url'],
        ['vendors', 'url'], ['ranking_contexts', 'template_values'],
        ['ranking_contexts', 'template_hash']
    ]) {
        record(`legacy column remains: ${table}.${column}`, await hasColumn(connection, table, column) ? 1 : 0);
    }
    record('models.introduction_url is missing',
        await hasColumn(connection, 'models', 'introduction_url') ? 0 : 1);
    record('ranking_contexts.context_values is missing',
        await hasColumn(connection, 'ranking_contexts', 'context_values') ? 0 : 1);
    record('ranking_contexts.context_hash is missing',
        await hasColumn(connection, 'ranking_contexts', 'context_hash') ? 0 : 1);
    record('legacy personal pie identity column remains',
        await hasColumn(connection, 'personal_pie_weights', 'benchmark_ID') ? 1 : 0);
    record('benchmark condition pie identity column missing',
        await hasColumn(connection, 'personal_pie_weights', 'benchmark_condition_ID') ? 0 : 1);
    for (const [table, constraint] of [
        ['benchmark_conditions', 'fk_benchmark_conditions_benchmark'],
        ['benchmark_results', 'fk_benchmark_results_benchmark_condition'],
        ['personal_pie_weights', 'fk_personal_pie_weights_condition']
    ]) {
        record(
            `condition identity foreign key missing: ${table}.${constraint}`,
            await hasConstraint(connection, table, constraint) ? 0 : 1
        );
    }
    record('obsolete benchmark result ranking context remains',
        await hasColumn(connection, 'benchmark_results', 'ranking_context_ID') ? 1 : 0);
    record('obsolete accepted-result unique index remains',
        await hasIndex(connection, 'benchmark_results', 'uq_benchmark_results_current_context') ? 1 : 0);
    record('obsolete benchmark_results.current_marker remains',
        await hasColumn(connection, 'benchmark_results', 'current_marker') ? 1 : 0);
    record('personal pie user-context unique index missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM (
                SELECT INDEX_NAME, NON_UNIQUE,
                       GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS indexed_columns
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_pies'
                GROUP BY INDEX_NAME, NON_UNIQUE
            ) indexes
            WHERE indexes.NON_UNIQUE = 0
              AND indexes.indexed_columns = 'user_ID,context_ID'
        ) THEN 0 ELSE 1 END AS count`));
    record('ranking integrity migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations WHERE migration_id = '005_ranking_integrity'
        ) THEN 0 ELSE 1 END AS count`));
    record('category integrity migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations WHERE migration_id = '006_category_integrity'
        ) THEN 0 ELSE 1 END AS count`));
    record('category sibling unique index missing',
        await hasIndex(connection, 'categories', 'uq_categories_parent_name') ? 0 : 1);
    record('category tree integrity migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations WHERE migration_id = '007_category_tree_integrity'
        ) THEN 0 ELSE 1 END AS count`));
    record('category parent foreign key missing',
        await hasConstraint(connection, 'categories', 'fk_categories_parent') ? 0 : 1);
    record('default category is missing or duplicated', await scalar(connection, `
        SELECT ABS(COUNT(*) - 1) AS count
        FROM categories
        WHERE parent_ID IS NULL AND is_active = 1 AND name = ?`, [DEFAULT_RANKING_CATEGORY_NAME]));
    record('active category nodes have inactive parents', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM categories AS child
        JOIN categories AS parent ON parent.ID = child.parent_ID
        WHERE child.is_active = 1 AND parent.is_active = 0`));
    record('orphan category nodes', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM categories AS child
        LEFT JOIN categories AS parent ON parent.ID = child.parent_ID
        WHERE child.parent_ID IS NOT NULL AND parent.ID IS NULL`));
    record('cyclic category nodes', await scalar(connection, `
        WITH RECURSIVE walk AS (
            SELECT ID, parent_ID, CAST(ID AS CHAR(4096)) AS visited, 0 AS cycle
            FROM categories
            UNION ALL
            SELECT walk.ID, parent.parent_ID,
                   CONCAT(walk.visited, ',', parent.ID),
                   FIND_IN_SET(parent.ID, walk.visited) > 0
            FROM walk
            JOIN categories AS parent ON parent.ID = walk.parent_ID
            WHERE walk.parent_ID IS NOT NULL AND walk.cycle = 0
        )
        SELECT COUNT(*) AS count FROM walk WHERE cycle = 1`));
    record('context dimensions reference missing categories', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM ranking_dimensions
        LEFT JOIN categories ON categories.ID = ranking_dimensions.scope_category_ID
        WHERE ranking_dimensions.scope_category_ID <> 0 AND categories.ID IS NULL`));
    record('canonical ranking context hash migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations
            WHERE migration_id = '008_canonical_ranking_context_hashes'
        ) THEN 0 ELSE 1 END AS count`));
    record('non-leaf ranking context migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations
            WHERE migration_id = '009_nonleaf_ranking_context_integrity'
        ) THEN 0 ELSE 1 END AS count`));
    const [categoryRows] = await connection.execute(`
        SELECT ID, parent_ID, name, is_active FROM categories`);
    const categoryByID = new Map(categoryRows.map(category => [Number(category.ID), {
        ID: Number(category.ID),
        parentID: category.parent_ID === null ? null : Number(category.parent_ID),
        name: category.name,
        isActive: Number(category.is_active) === 1
    }]));
    const activeChildCategoryIDs = new Set(categoryRows
        .filter(category => category.parent_ID !== null && Number(category.is_active) === 1)
        .map(category => Number(category.parent_ID)));
    const [dimensionRows] = await connection.execute(`
        SELECT ID, scope_category_ID, dimension_key
        FROM ranking_dimensions
        WHERE is_active = 1`);
    const [dimensionOptionRows] = await connection.execute(`
        SELECT dimension_ID, option_key
        FROM ranking_dimension_options`);
    const optionKeysByDimensionID = new Map();
    for (const option of dimensionOptionRows) {
        const dimensionID = Number(option.dimension_ID);
        if (!optionKeysByDimensionID.has(dimensionID)) {
            optionKeysByDimensionID.set(dimensionID, new Set());
        }
        optionKeysByDimensionID.get(dimensionID).add(String(option.option_key));
    }
    const dimensionsByScopeID = new Map();
    for (const dimension of dimensionRows) {
        const scopeID = Number(dimension.scope_category_ID);
        if (!dimensionsByScopeID.has(scopeID)) {
            dimensionsByScopeID.set(scopeID, []);
        }
        dimensionsByScopeID.get(scopeID).push({
            ID: Number(dimension.ID),
            key: String(dimension.dimension_key)
        });
    }
    const categoryLineage = categoryID => {
        const lineage = [];
        const visited = new Set();
        let cursorID = categoryID;
        while (cursorID !== null) {
            if (visited.has(cursorID) || !categoryByID.has(cursorID)) {
                return null;
            }
            visited.add(cursorID);
            lineage.unshift(cursorID);
            cursorID = categoryByID.get(cursorID).parentID;
        }
        return lineage;
    };
    let inheritedDimensionConflicts = 0;
    for (const category of categoryByID.values()) {
        const lineage = categoryLineage(category.ID);
        if (lineage === null) continue;
        const inheritedKeys = new Set((dimensionsByScopeID.get(0) ?? []).map(dimension => dimension.key));
        for (const scopeID of lineage) {
            for (const dimension of dimensionsByScopeID.get(scopeID) ?? []) {
                if (inheritedKeys.has(dimension.key)) inheritedDimensionConflicts += 1;
                inheritedKeys.add(dimension.key);
            }
        }
    }
    record('active context dimensions shadow global or ancestor keys', inheritedDimensionConflicts);

    const [rankingContexts] = await connection.execute(`
        SELECT ID, category_ID, context_values, context_hash
        FROM ranking_contexts`);
    const [pieReferenceRows] = await connection.execute(`
        SELECT context_ID, COUNT(*) AS count
        FROM personal_pies
        GROUP BY context_ID`);
    const pieReferencesByContextID = new Map(pieReferenceRows.map(row => [
        Number(row.context_ID),
        Number(row.count)
    ]));
    if (topicSchema.enabled) {
        const [scenes] = topicSchema.tables.topic_scenes ? await connection.execute(`
            SELECT context_ID, category_ID, is_active, is_default FROM topic_scenes`) : [[]];
        const [referenceTargets] = topicSchema.tables.personal_pie_topic_weights ? await connection.execute(`
            SELECT DISTINCT target_context_ID AS context_ID FROM personal_pie_topic_weights`) : [[]];
        checks.push(...inspectTopicSceneIntegrity({
            categories: categoryRows, contexts: rankingContexts, scenes,
            referencedContextIDs: [...pieReferenceRows, ...referenceTargets].map(row => row.context_ID)
        }));
        record('legacy context selectors remain active on current topics', dimensionRows.filter(row =>
            Number(row.scope_category_ID) === 0 || categoryByID.get(Number(row.scope_category_ID))?.isActive).length);
    }
    let invalidContextJSON = 0;
    let noncanonicalContextHashes = 0;
    let duplicateCanonicalContexts = 0;
    const contextDimensionSetMismatchDetails = [];
    const contextOptionMismatchDetails = [];
    const canonicalContextIdentities = new Set();
    for (const context of rankingContexts) {
        const values = contextValues(context.context_values);
        if (!values) {
            invalidContextJSON += 1;
            continue;
        }
        const canonical = Object.fromEntries(
            Object.keys(values).sort().map(key => [key, values[key]])
        );
        const serialized = JSON.stringify(canonical);
        const hash = crypto.createHash('sha256').update(serialized).digest('hex');
        if (hash !== context.context_hash) noncanonicalContextHashes += 1;
        const identity = `${context.category_ID}:${hash}`;
        if (canonicalContextIdentities.has(identity)) duplicateCanonicalContexts += 1;
        canonicalContextIdentities.add(identity);

        const categoryID = Number(context.category_ID);
        const lineage = categoryLineage(categoryID);
        if (lineage === null) {
            contextDimensionSetMismatchDetails.push({
                contextID: Number(context.ID),
                categoryID,
                categoryName: categoryByID.get(categoryID)?.name ?? null,
                error: 'category_lineage_unavailable'
            });
            continue;
        }
        if (topicSchema.enabled) continue;
        const effectiveDimensions = new Map();
        if (!activeChildCategoryIDs.has(categoryID)) {
            for (const scopeID of [0, ...lineage]) {
                for (const dimension of dimensionsByScopeID.get(scopeID) ?? []) {
                    effectiveDimensions.set(dimension.key, dimension);
                }
            }
        }
        const actualKeys = Object.keys(values).sort();
        const expectedKeys = [...effectiveDimensions.keys()].sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
            contextDimensionSetMismatchDetails.push({
                contextID: Number(context.ID),
                categoryID,
                categoryName: categoryByID.get(categoryID)?.name ?? null,
                actualKeys,
                expectedKeys,
                personalPieCount: pieReferencesByContextID.get(Number(context.ID)) ?? 0
            });
            continue;
        }
        for (const [key, dimension] of effectiveDimensions) {
            if (!optionKeysByDimensionID.get(dimension.ID)?.has(String(values[key]))) {
                contextOptionMismatchDetails.push({
                    contextID: Number(context.ID),
                    categoryID,
                    categoryName: categoryByID.get(categoryID)?.name ?? null,
                    dimension: key,
                    value: values[key]
                });
                break;
            }
        }
    }
    record('ranking contexts with invalid context JSON', invalidContextJSON);
    record('ranking contexts with noncanonical hashes', noncanonicalContextHashes);
    record('semantically duplicate ranking contexts', duplicateCanonicalContexts);
    record(
        'ranking contexts with missing or unknown dimensions',
        contextDimensionSetMismatchDetails.length,
        'error',
        contextDimensionSetMismatchDetails
    );
    record(
        'ranking contexts with unavailable option values',
        contextOptionMismatchDetails.length,
        'error',
        contextOptionMismatchDetails
    );

    record('personal pies with totals other than zero or 100 percent',
        await countInvalidPersonalPieTotals(connection, topicSchema.tables.personal_pie_topic_weights));
    if (topicSchema.tables.personal_pie_topic_weights) {
        record('topic reference weights with missing pie or target context', await scalar(connection, `
            SELECT COUNT(*) AS count FROM personal_pie_topic_weights weights
            LEFT JOIN personal_pies pies ON pies.ID = weights.pie_ID
            LEFT JOIN ranking_contexts contexts ON contexts.ID = weights.target_context_ID
            WHERE pies.ID IS NULL OR contexts.ID IS NULL`));
        record('topic reference weights outside 100 to 10000 basis points', await scalar(connection, `
            SELECT COUNT(*) AS count FROM personal_pie_topic_weights
            WHERE weight_basis_points IS NULL OR weight_basis_points NOT BETWEEN 100 AND 10000`));
    }
    record('duplicate personal pies per user and context', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM (
            SELECT user_ID, context_ID
            FROM personal_pies
            GROUP BY user_ID, context_ID
            HAVING COUNT(*) > 1
        ) duplicate_pies`));
    record('personal pies referencing deleted benchmark conditions', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM personal_pie_weights
        LEFT JOIN benchmark_conditions
          ON benchmark_conditions.ID = personal_pie_weights.benchmark_condition_ID
         AND benchmark_conditions.deleted_at IS NULL
        WHERE benchmark_conditions.ID IS NULL`));
    if (fallbackRuleTableExists && familyTableExists && familyMemberTableExists) {
        record('family associations without their entrance weight', await scalar(connection, `
            SELECT COUNT(*) AS count FROM personal_pie_score_rules rules
            LEFT JOIN personal_pie_weights weights ON weights.pie_ID = rules.pie_ID
                AND weights.benchmark_condition_ID = rules.primary_benchmark_condition_ID
            WHERE weights.pie_ID IS NULL`));
        record('family associations referencing a different entrance', await scalar(connection, `
            SELECT COUNT(*) AS count FROM personal_pie_score_rules rules
            LEFT JOIN benchmark_families families ON families.ID = rules.family_ID
                AND families.primary_benchmark_condition_ID = rules.primary_benchmark_condition_ID
            WHERE rules.family_ID IS NOT NULL AND families.ID IS NULL`));
        record('family members referencing themselves or deleted conditions', await scalar(connection, `
            SELECT COUNT(*) AS count FROM benchmark_family_members members
            JOIN benchmark_families families ON families.ID = members.family_ID
            LEFT JOIN benchmark_conditions conditions ON conditions.ID = members.benchmark_condition_ID
                AND conditions.deleted_at IS NULL
            WHERE members.benchmark_condition_ID IS NOT NULL
                AND (conditions.ID IS NULL OR members.benchmark_condition_ID = families.primary_benchmark_condition_ID)`));
        record('family entrances referencing deleted conditions', await scalar(connection, `
            SELECT COUNT(*) AS count FROM benchmark_families families
            LEFT JOIN benchmark_conditions conditions ON conditions.ID = families.primary_benchmark_condition_ID
                AND conditions.deleted_at IS NULL WHERE conditions.ID IS NULL`));
        let invalidFamilies = 0;
        try { await loadBenchmarkFamilies(connection); }
        catch (error) {
            if (error.body?.error !== 'benchmark_family_invariant_failed') throw error;
            invalidFamilies = 1;
        }
        record('family catalogue has invalid member order or identity hash', invalidFamilies);
    }
    record('active context dimensions with invalid option invariants', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM (
            SELECT ranking_dimensions.ID
            FROM ranking_dimensions
            LEFT JOIN ranking_dimension_options
              ON ranking_dimension_options.dimension_ID = ranking_dimensions.ID
            WHERE ranking_dimensions.is_active = 1
            GROUP BY ranking_dimensions.ID
            HAVING COUNT(ranking_dimension_options.ID) < 2
                OR SUM(ranking_dimension_options.is_default) <> 1
                OR SUM(ranking_dimension_options.is_neutral) <> 1
        ) invalid_dimensions`));
    record('context dimensions attached to non-leaf categories', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM ranking_dimensions
        JOIN categories AS scope_category
          ON scope_category.ID = ranking_dimensions.scope_category_ID
         AND scope_category.is_active = 1
        WHERE ranking_dimensions.is_active = 1
          AND ranking_dimensions.scope_category_ID <> 0
          AND EXISTS (
              SELECT 1 FROM categories child
              WHERE child.parent_ID = ranking_dimensions.scope_category_ID
                AND child.is_active = 1
          )`));
    record('duplicate category names under one parent', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM (
            SELECT parent_ID, name
            FROM categories
            GROUP BY parent_ID, name
            HAVING COUNT(*) > 1
        ) duplicate_categories`));

    record('accepted results with mismatched model or benchmark identity', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_results
        LEFT JOIN models ON models.ID = benchmark_results.model_ID
        LEFT JOIN benchmark_conditions
          ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
        WHERE benchmark_results.status = 'accepted'
          AND (models.ID IS NULL
               OR benchmark_conditions.ID IS NULL
               OR benchmark_conditions.benchmark_ID <> benchmark_results.benchmark_ID)`));
    record('percentage results outside 0 to 100', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_results
        JOIN benchmark_conditions
          ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
        WHERE benchmark_results.status = 'accepted'
          AND benchmark_conditions.uses_percentage_scale = 1
          AND (benchmark_results.raw_score < 0 OR benchmark_results.raw_score > 100)`));
    record('accepted results referencing unavailable ranking entities', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_results
        JOIN models ON models.ID = benchmark_results.model_ID
        JOIN benchmark_conditions
          ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
        WHERE benchmark_results.status = 'accepted'
          AND (models.is_active <> 1
               OR benchmark_conditions.deleted_at IS NOT NULL)`));
    record('benchmark conditions with invalid score invariants', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_conditions
        WHERE (uses_percentage_scale = 1
               AND (score_min IS NOT NULL OR score_max IS NOT NULL))
           OR (uses_percentage_scale = 0
               AND (score_min IS NULL OR score_max IS NULL OR score_max <= score_min))
           OR (score_direction = 'closer_to_target'
               AND (target_value IS NULL
                    OR (uses_percentage_scale = 1 AND (target_value < 0 OR target_value > 100))
                    OR (score_min IS NOT NULL AND target_value < score_min)
                    OR (score_max IS NOT NULL AND target_value > score_max)))
           OR (score_direction <> 'closer_to_target' AND target_value IS NOT NULL)`));
    record('accepted results without a source URL', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_results
        WHERE status = 'accepted' AND TRIM(source_url) = ''`));
    record('obsolete score provider columns', await scalar(connection, `SELECT COUNT(*) AS count
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'benchmark_results' AND COLUMN_NAME = 'provider_organization_ID')
          OR (TABLE_NAME = 'organizations' AND COLUMN_NAME = 'is_score_provider'))`));
    record('accepted results with invalid condition snapshots', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_results
        WHERE benchmark_results.status = 'accepted'
          AND (JSON_TYPE(benchmark_results.benchmark_condition_snapshot) <> 'OBJECT'
               OR JSON_EXTRACT(benchmark_results.benchmark_condition_snapshot, '$.conditionID') IS NULL
               OR CAST(JSON_UNQUOTE(JSON_EXTRACT(
                    benchmark_results.benchmark_condition_snapshot,
                    '$.conditionID'
                  )) AS UNSIGNED) <> benchmark_results.benchmark_condition_ID
               OR JSON_EXTRACT(benchmark_results.benchmark_condition_snapshot, '$.benchmarkID') IS NULL
               OR CAST(JSON_UNQUOTE(JSON_EXTRACT(
                    benchmark_results.benchmark_condition_snapshot,
                    '$.benchmarkID'
                  )) AS UNSIGNED) <> benchmark_results.benchmark_ID)`));
    record('score fields migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(SELECT 1 FROM schema_migrations WHERE migration_id = '029_score_fields') THEN 0 ELSE 1 END AS count`));
    const fields = await loadScoreFieldCatalog(connection);
    const [scores] = await connection.execute('SELECT ID, score_fields FROM benchmark_results');
    let invalidFields = 0;
    for (const score of scores) {
        try { normalizeScoreFields(typeof score.score_fields === 'string' ? JSON.parse(score.score_fields) : score.score_fields, fields); }
        catch { invalidFields++; }
    }
    record('invalid per-score field assignments', invalidFields);
    record('benchmark condition default flags that disagree with the literal default name', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_conditions
        WHERE deleted_at IS NULL
          AND (is_default <> (LOWER(TRIM(name)) = 'default')
               OR (condition_key = 'default') <> (LOWER(TRIM(name)) = 'default'))`));
    record('active benchmarks without a condition', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmarks
        WHERE benchmarks.is_active = 1
          AND NOT EXISTS (
              SELECT 1 FROM benchmark_conditions
              WHERE benchmark_conditions.benchmark_ID = benchmarks.ID
                AND benchmark_conditions.deleted_at IS NULL
          )`));
    record('malformed moderation JSON', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM moderation_logs
        WHERE JSON_VALID(content) = 0`));
    record('moderation records with noncanonical schema versions', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM moderation_logs
        WHERE status = 'pending' AND JSON_VALID(content) = 1
          AND COALESCE((
              JSON_TYPE(JSON_EXTRACT(content, '$.schemaVersion')) = 'INTEGER'
              AND (
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) IN ('feedback', 'report_issue', 'discussion_report', 'score_field', 'score_field_option')
                   AND JSON_EXTRACT(content, '$.schemaVersion') = 1)
                  OR
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) IN ('new_category', 'new_benchmark')
                   AND JSON_EXTRACT(content, '$.schemaVersion') = 5)
                  OR
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'new_model'
                   AND JSON_EXTRACT(content, '$.schemaVersion') = 6)
                  OR
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'benchmark_result'
                   AND JSON_EXTRACT(content, '$.schemaVersion') = 9)
                  OR
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'entity_change'
                   AND (
                       (JSON_UNQUOTE(JSON_EXTRACT(content, '$.targetKind')) = 'benchmark'
                        AND JSON_EXTRACT(content, '$.schemaVersion') = 5)
                       OR
                       (JSON_UNQUOTE(JSON_EXTRACT(content, '$.targetKind')) = 'model'
                        AND JSON_EXTRACT(content, '$.schemaVersion') = 6)
                       OR
                       (JSON_UNQUOTE(JSON_EXTRACT(content, '$.targetKind')) = 'result'
                        AND JSON_EXTRACT(content, '$.schemaVersion') = 9)
                   ))
              )
          ), 0) = 0`));
    record('pending context requests without usable options', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM moderation_logs
        WHERE status = 'pending'
          AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'new_category'
          AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.requestKind')) = 'context'
          AND COALESCE(JSON_LENGTH(JSON_EXTRACT(content, '$.options')), 0) < 2`));

    const failures = checks.filter(check => !check.passed && check.severity === 'error');
    return {
        status: failures.length === 0 ? 'passed' : 'failed',
        checks
    };
}

export async function runRankingIntegrityAudit(connection) {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try {
        return await checkRankingIntegrity(connection);
    } finally {
        await connection.rollback();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const connection = await mysql.createConnection(readCredentialFile());
    try {
        const report = await runRankingIntegrityAudit(connection);
        console.log(JSON.stringify(report, null, 2));
        if (report.status === 'failed') process.exitCode = 1;
    } finally {
        await connection.end();
    }
}
