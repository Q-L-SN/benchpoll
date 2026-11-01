#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { chromium } from 'playwright';

const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output || process.argv.slice(2).some(arg => !arg.startsWith('--output='))) {
    throw new Error('Usage: node scripts/collect-top16-official.mjs --output=<snapshot.json>');
}

async function fetchText(url) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await fetch(url, { headers: { 'User-Agent': 'BenchPoll research collector' } });
            if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
            return response.text();
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
    throw lastError;
}

function source(key, url, entries, details = {}) {
    if (!entries.length) throw new Error(`${key} has no scores.`);
    for (const row of entries) {
        if (!row.recordID || !row.modelName || !Number.isFinite(row.score)
            || row.score < 0 || row.score > 100 || !row.metric) {
            throw new Error(`Invalid ${key} score: ${JSON.stringify(row)}`);
        }
    }
    console.error(`${key}: ${entries.length} scores`);
    return { key, url, ...details, entries };
}

const sources = [];

const arcURL = 'https://arcprize.org/media/data/leaderboard/v3.json';
const arc = JSON.parse(await fetchText(arcURL));
if (arc.version !== 'v3' || arc.datasets.length !== 1
    || arc.datasets[0].id !== 'v3_Semi_Private' || !Array.isArray(arc.evaluations)) {
    throw new Error('Unexpected ARC-AGI-3 leaderboard version or dataset.');
}
sources.push(source('arc-agi-3', 'https://arcprize.org/leaderboard',
    arc.evaluations.filter(row => row.datasetId === 'v3_Semi_Private' && row.display).map(row => {
        const effort = row.modelId.match(/-(max|xhigh|high|medium|low|none)(?:-effort)?(?:-provider-adapter)?$/)?.[1] ?? null;
        return {
            recordID: row.modelId, modelName: row.modelDisplayName,
            modelSlug: row.modelId, provider: row.providerDisplayName,
            score: row.score * 100, metric: 'semi-private-v3',
            config: { harness: row.modelId.endsWith('-provider-adapter') ? 'Provider Adapter' : 'Standard',
                reasoningEffort: effort,
                reasoningMode: /reasoning/i.test(row.modelDisplayName) ? 'enabled' : null }
        };
    }), { generatedAt: arc.generatedAt, dataURL: arcURL }));

const deepURL = 'https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json';
const deep = JSON.parse(await fetchText(deepURL));
if (deep.n_tasks_in_set !== 113 || !Array.isArray(deep.rows)) {
    throw new Error('Unexpected DeepSWE v1.1 feed.');
}
const deepEntries = [];
for (const row of deep.rows) {
    for (const [field, metric] of [['pass_at_1', 'v1.1-pass-at-1'], ['pass_at_4', 'v1.1-pass-at-4']]) {
        if (row[field] === null || row[field] === undefined) continue;
        deepEntries.push({
            recordID: `${row.config}:${field}`, modelName: row.model,
            modelSlug: row.model, provider: row.provider || null,
            score: row[field] * 100, metric,
            config: { harness: row.harness, reasoningEffort: row.reasoning_effort || null }
        });
    }
}
sources.push(source('deepswe-v1.1', 'https://deepswe.datacurve.ai/', deepEntries,
    { generatedAt: deep.generated_at, dataURL: deepURL, taskCount: deep.n_tasks_in_set }));

const spatialJSURL = 'https://wangst0181.github.io/SpatialViz-Bench/assets/main.js';
const spatialAST = parse(await fetchText(spatialJSURL), { ecmaVersion: 'latest', sourceType: 'script' });
const spatialDeclaration = spatialAST.body.flatMap(node => node.type === 'VariableDeclaration'
    ? node.declarations : []).find(node => node.id.name === 'leaderboard');
if (spatialDeclaration?.init?.type !== 'ArrayExpression') {
    throw new Error('SpatialViz leaderboard is no longer a literal array.');
}
const spatialEntries = [];
for (const [index, node] of spatialDeclaration.init.elements.entries()) {
    if (node?.type !== 'ObjectExpression') throw new Error('Unexpected SpatialViz row.');
    const row = Object.fromEntries(node.properties.map(property => {
        if (property.type !== 'Property' || property.value.type !== 'Literal') {
            throw new Error('Unexpected SpatialViz score expression.');
        }
        return [property.key.name ?? property.key.value, property.value.value];
    }));
    for (const metric of ['direct', 'cot', 'overall']) {
        if (typeof row[metric] !== 'number') continue;
        spatialEntries.push({ recordID: `${index}:${row.model}:${metric}`,
            modelName: row.model, modelSlug: null, provider: null,
            score: row[metric], metric, config: {} });
    }
}
sources.push(source('spatialviz', 'https://wangst0181.github.io/SpatialViz-Bench/',
    spatialEntries, { dataURL: spatialJSURL }));

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const aleURL = 'https://agents-last-exam.org/leaderboard';
    await page.goto(aleURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('tbody tr', { timeout: 30000 });
    const aleRows = await page.evaluate(() => [...document.querySelectorAll('tbody tr')]
        .map(row => ({ cells: [...row.querySelectorAll('td')].map((cell, index) => index === 2
            ? cell.querySelector('span.font-mono')?.textContent.trim() ?? cell.innerText.trim()
            : cell.innerText.trim()),
            select: row.querySelector('select')?.getAttribute('aria-label') ?? null,
            efforts: [...(row.querySelector('select')?.options ?? [])].map(option => option.value) })));
    const aleEntries = [];
    function addAleRows(cells, effort, recordID) {
        if (cells[2] === 'Best per task') return;
        for (const [index, metric] of [[4, 'ale-v1-pass-rate'], [5, 'ale-v1-partial-score']]) {
            const match = cells[index]?.match(/^([\d.]+)%$/);
            if (!match) throw new Error(`Unexpected ALE score ${cells[index]}.`);
            aleEntries.push({ recordID: `${recordID}:${metric}`, modelName: cells[2],
                modelSlug: cells[2], provider: null, score: Number(match[1]), metric,
                config: { harness: cells[1] === '—' ? null : cells[1],
                    reasoningEffort: effort === '—' || effort === '-' ? null : effort.toLowerCase() } });
        }
    }
    for (const [index, row] of aleRows.entries()) {
        if (!row.select) {
            addAleRows(row.cells, row.cells[3], `row-${index}`);
            continue;
        }
        for (const effort of row.efforts) {
            const selected = page.getByLabel(row.select);
            await selected.selectOption(effort);
            const cells = await selected.evaluate(element => [...element.closest('tr').querySelectorAll('td')]
                .map((cell, index) => index === 2
                    ? cell.querySelector('span.font-mono')?.textContent.trim() ?? cell.innerText.trim()
                    : cell.innerText.trim()));
            addAleRows(cells, effort, `row-${index}:${effort}`);
        }
    }
    sources.push(source('agents-last-exam', aleURL, aleEntries));

    const scaleURL = 'https://labs.scale.com/leaderboard/swe_bench_pro';
    await page.goto(scaleURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('p[data-model-name]', { timeout: 30000 });
    const subset = 'Public';
    const entries = await page.evaluate(subsetName => [...document.querySelectorAll('[role="tabpanel"][data-state="active"] p[data-model-name]')]
            .map((element, index) => {
                const name = element.innerText.trim();
                const score = Number(element.parentElement.querySelector('p.ml-auto span')?.innerText);
                return { recordID: `${subsetName}:${index}:${name}`, modelName: name.replace(/\*$/, ''),
                    modelSlug: null, provider: null, score,
                    metric: `v1-${subsetName.toLowerCase()}-resolve-rate`,
                    config: { harness: name.endsWith('*') ? 'mini-swe-agent' : null,
                        reasoningEffort: name.match(/\((xhigh|high|medium|low|max)\)/i)?.[1]?.toLowerCase() ?? null,
                        reasoningMode: /\(thinking\)/i.test(name) ? 'enabled' : null } };
            }), subset);
    sources.push(source('swe-bench-pro-public', scaleURL, entries));

    const terminalURL = 'https://www.tbench.ai/?version=4.0';
    await page.goto(terminalURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-row-id]').length >= 10,
    null, { timeout: 30000 });
    const terminalEntries = await page.evaluate(() => [...document.querySelectorAll('tbody tr[data-row-id]')]
        .map(row => {
            const cells = [...row.querySelectorAll('td')];
            const modelName = cells[1]?.querySelector('a')?.textContent?.trim();
            const effort = cells[1]?.querySelector('span.text-xs')?.textContent?.trim()
                .replace(/[()]/g, '').toLowerCase() ?? null;
            const score = Number(cells[3]?.querySelector('strong')?.textContent?.replace('%', ''));
            return { recordID: row.getAttribute('data-row-id'), modelName,
                modelSlug: null, provider: null, score,
                metric: 'tbench-v4-resolve-rate',
                config: { harness: cells[2]?.innerText.trim() ?? null,
                    reasoningEffort: effort } };
        }));
    sources.push(source('terminal-bench-v4', terminalURL, terminalEntries));

    const hleURL = 'https://labs.scale.com/leaderboard/humanitys_last_exam';
    await page.goto(hleURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('p[data-model-name]', { timeout: 30000 });
    const hleEntries = await page.evaluate(() => [...document.querySelectorAll('p[data-model-name]')]
        .map(element => {
            const modelName = element.textContent.trim();
            const score = Number(element.closest('button')?.parentElement
                ?.querySelector('p.ml-auto span.text-ink')?.textContent?.trim());
            const effort = modelName.match(/(?:thinking[ -])?(xhigh|high|medium|low|max|minimal)/i)?.[1]
                ?.toLowerCase() ?? null;
            return { recordID: modelName, modelName, modelSlug: null, provider: null,
                score, metric: 'scale-hle-finalized-public-accuracy',
                config: { reasoningEffort: effort,
                    reasoningMode: /non-thinking/i.test(modelName) ? 'disabled'
                        : /thinking/i.test(modelName) ? 'enabled' : null } };
        }));
    sources.push(source('scale-hle-finalized', hleURL, hleEntries));

    const scicodeURL = 'https://scicode-bench.github.io/leaderboard/';
    await page.goto(scicodeURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('table tbody tr', { timeout: 30000 });
    const scicodeEntries = await page.evaluate(() => [...document.querySelectorAll('table tbody tr')]
        .flatMap(row => {
            const cells = [...row.querySelectorAll('td')].map(cell => cell.textContent.trim());
            if (cells.length !== 3) throw new Error('Unexpected SciCode leaderboard row.');
            const modelName = cells[0].replace(/^[^A-Za-z]+/, '');
            const effort = modelName.match(/o3-mini-(low|medium|high)/i)?.[1] ?? null;
            return [[1, 'scicode-official-main'], [2, 'scicode-official-subproblem']]
                .map(([index, metric]) => ({ recordID: `${modelName}:${metric}`,
                    modelName, modelSlug: null, provider: null,
                    score: Number(cells[index]), metric,
                    config: { reasoningEffort: effort } }));
        }));
    sources.push(source('scicode-official', scicodeURL, scicodeEntries));

    const critptURL = 'https://github.com/CritPt-Benchmark/CritPt/blob/main/README.md';
    await page.goto(critptURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('table tbody tr', { timeout: 30000 });
    const critptEntries = await page.evaluate(() => [...document.querySelectorAll('table tbody tr')]
        .map(row => {
            const cells = [...row.querySelectorAll('td')].map(cell => cell.textContent.trim());
            if (cells.length !== 2) throw new Error('Unexpected CritPt leaderboard row.');
            const modelName = cells[0].replace(/[¹²]$/u, '').trim();
            const tools = /code & web/i.test(modelName) ? 'code and web'
                : /\bcode\)/i.test(modelName) ? 'code' : null;
            const effort = modelName.match(/\((high|minimal)\b/i)?.[1]?.toLowerCase() ?? null;
            return { recordID: modelName, modelName, modelSlug: null, provider: null,
                score: Number(cells[1]), metric: 'critpt-official-challenge-accuracy',
                config: { reasoningEffort: effort, tools } };
        }));
    sources.push(source('critpt-official', critptURL, critptEntries));
} finally {
    await browser.close();
}

const snapshot = { schemaVersion: 1, fetchedAt: new Date().toISOString(), sources };
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, sources: sources.map(item => ({ key: item.key,
    scoreCount: item.entries.length })), scoreCount: sources.reduce((n, item) => n + item.entries.length, 0) }));
