import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const observe = process.argv.includes('--observe');
const output = resolve(process.env.CHART_VISUAL_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-composition-20261021/chart-visuals');
await mkdir(output, { recursive: true });
const reports = [];
const cases = [
    ['chromium', chromium, 1440, 900], ['chromium', chromium, 1440, 650],
    ['chromium', chromium, 390, 844], ['chromium', chromium, 390, 667],
    ['chromium', chromium, 320, 568], ['chromium', chromium, 844, 390],
    ['webkit', webkit, 390, 844], ['webkit', webkit, 320, 568],
    ['chromium', chromium, 1440, 650, 'range'], ['chromium', chromium, 390, 844, 'range'],
    ['chromium', chromium, 320, 568, 'range'], ['chromium', chromium, 844, 390, 'range'],
    ['webkit', webkit, 390, 844, 'range'], ['chromium', chromium, 390, 844, 'available', true]
];

async function settle(page) {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().filter(animation =>
            animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

for (const [engine, launcher, width, height, scoreMode = 'available', reduced = false] of cases) {
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    const label = `${engine}-${width}x${height}${scoreMode === 'range' ? '-range' : ''}${reduced ? '-reduced' : ''}`;
    const app = await startPreview({ rankingStress: true });
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760,
        hasTouch: width < 760, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.addInitScript(scoreMode => sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ scoreMode })), scoreMode);
        await page.goto(`${app.url}/Language-models?view=showcase`);
        await page.locator('.bp-model-column').first().waitFor({ state: 'attached' });
        await page.waitForFunction(() => document.querySelector('#model-card').getAttribute('aria-busy') === 'false');
        await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            const start = scene.getBoundingClientRect().top + scrollY;
            const travel = scene.offsetHeight - document.documentElement.clientHeight - scene.querySelector('.bp-showcase-stage').offsetHeight;
            scrollTo({ top: start + travel * .55, behavior: 'instant' });
        });
        await settle(page);
        const geometry = await page.evaluate(() => {
            const rect = node => node.getBoundingClientRect().toJSON();
            const scroll = document.querySelector('.bp-model-chart-scroll');
            const bounds = rect(scroll);
            const weights = document.getElementById('weight-bars');
            const weightBounds = rect(weights);
            const weightTop = weightBounds.top + weights.clientTop;
            const weightBottom = weightTop + weights.clientHeight;
            const completeWeightRows = [...weights.querySelectorAll('.bp-weight-bar-row')].filter(row =>
                [row, row.querySelector('.bp-benchmark-information-link'), row.querySelector('.bp-weight-bar-value')].every(node => {
                    const box = rect(node);
                    return box.top >= weightTop - .5 && box.bottom <= weightBottom + .5;
                })).length;
            const columns = [...document.querySelectorAll('.bp-model-column')];
            const visible = columns.filter(column => {
                const box = rect(column);
                return box.left >= bounds.left && box.right <= bounds.right;
            });
            const textRect = node => {
                const range = document.createRange(); range.selectNodeContents(node); return rect(range);
            };
            return {
                grid: rect(document.querySelector('.bp-workspace-grid')),
                plot: rect(document.querySelector('.bp-model-column-plot')),
                column: rect(columns[0]), bar: rect(columns[0].querySelector('.bp-column-known')),
                footer: rect(document.querySelector('.bp-showcase-footer')),
                models: rect(document.getElementById('model-rows')),
                chartViewport: bounds,
                legend: document.querySelector('.bp-model-chart-legend') ? rect(document.querySelector('.bp-model-chart-legend')) : null,
                weights: weightBounds,
                weightClientHeight: weights.clientHeight,
                completeWeightRows,
                leftWorkspace: rect(document.querySelector('.bp-left-workspace')),
                rightWorkspace: rect(document.querySelector('.bp-right-workspace')),
                sourceControls: rect(document.querySelector('.bp-pie-mode-row')),
                weightsHeading: rect(document.querySelector('.bp-weight-bars-heading')),
                modelToolbar: rect(document.querySelector('.bp-model-toolbar')),
                sceneHeading: rect(document.querySelector('.bp-showcase-scene-heading')),
                weightOverflow: getComputedStyle(document.getElementById('weight-bars')).overflowY,
                horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
                chartVerticalOverflow: scroll.scrollHeight - scroll.clientHeight,
                chartOverflowY: getComputedStyle(scroll).overflowY,
                modelVerticalOverflow: document.getElementById('model-rows').scrollHeight - document.getElementById('model-rows').clientHeight,
                visibleModels: visible.length,
                labels: visible.map(column => {
                    const mark = column.querySelector('.bp-vendor-mark');
                    const image = mark?.querySelector('img');
                    return { score: rect(column.querySelector('.bp-model-column-value')),
                        bar: rect(column.querySelector('.bp-column-known')),
                        logo: mark ? rect(mark) : null,
                        logoLoaded: !image || image.complete && image.naturalWidth > 0,
                        name: textRect(column.querySelector('.bp-model-display-name')) };
                })
            };
        });
        await page.screenshot({ path: resolve(output, `${label}.png`) });

        const first = page.locator('.bp-model-column').first();
        const backgroundBefore = await first.evaluate(node => ({
            plot: getComputedStyle(node.querySelector('.bp-model-column-plot'), '::before').backgroundColor,
            column: getComputedStyle(node).backgroundColor,
            identity: getComputedStyle(node.querySelector('.bp-model-column-identity')).backgroundColor
        }));
        if (width >= 760) await first.hover();
        else await first.focus();
        await settle(page);
        const highlight = await first.evaluate(node => {
            const plot = node.querySelector('.bp-model-column-plot');
            const identity = node.querySelector('.bp-model-column-identity');
            const style = getComputedStyle(plot, '::before');
            return { plot: style.backgroundColor, column: getComputedStyle(node).backgroundColor,
                identity: getComputedStyle(identity).backgroundColor,
                height: parseFloat(style.height), plotHeight: plot.getBoundingClientRect().height,
                plotBottom: plot.getBoundingClientRect().bottom, identityTop: identity.getBoundingClientRect().top,
                filter: getComputedStyle(node.querySelector('.bp-column-known')).filter };
        });
        if (width === 1440 && height === 900) await page.screenshot({ path: resolve(output, `${label}-hover.png`) });
        const scoreFits = await first.evaluate(column => {
            const value = column.querySelector('.bp-model-column-value');
            const original = value.textContent;
            const fits = ['-1,234.56789', '100', '0', '-'].every(text => {
                value.textContent = text; value.style.setProperty('--model-score-characters', text.length);
                const score = value.getBoundingClientRect(), bar = value.parentElement.getBoundingClientRect();
                return score.left >= bar.left - 1 && score.right <= bar.right + 1;
            });
            value.textContent = original; value.style.setProperty('--model-score-characters', original.length);
            return fits;
        });

        await page.evaluate(async () => {
            const { createChartWorkspace } = await import('/js/workspace/chart-workspace.js');
            const entries = Array.from({ length: 23 }, (_, index) => ({ conditionID: index + 1, benchmarkID: index + 101,
                name: `Chart benchmark ${index + 1}`, isPrimaryCondition: true, weightBasisPoints: 1000 - index }));
            window.chartVisualHarness = createChartWorkspace({ state: { categoryID: 1, selectedContextValues: {},
                workspaceDisplay: 'charts', mode: 'public', personalEntries: [], loading: false }, getEntries: () => entries,
                benchmarkCard: document.getElementById('benchmark-card'), getMemberURL: () => '#', onInspectVersion: () => {} });
            window.chartVisualHarness.render();
        });
        const more = page.locator('.bp-weight-bars-more');
        const expansion = { before: await page.locator('.bp-weight-bar-row').count(),
            icon: await more.locator('i').getAttribute('class'), variant: await more.getAttribute('data-ui-variant') };
        await more.evaluate(node => node.focus());
        await settle(page);
        if (scoreMode === 'available' && !reduced && height >= 800) {
            await page.screenshot({ path: resolve(output, `${label}-show-more.png`) });
        }
        expansion.scrollBefore = await page.locator('#weight-bars').evaluate(node => node.scrollTop);
        await page.keyboard.press('Enter');
        await settle(page);
        expansion.after = await page.locator('.bp-weight-bar-row').count();
        expansion.scrollAfter = await page.locator('#weight-bars').evaluate(node => node.scrollTop);
        expansion.stillFocused = await more.evaluate(node => document.activeElement === node);
        expansion.scrollable = await page.locator('#weight-bars').evaluate(node => node.scrollHeight > node.clientHeight);
        await more.evaluate(node => node.focus());
        await page.keyboard.press('Enter');
        expansion.final = await page.locator('.bp-weight-bar-row').count();
        expansion.hidden = await more.isHidden();
        expansion.focusTransferred = expansion.final > 20
            && await page.locator('.bp-weight-bar-row').nth(20).evaluate(node => node.contains(document.activeElement));

        const checks = {
            narrowerColumns: geometry.column.width <= (width < 760 ? 36 : 44),
            tallerMobilePlot: width >= 760 || geometry.plot.height >= (height >= 800 ? 150 : height >= 640 ? 90 : 70),
            desktopPlotNotTaller: width < 760 || geometry.plot.height <= 240,
            aboveFooter: geometry.models.bottom <= geometry.footer.top + 1 && geometry.weights.bottom <= geometry.footer.top + 1,
            rangeLegendAboveFooter: !geometry.legend || geometry.legend.bottom <= geometry.footer.top + 1,
            noHorizontalPageOverflow: geometry.horizontalOverflow <= 1,
            noVerticalChartScroll: geometry.chartOverflowY === 'hidden' && geometry.modelVerticalOverflow <= 1,
            labelsFit: geometry.labels.every(({ score, bar, logo, logoLoaded, name }) => score.left >= bar.left - 1
                && score.right <= bar.right + 1 && logoLoaded && (!logo || logo.bottom <= geometry.footer.top + 1)
                && (!logo || logo.left >= geometry.chartViewport.left - 1 && logo.right <= geometry.chartViewport.right + 1)
                && name.bottom <= Math.min(geometry.footer.top, geometry.chartViewport.bottom) + 1),
            adaptiveScoresFit: scoreFits,
            plotOnlyHighlight: backgroundBefore.plot !== highlight.plot && highlight.filter === 'none'
                && backgroundBefore.column === highlight.column && backgroundBefore.identity === highlight.identity
                && Math.abs(highlight.height - highlight.plotHeight) <= 1 && highlight.plotBottom <= highlight.identityTop + 1,
            explicitExpansion: expansion.icon.includes('chevron-down') && expansion.variant === 'quiet'
                && expansion.before === 10 && expansion.after === 20 && expansion.final === 23
                && expansion.stillFocused && expansion.hidden && expansion.focusTransferred
                && Math.abs(expansion.scrollAfter - expansion.scrollBefore) <= 1,
            weightsScrollInternally: geometry.weightOverflow === 'auto' && expansion.scrollable,
            usableMobileWeights: width >= 760 || geometry.weightClientHeight >= 80,
            completeWeightRowVisible: width >= 760 || geometry.completeWeightRows >= 1,
            noPageErrors: errors.length === 0
        };
        reports.push({ label, geometry, highlight, expansion, checks, errors });
        console.log(JSON.stringify({ label, plot: geometry.plot.height, weights: geometry.weights.height,
            weightClientHeight: geometry.weightClientHeight, completeWeightRows: geometry.completeWeightRows,
            column: geometry.column.width, visibleModels: geometry.visibleModels, checks }));
    } catch (error) {
        await page.screenshot({ path: resolve(output, `${label}-error.png`) }).catch(() => {});
        throw error;
    } finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(resolve(output, 'results.json'), JSON.stringify(reports, null, 2));
assert.ok(reports.length);
if (!observe) assert.ok(reports.every(report => Object.values(report.checks).every(Boolean)), 'Chart visual regression; inspect results.json.');
