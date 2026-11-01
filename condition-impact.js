import { selectableBenchmarkConditionSQL } from './benchmark-condition-visibility.js';

const fail = (error, details = {}) => { throw { status: 409, body: { error, ...details } }; };
const tables = {
    benchmark: { objects: 'benchmarks', conditions: 'benchmark_conditions', parent: 'benchmark_ID' }
};

export async function conditionImpact(connection, kind, targetID, conditionID) {
    const schema = tables[kind];
    if (!schema) fail('invalid_condition_kind');
    const [conditions] = await connection.execute(`SELECT ID FROM ${schema.conditions}
        WHERE ID = ? AND ${schema.parent} = ? AND ${selectableBenchmarkConditionSQL(schema.conditions)}`,
    [conditionID, targetID]);
    if (conditions.length !== 1) fail('condition_not_found');
    const column = 'benchmark_condition_ID';
    const [scores] = await connection.execute(`SELECT COUNT(*) AS count FROM benchmark_results WHERE ${column} = ?`, [conditionID]);
    let pieCount = 0;
    if (kind === 'benchmark') {
        const [pies] = await connection.execute(`SELECT COUNT(DISTINCT pie_ID) AS count FROM (
            SELECT pie_ID FROM personal_pie_weights WHERE benchmark_condition_ID = ?
            UNION SELECT r.pie_ID FROM personal_pie_score_rules r
                JOIN benchmark_family_members m ON m.family_ID = r.family_ID WHERE m.benchmark_condition_ID = ?
            UNION SELECT r.pie_ID FROM personal_pie_score_rules r
                JOIN benchmark_families f ON f.ID = r.family_ID
                JOIN benchmark_family_members automatic ON automatic.family_ID = f.ID
                    AND automatic.benchmark_condition_ID IS NULL
                LEFT JOIN benchmark_family_members previous ON previous.family_ID = f.ID
                    AND previous.position = automatic.position - 1
                JOIN benchmark_conditions anchor ON anchor.ID = COALESCE(previous.benchmark_condition_ID, f.primary_benchmark_condition_ID)
                WHERE anchor.benchmark_ID = ? AND anchor.ID <> ?
        ) AS dependencies`, [conditionID, conditionID, targetID, conditionID]);
        pieCount = Number(pies[0].count);
    }
    return { resultCount: Number(scores[0].count), pieCount };
}
