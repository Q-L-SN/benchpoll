function escapeHTML(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function option(value, label, selectedValue) {
    return `<option value="${escapeHTML(value)}"${String(value) === String(selectedValue) ? ' selected' : ''}>${escapeHTML(label)}</option>`;
}

function finiteOrNull(value) {
    if (value === '' || value === null || value === undefined) {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
    const number = finiteOrNull(value);
    return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function entityKey(value) {
    return value === null || value === undefined ? '' : String(value);
}

function sameEntityID(left, right) {
    return entityKey(left) !== '' && entityKey(left) === entityKey(right);
}

function entityLocator(entity, idField, referenceField) {
    return entity?.reference
        ? { [idField]: null, [referenceField]: entity.reference }
        : { [idField]: entity ? Number(entity.ID) : null, [referenceField]: null };
}

function pendingBadge(entity) {
    return entity?.pending ? '<span class="pending-entity-badge">Pending review</span>' : '';
}

function evaluationScoreBounds(evaluation) {
    if (evaluation.usesPercentageScale) {
        return { min: null, max: null };
    }
    return {
        min: finiteOrNull(evaluation.scoreMin),
        max: finiteOrNull(evaluation.scoreMax)
    };
}

function evaluationDisplayScoreBounds(evaluation) {
    if (evaluation.usesPercentageScale) {
        return { min: 0, max: 100 };
    }
    return evaluationScoreBounds(evaluation);
}

function evaluationStoredTargetValue(evaluation) {
    if (evaluation.scoreDirection !== 'closer_to_target') {
        return null;
    }
    const targetValue = finiteOrNull(evaluation.targetValue);
    if (targetValue === null) {
        return null;
    }
    return targetValue;
}

function normalizedConditionName(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function isLiteralDefaultCondition(value) {
    return normalizedConditionName(value) === 'default';
}

function normalizedIdentifierKey(value) {
    const normalized = String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return normalized || `text:${normalizedConditionName(value)}`;
}

function normalizedSearch(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function rankedMatches(items, query, label) {
    const normalizedQuery = normalizedSearch(query);
    return items
        .map(item => {
            const itemLabel = label(item);
            const normalizedLabel = normalizedSearch(itemLabel);
            const matchIndex = normalizedQuery ? normalizedLabel.indexOf(normalizedQuery) : 0;
            return { item, itemLabel, normalizedLabel, matchIndex, startsWith: normalizedLabel.startsWith(normalizedQuery) };
        })
        .filter(candidate => candidate.matchIndex >= 0)
        .sort((left, right) => (
            Number(right.startsWith) - Number(left.startsWith)
            || left.matchIndex - right.matchIndex
            || left.itemLabel.length - right.itemLabel.length
            || left.itemLabel.localeCompare(right.itemLabel)
        ))
        .slice(0, 8)
        .map(candidate => candidate.item);
}

export { escapeHTML, option, finiteOrNull, integerOrNull, entityKey, sameEntityID, entityLocator, pendingBadge, evaluationScoreBounds, evaluationDisplayScoreBounds, evaluationStoredTargetValue, normalizedConditionName, isLiteralDefaultCondition, normalizedIdentifierKey, normalizedSearch, rankedMatches };
