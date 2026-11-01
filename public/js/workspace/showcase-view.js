import { createShowcaseScrollGate } from './showcase-scroll-gate.js';
import { createShowcaseWeightScroll } from './showcase-weight-scroll.js';

const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => { const p = clamp(value); return p * p * (3 - 2 * p); };

export function showcaseProgress(scrollTop, start, height, viewportHeight, holdDistance = 0) {
    return clamp((scrollTop - start) / Math.max(1, height - viewportHeight - holdDistance));
}

export function showcaseFrame(progress, reduced = false) {
    const p = clamp(progress);
    return {
        hero: reduced ? 0 : 1 - ease((p - .04) / .25),
        reveal: reduced ? 1 : ease(p / .35),
        outro: ease((p - .74) / .18),
        departure: reduced ? 0 : ease((p - .76) / .24),
        chapter: p < .4 ? 'The weights' : p < .76 ? 'The ranking' : 'Your turn'
    };
}

export function showcasePull(distance) {
    return { progress: clamp(distance / 76), ready: distance >= 76 };
}

export function createShowcaseView({ state, onEnter, onPresent }) {
    const section = document.getElementById('showcase');
    const body = document.body;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const categories = document.getElementById('showcase-categories');
    const enter = document.getElementById('showcase-enter');
    const startButton = document.getElementById('showcase-start');
    const context = document.getElementById('showcase-context');
    const source = document.getElementById('showcase-source');
    const question = document.getElementById('showcase-question');
    const intro = document.getElementById('showcase-intro');
    const chapter = document.getElementById('showcase-chapter');
    const grid = document.querySelector('.bp-workspace-grid');
    const sidebar = document.querySelector('.bp-sidebar');
    const trigger = document.getElementById('showcase-trigger');
    const touchScreen = window.matchMedia('(max-width: 760px), (pointer: coarse)');
    const prompt = document.createElement('div'); prompt.className = 'bp-showcase-pull-prompt';
    prompt.setAttribute('role', 'status'); prompt.setAttribute('aria-live', 'polite');
    const arrow = document.createElement('i'); arrow.className = 'fa-solid fa-arrow-down'; arrow.setAttribute('aria-hidden', 'true');
    const promptText = document.createElement('span'); prompt.append(arrow, promptText); body.append(prompt);
    let active = false, frame = 0, progress = 0, start = 0, height = 1, viewport = 1, holdDistance = 0, entering = false;
    let drawerWasOpen = false;
    let pull = null, promptTimer = 0;
    let advancing = false;
    const scrollGate = createShowcaseScrollGate(() => active, () => { advancing = false; });
    const weightScroll = createShowcaseWeightScroll({ panel: document.getElementById('weight-bars-panel'),
        viewport: document.getElementById('weight-bars'), isActive: () => active && !body.classList.contains('taxonomy-open') });

    function hidePrompt() {
        window.clearTimeout(promptTimer); promptTimer = 0;
        prompt.classList.remove('is-visible', 'is-ready');
    }

    function showPrompt(distance = 0) {
        window.clearTimeout(promptTimer);
        const values = showcasePull(distance);
        promptText.textContent = values.ready ? 'Release to open the overview' : 'Pull down to open the overview';
        prompt.style.setProperty('--pull-progress', values.progress);
        prompt.classList.toggle('is-ready', values.ready);
        prompt.classList.add('is-visible');
    }

    function entryBlocked() {
        return active || entering || body.classList.contains('taxonomy-open')
            || body.classList.contains('discussion-open')
            || Boolean(document.querySelector('global-dialog:not([hidden]), dialog[open]'));
    }

    async function present() {
        if (entryBlocked()) return;
        hidePrompt(); entering = true;
        try { await onPresent(); }
        finally { entering = false; }
    }

    trigger.addEventListener('click', event => {
        if (entryBlocked()) return;
        if (!touchScreen.matches || event.detail === 0) void present();
        else { showPrompt(); promptTimer = window.setTimeout(hidePrompt, 1600); }
    });
    document.querySelector('.bp-workspace').addEventListener('touchstart', event => {
        if (!touchScreen.matches || entryBlocked() || state.gestureOpen || window.scrollY > 1 || event.touches.length !== 1) return;
        if (event.target.closest('button:not(.bp-showcase-trigger), a, input, textarea, select, [contenteditable], [role="slider"], .bp-pie-stage, .bp-family-list')) return;
        for (let node = event.target; node && node !== body; node = node.parentElement) if (node.scrollTop > 1) return;
        const touch = event.touches[0];
        pull = { ID: touch.identifier, x: touch.clientX, y: touch.clientY, distance: 0 };
    }, { passive: true });
    window.addEventListener('touchmove', event => {
        if (!pull) return;
        const touch = [...event.touches].find(item => item.identifier === pull.ID);
        if (!touch || event.touches.length !== 1 || entryBlocked() || state.gestureOpen) { pull = null; hidePrompt(); return; }
        const dx = Math.abs(touch.clientX - pull.x), dy = touch.clientY - pull.y;
        if (dx > 12 && dx > Math.abs(dy) || dy < -8) { pull = null; hidePrompt(); return; }
        pull.distance = Math.max(0, dy);
        if (dy > 12 && dy > dx) { event.preventDefault(); showPrompt(dy); }
    }, { passive: false });
    window.addEventListener('touchend', () => {
        const ready = pull && showcasePull(pull.distance).ready;
        pull = null; hidePrompt();
        if (ready) void present();
    });
    window.addEventListener('touchcancel', () => { pull = null; hidePrompt(); });

    const drawerObserver = new window.MutationObserver(() => {
        if (!active) return;
        const open = body.classList.contains('taxonomy-open');
        section.inert = open;
        grid.inert = open || showcaseFrame(progress, reduced.matches).outro > .5;
        if (drawerWasOpen && !open) categories.focus({ preventScroll: true });
        drawerWasOpen = open;
    });
    drawerObserver.observe(body, { attributes: true, attributeFilter: ['class'] });

    function measure() {
        start = section.getBoundingClientRect().top + window.scrollY;
        height = section.offsetHeight;
        viewport = document.documentElement.clientHeight;
        // The extra scroll runway holds the fully settled third screen, not the earlier animations.
        holdDistance = section.querySelector('.bp-showcase-stage').offsetHeight;
        const heading = section.querySelector('.bp-showcase-scene-heading');
        const compact = window.matchMedia('(max-width: 760px)').matches;
        body.style.setProperty('--showcase-grid-top', `${heading.offsetTop + heading.offsetHeight + (compact ? 16 : 24)}px`);
    }

    function draw() {
        frame = 0;
        if (!active) return;
        progress = showcaseProgress(window.scrollY, start, height, viewport, holdDistance);
        const values = showcaseFrame(progress, reduced.matches);
        body.style.setProperty('--showcase-hero', values.hero);
        body.style.setProperty('--showcase-reveal', values.reveal);
        body.style.setProperty('--showcase-outro', values.outro);
        body.style.setProperty('--showcase-departure', values.departure);
        section.dataset.chapter = values.chapter;
        chapter.textContent = values.chapter;
        grid.inert = values.outro > .5 || body.classList.contains('taxonomy-open');
        section.querySelector('.bp-showcase-hero').inert = values.hero < .05;
        const outro = section.querySelector('.bp-showcase-outro');
        outro.inert = values.outro < .5;
        outro.setAttribute('aria-hidden', String(values.outro < .5));
        if (window.scrollY >= start + height - viewport - 2 && !body.classList.contains('taxonomy-open')
            && !document.querySelector('global-dialog:not([hidden]), dialog[open]') && !entering) void leave(!advancing && scrollGate.recentlyScrolling());
    }

    function schedule() { if (active && !frame) frame = window.requestAnimationFrame(draw); }

    async function leave(fromScroll = false) {
        if (!active || entering) return;
        entering = true; enter.disabled = true; startButton.disabled = true;
        if (fromScroll === true) scrollGate.begin();
        try { await onEnter(); }
        finally { entering = false; advancing = false; scrollGate.finish(); enter.disabled = false; startButton.disabled = false; }
    }

    function render() {
        const next = state.workspaceDisplay === 'charts';
        const changed = next !== active;
        active = next; section.hidden = !active;
        if (changed) { pull = null; hidePrompt(); weightScroll.reset(); }
        if (changed && active) body.classList.add('showcase-starting');
        body.classList.toggle('is-showcase', active);
        if (!active) { window.cancelAnimationFrame(frame); frame = 0; grid.inert = false; section.inert = false; scrollGate.capture(); return; }
        if (changed) { scrollGate.reset(); advancing = false; }
        source.textContent = state.mode === 'personal' ? 'Your AI ranking' : "The community's AI ranking";
        context.textContent = state.categoryPath.split('/').map(part => part.replaceAll('-', ' ')).join(' / ') || 'Intelligence';
        const values = Object.values(state.selectedContextValues).filter(Boolean);
        if (values.length) context.textContent += ' / ' + values.join(' / ');
        question.replaceChildren();
        const strong = document.createElement('strong');
        if (state.mode === 'personal') { strong.textContent = 'rank AI'; question.append('How would you ', strong, ' for this task?'); }
        else { strong.textContent = 'should count?'; question.append('Which AI benchmarks ', strong); }
        intro.textContent = state.mode === 'personal'
            ? 'The community chooses the weights.\nThe results speak for themselves.'
            : 'AI labs choose what they report. Help the community decide what counts, and how much.';
        if (changed) { window.scrollTo({ top: 0, behavior: 'instant' }); progress = 0; }
        measure(); draw();
        if (changed) window.requestAnimationFrame(() => body.classList.remove('showcase-starting'));
    }

    categories.addEventListener('click', event => {
        event.stopPropagation();
        document.getElementById('taxonomy-toggle').click();
        if (body.classList.contains('taxonomy-open')) document.getElementById('taxonomy-close').focus({ preventScroll: true });
    });
    enter.addEventListener('click', () => { void leave(); }); startButton.addEventListener('click', () => { void leave(); });
    document.getElementById('showcase-next').addEventListener('click', () => {
        advancing = true;
        const travel = Math.max(1, height - viewport - holdDistance);
        const next = progress < .34 ? travel * .42 : progress < .72 ? travel : height - viewport;
        window.scrollTo({ top: start + next, behavior: reduced.matches ? 'instant' : 'smooth' });
    });
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', () => { if (active) { measure(); schedule(); } }, { passive: true });
    window.addEventListener('keydown', event => {
        if (!active || !body.classList.contains('taxonomy-open') || event.key !== 'Tab') return;
        const controls = [...sidebar.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')]
            .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
            event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        }
    });
    window.addEventListener('pageshow', () => { if (active) { measure(); schedule(); } });
    reduced.addEventListener('change', () => { if (active) { measure(); schedule(); } });
    window.addEventListener('pagehide', () => { window.cancelAnimationFrame(frame); frame = 0; pull = null; hidePrompt(); scrollGate.destroy(); weightScroll.destroy(); }, { once: true });
    return { render };
}
