import * as G from '/js/global.js';
import { initializeOverlays } from './shared/overlays.js';

initializeOverlays([...document.querySelectorAll('.moderation-overlay')]);

const statusFilter = document.getElementById('status-filter');
const logList = document.getElementById('log-list');
const editorOverlay = document.getElementById('editor-overlay');
const editorForm = document.getElementById('request-editor');
const editorType = document.getElementById('editor-type');
const editorFields = document.getElementById('editor-fields');
const editorPreview = document.getElementById('editor-preview');
const escalateOverlay = document.getElementById('escalate-overlay');
const escalateForm = document.getElementById('escalate-form');
const escalateNote = document.getElementById('escalate-note');
const sqlOverlay = document.getElementById('sql-overlay');
const sqlPreview = document.getElementById('sql-preview');
const workspaceTabs = [...document.querySelectorAll('[data-workspace-view]')];
const workspaceViews = {
    queue: document.getElementById('queue-view'),
    explorer: document.getElementById('explorer-view'),
    audit: document.getElementById('audit-view'),
    messages: document.getElementById('messages-view')
};
const explorerFilter = document.getElementById('explorer-filter');
const explorerEntity = document.getElementById('explorer-entity');
const explorerSearch = document.getElementById('explorer-search');
const explorerSummary = document.getElementById('explorer-summary');
const explorerHead = document.getElementById('explorer-head');
const explorerBody = document.getElementById('explorer-body');
const explorerPage = document.getElementById('explorer-page');
const explorerPrev = document.getElementById('explorer-prev');
const explorerNext = document.getElementById('explorer-next');
const explorerAdd = document.getElementById('explorer-add');
const explorerAccessMark = document.getElementById('explorer-access-mark');
const explorerAccessLabel = document.getElementById('explorer-access-label');
const auditFilter = document.getElementById('audit-filter');
const auditAction = document.getElementById('audit-action');
const auditLogID = document.getElementById('audit-log-id');
const auditSearch = document.getElementById('audit-search');
const auditSummary = document.getElementById('audit-summary');
const auditBody = document.getElementById('audit-body');
const auditPage = document.getElementById('audit-page');
const auditPrev = document.getElementById('audit-prev');
const auditNext = document.getElementById('audit-next');
const recordOverlay = document.getElementById('record-overlay');
const recordEyebrow = document.getElementById('record-eyebrow');
const recordTitle = document.getElementById('record-title');
const recordDetails = document.getElementById('record-details');
const recordEdit = document.getElementById('record-edit');
const recordDelete = document.getElementById('record-delete');
const composeMessageButton = document.getElementById('compose-message-button');
const messageComposeOverlay = document.getElementById('message-compose-overlay');
const messageComposeForm = document.getElementById('message-compose-form');
const messageComposeBody = document.getElementById('message-compose-body');
const messagesTab = document.getElementById('messages-tab');
const messagesRefresh = document.getElementById('messages-refresh');
const messageList = document.getElementById('message-list');
const messageUnreadCount = document.getElementById('message-unread-count');
const auditOverlay = document.getElementById('audit-overlay');
const auditDetailTitle = document.getElementById('audit-detail-title');
const auditDetailMeta = document.getElementById('audit-detail-meta');
const auditRequestBefore = document.getElementById('audit-request-before');
const auditRequestAfter = document.getElementById('audit-request-after');
const auditSQL = document.getElementById('audit-sql');
const auditResponse = document.getElementById('audit-response');

let activeEditorLog = null;
let activeEditorType = null;
let editorDrafts = {};
let activeEditorPreviewToken = null;
let activeEditorPreviewFingerprint = null;
let activeEscalationLog = null;
let activeEditorUsesJSON = false;
let activeWorkspaceView = 'queue';
let explorerState = { page: 1, totalPages: 1, loaded: false, requestID: 0 };
let auditState = { page: 1, totalPages: 1, loaded: false, requestID: 0, rows: [] };
let reviewerCapabilities = { userID: null, role: null, isSenior: false, messagesAvailable: false };
let activeExplorerRow = null;
let messagesLoaded = false;

const issueTypeLabels = {
    correct_or_add_info: 'Correct or Add Information',
    delete_or_migrate_category: 'Delete or Migrate Category'
};

const requestFields = {
    feedback: [
        { name: 'pageURL', label: 'Page URL', type: 'url', maxLength: 512, wide: true },
        { name: 'details', label: 'Feedback', type: 'textarea', required: true, maxLength: 4000, wide: true }
    ],
    new_benchmark: [],
    new_model: [],
    new_category: [
        { name: 'name', label: 'Category Name', type: 'text', required: true, maxLength: 128 },
        { name: 'parentPath', label: 'Parent Category Path', type: 'text', maxLength: 512 },
        { name: 'pageURL', label: 'Source Page', type: 'url', maxLength: 512, wide: true },
        { name: 'details', label: 'Reason or Notes', type: 'textarea', maxLength: 2000, wide: true }
    ],
    report_issue: [
        {
            name: 'issueType',
            label: 'Issue Type',
            type: 'select',
            required: true,
            options: Object.entries(issueTypeLabels).map(([value, label]) => [value, label])
        },
        { name: 'targetName', label: 'Target Name', type: 'text', required: true, maxLength: 128 },
        {
            name: 'targetKind',
            label: 'Target Kind',
            type: 'select',
            options: [['', 'Not specified'], ['benchmark', 'Benchmark'], ['category', 'Category']]
        },
        { name: 'targetBenchmarkID', label: 'Target Benchmark ID', type: 'number', min: 1 },
        { name: 'categoryPath', label: 'Category Path', type: 'text', maxLength: 512, wide: true },
        { name: 'pageURL', label: 'Page URL', type: 'url', maxLength: 512, wide: true },
        { name: 'sourceURL', label: 'Source URL', type: 'url', maxLength: 512, wide: true },
        { name: 'details', label: 'Details', type: 'textarea', required: true, maxLength: 2000, wide: true }
    ],
    benchmark_result: []
};

function formatDate(value) {
    return new Intl.DateTimeFormat(navigator.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(value));
}

async function postJSON(path, body) {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return G.checkErrorCodeInURL(response);
}

function humanizeKey(key) {
    return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replaceAll('_', ' ')
        .replace(/^./, character => character.toUpperCase());
}

function formatValue(value, type = '') {
    if (value === null || value === undefined || value === '') {
        return '—';
    }
    if (type === 'date') {
        return formatDate(value);
    }
    if (type === 'boolean') {
        return Number(value) === 1 || value === true ? 'Yes' : 'No';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value, null, 2);
    }
    return String(value);
}

function createInspectButton(label, onClick) {
    const button = document.createElement('button');
    button.className = 'inspect-row-button';
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-magnifying-glass';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    button.addEventListener('click', onClick);
    return button;
}

function createRowActionButton(label, iconName, className, onClick) {
    const button = document.createElement('button');
    button.className = `inspect-row-button ${className}`;
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = document.createElement('i');
    icon.className = iconName;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    button.addEventListener('click', event => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

function renderTableMessage(body, columnCount, message, className) {
    body.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = className;
    cell.colSpan = columnCount;
    cell.textContent = message;
    row.append(cell);
    body.append(row);
}

function normalizeRequestType(type) {
    return type;
}

function isEscalated(log) {
    return log.content?.moderation?.state === 'escalated';
}

function entityChangeTargetName(content) {
    return content.before?.name
        || content.before?.result?.source?.title
        || `${content.targetKind ?? 'object'} #${content.targetID ?? '?'}`;
}

function getHeading(log) {
    const type = normalizeRequestType(log.content.type);
    if (type === 'feedback') {
        return 'BenchPoll feedback';
    }
    if (type === 'new_benchmark' && Array.isArray(log.content.benchmarks)) {
        const firstName = log.content.benchmarks[0]?.name ?? 'benchmark';
        return log.content.benchmarks.length === 1
            ? firstName
            : `${firstName} + ${log.content.benchmarks.length - 1} more`;
    }
    if (type === 'new_model' && Array.isArray(log.content.models)) {
        const firstName = log.content.models[0]?.name ?? 'model';
        return log.content.models.length === 1
            ? firstName
            : `${firstName} + ${log.content.models.length - 1} more`;
    }
    if (type === 'new_category') {
        return log.content.name;
    }
    if (type === 'benchmark_result' && Array.isArray(log.content.results)) {
        const first = log.content.results[0];
        const model = first?.model?.name || (first?.modelID ? `Model #${first.modelID}` : 'model');
        return log.content.results.length === 1
            ? `${model} result`
            : `${model} + ${log.content.results.length - 1} more results`;
    }
    if (type === 'entity_change') {
        const action = log.content.operation === 'delete' ? 'Delete' : 'Change';
        return `${action} ${entityChangeTargetName(log.content)}`;
    }
    return log.content.targetName;
}

function getTypeLabel(type) {
    switch (normalizeRequestType(type)) {
    case 'new_benchmark':
        return 'New Benchmark';
    case 'new_category':
        return 'New Category or Context';
    case 'new_model':
        return 'New Model';
    case 'benchmark_result':
        return 'Benchmark Result';
    case 'feedback':
        return 'Feedback';
    case 'entity_change':
        return 'Object Change';
    default:
        return 'Report';
    }
}

function createField(name, value) {
    if (value === null || value === undefined || value === '') {
        return [];
    }
    const fieldName = document.createElement('div');
    fieldName.className = 'field-name';
    fieldName.textContent = name;
    const fieldValue = document.createElement('div');
    fieldValue.className = 'field-value';
    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
        const link = document.createElement('a');
        link.href = value;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = value;
        fieldValue.append(link);
    } else if (typeof value === 'object') {
        fieldValue.classList.add('json-value');
        fieldValue.textContent = JSON.stringify(value, null, 2);
    } else {
        fieldValue.textContent = String(value);
    }
    return [fieldName, fieldValue];
}

function appendContentFields(fields, log) {
    const type = normalizeRequestType(log.content.type);
    if (type === 'new_benchmark') {
        fields.append(...createField('Batch Size', log.content.benchmarks?.length ?? 0));
        (log.content.benchmarks ?? []).forEach((benchmark, index) => {
            fields.append(...createField(`Benchmark ${index + 1}`, benchmark));
        });
    } else if (type === 'new_model') {
        fields.append(...createField('Model Count', log.content.models?.length ?? 0));
        (log.content.models ?? []).forEach((model, index) => {
            fields.append(...createField(`Model ${index + 1}`, model));
        });
    } else if (type === 'feedback') {
        fields.append(
            ...createField('Page URL', log.content.pageURL),
            ...createField('Feedback', log.content.details)
        );
    } else if (type === 'new_category') {
        fields.append(
            ...createField('Request', log.content.requestKind === 'context' ? 'Add context' : 'Add category'),
            ...createField('Parent Category Path', log.content.parentPath || '(root)'),
            ...createField('Parent Category ID', log.content.parentCategoryID),
            ...createField('Parent Pending Reference', log.content.parentCategoryRef),
            ...createField('Requested Context Order', log.content.contextOrder),
            ...createField('Source Page', log.content.pageURL),
            ...createField('Notes', log.content.details)
        );
    } else if (type === 'benchmark_result') {
        fields.append(
            ...createField('Reviewer Notes', log.content.reviewerNotes),
            ...createField('Result Count', log.content.results?.length ?? 0)
        );
        (log.content.results ?? []).forEach((result, index) => {
            fields.append(...createField(`Result ${index + 1}`, result));
        });
    } else if (type === 'entity_change') {
        const changes = (log.content.changes ?? []).map(change => ({
            field: change.field,
            before: change.before,
            after: change.after
        }));
        fields.append(
            ...createField('Operation', log.content.operation === 'delete' ? 'Delete' : 'Update'),
            ...createField('Target', `${log.content.targetKind} #${log.content.targetID}`),
            ...createField('Object', entityChangeTargetName(log.content)),
            ...createField('Requested Changes', changes),
            ...createField('Reviewer Notes', log.content.reviewNotes)
        );
    } else {
        fields.append(
            ...createField('Issue Type', issueTypeLabels[log.content.issueType] ?? log.content.issueType),
            ...createField('Target Kind', log.content.targetKind),
            ...createField('Target Benchmark ID', log.content.targetBenchmarkID),
            ...createField('Category Path', log.content.categoryPath),
            ...createField('Page URL', log.content.pageURL),
            ...createField('Source URL', log.content.sourceURL),
            ...createField('Details', log.content.details)
        );
    }
    if (isEscalated(log)) {
        fields.append(
            ...createField('Escalated By', log.content.moderation.escalatedBy),
            ...createField('Escalated At', formatDate(log.content.moderation.escalatedAt)),
            ...createField('Moderator Opinion', log.content.moderation.note)
        );
    }
    if (log.content.github) {
        fields.append(
            ...createField('GitHub Issue', log.content.github.issueURL),
            ...createField('GitHub Author', log.content.github.authorLogin),
            ...createField('Last Synced', formatDate(log.content.github.syncedAt))
        );
    }
}

function createActionButton(className, label, iconClass, onClick) {
    const button = document.createElement('button');
    button.className = `action-button ${className}`;
    button.type = 'button';
    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconClass}`;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = label;
    button.append(icon, text);
    button.addEventListener('click', onClick);
    return button;
}

function createLogItem(log) {
    const item = document.createElement('article');
    item.className = 'log-item';

    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'log-title';
    const type = document.createElement('span');
    type.className = 'log-type';
    type.textContent = getTypeLabel(log.content.type);
    const status = document.createElement('span');
    const displayStatus = log.status === 'pending' && isEscalated(log) ? 'escalated' : log.status;
    status.className = `log-status ${displayStatus}`;
    status.textContent = displayStatus;
    const heading = document.createElement('span');
    heading.className = 'log-heading';
    heading.textContent = getHeading(log);
    title.append(type, status, heading);

    const meta = document.createElement('div');
    meta.className = 'log-meta';
    const issueReference = log.content.github?.issueNumber
        ? `GitHub #${log.content.github.issueNumber} · `
        : '';
    meta.textContent = `${issueReference}moderation #${log.ID} by ${log.userName ?? log.content.github?.authorLogin ?? log.user_id} · ${formatDate(log.created_at)}`;

    const fields = document.createElement('div');
    fields.className = 'field-grid';
    appendContentFields(fields, log);
    body.append(title, meta, fields);

    const actions = document.createElement('div');
    actions.className = 'log-actions';
    if (log.status === 'pending') {
        actions.append(createActionButton('preview', 'SQL', 'fa-code', () => previewSQL(log)));
        actions.append(
            createActionButton('edit', 'Edit & Apply', 'fa-pen-to-square', () => openEditor(log))
        );
        if (!isEscalated(log)) {
            actions.append(createActionButton('escalate', 'Escalate', 'fa-arrow-up-right-dots', () => openEscalation(log)));
        }
        actions.append(
            createActionButton('approve', 'Approve', 'fa-check', () => reviewLog(log.ID, 'approved')),
            createActionButton('reject', 'Reject', 'fa-xmark', () => reviewLog(log.ID, 'rejected'))
        );
    }
    actions.append(createActionButton('history', 'History', 'fa-clock-rotate-left', () => openAuditForLog(log.ID)));
    item.append(body, actions);
    return item;
}

function renderLogs(logs) {
    logList.replaceChildren();
    if (logs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No submissions in this queue.';
        logList.append(empty);
        return;
    }
    logs.forEach(log => logList.append(createLogItem(log)));
}

async function loadLogs() {
    logList.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'empty-state';
    loading.textContent = 'Loading contribution queue...';
    logList.append(loading);
    statusFilter.disabled = true;
    try {
        const data = await postJSON('/api/list_moderation_logs', { status: statusFilter.value });
        if (data) {
            renderLogs(data.logs);
        }
    } catch {
        loading.textContent = 'The contribution queue could not be loaded.';
    } finally {
        statusFilter.disabled = false;
    }
}

async function loadAdminCapabilities() {
    reviewerCapabilities = await postJSON('/api/admin_capabilities', {});
    auditAction.querySelectorAll('option').forEach(option => {
        if (['direct_create', 'direct_update', 'direct_delete', 'admin_message'].includes(option.value)) {
            option.hidden = !reviewerCapabilities.isSenior;
            option.disabled = !reviewerCapabilities.isSenior;
        }
    });
    messagesTab.hidden = !(reviewerCapabilities.isSenior && reviewerCapabilities.messagesAvailable);
    composeMessageButton.disabled = !reviewerCapabilities.messagesAvailable;
    if (!reviewerCapabilities.messagesAvailable) {
        composeMessageButton.title = 'Run the admin messages database migration to enable messaging.';
    }
}

function setActiveWorkspaceView(view) {
    if (!Object.hasOwn(workspaceViews, view)) {
        return;
    }
    activeWorkspaceView = view;
    workspaceTabs.forEach(tab => {
        const active = tab.dataset.workspaceView === view;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
    });
    Object.entries(workspaceViews).forEach(([key, panel]) => {
        panel.hidden = key !== view;
    });
    if (view === 'explorer' && !explorerState.loaded) {
        loadExplorer();
    }
    if (view === 'audit' && !auditState.loaded) {
        loadAuditLogs();
    }
    if (view === 'messages' && reviewerCapabilities.isSenior && !messagesLoaded) {
        loadAdminMessages();
    }
}

function populateExplorerEntities(entities) {
    const selected = explorerEntity.value;
    explorerEntity.replaceChildren();
    entities.forEach(entity => {
        const option = document.createElement('option');
        option.value = entity.key;
        option.textContent = entity.label;
        explorerEntity.append(option);
    });
    explorerEntity.value = entities.some(entity => entity.key === selected) ? selected : entities[0]?.key ?? '';
}

const EXPLORER_CONTRIBUTION_FORMS = Object.freeze({
    benchmarks: {
        create: () => '/contribute?mode=new_benchmark',
        update: row => `/contribute?mode=edit_benchmark&targetBenchmarkID=${encodeURIComponent(row.id)}`,
        delete: row => `/contribute?mode=edit_benchmark&targetBenchmarkID=${encodeURIComponent(row.id)}&operation=delete`
    },
    benchmark_conditions: {
        update: row => `/contribute?mode=edit_benchmark&targetBenchmarkID=${encodeURIComponent(row.benchmarkID)}`
    },
    models: {
        create: () => '/contribute?mode=new_model',
        update: row => `/contribute?mode=edit_model&targetModelID=${encodeURIComponent(row.id)}`,
        delete: row => `/contribute?mode=edit_model&targetModelID=${encodeURIComponent(row.id)}&operation=delete`
    },
    model_conditions: {
        update: row => `/contribute?mode=edit_model&targetModelID=${encodeURIComponent(row.modelID)}`
    },
    benchmark_results: {
        create: () => '/contribute?mode=benchmark_result',
        update: row => `/contribute?mode=edit_result&targetResultID=${encodeURIComponent(row.id)}`,
        delete: row => `/contribute?mode=edit_result&targetResultID=${encodeURIComponent(row.id)}&operation=delete`
    },
    categories: {
        create: () => '/contribute?mode=new_category'
    }
});

function explorerContributionURL(operation, row = null) {
    const factory = EXPLORER_CONTRIBUTION_FORMS[explorerEntity.value]?.[operation];
    if (!reviewerCapabilities.isSenior || typeof factory !== 'function') {
        return null;
    }
    const url = factory(row);
    return typeof url === 'string' && url.startsWith('/contribute?') ? url : null;
}

function openContributionForm(operation, row = null) {
    const url = explorerContributionURL(operation, row);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
}

function openRecordDetails(row, label) {
    activeExplorerRow = row;
    recordEyebrow.textContent = label;
    recordTitle.textContent = row.name ?? row.modelName ?? row.benchmarkName ?? `Record #${row.id ?? ''}`;
    recordDetails.replaceChildren();
    Object.entries(row).forEach(([key, value]) => {
        const name = document.createElement('div');
        name.className = 'record-key';
        name.textContent = humanizeKey(key);
        const content = document.createElement('div');
        content.className = 'record-value';
        if (typeof value === 'string' && /^https?:\/\//.test(value)) {
            const link = document.createElement('a');
            link.href = value;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.textContent = value;
            content.append(link);
        } else {
            content.textContent = formatValue(value);
        }
        recordDetails.append(name, content);
    });
    recordEdit.hidden = !explorerContributionURL('update', row);
    recordDelete.hidden = !explorerContributionURL('delete', row);
    recordOverlay.hidden = false;
}

async function openExplorerRecord(summaryRow, label) {
    try {
        const data = await postJSON('/api/admin_data_record', {
            entity: explorerEntity.value,
            id: summaryRow.id
        });
        if (!data?.row) {
            return;
        }
        openRecordDetails(data.row, label);
    } catch (error) {
        await G.showAlert(error?.message
            ?? 'This record could not be loaded. It may have changed or been removed.', {
            title: 'Record unavailable'
        });
    }
}

function renderExplorer(data) {
    populateExplorerEntities(data.entities);
    const createURL = explorerContributionURL('create');
    const formEditing = reviewerCapabilities.isSenior
        && Boolean(EXPLORER_CONTRIBUTION_FORMS[data.entity]);
    explorerAdd.hidden = !createURL;
    explorerAccessLabel.textContent = formEditing ? 'Changes use reviewed forms' : 'Read only';
    explorerAccessMark.title = formEditing
        ? 'Supported changes open the standard contribution form'
        : 'Read-only data access';
    explorerAccessMark.classList.toggle('direct-access', formEditing);
    explorerAccessMark.replaceChildren();
    const accessIcon = document.createElement('i');
    accessIcon.className = formEditing ? 'fa-regular fa-pen-to-square' : 'fa-solid fa-lock';
    accessIcon.setAttribute('aria-hidden', 'true');
    explorerAccessMark.append(accessIcon);
    explorerHead.replaceChildren();
    const headingRow = document.createElement('tr');
    data.columns.forEach(column => {
        const heading = document.createElement('th');
        heading.scope = 'col';
        heading.textContent = column.label;
        headingRow.append(heading);
    });
    const inspectHeading = document.createElement('th');
    inspectHeading.scope = 'col';
    const hiddenLabel = document.createElement('span');
    hiddenLabel.className = 'visually-hidden';
    hiddenLabel.textContent = formEditing ? 'Record actions' : 'Inspect';
    inspectHeading.append(hiddenLabel);
    headingRow.append(inspectHeading);
    explorerHead.append(headingRow);

    explorerBody.replaceChildren();
    if (data.rows.length === 0) {
        renderTableMessage(explorerBody, data.columns.length + 1, 'No matching records.', 'table-empty');
    } else {
        data.rows.forEach(row => {
            const tableRow = document.createElement('tr');
            data.columns.forEach(column => {
                const cell = document.createElement('td');
                const value = formatValue(row[column.key], column.type);
                cell.textContent = value;
                cell.title = value.replaceAll('\n', ' ');
                tableRow.append(cell);
            });
            const inspectCell = document.createElement('td');
            inspectCell.className = 'row-actions-cell';
            inspectCell.append(createInspectButton(
                'Inspect full record',
                () => openExplorerRecord(row, data.label)
            ));
            if (explorerContributionURL('update', row)) {
                inspectCell.append(createRowActionButton(
                    'Open change form in a new tab',
                    'fa-regular fa-pen-to-square',
                    'edit-record-button',
                    () => openContributionForm('update', row)
                ));
            }
            if (explorerContributionURL('delete', row)) {
                inspectCell.append(createRowActionButton(
                    'Open deletion form in a new tab',
                    'fa-regular fa-trash-can',
                    'delete-record-button',
                    () => openContributionForm('delete', row)
                ));
            }
            tableRow.append(inspectCell);
            explorerBody.append(tableRow);
        });
    }

    explorerState.page = data.page;
    explorerState.totalPages = data.totalPages;
    explorerState.loaded = true;
    const first = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
    const last = Math.min(data.total, data.page * data.pageSize);
    explorerSummary.textContent = `${data.label} · showing ${first}–${last} of ${data.total}`;
    explorerPage.textContent = `Page ${data.page} of ${data.totalPages}`;
    explorerPrev.disabled = data.page <= 1;
    explorerNext.disabled = data.page >= data.totalPages;
}

async function loadExplorer() {
    const requestID = ++explorerState.requestID;
    explorerAdd.hidden = true;
    renderTableMessage(explorerBody, Math.max(2, explorerHead.querySelectorAll('th').length), 'Loading records...', 'table-loading');
    explorerSummary.textContent = 'Loading records...';
    try {
        const data = await postJSON('/api/admin_data_explorer', {
            entity: explorerEntity.value || 'benchmarks',
            search: explorerSearch.value,
            page: explorerState.page,
            pageSize: 25
        });
        if (data && requestID === explorerState.requestID) {
            renderExplorer(data);
        }
    } catch {
        if (requestID === explorerState.requestID) {
            renderTableMessage(explorerBody, 2, 'The data explorer could not be loaded.', 'table-empty');
            explorerSummary.textContent = 'Data unavailable';
        }
    }
}

function auditActionLabel(action) {
    return {
        approve: 'Approved',
        edit_and_approve: 'Edited & approved',
        reject: 'Rejected',
        escalate: 'Escalated',
        direct_create: 'Direct create',
        direct_update: 'Direct update',
        direct_delete: 'Direct delete',
        admin_message: 'Admin message'
    }[action] ?? action;
}

async function openAuditDetails(summaryRow) {
    let row;
    try {
        row = await postJSON('/api/get_moderation_audit_log', { ID: Number(summaryRow.ID) });
    } catch {
        await G.showAlert('This audit record could not be loaded.', { title: 'Audit unavailable' });
        return;
    }
    const contributionID = row.moderation_log_ID ?? row.request_before?.moderationLogID ?? null;
    auditDetailTitle.textContent = contributionID === null
        ? `${auditActionLabel(row.action_type)} · ${row.request_summary}`
        : `${auditActionLabel(row.action_type)} · contribution #${contributionID}`;
    auditDetailMeta.textContent = `Audit #${row.ID} · ${row.outcome} · reviewer #${row.reviewer_user_ID} · ${formatDate(row.created_at)} · ${row.duration_ms} ms`;
    auditRequestBefore.textContent = JSON.stringify(row.request_before, null, 2);
    auditRequestAfter.textContent = row.request_after === null
        ? 'No post-action snapshot was recorded.'
        : JSON.stringify(row.request_after, null, 2);
    auditSQL.textContent = row.executed_sql;
    auditResponse.textContent = JSON.stringify(row.database_response, null, 2);
    auditOverlay.hidden = false;
}

function renderAuditLogs(data) {
    auditState.rows = data.rows;
    auditBody.replaceChildren();
    if (data.rows.length === 0) {
        renderTableMessage(auditBody, 7, 'No matching audit records.', 'table-empty');
    } else {
        data.rows.forEach(row => {
            const tableRow = document.createElement('tr');
            const time = document.createElement('td');
            time.textContent = formatDate(row.created_at);
            const reviewer = document.createElement('td');
            reviewer.textContent = `Reviewer #${row.reviewer_user_ID}`;
            const action = document.createElement('td');
            const actionLabel = document.createElement('span');
            actionLabel.className = `audit-action-label ${row.action_type} ${row.outcome}`;
            actionLabel.textContent = row.outcome === 'failure'
                ? `${auditActionLabel(row.action_type)} failed`
                : auditActionLabel(row.action_type);
            action.append(actionLabel);
            const contribution = document.createElement('td');
            const contributionID = row.moderation_log_ID;
            contribution.textContent = contributionID
                ? `#${contributionID} · ${row.request_summary}`
                : row.request_summary;
            contribution.title = `${row.request_type}: ${row.request_summary}`;
            const transition = document.createElement('td');
            const transitionLabel = document.createElement('span');
            transitionLabel.className = 'status-transition';
            transitionLabel.textContent = `${row.status_before} → ${row.status_after}`;
            transition.append(transitionLabel);
            const duration = document.createElement('td');
            duration.textContent = `${row.duration_ms} ms`;
            const inspect = document.createElement('td');
            inspect.append(createInspectButton('Inspect audit details', () => openAuditDetails(row)));
            tableRow.append(time, reviewer, action, contribution, transition, duration, inspect);
            auditBody.append(tableRow);
        });
    }

    auditState.page = data.page;
    auditState.totalPages = data.totalPages;
    auditState.loaded = true;
    const first = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
    const last = Math.min(data.total, data.page * data.pageSize);
    auditSummary.textContent = `Showing ${first}–${last} of ${data.total} audit records`;
    auditPage.textContent = `Page ${data.page} of ${data.totalPages}`;
    auditPrev.disabled = data.page <= 1;
    auditNext.disabled = data.page >= data.totalPages;
}

async function loadAuditLogs() {
    const requestID = ++auditState.requestID;
    renderTableMessage(auditBody, 7, 'Loading audit records...', 'table-loading');
    auditSummary.textContent = 'Loading audit records...';
    const rawLogID = auditLogID.value.trim();
    try {
        const data = await postJSON('/api/list_moderation_audit_logs', {
            actionType: auditAction.value,
            moderationLogID: rawLogID ? Number(rawLogID) : null,
            search: auditSearch.value,
            page: auditState.page,
            pageSize: 25
        });
        if (data && requestID === auditState.requestID) {
            renderAuditLogs(data);
        }
    } catch {
        if (requestID === auditState.requestID) {
            renderTableMessage(auditBody, 7, 'The audit log could not be loaded.', 'table-empty');
            auditSummary.textContent = 'Audit data unavailable';
        }
    }
}

function renderAdminMessages(messages) {
    messageList.replaceChildren();
    const unreadCount = messages.filter(message => !message.isRead).length;
    messageUnreadCount.hidden = unreadCount === 0;
    messageUnreadCount.textContent = String(unreadCount);
    if (messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No messages have been sent to senior reviewers.';
        messageList.append(empty);
        return;
    }
    messages.forEach(message => {
        const article = document.createElement('article');
        article.className = `admin-message${message.isRead ? '' : ' unread'}`;
        const header = document.createElement('div');
        header.className = 'admin-message-header';
        const sender = document.createElement('strong');
        sender.textContent = `Reviewer #${message.senderUserID}`;
        const time = document.createElement('time');
        time.dateTime = new Date(message.createdAt).toISOString();
        time.textContent = formatDate(message.createdAt);
        header.append(sender, time);
        const body = document.createElement('p');
        body.textContent = message.body;
        article.append(header, body);
        if (!message.isRead) {
            const readButton = document.createElement('button');
            readButton.className = 'action-button';
            readButton.type = 'button';
            readButton.textContent = 'Mark as read';
            readButton.addEventListener('click', async () => {
                readButton.disabled = true;
                try {
                    await postJSON('/api/mark_admin_message_read', { messageID: Number(message.ID) });
                    message.isRead = true;
                    renderAdminMessages(messages);
                } finally {
                    readButton.disabled = false;
                }
            });
            article.append(readButton);
        }
        messageList.append(article);
    });
}

async function loadAdminMessages() {
    if (!reviewerCapabilities.isSenior || !reviewerCapabilities.messagesAvailable) {
        return;
    }
    messageList.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'empty-state';
    loading.textContent = 'Loading senior reviewer messages...';
    messageList.append(loading);
    try {
        const data = await postJSON('/api/list_admin_messages', {});
        renderAdminMessages(data.messages);
        messagesLoaded = true;
    } catch {
        loading.textContent = 'Messages could not be loaded.';
    }
}

function openAuditForLog(ID) {
    auditLogID.value = String(ID);
    auditState.page = 1;
    auditState.loaded = false;
    if (activeWorkspaceView === 'audit') {
        loadAuditLogs();
    } else {
        setActiveWorkspaceView('audit');
    }
}

async function reviewLog(ID, status) {
    const action = status === 'approved' ? 'apply this request to the database' : 'reject this request';
    const confirmed = await G.showConfirm(`This will ${action}.`, {
        title: status === 'approved' ? 'Approve contribution?' : 'Reject contribution?',
        confirmLabel: status === 'approved' ? 'Approve' : 'Reject',
        tone: status === 'approved' ? 'default' : 'danger'
    });
    if (!confirmed) {
        return;
    }
    fetch('/api/review_moderation_log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ID, status })
    })
    .then(handleModerationResponse)
    .then(async data => {
        if (data !== undefined) {
            await showModerationEmailStatus(data.emailNotification);
            auditState.loaded = false;
            loadLogs();
        }
    });
}

function handleModerationResponse(response) {
    if (response.status === 409) {
        return response.json().then(async data => {
            await G.showAlert(`The request could not be completed: ${data.error ?? 'data conflict'}.`, {
                title: 'Request conflict'
            });
        });
    }
    return G.checkErrorCodeInURL(response);
}

async function showModerationEmailStatus(notification) {
    if (!notification) {
        return;
    }
    if (!notification.recipientAvailable) {
        await G.showAlert('The review was saved, but this older submission has no verified email address to notify.', {
            title: 'Email notification unavailable'
        });
        return;
    }
    if (!notification.deliveryConfigured) {
        await G.showAlert('The review was saved and its email is queued. Configure BenchPoll SMTP delivery to send queued notifications.', {
            title: 'Email queued'
        });
    }
}

function closeOverlay(overlay) {
    overlay.hidden = true;
}

function stripModerationMetadata(content) {
    const copy = { ...content };
    delete copy.moderation;
    copy.type = normalizeRequestType(copy.type);
    return copy;
}

function createEditorControl(definition, value) {
    let input;
    if (definition.type === 'textarea') {
        input = document.createElement('textarea');
    } else if (definition.type === 'select') {
        input = document.createElement('select');
        definition.options.forEach(([optionValue, optionLabel]) => {
            const option = document.createElement('option');
            option.value = optionValue;
            option.textContent = optionLabel;
            input.append(option);
        });
    } else {
        input = document.createElement('input');
        input.type = definition.type;
    }
    input.name = definition.name;
    input.required = Boolean(definition.required);
    if (definition.maxLength) {
        input.maxLength = definition.maxLength;
    }
    if (definition.min !== undefined) {
        input.min = String(definition.min);
    }
    if (definition.step !== undefined) {
        input.step = String(definition.step);
    }
    if (definition.type === 'checkbox') {
        input.checked = Boolean(value);
    } else {
        input.value = value ?? '';
    }
    return input;
}

function renderEditorFields() {
    const type = editorType.value;
    const draft = editorDrafts[type] ?? {
        schemaVersion: 3,
        type,
        ...(type === 'new_benchmark' ? { benchmarks: [] } : {}),
        ...(type === 'new_model' ? { models: [] } : {}),
        ...(type === 'benchmark_result' ? { reviewerNotes: '', results: [] } : {})
    };
    editorFields.replaceChildren();
    activeEditorUsesJSON = Number(draft.schemaVersion) >= 3
        || ['new_benchmark', 'new_model', 'benchmark_result'].includes(type);
    if (activeEditorUsesJSON) {
        const label = document.createElement('label');
        label.className = 'editor-field wide';
        const caption = document.createElement('span');
        caption.textContent = 'Request JSON (all nested fields are editable)';
        const input = document.createElement('textarea');
        input.name = 'contentJSON';
        input.required = true;
        input.spellcheck = false;
        input.value = JSON.stringify(draft, null, 2);
        label.append(caption, input);
        editorFields.append(label);
        return;
    }
    requestFields[type].forEach(definition => {
        const label = document.createElement('label');
        label.className = `editor-field${definition.wide ? ' wide' : ''}${definition.type === 'checkbox' ? ' checkbox' : ''}`;
        const caption = document.createElement('span');
        caption.textContent = definition.label;
        const input = createEditorControl(definition, draft[definition.name]);
        if (definition.type === 'checkbox') {
            label.append(input, caption);
        } else {
            label.append(caption, input);
        }
        editorFields.append(label);
    });
}

function collectEditorContent(type = editorType.value) {
    const jsonInput = editorFields.querySelector('[name="contentJSON"]');
    if (jsonInput) {
        const content = JSON.parse(jsonInput.value);
        content.type = normalizeRequestType(content.type);
        return content;
    }
    const schemaVersion = Number(editorDrafts[type]?.schemaVersion);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
        throw new Error('The moderation request schema version is missing.');
    }
    const content = { schemaVersion, type };
    requestFields[type].forEach(definition => {
        const input = editorFields.querySelector(`[name="${definition.name}"]`);
        content[definition.name] = definition.type === 'checkbox' ? input.checked : input.value.trim();
    });
    return content;
}

function openEditor(log) {
    activeEditorLog = log;
    activeEditorPreviewToken = null;
    activeEditorPreviewFingerprint = null;
    const initialContent = stripModerationMetadata(log.content);
    activeEditorType = initialContent.type;
    editorDrafts = { [initialContent.type]: initialContent };
    editorType.value = initialContent.type;
    renderEditorFields();
    editorOverlay.hidden = false;
    editorType.focus();
}

function openEscalation(log) {
    activeEscalationLog = log;
    escalateNote.value = '';
    escalateOverlay.hidden = false;
    escalateNote.focus();
}

function editorContentFingerprint(content) {
    return JSON.stringify(content);
}

function invalidateEditorPreview() {
    activeEditorPreviewToken = null;
    activeEditorPreviewFingerprint = null;
}

function previewSQL(log, content) {
    sqlPreview.textContent = 'Generating SQL preview...';
    sqlOverlay.hidden = false;
    const body = { ID: log.ID };
    if (content !== undefined) {
        body.content = content;
    }
    return fetch('/api/preview_moderation_sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    .then(handleModerationResponse)
    .then(data => {
        if (data?.sql) {
            sqlPreview.textContent = data.sql;
        }
        if (content !== undefined && activeEditorLog?.ID === log.ID) {
            activeEditorPreviewToken = data?.previewToken ?? null;
            activeEditorPreviewFingerprint = activeEditorPreviewToken
                ? editorContentFingerprint(content)
                : null;
        }
        return data;
    });
}

editorType.addEventListener('change', async () => {
    if (activeEditorType) {
        try {
            editorDrafts[activeEditorType] = collectEditorContent(activeEditorType);
        } catch {
            await G.showAlert('The request JSON must be valid before changing request type.', {
                title: 'Invalid request JSON'
            });
            editorType.value = activeEditorType;
            return;
        }
    }
    activeEditorType = editorType.value;
    renderEditorFields();
});

editorPreview.addEventListener('click', async () => {
    if (editorForm.reportValidity() && activeEditorLog) {
        try {
            const content = collectEditorContent();
            await previewSQL(activeEditorLog, content);
        } catch (error) {
            invalidateEditorPreview();
            await G.showAlert(error instanceof SyntaxError
                ? 'The request JSON is not valid.'
                : 'The SQL preview could not be generated.', {
                title: error instanceof SyntaxError
                    ? 'Invalid request JSON'
                    : 'Preview failed'
            });
        }
    }
});

editorFields.addEventListener('input', invalidateEditorPreview);
editorFields.addEventListener('change', invalidateEditorPreview);

editorForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!activeEditorLog || !editorForm.reportValidity()) {
        return;
    }
    let editedContent;
    try {
        editedContent = collectEditorContent();
    } catch {
        await G.showAlert('The request JSON is not valid.', {
            title: 'Invalid request JSON'
        });
        return;
    }
    if (!activeEditorPreviewToken
        || activeEditorPreviewFingerprint !== editorContentFingerprint(editedContent)) {
        await G.showAlert('Preview the SQL execution plan after your latest edit before applying it.', {
            title: 'Fresh preview required'
        });
        return;
    }
    const confirmed = await G.showConfirm('The edited request will be applied to the database and marked as approved.', {
        title: 'Apply edited request?',
        confirmLabel: 'Apply request'
    });
    if (!confirmed) {
        return;
    }
    const submitButton = editorForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    fetch('/api/apply_moderation_log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ID: activeEditorLog.ID,
            content: editedContent,
            previewToken: activeEditorPreviewToken
        })
    })
    .then(handleModerationResponse)
    .then(async data => {
        if (data?.status === 'approved') {
            await showModerationEmailStatus(data.emailNotification);
            auditState.loaded = false;
            closeOverlay(editorOverlay);
            loadLogs();
        }
    })
    .finally(() => {
        submitButton.disabled = false;
    });
});

escalateForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!activeEscalationLog || !escalateForm.reportValidity()) {
        return;
    }
    const submitButton = escalateForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    fetch('/api/escalate_moderation_log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ID: activeEscalationLog.ID, note: escalateNote.value.trim() })
    })
    .then(handleModerationResponse)
    .then(data => {
        if (data?.status === 'escalated') {
            auditState.loaded = false;
            closeOverlay(escalateOverlay);
            statusFilter.value = 'escalated';
            loadLogs();
        }
    })
    .finally(() => {
        submitButton.disabled = false;
    });
});

document.querySelectorAll('[data-close-overlay]').forEach(button => {
    button.addEventListener('click', () => closeOverlay(document.getElementById(button.dataset.closeOverlay)));
});

document.querySelectorAll('.moderation-overlay').forEach(overlay => {
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeOverlay(overlay);
        }
    });
});

workspaceTabs.forEach(tab => {
    tab.addEventListener('click', () => setActiveWorkspaceView(tab.dataset.workspaceView));
    tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) {
            return;
        }
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const availableTabs = workspaceTabs.filter(candidate => !candidate.hidden);
        const index = availableTabs.indexOf(tab);
        const nextTab = availableTabs[(index + direction + availableTabs.length) % availableTabs.length];
        setActiveWorkspaceView(nextTab.dataset.workspaceView);
        nextTab.focus();
    });
});

explorerFilter.addEventListener('submit', event => {
    event.preventDefault();
    explorerState.page = 1;
    loadExplorer();
});

explorerAdd.addEventListener('click', () => openContributionForm('create'));
recordEdit.addEventListener('click', () => {
    closeOverlay(recordOverlay);
    openContributionForm('update', activeExplorerRow);
});
recordDelete.addEventListener('click', () => {
    closeOverlay(recordOverlay);
    openContributionForm('delete', activeExplorerRow);
});

explorerEntity.addEventListener('change', () => {
    explorerState.page = 1;
    loadExplorer();
});

explorerPrev.addEventListener('click', () => {
    if (explorerState.page > 1) {
        explorerState.page -= 1;
        loadExplorer();
    }
});

explorerNext.addEventListener('click', () => {
    if (explorerState.page < explorerState.totalPages) {
        explorerState.page += 1;
        loadExplorer();
    }
});

auditFilter.addEventListener('submit', event => {
    event.preventDefault();
    if (!auditFilter.reportValidity()) {
        return;
    }
    auditState.page = 1;
    loadAuditLogs();
});

auditPrev.addEventListener('click', () => {
    if (auditState.page > 1) {
        auditState.page -= 1;
        loadAuditLogs();
    }
});

auditNext.addEventListener('click', () => {
    if (auditState.page < auditState.totalPages) {
        auditState.page += 1;
        loadAuditLogs();
    }
});

composeMessageButton.addEventListener('click', () => {
    if (!reviewerCapabilities.messagesAvailable) {
        return;
    }
    messageComposeBody.value = '';
    messageComposeOverlay.hidden = false;
    messageComposeBody.focus();
});

messageComposeForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!messageComposeForm.reportValidity()) {
        return;
    }
    const submitButton = messageComposeForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
        await postJSON('/api/send_admin_message', { body: messageComposeBody.value.trim() });
        closeOverlay(messageComposeOverlay);
        auditState.loaded = false;
        messagesLoaded = false;
        if (activeWorkspaceView === 'messages') {
            await loadAdminMessages();
        }
    } finally {
        submitButton.disabled = false;
    }
});

messagesRefresh.addEventListener('click', () => {
    messagesLoaded = false;
    loadAdminMessages();
});

statusFilter.addEventListener('change', loadLogs);

async function initializeModerationWorkspace() {
    try {
        await loadAdminCapabilities();
    } catch {
        composeMessageButton.disabled = true;
    }
    setActiveWorkspaceView('queue');
    await loadLogs();
}

initializeModerationWorkspace();
