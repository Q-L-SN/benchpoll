export function createBenchmarkRowFocus() {
    function captureFocus(container) {
        const active = document.activeElement;
        if (!active || !container.contains(active)) return null;
        const row = active.closest('.bp-benchmark-row');
        const control = active.dataset.benchmarkControl;
        return row && control ? { conditionID: row.dataset.conditionId, control } : null;
    }
    function restoreFocus(container, snapshot) {
        if (!snapshot) return true;
        const row = [...container.querySelectorAll('.bp-benchmark-row')]
            .find(node => node.dataset.conditionId === snapshot.conditionID);
        const target = snapshot.control === 'selection' ? row
            : snapshot.control === 'add' ? row?.querySelector('[data-benchmark-control="add"], [data-benchmark-control="remove"]')
                ?? row?.querySelector('[data-benchmark-control="information"]')
            : [...row?.querySelectorAll('[data-benchmark-control]') ?? []]
                .find(node => node.dataset.benchmarkControl === snapshot.control);
        if (!target || !target.getClientRects().length || target.closest('[hidden], [inert]') || target.disabled) return false;
        target.focus({ preventScroll: true }); return true;
    }
    return { captureFocus, restoreFocus };
}
