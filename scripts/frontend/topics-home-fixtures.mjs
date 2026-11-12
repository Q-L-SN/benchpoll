import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchRankedModels } from '../../ranking-pagination.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
export const fixtureWeights = [
    ['GPQA Diamond', '2026', 2800], ['SWE-bench Verified', 'Agent v2', 2100], ['MMLU-Pro', 'Default', 1700],
    ['AIME', '2026', 1300], ['LiveCodeBench', 'v6', 900], ['Terminal-Bench', '2.0', 600], ['Humanity\'s Last Exam', '', 400],
    ['Small benchmark A', 'v1', 90], ['Small benchmark B', '', 60], ['Small benchmark C', '', 30], ['Small benchmark D', '', 20]
].map(([name, conditionName, weightBasisPoints], index) => ({ conditionID: index + 1, name, conditionName, weightBasisPoints }));

const vendors = [
    ['openai', 'OpenAI', 'GPT-5'], ['anthropic', 'Anthropic', 'Claude Sonnet 4.5'], ['google', 'Google', 'Gemini 2.5 Pro'],
    ['deepseek', 'DeepSeek', 'DeepSeek V3.2'], ['meta', 'Meta', 'Llama 4'], ['mistral', 'Mistral AI', 'Mistral Large'],
    ['qwen', 'Alibaba Qwen', 'Qwen3'], ['xai', 'xAI', 'Grok 4']
];
export const fixtureTopics = ['Coding', 'Science', 'Math', 'Writing', 'Vision', 'Research', 'Translation', 'Audio', 'Tool use',
    'Everyday assistance', 'Safety', 'Data analysis', 'Long context', 'Creative work', 'Open models', 'General intelligence']
    .map((name, index) => {
        const ID = index === 10 ? 54 : index + 1;
        const isPrivate = index === 14, isOfficial = !isPrivate && (index % 3 === 0 || index === 10);
        const publicID = isPrivate ? null : index === 10 ? 1 : index + 2;
        const privateID = isPrivate ? 'FixturePrivate15' : null;
        return { ID, categoryID: ID, publicID, privateID, name: index === 10 ? 'Intelligence' : name,
            url: isPrivate ? `/private/${privateID}` : `/${publicID}`,
            description: `Community weights for ${index === 10 ? 'intelligence' : name.toLowerCase()}.`, isPrivate, isOfficial,
            isMine: !isOfficial, configured: index % 4 === 1, configurationCount: 12 + index,
            favoriteCount: index === 10 ? 48 : 32 - index, isFavorited: index % 5 === 0,
            coverageIndex: null, editRevision: `fixture-${ID}-1`, scenes: [],
            creator: isOfficial ? null : { id: '42', publicID: '42', handle: '42', name: 'Alex Chen', url: '/@42', avatarURL: '/assets/apple-touch-icon.png' },
            hasWeights: index !== 7 };
    }).sort((a, b) => b.favoriteCount - a.favoriteCount);

function comparison(body) {
    const keys = ['model'];
    const fields = [];
    if (body.reasoning) { keys.push('field:1'); fields.push({ ID: 1, name: 'Reasoning effort', type: 'text' }); }
    if (body.harness) { keys.push('field:2'); fields.push({ ID: 2, name: 'Agent harness', type: 'text' }); }
    return { keys, fields, models: [], availableKeys: ['model', 'field:1', 'field:2'] };
}

export function fixtureModels(body) {
    const count = body.categoryID === 2 ? 3 : body.categoryID === 3 ? 6 : body.categoryID === 8 || body.categoryID === 9 ? 0 : 37;
    return Array.from({ length: count }, (_, index) => {
        const [vendorSlug, vendorName, baseName] = vendors[index % vendors.length];
        const name = index < 8 ? baseName : `${baseName} ${Math.floor(index / 8) + 1}`;
        const lower = body.categoryID === 2 ? [100, 3, 0][index] : body.categoryID === 3 ? [100, 16, 14, 11, 3, 0][index]
            : Math.max(0, 100 - index * 2.4 - (body.reasoning ? 3 : 0) - (body.harness ? 2 : 0));
        const identity = [['model', true, index + 1]];
        if (body.reasoning) identity.push(['field:1', true, index % 2 ? 'max' : 'high']);
        if (body.harness) identity.push(['field:2', true, index % 2 ? 'Mini-SWE-Agent 2026.10 long harness name' : 'Agent v2']);
        const groupName = [body.reasoning ? `Reasoning effort=${index % 2 ? 'max' : 'high'}` : '',
            body.harness ? `Harness=${index % 2 ? 'Mini-SWE-Agent 2026.10 long harness name' : 'Agent v2'}` : '', name].filter(Boolean).join(' / ');
        return { modelID: index + 1, rank: index + 1, name: groupName, modelName: name, vendorSlug, vendorName, logoKey: vendorSlug,
            lower, upper: body.scoreMode === 'range' ? Math.min(100, lower + 14) : lower,
            coverage: 87.4, comparable: true, comparisonIdentity: JSON.stringify(identity) };
    });
}

export async function startTopicsPreview(options = {}) {
    const serverRoot = resolve(options.root ?? process.env.TOPICS_HOME_ROOT ?? root);
    const built = options.built ?? process.env.TOPICS_HOME_BUILT === '1';
    const publicRoot = resolve(serverRoot, 'public');
    const entryFile = resolve(serverRoot, built ? 'private/index-built.html' : 'private/index.html');
    const state = { topics: structuredClone(fixtureTopics), requests: [], active: 0, maxActive: 0, created: [],
        authenticated: options.authenticated ?? true, previewDelay: options.previewDelay ?? 65,
        topicsDelay: options.topicsDelay ?? 0, profileDelay: options.profileDelay ?? 0, topicsFailures: 0,
        failures: new Map(), previewRevisions: new Map(), previewOverrides: new Map(), createError: null, pageSize: options.pageSize ?? 25,
        profile: { userID: '42', publicID: '42', userName: 'Alex Chen', userProfilePictureURL: '/assets/apple-touch-icon.png',
            defaultUserProfilePictureURL: '/assets/apple-touch-icon.png', hasCustomDisplayName: false, hasCustomAvatar: false } };
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const send = (status, value) => {
            if (response.destroyed) return;
            response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(status === 204 ? undefined : JSON.stringify(value));
        };
        try {
            if (url.pathname.startsWith('/api/')) {
                if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                let raw = '';
                for await (const part of request) raw += part;
                const body = raw ? JSON.parse(raw) : {};
                const record = { path: url.pathname, body, started: Date.now() }; state.requests.push(record);
                const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
                if (url.pathname === '/api/get_topics') {
                    await wait(state.topicsDelay);
                    if (state.topicsFailures > 0) { state.topicsFailures--; return send(503, { error: 'fixture_topics_failure' }); }
                    return send(200, { topics: state.topics.filter(topic => state.authenticated || !topic.isPrivate)
                        .map(topic => state.authenticated ? topic : { ...topic, isMine: false, configured: false }), featuredTopicID: 54 });
                }
                if (url.pathname === '/api/get_user_profile') {
                    await wait(state.profileDelay);
                    return send(state.authenticated ? 200 : 204, state.authenticated
                        ? state.profile : null);
                }
                if (url.pathname === '/api/get_privacy_status') return send(state.authenticated ? 200 : 401,
                    state.authenticated ? { csrfToken: 'fixture-topics-csrf' } : { error: 'authentication_required' });
                if (['/api/set_topic_favorite', '/api/set_topic_visibility', '/api/save_private_topic', '/api/delete_private_topic'].includes(url.pathname)) {
                    if (!state.authenticated) return send(401, { error: 'authentication_required' });
                    if (body.expectedUserID !== state.profile.userID) return send(409, { error: 'account_changed' });
                    if (body.csrfToken !== 'fixture-topics-csrf') return send(403, { error: 'invalid_csrf_token' });
                }
                if (url.pathname === '/api/set_topic_favorite') {
                    const topic = state.topics.find(item => item.ID === Number(body.categoryID));
                    if (!topic || typeof body.isFavorited !== 'boolean') return send(404, { error: 'topic_not_found' });
                    topic.favoriteCount = Math.max(0, topic.favoriteCount + Number(body.isFavorited) - Number(topic.isFavorited === true));
                    topic.isFavorited = body.isFavorited;
                    return send(200, { categoryID: topic.ID, favoriteCount: topic.favoriteCount, isFavorited: topic.isFavorited });
                }
                if (url.pathname === '/api/get_private_topic_editor') {
                    const topic = state.topics.find(item => item.ID === Number(body.categoryID));
                    return topic?.isMine && state.authenticated ? send(200, topic) : send(404, { error: 'private_topic_not_found' });
                }
                if (url.pathname === '/api/set_topic_visibility') {
                    const topic = state.topics.find(item => item.ID === Number(body.categoryID));
                    if (!topic?.isMine) return send(404, { error: 'topic_not_found' });
                    topic.isPrivate = !body.isPublic;
                    if (topic.isPrivate) topic.privateID ??= `FixturePrivate${topic.ID}`;
                    else topic.publicID ??= topic.ID + 100;
                    topic.url = topic.isPrivate ? `/private/${topic.privateID}` : `/${topic.publicID}`;
                    return send(200, topic);
                }
                if (url.pathname === '/api/delete_private_topic') {
                    const topic = state.topics.find(item => item.ID === Number(body.categoryID));
                    if (!topic?.isMine) return send(404, { error: 'private_topic_not_found' });
                    if (!topic.isPrivate) return send(409, { error: 'make_topic_private_before_deleting' });
                    state.topics = state.topics.filter(item => item !== topic);
                    return send(200, { categoryID: topic.ID, deleted: true });
                }
                if (url.pathname === '/api/get_device_count') return send(state.authenticated ? 200 : 401,
                    state.authenticated ? { deviceCount: 2 } : { error: 'authentication_required' });
                if (url.pathname === '/api/logout') {
                    if (!state.authenticated) return send(401, { error: 'authentication_required' });
                    if (body.expectedUserID !== state.profile.userID) return send(409, { error: 'account_changed' });
                    state.authenticated = false; return send(200, { success: true });
                }
                if (url.pathname === '/api/save_user_profile') {
                    if (!state.authenticated) return send(401, { error: 'authentication_required' });
                    if (body.expectedUserID !== state.profile.userID) return send(409, { error: 'account_changed' });
                    const oldName = state.profile.userName;
                    if (body.displayName) { state.profile.userName = body.displayName; state.profile.hasCustomDisplayName = true; }
                    if (body.avatar) { state.profile.userProfilePictureURL = body.avatar; state.profile.hasCustomAvatar = true; }
                    for (const topic of state.topics) if (topic.creator?.name === oldName) {
                        topic.creator.name = state.profile.userName; topic.creator.avatarURL = state.profile.userProfilePictureURL;
                    }
                    return send(200, state.profile);
                }
                if (url.pathname === '/api/get_topic_preview') {
                    state.active++; state.maxActive = Math.max(state.active, state.maxActive);
                    let ended = false;
                    const end = () => { if (!ended) { ended = true; state.active--; record.ended = Date.now(); } };
                    response.once('finish', end); response.once('close', end);
                    await wait(typeof state.previewDelay === 'function' ? state.previewDelay(body) : state.previewDelay);
                    if (response.destroyed) return;
                    const failures = state.failures.get(body.categoryID) ?? 0;
                    if (failures > 0) { state.failures.set(body.categoryID, failures - 1); return send(503, { error: 'fixture_preview_failure' }); }
                    const key = `${body.categoryID}:${body.scoreMode}:${body.reasoning}:${body.harness}:${body.availableInferenceVersion ?? 4}`;
                    const revision = state.previewRevisions.get(body.categoryID) ?? 0;
                    const snapshotID = `snapshot:${key}${revision ? ':v' + revision : ''}`;
                    const override = state.previewOverrides.get(body.categoryID) ?? {};
                    const models = override.models ?? fixtureModels(body);
                    const offset = body.offset ?? 0;
                    if (body.snapshotID && body.snapshotID !== snapshotID) return send(410, { error: 'ranking_snapshot_expired' });
                    const endOffset = Math.min(models.length, offset + state.pageSize);
                    const result = { topicID: body.categoryID, models: models.slice(offset, endOffset),
                        pagination: { snapshotID, offset, nextOffset: endOffset, hasMore: endOffset < models.length, total: models.length } };
                    if (!body.snapshotID) Object.assign(result, { contextValues: override.contextValues ?? (body.sceneID ? { scene: String(body.sceneID) } : {}), comparison: override.comparison ?? comparison(body),
                        weights: override.weights ?? (body.categoryID === 8 ? [] : fixtureWeights), scoreScale: override.scoreScale ?? { min: 0, max: 100 } });
                    return send(200, result);
                }
                if (url.pathname === '/api/search_home_models') {
                    const args = { ...body, categoryID: 54, scoreMode: 'available' };
                    const models = (state.previewOverrides.get(54) ?? {}).models ?? fixtureModels(args);
                    return send(200, { items: searchRankedModels(models, comparison(args), body.query) });
                }
                if (url.pathname === '/api/locate_topic_model') {
                    const models = (state.previewOverrides.get(body.categoryID) ?? {}).models ?? fixtureModels(body);
                    const key = `${body.categoryID}:${body.scoreMode}:${body.reasoning}:${body.harness}:${body.availableInferenceVersion ?? 4}`;
                    const revision = state.previewRevisions.get(body.categoryID) ?? 0;
                    const snapshotID = `snapshot:${key}${revision ? ':v' + revision : ''}`;
                    if (body.snapshotID !== snapshotID) return send(410, { error: 'ranking_snapshot_expired' });
                    const targetOffset = models.findIndex(model => model.comparisonIdentity === body.targetModel);
                    if (targetOffset < 0) return send(200, { topicID: body.categoryID, snapshotID, targetModel: body.targetModel, found: false });
                    const size = state.pageSize * 3;
                    const offset = Math.max(0, Math.min(targetOffset - Math.floor(size / 2), models.length - size));
                    const nextOffset = Math.min(models.length, offset + size);
                    return send(200, { topicID: body.categoryID, targetModel: body.targetModel, targetOffset, found: true,
                        models: models.slice(offset, nextOffset), pagination: { snapshotID, offset, nextOffset,
                            hasMore: nextOffset < models.length, total: models.length } });
                }
                if (url.pathname === '/api/save_private_topic') {
                    if (state.createError) return send(state.createError.status, { error: state.createError.error });
                    const previous = body.categoryID == null ? null : state.topics.find(item => item.ID === Number(body.categoryID) && item.isMine);
                    if (body.categoryID != null && !previous) return send(404, { error: 'private_topic_not_found' });
                    const ID = previous?.ID ?? 200 + state.created.length;
                    const privateID = previous?.privateID ?? `FixturePrivate${ID}`;
                    const scenes = (body.scenes ?? []).map((scene, index) => ({ ...scene, ID: scene.ID ?? ID * 100 + index + 1,
                        contextID: scene.ID ?? ID * 100 + index + 1, sceneNumber: index + 1, isDefault: scene.key === body.defaultSceneKey }));
                    const topic = { ID, categoryID: ID, publicID: null, privateID, isPrivate: true, isOfficial: false, isMine: true, configured: false,
                        favoriteCount: 0, isFavorited: false, coverageIndex: null, configurationCount: 0,
                        creator: { id: '42', publicID: '42', handle: '42', name: 'Alex Chen', url: '/@42', avatarURL: '/assets/apple-touch-icon.png' },
                        ...previous, name: body.name, description: body.description, scenes, editRevision: `fixture-${ID}-${Date.now()}` };
                    const base = topic.isPrivate ? `/private/${privateID}` : `/${topic.publicID}`;
                    for (const scene of scenes) scene.url = `${base}/${scene.sceneNumber}`;
                    topic.url = scenes.find(scene => scene.isDefault)?.url ?? base;
                    if (previous) state.topics[state.topics.indexOf(previous)] = topic;
                    else { state.created.push(topic); state.topics.unshift(topic); }
                    return send(previous ? 200 : 201, topic);
                }
                return send(404, { error: 'fixture_route_not_found' });
            }
            const target = state.topics.find(topic => [topic.url, ...(topic.scenes ?? []).map(scene => scene.url)].filter(Boolean)
                .some(href => new URL(href, 'http://fixture.local').pathname === url.pathname));
            if (target) {
                if (target.isPrivate && !state.authenticated) return send(404, { error: 'not_found' });
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end('<!doctype html><html lang="en"><title>Topic target fixture</title><body><h1>Topic target fixture</h1></body></html>'); return;
            }
            const file = url.pathname === '/' ? entryFile : resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
            if (file !== entryFile && !file.startsWith(publicRoot + sep)) return send(403, {});
            const data = await readFile(file);
            response.writeHead(200, { 'content-type': `${types[extname(file)] ?? 'application/octet-stream'}${['.html', '.js', '.css', '.svg'].includes(extname(file)) ? '; charset=utf-8' : ''}`, 'cache-control': 'no-store',
                'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
            response.end(data);
        } catch (error) { send(error.code === 'ENOENT' ? 404 : 500, { error: error.message }); }
    });
    await new Promise(resolveListen => server.listen(options.port ?? 0, '127.0.0.1', resolveListen));
    return { state, server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const app = await startTopicsPreview({ port: Number(process.env.TOPICS_HOME_PORT || 0) });
    console.log(`Local topics fixture (${process.env.TOPICS_HOME_BUILT === '1' ? 'built' : 'source'}): ${app.url}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
}
