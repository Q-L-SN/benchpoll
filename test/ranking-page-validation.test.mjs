import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import express from 'express';
import { buildBenchmarkList } from '../ranking-service.js';
import { validateRankingPagePayload } from '../public/js/workspace/contracts.js';

let pagination;
if (process.env.RANKING_PAGE_BASELINE) {
    const source = await readFile(resolve(process.env.RANKING_PAGE_BASELINE, 'ranking-pagination.js'), 'utf8');
    const absolute = source.replace(/from '(\.\/[^']+)'/g, (_all, path) => `from '${pathToFileURL(resolve(path)).href}'`);
    pagination = await import('data:text/javascript;base64,' + Buffer.from(absolute).toString('base64'));
} else pagination = await import('../ranking-pagination.js');
const server = await readFile(process.env.RANKING_PAGE_BASELINE
    ? resolve(process.env.RANKING_PAGE_BASELINE, 'server.js') : new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf("API.post('/get_ranking_page'");
const end = server.indexOf("API.post('/get_model_score_configurations'", start);
assert.ok(start > 0 && end > start);
function fixture() {
    const conditions = [1, 2].map(ID => ({ ID, conditionID: ID, benchmarkID: 1, name: 'Review benchmark', tags: [],
        conditionKey: ID === 1 ? 'default' : 'secondary', conditionName: ID === 1 ? 'default' : 'Secondary',
        isDefaultCondition: ID === 1, isPrimaryCondition: ID === 1, scoreCount: ID === 1 ? 10 : 1,
        scoredModelCount: ID === 1 ? 10 : 1 }));
    const model = { ID: 1, name: 'Model 1', comparable: true, lower: 50, upper: 50, coverage: 100,
        missingWeight: 0, availableInference: null, inferredScores: [], calculationScores: [{ conditionID: 1,
            normalizedScore: 50, effectiveWeight: 100, contribution: 50, fallbackFor: null, memberIDs: [1],
            memberWeights: [{ ID: 1, weight: 1 }], memberEvidence: [{ ID: 1, hash: 'a'.repeat(64) }] }] };
    return { scoreMode: 'range', benchmarks: buildBenchmarkList(conditions, [], [], [{ primaryConditionID: 1,
        familyID: 11, mode: 'ordered', entries: [conditions[1]] }]), personalPie: { entries: [], fallbackRules: [] },
    modelLeaderboards: { personal: [model], public: [model] } };
}
async function harness() {
    let time = 0;
    const pager = pagination.createRankingPager({ now: () => time });
    const snapshotID = pager.create(fixture(), { userID: '7' }).rankingPagination.snapshotID;
    const app = express(), API = express.Router(); app.use(express.json());
    const context = vm.createContext({ API, db: {}, rankingPager: pager,
        activeSessionUserID: async req => req.get('x-review-owner') ?? '7',
        loadReferencedBenchmarkFamilyIDs: async () => [11] });
    vm.runInContext(server.slice(start, end), context);
    app.use('/api', API);
    app.use((error, _req, res, _next) => res.status(error.status ?? 500).json(error.body ?? { error: 'internal_server_error' }));
    let http;
    await new Promise(resolve => { http = app.listen(0, '127.0.0.1', resolve); });
    return { pager, snapshotID, setTime(value) { time = value; },
        async request(args, owner = '7') {
            const response = await fetch(`http://127.0.0.1:${http.address().port}/api/get_ranking_page`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-review-owner': owner },
                body: JSON.stringify({ snapshotID, ...args }), signal: AbortSignal.timeout(5000) });
            return { status: response.status, body: await response.json() };
        }, async close() { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); } };
}
const badRequests = [
    ...[['public'], ['benchmarks'], ['fallbacks'], { toString: 'public' }].map(list => ({
        name: 'non-string list ' + JSON.stringify(list), args: { list }, error: 'invalid_ranking_list' })),
    ...[{ list: 'public', offset: 2 }, { list: 'personal', offset: 2 },
        { list: 'benchmarks', group: 'primary', offset: 3 },
        { list: 'benchmarks', group: 'other', groupVersions: true, offset: 1 },
        { list: 'benchmarks', group: 'lowCoverage', groupVersions: true, offset: 2 },
        { list: 'fallbacks', conditionID: 1, offset: 2 },
        { list: 'public', offset: Number.MAX_SAFE_INTEGER }].map(args => ({
        name: 'out-of-range cursor ' + JSON.stringify(args), args, error: 'invalid_ranking_offset' })),
    ...['other', 'lowCoverage'].flatMap(group => [false, undefined].map(groupVersions => ({
        name: 'flat secondary group ' + group + ' / ' + groupVersions,
        args: { list: 'benchmarks', group, groupVersions, query: '  ' }, error: 'invalid_ranking_group' })))
];
for (const repetition of [1, 2]) {
    for (const { name, args, error } of badRequests) test(`actual page route rejects ${name} (${repetition})`, async () => {
        const data = await harness();
        try {
            const result = await data.request(args);
            assert.equal(result.status, 400);
            assert.equal(result.body.error, error);
        } finally { await data.close(); }
    });
    for (const args of [{ list: 'public', offset: 1 }, { list: 'personal', offset: 1 },
        { list: 'benchmarks', group: 'primary', offset: 2 },
        { list: 'benchmarks', group: 'other', groupVersions: true, offset: 0 },
        { list: 'benchmarks', group: 'lowCoverage', groupVersions: true, offset: 1 },
        { list: 'fallbacks', conditionID: 1, offset: 1 }]) {
        test(`terminal page still satisfies the actual client contract ${JSON.stringify(args)} (${repetition})`, async () => {
            const data = await harness();
            try {
                const result = await data.request(args); assert.equal(result.status, 200);
                validateRankingPagePayload(result.body, { ...args, scoreMode: 'range',
                    grouping: args.groupVersions ? 'versions' : 'flat' });
                assert.deepEqual(result.body.items, []);
                assert.equal(result.body.nextOffset, result.body.total);
            } finally { await data.close(); }
        });
    }
    test(`search and explicit version grouping still allow secondary pages (${repetition})`, async () => {
        const data = await harness();
        try {
            for (const args of [{ list: 'benchmarks', group: 'lowCoverage', query: 'Review benchmark', offset: 0 },
                { list: 'benchmarks', group: 'lowCoverage', groupVersions: true, offset: 0 }]) {
                const result = await data.request(args); assert.equal(result.status, 200);
                validateRankingPagePayload(result.body, { ...args, grouping: 'versions', scoreMode: 'range' });
            }
        } finally { await data.close(); }
    });
    test(`rejected cursor never renews an owner's snapshot (${repetition})`, async () => {
        const data = await harness();
        try {
            data.setTime(15 * 60 * 1000 - 1);
            assert.equal((await data.request({ list: 'public', offset: 2 })).status, 400);
            data.setTime(15 * 60 * 1000);
            const expired = await data.request({ list: 'public' });
            assert.equal(expired.status, 410); assert.equal(expired.body.error, 'ranking_snapshot_expired');
        } finally { await data.close(); }
    });
    test(`valid pages still deny another owner and ignore a forged userID (${repetition})`, async () => {
        const data = await harness();
        try {
            const result = await data.request({ list: 'public', userID: '7' }, '8');
            assert.equal(result.status, 403); assert.equal(result.body.error, 'ranking_snapshot_forbidden');
        } finally { await data.close(); }
    });
}
