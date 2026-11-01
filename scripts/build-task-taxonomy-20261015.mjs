import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function updateTaskTaxonomy(previous) {
    const specification = structuredClone(previous);
    const renames = new Map([
        ['business', ['Business', 'Management', 202]],
        ['long_context', ['Long Context', 'Memory & Context', 215]]
    ]);
    for (const [key, [before, name, ID]] of renames) {
        const node = specification.categories.find(category => category.key === key);
        if (!node || node.existingID !== ID || ![before, name].includes(node.name)) throw new Error(`Unexpected category: ${key}`);
        Object.assign(node, { name, previousName: before });
    }
    const removed = specification.categories.filter(node => node.key === 'real_world');
    if (removed.length > 1 || removed.some(node => node.name !== 'Real World' || node.parent !== 'forecast')) throw new Error('Unexpected Real World category');
    specification.categories = specification.categories.filter(node => node.key !== 'real_world');
    if (!specification.retiredCategories.some(node => node.ID === 235)) specification.retiredCategories.push({ ID: 235, name: 'Real World' });
    const positions = new Map();
    for (const node of specification.categories) {
        node.position = (positions.get(node.parent) ?? 0) + 10;
        positions.set(node.parent, node.position);
    }
    specification.version = '20261015-management-memory';
    return specification;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const previous = JSON.parse(readFileSync(new URL('../ops/task-taxonomy-20261002.json', import.meta.url), 'utf8'));
    const specification = updateTaskTaxonomy(previous);
    writeFileSync(new URL('../ops/task-taxonomy-20261015.json', import.meta.url), JSON.stringify(specification, null, 2) + '\n');
    console.log(JSON.stringify({ categories: specification.categories.length, dimensionCategories: Object.keys(specification.dimensions).length }));
}
