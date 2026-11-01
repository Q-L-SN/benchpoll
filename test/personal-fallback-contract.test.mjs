import { frontendSource, frontendStyles } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relativePath => fs.readFileSync(new URL('../' + relativePath, import.meta.url), 'utf8');
const migration = read('scripts/migrate-ordered-benchmark-families.mjs');
const ranking = read('ranking-service.js');
const server = read('server.js');
const home = read('private/home.html');
const workspace = frontendSource('public/js/home-workspace.js');
const styles = frontendStyles('public/css/home-v2.css');

test('ordered families replace weighted component storage and retain entrance-weight and condition foreign keys', () => {
    assert.match(migration, /050_ordered_benchmark_families/);
    assert.match(migration, /CREATE TABLE benchmark_families/);
    assert.match(migration, /CREATE TABLE benchmark_family_members/);
    assert.match(migration, /UNIQUE KEY uq_family_chain \(chain_hash\)/);
    assert.match(migration, /FOREIGN KEY \(pie_ID,primary_benchmark_condition_ID\)[\s\S]*REFERENCES personal_pie_weights/);
    assert.match(migration, /DROP TABLE personal_pie_score_rule_components/);
    assert.doesNotMatch(ranking, /personal_pie_score_rule_components/);
});

test('personal API requires explicit ordered rules and saves immutable family references atomically', () => {
    const endpoint = server.slice(server.indexOf("API.post('/save_personal_pie'"), server.indexOf("page.get('/login'", server.indexOf("API.post('/save_personal_pie'")));
    assert.match(endpoint, /fallbackRules:\s*req\.body\.fallbackRules/);
    assert.doesNotMatch(endpoint, /fallbackRules:\s*req\.body\.fallbackRules\s*\?\?/);
    assert.match(ranking, /validateFallbackRules\(fallbackRules, normalizedEntries\)/);
    assert.match(ranking, /ensureBenchmarkFamily\(connection, rule\.primaryConditionID, rule\.entries\)/);
    assert.match(ranking, /INSERT INTO personal_pie_score_rules[\s\S]*family_ID/);
    assert.doesNotMatch(ranking, /pie_fallback_cycle_not_allowed|MAX_FALLBACK/);
});

test('homepage uses an ordered inline editor, not a weighted fallback dialog or wheel target', () => {
    assert.doesNotMatch(home, /id="fallback-rule-dialog"|id="inline-fallback-remove"/);
    for (const id of ['inline-fallback-toggle', 'inline-fallback-settings', 'inline-fallback-personal-control', 'public-fallback-toggle', 'inline-fallback-chart']) assert.ok(home.includes('id="' + id + '"'));
    assert.doesNotMatch(home, /inline-fallback-enabled|bp-fallback-switch/);
    assert.match(workspace, /function addObjectToFallbackChain\(object\)/);
    assert.match(workspace, /function moveFallbackMember\(conditionID, targetIndex\)/);
    assert.match(workspace, /function removeFallbackMember\(conditionID\)/);
    assert.match(workspace, /createFamilyView/);
    assert.doesNotMatch(workspace, /adjustSelectedFallbackWeight|MAX_FALLBACK_COMPONENTS|fallbackWheelCommitTimer/);
    assert.match(styles, /\.bp-family-chain/);
    assert.match(styles, /\.bp-family-composition-bar/);
});

test('public scoring receives whole family shares and personal scoring receives explicit rules plus the community mix', () => {
    assert.match(ranking, /calculate\('personal', personalScoringEntries, PIE_TOTAL_BASIS_POINTS,\s*\{ fallbackRules: personalExpanded \? \[\] : personalFallbackRules, familyComposition: personalEffectiveComposition/);
    assert.match(ranking, /const personalEffectiveComposition = personalExpanded\?\.familyComposition \?\? personalCommunityComposition/);
    assert.match(ranking, /calculate\('public', publicEffectiveEntries,\s*publicExpanded \? PIE_TOTAL_BASIS_POINTS : publicPie\.participantCount \* PIE_TOTAL_BASIS_POINTS/);
    assert.match(ranking, /const build = \(\) => scoreComparison\(models, entries, total, rules, compareOptions, preparedGroups\)/);
    assert.match(ranking, /\{ familyComposition: publicEffectiveComposition, fallbackScope: 'public'/);
    assert.match(ranking, /const personalFallbackRules = decorateFallbackRules\(personalSourceFallbackRules, conditionsByID\)/);
    assert.match(ranking, /communityFallbackComposition: personalCommunityComposition/);
    assert.match(ranking, /familyKey\(group\.primaryConditionID, family\.entries\)/);
});
