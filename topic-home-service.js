import { getTopic, topicID } from './topic-service.js';
import { getRankingWorkspace, loadModels } from './ranking-service.js';
import { loadScoreFieldCatalog } from './score-field-service.js';
import { fieldKey } from './public/js/shared/score-fields.js';
import { runFieldKind } from './public/js/shared/score-field-presets.js';
import { normalizeAvailableInferenceVersion } from './public/js/shared/available-score.js';
import { randomUUID } from 'node:crypto';
import { rankModels, searchRankedModels } from './ranking-pagination.js';
import { RANKING_PAGE_SIZE } from './public/js/shared/ranking-resume.js';
import { comparisonOptions, groupComparisonModels } from './model-comparison.js';
import { normalizeModelFocusTarget, findModelFocusIndex } from './public/js/workspace/model-focus-target.js';

const fail = (status, error) => { throw { status, body: { error } }; };
const publicModelKeys = ['ID', 'modelID', 'modelName', 'name', 'vendor', 'vendorName', 'vendorSlug', 'logoKey',
    'vendorColor', 'rank', 'lower', 'upper', 'coverage', 'comparable', 'comparisonIdentity'];

export function normalizeHomeComparison(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['reasoning', 'harness'].includes(key))
        || Object.values(value).some(flag => typeof flag !== 'boolean')) fail(400, 'invalid_topic_comparison');
    return { reasoning: value.reasoning === true, harness: value.harness === true };
}

export function normalizeTopicPreview(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['categoryID', 'sceneID', 'scoreMode', 'reasoning', 'harness', 'availableInferenceVersion', 'snapshotID', 'offset'].includes(key))) {
        fail(400, 'invalid_topic_preview');
    }
    const categoryID = topicID(body.categoryID);
    const sceneID = body.sceneID == null ? null : topicID(body.sceneID);
    const scoreMode = body.scoreMode ?? 'available';
    if (!['available', 'range'].includes(scoreMode)) fail(400, 'invalid_score_mode');
    let availableInferenceVersion;
    try { availableInferenceVersion = normalizeAvailableInferenceVersion(body.availableInferenceVersion); }
    catch { fail(400, 'invalid_available_inference_version'); }
    for (const key of ['reasoning', 'harness']) {
        if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_topic_comparison');
    }
    const offset = body.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail(400, 'invalid_topic_offset');
    if (body.snapshotID !== undefined && (typeof body.snapshotID !== 'string'
        || !/^[0-9a-f-]{36}$/.test(body.snapshotID))) fail(400, 'invalid_ranking_snapshot');
    if (offset > 0 && !body.snapshotID) fail(400, 'ranking_snapshot_required');
    return { categoryID, sceneID, scoreMode, availableInferenceVersion, reasoning: body.reasoning === true, harness: body.harness === true,
        snapshotID: body.snapshotID, offset };
}

export function topicPreviewComparison(fields, options) {
    const select = kind => fields.filter(field => runFieldKind(field) === kind)
        .sort((a, b) => a.ID - b.ID)[0];
    return { mode: 'best', filters: [], keys: ['model',
        ...(options.reasoning && select('effort') ? [fieldKey(select('effort').ID)] : []),
        ...(options.harness && select('harness') ? [fieldKey(select('harness').ID)] : [])] };
}

export function serializeTopicPreviewModels(models, catalogue = []) {
    const names = new Map(catalogue.map(model => [model.ID, model.name]));
    return models.map(model => {
        const row = Object.fromEntries(publicModelKeys.filter(key => Object.hasOwn(model, key)).map(key => [key, model[key]]));
        // Ranked group names contain assignments; the public catalogue retains the original name.
        const name = names.get(model.modelID);
        if (typeof name === 'string' && name) row.modelName = name;
        return row;
    });
}

export function createTopicHomeService({ db, rankingCache, now = () => Date.now(),
    loadTopic = getTopic, loadFields = loadScoreFieldCatalog, loadWorkspace = getRankingWorkspace, loadRuns = loadModels } = {}) {
    const previews = new Map(), scopes = new Map();
    let modelCatalog = null;
    const prune = () => {
        for (const [key, value] of previews) if (value.expiresAt <= now()) previews.delete(key);
        for (const [key, value] of scopes) if (value.expiresAt <= now()) scopes.delete(key);
        while (previews.size > 128) previews.delete(previews.keys().next().value);
        let rows = [...scopes.values()].reduce((sum, scope) => sum + scope.models.length, 0);
        while (scopes.size > 128 || rows > 100000) {
            const key = scopes.keys().next().value;
            rows -= scopes.get(key).models.length; scopes.delete(key);
        }
    };
    const modelPage = (scope, offset, size = RANKING_PAGE_SIZE.public) => {
        const models = scope.models.slice(offset, offset + size);
        return { topicID: scope.categoryID, models, pagination: { snapshotID: scope.snapshotID, offset,
            nextOffset: offset + models.length, hasMore: offset + models.length < scope.models.length,
            total: scope.models.length } };
    };
    async function preview(userID, body) {
        const options = normalizeTopicPreview(body);
        const topic = await loadTopic(db, userID, options.categoryID);
        const owner = topic.isPrivate ? userID : null;
        const mode = topic.isPrivate ? 'personal' : 'public';
        if (options.sceneID !== null && !(topic.scenes ?? []).some(scene => scene.ID === options.sceneID)) fail(404, 'topic_scene_not_found');
        const signature = JSON.stringify([options.categoryID, options.sceneID, owner, options.scoreMode, options.reasoning, options.harness, options.availableInferenceVersion]);
        prune();
        if (options.snapshotID) {
            const scope = scopes.get(options.snapshotID);
            if (!scope || scope.signature !== signature) fail(410, 'ranking_snapshot_expired');
            scopes.delete(options.snapshotID); scopes.set(options.snapshotID, scope);
            scope.expiresAt = now() + 900000;
            return modelPage(scope, options.offset);
        }
        const cached = previews.get(signature);
        if (cached) {
            const result = await cached.value;
            if (scopes.has(result.pagination.snapshotID)) return result;
            if (previews.get(signature) === cached) previews.delete(signature);
        }
        const entry = { categoryID: options.categoryID, expiresAt: now() + 60000, value: null };
        entry.value = (async () => {
            const fields = await loadFields(db);
            const comparison = topicPreviewComparison(fields, options);
            const workspace = await loadWorkspace(db, { categoryID: options.categoryID,
                contextValues: options.sceneID === null ? {} : { scene: String(options.sceneID) },
                scoreMode: options.scoreMode, comparison, userID: owner, rankingCache,
                availableInferenceVersion: options.availableInferenceVersion, jsonMemberMetadata: true });
            const models = serializeTopicPreviewModels(rankModels(workspace.modelLeaderboards[mode]), workspace.comparison.models);
            const scope = { categoryID: options.categoryID, signature, models, snapshotID: randomUUID(), expiresAt: now() + 900000 };
            scopes.set(scope.snapshotID, scope);
            prune();
            const endpoints = models.filter(model => model.comparable !== false).flatMap(model => [model.lower, model.upper]);
            const scoreScale = endpoints.reduce((scale, value) => ({ min: Math.min(scale.min, value), max: Math.max(scale.max, value) }),
                { min: 0, max: 100 });
            const weights = mode === 'public' ? workspace.publicPie.entries : workspace.personalPie.entries;
            return { ...modelPage(scope, 0), contextValues: workspace.context.contextValues,
                comparison: { mode: 'best', keys: workspace.comparison.keys, fields: workspace.comparison.fields,
                    availableKeys: workspace.comparison.availableKeys, models: [] },
                referenceIssues: workspace[mode === 'public' ? 'publicPie' : 'personalPie'].referenceIssues ?? [],
                weights: weights.map(weight => ({ conditionID: weight.conditionID, name: weight.name,
                    type: weight.type, referenceContextID: weight.referenceContextID, url: weight.url,
                    topicName: weight.topicName, sceneName: weight.sceneName,
                    benchmarkID: weight.benchmarkID, conditionName: weight.conditionName,
                    weightBasisPoints: weight.weightBasisPoints })),
                totalCoverageIndex: models.reduce((sum, model) => sum + (Number.isFinite(model.coverage) ? model.coverage / 100 : 0), 0),
                scoreScale };
        })().then(value => {
            entry.expiresAt = now() + 60000;
            return value;
        }).catch(error => {
            if (previews.get(signature) === entry) previews.delete(signature);
            throw error;
        });
        previews.set(signature, entry);
        return entry.value;
    }
    async function searchModels(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(key => !['query', 'reasoning', 'harness'].includes(key))
            || typeof body.query !== 'string' || body.query.length > 120) fail(400, 'invalid_model_search');
        const options = normalizeHomeComparison({ reasoning: body.reasoning ?? false, harness: body.harness ?? false });
        if (!body.query.trim()) return { items: [] };
        if (!modelCatalog || modelCatalog.expiresAt <= now()) {
            const entry = { expiresAt: now() + 30000, promise: null };
            entry.promise = (async () => {
                const fields = await loadFields(db);
                const models = await loadRuns(db, fields, { conditionIDs: [] });
                return { fields, models };
            })().catch(error => { if (modelCatalog === entry) modelCatalog = null; throw error; });
            modelCatalog = entry;
        }
        const { fields, models } = await modelCatalog.promise;
        const comparison = comparisonOptions(models, topicPreviewComparison(fields, options), fields);
        const groups = groupComparisonModels(models, comparison, []);
        return { items: searchRankedModels(groups, comparison, body.query) };
    }
    async function locate(userID, body) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'targetModel')) fail(400, 'invalid_ranking_target');
        const { targetModel: rawTarget, ...previewRequest } = body;
        let targetModel;
        try { targetModel = normalizeModelFocusTarget(rawTarget); }
        catch { fail(400, 'invalid_ranking_target'); }
        if (!previewRequest.snapshotID) fail(400, 'ranking_snapshot_required');
        await preview(userID, { ...previewRequest, offset: 0 });
        const scope = scopes.get(previewRequest.snapshotID);
        if (!scope) fail(410, 'ranking_snapshot_expired');
        const targetOffset = findModelFocusIndex(scope.models, targetModel);
        if (targetOffset < 0) return { topicID: scope.categoryID, snapshotID: scope.snapshotID, targetModel, found: false };
        const size = RANKING_PAGE_SIZE.public * 3;
        const offset = Math.max(0, Math.min(targetOffset - Math.floor(size / 2), scope.models.length - size));
        return { ...modelPage(scope, offset, size), targetModel, targetOffset, found: true };
    }
    return { preview, searchModels, locate,
        invalidate() {
            modelCatalog = null;
            // A changed target can affect any transitive referencing topic.
            previews.clear();
            scopes.clear();
        } };
}
