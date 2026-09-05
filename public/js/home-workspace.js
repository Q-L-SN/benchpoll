const SVG_NS = 'http://www.w3.org/2000/svg';
const SAVE_DEBOUNCE_MS = 420;
const WEIGHT_STEP_BASIS_POINTS = 200;
const MIN_WEIGHT_BASIS_POINTS = 100;
const WHEEL_WEIGHT_COMMIT_IDLE_MS = 400;
const PIE_WEIGHT_TRANSITION_MS = 210;
const TOUCH_DRAG_THRESHOLD_PX = 4;
const TOUCH_WEIGHT_BASIS_POINTS_PER_PIXEL = 12;
const WORKSPACE_LOAD_RETRY_DELAYS_MS = [500, 1200];
const FALLBACK_RULE_MODE = 'fallback_if_missing';
const MAX_FALLBACK_COMPONENTS = 12;

const pieSvg = document.getElementById('weight-pie');
const breadcrumb = document.getElementById('bp-breadcrumb');
const templateStrip = document.getElementById('bp-template-strip');
const benchmarkRows = document.getElementById('benchmark-rows');
const benchmarkSearch = document.getElementById('benchmark-search');
const benchmarkPersonalPin = document.getElementById('benchmark-personal-pin');
const modelRows = document.getElementById('model-rows');
const modeSwitch = document.querySelector('.bp-mode-switch');
const personalModeButton = document.getElementById('pie-mode-personal');
const publicModeButton = document.getElementById('pie-mode-public');
const personalPieCreate = document.getElementById('personal-pie-create');
const personalEmptyMode = document.getElementById('personal-empty-mode');
const personalEmptyPublicReturn = document.getElementById('personal-empty-public-return');
const pieInstruction = document.getElementById('pie-instruction');
const pieContextNote = document.getElementById('pie-context-note');
const undoButton = document.getElementById('workspace-undo');
const refreshButton = document.getElementById('workspace-refresh');
const lastUpdated = document.getElementById('last-updated');
const missionBanner = document.getElementById('mission-banner');
const missionDismiss = document.getElementById('mission-dismiss');
const termsButton = document.getElementById('terms-button');
const termsDialog = document.getElementById('terms-dialog');
const loginButton = document.getElementById('login-button');
const contributeDataButton = document.getElementById('contribute-data-button');
const contributeEvaluationButton = document.getElementById('contribute-button');
const modelScoresDialog = document.getElementById('model-scores-dialog');
const modelScoresTitle = document.getElementById('model-scores-title');
const modelScoresSummary = document.getElementById('model-scores-summary');
const modelScoresList = document.getElementById('model-scores-list');
const benchmarkCard = document.getElementById('benchmark-card');
const modelCard = document.getElementById('model-card');
const leftWorkspace = document.querySelector('.bp-left-workspace');
const pieHomeSlot = document.getElementById('pie-home-slot');
const pieCard = document.getElementById('pie-card');
const rightWorkspace = document.getElementById('right-workspace');
const benchmarkSummaryCard = document.getElementById('benchmark-summary-card');
const benchmarkSummaryContent = document.getElementById('benchmark-summary-content');
const benchmarkLeaderboardOpen = document.getElementById('benchmark-leaderboard-open');
const benchmarkLeaderboardClose = document.getElementById('benchmark-leaderboard-close');
const inlineFallback = document.getElementById('inline-fallback');
const inlineFallbackPersonalControl = document.getElementById('inline-fallback-personal-control');
const inlineFallbackEnabled = document.getElementById('inline-fallback-enabled');
const publicFallbackToggle = document.getElementById('public-fallback-toggle');
const inlineFallbackRemove = document.getElementById('inline-fallback-remove');
const inlineFallbackGuide = document.getElementById('inline-fallback-guide');
const inlineFallbackChart = document.getElementById('inline-fallback-chart');

const PIE_GRADIENTS = [
    ['#b7acf4', '#8170e4'],
    ['#a7c9f4', '#6d9fe7'],
    ['#a1dfdb', '#65c6c3'],
    ['#fae99a', '#f4ce60'],
    ['#ffd49d', '#f4ad65'],
    ['#f7beda', '#e989bc'],
    ['#c7b8ef', '#9a7bd8'],
    ['#b6ddd2', '#77bfae']
];

const state = {
    categoryID: null,
    categoryPath: '',
    selectedContextValues: {},
    dimensions: [],
    mode: 'public',
    pinPersonalBenchmarks: false,
    workspaceView: 'overview',
    selectedObjectID: null,
    authenticated: false,
    personalRevision: 0,
    personalIsDraft: true,
    personalEntries: [],
    personalFallbackRules: [],
    publicEntries: [],
    publicFallbackRules: [],
    publicParticipantCount: 0,
    publicIsFallback: false,
    benchmarks: [],
    modelLeaderboards: { personal: [], public: [] },
    scoreScale: { min: 0, max: 100, higherIsBetter: true },
    limits: { totalBasisPoints: 10000, maxPieItems: 24 },
    undoSnapshot: null,
    serverPersonalEntries: [],
    serverPersonalFallbackRules: [],
    saveTimer: null,
    gestureTimer: null,
    gestureOpen: false,
    gestureSnapshot: null,
    pieContextFingerprint: '',
    pieOrderByObjectID: new Map(),
    nextPieOrder: 0,
    visualPieWeights: new Map(),
    visualPieEntries: new Map(),
    pieAnimationFrame: null,
    saving: false,
    savePromise: null,
    persistPromise: null,
    loadSequence: 0,
    loading: false,
    lastLoadTime: Date.now(),
    statusMessage: ''
};
let touchPieGesture = null;
let pendingWheelBasisPoints = 0;
let wheelWeightCommitTimer = null;
let wheelPreviewFrame = null;
let modelScoresRequestSequence = 0;
let selectedFallbackPrimaryID = null;
let selectedFallbackComponentID = null;
let fallbackDraftPrimaryID = null;
let fallbackTargetPrimaryID = null;
let expandedPublicFallbackPrimaryID = null;
let selectedPublicFallbackComponentID = null;
let pendingFallbackWheelBasisPoints = 0;
let fallbackWheelCommitTimer = null;
let fallbackWheelPreviewFrame = null;
let touchFallbackGesture = null;

function cloneEntries(entries) {
    return entries.map(entry => ({ ...entry }));
}

function cloneFallbackRules(rules) {
    return rules.map(rule => ({
        ...rule,
        entries: rule.entries.map(entry => ({ ...entry }))
    }));
}

function snapshotPersonalPie() {
    return {
        entries: cloneEntries(state.personalEntries),
        fallbackRules: cloneFallbackRules(state.personalFallbackRules)
    };
}

function clonePersonalPieSnapshot(snapshot) {
    return {
        entries: cloneEntries(snapshot?.entries ?? []),
        fallbackRules: cloneFallbackRules(snapshot?.fallbackRules ?? [])
    };
}

function restorePersonalPieSnapshot(snapshot) {
    const restored = clonePersonalPieSnapshot(snapshot);
    state.personalEntries = restored.entries;
    state.personalFallbackRules = restored.fallbackRules;
}

function invalidWorkspaceResponse(path, message) {
    const error = new Error(`Invalid workspace response: ${path} ${message}`);
    error.code = 'invalid_workspace_response';
    // A response-shape error is deterministic and must not enter the network retry loop.
    error.status = 422;
    return error;
}

function requireWorkspaceObject(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidWorkspaceResponse(path, 'must be an object');
    }
    return value;
}

function requireWorkspaceArray(value, path) {
    if (!Array.isArray(value)) {
        throw invalidWorkspaceResponse(path, 'must be an array');
    }
    return value;
}

function requireWorkspaceConditionIdentity(value, path) {
    const current = requireWorkspaceObject(value, path);
    if (typeof current.conditionKey !== 'string' || current.conditionKey.trim() === '') {
        throw invalidWorkspaceResponse(`${path}.conditionKey`, 'must be a non-empty string');
    }
    if (typeof current.conditionName !== 'string' || current.conditionName.trim() === '') {
        throw invalidWorkspaceResponse(`${path}.conditionName`, 'must be a non-empty string');
    }
    if (typeof current.isDefaultCondition !== 'boolean') {
        throw invalidWorkspaceResponse(`${path}.isDefaultCondition`, 'must be a boolean');
    }
    const literalDefault = current.conditionName.trim().toLocaleLowerCase('en-US') === 'default';
    if (current.isDefaultCondition !== literalDefault
        || (current.conditionKey === 'default') !== literalDefault) {
        throw invalidWorkspaceResponse(path, 'has inconsistent default-condition identity');
    }
    return current;
}

function validateWorkspaceFallbackRules(value, pieEntries, piePath) {
    const rulesPath = `${piePath}.fallbackRules`;
    const rules = requireWorkspaceArray(value, rulesPath);
    const pieConditionIDs = new Set(pieEntries.map(entry => Number(entry.conditionID)));
    const primaryIDs = new Set();
    rules.forEach((valueRule, ruleIndex) => {
        const path = `${rulesPath}[${ruleIndex}]`;
        const rule = requireWorkspaceObject(valueRule, path);
        const primaryConditionID = Number(rule.primaryConditionID);
        if (!Number.isSafeInteger(primaryConditionID)
            || !pieConditionIDs.has(primaryConditionID)
            || primaryIDs.has(primaryConditionID)
            || rule.mode !== FALLBACK_RULE_MODE) {
            throw invalidWorkspaceResponse(path, 'has an invalid primary or mode');
        }
        primaryIDs.add(primaryConditionID);
        const componentIDs = new Set();
        let totalBasisPoints = 0;
        const entries = requireWorkspaceArray(rule.entries, `${path}.entries`);
        if (entries.length === 0 || entries.length > MAX_FALLBACK_COMPONENTS) {
            throw invalidWorkspaceResponse(`${path}.entries`, 'has an invalid size');
        }
        entries.forEach((valueEntry, entryIndex) => {
            const entryPath = `${path}.entries[${entryIndex}]`;
            const entry = requireWorkspaceConditionIdentity(valueEntry, entryPath);
            const conditionID = Number(entry.conditionID);
            const weightBasisPoints = Number(entry.weightBasisPoints);
            if (!Number.isSafeInteger(conditionID)
                || conditionID < 1
                || conditionID === primaryConditionID
                || componentIDs.has(conditionID)
                || !Number.isSafeInteger(weightBasisPoints)
                || weightBasisPoints < MIN_WEIGHT_BASIS_POINTS
                || weightBasisPoints > 10000) {
                throw invalidWorkspaceResponse(entryPath, 'has an invalid condition or weight');
            }
            componentIDs.add(conditionID);
            totalBasisPoints += weightBasisPoints;
        });
        if (totalBasisPoints !== 10000) {
            throw invalidWorkspaceResponse(`${path}.entries`, 'must total 100 percent');
        }
    });
    return rules;
}

function validateWorkspacePayload(payload) {
    const response = requireWorkspaceObject(payload, 'response');
    const context = requireWorkspaceObject(response.context, 'context');
    const dimensions = requireWorkspaceArray(context.dimensions, 'context.dimensions');
    dimensions.forEach((dimension, index) => {
        const current = requireWorkspaceObject(dimension, `context.dimensions[${index}]`);
        requireWorkspaceArray(current.options, `context.dimensions[${index}].options`);
    });
    const personalPie = requireWorkspaceObject(response.personalPie, 'personalPie');
    const personalEntries = requireWorkspaceArray(personalPie.entries, 'personalPie.entries');
    personalEntries.forEach((entry, index) => {
        requireWorkspaceConditionIdentity(entry, `personalPie.entries[${index}]`);
    });
    validateWorkspaceFallbackRules(personalPie.fallbackRules, personalEntries, 'personalPie');
    const publicPie = requireWorkspaceObject(response.publicPie, 'publicPie');
    const publicEntries = requireWorkspaceArray(publicPie.entries, 'publicPie.entries');
    publicEntries.forEach((entry, index) => {
        requireWorkspaceConditionIdentity(entry, `publicPie.entries[${index}]`);
    });
    validateWorkspaceFallbackRules(publicPie.fallbackRules, publicEntries, 'publicPie');
    requireWorkspaceArray(response.benchmarks, 'benchmarks').forEach((entry, index) => {
        requireWorkspaceConditionIdentity(entry, `benchmarks[${index}]`);
    });
    const modelLeaderboards = requireWorkspaceObject(response.modelLeaderboards, 'modelLeaderboards');
    requireWorkspaceArray(modelLeaderboards.personal, 'modelLeaderboards.personal');
    requireWorkspaceArray(modelLeaderboards.public, 'modelLeaderboards.public');
    return response;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function humanizePathPart(part) {
    let decoded = String(part ?? '');
    try {
        decoded = decodeURIComponent(decoded.replace(/\+/g, ' '));
    } catch {
        // Keep the original text when a legacy path contains an incomplete escape.
    }
    return decoded.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

function selectedObjectIndex(entries = currentPieEntries()) {
    return entries.findIndex(entry => Number(entry.conditionID) === Number(state.selectedObjectID));
}

function currentPieEntries() {
    return state.mode === 'personal' ? state.personalEntries : state.publicEntries;
}

function workspaceContextFingerprint(categoryID = state.categoryID, contextValues = state.selectedContextValues) {
    const normalizedContextValues = Object.entries(contextValues ?? {})
        .sort(([left], [right]) => left.localeCompare(right));
    return `${categoryID ?? ''}:${JSON.stringify(normalizedContextValues)}`;
}

function resetPieVisualState() {
    if (state.pieAnimationFrame !== null) {
        cancelAnimationFrame(state.pieAnimationFrame);
    }
    state.pieAnimationFrame = null;
    state.pieOrderByObjectID.clear();
    state.nextPieOrder = 0;
    state.visualPieWeights.clear();
    state.visualPieEntries.clear();
    pieCard?.classList.remove('is-adjusting-weight');
    inlineFallback?.classList.remove('is-adjusting-weight');
    selectedFallbackPrimaryID = null;
    selectedFallbackComponentID = null;
    fallbackDraftPrimaryID = null;
    fallbackTargetPrimaryID = null;
    expandedPublicFallbackPrimaryID = null;
    selectedPublicFallbackComponentID = null;
}

function setPieAdjustmentActive(active) {
    pieCard?.classList.toggle('is-adjusting-weight', Boolean(active));
}

function setFallbackAdjustmentActive(active) {
    inlineFallback?.classList.toggle('is-adjusting-weight', Boolean(active));
}

function registerPieEntries(entries) {
    entries.forEach(entry => {
        const objectID = Number(entry.conditionID);
        if (!state.pieOrderByObjectID.has(objectID)) {
            state.pieOrderByObjectID.set(objectID, state.nextPieOrder);
            state.nextPieOrder += 1;
        }
    });
}

function orderedPieEntries(entries) {
    registerPieEntries(entries);
    return [...entries].sort((left, right) => {
        const leftOrder = state.pieOrderByObjectID.get(Number(left.conditionID));
        const rightOrder = state.pieOrderByObjectID.get(Number(right.conditionID));
        return leftOrder - rightOrder;
    });
}

function contextValuesFromURL() {
    const params = new URLSearchParams(window.location.search);
    const values = {};
    for (const [key, value] of params.entries()) {
        if (key.startsWith('context_') && value.trim() !== '') {
            values[key.slice('context_'.length)] = value.trim();
        }
    }
    return values;
}

function contextValuesForDimensions(dimensions, values = contextValuesFromURL()) {
    const dimensionKeys = new Set(dimensions.map(dimension => String(dimension.key)));
    return Object.fromEntries(
        Object.entries(values).filter(([key]) => dimensionKeys.has(key))
    );
}

function sameContextValues(left = {}, right = {}) {
    const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function syncContextValuesToURL() {
    const url = new URL(window.location.href);
    Array.from(url.searchParams.keys())
        .filter(key => key.startsWith('context_'))
        .forEach(key => url.searchParams.delete(key));
    Object.entries(state.selectedContextValues).forEach(([key, value]) => {
        url.searchParams.set(`context_${key}`, value);
    });
    window.history.replaceState(window.history.state, '', url);
}

async function postJSON(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    let payload = null;
    if (response.status !== 204) {
        const contentType = response.headers.get('content-type') ?? '';
        payload = contentType.includes('application/json') ? await response.json() : null;
    }
    if (!response.ok) {
        const error = new Error(payload?.error || `Request failed with status ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    return payload;
}

function setStatus(message = '') {
    state.statusMessage = message;
    updateLastUpdated();
}

function updateLastUpdated() {
    if (state.statusMessage) {
        lastUpdated.textContent = state.statusMessage;
        return;
    }
    const elapsedMinutes = Math.max(0, Math.floor((Date.now() - state.lastLoadTime) / 60000));
    lastUpdated.textContent = elapsedMinutes === 0
        ? 'Last updated just now'
        : `Last updated ${elapsedMinutes}m ago`;
}

function renderBreadcrumb() {
    breadcrumb.replaceChildren();
    const pathParts = String(state.categoryPath || '')
        .split('/')
        .filter(Boolean);
    const displayParts = pathParts.map(humanizePathPart);
    const rootOffset = displayParts.length > 1 ? 1 : 0;
    const visibleParts = displayParts.length > 0
        ? displayParts.slice(rootOffset)
        : ['All Categories'];
    visibleParts.forEach((part, index) => {
        const isCurrent = index === visibleParts.length - 1;
        const node = document.createElement(isCurrent ? 'span' : 'a');
        node.textContent = part;
        if (isCurrent) node.className = 'bp-breadcrumb-current';
        if (!isCurrent) {
            const path = pathParts
                .slice(0, rootOffset + index + 1)
                .map(segment => encodeURIComponent(segment))
                .join('/');
            node.href = `/rankings/${path}`;
        }
        breadcrumb.append(node);
        if (!isCurrent) {
            const separator = document.createElement('i');
            separator.className = 'fa-solid fa-chevron-right';
            separator.setAttribute('aria-hidden', 'true');
            breadcrumb.append(separator);
        }
    });
}

function templateValueClass(option) {
    if (option?.isNeutral) {
        return 'bp-template-neutral';
    }
    if (/disallowed/i.test(option?.name ?? '')) {
        return 'bp-template-negative';
    }
    return 'bp-template-positive';
}

function renderTemplateControls() {
    templateStrip.replaceChildren();
    const hasTemplateDimensions = state.dimensions.length > 0;
    templateStrip.hidden = !hasTemplateDimensions;
    document.body.classList.toggle('bp-no-template-context', !hasTemplateDimensions);

    if (!hasTemplateDimensions) {
        return;
    }

    state.dimensions.forEach(dimension => {
        const selected = dimension.options.find(option => option.key === dimension.selectedKey)
            ?? dimension.options[0];
        const picker = document.createElement('div');
        picker.className = 'bp-template-picker';
        picker.dataset.templateKey = dimension.key;
        const control = document.createElement('button');
        control.className = 'bp-template-control';
        control.type = 'button';
        control.dataset.templateKey = dimension.key;
        control.setAttribute('aria-haspopup', 'listbox');
        control.setAttribute('aria-expanded', 'false');
        control.setAttribute('aria-label', `${dimension.name}: ${selected?.name ?? 'Not specified'}. Hover to view options.`);
        const name = document.createElement('span');
        name.textContent = dimension.name;
        const value = document.createElement('strong');
        value.className = `bp-template-value ${templateValueClass(selected)}`;
        value.textContent = selected?.name ?? 'Not specified';
        control.append(name, value);

        const menu = document.createElement('div');
        menu.className = 'bp-template-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', dimension.name);

        let closeTimer = null;
        const openMenu = () => {
            if (dimension.options.length < 2) {
                return;
            }
            window.clearTimeout(closeTimer);
            closeTimer = null;
            picker.dataset.open = 'true';
            control.setAttribute('aria-expanded', 'true');
        };
        const closeMenu = () => {
            window.clearTimeout(closeTimer);
            closeTimer = null;
            delete picker.dataset.open;
            control.setAttribute('aria-expanded', 'false');
        };
        const scheduleMenuClose = () => {
            window.clearTimeout(closeTimer);
            closeTimer = window.setTimeout(closeMenu, 140);
        };

        dimension.options.forEach(option => {
            const choice = document.createElement('button');
            const isSelected = option.key === selected?.key;
            choice.className = 'bp-template-choice';
            choice.type = 'button';
            choice.setAttribute('role', 'option');
            choice.setAttribute('aria-selected', String(isSelected));
            choice.dataset.selected = String(isSelected);
            choice.textContent = option.name;
            choice.addEventListener('click', async event => {
                event.stopPropagation();
                if (state.loading || isSelected) {
                    closeMenu();
                    return;
                }
                closeMenu();
                if (!await finishPendingWeightAdjustments()) return;
                if (state.saving && state.savePromise) {
                    await state.savePromise.catch(() => {});
                }
                if (!await flushPendingPersonalPieSave()) {
                    return;
                }
                state.selectedContextValues = {
                    ...state.selectedContextValues,
                    [dimension.key]: option.key
                };
                state.workspaceView = 'overview';
                await loadWeightedWorkspace();
            });
            menu.append(choice);
        });

        picker.addEventListener('pointerenter', event => {
            if (event.pointerType !== 'touch') {
                openMenu();
            }
        });
        picker.addEventListener('pointerleave', event => {
            if (event.pointerType !== 'touch') {
                scheduleMenuClose();
            }
        });
        picker.addEventListener('focusin', openMenu);
        picker.addEventListener('focusout', () => {
            requestAnimationFrame(() => {
                if (!picker.contains(document.activeElement)) {
                    closeMenu();
                }
            });
        });
        control.addEventListener('click', event => {
            event.stopPropagation();
            if (window.matchMedia('(hover: none)').matches) {
                if (picker.dataset.open === 'true') {
                    closeMenu();
                } else {
                    openMenu();
                }
            } else {
                openMenu();
            }
        });
        control.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                closeMenu();
                control.focus();
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                openMenu();
                menu.querySelector('[aria-selected="true"]')?.focus();
            }
        });
        menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                closeMenu();
                control.focus();
            }
        });

        picker.append(control, menu);
        templateStrip.append(picker);
    });
}

function polarToCartesian(cx, cy, radius, angle) {
    const radians = (angle - 90) * Math.PI / 180;
    return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function describeArc(cx, cy, radius, startAngle, endAngle) {
    if (endAngle - startAngle >= 359.999) {
        const start = polarToCartesian(cx, cy, radius, startAngle);
        const opposite = polarToCartesian(cx, cy, radius, startAngle + 180);
        return [
            `M ${start.x} ${start.y}`,
            `A ${radius} ${radius} 0 1 0 ${opposite.x} ${opposite.y}`,
            `A ${radius} ${radius} 0 1 0 ${start.x} ${start.y}`,
            'Z'
        ].join(' ');
    }
    const start = polarToCartesian(cx, cy, radius, endAngle);
    const end = polarToCartesian(cx, cy, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
    return [
        `M ${cx} ${cy}`,
        `L ${start.x} ${start.y}`,
        `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
        'Z'
    ].join(' ');
}

function splitPieLabel(label) {
    const words = String(label).trim().split(/\s+/).filter(Boolean);
    if (words.length <= 1) {
        return [words[0] || 'Other'];
    }
    if (words.length === 2) {
        return words;
    }
    const midpoint = Math.ceil(words.length / 2);
    return [words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' ')];
}

function benchmarkConditionLabel(object) {
    if (!object) {
        return '';
    }
    const conditionName = String(object.conditionName ?? '').trim();
    return conditionName.toLocaleLowerCase('en-US') === 'default' ? '' : conditionName;
}

function benchmarkAccessibleName(object) {
    if (!object) {
        return '';
    }
    const conditionLabel = benchmarkConditionLabel(object);
    return conditionLabel ? `${object.name}, ${conditionLabel}` : object.name;
}

function createSvgElement(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    return element;
}

function drawPie(entries) {
    if (entries.length === 0) {
        pieSvg.replaceChildren();
        const empty = createSvgElement('text', { x: 180, y: 180, class: 'bp-pie-empty' });
        empty.textContent = state.mode === 'personal'
            ? 'Choose a benchmark on the right to begin'
            : 'No public weights yet';
        pieSvg.append(empty);
        return;
    }

    pieSvg.querySelector('.bp-pie-empty')?.remove();
    if (selectedObjectIndex(entries) < 0) {
        state.selectedObjectID = entries[0].conditionID;
    }
    let defs = pieSvg.querySelector(':scope > defs[data-pie-defs]');
    if (!defs) {
        defs = createSvgElement('defs', { 'data-pie-defs': '' });
        pieSvg.prepend(defs);
    }
    const desiredIDs = new Set(entries.map(entry => Number(entry.conditionID)));
    pieSvg.querySelectorAll(':scope > g[data-object-id]').forEach(group => {
        if (!desiredIDs.has(Number(group.dataset.objectId))) {
            group.remove();
        }
    });
    defs.querySelectorAll('linearGradient[data-object-id]').forEach(gradient => {
        if (!desiredIDs.has(Number(gradient.dataset.objectId))) {
            gradient.remove();
        }
    });

    entries.forEach((entry, index) => {
        const objectID = Number(entry.conditionID);
        const colorIndex = state.pieOrderByObjectID.get(Number(entry.conditionID)) ?? index;
        const [startColor, endColor] = PIE_GRADIENTS[colorIndex % PIE_GRADIENTS.length];
        let gradient = defs.querySelector(`linearGradient[data-object-id="${objectID}"]`);
        if (!gradient) {
            gradient = createSvgElement('linearGradient', {
                id: `bp-pie-gradient-${objectID}`,
                'data-object-id': objectID,
                x1: '0%', y1: '0%', x2: '100%', y2: '100%'
            });
            gradient.append(
                createSvgElement('stop', { offset: '0%', 'stop-color': startColor }),
                createSvgElement('stop', { offset: '100%', 'stop-color': endColor })
            );
            defs.append(gradient);
        }
    });

    const cx = 180;
    const cy = 180;
    const radius = 160;
    let startAngle = 7;
    entries.forEach((entry, index) => {
        const weight = Number(entry.weightBasisPoints) / state.limits.totalBasisPoints;
        const angle = weight * 360;
        const endAngle = startAngle + angle;
        const middleAngle = startAngle + angle / 2;
        const selected = Number(state.selectedObjectID) === Number(entry.conditionID);
        const objectID = Number(entry.conditionID);
        let group = pieSvg.querySelector(`:scope > g[data-object-id="${objectID}"]`);
        if (!group) {
            group = createSvgElement('g', {
                role: 'button',
                tabindex: '0',
                'data-object-id': objectID
            });
            const liftLayer = createSvgElement('g', { class: 'bp-pie-slice-lift' });
            const slice = createSvgElement('path', { class: 'bp-pie-slice' });
            liftLayer.append(slice);
            group.append(liftLayer);
            const select = async () => {
                if (!await finishPendingWeightAdjustments()) return;
                deactivateInlineFallbackTarget({ discardDraft: true });
                expandedPublicFallbackPrimaryID = null;
                selectedPublicFallbackComponentID = null;
                state.selectedObjectID = Number(group.dataset.objectId);
                renderPie();
                renderBenchmarks();
                renderBenchmarkSummary();
            };
            group.addEventListener('mousedown', event => event.preventDefault());
            group.addEventListener('click', () => void select());
            group.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void select();
                }
            });
            pieSvg.append(group);
        }
        const hasFallback = state.mode === 'personal'
            ? Boolean(fallbackRuleFor(objectID))
            : Boolean(publicFallbackRuleFor(objectID));
        group.setAttribute(
            'aria-label',
            `${benchmarkAccessibleName(entry)}: ${entry.weight.toFixed(2)}%${hasFallback ? '. Fallback enabled' : ''}`
        );
        const liftLayer = group.querySelector('.bp-pie-slice-lift');
        const slice = group.querySelector('.bp-pie-slice');
        slice.setAttribute('d', describeArc(cx, cy, radius, startAngle, endAngle));
        slice.setAttribute('fill', `url(#bp-pie-gradient-${objectID})`);
        slice.classList.toggle('selected', selected);

        if (entry.weight >= 7) {
            const labelPoint = polarToCartesian(cx, cy, radius * (entry.weight >= 24 ? 0.57 : 0.7), middleAngle);
            let text = group.querySelector('.bp-pie-label');
            const labelLines = splitPieLabel(entry.name).slice(0, 2);
            const conditionLabel = benchmarkConditionLabel(entry);
            const labelKey = [...labelLines, conditionLabel, hasFallback ? 'fallback' : ''].join('\n');
            if (!text || text.dataset.labelKey !== labelKey) {
                text?.remove();
                text = createSvgElement('text', { class: 'bp-pie-label' });
                text.dataset.labelKey = labelKey;
                labelLines.forEach(line => {
                    const tspan = createSvgElement('tspan', { 'data-label-line': '' });
                    tspan.textContent = line.length > 18 ? `${line.slice(0, 16)}…` : line;
                    text.append(tspan);
                });
                if (hasFallback) {
                    const fallbackIcon = createSvgElement('tspan', {
                        class: 'bp-pie-fallback-icon',
                        dx: '4',
                        'aria-hidden': 'true'
                    });
                    fallbackIcon.textContent = '\uf126';
                    text.append(fallbackIcon);
                }
                if (conditionLabel) {
                    const condition = createSvgElement('tspan', {
                        class: 'bp-pie-condition',
                        'data-label-condition': ''
                    });
                    condition.textContent = conditionLabel.length > 18
                        ? `${conditionLabel.slice(0, 16)}…`
                        : conditionLabel;
                    text.append(condition);
                }
                text.append(createSvgElement('tspan', { 'data-label-percent': '' }));
                liftLayer.append(text);
            }
            text.setAttribute('x', labelPoint.x);
            const contentLineCount = labelLines.length + (conditionLabel ? 1 : 0);
            text.setAttribute('y', labelPoint.y - Math.max(7, (contentLineCount - 1) * 8));
            text.querySelectorAll('[data-label-line]').forEach((line, lineIndex) => {
                line.setAttribute('x', labelPoint.x);
                line.setAttribute('dy', lineIndex === 0 ? 0 : 17);
            });
            const condition = text.querySelector('[data-label-condition]');
            if (condition) {
                condition.setAttribute('x', labelPoint.x);
                condition.setAttribute('dy', 17);
            }
            const percentage = text.querySelector('[data-label-percent]');
            percentage.setAttribute('x', labelPoint.x);
            percentage.setAttribute('dy', 18);
            percentage.textContent = `${Math.round(entry.weight)}%`;
        } else {
            group.querySelector('.bp-pie-label')?.remove();
        }
        startAngle = endAngle;
    });
    const selectedGroup = pieSvg.querySelector(`:scope > g[data-object-id="${Number(state.selectedObjectID)}"]`);
    if (selectedGroup) {
        pieSvg.append(selectedGroup);
    }
    pieSvg.setAttribute('aria-label', state.mode === 'personal'
        ? 'Personal benchmark weights'
        : 'Public benchmark weights');
}

function renderPie({ animateWeights = false } = {}) {
    const entries = orderedPieEntries(currentPieEntries());
    if (selectedObjectIndex(entries) < 0) {
        state.selectedObjectID = entries[0]?.conditionID ?? null;
    }
    renderInlineFallback();

    const targetWeights = new Map(entries.map(entry => [
        Number(entry.conditionID),
        Number(entry.weightBasisPoints)
    ]));
    const canAnimate = animateWeights
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        && state.visualPieWeights.size > 0;

    if (!canAnimate) {
        if (state.pieAnimationFrame !== null) {
            cancelAnimationFrame(state.pieAnimationFrame);
            state.pieAnimationFrame = null;
        }
        state.visualPieWeights = targetWeights;
        state.visualPieEntries = new Map(entries.map(entry => [Number(entry.conditionID), { ...entry }]));
        drawPie(entries);
        return;
    }

    const animationEntryMap = new Map(state.visualPieEntries);
    entries.forEach(entry => animationEntryMap.set(Number(entry.conditionID), { ...entry }));
    const animationEntries = orderedPieEntries(Array.from(animationEntryMap.values()));
    const startWeights = new Map(animationEntries.map(entry => {
        const objectID = Number(entry.conditionID);
        return [objectID, Number(state.visualPieWeights.get(objectID) ?? 0)];
    }));
    const animationTargetWeights = new Map(animationEntries.map(entry => {
        const objectID = Number(entry.conditionID);
        return [objectID, Number(targetWeights.get(objectID) ?? 0)];
    }));
    if (state.pieAnimationFrame !== null) {
        cancelAnimationFrame(state.pieAnimationFrame);
    }
    const startedAt = performance.now();
    const animateFrame = now => {
        const progress = clamp((now - startedAt) / PIE_WEIGHT_TRANSITION_MS, 0, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const frameEntries = animationEntries.map(entry => {
            const objectID = Number(entry.conditionID);
            const start = startWeights.get(objectID);
            const target = animationTargetWeights.get(objectID);
            const weightBasisPoints = start + ((target - start) * eased);
            return {
                ...entry,
                weightBasisPoints,
                weight: weightBasisPoints / 100
            };
        });
        state.visualPieWeights = new Map(frameEntries.map(entry => [
            Number(entry.conditionID),
            Number(entry.weightBasisPoints)
        ]));
        state.visualPieEntries = new Map(frameEntries.map(entry => [Number(entry.conditionID), { ...entry }]));
        drawPie(frameEntries);
        if (progress < 1) {
            state.pieAnimationFrame = requestAnimationFrame(animateFrame);
        } else {
            state.pieAnimationFrame = null;
            state.visualPieWeights = targetWeights;
            state.visualPieEntries = new Map(entries.map(entry => [Number(entry.conditionID), { ...entry }]));
            drawPie(entries);
        }
    };
    state.pieAnimationFrame = requestAnimationFrame(animateFrame);
}

function distributeToTarget(entries, target, minimum = MIN_WEIGHT_BASIS_POINTS) {
    if (entries.length === 0) {
        return [];
    }
    const minimumTotal = entries.length * minimum;
    const normalizedTarget = Math.max(minimumTotal, Math.round(target));
    const distributable = normalizedTarget - minimumTotal;
    const raw = entries.map(entry => Math.max(0, Number(entry.weightBasisPoints) - minimum));
    const rawTotal = raw.reduce((sum, value) => sum + value, 0);
    const exact = raw.map(value => distributable * (rawTotal > 0 ? value / rawTotal : 1 / entries.length));
    const floors = exact.map(Math.floor);
    let remaining = distributable - floors.reduce((sum, value) => sum + value, 0);
    exact
        .map((value, index) => ({ index, fraction: value - floors[index] }))
        .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index))
        .forEach(item => {
            if (remaining > 0) {
                floors[item.index] += 1;
                remaining -= 1;
            }
        });
    return entries.map((entry, index) => ({
        ...entry,
        weightBasisPoints: minimum + floors[index],
        weight: (minimum + floors[index]) / 100
    }));
}

function updateUndoState() {
    undoButton.disabled = !state.authenticated
        || state.saving
        || state.gestureOpen
        || wheelWeightCommitTimer !== null
        || fallbackWheelCommitTimer !== null
        || !state.undoSnapshot;
}

function requestLogin() {
    loginButton?.click();
}

function beginMutation(isGesture = false) {
    if (!state.authenticated) {
        requestLogin();
        return false;
    }
    if (state.saving || state.loading) {
        return false;
    }
    if (isGesture) {
        let gestureStarted = false;
        if (!state.gestureOpen) {
            state.gestureOpen = true;
            state.gestureSnapshot = snapshotPersonalPie();
            gestureStarted = true;
        }
        window.clearTimeout(state.gestureTimer);
        state.gestureTimer = null;
        if (gestureStarted) {
            updateUndoState();
        }
    } else {
        if (state.gestureOpen) {
            return false;
        }
        state.undoSnapshot = snapshotPersonalPie();
        updateUndoState();
    }
    return true;
}

function finishWeightGesture({ persist = true } = {}) {
    if (!state.gestureOpen) {
        setPieAdjustmentActive(false);
        setFallbackAdjustmentActive(false);
        return state.persistPromise ?? Promise.resolve(true);
    }
    window.clearTimeout(state.gestureTimer);
    state.gestureTimer = null;
    state.gestureOpen = false;
    setPieAdjustmentActive(false);
    setFallbackAdjustmentActive(false);
    if (state.gestureSnapshot) {
        state.undoSnapshot = clonePersonalPieSnapshot(state.gestureSnapshot);
    }
    state.gestureSnapshot = null;
    renderInlineFallback();
    renderBenchmarks();
    renderModels();
    updateUndoState();
    return persist ? persistPersonalPie() : Promise.resolve(true);
}

async function finishPendingWeightAdjustments() {
    if (fallbackWheelCommitTimer !== null && !await commitPendingFallbackWheelAdjustment()) {
        return false;
    }
    if (wheelWeightCommitTimer !== null && !await commitPendingWheelAdjustment()) {
        return false;
    }
    if (state.gestureOpen && !await finishWeightGesture()) {
        return false;
    }
    return true;
}

function scheduleSave() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
        state.saveTimer = null;
        void persistPersonalPie();
    }, SAVE_DEBOUNCE_MS);
}

async function flushPendingPersonalPieSave() {
    let saved = true;
    if (state.saveTimer !== null) {
        window.clearTimeout(state.saveTimer);
        state.saveTimer = null;
        saved = await persistPersonalPie();
    }
    if (state.persistPromise) {
        saved = (await state.persistPromise) && saved;
    }
    return saved;
}

function adjustSelectedWeight(deltaBasisPoints, { animateWeights = true } = {}) {
    if (state.mode !== 'personal' || state.personalEntries.length === 0) {
        return;
    }
    const selectedIndex = selectedObjectIndex(state.personalEntries);
    if (selectedIndex < 0) {
        return;
    }
    const entries = cloneEntries(state.personalEntries);
    const selected = entries[selectedIndex];
    const others = entries.filter((_, index) => index !== selectedIndex);
    const minimum = others.length === 0
        ? state.limits.totalBasisPoints
        : MIN_WEIGHT_BASIS_POINTS;
    const maximum = state.limits.totalBasisPoints - (others.length * MIN_WEIGHT_BASIS_POINTS);
    const selectedWeight = clamp(
        selected.weightBasisPoints + deltaBasisPoints,
        minimum,
        maximum
    );
    if (selectedWeight === selected.weightBasisPoints || !beginMutation(true)) {
        return;
    }
    const redistributed = distributeToTarget(
        others,
        state.limits.totalBasisPoints - selectedWeight
    );
    selected.weightBasisPoints = selectedWeight;
    selected.weight = selectedWeight / 100;
    const redistributedByID = new Map(redistributed.map(entry => [Number(entry.conditionID), entry]));
    state.personalEntries = entries.map((entry, index) => (
        index === selectedIndex ? selected : redistributedByID.get(Number(entry.conditionID))
    ));
    renderPie({ animateWeights });
    renderBenchmarkSummary();
}

function commitPendingWheelAdjustment() {
    window.clearTimeout(wheelWeightCommitTimer);
    wheelWeightCommitTimer = null;
    if (wheelPreviewFrame !== null) {
        cancelAnimationFrame(wheelPreviewFrame);
        wheelPreviewFrame = null;
    }
    const deltaBasisPoints = Math.round(pendingWheelBasisPoints);
    pendingWheelBasisPoints = 0;
    if (deltaBasisPoints !== 0) {
        adjustSelectedWeight(deltaBasisPoints, { animateWeights: false });
    }
    renderBenchmarks();
    updateUndoState();
    return finishWeightGesture();
}

function scheduleWheelPreview() {
    if (wheelPreviewFrame !== null) {
        return;
    }
    wheelPreviewFrame = requestAnimationFrame(() => {
        wheelPreviewFrame = null;
        const deltaBasisPoints = Math.round(pendingWheelBasisPoints);
        pendingWheelBasisPoints = 0;
        if (deltaBasisPoints !== 0) {
            adjustSelectedWeight(deltaBasisPoints);
        }
    });
}

function objectTypeLabel(type) {
    const normalized = String(type ?? 'benchmark').toLowerCase();
    if (normalized === 'arena') return 'Arena';
    if (normalized === 'protocol') return 'Protocol';
    if (normalized === 'other') return 'Other Benchmark';
    return 'Benchmark';
}

const WORKSPACE_VIEWS = new Set(['overview', 'leaderboard', 'focus']);

function selectedBenchmark() {
    return state.benchmarks.find(object => Number(object.ID) === Number(state.selectedObjectID)) ?? null;
}

function benchmarkSummaryTags(object) {
    if (!object) {
        return [];
    }
    const tags = Array.isArray(object.tags) && object.tags.length > 0
        ? [...object.tags]
        : [objectTypeLabel(object.type)];
    return tags.slice(0, 4);
}

function renderBenchmarkSummary() {
    benchmarkSummaryContent.replaceChildren();
    const object = selectedBenchmark();
    if (!object) {
        const empty = document.createElement('div');
        empty.className = 'bp-benchmark-summary-empty';
        empty.innerHTML = '<strong>No benchmark selected</strong><span>Select a weight slice to inspect its benchmark.</span>';
        benchmarkSummaryContent.append(empty);
        return;
    }

    const identity = document.createElement('div');
    identity.className = 'bp-benchmark-summary-identity';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'bp-benchmark-summary-eyebrow';
    eyebrow.textContent = 'Selected benchmark';
    const title = document.createElement('span');
    title.className = 'bp-benchmark-summary-title';
    const name = document.createElement('strong');
    name.textContent = object.name;
    title.append(name);
    const conditionLabel = benchmarkConditionLabel(object);
    if (conditionLabel) {
        const condition = document.createElement('span');
        condition.className = 'bp-benchmark-condition';
        condition.textContent = conditionLabel;
        title.append(condition);
    }
    const tags = document.createElement('span');
    tags.className = 'bp-benchmark-summary-tags';
    benchmarkSummaryTags(object).forEach(label => {
        const tag = document.createElement('span');
        tag.textContent = label;
        tags.append(tag);
    });
    identity.append(eyebrow, title, tags);

    const metric = document.createElement('div');
    metric.className = 'bp-benchmark-summary-metric';
    const label = document.createElement('span');
    label.textContent = state.mode === 'personal' ? 'Personal weight' : 'Public weight';
    const value = document.createElement('strong');
    const selectedEntry = currentPieEntries().find(entry => Number(entry.conditionID) === Number(object.ID));
    const weight = selectedEntry?.weight ?? (state.mode === 'personal' ? object.personalWeight : object.publicWeight);
    value.textContent = weight === null || weight === undefined
        ? 'Not added'
        : `${Number(weight).toFixed(2)}%`;
    metric.append(label, value);
    benchmarkSummaryContent.append(identity, metric);
}

function applyWorkspaceView({ animate = false } = {}) {
    const update = () => {
        const focus = state.workspaceView === 'focus';
        if (pieCard.parentElement !== pieHomeSlot) {
            pieHomeSlot.append(pieCard);
        }
        pieCard.hidden = false;
        benchmarkSummaryCard.hidden = true;
        benchmarkCard.hidden = false;
        modelCard.hidden = false;
        leftWorkspace.dataset.workspaceView = state.workspaceView;
        rightWorkspace.dataset.workspaceView = state.workspaceView;
    };
    if (animate
        && typeof document.startViewTransition === 'function'
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(update);
    } else {
        update();
    }
}

function setWorkspaceView(view, { animate = true } = {}) {
    if (!WORKSPACE_VIEWS.has(view)) {
        throw new TypeError(`Unsupported workspace view: ${view}`);
    }
    state.workspaceView = view;
    applyWorkspaceView({ animate });
    renderModeState();
    renderBenchmarks();
    renderBenchmarkSummary();
}

function contributionEditURL(mode, values) {
    const url = new URL('/contribute', window.location.origin);
    url.searchParams.set('mode', mode);
    Object.entries(values).forEach(([key, value]) => {
        if (value !== null && value !== undefined && String(value) !== '') {
            url.searchParams.set(key, String(value));
        }
    });
    url.searchParams.set('pageURL', window.location.href);
    return url.pathname + url.search;
}

function buildBenchmarkEditURL(object) {
    return contributionEditURL('edit_benchmark', {
        targetBenchmarkID: object.benchmarkID,
        targetConditionID: object.ID
    });
}

function buildModelEditURL(model) {
    return contributionEditURL('edit_model', {
        targetModelID: model.modelID,
        targetConditionID: model.ID
    });
}

function buildResultEditURL(result) {
    return contributionEditURL('edit_result', { targetResultID: result.ID });
}

function invalidModelScoresResponse(path, message) {
    const error = new Error(`Invalid model-score response: ${path} ${message}`);
    error.code = 'invalid_model_scores_response';
    error.status = 422;
    return error;
}

function requireModelScoresObject(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidModelScoresResponse(path, 'must be an object');
    }
    return value;
}

function requireModelScoresArray(value, path) {
    if (!Array.isArray(value)) {
        throw invalidModelScoresResponse(path, 'must be an array');
    }
    return value;
}

function requireModelScoresNumber(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidModelScoresResponse(path, 'must be a finite number');
    }
    return value;
}

function validateApprovedModelResultsPayload(payload) {
    const response = requireModelScoresObject(payload, 'response');
    const model = requireModelScoresObject(response.model, 'model');
    requireModelScoresNumber(model.modelID, 'model.modelID');
    requireModelScoresNumber(model.modelConditionID, 'model.modelConditionID');
    if (typeof model.modelName !== 'string'
        || typeof model.vendorName !== 'string'
        || typeof model.modelConditionName !== 'string') {
        throw invalidModelScoresResponse('model', 'must include vendor, model, and condition names');
    }
    const scoreGroups = requireModelScoresArray(response.scoreGroups, 'scoreGroups');
    scoreGroups.forEach((groupValue, groupIndex) => {
        const group = requireModelScoresObject(groupValue, `scoreGroups[${groupIndex}]`);
        requireModelScoresNumber(group.benchmarkConditionID, `scoreGroups[${groupIndex}].benchmarkConditionID`);
        requireModelScoresNumber(group.medianRawScore, `scoreGroups[${groupIndex}].medianRawScore`);
        requireModelScoresNumber(group.medianNormalizedScore, `scoreGroups[${groupIndex}].medianNormalizedScore`);
        if (typeof group.benchmarkName !== 'string' || typeof group.benchmarkConditionName !== 'string') {
            throw invalidModelScoresResponse(`scoreGroups[${groupIndex}]`, 'must include benchmark and condition names');
        }
        const samples = requireModelScoresArray(group.samples, `scoreGroups[${groupIndex}].samples`);
        if (samples.length === 0 || group.sampleCount !== samples.length) {
            throw invalidModelScoresResponse(`scoreGroups[${groupIndex}].sampleCount`, 'must match a non-empty samples array');
        }
        samples.forEach((sampleValue, sampleIndex) => {
            const sample = requireModelScoresObject(sampleValue, `scoreGroups[${groupIndex}].samples[${sampleIndex}]`);
            requireModelScoresNumber(sample.ID, `scoreGroups[${groupIndex}].samples[${sampleIndex}].ID`);
            requireModelScoresNumber(sample.rawScore, `scoreGroups[${groupIndex}].samples[${sampleIndex}].rawScore`);
            requireModelScoresNumber(sample.normalizedScore, `scoreGroups[${groupIndex}].samples[${sampleIndex}].normalizedScore`);
            if (typeof sample.sourceURL !== 'string' || sample.sourceURL.trim() === '') {
                throw invalidModelScoresResponse(`scoreGroups[${groupIndex}].samples[${sampleIndex}].sourceURL`, 'must be a non-empty string');
            }
        });
    });
    return response;
}

function approvedResultScore(rawScore, usesPercentageScale) {
    const numericValue = Number(rawScore);
    const displayValue = String(Number(numericValue.toFixed(usesPercentageScale ? 1 : 3)));
    return `${displayValue}${usesPercentageScale ? '%' : ''}`;
}

function approvedResultSourceLabel(sample) {
    if (typeof sample.sourceTitle === 'string' && sample.sourceTitle.trim()) {
        return sample.sourceTitle.trim();
    }
    try {
        return new URL(sample.sourceURL).hostname.replace(/^www\./, '');
    } catch {
        return 'Source';
    }
}

function approvedResultDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        return '';
    }
    return new Intl.DateTimeFormat('en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    }).format(date);
}

function renderApprovedModelResults(payload) {
    modelScoresTitle.textContent = `${payload.model.modelName} · approved scores`;
    const sampleCount = payload.scoreGroups.reduce((total, group) => total + group.sampleCount, 0);
    modelScoresSummary.replaceChildren();
    const vendor = document.createElement('span');
    vendor.textContent = payload.model.vendorName;
    const condition = document.createElement('span');
    condition.className = 'bp-model-scores-condition';
    const conditionLabel = document.createElement('small');
    conditionLabel.textContent = 'Model condition';
    const conditionName = document.createElement('strong');
    conditionName.textContent = payload.model.modelConditionName;
    condition.append(conditionLabel, conditionName);
    const count = document.createElement('span');
    count.textContent = `${payload.scoreGroups.length} benchmark ${payload.scoreGroups.length === 1 ? 'condition' : 'conditions'} · ${sampleCount} accepted source ${sampleCount === 1 ? 'score' : 'scores'}`;
    modelScoresSummary.append(vendor, condition, count);
    modelScoresList.replaceChildren();
    if (payload.scoreGroups.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'bp-model-scores-empty';
        empty.textContent = 'No approved scores are available for this model condition.';
        modelScoresList.append(empty);
        return;
    }
    payload.scoreGroups.forEach(group => {
        const row = document.createElement('article');
        row.className = 'bp-model-score-detail-row';
        const heading = document.createElement('header');
        heading.className = 'bp-model-score-detail-heading';
        const identity = document.createElement('div');
        identity.className = 'bp-model-score-detail-identity';
        const benchmarkTitle = document.createElement('div');
        benchmarkTitle.className = 'bp-model-score-detail-benchmark';
        const name = document.createElement('strong');
        name.textContent = group.benchmarkName;
        benchmarkTitle.append(name);
        const benchmarkCondition = document.createElement('span');
        benchmarkCondition.className = 'bp-benchmark-condition';
        benchmarkCondition.textContent = group.benchmarkConditionIsDefault
            ? 'Default benchmark condition'
            : group.benchmarkConditionName;
        benchmarkTitle.append(benchmarkCondition);
        const sampleDescription = document.createElement('small');
        sampleDescription.textContent = group.sampleCount === 1
            ? '1 accepted source score'
            : `Median of ${group.sampleCount} accepted source scores`;
        identity.append(benchmarkTitle, sampleDescription);

        const aggregate = document.createElement('div');
        aggregate.className = 'bp-model-score-aggregate';
        const aggregateLabel = document.createElement('small');
        aggregateLabel.textContent = group.sampleCount === 1 ? 'Reported score' : 'Reported median';
        const aggregateValue = document.createElement('strong');
        aggregateValue.className = 'bp-model-score-detail-value';
        aggregateValue.textContent = approvedResultScore(group.medianRawScore, group.usesPercentageScale);
        const normalized = document.createElement('span');
        normalized.textContent = `Ranking value ${Number(group.medianNormalizedScore).toFixed(2)} / 100`;
        aggregate.append(aggregateLabel, aggregateValue, normalized);
        heading.append(identity, aggregate);

        const samples = document.createElement('div');
        samples.className = 'bp-model-score-samples';
        group.samples.forEach((sample, index) => {
            const sampleRow = document.createElement('div');
            sampleRow.className = 'bp-model-score-sample';
            const sampleIndex = document.createElement('span');
            sampleIndex.className = 'bp-model-score-sample-index';
            sampleIndex.textContent = String(index + 1);
            const sampleScore = document.createElement('strong');
            sampleScore.className = 'bp-model-score-sample-value';
            sampleScore.textContent = approvedResultScore(sample.rawScore, group.usesPercentageScale);
            const source = document.createElement('a');
            source.className = 'bp-model-score-source';
            source.href = sample.sourceURL;
            source.target = '_blank';
            source.rel = 'noopener';
            source.title = sample.sourceURL;
            source.setAttribute('aria-label', `Open source for ${group.benchmarkName}`);
            const sourceLabel = document.createElement('span');
            sourceLabel.textContent = approvedResultSourceLabel(sample);
            const sourceDate = document.createElement('small');
            sourceDate.textContent = approvedResultDate(sample.createdAt);
            source.append(sourceLabel, sourceDate, document.createElement('i'));
            source.lastElementChild.className = 'fa-solid fa-arrow-up-right-from-square';
            source.lastElementChild.setAttribute('aria-hidden', 'true');
            const normalizedSample = document.createElement('span');
            normalizedSample.className = 'bp-model-score-sample-normalized';
            normalizedSample.textContent = `${Number(sample.normalizedScore).toFixed(2)} / 100`;
            const edit = document.createElement('a');
            edit.className = 'bp-row-edit-action bp-benchmark-edit';
            edit.href = buildResultEditURL(sample);
            edit.title = 'Change approved score';
            edit.setAttribute('aria-label', `Change source score ${index + 1} for ${group.benchmarkName}`);
            edit.innerHTML = '<i class="fa-solid fa-pencil" aria-hidden="true"></i>';
            edit.hidden = !state.authenticated;
            sampleRow.append(sampleIndex, sampleScore, source, normalizedSample, edit);
            samples.append(sampleRow);
        });
        row.append(heading, samples);
        modelScoresList.append(row);
    });
}

async function openApprovedModelResults(model) {
    const requestSequence = ++modelScoresRequestSequence;
    modelScoresTitle.textContent = `${model.name} · approved scores`;
    modelScoresSummary.textContent = 'Loading approved scores…';
    modelScoresList.replaceChildren();
    modelScoresDialog.hidden = false;
    try {
        const payload = validateApprovedModelResultsPayload(await postJSON('/api/get_approved_benchmark_results', {
            modelID: Number(model.modelID),
            modelConditionID: Number(model.ID)
        }));
        if (requestSequence !== modelScoresRequestSequence) return;
        if (payload.model.modelID !== Number(model.modelID)
            || payload.model.modelConditionID !== Number(model.ID)) {
            throw invalidModelScoresResponse('model', 'does not match the requested model condition');
        }
        renderApprovedModelResults(payload);
    } catch (error) {
        if (requestSequence !== modelScoresRequestSequence) return;
        modelScoresSummary.textContent = 'Approved scores could not be loaded.';
        const message = document.createElement('p');
        message.className = 'bp-model-scores-empty';
        message.textContent = error?.payload?.error ?? 'Try again after refreshing the workspace.';
        modelScoresList.replaceChildren(message);
    }
}

function fallbackRuleFor(primaryConditionID) {
    return state.personalFallbackRules.find(rule => (
        Number(rule.primaryConditionID) === Number(primaryConditionID)
    )) ?? null;
}

function publicFallbackRuleFor(primaryConditionID) {
    return state.publicFallbackRules.find(rule => (
        Number(rule.primaryConditionID) === Number(primaryConditionID)
    )) ?? null;
}

function fallbackIsEnabledFor(primaryConditionID) {
    return Boolean(fallbackRuleFor(primaryConditionID))
        || Number(fallbackDraftPrimaryID) === Number(primaryConditionID);
}

function selectedInlineFallbackPrimary() {
    if (!state.authenticated || state.mode !== 'personal') {
        return null;
    }
    const primary = selectedBenchmark();
    if (!primary || !state.personalEntries.some(entry => (
        Number(entry.conditionID) === Number(primary.ID)
    ))) {
        return null;
    }
    return primary;
}

function selectedPublicFallbackPrimary() {
    if (state.mode !== 'public') {
        return null;
    }
    const primary = selectedBenchmark();
    if (!primary || !state.publicEntries.some(entry => (
        Number(entry.conditionID) === Number(primary.ID)
    ))) {
        return null;
    }
    return primary;
}

function isInlineFallbackTargetActive() {
    const primary = selectedInlineFallbackPrimary();
    return Boolean(primary)
        && fallbackIsEnabledFor(primary.ID)
        && Number(fallbackTargetPrimaryID) === Number(primary.ID);
}

function deactivateInlineFallbackTarget({ discardDraft = false } = {}) {
    fallbackTargetPrimaryID = null;
    selectedFallbackPrimaryID = null;
    selectedFallbackComponentID = null;
    if (discardDraft) {
        fallbackDraftPrimaryID = null;
    }
    inlineFallback?.classList.remove('is-target-active');
    benchmarkCard?.classList.remove('is-fallback-target-active');
}

function activateInlineFallbackTarget(preferredComponentID = null) {
    const primary = selectedInlineFallbackPrimary();
    if (!primary || !fallbackIsEnabledFor(primary.ID) || state.loading || state.saving) {
        return false;
    }
    const rule = fallbackRuleFor(primary.ID);
    const componentIDs = new Set((rule?.entries ?? []).map(entry => Number(entry.conditionID)));
    fallbackTargetPrimaryID = Number(primary.ID);
    selectedFallbackPrimaryID = Number(primary.ID);
    selectedFallbackComponentID = componentIDs.has(Number(preferredComponentID))
        ? Number(preferredComponentID)
        : rule?.entries[0]?.conditionID ?? null;
    if (state.workspaceView === 'focus') {
        state.workspaceView = 'leaderboard';
        applyWorkspaceView({ animate: true });
        renderModeState();
    }
    renderInlineFallback();
    renderBenchmarks();
    return true;
}

function renderInlineFallback() {
    if (!inlineFallback
        || !inlineFallbackPersonalControl
        || !inlineFallbackEnabled
        || !publicFallbackToggle
        || !inlineFallbackRemove
        || !inlineFallbackGuide
        || !inlineFallbackChart) {
        return;
    }
    const personal = state.mode === 'personal';
    const primary = personal ? selectedInlineFallbackPrimary() : selectedPublicFallbackPrimary();
    const primaryConditionID = Number(primary?.ID);
    const personalRule = primary && personal ? fallbackRuleFor(primaryConditionID) : null;
    const publicRule = primary && !personal ? publicFallbackRuleFor(primaryConditionID) : null;
    const enabled = Boolean(primary) && personal && fallbackIsEnabledFor(primaryConditionID);
    const publicExpanded = Boolean(publicRule)
        && Number(expandedPublicFallbackPrimaryID) === primaryConditionID;
    const visible = Boolean(primary) && (personal || Boolean(publicRule));
    inlineFallback.hidden = !visible;
    pieCard?.classList.toggle('has-inline-fallback', visible);
    inlineFallback.classList.toggle('is-readonly', !personal);
    inlineFallbackPersonalControl.hidden = !personal;
    publicFallbackToggle.hidden = personal || !publicRule;
    publicFallbackToggle.textContent = publicExpanded ? 'Hide fallback' : 'Show fallback';
    publicFallbackToggle.setAttribute('aria-expanded', String(publicExpanded));
    if (!primary) {
        deactivateInlineFallbackTarget({ discardDraft: personal });
        inlineFallbackEnabled.checked = false;
        inlineFallbackRemove.hidden = true;
        inlineFallbackGuide.hidden = true;
        inlineFallbackChart.hidden = true;
        inlineFallbackChart.tabIndex = -1;
        inlineFallbackChart.replaceChildren();
        return;
    }

    const rule = personal ? personalRule : publicRule;
    const targetActive = personal && enabled && Number(fallbackTargetPrimaryID) === primaryConditionID;
    const controlsBusy = state.loading || state.saving || state.gestureOpen;
    const interactionBusy = state.loading || state.saving;
    if (!personal || !targetActive) {
        selectedFallbackPrimaryID = null;
        selectedFallbackComponentID = null;
    }
    inlineFallback.classList.toggle('is-target-active', targetActive);
    benchmarkCard?.classList.toggle('is-fallback-target-active', targetActive);
    inlineFallbackEnabled.checked = enabled;
    inlineFallbackEnabled.disabled = controlsBusy;
    inlineFallbackRemove.hidden = !personal || !targetActive || !rule || selectedFallbackComponentID === null;
    inlineFallbackRemove.disabled = controlsBusy;
    if (!inlineFallbackRemove.hidden) {
        const selectedEntry = rule.entries.find(entry => (
            Number(entry.conditionID) === Number(selectedFallbackComponentID)
        ));
        const selectedName = benchmarkAccessibleName(selectedEntry);
        inlineFallbackRemove.setAttribute('aria-label', `Remove ${selectedName} from Fallback`);
        inlineFallbackRemove.title = `Remove ${selectedName} from Fallback`;
    }
    const chartVisible = personal ? enabled : publicExpanded;
    inlineFallbackGuide.hidden = !chartVisible;
    inlineFallbackGuide.textContent = personal
        ? 'Select the bar, add benchmarks from the leaderboard, then scroll to adjust.'
        : `Community fallback mix for ${benchmarkAccessibleName(primary)}.`;
    inlineFallbackChart.hidden = !chartVisible;
    inlineFallbackChart.tabIndex = chartVisible && !interactionBusy ? 0 : -1;
    inlineFallbackChart.classList.toggle('is-target-active', targetActive);
    inlineFallbackChart.classList.toggle('is-disabled', interactionBusy);
    inlineFallbackChart.setAttribute(
        'aria-label',
        personal
            ? targetActive
                ? `Fallback mix selected for ${benchmarkAccessibleName(primary)}. Choose benchmark rows to add.`
                : `Fallback mix for ${benchmarkAccessibleName(primary)}. Select this bar before choosing benchmarks.`
            : `Public fallback mix for ${benchmarkAccessibleName(primary)}`
    );

    if (!chartVisible) {
        inlineFallbackChart.classList.remove('has-single-component', 'is-empty');
        inlineFallbackChart.replaceChildren();
        return;
    }

    if (!rule) {
        inlineFallbackChart.classList.remove('has-single-component');
        inlineFallbackChart.classList.add('is-empty');
        const empty = document.createElement('span');
        empty.className = 'bp-inline-fallback-empty';
        empty.textContent = targetActive
            ? 'Choose a benchmark from the leaderboard'
            : 'Select this bar to add benchmarks';
        inlineFallbackChart.replaceChildren(empty);
        return;
    }

    const componentIDs = new Set(rule.entries.map(entry => Number(entry.conditionID)));
    if (personal && targetActive && (selectedFallbackPrimaryID !== primaryConditionID
        || !componentIDs.has(Number(selectedFallbackComponentID)))) {
        selectedFallbackPrimaryID = primaryConditionID;
        selectedFallbackComponentID = rule.entries[0]?.conditionID ?? null;
    }
    if (!personal && selectedPublicFallbackComponentID !== null
        && !componentIDs.has(Number(selectedPublicFallbackComponentID))) {
        selectedPublicFallbackComponentID = null;
    }
    inlineFallbackChart.querySelector('.bp-inline-fallback-empty')?.remove();
    inlineFallbackChart.classList.remove('is-empty');
    inlineFallbackChart.classList.toggle('has-single-component', rule.entries.length === 1);
    const retainedSegments = new Set();
    rule.entries.forEach((entry, index) => {
        const conditionID = Number(entry.conditionID);
        const weight = Number(entry.weightBasisPoints) / 100;
        const selected = personal
            ? targetActive && conditionID === Number(selectedFallbackComponentID)
            : conditionID === Number(selectedPublicFallbackComponentID);
        const [startColor, endColor] = PIE_GRADIENTS[index % PIE_GRADIENTS.length];
        let segment = inlineFallbackChart.querySelector(
            `.bp-inline-fallback-segment[data-condition-id="${conditionID}"]`
        );
        if (!segment) {
            segment = document.createElement('button');
            segment.type = 'button';
            segment.className = 'bp-inline-fallback-segment';
            segment.append(
                document.createElement('strong'),
                document.createElement('small'),
                document.createElement('span')
            );
            segment.addEventListener('click', event => {
                event.stopPropagation();
                if (state.mode === 'public') {
                    selectedPublicFallbackComponentID = Number(segment.dataset.conditionId);
                    renderInlineFallback();
                } else {
                    activateInlineFallbackTarget(Number(segment.dataset.conditionId));
                }
            });
        }
        retainedSegments.add(segment);
        segment.classList.toggle('selected', selected);
        segment.dataset.primaryConditionId = String(primaryConditionID);
        segment.dataset.conditionId = String(conditionID);
        segment.style.setProperty('--bp-fallback-weight', `${weight}%`);
        segment.style.setProperty('--bp-fallback-color-start', startColor);
        segment.style.setProperty('--bp-fallback-color-end', endColor);
        segment.disabled = interactionBusy;
        segment.setAttribute('aria-pressed', String(selected));
        segment.setAttribute(
            'aria-label',
            `${benchmarkAccessibleName(entry)}: ${Math.round(weight)} percent of the ${personal ? '' : 'public '}Fallback mix`
        );
        segment.title = `${benchmarkAccessibleName(entry)} · ${Math.round(weight)}%`;

        const name = segment.querySelector('strong');
        name.textContent = entry.name;
        const conditionLabel = benchmarkConditionLabel(entry);
        const condition = segment.querySelector('small');
        condition.hidden = !conditionLabel;
        condition.textContent = conditionLabel;
        const value = segment.querySelector('span');
        value.textContent = `${Math.round(weight)}%`;
        const currentAtIndex = inlineFallbackChart.children[index];
        if (currentAtIndex !== segment) {
            inlineFallbackChart.insertBefore(segment, currentAtIndex ?? null);
        }
    });
    inlineFallbackChart.querySelectorAll('.bp-inline-fallback-segment').forEach(segment => {
        if (!retainedSegments.has(segment)) segment.remove();
    });
}

function adjustSelectedFallbackWeight(deltaBasisPoints) {
    const primary = selectedInlineFallbackPrimary();
    if (!primary || !isInlineFallbackTargetActive()) return false;
    const rules = cloneFallbackRules(state.personalFallbackRules);
    const rule = rules.find(candidate => (
        Number(candidate.primaryConditionID) === Number(primary.ID)
    ));
    if (!rule || rule.entries.length < 2) return false;
    const selectedIndex = rule.entries.findIndex(entry => (
        Number(entry.conditionID) === Number(selectedFallbackComponentID)
    ));
    if (selectedIndex < 0) return false;

    const selected = { ...rule.entries[selectedIndex] };
    const others = rule.entries.filter((_, index) => index !== selectedIndex);
    const maximum = state.limits.totalBasisPoints - (others.length * MIN_WEIGHT_BASIS_POINTS);
    const nextWeight = clamp(
        Number(selected.weightBasisPoints) + deltaBasisPoints,
        MIN_WEIGHT_BASIS_POINTS,
        maximum
    );
    if (nextWeight === Number(selected.weightBasisPoints) || !beginMutation(true)) {
        return false;
    }

    selected.weightBasisPoints = nextWeight;
    selected.weight = nextWeight / 100;
    const redistributed = distributeToTarget(
        others,
        state.limits.totalBasisPoints - nextWeight,
        MIN_WEIGHT_BASIS_POINTS
    );
    const redistributedByID = new Map(redistributed.map(entry => [Number(entry.conditionID), entry]));
    rule.entries = rule.entries.map((entry, index) => (
        index === selectedIndex ? selected : redistributedByID.get(Number(entry.conditionID))
    ));
    state.personalFallbackRules = rules;
    renderInlineFallback();
    return true;
}

function scheduleFallbackWheelPreview() {
    if (fallbackWheelPreviewFrame !== null) return;
    fallbackWheelPreviewFrame = requestAnimationFrame(() => {
        fallbackWheelPreviewFrame = null;
        const deltaBasisPoints = Math.round(pendingFallbackWheelBasisPoints);
        pendingFallbackWheelBasisPoints = 0;
        if (deltaBasisPoints !== 0) {
            adjustSelectedFallbackWeight(deltaBasisPoints);
        }
    });
}

function commitPendingFallbackWheelAdjustment() {
    window.clearTimeout(fallbackWheelCommitTimer);
    fallbackWheelCommitTimer = null;
    if (fallbackWheelPreviewFrame !== null) {
        cancelAnimationFrame(fallbackWheelPreviewFrame);
        fallbackWheelPreviewFrame = null;
    }
    const deltaBasisPoints = Math.round(pendingFallbackWheelBasisPoints);
    pendingFallbackWheelBasisPoints = 0;
    if (deltaBasisPoints !== 0) {
        adjustSelectedFallbackWeight(deltaBasisPoints);
    }
    renderInlineFallback();
    updateUndoState();
    return finishWeightGesture();
}

async function removeInlineFallbackRule() {
    const primary = selectedInlineFallbackPrimary();
    if (!primary) {
        renderInlineFallback();
        return;
    }
    const primaryConditionID = Number(primary.ID);
    if (!fallbackRuleFor(primaryConditionID)) {
        if (Number(fallbackDraftPrimaryID) === primaryConditionID) {
            fallbackDraftPrimaryID = null;
        }
        deactivateInlineFallbackTarget();
        renderInlineFallback();
        renderBenchmarks();
        return;
    }
    if (!beginMutation()) {
        renderInlineFallback();
        return;
    }
    state.personalFallbackRules = state.personalFallbackRules.filter(rule => (
        Number(rule.primaryConditionID) !== primaryConditionID
    ));
    fallbackDraftPrimaryID = null;
    deactivateInlineFallbackTarget();
    renderPie();
    renderBenchmarks();
    await persistPersonalPie();
}

function fallbackComponentFromBenchmark(object, weightBasisPoints) {
    return {
        conditionID: Number(object.ID),
        benchmarkID: Number(object.benchmarkID),
        name: object.name,
        conditionKey: object.conditionKey,
        conditionName: object.conditionName,
        isDefaultCondition: Boolean(object.isDefaultCondition),
        type: object.type,
        weightBasisPoints,
        weight: weightBasisPoints / 100
    };
}

function fallbackRuleWouldCycle(primaryConditionID, candidateEntries) {
    const rulesByPrimary = new Map(state.personalFallbackRules
        .filter(rule => Number(rule.primaryConditionID) !== Number(primaryConditionID))
        .map(rule => [Number(rule.primaryConditionID), rule.entries.map(entry => Number(entry.conditionID))]));
    rulesByPrimary.set(Number(primaryConditionID), candidateEntries.map(entry => Number(entry.conditionID)));
    const targetID = Number(primaryConditionID);
    const canReachTarget = (conditionID, visited = new Set()) => {
        const normalizedID = Number(conditionID);
        if (normalizedID === targetID) return true;
        if (visited.has(normalizedID)) return false;
        visited.add(normalizedID);
        return (rulesByPrimary.get(normalizedID) ?? []).some(nextID => canReachTarget(nextID, visited));
    };
    return candidateEntries.some(entry => canReachTarget(entry.conditionID));
}

function replaceFallbackRuleEntries(primaryConditionID, entries) {
    const retained = state.personalFallbackRules.filter(rule => (
        Number(rule.primaryConditionID) !== Number(primaryConditionID)
    ));
    if (entries.length > 0) {
        retained.push({
            primaryConditionID: Number(primaryConditionID),
            mode: FALLBACK_RULE_MODE,
            entries: cloneEntries(entries)
        });
    }
    state.personalFallbackRules = retained.sort((left, right) => (
        Number(left.primaryConditionID) - Number(right.primaryConditionID)
    ));
}

function addObjectToFallbackMix(object) {
    const primary = selectedInlineFallbackPrimary();
    if (!primary || !isInlineFallbackTargetActive()) {
        return false;
    }
    const primaryConditionID = Number(primary.ID);
    const conditionID = Number(object.ID);
    if (conditionID === primaryConditionID) {
        setStatus('A benchmark cannot fall back to itself.');
        return false;
    }

    const existingRule = fallbackRuleFor(primaryConditionID);
    const existingEntry = existingRule?.entries.find(entry => (
        Number(entry.conditionID) === conditionID
    ));
    if (existingEntry) {
        selectedFallbackPrimaryID = primaryConditionID;
        selectedFallbackComponentID = conditionID;
        renderInlineFallback();
        renderBenchmarks();
        return true;
    }

    const existingEntries = cloneEntries(existingRule?.entries ?? []);
    if (existingEntries.length >= MAX_FALLBACK_COMPONENTS) {
        setStatus('Fallback can contain up to ' + MAX_FALLBACK_COMPONENTS + ' benchmarks.');
        return false;
    }

    const candidate = fallbackComponentFromBenchmark(object, state.limits.totalBasisPoints);
    let nextEntries;
    if (existingEntries.length === 0) {
        nextEntries = [candidate];
    } else {
        const initialWeight = Math.min(
            500,
            state.limits.totalBasisPoints - (existingEntries.length * MIN_WEIGHT_BASIS_POINTS)
        );
        const redistributed = distributeToTarget(
            existingEntries,
            state.limits.totalBasisPoints - initialWeight,
            MIN_WEIGHT_BASIS_POINTS
        );
        candidate.weightBasisPoints = initialWeight;
        candidate.weight = initialWeight / 100;
        nextEntries = [...redistributed, candidate];
    }

    if (fallbackRuleWouldCycle(primaryConditionID, nextEntries)) {
        setStatus('That benchmark would create a fallback loop.');
        return false;
    }
    if (!beginMutation()) {
        return false;
    }

    replaceFallbackRuleEntries(primaryConditionID, nextEntries);
    fallbackDraftPrimaryID = null;
    fallbackTargetPrimaryID = primaryConditionID;
    selectedFallbackPrimaryID = primaryConditionID;
    selectedFallbackComponentID = conditionID;
    setStatus('');
    renderPie();
    renderBenchmarks();
    scheduleSave();
    return true;
}

function removeSelectedFallbackComponent() {
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!primary || !rule || !isInlineFallbackTargetActive()) {
        return false;
    }
    const conditionID = Number(selectedFallbackComponentID);
    if (!rule.entries.some(entry => Number(entry.conditionID) === conditionID)) {
        return false;
    }
    if (!beginMutation()) {
        return false;
    }

    const remaining = rule.entries.filter(entry => Number(entry.conditionID) !== conditionID);
    const redistributed = distributeToTarget(
        remaining,
        state.limits.totalBasisPoints,
        MIN_WEIGHT_BASIS_POINTS
    );
    const primaryConditionID = Number(primary.ID);
    replaceFallbackRuleEntries(primaryConditionID, redistributed);
    fallbackDraftPrimaryID = redistributed.length === 0 ? primaryConditionID : null;
    fallbackTargetPrimaryID = primaryConditionID;
    selectedFallbackPrimaryID = primaryConditionID;
    selectedFallbackComponentID = redistributed[0]?.conditionID ?? null;
    renderPie();
    renderBenchmarks();
    scheduleSave();
    return true;
}
function addObjectToPersonalPie(object) {
    const existing = state.personalEntries.find(entry => Number(entry.conditionID) === Number(object.ID));
    if (existing) {
        state.selectedObjectID = existing.conditionID;
        return true;
    }
    if (!beginMutation()) {
        return false;
    }
    if (state.personalEntries.length >= state.limits.maxPieItems) {
        setStatus(`Personal Weights can contain up to ${state.limits.maxPieItems} benchmarks`);
        state.undoSnapshot = null;
        updateUndoState();
        return false;
    }
    const initialWeight = state.personalEntries.length === 0
        ? state.limits.totalBasisPoints
        : Math.min(
            500,
            state.limits.totalBasisPoints - (state.personalEntries.length * MIN_WEIGHT_BASIS_POINTS)
        );
    const existingEntries = distributeToTarget(
        state.personalEntries,
        state.limits.totalBasisPoints - initialWeight
    );
    const newEntry = {
        conditionID: Number(object.ID),
        benchmarkID: Number(object.benchmarkID),
        name: object.name,
        conditionKey: object.conditionKey,
        conditionName: object.conditionName,
        isDefaultCondition: Boolean(object.isDefaultCondition),
        type: object.type,
        weightBasisPoints: initialWeight,
        weight: initialWeight / 100
    };
    state.personalEntries = [...existingEntries, newEntry];
    registerPieEntries([newEntry]);
    state.selectedObjectID = newEntry.conditionID;
    scheduleSave();
    return true;
}

function removeObjectFromPersonalPie(object) {
    const objectID = Number(object.ID);
    if (!state.personalEntries.some(entry => Number(entry.conditionID) === objectID)) {
        return false;
    }
    if (!beginMutation()) {
        return false;
    }

    state.personalEntries = distributeToTarget(
        state.personalEntries.filter(entry => Number(entry.conditionID) !== objectID),
        state.limits.totalBasisPoints
    );
    state.personalFallbackRules = state.personalFallbackRules.filter(rule => (
        Number(rule.primaryConditionID) !== objectID
    ));
    if (state.mode === 'personal' && Number(state.selectedObjectID) === objectID) {
        deactivateInlineFallbackTarget({ discardDraft: true });
        state.selectedObjectID = state.personalEntries[0]?.conditionID ?? null;
        if (state.workspaceView === 'focus') {
            state.workspaceView = 'leaderboard';
        }
    }
    scheduleSave();
    return true;
}

function renderBenchmarks() {
    benchmarkRows.replaceChildren();
    const personalControlsActive = state.mode === 'personal';
    const fallbackTargetActive = isInlineFallbackTargetActive();
    const fallbackPrimary = fallbackTargetActive ? selectedInlineFallbackPrimary() : null;
    const activeFallbackRule = fallbackPrimary ? fallbackRuleFor(fallbackPrimary.ID) : null;
    const activeFallbackConditionIDs = new Set((activeFallbackRule?.entries ?? []).map(entry => (
        Number(entry.conditionID)
    )));
    benchmarkCard?.classList.toggle('is-fallback-target-active', fallbackTargetActive);
    const canPinPersonal = personalControlsActive
        && state.authenticated
        && state.personalEntries.length > 0;
    if (!canPinPersonal) {
        state.pinPersonalBenchmarks = false;
    }
    benchmarkPersonalPin.hidden = !canPinPersonal;
    benchmarkPersonalPin.disabled = !canPinPersonal;
    benchmarkPersonalPin.setAttribute('aria-pressed', String(state.pinPersonalBenchmarks));
    benchmarkPersonalPin.setAttribute(
        'aria-label',
        state.pinPersonalBenchmarks ? 'Stop pinning my benchmarks to the top' : 'Pin my benchmarks to the top'
    );
    benchmarkPersonalPin.title = canPinPersonal
        ? state.pinPersonalBenchmarks ? 'Restore public-weight order' : 'Pin my benchmarks to the top'
        : 'Add benchmarks to Personal Weights to use this';
    if (state.loading) {
        const loading = document.createElement('div');
        loading.className = 'bp-loading-state';
        loading.textContent = 'Loading benchmarks…';
        benchmarkRows.append(loading);
        return;
    }
    const query = benchmarkSearch.value.trim().toLowerCase();
    const personalWeightsByID = new Map(state.personalEntries.map(entry => [
        Number(entry.conditionID),
        Number(entry.weight)
    ]));
    const personalWeightFor = object => personalWeightsByID.has(Number(object.ID))
        ? personalWeightsByID.get(Number(object.ID))
        : object.personalWeight;
    const objects = state.benchmarks.filter(object => (
        !query
        || object.name.toLowerCase().includes(query)
        || benchmarkConditionLabel(object).toLowerCase().includes(query)
        || object.tags?.some(tag => tag.toLowerCase().includes(query))
    )).sort((left, right) => {
        const leftIsPinned = state.pinPersonalBenchmarks && personalWeightsByID.has(Number(left.ID));
        const rightIsPinned = state.pinPersonalBenchmarks && personalWeightsByID.has(Number(right.ID));
        if (leftIsPinned !== rightIsPinned) {
            return rightIsPinned - leftIsPinned;
        }
        if (leftIsPinned && rightIsPinned) {
            const personalDifference = personalWeightFor(right) - personalWeightFor(left);
            if (personalDifference !== 0) {
                return personalDifference;
            }
        }
        const publicDifference = Number(right.publicWeight) - Number(left.publicWeight);
        if (publicDifference !== 0) {
            return publicDifference;
        }
        return Number(left.rank) - Number(right.rank)
            || left.name.localeCompare(right.name)
            || benchmarkConditionLabel(left).localeCompare(benchmarkConditionLabel(right));
    });
    if (objects.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'bp-empty-state';
        empty.textContent = 'No benchmarks found';
        benchmarkRows.append(empty);
        return;
    }

    const hasPinnedObjects = state.pinPersonalBenchmarks
        && objects.some(object => personalWeightsByID.has(Number(object.ID)));
    let encounteredUnpinnedRow = false;
    objects.forEach(object => {
        const inPersonalPie = state.personalEntries.some(entry => Number(entry.conditionID) === Number(object.ID));
        const pinned = state.pinPersonalBenchmarks && inPersonalPie;
        const row = document.createElement('div');
        row.className = 'bp-benchmark-row';
        const selected = Number(state.selectedObjectID) === Number(object.ID);
        row.classList.toggle('selected', selected);
        row.classList.toggle('in-personal-pie', inPersonalPie);
        row.classList.toggle('is-personal-pinned', pinned);
        row.classList.toggle('in-fallback-mix', activeFallbackConditionIDs.has(Number(object.ID)));
        row.classList.toggle('is-fallback-primary', Number(fallbackPrimary?.ID) === Number(object.ID));
        if (hasPinnedObjects && !pinned && !encounteredUnpinnedRow) {
            row.classList.add('after-personal-pinned');
            encounteredUnpinnedRow = true;
        }
        row.classList.toggle('is-muted', state.workspaceView === 'focus' && state.mode === 'personal' && !selected);
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        const accessibleName = benchmarkAccessibleName(object);
        const focusedName = selected
            ? accessibleName
            : benchmarkAccessibleName(selectedBenchmark()) || 'the selected benchmark';
        const exitsPersonalFocus = state.workspaceView === 'focus' && state.mode === 'personal';
        row.setAttribute('aria-label', fallbackTargetActive
            ? activeFallbackConditionIDs.has(Number(object.ID))
                ? `Select ${accessibleName} in Fallback`
                : Number(fallbackPrimary?.ID) === Number(object.ID)
                    ? `${accessibleName} cannot be its own Fallback`
                    : `Add ${accessibleName} to Fallback`
            : exitsPersonalFocus
                ? `Exit weight adjustment for ${focusedName}`
                : state.mode === 'personal' && !inPersonalPie
                    ? `Add ${accessibleName} to Personal Weights and focus it`
                    : `${selected && state.workspaceView === 'focus' ? 'Close focus for' : 'Focus'} ${accessibleName}`);

        const rank = document.createElement('span');
        rank.className = 'bp-benchmark-rank';
        rank.textContent = String(object.rank);

        const identity = document.createElement('span');
        identity.className = 'bp-benchmark-identity';
        const name = document.createElement('span');
        name.className = 'bp-benchmark-name';
        name.textContent = object.name;
        identity.append(name);
        const conditionLabel = benchmarkConditionLabel(object);
        if (conditionLabel) {
            const condition = document.createElement('span');
            condition.className = 'bp-benchmark-condition';
            condition.textContent = conditionLabel;
            identity.append(condition);
        }
        identity.title = accessibleName;

        const publicValue = document.createElement('span');
        publicValue.className = 'bp-benchmark-weight';
        publicValue.textContent = `${Number(object.publicWeight).toFixed(2)}%`;

        const personalWeight = personalWeightFor(object);
        const personalValue = document.createElement('span');
        personalValue.className = 'bp-benchmark-weight';
        const personalWeightText = personalWeight === null ? '—' : `${Math.round(Number(personalWeight))}%`;
        personalValue.textContent = personalWeightText;
        if (personalControlsActive && inPersonalPie && fallbackRuleFor(object.ID)) {
            personalValue.classList.add('has-fallback');
            personalValue.title = `${accessibleName} has a Fallback`;
            const value = document.createElement('span');
            value.textContent = personalWeightText;
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-code-branch';
            icon.setAttribute('aria-hidden', 'true');
            personalValue.replaceChildren();
            personalValue.append(value, icon);
        }

        const actionCell = document.createElement('span');
        actionCell.className = 'bp-benchmark-action-cell';
        if (state.authenticated) {
            const edit = document.createElement('a');
            edit.className = 'bp-row-edit-action bp-benchmark-edit';
            edit.href = buildBenchmarkEditURL(object);
            edit.title = 'Change benchmark';
            edit.setAttribute('aria-label', `Change ${accessibleName}`);
            edit.innerHTML = '<i class="fa-solid fa-pencil" aria-hidden="true"></i>';
            edit.addEventListener('click', event => event.stopPropagation());
            actionCell.append(edit);

            if (personalControlsActive && inPersonalPie) {
                actionCell.classList.add('has-personal-remove');
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'bp-personal-weight-remove';
                remove.title = 'Remove from Personal Weights';
                remove.setAttribute('aria-label', `Remove ${accessibleName} from Personal Weights`);
                remove.innerHTML = '<i class="fa-regular fa-trash-can" aria-hidden="true"></i>';
                remove.addEventListener('click', event => {
                    event.stopPropagation();
                    if (!removeObjectFromPersonalPie(object)) {
                        return;
                    }
                    renderAll();
                });
                actionCell.append(remove);
            }
        }

        const activate = event => {
            if (event.target.closest('a, button')) {
                return;
            }
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') {
                return;
            }
            if (event.type === 'keydown') {
                event.preventDefault();
            }
            if (fallbackTargetActive) {
                addObjectToFallbackMix(object);
                return;
            }
            deactivateInlineFallbackTarget({ discardDraft: true });
            if (state.workspaceView === 'focus' && state.mode === 'personal') {
                setWorkspaceView('leaderboard');
                return;
            }
            if (state.workspaceView === 'focus' && selected) {
                setWorkspaceView('leaderboard');
                return;
            }
            if (state.mode === 'personal' && !addObjectToPersonalPie(object)) {
                return;
            }
            state.selectedObjectID = Number(object.ID);
            state.workspaceView = 'focus';
            applyWorkspaceView({ animate: true });
            renderModeState();
            renderPie();
            renderBenchmarks();
            renderBenchmarkSummary();
        };
        row.addEventListener('click', activate);
        row.addEventListener('keydown', activate);
        row.append(rank, identity, personalValue, publicValue, actionCell);
        benchmarkRows.append(row);
    });
}

function vendorMark(vendor) {
    const key = String(vendor || 'openai').toLowerCase();
    const mark = document.createElement('span');
    mark.className = `bp-vendor-mark vendor-${key}`;
    const assets = {
        openai: 'openai.png', anthropic: 'anthropic.png', google: 'google.png',
        meta: 'meta.png', mistral: 'mistral.png', amazon: 'amazon.png',
        cohere: 'cohere.png', qwen: 'qwen.png', microsoft: 'microsoft.png',
        xai: 'xai.png', deepseek: 'deepseek.png', zhipu: 'zhipu.png'
    };
    if (assets[key]) {
        const image = document.createElement('img');
        image.src = `/assets/vendors/${assets[key]}`;
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        image.addEventListener('error', () => {
            mark.textContent = key.slice(0, 1).toUpperCase();
        }, { once: true });
        mark.append(image);
    } else {
        mark.textContent = key.slice(0, 1).toUpperCase();
    }
    return mark;
}

function renderModels() {
    modelRows.replaceChildren();
    if (state.loading) {
        const loading = document.createElement('div');
        loading.className = 'bp-loading-state';
        loading.textContent = 'Calculating model ranges…';
        modelRows.append(loading);
        return;
    }
    const models = [...(state.modelLeaderboards[state.mode] ?? [])]
        .sort((a, b) => (
            Number(b.lower) - Number(a.lower)
            || Number(b.coverage) - Number(a.coverage)
            || a.name.localeCompare(b.name)
        ));
    if (models.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'bp-empty-state';
        empty.textContent = state.mode === 'personal'
            ? 'Add benchmarks to Personal Weights to calculate a model ranking.'
            : 'No public model ranking is available in this context yet.';
        modelRows.append(empty);
        return;
    }
    let previousScore = null;
    let previousRank = 0;
    models.forEach((model, index) => {
        const selectedScore = Number(model.lower);
        const rankValue = previousScore !== null && Math.abs(selectedScore - previousScore) < 0.0001
            ? previousRank
            : index + 1;
        previousScore = selectedScore;
        previousRank = rankValue;

        const row = document.createElement('div');
        row.className = 'bp-model-row';
        row.title = `${model.lower.toFixed(2)}–${model.upper.toFixed(2)} · ${model.coverage.toFixed(2)}% benchmark coverage`;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', `View approved scores for ${model.name}`);
        const rank = document.createElement('span');
        rank.className = 'bp-model-rank';
        rank.textContent = String(rankValue);
        const identity = document.createElement('span');
        identity.className = 'bp-model-name-wrap';
        const name = document.createElement('span');
        name.className = 'bp-model-name';
        name.textContent = model.name;
        identity.append(vendorMark(model.logoKey || model.vendorSlug), name);
        if (state.mode === 'personal' && Number(model.fallbackUsageCount) > 0) {
            const fallbackBadge = document.createElement('span');
            fallbackBadge.className = 'bp-model-fallback-badge';
            fallbackBadge.title = `Fallback used for ${model.fallbackUsageCount} benchmark${Number(model.fallbackUsageCount) === 1 ? '' : 's'}`;
            fallbackBadge.setAttribute('aria-label', fallbackBadge.title);
            fallbackBadge.innerHTML = `<i class="fa-solid fa-code-branch" aria-hidden="true"></i><span>${Number(model.fallbackUsageCount)}</span>`;
            identity.append(fallbackBadge);
            row.title += ` · ${fallbackBadge.title}`;
        }

        const track = document.createElement('span');
        track.className = 'bp-score-track';
        track.setAttribute('aria-label', `Verified lower bound ${model.lower.toFixed(2)}, possible upper bound ${model.upper.toFixed(2)}`);
        const known = document.createElement('span');
        known.className = 'bp-score-known';
        known.style.width = `${clamp(Number(model.lower), 0, 100)}%`;
        const uncertain = document.createElement('span');
        uncertain.className = 'bp-score-uncertain';
        uncertain.style.left = `${clamp(Number(model.lower), 0, 100)}%`;
        uncertain.style.width = `${clamp(Number(model.upper) - Number(model.lower), 0, 100)}%`;
        track.append(known, uncertain);

        const score = document.createElement('span');
        score.className = 'bp-model-score';
        score.textContent = selectedScore.toFixed(2);
        const actionCell = document.createElement('span');
        actionCell.className = 'bp-model-action-cell';
        if (state.authenticated) {
            const edit = document.createElement('a');
            edit.className = 'bp-row-edit-action bp-benchmark-edit';
            edit.href = buildModelEditURL(model);
            edit.title = 'Change model';
            edit.setAttribute('aria-label', `Change ${model.name}`);
            edit.innerHTML = '<i class="fa-solid fa-pencil" aria-hidden="true"></i>';
            edit.addEventListener('click', event => event.stopPropagation());
            actionCell.append(edit);
        }
        const activate = event => {
            if (event.target.closest('a, button')) {
                return;
            }
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') {
                return;
            }
            if (event.type === 'keydown') {
                event.preventDefault();
            }
            void openApprovedModelResults(model);
        };
        row.addEventListener('click', activate);
        row.addEventListener('keydown', activate);
        row.append(rank, identity, track, score, actionCell);
        modelRows.append(row);
    });
}

function renderModeState() {
    const personal = state.mode === 'personal';
    const hasPersonalWeights = state.personalEntries.length > 0;
    const showCreatePersonal = !state.loading && !hasPersonalWeights && !personal;
    const showEmptyPersonal = !state.loading && !hasPersonalWeights && personal;
    modeSwitch.hidden = !hasPersonalWeights;
    personalPieCreate.hidden = !showCreatePersonal;
    personalEmptyMode.hidden = !showEmptyPersonal;
    pieCard.classList.toggle('has-personal-create-cta', showCreatePersonal);
    modeSwitch?.classList.toggle('is-public', !personal);
    personalModeButton.classList.toggle('selected', personal);
    publicModeButton.classList.toggle('selected', !personal);
    personalModeButton.setAttribute('aria-selected', String(personal));
    publicModeButton.setAttribute('aria-selected', String(!personal));
    if (personal && !state.authenticated) {
        pieInstruction.textContent = 'Sign in to create Personal Weights.';
        pieContextNote.textContent = '';
    } else if (personal) {
        const focusedName = state.workspaceView === 'focus'
            ? benchmarkAccessibleName(selectedBenchmark())
            : '';
        pieInstruction.textContent = focusedName
            ? window.matchMedia('(pointer: coarse)').matches
                ? `Swipe to adjust ${focusedName}.`
                : `Scroll to adjust ${focusedName}.`
            : state.personalEntries.length === 0
                ? 'Choose a benchmark on the right to begin.'
            : window.matchMedia('(pointer: coarse)').matches
                ? 'Tap a slice, then swipe to adjust.'
                : 'Select a slice, then scroll to adjust.';
        pieContextNote.textContent = state.personalEntries.length === 0 ? '' : 'This context only.';
    } else {
        pieInstruction.textContent = 'Select a slice to inspect.';
        if (state.publicEntries.length > 0) {
            const people = state.publicParticipantCount === 1 ? 'person' : 'people';
            pieContextNote.textContent = `Community average · ${state.publicParticipantCount} ${people}.`;
        } else {
            pieContextNote.textContent = 'No community weights yet.';
        }
    }
}

function setMode(mode) {
    if (fallbackWheelCommitTimer !== null) {
        void commitPendingFallbackWheelAdjustment();
    } else if (wheelWeightCommitTimer !== null) {
        void commitPendingWheelAdjustment();
    }
    if (state.gestureOpen) {
        void finishWeightGesture();
    }
    deactivateInlineFallbackTarget({ discardDraft: true });
    expandedPublicFallbackPrimaryID = null;
    selectedPublicFallbackComponentID = null;
    state.mode = mode === 'public' ? 'public' : 'personal';
    const entries = currentPieEntries();
    if (!entries.some(entry => Number(entry.conditionID) === Number(state.selectedObjectID))) {
        state.selectedObjectID = entries[0]?.conditionID ?? null;
    }
    if (state.workspaceView === 'focus' && entries.length === 0) {
        state.workspaceView = 'leaderboard';
    }
    applyWorkspaceView({ animate: true });
    renderModeState();
    renderPie();
    renderBenchmarks();
    renderBenchmarkSummary();
    renderModels();
}

function renderAll() {
    updateLastUpdated();
    renderBreadcrumb();
    renderTemplateControls();
    renderModeState();
    renderPie();
    renderBenchmarks();
    renderBenchmarkSummary();
    renderModels();
    applyWorkspaceView();
    contributeDataButton.hidden = !state.authenticated;
    contributeEvaluationButton.hidden = !state.authenticated;
    const evaluationContributionURL = new URL('/contribute', window.location.origin);
    evaluationContributionURL.searchParams.set('mode', 'new_benchmark');
    evaluationContributionURL.searchParams.set('pageURL', window.location.href);
    contributeEvaluationButton.href = evaluationContributionURL.pathname + evaluationContributionURL.search;
    const contributionURL = new URL('/contribute', window.location.origin);
    contributionURL.searchParams.set('mode', 'benchmark_result');
    contributionURL.searchParams.set('categoryPath', state.categoryPath);
    contributionURL.searchParams.set('pageURL', window.location.href);
    contributeDataButton.href = contributionURL.pathname + contributionURL.search;
    updateUndoState();
    benchmarkCard?.setAttribute('aria-busy', String(state.loading));
    modelCard?.setAttribute('aria-busy', String(state.loading));
}

function applyServerWorkspace(payload, { preserveUndo = true } = {}) {
    const previousUndo = preserveUndo ? state.undoSnapshot : null;
    const nextContextFingerprint = workspaceContextFingerprint(
        payload.context.categoryID,
        payload.context.contextValues
    );
    const contextChanged = state.pieContextFingerprint !== nextContextFingerprint;
    if (contextChanged) {
        resetPieVisualState();
        state.pieContextFingerprint = nextContextFingerprint;
        state.workspaceView = 'overview';
    }
    state.authenticated = Boolean(payload.authenticated);
    state.categoryID = Number(payload.context.categoryID);
    state.categoryPath = String(payload.context.categoryPath || '');
    state.selectedContextValues = { ...payload.context.contextValues };
    state.dimensions = payload.context.dimensions.map(dimension => ({
        ...dimension,
        options: dimension.options.map(option => ({ ...option }))
    }));
    state.personalRevision = Number(payload.personalPie.revision);
    state.personalIsDraft = Boolean(payload.personalPie.isDraft);
    state.personalEntries = cloneEntries(payload.personalPie.entries);
    state.personalFallbackRules = cloneFallbackRules(payload.personalPie.fallbackRules);
    state.publicEntries = cloneEntries(payload.publicPie.entries);
    state.publicFallbackRules = cloneFallbackRules(payload.publicPie.fallbackRules);
    registerPieEntries(state.personalEntries);
    registerPieEntries(state.publicEntries);
    state.publicParticipantCount = Number(payload.publicPie.participantCount) || 0;
    state.publicIsFallback = Boolean(payload.publicPie.isFallback);
    state.benchmarks = payload.benchmarks.map(object => ({ ...object }));
    state.modelLeaderboards = {
        personal: payload.modelLeaderboards.personal.map(model => ({ ...model })),
        public: payload.modelLeaderboards.public.map(model => ({ ...model }))
    };
    state.scoreScale = { ...payload.scoreScale };
    state.limits = { ...payload.limits };
    state.serverPersonalEntries = cloneEntries(state.personalEntries);
    state.serverPersonalFallbackRules = cloneFallbackRules(state.personalFallbackRules);
    state.lastLoadTime = Date.parse(payload.serverTime) || Date.now();
    state.statusMessage = '';
    state.undoSnapshot = previousUndo;
    const currentEntries = currentPieEntries();
    if (!currentEntries.some(entry => Number(entry.conditionID) === Number(state.selectedObjectID))) {
        state.selectedObjectID = currentEntries[0]?.conditionID ?? null;
    }
    syncContextValuesToURL();
}

function workspaceLoadErrorMessage(error) {
    if (error?.code === 'invalid_workspace_response') {
        return error.message;
    }
    if (error?.payload?.error === 'category_not_found') {
        return 'This category no longer exists';
    }
    if (error?.payload?.error === 'ranking_root_missing') {
        return 'No ranking root is configured';
    }
    if (!error?.status) {
        return 'Connection interrupted';
    }
    if (error.status >= 500) {
        return 'The ranking service is temporarily unavailable';
    }
    return 'Could not load this ranking context';
}

function renderLoadError(error) {
    state.loading = false;
    const message = workspaceLoadErrorMessage(error);
    benchmarkRows.replaceChildren();
    modelRows.replaceChildren();
    [benchmarkRows, modelRows].forEach(container => {
        const errorState = document.createElement('div');
        errorState.className = 'bp-error-state';
        const text = document.createElement('span');
        text.textContent = message;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => loadWeightedWorkspace());
        errorState.append(text, retry);
        container.append(errorState);
    });
    setStatus(message);
}

async function loadWeightedWorkspace({ resetTemplates = false, retryAttempt = 0 } = {}) {
    if (!await finishPendingWeightAdjustments()) return;
    if (state.saving && state.savePromise) {
        await state.savePromise.catch(() => {});
    }
    const sequence = ++state.loadSequence;
    state.loading = true;
    state.statusMessage = 'Updating…';
    renderAll();
    const requestedContextValues = resetTemplates
        ? {}
        : { ...state.selectedContextValues };
    try {
        let payload = validateWorkspacePayload(await postJSON('/api/get_weighted_workspace', {
            categoryID: state.categoryID,
            contextValues: requestedContextValues
        }));
        if (!resetTemplates) {
            const URLContextValues = contextValuesForDimensions(payload.context.dimensions);
            const resolvedContextValues = {
                ...payload.context.contextValues,
                ...URLContextValues,
                ...state.selectedContextValues
            };
            if (!sameContextValues(resolvedContextValues, payload.context.contextValues)) {
                payload = validateWorkspacePayload(await postJSON('/api/get_weighted_workspace', {
                    categoryID: state.categoryID,
                    contextValues: resolvedContextValues
                }));
            }
        }
        if (sequence !== state.loadSequence) {
            return;
        }
        state.loading = false;
        applyServerWorkspace(payload, { preserveUndo: false });
        renderAll();
    } catch (error) {
        if (sequence !== state.loadSequence) {
            return;
        }
        const retryDelay = WORKSPACE_LOAD_RETRY_DELAYS_MS[retryAttempt];
        if (retryDelay !== undefined && (!error.status || error.status >= 500)) {
            state.loading = true;
            setStatus('Connection interrupted - retrying...');
            await new Promise(resolve => window.setTimeout(resolve, retryDelay));
            if (sequence === state.loadSequence) {
                await loadWeightedWorkspace({ resetTemplates, retryAttempt: retryAttempt + 1 });
            }
            return;
        }
        console.error('[BenchPoll] Workspace update failed', {
            status: error.status ?? null,
            error: error.payload?.error ?? error.message
        });
        renderLoadError(error);
    }
}

async function persistPersonalPie() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (!state.authenticated) {
        return false;
    }
    if (state.persistPromise) {
        return state.persistPromise;
    }
    const task = (async () => {
        const categoryID = state.categoryID;
        const contextValues = { ...state.selectedContextValues };
        const entries = state.personalEntries.map(entry => ({
            conditionID: Number(entry.conditionID),
            weightBasisPoints: Number(entry.weightBasisPoints)
        }));
        const fallbackRules = state.personalFallbackRules.map(rule => ({
            primaryConditionID: Number(rule.primaryConditionID),
            mode: FALLBACK_RULE_MODE,
            entries: rule.entries.map(entry => ({
                conditionID: Number(entry.conditionID),
                weightBasisPoints: Number(entry.weightBasisPoints)
            }))
        }));
        const expectedRevision = state.personalRevision;
        const contextFingerprint = workspaceContextFingerprint(categoryID, contextValues);
        let reloadAfterConflict = false;
        let saved = false;
        state.saving = true;
        setStatus('Saving your pie…');
        updateUndoState();
        renderInlineFallback();
        state.savePromise = postJSON('/api/save_personal_pie', {
            categoryID,
            contextValues,
            expectedRevision,
            entries,
            fallbackRules
        });
        try {
            const payload = validateWorkspacePayload(await state.savePromise);
            const currentFingerprint = workspaceContextFingerprint();
            if (contextFingerprint === currentFingerprint) {
                applyServerWorkspace(payload, { preserveUndo: true });
                state.personalIsDraft = false;
                setStatus('Saved');
                window.setTimeout(() => {
                    if (state.statusMessage === 'Saved') {
                        setStatus('');
                    }
                }, 1200);
                renderAll();
            }
            saved = true;
        } catch (error) {
            if (error.status === 401) {
                requestLogin();
            }
            state.personalEntries = cloneEntries(state.serverPersonalEntries);
            state.personalFallbackRules = cloneFallbackRules(state.serverPersonalFallbackRules);
            state.undoSnapshot = null;
            if (error.status === 409 && error.payload?.error === 'pie_revision_conflict') {
                reloadAfterConflict = true;
            } else {
                setStatus('Your change was not saved');
                renderAll();
            }
        } finally {
            state.saving = false;
            state.savePromise = null;
            updateUndoState();
            renderInlineFallback();
        }
        if (reloadAfterConflict) {
            await loadWeightedWorkspace();
        }
        return saved;
    })();
    state.persistPromise = task;
    try {
        return await task;
    } finally {
        if (state.persistPromise === task) {
            state.persistPromise = null;
        }
    }
}

async function applyWorkspaceState(detail = {}) {
    if (!await finishPendingWeightAdjustments()) return;
    if (state.saving && state.savePromise) {
        await state.savePromise.catch(() => {});
    }
    if (!await flushPendingPersonalPieSave()) {
        return;
    }
    const nextCategoryID = detail.currentCategoryID ?? null;
    const nextCategoryPath = String(detail.categoryPath || '');
    const changed = Number(nextCategoryID) !== Number(state.categoryID)
        || (nextCategoryID === null && state.categoryID !== null)
        || nextCategoryPath !== state.categoryPath;
    state.categoryID = nextCategoryID;
    state.categoryPath = nextCategoryPath;
    if (changed) {
        state.selectedContextValues = {};
        state.dimensions = [];
        state.workspaceView = 'overview';
    }
    if (changed || state.benchmarks.length === 0) {
        await loadWeightedWorkspace();
    }
}

personalModeButton.addEventListener('click', () => setMode('personal'));
publicModeButton.addEventListener('click', () => setMode('public'));
personalPieCreate.addEventListener('click', () => {
    if (!state.authenticated) {
        requestLogin();
        return;
    }
    setMode('personal');
});
personalEmptyPublicReturn.addEventListener('click', () => setMode('public'));

function isPersonalBenchmarkFocus() {
    return state.workspaceView === 'focus' && state.mode === 'personal';
}

function queueSelectedWeightWheel(event) {
    if (state.mode !== 'personal') {
        return;
    }
    if (fallbackWheelCommitTimer !== null) {
        void commitPendingFallbackWheelAdjustment();
        return;
    }
    event.preventDefault();
    if (!state.authenticated) {
        requestLogin();
        return;
    }
    if (state.loading || state.saving || selectedObjectIndex(state.personalEntries) < 0) {
        return;
    }
    if (event.deltaY === 0) {
        return;
    }
    pendingWheelBasisPoints += event.deltaY < 0
        ? WEIGHT_STEP_BASIS_POINTS
        : -WEIGHT_STEP_BASIS_POINTS;
    setPieAdjustmentActive(true);
    scheduleWheelPreview();
    window.clearTimeout(wheelWeightCommitTimer);
    wheelWeightCommitTimer = window.setTimeout(() => {
        void commitPendingWheelAdjustment();
    }, WHEEL_WEIGHT_COMMIT_IDLE_MS);
    updateUndoState();
}

function queueSelectedFallbackWeightWheel(event) {
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!rule || !isInlineFallbackTargetActive() || rule.entries.length < 2 || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (wheelWeightCommitTimer !== null) {
        void commitPendingWheelAdjustment();
        return;
    }
    if (state.loading || state.saving || !state.authenticated) return;
    const wheelSteps = Math.max(1, Math.min(4, Math.round(Math.abs(event.deltaY) / 100)));
    pendingFallbackWheelBasisPoints += (event.deltaY < 0 ? 1 : -1)
        * MIN_WEIGHT_BASIS_POINTS
        * wheelSteps;
    setFallbackAdjustmentActive(true);
    scheduleFallbackWheelPreview();
    window.clearTimeout(fallbackWheelCommitTimer);
    fallbackWheelCommitTimer = window.setTimeout(() => {
        void commitPendingFallbackWheelAdjustment();
    }, WHEEL_WEIGHT_COMMIT_IDLE_MS);
    updateUndoState();
}

document.addEventListener('wheel', event => {
    if (!isPersonalBenchmarkFocus()) {
        return;
    }
    if (!(event.target instanceof Element)
        || event.target.closest('.bp-inline-fallback')
        || !event.target.closest('.bp-left-workspace')) {
        return;
    }
    queueSelectedWeightWheel(event);
}, { passive: false, capture: true });

pieSvg.addEventListener('wheel', event => {
    if (isPersonalBenchmarkFocus()) {
        return;
    }
    queueSelectedWeightWheel(event);
}, { passive: false });

inlineFallbackChart.addEventListener('wheel', queueSelectedFallbackWeightWheel, { passive: false });

pieSvg.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return;
    }
    const slice = event.target.closest('[data-object-id]');
    if (state.mode !== 'personal') {
        return;
    }
    if (fallbackWheelCommitTimer !== null) {
        void commitPendingFallbackWheelAdjustment();
        return;
    }
    if (wheelWeightCommitTimer !== null) {
        void commitPendingWheelAdjustment();
        return;
    }
    if (selectedObjectIndex(state.personalEntries) < 0) {
        return;
    }
    touchPieGesture = {
        pointerID: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        candidateObjectID: slice ? Number(slice.dataset.objectId) : null,
        adjusted: false,
        pendingBasisPoints: 0,
        previewFrame: null
    };
    pieSvg.setPointerCapture(event.pointerId);
});

const flushTouchPiePreview = gesture => {
    if (gesture.previewFrame !== null) {
        cancelAnimationFrame(gesture.previewFrame);
        gesture.previewFrame = null;
    }
    const deltaBasisPoints = Math.round(gesture.pendingBasisPoints);
    gesture.pendingBasisPoints = 0;
    if (deltaBasisPoints !== 0) {
        adjustSelectedWeight(deltaBasisPoints, { animateWeights: false });
    }
};

pieSvg.addEventListener('pointermove', event => {
    if (!touchPieGesture || touchPieGesture.pointerID !== event.pointerId) {
        return;
    }
    const deltaY = touchPieGesture.lastY - event.clientY;
    touchPieGesture.lastY = event.clientY;
    if (!touchPieGesture.adjusted
        && Math.abs(event.clientY - touchPieGesture.startY) < TOUCH_DRAG_THRESHOLD_PX) {
        return;
    }
    event.preventDefault();
    touchPieGesture.adjusted = true;
    setPieAdjustmentActive(true);
    touchPieGesture.pendingBasisPoints += deltaY * TOUCH_WEIGHT_BASIS_POINTS_PER_PIXEL;
    if (touchPieGesture.previewFrame === null) {
        const gesture = touchPieGesture;
        gesture.previewFrame = requestAnimationFrame(() => flushTouchPiePreview(gesture));
    }
});

const endTouchPieGesture = (event, cancelled = false) => {
    if (!touchPieGesture || touchPieGesture.pointerID !== event.pointerId) {
        return;
    }
    const completedGesture = touchPieGesture;
    if (!cancelled) {
        flushTouchPiePreview(completedGesture);
    } else if (completedGesture.previewFrame !== null) {
        cancelAnimationFrame(completedGesture.previewFrame);
        completedGesture.previewFrame = null;
    }
    if (pieSvg.hasPointerCapture(event.pointerId)) {
        pieSvg.releasePointerCapture(event.pointerId);
    }
    touchPieGesture = null;
    setPieAdjustmentActive(false);
    if (!cancelled && !completedGesture.adjusted && completedGesture.candidateObjectID !== null) {
        deactivateInlineFallbackTarget({ discardDraft: true });
        state.selectedObjectID = completedGesture.candidateObjectID;
        renderPie();
        renderBenchmarks();
        renderBenchmarkSummary();
        return;
    }
    if (cancelled && state.gestureOpen) {
        restorePersonalPieSnapshot(state.gestureSnapshot ?? snapshotPersonalPie());
        state.gestureOpen = false;
        state.gestureSnapshot = null;
        renderPie();
        renderBenchmarkSummary();
        updateUndoState();
        return;
    }
    if (completedGesture.adjusted && state.gestureOpen) {
        renderBenchmarks();
        void finishWeightGesture();
    }
};
pieSvg.addEventListener('pointerup', endTouchPieGesture);
pieSvg.addEventListener('pointercancel', event => endTouchPieGesture(event, true));

inlineFallbackChart.addEventListener('pointerdown', event => {
    const segment = event.target instanceof Element
        ? event.target.closest('.bp-inline-fallback-segment')
        : null;
    if (segment) {
        activateInlineFallbackTarget(Number(segment.dataset.conditionId));
    } else if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        activateInlineFallbackTarget();
    }
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!rule || rule.entries.length < 2 || wheelWeightCommitTimer !== null) return;
    touchFallbackGesture = {
        pointerID: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        adjusted: false,
        pendingBasisPoints: 0,
        previewFrame: null
    };
    inlineFallbackChart.setPointerCapture(event.pointerId);
});

const flushTouchFallbackPreview = gesture => {
    if (gesture.previewFrame !== null) {
        cancelAnimationFrame(gesture.previewFrame);
        gesture.previewFrame = null;
    }
    const deltaBasisPoints = Math.round(gesture.pendingBasisPoints);
    gesture.pendingBasisPoints = 0;
    if (deltaBasisPoints !== 0) {
        adjustSelectedFallbackWeight(deltaBasisPoints);
    }
};

inlineFallbackChart.addEventListener('pointermove', event => {
    if (!touchFallbackGesture || touchFallbackGesture.pointerID !== event.pointerId) return;
    const deltaY = touchFallbackGesture.lastY - event.clientY;
    touchFallbackGesture.lastY = event.clientY;
    if (!touchFallbackGesture.adjusted
        && Math.abs(event.clientY - touchFallbackGesture.startY) < TOUCH_DRAG_THRESHOLD_PX) {
        return;
    }
    event.preventDefault();
    touchFallbackGesture.adjusted = true;
    setFallbackAdjustmentActive(true);
    touchFallbackGesture.pendingBasisPoints += deltaY * TOUCH_WEIGHT_BASIS_POINTS_PER_PIXEL;
    if (touchFallbackGesture.previewFrame === null) {
        const gesture = touchFallbackGesture;
        gesture.previewFrame = requestAnimationFrame(() => flushTouchFallbackPreview(gesture));
    }
});

const endTouchFallbackGesture = (event, cancelled = false) => {
    if (!touchFallbackGesture || touchFallbackGesture.pointerID !== event.pointerId) return;
    const completedGesture = touchFallbackGesture;
    if (!cancelled) {
        flushTouchFallbackPreview(completedGesture);
    } else if (completedGesture.previewFrame !== null) {
        cancelAnimationFrame(completedGesture.previewFrame);
        completedGesture.previewFrame = null;
    }
    if (inlineFallbackChart.hasPointerCapture(event.pointerId)) {
        inlineFallbackChart.releasePointerCapture(event.pointerId);
    }
    touchFallbackGesture = null;
    setFallbackAdjustmentActive(false);
    if (cancelled && state.gestureOpen) {
        restorePersonalPieSnapshot(state.gestureSnapshot ?? snapshotPersonalPie());
        state.gestureOpen = false;
        state.gestureSnapshot = null;
        renderInlineFallback();
        updateUndoState();
        return;
    }
    if (completedGesture.adjusted && state.gestureOpen) {
        void finishWeightGesture();
    }
};
inlineFallbackChart.addEventListener('pointerup', endTouchFallbackGesture);
inlineFallbackChart.addEventListener('pointercancel', event => endTouchFallbackGesture(event, true));

undoButton.addEventListener('click', () => {
    if (!state.undoSnapshot
        || state.saving
        || state.gestureOpen
        || wheelWeightCommitTimer !== null
        || fallbackWheelCommitTimer !== null
        || !state.authenticated) {
        return;
    }
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const current = snapshotPersonalPie();
    restorePersonalPieSnapshot(state.undoSnapshot);
    state.undoSnapshot = current;
    if (!state.personalEntries.some(entry => Number(entry.conditionID) === Number(state.selectedObjectID))) {
        state.selectedObjectID = state.personalEntries[0]?.conditionID ?? null;
    }
    renderAll();
    void persistPersonalPie();
});

benchmarkSearch.addEventListener('input', renderBenchmarks);

benchmarkPersonalPin.addEventListener('click', () => {
    if (benchmarkPersonalPin.disabled) {
        return;
    }
    state.pinPersonalBenchmarks = !state.pinPersonalBenchmarks;
    renderBenchmarks();
});

inlineFallbackEnabled.addEventListener('change', () => {
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!primary) {
        renderInlineFallback();
        return;
    }
    if (inlineFallbackEnabled.checked && !rule) {
        fallbackDraftPrimaryID = Number(primary.ID);
        deactivateInlineFallbackTarget();
        renderInlineFallback();
        renderBenchmarks();
        return;
    }
    if (!inlineFallbackEnabled.checked) {
        void removeInlineFallbackRule();
        return;
    }
    renderInlineFallback();
});
publicFallbackToggle.addEventListener('click', () => {
    const primary = selectedPublicFallbackPrimary();
    const rule = primary ? publicFallbackRuleFor(primary.ID) : null;
    if (!primary || !rule) {
        expandedPublicFallbackPrimaryID = null;
        selectedPublicFallbackComponentID = null;
    } else if (Number(expandedPublicFallbackPrimaryID) === Number(primary.ID)) {
        expandedPublicFallbackPrimaryID = null;
        selectedPublicFallbackComponentID = null;
    } else {
        expandedPublicFallbackPrimaryID = Number(primary.ID);
        selectedPublicFallbackComponentID = null;
    }
    renderInlineFallback();
});
inlineFallbackRemove.addEventListener('click', () => {
    removeSelectedFallbackComponent();
});
inlineFallbackChart.addEventListener('click', event => {
    if (state.mode !== 'personal') {
        return;
    }
    if (event.target instanceof Element && event.target.closest('.bp-inline-fallback-segment')) {
        return;
    }
    activateInlineFallbackTarget();
});
inlineFallbackChart.addEventListener('keydown', event => {
    if (event.target !== inlineFallbackChart || state.mode !== 'personal') return;
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateInlineFallbackTarget();
    } else if (event.key === 'Escape' && isInlineFallbackTargetActive()) {
        event.preventDefault();
        deactivateInlineFallbackTarget();
        renderInlineFallback();
        renderBenchmarks();
    }
});

benchmarkLeaderboardOpen.addEventListener('click', () => setWorkspaceView('leaderboard'));
benchmarkLeaderboardClose.addEventListener('click', () => setWorkspaceView('overview'));

refreshButton.addEventListener('click', async () => {
    if (!await flushPendingPersonalPieSave()) {
        return;
    }
    await loadWeightedWorkspace();
});

window.__benchpollBeforeWorkspaceChange = async () => {
    if (!await finishPendingWeightAdjustments()) return false;
    return flushPendingPersonalPieSave();
};

missionDismiss.addEventListener('click', () => {
    missionBanner.hidden = true;
    document.body.classList.add('bp-mission-hidden');
});

termsButton.addEventListener('click', () => {
    termsDialog.hidden = false;
});

window.addEventListener('benchpoll:workspace-state', event => {
    void applyWorkspaceState(event.detail);
});

const existingState = window.__benchpollHomeState;
if (existingState) {
    void applyWorkspaceState(existingState);
} else {
    void loadWeightedWorkspace();
}

const treeObserver = new MutationObserver(() => {
    const firstFolder = document.querySelector('#tree-content > .tree-group:not(.expanded) > .tree-root-item .icon-folder');
    if (firstFolder) {
        treeObserver.disconnect();
        firstFolder.click();
    }
});
treeObserver.observe(document.getElementById('tree-content'), { childList: true, subtree: true });

window.setInterval(updateLastUpdated, 30000);
