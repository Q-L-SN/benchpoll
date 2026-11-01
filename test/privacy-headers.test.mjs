import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';
import { chromium } from 'playwright';
import { PRIVACY_CONTENT_SECURITY_POLICY, REVIEWED_INLINE_SCRIPT_HASHES, privacyHeaders } from '../privacy-headers.js';
import { startPreview } from '../scripts/frontend/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = 'benchpoll:contribution-entry:';

function response(initial = {}) {
    const headers = new Map(Object.entries(initial));
    return { headers, getHeader: name => headers.get(name), setHeader: (name, value) => headers.set(name, value) };
}

test('privacyHeaders is synchronous Express-compatible middleware without request/session/storage work', () => {
    const res = response({ 'Cache-Control': 'private, no-store', 'Set-Cookie': 'synthetic=untouched' });
    let nextCalls = 0;
    const req = new Proxy({}, { get() { throw new Error('Headers must not inspect the request'); } });
    assert.equal(privacyHeaders(req, res, () => nextCalls++), undefined);
    assert.equal(nextCalls, 1);
    assert.equal(res.headers.get('Content-Security-Policy'), PRIVACY_CONTENT_SECURITY_POLICY);
    assert.equal(res.headers.get('Referrer-Policy'), 'same-origin');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('Set-Cookie'), 'synthetic=untouched');
    for (const name of ['Content-Security-Policy-Report-Only', 'Report-To', 'Reporting-Endpoints',
        'Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Strict-Transport-Security']) {
        assert.equal(res.headers.has(name), false);
    }
});

test('the policy never grants arbitrary inline/evaluated/external scripts or analytics reporting', () => {
    const directives = new Map(PRIVACY_CONTENT_SECURITY_POLICY.split('; ').map(part => {
        const [name, ...values] = part.split(' '); return [name, values];
    }));
    assert.deepEqual(directives.get('script-src'), ["'self'", ...Object.values(REVIEWED_INLINE_SCRIPT_HASHES).map(hash => `'${hash}'`)]);
    assert.deepEqual(directives.get('script-src-attr'), ["'none'"]);
    assert.deepEqual(directives.get('connect-src'), ["'self'"]);
    assert.deepEqual(directives.get('font-src'), ["'self'"]);
    assert.deepEqual(directives.get('img-src'), ["'self'", 'data:', 'https:']);
    assert.doesNotMatch(PRIVACY_CONTENT_SECURITY_POLICY, /unsafe-eval|strict-dynamic|nonce-|report-uri|report-to|cloudflareinsights|googletagmanager|https:\/\//);
});

test('existing CSP protections intersect, including array headers, and repeated mounts are idempotent', () => {
    for (const existing of ["frame-ancestors 'none'", ["frame-ancestors 'none'", "object-src 'none'"]]) {
        const res = response({ 'Content-Security-Policy': existing, 'Referrer-Policy': 'no-referrer' });
        privacyHeaders({}, res, () => {}); privacyHeaders({}, res, () => {});
        assert.deepEqual(res.getHeader('Content-Security-Policy'), [
            ...(Array.isArray(existing) ? existing : [existing]), PRIVACY_CONTENT_SECURITY_POLICY
        ]);
        assert.equal(res.getHeader('Referrer-Policy'), 'no-referrer');
    }
    const res = response(); privacyHeaders({}, res, () => {}); privacyHeaders({}, res, () => {});
    assert.equal(res.getHeader('Content-Security-Policy'), PRIVACY_CONTENT_SECURITY_POLICY);
});

const probeHTML = `<!doctype html><html><head>
    <link rel="stylesheet" href="/css/global.css">
    <style>body { padding-top: 90px; }</style>
    <script>globalThis.unreviewedInlineRan = true;</script>
    <script src="https://static.cloudflareinsights.com/beacon.min.js/synthetic" defer></script>
    <script src="https://www.googletagmanager.com/gtag/js?id=synthetic" defer></script>
    <script type="module" src="/__policy.js"></script>
    </head><body><global-header></global-header>
    <button id="inline-handler" onclick="globalThis.unreviewedHandlerRan = true">Probe</button>
    <button id="open-dialog">Open</button>
    <global-dialog id="probe-dialog" hidden><span slot="title">Synthetic dialog</span>
    <button slot="actions" id="close-dialog" class="dialog-close-button">Close</button></global-dialog>
    <form id="probe-form" action="/api/get_user_profile" method="post"><input name="synthetic" required value="test"><button>Submit</button></form>
    <img id="local-image" src="/assets/benchpoll-mark.svg" alt="">
    <img id="avatar-image" src="https://avatars.githubusercontent.com/u/1?v=4" alt="">
    </body></html>`;

const probeScript = `import '/js/global.js';
    import { contributionPath } from '/js/shared/contribution-navigation.js';
    window.selfModuleWorks = contributionPath('feedback') === '/contribute/feedback';
    try { eval('globalThis.evaluatedCodeRan = true'); } catch (error) { window.evalBlocked = error instanceof EvalError; }
    try { await fetch('https://cloudflareinsights.com/cdn-cgi/rum', { method: 'POST', body: 'synthetic' }); } catch { window.externalConnectBlocked = true; }
    document.getElementById('open-dialog').addEventListener('click', () => { document.getElementById('probe-dialog').hidden = false; });
    document.getElementById('close-dialog').addEventListener('click', () => { document.getElementById('probe-dialog').hidden = true; });
    document.getElementById('probe-form').addEventListener('submit', async event => {
        event.preventDefault(); const res = await fetch('/api/get_user_profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        window.formWorks = res.ok;
    });
    window.addEventListener('message', event => { if (event.origin === location.origin && event.data === 'synthetic-auth') window.popupWorks = true; });
    window.probeReady = true;`;

const navigationScript = `import { buildContributionURL, activateContributionURL } from '/js/shared/contribution-navigation.js';
    const values = { details: 'Synthetic prefill' };
    if (!location.search.includes('late-only')) {
        const url = buildContributionURL('feedback', values);
        for (const link of document.querySelectorAll('[data-prefill]')) link.href = url;
    }
    document.getElementById('late').addEventListener('click', event => { event.currentTarget.href = buildContributionURL('feedback', values); });
    document.getElementById('imperative').addEventListener('click', () => { location.assign(activateContributionURL(buildContributionURL('feedback', values))); });
    window.navigationReady = true;`;

async function fixture() {
    const preview = await startPreview({ authenticated: true });
    const app = express();
    app.use(privacyHeaders);
    app.get('/__policy', (_req, res) => res.type('html').send(probeHTML));
    app.get('/__policy.js', (_req, res) => res.type('js').send(probeScript));
    app.get('/__navigation', (_req, res) => res.type('html').send(`<!doctype html><script type="module" src="/__navigation.js"></script>
        <a id="primary" data-prefill href="/contribute/feedback"><span>Open form</span></a>
        <a id="blank" data-prefill target="_blank" rel="noopener" href="/contribute/feedback">New tab</a>
        <a id="late" href="/contribute/feedback">Late href</a><button id="imperative">Direct navigation</button>`));
    app.get('/__navigation.js', (_req, res) => res.type('js').send(navigationScript));
    app.get('/contribute/feedback', (_req, res) => res.type('html').send('<!doctype html><script type="module" src="/__handoff.js"></script>'));
    app.get('/__handoff.js', (_req, res) => res.type('js').send(`import { readContributionEntry } from '/js/shared/contribution-navigation.js';
        const entry = readContributionEntry(); window.handoffWorks = entry.error === null && entry.params.get('details') === 'Synthetic prefill';
        window.handoffHasDetails = entry.error === null && !!entry.params.get('details')?.trim();`));
    app.get('/__popup', (_req, res) => res.type('html').send('<!doctype html><script src="/__popup.js"></script>'));
    app.get('/__popup.js', (_req, res) => res.type('js').send("window.opener?.postMessage('synthetic-auth', location.origin);"));
    app.get('/__built-home', (_req, res) => res.sendFile(root + 'private/home-built.html', { dotfiles: 'allow' }));
    app.get('/__topics-home', (_req, res) => res.sendFile(root + 'private/index.html', { dotfiles: 'allow' }));
    app.use(express.static(root + 'public'));
    app.use(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const upstream = await fetch(preview.url + req.originalUrl, { method: req.method,
            headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
            ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        res.status(upstream.status).type(upstream.headers.get('content-type') ?? 'application/octet-stream');
        res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { origin: `http://127.0.0.1:${server.address().port}`,
        async close() {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve)); await preview.close();
        } };
}

test('locally served real HTML and native browser behavior obey the enforced policy', { timeout: 120000 }, async t => {
    const site = await fixture();
    const browser = await chromium.launch({ headless: true });
    try {
        await t.test('headers cover static, pages, HEAD and error responses without creating cookies', async () => {
            for (const [path, method, status] of [['/js/global.js', 'GET', 200], ['/css/global.css', 'HEAD', 200],
                ['/privacy', 'GET', 200], ['/missing-static-fixture.js', 'GET', 404]]) {
                const res = await fetch(site.origin + path, { method });
                assert.equal(res.status, status); assert.equal(res.headers.get('content-security-policy'), PRIVACY_CONTENT_SECURITY_POLICY);
                assert.equal(res.headers.get('set-cookie'), null);
                await res.arrayBuffer();
            }
        });

        await t.test('all real application/static HTML matches the reviewed script and handler inventory', async () => {
            const page = await browser.newPage();
            const files = (await readdir(root + 'private')).filter(name => name.endsWith('.html')).map(name => 'private/' + name);
            files.push(...(await readdir(root + 'public', { recursive: true })).filter(name => name.endsWith('.html'))
                .map(name => 'public/' + name.replaceAll('\\', '/')));
            const observed = new Set();
            for (const file of files) {
                const inventory = await page.evaluate(html => {
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    return { scripts: [...doc.scripts].map(node => ({ src: node.getAttribute('src'), text: node.textContent })),
                        handlers: [...doc.querySelectorAll('*')].flatMap(node => [...node.attributes].filter(attr => /^on/i.test(attr.name)).map(attr => attr.name)),
                        scriptLinks: [...doc.querySelectorAll('[href]')].filter(node => /^\s*javascript:/i.test(node.getAttribute('href'))).length };
                }, await readFile(root + file, 'utf8'));
                assert.equal(inventory.handlers.length, 0, `Inline handlers need review in ${file}`);
                assert.equal(inventory.scriptLinks, 0, `Script URLs need review in ${file}`);
                for (const script of inventory.scripts) {
                    if (script.src) {
                        assert.equal(new URL(script.src, site.origin + '/').origin, site.origin, `External script needs review in ${file}`);
                    } else {
                        const hash = 'sha256-' + createHash('sha256').update(script.text).digest('base64');
                        assert.equal(hash, REVIEWED_INLINE_SCRIPT_HASHES[file], `Changed inline script in ${file}; review/externalize it before updating the CSP pin`);
                        observed.add(file);
                    }
                }
            }
            assert.deepEqual([...observed].sort(), Object.keys(REVIEWED_INLINE_SCRIPT_HASHES).sort());
            await page.close();
        });

        await t.test('analytics/unknown scripts, inline handlers, eval and external connections are blocked before network', async () => {
            const context = await browser.newContext();
            const attempted = [];
            await context.route('**/*', route => {
                const request = route.request();
                if (new URL(request.url()).origin === site.origin) return route.continue();
                attempted.push(request.resourceType());
                if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>' });
                return route.abort();
            });
            await context.addInitScript(() => {
                window.policyViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.policyViolations.push(event.effectiveDirective));
            });
            const page = await context.newPage();
            await page.goto(site.origin + '/__policy'); await page.waitForFunction(() => window.probeReady);
            await page.locator('#inline-handler').click();
            assert.deepEqual(await page.evaluate(() => ({ inline: !!window.unreviewedInlineRan, handler: !!window.unreviewedHandlerRan,
                evaluated: !!window.evaluatedCodeRan, evalBlocked: window.evalBlocked, connectBlocked: window.externalConnectBlocked,
                moduleWorks: window.selfModuleWorks })), { inline: false, handler: false, evaluated: false, evalBlocked: true, connectBlocked: true, moduleWorks: true });
            assert.equal(attempted.filter(type => type !== 'image').length, 0);
            assert.equal(await page.locator('#local-image').evaluate(node => node.complete && node.naturalWidth > 0), true);
            assert.equal(await page.locator('#avatar-image').evaluate(node => node.complete && node.naturalWidth > 0), true);
            await page.locator('#open-dialog').click(); await page.locator('#probe-dialog').waitFor({ state: 'visible' });
            await page.locator('#close-dialog').click(); await page.locator('#probe-dialog').waitFor({ state: 'hidden' });
            await page.locator('#probe-form button').click(); await page.waitForFunction(() => window.formWorks);
            const popupPromise = page.waitForEvent('popup');
            await page.evaluate(() => { window.open('/__popup', 'synthetic-oauth'); });
            const popup = await popupPromise; await page.waitForFunction(() => window.popupWorks); await popup.close();
            const violations = await page.evaluate(() => window.policyViolations);
            for (const directive of ['script-src-elem', 'script-src-attr', 'script-src', 'connect-src']) assert.ok(violations.includes(directive));
            await context.close();
        });

        await t.test('source/built home, contribution, legal and help modules run without CSP violations', async () => {
            const context = await browser.newContext();
            await context.route('**/*', route => new URL(route.request().url()).origin === site.origin ? route.continue() : route.abort());
            await context.addInitScript(() => {
                window.applicationPolicyViolations = [];
                document.addEventListener('securitypolicyviolation', event => window.applicationPolicyViolations.push(event.effectiveDirective));
            });
            const page = await context.newPage();
            for (const path of ['/Intelligence', '/__built-home', '/contribute/scores/new', '/privacy', '/terms', '/how-it-works', '/adminlogin', '/censor', '/dialogPage?dialogCode=2']) {
                const res = await page.goto(site.origin + path, { waitUntil: 'networkidle' });
                assert.equal(res.status(), 200, `Local page response for ${path}`);
                assert.equal(new URL(page.url()).pathname, path === '/adminlogin' ? '/censor'
                    : ['/Intelligence', '/__built-home'].includes(path) ? '/language-models' : new URL(site.origin + path).pathname,
                    `Only expected application navigation for ${path}`);
                assert.equal(await page.evaluate(() => window.applicationPolicyViolations.length), 0, `No application CSP violations for ${path}`);
            }
            await context.close();
        });

        await t.test('native click, Enter, target=_blank, Control-click and middle click preserve requested prefill', async () => {
            for (const mode of ['click', 'keyboard', 'blank', 'modified', 'middle', 'late-only', 'imperative']) {
                const context = await browser.newContext();
                const page = await context.newPage();
                await page.goto(site.origin + '/__navigation' + (mode === 'late-only' ? '?late-only' : ''));
                await page.waitForFunction(() => window.navigationReady);
                const count = () => page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).length, prefix);
                assert.equal(await count(), 0, `No eager storage in ${mode}`);
                let target = page;
                if (['blank', 'modified', 'middle'].includes(mode)) {
                    const created = context.waitForEvent('page');
                    await page.locator(mode === 'blank' ? '#blank' : '#primary').click({
                        ...(mode === 'middle' ? { button: 'middle' } : {}), ...(mode === 'modified' ? { modifiers: ['Control'] } : {}) });
                    target = await created;
                } else if (mode === 'keyboard') {
                    await page.locator('#primary').focus(); await page.keyboard.press('Enter');
                } else await page.locator(mode === 'late-only' ? '#late' : mode === 'imperative' ? '#imperative' : '#primary span').click();
                await target.waitForFunction(() => window.handoffWorks);
                assert.equal(new URL(target.url()).hash, '');
                if (target !== page) assert.equal(await count(), 1, `Only requested handoff in ${mode}`);
                await target.reload(); await target.waitForFunction(() => window.handoffWorks);
                await context.close();
            }
        });

        await t.test('real application contribution entry points retain their requested prefill', async workflows => {
            for (const mode of ['Beta', 'Contribute scores', 'Contribute benchmark', 'New benchmark search', 'Bulk import link',
                'Bulk import button', 'Merge button', 'Add condition button', 'Discussion report', 'Score change']) {
                await workflows.test(mode, async () => {
                    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
                    await context.route('**/*', route => new URL(route.request().url()).origin === site.origin ? route.continue() : route.abort());
                    const page = await context.newPage(); page.setDefaultTimeout(10000);
                    const noEagerEntry = async () => assert.equal(await page.evaluate(prefix =>
                        Object.keys(localStorage).filter(key => key.startsWith(prefix)).length, prefix), 0, `No eager handoff for ${mode}`);
                    const readyForm = () => page.locator('#form-surface:not([hidden])').waitFor();
                    try {
                        if (['Bulk import button', 'Add condition button', 'Merge button'].includes(mode)) {
                            await page.goto(site.origin + (mode === 'Merge button' ? '/contribute/benchmarks/101/edit' : '/contribute/benchmarks/new'));
                            await readyForm(); await noEagerEntry();
                            if (mode === 'Bulk import button') await page.locator('#contribution-bulk-import').click();
                            else if (mode === 'Merge button') await page.locator('[data-change-operation="merge"]').click();
                            else {
                                await page.locator('[data-evaluation-name]').fill('General knowledge');
                                await page.locator('[data-select-evaluation="101"]').first().click();
                                await readyForm();
                                assert.equal(new URL(page.url()).pathname, '/contribute/benchmarks/101/edit');
                                assert.equal(await page.locator('[data-condition-input]').last().inputValue(), '');
                            }
                        } else if (mode === 'Beta') {
                            await page.goto(site.origin + '/__topics-home');
                            await page.locator('#beta-feedback-link').waitFor();
                            await noEagerEntry();
                            await page.locator('#beta-feedback-link').click();
                        } else {
                            await page.goto(site.origin + '/Intelligence' + (mode === 'Discussion report' ? '?discussion=1' : ''));
                            await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
                            if (await page.locator('#showcase-enter').isVisible()) await page.locator('#showcase-enter').click();
                            await noEagerEntry();
                            if (mode === 'Contribute scores' || mode === 'Contribute benchmark') {
                                await page.locator(mode === 'Contribute scores' ? '#contribute-data-button' : '#contribute-button').click();
                                await readyForm();
                                assert.equal(new URL(page.url()).pathname, mode === 'Contribute scores' ? '/contribute/scores/new' : '/contribute/benchmarks/new');
                            } else if (mode === 'New benchmark search' || mode === 'Bulk import link') {
                                await page.locator('#benchmark-search').fill('Synthetic missing benchmark xyz');
                                const actions = page.locator('.bp-benchmark-discovery-actions a'); await actions.first().waitFor();
                                await noEagerEntry();
                                await (mode === 'New benchmark search' ? actions.first() : actions.last()).click();
                                if (mode === 'New benchmark search') {
                                    await readyForm();
                                    assert.equal(await page.locator('[data-evaluation-name]').inputValue(), 'Synthetic missing benchmark xyz');
                                }
                            } else if (mode === 'Discussion report') {
                                await page.locator('#post-801 .discussion-report').click(); await readyForm();
                                assert.equal(new URL(page.url()).pathname, '/contribute/discussions/801/report');
                                assert.equal(await page.locator('[data-field="postID"]').inputValue(), '801');
                            } else {
                                await page.locator('#benchmark-rows .bp-benchmark-information-link .bp-benchmark-link-name').first().click();
                                await page.locator('#benchmark-scores-open').click();
                                const edit = page.locator('.benchmark-score-row a[data-tooltip="Change this score"]').first();
                                const path = new URL(await edit.getAttribute('href'), site.origin).pathname;
                                await edit.click(); await readyForm();
                                assert.equal(new URL(page.url()).pathname, path);
                                assert.match(path, /^\/contribute\/scores\/[1-9]\d*\/edit$/);
                            }
                        }
                        if (['Beta', 'Bulk import link', 'Bulk import button', 'Merge button'].includes(mode)) {
                            await page.waitForFunction(() => window.handoffHasDetails);
                        }
                        assert.equal(new URL(page.url()).hash, '');
                    } finally { await context.close(); }
                });
            }
        });
    } finally {
        await browser.close(); await site.close();
    }
});

test('actual edge-injected analytics is blocked under a browser-only CSP overlay (opt-in)', {
    skip: process.env.BENCHPOLL_LIVE_CSP_CHECK !== '1', timeout: 90000
}, async t => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const documentURL = 'https://benchpoll.com/privacy';
    let edgeResponses = 0, edgeStatus, externalAttempts = 0, providerScriptAttempts = 0, transportError;
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
        '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp' };
    try {
        await context.addInitScript(() => {
            window.edgeViolations = [];
            document.addEventListener('securitypolicyviolation', event => {
                let origin;
                try { origin = new URL(event.blockedURI).origin; } catch { return; }
                window.edgeViolations.push({ directive: event.effectiveDirective, origin });
            });
        });
        await context.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (request.isNavigationRequest() && request.url() === documentURL && edgeResponses === 0) {
                edgeResponses++;
                try {
                    const upstream = await route.fetch({ maxRedirects: 0, timeout: 30000,
                        headers: { ...request.headers(), 'accept-encoding': 'identity' } });
                    edgeStatus = upstream.status();
                    const headers = upstream.headers();
                    for (const name of ['nel', 'report-to', 'reporting-endpoints']) delete headers[name];
                    return route.fulfill({ response: upstream, headers: { ...headers, 'cache-control': 'no-store',
                        'content-security-policy': [headers['content-security-policy'], PRIVACY_CONTENT_SECURITY_POLICY].filter(Boolean).join(', ') } });
                } catch (error) {
                    // Do not expose public response headers, provider tokens or cookie values in call logs.
                    transportError = error.name === 'TimeoutError' ? 'Public edge document fetch timed out' : 'Public edge document fetch failed';
                    return route.abort();
                }
            }
            if (url.origin !== new URL(documentURL).origin) { externalAttempts++; return route.abort(); }
            if (url.pathname.startsWith('/cdn-cgi/')) { providerScriptAttempts++; return route.abort(); }
            if (request.method() === 'GET' && /^\/(js|css|assets|vendor)\//.test(url.pathname)
                && !url.pathname.includes('..') && !url.pathname.includes('%') && !url.pathname.includes('\\')) {
                try {
                    const extension = url.pathname.slice(url.pathname.lastIndexOf('.'));
                    return route.fulfill({ contentType: mime[extension] ?? 'application/octet-stream',
                        body: await readFile(root + 'public' + url.pathname) });
                } catch { return route.fulfill({ status: 404, body: '' }); }
            }
            // No production APIs, analytics, account actions or secondary document requests.
            return route.abort();
        });
        const page = await context.newPage();
        try { await page.goto(documentURL, { waitUntil: 'networkidle', timeout: 45000 }); }
        catch { assert.fail(transportError ?? 'Public edge document navigation failed'); }
        assert.equal(edgeResponses, 1); assert.equal(edgeStatus, 200, 'A challenge/error document cannot verify the application response');
        const result = await page.evaluate(() => ({
            injectedAnalytics: [...document.scripts].some(script => {
                try { return new URL(script.src).hostname === 'static.cloudflareinsights.com'; } catch { return false; }
            }),
            challengeScripts: [...document.scripts].filter(script => {
                try { return new URL(script.src).hostname === 'challenges.cloudflare.com'; } catch { return false; }
            }).length,
            blockedAnalytics: window.edgeViolations.some(event => event.directive === 'script-src-elem'
                && event.origin === 'https://static.cloudflareinsights.com')
        }));
        t.diagnostic(JSON.stringify({ ...result, edgeResponses, externalAttempts, providerScriptAttempts, browserOnlyOverlay: true }));
        assert.equal(result.injectedAnalytics, true, 'No analytics injection was present; do not claim live blocking was verified');
        assert.equal(result.blockedAnalytics, true);
        assert.equal(externalAttempts, 0, 'No external request should pass the overlaid CSP');
        assert.equal(providerScriptAttempts, 0, 'Same-origin provider scripts require separate review; no broad exemption is allowed');
    } finally { await context.close(); await browser.close(); }
});
