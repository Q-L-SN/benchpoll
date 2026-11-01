import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { chromium, webkit } from 'playwright';

const require = createRequire(import.meta.url);
const origin = 'https://benchpoll.com';
const artifact = resolve('artifacts/review-20261008/cloudflare-residual-investigation.json');
const summarize = process.argv.includes('--summarize');
const reduction = process.argv.includes('--reduction');
const extra = process.argv.includes('--extra') || reduction || summarize;
const paths = ['/how-it-works', '/privacy', '/terms', '/contribute/scores/new'];
const selectedHeaders = new Set([
    'server', 'cf-ray', 'cf-cache-status', 'cache-control', 'content-type', 'content-length',
    'content-security-policy', 'content-security-policy-report-only', 'referrer-policy',
    'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods',
    'access-control-allow-headers', 'location', 'vary', 'allow', 'origin', 'referer',
    'sec-fetch-mode', 'sec-fetch-site', 'user-agent', 'accept',
    'access-control-request-method', 'access-control-request-headers',
]);
const headersFor = headers => Object.fromEntries(Object.entries(headers).filter(([key]) => selectedHeaders.has(key.toLowerCase())));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const isRum = url => new URL(url).pathname === '/cdn-cgi/rum';
const report = extra ? JSON.parse(await readFile(artifact, 'utf8')) : {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    scope: 'Read-only public production investigation; no application/test edits, secrets, account access, deployment, or Cloudflare configuration changes.',
    expected: 'Docs navigations complete without uncaught page errors. Beacon requests complete or have explicitly recorded failures.',
    environment: {
        node: process.version, platform: process.platform, architecture: process.arch,
        playwright: require('playwright/package.json').version,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
        workingTree: 'Pre-existing changes present; concurrent parent and styling worker. Application source not changed by this investigation.',
        origin,
    },
    originalSmoke: JSON.parse(await readFile(resolve('artifacts/review-20261008/transaction-cleanup-production-smoke/results.json'), 'utf8')),
    sourceEvidence: {
        launchCheck: 'scripts/frontend/launch-check.mjs:83-92: docs loop uses domcontentloaded + document.fonts.ready, no wait for load/beacon completion; all pageerrors asserted empty.',
        routes: 'server.js:369-378: docs served using res.sendFile of private templates.',
        localBeaconSearch: 'rg -n -i "cloudflare|cdn-cgi|beacon|content-security-policy|access-control|rum" private public/js server.js ops/nginx/benchpoll.conf package.json scripts/frontend/server.mjs: no beacon/embed or CORS/CSP rule for RUM.',
    },
    references: [
        'https://developers.cloudflare.com/web-analytics/faq/',
        'https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/',
        'https://www.w3.org/TR/beacon/',
    ],
    publicInspection: [],
    cases: [],
};

if (summarize) {
    const rum = report.cases.flatMap(testCase => testCase.network.filter(request => isRum(request.url)).map(request => ({ engine: testCase.engine, mode: testCase.mode, repetition: testCase.repetition, ...request })));
    const groups = new Map();
    for (const testCase of report.cases) {
        const key = testCase.engine + ':' + testCase.mode;
        if (!groups.has(key)) groups.set(key, { engine: testCase.engine, mode: testCase.mode, repetitions: 0, repetitionsWithPageErrors: 0, pageErrorsPerRun: [], rumFailuresPerRun: [], rumFinishedPerRun: [], driverErrors: [] });
        const group = groups.get(key);
        group.repetitions++;
        group.repetitionsWithPageErrors += Number(testCase.errors.length > 0);
        group.pageErrorsPerRun.push(testCase.errors.length);
        group.rumFailuresPerRun.push(testCase.summary.rumFailures.length);
        group.rumFinishedPerRun.push(testCase.summary.rumFinished);
        if (testCase.driverError) group.driverErrors.push(testCase.driverError);
    }
    report.observationSummary = {
        totalCases: report.cases.length,
        pageErrorEvents: report.cases.reduce((sum, testCase) => sum + testCase.errors.length, 0),
        failedHttpResponses: report.cases.reduce((sum, testCase) => sum + testCase.summary.failedResponses.length, 0),
        rumRequests: rum.length,
        rumFinished: rum.filter(request => request.finished).length,
        rumFailures: rum.filter(request => request.failure).length,
        rumFailureTexts: [...new Set(rum.filter(request => request.failure).map(request => request.failure.errorText))],
        rumResponseStatuses: [...new Set(rum.filter(request => request.response).map(request => request.response.status))],
        rumResponseAllowOrigins: [...new Set(rum.filter(request => request.response).map(request => request.response.headers?.['access-control-allow-origin']))],
        rumResponseAllowCredentials: [...new Set(rum.filter(request => request.response).map(request => request.response.headers?.['access-control-allow-credentials']))],
        nonRumFailures: report.cases.flatMap(testCase => testCase.network.filter(request => request.failure && !isRum(request.url)).map(request => ({ engine: testCase.engine, mode: testCase.mode, repetition: testCase.repetition, url: request.url, failure: request.failure }))),
        groups: [...groups.values()],
        pageErrorNavigationRelations: report.cases.flatMap(testCase => testCase.errors.map(error => {
            const previousGoto = testCase.events.filter(event => event.type === 'goto-start' && event.elapsedMs <= error.elapsedMs).at(-1);
            const previousLoad = testCase.events.filter(event => event.type === 'load' && event.currentUrl === error.currentUrl && event.elapsedMs <= error.elapsedMs).at(-1);
            return { engine: testCase.engine, mode: testCase.mode, repetition: testCase.repetition, at: error.at, currentUrl: error.currentUrl, phase: error.phase, navigationFrom: previousGoto?.fromUrl, navigationTo: previousGoto?.toUrl, afterGotoStartMs: previousGoto ? Math.round((error.elapsedMs - previousGoto.elapsedMs) * 100) / 100 : null, afterLoadMs: previousLoad ? Math.round((error.elapsedMs - previousLoad.elapsedMs) * 100) / 100 : null };
        })),
    };
    report.sourceEvidence.snapshots = [];
    for (const path of ['private/privacy.html', 'private/terms.html', 'private/how-it-works.html', 'public/js/legal.js', 'scripts/frontend/launch-check.mjs']) {
        const source = await readFile(resolve(path), 'utf8');
        report.sourceEvidence.snapshots.push({ path, capturedAt: new Date().toISOString(), bytes: Buffer.byteLength(source), sha256: sha256(source), includesBeacon: source.includes('data-cf-beacon') });
    }
    const plainPrivacy = report.publicInspection.find(inspection => inspection.url === origin + '/privacy' && inspection.method === 'GET' && !inspection.includesBeacon);
    report.sourceEvidence.plainPublicPrivacyMatchesLocal = plainPrivacy?.bodySha256 === report.sourceEvidence.snapshots.find(snapshot => snapshot.path === 'private/privacy.html')?.sha256;
    const originalSmokeSource = await readFile(resolve('artifacts/review-20261008/transaction-cleanup-production-smoke/results.json'), 'utf8');
    report.originalSmokeIntegrity = { path: 'artifacts/review-20261008/transaction-cleanup-production-smoke/results.json', sha256: sha256(originalSmokeSource), sameStructureAsCapturedAtStart: JSON.stringify(JSON.parse(originalSmokeSource)) === JSON.stringify(report.originalSmoke) };
    report.conclusions = {
        classification: 'Cloudflare-beacon load-metrics XHR / WebKit rapid-navigation lifecycle race; not an evidenced BenchPoll application bug or persistent endpoint CORS denial.',
        confidence: 'High for the observed navigation-timing dependency and third-party source; exact WebKit internal failure path is not established.',
        evidence: [
            'Original docs-only sequence reproduced the exact pageerror twice (2/2 runs, two events each), without the workspace/DB flows.',
            'Pageerror stacks originate in the public Cloudflare script a -> vt -> pt. They occur a few milliseconds after the outgoing goto starts, before the next document commits.',
            'The public beacon schedules pt with setTimeout on load, and uses asynchronous XHR for vt load metrics even though navigator.sendBeacon is present. Its WebVitals path uses sendBeacon separately.',
            'Both load-plus-2500ms runs and both per-document-XHR-204-completion runs had zero WebKit pageerrors and zero request failures; all seven observed RUM requests finished in each run.',
            'Public OPTIONS probes allow the exact origin, POST and Content-Type; observed live POST responses are 204 with matching ACAO and ACAC. No failed HTTP responses or cross-origin redirects to RUM observed.',
            'A beacon-only document with no BenchPoll scripts or styles produced the same pageerror in 1/2 runs. The public default-UA privacy HTML exactly matches the local template; browser-UA HTML injects the beacon.',
        ],
        smallestObservedReproduction: 'WebKit: /privacy -> /terms -> /privacy using domcontentloaded + document.fonts.ready, with no post-load wait; exact exception occurred on the /terms departure in 1/2 runs. This is intermittent, not a deterministic minimal reproduction. The original four-route docs loop failed 2/2.',
        recommendation: 'For production page-content smoke pages containing the injected beacon, arm a bounded current-document load-metrics XHR response wait before goto; match /cdn-cgi/rum, resourceType xhr and payload.location to the destination URL; require status 204 and response.finished() without error before the next goto. Do not require this external beacon in a local preview that does not contain it. Continue capturing and asserting all pageerrors and HTTP failures. Preserve immediate-navigation as a separate observed-failing telemetry/lifecycle scenario; do not filter it into a green result.',
        noSupportedChange: 'No application CORS/CSP change or Cloudflare hostname/referrer setting change is supported by this evidence. No implementation, test or infrastructure repair was made.',
        strictSmokeStatus: 'Original strict production smoke remains FAILED in WebKit; no diagnostic result is a substitute for that failure.',
        uncertainties: [
            'The smaller legal-only, three-docs, and beacon-only reductions were intermittent (each exact exception in 1/2). Twenty browser cases do not establish universal frequency.',
            'No genuine CORS denial was observed on this route, origin, script version and AMS edge. Other origins, user networks or Cloudflare rules were not tested; private settings were not read.',
            'Real macOS/iOS Safari was not tested. The evidence is from headless Playwright WebKit 26.5 on Windows.',
            'No engine debug trace was taken; cancellation of already-started XHR and rejection before an observable network request are distinct recorded outcomes, not assumed to be the same event.',
            'Only the docs residual was reduced; the complete workspace smoke was not rerun and the parent DB deadline work was not evaluated.',
        ],
    };
    report.finalizedAt = new Date().toISOString();
    report.reproductionCommands = ['node scripts/review-cloudflare-residual-20261008.mjs', 'node scripts/review-cloudflare-residual-20261008.mjs --extra', 'node scripts/review-cloudflare-residual-20261008.mjs --reduction', 'node scripts/review-cloudflare-residual-20261008.mjs --summarize'];
    await writeFile(artifact, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ observationSummary: report.observationSummary, originalSmokeIntegrity: report.originalSmokeIntegrity, conclusions: report.conclusions }, null, 2));
    process.exit(0);
}

async function inspectPublic(url, options = {}) {
    const start = performance.now();
    try {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000), ...options });
        const body = await response.text();
        const observation = {
            at: new Date().toISOString(), method: options.method ?? 'GET', url, finalUrl: response.url,
            sentHeaders: headersFor(options.headers ?? {}), status: response.status,
            headers: headersFor(Object.fromEntries(response.headers)), durationMs: Math.round(performance.now() - start),
            bodyBytes: Buffer.byteLength(body), bodySha256: sha256(body),
            includesBeacon: body.includes('static.cloudflareinsights.com/beacon.min.js'),
        };
        report.publicInspection.push(observation);
        return { observation, body };
    } catch (error) {
        report.publicInspection.push({ at: new Date().toISOString(), url, method: options.method ?? 'GET', error: error.stack });
        return null;
    }
}

const browserEnv = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, launcher] of [['webkit', webkit], ['chromium', chromium]]) {
    if (extra && engine !== 'webkit') continue;
    const browser = await launcher.launch({ headless: true, env: browserEnv });
    report.environment[`${engine}Version`] = browser.version();
    try {
        const modes = reduction ? ['three-docs-immediate']
            : extra ? ['minimal-immediate', 'beacon-only-immediate', 'completion-wait'] : ['immediate', 'settled', 'single-page-stay'];
        for (const mode of modes) {
            for (let repetition = 1; repetition <= 2; repetition++) {
                const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
                const page = await context.newPage();
                page.setDefaultNavigationTimeout(45000);
                const testCase = { engine, mode, repetition, startedAt: new Date().toISOString(), events: [], network: [], navigations: [], documents: [], errors: [], console: [] };
                const start = performance.now();
                const timestamp = () => ({ at: new Date().toISOString(), elapsedMs: Math.round((performance.now() - start) * 100) / 100 });
                const pending = [];
                const requests = new Map();
                let phase = 'setup';
                let requestId = 0;
                page.on('pageerror', error => {
                    const item = { ...timestamp(), phase, currentUrl: page.url(), name: error.name, message: error.message, stack: error.stack };
                    testCase.errors.push(item);
                    testCase.events.push({ type: 'pageerror', ...item });
                });
                page.on('console', message => testCase.console.push({ ...timestamp(), phase, type: message.type(), text: message.text(), location: message.location() }));
                page.on('load', () => testCase.events.push({ type: 'load', ...timestamp(), phase, currentUrl: page.url() }));
                page.on('domcontentloaded', () => testCase.events.push({ type: 'domcontentloaded', ...timestamp(), phase, currentUrl: page.url() }));
                page.on('framenavigated', frame => {
                    if (frame === page.mainFrame()) testCase.events.push({ type: 'framenavigated', ...timestamp(), phase, url: frame.url() });
                });
                page.on('request', request => {
                    const item = { id: ++requestId, ...timestamp(), phase, currentUrl: page.url(), url: request.url(), method: request.method(), resourceType: request.resourceType() };
                    requests.set(request, item);
                    testCase.network.push(item);
                    pending.push(request.allHeaders().then(headers => { item.requestHeaders = headersFor(headers); }).catch(error => { item.requestHeadersError = error.message; }));
                    if (isRum(request.url())) {
                        const data = request.postData();
                        item.payloadBytes = data ? Buffer.byteLength(data) : 0;
                        item.payloadSha256 = data ? sha256(data) : null;
                        try {
                            const payload = JSON.parse(data);
                            item.payloadSummary = { eventType: payload.eventType, location: payload.location, referrer: payload.referrer, startTime: payload.startTime, documentTimings: payload.timingsV2, keyNames: Object.keys(payload) };
                        } catch { item.payloadSummary = 'Non-JSON payload; not recorded.'; }
                    }
                });
                page.on('response', response => {
                    const item = requests.get(response.request());
                    if (!item) return;
                    item.response = { ...timestamp(), status: response.status(), url: response.url(), fromServiceWorker: response.fromServiceWorker() };
                    pending.push(response.allHeaders().then(headers => { item.response.headers = headersFor(headers); }).catch(error => { item.response.headersError = error.message; }));
                });
                page.on('requestfinished', request => {
                    const item = requests.get(request);
                    if (item) { item.finished = timestamp(); item.timing = request.timing(); }
                });
                page.on('requestfailed', request => {
                    const item = requests.get(request);
                    if (item) { item.failure = { ...timestamp(), phase, currentUrl: page.url(), errorText: request.failure()?.errorText }; item.timing = request.timing(); }
                });
                try {
                    if (mode === 'beacon-only-immediate') {
                        phase = 'fixture-seed';
                        await page.goto(origin + '/privacy', { waitUntil: 'load' });
                        const beaconTag = await page.evaluate(() => [...document.scripts].find(script => script.src.includes('cloudflareinsights'))?.outerHTML);
                        if (!beaconTag) throw new Error('No public beacon tag was available for the diagnostic fixture.');
                        await page.waitForTimeout(2500);
                        testCase.fixture = {
                            seedUrl: origin + '/privacy',
                            description: 'Only /privacy and /terms document responses are fulfilled inside this fresh browser context with an otherwise empty HTML document containing the unmodified publicly injected beacon tag. The external beacon script and RUM endpoint remain live. No BenchPoll CSS or application JS in the fixture; no source/server changes.',
                            scriptToken: 'Public token kept in memory only; not persisted.',
                        };
                        await page.route(url => [origin + '/privacy', origin + '/terms'].includes(url.href), route => route.fulfill({
                            status: 200, contentType: 'text/html; charset=utf-8',
                            body: '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Beacon-only diagnostic</title></head><body>' + beaconTag + '</body></html>',
                        }));
                    }
                    const immediate = mode.endsWith('immediate') || mode === 'completion-wait';
                    const routeList = mode === 'single-page-stay' ? ['/privacy']
                        : mode === 'minimal-immediate' || mode === 'beacon-only-immediate' ? ['/privacy', '/terms', '/privacy']
                            : mode === 'three-docs-immediate' ? ['/how-it-works', '/privacy', '/terms'] : paths;
                    for (const path of routeList) {
                        phase = `navigate:${path}`;
                        const navigation = { ...timestamp(), path, waitUntil: immediate ? 'domcontentloaded' : 'load' };
                        testCase.navigations.push(navigation);
                        testCase.events.push({ type: 'goto-start', ...timestamp(), phase, fromUrl: page.url(), toUrl: origin + path });
                        const loadBeacon = mode === 'completion-wait' ? page.waitForResponse(response => {
                            if (!isRum(response.url()) || response.request().resourceType() !== 'xhr') return false;
                            try { return response.request().postDataJSON()?.location === origin + path; } catch { return false; }
                        }, { timeout: 12000 }).then(async response => ({ status: response.status(), finishedError: await response.finished(), url: response.url(), ...timestamp() }))
                            .catch(error => ({ error: error.message, ...timestamp() })) : null;
                        const response = await page.goto(origin + path, { waitUntil: navigation.waitUntil });
                        navigation.status = response?.status();
                        phase = `fonts:${path}`;
                        await page.evaluate(() => document.fonts.ready);
                        navigation.afterFonts = timestamp();
                        const document = await page.evaluate(() => ({
                            url: location.href, origin: location.origin, readyState: document.readyState,
                            referrer: document.referrer, referrerPolicy: document.referrerPolicy,
                            sendBeaconType: typeof navigator.sendBeacon,
                            userAgent: navigator.userAgent,
                            width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
                            beaconScripts: [...document.scripts].filter(script => script.src.includes('cloudflareinsights')).map(script => {
                                let config = null;
                                try { config = JSON.parse(script.getAttribute('data-cf-beacon')); } catch { /* Public HTML may use a query-string configuration. */ }
                                return { src: script.src, type: script.type, defer: script.defer, async: script.async, integrity: script.integrity, crossOrigin: script.crossOrigin, config: config ? { ...config, token: '[public-token-redacted]' } : null };
                            }),
                        }));
                        testCase.documents.push({ ...timestamp(), ...document });
                        if (loadBeacon) {
                            phase = `complete-beacon:${path}`;
                            navigation.beaconCompletion = await loadBeacon;
                            if (navigation.beaconCompletion.error || navigation.beaconCompletion.finishedError || navigation.beaconCompletion.status !== 204) {
                                throw new Error('Current-document beacon did not successfully complete: ' + JSON.stringify(navigation.beaconCompletion));
                            }
                        }
                        if (!immediate) {
                            phase = `settle:${path}`;
                            await page.waitForTimeout(mode === 'single-page-stay' ? 7000 : 2500);
                            navigation.afterSettle = timestamp();
                        }
                    }
                    phase = 'final-observation';
                    await page.waitForTimeout(4000);
                    testCase.errorsBeforeClose = testCase.errors.length;
                    testCase.networkFailuresBeforeClose = testCase.network.filter(item => item.failure).length;
                } catch (error) {
                    testCase.driverError = { ...timestamp(), phase, message: error.message, stack: error.stack };
                } finally {
                    phase = 'close';
                    testCase.events.push({ type: 'close-start', ...timestamp(), phase });
                    await context.close();
                    await Promise.allSettled(pending);
                    testCase.endedAt = new Date().toISOString();
                    testCase.summary = {
                        pageErrors: testCase.errors.length,
                        errorsBeforeClose: testCase.errorsBeforeClose,
                        networkFailures: testCase.network.filter(item => item.failure).length,
                        rumRequests: testCase.network.filter(item => isRum(item.url)).length,
                        rumFinished: testCase.network.filter(item => isRum(item.url) && item.finished).length,
                        rumFailures: testCase.network.filter(item => isRum(item.url) && item.failure).map(item => ({ id: item.id, url: item.url, method: item.method, resourceType: item.resourceType, failure: item.failure, response: item.response })),
                        failedResponses: testCase.network.filter(item => item.response?.status >= 400).map(item => ({ id: item.id, url: item.url, status: item.response.status })),
                    };
                    report.cases.push(testCase);
                    await writeFile(artifact, JSON.stringify(report, null, 2) + '\n', 'utf8');
                    console.log(JSON.stringify({ engine, mode, repetition, summary: testCase.summary, errors: testCase.errors, driverError: testCase.driverError }));
                }
            }
        }
    } finally { await browser.close(); }
}

const inspectedUa = report.cases.find(item => item.engine === 'webkit')?.documents[0]?.userAgent;
for (let repetition = 1; repetition <= 2; repetition++) {
    await inspectPublic(origin + '/privacy');
    await inspectPublic(origin + '/privacy', { headers: { 'User-Agent': inspectedUa, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    await inspectPublic(origin + '/cdn-cgi/rum?', { method: 'OPTIONS', headers: { Origin: origin, Referer: origin + '/privacy', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
}
const scriptUrl = report.cases.flatMap(item => item.documents).flatMap(item => item.beaconScripts).find(item => item.src)?.src;
if (scriptUrl) {
    const inspection = await inspectPublic(scriptUrl);
    if (inspection) {
        const snippetFor = term => {
            const index = inspection.body.indexOf(term);
            return index === -1 ? null : { term, offset: index };
        };
        report.beaconSource = {
            url: scriptUrl, sha256: sha256(inspection.body),
            snippets: ['sendBeacon', 'XMLHttpRequest', 'vt(', 'pt(', 'visibilitychange'].map(snippetFor),
            loadSchedulingExcerpt: inspection.body.slice(inspection.body.indexOf('"complete"===window.document.readyState?pt()'), inspection.body.indexOf('"complete"===window.document.readyState?pt()') + 125),
            xhrSendExcerpt: inspection.body.slice(inspection.body.indexOf('o.open("POST",a,!0)'), inspection.body.indexOf('o.open("POST",a,!0)') + 87),
            observation: 'Load-metrics vt calls sender a with false in the sendBeacon selector argument, so it selects async XHR even when navigator.sendBeacon exists. pt is scheduled via setTimeout from load. WebVitals gt calls the same sender with true, selecting sendBeacon.',
        };
    }
}
report.finishedAt = new Date().toISOString();
report.conclusions = 'Pending manual evidence review; no pageerror or failed request filtered or suppressed.';
await writeFile(artifact, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log('Artifact: ' + artifact);
