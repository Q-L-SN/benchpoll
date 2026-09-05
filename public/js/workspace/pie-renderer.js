import { SVG_NS, PIE_WEIGHT_TRANSITION_MS, PIE_GRADIENTS } from './constants.js';
import { polarToCartesian, describeArc, splitPieLabel, benchmarkConditionLabel, benchmarkAccessibleName, clamp } from './weights.js';

export function createPieRenderer({ state, pieSvg, orderedPieEntries, currentPieEntries, selectedObjectIndex, renderInlineFallback, fallbackRuleFor, publicFallbackRuleFor, onSelect }) {
    function createSvgElement(tag, attributes = {}) {
        const element = document.createElementNS(SVG_NS, tag);
        Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
        return element;
    }

    function drawPie(entries) {
        if (entries.length === 0) {
            pieSvg.replaceChildren();
            const empty = createSvgElement('text', { x: 180, y: 180, class: 'bp-pie-empty' });
            empty.textContent = state.mode === 'personal'
                ? 'Choose a benchmark on the right to begin'
                : 'No public weights yet';
            pieSvg.append(empty);
            return;
        }

        pieSvg.querySelector('.bp-pie-empty')?.remove();
        if (selectedObjectIndex(entries) < 0) {
            state.selectedObjectID = entries[0].conditionID;
        }
        let defs = pieSvg.querySelector(':scope > defs[data-pie-defs]');
        if (!defs) {
            defs = createSvgElement('defs', { 'data-pie-defs': '' });
            pieSvg.prepend(defs);
        }
        const desiredIDs = new Set(entries.map(entry => Number(entry.conditionID)));
        pieSvg.querySelectorAll(':scope > g[data-object-id]').forEach(group => {
            if (!desiredIDs.has(Number(group.dataset.objectId))) {
                group.remove();
            }
        });
        defs.querySelectorAll('linearGradient[data-object-id]').forEach(gradient => {
            if (!desiredIDs.has(Number(gradient.dataset.objectId))) {
                gradient.remove();
            }
        });

        entries.forEach((entry, index) => {
            const objectID = Number(entry.conditionID);
            const colorIndex = state.pieOrderByObjectID.get(Number(entry.conditionID)) ?? index;
            const [startColor, endColor] = PIE_GRADIENTS[colorIndex % PIE_GRADIENTS.length];
            let gradient = defs.querySelector(`linearGradient[data-object-id="${objectID}"]`);
            if (!gradient) {
                gradient = createSvgElement('linearGradient', {
                    id: `bp-pie-gradient-${objectID}`,
                    'data-object-id': objectID,
                    x1: '0%', y1: '0%', x2: '100%', y2: '100%'
                });
                gradient.append(
                    createSvgElement('stop', { offset: '0%', 'stop-color': startColor }),
                    createSvgElement('stop', { offset: '100%', 'stop-color': endColor })
                );
                defs.append(gradient);
            }
        });

        const cx = 180;
        const cy = 180;
        const radius = 160;
        let startAngle = 7;
        entries.forEach((entry, index) => {
            const weight = Number(entry.weightBasisPoints) / state.limits.totalBasisPoints;
            const angle = weight * 360;
            const endAngle = startAngle + angle;
            const middleAngle = startAngle + angle / 2;
            const selected = Number(state.selectedObjectID) === Number(entry.conditionID);
            const objectID = Number(entry.conditionID);
            let group = pieSvg.querySelector(`:scope > g[data-object-id="${objectID}"]`);
            if (!group) {
                group = createSvgElement('g', {
                    role: 'button',
                    tabindex: '0',
                    'data-object-id': objectID
                });
                const liftLayer = createSvgElement('g', { class: 'bp-pie-slice-lift' });
                const slice = createSvgElement('path', { class: 'bp-pie-slice' });
                liftLayer.append(slice);
                group.append(liftLayer);
                const select = () => onSelect(Number(group.dataset.objectId));
                group.addEventListener('mousedown', event => event.preventDefault());
                group.addEventListener('click', () => void select());
                group.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void select();
                    }
                });
                pieSvg.append(group);
            }
            const hasFallback = state.mode === 'personal'
                ? Boolean(fallbackRuleFor(objectID))
                : Boolean(publicFallbackRuleFor(objectID));
            group.setAttribute(
                'aria-label',
                `${benchmarkAccessibleName(entry)}: ${entry.weight.toFixed(2)}%${hasFallback ? '. Fallback enabled' : ''}`
            );
            const liftLayer = group.querySelector('.bp-pie-slice-lift');
            const slice = group.querySelector('.bp-pie-slice');
            slice.setAttribute('d', describeArc(cx, cy, radius, startAngle, endAngle));
            slice.setAttribute('fill', `url(#bp-pie-gradient-${objectID})`);
            slice.classList.toggle('selected', selected);

            if (entry.weight >= 7) {
                const labelPoint = polarToCartesian(cx, cy, radius * (entry.weight >= 24 ? 0.57 : 0.7), middleAngle);
                let text = group.querySelector('.bp-pie-label');
                const labelLines = splitPieLabel(entry.name).slice(0, 2);
                const conditionLabel = benchmarkConditionLabel(entry);
                const labelKey = [...labelLines, conditionLabel, hasFallback ? 'fallback' : ''].join('\n');
                if (!text || text.dataset.labelKey !== labelKey) {
                    text?.remove();
                    text = createSvgElement('text', { class: 'bp-pie-label' });
                    text.dataset.labelKey = labelKey;
                    labelLines.forEach(line => {
                        const tspan = createSvgElement('tspan', { 'data-label-line': '' });
                        tspan.textContent = line.length > 18 ? `${line.slice(0, 16)}…` : line;
                        text.append(tspan);
                    });
                    if (hasFallback) {
                        const fallbackIcon = createSvgElement('tspan', {
                            class: 'bp-pie-fallback-icon',
                            dx: '4',
                            'aria-hidden': 'true'
                        });
                        fallbackIcon.textContent = '\uf126';
                        text.append(fallbackIcon);
                    }
                    if (conditionLabel) {
                        const condition = createSvgElement('tspan', {
                            class: 'bp-pie-condition',
                            'data-label-condition': ''
                        });
                        condition.textContent = conditionLabel.length > 18
                            ? `${conditionLabel.slice(0, 16)}…`
                            : conditionLabel;
                        text.append(condition);
                    }
                    text.append(createSvgElement('tspan', { 'data-label-percent': '' }));
                    liftLayer.append(text);
                }
                text.setAttribute('x', labelPoint.x);
                const contentLineCount = labelLines.length + (conditionLabel ? 1 : 0);
                text.setAttribute('y', labelPoint.y - Math.max(7, (contentLineCount - 1) * 8));
                text.querySelectorAll('[data-label-line]').forEach((line, lineIndex) => {
                    line.setAttribute('x', labelPoint.x);
                    line.setAttribute('dy', lineIndex === 0 ? 0 : 17);
                });
                const condition = text.querySelector('[data-label-condition]');
                if (condition) {
                    condition.setAttribute('x', labelPoint.x);
                    condition.setAttribute('dy', 17);
                }
                const percentage = text.querySelector('[data-label-percent]');
                percentage.setAttribute('x', labelPoint.x);
                percentage.setAttribute('dy', 18);
                percentage.textContent = `${Math.round(entry.weight)}%`;
            } else {
                group.querySelector('.bp-pie-label')?.remove();
            }
            startAngle = endAngle;
        });
        const selectedGroup = pieSvg.querySelector(`:scope > g[data-object-id="${Number(state.selectedObjectID)}"]`);
        if (selectedGroup) {
            pieSvg.append(selectedGroup);
        }
        pieSvg.setAttribute('aria-label', state.mode === 'personal'
            ? 'Personal benchmark weights'
            : 'Public benchmark weights');
    }

    function renderPie({ animateWeights = false } = {}) {
        const entries = orderedPieEntries(currentPieEntries());
        if (selectedObjectIndex(entries) < 0) {
            state.selectedObjectID = entries[0]?.conditionID ?? null;
        }
        renderInlineFallback();

        const targetWeights = new Map(entries.map(entry => [
            Number(entry.conditionID),
            Number(entry.weightBasisPoints)
        ]));
        const canAnimate = animateWeights
            && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
            && state.visualPieWeights.size > 0;

        if (!canAnimate) {
            if (state.pieAnimationFrame !== null) {
                cancelAnimationFrame(state.pieAnimationFrame);
                state.pieAnimationFrame = null;
            }
            state.visualPieWeights = targetWeights;
            state.visualPieEntries = new Map(entries.map(entry => [Number(entry.conditionID), { ...entry }]));
            drawPie(entries);
            return;
        }

        const animationEntryMap = new Map(state.visualPieEntries);
        entries.forEach(entry => animationEntryMap.set(Number(entry.conditionID), { ...entry }));
        const animationEntries = orderedPieEntries(Array.from(animationEntryMap.values()));
        const startWeights = new Map(animationEntries.map(entry => {
            const objectID = Number(entry.conditionID);
            return [objectID, Number(state.visualPieWeights.get(objectID) ?? 0)];
        }));
        const animationTargetWeights = new Map(animationEntries.map(entry => {
            const objectID = Number(entry.conditionID);
            return [objectID, Number(targetWeights.get(objectID) ?? 0)];
        }));
        if (state.pieAnimationFrame !== null) {
            cancelAnimationFrame(state.pieAnimationFrame);
        }
        const startedAt = performance.now();
        const animateFrame = now => {
            const progress = clamp((now - startedAt) / PIE_WEIGHT_TRANSITION_MS, 0, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const frameEntries = animationEntries.map(entry => {
                const objectID = Number(entry.conditionID);
                const start = startWeights.get(objectID);
                const target = animationTargetWeights.get(objectID);
                const weightBasisPoints = start + ((target - start) * eased);
                return {
                    ...entry,
                    weightBasisPoints,
                    weight: weightBasisPoints / 100
                };
            });
            state.visualPieWeights = new Map(frameEntries.map(entry => [
                Number(entry.conditionID),
                Number(entry.weightBasisPoints)
            ]));
            state.visualPieEntries = new Map(frameEntries.map(entry => [Number(entry.conditionID), { ...entry }]));
            drawPie(frameEntries);
            if (progress < 1) {
                state.pieAnimationFrame = requestAnimationFrame(animateFrame);
            } else {
                state.pieAnimationFrame = null;
                state.visualPieWeights = targetWeights;
                state.visualPieEntries = new Map(entries.map(entry => [Number(entry.conditionID), { ...entry }]));
                drawPie(entries);
            }
        };
        state.pieAnimationFrame = requestAnimationFrame(animateFrame);
    }

    return { renderPie };
}
