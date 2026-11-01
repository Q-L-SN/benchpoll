export const SITE_DESCRIPTION = 'Compare AI models with community-weighted benchmarks. Explore public AI indices by topic and scene, inspect the evidence, and build your own index.';

export function topicSearchMetadata(topic, sceneID = null) {
    const scene = (topic.scenes ?? []).find(item => Number(item.ID) === Number(sceneID))
        ?? (sceneID == null ? topic.scenes?.find(item => item.isDefault) : null);
    const name = scene ? `${topic.name}: ${scene.name}` : topic.name;
    const path = scene && !scene.isDefault ? `${topic.url}?scene=${scene.ID}` : topic.url;
    return { title: `${name} AI Index | BenchPoll`, name,
        description: `${scene?.description || topic.description} Compare AI models using public evaluation weights, scores and coverage.`,
        path, scene };
}

export function updateTopicSearchMetadata(topic, sceneID = null, root = document) {
    if (topic.isPrivate) {
        root.title = `${topic.name} - Private AI Index | BenchPoll`;
        root.querySelector('#bp-search-structured-data')?.remove();
        root.querySelector('link[rel="canonical"]')?.remove();
        return;
    }
    const metadata = topicSearchMetadata(topic, sceneID);
    root.title = metadata.title;
    for (const [selector, value] of [
        ['meta[name="description"]', metadata.description], ['meta[property="og:title"]', metadata.title],
        ['meta[property="og:description"]', metadata.description], ['meta[name="twitter:title"]', metadata.title],
        ['meta[name="twitter:description"]', metadata.description]
    ]) root.querySelector(selector)?.setAttribute('content', value);
    const canonical = root.querySelector('link[rel="canonical"]');
    if (canonical) {
        const url = new URL(metadata.path, canonical.href).href;
        canonical.href = url;
        root.querySelector('meta[property="og:url"]')?.setAttribute('content', url);
        // Interactive filters and personal weights can replace the public server snapshot.
        const structured = root.querySelector('#bp-search-structured-data');
        if (structured) {
            const data = JSON.parse(structured.textContent);
            const page = data['@graph']?.find(item => item['@id']?.endsWith('#page'));
            if (page) {
                if (page.url !== url) {
                    data['@graph'] = data['@graph'].filter(item => item['@type'] !== 'BreadcrumbList');
                    delete page.breadcrumb;
                }
                page['@id'] = url + '#page'; page.url = url; page.name = metadata.title;
                page.description = metadata.description; delete page.mainEntity;
                data['@graph'] = data['@graph'].filter(item => item['@type'] !== 'ItemList');
                structured.textContent = JSON.stringify(data);
            }
        }
    }
}
