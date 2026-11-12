import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { taxonomy, planCategories, desiredDimensions } from '../scripts/migrate-expanded-taxonomy.mjs';
import { canonicalizeContextValues } from '../ranking-service.js';

const specification = JSON.parse(readFileSync(new URL('../ops/task-taxonomy-20260930.json', import.meta.url), 'utf8'));
const originalIDs = [54, 167, 168, 169, 174, 170, 175, 176, 177, 178, 179, 180, 181, 182, 183,
    184, 185, 166, 186, 187, 171, 188, 189, 172, 173, 190, 191, 192, 193, 194];
const original = [];
const ids = new Map();
taxonomy.categories.forEach((node, index) => {
    const ID = originalIDs[index];
    ids.set(node.key, ID);
    original.push({ ID, parent_ID: node.parent === null ? null : ids.get(node.parent), name: node.name,
        position: node.position, is_active: 1 });
});

test('task tree preserves retained identities, removes only named retired categories, and is repeatable', () => {
    const plan = planCategories(original, specification);
    assert.equal(plan.filter(node => node.ID !== null).length, 26);
    assert.equal(plan.find(node => node.key === 'software').ID, 180);
    assert.equal(plan.find(node => node.key === 'teaching').parent, 'intelligence');
    assert.deepEqual(plan.filter(node => node.parent === null).map(node => node.name), ['Intelligence', 'Creation', 'AGI']);
    const allocated = new Map();
    let nextID = 200;
    const after = plan.map(node => {
        const ID = node.ID ?? nextID++;
        allocated.set(node.key, ID);
        return { ID, parent_ID: node.parent === null ? null : allocated.get(node.parent), name: node.name,
            position: node.position, is_active: 1 };
    });
    assert.ok(planCategories(after, specification).every(node => node.ID === allocated.get(node.key)));
    assert.throws(() => planCategories(original.map(row => row.ID === 181 ? { ...row, name: 'Unplanned' } : row), specification),
        /Unexpected retired category/);
});

test('ordered templates all offer a neutral default and distinguish no reference from unrestricted', () => {
    for (const key of Object.keys(specification.dimensions)) {
        const dimensions = desiredDimensions(key, specification);
        const resolved = canonicalizeContextValues({}, dimensions);
        assert.ok(Object.values(resolved.contextValues).every(value => value === 'any'));
    }
    assert.deepEqual(desiredDimensions('image', specification).map(d => d.key), ['realtime', 'output', 'reference_image']);
    assert.deepEqual(desiredDimensions('video', specification).map(d => d.key), ['realtime', 'output', 'reference_video', 'reference_image']);
    const image = desiredDimensions('image', specification);
    const values = { realtime: 'no', output: 'vector', reference_image: 'none' };
    assert.deepEqual(canonicalizeContextValues(values, image).contextValues, values);
    assert.equal(canonicalizeContextValues({}, image).contextValues.reference_image, 'any');
    assert.deepEqual(canonicalizeContextValues({ realtime: 'any', output: 'vector' }, image).contextValues,
        { realtime: 'any', output: 'vector', reference_image: 'any' });
});
