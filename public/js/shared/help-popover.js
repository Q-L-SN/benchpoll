const triggerSelector = '[data-tooltip], [data-help-text], [data-help-content]';
const focusableSelector = 'a[href], button, input, select, textarea, summary, [tabindex]';
const actionSelector = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"]';
const familiarActionIconSelector = '.fa-xmark, .fa-magnifying-glass, .fa-chevron-left, .fa-chevron-right, '
    + '.fa-angle-left, .fa-angle-right, .fa-arrow-left, .fa-arrow-right, .fa-arrow-right-arrow-left, '
    + '.fa-plus, .fa-minus, .fa-pen-to-square, .fa-trash-can, .fa-copy, .fa-rotate, .fa-rotate-right, '
    + '.fa-rotate-left, .fa-arrow-rotate-left, .fa-arrow-rotate-right, .fa-ellipsis';
const singleton = Symbol.for('benchpoll.shared-tooltip');
const normalizeLabel = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
const containsLabel = (text, label) => Boolean(label) && ` ${text} `.includes(` ${label} `);

export function helpPopoverGeometry(anchor, viewport, height, preferredWidth = 380) {
    const margin = Math.min(12, viewport.width / 4, viewport.height / 4);
    const width = Math.max(1, Math.min(preferredWidth, viewport.width - 2 * margin));
    const aboveSpace = Math.max(0, anchor.top - 8 - viewport.top - margin);
    const belowSpace = Math.max(0, viewport.top + viewport.height - margin - anchor.bottom - 8);
    const below = height > aboveSpace && (height <= belowSpace || belowSpace > aboveSpace);
    const maxHeight = Math.max(1, Math.min(viewport.height - 2 * margin, below ? belowSpace : aboveSpace));
    const visibleHeight = Math.min(height, maxHeight);
    const center = Math.max(viewport.left, Math.min(viewport.left + viewport.width,
        ((anchor.left ?? anchor.right) + anchor.right) / 2));
    const left = Math.max(viewport.left + margin, Math.min(viewport.left + viewport.width - width - margin, center - width / 2));
    const top = Math.max(viewport.top + margin, Math.min(viewport.top + viewport.height - visibleHeight - margin,
        below ? anchor.bottom + 8 : anchor.top - visibleHeight - 8));
    const arrowInset = Math.min(12, width / 2);
    const arrowX = Math.max(arrowInset, Math.min(width - arrowInset, center - left));
    return { left, top, width, maxHeight, arrowX, placement: below ? 'bottom' : 'top' };
}

function createHelpController() {
    const panel = document.createElement('div');
    panel.id = 'bp-help-popover';
    panel.className = 'bp-help-popover';
    panel.setAttribute('role', 'tooltip');
    panel.hidden = true;
    const body = document.createElement('div');
    body.className = 'bp-help-body';
    const arrow = document.createElement('span');
    arrow.className = 'bp-help-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    panel.append(body, arrow);
    const topLayer = typeof panel.showPopover === 'function' && typeof panel.hidePopover === 'function';
    if (topLayer) panel.setAttribute('popover', 'manual');
    let active = null, pinned = false, hovered = null, dismissed = null, overPanel = false, pointerType = '';
    let originalDescription = null, originalExpanded = null;
    let hideTimer, showTimer, pressTimer, touch = null, consumedPress = null, handledTap = null;
    let positionFrame = null, animation = null;
    let scrollParents = [];
    const roots = new WeakSet();
    const adoptedTitles = new WeakMap(), generatedNames = new WeakMap();
    const composedParent = node => node.assignedSlot ?? node.parentElement ?? node.getRootNode().host ?? null;
    const resizeObserver = window.ResizeObserver ? new window.ResizeObserver(() => schedulePosition()) : null;
    const anchorObserver = new MutationObserver(() => schedulePosition());
    const isHelp = trigger => trigger.hasAttribute('data-help-content') || trigger.hasAttribute('data-help-text');
    function textIsClipped(trigger) {
        for (const node of [trigger, ...trigger.querySelectorAll('*')]) {
            if (!node.textContent.trim() || !node.getClientRects().length) continue;
            const style = getComputedStyle(node);
            if ((/(auto|scroll|hidden|clip)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1)
                || (/(auto|scroll|hidden|clip)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1)) return true;
        }
        const range = document.createRange();
        range.selectNodeContents(trigger);
        const text = range.getBoundingClientRect();
        if (!text.width || !text.height) return false;
        for (let node = composedParent(trigger); node && node !== document.body; node = composedParent(node)) {
            const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
            if ((/(auto|scroll|hidden|clip)/.test(style.overflowX) && (text.left < bounds.left - 1 || text.right > bounds.right + 1))
                || (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1))) return true;
        }
        return false;
    }
    function shouldShow(trigger) {
        if (isHelp(trigger)) return true;
        const content = trigger.dataset.tooltip?.trim(), label = normalizeLabel(content);
        if (!label) return false;
        const visible = normalizeLabel(trigger.innerText ?? trigger.textContent);
        if (containsLabel(visible, label)) return textIsClipped(trigger);
        // Card headings can repeat the description already printed beside the name.
        const heading = trigger.closest('header');
        for (const peer of heading?.querySelectorAll(triggerSelector) ?? []) {
            if (peer !== trigger && peer.getClientRects().length && getComputedStyle(peer).visibility !== 'hidden'
                && containsLabel(normalizeLabel(peer.innerText ?? peer.textContent), label) && !textIsClipped(peer)) return false;
        }
        if (!trigger.matches(actionSelector) || trigger.matches(':disabled, [aria-disabled="true"]')) return true;
        const name = normalizeLabel(trigger.getAttribute('aria-label'));
        const explanation = content.length > 80 || /[.!?;\n\d]/.test(content)
            || /\b(?:only|limits?|limited|at least|at most|up to|must|cannot|unavailable|without|unless|already|required|because|coverage|fallback)\b/i.test(content);
        // Named text controls and familiar action icons do not need a second label.
        // Keep unfamiliar icon names and explanations (including disabled reasons).
        if (visible && label === name && !explanation && !textIsClipped(trigger)) return false;
        const familiar = trigger.matches(familiarActionIconSelector) || trigger.querySelector(familiarActionIconSelector);
        const briefAction = /^(?:open|close|show|hide|search|clear|previous|next|back|add|edit|change|remove|delete|refresh|retry|undo|redo|reset|save|copy|cancel|switch)\b/i.test(content);
        return !(familiar && !explanation && (label === name || briefAction));
    }
    const deepFocus = () => {
        let node = document.activeElement;
        while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
        return node;
    };
    const inPath = (event, node) => event.composedPath().includes(node);
    function nestedAction(event, trigger) {
        for (const node of event.composedPath()) {
            if (node === trigger) break;
            if (node instanceof Element && node.matches(actionSelector)
                && !node.matches(':disabled, [aria-disabled="true"]')) return true;
        }
        const parentAction = trigger.parentElement?.closest(actionSelector);
        return Boolean(parentAction && !parentAction.matches(':disabled, [aria-disabled="true"]'));
    }
    function tapShowsHelp(trigger, event) {
        if (trigger.dataset.helpAction === 'follow' || nestedAction(event, trigger)) return false;
        return isHelp(trigger) || !trigger.closest(actionSelector) || trigger.matches(':disabled, [aria-disabled="true"]');
    }
    const viewport = () => {
        const visual = window.visualViewport;
        return { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
            width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
    };
    function cancelPress() { clearTimeout(pressTimer); touch = null; }
    function close() {
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        if (!active) return;
        if (originalDescription === null) active.removeAttribute('aria-describedby');
        else active.setAttribute('aria-describedby', originalDescription);
        if (isHelp(active) && active.dataset.helpAction !== 'follow') {
            if (originalExpanded === null) active.removeAttribute('aria-expanded');
            else active.setAttribute('aria-expanded', originalExpanded);
        }
        active = null;
        pinned = false;
        overPanel = false;
        animation?.cancel();
        anchorObserver.disconnect();
        resizeObserver?.disconnect();
        for (const parent of scrollParents) parent.removeEventListener('scroll', schedulePosition);
        scrollParents = [];
        if (positionFrame !== null) cancelAnimationFrame(positionFrame);
        positionFrame = null;
        if (topLayer && panel.matches(':popover-open')) panel.hidePopover();
        panel.hidden = true;
        body.replaceChildren();
    }
    function position() {
        positionFrame = null;
        if (!active) return;
        if (!shouldShow(active)) { close(); return; }
        const view = viewport(), bounds = active.getBoundingClientRect();
        const anchor = { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
        if (!active.isConnected || !active.getClientRects().length || active.closest('[hidden], [inert]')
            || getComputedStyle(active).visibility === 'hidden'
            || anchor.bottom <= view.top || anchor.top >= view.top + view.height
            || anchor.right <= view.left || anchor.left >= view.left + view.width) { close(); return; }
        // A scrolling column can clip a trigger even while it remains inside the window.
        for (let parent = composedParent(active); parent && parent !== document.body; parent = composedParent(parent)) {
            const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
            if (parent.hidden || parent.inert || style.visibility === 'hidden'
                || (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (anchor.bottom <= rect.top || anchor.top >= rect.bottom))
                || (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (anchor.right <= rect.left || anchor.left >= rect.right))) { close(); return; }
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
                anchor.left = Math.max(anchor.left, rect.left); anchor.right = Math.min(anchor.right, rect.right);
            }
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
                anchor.top = Math.max(anchor.top, rect.top); anchor.bottom = Math.min(anchor.bottom, rect.bottom);
            }
        }
        anchor.left = Math.max(anchor.left, view.left); anchor.right = Math.min(anchor.right, view.left + view.width);
        const limit = helpPopoverGeometry(anchor, view, 0, isHelp(active) ? 380 : 320).width;
        panel.style.width = isHelp(active) ? limit + 'px' : 'max-content';
        panel.style.maxWidth = limit + 'px';
        body.style.maxHeight = '';
        const size = panel.getBoundingClientRect();
        const geometry = helpPopoverGeometry(anchor, view, size.height, size.width);
        body.style.maxHeight = Math.max(1, geometry.maxHeight - 2) + 'px';
        panel.style.left = geometry.left + 'px';
        panel.style.top = geometry.top + 'px';
        panel.style.setProperty('--bp-tooltip-arrow-x', geometry.arrowX + 'px');
        panel.dataset.placement = geometry.placement;
        if (scrollParents.some(parent => parent.getAnimations?.().some(animation => animation.playState === 'running'))) {
            schedulePosition();
        }
    }
    function schedulePosition() {
        if (active && positionFrame === null) positionFrame = requestAnimationFrame(position);
    }
    function sourceFor(trigger) {
        const id = trigger.dataset.helpContent;
        return id && (trigger.getRootNode().getElementById?.(id) ?? document.getElementById(id));
    }
    function renderContent(trigger) {
        if (!shouldShow(trigger)) return false;
        const source = sourceFor(trigger);
        if (source) {
            body.replaceChildren(...[...source.childNodes].map(node => node.cloneNode(true)));
            body.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
        } else body.textContent = trigger.dataset.helpText ?? trigger.dataset.tooltip ?? '';
        const interactive = Boolean(body.querySelector('a[href], button, input, select, textarea'));
        panel.setAttribute('role', interactive ? 'dialog' : 'tooltip');
        if (interactive) panel.setAttribute('aria-label', trigger.getAttribute('aria-label') || 'More information');
        else panel.removeAttribute('aria-label');
        panel.dataset.kind = isHelp(trigger) ? 'help' : 'tooltip';
        body.scrollTop = 0;
        return Boolean(body.textContent.trim());
    }
    function show(trigger, pin = false) {
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        if (trigger === dismissed && !pin) return false;
        dismissed = null;
        if (active === trigger) { if (pin) pinned = true; return true; }
        if (pinned && !pin) return false;
        close();
        if (!renderContent(trigger)) return false;
        let host = document.body;
        for (let node = trigger; node && node !== document.body; node = composedParent(node)) {
            if (node.localName === 'dialog' && node.open) { host = node; break; }
        }
        if (panel.parentElement !== host) host.append(panel);
        active = trigger;
        pinned = pin;
        originalDescription = trigger.getAttribute('aria-describedby');
        originalExpanded = trigger.getAttribute('aria-expanded');
        const descriptions = (originalDescription ?? '').split(/\s+/).filter(id => id && id !== trigger.dataset.helpContent && id !== panel.id);
        trigger.setAttribute('aria-describedby', [...descriptions, panel.id].join(' '));
        if (isHelp(trigger) && trigger.dataset.helpAction !== 'follow') trigger.setAttribute('aria-expanded', 'true');
        panel.style.visibility = 'hidden';
        panel.hidden = false;
        if (topLayer) panel.showPopover();
        position();
        panel.style.visibility = '';
        if (!active) return false;
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && panel.animate) {
            animation = panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
        }
        resizeObserver?.observe(body);
        for (let parent = trigger; parent; parent = composedParent(parent)) {
            // Opening or closing a rail can move an unchanged-size trigger as
            // its ancestors resize. Follow that layout until it settles.
            resizeObserver?.observe(parent);
            parent.addEventListener('scroll', schedulePosition);
            scrollParents.push(parent);
            anchorObserver.observe(parent, { attributes: true, attributeFilter: ['hidden', 'inert', 'class', 'style', 'open'] });
            if (parent === document.body) break;
        }
        return true;
    }
    function deferClose() {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        if (!pinned) hideTimer = setTimeout(() => {
            const focus = deepFocus();
            if (active && active !== hovered && !overPanel
                && (focus !== active || !active.matches(':focus-visible')) && !panel.contains(focus)) close();
        }, 160);
    }
    function adoptTitle(node) {
        if (!(node instanceof Element) || node.matches('iframe, script, style, link')) return;
        if (node.hasAttribute('title')) {
            const text = node.getAttribute('title');
            if (!node.hasAttribute('data-tooltip') || node.dataset.tooltip === adoptedTitles.get(node)) {
                if (text) node.dataset.tooltip = text;
                else node.removeAttribute('data-tooltip');
                adoptedTitles.set(node, text);
            }
            node.removeAttribute('title');
        }
        if (node.dataset.tooltip && node.matches(focusableSelector) && !node.textContent.trim()
            && !node.hasAttribute('aria-labelledby')
            && (!node.hasAttribute('aria-label') || node.getAttribute('aria-label') === generatedNames.get(node))) {
            if (node.getAttribute('aria-label') !== node.dataset.tooltip) node.setAttribute('aria-label', node.dataset.tooltip);
            generatedNames.set(node, node.dataset.tooltip);
        }
    }
    function triggerAt(event) {
        for (const node of event.composedPath()) {
            if (!(node instanceof Element)) continue;
            if (node === panel) return null;
            adoptTitle(node);
            if (node.matches(triggerSelector)) return shouldShow(node) ? node : null;
        }
        return null;
    }
    function scan(root) {
        if (root === panel || panel.contains(root)) return;
        adoptTitle(root);
        for (const node of root.querySelectorAll?.('[title], [data-tooltip]') ?? []) adoptTitle(node);
        if (root.shadowRoot) observeRoot(root.shadowRoot);
        for (const node of root.querySelectorAll?.('*') ?? []) if (node.shadowRoot) observeRoot(node.shadowRoot);
    }
    const watcher = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') {
                if (record.attributeName === 'title' || record.attributeName === 'data-tooltip') adoptTitle(record.target);
                if (record.target === active) refresh(active);
            } else {
                if (record.type === 'childList') for (const node of record.addedNodes) if (node instanceof Element) scan(node);
                if (active?.contains(record.target)) refresh(active);
            }
        }
        if (active && !active.isConnected) close();
    });
    function observeRoot(root) {
        if (roots.has(root)) return;
        roots.add(root);
        scan(root);
        watcher.observe(root, { childList: true, characterData: true, subtree: true, attributes: true,
            attributeFilter: ['title', 'data-tooltip', 'data-help-text', 'data-help-content'] });
    }
    function refresh(trigger) {
        if (active !== trigger) return;
        if (!renderContent(trigger)) close();
        else schedulePosition();
    }
    observeRoot(document.documentElement);
    document.addEventListener('pointerover', event => {
        if (event.pointerType === 'touch') return;
        if (inPath(event, panel)) { overPanel = true; clearTimeout(hideTimer); return; }
        const trigger = triggerAt(event);
        if (!trigger) return;
        hovered = trigger;
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        if (active === trigger) return;
        showTimer = setTimeout(() => { if (hovered === trigger) show(trigger); }, 240);
    });
    document.addEventListener('pointerout', event => {
        if (event.pointerType === 'touch') return;
        if (inPath(event, panel) && !panel.contains(event.relatedTarget)) { overPanel = false; deferClose(); }
        const trigger = triggerAt(event);
        if (trigger && !trigger.contains(event.relatedTarget)) {
            if (hovered === trigger) hovered = null;
            if (dismissed === trigger) dismissed = null;
            deferClose();
        }
    });
    document.addEventListener('focusin', event => {
        const trigger = triggerAt(event);
        // Mouse-driven focus restoration (for example, after closing a panel)
        // should not create a tooltip at an anchor the pointer never reached.
        if (trigger && pointerType !== 'touch' && trigger.matches(':focus-visible')) {
            if (active && active !== trigger) close();
            show(trigger);
        } else if (!trigger && active && !inPath(event, panel)) close();
    });
    document.addEventListener('focusout', event => {
        if (dismissed && inPath(event, dismissed)) dismissed = null;
        deferClose();
    });
    document.addEventListener('pointerdown', event => {
        pointerType = event.pointerType;
        if (active && !inPath(event, active) && !inPath(event, panel)) close();
        cancelPress();
        consumedPress = null;
        handledTap = null;
        if (event.pointerType !== 'touch' || !event.isPrimary) return;
        const trigger = triggerAt(event);
        if (!trigger || nestedAction(event, trigger)) return;
        touch = { trigger, id: event.pointerId, x: event.clientX, y: event.clientY };
        pressTimer = setTimeout(() => {
            if (!touch) return;
            if (show(trigger, true)) consumedPress = { trigger, until: Date.now() + 1800 };
        }, 500);
    }, true);
    document.addEventListener('pointermove', event => {
        if (touch && (event.pointerId !== touch.id || Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10)) cancelPress();
    }, { passive: true });
    document.addEventListener('pointerup', event => {
        const press = touch;
        cancelPress();
        // Mobile WebKit does not always synthesize clicks on plain text or SVG.
        // Passive information uses pointerup; actual actions keep their native click.
        if (!press || event.pointerId !== press.id || !tapShowsHelp(press.trigger, event)
            || (consumedPress?.trigger === press.trigger && Date.now() < consumedPress.until)
            || triggerAt(event) !== press.trigger) return;
        if (active === press.trigger && pinned) close();
        else show(press.trigger, true);
        handledTap = { trigger: press.trigger, until: Date.now() + 1800 };
        if (isHelp(press.trigger)) press.trigger.focus({ preventScroll: true });
    }, true);
    document.addEventListener('pointercancel', () => cancelPress(), true);
    document.addEventListener('contextmenu', event => {
        if (consumedPress && Date.now() < consumedPress.until && inPath(event, consumedPress.trigger)) event.preventDefault();
    });
    document.addEventListener('click', event => {
        if (consumedPress && Date.now() < consumedPress.until && inPath(event, consumedPress.trigger)) {
            event.preventDefault(); event.stopImmediatePropagation(); consumedPress = null; return;
        }
        const trigger = triggerAt(event);
        if (!trigger) return;
        if (trigger.dataset.helpAction === 'follow' || nestedAction(event, trigger)) { close(); return; }
        if (handledTap?.trigger === trigger && Date.now() < handledTap.until) {
            if (isHelp(trigger)) event.preventDefault();
            handledTap = null;
            return;
        }
        if (isHelp(trigger)) {
            event.preventDefault();
            if (active === trigger && pinned) close();
            else { show(trigger, true); trigger.focus({ preventScroll: true }); }
        } else if (!(pointerType === 'touch' && !trigger.closest(actionSelector))) close();
    }, true);
    // Escape closes only this layer, before any underlying dialog handles the key.
    window.addEventListener('keydown', event => {
        pointerType = '';
        cancelPress();
        handledTap = null;
        if (event.key === 'Escape' && active) {
            event.preventDefault(); event.stopPropagation();
            const trigger = active, returnFocus = panel.contains(deepFocus());
            dismissed = trigger;
            close();
            if (returnFocus) trigger.focus({ preventScroll: true });
            return;
        }
        if (!active) return;
        if (event.key === 'Tab' && pinned) {
            const links = [...body.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
            const focus = deepFocus();
            if (links.length && ((!event.shiftKey && focus === active) || (event.shiftKey && focus === links[0]))) {
                event.preventDefault(); event.stopPropagation();
                (focus === active ? links[0] : active).focus();
            } else if (panel.contains(focus) && focus === links.at(-1) && !event.shiftKey) {
                const trigger = active;
                close(); trigger.focus({ preventScroll: true });
            }
        } else if (inPath(event, active) && body.scrollHeight > body.clientHeight) {
            const amount = { ArrowDown: 32, ArrowUp: -32, PageDown: body.clientHeight * .8, PageUp: -body.clientHeight * .8 }[event.key];
            if (amount && isHelp(active)) { event.preventDefault(); body.scrollTop += amount; }
        }
    }, true);
    document.addEventListener('scroll', () => { cancelPress(); schedulePosition(); }, true);
    for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) document.addEventListener(type, event => {
        if (active && scrollParents.includes(event.target)) schedulePosition();
    }, true);
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('blur', () => { cancelPress(); close(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelPress(); close(); } });
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
    document.fonts?.addEventListener('loadingdone', schedulePosition);
    return { refresh, observeRoot };
}

const controller = typeof document === 'undefined' ? null : (globalThis[singleton] ??= createHelpController());

export function refreshHelpPopover(trigger) { controller?.refresh(trigger); }
export function observeTooltipRoot(root) { controller?.observeRoot(root); }

export function setHelpText(trigger, text) {
    trigger.dataset.helpText = text;
    trigger.classList.add('bp-help-trigger');
    trigger.removeAttribute('title');
    refreshHelpPopover(trigger);
}
