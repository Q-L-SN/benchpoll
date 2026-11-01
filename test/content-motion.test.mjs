import assert from 'node:assert/strict';
import test from 'node:test';
import { animateContent } from '../public/js/shared/motion.js';

test('fixed-control workspaces keep a fade without a temporary transform containing block', async () => {
    const previousWindow = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    try {
        const calls = [];
        const element = { animate(frames) {
            calls.push(frames);
            return { finished: Promise.resolve(), cancel() {} };
        } };
        animateContent(element, { translate: false });
        assert.deepEqual(calls[0], [{ opacity: .35 }, { opacity: 1 }]);
        await Promise.resolve();
        animateContent(element);
        assert.equal(calls[1][0].transform, 'translateY(4px)');
        await Promise.resolve();
        globalThis.window.matchMedia = () => ({ matches: true });
        animateContent(element, { translate: false });
        assert.equal(calls.length, 2);
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
