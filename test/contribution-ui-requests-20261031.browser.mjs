import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { catalog } from '../scripts/frontend/fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';
import { betaFeedbackTemplate, bulkImportTemplate, mergeRequestTemplate, privacyRequestTemplate,
    feedbackSubmission } from '../public/js/shared/feedback-templates.js';

const browsers = new Map();
let screenshots;
before(async () => {
    screenshots = await mkdtemp(join(tmpdir(), 'benchpoll-contribution-ui-'));
    for (const [name, engine] of Object.entries({ chromium, webkit })) {
        browsers.set(name, await engine.launch({ headless: true, env: { ...process.env,
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
            NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } }));
    }
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

function editTarget() {
    return {
        name: 'Existing benchmark', introductionURL: 'https://example.com/benchmark',
        description: 'Original introduction', requestOfficialSync: false, officialSyncURL: '',
        officialSyncInstructions: '', notes: 'Original notes', conditions: [
            { ID: 1, name: 'default', differenceExplanation: 'Original default description', usesPercentageScale: true,
                scoreMin: null, scoreMax: null, scoreDirection: 'higher', targetValue: null, isDefault: true, isPrimary: true },
            { ID: 2, name: 'special', differenceExplanation: 'Different scale', usesPercentageScale: false,
                scoreMin: -1, scoreMax: 4, scoreDirection: 'lower', targetValue: null, isDefault: false, isPrimary: false }
        ]
    };
}

async function fixture(t, engine, { data = catalog(), target = editTarget(), width = 1280 } = {}) {
    const preview = await startPreview({ conditionImpact: { resultCount: 0, pieCount: 0 } });
    const page = await browsers.get(engine).newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
    const errors = [], submissions = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (/not focusable/i.test(message.text())) errors.push(message.text()); });
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/submit_contribution') submissions.push(request.postDataJSON());
    });
    await page.route('**/api/get_contribution_catalog', route => route.fulfill({ json: data }));
    await page.route('**/api/get_contribution_target', route => route.fulfill({
        json: { targetKind: 'benchmark', targetID: 101, form: target }
    }));
    t.after(async () => {
        await page.close();
        await preview.close();
        assert.deepEqual(errors, [], 'No application or hidden-invalid-field errors');
    });
    return { page, preview, submissions };
}

const rows = page => page.locator('[data-condition-key]');
const nameField = row => row.locator('[data-condition-input]');
const descriptionField = row => row.locator('[data-field="differenceExplanation"]');
async function ready(page) { await page.locator('#form-surface:not([hidden])').waitFor(); }
async function focusOn(input) {
    await input.page().waitForFunction(element => document.activeElement === element, await input.elementHandle());
}
async function oneOpen(page, key) {
    await page.waitForFunction(expected => {
        const open = [...document.querySelectorAll('[data-condition-key][open]')];
        return open.length === (expected === null ? 0 : 1) && (expected === null || open[0].dataset.conditionKey === expected);
    }, key);
}
async function submit(page) {
    await page.locator('#submit-contribution').click();
    await page.locator('#submit-success-dialog:not([hidden])').waitFor();
}
async function systemAction(page, label) {
    await page.locator('.global-system-dialog:not([hidden])').getByRole('button', { name: label, exact: true }).click();
    await page.locator('.global-system-dialog').waitFor({ state: 'detached' });
}
async function handoff(page, values, mode = 'feedback') {
    await page.evaluate(async ({ mode, values }) => {
        const navigation = await import('/js/shared/contribution-navigation.js?v=taxonomy-20260929');
        location.assign(navigation.activateContributionURL(navigation.buildContributionURL(mode, values)));
    }, { mode, values });
    await page.waitForEvent('load');
    await ready(page);
}

for (const engine of ['chromium', 'webkit']) {
    test(`${engine}: edit accordion retains names, descriptions, IDs, primary choice and score fields`, async t => {
        const target = editTarget();
        const { page, preview, submissions } = await fixture(t, engine, { target });
        await page.goto(`${preview.url}/contribute/benchmarks/101/edit`);
        await ready(page);
        assert.equal(await rows(page).count(), 2);
        await oneOpen(page, null);
        for (const row of await rows(page).all()) {
            assert.equal(await nameField(row).isVisible(), false);
            assert.equal(await row.locator('[data-action="remove-profile"]').isVisible(), false);
            assert.equal(await row.innerText(), await row.locator('[data-condition-heading]').innerText());
        }
        const first = rows(page).nth(0), second = rows(page).nth(1);
        await first.locator('summary').focus();
        await page.keyboard.press('Enter');
        await oneOpen(page, 'existing-1');
        assert.equal(await first.getByLabel('Name', { exact: true }).inputValue(), 'default');
        await second.locator('summary').click();
        await oneOpen(page, 'existing-2');
        await nameField(second).fill('Renamed special');
        await descriptionField(second).click();
        await systemAction(page, 'Confirm rename');
        await descriptionField(second).fill('Updated version description');
        await second.locator('[data-action="set-primary-condition"]').check();
        await oneOpen(page, 'existing-2');
        await page.locator('[data-field="requestOfficialSync"]').check();
        await page.locator('[data-field="requestOfficialSync"]').uncheck();
        await oneOpen(page, 'existing-2');
        assert.equal(await nameField(second).inputValue(), 'Renamed special');
        assert.equal(await descriptionField(second).inputValue(), 'Updated version description');
        assert.equal(await second.locator('[data-action="set-primary-condition"]').isChecked(), true);
        await first.locator('summary').click();
        await first.locator('summary').press('Space');
        await oneOpen(page, null);
        assert.equal(await second.locator('[data-condition-heading]').innerText(), 'Renamed special');
        await submit(page);
        assert.equal(submissions.length, 1);
        assert.deepEqual(submissions[0].proposed.conditions, [
            { ...target.conditions[0], isPrimary: false },
            { ...target.conditions[1], name: 'Renamed special', differenceExplanation: 'Updated version description', isPrimary: true }
        ]);
    });

    test(`${engine}: new rows focus, invalid collapsed rows reopen, deletion and re-render retain payload`, async t => {
        const { page, preview, submissions } = await fixture(t, engine);
        await page.goto(`${preview.url}/contribute/benchmarks/new`);
        await ready(page);
        await page.locator('[data-evaluation-name]').fill('New accordion benchmark');
        const initialKey = await rows(page).first().getAttribute('data-condition-key');
        await page.getByRole('button', { name: 'Add version', exact: true }).click();
        const added = rows(page).nth(1);
        const addedKey = await added.getAttribute('data-condition-key');
        await focusOn(nameField(added));
        await oneOpen(page, addedKey);
        await added.locator('summary').click();
        await oneOpen(page, null);
        await page.locator('#submit-contribution').click();
        await focusOn(nameField(added));
        await oneOpen(page, addedKey);
        assert.equal(submissions.length, 0);
        await nameField(added).fill('  ');
        await added.locator('summary').click();
        await page.locator('#submit-contribution').click();
        await focusOn(nameField(added));
        assert.equal(await nameField(added).getAttribute('aria-invalid'), 'true');
        await nameField(added).fill('default');
        await added.locator('summary').click();
        await page.locator('#submit-contribution').click();
        await focusOn(nameField(rows(page).first()));
        await oneOpen(page, initialKey);
        assert.match(await nameField(rows(page).first()).evaluate(input => input.validationMessage), /unique names/);
        await added.locator('summary').click();
        await nameField(added).fill('Version two');
        await descriptionField(added).fill('Version two typed description');
        await added.locator('[data-action="set-primary-condition"]').check();
        await page.getByRole('button', { name: 'Add version', exact: true }).click();
        await focusOn(nameField(rows(page).last()));
        const removedKey = await rows(page).last().getAttribute('data-condition-key');
        await rows(page).last().getByRole('button', { name: 'Remove version', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('[data-condition-key]').length === 2);
        await oneOpen(page, addedKey);
        await page.getByRole('button', { name: 'Add version', exact: true }).click();
        await focusOn(nameField(rows(page).last()));
        const replacementKey = await rows(page).last().getAttribute('data-condition-key');
        assert.ok(![initialKey, addedKey, removedKey].includes(replacementKey));
        await rows(page).last().getByRole('button', { name: 'Remove version', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('[data-condition-key]').length === 2);
        await oneOpen(page, addedKey);
        assert.equal(await nameField(added).inputValue(), 'Version two');
        assert.equal(await descriptionField(added).inputValue(), 'Version two typed description');
        assert.equal(await added.locator('[data-action="set-primary-condition"]').isChecked(), true);
        await added.locator('summary').click();
        await submit(page);
        const conditions = submissions[0].benchmarks[0].conditions;
        assert.deepEqual(conditions.map(({ clientRef, name, differenceExplanation, isPrimary }) =>
            ({ clientRef, name, differenceExplanation, isPrimary })), [
            { clientRef: initialKey, name: 'default', differenceExplanation: '', isPrimary: false },
            { clientRef: addedKey, name: 'Version two', differenceExplanation: 'Version two typed description', isPrimary: true }
        ]);
    });

    test(`${engine}: linked-version deletion guard, cancelled rename and last-version guard remain intact`, async t => {
        const { page, preview, submissions } = await fixture(t, engine);
        let impact = { resultCount: 3, pieCount: 2 };
        await page.route('**/api/get_condition_impact', route => route.fulfill({ json: impact }));
        await page.goto(`${preview.url}/contribute/benchmarks/101/edit`);
        await ready(page);
        await rows(page).first().locator('summary').click();
        await nameField(rows(page).first()).fill('Cancelled rename');
        await descriptionField(rows(page).first()).click();
        await systemAction(page, 'Cancel');
        assert.equal(await nameField(rows(page).first()).inputValue(), 'default');
        assert.equal(await rows(page).first().locator('[data-condition-heading]').innerText(), 'default');
        await rows(page).first().getByRole('button', { name: 'Remove version', exact: true }).click();
        await page.locator('.global-system-dialog:not([hidden])').waitFor();
        assert.match(await page.locator('.global-system-dialog').innerText(), /cannot be deleted/);
        await systemAction(page, 'OK');
        assert.equal(await rows(page).count(), 2);
        impact = { resultCount: 0, pieCount: 0 };
        await rows(page).first().getByRole('button', { name: 'Remove version', exact: true }).click();
        await systemAction(page, 'Cancel');
        assert.equal(await rows(page).count(), 2);
        await rows(page).first().getByRole('button', { name: 'Remove version', exact: true }).click();
        await systemAction(page, 'Request deletion');
        await page.waitForFunction(() => document.querySelectorAll('[data-condition-key]').length === 1);
        await oneOpen(page, 'existing-2');
        assert.equal(await rows(page).first().locator('[data-action="set-primary-condition"]').isChecked(), true);
        await rows(page).first().getByRole('button', { name: 'Remove version', exact: true }).click();
        await page.locator('#contribution-notice-dialog:not([hidden])').waitFor();
        assert.match(await page.locator('#contribution-notice-title').innerText(), /Keep one version/);
        await page.locator('#contribution-notice-dialog .dialog-close-button').click();
        await submit(page);
        assert.deepEqual(submissions[0].proposed.conditions, [{ ...editTarget().conditions[1], isPrimary: true }]);
    });

    test(`${engine}: benchmark search handoff opens and focuses only the added version`, async t => {
        const { page, preview } = await fixture(t, engine);
        await page.goto(`${preview.url}/contribute/benchmarks/new`);
        await ready(page);
        await page.locator('[data-evaluation-name]').fill('General knowledge');
        await page.locator('[data-select-evaluation="101"]').first().click();
        await page.waitForURL(`${preview.url}/contribute/benchmarks/101/edit`);
        await ready(page);
        assert.equal(await rows(page).count(), 3);
        await oneOpen(page, await rows(page).last().getAttribute('data-condition-key'));
        await focusOn(nameField(rows(page).last()));
        assert.equal(await nameField(rows(page).last()).inputValue(), '');
    });

    test(`${engine}: retained add-to-existing renderer keeps locked controls inside the accordion`, async t => {
        const { page, preview } = await fixture(t, engine);
        // Search now redirects to edit; exercise the retained locked branch without changing production routing.
        await page.route('**/js/contribute.js*', async route => {
            const response = await route.fetch();
            await route.fulfill({ response, body: await response.text() + `\n
                globalThis.openLockedContributionFixture = () => {
                    selectedEvaluation().existingBenchmarkID = 101;
                    renderCurrentStep();
                };` });
        });
        await page.goto(`${preview.url}/contribute/benchmarks/new`);
        await ready(page);
        await page.evaluate(() => globalThis.openLockedContributionFixture());
        const locked = page.locator('[data-existing-condition]').first();
        assert.equal(await locked.innerText(), 'default');
        assert.equal(await locked.getByRole('button').isVisible(), false);
        await locked.locator('summary').click();
        await oneOpen(page, 'locked-1');
        assert.equal(await locked.getByLabel('Name', { exact: true }).getAttribute('readonly'), '');
        assert.equal(await locked.getByLabel('Description', { exact: true }).getAttribute('readonly'), '');
        assert.equal(await locked.locator('[data-bind], [data-action="remove-profile"]').count(), 0);
        await locked.getByRole('button', { name: 'Existing versions cannot be removed here' }).click();
        await page.locator('#contribution-notice-dialog:not([hidden])').waitFor();
        await page.locator('#contribution-notice-dialog .dialog-close-button').click();
        await page.getByRole('button', { name: 'Add version', exact: true }).click();
        await focusOn(nameField(rows(page).last()));
        await oneOpen(page, await rows(page).last().getAttribute('data-condition-key'));
        assert.equal(await locked.getByRole('button').isVisible(), false);
        assert.equal(await locked.getByLabel('Name', { exact: true }).inputValue(), 'default');
    });

    test(`${engine}: workspace bulk-import handoff suppresses its matching sidebar action`, async t => {
        const { page, preview } = await fixture(t, engine);
        await page.goto(`${preview.url}/Intelligence`);
        await page.locator('#benchmark-search').fill('Synthetic missing benchmark xyz');
        await page.getByRole('link', { name: 'Request bulk import', exact: true }).click();
        await ready(page);
        await page.locator('#feedback-guidance').filter({ hasText: 'Synthetic missing benchmark xyz' }).waitFor();
        assert.equal(await page.locator('#contribution-bulk-import').count(), 0);
        assert.equal(await page.locator('.contribution-sidebar-actions a[href="/contribute/feedback"]').isVisible(), true);
        await page.reload();
        await ready(page);
        assert.equal(await page.locator('#contribution-bulk-import').count(), 0);
    });

    test(`${engine}: sidebar self-links use form identity and keep other feedback entries`, async t => {
        const { page, preview, submissions } = await fixture(t, engine);
        const feedbackLink = page.locator('.contribution-sidebar-actions a[href="/contribute/feedback"]');
        const bulkButton = page.locator('#contribution-bulk-import');
        await page.goto(`${preview.url}/contribute/feedback`);
        await ready(page);
        assert.equal(await feedbackLink.count(), 0);
        assert.equal(await bulkButton.isVisible(), true);
        await bulkButton.click();
        await page.locator('#feedback-guidance').filter({ hasText: bulkImportTemplate() }).waitFor();
        assert.equal(await bulkButton.count(), 0);
        assert.equal(await feedbackLink.isVisible(), true);
        await page.reload();
        await ready(page);
        assert.equal(await bulkButton.count(), 0, 'Stable template identity survives reload');
        for (const targetKind of ['benchmark', 'bulk_import']) {
            await page.goto(`${preview.url}/contribute/benchmarks/new`);
            await ready(page);
            await handoff(page, { targetKind });
            assert.equal(await feedbackLink.count(), 0, 'A target kind alone is not an instruction template');
            assert.equal(await bulkButton.isVisible(), true);
        }
        for (const details of [betaFeedbackTemplate(), privacyRequestTemplate(),
            mergeRequestTemplate({ name: 'Existing benchmark', kind: 'benchmark', ID: 101 }),
            'Request bulk import is a quoted button label, not a template ID.']) {
            await page.goto(`${preview.url}/contribute/benchmarks/new`);
            await ready(page);
            await handoff(page, { details });
            assert.equal(await feedbackLink.isVisible(), true);
            assert.equal(await bulkButton.isVisible(), true);
        }
        const details = 'Provide the official source links for this request.';
        await page.goto(`${preview.url}/contribute/benchmarks/new`);
        await ready(page);
        await handoff(page, { targetKind: 'bulk_import', details });
        assert.equal(await bulkButton.count(), 0, 'Template ID wins independently of instruction wording');
        assert.equal(await feedbackLink.isVisible(), true);
        const message = 'Import the named benchmarks and keep their source links.';
        await page.locator('[data-bind="feedback"]').fill(message);
        await submit(page);
        assert.equal(submissions.at(-1).details, feedbackSubmission(details, message));
    });

    test(`${engine}: picker evidence counts include icon, meaning, unknown state and no nested tab stop`, async t => {
        const data = catalog();
        const benchmark = data.benchmarks[0], base = benchmark.conditions[0];
        const counts = [0, 1, 27, undefined, null, -1, 1.5, '3'];
        benchmark.conditions = counts.map((scoreCount, index) => ({ ...base, ID: 2000 + index,
            name: `Count version ${index}`, isPrimary: index === 0, isDefault: false, scoreCount }));
        const { page, preview } = await fixture(t, engine, { data });
        const check = async buttons => {
            for (const summary of await page.locator('.condition-suggestion-fold:not([open]) > summary').all()) await summary.click();
            assert.equal(await buttons.count(), counts.length);
            for (let index = 0; index < counts.length; index++) {
                const badge = buttons.nth(index).locator('.bp-evidence-count');
                const known = index < 3;
                const description = known ? `${counts[index]} approved ${counts[index] === 1 ? 'score' : 'scores'}.`
                    : 'Approved score count unavailable.';
                assert.equal(await badge.getAttribute('data-tooltip'), description);
                assert.equal(await badge.getAttribute('aria-label'), description);
                assert.equal(await badge.getAttribute('role'), 'img');
                assert.equal(await badge.getAttribute('tabindex'), null);
                assert.equal(await badge.innerText(), known ? String(counts[index]) : '?');
                assert.equal(await badge.locator('i.fa-chart-simple[aria-hidden="true"]').count(), 1);
                const style = await badge.evaluate(element => {
                    const css = getComputedStyle(element);
                    return { display: css.display, gap: css.gap, minHeight: css.minHeight };
                });
                assert.ok(['flex', 'inline-flex'].includes(style.display));
                assert.equal(style.gap, '4px');
                assert.equal(style.minHeight, '24px');
            }
        };
        await page.goto(`${preview.url}/contribute/benchmarks/new`);
        await ready(page);
        await page.locator('[data-evaluation-name]').fill('General knowledge');
        await page.locator('[data-select-evaluation]').first().waitFor();
        await check(page.locator('[data-select-evaluation]'));
        await page.goto(`${preview.url}/contribute/scores/new`);
        await ready(page);
        await page.locator('[data-result-object-query]').fill('General knowledge');
        await page.locator('[data-select-result-object]').first().waitFor();
        await check(page.locator('[data-select-result-object]'));
        await page.locator('[data-select-result-object]').first().click();
        await page.locator('[data-catalog-picker="benchmark-condition"] > summary').click();
        await check(page.locator('[data-select-result-profile]'));
        await page.screenshot({ path: join(screenshots, `${engine}-counts.png`), fullPage: true });
        t.diagnostic(`Screenshots: ${screenshots}`);
    });

    test(`${engine}: long version names fit desktop and mobile with expanded controls`, async t => {
        const target = editTarget();
        target.conditions[1].name = 'LegacyVersion'.repeat(14);
        const { page, preview } = await fixture(t, engine, { target });
        await page.goto(`${preview.url}/contribute/benchmarks/101/edit`);
        await ready(page);
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 960 });
            await rows(page).nth(1).locator('summary').click();
            await oneOpen(page, 'existing-2');
            const geometry = await rows(page).nth(1).evaluate(row => {
                const bounds = row.getBoundingClientRect(), summary = row.querySelector('summary').getBoundingClientRect();
                const fields = row.querySelector('.condition-version-fields').getBoundingClientRect();
                const children = [...row.querySelectorAll('input, textarea, button')].map(element => element.getBoundingClientRect());
                return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
                    ordered: summary.bottom <= fields.top + 1,
                    contained: children.every(child => child.left >= bounds.left && child.right <= bounds.right + 1) };
            });
            assert.deepEqual(geometry, { overflow: false, ordered: true, contained: true });
            await page.screenshot({ path: join(screenshots, `${engine}-accordion-${width}.png`), fullPage: true });
            await rows(page).nth(1).locator('summary').click();
            await oneOpen(page, null);
        }
        t.diagnostic(`Screenshots: ${screenshots}`);
    });
}
