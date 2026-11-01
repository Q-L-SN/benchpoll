import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('the chain has no appearance selector or candidate-specific layouts', async () => {
    const css = await readFile(new URL('../public/css/ui/fallback-appearance.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /bp-fallback-style-control|data-fallback-appearance|branch|flow/);
});

test('retired local preferences cannot alter the fixed Rail layout', async () => {
    const source = await readFile(new URL('../public/js/workspace/fallback-appearance.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|STORAGE_KEY|mountCustomSelect|createElement|fallbackAppearance/);
    assert.match(source, /export function initializeFallbackAppearance\(\)/);
});

test('node layout still responds to content, fonts and resized names without selector state', async () => {
    const source = await readFile(new URL('../public/js/workspace/fallback-appearance.js', import.meta.url), 'utf8');
    assert.match(source, /getClientRects\(\)/);
    assert.match(source, /ResizeObserver/); assert.match(source, /MutationObserver/); assert.match(source, /document.fonts/);
});

test('nodes and line endpoints share the measured name position, while personal chains connect upward', async () => {
    const css = await readFile(new URL('../public/css/ui/fallback-appearance.css', import.meta.url), 'utf8');
    assert.match(css, /step::after \{ top: var\(--bp-chain-node-y, 50%\); \}/);
    assert.match(css, /:first-child::before \{ top: var\(--bp-chain-node-y, 50%\); \}/);
    assert.match(css, /:last-child::before \{ bottom: calc\(100% - var\(--bp-chain-node-y, 50%\)\); \}/);
    assert.match(css, /\.bp-family-chain > \.bp-fallback-chain-step:first-child::before \{ top: 0; \}/);
});
