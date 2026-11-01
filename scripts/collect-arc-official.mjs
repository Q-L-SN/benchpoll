#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalNumber, compareCanonicalNumbers } from '../public/js/shared/score-fields.js';

export const ARC_SOURCES = Object.freeze([
    { version: 'v1', benchmark: 'ARC-AGI-1', url: 'https://arcprize.org/media/data/leaderboard/v1.json' },
    { version: 'v2', benchmark: 'ARC-AGI-2', url: 'https://arcprize.org/media/data/leaderboard/v2.json' }
]);
export const LEADERBOARD_URL = 'https://arcprize.org/leaderboard';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// Reviver source text is essential: parsing as a JS number first loses published digits.
export function parseSourceJSON(text) {
    let supported = false;
    JSON.parse('0', (key, value, context) => { supported = context?.source === '0'; return value; });
    if (!supported) throw new Error('Lossless JSON collection requires Node.js 22 or newer with reviver context.source.');
    return JSON.parse(text, (key, value, context) => typeof value === 'number' ? context.source : value);
}

export function decimalText(input, shift = 0) {
    const canonical = canonicalNumber(input);
    if (canonical === '0') return '0';
    const negative = canonical.startsWith('-');
    const [digits, exponent] = (negative ? canonical.slice(1) : canonical).split('e');
    const point = digits.length + Number(exponent) + shift;
    const unsigned = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
        : point >= digits.length ? digits + '0'.repeat(point - digits.length)
            : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return (negative ? '-' : '') + unsigned;
}

export function fractionToPercent(fraction) {
    if (typeof fraction !== 'string' || compareCanonicalNumbers(fraction, '0') < 0
        || compareCanonicalNumbers(fraction, '1') > 0) throw new Error('Invalid source score fraction.');
    return decimalText(fraction, 2);
}

export function absoluteSourceURL(value) {
    if (value === '' || value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error('Source URL must be text.');
    const url = new URL(value, LEADERBOARD_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || url.href.length > 2048) throw new Error(`Invalid source URL: ${value}`);
    return url.href;
}

export function isHumanReference(row) {
    return [row.providerId, row.providerDisplayName, row.modelGroup, row.modelType]
        .some(value => typeof value === 'string' && /^human(?:s| panel)?$/i.test(value.trim()))
        || ['2025_human_panel', 'stem_grad', 'mturker'].includes(row.modelId);
}

export function normalizeArcSource(text, definition) {
    const data = parseSourceJSON(text);
    if (data.version !== definition.version || !Array.isArray(data.datasets) || !data.datasets.length
        || !Array.isArray(data.evaluations) || !Number.isFinite(Date.parse(data.generatedAt))) {
        throw new Error(`Invalid ${definition.version} source schema.`);
    }
    const datasets = new Map();
    for (const dataset of data.datasets) {
        if (typeof dataset.id !== 'string' || !dataset.id.startsWith(`${definition.version}_`)
            || dataset.displayName !== definition.benchmark || datasets.has(dataset.id)) throw new Error('Invalid or duplicate ARC dataset.');
        datasets.set(dataset.id, { ...dataset, url: absoluteSourceURL(dataset.url) });
    }
    const entries = [], excluded = [], seen = new Map();
    for (const [index, row] of data.evaluations.entries()) {
        if (!row || typeof row.display !== 'boolean' || !datasets.has(row.datasetId)) {
            throw new Error(`Invalid evaluation/dataset at ${definition.version}/${index}.`);
        }
        if (!row.display || isHumanReference(row)) {
            excluded.push({ index, modelId: row.modelId, datasetId: row.datasetId,
                reason: !row.display ? 'display=false' : 'human reference' });
            continue;
        }
        if (!row.modelId || !row.modelDisplayName || !row.providerId || !row.providerDisplayName
            || row.datasetDisplayName !== datasets.get(row.datasetId).displayName) {
            throw new Error(`Missing source identity at ${definition.version}/${index}.`);
        }
        const baseID = `${definition.version}:${row.datasetId}:${row.modelId}`;
        const previous = seen.get(baseID) ?? [];
        const recordID = previous.length ? `${baseID}:occurrence-${previous.length + 1}` : baseID;
        const duplicateOf = previous.find(item => JSON.stringify(item.sourceRecord) === JSON.stringify(row))?.recordID ?? null;
        const sourceCollisionOf = previous.length && !duplicateOf ? previous[0].recordID : null;
        const cost = row.costPerTask == null ? null : decimalText(row.costPerTask);
        if (cost !== null && compareCanonicalNumbers(cost, '0') < 0) throw new Error('Negative source cost.');
        const entry = { recordID, duplicateOf, sourceCollisionOf, sourceIndex: index, datasetId: row.datasetId,
            modelId: row.modelId, modelName: row.modelDisplayName,
            providerId: row.providerId, providerName: row.providerDisplayName,
            modelType: row.modelType, modelGroup: row.modelGroup, modelReleaseDate: row.modelReleaseDate,
            scoreFraction: row.score, scorePercent: fractionToPercent(row.score),
            costPerTaskUSD: cost, sourceURL: absoluteSourceURL(row.resultsUrl) ?? definition.url,
            resultsURL: absoluteSourceURL(row.resultsUrl), displayLabel: row.displayLabel ?? null,
            evidencePointer: `${definition.url}#/evaluations/${index}`, sourceRecord: row };
        entries.push(entry);
        previous.push(entry);
        seen.set(baseID, previous);
    }
    return { version: definition.version, benchmark: definition.benchmark, url: definition.url,
        rawFile: `${definition.version}.json`, sha256: sha256(text), generatedAt: data.generatedAt,
        datasets: [...datasets.values()], totalEvaluations: data.evaluations.length, entries, excluded };
}

export async function fetchOfficial(url) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(45000),
                headers: { 'User-Agent': 'BenchPoll official ARC research collector' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
            if (new URL(response.url).origin !== new URL(url).origin) throw new Error('Unexpected source redirect.');
            return await response.text();
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise(resolveWait => setTimeout(resolveWait, 1000 * (attempt + 1)));
        }
    }
    throw lastError;
}

export async function collectArcOfficial(output, fetchText = fetchOfficial) {
    await mkdir(dirname(output), { recursive: true });
    const sources = [];
    for (const definition of ARC_SOURCES) {
        const text = await fetchText(definition.url);
        const source = normalizeArcSource(text, definition);
        const rawPath = resolve(dirname(output), source.rawFile);
        try { await writeFile(rawPath, text, { encoding: 'utf8', flag: 'wx' }); }
        catch (error) {
            if (error.code !== 'EEXIST' || await readFile(rawPath, 'utf8') !== text) throw error;
        }
        sources.push(source);
    }
    const snapshot = { schemaVersion: 1, publisher: 'ARC Prize', fetchedAt: new Date().toISOString(),
        leaderboardURL: LEADERBOARD_URL, policyURL: 'https://arcprize.org/policy', sources };
    await writeFile(output, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return snapshot;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !args[0].startsWith('--output=')) {
        throw new Error('Usage: node scripts/collect-arc-official.mjs --output=<snapshot.json>');
    }
    const snapshot = await collectArcOfficial(resolve(args[0].slice(9)));
    console.log(JSON.stringify({ scoreCount: snapshot.sources.reduce((sum, source) => sum + source.entries.length, 0),
        sources: snapshot.sources.map(source => ({ version: source.version, collected: source.entries.length,
            excluded: source.excluded.length, unlabelled: source.entries.filter(row => row.displayLabel === false).length })) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
