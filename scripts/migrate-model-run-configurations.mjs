import 'dotenv/config';
import mysql from 'mysql2/promise';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { arenaCanonicalModelName } from '../arena-import-plan.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { mergeRunConfigurationFields, modelRunConfiguration, resolveModelRunMappings, runConfigurationFields } from '../model-run-configuration.js';

const apply = process.argv.includes('--apply');
const resolutionIndex = process.argv.indexOf('--identity-resolutions');
const resolutions = resolutionIndex === -1 ? [] : JSON.parse(await readFile(process.argv[resolutionIndex + 1], 'utf8'));
if (!Array.isArray(resolutions)) throw new Error('Identity resolutions must be an explicit list');
const configurationIndex = process.argv.indexOf('--configuration-resolutions');
const configurationResolutions = configurationIndex === -1 ? [] : JSON.parse(await readFile(process.argv[configurationIndex + 1], 'utf8'));
if (!Array.isArray(configurationResolutions) || new Set(configurationResolutions.map(item => item.scoreID)).size !== configurationResolutions.length) {
    throw new Error('Configuration resolutions must be an explicit unique score list');
}
if (apply && !process.argv.includes('--backup-confirmed')) throw new Error('Verified database backup required');
const output = resolve(process.env.BENCHPOLL_RUN_CONFIG_OUTPUT || 'artifacts/arena-workspace-20261003/model-configurations');
await mkdir(output, { recursive: true });
const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4', dateStrings: true, timezone: 'Z' });
let locked = false;
try {
    const [[{ acquired }]] = await db.query("SELECT GET_LOCK('benchpoll_arena_latest_import',30) AS acquired");
    if (Number(acquired) !== 1) throw new Error('Arena import lock unavailable');
    locked = true;
    await db.beginTransaction();
    const [models] = await db.query(`SELECT m.*,o.slug AS vendorSlug FROM models m
        JOIN organizations o ON o.ID=m.vendor_ID ORDER BY m.ID FOR UPDATE`);
    const definitions = await loadScoreFieldCatalog(db, null, true);
    let mappings = [];
    const originalNames = new Map(models.map(model => [model.ID, model.name]));
    for (const resolution of resolutions) {
        const from = models.find(model => model.ID === resolution.fromID);
        const target = models.find(model => model.ID === resolution.toID);
        if (!from || !target || from === target || from.vendor_ID !== target.vendor_ID || from.vendorSlug !== resolution.vendorSlug
            || from.name !== resolution.fromName || target.name !== resolution.toName || !target.is_active
            || arenaCanonicalModelName(from.name) !== arenaCanonicalModelName(target.name)) throw new Error('Stale or invalid explicit model identity resolution');
        if (!from.is_active) {
            const [[remaining]] = await db.execute('SELECT COUNT(*) count FROM benchmark_results WHERE model_ID=?', [from.ID]);
            if (Number(remaining.count)) throw new Error('Previously merged model still has score references');
            continue;
        }
        mappings.push({ fromID: from.ID, toID: target.ID, oldName: from.name, baseName: target.name,
            fields: [], evidenceURL: resolution.evidenceURL });
        from.is_active = 0;
    }
    for (const model of models) {
        if (!model.is_active) continue;
        const run = modelRunConfiguration(model.name, model.vendorSlug);
        if (!Object.keys(run.configuration).length && run.baseName === model.name) continue;
        let candidates = models.filter(candidate => candidate.is_active && candidate.ID !== model.ID && candidate.vendor_ID === model.vendor_ID
            && arenaCanonicalModelName(candidate.name) === arenaCanonicalModelName(run.baseName));
        if (candidates.length > 1) {
            candidates = candidates.filter(candidate => candidate.name.toLowerCase() === run.baseName.toLowerCase());
            if (candidates.length !== 1) throw new Error(`Ambiguous base model for ${model.name}`);
        }
        const target = candidates[0] || model;
        const fields = runConfigurationFields(run.configuration, definitions);
        mappings.push({ fromID: model.ID, toID: target.ID, oldName: originalNames.get(model.ID), baseName: run.baseName, fields });
        if (target === model) model.name = run.baseName;
    }
    mappings = resolveModelRunMappings(mappings, definitions);
    const scoreChanges = [];
    const resolvedScores = new Set();
    const verifyConfigurationResolution = (score, resolution) => {
        const existing = typeof score.score_fields === 'string' ? JSON.parse(score.score_fields) : score.score_fields;
        const notes = typeof score.notes === 'string' ? JSON.parse(score.notes) : score.notes;
        if (existing.find(field => field.fieldID === resolution.fieldID)?.value !== resolution.existingValue
            || score.source_URL !== resolution.sourceURL || notes?.post_astra_import?.nativeID !== resolution.nativeID) {
            throw new Error(`Stale score configuration resolution: ${score.ID}`);
        }
        return existing;
    };
    for (const mapping of mappings) {
        const [scores] = await db.execute('SELECT ID,score_fields,source_URL,notes FROM benchmark_results WHERE model_ID=? FOR UPDATE', [mapping.fromID]);
        for (const score of scores) {
            const existing = typeof score.score_fields === 'string' ? JSON.parse(score.score_fields) : score.score_fields;
            const resolution = configurationResolutions.find(item => item.scoreID === score.ID);
            let inferred = mapping.fields;
            if (resolution) {
                verifyConfigurationResolution(score, resolution);
                if (mapping.fromID !== resolution.modelID || mapping.toID !== resolution.canonicalModelID
                    || inferred.find(field => field.fieldID === resolution.fieldID)?.value !== resolution.inferredValue) {
                    throw new Error(`Stale model configuration resolution: ${score.ID}`);
                }
                inferred = inferred.filter(field => field.fieldID !== resolution.fieldID);
                resolvedScores.add(score.ID);
            }
            let fields;
            try { fields = mergeRunConfigurationFields(existing, inferred, definitions); }
            catch (error) { throw new Error(`Score ${score.ID}, model ${mapping.oldName}: ${error.message}`, { cause: error }); }
            scoreChanges.push({ ID: score.ID, modelID: mapping.toID, fields });
        }
        mapping.scoreCount = scores.length;
    }
    for (const resolution of configurationResolutions) {
        if (resolvedScores.has(resolution.scoreID)) continue;
        const [[score]] = await db.execute('SELECT ID,model_ID,score_fields,source_URL,notes FROM benchmark_results WHERE ID=? FOR UPDATE', [resolution.scoreID]);
        if (!score || score.model_ID !== resolution.canonicalModelID) throw new Error(`Unmatched score configuration resolution: ${resolution.scoreID}`);
        verifyConfigurationResolution(score, resolution);
    }
    const [profiles] = await db.query('SELECT user_ID,profile_key,comparison FROM user_comparison_profiles FOR UPDATE');
    const profileChanges = [];
    for (const profile of profiles) {
        const comparison = typeof profile.comparison === 'string' ? JSON.parse(profile.comparison) : structuredClone(profile.comparison);
        let changed = false;
        for (const filter of comparison.filters) {
            if (filter.key !== 'model' || filter.operator !== 'eq') continue;
            const mapping = mappings.find(item => item.fromID === filter.value);
            if (!mapping) continue;
            filter.value = mapping.toID;
            for (const assignment of mapping.fields) {
                const key = `field:${assignment.fieldID}`;
                const old = comparison.filters.find(item => item.key === key);
                if (old && (old.operator !== 'eq' || old.value !== assignment.value)) throw new Error('Saved comparison profile conflicts with model run configuration');
                if (!old) comparison.filters.push({ key, operator: 'eq', value: assignment.value });
            }
            changed = true;
        }
        if (changed) profileChanges.push({ ...profile, comparison });
    }
    const summary = { apply, modelMappings: mappings, scoreCount: scoreChanges.length, profileCount: profileChanges.length,
        reviewedConfigurationResolutions: [...resolvedScores] };
    await writeFile(resolve(output, 'plan.json'), JSON.stringify(summary, null, 2));
    if (apply) {
        const [[before]] = await db.query('SELECT COUNT(*) count,SUM(raw_score) scoreSum FROM benchmark_results');
        for (const mapping of mappings) {
            if (mapping.fromID === mapping.toID) await db.execute('UPDATE models SET name=? WHERE ID=?', [mapping.baseName, mapping.fromID]);
        }
        const groups = new Map();
        for (const score of scoreChanges) {
            const key = JSON.stringify([score.modelID, score.fields]);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(score.ID);
        }
        for (const [key, IDs] of groups) {
            const [modelID, fields] = JSON.parse(key);
            for (let offset = 0; offset < IDs.length; offset += 500) await db.query(
                'UPDATE benchmark_results SET model_ID=?,score_fields=? WHERE ID IN (?)',
                [modelID, JSON.stringify(fields), IDs.slice(offset, offset + 500)]);
        }
        for (const mapping of mappings) {
            if (mapping.fromID !== mapping.toID) await db.execute('UPDATE models SET is_active=0 WHERE ID=?', [mapping.fromID]);
        }
        for (const profile of profileChanges) await db.execute('UPDATE user_comparison_profiles SET comparison=? WHERE user_ID=? AND profile_key=?',
            [JSON.stringify(profile.comparison), profile.user_ID, profile.profile_key]);
        const [[after]] = await db.query('SELECT COUNT(*) count,SUM(raw_score) scoreSum FROM benchmark_results');
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Model normalization changed raw scores or removed results');
        await db.commit();
    } else await db.rollback();
    console.log(JSON.stringify({ apply, models: mappings.length, scores: scoreChanges.length, profiles: profileChanges.length, report: resolve(output, 'plan.json') }));
} catch (error) { await db.rollback(); throw error; }
finally {
    if (locked) await db.query("SELECT RELEASE_LOCK('benchpoll_arena_latest_import')");
    await db.end();
}
