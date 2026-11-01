import { benchmarkAccessibleName, benchmarkConditionLabel } from './weights.js';

export function appendBenchmarkIdentity(element, member) {
    const name = document.createElement('strong');
    name.className = 'bp-benchmark-link-name'; name.textContent = member.name;
    element.append(name);
    const version = benchmarkConditionLabel(member);
    if (version) {
        const detail = document.createElement('span');
        detail.className = 'bp-benchmark-condition'; detail.textContent = version;
        element.append(detail);
    }
    return element;
}

export function createBenchmarkInformationLink(member, { getURL, onInspect, label, className = '' }) {
    const link = document.createElement('a');
    link.className = `bp-benchmark-information-link ${className}`.trim();
    link.href = getURL(member);
    link.dataset.benchmarkControl = 'information';
    link.setAttribute('aria-label', `Information and discussion for ${benchmarkAccessibleName(member)}`);
    if (label !== undefined) link.textContent = label;
    else appendBenchmarkIdentity(link, member);
    link.addEventListener('click', event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        onInspect?.(event);
    });
    return link;
}
