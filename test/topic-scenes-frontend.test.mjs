import assert from 'node:assert/strict';
import test from 'node:test';
import { readRankingContext, rankingContextURL } from '../public/js/shared/ranking-url.js';
import { orderedScenes, matchingScenes, sceneNavigationEntries, searchTopicGroups } from '../public/js/navigation/scenes.js';
import { entryFromContext, locationURL, validateNavigationPayload } from '../public/js/navigation/model.js';
import { referenceGroups, validateReferenceTargets, referenceIssueMessage, topicReferenceUnavailable } from '../public/js/workspace/topic-references.js';
import { createWeightTreemapLayout } from '../public/js/workspace/weight-treemap-layout.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { createPersonalPieRecovery } from '../public/js/workspace/pie-recovery.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';

const scenes = [{ ID: 20, sceneNumber: 2, name: 'Vector', description: 'Editable image output', isDefault: false },
    { ID: 10, sceneNumber: 1, name: 'General', description: 'General image generation', isDefault: true }];
const topic = { ID: 54, name: 'Images', categoryID: 54, categoryName: 'Images', publicID: 11, url: '/11', scenes, contextValues: {} };
const targets = [{ contextID: 10, categoryID: 54, sceneID: 10, name: 'Images / General', topicName: 'Images', sceneName: 'General',
    publicID: 11, sceneNumber: 1, url: '/11/1', description: 'General images', isPrivate: false, hasWeights: true },
{ contextID: 20, categoryID: 54, sceneID: 20, name: 'Images / Vector', topicName: 'Images', sceneName: 'Vector',
    publicID: 11, sceneNumber: 2, url: '/11/2', description: 'Editable output', isPrivate: false, hasWeights: true },
{ contextID: 30, categoryID: 55, sceneID: null, name: 'Coding', topicName: 'Coding', sceneName: null,
    publicID: 2, url: '/2', description: 'Software development', isPrivate: false, hasWeights: true }];

test('reference eligibility blocks only self, empty targets and private visibility mismatches', () => {
    assert.match(topicReferenceUnavailable(targets[0], 10, false), /same scene or topic/);
    assert.match(topicReferenceUnavailable({ ...targets[1], hasWeights: false }, 10, false), /no weights yet/);
    assert.equal(topicReferenceUnavailable(targets[1], 10, false), '', 'Another scene can be referenced');
    assert.equal(topicReferenceUnavailable(targets[2], 10, false), '', 'Another topic can be referenced');
    assert.equal(topicReferenceUnavailable({ ...targets[2], references: [10] }, 10, false), '', 'An indirect loop does not block adding');
    assert.match(topicReferenceUnavailable({ ...targets[2], isPrivate: true }, 10, false), /Private topics/);
    assert.equal(topicReferenceUnavailable({ ...targets[2], isPrivate: true }, 10, true), '');
    assert.match(topicReferenceUnavailable({ ID: -10, type: 'topic', hasWeights: true }, 10, false), /same scene or topic/);
});

test('scene URLs use numeric paths and preserve focus while old scene queries are rejected', () => {
    assert.deepEqual(readRankingContext('?focusModel=91', []), {});
    const url = rankingContextURL('https://benchpoll.com/11/1?focusModel=91', [], { scene: '20' }, scenes);
    assert.equal(url.pathname, '/11/2'); assert.equal(url.search, '?focusModel=91');
    for (const search of ['?scene=20', '?scene=0', '?scene=-10', '?scene=abc', '?scene=9007199254740992', '?scene=10&scene=20', '?context_scene=10']) {
        assert.throws(() => rankingContextURL('https://benchpoll.com/11' + search, [], { scene: '20' }, scenes));
        assert.throws(() => readRankingContext(search, []), search);
    }
    assert.throws(() => rankingContextURL(url.href, [], { scene: '999' }, scenes));
});

test('default scene leads stable tabs; scene search uses names', () => {
    assert.deepEqual(orderedScenes(scenes).map(scene => scene.ID), [10, 20]);
    assert.deepEqual(scenes.map(scene => scene.ID), [20, 10]);
    assert.deepEqual(matchingScenes(topic, 'vector').map(scene => scene.ID), [20]);
    assert.deepEqual(matchingScenes(topic, 'editable'), []);
    const entries = sceneNavigationEntries([entryFromContext(topic)]);
    assert.equal(entries.length, 3);
    assert.equal(locationURL(entries[2]), '/11/2');
    assert.equal(entries[2].contextLabel, 'Vector');
    assert.equal(locationURL(entries[0]), '/11/1');
});

test('parent-only searches keep all scenes available without treating inherited names or summaries as matches', () => {
    const parent = { ...topic, name: 'Image Generation', description: 'Create still pictures.', scenes: [
        { ...scenes[0], description: 'Image Generation: Vector.' },
        { ...scenes[1], description: 'Create still pictures.' }
    ] };
    for (const query of ['', 'Image Generation', 'IMAGE generation', 'Create still pictures', 'Image Generaton']) {
        const [group] = searchTopicGroups([parent], query);
        assert.equal(group.topic, parent, query);
        assert.equal(group.topicMatch, true, query);
        assert.deepEqual(group.scenes, [], query);
        assert.equal(group.topic.scenes.length, 2, 'expansion retains the complete scene catalogue');
    }
    assert.equal(searchTopicGroups([parent], 'unrelated').length, 0);
    const onlyParent = { categoryName: 'Coding', description: 'Software development' };
    assert.deepEqual(searchTopicGroups([onlyParent], 'coding'), [{ topic: onlyParent, topicMatch: true, scenes: [] }]);
});

test('scene names and combined parent/scene queries remain directly searchable', () => {
    for (const query of ['Vector', 'Images Vector', 'Véctor', 'Vetor']) {
        const [group] = searchTopicGroups([topic], query);
        assert.equal(group.topicMatch, false, query);
        assert.deepEqual(group.scenes.map(scene => scene.ID), [20], query);
    }
    const mixed = { ...topic, name: 'Vector Images' };
    const [group] = searchTopicGroups([mixed], 'Vector');
    assert.equal(group.topicMatch, true);
    assert.deepEqual(group.scenes.map(scene => scene.ID), [20], 'a parent match does not hide directly matched scenes or reveal other siblings');
    const shared = { ...topic, scenes: scenes.map(scene => ({ ...scene, description: 'Shared goal' })) };
    assert.deepEqual(searchTopicGroups([shared], 'Shared goal'), []);
});

test('a language name expands neither all 184 sibling languages nor other topic scenes', () => {
    const parent = { ID: 219, name: 'Language', description: 'Understand and communicate across languages.', scenes: [
        { ID: 1, name: 'General', isDefault: true, description: 'Language: General.' },
        { ID: 2, name: 'English', description: 'Language: English.' },
        ...Array.from({ length: 183 }, (_, i) => ({ ID: i + 3, name: `Option ${i}`, description: `Language: Option ${i}.` }))
    ] };
    assert.equal(searchTopicGroups([parent], 'Language')[0].scenes.length, 0);
    assert.deepEqual(searchTopicGroups([parent], 'English')[0].scenes.map(scene => scene.ID), [2]);
});

test('private scene navigation remains scoped and has readable scene labels', () => {
    const entry = entryFromContext({ ...topic, isPrivate: true, ID: 20, url: '/private/AbCdEf123456', sceneID: 20, contextValues: { scene: '20' } });
    assert.equal(entry.contextID, 20);
    assert.equal(entry.contextLabel, 'Vector');
    assert.equal(locationURL(entry), '/private/AbCdEf123456/2');
    assert.equal(validateNavigationPayload({ userID: '1', items: [entry] }).items.length, 1);
});

test('reference chooser groups scenes but never exposes an ambiguous root selection', () => {
    const root = { ...targets[0], contextID: 9, sceneID: null, sceneName: null };
    assert.deepEqual(referenceGroups([root, ...targets]).map(group => [group.name, group.hasScenes, group.targets.map(target => target.contextID)]),
        [['Images', true, [10, 20]], ['Coding', false, [30]]]);
    assert.deepEqual(referenceGroups(targets, 'Vector').flatMap(group => group.targets.map(target => target.contextID)), [20]);
    assert.deepEqual(referenceGroups(targets, 'Images').flatMap(group => group.targets.map(target => target.contextID)), [10, 20]);
    assert.equal(referenceGroups(targets, 'Images')[0].collapsed, true);
    assert.equal(referenceGroups(targets, '')[0].collapsed, true);
    assert.equal(referenceGroups(targets, 'Vector')[0].collapsed, false);
    assert.deepEqual(referenceGroups(targets, 'Images Vector')[0].targets.map(target => target.contextID), [20]);
    assert.deepEqual(referenceGroups([targets[1], { ...targets[0], isDefault: true }], 'Images')[0].targets.map(target => target.contextID), [10, 20]);
});

test('reference payload validation rejects duplicate identities, foreign URLs and mismatched scene IDs', () => {
    assert.equal(validateReferenceTargets({ targets }).length, 3);
    for (const invalid of [[...targets, targets[0]], [{ ...targets[0], sceneID: 21 }], [{ ...targets[0], url: 'https://example.com' }]]) {
        assert.throws(() => validateReferenceTargets({ targets: invalid }));
    }
    assert.match(referenceIssueMessage({ name: 'Vector', reason: 'empty' }), /Vector: No weights/);
});

test('mixed treemap keeps positive benchmark and negative reference identity and area', () => {
    const tiles = createWeightTreemapLayout()([{ conditionID: 1, weightBasisPoints: 2500 }, { conditionID: -20, weightBasisPoints: 7500 }], 400, 400);
    assert.equal(tiles.length, 2);
    assert.equal(tiles[0].conditionID, -20);
    assert.equal(tiles[0].width * tiles[0].height / (tiles[1].width * tiles[1].height), 3);
});

test('owned recovery retains topic references and exact scene scope', () => {
    const values = new Map(), store = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const state = Object.assign(createWorkspaceState(), { userID: '1', authenticated: true, categoryID: 54,
        selectedContextValues: { scene: '10' }, personalRevision: 1, personalEditVersion: 1 });
    const draft = { entries: [{ conditionID: 1, weightBasisPoints: 2500 }, { conditionID: -20, weightBasisPoints: 7500 }], fallbackRules: [] };
    const recovery = createPersonalPieRecovery({ state, getStorage: () => store, guestDrafts: {}, snapshot: () => draft });
    recovery.checkpoint();
    assert.deepEqual(recovery.lookup('1', 54, { scene: '10' }).value.draft, draft);
    assert.equal(recovery.lookup('1', 54, { scene: '20' }), null);
    assert.equal(recovery.lookup('2', 54, { scene: '10' }), null);
});

test('workspace mixed entries validate independently of benchmark fallback identities', () => {
    const value = workspace(createFixtureState(), { categoryID: 1, scoreMode: 'range' });
    value.context = { ...value.context, ID: 10, sceneID: 10, scenes, contextValues: { scene: '10' }, dimensions: [] };
    const entry = { type: 'topic', referenceContextID: 20, conditionID: -20, name: 'Images / Vector', weightBasisPoints: 500 };
    value.personalPie.entries.push(entry); value.publicPie.entries.push(entry);
    value.personalPie.referenceIssues = [{ targetContextID: 20, name: 'Vector', reason: 'empty' }];
    value.personalPie.effectiveEntries = [{ ...entry, unavailable: true }];
    assert.equal(validateWorkspacePayload(value), value);
    value.personalPie.fallbackRules.push({ primaryConditionID: -20, mode: 'ordered', entries: [] });
    assert.throws(() => validateWorkspacePayload(value), /invalid primary/);
});
