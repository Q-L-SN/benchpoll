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

test('personal previews accept ballots with explicit, community, or topic-only weights', () => {
    const estimationVotes = [{ targetConditionID: 3, sourceConditionID: 2, vote: 'support' }];
    for (const allocation of [{ conditionID: 1 }, { conditionID: 1, followCommunityVersion: true }, { conditionID: -10 }]) {
        const entries = [{ ...allocation, weightBasisPoints: 10000 }];
        assert.deepEqual(normalizePreviewPersonalPie({ entries, estimationVotes }), {
            entries, estimationVotes: [{ targetConditionID: 2, sourceConditionID: 3, vote: 'support' }]
        });
        assert.deepEqual(normalizePreviewPersonalPie({ entries, estimationVotes: [] }), { entries, estimationVotes: [] });
    }
});

test('a personal preview rejects a second vote on a reversed pair and rejects topic IDs as endpoints', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
    const vote = { targetConditionID: 1, sourceConditionID: 2, vote: 'support' };
    assert.throws(() => normalizePreviewPersonalPie({ entries, estimationVotes: [vote,
        { targetConditionID: 2, sourceConditionID: 1, vote: 'oppose' }] }),
        error => error.body.error === 'invalid_estimation_votes');
    assert.throws(() => normalizePreviewPersonalPie({ entries, estimationVotes: [{ ...vote, sourceConditionID: -10 }] }),
        error => error.body.error === 'invalid_estimation_votes');
});
