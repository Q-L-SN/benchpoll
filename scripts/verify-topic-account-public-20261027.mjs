import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const origin = 'https://benchpoll.com';
const output = resolve(process.argv[2] || 'D:/Codex-artifacts/website1/sign-in-simplification-20261027/public');
await mkdir(output, { recursive: true });
const results = [];
const mutations = new Set(['propose_topic', 'vote_topic_proposal', 'create_topic', 'save_user_profile',
    'cancel_topic_proposal_support', 'edit_topic_proposal', 'withdraw_topic_proposal',
    'accept_privacy', 'submit_contribution', 'review_moderation_log']);

for (const [launcher, viewport] of [[chromium, { width: 1440, height: 1000 }],
    [chromium, { width: 390, height: 844 }], [webkit, { width: 390, height: 844 }]]) {
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 760,
        reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], violations = [], writes = [];
    const label = `${launcher.name()}-${viewport.width}`;
    page.setDefaultTimeout(35000);
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
        window.accountReleaseViolations = [];
        document.addEventListener('securitypolicyviolation', event => {
            window.accountReleaseViolations.push({ directive: event.effectiveDirective, uri: event.blockedURI });
        });
    });
    await context.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname.split('/').at(-1);
        if (!mutations.has(path)) return route.continue();
        writes.push(path);
        return route.abort();
    });
    async function visit(path) {
        const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
        assert.equal(response.status(), 200, path);
        assert.ok(response.headers()['content-security-policy']?.includes("script-src-attr 'none'"));
    }
    async function capture(name) {
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name + ' overflow');
        violations.push(...await page.evaluate(() => window.accountReleaseViolations));
        await page.screenshot({ path: join(output, `${label}-${name}.png`) });
    }
    async function configReady() {
        await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
            && document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
            && document.querySelector('.bp-topic-row') && document.querySelector('#workspace-topic-summary')?.textContent.trim()
            && document.body.dataset.configSidebarPhase === 'idle');
    }
    try {
        await visit('/');
        await page.waitForFunction(() => document.querySelector('#topics-grid')?.getAttribute('aria-busy') === 'false'
            && document.querySelector('.th-card[data-preview-state="loaded"] .th-model'));
        assert.equal(await page.locator('.bp-coverage-experiment, #home-coverage-penalty').count(), 0);
        assert.equal(await page.locator('.th-creator .bp-topic-byline').count(), 0);
        assert.equal(await page.locator('#beta-feedback-link').count(), 1);
        assert.ok(await page.locator('a[href="/topic-proposals"]').count());
        assert.equal(await page.locator('[data-topics-view]').count(), 4);
        assert.equal(await page.locator('[data-topics-view="mine"]').count(), 0);
        assert.equal(await page.locator('#topics-configured').getAttribute('aria-label'), 'Mine');
        const topicPath = await page.locator('.th-topic-link').first().getAttribute('href');
        assert.match(topicPath, /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
        await capture('home');
        await page.locator('#topics-configured').click();
        await page.locator('#mine-actions:not([hidden])').waitFor();
        assert.equal(await page.locator('#new-private-topic').isVisible(), true);
        await capture('home-mine');

        await visit(topicPath);
        await configReady();
        assert.equal(await page.locator('#agi-promo, #beta-feedback-link').count(), 0);
        assert.equal(await page.locator('a[href="/topic-proposals"], [data-create-topic="public"]').count(), 0);
        assert.equal(await page.locator('[data-navigation-view]').count(), 4);
        assert.equal(await page.locator('[data-navigation-view="mine"]').count(), 0);
        assert.ok((await page.locator('#workspace-topic-summary').innerText()).trim());
        if (viewport.width > 760) {
            assert.equal(await page.locator('body').evaluate(node => node.classList.contains('config-sidebar-collapsed')), true);
            await page.locator('#config-sidebar-toggle').click();
            await page.waitForFunction(() => !document.body.classList.contains('config-sidebar-collapsed'));
            await page.reload({ waitUntil: 'domcontentloaded' });
            await configReady();
            assert.equal(await page.locator('body').evaluate(node => node.classList.contains('config-sidebar-collapsed')), false);
        }
        await capture('configuration');
        if (viewport.width <= 760) {
            await page.locator('#taxonomy-toggle').click();
            await page.waitForFunction(() => document.body.classList.contains('taxonomy-open'));
        }
        await page.locator('[data-navigation-view="configured"]').click();
        assert.equal(await page.locator('[data-create-topic="private"]').isVisible(), true);
        await capture('configuration-mine');

        const hallResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/get_topic_proposals' && response.status() === 200);
        await visit('/topic-proposals');
        const hall = await (await hallResponse).json();
        assert.deepEqual(hall.limits, { supports: 3, proposals: 1, days: 14 });
        assert.equal(hall.account, null); assert.equal(hall.activeProposal, null);
        await page.waitForFunction(() => !document.querySelector('#open-proposal').disabled
            && document.querySelector('#proposals-list-region').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('#proposals-list-region').getAttribute('aria-busy'), 'false');
        await page.locator('#open-proposal').click();
        await page.locator('#proposal-dialog[open]').waitFor();
        assert.equal(await page.locator('#proposal-dialog input[type="checkbox"]').count(), 0);
        assert.match(await page.locator('#proposal-email-notice').innerText(), /verified address linked to your GitHub account/);
        await page.locator('#proposal-name').fill('Unsubmitted browser-check draft');
        await capture('proposal-dialog');
        await page.locator('#proposal-cancel').click();
        await capture('proposal-hall');
        await visit('/how-it-works');
        assert.equal(await page.locator('a[href="/topic-proposals"]').count(), 0);

        await visit('/github_login');
        await page.waitForFunction(() => !document.querySelector('#sign-in-submit')?.disabled);
        assert.equal(await page.locator('input[type="checkbox"]').count(), 0);
        assert.equal(await page.locator('#sign-in-submit').innerText(), 'Agree & continue with GitHub');
        assert.doesNotMatch(await page.locator('body').innerText(), /mainland|China/i);
        await capture('sign-in');
        await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
        assert.equal(new URL(page.url()).pathname, '/github_login', 'Guest completion route cannot claim success');
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
        assert.ok(violations.every(event => event.uri.startsWith('https://static.cloudflareinsights.com')), JSON.stringify(violations));
        results.push({ engine: launcher.name(), viewport, passed: true, pageErrors: 0, writes: 0,
            pages: ['home', 'configuration', 'proposal hall', 'proposal dialog', 'sign in'],
            blockedAnalytics: violations.length });
        console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {});
        throw error;
    } finally { await context.close(); await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify({ results }, null, 2));
