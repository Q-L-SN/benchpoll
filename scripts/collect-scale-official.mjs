#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

export const SCALE_DIRECTORY = 'https://labs.scale.com/leaderboard';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function flightFromHTML(html) {
    let flight = '';
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
        const push = match[1].match(/self\.__next_f\.push\((\[[\s\S]*\])\)/);
        if (!push) continue;
        const packet = JSON.parse(push[1]);
        if (typeof packet[1] === 'string') flight += packet[1];
    }
    return flight;
}

export async function fetchViaSSH(url, identityFile) {
    if (!/^https:\/\/(labs\.scale\.com|rsi-benchmark\.com)\/[a-zA-Z0-9_/?=&.\-]+$/.test(url)) throw new Error('Unexpected publisher URL.');
    return new Promise((done, fail) => {
        const child = spawn('ssh', ['-i', identityFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
            'ubuntu@18.226.222.18', `curl --fail --silent --show-error --location --max-time 35 '${url}'`], { windowsHide: true });
        let body = '', diagnostics = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { body += chunk; }); child.stderr.on('data', chunk => { diagnostics += chunk; });
        child.on('error', fail);
        child.on('close', code => code === 0 ? done(body) : fail(new Error(`Public source retrieval failed (${code}): ${diagnostics.slice(0,200)}`)));
    });
}

export function parseFlightObjects(flight) {
    const objects = [];
    const bytes = Buffer.from(flight, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
        if (bytes[offset] === 10) { offset++; continue; }
        const colon = bytes.indexOf(58, offset);
        if (colon < offset || colon - offset > 16) throw new Error('Invalid Flight record boundary.');
        const prefix = bytes.subarray(colon + 1, Math.min(bytes.length, colon + 30)).toString('utf8');
        const textRecord = prefix.match(/^T([0-9a-f]+),/i);
        if (textRecord) {
            // Flight text frames use UTF-8 byte lengths, not newline-delimited JSON.
            const start = colon + 1 + textRecord[0].length, end = start + parseInt(textRecord[1], 16);
            if (end > bytes.length) throw new Error('Truncated Flight text frame.');
            objects.push(bytes.subarray(start, end).toString('utf8'));
            offset = end;
        } else {
            let end = bytes.indexOf(10, colon + 1);
            if (end < 0) end = bytes.length;
            try { objects.push(JSON.parse(bytes.subarray(colon + 1, end).toString('utf8'))); } catch { /* Module and hint records are not data objects. */ }
            offset = end + 1;
        }
    }
    return objects;
}

export function findScoreTables(flight) {
    const tables = [];
    function visit(value, path) {
        if (!value || typeof value !== 'object') return;
        const entries = value.scores ?? value.entries;
        if (!Array.isArray(value) && Array.isArray(entries)
            && entries.some(row => typeof row.model === 'string' && typeof row.score === 'number')) {
            tables.push({ path, data: { ...value, scores: entries } });
        }
        for (const [key, child] of Object.entries(value)) visit(child, `${path}/${key}`);
    }
    parseFlightObjects(flight).forEach((value, index) => visit(value, String(index)));
    return tables;
}

async function capturePage(page, url, identityFile) {
    let failure;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const rawHTML = identityFile ? await fetchViaSSH(url, identityFile) : null;
            if (rawHTML) await page.setContent(rawHTML, { waitUntil: 'domcontentloaded', timeout: 10000 });
            else {
                const response = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
                if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
            }
            await page.locator('h1').first().waitFor({ state: 'attached', timeout: 12000 });
            const extracted = await page.evaluate(() => ({
                title: document.title,
                headings: [...document.querySelectorAll('h1,h2,h3,h4')].map(e => e.innerText.trim()),
                text: document.body.innerText,
                flight: window.__next_f?.filter(row => typeof row[1] === 'string').map(row => row[1]).join('') ?? '',
                links: [...document.querySelectorAll('a[href]')].map(a => ({ text: a.innerText.trim(), url: a.href })),
                tabs: [...document.querySelectorAll('[role=tab]')].map(e => ({ text: e.innerText, id: e.id, selected: e.getAttribute('aria-selected') })),
                rows: [...document.querySelectorAll('[data-model-name]')].map(e => {
                    let container = e.parentElement;
                    while (container && !container.querySelector('p.ml-auto span.text-ink')) container = container.parentElement;
                    return { model: e.innerText, scoreText: container?.querySelector('p.ml-auto span.text-ink')?.innerText,
                        rowText: container?.innerText, html: container?.outerHTML };
                }),
                publishedTables: [...document.querySelectorAll('table')].map(e => ({ text: e.innerText, html: e.outerHTML }))
            }));
            const html = rawHTML ?? await page.content();
            const flight = flightFromHTML(html) || extracted.flight;
            const links = extracted.links.map(row => ({ ...row, url: row.url.startsWith('about:') || !row.url.includes('://')
                ? new URL(row.url.replace(/^about:/, ''), url).href : row.url }));
            return { schemaVersion: 1, sourceURL: url, resolvedURL: identityFile ? url : page.url(), fetchedAt: new Date().toISOString(),
                ...extracted, links, flight, html, tables: findScoreTables(flight) };
        } catch (error) {
            failure = error;
            await page.waitForTimeout(2000 * (attempt + 1));
        }
    }
    throw new Error(`Could not capture ${url}: ${failure.message.split('\n')[0]}`);
}

export async function collectScale(outputDirectory, { extraURLs = [], onlyDirectory = false, onlyExtra = false, identityFile } = {}) {
    const root = resolve(outputDirectory);
    await mkdir(root, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ javaScriptEnabled: !identityFile });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const manifest = { schemaVersion: 1, publisher: 'Scale Labs', fetchedAt: new Date().toISOString(), pages: [], failures: [] };
    try {
        const directory = await capturePage(page, SCALE_DIRECTORY, identityFile);
        const currentURLs = directory.links.filter(row => row.url.startsWith(`${SCALE_DIRECTORY}/`)).map(row => row.url);
        const switchControl = page.getByRole('switch');
        if (!identityFile && directory.flight && await switchControl.count()) {
            await switchControl.click({ timeout: 3000 });
            await page.waitForTimeout(800);
            directory.deprecatedLinks = await page.locator('a[href*="/leaderboard/"]').evaluateAll(links => links.map(a => ({ text: a.innerText.trim(), url: a.href })));
        }
        const save = async (capture, file) => {
            const body = JSON.stringify(capture, null, 2) + '\n';
            await writeFile(resolve(root, file), body, 'utf8');
            manifest.pages.push({ sourceURL: capture.sourceURL, file, sha256: sha256(body),
                tableCounts: capture.tables.map(({ data }) => ({ id: data.id, name: data.name, count: data.scores.length })) });
            await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        };
        await save(directory, 'directory.json');
        console.log(JSON.stringify({ kind: 'directory', tables: directory.tables.map(({ data }) => ({ id: data.id,
            name: data.name, deprecated: data.deprecated, count: data.scores.length, reversedScores: data.reversedScores })) }));
        if (!onlyDirectory) {
            const tableURLs = directory.tables.map(({ data }) => `${SCALE_DIRECTORY}/${data.id}`);
            const queue = [...new Set(onlyExtra ? extraURLs : [...currentURLs, ...(directory.deprecatedLinks ?? []).map(row => row.url), ...tableURLs,
                `${SCALE_DIRECTORY}/swe_bench_pro?tab=private`, ...extraURLs])];
            for (const [index, url] of queue.entries()) {
                try {
                    const capture = await capturePage(page, url, identityFile);
                    const name = new URL(url).pathname.split('/').at(-1) + (new URL(url).searchParams.get('tab') ? `-${new URL(url).searchParams.get('tab')}` : '');
                    await save(capture, `${name}.json`);
                    console.log(JSON.stringify({ kind: 'page', index: index + 1, total: queue.length, url,
                        tables: capture.tables.map(({ data }) => ({ id: data.id, name: data.name, count: data.scores.length })), rows: capture.rows.length,
                        headings: capture.headings.slice(0,3) }));
                } catch (error) {
                    manifest.failures.push({ url, message: error.message });
                    console.log(JSON.stringify({ kind: 'failure', url, message: error.message }));
                    await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
                }
            }
        }
    } finally { await browser.close(); }
    return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const output = process.argv.find(arg => arg.startsWith('--output-dir='))?.slice('--output-dir='.length);
    if (!output) throw new Error('Use --output-dir=<evidence directory>.');
    const extraFile = process.argv.find(arg => arg.startsWith('--extra-urls='))?.slice('--extra-urls='.length);
    const extraURLs = extraFile ? JSON.parse(await readFile(extraFile, 'utf8')) : [];
    const identityFile = process.argv.find(arg => arg.startsWith('--identity='))?.slice('--identity='.length);
    const result = await collectScale(output, { extraURLs, onlyDirectory: process.argv.includes('--directory-only'),
        onlyExtra: process.argv.includes('--extra-only'), identityFile });
    console.log(JSON.stringify({ pages: result.pages.length, failures: result.failures.length }));
}
