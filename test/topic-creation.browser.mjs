import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

for (const width of [1440, 390]) {
    test(`home and workspace can publish a new topic directly at ${width}px`, async t => {
        const home = await startTopicsPreview({ authenticated: true });
        for (const topic of home.state.topics) if (!topic.isPrivate) topic.isMine = false;
        const workspace = await startPreview();
        const browser = await chromium.launch({ headless: true });
        t.after(async () => { await browser.close(); await home.close(); await workspace.close(); });
        const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        page.setDefaultTimeout(10000);
        await page.route('https://**/*', route => route.abort());
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'false'));
        const editor = page.getByRole('dialog', { name: 'New topic', exact: true });
        const publicChoice = editor.getByRole('radio', { name: 'Public' });
        const publish = editor.getByRole('button', { name: 'Publish topic' });
        const fill = async name => {
            assert.equal(await editor.getByRole('radio', { name: 'Private' }).isChecked(), true);
            await publicChoice.check();
            await editor.getByLabel('Name', { exact: true }).fill(name);
            await editor.getByLabel('One-sentence summary').fill('Compare a collection of useful benchmarks.');
        };
        await page.goto(home.url);
        await page.locator('.th-card').first().waitFor();
        const homeCreate = page.getByRole('button', { name: 'Create topic', exact: true });
        if (!await homeCreate.isVisible()) await page.locator('#topics-more summary').click();
        await homeCreate.click();
        await fill('Directory evaluation');
        const [created] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/save_private_topic')), publish.click()]);
        assert.equal(created.status(), 201);
        const cardLink = page.getByRole('link', { name: 'Directory evaluation', exact: true });
        await cardLink.waitFor();
        assert.match(await cardLink.getAttribute('href'), /^\/\d+$/);
        assert.equal(home.state.created[0].isPrivate, false);
        assert.equal(home.state.requests.filter(item => item.path === '/api/set_topic_visibility').length, 0);
        await cardLink.click();
        await page.waitForURL(home.url + home.state.created[0].url);

        await page.goto(workspace.url + '/1');
        await page.locator('#benchmark-rows .bp-benchmark-row').first().waitFor({ state: 'attached' });
        const sidebarCreate = page.locator('#sidebar-topic-creation').getByRole('button', { name: 'Create topic', exact: true });
        if (width < 760) await page.locator('#taxonomy-toggle').click();
        await sidebarCreate.click();
        await fill('Sidebar evaluation');
        await editor.getByRole('button', { name: 'Add scene' }).click();
        await editor.getByRole('textbox', { name: 'Scene name 1' }).fill('General');
        const [published] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/save_private_topic')), publish.click()]);
        assert.equal(published.status(), 201);
        await page.waitForURL(workspace.url + '/1000/1');
        const request = workspace.state.requests.find(item => item.path === '/api/save_private_topic');
        assert.equal(request.body.isPrivate, false);
        assert.equal(request.body.scenes[0].name, 'General');
    });
}
