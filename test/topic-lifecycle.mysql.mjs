import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import mysql from 'mysql2';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { savePrivateTopic, readPrivateTopicEditor, deletePrivateTopic } from '../private-topic-service.js';
import { getTopic, assertPublicTopicAvailable } from '../topic-service.js';
import { loadPersonalPie, savePersonalPie } from '../ranking-service.js';
import { captureTopicSnapshot, loadTopicProposalSnapshot, seedSnapshotTopic, createProposalPreviewService } from '../topic-snapshot-service.js';
import { createTopicProposalService, readProposal, lockTopicProposalForReview, finishTopicProposalReview } from '../topic-proposal-service.js';
import { lockTopicReferences, loadTopicReferenceTargets } from '../topic-reference-service.js';
import { canonicalAccountID } from '../public/js/shared/account-identity.js';
import { TOPIC_SCENE_SQL_PREVIEW } from '../topic-scenes-service.js';

const rejects = code => error => error.body?.error === code;
const edit = topic => ({ categoryID: topic.ID, expectedRevision: topic.editRevision, name: topic.name,
    description: topic.description, scenes: topic.scenes.map(scene => ({ key: 's' + scene.ID, ID: scene.ID,
        name: scene.name, description: scene.description })), defaultSceneKey: topic.hasScenes ? 's' + topic.defaultContextID : null });

test('private topics, immutable proposals, trial rankings and publication in isolated MySQL', async t => {
    const db = await createLifecycleDatabase();
    t.after(() => db.close());
    const pool = db.pool;
    await seedLifecycleEvidence(pool);
    const create = (name, owner = '42', withScenes = true) => savePrivateTopic(pool, owner, { name,
        description: 'Evaluate useful work.', scenes: withScenes ? [
            { key: 'code', name: 'Coding', description: '' }, { key: 'research', name: 'Research', description: '' }
        ] : [], defaultSceneKey: withScenes ? 'code' : null }, randomUUID());
    const savePie = async (topic, sceneID = topic.defaultContextID, entries = [{ conditionID: 1, weightBasisPoints: 10000 }], owner = '42', fallbackRules = []) => {
        const current = await loadPersonalPie(pool, sceneID, owner);
        return savePersonalPie(pool, { userID: owner, writeIdentity: randomUUID(), categoryID: topic.ID,
            contextValues: topic.hasScenes ? { scene: String(sceneID) } : {}, expectedRevision: current?.revision ?? 0,
            entries, fallbackRules });
    };
    const proposals = createTopicProposalService({ pool, queueForReview: async (connection, proposal) => {
        const [row] = await connection.execute('INSERT INTO moderation_logs (content, report_count, user_id) VALUES (?, 1, ?)',
            [JSON.stringify({ type: 'new_topic', proposalID: proposal.ID, name: proposal.name, description: proposal.description }), proposal.user_ID]);
        return Number(row.insertId);
    } });
    const previews = createProposalPreviewService({ db: pool, readProposal });
    let source, published;

    await t.test('owner checks, stable scene IDs, optimistic edits and atomic retries', async () => {
        source = await create('Work index');
        await savePie(source, source.defaultContextID, undefined, '42', [{ primaryConditionID: 1, mode: 'ordered', entries: [] }]);
        await savePie(source, source.scenes[1].ID, [{ conditionID: 2, weightBasisPoints: 10000 }]);
        await assert.rejects(readPrivateTopicEditor(pool, '43', { categoryID: source.ID }), rejects('private_topic_not_found'));
        await assert.rejects(savePrivateTopic(pool, '43', edit(source), randomUUID()), rejects('private_topic_not_found'));
        const request = edit(source), ids = source.scenes.map(scene => scene.ID);
        request.scenes.reverse(); request.scenes[0].name = 'Deep research'; request.defaultSceneKey = request.scenes[0].key;
        const key = randomUUID();
        const results = await Promise.all([savePrivateTopic(pool, '42', request, key), savePrivateTopic(pool, '42', request, key)]);
        assert.deepEqual(results[0], results[1]); source = results[0];
        assert.deepEqual(source.scenes.map(scene => scene.ID), ids.reverse());
        assert.equal(source.scenes[0].url, `/personal/${source.ID}/deep-research`);
        assert.equal((await loadPersonalPie(pool, source.defaultContextID, '42')).entries[0].conditionID, 2);
        await assert.rejects(savePrivateTopic(pool, '42', request, randomUUID()), rejects('private_topic_changed'));
        const before = await readPrivateTopicEditor(pool, '42', { categoryID: source.ID });
        await assert.rejects(savePrivateTopic(pool, '42', { ...edit(source), name: 'Should roll back',
            scenes: [...edit(source).scenes, { key: 'foreign', ID: 9999, name: 'Foreign' }] }, randomUUID()), rejects('topic_scene_not_found'));
        assert.deepEqual(await readPrivateTopicEditor(pool, '42', { categoryID: source.ID }), before);
    });

    await t.test('root proposals require owned, configured private sources and freeze every scene', async () => {
        await assert.rejects(proposals.propose('42', { name: 'Text only', description: 'Missing configuration.' }, randomUUID()), rejects('private_topic_source_required'));
        await assert.rejects(proposals.propose('43', { sourceTopicID: source.ID }, randomUUID()), error => error.status === 404);
        const empty = await create('Empty source');
        await assert.rejects(proposals.propose('42', { sourceTopicID: empty.ID }, randomUUID()), rejects('proposal_topic_empty'));
        published = await proposals.propose('42', { sourceTopicID: source.ID }, randomUUID());
        assert.equal(published.hasSnapshot, true); assert.equal(published.sourceTopicID, source.ID);
        const guest = await previews.read(null, { proposalID: published.proposalID });
        assert.equal(guest.proposal.sourceTopicID, undefined);
        assert.equal(guest.snapshot.scenes.length, 2);
        assert.deepEqual(guest.snapshot.scenes[1].fallbackRules[0].entries, [], 'Explicit No fallback survives publication');
        assert.equal(guest.snapshot.scenes[0].entries[0].conditionID, 2);
        await savePie(source, source.defaultContextID, [{ conditionID: 1, weightBasisPoints: 10000 }]);
        assert.deepEqual((await previews.read(null, { proposalID: published.proposalID })).snapshot, guest.snapshot);
    });

    await t.test('replacement resets votes and revision but preserves collection deadline; unchanged snapshots are no-ops', async () => {
        await proposals.support('43', { proposalID: published.proposalID, revision: 1 }, randomUUID());
        const replacement = { proposalID: published.proposalID, revision: 1, sourceTopicID: source.ID };
        published = await proposals.edit('42', replacement, randomUUID());
        assert.equal(published.revision, 2); assert.equal(published.supportCount, 0);
        await assert.rejects(previews.read(null, { proposalID: published.proposalID, revision: 1 }), rejects('topic_proposal_changed'));
        const noop = await proposals.edit('42', { ...replacement, revision: 2 }, randomUUID());
        assert.equal(noop.revision, 2); assert.equal(noop.expiresAt, published.expiresAt);
        assert.equal((await loadTopicProposalSnapshot(pool, published.proposalID, 1)).snapshot.scenes[0].entries[0].conditionID, 2);
    });

    await t.test('trial rankings are real, read-only, and copying creates independent private weights for every scene', async () => {
        const counts = async () => {
            const result = {};
            for (const table of ['categories', 'personal_pies', 'personal_pie_weights', 'topic_proposal_votes', 'write_requests']) {
                const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM ' + table); result[table] = Number(row.n);
            }
            return result;
        };
        const before = await counts();
        const preview = await previews.preview(null, { proposalID: published.proposalID, revision: 2 });
        assert.equal(preview.models.length, 3); assert.equal(preview.models[0].modelName, 'Model 1');
        assert.deepEqual(await counts(), before);
        await assert.rejects(previews.preview(null, { proposalID: published.proposalID, entries: [{ conditionID: 3, weightBasisPoints: 10000 }] }), rejects('invalid_proposal_trial_entries'));
        const key = randomUUID(), request = { proposalID: published.proposalID, revision: 2, name: 'My copy' };
        const copy = await previews.copy('43', request, key);
        assert.deepEqual(await previews.copy('43', request, key), copy);
        const topic = await getTopic(pool, '43', copy.categoryID);
        assert.equal(topic.scenes.length, 2);
        for (const scene of topic.scenes) assert.equal((await loadPersonalPie(pool, scene.ID, '43')).entries[0].conditionID, 1);
        assert.equal((await loadPersonalPie(pool, topic.scenes[1].ID, '43')).fallbackRules.length, 1);
        assert.equal((await readProposal(pool, published.proposalID, '43')).supported, false);
    });

    await t.test('deleted originals leave snapshots usable and release names, while removed scene references stay unavailable', async () => {
        const target = await create('Removable target');
        const removed = target.scenes[1].ID;
        const request = { ...edit(target), scenes: [edit(target).scenes[0]] };
        await savePrivateTopic(pool, '42', request, randomUUID());
        assert.equal((await loadTopicReferenceTargets(pool, '42')).some(item => item.contextID === removed), false);
        assert.equal((await pool.execute('SELECT ID FROM ranking_contexts WHERE ID = ?', [removed]))[0].length, 1);
        const deleting = { categoryID: source.ID, expectedRevision: source.editRevision }, key = randomUUID();
        await deletePrivateTopic(pool, '42', deleting, key);
        assert.deepEqual(await deletePrivateTopic(pool, '42', deleting, key), { categoryID: source.ID, deleted: true });
        await assert.rejects(readPrivateTopicEditor(pool, '42', { categoryID: source.ID }), rejects('private_topic_not_found'));
        const recreated = await create('Work index'); assert.notEqual(recreated.ID, source.ID);
        assert.equal((await previews.preview(null, { proposalID: published.proposalID, revision: 2 })).models.length, 3);
    });

    await t.test('removing all scenes keeps only the current default configuration; private references cannot be published', async () => {
        let topic = await create('Default retention');
        await savePie(topic); await savePie(topic, topic.scenes[1].ID, [{ conditionID: 2, weightBasisPoints: 10000 }]);
        const retained = topic.scenes[1].ID;
        topic = await savePrivateTopic(pool, '42', { ...edit(topic), defaultSceneKey: 's' + retained }, randomUUID());
        topic = await savePrivateTopic(pool, '42', { ...edit(topic), scenes: [], defaultSceneKey: null }, randomUUID());
        assert.equal(topic.defaultContextID, retained); assert.equal(topic.hasScenes, false);
        assert.equal((await loadPersonalPie(pool, retained, '42')).entries[0].conditionID, 2);
        const referencing = await create('Private reference', '43', false);
        const ownTarget = await create('Own private target', '43', false); await savePie(ownTarget, ownTarget.defaultContextID, undefined, '43');
        await savePie(referencing, referencing.defaultContextID, [{ conditionID: -ownTarget.defaultContextID, weightBasisPoints: 10000 }], '43');
        await assert.rejects(captureTopicSnapshot(pool, '43', referencing.ID), rejects('proposal_private_or_unavailable_reference'));
    });

    await t.test('thirty other supporters enter review and the actual approval handler imports the frozen scenes with one contributor', async () => {
        for (let i = 0; i < 30; i++) published = await proposals.support(String(1000 + i), { proposalID: published.proposalID, revision: 2 }, randomUUID());
        assert.equal(published.status, 'pending');
        const sourceText = await readFile(new URL('../server.js', import.meta.url), 'utf8');
        const context = vm.createContext({ crypto, mysql, TOPIC_SCENE_SQL_PREVIEW, canonicalAccountID, assertPublicTopicAvailable,
            lockTopicReferences, lockTopicProposalForReview, loadTopicProposalSnapshot, seedSnapshotTopic, finishTopicProposalReview,
            normalizeStoredModerationContent: content => content });
        const start = sourceText.indexOf('async function createPublicTopicFromSubmission(');
        const end = sourceText.indexOf("    if (content.type === 'score_field'", start);
        vm.runInContext(sourceText.slice(start, end) + '\n}', context);
        const previewStart = sourceText.indexOf('async function buildExecutedModerationSQLPreview(');
        vm.runInContext(sourceText.slice(previewStart, sourceText.indexOf('\nfunction moderationTimestamp(', previewStart)), context);
        const connection = await pool.getConnection();
        try {
            const [[before]] = await connection.query('SELECT COUNT(*) AS n FROM categories');
            await connection.query('SET TRANSACTION READ ONLY');
            await connection.beginTransaction();
            const content = { type: 'new_topic', proposalID: published.proposalID, name: published.name, description: published.description };
            const sql = await context.buildExecutedModerationSQLPreview(connection, published.submissionID, content, false, '42');
            assert.match(sql, /INSERT INTO topic_scenes/);
            assert.match(sql, /INSERT INTO personal_pie_weights/);
            assert.match(sql, /INSERT INTO personal_pie_score_rules/);
            await assert.rejects(context.buildExecutedModerationSQLPreview(connection, published.submissionID,
                { ...content, name: 'Unapproved replacement' }, true, '42'), rejects('topic_proposal_snapshot_immutable'));
            await connection.commit();
            const [[after]] = await connection.query('SELECT COUNT(*) AS n FROM categories');
            assert.equal(after.n, before.n, 'Moderation preview never writes a category or its scenes');
            await connection.beginTransaction();
            await context.applyModerationContent(connection, { type: 'new_topic', proposalID: published.proposalID,
                name: published.name, description: published.description }, { submittedBy: '42', moderationLogID: published.submissionID });
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
        const approved = await readProposal(pool, published.proposalID, null);
        assert.equal(approved.status, 'approved');
        const topic = await getTopic(pool, null, approved.topicID);
        assert.equal(topic.isPrivate, false); assert.equal(topic.scenes.length, 2);
        for (const scene of topic.scenes) {
            const [pies] = await pool.execute('SELECT user_ID FROM personal_pies WHERE context_ID = ?', [scene.ID]);
            assert.deepEqual(pies.map(row => row.user_ID), ['42']);
            assert.equal((await loadPersonalPie(pool, scene.ID, '42')).entries[0].conditionID, 1);
        }
    });

    await t.test('ordered fallback choices are portable across publication and a private copy', async () => {
        await pool.execute(`INSERT INTO benchmark_conditions
            (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale)
            VALUES (4, 1, 'extended', 'Extended', 'higher', 1)`);
        for (let model = 1; model <= 3; model++) await pool.execute(`INSERT INTO benchmark_results
            (model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, benchmark_condition_snapshot, score_fields)
            VALUES (?, 1, 4, 75, 'https://example.test/fallback', 'vendor_official', '{}', '[]')`, [model]);
        const topic = await create('Fallback source', '43', false);
        const rule = { primaryConditionID: 1, mode: 'ordered', selectionSource: 'custom', entries: [{ conditionID: 4 }] };
        await savePie(topic, topic.defaultContextID, undefined, '43', [rule]);
        const proposal = await proposals.propose('43', { sourceTopicID: topic.ID }, randomUUID());
        const { snapshot } = await previews.read(null, { proposalID: proposal.proposalID });
        assert.deepEqual(snapshot.scenes[0].fallbackRules, [rule]);
        const copy = await previews.copy('42', { proposalID: proposal.proposalID, revision: 1, name: 'Fallback copy' }, randomUUID());
        const target = await getTopic(pool, '42', copy.categoryID);
        const [copiedRule] = (await loadPersonalPie(pool, target.defaultContextID, '42')).fallbackRules;
        assert.equal(copiedRule.selectionSource, 'custom');
        assert.deepEqual(copiedRule.entries.map(entry => entry.conditionID), [4]);
    });
});
