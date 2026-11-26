import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { conditionImpact } from '../condition-impact.js';
import { saveEstimationVote } from '../estimation-ballots.js';
import { migrateEstimationVotes } from '../scripts/migrate-estimation-votes.mjs';
import { estimationPair } from '../public/js/shared/estimation-votes.js';
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
const secondTarget = 7;
const noisySource = 8;
const sparseSource = 9;
const support = (a, b) => ({ ...estimationPair(a, b), vote: 'support' });
const oppose = (a, b) => ({ ...estimationPair(a, b), vote: 'oppose' });
const tally = (a, b, supportCount, opposeCount) => ({ ...estimationPair(a, b), supportCount, opposeCount });
const entry = (conditionID, weightBasisPoints = 10000) => ({ conditionID, weightBasisPoints });
const comparison = { mode: 'best', keys: ['model'] };
const sceneValues = ID => ({ scene: String(ID) });

// Point predictions computed independently from these measured rows with the frozen NumPy model.
const sources = [
    { sourceConditionID: preciseSource, sourceScore: 58, referenceCount: 6 },
    { sourceConditionID: alternateSource, sourceScore: 42, referenceCount: 5 },
    { sourceConditionID: noisySource, sourceScore: 50, referenceCount: 6 },
    { sourceConditionID: sparseSource, sourceScore: 49, referenceCount: 4 }
];
const jointScore = 48.96316682871836;
const withoutPrecise = sources.slice(1);
const withoutPreciseScore = 49.90401823459692;
const secondTargetScore = jointScore + 3;

async function createFixture(t) {
    const database = await createLifecycleDatabase();
    t.after(() => database.close());
    const db = database.pool;
    await seedLifecycleEvidence(db);
    await db.execute(`INSERT INTO benchmark_conditions
        (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, score_source)
        VALUES (4, 1, 'precise', 'Precise', 'higher', 1, NULL),
               (5, 1, 'alternate', 'Alternate', 'higher', 1, NULL),
               (6, 1, 'excluded', 'Excluded', 'higher', 1, 'aa'),
               (7, 1, 'second-target', 'Second target', 'higher', 1, NULL),
               (8, 1, 'noisy', 'Noisy', 'higher', 1, NULL),
               (9, 1, 'sparse', 'Sparse', 'higher', 1, NULL)`);
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
    await score(1, noisySource, 50);
    await score(1, sparseSource, 49);
    const alternateOffsets = [13, 11, 10, 9, 7];
    for (let modelID = 2; modelID <= 7; modelID++) {
        const targetScore = 45 + modelID;
        await score(modelID, target, targetScore);
        await score(modelID, independent, targetScore + 4);
        await score(modelID, unresolved, 20 + modelID);
        await score(modelID, preciseSource, targetScore + 10);
        if (modelID <= 6) await score(modelID, alternateSource, targetScore - alternateOffsets[modelID - 2]);
        await score(modelID, excludedSource, targetScore + 8);
        await score(modelID, secondTarget, targetScore + 3);
        await score(modelID, noisySource, targetScore + (modelID % 2 ? 7 : -7));
        if (modelID <= 5) await score(modelID, sparseSource, targetScore + 1);
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

function save(db, scope, userID, entries, expectedRevision = 0) {
    return savePersonalPie(db, { ...scope, userID, writeIdentity: randomUUID(), expectedRevision, entries });
}

function vote(db, userID, ballot) {
    return saveEstimationVote(db, userID, randomUUID(), ballot);
}

function modelOne(rows) {
    const row = rows.find(model => model.modelID === 1);
    assert.ok(row, 'fixture model is present');
    return row;
}

function near(actual, expected) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-10, `Expected ${expected}, received ${actual}`);
}

function checkEstimate(row, conditionID, sources, prediction, originalWeight) {
    assert.equal(row.inferredScores.length, 1);
    checkInferenceLine(row.inferredScores[0], conditionID, sources, prediction, originalWeight);
}

function checkInferenceLine(estimate, conditionID, sources, prediction, originalWeight) {
    assert.ok(estimate, `Expected an inference for condition ${conditionID}`);
    assert.deepEqual([estimate.conditionID, estimate.selection], [conditionID, 'automatic']);
    for (const key of ['sourceConditionID', 'sourceScore', 'referenceCount', 'validationError']) {
        assert.equal(Object.hasOwn(estimate, key), false, key);
    }
    near(estimate.originalWeight, originalWeight * 100);
    near(estimate.effectiveWeight, originalWeight * 100);
    near(estimate.normalizedScore, prediction);
    near(estimate.contribution, prediction * originalWeight);
    assert.equal(estimate.estimationMethod, 'joint-versions');
    assert.deepEqual(estimate.sources.map(({ sourceScore, ...evidence }) => evidence),
        sources.map(({ sourceScore, ...evidence }) => evidence));
    estimate.sources.forEach((source, i) => near(source.sourceScore, sources[i].sourceScore));
}

test('SQL workspaces sample sitewide ballots per pair and jointly fit eligible measured versions', { timeout: 60000 }, async t => {
    const db = await createFixture(t);
    const topic = await publicTopic(db, 'Scene ballots');
    const [general, specialized] = await addScenes(db, topic.ID);
    const scope = { categoryID: topic.ID, contextValues: sceneValues(general) };
    const specializedScope = { categoryID: topic.ID, contextValues: sceneValues(specialized) };
    const entries = [entry(target, 6000), entry(independent, 2000), entry(unresolved, 2000)];
    const followerEntries = [{ ...entries[0], followCommunityVersion: true }, ...entries.slice(1)];
    await save(db, scope, '42', followerEntries);
    for (const userID of ['43', '1001', '1002', '1003']) await save(db, scope, userID, entries);
    for (const userID of ['42', '1002', '1003']) await vote(db, userID, support(target, preciseSource));
    for (const userID of ['43', '1001']) await vote(db, userID, oppose(target, preciseSource));
    await db.execute('UPDATE estimation_pair_votes SET updated_at = NOW() - INTERVAL 73 HOUR WHERE user_ID = 1002');
    await db.execute('UPDATE personal_pies SET updated_at = NOW() - INTERVAL 73 HOUR WHERE user_ID = 1002 AND context_ID = ?', [general]);
    await db.execute('UPDATE users SET banned_at = NOW() WHERE ID = 1003');

    for (const userID of ['42', '43']) await save(db, specializedScope, userID, [entry(target)]);
    for (let userID = 1004; userID <= 1012; userID++) await save(db, specializedScope, String(userID), [entry(target)]);
    await db.execute('UPDATE personal_pies SET updated_at = NOW() - INTERVAL 90 HOUR WHERE user_ID BETWEEN 1004 AND 1011 AND context_ID = ?', [specialized]);
    await db.execute('UPDATE personal_pies SET updated_at = NOW() - INTERVAL 100 HOUR WHERE user_ID = 1012 AND context_ID = ?', [specialized]);
    // This voter has no general-scene weights. Its old ballot is still in its own pair's ten-vote sample.
    await vote(db, '1012', support(target, alternateSource));
    await db.execute('UPDATE estimation_pair_votes SET updated_at = NOW() - INTERVAL 100 HOUR WHERE user_ID = 1012');

    const rankingCache = createRankingReadCache();
    const read = options => getRankingWorkspace(db, { ...scope, comparison, rankingCache, jsonMemberMetadata: true, ...options });
    const sparseVotes = [tally(target, preciseSource, 2, 2), tally(target, alternateSource, 1, 0)];
    const sparse = await read();
    assert.equal(sparse.publicPie.participantCount, 4);
    assert.deepEqual(sparse.communityEstimationVotes, sparseVotes);
    assert.equal(sparse.versionComposition.find(group => group.benchmarkID === 1).configuredPieCount, 3);
    checkEstimate(modelOne(sparse.modelLeaderboards.public), target, sources, jointScore, .6);
    assert.deepEqual((await read(specializedScope)).communityEstimationVotes, sparseVotes);

    for (let userID = 1004; userID <= 1011; userID++) {
        await save(db, scope, String(userID), followerEntries);
        await vote(db, String(userID), oppose(target, preciseSource));
    }
    await db.execute('UPDATE personal_pies SET updated_at = NOW() - INTERVAL 71 HOUR WHERE user_ID = 1004 AND context_ID = ?', [general]);
    const initial = await read({ userID: '42' });
    assert.equal(initial.scoreMode, 'available');
    assert.equal(initial.publicPie.participantCount, 11);
    const sampledVotes = [tally(target, preciseSource, 1, 10), tally(target, alternateSource, 1, 0)];
    assert.deepEqual(initial.communityEstimationVotes, sampledVotes);
    assert.deepEqual(initial.personalPie.estimationVotes, [support(target, preciseSource)]);
    assert.equal(initial.personalPie.entries.find(row => row.conditionID === target).followCommunityVersion, true);
    assert.equal(initial.versionComposition.find(group => group.benchmarkID === 1).configuredPieCount, 2);

    const personal = modelOne(initial.modelLeaderboards.personal);
    const publicRow = modelOne(initial.modelLeaderboards.public);
    checkEstimate(personal, target, sources, jointScore, .6);
    checkEstimate(publicRow, target, withoutPrecise, withoutPreciseScore, .6);
    const olderOwner = await read({ userID: '1002' });
    checkEstimate(modelOne(olderOwner.modelLeaderboards.personal), target, sources, jointScore, .6);
    assert.deepEqual(olderOwner.personalPie.estimationVotes, [support(target, preciseSource)]);
    assert.deepEqual([personal.lower, personal.upper, personal.coverage], [40.38, 40.38, 20]);
    assert.deepEqual([publicRow.lower, publicRow.upper, publicRow.coverage], [40.94, 40.94, 20]);
    assert.deepEqual([personal.fallbackUsageCount, personal.fallbackCoverage], [1, 60]);
    near(personal.availableInference.observedContribution, 11);
    near(personal.availableInference.inferredContribution, jointScore * .6);
    near(personal.availableInference.inferredFraction, .6);
    near(personal.availableInference.unresolvedFraction, .2);
    assert.equal(personal.availableInference.unresolvedContribution, 0);
    assert.deepEqual(personal.calculationScores.map(score => score.conditionID), [independent]);
    const missingCoverage = personal.coverageEntries.find(item => item.conditionID === target);
    assert.deepEqual([missingCoverage.coveredWeightBasisPoints, missingCoverage.normalizedScore], [0, null]);
    const measured = initial.modelLeaderboards.public.find(row => row.modelID === 2);
    assert.deepEqual([measured.coverage, measured.inferredScores, measured.calculationScores.find(score => score.conditionID === target).normalizedScore],
        [100, [], 47]);

    for (const options of [{ rankingCache: null }, { comparison: { ...comparison, mode: 'matched' } }]) {
        const result = await read({ userID: '42', ...options });
        checkEstimate(modelOne(result.modelLeaderboards.personal), target, sources, jointScore, .6);
        checkEstimate(modelOne(result.modelLeaderboards.public), target, withoutPrecise, withoutPreciseScore, .6);
    }

    const secondary = await read(specializedScope);
    assert.equal(secondary.publicPie.participantCount, 10);
    assert.deepEqual(secondary.communityEstimationVotes, sampledVotes);
    checkEstimate(modelOne(secondary.modelLeaderboards.public), target, withoutPrecise, withoutPreciseScore, 1);
    const range = modelOne((await read({ userID: '42', scoreMode: 'range' })).modelLeaderboards.personal);
    assert.deepEqual([range.lower, range.upper, range.coverage, range.inferredScores], [11, 91, 20, []]);

    const guest = await read({ previewPersonalPie: { entries, estimationVotes: [support(target, preciseSource)] } });
    checkEstimate(modelOne(guest.modelLeaderboards.personal), target, sources, jointScore, .6);
    checkEstimate(modelOne(guest.modelLeaderboards.public), target, withoutPrecise, withoutPreciseScore, .6);
    assert.deepEqual((await read()).personalPie.estimationVotes, []);
    assert.deepEqual((await read()).communityEstimationVotes, sampledVotes);

    for (const ballot of [support(target, excludedSource), support(excludedSource, preciseSource)]) {
        const unavailable = failure => failure.status === 400 && failure.body?.error === 'estimation_vote_condition_unavailable';
        await assert.rejects(read({ previewPersonalPie: { entries: [entry(target)], estimationVotes: [ballot] } }), unavailable);
        await assert.rejects(vote(db, '42', ballot), unavailable);
    }
    const fewPairs = await read({ previewPersonalPie: {
        entries: [entry(target)], estimationVotes: [oppose(target, preciseSource), oppose(target, alternateSource),
            support(target, noisySource), support(target, sparseSource)]
    } });
    checkEstimate(modelOne(fewPairs.modelLeaderboards.personal), target, sources.slice(2), 48.57634644264887, 1);
    const noSources = await read({ previewPersonalPie: { entries: [entry(target)],
        estimationVotes: sources.map(source => oppose(target, source.sourceConditionID)) } });
    const unranked = modelOne(noSources.modelLeaderboards.personal);
    assert.deepEqual([unranked.lower, unranked.coverage, unranked.inferredScores], [null, 0, []]);
    assert.ok(rankingCache.stats.entries > 0);
});

test('SQL weight edits, community version changes and clearing pies preserve account ballots', { timeout: 60000 }, async t => {
    const db = await createFixture(t);
    const topic = await publicTopic(db, 'Global pairs');
    const scope = { categoryID: topic.ID };
    const read = (userID = '42') => getRankingWorkspace(db, { ...scope, comparison, userID });
    const firstTargetVotes = [tally(target, preciseSource, 1, 2)];
    const ownerFirstVote = support(target, preciseSource);
    const otherFirstVote = oppose(target, preciseSource);
    const followerEntry = { ...entry(target), followCommunityVersion: true };
    await save(db, scope, '42', [followerEntry]);
    await vote(db, '42', ownerFirstVote);
    for (const userID of ['43', '1001']) {
        await save(db, scope, userID, [entry(target)]);
        await vote(db, userID, otherFirstVote);
    }
    checkEstimate(modelOne((await read()).modelLeaderboards.public), target, withoutPrecise, withoutPreciseScore, 1);

    const secondEntries = [entry(secondTarget)];
    for (const userID of ['43', '1001']) await save(db, scope, userID, secondEntries, 1);
    assert.deepEqual((await read('43')).personalPie.estimationVotes, [otherFirstVote]);

    const changedCommunity = await read();
    assert.deepEqual(changedCommunity.communityEstimationVotes, firstTargetVotes);
    assert.deepEqual(changedCommunity.personalPie.estimationVotes, [ownerFirstVote]);
    assert.equal(changedCommunity.personalPie.revision, 1);
    assert.deepEqual(changedCommunity.personalPie.effectiveEntries.map(item => item.conditionID), [secondTarget]);
    for (const mode of ['public', 'personal']) {
        checkEstimate(modelOne(changedCommunity.modelLeaderboards[mode]), secondTarget, sources, secondTargetScore, 1);
    }

    const ownerSecondVote = oppose(secondTarget, preciseSource);
    const ownerVotes = [ownerFirstVote, ownerSecondVote];
    await vote(db, '42', ownerSecondVote);
    await vote(db, '43', support(secondTarget, preciseSource));
    const distinctPairs = await read();
    const twoTallies = [...firstTargetVotes, tally(secondTarget, preciseSource, 1, 1)];
    const secondWithoutPrecise = withoutPreciseScore + 3;
    assert.deepEqual(distinctPairs.communityEstimationVotes, twoTallies);
    checkEstimate(modelOne(distinctPairs.modelLeaderboards.public), secondTarget, sources, secondTargetScore, 1);
    checkEstimate(modelOne(distinctPairs.modelLeaderboards.personal), secondTarget, withoutPrecise, secondWithoutPrecise, 1);

    await save(db, scope, '42', [entry(target)], 1);
    const persisted = await loadPersonalPie(db, distinctPairs.context.ID, '42');
    assert.deepEqual(persisted.entries, [entry(target)]);
    const restored = await read();
    assert.deepEqual(restored.personalPie.estimationVotes, ownerVotes);
    assert.deepEqual(restored.communityEstimationVotes, twoTallies);
    checkEstimate(modelOne(restored.modelLeaderboards.personal), target, sources, jointScore, 1);
    const publicRow = modelOne(restored.modelLeaderboards.public);
    assert.equal(publicRow.inferredScores.length, 2);
    checkInferenceLine(publicRow.inferredScores.find(item => item.conditionID === target), target, withoutPrecise, withoutPreciseScore, 1 / 3);
    checkInferenceLine(publicRow.inferredScores.find(item => item.conditionID === secondTarget), secondTarget, sources, secondTargetScore, 2 / 3);
    assert.deepEqual([publicRow.lower, publicRow.coverage, publicRow.fallbackCoverage], [51.28, 0, 100]);
    assert.deepEqual(await conditionImpact(db, 'benchmark', 1, target), { resultCount: 6, pieCount: 1, estimationPairCount: 1 });
    assert.deepEqual(await conditionImpact(db, 'benchmark', 1, secondTarget), { resultCount: 6, pieCount: 2, estimationPairCount: 1 });
    assert.deepEqual(await conditionImpact(db, 'benchmark', 1, preciseSource), { resultCount: 7, pieCount: 0, estimationPairCount: 2 });

    await save(db, scope, '42', [followerEntry], 2);
    const followed = await read();
    assert.deepEqual(followed.communityEstimationVotes, twoTallies);
    assert.deepEqual(followed.personalPie.effectiveEntries.map(item => item.conditionID), [secondTarget]);
    checkEstimate(modelOne(followed.modelLeaderboards.personal), secondTarget, withoutPrecise, secondWithoutPrecise, 1);

    await save(db, scope, '42', [entry(independent)], 3);
    assert.deepEqual((await read()).personalPie.estimationVotes, ownerVotes);
    const cleared = await save(db, scope, '43', [], 2);
    assert.equal(cleared.personalPie.revision, 0);
    assert.equal(await loadPersonalPie(db, distinctPairs.context.ID, '43'), null);
    assert.deepEqual((await read('43')).personalPie.estimationVotes, [otherFirstVote, support(secondTarget, preciseSource)]);
    assert.deepEqual((await read()).communityEstimationVotes, twoTallies);
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
        rankingCache, rankingPager: createRankingPager(), readWriteIdentity, requireAccountWriteOwner, saveEstimationVote, savePersonalPie,
        requireAuthForAPI(req, res, next) { if (fixtureSession(req) === null) return res.status(401).json({ error: 'authentication_required' }); next(); },
        requireCurrentTermsForAPI(_req, _res, next) { next(); },
        topicHome, topicPreviewComparison, searchPresentation
    };
    for (const endpoint of ['get_topic_preview', 'get_weighted_workspace', 'save_personal_pie', 'save_estimation_vote']) {
        const start = source.indexOf(`API.post('/${endpoint}',`);
        assert.ok(start >= 0, endpoint);
        runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), bindings);
    }
    app.use((error, _req, res, _next) => res.status(error.status ?? 500).json(error.body ?? { error: error.message }));
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    t.after(() => new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())));
    async function post(endpoint, request, { userID, status = 200, key = randomUUID() } = {}) {
        const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key };
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

test('SQL-backed workspace and home can estimate through a single paired peer and honor a veto on the bridge', { timeout: 60000 }, async t => {
    const db = await createFixture(t);
    const anchor = 10;
    await db.execute("INSERT INTO benchmark_conditions (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale) VALUES (?, 1, 'bridge-anchor', 'Anchor', 'higher', 1)", [anchor]);
    await db.execute("INSERT INTO models (ID, vendor_ID, slug, name) VALUES (8, 1, 'bridge-peer', 'Bridge peer'), (9, 1, 'bridge-subject', 'Bridge subject')");
    for (const [modelID, conditionID, value] of [[8, anchor, 80], [8, preciseSource, 59.5], [9, anchor, 80]]) {
        await db.execute(`INSERT INTO benchmark_results
            (model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, benchmark_condition_snapshot, score_fields)
            VALUES (?, 1, ?, ?, 'https://example.test/bridge', 'vendor_official', '{}', '[]')`, [modelID, conditionID, value]);
    }
    const topic = await publicTopic(db, 'Indirect estimation'), scope = { categoryID: topic.ID, contextValues: {} };
    await save(db, scope, '42', [entry(target)]);
    const { post } = await openFixtureAPI(t, db, createRankingReadCache());
    const request = { ...scope, comparison, scoreMode: 'available' };
    const initial = await post('get_weighted_workspace', request);
    validateWorkspacePayload(initial);
    const subject = rows => rows.find(row => row.modelID === 9);
    const row = subject(initial.modelLeaderboards.public);
    assert.deepEqual([row.lower, row.coverage], [49.5, 0]);
    checkEstimate(row, target, [{ sourceConditionID: anchor, sourceScore: 80, referenceCount: 1,
        calibrationPaths: [[{ targetConditionID: preciseSource, referenceCount: 1 }, { targetConditionID: target, referenceCount: 6 }]] }], 49.5, 1);
    const home = await post('get_topic_preview', { categoryID: topic.ID });
    assert.equal(subject(home.models).lower, 49.5);

    const previewPersonalPie = { entries: [entry(target)], estimationVotes: [oppose(preciseSource, anchor)] };
    const vetoed = await post('get_weighted_workspace', { ...request, initialMode: 'personal', previewPersonalPie });
    validateWorkspacePayload(vetoed);
    assert.deepEqual(subject(vetoed.modelLeaderboards.personal).inferredScores, []);
    assert.equal(subject(vetoed.modelLeaderboards.personal).availableInference.unresolvedFraction, 1);
    const community = await post('get_weighted_workspace', { ...request, initialMode: 'public', previewPersonalPie });
    assert.equal(subject(community.modelLeaderboards.public).lower, 49.5);
});

test('HTTP sitewide ballots refresh cyclic workspace and home rankings without persisting guest previews', { timeout: 60000 }, async t => {
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
    await save(db, scope(branchA), '42', [entry(target)]);
    await save(db, scope(branchB), '42', branchBEntries);
    await save(db, scope(branchA), '42', branchAEntries, 1);
    await save(db, scope(root), '42', rootEntries);

    const { post, searchPresentation } = await openFixtureAPI(t, db, rankingCache);
    const request = { ...scope(root), comparison, scoreMode: 'available' };
    const initial = await post('get_weighted_workspace', request);
    validateWorkspacePayload(initial);
    assert.deepEqual(initial.publicPie.referenceIssues, []);
    const publicRow = modelOne(initial.modelLeaderboards.public);
    assert.deepEqual([publicRow.lower, publicRow.upper, publicRow.coverage], [48.96, 48.96, 0]);
    checkEstimate(publicRow, target, sources, jointScore, 1);
    const personal = await post('get_weighted_workspace', { ...request, initialMode: 'personal' }, { userID: '42' });
    checkEstimate(modelOne(personal.modelLeaderboards.personal), target, sources, jointScore, 1);

    const homeRequest = { categoryID: root.ID };
    const homeBefore = await post('get_topic_preview', homeRequest);
    assert.equal(modelOne(homeBefore.models).lower, 48.96);
    const crawlerPreview = async () => {
        const topic = (await searchPresentation.topics()).find(item => item.ID === root.ID);
        return searchPresentation.snapshot(topic, null);
    };
    assert.equal(modelOne((await crawlerPreview()).models).lower, 48.96);

    const validVote = oppose(target, preciseSource);
    const beforePreview = await db.query('SELECT * FROM personal_pies ORDER BY ID');
    const previewRequest = { ...request, ...scope(branchA), previewPersonalPie: {
        entries: branchAEntries, estimationVotes: [validVote, support(target, alternateSource)]
    } };
    const preview = await post('get_weighted_workspace', { ...previewRequest, initialMode: 'personal' });
    validateWorkspacePayload(preview);
    checkEstimate(modelOne(preview.modelLeaderboards.personal), target, withoutPrecise, withoutPreciseScore, 1);
    const publicPreview = await post('get_weighted_workspace', previewRequest);
    checkEstimate(modelOne(publicPreview.modelLeaderboards.public), target, sources, jointScore, 1);
    assert.deepEqual(await db.query('SELECT * FROM personal_pies ORDER BY ID'), beforePreview);
    assert.deepEqual((await db.query('SELECT * FROM estimation_pair_votes'))[0], []);
    assert.equal((await post('get_topic_preview', homeRequest)).pagination.snapshotID, homeBefore.pagination.snapshotID);
    checkEstimate(modelOne((await post('get_weighted_workspace', request)).modelLeaderboards.public), target, sources, jointScore, 1);

    for (const estimationVotes of [[{ conditionID: preciseSource, vote: 'oppose' }],
        [{ targetConditionID: target, sourceConditionID: target, vote: 'oppose' }],
        [validVote, { targetConditionID: preciseSource, sourceConditionID: target, vote: 'support' }]]) {
        const failure = await post('get_weighted_workspace', { ...previewRequest,
            previewPersonalPie: { entries: branchAEntries, estimationVotes } }, { status: 400 });
        assert.equal(failure.error, 'invalid_estimation_votes');
    }
    const receipt = await post('save_estimation_vote', { expectedUserID: '42', ...validVote }, { userID: '42' });
    assert.deepEqual({ targetConditionID: receipt.targetConditionID, sourceConditionID: receipt.sourceConditionID, vote: receipt.vote }, validVote);
    assert.deepEqual(await db.query('SELECT * FROM personal_pies ORDER BY ID'), beforePreview);

    const fresh = await post('get_weighted_workspace', request);
    validateWorkspacePayload(fresh);
    const freshRow = modelOne(fresh.modelLeaderboards.public);
    assert.equal(freshRow.lower, 49.9);
    checkEstimate(freshRow, target, withoutPrecise, withoutPreciseScore, 1);
    const homeAfter = await post('get_topic_preview', homeRequest);
    assert.equal(modelOne(homeAfter.models).lower, 49.9);
    assert.notEqual(homeAfter.pagination.snapshotID, homeBefore.pagination.snapshotID);
    await post('get_topic_preview', { ...homeRequest, snapshotID: homeBefore.pagination.snapshotID }, { status: 410 });
    assert.equal(modelOne((await crawlerPreview()).models).lower, 49.9);
});

test('HTTP external nominations appear and score in both directions until their sampled support disappears', { timeout: 60000 }, async t => {
    const db = await createFixture(t);
    const forwardSubject = 8, reverseSubject = 9, lowCoverage = 10;
    await db.execute(`INSERT INTO models (ID, vendor_ID, slug, name) VALUES
        (8, 1, 'external-forward', 'External forward'), (9, 1, 'external-reverse', 'External reverse')`);
    await db.execute("INSERT INTO benchmarks (ID, name) VALUES (4, 'Low coverage')");
    await db.execute(`INSERT INTO benchmark_conditions
        (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_default, is_primary)
        VALUES (?, 4, 'default', 'Default', 'higher', 1, 1, 1)`, [lowCoverage]);
    for (const [modelID, conditionID, value] of [[forwardSubject, independent, 53.5], [reverseSubject, target, 49.5],
        [forwardSubject, unresolved, 21], [reverseSubject, unresolved, 21]]) {
        await db.execute(`INSERT INTO benchmark_results (model_ID, benchmark_ID, benchmark_condition_ID, raw_score,
            source_url, source_type, benchmark_condition_snapshot, score_fields)
            VALUES (?, ?, ?, ?, 'https://example.test/external-pair', 'vendor_official', '{}', '[]')`,
        [modelID, conditionID, conditionID, value]);
    }
    await db.execute(`INSERT INTO benchmark_results (model_ID, benchmark_ID, benchmark_condition_ID, raw_score,
        source_url, source_type, benchmark_condition_snapshot, score_fields)
        VALUES (1, 4, ?, 50, 'https://example.test/low-coverage/1', 'vendor_official', '{}', '[]'),
               (2, 4, ?, 60, 'https://example.test/low-coverage/2', 'vendor_official', '{}', '[]')`, [lowCoverage, lowCoverage]);
    const forward = await publicTopic(db, 'External forward');
    const reverse = await publicTopic(db, 'External reverse');
    const entries = conditionID => [entry(conditionID, 8000), entry(unresolved, 2000)];
    await save(db, { categoryID: forward.ID }, '42', entries(target));
    await save(db, { categoryID: reverse.ID }, '42', entries(independent));

    const { post } = await openFixtureAPI(t, db, createRankingReadCache());
    const read = async (topic, mode = 'public', userID = '42', compare = comparison) => {
        const workspace = await post('get_weighted_workspace', { categoryID: topic.ID, comparison: compare, initialMode: mode }, { userID });
        validateWorkspacePayload(workspace, { initialMode: mode });
        return workspace;
    };
    const pair = { targetConditionID: target, sourceConditionID: independent };
    const reversePair = { targetConditionID: independent, sourceConditionID: target };
    const write = (userID, change, options) => post('save_estimation_vote', {
        expectedUserID: userID, ...pair, ...change
    }, { userID, ...options });
    const expectPair = async (supportCount, opposeCount, available = supportCount >= opposeCount) => {
        for (const [topic, subject, conditionID, sourceID, prediction, sourceScore] of [
            [forward, forwardSubject, target, independent, 49.5, 53.5],
            [reverse, reverseSubject, independent, target, 53.5, 49.5]
        ]) {
            const workspace = await read(topic);
            assert.deepEqual(workspace.externalEstimationPairs, supportCount ? [pair] : []);
            assert.deepEqual(workspace.communityEstimationVotes, supportCount ? [tally(target, independent, supportCount, opposeCount)] : []);
            const row = workspace.modelLeaderboards.public.find(model => model.modelID === subject);
            if (available) {
                checkEstimate(row, conditionID, [{ sourceConditionID: sourceID, sourceScore, referenceCount: 6 }], prediction, .8);
            } else {
                assert.deepEqual([row.lower, row.coverage, row.inferredScores], [4.2, 20, []]);
            }
        }
    };
    const checkForwardPersonal = async () => {
        const workspace = await read(forward, 'personal');
        const row = workspace.modelLeaderboards.personal.find(model => model.modelID === forwardSubject);
        checkEstimate(row, target, [{ sourceConditionID: independent, sourceScore: 53.5, referenceCount: 6 }], 49.5, .8);
    };

    await expectPair(0, 0, false);
    const unauthorized = await post('save_estimation_vote', { ...pair, vote: 'support', nominate: true }, { status: 401 });
    assert.equal(unauthorized.error, 'authentication_required');
    const mismatched = await write('42', { expectedUserID: '43', vote: 'support', nominate: true }, { status: 409 });
    assert.equal(mismatched.error, 'account_changed');
    const unchanged = await write('42', { vote: 'support' }, { status: 400 });
    assert.equal(unchanged.error, 'estimation_vote_condition_unavailable');
    const unavailable = await write('42', { sourceConditionID: lowCoverage, vote: 'support', nominate: true }, { status: 400 });
    assert.equal(unavailable.error, 'estimation_vote_condition_unavailable');
    assert.deepEqual((await db.query('SELECT * FROM estimation_pair_votes'))[0], []);

    const key = randomUUID();
    const [nomination, replay] = await Promise.all([
        write('42', { vote: 'support', nominate: true }, { key }),
        write('42', { ...reversePair, vote: 'support', nominate: true }, { key })
    ]);
    assert.deepEqual(nomination, { saved: true, userID: '42', requestKey: key, ...pair, vote: 'support', nominate: true });
    assert.deepEqual(replay, nomination);
    const conflict = await write('42', { ...reversePair, vote: 'oppose' }, { key, status: 409 });
    assert.equal(conflict.error, 'write_identity_reused');

    await db.execute(`UPDATE estimation_pair_votes SET updated_at = NOW() - INTERVAL 48 HOUR
        WHERE user_ID=42 AND first_ID=? AND second_ID=?`, [target, independent]);
    const ballots = async () => (await db.execute(`SELECT user_ID, first_ID, second_ID, vote,
        DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS votedAt
        FROM estimation_pair_votes ORDER BY user_ID`))[0];
    const original = await ballots();
    assert.deepEqual(original.map(({ votedAt, ...ballot }) => ballot),
        [{ user_ID: '42', first_ID: String(target), second_ID: String(independent), vote: 'support' }]);
    await write('42', { ...reversePair, vote: 'support' });
    assert.deepEqual(await ballots(), original);

    const adoption = await post('save_personal_pie', { categoryID: forward.ID, expectedRevision: 0, expectedUserID: '43',
        entries: entries(target), estimationVotes: [{ ...reversePair, vote: 'support' }] }, { userID: '43' });
    assert.deepEqual(adoption.personalPie.estimationVotes, [support(target, independent)]);
    assert.equal(adoption.personalPie.revision, 1);
    await write('1001', { vote: 'oppose' });
    await expectPair(2, 1);
    await checkForwardPersonal();
    const matched = await read(forward, 'public', '42', { ...comparison, mode: 'matched' });
    checkEstimate(matched.modelLeaderboards.public.find(model => model.modelID === forwardSubject), target,
        [{ sourceConditionID: independent, sourceScore: 53.5, referenceCount: 6 }], 49.5, .8);
    checkEstimate(modelOne(matched.modelLeaderboards.public), target, sources, jointScore, .8);

    await write('42', { ...reversePair, vote: null });
    await expectPair(1, 1);
    await write('43', { vote: null });
    await expectPair(0, 1, false);
    assert.deepEqual((await read(forward, 'personal', '1001')).personalPie.estimationVotes, []);
    assert.deepEqual(await write('42', { ...reversePair, vote: 'support', nominate: true }, { key }), nomination);
    await expectPair(0, 1, false);

    const importRequest = { categoryID: forward.ID, expectedRevision: 1, expectedUserID: '42', entries: entries(target),
        estimationVotes: [support(target, independent)] };
    const beforeImport = await db.query('SELECT * FROM personal_pies ORDER BY ID');
    const rejected = await post('save_personal_pie', importRequest, { userID: '42', status: 400 });
    assert.equal(rejected.error, 'estimation_vote_condition_unavailable');
    assert.deepEqual(await db.query('SELECT * FROM personal_pies ORDER BY ID'), beforeImport);
    await expectPair(0, 1, false);

    await write('43', { ...reversePair, vote: 'support', nominate: true });
    await expectPair(1, 1);
    await write('43', { vote: 'oppose' });
    await expectPair(0, 2, false);
    await write('42', { ...reversePair, vote: 'support', nominate: true });
    await expectPair(1, 2, false);
    await checkForwardPersonal();
    await write('43', { ...reversePair, vote: null });
    await expectPair(1, 1);

    await db.execute(`UPDATE estimation_pair_votes SET updated_at = NOW() - INTERVAL 73 HOUR
        WHERE user_ID=42 AND first_ID=? AND second_ID=?`, [target, independent]);
    for (let userID = 1002; userID <= 1009; userID++) await write(String(userID), { vote: 'oppose' });
    await expectPair(1, 9, false);
    await write('1010', { vote: 'oppose' });
    await expectPair(0, 10, false);
    const expiredPersonal = await read(forward, 'personal');
    assert.deepEqual(expiredPersonal.personalPie.estimationVotes, []);
    assert.deepEqual(expiredPersonal.modelLeaderboards.personal.find(model => model.modelID === forwardSubject).inferredScores, []);
    await write('1010', { ...reversePair, vote: null });
    await expectPair(1, 9, false);
    await write('1010', { vote: 'oppose' });
    await expectPair(0, 10, false);
    await write('42', { vote: 'support', nominate: true });
    await expectPair(1, 10, false);
    await checkForwardPersonal();
});

test('SQL migration imports the latest unambiguous legacy vote for each unordered pair and reruns safely', { timeout: 60000 }, async t => {
    const db = await createFixture(t);
    const earlierTopic = await publicTopic(db, 'Earlier legacy votes');
    const laterTopic = await publicTopic(db, 'Later legacy votes');
    for (const topic of [earlierTopic, laterTopic]) {
        for (const userID of ['42', '43', '1001']) await save(db, { categoryID: topic.ID }, userID, [entry(target)]);
    }
    const contextOf = async topic => (await getRankingWorkspace(db, { categoryID: topic.ID, comparison })).context.ID;
    const earlier = await contextOf(earlierTopic), later = await contextOf(laterTopic);
    const connection = await db.getConnection();
    try {
        await connection.query('ALTER TABLE personal_pies ADD COLUMN estimation_votes JSON NULL');
        const oldVote = (userID, contextID, updatedAt, votes) => connection.execute(
            'UPDATE personal_pies SET estimation_votes=?, updated_at=? WHERE user_ID=? AND context_ID=?',
            [JSON.stringify(votes), updatedAt, userID, contextID]);
        const firstDay = '2026-11-10 10:00:00', secondDay = '2026-11-11 10:00:00';
        const reversedSupport = { targetConditionID: preciseSource, sourceConditionID: target, vote: 'support' };
        await oldVote('42', earlier, firstDay, [support(target, preciseSource), support(target, independent)]);
        await oldVote('42', later, secondDay, [{ ...reversedSupport, vote: 'oppose' }, { conditionID: alternateSource, vote: 'oppose' }]);
        await oldVote('43', earlier, secondDay, [oppose(target, preciseSource)]);
        await oldVote('43', later, secondDay, [reversedSupport]);
        await oldVote('1001', earlier, secondDay, [support(target, preciseSource)]);
        await oldVote('1001', later, secondDay, [reversedSupport]);

        await connection.query('DROP TABLE estimation_pair_votes');
        await connection.execute('DELETE FROM schema_migrations WHERE migration_id=?', ['global_estimation_pairs_20261126']);
        assert.deepEqual(await migrateEstimationVotes(connection), { applied: false, missing: true });
        assert.deepEqual(await migrateEstimationVotes(connection, { apply: true }), { applied: true, changed: true, missing: false });
        const imported = async () => (await connection.query(`SELECT user_ID, first_ID, second_ID, vote,
            DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAt FROM estimation_pair_votes ORDER BY user_ID`))[0];
        const expected = [
            { user_ID: '42', first_ID: String(target), second_ID: String(preciseSource), vote: 'oppose', updatedAt: secondDay },
            { user_ID: '1001', first_ID: String(target), second_ID: String(preciseSource), vote: 'support', updatedAt: secondDay }
        ];
        assert.deepEqual(await imported(), expected);

        await connection.execute('DELETE FROM estimation_pair_votes WHERE user_ID=42');
        assert.deepEqual(await migrateEstimationVotes(connection, { apply: true }), { applied: true, changed: false, missing: false });
        assert.deepEqual(await imported(), expected.slice(1));
    } finally { connection.release(); }
});
