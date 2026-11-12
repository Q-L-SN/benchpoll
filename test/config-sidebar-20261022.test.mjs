import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configuredRows, entryFromContext, locationURL, popularTopics } from '../public/js/navigation/model.js';
import { readConfigSidebarCollapsed } from '../public/js/shared/config-sidebar.js';
import { addRecentTopic, readRecentTopics, writeRecentTopics, readSidebarPreferences } from '../public/js/navigation/preferences.js';

const privateID = 'PrivateTopic999Token';
const researchScenes = [{ ID: 601, sceneNumber: 1, name: 'General', isDefault: true },
    { ID: 602, sceneNumber: 2, name: 'Physics', isDefault: false }];
const entry = (ID, name, extra = {}) => entryFromContext({ categoryID: ID, publicID: ID,
    lineage: [{ ID, name }], contextValues: {}, ...extra });

test('flat navigation uses the canonical topic helper and real IDs, including duplicate names', () => {
    const first = entry(167, 'Research', { publicID: 11 }), second = entry(190, 'Research', { publicID: 12 });
    assert.equal(locationURL(first), '/11');
    assert.equal(locationURL(second), '/12');
    assert.equal(locationURL(entry(170, 'Biology & Medicine', { publicID: 13 })), '/13');
    assert.equal(locationURL(entry(999, 'My topic', { isPrivate: true, privateID })), `/private/${privateID}`);
    const rows = configuredRows([{ ...first, weightCount: 1 }, { ...second, weightCount: 1 }], second);
    assert.deepEqual(rows.map(row => row.depth), [0, 0]);
    assert.deepEqual(rows.map(row => row.groupStart), [false, false]);
    assert.equal(rows.find(row => row.current).categoryID, 190);
    assert.ok(rows.every(row => row.pathLabel === `Topic ${row.categoryID}`));
});

test('topic URLs use local scene numbers while selected contexts keep internal scene IDs', () => {
    const saved = entry(54, 'Intelligence', { publicID: 1, scenes: researchScenes, contextValues: { scene: '602' } });
    const url = new URL(locationURL(saved), 'https://example.com');
    assert.equal(url.pathname, '/1/2');
    assert.equal(url.search, '');
    assert.equal(saved.sceneID, 602);
    assert.deepEqual(saved.contextValues, { scene: '602' });
    assert.equal(locationURL(entry(54, 'Intelligence', { publicID: 1, scenes: researchScenes })), '/1/1');
    assert.equal(locationURL(entry(999, 'My topic', { isPrivate: true, privateID,
        scenes: researchScenes, contextValues: { scene: '602' } })), `/private/${privateID}/2`);
    assert.throws(() => locationURL(entry(54, 'Intelligence', { publicID: 1, contextValues: { budget: 'standard' } })), /Unsupported topic context/);
});

test('Popular preserves the server favorites order without pinning Intelligence or re-sorting ties', () => {
    const topics = [{ ...entry(54, 'Intelligence', { publicID: 1 }), popularity: 0 }, { ...entry(190, 'Other'), popularity: 7 },
        { ...entry(170, 'Biology'), popularity: 40 }, { ...entry(167, 'Research'), popularity: 7 }];
    const before = structuredClone(topics);
    assert.deepEqual(popularTopics(topics).map(topic => topic.categoryID), [54, 190, 170, 167]);
    assert.deepEqual(popularTopics([entry(190, 'Other'), entry(54, 'Intelligence', { publicID: 1 }), entry(167, 'Research')])
        .map(topic => topic.categoryID), [190, 54, 167]);
    assert.deepEqual(topics, before);
});

test('Configured filters empty or unconfirmed public/private entries and never inserts the browsing topic', () => {
    const saved = { ...entry(54, 'Intelligence'), weightCount: 4 };
    const emptyPrivate = { ...entry(999, 'Private', { isPrivate: true, privateID }), weightCount: 0 };
    const emptyPublic = { ...entry(170, 'Biology'), weightCount: 0 };
    assert.deepEqual(configuredRows([saved, emptyPrivate, emptyPublic, entry(171, 'Unconfirmed')], entry(167, 'Research')).map(row => row.categoryID), [54]);
});

test('Recent stores only numeric/context identity, isolates accounts and keeps contexts distinct', () => {
    const storage = new Map();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)
    } });
    try {
        let visits = addRecentTopic([], entry(54, 'Intelligence'), '1', 10);
        visits = addRecentTopic(visits, entry(167, 'Research', { scenes: researchScenes, contextValues: { scene: '601' } }), '1', 20);
        visits = addRecentTopic(visits, entry(167, 'Research', { scenes: researchScenes, contextValues: { scene: '602' } }), '1', 30);
        visits = addRecentTopic(visits, entry(999, 'Secret private name', { isPrivate: true, privateID }), '1', 40);
        assert.equal(writeRecentTopics('1', visits), true);
        assert.deepEqual(readRecentTopics('1'), [
            { categoryID: 999, contextValues: {}, isPrivate: true, visitedAt: 40 },
            { categoryID: 167, contextValues: { scene: '602' }, isPrivate: false, visitedAt: 30 },
            { categoryID: 167, contextValues: { scene: '601' }, isPrivate: false, visitedAt: 20 },
            { categoryID: 54, contextValues: {}, isPrivate: false, visitedAt: 10 }
        ]);
        assert.deepEqual(readRecentTopics('2'), []);
        assert.deepEqual(readRecentTopics(null), []);
        assert.ok([...storage.values()].every(value => !/Research|Secret|name|url|publicID|privateID/i.test(value)));
        assert.equal(addRecentTopic([], entry(999, 'Secret', { isPrivate: true, privateID }), null, 50).length, 0);
        assert.equal(writeRecentTopics('01', visits), false);
        assert.deepEqual(readRecentTopics('01'), []);
    } finally {
        if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage;
    }
});

test('legacy All preferences migrate to Popular with independent scroll positions', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true,
        value: { getItem: () => JSON.stringify({ view: 'all', scroll: { all: 51, configured: 9 } }) } });
    try {
        const preferences = readSidebarPreferences();
        assert.equal(preferences.view, 'popular');
        assert.deepEqual(preferences.scroll, { popular: 51, recent: 0, configured: 9, search: 0 });
    } finally {
        if (original) Object.defineProperty(globalThis, 'sessionStorage', original); else delete globalThis.sessionStorage;
    }
});

test('navigation preserves canonical numeric URLs, local scenes and ranking parameters for duplicate names', () => {
    const metadata = entry(190, 'Research', { publicID: 23, url: '/23?scoreMode=range' });
    assert.equal(locationURL(metadata), '/23?scoreMode=range');
    assert.equal(metadata.publicID, 23);
    assert.equal(locationURL(entry(191, 'Research', { publicID: 24, url: '/24', scenes: researchScenes,
        contextValues: { scene: '602' } })), '/24/2');
    assert.equal(locationURL(entry(192, 'Research', { publicID: 25 })), '/25');
    for (const url of ['//example.com/leak', '/research', '/23?context_scene=602', '/23?scene=2', '/private/999']) {
        assert.throws(() => locationURL({ ...metadata, url }), /Invalid topic URL/);
    }
});

test('the sidebar has four icon-only modes and private creation lives exclusively in Mine', async () => {
    const html = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    const controls = [...html.matchAll(/<button[^>]*data-navigation-view="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
    assert.deepEqual(controls.map(match => match[1]), ['popular', 'recent', 'configured', 'search']);
    assert.ok(controls.every(match => /aria-label="[^"]+"/.test(match[0]) && /data-tooltip="[^"]+"/.test(match[0]) && !/<span/.test(match[2])));
    const byView = new Map(controls.map(match => [match[1], match[0]]));
    assert.match(byView.get('configured'), /aria-label="Mine" data-tooltip="Mine"/);
    assert.match(byView.get('configured'), /class="fa-solid fa-user"/);
    assert.ok(controls.every(match => /<i class="fa-solid fa-[a-z-]+" aria-hidden="true"><\/i>/.test(match[2])),
        'all four navigation modes use the same solid icon family');
    assert.ok(controls.every(match => !/\s(?:class|style)=/.test(match[0].split('>')[0])),
        'all four buttons, including Search, use the shared navigation styling');
    const mine = html.match(/<section id="configured-panel"[\s\S]*?<\/section>/)[0];
    assert.doesNotMatch(html, /data-create-topic="public"|topic-proposals|Created by me|Configured by me|id="mine-(?:panel|content|login)"/);
    assert.ok(controls.every(match => !/fa-pen-to-square/.test(match[0])));
    assert.match(mine, /data-create-topic="private"/);
    assert.match(mine, /id="topic-create-form"/);
    assert.match(mine, /aria-label="Mine"/);
    assert.match(mine, /<span>Create private topic<\/span>/);
    assert.match(mine, /<p id="topic-visibility-notice" class="bp-private-category-notice">Private topics and their weights stay private and do not affect public rankings\.<\/p>/);
    assert.match(mine, /id="topic-create-form"[^>]*aria-describedby="topic-visibility-notice"/);
    assert.doesNotMatch(html, /private-category-create-toggle|private-category-create-form/);
});

test('sidebar Mine copy covers sign-in, loading, empty and error states without a Created mode', async () => {
    const sidebar = await readFile(new URL('../public/js/navigation/sidebar.js', import.meta.url), 'utf8');
    for (const copy of ['Sign in to see your topics.', 'Loading your topics...', 'Could not load all your topics.', 'No topics in Mine yet.']) {
        assert.ok(sidebar.includes(copy), copy);
    }
    assert.doesNotMatch(sidebar, /topics you created|topics you configured|Configured Pies|No saved Pies yet|topic-proposals|renderMine|mineContent|minePanel/);
});

test('sidebar defaults to collapsed and reads saved booleans without overwriting preferences', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const writes = [];
    try {
        for (const [stored, expected] of [['true', true], ['false', false], ['1', true], ['', true], [null, true]]) {
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
                getItem: () => stored, setItem: (...args) => writes.push(args)
            } });
            assert.equal(readConfigSidebarCollapsed(), expected);
        }
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
        assert.equal(readConfigSidebarCollapsed(), true);
        assert.deepEqual(writes, []);
    } finally {
        if (original) Object.defineProperty(globalThis, 'localStorage', original);
        else delete globalThis.localStorage;
    }
});

test('configuration entry has no presentation or Public composition DOM/modules and keeps public fallback', async () => {
    const html = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    const workspace = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const navigation = await readFile(new URL('../public/js/home.js', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /showcase|public-composition|weight-bars-panel/);
    assert.doesNotMatch(workspace, /publicComposition|createShowcaseView|createChartWorkspace|setWorkspaceDisplay/);
    assert.doesNotMatch(navigation, /load_benchmarks_and_subcategories|loadChildren|rememberExpansion/);
    assert.match(html, /id="public-fallback-toggle"/);
    assert.match(navigation, /benchpoll:profile-updated/);
    assert.doesNotMatch(navigation, /account-center\.js/);
    assert.match(navigation, /\/me/);
});
