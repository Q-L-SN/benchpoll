import test from 'node:test';
import assert from 'node:assert/strict';
import { getBenchmarkScores } from '../benchmark-scores.js';

function fixture({ count = 51, conditionID = 10, invalidScore = false, failure = false,
    cursorScore = '80.5', cursorExists = true, dataset = null, conditions = null, provenance = [] } = {}) {
    const calls = [], lifecycle = [];
    const connection = {
        async query(sql) { lifecycle.push(sql); },
        async commit() { lifecycle.push('commit'); },
        async rollback() { lifecycle.push('rollback'); },
        release() { lifecycle.push('release'); },
        async execute(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('FROM benchmark_conditions c')) return [conditions ?? [{ ID: conditionID, name: 'Overall', isPrimary: 1, usesPercentageScale: 1, scoreCount: dataset?.length ?? 60 }]];
            if (sql.includes('FROM benchmark_results\n')) {
                const row = dataset?.find(row => row.ID === values[0]);
                return [cursorExists && (!dataset || row) ? [{ rawScore: row?.rawScore ?? cursorScore }] : []];
            }
            if (sql.includes('FROM benchmark_results r')) {
                if (failure) throw Error('Database failed');
                if (!sql.includes('JOIN organizations v')) return [provenance];
                const hasCursor = sql.includes('r.raw_score < CAST');
                const omitted = sql.includes('AND r.ID NOT IN') ? values.slice(hasCursor ? 5 : 2) : [];
                const rows = dataset ? dataset.filter(row => !omitted.includes(row.ID))
                    .filter(row => !hasCursor || Number(row.rawScore) < Number(values[2])
                    || Number(row.rawScore) === Number(values[2]) && row.ID < values[4])
                    .toSorted((a, b) => Number(b.rawScore) - Number(a.rawScore) || b.ID - a.ID).slice(0, 51)
                    : Array.from({ length: count }, (_, index) => ({ ID: 100 - index, rawScore: invalidScore ? 'invalid' : 80.5 }));
                return [rows.map(row => ({ ...row,
                    modelID: 1, modelName: 'A model', vendorName: 'A vendor', sourceURL: 'https://example.com/report',
                    scoreFields: '[{"fieldID":1,"value":11}]' }))];
            }
            if (sql.includes('FROM score_fields')) return [[{ ID: 1, name: 'Harness', type: 'enum', revision: 1 },
                { ID: 59, name: 'Published evaluation provider', type: 'text', revision: 1 }]];
            if (sql.includes('FROM score_field_options')) return [[{ ID: 11, fieldID: 1, label: 'Agent A', revision: 1 }]];
            throw Error(`Unexpected SQL: ${sql}`);
        }
    };
    return { db: { async getConnection() { return connection; } }, calls, lifecycle };
}
test('all-scores API uses a consistent read-only snapshot and bounded current-only keyset pages', async () => {
    const f = fixture();
    const data = await getBenchmarkScores(f.db, { benchmarkID: 2, conditionID: 10, beforeID: 200 });
    assert.equal(data.scores.length, 50);
    assert.equal(data.nextBeforeID, 51);
    assert.deepEqual(data.scores[0].fields, [{ name: 'Harness', value: 'Agent A' }]);
    assert.equal(data.conditions[0].scoreCount, 60);
    assert.equal(data.conditions[0].usesPercentageScale, true);
    const results = f.calls.find(call => call.sql.includes('JOIN organizations v'));
    assert.deepEqual(results.values, [2, 10, '80.5', '80.5', 200]);
    assert.match(results.sql, /r.status = 'accepted'/);
    assert.match(results.sql, /r.ID < \?/);
    assert.match(results.sql, /r.raw_score < CAST\(\? AS DECIMAL\(18,6\)\) OR \(r.raw_score = CAST\(\? AS DECIMAL\(18,6\)\) AND r.ID < \?\)/);
    assert.match(results.sql, /ORDER BY r.raw_score DESC, r.ID DESC LIMIT 51/);
    assert.doesNotMatch(results.sql, /OFFSET|UPDATE|notes|user_id/i);
    assert.match(f.calls[0].sql, /c.deleted_at IS NULL/);
    assert.deepEqual(f.lifecycle, ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'commit', 'release']);
});

test('score-descending pagination spans the whole list and does not skip ties, zero or negative scores', async () => {
    const dataset = Array.from({ length: 137 }, (_, index) => ({ ID: index + 1,
        rawScore: String([95, 10, 95, 0, -2.5, 42, -200][index % 7]) }));
    const f = fixture({ dataset }), received = [];
    let cursor;
    do {
        const page = await getBenchmarkScores(f.db, { benchmarkID: 2, conditionID: 10, ...(cursor ? { beforeID: cursor } : {}) });
        received.push(...page.scores); cursor = page.nextBeforeID;
    } while (cursor !== null);
    const expected = dataset.toSorted((a, b) => Number(b.rawScore) - Number(a.rawScore) || b.ID - a.ID);
    assert.deepEqual(received.map(row => row.ID), expected.map(row => row.ID));
    assert.equal(new Set(received.map(row => row.ID)).size, dataset.length);
    assert.ok(received.every((row, index) => !index || received[index - 1].rawScore >= row.rawScore));
});

test('AA versions return a restriction without loading score rows or exposing counts, even with a cursor', async () => {
    const conditions = [
        { ID: 10, name: 'Independent run', benchmarkName: 'Bench', conditionKey: 'default', usesPercentageScale: 1, scoreCount: 60 },
        { ID: 11, name: 'Third-party run', benchmarkName: 'Bench', conditionKey: 'aa-run', usesPercentageScale: 1, scoreCount: 999 }
    ];
    for (const beforeID of [undefined, 200]) {
        const f = fixture({ conditions });
        const data = await getBenchmarkScores(f.db, { benchmarkID: 2, conditionID: 11, ...(beforeID ? { beforeID } : {}) });
        assert.equal(data.displayRestriction, 'artificial_analysis');
        assert.deepEqual(data.scores, []);
        assert.equal(data.nextBeforeID, null);
        assert.equal(data.conditions[1].scoreCount, null);
        assert.equal(data.conditions[1].displayRestriction, 'artificial_analysis');
        assert.equal(data.conditions[0].scoreCount, 60);
        assert.equal(f.calls.length, 1);
        assert.deepEqual(f.lifecycle.slice(-2), ['commit', 'release']);
        assert.doesNotMatch(JSON.stringify(data), /999|aa-run/);
    }
    const normal = await getBenchmarkScores(fixture({ conditions, count: 2 }).db, { benchmarkID: 2, conditionID: 10 });
    assert.equal(normal.displayRestriction, null);
    assert.equal(normal.scores.length, 2);
    assert.equal(normal.conditions[1].scoreCount, null);
});

test('all versions of an AA-owned benchmark remain restricted', async () => {
    const f = fixture({ conditions: [{ ID: 10, name: 'Overall', benchmarkName: 'AA-Intelligence',
        conditionKey: 'default', usesPercentageScale: 1, scoreCount: 100 }] });
    const data = await getBenchmarkScores(f.db, { benchmarkID: 2, conditionID: 10 });
    assert.equal(data.displayRestriction, 'artificial_analysis');
    assert.deepEqual(data.scores, []);
    assert.equal(f.calls.length, 1);
});

test('mixed versions hide AA-source rows before pagination and counts without losing independent rows', async () => {
    const dataset = Array.from({ length: 137 }, (_, index) => ({ ID: index + 1, rawScore: String(index % 20) }));
    const hidden = dataset.filter(row => row.ID % 3 === 0);
    const provenance = hidden.map(row => ({ ID: row.ID, benchmark_ID: 2, conditionID: 10,
        source_url: 'https://publisher.example/chart', score_fields: [{ fieldID: 59, value: 'Artificial Analysis' }] }));
    const f = fixture({ dataset, provenance }), received = [];
    let cursor;
    do {
        const page = await getBenchmarkScores(f.db, { benchmarkID: 2, conditionID: 10, ...(cursor ? { beforeID: cursor } : {}) });
        assert.equal(page.omittedScores, true);
        assert.equal(page.displayRestriction, null);
        assert.equal(page.conditions[0].scoreCount, dataset.length - hidden.length);
        received.push(...page.scores); cursor = page.nextBeforeID;
    } while (cursor !== null);
    const expected = dataset.filter(row => row.ID % 3 !== 0).toSorted((a, b) => Number(b.rawScore) - Number(a.rawScore) || b.ID - a.ID);
    assert.deepEqual(received.map(row => row.ID), expected.map(row => row.ID));
});

test('page anchors are scoped to the selected benchmark version and retain decimal precision', async () => {
    const f = fixture({ cursorScore: '999999999999.123456' });
    await getBenchmarkScores(f.db, { benchmarkID: 2, conditionID: 10, beforeID: 200 });
    const anchor = f.calls.find(call => call.sql.includes('FROM benchmark_results\n'));
    assert.deepEqual(anchor.values, [200, 2, 10]);
    const results = f.calls.find(call => call.sql.includes('JOIN organizations v'));
    assert.deepEqual(results.values.slice(2), ['999999999999.123456', '999999999999.123456', 200]);
    const missing = fixture({ cursorExists: false });
    await assert.rejects(getBenchmarkScores(missing.db, { benchmarkID: 2, conditionID: 10, beforeID: 200 }),
        error => error.body.error === 'invalid_benchmark_scores_cursor');
    assert.deepEqual(missing.lifecycle.slice(-2), ['rollback', 'release']);
});
test('empty and final pages have no cursor, including an exact 50-result page', async () => {
    for (const count of [0, 2, 50]) {
        const data = await getBenchmarkScores(fixture({ count }).db, { benchmarkID: 2, conditionID: 10 });
        assert.equal(data.scores.length, count); assert.equal(data.nextBeforeID, null);
    }
});
test('invalid IDs and unknown properties fail before opening a connection', async () => {
    const db = { getConnection() { throw Error('Should not connect'); } };
    for (const body of [null, [], {}, { benchmarkID: '2', conditionID: 10 }, { benchmarkID: 2, conditionID: 0 },
        { benchmarkID: 2, conditionID: 10, beforeID: null }, { benchmarkID: 2, conditionID: 10, categoryID: 3 }]) {
        await assert.rejects(getBenchmarkScores(db, body), error => error.body.error === 'invalid_benchmark_scores_request');
    }
});
test('a missing condition, corrupt score or SQL failure rolls back and always releases', async () => {
    for (const [options, predicate] of [[{ conditionID: 11 }, error => error.status === 404],
        [{ invalidScore: true }, error => error.body.error === 'accepted_result_score_invalid'],
        [{ failure: true }, /Database failed/]]) {
        const f = fixture(options);
        await assert.rejects(getBenchmarkScores(f.db, { benchmarkID: 2, conditionID: 10 }), predicate);
        assert.deepEqual(f.lifecycle.slice(-2), ['rollback', 'release']);
    }
});
