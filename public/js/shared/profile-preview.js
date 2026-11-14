import { createFloatingSearchLayer } from './floating-search-layer.js';
import { parseTopicPath } from './topics.js';
import { setLoading } from './loading.js';

const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

// The account link still navigates to /me. Desktop hover exposes only these two
// collections, using the current account's already-authorized topic directory.
export function mountProfilePreview(anchor, { getState }) {
    const desktop = window.matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)');
    const panel = element('section', 'th-profile-preview');
    panel.id = 'topics-account-preview'; panel.hidden = true;
    panel.setAttribute('aria-label', 'Your topic collections');
    document.body.append(panel);
    let closeTimer = null, dismissed = false;
    const cancelClose = () => { clearTimeout(closeTimer); closeTimer = null; };
    const layer = createFloatingSearchLayer({ anchor, panel, align: 'end', width: 500, maxHeight: 430, gap: 8,
        onClose(reason) {
            cancelClose(); anchor.setAttribute('aria-expanded', 'false');
            if (reason === 'escape') dismissed = true;
        } });
    function destination(path, personal = false) {
        if (typeof path !== 'string' || !parseTopicPath(path)) return null;
        const url = new URL(path, location.origin);
        if (url.origin !== location.origin) return null;
        if (personal) url.searchParams.set('mode', 'personal');
        return url.pathname + url.search;
    }
    function section(label, icon, items, empty) {
        const section = element('section', 'th-profile-collection');
        const heading = element('h2', '', label), glyph = element('i', `fa-solid fa-${icon}`);
        glyph.setAttribute('aria-hidden', 'true'); heading.prepend(glyph);
        const list = element('ul', 'th-profile-collection-list');
        for (const item of items) {
            const url = destination(item.url, item.personal);
            if (!url) continue;
            const row = element('li', ''), link = element('a', '', item.name); link.href = url;
            if (item.isPrivate) { const lock = element('i', 'fa-solid fa-lock'); lock.setAttribute('aria-label', 'Private topic'); link.prepend(lock); }
            row.append(link); list.append(row);
        }
        section.append(heading, list);
        if (!list.childElementCount) section.append(element('p', 'th-profile-empty', empty));
        return section;
    }
    function render() {
        const state = getState();
        panel.replaceChildren();
        if (state.loading) { setLoading(panel, 'Loading your topics'); return; }
        if (state.failed) { panel.append(element('p', 'th-profile-empty', 'Open your profile to view your topics.')); return; }
        const topics = state.topics.filter(topic => !topic.isPrivate || topic.isMine === true);
        const configured = topics.filter(topic => topic.configured).flatMap(topic => {
            const scenes = (topic.scenes ?? []).filter(scene => (topic.configuredContextIDs ?? []).includes(Number(scene.ID)));
            if (scenes.length) return scenes.map(scene => ({ name: `${topic.name} › ${scene.name}`, url: scene.url,
                personal: true, isPrivate: topic.isPrivate }));
            const context = topic.configuredPersonalContext;
            return [{ name: context?.name && context.name !== topic.name ? `${topic.name} › ${context.name}` : topic.name,
                url: context?.url ?? topic.url, personal: true, isPrivate: topic.isPrivate }];
        });
        panel.append(section('Favorites', 'star', topics.filter(topic => topic.isFavorited), 'No favorites yet.'),
            section('Configured', 'sliders', configured, 'No personal weights yet.'));
    }
    function open() {
        cancelClose();
        if (dismissed || !desktop.matches || !getState().profile) return false;
        render();
        if (!layer.open()) return false;
        anchor.setAttribute('aria-expanded', 'true'); return true;
    }
    function scheduleClose() {
        cancelClose();
        closeTimer = setTimeout(() => { if (!panel.contains(document.activeElement)) layer.close(); }, 160);
    }
    anchor.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { dismissed = false; open(); } });
    anchor.addEventListener('pointerleave', scheduleClose);
    anchor.addEventListener('focus', open);
    anchor.addEventListener('blur', () => { dismissed = false; });
    anchor.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' && open()) { event.preventDefault(); panel.querySelector('a')?.focus(); }
    });
    panel.addEventListener('pointerenter', cancelClose);
    panel.addEventListener('pointerleave', scheduleClose);
    panel.addEventListener('focusin', cancelClose);
    const refresh = () => {
        if (!getState().profile || !desktop.matches) {
            layer.close(); panel.replaceChildren(); anchor.removeAttribute('aria-controls'); anchor.removeAttribute('aria-expanded');
        } else {
            anchor.setAttribute('aria-controls', panel.id);
            anchor.setAttribute('aria-expanded', String(layer.isOpen));
            if (layer.isOpen) render();
        }
    };
    desktop.addEventListener('change', refresh);
    return { refresh, close: () => layer.close() };
}
