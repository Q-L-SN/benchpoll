import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { keyboardFocus, navigationSnapshot, verifyMessageTabLifecycle } from '../scripts/frontend/review-moderation-style-20261008.mjs';

const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };

async function inspectFields(locator) {
    return locator.evaluate(element => {
        const style = getComputedStyle(element);
        return { borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Width`]),
            shadow: style.boxShadow, paddingLeft: style.paddingLeft,
            columns: style.gridTemplateColumns.split(' ').length,
            pseudoContent: ['::before', '::after'].map(pseudo => getComputedStyle(element, pseudo).content) };
    });
}

function assertUnframedFields(fields, width) {
    assert.deepEqual(fields.borders, ['0px', '0px', '0px', '0px'], 'Field groups must not have a unilateral colored border');
    assert.equal(fields.shadow, 'none', 'Do not replace the border with a left inset stripe');
    assert.ok(fields.pseudoContent.every(content => ['none', 'normal'].includes(content)), 'Do not replace it with a pseudo stripe');
    assert.equal(fields.paddingLeft, '14px', 'Keep existing field indentation');
    assert.equal(fields.columns, width <= 760 ? 1 : 2, 'Keep existing responsive label/value layout');
}

for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    test(`${engine}: moderation ornaments, internal focus and count navigation`, { timeout: 120000 }, async t => {
        const browser = await launcher.launch({ headless: true, env });
        try {
            for (const width of [1440, 761, 760, 390, 320]) {
                await t.test(`${width}px: queue, source conflict, unread state and neutral dividers`, async () => {
                    const app = await startPreview({ isSenior: true,
                        syncConflicts: [{ row_key: 'style-test', result_ID: 77, incoming_hash: 'a'.repeat(64), status: 'pending',
                            modelName: 'Style fixture model', benchmarkName: 'Style fixture benchmark', conditionName: 'Overall',
                            currentScore: 82, currentStatus: 'approved', manualOverride: 'corrected', currentFields: [],
                            currentNotes: 'Reviewed source', incoming_row: { rawScore: 83 } }],
                        adminMessages: [{ ID: 100, senderUserID: 3, createdAt: '2026-10-08T01:00:00Z', isRead: false,
                            body: 'Synthetic style regression message.' }] });
                    const page = await browser.newPage({ viewport: { width, height: 960 } });
                    try {
                        const external = [];
                        await page.route('**/*', route => {
                            if (new URL(route.request().url()).origin === app.url) return route.continue();
                            external.push(route.request().url());
                            return route.abort('blockedbyclient');
                        });
                        await page.goto(`${app.url}/censor`);
                        await page.locator('#log-list .field-grid').waitFor();
                        assertUnframedFields(await inspectFields(page.locator('#log-list .field-grid')), width);
                        const resting = await page.locator('#status-filter').boundingBox();
                        const focus = await keyboardFocus(page, '#status-filter');
                        assert.deepEqual(await page.locator('#status-filter').boundingBox(), resting, 'Focus must not change select geometry');
                        if (focus.outlineStyle !== 'none') {
                            assert.ok(parseFloat(focus.outlineOffset) + parseFloat(focus.outlineWidth) <= 0,
                                'Select focus must stay entirely inside, not become an external frame');
                            assert.equal(focus.shadow, 'none', 'No extra external focus halo');
                        }
                        await page.locator('#sync-tab').click();
                        await page.locator('#sync-list .field-grid').waitFor();
                        assertUnframedFields(await inspectFields(page.locator('#sync-list .field-grid')), width);

                        await page.locator('#messages-tab').click();
                        const message = page.locator('#message-list .admin-message.unread');
                        await message.waitFor();
                        await page.waitForFunction(() => {
                            const nav = document.querySelector('.workspace-tabs').getBoundingClientRect();
                            const tab = document.getElementById('messages-tab').getBoundingClientRect();
                            return tab.left >= nav.left - 1 && tab.right <= nav.right + 1;
                        }, null, { timeout: 3000 });
                        assert.equal((await navigationSnapshot(page)).activeTabFullyVisible, true);
                        const unread = await message.evaluate(element => {
                            const style = getComputedStyle(element);
                            return { widths: ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Width`]),
                                colors: ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Color`]),
                                shadow: style.boxShadow, background: style.backgroundColor };
                        });
                        assert.deepEqual(unread.widths, ['1px', '1px', '1px', '1px'], 'Preserve the dirty-tree full unread outline');
                        assert.equal(new Set(unread.colors).size, 1, 'Unread emphasis belongs on all four sides');
                        assert.ok(!unread.shadow.includes('inset'), 'Do not reintroduce the historical unread left inset');
                        assert.notEqual(unread.background, 'rgb(255, 255, 255)', 'Preserve the existing selected background');

                        const dividers = await page.locator('#editor-overlay .moderation-panel-header')
                            .evaluateAll(elements => elements.map(element => ({
                                width: getComputedStyle(element).borderBottomWidth,
                                color: getComputedStyle(element).borderBottomColor
                            })));
                        assert.equal(dividers.length, 1);
                        assert.ok(dividers.every(divider => divider.width === '1px' && divider.color === 'rgb(227, 230, 236)'),
                            'The panel retains its neutral separator');
                        if ([1440, 390, 320].includes(width)) {
                            const lifecycle = await verifyMessageTabLifecycle(page, { url: app.url });
                            assert.equal(lifecycle.passed, true);
                            assert.equal(lifecycle.steps.length, 9);
                            assert.equal(lifecycle.listRequests, 6);
                            assert.equal(lifecycle.readRequests, 3);
                        }
                        assert.deepEqual(external, [], 'Tests must stay inside the synthetic loopback fixture');
                    } finally {
                        await page.close();
                        await app.close();
                    }
                });
            }
        } finally { await browser.close(); }
    });
}
