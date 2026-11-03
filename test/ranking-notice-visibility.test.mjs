import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRankingNotice } from '../public/js/workspace/ranking-notice.js';

test('the ranking notification has no raised shadow on hover', async () => {
    const styles = await readFile(new URL('../public/css/ui/ranking-motion.css', import.meta.url), 'utf8');
    assert.match(styles, /\.bp-model-ranking-status \{[^}]*box-shadow: none;/);
    assert.doesNotMatch(styles, /\.bp-model-ranking-status[^{}]*:hover[^{}]*\{[^}]*box-shadow:\s*(?!none)[^;]+;/);
});

function fixture(t, { mobile, hidden, rounded = false }) {
    const previousWindow = globalThis.window, previousDocument = globalThis.document;
    const frames = new Map(), timers = new Map(), scrollCalls = [], properties = new Map();
    let nextID = 1;
    const node = () => ({ isConnected: false, scrollHeight: 44, append() {}, setAttribute() {},
        replaceChildren() {}, getBoundingClientRect: () => ({ top: 0, height: 44 }) });
    const scrollingElement = { scrollTop: 1100 };
    const mobilePage = { ...node(), scrollTop: 1100,
        getBoundingClientRect: () => ({ top: 250, height: 500 }),
        scrollTo({ top }) { scrollCalls.push({ target: 'page', top }); this.scrollTop = rounded ? Math.round(top) : top; } };
    const rows = { ...node(), scrollTop: 250, clientHeight: hidden ? 0 : 360,
        getClientRects: () => hidden ? [] : [{ top: 0, height: 360 }],
        closest: selector => selector === '.bp-right-workspace' ? mobilePage : { setAttribute() {} },
        replaceChildren(spacer) { spacer.isConnected = true; },
        scrollTo({ top }) { scrollCalls.push({ target: 'rows', top }); this.scrollTop = rounded ? Math.round(top) : top; } };
    const viewport = { style: { setProperty: (key, value) => properties.set(key, value) } };
    const status = { ...node(), dataset: {}, hidden: true, closest: () => viewport };
    globalThis.document = { scrollingElement, createElement: node, querySelector: () => null };
    globalThis.window = {
        matchMedia: query => ({ matches: query.includes('max-width') ? mobile : false }),
        requestAnimationFrame: callback => { const ID = nextID++; frames.set(ID, callback); return ID; },
        cancelAnimationFrame: ID => frames.delete(ID), setTimeout: callback => { const ID = nextID++; timers.set(ID, callback); return ID; },
        clearTimeout: ID => timers.delete(ID), addEventListener() {},
        ResizeObserver: class { observe() {} disconnect() {} },
        scrollTo({ top }) { scrollCalls.push({ target: 'document', top }); scrollingElement.scrollTop = rounded ? Math.round(top) : top; }
    };
    const notice = createRankingNotice({ status, rows }); notice.resetRows();
    t.after(() => { notice.destroy(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
    const advance = time => {
        const batch = [...frames.values()]; frames.clear();
        batch.forEach(callback => callback(time));
    };
    return { notice, status, rows, mobilePage, scrollingElement, scrollCalls, properties, advance };
}

for (const mobile of [true, false]) {
    test(`hidden ${mobile ? 'mobile' : 'desktop'} ranking notices never compensate an invisible spacer`, t => {
        const view = fixture(t, { mobile, hidden: true });
        view.notice.update({ pending: false, version: 1, scope: 'same' });
        view.notice.update({ pending: false, error: 'Could not update the ranking.', version: 1, scope: 'same' });
        view.advance(0); view.advance(160); view.advance(320);
        assert.equal(view.status.dataset.motion, 'open');
        assert.equal(view.properties.get('--ranking-notice-height'), '44px');
        view.notice.hide(); view.advance(400); view.advance(710); view.advance(1020);
        assert.equal(view.status.dataset.motion, 'closed');
        assert.equal(view.scrollingElement.scrollTop, 1100);
        assert.equal(view.mobilePage.scrollTop, 1100);
        assert.equal(view.rows.scrollTop, 250);
        assert.deepEqual(view.scrollCalls, []);
    });

    test(`visible ${mobile ? 'mobile' : 'desktop'} ranking notices retain fractional scroll compensation`, t => {
        const view = fixture(t, { mobile, hidden: false, rounded: true });
        view.notice.update({ pending: false, version: 1, scope: 'same' });
        view.notice.update({ pending: false, error: 'Could not update the ranking.', version: 1, scope: 'same' });
        view.advance(0); view.advance(105); view.advance(210); view.advance(320);
        assert.equal(mobile ? view.mobilePage.scrollTop : view.rows.scrollTop, (mobile ? 1100 : 250) + 44);
        assert.ok(view.scrollCalls.every(call => call.target === (mobile ? 'page' : 'rows')));
        assert.equal(view.scrollingElement.scrollTop, 1100, 'the shared header never scrolls');
        view.notice.hide(); view.advance(400); view.advance(605); view.advance(810); view.advance(1020);
        assert.equal(mobile ? view.mobilePage.scrollTop : view.rows.scrollTop, mobile ? 1100 : 250);
    });
}

test('first entering a ranking scope stays quiet while loading and after completion', t => {
    const view = fixture(t, { mobile: false, hidden: false });
    view.notice.update({ pending: true, version: 0, scope: 'first' });
    view.notice.update({ pending: false, version: 1, scope: 'first' });
    view.advance(0); view.advance(700);
    assert.equal(view.status.hidden, true);
    assert.equal(view.properties.get('--ranking-notice-height'), '0px');
    view.notice.update({ pending: true, version: 1, scope: 'another-category' });
    view.notice.update({ pending: false, version: 2, scope: 'another-category' });
    view.advance(800); view.advance(1500);
    assert.equal(view.status.hidden, true);
});

test('normal recalculation stays beside the topic title; the ranking only shows errors', t => {
    const view = fixture(t, { mobile: false, hidden: false });
    view.notice.update({ pending: false, version: 1, scope: 'same' });
    view.notice.update({ pending: false, version: 1, scope: 'same' });
    view.notice.update({ pending: false, version: 2, scope: 'same' });
    assert.equal(view.status.hidden, true);
    view.notice.update({ pending: true, version: 2, scope: 'same' });
    view.advance(0); view.advance(320);
    assert.equal(view.status.dataset.phase, 'updating');
    assert.equal(view.status.hidden, true);
    view.notice.update({ pending: false, version: 3, scope: 'same' });
    assert.equal(view.status.dataset.phase, 'ready');
    assert.equal(view.status.hidden, true);
    view.notice.update({ pending: false, error: 'Could not update the ranking.', version: 3, scope: 'same' });
    view.advance(400); view.advance(720);
    assert.equal(view.status.dataset.phase, 'error');
    assert.equal(view.status.hidden, false);
});
