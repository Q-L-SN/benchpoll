import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privacyHeaders } from '../../privacy-headers.js';
import { assertAccountWriteOwner } from '../../public/js/shared/account-identity.js';
import { normalizeTopicSummary, isReservedTopicSlug } from '../../public/js/shared/topics.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = resolve(root, 'public');
const fixtureDeadline = new Date(Date.now() + 7 * 86400000).toISOString();
export const PROPOSAL_OWNER = '9007199254740993';
export const proposalProfile = { userID: PROPOSAL_OWNER, userName: 'Local account', userProfilePictureURL: null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

export function fixtureProposal(overrides = {}) {
    return { proposalID: 104, name: 'Clinical reasoning', description: 'Reasoning about clinical tasks and evidence.',
        supportCount: 29, threshold: 30, status: 'open', supported: false, canSupport: true,
        revision: 1, expiresAt: fixtureDeadline, isMine: false,
        canEdit: false, canWithdraw: false, canCancelSupport: false,
        submissionID: null, topicID: null, url: null, ...overrides };
}

const defaultProposals = () => [
    fixtureProposal({ proposalID: 105, name: 'Long-context document analysis', description: 'Understanding and comparing evidence across long documents.', supportCount: 30, status: 'pending', canSupport: false, submissionID: 52 }),
    fixtureProposal(),
    fixtureProposal({ proposalID: 103, name: 'Code review', description: 'Finding bugs and explaining changes in real code.', supportCount: 12 }),
    fixtureProposal({ proposalID: 102, name: 'Scientific reasoning', description: 'Reasoning through scientific questions with evidence.', supportCount: 30, status: 'pending', canSupport: false, submissionID: 51 }),
    fixtureProposal({ proposalID: 101, name: 'Visual reasoning', description: 'Interpreting images, diagrams and visual evidence.', supportCount: 30, status: 'approved', canSupport: false, submissionID: 50, topicID: 77, url: '/visual-reasoning' }),
    fixtureProposal({ proposalID: 100, name: 'Everyday assistance', description: 'Completing everyday questions and practical tasks.', supportCount: 30, status: 'rejected', canSupport: false, submissionID: 49 })
];

export async function startProposalFixture({ port = 0, profile = proposalProfile, proposals = defaultProposals() } = {}) {
    const state = { profile: structuredClone(profile), proposals: structuredClone(proposals),
        topics: [{ ID: 54, name: 'Intelligence', isPrivate: false }, { ID: 190, name: 'Coding', isPrivate: false },
            { ID: 501, name: 'My evaluation', description: 'Evaluate models for my daily work.', isPrivate: true }],
        csrfToken: 'local-proposal-csrf-token', privacyUserID: undefined,
        requests: [], staticRequests: [], failures: [], responses: new Map(), holds: new Map(),
        authors: new Map([[105, PROPOSAL_OWNER]]), voters: new Map(), replays: new Map(), now: () => Date.now() };
    const releases = new Set();
    state.hold = path => {
        if (state.holds.has(path)) throw new Error('A response is already held.');
        let resolveHold;
        const promise = new Promise(resolvePromise => { resolveHold = resolvePromise; });
        const release = () => { state.holds.delete(path); releases.delete(release); resolveHold(); };
        state.holds.set(path, promise);
        releases.add(release);
        return release;
    };
    const statusOf = proposal => proposal.status === 'open' && Date.parse(proposal.expiresAt) <= state.now() ? 'expired' : proposal.status;
    const accountQuota = () => state.profile ? {
        activeSupports: state.proposals.filter(proposal => statusOf(proposal) === 'open' && state.voters.get(proposal.proposalID)?.has(state.profile.userID)).length,
        activeProposalID: state.proposals.find(proposal => statusOf(proposal) === 'open' && state.authors.get(proposal.proposalID) === state.profile.userID)?.proposalID ?? null
    } : null;
    const serialize = proposal => {
        const supported = Boolean(state.profile && state.voters.get(proposal.proposalID)?.has(state.profile.userID));
        const isMine = Boolean(state.profile && state.authors.get(proposal.proposalID) === state.profile.userID);
        const status = statusOf(proposal), open = status === 'open';
        return { ...proposal, status, supported, isMine, canSupport: Boolean(state.profile && !supported && open && !isMine
            && accountQuota().activeSupports < 3), canEdit: isMine && open, canWithdraw: isMine && open,
        canCancelSupport: supported && open };
    };
    const server = createServer(async (request, response) => {
        privacyHeaders(request, response, () => {});
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        const send = (code, body, options = {}) => {
            if (response.destroyed) return;
            if (code >= 400) state.failures.push({ path: pathname, code });
            response.writeHead(code, { 'Content-Type': options.contentType ?? 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(options.raw ?? JSON.stringify(body));
        };
        const fail = (status, error) => { throw Object.assign(new Error(error), { status, payload: { error } }); };
        try {
            if (pathname === '/fixture/sign-in' && request.method === 'POST') {
                state.profile = { ...proposalProfile };
                return send(200, { ok: true });
            }
            if (pathname.startsWith('/api/')) {
                if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') return send(405, { error: 'invalid_fixture_method' });
                let raw = '';
                for await (const chunk of request) { raw += chunk.toString('utf8'); if (raw.length > 20000) return send(413, { error: 'fixture_body_too_large' }); }
                const body = JSON.parse(raw);
                const key = request.headers['idempotency-key'];
                state.requests.push({ path: pathname, body: structuredClone(body), key });
                const keys = {
                    '/api/get_user_profile': [], '/api/get_privacy_status': [], '/api/get_device_count': [], '/api/get_topics': [],
                    '/api/get_topic_proposals': [...(Object.hasOwn(body, 'view') ? ['view'] : []), ...(Object.hasOwn(body, 'before') ? ['before'] : [])],
                    '/api/propose_topic': ['sourceTopicID', 'name', 'description', 'csrfToken', 'expectedUserID'],
                    '/api/vote_topic_proposal': ['proposalID', 'revision', 'csrfToken', 'expectedUserID'],
                    '/api/cancel_topic_proposal_support': ['proposalID', 'revision', 'csrfToken', 'expectedUserID'],
                    '/api/edit_topic_proposal': ['proposalID', 'revision', 'name', 'description', 'csrfToken', 'expectedUserID', ...(Object.hasOwn(body, 'sourceTopicID') ? ['sourceTopicID'] : [])],
                    '/api/withdraw_topic_proposal': ['proposalID', 'revision', 'csrfToken', 'expectedUserID']
                }[pathname];
                if (!keys || !body || Array.isArray(body) || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(keys.sort())) return send(400, { error: 'unexpected_fixture_payload' });
                await state.holds.get(pathname);
                const queued = state.responses.get(pathname)?.shift();
                if (queued && !queued.commit) return send(queued.code ?? 200, queued.body, queued);
                if (pathname === '/api/get_user_profile') return send(200, state.profile);
                if (pathname === '/api/get_topics') return send(200, { topics: state.topics.filter(topic => state.profile || !topic.isPrivate) });
                if (pathname === '/api/get_privacy_status') return send(200, { authenticated: Boolean(state.profile),
                    userID: state.privacyUserID === undefined ? state.profile?.userID ?? null : state.privacyUserID,
                    csrfToken: state.csrfToken });
                if (pathname === '/api/get_device_count') return send(200, { deviceCount: 1 });
                if (pathname === '/api/get_topic_proposals') {
                    if (body.before !== undefined && (!Number.isSafeInteger(body.before) || body.before < 1)) return send(400, { error: 'invalid_fixture_cursor' });
                    if (body.view !== undefined && !['all', 'review'].includes(body.view)) return send(400, { error: 'invalid_topic_proposal_view' });
                    const rows = state.proposals.filter(item => item.status !== 'withdrawn'
                        && (body.view !== 'review' || item.status === 'pending') && (body.before === undefined || item.proposalID < body.before))
                        .sort((a, b) => b.proposalID - a.proposalID);
                    return send(200, { authenticated: Boolean(state.profile), proposals: rows.slice(0, 30).map(serialize),
                        nextCursor: rows.length > 30 ? rows[29].proposalID : null, threshold: 30,
                        limits: { supports: 3, proposals: 1, days: 14 }, account: accountQuota(),
                        activeProposal: accountQuota()?.activeProposalID ? serialize(state.proposals.find(item => item.proposalID === accountQuota().activeProposalID)) : null });
                }
                assertAccountWriteOwner(state.profile?.userID, body.expectedUserID);
                if (body.csrfToken !== state.csrfToken) fail(403, 'privacy_form_expired');
                if (!uuid.test(key ?? '')) fail(400, 'write_identity_required');
                const signature = JSON.stringify({ path: pathname, body });
                const replay = state.replays.get(key);
                if (replay) {
                    if (replay.signature !== signature) fail(409, 'write_identity_reused');
                    if (replay.deleted) return send(200, { proposalID: replay.proposalID, deleted: true });
                    const proposal = state.proposals.find(item => item.proposalID === replay.proposalID);
                    if (!proposal) fail(404, 'topic_proposal_not_found');
                    return send(200, serialize(proposal));
                }
                let result;
                if (pathname === '/api/propose_topic') {
                    if (accountQuota().activeProposalID !== null) fail(409, 'active_topic_proposal_limit');
                    if (typeof body.name !== 'string' || !body.name || [...body.name].length > 128) fail(400, 'invalid_topic_name');
                    normalizeTopicSummary(body.description);
                    if (!state.topics.some(topic => topic.isPrivate && topic.ID === body.sourceTopicID)) fail(400, 'private_topic_source_required');
                    if (isReservedTopicSlug(body.name)) fail(400, 'reserved_topic_name');
                    if (state.proposals.some(item => item.name === body.name)) fail(409, 'topic_proposal_exists');
                    const proposal = fixtureProposal({ proposalID: Math.max(0, ...state.proposals.map(item => item.proposalID)) + 1,
                        name: body.name, description: body.description, supportCount: 0, canSupport: false,
                        expiresAt: new Date(state.now() + 14 * 86400000).toISOString(),
                        hasSnapshot: true, sourceTopicID: body.sourceTopicID });
                    proposal.previewURL = `/topic-proposals/${proposal.proposalID}/preview`;
                    state.proposals.unshift(proposal);
                    state.authors.set(proposal.proposalID, state.profile.userID);
                    result = serialize(proposal);
                } else {
                    if (!Number.isSafeInteger(body.proposalID) || body.proposalID < 1) fail(400, 'invalid_proposal_id');
                    const proposal = state.proposals.find(item => item.proposalID === body.proposalID);
                    if (!proposal) fail(404, 'topic_proposal_not_found');
                    if (!Number.isSafeInteger(body.revision) || body.revision < 1) fail(400, 'topic_proposal_revision_required');
                    if (statusOf(proposal) === 'expired') fail(409, 'topic_proposal_expired');
                    if (statusOf(proposal) !== 'open') fail(409, 'topic_proposal_not_open');
                    if (body.revision !== proposal.revision) fail(409, 'topic_proposal_changed');
                    const voters = state.voters.get(body.proposalID) ?? new Set();
                    if (pathname === '/api/edit_topic_proposal' || pathname === '/api/withdraw_topic_proposal') {
                        if (state.authors.get(body.proposalID) !== state.profile.userID) fail(403, 'topic_proposal_not_owner');
                        if (pathname === '/api/withdraw_topic_proposal') {
                            state.proposals.splice(state.proposals.indexOf(proposal), 1);
                            state.voters.delete(body.proposalID);
                        }
                        else {
                            if (typeof body.name !== 'string' || !body.name || [...body.name].length > 128) fail(400, 'invalid_topic_name');
                            normalizeTopicSummary(body.description);
                            if (!proposal.parentTopicID && isReservedTopicSlug(body.name)) fail(400, 'reserved_topic_name');
                            if (state.proposals.some(item => item.proposalID !== proposal.proposalID && item.name === body.name)) fail(409, 'topic_proposal_exists');
                            if (body.name !== proposal.name || body.description !== proposal.description) {
                                proposal.name = body.name;
                                proposal.description = body.description;
                                proposal.supportCount = 0;
                                proposal.revision++;
                                state.voters.delete(body.proposalID);
                            }
                        }
                    } else if (pathname === '/api/cancel_topic_proposal_support') {
                        if (voters.delete(state.profile.userID)) proposal.supportCount--;
                    } else if (!voters.has(state.profile.userID)) {
                        if (state.authors.get(body.proposalID) === state.profile.userID) fail(403, 'proposal_self_support_not_allowed');
                        if (accountQuota().activeSupports >= 3) fail(409, 'topic_proposal_support_limit');
                        voters.add(state.profile.userID);
                        state.voters.set(body.proposalID, voters);
                        proposal.supportCount++;
                        if (proposal.supportCount === 30) { proposal.status = 'pending'; proposal.submissionID = 90; }
                    }
                    result = pathname === '/api/withdraw_topic_proposal' ? { proposalID: body.proposalID, deleted: true } : serialize(proposal);
                }
                state.replays.set(key, { signature, proposalID: result.proposalID, deleted: result.deleted === true });
                return send(queued?.code ?? 200, queued?.body ?? result, queued ?? {});
            }
            state.staticRequests.push({ path: pathname, method: request.method });
            if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, { error: 'invalid_fixture_method' });
            if (pathname === '/github_login') return send(200, null, { contentType: types['.html'], raw:
                '<!doctype html><html lang="en"><head><title>Local sign-in</title></head><body><button id="fixture-sign-in">Complete local sign-in</button><script type="module" src="/fixture/complete-sign-in.js"></script></body></html>' });
            if (pathname === '/fixture/complete-sign-in.js') return send(200, null, { contentType: types['.js'], raw:
                "import { completeSignIn } from '/js/shared/sign-in.js'; document.getElementById('fixture-sign-in').addEventListener('click', async () => { await fetch('/fixture/sign-in', { method: 'POST' }); completeSignIn(); });" });
            let path;
            if (pathname === '/topic-proposals') path = resolve(root, 'private/topic-proposals.html');
            else {
                path = resolve(publicRoot, '.' + decodeURIComponent(pathname));
                if (!path.startsWith(publicRoot + sep)) return send(403, { error: 'fixture_static_path_forbidden' });
            }
            const content = await readFile(path);
            response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
            response.end(request.method === 'HEAD' ? undefined : content);
        } catch (error) {
            send(error.status ?? (error.code === 'ENOENT' ? 404 : 500), error.payload ?? { error: error.code ?? 'fixture_error' });
        }
    });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    let closing;
    return { state, origin, url: `${origin}/topic-proposals`, close: () => closing ??= new Promise(resolveClose => {
        for (const release of releases) release();
        server.closeAllConnections();
        server.close(resolveClose);
    }) };
}
