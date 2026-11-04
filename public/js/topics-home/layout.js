import * as hierarchyModule from '../vendor/d3-hierarchy-3.1.2.js';
import { createWeightTreemapLayout } from '../workspace/weight-treemap-layout.js';

// The pinned UMD exposes a global in native modules and exports in the bundle.
const { hierarchy, treemap, treemapSlice, treemapDice, treemapSquarify } = hierarchyModule.hierarchy ? hierarchyModule : hierarchyModule.default ?? globalThis.d3;
export const FEATURED_TOPIC_ID = 54;
export const OTHER_THRESHOLD = .01;
export const MAX_BAR_RATIO = .65;
export const TREEMAP_FADE = Object.freeze({ start: .32, end: .76 });
export const WEIGHT_LABEL_METRICS = Object.freeze({
    name: Object.freeze({ fontSize: 14, lineHeight: 18, fontWeight: 600 }),
    version: Object.freeze({ fontSize: 12, lineHeight: 16, fontWeight: 400 })
});
export const WEIGHT_LAYOUT_POLICY = Object.freeze({ ceiling: .4, minWidth: 56, minHeight: 24, maxAspect: 12 });
export const MODEL_LABEL_ANGLE = 66;
export const MODEL_IDENTITY_HEIGHT = Object.freeze({ normal: 124, compared: 152 });
const labelSin = Math.sin(MODEL_LABEL_ANGLE * Math.PI / 180);
const labelCos = Math.cos(MODEL_LABEL_ANGLE * Math.PI / 180);
export const HOME_WEIGHT_THEME = Object.freeze({ id: 'frost-hatch', ink: '#111111', divider: '#bfc4cb', texture: 'hatch',
    colors: Object.freeze(['#e4eaf1', '#cbd5e2', '#eef1f5', '#d5dfe6', '#e2e4eb', '#cbdcde', '#d8e0ee', '#edf0f4']) });
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function topicCollection(topics, collection, recent = [], userID = null) {
    const authorized = topics.filter(topic => !topic.isPrivate || userID !== null && topic.isMine === true);
    if (collection === 'configured' || collection === 'mine') return orderTopics(authorized.filter(topic => userID !== null
        && (topic.configured === true || topic.isPrivate === true && topic.isMine === true)));
    if (collection !== 'recent') return orderTopics(authorized);
    const available = new Map(authorized.map(topic => [Number(topic.ID), topic]));
    const seen = new Set();
    return orderTopics(recent.flatMap(record => {
        const topic = available.get(record.categoryID);
        if (!topic || seen.has(record.categoryID)) return [];
        seen.add(record.categoryID); return [topic];
    }));
}

export function modelTargetURL(href, model, filters, isPrivate = false) {
    const numericID = Number(model.modelID ?? model.ID);
    const focus = typeof model.comparisonIdentity === 'string' && model.comparisonIdentity
        ? model.comparisonIdentity : Number.isSafeInteger(numericID) && numericID > 0 ? String(numericID) : null;
    if (!href || !focus) return null;
    const url = new URL(href, 'https://home.invalid');
    url.searchParams.set('focusModel', focus);
    url.searchParams.set('scoreMode', filters.scoreMode === 'range' ? 'range' : 'available');
    url.searchParams.set('compareReasoning', filters.reasoning ? '1' : '0');
    url.searchParams.set('compareHarness', filters.harness ? '1' : '0');
    url.searchParams.set('mode', isPrivate ? 'personal' : 'public');
    return url.pathname + url.search + url.hash;
}

export function scoreLabelLayout(labelWidth, barWidth, barHeight, comparable = true) {
    const fontSize = Math.floor(Math.min(12, 12 * (barWidth - 4) / Math.max(1, labelWidth), (barHeight - 2) / 1.2) * 10) / 10;
    return !comparable || fontSize < 9 ? { outside: true, fontSize: 12, lineHeight: 16 }
        : { outside: false, fontSize, lineHeight: fontSize * 1.2 };
}

export function orderTopics(topics) {
    return [...topics].sort((a, b) => Number(Number(b.ID) === FEATURED_TOPIC_ID) - Number(Number(a.ID) === FEATURED_TOPIC_ID));
}

export function modelKey(model) {
    return model.comparisonIdentity ?? JSON.stringify([model.modelID ?? model.ID ?? model.modelName ?? model.name,
        model.condition?.scoreFields ?? model.condition?.parameters ?? {}]);
}

export function mergePreview(previous, incoming, append = false) {
    if (!incoming || !Array.isArray(incoming.models)) throw new TypeError('Invalid topic preview.');
    if (append && previous?.topicID !== incoming.topicID) throw new TypeError('Topic preview changed.');
    const merged = { ...previous, ...incoming };
    if (append) {
        const models = new Map((previous?.models ?? []).map(model => [modelKey(model), model]));
        for (const model of incoming.models) models.set(modelKey(model), model);
        merged.models = [...models.values()];
    }
    return merged;
}

export function weightEntries(weights) {
    const entries = (weights ?? []).filter(entry => Number.isFinite(Number(entry.weightBasisPoints)) && Number(entry.weightBasisPoints) > 0)
        .map(entry => ({ ...entry, weightBasisPoints: Number(entry.weightBasisPoints),
            name: String(entry.name || 'Unnamed benchmark'), conditionName: String(entry.conditionName || ''),
            key: `condition:${entry.conditionID ?? entry.name}` }));
    const total = entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
    const members = entries.filter(entry => entry.weightBasisPoints / total < OTHER_THRESHOLD);
    const visible = entries.filter(entry => entry.weightBasisPoints / total >= OTHER_THRESHOLD);
    if (members.length) visible.push({ key: 'other', name: 'Other', conditionName: '', isOther: true,
        weightBasisPoints: members.reduce((sum, entry) => sum + entry.weightBasisPoints, 0),
        members: members.sort((a, b) => b.weightBasisPoints - a.weightBasisPoints || compareText(a.key, b.key)) });
    return { total, entries: visible.map(entry => ({ ...entry, share: entry.weightBasisPoints / total }))
        .sort((a, b) => b.weightBasisPoints - a.weightBasisPoints || compareText(a.key, b.key)) };
}

function tileShape(width, height, area) {
    const root = Math.sqrt(area);
    return width + 1e-7 >= Math.min(WEIGHT_LAYOUT_POLICY.minWidth, root * .8)
        && height + 1e-7 >= Math.min(WEIGHT_LAYOUT_POLICY.minHeight, root * .5)
        && Math.max(width / height, height / width) <= WEIGHT_LAYOUT_POLICY.maxAspect + 1e-7;
}

// Row starts depend only on preceding weight, so a suffix DP can optimize the
// uninterrupted descending prefix without enumerating every row partition.
function priorityRows(entries, width, height) {
    const sums = [0];
    for (const entry of entries) sums.push(sums.at(-1) + entry.weightBasisPoints);
    const total = sums.at(-1);
    const plans = Array(entries.length + 1).fill(null);
    plans[entries.length] = { chain: 0, cost: 0 };
    for (let start = entries.length - 1; start >= 0; start--) {
        let minWidthRatio = 0;
        for (let end = start + 1; end <= entries.length; end++) {
            const entry = entries[end - 1];
            const area = entry.weightBasisPoints / total * width * height;
            minWidthRatio = Math.max(minWidthRatio, Math.min(WEIGHT_LAYOUT_POLICY.minWidth, Math.sqrt(area) * .8) / entry.weightBasisPoints);
            const weight = sums[end] - sums[start], rowHeight = weight / total * height;
            if (width / weight + 1e-9 < minWidthRatio) break;
            if (!plans[end]) continue;
            let cost = 0, valid = true;
            for (let index = start; index < end; index++) {
                const value = entries[index].weightBasisPoints;
                const cellWidth = value / weight * width;
                if (!tileShape(cellWidth, rowHeight, value / total * width * height)) { valid = false; break; }
                cost += value * Math.log(cellWidth / rowHeight) ** 2;
            }
            if (!valid) continue;
            const exposed = sums[start] / total <= WEIGHT_LAYOUT_POLICY.ceiling + 1e-9;
            const candidate = { end, chain: exposed ? end - start + plans[end].chain : 0, cost: cost + plans[end].cost };
            const best = plans[start];
            if (!best || candidate.chain > best.chain || candidate.chain === best.chain && candidate.cost < best.cost) plans[start] = candidate;
        }
    }
    if (!plans[0]) return null;
    const rows = [];
    for (let start = 0; start < entries.length;) {
        const end = plans[start].end;
        rows.push({ axis: 'x', children: entries.slice(start, end) }); start = end;
    }
    return { ...plans[0], rows, topCount: rows[0].children.length };
}

export function weightChainLength(tiles, height) {
    const end = tiles.findIndex(tile => tile.y > height * WEIGHT_LAYOUT_POLICY.ceiling + 1e-7);
    return end < 0 ? tiles.length : end;
}

export function weightLayout(weights, width, height, view = 'default') {
    const { entries, total } = weightEntries(weights);
    if (!entries.length || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    if (view === 'weights') {
        // Layout-only IDs include Other and entries without a condition ID; keep their original metadata in the result.
        return createWeightTreemapLayout({ padding: 0 })(entries.map((entry, index) => ({
            conditionID: index + 1, weightBasisPoints: entry.weightBasisPoints
        })), width, height).map(({ conditionID, x, y, width, height }) => ({
            ...entries[conditionID - 1], total, x, y, width, height
        }));
    }
    let best = null, prefix = 0, headCost = 0;
    // Full-height leading columns can expose a longer chain than rows alone,
    // especially when one large weight would otherwise push everything down.
    for (let head = 0; head <= entries.length; head++) {
        if (head) {
            const entry = entries[head - 1], cellWidth = entry.share * width;
            if (!tileShape(cellWidth, height, entry.share * width * height)) break;
            prefix += entry.weightBasisPoints;
            headCost += entry.weightBasisPoints * Math.log(cellWidth / height) ** 2;
        }
        const remaining = total - prefix;
        const tail = remaining ? priorityRows(entries.slice(head), width * remaining / total, height) : { chain: 0, cost: 0, rows: [], topCount: 0 };
        if (!tail) continue;
        const candidate = { head, rows: tail.rows, chain: head + tail.chain, cost: headCost + tail.cost, topCount: head + tail.topCount };
        const parallel = Number(candidate.topCount > 1), bestParallel = Number(best?.topCount > 1);
        if (!best || candidate.chain > best.chain || candidate.chain === best.chain
            && (parallel > bestParallel || parallel === bestParallel && candidate.cost < best.cost)) best = candidate;
    }
    const data = best ? { axis: 'x', children: [...entries.slice(0, best.head),
        ...(best.rows.length ? [{ axis: 'y', children: best.rows }] : [])] } : { children: entries };
    const root = hierarchy(data).sum(entry => entry.weightBasisPoints ?? 0);
    treemap().size([width, height]).padding(0).round(false)
        .tile((node, x0, y0, x1, y1) => (best ? node.data.axis === 'x' ? treemapDice : treemapSlice : treemapSquarify)(node, x0, y0, x1, y1))(root);
    return root.leaves().map(node => ({ ...node.data, total, x: node.x0, y: node.y0,
        width: node.x1 - node.x0, height: node.y1 - node.y0 }));
}

export function modelLabelLayout(parts, measure = text => text.length * 6) {
    const parameters = parts.some(part => part.kind === 'parameter');
    const baseWidth = Math.ceil(measure(parts.find(part => part.kind !== 'parameter')?.text ?? ''));
    const width = parameters ? 88 : baseWidth > 88 ? 82 : Math.max(16, baseWidth);
    const rows = parts.map(part => ({ lines: measure(part.text) > width - (part.kind === 'parameter' ? 15 : 0)
        && /\s/.test(part.text.trim()) ? 2 : 1 }));
    const height = rows.reduce((sum, row) => sum + row.lines * 13, 0) + Math.max(0, rows.length - 1) * 2;
    return { width, height, rows, projectedWidth: width * labelCos + height * labelSin,
        projectedHeight: width * labelSin + height * labelCos, top: 38 + width * labelSin,
        anchorX: width * labelCos + height * labelSin / 2 };
}

export function fitWeightLabel(tile, measure = text => text.length * 7) {
    const width = tile.width - 16, height = tile.height - 10;
    const name = String(tile.name ?? '').trim();
    if (!name || width < 16 || height < WEIGHT_LABEL_METRICS.name.lineHeight) return { kind: 'none', lines: [], height: 0 };
    const line = (text, kind) => ({ text, kind, overflow: measure(text, kind) > width });
    const lines = [line(name, 'name')];
    let used = WEIGHT_LABEL_METRICS.name.lineHeight;
    const version = String(tile.conditionName ?? '').trim();
    if (version && !/^default$/i.test(version) && used + WEIGHT_LABEL_METRICS.version.lineHeight <= height) {
        lines.push(line(version, 'version')); used += WEIGHT_LABEL_METRICS.version.lineHeight;
    }
    return { kind: lines.length > 1 ? 'full' : 'name', lines, height: used };
}

export function modelColumnOpacity(index, scrollLeft, { slot, visible }) {
    if (!(slot > 0 && visible > 0)) return 0;
    const offset = Math.max(0, scrollLeft);
    const overlap = Math.min((index + 1) * slot, offset + visible * slot) - Math.max(index * slot, offset);
    const fraction = Math.max(0, Math.min(1, overlap / slot));
    return fraction * fraction * (3 - 2 * fraction);
}

export function columnLayout(availableWidth, loadedCount, totalCount = loadedCount, minimumSlot = 0, edgeInset = 0) {
    if (availableWidth <= 0 || !loadedCount) return { visible: 0, slot: 0, width: 0, barWidth: 0 };
    const inset = Math.min(Math.max(0, edgeInset), Math.max(0, (availableWidth - 48) / 2));
    availableWidth -= inset * 2;
    const requested = Number.isFinite(minimumSlot) ? Math.max(0, Math.ceil(minimumSlot)) : 0;
    const preferred = Math.max(totalCount <= 4 ? 80 : totalCount <= 10 ? 56 : 48, requested);
    const visible = Math.min(loadedCount, Math.max(1, Math.floor(availableWidth / preferred)));
    const ceiling = requested ? Math.min(availableWidth, Math.max(96, requested)) : 96;
    const slot = Math.min(availableWidth, ceiling, Math.max(48, Math.floor(availableWidth / visible)));
    return { visible, slot, width: slot * visible, inset, frameWidth: slot * visible + inset * 2,
        barWidth: Math.min(slot, Math.max(28, Math.min(36, Math.floor(slot * .58)))) };
}

export function modelBarScale(preview, scoreMode) {
    if (scoreMode === 'range') return preview.scoreScale;
    // Keep the full ranking's leader as the anchor when later pages are appended.
    const leader = preview.models.find(model => model.comparable !== false
        && Number.isFinite(model.lower) && Number.isFinite(model.upper));
    return { min: 0, max: leader?.lower > 0 ? leader.lower : 1 };
}

export function barGeometry(model, scoreScale, plotHeight) {
    let min = Number(scoreScale?.min ?? 0), max = Number(scoreScale?.max ?? 100);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) { min = 0; max = 100; }
    const span = max - min;
    const project = value => Math.max(0, Math.min(1, Number.isFinite(span) ? (value - min) / span
        : (value / 2 - min / 2) / (max / 2 - min / 2))) * plotHeight * MAX_BAR_RATIO;
    const comparable = model.comparable !== false && Number.isFinite(model.lower) && Number.isFinite(model.upper);
    return { known: comparable ? project(model.lower) : 0,
        upper: comparable ? project(Math.max(model.lower, model.upper)) : 0, comparable };
}
