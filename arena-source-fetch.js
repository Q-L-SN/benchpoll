import { createHash } from 'node:crypto';

const DATASET = 'lmarena-ai/leaderboard-dataset';

export function buildArenaSourceManifest(metadata, revision) {
    if (!/^[a-f0-9]{40}$/.test(revision) || metadata?.sha !== revision
        || metadata.cardData?.license !== 'cc-by-4.0'
        || !Array.isArray(metadata.cardData.configs) || !metadata.cardData.configs.length
        || !Array.isArray(metadata.siblings)) {
        throw new Error('A revision-pinned official Arena file manifest is required');
    }
    const definitions = new Map();
    for (const definition of metadata.cardData.configs) {
        const name = definition.config_name;
        if (!Array.isArray(definition.data_files)) throw new Error('Missing Arena latest-file definition');
        const latest = definition.data_files.filter(file => file.split === 'latest');
        if (typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name) || definitions.has(name)
            || !Array.isArray(latest) || latest.length !== 1 || latest[0].path !== `${name}/latest-*`) {
            throw new Error('Unknown or duplicated Arena latest-file layout');
        }
        definitions.set(name, []);
    }
    const paths = new Set();
    for (const sibling of metadata.siblings) {
        if (typeof sibling.rfilename !== 'string' || paths.has(sibling.rfilename)) {
            throw new Error('Invalid or duplicated Arena source-file path');
        }
        paths.add(sibling.rfilename);
        if (!sibling.rfilename.includes('/latest-')) continue;
        const match = /^([a-z0-9_]+)\/latest-(\d+)-of-(\d+)\.parquet$/.exec(sibling.rfilename);
        if (!match || !definitions.has(match[1])) throw new Error('Undeclared Arena latest source file');
        const index = Number(match[2]);
        const total = Number(match[3]);
        if (!Number.isSafeInteger(total) || total < 1 || total > 10000
            || !Number.isSafeInteger(index) || index < 0 || index >= total
            || !Number.isSafeInteger(sibling.size) || sibling.size < 1
            || sibling.lfs?.size !== sibling.size || !/^[a-f0-9]{64}$/.test(sibling.lfs.sha256)) {
            throw new Error(`Invalid Arena shard manifest: ${sibling.rfilename}`);
        }
        definitions.get(match[1]).push({ config: match[1], index, total,
            // Keep the logical shard identity independent of its transport URL.
            filename: `${String(index).padStart(4, '0')}.parquet`, sourcePath: sibling.rfilename,
            size: sibling.size, sha256: sibling.lfs.sha256,
            url: `https://huggingface.co/datasets/${DATASET}/resolve/${revision}/${sibling.rfilename}` });
    }
    const configs = [...definitions.keys()].sort();
    const files = [];
    for (const config of configs) {
        const shards = definitions.get(config).sort((left, right) => left.index - right.index);
        if (!shards.length || shards.length !== shards[0].total
            || shards.some((shard, index) => shard.index !== index || shard.total !== shards.length)) {
            throw new Error(`Incomplete Arena latest shards: ${config}`);
        }
        files.push(...shards);
    }
    return { configs, files };
}

export function verifyArenaSourceFile(source, bytes) {
    if (bytes.byteLength !== source.size) throw new Error(`Truncated ${source.config}/${source.sourcePath}`);
    const sha256 = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    if (sha256 !== source.sha256) throw new Error(`Arena source checksum mismatch: ${source.sourcePath}`);
    return { bytes, sha256 };
}

export async function fetchArenaConfigs(configs, fetchConfig, { concurrency = 4 } = {}) {
    if (!Array.isArray(configs) || !configs.length || new Set(configs).size !== configs.length
        || configs.some(config => typeof config !== 'string' || !/^[a-z0-9_]+$/.test(config))
        || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
        throw new Error('Invalid Arena fetch schedule');
    }
    const fetched = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, configs.length) }, async () => {
        while (cursor < configs.length) {
            const config = configs[cursor++];
            try {
                const result = await fetchConfig(config);
                if (result?.config !== config) throw new Error('Arena fetch returned a different config');
                fetched.push(result);
            } catch (error) {
                const message = error instanceof Error ? error.message || error.name : String(error);
                fetched.push({ config, fetchError: message.slice(0, 8000) });
            }
        }
    }));
    return fetched.sort((left, right) => left.config.localeCompare(right.config));
}
