import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { conditionImpact } from '../condition-impact.js';
import { getRankingWorkspace, loadPersonalPie, savePersonalPie } from '../ranking-service.js';
import { createRankingReadCache } from '../ranking-read-cache.js';
import { createRankingPager } from '../ranking-pagination.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { createSearchPresentation } from '../search-presentation.js';
import { createTopicHomeService, normalizeHomeComparison, topicPreviewComparison } from '../topic-home-service.js';
import { insertTopicScene } from '../topic-scenes-service.js';
import { assertTopicAccess, createTopic, listTopics } from '../topic-service.js';
import { readWriteIdentity } from '../write-idempotency.js';
import { requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { normalizeRankingResume } from '../public/js/shared/ranking-resume.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const target = 1;
const independent = 2;
const unresolved = 3;
const preciseSource = 4;
const alternateSource = 5;
const excludedSource = 6;
const support = conditionID => ({ conditionID, vote: 'support' });
const oppose = conditionID => ({ conditionID, vote: 'oppose' });
const entry = (conditionID, weightBasisPoints = 10000) => ({ conditionID, weightBasisPoints });
const comparison = { mode: 'best', keys: ['model'] };
const sceneValues = ID => ({ scene: String(ID) });

async function createFixture(t) {
    const database = await createLifecycleDatabase();
    t.after(() => database.close());
    const db = database.pool;
    await seedLifecycleEvidence(db);
    await db.execute(`INSERT INTO benchmark_conditions
        (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, score_source)
        VALUES (4, 1, 'precise', 'Precise', 'higher', 1, NULL),
               (5, 1, 'alternate', 'Alternate', 'higher', 1, NULL),
               (6, 1, 'excluded', 'Excluded', 'higher', 1, 'aa')`);
    for (let ID = 4; ID <= 7; ID++) {
        await db.execute('INSERT INTO models (ID, vendor_ID, slug, name) VALUES (?, 1, ?, ?)', [ID, 'model-' + ID, 'Model ' + ID]);
    }
    await db.execute('DELETE FROM benchmark_results');
    const score = (modelID, conditionID, value) => db.execute(`INSERT INTO benchmark_results
        (model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, benchmark_condition_snapshot, score_fields)
        VALUES (?, ?, ?, ?, ?, 'vendor_official', '{}', '[]')`,
    [modelID, conditionID <= 3 ? conditionID : 1, conditionID, value, `https://example.test/record/${modelID}/${conditionID}`]);
    await score(1, independent, 55);
    await score(1, preciseSource, 58);
    await score(1, alternateSource, 42);
    await score(1, excludedSource, 60);
    for (let modelID = 2; modelID <= 7; modelID++) {
        const targetScore = 45 + modelID;
        await score(modelID, target, targetScore);
        await score(modelID, independent, targetScore + 4);
        await score(modelID, unresolved, 20 + modelID);
        await score(modelID, preciseSource, targetScore + 10);
        await score(modelID, alternateSource, targetScore - 10 + (modelID % 2 ? -1 : 1));
        await score(modelID, excludedSource, targetScore + 8);
    }
    return db;
}

function publicTopic(db, name) {
    return createTopic(db, '42', { name, description: 'An independent scoring sample.', isPrivate: false });
}

async function addScenes(db, categoryID) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const general = await insertTopicScene(connection, categoryID, { name: 'General', isDefault: true });
        const specialized = await insertTopicScene(connection, categoryID, { name: 'Specialized' }, { position: 20 });
        await connection.commit();
        return [general, specialized];
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally { connection.release(); }
}

function save(db, scope, userID, entries, estimationVotes = [], expectedRevision = 0) {
    return savePersonalPie(db, { ...scope, userID, writeIdentity: randomUUID(), expectedRevision, entries, estimationVotes });
}

function modelOne(rows) {
    const row = rows.find(model => model.modelID === 1);
    assert.ok(row, 'fixture model is present');
    return row;
}

function near(actual, expected) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10, `Expected ${expected}, received ${actual}`);
}

function checkEstimate(row, source, sourceScore, prediction, originalWeight) {
    assert.equal(row.inferredScores.length, 1);
    const [estimate] = row.inferredScores;
    assert.deepEqual([estimate.conditionID, estimate.sourceConditionID, estimate.referenceCount, estimate.selection],
        [target, source, 6, 'automatic']);
    near(estimate.originalWeight, originalWeight * 100);
    near(estimate.sourceScore, sourceScore);
    near(estimate.normalizedScore, prediction);
    near(estimate.contribution, prediction * originalWeight);
    if (source === preciseSource) near(estimate.validationError, 0);
    else assert.ok(estimate.validationError > 0 && estimate.validationError <= 5);
}

test('SQL workspaces keep source ballots separate from scoring versions, scenes, and guest previews', { timeout: 60000 }, async t => {
    const db = await createFixture(t);
    const topic = await publicTopic(db, 'Scene ballots');
    const [general, specialized] = await addScenes(db, topic.ID);
    const scope = { categoryID: topic.ID, contextValues: sceneValues(general) };
    const specializedScope = { categoryID: topic.ID, contextValues: sceneValues(specialized) };
    const entries = [entry(target, 6000), entry(independent, 2000), entry(unresolved, 2000)];
    const followerEntries = [{ ...entries[0], followCommunityVersion: true }, ...entries.slice(1)];
    await save(db, scope, '42', followerEntries, [support(preciseSource)]);
    for (const userID of ['43', '1001']) await save(db, scope, userID, entries, [oppose(preciseSource)]);
    for (const userID of ['1002', '1003']) await save(db, scope, userID, entries, [support(preciseSource)]);
    await db.execute(`UPDATE personal_pies SET updated_at = NOW() - INTERVAL 15 DAY WHERE user_ID = 1002 AND context_ID = ?`, [general]);
    await db.execute('UPDATE users SET banned_at = NOW() WHERE ID = 1003');
    await save(db, specializedScope, '42', [entry(target)], [support(preciseSource)]);
    await save(db, specializedScope, '43', [entry(target)], [oppose(preciseSource)]);
    const preciseUsage = await conditionImpact(db, 'benchmark', 1, preciseSource);
    assert.deepEqual(preciseUsage, { resultCount: 7, pieCount: 7 });

    const rankingCache = createRankingReadCache();
    const read = options => getRankingWorkspace(db, { ...scope, comparison, rankingCache, jsonMemberMetadata: true, ...options });
    const sparse = await read();
    assert.equal(sparse.publicPie.participantCount, 4);
    assert.deepEqual(sparse.communityEstimationVotes, [{ conditionID: preciseSource, supportCount: 2, opposeCount: 2 }]);
    assert.equal(sparse.versionComposition.find(group => group.benchmarkID === 1).configuredPieCount, 3);
    checkEstimate(modelOne(sparse.modelLeaderboards.public), preciseSource, 58, 48, .6);

    for (let userID = 1004; userID <= 1010; userID++) await save(db, scope, String(userID), followerEntries);
    const initial = await read({ userID: '42' });
    assert.equal(initial.scoreMode, 'available');
    assert.equal(initial.publicPie.participantCount, 10);
    const initialVotes = [{ conditionID: preciseSource, supportCount: 1, opposeCount: 2 }];
    assert.deepEqual(initial.communityEstimationVotes, initialVotes);
    assert.deepEqual(initial.personalPie.estimationVotes, [support(preciseSource)]);
    assert.equal(initial.personalPie.entries.find(row => row.conditionID === target).followCommunityVersion, true);
    assert.equal(initial.versionComposition.find(group => group.benchmarkID === 1).configuredPieCount, 2);

    const personal = modelOne(initial.modelLeaderboards.personal);
    const publicRow = modelOne(initial.modelLeaderboards.public);
    checkEstimate(personal, preciseSource, 58, 48, .6);
    checkEstimate(publicRow, alternateSource, 42, 52, .6);
    const olderOwner = await read({ userID: '1002' });
    checkEstimate(modelOne(olderOwner.modelLeaderboards.personal), preciseSource, 58, 48, .6);
    assert.deepEqual([personal.lower, personal.upper, personal.coverage], [39.8, 39.8, 20]);
    assert.deepEqual([publicRow.lower, publicRow.upper, publicRow.coverage], [42.2, 42.2, 20]);
    near(personal.availableInference.observedContribution, 11);
    near(personal.availableInference.unresolvedFraction, .2);
    assert.equal(personal.availableInference.unresolvedContribution, 0);
    assert.deepEqual(personal.calculationScores.map(score => score.conditionID), [independent]);
    const missingCoverage = personal.coverageEntries.find(item => item.conditionID === target);
    assert.deepEqual([missingCoverage.coveredWeightBasisPoints, missingCoverage.normalizedScore], [0, null]);

    for (const options of [{ rankingCache: null }, { comparison: { ...comparison, mode: 'matched' } }]) {
        const result = await read({ userID: '42', ...options });
        checkEstimate(modelOne(result.modelLeaderboards.personal), preciseSource, 58, 48, .6);
        checkEstimate(modelOne(result.modelLeaderboards.public), alternateSource, 42, 52, .6);
    }

    const secondary = await read(specializedScope);
    assert.deepEqual(secondary.communityEstimationVotes, [{ conditionID: preciseSource, supportCount: 1, opposeCount: 1 }]);
    checkEstimate(modelOne(secondary.modelLeaderboards.public), preciseSource, 58, 48, 1);
    const range = modelOne((await read({ userID: '42', scoreMode: 'range' })).modelLeaderboards.personal);
    assert.deepEqual([range.lower, range.upper, range.coverage, range.inferredScores], [11, 91, 20, []]);

    const guest = await read({ previewPersonalPie: { entries, estimationVotes: [support(preciseSource)] } });
    checkEstimate(modelOne(guest.modelLeaderboards.personal), preciseSource, 58, 48, .6);
    checkEstimate(modelOne(guest.modelLeaderboards.public), alternateSource, 42, 52, .6);
    assert.deepEqual((await read()).personalPie.estimationVotes, []);
    assert.deepEqual((await read()).communityEstimationVotes, initialVotes);

    const unavailableVote = failure => failure.status === 400 && failure.body?.error === 'estimation_vote_condition_unavailable';
    for (const conditionID of [independent, excludedSource]) {
        const badPreview = { entries: [entry(target)], estimationVotes: [support(conditionID)] };
        await assert.rejects(read({ previewPersonalPie: badPreview }), unavailableVote);
        await assert.rejects(save(db, scope, '42', badPreview.entries, badPreview.estimationVotes, 1), unavailableVote);
    }
    const noSources = await read({ previewPersonalPie: {
        entries: [entry(target)], estimationVotes: [oppose(preciseSource), oppose(alternateSource)]
    } });
    const unranked = modelOne(noSources.modelLeaderboards.personal);
    assert.deepEqual([unranked.lower, unranked.coverage, unranked.inferredScores], [null, 0, []]);

    const alternateEntries = [entry(alternateSource, 6000), ...entries.slice(1)];
    for (const userID of ['43', '1001']) await save(db, scope, userID, alternateEntries, [oppose(preciseSource)], 1);
    const changedCommunity = await read({ userID: '42' });
    assert.deepEqual(changedCommunity.communityEstimationVotes, initialVotes);
    assert.equal(changedCommunity.personalPie.revision, 1);
    assert.ok(changedCommunity.personalPie.effectiveEntries.some(item => item.conditionID === alternateSource));
    assert.deepEqual([modelOne(changedCommunity.modelLeaderboards.personal).lower,
        modelOne(changedCommunity.modelLeaderboards.personal).inferredScores], [36.2, []]);

    const explicitEntries = [entry(preciseSource, 6000), ...entries.slice(1)];
    const receipt = await savePersonalPie(db, { ...scope, userID: '42', writeIdentity: randomUUID(), expectedRevision: 1,
        entries: explicitEntries });
    assert.deepEqual(receipt.personalPie.estimationVotes, [support(preciseSource)]);
    const persisted = await loadPersonalPie(db, general, '42');
    assert.ok(persisted.entries.some(item => item.conditionID === preciseSource && !item.followCommunityVersion));
    assert.deepEqual(persisted.estimationVotes, [support(preciseSource)]);
    assert.deepEqual(await conditionImpact(db, 'benchmark', 1, preciseSource), preciseUsage);
    assert.deepEqual(await conditionImpact(db, 'benchmark', 1, alternateSource), { resultCount: 7, pieCount: 2 });
    assert.equal(modelOne((await read({ userID: '42' })).modelLeaderboards.personal).lower, 45.8);
    assert.ok(rankingCache.stats.entries > 0);
});

async function openFixtureAPI(t, db, rankingCache) {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userID: req.get('Fixture-User') ?? null }; next(); });
    const fixtureSession = req => req.session.userID;
    const topicHome = createTopicHomeService({ db, rankingCache });
    const searchPresentation = createSearchPresentation({ origin: 'https://example.test',
        loadTopics: () => listTopics(db, null), loadPreview: body => topicHome.preview(null, body) });
    const bindings = {
        API: app, AbortController, activeSessionUserID: fixtureSession, assertTopicAccess, db,
        getRankingWorkspace, loadScoreFieldCatalog, normalizeHomeComparison, normalizeRankingResume,
        rankingCache, rankingPager: createRankingPager(), readWriteIdentity, requireAccountWriteOwner, savePersonalPie,
        requireAuthForAPI(req, res, next) { if (fixtureSession(req) === null) return res.sendStatus(401); next(); },
        requireCurrentTermsForAPI(_req, _res, next) { next(); },
        topicHome, topicPreviewComparison, searchPresentation
    };
    for (const endpoint of ['get_topic_preview', 'get_weighted_workspace', 'save_personal_pie']) {
        const start = source.indexOf(`API.post('/${endpoint}',`);
        assert.ok(start >= 0, endpoint);
        runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), bindings);
    }
    app.use((error, _req, res, _next) => res.status(error.status ?? 500).json(error.body ?? { error: error.message }));
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    t.after(() => new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())));
    async function post(endpoint, request, { userID, status = 200 } = {}) {
        const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
        if (userID) headers['Fixture-User'] = userID;
        const response = await fetch(`http://127.0.0.1:${listener.address().port}/${endpoint}`, {
            method: 'POST', headers, body: JSON.stringify(request)
        });
        const payload = await response.json();
        assert.equal(response.status, status, JSON.stringify(payload));
        return payload;
    }
    return { post, searchPresentation };
}

test('HTTP workspace and homepage preserve local sources in cyclic references and refresh after a vote-only save', { timeout: 60000 }, async t => {
    const db = await createFixture(t);
    const root = await publicTopic(db, 'Root with two paths');
    const branchA = await publicTopic(db, 'Precise branch');
    const branchB = await publicTopic(db, 'Alternate branch');
    const scope = category => ({ categoryID: category.ID, contextValues: {} });
    const rankingCache = createRankingReadCache();
    const contextID = async category => (await getRankingWorkspace(db, { ...scope(category), comparison, rankingCache })).context.ID;
    const contextA = await contextID(branchA), contextB = await contextID(branchB);
    const rootEntries = [entry(-contextA, 5000), entry(-contextB, 5000)];
    const branchAEntries = [entry(target, 5000), entry(-contextB, 5000)];
    const branchBEntries = [entry(target, 5000), entry(-contextA, 5000)];
    await save(db, scope(branchA), '42', [entry(target)], [oppose(alternateSource)]);
    await save(db, scope(branchB), '42', branchBEntries, [oppose(preciseSource)]);
    await save(db, scope(branchA), '42', branchAEntries, [oppose(alternateSource)], 1);
    await save(db, scope(root), '42', rootEntries);

    const { post, searchPresentation } = await openFixtureAPI(t, db, rankingCache);
    const request = { ...scope(root), comparison, scoreMode: 'available' };
    const initial = await post('get_weighted_workspace', request);
    validateWorkspacePayload(initial);
    const publicRow = modelOne(initial.modelLeaderboards.public);
    assert.deepEqual([publicRow.lower, publicRow.upper, publicRow.coverage], [50, 50, 0]);
    const inferred = publicRow.inferredScores.slice().sort((a, b) => a.sourceConditionID - b.sourceConditionID);
    assert.deepEqual(inferred.map(item => [item.conditionID, item.sourceConditionID, item.originalWeight]),
        [[target, preciseSource, 50], [target, alternateSource, 50]]);
    near(inferred[0].normalizedScore, 48);
    near(inferred[1].normalizedScore, 52);
    const personal = await post('get_weighted_workspace', { ...request, initialMode: 'personal' }, { userID: '42' });
    assert.equal(modelOne(personal.modelLeaderboards.personal).lower, 50);

    const preview = await post('get_weighted_workspace', { ...request, ...scope(branchA), initialMode: 'personal',
        previewPersonalPie: { entries: branchAEntries, estimationVotes: [oppose(preciseSource), support(alternateSource)] } });
    assert.equal(modelOne(preview.modelLeaderboards.personal).lower, 52);
    checkEstimate(modelOne(preview.modelLeaderboards.personal), alternateSource, 42, 52, 1);

    const homeRequest = { categoryID: root.ID };
    const homeBefore = await post('get_topic_preview', homeRequest);
    assert.equal(modelOne(homeBefore.models).lower, 50);
    assert.equal((await post('get_topic_preview', homeRequest)).pagination.snapshotID, homeBefore.pagination.snapshotID);
    const crawlerPreview = async () => {
        const topic = (await searchPresentation.topics()).find(item => item.ID === root.ID);
        return searchPresentation.snapshot(topic, null);
    };
    assert.equal(modelOne((await crawlerPreview()).models).lower, 50);

    const receipt = await post('save_personal_pie', { ...scope(branchA), expectedRevision: 2,
        expectedUserID: '42', entries: branchAEntries, estimationVotes: [oppose(preciseSource)] }, { userID: '42' });
    assert.deepEqual(receipt.personalPie.estimationVotes, [oppose(preciseSource)]);
    assert.equal(receipt.personalPie.revision, 3);

    const fresh = await post('get_weighted_workspace', request);
    const freshRow = modelOne(fresh.modelLeaderboards.public);
    assert.equal(freshRow.lower, 52);
    checkEstimate(freshRow, alternateSource, 42, 52, 1);
    const homeAfter = await post('get_topic_preview', homeRequest);
    assert.equal(modelOne(homeAfter.models).lower, 52);
    assert.notEqual(homeAfter.pagination.snapshotID, homeBefore.pagination.snapshotID);
    await post('get_topic_preview', { ...homeRequest, snapshotID: homeBefore.pagination.snapshotID }, { status: 410 });
    assert.equal(modelOne((await crawlerPreview()).models).lower, 52);
});
