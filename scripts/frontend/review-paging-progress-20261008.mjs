import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { workspace, familyEntries } from './fixtures.mjs';
import { createRankingPager } from '../../ranking-pagination.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = 'D:/BenchPoll-artifacts/review-20261008/paging-progress-production-before';
const runID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const output = join(root, 'artifacts/review-20261008', `paging-progress-browser-${runID}`);
const argument = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const engines = argument('engines', 'chromium,webkit').split(',');
const widths = argument('widths', '1440,390').split(',').map(Number);
const repetitions = Number(argument('repeat', '2'));
const scenarios = argument('scenarios', 'eviction-retry,expiry-search-folds,stale-refresh').split(',');
assert.ok(engines.length && engines.every(name => ['chromium', 'webkit'].includes(name)));
assert.ok(widths.length && widths.every(width => [1440, 390].includes(width)));
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
assert.ok(scenarios.length && scenarios.every(name => ['eviction-retry', 'expiry-search-folds', 'stale-refresh'].includes(name)));
await mkdir(output, { recursive: false });
const sha256 = data => createHash('sha256').update(data).digest('hex');
const save = async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2), { flag: 'wx' });
};
const sourceBytes = new Map();
async function captureDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await captureDirectory(path);
        else if (/\.(?:js|css)$/.test(entry.name)) sourceBytes.set(relative(root, path).replaceAll('\\', '/'), await readFile(path));
    }
}
await captureDirectory(join(root, 'public/js'));
await captureDirectory(join(root, 'public/css'));
for (const path of ['private/home.html', 'ranking-pagination.js', 'server.js', 'package.json', 'package-lock.json', 'scripts/frontend/server.mjs',
    'scripts/frontend/fixtures.mjs', 'scripts/frontend/review-paging-progress-20261008.mjs']) {
    sourceBytes.set(path, await readFile(join(root, path)));
}
const beforeBytes = new Map();
for (const path of ['public/js/home-workspace.js', 'public/js/workspace/contracts.js',
    'public/js/workspace/benchmark-fallback-catalogue.js', 'public/js/contribution/score-fields.js', 'ranking-pagination.js', 'server.js']) {
    try { beforeBytes.set(path, await readFile(join(baseline, path))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const manifest = {
    runID, output, command: [process.execPath, ...process.argv.slice(1)], timestamp: new Date().toISOString(),
    node: process.version, platform: process.platform, playwright: JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8')).version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    engines, widths, repetitions, scenarios, baseline,
    boundary: 'Loopback preview only. Synthetic account 7. No application edits, production API, SSH, database, auth, social network, or writes.',
    currentSources: [...sourceBytes].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    beforeSources: [...beforeBytes].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    limits: [
        'Before control overlays captured installed frontend files onto the current preview and exported current pager, not an old server deployment.',
        'Synthetic data and deterministic held responses do not measure production traffic, latency, or multi-worker routing.',
        'Some pagination/disclosure buttons use DOM-dispatched clicks to hold scroll anchors; actual model continuation uses the rendered scroll surface.',
        'Range scoring, one context, one fallback entrance, and best/model comparison are covered; real accounts and writes are intentionally excluded.'
    ]
};
manifest.sourceSetID = sha256(JSON.stringify({ current: manifest.currentSources, before: manifest.beforeSources }));
manifest.completeMatrix = engines.length === 2 && widths.length === 2 && repetitions >= 2 && scenarios.length === 3;
await save(join(output, 'manifest.json'), manifest);
for (const [path, bytes] of sourceBytes) await save(join(output, 'sources/current', path), bytes);
for (const [path, bytes] of beforeBytes) await save(join(output, 'sources/before', path), bytes);
const results = [];
const environment = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const groups = ['primary', 'other', 'lowCoverage'];
const rows = { benchmarks: '#benchmark-rows .bp-benchmark-row:not(.is-family)', models: '#model-rows .bp-model-row',
    fallbacks: '#benchmark-fallback-configs-1 .bp-benchmark-row.is-family' };
const fallbackToggle = '.bp-benchmark-fallbacks[data-entrance-id="1"] .bp-benchmark-fallback-toggle';
const fallbackMore = '#benchmark-fallback-configs-1 .bp-fallback-catalogue-more';
const benchmarkMore = group => `.bp-ranking-page-footer[data-benchmark-group="${group}"] button`;
const pageKey = body => body.list === 'benchmarks' ? `benchmarks:${body.group}` : body.list === 'fallbacks' ? `fallbacks:${body.conditionID}` : body.list;
const tag = revision => `[R${String(revision).padStart(3, '0')}]`;

function rawFixture(state, body, revision) {
    const raw = structuredClone(workspace(state, body, { paginate: false }));
    const ordinary = raw.benchmarks.filter(row => !row.isFamily);
    for (const [groupIndex, group] of ['other', 'lowCoverage'].entries()) {
        for (let index = 0; index < 48; index++) {
            const ID = 4001 + groupIndex * 100 + index;
            raw.benchmarks.push({ ...structuredClone(ordinary[index % ordinary.length]), ID, conditionID: ID,
                benchmarkID: ordinary[index % ordinary.length].benchmarkID, rank: ID,
                conditionName: `${group} ${index + 1}`, conditionKey: `${group}-${index + 1}`,
                isDefaultCondition: false, isPrimaryCondition: false, lowCoverage: group === 'lowCoverage',
                publicWeight: 0, publicWeightBasisPoints: 0, personalWeight: null });
        }
    }
    const conditions = new Map(raw.benchmarks.filter(row => !row.isFamily).map(row => [row.conditionID, row]));
    for (const row of conditions.values()) row.name = `Suite ${row.name} ${tag(revision)}`;
    const reviseEntry = entry => ({ ...entry, name: conditions.get(entry.conditionID)?.name ?? entry.name });
    for (const pie of [raw.personalPie, raw.publicPie]) pie.entries = pie.entries.map(reviseEntry);
    for (const row of raw.benchmarks.filter(row => row.isFamily)) {
        row.name = conditions.get(row.conditionID).name;
        row.familyEntries = row.familyEntries.map(reviseEntry);
    }
    for (const mode of ['personal', 'public']) {
        for (const model of raw.modelLeaderboards[mode]) {
            const difference = revision * .1;
            model.name += ` ${tag(revision)}`;
            model.lower += difference;
            model.upper += difference;
            for (const score of model.calculationScores) {
                score.normalizedScore += difference * 100 / model.coverage;
                score.contribution = score.normalizedScore * score.effectiveWeight / 100;
                score.memberEvidence.forEach(item => { item.hash = sha256(`${revision}:${item.ID}`); });
            }
        }
    }
    raw.comparison.models = raw.comparison.models.map(model => ({ ...model, name: `${model.name} ${tag(revision)}` }));
    raw.personalPie.revision = revision;
    raw.serverTime = new Date(Date.UTC(2026, 9, 8, 0, 0, revision)).toISOString();
    return raw;
}

async function until(predicate, label, timeout = 15000) {
    const started = Date.now();
    while (!await predicate()) {
        if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`);
        await delay(30);
    }
}

async function rehearse(browser, engine, width, repetition, name, before = false) {
    const ID = `${before ? 'before' : 'after'}-${engine}-${width}-${name}-${repetition}`;
    const directory = join(output, ID);
    await mkdir(directory);
    const record = { ID, engine, width, repetition, name, before, sourceSetID: manifest.sourceSetID, passed: false,
        checks: [], errors: [], console: [], requests: [], responses: [], blocked: [], servedSources: [], events: [] };
    results.push(record);
    const app = await startPreview({ userID: '7', authenticated: true, rankingStress: true,
        families: [2, 3, 4, 5, 6, 7, 8].flatMap(left => [2, 3, 4, 5, 6, 7, 8].filter(right => right !== left)
            .map(right => ({ primaryConditionID: 1, familyID: left * 100 + right, mode: 'ordered',
                entries: familyEntries([{ conditionID: left }, { conditionID: right }]) }))) });
    const context = await browser.newContext({ viewport: { width, height: 960 }, hasTouch: width === 390,
        isMobile: width === 390, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(20000);
    let clock = 0, revision = 1, workspaceFailures = 0, workspaceHold = null, dataCaptures = 0;
    const pager = createRankingPager({ now: () => clock });
    const gates = new Map();
    const failPages = new Map();
    const rawRevisions = new Map();
    const snapshotRevisions = new Map();
    const served = new Set();
    const deferred = () => {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        return { promise, release };
    };
    const event = (type, value = {}) => record.events.push({ time: Date.now(), type, ...value });
    const hold = (key, { capture = false, offset = null } = {}) => {
        assert.equal(gates.has(key), false, `Only one pending gate per ${key}`);
        const gate = { ...deferred(), capture, offset, request: null };
        gates.set(key, gate);
        return gate;
    };
    const workspaces = () => record.responses.filter(response => response.path === '/api/get_weighted_workspace');
    const pages = () => record.responses.filter(response => response.path === '/api/get_ranking_page');
    const latest = () => workspaces().filter(response => response.status === 200).at(-1);
    const createOptions = body => ({ userID: '7', initialMode: body.initialMode ?? 'public', query: body.benchmarkQuery ?? '',
        groupVersions: body.groupVersions ?? false, pinPersonal: body.pinPersonal ?? false, resume: body.rankingResume });
    page.on('pageerror', error => { record.errors.push({ message: error.message, stack: error.stack, time: Date.now() }); });
    page.on('console', message => record.console.push({ type: message.type(), text: message.text(), location: message.location(), time: Date.now() }));
    page.on('requestfailed', request => event('requestfailed', { url: request.url(), failure: request.failure() }));
    await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== app.url) {
            record.blocked.push({ url: url.href, method: request.method(), reason: 'non-loopback' });
            return route.abort('blockedbyclient');
        }
        if (url.pathname.startsWith('/api/')) {
            const body = request.postDataJSON();
            const entry = { number: record.requests.length + 1, path: url.pathname, body, time: Date.now() };
            record.requests.push(entry);
            if (!url.pathname.startsWith('/api/get_') && url.pathname !== '/api/load_benchmarks_and_subcategories') {
                record.blocked.push({ ...entry, reason: 'write-or-non-read-api' });
                return route.fulfill({ status: 451, json: { error: 'rehearsal_write_blocked' } });
            }
            if (url.pathname === '/api/get_weighted_workspace' || url.pathname === '/api/get_ranking_page') {
                let payload, status = 200;
                try {
                    if (url.pathname === '/api/get_weighted_workspace') {
                        if (workspaceHold) { workspaceHold.request = entry; await workspaceHold.promise; }
                        if (workspaceFailures > 0) {
                            workspaceFailures--;
                            throw { status: 503, body: { error: 'synthetic_workspace_failure' } };
                        }
                        const raw = rawFixture(app.state, body, revision);
                        if (!rawRevisions.has(revision)) {
                            rawRevisions.set(revision, { raw, hash: sha256(JSON.stringify(raw)) });
                            await save(join(directory, `raw-R${revision}.json`), raw);
                        }
                        payload = pager.create(raw, createOptions(body));
                        snapshotRevisions.set(payload.rankingPagination.snapshotID, revision);
                    } else {
                        const key = pageKey(body);
                        const gate = gates.get(key);
                        if (gate && (gate.offset === null || gate.offset === body.offset)) {
                            gate.request = entry;
                            if (gate.capture) payload = pager.getPage({ ...body, userID: '7' });
                            await gate.promise;
                            if (gates.get(key) === gate) gates.delete(key);
                        }
                        if (failPages.get(key)) {
                            failPages.set(key, failPages.get(key) - 1);
                            throw { status: 503, body: { error: 'synthetic_page_failure' } };
                        }
                        payload ??= pager.getPage({ ...body, userID: '7' });
                    }
                } catch (error) {
                    if (!error.status || !error.body) throw error;
                    status = error.status; payload = error.body;
                }
                const wire = JSON.stringify(payload);
                record.responses.push({ request: entry.number, path: entry.path, body,
                    revision: entry.path === '/api/get_weighted_workspace' ? revision : snapshotRevisions.get(body.snapshotID),
                    harnessRevision: revision, status, payload: JSON.parse(wire), wireSHA256: sha256(wire), time: Date.now() });
                return route.fulfill({ status, body: wire, contentType: 'application/json', headers: { 'cache-control': 'no-store' } });
            }
            return route.continue();
        }
        const path = url.pathname === '/' ? 'private/home.html' : `public${decodeURIComponent(url.pathname)}`;
        const bytes = before && beforeBytes.has(path) ? beforeBytes.get(path) : sourceBytes.get(path);
        if (bytes) {
            const source = before && beforeBytes.has(path) ? 'before' : 'current';
            const identity = `${path}?${url.search}:${source}`;
            if (!served.has(identity)) {
                served.add(identity);
                record.servedSources.push({ path, query: url.search, source, sha256: sha256(bytes) });
            }
            return route.fulfill({ status: 200, body: bytes, contentType: path.endsWith('.html') ? 'text/html; charset=utf-8'
                : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
        }
        return route.continue();
    });
    const check = async (label, action) => {
        try {
            const detail = await action();
            record.checks.push({ label, passed: true, detail });
        } catch (error) {
            record.checks.push({ label, passed: false, error: error.stack });
            const failurePath = join(directory, `failure-${record.checks.length}.png`);
            try { await page.screenshot({ path: failurePath }); } catch (captureError) { event('screenshot-error', { message: captureError.message }); }
            console.error(JSON.stringify({ ID, finding: label, error: error.message, evidence: directory }));
        }
        await save(join(directory, `checkpoint-${record.checks.length}.json`), record);
        return record.checks.at(-1).passed;
    };
    const snapshot = async label => {
        const data = await page.evaluate(() => ({
            benchmarks: [...document.querySelectorAll('#benchmark-rows .bp-benchmark-row:not(.is-family)')].map(row => ({
                ID: Number(row.dataset.conditionId), name: row.querySelector('.bp-benchmark-name')?.textContent ?? '',
                group: row.closest('#benchmark-low-rows') ? 'lowCoverage' : row.closest('#benchmark-other-rows') ? 'other' : 'primary' })),
            models: [...document.querySelectorAll('#model-rows .bp-model-row')].map(row => ({ key: row.dataset.modelKey,
                name: row.querySelector('.bp-model-name')?.textContent ?? '', score: row.querySelector('.bp-model-score > span')?.textContent ?? '' })),
            families: [...document.querySelectorAll('#benchmark-rows .bp-benchmark-row.is-family')].map(row => ({
                key: row.dataset.familyKey, text: row.textContent,
                members: [...row.querySelectorAll('.bp-fallback-step-name')].map(node => ({ key: node.dataset.familyMemberKey, name: node.textContent })) })),
            folds: [...document.querySelectorAll('.bp-benchmark-low-toggle, .bp-benchmark-fallback-toggle')].map(node => ({
                controls: node.getAttribute('aria-controls'), expanded: node.getAttribute('aria-expanded') })),
            scroll: { window: scrollY, benchmark: document.querySelector('#benchmark-rows').scrollTop,
                model: document.querySelector('#model-rows').scrollTop },
            layout: {
                documentHeight: document.documentElement.scrollHeight,
                notice: { hidden: document.querySelector('#model-ranking-status').hidden,
                    phase: document.querySelector('#model-ranking-status').dataset.phase,
                    motion: document.querySelector('#model-ranking-status').dataset.motion,
                    height: getComputedStyle(document.querySelector('.bp-model-viewport')).getPropertyValue('--ranking-notice-height') },
                lists: ['#benchmark-rows', '#model-rows'].map(selector => {
                    const list = document.querySelector(selector);
                    const bounds = list.getBoundingClientRect();
                    const visible = [...list.querySelectorAll('.bp-benchmark-row, .bp-model-row')].filter(row => {
                        const rect = row.getBoundingClientRect();
                        return rect.height > 0 && rect.bottom > Math.max(110, bounds.top) && rect.top < Math.min(innerHeight, bounds.bottom);
                    });
                    return { selector, top: bounds.top, bottom: bounds.bottom, height: bounds.height,
                        clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
                        firstVisible: visible.slice(0, 2).map(row => ({ key: row.dataset.modelKey ?? row.dataset.familyKey ?? row.dataset.conditionId,
                            top: row.getBoundingClientRect().top, bottom: row.getBoundingClientRect().bottom })) };
                })
            },
            busy: document.querySelector('#benchmark-card').getAttribute('aria-busy'),
            search: document.querySelector('#benchmark-search').value,
            grouping: Boolean(document.querySelector('#benchmark-search').value.trim()),
            mode: document.querySelector('#pie-mode-personal').getAttribute('aria-selected') === 'true' ? 'personal' : 'public',
            overflow: document.documentElement.scrollWidth - innerWidth,
            errors: [...document.querySelectorAll('.bp-error-state')].map(node => node.textContent)
        }));
        await save(join(directory, `${label}-dom.json`), data);
        await page.screenshot({ path: join(directory, `${label}.png`) });
        return data;
    };
    const waitRows = async (kind, count) => {
        await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected,
            { selector: rows[kind], expected: count });
    };
    const mix = async () => { if (width === 390) await page.locator('button[data-mobile-panel="mix"]').dispatchEvent('click'); };
    const models = async () => { if (width === 390) await page.locator('button[data-mobile-panel="models"]').dispatchEvent('click'); };
    const benchmarkNext = async (group = 'primary') => { await mix(); await page.locator(benchmarkMore(group)).dispatchEvent('click'); };
    const modelNext = async () => {
        await models();
        const requestCount = record.requests.filter(item => item.path === '/api/get_ranking_page' && ['public', 'personal'].includes(item.body.list)).length;
        if (width === 390) await page.locator('#model-rows .bp-ranking-page-footer').scrollIntoViewIfNeeded();
        else await page.locator('#model-rows').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await until(() => record.requests.filter(item => item.path === '/api/get_ranking_page' && ['public', 'personal'].includes(item.body.list)).length > requestCount, 'rendered model scroll starts a page');
    };
    const fallbackNext = async () => { await mix(); await page.locator(fallbackMore).dispatchEvent('click'); };
    const clearScroll = async () => {
        await page.evaluate(() => { document.querySelector('#benchmark-rows').scrollTop = 0; document.querySelector('#model-rows').scrollTop = 0; scrollTo(0, 0); });
    };
    const stable = async () => {
        await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
            && !document.querySelector('#benchmark-rows .bp-loading-state'));
        await page.evaluate(() => document.fonts.ready);
        await delay(200);
    };
    const settleNotice = async () => {
        await page.waitForFunction(() => {
            const notice = document.querySelector('#model-ranking-status');
            return notice.hidden && notice.dataset.motion === 'closed';
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const assertData = async (payload, mode = 'public', extraBenchmarks = [], extraModels = [], extraFallbacks = []) => {
        const data = await snapshot(`data-${++dataCaptures}`);
        const benchmarks = [...payload.benchmarks, ...extraBenchmarks];
        const modelItems = [...payload.modelLeaderboards[mode], ...extraModels];
        const fallbackItems = [...(payload.rankingPagination.fallbacks?.flatMap(item => item.items) ?? []), ...extraFallbacks];
        assert.equal(new Set(data.benchmarks.map(item => item.ID)).size, data.benchmarks.length, 'No duplicate ordinary benchmark rows');
        assert.equal(new Set(data.models.map(item => item.key)).size, data.models.length, 'No duplicate model rows');
        assert.equal(new Set(data.families.map(item => item.key)).size, data.families.length, 'No duplicate family rows');
        assert.deepEqual(data.benchmarks.map(item => [item.ID, item.name]).sort((a, b) => a[0] - b[0]),
            benchmarks.map(item => [item.ID, item.name]).sort((a, b) => a[0] - b[0]), 'Every benchmark identity/name must match the actual paged raw revision');
        assert.deepEqual(data.models.map(item => [item.name, item.score]), modelItems.map(item => [item.name, item.lower.toFixed(2)]),
            'Every model name/score must match the actual paged raw revision in ranking order');
        assert.deepEqual(data.models.map(item => item.key), modelItems.map(item => item.comparisonIdentity ?? JSON.stringify([item.modelID,
            item.condition?.scoreFields ?? item.condition?.parameters ?? {}])), 'Every model identity matches the actual returned prefix');
        assert.deepEqual(data.families.map(item => item.key).sort(), fallbackItems.map(item => item.familyKey).sort(), 'All family identities come from the same paged raw revision');
        const expectedTag = benchmarks[0]?.name.match(/\[R\d+\]/)?.[0];
        for (const item of data.families) {
            const source = fallbackItems.find(value => value.familyKey === item.key);
            assert.ok(item.text.includes(expectedTag), 'Family member names use the current raw revision');
            assert.deepEqual(item.members.map(member => member.name), source.familyEntries.map(member => member.name),
                'Every fallback member name matches its current raw fixture revision');
        }
        assert.ok(data.overflow <= 1, 'No horizontal document overflow');
        return { benchmarkRows: data.benchmarks.length, modelRows: data.models.length, familyRows: data.families.length, revision: expectedTag };
    };
    const evict = () => {
        const source = rawRevisions.get(revision).raw;
        const peers = Array.from({ length: 12 }, (_, index) => pager.create(structuredClone(source), { userID: `synthetic-peer-${index}` }).rankingPagination.snapshotID);
        event('eviction', { peerCount: peers.length, peerSnapshots: peers, rawHash: rawRevisions.get(revision).hash });
    };
    const advanceRevision = () => { revision++; event('raw-revision', { revision }); };
    const expandFallback = async (count = 10) => {
        await mix(); await page.locator(fallbackToggle).dispatchEvent('click');
        await waitRows('fallbacks', 5);
        if (count === 10) { await fallbackNext(); await waitRows('fallbacks', 10); }
    };
    const loadPrefixes = async ({ personal = false, fallback = true } = {}) => {
        await benchmarkNext(); await waitRows('benchmarks', 80);
        await modelNext(); await waitRows('models', 50);
        if (personal) {
            // Mobile mode changes can already put the newly rendered first page at the scroll boundary.
            const personalGate = hold('personal', { offset: 25 });
            await page.locator('#pie-mode-personal').dispatchEvent('click');
            await waitRows('models', 25);
            const automatic = Boolean(personalGate.request);
            if (!personalGate.request) await modelNext();
            await until(() => personalGate.request, 'personal continuation held at offset 25');
            event('personal-continuation', { automatic, request: personalGate.request.number });
            personalGate.release(); await waitRows('models', 50);
            await page.locator('#pie-mode-public').dispatchEvent('click'); await waitRows('models', 50);
        }
        if (fallback) await expandFallback();
        await clearScroll();
    };
    try {
        await page.goto(app.url, { waitUntil: 'domcontentloaded' });
        await stable(); await waitRows('benchmarks', 40); await waitRows('models', 25);
        const initial = latest().payload;
        await check('ordinary initial prefix is 40 benchmarks / 25 models / fallback page 5', async () => {
            assert.equal(initial.userID, '7');
            assert.equal(initial.benchmarks.length, 40);
            assert.equal(initial.modelLeaderboards.public.length, 25);
            assert.equal(initial.modelLeaderboards.personal.length, 0);
            assert.equal(record.requests.filter(item => item.path === '/api/get_ranking_page').length, 0);
            return assertData(initial);
        });
        if (before) {
            assert.ok(beforeBytes.has('public/js/home-workspace.js'), 'Installed before source must exist for the control');
            await loadPrefixes({ fallback: false });
            const gate = hold('benchmarks:primary');
            await benchmarkNext(); await until(() => gate.request, 'before next benchmark page held');
            await clearScroll(); evict(); advanceRevision();
            const count = workspaces().length;
            gate.release();
            await until(() => workspaces().length > count, 'before expired snapshot refresh');
            await stable(); await waitRows('benchmarks', 40);
            await check('installed frontend control loses loaded 80-row progress after eviction', async () => {
                assert.equal(pages().at(-1).status, 410);
                assert.equal(latest().body.rankingResume, undefined);
                assert.equal(latest().payload.benchmarks.length, 40);
                assert.equal(latest().payload.modelLeaderboards.public.length, 25);
                assert.equal(workspaces().length, count + 1);
                const detail = await assertData(latest().payload);
                return { beforeRows: 80, afterRows: 40, ...detail };
            });
        } else if (name === 'eviction-retry') {
            await loadPrefixes({ personal: true });
            const benchmark = hold('benchmarks:primary'), model = hold('public'), fallback = hold('fallbacks:1');
            await modelNext(); await until(() => model.request, 'model continuation in flight');
            await benchmarkNext(); await until(() => benchmark.request, 'benchmark continuation in flight');
            await fallbackNext(); await until(() => fallback.request, 'fallback continuation in flight');
            await clearScroll();
            const beforeData = await snapshot('before-eviction');
            const workspaceCount = workspaces().length;
            workspaceFailures = 2;
            evict(); advanceRevision();
            benchmark.release(); model.release(); fallback.release();
            await until(() => workspaces().length === workspaceCount + 3 && latest().revision === revision, 'one recovery with two automatic retries');
            await stable(); await waitRows('benchmarks', 120); await waitRows('models', 66); await waitRows('fallbacks', 15);
            await check('simultaneous real model/benchmark/fallback 410 dedupes into one recovery plus two retries', async () => {
                const failed = pages().filter(item => item.body.snapshotID === initial.rankingPagination.snapshotID && item.status === 410);
                assert.deepEqual(failed.map(item => pageKey(item.body)).sort(), ['benchmarks:primary', 'fallbacks:1', 'public']);
                const recovery = workspaces().slice(workspaceCount);
                assert.deepEqual(recovery.map(item => item.status), [503, 503, 200]);
                const resume = { benchmarks: { primary: 120, other: 0, lowCoverage: 0 }, personal: 50, public: 75,
                    fallbacks: [{ conditionID: 1, depth: 15 }] };
                for (const response of recovery) assert.deepEqual(response.body.rankingResume, resume);
                assert.notEqual(latest().payload.rankingPagination.snapshotID, initial.rankingPagination.snapshotID);
                assert.equal(beforeData.benchmarks.length, 80);
                assert.equal(beforeData.models.length, 50);
                assert.equal(beforeData.families.length, 10);
                return assertData(latest().payload);
            });
            await check('inactive personal prefix is restored from the new raw revision', async () => {
                await page.locator('#pie-mode-personal').dispatchEvent('click'); await waitRows('models', 50);
                const payload = latest().payload;
                const detail = await assertData(payload, 'personal');
                await modelNext(); await waitRows('models', 66);
                const response = pages().at(-1);
                assert.equal(response.body.list, 'personal'); assert.equal(response.body.offset, 50);
                assert.equal(response.body.snapshotID, payload.rankingPagination.snapshotID);
                await assertData(payload, 'personal', [], response.payload.items);
                await page.locator('#pie-mode-public').dispatchEvent('click'); await waitRows('models', 66);
                return detail;
            });
            const nextBenchmark = hold('benchmarks:primary'), nextFallback = hold('fallbacks:1');
            await benchmarkNext(); await until(() => nextBenchmark.request, 'second benchmark continuation');
            await fallbackNext(); await until(() => nextFallback.request, 'second fallback continuation');
            await clearScroll();
            const previousSnapshot = latest().payload.rankingPagination.snapshotID;
            const count = workspaces().length;
            evict(); advanceRevision(); nextBenchmark.release(); nextFallback.release();
            await until(() => workspaces().length === count + 1 && latest().revision === revision, 'second eviction recovery');
            await stable(); await waitRows('benchmarks', 160); await waitRows('fallbacks', 20);
            await check('a second eviction advances rather than repeating the recovered prefix', async () => {
                assert.notEqual(latest().payload.rankingPagination.snapshotID, previousSnapshot);
                assert.deepEqual(latest().body.rankingResume, { benchmarks: { primary: 160, other: 0, lowCoverage: 0 },
                    personal: 66, public: 66, fallbacks: [{ conditionID: 1, depth: 20 }] });
                assert.equal(pages().filter(item => item.body.snapshotID === previousSnapshot && item.status === 410).length, 2);
                return assertData(latest().payload);
            });
        } else if (name === 'expiry-search-folds') {
            await mix();
            await page.locator('#benchmark-search').fill('Suite');
            await until(() => pages().some(item => item.body.query === 'Suite' && item.status === 200), 'searched first page');
            await waitRows('benchmarks', 40);
            await benchmarkNext(); await waitRows('benchmarks', 80);
            await page.locator('.bp-benchmark-low-toggle[aria-controls="benchmark-other-rows"]').dispatchEvent('click');
            await waitRows('benchmarks', 120);
            await page.locator('.bp-benchmark-low-toggle[aria-controls="benchmark-low-rows"]').dispatchEvent('click');
            await waitRows('benchmarks', 160);
            await modelNext(); await waitRows('models', 50);
            await expandFallback();
            await settleNotice();
            const gate = hold('benchmarks:other');
            await benchmarkNext('other'); await until(() => gate.request, 'searched other continuation');
            await page.evaluate(widthValue => {
                document.querySelector('#benchmark-rows').scrollTop = widthValue === 1440 ? 420 : 0;
                document.querySelector('#model-rows').scrollTop = widthValue === 1440 ? 260 : 0;
                scrollTo(0, widthValue === 390 ? 1100 : 0);
            }, width);
            await delay(100);
            const anchor = await snapshot('before-expiry-anchor');
            const count = workspaces().length;
            workspaceHold = deferred();
            clock += 15 * 60 * 1000 + 1; event('expiry', { now: clock }); advanceRevision(); gate.release();
            await until(() => workspaceHold.request, 'TTL recovery workspace response held');
            await page.waitForFunction(() => document.querySelector('#model-ranking-status').dataset.motion === 'open');
            await check('same-scope recovery retains benchmark rows and disclosure geometry while loading', async () => {
                const pending = await snapshot('expiry-recovery-loading');
                assert.deepEqual(pending.benchmarks, anchor.benchmarks);
                assert.deepEqual(pending.families, anchor.families);
                assert.deepEqual(pending.folds, anchor.folds);
                assert.equal(pending.scroll.benchmark, anchor.scroll.benchmark);
                assert.equal(pending.layout.lists[0].scrollHeight, anchor.layout.lists[0].scrollHeight);
                if (width === 390) assert.ok(Math.abs(pending.scroll.window - anchor.scroll.window) <= 2,
                    `Pending hidden model notice moved benchmark document scroll ${anchor.scroll.window} -> ${pending.scroll.window}`);
                for (const [listIndex, list] of pending.layout.lists.entries()) {
                    if (list.clientHeight <= 0) continue;
                    assert.deepEqual(list.firstVisible.map(item => item.key), anchor.layout.lists[listIndex].firstVisible.map(item => item.key));
                    for (const [rowIndex, row] of list.firstVisible.entries()) {
                        assert.ok(Math.abs(row.top - anchor.layout.lists[listIndex].firstVisible[rowIndex].top) <= 2,
                            'Visible benchmark and model rows stay anchored during pending recovery');
                    }
                }
                return { before: anchor.scroll, pending: pending.scroll, notice: pending.layout.notice };
            });
            workspaceHold.release(); workspaceHold = null;
            await until(() => workspaces().length === count + 1 && latest().revision === revision, 'TTL recovery');
            await stable(); await waitRows('benchmarks', 168); await waitRows('models', 50); await waitRows('fallbacks', 10);
            const ready = await snapshot('expiry-recovery-ready-motion');
            if (width === 390) await check('a hidden mobile model notice cannot move the active benchmark scroll anchor', async () => {
                assert.equal(ready.layout.lists[1].clientHeight, 0, 'Model panel is hidden while the benchmark panel is active');
                assert.ok(Math.abs(ready.scroll.window - anchor.scroll.window) <= 2,
                    `Hidden model notice moved benchmark document scroll ${anchor.scroll.window} -> ${ready.scroll.window}`);
                assert.deepEqual(ready.layout.lists[0].firstVisible.map(item => item.key), anchor.layout.lists[0].firstVisible.map(item => item.key));
                for (const [index, item] of ready.layout.lists[0].firstVisible.entries()) {
                    assert.ok(Math.abs(item.top - anchor.layout.lists[0].firstVisible[index].top) <= 2, 'Visible benchmark row coordinates stay anchored');
                }
                return { before: anchor.scroll, ready: ready.scroll, notice: ready.layout.notice };
            });
            else await check('ready/open notice preserves visible desktop row coordinates', async () => {
                for (const [listIndex, list] of ready.layout.lists.entries()) {
                    assert.deepEqual(list.firstVisible.map(item => item.key), anchor.layout.lists[listIndex].firstVisible.map(item => item.key));
                    for (const [rowIndex, row] of list.firstVisible.entries()) {
                        assert.ok(Math.abs(row.top - anchor.layout.lists[listIndex].firstVisible[rowIndex].top) <= 2,
                            'Visible benchmark and model rows stay anchored during the ready/open notice');
                    }
                }
                return { before: anchor.scroll, ready: ready.scroll, notice: ready.layout.notice };
            });
            await page.waitForFunction(() => {
                const notice = document.querySelector('#model-ranking-status');
                const height = parseFloat(getComputedStyle(document.querySelector('.bp-model-viewport')).getPropertyValue('--ranking-notice-height'));
                return notice.dataset.motion === 'closing' && height >= 10 && height <= 30;
            });
            const closing = await snapshot('expiry-recovery-closing');
            await check('visible list anchors also survive the closing recovery notice', async () => {
                if (width === 390) assert.ok(Math.abs(closing.scroll.window - anchor.scroll.window) <= 2,
                    `Closing hidden model notice moved benchmark document scroll ${anchor.scroll.window} -> ${closing.scroll.window}`);
                for (const [listIndex, list] of closing.layout.lists.entries()) {
                    if (list.clientHeight <= 0) continue;
                    assert.deepEqual(list.firstVisible.map(item => item.key), anchor.layout.lists[listIndex].firstVisible.map(item => item.key));
                    for (const [rowIndex, row] of list.firstVisible.entries()) {
                        assert.ok(Math.abs(row.top - anchor.layout.lists[listIndex].firstVisible[rowIndex].top) <= 2,
                            'Visible benchmark and model rows stay anchored while the recovery notice closes');
                    }
                }
                return { before: anchor.scroll, closing: closing.scroll, notice: closing.layout.notice };
            });
            await settleNotice();
            await check('searched/grouped TTL recovery preserves each frontier and one new-generation dataset', async () => {
                assert.equal(pages().at(-1).status, 410);
                assert.equal(latest().body.benchmarkQuery, 'Suite'); assert.equal(latest().body.groupVersions ?? false, false);
                assert.deepEqual(latest().body.rankingResume, { benchmarks: { primary: 80, other: 80, lowCoverage: 40 },
                    personal: 0, public: 50, fallbacks: [{ conditionID: 1, depth: 10 }] });
                assert.deepEqual(groups.map(group => latest().payload.rankingPagination.benchmarks[group].nextOffset), [80, 48, 40]);
                return assertData(latest().payload);
            });
            await check('searched/grouped disclosure and actual scroll anchors survive recovery', async () => {
                const restored = await snapshot('after-expiry-anchor');
                assert.deepEqual(restored.folds, anchor.folds, 'Open nested version groups and fallback catalogue stay open');
                assert.equal(restored.search, anchor.search); assert.equal(restored.grouping, anchor.grouping);
                if (width === 1440) {
                    assert.ok(anchor.scroll.benchmark > 0 && anchor.scroll.model > 0, 'Desktop anchor must be nonzero');
                    assert.ok(Math.abs(restored.scroll.benchmark - anchor.scroll.benchmark) <= 2,
                        `Benchmark scroll changed ${anchor.scroll.benchmark} -> ${restored.scroll.benchmark}`);
                    assert.ok(Math.abs(restored.scroll.model - anchor.scroll.model) <= 2,
                        `Model scroll changed ${anchor.scroll.model} -> ${restored.scroll.model}`);
                } else {
                    assert.ok(anchor.scroll.window >= 1000, 'Mobile document anchor must be nonzero');
                    assert.ok(Math.abs(restored.scroll.window - anchor.scroll.window) <= 2,
                        `Mobile scroll changed ${anchor.scroll.window} -> ${restored.scroll.window}`);
                }
                return { before: anchor.scroll, after: restored.scroll, folds: restored.folds };
            });
            await check('searched lower-coverage continuation still extends without duplicates', async () => {
                const payload = latest().payload;
                await benchmarkNext('lowCoverage'); await waitRows('benchmarks', 176);
                const response = pages().at(-1);
                assert.equal(response.status, 200); assert.equal(response.body.offset, 40);
                assert.equal(response.body.query, 'Suite'); assert.equal(response.body.group, 'lowCoverage');
                assert.equal(response.body.snapshotID, payload.rankingPagination.snapshotID);
                return assertData(payload, 'public', response.payload.items);
            });
        } else if (name === 'stale-refresh') {
            await loadPrefixes();
            const benchmark = hold('benchmarks:primary', { capture: true }), model = hold('public', { capture: true }),
                fallback = hold('fallbacks:1', { capture: true });
            await modelNext(); await until(() => model.request, 'old model page captured');
            await benchmarkNext(); await until(() => benchmark.request, 'old benchmark page captured');
            await fallbackNext(); await until(() => fallback.request, 'old fallback page captured');
            await clearScroll();
            workspaceHold = deferred(); advanceRevision();
            const count = workspaces().length;
            await page.locator('#workspace-refresh').dispatchEvent('click');
            await until(() => workspaceHold.request, 'newer full refresh started');
            const pending = await snapshot('newer-refresh-pending');
            benchmark.release(); model.release(); fallback.release();
            await until(() => pages().filter(item => [benchmark.request.number, model.request.number, fallback.request.number].includes(item.request)).length === 3,
                'old successful pages delivered before newer full response');
            await delay(250);
            await check('successful stale pages cannot append before a newer full refresh responds', async () => {
                const after = await snapshot('stale-delivered-before-refresh');
                assert.deepEqual(after.benchmarks, pending.benchmarks);
                assert.deepEqual(after.models, pending.models);
                assert.deepEqual(after.families, pending.families);
                assert.equal(after.models.length, 50);
                assert.equal(workspaces().length, count);
                return { staleResponses: 3, pendingModelRows: 50, pendingBenchmarkRows: after.benchmarks.length };
            });
            workspaceHold.release(); workspaceHold = null;
            await until(() => workspaces().length === count + 1, 'newer workspace response');
            await stable(); await waitRows('benchmarks', 40); await waitRows('models', 25); await waitRows('fallbacks', 5);
            await clearScroll();
            await check('newer ordinary refresh is all current data, never old-page mixtures', async () => {
                assert.equal(latest().body.rankingResume, undefined, 'Explicit ordinary refresh does not send recovery resume');
                const fallbackResponse = pages().filter(item => item.body.snapshotID === latest().payload.rankingPagination.snapshotID
                    && item.body.list === 'fallbacks').at(-1);
                assert.equal(fallbackResponse.status, 200); assert.equal(fallbackResponse.body.offset, 0);
                return assertData(latest().payload, 'public', [], [], fallbackResponse.payload.items);
            });
            const base = latest().payload;
            const extra = { benchmarks: [], public: [], fallbacks: [...pages().filter(item => item.body.snapshotID === base.rankingPagination.snapshotID
                && item.body.list === 'fallbacks').at(-1).payload.items] };
            for (const kind of ['public', 'benchmarks:primary', 'fallbacks:1']) {
                await check(`${kind} transient page failure and explicit retry advance once`, async () => {
                    failPages.set(kind, 1);
                    const failureGate = hold(kind);
                    const beforeCount = pages().length;
                    const action = kind === 'public' ? modelNext : kind === 'benchmarks:primary' ? benchmarkNext : fallbackNext;
                    await action(); await until(() => failureGate.request, `${kind} failing response held`);
                    // Leave the auto-load boundary while the request is pending, before measuring Retry.
                    await clearScroll(); await delay(100); failureGate.release();
                    await until(() => pages().length === beforeCount + 1, `${kind} 503 response`);
                    assert.equal(pages().at(-1).status, 503);
                    await delay(100);
                    await assertData(base, 'public', extra.benchmarks, extra.public, extra.fallbacks);
                    const retry = kind === 'public' ? '#model-rows .bp-ranking-page-footer button'
                        : kind === 'benchmarks:primary' ? benchmarkMore('primary') : fallbackMore;
                    const retryGate = hold(kind, { offset: kind === 'public' ? 25 : kind === 'benchmarks:primary' ? 40 : 5 });
                    if (kind === 'public') {
                        const geometry = await page.locator(retry).evaluate(button => {
                            button.scrollIntoView({ block: 'end', behavior: 'instant' });
                            const bounds = button.getBoundingClientRect();
                            const viewport = document.querySelector('#model-rows').getBoundingClientRect();
                            const detail = { top: bounds.top, bottom: bounds.bottom, height: bounds.height,
                                listTop: viewport.top, listBottom: viewport.bottom, window: scrollY,
                                modelScroll: document.querySelector('#model-rows').scrollTop, viewportHeight: innerHeight };
                            button.click();
                            return detail;
                        });
                        event('rendered-model-retry-click', geometry);
                        assert.ok(geometry.height > 0 && geometry.top >= Math.max(0, geometry.listTop)
                            && geometry.bottom <= Math.min(geometry.viewportHeight, geometry.listBottom) + 1, 'Retry is visible at the model paging boundary');
                    } else await page.locator(retry).dispatchEvent('click');
                    await until(() => retryGate.request, `${kind} retry request held`);
                    await clearScroll(); await delay(100); retryGate.release();
                    await until(() => pages().length === beforeCount + 2, `${kind} retry response`);
                    const response = pages().at(-1);
                    assert.equal(response.status, 200); assert.equal(response.body.snapshotID, base.rankingPagination.snapshotID);
                    assert.equal(response.body.offset, kind === 'public' ? 25 : kind === 'benchmarks:primary' ? 40 : 5);
                    extra[kind === 'public' ? 'public' : kind === 'benchmarks:primary' ? 'benchmarks' : 'fallbacks'].push(...response.payload.items);
                    await waitRows(kind === 'public' ? 'models' : kind === 'benchmarks:primary' ? 'benchmarks' : 'fallbacks',
                        kind === 'public' ? 50 : kind === 'benchmarks:primary' ? 80 : 10);
                    assert.equal(workspaces().length, count + 1, 'Page retries do not issue full workspace refreshes');
                    return assertData(base, 'public', extra.benchmarks, extra.public, extra.fallbacks);
                });
            }
        }
    } catch (error) {
        record.fatal = error.stack;
        console.error(JSON.stringify({ ID, fatal: error.message, evidence: directory }));
    } finally {
        for (const gate of gates.values()) gate.release();
        workspaceHold?.release();
        await check('all pageerrors and boundary violations are failures, without filtering', async () => {
            assert.deepEqual(record.errors, []); assert.deepEqual(record.blocked, []);
            assert.equal(app.state.requests.some(request => !request.path.startsWith('/api/get_')
                && request.path !== '/api/load_benchmarks_and_subcategories'), false);
            assert.ok(record.servedSources.some(source => source.path === 'public/js/home-workspace.js'
                && source.source === (before ? 'before' : 'current')), 'Browser loaded the intended source bytes');
            assert.ok(record.requests.filter(request => request.path === '/api/get_weighted_workspace').every(request => !request.body.previewPersonalPie),
                'No drafts are previewed or saved');
        });
        try { await snapshot('final'); } catch (error) { event('final-capture-error', { message: error.stack }); }
        record.rawRevisions = [...rawRevisions].map(([value, item]) => ({ revision: value, sha256: item.hash }));
        record.previewRequests = app.state.requests;
        record.passed = !record.fatal && record.checks.every(item => item.passed);
        await context.tracing.stop({ path: join(directory, 'trace.zip') });
        await context.close(); await app.close();
        await save(join(directory, 'result.json'), record);
        await appendFile(join(output, 'results.ndjson'), JSON.stringify({ ID, passed: record.passed,
            failed: record.checks.filter(item => !item.passed).map(item => item.label), fatal: record.fatal, evidence: directory }) + '\n');
        console.log(JSON.stringify({ ID, passed: record.passed, checks: record.checks.length, errors: record.errors.length, evidence: directory }));
    }
}

console.log(JSON.stringify({ output, command: manifest.command }));
for (const engine of engines) {
    let browser;
    try {
        browser = await ({ chromium, webkit }[engine]).launch({ headless: true, env: environment });
        for (const width of widths) {
            for (let repetition = 1; repetition <= repetitions; repetition++) {
                await rehearse(browser, engine, width, repetition, 'lost-progress-control', true);
                for (const scenario of scenarios) await rehearse(browser, engine, width, repetition, scenario);
            }
        }
    } catch (error) {
        results.push({ engine, passed: false, fatal: error.stack });
        console.error(JSON.stringify({ engine, error: error.stack, output }));
    } finally { await browser?.close(); }
}
const sourceDrift = [];
for (const [path, bytes] of sourceBytes) {
    const current = await readFile(join(root, path));
    if (sha256(current) !== sha256(bytes)) sourceDrift.push({ path, servedHash: sha256(bytes), currentHash: sha256(current) });
}
const report = { ...manifest, passed: results.filter(item => item.passed).length, total: results.length, sourceDrift,
    results: results.map(({ responses, console: logs, ...item }) => ({ ...item, responseCount: responses?.length, consoleCount: logs?.length })) };
report.matrix = [];
for (const engine of engines) for (const width of widths) {
    for (const scenario of ['lost-progress-control', ...scenarios]) {
        const cases = results.filter(item => item.engine === engine && item.width === width && item.name === scenario);
        report.matrix.push({ engine, viewport: `${width}x960`, scenario, repetitions: cases.length,
            passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length,
            errors: cases.reduce((total, item) => total + item.errors.length, 0),
            failedChecks: cases.reduce((total, item) => total + item.checks.filter(check => !check.passed).length, 0),
            fatals: cases.filter(item => item.fatal).length, caseIDs: cases.map(item => item.ID), sourceSetID: manifest.sourceSetID });
    }
}
report.deploymentGate = { eligible: manifest.completeMatrix && report.passed === report.total && sourceDrift.length === 0,
    completeMatrix: manifest.completeMatrix, allScenariosPassed: report.passed === report.total, noSourceDrift: sourceDrift.length === 0 };
await save(join(output, 'summary.json'), report);
await save(join(output, 'brief.md'), '# Local Paging Progress Browser Rehearsal\n\n'
    + `Command: \`${manifest.command.join(' ')}\`\n\n`
    + `Result: ${report.passed}/${report.total} scenarios passed. Source drift during run: ${sourceDrift.length}.\n\n`
    + 'Each case preserves result.json, full request/response bodies, raw revision fixtures, DOM identities, screenshots, and trace.zip. '
    + 'Failed checks and checkpoints are retained. Current frontend bytes are frozen at invocation and archived under sources/current.\n\n'
    + results.filter(item => !item.passed).map(item => `- ${item.ID ?? item.engine}: ${item.fatal ?? item.checks.filter(check => !check.passed).map(check => check.label).join('; ')}\n`).join('')
    + '\nCoverage limits:\n' + manifest.limits.map(limit => `- ${limit}\n`).join(''));
console.log(JSON.stringify({ passed: report.passed, total: report.total, sourceDrift, output }));
if (report.passed !== report.total) process.exitCode = 1;
