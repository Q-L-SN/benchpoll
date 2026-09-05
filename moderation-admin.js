import mysql from 'mysql2';

const AUDIT_ACTIONS = new Set(['approve', 'edit_and_approve', 'reject', 'escalate', 'admin_message']);
const SENIOR_AUDIT_ACTIONS = new Set(['admin_message']);

const EXPLORER_ENTITIES = {
    benchmarks: {
        label: 'Benchmarks',
        actionKeys: [],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Benchmark' },
            { key: 'conditionCount', label: 'Conditions' },
            { key: 'resultCount', label: 'Results' },
            { key: 'isActive', label: 'Active', type: 'boolean' },
            { key: 'updatedAt', label: 'Updated', type: 'date' }
        ],
        select: `
            benchmarks.ID AS id, benchmarks.name,
            benchmarks.introduction_url AS introductionURL,
            benchmarks.is_active AS isActive,
            (SELECT COUNT(*) FROM benchmark_conditions
             WHERE benchmark_conditions.benchmark_ID = benchmarks.ID) AS conditionCount,
            (SELECT COUNT(*) FROM benchmark_results
             WHERE benchmark_results.benchmark_ID = benchmarks.ID
               AND benchmark_results.status = 'accepted') AS resultCount,
            (SELECT GROUP_CONCAT(benchmark_tags.name ORDER BY benchmark_tags.name SEPARATOR ', ')
             FROM benchmark_tag_links
             JOIN benchmark_tags ON benchmark_tags.ID = benchmark_tag_links.tag_ID
             WHERE benchmark_tag_links.benchmark_ID = benchmarks.ID) AS tags,
            benchmarks.created_at AS createdAt, benchmarks.updated_at AS updatedAt`,
        from: 'FROM benchmarks',
        search: "CONCAT_WS(' ', benchmarks.ID, benchmarks.name, COALESCE(benchmarks.introduction_url, ''))",
        orderBy: 'benchmarks.updated_at DESC, benchmarks.ID DESC'
    },
    benchmark_conditions: {
        label: 'Benchmark conditions',
        actionKeys: ['benchmarkID'],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'benchmarkName', label: 'Benchmark' },
            { key: 'name', label: 'Condition' },
            { key: 'scoreDirection', label: 'Direction' },
            { key: 'usesPercentageScale', label: 'Percentage', type: 'boolean' },
            { key: 'isDefault', label: 'Default', type: 'boolean' },
            { key: 'isActive', label: 'Active', type: 'boolean' }
        ],
        select: `
            benchmark_conditions.ID AS id,
            benchmark_conditions.benchmark_ID AS benchmarkID,
            benchmarks.name AS benchmarkName,
            benchmark_conditions.condition_key AS conditionKey,
            benchmark_conditions.name,
            benchmark_conditions.score_direction AS scoreDirection,
            benchmark_conditions.target_value AS targetValue,
            benchmark_conditions.uses_percentage_scale AS usesPercentageScale,
            benchmark_conditions.score_min AS scoreMin,
            benchmark_conditions.score_max AS scoreMax,
            benchmark_conditions.is_default AS isDefault,
            benchmark_conditions.is_active AS isActive,
            (SELECT COUNT(*) FROM benchmark_results
             WHERE benchmark_results.benchmark_condition_ID = benchmark_conditions.ID
               AND benchmark_results.status = 'accepted') AS resultCount,
            (SELECT COUNT(*) FROM personal_pie_weights
             WHERE personal_pie_weights.benchmark_condition_ID = benchmark_conditions.ID) AS weightCount,
            benchmark_conditions.created_at AS createdAt,
            benchmark_conditions.updated_at AS updatedAt`,
        from: `FROM benchmark_conditions
               JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID`,
        search: "CONCAT_WS(' ', benchmark_conditions.ID, benchmarks.name, benchmark_conditions.name, benchmark_conditions.condition_key)",
        orderBy: 'benchmarks.name, benchmark_conditions.is_default DESC, benchmark_conditions.name, benchmark_conditions.ID'
    },
    models: {
        label: 'Models',
        actionKeys: [],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'vendorName', label: 'Vendor' },
            { key: 'name', label: 'Model' },
            { key: 'conditionCount', label: 'Conditions' },
            { key: 'resultCount', label: 'Results' },
            { key: 'isActive', label: 'Active', type: 'boolean' }
        ],
        select: `
            models.ID AS id, models.vendor_ID AS vendorID,
            vendors.name AS vendorName, vendors.slug AS vendorSlug,
            models.slug, models.name, models.introduction_url AS introductionURL,
            models.is_active AS isActive,
            (SELECT COUNT(*) FROM model_conditions
             WHERE model_conditions.model_ID = models.ID) AS conditionCount,
            (SELECT COUNT(*) FROM benchmark_results
             WHERE benchmark_results.model_ID = models.ID
               AND benchmark_results.status = 'accepted') AS resultCount,
            models.created_at AS createdAt, models.updated_at AS updatedAt`,
        from: 'FROM models JOIN vendors ON vendors.ID = models.vendor_ID',
        search: "CONCAT_WS(' ', models.ID, vendors.name, models.name, models.slug, COALESCE(models.introduction_url, ''))",
        orderBy: 'models.updated_at DESC, models.ID DESC'
    },
    model_conditions: {
        label: 'Model conditions',
        actionKeys: ['modelID'],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'vendorName', label: 'Vendor' },
            { key: 'modelName', label: 'Model' },
            { key: 'name', label: 'Condition' },
            { key: 'isDefault', label: 'Default', type: 'boolean' },
            { key: 'isActive', label: 'Active', type: 'boolean' }
        ],
        select: `
            model_conditions.ID AS id, model_conditions.model_ID AS modelID,
            vendors.name AS vendorName, models.name AS modelName,
            model_conditions.condition_key AS conditionKey, model_conditions.name,
            model_conditions.is_default AS isDefault, model_conditions.is_active AS isActive,
            (SELECT COUNT(*) FROM benchmark_results
             WHERE benchmark_results.model_condition_ID = model_conditions.ID
               AND benchmark_results.status = 'accepted') AS resultCount,
            model_conditions.created_at AS createdAt, model_conditions.updated_at AS updatedAt`,
        from: `FROM model_conditions
               JOIN models ON models.ID = model_conditions.model_ID
               JOIN vendors ON vendors.ID = models.vendor_ID`,
        search: "CONCAT_WS(' ', model_conditions.ID, vendors.name, models.name, model_conditions.name, model_conditions.condition_key)",
        orderBy: 'model_conditions.updated_at DESC, model_conditions.ID DESC'
    },
    benchmark_results: {
        label: 'Benchmark results',
        actionKeys: ['modelID', 'benchmarkID'],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'modelName', label: 'Model' },
            { key: 'benchmarkName', label: 'Benchmark' },
            { key: 'rawScore', label: 'Score' },
            { key: 'status', label: 'Status' },
            { key: 'updatedAt', label: 'Updated', type: 'date' }
        ],
        select: `
            benchmark_results.ID AS id, benchmark_results.model_ID AS modelID,
            benchmark_results.model_condition_ID AS modelConditionID,
            benchmark_results.benchmark_ID AS benchmarkID,
            benchmark_results.benchmark_condition_ID AS benchmarkConditionID,
            vendors.name AS vendorName, models.name AS modelName,
            model_conditions.name AS modelCondition,
            benchmarks.name AS benchmarkName,
            benchmark_conditions.name AS benchmarkCondition,
            benchmark_results.raw_score AS rawScore,
            benchmark_results.source_url AS sourceURL,
            benchmark_results.source_type AS sourceType,
            benchmark_results.source_title AS sourceTitle,
            benchmark_results.benchmark_condition_snapshot AS benchmarkConditionSnapshot,
            benchmark_results.model_condition_snapshot AS modelConditionSnapshot,
            benchmark_results.submitted_by AS submittedBy,
            benchmark_results.moderation_log_ID AS moderationLogID,
            benchmark_results.status, benchmark_results.accepted_at AS acceptedAt,
            benchmark_results.created_at AS createdAt,
            benchmark_results.updated_at AS updatedAt`,
        from: `FROM benchmark_results
               JOIN models ON models.ID = benchmark_results.model_ID
               JOIN vendors ON vendors.ID = models.vendor_ID
               JOIN model_conditions ON model_conditions.ID = benchmark_results.model_condition_ID
               JOIN benchmarks ON benchmarks.ID = benchmark_results.benchmark_ID
               JOIN benchmark_conditions ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID`,
        search: "CONCAT_WS(' ', benchmark_results.ID, vendors.name, models.name, model_conditions.name, benchmarks.name, benchmark_conditions.name, COALESCE(benchmark_results.source_title, ''), benchmark_results.source_url)",
        orderBy: 'benchmark_results.updated_at DESC, benchmark_results.ID DESC'
    },
    benchmark_tags: {
        label: 'Benchmark tags',
        actionKeys: [],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Tag' },
            { key: 'benchmarkCount', label: 'Benchmarks' },
            { key: 'isActive', label: 'Active', type: 'boolean' }
        ],
        select: `
            benchmark_tags.ID AS id, benchmark_tags.tag_key AS tagKey,
            benchmark_tags.name, benchmark_tags.is_active AS isActive,
            (SELECT COUNT(*) FROM benchmark_tag_links
             WHERE benchmark_tag_links.tag_ID = benchmark_tags.ID) AS benchmarkCount,
            benchmark_tags.created_at AS createdAt, benchmark_tags.updated_at AS updatedAt`,
        from: 'FROM benchmark_tags',
        search: "CONCAT_WS(' ', benchmark_tags.ID, benchmark_tags.name, benchmark_tags.tag_key)",
        orderBy: 'benchmark_tags.name, benchmark_tags.ID'
    },
    vendors: {
        label: 'Vendors',
        actionKeys: [],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Vendor' },
            { key: 'modelCount', label: 'Models' },
            { key: 'updatedAt', label: 'Updated', type: 'date' }
        ],
        select: `
            vendors.ID AS id, vendors.slug, vendors.name, vendors.logo_key AS logoKey,
            (SELECT COUNT(*) FROM models WHERE models.vendor_ID = vendors.ID) AS modelCount,
            vendors.created_at AS createdAt, vendors.updated_at AS updatedAt`,
        from: 'FROM vendors',
        search: "CONCAT_WS(' ', vendors.ID, vendors.name, vendors.slug)",
        orderBy: 'vendors.name, vendors.ID'
    },
    categories: {
        label: 'Categories',
        actionKeys: ['parentID'],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Category' },
            { key: 'parentName', label: 'Parent' },
            { key: 'childCount', label: 'Children' },
            { key: 'isActive', label: 'Active', type: 'boolean' }
        ],
        select: `
            categories.ID AS id, categories.parent_ID AS parentID,
            categories.name, parent.name AS parentName, categories.is_active AS isActive,
            (SELECT COUNT(*) FROM categories AS child WHERE child.parent_ID = categories.ID) AS childCount,
            (SELECT COUNT(*) FROM ranking_dimensions
             WHERE ranking_dimensions.scope_category_ID = categories.ID) AS contextCount,
            categories.created_at AS createdAt, categories.updated_at AS updatedAt`,
        from: 'FROM categories LEFT JOIN categories AS parent ON parent.ID = categories.parent_ID',
        search: "CONCAT_WS(' ', categories.ID, categories.name, COALESCE(parent.name, ''))",
        orderBy: 'categories.parent_ID, categories.name, categories.ID'
    },
    ranking_dimensions: {
        label: 'Context dimensions',
        actionKeys: ['scopeCategoryID'],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'categoryName', label: 'Category' },
            { key: 'name', label: 'Context' },
            { key: 'optionCount', label: 'Options' },
            { key: 'isActive', label: 'Active', type: 'boolean' }
        ],
        select: `
            ranking_dimensions.ID AS id,
            ranking_dimensions.scope_category_ID AS scopeCategoryID,
            categories.name AS categoryName,
            ranking_dimensions.dimension_key AS dimensionKey,
            ranking_dimensions.name, ranking_dimensions.position,
            ranking_dimensions.is_active AS isActive,
            (SELECT COUNT(*) FROM ranking_dimension_options
             WHERE ranking_dimension_options.dimension_ID = ranking_dimensions.ID) AS optionCount,
            ranking_dimensions.created_at AS createdAt,
            ranking_dimensions.updated_at AS updatedAt`,
        from: 'FROM ranking_dimensions JOIN categories ON categories.ID = ranking_dimensions.scope_category_ID',
        search: "CONCAT_WS(' ', ranking_dimensions.ID, categories.name, ranking_dimensions.name, ranking_dimensions.dimension_key)",
        orderBy: 'categories.name, ranking_dimensions.position, ranking_dimensions.ID'
    },
    ranking_contexts: {
        label: 'Ranking contexts',
        actionKeys: ['categoryID'],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'categoryName', label: 'Category' },
            { key: 'contextHash', label: 'Context hash' },
            { key: 'personalPieCount', label: 'Personal pies' }
        ],
        select: `
            ranking_contexts.ID AS id, ranking_contexts.category_ID AS categoryID,
            categories.name AS categoryName, ranking_contexts.context_hash AS contextHash,
            ranking_contexts.context_values AS contextValues,
            (SELECT COUNT(*) FROM personal_pies
             WHERE personal_pies.context_ID = ranking_contexts.ID) AS personalPieCount,
            ranking_contexts.created_at AS createdAt, ranking_contexts.updated_at AS updatedAt`,
        from: 'FROM ranking_contexts JOIN categories ON categories.ID = ranking_contexts.category_ID',
        search: "CONCAT_WS(' ', ranking_contexts.ID, categories.name, ranking_contexts.context_hash)",
        orderBy: 'ranking_contexts.updated_at DESC, ranking_contexts.ID DESC'
    },
    personal_pies: {
        label: 'Personal pies',
        actionKeys: ['userID', 'contextID'],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'userName', label: 'User' },
            { key: 'categoryName', label: 'Category' },
            { key: 'weightCount', label: 'Weights' },
            { key: 'updatedAt', label: 'Updated', type: 'date' }
        ],
        select: `
            personal_pies.ID AS id, personal_pies.user_ID AS userID,
            personal_pies.context_ID AS contextID, users.name AS userName,
            categories.name AS categoryName,
            (SELECT COUNT(*) FROM personal_pie_weights
             WHERE personal_pie_weights.pie_ID = personal_pies.ID) AS weightCount,
            personal_pies.created_at AS createdAt, personal_pies.updated_at AS updatedAt`,
        from: `FROM personal_pies
               JOIN users ON users.ID = personal_pies.user_ID
               JOIN ranking_contexts ON ranking_contexts.ID = personal_pies.context_ID
               JOIN categories ON categories.ID = ranking_contexts.category_ID`,
        search: "CONCAT_WS(' ', personal_pies.ID, users.ID, users.name, categories.name)",
        orderBy: 'personal_pies.updated_at DESC, personal_pies.ID DESC'
    },
    personal_pie_weights: {
        label: 'Personal pie weights',
        actionKeys: ['pieID', 'benchmarkConditionID'],
        columns: [
            { key: 'id', label: 'ID' },
            { key: 'userName', label: 'User' },
            { key: 'benchmarkName', label: 'Benchmark' },
            { key: 'conditionName', label: 'Condition' },
            { key: 'weightBasisPoints', label: 'Basis points' }
        ],
        select: `
            CONCAT(personal_pie_weights.pie_ID, ':', personal_pie_weights.benchmark_condition_ID) AS id,
            personal_pie_weights.pie_ID AS pieID,
            personal_pie_weights.benchmark_condition_ID AS benchmarkConditionID,
            personal_pies.user_ID AS userID, users.name AS userName,
            benchmarks.name AS benchmarkName, benchmark_conditions.name AS conditionName,
            personal_pie_weights.weight_basis_points AS weightBasisPoints,
            personal_pie_weights.created_at AS createdAt,
            personal_pie_weights.updated_at AS updatedAt`,
        from: `FROM personal_pie_weights
               JOIN personal_pies ON personal_pies.ID = personal_pie_weights.pie_ID
               JOIN users ON users.ID = personal_pies.user_ID
               JOIN benchmark_conditions ON benchmark_conditions.ID = personal_pie_weights.benchmark_condition_ID
               JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID`,
        search: "CONCAT_WS(' ', personal_pie_weights.pie_ID, users.ID, users.name, benchmarks.name, benchmark_conditions.name)",
        orderBy: 'personal_pie_weights.updated_at DESC, personal_pie_weights.pie_ID DESC'
    }
};

function requestError(error, details = {}) {
    return { status: 400, body: { error, ...details } };
}

function normalizeSearch(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > 256) throw requestError('invalid_search');
    return value.trim();
}

function normalizePageValue(value, field, fallback, maximum) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw requestError(`invalid_${field}`);
    }
    return value;
}

function normalizePositiveID(value, error) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw requestError(error);
    }
    return value;
}

function parseStoredJSON(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        throw new Error('Stored moderation audit JSON is invalid.');
    }
}

function auditJSON(value) {
    return JSON.stringify(value, (_key, item) => {
        if (typeof item === 'bigint') return item.toString();
        if (Buffer.isBuffer(item)) return item.toString('base64');
        return item;
    });
}

function summarizeQueryResult(result) {
    const payload = Array.isArray(result) ? result[0] : result;
    if (Array.isArray(payload)) return { rowCount: payload.length };
    if (!payload || typeof payload !== 'object') return { value: payload ?? null };
    const summary = {};
    for (const key of ['fieldCount', 'affectedRows', 'insertId', 'info', 'serverStatus', 'warningStatus', 'changedRows']) {
        if (payload[key] !== undefined) summary[key] = payload[key];
    }
    return summary;
}

function summarizeQueryError(error) {
    return {
        code: error?.code ?? null,
        errno: error?.errno ?? null,
        sqlState: error?.sqlState ?? null,
        message: error?.sqlMessage ?? error?.message ?? 'Database query failed'
    };
}

function formatExecutedSQL(sql, params) {
    return typeof sql === 'string'
        ? mysql.format(sql, Array.isArray(params) ? params : []).trim()
        : String(sql);
}

export function createModerationAuditRecorder(connection) {
    const startedAt = performance.now();
    const statements = [];
    async function record(method, sql, params = []) {
        const queryStartedAt = performance.now();
        const renderedSQL = formatExecutedSQL(sql, params);
        try {
            const result = await connection[method](sql, params);
            statements.push({
                method, sql: renderedSQL, success: true,
                durationMs: Math.max(0, Math.round(performance.now() - queryStartedAt)),
                response: summarizeQueryResult(result)
            });
            return result;
        } catch (error) {
            statements.push({
                method, sql: renderedSQL, success: false,
                durationMs: Math.max(0, Math.round(performance.now() - queryStartedAt)),
                error: summarizeQueryError(error)
            });
            throw error;
        }
    }
    return {
        connection: {
            execute(sql, params = []) { return record('execute', sql, params); },
            query(sql, params = []) { return record('query', sql, params); }
        },
        statements,
        elapsedMs() { return Math.max(0, Math.round(performance.now() - startedAt)); }
    };
}

export function moderationRequestSummary(content) {
    const type = String(content?.type ?? 'unknown');
    if (type === 'new_benchmark') {
        const items = Array.isArray(content.benchmarks) ? content.benchmarks : [];
        return items[0]?.name
            ? `${items[0].name}${items.length > 1 ? ` + ${items.length - 1} more` : ''}`
            : 'New benchmark';
    }
    if (type === 'new_model') {
        const items = Array.isArray(content.models) ? content.models : [];
        return items[0]?.name
            ? `${items[0].name}${items.length > 1 ? ` + ${items.length - 1} more` : ''}`
            : 'New model';
    }
    if (type === 'benchmark_result') {
        const count = Array.isArray(content.results) ? content.results.length : 0;
        return `${count || 1} benchmark result${count === 1 ? '' : 's'}`;
    }
    if (type === 'entity_change') {
        const action = content.operation === 'delete' ? 'Delete' : 'Change';
        const kind = content.targetKind === 'benchmark'
            ? 'benchmark'
            : content.targetKind === 'model' ? 'model' : 'score';
        const name = content.before?.name || content.before?.result?.source?.title || `#${content.targetID}`;
        return `${action} ${kind}: ${name}`;
    }
    if (type === 'admin_message') return 'Message to senior reviewers';
    return String(content?.name ?? content?.targetName ?? (type === 'feedback' ? 'BenchPoll feedback' : type));
}

export function moderationAuditSnapshot(log, content, status = log.status) {
    return {
        moderationLogID: Number(log.ID),
        status,
        submittedBy: log.user_id === null || log.user_id === undefined ? null : Number(log.user_id),
        reportCount: Number(log.report_count ?? 0),
        createdAt: log.created_at ?? null,
        updatedAt: log.updated_at ?? null,
        content: structuredClone(content)
    };
}

export async function insertModerationAuditLog(connection, recorder, details) {
    if (!AUDIT_ACTIONS.has(details.actionType)) {
        throw new Error(`Unsupported moderation audit action: ${details.actionType}`);
    }
    const reviewerUserID = Number(details.reviewerUserID);
    if (!Number.isSafeInteger(reviewerUserID) || reviewerUserID < 1) {
        throw new Error('A valid reviewer user ID is required for moderation auditing.');
    }
    const outcome = details.outcome ?? 'success';
    if (!new Set(['success', 'failure']).has(outcome)) {
        throw new Error(`Unsupported moderation audit outcome: ${outcome}`);
    }
    if (recorder.statements.length === 0 && outcome === 'success') {
        throw new Error('A moderation action cannot be committed without recorded SQL.');
    }
    const executedSQL = recorder.statements
        .map(statement => `${statement.sql.replace(/;\s*$/, '')};`)
        .join('\n\n');
    const databaseResponse = {
        statementCount: recorder.statements.length,
        successfulStatements: recorder.statements.filter(statement => statement.success).length,
        statements: recorder.statements.map((statement, index) => ({
            index: index + 1,
            method: statement.method,
            success: statement.success,
            durationMs: statement.durationMs,
            ...(statement.success ? { response: statement.response } : { error: statement.error })
        }))
    };
    if (details.error) {
        databaseResponse.operationError = {
            code: details.error.code ?? null,
            status: Number.isInteger(Number(details.error.status)) ? Number(details.error.status) : null,
            message: details.error.message ?? 'Moderation operation failed',
            body: details.error.body && typeof details.error.body === 'object'
                ? structuredClone(details.error.body)
                : null
        };
    }
    const content = details.requestAfter?.content ?? details.requestBefore?.content ?? {};
    const [result] = await connection.execute(`
        INSERT INTO moderation_audit_logs
            (moderation_log_ID, reviewer_user_ID, action_type, request_type, request_summary,
             status_before, status_after, request_before, request_after, executed_sql,
             database_response, outcome, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        details.moderationLogID,
        reviewerUserID,
        details.actionType,
        String(content.type ?? 'unknown').slice(0, 64),
        moderationRequestSummary(content).slice(0, 255),
        details.statusBefore,
        details.statusAfter,
        auditJSON(details.requestBefore),
        details.requestAfter === undefined ? null : auditJSON(details.requestAfter),
        executedSQL,
        auditJSON(databaseResponse),
        outcome,
        recorder.elapsedMs()
    ]);
    return Number(result.insertId);
}

export async function queryAdminDataExplorer(connection, input = {}) {
    const entity = input.entity ?? 'benchmarks';
    if (typeof entity !== 'string' || !Object.hasOwn(EXPLORER_ENTITIES, entity)) {
        throw requestError('invalid_explorer_entity');
    }
    const search = normalizeSearch(input.search);
    const page = normalizePageValue(input.page, 'page', 1, 1000000);
    const pageSize = normalizePageValue(input.pageSize, 'page_size', 25, 100);
    const config = EXPLORER_ENTITIES[entity];
    const where = search ? `WHERE ${config.search} LIKE ?` : '';
    const searchParams = search ? [`%${search}%`] : [];
    const [countRows] = await connection.execute(`SELECT COUNT(*) AS total ${config.from} ${where}`, searchParams);
    const total = Number(countRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(page, totalPages);
    const offset = (normalizedPage - 1) * pageSize;
    const [rows] = await connection.execute(
        `SELECT ${config.select} ${config.from} ${where} ORDER BY ${config.orderBy} LIMIT ${pageSize} OFFSET ${offset}`,
        searchParams
    );
    const listKeys = [...new Set(['id', ...config.columns.map(column => column.key), ...(config.actionKeys ?? [])])];
    return {
        entity,
        label: config.label,
        entities: Object.entries(EXPLORER_ENTITIES).map(([key, value]) => ({ key, label: value.label })),
        columns: config.columns,
        rows: rows.map(row => Object.fromEntries(listKeys.map(key => [key, row[key]]))),
        page: normalizedPage,
        pageSize,
        total,
        totalPages
    };
}

export async function queryAdminDataRecord(connection, input = {}) {
    const entity = input.entity;
    if (typeof entity !== 'string' || !Object.hasOwn(EXPLORER_ENTITIES, entity)) {
        throw requestError('invalid_explorer_entity');
    }
    const recordID = input.id;
    if ((typeof recordID !== 'number' && typeof recordID !== 'string')
        || String(recordID).trim() === '' || String(recordID).length > 191) {
        throw requestError('invalid_record_id');
    }
    const config = EXPLORER_ENTITIES[entity];
    const [rows] = await connection.execute(`
        SELECT * FROM (SELECT ${config.select} ${config.from}) AS explorer_record
        WHERE explorer_record.id = ? LIMIT 1`, [recordID]);
    if (rows.length !== 1) throw { status: 404, body: { error: 'explorer_record_not_found' } };
    return { entity, label: config.label, row: rows[0] };
}

export async function queryModerationAuditLogs(connection, input = {}, options = {}) {
    const page = normalizePageValue(input.page, 'page', 1, 1000000);
    const pageSize = normalizePageValue(input.pageSize, 'page_size', 25, 100);
    const search = normalizeSearch(input.search);
    let moderationLogID = null;
    if (input.moderationLogID !== undefined && input.moderationLogID !== null && input.moderationLogID !== '') {
        moderationLogID = normalizePositiveID(input.moderationLogID, 'invalid_moderation_log_id');
    }
    const visibleActions = [...AUDIT_ACTIONS].filter(action => (
        options.includeSeniorActions || !SENIOR_AUDIT_ACTIONS.has(action)
    ));
    const actionType = input.actionType ?? '';
    if (typeof actionType !== 'string' || (actionType && !visibleActions.includes(actionType))) {
        throw requestError('invalid_audit_action');
    }
    const conditions = [];
    const parameters = [];
    if (!options.includeSeniorActions) {
        conditions.push(`action_type NOT IN (${[...SENIOR_AUDIT_ACTIONS].map(() => '?').join(', ')})`);
        parameters.push(...SENIOR_AUDIT_ACTIONS);
    }
    if (moderationLogID !== null) {
        conditions.push('moderation_log_ID = ?');
        parameters.push(moderationLogID);
    }
    if (actionType) {
        conditions.push('action_type = ?');
        parameters.push(actionType);
    }
    if (search) {
        conditions.push("CONCAT_WS(' ', ID, reviewer_user_ID, request_type, request_summary, status_before, status_after, outcome) LIKE ?");
        parameters.push(`%${search}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [countRows] = await connection.execute(
        `SELECT COUNT(*) AS total FROM moderation_audit_logs ${where}`,
        parameters
    );
    const total = Number(countRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const normalizedPage = Math.min(page, totalPages);
    const offset = (normalizedPage - 1) * pageSize;
    const [rows] = await connection.execute(`
        SELECT ID, moderation_log_ID, reviewer_user_ID, action_type, request_type,
               request_summary, status_before, status_after, outcome, duration_ms, created_at
        FROM moderation_audit_logs ${where}
        ORDER BY created_at DESC, ID DESC
        LIMIT ${pageSize} OFFSET ${offset}`, parameters);
    return { rows, page: normalizedPage, pageSize, total, totalPages, actions: visibleActions };
}

export async function queryModerationAuditLogDetail(connection, input = {}, options = {}) {
    const auditID = normalizePositiveID(input.ID, 'invalid_audit_id');
    const parameters = [auditID];
    const visibility = options.includeSeniorActions
        ? ''
        : ` AND action_type NOT IN (${[...SENIOR_AUDIT_ACTIONS].map(() => '?').join(', ')})`;
    if (!options.includeSeniorActions) parameters.push(...SENIOR_AUDIT_ACTIONS);
    const [rows] = await connection.execute(`
        SELECT ID, moderation_log_ID, reviewer_user_ID, action_type, request_type,
               request_summary, status_before, status_after, request_before, request_after,
               executed_sql, database_response, outcome, duration_ms, created_at
        FROM moderation_audit_logs
        WHERE ID = ?${visibility} LIMIT 1`, parameters);
    if (rows.length !== 1) throw { status: 404, body: { error: 'audit_log_not_found' } };
    return {
        ...rows[0],
        request_before: parseStoredJSON(rows[0].request_before),
        request_after: parseStoredJSON(rows[0].request_after),
        database_response: parseStoredJSON(rows[0].database_response)
    };
}

export const MODERATION_AUDIT_ACTIONS = Object.freeze([...AUDIT_ACTIONS]);
export const ADMIN_EXPLORER_ENTITIES = Object.freeze(
    Object.entries(EXPLORER_ENTITIES).map(([key, value]) => ({ key, label: value.label }))
);
