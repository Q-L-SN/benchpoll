import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = resolve(process.env.DISCUSSION_AUTO_LOAD_OUTPUT ?? 'D:/Codex-artifacts/website1/discussion-auto-load-20261016');
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const results = [];
const dimensions = [{ key: 'budget', name: 'Budget', options: [{ key: 'any', name: 'Any', isNeutral: true },
    { key: 'standard', name: 'Standard' }, { key: 'extended', name: 'Extended' }] }];
const makePost = (ID, categoryID = 1, parentID = null) => ({ ID, categoryID, parentID,
    categoryName: categoryID === 1 ? 'Language models' : 'Reasoning', contextID: ID % 2 ? 10 : 11,
    contextValues: ID % 3 === 0 ? { budget: 'any' } : ID % 3 === 1 ? { budget: 'standard' } : {},
    authorName: 'Fixture contributor', createdAt: '2026-10-01T00:00:00Z',
    text: `Synthetic discussion ${ID}. This fixture checks incremental loading inside the discussion panel.`,
    mentions: [{ benchmarkID: 101, conditionID: 1, label: 'General knowledge' }],
    isOwn: false, isDeleted: false, upvotes: 8, downvotes: 1, myVote: 0, replyCount: 45 });
const posts = [...Array.from({ length: 65 }, (_, index) => makePost(801 + index)),
    ...Array.from({ length: 23 }, (_, index) => makePost(901 + index, 2)),
    ...Array.from({ length: 45 }, (_, index) => makePost(2001 + index, 1, 801))];
const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
const idle = page => page.locator('#discussion-feed[aria-busy="false"]').waitFor({ state: 'attached' });
const ids = page => page.locator('#discussion-feed > .discussion-post').evaluateAll(nodes => nodes.map(node => Number(node.id.slice(5))));
const count = (page, expected) => page.waitForFunction(expected => document.querySelectorAll('#discussion-feed > .discussion-post').length === expected, expected);
const scrollBottom = page => page.locator('#discussion-panel .discussion-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
const scrollTop = page => page.locator('#discussion-panel .discussion-scroll').evaluate(node => { node.scrollTop = 0; });
const pulse = page => page.evaluate(() => {
    const scroll = document.querySelector('#discussion-panel .discussion-scroll');
    for (let index = 0; index < 12; index++) scroll.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
});

async function geometry(page) {
    const result = await page.evaluate(() => {
        const panel = document.querySelector('.discussion-main'), scroll = document.querySelector('#discussion-panel .discussion-scroll');
        const bounds = panel.getBoundingClientRect();
        return { documentOverflow: document.documentElement.scrollWidth - innerWidth,
            panelOverflow: panel.scrollWidth - panel.clientWidth, scrollOverflow: scroll.scrollWidth - scroll.clientWidth,
            outside: [...panel.querySelectorAll('button, a, select, textarea, label, h2, h3, p')]
                .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
                .map(node => ({ id: node.id, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }))
                .filter(node => node.left < bounds.left - 1 || node.right > bounds.right + 1) };
    });
    assert.ok(result.documentOverflow <= 1 && result.panelOverflow <= 1 && result.scrollOverflow <= 1, JSON.stringify(result));
    assert.deepEqual(result.outside, []);
    return result;
}

for (const [engine, launcher, width, height] of [['chromium', chromium, 1440, 900], ['chromium', chromium, 390, 844],
    ['chromium', chromium, 320, 740], ['webkit', webkit, 390, 844]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const label = `${engine}-${width}`;
    const app = await startPreview({ secondaryBenchmark: true });
    let browser, context, page;
    const reads = [], writeAttempts = [], unexpectedWrites = [], errors = [], checks = [], held = [];
    let mode = 'normal', failNext = false, holdNext = false;
    try {
        browser = await launcher.launch({ headless: true });
        context = await browser.newContext({ viewport: { width, height }, isMobile: width < 761, hasTouch: width < 761, reducedMotion: 'reduce' });
        page = await context.newPage(); page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin !== app.url) return route.abort();
            if (url.pathname.startsWith('/api/') && !/^\/api\/(get_|search_|list_)/.test(url.pathname)) {
                const body = route.request().postDataJSON();
                if (url.pathname === '/api/create_discussion_post') {
                    writeAttempts.push(body);
                    assert.equal(body.expectedUserID, '1');
                    return route.fulfill({ status: 429, json: { error: 'discussion_post_cooldown' } });
                }
                unexpectedWrites.push({ path: url.pathname, body });
                return route.fulfill({ status: 409, json: { error: 'fixture_write_blocked' } });
            }
            if (builtHTML && route.request().resourceType() === 'document') return route.fulfill({ body: builtHTML, contentType: 'text/html' });
            if (builtHTML && url.pathname.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, url.pathname.slice(1))),
                contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
            if (engine === 'webkit') {
                const response = await route.fetch();
                return route.fulfill({ response, body: await response.body() });
            }
            return route.continue();
        });
        await page.route(`${app.url}/api/get_discussion`, async route => {
            const body = route.request().postDataJSON();
            const entry = { body, mode, failed: failNext, delayed: holdNext };
            reads.push(entry);
            const fail = failNext; failNext = false;
            let selected = posts.filter(post => body.threadID ? post.parentID === body.threadID : post.parentID === null);
            if (!body.threadID) {
                if (!body.allCategories || !body.benchmarkID) selected = selected.filter(post => post.categoryID === body.categoryID);
                if (body.contextID !== null) selected = selected.filter(post => post.contextID === body.contextID);
                if (body.sort === 'new') selected = selected.toReversed();
            }
            const offset = body.offset ?? 0, size = mode === 'short' ? 2 : 20;
            if (mode === 'short') selected = selected.slice(0, 23);
            let pagePosts = selected.slice(offset, offset + size);
            if (mode === 'empty' && offset > 0) pagePosts = [];
            if (mode === 'duplicate' && offset > 0) pagePosts = selected.slice(0, 20);
            const root = body.threadID ? posts.find(post => post.ID === body.threadID) : null;
            const payload = { context: { categoryID: root?.categoryID ?? body.categoryID, categoryPath: body.categoryID === 2
                ? 'Language-models/Reasoning' : 'Language-models', contextValues: root?.contextValues ?? { budget: 'standard', ...body.contextValues }, dimensions },
                contexts: [{ ID: 10, values: { budget: 'standard' } }, { ID: 11, values: { budget: 'extended' } }],
                authenticated: app.state.authenticated, userID: app.state.authenticated ? app.state.userID : null,
                root, posts: pagePosts, total: selected.length,
                hasMore: mode === 'empty' || mode === 'duplicate' || offset + pagePosts.length < selected.length };
            if (holdNext) {
                holdNext = false;
                await new Promise(resolve => { held.push({ entry, payload, release: resolve }); });
            }
            await route.fulfill(fail ? { status: 502, json: { error: 'fixture_read_failed' } } : { json: payload }).catch(() => {});
            entry.finished = true;
        });
        await context.addInitScript(() => {
            localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal' }));
            // Exercise ignored-abort transports as well as the loader's sequence guard.
            const nativeFetch = window.fetch.bind(window);
            window.fetch = (input, options) => nativeFetch(input, String(input).endsWith('/api/get_discussion')
                ? { ...options, signal: undefined } : options);
        });
        const settle = async () => { await idle(page); await delay(250); };
        const noMoreReads = async (before = reads.length) => { await pulse(page); await delay(300); assert.equal(reads.length, before); };
        const open = async (extra = '') => {
            await scrollTop(page);
            const before = reads.length;
            await page.evaluate(url => {
                const link = document.createElement('a'); link.href = url;
                document.body.append(link); link.click(); link.remove();
            }, `${app.url}/?discussion=1&categoryID=1&context_budget=standard${extra}`);
            if (!app.state.isPrivate) {
                await page.waitForFunction(() => document.querySelector('#discussion-panel').getAttribute('aria-hidden') === 'false');
                await settle(); assert.ok(reads.length > before);
            }
        };
        const waitHeld = async index => {
            for (let attempt = 0; attempt < 150 && held.length <= index; attempt++) await delay(20);
            assert.ok(held[index], `Expected held read ${index}`);
            return held[index];
        };
        const release = async (pending, stale = true) => {
            if (stale) pending.payload.posts = pending.payload.posts.map(post => ({ ...post, text: 'OBSOLETE FIXTURE RESPONSE' }));
            pending.release();
            for (let attempt = 0; attempt < 150 && !pending.entry.finished; attempt++) await delay(20);
            assert.equal(pending.entry.finished, true);
            await delay(100);
        };
        const assertNotStale = async () => assert.equal((await page.locator('#discussion-feed').textContent()).includes('OBSOLETE FIXTURE RESPONSE'), false);

        await page.goto(app.url); await ready(page); await page.evaluate(() => document.fonts.ready);
        if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#discussion-entry').click(); await settle();
        assert.equal(await page.locator('#discussion-panel').getAttribute('data-view'), 'feed');
        assert.equal(await page.locator('#discussion-feed > .discussion-post').count(), 20);
        const postingSelector = await page.locator('#posting-context select').elementHandle();
        assert.ok(postingSelector);
        const firstRead = reads.length;
        await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); window.dispatchEvent(new Event('scroll')); });
        await noMoreReads(firstRead);
        await scrollBottom(page); await count(page, 40); await settle(); await noMoreReads();
        assert.equal(await postingSelector.evaluate(node => node.isConnected), true, 'Auto-append preserves the existing composer controls');
        assert.deepEqual(reads.slice(0, 2).map(read => read.body.offset), [0, 20]);
        await scrollBottom(page); await count(page, 60); await settle();
        await scrollBottom(page); await count(page, 65); await settle();
        assert.deepEqual(reads.slice(0, 4).map(read => read.body.offset), [0, 20, 40, 60]);
        assert.equal(new Set(await ids(page)).size, 65);
        assert.equal(await page.locator('#discussion-more').isVisible(), false); await noMoreReads();
        checks.push('ordinary feed: 20-result sequential paging, root geometry, duplicate guard, exhaustion');
        await scrollTop(page); await geometry(page);
        await page.locator('#discussion-panel').screenshot({ path: join(output, `${label}-feed.png`) });

        await page.locator('#post-801 .discussion-post-actions a').filter({ hasText: '45 replies' }).click();
        await settle(); await count(page, 20);
        assert.equal(await page.locator('#discussion-panel').getAttribute('data-view'), 'thread');
        assert.equal(await page.locator('#thread-root > .discussion-post.is-root').count(), 1);
        assert.equal(await page.locator('#discussion-feed > .discussion-post.is-reply').count(), 20);
        await scrollBottom(page); await count(page, 40); await settle();
        await scrollBottom(page); await count(page, 45); await settle(); await noMoreReads();
        assert.deepEqual(reads.filter(read => read.body.threadID === 801).map(read => read.body.offset), [0, 20, 40]);
        await scrollTop(page); await geometry(page);
        const permalink = page.locator('#thread-root a[title="Link to this message"]');
        assert.equal(await permalink.getAttribute('aria-label'), 'Link to this message');
        assert.equal(await permalink.locator('i.fa-link').count(), 1);
        assert.equal(await page.locator('#thread-root .discussion-context-badge').count(), 0);
        assert.equal(await page.locator('#thread-root .discussion-post-actions .bp-ui-action').count(), 4);
        await page.locator('#discussion-panel').screenshot({ path: join(output, `${label}-thread.png`) });
        checks.push('replies: root/reply classes, 20/40/45 results, metadata, shared accessible quiet actions');

        await open('&benchmarkID=101&conditionID=1');
        await page.waitForFunction(() => document.querySelector('#benchmark-information-name').textContent === 'General knowledge');
        await page.locator('#discussion-compose-toggle').click();
        await page.locator('#discussion-text').fill('Fixture benchmark draft survives automatic paging and navigation.');
        const scopeStart = reads.length;
        await page.locator('#discussion-scope-toggle').click(); await settle();
        assert.equal(reads.at(-1).body.allCategories, true);
        assert.equal(reads.at(-1).body.contextID, null);
        await scrollBottom(page); await count(page, 40); await settle();
        assert.deepEqual(reads.slice(scopeStart).map(read => read.body.offset), [0, 20]);
        assert.equal(await page.locator('#discussion-text').inputValue(), 'Fixture benchmark draft survives automatic paging and navigation.');
        checks.push('benchmark all-category scope auto-load preserves task context and draft');

        for (const action of ['sort', 'scope', 'filter', 'workspace', 'close', 'scores']) {
            await open('&benchmarkID=101&conditionID=1');
            await scrollTop(page);
            const index = held.length; holdNext = true;
            await scrollBottom(page); const pending = await waitHeld(index);
            const inFlightReads = reads.length;
            await pulse(page); await delay(120);
            assert.equal(reads.length, inFlightReads, `${action}: repeated scroll cannot create concurrent appends`);
            if (action === 'sort') {
                holdNext = true;
                await page.locator('#benchmark-discussion-view [data-sort="new"]').click();
                const replacement = await waitHeld(index + 1);
                await release(pending);
                assert.equal(await page.locator('#discussion-feed').getAttribute('aria-busy'), 'true', 'Stale finalizers cannot clear a newer busy state');
                await release(replacement, false); await settle();
                assert.equal(reads.at(-1).body.sort, 'new');
                assert.deepEqual((await ids(page)).slice(0, 2), [865, 864]);
            } else if (action === 'scope') {
                await page.locator('#discussion-scope-toggle').click(); await settle();
                assert.equal(reads.at(-1).body.allCategories, true); await release(pending);
            } else if (action === 'filter') {
                await page.locator('#discussion-context').selectOption('10', { force: true }); await settle();
                assert.equal(reads.at(-1).body.contextID, 10); await release(pending);
                assert.ok((await ids(page)).every(ID => ID % 2 === 1));
            } else if (action === 'workspace') {
                await page.evaluate(() => window.dispatchEvent(new CustomEvent('benchpoll:discussion-context',
                    { detail: { categoryID: 2, contextValues: { budget: 'extended' }, isPrivate: false } })));
                await settle(); assert.equal(reads.at(-1).body.categoryID, 2); await release(pending);
                assert.ok((await ids(page)).every(ID => ID >= 901 && ID <= 923));
            } else if (action === 'close') {
                await page.locator('#discussion-close').click(); await release(pending); await noMoreReads(inFlightReads);
                assert.equal(await page.locator('#discussion-panel').getAttribute('aria-hidden'), 'true');
                await open('&benchmarkID=101&conditionID=1');
                assert.equal(await page.locator('#discussion-text').inputValue(), 'Fixture benchmark draft survives automatic paging and navigation.');
            } else {
                await page.locator('#benchmark-scores-open').click();
                await page.locator('#benchmark-scores-view').waitFor();
                await scrollBottom(page); await noMoreReads(inFlightReads); await release(pending);
                assert.equal(await page.locator('#discussion-feed').getAttribute('aria-busy'), 'false');
                await page.locator('#benchmark-scores-back').click(); await settle();
                await scrollBottom(page); await count(page, 40); await settle();
            }
            await assertNotStale();
            checks.push(`${action}: abort/retire pending append and ignore out-of-order response`);
        }

        await open();
        failNext = true; const beforeError = reads.length;
        await scrollBottom(page); await page.getByRole('button', { name: 'Retry', exact: true }).waitFor(); await settle();
        assert.equal(reads.length, beforeError + 1); assert.equal(await page.locator('#discussion-error').isVisible(), true);
        await noMoreReads(); await scrollBottom(page); await noMoreReads();
        await page.locator('#discussion-more').click(); await count(page, 40); await settle();
        assert.deepEqual(reads.slice(beforeError).map(read => read.body.offset), [20, 20]);
        assert.equal(await page.locator('#discussion-error').isVisible(), false);
        failNext = true; await open();
        assert.equal(await page.locator('#discussion-more').textContent(), 'Retry'); await noMoreReads();
        await page.locator('#discussion-more').click(); await count(page, 20); await settle();
        checks.push('append and initial failures pause automatic reads until explicit same-page retry');

        for (const zeroMode of ['empty', 'duplicate']) {
            mode = zeroMode; await open(); const before = reads.length;
            await scrollBottom(page); await settle(); await noMoreReads();
            assert.equal(reads.length, before + 1); assert.equal((await ids(page)).length, 20);
            assert.equal(await page.locator('#discussion-more').isVisible(), false);
        }
        mode = 'short'; await open(); await delay(700); await idle(page);
        const shortIDs = await ids(page);
        assert.ok(shortIDs.length > 2 && shortIDs.length < 23, `Short feeds should fill sequentially without fetching off-screen batches: ${shortIDs.length}`);
        const position = await page.evaluate(() => {
            const root = document.querySelector('#discussion-panel .discussion-scroll').getBoundingClientRect();
            const target = document.querySelector('#discussion-more').getBoundingClientRect();
            return { rootBottom: root.bottom, sentinelTop: target.top };
        });
        assert.ok(position.sentinelTop > position.rootBottom + 150, JSON.stringify(position));
        await noMoreReads(); mode = 'normal';
        checks.push('zero-progress batches stop; short pages fill only while sentinel remains near the panel bottom');

        await open('&benchmarkID=101&conditionID=1');
        await page.locator('#post-discussion').click(); await page.locator('#discussion-error').waitFor();
        assert.equal(writeAttempts.length, 1); assert.equal(writeAttempts[0].expectedUserID, '1');
        assert.equal(await page.locator('#discussion-text').inputValue(), 'Fixture benchmark draft survives automatic paging and navigation.');
        app.state.userID = '2';
        await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await delay(200);
        await page.locator('#post-discussion').click(); await delay(150);
        assert.equal(writeAttempts.length, 1, 'Account change blocks the write before transport');
        assert.match(await page.locator('#discussion-error').textContent(), /account changed/);
        checks.push('account-bound writes remain guarded; rejected submission and account change preserve draft');

        await page.locator('#discussion-text').fill('');
        await page.locator('#discussion-close').click(); app.state.isPrivate = true; app.state.userID = '1';
        await page.reload(); await ready(page);
        if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
        const privateReads = reads.length;
        await open('&benchmarkID=101&conditionID=1');
        await page.waitForFunction(() => document.querySelector('#benchmark-information-name').textContent === 'General knowledge');
        await scrollBottom(page); await noMoreReads(privateReads);
        assert.equal(await page.locator('#benchmark-discussion-view').isVisible(), false);
        assert.equal(await page.locator('#discussion-composer').isVisible(), false);
        checks.push('private information-only panels make no discussion read or automatic append');

        assert.deepEqual(unexpectedWrites, []);
        assert.equal(app.state.requests.some(request => !/^\/api\/(get_|search_|list_)/.test(request.path)), false, 'No write reaches the fixture server');
        assert.deepEqual(errors, []);
        results.push({ label, passed: true, checks, reads: reads.length, interceptedRejectedPosts: writeAttempts.length,
            realWrites: 0, pageErrors: errors });
        console.log(`PASS ${label}: ${checks.length} checks, ${reads.length} fixture reads, zero real writes`);
    } catch (error) {
        await page?.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true }).catch(() => {});
        results.push({ label, passed: false, checks, error: error.stack, lastReads: reads.slice(-5), pageErrors: errors, unexpectedWrites });
        console.error(`FAIL ${label}: ${error.stack}`);
    } finally {
        held.forEach(pending => pending.release());
        await context?.close(); await browser?.close(); await app.close();
    }
}
await writeFile(join(output, 'verification.json'), JSON.stringify(results, null, 2));
if (!results.length || results.some(result => !result.passed)) process.exitCode = 1;
