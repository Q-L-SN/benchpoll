const routes = Object.freeze({
    new_benchmark: 'benchmarks/new', new_model: 'models/new', benchmark_result: 'scores/new',
    feedback: 'feedback', report: 'reports/new',
    correct_or_add_info: 'benchmark-correction'
});
const targets = Object.freeze({
    edit_benchmark: ['benchmarks', 'targetBenchmarkID'],
    edit_model: ['models', 'targetModelID'], edit_result: ['scores', 'targetResultID']
});
const entryPrefix = 'benchpoll:contribution-entry:';
const lifetime = 30 * 60 * 1000;
const links = new Map();
const entries = new Map();
let activationListening = false;
const fields = new Set(['pageURL', 'parentPath', 'parentName', 'categoryPath', 'targetName', 'targetKind',
    'targetCategoryID', 'targetBenchmarkID', 'targetModelID', 'targetResultID', 'targetConditionID',
    'benchmarkID', 'benchmarkName', 'modelID', 'modelName', 'vendorID', 'vendorName', 'postID', 'operation', 'addCondition', 'details']);

export function returnFromContribution(params = new URLSearchParams()) {
    if (window.history.length > 1) { window.history.back(); return; }
    const candidates = [document.referrer, params.get('pageURL'), params.get('parentPath')];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            const previous = new URL(candidate, window.location.origin);
            if (previous.origin === window.location.origin && previous.href !== window.location.href) {
                window.location.assign(previous.href); return;
            }
        } catch { /* Ignore a malformed optional return URL. */ }
    }
    window.location.assign('/');
}

export function contributionPath(mode, values = {}) {
    if (mode === 'topic_report') {
        if (!/^[1-9]\d*$/.test(String(values.targetCategoryID))) throw new Error('A valid topic ID is required.');
        return `/contribute/topics/${values.targetCategoryID}/report`;
    }
    if (targets[mode]) {
        const [collection, field] = targets[mode];
        if (!/^[1-9]\d*$/.test(String(values[field]))) throw new Error('A valid object ID is required.');
        return `/contribute/${collection}/${values[field]}/${values.operation === 'delete' ? 'delete' : 'edit'}`;
    }
    if (mode === 'report' && /^[1-9]\d*$/.test(String(values.postID))) return `/contribute/discussions/${values.postID}/report`;
    if (!routes[mode]) throw new Error('Unknown contribution form.');
    return `/contribute/${routes[mode]}`;
}

export function contributionRoute(pathname) {
    const path = pathname.replace(/\/$/, '');
    const match = path.match(/^\/contribute\/(benchmarks|models|scores)\/([1-9]\d*)\/(edit|delete)$/);
    if (match) {
        const [mode, [, field]] = Object.entries(targets).find(([, [collection]]) => collection === match[1]);
        return { mode, [field]: match[2], ...(match[3] === 'delete' ? { operation: 'delete' } : {}) };
    }
    const report = path.match(/^\/contribute\/discussions\/([1-9]\d*)\/report$/);
    if (report) return { mode: 'report', postID: report[1] };
    const topicReport = path.match(/^\/contribute\/topics\/([1-9]\d*)\/report$/);
    if (topicReport) return { mode: 'topic_report', targetCategoryID: topicReport[1] };
    const mode = Object.keys(routes).find(key => path === `/contribute/${routes[key]}`);
    return mode ? { mode } : null;
}

function cleanValues(values) {
    return Object.fromEntries(Object.entries(values).filter(([key, value]) => fields.has(key)
        && value !== undefined && value !== null && String(value) !== '').map(([key, value]) => [key, String(value)]));
}

export function buildContributionURL(mode, values = {}) {
    const clean = cleanValues(values);
    const path = contributionPath(mode, clean);
    const core = contributionRoute(path);
    const extra = Object.fromEntries(Object.entries(clean).filter(([key, value]) => core[key] !== value));
    if (!Object.keys(extra).length) return path;
    const signature = JSON.stringify([path, extra]);
    const cached = links.get(signature);
    if (cached) return cached;
    const token = window.crypto.randomUUID();
    const url = `${path}#entry=${token}`;
    entries.set(token, { path, values: extra });
    links.set(signature, url);
    listenForContributionActivation();
    return url;
}

export function activateContributionURL(url) {
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin) return url;
    const token = new URLSearchParams(target.hash.slice(1)).get('entry');
    const entry = entries.get(token);
    if (!entry || entry.path !== target.pathname) return url;
    try {
        const storage = window.localStorage;
        const now = Date.now();
        for (let index = storage.length - 1; index >= 0; index--) {
            const key = storage.key(index);
            if (!key?.startsWith(entryPrefix)) continue;
            let record;
            try { record = JSON.parse(storage.getItem(key)); } catch { /* Remove malformed handoffs only. */ }
            if (!Number.isFinite(record?.expiresAt) || record.expiresAt <= now) storage.removeItem(key);
        }
        storage.setItem(entryPrefix + token, JSON.stringify({ ...entry, expiresAt: now + lifetime }));
    } catch { /* The destination reports unavailable prefill without breaking ordinary navigation. */ }
    return url;
}

function listenForContributionActivation() {
    if (activationListening || typeof document === 'undefined') return;
    activationListening = true;
    const activate = event => {
        if (!event.isTrusted || event.defaultPrevented || (event.type === 'click' && event.button !== 0)
            || (event.type === 'auxclick' && event.button !== 1)) return;
        const link = event.composedPath().find(node => node.matches?.('a[href]'));
        if (!link || link.hasAttribute('download')) return;
        activateContributionURL(link.href);
    };
    // Bubble after handlers which update href; leave native navigation/modifiers untouched.
    document.addEventListener('click', activate);
    document.addEventListener('auxclick', activate);
    // Native browser menu selections are not observable. Prepare only the requested link.
    document.addEventListener('contextmenu', activate);
}

export function readContributionEntry() {
    const url = new URL(location.href);
    const legacy = url.pathname === '/contribute' || url.pathname === '/contribute/';
    const query = Object.fromEntries(url.searchParams);
    const core = legacy ? { mode: query.mode, ...cleanValues(query) } : contributionRoute(url.pathname);
    if (!core?.mode) return { params: new URLSearchParams(), error: null };
    try {
        const path = contributionPath(core.mode, core);
        let token = new URLSearchParams(url.hash.slice(1)).get('entry');
        let extra = {};
        if (token) {
            if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error('Invalid form entry.');
            const record = JSON.parse(localStorage.getItem(entryPrefix + token) || 'null');
            if (!record || record.path !== path || record.expiresAt <= Date.now()) {
                throw new Error('These prefilled details have expired. Please open the form again from the original page.');
            }
            extra = cleanValues(record.values);
            sessionStorage.setItem(entryPrefix + token, JSON.stringify({ path, values: extra }));
        } else if (history.state?.contributionEntry
            && ['reload', 'back_forward'].includes(performance.getEntriesByType('navigation')[0]?.type)) {
            token = history.state.contributionEntry;
            const record = JSON.parse(sessionStorage.getItem(entryPrefix + token) || 'null');
            if (!record || record.path !== path) throw new Error('The form session is unavailable. Please reopen the form.');
            extra = cleanValues(record.values);
        } else if (legacy) {
            token = window.crypto.randomUUID();
            extra = cleanValues(query);
            sessionStorage.setItem(entryPrefix + token, JSON.stringify({ path, values: extra }));
        }
        // Route identity wins over handoff data; the server still authorizes every operation.
        const values = { ...extra, ...core };
        history.replaceState({ ...history.state, contributionEntry: token }, '', path);
        return { params: new URLSearchParams(values), error: null };
    } catch (error) {
        return { params: new URLSearchParams(core), error: error.message };
    }
}
