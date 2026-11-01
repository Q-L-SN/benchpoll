import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspaceChannel, workspaceChannel } from '../public/js/shared/workspace-channel.js';
import { navigationChannel } from '../public/js/shared/navigation-channel.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const motionVersion = 'comparison-experiment-20261007';
const motionURL = new URL('../public/js/shared/motion.js', import.meta.url);
const sourceFiles = [
    'AGENTS.md', 'package.json', 'package-lock.json', 'private/home.html',
    'public/js/shared/motion.js', 'public/js/shared/workspace-channel.js',
    'public/js/shared/navigation-channel.js', 'public/js/home.js', 'public/js/home-workspace.js',
    'public/js/navigation/sidebar.js', 'public/js/workspace/comparison-controls.js',
    'public/js/workspace/family-view.js', 'public/js/workspace/model-scores.js',
    'public/js/workspace/benchmark-fallback-catalogue.js', 'public/js/workspace/style-previews.js',
    'public/js/workspace/comparison-profile-menu.js', 'public/js/workspace/benchmark-scores.js',
    'public/js/discussion.js', 'test/content-motion.test.mjs', 'test/frontend-modules.test.mjs',
    'scripts/frontend/ui-routing-20261001.mjs', 'scripts/frontend/fixtures.mjs',
    'public/js/shared/http.js', 'public/js/shared/mobile-panels.js', 'public/js/shared/taxonomy-drawer.js',
    'scripts/review-coordination-20261008.mjs', 'test/review-coordination-20261008.test.mjs'
];

const callerTargets = {
    versionedMotion: [
        { file: 'public/js/home-workspace.js', lines: [1102, 1103], targets: ['.bp-left-workspace', '#right-workspace'] },
        { file: 'public/js/home-workspace.js', lines: [1257, 1278, 1294, 1302], targets: ['#inline-fallback', '#inline-fallback-settings'] },
        { file: 'public/js/home-workspace.js', lines: [1360], targets: ['#inline-fallback-chart .bp-family-chain (personal-only)'] },
        { file: 'public/js/home-workspace.js', lines: [1818, 1821], targets: ['benchmark other/low rows owned by renderBenchmarks'] },
        { file: 'public/js/home-workspace.js', lines: [1847, 2009, 2024, 2610], targets: ['workspace headline', '#weight-pie', '#agi-promo', '#public-composition-pie'] }
    ],
    bareMotion: [
        { file: 'public/js/navigation/sidebar.js', lines: [93, 236, 336, 341, 356], targets: ['#configured-search-wrap', '#configured-panel', '#tree-content', '#topic-create-form'] },
        { file: 'public/js/workspace/comparison-controls.js', lines: [39, 128, 255, 309, 334, 339, 347, 438, 596, 657], targets: ['#model-comparison-panel', '#model-comparison-keys', 'private filter rows/controls/search results'] },
        { file: 'public/js/workspace/comparison-profile-menu.js', lines: [41, 73, 118, 128], targets: ['private popover/editor'] },
        { file: 'public/js/workspace/family-view.js', lines: [186, 216], targets: ['.bp-family-expanded-chain', '.bp-family-other-list (public-only descendants, not the personal .bp-family-chain)'] },
        { file: 'public/js/workspace/benchmark-fallback-catalogue.js', lines: [54, 105, 111], targets: ['#benchmark-fallback-configs-${conditionID} (descendant of benchmark rows)'] },
        { file: 'public/js/workspace/style-previews.js', lines: [80, 88, 99], targets: ['#workspace-style-menu', '[data-style-kind] groups'] },
        { file: 'public/js/workspace/model-scores.js', lines: [87, 323, 402, 462, 487], targets: ['model-score dialog list/disclosures/fallback chains'] },
        { file: 'public/js/workspace/benchmark-scores.js', lines: [86, 111], targets: ['benchmark-score view/list in discussion'] },
        { file: 'public/js/discussion.js', lines: [46, 68, 410], targets: ['#benchmark-discussion-view', '#discussion-compose-fields', 'discussion feed'] }
    ],
    channels: [
        { file: 'public/js/home-workspace.js', line: 2852, channel: 'workspaceChannel', async: true, listener: 'applyWorkspaceState (2504)' },
        { file: 'public/js/navigation/sidebar.js', line: 299, channel: 'navigationChannel', async: false, listener: 'snapshot -> current/confirmed/render; refresh is void' },
        { file: 'public/js/home.js', line: 63, channel: 'navigationChannel', async: false, listener: 'update lastWorkspaceURL' }
    ]
};

export function parseReviewArgs(args) {
    let run, expectFixed = false;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--run' && run === undefined) run = args[++index];
        else if (args[index] === '--expect-fixed' && !expectFixed) expectFixed = true;
        else throw new Error('Use --run <fresh-evidence-label> [--expect-fixed]');
    }
    assert.equal(typeof run, 'string', 'A fresh --run label is required');
    assert.match(run, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
    return { run, expectFixed };
}

export function inspectVisibilityFixes(source) {
    const lines = source.split(/\r?\n/);
    const find = text => lines.findIndex(line => line.includes(text)) + 1;
    return {
        compositionFixed: /if \(state\.mode === 'public' && state\.publicCompositionVisible\) \{\s*void setVisible\(inlineFallback, false, \{ collapse: true \}\)/.test(source),
        agiDesiredGuard: /if \(agiPromo\.getAttribute\('aria-hidden'\) !== String\(!showAGI\)\) void setVisible\(agiPromo, showAGI/.test(source),
        locations: { composition: find('void setVisible(inlineFallback, false'),
            agi: find("agiPromo.getAttribute('aria-hidden')"),
            applyWorkspaceState: find('async function applyWorkspaceState'),
            workspaceSubscriber: find('workspaceChannel.subscribe') }
    };
}

export function visibilityMatches(state, visible) {
    return state.hidden === !visible && state.inert === !visible && state.ariaHidden === String(!visible);
}

export function inspectResidualFixes(sidebar, profileMenu) {
    const location = (source, text) => source.split(/\r?\n/).findIndex(line => line.includes(text)) + 1;
    const accountChange = sidebar.slice(sidebar.indexOf('function setAccount('), sidebar.indexOf('navigationChannel.subscribe('));
    const formCleanup = accountChange.slice(accountChange.indexOf('if (changed) {'), accountChange.indexOf('++privateValidation;'));
    return {
        privateFormFixed: /const changed = !accountKnown \|\| next !== account/.test(accountChange)
            && /if \(changed\) \{/.test(formCleanup)
            && /createForm\.reset\(\)/.test(formCleanup)
            && /void setVisible\(createForm, false, \{ collapse: true \}\)/.test(formCleanup)
            && /createButtons\.forEach\(button => button\.setAttribute\('aria-expanded', 'false'\)\)/.test(formCleanup),
        profileEditorFixed: /if \(!open\) \{\s*editing = null;\s*void setVisible\(editor, false, \{ collapse: true \}\);\s*status\.textContent = ''/.test(profileMenu),
        locations: { guestCleanup: location(sidebar, 'createForm.reset()'),
            editorClose: location(profileMenu, 'if (!open) { editing = null; void setVisible(editor') }
    };
}

export function motionCallerImports(sources) {
    const imports = {};
    for (const [file, source] of Object.entries(sources)) {
        const specifier = source.match(/import\s*\{[^}]*\}\s*from\s*['"]([^'"]*\/motion\.js(?:\?[^'"]*)?)['"]/)?.[1];
        if (!specifier) continue;
        const caller = '/' + file.replace(/^public\//, '');
        const url = new URL(specifier, 'http://fixture.invalid' + caller);
        imports[caller] = url.pathname + url.search;
    }
    return imports;
}

export function motionTraceIdentity(stack, imports) {
    const rawMotion = stack?.match(/\/js\/shared\/motion\.js(?:\?[^\s:)]+)?/)?.[0] ?? null;
    const caller = stack?.match(/\/js\/(?!shared\/motion\.js)[^\s:?@)]+\.js/g)?.find(path => imports[path]) ?? null;
    const motion = caller && rawMotion ? imports[caller] : rawMotion;
    return { rawMotion, caller, motion, attribution: caller && rawMotion ? 'actual-caller-import' : 'stack-url' };
}

export function assertResidualFixes({ profileEditor, privateForm }) {
    for (const [name, result, state] of [['profile editor', profileEditor, profileEditor.reopened],
        ['private form', privateForm, privateForm.after]]) {
        assert.equal(result.bug, false, name + ' must not reappear after its old show completes');
        assert.equal(visibilityMatches(state, false), true, name + ' must finish hidden/inert/aria-hidden');
        assert.equal(state.rendered, false, name + ' must not remain rendered');
        assert.ok(result.completion.captured >= 2, name + ' must exercise a pending show and a replacement hide');
        assert.ok(result.completion.cancelled >= 1, name + ' must cancel its old show');
    }
    assert.equal(profileEditor.closed.inert, true);
    assert.equal(profileEditor.closed.ariaHidden, 'true');
    assert.equal(privateForm.cleared.inert, true);
    assert.equal(privateForm.cleared.ariaHidden, 'true');
    assert.equal(privateForm.toggleExpanded, 'false');
    assert.equal(privateForm.createButtonsClosed, true);
    assert.equal(privateForm.guestPromptVisible, true);
}

async function currentCallerTargets() {
    const current = {};
    for (const [group, entries] of Object.entries(callerTargets)) {
        current[group] = [];
        for (const entry of entries) {
            const lines = (await readFile(resolve(root, entry.file), 'utf8')).split(/\r?\n/);
            const { lines: originalLines, line: originalLine, ...metadata } = entry;
            current[group].push({ ...metadata, originalReviewLines: originalLines ?? [originalLine],
                currentCallSites: lines.flatMap((line, index) => /(?:setVisible|animateContent|flipPie|Channel\.subscribe)\(/.test(line)
                    ? [{ line: index + 1, source: line.trim() }] : []),
                sameFamilyDirectWrites: lines.flatMap((line, index) => /(?:editor|createForm|menu)\.hidden\s*=/.test(line)
                    ? [{ line: index + 1, source: line.trim() }] : []) });
        }
    }
    return current;
}

async function preservedFinalEvidence() {
    const hashes = {};
    const visit = async (directory, prefix) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = resolve(directory, entry.name), key = prefix + '/' + entry.name;
            if (entry.isDirectory()) await visit(path, key);
            else hashes[key] = createHash('sha256').update(await readFile(path)).digest('hex');
        }
    };
    for (const run of ['final1', 'final2', 'after1', 'after2']) {
        const directory = resolve(root, 'artifacts/review-20261008/coordination-' + run);
        await visit(directory, run);
    }
    hashes['coordination-summary.md'] = createHash('sha256').update(await readFile(resolve(root,
        'artifacts/review-20261008/coordination-summary.md'))).digest('hex');
    return hashes;
}

function deferred() {
    let resolvePromise, reject;
    const promise = new Promise((resolve, rejectPromise) => { resolvePromise = resolve; reject = rejectPromise; });
    return { promise, resolve: resolvePromise, reject };
}

function motionElement(hidden = false) {
    const calls = [];
    return {
        hidden, inert: false, attrs: {}, calls,
        setAttribute(name, value) { this.attrs[name] = value; },
        getBoundingClientRect() { return { height: this.hidden ? 0 : 100 }; },
        animate() {
            const completion = deferred();
            const animation = {
                finished: completion.promise, cancelled: false,
                cancel() { this.cancelled = true; completion.reject(new Error('fixture animation cancelled')); },
                finish() { completion.resolve(); }
            };
            calls.push(animation);
            return animation;
        }
    };
}

export async function reproduceNodeCoordination() {
    const plain = await import(motionURL.href);
    const versioned = await import(motionURL.href + '?v=' + motionVersion);
    const repeated = await import(motionURL.href + '?v=' + motionVersion);
    const originalWindow = globalThis.window;
    const originalComputed = globalThis.getComputedStyle;
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    globalThis.getComputedStyle = () => ({ opacity: '1' });
    const results = {};
    try {
        const split = motionElement();
        const hide = versioned.setVisible(split, false, { collapse: true });
        await plain.setVisible(split, true, { collapse: true });
        split.calls[0].finish();
        await hide;
        results.splitMotion = { distinct: plain !== versioned, sameURLCached: repeated === versioned,
            animationCount: split.calls.length, hidden: split.hidden, inert: split.inert, ariaHidden: split.attrs['aria-hidden'] };

        const canonical = motionElement();
        const oldHide = versioned.setVisible(canonical, false, { collapse: true });
        const latestShow = versioned.setVisible(canonical, true, { collapse: true });
        canonical.calls[1].finish();
        await Promise.all([oldHide, latestShow]);
        results.canonicalMotion = { animationCount: canonical.calls.length, oldCancelled: canonical.calls[0].cancelled,
            hidden: canonical.hidden, inert: canonical.inert, ariaHidden: canonical.attrs['aria-hidden'] };

        const direct = motionElement(true);
        const oldShow = versioned.setVisible(direct, true, { collapse: true });
        direct.hidden = true;
        direct.calls[0].finish();
        await oldShow;
        results.directHide = { hiddenAfterShowFinishes: direct.hidden };

        const coordinated = motionElement(true);
        const pendingShow = versioned.setVisible(coordinated, true, { collapse: true });
        const latestHide = versioned.setVisible(coordinated, false, { collapse: true });
        coordinated.calls[1].finish();
        await Promise.all([pendingShow, latestHide]);
        results.coordinatedHide = { hidden: coordinated.hidden, inert: coordinated.inert,
            oldCancelled: coordinated.calls[0].cancelled };
    } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
        if (originalComputed === undefined) delete globalThis.getComputedStyle;
        else globalThis.getComputedStyle = originalComputed;
    }

    const channel = createWorkspaceChannel();
    await channel.publish({ context: 'old' });
    const gate = deferred();
    const commits = [];
    let oldComplete = false;
    const stop = channel.subscribe(async snapshot => {
        if (snapshot.context === 'old') { await gate.promise; oldComplete = true; }
        commits.push(snapshot.context);
    });
    await channel.publish({ context: 'new' });
    const afterLivePublish = { commits: [...commits], oldComplete, subscriptionReturnType: typeof stop };
    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    stop();
    results.asyncReplay = { afterLivePublish, finalCommits: [...commits], oldComplete };

    const caught = createWorkspaceChannel();
    caught.subscribe(async () => { throw new Error('fixture live rejection'); });
    let liveRejection = '';
    await caught.publish({ context: 'live' }).catch(error => { liveRejection = error.message; });
    const child = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { createWorkspaceChannel } from ${JSON.stringify(new URL('../public/js/shared/workspace-channel.js', import.meta.url).href)};
        const events = [];
        process.on('unhandledRejection', error => events.push(error.message));
        const channel = createWorkspaceChannel();
        await channel.publish({ context: 'cached' });
        channel.subscribe(async () => { throw new Error('fixture replay rejection'); });
        await new Promise(resolve => setImmediate(resolve));
        console.log(JSON.stringify(events));
    `], { encoding: 'utf8', cwd: root, timeout: 10000 });
    results.rejections = { liveRejection, unhandledReplay: JSON.parse(child.trim()) };
    results.channelIdentity = { workspaceAndNavigationAreSeparate: workspaceChannel !== navigationChannel };
    return results;
}

async function fingerprints() {
    const entries = [];
    for (const path of sourceFiles) {
        const bytes = await readFile(resolve(root, path));
        entries.push([path, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }]);
    }
    return Object.fromEntries(entries);
}

async function readMotionSources() {
    const entries = [];
    for (const file of sourceFiles.filter(file => file.startsWith('public/js/'))) {
        entries.push([file, await readFile(resolve(root, file), 'utf8')]);
    }
    return entries;
}

async function startReadOnlyFixture() {
    const { categories, createFixtureState, workspace, rankingPage, approvedResults } = await import('./frontend/fixtures.mjs');
    const { entryFromContext } = await import('../public/js/navigation/model.js');
    const tree = structuredClone(categories);
    tree.push({ ID: 40, name: 'AGI', path: 'AGI', parentID: null, hasChildren: false });
    const requests = [];
    const state = createFixtureState({ secondaryBenchmark: true, sparseBenchmark: true });
    const flattened = [...tree, ...tree[0].children];
    const publicRoot = resolve(root, 'public');
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const send = (status, value) => {
            response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify(value));
        };
        try {
            if (url.pathname.startsWith('/api/')) {
                let raw = '';
                for await (const part of request) { raw += part; assert.ok(raw.length < 100000); }
                const body = raw ? JSON.parse(raw) : {};
                requests.push({ path: url.pathname, body });
                if (url.pathname.startsWith('/api/get_page')) {
                    const path = url.pathname.slice('/api/get_page'.length).replace(/^\/+|\/+$/g, '');
                    return send(200, { categoryTree: tree, currentCategoryID: flattened.find(item => item.path === path)?.ID ?? 1 });
                }
                switch (url.pathname) {
                case '/api/get_user_profile': return send(state.authenticated ? 200 : 204, { userID: '1', userName: 'Synthetic review fixture' });
                case '/api/get_comparison_profiles': return send(200, { authenticated: true, userID: '1', last: null,
                    profiles: [{ name: 'Synthetic preset', comparison: { mode: 'best', keys: ['model'], filters: [] } }] });
                case '/api/get_personal_navigation': return send(state.authenticated ? 200 : 401, { userID: '1', items: [] });
                case '/api/get_category_navigation': return send(200, { items: flattened.map(item => entryFromContext({
                    categoryID: item.ID, lineage: [{ ID: item.ID, name: item.name }], contextValues: {}
                })) });
                case '/api/get_weighted_workspace': {
                    const payload = workspace(state, body);
                    if (Number(body.categoryID) === 40) Object.assign(payload.context, {
                        categoryID: 40, categoryPath: 'AGI', categoryName: 'AGI', lineage: [{ ID: 40, name: 'AGI' }]
                    });
                    return send(200, payload);
                }
                case '/api/get_ranking_page': return send(200, rankingPage(state, body));
                case '/api/get_approved_benchmark_results': return send(200, approvedResults(body));
                default: return send(403, { error: 'coordination_read_only_fixture_endpoint_blocked' });
                }
            }
            const home = url.pathname === '/' || flattened.some(item => '/' + item.path === url.pathname);
            const file = home ? resolve(root, 'private/home.html') : resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
            if (!home && (!file.startsWith(publicRoot + sep) || url.pathname.split('/').some(part => part.startsWith('.')))) return send(403, {});
            const bytes = await readFile(file);
            response.writeHead(200, { 'content-type': (types[extname(file)] ?? 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
            response.end(bytes);
        } catch (error) { send(error.code === 'ENOENT' ? 404 : 500, { error: error.message }); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, requests,
        syntheticGuestRead() { state.authenticated = false; },
        close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

function browserInstrumentation(imports) {
    const original = Element.prototype.animate;
    const identities = new WeakMap();
    let nextID = 0;
    window.__coordination = { trace: [], navigation: [], hold: new Set(), held: [], synthetic: false };
    localStorage.setItem('benchpoll-comparison-settings-v1:1', JSON.stringify({ experimental: true,
        basic: { mode: 'best', keys: ['model'], filters: [] } }));
    Element.prototype.animate = function (frames, timing) {
        const animation = original.call(this, frames, timing);
        if (!identities.has(this)) identities.set(this, ++nextID);
        const stack = new Error().stack;
        const identity = window.__motionTraceIdentity(stack, imports);
        const record = { identity: identities.get(this), id: this.id, classes: this.className?.baseVal ?? this.className,
            tag: this.tagName, ...identity, stack, synthetic: window.__coordination.synthetic, frames, timing };
        window.__coordination.trace.push(record);
        if ([...window.__coordination.hold].some(target => target === this.id || target.startsWith('.') && this.matches(target))) {
            animation.pause();
            window.__coordination.held.push({ element: this, animation, finished: animation.finished });
        }
        return animation;
    };
}

async function ready(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('.bp-model-row').length > 0);
}

async function settle(page) {
    await page.evaluate(async () => {
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
}

async function navigateFixtureCategory(page, ID, pathname) {
    const mobile = page.viewportSize().width < 760;
    const beforeDrawer = await page.locator('body').getAttribute('class');
    if (mobile) {
        // taxonomy-open remains set during the exit animation; it does not mean the drawer is usable.
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-closing'));
        if (!await page.locator('body').evaluate(element => element.classList.contains('taxonomy-open'))) {
            await page.locator('#taxonomy-toggle').click();
            await page.locator('.bp-sidebar').evaluate(async element => {
                await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
            });
        }
    }
    await page.evaluate(({ ID, pathname, beforeDrawer }) => window.__coordination.navigation.push({
        ID, pathname, beforeDrawer, clickDrawer: document.body.className
    }), { ID, pathname, beforeDrawer });
    const response = page.waitForResponse(item => item.url().endsWith('/api/get_weighted_workspace')
        && Number(item.request().postDataJSON()?.categoryID) === ID && item.status() === 200);
    await Promise.all([response, page.locator(`#tree-content [data-category-id="${ID}"]`).click()]);
    await page.waitForFunction(path => location.pathname === path
        && document.querySelector('#benchmark-card').getAttribute('aria-busy') === 'false', pathname);
}

async function browserIdentity(page) {
    return page.evaluate(async version => {
        window.__coordination.synthetic = true;
        try {
            const plain = await import('/js/shared/motion.js');
            const versioned = await import('/js/shared/motion.js?v=' + version);
            const repeated = await import('/js/shared/motion.js?v=' + version);
            const element = document.createElement('div');
            element.style.height = '100px'; document.body.append(element);
            const hide = versioned.setVisible(element, false, { collapse: true });
            const animation = element.getAnimations()[0]; animation.pause();
            await plain.setVisible(element, true, { collapse: true });
            const count = element.getAnimations().length;
            animation.finish(); await hide;
            const collision = { hidden: element.hidden, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden'), count };
            element.remove();
            return { distinct: plain !== versioned, sameURLCached: repeated === versioned, collision,
                resources: performance.getEntriesByType('resource').map(item => item.name).filter(url => /\/motion\.js(?:\?|$)/.test(url)) };
        } finally { window.__coordination.synthetic = false; }
    }, motionVersion);
}

async function hold(page, target) {
    return page.evaluate(target => {
        window.__coordination.hold.add(target);
        return window.__coordination.held.length;
    }, target);
}

async function finishHeld(page, target, start, reverse = false) {
    return page.evaluate(async ({ target, start, reverse }) => {
        window.__coordination.hold.delete(target);
        const entries = window.__coordination.held.slice(start).filter(item => item.element.id === target
            || target.startsWith('.') && item.element.matches(target));
        if (reverse) entries.reverse();
        const active = entries.filter(item => ['paused', 'running'].includes(item.animation.playState));
        for (const item of active) item.animation.finish();
        await Promise.all(entries.map(item => item.finished.catch(() => {})));
        // Repeated completion must not change the final visibility or revive a cancelled animation.
        for (const item of active) item.animation.finish();
        await Promise.resolve();
        return { captured: entries.length, cancelled: entries.length - active.length, repeatedCompletions: active.length };
    }, { target, start, reverse });
}

async function visibleState(page, selector) {
    return page.locator(selector).evaluate(element => ({
        hidden: element.hidden, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden'),
        rendered: element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none'
    }));
}

async function compositionState(page) {
    const fallback = await visibleState(page, '#inline-fallback');
    return { ...fallback, ...await page.evaluate(() => ({
        expanded: document.querySelector('#public-composition-toggle').getAttribute('aria-expanded'),
        svgHidden: document.querySelector('#public-composition-pie').hasAttribute('hidden')
    })) };
}

async function clickHandler(page, selector) {
    await page.locator(selector).evaluate(element => element.click());
}

async function primaryControls(page, output, expectFixed) {
    const composition = [], agi = [], style = [];
    for (let cycle = 0; cycle < 3; cycle++) {
        if (await page.locator('#public-composition-toggle').getAttribute('aria-expanded') === 'false') {
            await clickHandler(page, '#public-composition-toggle');
        }
        await settle(page);
        const start = await hold(page, 'inline-fallback');
        await clickHandler(page, '#public-composition-toggle');
        await clickHandler(page, '#public-composition-toggle');
        const pending = await compositionState(page);
        const completion = await finishHeld(page, 'inline-fallback', start, cycle % 2 === 1);
        const after = await compositionState(page);
        assert.equal(after.expanded, 'true');
        assert.equal(after.svgHidden, false);
        if (expectFixed) assert.equal(visibilityMatches(after, false), true, 'composition must keep the fallback hidden/inert');
        composition.push({ cycle, pending, completion, after, oldBugReproduced: !after.hidden });
        if (cycle === 0) {
            await writeFile(resolve(output, 'primary-first.json'), JSON.stringify({ composition: composition[0] }, null, 2), { flag: 'wx' });
            await settle(page);
            await page.screenshot({ path: resolve(output, 'composition.png'), fullPage: true });
        }
        await clickHandler(page, '#public-composition-toggle');
        await settle(page);
        const rapidStart = await hold(page, 'inline-fallback');
        for (let step = 0; step < 4; step++) await clickHandler(page, '#public-composition-toggle');
        const rapidCompletion = await finishHeld(page, 'inline-fallback', rapidStart, cycle % 2 === 0);
        const rapidAfter = await compositionState(page);
        assert.equal(rapidAfter.expanded, 'false');
        assert.equal(visibilityMatches(rapidAfter, true), true, 'rapid reverse must end in accessible weights/fallback');
        composition.at(-1).rapidReverse = { completion: rapidCompletion, after: rapidAfter };
        await settle(page);
    }
    await navigateFixtureCategory(page, 40, '/AGI');
    await settle(page);
    for (let cycle = 0; cycle < 3; cycle++) {
        const start = await hold(page, 'agi-promo');
        await navigateFixtureCategory(page, 1, '/Language-models');
        const away = await visibleState(page, '#agi-promo');
        const awayAnimations = await page.evaluate(start => window.__coordination.held.slice(start)
            .filter(item => item.element.id === 'agi-promo').length, start);
        if (expectFixed) assert.equal(awayAnimations, 1, 'same desired hide must not restart on response render');
        await navigateFixtureCategory(page, 40, '/AGI');
        const returned = await visibleState(page, '#agi-promo');
        const totalAnimations = await page.evaluate(start => window.__coordination.held.slice(start)
            .filter(item => item.element.id === 'agi-promo').length, start);
        if (expectFixed) assert.equal(totalAnimations, 2, 'return needs one show, not a restart per render');
        const completion = await finishHeld(page, 'agi-promo', start, cycle % 2 === 1);
        const after = await visibleState(page, '#agi-promo');
        if (expectFixed) assert.equal(visibilityMatches(after, true), true, 'return to AGI must cancel the stale hide');
        agi.push({ cycle, away, returned, awayAnimations, totalAnimations, completion, after, oldBugReproduced: after.hidden });
        await settle(page);
        if (cycle === 0) await page.screenshot({ path: resolve(output, 'agi.png'), fullPage: true });
        await navigateFixtureCategory(page, 1, '/Language-models');
        await settle(page);
        assert.equal(visibilityMatches(await visibleState(page, '#agi-promo'), false), true);
        await navigateFixtureCategory(page, 40, '/AGI');
        await settle(page);
        assert.equal(visibilityMatches(await visibleState(page, '#agi-promo'), true), true);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
        const start = await hold(page, 'workspace-style-menu');
        for (let step = 0; step < 3; step++) await clickHandler(page, '#workspace-style-toggle');
        const completion = await finishHeld(page, 'workspace-style-menu', start, cycle % 2 === 1);
        const after = await visibleState(page, '#workspace-style-menu');
        assert.equal(visibilityMatches(after, true), true, 'style menu measurement writes must not defeat final show');
        style.push({ cycle, completion, after });
        await clickHandler(page, '#workspace-style-toggle');
        await settle(page);
    }
    return { composition, agi, style };
}

async function profileEditorCollision(page, output, mobile) {
    if (mobile) { await clickHandler(page, '[data-mobile-panel="models"]'); await settle(page); }
    await clickHandler(page, '#model-comparison-toggle');
    await settle(page);
    await clickHandler(page, '.bp-profile-toggle');
    await settle(page);
    const start = await hold(page, '.bp-comparison-profile-editor');
    await clickHandler(page, '.bp-profile-action[aria-label="Rename Synthetic preset"]'); // Opens only; never confirms a rename.
    await clickHandler(page, '#model-comparison-close');
    const closed = await visibleState(page, '.bp-comparison-profile-editor');
    const completion = await finishHeld(page, '.bp-comparison-profile-editor', start);
    await settle(page);
    await clickHandler(page, '#model-comparison-toggle');
    await settle(page);
    await clickHandler(page, '.bp-profile-toggle');
    await settle(page);
    const reopened = await visibleState(page, '.bp-comparison-profile-editor');
    const bug = !reopened.hidden && reopened.rendered;
    await page.screenshot({ path: resolve(output, 'profile-editor.png'), fullPage: true });
    await page.locator('.bp-comparison-profile-editor').getByRole('button', { name: 'Cancel', exact: true, includeHidden: true }).evaluate(element => element.click());
    await settle(page);
    await clickHandler(page, '#model-comparison-close');
    if (mobile) await clickHandler(page, '[data-mobile-panel="mix"]');
    await settle(page);
    return { target: '.bp-comparison-profile-editor', closed, completion, reopened, bug,
        caller: 'comparison-profile-menu setOpen(false) vs showEditor; Rename UI opener only, no confirm/save/delete or write callback' };
}

async function sidebarFormCollision(page, fixture, output, mobile) {
    if (mobile) { await clickHandler(page, '#taxonomy-toggle'); await settle(page); }
    await clickHandler(page, '[data-navigation-view="mine"]');
    await settle(page);
    const start = await hold(page, 'topic-create-form');
    await clickHandler(page, '[data-create-topic="private"]'); // Opens a local form only; never submits it.
    fixture.syntheticGuestRead();
    const profileRead = page.waitForResponse(response => response.url().endsWith('/api/get_user_profile') && response.status() === 204);
    await Promise.all([profileRead, page.evaluate(async () => {
        const { navigationChannel } = await import('/js/shared/navigation-channel.js');
        let snapshot;
        const stop = navigationChannel.subscribe(value => { snapshot = value; });
        stop();
        await navigationChannel.publish({ ...snapshot, userID: null, authenticated: false, hasPersonalWeights: false });
    })]);
    await page.waitForFunction(() => !document.querySelector('#mine-login').hidden
        && !document.querySelector('#login-button').hidden);
    const cleared = await visibleState(page, '#topic-create-form');
    const completion = await finishHeld(page, 'topic-create-form', start);
    await settle(page);
    const after = await visibleState(page, '#topic-create-form');
    const toggleExpanded = await page.locator('[data-create-topic="private"]').getAttribute('aria-expanded');
    const createButtonsClosed = await page.locator('[data-create-topic]').evaluateAll(elements => elements.every(element => element.getAttribute('aria-expanded') === 'false'));
    const guestPromptVisible = await page.locator('#mine-login').isVisible();
    await page.screenshot({ path: resolve(output, 'private-form.png'), fullPage: true });
    if (mobile) { await clickHandler(page, '#taxonomy-close'); await settle(page); }
    return { target: '#topic-create-form', cleared, completion, after, toggleExpanded, createButtonsClosed, guestPromptVisible,
        bug: !after.hidden && after.rendered,
        caller: 'sidebar setAccount(null) vs create toggle; a synthetic read snapshot only, no logout/account/write API' };
}

async function runBrowserCase(output, { launcher, engine, device, viewport, expectFixed }) {
    const fixture = await startReadOnlyFixture();
    let browser;
    try {
        browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { args: ['--disable-background-networking'] } : {}),
            env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    } catch (error) {
        await fixture.close();
        return { engine, device, viewport, status: 'unavailable', error: error.message };
    }
    const mobile = device === 'mobile';
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile,
        reducedMotion: 'no-preference', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const pageErrors = [], externalBlocked = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === fixture.url) return route.continue();
        externalBlocked.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
    });
    const imports = motionCallerImports(Object.fromEntries(await readMotionSources()));
    await context.addInitScript({ content: `window.__motionTraceIdentity = ${motionTraceIdentity.toString()};
        (${browserInstrumentation.toString()})(${JSON.stringify(imports)});` });
    const before = await fingerprints();
    await writeFile(resolve(output, 'source-first.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
    let phase = 'initial-ready';
    try {
        await page.goto(fixture.url);
        await ready(page);
        await settle(page);
        const identity = await browserIdentity(page);
        assert.equal(identity.distinct, true);
        assert.equal(identity.sameURLCached, true);
        assert.deepEqual(identity.collision, { hidden: true, inert: false, ariaHidden: 'false', count: 1 });

        // All interactions below invoke the current application's event handlers.
        phase = 'actual-disjoint-targets';
        if (mobile) { await page.locator('#taxonomy-toggle').click(); await settle(page); }
        await page.locator('#navigation-search-toggle').click();
        await settle(page);
        await page.locator('#navigation-search-close').click();
        await page.locator('[data-navigation-view="configured"]').click();
        await settle(page);
        await page.locator('[data-navigation-view="all"]').click();
        if (mobile) {
            await page.locator('#taxonomy-close').click();
            await page.locator('[data-mobile-panel="models"]').click();
            await settle(page);
        }
        await page.locator('#model-comparison-toggle').click();
        await settle(page);
        await page.locator('#model-comparison-close').click();
        if (mobile) { await page.locator('[data-mobile-panel="mix"]').click(); await settle(page); }
        await page.locator('#public-fallback-toggle').click();
        await settle(page);
        await page.locator('#public-fallback-toggle').click();
        await settle(page);
        const baselineTrace = await page.evaluate(() => window.__coordination.trace.filter(record => !record.synthetic));
        const targets = new Map();
        for (const record of baselineTrace.filter(record => record.motion)) {
            if (!targets.has(record.identity)) targets.set(record.identity, { id: record.id, classes: record.classes, modules: new Set() });
            targets.get(record.identity).modules.add(record.motion);
        }
        const targetAudit = [...targets.values()].map(target => ({ ...target, modules: [...target.modules] }));
        assert.equal(targetAudit.some(target => target.modules.length > 1), false);
        assert.ok(targetAudit.some(target => target.modules.includes('/js/shared/motion.js')));
        const workspaceMotion = imports['/js/home-workspace.js'];
        assert.ok(workspaceMotion, 'The actual workspace motion import must be identified');
        assert.ok(targetAudit.some(target => target.modules.includes(workspaceMotion)));

        phase = 'primary-controls';
        const controls = await primaryControls(page, output, expectFixed);
        console.log(`${engine}/${device}: three primary reversal/completion cycles passed`);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await navigateFixtureCategory(page, 1, '/Language-models');
        await navigateFixtureCategory(page, 40, '/AGI');
        await page.locator('#public-composition-toggle').evaluate(element => element.click());
        await settle(page);
        const reducedMotionControl = await page.evaluate(() => ({
            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
            agiHidden: document.querySelector('#agi-promo').hidden,
            agiInert: document.querySelector('#agi-promo').inert,
            compositionExpanded: document.querySelector('#public-composition-toggle').getAttribute('aria-expanded'),
            fallbackHidden: document.querySelector('#inline-fallback').hidden
        }));
        assert.deepEqual(reducedMotionControl, { reduced: true, agiHidden: false, agiInert: false,
            compositionExpanded: 'true', fallbackHidden: true });
        await clickHandler(page, '#public-composition-toggle');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        phase = 'same-target-profile-editor';
        const profileEditor = await profileEditorCollision(page, output, mobile);
        await writeFile(resolve(output, 'residual-first.json'), JSON.stringify(profileEditor, null, 2), { flag: 'wx' });
        phase = 'same-target-private-form';
        const privateForm = await sidebarFormCollision(page, fixture, output, mobile);
        const remainingSameTarget = { profileEditor, privateForm };
        if (expectFixed) assertResidualFixes(remainingSameTarget);
        const trace = await page.evaluate(() => window.__coordination.trace);
        const navigation = await page.evaluate(() => window.__coordination.navigation);
        const writes = fixture.requests.filter(item => !item.path.startsWith('/api/get_'));
        assert.deepEqual(writes, []);
        assert.deepEqual(pageErrors, []);
        const after = await fingerprints();
        const result = { engine, device, status: 'passed', browser: browser.version(), viewport, expectFixed, identity, targetAudit,
            controls, reducedMotionControl, remainingSameTarget, motionCallerImports: imports, navigation,
            pageErrors, externalBlocked, requests: fixture.requests, trace, before, after,
            changedSources: sourceFiles.filter(path => before[path].sha256 !== after[path].sha256) };
        await writeFile(resolve(output, 'case.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
        return result;
    } catch (error) {
        await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
        const failure = { engine, device, viewport, browser: browser.version(), status: 'failed', phase, error: error.stack, pageErrors,
            requests: fixture.requests, state: await page.evaluate(() => ({ path: location.pathname,
                drawer: document.body.className, navigation: window.__coordination?.navigation,
                fallback: document.querySelector('#inline-fallback')?.hidden,
                trace: window.__coordination?.trace })).catch(() => null), before, after: await fingerprints() };
        await writeFile(resolve(output, 'failure.json'), JSON.stringify(failure, null, 2), { flag: 'wx' });
        return failure;
    } finally {
        await context.close();
        await browser.close();
        await fixture.close();
    }
}

async function runBrowserMatrix(output, expectFixed) {
    const { chromium, webkit } = await import('playwright');
    const results = [];
    for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
        for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
            const directory = resolve(output, engine + '-' + device);
            await mkdir(directory);
            const result = await runBrowserCase(directory, { launcher, engine, device, viewport, expectFixed });
            results.push(result);
            console.log(`${engine}/${device}: ${result.status}`);
        }
    }
    return results;
}

function markdown(report) {
    const matrix = report.browserMatrix.map(item => `| ${item.engine} | ${item.device} | ${item.status} | ${item.browser ?? 'not recorded'} |`).join('\n');
    const residual = report.browserMatrix.filter(item => item.status === 'passed').map(item => ({
        engine: item.engine, device: item.device, profileEditor: item.remainingSameTarget.profileEditor.bug,
        privateForm: item.remainingSameTarget.privateForm.bug
    }));
    return `# Coordination Follow-Up, ${report.run}\n\n`
        + `Mode: ${report.expectFixed ? 'expect-fixed for composition, AGI, profile editor and private create form' : 'diagnostic'}. Commit ${report.environment.commit}; branch ${report.environment.branch}; Node ${report.environment.node}.\n\n`
        + '## Browser Matrix\n\n| Engine | View | Result | Version |\n| --- | --- | --- | --- |\n' + matrix + '\n\n'
        + '- Each available case runs three composition and AGI reversals, four-click rapid composition reversals, repeated completion of active animations, completed forward/reverse controls, three style-menu measurement reversals, and reduced-motion controls. AGI must create exactly one hide and one return show, not restart on each render.\n'
        + `- Source fix anchors: ${JSON.stringify(report.sourceFixes)}.\n`
        + `- Residual fix anchors: ${JSON.stringify(report.residualFixes)}.\n`
        + '- Current call sites are extracted into callerTargets; original review line numbers are labelled as historical rather than silently reused. Query-distinct synthetic same-target failure and channel replay mechanics remain characterization controls, NOT proof of a current cross-instance app failure or async navigation replay consumer.\n\n'
        + '## Same-Target Regression Checks\n\n'
        + `- Observed browser outcomes: ${JSON.stringify(residual)}.\n`
        + '- Profile editor: actual Rename UI opener, then advanced-panel close during held show; complete active replacement hide twice and reopen panel/popover. Expect-fixed requires cancelled old show, hidden/inert/aria-hidden editor and no rendered stale editor. The authorized setOpen(false) fix uses same-module setVisible(editor, false, { collapse: true }). No rename confirmation or write callback is invoked.\n'
        + '- Topic form: actual Mine private-topic create toggle, then synthetic guest READ snapshot/204 through the actual navigation subscriber. Complete active replacement hide twice; expect-fixed requires cancelled old show, hidden/inert/aria-hidden form, both create toggles collapsed and the Mine sign-in prompt visible. Guest creation actions remain sign-in entry points. Account-change cleanup uses same-module setVisible(createForm, false, { collapse: true }). No login/logout, form submit, account API or profile write was invoked.\n'
        + '- Style menu direct hidden writes are temporary measurement in the same caller family followed by setVisible; three rapid reversals exercise cancellation. New per-render family/catalogue/benchmark nodes are not treated as the same WeakMap target just because selectors match. No unrelated hidden assignment is promoted to a finding.\n\n'
        + '## Harness Assumptions\n\n'
        + '- Real current HTML/modules; only Web Animations pause/finish is controlled. Initial native clicks and mobile drawer/panel selection verify real layout paths. Rapid reversals dispatch attached real button handlers to make timing deterministic; they are not a claim about physical pointer hit testing or production frequency.\n'
        + '- Read-only local fixture returns a valid synthetic account/profile and comparison metadata. Primary cases start only after rendered workspace readiness; navigation waits for a matching successful workspace response and render completion, not the home module top-level await. This tolerates parent initialization changes without reviewing profile-read deadlines.\n'
        + '- Original Animation.finished Promises are captured before cancellation. Cancelled idle animations are never revived; repeated finish only applies to the active animation.\n'
        + '- WebKit stack URLs omit module queries: traces preserve rawMotion/stack and attribute a known application caller through its current literal motion import. Browser dynamic imports still independently verify distinct URL identity and performance resources. No stack-only bare URL is treated as proof of a bare-module caller.\n'
        + '- Mobile navigation waits for taxonomy-closing to clear before opening/clicking the drawer; taxonomy-open alone is not usable during exit. Navigation checkpoints retain before/click drawer classes. Matching-response and native-click Promises are awaited together so a timeout cannot escape as an unhandled rejection.\n'
        + '- Parent edits are fingerprinted before/after every case and run. Run-level source drift invalidates an expect-fixed success. No production service, external request, DB pool or account/social action is used. Unavailable engine launch is recorded explicitly, never treated as a passing case.\n'
        + `- Original final1/final2, after1/after2 and coordination-summary.md unchanged: ${report.protectedEvidenceUnchanged}. Changed run sources: ${JSON.stringify(report.changedSources)}.\n\n`
        + '## Commands and Files\n\n'
        + `- node scripts/review-coordination-20261008.mjs --run ${report.run}${report.expectFixed ? ' --expect-fixed' : ''}\n`
        + '- node --test test/review-coordination-20261008.test.mjs test/content-motion.test.mjs test/frontend-modules.test.mjs\n'
        + '- node node_modules/eslint/bin/eslint.js scripts/review-coordination-20261008.mjs test/review-coordination-20261008.test.mjs\n'
        + '- Run files: source-first.json, report.json, report.md. Each engine-view directory has source-first.json, primary-first.json, composition.png, agi.png, profile-editor.png, private-form.png, residual-first.json, case.json. Failures retain failure.png/failure.json; run-failure.json retains incomplete run results. Existing directories/evidence are refused, never overwritten.\n';
}

export async function runReview(run, { expectFixed = false } = {}) {
    assert.match(run, /^[a-zA-Z0-9_-]+$/);
    const base = resolve(root, 'artifacts/review-20261008');
    await mkdir(base, { recursive: true });
    const output = resolve(base, 'coordination-' + run);
    await mkdir(output); // Refuse to replace a prior run, including an incomplete first run.
    const before = await fingerprints();
    await writeFile(resolve(output, 'source-first.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
    const protectedBefore = await preservedFinalEvidence();
    const report = {
        run, expectFixed, startedAt: new Date().toISOString(), environment: {
            node: process.version, platform: process.platform,
            commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
            branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
        }, before, callerTargets: await currentCallerTargets(), protectedBefore,
        sourceFixes: inspectVisibilityFixes(await readFile(resolve(root, 'public/js/home-workspace.js'), 'utf8')),
        residualFixes: inspectResidualFixes(await readFile(resolve(root, 'public/js/navigation/sidebar.js'), 'utf8'),
            await readFile(resolve(root, 'public/js/workspace/comparison-profile-menu.js'), 'utf8'))
    };
    try {
        report.node = await reproduceNodeCoordination();
        if (expectFixed) {
            assert.equal(report.sourceFixes.compositionFixed, true, 'Wait for the composition source edit before --expect-fixed');
            assert.equal(report.sourceFixes.agiDesiredGuard, true, 'Wait for the AGI desired visibility guard before --expect-fixed');
            assert.equal(report.residualFixes.profileEditorFixed, true, 'Profile editor close must cancel its old show');
            assert.equal(report.residualFixes.privateFormFixed, true, 'Guest cleanup must cancel its old form show');
        }
        report.browserMatrix = await runBrowserMatrix(output, expectFixed);
        report.after = await fingerprints();
        report.changedSources = sourceFiles.filter(path => before[path].sha256 !== report.after[path].sha256);
        report.protectedAfter = await preservedFinalEvidence();
        report.protectedEvidenceUnchanged = Object.keys(protectedBefore).every(path => protectedBefore[path] === report.protectedAfter[path]);
        report.finishedAt = new Date().toISOString();
        await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
        await writeFile(resolve(output, 'report.md'), markdown(report), { flag: 'wx' });
        assert.equal(report.protectedEvidenceUnchanged, true, 'Original final/after evidence changed');
        if (expectFixed) assert.deepEqual(report.changedSources, [], 'Source drift during expect-fixed run; preserve this run and repeat with a fresh label');
        assert.equal(report.browserMatrix.some(item => item.status === 'failed'), false, 'Browser checks failed; inspect preserved case evidence');
        if (expectFixed) assert.equal(report.browserMatrix.filter(item => item.status === 'passed').length, 4,
            'Expect-fixed requires all four desktop/mobile Chromium/WebKit cases, not unavailable fallbacks');
        else assert.ok(report.browserMatrix.some(item => item.status === 'passed'), 'No browser case was available');
        console.log(JSON.stringify({ output, status: expectFixed ? 'PASS expected fixes' : 'PASS diagnostic',
            cases: report.browserMatrix.map(item => ({ engine: item.engine, device: item.device, status: item.status,
                residualEditor: item.remainingSameTarget?.profileEditor.bug, residualForm: item.remainingSameTarget?.privateForm.bug })),
            queryDistinctAppCollisionProven: false, asyncReplayAppFailureProven: false,
            changedSources: report.changedSources }, null, 2));
    } catch (error) {
        await writeFile(resolve(output, 'run-failure.json'), JSON.stringify({ ...report, error: error.stack }, null, 2), { flag: 'wx' });
        throw error;
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const { run, expectFixed } = parseReviewArgs(process.argv.slice(2));
    await runReview(run, { expectFixed });
}
