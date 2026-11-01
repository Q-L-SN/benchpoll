import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createSearchIndex } from '../public/js/shared/search.js';

const names = ['SWE-bench Verified', 'ARC-AGI-3', 'LiveCodeBench', 'Agent Arena', 'MMLU Pro', 'GPQA Diamond'];
const items = Array.from({ length: 16000 }, (_, i) => ({ ID: i, name: names[i % names.length],
    condition: `Test configuration ${Math.floor(i / names.length)}`, tags: ['Knowledge', 'Reasoning'] }));
const start = performance.now();
const index = createSearchIndex(items, item => [item.name, item.condition, ...item.tags]);
const report = { rows: items.length, buildMs: performance.now() - start, queries: [] };
for (const query of ['swe bench verified', 'verifed swe', 'arcagi3', 'livecodebench configuration 12', 'imaginary no matches']) {
    const cold = performance.now(); const hits = index.search(query);
    const coldMs = performance.now() - cold;
    const warm = performance.now(); index.search(query, { limit: 40 });
    report.queries.push({ query, matches: hits.length, coldMs, cachedMs: performance.now() - warm });
}
await writeFile('artifacts/ranking-interactions-20261002/search-performance.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
