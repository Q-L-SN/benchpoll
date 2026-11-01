import test from 'node:test';
import assert from 'node:assert/strict';
import { taxonomy, planCategories, desiredDimensions } from '../scripts/migrate-expanded-taxonomy.mjs';
import { canonicalizeContextValues } from '../ranking-service.js';
import { rankingContextURL, readRankingContext } from '../public/js/shared/ranking-url.js';

const current = [
    { ID: 54, parent_ID: null, name: 'Intelligence', is_active: 1 },
    { ID: 166, parent_ID: 54, name: 'AGI', is_active: 1 },
    { ID: 167, parent_ID: 54, name: 'Research', is_active: 1 },
    { ID: 168, parent_ID: 167, name: 'Mathematics', is_active: 1 },
    { ID: 169, parent_ID: 167, name: 'Physics', is_active: 1 },
    { ID: 170, parent_ID: 167, name: 'Biology and Medicine', is_active: 1 },
    { ID: 171, parent_ID: null, name: 'Literary Writing', is_active: 1 },
    { ID: 172, parent_ID: null, name: 'Image', is_active: 1 },
    { ID: 173, parent_ID: null, name: 'Video', is_active: 1 }
];

test('taxonomy reparenting retains every existing category identity and rejects unplanned active data', () => {
    const plan = planCategories(current);
    assert.deepEqual(plan.filter(node => node.ID !== null).map(node => node.ID).sort((a, b) => a - b),
        current.map(row => row.ID));
    assert.equal(plan.find(node => node.key === 'agi').parent, null);
    assert.equal(plan.find(node => node.key === 'image').parent, 'audiovisual');
    assert.equal(plan.find(node => node.key === 'literature').ID, 171);
    assert.throws(() => planCategories([...current, { ID: 400, parent_ID: null, name: 'Unexpected', is_active: 1 }]),
        /Unplanned active categories/);
    assert.throws(() => planCategories(current.filter(row => row.ID !== 172)), /missing or duplicated/);
});

test('planning an already migrated taxonomy creates no duplicate categories', () => {
    const ids = new Map();
    let nextID = 200;
    const applied = planCategories(current).map(node => {
        const ID = node.ID ?? nextID++;
        ids.set(node.key, ID);
        return { ID, parent_ID: node.parent === null ? null : ids.get(node.parent), name: node.name,
            position: node.position, is_active: 1 };
    });
    const again = planCategories(applied);
    assert.ok(again.every(node => node.ID === ids.get(node.key)));
    assert.equal(new Set(again.map(node => node.ID)).size, taxonomy.categories.length);
});

test('new context definitions satisfy ranking invariants and shared reference options round-trip', () => {
    for (const key of Object.keys(taxonomy.dimensions)) {
        const dimensions = desiredDimensions(key);
        const resolved = canonicalizeContextValues({}, dimensions);
        assert.ok(Object.values(resolved.contextValues).every(value => value === 'any'));
        for (const dimension of dimensions) {
            assert.equal(dimension.options.filter(option => option.isDefault).length, 1);
            assert.equal(dimension.options.filter(option => option.isNeutral).length, 1);
        }
    }
    const dimensions = desiredDimensions('video');
    const values = { reference_image: 'present', reference_video: 'present', realtime: 'yes' };
    const url = rankingContextURL('https://benchpoll.com/Creation-and-Expression/Audiovisual/Video', dimensions, values);
    assert.deepEqual(readRankingContext(url.search, dimensions), values);
    assert.equal(new URLSearchParams(url.search).get('reference_image'), 'present');
    assert.equal(new URLSearchParams(url.search).get('reference_video'), 'present');
});
