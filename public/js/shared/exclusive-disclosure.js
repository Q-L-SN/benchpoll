// Disclosure triggers keep their packaged chevron and accessibility semantics;
// this controller owns the exactly-one-open behavior used by two-step choosers.
export function createExclusiveDisclosure({ items, initial, canOpen = () => true, onChange = () => {} }) {
    let active = initial;
    function render() {
        for (const item of items) {
            const open = item.key === active;
            item.panel.inert = !open;
            item.panel.setAttribute('aria-hidden', String(!open));
            item.trigger.setAttribute('aria-expanded', String(open));
            item.section.dataset.open = String(open);
        }
    }
    function open(key) {
        if (!items.some(item => item.key === key) || !canOpen(key)) return false;
        if (active === key) return true;
        active = key; render(); onChange(key); return true;
    }
    const listeners = items.map(item => {
        const listener = () => open(item.key);
        item.trigger.addEventListener('click', listener);
        return [item.trigger, listener];
    });
    render();
    return { open, current: () => active,
        reset() { active = initial; render(); },
        destroy() { for (const [trigger, listener] of listeners) trigger.removeEventListener('click', listener); }
    };
}
