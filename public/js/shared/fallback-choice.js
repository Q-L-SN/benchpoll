export const FALLBACK_SELECTION_SOURCES = ['selected', 'custom'];

export function fallbackStatusLabel(rule) {
    if (!rule) return 'Follow community';
    if (rule.selectionSource === 'custom') return 'Custom';
    return rule.entries.length ? 'Selected configuration' : 'No fallback';
}

export const COMMUNITY_FALLBACK_EXPLANATION = 'You are following the community. Only people who explicitly choose a fallback configuration shape the mix, weighted by their allocation to this benchmark. That mix applies to everyone following the community. If nobody has made a choice, no fallback is used. Selecting a card replaces the community mix; deselecting it resumes following the community.';
