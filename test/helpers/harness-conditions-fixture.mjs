import { readFile } from 'node:fs/promises';
import { publicScoreIdentity } from '../../benchmark-harness-split.js';

export const harnessReview = JSON.parse(await readFile(new URL('../../ops/arc-harness-review-20261103.json', import.meta.url), 'utf8'));
export function reviewedHarnessState(review = harnessReview) {
    return { benchmarks: review.targets.map(row => ({ ID: row.benchmarkID, name: row.benchmarkName, is_active: 1 })),
        conditions: review.targets.map(row => ({ ID: row.conditionID, benchmark_ID: row.benchmarkID, name: row.beforeName,
            condition_key: 'existing-' + row.conditionID, is_primary: 1, is_default: 0, deleted_at: null,
            score_direction: 'higher', target_value: null, uses_percentage_scale: 1, score_min: null, score_max: null, difference_explanation: '' })),
        results: review.targets.flatMap(target => target.scores.map(row => ({ ID: row.ID, benchmark_ID: target.benchmarkID,
            benchmark_condition_ID: target.conditionID, status: 'accepted', raw_score: String(row.rawScore),
            benchmark_condition_snapshot: { conditionID: target.conditionID, name: target.beforeName, benchmarkID: target.benchmarkID },
            publicIdentity: publicScoreIdentity(row) }))), pendingTargetRequests: [] };
}

// Public score inventory only; fresh schema and synthetic accounts/vendors/notes.
// This is not a restored production database.
export async function seedHarnessReview(pool, review = harnessReview) {
    await pool.execute("INSERT INTO organizations (ID, slug, name, is_model_vendor) VALUES (1, 'fixture', 'Fixture', 1)");
    const scores = review.targets.flatMap(row => row.scores), models = new Map(scores.map(row => [row.modelID, row.modelName]));
    for (const [ID, name] of models) await pool.execute('INSERT INTO models (ID, vendor_ID, slug, name) VALUES (?, 1, ?, ?)', [ID, 'model-' + ID, name]);
    const fields = new Map();
    for (const field of scores.flatMap(row => row.fields)) {
        if (fields.has(field.name)) continue;
        const [created] = await pool.execute(`INSERT INTO score_fields (name, name_key, field_type, allow_empty, exclude_missing, exclude_empty)
            VALUES (?, ?, 'text', 1, 1, 1)`, [field.name, field.name.toLowerCase()]);
        fields.set(field.name, Number(created.insertId));
    }
    for (const target of review.targets) {
        await pool.execute('INSERT INTO benchmarks (ID, name) VALUES (?, ?)', [target.benchmarkID, target.benchmarkName]);
        await pool.execute(`INSERT INTO benchmark_conditions (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_primary)
            VALUES (?, ?, ?, ?, 'higher', 1, 1)`, [target.conditionID, target.benchmarkID, 'original-' + target.conditionID, target.beforeName]);
        for (const score of target.scores) {
            await pool.execute(`INSERT INTO benchmark_results (ID, model_ID, benchmark_ID, benchmark_condition_ID, raw_score,
                source_url, source_title, source_type, benchmark_condition_snapshot, score_fields, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'other', ?, ?, 'Local public-data rehearsal; no private production notes')`,
            [score.ID, score.modelID, target.benchmarkID, target.conditionID, String(score.rawScore), score.sourceURL, score.sourceTitle,
                JSON.stringify({ benchmarkID: target.benchmarkID, conditionID: target.conditionID, name: target.beforeName,
                    scoreDirection: 'higher', usesPercentageScale: true, scoreMin: null, scoreMax: null, targetValue: null }),
                JSON.stringify(score.fields.map(field => ({ fieldID: fields.get(field.name), value: field.value })))]);
        }
    }
}
