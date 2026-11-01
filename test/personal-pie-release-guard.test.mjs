import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHomeSaveRepair, assertPieSaveStyles } from '../scripts/personal-pie-release-guard-20261008.mjs';

const source = `import { postWriteJSON } from './shared/http.js';
import { validatePersonalPieSave } from './workspace/pie-save.js';
function beginMutation() { state.personalSavePending = true; }
async function flushPendingPersonalPieSave() { return persistPersonalPie(); }
function applyServerWorkspace(payload) { state.personalRevision = payload.revision; }
async function loadWeightedWorkspace() { await flushPendingPersonalPieSave(); }
async function persistPersonalPie() { return postWriteJSON('/api/save_personal_pie', body, { validateResponse: validatePersonalPieSave }); }
function restoreHistory() { state.personalSavePending = true; }
const view = createModelListView({ onRetrySave: () => state.personalSaveConflict ? reload() : persistPersonalPie() });
function renderInlineFallback() { button.textContent = 'Add fallback benchmark'; }
`;
test('concurrent rendering/help changes do not require restoring an old UI', () => {
    const current = "import { setHelpText } from './shared/help-popover.js';\n" + source.replace("'Add fallback benchmark'", "'Add benchmark'");
    assert.equal(assertHomeSaveRepair(current, source).matched, true);
});
test('comments and formatting do not falsely conflict with the owned save repair', () => {
    assert.equal(assertHomeSaveRepair(source.replace('state.personalSavePending = true;', '/* keep draft */\n state.personalSavePending=true;'), source).matched, true);
});
test('an altered save body or retry binding stops the release', () => {
    assert.throws(() => assertHomeSaveRepair(source.replace("'/api/save_personal_pie'", "'/api/delete_personal_pie'"), source), /Owned save behavior changed: persistPersonalPie/);
    assert.throws(() => assertHomeSaveRepair(source.replace('state.personalSaveConflict ? reload()', 'true ? reload()'), source), /Owned save behavior changed: onRetrySave/);
});
test('a missing or redirected save dependency stops the release', () => {
    assert.throws(() => assertHomeSaveRepair(source.replace("'./shared/http.js'", "'./shared/other.js'"), source), /Missing owned save import: postWriteJSON/);
    assert.throws(() => assertHomeSaveRepair(source.replace('function restoreHistory()', 'function otherHistory()'), source), /Missing owned save function: restoreHistory/);
});
const styles = '.bp-error-state.bp-pie-save-error { display: flex; }\n.bp-pie-save-error > span { min-width: 0; }\n.bp-error-state button { padding: 8px; }';
test('concurrent unrelated styles are preserved without changing the reviewed error banner', () => {
    assert.equal(assertPieSaveStyles('.new-help-layer { display: block; }\n' + styles, styles).matched, true);
});
test('changed or missing save-error styles stop the release', () => {
    assert.throws(() => assertPieSaveStyles(styles.replace('min-width: 0', 'min-width: 800px'), styles), /Owned save-error styles changed/);
    assert.throws(() => assertPieSaveStyles(styles.replace('bp-pie-save-error', 'other-error'), styles), /Missing or duplicated save-error styles/);
});
