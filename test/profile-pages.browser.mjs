import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startProfilePagesFixture } from './fixtures/profile-pages-server.mjs';

const output = resolve(process.env.PROFILE_PAGES_OUTPUT || '/workspace/benchpoll-work/artifacts/profiles');
await mkdir(output, { recursive: true });
const fixture = await startProfilePagesFixture();
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || (existsSync(chromium.executablePath()) ? undefined : '/usr/bin/chromium');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('https://**/*', route => route.abort());
try {
    await page.goto(fixture.origin + '/me');
    await page.getByRole('tab', { name: 'Topics I created', selected: true }).waitFor();
    await page.getByRole('link', { name: 'Private notebook' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Private notebook' }).getAttribute('href'), '/private/OwnerDraft1234');
    assert.equal(await page.getByRole('img', { name: 'Private topic' }).count(), 1);
    await page.getByRole('link', { name: 'Research', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Avery Chen' }).waitFor();
    assert.equal(await page.locator('.pf-own-actions').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    assert.equal(await page.getByRole('link', { name: 'Settings', exact: true }).getAttribute('href'), '/settings');
    assert.equal(await page.getByRole('link', { name: 'History', exact: true }).getAttribute('href'), '/me/history');
    await page.getByRole('tab', { name: 'Favorited topics, only you' }).click();
    assert.equal(await page.locator('.bp-profile-topic-card').count(), 2);
    assert.equal(await page.locator('.bp-profile-topic-card').first().getByRole('link', { name: 'Report this topic' }).count(), 0);
    assert.equal(await page.locator('.bp-profile-topic-card').nth(1).getByRole('link', { name: 'Sam Rivera' }).getAttribute('href'), '/@2');
    const favorite = page.locator('.bp-profile-topic-card').first().getByRole('button', { name: /Remove favorite/ });
    const language = page.getByRole('link', { name: 'Language', exact: true });
    let capture;
    const attempt = new Promise(resolve => { capture = resolve; });
    await page.route('**/api/set_topic_favorite', route => { capture(route); });
    await favorite.click();
    const withheld = await attempt;
    await language.waitFor({ state: 'hidden' });
    await withheld.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    await language.waitFor();
    await page.locator('.bp-toast.is-visible').getByText(/Could not update your favorites/).waitFor();
    await page.unroute('**/api/set_topic_favorite');
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/set_topic_favorite') && response.ok()), favorite.click()]);
    await language.waitFor({ state: 'hidden' });
    await page.screenshot({ path: output + '/profile-desktop.png', fullPage: true });
    const remainingCard = page.locator('.bp-profile-topic-card').first();
    const topicURL = await remainingCard.locator('h2 a').getAttribute('href');
    await Promise.all([
        page.waitForURL(fixture.origin + topicURL),
        remainingCard.click({ position: { x: 8, y: 8 } })
    ]);
    await page.goto(fixture.origin + '/me');

    const create = page.getByRole('button', { name: 'Create topic', exact: true });
    const editor = page.getByRole('dialog', { name: 'New topic', exact: true });
    const publicOption = editor.getByRole('button', { name: 'Public', exact: true });
    const privateOption = editor.getByRole('button', { name: 'Private', exact: true });
    for (const name of ['Topics I created', 'Favorited topics, only you', 'Configured topics, only you', 'Discussion']) {
        await page.getByRole('tab', { name, exact: true }).click();
        assert.equal(await create.isVisible(), true);
        assert.equal(await page.getByRole('tabpanel').getByRole('button', { name: 'Create topic', exact: true }).count(), 0);
    }
    await create.click();
    await publicOption.click();
    await editor.getByLabel('Name', { exact: true }).fill('Open evaluation');
    await editor.getByLabel('One-sentence summary').fill('Compare practical evaluations.');
    await editor.getByRole('button', { name: 'Add scene' }).click();
    await editor.getByRole('textbox', { name: 'Scene name 1' }).fill('General');
    await editor.getByRole('button', { name: 'Publish topic' }).click();
    await page.getByRole('tab', { name: 'Topics I created', selected: true }).waitFor();
    const openEvaluation = page.getByRole('link', { name: 'Open evaluation', exact: true });
    assert.match(await openEvaluation.getAttribute('href'), /^\/\d+$/);
    assert.equal(fixture.state.created[0].topic.scenes[0].name, 'General');

    await page.setViewportSize({ width: 320, height: 760 });
    await page.getByRole('tab', { name: 'Configured topics, only you' }).click();
    await create.click();
    assert.equal(await privateOption.getAttribute('aria-pressed'), 'true');
    assert.ok(await editor.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({ path: output + '/profile-create-mobile.png', fullPage: true });
    await publicOption.click();
    await editor.getByLabel('Name', { exact: true }).fill('Second open evaluation');
    await editor.getByLabel('One-sentence summary').fill('Review another public evaluation.');
    await editor.getByRole('button', { name: 'Publish topic' }).click();
    await editor.waitFor({ state: 'hidden' });
    await create.click();
    await publicOption.click();
    await editor.getByLabel('Name', { exact: true }).fill('Personal evaluation');
    await editor.getByLabel('One-sentence summary').fill('Keep these evaluation weights personal.');
    await editor.getByRole('button', { name: 'Publish topic' }).click();
    await editor.getByText(/You can have up to three public topics at a time/).waitFor();
    assert.equal(fixture.state.created.length, 2);
    assert.equal(await editor.getByLabel('Name', { exact: true }).inputValue(), 'Personal evaluation');
    assert.equal(await editor.getByLabel('One-sentence summary').inputValue(), 'Keep these evaluation weights personal.');
    await privateOption.click();
    await editor.getByRole('button', { name: 'Create private topic' }).click();
    await editor.waitFor({ state: 'hidden' });
    assert.match(await page.getByRole('link', { name: 'Personal evaluation', exact: true }).getAttribute('href'), /^\/private\//);
    assert.deepEqual(fixture.state.requests.filter(request => request.path === '/save_private_topic').map(request => request.body.isPrivate),
        [false, false, false, true]);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(fixture.origin + '/settings');
    await page.getByLabel('User ID', { exact: true }).waitFor();
    for (const section of ['profile', 'privacy', 'delete-account', 'logout']) {
        assert.equal((await page.request.get(fixture.origin + '/settings/' + section)).status(), 404);
    }
    await page.getByLabel('Avatar', { exact: true }).setInputFiles({ name: 'image.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await page.getByText('Choose a valid PNG, JPEG or WebP image.').waitFor();
    const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d'); context.fillStyle = '#7d9272'; context.fillRect(0, 0, 64, 64);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByLabel('Avatar', { exact: true }).setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.locator('.pf-avatar img').waitFor();
    await page.getByLabel('User ID', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await page.getByText('That user ID is already taken. Choose another.').waitFor();
    assert.equal(await page.getByLabel('User ID', { exact: true }).inputValue(), '2');
    await page.getByLabel('User ID', { exact: true }).fill('Avery');
    await page.getByLabel('Bio', { exact: true }).fill('<img src=x onerror="window.profileXSS=1">\nI compare models.');
    await page.getByRole('switch', { name: 'Show GitHub profile link' }).check();
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await page.getByText('Profile saved.', { exact: true }).waitFor();
    assert.equal(fixture.state.profiles.get('10').hasCustomAvatar, 1);
    await page.goto(fixture.origin + '/me');
    await page.locator('.pf-handle').filter({ hasText: '@avery' }).waitFor();
    assert.equal(await page.locator('.pf-bio img').count(), 0);
    assert.equal(await page.evaluate(() => window.profileXSS), undefined);
    assert.equal(await page.getByRole('link', { name: 'GitHub', exact: true }).getAttribute('href'), 'https://github.com/avery-fixture');

    await page.goto(fixture.origin + '/settings');
    await page.getByRole('tab', { name: 'Privacy', exact: true }).click();
    await page.getByRole('switch', { name: 'Publish my favorites' }).check();
    await page.getByRole('button', { name: 'Save privacy settings' }).click();
    await page.getByText('Privacy settings saved.', { exact: true }).waitFor();
    fixture.state.viewerID = null;
    await page.goto(fixture.origin + '/@avery?tab=created');
    await page.getByRole('heading', { name: 'Avery Chen' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Published topics', selected: true }).count(), 1);
    await page.getByRole('link', { name: 'Research', exact: true }).waitFor();
    await openEvaluation.waitFor();
    assert.equal(await page.getByRole('link', { name: 'Private notebook' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Personal evaluation' }).count(), 0);
    assert.equal(await create.count(), 0);
    assert.equal(await page.getByRole('tab').count(), 3);
    assert.equal(await page.getByRole('tab', { name: 'Discussion', exact: true }).count(), 1);
    assert.equal(await page.getByRole('tab', { name: 'Configured topics' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Settings', exact: true }).count(), 0);
    await page.getByRole('tab', { name: 'Favorited topics', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 760 });
    await page.screenshot({ path: output + '/profile-mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    fixture.state.viewerID = '10';
    await page.goto(fixture.origin + '/settings');
    await page.getByLabel('User ID', { exact: true }).waitFor();
    assert.equal(page.url(), fixture.origin + '/settings');
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), 'Profile');
    const settingsDocument = await page.evaluateHandle(() => document);
    await page.getByLabel('Bio', { exact: true }).fill('An unsaved draft');
    for (const name of ['Privacy', 'Delete account', 'Log out', 'Profile']) {
        await page.getByRole('tab', { name, exact: true }).click();
        assert.equal(await page.getByRole('tabpanel', { name, exact: true }).isVisible(), true);
        assert.equal(page.url(), fixture.origin + '/settings');
        assert.ok(await page.evaluate(previous => previous === document, settingsDocument));
    }
    assert.equal(await page.getByLabel('Bio', { exact: true }).inputValue(), 'An unsaved draft');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: output + '/settings-mobile.png', fullPage: true });
    await page.goto(fixture.origin + '/me/history');
    await page.getByRole('link', { name: 'Coding / Python', exact: true }).waitFor();
    assert.equal(await page.locator('#history-list li').count(), 2);
    await page.getByRole('button', { name: 'Clear browsing history' }).click();
    await page.getByText('Browsing history cleared.', { exact: true }).waitFor();
    assert.equal(await page.locator('#history-list li').count(), 0);

    await page.goto(fixture.origin + '/settings');
    await page.getByRole('tab', { name: 'Privacy', exact: true }).click();
    await page.getByRole('switch', { name: 'Publish my favorites' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'user-profile-update', newValue: 'null' })));
    assert.equal(await page.getByRole('button', { name: 'Save privacy settings' }).isDisabled(), true);
    await page.goto(fixture.origin + '/me');
    await page.getByRole('tab', { name: 'Configured topics, only you' }).click();
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'user-profile-update', newValue: 'null' })));
    assert.equal(await page.locator('.bp-profile-topic-card').count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, screenshots: output, checks: ['self/public privacy', 'public/private creation across tabs', 'publication cap and draft retry', 'unique IDs', 'plain-text bio', 'separate GitHub link', 'favorite action', 'private history', 'account changes', '320px overflow'] }));
} finally { await browser.close(); await fixture.close(); }
