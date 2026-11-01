import { readFile } from 'node:fs/promises';
import { startTopicsPreview } from './topics-home-fixtures.mjs';
import { topicSlug } from '../../public/js/shared/topics.js';

const spec = JSON.parse(await readFile(new URL('../../ops/topic-scenes-taxonomy-20261031.json', import.meta.url), 'utf8'));
const app = await startTopicsPreview({ port: Number(process.argv[2] || 4177), authenticated: false });
app.state.topics = spec.topics.map((topic, index) => {
    const ID = topic.ID ?? 10000 + index, slug = topicSlug(topic.name);
    const scenes = topic.scenes.map((scene, position) => ({
        ID: ID * 1000 + position + 1, name: scene.name, description: `${topic.name}: ${scene.name}.`,
        isDefault: position === 0, url: `/${slug}?scene=${ID * 1000 + position + 1}`
    }));
    return { ...topic, ID, slug, url: `/${slug}`, scenes, creator: null,
        isPrivate: false, isMine: false, configured: false, hasWeights: true };
});
console.log(`Topic/scene search preview with sample scores: ${app.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
