import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertResidualFixes, inspectResidualFixes, inspectVisibilityFixes, motionCallerImports,
    motionTraceIdentity, parseReviewArgs, reproduceNodeCoordination, visibilityMatches } from '../scripts/review-coordination-20261008.mjs';

for (const iteration of [1, 2]) {
    test(`coordination characterization repeats deterministically (${iteration})`, async () => {
        const result = await reproduceNodeCoordination();
        assert.deepEqual(result.splitMotion, { distinct: true, sameURLCached: true,
            animationCount: 1, hidden: true, inert: false, ariaHidden: 'false' });
        assert.deepEqual(result.canonicalMotion, { animationCount: 2, oldCancelled: true,
            hidden: false, inert: false, ariaHidden: 'false' });
        assert.deepEqual(result.directHide, { hiddenAfterShowFinishes: false });
        assert.deepEqual(result.coordinatedHide, { hidden: true, inert: true, oldCancelled: true });
        assert.deepEqual(result.asyncReplay, {
            afterLivePublish: { commits: ['new'], oldComplete: false, subscriptionReturnType: 'function' },
            finalCommits: ['new', 'old'], oldComplete: true
        });
        assert.deepEqual(result.rejections, {
            liveRejection: 'fixture live rejection', unhandledReplay: ['fixture replay rejection']
        });
        assert.deepEqual(result.channelIdentity, { workspaceAndNavigationAreSeparate: true });
    });
}

test('current caller/import anchors distinguish a real caller from a synthetic risk', async () => {
    const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
    const workspace = await read('public/js/home-workspace.js');
    const sidebar = await read('public/js/navigation/sidebar.js');
    const home = await read('public/js/home.js');
    const channel = await read('public/js/shared/workspace-channel.js');
    const workspaceMotion = motionCallerImports({ 'public/js/home-workspace.js': workspace })['/js/home-workspace.js'];
    assert.match(workspaceMotion, /^\/js\/shared\/motion\.js(?:\?v=[a-zA-Z0-9_-]+)?$/);
    assert.match(sidebar, /from '\.\.\/shared\/motion\.js'/);
    const fixes = inspectVisibilityFixes(workspace);
    assert.doesNotMatch(workspace, /state\.publicCompositionVisible/);
    assert.match(workspace, /void setVisible\(inlineFallback, Boolean\(primary\), \{ collapse: true \}\)/);
    assert.match(workspace, /void setVisible\(inlineFallbackSettings, false, \{ collapse: true \}\)/);
    assert.equal(fixes.agiDesiredGuard, false);
    assert.equal(fixes.locations.agi, 0);
    assert.doesNotMatch(workspace, /agi-promo/);
    assert.match(workspace, /workspaceChannel\.subscribe\(detail => applyWorkspaceState\(detail\)\)/);
    assert.match(workspace, /async function applyWorkspaceState/);
    assert.match(sidebar, /navigationChannel\.subscribe\(snapshot => \{/);
    assert.doesNotMatch(sidebar, /navigationChannel\.subscribe\(async/);
    assert.match(home, /navigationChannel\.subscribe\(\(\) => \{ lastWorkspaceURL = window\.location\.href; \}\)/);
    assert.match(channel, /if \(current\) listener\(\{ \.\.\.current \}\)/);
});

test('expect-fixed arguments require a fresh label and do not default to fixed claims', () => {
    assert.deepEqual(parseReviewArgs(['--run', 'after1']), { run: 'after1', expectFixed: false });
    assert.deepEqual(parseReviewArgs(['--run', 'after1', '--expect-fixed']), { run: 'after1', expectFixed: true });
    assert.deepEqual(parseReviewArgs(['--expect-fixed', '--run', 'after2']), { run: 'after2', expectFixed: true });
    for (const args of [[], ['--run'], ['--run', '../final1'], ['--run', '--expect-fixed'],
        ['--run', 'after1', '--unknown'], ['--run', 'after1', '--expect-fixed', '--expect-fixed']]) {
        assert.throws(() => parseReviewArgs(args));
    }
});

test('fixed visibility includes hidden, inert and aria-hidden, not just temporary rendering', () => {
    assert.equal(visibilityMatches({ hidden: true, inert: true, ariaHidden: 'true' }, false), true);
    assert.equal(visibilityMatches({ hidden: false, inert: false, ariaHidden: 'false' }, true), true);
    assert.equal(visibilityMatches({ hidden: false, inert: true, ariaHidden: 'true' }, true), false);
    assert.equal(visibilityMatches({ hidden: true, inert: false, ariaHidden: 'false' }, false), false);
});

test('source inspection distinguishes the original hidden guard from the desired-state fixes', () => {
    const original = "if (state.mode === 'public' && state.publicCompositionVisible) {\ninlineFallback.hidden = true;\n}\nif (agiPromo.hidden === showAGI) void setVisible(agiPromo, showAGI);";
    const fixed = "if (state.mode === 'public' && state.publicCompositionVisible) {\nvoid setVisible(inlineFallback, false, { collapse: true });\n}\nif (agiPromo.getAttribute('aria-hidden') !== String(!showAGI)) void setVisible(agiPromo, showAGI);";
    assert.equal(inspectVisibilityFixes(original).compositionFixed, false);
    assert.equal(inspectVisibilityFixes(original).agiDesiredGuard, false);
    assert.equal(inspectVisibilityFixes(fixed).compositionFixed, true);
    assert.equal(inspectVisibilityFixes(fixed).agiDesiredGuard, true);
});

test('authorized same-target cleanup uses the same motion module and preserves closed toggles', async () => {
    const read = path => readFile(new URL('../public/js/' + path, import.meta.url), 'utf8');
    const sidebar = await read('navigation/sidebar.js');
    const profileMenu = await read('workspace/comparison-profile-menu.js');
    const fixes = inspectResidualFixes(sidebar, profileMenu);
    assert.equal(fixes.privateFormFixed, true);
    assert.equal(fixes.profileEditorFixed, true);
    assert.ok(fixes.locations.guestCleanup > 0 && fixes.locations.editorClose > 0);
    assert.match(sidebar, /from '\.\.\/shared\/motion\.js'/);
    assert.match(profileMenu, /from '\.\.\/shared\/motion\.js'/);
    assert.match(sidebar, /void setVisible\(createForm, true, \{ collapse: true \}\)/);
    assert.match(profileMenu, /setVisible\(editor, true, \{ collapse: true \}\)/);
    assert.equal(inspectResidualFixes("if (!account) { createForm.hidden = true; createForm.inert = true; }",
        "if (!open) { editing = null; editor.hidden = true; }").privateFormFixed, false);
    assert.equal(inspectResidualFixes('', "if (!open) { editing = null; editor.hidden = true; }").profileEditorFixed, false);
    for (const broken of [
        sidebar.replace('createForm.reset()', 'createForm.checkValidity()'),
        sidebar.replace('void setVisible(createForm, false, { collapse: true })', 'createForm.hidden = true'),
        sidebar.replace("createButtons.forEach(button => button.setAttribute('aria-expanded', 'false'))", '')
    ]) assert.equal(inspectResidualFixes(broken, profileMenu).privateFormFixed, false);
});

test('WebKit query-stripped stacks retain raw evidence and use actual caller import identity', async () => {
    const imports = motionCallerImports({
        'public/js/home-workspace.js': "import { setVisible } from './shared/motion.js?v=comparison-experiment-20261007';",
        'public/js/navigation/sidebar.js': "import { setVisible, animateContent } from '../shared/motion.js';"
    });
    assert.equal(imports['/js/home-workspace.js'], '/js/shared/motion.js?v=comparison-experiment-20261007');
    assert.equal(imports['/js/navigation/sidebar.js'], '/js/shared/motion.js');
    const evidence = JSON.parse(await readFile(new URL('../artifacts/review-20261008/coordination-after2/webkit-desktop/failure.json', import.meta.url), 'utf8'));
    const versioned = evidence.state.trace.find(item => item.id === 'inline-fallback-settings');
    assert.equal(versioned.motion, '/js/shared/motion.js', 'Preserved failed harness misattribution');
    assert.deepEqual(motionTraceIdentity(versioned.stack, imports), {
        rawMotion: '/js/shared/motion.js', caller: '/js/home-workspace.js',
        motion: '/js/shared/motion.js?v=comparison-experiment-20261007', attribution: 'actual-caller-import'
    });
    const bare = evidence.state.trace.find(item => item.id === 'configured-search-wrap');
    assert.equal(motionTraceIdentity(bare.stack, imports).motion, '/js/shared/motion.js');
    assert.equal(motionTraceIdentity('unrelated stack', imports).motion, null);
});

test('expect-fixed rejects residual visibility, missing cancellation and reopened guest toggles', () => {
    const hidden = { hidden: true, inert: true, ariaHidden: 'true', rendered: false };
    const completion = { captured: 2, cancelled: 1, repeatedCompletions: 1 };
    const fixed = { profileEditor: { bug: false, closed: hidden, reopened: hidden, completion },
        privateForm: { bug: false, cleared: hidden, after: hidden, completion, toggleExpanded: 'false',
            createButtonsClosed: true, guestPromptVisible: true } };
    assert.doesNotThrow(() => assertResidualFixes(fixed));
    const bug = structuredClone(fixed); bug.profileEditor.bug = true;
    assert.throws(() => assertResidualFixes(bug));
    const uncancelled = structuredClone(fixed); uncancelled.privateForm.completion.cancelled = 0;
    assert.throws(() => assertResidualFixes(uncancelled));
    const inaccessible = structuredClone(fixed); inaccessible.privateForm.after.ariaHidden = 'false';
    assert.throws(() => assertResidualFixes(inaccessible));
    const expanded = structuredClone(fixed); expanded.privateForm.toggleExpanded = 'true';
    assert.throws(() => assertResidualFixes(expanded));
    const otherToggleExpanded = structuredClone(fixed); otherToggleExpanded.privateForm.createButtonsClosed = false;
    assert.throws(() => assertResidualFixes(otherToggleExpanded));
    const missingGuestPrompt = structuredClone(fixed); missingGuestPrompt.privateForm.guestPromptVisible = false;
    assert.throws(() => assertResidualFixes(missingGuestPrompt));
});
