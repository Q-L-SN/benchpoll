import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startProposalFixture } from './fixtures/topic-proposals-server.mjs';

const output = 'artifacts/topic-proposal-wizard-20261104';
async function setup(t, engine = 'chromium', width = 390, options = {}) {
    const site = await startProposalFixture(options);
    const browser = await ({ chromium, webkit })[engine].launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await site.close(); assert.deepEqual(errors, []); });
    await page.goto(site.url + '?parentTopicID=190');
    await page.waitForFunction(() => !document.querySelector('#proposals-account').disabled
        && document.querySelector('#proposals-list-region').getAttribute('aria-busy') === 'false');
    return { ...site, page };
}
async function open(page) {
    await page.locator('#open-proposal').click();
    await page.waitForFunction(() => !document.querySelector('#proposal-source').disabled);
}
async function choose(page, name) {
    await page.getByRole('combobox', { name: 'Your private Topic' }).click();
    await page.getByRole('option', { name, exact: true }).click();
}

for (const [engine, width] of [['chromium', 1440], ['chromium', 320], ['webkit', 390]]) {
    test(`${engine} ${width}: private source, review metadata, publish and update support reset`, async t => {
        const { page, state } = await setup(t, engine, width);
        await mkdir(output, { recursive: true });
        await open(page);
        assert.equal(await page.locator('#proposal-target, #proposal-source-refresh').count(), 0);
        assert.equal(await page.locator('#proposal-name').isVisible(), false);
        assert.equal(await page.locator('#proposal-submit').isVisible(), false);
        assert.equal(await page.locator('#proposal-next').isDisabled(), true);
        assert.deepEqual(await page.locator('#proposal-source option').evaluateAll(items => items.map(item => item.value)), ['', '501']);
        await choose(page, 'My evaluation');
        assert.equal(state.requests.some(request => request.path === '/api/propose_topic'), false);
        await page.screenshot({ path: `${output}/${engine}-${width}-source.png` });
        await page.locator('#proposal-next').click();
        assert.equal(await page.locator('#proposal-name').inputValue(), 'My evaluation');
        assert.equal(await page.locator('#proposal-description').inputValue(), 'Evaluate models for my daily work.');
        assert.equal(await page.locator('#proposal-source').isVisible(), false);
        assert.match(await page.locator('#proposal-update-notice').textContent(), /updating this proposal resets its support count to zero/);
        await page.locator('#proposal-name').fill('Everyday model evaluation');
        await page.locator('#proposal-description').fill('Compare models for everyday work.');
        await page.locator('#proposal-back').click();
        await page.waitForFunction(() => !document.querySelector('#proposal-next').disabled);
        await page.locator('#proposal-next').click();
        assert.equal(await page.locator('#proposal-name').inputValue(), 'Everyday model evaluation');
        assert.equal(await page.locator('#proposal-description').inputValue(), 'Compare models for everyday work.');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: `${output}/${engine}-${width}-review.png` });
        await page.locator('#proposal-submit').click();
        await page.waitForFunction(() => !document.querySelector('#proposal-dialog').open);
        const request = state.requests.find(request => request.path === '/api/propose_topic');
        assert.equal(request.body.sourceTopicID, 501);
        assert.equal(Object.hasOwn(request.body, 'parentTopicID'), false);
        assert.equal(request.body.name, 'Everyday model evaluation');
        assert.equal(state.topics.find(topic => topic.ID === 501).name, 'My evaluation');
        const proposal = state.proposals.find(item => item.name === request.body.name);
        proposal.supportCount = 3;
        await page.locator('#proposals-refresh').click();
        const row = page.locator(`#proposal-${proposal.proposalID}`);
        await row.getByRole('button', { name: 'Edit Everyday model evaluation' }).click();
        await page.waitForFunction(() => !document.querySelector('#proposal-next').disabled);
        await page.locator('#proposal-next').click();
        assert.match(await page.locator('#proposal-edit-notice').textContent(), /resets all supports/);
        await page.locator('#proposal-name').fill('Daily model evaluation');
        await page.locator('#proposal-submit').click();
        await page.waitForFunction(() => !document.querySelector('#proposal-dialog').open);
        assert.equal(proposal.supportCount, 0);
        assert.equal(proposal.revision, 2);
        assert.deepEqual(state.failures, []);
    });
}

test('private topics reload on open and return to the tab, with an inline retry after a failed read', async t => {
    const { page, state } = await setup(t);
    state.responses.set('/api/get_topics', [{ code: 503, body: { error: 'fixture_unavailable' } }]);
    await page.locator('#open-proposal').click();
    await page.locator('#proposal-source-status').getByRole('button', { name: 'Retry' }).click();
    await page.waitForFunction(() => !document.querySelector('#proposal-source').disabled);
    await page.locator('#proposal-cancel').click();
    state.topics.push({ ID: 502, name: 'New private topic', description: 'A new configuration.', isPrivate: true });
    await open(page);
    assert.equal(await page.locator('#proposal-source option[value="502"]').count(), 1);
    state.topics.push({ ID: 503, name: 'Edited in another tab', description: 'Another configuration.', isPrivate: true });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForSelector('#proposal-source option[value="503"]', { state: 'attached' });
    await choose(page, 'Edited in another tab');
    await page.locator('#proposal-next').click();
    assert.equal(await page.locator('#proposal-name').inputValue(), 'Edited in another tab');
    assert.equal(state.requests.some(request => request.path === '/api/propose_topic'), false);
});

test('empty and guest accounts remain at source selection with a clear next action', async t => {
    const { page, state } = await setup(t);
    state.topics = state.topics.filter(topic => !topic.isPrivate);
    await open(page);
    assert.match(await page.locator('#proposal-source-status').textContent(), /Create a private Topic/);
    assert.equal(await page.locator('#proposal-next').isDisabled(), true);
    assert.equal(await page.locator('#proposal-submit').isVisible(), false);
    await page.locator('#proposal-cancel').click();
    state.profile = null;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#proposals-account').textContent.includes('Sign in'));
    await page.locator('#open-proposal').click();
    assert.equal(await page.locator('#proposal-next').textContent(), 'Sign in to choose a Topic');
    assert.equal(await page.locator('#proposal-next').isDisabled(), false);
    assert.equal(await page.locator('#proposal-submit').isVisible(), false);
    assert.equal(state.requests.some(request => request.path === '/api/propose_topic'), false);
});
