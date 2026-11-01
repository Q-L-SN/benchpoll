import { createHash } from 'node:crypto';

export function scoreEvidenceDigest(rows) {
    const entries = rows.map(row => [Number(row.ID), Number(row.conditionID), Number(row.modelID),
        String(row.rawScore), typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields,
        row.sourceURL]).sort((a, b) => a[0] - b[0]);
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function fullScoreEvidenceDigest(rows) {
    const entries = rows.map(row => [Number(row.ID), Number(row.conditionID), Number(row.modelID),
        String(row.rawScore), typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields,
        row.sourceURL, row.scoreStatus]).sort((a, b) => a[0] - b[0]);
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function semanticDifferences(left, right) {
    const facets = condition => new Map(condition.name.split(';').flatMap(part => {
        const match = part.trim().match(/^([\w /-]+)\s*=\s*(.+)$/);
        return match ? [[match[1].trim().toLowerCase(), match[2].trim().toLowerCase()]] : [];
    }));
    const a = facets(left), b = facets(right);
    return [...a].filter(([key, value]) => b.has(key) && b.get(key) !== value)
        .map(([key, value]) => ({ key, left: value, right: b.get(key) }));
}

export function planConditionOverlapMerges(report, reviewedGroups, protectedIDs = new Set()) {
    const conditions = new Map(report.conditions.map(row => [Number(row.ID), row]));
    const sampleSets = new Map(report.conditions.map(row => [Number(row.ID), new Map()]));
    for (const sample of report.samples) {
        const config = JSON.stringify([sample.modelID, sample.fields]);
        sampleSets.get(sample.conditionID).set(JSON.stringify([config, sample.score]), { ...sample, config });
    }
    const seen = new Set(), groups = [], steps = [], blocked = [];
    const scale = row => JSON.stringify([row.score_direction, row.target_value,
        row.uses_percentage_scale, row.score_min, row.score_max]);
    for (const reviewed of reviewedGroups) {
        if (!reviewed.reason?.trim() || reviewed.conditions.length < 2) throw new Error('Invalid semantic review group');
        const remaining = new Map();
        for (const expected of reviewed.conditions) {
            const id = Number(expected.ID), row = conditions.get(id);
            if (!row || seen.has(id) || row.name !== expected.name
                || row.benchmark_name !== reviewed.benchmarkName) throw new Error(`Stale semantic review: ${id}`);
            seen.add(id);
            remaining.set(id, { id, members: [id], samples: new Map(sampleSets.get(id)) });
        }
        if (new Set([...remaining.keys()].map(id => conditions.get(id).benchmark_ID)).size !== 1) {
            throw new Error('Semantic review spans different benchmarks');
        }
        // Recompute every candidate after each union; never merge stale graph edges transitively.
        while (remaining.size > 1) {
            const candidates = [], items = [...remaining.values()];
            for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
                const [target, source] = [items[i], items[j]].sort((a, b) => b.samples.size - a.samples.size
                    || Number(conditions.get(b.id).is_default) - Number(conditions.get(a.id).is_default) || a.id - b.id);
                const exact = [...source.samples].filter(([key]) => target.samples.has(key));
                const matchingModels = new Set(exact.map(([, sample]) => sample.modelID)).size;
                const configs = item => {
                    const map = new Map();
                    for (const sample of item.samples.values()) {
                        if (!map.has(sample.config)) map.set(sample.config, new Set());
                        map.get(sample.config).add(sample.score);
                    }
                    return map;
                };
                const a = configs(target), b = configs(source);
                const conflicts = [...b].filter(([key, scores]) => a.has(key)
                    && ![...scores].some(score => a.get(key).has(score))).length;
                const reasons = [];
                if (exact.length < 2 || exact.length * 4 < source.samples.size * 3) reasons.push('below_overlap_threshold');
                if (matchingModels < 2) reasons.push('fewer_than_two_models');
                if (conflicts) reasons.push('conflicting_configuration_scores');
                if (scale(conditions.get(target.id)) !== scale(conditions.get(source.id))) reasons.push('different_scale');
                if (Number(conditions.get(source.id).is_default)) reasons.push('default_source');
                if (protectedIDs.has(source.id)) reasons.push('referenced_source');
                const candidate = { target, source, exact: exact.length, matchingModels,
                    coverage: exact.length / source.samples.size, reasons };
                if (!reasons.length) candidates.push(candidate);
            }
            candidates.sort((a, b) => b.coverage - a.coverage || b.exact - a.exact
                || b.target.samples.size - a.target.samples.size || a.target.id - b.target.id || a.source.id - b.source.id);
            if (!candidates.length) break;
            const { target, source, exact, matchingModels, coverage } = candidates[0];
            steps.push({ targetID: target.id, sourceID: source.id, exact, matchingModels, coverage,
                targetSampleCount: target.samples.size, sourceSampleCount: source.samples.size });
            for (const [key, sample] of source.samples) target.samples.set(key, sample);
            target.members.push(...source.members);
            remaining.delete(source.id);
        }
        for (const item of remaining.values()) if (item.members.length > 1) groups.push({
            benchmarkName: reviewed.benchmarkName, targetID: item.id,
            sourceIDs: item.members.filter(id => id !== item.id).sort((a, b) => a - b), reason: reviewed.reason
        });
        if (remaining.size > 1) blocked.push({ benchmarkName: reviewed.benchmarkName,
            remainingIDs: [...remaining.keys()], reason: 'No further merge passes the recomputed checks.' });
    }
    return { groups: groups.sort((a, b) => a.targetID - b.targetID), steps, blocked };
}
