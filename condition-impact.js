const fail = (error, details = {}) => { throw { status: 409, body: { error, ...details } }; };
const tables = {
    benchmark: { objects: 'benchmarks', conditions: 'benchmark_conditions', parent: 'benchmark_ID' },
    model: { objects: 'models', conditions: 'model_conditions', parent: 'model_ID' }
};

export async function conditionImpact(connection, kind, targetID, conditionID) {
    const schema = tables[kind];
    if (!schema) fail('invalid_condition_kind');
    const [conditions] = await connection.execute(`SELECT ID FROM ${schema.conditions} WHERE ID = ? AND ${schema.parent} = ? AND is_active = 1`, [conditionID, targetID]);
    if (conditions.length !== 1) fail('condition_not_found');
    const column = kind === 'benchmark' ? 'benchmark_condition_ID' : 'model_condition_ID';
    const [scores] = await connection.execute(`SELECT COUNT(*) AS count FROM benchmark_results WHERE ${column} = ?`, [conditionID]);
    let pieCount = 0;
    if (kind === 'benchmark') {
        const [pies] = await connection.execute(`SELECT COUNT(DISTINCT pie_ID) AS count FROM (
            SELECT pie_ID FROM personal_pie_weights WHERE benchmark_condition_ID = ?
            UNION SELECT pie_ID FROM personal_pie_score_rule_components WHERE fallback_benchmark_condition_ID = ?
        ) AS dependencies`, [conditionID, conditionID]);
        pieCount = Number(pies[0].count);
    }
    return { resultCount: Number(scores[0].count), pieCount };
}

