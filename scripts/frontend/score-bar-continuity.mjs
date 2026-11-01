import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { availableResultInference } from '../../public/js/shared/available-score.js';

const output = process.env.SCORE_BARS_OUTPUT ?? 'artifacts/workspace-ui-20261008/score-bars';
const builtRoot = process.env.HOME_BUILT_ROOT;
const html = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
await mkdir(output, { recursive: true });
const cases = [
    { name: 'Above 100', lower: 120, upper: 150 },
    { name: 'Continuous join', lower: 55, upper: 85 },
    { name: 'Known only', lower: 40, upper: 40 },
    { name: 'Uncertain only', lower: 0, upper: 100 },
    { name: 'Zero', lower: 0, upper: 0 },
    { name: 'Crossing zero', lower: -30, upper: 30 },
    { name: 'Negative interval', lower: -50, upper: -20 }
];
const checks = [];

async function seamPixels(page, track) {
    const geometry = await track.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const known = node.querySelector('.bp-score-known').getBoundingClientRect();
        const uncertain = node.querySelector('.bp-score-uncertain').getBoundingClientRect();
        return { seam: (uncertain.left - bounds.left) / bounds.width, gap: uncertain.left - known.right };
    });
    assert.ok(Math.abs(geometry.gap) < 0.02, `Known and uncertain segments must share an edge; gap=${geometry.gap}`);
    const screenshot = await track.screenshot();
    // Decode captured pixels outside the live page's image CSP.
    const decoder = await page.context().browser().newPage();
    try {
        return await decoder.evaluate(async ({ imageData, seam }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${imageData}`;
            await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            const x = Math.floor(image.width * seam);
            const pixels = [];
            for (const y of [.15, .3, .7, .85]) {
                for (const offset of [-1, 0, 1]) {
                    pixels.push(Array.from(context.getImageData(x + offset, Math.floor(image.height * y), 1, 1).data));
                }
            }
            return pixels;
        }, { imageData: screenshot.toString('base64'), seam: geometry.seam });
    } finally { await decoder.close(); }
}

for (const engine of process.argv.includes('--webkit') ? [chromium, webkit] : [chromium]) {
    const browser = await engine.launch({ headless: true,
        proxy: liveURL && process.env.SCORE_BARS_PROXY ? { server: process.env.SCORE_BARS_PROXY, bypass: '127.0.0.1,localhost' } : undefined,
        env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of [1440, 390, 320]) {
            const app = await startPreview();
            const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 3,
                isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            if (html) await page.route(`${app.url}/**`, async route => {
                const path = new URL(route.request().url()).pathname;
                if (route.request().resourceType() === 'document') return route.fulfill({ body: html, contentType: 'text/html' });
                if (path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))),
                    contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
                return route.fallback();
            });
            await page.route('**/api/get_weighted_workspace', async route => {
                const response = await route.fetch({ url: app.url + '/api/get_weighted_workspace' });
                const data = await response.json();
                const base = data.modelLeaderboards.public[0];
                const recordedWeight = base.calculationScores.reduce((sum, score) => sum + score.effectiveWeight, 0);
                data.modelLeaderboards.public = cases.map((item, index) => {
                    const available = data.scoreMode === 'available';
                    const coverage = available ? 100 : 100 - item.upper + item.lower;
                    const normalizedScore = coverage ? item.lower * 100 / coverage : 0;
                    const ID = 201 + index;
                    return { ...base, ...item, ID, modelID: 301 + index, coverage, missingWeight: 100 - coverage,
                        upper: available ? item.lower : item.upper, rank: index + 1,
                        availableInference: available ? availableResultInference(item.lower, 1, []) : null,
                        inferredScores: [],
                        calculationScores: coverage ? base.calculationScores.map(score => {
                            const effectiveWeight = score.effectiveWeight * coverage / recordedWeight;
                            return { ...score, normalizedScore, effectiveWeight,
                                contribution: normalizedScore * effectiveWeight / 100,
                                memberIDs: [ID], memberWeights: [{ ID, weight: 1 }],
                                memberEvidence: [{ ID, hash: 'f'.repeat(64) }] };
                        }) : [] };
                });
                data.rankingPagination.public = { total: cases.length, nextOffset: cases.length, hasMore: false };
                data.rankingPagination.modelScales.public = { min: -50, max: 200 };
                await route.fulfill({ response, json: data });
            });
            try {
                await page.goto(liveURL ?? app.url, liveURL ? { waitUntil: 'domcontentloaded', timeout: 60000 } : undefined);
                await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
                assert.equal(await page.locator('.bp-score-zero').count(), 0, 'Range score bars must not render zero-reference lines');
                const rows = await page.locator('.bp-model-row').evaluateAll(nodes => nodes.map(node => {
                    const known = node.querySelector('.bp-score-known');
                    const uncertain = node.querySelector('.bp-score-uncertain');
                    const fill = node.querySelector('.bp-score-fill');
                    const track = node.querySelector('.bp-score-track');
                    return { name: node.querySelector('.bp-model-name').textContent,
                        knownLeft: parseFloat(known.style.left), knownWidth: parseFloat(known.style.width),
                        uncertainLeft: parseFloat(uncertain.style.left), uncertainWidth: parseFloat(uncertain.style.width),
                        knownRadius: getComputedStyle(known).borderRadius, uncertainRadius: getComputedStyle(uncertain).borderRadius,
                        sharedParent: known.parentElement === fill && uncertain.parentElement === fill,
                        hasContinuousBed: Boolean(fill.querySelector('.bp-score-range-base')),
                        clip: getComputedStyle(fill).clipPath, animation: getComputedStyle(fill).animationName,
                        knownHeight: known.getBoundingClientRect().height / track.getBoundingClientRect().height,
                        uncertainHeight: uncertain.getBoundingClientRect().height / track.getBoundingClientRect().height };
                }));
                rows.forEach((row, index) => {
                    const item = cases[index];
                    const position = value => (value + 50) / 250 * 100;
                    const expected = [Math.min(20, position(item.lower)), Math.abs(position(item.lower) - 20),
                        position(item.lower), position(item.upper) - position(item.lower)];
                    [row.knownLeft, row.knownWidth, row.uncertainLeft, row.uncertainWidth]
                        .forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8, `${item.name}: score coordinates changed`));
                    assert.equal(row.knownRadius, '3px');
                    assert.equal(row.uncertainRadius, '3px');
                    assert.equal(row.hasContinuousBed, item.lower > 0 && item.upper > item.lower);
                    assert.equal(row.sharedParent, true);
                    assert.match(row.clip, /round 3px/);
                    assert.equal(row.animation, 'none', 'Reduced motion must disable the shared animation');
                    assert.equal(row.knownHeight, item.lower < 0 && item.upper > item.lower ? .5 : 1);
                    assert.equal(row.uncertainHeight, item.lower < 0 && item.upper > item.lower ? .5 : 1);
                });
                await page.waitForFunction(() => [...document.querySelectorAll('.bp-score-track > .bp-model-score')]
                    .every(node => {
                        const end = parseFloat(node.style.getPropertyValue('--bar-label-position'));
                        const start = parseFloat(node.style.getPropertyValue('--bar-label-start'));
                        return node.dataset.barLabelOverflow === String(node.parentElement.clientWidth * Math.max(0, end - start) / 100 < node.getBoundingClientRect().width);
                    }));
                const labels = await page.locator('.bp-score-track > .bp-model-score').evaluateAll(nodes => nodes.map(node => {
                    const box = node.getBoundingClientRect(), track = node.parentElement, fill = track.querySelector('.bp-score-known').getBoundingClientRect();
                    return { text: node.textContent, color: getComputedStyle(node).color, opacity: getComputedStyle(node).opacity,
                        outside: node.dataset.barLabelOverflow === 'true', trackHeight: track.getBoundingClientRect().height,
                        rightOfBar: box.left >= fill.right - 1,
                        inside: box.left >= fill.left - 1 && box.right <= fill.right + 1 && box.top >= fill.top - 1 && box.bottom <= fill.bottom + 1 };
                }));
                assert.equal(labels.length, cases.length);
                for (const label of labels) {
                    assert.equal(label.trackHeight, 26);
                    assert.equal(label.opacity, '1');
                    assert.equal(label.color, label.outside ? 'rgb(17, 17, 17)' : 'rgb(255, 255, 255)');
                    assert.equal(label.outside ? label.rightOfBar : label.inside, true, JSON.stringify(label));
                }
                const joined = page.getByRole('button', { name: 'View approved scores for Continuous join', exact: true });
                const pixels = await seamPixels(page, joined.locator('.bp-score-track'));
                assert.ok(pixels.every(pixel => pixel[1] <= 218 && pixel[3] === 255), 'Track background must not show through the orange/gray join');
                await joined.screenshot({ path: `${output}/after-join-${engine.name()}-${width}.png` });
                await page.screenshot({ path: `${output}/after-${engine.name()}-${width}.png`, fullPage: true });
                await page.locator('[data-score-mode="available"]').click();
                await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.phase === 'ready'
                    && document.querySelector('.bp-score-known')?.style.width === '100%'
                    && [...document.querySelectorAll('.bp-score-uncertain')].every(node => parseFloat(node.style.width) === 0));
                assert.equal(await page.locator('.bp-score-uncertain').evaluateAll(nodes => nodes.every(node => parseFloat(node.style.width) === 0)), true);
                assert.equal(await page.locator('.bp-score-negative-range').count(), 0);
                assert.equal(await page.locator('.bp-score-zero').count(), 0, 'Available-result score bars must not render zero-reference lines');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.locator('[data-score-mode="range"]').click();
                await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.phase === 'ready'
                    && document.querySelector('.bp-score-known')?.style.width === '48%');
                await page.emulateMedia({ reducedMotion: 'no-preference' });
                await page.locator('.bp-model-row').evaluateAll(nodes => nodes.forEach(node => {
                    for (const animation of node.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 150; }
                }));
                const animatedPixels = await seamPixels(page, joined.locator('.bp-score-track'));
                assert.ok(animatedPixels.every(pixel => pixel[1] <= 218 && pixel[3] === 255), 'Animation must not separate the two segments');
                assert.deepEqual(errors, []);
                assert.equal(app.state.requests.some(request => /save_personal_pie|submit_contribution/.test(request.path)), false);
                checks.push({ browser: engine.name(), width, cases: rows.length, labels, continuousJoin: true,
                    animatedJoin: true, availableMode: true, reducedMotion: true, zeroReferenceLines: 0,
                    built: Boolean(html), live: Boolean(liveURL), businessWrites: 0, errors });
                console.log(`PASS ${engine.name()} ${width}`);
            } finally { await page.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/frontend-checks.json`, JSON.stringify(checks, null, 2));
