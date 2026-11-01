import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateIndicator, UPDATE_HOLD_MS, UPDATE_FADE_MS } from '../public/js/shared/update-indicator.js';

function fixture() {
    let now = 0, next = 0;
    const tasks = new Map();
    const timers = {
        setTimeout(fn, delay) { const id = ++next; tasks.set(id, { fn, at: now + delay }); return id; },
        clearTimeout(id) { tasks.delete(id); }
    };
    const document = { createElement() { return { dataset: {}, children: [], attributes: {},
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this.attributes[name] = value; } }; } };
    const indicator = createUpdateIndicator({ document, timers });
    return { ...indicator, advance(ms) {
        const end = now + ms;
        while (true) {
            const task = [...tasks].sort((a, b) => a[1].at - b[1].at).find(([, value]) => value.at <= end);
            if (!task) break;
            now = task[1].at; tasks.delete(task[0]); task[1].fn();
        }
        now = end;
    } };
}

test('updates transition from centered spinner to check and fade without a timestamp', () => {
    const indicator = fixture();
    indicator.update({ pending: true, version: 1 });
    assert.equal(indicator.element.dataset.phase, 'pending');
    assert.equal(indicator.element.children[0].className, 'bp-spinner');
    indicator.update({ version: 2 });
    assert.equal(indicator.element.dataset.phase, 'complete');
    indicator.advance(UPDATE_HOLD_MS);
    assert.equal(indicator.element.dataset.phase, 'fading');
    indicator.advance(UPDATE_FADE_MS);
    assert.equal(indicator.element.dataset.phase, 'idle');
    assert.equal(indicator.element.children[1].textContent, '');
});

test('rerenders do not restart completion and a new request cancels the previous fade', () => {
    const indicator = fixture();
    indicator.update({ version: 1 });
    assert.equal(indicator.element.dataset.phase, 'idle');
    indicator.update({ pending: true, version: 1 });
    indicator.update({ version: 2 });
    indicator.advance(UPDATE_HOLD_MS - 1);
    indicator.update({ version: 2 });
    indicator.advance(1);
    assert.equal(indicator.element.dataset.phase, 'fading');
    indicator.update({ pending: true, version: 2 });
    indicator.advance(UPDATE_FADE_MS + UPDATE_HOLD_MS);
    assert.equal(indicator.element.dataset.phase, 'pending');
});

test('errors never acknowledge success, and disposal clears pending timers', () => {
    const indicator = fixture();
    indicator.update({ pending: true, version: 1 });
    indicator.update({ error: true, version: 1 });
    assert.equal(indicator.element.dataset.phase, 'idle');
    indicator.update({ version: 1 });
    assert.equal(indicator.element.dataset.phase, 'idle');
    indicator.update({ pending: true, version: 1 });
    indicator.update({ version: 2 });
    indicator.destroy();
    indicator.advance(UPDATE_HOLD_MS + UPDATE_FADE_MS);
    assert.equal(indicator.element.dataset.phase, 'complete');
});
