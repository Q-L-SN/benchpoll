import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries, weightedEntries } from './fixtures.mjs';

const output = process.env.FALLBACK_APPEARANCE_TEST_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/fixed-appearance-20261015/rail';
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const reports = [];
const rule = { primaryConditionID: 1, familyID: 701, mode: 'ordered',
    entries: familyEntries([{ conditionID: 2 }, { conditionID: 3 }, { kind: 'other_versions' }, { conditionID: 4 }]) };
for (const entry of rule.entries) if (!entry.kind) {
    entry.conditionKey = 'v2-offline-evaluation'; entry.conditionName = 'v2 offline evaluation'; entry.isDefaultCondition = false;
}

async function assertNameAlignment(scope) {
    await scope.page().waitForFunction(() => [...document.querySelectorAll('.bp-fallback-chain > .bp-fallback-chain-step')]
        .filter(row => row.getBoundingClientRect().height > 0).every(row => row.style.getPropertyValue('--bp-chain-node-y')),
        null, { timeout: 1500 }).catch(() => {});
    const positions = await scope.locator('.bp-fallback-chain-step').evaluateAll(rows => rows.filter(row => row.getBoundingClientRect().height > 0).map(row => {
        const name = row.querySelector('.bp-benchmark-link-name, .bp-auto-version-label strong')
            ?? row.querySelector('.bp-benchmark-information-link') ?? row.firstElementChild;
        const range = document.createRange(); range.selectNodeContents(name);
        const text = [...range.getClientRects()].find(box => box.width > 0 && box.height > 0);
        const box = row.getBoundingClientRect(), dot = getComputedStyle(row, '::after');
        return { name: name.textContent, nodeY: parseFloat(dot.top), nameY: text.top + text.height / 2 - box.top,
            rowY: box.height / 2, lineTop: getComputedStyle(row, '::before').top, lineBottom: getComputedStyle(row, '::before').bottom,
            height: box.height };
    }));
    assert.ok(positions.length > 0);
    for (const position of positions) assert.ok(Math.abs(position.nodeY - position.nameY) < 1.1,
        `Node must align with the first name line: ${JSON.stringify(position)}`);
    const last = positions.at(-1);
    assert.ok(Math.abs(last.height - parseFloat(last.lineBottom) - last.nameY) < 1.1, 'The last line ends at its name node');
    if (!await scope.evaluate(node => node.classList.contains('bp-family-chain')))
        assert.ok(Math.abs(parseFloat(positions[0].lineTop) - positions[0].nameY) < 1.1, 'The first line starts at its name node');
    return positions;
}

async function inspectWrappedNames(page) {
    await page.evaluate(async () => {
        const { createBenchmarkInformationLink } = await import('/js/workspace/benchmark-link.js');
        const host = document.createElement('section'); host.id = 'alignment-fixtures'; host.hidden = true;
        host.style.cssText = 'position:fixed;left:8px;top:150px;width:250px;z-index:20000;background:white;padding:12px';
        for (const className of ['bp-model-fallback-path', 'bp-version-priority-list']) {
            const list = document.createElement('ol'); list.className = `${className} bp-fallback-chain`;
            for (const index of [0, 1]) {
                const row = document.createElement('li'); row.className = 'bp-fallback-chain-step';
                const member = { name: 'A benchmark name deliberately long enough to wrap to another line', conditionName: 'v2 offline partial accuracy',
                    conditionID: 9100 + index, isDefaultCondition: false };
                row.append(createBenchmarkInformationLink(member, { getURL: () => '#',
                    ...(className === 'bp-version-priority-list' ? { label: 'A long benchmark version label wrapping over several lines' } : {}) }));
                const status = document.createElement('small'); status.textContent = className === 'bp-version-priority-list' ? '45%' : 'Used';
                row.append(status); list.append(row);
            }
            host.append(list);
        }
        document.body.append(host);
    });
    await page.waitForTimeout(50);
    await page.locator('#alignment-fixtures').evaluate(host => { host.hidden = false; });
    const results = [];
    {
        const style = 'rail';
        for (const className of ['bp-model-fallback-path', 'bp-version-priority-list']) {
            const nodes = await assertNameAlignment(page.locator(`#alignment-fixtures .${className}`));
            assert.ok(nodes.every(node => Math.abs(node.nodeY - node.rowY) > 8), 'A multi-line identity must not pull the node to the row center');
            results.push({ style, className, nodes });
        }
    }
    await page.locator('#alignment-fixtures').screenshot({ path: join(output, `wrapped-${page.viewportSize().width}.png`) });
    await page.locator('#alignment-fixtures').evaluate(host => host.remove());
    return results;
}
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    const label = `${engine}-${width}${builtRoot ? '-built' : ''}`;
    const app = await startPreview({ fallbackRules: [structuredClone(rule)], families: [rule],
        personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 6, weightBasisPoints: 4000 }]) });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const writes = () => app.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
    const ready = () => page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready'
        && document.querySelectorAll('.bp-model-row').length > 0);
    try {
        if (builtHTML || engine === 'webkit') await page.route(`${app.url}/**`, async route => {
            const path = new URL(route.request().url()).pathname;
            if (builtHTML && route.request().resourceType() === 'document') return route.fulfill({ body: builtHTML, contentType: 'text/html' });
            if (builtHTML && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))),
                contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            if (engine === 'webkit') { const response = await route.fetch(); return route.fulfill({ response, body: await response.body() }); }
            return route.fallback();
        });
        await context.addInitScript(() => {
            localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            localStorage.setItem('benchpoll-fallback-appearance-v1', 'flow');
            localStorage.setItem('benchpoll-score-bar-colors-v1', 'uniform');
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', scoreMode: 'available', personalFallbackExpanded: true }));
        });
        await page.goto(app.url); await ready(); await page.evaluate(() => document.fonts.ready);
        const snapshot = structuredClone(app.state.fallbackRules), initialWrites = writes();
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        if (await page.locator('#pie-adjustment-dismiss').isVisible()) await page.locator('#pie-adjustment-dismiss').click();
        await page.locator('#inline-fallback-preview').waitFor();
        const styles = [];
        assert.equal(await page.getByRole('combobox', { name: 'Fallback chain style' }).count(), 0);
        assert.equal(await page.locator('.bp-fallback-style-control, .bp-score-colors-toggle').count(), 0);
        {
            const key = 'rail';
            await page.locator('#inline-fallback-edit').click();
            const editor = page.locator('#inline-fallback-chart .bp-family-chain');
            const geometry = await editor.evaluate(list => {
                const row = list.querySelector('.bp-family-member'), frame = list.closest('.bp-inline-fallback-chart').getBoundingClientRect();
                const dot = getComputedStyle(row, '::after'), line = getComputedStyle(row, '::before');
                const drag = row.querySelector('.bp-family-drag').getBoundingClientRect();
                const name = row.querySelector('.bp-benchmark-link-name').getBoundingClientRect();
                return { width: dot.width, height: dot.height, radius: dot.borderRadius, top: line.top,
                    inset: row.getBoundingClientRect().left + parseFloat(dot.left) - frame.left,
                    dragGap: row.getBoundingClientRect().left + parseFloat(dot.left) - drag.right,
                    nameGap: name.left - row.getBoundingClientRect().left - parseFloat(dot.left) - parseFloat(dot.width),
                    framePadding: getComputedStyle(list.closest('.bp-inline-fallback-chart')).paddingLeft,
                    actionsBelow: row.querySelector('.bp-family-actions').getBoundingClientRect().top > name.bottom,
                    overflow: [...list.querySelectorAll('.bp-family-member')].some(item => item.scrollWidth > item.clientWidth + 1),
                    identity: getComputedStyle(row.querySelector('.bp-family-member-name')).display,
                    rowHeight: row.getBoundingClientRect().height };
            });
            assert.equal(geometry.top, '0px', 'Every first normal fallback has an upward connection');
            assert.ok(geometry.inset >= 20, JSON.stringify(geometry));
            assert.ok(geometry.dragGap >= 4 && geometry.dragGap <= 10, JSON.stringify(geometry));
            assert.ok(geometry.nameGap >= 4 && geometry.nameGap <= 10, JSON.stringify(geometry));
            assert.equal(geometry.framePadding, '8px');
            assert.equal(geometry.actionsBelow, false);
            assert.equal(geometry.overflow, false, JSON.stringify(geometry));
            assert.deepEqual([geometry.width, geometry.height], ['8px', '8px']);
            assert.equal(await editor.locator('a').count(), 0);
            assert.equal(await editor.locator('.bp-family-attachment .fa-link').count(), 1);
            geometry.nodes = await assertNameAlignment(editor);
            await page.locator('#inline-fallback-settings').screenshot({ path: join(output, `${label}-${key}-editing.png`) });
            await page.locator('#inline-fallback-done').click();
            assert.equal(await page.locator('#inline-fallback-preview a').count(), 0);
            assert.equal(await page.locator('#inline-fallback-entrance a').count(), 0);
            geometry.previewNodes = await assertNameAlignment(page.locator('#inline-fallback-preview .bp-family-chain'));
            if (width > 760) {
                const name = page.locator('#inline-fallback-preview .bp-benchmark-link-name').first();
                await name.hover();
                assert.equal(await name.evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
            }
            await page.locator('#inline-fallback-settings').screenshot({ path: join(output, `${label}-${key}-browsing.png`) });
            styles.push({ key, geometry });
        }
        const wrappedNames = await inspectWrappedNames(page);
        await page.locator('#inline-fallback-preview').press('Enter');
        const picker = page.locator('#fallback-picker'); await picker.waitFor();
        assert.equal(await picker.getByRole('combobox', { name: 'Fallback chain style' }).count(), 0);
        assert.equal(await picker.locator('.bp-fallback-picker-steps').first().locator('li').first().evaluate(node => getComputedStyle(node, '::after').height), '8px');
        await assertNameAlignment(picker.locator('.bp-fallback-picker-steps').first());
        await page.screenshot({ path: join(output, `${label}-chooser.png`) });
        await picker.locator('.bp-fallback-picker-cancel').click();
        assert.equal(writes(), initialWrites); assert.deepEqual(app.state.fallbackRules, snapshot);
        await page.locator('#inline-fallback-edit').click();
        const currentOrder = () => app.state.fallbackRules[0].entries.map(entry => entry.kind ?? entry.conditionID);
        const expected = [2, 3, 'other_versions', 4];
        await page.locator('#inline-fallback-chart [data-family-focus="up-3"]').click();
        for (let attempt = 0; attempt < 200 && JSON.stringify(currentOrder()) !== JSON.stringify([3, 2, 'other_versions', 4]); attempt++) await page.waitForTimeout(30);
        assert.deepEqual(currentOrder(), [3, 2, 'other_versions', 4]); await ready();
        await page.locator('#inline-fallback-chart [data-family-focus="down-3"]').click();
        for (let attempt = 0; attempt < 200 && JSON.stringify(currentOrder()) !== JSON.stringify(expected); attempt++) await page.waitForTimeout(30);
        assert.deepEqual(currentOrder(), expected); await ready();
        assert.deepEqual(app.state.personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]), [[1, 6000], [6, 4000]]);
        await page.locator('#inline-fallback-done').click();
        assert.equal(await page.locator('.bp-family-order, .bp-fallback-picker-step-number').count(), 0);
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        const score = page.locator('.bp-score-track.is-leader-relative').first();
        const bars = await score.evaluate(track => {
            const fill = track.querySelector('.bp-score-known').getBoundingClientRect(), label = track.querySelector('.bp-model-score');
            const box = label.getBoundingClientRect(), css = getComputedStyle(label);
            return { height: track.getBoundingClientRect().height, radius: getComputedStyle(track).borderRadius, color: css.color,
                inside: box.left >= fill.left - 1 && box.right <= fill.right + 1 && box.top >= fill.top && box.bottom <= fill.bottom,
                coverageInBar: label.querySelectorAll('small').length, background: getComputedStyle(track).backgroundColor };
        });
        assert.equal(bars.color, 'rgb(255, 255, 255)'); assert.equal(bars.inside, true, JSON.stringify(bars));
        assert.equal(bars.coverageInBar, 0); assert.equal(bars.background, 'rgba(0, 0, 0, 0)');
        assert.ok(bars.height >= 24); assert.equal(bars.radius, '3px');
        await page.screenshot({ path: join(output, `${label}-score-bars.png`) });
        await page.reload(); await ready();
        assert.equal(await page.locator('html').getAttribute('data-fallback-appearance'), null);
        assert.equal(await page.locator('.bp-fallback-style-control, .bp-score-colors-toggle').count(), 0);
        assert.deepEqual(errors, []);
        reports.push({ label, styles, wrappedNames, bars, writes: writes() - initialWrites });
        console.log(JSON.stringify({ label, passed: true, styles: styles.map(style => style.key) }));
    } catch (error) { await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {}); throw error; }
    finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
