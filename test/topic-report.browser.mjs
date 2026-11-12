import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const fixture = await startPreview({ authenticated: true });
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [], submissions = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (request.url().endsWith('/api/submit_contribution')) submissions.push(request.postDataJSON());
    });
    await page.route('**/report-entry', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <link rel="stylesheet" href="/css/ui/navigation.css">
        <main id="card"></main><script type="module">
        import { createTopicReportButton } from '/js/shared/topic-actions.js';
        const card = document.querySelector('#card');
        card.onclick = () => { window.cardNavigated = true; };
        card.append(createTopicReportButton({ ID: -400, categoryID: 1, name: 'Untrusted title', url: '/1' }));
        </script>` }));
    await page.goto(fixture.url + '/report-entry');
    const report = page.getByRole('link', { name: 'Report this topic' });
    assert.match(await report.getAttribute('href'), /\/contribute\/topics\/1\/report#entry=/);
    await report.click();
    await page.locator('#form-surface:not([hidden])').waitFor();
    assert.equal(new URL(page.url()).pathname, '/contribute/topics/1/report');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('#contribute-title').textContent(), 'Report a topic');
    const metadata = await page.request.post(fixture.url + '/api/get_topic', { data: { categoryID: 1 } }).then(response => response.json());
    assert.equal(await page.locator('input:disabled').inputValue(), metadata.name);
    await page.locator('textarea[data-bind="report"][data-field="details"]').fill('This topic needs a clearer description of its scope.');
    await page.locator('#submit-contribution').click();
    await page.locator('#submit-success-dialog:not([hidden])').waitFor();
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].type, 'report_issue');
    assert.equal(submissions[0].issueType, 'topic_report');
    assert.equal(submissions[0].targetCategoryID, 1);
    assert.equal(submissions[0].targetKind, 'category');
    assert.equal(submissions[0].targetName, metadata.name);
    assert.equal(submissions[0].pageURL, fixture.url + metadata.url);
    assert.equal(Object.hasOwn(submissions[0], 'targetBenchmarkID'), false);
    assert.deepEqual(errors, []);
    console.log('Topic report icon, handoff, canonical target and real submission parser passed.');
} finally {
    await browser.close();
    await fixture.close();
}
