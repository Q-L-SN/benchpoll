#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const PAGES = [
    ['intelligenceIndex', 'artificial-analysis-intelligence-index'],
    ['briefcaseElo', 'aa-briefcase'],
    ['gdpval', 'gdpval-aa'],
    ['automationBenchPartialScore', 'automationbench-aa'],
    ['apexAgents', 'apex-agents-aa'],
    ['terminalBench40', 'terminalbench-4-0'],
    ['terminalbenchHard', 'terminalbench-hard'],
    ['scicode', 'scicode'],
    ['hle', 'humanitys-last-exam'],
    ['gdpPdfAllPass', 'gdp-pdf'],
    ['critpt', 'critpt'],
    ['omniscience', 'omniscience'],
    ['lcr', 'artificial-analysis-long-context-reasoning']
];
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (process.argv.slice(2).some(arg => !arg.startsWith('--output=')) || !output) {
    throw new Error('Usage: node scripts/collect-aa-current.mjs --output=<snapshot.json>');
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const bySlug = new Map();
const sources = [];
try {
    for (const [metric, route] of PAGES) {
        const url = `https://artificialanalysis.ai/evaluations/${route}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => [...document.scripts]
            .some(script => script.textContent.includes('initialModels')),
        null, { timeout: 30000 });
        const payload = await page.evaluate(() => {
            const arrays = [];
            const visit = value => {
                if (!value || typeof value !== 'object') return;
                if (!Array.isArray(value) && Array.isArray(value.initialModels)
                    && value.initialModels.length && value.initialModels[0]?.slug
                    && value.initialModels[0]?.creator) {
                    arrays.push(value.initialModels);
                }
                for (const child of Object.values(value)) visit(child);
            };
            for (const script of document.scripts) {
                const content = script.textContent;
                if (!content.startsWith('self.__next_f.push(') || !content.endsWith(')')) continue;
                let chunk;
                try { chunk = JSON.parse(content.slice(19, -1)); }
                catch { continue; }
                const data = chunk[1];
                if (typeof data !== 'string' || !data.includes('"initialModels"')) continue;
                const separator = data.indexOf(':');
                if (separator < 0) continue;
                try { visit(JSON.parse(data.slice(separator + 1))); }
                catch { /* Other React Flight records are not JSON values. */ }
            }
            const models = new Map();
            for (const array of arrays) {
                for (const model of array) models.set(model.slug, model);
            }
            return {
                heading: document.querySelector('h1')?.textContent?.trim() ?? '',
                models: [...models.values()]
            };
        });
        const minimumModels = metric === 'apexAgents' || metric === 'terminalbenchHard' ? 1 : 10;
        if (payload.models.length < minimumModels || !payload.heading) {
            throw new Error(`No comparable model scores found at ${url}.`);
        }
        if (metric === 'intelligenceIndex' && !payload.heading.includes('v4.3.2')) {
            throw new Error(`Unexpected Index version: ${payload.heading}.`);
        }
        let scored = 0;
        for (const model of payload.models) {
            const value = model[metric];
            if (value === null || value === undefined) continue;
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new Error(`Invalid ${metric} value for ${model.slug}.`);
            }
            const creator = model.creator?.name;
            if (!model.slug || !model.name || !creator) {
                throw new Error(`Incomplete model identity on ${url}.`);
            }
            const existing = bySlug.get(model.slug);
            if (existing && existing.creator !== creator) {
                throw new Error(`Conflicting creator for ${model.slug}.`);
            }
            const record = existing ?? {
                slug: model.slug, name: model.name, creator,
                releaseDate: model.releaseDate ?? null, scores: {}
            };
            if (record.scores[metric]) throw new Error(`Duplicate ${metric} for ${model.slug}.`);
            record.scores[metric] = { value, sourceURL: url };
            bySlug.set(model.slug, record);
            scored += 1;
        }
        sources.push({ metric, url, heading: payload.heading,
            displayedModels: payload.models.length, scoredModels: scored });
        console.error(`${metric}: ${scored} scores from ${payload.models.length} displayed models`);
    }
} finally {
    await browser.close();
}

const snapshot = {
    schemaVersion: 1,
    indexVersion: 'v4.3.2',
    fetchedAt: new Date().toISOString(),
    sources,
    models: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))
};
await writeFile(output, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output, sourceCount: sources.length,
    modelCount: snapshot.models.length,
    scoreCount: snapshot.models.reduce((sum, model) => sum + Object.keys(model.scores).length, 0) }));
