export const ORGANIZATION_LOGOS = Object.freeze({
    openai: 'openai.svg', anthropic: 'anthropic.svg', google: 'google.svg', meta: 'meta.svg',
    mistral: 'mistral.svg', amazon: 'amazon.svg', cohere: 'cohere.svg', qwen: 'qwen.svg',
    microsoft: 'microsoft.svg', xai: 'xai.svg', deepseek: 'deepseek.svg', zhipu: 'zhipu.svg',
    zai: 'zai.svg', alibaba: 'alibaba.svg', bytedance: 'bytedance.svg', nvidia: 'nvidia.svg',
    tencent: 'tencent.svg', 'black-forest-labs': 'black-forest-labs.svg', moonshot: 'moonshot.svg',
    minimax: 'minimax.svg', recraft: 'recraft.svg', stepfun: 'stepfun.svg', ibm: 'ibm.svg',
    kling: 'kling.svg', stability: 'stability.svg', allenai: 'allenai.svg', ideogram: 'ideogram.svg',
    voyage: 'voyage.svg', luma: 'luma.svg', reve: 'reve.svg', baidu: 'baidu.svg', xiaomi: 'xiaomi.svg',
    krea: 'krea.svg', perplexity: 'perplexity.svg', internlm: 'internlm.svg', runway: 'runway.svg',
    sakana: 'sakana.svg', bria: 'bria.svg', meituan: 'meituan.svg', poolside: 'poolside.svg',
    baai: 'baai.svg', elevenlabs: 'elevenlabs.svg', 'fish-audio': 'fish-audio.svg',
    inception: 'inception.svg', midjourney: 'midjourney.svg', 'nous-research': 'nous-research.svg',
    upstage: 'upstage.svg', 'ant-group': 'ant-group.svg', jina: 'jina.svg', liquid: 'liquid.svg',
    morph: 'morph.svg', perceptron: 'perceptron.svg', pruna: 'pruna.svg', arcee: 'arcee.svg',
    cursor: 'cursor.svg', 'dots-studio': 'dots-studio.svg', fireworks: 'fireworks.svg', pika: 'pika.svg',
    reka: 'reka.svg', relace: 'relace.svg', together: 'together.svg', vidu: 'vidu.svg',
    lighton: 'lighton.webp', inclusionai: 'inclusionai.webp', 'h-company': 'h-company.webp',
    infly: 'infly.webp', vidore: 'vidore-vidore.webp', 'sentence-transformers': 'sentence-transformers.webp',
    'kingsware-vocaela-ai': 'kingsware-vocaela-ai.webp', 'osu-nlp-group-orby-ai': 'osu-nlp-group-orby-ai.webp',
    salesforce: 'salesforce.svg', 'jared-palmer': 'jared-palmer.webp', hidream: 'hidream.webp',
    opengvlab: 'opengvlab.webp',
    mixedbread: 'mixedbread.webp', genmo: 'genmo.webp', kandinsky: 'kandinsky.webp', showlab: 'showlab.png',
    'intelligence-indeed': 'intelligence-indeed.png', 'nex-agi': 'nex-agi.jpg', kuaishou: 'kuaishou.svg',
    deepgram: 'deepgram.svg',
    'thinking-machines': 'thinking-machines.png', cognition: 'cognition.svg', cartesia: 'cartesia.svg',
    inworld: 'inworld-ai.png', prismml: 'prismml.png', writer: 'writer.png', respan: 'respan.png',
    unbiased: 'unbiased.svg', typesafe: 'typesafe-ai.png', diffbot: 'diffbot.svg', 'huzzle-labs': 'huzzle-labs.png',
    'playground-ai': 'playground-ai.webp', thedrummer: 'thedrummer.webp', wan: 'wan.webp', imagineart: 'imagineart.png'
});

const aliases = {
    google: ['google-alt', 'Google DeepMind'], mistral: ['Mistral AI'],
    amazon: ['Amazon AWS', 'Amazon Web Services'], qwen: ['Alibaba Qwen'],
    microsoft: ['microsoft-ai'], zhipu: ['Zhipu AI', '\u667a\u8c31', '\u667a\u8c31AI'],
    zai: ['Z AI', 'Z.AI'], 'black-forest-labs': ['BFL'], moonshot: ['moonshot-ai', 'Moonshot AI'],
    recraft: ['recraft-ai'], kling: ['klingai', 'Kling AI'], stability: ['stability-ai', 'Stability AI'],
    allenai: ['AI2', 'Allen Institute for AI'], voyage: ['voyage-ai'], luma: ['luma-labs'],
    perplexity: ['perplexity-ai'], internlm: ['shanghai-ai-lab', 'Shanghai AI Lab'],
    sakana: ['Sakana AI'], bria: ['Bria AI'], inception: ['inception-labs'], jina: ['jina-ai'],
    liquid: ['liquidai', 'Liquid AI'], perceptron: ['perceptron-inc', 'Perceptron Inc.'],
    pruna: ['pruna-ai'], arcee: ['arcee-ai'], fireworks: ['fireworks-ai'], reka: ['reka-ai'],
    together: ['together-ai'], vidore: ['vidore-vidore', 'ViDoRe (vidore)'],
    inworld: ['inworld-ai'], typesafe: ['typesafe-ai'],
    vidu: ['Shengshu', 'Shengshu Technology']
};
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s._-]+/g, '');
const keys = new Map(Object.keys(ORGANIZATION_LOGOS).flatMap(key => [key, ...(aliases[key] ?? [])]
    .map(alias => [normalize(alias), key])));

export function organizationLogo(organization) {
    const candidates = typeof organization === 'string' ? [organization]
        : [organization?.logoKey, organization?.vendorLogoKey, organization?.vendorSlug,
            organization?.slug, organization?.vendorName, organization?.vendor, organization?.name];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const key = keys.get(normalize(candidate));
        if (key) return { key, url: `/assets/vendors/${ORGANIZATION_LOGOS[key]}?v=organization-logos-20261006` };
    }
    return null;
}

export function createOrganizationMark(organization, className) {
    const mark = document.createElement('span');
    mark.className = className;
    mark.setAttribute('aria-hidden', 'true');
    const name = typeof organization === 'string' ? organization
        : organization?.vendorName || organization?.vendor || organization?.name || organization?.vendorSlug || organization?.slug || '';
    if (typeof name === 'string' && name) mark.dataset.tooltip = name;
    const logo = organizationLogo(organization);
    if (logo) {
        mark.dataset.organization = logo.key;
        const image = document.createElement('img');
        image.src = logo.url; image.alt = ''; image.width = image.height = 20;
        image.draggable = false;
        image.style.colorScheme = 'light';
        mark.append(image);
    } else {
        mark.classList.add('fallback');
        mark.textContent = Array.from(String(name).trim())[0]?.toUpperCase() || '?';
    }
    return mark;
}
