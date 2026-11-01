import { normalizeFieldDefinition, normalizeScoreFields, fieldNameKey } from './public/js/shared/score-fields.js';
import { adaptRunAssignments, pinnedScoreFields, runFieldKind, sortScoreFields } from './public/js/shared/score-field-presets.js';

const error = (code, status = 400) => { throw { status, body: { error: code } }; };
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const id = value => Number.isSafeInteger(value) && value > 0;
export function normalizeFieldContribution(body) {
    if (!body || !['score_field', 'score_field_option'].includes(body.type)) error('invalid_field_contribution');
    const allowed = ['type', 'operation', 'targetID', 'revision', 'definition', 'fieldID', 'label', 'excluded', 'notes'];
    if (Object.keys(body).some(key => !allowed.includes(key))) error('unknown_field_contribution_property');
    if (!['create', 'update', 'delete'].includes(body.operation)) error('invalid_field_operation');
    if (body.operation !== 'create' && (!id(body.targetID) || !id(body.revision))) error('invalid_field_target');
    if (typeof body.notes !== 'string' || body.notes.length > 10000 || (body.operation === 'delete' && !body.notes.trim())) error('field_notes_required');
    const result = { schemaVersion: 1, type: body.type, operation: body.operation,
        targetID: body.operation === 'create' ? null : body.targetID,
        revision: body.operation === 'create' ? null : body.revision, notes: body.notes };
    if (body.type === 'score_field') {
        if (!body.definition || Object.keys(body.definition).some(key => !['name', 'type', 'allowEmpty', 'excludeMissing', 'excludeEmpty', 'options'].includes(key))) error('unknown_field_definition_property');
        if (Array.isArray(body.definition.options) && body.definition.options.some(option => !option || Object.keys(option).some(key => !['label', 'excluded'].includes(key)))) error('unknown_field_option_property');
        try { result.definition = normalizeFieldDefinition(body.definition); }
        catch (cause) { error(cause.message); }
    } else {
        if (!id(body.fieldID) || typeof body.label !== 'string' || !body.label.trim() || body.label.trim().length > 512
            || typeof body.excluded !== 'boolean') error('invalid_field_option');
        Object.assign(result, { fieldID: body.fieldID, label: body.label.trim(), excluded: body.excluded });
    }
    return result;
}

export async function loadScoreFieldCatalog(db, userID = null, forUpdate = false) {
    const [rows] = await db.execute(`SELECT ID, name, field_type AS type, allow_empty AS allowEmpty,
        exclude_missing AS excludeMissing, exclude_empty AS excludeEmpty, revision, is_active AS isActive,
        created_request_ID AS requestID FROM score_fields WHERE is_active = 1 OR name_key IN ('image quality', 'image quality preset') ORDER BY name, ID${forUpdate ? ' FOR UPDATE' : ''}`);
    const [values] = await db.execute(`SELECT ID, field_ID AS fieldID, label, excluded, revision, created_request_ID AS requestID, created_option_index AS pendingIndex
        FROM score_field_options WHERE is_active = 1 ORDER BY label, ID${forUpdate ? ' FOR UPDATE' : ''}`);
    const fields = rows.filter(row => Number(row.isActive ?? 1) !== 0).map(row => ({ ...row, ID: Number(row.ID), revision: Number(row.revision),
        allowEmpty: Boolean(row.allowEmpty), excludeMissing: Boolean(row.excludeMissing), excludeEmpty: Boolean(row.excludeEmpty),
        options: values.filter(option => Number(option.fieldID) === Number(row.ID)).map(option => ({ ...option,
            ID: Number(option.ID), fieldID: Number(option.fieldID), excluded: Boolean(option.excluded), revision: Number(option.revision) })) }));
    const effort = fields.find(field => fieldNameKey(field.name) === 'effort');
    if (effort) effort.legacyFields = rows.filter(row => Number(row.isActive ?? 1) === 0 && runFieldKind(row) === 'imageQuality')
        .map(row => ({ ID: Number(row.ID), name: row.name, type: row.type }));
    if (userID === null) return sortScoreFields(fields);
    const [pending] = await db.execute(`SELECT ID, content FROM moderation_logs WHERE user_id = ? AND status = 'pending'
        AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.type')) IN ('score_field', 'score_field_option') ORDER BY ID`, [userID]);
    for (const row of pending) {
        const content = json(row.content);
        if (content.operation !== 'create') continue;
        const requestID = Number(row.ID);
        if (content.type === 'score_field') fields.push({ ...content.definition, ID: null, requestID, pending: true,
            options: content.definition.options.map((option, index) => ({ ...option, ID: null, pendingIndex: index })) });
        else {
            const field = fields.find(item => item.ID === content.fieldID);
            if (field) field.options.push({ ID: null, requestID, pending: true, label: content.label, excluded: content.excluded });
        }
    }
    return sortScoreFields(fields);
}

export function normalizeScoreFieldRequests(input) {
    if (!Array.isArray(input) || input.length > 64) error('invalid_score_fields');
    const seen = new Set();
    return input.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['fieldID', 'fieldRequestID', 'value', 'optionRequestID', 'optionIndex', 'newOption'].includes(key))) error('invalid_score_field_assignment');
        const direct = Object.hasOwn(item, 'fieldID');
        if (direct === Object.hasOwn(item, 'fieldRequestID') || !id(direct ? item.fieldID : item.fieldRequestID)) error('score_field_reference_required');
        const key = direct ? `id:${item.fieldID}` : `request:${item.fieldRequestID}`;
        if (seen.has(key)) error('duplicate_score_field');
        seen.add(key);
        const result = direct ? { fieldID: item.fieldID } : { fieldRequestID: item.fieldRequestID };
        if (Object.hasOwn(item, 'optionIndex')) {
            if (direct || !Number.isSafeInteger(item.optionIndex) || item.optionIndex < 0 || item.optionIndex >= 100
                || ['value', 'newOption', 'optionRequestID'].some(key => Object.hasOwn(item, key))) error('invalid_pending_option_index');
            result.optionIndex = item.optionIndex;
        } else if (Object.hasOwn(item, 'newOption')) {
            if (typeof item.newOption !== 'string' || !item.newOption.trim() || item.newOption.trim().length > 512
                || Object.hasOwn(item, 'optionRequestID') || Object.hasOwn(item, 'value')) error('invalid_new_field_option');
            result.newOption = item.newOption.trim();
        } else if (Object.hasOwn(item, 'optionRequestID')) {
            if (!id(item.optionRequestID) || Object.hasOwn(item, 'value')) error('invalid_option_reference');
            result.optionRequestID = item.optionRequestID;
        } else {
            if (!Object.hasOwn(item, 'value') || !['string', 'number'].includes(typeof item.value) && item.value !== null) error('invalid_field_value');
            result.value = item.value;
        }
        return result;
    });
}

export function normalizeContributionScoreFields(input, fields, { historical = [] } = {}) {
    const fixed = pinnedScoreFields(fields.filter(field => !field.pending
        && ['effort', 'harness'].includes(fieldNameKey(field.name))))
        .map(field => ({ ...field, options: field.options.filter(option => !option.pending && id(option.ID)) }));
    let normalized;
    try { normalized = normalizeScoreFields(input, fixed); }
    catch (cause) { error(cause.message); }
    // Only the server's original score supplies retired fields; submitted assignments never do.
    return [...historical.filter(assignment => !fixed.some(field => field.ID === assignment.fieldID)), ...normalized]
        .map(assignment => ({ ...assignment })).sort((a, b) => a.fieldID - b.fieldID);
}

async function ownFieldRequest(db, requestID, userID, type, lock = false) {
    const [rows] = await db.execute(`SELECT status, user_id, content FROM moderation_logs WHERE ID = ? LIMIT 1${lock ? ' FOR SHARE' : ''}`, [requestID]);
    const row = rows[0];
    if (!row || String(row.user_id) !== String(userID)) error('field_reference_not_found', 409);
    const content = json(row.content);
    if (content.type !== type || content.operation !== 'create' || !['pending', 'approved'].includes(row.status)) error('field_reference_rejected', 409);
    return { ...row, content };
}

// Pending references are valid drafts, but only approved dependencies may be applied.
export async function resolveScoreFields(db, input, userID, { apply = false, moderationLogID = null } = {}) {
    const fields = await loadScoreFieldCatalog(db, null, apply);
    const result = [];
    const resolvedFields = new Set();
    let adapted;
    try { adapted = adaptRunAssignments(input, fields); }
    catch { error('conflicting_legacy_effort_values', 409); }
    for (const assignment of normalizeScoreFieldRequests(adapted)) {
        let field = fields.find(item => item.ID === assignment.fieldID);
        let pendingFieldRequest = false;
        if (assignment.fieldRequestID) {
            const request = await ownFieldRequest(db, assignment.fieldRequestID, userID, 'score_field', apply);
            if (request.status === 'pending') {
                if (apply) error('referenced_contribution_pending', 409);
                pendingFieldRequest = true;
                field = { ...request.content.definition, ID: assignment.fieldRequestID,
                    options: request.content.definition.options.map((option, index) => ({ ...option, ID: index + 1, pendingIndex: index })) };
            } else {
                const [rows] = await db.execute('SELECT ID FROM score_fields WHERE created_request_ID = ? AND is_active = 1', [assignment.fieldRequestID]);
                field = fields.find(item => item.ID === Number(rows[0]?.ID));
            }
        }
        if (!field) error('score_field_unavailable', 409);
        // An approved request and its field ID are aliases; pending IDs have their own namespace.
        const identity = pendingFieldRequest ? `request:${assignment.fieldRequestID}` : `id:${field.ID}`;
        if (resolvedFields.has(identity)) error('duplicate_score_field');
        resolvedFields.add(identity);
        let value = assignment.value;
        if (assignment.optionIndex !== undefined) {
            if (field.type !== 'enum') error('unexpected_option_reference');
            const option = field.options.find(item => item.pendingIndex === assignment.optionIndex);
            if (!option) error('score_field_option_unavailable', 409);
            value = option.ID;
        }
        if (assignment.optionRequestID) {
            if (field.type !== 'enum') error('unexpected_option_reference');
            const request = await ownFieldRequest(db, assignment.optionRequestID, userID, 'score_field_option', apply);
            if (request.content.fieldID !== field.ID) error('field_option_mismatch');
            if (request.status === 'pending') {
                if (apply) error('referenced_contribution_pending', 409);
                continue;
            }
            const [rows] = await db.execute('SELECT ID FROM score_field_options WHERE created_request_ID = ? AND is_active = 1', [assignment.optionRequestID]);
            value = Number(rows[0]?.ID);
        }
        if (assignment.newOption !== undefined) {
            if (field.type !== 'enum') error('unexpected_new_field_option');
            const existing = field.options.find(option => fieldNameKey(option.label) === fieldNameKey(assignment.newOption));
            if (existing) value = existing.ID;
            else if (!apply) continue;
            else {
                await db.execute('SELECT ID FROM score_fields WHERE ID = ? FOR UPDATE', [field.ID]);
                const [again] = await db.execute('SELECT ID, is_active FROM score_field_options WHERE field_ID = ? AND label_key = ?', [field.ID, fieldNameKey(assignment.newOption)]);
                if (again.length) {
                    if (!again[0].is_active) error('field_option_retired', 409);
                    value = Number(again[0].ID);
                } else {
                    const [insert] = await db.execute('INSERT INTO score_field_options (field_ID, label, label_key, excluded, created_request_ID) VALUES (?, ?, ?, 0, ?)',
                        [field.ID, assignment.newOption, fieldNameKey(assignment.newOption), moderationLogID]);
                    value = Number(insert.insertId);
                }
                field.options.push({ ID: value, label: assignment.newOption, excluded: false });
            }
        }
        try { result.push(...normalizeScoreFields([{ fieldID: field.ID, value }], [field])); }
        catch (cause) { error(cause.message); }
    }
    return result.sort((a, b) => a.fieldID - b.fieldID);
}

export async function applyFieldContribution(db, content, metadata) {
    const isField = content.type === 'score_field';
    const table = isField ? 'score_fields' : 'score_field_options';
    const definition = content.definition;
    if (!isField) {
        const [parent] = await db.execute("SELECT ID FROM score_fields WHERE ID = ? AND field_type = 'enum' AND is_active = 1 FOR UPDATE", [content.fieldID]);
        if (!parent.length) error('score_field_unavailable', 409);
    }
    if (content.operation !== 'create') {
        const [rows] = await db.execute(`SELECT * FROM ${table} WHERE ID = ? AND is_active = 1 FOR UPDATE`, [content.targetID]);
        const current = rows[0];
        if (!current || Number(current.revision) !== content.revision) error('field_changed_since_submission', 409);
        if (!isField && Number(current.field_ID) !== content.fieldID) error('field_option_mismatch');
        if (isField && content.operation === 'update' && definition.type !== current.field_type) error('field_type_immutable', 409);
        if (isField && content.operation === 'update' && definition.allowEmpty !== Boolean(current.allow_empty)) {
            const [[count]] = await db.execute("SELECT COUNT(*) AS n FROM benchmark_results WHERE JSON_CONTAINS(score_fields, JSON_OBJECT('fieldID', ?))", [content.targetID]);
            if (Number(count.n)) error('referenced_field_type_immutable', 409);
        }
        if (content.operation === 'delete') {
            if (!isField) {
                const [[remaining]] = await db.execute('SELECT COUNT(*) AS n FROM score_field_options WHERE field_ID = ? AND is_active = 1', [content.fieldID]);
                if (Number(remaining.n) <= 1) error('keep_one_field_option', 409);
            }
            const [[count]] = await db.execute(isField
                ? "SELECT COUNT(*) AS n FROM benchmark_results WHERE JSON_CONTAINS(score_fields, JSON_OBJECT('fieldID', ?))"
                : "SELECT COUNT(*) AS n FROM benchmark_results WHERE JSON_CONTAINS(score_fields, JSON_OBJECT('fieldID', ?, 'value', ?))",
            isField ? [content.targetID] : [content.fieldID, content.targetID]);
            if (Number(count.n)) error('field_still_used_by_scores', 409);
            await db.execute(`UPDATE ${table} SET is_active = 0, revision = revision + 1 WHERE ID = ?`, [content.targetID]);
            return;
        }
    }
    if (isField) {
        const [conflicts] = await db.execute('SELECT ID FROM score_fields WHERE name_key = ? AND ID <> ?', [fieldNameKey(definition.name), content.targetID ?? 0]);
        if (conflicts.length) error('score_field_name_exists', 409);
        if (content.operation === 'update') {
            const [options] = await db.execute('SELECT label, excluded FROM score_field_options WHERE field_ID = ? AND is_active = 1 ORDER BY label, ID FOR UPDATE', [content.targetID]);
            const signature = items => JSON.stringify(items.map(option => [option.label, Boolean(option.excluded)]).sort((a, b) => a[0].localeCompare(b[0])));
            if (signature(options) !== signature(definition.options)) error('edit_field_options_separately', 409);
            await db.execute(`UPDATE score_fields SET name = ?, name_key = ?, field_type = ?, allow_empty = ?, exclude_missing = ?, exclude_empty = ?, revision = revision + 1 WHERE ID = ?`,
                [definition.name, fieldNameKey(definition.name), definition.type, definition.allowEmpty, definition.excludeMissing, definition.excludeEmpty, content.targetID]);
            return;
        }
        const [insert] = await db.execute(`INSERT INTO score_fields (name, name_key, field_type, allow_empty, exclude_missing, exclude_empty, created_request_ID) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [definition.name, fieldNameKey(definition.name), definition.type, definition.allowEmpty, definition.excludeMissing, definition.excludeEmpty, metadata.moderationLogID]);
        for (const [index, option] of definition.options.entries()) await db.execute('INSERT INTO score_field_options (field_ID, label, label_key, excluded, created_request_ID, created_option_index) VALUES (?, ?, ?, ?, ?, ?)',
            [insert.insertId, option.label, fieldNameKey(option.label), option.excluded, metadata.moderationLogID, index]);
    } else {
        const [field] = await db.execute("SELECT ID FROM score_fields WHERE ID = ? AND field_type = 'enum' AND is_active = 1 FOR UPDATE", [content.fieldID]);
        if (!field.length) error('score_field_unavailable', 409);
        const [conflicts] = await db.execute('SELECT ID FROM score_field_options WHERE field_ID = ? AND label_key = ? AND ID <> ?', [content.fieldID, fieldNameKey(content.label), content.targetID ?? 0]);
        if (conflicts.length) error('field_option_exists', 409);
        if (content.operation === 'create') await db.execute('INSERT INTO score_field_options (field_ID, label, label_key, excluded, created_request_ID) VALUES (?, ?, ?, ?, ?)',
            [content.fieldID, content.label, fieldNameKey(content.label), content.excluded, metadata.moderationLogID]);
        else await db.execute('UPDATE score_field_options SET label = ?, label_key = ?, excluded = ?, revision = revision + 1 WHERE ID = ?',
            [content.label, fieldNameKey(content.label), content.excluded, content.targetID]);
    }
}
