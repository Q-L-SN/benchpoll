import { createSearchIndex, searchText } from '../shared/search.js';
import { sceneSummary, scenePath } from '../shared/topics.js';

export function orderedScenes(scenes = []) {
    return [...scenes].sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true));
}

export function searchTopicGroups(topics, query) {
    const groups = topics.map(topic => ({ topic, allScenes: orderedScenes(topic.scenes) }));
    if (!searchText(query)) return groups.map(({ topic }) => ({ topic, topicMatch: true, scenes: [] }));
    const documents = groups.flatMap(({ topic, allScenes }) => {
        const name = topic.name ?? topic.categoryName ?? '';
        const fields = [name, topic.description, topic.creator?.name];
        return [{ topic, scene: null, fields }, ...allScenes.flatMap(scene => {
            const summary = searchText(scene.description);
            // Inherited summaries and generated "Topic: Scene" prefixes are not scene matches.
            const description = summary === searchText(topic.description) ? ''
                : ` ${summary} `.replaceAll(` ${searchText(name)} `, ' ').trim();
            const ownFields = [scene.name, description];
            return [{ topic, scene, own: true, fields: ownFields },
                { topic, scene, own: false, fields: [...ownFields, ...fields] }];
        })];
    });
    const matches = createSearchIndex(documents, document => document.fields).search(query);
    const topicMatches = new Set(matches.filter(match => !match.scene).map(match => match.topic));
    const sceneMatches = new Set(matches.filter(match => match.scene && (match.own || !topicMatches.has(match.topic)))
        .map(match => match.scene));
    const orderedTopics = [...new Set(matches.map(match => match.topic))];
    return orderedTopics.map(topic => ({ topic, topicMatch: topicMatches.has(topic),
        scenes: orderedScenes(topic.scenes).filter(scene => sceneMatches.has(scene)) }))
        .filter(group => group.topicMatch || group.scenes.length);
}

export const sceneURL = scenePath;

export function matchingScenes(topic, query) {
    const text = String(query).trim().toLocaleLowerCase();
    return orderedScenes(topic.scenes).filter(scene => !text
        || `${scene.name} ${scene.description ?? ''}`.toLocaleLowerCase().includes(text));
}

export function sceneNavigationEntries(topics) {
    return topics.flatMap(topic => [{ ...topic, contextValues: {}, sceneID: null }, ...orderedScenes(topic.scenes).map(scene => ({
        ...topic,
        contextID: Number(scene.ID),
        sceneID: Number(scene.ID),
        sceneName: scene.name,
        contextValues: { scene: String(scene.ID) },
        contextLabel: scene.name,
        description: sceneSummary(topic, scene),
        url: scene.url || sceneURL(topic.url, scene),
        isScene: true
    }))]);
}
