import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertPieRecoveryRepair, transplantPieRecovery } from '../scripts/pie-recovery-release-guard-20261008.mjs';

const workspace = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
const bannerEnd = '    personalPieGuidance.hidden = false;';
const historicalBoundary = "    const compositionVisible = state.workspaceDisplay !== 'charts' && !personal && state.publicCompositionVisible;\n";
assert.equal(workspace.split(bannerEnd).length, 2, 'The current recovery notice has one explicit end boundary');
// The historical release parser uses this retired declaration only as a notice delimiter.
const source = workspace.replace(bannerEnd, historicalBoundary + bannerEnd);

test('historical recovery fixture changes only the parser boundary, not the current topic workspace', () => {
    assert.doesNotMatch(workspace, /const compositionVisible =|state\.publicCompositionVisible/);
    assert.equal(source.replace(historicalBoundary, ''), workspace);
    assert.equal(assertPieRecoveryRepair(source, source).components, 18);
});

test('release transplantation preserves independent weight controls, fallback and other UI bytes', () => {
    const headline = "const topicViewButton = document.getElementById('weight-topic-view');";
    const fallback = "const inlineFallbackChart = document.getElementById('inline-fallback-chart');";
    assert.ok(source.includes(headline), 'View control anchor is outside the owned recovery nodes');
    assert.ok(source.includes(fallback), 'Fallback anchor is outside the owned recovery nodes');
    const installed = source.replace(headline, `${headline}\n// Concurrent weight controls.`)
        .replace(fallback, `${fallback}\n// Concurrent fallback interface.`);
    assert.notEqual(installed, source);
    const staged = transplantPieRecovery(source, source, installed);
    assert.equal(staged, installed, 'Every unrelated installed byte must survive transplantation');
    assert.equal(assertPieRecoveryRepair(source, staged).components, 18);
});
test('release transplantation refuses a simultaneous change to an owned save function', () => {
    const installed = source.replace('async function persistPersonalPie({ forceSave = false } = {}) {',
        'async function persistPersonalPie({ forceSave = true } = {}) {');
    assert.notEqual(installed, source);
    assert.throws(() => transplantPieRecovery(source, source, installed), /Concurrent installed change inside owned node/);
});
test('release transplantation refuses a simultaneous change to the recovery notice', () => {
    const installed = source.replace('Recover it only if it is yours.', 'Automatically restored.');
    assert.notEqual(installed, source);
    assert.throws(() => transplantPieRecovery(source, source, installed), /Concurrent draft-notice change/);
});

test('release validation refuses to omit the recovery checkpoint or change its notice', () => {
    const missingCheckpoint = source.replace('    recordPersonalDraft();\n    renderModeState();', '    renderModeState();');
    const changedNotice = source.replace('Recover it only if it is yours.', 'Automatically restored.');
    assert.notEqual(missingCheckpoint, source);
    assert.notEqual(changedNotice, source);
    assert.throws(() => assertPieRecoveryRepair(source, missingCheckpoint), /Owned recovery changed/);
    assert.throws(() => assertPieRecoveryRepair(source, changedNotice));
});
