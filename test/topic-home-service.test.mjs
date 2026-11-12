import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopicPreview, topicPreviewComparison, serializeTopicPreviewModels, createTopicHomeService } from '../topic-home-service.js';
import { comparisonDisplayParts } from '../public/js/shared/comparison-display.js';

test('home previews default to Estimated score and forbid configuration or arbitrary filters', () => {
    assert.equal(normalizeTopicPreview({ categoryID: 54 }).scoreMode, 'available');
    for (const body of [{ categoryID: 54, weights: [] }, { categoryID: 54, importFrom: 2 },
        { categoryID: 54, reasoning: 'yes' }, { categoryID: 54, offset: 25 }, { categoryID: '54' }]) {
        assert.throws(() => normalizeTopicPreview(body));
    }
});

test('quick comparisons only split effort/harness, preserving Model and missing values', () => {
    const fields = [{ ID: 8, name: 'Harness', type: 'enum' }, { ID: 3, name: 'Effort', type: 'enum' }];
    assert.deepEqual(topicPreviewComparison(fields, { reasoning: true, harness: true }),
        { mode: 'best', filters: [], keys: ['model', 'field:3', 'field:8'] });
    assert.deepEqual(topicPreviewComparison([], { reasoning: true, harness: true }).keys, ['model']);
});

test('home model serialization excludes heavy score evidence and private member records', () => {
    assert.deepEqual(serializeTopicPreviewModels([{ ID: 1, modelName: 'Model', lower: 25,
        calculationScores: [{ secret: 'not needed' }], members: [{ userID: '123' }], comparisonIdentity: '[]' }]),
    [{ ID: 1, modelName: 'Model', lower: 25, comparisonIdentity: '[]' }]);
});

test('grouped home previews supply the catalogue name, not a key=value presentation label', () => {
    const [model] = serializeTopicPreviewModels([{ ID: 1, modelID: 339,
        name: 'Harness=Not recorded / Effort=max / Acme (a=b) / v2', lower: 42, upper: 42,
        comparisonIdentity: JSON.stringify([['field:1', false, null], ['field:20', true, 5], ['model', true, 339]]) }],
    [{ ID: 339, name: 'Acme (a=b) / v2' }]);
    assert.equal(model.modelName, 'Acme (a=b) / v2', 'legitimate punctuation must not be parsed or stripped');
    assert.equal(model.lower, 42);
    const parts = comparisonDisplayParts(model, { keys: ['field:1', 'field:20', 'model'], models: [], fields: [
        { ID: 1, name: 'Harness', type: 'text' }, { ID: 20, name: 'Effort', type: 'enum', options: [{ ID: 5, label: 'max' }] }
    ] });
    assert.equal(parts[0].text, model.modelName);
    assert.deepEqual(parts.slice(1).map(part => [part.icon, part.text]), [['fa-puzzle-piece', 'Not recorded'], ['fa-brain', 'max']]);
});

test('preview and subsequent pages retain canonical names without exposing the full catalogue', async () => {
    const models = Array.from({ length: 30 }, (_, index) => ({ ID: index + 1, modelID: 339,
        name: 'Harness=Not recorded / Effort=max / Acme (a=b) / v2', lower: 42, upper: 42 }));
    const service = createTopicHomeService({ db: {}, authorizeTopics: async () => {}, loadTopic: async () => ({ ID: 54, isPrivate: false }),
        loadFields: async () => [], loadWorkspace: async () => ({
            context: { contextValues: {} }, comparison: { keys: ['model'], fields: [], availableKeys: ['model'],
                models: [{ ID: 339, name: 'Acme (a=b) / v2' }] },
            publicPie: { entries: [] }, modelLeaderboards: { public: models }
        }) });
    const first = await service.preview(null, { categoryID: 54 });
    assert.deepEqual(first.comparison.models, []);
    assert.equal(first.models.length, 25);
    assert.ok(first.models.every(model => model.modelName === 'Acme (a=b) / v2'));
    const next = await service.preview(null, { categoryID: 54, snapshotID: first.pagination.snapshotID, offset: 25 });
    assert.equal(next.models.length, 5);
    assert.ok(next.models.every(model => model.modelName === 'Acme (a=b) / v2'));
});

function fixture(isPrivate = false) {
    let builds = 0;
    const owners = [];
    const workspace = { context: { contextValues: {} }, comparison: { keys: ['model'], fields: [], availableKeys: ['model'] },
        publicPie: { entries: [{ conditionID: 1, name: 'Benchmark', weightBasisPoints: 10000 }] },
        personalPie: { entries: [] },
        modelLeaderboards: { public: Array.from({ length: 30 }, (_, index) => ({ ID: index + 1, name: `Model ${index + 1}`,
            lower: 30 - index, upper: 30 - index, coverage: 100 })), personal: [] } };
    const service = createTopicHomeService({
        db: {}, authorizeTopics: async () => {}, loadTopic: async (_db, userID) => {
            if (isPrivate && userID !== '42') throw { status: 404 };
            return { ID: 54, isPrivate };
        }, loadFields: async () => [],
        loadWorkspace: async (_db, options) => { builds++; owners.push(options.userID); return workspace; }
    });
    return { service, owners, builds: () => builds };
}

test('public previews coalesce loads, never resolve the viewer personal pie, and bind pages to their topic', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.service.preview('42', { categoryID: 54 }), f.service.preview('99', { categoryID: 54 })]);
    assert.equal(f.builds(), 1);
    assert.deepEqual(f.owners, [null]);
    assert.equal(a, b);
    const snapshotID = a.pagination.snapshotID;
    const page = await f.service.preview('99', { categoryID: 54, snapshotID, offset: 25 });
    assert.equal(page.models[0].ID, 26);
    assert.equal(f.owners.at(-1), null);
    await assert.rejects(f.service.preview('99', { categoryID: 55, snapshotID, offset: 25 }), error => error.status === 410);
    await assert.rejects(f.service.preview('99', { categoryID: 54, scoreMode: 'range', snapshotID, offset: 25 }), error => error.status === 410);
    f.service.invalidate(54);
    await f.service.preview(null, { categoryID: 54 });
    assert.equal(f.builds(), 2);
});

test('private previews use only their owner and never become public cached results', async () => {
    const f = fixture(true);
    await f.service.preview('42', { categoryID: 54 });
    assert.deepEqual(f.owners, ['42']);
    await assert.rejects(f.service.preview(null, { categoryID: 54 }), error => error.status === 404);
    await assert.rejects(f.service.preview('99', { categoryID: 54 }), error => error.status === 404);
});

test('a directory with more than twelve topics does not evict configuration snapshots or its first preview', async () => {
    const f = fixture();
    const first = await f.service.preview(null, { categoryID: 54 });
    for (let ID = 100; ID < 130; ID++) await f.service.preview(null, { categoryID: ID });
    const page = await f.service.preview(null, { categoryID: 54, snapshotID: first.pagination.snapshotID, offset: 25 });
    assert.equal(page.models.length, 5);
    assert.equal(page.pagination.hasMore, false);
    assert.equal(f.builds(), 31);
});

test('home model search uses all recorded models and only currently enabled parameter keys', async () => {
    const fields = [{ ID: 3, name: 'Effort', type: 'text' }];
    const runs = ['low', 'high'].map((value, index) => ({ ID: index + 1, modelID: 77, modelName: 'Example',
        name: 'Example', vendor: 'Acme', condition: { parameters: { 'field:3': value } }, results: new Map() }));
    let loads = 0;
    const service = createTopicHomeService({ db: {}, authorizeTopics: async () => {}, loadFields: async () => fields,
        loadRuns: async () => { loads++; return runs; } });
    const result = await service.searchModels({ query: 'example high', reasoning: true, harness: false });
    assert.equal(result.items.length, 1);
    assert.ok(result.items[0].parts.some(part => part.text === 'high'));
    assert.equal((await service.searchModels({ query: 'high', reasoning: false })).items.length, 0);
    assert.equal(loads, 1);
    await assert.rejects(service.searchModels({ query: 'x', reasoning: 'true' }), error => error.status === 400);
});

test('home locating returns a centered window and validates topic snapshot access', async () => {
    const f = fixture();
    const first = await f.service.preview(null, { categoryID: 54 });
    const result = await f.service.locate(null, { categoryID: 54, snapshotID: first.pagination.snapshotID, targetModel: '26' });
    assert.equal(result.found, true);
    assert.equal(result.targetOffset, 25);
    assert.equal(result.pagination.offset, 0);
    assert.equal(result.models[25].ID, 26);
    assert.equal((await f.service.locate(null, { categoryID: 54, snapshotID: first.pagination.snapshotID, targetModel: '100' })).found, false);
    await assert.rejects(f.service.locate(null, { categoryID: 55, snapshotID: first.pagination.snapshotID, targetModel: '26' }), error => error.status === 410);
});


test('cached preview, page and locate reauthorize referenced topics after publication changes', async () => {
    let readable = true;
    const service = createTopicHomeService({ db: {}, loadTopic: async () => ({ ID: 1, isPrivate: false }),
        authorizeTopics: async (_db, _userID, IDs) => {
            assert.deepEqual(IDs, [1, 2]);
            if (!readable) throw { status: 410, body: { error: 'ranking_snapshot_expired' } };
        }, loadFields: async () => [], loadWorkspace: async () => ({ context: { contextValues: {} },
            comparison: { keys: ['model'], fields: [], availableKeys: ['model'], models: [] },
            benchmarks: [{ type: 'topic', categoryID: 2 }], publicPie: { entries: [] }, modelLeaderboards: { public: [] } }) });
    const first = await service.preview(null, { categoryID: 1 });
    readable = false;
    for (const body of [{ categoryID: 1 }, { categoryID: 1, snapshotID: first.pagination.snapshotID, offset: 0 }]) {
        await assert.rejects(service.preview(null, body), error => error.status === 410);
    }
    await assert.rejects(service.locate(null, { categoryID: 1, snapshotID: first.pagination.snapshotID, targetModel: '1' }), error => error.status === 410);
});


test('personal reference previews use viewer weights and isolate each account cache', async () => {
    const f = fixture();
    const personal = await f.service.preview('42', { categoryID: 54, mode: 'personal' });
    assert.deepEqual(f.owners, ['42']);
    assert.equal(personal.models.length, 0);
    await f.service.preview('43', { categoryID: 54, mode: 'personal' });
    await f.service.preview('42', { categoryID: 54, mode: 'public' });
    assert.deepEqual(f.owners, ['42', '43', null]);
    await assert.rejects(f.service.preview(null, { categoryID: 54, mode: 'personal' }), error => error.status === 401);
    await assert.rejects(f.service.preview('43', { categoryID: 54, mode: 'personal', snapshotID: personal.pagination.snapshotID }), error => error.status === 410);
    const privateFixture = fixture(true);
    await assert.rejects(privateFixture.service.preview('42', { categoryID: 54, mode: 'public' }), error => error.status === 400);
});

test('preview coverage index uses the complete precise aggregate rather than rounded page rows', async () => {
    const service = createTopicHomeService({ db: {}, authorizeTopics: async () => {},
        loadTopic: async () => ({ ID: 1, isPrivate: false }), loadFields: async () => [],
        loadWorkspace: async () => ({ context: { contextValues: {} },
            comparison: { keys: ['model'], fields: [], availableKeys: ['model'], models: [] },
            publicPie: { entries: [], coverageIndex: 29.999999999999 },
            modelLeaderboards: { public: Array.from({ length: 30 }, (_, index) => ({ ID: index + 1, name: `Model ${index + 1}`, lower: 30 - index, upper: 30 - index, coverage: 100 })) } }) });
    const result = await service.preview(null, { categoryID: 1 });
    assert.equal(result.models.length, 25);
    assert.equal(result.coverageIndex, 29.999999999999);
    assert.equal(result.totalCoverageIndex, 29.999999999999);
});
