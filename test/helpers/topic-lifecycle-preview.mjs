import express from 'express';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createLifecycleDatabase, seedLifecycleEvidence } from './lifecycle-mysql.mjs';
import { privacyHeaders } from '../../privacy-headers.js';
import { listTopics, getTopic, findTopicBySlug } from '../../topic-service.js';
import { createTopicHomeService } from '../../topic-home-service.js';
import { savePrivateTopic, deletePrivateTopic, readPrivateTopicEditor } from '../../private-topic-service.js';
import { createTopicProposalService, readProposal } from '../../topic-proposal-service.js';
import { createProposalPreviewService } from '../../topic-snapshot-service.js';
import { assertAccountWriteOwner } from '../../public/js/shared/account-identity.js';
import { readWriteIdentity } from '../../write-idempotency.js';
import { scenePath } from '../../public/js/shared/topics.js';
import { selectSearchScene } from '../../search-presentation.js';
import { ensureTopicRootContext } from '../../topic-scenes-service.js';

export async function startLifecyclePreview() {
    const database = await createLifecycleDatabase();
    await seedLifecycleEvidence(database.pool);
    const db = database.pool, root = fileURLToPath(new URL('../../', import.meta.url));
    for (let index = 0; index < 12; index++) {
        const [row] = await db.execute(`INSERT INTO categories (name, slug, description)
            VALUES (?, ?, 'Synthetic browser example.')`, ['Example topic ' + index, 'example-topic-' + index]);
        await ensureTopicRootContext(db, Number(row.insertId));
    }
    const state = { userID: '42', requests: [] };
    const topics = createTopicHomeService({ db });
    const proposals = createTopicProposalService({ pool: db, queueForReview: async () => { throw new Error('Review is outside this browser fixture'); } });
    const previews = createProposalPreviewService({ db, readProposal });
    const csrfToken = 'local-topic-lifecycle-csrf';
    const profile = () => state.userID ? { userID: state.userID, userName: 'Local example', userProfilePictureURL: '/assets/benchpoll-mark.svg' } : null;
    const app = express(); app.use(privacyHeaders); app.use(express.json());
    app.post('/api/:operation', async (req, res) => {
        const body = { ...req.body }, action = req.params.operation;
        state.requests.push({ action, body });
        res.set('Cache-Control', 'no-store');
        const readonly = {
            get_user_profile: () => profile(), get_privacy_status: () => ({ authenticated: Boolean(state.userID), userID: state.userID, csrfToken }),
            get_device_count: () => ({ deviceCount: 1 }), get_topics: () => listTopics(db, state.userID, body),
            get_topic: () => getTopic(db, state.userID, body.categoryID),
            get_topic_preview: () => topics.preview(state.userID, body),
            get_private_topic_editor: () => readPrivateTopicEditor(db, state.userID, body),
            get_topic_proposals: () => proposals.list(state.userID, body),
            get_topic_proposal_snapshot: () => previews.read(state.userID, body),
            preview_topic_proposal: () => previews.preview(state.userID, body)
        };
        if (readonly[action]) return res.json(await readonly[action]());
        assertAccountWriteOwner(state.userID, body.expectedUserID); delete body.expectedUserID;
        if (body.csrfToken !== csrfToken) throw { status: 403, body: { error: 'privacy_form_expired' } };
        delete body.csrfToken;
        const key = readWriteIdentity(req);
        const writes = {
            save_private_topic: () => savePrivateTopic(db, state.userID, body, key),
            delete_private_topic: () => deletePrivateTopic(db, state.userID, body, key),
            propose_topic: () => proposals.propose(state.userID, body, key),
            edit_topic_proposal: () => proposals.edit(state.userID, body, key),
            withdraw_topic_proposal: () => proposals.withdraw(state.userID, body, key),
            vote_topic_proposal: () => proposals.support(state.userID, body, key),
            copy_topic_proposal: () => previews.copy(state.userID, body, key)
        };
        if (!writes[action]) throw { status: 404, body: { error: 'fixture_api_missing' } };
        const result = await writes[action](); topics.invalidate(); res.json(result);
    });
    app.get('/', (_req, res) => res.sendFile(root + 'private/index.html'));
    app.get('/topic-proposals', (_req, res) => res.sendFile(root + 'private/topic-proposals.html'));
    app.get('/topic-proposals/:proposalID/preview', (_req, res) => res.set('X-Robots-Tag', 'noindex, nofollow, nosnippet').sendFile(root + 'private/topic-proposal-preview.html'));
    app.use(express.static(root + 'public'));
    const source = await readFile(root + 'server.js', 'utf8');
    const route = prefix => {
        const start = source.indexOf(prefix), end = source.indexOf('\n});', start);
        if (start < 0 || end < 0) throw new Error('Production route missing');
        return source.slice(start, end + 4);
    };
    const context = vm.createContext({ page: app, URL, publicOrigin: 'http://localhost', db, getTopic, findTopicBySlug,
        activeSessionUserID: async () => state.userID, selectSearchScene, scenePath,
        resolveLegacyTopic: async () => null, searchPresentation: { snapshot: async () => null },
        renderHome: async res => res.type('html').send('<!doctype html><title>Canonical scene</title><h1>Canonical scene</h1>') });
    vm.runInContext(route("page.get(['/personal/:categoryID'"), context);
    vm.runInContext(route("page.get('/*any_path'"), context);
    app.use((error, _req, res, _next) => res.status(error.status ?? 500).json(error.body ?? { error: error.message ?? 'fixture_failed' }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    return { db, state, url: 'http://127.0.0.1:' + server.address().port,
        async close() { await new Promise(resolve => server.close(resolve)); await database.close(); } };
}
