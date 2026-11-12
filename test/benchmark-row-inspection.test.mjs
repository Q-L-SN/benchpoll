import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const home = source('public/js/home-workspace.js');
const families = source('public/js/workspace/benchmark-family-row.js');
const styles = source('public/css/ui/benchmark-families.css');

test('benchmark and version names share information links, with counts outside them', () => {
    assert.match(home, /let identity = document\.createElement\('span'\)/);
    assert.match(home, /const name = createBenchmarkInformationLink\(object/);
    assert.match(home, /getURL: getBenchmarkMemberURL,\s*onInspect: onBenchmarkInspection/);
    const link = source('public/js/workspace/benchmark-link.js');
    assert.match(link, /detail\.textContent = version/);
    assert.match(link, /link\.dataset\.benchmarkControl = 'information'/);
    assert.match(home, /identity\.append\(name\)/);
    assert.match(home, /metadata\.append\(scoreCount\); identity\.append\(metadata\)/);
    assert.doesNotMatch(home, /name\.append\([^)]*(?:metadata|scoreCount)/);
    assert.doesNotMatch(families, /familyControl|bp-benchmark-family-chain|function create\(/);
    assert.doesNotMatch(home, /identity\.href|identity\.dataset\.benchmarkControl/);
    assert.doesNotMatch(home, /bp-benchmark-discuss|fa-comment|alreadyAdded \? 'check'/);
});

test('row backgrounds use the primary action and never allocate weights', () => {
    const start = home.indexOf("row.addEventListener('click', event => {");
    const listener = home.slice(start, home.indexOf('row.append(rank, identity', start));
    assert.match(listener, /event\.target\.closest\('a, button'\)/);
    assert.match(listener, /onBenchmarkActivation\(event, object\)/);
    assert.match(listener, /event\.target !== row/);
    assert.doesNotMatch(listener, /addObject|removeObject|Inspection|\.click\(\)/);
    const startActivation = home.indexOf('function onBenchmarkActivation(');
    const endActivation = home.indexOf('function fallbackRuleFor(', startActivation);
    assert.ok(startActivation >= 0 && endActivation > startActivation);
    const activation = home.slice(startActivation, endActivation);
    assert.match(activation, /if \(!hasWeight\) return/);
    assert.match(activation, /toggle && selected \? 'leaderboard' : 'focus'/);
    assert.doesNotMatch(activation, /onBenchmarkInspection|addObject/);
});

test('added and unavailable items do not render a fake disabled Add/check control', () => {
    assert.match(home, /if \(!alreadyAdded && !unavailable\) \{/);
    assert.match(home, /add\.innerHTML = '<i class="fa-solid fa-plus"/);
    assert.doesNotMatch(home, /is already in|aria-disabled', String\(alreadyAdded/);
    assert.match(home, /if \(actionCell\.childElementCount\) row\.append\(actionCell\)/);
    assert.match(styles, /not\(\.has-personal-controls\) \.bp-benchmark-row \{ grid-template-columns: 20px minmax\(0, 1fr\) 52px 52px;/);
});

test('optimistic Add moves focus to Remove or information and a closed rail resolves rerendered links', () => {
    assert.match(families, /snapshot\.control === 'add'[\s\S]*data-benchmark-control="remove"[\s\S]*data-benchmark-control="information"/);
    assert.match(families, /snapshot\.control === 'selection' \? row/);
    const discussion = source('public/js/discussion.js');
    assert.match(discussion, /row\.dataset\.conditionId === sourceRow\.dataset\.conditionId/);
    assert.match(discussion, /currentControl \?\? \$\('discussion-entry'\)/);
});

test('applied configurations show a non-destructive check, ordinary benchmarks retain Remove', () => {
    const controls = home.slice(home.indexOf('if (personalControlsActive && inPersonalPie && !fallbackTargetActive)'), home.indexOf("row.addEventListener('click', event => {"));
    const familyBranch = controls.slice(controls.indexOf('if (object.isFamily)'), controls.indexOf('} else {'));
    assert.match(familyBranch, /bp-benchmark-applied/);
    assert.match(familyBranch, /fa-solid fa-check/);
    assert.doesNotMatch(familyBranch, /removeObject|createElement\('button'\)/);
    assert.match(controls, /bp-personal-weight-remove/);
    assert.match(home, /object\.familyKey/);
});

test('benchmark and topic names share a continuous underline while their metadata stays outside the link', () => {
    const nameRule = styles.match(/\.bp-benchmark-information-link \{([^}]+)\}/)?.[1];
    assert.ok(nameRule);
    assert.match(nameRule, /text-decoration: none;/);
    assert.doesNotMatch(nameRule, /text-decoration: underline;/);
    assert.match(styles, /@media \(hover: hover\) \{\s*\.bp-benchmark-row:hover > \.bp-benchmark-identity > \.bp-benchmark-information-link/);
    assert.match(styles, /\.bp-benchmark-row:focus-visible :is\(\.bp-benchmark-name\.bp-benchmark-information-link\),\s*\.bp-benchmark-information-link:focus-visible \{ text-decoration: underline; \}/);
    const redesign = source('public/css/ui/workspace-redesign.css');
    assert.match(redesign, /\.bp-home \.bp-benchmark-information-link \{[^}]*display: inline;[^}]*text-decoration: none/);
    assert.match(redesign, /\.bp-benchmark-information-link \.bp-benchmark-link-name, \.bp-home \.bp-topic-link-label \{[^}]*display: inline; border: 0/);
    assert.match(redesign, /\.bp-home \.bp-benchmark-information-link:is\(:hover, :focus-visible\)[^{]*\{[^}]*text-decoration: underline/);
    assert.match(redesign, /\.bp-benchmark-identity > \.bp-evaluation-meta \{[^}]*display: inline-flex;[^}]*white-space: nowrap/);
});

test('workspace updates are immediate and use local animation instead of interruptible page snapshots', () => {
    const view = home.slice(home.indexOf('function applyWorkspaceView('), home.indexOf('function setWorkspaceView('));
    assert.match(view, /leftWorkspace\.dataset\.workspaceView = state\.workspaceView/);
    assert.match(view, /animateContent\(leftWorkspace, \{ translate: false \}\)/);
    assert.match(view, /animate && window\.matchMedia\('\(min-width: 761px\)'\)\.matches/);
    assert.match(styles, /\.bp-benchmark-row \{ transition: background-color 160ms ease, opacity 160ms ease; \}/);
    assert.doesNotMatch(view, /startViewTransition|\.catch\(/);
});
