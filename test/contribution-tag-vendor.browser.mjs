import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { catalog } from '../scripts/frontend/fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function openFixture(t, data, target) {
    const preview = await startPreview();
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    const submissions = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.route('**/api/get_contribution_catalog', route => route.fulfill({ json: data }));
    if (target) await page.route('**/api/get_contribution_target', route => route.fulfill({
        json: { targetKind: 'benchmark', targetID: 101, form: target }
    }));
    await page.route('**/api/submit_contribution', route => {
        submissions.push(route.request().postDataJSON());
        return route.fulfill({ json: { ID: 1001, status: 'pending' } });
    });
    t.after(async () => {
        await page.close();
        await preview.close();
        assert.deepEqual(errors, []);
    });
    return { page, preview, submissions };
}

function taglessCatalog() {
    const data = catalog();
    delete data.knownTags;
    for (const benchmark of data.benchmarks) delete benchmark.tags;
    return data;
}

function editTarget(withLegacyTags) {
    const target = {
        name: 'Existing benchmark', introductionURL: 'https://example.com/benchmark',
        description: 'Original introduction', requestOfficialSync: false, officialSyncURL: '',
        officialSyncInstructions: '', notes: 'Original notes', conditions: [
            { ID: 1, name: 'default', differenceExplanation: '', usesPercentageScale: true, scoreMin: null,
                scoreMax: null, scoreDirection: 'higher', targetValue: null, isDefault: true, isPrimary: true },
            { ID: 2, name: 'special', differenceExplanation: 'Different scale', usesPercentageScale: false, scoreMin: -1,
                scoreMax: 4, scoreDirection: 'lower', targetValue: null, isDefault: false, isPrimary: false }
        ]
    };
    if (withLegacyTags) target.tags = ['Old tag'];
    return target;
}

test('benchmark form ignores legacy tags in searches and submits a tag-free score contract', async t => {
    const data = taglessCatalog();
    data.benchmarks[0].tags = ['xzqunique'];
    const { page, preview, submissions } = await openFixture(t, data);
    await page.goto(`${preview.url}/contribute/benchmarks/new`);
    const name = page.locator('[data-evaluation-name]');
    await name.fill('xzqunique');
    assert.equal(await page.locator('[data-select-evaluation]').count(), 0);
    await name.fill('General knowledge');
    await page.locator('[data-select-evaluation="101"]').waitFor();
    await name.fill('A new benchmark');
    assert.equal(await page.getByText('Tags', { exact: true }).count(), 0);
    await page.locator('#submit-contribution').click();
    await page.locator('#submit-success-dialog:not([hidden])').waitFor();
    assert.equal(submissions.length, 1);
    assert.equal(Object.hasOwn(submissions[0].benchmarks[0], 'tags'), false);
    assert.deepEqual(submissions[0].benchmarks[0].conditions.map(condition => ({
        name: condition.name, usesPercentageScale: condition.usesPercentageScale,
        scoreMin: condition.scoreMin, scoreMax: condition.scoreMax, scoreDirection: condition.scoreDirection
    })), [{ name: 'default', usesPercentageScale: true, scoreMin: null, scoreMax: null, scoreDirection: 'higher' }]);
});

for (const withLegacyTags of [false, true]) test(`benchmark edit ignores ${withLegacyTags ? 'legacy' : 'absent'} tags and preserves version score fields`, async t => {
    const target = editTarget(withLegacyTags);
    const { page, preview, submissions } = await openFixture(t, taglessCatalog(), target);
    await page.goto(`${preview.url}/contribute/benchmarks/101/edit`);
    await page.locator('[data-field="description"]').waitFor();
    assert.equal(await page.getByText('Tags', { exact: true }).count(), 0);
    await page.locator('#submit-contribution').click();
    await page.locator('#submit-error-dialog:not([hidden])').waitFor();
    assert.match(await page.locator('#submit-error-copy').textContent(), /Change at least one structured field/);
    assert.equal(submissions.length, 0);
    await page.locator('#submit-error-dialog .dialog-close-button').click();
    await page.locator('[data-field="description"]').fill('Updated introduction');
    await page.locator('#submit-contribution').click();
    await page.locator('#submit-success-dialog:not([hidden])').waitFor();
    assert.equal(submissions.length, 1);
    assert.equal(Object.hasOwn(submissions[0].proposed, 'tags'), false);
    assert.equal(submissions[0].proposed.description, 'Updated introduction');
    assert.deepEqual(submissions[0].proposed.conditions, target.conditions);
});

test('vendor picker orders the full catalog by model count, refreshes, and keeps query relevance', async t => {
    const data = taglessCatalog();
    data.vendors = [
        { ID: 1, name: 'Alpha Beta' }, { ID: 2, name: 'Beta Systems' }, { ID: 3, name: 'Beta' },
        ...Array.from({ length: 8 }, (_, index) => ({ ID: 10 + index, name: `Vendor ${index + 1}` })),
        { ID: 'pending:vendor', name: 'Pending Lab', pending: true }, { name: 'Missing A' }, { ID: null, name: 'Missing B' }
    ];
    data.models = [
        ...Array.from({ length: 12 }, (_, index) => ({ ID: index + 1, name: `Late ${index}`, vendorID: '17' })),
        ...Array.from({ length: 9 }, (_, index) => ({ ID: index + 20, name: `Alpha ${index}`, vendorID: 1 })),
        { ID: 'pending:model', name: 'Pending', vendorID: 'pending:vendor', pending: true },
        { ID: 40, name: 'Beta 1', vendorID: 2 }, { ID: 41, name: 'Beta 2', vendorID: 3 },
        { ID: 42, name: 'Missing 1', vendorID: null }, { ID: 43, name: 'Missing 2' }
    ];
    const { page, preview } = await openFixture(t, data);
    await page.goto(`${preview.url}/contribute/models/new`);
    const picker = page.locator('[data-catalog-picker="vendor"]');
    await picker.waitFor();
    assert.equal(await page.getByText('Choose or add a vendor to continue.', { exact: true }).count(), 0);
    const ids = () => picker.locator('[data-select-vendor]').evaluateAll(buttons => buttons.map(button => button.dataset.selectVendor));
    await picker.locator('summary').click();
    await page.waitForFunction(() => document.querySelector('[data-catalog-picker="vendor"] [data-select-vendor]')?.dataset.selectVendor === '17');
    assert.deepEqual(await ids(), ['17', '1', '3', '2', 'pending:vendor', '', '', '10']);
    const query = picker.locator('[data-vendor-search]');
    await query.fill('beta');
    assert.deepEqual(await ids(), ['3', '2', '1']);
    await query.fill('');
    data.models.push(...Array.from({ length: 13 }, (_, index) => ({ ID: 100 + index, name: `New ${index}`, vendorID: 2 })));
    await picker.locator('summary').click();
    await picker.locator('summary').click();
    await page.waitForFunction(() => document.querySelector('[data-catalog-picker="vendor"] [data-select-vendor]')?.dataset.selectVendor === '2');
    assert.deepEqual((await ids()).slice(0, 3), ['2', '17', '1']);
});

test('score entry retains fixed score fields with a tag-free catalog', async t => {
    const { page, preview, submissions } = await openFixture(t, taglessCatalog());
    await page.goto(`${preview.url}/contribute/scores/new`);
    await page.locator('[data-result-model-query]').fill('Aster Pro');
    await page.locator('[data-select-result-model]').first().click();
    await page.locator('[data-result-object-query]').fill('General knowledge');
    await page.locator('[data-select-result-object]').first().click();
    await page.locator('[data-score-value-input]').fill('55');
    await page.getByRole('combobox', { name: 'Harness value', exact: true }).click();
    await page.getByRole('option', { name: 'Agent A', exact: true }).click();
    await page.locator('[data-field="sourceURL"]').fill('https://example.com/evidence');
    await page.locator('#submit-contribution').click();
    await page.locator('#submit-success-dialog:not([hidden])').waitFor();
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0].results[0].scoreFields, [{ fieldID: 1, value: 11 }]);
    assert.equal(submissions[0].results[0].rawScore, 55);
});
