import { frontendSource, frontendStyles } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relativePath => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const migration = read('scripts/migrate-personal-fallback-rules.mjs');
const integrity = read('scripts/check-ranking-integrity.mjs');
const ranking = read('ranking-service.js');
const server = read('server.js');
const home = read('private/home.html');
const workspace = frontendSource('public/js/home-workspace.js');
const styles = frontendStyles('public/css/home-v2.css');

test('personal OR fallback schema is strict and tied to an existing personal pie weight', () => {
    assert.match(migration, /022_personal_fallback_rules/);
    assert.match(migration, /CREATE TABLE personal_pie_score_rules/);
    assert.match(migration, /ENUM\('fallback_if_missing'\)/);
    assert.match(migration, /FOREIGN KEY \(pie_ID, primary_benchmark_condition_ID\)[\s\S]*REFERENCES personal_pie_weights \(pie_ID, benchmark_condition_ID\)[\s\S]*ON DELETE CASCADE/);
    assert.match(migration, /CREATE TABLE personal_pie_score_rule_components/);
    assert.match(migration, /FOREIGN KEY \(fallback_benchmark_condition_ID\)[\s\S]*REFERENCES benchmark_conditions \(ID\)[\s\S]*ON DELETE RESTRICT/);
    assert.match(migration, /CHECK \(primary_benchmark_condition_ID <> fallback_benchmark_condition_ID\)/);
    assert.match(integrity, /personal fallback rule graphs with cycles/);
    assert.match(integrity, /personal fallback component totals other than 100 percent/);
});

test('personal pie API requires and persists fallback rules without a compatibility default', () => {
    const endpoint = server.slice(
        server.indexOf("API.post('/save_personal_pie'"),
        server.indexOf("page.get('/login'", server.indexOf("API.post('/save_personal_pie'"))
    );
    assert.match(endpoint, /fallbackRules:\s*req\.body\.fallbackRules/);
    assert.doesNotMatch(endpoint, /fallbackRules:\s*req\.body\.fallbackRules\s*\?\?/);
    assert.match(ranking, /validateFallbackRules\(fallbackRules, normalizedEntries\)/);
    assert.match(ranking, /INSERT INTO personal_pie_score_rules/);
    assert.match(ranking, /INSERT INTO personal_pie_score_rule_components/);
    assert.match(ranking, /pie_fallback_cycle_not_allowed/);
});

test('homepage edits Fallback inline and saves it atomically with the personal pie', () => {
    assert.doesNotMatch(home, /id="fallback-rule-dialog"/);
    assert.doesNotMatch(home, /id="fallback-rule-search"/);
    assert.match(home, /id="inline-fallback-enabled"/);
    assert.match(home, /id="inline-fallback-personal-control"/);
    assert.match(home, /id="public-fallback-toggle"/);
    assert.match(home, /id="inline-fallback-guide"/);
    assert.match(home, /id="inline-fallback-remove"/);
    assert.match(home, /id="inline-fallback-chart"/);
    assert.match(home, /<strong>Fallback<\/strong>/);
    assert.doesNotMatch(home, /OR fallback/i);
    assert.doesNotMatch(workspace, /openFallbackRuleEditor|fallbackEditorState|fallbackRuleDialog/);
    assert.match(workspace, /personalFallbackRules:\s*\[\]/);
    assert.match(workspace, /publicFallbackRules:\s*\[\]/);
    assert.match(workspace, /serverPersonalFallbackRules:\s*\[\]/);
    assert.match(workspace, /fallbackRules,\s*comparison: state\.comparisonRequest/);
    assert.match(workspace, /function snapshotPersonalPie\(\)/);
    assert.match(workspace, /fallbackRules:\s*cloneFallbackRules\(state\.personalFallbackRules\)/);
    assert.match(workspace, /function renderInlineFallback\(\)/);
    assert.match(workspace, /function isInlineFallbackTargetActive\(\)/);
    assert.match(workspace, /function addObjectToFallbackMix\(object\)/);
    assert.match(workspace, /function removeSelectedFallbackComponent\(\)/);
    assert.match(workspace, /if \(fallbackTargetActive\) \{\s*addObjectToFallbackMix\(object\)/);
    assert.match(workspace, /function adjustSelectedFallbackWeight\(deltaBasisPoints\)/);
    assert.match(workspace, /const retainedSegments = new Set\(\)/);
    assert.match(workspace, /insertBefore\(segment, currentAtIndex \?\? null\)/);
    assert.match(workspace, /fallbackWheelCommitTimer = window\.setTimeout\([\s\S]*WHEEL_WEIGHT_COMMIT_IDLE_MS/);
    assert.match(workspace, /showFallbackIcon = state\.mode === 'personal' && hasFallback/);
    assert.match(workspace, /showFallbackIcon \? 'fallback' : ''/);
    assert.match(workspace, /function publicFallbackRuleFor\(primaryConditionID\)/);
    assert.match(workspace, /publicFallbackToggle\.addEventListener\('click'/);
    assert.match(styles, /\.bp-inline-fallback-chart\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s);
    assert.match(styles, /\.bp-inline-fallback-chart\.is-target-active\s*\{/);
    assert.match(styles, /\.bp-inline-fallback-segment\s*\{[^}]*flex:\s*0 0 var\(--bp-fallback-weight\)/s);
    assert.match(styles, /\.bp-pie-fallback-icon\s*\{/);
    assert.doesNotMatch(styles, /\.bp-fallback-dialog\s*\{/);
});

test('public scoring receives aggregated rules while personal scoring keeps its own rules', () => {
    const workspaceBuilder = ranking.slice(
        ranking.indexOf('export async function getRankingWorkspace'),
        ranking.indexOf('function validatePieEntries')
    );
    assert.match(workspaceBuilder, /personal:\s*scoreComparison\([\s\S]*fallbackRules:\s*personalSourceFallbackRules/);
    assert.match(workspaceBuilder, /publicPie:\s*\{[\s\S]*fallbackRules:\s*decorateFallbackRules\(publicPie\.fallbackRules/);
    const publicCall = workspaceBuilder.slice(workspaceBuilder.indexOf('public: scoreComparison'));
    assert.match(publicCall, /fallbackRules:\s*publicPie\.fallbackRules, fallbackScope: 'public'/);
});
