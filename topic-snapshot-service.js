import { createHash } from 'node:crypto';
import { getTopic, normalizeTopicRequest, topicID } from './topic-service.js';
import { loadPersonalPie, loadBenchmarkConditions, normalizePreviewPersonalPie, getProposalRankingWorkspace } from './ranking-service.js';
import { loadTopicReferenceTargets } from './topic-reference-service.js';
import { loadTopicSceneCatalog, insertTopicScene, TOPIC_SCENE_SQL_PREVIEW } from './topic-scenes-service.js';
import { ensureBenchmarkFamily } from './benchmark-family-service.js';
import { insertPrivateTopic, replacePrivateScenes, privateTopicTransaction } from './private-topic-service.js';
import { loadScoreFieldCatalog } from './score-field-service.js';
import { topicPreviewComparison, serializeTopicPreviewModels } from './topic-home-service.js';
import { rankModels } from './ranking-pagination.js';

const fail = (status, error, details = {}) => { throw { status, body: { error, ...details } }; };
export const snapshotHash = snapshot => createHash('sha256').update(JSON.stringify(snapshot, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');

export async function validateSnapshotEvidence(connection, snapshot, userID = null) {
    const conditions = new Map((await loadBenchmarkConditions(connection)).map(item => [item.conditionID, item]));
    const targets = new Map((await loadTopicReferenceTargets(connection, userID)).map(item => [item.contextID, item]));
    for (const scene of snapshot.scenes) {
        const pie = normalizePreviewPersonalPie({ entries: scene.entries, fallbackRules: scene.fallbackRules });
        for (const ID of [...pie.entries.map(entry => entry.conditionID), ...pie.fallbackRules.flatMap(rule => rule.entries.map(entry => entry.conditionID))]) {
            if (ID < 0) {
                const target = targets.get(-ID);
                if (!target || target.isPrivate) fail(409, 'proposal_private_or_unavailable_reference', { sceneName: scene.name });
            } else if (!conditions.has(ID) || conditions.get(ID).excludedFromRanking) {
                fail(409, 'proposal_evaluation_unavailable', { conditionID: ID, sceneName: scene.name });
            }
        }
    }
}

export async function captureTopicSnapshot(connection, userID, sourceTopicID, metadata = {}) {
    const topic = await getTopic(connection, userID, topicID(sourceTopicID));
    if (!topic.isPrivate) fail(404, 'private_topic_not_found');
    const normalized = normalizeTopicRequest({ name: metadata.name ?? topic.name,
        description: metadata.description ?? topic.description, isPrivate: false });
    const contexts = topic.scenes.length ? topic.scenes : [{ ID: topic.defaultContextID, name: null, description: '', isDefault: true }];
    const scenes = [];
    for (const [index, scene] of contexts.entries()) {
        const pie = await loadPersonalPie(connection, scene.ID, userID);
        scenes.push({ key: 'scene-' + index, name: scene.name, description: scene.description, isDefault: scene.isDefault,
            entries: pie?.entries ?? [], fallbackRules: (pie?.fallbackRules ?? []).map(rule => ({
                primaryConditionID: rule.primaryConditionID, mode: rule.mode,
                entries: rule.entries.map(entry => ({ conditionID: entry.conditionID })),
                ...(rule.selectionSource ? { selectionSource: rule.selectionSource } : {})
            })) });
    }
    if (!scenes.find(scene => scene.isDefault)?.entries.length) fail(409, 'proposal_topic_empty');
    const snapshot = { version: 1, name: normalized.name, description: normalized.description,
        hasScenes: topic.scenes.length > 0, scenes };
    await validateSnapshotEvidence(connection, snapshot, userID);
    return snapshot;
}

export async function saveTopicProposalSnapshot(connection, proposalID, revision, sourceTopicID, snapshot) {
    await connection.execute(`INSERT INTO topic_proposal_snapshots
        (proposal_ID, revision, source_topic_ID, content, content_hash) VALUES (?, ?, ?, ?, ?)`,
    [proposalID, revision, sourceTopicID, JSON.stringify(snapshot), snapshotHash(snapshot)]);
}

export async function loadTopicProposalSnapshot(connection, proposalID, revision) {
    const [rows] = await connection.execute(`SELECT content, content_hash, source_topic_ID FROM topic_proposal_snapshots
        WHERE proposal_ID = ? AND revision = ?`, [proposalID, revision]);
    if (!rows.length) return null;
    const snapshot = typeof rows[0].content === 'string' ? JSON.parse(rows[0].content) : rows[0].content;
    if (snapshot?.version !== 1 || snapshotHash(snapshot) !== rows[0].content_hash) fail(503, 'topic_proposal_snapshot_invalid');
    return { snapshot, sourceTopicID: Number(rows[0].source_topic_ID) };
}

export async function seedSnapshotTopic(connection, topic, owner, snapshot, { rootContextID = null } = {}) {
    await validateSnapshotEvidence(connection, snapshot, owner);
    const categoryID = Number(topic.ID);
    const contexts = new Map();
    if (connection[TOPIC_SCENE_SQL_PREVIEW] === true && categoryID < 0) {
        if (!Number.isSafeInteger(rootContextID) || rootContextID >= 0) fail(409, 'topic_root_context_invalid');
        for (const [position, scene] of snapshot.scenes.entries()) contexts.set(scene.key, snapshot.hasScenes
            ? await insertTopicScene(connection, categoryID, scene, { contextID: scene.isDefault ? rootContextID : null, position })
            : rootContextID);
    } else {
        const catalog = (await loadTopicSceneCatalog(connection, [categoryID])).get(categoryID);
        const scenes = snapshot.hasScenes ? snapshot.scenes.map(scene => ({ ...scene, ID: null })) : [];
        await replacePrivateScenes(connection, topic, catalog, { scenes,
            defaultSceneKey: scenes.find(scene => scene.isDefault)?.key ?? null });
        const next = (await loadTopicSceneCatalog(connection, [categoryID])).get(categoryID);
        for (const scene of snapshot.scenes) contexts.set(scene.key, snapshot.hasScenes
            ? next.scenes.find(item => item.name === scene.name)?.ID : next.defaultContextID);
    }
    for (const scene of snapshot.scenes) {
        if (!scene.entries.length) continue;
        const contextID = contexts.get(scene.key);
        if (!contextID) fail(409, 'topic_scene_not_found');
        const [inserted] = await connection.execute(`INSERT INTO personal_pies (user_ID, context_ID, revision) VALUES (?, ?, 1)`, [owner, contextID]);
        const pieID = Number(inserted.insertId);
        for (const entry of scene.entries) {
            if (entry.conditionID > 0) await connection.execute(`INSERT INTO personal_pie_weights
                (pie_ID, benchmark_condition_ID, weight_basis_points) VALUES (?, ?, ?)`, [pieID, entry.conditionID, entry.weightBasisPoints]);
            else await connection.execute(`INSERT INTO personal_pie_topic_weights
                (pie_ID, target_context_ID, weight_basis_points) VALUES (?, ?, ?)`, [pieID, -entry.conditionID, entry.weightBasisPoints]);
        }
        for (const rule of scene.fallbackRules) {
            const familyID = rule.entries.length ? await ensureBenchmarkFamily(connection, rule.primaryConditionID, rule.entries) : null;
            await connection.execute(`INSERT INTO personal_pie_score_rules
                (pie_ID, primary_benchmark_condition_ID, family_ID, selection_source) VALUES (?, ?, ?, ?)`,
            [pieID, rule.primaryConditionID, familyID, rule.selectionSource ?? 'selected']);
        }
    }
}

export function createProposalPreviewService({ db, rankingCache, readProposal,
    loadSnapshot = loadTopicProposalSnapshot, loadWorkspace = getProposalRankingWorkspace, loadFields = loadScoreFieldCatalog }) {
    async function read(userID, body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(key => !['proposalID', 'revision'].includes(key))) fail(400, 'invalid_topic_proposal_request');
        const proposal = await readProposal(db, topicID(body.proposalID), userID);
        if (body.revision !== undefined && body.revision !== proposal.revision) fail(409, 'topic_proposal_changed');
        const saved = await loadSnapshot(db, proposal.proposalID, proposal.revision);
        if (!saved) fail(404, 'topic_proposal_preview_unavailable');
        return { proposal, snapshot: saved.snapshot };
    }
    async function preview(userID, body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(key => !['proposalID', 'revision', 'sceneKey', 'entries', 'scoreMode', 'reasoning', 'harness'].includes(key))) fail(400, 'invalid_topic_proposal_preview');
        const { proposal, snapshot } = await read(userID, { proposalID: body.proposalID, revision: body.revision });
        const scene = body.sceneKey === undefined ? snapshot.scenes.find(item => item.isDefault)
            : snapshot.scenes.find(item => item.key === body.sceneKey);
        if (!scene) fail(404, 'topic_scene_not_found');
        for (const key of ['reasoning', 'harness']) if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(400, 'invalid_topic_comparison');
        const selected = body.entries ?? scene.entries;
        if (!Array.isArray(selected) || selected.some(item => !scene.entries.some(entry => entry.conditionID === item?.conditionID))) fail(400, 'invalid_proposal_trial_entries');
        const fallbackRules = scene.fallbackRules.filter(rule => selected.some(item => item.conditionID === rule.primaryConditionID));
        const fields = await loadFields(db);
        const workspace = await loadWorkspace(db, { name: snapshot.name, entries: selected, fallbackRules },
            { scoreMode: body.scoreMode ?? 'available', comparison: topicPreviewComparison(fields, body), rankingCache });
        return { proposalID: proposal.proposalID, revision: proposal.revision, sceneKey: scene.key,
            scoreMode: workspace.scoreMode, weights: workspace.personalPie.entries,
            referenceIssues: workspace.personalPie.referenceIssues,
            models: serializeTopicPreviewModels(rankModels(workspace.modelLeaderboards.personal), workspace.comparison.models),
            participantCount: 1, isTrial: body.entries !== undefined };
    }
    async function copy(userID, body, key) {
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(name => !['proposalID', 'revision', 'name', 'sceneDrafts'].includes(name))) fail(400, 'invalid_topic_proposal_request');
        const metadata = normalizeTopicRequest({ name: body.name, description: 'Private copy', isPrivate: true });
        const request = { proposalID: topicID(body.proposalID), revision: topicID(body.revision), name: metadata.name,
            sceneDrafts: body.sceneDrafts ?? [] };
        if (!Array.isArray(request.sceneDrafts)) fail(400, 'invalid_proposal_trial_entries');
        return privateTopicTransaction(db, userID, key, 'copy_topic_proposal', request, async (connection, owner) => {
            const proposal = await readProposal(connection, request.proposalID, owner);
            if (proposal.revision !== request.revision) fail(409, 'topic_proposal_changed');
            const saved = await loadSnapshot(connection, proposal.proposalID, proposal.revision);
            if (!saved) fail(404, 'topic_proposal_preview_unavailable');
            const snapshot = structuredClone(saved.snapshot), keys = new Set();
            for (const draft of request.sceneDrafts) {
                const scene = snapshot.scenes.find(item => item.key === draft?.key);
                if (!scene || keys.has(draft.key) || Object.keys(draft).some(name => !['key', 'entries'].includes(name))
                    || !Array.isArray(draft.entries) || draft.entries.some(item => !scene.entries.some(entry => entry.conditionID === item?.conditionID))) fail(400, 'invalid_proposal_trial_entries');
                keys.add(draft.key);
                const pie = normalizePreviewPersonalPie({ entries: draft.entries,
                    fallbackRules: scene.fallbackRules.filter(rule => draft.entries.some(item => item.conditionID === rule.primaryConditionID)) });
                Object.assign(scene, pie);
            }
            const topic = await insertPrivateTopic(connection, owner, { name: request.name, description: snapshot.description });
            await seedSnapshotTopic(connection, topic, owner, snapshot);
            return { categoryID: topic.ID, url: '/personal/' + topic.ID, name: topic.name, isPrivate: true };
        });
    }
    return { read, preview, copy };
}
