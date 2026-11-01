import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { updateTaskTaxonomy } from '../scripts/build-task-taxonomy-20261015.mjs';
import { planCategories } from '../scripts/migrate-expanded-taxonomy.mjs';
import { buildCategoryNavigation, buildPersonalNavigation } from '../navigation-service.js';
import { locationURL } from '../public/js/navigation/model.js';

const read = date => JSON.parse(readFileSync(new URL(`../ops/task-taxonomy-${date}.json`, import.meta.url), 'utf8'));
const previous = read('20261002');
const current = read('20261015');
const allocated = { work: 231, training: 232, driving: 233, forecast: 234, real_world: 235, investing: 236, culture: 237, support: 238 };
const IDs = new Map(previous.categories.map(node => [node.key, node.existingID ?? allocated[node.key]]));
const before = previous.categories.map(node => ({ ID: IDs.get(node.key), parent_ID: node.parent === null ? null : IDs.get(node.parent),
    name: node.name, position: node.position, is_active: 1, owner_user_ID: null }));
const privateCategory = { ID: 9000, parent_ID: null, name: 'Business', position: 0, is_active: 1, owner_user_ID: 1 };
const after = current.categories.map(node => ({ ID: IDs.get(node.key), parent_ID: node.parent === null ? null : IDs.get(node.parent),
    name: node.name, position: node.position, is_active: 1, owner_user_ID: null }));

test('the dated specification contains only the requested renames, retirement and sibling reorder', () => {
    assert.deepEqual(current, updateTaskTaxonomy(previous));
    assert.deepEqual(updateTaskTaxonomy(current), current);
    assert.equal(current.categories.length, previous.categories.length - 1);
    assert.deepEqual(current.dimensions, previous.dimensions);
    assert.deepEqual(current.neutralOption, previous.neutralOption);
    assert.equal(current.defaultCategory, 'intelligence');
    assert.equal(current.preservePersonalPies, true);
    assert.deepEqual(current.categories.filter(node => {
        const old = previous.categories.find(item => item.key === node.key);
        return JSON.stringify(node) !== JSON.stringify(old);
    }).map(node => node.key), ['business', 'investing', 'long_context']);
    assert.deepEqual(current.retiredCategories.at(-1), { ID: 235, name: 'Real World' });
    assert.deepEqual(current.categories.filter(node => node.parent === 'forecast').map(node => [node.name, node.position]), [['Live Investing', 10]]);
});

test('the migration plan retains category identities and is repeatable without touching private categories', () => {
    const plan = planCategories([...before, privateCategory], current);
    assert.ok(plan.every(node => node.ID === IDs.get(node.key)));
    assert.equal(plan.find(node => node.key === 'business').name, 'Management');
    assert.equal(plan.find(node => node.key === 'long_context').name, 'Memory & Context');
    assert.equal(plan.some(node => node.ID === 235 || node.ID === 9000), false);
    const retired = { ...before.find(node => node.ID === 235), is_active: 0 };
    assert.ok(planCategories([...after, retired, privateCategory], current).every(node => node.previous.name === node.name && node.previous.position === node.position));
    assert.equal(privateCategory.name, 'Business');
});

test('canonical short topic URLs retain new English labels without renaming private topics', () => {
    const entries = buildCategoryNavigation([...after, { ...before.find(node => node.ID === 235), is_active: 0 }, privateCategory]);
    const management = entries.find(entry => entry.categoryID === 202);
    const memory = entries.find(entry => entry.categoryID === 215);
    assert.equal(management.categoryName, 'Management');
    assert.equal(memory.categoryName, 'Memory & Context');
    assert.equal(locationURL(management), '/management');
    assert.equal(locationURL(memory), '/memory-context');
    assert.deepEqual(management.lineage.map(item => item.name), ['Management']);
    assert.deepEqual(memory.lineage.map(item => item.name), ['Memory & Context']);
    assert.equal(entries.some(entry => entry.categoryID === 235 || entry.categoryID === 9000), false);
    const personal = buildPersonalNavigation([
        { contextID: 77, categoryID: 202, contextValues: {}, weightCount: 1, totalBasisPoints: 10000, unavailableConditions: 0 },
        { contextID: 78, categoryID: 9000, contextValues: {}, weightCount: 1, totalBasisPoints: 10000, unavailableConditions: 0 }
    ], [...after, privateCategory], [], []);
    assert.equal(personal.length, 2);
    const publicPie = personal.find(entry => entry.categoryID === 202);
    assert.equal(publicPie.contextID, 77);
    assert.equal(publicPie.available, true);
    assert.equal(locationURL(publicPie), '/management');
    const privatePie = personal.find(entry => entry.categoryID === 9000);
    assert.equal(privatePie.categoryName, 'Business');
    assert.equal(privatePie.isPrivate, true);
    assert.equal(privatePie.available, true);
    assert.equal(locationURL(privatePie), '/personal/9000');
});
