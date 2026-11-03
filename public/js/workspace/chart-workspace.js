import { setLoading } from '../shared/loading.js';
import { createBenchmarkInformationLink } from './benchmark-link.js';
import { benchmarkAccessibleName } from './weights.js';
import { animateContent } from '../shared/motion.js?v=workspace-ui-20261008';
import { mountBarEndpointLabel } from '../shared/bar-label.js';
import { createAction } from '../shared/ui-components.js';
import { rankingNumber } from '../shared/ranking-number.js';

export function sortedWeightEntries(entries) {
    return [...entries].sort((a, b) => Number(b.weightBasisPoints) - Number(a.weightBasisPoints)
        || Number(Boolean(b.isPrimaryCondition)) - Number(Boolean(a.isPrimaryCondition))
        || Number(b.scoredModelCount ?? 0) - Number(a.scoredModelCount ?? 0)
        || Number(a.conditionID) - Number(b.conditionID));
}

export function chartWeightMode(state) {
    if (state.contextIsPrivate) return 'personal';
    return state.workspaceDisplay === 'charts' && !state.personalEntries.length ? 'public' : state.mode;
}

export function createChartWorkspace({ state, getEntries, benchmarkCard, getMemberURL, onInspectVersion }) {
    const workspace = document.querySelector('.bp-workspace');
    const panel = document.getElementById('weight-bars-panel');
    const bars = document.getElementById('weight-bars');
    const title = document.getElementById('weight-bars-title');
    const nodes = new Map();
    let renderedScope = '';
    let visibleCount = 10;
    const more = createAction({ label: 'Show more benchmarks', icon: 'fa-solid fa-chevron-down', variant: 'quiet', className: 'bp-weight-bars-more' });
    more.setAttribute('aria-controls', 'weight-bars');
    more.addEventListener('click', () => {
        const top = bars.scrollTop;
        const firstNew = visibleCount;
        const focused = document.activeElement === more;
        visibleCount += 10;
        render();
        bars.scrollTop = top;
        if (focused) {
            if (more.hidden) bars.querySelectorAll('.bp-weight-bar-row')[firstNew]?.querySelector('a')?.focus({ preventScroll: true });
            else more.focus({ preventScroll: true });
        }
    });

    function makeRow(entry) {
        const ID = Number(entry.conditionID);
        const row = document.createElement('div'); row.className = 'bp-weight-bar-row'; row.dataset.conditionId = ID;
        row.setAttribute('role', 'group'); row.setAttribute('aria-label', benchmarkAccessibleName(entry));
        const header = document.createElement('div'); header.className = 'bp-weight-bar-heading';
        const member = { ...entry, ID };
        const name = createBenchmarkInformationLink(member, { getURL: getMemberURL, onInspect: onInspectVersion });
        const value = document.createElement('strong'); value.className = 'bp-weight-bar-value';
        header.append(name);
        const track = document.createElement('div'); track.className = 'bp-weight-bar-track';
        const fill = document.createElement('span'); fill.className = 'bp-weight-bar-fill'; track.append(fill);
        row.append(header, track);
        return { row, value, fill };
    }

    function render() {
        const charts = state.workspaceDisplay === 'charts';
        workspace.dataset.display = state.workspaceDisplay;
        panel.hidden = !charts;
        benchmarkCard.hidden = charts;
        if (!charts) return;
        const scope = JSON.stringify([state.categoryID, state.selectedContextValues, state.mode]);
        if (scope !== renderedScope) {
            nodes.clear(); bars.replaceChildren(); renderedScope = scope; visibleCount = 10;
        }
        title.textContent = state.personalEntries.length && !state.contextIsPrivate ? 'Benchmark weights'
            : state.mode === 'personal' ? 'Personal Weights' : 'Public Weights';
        const entries = sortedWeightEntries(getEntries());
        bars.setAttribute('aria-label', `${state.mode === 'personal' ? 'Personal' : 'Public'} benchmark weights, highest first`);
        bars.setAttribute('aria-busy', String(state.loading));
        if (!entries.length) {
            nodes.clear(); bars.replaceChildren();
            const empty = document.createElement('p'); empty.className = 'bp-chart-empty';
            if (state.loading) setLoading(empty, 'Loading weights');
            else empty.textContent = state.mode === 'personal'
                ? 'No personal weights for this task yet.' : 'No public weights for this task yet.';
            bars.append(empty); return;
        }
        const visible = entries.slice(0, visibleCount);
        const desired = new Set(visible.map(entry => Number(entry.conditionID)));
        for (const [ID, node] of nodes) if (!desired.has(ID)) { node.row.remove(); nodes.delete(ID); }
        bars.querySelector('.bp-chart-empty')?.remove();
        const maximum = Math.max(1, ...entries.map(entry => Number(entry.weightBasisPoints)));
        const previous = new Map([...nodes].map(([ID, node]) => [ID, node.row.getBoundingClientRect().top]));
        visible.forEach((entry, index) => {
            const ID = Number(entry.conditionID);
            const node = nodes.get(ID) ?? makeRow(entry); nodes.set(ID, node);
            const { row, value, fill } = node;
            row.dataset.order = String(index + 1);
            row.style.setProperty('--weight-width', `${Number(entry.weightBasisPoints) / maximum * 100}%`);
            fill.dataset.tooltip = `${rankingNumber(entry.weightBasisPoints / 100)}%`;
            value.textContent = fill.dataset.tooltip;
            mountBarEndpointLabel(fill.parentElement, value, Number(entry.weightBasisPoints) / maximum * 100);
            if (bars.children[index] !== row) bars.insertBefore(row, bars.children[index] ?? null);
            const dy = (previous.get(ID) ?? row.getBoundingClientRect().top) - row.getBoundingClientRect().top;
            if (Math.abs(dy) > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 240, easing: 'ease-out' });
            }
        });
        more.hidden = visible.length >= entries.length;
        bars.append(more);
    }
    function animate() { animateContent(panel, { translate: false }); }
    function renderError(message) {
        render();
        if (state.workspaceDisplay === 'charts' && !getEntries().length) {
            const empty = bars.querySelector('.bp-chart-empty');
            if (empty) { empty.textContent = message; empty.setAttribute('role', 'alert'); }
        }
    }
    return { render, renderError, animate };
}
