#!/usr/bin/env node

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { modelKey, huggingFaceModelID, repoMatchesModelName } from './recent-model-evidence.mjs';

const CUTOFF = '2026-08-01';
const CATALOG_URL = 'https://models.dev/models.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const HF_API_URL = 'https://huggingface.co/api/models/';
const planOutput = process.argv.find(arg => arg.startsWith('--plan-output='))?.slice(14);

function digestRows(rows, serialize) {
    const hash = crypto.createHash('sha256');
    for (const row of rows) hash.update(`${serialize(row)}\n`);
    return hash.digest('hex');
}

async function fetchHuggingFaceDates(models) {
    const candidates = models.map(model => ({ ID: Number(model.ID), name: model.name,
        repoID: huggingFaceModelID(model.introduction_url) }))
        .filter(row => row.repoID && repoMatchesModelName(row.name, row.repoID));
    const dates = new Map();
    const failures = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
        while (cursor < candidates.length) {
            const candidate = candidates[cursor++];
            try {
                const response = await fetch(`${HF_API_URL}${candidate.repoID}?expand=createdAt&expand=lastModified`,
                    { signal: AbortSignal.timeout(20000) });
                if (!response.ok) {
                    failures.push({ ...candidate, status: response.status });
                    continue;
                }
                const details = await response.json();
                if (String(details.id ?? '').toLowerCase() !== candidate.repoID.toLowerCase()
                    || !/^\d{4}-\d{2}-\d{2}T/.test(details.createdAt ?? '')
                    || !/^\d{4}-\d{2}-\d{2}T/.test(details.lastModified ?? '')) {
                    failures.push({ ...candidate, status: 'invalid_response' });
                    continue;
                }
                dates.set(candidate.ID, { created: details.createdAt.slice(0, 10),
                    lastModified: details.lastModified.slice(0, 10), repoID: candidate.repoID });
            } catch (error) {
                failures.push({ ...candidate, status: error.message });
            }
        }
    }));
    return { dates, candidates: candidates.length, failures };
}

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined && !process.env.BENCHPOLL_DB_SOCKET) {
        throw new Error('Database credentials are unavailable.');
    }
    return {
        socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks'
    };
}

const [catalogResponse, openRouterResponse] = await Promise.all([
    fetch(CATALOG_URL, { signal: AbortSignal.timeout(30000) }),
    fetch(OPENROUTER_URL, { signal: AbortSignal.timeout(30000) })
]);
if (!catalogResponse.ok) throw new Error(`Model catalog returned HTTP ${catalogResponse.status}.`);
if (!openRouterResponse.ok) throw new Error(`OpenRouter returned HTTP ${openRouterResponse.status}.`);
const catalog = await catalogResponse.json();
const openRouter = await openRouterResponse.json();
const byName = new Map();
for (const item of Object.values(catalog)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.release_date ?? '')) continue;
    const nameKey = modelKey(item.name);
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(item);
}
const openRouterByName = new Map();
for (const item of openRouter.data ?? []) {
    const nameKey = modelKey(item.name);
    if (!openRouterByName.has(nameKey)) openRouterByName.set(nameKey, []);
    openRouterByName.get(nameKey).push(item);
}

const connection = await mysql.createConnection(databaseConfig());
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [models] = await connection.query(`SELECT m.ID, m.name, m.introduction_url,
            m.is_active, o.name AS vendor
        FROM models m JOIN organizations o ON o.ID = m.vendor_ID`);
    const [conditions] = await connection.query(`SELECT c.ID, c.benchmark_ID, c.name, b.name AS benchmark_name
        FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID
        WHERE c.deleted_at IS NULL AND b.is_active = 1`);
    const [scores] = await connection.query(`SELECT r.ID, r.benchmark_condition_ID, r.model_ID
        FROM benchmark_results r WHERE r.status = 'accepted'`);
    const [protectedRows] = await connection.query(`SELECT benchmark_condition_ID AS ID FROM personal_pie_weights
        UNION SELECT fallback_benchmark_condition_ID AS ID FROM personal_pie_score_rule_components
        UNION SELECT condition_ID AS ID FROM discussion_mentions WHERE condition_ID IS NOT NULL`);
    const protectedIDs = new Set(protectedRows.map(row => Number(row.ID)));
    const releaseDates = new Map();
    const provenOld = new Set();
    const evidence = new Map();
    const matchedModels = [];
    const ambiguousModels = [];
    const openRouterOldModels = [];
    for (const model of models) {
        const matches = byName.get(modelKey(model.name)) ?? [];
        const dates = [...new Set(matches.map(item => item.release_date))];
        if (dates.length === 1) {
            releaseDates.set(Number(model.ID), dates[0]);
            evidence.set(Number(model.ID), { kind: 'release_date', date: dates[0],
                source: `${CATALOG_URL}#${matches[0].id}` });
            matchedModels.push({ ID: model.ID, name: model.name, releaseDate: dates[0],
                sources: matches.map(item => item.id) });
        } else if (dates.length > 1) {
            ambiguousModels.push({ ID: model.ID, name: model.name,
                candidates: matches.map(item => ({ id: item.id, releaseDate: item.release_date })) });
        }
        if (!releaseDates.has(Number(model.ID))) {
            const listings = openRouterByName.get(modelKey(model.name)) ?? [];
            if (listings.some(item => Number.isFinite(Number(item.created))
                && new Date(Number(item.created) * 1000).toISOString().slice(0, 10) < CUTOFF)) {
                provenOld.add(Number(model.ID));
                const oldListing = listings.find(item => Number.isFinite(Number(item.created))
                    && new Date(Number(item.created) * 1000).toISOString().slice(0, 10) < CUTOFF);
                evidence.set(Number(model.ID), { kind: 'openrouter_listing',
                    date: new Date(Number(oldListing.created) * 1000).toISOString().slice(0, 10),
                    source: `${OPENROUTER_URL}#${oldListing.id}` });
                openRouterOldModels.push({ ID: model.ID, name: model.name,
                    listings: listings.map(item => ({ id: item.id, created: item.created })) });
            }
        }
    }
    const scoredModelIDs = new Set(scores.map(row => Number(row.model_ID)));
    const hf = await fetchHuggingFaceDates(models.filter(model => scoredModelIDs.has(Number(model.ID))
        && !releaseDates.has(Number(model.ID)) && !provenOld.has(Number(model.ID))));
    const hfOldModels = [];
    for (const [id, details] of hf.dates) {
        if (details.created < CUTOFF && details.lastModified < CUTOFF) {
            provenOld.add(id);
            evidence.set(id, { kind: 'huggingface_unchanged_repository',
                date: details.lastModified, created: details.created,
                source: `${HF_API_URL}${details.repoID}` });
            hfOldModels.push({ ID: id, ...details });
        }
    }
    const modelsByID = new Map(models.map(row => [Number(row.ID), row]));
    const scoredByCondition = new Map();
    for (const score of scores) {
        const conditionID = Number(score.benchmark_condition_ID);
        if (!scoredByCondition.has(conditionID)) scoredByCondition.set(conditionID, new Set());
        scoredByCondition.get(conditionID).add(Number(score.model_ID));
    }
    const groups = { recent: [], uncertain: [], oldOnly: [], noScores: [] };
    for (const condition of conditions) {
        const scoredModelIDs = [...(scoredByCondition.get(Number(condition.ID)) ?? [])];
        const recent = scoredModelIDs.filter(id => releaseDates.get(id) >= CUTOFF);
        const unknown = scoredModelIDs.filter(id => !releaseDates.has(id) && !provenOld.has(id));
        const item = { ID: condition.ID, benchmarkID: condition.benchmark_ID,
            benchmark: condition.benchmark_name, condition: condition.name,
            scoredModels: scoredModelIDs.length, recentModels: recent.length,
            unknownModels: unknown.length, protected: protectedIDs.has(Number(condition.ID)) };
        if (recent.length) groups.recent.push(item);
        else if (unknown.length) groups.uncertain.push(item);
        else if (scoredModelIDs.length) groups.oldOnly.push(item);
        else groups.noScores.push(item);
    }
    if (planOutput) {
        const candidates = groups.oldOnly.filter(row => !row.protected)
            .map(row => ({ ID: Number(row.ID), benchmarkID: Number(row.benchmarkID),
                scoredModels: row.scoredModels })).sort((a, b) => a.ID - b.ID);
        const candidateIDs = new Set(candidates.map(row => row.ID));
        const candidateResults = scores.filter(row => candidateIDs.has(Number(row.benchmark_condition_ID)))
            .sort((a, b) => Number(a.ID) - Number(b.ID));
        const conditionsByBenchmark = new Map();
        for (const condition of conditions) {
            const id = Number(condition.benchmark_ID);
            if (!conditionsByBenchmark.has(id)) conditionsByBenchmark.set(id, []);
            conditionsByBenchmark.get(id).push(Number(condition.ID));
        }
        const benchmarkIDs = [...conditionsByBenchmark]
            .filter(([, ids]) => ids.every(id => candidateIDs.has(id)))
            .map(([id]) => id).sort((a, b) => a - b);
        const scoredCandidateModelIDs = [...new Set(candidateResults.map(row => Number(row.model_ID)))].sort((a, b) => a - b);
        if (scoredCandidateModelIDs.some(id => !evidence.has(id)
            || evidence.get(id).date >= CUTOFF)) {
            throw new Error('An archive candidate contains an unverified or recent model.');
        }
        const plan = {
            batchID: 'recent-model-archive-2026-09-27', cutoff: CUTOFF,
            generatedAt: new Date().toISOString(),
            sourceURLs: [CATALOG_URL, OPENROUTER_URL, HF_API_URL],
            conditionCount: conditions.length,
            conditionDigest: digestRows(conditions
                .map(row => ({ ID: Number(row.ID), benchmarkID: Number(row.benchmark_ID) }))
                .sort((a, b) => a.ID - b.ID), row => `${row.ID}:${row.benchmarkID}`),
            candidates, benchmarkIDs, resultCount: candidateResults.length,
            resultDigest: digestRows(candidateResults,
                row => `${row.ID}:${row.benchmark_condition_ID}:${row.model_ID}`),
            modelEvidence: scoredCandidateModelIDs.map(id => ({ ID: id,
                name: modelsByID.get(id)?.name, ...evidence.get(id) }))
        };
        await fs.writeFile(planOutput, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
        console.error(`Archive plan written to ${planOutput}: ${candidates.length} conditions, `
            + `${benchmarkIDs.length} benchmarks, ${candidateResults.length} accepted results.`);
    }
    const summary = { cutoff: CUTOFF, catalogURL: CATALOG_URL,
        openRouterURL: OPENROUTER_URL, huggingFaceAPI: HF_API_URL,
        models: models.length, activeModels: models.filter(row => Number(row.is_active) === 1).length,
        matchedModels: matchedModels.length, openRouterProvenOldModels: openRouterOldModels.length,
        huggingFaceCandidates: hf.candidates, huggingFaceDated: hf.dates.size,
        huggingFaceProvenOldModels: hfOldModels.length,
        huggingFaceFailures: hf.failures.slice(0, 30), huggingFaceFailureCount: hf.failures.length,
        recentMatchedModels: matchedModels.filter(row => row.releaseDate >= CUTOFF).length,
        ambiguousModels: ambiguousModels.length,
        unknownModels: models.length - matchedModels.length - provenOld.size,
        conditions: conditions.length, protectedConditions: protectedIDs.size,
        groups: Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, {
            total: rows.length, protected: rows.filter(row => row.protected).length,
            comparable: rows.filter(row => row.scoredModels >= 3).length,
            examples: rows.filter(row => !row.protected).sort((a, b) => b.scoredModels - a.scoredModels).slice(0, 12)
        }])),
        highCoverageRecentModels: matchedModels.filter(row => row.releaseDate >= CUTOFF)
            .map(row => ({ ...row, conditions: scores.filter(score => Number(score.model_ID) === Number(row.ID)).length }))
            .sort((a, b) => b.conditions - a.conditions).slice(0, 50),
        ambiguousExamples: ambiguousModels.slice(0, 20),
        highCoverageUnknownModels: [...new Set(scores.map(row => Number(row.model_ID)))]
            .filter(id => !releaseDates.has(id) && !provenOld.has(id))
            .map(id => ({ ID: id, name: modelsByID.get(id)?.name,
                conditions: scores.filter(score => Number(score.model_ID) === id).length }))
            .sort((a, b) => b.conditions - a.conditions).slice(0, 50),
        uncertainScoredModelExamples: [...new Set(groups.uncertain.flatMap(row =>
            [...(scoredByCondition.get(Number(row.ID)) ?? [])]
                .filter(id => !releaseDates.has(id) && !provenOld.has(id))))]
            .map(id => ({ ID: id, name: modelsByID.get(id)?.name }))
            .slice(0, 40)
    };
    console.log(JSON.stringify(summary, null, 2));
    await connection.commit();
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    await connection.end();
}
