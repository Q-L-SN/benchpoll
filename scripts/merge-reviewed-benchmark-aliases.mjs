import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const args = new Map(process.argv.slice(2).map(arg => {
    const i = arg.indexOf('=');
    return i < 0 ? [arg, true] : [arg.slice(0, i), arg.slice(i + 1)];
}));
const apply = args.has('--apply'), rehearse = args.has('--rehearse');
if (!args.get('--spec') || !args.get('--snapshot') || !args.get('--report')
    || apply && rehearse || (apply || rehearse) && !args.get('--expect')
    || [...args.keys()].some(key => !['--spec', '--snapshot', '--report', '--expect', '--apply', '--rehearse'].includes(key))) {
    throw new Error('Required: --spec=review.json --snapshot=reviewed.json.gz --report=result.json [--rehearse|--apply --expect=digest]');
}
const spec = JSON.parse(await readFile(args.get('--spec'), 'utf8'));
const snapshot = JSON.parse(gunzipSync(await readFile(args.get('--snapshot'))).toString('utf8'));
assert.equal(spec.version, 1);
assert.ok(spec.groups.length > 0 && spec.groups.length <= 10);
const groups = spec.groups;
const benchmarkIDs = groups.flatMap(g => [g.sourceID, g.targetID]);
assert.equal(new Set(benchmarkIDs).size, benchmarkIDs.length, 'Benchmark groups overlap');
const benchmarkMap = new Map(groups.map(g => [g.sourceID, g.targetID]));
const conditionMap = new Map(groups.flatMap(g => g.conditionMerges.map(m => [m.sourceID, m.targetID])));
const sourceConditionIDs = [...conditionMap.keys()];
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const parseJSON = value => typeof value === 'string' ? JSON.parse(value) : value;
const scoreEvidence = rows => hash(rows.map(r => [Number(r.ID), Number(r.conditionID), Number(r.modelID),
    String(r.rawScore), parseJSON(r.fields), r.sourceURL, r.scoreStatus]).sort((a, b) => a[0] - b[0]));
const reviewedConditionIDs = new Set(snapshot.conditions.filter(c => benchmarkIDs.includes(Number(c.benchmark_ID))).map(c => Number(c.ID)));
const expectedScoreEvidence = scoreEvidence(snapshot.results.filter(r => reviewedConditionIDs.has(Number(r.conditionID))));
const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
    charset: 'utf8mb4', dateStrings: true });
const statements = [], started = Date.now();
let locked = false, committed = false;
async function execute(sql, values = []) {
    const [result] = await db.query(sql, values);
    statements.push({ sql: mysql.format(sql, values), affectedRows: result.affectedRows });
    return result;
}
async function rows(sql, values = []) { return (await db.query(sql, values))[0]; }
async function readState() {
    return {
        benchmarks: await rows('SELECT * FROM benchmarks WHERE ID IN (?) ORDER BY ID FOR UPDATE', [benchmarkIDs]),
        conditions: await rows('SELECT * FROM benchmark_conditions WHERE benchmark_ID IN (?) ORDER BY ID FOR UPDATE', [benchmarkIDs]),
        results: await rows('SELECT * FROM benchmark_results WHERE benchmark_ID IN (?) ORDER BY ID FOR UPDATE', [benchmarkIDs]),
        tags: await rows('SELECT * FROM benchmark_tag_links WHERE benchmark_ID IN (?) ORDER BY benchmark_ID, tag_ID FOR UPDATE', [benchmarkIDs]),
        mentions: await rows(`SELECT * FROM discussion_mentions WHERE benchmark_ID IN (?)
            OR condition_ID IN (SELECT ID FROM benchmark_conditions WHERE benchmark_ID IN (?)) ORDER BY ID FOR UPDATE`, [benchmarkIDs, benchmarkIDs])
    };
}
async function pieDigest() {
    return hash(await Promise.all(['personal_pies', 'personal_pie_weights', 'personal_pie_score_rules', 'personal_pie_score_rule_components']
        .map(async table => [table, (await rows(`SELECT * FROM ${table}`)).map(row => JSON.stringify(row)).sort()])));
}
function resultContent(rows) {
    return rows.map(row => {
        const copy = { ...row };
        delete copy.benchmark_ID;
        delete copy.benchmark_condition_ID;
        const snapshot = structuredClone(parseJSON(copy.benchmark_condition_snapshot));
        delete snapshot.benchmarkID;
        delete snapshot.conditionID;
        copy.benchmark_condition_snapshot = snapshot;
        return copy;
    });
}
try {
    const [lock] = await rows("SELECT GET_LOCK('benchpoll_curated_condition_merges', 10) AS acquired");
    assert.equal(Number(lock.acquired), 1);
    locked = true;
    await db.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await db.beginTransaction();
    const [reviewer] = await rows('SELECT ID, role FROM users WHERE ID = ? AND deleted_at IS NULL', [spec.reviewerUserID]);
    assert.equal(reviewer?.role, 'senior', 'Reviewer is not a current senior');
    const [pending] = await rows("SELECT COUNT(*) AS n FROM moderation_logs WHERE status = 'pending'");
    assert.equal(Number(pending.n), 0, 'Pending requests require review before changing object identities');
    const references = await rows(`SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME
        FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
        AND REFERENCED_TABLE_NAME IN ('benchmarks', 'benchmark_conditions')`);
    assert.deepEqual(references.map(r => `${r.TABLE_NAME}.${r.COLUMN_NAME}->${r.REFERENCED_TABLE_NAME}`).sort(), [
        'benchmark_conditions.benchmark_ID->benchmarks', 'benchmark_results.benchmark_ID->benchmarks',
        'benchmark_results.benchmark_condition_ID->benchmark_conditions', 'benchmark_tag_links.benchmark_ID->benchmarks',
        'discussion_mentions.benchmark_ID->benchmarks', 'discussion_mentions.condition_ID->benchmark_conditions',
        'personal_pie_weights.benchmark_condition_ID->benchmark_conditions',
        'personal_pie_score_rule_components.fallback_benchmark_condition_ID->benchmark_conditions'
    ].sort(), 'Unreviewed foreign key references');
    const before = await readState();
    const byCondition = new Map(before.conditions.map(c => [Number(c.ID), c]));
    for (const group of groups) {
        assert.ok(group.reason?.trim() && group.sources.length);
        const source = before.benchmarks.find(b => Number(b.ID) === group.sourceID);
        const target = before.benchmarks.find(b => Number(b.ID) === group.targetID);
        assert.equal(source?.name, group.sourceName);
        assert.equal(target?.name, group.targetName);
        assert.ok(!source.notes?.trim(), 'Source has notes requiring an explicit metadata merge');
        assert.equal(Number(target.is_active), 1, 'Target benchmark must retain current visibility');
        assert.deepEqual(before.conditions.filter(c => Number(c.benchmark_ID) === group.sourceID).map(c => Number(c.ID)).sort((a,b)=>a-b),
            group.sourceConditionIDs.slice().sort((a,b)=>a-b));
        for (const merge of group.conditionMerges) {
            const sourceCondition = byCondition.get(merge.sourceID), targetCondition = byCondition.get(merge.targetID);
            assert.equal(Number(sourceCondition?.benchmark_ID), group.sourceID);
            assert.equal(Number(targetCondition?.benchmark_ID), group.targetID);
            assert.equal(sourceCondition.deleted_at, null);
            assert.equal(targetCondition.deleted_at, null);
            for (const key of ['score_direction', 'target_value', 'uses_percentage_scale', 'score_min', 'score_max']) {
                assert.equal(sourceCondition[key], targetCondition[key], `Incompatible ${key}`);
            }
            assert.equal(Number(sourceCondition.is_default), 0, 'Do not delete default condition implicitly');
        }
        const retained = before.conditions.filter(c => [group.sourceID, group.targetID].includes(Number(c.benchmark_ID)) && !conditionMap.has(Number(c.ID)));
        assert.equal(new Set(retained.map(c=>c.condition_key)).size, retained.length, 'Condition-key collision');
        assert.ok(retained.filter(c=>Number(c.is_default)).length <= 1, 'Default condition collision');
        assert.equal(new Set(retained.filter(c=>!c.deleted_at).map(c=>c.name.toLowerCase())).size,
            retained.filter(c=>!c.deleted_at).length, 'Condition-name collision');
        const collisions = await rows('SELECT ID FROM benchmarks WHERE name = ? AND ID NOT IN (?)', [group.canonicalName, [group.sourceID,group.targetID]]);
        assert.equal(collisions.length, 0, 'Canonical benchmark name already exists');
    }
    for (const current of before.conditions) {
        const reviewed = snapshot.conditions.find(c => Number(c.ID) === Number(current.ID));
        assert.ok(reviewed, `New unreviewed condition ${current.ID}`);
        for (const key of ['benchmark_ID', 'name', 'deleted_at']) assert.equal(current[key], reviewed[key]);
    }
    const liveScoreEvidence = scoreEvidence(before.results.map(r => ({ ID:r.ID,conditionID:r.benchmark_condition_ID,
        modelID:r.model_ID,rawScore:r.raw_score,fields:r.score_fields,sourceURL:r.source_url,scoreStatus:r.status })));
    assert.equal(liveScoreEvidence, expectedScoreEvidence, 'Score evidence changed after review');
    if (sourceConditionIDs.length) {
        const protectedRows = await rows(`SELECT benchmark_condition_ID AS ID FROM personal_pie_weights WHERE benchmark_condition_ID IN (?)
            UNION SELECT fallback_benchmark_condition_ID AS ID FROM personal_pie_score_rule_components WHERE fallback_benchmark_condition_ID IN (?)`,
        [sourceConditionIDs, sourceConditionIDs]);
        assert.equal(protectedRows.length, 0, 'A reviewed source condition now has a Pie/fallback reference; replan explicitly');
    }
    const originalPies = await pieDigest();
    const [totalsBefore] = await rows(`SELECT (SELECT COUNT(*) FROM benchmarks) AS benchmarks,
        (SELECT COUNT(*) FROM benchmark_conditions) AS conditions, (SELECT COUNT(*) FROM benchmark_results) AS results`);
    const planDigest = hash({ spec, before });
    const output = { planDigest, applied: false, rehearsed: false, spec,
        before: { totals: totalsBefore, benchmarks: before.benchmarks, conditions: before.conditions,
            resultCount: before.results.length, resultContentSHA256: hash(resultContent(before.results)), tags:before.tags, mentions:before.mentions },
        sourceResults: before.results.filter(r=>benchmarkMap.has(Number(r.benchmark_ID))).length,
        mergedConditionResults: before.results.filter(r=>conditionMap.has(Number(r.benchmark_condition_ID))).length };
    if (!apply && !rehearse) {
        await db.rollback();
        await writeFile(args.get('--report'), JSON.stringify(output,null,2));
        console.log(JSON.stringify({planDigest,groups:groups.length,sourceResults:output.sourceResults,
            mergedConditions:conditionMap.size,mergedConditionResults:output.mergedConditionResults}));
    } else {
        assert.equal(planDigest, args.get('--expect'), 'Plan changed since preflight');
        for (const group of groups) {
            for (const merge of group.conditionMerges) {
                await execute(`UPDATE benchmark_results SET benchmark_ID = ?, benchmark_condition_ID = ?,
                    benchmark_condition_snapshot = JSON_SET(benchmark_condition_snapshot, '$.benchmarkID', ?, '$.conditionID', ?),
                    updated_at = updated_at WHERE benchmark_condition_ID = ?`,
                [group.targetID,merge.targetID,group.targetID,merge.targetID,merge.sourceID]);
                await execute('UPDATE discussion_mentions SET benchmark_ID = ?, condition_ID = ? WHERE condition_ID = ?',
                    [group.targetID,merge.targetID,merge.sourceID]);
                const deleted = await execute('DELETE FROM benchmark_conditions WHERE ID = ?', [merge.sourceID]);
                assert.equal(deleted.affectedRows,1);
            }
            await execute('UPDATE benchmark_conditions SET benchmark_ID = ?, updated_at = updated_at WHERE benchmark_ID = ?',
                [group.targetID,group.sourceID]);
            await execute(`UPDATE benchmark_results SET benchmark_ID = ?,
                benchmark_condition_snapshot = JSON_SET(benchmark_condition_snapshot, '$.benchmarkID', ?),
                updated_at = updated_at WHERE benchmark_ID = ?`, [group.targetID,group.targetID,group.sourceID]);
            await execute(`INSERT INTO benchmark_tag_links (benchmark_ID, tag_ID)
                SELECT ?, s.tag_ID FROM benchmark_tag_links s WHERE s.benchmark_ID = ?
                AND NOT EXISTS (SELECT 1 FROM benchmark_tag_links t WHERE t.benchmark_ID = ? AND t.tag_ID = s.tag_ID)`,
            [group.targetID,group.sourceID,group.targetID]);
            await execute('DELETE FROM benchmark_tag_links WHERE benchmark_ID = ?', [group.sourceID]);
            await execute('UPDATE discussion_mentions SET benchmark_ID = ? WHERE benchmark_ID = ?', [group.targetID,group.sourceID]);
            // Raw crawl payloads and historical archive/audit snapshots remain immutable evidence.
            await execute(`UPDATE crawl_entity_mapping_evidence SET existing_db_id = ?
                WHERE target_table_name = 'benchmarks' AND existing_db_id = ?`, [group.targetID,group.sourceID]);
            for (const merge of group.conditionMerges) await execute(`UPDATE crawl_entity_mapping_evidence SET existing_db_id = ?
                WHERE target_table_name = 'benchmark_conditions' AND existing_db_id = ?`, [merge.targetID,merge.sourceID]);
            const deleted = await execute('DELETE FROM benchmarks WHERE ID = ?', [group.sourceID]);
            assert.equal(deleted.affectedRows,1);
            await execute('UPDATE benchmarks SET name = ?, updated_at = updated_at WHERE ID = ?', [group.canonicalName,group.targetID]);
        }
        const after = await readState();
        assert.equal(after.results.length,before.results.length);
        assert.deepEqual(resultContent(after.results),resultContent(before.results),'Score content or metadata changed');
        assert.equal(await pieDigest(),originalPies,'Pie weights or fallback rules changed');
        const afterResults = new Map(after.results.map(r=>[Number(r.ID),r]));
        for (const old of before.results) {
            const current = afterResults.get(Number(old.ID)), snapshot = parseJSON(current.benchmark_condition_snapshot);
            assert.equal(Number(current.benchmark_ID),benchmarkMap.get(Number(old.benchmark_ID))??Number(old.benchmark_ID));
            assert.equal(Number(current.benchmark_condition_ID),conditionMap.get(Number(old.benchmark_condition_ID))??Number(old.benchmark_condition_ID));
            assert.equal(Number(snapshot.benchmarkID),Number(current.benchmark_ID));
            assert.equal(Number(snapshot.conditionID),Number(current.benchmark_condition_ID));
        }
        const [totalsAfter] = await rows(`SELECT (SELECT COUNT(*) FROM benchmarks) AS benchmarks,
            (SELECT COUNT(*) FROM benchmark_conditions) AS conditions, (SELECT COUNT(*) FROM benchmark_results) AS results`);
        assert.equal(Number(totalsAfter.benchmarks),Number(totalsBefore.benchmarks)-groups.length);
        assert.equal(Number(totalsAfter.conditions),Number(totalsBefore.conditions)-conditionMap.size);
        assert.equal(Number(totalsAfter.results),Number(totalsBefore.results));
        const [invalid] = await rows(`SELECT COUNT(*) AS n FROM benchmark_results r LEFT JOIN benchmark_conditions c ON c.ID=r.benchmark_condition_ID
            WHERE c.ID IS NULL OR r.benchmark_ID<>c.benchmark_ID`);
        assert.equal(Number(invalid.n),0,'Dangling or cross-linked scores');
        output.after = { totals:totalsAfter,benchmarks:after.benchmarks,conditions:after.conditions,
            resultCount:after.results.length,resultContentSHA256:hash(resultContent(after.results)),tags:after.tags,mentions:after.mentions };
        output.statements = statements;
        output.preservedPiesSHA256 = originalPies;
        output.completedAt = new Date().toISOString();
        const [audit] = await db.query(`INSERT INTO moderation_audit_logs
            (reviewer_user_ID,action_type,request_type,request_summary,status_before,status_after,
             request_before,request_after,executed_sql,database_response,outcome,duration_ms)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [spec.reviewerUserID,'merge_benchmark_aliases','benchmark_cleanup',
            'Reviewed cross-benchmark aliases: MultiPL-E, MMLongBench-Doc, OSWorld-Verified',
            'reviewed','applied',JSON.stringify({spec,before:output.before}),JSON.stringify(output.after),
            statements.map(s=>s.sql+';').join('\n'),JSON.stringify({statements,planDigest,totalsAfter}),
            'success',Date.now()-started]);
        if (apply) { await db.commit(); committed = true; } else await db.rollback();
        output.applied = apply;
        output.rehearsed = rehearse;
        output.auditLogID = apply ? audit.insertId : null;
        await writeFile(args.get('--report'),JSON.stringify(output,null,2));
        console.log(JSON.stringify({applied:apply,rehearsed:rehearse,auditLogID:output.auditLogID,
            before:totalsBefore,after:totalsAfter,sourceResults:output.sourceResults,mergedConditions:conditionMap.size,
            mergedConditionResults:output.mergedConditionResults,preservedResults:after.results.length}));
    }
} catch (error) {
    if (!committed) await db.rollback();
    else console.error('Database committed; report writing failed. Consult moderation_audit_logs before retrying.');
    throw error;
} finally {
    if (locked) await db.query("SELECT RELEASE_LOCK('benchpoll_curated_condition_merges')");
    await db.end();
}
