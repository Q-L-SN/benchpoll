import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const output = 'D:/Codex-artifacts/website1/ui-interactions-20261101-live';
await mkdir(output, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const reports = [];
for (const [engine, width] of [[chromium, 1440], [webkit, 390]]) {
    const browser = await engine.launch({ headless: true, ...(proxy ? { proxy: { server: proxy } } : {}) });
    const page = await browser.newPage({ viewport: { width, height: 960 }, hasTouch: width < 760, isMobile: width < 760 });
    page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
        await page.locator('.th-model-bar').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        const hero = await page.locator('#home-title').evaluate(node => ({
            phrases: [...node.children].map(child => {
                const rect = child.getBoundingClientRect(), line = parseFloat(getComputedStyle(child).lineHeight);
                return { text: child.textContent, singleLine: rect.height < line + 2, inside: rect.left >= 0 && rect.right <= innerWidth };
            }), overflow: document.documentElement.scrollWidth > innerWidth + 1
        }));
        assert.equal(hero.phrases.length, 2);
        assert.ok(hero.phrases.every(phrase => phrase.singleLine && phrase.inside), JSON.stringify(hero));
        assert.equal(hero.overflow, false);
        assert.equal(await page.locator('.th-tile-version').count(), 0);
        assert.equal(await page.locator('.th-topic-tabs button > i.fa-solid').count(), 4);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-home.png` });
        await page.locator('#topics').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.locator('#topics-view-toggle').click();
        await page.locator('.th-tile-version').first().waitFor();
        const versions = await page.locator('.th-tile-version').count();
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-weights.png` });
        await page.locator('#topics-view-toggle').click();
        assert.equal(await page.locator('.th-tile-version').count(), 0);

        await page.goto('https://benchpoll.com/multimodal-understanding', { waitUntil: 'domcontentloaded' });
        await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
        await page.locator('#bp-template-strip .bp-scene-tab').first().waitFor();
        assert.ok(await page.locator('#bp-template-strip .bp-scene-tab').count() >= 3);
        await page.locator('#bp-template-strip .bp-scene-tab').nth(1).click();
        await page.waitForFunction(() => document.querySelectorAll('#bp-template-strip .bp-scene-tab')[1]?.getAttribute('aria-selected') === 'true');
        assert.equal(await page.locator('#bp-template-strip .bp-scene-tabs').getAttribute('data-scene-animated'), 'true');
        assert.equal(await page.locator('#bp-template-strip .bp-scene-tabs').evaluate(node => getComputedStyle(node).scrollbarWidth), 'none');
        await page.locator('#workspace-refresh').click();
        await page.waitForFunction(() => document.querySelector('#workspace-update-indicator')?.dataset.phase === 'complete');
        assert.equal(await page.locator('#last-updated').isVisible(), false);
        const layout = await page.locator('#workspace-update-indicator').evaluate(node => {
            const name = node.previousElementSibling.getBoundingClientRect(), icon = node.getBoundingClientRect();
            const actions = document.querySelector('.bp-context-actions').getBoundingClientRect();
            return { nextToTopic: icon.left >= name.right && icon.left - name.right < 12,
                actionAlignment: Math.abs(actions.y + actions.height / 2 - name.y - name.height / 2),
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                color: getComputedStyle(node.querySelector('i')).color };
        });
        assert.equal(layout.nextToTopic, true, JSON.stringify(layout));
        assert.equal(layout.overflow, false);
        if (width < 760) {
            assert.ok(layout.actionAlignment <= 2, JSON.stringify(layout));
            await page.locator('[data-mobile-panel="models"]').click();
            const help = page.locator('#quick-comparison-help');
            await help.tap();
            await page.locator('#bp-help-popover').waitFor();
            await help.tap();
            await page.locator('#bp-help-popover').waitFor({ state: 'hidden' });
        }
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-workspace.png` });
        await page.waitForFunction(() => document.querySelector('#workspace-update-indicator').dataset.phase === 'idle');
        assert.deepEqual(errors, []);
        reports.push({ engine: engine.name(), width, hero, fullWeightsVersions: versions, layout, errors });
        console.log(JSON.stringify(reports.at(-1)));
    } catch (error) {
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-failure.png` }).catch(() => {});
        throw error;
    } finally { await browser.close(); }
}
await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
