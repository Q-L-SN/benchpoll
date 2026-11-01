export function assertPrimaryCondition(conditions, { appended = false } = {}) {
    if (!Array.isArray(conditions) || conditions.length === 0
        || conditions.some(condition => typeof condition.isPrimary !== 'boolean')
        || conditions.filter(condition => condition.isPrimary).length !== (appended ? 0 : 1)) {
        throw { status: 400, body: { error: appended
            ? 'use_change_form_to_set_primary_condition' : 'benchmark_requires_one_primary_condition' } };
    }
}

export function chooseInitialPrimaryCondition(conditions) {
    if (!Array.isArray(conditions) || conditions.length === 0) throw new TypeError('A benchmark must have conditions');
    const priority = condition => {
        const name = condition.name.trim().toLocaleLowerCase('en-US');
        if (/^(overall|overall score|total|total score|aggregate|aggregate score|all)$/.test(name)) return 3;
        if (name === 'default') return 2;
        if (/^(general|standard)$/.test(name)) return 1;
        return 0;
    };
    return [...conditions].sort((a, b) => priority(b) - priority(a)
        || b.scoredModelCount - a.scoredModelCount || b.scoreCount - a.scoreCount || a.ID - b.ID)[0];
}

export async function primaryFlagForNewCondition(db, benchmarkID) {
    const [[family]] = await db.execute(`SELECT COUNT(*) AS conditionCount, COALESCE(SUM(is_primary),0) AS primaryCount
        FROM benchmark_conditions WHERE benchmark_ID = ? AND deleted_at IS NULL`, [benchmarkID]);
    if (Number(family.conditionCount) === 0) return 1;
    if (Number(family.primaryCount) !== 1) throw new Error(`Benchmark ${benchmarkID} requires exactly one primary condition before importing`);
    return 0;
}
