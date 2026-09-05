import { MIN_WEIGHT_BASIS_POINTS } from './constants.js';

function cloneEntries(entries) {
    return entries.map(entry => ({ ...entry }));
}

function cloneFallbackRules(rules) {
    return rules.map(rule => ({
        ...rule,
        entries: rule.entries.map(entry => ({ ...entry }))
    }));
}

function clonePersonalPieSnapshot(snapshot) {
    return {
        entries: cloneEntries(snapshot?.entries ?? []),
        fallbackRules: cloneFallbackRules(snapshot?.fallbackRules ?? [])
    };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function humanizePathPart(part) {
    let decoded = String(part ?? '');
    try {
        decoded = decodeURIComponent(decoded.replace(/\+/g, ' '));
    } catch {
        // Keep the original text when a legacy path contains an incomplete escape.
    }
    return decoded.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

function polarToCartesian(cx, cy, radius, angle) {
    const radians = (angle - 90) * Math.PI / 180;
    return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function describeArc(cx, cy, radius, startAngle, endAngle) {
    if (endAngle - startAngle >= 359.999) {
        const start = polarToCartesian(cx, cy, radius, startAngle);
        const opposite = polarToCartesian(cx, cy, radius, startAngle + 180);
        return [
            `M ${start.x} ${start.y}`,
            `A ${radius} ${radius} 0 1 0 ${opposite.x} ${opposite.y}`,
            `A ${radius} ${radius} 0 1 0 ${start.x} ${start.y}`,
            'Z'
        ].join(' ');
    }
    const start = polarToCartesian(cx, cy, radius, endAngle);
    const end = polarToCartesian(cx, cy, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
    return [
        `M ${cx} ${cy}`,
        `L ${start.x} ${start.y}`,
        `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
        'Z'
    ].join(' ');
}

function splitPieLabel(label) {
    const words = String(label).trim().split(/\s+/).filter(Boolean);
    if (words.length <= 1) {
        return [words[0] || 'Other'];
    }
    if (words.length === 2) {
        return words;
    }
    const midpoint = Math.ceil(words.length / 2);
    return [words.slice(0, midpoint).join(' '), words.slice(midpoint).join(' ')];
}

function benchmarkConditionLabel(object) {
    if (!object) {
        return '';
    }
    const conditionName = String(object.conditionName ?? '').trim();
    return conditionName.toLocaleLowerCase('en-US') === 'default' ? '' : conditionName;
}

function benchmarkAccessibleName(object) {
    if (!object) {
        return '';
    }
    const conditionLabel = benchmarkConditionLabel(object);
    return conditionLabel ? `${object.name}, ${conditionLabel}` : object.name;
}

function distributeToTarget(entries, target, minimum = MIN_WEIGHT_BASIS_POINTS) {
    if (entries.length === 0) {
        return [];
    }
    const minimumTotal = entries.length * minimum;
    const normalizedTarget = Math.max(minimumTotal, Math.round(target));
    const distributable = normalizedTarget - minimumTotal;
    const raw = entries.map(entry => Math.max(0, Number(entry.weightBasisPoints) - minimum));
    const rawTotal = raw.reduce((sum, value) => sum + value, 0);
    const exact = raw.map(value => distributable * (rawTotal > 0 ? value / rawTotal : 1 / entries.length));
    const floors = exact.map(Math.floor);
    let remaining = distributable - floors.reduce((sum, value) => sum + value, 0);
    exact
        .map((value, index) => ({ index, fraction: value - floors[index] }))
        .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index))
        .forEach(item => {
            if (remaining > 0) {
                floors[item.index] += 1;
                remaining -= 1;
            }
        });
    return entries.map((entry, index) => ({
        ...entry,
        weightBasisPoints: minimum + floors[index],
        weight: (minimum + floors[index]) / 100
    }));
}

export { cloneEntries, cloneFallbackRules, clonePersonalPieSnapshot, clamp, humanizePathPart, polarToCartesian, describeArc, splitPieLabel, benchmarkConditionLabel, benchmarkAccessibleName, distributeToTarget };
