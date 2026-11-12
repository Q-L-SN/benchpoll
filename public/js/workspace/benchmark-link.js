import { benchmarkAccessibleName, benchmarkConditionLabel } from './weights.js';
import { isTopicReference, topicLabelText, renderTopicLabel, referenceLabel, TOPIC_GLYPH } from '../shared/topic-label.js';

export function appendBenchmarkIdentity(element, member, { showVersion = false } = {}) {
    const name = document.createElement('strong');
    name.className = 'bp-benchmark-link-name';
    if (isTopicReference(member)) {
        const icon = document.createElement('i'); icon.className = 'fa-solid fa-layer-group'; icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span'); label.className = 'bp-topic-link-label';
        renderTopicLabel(label, topicLabelText(member).replace(`${TOPIC_GLYPH} `, ''));
        name.append(icon, document.createTextNode(' '), label);
    }
    else name.textContent = member.name;
    element.append(name);
    const version = !showVersion || isTopicReference(member) || member.isBenchmarkGroup ? '' : benchmarkConditionLabel(member);
    if (version) {
        const detail = document.createElement('span');
        detail.className = 'bp-benchmark-condition'; detail.textContent = version;
        element.append(detail);
    }
    return element;
}

export function createBenchmarkInformationLink(member, { getURL, onInspect, label, className = '', showVersion = false }) {
    const link = document.createElement('a');
    link.className = `bp-benchmark-information-link ${className}`.trim();
    const reference = isTopicReference(member);
    link.href = reference ? member.url : getURL(member);
    link.dataset.benchmarkControl = 'information';
    link.setAttribute('aria-label', reference ? `Visit ${referenceLabel(member)}` : `Information and discussion for ${benchmarkAccessibleName(member, { showVersion })}`);
    if (label !== undefined) link.textContent = label;
    else appendBenchmarkIdentity(link, member, { showVersion });
    link.addEventListener('click', event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (!reference) onInspect?.(event);
    });
    return link;
}
