import crypto from 'node:crypto';

export const PIE_TOTAL_BASIS_POINTS = 10000;
export const PIE_MIN_ITEM_BASIS_POINTS = 100;
export const MAX_PIE_ITEMS = PIE_TOTAL_BASIS_POINTS / PIE_MIN_ITEM_BASIS_POINTS;
export const FALLBACK_RULE_MODE = 'fallback_if_missing';
export const MAX_FALLBACK_COMPONENTS = 12;

function requestError(status, error, details = {}) {
    return { status, body: { error, ...details } };
}

function parseSafeInteger(value, { minimum = 0 } = {}) {
    if (typeof value !== 'number') {
        return null;
    }
    return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function parseFiniteNumber(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const normalized = Number(value);
        return Number.isFinite(normalized) ? normalized : null;
    }
    return null;
}

function normalizeUserID(value) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
        return null;
    }
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) {
        return null;
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) {
        return null;
    }
    const userID = BigInt(text);
    if (userID < 1n || userID > 18446744073709551615n) {
        return null;
    }
    return userID.toString();
}

function roundTo(value, places = 2) {
    const scale = 10 ** places;
    return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function normalizeWeights(entries) {
    const positiveEntries = entries
        .map(entry => ({ ...entry, rawWeight: Number(entry.rawWeight) }))
        .filter(entry => Number.isFinite(entry.rawWeight) && entry.rawWeight > 0);
    if (positiveEntries.length === 0) {
        return [];
    }
    const total = positiveEntries.reduce((sum, entry) => sum + entry.rawWeight, 0);
    const distributed = positiveEntries.map((entry, index) => {
        const exact = entry.rawWeight / total * PIE_TOTAL_BASIS_POINTS;
        const weightBasisPoints = Math.floor(exact);
        return {
            ...entry,
            index,
            exact,
            weightBasisPoints,
            fraction: exact - weightBasisPoints
        };
    });
    let remaining = PIE_TOTAL_BASIS_POINTS
        - distributed.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
    distributed
        .slice()
        .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index))
        .forEach(entry => {
            if (remaining > 0) {
                distributed[entry.index].weightBasisPoints += 1;
                remaining -= 1;
            }
        });
    return distributed.map(({ rawWeight, exact, fraction, index, ...entry }) => entry);
}

async function resolveCategory(connection, requestedCategoryID) {
    const categoryWasOmitted = requestedCategoryID === undefined || requestedCategoryID === null;
    let categoryID = categoryWasOmitted ? null : parseSafeInteger(requestedCategoryID, { minimum: 1 });
    if (categoryID === null) {
        if (!categoryWasOmitted) {
            throw requestError(400, 'invalid_category_id');
        }
        const [roots] = await connection.execute(`
            SELECT ID, parent_ID, name
            FROM categories
            WHERE parent_ID IS NULL AND is_active = 1
            ORDER BY ID`);
        if (roots.length === 0) {
            throw requestError(409, 'ranking_root_missing');
        }
        if (roots.length > 1) {
            throw requestError(409, 'multiple_ranking_roots', {
                categoryIDs: roots.map(root => Number(root.ID))
            });
        }
        categoryID = Number(roots[0].ID);
    }

    const lineage = [];
    const visited = new Set();
    let cursorID = categoryID;
    while (cursorID !== null) {
        if (visited.has(cursorID) || lineage.length >= 64) {
            throw requestError(409, 'category_cycle_detected');
        }
        visited.add(cursorID);
        const [rows] = await connection.execute(
            'SELECT ID, parent_ID, name FROM categories WHERE ID = ? AND is_active = 1',
            [cursorID]
        );
        if (rows.length === 0) {
            throw requestError(404, 'category_not_found');
        }
        const category = rows[0];
        lineage.unshift({
            ID: Number(category.ID),
            parentID: category.parent_ID === null ? null : Number(category.parent_ID),
            name: category.name
        });
        cursorID = category.parent_ID === null ? null : Number(category.parent_ID);
    }
    const [[childCount]] = await connection.execute(
        'SELECT COUNT(*) AS count FROM categories WHERE parent_ID = ? AND is_active = 1',
        [categoryID]
    );
    return {
        ID: categoryID,
        path: lineage.map(category => category.name).join('/'),
        lineage,
        isLeaf: Number(childCount.count) === 0
    };
}

async function loadDimensions(connection, category) {
    if (!category.isLeaf) {
        return [];
    }
    const scopedIDs = [0, ...category.lineage.map(item => item.ID)];
    const [rows] = await connection.execute(`
        SELECT ID, scope_category_ID, dimension_key, name, position
        FROM ranking_dimensions
        WHERE is_active = 1
          AND scope_category_ID IN (${scopedIDs.map(() => '?').join(', ')})
        ORDER BY position, ID`, scopedIDs);
    const priority = new Map(scopedIDs.map((scopeID, index) => [Number(scopeID), index]));
    const selectedByKey = new Map();
    for (const row of rows) {
        const key = String(row.dimension_key);
        const current = selectedByKey.get(key);
        if (!current || priority.get(Number(row.scope_category_ID)) > priority.get(Number(current.scope_category_ID))) {
            selectedByKey.set(key, row);
        }
    }
    const selected = Array.from(selectedByKey.values())
        .sort((a, b) => (Number(a.position) - Number(b.position)) || (Number(a.ID) - Number(b.ID)));
    if (selected.length === 0) {
        return [];
    }
    const dimensionIDs = selected.map(dimension => Number(dimension.ID));
    const [options] = await connection.execute(`
        SELECT dimension_ID, option_key, name, position, is_default, is_neutral
        FROM ranking_dimension_options
        WHERE dimension_ID IN (${dimensionIDs.map(() => '?').join(', ')})
        ORDER BY dimension_ID, position, ID`, dimensionIDs);
    const optionsByDimension = new Map();
    for (const option of options) {
        const dimensionID = Number(option.dimension_ID);
        if (!optionsByDimension.has(dimensionID)) {
            optionsByDimension.set(dimensionID, []);
        }
        optionsByDimension.get(dimensionID).push({
            key: option.option_key,
            name: option.name,
            isDefault: Boolean(option.is_default),
            isNeutral: Boolean(option.is_neutral)
        });
    }
    return selected.map(dimension => ({
        ID: Number(dimension.ID),
        scopeCategoryID: Number(dimension.scope_category_ID),
        key: dimension.dimension_key,
        name: dimension.name,
        position: Number(dimension.position),
        options: optionsByDimension.get(Number(dimension.ID)) ?? []
    }));
}

function canonicalizeContextValues(requestedValues, dimensions, { requireAllDimensions = false } = {}) {
    if (requestedValues !== null && requestedValues !== undefined
        && (!requestedValues || typeof requestedValues !== 'object' || Array.isArray(requestedValues))) {
        throw requestError(400, 'invalid_context_values');
    }
    const input = requestedValues ?? {};
    const allowedKeys = new Set(dimensions.map(dimension => dimension.key));
    for (const inputKey of Object.keys(input)) {
        if (!allowedKeys.has(inputKey)) {
            throw requestError(400, 'unknown_context_dimension', { dimension: inputKey });
        }
    }

    const contextValues = {};
    const displayValues = {};
    const resolvedDimensions = dimensions.map(dimension => {
        if (dimension.options.length < 2) {
            throw requestError(409, 'context_dimension_needs_multiple_options', { dimension: dimension.key });
        }
        const defaults = dimension.options.filter(option => option.isDefault);
        const neutralOptions = dimension.options.filter(option => option.isNeutral);
        if (defaults.length !== 1 || neutralOptions.length !== 1) {
            throw requestError(409, 'context_dimension_option_invariant_failed', { dimension: dimension.key });
        }
        if (requireAllDimensions && !Object.hasOwn(input, dimension.key)) {
            throw requestError(400, 'missing_context_dimension', { dimension: dimension.key });
        }
        const hasRequestedValue = Object.hasOwn(input, dimension.key);
        let selected = defaults[0];
        if (hasRequestedValue) {
            const requestedValue = input[dimension.key];
            if (typeof requestedValue !== 'string'
                || requestedValue === ''
                || requestedValue !== requestedValue.trim()) {
                throw requestError(400, 'invalid_context_option', { dimension: dimension.key });
            }
            selected = dimension.options.find(option => String(option.key) === requestedValue) ?? null;
        }
        if (!selected) {
            throw requestError(400, 'invalid_context_option', { dimension: dimension.key });
        }
        contextValues[dimension.key] = selected.key;
        displayValues[dimension.key] = selected.name;
        return { ...dimension, selectedKey: selected.key, selectedName: selected.name };
    });
    return { contextValues, displayValues, dimensions: resolvedDimensions };
}

export function serializeRankingContextValues(contextValues) {
    const canonicalValues = Object.fromEntries(
        Object.keys(contextValues).sort().map(key => [key, contextValues[key]])
    );
    const serialized = JSON.stringify(canonicalValues);
    return {
        serialized,
        contextHash: crypto.createHash('sha256').update(serialized).digest('hex')
    };
}

async function findContext(connection, categoryID, contextValues) {
    const { serialized, contextHash } = serializeRankingContextValues(contextValues);
    const [rows] = await connection.execute(`
        SELECT ID
        FROM ranking_contexts
        WHERE category_ID = ? AND context_hash = ?
        LIMIT 1`, [categoryID, contextHash]);
    return {
        ID: rows.length > 0 ? Number(rows[0].ID) : null,
        categoryID,
        contextHash,
        contextValues,
        serialized
    };
}

async function ensureContext(connection, categoryID, contextValues) {
    const context = await findContext(connection, categoryID, contextValues);
    const [result] = await connection.execute(`
        INSERT INTO ranking_contexts (category_ID, context_values, context_hash)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE ID = LAST_INSERT_ID(ID)`,
    [categoryID, context.serialized, context.contextHash]);
    if (!Number(result.insertId)) {
        throw requestError(500, 'ranking_context_upsert_failed');
    }
    return { ...context, ID: Number(result.insertId) };
}

function parseContextValues(value, contextID) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        // The invariant error below is more actionable than a raw JSON error.
    }
    throw requestError(409, 'ranking_context_values_invalid', { contextID });
}

export async function loadBenchmarkConditions(connection) {
    const [rows] = await connection.execute(`
        SELECT benchmark_conditions.ID AS condition_ID,
               benchmark_conditions.benchmark_ID,
               benchmark_conditions.condition_key,
               benchmark_conditions.name AS condition_name,
               benchmark_conditions.uses_percentage_scale,
               benchmark_conditions.score_min,
               benchmark_conditions.score_max,
               benchmark_conditions.score_direction,
               benchmark_conditions.target_value,
               benchmark_conditions.is_default,
               benchmarks.name,
               benchmarks.introduction_url,
               GROUP_CONCAT(benchmark_tags.name ORDER BY benchmark_tags.name SEPARATOR '\n') AS tags
        FROM benchmark_conditions
        JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
        LEFT JOIN benchmark_tag_links
          ON benchmark_tag_links.benchmark_ID = benchmarks.ID
        LEFT JOIN benchmark_tags
          ON benchmark_tags.ID = benchmark_tag_links.tag_ID
         AND benchmark_tags.is_active = 1
        WHERE benchmark_conditions.is_active = 1
          AND benchmarks.is_active = 1
        GROUP BY benchmark_conditions.ID, benchmark_conditions.benchmark_ID,
                 benchmark_conditions.condition_key, benchmark_conditions.name,
                 benchmark_conditions.uses_percentage_scale,
                 benchmark_conditions.score_min, benchmark_conditions.score_max,
                 benchmark_conditions.score_direction, benchmark_conditions.target_value,
                 benchmark_conditions.is_default, benchmarks.name, benchmarks.introduction_url
        ORDER BY benchmarks.name, benchmark_conditions.is_default DESC,
                 benchmark_conditions.name, benchmark_conditions.ID`);
    return rows.map(row => {
        const conditionName = row.condition_name;
        const normalizedConditionName = String(conditionName ?? '')
            .trim()
            .replace(/\s+/g, ' ')
            .toLocaleLowerCase('en-US');
        const literalDefault = normalizedConditionName === 'default';
        const isDefault = Boolean(row.is_default);
        const usesPercentageScale = Boolean(row.uses_percentage_scale);
        const scoreMin = parseFiniteNumber(row.score_min);
        const scoreMax = parseFiniteNumber(row.score_max);
        const targetValue = row.target_value === null ? null : parseFiniteNumber(row.target_value);
        const scoreDirection = row.score_direction;
        const hasAnyRangeValue = scoreMin !== null || scoreMax !== null;
        if (isDefault !== literalDefault
            || (row.condition_key === 'default') !== literalDefault) {
            throw requestError(409, 'benchmark_condition_default_invariant_failed', {
                conditionID: Number(row.condition_ID)
            });
        }
        if ((usesPercentageScale && hasAnyRangeValue)
            || (!usesPercentageScale
                && (scoreMin === null || scoreMax === null || scoreMax <= scoreMin))
            || !['higher', 'lower', 'closer_to_target'].includes(scoreDirection)
            || (scoreDirection === 'closer_to_target'
                && (targetValue === null
                    || (usesPercentageScale && (targetValue < 0 || targetValue > 100))
                    || (scoreMin !== null && targetValue < scoreMin)
                    || (scoreMax !== null && targetValue > scoreMax)))
            || (scoreDirection !== 'closer_to_target' && targetValue !== null)) {
            throw requestError(409, 'benchmark_condition_score_invariant_failed', {
                conditionID: Number(row.condition_ID)
            });
        }
        const tags = row.tags ? String(row.tags).split('\n') : [];
        return {
            ID: Number(row.condition_ID),
            conditionID: Number(row.condition_ID),
            benchmarkID: Number(row.benchmark_ID),
            name: row.name,
            baseName: row.name,
            conditionKey: row.condition_key,
            conditionName,
            isDefaultCondition: isDefault,
            tags,
            type: tags[0] ?? 'benchmark',
            url: row.introduction_url,
            usesPercentageScale,
            scoreMin,
            scoreMax,
            scoreDirection,
            targetValue
        };
    });
}

function contextMatchesSelection(candidateValues, context) {
    const expectedKeys = new Set(context.dimensions.map(dimension => dimension.key));
    if (expectedKeys.size > 0) {
        const candidateKeys = Object.keys(candidateValues);
        if (candidateKeys.length !== expectedKeys.size
            || candidateKeys.some(key => !expectedKeys.has(key))) {
            throw requestError(409, 'ranking_context_values_mismatch');
        }
    }
    for (const dimension of context.dimensions) {
        const selected = dimension.options.find(option => option.key === context.contextValues[dimension.key]);
        if (!selected) {
            throw requestError(409, 'selected_context_option_missing', { dimension: dimension.key });
        }
        const candidateValue = candidateValues[dimension.key];
        if (typeof candidateValue !== 'string'
            || !dimension.options.some(option => option.key === candidateValue)) {
            throw requestError(409, 'ranking_context_values_mismatch', {
                dimension: dimension.key
            });
        }
        if (!selected.isNeutral && candidateValue !== selected.key) {
            return false;
        }
    }
    return true;
}

async function loadMatchingContexts(connection, context) {
    const [rows] = await connection.execute(`
        WITH RECURSIVE category_scope AS (
            SELECT ID, CAST(ID AS CHAR(4096)) AS visited
            FROM categories
            WHERE ID = ? AND is_active = 1
            UNION ALL
            SELECT child.ID, CONCAT(category_scope.visited, ',', child.ID)
            FROM categories child
            JOIN category_scope ON child.parent_ID = category_scope.ID
            WHERE child.is_active = 1
              AND FIND_IN_SET(child.ID, category_scope.visited) = 0
        )
        SELECT ranking_contexts.ID, ranking_contexts.category_ID,
               ranking_contexts.context_values
        FROM ranking_contexts
        JOIN category_scope ON category_scope.ID = ranking_contexts.category_ID
        ORDER BY ranking_contexts.category_ID, ranking_contexts.ID`, [context.categoryID]);
    return rows.map(row => ({
        ID: Number(row.ID),
        categoryID: Number(row.category_ID),
        contextValues: parseContextValues(row.context_values, Number(row.ID))
    })).filter(candidate => contextMatchesSelection(candidate.contextValues, context));
}

export async function loadPublicPie(connection, context, conditionsByID) {
    const matchingContexts = await loadMatchingContexts(connection, context);
    if (matchingContexts.length === 0) {
        return { entries: [], participantCount: 0, isFallback: false, scoringEntries: [], contextIDs: [] };
    }
    const contextIDs = matchingContexts.map(candidate => candidate.ID);
    const [rows] = await connection.execute(`
        SELECT personal_pies.ID AS pie_ID, personal_pies.context_ID,
               personal_pie_weights.benchmark_condition_ID,
               personal_pie_weights.weight_basis_points
        FROM personal_pies
        JOIN users ON users.ID = personal_pies.user_ID
        LEFT JOIN personal_pie_weights ON personal_pie_weights.pie_ID = personal_pies.ID
        WHERE personal_pies.context_ID IN (${contextIDs.map(() => '?').join(', ')})
          AND users.deleted_at IS NULL
          AND (users.banned_at IS NULL
               OR (users.banned_until IS NOT NULL AND users.banned_until <= NOW()))
        ORDER BY personal_pies.ID, personal_pie_weights.benchmark_condition_ID`, contextIDs);

    const pies = new Map();
    for (const row of rows) {
        const pieID = Number(row.pie_ID);
        if (!pies.has(pieID)) {
            pies.set(pieID, {
                contextID: Number(row.context_ID),
                entries: [],
                conditionIDs: new Set(),
                total: 0
            });
        }
        if (row.benchmark_condition_ID === null) {
            continue;
        }
        const conditionID = Number(row.benchmark_condition_ID);
        if (!conditionsByID.has(conditionID)) {
            throw requestError(409, 'personal_pie_references_unavailable_condition', { pieID, conditionID });
        }
        const weightBasisPoints = Number(row.weight_basis_points);
        const pie = pies.get(pieID);
        if (!Number.isSafeInteger(weightBasisPoints)
            || weightBasisPoints < PIE_MIN_ITEM_BASIS_POINTS
            || weightBasisPoints > PIE_TOTAL_BASIS_POINTS) {
            throw requestError(409, 'personal_pie_weight_invalid', {
                pieID,
                conditionID,
                weightBasisPoints
            });
        }
        if (pie.conditionIDs.has(conditionID)) {
            throw requestError(409, 'personal_pie_condition_duplicate', { pieID, conditionID });
        }
        pie.conditionIDs.add(conditionID);
        pie.entries.push({ conditionID, weightBasisPoints });
        pie.total += weightBasisPoints;
    }
    const validPies = new Map();
    for (const [pieID, pie] of pies) {
        if (pie.entries.length === 0) {
            continue;
        }
        if (pie.total !== PIE_TOTAL_BASIS_POINTS) {
            throw requestError(409, 'personal_pie_total_invalid', { pieID, totalBasisPoints: pie.total });
        }
        validPies.set(pieID, pie);
    }
    if (validPies.size === 0) {
        return { entries: [], participantCount: 0, isFallback: false, scoringEntries: [], contextIDs };
    }

    const aggregateWeights = new Map();
    const scoringWeights = new Map();
    for (const pie of validPies.values()) {
        for (const entry of pie.entries) {
            aggregateWeights.set(
                entry.conditionID,
                (aggregateWeights.get(entry.conditionID) ?? 0) + entry.weightBasisPoints
            );
            const scoringKey = `${pie.contextID}:${entry.conditionID}`;
            const current = scoringWeights.get(scoringKey);
            scoringWeights.set(scoringKey, {
                contextID: pie.contextID,
                conditionID: entry.conditionID,
                weightBasisPoints: (current?.weightBasisPoints ?? 0) + entry.weightBasisPoints
            });
        }
    }
    return {
        entries: normalizeWeights(Array.from(aggregateWeights, ([conditionID, rawWeight]) => ({
            conditionID,
            rawWeight
        }))),
        participantCount: validPies.size,
        isFallback: false,
        scoringEntries: Array.from(scoringWeights.values()),
        contextIDs
    };
}

export async function loadPersonalPie(connection, contextID, userID) {
    if (!userID || contextID === null) {
        return null;
    }
    const [pies] = await connection.execute(`
        SELECT ID, revision, updated_at
        FROM personal_pies
        WHERE user_ID = ? AND context_ID = ?
        LIMIT 1`, [userID, contextID]);
    if (pies.length === 0) {
        return null;
    }
    const pie = pies[0];
    const [weights] = await connection.execute(`
        SELECT benchmark_condition_ID, weight_basis_points
        FROM personal_pie_weights
        WHERE pie_ID = ?
        ORDER BY weight_basis_points DESC, benchmark_condition_ID`, [pie.ID]);
    const entries = weights.map(row => ({
        conditionID: Number(row.benchmark_condition_ID),
        weightBasisPoints: Number(row.weight_basis_points)
    }));
    const conditionIDs = new Set();
    for (const entry of entries) {
        if (!Number.isSafeInteger(entry.conditionID)
            || entry.conditionID < 1
            || !Number.isSafeInteger(entry.weightBasisPoints)
            || entry.weightBasisPoints < PIE_MIN_ITEM_BASIS_POINTS
            || entry.weightBasisPoints > PIE_TOTAL_BASIS_POINTS) {
            throw requestError(409, 'personal_pie_weight_invalid', { pieID: Number(pie.ID) });
        }
        if (conditionIDs.has(entry.conditionID)) {
            throw requestError(409, 'personal_pie_condition_duplicate', {
                pieID: Number(pie.ID),
                conditionID: entry.conditionID
            });
        }
        conditionIDs.add(entry.conditionID);
    }
    const total = entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
    if (entries.length > 0 && total !== PIE_TOTAL_BASIS_POINTS) {
        throw requestError(409, 'personal_pie_total_invalid', { pieID: Number(pie.ID), totalBasisPoints: total });
    }
    const [fallbackRows] = await connection.execute(`
        SELECT personal_pie_score_rules.primary_benchmark_condition_ID,
               personal_pie_score_rules.mode,
               personal_pie_score_rule_components.fallback_benchmark_condition_ID,
               personal_pie_score_rule_components.weight_basis_points
        FROM personal_pie_score_rules
        LEFT JOIN personal_pie_score_rule_components
          ON personal_pie_score_rule_components.pie_ID = personal_pie_score_rules.pie_ID
         AND personal_pie_score_rule_components.primary_benchmark_condition_ID =
             personal_pie_score_rules.primary_benchmark_condition_ID
        WHERE personal_pie_score_rules.pie_ID = ?
        ORDER BY personal_pie_score_rules.primary_benchmark_condition_ID,
                 personal_pie_score_rule_components.weight_basis_points DESC,
                 personal_pie_score_rule_components.fallback_benchmark_condition_ID`, [pie.ID]);
    const fallbackRulesByPrimary = new Map();
    for (const row of fallbackRows) {
        const primaryConditionID = Number(row.primary_benchmark_condition_ID);
        if (!Number.isSafeInteger(primaryConditionID) || !conditionIDs.has(primaryConditionID)) {
            throw requestError(409, 'personal_pie_fallback_primary_invalid', {
                pieID: Number(pie.ID),
                primaryConditionID
            });
        }
        if (row.mode !== FALLBACK_RULE_MODE) {
            throw requestError(409, 'personal_pie_fallback_mode_invalid', {
                pieID: Number(pie.ID),
                primaryConditionID,
                mode: row.mode
            });
        }
        if (!fallbackRulesByPrimary.has(primaryConditionID)) {
            fallbackRulesByPrimary.set(primaryConditionID, {
                primaryConditionID,
                mode: FALLBACK_RULE_MODE,
                entries: [],
                conditionIDs: new Set(),
                total: 0
            });
        }
        if (row.fallback_benchmark_condition_ID === null) {
            throw requestError(409, 'personal_pie_fallback_empty', {
                pieID: Number(pie.ID),
                primaryConditionID
            });
        }
        const conditionID = Number(row.fallback_benchmark_condition_ID);
        const weightBasisPoints = Number(row.weight_basis_points);
        const rule = fallbackRulesByPrimary.get(primaryConditionID);
        if (!Number.isSafeInteger(conditionID)
            || conditionID < 1
            || conditionID === primaryConditionID
            || !Number.isSafeInteger(weightBasisPoints)
            || weightBasisPoints < PIE_MIN_ITEM_BASIS_POINTS
            || weightBasisPoints > PIE_TOTAL_BASIS_POINTS) {
            throw requestError(409, 'personal_pie_fallback_component_invalid', {
                pieID: Number(pie.ID),
                primaryConditionID,
                conditionID
            });
        }
        if (rule.conditionIDs.has(conditionID)) {
            throw requestError(409, 'personal_pie_fallback_component_duplicate', {
                pieID: Number(pie.ID),
                primaryConditionID,
                conditionID
            });
        }
        rule.conditionIDs.add(conditionID);
        rule.entries.push({ conditionID, weightBasisPoints });
        rule.total += weightBasisPoints;
    }
    const fallbackRules = Array.from(fallbackRulesByPrimary.values(), rule => {
        if (rule.entries.length > MAX_FALLBACK_COMPONENTS) {
            throw requestError(409, 'personal_pie_fallback_too_large', {
                pieID: Number(pie.ID),
                primaryConditionID: rule.primaryConditionID,
                maxComponents: MAX_FALLBACK_COMPONENTS
            });
        }
        if (rule.total !== PIE_TOTAL_BASIS_POINTS) {
            throw requestError(409, 'personal_pie_fallback_total_invalid', {
                pieID: Number(pie.ID),
                primaryConditionID: rule.primaryConditionID,
                totalBasisPoints: rule.total
            });
        }
        return {
            primaryConditionID: rule.primaryConditionID,
            mode: rule.mode,
            entries: rule.entries
        };
    });
    try {
        assertFallbackRulesAcyclic(fallbackRules);
    } catch {
        throw requestError(409, 'personal_pie_fallback_cycle_invalid', {
            pieID: Number(pie.ID)
        });
    }
    return {
        ID: Number(pie.ID),
        revision: Number(pie.revision),
        updatedAt: pie.updated_at,
        entries,
        fallbackRules
    };
}

export function decoratePieEntries(entries, conditionsByID) {
    return entries.map(entry => {
        const condition = conditionsByID.get(Number(entry.conditionID));
        if (!condition) {
            throw requestError(409, 'pie_condition_not_available', { conditionID: Number(entry.conditionID) });
        }
        return {
            conditionID: condition.conditionID,
            benchmarkID: condition.benchmarkID,
            name: condition.name,
            conditionKey: condition.conditionKey,
            conditionName: condition.conditionName,
            isDefaultCondition: condition.isDefaultCondition,
            type: condition.type,
            weightBasisPoints: Number(entry.weightBasisPoints),
            weight: roundTo(Number(entry.weightBasisPoints) / 100)
        };
    }).sort((a, b) => (b.weightBasisPoints - a.weightBasisPoints) || a.name.localeCompare(b.name));
}

function decorateFallbackRules(rules, conditionsByID) {
    return rules.map(rule => ({
        primaryConditionID: rule.primaryConditionID,
        mode: rule.mode,
        entries: rule.entries.map(entry => {
            const condition = conditionsByID.get(Number(entry.conditionID));
            if (!condition) {
                throw requestError(409, 'personal_pie_fallback_condition_not_available', {
                    primaryConditionID: rule.primaryConditionID,
                    conditionID: Number(entry.conditionID)
                });
            }
            return {
                conditionID: condition.conditionID,
                benchmarkID: condition.benchmarkID,
                name: condition.name,
                conditionKey: condition.conditionKey,
                conditionName: condition.conditionName,
                isDefaultCondition: condition.isDefaultCondition,
                type: condition.type,
                weightBasisPoints: Number(entry.weightBasisPoints),
                weight: roundTo(Number(entry.weightBasisPoints) / 100)
            };
        })
    }));
}

function buildBenchmarkList(conditions, publicEntries, personalEntries) {
    const publicWeights = new Map(publicEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]));
    const personalWeights = new Map(personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]));
    const rows = conditions.map(condition => ({
        ...condition,
        publicWeightBasisPoints: publicWeights.get(condition.conditionID) ?? 0,
        publicWeight: roundTo((publicWeights.get(condition.conditionID) ?? 0) / 100),
        personalWeightBasisPoints: personalWeights.get(condition.conditionID) ?? null,
        personalWeight: personalWeights.has(condition.conditionID)
            ? roundTo(personalWeights.get(condition.conditionID) / 100)
            : null
    })).sort((a, b) => (
        (b.publicWeightBasisPoints - a.publicWeightBasisPoints)
        || (b.personalWeightBasisPoints ?? -1) - (a.personalWeightBasisPoints ?? -1)
        || a.name.localeCompare(b.name)
        || a.conditionID - b.conditionID
    ));
    let previousWeight = null;
    let previousRank = 0;
    rows.forEach((row, index) => {
        if (row.publicWeightBasisPoints === previousWeight) {
            row.rank = previousRank;
        } else {
            row.rank = index + 1;
            previousRank = row.rank;
            previousWeight = row.publicWeightBasisPoints;
        }
    });
    return rows;
}

export function normalizedResultScore(result) {
    const rawScore = parseFiniteNumber(result.rawScore);
    if (rawScore === null) {
        return null;
    }
    const usesPercentageScale = result.usesPercentageScale === true;
    const scoreMin = usesPercentageScale ? 0 : parseFiniteNumber(result.scoreMin);
    const scoreMax = usesPercentageScale ? 100 : parseFiniteNumber(result.scoreMax);
    if (scoreMin === null || scoreMax === null || scoreMax <= scoreMin) {
        return null;
    }
    if (usesPercentageScale && (rawScore < 0 || rawScore > 100)) {
        return null;
    }
    const ascending = (rawScore - scoreMin) / (scoreMax - scoreMin) * 100;
    if (result.scoreDirection === 'higher') {
        return ascending;
    }
    if (result.scoreDirection === 'lower') {
        return 100 - ascending;
    }
    if (result.scoreDirection === 'closer_to_target') {
        const targetValue = parseFiniteNumber(result.targetValue);
        if (targetValue === null) {
            return null;
        }
        const maximumDistance = Math.max(targetValue - scoreMin, scoreMax - targetValue);
        if (targetValue < scoreMin || targetValue > scoreMax
            || maximumDistance <= 0) {
            return null;
        }
        return 100 - Math.abs(rawScore - targetValue) / maximumDistance * 100;
    }
    return null;
}

export function medianOfFiniteNumbers(values) {
    if (!Array.isArray(values) || values.length === 0
        || values.some(value => !Number.isFinite(value))) {
        throw new TypeError('median requires one or more finite numbers');
    }
    const sorted = [...values].sort((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[midpoint]
        : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

export async function resolveRankingContext(connection, {
    categoryID,
    contextValues = {},
    create = false,
    requireAllDimensions = false
} = {}) {
    const category = await resolveCategory(connection, categoryID);
    const dimensions = await loadDimensions(connection, category);
    const resolvedContext = canonicalizeContextValues(
        contextValues,
        dimensions,
        { requireAllDimensions }
    );
    const context = create
        ? await ensureContext(connection, category.ID, resolvedContext.contextValues)
        : await findContext(connection, category.ID, resolvedContext.contextValues);
    return {
        ID: context.ID,
        categoryID: category.ID,
        categoryPath: category.path,
        isLeafCategory: category.isLeaf,
        contextHash: context.contextHash,
        contextValues: resolvedContext.contextValues,
        contextDisplayValues: resolvedContext.displayValues,
        dimensions: resolvedContext.dimensions
    };
}

function resultKey(conditionID) {
    return String(Number(conditionID));
}

function indexFallbackRules(fallbackRules) {
    if (!Array.isArray(fallbackRules)) {
        throw new TypeError('fallback rules must be an array');
    }
    const rulesByPrimary = new Map();
    for (const rule of fallbackRules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)
            || rule.mode !== FALLBACK_RULE_MODE
            || !Number.isSafeInteger(rule.primaryConditionID)
            || !Array.isArray(rule.entries)
            || rule.entries.length === 0
            || rule.entries.length > MAX_FALLBACK_COMPONENTS
            || rulesByPrimary.has(rule.primaryConditionID)) {
            throw new TypeError('invalid fallback rule');
        }
        const seen = new Set();
        let total = 0;
        const entries = rule.entries.map(entry => {
            const conditionID = Number(entry?.conditionID);
            const weightBasisPoints = Number(entry?.weightBasisPoints);
            if (!Number.isSafeInteger(conditionID)
                || conditionID < 1
                || conditionID === rule.primaryConditionID
                || seen.has(conditionID)
                || !Number.isSafeInteger(weightBasisPoints)
                || weightBasisPoints < PIE_MIN_ITEM_BASIS_POINTS
                || weightBasisPoints > PIE_TOTAL_BASIS_POINTS) {
                throw new TypeError('invalid fallback rule component');
            }
            seen.add(conditionID);
            total += weightBasisPoints;
            return { conditionID, weightBasisPoints };
        });
        if (total !== PIE_TOTAL_BASIS_POINTS) {
            throw new TypeError('fallback rule weights must total 100 percent');
        }
        rulesByPrimary.set(rule.primaryConditionID, { ...rule, entries });
    }
    return rulesByPrimary;
}

function directModelScore(model, conditionID) {
    const result = model.results.get(resultKey(conditionID));
    if (!result) return null;
    const normalizedScore = parseFiniteNumber(result.normalizedScore);
    return normalizedScore === null ? null : normalizedScore;
}

function resolveDirectFallback(model, rule) {
    let lower = 0;
    let upper = 0;
    let coveredBasisPoints = 0;
    const resultKeys = new Set();
    const components = rule.entries.map(entry => {
        const normalizedScore = directModelScore(model, entry.conditionID);
        const fraction = entry.weightBasisPoints / PIE_TOTAL_BASIS_POINTS;
        if (normalizedScore === null) {
            upper += fraction * 100;
            return {
                conditionID: entry.conditionID,
                weightBasisPoints: entry.weightBasisPoints,
                status: 'missing',
                normalizedScore: null
            };
        }
        lower += fraction * normalizedScore;
        upper += fraction * normalizedScore;
        coveredBasisPoints += entry.weightBasisPoints;
        resultKeys.add(resultKey(entry.conditionID));
        return {
            conditionID: entry.conditionID,
            weightBasisPoints: entry.weightBasisPoints,
            status: 'direct',
            normalizedScore
        };
    });
    return { lower, upper, coveredBasisPoints, resultKeys, components };
}

export function scoreModels(models, weightedEntries, totalBasisPoints, { fallbackRules = [] } = {}) {
    if (!Number.isFinite(totalBasisPoints) || totalBasisPoints <= 0 || weightedEntries.length === 0) {
        return [];
    }
    const fallbackRulesByPrimary = indexFallbackRules(fallbackRules);
    return models.map(model => {
        let lower = 0;
        let upper = 0;
        let coveredBasisPoints = 0;
        let fallbackCoveredBasisPoints = 0;
        const resultKeys = new Set();
        const fallbackResolutions = [];
        for (const entry of weightedEntries) {
            const entryFraction = entry.weightBasisPoints / totalBasisPoints;
            const normalizedScore = directModelScore(model, entry.conditionID);
            if (normalizedScore !== null) {
                lower += entryFraction * normalizedScore;
                upper += entryFraction * normalizedScore;
                coveredBasisPoints += entry.weightBasisPoints;
                resultKeys.add(resultKey(entry.conditionID));
                continue;
            }
            const fallbackRule = fallbackRulesByPrimary.get(Number(entry.conditionID));
            if (!fallbackRule) {
                upper += entryFraction * 100;
                continue;
            }
            const fallback = resolveDirectFallback(model, fallbackRule);
            lower += entryFraction * fallback.lower;
            upper += entryFraction * fallback.upper;
            const coveredFromFallback = entry.weightBasisPoints
                * fallback.coveredBasisPoints / PIE_TOTAL_BASIS_POINTS;
            coveredBasisPoints += coveredFromFallback;
            fallbackCoveredBasisPoints += coveredFromFallback;
            fallback.resultKeys.forEach(key => resultKeys.add(key));
            fallbackResolutions.push({
                primaryConditionID: Number(entry.conditionID),
                lower: roundTo(fallback.lower),
                upper: roundTo(fallback.upper),
                coverage: roundTo(fallback.coveredBasisPoints / PIE_TOTAL_BASIS_POINTS * 100),
                components: fallback.components.map(component => ({
                    ...component,
                    normalizedScore: component.normalizedScore === null
                        ? null
                        : roundTo(component.normalizedScore)
                }))
            });
        }
        return {
            ID: model.ID,
            modelID: model.modelID,
            name: model.name,
            vendor: model.vendor,
            vendorSlug: model.vendorSlug,
            logoKey: model.logoKey,
            introductionURL: model.introductionURL,
            condition: model.condition,
            lower: roundTo(lower),
            upper: roundTo(upper),
            coverage: roundTo(coveredBasisPoints / totalBasisPoints * 100),
            resultCount: resultKeys.size,
            fallbackUsageCount: fallbackResolutions.length,
            fallbackCoverage: roundTo(fallbackCoveredBasisPoints / totalBasisPoints * 100),
            fallbackResolutions
        };
    });
}

export async function loadModels(connection) {
    const [rows] = await connection.execute(`
        SELECT models.ID AS model_ID, models.name AS model_name,
               models.introduction_url AS introductionURL,
               vendors.name AS vendor_name, vendors.slug AS vendor_slug, vendors.logo_key,
               model_conditions.ID AS model_condition_ID,
               model_conditions.name AS model_condition_name,
               model_conditions.condition_key,
               model_conditions.is_default AS model_condition_is_default,
               benchmark_results.ID AS result_ID,
               benchmark_results.benchmark_condition_ID,
               benchmark_results.raw_score,
               benchmark_conditions.uses_percentage_scale,
               benchmark_conditions.score_min,
               benchmark_conditions.score_max,
               benchmark_conditions.score_direction,
               benchmark_conditions.target_value
        FROM models
        JOIN vendors ON vendors.ID = models.vendor_ID
        JOIN model_conditions
          ON model_conditions.model_ID = models.ID
         AND model_conditions.is_active = 1
        LEFT JOIN benchmark_results
          ON benchmark_results.model_condition_ID = model_conditions.ID
         AND benchmark_results.status = 'accepted'
         LEFT JOIN benchmark_conditions
           ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
          AND benchmark_conditions.is_active = 1
        WHERE models.is_active = 1
        ORDER BY models.name, models.ID,
                 model_conditions.is_default DESC,
                 model_conditions.name, model_conditions.ID,
                 benchmark_results.ID`);
    const modelConditions = new Map();
    for (const row of rows) {
        const modelConditionID = Number(row.model_condition_ID);
        if (!modelConditions.has(modelConditionID)) {
            const isDefaultCondition = Boolean(row.model_condition_is_default);
            modelConditions.set(modelConditionID, {
                ID: modelConditionID,
                modelID: Number(row.model_ID),
                name: isDefaultCondition
                    ? row.model_name
                    : `${row.model_name} · ${row.model_condition_name}`,
                vendor: row.vendor_name,
                vendorSlug: row.vendor_slug,
                logoKey: row.logo_key,
                introductionURL: row.introductionURL,
                condition: {
                    ID: modelConditionID,
                    name: row.model_condition_name
                },
                resultSamples: new Map(),
                results: new Map()
            });
        }
        if (row.result_ID !== null && row.benchmark_condition_ID !== null && row.score_direction !== null) {
            const key = resultKey(row.benchmark_condition_ID);
            const normalizedScore = normalizedResultScore({
                rawScore: row.raw_score,
                usesPercentageScale: Boolean(row.uses_percentage_scale),
                scoreMin: row.score_min,
                scoreMax: row.score_max,
                scoreDirection: row.score_direction,
                targetValue: row.target_value
            });
            if (normalizedScore === null) {
                throw requestError(409, 'accepted_result_score_invalid', {
                    resultID: Number(row.result_ID),
                    modelConditionID,
                    conditionID: Number(row.benchmark_condition_ID)
                });
            }
            const samples = modelConditions.get(modelConditionID).resultSamples;
            if (!samples.has(key)) {
                samples.set(key, []);
            }
            samples.get(key).push(normalizedScore);
        } else if (row.result_ID !== null) {
            throw requestError(409, 'accepted_result_condition_unavailable', {
                resultID: Number(row.result_ID),
                conditionID: Number(row.benchmark_condition_ID)
            });
        }
    }
    return Array.from(modelConditions.values()).map(model => {
        for (const [key, samples] of model.resultSamples) {
            model.results.set(key, {
                normalizedScore: medianOfFiniteNumbers(samples),
                sampleCount: samples.length
            });
        }
        delete model.resultSamples;
        return model;
    });
}

export async function getRankingWorkspace(db, {
    categoryID,
    contextValues = {},
    userID = null
} = {}) {
    const context = await resolveRankingContext(db, { categoryID, contextValues, create: false });
    const conditions = await loadBenchmarkConditions(db);
    const conditionsByID = new Map(conditions.map(condition => [condition.conditionID, condition]));
    const publicPie = await loadPublicPie(db, context, conditionsByID);
    const storedPersonalPie = await loadPersonalPie(db, context.ID, userID);
    const personalSourceEntries = storedPersonalPie?.entries ?? [];
    const personalSourceFallbackRules = storedPersonalPie?.fallbackRules ?? [];
    const personalEntries = decoratePieEntries(personalSourceEntries, conditionsByID);
    const personalFallbackRules = decorateFallbackRules(personalSourceFallbackRules, conditionsByID);
    const publicEntries = decoratePieEntries(publicPie.entries, conditionsByID);
    const benchmarkList = buildBenchmarkList(conditions, publicEntries, personalEntries);
    const models = await loadModels(db);
    const personalScoringEntries = context.ID === null
        ? []
        : personalSourceEntries.map(entry => ({
            conditionID: entry.conditionID,
            weightBasisPoints: entry.weightBasisPoints
        }));

    return {
        authenticated: Boolean(userID),
        context,
        personalPie: {
            revision: storedPersonalPie?.revision ?? 0,
            isDraft: !storedPersonalPie,
            editable: Boolean(userID),
            entries: personalEntries,
            fallbackRules: personalFallbackRules
        },
        publicPie: {
            participantCount: publicPie.participantCount,
            isFallback: false,
            entries: publicEntries,
            fallbackRules: []
        },
        benchmarks: benchmarkList,
        modelLeaderboards: {
            personal: scoreModels(models, personalScoringEntries, PIE_TOTAL_BASIS_POINTS, {
                fallbackRules: personalSourceFallbackRules
            }),
            public: scoreModels(
                models,
                publicPie.scoringEntries,
                publicPie.participantCount * PIE_TOTAL_BASIS_POINTS
            )
        },
        scoreScale: {
            min: 0,
            max: 100,
            higherIsBetter: true
        },
        limits: {
            totalBasisPoints: PIE_TOTAL_BASIS_POINTS,
            maxPieItems: MAX_PIE_ITEMS
        },
        serverTime: new Date().toISOString()
    };
}

function validatePieEntries(entries) {
    if (!Array.isArray(entries) || entries.length > MAX_PIE_ITEMS) {
        throw requestError(400, 'invalid_pie_size', { maxPieItems: MAX_PIE_ITEMS });
    }
    if (entries.length === 0) {
        return [];
    }
    const seen = new Set();
    const normalized = entries.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw requestError(400, 'invalid_pie_entry');
        }
        const conditionID = parseSafeInteger(entry.conditionID, { minimum: 1 });
        const weightBasisPoints = parseSafeInteger(entry.weightBasisPoints, {
            minimum: PIE_MIN_ITEM_BASIS_POINTS
        });
        if (conditionID === null
            || weightBasisPoints === null
            || weightBasisPoints > PIE_TOTAL_BASIS_POINTS
            || seen.has(conditionID)) {
            throw requestError(400, 'invalid_pie_entry');
        }
        seen.add(conditionID);
        return { conditionID, weightBasisPoints };
    });
    const total = normalized.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
    if (total !== PIE_TOTAL_BASIS_POINTS) {
        throw requestError(400, 'pie_total_must_equal_100_percent', { totalBasisPoints: total });
    }
    return normalized;
}

function hasExactKeys(value, expectedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function assertFallbackRulesAcyclic(rules) {
    const primaryIDs = new Set(rules.map(rule => rule.primaryConditionID));
    const graph = new Map(rules.map(rule => [
        rule.primaryConditionID,
        rule.entries
            .map(entry => entry.conditionID)
            .filter(conditionID => primaryIDs.has(conditionID))
    ]));
    const visiting = new Set();
    const visited = new Set();
    const visit = conditionID => {
        if (visiting.has(conditionID)) {
            throw requestError(400, 'pie_fallback_cycle_not_allowed', { conditionID });
        }
        if (visited.has(conditionID)) return;
        visiting.add(conditionID);
        for (const targetID of graph.get(conditionID) ?? []) {
            visit(targetID);
        }
        visiting.delete(conditionID);
        visited.add(conditionID);
    };
    graph.forEach((_, conditionID) => visit(conditionID));
}

function validateFallbackRules(fallbackRules, pieEntries) {
    if (!Array.isArray(fallbackRules) || fallbackRules.length > pieEntries.length) {
        throw requestError(400, 'invalid_personal_pie_fallback_rules');
    }
    const pieConditionIDs = new Set(pieEntries.map(entry => entry.conditionID));
    const primaryIDs = new Set();
    const normalized = fallbackRules.map(rule => {
        if (!hasExactKeys(rule, ['primaryConditionID', 'mode', 'entries'])) {
            throw requestError(400, 'invalid_personal_pie_fallback_rule');
        }
        const primaryConditionID = parseSafeInteger(rule.primaryConditionID, { minimum: 1 });
        if (primaryConditionID === null
            || !pieConditionIDs.has(primaryConditionID)
            || primaryIDs.has(primaryConditionID)
            || rule.mode !== FALLBACK_RULE_MODE
            || !Array.isArray(rule.entries)
            || rule.entries.length === 0
            || rule.entries.length > MAX_FALLBACK_COMPONENTS) {
            throw requestError(400, 'invalid_personal_pie_fallback_rule', {
                primaryConditionID: rule.primaryConditionID,
                maxComponents: MAX_FALLBACK_COMPONENTS
            });
        }
        primaryIDs.add(primaryConditionID);
        const conditionIDs = new Set();
        let totalBasisPoints = 0;
        const entries = rule.entries.map(entry => {
            if (!hasExactKeys(entry, ['conditionID', 'weightBasisPoints'])) {
                throw requestError(400, 'invalid_personal_pie_fallback_component', { primaryConditionID });
            }
            const conditionID = parseSafeInteger(entry.conditionID, { minimum: 1 });
            const weightBasisPoints = parseSafeInteger(entry.weightBasisPoints, {
                minimum: PIE_MIN_ITEM_BASIS_POINTS
            });
            if (conditionID === null
                || conditionID === primaryConditionID
                || conditionIDs.has(conditionID)
                || weightBasisPoints === null
                || weightBasisPoints > PIE_TOTAL_BASIS_POINTS) {
                throw requestError(400, 'invalid_personal_pie_fallback_component', {
                    primaryConditionID,
                    conditionID: entry.conditionID
                });
            }
            conditionIDs.add(conditionID);
            totalBasisPoints += weightBasisPoints;
            return { conditionID, weightBasisPoints };
        });
        if (totalBasisPoints !== PIE_TOTAL_BASIS_POINTS) {
            throw requestError(400, 'pie_fallback_total_must_equal_100_percent', {
                primaryConditionID,
                totalBasisPoints
            });
        }
        return { primaryConditionID, mode: FALLBACK_RULE_MODE, entries };
    });
    assertFallbackRulesAcyclic(normalized);
    return normalized;
}

export async function savePersonalPie(db, {
    userID,
    categoryID,
    contextValues = {},
    expectedRevision,
    entries,
    fallbackRules
}) {
    const normalizedUserID = normalizeUserID(userID);
    const normalizedCategoryID = parseSafeInteger(categoryID, { minimum: 1 });
    const revision = parseSafeInteger(expectedRevision);
    if (!normalizedUserID
        || normalizedCategoryID === null
        || revision === null) {
        throw requestError(400, 'invalid_personal_pie_request');
    }
    const normalizedEntries = validatePieEntries(entries);
    const normalizedFallbackRules = validateFallbackRules(fallbackRules, normalizedEntries);
    const connection = await db.getConnection();
    let resolvedCategoryID;
    let resolvedContextValues;
    let returnEarly = false;
    try {
        await connection.beginTransaction();
        const [users] = await connection.execute(`
            SELECT ID
            FROM users
            WHERE ID = ? AND deleted_at IS NULL
              AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW()))
            FOR UPDATE`, [normalizedUserID]);
        if (users.length === 0) {
            throw requestError(403, 'account_unavailable');
        }

        const category = await resolveCategory(connection, normalizedCategoryID);
        resolvedCategoryID = category.ID;
        const dimensions = await loadDimensions(connection, category);
        const resolvedContext = canonicalizeContextValues(
            contextValues,
            dimensions,
            { requireAllDimensions: true }
        );
        resolvedContextValues = resolvedContext.contextValues;
        let context = await findContext(connection, category.ID, resolvedContextValues);

        if (context.ID === null && normalizedEntries.length === 0) {
            if (revision !== 0) {
                throw requestError(409, 'pie_revision_conflict', { currentRevision: 0 });
            }
            returnEarly = true;
        } else {
            if (context.ID === null) {
                context = await ensureContext(connection, category.ID, resolvedContextValues);
            }

            const [pies] = await connection.execute(`
                SELECT ID, revision
                FROM personal_pies
                WHERE user_ID = ? AND context_ID = ?
                FOR UPDATE`, [normalizedUserID, context.ID]);
            if (normalizedEntries.length === 0) {
                if (pies.length === 0) {
                    if (revision !== 0) {
                        throw requestError(409, 'pie_revision_conflict', { currentRevision: 0 });
                    }
                } else {
                    const currentRevision = Number(pies[0].revision);
                    if (revision !== currentRevision) {
                        throw requestError(409, 'pie_revision_conflict', { currentRevision });
                    }
                    await connection.execute('DELETE FROM personal_pies WHERE ID = ?', [Number(pies[0].ID)]);
                }
                returnEarly = true;
            } else {
                const primaryConditionIDs = normalizedEntries.map(entry => entry.conditionID);
                const fallbackConditionIDs = normalizedFallbackRules.flatMap(rule => (
                    rule.entries.map(entry => entry.conditionID)
                ));
                const conditionIDs = [...new Set([...primaryConditionIDs, ...fallbackConditionIDs])];
                const [conditions] = await connection.execute(`
                    SELECT ID
                    FROM benchmark_conditions
                    WHERE ID IN (${conditionIDs.map(() => '?').join(', ')})
                      AND is_active = 1
                    FOR SHARE`, conditionIDs);
                if (conditions.length !== conditionIDs.length) {
                    throw requestError(404, 'pie_benchmark_condition_not_found');
                }

                let pieID;
                if (pies.length === 0) {
                    if (revision !== 0) {
                        throw requestError(409, 'pie_revision_conflict', { currentRevision: 0 });
                    }
                    const [result] = await connection.execute(`
                        INSERT INTO personal_pies (user_ID, context_ID, revision)
                        VALUES (?, ?, 1)`, [normalizedUserID, context.ID]);
                    pieID = Number(result.insertId);
                } else {
                    const currentRevision = Number(pies[0].revision);
                    if (revision !== currentRevision) {
                        throw requestError(409, 'pie_revision_conflict', { currentRevision });
                    }
                    pieID = Number(pies[0].ID);
                    await connection.execute(`
                        UPDATE personal_pies
                        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
                        WHERE ID = ?`, [pieID]);
                    await connection.execute('DELETE FROM personal_pie_weights WHERE pie_ID = ?', [pieID]);
                }

                const valueSQL = normalizedEntries.map(() => '(?, ?, ?)').join(', ');
                const valueParams = normalizedEntries.flatMap(entry => [pieID, entry.conditionID, entry.weightBasisPoints]);
                await connection.execute(`
                    INSERT INTO personal_pie_weights (pie_ID, benchmark_condition_ID, weight_basis_points)
                    VALUES ${valueSQL}`, valueParams);

                if (normalizedFallbackRules.length > 0) {
                    const ruleValueSQL = normalizedFallbackRules.map(() => '(?, ?, ?)').join(', ');
                    const ruleValueParams = normalizedFallbackRules.flatMap(rule => [
                        pieID,
                        rule.primaryConditionID,
                        rule.mode
                    ]);
                    await connection.execute(`
                        INSERT INTO personal_pie_score_rules
                            (pie_ID, primary_benchmark_condition_ID, mode)
                        VALUES ${ruleValueSQL}`, ruleValueParams);

                    const components = normalizedFallbackRules.flatMap(rule => (
                        rule.entries.map(entry => ({
                            primaryConditionID: rule.primaryConditionID,
                            ...entry
                        }))
                    ));
                    const componentValueSQL = components.map(() => '(?, ?, ?, ?)').join(', ');
                    const componentValueParams = components.flatMap(component => [
                        pieID,
                        component.primaryConditionID,
                        component.conditionID,
                        component.weightBasisPoints
                    ]);
                    await connection.execute(`
                        INSERT INTO personal_pie_score_rule_components
                            (pie_ID, primary_benchmark_condition_ID,
                             fallback_benchmark_condition_ID, weight_basis_points)
                        VALUES ${componentValueSQL}`, componentValueParams);
                }
            }
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    if (returnEarly || normalizedEntries.length > 0) {
        return getRankingWorkspace(db, {
            categoryID: resolvedCategoryID,
            contextValues: resolvedContextValues,
            userID: normalizedUserID
        });
    }
    throw requestError(500, 'personal_pie_save_incomplete');
}
