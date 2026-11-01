export const TOPIC_GLYPH = '\uf5fd';
export const SCENE_SEPARATOR_GLYPH = '\uf105';
export const TOPIC_ICON_FONT = '"Font Awesome 6 Free"';
const icons = new Map([[TOPIC_GLYPH, 'fa-layer-group'], [SCENE_SEPARATOR_GLYPH, 'fa-angle-right']]);

export function isTopicReference(entry) {
    return entry?.type === 'topic' || Number(entry?.conditionID ?? entry?.ID) < 0;
}

export function referenceLabel(target) {
    return target.sceneName ? `${target.topicName || target.name} / ${target.sceneName}` : target.topicName || target.name;
}

export function topicLabelText(target) {
    const parent = target.topicName || target.name;
    return `${TOPIC_GLYPH} ${parent}${target.sceneName ? ` ${SCENE_SEPARATOR_GLYPH} ${target.sceneName}` : ''}`;
}

export function topicLabelParts(text) {
    return String(text).split(/([\uf5fd\uf105])/).filter(Boolean).map(value => ({ text: value, icon: icons.get(value) }));
}

export function renderTopicLabel(host, text) {
    const svg = host.namespaceURI === 'http://www.w3.org/2000/svg';
    if (svg) host.style.whiteSpace = 'pre';
    host.replaceChildren(...topicLabelParts(text).map(part => {
        if (!part.icon) return document.createTextNode(part.text);
        const icon = svg ? document.createElementNS(host.namespaceURI, 'tspan') : document.createElement('i');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('class', `fa-solid ${part.icon}`);
        if (svg) {
            icon.setAttribute('font-family', TOPIC_ICON_FONT);
            icon.setAttribute('font-weight', '900');
            icon.textContent = part.text;
        }
        return icon;
    }));
}
