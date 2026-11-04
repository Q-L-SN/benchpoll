import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import express from 'express';
import session from 'express-session';
import { privacyHeaders, PRIVACY_CONTENT_SECURITY_POLICY } from '../privacy-headers.js';
import { assertCategoryName, categoryPathParts, RESERVED_CATEGORY_PATHS } from '../public/js/shared/category-route.js';
import { contributionRoute } from '../public/js/shared/contribution-navigation.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const source = await read('server.js');
const documents = [
    { path: '/cookies', file: 'cookies.html', title: 'Cookie &amp; Local Storage Policy' },
    { path: '/community-guidelines', file: 'community-guidelines.html', title: 'Contribution &amp; Community Rules' }
];
const html = Object.fromEntries(await Promise.all(documents.map(async document => [document.path, await read('private/' + document.file)])));
const links = { '/terms': 'Terms', '/privacy': 'Privacy', '/cookies': 'Cookies', '/community-guidelines': 'Community' };

function registration(marker, end = '\n});') {
    const from = source.indexOf(marker);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Actual server registration: ${marker}`);
    return source.slice(from, to + end.length);
}

async function fixture() {
    const app = express();
    const page = express.Router();
    const API = express.Router();
    const store = new session.MemoryStore();
    let writes = 0;
    const originalSet = store.set.bind(store);
    store.set = (...args) => { writes++; originalSet(...args); };
    app.use(privacyHeaders);
    app.use(express.static(join(root, 'public')));
    // Execute the production session registration without loading dotenv, the database or mail worker.
    runInNewContext(registration('app.use(session({', '\n}));'), {
        app, session, sessionStore: store, sessionSecret: 'isolated-legal-fixture', sessionMaxAgeMs: 7 * 86400000
    });
    runInNewContext(registration('page.use((_req, res, next) => {'), { page });
    const fixturePage = { get(path, handler) { page.get(path, (req, res) => {
        const sendFile = res.sendFile.bind(res);
        res.sendFile = file => sendFile(file, { dotfiles: 'allow' });
        handler(req, res);
    }); } };
    for (const document of documents) runInNewContext(registration(`page.get('${document.path}',`), {
        page: fixturePage, currentDir: root.replace(/[\\/]$/, '')
    });
    runInNewContext(registration("API.get('/privacy_information',"), {
        API, privacyOperator: { displayName: 'BenchPoll operator', contactPath: '/account/privacy#request' },
        LEGAL_VERSIONS: { terms: 'fixture', privacy: 'fixture' }
    });
    app.use('/api', API);
    app.get('/fixture-session', (req, res) => { req.session.fixture = true; res.json({ ok: true }); });
    app.get('/dialogPage', (_req, res) => res.sendFile(join(root, 'private/dialogPage.html')));
    app.use(page);
    app.use((_req, res) => res.status(404).send('category-catch-all-fixture'));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        writes: () => writes,
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    };
}

test('new policy routes use production handlers, preserve CSP and create no anonymous session', async () => {
    const site = await fixture();
    try {
        for (const document of documents) {
            assert.ok(source.indexOf(`page.get('${document.path}',`) < source.indexOf("page.get('/*any_path'"));
            assert.doesNotMatch(registration(`page.get('${document.path}',`), /req\.session|requireAuth|db\.|ensurePrivacyCSRF/);
            for (const path of [document.path, document.path.toUpperCase(), document.path + '/']) {
                const response = await fetch(site.origin + path);
                assert.equal(response.status, 200, path);
                assert.equal(response.headers.get('cache-control'), 'no-store');
                assert.equal(response.headers.get('content-security-policy'), PRIVACY_CONTENT_SECURITY_POLICY);
                assert.equal(response.headers.get('set-cookie'), null);
                assert.equal(await response.text(), html[document.path]);
            }
        }
        assert.equal(site.writes(), 0);
        const information = await fetch(site.origin + '/api/privacy_information');
        assert.equal(information.status, 200);
        assert.equal(information.headers.get('cache-control'), 'no-store');
        assert.equal(information.headers.get('set-cookie'), null);
        assert.equal(site.writes(), 0);
        const seeded = await fetch(site.origin + '/fixture-session');
        assert.match(seeded.headers.get('set-cookie'), /^sid=.*HttpOnly; SameSite=Lax/);
        assert.equal(site.writes(), 1, 'The same real middleware persists requested session features');
    } finally { await site.close(); }
});

test('new policy names are reserved across case, Unicode and separator variants', () => {
    for (const document of documents) {
        const name = document.path.slice(1);
        assert.ok(RESERVED_CATEGORY_PATHS.includes(name));
        for (const variant of [name, name.toUpperCase(), ` ${name} `, name.replaceAll('-', '_'), name.replaceAll('-', ' '),
            name.replace(/[a-z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 0xfee0))]) {
            assert.throws(() => assertCategoryName(variant), TypeError, variant);
            assert.throws(() => categoryPathParts('/' + encodeURIComponent(variant)), TypeError, variant);
        }
    }
    assert.equal(assertCategoryName('Cookie Evaluation'), 'Cookie Evaluation');
});

test('new documents reuse legal navigation with valid focus targets and no operator profile', async () => {
    const script = await read('public/js/legal.js');
    const requests = [...script.matchAll(/fetch\('([^']+)'/g)].map(match => match[1]);
    assert.deepEqual(requests, ['/api/privacy_information']);
    assert.match(source, /API\.get\('\/privacy_information'/);
    for (const document of documents) {
        const text = html[document.path];
        assert.match(text, /<html lang="en">/);
        assert.ok(text.includes(`<h1>${document.title}</h1>`));
        assert.match(text, /<time datetime="2026-10-28">October 28, 2026<\/time>/);
        assert.match(text, /href="\/css\/legal\.css\?/);
        assert.deepEqual([...text.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => match[1]), ['/js/legal.js?v=shared-controls-20261010']);
        assert.doesNotMatch(text, /<script(?![^>]*src=)|on(?:click|load)=|data-operator-name|data-privacy-email|Q-L-SN|github\.com\/Q-L-SN|mailto:/i);
        for (const target of text.matchAll(/href="#([^"#]+)"/g)) {
            assert.match(text, new RegExp(`(?:header|section)[^>]*id="${target[1]}"[^>]*tabindex="-1"`));
        }
        for (const ID of ['taxonomy-toggle', 'taxonomy-close', 'taxonomy-scrim', 'legal-sections']) assert.ok(text.includes(`id="${ID}"`));
        assert.match(text, /aria-expanded="false" aria-controls="legal-sections"/);
        assert.match(text, /href="\/account\/privacy#request"/);
    }
});

test('all owned entry-page legal links include short Terms, Privacy, Cookies and Community labels', async () => {
    for (const file of ['home.html', 'contribute.html', 'how-it-works.html', 'dialogPage.html', 'account-privacy.html',
        ...documents.map(document => document.file)]) {
        const text = await read('private/' + file);
        if (file === 'dialogPage.html') {
            assert.match(text, /<global-header><\/global-header>/);
            const shared = await read('public/js/shared/site-header.js');
            for (const path of Object.keys(links)) assert.ok(shared.includes(`href="${path}"`), `${file}: ${path}`);
            continue;
        }
        const navs = [...text.matchAll(/<nav[^>]*aria-label="Legal (?:and social links|documents)"[^>]*>([\s\S]*?)<\/nav>/g)];
        assert.ok(navs.length, file);
        for (const nav of navs) for (const [path, label] of Object.entries(links)) {
            assert.ok(nav[1].includes(`href="${path}"`), `${file}: ${path}`);
            assert.match(nav[1], new RegExp(`href="${path}"[^>]*>${label}<`));
        }
    }
});

test('the four published documents link each other without modifying the other policy owners', async () => {
    for (const file of ['terms.html', 'privacy.html', ...documents.map(document => document.file)]) {
        const text = await read('private/' + file);
        for (const path of Object.keys(links)) assert.ok(text.includes(`href="${path}"`), `${file}: ${path}`);
    }
});

test('cookie notice reflects the configurable session and real storage cleanup boundaries', async () => {
    const text = html['/cookies'];
    assert.match(source, /sessionMaxAgeMs = requiredPositiveEnvironmentNumber\('SESSION_MAX_AGE_DAYS'\) \* 24 \* 60 \* 60 \* 1000/);
    assert.match(source, /name: 'sid'/);
    assert.match(source, /saveUninitialized: false/);
    assert.match(source, /maxAge: sessionMaxAgeMs/);
    assert.match(source, /httpOnly: true,[\s\S]*?sameSite: 'lax',[\s\S]*?secure: 'auto'/);
    assert.match(source, /req\.session\.githubOAuth = \{ state, redirectURI, createdAt: Date\.now\(\), legalChoice \}/);
    assert.match(source, /delete req\.session\.githubOAuth/);
    assert.match(source, /oauthAge > 10 \* 60 \* 1000/);
    for (const value of ['sid', 'SESSION_MAX_AGE_DAYS', 'SameSite=Lax', 'HTTP-only', 'ten minutes',
        'no application-set automatic expiry', '30-minute validity period', 'not by a continuously running deletion timer',
        'no separate 30-minute timer', 'Logout clears', 'does not run a blanket', 'Cookie-only deletion',
        'history or cache alone', 'browser restore', 'does not delete saved weights']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(text, /expires after seven days|always deleted after 30 minutes|closing the browser deletes all/i);
    const representatives = [
        ['public/js/workspace/guest-drafts.js', 'benchpoll:guest-pie:v3:'],
        ['public/js/workspace/pie-recovery.js', 'benchpoll:owned-pie:v1:'],
        ['public/js/workspace/preferences.js', 'benchpoll-workspace-preferences-v1'],
        ['public/js/workspace/preferences.js', 'benchpoll-workspace-display-v1'],
        ['public/js/navigation/preferences.js', 'benchpoll-sidebar-preferences-v1'],
        ['public/js/workspace/comparison-settings.js', 'benchpoll-comparison-settings-v1:'],
        ['public/js/workspace/comparison-profiles.js', 'benchpoll-comparison-profiles-v2:'],
        ['public/js/home-welcome.js', 'benchpoll-welcome-seen-v1'],
        ['public/js/shared/sign-in.js', 'user-profile-update'],
        ['public/js/shared/write-intent.js', 'benchpoll:unconfirmed-write:'],
        ['public/js/shared/contribution-navigation.js', 'benchpoll:contribution-entry:']
    ];
    for (const [path, key] of representatives) {
        assert.ok((await read(path)).includes(key), path);
        assert.ok(text.includes(key), key);
    }
    const handoff = await read('public/js/shared/contribution-navigation.js');
    const build = handoff.slice(handoff.indexOf('export function buildContributionURL'), handoff.indexOf('export function activateContributionURL'));
    assert.doesNotMatch(build, /setItem|localStorage|sessionStorage/);
    assert.match(handoff, /const lifetime = 30 \* 60 \* 1000/);
    assert.match(handoff, /expiresAt <= now\) storage\.removeItem/);
    assert.match(handoff, /sessionStorage\.setItem\(entryPrefix \+ token/);
});

test('current policy pages add no tracking or acceptance banner and accurately limit CSP claims', async () => {
    for (const text of Object.values(html)) {
        assert.doesNotMatch(text, /<iframe|<form|googletagmanager|google-analytics|src="https?:|id="cookie-(?:banner|consent)|data-cookie-consent/i);
    }
    const text = html['/cookies'];
    for (const phrase of ['Non-essential tracking is not enabled by default', 'no "accept all cookies" banner',
        'not consent to future tracking', 'security logs', 'same-origin scripts and requests remain permitted',
        'HTTPS images', 'disabled by default', 'configured at domain level', 'not marketing consent']) assert.ok(text.includes(phrase), phrase);
    assert.ok(PRIVACY_CONTENT_SECURITY_POLICY.includes("connect-src 'self'"));
    assert.ok(PRIVACY_CONTENT_SECURITY_POLICY.includes("img-src 'self' data: https:"));
    assert.doesNotMatch(PRIVACY_CONTENT_SECURITY_POLICY, /static\.cloudflareinsights\.com|cloudflareinsights\.com/);
});

test('community policy links real forms and covers evidence, synced versions, private rights and moderation', async () => {
    const text = html['/community-guidelines'];
    const paths = [...text.matchAll(/href="(\/contribute[^"#]*)"/g)].map(match => match[1]);
    for (const path of paths) {
        assert.ok(path === '/contribute' || contributionRoute(path), path);
    }
    assert.match(source, /page\.get\(\['\/contribute', '\/contribute\/\{\*formPath\}'\]/);
    for (const phrase of ['same task context', "users' saved personal pies in public categories", 'Private categories do not contribute',
        'not public discussion material or used for research', 'operate, support and secure the service',
        'reasoning effort', 'harness version', 'Do not guess missing settings',
        'vendor-reported result', 'Check for duplicates', 'dated source snapshot', 'manual new-score submissions are disabled',
        'source mapping', 'Request bulk import', 'plain-text feedback form', 'at least 16', 'verified email',
        'Email verification checks access to that address', 'third-party license', 'copyright', 'trademarks', 'private reports remain within the review process',
        'harassment', 'privacy violations', 'spam votes', 'misleading vendor claims', 'evidence-backed criticism',
        'Submitted items enter the review queue', 'decision you question', 'operator reviews the request',
        'follow-up messages and any deletion are handled manually', 'Delivery can be delayed or fail']) assert.ok(text.includes(phrase), phrase);
    assert.doesNotMatch(text, /DMCA agent|mailto:|guaranteed email|all submissions are public|private reports are published/i);
});

test('browser: both policies at 1440, 390 and 320, mobile section navigation and no storage writes', {
    skip: process.env.BENCHPOLL_LEGAL_BROWSER !== '1', timeout: 120000
}, async () => {
    const { chromium } = await import('playwright');
    const site = await fixture();
    const browser = await chromium.launch({ headless: true });
    const evidence = join(tmpdir(), 'benchpoll-cookie-community-20261018');
    await mkdir(evidence, { recursive: true });
    try {
        for (const width of [1440, 390, 320]) for (const document of documents) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            const errors = [], requests = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('request', request => requests.push(new URL(request.url()).pathname));
            await context.route('**/*', route => new URL(route.request().url()).origin === site.origin ? route.continue() : route.abort());
            await context.addInitScript(() => {
                window.policyWrites = [];
                const setItem = Storage.prototype.setItem;
                Storage.prototype.setItem = function (...args) { window.policyWrites.push(args[0]); return setItem.apply(this, args); };
            });
            const response = await page.goto(site.origin + document.path);
            assert.equal(response.status(), 200);
            await page.evaluate(() => document.fonts.ready);
            await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('/api/privacy_information')));
            await page.screenshot({ path: join(evidence, `${document.file.replace('.html', '')}-${width}.png`), fullPage: true });
            await page.screenshot({ path: join(evidence, `${document.file.replace('.html', '')}-${width}-viewport.png`), fullPage: false });
            const dimensions = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
                main: document.querySelector('main').scrollWidth, mainClient: document.querySelector('main').clientWidth,
                navs: [...document.querySelectorAll('nav[aria-label="Legal documents"], .bp-sidebar-footer nav')]
                    .filter(nav => nav.getClientRects().length).map(nav => ({ scroll: nav.scrollWidth, client: nav.clientWidth })) }));
            assert.ok(dimensions.document <= dimensions.width, JSON.stringify(dimensions));
            assert.ok(dimensions.main <= dimensions.mainClient, JSON.stringify(dimensions));
            for (const nav of dimensions.navs) assert.ok(nav.scroll <= nav.client, JSON.stringify(nav));
            if (width < 760) {
                await page.locator('#taxonomy-toggle').click();
                assert.equal(await page.locator('#taxonomy-toggle').getAttribute('aria-expanded'), 'true');
                await page.screenshot({ path: join(evidence, `${document.file.replace('.html', '')}-${width}-navigation.png`), fullPage: false });
                const footer = page.locator('.bp-sidebar-footer');
                const bounds = await footer.boundingBox();
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
                const last = page.locator('[data-legal-link]').last();
                const target = (await last.getAttribute('href')).slice(1);
                await last.click();
                assert.equal(await page.locator('#taxonomy-toggle').getAttribute('aria-expanded'), 'false');
                assert.equal(await page.evaluate(() => document.activeElement.id), target);
                assert.equal(new URL(page.url()).hash, '#' + target);
            }
            assert.deepEqual(await context.cookies(), []);
            assert.deepEqual(await page.evaluate(() => window.policyWrites), []);
            assert.deepEqual(errors, []);
            assert.ok(requests.includes('/api/privacy_information'));
            assert.equal(site.writes(), 0);
            await context.close();
        }
        for (const width of [1440, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            await context.route('**/*', route => new URL(route.request().url()).origin === site.origin ? route.continue() : route.abort());
            await page.goto(site.origin + '/dialogPage');
            await page.waitForFunction(() => customElements.get('global-header'));
            const bounds = await page.locator('nav[aria-label="Legal documents"]').boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 62,
                'The notice-page legal links stay within the existing header: ' + JSON.stringify(bounds));
            const brand = await page.locator('global-header img.brand').boundingBox();
            assert.ok(brand.x >= 0 && brand.x + brand.width < bounds.x, 'Legal links must not push or cover the existing brand');
            await page.screenshot({ path: join(evidence, `dialog-legal-links-${width}.png`), fullPage: false });
            await context.close();
        }
        console.log('Legal policy screenshots: ' + evidence);
    } finally { await browser.close(); await site.close(); }
});
