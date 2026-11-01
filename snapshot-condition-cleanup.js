import { createHash } from 'node:crypto';

const numericDate = '(?:20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}|20\\d{6})';
const namedDate = '(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s*\\d{0,2},?\\s*20\\d{2})';

export function stripConditionSnapshots(name) {
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Invalid condition name');
    if (!/snapshot/i.test(name)) return name;
    const tokens = name.split(';').flatMap(piece => {
        let text = piece.trim();
        if (!/snapshot/i.test(text)) return text ? [text] : [];
        const assignment = text.match(/^([^=]+)=/);
        if (assignment && /snapshot/i.test(assignment[1])) return [];
        // File locations are provenance, not an extra time-specific condition.
        text = text.replace(/leaderboard-snapshots/gi, 'leaderboard');
        text = text.replace(new RegExp(`(?:${numericDate}|${namedDate})\\s*(?:(?:author|leaderboard|release)\\s+)?snapshots?`, 'gi'), '');
        text = text.replace(new RegExp(`snapshots?(?:[_\\s-]*(?:date|time))?\\s*[:=_-]?\\s*(?:${numericDate}|${namedDate})`, 'gi'), '');
        text = text.replace(/snapshots?\s+and\s+/gi, '').replace(/\/?snapshots?/gi, '');
        text = text.replace(/\s+/g, ' ').replace(/^[\s,/:=_-]+|[\s,/:=_-]+$/g, '').trim();
        return text ? [text] : [];
    });
    return tokens.join(';') || 'default';
}

const scale = row => JSON.stringify([row.score_direction, row.target_value == null ? null : Number(row.target_value),
    Boolean(Number(row.uses_percentage_scale)), row.score_min == null ? null : Number(row.score_min), row.score_max == null ? null : Number(row.score_max)]);

export function planSnapshotCleanup(conditions, protectedIDs = new Set()) {
    const renamed = conditions.map(row => ({ ...row, cleanName: stripConditionSnapshots(row.name) }));
    const groups = new Map(), merges = [], retained = [], blocked = [];
    for (const row of renamed) {
        // A deleted condition is never resurrected or combined with a live one.
        const identity = JSON.stringify([Number(row.benchmark_ID), row.cleanName.toLocaleLowerCase(), scale(row), row.deleted_at]);
        if (!groups.has(identity)) groups.set(identity, []);
        groups.get(identity).push(row);
    }
    for (const rows of groups.values()) {
        const affected = rows.some(row => row.cleanName !== row.name || /snapshot/i.test(row.condition_key));
        const protectedRows = rows.filter(row => protectedIDs.has(Number(row.ID)));
        if (!affected || rows[0].deleted_at != null || protectedRows.length > 1) {
            retained.push(...rows);
            if (affected && protectedRows.length > 1) blocked.push({ IDs: rows.map(row => Number(row.ID)), reason: 'multiple_personal_pie_references' });
            continue;
        }
        rows.sort((a, b) => Number(b.is_default) - Number(a.is_default)
            || Number(protectedIDs.has(Number(b.ID))) - Number(protectedIDs.has(Number(a.ID)))
            || Number(b.score_count) - Number(a.score_count) || Number(a.ID) - Number(b.ID));
        // Keep an already-referenced ID so no personal weight or fallback is lost.
        const target = protectedRows[0] ?? rows[0];
        retained.push(target);
        for (const source of rows.filter(row => row !== target)) {
            merges.push({ sourceID: Number(source.ID), targetID: Number(target.ID), resultCount: Number(source.score_count) });
        }
    }
    const updates = retained.filter(row => row.cleanName !== row.name || /snapshot/i.test(row.condition_key)).map(row => {
        let name = row.cleanName;
        const existingDefault = conditions.find(item => Number(item.benchmark_ID) === Number(row.benchmark_ID)
            && Number(item.is_default) && Number(item.ID) !== Number(row.ID)
            && !merges.some(merge => merge.sourceID === Number(item.ID)));
        if (name === 'default' && existingDefault) {
            name = `Standard (${Number(row.uses_percentage_scale) ? 'percentage' : `${Number(row.score_min)} to ${Number(row.score_max)}`};${row.score_direction}${row.target_value == null ? '' : `:${Number(row.target_value)}`})`;
        }
        const isDefault = name === 'default';
        const key = isDefault ? 'default' : /snapshot/i.test(row.condition_key) || row.condition_key === 'default'
            ? `condition-${createHash('sha256').update(`${row.ID}:${name}`).digest('hex').slice(0, 24)}` : row.condition_key;
        return { ID: Number(row.ID), previousName: row.name, name, key, isDefault };
    });
    return { updates, merges, blocked };
}
