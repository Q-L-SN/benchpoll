import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

async function checkEditor(dialog) {
    await dialog.waitFor();
    const { left, right, top, bottom, width, height, fill, ink } = await dialog.evaluate(async element => {
        const submit = element.querySelector('button[type="submit"]');
        await Promise.allSettled(submit.getAnimations().map(animation => animation.finished));
        const { left, right, top, bottom } = element.getBoundingClientRect();
        const { clientWidth: width, clientHeight: height } = document.documentElement;
        const { backgroundColor: fill, color: ink } = getComputedStyle(submit);
        return { left, right, top, bottom, width, height, fill, ink };
    });
    assert.ok(Math.abs(left - (width - right)) < 1, 'The editor is horizontally centered');
    assert.ok(Math.abs(top - (height - bottom)) < 1, 'The editor is vertically centered');
    assert.ok(fill === 'rgb(196, 81, 5)' || fill === 'rgb(168, 67, 4)', `Expected an orange submit button, got ${fill}`);
    assert.equal(ink, 'rgb(255, 255, 255)');
}

async function checkEditButton(button) {
    const style = await button.evaluate(element => {
        const { width, height } = element.getBoundingClientRect();
        const { backgroundColor, borderWidth } = getComputedStyle(element);
        return { width, height, backgroundColor, borderWidth };
    });
    assert.ok(style.width >= 44 && style.height >= 44);
    assert.equal(style.backgroundColor, 'rgba(0, 0, 0, 0)');
    assert.equal(style.borderWidth, '0px');
}

for (const [engine, width] of [[chromium, 1440], [chromium, 390], [webkit, 390]]) {
    test(`home and workspace can create and edit topics in ${engine.name()} at ${width}px`, async t => {
        const home = await startTopicsPreview({ authenticated: true });
        for (const topic of home.state.topics) if (!topic.isPrivate) topic.isMine = false;
        const workspace = await startPreview();
        const browser = await engine.launch({ headless: true });
        t.after(async () => { await browser.close(); await home.close(); await workspace.close(); });
        const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        page.setDefaultTimeout(10000);
        await page.route('https://**/*', route => route.abort());
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'false'));
        const editor = page.getByRole('dialog', { name: 'New topic', exact: true });
        const publicChoice = editor.getByRole('button', { name: 'Public', exact: true });
        const publish = editor.getByRole('button', { name: 'Publish topic' });
        const fill = async name => {
            assert.equal(await editor.getByRole('button', { name: 'Private', exact: true }).getAttribute('aria-pressed'), 'true');
            await publicChoice.click();
            await editor.getByLabel('Name', { exact: true }).fill(name);
            await editor.getByLabel('One-sentence summary').fill('Compare a collection of useful benchmarks.');
        };
        await page.goto(home.url);
        await page.locator('.th-card').first().waitFor();
        const homeCreate = page.getByRole('button', { name: 'Create topic', exact: true });
        if (!await homeCreate.isVisible()) await page.locator('#topics-more summary').click();
        await homeCreate.click();
        await fill('Directory evaluation');
        await checkEditor(editor);
        const [created] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/save_private_topic')), publish.click()]);
        assert.equal(created.status(), 201);
        const cardLink = page.getByRole('link', { name: 'Directory evaluation', exact: true });
        await cardLink.waitFor();
        assert.match(await cardLink.getAttribute('href'), /^\/\d+$/);
        assert.equal(home.state.created[0].isPrivate, false);
        assert.equal(home.state.requests.filter(item => item.path === '/api/set_topic_visibility').length, 0);
        const cardEdit = page.locator('.th-card').filter({ has: cardLink }).getByRole('button', { name: 'Edit topic', exact: true });
        await checkEditButton(cardEdit);
        await cardEdit.click();
        const publicEditor = page.getByRole('dialog', { name: 'Edit public topic', exact: true });
        await checkEditor(publicEditor);
        await publicEditor.getByLabel('Name', { exact: true }).fill('Edited directory evaluation');
        await publicEditor.getByRole('button', { name: 'Save changes' }).click();
        await page.getByRole('link', { name: 'Edited directory evaluation', exact: true }).click();
        await page.waitForURL(home.url + home.state.created[0].url);
        await page.goto(home.url);
        await page.getByRole('combobox', { name: 'Topic collection' }).click();
        await page.getByRole('option', { name: 'Topics I created' }).click();
        const editedLink = page.getByRole('link', { name: 'Edited directory evaluation', exact: true });
        const editedCard = page.locator('.th-card').filter({ has: editedLink });
        const edit = editedCard.getByRole('button', { name: 'Edit topic', exact: true });
        await edit.click();
        assert.equal(await publicEditor.getByRole('button', { name: 'Delete topic', exact: true }).isVisible(), false);
        await publicEditor.getByRole('button', { name: 'Private', exact: true }).click();
        await publicEditor.waitFor({ state: 'hidden' });
        await edit.click();
        const unpublished = page.getByRole('dialog', { name: 'Edit private topic', exact: true });
        await unpublished.getByRole('button', { name: 'Delete topic', exact: true }).click();
        await unpublished.locator('#topic-editor-confirm-delete').click();
        await editedLink.waitFor({ state: 'hidden' });

        await page.goto(workspace.url + '/1');
        await page.locator('#benchmark-rows .bp-benchmark-row').first().waitFor({ state: 'attached' });
        const sidebarCreate = page.locator('#sidebar-topic-creation').getByRole('button', { name: 'Create topic', exact: true });
        if (width < 760) await page.locator('#taxonomy-toggle').click();
        await sidebarCreate.click();
        await fill('Sidebar evaluation');
        await checkEditor(editor);
        await editor.getByRole('button', { name: 'Add scene' }).click();
        await editor.getByRole('textbox', { name: 'Scene name 1' }).fill('General');
        const [published] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/save_private_topic')), publish.click()]);
        assert.equal(published.status(), 201);
        await page.waitForURL(workspace.url + '/1000/1');
        const request = workspace.state.requests.find(item => item.path === '/api/save_private_topic');
        assert.equal(request.body.isPrivate, false);
        assert.equal(request.body.scenes[0].name, 'General');

        workspace.state.isPrivate = true;
        if (width < 760) await page.setViewportSize({ width: 320, height: 900 });
        await page.route('**/api/get_private_topic_editor', route => route.fulfill({ json: {
            ID: 1, isPrivate: true, name: 'Private evaluation', description: 'A collection of practical evaluations.',
            editRevision: 'fixture-1', scenes: Array.from({ length: 20 }, (_, index) => ({
                ID: index + 1, name: `Scene ${index + 1}`, isDefault: index === 0
            }))
        } }));
        await page.goto(workspace.url + '/1');
        const workspaceEdit = page.getByRole('button', { name: 'Edit private topic', exact: true });
        await workspaceEdit.waitFor();
        await checkEditButton(workspaceEdit);
        const titleBounds = await page.locator('#bp-breadcrumb > .bp-breadcrumb-current').boundingBox();
        const editBounds = await workspaceEdit.boundingBox();
        assert.ok(editBounds.x >= 0 && editBounds.x + editBounds.width <= page.viewportSize().width,
            'The edit button is fully inside the viewport');
        assert.ok(Math.abs(titleBounds.y + titleBounds.height / 2 - (editBounds.y + editBounds.height / 2)) < 1,
            'The edit button stays on the same row as the topic title');
        await workspaceEdit.click();
        const privateEditor = page.getByRole('dialog', { name: 'Edit private topic', exact: true });
        await checkEditor(privateEditor);
        await privateEditor.getByRole('button', { name: 'Cancel', exact: true }).click();
        await privateEditor.waitFor({ state: 'hidden' });
    });
}
