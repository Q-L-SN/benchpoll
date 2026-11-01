import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const output = resolve('artifacts/openrouter-latest-20261014');
const previousPath = 'artifacts/post-astra-import-20261002/openrouter-models.json';
const previous = JSON.parse(await readFile(previousPath, 'utf8'));
const previousInventory = JSON.parse(await readFile('artifacts/post-astra-import-20261002/inventory.json', 'utf8'));
const url = 'https://openrouter.ai/api/v1/models?output_modalities=all';
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
assert.equal(response.status, 200);
const bytes = Buffer.from(await response.arrayBuffer());
const catalog = JSON.parse(bytes.toString('utf8'));
assert.ok(Array.isArray(catalog.data) && catalog.data.length > 100);
assert.equal(new Set(catalog.data.map(model => model.id)).size, catalog.data.length);
if (catalog.total_count !== undefined) assert.equal(catalog.total_count, catalog.data.length);
const routeKey = model => model.id.replace(/:(batch|free)$/, '');
const prior = new Map(previous.data.map(model => [model.id, model]));
const priorFamilies = new Set(previous.data.filter(model => !model.id.startsWith('~')).map(routeKey));
const latest = new Map(), aliases = [];
for (const model of catalog.data) {
    if (model.id.startsWith('~') || model.alias_target) { if (!prior.has(model.id)) aliases.push(model); continue; }
    const ID = routeKey(model);
    const group = latest.get(ID) ?? { id: ID, name: model.name, canonicalSlug: model.canonical_slug,
        huggingFaceID: model.hugging_face_id, listedAt: new Date(model.created * 1000).toISOString(),
        routes: [], newRoutes: [], previouslyListed: priorFamilies.has(ID), previouslyRecorded: null,
        reason: null, description: model.description, officialReleaseDate: null, officialSourceURLs: [], status: 'unverified' };
    group.routes.push(model.id);
    if (!prior.has(model.id)) group.newRoutes.push(model.id);
    if (model.id === ID) { group.name = model.name; group.huggingFaceID = model.hugging_face_id; }
    latest.set(ID, group);
}
const candidates = [...latest.values()].filter(model => model.newRoutes.length
    || new Date(model.listedAt) > new Date(previousInventory.fetchedAt))
    .sort((a, b) => b.listedAt.localeCompare(a.listedAt));
for (const model of candidates) model.reason = model.previouslyListed ? 'new-route-or-later-listing' : 'new-model-family-in-catalog';
const inventory = { capturedAt: new Date().toISOString(), sourceURL: url,
    sourceSHA256: createHash('sha256').update(bytes).digest('hex'), catalogCount: catalog.data.length,
    previousCatalog: { path: previousPath, capturedAt: previousInventory.fetchedAt, count: previous.data.length },
    cutoff: previousInventory.cutoff, candidates, newRollingAliases: aliases,
    rules: { catalogCreatedIsNotOfficialReleaseDate: true, rollingAliasesAreNotIndependentModels: true,
        routingVariantsAreNotIndependentModelWeights: true, officialReleaseScoresThenOperatorLeaderboards: true,
        paperScoresExcluded: true, snapshotsAreNotBenchmarkVersions: true,
        keepEffortHarnessAndCostSeparateFromVersion: true, includeExplicitlyRequestedGeminiArgon: true } };
await mkdir(output, { recursive: true });
await writeFile(join(output, 'openrouter-models.json'), bytes, { flag: 'wx' });
await writeFile(join(output, 'inventory.json'), JSON.stringify(inventory, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, catalogCount: catalog.data.length, previousCapture: previousInventory.fetchedAt,
    candidates: candidates.map(model => ({ id: model.id, name: model.name, listedAt: model.listedAt,
        previouslyListed: model.previouslyListed, newRoutes: model.newRoutes })), aliases: aliases.map(model => model.id) }, null, 2));
