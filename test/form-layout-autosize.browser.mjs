import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
const output = process.env.BP_FORM_ARTIFACTS ?? '/tmp/benchpoll-forms';
await mkdir(output, { recursive: true });
for (const engine of [chromium, webkit]) for (const width of [1440, 390]) {
    test(`${engine.name()} ${width}: version fields, automatic height and persistent contribution notices`, async t => {
        const fixture = await startPreview({ reviewEmailEnabled: true });
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        await page.goto(fixture.url + '/contribute/benchmarks/new');
        await page.locator('#form-surface:not([hidden])').waitFor();
        await page.getByRole('button', { name: 'Add version', exact: true }).click();
        const row = page.locator('[data-condition-key][open]'), name = row.locator('[data-condition-input]');
        const description = row.locator('[data-field="differenceExplanation"]');
        assert.equal(await name.evaluate(node => node.tagName), 'TEXTAREA');
        await page.waitForFunction(() => document.querySelector('[data-condition-key][open] textarea').style.height !== '');
        const initialHeight = (await name.boundingBox()).height;
        await name.fill('A long version name with detailed testing and coverage rules');
        await page.waitForFunction(height => document.querySelector('[data-condition-key][open] [data-condition-input]').getBoundingClientRect().height > height + 10, initialHeight);
        await description.fill('This version measures reasoning in a controlled setting.\n'.repeat(12));
        await page.waitForFunction(() => document.querySelector('[data-condition-key][open] [data-field="differenceExplanation"]').clientHeight > 250);
        const layout = await row.evaluate(node => {
            const name = node.querySelector('[data-condition-input]'), description = node.querySelector('[data-field="differenceExplanation"]');
            return { name: name.getBoundingClientRect().toJSON(), description: description.getBoundingClientRect().toJSON(),
                actions: node.querySelector('.condition-version-actions').getBoundingClientRect().toJSON(),
                deletion: node.querySelector('.condition-delete').getBoundingClientRect().toJSON(), resize: getComputedStyle(description).resize,
                contentFits: description.scrollHeight <= description.clientHeight + 1 };
        });
        assert.equal(layout.name.x, layout.description.x); assert.equal(layout.name.width, layout.description.width);
        assert.ok(layout.name.width <= 292.5);
        assert.ok(layout.actions.top >= layout.description.bottom + 8);
        assert.equal(layout.actions.x, layout.description.x);
        assert.ok(layout.deletion.x < layout.description.x + 240);
        assert.equal(layout.resize, 'none'); assert.ok(layout.contentFits);
        await name.evaluate(node => { node.value = 'Short'; });
        await description.fill('A short description.');
        await page.waitForFunction(height => document.querySelector('[data-condition-key][open] [data-condition-input]').getBoundingClientRect().height === height, initialHeight);
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-versions.png` });
        const notice = page.locator('.contribution-aa-notice');
        assert.match(await notice.textContent(), /do not submit.*Artificial Analysis \(AA\).*benchmarks or scores/s);
        assert.equal(await notice.locator('button').count(), 0);
        assert.equal(await notice.isVisible(), true);
        await page.goto(fixture.url + '/contribute/feedback');
        await page.locator('#form-surface:not([hidden])').waitFor();
        assert.equal(await notice.isVisible(), true);
        assert.match(await page.locator('.submission-email-notice').textContent(), /You will receive the review result by email/);
        const styles = await page.locator('.feedback-guidance, .submission-email-notice').evaluateAll(nodes => nodes.map(node => {
            const style = getComputedStyle(node); return [style.backgroundColor, style.borderTopWidth, style.borderTopColor, style.borderRadius];
        }));
        assert.deepEqual(styles[0], styles[1]);
        const feedback = page.locator('[data-bind="feedback"][data-field="details"]');
        await page.waitForFunction(() => document.querySelector('[data-bind="feedback"][data-field="details"]').style.height !== '');
        const min = (await feedback.boundingBox()).height;
        await feedback.fill('A feedback paragraph that wraps naturally as the form gets narrower.\n'.repeat(20));
        await page.waitForFunction(min => { const node = document.querySelector('[data-bind="feedback"][data-field="details"]'); return node.clientHeight > min + 50 && node.scrollHeight <= node.clientHeight + 1; }, min);
        await feedback.fill('');
        await page.waitForFunction(min => document.querySelector('[data-bind="feedback"][data-field="details"]').getBoundingClientRect().height <= min + 2, min);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    });
}
