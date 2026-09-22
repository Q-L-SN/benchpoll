import { entryFromContext } from '../../public/js/navigation/model.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { categories, createFixtureState, weightedEntries, workspace, catalog, approvedResults } from './fixtures.mjs';
import { discussionFixture } from './discussions.mjs';
import { comparisonOptions } from '../../model-comparison.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = resolve(root, 'public');
const pages = { '/': 'home.html', '/contribute': 'contribute.html', '/censor': 'censor.html', '/adminlogin': 'adminlogin.html', '/how-it-works': 'how-it-works.html', '/dialogPage': 'dialogPage.html' };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export async function startPreview({ port = 0, ...options } = {}) {
    const state = createFixtureState(options);
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname.startsWith('/contribute/')) url.pathname = '/contribute';
        if (url.pathname.startsWith('/rankings/')) url.pathname = '/';
        const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
        try {
            if (url.pathname.startsWith('/api/')) {
                if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                let raw = '';
                for await (const part of request) { raw += part; if (raw.length > 1000000) return send(413, {}); }
                const body = raw ? JSON.parse(raw) : {};
                state.requests.push({ path: url.pathname, body });
                const discussion = discussionFixture(url.pathname, body, state);
                if (discussion !== null) return send(200, discussion);
                if (url.pathname.startsWith('/api/get_page')) return send(200, { categoryTree: categories, currentCategoryID: 1 });
                switch (url.pathname) {
                case '/api/get_user_profile': return send(state.authenticated ? 200 : 204, { userID: state.userID, userName: 'Preview account', hasVerifiedEmail: true, role: state.isSenior ? 'senior' : 'reviewer' });
                case '/api/get_personal_navigation':
                    if (!state.authenticated) return send(401, { error: 'authentication_required' });
                    return send(200, { userID: state.userID, items: state.empty || state.personalEntries.length === 0 ? []
                        : [entryFromContext(workspace(state, { categoryID: 1, contextValues: { budget: 'standard' } }).context)] });
                case '/api/load_benchmarks_and_subcategories': return send(200, { subcategories: categories[0].children });
                case '/api/get_weighted_workspace':
                    await delay(state.workspaceDelay);
                    if (state.workspaceFailure) return send(state.workspaceFailure, { error: 'fixture_workspace_failure' });
                    return send(200, workspace(state, body));
                case '/api/save_personal_pie':
                    await delay(state.saveDelay);
                    if (state.saveFailure) return send(state.saveFailure, { error: state.saveFailure === 409 ? 'pie_revision_conflict' : 'fixture_save_failure' });
                    if (!state.authenticated) return send(401, { error: 'unauthorized' });
                    if (body.expectedRevision !== state.revision) return send(409, { error: 'pie_revision_conflict' });
                    if (state.comparisonModels) comparisonOptions(state.comparisonModels, body.comparison);
                    state.revision += 1;
                    state.personalEntries = weightedEntries(body.entries);
                    state.fallbackRules = body.fallbackRules.map(rule => ({ ...rule, entries: weightedEntries(rule.entries) }));
                    return send(200, workspace(state, body));
                case '/api/get_approved_benchmark_results':
                    await delay(state.evidenceDelay);
                    return send(200, approvedResults(body));
                case '/api/get_contribution_catalog': {
                    const data = catalog();
                    return send(200, data);
                }
                case '/api/get_condition_impact': return send(200, state.conditionImpact ?? { resultCount: 3, pieCount: body.targetKind === 'benchmark' ? 2 : 0 });
                case '/api/get_contribution_target': {
                    const data = catalog();
                    const kind = body.targetKind;
                    const form = kind === 'benchmark' ? data.benchmarks[0] : kind === 'model' ? data.models[0] : { result: { modelID: 301, modelConditionID: 201, benchmarkID: 101, benchmarkConditionID: 1, rawScore: 88, source: { url: 'https://example.com/evidence', type: 'independent', title: 'Synthetic report' } } };
                    if (kind === 'result') form.result.notes = 'Saved score note';
                    else form.notes = 'Saved object note';
                    return send(200, { targetKind: kind, targetID: body.targetID, form });
                }
                case '/api/submit_contribution': return send(200, { ID: 1001, status: 'pending' });
                case '/api/get_device_count': return send(200, { deviceCount: 2 });
                case '/api/logout':
                case '/api/delete_account': state.authenticated = false; return send(200, {});
                case '/api/admin_capabilities': return send(200, { userID: 1, role: state.isSenior ? 'senior' : 'reviewer', isSenior: state.isSenior, messagesAvailable: true });
                case '/api/list_moderation_logs': return send(200, { logs: state.logs.filter(log => !body.status || body.status === 'all' || log.status === body.status) });
                case '/api/review_moderation_log': {
                    const log = state.logs.find(log => log.ID === body.ID);
                    if (log) log.status = body.status;
                    return send(200, {});
                }
                case '/api/admin_data_explorer': return send(200, { entity: 'benchmarks', label: 'Benchmarks', pageSize: 25, entities: [{ key: 'benchmarks', label: 'Benchmarks' }], columns: [{ key: 'ID', label: 'ID' }, { key: 'name', label: 'Name' }], rows: [], total: 0, page: 1, totalPages: 1 });
                case '/api/list_moderation_audit_logs': return send(200, { rows: [], total: 0, page: 1, pageSize: 25, totalPages: 1 });
                case '/api/list_admin_messages': return send(200, { messages: [], unreadCount: 0 });
                case '/api/preview_moderation_sql': return send(200, { sql: '-- Synthetic preview only', previewToken: 'fixture-preview' });
                case '/api/apply_moderation_log':
                case '/api/escalate_moderation_log': return send(200, {});
                default: return send(404, { error: 'unhandled_fixture_endpoint' });
                }
            }
            const pathname = decodeURIComponent(url.pathname);
            const page = pathname.startsWith('/rankings/') ? 'home.html' : pages[pathname];
            const file = page ? resolve(root, 'private', page) : resolve(publicRoot, '.' + pathname);
            // Only an explicit page or a public asset can be served. No root/config/DB files.
            if (!page && (!file.startsWith(publicRoot + sep) || pathname.split('/').some(part => part.startsWith('.')))) return send(403, {});
            const data = await readFile(file);
            response.writeHead(200, { 'content-type': `${types[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
            response.end(data);
        } catch (error) {
            send(error.status ?? (error.code === 'ENOENT' ? 404 : 500), error.body ?? { error: error.code === 'ENOENT' ? 'not_found' : 'fixture_error' });
        }
    });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
