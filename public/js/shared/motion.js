import { mountDisclosureChevron } from './disclosure-chevron.js';

const transitions = new WeakMap();
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pieTransitions = new WeakMap();

function pieFace(snapshot) {
    // Temporary faces own separate paint-server IDs and never accept interaction.
    const prefix = `flip-${window.crypto.randomUUID()}-`;
    const IDs = new Map([...snapshot.querySelectorAll('[id]')].map(element => [element.id, prefix + element.id]));
    for (const element of [snapshot, ...snapshot.querySelectorAll('*')]) {
        if (element === snapshot) element.removeAttribute('id');
        else if (IDs.has(element.id)) element.id = IDs.get(element.id);
        for (const attribute of [...element.attributes]) {
            let value = attribute.value;
            for (const [oldID, ID] of IDs) value = value.replaceAll(`url(#${oldID})`, `url(#${ID})`);
            if (['href', 'xlink:href'].includes(attribute.name) && IDs.has(value.slice(1))) value = `#${IDs.get(value.slice(1))}`;
            if (value !== attribute.value) element.setAttribute(attribute.name, value);
        }
    }
    snapshot.removeAttribute('hidden');
    snapshot.classList.remove('bp-pie-live-in-motion');
    snapshot.classList.add('bp-pie-transition-face');
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.inert = true;
    snapshot.style.cssText = 'width:100%;height:100%;pointer-events:none;visibility:visible';
    return snapshot;
}

function transitionPie(svg, previous, { kind, from, to }) {
    const stage = svg.parentElement;
    const active = pieTransitions.get(stage);
    if (reduceMotion() || !svg.isConnected || svg.hasAttribute('hidden')) {
        active?.cleanup();
        return Promise.resolve();
    }
    const reverse = active?.kind === kind && from === active.goal && to !== from && active.keys.includes(to);
    if (reverse) {
        const latest = pieFace(svg.cloneNode(true));
        const face = active.faces[active.keys.indexOf(to)];
        face.replaceChildren(...latest.childNodes);
        face.setAttribute('viewBox', latest.getAttribute('viewBox'));
        active.watch(svg);
        active.goal = to;
        active.animations.forEach(animation => animation.reverse());
        return active.finished;
    }
    active?.cleanup();
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width || !bounds.height || previous.hasAttribute('hidden')) return Promise.resolve();
    const hostBounds = stage.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'bp-pie-transition';
    layer.dataset.kind = kind;
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    layer.style.cssText = `left:${bounds.left - hostBounds.left - stage.clientLeft + stage.scrollLeft}px;top:${bounds.top - hostBounds.top - stage.clientTop + stage.scrollTop}px;width:${bounds.width}px;height:${bounds.height}px`;
    const turntable = document.createElement('div');
    turntable.className = 'bp-pie-turntable';
    const faces = [pieFace(previous), pieFace(svg.cloneNode(true))];
    faces[1].classList.add('is-back');
    turntable.append(...faces);
    layer.append(turntable);
    stage.append(layer);
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    const originals = new Map();
    let currentSVG, markup, ended = false;
    const observer = new MutationObserver(() => {
        if (currentSVG.innerHTML !== markup) motion.cleanup();
    });
    const sizeObserver = new window.ResizeObserver(() => {
        const next = currentSVG.getBoundingClientRect();
        if (Math.abs(next.width - bounds.width) > 1 || Math.abs(next.height - bounds.height) > 1) motion.cleanup();
    });
    const motion = {
        kind, keys: [from, to], goal: to, faces, animations: [], finished,
        watch(live) {
            observer.disconnect(); sizeObserver.disconnect();
            if (!originals.has(live)) originals.set(live, live.inert);
            live.classList.add('bp-pie-live-in-motion'); live.inert = true;
            currentSVG = live; markup = live.innerHTML;
            observer.observe(live, { childList: true, subtree: true, attributes: true });
            sizeObserver.observe(live);
        },
        cleanup() {
            if (ended) return;
            ended = true;
            observer.disconnect(); sizeObserver.disconnect();
            motion.animations.forEach(animation => animation.cancel());
            layer.remove();
            for (const [live, wasInert] of originals) {
                live.classList.remove('bp-pie-live-in-motion'); live.inert = wasInert;
            }
            if (pieTransitions.get(stage) === motion) pieTransitions.delete(stage);
            resolveFinished();
        }
    };
    pieTransitions.set(stage, motion);
    motion.watch(svg);
    const timing = { duration: kind === 'flip' ? 430 : 170, easing: 'cubic-bezier(.42,0,.58,1)', fill: 'both' };
    // WebKit can paint back-facing SVGs; gate each half on the turntable's timeline.
    motion.animations = kind === 'flip'
        ? [turntable.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-180deg)' }], timing),
            ...faces.map((face, index) => face.animate([
                { opacity: 1 - index, offset: 0, easing: 'steps(1,end)' },
                { opacity: index, offset: .5 },
                { opacity: index, offset: 1 }
            ], timing))]
        : [faces[0].animate([{ opacity: 1 }, { opacity: 0 }], timing), faces[1].animate([{ opacity: 0 }, { opacity: 1 }], timing)];
    Promise.all(motion.animations.map(animation => animation.finished)).then(motion.cleanup, motion.cleanup);
    return finished;
}

export function flipPie(svg, previous, { from, to } = {}) {
    return transitionPie(svg, previous, { kind: 'flip', from, to });
}

export function crossfadePie(svg, previous, { from, to } = {}) {
    return transitionPie(svg, previous, { kind: 'fade', from, to });
}

export function animateContent(element, { translate = true } = {}) {
    if (!element || reduceMotion()) return;
    transitions.get(element)?.cancel();
    const animation = element.animate([
        { opacity: .35, ...(translate ? { transform: 'translateY(4px)' } : {}) },
        { opacity: 1, ...(translate ? { transform: 'translateY(0)' } : {}) }
    ], { duration: 180, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    transitions.set(element, animation);
    animation.finished.then(() => {
        if (transitions.get(element) === animation) transitions.delete(element);
    }, () => {});
}

export function setVisible(element, visible, { collapse = false } = {}) {
    element.inert = !visible;
    element.setAttribute('aria-hidden', String(!visible));
    const previous = transitions.get(element);
    if (!previous && element.hidden === !visible) return Promise.resolve();
    const wasHidden = element.hidden;
    const startHeight = wasHidden ? 0 : element.getBoundingClientRect().height;
    const startOpacity = wasHidden ? 0 : getComputedStyle(element).opacity;
    previous?.cancel();
    if (reduceMotion()) { element.hidden = !visible; transitions.delete(element); return Promise.resolve(); }
    element.hidden = false;
    const endHeight = visible ? element.getBoundingClientRect().height : 0;
    const animation = element.animate([
        { opacity: startOpacity, ...(collapse ? { height: `${startHeight}px`, overflow: 'hidden' } : { transform: visible ? 'translateY(-4px)' : 'translateY(0)' }) },
        { opacity: visible ? 1 : 0, ...(collapse ? { height: `${endHeight}px`, overflow: 'hidden' } : { transform: visible ? 'translateY(0)' : 'translateY(-4px)' }) }
    ], { duration: 190, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    transitions.set(element, animation);
    return animation.finished.then(() => {
        if (transitions.get(element) !== animation) return;
        element.hidden = !visible;
        transitions.delete(element);
    }, () => {});
}

const disclosures = new WeakMap();

export function isDisclosureOpen(details) {
    return disclosures.get(details)?.open ?? details.open;
}

export function setDisclosureOpen(details, open, { animate = true } = {}) {
    mountDisclosureChevron(details.querySelector(':scope > summary'));
    const previous = disclosures.get(details);
    if (!previous && details.open === open) return Promise.resolve();
    const startHeight = details.getBoundingClientRect().height;
    previous?.animation.cancel();
    if (!animate || reduceMotion()) {
        details.open = open;
        delete details.dataset.uiDisclosureOpen;
        disclosures.delete(details);
        return Promise.resolve();
    }
    // During closing, native open remains true until height animation finishes.
    details.dataset.uiDisclosureOpen = String(open);
    details.open = open;
    const endHeight = details.getBoundingClientRect().height;
    details.open = true;
    const animation = details.animate([
        { height: `${startHeight}px`, overflow: 'hidden' },
        { height: `${endHeight}px`, overflow: 'hidden' }
    ], { duration: 190, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    const transition = { open, animation };
    disclosures.set(details, transition);
    return animation.finished.then(() => {
        if (disclosures.get(details) !== transition) return;
        details.open = open;
        delete details.dataset.uiDisclosureOpen;
        disclosures.delete(details);
    }, () => {});
}

export function mountDisclosureMotion(container, selector) {
    container.addEventListener('click', event => {
        const summary = event.target.closest('summary');
        const details = summary?.parentElement;
        if (!details?.matches(selector) || !container.contains(details)) return;
        const control = event.target.closest('a, button, input, select, textarea');
        if (control && summary.contains(control)) return;
        event.preventDefault();
        void setDisclosureOpen(details, !isDisclosureOpen(details));
    });
}
