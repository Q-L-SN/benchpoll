import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { familyKey, portableFamilyEntry } from '../../public/js/shared/benchmark-families.js';
import { validateWorkspacePayload } from '../../public/js/workspace/contracts.js';

const baseURL = process.env.BENCHPOLL_VERIFY_URL ?? 'https://benchpoll.com';
const output = 'artifacts/scoring-mode-samples-20261003/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];

function evidence(row) {
    return { ID: row.ID, comparable: row.comparable, members: row.members,
        coverage: row.coverage, resultCount: row.resultCount, missingWeight: row.missingWeight,
        fallbackUsageCount: row.fallbackUsageCount, fallbackResolutions: row.fallbackResolutions,
        comparisonScores: row.comparisonScores,
        calculationScores: row.calculationScores.map(score => {
            const sample = { ...score };
            delete sample.effectiveWeight;
            delete sample.contribution;
            return sample;
        }) };
}

try {
    for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 },
            isMobile: width < 760, hasTouch: width < 760 });
        page.setDefaultTimeout(30000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        async function switchMode(mode) {
            const pending = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                && response.request().postDataJSON().scoreMode === mode
                && response.request().postDataJSON().initialMode === 'personal'
                && response.request().postDataJSON().previewPersonalPie, { timeout: 120000 });
            const [response] = await Promise.all([pending, page.locator(`[data-score-mode="${mode}"]`).click()]);
            assert.equal(response.status(), 200);
            const payload = await response.json();
            await page.locator('.bp-model-row').first().waitFor();
            await page.screenshot({ path: `${output}/${mode}-${width}.png`, fullPage: width < 760 });
            return payload;
        }
        async function allPersonalModels(payload) {
            const rows = [...payload.modelLeaderboards.personal];
            const metadata = payload.rankingPagination.personal;
            let offset = metadata.nextOffset;
            while (offset < metadata.total) {
                const response = await page.request.post(`${baseURL}/api/get_ranking_page`, { data: {
                    snapshotID: payload.rankingPagination.snapshotID, list: 'personal', offset
                } });
                assert.equal(response.status(), 200);
                const next = await response.json();
                assert.equal(next.total, metadata.total);
                assert.ok(next.nextOffset > offset, 'Ranking pagination must advance');
                rows.push(...next.items);
                offset = next.nextOffset;
            }
            assert.equal(rows.length, metadata.total);
            assert.equal(new Set(rows.map(row => row.ID)).size, rows.length);
            return rows;
        }
        try {
            console.log(`Checking live scoring modes at ${width}px`);
            const seedResponse = await page.request.post(`${baseURL}/api/get_weighted_workspace`,
                { data: { initialMode: 'public' }, timeout: 120000 });
            assert.equal(seedResponse.status(), 200);
            const seed = await seedResponse.json();
            validateWorkspacePayload(seed);
            assert.ok(seed.publicPie.entries.length);
            const contextValues = Object.entries(seed.context.contextValues).sort(([left], [right]) => left.localeCompare(right));
            const key = `${seed.context.categoryID}:${JSON.stringify(contextValues)}`;
            const draft = { entries: seed.publicPie.entries.map(({ conditionID, weightBasisPoints }) => ({ conditionID, weightBasisPoints })),
                fallbackRules: seed.publicPie.familyComposition.flatMap(group => {
                    const family = [...group.families].sort((left, right) => right.weightBasisPoints - left.weightBasisPoints
                        || familyKey(group.primaryConditionID, left.entries).localeCompare(familyKey(group.primaryConditionID, right.entries)))[0];
                    return family.entries.length ? [{ primaryConditionID: group.primaryConditionID, mode: 'ordered',
                        entries: family.entries.map(portableFamilyEntry) }] : [];
                }) };
            await page.addInitScript(({ key, draft }) => {
                sessionStorage.setItem('benchpoll-guest-weights-v2-ordered', JSON.stringify([[key, draft]]));
            }, { key, draft });
            const loaded = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                && response.request().postDataJSON().previewPersonalPie,
                { timeout: 120000 });
            const [loadedResponse] = await Promise.all([loaded,
                page.goto(baseURL, { waitUntil: 'commit', timeout: 60000 })]);
            assert.equal(loadedResponse.status(), 200);
            await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
            const personalLoaded = page.waitForResponse(response => response.url().endsWith('/api/get_ranking_page')
                && response.request().postDataJSON().list === 'personal');
            const [personalResponse] = await Promise.all([personalLoaded, page.locator('#pie-mode-personal').click()]);
            assert.equal(personalResponse.status(), 200);
            if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
            const available = await switchMode('available');
            const range = await switchMode('range');
            console.log(`Comparing all paginated model evidence at ${width}px`);
            assert.deepEqual(range.comparison, available.comparison);
            assert.deepEqual(range.personalPie, available.personalPie);
            const availableRows = new Map((await allPersonalModels(available)).map(row => [row.ID, row]));
            const rangeRows = await allPersonalModels(range);
            assert.ok(rangeRows.length);
            assert.equal(rangeRows.length, availableRows.size);
            for (const row of rangeRows) {
                assert.ok(availableRows.has(row.ID), `Model ${row.ID} must exist in both scoring modes`);
                assert.deepEqual(evidence(row), evidence(availableRows.get(row.ID)));
            }
            const ranked = range.modelLeaderboards.personal.find(row => row.comparable);
            assert.ok(ranked);
            await page.getByRole('button', { name: `View approved scores for ${ranked.name}`, exact: true }).click();
            assert.equal(await page.locator('#model-scores-list .bp-model-score-detail-row').count(), ranked.calculationScores.length);
            await page.locator('#model-scores-dialog .dialog-close-button').click();
            assert.match(await page.locator('.bp-score-fill').first().evaluate(node => getComputedStyle(node).clipPath), /round 5px/);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            checks.push({ width, temporaryPersonalMix: true, comparedModels: rangeRows.length, identicalSamples: true,
                displayedCalculationScores: ranked.calculationScores.length, errors, passed: true });
            console.log(`PASS live scoring modes at ${width}px: ${rangeRows.length} identical model samples`);
        } finally { await page.close(); }
    }
    await writeFile(`${output}/results.json`, JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
