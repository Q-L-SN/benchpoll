import { frontendSource, frontendStyles } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { currentScoreSQL } from '../score-aggregation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('homepage exposes compact edit entry points beside their objects', () => {
    const home = read('private/home.html');
    const workspace = frontendSource('public/js/home-workspace.js');
    const styles = frontendStyles('public/css/home-v2.css');
    const benchmarkToolbar = home.slice(
        home.indexOf('<div class="bp-benchmark-toolbar">'),
        home.indexOf('<div class="bp-benchmark-head"')
    );

    assert.match(benchmarkToolbar, /id="contribute-button"/);
    assert.match(benchmarkToolbar, /id="benchmark-search"/);
    assert.match(workspace, /Information and discussion for/);
    assert.match(read('public/js/discussion.js'), /buildContributionURL\('edit_benchmark'/);
    assert.match(workspace, /buildModelEditURL/);
    assert.match(workspace, /buildResultEditURL/);
    assert.match(styles, /\.bp-row-edit-action[\s\S]*border:\s*0/);
});

test('model score details load and group accepted samples for the selected model condition', () => {
    const server = read('server.js');
    const workspace = frontendSource('public/js/home-workspace.js');
    const endpoint = server.slice(
        server.indexOf("API.post('/get_approved_benchmark_results'"),
        server.indexOf("API.post('/save_personal_pie'")
    );

    assert.match(endpoint, /normalizeRequiredPositiveInteger\(req\.body\.modelID\)/);
    assert.match(endpoint, /normalizeScoreFields\(req\.body\.scoreFields, fields\)/);
    assert.match(endpoint, /WHERE benchmark_results\.model_ID = \?/);
    assert.match(endpoint, /AND \$\{currentScoreSQL\(\)\}/);
    assert.equal(currentScoreSQL(), "benchmark_results.status = 'accepted'");
    assert.match(endpoint, /configurationName/);
    assert.match(endpoint, /benchmarkConditionIsDefault/);
    assert.match(endpoint, /scoreGroupsByCondition/);
    assert.match(endpoint, /medianRawScore:\s*medianOfFiniteNumbers/);
    assert.match(endpoint, /medianNormalizedScore:\s*medianOfFiniteNumbers/);
    assert.match(endpoint, /samples:\s*\[\]/);
    assert.match(workspace, /modelID:\s*Number\((?:entry\.)?member\.modelID\)/);
    assert.match(workspace, /scoreFields:\s*(?:entry\.)?member\.condition\.scoreFields/);
    assert.match(workspace, /validateApprovedModelResultsPayload/);
    assert.match(workspace, /typeof model\.vendorName !== 'string'/);
    assert.match(workspace, /Median of \$\{distinctCount\} distinct score values/);
    assert.match(workspace, /Ranking value \$\{Number\(group\.medianNormalizedScore\)\.toFixed\(2\)\} \/ 100/);
    assert.match(workspace, /benchmarkTitle\.append\(informationLink\(\{ benchmarkID: group\.benchmarkID/);
    assert.match(read('public/js/workspace/benchmark-link.js'), /detail\.className = 'bp-benchmark-condition'/);
    assert.match(workspace, /group\.samples\.forEach/);
    assert.match(workspace, /buildResultEditURL\(sample\)/);
});

test('model score dialog owns one scroll region and cannot clip its result list', () => {
    const home = read('private/home.html');
    const styles = frontendStyles('public/css/home-v2.css');
    assert.match(styles, /\.bp-model-scores-dialog::part\(content\)\s*\{[^}]*max-height:\s*calc\(100dvh - 32px\)[^}]*overflow:\s*hidden/s);
    assert.match(styles, /\.bp-model-scores-dialog::part\(body\)\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    assert.match(styles, /\.bp-model-scores-body\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\)[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    assert.match(home, /id="model-scores-search"/);
    assert.doesNotMatch(home, /id="model-scores-expand"/);
    assert.match(styles, /\.bp-model-scores-list\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s);
});

test('workspace responses are validated before any response array is mapped', () => {
    const workspace = frontendSource('public/js/home-workspace.js');

    assert.match(workspace, /function validateWorkspacePayload\(payload, \{ resume = null, initialMode = 'public' \} = \{\}\)/);
    assert.match(workspace, /function requireWorkspaceConditionIdentity\(value, path\)/);
    assert.match(workspace, /context\.dimensions.*must be an array|context\.dimensions/);
    assert.match(workspace, /requireWeightEntry\(entry, `personalPie\.entries\[\$\{index\}\]`\)/);
    assert.match(workspace, /requireWeightEntry\(entry, `publicPie\.entries\[\$\{index\}\]`\)/);
    const mixedEntryValidation = workspace.slice(workspace.indexOf('function requireWeightEntry('), workspace.indexOf('function validateReferenceStatus('));
    assert.match(mixedEntryValidation, /requireWorkspaceConditionIdentity\(entry, path\)/);
    assert.match(mixedEntryValidation, /entry\.conditionID !== -entry\.referenceContextID/);
    assert.match(workspace, /requireBenchmarkRow\(entry, `benchmarks\[\$\{index\}\]`\)/);
    assert.match(workspace, /Number\.isSafeInteger\(row\.scoreCount\)/);
    assert.match(workspace, /current\.isDefaultCondition !== literalDefault/);
    assert.match(workspace, /modelLeaderboards\.personal/);
    assert.match(workspace, /const requestWorkspace = async body => \{\s*const payload = validateWorkspacePayload\(await postJSON\('\/api\/get_weighted_workspace',[\s\S]*?\}\), \{ resume, initialMode: body\.initialMode \}\)/);
    assert.match(workspace, /else if \(payload\.userID !== verifiedReadOwner\) throw accountWriteError\(\);\s*return payload;/);
    assert.match(workspace, /let payload = await requestWorkspace\(/);
    assert.doesNotMatch(workspace, /payload\.context\.dimensions \?\? \[\]/);
});

test('moderation cards show structured entity changes and reviewer-only notes', () => {
    const censor = frontendSource('public/js/censor.js');
    assert.match(censor, /case 'entity_change':[\s\S]*return 'Object Change'/);
    assert.match(censor, /Requested Changes/);
    assert.match(censor, /Reviewer Notes/);
    assert.match(censor, /log\.content\.changes/);
    assert.match(censor, /log\.content\.reviewNotes/);
});
