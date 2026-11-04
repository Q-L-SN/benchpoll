import * as hierarchyModule from '../vendor/d3-hierarchy-3.1.2.js';

const { hierarchy, treemap, treemapResquarify } = hierarchyModule.hierarchy
    ? hierarchyModule : hierarchyModule.default ?? globalThis.d3;
const horizontalShapeBias = 3;

export function createWeightTreemapLayout({ padding: outerPadding = 14 } = {}) {
    let root = null;
    let identity = '';
    const layout = treemap().tile(treemapResquarify).round(false).padding(0);
    return (entries, width, height, scope = '') => {
        const byID = new Map();
        for (const entry of entries) {
            const id = Number(entry.conditionID), weight = Number(entry.weightBasisPoints);
            if (!Number.isSafeInteger(id) || id === 0 || !Number.isFinite(weight) || weight <= 0) continue;
            if (byID.has(id)) throw new TypeError(`Duplicate benchmark condition: ${id}`);
            byID.set(id, entry);
        }
        const nextIdentity = JSON.stringify([scope, [...byID.keys()].sort((a, b) => a - b)]);
        const value = node => Number(byID.get(node.id)?.weightBasisPoints ?? 0);
        if (identity !== nextIdentity) {
            identity = nextIdentity;
            root = hierarchy({ children: [...byID.keys()].map(id => ({ id })) }).sum(value)
                .sort((a, b) => b.value - a.value || a.data.id - b.data.id);
        } else root.sum(value);
        const w = Number.isFinite(width) ? Math.max(0, width) : 0;
        const h = Number.isFinite(height) ? Math.max(0, height) : 0;
        if (!root.value || !w || !h) return [];
        const padding = Math.min(outerPadding, w / 10, h / 10);
        // Stretch the layout space vertically, then compress it to favor wide, shallow tiles without changing areas.
        layout.size([w - padding * 2, (h - padding * 2) * horizontalShapeBias])(root);
        return root.leaves().map(node => ({ ...byID.get(node.data.id),
            x: node.x0 + padding, y: node.y0 / horizontalShapeBias + padding,
            width: node.x1 - node.x0, height: (node.y1 - node.y0) / horizontalShapeBias, share: node.value / root.value }));
    };
}

export function treemapHoverTransform(tile, width, height) {
    const scale = Math.max(1, Math.min(1.08, (width - 2) / Math.max(1, tile.width),
        (height - 2) / Math.max(1, tile.height)));
    const dx = tile.width * (scale - 1) / 2, dy = tile.height * (scale - 1) / 2;
    return { scale,
        x: Math.max(1 - tile.x + dx, Math.min(0, width - 1 - tile.x - tile.width - dx)),
        y: Math.max(1 - tile.y + dy, Math.min(0, height - 1 - tile.y - tile.height - dy)) };
}
