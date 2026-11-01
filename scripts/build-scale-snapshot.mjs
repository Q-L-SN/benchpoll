#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { parse } from 'acorn';
import { parseFlightObjects } from './collect-scale-official.mjs';
import { loadScaleEvidence, uniqueScaleTables, objectHash, nameKey, stableJSON, scaleRunConfiguration } from './scale-official-data.mjs';
import { scaleVersion } from './scale-benchmark-catalogue.mjs';

export function visitObjects(value, visit) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) visit(value);
    for (const child of Object.values(value)) visitObjects(child, visit);
}
export function literalJSONArrays(javascript) {
    const arrays = [];
    visitObjects(parse(javascript, { ecmaVersion: 'latest' }), node => {
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
            && node.callee.object.name === 'JSON' && node.callee.property.name === 'parse'
            && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
            const value = JSON.parse(node.arguments[0].value);
            if (Array.isArray(value)) arrays.push(value);
        }
    });
    return arrays;
}
const armModels = {
    'claude-opus5': 'Claude Opus 5', 'claude-sonnet5': 'Claude Sonnet 5',
    'codex-gpt54': 'GPT-5.4', 'codex-gpt54mini': 'GPT-5.4 Mini', 'codex-gpt55': 'GPT-5.5',
    'codex-gpt56luna': 'GPT-5.6 Luna', 'codex-gpt56sol': 'GPT-5.6 Sol',
    'gemini-31pro': 'Gemini 3.1 Pro', 'gemini-35flash': 'Gemini 3.5 Flash', 'gemini-36flash': 'Gemini 3.6 Flash',
    'opencode-ds4flash': 'DeepSeek V4 Flash', 'opencode-ds4pro': 'DeepSeek V4 Pro', 'opencode-glm52': 'GLM-5.2',
    'opencode-gptoss120b': 'gpt-oss-120b', 'opencode-kimik2p7': 'Kimi K2.7', 'opencode-minimaxm3': 'MiniMax M3',
    'opencode-museglimmer30b': 'Muse Glimmer 30B', 'opencode-nemotron3ultra': 'Nemotron 3 Ultra',
    'opencode-qwen37': 'Qwen3.7', deepseekr1: 'DeepSeek R1', gemini25flash: 'Gemini 2.5 Flash',
    gemini31pro: 'Gemini 3.1 Pro', gpt5: 'GPT-5', gpt55: 'GPT-5.5', gpt56: 'GPT-5.6', gpt5nano: 'GPT-5 Nano',
    gptoss120b: 'gpt-oss-120b', 'huatuo-70b': 'HuatuoGPT-70B', 'huatuo-o1-8b': 'HuatuoGPT-o1-8B',
    'llama31-8b': 'Llama 3.1 8B Instruct', 'medgemma-27b': 'MedGemma 27B', 'mistral-24b': 'Mistral Small 24B',
    opus47: 'Claude Opus 4.7', qwen3235b: 'Qwen3 235B A22B', sonnet46: 'Claude Sonnet 4.6'
};

async function htmlTables(page, capture) {
    await page.setContent(capture.html, { waitUntil: 'domcontentloaded' });
    return page.locator('table').evaluateAll(tables => tables.map(table => [...table.querySelectorAll('tr')].map(row =>
        [...row.querySelectorAll('th,td')].map(cell => ({ text: cell.textContent.trim(), href: cell.querySelector('a')?.getAttribute('href') ?? null })))));
}

export async function buildScaleSnapshot(root) {
    const evidence = await loadScaleEvidence(resolve(root, 'source'));
    const extra = await loadScaleEvidence(resolve(root, 'extra-source'));
    const rsi = await loadScaleEvidence(resolve(root, 'rsi-source'));
    const records = [], warnings = [], sourceRows = {};
    const add = (metricKey, row, source, additional = {}) => {
        if (!Number.isFinite(row.score)) throw new Error(`Missing numeric score in ${metricKey}`);
        const metric = scaleVersion(metricKey);
        const min = metric.percentage ? 0 : metric.min, max = metric.percentage ? 100 : metric.max;
        if (row.score < min || row.score > max) throw new Error(`Out-of-range ${metricKey}: ${row.model} ${row.score}`);
        const boardID = metricKey.startsWith('ready:') ? 'ready' : metricKey.startsWith('rsi:') ? 'rsi' : metricKey.split(':')[0];
        records.push({ metricKey, boardID, record: row, sourceURL: source.sourceURL,
            evidenceFile: source.evidenceFile, evidenceHash: source.evidenceHash, fetchedAt: source.fetchedAt,
            status: metric.archived ? 'archived' : 'accepted', ...additional });
        sourceRows[metricKey] = (sourceRows[metricKey] ?? 0) + 1;
    };
    const tables = uniqueScaleTables(evidence.pages);
    const audioTyped = tables.filter(t => t.boardID === 'audiomc-text' || t.boardID === 'audiomc-audio');
    for (const table of tables) {
        const metricKey = table.boardID.startsWith('audiomc') ? 'audiomc:overall' : table.ID;
        for (const row of table.records) {
            let configuration;
            if (table.boardID === 'audiomc') {
                const parsed = scaleRunConfiguration(row, table.boardID);
                if (!parsed.configuration.generationMode) {
                    const matches = audioTyped.flatMap(t => t.records.filter(other => other.score === row.score
                        && nameKey(scaleRunConfiguration(other, t.boardID).baseName) === nameKey(parsed.baseName)
                        && stableJSON(scaleRunConfiguration(other, t.boardID).configuration.reasoningEffort) === stableJSON(parsed.configuration.reasoningEffort)
                        && stableJSON(scaleRunConfiguration(other, t.boardID).configuration.reasoningMode) === stableJSON(parsed.configuration.reasoningMode))
                        .map(other => scaleRunConfiguration(other, t.boardID).configuration.generationMode));
                    if (new Set(matches).size === 1) configuration = { generationMode: matches[0] };
                    else warnings.push({ type: 'Unspecified output modality', model: row.model, metricKey });
                }
            }
            add(metricKey, row, table, { configuration, boardID: table.boardID });
            if (Number.isFinite(row.calibrationError)) add(`${table.boardID}:calibration`, { ...row, score: row.calibrationError }, table);
            if (table.boardID === 'fortress') {
                const match = row.contaminationMessage?.match(/ORS score:\s*(\d+(?:\.\d+)?)/i);
                if (match) add('fortress:ors', { ...row, score: Number(match[1]) }, table);
                else warnings.push({ type: 'No published ORS', model: row.model });
            }
        }
    }
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
        for (const capture of evidence.pages.filter(p => ['hle-diamond.json', 'mcp_atlas.json'].includes(p.evidenceFile))) {
            const board = capture.evidenceFile.split('.')[0];
            for (const cells of await htmlTables(page, capture)) {
                if (board === 'hle-diamond' && cells[0]?.map(c => c.text).join('|') === 'Model|Overall|Reasoning|Knowledge') {
                    for (const row of cells.slice(1)) for (const [column, key] of [[2, 'reasoning'], [3, 'knowledge']]) {
                        add(`hle-diamond:${key}`, { model: row[0].text, score: Number(row[column].text.replace('%', '')), company: '' }, capture);
                    }
                }
                if (board === 'mcp_atlas' && cells[0]?.some(c => c.text.includes('Public 500'))) {
                    for (const row of cells.slice(1)) add('mcp_atlas:public500', {
                        model: row[0].text, score: Number(row[2].text.replace('%', '')), company: '' }, capture);
                }
            }
        }
        for (const capture of rsi.pages.filter(p => new URL(p.sourceURL).pathname.startsWith('/tasks/'))) {
            const task = new URL(capture.sourceURL).pathname.split('/').at(-1);
            for (const cells of await htmlTables(page, capture)) {
                if (cells[0]?.map(c => c.text).join('|') !== 'run|model|effort|reward|status') continue;
                for (const row of cells.slice(1)) {
                    if (!['ok', 'finished'].includes(row[4].text)) throw new Error(`Unverified RSI run: ${row[0].text}`);
                    const configuration = /^[a-z]+$/i.test(row[2].text) ? { reasoningEffort: row[2].text.toLowerCase() } : {};
                    add(`rsi:${task}`, { model: row[1].text, score: Number(row[3].text), company: '' }, capture,
                        { configuration, measurementID: row[0].text, sourceURL: new URL(row[0].href, capture.sourceURL).href });
                }
            }
        }
    } finally { await browser.close(); }
    const blog = extra.pages.find(p => p.evidenceFile === 'swe-bench-pro-v2.json');
    const charts = new Map();
    for (const object of parseFlightObjects(blog.flight)) visitObjects(object, item => {
        if (item._type === 'chart' && item.dataJson?.startsWith('[')) charts.set(item._key, item);
    });
    const privateChart = [...charts.values()].find(c => c.dataJson.includes('SWE-Bench Pro V2 Private (272 tasks)'));
    for (const row of JSON.parse(privateChart.dataJson)) {
        const [model, harness] = row.label.split(', ');
        add('swe_bench_pro_public_v2:private', { model, score: row['SWE-Bench Pro V2 Private (272 tasks)'], company: '' }, blog,
            { configuration: { agentHarness: harness }, measurementID: 'V2 private chart' });
    }
    for (const row of JSON.parse(charts.get('chartPass1Harness').dataJson)) {
        for (const [model, score] of Object.entries(row).filter(([key]) => key !== 'label')) {
            add('swe_bench_pro_public_v2:full', { model, score, company: '' }, blog, {
                configuration: { agentHarness: row.label, configurationSelection: 'Official harness ablation' },
                measurementID: 'Harness ablation', metadata: { bashTimeoutSeconds: row.label === 'mini-swe-agent' ? 30 : null } });
        }
    }
    const assetPath = resolve(root, 'ready-assets/1yv5c77lh5r57.js');
    const assetBody = await readFile(assetPath, 'utf8');
    const readyArrays = literalJSONArrays(assetBody);
    if (readyArrays.length !== 2 || readyArrays[0].length !== 741 || readyArrays[1].length !== 912) throw new Error('READY data inventory changed; review required.');
    const readySource = extra.pages.find(p => p.evidenceFile === 'economics.json');
    for (const [index, key, target] of [[0, 'clinicare', .85], [1, 'psebench', .9]]) {
        const rows = readyArrays[index];
        for (const row of rows.filter(row => Math.abs(row.target_reliability - target) < 1e-10)) {
            if (!armModels[row.arm]) throw new Error(`Unknown READY arm: ${row.arm}`);
            if (row.review_fraction === null || row.achievable === false) {
                warnings.push({ type: 'Unachievable READY target', benchmark: key, arm: row.arm, target }); continue;
            }
            const harness = { codex: 'Codex', opencode: 'OpenCode' }[row.arm.split('-')[0]];
            const configuration = harness ? { agentHarness: harness } : {};
            const metadata = { readyArm: row.arm, modelCostUSDPerCase: row.model_cost, humanReviewCostUSDPerCase: 25,
                reliabilityCurve: rows.filter(other => other.arm === row.arm), javascriptEvidenceHash: objectHash(assetBody) };
            const source = { ...readySource, evidenceHash: objectHash(assetBody), evidenceFile: 'ready-assets/1yv5c77lh5r57.js' };
            add(`ready:${key}:review`, { model: armModels[row.arm], score: 100 * row.review_fraction, company: '' }, source, { configuration, metadata });
            add(`ready:${key}:cost`, { model: armModels[row.arm], score: row.model_cost + 25 * row.review_fraction, company: '' }, source, { configuration, metadata });
        }
    }
    const reportPath = resolve('ops/scale-showdown-report-20261012.json');
    const reportBody = await readFile(reportPath, 'utf8'), report = JSON.parse(reportBody);
    for (const row of report.records) add('showdown:style-controlled', row, {
        sourceURL: report.sourceURL, evidenceFile: reportPath, evidenceHash: objectHash(reportBody), fetchedAt: extra.manifest.fetchedAt
    }, { configuration: row.reasoningMode ? { reasoningMode: row.reasoningMode } : {}, metadata: { asOf: report.asOf, page: report.page, table: report.table } });
    const versionKeys = [...new Set(records.map(r => r.metricKey))];
    return { schemaVersion: 1, publisher: 'Scale Labs', collectedAt: new Date().toISOString(),
        versions: versionKeys.map(scaleVersion), records, sourceRows, warnings,
        directoryEntries: evidence.pages.find(p => p.evidenceFile === 'directory.json').tables.map(t => ({ ID: t.data.id, name: t.data.name, deprecated: t.data.deprecated })),
        sources: [...evidence.manifest.pages, ...extra.manifest.pages, ...rsi.manifest.pages] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const root = process.argv.find(arg => arg.startsWith('--root='))?.slice(7);
    if (!root) throw new Error('Use --root=<source artifact directory>.');
    const snapshot = await buildScaleSnapshot(root);
    await writeFile(resolve(root, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ versions: snapshot.versions.length, rawRecords: snapshot.records.length, sourceRows: snapshot.sourceRows, warnings: snapshot.warnings }, null, 2));
}
