import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { parquetReadObjects } from 'hyparquet';
import { ARENA_SNAPSHOT_VERSION, validateArenaSnapshot } from '../arena-sync.js';
import { buildArenaSourceManifest, fetchArenaConfigs, verifyArenaSourceFile } from '../arena-source-fetch.js';

const DATASET = 'lmarena-ai/leaderboard-dataset';
const args = process.argv.slice(2);
const paths = args.filter(argument => !argument.startsWith('--'));
if (paths.length > 1 || args.some(argument => argument.startsWith('--') && argument !== '--candidate')
    || args.filter(argument => argument === '--candidate').length > 1) throw new Error('Unknown Arena fetch argument');
const output = resolve(paths[0] || 'artifacts/arena-latest.json');
const candidate = args.includes('--candidate');

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
}

async function getJSON(url) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.ok) return response.json();
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
            throw new Error(`${response.status} from ${url}`);
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1000 * (attempt + 1)));
    }
    throw new Error(`Could not fetch ${url}`);
}

const metadata = await getJSON(`https://huggingface.co/api/datasets/${DATASET}`);
if (!/^[0-9a-f]{40}$/.test(metadata.sha)) throw new Error('Dataset revision is missing');
const revision = metadata.sha;
const pinnedMetadata = await getJSON(`https://huggingface.co/api/datasets/${DATASET}/revision/${revision}?blobs=true`);
const { files, configs } = buildArenaSourceManifest(pinnedMetadata, revision);

async function downloadFile(source) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await fetch(source.url, { signal: AbortSignal.timeout(60000) });
        if (response.ok) {
            const bytes = await response.arrayBuffer();
            return verifyArenaSourceFile(source, bytes);
        }
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
            throw new Error(`${response.status} from ${source.url}`);
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1000 * (attempt + 1)));
    }
    throw new Error(`Could not download ${source.url}`);
}

async function fetchConfig(config) {
    const rows = [];
    const checksums = [];
    for (const source of files.filter(item => item.config === config)) {
        const { bytes, sha256 } = await downloadFile(source);
        const decoded = await parquetReadObjects({ file: bytes });
        rows.push(...decoded.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
            if (typeof value !== 'bigint') return [key, value];
            const number = Number(value);
            if (!Number.isSafeInteger(number)) throw new Error(`Oversized ${config}.${key}`);
            return [key, number];
        }))));
        checksums.push({ filename: source.filename, sourcePath: source.sourcePath,
            sha256, rows: decoded.length, size: bytes.byteLength });
    }
    const categories = new Map();
    const dates = new Set();
    const identities = new Map();
    const conflicts = [];
    for (const [index, row] of rows.entries()) {
        if (typeof row.model_name !== 'string' || !row.model_name.trim()
            || typeof row.organization !== 'string'
            || typeof row.category !== 'string' || !row.category.trim()
            || !/^\d{4}-\d{2}-\d{2}$/.test(row.leaderboard_publish_date)
            || !Number.isFinite(row.score ?? row.rating)) {
            throw new Error(`${config} contains an incomplete result row`);
        }
        const identity = `${row.organization}\0${row.model_name}\0${row.category}`;
        if (identities.has(identity)) {
            conflicts.push({ firstRow: identities.get(identity), duplicateRow: index,
                organization: row.organization, modelName: row.model_name, category: row.category });
        } else {
            identities.set(identity, index);
        }
        categories.set(row.category, (categories.get(row.category) || 0) + 1);
        dates.add(row.leaderboard_publish_date);
    }
    console.log(`${config}: ${rows.length} rows, ${categories.size} categories, ${dates.size} dates, ${conflicts.length} conflicts`);
    return { config, rows, categories: Object.fromEntries([...categories].sort()), dates: [...dates].sort(), conflicts, checksums };
}

const fetched = await fetchArenaConfigs(configs, fetchConfig);
for (const feed of fetched.filter(item => Object.hasOwn(item, 'fetchError'))) {
    console.error(`${feed.config}: download failed: ${feed.fetchError}`);
}
const snapshot = {
    schemaVersion: ARENA_SNAPSHOT_VERSION,
    source: `https://huggingface.co/datasets/${DATASET}`,
    license: 'CC-BY-4.0',
    revision,
    sourceModifiedAt: pinnedMetadata.lastModified,
    fetchedAt: new Date().toISOString(),
    expectedConfigs: configs,
    configs: fetched
};
const content = JSON.stringify(snapshot);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, content, 'utf8');
try {
    validateArenaSnapshot(snapshot);
} catch (error) {
    await writeFile(`${output}.validation.json`, JSON.stringify({ valid: false, revision,
        fetchedAt: snapshot.fetchedAt, error: error.message }), 'utf8');
    if (!candidate) throw error;
    console.error(`Candidate retained for independent feed validation: ${error.message}`);
}
console.log(JSON.stringify({ output, revision, configs: fetched.length,
    failedConfigs: fetched.filter(item => Object.hasOwn(item, 'fetchError')).map(item => item.config),
    rows: fetched.reduce((sum, item) => Object.hasOwn(item, 'fetchError') ? sum : sum + item.rows.length, 0),
    sha256: createHash('sha256').update(content).digest('hex') }));
