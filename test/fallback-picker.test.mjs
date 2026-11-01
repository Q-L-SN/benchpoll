import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fallbackPickerChoices } from '../public/js/workspace/fallback-picker.js';
import { fallbackScrollEdges, sequentialScrollStep } from '../public/js/workspace/fallback-picker-scroll.js';
import { createBenchmarkFallbackCatalogue } from '../public/js/workspace/benchmark-fallback-catalogue.js';
import { familyKey } from '../public/js/shared/benchmark-families.js';
import { excludedFromRanking, AA_EXCLUSION_MESSAGE } from '../public/js/shared/aa-ranking-policy.js';

const primary = { ID: 1, conditionID: 1, name: 'Entrance', publicWeightBasisPoints: 2600 };
const entries = IDs => IDs.map(conditionID => ({ conditionID, benchmarkID: 100 + conditionID, name: `Bench ${conditionID}` }));
const row = (IDs, ID) => ({ familyEntries: entries(IDs), familyID: ID });

test('empty catalogues always offer explicit no fallback at zero share, including read-only views', () => {
    for (const action of ['add', 'replace', 'view']) {
        const choices = fallbackPickerChoices(primary, { action, catalogue: { featured: [], items: [] },
            composition: { isDefault: true, configuredPieCount: 0, families: [{ entries: [], weightBasisPoints: 10000 }] } });
        assert.deepEqual(choices.map(choice => [choice.key, choice.shareBasisPoints]), [['[1]', 0]]);
    }
});

test('current choices lead, followed by descending community shares rather than catalogue order', () => {
    const composition = { families: [{ entries: entries([2]), weightBasisPoints: 2000 },
        { entries: entries([3]), weightBasisPoints: 7000 }, { entries: [], weightBasisPoints: 1000 }] };
    for (const selectionSource of ['selected', 'custom']) {
        const choices = fallbackPickerChoices(primary, { action: 'replace', composition,
            catalogue: { featured: [row([2], 10)], items: [row([4], 12), row([3], 11)] },
            current: { entries: entries([4]), selectionSource } });
        assert.deepEqual(choices.map(choice => choice.key), ['[1,4]', '[1,3]', '[1,2]', '[1]']);
    }
});

test('fallback chooser identifies configuration and isolates the entrance name in its subtitle', async () => {
    const source = await readFile(new URL('../public/js/workspace/fallback-picker.js', import.meta.url), 'utf8');
    assert.match(source, /const title = element\('span', '', 'Choose fallback configuration'\)/);
    assert.match(source, /question\.replaceChildren\(createBenchmarkInformationLink\(primary/);
    assert.doesNotMatch(source, /Choose a fallback order|has no score, what should be tried next/);
});

test('editing separates community inheritance from explicit choices and deduplicates shared chains', () => {
    const choices = fallbackPickerChoices(primary, { catalogue: { featured: [row([2, 3], 10)], items: [row([3], 11), row([2, 3], 10)] },
        composition: { families: [{ entries: entries([2, 3]), weightBasisPoints: 6000 }, { entries: [], weightBasisPoints: 4000 }] },
        current: { entries: entries([4]), familyID: 12 }, action: 'replace' });
    assert.deepEqual(choices.map(choice => [choice.key, choice.shareBasisPoints, choice.featured, choice.custom]),
        [['[1,4]', 0, false, true], ['[1,2,3]', 6000, true, false], ['[1]', 4000, false, false], ['[1,3]', 0, false, false]]);
    assert.equal(choices[1].shareBasisPoints / 100, 60, 'Share is 60%, not 15.6% of the whole Pie or a fabricated headcount');
    const same = fallbackPickerChoices(primary, { catalogue: { featured: [row([2], 10)], items: [row([3], 11)] },
        current: { entries: entries([2]), familyID: 10 }, action: 'replace' });
    assert.deepEqual(same.map(choice => [choice.key, choice.custom]), [['[1,2]', true], ['[1,3]', false], ['[1]', false]]);
});

test('choice catalogues contain explicit configurations, not a follow-community card', () => {
    const choices = fallbackPickerChoices(primary, { catalogue: { featured: [row([2], 10)], items: [row([3], 11), row([], null), row([2], 10)] },
        current: { entries: entries([4]) }, action: 'add' });
    assert.deepEqual(choices.map(choice => [choice.key, choice.custom]), [['[1,2]', false], ['[1,3]', false], ['[1]', false]]);
    const cold = fallbackPickerChoices(primary, { catalogue: { featured: [], items: [row([3], 11), row([2], 10)] } });
    assert.deepEqual(cold.map(choice => choice.key), ['[1,3]', '[1,2]', '[1]']);
});

test('Public viewing includes all active shares and paged configurations without a personal Custom choice', () => {
    const choices = fallbackPickerChoices(primary, { catalogue: { featured: [row([2], 10)], items: [row([3], 11), row([2], 10)] },
        composition: { families: [{ entries: entries([2]), weightBasisPoints: 2000 },
            { entries: entries([4]), familyID: 12, weightBasisPoints: 5000 }, { entries: [], weightBasisPoints: 3000 }] },
        current: { entries: entries([5]), familyID: 13 }, action: 'view' });
    assert.deepEqual(choices.map(choice => [choice.key, choice.shareBasisPoints, choice.custom]),
        [['[1,4]', 5000, false], ['[1]', 3000, false], ['[1,2]', 2000, false], ['[1,3]', 0, false]]);
    assert.equal(choices.find(choice => choice.key === '[1,2]').featured, true);
    const unknown = fallbackPickerChoices(primary, { catalogue: { featured: [], items: [row([3], 11)] }, action: 'view' });
    assert.equal(unknown[0].shareBasisPoints, null);
});

test('Public opens the existing chooser as a read-only dialog instead of expanding an inline chart', async () => {
    const workspace = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const picker = await readFile(new URL('../public/js/workspace/fallback-picker.js', import.meta.url), 'utf8');
    const home = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    assert.match(home, /id="public-fallback-toggle"[^>]*aria-haspopup="dialog"[^>]*aria-controls="fallback-picker"/);
    assert.doesNotMatch(home, /id="public-fallback-toggle"[^>]*aria-expanded/);
    assert.match(workspace, /fallbackPicker\.open\(primary, \{ action: 'view', getReturnFocus: \(\) => publicFallbackToggle \}\)/);
    assert.doesNotMatch(workspace, /publicFallbackVisible|familyView\.renderPublic/);
    assert.doesNotMatch(picker, /fallback-picker-confirm|radiogroup|fallback-order/);
    assert.match(picker, /if \(intent\.action === 'replace'\) \{\s*const toggle = createAction/);
    assert.match(picker, /intent\.action === 'view' \|\| !chosen/);
    assert.match(picker, /track\.setAttribute\('role', 'list'\)/);
});

test('an absent current choice follows community instead of casting a no-fallback vote', () => {
    const choices = fallbackPickerChoices(primary, { catalogue: { featured: [], items: [row([2], 10)] }, action: 'replace' });
    assert.deepEqual(choices.map(choice => [choice.key, choice.custom]), [['[1,2]', false], ['[1]', false]]);
    const explicit = fallbackPickerChoices(primary, { catalogue: { featured: [], items: [] },
        current: { entries: [], familyID: null }, action: 'replace' });
    assert.deepEqual(explicit.map(choice => [choice.key, choice.custom]), [['[1]', true]]);
});

test('no public composition never invents percentages and explicit chains retain identity', () => {
    const current = { entries: entries([3, 4]), familyID: 30 };
    const choices = fallbackPickerChoices(primary, { catalogue: { featured: [], items: [] }, current, action: 'replace' });
    assert.equal(choices.length, 2);
    assert.equal(choices[0].shareBasisPoints, null);
    assert.equal(choices[1].shareBasisPoints, 0);
    assert.equal(choices[0].key, familyKey(1, current.entries));
    assert.deepEqual(choices[0].entries, current.entries);
});

test('edge fades follow actual clipping, not a padded scroll offset at the first snap point', () => {
    assert.deepEqual(fallbackScrollEdges({ firstLeft: 2, lastRight: 800, left: 0, right: 400 }), { left: false, right: true });
    assert.deepEqual(fallbackScrollEdges({ firstLeft: -.5, lastRight: 400.5, left: 0, right: 400 }), { left: false, right: false });
    assert.deepEqual(fallbackScrollEdges({ firstLeft: -100, lastRight: 400, left: 0, right: 400 }), { left: true, right: false });
});

test('every chooser uses the same horizontal cards without a grid or layout preference', async () => {
    const picker = await readFile(new URL('../public/js/workspace/fallback-picker.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/css/ui/fallback-picker.css', import.meta.url), 'utf8');
    assert.doesNotMatch(picker, /layoutButtons|layoutGroup|setLayout|writeFallbackPickerLayout/);
    assert.doesNotMatch(css, /data-layout|bp-fallback-picker-layout/);
    assert.match(css, /\.bp-fallback-picker-columns \{ display: flex;/);
    assert.match(css, /\.bp-fallback-picker-steps \{[^}]*overflow-y: auto/);
    assert.match(css, /\.bp-fallback-picker-column \{[^}]*border: 1px solid var\(--bp-line-strong\)/);
    assert.match(css, /\.bp-fallback-picker-column\.is-selected \{[^}]*border-color: var\(--bp-accent\)/);
});

test('sequential scroll finishes vertical content before moving to the adjacent order, including reverse and bounds', () => {
    const base = { delta: 100, top: 0, height: 600, visible: 200, index: 1, count: 3 };
    assert.deepEqual(sequentialScrollStep(base), { kind: 'vertical', top: 100 });
    assert.deepEqual(sequentialScrollStep({ ...base, top: 390 }), { kind: 'vertical', top: 400 });
    assert.deepEqual(sequentialScrollStep({ ...base, top: 400 }), { kind: 'column', index: 2 });
    assert.deepEqual(sequentialScrollStep({ ...base, top: 0, delta: -100 }), { kind: 'column', index: 0 });
    assert.deepEqual(sequentialScrollStep({ ...base, top: 10, delta: -100 }), { kind: 'vertical', top: 0 });
    assert.deepEqual(sequentialScrollStep({ ...base, top: 400, index: 2 }), { kind: 'boundary' });
    assert.deepEqual(sequentialScrollStep({ ...base, top: 0, delta: -100, index: 0 }), { kind: 'boundary' });
    assert.deepEqual(sequentialScrollStep({ ...base, height: 50 }), { kind: 'column', index: 2 });
});

test('catalogue exposes data, not benchmark DOM, and an unknown entrance has a safe empty view', () => {
    const catalogue = createBenchmarkFallbackCatalogue({ request() { throw new Error('No eager load'); }, onChange() {}, onExpired() {} });
    assert.equal(catalogue.create, undefined);
    assert.deepEqual(catalogue.view(primary).items, []);
    assert.deepEqual(catalogue.featuredFor(primary), []);
    assert.equal(catalogue.view(primary).total, 0);
    assert.equal(catalogue.view(primary).hasMore, false);
    catalogue.invalidate(); assert.equal(catalogue.view(primary).suspended, true);
    catalogue.setSnapshot('same'); assert.equal(catalogue.view(primary).suspended, false);
});

test('replacing a fallback list records one mutation, preserves every entrance weight and allows no fallback', async () => {
    const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const left = source.indexOf('function applyFallbackConfiguration('), right = source.indexOf('function openInlineFallbackPicker(', left);
    const state = { mode: 'personal', loading: false, personalEntries: [{ conditionID: 1, weightBasisPoints: 4500 }, { conditionID: 2, weightBasisPoints: 5500 }] };
    let rule = null, mutations = 0, saves = 0;
    const apply = vm.runInNewContext(source.slice(left, right) + '\napplyFallbackConfiguration', { state, excludedFromRanking, AA_EXCLUSION_MESSAGE,
        beginMutation() { mutations++; return true; }, replaceFallbackRuleEntries(ID, values) { rule = values.length ? { primaryConditionID: ID, entries: values } : null; },
        fallbackRuleFor() { return rule; }, scheduleSave() { saves++; }, focusPersonalBenchmark() {},
        deactivateInlineFallbackTarget() {}, writeWorkspacePreferences() {},
        addObjectToPersonalPie() { assert.fail('Existing entrance must not be added/reweighted'); } });
    const weights = structuredClone(state.personalEntries);
    assert.equal(apply(primary, { entries: entries([3]), familyID: 10 }, 'replace'), true);
    assert.equal(rule.familyID, 10); assert.equal(state.personalFallbackExpanded, true);
    assert.deepEqual(state.personalEntries, weights);
    assert.equal(apply(primary, { entries: [], familyID: null }, 'replace'), true);
    assert.equal(rule, null); assert.equal(state.personalFallbackExpanded, true);
    assert.equal(mutations, 2); assert.equal(saves, 2); assert.deepEqual(state.personalEntries, weights);
    state.loading = true;
    assert.equal(apply(primary, { entries: entries([3]), familyID: 10 }, 'replace'), false);
    assert.equal(mutations, 2);
});

test('skip or customize adds the bare entrance and reveals an empty editor without activating the fallback target', async () => {
    const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const left = source.indexOf('function applyFallbackConfiguration('), right = source.indexOf('function openInlineFallbackPicker(', left);
    const state = { mode: 'personal', loading: false, personalEntries: [] };
    let added = null, focused = null, editing = null;
    const apply = vm.runInNewContext(source.slice(left, right) + '\napplyFallbackConfiguration', { state, excludedFromRanking, AA_EXCLUSION_MESSAGE,
        addObjectToPersonalPie(object) { added = object; return true; },
        focusPersonalBenchmark(object) { focused = object; },
        deactivateInlineFallbackTarget() {}, writeWorkspacePreferences() {},
        beginInlineFallbackEditing(object) { editing = object; } });
    assert.equal(apply(primary, { entries: [], familyID: null, configureOwn: true }, 'add'), true);
    assert.equal(added, primary); assert.equal(focused, primary); assert.equal(state.personalFallbackExpanded, true);
    assert.equal(editing, primary);
    assert.doesNotMatch(source.slice(left, right), /\bactivateInlineFallbackTarget/);
});

test('retired list UI and native help are absent; chooser and editor share one configuration entry point', async () => {
    const workspace = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const picker = await readFile(new URL('../public/js/workspace/fallback-picker.js', import.meta.url), 'utf8');
    const catalogue = await readFile(new URL('../public/js/workspace/benchmark-fallback-catalogue.js', import.meta.url), 'utf8');
    assert.doesNotMatch(workspace, /Direct add|benchmarkFallbackCatalogue\.create|benchmarkFamilyRows\.create|createChainScrollEdges/);
    assert.doesNotMatch(catalogue, /document\.|bp-benchmark-fallback-toggle/);
    assert.doesNotMatch(workspace, /inlineFallback(?:Preview|Settings)\.addEventListener/);
    assert.match(workspace, /inlineFallbackConfigurations\.addEventListener\('click'/);
    assert.doesNotMatch(workspace, /fallbackPicker\.open\(object/);
    assert.doesNotMatch(workspace, /featuredFor\(object\)\.length > 0/);
    assert.match(picker, /setHelpText\(help/); assert.match(picker, /getScope\(\) !== intent\.scope/);
    assert.match(picker, /canApply\(primary\.ID, intent\.action\)/);
    assert.match(picker, /customAdd\.hidden = intent\.action !== 'add'/);
    assert.match(picker, /variant: recommended \? 'quiet' : 'primary'/);
    assert.match(picker, /Skip fallback or create my own/);
    assert.match(picker, /\(not recommended\)/);
    assert.doesNotMatch(picker, /Do not choose|Not among these/);
});
