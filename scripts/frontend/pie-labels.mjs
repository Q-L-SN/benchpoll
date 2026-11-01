import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = process.env.PIE_LABELS_OUTPUT ?? 'artifacts/percentile-ranking-20261007/pie-labels';
await mkdir(output, { recursive: true });
const baseline = process.argv.includes('--baseline');
const liveURL = process.env.PIE_LABELS_URL;
const results = [];

async function exercise(page) {
    return page.evaluate(async () => {
        await document.fonts.ready;
        const { createPieRenderer } = await import('/js/workspace/pie-renderer.js');
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.id = 'label-test-pie'; svg.setAttribute('viewBox', '0 0 360 360');
        svg.style.cssText = 'display:block;width:100%;max-width:560px;height:auto;background:white;margin:16px auto;';
        document.querySelector('.bp-workspace').prepend(svg);
        const tooltip = document.createElement('div'); tooltip.hidden = true; document.body.append(tooltip);
        let entries = [], fallback = false;
        const state = { mode: 'public', selectedObjectID: null, pieOrderByObjectID: new Map(),
            limits: { totalBasisPoints: 10000 }, visualPieWeights: new Map(), visualPieEntries: new Map(), pieAnimationFrame: null };
        const renderer = createPieRenderer({ state, pieSvg: svg, pieHoverTooltip: tooltip,
            orderedPieEntries: values => values, currentPieEntries: () => entries,
            selectedObjectIndex: values => values.findIndex(entry => entry.conditionID === state.selectedObjectID),
            renderInlineFallback() {}, fallbackRuleFor: ID => fallback && ID === 2 ? {} : null, publicFallbackRuleFor: () => null, onSelect() {} });
        const entry = (ID, weight, name, conditionName = 'default') => ({ conditionID: ID, name, conditionName,
            weight, weightBasisPoints: weight * 100 });
        const polar = (radius, angle) => ({ x: 180 + radius * Math.sin(angle * Math.PI / 180),
            y: 180 - radius * Math.cos(angle * Math.PI / 180) });
        const boxInside = (box, slice, inset = 0) => [
            [box.x - inset, box.y - inset], [box.x + box.width + inset, box.y - inset],
            [box.x - inset, box.y + box.height + inset], [box.x + box.width + inset, box.y + box.height + inset],
            [box.x + box.width / 2, box.y - inset], [box.x + box.width / 2, box.y + box.height + inset],
            [box.x - inset, box.y + box.height / 2], [box.x + box.width + inset, box.y + box.height / 2]
        ].every(([x, y]) => slice.isPointInFill(new DOMPoint(x, y)));
        const paintedBoxes = text => {
            if (!text) return [];
            if (text.querySelector('[data-label-clipped]')) {
                const id = text.getAttribute('mask')?.match(/#([^)]*)/)?.[1];
                const mask = document.getElementById(id);
                if (!mask) throw new Error('Missing name fade mask');
                const percentage = text.querySelector('[data-label-percent]');
                return [mask.querySelector('[data-name-mask]').getBBox(),
                    ...Array.from({ length: percentage?.getNumberOfChars() ?? 0 }, (_, index) => percentage.getExtentOfChar(index))];
            }
            return Array.from({ length: text.getNumberOfChars() }, (_, index) => text.getExtentOfChar(index));
        };
        const probe = document.createElementNS(NS, 'text'); probe.classList.add('bp-pie-label');
        const nameLine = document.createElementNS(NS, 'tspan'); nameLine.textContent = 'MMLU';
        const percentLine = document.createElementNS(NS, 'tspan'); percentLine.setAttribute('data-label-percent', '');
        probe.append(nameLine, percentLine); svg.append(probe);
        const cases = [];
        for (const [offset, weight] of [[0, 8], [20, 9], [40, 10], [65, 8]]) {
            entries = [...(offset ? [entry(1, offset, 'Offset')] : []), entry(2, weight, 'MMLU'), entry(3, 100 - offset - weight, 'Other')];
            renderer.renderPie();
            const slice = svg.querySelector('g[data-object-id="2"] .bp-pie-slice');
            percentLine.textContent = `${weight}%`;
            const start = 7 + offset * 3.6, sweep = weight * 3.6;
            let candidate = null;
            for (let r = 70; r <= 140 && !candidate; r += 2) {
                const point = polar(r, start + sweep / 2);
                for (const [line, y] of [[nameLine, point.y - 4], [percentLine, point.y + 13]]) {
                    line.setAttribute('x', point.x); line.setAttribute('y', y);
                }
                if (paintedBoxes(probe).every(box => boxInside(box, slice, 2))) candidate = { ...point, radius: r };
            }
            const group = svg.querySelector('g[data-object-id="2"]');
            cases.push({ offset, weight, actualText: group.querySelector('.bp-pie-label')?.textContent ?? '',
                fullCandidate: candidate, actualFits: paintedBoxes(group.querySelector('.bp-pie-label')).every(box => boxInside(box, slice)) });
        }
        probe.remove();
        const matrix = [];
        if (!window.labelBaseline) for (const [name, version] of [['MMLU', 'default'], ['ARC-AGI-2', 'semi-private'],
            ['Agent Arena', 'Chat'], ['Global MMLU Lite', 'default'], ['Code generation', 'full offline binary accuracy']]) {
            for (const weight of [1, 3, 6, 8, 10, 16, 25, 50, 90, 100]) for (const offset of [0, (100 - weight) / 2]) {
                for (const personal of [false, true]) {
                    state.mode = personal ? 'personal' : 'public'; fallback = personal;
                    entries = [...(offset ? [entry(1, offset, 'Offset')] : []), entry(2, weight, name, version),
                        ...(100 - offset - weight > 0 ? [entry(3, 100 - offset - weight, 'Other')] : [])];
                    renderer.renderPie();
                    const group = svg.querySelector('g[data-object-id="2"]');
                    const slice = group.querySelector('.bp-pie-slice');
                    const mode = group.dataset.labelMode;
                    const boxes = paintedBoxes(group.querySelector('.bp-pie-label'));
                    const contained = boxes.every(box => boxInside(box, slice));
                    matrix.push({ name, version, weight, offset, personal, mode, contained,
                        ...(!contained ? { boxes: boxes.map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height })) } : {}) });
                    if (mode === 'full') {
                        const nameText = [...group.querySelectorAll('[data-label-line]')].map(line => line.textContent).join(' ');
                        const versionText = [...group.querySelectorAll('[data-label-condition]')].map(line => line.textContent).join(' ');
                        if (nameText !== name || versionText !== (version === 'default' ? '' : version)) throw new Error('Truncated full label');
                    } else {
                        group.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', clientX: 180, clientY: 180 }));
                        if (tooltip.hidden || !tooltip.textContent.includes(name)
                            || !tooltip.textContent.includes(`${weight.toFixed(2)}%`)) throw new Error('Missing compact-label tooltip');
                        tooltip.hidden = true;
                    }
                }
            }
        }
        if (matrix.some(test => !test.contained)) throw new Error('Overflowing labels: ' + JSON.stringify(matrix.filter(test => !test.contained)));
        state.mode = 'public'; fallback = false;
        entries = [entry(2, 8, 'A very long benchmark name', 'A long version name'),
            entry(3, 12, 'MMLU', 'A very long version name with many details'),
            entry(4, 30, 'Agent Arena', 'Chat'), entry(5, 50, 'Other')]; renderer.renderPie();
        return { cases, matrixCases: matrix.length, matrixModes: Object.fromEntries(['full', 'name', 'truncated', 'percent', 'hidden']
            .map(mode => [mode, matrix.filter(test => test.mode === mode).length])) };
    });
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    if (baseline && engine === 'webkit') continue;
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of baseline ? widths.slice(0, 1) : widths) {
            const app = await startPreview();
            const context = await browser.newContext({ viewport: { width, height: 960 } });
            const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 60000 : 15000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
                await page.locator('#weight-pie g[data-object-id]').first().waitFor();
                await page.evaluate(value => { window.labelBaseline = value; }, baseline);
                const { cases, matrixCases, matrixModes } = await exercise(page);
                assert.deepEqual(errors, []);
                if (baseline) assert.ok(cases.some(test => test.fullCandidate && !test.actualText.includes('MMLU')),
                    'The old renderer must hide a label that demonstrably fits');
                else for (const test of cases) {
                    if (test.fullCandidate) assert.match(test.actualText, /MMLU/);
                    assert.equal(test.actualFits, true, JSON.stringify(test));
                }
                await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${baseline ? 'before-' : ''}${engine}-${width}.png`, fullPage: true });
                results.push({ engine, width, passed: true, cases, matrixCases, matrixModes });
                console.log(JSON.stringify({ engine, width, passed: true, cases, matrixCases, matrixModes }));
            } catch (error) {
                results.push({ engine, width, passed: false, error: error.stack, errors }); console.error(error);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/${liveURL ? 'live-' : ''}${baseline ? 'before' : 'results'}.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
