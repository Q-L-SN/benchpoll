import { SITE_TITLE, SITE_TAGLINE, SITE_DESCRIPTION, SITE_SOCIAL_IMAGE, topicSearchMetadata } from './public/js/shared/search-metadata.js';
import { FEATURED_TOPIC_ID, sceneSummary, topicSlug } from './public/js/shared/topics.js';

export const PUBLIC_DOCUMENTS = Object.freeze([
    { path: '/', title: SITE_TITLE, description: SITE_DESCRIPTION, type: 'CollectionPage' },
    { path: '/how-it-works', title: 'How BenchPoll Works - Weights, Scores and Fallback', description: 'Understand BenchPoll public and personal AI indices, topic references, measured coverage, missing-score estimation and community fallback.' },
    { path: '/terms', title: 'Terms of Use | BenchPoll', description: 'Terms for BenchPoll accounts, evaluation contributions, public and private topics, AI indices and discussions.', modified: '2026-11-04' },
    { path: '/privacy', title: 'Privacy Policy | BenchPoll', description: 'How BenchPoll handles account information, private topics, contributions and privacy requests.', modified: '2026-11-04' },
    { path: '/cookies', title: 'Cookie and Local Storage Policy | BenchPoll', description: 'Cookies, local storage, session preferences and your choices on BenchPoll.', modified: '2026-11-04' },
    { path: '/community-guidelines', title: 'Contribution and Community Rules | BenchPoll', description: 'Evidence, sources, discussions, moderation and participation rules for BenchPoll.', modified: '2026-11-04' }
]);

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const jsonData = value => JSON.stringify(value).replace(/</g, '\\u003c');
const absolute = (path, origin) => new URL(path, origin).href;
const publicTopics = topics => topics.filter(topic => topic.isPrivate === false);
const comparableModels = snapshot => (snapshot?.models ?? []).filter(model => model.comparable !== false && Number.isFinite(model.lower));
const error = (status, code) => Object.assign(new Error(code), { status, body: { error: code } });

export function replaceSearchSlot(html, name, value) {
    const start = `<!--bp:${name}-->`, end = `<!--/bp:${name}-->`;
    const from = html.indexOf(start), to = html.indexOf(end, from);
    if (from < 0 || to < from) throw new Error(`Missing search presentation slot: ${name}`);
    return html.slice(0, from + start.length) + value + html.slice(to);
}

export function searchHead(metadata, origin, { items = [], breadcrumbs = [] } = {}) {
    const url = absolute(metadata.path, origin), image = origin + SITE_SOCIAL_IMAGE;
    const page = { '@type': metadata.type || 'WebPage', '@id': url + '#page', url,
        name: metadata.title, description: metadata.description, inLanguage: 'en',
        isPartOf: { '@id': origin + '/#website' }, publisher: { '@id': origin + '/#publisher' },
        ...(metadata.modified ? { dateModified: metadata.modified } : {}) };
    const graph = [
        { '@type': 'Organization', '@id': origin + '/#publisher', name: 'BenchPoll', url: origin + '/',
            slogan: SITE_TAGLINE, logo: origin + '/assets/benchpoll-logo.svg', sameAs: ['https://x.com/BenchPoll'] },
        { '@type': 'WebSite', '@id': origin + '/#website', name: 'BenchPoll', url: origin + '/',
            description: SITE_DESCRIPTION, inLanguage: 'en', publisher: { '@id': origin + '/#publisher' } }, page
    ];
    if (items.length) {
        page.mainEntity = { '@id': url + '#items' };
        graph.push({ '@type': 'ItemList', '@id': url + '#items', name: metadata.name || metadata.title,
            itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1,
                name: item.name, ...(item.url ? { url: absolute(item.url, origin) } : {}) })) });
    }
    if (breadcrumbs.length) {
        page.breadcrumb = { '@id': url + '#breadcrumbs' };
        graph.push({ '@type': 'BreadcrumbList', '@id': url + '#breadcrumbs', itemListElement: breadcrumbs.map((item, index) => ({
            '@type': 'ListItem', position: index + 1, name: item.name, item: absolute(item.path, origin)
        })) });
    }
    const meta = (key, value, attribute = 'name') => `<meta ${attribute}="${key}" content="${escapeHTML(value)}">`;
    return `\n<title>${escapeHTML(metadata.title)}</title>\n${meta('description', metadata.description)}
<link rel="canonical" href="${escapeHTML(url)}">
${meta('robots', 'index, follow, max-image-preview:large')}
${meta('og:type', 'website', 'property')}${meta('og:site_name', 'BenchPoll', 'property')}
${meta('og:title', metadata.title, 'property')}${meta('og:description', metadata.description, 'property')}
${meta('og:url', url, 'property')}${meta('og:image', image, 'property')}
${meta('og:image:width', '1200', 'property')}${meta('og:image:height', '630', 'property')}
${meta('og:image:alt', `BenchPoll - ${SITE_TAGLINE}`, 'property')}
${meta('twitter:card', 'summary_large_image')}${meta('twitter:site', '@BenchPoll')}
${meta('twitter:title', metadata.title)}${meta('twitter:description', metadata.description)}${meta('twitter:image', image)}
${meta('twitter:image:alt', `BenchPoll - ${SITE_TAGLINE}`)}
<script id="bp-search-structured-data" type="application/ld+json">${jsonData({ '@context': 'https://schema.org', '@graph': graph })}</script>\n`;
}

export function selectSearchScene(topic, params, slug = null) {
    if (params.has('scene') || params.has('context_scene')) throw error(404, 'topic_scene_not_found');
    if (slug === null) return topic.scenes?.find(scene => scene.isDefault) ?? null;
    const scene = topic.scenes?.find(scene => (scene.slug || topicSlug(scene.name)) === slug);
    if (!scene) throw error(404, 'topic_scene_not_found');
    return scene;
}

export function renderTopicDirectory(topics) {
    return publicTopics(topics).map(topic => `<article class="th-card th-server-card${topic.ID === FEATURED_TOPIC_ID ? ' is-featured' : ''}">
<header class="th-card-header"><div class="th-card-identity"><h3 class="th-card-title"><a class="th-topic-link" href="${escapeHTML(topic.url)}"><span class="th-topic-name">${escapeHTML(topic.name)}</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></a></h3></div><p class="th-topic-summary">${escapeHTML(topic.description)}</p></header>
<div class="th-visual"><a class="th-server-index-link" href="${escapeHTML(topic.url)}">Public AI Index <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a></div>
${topic.scenes?.length ? `<details class="bp-server-scenes"><summary>Scenes (${topic.scenes.length})</summary><ul>${topic.scenes.map(scene => `<li><a href="${escapeHTML(topicSearchMetadata(topic, scene.ID).path)}">${escapeHTML(scene.name)}</a></li>`).join('')}</ul></details>` : ''}</article>`).join('');
}

export function renderPublicSnapshot(snapshot) {
    if (!snapshot) return { models: '', weights: '' };
    const rows = comparableModels(snapshot);
    const number = value => new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(value);
    const models = `<div class="bp-search-snapshot"><p>Public AI Index &middot; Estimated score &middot; Best qualifying result per model</p>
<table><thead><tr><th scope="col">Model</th><th scope="col">Estimated score</th><th scope="col">Measured coverage</th></tr></thead><tbody>${rows.map(model => `<tr><th scope="row">${escapeHTML(model.modelName || model.name)}</th><td>${number(model.lower)}</td><td>${Number.isFinite(model.coverage) ? number(model.coverage) + '%' : 'Unavailable'}</td></tr>`).join('')}</tbody></table>
<p><a href="/how-it-works#rankings">Score and coverage methodology</a></p></div>`;
    const weights = `<div class="bp-search-snapshot"><p>Public index composition</p><table><thead><tr><th scope="col">Evaluation item</th><th scope="col">Weight</th></tr></thead><tbody>${snapshot.weights.map(item => `<tr><th scope="row">${escapeHTML(item.name)}${item.conditionName ? `<small>${escapeHTML(item.conditionName)}</small>` : ''}</th><td>${number(item.weightBasisPoints / 100)}%</td></tr>`).join('')}</tbody></table></div>`;
    return { models, weights };
}

export function renderPublicTopic(html, topic, scene, snapshot, origin) {
    if (topic.isPrivate !== false) throw new Error('Only public topics can receive search presentation');
    const metadata = topicSearchMetadata(topic, scene?.ID), content = renderPublicSnapshot(snapshot);
    html = replaceSearchSlot(html, 'metadata', searchHead(metadata, origin, { breadcrumbs: [
        { name: 'BenchPoll', path: '/' }, { name: topic.name, path: topic.url },
        ...(scene ? [{ name: scene.name, path: metadata.path }] : [])
    ], items: comparableModels(snapshot).map(item => ({ name: item.modelName || item.name })) }));
    html = replaceSearchSlot(html, 'topic-identity', `<nav id="bp-breadcrumb" class="bp-breadcrumb" aria-label="Breadcrumb"><span class="bp-breadcrumb-current">${escapeHTML(metadata.name)}</span></nav><p id="workspace-topic-summary" class="bp-workspace-topic-summary">${escapeHTML(sceneSummary(topic, scene))}</p>`);
    html = replaceSearchSlot(html, 'scenes', `<section id="bp-template-strip" class="bp-scene-strip" aria-label="Topic scenes"${topic.scenes.length ? '' : ' hidden'}><nav class="bp-scene-tabs" aria-label="Scenes">${topic.scenes.map(item => `<a class="bp-scene-tab" href="${escapeHTML(topicSearchMetadata(topic, item.ID).path)}"${item.ID === scene?.ID ? ' aria-current="page"' : ''}>${escapeHTML(item.name)}</a>`).join('')}</nav></section>`);
    html = replaceSearchSlot(html, 'model-rows', content.models);
    return replaceSearchSlot(html, 'evaluation-rows', content.weights);
}

export function discoveryRobots(origin) {
    return `User-agent: *
Allow: /
Disallow: /api/
Disallow: /account/
Disallow: /personal/
Disallow: /contribute
Disallow: /github_login
Disallow: /github_callback
Disallow: /login
Disallow: /sign-in
Disallow: /topic-proposals
Disallow: /censor
Disallow: /adminlogin
Disallow: /dialogPage

Sitemap: ${origin}/sitemap.xml
`;
}

export function discoverySitemap(topics, origin) {
    const entries = [...PUBLIC_DOCUMENTS, ...publicTopics(topics).flatMap(topic => topic.scenes?.length
        ? topic.scenes.map(scene => ({ path: topicSearchMetadata(topic, scene.ID).path })) : [{ path: topic.url }])];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(item => `<url><loc>${escapeHTML(absolute(item.path, origin))}</loc>${item.modified ? `<lastmod>${item.modified}</lastmod>` : ''}</url>`).join('')}</urlset>`;
}

export function discoveryText(topics, origin) {
    const link = (label, path) => `[${String(label).replace(/[\[\]\\]/g, '\\$&')}](${absolute(path, origin)})`;
    return `# BenchPoll

> ${SITE_TAGLINE}

BenchPoll is a community-weighted AI model ranking platform. Participants choose benchmark and topic weights to define what matters in an AI index. Explore public rankings by topic and scene, inspect the evidence, or build a personal index.

Benchmark evidence supplies measured results; public or personal weights determine their importance. Estimated scores combine available results with estimates and a coverage adjustment. Coverage counts measured results, including successful fallbacks. Score range holds measurements fixed and fills missing scores with 0 at the lower end and 100 at the upper end. Topic references expand into benchmark weights before scores are calculated. Scores depend on the selected topic, scene, weights and comparison settings.

## Methodology and evidence
- ${link('How BenchPoll works', '/how-it-works')}
- ${link('Scores, estimates and measured coverage', '/how-it-works#rankings')}
- ${link('Community fallback', '/how-it-works#fallback')}
- ${link('Topic references', '/how-it-works#references')}
- ${link('Contribution and source rules', '/community-guidelines')}
- ${link('Sitemap', '/sitemap.xml')}

## Public topics
${publicTopics(topics).map(topic => `- ${link(topic.name, topic.url)}: ${topic.description}\n${(topic.scenes ?? []).map(scene => `  - ${link(scene.name, topicSearchMetadata(topic, scene.ID).path)}`).join('\n')}`).join('\n')}

## Policies
- ${link('Terms of Use', '/terms')}
- ${link('Privacy Policy', '/privacy')}
- ${link('Cookie Policy', '/cookies')}
`;
}

export function createSearchPresentation({ origin, loadTopics, loadPreview, now = () => Date.now(), snapshotWaitMs = 1500 }) {
    if (new URL(origin).origin !== origin || !/^https?:\/\//.test(origin)) throw new Error('Search origin must be an HTTP(S) origin');
    let catalogue = null;
    const previewJobs = new Map();
    async function topics() {
        if (!catalogue || catalogue.expires <= now()) {
            const current = { expires: now() + 60000, promise: null };
            current.promise = Promise.resolve().then(loadTopics).then(result => publicTopics(result.topics))
                .catch(cause => { if (catalogue === current) catalogue = null; throw cause; });
            catalogue = current;
        }
        return catalogue.promise;
    }
    async function snapshot(topic, scene) {
        if (topic.isPrivate !== false || !loadPreview || !topic.hasWeights) return null;
        const key = `${topic.ID}:${scene?.ID ?? ''}`;
        let job = previewJobs.get(key);
        if (!job) {
            // Bound crawler-triggered work; duplicate requests share the same public preview.
            if (previewJobs.size >= 2) return null;
            job = Promise.resolve().then(() => loadPreview({ categoryID: topic.ID, sceneID: scene?.ID ?? null,
                scoreMode: 'available', reasoning: false, harness: false })).catch(() => null)
                .finally(() => previewJobs.delete(key));
            previewJobs.set(key, job);
        }
        let timer;
        try {
            return await Promise.race([
                job,
                new Promise(resolve => { timer = setTimeout(() => resolve(null), snapshotWaitMs); })
            ]);
        } finally { clearTimeout(timer); }
    }
    return {
        topics, snapshot, invalidate() { catalogue = null; },
        middleware(req, res, next) {
            if (!['GET', 'HEAD'].includes(req.method)) return next();
            const path = req.path.toLowerCase();
            if (!['/robots.txt', '/sitemap.xml', '/llms.txt'].includes(path)) return next();
            res.set('Cache-Control', 'public, max-age=60');
            if (path === '/robots.txt') return res.type('text/plain').send(discoveryRobots(origin));
            req.errorFrom = 'page';
            return topics().then(rows => res.type(path === '/sitemap.xml' ? 'application/xml' : 'text/plain')
                .send(path === '/sitemap.xml' ? discoverySitemap(rows, origin) : discoveryText(rows, origin)))
                .catch(cause => { res.set('Cache-Control', 'no-store'); next(cause); });
        }
    };
}

export function searchIndexingHeaders(req, res, next) {
    if (/^\/(?:api(?:\/|$)|personal(?:\/|$)|account(?:\/|$)|contribute(?:\/|$)|github_login(?:\/|$)|github_callback(?:\/|$)|login(?:\/|$)|sign-in(?:\/|$)|topic-proposals(?:\/|$)|censor(?:\/|$)|adminlogin(?:\/|$)|dialogpage(?:\/|$))/i.test(req.path)) {
        res.set('X-Robots-Tag', 'noindex, nofollow, nosnippet');
    }
    next();
}
