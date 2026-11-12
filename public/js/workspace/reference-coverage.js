import { setLoading } from '../shared/loading.js';
export function createReferenceCoverage({ request, getScope }) {
    const cache = new Map(), waiting = new Map(), queue = [];
    let scope = getScope(), active = 0, generation = 0;
    const controllers = new Set();
    const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    const targetMode = target => target.isPrivate === true || target.configured === true ? 'personal' : 'public';
    const targetKey = target => `${target.referenceContextID ?? target.contextID}:${targetMode(target)}`;
    function paint(metric, result) {
        metric.querySelector('[data-coverage-value]').textContent = result.error ? '—' : number.format(Math.floor(result.value));
        metric.dataset.coverageState = result.error ? 'error' : 'loaded';
        metric.dataset.tooltip = result.error ? 'Total coverage is unavailable. Select to retry.'
            : `Total coverage index: ${number.format(Math.floor(result.value))}. Sum of all model coverage in this ${metric.dataset.private === 'true' ? 'personal' : 'public'} index; 100% coverage counts as 1.`;
        metric.setAttribute('aria-label', metric.dataset.tooltip);
        metric.setAttribute('role', result.error ? 'button' : 'img');
    }
    function pump() {
        while (active < 2 && queue.length) {
            const { key, target, token } = queue.shift(), controller = new globalThis.AbortController();
            active++; controllers.add(controller);
            request({ categoryID: target.categoryID, ...(target.sceneID == null ? {} : { sceneID: target.sceneID }),
                mode: targetMode(target),
                scoreMode: 'range', reasoning: false, harness: false }, { signal: controller.signal })
                .then(payload => {
                    if (!Number.isFinite(payload.totalCoverageIndex) || payload.totalCoverageIndex < 0) throw new Error('Invalid coverage index');
                    return { value: payload.totalCoverageIndex, time: Date.now() };
                }).catch(() => ({ error: true, time: Date.now() }))
                .then(result => {
                    if (token !== generation) return;
                    cache.set(key, result);
                    for (const metric of waiting.get(key) ?? []) if (metric.isConnected) paint(metric, result);
                    waiting.delete(key);
                }).finally(() => { active--; controllers.delete(controller); pump(); });
        }
    }
    function load(metric, target) {
        const key = targetKey(target);
        const saved = cache.get(key);
        if (saved && Date.now() - saved.time < 60000) { paint(metric, saved); return; }
        if (!waiting.has(key)) {
            waiting.set(key, new Set()); queue.push({ key, target, token: generation });
        }
        waiting.get(key).add(metric); pump();
    }
    const observer = new globalThis.IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
            observer.unobserve(entry.target); load(entry.target, entry.target.coverageTarget);
        }
    }, { rootMargin: '100px' });
    return {
        begin() {
            observer.disconnect();
            if (scope === getScope()) return;
            scope = getScope(); generation++;
            controllers.forEach(controller => controller.abort());
            cache.clear(); waiting.clear(); queue.length = 0;
        },
        create(target) {
            const metric = document.createElement('span');
            metric.className = 'bp-evidence-count bp-benchmark-score-count';
            metric.tabIndex = 0; metric.setAttribute('role', 'img');
            metric.dataset.coverageState = 'loading'; metric.dataset.private = String(target.isPrivate === true || target.configured === true);
            metric.innerHTML = '<i class="fa-solid fa-chart-pie" aria-hidden="true"></i><span class="bp-evidence-count-value" data-coverage-value aria-hidden="true"></span>';
            setLoading(metric.querySelector('[data-coverage-value]'), 'Loading total coverage index');
            metric.setAttribute('aria-label', 'Loading total coverage index'); metric.coverageTarget = target;
            const retry = event => {
                if (metric.dataset.coverageState !== 'error') return;
                event.stopPropagation(); event.preventDefault();
                cache.delete(targetKey(target));
                metric.dataset.coverageState = 'loading';
                setLoading(metric.querySelector('[data-coverage-value]'), 'Loading total coverage index');
                metric.setAttribute('aria-label', 'Loading total coverage index');
                load(metric, target);
            };
            metric.addEventListener('click', retry);
            metric.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') retry(event); });
            if (Number.isFinite(target.coverageIndex) && target.coverageIndex >= 0) paint(metric, { value: target.coverageIndex });
            else observer.observe(metric);
            return metric;
        }
    };
}
