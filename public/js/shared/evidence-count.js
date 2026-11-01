export function updateEvidenceCount(element, count, { kind = 'scores', modelCount } = {}) {
    const description = kind === 'models'
        ? `Scores from ${count} ${count === 1 ? 'model' : 'models'}.`
        : `${count} approved ${count === 1 ? 'score' : 'scores'}`
            + (typeof modelCount === 'number' ? ` from ${modelCount} ${modelCount === 1 ? 'model' : 'models'}` : '') + '.';
    element.querySelector('.bp-evidence-count-value').textContent = String(count);
    element.dataset.tooltip = description;
    element.setAttribute('aria-label', description);
    return element;
}

export function createEvidenceCount(count, options) {
    const element = document.createElement('span');
    element.className = 'bp-evidence-count';
    element.tabIndex = 0;
    element.setAttribute('role', 'img');
    element.innerHTML = '<i class="fa-solid fa-chart-simple" aria-hidden="true"></i>'
        + '<span class="bp-evidence-count-value" aria-hidden="true"></span>';
    return updateEvidenceCount(element, count, options);
}
