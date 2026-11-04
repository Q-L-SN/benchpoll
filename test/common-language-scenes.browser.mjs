import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startLifecyclePreview } from './helpers/topic-lifecycle-preview.mjs';
import { seedCommonLanguageScenes } from './helpers/common-language-scenes-fixture.mjs';
import { COMMON_LANGUAGE_SCENES, migrateCommonLanguageScenes } from '../scripts/migrate-common-language-scenes-20261104.mjs';

test('migrated scene directory and canonical paths in Chromium and WebKit', async t => {
    const app = await startLifecyclePreview();
    t.after(() => app.close());
    await seedCommonLanguageScenes(app.db);
    const connection = await app.db.getConnection();
    try {
        const plan = await migrateCommonLanguageScenes(connection);
        await migrateCommonLanguageScenes(connection, { apply: true, rehearsal: true, expectedPlanHash: plan.planHash });
    } finally { connection.release(); }
    const output = 'artifacts/common-language-scenes-20261104';
    await mkdir(output, { recursive: true });
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch({ headless: true });
        try {
            for (const width of [390, 1440]) await t.test(`${engine.name()} ${width}px scene lists, paths and default redirects`, async () => {
                const page = await browser.newPage({ viewport: { width, height: 900 } });
                const errors = []; page.on('pageerror', error => errors.push(error.message));
                try {
                    await page.goto(app.url);
                    for (const topic of [COMMON_LANGUAGE_SCENES.coding, COMMON_LANGUAGE_SCENES.language]) {
                        await page.locator(`#topics-grid .th-card[data-topic-id="${topic.ID}"] .th-scene-toggle`).click();
                        const dialog = page.locator('#topic-scenes-dialog'); await dialog.waitFor({ state: 'visible' });
                        assert.deepEqual(await dialog.locator('.th-topic-name').allTextContents(), topic.scenes.map(scene => scene.name));
                        const links = await dialog.locator('.th-topic-name').evaluateAll(nodes => nodes.map(node => node.closest('a')?.getAttribute('href') ?? node.querySelector('a')?.getAttribute('href')));
                        assert.deepEqual(links, topic.scenes.map(scene => `/${topic.slug}/${scene.slug}`));
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                        await page.screenshot({ path: `${output}/${topic.slug}-${engine.name()}-${width}.png` });
                        await dialog.getByRole('button', { name: 'Close scenes' }).click(); await dialog.waitFor({ state: 'hidden' });
                    }
                    for (const slug of ['language', 'coding']) {
                        const response = await page.request.get(app.url + '/' + slug, { maxRedirects: 0 });
                        assert.equal(response.status(), 302);
                        assert.equal(response.headers().location, '/' + slug + '/general');
                    }
                    for (const slug of ['c', 'c-plus-plus', 'c-sharp']) assert.equal((await page.request.get(app.url + '/coding/' + slug)).status(), 200);
                    assert.equal((await page.request.get(app.url + '/language/aa')).status(), 404);
                    assert.deepEqual(errors, []);
                } finally { await page.close(); }
            });
        } finally { await browser.close(); }
    }
});
