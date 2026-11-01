import { readFileSync, writeFileSync } from 'node:fs';
const previous = JSON.parse(readFileSync(new URL('../ops/task-taxonomy-20260930.json', import.meta.url), 'utf8'));
const nodes = [
    ['intelligence', null, 'Intelligence', 54],
    ['work', 'intelligence', 'Professional Work'],
    ['software', 'work', 'Software', 180],
    ['office', 'work', 'Office & Data', 196],
    ['diagnosis', 'work', 'Diagnosis', 197],
    ['law', 'work', 'Law', 198],
    ['security', 'work', 'Security', 199],
    ['training', 'work', 'AI Training'],
    ['teaching', 'work', 'Teaching', 216],
    ['service', 'work', 'Customer Service', 207],
    ['engineering', 'work', 'Engineering', 195],
    ['business', 'intelligence', 'Business', 202],
    ['research', 'intelligence', 'Research', 167],
    ['mathematics', 'research', 'Mathematics', 168],
    ['physics', 'research', 'Physics', 169],
    ['chemistry', 'research', 'Chemistry', 174],
    ['biology', 'research', 'Biomed', 170],
    ['execution', 'intelligence', 'Actions', 175],
    ['computer', 'execution', 'Computer', 176],
    ['mobile', 'execution', 'Mobile', 177],
    ['robotics', 'execution', 'Robotics', 178],
    ['driving', 'execution', 'Driving'],
    ['industrial', 'execution', 'Industry & Labs', 179],
    ['forecast', 'intelligence', 'Forecast & Decide'],
    ['real_world', 'forecast', 'Real World'],
    ['investing', 'forecast', 'Live Investing'],
    ['planning', 'intelligence', 'Planning', 184],
    ['collaboration', 'intelligence', 'Collaboration', 204],
    ['human', 'collaboration', 'Human + AI', 205],
    ['multi_agent', 'collaboration', 'Multi-Agent', 206],
    ['learning', 'intelligence', 'Self-Learning', 208],
    ['retrieval', 'intelligence', 'Knowledge & Retrieval', 209, 'Retrieval'],
    ['culture', 'retrieval', 'Culture'],
    ['hallucination', 'intelligence', 'Low Hallucination', 182],
    ['long_context', 'intelligence', 'Long Context', 215],
    ['multimodal', 'intelligence', 'Multimodal', 210],
    ['image_understanding', 'multimodal', 'Image', 211],
    ['video_understanding', 'multimodal', 'Video', 212],
    ['audio_understanding', 'multimodal', 'Audio', 213],
    ['live_understanding', 'multimodal', 'Live AV', 214],
    ['creation', null, 'Creation', 186],
    ['audiovisual', 'creation', 'Media', 189],
    ['image', 'audiovisual', 'Image', 172],
    ['video', 'audiovisual', 'Video', 173],
    ['audio', 'audiovisual', 'Audio', 190],
    ['3d', 'audiovisual', '3D', 191],
    ['interfaces', 'audiovisual', 'Interfaces', 192],
    ['communication', 'creation', 'Communication', 193],
    ['clarity', 'communication', 'Clarity', 217],
    ['emotional', 'communication', 'EQ', 194],
    ['support', 'communication', 'Emotional Support'],
    ['language_writing', 'creation', 'Language & Writing', 218],
    ['writing', 'language_writing', 'Writing', 187],
    ['language', 'language_writing', 'Language', 219],
    ['agi', null, 'AGI', 166]
];
const positions = new Map();
const categories = nodes.map(([key, parent, name, existingID, previousName]) => {
    const position = (positions.get(parent) ?? 0) + 10;
    positions.set(parent, position);
    return { key, parent, name, position, ...(existingID ? { existingID } : {}), ...(previousName ? { previousName } : {}) };
});
const dimensions = structuredClone(previous.dimensions);
for (const key of ['image_understanding', 'video_understanding']) {
    const list = dimensions[key];
    dimensions[key] = [...list].reverse();
}
const accessibility = { key: 'accessibility', name: 'Accessibility' };
dimensions.video_understanding.find(d => d.key === 'task').options = [accessibility];
dimensions.live_understanding.find(d => d.key === 'task').options.push(accessibility);
const specification = { version: '20261002-private-categories', defaultCategory: 'intelligence',
    preservePersonalPies: true,
    neutralOption: previous.neutralOption, categories, dimensions,
    retiredCategories: [{ ID: 183, name: 'Logic' }, { ID: 200, name: 'Money' },
        { ID: 201, name: 'Finance' }, { ID: 203, name: 'Manual Work' }] };
writeFileSync(new URL('../ops/task-taxonomy-20261002.json', import.meta.url), JSON.stringify(specification, null, 2) + '\n');
console.log(JSON.stringify({ categories: categories.length, dimensionCategories: Object.keys(dimensions).length }));
