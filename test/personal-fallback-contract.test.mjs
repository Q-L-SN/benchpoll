import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizePreviewPersonalPie } from '../ranking-service.js';
import test from 'node:test';

const read = relativePath => fs.readFileSync(new URL('../' + relativePath, import.meta.url), 'utf8');
const migration = read('scripts/migrate-ordered-benchmark-families.mjs');
const ranking = read('ranking-service.js');
test('ordered families replace weighted component storage and retain entrance-weight and condition foreign keys', () => {
    assert.match(migration, /050_ordered_benchmark_families/);
    assert.match(migration, /CREATE TABLE benchmark_families/);
    assert.match(migration, /CREATE TABLE benchmark_family_members/);
    assert.match(migration, /UNIQUE KEY uq_family_chain \(chain_hash\)/);
    assert.match(migration, /FOREIGN KEY \(pie_ID,primary_benchmark_condition_ID\)[\s\S]*REFERENCES personal_pie_weights/);
    assert.match(migration, /DROP TABLE personal_pie_score_rule_components/);
    assert.doesNotMatch(ranking, /personal_pie_score_rule_components/);
});

test('personal previews accept independent source opinions with an explicit scoring version or community versions', () => {
    const estimationVotes = [{ conditionID: 1, vote: 'oppose' }, { conditionID: 2, vote: 'support' }];
    for (const selection of [{}, { followCommunityVersion: true }]) {
        const entries = [{ conditionID: 1, weightBasisPoints: 10000, ...selection }];
        assert.deepEqual(normalizePreviewPersonalPie({ entries, estimationVotes }), { entries, estimationVotes });
        assert.deepEqual(normalizePreviewPersonalPie({ entries, estimationVotes: [] }), { entries, estimationVotes: [] });
    }
});

test('a personal preview rejects contradictory votes and never treats a topic as a version', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
    const vote = { conditionID: 2, vote: 'support' };
    assert.throws(() => normalizePreviewPersonalPie({ entries, estimationVotes: [vote, { ...vote, vote: 'oppose' }] }),
        error => error.body.error === 'invalid_estimation_votes');
    assert.throws(() => normalizePreviewPersonalPie({ entries: [{ conditionID: -10, weightBasisPoints: 10000 }], estimationVotes: [vote] }),
        error => error.body.error === 'estimation_vote_condition_unavailable');
});
