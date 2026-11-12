import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readConfigSidebarCollapsed } from '../public/js/shared/config-sidebar.js';
import { createAccountWriteScope, canonicalAccountID } from '../public/js/shared/account-identity.js';
import { AVAILABLE_INFERENCE_VERSION } from '../public/js/shared/available-score.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const home = read('private/index.html');
const configuration = read('private/home.html');
const topics = read('public/js/topics-home.js');
const workspace = read('public/js/home-workspace.js');

test('sidebar defaults to collapsed without writing or replacing any saved boolean preference', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const writes = [];
    try {
        for (const [stored, expected] of [[null, true], ['true', true], ['false', false], ['', true], ['invalid', true]]) {
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
                getItem(key) { assert.equal(key, 'benchpoll:config-sidebar-collapsed'); return stored; },
                setItem(...args) { writes.push(args); }
            } });
            assert.equal(readConfigSidebarCollapsed(), expected, String(stored));
        }
        Object.defineProperty(globalThis, 'localStorage', { configurable: true,
            get() { throw new Error('Storage unavailable'); } });
        assert.equal(readConfigSidebarCollapsed(), true);
        assert.deepEqual(writes, []);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        else delete globalThis.localStorage;
    }
});

test('only the rational inference version is used; neither page exposes experiment controls', () => {
    assert.equal(AVAILABLE_INFERENCE_VERSION, 7);
    for (const source of [topics, workspace]) {
        assert.match(source, /import \{ AVAILABLE_INFERENCE_VERSION \} from '\.\/shared\/available-score\.js'/);
        assert.match(source, /availableInferenceVersion\s*[:=]\s*AVAILABLE_INFERENCE_VERSION/);
        assert.doesNotMatch(source, /readCoveragePenalty|coveragePenaltyVersion|mountCoveragePenaltyControl|coveragePenaltyControl/);
    }
    for (const html of [home, configuration]) assert.doesNotMatch(html, /coverage-experiment|coverage-penalty|Power 0\.35/);
    assert.doesNotMatch(read('public/css/ui/topic-identity.css'), /coverage-experiment/);
    assert.match(configuration, /adjusts the whole index for measured coverage/);
    assert.match(read('private/how-it-works.html'), /f\(c\)=5c\/\(1\+4c\)[^\n]*negatives 2-f\(c\)/);
});

test('topic creation starts private and the editor publishes directly with a three-public-topic limit', () => {
    const editor = read('public/js/shared/private-topic-editor.js');
    assert.doesNotMatch(read('public/js/shared/site-header.js'), /topic-proposals|id="new-topic"/);
    assert.match(home, /<h2 id="create-topic-title">New private topic<\/h2>/);
    assert.match(home, /id="create-topic-submit"[^>]*>[\s\S]*?<span>Create private topic<\/span>/);
    assert.match(topics, /createPrivateTopicEditor/);
    assert.match(editor, /\/api\/save_private_topic/);
    assert.match(editor, /id="topic-editor-publish" hidden>Make public<\/button>/);
    assert.match(editor, /setTopicVisibility\(topic, topic\.isPrivate\)/);
    assert.match(editor, /topic\.isPrivate \? 'Make public' : 'Make private'/);
    assert.match(editor, /public_topic_limit: 'You can have up to three public topics at a time\./);
    assert.match(read('public/js/shared/topic-actions.js'), /writeTopicAction\('\/api\/set_topic_visibility', \{ categoryID: Number\(topic\.categoryID \?\? topic\.ID\), isPublic/);
    assert.doesNotMatch(topics, /\$\('#new-topic'\)\.addEventListener|openCreateTopic\(false\)|result\.submissionID|createTopicIsPrivate/);
    const modal = home.slice(home.indexOf('<dialog id="create-topic-dialog"'));
    const sidebarForm = configuration.match(/<form id="topic-create-form"[\s\S]*?<\/form>/)?.[0];
    for (const markup of [modal, sidebarForm]) {
        assert.ok(markup);
        assert.doesNotMatch(markup, /type="(?:checkbox|radio)"|review result by email|verified address linked/);
    }
    assert.match(sidebarForm, /<input type="hidden" name="visibility" value="private">/);
});

test('shared navigation has no proposal hall and Create topic remains beside directory Search', () => {
    assert.doesNotMatch(read('public/js/shared/site-header.js'), /topic-proposals/);
    assert.match(topics, /mountSiteActions\(\$\('\.th-header-links'\)/);
    assert.match(read('public/js/shared/page-header.js'), /mountSiteActions\(/);
    assert.match(workspace, /minimal: true, extraActions:/);
    const actions = home.match(/<div class="th-topic-tabs"[\s\S]*?<\/div>/)?.[0];
    assert.ok(actions);
    assert.match(actions, /id="topic-search-toggle"[\s\S]*?<\/button>\s*<button id="new-private-topic"[^>]*aria-label="Create topic"/);
    assert.match(topics, /\$\('#new-private-topic'\)\.addEventListener\('click', event => void privateTopicEditor\.open\(null, event\.currentTarget\)\)/);
    assert.doesNotMatch(home, /id="mine-actions"|topic-proposals/);
});

test('Official or real creator metadata sits in the card footer while the summary follows the title', () => {
    assert.equal((topics.match(/createTopicCreator\(topic\.isOfficial \? \{ isOfficial: true \} : topic\.creator, 'th-creator'\)/g) ?? []).length, 2);
    assert.equal((topics.match(/if \(topic\.sceneID != null\) creator\.hidden = true/g) ?? []).length, 2);
    assert.match(topics, /identity\.append\(title\);\s*if \(topic\.sceneID == null\) identity\.append\(summary\)/);
    assert.match(topics, /author\.append\(creator, createCardReport\(topic\)\)/);
    assert.match(topics, /footer\.append\(author, topicMeta, sceneToggle\)/);
    const identity = read('public/js/shared/topic-identity.js');
    assert.match(identity, /if \(creator\?\.isOfficial\) \{[\s\S]*?fa-solid fa-circle-check[\s\S]*?'Official'/);
    assert.match(identity, /if \(!creator\?\.name\) \{ byline\.hidden = true; return byline; \}/);
    assert.match(topics, /frame\.append\(state\.pagination\)/);
    assert.match(topics, /topic\.name\), icon\('chevron-right'\)/);
    assert.match(workspace, /if \(state\.topicMetadata\?\.isOfficial\)/);
    assert.match(workspace, /else if \(state\.topicCreator\) creator\.append\(createTopicCreator\(state\.topicCreator\)\)/);
    assert.match(configuration, /class="bp-context-actions">[\s\S]*?<span id="workspace-topic-creator"/);
    const breadcrumb = workspace.slice(workspace.indexOf('function renderBreadcrumb()'), workspace.indexOf('function templateValueClass('));
    assert.doesNotMatch(breadcrumb, /breadcrumb\.append\(createTopicCreator/);
});

test('the second-line summary and plot controls preserve fixed cards and avoid accent side decoration', () => {
    const css = read('public/css/topics-home.css');
    assert.match(css, /\.th-card \{[^}]*grid-template-rows: 62px minmax\(0, 1fr\) 40px;[^}]*height: 416px/);
    assert.match(css, /\.th-card-header \{[^}]*align-self: start; align-items: start/);
    assert.match(css, /\.th-card-identity \{[^}]*flex-direction: column; align-items: start/);
    assert.match(css, /\.th-card\.is-featured \{[^}]*height: 456px/);
    assert.match(css, /\.th-topic-summary \{[^}]*font-size: 13px; line-height: 20px; font-weight: 400; white-space: nowrap;[^}]*mask-image: linear-gradient/);
    const sidebar = read('public/css/ui/config-sidebar.css');
    assert.match(sidebar, /#config-sidebar \{[^}]*border: 0; background: var\(--bp-surface-soft\)/);
    assert.match(sidebar, /\.selected \{[^}]*border-color: #b8c0c8; background: #e1e5e9; box-shadow: none/);
    assert.match(sidebar, /button:is\([^}]*aria-pressed="true"[^}]*\) > \.fa-regular \{ font-weight: 900; \}/);
    assert.doesNotMatch(sidebar, /border-(?:left|right|top|bottom|inline-start|inline-end):[^;]*accent/);
});

test('Beta feedback remains visible in the root introduction and keeps the private prefill handoff', () => {
    assert.doesNotMatch(configuration, /id="beta-feedback-link"/);
    assert.match(home, /<section id="home-hero"[\s\S]*?<a id="beta-feedback-link"[^>]*href="\/contribute\/feedback"[\s\S]*?<\/section>/);
    assert.match(home, /BenchPoll is in beta\. Tell us what to improve\./);
    assert.match(topics, /details: betaFeedbackTemplate\(\), pageURL: `\$\{location\.origin\}\$\{location\.pathname\}`/);
    assert.match(topics, /betaFeedbackLink\.addEventListener\('click', prepareBetaFeedback\)/);
});

function workspaceHook({ checkpoint = true, flush = true, refresh = true, loading = false } = {}) {
    const calls = [];
    const state = { categoryID: 54, categoryPath: 'intelligence', topicName: 'Intelligence',
        selectedContextValues: { budget: 'standard' }, rankingPagination: {}, usingGuestDraft: checkpoint,
        mode: 'personal', workspaceView: 'overview' };
    const source = workspace.slice(workspace.indexOf('async function applyWorkspaceState('),
        workspace.indexOf('personalModeButton.addEventListener(', workspace.indexOf('async function applyWorkspaceState(')));
    const hook = runInNewContext(`(${source.trim()})`, {
        state, comparisonProfileLoading: loading, comparisonProfilesReady: Promise.resolve(true),
        finishPendingWeightAdjustments: async () => { calls.push('adjustments'); return true; },
        flushPendingPersonalPieSave: async () => { calls.push('flush'); return flush; },
        recordPersonalDraft: () => { calls.push('checkpoint'); return true; },
        loadComparisonProfiles: async () => { calls.push('account-settings'); return true; },
        loadWeightedWorkspace: async options => { calls.push(['workspace', options ? JSON.parse(JSON.stringify(options)) : null]); }
    });
    return { calls, state, run: () => hook({ currentCategoryID: 54, categoryPath: 'intelligence', accountRefresh: refresh }) };
}

test('accountRefresh checkpoints the guest draft and refreshes settings plus the same-context workspace with undo preserved', async () => {
    const hook = workspaceHook({ loading: true });
    await hook.run();
    assert.deepEqual(hook.calls, ['adjustments', 'flush', 'checkpoint', 'account-settings', ['workspace', { preserveUndo: true }]]);
    assert.deepEqual(hook.state.selectedContextValues, { budget: 'standard' });
});

test('normal same-context updates do not force reloads, and an unconfirmed save still blocks account refresh', async () => {
    const unchanged = workspaceHook({ refresh: false });
    await unchanged.run();
    assert.deepEqual(unchanged.calls, ['adjustments', 'flush']);
    const blocked = workspaceHook({ flush: false });
    await blocked.run();
    assert.deepEqual(blocked.calls, ['adjustments', 'flush']);
});

function rootAccountHooks(responses) {
    const scope = createAccountWriteScope();
    let reloads = 0;
    const source = topics.slice(topics.indexOf('async function loadProfile()'), topics.indexOf('const profileReady = loadProfile();'));
    const hooks = runInNewContext(source + '\n({ loadProfile, accountSignedOut, snapshot: () => ({ profile, accountSessionEnded, boundAccountID }) })', {
        profile: null, profileReadFailed: false, profileLoading: false, accountEpoch: 0,
        boundAccountID: null, accountSessionEnded: false, cards: new Map(), visibility: null, scenesDialog: { close() {} },
        pageAccountWriteScope: scope, canonicalAccountID, location: { reload: () => { reloads++; } },
        postJSON: async () => responses.shift(), renderAccount() {}, filterTopics() {}, loadTopics: async () => {}
    });
    return { ...hooks, scope, reloads: () => reloads };
}

test('an initial guest or guest sign-out signal does not poison first sign-in account binding', async () => {
    const hooks = rootAccountHooks([null, null, { userID: '42', userName: 'Member' }]);
    await hooks.loadProfile();
    await hooks.accountSignedOut({ signedOut: true });
    await hooks.accountSignedOut({ signedOut: false });
    assert.equal(hooks.snapshot().profile.userID, '42');
    assert.equal(hooks.snapshot().accountSessionEnded, false);
    assert.equal(hooks.scope.capture(), '42');
    assert.equal(hooks.reloads(), 0);
});

test('a bound account sign-out keeps exact-owner writes blocked and requires reload before a later sign-in', async () => {
    const hooks = rootAccountHooks([{ userID: '42' }, null]);
    await hooks.loadProfile();
    await hooks.accountSignedOut({ signedOut: true });
    assert.equal(hooks.snapshot().accountSessionEnded, true);
    assert.throws(() => hooks.scope.capture(), /account changed/i);
    await hooks.accountSignedOut({ signedOut: false });
    assert.equal(hooks.reloads(), 1);
    assert.throws(() => hooks.scope.capture(), /account changed/i);
});

test('a true root account switch reloads without rebinding the old document write scope', async () => {
    const hooks = rootAccountHooks([{ userID: '42' }, { userID: '43' }]);
    await hooks.loadProfile();
    await hooks.accountSignedOut({ signedOut: false });
    assert.equal(hooks.reloads(), 1);
    assert.throws(() => hooks.scope.capture(), /account changed/i);
});

test('both edited entry modules bundle against the real dependency graph without retired controls', async () => {
    for (const file of ['public/js/topics-home.js', 'public/js/home-workspace.js']) {
        const result = await build({ entryPoints: [fileURLToPath(new URL('../' + file, import.meta.url))],
            bundle: true, format: 'esm', platform: 'browser', write: false });
        assert.ok(result.outputFiles[0].text.length > 0);
    }
});
