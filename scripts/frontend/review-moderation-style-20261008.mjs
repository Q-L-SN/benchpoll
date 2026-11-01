import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = fileURLToPath(new URL('../../artifacts/review-20261008/', import.meta.url));
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const viewports = [
    { name: 'desktop', width: 1440, height: 960 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'small-mobile', width: 320, height: 780 }
];

function fixtureOptions() {
    return { userID: '1', isSenior: true,
        logs: [{ ID: 901, status: 'pending', created_at: '2026-10-08T01:00:00Z', userName: 'Fixture contributor',
            content: { schemaVersion: 1, type: 'feedback', pageURL: 'https://example.com/reviewer-evidence',
                details: 'Compare the official score source with the contributed score before approval.' } }],
        syncConflicts: [{ row_key: 'style-review-row', result_ID: 77, incoming_hash: 'a'.repeat(64), status: 'pending',
            modelName: 'Fixture model', benchmarkName: 'Fixture benchmark', conditionName: 'Overall',
            currentScore: 82, currentStatus: 'approved', manualOverride: 'corrected',
            currentFields: [{ name: 'Configuration', value: 'Standard evaluation' }],
            currentNotes: 'Manually checked against the published evaluation.', incoming_row: { rawScore: 83 } }],
        adminMessages: [{ ID: 100, senderUserID: 3, createdAt: '2026-10-08T01:00:00Z', isRead: false,
            body: 'Please compare the current source evidence before approving this contribution.' },
        { ID: 101, senderUserID: 4, createdAt: '2026-10-08T01:10:00Z', isRead: true,
            body: 'The previous source check is complete.' }] };
}

async function decorationSnapshot(locator) {
    return locator.evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const borders = Object.fromEntries(['Top', 'Right', 'Bottom', 'Left'].map(side => [side.toLowerCase(), {
            width: style[`border${side}Width`], color: style[`border${side}Color`], style: style[`border${side}Style`]
        }]));
        const pseudo = selector => {
            const value = getComputedStyle(element, selector);
            return { content: value.content, width: value.width, height: value.height,
                left: value.left, right: value.right, background: value.backgroundColor, shadow: value.boxShadow };
        };
        return { className: element.className, borders, shadow: style.boxShadow,
            background: style.backgroundColor, paddingLeft: style.paddingLeft,
            before: pseudo('::before'), after: pseudo('::after'),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }));
}

async function fitSnapshot(page, selectors) {
    return page.evaluate(selectors => {
        const outside = [], overflow = [], textOutside = [];
        for (const selector of selectors) for (const element of document.querySelectorAll(selector)) {
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            const label = `${selector}: ${element.textContent.trim().slice(0, 80)}`;
            if (rect.left < -1 || rect.right > innerWidth + 1) outside.push(label);
            if (element.scrollWidth > element.clientWidth + 1) overflow.push(label);
            // Range bounds catch clipped labels even when page overflow is hidden.
            if (element.matches('button, .field-name, .field-value:not(.json-value), .admin-message p')) {
                const range = document.createRange();
                range.selectNodeContents(element);
                if ([...range.getClientRects()].some(text => text.left < rect.left - 1 || text.right > rect.right + 1)) {
                    textOutside.push(label);
                }
            }
        }
        return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
            outside, overflow, textOutside };
    }, selectors);
}

export async function keyboardFocus(page, selector) {
    if (await page.locator(selector).evaluate(element => element.matches('select.bp-ui-select-native'))) {
        selector += ' + .bp-ui-select [role="combobox"]';
    }
    // Reach the control by a real Tab key, not by synthetic focus().
    const restingShadow = await page.locator(selector).evaluate(element => getComputedStyle(element).boxShadow);
    for (let attempt = 0; attempt < 100; attempt++) {
        await page.keyboard.press('Tab');
        const focused = await page.locator(selector).evaluate(element => element === document.activeElement);
        if (!focused) continue;
        const style = await page.locator(selector).evaluate(element => {
            const value = getComputedStyle(element), rect = element.getBoundingClientRect();
            return { focusVisible: element.matches(':focus-visible'), outlineStyle: value.outlineStyle,
                outlineWidth: value.outlineWidth, outlineColor: value.outlineColor, outlineOffset: value.outlineOffset,
                shadow: value.boxShadow,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        });
        assert.equal(style.focusVisible, true, `${selector} must be keyboard-focused`);
        style.indicatorVisible = (style.shadow !== 'none' && style.shadow !== restingShadow)
            || (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0);
        assert.equal(style.indicatorVisible, true, `${selector} must retain a visible focus indicator`);
        assert.ok(style.rect.x >= -1 && style.rect.x + style.rect.width <= await page.evaluate(() => innerWidth) + 1,
            `${selector} must fit while focused`);
        return style;
    }
    assert.fail(`${selector} was not reachable by Tab`);
}

function assertFields(fields) {
    assert.ok(fields.length, 'Current renderer must create field groups');
    for (const field of fields) {
        assert.equal(field.paddingLeft, '14px', 'Preserve existing field indentation');
        assert.ok(Object.values(field.borders).every(border => border.width === '0px'), 'No field-group stripe');
        assert.equal(field.shadow, 'none', 'No replacement inset stripe');
        for (const pseudo of [field.before, field.after]) assert.ok(['none', 'normal'].includes(pseudo.content),
            'No replacement pseudo-element stripe');
    }
}

function assertFit(fit) {
    assert.ok(fit.documentWidth <= fit.viewportWidth + 1, 'Page must not overflow horizontally');
    assert.deepEqual(fit.outside, [], 'Relevant containers and controls must remain in the viewport');
    assert.deepEqual(fit.overflow, [], 'Relevant containers must not hide overflowing content');
    assert.deepEqual(fit.textOutside, [], 'Text must fit its own container');
}

export async function navigationSnapshot(page) {
    return page.evaluate(() => {
        const nav = document.querySelector('.workspace-tabs');
        const tab = nav.querySelector('[aria-selected="true"]');
        const bounds = nav.getBoundingClientRect(), target = tab.getBoundingClientRect();
        const badge = document.getElementById('message-unread-count');
        return { activeView: tab.dataset.workspaceView, scrollLeft: nav.scrollLeft, scrollTop: nav.scrollTop,
            clientWidth: nav.clientWidth, scrollWidth: nav.scrollWidth, activeLeft: target.left - bounds.left,
            activeRight: target.right - bounds.left, activeTabFullyVisible: target.left >= bounds.left - 1
                && target.right <= bounds.right + 1, badgeHidden: badge.hidden, badgeText: badge.textContent,
            messageTabWidth: document.getElementById('messages-tab').getBoundingClientRect().width,
            documentX: scrollX, documentY: scrollY, documentScrolls: window.moderationStyleScrolls ?? 0 };
    });
}

async function settleNavigation(page, requireVisible = false) {
    let previous, stable = 0;
    for (let attempt = 0; attempt < 160; attempt++) {
        const current = await navigationSnapshot(page);
        stable = previous && Math.abs(previous.scrollLeft - current.scrollLeft) < 0.1
            && previous.documentY === current.documentY ? stable + 1 : 0;
        if (stable >= 4 && (!requireVisible || current.activeTabFullyVisible)) return current;
        previous = current;
        await page.waitForTimeout(25);
    }
    assert.fail(`Selected tab did not settle fully visible: ${JSON.stringify(previous)}`);
}

function assertNoPageJump(before, after) {
    assert.equal(after.documentX, before.documentX, 'Count callbacks must not scroll the document horizontally');
    assert.equal(after.documentY, before.documentY, 'Count callbacks must not scroll the document vertically');
    assert.equal(after.documentScrolls, before.documentScrolls, 'No transient document jump');
}

export async function verifyMessageTabLifecycle(page, { url, capture = async () => {} }) {
    const lists = [], reads = [], steps = [];
    const defer = pending => async route => {
        let release;
        const payload = new Promise(resolve => { release = resolve; });
        const request = { release, finished: false, body: route.request().postDataJSON() };
        pending.push(request);
        try { await route.fulfill({ json: await payload }); }
        finally { request.finished = true; }
    };
    const listRoute = defer(lists), readRoute = defer(reads);
    const waitHeld = async (pending, count) => {
        for (let attempt = 0; pending.length < count && attempt < 160; attempt++) await page.waitForTimeout(25);
        assert.ok(pending.length >= count, `Expected ${count} held requests, received ${pending.length}`);
    };
    const release = async (pending, index, payload) => {
        pending[index].release(payload);
        for (let attempt = 0; !pending[index].finished && attempt < 160; attempt++) await page.waitForTimeout(25);
        assert.equal(pending[index].finished, true, 'Held response must complete');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const messages = (count, label) => Array.from({ length: count }, (_, index) => ({ ID: 1000 + index,
        senderUserID: 3, createdAt: '2026-10-08T01:00:00Z', isRead: false, body: `${label} ${index + 1}` }));
    const badge = value => page.waitForFunction(value => {
        const count = document.getElementById('message-unread-count');
        return count.textContent === String(value) && count.hidden === (value === 0);
    }, value);
    const checkpoint = async (name, before, count, { inactive = false } = {}) => {
        await badge(count);
        const after = await settleNavigation(page, !inactive);
        assertNoPageJump(before, after);
        if (inactive) {
            assert.equal(after.activeView, before.activeView, 'Inactive count update must not switch views');
            assert.ok(Math.abs(after.scrollLeft - before.scrollLeft) <= 1, 'Inactive callback must preserve manual tab scrolling');
            assert.ok(Math.abs(after.activeLeft - before.activeLeft) <= 1, 'Inactive callback must not move the selected tab');
        } else assert.equal(after.activeView, 'messages');
        steps.push({ name, before, after, passed: true });
        await capture(name);
        return after;
    };
    const manualPosition = async () => {
        await settleNavigation(page, true);
        await page.evaluate(() => {
            const nav = document.querySelector('.workspace-tabs');
            nav.scrollTo({ left: Math.min(43, nav.scrollWidth - nav.clientWidth), behavior: 'instant' });
            window.scrollTo({ top: 80, behavior: 'instant' });
        });
        return settleNavigation(page);
    };
    await page.route('**/api/list_admin_messages', listRoute);
    await page.route('**/api/mark_admin_message_read', readRoute);
    try {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(`${url}/censor`);
        await page.locator('#log-list .field-grid').waitFor();
        await page.evaluate(() => document.fonts.ready);
        // Test-only document slack prevents content-height clamping from masking a page-scroll regression.
        await page.evaluate(() => {
            const slack = document.createElement('div');
            slack.id = 'moderation-style-scroll-slack';
            slack.style.height = '2000px';
            document.body.append(slack);
            window.moderationStyleScrolls = 0;
            window.moderationStyleScrollListener = () => { window.moderationStyleScrolls++; };
            window.addEventListener('scroll', window.moderationStyleScrollListener);
        });
        await page.locator('#sync-tab').click();
        await page.locator('#sync-list .field-grid').waitFor();
        await keyboardFocus(page, '#sync-tab');
        await page.keyboard.press('ArrowRight');
        await waitHeld(lists, 1);
        await page.evaluate(() => window.scrollTo({ top: 80, behavior: 'instant' }));
        const initial = await settleNavigation(page, true);
        assert.equal(initial.activeView, 'messages', 'Activate Messages by the real arrow-key handler');
        assert.equal(initial.documentY, 80, 'Exercise count callbacks on a genuinely scrolled document');
        assert.equal(initial.badgeHidden, true);
        await release(lists, 0, { messages: messages(12, 'Initial current list') });
        const populated = await checkpoint('active-delayed-count', initial, 12);
        assert.ok(populated.messageTabWidth > initial.messageTabWidth + 1, 'Badge must use dynamic width, not reserved space');

        await page.locator('#messages-refresh').click();
        await waitHeld(lists, 2);
        await page.locator('#sync-tab').click();
        const inactive = await manualPosition();
        await release(lists, 1, { messages: messages(100, 'Background current list') });
        const grown = await checkpoint('inactive-count-digit-growth', inactive, 100, { inactive: true });
        assert.ok(grown.messageTabWidth > populated.messageTabWidth + 1, 'Three-digit badge must grow naturally');

        await page.locator('#messages-tab').click();
        await settleNavigation(page, true);
        await page.locator('#messages-refresh').click();
        await waitHeld(lists, 3);
        await page.locator('#messages-refresh').click();
        await waitHeld(lists, 4);
        const refreshing = await settleNavigation(page, true);
        await release(lists, 3, { messages: messages(4, 'Latest list wins') });
        const latest = await checkpoint('latest-list-response', refreshing, 4);
        await release(lists, 2, { messages: messages(111, 'Stale list must not render') });
        const stale = await checkpoint('stale-list-response', latest, 4);
        assert.equal(stale.scrollLeft, latest.scrollLeft);
        assert.equal(await page.getByText('Stale list must not render 1', { exact: true }).count(), 0);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.getByRole('button', { name: 'Mark as read', exact: true }).first().click();
        await waitHeld(reads, 1);
        const reading = await settleNavigation(page, true);
        await release(reads, 0, { messageID: reads[0].body.messageID, isRead: true });
        await checkpoint('active-mark-as-read', reading, 3);

        await page.getByRole('button', { name: 'Mark as read', exact: true }).first().click();
        await waitHeld(reads, 2);
        await page.locator('#sync-tab').click();
        const backgroundRead = await manualPosition();
        await release(reads, 1, { messageID: reads[1].body.messageID, isRead: true });
        await checkpoint('inactive-mark-as-read', backgroundRead, 2, { inactive: true });

        await page.locator('#messages-tab').click();
        await page.getByRole('button', { name: 'Mark as read', exact: true }).first().click();
        await waitHeld(reads, 3);
        await page.locator('#messages-refresh').click();
        await waitHeld(lists, 5);
        const beforeFresh = await settleNavigation(page, true);
        await release(lists, 4, { messages: messages(7, 'Fresh list after read') });
        const fresh = await checkpoint('refresh-before-read-ack', beforeFresh, 7);
        await release(reads, 2, { messageID: reads[2].body.messageID, isRead: true });
        const staleRead = await checkpoint('stale-read-ack', fresh, 7);
        assert.equal(staleRead.scrollLeft, fresh.scrollLeft);
        assert.equal(await page.getByText('Fresh list after read 1', { exact: true }).count(), 1);

        await page.locator('#messages-refresh').click();
        await waitHeld(lists, 6);
        const clearing = await settleNavigation(page, true);
        await release(lists, 5, { messages: [] });
        const empty = await checkpoint('zero-count-removal', clearing, 0);
        assert.ok(Math.abs(empty.messageTabWidth - initial.messageTabWidth) <= 1, 'No reserved badge width when empty');
        return { steps, listRequests: lists.length, readRequests: reads.length, passed: true };
    } finally {
        for (const pending of [...lists, ...reads]) if (!pending.finished) pending.release({ messages: [], isRead: true });
        for (let attempt = 0; [...lists, ...reads].some(request => !request.finished) && attempt < 80; attempt++) {
            await page.waitForTimeout(25);
        }
        await page.unroute('**/api/list_admin_messages', listRoute);
        await page.unroute('**/api/mark_admin_message_read', readRoute);
        await page.evaluate(() => {
            document.getElementById('moderation-style-scroll-slack')?.remove();
            window.removeEventListener('scroll', window.moderationStyleScrollListener);
        });
    }
}

async function originalEvidenceHashes() {
    const root = fileURLToPath(new URL('../../artifacts/review-20261008/', import.meta.url));
    const files = (await readdir(root)).filter(name => name.startsWith('moderation-style-before-')
        || name.startsWith('moderation-style-replay-before-')).sort();
    return Object.fromEntries(await Promise.all(files.map(async name => [name,
        createHash('sha256').update(await readFile(`${root}/${name}`)).digest('hex')])));
}

async function runReview() {
const phase = process.argv.includes('--residual-before') ? 'residual-before' : 'residual-after';
assert.ok(!process.argv.includes('--before') && !process.argv.includes('--replay-before'),
    'Original before/replay evidence is immutable. Use --residual-before for this continuation baseline.');
const prefix = name => `${output}/moderation-style-${phase}-${name}`;
const css = await readFile(new URL('../../public/css/censor.css', import.meta.url), 'utf8');
const client = await readFile(new URL('../../public/js/censor.js', import.meta.url), 'utf8');
const originals = await originalEvidenceHashes();
const policyURL = new URL('../../public/css/ui/control-policy.css', import.meta.url);
const policyHash = createHash('sha256').update(await readFile(policyURL)).digest('hex');
const results = [];
await mkdir(output, { recursive: true });
await writeFile(prefix('source.css'), css, { flag: phase === 'residual-before' ? 'wx' : 'w' });
await writeFile(prefix('source.js'), client, { flag: phase === 'residual-before' ? 'wx' : 'w' });
await writeFile(prefix('original-evidence.json'), JSON.stringify(originals, null, 2),
    { flag: phase === 'residual-before' ? 'wx' : 'w' });
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const viewport of viewports) {
            const app = await startPreview(fixtureOptions());
            const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
                isMobile: viewport.name !== 'desktop', hasTouch: viewport.name !== 'desktop', reducedMotion: 'reduce' });
            const page = await context.newPage();
            page.setDefaultTimeout(8000);
            const name = `${engine}-${viewport.name}`;
            const record = { engine, browserVersion: browser.version(), viewport, phase, passed: false,
                errors: [], failedResponses: [], externalRequests: [], views: {}, focus: {} };
            results.push(record);
            try {
                page.on('pageerror', error => record.errors.push(error.message));
                page.on('response', response => { if (response.status() >= 400) record.failedResponses.push(response.url()); });
                await context.route('**/*', route => {
                    if (new URL(route.request().url()).origin === app.url) return route.continue();
                    record.externalRequests.push(route.request().url());
                    return route.abort('blockedbyclient');
                });
                // Pin the exact captured working-tree CSS, leaving shared fixture files untouched.
                await page.route('**/css/censor.css?*', route => route.fulfill({ contentType: 'text/css; charset=utf-8', body: css }));
                await page.route('**/js/censor.js?*', route => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: client }));
                await page.goto(`${app.url}/censor`);
                await page.locator('#log-list .field-grid').waitFor();
                await page.evaluate(() => document.fonts.ready);
                record.views.queue = { fields: await decorationSnapshot(page.locator('#log-list .field-grid')),
                    fit: await fitSnapshot(page, ['.censor-page', '#log-list .log-item', '#log-list .field-grid',
                        '#log-list .field-name', '#log-list .field-value', '#log-list .log-actions', '#log-list .action-button']) };
                assertFields(record.views.queue.fields);
                assertFit(record.views.queue.fit);
                await page.screenshot({ path: prefix(`${name}-queue.png`), fullPage: true });
                record.focus.queueTab = await keyboardFocus(page, '#queue-tab');
                record.focus.statusFilter = await keyboardFocus(page, '#status-filter');
                if (phase === 'residual-after') {
                    assert.equal(record.focus.statusFilter.outlineStyle, 'solid');
                    assert.equal(record.focus.statusFilter.outlineWidth, '2px');
                    assert.equal(record.focus.statusFilter.outlineOffset, '-3px');
                    assert.equal(record.focus.statusFilter.shadow, 'none', 'Use one internal focus cue, no halo');
                }
                await page.screenshot({ path: prefix(`${name}-status-focus.png`), fullPage: true });
                record.focus.queueAction = await keyboardFocus(page, '#log-list .action-button.edit');
                await page.screenshot({ path: prefix(`${name}-queue-focus.png`), fullPage: true });

                await page.locator('#log-list .action-button.edit').click();
                await page.locator('#editor-overlay').waitFor({ state: 'visible' });
                await page.locator('#editor-fields [name="details"]').fill('Synthetic editor draft; no submission.');
                record.focus.editorClose = await keyboardFocus(page, '#editor-overlay .panel-close');
                record.views.editor = { fit: await fitSnapshot(page, ['#editor-overlay .moderation-panel',
                    '#editor-overlay .editor-field', '#editor-overlay input', '#editor-overlay textarea',
                    '#editor-overlay .panel-close', '#editor-overlay .action-button']) };
                assertFit(record.views.editor.fit);
                await page.screenshot({ path: prefix(`${name}-editor-focus.png`), fullPage: false });
                await page.keyboard.press('Escape');
                await page.locator('#editor-overlay').waitFor({ state: 'hidden' });

                await page.locator('#sync-tab').click();
                await page.locator('#sync-list .field-grid').waitFor();
                record.views.conflicts = { fields: await decorationSnapshot(page.locator('#sync-list .field-grid')),
                    fit: await fitSnapshot(page, ['#sync-list .log-item', '#sync-list .field-grid', '#sync-list .field-name',
                        '#sync-list .field-value', '#sync-list .log-actions', '#sync-list .action-button']) };
                assertFields(record.views.conflicts.fields);
                assertFit(record.views.conflicts.fit);
                record.focus.conflictAction = await keyboardFocus(page, '#sync-list .action-button.approve');
                await page.screenshot({ path: prefix(`${name}-conflicts.png`), fullPage: true });

                await page.locator('#messages-tab').click();
                await page.locator('#message-list .admin-message.unread').waitFor();
                record.views.messages = { cards: await decorationSnapshot(page.locator('#message-list .admin-message')),
                    fit: await fitSnapshot(page, ['#message-list .admin-message', '#message-list .admin-message-header',
                        '#message-list .admin-message p', '#message-list .action-button']) };
                record.views.messages.navigation = await settleNavigation(page, true);
                const unread = record.views.messages.cards.find(card => card.className.includes('unread'));
                assert.ok(unread && Object.values(unread.borders).every(border => border.width === '1px'
                    && border.color === unread.borders.left.color), 'Preserve existing complete unread border');
                assert.ok(!unread.shadow.includes('inset'), 'Preserve the existing removal of the unread inset stripe');
                assertFit(record.views.messages.fit);
                record.focus.readMessage = await keyboardFocus(page, '#message-list .action-button');
                await page.screenshot({ path: prefix(`${name}-messages-focus.png`), fullPage: true });
                await page.getByRole('button', { name: 'Mark as read', exact: true }).click();
                await page.locator('#message-list .admin-message.unread').waitFor({ state: 'hidden' });
                assert.equal(await page.locator('#message-unread-count').isVisible(), false, 'Read state remains functional');
                record.views.readMessages = await decorationSnapshot(page.locator('#message-list .admin-message'));
                record.lifecycle = await verifyMessageTabLifecycle(page, { url: app.url,
                    capture: step => page.screenshot({ path: prefix(`${name}-${step}.png`), fullPage: false }) });
                assert.deepEqual(record.errors, [], 'No unhandled browser errors');
                assert.deepEqual(record.failedResponses, [], 'All local fixture assets and API reads must load');
                assert.deepEqual(record.externalRequests, [], 'No external requests');
                record.requests = app.state.requests.map(request => request.path);
                assert.ok(record.requests.every(path => /\/api\/(admin_capabilities|get_user_profile|list_moderation_logs|list_score_sync_conflicts|list_admin_messages|mark_admin_message_read)$/.test(path)),
                    'Only isolated read endpoints and the synthetic mark-as-read action may run');
                record.passed = true;
            } catch (error) {
                record.error = error.stack;
                await page.screenshot({ path: prefix(`${name}-failure.png`), fullPage: true });
            } finally {
                console.log(JSON.stringify({ phase, engine, viewport: viewport.name, passed: record.passed, error: record.error }));
                await context.close();
                await app.close();
            }
        }
    } finally { await browser.close(); }
}
assert.deepEqual(await originalEvidenceHashes(), originals, 'Original before/replay artifacts must remain byte-identical');
assert.equal(createHash('sha256').update(await readFile(policyURL)).digest('hex'), policyHash, 'Shared policy must remain read-only');
await writeFile(prefix('results.json'), JSON.stringify({ phase, cssHash: createHash('sha256').update(css).digest('hex'),
    clientHash: createHash('sha256').update(client).digest('hex'), originalEvidenceUnchanged: true, sharedPolicyUnchanged: true,
    scope: 'Current working-tree source on a loopback synthetic reviewer fixture. Shared files read-only; no DB, secrets or deployment. Strict focus and navigation checks; no waivers.',
    passed: results.filter(record => record.passed).length, total: results.length,
    results }, null, 2));
console.log(JSON.stringify({ phase, passed: results.filter(record => record.passed).length, total: results.length, output }));
if (results.some(record => !record.passed)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runReview();
