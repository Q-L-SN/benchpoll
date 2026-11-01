import assert from 'node:assert/strict';
import test from 'node:test';
import { configSidebarSwipeIntent } from '../public/js/shared/config-sidebar.js';

test('configuration swipe requires a deliberate, short, rightward gesture', () => {
    for (const [dx, dy, elapsed] of [[72, 0, 650], [120, 25, 300], [100, -32, 200]]) {
        assert.equal(configSidebarSwipeIntent(dx, dy, elapsed), 'open');
    }
    for (const [dx, dy, elapsed] of [[0, 0, 0], [71, 0, 200], [8, 8, 80], [0, -9, 80]]) {
        assert.equal(configSidebarSwipeIntent(dx, dy, elapsed), 'pending');
    }
});

test('vertical intent, reversals and slow drags abandon the sidebar gesture', () => {
    for (const [dx, dy, elapsed] of [[90, 0, 651], [-11, 0, 100], [14, 11, 100],
        [14, -11, 100], [100, 33, 100], [100, -33, 100], [-90, 0, 100]]) {
        assert.equal(configSidebarSwipeIntent(dx, dy, elapsed), 'cancel');
    }
});
