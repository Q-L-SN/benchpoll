import { JOINT_VERSION_METHOD, PEER_MEDIAN_METHOD, TREEMAP_ESTIMATION_METHOD } from '../shared/fallback-inference.js';

const methods = new Map([
    [JOINT_VERSION_METHOD, { label: 'Version estimate', icon: 'fa-code-branch', glyph: '\uf126', href: '/how-it-works#calibration',
        description: 'A version estimate converts this model’s measured scores from eligible versions to the target scale.' }],
    [TREEMAP_ESTIMATION_METHOD, { label: 'Treemap estimate', icon: 'fa-diagram-project', glyph: '\uf542', href: '/how-it-works#treemap-estimates',
        description: 'A treemap estimate follows calibrated version chains from other weighted benchmarks.' }],
    [PEER_MEDIAN_METHOD, { label: 'Peer median', icon: 'fa-users', glyph: '\uf0c0', href: '/how-it-works#peer-median',
        description: 'A peer median uses other models’ measured or previously estimated scores on the target version.' }]
]);
const explanation = [...methods.values()].map(method => method.description).join('\n')
    + '\n\nClick to read more in How it works.';

export function estimationMethodDetails(methodIDs) {
    const used = methodIDs.map(ID => methods.get(ID)).filter(Boolean);
    if (!used.length) return null;
    if (used.length === 1) return { ...used[0], tooltip: `${used[0].label}\n\n${explanation}` };
    return { label: 'Multiple estimation methods', icon: 'fa-layer-group', glyph: '\uf5fd',
        href: '/how-it-works#estimated-score',
        tooltip: `This score uses ${used.map(method => method.label.toLowerCase()).join(', ')}.\n\n${explanation}` };
}
