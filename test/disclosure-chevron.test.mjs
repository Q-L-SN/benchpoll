import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createDisclosureChevron, mountDisclosureChevron, observeDisclosureChevrons } from '../public/js/shared/ui-components.js';
import { isDisclosureOpen, setDisclosureOpen } from '../public/js/shared/motion.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('disclosure presentation is a shared, explicitly scoped adapter', () => {
    for (const api of [createDisclosureChevron, mountDisclosureChevron, observeDisclosureChevrons]) assert.equal(typeof api, 'function');
    const code = read('public/js/shared/disclosure-chevron.js');
    assert.match(code, /const candidates = 'details > summary, \[data-ui-disclosure\]'/);
    assert.doesNotMatch(code, /addEventListener|tabIndex|setAttribute\('aria-expanded'/);
    assert.match(read('public/js/shared/custom-select.js'), /mountDisclosureChevron\(trigger\)/);
    assert.match(read('public/js/shared/ui-components.js'), /observeDisclosureChevrons\(root\)/);
    assert.match(read('public/css/global.css'), /ui\/disclosure.css/);
});

test('one rotation rule and reduced-motion policy cover the shared glyph', () => {
    const css = read('public/css/ui/disclosure.css');
    assert.match(css, /transform: rotate\(0deg\)/);
    assert.match(css, /transform: rotate\(90deg\)/);
    assert.match(css, /transition: transform 190ms cubic-bezier\(\.22, 1, \.36, 1\)/);
    assert.match(css, /prefers-reduced-motion: reduce[^}]+bp-ui-disclosure-chevron \{ transition: none/s);
    assert.match(css, /details\[open\]:not\(\[data-ui-disclosure-open="false"\]\)/);
    for (const path of ['public/css/ui/evidence.css', 'public/css/ui/components.css', 'public/css/topics-home.css', 'public/css/contribute.css']) {
        assert.doesNotMatch(read(path), /\[aria-expanded="true"\][^{]*\{[^}]*rotate\(180deg\)/);
    }
});

function detailsFixture(open) {
    const animations = [];
    const details = { open, dataset: {}, querySelector: () => null,
        getBoundingClientRect() { return { height: this.open ? 120 : 40 }; },
        animate() {
            let finish, reject;
            const finished = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
            const animation = { finished, finish, cancel() { reject(new Error('Canceled')); } };
            animations.push(animation);
            return animation;
        } };
    return { details, animations };
}

test('animated native details expose their target during close and rapid reversal', async () => {
    const previous = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    try {
        const { details, animations } = detailsFixture(true);
        const closing = setDisclosureOpen(details, false);
        assert.equal(details.open, true);
        assert.equal(details.dataset.uiDisclosureOpen, 'false');
        assert.equal(isDisclosureOpen(details), false);
        const reopening = setDisclosureOpen(details, true);
        assert.equal(details.dataset.uiDisclosureOpen, 'true');
        assert.equal(isDisclosureOpen(details), true);
        await closing;
        assert.equal(details.dataset.uiDisclosureOpen, 'true');
        animations.at(-1).finish();
        await reopening;
        assert.equal(details.open, true);
        assert.equal(details.dataset.uiDisclosureOpen, undefined);
        const finalClose = setDisclosureOpen(details, false);
        animations.at(-1).finish();
        await finalClose;
        assert.equal(details.open, false);
        assert.equal(details.dataset.uiDisclosureOpen, undefined);
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
});

test('reduced motion and nonanimated updates cancel the target override immediately', async () => {
    const previous = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    try {
        const { details, animations } = detailsFixture(false);
        const opening = setDisclosureOpen(details, true);
        await setDisclosureOpen(details, false, { animate: false });
        await opening;
        assert.equal(details.open, false);
        assert.equal(details.dataset.uiDisclosureOpen, undefined);
        globalThis.window.matchMedia = () => ({ matches: true });
        await setDisclosureOpen(details, true);
        assert.equal(details.open, true);
        assert.equal(details.dataset.uiDisclosureOpen, undefined);
        assert.equal(animations.length, 1);
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
});
