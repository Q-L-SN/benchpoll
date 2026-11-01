import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
assert.ok(argument('capture'));
const capture = resolve(argument('capture')), baseline = JSON.parse(await readFile(join(capture, 'baseline.json'), 'utf8'));
const output = join(capture, 'browser-' + Date.now()), root = baseline.root, sha = bytes => createHash('sha256').update(bytes).digest('hex');
const resources = new Map(), origin = 'https://benchpoll.com';
const contentTypes = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
for (const file of baseline.files) {
    const bytes = await readFile(join(root, file.path)); assert.equal(sha(bytes), file.hash, 'Captured source drift: ' + file.path);
    if (file.path.startsWith('public/')) resources.set('/' + file.path.slice(7), { bytes, contentType: contentTypes[extname(file.path)] });
}
await mkdir(output, { recursive: true });
const results = [], env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '',
    all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await driver.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) for (const repetition of [1, 2]) {
            const variants = repetition === 1 ? ['natural', 'local-static'] : ['local-static', 'natural'];
            for (const variant of variants) {
                const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
                const page = await context.newPage(), result = { engine, width, repetition, variant, passed: false,
                    errors: [], failures: [], rejectedWrites: [], suppliedStatic: [], api: [], requests: [] };
                results.push(result); const requests = new Map(), pending = new Set(); let started = performance.now();
                page.setDefaultTimeout(75000);
                page.on('pageerror', error => result.errors.push(error.message));
                page.on('request', request => {
                    const url = new URL(request.url()); if (url.origin !== origin) return;
                    const item = { path: url.pathname + url.search, type: request.resourceType(), startMs: Math.round(performance.now() - started) };
                    result.requests.push(item); requests.set(request, item);
                });
                page.on('requestfinished', request => {
                    const item = requests.get(request); if (!item) return;
                    const work = (async () => {
                        item.timing = request.timing(); const response = await request.response(); item.status = response?.status();
                        if (response) {
                            const headers = await response.allHeaders();
                            item.headers = Object.fromEntries(['cache-control', 'content-encoding', 'cf-cache-status', 'content-length']
                                .filter(name => headers[name]).map(name => [name, headers[name]]));
                        }
                    })().catch(error => { item.observationError = error.message; });
                    pending.add(work); void work.finally(() => pending.delete(work));
                });
                page.on('requestfailed', request => { const item = requests.get(request); if (item) item.failure = request.failure()?.errorText; });
                page.on('response', response => {
                    const url = new URL(response.url()); if (url.origin !== origin) return;
                    if (url.pathname === '/api/get_user_profile') result.profileStatus = response.status();
                    if (response.status() >= 400) result.failures.push({ path: url.pathname, status: response.status() });
                });
                await page.route('**/*', async route => {
                    const request = route.request(), url = new URL(request.url());
                    if (url.origin !== origin) return route.continue();
                    if (url.pathname.startsWith('/api/')) {
                        result.api.push({ path: url.pathname, method: request.method() });
                        if (!['GET', 'HEAD'].includes(request.method()) && !url.pathname.startsWith('/api/get_')) {
                            result.rejectedWrites.push(url.pathname); return route.abort();
                        }
                    }
                    const asset = resources.get(url.pathname);
                    if (variant === 'local-static' && asset) {
                        assert.ok(asset.contentType); result.suppliedStatic.push(url.pathname + url.search);
                        return route.fulfill({ body: asset.bytes, contentType: asset.contentType });
                    }
                    return route.continue();
                });
                try {
                    started = performance.now();
                    assert.equal((await page.goto(origin + '/Intelligence', { waitUntil: 'domcontentloaded' })).status(), 200);
                    result.documentMs = Math.round(performance.now() - started);
                    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    result.readyMs = Math.round(performance.now() - started);
                    result.profileStatus ??= await page.evaluate(async () => (await fetch('/api/get_user_profile', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
                    assert.equal(result.profileStatus, 204);
                    result.benchmarkRows = await page.locator('.bp-benchmark-row').count(); result.modelRows = await page.locator('.bp-model-row').count();
                    assert.ok(result.benchmarkRows > 0 && result.modelRows > 0);
                    if (width < 760) await page.getByRole('button', { name: 'Model ranking', exact: true }).click();
                    await page.locator('#model-card[aria-busy="false"]').waitFor();
                    result.resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({
                        path: new URL(entry.name).pathname + new URL(entry.name).search, type: entry.initiatorType,
                        startMs: Math.round(entry.startTime), requestMs: Math.round(entry.requestStart), headersMs: Math.round(entry.responseStart),
                        endMs: Math.round(entry.responseEnd), durationMs: Math.round(entry.duration), protocol: entry.nextHopProtocol,
                        decodedBytes: entry.decodedBodySize, encodedBytes: entry.encodedBodySize, transferBytes: entry.transferSize })));
                    result.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
                    assert.equal(result.horizontalOverflow, false); assert.deepEqual(result.errors, []);
                    assert.deepEqual(result.failures, []); assert.deepEqual(result.rejectedWrites, []);
                    await page.screenshot({ path: join(output, `${engine}-${width}-${repetition}-${variant}.png`) });
                    result.passed = true;
                } catch (error) { result.error = error.stack; }
                finally {
                    await context.close(); for (const work of [...pending]) await work;
                    console.log(JSON.stringify({ engine, width, repetition, variant, passed: result.passed, documentMs: result.documentMs,
                        readyMs: result.readyMs, supplied: result.suppliedStatic.length, error: result.error }));
                    await writeFile(join(output, 'progress.json'), JSON.stringify({ results }, null, 2));
                }
            }
        }
    } finally { await browser.close(); }
}
const sourceDrift = [];
for (const file of baseline.files) if (sha(await readFile(join(root, file.path))) !== file.hash) sourceDrift.push(file.path);
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const serverDrift = JSON.parse(execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, 'ubuntu@18.226.222.18', 'node --input-type=module'], {
    input: `import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';const drift=[];
for(const f of ${JSON.stringify(baseline.files)}){let actual=null;try{actual=createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+f.path)).digest('hex');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==f.hash)drift.push(f.path);}console.log(JSON.stringify(drift));`,
    encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024
}));
const report = { passed: results.every(result => result.passed) && sourceDrift.length === 0 && serverDrift.length === 0,
    results, sourceDrift, serverDrift, source: join(capture, 'baseline.json'),
    scope: 'Alternated fresh anonymous natural/local-static browser contexts. The production document and read-only APIs remain live in both variants. Local-static serves exact captured installed files only inside the test browser; no application or production business data is changed. API cache/data may change naturally, and this is not a latency SLA.' };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(join(output, 'report.json')); assert.equal(report.passed, true);
