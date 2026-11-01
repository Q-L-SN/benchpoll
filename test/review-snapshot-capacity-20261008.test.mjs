import assert from 'node:assert/strict';
import test from 'node:test';
import {
    policy, capacityScenario, emptyCapacityScenario, continuationScenario, activeRecencyScenario, unauthorizedScenario,
    emptyRenewalScenario, rejectedRefreshScenario, invalidValidationScenario, cleanupScenario,
    cleanupRecencyScenario, expiredCleanupScenario, failedCreateScenario, ownerIsolationScenario, recoveryCycleScenario,
    fallbackCallerScenario, successfulRenewalScenario, constructionFailureScenario, invalidCreateScenario,
    repeatedFailedCreateScenario, creationDeadlineScenario, tieScenario
} from '../scripts/review-snapshot-capacity-20261008.mjs';

// Historical failed runs are preserved; current recovery must advance within the same twelve-slot bound.
for (const owners of [13, 24]) {
    test(`${owners} synthetic owners retain exactly the most recent 12 snapshots, twice`, () => {
        for (let run = 0; run < 2; run++) {
            const result = capacityScenario(owners);
            assert.equal(result.live, policy.capacity);
            assert.deepEqual(result.evicted, Array.from({ length: owners - 12 }, (_, index) => `owner-${index + 1}`));
        }
    });
}

for (const context of ['workspace', 'group', 'search', 'fallback']) {
    test(`13-owner capacity includes successful empty ${context} contexts`, () => {
        const result = emptyCapacityScenario(context);
        assert.equal(result.distinctOwners, 13);
        assert.equal(result.usefulOwnerStatus, 410);
        assert.equal(result.liveEmptySnapshots, 12);
        assert.equal(result.allEmpty, true);
    });
}

test('many continuation pages and 70 query contexts per owner preserve rows without raising snapshot capacity', () => {
    const result = continuationScenario();
    assert.equal(result.owners.length, 13);
    for (const owner of result.owners) {
        assert.deepEqual(owner.pages.map(page => page.rows), [401, 401, 337, 337, 53]);
        assert.deepEqual(owner.pages.map(page => page.requests), [17, 17, 9, 9, 11]);
        assert.equal(owner.queryContexts, 70);
    }
    assert.equal(result.successfulRequests, 1729);
    assert.equal(result.inventory.filter(row => row.status === 200).length, 12);
});

test('successful continuation refresh protects the active owner through 24 peer insertions', () => {
    const result = activeRecencyScenario();
    assert.equal(result.activeStatus, 200);
    assert.equal(result.peerInventory.filter(row => row.status === 200).length, 11);
    assert.deepEqual(result.peerInventory.filter(row => row.status === 410).map(row => row.userID),
        Array.from({ length: 13 }, (_, index) => `peer-${index + 1}`));
});

test('foreign-owner 403 touches neither sliding expiry nor LRU priority', () => {
    const result = unauthorizedScenario();
    assert.equal(result.forbidden.status, 403);
    assert.equal(result.forbidden.error, 'ranking_snapshot_forbidden');
    assert.equal(result.capacityStatus, 410);
    assert.equal(result.expiryForbidden.status, 403);
    assert.equal(result.expiryStatus, 410);
});

for (const context of ['models', 'group', 'search', 'fallback']) {
    test(`successful empty ${context} pages refresh TTL, and exact sliding deadline expires`, () => {
        const result = emptyRenewalScenario(context);
        assert.equal(result.emptyRows, 0);
        assert.equal(result.hasMore, false);
        assert.equal(result.statusAfterOriginalExpiry, 200);
        assert.equal(result.statusAtSlidingBoundary, 410);
    });
}

for (const [kind, status] of [['missing-fallback', 404], ['cleaned-fallback', 410], ['cleaned-search', 410]]) {
    test(`rejected ${kind} touches neither expiry nor eviction priority, twice`, () => {
        for (let run = 0; run < 2; run++) {
            const result = rejectedRefreshScenario(kind);
            assert.equal(result.rejectedAtBoundary.status, status);
            assert.equal(result.rejectedForRecency.status, status);
            assert.equal(result.statusAfterOriginalExpiry, 410);
            assert.equal(result.failedOwnerStatus, 410);
            assert.equal(result.untouchedOwnerStatus, 200);
        }
    });
}

test('argument-validation 400 does not refresh the snapshot', () => {
    const result = invalidValidationScenario();
    assert.deepEqual(result.invalidStatuses, [400, 400, 400, 400, 400, 400]);
    assert.equal(result.statusAtOriginalExpiry, 410);
});

test('cleanup is snapshot-wide and sticky even after fresh first pages under an unaffected entrance, twice', () => {
    for (let run = 0; run < 2; run++) {
        const result = cleanupScenario();
        assert.equal(result.removedEntrance, 2);
        assert.equal(result.unaffectedEntrance, 1);
        assert.equal(result.beforeFallbackRows, 5);
        assert.equal(result.freshFallbackRows, 5);
        assert.equal(result.unaffectedFallbackTotal, 17);
        assert.equal(result.fallbackContinuation.status, 410);
        assert.equal(result.beforeSearchRows, 40);
        assert.equal(result.freshSearchRows, 40);
        assert.equal(result.searchTotal, 83);
        assert.equal(result.searchContinuation.status, 410);
        assert.equal(result.ordinaryContinuationStatus, 200);
        assert.equal(result.modelContinuationStatus, 200);
        assert.equal(result.changedEntranceTotal, 16);
        assert.equal(result.guestSurvives, true);
        assert.equal(result.beforeFeatured, 1);
        assert.equal(result.afterFeatured, 0);
        assert.equal(result.beforeRemovedTermTotal, 1);
        assert.equal(result.afterRemovedTermTotal, 0);
    }
});

test('global family cleanup does not itself refresh expiry or eviction priority', () => {
    const result = cleanupRecencyScenario();
    assert.equal(result.expiryStatus, 410);
    assert.equal(result.liveAfterCleanup, 12);
    assert.equal(result.oldestStatus, 410);
    assert.equal(result.secondStatus, 200);
});

test('global cleanup prunes all expired catalogues before touching their rows, twice', () => {
    for (let run = 0; run < 2; run++) {
        const result = expiredCleanupScenario();
        assert.equal(result.expiredOwnersVisited, 0);
        assert.equal(result.expiredRowReads, 0);
        assert.equal(result.oldRowReadsAfterCreatePrune, 0);
    }
});

for (const phase of ['before-insert', 'after-insert', 'benchmark-page', 'response-spread']) {
    test(`failed create ${phase} preserves all healthy snapshots and capacity, twice`, () => {
        for (let run = 0; run < 2; run++) {
            const result = failedCreateScenario(phase);
            assert.equal(result.failure.name, ['before-insert', 'after-insert'].includes(phase) ? 'TypeError' : 'Error');
            assert.equal(result.oldestImmediatelyAfterFailureStatus, 200);
            assert.equal(result.readableImmediatelyAfterFailure, 12);
            assert.deepEqual(result.evicted, ['owner-1']);
            assert.equal(result.reachableOriginalOwners, 11);
        }
    });
}

for (const list of ['personal', 'public', 'benchmarks', 'fallbacks']) {
    test(`successful nonempty ${list} pages renew the sliding deadline`, () => {
        const result = successfulRenewalScenario(list);
        assert.ok(result.rows > 0);
        assert.equal(result.statusAfterOriginalExpiry, 200);
        assert.equal(result.statusAtSlidingBoundary, 410);
    });
}

test('a page-construction exception does not refresh expiry or eviction priority, twice', () => {
    for (let run = 0; run < 2; run++) {
        const result = constructionFailureScenario();
        assert.equal(result.statusAfterOriginalExpiry, 410);
        assert.equal(result.failedOwnerStatus, 410);
        assert.equal(result.untouchedOwnerStatus, 200);
    }
});

test('invalid create inputs preserve all 12 healthy handles', () => {
    const result = invalidCreateScenario();
    assert.deepEqual(result.errors.map(error => error.status), [400, 400, 400, 400, 500]);
    assert.equal(result.readableOwners, 12);
});

test('24 failed creates do not consume slots or change healthy-owner eviction priority', () => {
    const result = repeatedFailedCreateScenario();
    assert.equal(result.failures, 24);
    assert.equal(result.readableOriginalOwners, 11);
    assert.deepEqual(result.evicted, ['owner-1']);
});

test('creation grants a full TTL after response preparation succeeds', () => {
    const result = creationDeadlineScenario();
    assert.equal(result.commitTime, policy.ttlMs * 2);
    assert.equal(result.statusImmediatelyAfterCreate, 200);
});

test('model-score ties preserve shared ranks across continuation boundaries', () => {
    const result = tieScenario();
    assert.equal(result.firstPageLastRank, 25);
    assert.deepEqual(result.continuationRanks, [25, 27]);
    assert.equal(result.uniqueIDs, 38);
    assert.equal(result.total, 38);
});

test('exact authenticated owner matching protects private model pages; null guest UUIDs remain capabilities', () => {
    const result = ownerIsolationScenario();
    assert.equal(result.distinctLargeStringOwners.status, 403);
    assert.deepEqual(result.foreignListStatuses, [403, 403, 403, 403]);
    assert.equal(result.containsOnlyMatchingOwner, true);
    assert.equal(result.matchingOwnerRows, 25);
    assert.equal(result.numericStringStatus, 200);
    assert.equal(result.guestBySnapshotPossession, 'guest-draft personal Model 1');
});

test('12-owner control: exact frontend page-loader advances instead of refreshing', async () => {
    const result = await recoveryCycleScenario(12);
    assert.equal(result.totalRefreshes, 0);
    for (const owner of result.records) {
        assert.deepEqual(owner.pageStatuses, [200, 200, 200]);
        assert.deepEqual(owner.loadedCounts, [50, 75, 100]);
    }
});

for (const [owners, list, firstPage] of [[13, 'public', 25], [13, 'benchmarks', 40], [24, 'public', 25]]) {
    test(`${owners}-owner ${list} recovery preserves continuation progress, twice`, async () => {
        for (let run = 0; run < 2; run++) {
            const result = await recoveryCycleScenario(owners, list);
            assert.equal(result.totalRefreshes, owners * 3);
            for (const owner of result.records) {
                assert.deepEqual(owner.pageStatuses, [410, 410, 410]);
                assert.deepEqual(owner.loadedCounts, [firstPage * 2, firstPage * 3, firstPage * 4]);
                assert.ok(owner.refreshOptions.every(options => options.preserveUndo === true && options.pageRecovery?.resume));
            }
        }
    });
}

for (const [kind, status] of [['eviction', 410], ['expiry', 410], ['forbidden', 403]]) {
    test(`actual fallback controller invokes recovery on ${kind}`, async () => {
        const result = await fallbackCallerScenario(kind);
        assert.deepEqual(result.statuses, [status]);
        assert.equal(result.refreshes, 1);
    });
}
