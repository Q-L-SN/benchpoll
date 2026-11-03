import { comparisonOptions, groupComparisonModels, comparisonGroupIsComparable } from './model-comparison.js';
import { selectableBenchmarkConditionSQL, conditionCoverage } from './benchmark-condition-visibility.js';
import { fieldKey, fieldDisplayValue, normalizeScoreFields } from './public/js/shared/score-fields.js';
import { loadScoreFieldCatalog } from './score-field-service.js';
import crypto from 'node:crypto';
import { claimWriteIntent, completeWriteIntent } from './write-idempotency.js';
import { ownsCategory } from './private-category-service.js';
import { topicCreator } from './topic-service.js';
import { FEATURED_TOPIC_ID, topicURL, sceneSummary } from './public/js/shared/topics.js';
import { currentScoreSQL } from './score-aggregation.js';
import { scoreEvidenceHash } from './score-evidence.js';
import { FALLBACK_RULE_MODE, familyKey, resolvedFamilyConditionIDs } from './public/js/shared/benchmark-families.js';
import { FALLBACK_SELECTION_SOURCES } from './public/js/shared/fallback-choice.js';
import { loadBenchmarkFamilies, ensureBenchmarkFamily, parseFamilyRows, pruneUnusedBenchmarkFamilies } from './benchmark-family-service.js';
import { availableResultInference, normalizeAvailableInferenceVersion,
    AVAILABLE_INFERENCE_VERSION } from './public/js/shared/available-score.js';
import { createPairwiseReference } from './pairwise-score.js';
import { DEFAULT_ESTIMATION_ALGORITHM, normalizeEstimationAlgorithm } from './public/js/shared/estimation-algorithms.js';
import { benchmarkVersionTieOrder } from './public/js/shared/benchmark-version-order.js';
import { isAACondition, AA_DISPLAY_RESTRICTION } from './public/js/shared/aa-ranking-policy.js';
import { aaResultReason } from './aa-archive-policy.js';
import { resolveTopicScene } from './topic-scenes-service.js';
import { loadTopicReferenceTargets, referenceCondition, missingReferenceCondition,
    lockTopicReferences, validateTopicReferences, expandTopicReferences, publicReferenceWeights } from './topic-reference-service.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection, destroyTransactionConnection } from './db-transaction.js';
import { cachedRankingRead, cachedRankingCalculation, cloneRankingMetadata, cloneRankingMembersForJSON, deferRankingMetadata, hasRankingReadCache, withRankingReadCache } from './ranking-read-cache.js';

export const PIE_TOTAL_BASIS_POINTS = 10000;
export const PIE_MIN_ITEM_BASIS_POINTS = 100;
export const MAX_PIE_ITEMS = PIE_TOTAL_BASIS_POINTS / PIE_MIN_ITEM_BASIS_POINTS;
export { FALLBACK_RULE_MODE };
export const MIN_COMPARABLE_MODELS = 3;
export const PUBLIC_PIE_SAMPLE_HOURS = 72;
export const PUBLIC_FALLBACK_ACTIVITY_DAYS = 14;
export const PUBLIC_PIE_MIN_SAMPLES = 10;
export const RANKING_READ_TIMEOUT_MS = 45000;

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

export function normalizeUserID(value) {
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
    if (Math.abs(Number(value)) > Number.MAX_VALUE / scale) return Number(value);
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

async function resolveCategory(connection, requestedCategoryID, userID = null) {
    const categoryID = requestedCategoryID == null ? FEATURED_TOPIC_ID
        : parseSafeInteger(requestedCategoryID, { minimum: 1 });
    if (categoryID === null) throw requestError(400, 'invalid_category_id');
    const [rows] = await connection.execute(`SELECT c.ID, c.name, c.slug, c.description, c.position, c.owner_user_ID,
        c.created_by_user_ID, COALESCE(NULLIF(p.display_name, ''), creator.name) AS creator_name,
        COALESCE(p.avatar_data_url, creator.profile_picture_URL) AS creator_avatar
        FROM categories c LEFT JOIN users creator ON creator.ID = c.created_by_user_ID AND creator.deleted_at IS NULL
        LEFT JOIN user_public_profiles p ON p.user_ID = creator.ID WHERE c.ID = ? AND c.is_active = 1`, [categoryID]);
    if (!rows.length || rows[0].owner_user_ID != null && !ownsCategory(rows[0], userID)) {
        throw requestError(404, 'category_not_found');
    }
    const category = rows[0];
    const isPrivate = category.owner_user_ID != null;
    const lineage = [{ ID: categoryID, name: category.name, position: Number(category.position ?? 0) }];
    return {
        ID: categoryID,
        description: category.description ?? '',
        creator: topicCreator(category),
        path: topicURL(categoryID, category.name, isPrivate, category.slug).slice(1),
        lineage,
        isPrivate,
        isLeaf: true
    };
}

export function selectScopedDimensions(rows, category) {
    if (!category.isLeaf || category.isPrivate) return [];
    const scopedIDs = [Number(category.ID ?? category.lineage.at(-1).ID)];
    const priority = new Map(scopedIDs.map((scopeID, index) => [Number(scopeID), index]));
    const selectedByKey = new Map();
    for (const row of rows.filter(row => scopedIDs.includes(Number(row.scope_category_ID)))) {
        const key = String(row.dimension_key);
        const current = selectedByKey.get(key);
        if (!current || priority.get(Number(row.scope_category_ID)) > priority.get(Number(current.scope_category_ID))) {
            selectedByKey.set(key, row);
        }
    }
    const selected = Array.from(selectedByKey.values())
        .sort((a, b) => (Number(a.position) - Number(b.position)) || (Number(a.ID) - Number(b.ID)));
    return selected;
}

export function decorateDimensions(selected, options) {
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

export function canonicalizeContextValues(requestedValues, dimensions, { requireAllDimensions = false } = {}) {
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

async function findContext(connection, categoryID, contextValues, { currentRead = false } = {}) {
    const { serialized, contextHash } = serializeRankingContextValues(contextValues);
    const [rows] = await connection.execute(`
        SELECT ID
        FROM ranking_contexts
        WHERE category_ID = ? AND context_hash = ?
        LIMIT 1${currentRead ? ' FOR SHARE' : ''}`, [categoryID, contextHash]);
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
    if (context.ID !== null) return context;
    const [result] = await connection.execute(`
        INSERT INTO ranking_contexts (category_ID, context_values, context_hash)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE ID = LAST_INSERT_ID(ID)`,
    [categoryID, context.serialized, context.contextHash]);
    const insertedID = parseSafeInteger(result.insertId, { minimum: 1 });
    if (insertedID !== null) return { ...context, ID: insertedID };
    // An UPDATE trigger can clear the duplicate-key insert ID. Read the row,
    // not the transaction's older snapshot, if another writer created it first.
    const current = await findContext(connection, categoryID, contextValues, { currentRead: true });
    if (current.ID === null) {
        throw requestError(500, 'ranking_context_upsert_failed');
    }
    return current;
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

export async function loadBenchmarkConditions(connection, { includeConditionIDs = [] } = {}) {
    if (!Array.isArray(includeConditionIDs)
        || includeConditionIDs.some(id => parseSafeInteger(id, { minimum: 1 }) === null)) {
        throw requestError(400, 'invalid_pie_condition_ids');
    }
    const preservedIDs = [...new Set(includeConditionIDs)];
    const previewClause = preservedIDs.length
        ? `OR candidate_conditions.ID IN (${preservedIDs.map(() => '?').join(', ')})`
        : '';
    const [rows] = await connection.execute(`
        WITH model_coverage AS (
            SELECT benchmark_results.benchmark_condition_ID,
                   COUNT(*) AS approved_score_count,
                   COUNT(DISTINCT benchmark_results.model_ID) AS scored_model_count
            FROM benchmark_results
            JOIN models ON models.ID = benchmark_results.model_ID AND models.is_active = 1
            WHERE ${currentScoreSQL()}
            GROUP BY benchmark_results.benchmark_condition_ID
        ), eligible_benchmarks AS (
            SELECT DISTINCT candidate_conditions.benchmark_ID
            FROM benchmark_conditions candidate_conditions
            LEFT JOIN model_coverage candidate_coverage
                ON candidate_coverage.benchmark_condition_ID = candidate_conditions.ID
            WHERE ${selectableBenchmarkConditionSQL('candidate_conditions')}
              AND (
                  candidate_coverage.scored_model_count >= ?
                  OR EXISTS (
                      SELECT 1 FROM personal_pie_weights
                      WHERE personal_pie_weights.benchmark_condition_ID = candidate_conditions.ID
                  )
                  OR EXISTS (
                      SELECT 1 FROM benchmark_family_members
                      WHERE benchmark_family_members.benchmark_condition_ID = candidate_conditions.ID
                        AND EXISTS (SELECT 1 FROM personal_pie_score_rules r
                            WHERE r.family_ID = benchmark_family_members.family_ID)
                  )
                  OR EXISTS (
                      SELECT 1 FROM benchmark_families
                      WHERE benchmark_families.primary_benchmark_condition_ID = candidate_conditions.ID
                        AND EXISTS (SELECT 1 FROM personal_pie_score_rules r
                            WHERE r.family_ID = benchmark_families.ID)
                  )
                  ${previewClause}
              )
        )
        SELECT benchmark_conditions.ID AS condition_ID,
               benchmark_conditions.benchmark_ID,
               benchmark_conditions.condition_key,
               benchmark_conditions.score_source,
               benchmark_conditions.name AS condition_name,
               benchmark_conditions.uses_percentage_scale,
               benchmark_conditions.score_min,
               benchmark_conditions.score_max,
               benchmark_conditions.score_direction,
               benchmark_conditions.target_value,
               benchmark_conditions.is_default,
               benchmark_conditions.is_primary,
               benchmarks.name,
               benchmarks.introduction_url,
               COALESCE(model_coverage.scored_model_count, 0) AS scored_model_count,
               COALESCE(model_coverage.approved_score_count, 0) AS approved_score_count
        FROM benchmark_conditions
        JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
        JOIN eligible_benchmarks ON eligible_benchmarks.benchmark_ID = benchmark_conditions.benchmark_ID
        LEFT JOIN model_coverage ON model_coverage.benchmark_condition_ID = benchmark_conditions.ID
        WHERE ${selectableBenchmarkConditionSQL()}
          AND benchmarks.is_active = 1
        ORDER BY benchmarks.name, benchmark_conditions.is_default DESC,
                  benchmark_conditions.name, benchmark_conditions.ID`,
    [MIN_COMPARABLE_MODELS, ...preservedIDs]);
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
        const scoreCount = Number(row.approved_score_count);
        if (!Number.isSafeInteger(scoreCount) || scoreCount < 0) {
            throw requestError(409, 'benchmark_condition_score_count_invalid', {
                conditionID: Number(row.condition_ID)
            });
        }
        return {
            ID: Number(row.condition_ID),
            conditionID: Number(row.condition_ID),
            benchmarkID: Number(row.benchmark_ID),
            name: row.name,
            baseName: row.name,
            conditionKey: row.condition_key,
            conditionName,
            excludedFromRanking: isAACondition({ benchmarkID: Number(row.benchmark_ID), benchmarkName: row.name,
                conditionKey: row.condition_key, conditionName, scoreSource: row.score_source }),
            isDefaultCondition: isDefault,
            isPrimaryCondition: Boolean(row.is_primary),
            url: row.introduction_url,
            usesPercentageScale,
            scoreMin,
            scoreMax,
            scoreDirection,
            targetValue,
            scoredModelCount: Number(row.scored_model_count ?? 0),
            scoreCount
        };
    });
}

function contextMatchesSelection(candidateValues, context) {
    const expectedKeys = new Set(context.dimensions.map(dimension => dimension.key));
    const candidateKeys = Object.keys(candidateValues);
    if (candidateKeys.length !== expectedKeys.size
        || candidateKeys.some(key => !expectedKeys.has(key))) {
        throw requestError(409, 'ranking_context_values_mismatch');
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
    if (context.sceneID != null || context.sceneMode === true) {
        return context.ID == null ? [] : [{ ID: context.ID, categoryID: context.categoryID,
            contextValues: context.contextValues }];
    }
    const [rows] = await connection.execute(`
        SELECT rc.ID, rc.category_ID, rc.context_values
        FROM ranking_contexts rc
        JOIN categories c ON c.ID = rc.category_ID
        WHERE rc.category_ID = ? AND c.is_active = 1 AND c.owner_user_ID IS NULL
        ORDER BY rc.ID`, [context.categoryID]);
    return rows.map(row => ({
        ID: Number(row.ID),
        categoryID: Number(row.category_ID),
        contextValues: parseContextValues(row.context_values, Number(row.ID))
    })).filter(candidate => contextMatchesSelection(candidate.contextValues, context));
}

export async function loadPublicPie(connection, context, conditionsByID) {
    if (context.isPrivate) return { entries: [], familyComposition: [], participantCount: 0,
        isFallback: false, scoringEntries: [], contextIDs: [] };
    const matchingContexts = await loadMatchingContexts(connection, context);
    if (matchingContexts.length === 0) {
        return { entries: [], familyComposition: [], participantCount: 0, isFallback: false, scoringEntries: [], contextIDs: [] };
    }
    const contextIDs = matchingContexts.map(candidate => candidate.ID);
    const [rows] = await connection.execute(`
        SELECT personal_pies.ID AS pie_ID, personal_pies.context_ID,
               personal_pies.updated_at >= NOW() - INTERVAL ${PUBLIC_PIE_SAMPLE_HOURS} HOUR AS is_recent,
               personal_pies.updated_at >= NOW() - INTERVAL ${PUBLIC_FALLBACK_ACTIVITY_DAYS} DAY AS is_fallback_recent,
               personal_pie_weights.benchmark_condition_ID,
               personal_pie_weights.weight_basis_points
        FROM personal_pies
        JOIN users ON users.ID = personal_pies.user_ID
        LEFT JOIN (SELECT pie_ID, benchmark_condition_ID, weight_basis_points FROM personal_pie_weights
            UNION ALL SELECT pie_ID, -target_context_ID AS benchmark_condition_ID, weight_basis_points
            FROM personal_pie_topic_weights) personal_pie_weights ON personal_pie_weights.pie_ID = personal_pies.ID
        WHERE personal_pies.context_ID IN (${contextIDs.map(() => '?').join(', ')})
          AND users.deleted_at IS NULL
          AND (users.banned_at IS NULL
               OR (users.banned_until IS NOT NULL AND users.banned_until <= NOW()))
        ORDER BY personal_pies.context_ID, personal_pies.updated_at DESC,
                 personal_pies.ID DESC, personal_pie_weights.benchmark_condition_ID`, contextIDs);

    const pies = new Map();
    for (const row of rows) {
        const pieID = Number(row.pie_ID);
        const recent = Number(row.is_recent);
        const fallbackRecent = Number(row.is_fallback_recent);
        if ((recent !== 0 && recent !== 1) || (fallbackRecent !== 0 && fallbackRecent !== 1)
            || (recent === 1 && fallbackRecent !== 1)) {
            throw requestError(409, 'personal_pie_recency_invalid', { pieID });
        }
        if (!pies.has(pieID)) {
            pies.set(pieID, {
                contextID: Number(row.context_ID),
                isRecent: recent === 1,
                isFallbackRecent: fallbackRecent === 1,
                entries: [],
                conditionIDs: new Set(),
                total: 0
            });
        }
        if (row.benchmark_condition_ID === null) {
            continue;
        }
        const conditionID = Number(row.benchmark_condition_ID);
        if (conditionID < 0 && !conditionsByID.has(conditionID)) {
            conditionsByID.set(conditionID, missingReferenceCondition(-conditionID));
        }
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
        const eligible = pie.entries.filter(entry => !conditionsByID.get(entry.conditionID)?.excludedFromRanking);
        if (!eligible.length) continue;
        if (eligible.length !== pie.entries.length) pie.entries = normalizeWeights(eligible.map(entry => ({
            conditionID: entry.conditionID, rawWeight: entry.weightBasisPoints
        })));
        validPies.set(pieID, pie);
    }
    if (validPies.size === 0) {
        return { entries: [], familyComposition: [], participantCount: 0, isFallback: false, scoringEntries: [], contextIDs };
    }

    const piesByContext = new Map(contextIDs.map(ID => [ID, []]));
    for (const [pieID, pie] of validPies) {
        const group = piesByContext.get(pie.contextID);
        if (!group) throw requestError(409, 'public_pie_context_outside_scope', { contextID: pie.contextID });
        group.push([pieID, pie]);
    }
    const selectedPies = new Map();
    for (const group of piesByContext.values()) {
        const recent = group.filter(([, pie]) => pie.isRecent);
        // Rows are newest first: sparse contexts use ten total, with no age cutoff.
        const sample = recent.length >= PUBLIC_PIE_MIN_SAMPLES ? recent : group.slice(0, PUBLIC_PIE_MIN_SAMPLES);
        for (const [pieID, pie] of sample) {
            selectedPies.set(pieID, pie);
        }
    }
    const participantCount = selectedPies.size;

    const aggregateWeights = new Map();
    const scoringWeights = new Map();
    for (const pie of selectedPies.values()) {
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
    // Explicit choices have their own electorate; passive recent pies must not crowd them out.
    const configuringPies = new Map([...validPies].filter(([, pie]) => pie.isFallbackRecent));
    const pieIDs = Array.from(configuringPies.keys());
    const fallbackRows = await loadPieFallbackRows(connection, pieIDs);
    const rowsByPie = new Map(pieIDs.map(ID => [ID, []]));
    for (const row of fallbackRows) {
        const pieID = Number(row.pie_ID);
        if (!rowsByPie.has(pieID)) {
            throw requestError(409, 'public_fallback_pie_outside_scope', { pieID });
        }
        rowsByPie.get(pieID).push(row);
    }
    const aggregates = new Map();
    const configuredCounts = new Map();
    for (const [pieID, pie] of configuringPies) {
        const rules = parseStoredFallbackRules(rowsByPie.get(pieID), pie.conditionIDs, pieID);
        const rulesByPrimary = new Map(rules.map(rule => [rule.primaryConditionID, rule]));
        for (const entry of pie.entries) {
            const rule = rulesByPrimary.get(entry.conditionID);
            if (!rule) continue;
            const members = rule.entries;
            for (const member of members) {
                if (!conditionsByID.has(member.conditionID)) throw requestError(409, 'personal_pie_fallback_condition_not_available', { pieID, conditionID: member.conditionID });
            }
            if (!aggregates.has(entry.conditionID)) aggregates.set(entry.conditionID, new Map());
            const families = aggregates.get(entry.conditionID);
            configuredCounts.set(entry.conditionID, (configuredCounts.get(entry.conditionID) ?? 0) + 1);
            const key = familyKey(entry.conditionID, members);
            const previous = families.get(key);
            families.set(key, { primaryConditionID: entry.conditionID, familyID: rule?.familyID ?? null,
                entries: members, rawWeight: (previous?.rawWeight ?? 0) + entry.weightBasisPoints });
        }
    }
    // Keep whole chains separate. Mixing alternative positions changes first-present semantics.
    const communityComposition = Array.from(new Set([...aggregateWeights.keys(), ...aggregates.keys()].filter(ID => ID > 0)), primaryConditionID => {
        const totalWeight = aggregateWeights.get(primaryConditionID) ?? 0;
        const families = aggregates.get(primaryConditionID) ?? new Map();
        const denominator = [...families.values()].reduce((sum, family) => sum + family.rawWeight, 0);
        const configuredPieCount = configuredCounts.get(primaryConditionID) ?? 0;
        const choices = denominator > 0 ? [...families.values()] : [
            { primaryConditionID, familyID: null, entries: [], rawWeight: 1 }
        ];
        return {
            primaryConditionID,
            configuredPieCount,
            isDefault: configuredPieCount === 0,
            families: choices.map(({ rawWeight, ...family }) => ({ ...family,
                weightBasisPoints: rawWeight / (denominator || 1) * PIE_TOTAL_BASIS_POINTS,
                overallWeightBasisPoints: totalWeight / participantCount * rawWeight / (denominator || 1)
            })).sort((a, b) => b.weightBasisPoints - a.weightBasisPoints
                || familyKey(primaryConditionID, a.entries).localeCompare(familyKey(primaryConditionID, b.entries)))
        };
    });
    const familyComposition = communityComposition.filter(group => aggregateWeights.has(group.primaryConditionID));
    return {
        familyComposition,
        communityComposition,
        entries: normalizeWeights(Array.from(aggregateWeights, ([conditionID, rawWeight]) => ({
            conditionID,
            rawWeight
        }))),
        participantCount,
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
        FROM (SELECT pie_ID, benchmark_condition_ID, weight_basis_points FROM personal_pie_weights
            UNION ALL SELECT pie_ID, -target_context_ID AS benchmark_condition_ID, weight_basis_points
            FROM personal_pie_topic_weights) personal_pie_weights
        WHERE pie_ID = ?
        ORDER BY weight_basis_points DESC, benchmark_condition_ID`, [pie.ID]);
    const entries = weights.map(row => ({
        conditionID: Number(row.benchmark_condition_ID),
        weightBasisPoints: Number(row.weight_basis_points)
    }));
    const conditionIDs = new Set();
    for (const entry of entries) {
        if (!Number.isSafeInteger(entry.conditionID)
            || entry.conditionID === 0
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
    const fallbackRows = await loadPieFallbackRows(connection, [Number(pie.ID)]);
    return {
        ID: Number(pie.ID),
        revision: Number(pie.revision),
        updatedAt: pie.updated_at,
        entries,
        fallbackRules: parseStoredFallbackRules(fallbackRows, conditionIDs, Number(pie.ID))
    };
}

async function loadPieFallbackRows(connection, pieIDs) {
    if (!pieIDs.length) return [];
    const [rows] = await connection.execute(`SELECT rules.pie_ID, rules.primary_benchmark_condition_ID,
        rules.family_ID AS selected_family_ID, rules.selection_source,
        f.ID AS family_ID, f.chain_hash, m.position,
        m.benchmark_condition_ID AS fallback_benchmark_condition_ID
        FROM personal_pie_score_rules rules
        LEFT JOIN benchmark_families f ON f.ID = rules.family_ID
          AND f.primary_benchmark_condition_ID = rules.primary_benchmark_condition_ID
        LEFT JOIN benchmark_family_members m ON m.family_ID = f.ID
        WHERE rules.pie_ID IN (${pieIDs.map(() => '?').join(', ')})
        ORDER BY rules.pie_ID, rules.primary_benchmark_condition_ID, m.position`, pieIDs);
    return rows;
}

function parseStoredFallbackRules(rows, conditionIDs, pieID) {
    const explicitNone = rows.filter(row => row.selected_family_ID === null);
    for (const row of explicitNone) {
        if (row.family_ID !== null || row.position !== null || row.fallback_benchmark_condition_ID !== null) {
            throw requestError(409, 'benchmark_family_invariant_failed', { pieID });
        }
    }
    const families = [...parseFamilyRows(rows.filter(row => row.selected_family_ID !== null)),
        ...explicitNone.map(row => ({ primaryConditionID: Number(row.primary_benchmark_condition_ID),
            familyID: null, mode: FALLBACK_RULE_MODE, entries: [] }))];
    const primaryIDs = new Set();
    const selectionSources = new Map(rows.map(row => [Number(row.primary_benchmark_condition_ID), row.selection_source]));
    for (const family of families) {
        if (!conditionIDs.has(family.primaryConditionID) || primaryIDs.has(family.primaryConditionID)) {
            throw requestError(409, 'personal_pie_fallback_primary_invalid', { pieID, primaryConditionID: family.primaryConditionID });
        }
        primaryIDs.add(family.primaryConditionID);
        const source = selectionSources.get(family.primaryConditionID);
        if (source !== undefined) {
            if (!FALLBACK_SELECTION_SOURCES.includes(source)) throw requestError(409, 'personal_pie_fallback_source_invalid', { pieID });
            family.selectionSource = source;
        }
    }
    return families;
}

export function decoratePieEntries(entries, conditionsByID) {
    return entries.map(entry => {
        const condition = conditionsByID.get(Number(entry.conditionID))
            ?? (entry.conditionID < 0 ? missingReferenceCondition(-entry.conditionID) : null);
        if (!condition) {
            throw requestError(409, 'pie_condition_not_available', { conditionID: Number(entry.conditionID) });
        }
        return {
            ...(condition.type === 'topic' ? condition : {}),
            conditionID: condition.conditionID,
            benchmarkID: condition.benchmarkID,
            name: condition.name,
            conditionKey: condition.conditionKey,
            conditionName: condition.conditionName,
            excludedFromRanking: condition.excludedFromRanking === true,
            isDefaultCondition: condition.isDefaultCondition,
            isPrimaryCondition: condition.isPrimaryCondition,
            lowCoverage: condition.lowCoverage,
            scoredModelCount: condition.scoredModelCount,
            scoreCount: condition.scoreCount,
            weightBasisPoints: Number(entry.weightBasisPoints),
            weight: roundTo(Number(entry.weightBasisPoints) / 100)
        };
    }).sort((a, b) => (b.weightBasisPoints - a.weightBasisPoints) || benchmarkVersionTieOrder(a, b));
}

function decorateFallbackRules(rules, conditionsByID) {
    return rules.map(rule => ({
        primaryConditionID: rule.primaryConditionID,
        mode: rule.mode,
        familyID: rule.familyID ?? null,
        ...(rule.selectionSource ? { selectionSource: rule.selectionSource } : {}),
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
                excludedFromRanking: condition.excludedFromRanking === true,
                isDefaultCondition: condition.isDefaultCondition,
                isPrimaryCondition: condition.isPrimaryCondition,
                lowCoverage: condition.lowCoverage
            };
        })
    }));
}

export function buildBenchmarkList(conditions, publicEntries, personalEntries, families = [], familyComposition = [], personalRules = []) {
    const measured = new Map(conditionCoverage(conditions.filter(condition => condition.type !== 'topic'))
        .map(condition => [condition.conditionID, condition]));
    conditions = conditions.map(condition => condition.type === 'topic' ? condition : measured.get(condition.conditionID));
    const publicWeights = new Map(publicEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]));
    const personalWeights = new Map(personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]));
    const conditionsByBenchmark = new Map();
    for (const condition of conditions) {
        if (condition.type === 'topic') continue;
        const benchmarkID = condition.benchmarkID;
        if (!conditionsByBenchmark.has(benchmarkID)) conditionsByBenchmark.set(benchmarkID, []);
        conditionsByBenchmark.get(benchmarkID).push(condition);
    }
    for (const family of conditionsByBenchmark.values()) {
        if (family.filter(condition => condition.isPrimaryCondition).length !== 1) {
            throw requestError(409, 'benchmark_primary_condition_invariant_failed', { benchmarkID: family[0].benchmarkID });
        }
    }
    const rows = conditions.map(condition => ({
        ...condition,
        publicWeightBasisPoints: publicWeights.get(condition.conditionID) ?? 0,
        publicWeight: roundTo((publicWeights.get(condition.conditionID) ?? 0) / 100),
        personalWeightBasisPoints: personalWeights.get(condition.conditionID) ?? null,
        personalWeight: personalWeights.has(condition.conditionID)
            ? roundTo(personalWeights.get(condition.conditionID) / 100)
            : null
    }));
    const rowsByConditionID = new Map(rows.map(row => [row.conditionID, row]));
    const publicFamilies = new Map(familyComposition.flatMap(group => group.families.map(family => [
        familyKey(group.primaryConditionID, family.entries), family.overallWeightBasisPoints
    ])));
    const personalFamilies = new Map(personalRules.map(rule => [familyKey(rule.primaryConditionID, rule.entries), rule]));
    for (const family of families) {
        const primary = rowsByConditionID.get(family.primaryConditionID);
        if (!primary) continue;
        const key = familyKey(family.primaryConditionID, family.entries);
        const publicWeightBasisPoints = publicFamilies.get(key) ?? 0;
        const personalWeightBasisPoints = personalFamilies.has(key) ? personalWeights.get(family.primaryConditionID) ?? null : null;
        rows.push({ ...primary, familyID: family.familyID, familyKey: key, isFamily: true,
            familyEntries: family.entries, publicWeightBasisPoints, publicWeight: roundTo(publicWeightBasisPoints / 100),
            personalWeightBasisPoints, personalWeight: personalWeightBasisPoints === null ? null : roundTo(personalWeightBasisPoints / 100) });
    }
    rows.sort((a, b) => b.publicWeightBasisPoints - a.publicWeightBasisPoints
        || benchmarkVersionTieOrder(a, b) || Number(a.isFamily ?? false) - Number(b.isFamily ?? false)
        || (a.familyKey ?? '').localeCompare(b.familyKey ?? ''));
    let previousWeight = null;
    let previousRank = 0;
    rows.filter(row => !row.isFamily).forEach((row, index) => {
        if (row.publicWeightBasisPoints === previousWeight) {
            row.rank = previousRank;
        } else {
            row.rank = index + 1;
            previousRank = row.rank;
            previousWeight = row.publicWeightBasisPoints;
        }
    });
    const entranceRanks = new Map(rows.filter(row => !row.isFamily).map(row => [row.conditionID, row.rank]));
    rows.filter(row => row.isFamily).forEach(row => { row.rank = entranceRanks.get(row.conditionID); });
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
    userID = null,
    create = false,
    requireAllDimensions = false
} = {}) {
    const category = await resolveCategory(connection, categoryID, userID);
    const scene = await resolveTopicScene(connection, category, contextValues, { create, requireAllDimensions });
    if (scene) return {
        ...scene, categoryID: category.ID, categoryPath: category.path,
        categoryName: category.lineage.at(-1).name, description: sceneSummary({
            name: category.lineage.at(-1).name, description: category.description }, scene.scene),
        topicDescription: category.description, creator: category.creator,
        lineage: category.lineage, isPrivate: category.isPrivate, isLeafCategory: true,
        sceneMode: true
    };
    const dimensions = [];
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
        categoryName: category.lineage.at(-1).name,
        description: category.description,
        creator: category.creator,
        lineage: category.lineage.map(item => ({ ID: item.ID, name: item.name, position: item.position })),
        isPrivate: category.isPrivate,
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
            || rulesByPrimary.has(rule.primaryConditionID)) {
            throw new TypeError('invalid fallback rule');
        }
        if (rule.entries.some(entry => Object.hasOwn(entry, 'weightBasisPoints'))) throw new TypeError('Weighted fallbacks are no longer supported');
        familyKey(rule.primaryConditionID, rule.entries);
        rulesByPrimary.set(rule.primaryConditionID, rule);
    }
    return rulesByPrimary;
}

function indexPublicFamilies(composition) {
    if (!Array.isArray(composition)) throw new TypeError('Invalid public family composition');
    const indexed = new Map();
    for (const group of composition) {
        if (!Number.isSafeInteger(group.primaryConditionID) || group.primaryConditionID < 1
            || indexed.has(group.primaryConditionID) || !Array.isArray(group.families) || !group.families.length) {
            throw new TypeError('Invalid public family composition');
        }
        const seen = new Set();
        let total = 0;
        for (const family of group.families) {
            const key = familyKey(group.primaryConditionID, family.entries);
            if (family.primaryConditionID !== group.primaryConditionID || seen.has(key)
                || !Number.isFinite(family.weightBasisPoints) || family.weightBasisPoints <= 0 || family.weightBasisPoints > 10000) {
                throw new TypeError('Invalid public family share');
            }
            seen.add(key);
            total += family.weightBasisPoints;
        }
        if (Math.abs(total - 10000) > 1e-6) throw new TypeError('Public family shares must total 100 percent');
        indexed.set(group.primaryConditionID, group.families);
    }
    return indexed;
}

function currentInferenceVersion(version) {
    try { return normalizeAvailableInferenceVersion(version); }
    catch { throw requestError(400, 'invalid_available_inference_version'); }
}

function currentEstimationAlgorithm(value) {
    try { return normalizeEstimationAlgorithm(value); }
    catch { throw requestError(400, 'invalid_estimation_algorithm'); }
}

export function scoreModels(models, weightedEntries, totalBasisPoints, { fallbackRules = [], familyComposition = [], fallbackScope = 'personal', scoreMode = 'range', availableInferenceVersion = AVAILABLE_INFERENCE_VERSION, estimationAlgorithm = DEFAULT_ESTIMATION_ALGORITHM, percentileReference = null, comparisonScoreIndexes = null, deferMetadata = false, excludedConditionIDs = new Set() } = {}) {
    currentInferenceVersion(availableInferenceVersion);
    currentEstimationAlgorithm(estimationAlgorithm);
    const missingOnly = estimationAlgorithm !== DEFAULT_ESTIMATION_ALGORITHM;
    if (!['range', 'available'].includes(scoreMode)) {
        throw { status: 400, body: { error: 'invalid_score_mode' } };
    }
    if (!Number.isFinite(totalBasisPoints) || totalBasisPoints <= 0 || weightedEntries.length === 0) {
        return [];
    }
    if (!['personal', 'public'].includes(fallbackScope)) throw new TypeError('Invalid fallback scope');
    if (fallbackScope === 'public' && fallbackRules.length) throw new TypeError('Public scoring requires whole family shares');
    const fallbackRulesByPrimary = indexFallbackRules(fallbackRules);
    const publicFamilies = indexPublicFamilies(familyComposition);
    const reference = scoreMode === 'available' ? percentileReference ?? createPairwiseReference(models) : null;
    const plans = weightedEntries.filter(entry => entry.weightBasisPoints > 0).map(entry => {
        const rule = fallbackRulesByPrimary.get(entry.conditionID);
        const families = fallbackScope === 'public' || !rule ? publicFamilies.get(entry.conditionID) : null;
        return { entry, families: (families ?? [{ familyID: rule?.familyID ?? null,
            entries: rule?.entries ?? [], weightBasisPoints: 10000 }]).map(family => ({
            family, fraction: family.weightBasisPoints / 10000,
            chain: entry.conditionID < 0 ? []
                : resolvedFamilyConditionIDs(entry.conditionID, family.entries).filter(ID => !excludedConditionIDs.has(ID))
        })) };
    });
    return models.map(model => {
        let lower = 0;
        let upper = 0;
        let coveredBasisPoints = 0;
        let fallbackCoveredBasisPoints = 0;
        const resultKeys = new Set();
        const fallbackResolutions = [];
        const calculationScores = [];
        const inferredScores = [];
        const estimate = reference?.estimate(model);
        let inferredBasisPoints = 0;
        const comparisonScores = comparisonScoreIndexes?.get(model)
            ?? new Map((model.comparisonScores ?? []).map(score => [Number(score.conditionID), score]));
        const recordScore = (conditionID, normalizedScore, weightBasisPoints, fallbackFor = null, familyID = null, chain = []) => {
            if (weightBasisPoints <= 0) return;
            const comparison = comparisonScores.get(Number(conditionID));
            calculationScores.push({ conditionID: Number(conditionID), normalizedScore,
                weightBasisPoints, fallbackFor, familyID, familyConditionIDs: deferMetadata ? chain : [...chain],
                memberIDs: comparison ? deferMetadata ? comparison.memberIDs : [...comparison.memberIDs] : [model.ID],
                matchedCount: comparison?.matchedCount ?? null,
                memberWeights: (deferMetadata ? comparison?.memberWeights : comparison?.memberWeights.map(item => ({ ...item }))) ?? [{ ID: model.ID, weight: 1 }] });
            calculationScores.at(-1).memberEvidence = (deferMetadata ? comparison?.memberEvidence : comparison?.memberEvidence.map(item => ({ ...item }))) ?? [];
        };
        for (const { entry, families } of plans) {
            const entryFraction = entry.weightBasisPoints / totalBasisPoints;
            for (const { family, fraction, chain } of families) {
                let conditionID = null, normalizedScore = null, attemptedCount = chain.length;
                for (let index = 0; index < chain.length; index++) {
                    const result = model.results.get(resultKey(chain[index]));
                    if (!result || result.normalizedScore === null || result.normalizedScore === undefined) continue;
                    if (!Number.isFinite(result.normalizedScore)) throw new TypeError('Invalid normalized family score');
                    conditionID = chain[index]; normalizedScore = result.normalizedScore; attemptedCount = index + 1; break;
                }
                const resolved = { conditionID, normalizedScore };
                if (resolved.conditionID === null) {
                    upper += entryFraction * fraction * 100;
                    const prediction = entry.conditionID > 0 ? reference?.predict(model, entry.conditionID) : null;
                    if (prediction) {
                        const weight = entry.weightBasisPoints * fraction;
                        inferredBasisPoints += weight;
                        inferredScores.push({ conditionID: entry.conditionID, familyID: family.familyID,
                            ...prediction, ...(missingOnly ? { normalizedScore: Math.min(100, Math.max(0, prediction.normalizedScore)),
                                rawNormalizedScore: prediction.normalizedScore } : {}), weightBasisPoints: weight,
                            originalWeight: weight / totalBasisPoints * 100 });
                    }
                } else {
                    lower += entryFraction * fraction * resolved.normalizedScore;
                    upper += entryFraction * fraction * resolved.normalizedScore;
                    const weight = entry.weightBasisPoints * fraction;
                    coveredBasisPoints += weight;
                    resultKeys.add(resultKey(resolved.conditionID));
                    const isFallback = resolved.conditionID !== entry.conditionID;
                    if (isFallback) fallbackCoveredBasisPoints += weight;
                    recordScore(resolved.conditionID, resolved.normalizedScore, weight, isFallback ? entry.conditionID : null,
                        family.familyID, chain);
                }
                if (family.entries.length && resolved.conditionID !== entry.conditionID) fallbackResolutions.push({
                    primaryConditionID: entry.conditionID, familyID: family.familyID,
                    conditionID: resolved.conditionID, normalizedScore: resolved.normalizedScore,
                    attemptedConditionIDs: chain.slice(0, attemptedCount),
                    weightBasisPoints: entry.weightBasisPoints * fraction
                });
            }
        }
        const observedFraction = coveredBasisPoints / totalBasisPoints;
        const availableInference = scoreMode === 'available' && coveredBasisPoints > 0
            ? availableResultInference(calculationScores.reduce((sum, score) => sum
                + score.normalizedScore * (score.weightBasisPoints / coveredBasisPoints), 0), observedFraction,
            inferredScores.map(score => ({ normalizedScore: score.normalizedScore, weightFraction: score.weightBasisPoints / totalBasisPoints })),
            estimate.percentile, estimate.sourceCount, estimationAlgorithm) : null;
        const availableScore = availableInference ? roundTo(availableInference.totalScore) : null;
        const scoringBasisPoints = scoreMode === 'available' && !missingOnly ? coveredBasisPoints + inferredBasisPoints : totalBasisPoints;
        const weightedScore = score => ({ ...score, effectiveWeight: score.weightBasisPoints / scoringBasisPoints * 100,
            contribution: score.normalizedScore * (score.weightBasisPoints / scoringBasisPoints) });
        const response = {
            ID: model.ID,
            modelID: model.modelID,
            name: model.name,
            vendor: model.vendor,
            vendorSlug: model.vendorSlug,
            logoKey: model.logoKey,
            introductionURL: model.introductionURL,
            condition: deferMetadata ? null : cloneRankingMetadata(model.condition),
            lower: scoreMode === 'available' ? availableScore : roundTo(lower),
            upper: scoreMode === 'available' ? availableScore : roundTo(upper),
            coverage: roundTo(observedFraction * 100),
            availableInference,
            inferredScores: coveredBasisPoints > 0 ? inferredScores.map(weightedScore) : [],
            resultCount: resultKeys.size,
            fallbackUsageCount: new Set(fallbackResolutions.filter(resolution => resolution.conditionID !== null)
                .map(resolution => resolution.primaryConditionID)).size,
            fallbackCoverage: roundTo(fallbackCoveredBasisPoints / totalBasisPoints * 100),
            fallbackResolutions,
            calculationScores: deferMetadata ? null : calculationScores.map(weightedScore),
            missingWeight: Math.max(0, totalBasisPoints - coveredBasisPoints) / totalBasisPoints * 100
        };
        if (deferMetadata) {
            deferRankingMetadata(response, 'condition', () => cloneRankingMetadata(model.condition));
            deferRankingMetadata(response, 'calculationScores', () => cloneRankingMetadata(calculationScores).map(weightedScore));
        }
        return response;
    });
}

export function scoreComparison(models, entries, total, rules, options, preparedGroups = null) {
    if (!Number.isFinite(total) || total <= 0 || entries.length === 0) return [];
    const grouped = preparedGroups ?? groupComparisonModels(models, options, entries, { includeReferenceVersions: rules.scoreMode === 'available' });
    const groupsByID = new Map(grouped.map(group => [group.ID, group]));
    const scoreMode = rules.scoreMode ?? 'range';
    const availableInferenceVersion = currentInferenceVersion(rules.availableInferenceVersion);
    // A model display limit keeps the comparison peers needed for missing-score estimates.
    const referenceOptions = { ...options, filters: (options.filters ?? []).filter(filter => filter.key !== 'model') };
    const reference = scoreMode === 'available' ? rules.percentileReference ?? createPairwiseReference(
        referenceOptions.filters.length === (options.filters ?? []).length ? grouped
            : groupComparisonModels(models, referenceOptions, entries, { includeReferenceVersions: true })) : null;
    const scores = scoreModels(grouped, entries, total, { ...(options.mode === 'matched' ? { scoreMode } : rules), percentileReference: reference,
        availableInferenceVersion, estimationAlgorithm: rules.estimationAlgorithm,
        excludedConditionIDs: rules.excludedConditionIDs,
        comparisonScoreIndexes: rules.comparisonScoreIndexes, deferMetadata: rules.jsonMemberMetadata === true });
    return scores.map(score => {
        const group = groupsByID.get(score.ID);
        const comparisonMetadata = () => {
            const usedConditions = new Set(score.calculationScores.map(item => item.conditionID));
            return cloneRankingMetadata(group.comparisonScores.filter(item => usedConditions.has(item.conditionID)));
        };
        // Evidence eligibility must not depend on how missing weights are scored.
        const comparable = score.resultCount > 0
            && comparisonGroupIsComparable(group, grouped.length, options.mode, entries);
        const response = rules.jsonMemberMetadata ? Object.defineProperties({}, Object.getOwnPropertyDescriptors(score)) : { ...score };
        Object.assign(response, { comparable, comparisonIdentity: group.comparisonIdentity, comparisonMode: group.comparisonMode,
            lower: comparable ? score.lower : null, upper: comparable ? score.upper : null });
        if (rules.jsonMemberMetadata) {
            deferRankingMetadata(response, 'members', () => cloneRankingMembersForJSON(group.members));
            deferRankingMetadata(response, 'comparisonScores', comparisonMetadata);
        } else {
            response.members = cloneRankingMetadata(group.members);
            response.comparisonScores = comparisonMetadata();
        }
        return response;
    });
}

export async function loadApprovedModelConfigurations(connection, modelIDs, definitions = null, {
    includeVersions = false, includeDisplayRestrictions = false
} = {}) {
    if (!Array.isArray(modelIDs) || !modelIDs.length || modelIDs.length > 2048
        || modelIDs.some(ID => !Number.isSafeInteger(ID) || ID < 1)
        || new Set(modelIDs).size !== modelIDs.length) throw requestError(400, 'invalid_model_ids');
    if (typeof includeVersions !== 'boolean' || typeof includeDisplayRestrictions !== 'boolean'
        || includeVersions && modelIDs.length > 32) throw requestError(400, 'invalid_model_score_index');
    const fields = definitions ?? await loadScoreFieldCatalog(connection);
    const [rows] = await connection.execute(`SELECT r.ID, r.benchmark_ID, m.ID AS modelID, m.name AS modelName,
        r.score_fields AS scoreFields, 1 AS scoreCount,
        b.ID AS benchmarkID, b.name AS benchmarkName, c.name AS benchmarkConditionName, c.condition_key AS conditionKey,
        c.score_source AS scoreSource, r.source_url, r.source_title, r.notes
        ${includeVersions ? `, r.raw_score AS rawScore,
            c.ID AS benchmarkConditionID, c.is_default AS benchmarkConditionIsDefault,
            c.uses_percentage_scale AS usesPercentageScale, c.score_min AS scoreMin, c.score_max AS scoreMax,
            c.score_direction AS scoreDirection, c.target_value AS targetValue` : ''}
        FROM benchmark_results r JOIN models m ON m.ID = r.model_ID AND m.is_active = 1
        JOIN benchmarks b ON b.ID = r.benchmark_ID
        JOIN benchmark_conditions c ON c.ID = r.benchmark_condition_ID
        WHERE ${currentScoreSQL('r')} AND b.is_active = 1 AND ${selectableBenchmarkConditionSQL('c')}
          AND m.ID IN (${modelIDs.map(() => '?').join(',')})
        ORDER BY m.name, m.ID`, modelIDs);
    const configurations = new Map();
    const groups = new Map();
    const omittedConfigurations = new Map();
    for (const row of rows) {
        const scoreFields = normalizeScoreFields(typeof row.scoreFields === 'string'
            ? JSON.parse(row.scoreFields) : row.scoreFields, fields);
        const key = JSON.stringify([Number(row.modelID), scoreFields]);
        if (isAACondition({ benchmarkID: Number(row.benchmarkID), benchmarkName: row.benchmarkName, conditionName: row.benchmarkConditionName,
            conditionKey: row.conditionKey, scoreSource: row.scoreSource }) || aaResultReason(row, undefined, fields)) {
            omittedConfigurations.set(key, { modelID: Number(row.modelID), scoreFields,
                displayRestriction: AA_DISPLAY_RESTRICTION });
            continue;
        }
        if (!configurations.has(key)) configurations.set(key, {
            modelID: Number(row.modelID), modelName: row.modelName, scoreFields,
            configurationName: scoreFields.map(item => {
                const field = fields.find(field => field.ID === item.fieldID);
                return field.name + '=' + fieldDisplayValue(field, item.value);
            }).join(', '), scoreCount: 0
        });
        configurations.get(key).scoreCount += Number(row.scoreCount);
        if (includeVersions) {
            if (!groups.has(key)) groups.set(key, new Map());
            const byCondition = groups.get(key), conditionID = Number(row.benchmarkConditionID);
            if (!byCondition.has(conditionID)) byCondition.set(conditionID, {
                benchmarkID: Number(row.benchmarkID), benchmarkName: row.benchmarkName,
                benchmarkConditionID: conditionID, benchmarkConditionName: row.benchmarkConditionName,
                conditionKey: row.conditionKey, scoreSource: row.scoreSource,
                benchmarkConditionIsDefault: Boolean(row.benchmarkConditionIsDefault),
                usesPercentageScale: Boolean(row.usesPercentageScale), scoreDirection: row.scoreDirection,
                scoreMin: row.scoreMin == null ? null : Number(row.scoreMin), scoreMax: row.scoreMax == null ? null : Number(row.scoreMax),
                targetValue: row.targetValue == null ? null : Number(row.targetValue), sampleCount: 0, values: new Map()
            });
            const group = byCondition.get(conditionID);
            const rawScore = Number(row.rawScore), normalizedScore = normalizedResultScore({ ...group, rawScore });
            if (row.rawScore == null || !Number.isFinite(rawScore) || normalizedScore === null) {
                throw requestError(409, 'accepted_result_score_invalid', { modelID: Number(row.modelID), benchmarkConditionID: conditionID });
            }
            group.sampleCount += Number(row.scoreCount);
            group.values.set(rawScore, normalizedScore);
        }
    }
    const visible = [...configurations].map(([key, configuration]) => includeVersions ? { ...configuration,
        scoreGroups: [...groups.get(key).values()].map(({ values, ...group }) => ({ ...group,
            distinctScoreCount: values.size, medianRawScore: medianOfFiniteNumbers([...values.keys()]),
            medianNormalizedScore: medianOfFiniteNumbers([...values.values()]) }))
            .sort((left, right) => left.benchmarkName.localeCompare(right.benchmarkName, 'en')
                || Number(right.benchmarkConditionIsDefault) - Number(left.benchmarkConditionIsDefault)
                || left.benchmarkConditionName.localeCompare(right.benchmarkConditionName, 'en')
                || left.benchmarkConditionID - right.benchmarkConditionID)
    } : configuration);
    return includeDisplayRestrictions ? { configurations: visible,
        displayPolicy: AA_DISPLAY_RESTRICTION, omittedConfigurations: [...omittedConfigurations.values()] } : visible;
}

async function loadModelMetadata(connection) {
    const [rows] = await connection.execute(`
        SELECT models.ID AS model_ID, models.name AS model_name, models.introduction_url AS introductionURL,
               vendors.name AS vendor_name, vendors.slug AS vendor_slug, vendors.logo_key
        FROM models JOIN organizations vendors ON vendors.ID = models.vendor_ID
        WHERE models.is_active = 1 ORDER BY models.name, models.ID`);
    return rows;
}

export async function loadModels(connection, definitions = null, {
    conditionIDs = null, evidenceConditionIDs = null, conditionDefinitions = null
} = {}) {
    if (conditionIDs !== null && (!Array.isArray(conditionIDs)
        || conditionIDs.some(ID => !Number.isSafeInteger(ID) || ID < 1)
        || new Set(conditionIDs).size !== conditionIDs.length)) {
        throw requestError(400, 'invalid_score_scope');
    }
    if (evidenceConditionIDs !== null && (!Array.isArray(evidenceConditionIDs)
        || evidenceConditionIDs.some(ID => !Number.isSafeInteger(ID) || ID < 1)
        || new Set(evidenceConditionIDs).size !== evidenceConditionIDs.length)) throw requestError(400, 'invalid_score_scope');
    if (conditionDefinitions !== null && (!Array.isArray(conditionDefinitions)
        || conditionDefinitions.some(condition => !Number.isSafeInteger(condition?.benchmark_condition_ID)
            || condition.benchmark_condition_ID < 1)
        || new Set(conditionDefinitions.map(condition => condition.benchmark_condition_ID)).size !== conditionDefinitions.length)) {
        throw requestError(400, 'invalid_condition_definitions');
    }
    const fields = definitions ?? await loadScoreFieldCatalog(connection);
    const evidenceScope = evidenceConditionIDs === null ? null : new Set(evidenceConditionIDs.map(resultKey));
    const modelRows = await loadModelMetadata(connection);
    const scope = conditionIDs === null ? '' : conditionIDs.length
        ? ` AND benchmark_results.benchmark_condition_ID IN (${conditionIDs.map(() => '?').join(',')})` : ' AND 0 = 1';
    const conditionScope = conditionIDs === null ? '' : conditionIDs.length
        ? ` WHERE ID IN (${conditionIDs.map(() => '?').join(',')})` : ' WHERE 0 = 1';
    const conditionRows = conditionDefinitions ?? (await connection.execute(`
        SELECT ID AS benchmark_condition_ID, uses_percentage_scale, score_min, score_max, score_direction, target_value
        FROM benchmark_conditions${conditionScope}`, conditionIDs ?? []))[0];
    const [rows] = await connection.execute(`
        SELECT benchmark_results.ID AS result_ID, benchmark_results.model_ID,
               benchmark_results.score_fields, benchmark_results.benchmark_condition_ID, benchmark_results.raw_score,
               benchmark_results.benchmark_ID, benchmark_results.source_url, benchmark_results.source_title, benchmark_results.notes
        FROM benchmark_results
        JOIN models ON models.ID = benchmark_results.model_ID AND models.is_active = 1
        WHERE ${currentScoreSQL()}${scope}`, conditionIDs ?? []);
    // Configuration IDs stay global even when a pie uses only a small evidence subset.
    const identities = conditionIDs === null ? rows : (await connection.execute(`
        SELECT MIN(benchmark_results.ID) AS result_ID, benchmark_results.model_ID, benchmark_results.score_fields
        FROM benchmark_results
        JOIN models ON models.ID = benchmark_results.model_ID AND models.is_active = 1
        WHERE ${currentScoreSQL()}
        GROUP BY benchmark_results.model_ID, benchmark_results.score_fields`))[0];
    const modelsByID = new Map(modelRows.map((model, index) => [Number(model.model_ID), { ...model, order: index }]));
    const conditionsByID = new Map(conditionRows.map(condition => [Number(condition.benchmark_condition_ID), condition]));
    const fieldsByID = new Map(fields.map(field => [field.ID, field]));
    const assignmentCache = new Map();
    const configurations = new Map();
    const seenModels = new Set();
    // Keep evidence order and configuration identity without a database filesort on wide joined rows.
    identities.sort((left, right) => Number(left.result_ID) - Number(right.result_ID));
    for (const row of identities) seenModels.add(Number(row.model_ID));
    for (const model of modelRows) {
        if (!seenModels.has(Number(model.model_ID))) identities.push({ model_ID: model.model_ID, result_ID: null });
    }
    const signatureFor = row => {
        const rawFields = row.result_ID === null ? '[]'
            : typeof row.score_fields === 'string' ? row.score_fields : JSON.stringify(row.score_fields);
        let assignments = assignmentCache.get(rawFields);
        if (!assignments) {
            assignments = normalizeScoreFields(JSON.parse(rawFields), fields);
            assignmentCache.set(rawFields, assignments);
        }
        return { assignments, signature: JSON.stringify([Number(row.model_ID), assignments]) };
    };
    for (const row of identities) {
        const { assignments, signature } = signatureFor(row);
        const metadata = modelsByID.get(Number(row.model_ID));
        if (!metadata) throw requestError(409, 'accepted_result_model_unavailable', { resultID: Number(row.result_ID) });
        if (!configurations.has(signature)) {
            const parameters = Object.fromEntries(assignments.map(item => [fieldKey(item.fieldID), item.value]));
            const label = assignments.map(item => {
                const field = fieldsByID.get(item.fieldID);
                return `${field.name}=${fieldDisplayValue(field, item.value)}`;
            }).join(', ');
            configurations.set(signature, {
                ID: row.result_ID === null ? -Number(row.model_ID) : Number(row.result_ID),
                modelID: Number(row.model_ID), modelName: metadata.model_name,
                name: metadata.model_name + (label ? ' (' + label + ')' : ''),
                vendor: metadata.vendor_name, vendorSlug: metadata.vendor_slug, logoKey: metadata.logo_key, introductionURL: metadata.introductionURL,
                condition: { name: label, parameters, scoreFields: assignments },
                resultSamples: new Map(), resultEvidence: new Map(), results: new Map()
            });
        }
    }
    rows.sort((left, right) => Number(left.result_ID) - Number(right.result_ID));
    for (const row of rows) {
        if (row.result_ID === null) continue;
        if (aaResultReason({ ...row, ID: row.result_ID }, undefined, fields)) continue;
        const { signature } = signatureFor(row);
        if (!configurations.has(signature)) {
            throw requestError(409, 'accepted_result_configuration_unavailable', { resultID: Number(row.result_ID) });
        }
        const condition = conditionsByID.get(Number(row.benchmark_condition_ID));
        if (!condition) throw requestError(409, 'accepted_result_condition_unavailable', { resultID: Number(row.result_ID) });
        const samples = configurations.get(signature).resultSamples;
        const key = resultKey(row.benchmark_condition_ID);
        if (!samples.has(key)) samples.set(key, new Map());
        const rawScore = Number(row.raw_score);
        if (row.raw_score === null || row.raw_score === undefined || row.raw_score === '' || !Number.isFinite(rawScore)) {
            throw requestError(409, 'accepted_result_score_invalid', { resultID: Number(row.result_ID) });
        }
        if (evidenceScope === null || evidenceScope.has(key)) {
            const evidence = configurations.get(signature).resultEvidence;
            if (!evidence.has(key)) evidence.set(key, []);
            evidence.get(key).push({ ID: Number(row.result_ID), rawScore });
        }
        if (samples.get(key).has(rawScore)) continue;
        const normalizedScore = normalizedResultScore({
            rawScore: row.raw_score, usesPercentageScale: Boolean(condition.uses_percentage_scale),
            scoreMin: condition.score_min, scoreMax: condition.score_max, scoreDirection: condition.score_direction, targetValue: condition.target_value
        });
        if (normalizedScore === null) throw requestError(409, 'accepted_result_score_invalid', { resultID: Number(row.result_ID) });
        samples.get(key).set(rawScore, normalizedScore);
    }
    return [...configurations.values()].map(model => {
        for (const [key, samples] of model.resultSamples) model.results.set(key, {
            normalizedScore: medianOfFiniteNumbers([...samples.values()]), sampleCount: samples.size,
            ...(model.resultEvidence.has(key) ? { evidenceHash: scoreEvidenceHash({
                usesPercentageScale: Boolean(conditionsByID.get(Number(key)).uses_percentage_scale),
                scoreDirection: conditionsByID.get(Number(key)).score_direction,
                scoreMin: conditionsByID.get(Number(key)).score_min, scoreMax: conditionsByID.get(Number(key)).score_max,
                targetValue: conditionsByID.get(Number(key)).target_value
            }, model.resultEvidence.get(key)) } : {})
        });
        delete model.resultSamples;
        delete model.resultEvidence;
        return model;
    }).sort((left, right) => modelsByID.get(left.modelID).order - modelsByID.get(right.modelID).order || left.ID - right.ID);
}

function rankingReadError(cancelled = false) {
    const error = cancelled ? 'ranking_read_cancelled' : 'ranking_read_timeout';
    return Object.assign(new Error(error), { code: cancelled ? 'RANKING_READ_CANCELLED' : 'RANKING_READ_TIMEOUT',
        status: 503, body: { error, retryable: true } });
}

async function readRankingSnapshot(db, build, signal, rankingCache) {
    if (signal?.aborted) throw rankingReadError(true);
    const label = 'RANKING WORKSPACE';
    const deadline = performance.now() + RANKING_READ_TIMEOUT_MS;
    let connection, failure, rejectCancellation;
    const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
    const stop = error => {
        if (failure) return;
        failure = error;
        if (connection) destroyTransactionConnection(connection, label);
        rejectCancellation(error);
    };
    const assertActive = () => {
        if (!failure && performance.now() >= deadline) stop(rankingReadError());
        if (failure) throw failure;
    };
    const abort = () => stop(rankingReadError(true));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(rankingReadError()), RANKING_READ_TIMEOUT_MS);
    const work = Promise.resolve().then(async () => {
        assertActive();
        const lease = await db.getConnection();
        if (failure) {
            // An acquisition cannot be removed from mysql2's queue; return it unused.
            releaseTransactionConnection(lease, label);
            throw failure;
        }
        const methods = {};
        for (const method of ['query', 'execute', 'beginTransaction', 'commit', 'rollback']) {
            methods[method] = async (...args) => {
                assertActive();
                const result = await lease[method](...args);
                assertActive();
                return result;
            };
        }
        connection = new Proxy(lease, { get(target, property) {
            if (Object.hasOwn(methods, property)) return methods[property];
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' && !['constructor', 'Promise'].includes(property) ? value.bind(target) : value;
        } });
        try {
            // Weights and rules must come from the same revision during concurrent saves.
            await startTransactionConnection(connection, label, { readOnlySnapshot: true });
            const workspace = await withRankingReadCache(connection, rankingCache, () => build(connection), assertActive);
            assertActive();
            await commitTransactionConnection(connection, label);
            return workspace;
        } catch (error) {
            await rollbackTransactionConnection(connection, label, error);
            throw error;
        } finally {
            const completedLease = connection;
            connection = null;
            releaseTransactionConnection(completedLease, label);
        }
    });
    try { return await Promise.race([work, cancelled]); }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

export async function getRankingWorkspace(db, options = {}) {
    const scoreMode = options.scoreMode ?? 'range';
    if (!['range', 'available'].includes(scoreMode)) {
        throw { status: 400, body: { error: 'invalid_score_mode' } };
    }
    const availableInferenceVersion = currentInferenceVersion(options.availableInferenceVersion);
    const estimationAlgorithm = currentEstimationAlgorithm(options.estimationAlgorithm);
    const previewPersonalPie = options.previewPersonalPie === undefined || options.previewPersonalPie === null
        ? null
        : normalizePreviewPersonalPie(options.previewPersonalPie);
    return readRankingSnapshot(db, connection => buildRankingWorkspace(connection,
        { ...options, scoreMode, availableInferenceVersion, estimationAlgorithm, previewPersonalPie }), options.signal, options.rankingCache);
}

// Proposal trials have no persisted context or electorate. References resolve only public weights.
export async function getProposalRankingWorkspace(db, snapshot, options = {}) {
    const scoreMode = options.scoreMode ?? 'available';
    if (!['range', 'available'].includes(scoreMode)) throw requestError(400, 'invalid_score_mode');
    const previewPersonalPie = normalizePreviewPersonalPie({ entries: snapshot.entries, fallbackRules: snapshot.fallbackRules });
    return readRankingSnapshot(db, connection => buildRankingWorkspace(connection, {
        proposalName: snapshot.name, userID: null, previewPersonalPie, scoreMode,
        availableInferenceVersion: currentInferenceVersion(options.availableInferenceVersion),
        comparison: options.comparison, jsonMemberMetadata: true
    }), options.signal, options.rankingCache);
}

async function buildRankingWorkspace(db, {
    categoryID,
    contextValues = {},
    userID = null,
    comparison = null,
    scoreMode = 'range',
    availableInferenceVersion = AVAILABLE_INFERENCE_VERSION,
    estimationAlgorithm = DEFAULT_ESTIMATION_ALGORITHM,
    previewPersonalPie = null,
    jsonMemberMetadata = false,
    proposalName = null
} = {}) {
    const context = proposalName === null ? await resolveRankingContext(db, { categoryID, contextValues, userID, create: false })
        : { ID: null, categoryID: 0, categoryName: proposalName, contextValues: {}, isPrivate: false };
    const previewConditionIDs = previewPersonalPie ? [
        ...previewPersonalPie.entries.map(entry => entry.conditionID),
        ...previewPersonalPie.fallbackRules.flatMap(rule => rule.entries.map(entry => entry.conditionID))
    ].filter(ID => ID > 0) : [];
    let availableConditions = await cachedRankingRead(db, 'catalogue', 'conditions:[]', () => loadBenchmarkConditions(db));
    const availableIDs = new Set(availableConditions.map(condition => condition.conditionID));
    if (previewConditionIDs.some(ID => !availableIDs.has(ID))) {
        availableConditions = await cachedRankingRead(db, 'catalogue', `conditions:${JSON.stringify(previewConditionIDs.slice().sort((a, b) => a - b))}`,
            () => loadBenchmarkConditions(db, { includeConditionIDs: previewConditionIDs }));
    }
    const conditions = cloneRankingMetadata(availableConditions);
    const conditionsByID = new Map(conditionCoverage(conditions).map(condition => [condition.conditionID, condition]));
    const referenceTargets = await loadTopicReferenceTargets(db, userID);
    const referencesByID = new Map(referenceTargets.map(target => [target.contextID, target]));
    for (const target of referenceTargets) conditionsByID.set(-target.contextID, referenceCondition(target));
    const publicPie = proposalName === null ? await loadPublicPie(db, context, conditionsByID)
        : { entries: [], scoringEntries: [], familyComposition: [], communityComposition: [], participantCount: 0 };
    const storedPersonalPie = proposalName === null ? await loadPersonalPie(db, context.ID, userID) : null;
    const rawPersonalEntries = previewPersonalPie?.entries ?? storedPersonalPie?.entries ?? [];
    const rawPersonalFallbackRules = previewPersonalPie?.fallbackRules ?? storedPersonalPie?.fallbackRules ?? [];
    if (previewPersonalPie) {
        await validateTopicReferences(db, context, rawPersonalEntries, userID);
        const conditionIDs = new Set([
            ...rawPersonalEntries.map(entry => entry.conditionID),
            ...rawPersonalFallbackRules.flatMap(rule => rule.entries.map(entry => entry.conditionID))
        ]);
        for (const conditionID of conditionIDs) {
            if (!conditionsByID.has(conditionID)) {
                throw requestError(400, 'pie_benchmark_condition_not_found', { conditionID });
            }
            if (conditionsByID.get(conditionID).excludedFromRanking) throw requestError(409, 'pie_benchmark_condition_excluded', { conditionID });
        }
    }
    const eligiblePersonalEntries = rawPersonalEntries.filter(entry => !conditionsByID.get(entry.conditionID)?.excludedFromRanking);
    const personalSourceEntries = eligiblePersonalEntries.length === rawPersonalEntries.length ? rawPersonalEntries
        : normalizeWeights(eligiblePersonalEntries.map(entry => ({ conditionID: entry.conditionID, rawWeight: entry.weightBasisPoints })));
    const activePersonalIDs = new Set(personalSourceEntries.map(entry => entry.conditionID));
    const personalSourceFallbackRules = rawPersonalFallbackRules.filter(rule => activePersonalIDs.has(rule.primaryConditionID));
    const storedFamilies = await loadBenchmarkFamilies(db, { referencedOnly: true });
    const personalEntries = decoratePieEntries(personalSourceEntries, conditionsByID);
    const personalFallbackRules = decorateFallbackRules(personalSourceFallbackRules, conditionsByID);
    const publicEntries = decoratePieEntries(publicPie.entries, conditionsByID);
    const familyComposition = publicPie.familyComposition.map(group => ({ ...group,
        families: group.families.map(family => ({ ...family,
            entries: decorateFallbackRules([{ ...family, mode: FALLBACK_RULE_MODE }], conditionsByID)[0].entries
        })) }));
    const communityByPrimary = new Map((publicPie.communityComposition ?? []).map(group => [group.primaryConditionID, group]));
    const personalCommunityComposition = personalEntries.filter(entry => entry.conditionID > 0).map(entry => {
        const group = communityByPrimary.get(entry.conditionID) ?? {
            primaryConditionID: entry.conditionID, configuredPieCount: 0, isDefault: true,
            families: [{ primaryConditionID: entry.conditionID, familyID: null, entries: [], weightBasisPoints: 10000 }]
        };
        return { ...group, families: group.families.map(family => ({ ...family,
            overallWeightBasisPoints: entry.weightBasisPoints * family.weightBasisPoints / 10000,
            entries: decorateFallbackRules([{ ...family, mode: FALLBACK_RULE_MODE }], conditionsByID)[0].entries
        })) };
    });
    const availableFamilies = storedFamilies.filter(family => [family.primaryConditionID,
        ...family.entries.map(entry => entry.conditionID)].every(ID => conditionsByID.has(ID)));
    const familyCatalogue = decorateFallbackRules(availableFamilies, conditionsByID);
    for (const draft of personalFallbackRules) {
        if (!draft.entries.length) continue;
        if (!familyCatalogue.some(family => familyKey(family.primaryConditionID, family.entries) === familyKey(draft.primaryConditionID, draft.entries))) familyCatalogue.push(draft);
    }
    const expandedFor = async (mode, entries, fallbackRules, composition) => {
        if (!entries.some(entry => entry.conditionID < 0)) return null;
        const root = { contextID: context.ID ?? 0, name: context.categoryName, entries,
            fallbackRules, familyComposition: composition };
        return expandTopicReferences(root, { loadTarget: async targetID => {
            const target = referencesByID.get(targetID);
            if (!target || mode === 'public' && target.isPrivate
                || !context.isPrivate && target.isPrivate) return null;
            const targetContext = await resolveRankingContext(db, { categoryID: target.categoryID,
                contextValues: target.sceneID == null ? {} : { scene: String(target.sceneID) },
                userID: mode === 'personal' ? userID : null });
            const publicTarget = await loadPublicPie(db, targetContext, conditionsByID);
            const personalTarget = mode === 'personal' ? await loadPersonalPie(db, targetID, userID) : null;
            const personal = personalTarget?.entries.length ? personalTarget : null;
            const raw = personal?.entries ?? publicReferenceWeights(publicTarget);
            const eligible = raw.filter(entry => !conditionsByID.get(entry.conditionID)?.excludedFromRanking);
            const selected = eligible.length === raw.length ? raw : normalizeWeights(eligible.map(entry => ({
                conditionID: entry.conditionID, rawWeight: entry.weightBasisPoints
            })));
            return { contextID: targetID, name: target.name, entries: selected,
                fallbackRules: personal?.fallbackRules ?? [],
                familyComposition: publicTarget.communityComposition ?? publicTarget.familyComposition };
        } });
    };
    const personalExpanded = await expandedFor('personal', personalSourceEntries, personalFallbackRules, personalCommunityComposition);
    const publicExpanded = await expandedFor('public', publicReferenceWeights(publicPie), [], familyComposition);
    const personalEffectiveEntries = personalExpanded?.entries ?? personalSourceEntries;
    const publicEffectiveEntries = publicExpanded?.entries ?? publicPie.scoringEntries;
    const personalEffectiveComposition = personalExpanded?.familyComposition ?? personalCommunityComposition;
    const publicEffectiveComposition = publicExpanded?.familyComposition ?? familyComposition;
    const evaluationConditions = [...conditions, ...referenceTargets.filter(target => target.contextID !== context.ID
        && (context.isPrivate || !target.isPrivate)).map(referenceCondition)];
    const benchmarkList = buildBenchmarkList(evaluationConditions, publicEntries, personalEntries, familyCatalogue,
        familyComposition, personalFallbackRules);
    const fields = await loadScoreFieldCatalog(db);
    const scoringConditionIDs = [...new Set([
        ...personalEffectiveEntries.map(entry => entry.conditionID),
        ...publicEffectiveEntries.map(entry => entry.conditionID),
        ...personalFallbackRules.flatMap(rule => resolvedFamilyConditionIDs(rule.primaryConditionID, rule.entries)),
        ...personalEffectiveComposition.flatMap(group => group.families.flatMap(family =>
            resolvedFamilyConditionIDs(group.primaryConditionID, family.entries))),
        ...publicEffectiveComposition.flatMap(group => group.families.flatMap(family =>
            resolvedFamilyConditionIDs(group.primaryConditionID, family.entries)))
    ])].filter(ID => ID > 0 && !conditionsByID.get(ID)?.excludedFromRanking).sort((a, b) => a - b);
    const excludedConditionIDs = new Set([...conditionsByID].filter(([, condition]) => condition.excludedFromRanking).map(([ID]) => ID));
    const modelConditionIDs = scoreMode === 'available' && scoringConditionIDs.length
        ? [...conditionsByID.keys()].filter(ID => ID > 0 && !excludedConditionIDs.has(ID)).sort((a, b) => a - b) : scoringConditionIDs;
    const definitionsFor = IDs => IDs.map(ID => {
        const condition = conditionsByID.get(ID);
        return { benchmark_condition_ID: ID, uses_percentage_scale: condition.usesPercentageScale,
            score_min: condition.scoreMin, score_max: condition.scoreMax,
            score_direction: condition.scoreDirection, target_value: condition.targetValue };
    });
    const universeIDs = [...conditionsByID.keys()].filter(ID => ID > 0 && !excludedConditionIDs.has(ID)).sort((a, b) => a - b);
    const universeKey = JSON.stringify(universeIDs);
    const allModels = hasRankingReadCache(db) ? await cachedRankingRead(db, 'data', `models:${universeKey}`,
        () => loadModels(db, fields, { conditionIDs: universeIDs, conditionDefinitions: definitionsFor(universeIDs) }),
        models => models.reduce((sum, model) => sum + model.results.size, 0)) : null;
    const modelScope = new Set(modelConditionIDs.map(resultKey));
    const models = allModels && comparison?.mode !== 'matched' ? allModels : allModels
        ? allModels.map(model => ({ ...model, results: new Map([...model.results].filter(([key]) => modelScope.has(key))) }))
        : await loadModels(db, fields, { conditionIDs: modelConditionIDs,
        evidenceConditionIDs: scoringConditionIDs,
        conditionDefinitions: definitionsFor(modelConditionIDs) });
    const compareOptions = comparisonOptions(models, comparison, fields);
    const personalScoringEntries = context.ID === null && !previewPersonalPie
        ? []
        : personalEffectiveEntries.map(entry => ({
            conditionID: entry.conditionID,
            weightBasisPoints: entry.weightBasisPoints
        }));
    // Fair comparison controls belong to each pie's benchmark scope.
    const comparisonKey = JSON.stringify([universeKey, compareOptions.keys, compareOptions.filters]);
    const preparedGroups = compareOptions.mode === 'best' && (personalScoringEntries.length || publicEffectiveEntries.length)
        ? await cachedRankingRead(db, 'data', `groups:${comparisonKey}`, () => groupComparisonModels(models, compareOptions, []),
            groups => groups.reduce((sum, group) => sum + group.results.size, 0)) : null;
    const comparisonScoreIndexes = preparedGroups
        ? await cachedRankingRead(db, 'data', `score-indexes:${comparisonKey}`, () => new WeakMap(preparedGroups.map(group => [group,
            new Map(group.comparisonScores.map(score => [Number(score.conditionID), score]))]))) : null;
    const percentileReference = scoreMode === 'available' && preparedGroups
        ? await cachedRankingRead(db, 'data', `inference:${availableInferenceVersion}:${comparisonKey}`, () => {
            const referenceOptions = { ...compareOptions, filters: compareOptions.filters.filter(filter => filter.key !== 'model') };
            const peers = referenceOptions.filters.length === compareOptions.filters.length ? preparedGroups
                : groupComparisonModels(models, referenceOptions, [], { includeReferenceVersions: true });
            const reference = createPairwiseReference(peers), estimates = new WeakMap();
            if (reference.predict) return reference;
            return { distributions: reference.distributions, estimate(model) {
                if (!estimates.has(model)) estimates.set(model, reference.estimate(model));
                return estimates.get(model);
            } };
        }, reference => reference.cellCount ?? 0) : null;
    const calculate = async (scope, entries, total, rules) => {
        const build = () => scoreComparison(models, entries, total, rules, compareOptions, preparedGroups);
        if (!jsonMemberMetadata || !preparedGroups) return build();
        // Read current pies first. Reuse only the exact scoring input, scoped to its owner and context.
        const key = JSON.stringify([normalizeUserID(userID), context.categoryID, context.contextValues,
            scope, comparisonKey, scoreMode, availableInferenceVersion, estimationAlgorithm, entries, total,
            rules.fallbackRules ?? [], rules.familyComposition ?? []]);
        return cachedRankingCalculation(db, key, build);
    };
    const personalRanking = await calculate('personal', personalScoringEntries, PIE_TOTAL_BASIS_POINTS,
        { fallbackRules: personalExpanded ? [] : personalFallbackRules, familyComposition: personalEffectiveComposition,
            scoreMode, availableInferenceVersion, estimationAlgorithm, percentileReference, comparisonScoreIndexes, jsonMemberMetadata, excludedConditionIDs });
    const publicRanking = await calculate('public', publicEffectiveEntries,
        publicExpanded ? PIE_TOTAL_BASIS_POINTS : publicPie.participantCount * PIE_TOTAL_BASIS_POINTS,
        { familyComposition: publicEffectiveComposition, fallbackScope: 'public', scoreMode, availableInferenceVersion, estimationAlgorithm,
            percentileReference, comparisonScoreIndexes, jsonMemberMetadata, excludedConditionIDs });

    return {
        scoreMode,
        estimationAlgorithm,
        authenticated: Boolean(userID),
        userID: normalizeUserID(userID),
        context,
        personalPie: {
            revision: storedPersonalPie?.revision ?? 0,
            isDraft: Boolean(previewPersonalPie) || !storedPersonalPie,
            editable: true,
            entries: personalEntries,
            effectiveEntries: personalExpanded ? decoratePieEntries(personalExpanded.entries, conditionsByID) : personalEntries,
            referenceIssues: personalExpanded?.issues ?? [],
            fallbackRules: personalFallbackRules,
            communityFallbackComposition: personalCommunityComposition
        },
        publicPie: {
            participantCount: publicPie.participantCount,
            isFallback: false,
            entries: publicEntries,
            effectiveEntries: publicExpanded ? decoratePieEntries(publicExpanded.entries, conditionsByID) : publicEntries,
            referenceIssues: publicExpanded?.issues ?? [],
            familyComposition
        },
        benchmarks: benchmarkList,
        comparison: compareOptions,
        modelLeaderboards: {
            personal: personalRanking,
            public: publicRanking
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
        const conditionID = typeof entry.conditionID === 'number' && Number.isSafeInteger(entry.conditionID)
            && entry.conditionID !== 0 ? entry.conditionID : null;
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

function validateFallbackRules(fallbackRules, pieEntries) {
    if (!Array.isArray(fallbackRules) || fallbackRules.length > pieEntries.length) {
        throw requestError(400, 'invalid_personal_pie_fallback_rules');
    }
    const pieConditionIDs = new Set(pieEntries.map(entry => entry.conditionID));
    const primaryIDs = new Set();
    const normalized = fallbackRules.map(rule => {
        if (!hasExactKeys(rule, ['primaryConditionID', 'mode', 'entries'])
            && !hasExactKeys(rule, ['primaryConditionID', 'mode', 'entries', 'selectionSource'])) {
            throw requestError(400, 'invalid_personal_pie_fallback_rule');
        }
        const primaryConditionID = parseSafeInteger(rule.primaryConditionID, { minimum: 1 });
        if (primaryConditionID === null
            || !pieConditionIDs.has(primaryConditionID)
            || primaryIDs.has(primaryConditionID)
            || rule.mode !== FALLBACK_RULE_MODE
            || !Array.isArray(rule.entries)
            || Object.hasOwn(rule, 'selectionSource') && !FALLBACK_SELECTION_SOURCES.includes(rule.selectionSource)) {
            throw requestError(400, 'invalid_personal_pie_fallback_rule', {
                primaryConditionID: rule.primaryConditionID
            });
        }
        primaryIDs.add(primaryConditionID);
        const conditionIDs = new Set();
        const entries = rule.entries.map(entry => {
            if (!hasExactKeys(entry, ['conditionID'])) {
                throw requestError(400, 'invalid_personal_pie_fallback_component', { primaryConditionID });
            }
            const conditionID = parseSafeInteger(entry.conditionID, { minimum: 1 });
            if (conditionID === null
                || conditionID === primaryConditionID
                || conditionIDs.has(conditionID)) {
                throw requestError(400, 'invalid_personal_pie_fallback_component', {
                    primaryConditionID,
                    conditionID: entry.conditionID
                });
            }
            conditionIDs.add(conditionID);
            return { conditionID };
        });
        try { familyKey(primaryConditionID, entries); }
        catch { throw requestError(400, 'invalid_personal_pie_fallback_component', { primaryConditionID }); }
        return { primaryConditionID, mode: FALLBACK_RULE_MODE, entries,
            ...(rule.selectionSource ? { selectionSource: rule.selectionSource } : {}) };
    });
    return normalized;
}

export function normalizePreviewPersonalPie(value) {
    if (!hasExactKeys(value, ['entries', 'fallbackRules'])) {
        throw requestError(400, 'invalid_personal_pie_preview');
    }
    const entries = validatePieEntries(value.entries);
    return { entries, fallbackRules: validateFallbackRules(value.fallbackRules, entries) };
}

export async function savePersonalPie(db, options) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await savePersonalPieAttempt(db, options);
        } catch (error) {
            // InnoDB rolls back a deadlock victim; reuse the same identity for a bounded retry.
            if (error.code !== 'ER_LOCK_DEADLOCK' || attempt >= 2) throw error;
        }
    }
}

async function savePersonalPieAttempt(db, {
    userID,
    writeIdentity,
    categoryID,
    contextValues = {},
    expectedRevision,
    entries,
    fallbackRules,
    comparison = null,
    scoreMode = 'range'
}) {
    if (!['range', 'available'].includes(scoreMode)) {
        throw requestError(400, 'invalid_score_mode');
    }
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
    let savedRevision = 0;
    let previousFamilyIDs = [];
    try {
        if (comparison !== null) {
            const metadata = await loadModelMetadata(connection);
            comparisonOptions(metadata.map(model => ({ modelID: Number(model.model_ID), modelName: model.model_name,
                vendor: model.vendor_name, condition: { parameters: {} } })), comparison, await loadScoreFieldCatalog(connection));
        }
        await startTransactionConnection(connection, 'SAVE PERSONAL PIE');
        await lockTopicReferences(connection);
        const [users] = await connection.execute(`
            SELECT ID
            FROM users
            WHERE ID = ? AND deleted_at IS NULL
              AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW()))
            FOR UPDATE`, [normalizedUserID]);
        if (users.length === 0) {
            throw requestError(403, 'account_unavailable');
        }

        const intent = await claimWriteIntent(connection, { userID: normalizedUserID,
            key: writeIdentity, action: 'save_personal_pie', payload: {
                categoryID: normalizedCategoryID, contextValues, expectedRevision: revision,
                entries: normalizedEntries, fallbackRules: normalizedFallbackRules
            } });
        if (intent.response) {
            await commitTransactionConnection(connection, 'SAVE PERSONAL PIE');
            return intent.response.body;
        }

        const category = await resolveCategory(connection, normalizedCategoryID, normalizedUserID);
        resolvedCategoryID = category.ID;
        const scene = await resolveTopicScene(connection, category, contextValues, { requireAllDimensions: true, create: true });
        const resolvedContext = scene ?? canonicalizeContextValues(contextValues, [], { requireAllDimensions: true });
        resolvedContextValues = resolvedContext.contextValues;
        let context = scene ?? await findContext(connection, category.ID, resolvedContextValues);

        if (context.ID === null && normalizedEntries.length === 0) {
            if (revision !== 0) {
                throw requestError(409, 'pie_revision_conflict', { currentRevision: 0 });
            }
        } else {
            if (context.ID === null) {
                context = await ensureContext(connection, category.ID, resolvedContextValues);
            }
            await validateTopicReferences(connection, { ...context, isPrivate: category.isPrivate }, normalizedEntries, normalizedUserID);

            const [pies] = await connection.execute(`
                SELECT ID, revision
                FROM personal_pies
                WHERE user_ID = ? AND context_ID = ?
                FOR UPDATE`, [normalizedUserID, context.ID]);
            if (pies.length) {
                const [rules] = await connection.execute(`SELECT family_ID FROM personal_pie_score_rules
                    WHERE pie_ID = ? ORDER BY family_ID FOR UPDATE`, [Number(pies[0].ID)]);
                previousFamilyIDs = rules.filter(rule => rule.family_ID !== null).map(rule => Number(rule.family_ID));
            }
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
            } else {
                const primaryConditionIDs = normalizedEntries.filter(entry => entry.conditionID > 0).map(entry => entry.conditionID);
                const fallbackConditionIDs = normalizedFallbackRules.flatMap(rule => (
                    rule.entries.map(entry => entry.conditionID)
                ));
                const conditionIDs = [...new Set([...primaryConditionIDs, ...fallbackConditionIDs])];
                const [conditions] = conditionIDs.length ? await connection.execute(`
                    SELECT ID
                    FROM benchmark_conditions
                    WHERE ID IN (${conditionIDs.map(() => '?').join(', ')})
                      AND ${selectableBenchmarkConditionSQL()}
                    FOR SHARE`, conditionIDs) : [[]];
                if (conditions.length !== conditionIDs.length) {
                    throw requestError(404, 'pie_benchmark_condition_not_found');
                }
                const selectable = await loadBenchmarkConditions(connection);
                const excludedID = conditionIDs.find(id => selectable.some(condition => condition.conditionID === id && condition.excludedFromRanking));
                if (excludedID !== undefined) throw requestError(409, 'pie_benchmark_condition_excluded', { conditionID: excludedID });
                const selectableIDs = new Set(selectable.map(condition => condition.conditionID));
                const notComparableID = conditionIDs.find(id => !selectableIDs.has(id));
                if (notComparableID !== undefined) {
                    throw requestError(409, 'pie_benchmark_condition_not_comparable', {
                        conditionID: notComparableID,
                        minimumModelCount: MIN_COMPARABLE_MODELS
                    });
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
                    savedRevision = 1;
                } else {
                    const currentRevision = Number(pies[0].revision);
                    if (revision !== currentRevision) {
                        throw requestError(409, 'pie_revision_conflict', { currentRevision });
                    }
                    pieID = Number(pies[0].ID);
                    savedRevision = currentRevision + 1;
                    await connection.execute(`
                        UPDATE personal_pies
                        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
                        WHERE ID = ?`, [pieID]);
                    await connection.execute('DELETE FROM personal_pie_weights WHERE pie_ID = ?', [pieID]);
                    await connection.execute('DELETE FROM personal_pie_topic_weights WHERE pie_ID = ?', [pieID]);
                }

                const benchmarkEntries = normalizedEntries.filter(entry => entry.conditionID > 0);
                const referenceEntries = normalizedEntries.filter(entry => entry.conditionID < 0);
                const valueSQL = benchmarkEntries.map(() => '(?, ?, ?)').join(', ');
                const valueParams = benchmarkEntries.flatMap(entry => [pieID, entry.conditionID, entry.weightBasisPoints]);
                if (benchmarkEntries.length) await connection.execute(`
                    INSERT INTO personal_pie_weights (pie_ID, benchmark_condition_ID, weight_basis_points)
                    VALUES ${valueSQL}`, valueParams);
                if (referenceEntries.length) await connection.execute(`INSERT INTO personal_pie_topic_weights
                    (pie_ID, target_context_ID, weight_basis_points)
                    VALUES ${referenceEntries.map(() => '(?, ?, ?)').join(', ')}`,
                referenceEntries.flatMap(entry => [pieID, -entry.conditionID, entry.weightBasisPoints]));

                if (normalizedFallbackRules.length > 0) {
                    const ruleValueSQL = normalizedFallbackRules.map(() => '(?, ?, ?, ?)').join(', ');
                    const ruleValueParams = [];
                    for (const rule of normalizedFallbackRules) {
                        const familyID = rule.entries.length
                            ? await ensureBenchmarkFamily(connection, rule.primaryConditionID, rule.entries) : null;
                        ruleValueParams.push(pieID, rule.primaryConditionID, familyID, rule.selectionSource ?? 'selected');
                    }
                    await connection.execute(`
                        INSERT INTO personal_pie_score_rules
                            (pie_ID, primary_benchmark_condition_ID, family_ID, selection_source)
                        VALUES ${ruleValueSQL}`, ruleValueParams);
                }
            }
        }
        await pruneUnusedBenchmarkFamilies(connection, previousFamilyIDs);
        const receipt = { saved: true, requestKey: intent.key, userID: normalizedUserID,
            categoryID: resolvedCategoryID, contextValues: resolvedContextValues,
            personalPie: { revision: savedRevision, entries: normalizedEntries, fallbackRules: normalizedFallbackRules } };
        // The receipt and weights commit together; ranking reads must not change this outcome.
        await completeWriteIntent(connection, intent, { status: 200, body: receipt });
        await commitTransactionConnection(connection, 'SAVE PERSONAL PIE');
        return receipt;
    } catch (error) {
        await rollbackTransactionConnection(connection, 'SAVE PERSONAL PIE', error);
        throw error;
    } finally {
        releaseTransactionConnection(connection, 'SAVE PERSONAL PIE');
    }

}
