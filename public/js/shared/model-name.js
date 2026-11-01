export function protectModelName(element, enabled = true) {
    element.translate = !enabled;
    element.classList.toggle('notranslate', enabled);
    return element;
}
