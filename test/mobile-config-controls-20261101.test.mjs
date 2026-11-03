import assert from 'node:assert/strict';
import test from 'node:test';
import { drawerReleaseOpen } from '../public/js/shared/drawer-drag.js';

test('a freely dragged drawer settles according to its revealed fraction', () => {
    for (const value of [0, .1, .49]) assert.equal(drawerReleaseOpen(value), false);
    for (const value of [.5, .8, 1]) assert.equal(drawerReleaseOpen(value), true);
});

test('a deliberate release velocity can open or close the drawer from either side of halfway', () => {
    assert.equal(drawerReleaseOpen(.2, .7), true);
    assert.equal(drawerReleaseOpen(.8, -.7), false);
    assert.equal(drawerReleaseOpen(.2, .1), false);
    assert.equal(drawerReleaseOpen(.8, -.1), true);
});
