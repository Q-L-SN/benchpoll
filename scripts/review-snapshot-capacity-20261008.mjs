import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { createRankingPager, RANKING_PAGE_SIZE } from '../ranking-pagination.js';
import { familyKey } from '../public/js/shared/benchmark-families.js';
import { validateRankingPagePayload } from '../public/js/workspace/contracts.js';
import { createBenchmarkFallbackCatalogue } from '../public/js/workspace/benchmark-fallback-catalogue.js';
import { captureRankingResume } from '../public/js/shared/ranking-resume.js';
import { comparisonProfileKey } from '../public/js/shared/comparison-profile-key.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const policy = Object.freeze({ capacity: 12, ttlMs: 15 * 60 * 1000, queryCache: 32, pageSizes: RANKING_PAGE_SIZE });
const artifactDirectory = path.join(root, 'artifacts/review-20261008');
const beforeFixesFile = 'artifacts/review-20261008/snapshot-capacity-before-fixes-20261008T020642.json';
const originalFinalRuns = ['2026-10-08T02-00-26-196Z-51844-ed548dc2', '2026-10-08T02-00-34-516Z-34004-50a89d35'];
const inspectedFiles = [
    'AGENTS.md', 'ranking-pagination.js', 'server.js', 'public/js/home-workspace.js',
    'public/js/workspace/benchmark-fallback-catalogue.js', 'public/js/workspace/contracts.js',
    'public/js/shared/ranking-resume.js',
    'public/js/workspace/constants.js', 'public/js/shared/search.js', 'public/js/vendor/fuse-7.5.0.js',
    'public/js/shared/benchmark-condition-groups.js', 'public/js/shared/benchmark-version-order.js',
    'public/js/shared/fallback-catalogue-policy.js', 'public/js/shared/benchmark-families.js',
    'public/js/shared/available-score.js', 'public/js/shared/account-identity.js', 'public/js/shared/motion.js',
    'package.json', 'package-lock.json', 'test/ranking-pagination.test.mjs',
    'test/ranking-page-refresh-contract.test.mjs', 'test/fallback-discovery.test.mjs', 'test/family-lifecycle.test.mjs',
    'scripts/review-snapshot-capacity-20261008.mjs', 'test/review-snapshot-capacity-20261008.test.mjs'
];
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function fixture({ benchmarks = 83, models = 76, families = 17, entrances = [1], owner = 'fixture' } = {}) {
    const rows = Array.from({ length: benchmarks }, (_, index) => ({
        ID: index + 1, benchmarkID: index + 1, conditionID: index + 1,
        name: `Benchmark ${index + 1}`, conditionName: 'default', conditionKey: 'default',
        isDefaultCondition: true, isPrimaryCondition: true, lowCoverage: false,
        isFamily: false, tags: ['benchmark', 'synthetic'], scoreCount: 1, scoredModelCount: 1,
        publicWeightBasisPoints: Math.max(0, 10000 - index), publicWeight: Math.max(0, 10000 - index) / 100,
        rank: index + 1
    }));
    let sequence = 0;
    for (const entranceID of families > 0 ? entrances : []) {
        const entrance = rows.find(row => row.conditionID === entranceID);
        assert.ok(entrance, 'Synthetic fallback entrance must exist');
        for (let index = 0; index < families; index++) {
            const ID = 10000 + ++sequence;
            const entries = [{ ...entrance, ID, conditionID: ID, conditionName: 'variant',
                conditionKey: `variant-${ID}`, isDefaultCondition: false, name: `Alternative ${ID}` }];
            rows.push({ ...entrance, isFamily: true, familyID: ID, familyKey: familyKey(entranceID, entries),
                familyEntries: entries, publicWeightBasisPoints: 0, publicWeight: 0 });
        }
    }
    function modelRows(mode) {
        return Array.from({ length: models }, (_, index) => {
            const ID = index + 1;
            const lower = 100 - index / Math.max(1, models);
            return { ID, name: `${owner} ${mode} Model ${ID}`, comparable: true, lower, upper: lower,
                coverage: 100, missingWeight: 0, availableInference: null, inferredScores: [],
                calculationScores: [{ conditionID: 1, normalizedScore: lower, effectiveWeight: 100,
                    contribution: lower, fallbackFor: null, memberIDs: [ID], memberWeights: [{ ID, weight: 1 }],
                    memberEvidence: [{ ID, hash: sha256(`synthetic:${owner}:${mode}:${ID}`) }] }] };
        });
    }
    return { scoreMode: 'range', benchmarks: rows, context: { categoryID: 1, contextValues: {} },
        personalPie: { entries: [], fallbackRules: [] },
        modelLeaderboards: { personal: modelRows('personal'), public: modelRows('public') } };
}

function handle(pager, userID, data = fixture({ owner: userID })) {
    const response = pager.create(data, { userID });
    return { userID, snapshotID: response.rankingPagination.snapshotID, response };
}

export function attempt(pager, args) {
    try { return { status: 200, page: pager.getPage(args) }; }
    catch (error) {
        if (!error.status) throw error;
        return { status: error.status, error: error.body.error };
    }
}

function statusInventory(pager, handles) {
    return handles.map(({ userID, snapshotID }) => ({ userID,
        status: attempt(pager, { userID, snapshotID, list: 'public', offset: 25 }).status }));
}

export function capacityScenario(ownerCount) {
    const pager = createRankingPager({ now: () => 0 });
    const handles = Array.from({ length: ownerCount }, (_, index) => handle(pager, `owner-${index + 1}`));
    const inventory = statusInventory(pager, handles);
    return { ownerCount, live: inventory.filter(row => row.status === 200).length,
        evicted: inventory.filter(row => row.status === 410).map(row => row.userID), inventory };
}

export function emptyCapacityScenario(context) {
    const pager = createRankingPager({ now: () => 0 });
    const useful = handle(pager, 'pageable-owner');
    const emptyHandles = [];
    for (let owner = 1; owner <= 12; owner++) {
        const userID = `empty-owner-${owner}`;
        const data = fixture({ benchmarks: context === 'workspace' ? 0 : 1, models: 0, families: 0 });
        const response = pager.create(data, { userID, query: context === 'search' ? 'absent-needle' : '' });
        emptyHandles.push({ userID, snapshotID: response.rankingPagination.snapshotID });
    }
    const args = context === 'fallback' ? { list: 'fallbacks', conditionID: 1 }
        : context === 'search' ? { list: 'benchmarks', group: 'primary', query: 'absent-needle' }
            : context === 'group' ? { list: 'benchmarks', group: 'lowCoverage', groupVersions: true }
                : { list: 'public' };
    const emptyPages = emptyHandles.map(current => pager.getPage({ ...current, ...args }));
    return { context, distinctOwners: 13, usefulOwnerStatus: attempt(pager, { ...useful, list: 'public', offset: 25 }).status,
        liveEmptySnapshots: emptyPages.length, allEmpty: emptyPages.every(page => page.items.length === 0 && !page.hasMore),
        interpretation: 'Empty contexts still consume the shared capacity; query/filter changes can need the snapshot later.' };
}

function drain(pager, current, list, extra = {}) {
    let offset = 0;
    const IDs = [];
    let requests = 0;
    while (true) {
        const args = { snapshotID: current.snapshotID, userID: current.userID, list, offset, ...extra };
        const response = pager.getPage(args);
        validateRankingPagePayload(response, { ...args, scoreMode: 'range',
            grouping: extra.query || extra.groupVersions ? 'versions' : 'flat' });
        IDs.push(...response.items.map(row => list === 'fallbacks' ? row.familyKey : row.ID));
        requests++;
        if (!response.hasMore) break;
        assert.ok(response.nextOffset > offset);
        offset = response.nextOffset;
    }
    assert.equal(new Set(IDs).size, IDs.length);
    return { rows: IDs.length, requests };
}

export function continuationScenario() {
    const pager = createRankingPager({ now: () => 0 });
    const owners = [];
    for (let index = 1; index <= 13; index++) {
        const current = handle(pager, `owner-${index}`, fixture({ benchmarks: 337, models: 401, families: 53 }));
        const pages = [
            drain(pager, current, 'public'), drain(pager, current, 'personal'),
            drain(pager, current, 'benchmarks', { group: 'primary' }),
            drain(pager, current, 'benchmarks', { group: 'primary', query: 'benchmark' }),
            drain(pager, current, 'fallbacks', { conditionID: 1 })
        ];
        for (let query = 0; query < 70; query++) {
            const args = { snapshotID: current.snapshotID, userID: current.userID,
                list: 'benchmarks', group: 'primary', query: `no-match-${query}` };
            validateRankingPagePayload(pager.getPage(args), { ...args, offset: 0, grouping: 'versions' });
        }
        owners.push({ ...current, pages, queryContexts: 70 });
    }
    return { owners: owners.map(({ userID, pages, queryContexts }) => ({ userID, pages, queryContexts })),
        successfulRequests: owners.reduce((sum, row) => sum + row.pages.reduce((count, page) => count + page.requests, 0)
            + row.queryContexts, 0), inventory: statusInventory(pager, owners) };
}

export function activeRecencyScenario() {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const active = handle(pager, 'active');
    const peers = [];
    for (let index = 1; index <= 24; index++) {
        time += 1000;
        assert.equal(pager.getPage({ ...active, list: 'public', offset: 25 }).items[0].rank, 26);
        peers.push(handle(pager, `peer-${index}`));
    }
    return { activeStatus: attempt(pager, { ...active, list: 'public', offset: 25 }).status,
        peerInventory: statusInventory(pager, peers) };
}

export function unauthorizedScenario() {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const handles = Array.from({ length: 12 }, (_, index) => handle(pager, `owner-${index + 1}`));
    const forbidden = attempt(pager, { ...handles[0], userID: 'other-owner', list: 'public' });
    handle(pager, 'owner-13');
    const capacityStatus = attempt(pager, { ...handles[0], list: 'public' }).status;
    const expiringPager = createRankingPager({ now: () => time });
    const expiring = handle(expiringPager, 'expiry-owner');
    time = policy.ttlMs - 1;
    const expiryForbidden = attempt(expiringPager, { ...expiring, userID: 'other-owner', list: 'public' });
    time = policy.ttlMs;
    return { forbidden, capacityStatus, expiryForbidden,
        expiryStatus: attempt(expiringPager, { ...expiring, list: 'public' }).status };
}

export function emptyRenewalScenario(context) {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const current = handle(pager, 'empty-owner', fixture({ benchmarks: 1, models: 0, families: 0 }));
    const filters = {
        models: { list: 'public' },
        group: { list: 'benchmarks', group: 'lowCoverage', groupVersions: true },
        search: { list: 'benchmarks', group: 'primary', query: 'absent-needle' },
        fallback: { list: 'fallbacks', conditionID: 1 }
    };
    const args = { ...current, offset: 0, ...filters[context] };
    time = policy.ttlMs - 1;
    const empty = pager.getPage(args);
    validateRankingPagePayload(empty, { ...args, scoreMode: 'range',
        grouping: args.query || args.groupVersions ? 'versions' : 'flat' });
    time = policy.ttlMs + 1;
    const stillLive = attempt(pager, args);
    time += policy.ttlMs;
    return { context, emptyRows: empty.items.length, hasMore: empty.hasMore,
        statusAfterOriginalExpiry: stillLive.status, statusAtSlidingBoundary: attempt(pager, args).status };
}

export function successfulRenewalScenario(list) {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const current = handle(pager, 'successful-owner');
    const args = { ...current, list,
        ...list === 'benchmarks' ? { group: 'primary', offset: 40 } : list === 'fallbacks'
            ? { conditionID: 1, offset: 5 } : { offset: 25 } };
    time = policy.ttlMs - 1;
    const response = pager.getPage(args);
    validateRankingPagePayload(response, { ...args, scoreMode: 'range', grouping: 'flat' });
    time = policy.ttlMs + 1;
    const live = attempt(pager, args);
    time += policy.ttlMs;
    return { list, rows: response.items.length, statusAfterOriginalExpiry: live.status,
        statusAtSlidingBoundary: attempt(pager, args).status };
}

export function constructionFailureScenario() {
    function setup(clock) {
        const pager = createRankingPager({ now: clock });
        const data = fixture();
        const name = data.benchmarks[0].name;
        const searchValue = { fail: false, toString() {
            if (this.fail) throw new Error('synthetic_page_build_failure');
            return name;
        }, localeCompare(other) { return name.localeCompare(String(other)); } };
        data.benchmarks[0].name = searchValue;
        const first = handle(pager, 'owner-1', data);
        const peers = Array.from({ length: 11 }, (_, index) => handle(pager, `owner-${index + 2}`));
        searchValue.fail = true;
        return { pager, first, peers };
    }
    function fail({ pager, first }) {
        let failure;
        try { pager.getPage({ ...first, list: 'benchmarks', group: 'primary', query: 'benchmark' }); }
        catch (error) { failure = { name: error.name, message: error.message }; }
        assert.equal(failure?.message, 'synthetic_page_build_failure');
        return failure;
    }
    let time = 0;
    const ttl = setup(() => time);
    time = policy.ttlMs - 1;
    const failure = fail(ttl);
    time = policy.ttlMs + 1;
    const statusAfterOriginalExpiry = attempt(ttl.pager, { ...ttl.first, list: 'public' }).status;
    const capacity = setup(() => 0);
    fail(capacity);
    handle(capacity.pager, 'owner-13');
    return { failure, statusAfterOriginalExpiry,
        failedOwnerStatus: attempt(capacity.pager, { ...capacity.first, list: 'public' }).status,
        untouchedOwnerStatus: attempt(capacity.pager, { ...capacity.peers[0], list: 'public' }).status };
}

function rejectedRequest(kind, current) {
    if (kind === 'missing-fallback') return { ...current, list: 'fallbacks', conditionID: 99999 };
    if (kind === 'cleaned-fallback') return { ...current, list: 'fallbacks', conditionID: 1, offset: 5 };
    if (kind === 'cleaned-search') return { ...current, list: 'benchmarks', group: 'primary', query: 'benchmark', offset: 40 };
    throw new Error(`Unknown rejection ${kind}`);
}

export function rejectedRefreshScenario(kind) {
    function setup(clock) {
        const pager = createRankingPager({ now: clock });
        const handles = Array.from({ length: 12 }, (_, index) => handle(pager, `owner-${index + 1}`));
        if (kind.startsWith('cleaned-')) pager.retainReferencedFamilies([]);
        return { pager, handles };
    }
    let time = 0;
    const ttl = setup(() => time);
    time = policy.ttlMs - 1;
    const rejectedAtBoundary = attempt(ttl.pager, rejectedRequest(kind, ttl.handles[0]));
    time = policy.ttlMs + 1;
    const liveAfterRejectedRequest = attempt(ttl.pager, { ...ttl.handles[0], list: 'public', offset: 25 });
    const eviction = setup(() => 0);
    const rejectedForRecency = attempt(eviction.pager, rejectedRequest(kind, eviction.handles[0]));
    handle(eviction.pager, 'owner-13');
    return { kind, rejectedAtBoundary, statusAfterOriginalExpiry: liveAfterRejectedRequest.status,
        rejectedForRecency, failedOwnerStatus: attempt(eviction.pager, { ...eviction.handles[0], list: 'public' }).status,
        untouchedOwnerStatus: attempt(eviction.pager, { ...eviction.handles[1], list: 'public' }).status };
}

export function invalidValidationScenario() {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const current = handle(pager, 'validation-owner');
    time = policy.ttlMs - 1;
    const invalid = [
        { offset: -1 }, { list: 'unknown' }, { group: 'unknown', list: 'benchmarks' },
        { list: 'fallbacks', conditionID: 0 }, { query: 'x'.repeat(121) }, { pinPersonal: 'true' }
    ].map(filters => attempt(pager, { ...current, list: 'public', ...filters }).status);
    time = policy.ttlMs;
    return { invalidStatuses: invalid, statusAtOriginalExpiry: attempt(pager, { ...current, list: 'public' }).status };
}

export function cleanupScenario() {
    const data = fixture({ benchmarks: 83, families: 17, entrances: [1, 2] });
    const guestFamily = data.benchmarks.find(row => row.isFamily && row.conditionID === 1);
    guestFamily.familyID = null;
    const familyIDs = data.benchmarks.filter(row => row.isFamily).map(row => row.familyID);
    const removed = data.benchmarks.find(row => row.isFamily && row.conditionID === 2);
    removed.publicWeightBasisPoints = 300;
    removed.publicWeight = 3;
    removed.familyEntries[0].name = 'Retiring component only';
    const pager = createRankingPager({ now: () => 0 });
    const current = handle(pager, 'cleanup-owner', data);
    const fallbackArgs = { ...current, list: 'fallbacks', conditionID: 1 };
    const searchArgs = { ...current, list: 'benchmarks', group: 'primary', query: 'benchmark' };
    const beforeFallback = pager.getPage({ ...fallbackArgs, offset: 5 });
    const beforeSearch = pager.getPage({ ...searchArgs, offset: 40 });
    const beforeRemovedTerm = pager.getPage({ ...searchArgs, query: 'retiring component' });
    const beforeFeatured = pager.getPage({ ...fallbackArgs, conditionID: 2 }).featuredFallbackConfigurations.length;
    pager.retainReferencedFamilies(familyIDs.filter(ID => ID !== removed.familyID));
    const freshFallback = pager.getPage({ ...fallbackArgs, offset: 0 });
    const freshSearch = pager.getPage({ ...searchArgs, offset: 0 });
    const fallbackContinuation = attempt(pager, { ...fallbackArgs, offset: freshFallback.nextOffset });
    const searchContinuation = attempt(pager, { ...searchArgs, offset: freshSearch.nextOffset });
    const otherEntrance = pager.getPage({ ...fallbackArgs, conditionID: 2, offset: 0 });
    const afterRemovedTerm = pager.getPage({ ...searchArgs, query: 'retiring component' });
    const guestSurvives = pager.getPage(fallbackArgs).items.some(row => row.familyID === null);
    return { removedEntrance: removed.conditionID, unaffectedEntrance: 1,
        beforeFallbackRows: beforeFallback.items.length, freshFallbackRows: freshFallback.items.length,
        unaffectedFallbackTotal: freshFallback.total, fallbackContinuation,
        beforeSearchRows: beforeSearch.items.length, freshSearchRows: freshSearch.items.length,
        searchTotal: freshSearch.total, searchContinuation,
        ordinaryContinuationStatus: attempt(pager, { ...current, list: 'benchmarks', group: 'primary', offset: 40 }).status,
        modelContinuationStatus: attempt(pager, { ...current, list: 'public', offset: 25 }).status,
        changedEntranceTotal: otherEntrance.total, guestSurvives, beforeFeatured,
        afterFeatured: otherEntrance.featuredFallbackConfigurations.length,
        beforeRemovedTermTotal: beforeRemovedTerm.total, afterRemovedTermTotal: afterRemovedTerm.total };
}

export function cleanupRecencyScenario() {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const current = handle(pager, 'expiry-owner');
    time = policy.ttlMs - 1;
    pager.retainReferencedFamilies([]);
    time = policy.ttlMs;
    const expiryStatus = attempt(pager, { ...current, list: 'public' }).status;
    const capacityPager = createRankingPager({ now: () => 0 });
    const handles = Array.from({ length: 12 }, (_, index) => handle(capacityPager, `owner-${index + 1}`));
    capacityPager.retainReferencedFamilies([]);
    const liveAfterCleanup = statusInventory(capacityPager, handles).filter(row => row.status === 200).length;
    handle(capacityPager, 'owner-13');
    return { expiryStatus, liveAfterCleanup, oldestStatus: attempt(capacityPager, { ...handles[0], list: 'public' }).status,
        secondStatus: attempt(capacityPager, { ...handles[1], list: 'public' }).status };
}

export function expiredCleanupScenario() {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const counters = [];
    const familyIDs = [];
    for (let owner = 1; owner <= 12; owner++) {
        const data = fixture({ benchmarks: 2, models: 0, families: 4 });
        const count = { owner, isFamilyReads: 0 };
        counters.push(count);
        for (const row of data.benchmarks) {
            const isFamily = row.isFamily;
            if (isFamily) familyIDs.push(row.familyID);
            Object.defineProperty(row, 'isFamily', { enumerable: true, get() { count.isFamilyReads++; return isFamily; } });
        }
        handle(pager, `owner-${owner}`, data);
    }
    for (const count of counters) count.isFamilyReads = 0;
    time = policy.ttlMs + 1;
    pager.retainReferencedFamilies(familyIDs);
    const afterExpiry = counters.map(row => ({ ...row }));
    for (const count of counters) count.isFamilyReads = 0;
    handle(pager, 'replacement', fixture({ benchmarks: 1, models: 0, families: 0 }));
    pager.retainReferencedFamilies(familyIDs);
    return { expiredOwnersVisited: afterExpiry.filter(row => row.isFamilyReads > 0).length,
        expiredRowReads: afterExpiry.reduce((sum, row) => sum + row.isFamilyReads, 0), afterExpiry,
        oldRowReadsAfterCreatePrune: counters.reduce((sum, row) => sum + row.isFamilyReads, 0),
        measurement: 'Synthetic getters observe original catalogue reachability, not heap size or GC timing.' };
}

export function failedCreateScenario(phase) {
    function setup() {
        const pager = createRankingPager({ now: () => 0 });
        const handles = Array.from({ length: 12 }, (_, index) => handle(pager, `owner-${index + 1}`));
        const malformed = fixture();
        const options = { userID: 'failed-owner' };
        if (phase === 'before-insert') malformed.personalPie = null;
        else if (phase === 'after-insert') malformed.modelLeaderboards.public[0].lower = NaN;
        else if (phase === 'benchmark-page') {
            options.query = 'benchmark';
            const name = malformed.benchmarks[0].name;
            malformed.benchmarks[0].name = { toString() { throw new Error('synthetic_create_page_failure'); },
                localeCompare(other) { return name.localeCompare(String(other)); } };
        } else if (phase === 'response-spread') {
            Object.defineProperty(malformed, 'syntheticMetadata', { enumerable: true,
                get() { throw new Error('synthetic_response_build_failure'); } });
        } else throw new Error(`Unknown create failure ${phase}`);
        let failure;
        try { pager.create(malformed, options); }
        catch (error) { failure = { name: error.name, message: error.message }; }
        assert.ok(failure);
        return { pager, handles, failure };
    }
    const health = setup();
    const oldestImmediatelyAfterFailureStatus = attempt(health.pager, { ...health.handles[0], list: 'public' }).status;
    const readableImmediatelyAfterFailure = statusInventory(health.pager, health.handles).filter(row => row.status === 200).length;
    // A separate pager avoids the health probes changing the eviction-order evidence.
    const capacity = setup();
    handle(capacity.pager, 'owner-13');
    const inventory = statusInventory(capacity.pager, capacity.handles);
    return { phase, failure: health.failure, oldestImmediatelyAfterFailureStatus, readableImmediatelyAfterFailure, inventory,
        evicted: inventory.filter(row => row.status === 410).map(row => row.userID),
        reachableOriginalOwners: inventory.filter(row => row.status === 200).length,
        interpretation: 'Independent health and capacity controls isolate failed preparation from successful reads.' };
}

export function invalidCreateScenario() {
    const pager = createRankingPager({ now: () => 0 });
    const handles = Array.from({ length: 12 }, (_, index) => handle(pager, `owner-${index + 1}`));
    const attempts = [
        { options: { initialMode: 'unknown' } }, { options: { query: 'x'.repeat(121) } },
        { options: { pinPersonal: 'true' } }, { options: { groupVersions: 'true' } },
        { mutate: data => { delete data.benchmarks[0].lowCoverage; } }
    ];
    const errors = attempts.map(({ options, mutate }) => {
        const data = fixture();
        mutate?.(data);
        try { pager.create(data, options); assert.fail('Invalid create must fail'); }
        catch (error) { assert.ok(error.status); return { status: error.status, error: error.body.error }; }
    });
    return { errors, readableOwners: statusInventory(pager, handles).filter(row => row.status === 200).length };
}

export function repeatedFailedCreateScenario() {
    const pager = createRankingPager({ now: () => 0 });
    const handles = Array.from({ length: 12 }, (_, index) => handle(pager, `owner-${index + 1}`));
    let failures = 0;
    for (let index = 0; index < 24; index++) {
        const data = fixture();
        if (index % 2) data.personalPie = null;
        else data.modelLeaderboards.public[0].upper = NaN;
        assert.throws(() => pager.create(data), TypeError);
        failures++;
    }
    handle(pager, 'owner-13');
    const inventory = statusInventory(pager, handles);
    return { failures, readableOriginalOwners: inventory.filter(row => row.status === 200).length,
        evicted: inventory.filter(row => row.status === 410).map(row => row.userID) };
}

export function creationDeadlineScenario() {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const data = fixture();
    Object.defineProperty(data, 'syntheticBuildDelay', { enumerable: true,
        get() { time = policy.ttlMs * 2; return true; } });
    const current = handle(pager, 'creation-owner', data);
    return { commitTime: time, statusImmediatelyAfterCreate: attempt(pager, { ...current, list: 'public' }).status };
}

export function tieScenario() {
    const pager = createRankingPager({ now: () => 0 });
    const data = fixture({ models: 38 });
    const tied = data.modelLeaderboards.public[25];
    tied.lower = data.modelLeaderboards.public[24].lower;
    tied.upper = tied.lower;
    tied.calculationScores[0].normalizedScore = tied.lower;
    tied.calculationScores[0].contribution = tied.lower;
    const current = handle(pager, 'tie-owner', data);
    const next = pager.getPage({ ...current, list: 'public', offset: 25 });
    validateRankingPagePayload(next, { list: 'public', offset: 25, scoreMode: 'range' });
    return { firstPageLastRank: current.response.modelLeaderboards.public.at(-1).rank,
        continuationRanks: next.items.slice(0, 2).map(row => row.rank),
        uniqueIDs: new Set([...current.response.modelLeaderboards.public, ...next.items].map(row => row.ID)).size,
        total: next.total };
}

export function ownerIsolationScenario() {
    const pager = createRankingPager({ now: () => 0 });
    const owner = handle(pager, '9007199254740992', fixture({ owner: 'private-A' }));
    const foreign = attempt(pager, { ...owner, userID: '9007199254740993', list: 'personal' });
    const foreignListStatuses = [{ list: 'personal' }, { list: 'public' }, { list: 'benchmarks', group: 'primary' },
        { list: 'fallbacks', conditionID: 1 }].map(args => attempt(pager, { ...owner,
        userID: '9007199254740993', ...args }).status);
    const matching = pager.getPage({ ...owner, list: 'personal' });
    const numeric = handle(pager, 7);
    const numericStringStatus = attempt(pager, { ...numeric, userID: '7', list: 'personal' }).status;
    const guest = handle(pager, null, fixture({ owner: 'guest-draft' }));
    const guestByPossession = pager.getPage({ snapshotID: guest.snapshotID, list: 'personal' });
    return { distinctLargeStringOwners: foreign, foreignListStatuses, matchingOwnerRows: matching.items.length,
        containsOnlyMatchingOwner: matching.items.every(row => row.name.startsWith('private-A')),
        numericStringStatus, guestBySnapshotPossession: guestByPossession.items[0].name,
        guestSemantics: 'All null owners share a UUID capability domain; this does not prove UUID discovery or account leakage.' };
}

export async function recoveryCycleScenario(ownerCount, list = 'public', rounds = 3) {
    const source = await readFile(path.join(root, 'public/js/home-workspace.js'), 'utf8');
    const start = source.indexOf('async function loadNextRankingPage(');
    const end = source.indexOf('function reloadBenchmarkPage(', start);
    assert.ok(start >= 0 && end > start);
    const caller = source.slice(start, end);
    const invalidatorStart = source.indexOf('function invalidateRankingPages()');
    assert.ok(invalidatorStart >= 0 && invalidatorStart < start);
    const invalidator = source.slice(invalidatorStart, start);
    const pager = createRankingPager({ now: () => 0 });
    const records = [];
    for (let owner = 1; owner <= ownerCount; owner++) {
        const userID = `owner-${owner}`;
        const data = fixture({ owner: userID, benchmarks: 337, models: 401 });
        const first = pager.create(data, { userID });
        const state = { loading: false, loadSequence: 0, mode: 'public', scoreMode: 'range', benchmarks: first.benchmarks,
            rankingPagination: first.rankingPagination, modelLeaderboards: first.modelLeaderboards,
            rankingPageSequence: { public: 0, benchmarks: 0, benchmarkOther: 0, benchmarkLow: 0 },
            rankingPageLoading: {}, rankingPageError: {}, benchmarkDetailsByID: new Map() };
        const record = { userID, state, refreshes: 0, pageStatuses: [], loadedCounts: [], refreshOptions: [] };
        const api = vm.runInNewContext(`${invalidator}\n${caller}\n({ load: loadNextRankingPage, invalidate: invalidateRankingPages });`, {
            state, workspaceLoadFailed: false, benchmarkPageKey: group => group === 'primary' ? 'benchmarks' : group,
            benchmarkSearch: { value: '' }, BENCHMARK_GROUPS: ['primary', 'other', 'lowCoverage'],
            renderBenchmarks() {}, renderModels() {}, renderBenchmarkSummary() {}, loadVisibleBenchmarkPage() {},
            window: { queueMicrotask() {} }, validateRankingPagePayload, captureRankingResume, comparisonProfileKey,
            workspaceContextFingerprint: () => `synthetic:${userID}`,
            currentBenchmarkFilters: () => ({ benchmarkQuery: '', pinPersonal: false, groupVersions: false }),
            benchmarkFallbackCatalogue: { progress: () => [] },
            async postJSON(route, args) {
                assert.equal(route, '/api/get_ranking_page');
                const outcome = attempt(pager, { ...args, userID });
                record.pageStatuses.push(outcome.status);
                if (outcome.status !== 200) throw { status: outcome.status, payload: { error: outcome.error } };
                return outcome.page;
            },
            async loadWeightedWorkspace(options) {
                record.refreshes++;
                record.refreshOptions.push(structuredClone(options));
                state.loadSequence++;
                const replacement = pager.create(data, { userID, resume: options.pageRecovery?.resume });
                record.invalidate();
                state.rankingPagination = replacement.rankingPagination;
                state.modelLeaderboards = replacement.modelLeaderboards;
                state.benchmarks = replacement.benchmarks;
            }
        });
        record.load = api.load;
        record.invalidate = api.invalidate;
        records.push(record);
    }
    for (let round = 0; round < rounds; round++) {
        for (const record of records) {
            await record.load(list);
            record.loadedCounts.push(list === 'benchmarks' ? record.state.benchmarks.length : record.state.modelLeaderboards.public.length);
        }
    }
    return { ownerCount, list, rounds, totalRefreshes: records.reduce((sum, row) => sum + row.refreshes, 0),
        records: records.map(({ userID, refreshes, pageStatuses, loadedCounts, refreshOptions }) =>
            ({ userID, refreshes, pageStatuses, loadedCounts, refreshOptions })),
        executedCaller: { file: 'public/js/home-workspace.js', sha256: sha256(caller),
            invalidatorSHA256: sha256(invalidator),
            note: 'Exact unmodified page-loader and invalidator bodies, real pager and page validator; replacement workspace callback is offline.' },
        boundary: 'Deterministic fair-owner ordering demonstrates lost progress, not production concurrency, latency, or rate.' };
}

class ReviewElement {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = new Map(); this.parts = new Map(); }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    querySelector(key) { if (!this.parts.has(key)) this.parts.set(key, new ReviewElement(key)); return this.parts.get(key); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    focus() {}
}

export async function fallbackCallerScenario(kind) {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const current = handle(pager, 'fallback-owner');
    if (kind === 'eviction') for (let owner = 0; owner < 12; owner++) handle(pager, `peer-${owner}`);
    if (kind === 'expiry') time = policy.ttlMs;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const statuses = [];
    let refreshes = 0;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        createElement: tag => new ReviewElement(tag), getElementById: () => null
    } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        matchMedia: () => ({ matches: true }), queueMicrotask
    } });
    try {
        const catalogue = createBenchmarkFallbackCatalogue({
            async request(args) {
                const outcome = attempt(pager, { ...args, userID: kind === 'forbidden' ? 'different-owner' : current.userID });
                statuses.push(outcome.status);
                if (outcome.status !== 200) throw { status: outcome.status, payload: { error: outcome.error } };
                return outcome.page;
            }, onChange() {}, onExpired() { refreshes++; }
        });
        catalogue.setSnapshot(current.snapshotID);
        if (catalogue.load) await catalogue.load(current.response.benchmarks[0].ID);
        else {
            const section = catalogue.create(current.response.benchmarks[0], () => new ReviewElement('row'));
            section.children[0].listeners.get('click')();
        }
        await new Promise(resolve => setImmediate(resolve));
        return { kind, statuses, refreshes, executed: 'Actual createBenchmarkFallbackCatalogue export; minimal inert DOM only.' };
    } finally {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete globalThis.document;
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete globalThis.window;
    }
}

async function captureSources() {
    const files = [];
    for (const file of inspectedFiles) {
        const bytes = await readFile(path.join(root, file));
        files.push({ file, bytes: bytes.length, sha256: sha256(bytes), text: bytes.toString('utf8') });
    }
    return files;
}

function anchor(sources, file, text) {
    const source = sources.find(row => row.file === file).text;
    const index = source.indexOf(text);
    assert.ok(index >= 0, `Missing review anchor ${file}: ${text}`);
    return `${file}:${source.slice(0, index).split('\n').length}`;
}

function verifyFixedResults(report) {
    const result = id => report.scenarios.find(row => row.id === id).result;
    const checks = [];
    function check(id, action) {
        try { action(); checks.push({ id, passed: true }); }
        catch (error) { checks.push({ id, passed: false, error: error.message }); }
    }
    for (const kind of ['missing-fallback', 'cleaned-fallback', 'cleaned-search']) {
        check(`rejected-${kind}`, () => {
            const row = result(`rejected-${kind}`);
            assert.equal(row.statusAfterOriginalExpiry, 410);
            assert.equal(row.failedOwnerStatus, 410);
            assert.equal(row.untouchedOwnerStatus, 200);
        });
    }
    check('construction-failure', () => {
        const row = result('construction-failure');
        assert.equal(row.statusAfterOriginalExpiry, 410);
        assert.equal(row.failedOwnerStatus, 410);
        assert.equal(row.untouchedOwnerStatus, 200);
    });
    check('expired-cleanup', () => {
        const row = result('expired-cleanup');
        assert.equal(row.expiredOwnersVisited, 0);
        assert.equal(row.expiredRowReads, 0);
    });
    for (const phase of ['before-insert', 'after-insert', 'benchmark-page', 'response-spread']) {
        check(`failed-create-${phase}`, () => {
            const row = result(`failed-create-${phase}`);
            assert.equal(row.oldestImmediatelyAfterFailureStatus, 200);
            assert.equal(row.readableImmediatelyAfterFailure, 12);
            assert.equal(row.reachableOriginalOwners, 11);
            assert.deepEqual(row.evicted, ['owner-1']);
        });
    }
    check('invalid-create', () => assert.equal(result('invalid-create').readableOwners, 12));
    check('repeated-failed-create', () => {
        assert.deepEqual(result('repeated-failed-create').evicted, ['owner-1']);
        assert.equal(result('repeated-failed-create').readableOriginalOwners, 11);
    });
    for (const count of [13, 24]) check(`capacity-${count}`, () => assert.equal(result(`capacity-${count}`).live, 12));
    for (const list of ['personal', 'public', 'benchmarks', 'fallbacks']) {
        check(`successful-renewal-${list}`, () => {
            const row = result(`successful-renewal-${list}`);
            assert.ok(row.rows > 0);
            assert.equal(row.statusAfterOriginalExpiry, 200);
            assert.equal(row.statusAtSlidingBoundary, 410);
        });
    }
    check('owner-isolation', () => assert.deepEqual(result('owner-isolation').foreignListStatuses, [403, 403, 403, 403]));
    check('cleanup-live-capacity', () => assert.equal(result('cleanup-recency').liveAfterCleanup, 12));
    check('creation-deadline', () => assert.equal(result('creation-deadline').statusImmediatelyAfterCreate, 200));
    check('ties', () => {
        assert.equal(result('ties').firstPageLastRank, 25);
        assert.deepEqual(result('ties').continuationRanks, [25, 27]);
        assert.equal(result('ties').uniqueIDs, 38);
    });
    for (const [count, list, size] of [[13, 'public', 25], [13, 'benchmarks', 40], [24, 'public', 25]]) {
        check(`recovery-${count}-${list}`, () => {
            for (const row of result(`recovery-${count}-${list}`).records) {
                assert.deepEqual(row.loadedCounts, [size * 2, size * 3, size * 4]);
            }
        });
    }
    return { requested: report.expectFixed, passed: checks.every(row => row.passed), checks };
}

async function verifyPreservedEvidence() {
    const baseline = JSON.parse(await readFile(path.join(root, beforeFixesFile), 'utf8'));
    const differences = [];
    for (const row of baseline.artifacts) {
        const actual = sha256(await readFile(path.join(root, row.file)));
        if (actual !== row.sha256) differences.push({ file: row.file, before: row.sha256, after: actual });
    }
    return { baselineFile: beforeFixesFile, originalFinalRuns, checkedArtifacts: baseline.artifacts.length,
        preserved: differences.length === 0, differences };
}

function sameBaselineFields(expected, actual) {
    if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
        && expected.every((value, index) => sameBaselineFields(value, actual[index]));
    if (expected && typeof expected === 'object') return actual && typeof actual === 'object'
        && Object.keys(expected).every(key => sameBaselineFields(expected[key], actual[key]));
    return Object.is(expected, actual);
}

async function compareBaselineControls(report) {
    const baselineFile = `artifacts/review-20261008/snapshot-capacity-${originalFinalRuns[1]}-results.json`;
    const baseline = JSON.parse(await readFile(path.join(root, baselineFile), 'utf8'));
    const controls = ['capacity-13', 'capacity-24', 'capacity-empty-workspace', 'capacity-empty-group',
        'capacity-empty-search', 'capacity-empty-fallback', 'active-recency', 'unauthorized', 'continuations',
        'empty-models', 'empty-group', 'empty-search', 'empty-fallback', 'invalid-validation',
        'cleanup', 'cleanup-recency', 'owner-isolation', 'fallback-caller-eviction',
        'fallback-caller-expiry', 'fallback-caller-forbidden'];
    return { baselineFile, rule: 'Compare unchanged pager control fields; progress recovery is intentionally changed and asserted separately.',
        controls: controls.map(id => ({ id, unchanged: sameBaselineFields(
            baseline.scenarios.find(row => row.id === id).result,
            report.scenarios.find(row => row.id === id).result) })) };
}

function reportMarkdown(report, sources) {
    const pager = text => anchor(sources, 'ranking-pagination.js', text);
    const result = id => report.scenarios.find(row => row.id === id).result;
    const rejected = ['missing-fallback', 'cleaned-fallback', 'cleaned-search'].map(kind => result(`rejected-${kind}`));
    const failures = ['before-insert', 'after-insert', 'benchmark-page', 'response-spread']
        .map(phase => result(`failed-create-${phase}`));
    const cycle = result('recovery-13-public');
    return `# Snapshot Capacity After-Fix Review\n\n`
        + `- Run: ${report.runID}; --expect-fixed: ${report.expectFixed}; fixed expectations passed: ${report.expectations.passed}.\n`
        + '- Scope: current pager and frontend recovery control flow with synthetic replacement workspaces. No production, DB, auth or network operations. Existing DB-related unit helpers use their own mocks only.\n'
        + `- Runtime: ${report.environment.node}; branch ${report.environment.branch}; commit ${report.environment.commit}; current dirty working tree preserved.\n`
        + `- Source hashes stable during execution: ${report.sourcesUnchanged}. Original evidence checked: ${report.preservation.checkedArtifacts}; unchanged: ${report.preservation.preserved}.\n\n`
        + `## Implemented Fixes\n\n`
        + `1. Successful-page-only touch: ${pager('function touch(')}, ${pager('touch(snapshotID, snapshot);')}. Read checks expiry/owner without refreshing; fallback/search construction and offset rejection happen before the single successful-page touch. For 404/410 rejection controls, status after original expiry is ${rejected.map(row => row.statusAfterOriginalExpiry).join('/')}; failed owner capacity status is ${rejected.map(row => row.failedOwnerStatus).join('/')}, untouched peer status is ${rejected.map(row => row.untouchedOwnerStatus).join('/')}. A throwing search-page builder has the same no-touch behavior. Successful nonempty/empty model, benchmark, search and fallback controls still renew the sliding deadline.\n`
        + `2. Separate expiry and capacity: ${pager('function pruneExpired(')}, ${pager('function evictForInsert(')}. Reads and global family cleanup sweep expired snapshots only; eviction reserves a slot only for a prepared create. Cleanup after TTL visits ${result('expired-cleanup').expiredOwnersVisited} old catalogues / ${result('expired-cleanup').expiredRowReads} original rows (before: 12 / 72). A live 12-entry cleanup leaves all ${result('cleanup-recency').liveAfterCleanup} handles usable. Capacity remains 12, not a byte/row guarantee.\n`
        + `3. Atomic creation: ${pager('const result = {')}, ${pager('const time = now();')}, ${pager('snapshots.set(snapshotID, snapshot);')}. Full catalogue, initial pages, response object and both score scales are prepared before expiry assignment, pruning, eviction and insertion. Early weight failure, late score validation failure, initial search failure and response-spread failure all leave ${failures.map(row => row.readableImmediatelyAfterFailure).join('/')} handles usable. The next valid create evicts only owner 1 in each independent capacity control. ${result('repeated-failed-create').failures} repeated failures do not leave ghost slots or change healthy-owner eviction priority. The TTL begins at successful commit, not before potentially failing preparation.\n\n`
        + `## Preserved Controls\n\n`
        + `- Original final1/final2: ${originalFinalRuns.join(', ')}. Their sources, results, reports and raw TAP remain unchanged. Preservation manifest: ${beforeFixesFile}.\n`
        + `- Original-field baseline comparisons: ${report.baselineControls.controls.filter(row => row.unchanged).length}/${report.baselineControls.controls.length} unchanged. Includes 13/24-owner bounds, active LRU, foreign owners, empty contexts, search/fallback cleanup and guest families. Progress recovery changes are separately asserted.\n`
        + `- ${result('continuations').successfulRequests} successful real page/query calls drain public/personal/benchmark/search/fallback lists without duplicate IDs; no throughput claim.\n`
        + `- Tie control: first-page tail rank ${result('ties').firstPageLastRank}, next ranks ${result('ties').continuationRanks.join(', ')}, ${result('ties').uniqueIDs} unique model IDs. Relevant existing pager/fallback/lifecycle tests also run unchanged.\n\n`
        + `## Remaining Risks\n\n`
        + `- Current 13-owner recovery performs ${cycle.totalRefreshes} refreshes in ${cycle.rounds} rounds but now advances through ${cycle.records[0].loadedCounts.join('/')} rows. Lost progress is repaired; repeated recomputation under sustained eviction and byte-bounded retention remain performance risks. Capacity is unchanged.\n`
        + `- Cleanup still uses a sticky snapshot-wide family-offset flag; unaffected fallback/search continuations may still return 410. This conservative consistency behavior was deliberately retained.\n`
        + `- No idle timer: expiry is reclaimed on valid reads, successful creation or family cleanup. Count remains bounded at 12, but full catalogues/models/traces have no byte limit. No production OOM or latency/concurrency claim.\n`
        + `- Authenticated owner matching remains exact; anonymous null owners remain UUID capabilities, not session-bound. No credential/session operations or authenticated leak demonstration.\n`
        + `- Failure injection uses synthetic producer inputs. Commit is atomic for synchronous preparation exceptions, not an assertion about OOM or later response serialization outside the pager.\n\n`
        + `## Actual Verification\n\n`
        + `- Command: node scripts/review-snapshot-capacity-20261008.mjs${report.expectFixed ? ' --expect-fixed' : ''}.\n`
        + `- Tests: ${report.tests.command}; exit ${report.tests.exitCode}; ${JSON.stringify(report.tests.counts)}.\n`
        + `- Lint: ${report.lint.command}; exit ${report.lint.exitCode}.\n`
        + `- Actual source exports only; original caller bodies executed with offline replacement callbacks. No source transforms/internal cache instrumentation.\n`
        + `- Raw TAP/lint logs and UTF-8 source snapshots are exclusive-create files.\n\n`
        + `## Changed Paths\n\n${report.files.map(file => `- ${file}`).join('\n')}\n`;
}

async function main() {
    const args = process.argv.slice(2);
    assert.ok(args.every(arg => arg === '--expect-fixed'), 'Supported option: --expect-fixed');
    const expectFixed = args.includes('--expect-fixed');
    const runID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const prefix = `snapshot-capacity-${expectFixed ? 'after-' : ''}${runID}`;
    await mkdir(artifactDirectory, { recursive: true });
    const names = ['sources.json', 'results.json', 'report.md', 'tests.tap', 'lint.txt'];
    const files = names.map(name => `artifacts/review-20261008/${prefix}-${name}`);
    const sources = await captureSources();
    assert.match(sources.find(row => row.file === 'ranking-pagination.js').text, /const MAX_SNAPSHOTS = 12;/);
    assert.match(sources.find(row => row.file === 'ranking-pagination.js').text, /const SNAPSHOT_TTL_MS = 15 \* 60 \* 1000;/);
    assert.match(sources.find(row => row.file === 'ranking-pagination.js').text, /snapshot\.benchmarkPages\.size >= 32/);
    assert.match(sources.find(row => row.file === 'public/js/shared/search.js').text, /cache\.size >= 32/);
    await writeFile(path.join(root, files[0]), `${JSON.stringify({ capturedAt: new Date().toISOString(), files: sources }, null, 2)}\n`, { flag: 'wx' });
    const report = { runID, expectFixed, createdAt: new Date().toISOString(), environment: {
        node: process.version, platform: process.platform, osRelease: os.release(),
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
        branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
        target: 'offline synthetic owners against current source exports; dirty worktree preserved'
    }, policy, methodology: {
        revision: 5,
        preservedInitialRun: 'artifacts/review-20261008/snapshot-capacity-2026-10-08T01-53-44-848Z-46772-55004e26-results.json',
        rehearsalNotes: 'artifacts/review-20261008/snapshot-capacity-rehearsal-notes.md',
        correction: 'Use exact frontend invalidateRankingPages body; do not require a fallback entrance in a fixture with zero families.'
    }, files: ['ranking-pagination.js', 'scripts/review-snapshot-capacity-20261008.mjs',
        'test/review-snapshot-capacity-20261008.test.mjs', ...files], scenarios: [] };
    async function record(id, action) { report.scenarios.push({ id, result: await action() }); }
    for (const count of [13, 24]) await record(`capacity-${count}`, () => capacityScenario(count));
    for (const context of ['workspace', 'group', 'search', 'fallback']) {
        await record(`capacity-empty-${context}`, () => emptyCapacityScenario(context));
    }
    await record('active-recency', activeRecencyScenario);
    await record('unauthorized', unauthorizedScenario);
    await record('continuations', continuationScenario);
    for (const context of ['models', 'group', 'search', 'fallback']) await record(`empty-${context}`, () => emptyRenewalScenario(context));
    for (const list of ['personal', 'public', 'benchmarks', 'fallbacks']) {
        await record(`successful-renewal-${list}`, () => successfulRenewalScenario(list));
    }
    for (const kind of ['missing-fallback', 'cleaned-fallback', 'cleaned-search']) await record(`rejected-${kind}`, () => rejectedRefreshScenario(kind));
    await record('invalid-validation', invalidValidationScenario);
    await record('construction-failure', constructionFailureScenario);
    await record('cleanup', cleanupScenario);
    await record('cleanup-recency', cleanupRecencyScenario);
    await record('expired-cleanup', expiredCleanupScenario);
    for (const phase of ['before-insert', 'after-insert', 'benchmark-page', 'response-spread']) {
        await record(`failed-create-${phase}`, () => failedCreateScenario(phase));
    }
    await record('invalid-create', invalidCreateScenario);
    await record('repeated-failed-create', repeatedFailedCreateScenario);
    await record('creation-deadline', creationDeadlineScenario);
    await record('ties', tieScenario);
    await record('owner-isolation', ownerIsolationScenario);
    for (const [count, list] of [[12, 'public'], [13, 'public'], [13, 'benchmarks'], [24, 'public']]) {
        await record(`recovery-${count}-${list}`, () => recoveryCycleScenario(count, list));
    }
    for (const kind of ['eviction', 'expiry', 'forbidden']) await record(`fallback-caller-${kind}`, () => fallbackCallerScenario(kind));
    report.expectations = verifyFixedResults(report);
    report.preservation = await verifyPreservedEvidence();
    report.baselineControls = await compareBaselineControls(report);
    const testArgs = ['--test', '--test-reporter=tap', 'test/review-snapshot-capacity-20261008.test.mjs',
        'test/ranking-pagination.test.mjs', 'test/ranking-page-refresh-contract.test.mjs',
        'test/fallback-discovery.test.mjs', 'test/family-lifecycle.test.mjs'];
    const tests = spawnSync(process.execPath, testArgs, { cwd: root, encoding: 'utf8', windowsHide: true,
        timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    const raw = `$ node ${testArgs.join(' ')}\n${tests.stdout ?? ''}\nSTDERR:\n${tests.stderr ?? ''}`;
    await writeFile(path.join(root, files[3]), raw, { flag: 'wx' });
    const counts = {};
    for (const match of (tests.stdout ?? '').matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) {
        counts[match[1]] = Number(match[2]);
    }
    report.tests = { command: `node ${testArgs.join(' ')}`, exitCode: tests.status, signal: tests.signal,
        error: tests.error?.message ?? null, counts };
    const lintArgs = ['node_modules/eslint/bin/eslint.js', 'ranking-pagination.js',
        'scripts/review-snapshot-capacity-20261008.mjs', 'test/review-snapshot-capacity-20261008.test.mjs'];
    const lint = spawnSync(process.execPath, lintArgs, { cwd: root, encoding: 'utf8', windowsHide: true,
        timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(path.join(root, files[4]), `$ node ${lintArgs.join(' ')}\n${lint.stdout ?? ''}\nSTDERR:\n${lint.stderr ?? ''}`, { flag: 'wx' });
    report.lint = { command: `node ${lintArgs.join(' ')}`, exitCode: lint.status, signal: lint.signal,
        error: lint.error?.message ?? null };
    const after = await captureSources();
    report.sourceFingerprints = sources.map(row => ({ file: row.file, before: row.sha256,
        after: after.find(current => current.file === row.file).sha256 }));
    report.sourcesUnchanged = report.sourceFingerprints.every(row => row.before === row.after);
    report.baselineIntegrity = { sha256: sha256(await readFile(path.join(root, files[0]))), overwritePolicy: 'exclusive-create wx' };
    await writeFile(path.join(root, files[1]), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await writeFile(path.join(root, files[2]), reportMarkdown(report, sources), { flag: 'wx' });
    console.log(JSON.stringify({ runID, files: report.files, sourcesUnchanged: report.sourcesUnchanged,
        expectFixed, expectationsPassed: report.expectations.passed, originalEvidencePreserved: report.preservation.preserved,
        testExitCode: tests.status, testCounts: counts, lintExitCode: lint.status, scenarios: report.scenarios.length }, null, 2));
    if (tests.status !== 0 || tests.error || lint.status !== 0 || lint.error || !report.sourcesUnchanged
        || !report.preservation.preserved || expectFixed && (!report.expectations.passed
        || report.baselineControls.controls.some(row => !row.unchanged))) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
