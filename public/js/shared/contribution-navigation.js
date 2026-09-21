const routes = Object.freeze({
    new_benchmark: 'benchmarks/new', new_model: 'models/new', benchmark_result: 'scores/new',
    new_category: 'categories/new', feedback: 'feedback', report: 'reports/new',
    correct_or_add_info: 'benchmark-correction', delete_or_migrate_category: 'categories/edit'
});
const targets = Object.freeze({
    edit_benchmark: ['benchmarks', 'targetBenchmarkID'],
    edit_model: ['models', 'targetModelID'], edit_result: ['scores', 'targetResultID']
});
const entryPrefix = 'benchpoll:contribution-entry:';
const lifetime = 30 * 60 * 1000;
const links = new Map();
const fields = new Set(['pageURL', 'parentPath', 'parentName', 'categoryPath', 'targetName', 'targetKind',
    'targetCategoryID', 'targetBenchmarkID', 'targetModelID', 'targetResultID', 'targetConditionID',
    'benchmarkID', 'benchmarkName', 'modelID', 'modelName', 'vendorID', 'vendorName', 'postID', 'operation', 'addCondition', 'details']);

export function contributionPath(mode, values = {}) {
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
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(entryPrefix)) continue;
        const record = JSON.parse(localStorage.getItem(key));
        if (record.expiresAt <= Date.now()) localStorage.removeItem(key);
    }
    for (const [key, value] of links) if (value.expiresAt <= Date.now()) links.delete(key);
    const token = window.crypto.randomUUID();
    const expiresAt = Date.now() + lifetime;
    localStorage.setItem(entryPrefix + token, JSON.stringify({ path, values: extra, expiresAt }));
    const url = `${path}#entry=${token}`;
    links.set(signature, { url, expiresAt });
    return url;
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
