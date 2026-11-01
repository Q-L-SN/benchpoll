import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { contributionPath } from '../../public/js/shared/contribution-navigation.js';

const output = resolve(process.env.HELP_COPY_OUTPUT ?? 'artifacts/help-copy-20261010/browser');
const builtRoot = process.env.HOME_BUILT_ROOT;
const reports = [];
await mkdir(output, { recursive: true });
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const cases = [['chromium', chromium, 1440], ['chromium', chromium, 1024],
    ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]];

async function fits(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
}

async function help(page, selector, mobile) {
    const trigger = page.locator(selector);
    await trigger.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    if (mobile) await trigger.tap();
    else await trigger.click();
    const panel = page.locator('#bp-help-popover');
    await panel.waitFor();
    const bounds = await panel.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: innerWidth, height: innerHeight, overflow: node.scrollWidth > node.clientWidth + 1 };
    });
    assert.ok(bounds.left >= 11 && bounds.right <= bounds.width - 11);
    assert.ok(bounds.top >= 11 && bounds.bottom <= bounds.height - 11);
    assert.equal(bounds.overflow, false);
    await fits(page);
    return panel;
}

for (const [engine, launcher, width] of cases) {
    const name = `${engine}-${width}`;
    const mobile = width < 760;
    const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true });
    const browser = await launcher.launch({ headless: true, env });
    const context = await browser.newContext({ viewport: { width, height: 900 },
        isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    try {
        if (builtRoot) {
            await context.route('**/*', async route => {
                const request = route.request(), path = new URL(request.url()).pathname;
                if (request.resourceType() === 'document') {
                    const file = path === '/' ? 'home-built.html' : path === '/how-it-works'
                        ? 'how-it-works.html' : path.startsWith('/contribute') ? 'contribute.html' : null;
                    if (file) return route.fulfill({ body: await readFile(join(builtRoot, 'private', file)), contentType: 'text/html' });
                }
                if (/^\/(?:js|css|build\/home)\//.test(path)) return route.fulfill({
                    body: await readFile(join(builtRoot, 'public', path)),
                    contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript'
                });
                return route.fallback();
            });
        }
        await page.goto(app.url, { waitUntil: 'domcontentloaded' });
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
        const publicHelp = await help(page, '.bp-public-pie-info', mobile);
        assert.match(await publicHelp.textContent(), /Saved Pies shape/);
        assert.match(await publicHelp.textContent(), /Each Pie counts once/);
        assert.equal(await publicHelp.locator('p').count(), 1);
        assert.match(await publicHelp.locator('a').getAttribute('href'), /#calculation-details$/);
        await publicHelp.screenshot({ path: join(output, name + '-public-help.png') });
        await page.keyboard.press('Escape');

        if (mobile) await page.locator('[data-mobile-panel="models"]').click();
        const scoreHelp = await help(page, '.bp-scoring-help', mobile);
        assert.match(await scoreHelp.textContent(), /missing scores could change the total/);
        assert.match(await scoreHelp.textContent(), /estimates those gaps/);
        await page.keyboard.press('Escape');
        const comparison = await help(page, '#quick-comparison-help', mobile);
        assert.match(await comparison.textContent(), /Missing settings/);
        assert.equal(await comparison.locator('li').count(), 4);
        await comparison.screenshot({ path: join(output, name + '-comparison-help.png') });
        await page.keyboard.press('Escape');

        if (mobile) await page.locator('[data-mobile-panel="mix"]').click();
        await page.locator('#pie-mode-personal').click();
        await page.locator('#pie-mode-personal[aria-selected="true"][aria-busy="false"]').waitFor();
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        if (await page.locator('#inline-fallback-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#inline-fallback-toggle').click();
        const fallback = await help(page, '.bp-inline-fallback-info', mobile);
        assert.match(await fallback.textContent(), /first available/);
        await page.keyboard.press('Escape');
        await page.locator('#inline-fallback-add-other-versions').click();
        await page.locator('#inline-fallback-chart .bp-auto-version-button').click();
        const versions = page.locator('#version-group-dialog');
        await versions.locator('.bp-version-priority-list').waitFor();
        assert.match(await versions.textContent(), /New versions join/);
        assert.match(await versions.textContent(), /order, not the score/);
        assert.equal(await versions.locator('.bp-version-group-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        await versions.screenshot({ path: join(output, name + '-other-versions.png') });

        const guide = await context.newPage();
        await guide.goto(app.url + '/how-it-works', { waitUntil: 'domcontentloaded' });
        await guide.evaluate(() => document.fonts.ready);
        assert.match(await guide.locator('.bp-how-lede').textContent(), /Shape your ranking/);
        assert.equal(await guide.locator('#calculation-details').getAttribute('open'), null);
        await fits(guide);
        await guide.screenshot({ path: join(output, name + '-guide.png') });
        await guide.locator('#public').evaluate(node => node.scrollIntoView());
        await guide.locator('#public').screenshot({ path: join(output, name + '-public-rules.png') });
        await guide.locator('#rules summary').filter({ hasText: /^What does Fallback do\?$/ }).click();
        const answer = guide.locator('#rules details').filter({ has: guide.locator('summary', { hasText: /^What does Fallback do\?$/ }) });
        assert.match(await answer.locator('p').first().textContent(), /Try a backup/);
        await answer.screenshot({ path: join(output, name + '-fallback-rules.png') });
        await guide.locator('#calculation-details > summary').click();
        await guide.waitForFunction(() => document.getElementById('calculation-details').open);
        await guide.getByRole('button', { name: 'Expand all', exact: true }).click();
        await guide.waitForFunction(() => [...document.querySelectorAll('#calculation-details .bp-how-rule-answers details')].every(node => node.open));
        await fits(guide);
        await guide.getByRole('button', { name: 'Collapse all', exact: true }).click();
        await guide.waitForFunction(() => [...document.querySelectorAll('#calculation-details .bp-how-rule-answers details')].every(node => !node.open));
        await guide.locator('#calculation-details > summary').click();
        await guide.waitForFunction(() => !document.getElementById('calculation-details').open);
        await guide.goto(app.url + '/how-it-works#agi', { waitUntil: 'domcontentloaded' });
        await guide.waitForFunction(() => document.getElementById('calculation-details').open && document.getElementById('agi').open);

        const form = await context.newPage();
        await form.goto(app.url + contributionPath('score_field'), { waitUntil: 'domcontentloaded' });
        await form.locator('.score-field-definition').waitFor();
        await form.getByRole('combobox', { name: 'Field type' }).selectOption('number');
        assert.match(await form.locator('.score-field-definition').textContent(), /including decimals/);
        await fits(form);
        await form.screenshot({ path: join(output, name + '-field-form.png'), fullPage: true });
        if (mobile) await form.locator('#contribution-taxonomy-toggle').click();
        await form.locator('#contribution-help').click();
        const contribution = form.locator('#contribution-guide-dialog');
        await contribution.waitFor();
        assert.match(await contribution.textContent(), /Submitted does not mean published/);
        assert.match(await contribution.textContent(), /Model settings are not test versions/);
        await fits(form);
        await contribution.screenshot({ path: join(output, name + '-contribution-guide.png') });
        assert.deepEqual(errors, []);
        reports.push({ name, passed: true, compiled: Boolean(builtRoot),
            publicHelp: true, scoreModes: true, comparison: true, dynamicVersions: true,
            guide: true, contribution: true, mobile });
        console.log(JSON.stringify({ name, passed: true }));
    } catch (error) {
        await page.screenshot({ path: join(output, name + '-FAILED.png'), fullPage: true }).catch(() => {});
        reports.push({ name, passed: false, error: String(error), errors });
        throw error;
    } finally {
        await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
        await context.close(); await browser.close(); await app.close();
    }
}
