import { entryFromContext } from '../../public/js/navigation/model.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { categories, createFixtureState, weightedEntries, familyEntries, workspace, rankingPage, rankingModelLocation, rankingModelSearch, catalog, approvedResults } from './fixtures.mjs';
import { discussionFixture } from './discussions.mjs';
import { categoryPathParts } from '../../public/js/shared/category-route.js';
import { familyKey } from '../../public/js/shared/benchmark-families.js';
import { requireAccountWriteOwner } from '../../public/js/shared/account-identity.js';
import { readWriteIdentity } from '../../write-idempotency.js';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { assertPrimaryCondition } from '../../benchmark-primary-condition.js';
import { normalizeScoreFieldRequests, normalizeFieldContribution } from '../../score-field-service.js';
import { normalizeModelParameters, modelParameterLabel, parameterRowsToObject } from '../../public/js/shared/model-parameters.js';
import { normalizeDiscussionReport } from '../../discussion-service.js';
import { normalizePrivateCategoryRequest } from '../../private-category-service.js';
import { topicSlug, topicURL } from '../../public/js/shared/topics.js';
import { normalizeTopicRequest } from '../../topic-service.js';
import { topicPreviewComparison, normalizeHomeComparison } from '../../topic-home-service.js';
import { AA_DISPLAY_RESTRICTION } from '../../public/js/shared/aa-ranking-policy.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = resolve(root, 'public');
const pages = { '/': 'home.html', '/contribute': 'contribute.html', '/censor': 'censor.html', '/adminlogin': 'adminlogin.html', '/how-it-works': 'how-it-works.html', '/privacy': 'privacy.html', '/terms': 'terms.html', '/dialogPage': 'dialogPage.html', '/account/privacy': 'account-privacy.html' };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
let parsedServerSource, parseSubmission;

function realSubmissionParser(source) {
    if (parsedServerSource === source) return parseSubmission;
    const contract = source.slice(source.indexOf('function normalizeString('), source.indexOf('function parseModerationContent('));
    const endpoint = source.slice(source.indexOf("API.post('/submit_contribution'"));
    const prefix = endpoint.slice(endpoint.indexOf('=> {') + 4, endpoint.indexOf('const connection = await db.getConnection();'));
    const sandbox = vm.createContext({ assertPrimaryCondition, normalizeScoreFieldRequests, normalizeFieldContribution,
        normalizeModelParameters, modelParameterLabel, parameterRowsToObject, normalizeDiscussionReport, URL, crypto, structuredClone });
    vm.runInContext(`${contract}\nthis.parseSubmission = body => { const req = { body }; ${prefix}\nreturn content; };`, sandbox);
    parsedServerSource = source;
    parseSubmission = sandbox.parseSubmission;
    return parseSubmission;
}

export async function startPreview({ port = 0, ...options } = {}) {
    const state = createFixtureState(options);
    const serverSource = await readFile(resolve(root, 'server.js'), 'utf8');
    const validateSubmission = realSubmissionParser(serverSource);
    const ownerProtectedPaths = new Set([...serverSource.matchAll(/API\.post\('(\/[^']+)',[^\n]*\brequireAccountWriteOwner\b/g)]
        .map(match => `/api${match[1]}`));
    const pieReceipts = new Map();
    const topicMetadata = category => ({ ...category, categoryID: category.ID, categoryName: category.name,
        description: category.description ?? `Compare models on ${category.name.toLowerCase()} tasks.`,
        slug: category.slug || topicSlug(category.name), url: topicURL(category.ID, category.name, category.isPrivate === true, category.slug || topicSlug(category.name)),
        lineage: [{ ID: category.ID, name: category.name }], contextValues: {}, dimensions: [],
        isMine: category.isMine === true, configured: state.authenticated && category.ID === 1 && !state.empty && state.personalEntries.length > 0,
        creator: { name: 'BenchPoll', avatarURL: '/assets/benchpoll-mark.svg' } });
    const publicTopics = () => [categories[0], ...categories[0].children, ...(state.newTopics ?? []).filter(topic => !topic.isPrivate)];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname.startsWith('/contribute/')) url.pathname = '/contribute';
        const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
        try {
            if (url.pathname.startsWith('/api/')) {
                if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                let raw = '';
                for await (const part of request) { raw += part; if (raw.length > 1000000) return send(413, {}); }
                let body = raw ? JSON.parse(raw) : {};
                state.requests.push({ path: url.pathname, body });
                if (ownerProtectedPaths.has(url.pathname)) {
                    const guardedRequest = { session: { userID: state.authenticated ? state.userID : null }, body };
                    let guardError;
                    requireAccountWriteOwner(guardedRequest, {}, error => { guardError = error; });
                    if (guardError) throw guardError;
                    body = guardedRequest.body;
                }
                const discussion = discussionFixture(url.pathname, body, state);
                if (discussion !== null) return send(200, discussion);
                if (url.pathname.startsWith('/api/get_page')) return send(200, { categoryTree: categories, currentCategoryID: 1 });
                switch (url.pathname) {
                case '/api/locate_ranking_model': return send(200, rankingModelLocation(state, body));
                case '/api/search_ranking_models': return send(200, rankingModelSearch(state, body));
                case '/api/get_topic': {
                    const selected = publicTopics().find(topic => body.slug ? topicSlug(topic.name) === body.slug : topic.ID === Number(body.categoryID));
                    return selected ? send(200, topicMetadata(selected)) : send(404, { error: 'topic_not_found' });
                }
                case '/api/get_topics': return send(200, { topics: [...publicTopics(),
                    ...(state.authenticated ? (state.newTopics ?? []).filter(topic => topic.isPrivate) : [])].map(topicMetadata), featuredTopicID: 54 });
                case '/api/create_topic': {
                    if (!state.authenticated) return send(401, { error: 'authentication_required' });
                    const topic = normalizeTopicRequest(body);
                    const created = { ...topic, ID: 1000 + (state.newTopics?.length ?? 0), isMine: true };
                    state.newTopics ??= []; state.newTopics.push(created);
                    if (topic.isPrivate) {
                        state.privateCategories ??= [];
                        state.privateCategories.push({ ...entryFromContext({ ...topicMetadata(created), categoryID: created.ID }), userID: state.userID });
                    }
                    return send(201, topicMetadata(created));
                }
                case '/api/get_category_navigation': {
                    return send(200, { items: publicTopics().map(category => entryFromContext(topicMetadata(category))) });
                }
                case '/api/get_user_profile': return send(state.authenticated ? 200 : 204, { userID: state.userID, userName: 'Preview account', hasVerifiedEmail: true, reviewEmailEnabled: options.reviewEmailEnabled === true, role: state.isSenior ? 'senior' : 'reviewer' });
                case '/api/get_comparison_profiles': return send(200, state.authenticated
                    ? { authenticated: true, userID: state.userID, last: state.comparisonLast, profiles: state.comparisonProfiles }
                    : { authenticated: false, last: null, profiles: [] });
                case '/api/save_comparison_profile': {
                    if (!state.authenticated) return send(401, { error: 'authentication_required' });
                    if (body.name === undefined) state.comparisonLast = body.comparison;
                    else {
                        const index = state.comparisonProfiles.findIndex(profile => profile.name.toLowerCase() === body.name.toLowerCase());
                        if (index === -1) state.comparisonProfiles.push({ name: body.name, comparison: body.comparison });
                        else state.comparisonProfiles[index] = { name: body.name, comparison: body.comparison };
                    }
                    return send(200, { name: body.name ?? '', comparison: body.comparison });
                }
                case '/api/delete_comparison_profile':
                    state.comparisonProfiles = state.comparisonProfiles.filter(profile => profile.name !== body.name);
                    return send(200, { deleted: true });
                case '/api/rename_comparison_profile': {
                    const profile = state.comparisonProfiles.find(item => item.name.toLowerCase() === body.name.toLowerCase());
                    if (!profile) return send(404, { error: 'comparison_profile_not_found' });
                    if (state.comparisonProfiles.some(item => item !== profile && item.name.toLowerCase() === body.newName.toLowerCase())) return send(409, { error: 'comparison_profile_name_exists' });
                    profile.name = body.newName;
                    return send(200, { name: body.newName });
                }
                case '/api/get_personal_navigation':
                    if (!state.authenticated) return send(401, { error: 'authentication_required' });
                    return send(200, { userID: state.userID, items: state.empty || state.personalEntries.length === 0 ? []
                        : [{ ...entryFromContext(workspace(state, { categoryID: 1, contextValues: { budget: 'standard' } }).context), weightCount: state.personalEntries.length }] });
                case '/api/create_private_category': {
                    normalizePrivateCategoryRequest(body);
                    const entry = entryFromContext({ categoryID: 999, categoryName: body.name, isPrivate: true,
                        description: body.description, creator: { name: 'BenchPoll', avatarURL: '/assets/benchpoll-mark.svg' },
                        lineage: [{ ID: 999, name: body.name }], contextValues: {} });
                    state.privateCategories ??= [];
                    state.privateCategories.push({ ...entry, userID: state.userID });
                    return send(201, entry);
                }
                case '/api/load_benchmarks_and_subcategories': return send(200, { subcategories: categories[0].children });
                case '/api/get_weighted_workspace':
                    await delay(state.workspaceDelay);
                    if (state.workspaceFailure) return send(state.workspaceFailure, { error: 'fixture_workspace_failure' });
                    if (body.homeComparison !== undefined) body.comparison = topicPreviewComparison(state.comparisonFields ?? [], normalizeHomeComparison(body.homeComparison));
                    return send(200, workspace(state, body));
                case '/api/get_ranking_page': return send(200, rankingPage(state, body));
                case '/api/save_personal_pie': {
                    const key = readWriteIdentity(request);
                    const intent = JSON.stringify(body);
                    const stored = pieReceipts.get(`${state.userID}:${key}`);
                    if (stored) {
                        if (stored.intent !== intent) return send(409, { error: 'write_identity_reused' });
                        return send(200, stored.receipt);
                    }
                    await delay(state.saveDelay);
                    if (state.saveFailure) return send(state.saveFailure, { error: state.saveFailure === 409 ? 'pie_revision_conflict' : 'fixture_save_failure' });
                    if (!state.authenticated) return send(401, { error: 'unauthorized' });
                    if (body.expectedRevision !== state.revision) return send(409, { error: 'pie_revision_conflict' });
                    state.revision = body.entries.length ? state.revision + 1 : 0;
                    state.personalEntries = weightedEntries(body.entries);
                    state.fallbackRules = body.fallbackRules.map(rule => {
                        if (!rule.entries.length) return { ...rule, familyID: null };
                        const key = familyKey(rule.primaryConditionID, rule.entries);
                        let family = state.families.find(value => familyKey(value.primaryConditionID, value.entries) === key);
                        if (!family) {
                            family = { ...rule, familyID: Math.max(0, ...state.families.map(value => value.familyID)) + 1,
                                entries: familyEntries(rule.entries, rule.primaryConditionID) };
                            state.families.push(family);
                        }
                        return { ...structuredClone(family), selectionSource: rule.selectionSource ?? 'selected' };
                    });
                    const receipt = { saved: true, requestKey: key, userID: state.userID,
                        categoryID: body.categoryID, contextValues: body.contextValues,
                        personalPie: { revision: state.revision, entries: body.entries, fallbackRules: body.fallbackRules } };
                    pieReceipts.set(`${state.userID}:${key}`, { intent, receipt });
                    return send(200, receipt);
                }
                case '/api/get_approved_benchmark_results':
                    await delay(state.evidenceDelay);
                    return send(200, { ...approvedResults(body), ...(!body.expectedEvidence
                        ? { displayPolicy: AA_DISPLAY_RESTRICTION, displayRestriction: null } : {}) });
                case '/api/get_model_score_configurations':
                    return send(200, { displayPolicy: AA_DISPLAY_RESTRICTION, omittedConfigurations: [], configurations: body.modelIDs.map(modelID => ({ modelID,
                        modelName: `Model ${modelID}`, configurationName: '', scoreFields: [], scoreCount: 10,
                        ...(body.includeVersions ? { scoreGroups: approvedResults({ modelID, scoreFields: [] }).scoreGroups.map(({ samples, evidenceHash, ...group }) => group) } : {}) })) });
                case '/api/get_contribution_catalog': {
                    const data = catalog(state);
                    for (const option of state.fieldOptions ?? []) data.scoreFields.find(field => field.ID === option.fieldID)?.options.push(option);
                    return send(200, data);
                }
                case '/api/get_benchmark_information': {
                    const data = catalog(state);
                    const benchmark = data.benchmarks.find(item => item.conditions.some(condition => condition.ID === body.conditionID));
                    if (!benchmark) return send(404, { error: 'benchmark_condition_unavailable' });
                    const condition = benchmark.conditions.find(item => item.ID === body.conditionID);
                    return send(200, { benchmarkID: benchmark.ID, conditionID: condition.ID, name: benchmark.name,
                        conditionName: condition.name, isPrimaryCondition: condition.isPrimary, differenceExplanation: condition.differenceExplanation, description: benchmark.description, requestOfficialSync: false,
                        scoreSource: condition.scoreSource, introductionURL: state.benchmarkInfoURL ?? '', scoresUpdatedAt: '2026-10-03T06:00:00Z' });
                }
                case '/api/get_condition_impact': return send(200, state.conditionImpact ?? { resultCount: 3, pieCount: body.targetKind === 'benchmark' ? 2 : 0 });
                case '/api/get_benchmark_scores': {
                    const benchmark = catalog(state).benchmarks.find(item => item.ID === body.benchmarkID);
                    const selected = benchmark?.conditions.find(item => item.ID === body.conditionID);
                    if (!selected) return send(404, { error: 'benchmark_condition_unavailable' });
                    const total = selected.isPrimary ? 55 : 2;
                    const scores = Array.from({ length: total }, (_, index) => ({ ID: 2000 - index, rawScore: 88.5 - index,
                        modelID: 301 + index, modelName: `Model ${index + 1}`, vendorName: 'OpenAI', vendorSlug: 'openai', logoKey: 'openai',
                        createdAt: '2026-10-03T06:00:00Z', sourceURL: 'https://example.com/evidence', sourceTitle: 'Official report',
                        fields: [{ name: 'Harness', value: 'Agent A' }, { name: 'Thinking', value: 'Present' }] }))
                        .filter(score => !body.beforeID || score.ID < body.beforeID);
                    return send(200, { benchmarkID: body.benchmarkID, conditionID: body.conditionID,
                        conditions: benchmark.conditions.map(condition => ({ ...condition, scoreCount: condition.isPrimary ? 55 : 2 })),
                        scores: scores.slice(0, 50), nextBeforeID: scores.length > 50 ? scores[49].ID : null });
                }
                case '/api/get_contribution_target': {
                    const data = catalog(state);
                    const kind = body.targetKind;
                    const form = kind === 'benchmark' ? data.benchmarks[0] : kind === 'model' ? data.models[0] : { result: { modelID: 301, scoreFields: [], benchmarkID: 101, benchmarkConditionID: 1, rawScore: 88, source: { url: 'https://example.com/evidence', type: 'third_party_lab', title: 'Synthetic report' } } };
                    if (kind === 'result') form.result.notes = 'Saved score note';
                    else form.notes = 'Saved object note';
                    return send(200, { targetKind: kind, targetID: body.targetID, form });
                }
                case '/api/submit_contribution':
                    validateSubmission(body);
                    if (body.type === 'score_field_option') {
                        state.fieldOptions ??= [];
                        state.fieldOptions.push({ ID: null, requestID: 1001 + state.fieldOptions.length, pending: true, fieldID: body.fieldID, label: body.label, excluded: body.excluded });
                    }
                    return send(200, { ID: 1001, status: 'pending' });
                case '/api/get_device_count': return send(200, { deviceCount: 2 });
                case '/api/logout':
                case '/api/delete_account': state.authenticated = false; return send(200, {});
                case '/api/admin_capabilities': return send(200, { userID: state.userID, role: state.isSenior ? 'senior' : 'reviewer', isSenior: state.isSenior, messagesAvailable: true });
                case '/api/list_moderation_logs': return send(200, { logs: state.logs.filter(log => !body.status || body.status === 'all' || log.status === body.status) });
                case '/api/review_moderation_log': {
                    const log = state.logs.find(log => log.ID === body.ID);
                    if (log) log.status = body.status;
                    return send(200, {});
                }
                case '/api/admin_data_explorer': return send(200, { entity: 'benchmarks', label: 'Benchmarks', pageSize: 25, entities: [{ key: 'benchmarks', label: 'Benchmarks' }], columns: [{ key: 'ID', label: 'ID' }, { key: 'name', label: 'Name' }], rows: [], total: 0, page: 1, totalPages: 1 });
                case '/api/list_moderation_audit_logs': return send(200, { rows: [], total: 0, page: 1, pageSize: 25, totalPages: 1 });
                case '/api/list_score_sync_conflicts': return send(200, { conflicts: state.syncConflicts ?? [], hasMore: false });
                case '/api/resolve_score_sync_conflict': {
                    const conflict = (state.syncConflicts ?? []).find(row => row.row_key === body.rowKey
                        && row.result_ID === body.resultID && row.incoming_hash === body.incomingHash);
                    if (!conflict) return send(409, { error: 'sync_conflict_changed' });
                    if (body.choice === 'correction') state.syncConflicts = state.syncConflicts.filter(row => row !== conflict);
                    else conflict.status = 'accept_source';
                    return send(200, { status: body.choice === 'correction' ? 'kept_correction' : 'accept_source', auditID: 1 });
                }
                case '/api/list_admin_messages': return send(200, { messages: state.adminMessages ?? [], unreadCount: 0 });
                case '/api/mark_admin_message_read': {
                    const message = (state.adminMessages ?? []).find(item => item.ID === body.messageID);
                    if (message) message.isRead = true;
                    return send(200, { messageID: body.messageID, isRead: true });
                }
                case '/api/send_admin_message': return send(200, { messageID: 1, auditID: 1 });
                case '/api/preview_moderation_sql': return send(200, { sql: '-- Synthetic preview only', previewToken: 'fixture-preview' });
                case '/api/apply_moderation_log': return send(200, { status: 'approved' });
                case '/api/escalate_moderation_log': return send(200, { status: 'escalated' });
                default: return send(404, { error: 'unhandled_fixture_endpoint' });
                }
            }
            const pathname = decodeURIComponent(url.pathname);
            let page = pathname === '/' && options.topicHome === true ? 'index.html' : pages[pathname];
            if (!page) {
                try {
                    const parts = categoryPathParts(url.pathname);
                    if (['All-Categories', 'Language-models', 'Intelligence', 'Creation', 'AGI'].includes(parts[0])
                        || publicTopics().some(topic => topicSlug(topic.name) === parts[0])) page = 'home.html';
                } catch { /* Reserved paths are pages or public assets, never categories. */ }
            }
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
