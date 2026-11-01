import test from 'node:test';
import assert from 'node:assert/strict';
import { transplantFallbackPicker, assertFallbackPickerRepair } from '../scripts/fallback-picker-release-guard-20261008.mjs';

const before = `
import { createBenchmarkFamilyRows } from './workspace/benchmark-family-row.js';
import { createChainScrollEdges } from './workspace/chain-scroll-edges.js';
import { createBenchmarkFallbackCatalogue } from './workspace/benchmark-fallback-catalogue.js';
import { createWorkspaceStylePreviews } from './workspace/style-previews.js';
createChainScrollEdges(benchmarkRows);
const inlineFallbackChart = document.getElementById('chart');
const benchmarkFamilyRows = createBenchmarkFamilyRows();
const benchmarkFallbackCatalogue = createBenchmarkFallbackCatalogue({onChange: renderBenchmarks});
function renderInlineFallback() { return 'old editor'; }
function renderBenchmarks() { return 'old list'; }
const familyView = createFamilyView();
function persistPersonalPie() { return 'old saving'; }
`;
const current = `
import { createBenchmarkRowFocus } from './workspace/benchmark-family-row.js?v=picker';
import { createBenchmarkFallbackCatalogue } from './workspace/benchmark-fallback-catalogue.js?v=picker';
import { createFallbackPicker } from './workspace/fallback-picker.js?v=picker';
import { createWorkspaceStylePreviews } from './workspace/style-previews.js?v=picker';
import { createPersonalPieRecovery } from './workspace/pie-recovery.js';
const inlineFallbackChart = document.getElementById('chart');
const inlineFallbackConfigurations = document.getElementById('configurations');
const benchmarkRowFocus = createBenchmarkRowFocus();
const benchmarkFallbackCatalogue = createBenchmarkFallbackCatalogue({onChange() { renderBenchmarks(); fallbackPicker.refresh(); }});
const fallbackPicker = createFallbackPicker();
function renderInlineFallback() { fallbackPicker.refresh(); }
function renderBenchmarks() { return 'ordinary rows'; }
const familyView = createFamilyView();
function focusPersonalBenchmark() { return 'select entrance'; }
function applyFallbackConfiguration() { return 'replace order'; }
inlineFallbackConfigurations.addEventListener('click', () => fallbackPicker.open());
function persistPersonalPie() { return createPersonalPieRecovery(); }
`;

test('scoped picker transplant does not publish another agent\'s local recovery edits', () => {
    const staged = transplantFallbackPicker(before, current, before);
    assert.doesNotMatch(staged, /pie-recovery|createPersonalPieRecovery/);
    assert.match(staged, /return 'old saving'/);
    assert.doesNotMatch(staged, /createChainScrollEdges|createBenchmarkFamilyRows/);
    assert.match(staged, /inlineFallbackConfigurations\.addEventListener/);
    assert.equal(assertFallbackPickerRepair(current, staged).components, 13);
});

test('scoped picker transplant preserves independent changes already installed', () => {
    const installed = before.replace("return 'old saving'", "return 'independently deployed saving'") + '\nconst anotherDeployment = true;\n';
    const staged = transplantFallbackPicker(before, current, installed);
    assert.match(staged, /return 'independently deployed saving'/);
    assert.match(staged, /const anotherDeployment = true/);
    assert.equal(transplantFallbackPicker(before, current, staged), staged);
});

test('scoped picker transplant stops on a concurrent change within an owned node', () => {
    assert.throws(() => transplantFallbackPicker(before, current, before.replace("return 'old list'", "return 'concurrent list'")),
        /Concurrent change inside owned node: renderBenchmarks/);
});
