// This module deliberately has no runtime, database or filesystem dependencies.
export const RUN_FIELD_PRESET_MIGRATION_ID = '20261013_run_field_presets';
export const PRESERVED_EFFORT_OPTIONS = Object.freeze([
    [3, 'high'], [4, 'low'], [5, 'max'], [6, 'medium'],
    [7, 'minimal'], [8, 'none'], [9, 'ultra'], [10, 'xhigh']
]);

const aliases = {
    harness: ['agent harness', 'harness'],
    version: ['agent harness version', 'harness version'],
    image: ['image quality preset', 'image quality'],
    effort: ['reasoning effort', 'effort']
};
const names = { harness: 'Harness', version: 'Harness version', effort: 'Effort' };
const immutableKeys = new Set(['moderation', 'audit', 'auditLog', 'audit_log', 'history', 'reviewHistory',
    'review_history', 'requestBefore', 'requestAfter', 'request_before', 'request_after']);
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
export const presetLabelKey = value => String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US');

export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
const same = (left, right) => stableStringify(left) === stableStringify(right);
export const parseMigrationJSON = value => typeof value === 'string' ? JSON.parse(value) : structuredClone(value);

export function materializePresetReferences(value, optionIDs) {
    if (Array.isArray(value)) return value.map(item => materializePresetReferences(item, optionIDs));
    if (!object(value)) return value;
    if (Object.keys(value).length === 1 && typeof value.presetOptionRef === 'string') {
        const ID = optionIDs instanceof Map ? optionIDs.get(value.presetOptionRef) : optionIDs[value.presetOptionRef];
        if (!Number.isSafeInteger(ID) || ID <= 0) throw new Error(`Unresolved preset option: ${value.presetOptionRef}`);
        return ID;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materializePresetReferences(item, optionIDs)]));
}

export function planRunFieldPresetMigration(input) {
    const plan = { migrationID: RUN_FIELD_PRESET_MIGRATION_ID, blocked: [], fieldIDs: {},
        fieldChanges: [], optionCreates: [], scoreChanges: [], profileChanges: [], pendingChanges: [],
        inventory: { harnessValues: [], imageValues: [], identicalEffortPairs: 0, pendingProposals: [], caseAliases: [] } };
    const fields = structuredClone(input.fields ?? []);
    const options = structuredClone(input.options ?? []);
    const scores = input.scores ?? [];
    const profiles = input.profiles ?? [];
    const pending = input.pending ?? [];
    const block = (code, location, details = {}) => plan.blocked.push({ code, location, ...details });
    const decoded = (raw, location) => {
        try { return parseMigrationJSON(raw); }
        catch { block('invalid_json', location); return undefined; }
    };
    const catalog = {};
    for (const [kind, accepted] of Object.entries(aliases)) {
        const found = fields.filter(field => accepted.includes(presetLabelKey(field.name)));
        if (found.length !== 1) { block('ambiguous_or_missing_field', `catalog.${kind}`, { matches: found.map(row => row.ID) }); continue; }
        const field = found[0];
        catalog[kind] = field;
        plan.fieldIDs[kind] = Number(field.ID);
        if (!id(field.ID) || !id(field.revision) || field.name_key !== presetLabelKey(field.name)) {
            block('invalid_field_identity', `field:${field.ID}`);
        }
        const expected = kind === 'effort' ? 'enum' : kind === 'harness' && presetLabelKey(field.name) === 'harness' ? 'enum' : 'text';
        if (field.field_type !== expected) block('unexpected_field_type', `field:${field.ID}`, { expected, actual: field.field_type });
        if (kind !== 'image' && Number(field.is_active) !== 1) block('inactive_target_field', `field:${field.ID}`);
    }
    if (new Set(fields.map(field => Number(field.ID))).size !== fields.length) block('duplicate_field_id', 'catalog');
    if (new Set(options.map(option => Number(option.ID))).size !== options.length) block('duplicate_option_id', 'catalog');
    if (Object.keys(catalog).length !== 4) return finish();
    const { harness, version, image, effort } = catalog;
    if (new Set(Object.values(plan.fieldIDs)).size !== 4) block('aliased_field_identity', 'catalog');
    for (const [ID, label] of PRESERVED_EFFORT_OPTIONS) {
        const option = options.find(row => Number(row.ID) === ID);
        if (!option || Number(option.field_ID) !== Number(effort.ID) || option.label !== label
            || option.label_key !== presetLabelKey(label) || Number(option.is_active) !== 1) {
            block('legacy_effort_option_mismatch', `option:${ID}`, { expectedLabel: label, expectedFieldID: Number(effort.ID) });
        }
    }
    for (const field of [version, image]) {
        if (options.some(option => Number(option.field_ID) === Number(field.ID))) block('text_field_has_options', `field:${field.ID}`);
    }
    const targetOptions = options.filter(option => [Number(harness.ID), Number(effort.ID)].includes(Number(option.field_ID)));
    for (const option of targetOptions) {
        if (!id(option.ID) || !id(option.revision) || typeof option.label !== 'string'
            || option.label.length > 512 || presetLabelKey(option.label).length > 512
            || option.label_key !== presetLabelKey(option.label)) block('invalid_existing_option', `option:${option.ID}`);
    }
    for (const [kind, field] of Object.entries(catalog)) {
        const after = { ...field };
        if (names[kind]) { after.name = names[kind]; after.name_key = presetLabelKey(names[kind]); }
        if (kind === 'harness') after.field_type = 'enum';
        if (kind === 'image') after.is_active = 0;
        if (!same(field, after)) {
            after.revision = Number(field.revision) + 1;
            plan.fieldChanges.push({ ID: Number(field.ID), before: field, after });
        }
    }
    if (plan.blocked.length) return finish();

    const scoreArrays = new Map();
    const required = { harness: new Map(), effort: new Map() };
    const remember = (kind, label, location) => {
        if (label === null) return;
        if (typeof label !== 'string' || !label.length || label.length > 512 || presetLabelKey(label).length > 512
            || !label.trim() || label.trim() !== label) {
            block('label_not_losslessly_representable', location, { value: label }); return;
        }
        required[kind].set(label, (required[kind].get(label) ?? 0) + 1);
    };
    for (const score of scores) {
        const location = `score:${score.ID}`;
        const assignments = decoded(score.score_fields, location);
        if (!Array.isArray(assignments)) { block('invalid_assignment_array', location); continue; }
        scoreArrays.set(score.ID, assignments);
        for (const assignment of assignments) {
            if (!object(assignment) || !Number.isSafeInteger(assignment.fieldID) || assignment.fieldID < 1) {
                block('invalid_assignment', location); continue;
            }
            if (assignment.fieldID === Number(harness.ID) && typeof assignment.value === 'string') remember('harness', assignment.value, location);
            if (assignment.fieldID === Number(image.ID)) {
                remember('effort', assignment.value, location);
                const label = assignment.value;
                const found = plan.inventory.imageValues.find(item => same(item.label, label));
                if (found) found.count++;
                else plan.inventory.imageValues.push({ label, count: 1 });
            }
        }
    }
    plan.inventory.harnessValues = [...required.harness].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([label, count]) => ({ label, count, length: label.length }));
    const values = { harness: new Map(), effort: new Map() };
    for (const kind of ['harness', 'effort']) {
        const fieldID = Number(catalog[kind].ID);
        const byKey = new Map();
        for (const option of targetOptions.filter(row => Number(row.field_ID) === fieldID)) {
            const key = presetLabelKey(option.label);
            if (byKey.has(key)) block('duplicate_option_key', `field:${fieldID}`, { labels: [byKey.get(key).label, option.label] });
            byKey.set(key, option);
            if (Number(option.is_active) === 1) values[kind].set(option.label, Number(option.ID));
        }
        let index = 0;
        for (const label of [...required[kind].keys()].sort()) {
            const key = presetLabelKey(label);
            const existing = byKey.get(key);
            if (existing) {
                if (existing.label.toLocaleLowerCase('en-US') !== label.toLocaleLowerCase('en-US') || Number(existing.is_active) !== 1) {
                    block('lossy_or_retired_option_collision', `field:${fieldID}`, { label, existingLabel: existing.label, existingID: existing.ID });
                } else {
                    values[kind].set(label, object(existing.ID) ? existing.ID : Number(existing.ID));
                    if (existing.label !== label) plan.inventory.caseAliases.push({ fieldID, from: label, to: existing.label,
                        count: required[kind].get(label) });
                }
                continue;
            }
            const ref = `${kind}:${index++}`;
            const option = { ref, fieldID, label, label_key: key, excluded: 0 };
            plan.optionCreates.push(option);
            const value = { presetOptionRef: ref };
            values[kind].set(label, value);
            byKey.set(key, { label, is_active: 1, ID: value });
        }
        const total = targetOptions.filter(row => Number(row.field_ID) === fieldID && Number(row.is_active) === 1).length
            + plan.optionCreates.filter(row => row.fieldID === fieldID).length;
        if (total < 1 || total > 2048) block('option_catalog_size', `field:${fieldID}`, { total });
    }
    const fieldAfter = field => plan.fieldChanges.find(change => change.ID === Number(field.ID))?.after ?? field;
    const approvedValue = (kind, value, location, allowProposal = false) => {
        if (value === null) {
            if (!Number(catalog[kind].allow_empty)) block('empty_target_value_not_allowed', location, { kind });
            return { value: null };
        }
        if (typeof value === 'string') {
            if (values[kind].has(value)) return { value: values[kind].get(value) };
            if (allowProposal && value.trim() === value && value.trim() && value.length <= 512 && presetLabelKey(value).length <= 512) {
                const collision = targetOptions.find(option => Number(option.field_ID) === Number(catalog[kind].ID)
                    && option.label_key === presetLabelKey(value));
                if (!collision && ![...values[kind].keys()].some(label => presetLabelKey(label) === presetLabelKey(value))) {
                    plan.inventory.pendingProposals.push({ location, fieldID: Number(catalog[kind].ID), label: value });
                    return { newOption: value };
                }
                block('pending_label_collision', location, { value });
            } else block('unrecorded_or_invalid_label', location, { kind, value });
            return { value };
        }
        if (Number.isSafeInteger(value) && targetOptions.some(option => Number(option.ID) === value
            && Number(option.field_ID) === Number(catalog[kind].ID) && Number(option.is_active) === 1)) return { value };
        block('invalid_enum_reference', location, { kind, value });
        return { value };
    };

    const pendingContents = new Map();
    for (const row of pending) {
        if (row.status !== 'pending') continue;
        const content = decoded(row.content, `pending:${row.ID}`);
        if (!object(content)) { block('invalid_pending_content', `pending:${row.ID}`); continue; }
        pendingContents.set(Number(row.ID), { row, content });
    }
    const related = fieldID => [Number(harness.ID), Number(image.ID), Number(effort.ID)].includes(fieldID);
    const optionRequest = (requestID, fieldID, row, location) => {
        const request = pendingContents.get(requestID);
        const normalizedFieldID = fieldID === Number(image.ID) ? Number(effort.ID) : fieldID;
        if (request) {
            const content = request.content;
            const dependencyFieldID = content.fieldID === Number(image.ID) ? Number(effort.ID) : content.fieldID;
            if (content.type !== 'score_field_option' || content.operation !== 'create'
                || dependencyFieldID !== normalizedFieldID || String(request.row.user_id) !== String(row.user_id)) {
                block('incompatible_pending_option_reference', location, { requestID });
            }
        } else if (!options.some(option => Number(option.created_request_ID) === requestID
            && Number(option.field_ID) === normalizedFieldID && Number(option.is_active) === 1)) {
            block('unresolved_option_request', location, { requestID });
        }
    };
    const assignments = (entries, location, row = null) => {
        if (!Array.isArray(entries)) { block('invalid_assignment_array', location); return entries; }
        const output = [];
        const seen = new Map();
        for (const [index, source] of entries.entries()) {
            const here = `${location}[${index}]`;
            if (!object(source)) { block('invalid_assignment', here); output.push(source); continue; }
            let entry = structuredClone(source);
            if (own(entry, 'fieldRequestID')) {
                const actual = fields.find(field => Number(field.created_request_ID) === entry.fieldRequestID);
                const request = pendingContents.get(entry.fieldRequestID)?.content;
                if (actual && related(Number(actual.ID))) {
                    if (!row) block('pending_reference_in_recorded_score', here);
                    else { delete entry.fieldRequestID; entry.fieldID = Number(actual.ID); }
                } else if (request?.type === 'score_field' && Object.values(aliases).flat().includes(presetLabelKey(request.definition?.name))) {
                    block('unresolved_run_field_request', here, { requestID: entry.fieldRequestID });
                } else if (Number(entry.fieldID) === Number(image.ID) || !id(entry.fieldRequestID)) block('invalid_field_request', here);
            }
            if (related(entry.fieldID)) {
                if (Object.keys(entry).some(key => !['fieldID', 'value', 'optionRequestID', 'newOption'].includes(key))
                    || ['value', 'optionRequestID', 'newOption'].filter(key => own(entry, key)).length !== 1) {
                    block('unsupported_run_assignment_shape', here);
                } else {
                    const kind = entry.fieldID === Number(harness.ID) ? 'harness' : 'effort';
                    if (entry.fieldID === Number(image.ID)) entry.fieldID = Number(effort.ID);
                    if (own(entry, 'optionRequestID')) {
                        if (!row || !id(entry.optionRequestID)) block('invalid_option_request', here);
                        else optionRequest(entry.optionRequestID, entry.fieldID, row, here);
                    } else if (own(entry, 'newOption')) {
                        if (!row) block('pending_proposal_in_recorded_score', here);
                        else if (typeof entry.newOption !== 'string' || entry.newOption.trim() !== entry.newOption
                            || !entry.newOption.length || entry.newOption.length > 512
                            || presetLabelKey(entry.newOption).length > 512) block('invalid_pending_proposal', here);
                        // Explicit proposals stay proposals even if an approved label already exists.
                    } else {
                        const mapped = approvedValue(kind, entry.value, here, Boolean(row) && typeof entry.value === 'string');
                        delete entry.value;
                        Object.assign(entry, mapped);
                    }
                }
            }
            const key = own(entry, 'fieldID') ? `id:${entry.fieldID}` : `request:${entry.fieldRequestID}`;
            if (seen.has(key)) {
                const previous = seen.get(key);
                if (related(entry.fieldID) && same(previous, entry)) {
                    if (!row && entry.fieldID === Number(effort.ID)) plan.inventory.identicalEffortPairs++;
                    continue;
                }
                block('conflicting_assignments', here, { previous, incoming: entry });
            } else seen.set(key, entry);
            output.push(entry);
        }
        return output;
    };
    for (const score of scores) {
        const before = scoreArrays.get(score.ID);
        if (!before) continue;
        const after = assignments(before, `score:${score.ID}`);
        if (!same(before, after)) plan.scoreChanges.push({ ID: score.ID, before, after });
    }

    for (const profile of profiles) {
        const location = `profile:${profile.user_ID}:${profile.profile_key}`;
        const before = decoded(profile.comparison, location);
        if (!object(before) || !Array.isArray(before.keys) || !Array.isArray(before.filters)) { block('invalid_comparison_profile', location); continue; }
        const after = structuredClone(before);
        const oldKey = `field:${image.ID}`;
        const effortKey = `field:${effort.ID}`;
        after.keys = [...new Set(before.keys.map(key => key === oldKey ? effortKey : key))];
        const filters = [];
        const seen = new Map();
        for (const original of before.filters) {
            if (!object(original)) { block('invalid_comparison_filter', location); filters.push(original); continue; }
            const filter = { ...original };
            if ([oldKey, `field:${harness.ID}`, effortKey].includes(filter.key)) {
                const kind = filter.key === `field:${harness.ID}` ? 'harness' : 'effort';
                if (filter.key === oldKey && filter.operator !== 'eq') block('non_equality_image_filter', location, { filter });
                if (filter.operator === 'eq') {
                    const mapped = approvedValue(kind, filter.value, location);
                    filter.value = mapped.value;
                } else if (!['present', 'absent'].includes(filter.operator)) block('unsupported_run_filter', location, { filter });
                if (filter.key === oldKey) filter.key = effortKey;
                if (seen.has(filter.key)) {
                    if (same(seen.get(filter.key), filter)) continue;
                    block('conflicting_comparison_filters', location, { previous: seen.get(filter.key), incoming: filter });
                }
                seen.set(filter.key, filter);
            }
            filters.push(filter);
        }
        after.filters = filters;
        if (!same(before, after)) plan.profileChanges.push({ user_ID: profile.user_ID, profile_key: profile.profile_key, before, after });
    }

    const rewriteContribution = (content, row, location) => {
        const after = structuredClone(content);
        if (content.type === 'score_field') {
            const field = fields.find(field => Number(field.ID) === content.targetID);
            const kind = Object.keys(catalog).find(kind => Number(catalog[kind].ID) === content.targetID);
            if (content.operation === 'create') {
                if (Object.values(aliases).flat().includes(presetLabelKey(content.definition?.name))) block('pending_duplicate_run_field', location);
                return after;
            }
            if (!kind) return after;
            if (kind === 'image' || kind === 'harness' || kind === 'effort' && plan.optionCreates.some(option => option.fieldID === Number(effort.ID))) {
                block('pending_field_intent_requires_review', location, { fieldID: content.targetID });
                return after;
            }
            if (content.revision !== Number(field.revision)) block('stale_pending_field_revision', location);
            if (content.operation === 'update') {
                if (!object(after.definition) || after.definition.type !== field.field_type) block('incompatible_pending_field_definition', location);
                else if (aliases[kind].includes(presetLabelKey(after.definition.name))) after.definition.name = names[kind];
            }
            after.revision = Number(fieldAfter(field).revision);
        } else if (content.type === 'score_field_option' && related(content.fieldID)) {
            if (content.fieldID === Number(image.ID)) {
                if (content.operation !== 'create') block('legacy_image_option_intent_requires_review', location);
                after.fieldID = Number(effort.ID);
            }
            if (content.operation === 'create') {
                const kind = after.fieldID === Number(harness.ID) ? 'harness' : 'effort';
                if (values[kind].has(content.label)) block('pending_option_create_now_duplicates_recorded_value', location, { label: content.label });
                else if (typeof content.label !== 'string' || content.label.trim() !== content.label || !content.label.length
                    || content.label.length > 512 || presetLabelKey(content.label).length > 512) block('invalid_pending_option_label', location);
                else if ([...values[kind].keys()].some(label => presetLabelKey(label) === presetLabelKey(content.label))) block('pending_label_collision', location, { value: content.label });
            } else {
                const option = options.find(option => Number(option.ID) === content.targetID && Number(option.field_ID) === after.fieldID);
                if (!option || Number(option.revision) !== content.revision) block('unresolved_pending_option_target', location);
            }
        }
        return after;
    };
    const visitPending = (value, row, location) => {
        if (Array.isArray(value)) return value.map((item, index) => visitPending(item, row, `${location}[${index}]`));
        if (!object(value)) return value;
        const typed = ['score_field', 'score_field_option'].includes(value.type);
        const output = typed ? rewriteContribution(value, row, location) : structuredClone(value);
        if (!typed && related(value.fieldID)) block('unrecognized_pending_field_reference', location, { fieldID: value.fieldID });
        for (const [key, item] of Object.entries(output)) {
            if (immutableKeys.has(key)) continue;
            if (key === 'scoreFields' || key === 'score_fields') output[key] = assignments(item, `${location}.${key}`, row);
            else output[key] = visitPending(item, row, `${location}.${key}`);
        }
        return output;
    };
    for (const { row, content: before } of pendingContents.values()) {
        const after = visitPending(before, row, `pending:${row.ID}`);
        if (!same(before, after)) plan.pendingChanges.push({ ID: row.ID, before, after });
    }
    return finish();

    function finish() {
        plan.canApply = plan.blocked.length === 0;
        plan.noop = plan.canApply && ![plan.fieldChanges, plan.optionCreates, plan.scoreChanges, plan.profileChanges, plan.pendingChanges].some(items => items.length);
        plan.summary = { fields: plan.fieldChanges.length, newOptions: plan.optionCreates.length, scores: plan.scoreChanges.length,
            profiles: plan.profileChanges.length, pending: plan.pendingChanges.length, blocked: plan.blocked.length,
            harnessDistinct: plan.inventory.harnessValues.length, harnessMaxLength: Math.max(0, ...plan.inventory.harnessValues.map(item => item.length)),
            imageAssignments: plan.inventory.imageValues.reduce((sum, item) => sum + item.count, 0), identicalEffortPairs: plan.inventory.identicalEffortPairs,
            caseAliases: plan.inventory.caseAliases.length };
        return plan;
    }
}
