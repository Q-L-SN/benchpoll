import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const allocatedIDs = { work: 231, training: 232, driving: 233, forecast: 234,
    investing: 236, culture: 237, support: 238 };
const sourceIDs = { intelligence: 54, work: 231, software: 180, office: 196, diagnosis: 197,
    law: 198, security: 199, training: 232, teaching: 216, service: 207, engineering: 195,
    business: 202, research: 167, mathematics: 168, physics: 169, chemistry: 174, biology: 170,
    execution: 175, computer: 176, mobile: 177, robotics: 178, driving: 233, industrial: 179,
    forecast: 234, investing: 236, planning: 184, collaboration: 204, human: 205, multi_agent: 206,
    learning: 208, retrieval: 209, culture: 237, hallucination: 182, long_context: 215,
    multimodal: 210, image_understanding: 211, video_understanding: 212, audio_understanding: 213,
    live_understanding: 214, creation: 186, audiovisual: 189, image: 172, video: 173, audio: 190,
    '3d': 191, interfaces: 192, communication: 193, clarity: 217, emotional: 194, support: 238,
    language_writing: 218, writing: 187, language: 219, agi: 166 };
const flatNames = new Map([[172, 'Image Generation'], [173, 'Video Generation'], [190, 'Audio Generation'],
    [211, 'Image Understanding'], [212, 'Video Understanding'], [213, 'Audio Understanding']]);
const retained = [
    ['intelligence', 'Intelligence'], ['software', 'Coding'], ['office', 'Office Documents & Data Processing'],
    ['diagnosis', 'Medical Diagnosis'], ['law', 'Law'], ['security', 'Cybersecurity & Cryptography'],
    ['training', 'RSI'], ['teaching', 'Teaching'], ['work', 'Computer Work'], ['business', 'Management'],
    ['research', 'Academic Research'], ['computer', 'Computer Use'], ['robotics', 'Robot Operation'],
    ['forecast', 'Foresight'], ['planning', 'Planning'], ['collaboration', 'Collaboration'],
    ['learning', 'Self-Learning'], ['retrieval', 'Knowledge & Retrieval'], ['hallucination', 'Low Hallucination'],
    ['long_context', 'Memory & Long Context'], ['multimodal', 'Multimodal Understanding'],
    ['image', 'Image Generation'], ['video', 'Video Generation'], ['audio', 'Audio Generation'],
    ['3d', '3D Generation'], ['interfaces', 'Interface Generation'], ['communication', 'Communication & EQ'],
    ['writing', 'Writing'], ['language', 'Language'], ['agi', 'AGI']
];
const merged = { mathematics: 'research', physics: 'research', chemistry: 'research', biology: 'research',
    mobile: 'computer', service: 'work', engineering: 'work', investing: 'forecast',
    human: 'collaboration', multi_agent: 'collaboration', culture: 'retrieval',
    image_understanding: 'multimodal', video_understanding: 'multimodal', audio_understanding: 'multimodal',
    live_understanding: 'multimodal', clarity: 'communication', emotional: 'communication', support: 'communication' };

export function buildTopicTaxonomy(previous) {
    const byKey = new Map(previous.categories.map(row => [row.key, row]));
    if (previous.categories.length !== 54 || byKey.size !== 54 || previous.version !== '20261015-management-memory'
        || previous.categories.some(row => !Object.hasOwn(sourceIDs, row.key)
            || (row.existingID ?? allocatedIDs[row.key]) !== sourceIDs[row.key])) throw new Error('Unexpected source taxonomy');
    const ID = key => byKey.get(key)?.existingID ?? allocatedIDs[key];
    const existingName = key => flatNames.get(ID(key)) ?? byKey.get(key)?.name;
    const keys = new Set(retained.map(([key]) => key));
    const categories = retained.map(([key, name], index) => {
        if (!Number.isSafeInteger(ID(key)) || !existingName(key)) throw new Error('Missing official topic: ' + key);
        return { key, ID: ID(key), name, previousName: existingName(key), position: (index + 1) * 10 };
    });
    const retiredCategories = previous.categories.filter(row => !keys.has(row.key)).map(row => ({
        ID: ID(row.key), name: existingName(row.key), targetID: merged[row.key] ? ID(merged[row.key]) : null,
        ...(row.key === 'live_understanding' ? { contextDefaults: { realtime: 'yes' } } : {})
    }));
    const dimensions = { multimodal: [structuredClone(previous.dimensions.image[0])] };
    for (const key of ['image', 'video', 'audio', '3d', 'interfaces', 'language']) {
        dimensions[key] = structuredClone(previous.dimensions[key]);
    }
    return { version: '20261026-flat-official-topics', featuredTopicID: 54,
        neutralOption: structuredClone(previous.neutralOption), categories, retiredCategories, dimensions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const previous = JSON.parse(readFileSync(new URL('../ops/task-taxonomy-20261015.json', import.meta.url), 'utf8'));
    const specification = buildTopicTaxonomy(previous);
    writeFileSync(new URL('../ops/topic-taxonomy-20261026.json', import.meta.url), JSON.stringify(specification, null, 2) + '\n');
    console.log(JSON.stringify({ topics: specification.categories.length,
        retiredTopics: specification.retiredCategories.length, dimensionTopics: Object.keys(specification.dimensions).length }));
}
