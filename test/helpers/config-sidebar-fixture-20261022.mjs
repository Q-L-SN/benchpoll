import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtureState, workspace, rankingPage, catalog, approvedResults } from '../../scripts/frontend/fixtures.mjs';
import { discussionFixture } from '../../scripts/frontend/discussions.mjs';
import { entryFromContext } from '../../public/js/navigation/model.js';
import { topicURL, topicSlug, isReservedTopicSlug } from '../../public/js/shared/topics.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = resolve(root, 'public');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

export async function startConfigSidebarPreview({ port = 0 } = {}) {
    const state = createFixtureState();
    const topics = [{ ID: 54, name: 'Intelligence', slug: 'intelligence', popularity: 1 },
        { ID: 167, name: 'Research', slug: 'research', popularity: 40, ownerUserID: '1' },
        { ID: 170, name: 'Biology and Medicine', slug: 'biology-and-medicine', popularity: 90, ownerUserID: '2' },
        { ID: 190, name: 'Secondary research', slug: 'secondary-research', popularity: 8, ownerUserID: '2' },
        { ID: 998, name: 'Empty private topic', slug: 'empty-private-topic', isPrivate: true, ownerUserID: '1' }];
    let profile = { userID: '1', userName: 'Preview account', hasCustomDisplayName: false,
        hasCustomAvatar: false, userProfilePictureURL: '', role: 'reviewer' };
    let nextPrivateID = 999;
    const metadata = topic => ({ ...topic, categoryID: topic.ID, categoryName: topic.name,
        isMine: state.authenticated && topic.ownerUserID === state.userID,
        configured: state.authenticated && !state.navigationEmpty && [54, 167, 190].includes(topic.ID),
        url: topicURL(topic.ID, topic.name, topic.isPrivate, topic.slug), path: topicURL(topic.ID, topic.name, topic.isPrivate, topic.slug).slice(1),
        lineage: [{ ID: topic.ID, name: topic.name }], contextValues: {}, dimensions: [] });
    const findTopic = ID => topics.find(topic => topic.ID === Number(ID));
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const send = (status, json) => {
            response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(status === 204 ? '' : JSON.stringify(json));
        };
        try {
            if (url.pathname.startsWith('/api/')) {
                let raw = '';
                for await (const chunk of request) raw += chunk;
                const body = raw ? JSON.parse(raw) : {};
                state.requests.push({ path: url.pathname, body });
                const topic = findTopic(body.categoryID) ?? topics.find(value => value.slug === body.slug) ?? topics[0];
                if (url.pathname.startsWith('/api/get_page')) {
                    const ID = url.pathname.match(/\/topics\/(\d+)/)?.[1];
                    const selected = findTopic(ID) ?? topics.find(value => metadata(value).url === url.pathname.slice('/api/get_page'.length)) ?? topics[0];
                    return send(200, { categoryTree: topics.filter(value => !value.isPrivate).map(metadata), currentCategoryID: selected.ID, topic: metadata(selected) });
                }
                switch (url.pathname) {
                case '/api/get_topics':
                    if (state.catalogueFailure) return send(state.catalogueFailure, { error: 'fixture_catalogue_failure' });
                    await delay(state.catalogueDelay ?? 0);
                    return send(200, { featuredTopicID: 54,
                        topics: topics.filter(value => !value.isPrivate || value.ownerUserID === state.userID)
                            .map(value => ({ ...metadata(value), isMine: state.mineEmpty ? false : metadata(value).isMine })) });
                case '/api/get_topic':
                case '/api/get_private_category':
                    if (!findTopic(body.categoryID) && !topics.some(value => value.slug === body.slug)) return send(404, { error: 'category_not_found' });
                    if (topic.isPrivate && topic.ownerUserID !== state.userID) return send(403, { error: 'category_not_found' });
                    return send(200, metadata(topic));
                case '/api/get_category_navigation': {
                    const items = topics.filter(value => !value.isPrivate).map(value => ({ ...entryFromContext(metadata(value)), popularity: value.popularity }));
                    return send(200, { items, entries: items, flat: true });
                }
                case '/api/get_user_profile': return send(state.authenticated ? 200 : 204, profile);
                case '/api/get_personal_navigation':
                    if (state.navigationFailure) return send(state.navigationFailure, { error: 'fixture_navigation_failure' });
                    return send(state.authenticated ? 200 : 401, { userID: state.userID, items: topics
                    .filter(value => !state.navigationEmpty && [54, 167, 190].includes(value.ID))
                    .map(value => ({ ...entryFromContext({ ...metadata(value), contextValues: { budget: 'standard' } }), weightCount: 4 })) });
                case '/api/get_weighted_workspace': {
                    await delay(state.workspaceDelay);
                    if (state.workspaceFailure) return send(state.workspaceFailure, { error: 'fixture_workspace_failure' });
                    const data = workspace({ ...state, isPrivate: topic.isPrivate === true,
                        personalEntries: state.navigationEmpty || topic.isPrivate || topic.ID === 170 ? [] : state.personalEntries }, { ...body, categoryID: 1 });
                    data.context = { ...data.context, ...metadata(topic), categoryPath: metadata(topic).path,
                        contextValues: topic.isPrivate ? {} : data.context.contextValues,
                        dimensions: topic.isPrivate ? [] : data.context.dimensions };
                    delete data.publicPie.composition;
                    return send(200, data);
                }
                case '/api/get_ranking_page': return send(200, rankingPage(state, { ...body, categoryID: 1 }));
                case '/api/get_comparison_profiles': return send(200, { authenticated: state.authenticated, userID: state.userID, last: null, profiles: [] });
                case '/api/create_topic': {
                    if (!state.authenticated) return send(401, { error: 'authentication_required' });
                    if (body.expectedUserID !== state.userID) return send(409, { error: 'account_changed' });
                    if (state.creationFailure) return send(state.creationFailure.status, { error: state.creationFailure.error });
                    if (isReservedTopicSlug(body.name)) return send(400, { error: 'reserved_topic_name' });
                    if (topics.some(value => value.name.toLowerCase() === body.name.toLowerCase())) return send(409, { error: 'topic_name_exists' });
                    const created = { ID: nextPrivateID++, name: body.name, slug: topicSlug(body.name), isPrivate: body.isPrivate, ownerUserID: state.userID };
                    topics.push(created);
                    return send(201, metadata(created));
                }
                case '/api/save_user_profile':
                    if (body.expectedUserID !== state.userID) return send(409, { error: 'account_changed' });
                    profile = { ...profile, userName: body.displayName ?? profile.userName,
                        userProfilePictureURL: body.avatar ?? profile.userProfilePictureURL,
                        hasCustomDisplayName: true, hasCustomAvatar: Boolean(body.avatar) };
                    return send(200, profile);
                case '/api/get_benchmark_information': {
                    const benchmark = catalog(state).benchmarks.find(value => value.conditions.some(condition => condition.ID === body.conditionID));
                    const condition = benchmark?.conditions.find(value => value.ID === body.conditionID);
                    if (!condition) return send(404, { error: 'benchmark_condition_unavailable' });
                    return send(200, { benchmarkID: benchmark.ID, conditionID: condition.ID, name: benchmark.name,
                        conditionName: condition.name, isPrimaryCondition: condition.isPrimary,
                        differenceExplanation: condition.differenceExplanation, description: benchmark.description,
                        introductionURL: '', scoresUpdatedAt: '2026-10-03T06:00:00Z' });
                }
                case '/api/get_approved_benchmark_results': return send(200, approvedResults(body));
                case '/api/get_device_count': return send(200, { deviceCount: 1 });
                default: {
                    const discussion = discussionFixture(url.pathname, body, state);
                    if (discussion !== null) {
                        if (discussion.context) discussion.context = { ...discussion.context, ...metadata(topic),
                            categoryPath: metadata(topic).path, dimensions: discussion.context.dimensions };
                        return send(200, discussion);
                    }
                    return send(404, { error: 'unhandled_fixture_endpoint' });
                }
                }
            }
            const legacyTopic = /^\/topics\/(\d+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
            if (legacyTopic) {
                const selected = findTopic(legacyTopic[1]);
                if (!selected || selected.isPrivate && selected.ownerUserID !== state.userID) return send(404, { error: 'topic_not_found' });
                response.writeHead(302, { location: metadata(selected).url + url.search });
                response.end(); return;
            }
            const configuration = /^\/personal\/\d+(?:\/[a-z0-9-]+)?\/?$/.test(url.pathname)
                || topics.some(topic => metadata(topic).url === url.pathname || !topic.isPrivate && url.pathname.startsWith(metadata(topic).url + '/'));
            const file = configuration ? resolve(root, 'private/home.html') : resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
            if (!configuration && (!file.startsWith(publicRoot + sep) || url.pathname.split('/').some(part => part.startsWith('.')))) return send(403, {});
            const data = await readFile(file);
            response.writeHead(200, { 'content-type': `${mime[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
            response.end(data);
        } catch (error) { send(error.status ?? (error.code === 'ENOENT' ? 404 : 500), { error: error.message }); }
    });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    return { state, topics, setAccount(userID) {
        state.authenticated = userID !== null;
        state.userID = userID;
        profile = { ...profile, userID, userName: `User ${userID}`, userProfilePictureURL: '' };
    }, url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve)) };
}
