import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { isTopicReference } from '../public/js/workspace/topic-references.js';

const workspace = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');

test('fallback editing is temporary, scoped to the account, context and selected personal slice', () => {
    const source = workspace.slice(workspace.indexOf('function inlineFallbackScope('), workspace.indexOf('function isInlineFallbackTargetActive('));
    const primary = { ID: 1 };
    const state = { mode: 'personal', userID: 3, categoryID: 10, selectedObjectID: 1, personalEntries: [{ conditionID: 1 }], personalFallbackExpanded: true };
    let focused = 0, renders = 0, targetClears = 0;
    let rule = null, saves = 0;
    const context = vm.createContext({ state, fallbackEditorScope: null, isTopicReference,
        isExpandedWeightView: () => state.weightView === 'expanded',
        selectedInlineFallbackPrimary: () => state.mode === 'personal' && state.personalEntries.some(entry => entry.conditionID === state.selectedObjectID)
            ? { ID: state.selectedObjectID } : null,
        workspaceContextFingerprint: () => String(state.categoryID),
        fallbackRuleFor: () => rule, beginMutation: () => true,
        replaceFallbackRuleEntries: (primaryConditionID, entries, selectionSource) => { rule = { primaryConditionID, entries, selectionSource }; },
        scheduleSave: () => { saves++; },
        deactivateInlineFallbackTarget: () => { targetClears++; },
        writeWorkspacePreferences() {}, renderInlineFallback() { renders++; }, renderBenchmarks() {},
        focusPersonalBenchmark: object => { state.selectedObjectID = object.ID; },
        requestAnimationFrame: callback => callback(),
        inlineFallbackDone: { focus: () => { focused++; } },
        inlineFallbackEdit: { closest: () => null, focus: () => { focused++; } }
    });
    vm.runInContext(source, context);
    const before = structuredClone(state.personalEntries);
    assert.equal(context.isInlineFallbackEditing(), false, 'Persisted expansion is not editing permission');
    assert.equal(context.beginInlineFallbackEditing(primary), true);
    assert.equal(context.isInlineFallbackEditing(), true);
    state.weightView = 'expanded'; assert.equal(context.isInlineFallbackEditing(), false);
    state.weightView = 'topics'; assert.equal(context.isInlineFallbackEditing(), true);
    assert.deepEqual(structuredClone(rule), { primaryConditionID: 1, entries: [], selectionSource: 'custom' });
    assert.equal(saves, 1, 'An empty custom choice immediately opts out of community following');
    assert.deepEqual(state.personalEntries, before);
    state.categoryID = 11; assert.equal(context.isInlineFallbackEditing(), false);
    state.categoryID = 10; state.userID = 4; assert.equal(context.isInlineFallbackEditing(), false);
    state.userID = 3; state.mode = 'public'; assert.equal(context.isInlineFallbackEditing(), false);
    state.mode = 'personal'; state.selectedObjectID = 2; assert.equal(context.isInlineFallbackEditing(), false);
    state.selectedObjectID = 1; state.personalFallbackExpanded = false; assert.equal(context.isInlineFallbackEditing(), false);
    state.personalFallbackExpanded = true;
    context.finishInlineFallbackEditing(); assert.equal(context.isInlineFallbackEditing(), false);
    assert.equal(renders, 2); assert.equal(focused, 2); assert.equal(targetClears, 2);
    assert.equal(state.personalFallbackExpanded, true);
    state.saving = true; assert.equal(context.beginInlineFallbackEditing(primary), true, 'Saving must not lock the editor');
    state.loading = true; assert.equal(context.beginInlineFallbackEditing(primary), false);
    state.loading = false; state.gestureOpen = true; assert.equal(context.beginInlineFallbackEditing(primary), false);
    state.gestureOpen = false; assert.equal(context.beginInlineFallbackEditing({ ID: 9 }), false);
});

test('all inline mutation and add-target entry points require explicit editing', () => {
    for (const name of ['moveFallbackMember', 'removeFallbackMember']) {
        assert.match(workspace, new RegExp(`function ${name}\\([^)]*\\) \\{\\s*if \\(!isInlineFallbackEditing\\(\\)\\) return false`));
    }
    assert.match(workspace, /function activateInlineFallbackTarget\(\)[\s\S]*?!isInlineFallbackEditing\(\)/);
    const target = workspace.slice(workspace.indexOf('function isInlineFallbackTargetActive('), workspace.indexOf('function deactivateInlineFallbackTarget('));
    assert.match(target, /&& isInlineFallbackEditing\(\)/);
    const add = workspace.slice(workspace.indexOf('function addObjectToFallbackChain('), workspace.indexOf('function moveFallbackMember('));
    assert.match(add, /if \(!primary \|\| !isInlineFallbackTargetActive\(\)\) return false/);
    assert.doesNotMatch(workspace, /addOtherVersionsButton|addOtherVersionsToFallback/);
    assert.match(workspace, /else familyView\.renderPreview/);
});

test('preview and Customize reuse existing UI without nested action controls or changes to scoring', async () => {
    const home = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    const picker = await readFile(new URL('../public/js/workspace/fallback-picker.js', import.meta.url), 'utf8');
    const view = await readFile(new URL('../public/js/workspace/family-view.js', import.meta.url), 'utf8');
    for (const ID of ['inline-fallback-edit', 'inline-fallback-done', 'inline-fallback-editor', 'inline-fallback-preview-sequence']) {
        assert.ok(home.includes(`id="${ID}"`));
    }
    const preview = view.slice(view.indexOf('function renderPreview('), view.indexOf('function renderPublic('));
    assert.doesNotMatch(preview, /createElement\('button'\)|onMove|onRemove/);
    assert.match(preview, /createPersonalList\(\{ primary, entries, editing: false \}\)/);
    assert.doesNotMatch(preview, /fa-chevron-right|bp-fallback-preview-connector/);
    const list = view.slice(view.indexOf('function createPersonalList('), view.indexOf('function renderPersonal('));
    assert.match(list, /appendBenchmarkIdentity\(identity, entry, \{ showVersion: true \}\)/);
    assert.doesNotMatch(list, /informationLink\(entry\)/);
    assert.match(workspace, /inlineFallbackEntrance\.textContent = benchmarkAccessibleName\(primary\)/);
    assert.doesNotMatch(list, /bp-family-order/);
    assert.match(list, /bp-family-member bp-fallback-chain-step/);
    assert.match(list, /iconButton\('trash-can'/);
    assert.match(picker, /customize\.hidden = intent\.action !== 'replace'/);
    assert.match(picker, /editCurrent \? await onCustomize\(primary\) : await onApply/);
    const editor = workspace.slice(workspace.indexOf('function beginInlineFallbackEditing('), workspace.indexOf('function isInlineFallbackTargetActive('));
    assert.match(editor, /current\?\.selectionSource !== 'custom'/);
    assert.match(editor, /replaceFallbackRuleEntries\(primary\.ID, current\?\.entries \?\? \[\], 'custom'\)/);
    assert.doesNotMatch(workspace, /Customizing/);
});
