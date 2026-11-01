import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { requireAccountWriteOwner } from '../../public/js/shared/account-identity.js';
import { LEGAL_VERSIONS, privacyRequestPayload, privacyRequestUpdatePayload } from '../../public/js/account-privacy.js';
import { privacyHeaders } from '../../privacy-headers.js';
import { validateLegalChoice } from '../../privacy-controls.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = resolve(root, 'public');
const owned = new Set(['/api/accept_legal_terms', '/api/save_privacy_preferences', '/api/list_privacy_requests', '/api/update_privacy_request']);
const queuePaths = new Set(['/api/list_privacy_requests', '/api/update_privacy_request']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };

export async function startAccountPrivacyFixture({ port = 0, authenticated = false, isSenior = false,
    accepted = false, privateCategoryResearch = false, userID = '9007199254740993' } = {}) {
    const state = {
        status: { userID: authenticated ? userID : null, authenticated, isSenior: authenticated && isSenior,
            versions: { ...LEGAL_VERSIONS },
            accepted, privateCategoryResearch: false, csrfToken: 'local-fixture-csrf-1',
            operator: { displayName: 'BenchPoll operator', email: null, identityPending: true } },
        historicalResearchChoice: privateCategoryResearch,
        requests: [], responses: new Map(), holds: new Map(), recorded: [],
        entries: [
            { reference: 'PR-LOCAL-0003', userID: null, email: '<img>@example.test', requestType: 'access',
                message: '<img src=x onerror="globalThis.privacyXSS=true">\nA literal request, not HTML.',
                status: 'open', createdAt: '2026-10-17T04:00:00Z', dueAt: '2026-11-14T04:00:00Z', resolution: '' },
            { reference: 'PR-LOCAL-0002', userID, email: 'requester@example.test', requestType: 'correction',
                message: 'Correct the account record reference.', status: 'in_review',
                createdAt: '2026-10-16T04:00:00Z', dueAt: '2026-11-13T04:00:00Z', resolution: 'Verification pending.' },
            { reference: 'PR-LOCAL-0001', userID: null, email: 'older@example.test', requestType: 'other', message: 'An older request.',
                status: 'closed', createdAt: '2026-10-15T04:00:00Z', dueAt: '2026-11-12T04:00:00Z', resolution: 'Handled manually.' }
        ]
    };
    const server = createServer(async (req, res) => {
        privacyHeaders(req, res, () => {});
        const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname.startsWith('/api/')) {
                if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                let raw = '';
                for await (const chunk of req) {
                    raw += chunk;
                    if (raw.length > 20000) return send(413, { error: 'too_large' });
                }
                let body = JSON.parse(raw || '{}');
                state.requests.push({ path: url.pathname, body: structuredClone(body) });
                if (url.pathname !== '/api/get_privacy_status' && body.csrfToken !== state.status.csrfToken) return send(403, { error: 'invalid_csrf' });
                if (owned.has(url.pathname)) {
                    const guarded = { session: { userID: state.status.userID }, body };
                    let error;
                    requireAccountWriteOwner(guarded, {}, problem => { error = problem; });
                    if (error) throw error;
                    body = guarded.body;
                }
                if (queuePaths.has(url.pathname) && !state.status.isSenior) return send(403, { error: 'senior_required' });
                await state.holds.get(url.pathname);
                const response = state.responses.get(url.pathname)?.shift();
                if (response) return send(response.code ?? 200, response.body);
                switch (url.pathname) {
                case '/api/get_privacy_status': return send(200, state.status);
                case '/api/prepare_github_login':
                case '/api/accept_legal_terms':
                    validateLegalChoice(body, { hashes: { terms: 'a'.repeat(64), privacy: 'b'.repeat(64) } });
                    if (url.pathname.endsWith('/prepare_github_login')) return send(200, { url: 'https://github.com/login/oauth/authorize?client_id=local-fixture&state=local-fixture' });
                    state.status.accepted = true;
                    if (body.privateCategoryResearch === false) state.historicalResearchChoice = false;
                    return send(200, state.status);
                case '/api/save_privacy_preferences':
                    if (typeof body.privateCategoryResearch !== 'boolean') return send(400, { error: 'invalid_preference' });
                    if (body.privateCategoryResearch) return send(409, { error: 'private_category_research_unavailable' });
                    state.historicalResearchChoice = false;
                    return send(200, state.status);
                case '/api/submit_privacy_request': {
                    const request = privacyRequestPayload(body.csrfToken, body);
                    const reference = `PR-FIXTURE-${state.recorded.length + 1}`;
                    state.recorded.push({ ...request, reference });
                    return send(200, { reference });
                }
                case '/api/list_privacy_requests': {
                    const index = body.before ? state.entries.findIndex(item => item.reference === body.before) + 1 : 0;
                    const requests = state.entries.slice(index, index + 2);
                    return send(200, { requests, nextCursor: index + 2 < state.entries.length ? requests.at(-1).reference : null });
                }
                case '/api/update_privacy_request': {
                    const update = privacyRequestUpdatePayload(body.csrfToken, body.reference, body.status, body.resolution);
                    const entry = state.entries.find(item => item.reference === update.reference);
                    if (!entry) return send(404, { error: 'request_not_found' });
                    Object.assign(entry, { status: update.status, resolution: update.resolution });
                    return send(200, { updated: true });
                }
                default: return send(404, { error: 'unknown_fixture_endpoint' });
                }
            }
            if (req.method !== 'GET') return send(405, {});
            let path;
            if (url.pathname === '/account/privacy') path = resolve(root, 'private/account-privacy.html');
            else if (url.pathname === '/privacy' || url.pathname === '/terms') path = resolve(root, `private${url.pathname}.html`);
            else {
                path = resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
                if (!path.startsWith(publicRoot + sep)) return send(403, {});
            }
            const content = await readFile(path);
            res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream',
                'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
            res.end(content);
        } catch (error) {
            if (res.headersSent) { res.end(); return; }
            send(error.status ?? 400, error.body ?? { error: error.code ?? 'fixture_error' });
        }
    });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    return { state, url: `http://127.0.0.1:${server.address().port}/account/privacy`,
        close: () => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }) };
}

if (process.argv.includes('--serve')) {
    const portIndex = process.argv.indexOf('--port');
    const fixture = await startAccountPrivacyFixture({ port: portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0,
        authenticated: process.argv.includes('--senior'), isSenior: process.argv.includes('--senior') });
    console.log(`Local mock APIs only; no database, mail or deletion. ${fixture.url}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
