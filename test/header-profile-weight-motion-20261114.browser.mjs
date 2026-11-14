import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = process.env.BP_HEADER_OUTPUT ?? '/workspace/benchpoll-work/header-profile-20261114';
await mkdir(output, { recursive: true });
async function settle(page) {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
    });
}

for (const engine of [webkit, chromium]) {
    test(`${engine.name()} profile priority, desktop previews and responsive homepage ${built ? 'built' : 'source'}`, async t => {
        const fixture = await startTopicsPreview({ built });
        const coding = fixture.state.topics.find(topic => topic.ID === 1);
        Object.assign(coding, { configured: true, configuredContextIDs: [102], scenes: [
            { ID: 101, sceneNumber: 1, name: 'General', isDefault: true, url: '/2/1' },
            { ID: 102, sceneNumber: 2, name: 'Python', url: '/2/2' },
            ...Array.from({ length: 9 }, (_, i) => ({ ID: 103 + i, sceneNumber: 3 + i, name: `Language ${i + 1}`, url: `/2/${i + 3}` }))
        ] });
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        await page.goto(fixture.url);
        await page.locator('#topic-card-1').waitFor();
        await page.locator('#topics-account[href="/me"]').waitFor(); await settle(page);
        assert.equal(await page.locator('.th-card .bp-topic-report').count(), 0);
        assert.equal(await page.locator('#topic-card-1 .bp-topic-favorite').evaluate(node => getComputedStyle(node).fontSize), '14px');
        assert.equal(await page.locator('#topic-card-1 .bp-topic-configured-dot').evaluate(node => node.getBoundingClientRect().width), 8);
        assert.equal(await page.locator('[data-topics-view]').count(), 0);
        assert.equal(await page.locator('#topics-label').isVisible(), false);
        await page.locator('#topic-search-toggle').click();
        await page.locator('#topic-search').fill('Python');
        assert.equal(await page.locator('#topic-card-1').isVisible(), true);
        assert.equal(await page.locator('#topic-card-54').isVisible(), false);
        await page.locator('#topic-search-toggle').click();
        assert.equal(await page.locator('#topic-card-54').isVisible(), true);

        const preview = page.locator('#topics-account-preview');
        await page.locator('#topics-account').hover(); await preview.waitFor();
        assert.deepEqual(await preview.locator('h2').allTextContents(), ['Favorites', 'Configured']);
        assert.equal(await preview.locator('a[href="/2/2?mode=personal"]').innerText(), 'Coding › Python');
        assert.doesNotMatch(await preview.innerText(), /Settings|Published|History/);
        await preview.locator('a').first().hover();
        await page.waitForTimeout(220);
        assert.equal(await preview.isVisible(), true, 'The pointer can enter the preview across the gap');
        await page.mouse.move(10, 500);
        await preview.waitFor({ state: 'hidden' });
        await page.locator('#topics-account').focus(); await page.keyboard.press('ArrowDown');
        assert.equal(await preview.evaluate(node => node.contains(document.activeElement)), true);
        await page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#topics-account').evaluate(node => node === document.activeElement), true);

        for (const width of [1440, 1024, 768, 390, 360, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => { scrollTo(0, 420); dispatchEvent(new Event('scroll')); }); await settle(page);
            const layout = await page.evaluate(() => {
                const account = document.querySelector('#topics-account'), label = document.querySelector('#topics-label');
                return { profileInHeader: account.parentElement.classList.contains('th-header-links'),
                    overflow: document.documentElement.scrollWidth - innerWidth,
                    headerOverflow: document.querySelector('.th-header-inner').scrollWidth - document.querySelector('.th-header-inner').clientWidth,
                    labelColor: getComputedStyle(label).color,
                    searchAfter: label.nextElementSibling.id === 'topic-search-toggle',
                    moreActions: [...document.querySelectorAll('#topics-more nav > .th-quiet')].map(node => node.textContent.trim()) };
            });
            assert.equal(layout.profileInHeader, true, `${width}px profile priority: ${JSON.stringify(layout)}`);
            assert.ok(layout.overflow <= 1 && layout.headerOverflow <= 1, JSON.stringify({ width, ...layout }));
            assert.equal(layout.searchAfter, true);
            assert.equal(await page.locator('#topics-label').isVisible(), true);
            if (width <= 390) assert.ok(layout.moreActions.includes('Create topic'));
            await page.screenshot({ path: `${output}/${engine.name()}-header-${width}-${built ? 'built' : 'source'}.png` });
        }
        await page.setViewportSize({ width: 1440, height: 900 }); await settle(page);
        await page.locator('#topics-account').hover(); await preview.waitFor();
        fixture.state.authenticated = false;
        await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'user-profile-update', newValue: null })));
        await page.locator('#topics-account[href="/login"]').waitFor(); await settle(page);
        assert.equal(await page.locator('#topics-account-preview a').count(), 0);

        const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        fixture.state.authenticated = true;
        await phone.goto(fixture.url); await phone.locator('#topics-account[href="/me"]').waitFor(); await settle(phone);
        await phone.locator('#topics-account').focus();
        assert.equal(await phone.locator('#topics-account-preview').isVisible(), false, 'Touch keeps direct profile navigation');
        assert.equal(await phone.locator('#topics-account').getAttribute('href'), '/me');
        for (const target of [page, phone]) {
            await target.locator('#topic-card-2').scrollIntoViewIfNeeded();
            await target.locator('#topic-card-2 .th-model-score.is-outside').first().waitFor();
            const scores = await target.locator('#topic-card-2 .th-model-score.is-outside').evaluateAll(nodes => nodes.map(node => {
                const label = node.getBoundingClientRect(), bar = node.parentElement.querySelector('.th-model-bar').getBoundingClientRect();
                return { offset: Math.abs(label.left + label.width / 2 - (bar.left + bar.width / 2)), gap: bar.top - label.bottom };
            }));
            assert.ok(scores.length > 0 && scores.every(score => score.offset < 1 && score.gap >= 2), JSON.stringify(scores));
            await target.screenshot({ path: `${output}/${engine.name()}-low-scores-${target === phone ? 'mobile' : 'desktop'}-${built ? 'built' : 'source'}.png` });
            await target.locator('#topic-card-1 .th-scene-toggle').click();
            await target.locator('#topic-scenes-dialog[open]').waitFor();
            const grid = target.locator('#topic-scenes-grid');
            for (const progress of [0, .4, 1]) {
                await grid.evaluate((node, progress) => { node.scrollTop = progress * (node.scrollHeight - node.clientHeight); }, progress);
                await settle(target);
                const lane = await grid.evaluate(node => {
                    const bounds = node.getBoundingClientRect(), edge = bounds.left + node.clientWidth;
                    const visible = [...node.children].map(card => card.getBoundingClientRect())
                        .filter(box => box.bottom > bounds.top && box.top < bounds.bottom);
                    return { overflow: node.scrollWidth > node.clientWidth, count: visible.length,
                        clearance: Math.min(...visible.map(box => edge - box.right)),
                        hitCards: visible.some(box => document.elementFromPoint(edge - 3, Math.max(bounds.top + 2, Math.min(bounds.bottom - 2, (box.top + box.bottom) / 2)))?.closest('.th-card')) };
                });
                assert.ok(lane.count > 0 && lane.clearance >= 11, JSON.stringify(lane));
                assert.equal(lane.overflow, false); assert.equal(lane.hitCards, false, 'Every card leaves the scrollbar lane unobstructed');
            }
            await target.screenshot({ path: `${output}/${engine.name()}-scenes-${target === phone ? 'mobile' : 'desktop'}-${built ? 'built' : 'source'}.png` });
            await target.locator('#topic-scenes-close').click();
        }
        if (!await phone.locator('#new-private-topic').isVisible()) await phone.locator('#topics-more summary').click();
        await phone.locator('#new-private-topic').click();
        await phone.locator('#new-topic-name').fill('My scene collection');
        await phone.locator('#new-topic-description').fill('One shared summary for every scene.');
        await phone.locator('#topic-editor-add-scene').click();
        assert.equal(await phone.locator('.bp-topic-scene-fields input').count(), 1);
        await phone.locator('.bp-topic-scene-fields input').fill('General');
        await phone.locator('#create-topic-submit').click();
        await phone.locator('#create-topic-dialog').waitFor({ state: 'hidden' });
        const saved = fixture.state.requests.findLast(request => request.path === '/api/save_private_topic').body;
        assert.equal(saved.description, 'One shared summary for every scene.');
        assert.deepEqual(Object.keys(saved.scenes[0]).sort(), ['ID', 'key', 'name']);
    });

    test(`${engine.name()} stable weight labels, CTA phrase and mobile chart actions ${built ? 'built' : 'source'}`, async t => {
        const fixture = await startPreview({ communityVersions: true, personalEntries: [] });
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        if (built) await page.route(url => url.origin === fixture.url && url.pathname === '/1', async route => route.fulfill({
            contentType: 'text/html', body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8')
        }));
        await page.goto(fixture.url); await page.locator('#benchmark-card[aria-busy="false"]').waitFor(); await settle(page);
        assert.equal(await page.locator('#workspace-topic-creator .bp-topic-report').isVisible(), true);
        for (const width of [320, 390]) {
            await page.setViewportSize({ width, height: 844 }); await settle(page);
            const phrase = await page.locator('.bp-keep-together').evaluate(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                return { lines: range.getClientRects().length, overflow: document.documentElement.scrollWidth - innerWidth };
            });
            assert.equal(phrase.lines, 1); assert.ok(phrase.overflow <= 1);
        }
        await page.locator('#personal-pie-create').click();
        await page.locator('#personal-pie-start-public').click(); await settle(page);
        await page.waitForFunction(() => document.querySelector('#model-card').getAttribute('aria-busy') === 'false');
        for (const mode of ['public', 'personal']) {
            // Fonts can still be loading in Safari; keep this real asynchronous dependency pending.
            await page.evaluate(() => Object.defineProperty(document.fonts, 'ready', { configurable: true,
                value: new Promise(resolve => { window.releaseModeFonts = resolve; }) }));
            await page.locator(`#pie-mode-${mode}`).click();
            await page.waitForFunction(mode => document.querySelector(`#pie-mode-${mode}`).getAttribute('aria-busy') === 'true', mode);
            const before = await page.locator(`#pie-mode-${mode}`).evaluate(button => {
                const label = button.querySelector('.bp-pie-mode-label'), style = getComputedStyle(label);
                return { opacity: style.opacity, visibility: style.visibility, rect: label.getBoundingClientRect().toJSON(),
                    spinner: !button.querySelector('.bp-pie-mode-loading').hidden };
            });
            assert.equal(before.opacity, '1'); assert.equal(before.visibility, 'visible'); assert.equal(before.spinner, true);
            const frames = await page.evaluate(async mode => {
                const samples = []; window.releaseModeFonts();
                for (let i = 0; i < 22; i++) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    const label = document.querySelector(`#pie-mode-${mode} .bp-pie-mode-label`);
                    samples.push({ opacity: getComputedStyle(label).opacity, width: label.getBoundingClientRect().width });
                }
                return samples;
            }, mode);
            assert.ok(frames.every(frame => frame.opacity === '1' && Math.abs(frame.width - before.rect.width) < 1), JSON.stringify(frames));
            await settle(page);
        }
        const spacing = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            const heading = rect('.bp-page-heading'), actions = rect('.bp-context-row'), card = rect('#pie-card'),
                mode = rect('.bp-mode-switch'), tools = rect('.bp-pie-tools');
            const top = Math.min(...[...document.querySelectorAll('#weight-pie .bp-weight-tile')].map(tile => tile.getBoundingClientRect().top));
            return { headerAbove: actions.top - heading.bottom, headerBelow: card.top - actions.bottom,
                chartAbove: tools.top - mode.bottom, chartBelow: top - tools.bottom };
        });
        assert.ok(Math.abs(spacing.headerAbove - spacing.headerBelow) < 1 && spacing.headerAbove <= 4, JSON.stringify(spacing));
        assert.ok(Math.abs(spacing.chartAbove - spacing.chartBelow) < 1 && spacing.chartAbove <= 6, JSON.stringify(spacing));
        for (const name of ['models', 'discussion', 'mix']) {
            const samples = await page.evaluate(async name => {
                document.querySelector(`button[data-mobile-panel="${name}"]`).click();
                const values = [];
                for (let i = 0; i < 35; i++) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    values.push(...[...document.querySelectorAll('#workspace-undo, #workspace-reset')].map(node => ({
                        width: node.getBoundingClientRect().width, opacity: Number(getComputedStyle(node).opacity), disabled: node.disabled
                    })));
                }
                return values;
            }, name);
            assert.ok(samples.every(value => value.width === 44 && Math.abs(value.opacity - (value.disabled ? .4 : 1)) < .001));
        }
        const dock = page.locator('.bp-mobile-panels');
        const bounds = await dock.boundingBox(), step = (bounds.width - 10) / 3;
        const center = { x: bounds.x + 5 + step / 2, y: bounds.y + bounds.height / 2 };
        const originalLabels = await dock.locator('button').evaluateAll(nodes => nodes.map(node => ({
            text: node.textContent, x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width
        })));
        await page.mouse.move(center.x, center.y); await page.mouse.down();
        await page.waitForFunction(() => Math.abs(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.bp-mobile-panel-thumb'), '::before').transform).a - 1.08) < .002);
        await page.mouse.move(center.x + step * .5, center.y, { steps: 8 });
        const partial = await dock.evaluate(node => {
            const pager = document.querySelector('#workspace-scene-panel');
            const buttons = [...node.querySelectorAll('button')], labels = [...node.querySelectorAll('[data-mobile-panel-label]')];
            return { progress: pager.scrollLeft / pager.clientWidth,
                clip: getComputedStyle(node.querySelector('.bp-mobile-panel-emphasis')).clipPath,
                labels: labels.map((label, i) => ({ text: label.textContent,
                    offset: label.getBoundingClientRect().x - buttons[i].getBoundingClientRect().x,
                    widthDifference: label.getBoundingClientRect().width - buttons[i].getBoundingClientRect().width })),
                buttons: buttons.map(button => ({ text: button.textContent, x: button.getBoundingClientRect().x, width: button.getBoundingClientRect().width })) };
        });
        assert.ok(Math.abs(partial.progress - .5) < .03, JSON.stringify(partial));
        assert.deepEqual(partial.buttons, originalLabels, 'Dragging does not move or replace the fixed labels');
        assert.ok(partial.labels.every(label => Math.abs(label.offset) < .5 && Math.abs(label.widthDifference) < .5));
        assert.match(partial.clip, /^inset\(/);
        await page.screenshot({ path: `${output}/${engine.name()}-dock-mid-drag-${built ? 'built' : 'source'}.png` });
        await page.mouse.move(center.x + step * .65, center.y); await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.mobilePanel === 'models'
            && Math.abs(document.querySelector('#workspace-scene-panel').scrollLeft / document.querySelector('#workspace-scene-panel').clientWidth - 1) < .01);
        await dock.evaluate(node => node.addEventListener('pointerdown', event => { window.testDockPointerID = event.pointerId; }, { once: true }));
        await page.mouse.move(center.x + step, center.y); await page.mouse.down();
        await page.mouse.move(center.x + step * 1.65, center.y, { steps: 8 });
        await dock.evaluate(node => node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.testDockPointerID })));
        await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.mobilePanel === 'models'
            && !document.querySelector('.bp-mobile-panels').classList.contains('is-pressed')
            && Math.abs(document.querySelector('#workspace-scene-panel').scrollLeft / document.querySelector('#workspace-scene-panel').clientWidth - 1) < .01);
        await dock.locator('button').first().focus(); await page.keyboard.press('Home');
        await page.waitForFunction(() => document.querySelector('#workspace-scene-panel').scrollLeft < 1);
        if (engine === chromium) {
            const cdp = await page.context().newCDPSession(page);
            const touch = (type, distance = 0) => cdp.send('Input.dispatchTouchEvent', { type,
                touchPoints: type === 'touchEnd' ? [] : [{ x: center.x + distance, y: center.y, id: 1 }] });
            await touch('touchStart');
            for (let i = 1; i <= 8; i++) await touch('touchMove', step * 1.3 * i / 8);
            assert.equal(await dock.evaluate(node => node.classList.contains('is-dragging')), true);
            await touch('touchEnd');
            await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.mobilePanel === 'models'
                && Math.abs(document.querySelector('#workspace-scene-panel').scrollLeft / document.querySelector('#workspace-scene-panel').clientWidth - 1) < .01);
            await cdp.detach();
        } else {
            await page.touchscreen.tap(center.x + step * 2, center.y);
            await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.mobilePanel === 'discussion'
                && Math.abs(document.querySelector('#workspace-scene-panel').scrollLeft / document.querySelector('#workspace-scene-panel').clientWidth - 2) < .01);
        }
        await page.screenshot({ path: `${output}/${engine.name()}-weights-${built ? 'built' : 'source'}.png` });
    });
}
