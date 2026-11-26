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
    const [[usage]] = await connection.execute(`SELECT
        (SELECT COUNT(*) FROM benchmark_results WHERE benchmark_condition_ID = ?) AS resultCount,
        (SELECT COUNT(DISTINCT pie_ID) FROM personal_pie_weights WHERE benchmark_condition_ID = ?) AS pieCount,
        (SELECT COUNT(*) FROM (
            SELECT DISTINCT first_ID, second_ID FROM estimation_pair_votes WHERE first_ID=? OR second_ID=?
        ) AS estimation_pairs) AS estimationPairCount`, Array(4).fill(conditionID));
    if (!usage) fail('benchmark_condition_dependency_check_failed', { ID: conditionID });
    return { resultCount: Number(usage.resultCount), pieCount: Number(usage.pieCount), estimationPairCount: Number(usage.estimationPairCount) };
}
