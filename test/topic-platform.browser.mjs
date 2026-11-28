import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import express from 'express';
import { chromium } from 'playwright';

const app = express(); app.use(express.json()); app.use('/js', express.static(resolve('public/js')));
app.use('/css', express.static(resolve('public/css')));
const revision = 'a'.repeat(64);
let topic = { ID: 1, categoryID: 1, name: 'My topic', description: 'Evaluate useful work.', isPrivate: true,
    isMine: true, privateID: 'AbCdEf123456', publicID: 1, url: '/private/AbCdEf123456',
    editRevision: revision, scenes: [], favoriteCount: 0, isFavorited: false };
let favoriteWrites = 0, visibilityWrites = 0, favoriteRelease = null, rejectFavorite = false, rejectPublication = false, createdDraft;
app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html><head><link rel="stylesheet" href="/css/ui/components.css"><link rel="stylesheet" href="/css/ui/private-topic-editor.css"><link rel="stylesheet" href="/css/ui/navigation.css"></head><body>
<div id="favorites"></div><button id="edit">Edit topic</button><button id="create">Create topic</button><p id="status" role="status"></p>
<script type="module">
import { createFavoriteButton } from '/js/shared/topic-actions.js';
import { createPrivateTopicEditor } from '/js/shared/private-topic-editor.js';
import { pageAccountWriteScope } from '/js/shared/account-identity.js';
pageAccountWriteScope.bind('1');
const metadata = ${JSON.stringify(topic)};
for (let i = 0; i < 2; i++) document.querySelector('#favorites').append(createFavoriteButton(metadata, {onError(_error,message){document.querySelector('#status').textContent=message;}}));
const editor = createPrivateTopicEditor({onSaved(result){window.savedTopic=result;}});
document.querySelector('#edit').onclick=()=>editor.open(1);
document.querySelector('#create').onclick=()=>editor.open();
window.ready=true;
</script></body></html>`));
app.post('/api/get_privacy_status', (_req, res) => res.json({ csrfToken: 'fixture-csrf' }));
app.post('/api/get_private_topic_editor', (_req, res) => res.json(topic));
app.post('/api/save_private_topic', (req, res) => {
    createdDraft = req.body;
    res.json({ ...topic, name: req.body.name, isPrivate: req.body.isPrivate, ID: 2, publicID: 2, url: '/2' });
});
app.post('/api/set_topic_favorite', async (req, res) => {
    favoriteWrites++;
    assert.equal(req.body.categoryID, 1); assert.equal(req.body.csrfToken, 'fixture-csrf');
    assert.equal(req.body.expectedUserID, '1'); assert.match(req.get('idempotency-key'), /^[a-f0-9-]{36}$/);
    if (!rejectFavorite) await new Promise(resolve => { favoriteRelease = () => { favoriteRelease = null; resolve(); }; });
    if (rejectFavorite) return res.status(404).json({ error: 'topic_not_found' });
    topic = { ...topic, isFavorited: req.body.isFavorited, favoriteCount: Number(req.body.isFavorited) };
    res.json({ categoryID: 1, isFavorited: topic.isFavorited, favoriteCount: topic.favoriteCount });
});
app.post('/api/set_topic_visibility', (req, res) => {
    visibilityWrites++;
    assert.equal(req.body.expectedUserID, '1'); assert.equal(req.body.expectedRevision, revision);
    assert.equal(req.body.csrfToken, 'fixture-csrf');
    if (rejectPublication) return res.status(409).json({ error: 'public_topic_limit' });
    topic = { ...topic, isPrivate: !req.body.isPublic, url: req.body.isPublic ? '/1' : '/private/AbCdEf123456' };
    res.json(topic);
});
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready);
    const favorites = page.locator('.bp-topic-favorite');
    await favorites.first().click(); await page.waitForFunction(() => document.querySelector('.bp-topic-favorite-count').textContent === '1');
    assert.equal(await favorites.nth(1).getAttribute('aria-pressed'), 'true');
    const release = async () => {
        while (!favoriteRelease) await new Promise(resolve => setTimeout(resolve, 5));
        favoriteRelease();
    };
    await favorites.nth(1).click();
    assert.equal(await favorites.first().getAttribute('aria-pressed'), 'false');
    assert.equal(await favorites.first().innerText(), '0');
    await release(); await release();
    await page.waitForFunction(() => document.querySelector('.bp-topic-favorite').getAttribute('aria-busy') === 'false');
    assert.equal(favoriteWrites, 2);
    assert.equal(topic.isFavorited, false);
    await favorites.first().click(); await favorites.nth(1).click(); await favorites.first().click();
    assert.equal(await favorites.nth(1).getAttribute('aria-pressed'), 'true');
    await release();
    await page.waitForFunction(() => document.querySelector('.bp-topic-favorite').getAttribute('aria-busy') === 'false');
    assert.equal(favoriteWrites, 3, 'Intermediate clicks coalesce into the last requested state');
    assert.equal(topic.isFavorited, true);
    rejectFavorite = true;
    await favorites.first().click(); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('no longer available'));
    assert.equal(await favorites.first().getAttribute('aria-pressed'), 'true');
    assert.equal(await favorites.nth(1).getAttribute('aria-pressed'), 'true');
    assert.equal(await favorites.nth(1).locator('.bp-topic-favorite-count').textContent(), '1');
    assert.match(await page.locator('.bp-toast.is-visible').textContent(), /no longer available/);
    await page.locator('#create').click();
    const visibility = page.getByRole('group', { name: 'Topic visibility' });
    const privateOption = visibility.getByRole('button', { name: 'Private', exact: true });
    const publicOption = visibility.getByRole('button', { name: 'Public', exact: true });
    assert.equal(await privateOption.getAttribute('aria-pressed'), 'true');
    assert.ok((await visibility.boundingBox()).y + (await visibility.boundingBox()).height < (await page.locator('#new-topic-name').boundingBox()).y);
    await publicOption.click();
    assert.equal(await publicOption.getAttribute('aria-pressed'), 'true');
    await page.locator('#new-topic-name').fill('New public topic');
    await page.locator('#new-topic-description').fill('A new comparison.');
    await page.getByRole('button', { name: 'Publish topic' }).click();
    await page.waitForFunction(() => window.savedTopic?.ID === 2);
    assert.equal(createdDraft.isPrivate, false);
    assert.equal(visibilityWrites, 0);

    await page.locator('#edit').click();
    await visibility.locator('[aria-pressed="true"][data-visibility="private"]').waitFor();
    await page.locator('#new-topic-name').fill('Unsaved'); await publicOption.click();
    assert.equal(visibilityWrites, 0); assert.match(await page.locator('#create-topic-status').textContent(), /Save your changes/);
    await page.locator('#new-topic-name').fill('My topic'); await publicOption.click();
    await page.waitForFunction(() => window.savedTopic?.ID === 1 && window.savedTopic?.isPrivate === false);
    assert.equal(visibilityWrites, 1); assert.equal(topic.url, '/1');
    await page.locator('#edit').click();
    await visibility.locator('[aria-pressed="true"][data-visibility="public"]').waitFor();
    assert.equal(await page.locator('#topic-editor-delete').isVisible(), false);
    await privateOption.click(); await page.waitForFunction(() => window.savedTopic?.isPrivate === true);
    assert.equal(topic.url, '/private/AbCdEf123456');
    rejectPublication = true;
    await page.locator('#edit').click(); await publicOption.click();
    await page.waitForFunction(() => document.querySelector('#create-topic-status').textContent.includes('three public topics'));
    assert.equal(await page.locator('#create-topic-dialog').getAttribute('open'), '');
    assert.deepEqual(errors, []);
    console.log('Topic favorite synchronization/rollback and publication editor browser checks passed.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
