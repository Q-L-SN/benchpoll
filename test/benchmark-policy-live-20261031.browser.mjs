import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { isAACondition } from '../public/js/shared/aa-ranking-policy.js';
import { aaResultReason } from '../aa-archive-policy.js';

const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
const baseline = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : { files: [] };
const assets = new Map([...baseline.files, ...manifest.files].map(file => [file.path, file]));
const output = `D:/Codex-artifacts/website1/${manifest.release}/live`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { release: manifest.release, viewports: [], restrictedVersions: [], bundles: [], modelConfigurations: [], mixedVersion: null };
try {
    for (const width of [393, 1440, 1920]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        try {
            const page = await context.newPage(), errors = [], writes = [], captures = [];
            page.setDefaultTimeout(90000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('response', response => {
                const path = new URL(response.url()).pathname;
                if (!path.startsWith('/build/')) return;
                const file = assets.get(`public${path}`);
                if (file) captures.push(response.body().then(bytes => {
                    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.after, path);
                    report.bundles.push(path);
                }));
            });
            await page.route('**/api/**', route => {
                const path = new URL(route.request().url()).pathname;
                if (/\/(?:save|create|delete|update|submit|cast|withdraw|accept)_/.test(path)) {
                    writes.push(path); return route.abort();
                }
                return route.continue();
            });
            await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
            await page.locator('.th-card[data-preview-state="loaded"] .th-model').first().waitFor();
            const grid = await page.locator('#topics-grid').boundingBox();
            assert.ok(grid.width <= 1121);
            assert.ok(Math.abs(grid.x * 2 + grid.width - width) < 2);
            if (width > 1000) assert.ok(grid.x >= width * .075);
            else assert.ok(grid.width > width * .88);
            await page.screenshot({ path: `${output}/home-${width}.png` });
            report.viewports.push({ width, grid });
            if (width === 1440) {
                const post = async (path, body) => page.evaluate(async ({ path, body }) => {
                    const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                    if (!response.ok) throw new Error(`${path}: ${response.status}`);
                    return response.json();
                }, { path, body });
                for (const conditionID of [8411, 13813, 25125, 25126, 2255, 25711, 4191, 9399, 25318, 25703, 25704, 25705, 25706, 25707, 25715]) {
                    const information = await post('get_benchmark_information', { conditionID });
                    assert.equal(information.displayRestriction, 'artificial_analysis', String(conditionID));
                    assert.equal(information.description, '');
                    assert.equal(information.differenceExplanation, '');
                    const scores = await post('get_benchmark_scores', { benchmarkID: information.benchmarkID, conditionID });
                    assert.equal(scores.displayRestriction, 'artificial_analysis');
                    assert.deepEqual(scores.scores, []);
                    assert.equal(scores.nextBeforeID, null);
                    report.restrictedVersions.push(conditionID);
                }
                const normal = await post('get_benchmark_scores', { benchmarkID: 1428, conditionID: 689 });
                assert.equal(normal.displayRestriction, null);
                assert.ok(normal.scores.length > 0);
                assert.equal(normal.conditions.find(row => row.ID === 2255).scoreCount, null);
                const mixedScores = [];
                let beforeID, mixedCount;
                do {
                    const mixed = await post('get_benchmark_scores', { benchmarkID: 1786, conditionID: 22187, ...(beforeID ? { beforeID } : {}) });
                    assert.equal(mixed.displayRestriction, null);
                    assert.equal(mixed.omittedScores, true);
                    mixedCount = mixed.conditions.find(row => row.ID === 22187).scoreCount;
                    assert.ok(mixed.scores.every(row => !row.fields.some(field => field.name === 'Published evaluation provider' && field.value === 'Artificial Analysis')));
                    mixedScores.push(...mixed.scores);
                    beforeID = mixed.nextBeforeID;
                } while (beforeID);
                assert.equal(mixedScores.length, mixedCount);
                assert.equal(new Set(mixedScores.map(row => row.ID)).size, mixedCount);
                report.mixedVersion = { conditionID: 22187, visibleCount: mixedCount, omittedNotice: true };
                const modelIDs = [...new Set(normal.scores.map(row => row.modelID))].slice(0, 3);
                const index = await post('get_model_score_configurations', { modelIDs, includeVersions: true });
                assert.equal(index.displayPolicy, 'artificial_analysis');
                assert.ok(Array.isArray(index.omittedConfigurations));
                for (const configuration of index.configurations) {
                    assert.ok(configuration.scoreGroups.every(group => !isAACondition(group)));
                    assert.equal(configuration.scoreCount, configuration.scoreGroups.reduce((sum, group) => sum + group.sampleCount, 0));
                }
                for (const configuration of index.configurations.slice(0, 3)) {
                    const data = await post('get_approved_benchmark_results', { modelID: configuration.modelID, scoreFields: configuration.scoreFields });
                    assert.equal(data.displayPolicy, 'artificial_analysis');
                    for (const group of data.scoreGroups) {
                        assert.equal(isAACondition(group), false);
                        for (const sample of group.samples) assert.equal(aaResultReason({
                            source_url: sample.sourceURL, source_title: sample.sourceTitle }), null);
                    }
                    report.modelConfigurations.push({ modelID: configuration.modelID, scoreFields: configuration.scoreFields,
                        groups: data.scoreGroups.length, omissionNotice: data.displayRestriction === 'artificial_analysis' });
                }
            }
            await Promise.all(captures);
            assert.deepEqual(errors, []); assert.deepEqual(writes, []);
        } finally { await context.close(); }
    }
    assert.ok(report.bundles.length > 0);
} finally { await browser.close(); }
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
