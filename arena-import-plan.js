import { createHash } from 'node:crypto';

const textCategories = {
    overall: 'Overall', coding: 'Coding', creative_writing: 'Creative Writing',
    english: 'English', exclude_ties: 'Exclude Ties', expert: 'Expert',
    hard_prompts: 'Hard Prompts', hard_prompts_english: 'Hard Prompts (English)',
    instruction_following: 'Instruction Following', chinese: 'Chinese',
    french: 'French', german: 'German', japanese: 'Japanese', korean: 'Korean',
    polish: 'Polish', russian: 'Russian', spanish: 'Spanish',
    longer_query: 'Longer Query', math: 'Math', multi_turn: 'Multi-Turn',
    non_english: 'Non-English',
    industry_business_and_management_and_financial_operations: 'Business, Management, & Financial Ops',
    industry_entertainment_and_sports_and_media: 'Entertainment, Sports, & Media',
    industry_legal_and_government: 'Legal & Government',
    industry_life_and_physical_and_social_science: 'Life, Physical, & Social Science',
    industry_mathematical: 'Mathematical',
    industry_medicine_and_healthcare: 'Medicine & Healthcare',
    industry_software_and_it_services: 'Software & IT Services',
    industry_writing_and_literature_and_language: 'Writing, Literature, & Language'
};

const visionCategories = {
    overall: 'Overall', captioning: 'Captioning', chinese: 'Chinese',
    creative_writing: 'Creative Writing', creative_writing_vision: 'Creative Writing (Vision)',
    diagram: 'Diagram', english: 'English', entity_recognition: 'Entity Recognition',
    homework: 'Homework', humor: 'Humor', ocr: 'OCR'
};

const imageCategories = {
    overall: 'Overall', '3d_modeling': '3D Imaging & Modeling', art: 'Art',
    cartoon: 'Cartoon, Anime & Fantasy', chinese: 'Chinese', english: 'English',
    commercial_design: 'Product, Branding & Commercial Design',
    photorealistic: 'Photorealistic & Cinematic Imagery', portraits: 'Portraits',
    russian: 'Russian', text_rendering: 'Text Rendering'
};

const agentNames = {
    agent: 'Agent Arena (Overall)',
    agent_bash_recovery_steps: 'Agent Arena (Bash Recovery Steps)',
    agent_praise_complaint: 'Agent Arena (Praise and Complaint)',
    agent_steerability: 'Agent Arena (Steerability)',
    agent_task_outcome_explicit: 'Agent Arena (Explicit Task Outcome)',
    agent_tool_hallucination: 'Agent Arena (Tool Hallucination)'
};

const vendorAliases = {
    bfl: 'black-forest-labs', kling: 'klingai', moonshot: 'moonshot-ai',
    perplexity: 'perplexity-ai', recraft: 'recraft-ai', stability_ai: 'stability-ai',
    zai: 'z-ai', 'inception-ai': 'inception-labs', 'luma-ai': 'luma-labs'
};

export function arenaVendorSlug(organization) {
    if (!organization) return 'arena-unattributed';
    const normalized = organization.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return vendorAliases[normalized.replaceAll('-', '_')] || vendorAliases[normalized] || normalized;
}

export function arenaResultVendorSlug(organization, modelName) {
    if (organization.toLowerCase() === 'alibaba' && /^(qwen|qwq)/i.test(modelName)) return 'qwen';
    return arenaVendorSlug(organization);
}

export function arenaVendorName(organization) {
    if (!organization) return 'Arena (unattributed)';
    if (organization.toLowerCase() === 'alibaba') return 'Alibaba';
    if (organization.toLowerCase() === 'bfl') return 'Black Forest Labs';
    if (organization.toLowerCase() === 'zai') return 'Z AI';
    return organization.replace(/(^|[- ])([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`);
}

export function arenaCanonicalModelName(name) {
    return name.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '');
}

export function arenaModelKey(organization, name) {
    return `${arenaVendorSlug(organization)}:${arenaCanonicalModelName(name)}`;
}

export function arenaBenchmarkName(config, category) {
    if (agentNames[config]) return category === 'overall' ? agentNames[config] : null;
    if (config === 'document' || config === 'document_style_control') {
        return category === 'overall' ? 'Document Arena' : null;
    }
    if (config === 'search' || config === 'search_style_control') {
        return category === 'overall' ? 'Search Arena' : null;
    }
    if (config === 'search_factuality') return category === 'overall' ? 'Search Arena Factuality' : null;
    if (config === 'text' || config === 'text_style_control') {
        return textCategories[category] ? `Text Arena (${textCategories[category]})` : null;
    }
    if (config === 'text_factuality') {
        return textCategories[category] ? `Text Arena Factuality (${textCategories[category]})` : null;
    }
    if (config === 'vision' || config === 'vision_style_control') {
        return visionCategories[category] ? `Vision Arena (${visionCategories[category]})` : null;
    }
    if (config === 'text_to_image') {
        return imageCategories[category] ? `Text-to-Image Arena (${imageCategories[category]})` : null;
    }
    if (config === 'image_edit') {
        if (category === 'overall') return 'Image Edit Arena (Single; Overall)';
        if (category === 'multi_image_edit') return 'Image Edit Arena (Multi; Overall)';
    }
    const single = {
        image_to_video: 'Image-to-Video Arena', text_to_video: 'Text-to-Video Arena',
        video_edit: 'Video Edit Arena'
    };
    if (single[config]) return category === 'overall' ? single[config] : null;
    const webdev = {
        overall: 'Code Arena WebDev (Overall)',
        image_to_webdev: 'Code Arena Image-to-WebDev',
        'webdev-html': 'Code Arena WebDev (HTML)',
        'webdev-react': 'Code Arena WebDev (React)'
    };
    if (config === 'webdev') return webdev[category] || null;
    return null;
}

export function arenaCondition(config) {
    if (config.endsWith('_style_control')) return 'default';
    if (['text', 'vision', 'search', 'document'].includes(config)) return 'unadjusted';
    return 'default';
}

export function arenaTrackedIdentities(trackedRows, benchmarks, conditions) {
    const benchmarksByID = new Map(benchmarks.map(row => [Number(row.ID), row]));
    const conditionsByID = new Map(conditions.map(row => [Number(row.ID), row]));
    const benchmarkIDs = new Map();
    const conditionIDs = new Map();
    for (const row of trackedRows) {
        const name = arenaBenchmarkName(row.config, row.category);
        const benchmarkID = Number(row.benchmark_ID);
        const condition = conditionsByID.get(Number(row.benchmark_condition_ID));
        if (!name || !benchmarksByID.has(benchmarkID) || !condition || Number(condition.benchmark_ID) !== benchmarkID
            || condition.deleted_at !== null) throw new Error(`Invalid tracked Arena identity: ${row.config}/${row.category}`);
        if (benchmarkIDs.has(name) && benchmarkIDs.get(name) !== benchmarkID) {
            throw new Error(`Conflicting tracked Arena benchmark identity: ${name}`);
        }
        benchmarkIDs.set(name, benchmarkID);
        const key = `${benchmarkID}:${arenaCondition(row.config)}`;
        if (conditionIDs.has(key) && Number(conditionIDs.get(key).ID) !== Number(condition.ID)) {
            throw new Error(`Conflicting tracked Arena condition identity: ${key}`);
        }
        conditionIDs.set(key, condition);
    }
    return { benchmarkIDs, conditionIDs };
}

export function arenaScore(config, row) {
    const agent = config === 'agent' || config.startsWith('agent_');
    const value = agent ? row.score * 100 : row.rating;
    if (!Number.isFinite(value)) throw new Error(`Invalid ${config} score`);
    return Math.round(value * 1e6) / 1e6;
}

export function arenaRowKey(config, row) {
    return createHash('sha256').update(JSON.stringify([
        config, row.category, arenaModelKey(row.organization, row.model_name)
    ])).digest('hex');
}

export function arenaRowHash(row) {
    return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

export function buildArenaPlan(snapshot) {
    const entries = [];
    const skippedAliases = [];
    const conflicts = [];
    const names = new Set();
    const identities = new Map();
    for (const config of snapshot.configs) {
        if (config.config === 'webdev') {
            const overall = new Map();
            for (const row of config.rows.filter(item => item.category === 'overall')) {
                const key = arenaModelKey(row.organization, row.model_name);
                if (!overall.has(key)) overall.set(key, []);
                overall.get(key).push(row.rating);
            }
            for (const row of config.rows.filter(item => item.category === 'webdev')) {
                const available = overall.get(arenaModelKey(row.organization, row.model_name));
                const match = available?.indexOf(row.rating) ?? -1;
                if (match === -1) {
                    throw new Error('WebDev alias is no longer equivalent to Overall');
                }
                available.splice(match, 1);
                skippedAliases.push(row);
            }
        }
        for (const row of config.rows) {
            if (config.config === 'webdev' && row.category === 'webdev') continue;
            const benchmarkName = arenaBenchmarkName(config.config, row.category);
            if (!benchmarkName) throw new Error(`Unmapped Arena category ${config.config}/${row.category}`);
            const score = arenaScore(config.config, row);
            const key = arenaRowKey(config.config, row);
            if (!identities.has(key)) identities.set(key, []);
            identities.get(key).push({ config: config.config, row, benchmarkName, score, key });
            names.add(benchmarkName);
        }
    }
    for (const group of identities.values()) {
        if (group.length > 1) {
            conflicts.push(group.map(item => ({ config: item.config, category: item.row.category,
                model: item.row.model_name, score: item.score })));
        } else {
            entries.push(group[0]);
        }
    }
    return { entries, skippedAliases, conflicts, benchmarkNames: [...names].sort() };
}
