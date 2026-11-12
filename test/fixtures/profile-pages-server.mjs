import express from 'express';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { registerProfileRoutes } from '../../profile-routes.js';
import { loadUserProfile, saveUserProfile } from '../../user-profile-service.js';
import { requireAccountWriteOwner } from '../../public/js/shared/account-identity.js';
import { LEGAL_VERSIONS } from '../../public/js/shared/legal-versions.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function startProfilePagesFixture({ viewerID = '10', port = 0 } = {}) {
    const profiles = new Map([
        ['10', { userID: '10', publicID: '1', userName: 'Avery Chen', userProfilePictureURL: null, bio: 'Building thoughtful model comparisons.',
            hasCustomDisplayName: 1, hasCustomAvatar: 0, defaultUserName: 'Avery', defaultUserProfilePictureURL: null,
            githubUsername: 'avery-fixture', showGitHubProfile: 0, publishFavorites: 0, publishConfiguredTopics: 0, role: 'user', hasVerifiedEmail: 1 }],
        ['20', { userID: '20', publicID: '2', userName: 'Sam Rivera', userProfilePictureURL: null, bio: '',
            hasCustomDisplayName: 0, hasCustomAvatar: 0, defaultUserName: 'Sam', defaultUserProfilePictureURL: null,
            githubUsername: null, showGitHubProfile: 0, publishFavorites: 1, publishConfiguredTopics: 0, role: 'user', hasVerifiedEmail: 1 }]
    ]);
    const topics = [
        { ID: 7, categoryID: 7, publicID: 1, name: 'Language', url: '/1', description: 'Understand language models across everyday tasks.',
            isOfficial: true, favoriteCount: 128, isFavorited: true, configured: true, rootContextID: 12, defaultContextID: 12, scenes: [] },
        { ID: 8, categoryID: 8, publicID: 2, name: 'Coding', url: '/2', description: 'Compare code generation and problem solving.',
            isOfficial: false, creator: { handle: '2', name: 'Sam Rivera', avatarURL: null }, favoriteCount: 82, isFavorited: false,
            configured: false, rootContextID: 13, defaultContextID: 13, scenes: [{ ID: 13, contextID: 13, name: 'Python', sceneNumber: 1, url: '/2/1' }] },
        { ID: 9, categoryID: 9, publicID: 3, name: 'Research', url: '/3', description: 'A careful view of evidence and research capability.',
            isOfficial: false, creator: { handle: '1', name: 'Avery Chen', avatarURL: null }, favoriteCount: 45, isFavorited: true,
            configured: false, rootContextID: 14, defaultContextID: 14, scenes: [] }
    ];
    const state = { viewerID, profiles, topics, requests: [], queried: [], visits: [
        { userID: '10', categoryID: 8, contextID: 13, visitedAt: '2026-11-12T12:30:00Z' },
        { userID: '10', categoryID: 7, contextID: 12, visitedAt: '2026-11-11T09:20:00Z' }
    ] };
    const connection = {
        async execute(sql, args = []) {
            if (sql.startsWith('SELECT ID FROM users')) return [profiles.has(args[0]) ? [{ ID: args[0] }] : []];
            if (sql.startsWith('SELECT CAST(u.ID AS CHAR)')) {
                const profile = sql.includes('WHERE p.public_id') ? [...profiles.values()].find(profile => profile.publicID === args[0]) : profiles.get(args[0]);
                return [profile ? [{ ...profile }] : []];
            }
            if (sql.startsWith('SELECT github_username')) return [[{ github_username: profiles.get(args[0])?.githubUsername }]];
            if (sql.startsWith('SELECT CAST(next_id')) return [[{ nextID: '3' }]];
            if (sql.startsWith('SELECT CAST(user_ID')) {
                const profile = [...profiles.values()].find(profile => profile.publicID === args[0]);
                return [profile ? [{ userID: profile.userID }] : []];
            }
            if (sql.startsWith('UPDATE user_public_profiles SET public_id')) { profiles.get(args[1]).publicID = args[0]; return [{ affectedRows: 1 }]; }
            if (sql.startsWith('UPDATE user_public_profiles SET bio')) { profiles.get(args[1]).bio = args[0]; return [{ affectedRows: 1 }]; }
            if (sql.startsWith('INSERT INTO user_public_profiles (user_ID, display_name')) {
                const profile = profiles.get(args[0]);
                if (args[4]) profile.userName = args[1];
                if (args[5]) { profile.userProfilePictureURL = args[2]; profile.hasCustomAvatar = Number(args[2] !== null); }
                if (args[6]) profile.showGitHubProfile = Number(args[3]);
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('INSERT INTO user_public_profiles (user_ID, publish_favorites')) {
                const profile = profiles.get(args[2]);
                if (profile) { profile.publishFavorites = Number(args[0]); profile.publishConfiguredTopics = Number(args[1]); }
                return [{ affectedRows: profile ? 1 : 0 }];
            }
            if (sql.startsWith('SELECT category_ID AS categoryID')) return [state.visits.filter(row => row.userID === args[0]).map(row => ({ ...row }))];
            if (sql.startsWith('DELETE FROM user_profile_visits')) { state.visits = state.visits.filter(row => row.userID !== args[0]); return [{ affectedRows: 1 }]; }
            if (sql.startsWith('INSERT INTO user_profile_visits')) {
                state.visits = state.visits.filter(row => !(row.userID === args[2] && row.contextID === args[1]));
                state.visits.unshift({ userID: args[2], categoryID: args[0], contextID: args[1], visitedAt: new Date().toISOString() });
                return [{ affectedRows: 1 }];
            }
            throw new Error('Unexpected fixture SQL: ' + sql);
        },
        beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}
    };
    const db = { execute: connection.execute, getConnection: async () => connection };
    const app = express(), API = express.Router(), page = express.Router();
    app.use(express.json({ limit: '400kb' }));
    app.use((req, _res, next) => { req.session = { userID: state.viewerID }; next(); });
    const auth = (req, res, next) => {
        if (!state.viewerID || !profiles.has(state.viewerID)) return res.status(401).json({ error: 'authentication_required' });
        req.user = { ID: state.viewerID }; next();
    };
    const sameOrigin = (req, res, next) => {
        if (req.get('origin') && req.get('origin') !== `http://${req.get('host')}`) return res.status(403).json({ error: 'same_origin_required' });
        next();
    };
    registerProfileRoutes({ page, API, db, currentDir: root.replace(/\/$/, ''), activeSessionUserID: async () => state.viewerID,
        requireAuthForAPI: auth, discussionSameOrigin: sameOrigin, requireAccountWriteOwner,
        readProfileTopics: async (_db, options) => {
            state.queried.push(options);
            return { published: options.userID === '10' ? [topics[2]] : [],
                ...(options.includeFavorites ? { favorites: [topics[0], topics[1]] } : {}),
                ...(options.includeConfigured ? { configured: [topics[0]] } : {}) };
        },
        getTopic: async (_db, _viewerID, id) => { const topic = topics.find(topic => topic.ID === id); if (!topic) throw { status: 404 }; return topic; }
    });
    API.use((req, _res, next) => { state.requests.push({ path: req.path, body: structuredClone(req.body) }); next(); });
    API.post('/get_user_profile', async (_req, res) => { const result = await loadUserProfile(db, state.viewerID); if (!result) return res.status(204).end(); res.json(result); });
    API.post('/save_user_profile', sameOrigin, auth, requireAccountWriteOwner, async (req, res) => res.json(await saveUserProfile(db, req.user.ID, req.body)));
    API.post('/get_privacy_status', (_req, res) => res.json({ authenticated: Boolean(state.viewerID), userID: state.viewerID, accepted: true,
        isSenior: false, privateCategoryResearch: false, csrfToken: 'fixture-csrf', versions: LEGAL_VERSIONS, operator: { displayName: 'Fixture operator', identityPending: false } }));
    API.post('/get_device_count', auth, (_req, res) => res.json({ deviceCount: 2 }));
    API.post(['/logout', '/delete_account'], sameOrigin, auth, requireAccountWriteOwner, (_req, res) => { state.viewerID = null; res.status(204).end(); });
    API.post('/set_topic_favorite', sameOrigin, auth, requireAccountWriteOwner, (req, res) => {
        const topic = topics.find(topic => topic.ID === req.body.categoryID);
        if (!topic) return res.status(404).json({ error: 'topic_not_found' });
        if (topic.isFavorited !== req.body.isFavorited) topic.favoriteCount += req.body.isFavorited ? 1 : -1;
        topic.isFavorited = req.body.isFavorited;
        res.json({ categoryID: topic.ID, isFavorited: topic.isFavorited, favoriteCount: topic.favoriteCount });
    });
    app.use('/api', API); app.use(page); app.use(express.static(root + 'public'));
    app.get(['/', '/login', '/:publicID', '/:publicID/:sceneNumber'], (_req, res) => res.send('<!doctype html><title>Fixture</title><a href="/me">Your profile</a>'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json(error.body ?? { error: error.message }));
    const server = app.listen(port, '127.0.0.1'); await once(server, 'listening');
    return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
