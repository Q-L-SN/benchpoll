import { canonicalNumber, normalizeScoreFields } from './public/js/shared/score-fields.js';

const effort = '(minimal|low|medium|high|xhigh|x-high|max|ultra|none)';
const parenthesizedEffort = new RegExp(`\\s*\\((?:(?:thinking|reasoning|effort)[ -])?${effort}\\)(?=\\s*(?:\\([0-9]{4,8}\\))?\\s*$)`, 'i');
const terminalEffort = new RegExp(`-${effort}$`, 'i');
const spacedEffort = new RegExp(` ${effort}$`, 'i');
const datedTerminalEffort = new RegExp(`-${effort}(?=-[0-9]{4,8}$)`, 'i');

export function modelRunConfiguration(name, vendorSlug) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A source model name is required');
    let baseName = name.trim();
    const configuration = {};
    const sonar = vendorSlug === 'perplexity-ai'
        ? baseName.match(/^(?:pplx?-)?(sonar(?:-reasoning)?(?:-pro)?)(?:-(low|medium|high))?$/i) : null;
    if (sonar) {
        baseName = sonar[1].toLowerCase();
        if (sonar[2]) configuration.searchContextSize = sonar[2].toLowerCase();
    }
    const grounding = vendorSlug === 'google'
        && /^gemini-(?:2\.5|3(?:\.1)?)-(?:pro|flash)-grounding$/i.test(baseName);
    if (grounding) {
        configuration.toolConfiguration = 'Google Search grounding';
        baseName = baseName.slice(0, -'-grounding'.length);
    }
    const configurableThinking = (vendorSlug === 'deepseek'
        && /^deepseek-v3\.(?:1(?:-terminus)?|2(?:-exp)?)-(?:non-)?thinking$/i.test(baseName))
        || (vendorSlug === 'google'
            && /^gemini-2\.5-flash(?:-lite)?(?:-preview(?:-\d{2}-(?:\d{2}|\d{4}))?)?-(?:no-)?thinking$/i.test(baseName))
        || (vendorSlug === 'qwen' && /^qwen3-235b-a22b-(?:no-)?thinking$/i.test(baseName));
    if (configurableThinking) {
        const mode = baseName.match(/-(no-thinking|non-thinking|thinking)$/i);
        configuration.reasoningMode = mode[1].toLowerCase() === 'thinking' ? 'enabled' : 'disabled';
        baseName = baseName.slice(0, mode.index);
    }
    const kimiMode = vendorSlug === 'moonshot-ai' ? baseName.match(/^(kimi-k2\.5)-(thinking|instant)$/i) : null;
    if (kimiMode) {
        baseName = kimiMode[1];
        configuration.reasoningMode = kimiMode[2].toLowerCase() === 'thinking' ? 'enabled' : 'disabled';
    }
    const harness = baseName.match(/\s*\((codex-harness)\)\s*$/i);
    if (harness && vendorSlug === 'openai') {
        configuration.agentHarness = harness[1].toLowerCase();
        baseName = baseName.slice(0, harness.index).trim();
    }
    const mode = baseName.match(/\s*\((thinking|non-thinking)\)\s*$/i);
    if (mode) {
        configuration.reasoningMode = mode[1].toLowerCase() === 'thinking' ? 'enabled' : 'disabled';
        baseName = baseName.slice(0, mode.index).trim();
    }
    const tokenSetting = vendorSlug === 'anthropic' && /^claude-/i.test(baseName)
        ? baseName.match(/-(high|thinking)-((?:16|32)k)$/i) : null;
    if (tokenSetting) {
        // Preserve the source notation; it does not attest an exact token count or cap type.
        configuration.configurationSelection = tokenSetting[2].toLowerCase();
        if (tokenSetting[1].toLowerCase() === 'high') configuration.reasoningEffort = 'high';
        else configuration.reasoningMode = 'enabled';
        baseName = baseName.slice(0, tokenSetting.index).trim();
    }
    let match = baseName.match(parenthesizedEffort);
    if (!match && /^(openai|anthropic|google|meta|xai|deepseek|z-ai|moonshot-ai)$/.test(vendorSlug)) {
        match = baseName.match(terminalEffort) || baseName.match(datedTerminalEffort);
        if (!match && vendorSlug === 'google' && /^gemini[- ]/i.test(baseName)) match = baseName.match(spacedEffort);
    }
    if (!match && vendorSlug === 'deepseek' && /^deepseek-v4-(?:pro|flash)-(?:high|max)-preview$/i.test(baseName)) {
        match = baseName.match(/-(high|max)(?=-preview$)/i);
    }
    // Edition names retain their identity regardless of the source's punctuation.
    const editionName = baseName.replace(/\s*\((max|ultra)\)/ig, ' $1');
    if (match && (/^imagen[- ]/i.test(editionName)
        || /codex[- ]max(?:[- ]?[0-9]{4,8})?$/i.test(editionName)
        || /^qwen.*[- ]max(?:[- ]?[0-9]{4,8})?$/i.test(editionName))) match = null;
    if (match) {
        configuration.reasoningEffort = match[1].toLowerCase().replace('-', '');
        baseName = `${baseName.slice(0, match.index)}${baseName.slice(match.index + match[0].length)}`.trim();
    }
    if (!baseName) throw new Error('Run configuration has no base model name');
    return { baseName, configuration };
}

export function runConfigurationFields(configuration, definitions) {
    const assignments = [];
    const definitionsByName = new Map();
    for (const definition of definitions) {
        const key = definition.name.toLowerCase();
        if (definitionsByName.has(key)) throw new Error(`Ambiguous score field: ${definition.name}`);
        definitionsByName.set(key, definition);
    }
    for (const [key, value] of Object.entries(configuration)) {
        const specification = { reasoningEffort: { name: 'Reasoning effort', type: 'enum' },
            reasoningMode: { name: 'Reasoning mode', type: 'enum' }, agentHarness: { name: 'Agent harness', type: 'text' },
            configurationSelection: { name: 'Configuration selection', type: 'text' },
            searchContextSize: { name: 'Search context size', type: 'enum' },
            toolConfiguration: { name: 'Tool configuration', type: 'text' } }[key];
        if (!specification) throw new Error(`Unknown run configuration: ${key}`);
        const canonicalName = { reasoningEffort: 'Effort', agentHarness: 'Harness' }[key];
        const field = definitionsByName.get(canonicalName?.toLowerCase()) ?? definitionsByName.get(specification.name.toLowerCase());
        if (!field || field.type !== specification.type && !(key === 'agentHarness' && field.type === 'enum')) throw new Error(`Register a ${specification.type} score field named ${specification.name}`);
        if (field.type === 'enum') {
            const options = field.options.filter(option => option.label.toLowerCase() === value.toLowerCase());
            if (options.length !== 1) throw new Error(`Register an unambiguous ${specification.name} option: ${value}`);
            assignments.push({ fieldID: field.ID, value: options[0].ID });
        } else assignments.push({ fieldID: field.ID, value });
    }
    return normalizeScoreFields(assignments, definitions);
}

export function mergeRunConfigurationFields(existing, inferred, definitions) {
    const normalized = normalizeScoreFields(existing, definitions);
    const result = new Map(normalized.map(assignment => [assignment.fieldID, assignment]));
    for (const assignment of inferred) {
        const previous = result.get(assignment.fieldID);
        const field = definitions.find(definition => definition.ID === assignment.fieldID);
        const equal = previous && field?.type === 'number'
            ? canonicalNumber(previous?.value) === canonicalNumber(assignment.value)
            : previous?.value === assignment.value;
        if (previous && !equal) throw new Error(`Model-name configuration conflicts with score field ${field.name}`);
        result.set(assignment.fieldID, assignment);
    }
    return [...result.values()].sort((left, right) => left.fieldID - right.fieldID);
}

export function resolveModelRunMappings(mappings, definitions) {
    const bySource = new Map();
    for (const mapping of mappings) {
        if (!Number.isSafeInteger(mapping.fromID) || mapping.fromID < 1
            || !Number.isSafeInteger(mapping.toID) || mapping.toID < 1 || bySource.has(mapping.fromID)) {
            throw new Error('Invalid or duplicate model identity mapping');
        }
        bySource.set(mapping.fromID, mapping);
    }
    return mappings.map(mapping => {
        let current = mapping;
        let fields = [];
        const visited = new Set();
        while (true) {
            if (visited.has(current.fromID)) throw new Error(`Cyclic model identity mapping: ${mapping.fromID}`);
            visited.add(current.fromID);
            fields = mergeRunConfigurationFields(fields, current.fields, definitions);
            const next = bySource.get(current.toID);
            if (current.fromID === current.toID || !next) {
                return { ...mapping, toID: current.toID, baseName: current.baseName, fields };
            }
            current = next;
        }
    });
}
