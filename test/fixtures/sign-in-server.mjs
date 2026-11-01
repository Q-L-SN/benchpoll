import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privacyHeaders } from '../../privacy-headers.js';
import { LEGAL_VERSIONS } from '../../public/js/shared/legal-versions.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicRoot = resolve(root, 'public');
const pages = new Map([
    ['/github_login', 'private/sign-in.html'],
    ['/terms', 'private/terms.html'],
    ['/privacy', 'private/privacy.html']
]);
const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
    '.woff': 'font/woff', '.ttf': 'font/ttf'
};

export const SIGN_IN_AUTHORIZATION_URL = 'https://github.com/login/oauth/authorize?client_id=local-sign-in-fixture&state=local-sign-in-fixture';

export async function startSignInFixture({ port = 0, status = {} } = {}) {
    const state = {
        status: {
            userID: null, authenticated: false, isSenior: false, accepted: false,
            privateCategoryResearch: false, versions: { ...LEGAL_VERSIONS },
            csrfToken: 'local-sign-in-csrf-1',
            operator: { displayName: 'Local fixture operator', email: null, identityPending: true },
            ...structuredClone(status)
        },
        requests: [], responses: new Map(), holds: new Map(), failures: [], staticRequests: []
    };
    const releases = new Set();
    state.hold = path => {
        if (state.holds.has(path)) throw new Error(`A fixture response is already held: ${path}`);
        let resolveHold;
        const promise = new Promise(resolvePromise => { resolveHold = resolvePromise; });
        const release = () => {
            if (state.holds.get(path) === promise) state.holds.delete(path);
            releases.delete(release);
            resolveHold();
        };
        releases.add(release);
        state.holds.set(path, promise);
        return release;
    };

    const server = createServer(async (request, response) => {
        privacyHeaders(request, response, () => {});
        let pathname = '';
        const send = (code, body, { contentType = 'application/json; charset=utf-8', raw } = {}) => {
            if (response.destroyed) return;
            if (code >= 400) state.failures.push({ path: pathname, code });
            response.writeHead(code, { 'Content-Type': contentType, 'Cache-Control': 'private, no-store' });
            response.end(raw === undefined ? JSON.stringify(body) : raw);
        };
        try {
            pathname = new URL(request.url, 'http://127.0.0.1').pathname;
            if (pathname.startsWith('/api/')) {
                if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' });
                let raw = '';
                for await (const chunk of request) {
                    raw += chunk.toString('utf8');
                    if (raw.length > 20000) return send(413, { error: 'fixture_body_too_large' });
                }
                let body;
                try { body = JSON.parse(raw || '{}'); }
                catch { return send(400, { error: 'fixture_invalid_json' }); }
                state.requests.push({ path: pathname, method: request.method, body: structuredClone(body) });
                if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'fixture_invalid_body' });
                if (!['/api/get_privacy_status', '/api/prepare_github_login'].includes(pathname)) {
                    return send(404, { error: 'unknown_fixture_endpoint' });
                }
                if (pathname === '/api/get_privacy_status' && Object.keys(body).length) {
                    return send(400, { error: 'fixture_status_body_must_be_empty' });
                }
                if (pathname === '/api/prepare_github_login') {
                    const keys = ['acceptedTerms', 'csrfToken', 'eligibleAge', 'privacyVersion', 'termsVersion'];
                    if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(keys)
                        || body.acceptedTerms !== true || body.eligibleAge !== true) {
                        return send(400, { error: 'fixture_invalid_login_payload' });
                    }
                }
                await state.holds.get(pathname);
                const queued = state.responses.get(pathname)?.shift();
                if (queued) return send(queued.code ?? 200, queued.body, queued);
                if (pathname === '/api/get_privacy_status') return send(200, state.status);
                if (body.csrfToken !== state.status.csrfToken) return send(403, { error: 'invalid_csrf' });
                if (body.termsVersion !== state.status.versions.terms || body.privacyVersion !== state.status.versions.privacy) {
                    return send(409, { error: 'legal_version_mismatch' });
                }
                return send(200, { url: SIGN_IN_AUTHORIZATION_URL });
            }
            state.staticRequests.push({ path: pathname, method: request.method });
            if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, { error: 'method_not_allowed' });
            let path;
            if (pages.has(pathname)) path = resolve(root, pages.get(pathname));
            else {
                path = resolve(publicRoot, '.' + decodeURIComponent(pathname));
                if (!path.startsWith(publicRoot + sep)) return send(403, { error: 'fixture_static_path_forbidden' });
            }
            const content = await readFile(path);
            response.writeHead(200, {
                'Content-Type': types[extname(path)] ?? 'application/octet-stream',
                'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer'
            });
            response.end(request.method === 'HEAD' ? undefined : content);
        } catch (error) {
            if (response.headersSent) { response.end(); return; }
            send(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 500, { error: error.code ?? 'fixture_error' });
        }
    });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    let closing;
    return {
        state, origin, url: `${origin}/github_login`,
        close: () => closing ??= new Promise(resolveClose => {
            for (const release of releases) release();
            server.closeAllConnections();
            server.close(resolveClose);
        })
    };
}

if (process.argv.includes('--serve')) {
    const portIndex = process.argv.indexOf('--port');
    const fixture = await startSignInFixture({ port: portIndex < 0 ? 0 : Number(process.argv[portIndex + 1]) });
    console.log(`Sign-in fixture; local mock APIs only. ${fixture.url}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
        await fixture.close();
        process.exit(0);
    });
}
