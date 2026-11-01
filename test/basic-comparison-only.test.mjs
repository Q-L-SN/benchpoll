import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basicComparisonOptions } from '../public/js/workspace/basic-comparison-controls.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const metadata = { fields: [{ ID: 1, name: 'Harness' }, { ID: 20, name: 'Effort' }, { ID: 99, name: 'Cost' }], availableKeys: ['model', 'field:1', 'field:20', 'field:99'] };

test('old experiments and advanced profiles cannot replace the basic comparison', () => {
    const settings = { experimental: true, last: { mode: 'matched', keys: ['field:99'], filters: [{ key: 'model', operator: 'eq', value: 301 }] },
        basic: { mode: 'matched', keys: ['field:20', 'field:99'], filters: [{ key: 'field:1', operator: 'absent' }] } };
    assert.deepEqual(basicComparisonOptions(settings, metadata), { mode: 'best', keys: ['model', 'field:20'], filters: [] });
    assert.deepEqual(basicComparisonOptions(settings.last, metadata), { mode: 'best', keys: ['model'], filters: [] });
    assert.deepEqual(basicComparisonOptions({ basic: { keys: ['field:1', 'field:20', 'model'] } }, metadata),
        { mode: 'best', keys: ['model', 'field:1', 'field:20'], filters: [] });
    assert.equal(settings.experimental, true, 'The archived preference is not deleted');
});

test('homepage has no advanced UI and does not load or mutate saved advanced profiles', () => {
    const html = read('private/home.html'), workspace = read('public/js/home-workspace.js');
    assert.doesNotMatch(html, /id="(?:experimental-comparison|model-comparison-(?:panel|toggle|keys|mode))"|comparison-profile-menu\.js/);
    assert.equal((html.match(/data-quick-comparison=/g) ?? []).length, 2);
    assert.match(workspace, /basic-comparison-controls\.js/);
    assert.match(workspace, /postJSON\('\/api\/get_user_profile'/);
    assert.doesNotMatch(workspace, /createComparisonProfileStore|comparisonProfileStore|isExperimental\(/);
    assert.doesNotMatch(read('public/js/workspace/basic-comparison-controls.js'), /get_comparison_profiles|save_comparison_profile|setProfiles|experimental/);
    assert.doesNotMatch(read('private/how-it-works.html'), /Enable Advanced filters|Enable them in Your account|Matched versions/);
});
