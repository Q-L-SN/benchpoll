import { createOrganizationMark } from '../shared/organization-logos.js?v=organization-logos-20261006';
import { renderComparisonName } from '../shared/comparison-display.js?v=launch-layout-20261007';
import { rankingRowKey } from './ranking-motion.js';
import { modelBarColor, modelBarTextColor } from './score-colors.js';
import { rankingNumber } from '../shared/ranking-number.js';
export { modelBarColor, modelBarTextColor };

export function columnGeometry(model, scale) {
    const position = value => Math.max(0, Math.min(100, scale.position(value)));
    const base = position(scale.barStart);
    const score = position(model.lower);
    return {
        known: { bottom: Math.min(base, score), height: Math.abs(score - base) },
        zero: position(0)
    };
}

export function modelChartTicks(scale) {
    const step = scale.max / 4 - scale.min / 4;
    if (scale.min < 0 && scale.max > 0) {
        const power = 10 ** Math.floor(Math.log10(step));
        const nice = [1, 2, 2.5, 5, 10].map(value => value * power).sort((a, b) => Math.abs(a - step) - Math.abs(b - step))[0];
        const ticks = [];
        for (let value = Math.ceil(scale.min / nice) * nice; value <= scale.max; value += nice) ticks.push(value === 0 ? 0 : value);
        return ticks;
    }
    return Array.from({ length: 5 }, (_, index) => scale.min * (1 - index / 4) + scale.max * (index / 4));
}

export function modelChartNeedsMore(container) {
    const chart = container.querySelector('.bp-model-chart-scroll');
    if (!chart?.clientWidth) return false;
    const maximum = chart.scrollWidth - chart.clientWidth;
    const threshold = Math.min(140, chart.clientWidth * .15, maximum * .2);
    return maximum > 1 && chart.scrollLeft >= maximum - threshold;
}

export function captureModelColumns(container) {
    return new Map([...container.querySelectorAll('.bp-model-column')].map(column => {
        const { style } = column.querySelector('.bp-column-known');
        return [column.dataset.modelKey, { left: column.getBoundingClientRect().left,
            bar: { bottom: style.bottom, height: style.height } }];
    }));
}

export function animateModelColumns(container, previous) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const column of container.querySelectorAll('.bp-model-column')) {
        const old = previous.get(column.dataset.modelKey);
        const options = { duration: 600, easing: 'cubic-bezier(.22, 1, .36, 1)' };
        if (!old) { column.animate([{ opacity: .3 }, { opacity: 1 }], options); continue; }
        const dx = old.left - column.getBoundingClientRect().left;
        if (Math.abs(dx) > 1) column.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], options);
        const bar = column.querySelector('.bp-column-known');
        bar.animate([old.bar, { bottom: bar.style.bottom, height: bar.style.height }], options);
    }
}

export function renderModelBarChart({ container, models, state, scale, showVendorMarks, onActivate, onNeedMore, hasMore, initialScrollLeft = 0, reuse = false }) {
    const figure = reuse ? container.querySelector('.bp-model-bar-chart') : document.createElement('div'); figure.className = 'bp-model-bar-chart';
    figure.setAttribute('role', 'group'); figure.setAttribute('aria-label', 'Model scores, highest ranked first');
    const axis = document.createElement('div'); axis.className = 'bp-model-chart-axis'; axis.setAttribute('aria-hidden', 'true');
    const ticks = modelChartTicks(scale);
    for (const value of reuse ? [] : ticks) {
        const tick = document.createElement('span');
        const position = scale.position(value);
        tick.style.bottom = `${position}%`;
        if (position >= 99.999) tick.dataset.edge = 'top';
        else if (position <= .001) tick.dataset.edge = 'bottom';
        tick.textContent = rankingNumber(value); axis.append(tick);
    }
    const scroll = reuse ? figure.querySelector('.bp-model-chart-scroll') : document.createElement('div'); scroll.className = 'bp-model-chart-scroll';
    scroll.tabIndex = 0; scroll.setAttribute('aria-label', 'Scroll to see more models');
    const columns = reuse ? scroll.querySelector('.bp-model-chart-columns') : document.createElement('div'); columns.className = 'bp-model-chart-columns';
    columns.style.minWidth = hasMore ? 'calc(100% + 56px)' : '';
    const grid = document.createElement('div'); grid.className = 'bp-model-chart-grid'; grid.setAttribute('aria-hidden', 'true');
    for (const value of reuse ? [] : ticks) {
        const line = document.createElement('span'); line.style.bottom = `${scale.position(value)}%`; grid.append(line);
    }
    if (!reuse) columns.append(grid);
    const existing = new Map([...columns.querySelectorAll('[data-model-key]')].map(node => [node.dataset.modelKey, node]));
    let previousColumn = null;
    models.forEach(model => {
        const key = rankingRowKey(model);
        if (existing.has(key)) { previousColumn = existing.get(key); return; }
        const comparable = model.comparable !== false;
        const column = document.createElement('div'); column.className = 'bp-model-column';
        column.dataset.modelKey = rankingRowKey(model); column.dataset.rank = model.rank;
        column.tabIndex = 0; column.setAttribute('role', 'button');
        column.setAttribute('aria-label', `View approved scores for ${model.name}`);
        column.classList.toggle('is-incomparable', !comparable);
        const color = modelBarColor(model);
        column.style.setProperty('--model-column-color', color);
        column.style.setProperty('--model-score-color', '#ffffff');
        const plot = document.createElement('div'); plot.className = 'bp-model-column-plot';
        const geometry = columnGeometry(model, scale);
        const value = document.createElement('strong'); value.className = 'bp-model-column-value';
        value.textContent = comparable ? rankingNumber(model.lower) : '-';
        value.style.setProperty('--model-score-characters', value.textContent.length);
        const bar = document.createElement('span'); bar.className = 'bp-column-known';
        bar.style.bottom = `${comparable ? geometry.known.bottom : 0}%`;
        bar.style.height = `${comparable ? geometry.known.height : 0}%`;
        bar.classList.toggle('is-empty', !comparable || geometry.known.height === 0);
        bar.append(value); plot.append(bar);
        if (scale.min < 0) {
            const zero = document.createElement('span'); zero.className = 'bp-column-zero';
            zero.style.bottom = `${geometry.zero}%`; plot.append(zero);
        }
        const identity = document.createElement('div'); identity.className = 'bp-model-column-identity';
        if (showVendorMarks) identity.append(createOrganizationMark(model, 'bp-vendor-mark'));
        const name = document.createElement('span'); name.className = 'bp-model-column-name';
        renderComparisonName(name, model, state.comparison ?? state.comparisonRequest); identity.append(name);
        const activate = event => {
            if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
            event.preventDefault(); void onActivate(model);
        };
        column.addEventListener('click', activate); column.addEventListener('keydown', activate);
        column.append(plot, identity);
        columns.insertBefore(column, previousColumn ? previousColumn.nextSibling : columns.querySelector('.bp-model-column'));
        previousColumn = column;
    });
    if (reuse) return scroll;
    scroll.append(columns); figure.append(axis, scroll); container.append(figure);
    scroll.scrollLeft = initialScrollLeft;
    let previousOffset = scroll.scrollLeft;
    scroll.addEventListener('scroll', () => {
        const advanced = scroll.scrollLeft > previousOffset + .5;
        previousOffset = scroll.scrollLeft;
        if (advanced && modelChartNeedsMore(container)) onNeedMore();
    }, { passive: true });
    return scroll;
}
