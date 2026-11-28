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

test('version-based estimation uses calibrated scores and keeps retired coverage controls hidden', () => {
    assert.equal(AVAILABLE_INFERENCE_VERSION, 13);
    assert.match(topics, /availableInferenceVersion:\s*AVAILABLE_INFERENCE_VERSION/);
    assert.match(read('public/js/shared/http.js'), /rankingReadBody\(url, body\)/);
    for (const source of [topics, workspace]) {
        assert.doesNotMatch(source, /readCoveragePenalty|coveragePenaltyVersion|mountCoveragePenaltyControl|coveragePenaltyControl/);
    }
    for (const html of [home, configuration]) assert.doesNotMatch(html, /coverage-experiment|coverage-penalty|Power 0\.35/);
    assert.doesNotMatch(read('public/css/ui/topic-identity.css'), /coverage-experiment/);
    assert.doesNotMatch(configuration, /Estimation method|Score range/);
    assert.match(read('private/how-it-works.html'), /searches all versions of other weighted benchmarks/);
});

test('creation offers private and public visibility while edits use the separate visibility action', () => {
    const editor = read('public/js/shared/private-topic-editor.js');
    assert.doesNotMatch(read('public/js/shared/site-header.js'), /topic-proposals|id="new-topic"/);
    assert.match(editor, /<h2 id="create-topic-title">New topic<\/h2>/);
    assert.match(editor, /'Create private topic' : 'Publish topic'/);
    assert.match(topics, /createPrivateTopicEditor/);
    assert.match(editor, /\/api\/save_private_topic/);
    assert.match(editor, /id="topic-editor-publish" hidden>Make public<\/button>/);
    assert.match(editor, /setTopicVisibility\(topic, topic\.isPrivate\)/);
    assert.match(editor, /topic\.isPrivate \? 'Make public' : 'Make private'/);
    assert.match(editor, /public_topic_limit: 'You can have up to three public topics at a time\./);
    assert.match(read('public/js/shared/topic-actions.js'), /writeTopicAction\('\/api\/set_topic_visibility', \{ categoryID: Number\(topic\.categoryID \?\? topic\.ID\), isPublic/);
    assert.doesNotMatch(topics, /\$\('#new-topic'\)\.addEventListener|openCreateTopic\(false\)|result\.submissionID|createTopicIsPrivate/);
    const sidebarForm = configuration.match(/<form id="topic-create-form"[\s\S]*?<\/form>/)?.[0];
    for (const markup of [editor, sidebarForm]) {
        assert.ok(markup);
        assert.match(markup, /type="radio" name="visibility" value="private" checked/);
        assert.match(markup, /type="radio" name="visibility" value="public"/);
        assert.doesNotMatch(markup, /review result by email|verified address linked/);
    }
});

test('shared navigation has no proposal hall and retains Search and Create topic', () => {
    assert.doesNotMatch(read('public/js/shared/site-header.js'), /topic-proposals/);
    assert.match(topics, /mountSiteActions\(\$\('\.th-header-links'\)/);
    assert.match(read('public/js/shared/page-header.js'), /mountSiteActions\(/);
    assert.match(workspace, /minimal: true, extraActions:/);
    assert.match(home, /<button id="new-private-topic"[^>]*aria-label="Create topic"/);
    assert.match(home, /id="home-topic-collection" aria-label="Topic collection"/);
    assert.ok(home.indexOf('id="home-topic-collection"') > home.indexOf('</header>'));
    assert.match(topics, /prioritizeAccount: true, extraActions: \[\$\('#new-private-topic'\)\]/);
    assert.match(topics, /\$\('#new-private-topic'\)\.addEventListener\('click', event => void privateTopicEditor\.open\(null, event\.currentTarget\)\)/);
    assert.doesNotMatch(home, /id="mine-actions"|topic-proposals/);
});

test('Official or real creator metadata sits in the card footer while the summary follows the title', () => {
    assert.equal((topics.match(/createTopicCreator\(topic\.isOfficial \? \{ isOfficial: true \} : topic\.creator, 'th-creator'\)/g) ?? []).length, 2);
    assert.equal((topics.match(/if \(topic\.sceneID != null\) creator\.hidden = true/g) ?? []).length, 2);
    assert.match(topics, /identity\.append\(title\);\s*if \(topic\.sceneID == null\) identity\.append\(summary\)/);
    assert.match(topics, /author\.append\(creator\)/);
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
    assert.match(css, /\.th-card \{[^}]*grid-template-rows: 62px minmax\(0, 1fr\) 40px;[^}]*height: 408px; padding: 18px 18px 10px/);
    assert.match(css, /\.th-card-header \{[^}]*align-self: start; align-items: start/);
    assert.match(css, /\.th-card-identity \{[^}]*flex-direction: column; align-items: start/);
    assert.match(css, /\.th-card\.is-featured \{[^}]*height: 448px/);
    assert.match(css, /\.th-topic-summary \{[^}]*font-size: 13px; line-height: 20px; font-weight: 400; white-space: nowrap;[^}]*mask-image: linear-gradient/);
    const sidebar = read('public/css/ui/config-sidebar.css');
    assert.match(sidebar, /#config-sidebar \{[^}]*border: 0; background: var\(--bp-surface-soft\)/);
    assert.match(sidebar, /\.selected \{[^}]*border-color: #b8c0c8; background: #e1e5e9; box-shadow: none/);
    assert.match(css, /\.th-card-identity \{[^}]*gap: 1px/);
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
        postJSON: async () => responses.shift(), renderAccount() {}, accountPreview: { refresh() {} }, filterTopics() {}, loadTopics: async () => {}
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
