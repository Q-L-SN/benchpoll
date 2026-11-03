import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { startLifecyclePreview } from './helpers/topic-lifecycle-preview.mjs';
import { getTopic } from '../topic-service.js';
import { savePersonalPie, loadPersonalPie } from '../ranking-service.js';

const output = resolve(process.env.TOPIC_LIFECYCLE_OUTPUT || 'artifacts/topic-lifecycle-20261102');
await mkdir(output, { recursive: true });
const results = [];
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
        for (const width of [1440, 390]) {
            const app = await startLifecyclePreview();
            const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', event => { if (event.type() === 'error' && /Content Security Policy|Refused to/.test(event.text())) errors.push(event.text()); });
            const fit = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
            const closed = async selector => page.waitForFunction(selector => !document.querySelector(selector).open, selector);
            try {
                await page.goto(app.url);
                await page.waitForSelector('.th-card'); await page.locator('#topics').scrollIntoViewIfNeeded();
                await page.locator('[data-topics-view="configured"]').click();
                await page.locator('#new-private-topic').click();
                await page.locator('#new-topic-name').fill('My evaluation');
                await page.locator('#new-topic-description').fill('Evaluate useful work with reproducible evidence.');
                for (const [index, name] of ['Coding', 'Research'].entries()) {
                    await page.locator('#topic-editor-add-scene').click();
                    await page.getByRole('textbox', { name: 'Scene name ' + (index + 1), exact: true }).fill(name);
                }
                await fit(); await page.screenshot({ path: resolve(output, `${engineName}-${width}-private-editor.png`) });
                await page.locator('#create-topic-submit').click(); await closed('#create-topic-dialog');
                const [[row]] = await app.db.execute("SELECT ID FROM categories WHERE name = 'My evaluation' AND is_active = 1");
                assert.ok(row?.ID); const ID = Number(row.ID);
                let topic = await getTopic(app.db, '42', ID);
                for (const scene of topic.scenes) await savePersonalPie(app.db, { userID: '42', writeIdentity: randomUUID(), categoryID: ID,
                    contextValues: { scene: String(scene.ID) }, expectedRevision: 0,
                    entries: [{ conditionID: 1, weightBasisPoints: 8000 }, { conditionID: 2, weightBasisPoints: 2000 }], fallbackRules: [] });
                await page.getByRole('button', { name: 'Edit private topic', exact: true }).click();
                await page.getByRole('textbox', { name: 'Scene name 2', exact: true }).fill('Deep research');
                await page.getByRole('radio', { name: 'Default scene: Deep research', exact: true }).check();
                await page.locator('#create-topic-submit').click(); await closed('#create-topic-dialog');
                topic = await getTopic(app.db, '42', ID);
                assert.equal(topic.scenes[0].name, 'Deep research');
                const redirect = await page.request.get(app.url + '/personal/' + ID + '?focusModel=1', { maxRedirects: 0 });
                assert.equal(redirect.status(), 302); assert.equal(redirect.headers().location, `/personal/${ID}/deep-research?focusModel=1`);
                for (const suffix of ['?scene=' + topic.defaultContextID, '?context_scene=' + topic.defaultContextID, '/missing']) {
                    assert.equal((await page.request.get(app.url + '/personal/' + ID + suffix, { maxRedirects: 0 })).status(), 404);
                }
                await page.getByRole('button', { name: 'Edit private topic', exact: true }).click();
                await page.locator('#topic-editor-propose').click();
                await page.waitForURL('**/topic-proposals?sourceTopicID=' + ID);
                await page.waitForFunction(() => document.querySelector('#proposal-name')?.value === 'My evaluation');
                assert.equal(await page.locator('#proposal-source').inputValue(), String(ID));
                await page.locator('#proposal-submit').click(); await closed('#proposal-dialog');
                const discussionLink = page.getByRole('link', { name: 'Discuss My evaluation', exact: true });
                assert.match(await discussionLink.getAttribute('href'), /\/preview#discussion$/);
                assert.equal(await discussionLink.locator('i.fa-comments').count(), 1);
                await page.getByRole('link', { name: 'Preview proposal', exact: true }).click();
                await page.waitForSelector('.pp-ranking tbody tr');
                assert.match(await page.locator('.pp-ranking tbody tr').first().innerText(), /Model 1/);
                const inputs = page.locator('#proposal-trial-weights input');
                await inputs.nth(0).fill('10'); await inputs.nth(1).fill('90');
                await page.locator('#proposal-calculate').click();
                await page.waitForFunction(() => document.querySelector('.pp-ranking tbody tr')?.textContent.includes('Model 3'));
                await page.locator('#proposal-preview-mode').selectOption('range');
                await page.waitForFunction(() => document.querySelector('#proposal-preview-ranking')?.getAttribute('aria-busy') === 'false');
                await fit(); await page.screenshot({ path: resolve(output, `${engineName}-${width}-proposal-trial.png`) });
                const [[votes]] = await app.db.query('SELECT COUNT(*) AS n FROM topic_proposal_votes'); assert.equal(Number(votes.n), 0);
                await page.locator('#proposal-copy-name').fill('My trial copy'); await page.locator('#proposal-copy').click();
                await page.waitForSelector('#proposal-copy-status a');
                const copyID = Number((await page.locator('#proposal-copy-status a').getAttribute('href')).split('/').at(-1));
                const copy = await getTopic(app.db, '42', copyID);
                assert.equal(copy.scenes.length, 2);
                assert.deepEqual((await loadPersonalPie(app.db, copy.defaultContextID, '42')).entries.sort((a, b) => a.conditionID - b.conditionID).map(item => item.weightBasisPoints), [1000, 9000]);
                assert.deepEqual((await loadPersonalPie(app.db, copy.scenes[1].ID, '42')).entries.sort((a, b) => a.conditionID - b.conditionID).map(item => item.weightBasisPoints), [8000, 2000]);
                const previewURL = page.url();
                await page.locator('#proposal-discussion-text').fill('Which benchmarks best represent this topic?');
                await page.locator('#proposal-discussion-submit').click();
                await page.getByText('Which benchmarks best represent this topic?', { exact: true }).waitFor();
                app.state.userID = '43'; await page.reload();
                await page.waitForSelector('.pp-ranking tbody tr');
                assert.equal(await inputs.first().isDisabled(), true);
                assert.equal(await page.locator('#proposal-calculate').isVisible(), false);
                await page.getByRole('link', { name: '0 replies', exact: true }).click();
                await page.locator('#proposal-discussion-text').fill('I would include more research evaluations.');
                await page.locator('#proposal-discussion-submit').click();
                await page.getByText('I would include more research evaluations.', { exact: true }).waitFor();
                await fit(); await page.screenshot({ path: resolve(output, `${engineName}-${width}-proposal-discussion.png`) });
                app.state.userID = null; await page.reload(); await page.waitForSelector('.pp-ranking tbody tr');
                assert.equal(await inputs.first().isDisabled(), true);
                await page.locator('#proposal-preview-scenes button').last().click();
                await page.waitForFunction(() => document.querySelector('#proposal-preview-ranking')?.getAttribute('aria-busy') === 'false');
                assert.equal((await page.request.get(app.url + '/personal/' + copyID)).status(), 404);
                app.state.userID = '42';
                await page.goto(app.url); await page.waitForSelector('.th-card');
                await page.locator('#topics').scrollIntoViewIfNeeded(); await page.locator('[data-topics-view="configured"]').click();
                const sourceCard = page.locator('.th-card').filter({ has: page.locator('.th-card-title a', { hasText: 'My evaluation' }) });
                await sourceCard.getByRole('button', { name: 'Edit private topic', exact: true }).click();
                await page.locator('#topic-editor-delete').click();
                assert.match(await page.locator('#topic-editor-delete-impact').textContent(), /withdraw your proposal/);
                assert.match(await page.locator('#topic-editor-delete-impact').textContent(), /already in review/);
                await page.locator('#topic-editor-confirm-delete').click();
                await closed('#create-topic-dialog');
                await page.goto(previewURL);
                await page.getByText('This proposal is no longer available.', { exact: true }).first().waitFor();
                assert.equal((await app.db.query('SELECT ID FROM topic_proposals'))[0].length, 0);
                assert.deepEqual(errors, []);
                results.push({ engine: engineName, width, passed: true });
                console.log(engineName + ' ' + width + ': passed');
            } catch (error) {
                await page.screenshot({ path: resolve(output, `${engineName}-${width}-failure.png`), fullPage: true });
                await writeFile(resolve(output, 'failure.txt'), JSON.stringify({ url: page.url(), error: error.stack, errors,
                    visible: await page.locator('body').innerText(), requests: app.state.requests.slice(-8) }, null, 2));
                throw error;
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(resolve(output, 'report.json'), JSON.stringify(results, null, 2));
