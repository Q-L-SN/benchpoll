#!/usr/bin/env node
import { normalizeModelParameters, modelParameterLabel } from '../public/js/shared/model-parameters.js';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

function readCredentialFile() {
    const environmentPassword = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (environmentPassword !== undefined) {
        return {
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

const checks = [];
function record(name, count, severity = 'error', details = undefined) {
    checks.push({
        name,
        count: Number(count),
        severity,
        passed: Number(count) === 0,
        ...(details === undefined ? {} : { details })
    });
}

const connection = await mysql.createConnection(readCredentialFile());
try {
    record('strict benchmark schema migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations
            WHERE migration_id = '015_strict_benchmark_schema'
        ) THEN 0 ELSE 1 END AS count`));
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
    record('personal fallback rules migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(
            SELECT 1 FROM schema_migrations
            WHERE migration_id = '022_personal_fallback_rules'
        ) THEN 0 ELSE 1 END AS count`));
    const fallbackRuleTableExists = await hasTable(connection, 'personal_pie_score_rules');
    const fallbackComponentTableExists = await hasTable(connection, 'personal_pie_score_rule_components');
    record('personal fallback rule table missing', fallbackRuleTableExists ? 0 : 1);
    record('personal fallback component table missing', fallbackComponentTableExists ? 0 : 1);
    if (fallbackRuleTableExists && fallbackComponentTableExists) {
        for (const [table, constraint] of [
            ['personal_pie_score_rules', 'fk_pie_score_rule_primary_weight'],
            ['personal_pie_score_rule_components', 'fk_pie_score_component_rule'],
            ['personal_pie_score_rule_components', 'fk_pie_score_component_fallback']
        ]) {
            record(
                `personal fallback foreign key missing: ${table}.${constraint}`,
                await hasConstraint(connection, table, constraint) ? 0 : 1
            );
        }
    }
    for (const legacyTable of [
        'objects', 'evaluation_profiles', 'evaluation_tags', 'evaluation_object_tags',
        'evaluation_results', 'model_configurations', 'votes', 'category_templates'
    ]) {
        record(`legacy table remains: ${legacyTable}`, await hasTable(connection, legacyTable) ? 1 : 0);
    }
    for (const [table, column] of [
        ['categories', 'template'], ['categories', 'is_folder'],
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
        ['model_conditions', 'fk_model_conditions_model'],
        ['benchmark_results', 'fk_benchmark_results_model_condition'],
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
    record('category tree does not have exactly one root', await scalar(connection, `
        SELECT ABS(COUNT(*) - 1) AS count FROM categories WHERE parent_ID IS NULL`));
    record('active category tree does not have exactly one root', await scalar(connection, `
        SELECT ABS(COUNT(*) - 1) AS count
        FROM categories
        WHERE parent_ID IS NULL AND is_active = 1`));
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
        isActive: Boolean(category.is_active)
    }]));
    const activeChildCategoryIDs = new Set(categoryRows
        .filter(category => category.parent_ID !== null && Boolean(category.is_active))
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
    let invalidContextJSON = 0;
    let noncanonicalContextHashes = 0;
    let duplicateCanonicalContexts = 0;
    const contextDimensionSetMismatchDetails = [];
    const contextOptionMismatchDetails = [];
    const canonicalContextIdentities = new Set();
    for (const context of rankingContexts) {
        const values = context.context_values;
        if (!values || Array.isArray(values) || typeof values !== 'object') {
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

    record('personal pies with totals other than zero or 100 percent', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM (
            SELECT personal_pies.ID
            FROM personal_pies
            LEFT JOIN personal_pie_weights ON personal_pie_weights.pie_ID = personal_pies.ID
            GROUP BY personal_pies.ID
            HAVING COALESCE(SUM(personal_pie_weights.weight_basis_points), 0) NOT IN (0, 10000)
        ) invalid_pies`));
    record('duplicate personal pies per user and context', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM (
            SELECT user_ID, context_ID
            FROM personal_pies
            GROUP BY user_ID, context_ID
            HAVING COUNT(*) > 1
        ) duplicate_pies`));
    record('personal pies referencing inactive benchmark conditions', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM personal_pie_weights
        LEFT JOIN benchmark_conditions
          ON benchmark_conditions.ID = personal_pie_weights.benchmark_condition_ID
         AND benchmark_conditions.is_active = 1
        WHERE benchmark_conditions.ID IS NULL`));
    if (fallbackRuleTableExists && fallbackComponentTableExists) {
        record('personal fallback rules without their primary pie weight', await scalar(connection, `
            SELECT COUNT(*) AS count
            FROM personal_pie_score_rules AS rules
            LEFT JOIN personal_pie_weights AS weights
              ON weights.pie_ID = rules.pie_ID
             AND weights.benchmark_condition_ID = rules.primary_benchmark_condition_ID
            WHERE weights.pie_ID IS NULL`));
        record('personal fallback rules with unsupported modes', await scalar(connection, `
            SELECT COUNT(*) AS count
            FROM personal_pie_score_rules
            WHERE mode <> 'fallback_if_missing'`));
        record('personal fallback rules without components', await scalar(connection, `
            SELECT COUNT(*) AS count
            FROM (
                SELECT rules.pie_ID, rules.primary_benchmark_condition_ID
                FROM personal_pie_score_rules AS rules
                LEFT JOIN personal_pie_score_rule_components AS components
                  ON components.pie_ID = rules.pie_ID
                 AND components.primary_benchmark_condition_ID = rules.primary_benchmark_condition_ID
                GROUP BY rules.pie_ID, rules.primary_benchmark_condition_ID
                HAVING COUNT(components.fallback_benchmark_condition_ID) = 0
            ) empty_fallback_rules`));
        record('personal fallback component totals other than 100 percent', await scalar(connection, `
            SELECT COUNT(*) AS count
            FROM (
                SELECT pie_ID, primary_benchmark_condition_ID
                FROM personal_pie_score_rule_components
                GROUP BY pie_ID, primary_benchmark_condition_ID
                HAVING SUM(weight_basis_points) <> 10000
            ) invalid_fallback_totals`));
        record('personal fallback components with invalid values', await scalar(connection, `
            SELECT COUNT(*) AS count
            FROM personal_pie_score_rule_components AS components
            LEFT JOIN benchmark_conditions
              ON benchmark_conditions.ID = components.fallback_benchmark_condition_ID
             AND benchmark_conditions.is_active = 1
            WHERE benchmark_conditions.ID IS NULL
               OR components.primary_benchmark_condition_ID = components.fallback_benchmark_condition_ID
               OR components.weight_basis_points < 100
               OR components.weight_basis_points > 10000`));

        const [fallbackGraphRows] = await connection.execute(`
            SELECT pie_ID, primary_benchmark_condition_ID, fallback_benchmark_condition_ID
            FROM personal_pie_score_rule_components
            ORDER BY pie_ID, primary_benchmark_condition_ID, fallback_benchmark_condition_ID`);
        const graphsByPie = new Map();
        for (const row of fallbackGraphRows) {
            const pieID = Number(row.pie_ID);
            if (!graphsByPie.has(pieID)) graphsByPie.set(pieID, new Map());
            const graph = graphsByPie.get(pieID);
            const primaryID = Number(row.primary_benchmark_condition_ID);
            if (!graph.has(primaryID)) graph.set(primaryID, []);
            graph.get(primaryID).push(Number(row.fallback_benchmark_condition_ID));
        }
        let cyclicFallbackPies = 0;
        for (const graph of graphsByPie.values()) {
            const primaries = new Set(graph.keys());
            const visiting = new Set();
            const visited = new Set();
            let cyclic = false;
            const visit = conditionID => {
                if (visiting.has(conditionID)) {
                    cyclic = true;
                    return;
                }
                if (visited.has(conditionID) || cyclic) return;
                visiting.add(conditionID);
                for (const targetID of graph.get(conditionID) ?? []) {
                    if (primaries.has(targetID)) visit(targetID);
                }
                visiting.delete(conditionID);
                visited.add(conditionID);
            };
            graph.forEach((_, conditionID) => visit(conditionID));
            if (cyclic) cyclicFallbackPies += 1;
        }
        record('personal fallback rule graphs with cycles', cyclicFallbackPies);
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
        LEFT JOIN model_conditions
          ON model_conditions.ID = benchmark_results.model_condition_ID
        LEFT JOIN benchmark_conditions
          ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
        WHERE benchmark_results.status = 'accepted'
          AND (model_conditions.ID IS NULL
               OR benchmark_conditions.ID IS NULL
               OR model_conditions.model_ID <> benchmark_results.model_ID
               OR benchmark_conditions.benchmark_ID <> benchmark_results.benchmark_ID)`));
    record('percentage results outside 0 to 100', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_results
        JOIN benchmark_conditions
          ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
        WHERE benchmark_results.status = 'accepted'
          AND benchmark_conditions.uses_percentage_scale = 1
          AND (benchmark_results.raw_score < 0 OR benchmark_results.raw_score > 100)`));
    record('accepted results referencing inactive ranking entities', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_results
        JOIN models ON models.ID = benchmark_results.model_ID
        JOIN model_conditions
          ON model_conditions.ID = benchmark_results.model_condition_ID
        JOIN benchmark_conditions
          ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
        WHERE benchmark_results.status = 'accepted'
          AND (models.is_active <> 1
               OR model_conditions.is_active <> 1
               OR benchmark_conditions.is_active <> 1)`));
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
               OR JSON_TYPE(benchmark_results.model_condition_snapshot) <> 'OBJECT'
               OR JSON_EXTRACT(benchmark_results.benchmark_condition_snapshot, '$.conditionID') IS NULL
               OR CAST(JSON_UNQUOTE(JSON_EXTRACT(
                    benchmark_results.benchmark_condition_snapshot,
                    '$.conditionID'
                  )) AS UNSIGNED) <> benchmark_results.benchmark_condition_ID
               OR JSON_EXTRACT(benchmark_results.benchmark_condition_snapshot, '$.benchmarkID') IS NULL
               OR CAST(JSON_UNQUOTE(JSON_EXTRACT(
                    benchmark_results.benchmark_condition_snapshot,
                    '$.benchmarkID'
                  )) AS UNSIGNED) <> benchmark_results.benchmark_ID
               OR JSON_EXTRACT(benchmark_results.model_condition_snapshot, '$.conditionID') IS NULL
               OR CAST(JSON_UNQUOTE(JSON_EXTRACT(
                    benchmark_results.model_condition_snapshot,
                    '$.conditionID'
                  )) AS UNSIGNED) <> benchmark_results.model_condition_ID
               OR JSON_EXTRACT(benchmark_results.model_condition_snapshot, '$.modelID') IS NULL
               OR CAST(JSON_UNQUOTE(JSON_EXTRACT(
                    benchmark_results.model_condition_snapshot,
                    '$.modelID'
                  )) AS UNSIGNED) <> benchmark_results.model_ID)`));
    record('model parameters migration missing', await scalar(connection, `
        SELECT CASE WHEN EXISTS(SELECT 1 FROM schema_migrations WHERE migration_id = '028_model_parameters') THEN 0 ELSE 1 END AS count`));
    const [modelConditions] = await connection.query('SELECT ID, parameters, name, condition_key, is_default FROM model_conditions WHERE is_active = 1');
    let invalidParameters = 0;
    for (const condition of modelConditions) {
        try {
            const parameters = condition.parameters === null ? null : normalizeModelParameters(
                typeof condition.parameters === 'string' ? JSON.parse(condition.parameters) : condition.parameters);
            const key = parameters === null ? `unconfigured-${condition.ID}`
                : 'kv-' + crypto.createHash('sha256').update(JSON.stringify(parameters)).digest('hex');
            if (condition.name !== modelParameterLabel(parameters, condition.ID).slice(0, 192)
                || condition.condition_key !== key || Boolean(condition.is_default) !== (parameters !== null && Object.keys(parameters).length === 0)) invalidParameters++;
        } catch { invalidParameters++; }
    }
    record('model parameters or derived labels are invalid', invalidParameters);
    record('active benchmark condition default flags that disagree with the literal default name', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmark_conditions
        WHERE is_active = 1
          AND (is_default <> (LOWER(TRIM(name)) = 'default')
               OR (condition_key = 'default') <> (LOWER(TRIM(name)) = 'default'))`));
    record('active models without an active condition', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM models
        WHERE models.is_active = 1
          AND NOT EXISTS (
              SELECT 1 FROM model_conditions
              WHERE model_conditions.model_ID = models.ID
                AND model_conditions.is_active = 1
          )`));
    record('active benchmarks without an active condition', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM benchmarks
        WHERE benchmarks.is_active = 1
          AND NOT EXISTS (
              SELECT 1 FROM benchmark_conditions
              WHERE benchmark_conditions.benchmark_ID = benchmarks.ID
                AND benchmark_conditions.is_active = 1
          )`));
    record('malformed moderation JSON', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM moderation_logs
        WHERE JSON_VALID(content) = 0`));
    record('moderation records with noncanonical schema versions', await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM moderation_logs
        WHERE JSON_VALID(content) = 1
          AND COALESCE((
              JSON_TYPE(JSON_EXTRACT(content, '$.schemaVersion')) = 'INTEGER'
              AND (
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) IN ('feedback', 'report_issue', 'discussion_report')
                   AND JSON_EXTRACT(content, '$.schemaVersion') = 1)
                  OR
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) IN ('new_category', 'new_benchmark', 'new_model')
                   AND JSON_EXTRACT(content, '$.schemaVersion') = 5)
                  OR
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'benchmark_result'
                   AND JSON_EXTRACT(content, '$.schemaVersion') = 8)
                  OR
                  (JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) = 'entity_change'
                   AND (
                       (JSON_UNQUOTE(JSON_EXTRACT(content, '$.targetKind')) IN ('benchmark', 'model')
                        AND JSON_EXTRACT(content, '$.schemaVersion') = 5)
                       OR
                       (JSON_UNQUOTE(JSON_EXTRACT(content, '$.targetKind')) = 'result'
                        AND JSON_EXTRACT(content, '$.schemaVersion') = 8)
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
    console.log(JSON.stringify({
        status: failures.length === 0 ? 'passed' : 'failed',
        checks
    }, null, 2));
    if (failures.length > 0) {
        process.exitCode = 1;
    }
} finally {
    await connection.end();
}
