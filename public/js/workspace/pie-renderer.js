import { SVG_NS, PIE_WEIGHT_TRANSITION_MS, PIE_GRADIENTS } from './constants.js';
import { benchmarkConditionLabel, benchmarkAccessibleName, clamp } from './weights.js';
import { createPieLabelLayout, pieLabelContentBox } from './pie-label-layout.js?v=weight-treemap-20261031';
import { createWeightTreemapLayout, treemapHoverTransform } from './weight-treemap-layout.js';
import '../shared/help-popover.js';
import { isTopicReference, topicLabelText, topicLabelParts, renderTopicLabel, TOPIC_ICON_FONT } from '../shared/topic-label.js';

export function createPieRenderer({ state, pieSvg, pieHoverTooltip, orderedPieEntries, currentPieEntries, selectedObjectIndex, renderInlineFallback, fallbackRuleFor, publicFallbackRuleFor, onSelect }) {
    const measure = document.createElement('canvas').getContext('2d');
    const labelMetrics = new Map();
    const labelLayout = createPieLabelLayout(metricsOf);
    const tileLayout = createWeightTreemapLayout();
    const prefix = `bp-weight-${window.crypto.randomUUID()}`;
    const nodes = new Map();
    let visualTiles = new Map(), hoveredID = null, disposed = false;
    let width = 360, height = 270, lastSize = '', lastScope = '';
    pieSvg.replaceChildren();
    pieSvg.dataset.chart = 'treemap';
    pieSvg.setAttribute('role', 'group');
    if (pieHoverTooltip) pieHoverTooltip.hidden = true;
    const defs = element('defs');
    pieSvg.append(defs);

    function element(tag, attributes = {}) {
        const node = document.createElementNS(SVG_NS, tag);
        attributesOf(node, attributes);
        return node;
    }
    function attributesOf(node, attributes) {
        Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    }
    function metricsOf(text, size, weight, fontFamily) {
        const font = `${weight} ${size}px ${fontFamily}`, key = `${font}:${text}`;
        if (!labelMetrics.has(key)) {
            const width = topicLabelParts(text).reduce((sum, part) => {
                measure.font = part.icon ? `900 ${size}px ${TOPIC_ICON_FONT}` : font;
                const metrics = measure.measureText(part.text);
                return sum + Math.max(metrics.width, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight);
            }, 0);
            labelMetrics.set(key, { width });
        }
        return labelMetrics.get(key);
    }
    function raiseActive() {
        const active = nodes.get(hoveredID) ?? nodes.get(Number(state.selectedObjectID));
        if (active && pieSvg.lastElementChild !== active.group) {
            // Moving a focused SVG group with append() drops keyboard focus in some engines.
            const focused = document.activeElement === active.group;
            pieSvg.append(active.group);
            if (focused) active.group.focus({ preventScroll: true });
        }
    }
    function makeTile(id) {
        const group = element('g', { role: 'button', tabindex: 0, 'data-object-id': id });
        const lift = element('g', { class: 'bp-weight-tile-lift' });
        const rect = element('rect', { class: 'bp-weight-tile', 'vector-effect': 'non-scaling-stroke' });
        const clip = element('clipPath', { id: `${prefix}-${id}-clip`, clipPathUnits: 'userSpaceOnUse' });
        const clipRect = element('rect');
        clip.append(clipRect);
        const gradient = element('linearGradient', { id: `${prefix}-${id}-fade`, gradientUnits: 'userSpaceOnUse' });
        gradient.append(element('stop', { offset: 0, 'stop-color': 'white' }),
            element('stop', { offset: 1, 'stop-color': 'white', 'stop-opacity': 0 }));
        const mask = element('mask', { id: `${prefix}-${id}-mask`, maskUnits: 'userSpaceOnUse' });
        const maskRect = element('rect', { fill: `url(#${gradient.id})` });
        mask.append(maskRect);
        defs.append(clip, gradient, mask);
        const labels = element('g', { class: 'bp-weight-tile-labels', 'clip-path': `url(#${clip.id})`, 'aria-hidden': true });
        lift.append(rect, labels);
        group.append(lift);
        group.addEventListener('mousedown', event => event.preventDefault());
        group.addEventListener('click', () => void onSelect(id));
        group.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void onSelect(id);
            }
        });
        group.addEventListener('pointerenter', event => {
            if (event.pointerType !== 'touch') { hoveredID = id; raiseActive(); }
        });
        group.addEventListener('pointerleave', () => { hoveredID = null; raiseActive(); });
        group.addEventListener('focus', () => raiseActive());
        pieSvg.append(group);
        const node = { group, lift, rect, clip, clipRect, gradient, mask, maskRect, labels, signature: '' };
        nodes.set(id, node);
        return node;
    }

    function draw(tiles) {
        const desired = new Set(tiles.map(tile => Number(tile.conditionID)));
        for (const [id, node] of nodes) if (!desired.has(id)) {
            for (const key of ['group', 'clip', 'gradient', 'mask']) node[key].remove();
            nodes.delete(id);
            if (hoveredID === id) hoveredID = null;
        }
        pieSvg.querySelector('.bp-pie-empty')?.remove();
        if (!tiles.length) {
            const empty = element('text', { x: width / 2, y: height / 2, class: 'bp-pie-empty' });
            empty.textContent = state.mode === 'personal' ? 'Add a benchmark or topic from Evaluation items' : 'No public weights yet';
            pieSvg.append(empty);
        }
        const fontFamily = getComputedStyle(pieSvg).fontFamily;
        tiles.forEach((tile, index) => {
            const id = Number(tile.conditionID), node = nodes.get(id) ?? makeTile(id);
            const selected = Number(state.selectedObjectID) === id;
            const colorIndex = (state.pieOrderByObjectID.get(id) ?? index) % PIE_GRADIENTS.length;
            const fallback = state.mode === 'personal' ? fallbackRuleFor(id) : publicFallbackRuleFor(id);
            const hasFallback = Boolean(fallback?.entries?.length || fallback?.families?.some(
                family => family.weightBasisPoints > 0 && family.entries?.length));
            const percent = Number(tile.weightBasisPoints) / state.limits.totalBasisPoints * 100;
            const description = `${benchmarkAccessibleName(tile)}: ${percent.toFixed(2)}%${hasFallback ? '. Fallback enabled' : ''}`;
            attributesOf(node.group, { 'aria-label': description, 'aria-pressed': selected });
            node.group.dataset.weight = String(tile.weightBasisPoints);
            attributesOf(node.rect, { x: tile.x, y: tile.y, width: Math.max(0, tile.width), height: Math.max(0, tile.height),
                fill: `var(--bp-chart-${colorIndex}-start, ${PIE_GRADIENTS[colorIndex][0]})` });
            node.rect.classList.toggle('selected', selected);
            node.lift.style.transformOrigin = `${tile.x + tile.width / 2}px ${tile.y + tile.height / 2}px`;
            const hover = treemapHoverTransform(tile, width, height);
            node.lift.style.setProperty('--bp-tile-hover-scale', hover.scale);
            node.lift.style.setProperty('--bp-tile-hover-x', `${hover.x}px`);
            node.lift.style.setProperty('--bp-tile-hover-y', `${hover.y}px`);
            const contentBox = pieLabelContentBox(tile.width, tile.height);
            const inner = { ...contentBox, x: tile.x + contentBox.x, y: tile.y + contentBox.y };
            attributesOf(node.clipRect, inner);
            attributesOf(node.mask, inner);
            attributesOf(node.maskRect, inner);
            attributesOf(node.gradient, { x1: inner.x + inner.width - Math.min(14, inner.width / 3),
                x2: inner.x + inner.width, y1: 0, y2: 0 });
            const topic = isTopicReference(tile);
            const label = labelLayout.layout({ name: topic ? topicLabelText(tile) : tile.name, topic,
                version: topic ? '' : benchmarkConditionLabel(tile),
                percent: `${Math.round(percent)}%`, width: tile.width, height: tile.height, fontFamily });
            node.group.dataset.labelMode = label.mode;
            const signature = JSON.stringify(label.rows.map(row => [row.kind, row.text, row.size, row.weight, row.clipped]));
            if (node.signature !== signature) {
                node.signature = signature;
                node.labels.replaceChildren(...label.rows.map(row => {
                    const text = element('text', { 'data-label-kind': row.kind, 'font-size': row.size, 'font-weight': row.weight,
                        'text-anchor': row.clipped ? 'start' : 'middle', ...(row.clipped ? { mask: `url(#${node.mask.id})` } : {}) });
                    if (topic && row.kind === 'name') renderTopicLabel(text, row.text);
                    else text.textContent = row.text;
                    return text;
                }));
            }
            [...node.labels.querySelectorAll('[data-label-kind]')].forEach((text, i) => {
                attributesOf(text, { x: label.rows[i].clipped ? inner.x : tile.x + tile.width / 2, y: tile.y + label.rows[i].y });
            });
        });
        raiseActive();
        pieSvg.setAttribute('aria-label', `${state.mode === 'personal' ? 'Personal' : 'Public'} index composition treemap`);
        visualTiles = new Map(tiles.map(tile => [Number(tile.conditionID), { ...tile }]));
        state.visualPieWeights = new Map(tiles.map(tile => [Number(tile.conditionID), tile.weightBasisPoints]));
        state.visualPieEntries = new Map(tiles.map(tile => [Number(tile.conditionID), { ...tile }]));
    }

    function renderPie({ animateWeights = false, layoutOnly = false } = {}) {
        if (disposed) return;
        const entries = orderedPieEntries(currentPieEntries());
        if (selectedObjectIndex(entries) < 0) state.selectedObjectID = entries[0]?.conditionID ?? null;
        if (!layoutOnly) renderInlineFallback();
        const bounds = pieSvg.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) { width = bounds.width; height = bounds.height; }
        pieSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const size = `${width}:${height}`, scope = JSON.stringify([state.categoryID, state.selectedContextValues, state.mode]);
        const targets = tileLayout(entries, width, height, scope);
        const canAnimate = animateWeights && visualTiles.size && lastSize === size && lastScope === scope
            && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        lastSize = size; lastScope = scope;
        if (state.pieAnimationFrame !== null) cancelAnimationFrame(state.pieAnimationFrame);
        state.pieAnimationFrame = null;
        if (!canAnimate) { draw(targets); return; }
        const collapsed = tile => ({ ...tile, x: tile.x + tile.width / 2, y: tile.y + tile.height / 2,
            width: 0, height: 0, weightBasisPoints: 0 });
        const targetMap = new Map(targets.map(tile => [Number(tile.conditionID), tile]));
        const ids = new Set([...visualTiles.keys(), ...targetMap.keys()]);
        const pairs = [...ids].map(id => {
            const from = visualTiles.get(id), to = targetMap.get(id);
            return [from ?? collapsed(to), to ?? collapsed(from)];
        });
        const startedAt = performance.now();
        const frame = now => {
            const progress = clamp((now - startedAt) / PIE_WEIGHT_TRANSITION_MS, 0, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            draw(pairs.map(([from, to]) => {
                const tile = { ...to };
                for (const key of ['x', 'y', 'width', 'height', 'weightBasisPoints']) tile[key] = from[key] + (to[key] - from[key]) * eased;
                return tile;
            }));
            if (progress < 1) state.pieAnimationFrame = requestAnimationFrame(frame);
            else { state.pieAnimationFrame = null; draw(targets); }
        };
        state.pieAnimationFrame = requestAnimationFrame(frame);
    }
    const resize = new window.ResizeObserver(() => {
        const bounds = pieSvg.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0 && (Math.abs(bounds.width - width) > .5 || Math.abs(bounds.height - height) > .5)) {
            renderPie({ layoutOnly: true });
        }
    });
    resize.observe(pieSvg);
    document.fonts.ready.then(() => { labelMetrics.clear(); renderPie({ layoutOnly: true }); });
    return { renderPie, destroy() {
        disposed = true; resize.disconnect();
        if (state.pieAnimationFrame !== null) cancelAnimationFrame(state.pieAnimationFrame);
        state.pieAnimationFrame = null;
    } };
}
