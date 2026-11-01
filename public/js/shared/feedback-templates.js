export function betaFeedbackTemplate() {
    return 'Describe the change you want and the problem it would solve. Add a link or example if useful.';
}

export function mergeRequestTemplate({ name, kind, ID }) {
    return mergeGuidance(`${name} (${kind} #${ID})`);
}

export function privacyRequestTemplate() {
    return 'Tell us whether you want to access, correct, or delete personal data. Identify the account or record and explain what you need.';
}

export function bulkImportTemplate({ query = '', categoryPath = '', contextValues = {} } = {}) {
    const context = Object.entries(contextValues).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(', ');
    return ['For a bulk import, name the benchmarks and link to their official leaderboards, papers, or datasets. Say which model scores and versions to include.',
        ...(query.trim() ? [`Requested benchmark: ${query.trim()}.`] : []),
        ...(categoryPath ? [`Topic: ${categoryPath}.`] : []), ...(context ? [`Task options: ${context}.`] : [])].join(' ');
}

function mergeGuidance(target) {
    return `To merge ${target || 'a duplicate'}, tell us which item to keep (name, ID, or link), why they are duplicates, and what information to preserve.`;
}

export function feedbackGuidance(value = '') {
    const text = String(value ?? '').trim();
    if (!text) return betaFeedbackTemplate();
    const lines = text.split(/\r?\n/).map(line => line.trim());
    const field = label => {
        const index = lines.indexOf(label), values = [];
        if (index < 0) return '';
        for (let cursor = index + 1; cursor < lines.length && lines[cursor] && !/^(?:Category|Task options):/.test(lines[cursor]); cursor++) {
            if (!/^\[[^\]]*\]$/.test(lines[cursor])) values.push(lines[cursor]);
        }
        return values.join(' ');
    };
    const inline = label => lines.find(line => line.startsWith(label))?.slice(label.length).trim() || '';
    const supplied = labels => labels.flatMap(label => field(label) ? [`${label} ${field(label)}`] : []).join(' ');
    // Handoffs from an older open page can still contain the previous form template.
    if (['Beta feedback', 'BenchPoll Beta feedback'].includes(lines[0])) {
        return [betaFeedbackTemplate(), supplied(['Suggested change:', 'My suggestion:', 'Problem or example (optional):'])].filter(Boolean).join(' ');
    }
    if (lines[0] === 'Bulk import request') {
        return [bulkImportTemplate({ query: field('Benchmarks:'), categoryPath: inline('Category:') }),
            inline('Task options:') ? `Task options: ${inline('Task options:')}.` : '',
            supplied(['Official sources:', 'Scores to include:'])].filter(Boolean).join(' ');
    }
    if (lines[0] === 'Merge request') {
        return [mergeGuidance(field('Duplicate to merge:')), supplied(['Item to keep:', 'Into the object to keep:', 'Why they are duplicates:'])].filter(Boolean).join(' ');
    }
    if (lines[0] === 'Privacy request') {
        return [privacyRequestTemplate(), supplied(['What I need:', 'Account or record:', 'Details (optional):'])].filter(Boolean).join(' ');
    }
    return text.replace(/\s*\r?\n\s*/g, ' ');
}

export function feedbackMessageLimit(guidance) {
    return Math.max(0, 4000 - feedbackGuidance(guidance).length - 2);
}

export function feedbackSubmission(guidance, message) {
    const text = String(message ?? '').trim();
    if (text.length < 10) throw new RangeError('Please add a little more detail before submitting.');
    const details = `${feedbackGuidance(guidance)}\n\n${text}`;
    if (details.length > 4000) throw new RangeError('Your message is too long. Shorten it before submitting.');
    return details;
}
