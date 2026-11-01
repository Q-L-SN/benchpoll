import { SVG_NS, PIE_GRADIENTS } from './constants.js';
import { describeArc, polarToCartesian, splitPieLabel } from './weights.js';

const percent = basisPoints => `${Number((basisPoints / 100).toFixed(1))}%`;
const pieCount = count => `${count.toLocaleString('en-US')} ${count === 1 ? 'pie' : 'pies'}`;

function svgElement(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
}

export function createPublicComposition({ svg, list }) {
    let selectedCategoryID = null;
    function select(categoryID) {
        selectedCategoryID = categoryID;
        svg.querySelectorAll('[data-category-id]').forEach(group => {
            const selected = Number(group.dataset.categoryId) === categoryID;
            group.setAttribute('aria-pressed', String(selected));
            group.querySelector('path').classList.toggle('selected', selected);
        });
        list.querySelectorAll('button').forEach(button => {
            button.setAttribute('aria-pressed', String(Number(button.dataset.categoryId) === categoryID));
        });
    }
    return function render(composition, currentCategoryID) {
        svg.replaceChildren();
        list.replaceChildren();
        const defs = svgElement('defs');
        svg.append(defs);
        const total = composition.reduce((sum, source) => sum + source.pieCount, 0);
        if (!total) {
            const empty = svgElement('text', { x: 180, y: 180, class: 'bp-pie-empty' });
            empty.textContent = 'No public weights yet';
            svg.append(empty);
        }
        if (!composition.some(source => source.categoryID === selectedCategoryID)) selectedCategoryID = null;
        let angle = 7;
        composition.forEach((source, index) => {
            const current = source.categoryID === currentCategoryID;
            const label = `${source.name}${current ? ' (this category)' : ' (including subcategories)'}`;
            const description = `${label}: ${percent(source.weightBasisPoints)}, ${pieCount(source.pieCount)}`;
            const colorIndex = index % PIE_GRADIENTS.length;
            const colors = PIE_GRADIENTS[colorIndex];
            const color = `var(--bp-chart-${colorIndex}-end, ${colors[1]})`;
            if (source.pieCount > 0) {
                const end = angle + source.weightBasisPoints / 10000 * 360;
                const gradientID = `bp-composition-gradient-${source.categoryID}`;
                const gradient = svgElement('linearGradient', { id: gradientID, x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
                colors.forEach((fallback, stop) => gradient.append(svgElement('stop', {
                    offset: `${stop * 100}%`, 'stop-color': `var(--bp-chart-${colorIndex}-${stop ? 'end' : 'start'}, ${fallback})`
                })));
                defs.append(gradient);
                const group = svgElement('g', { 'data-category-id': source.categoryID, tabindex: 0, role: 'button', 'aria-label': description });
                const title = svgElement('title');
                title.textContent = description;
                const lift = svgElement('g', { class: 'bp-pie-slice-lift' });
                lift.append(svgElement('path', { class: 'bp-pie-slice', d: describeArc(180, 180, 160, angle, end), fill: `url(#${gradientID})` }));
                if (source.weightBasisPoints >= 700) {
                    const point = polarToCartesian(180, 180, 160 * (source.weightBasisPoints >= 2400 ? 0.57 : 0.7), (angle + end) / 2);
                    const lines = splitPieLabel(source.name).slice(0, 2);
                    const text = svgElement('text', { class: 'bp-pie-label', x: point.x, y: point.y - lines.length * 8 });
                    [...lines, percent(source.weightBasisPoints)].forEach((line, lineIndex) => {
                        const span = svgElement('tspan', { x: point.x, dy: lineIndex ? 18 : 0 });
                        span.textContent = line.length > 18 ? `${line.slice(0, 16)}...` : line;
                        text.append(span);
                    });
                    lift.append(text);
                }
                group.append(title, lift);
                group.addEventListener('click', () => select(source.categoryID));
                group.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(source.categoryID); }
                });
                svg.append(group);
                angle = end;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.categoryId = source.categoryID;
            button.setAttribute('aria-label', description);
            const swatch = document.createElement('span');
            swatch.className = 'bp-composition-swatch';
            swatch.style.background = color;
            const name = document.createElement('span');
            name.className = 'bp-composition-name';
            name.textContent = source.name;
            const count = document.createElement('small');
            count.textContent = `${current ? 'This category' : 'Including subcategories'}, ${pieCount(source.pieCount)}`;
            name.append(count);
            const share = document.createElement('strong');
            share.textContent = percent(source.weightBasisPoints);
            button.append(swatch, name, share);
            button.addEventListener('click', () => select(source.categoryID));
            list.append(button);
        });
        select(selectedCategoryID);
    };
}
