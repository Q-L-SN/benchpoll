import { frontendSource, frontendStyles } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../private/home.html', import.meta.url), 'utf8');
const home = frontendSource('public/js/home.js');
const workspace = frontendSource('public/js/home-workspace.js');
const rankingPages = fs.readFileSync(new URL('../ranking-pagination.js', import.meta.url), 'utf8');
const styles = frontendStyles('public/css/home-v2.css');

test('homepage keeps pie, benchmark leaderboard, and model leaderboard in three persistent columns', () => {
    for (const id of [
        'benchmark-summary-card',
        'benchmark-leaderboard-open',
        'benchmark-card',
        'benchmark-leaderboard-close',
        'model-card'
    ]) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(workspace, /new Set\(\['overview', 'leaderboard', 'focus'\]\)/);
    assert.match(workspace, /pieCard\.hidden = false/);
    assert.match(workspace, /benchmarkCard\.hidden = false/);
    assert.match(workspace, /modelCard\.hidden = false/);
    assert.match(workspace, /pieCard\.parentElement !== pieHomeSlot/);
    assert.match(styles, /\.bp-workspace-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.62fr\) minmax\(340px, 1fr\)/s);
    assert.match(styles, /\.bp-left-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(240px, \.88fr\) minmax\(285px, 1\.12fr\)/s);
    assert.match(workspace, /function onBenchmarkInspection\(event\)/);
    assert.match(workspace, /row\.classList\.toggle\('is-muted'/);
    assert.doesNotMatch(html, /id="pie-focus-close"/);
    assert.doesNotMatch(workspace, /pieFocusClose/);
});

test('the workspace breadcrumb shows the flat topic name instead of URL segments or ancestors', () => {
    const breadcrumb = workspace.slice(workspace.indexOf('function renderBreadcrumb('), workspace.indexOf('async function prepareContextChange('));
    assert.match(breadcrumb, /currentCategoryNode\(state\.topicName \|\| 'Topics'\)/);
    assert.match(breadcrumb, /breadcrumb\.append\(name, updateIndicator\.element\)/);
    assert.doesNotMatch(breadcrumb, /categoryPath|lineage|displayParts|rootOffset/);
});

test('the current homepage topic is emphasized and opens topic navigation on mobile', () => {
    assert.match(workspace, /node\.className = 'bp-breadcrumb-current'/);
    assert.match(workspace, /document\.createElement\(categoryNavigationMedia\.matches \? 'button' : 'span'\)/);
    assert.match(workspace, /node\.textContent = name/);
    assert.match(workspace, /node\.setAttribute\('aria-label', `Open topics: \$\{name\}`\)/);
    assert.match(styles, /\.bp-breadcrumb-current\s*\{[^}]*font-size:\s*17px[^}]*font-weight:\s*680/s);
});

test('topic navigation preserves a flat identity and explicit selection without an artificial root', () => {
    const topicSelection = home.slice(home.indexOf('function normalizeTopic('), home.indexOf('async function selectTopic('));
    assert.doesNotMatch(home, /name:\s*'All Categories'/);
    assert.doesNotMatch(home, /dataset\.categoryId\s*=\s*root\s*\?/);
    assert.match(topicSelection, /lineage: \[\{ ID: categoryID, name: categoryName \}\]/);
    assert.match(topicSelection, /sidebarNavigation\.setCurrentTopic\(topic\)/);
    assert.doesNotMatch(topicSelection, /parent_ID|children|currentTree/);
    assert.match(home, /requestJSON\('\/api\/get_topic', \{ categoryID: Number\(publicMatch\[1\]\) \}\)/);
    assert.doesNotMatch(home, /currentTree\[0\]/);
    assert.match(home, /if \(!selected\) throw new Error\('Current topic is missing'\)/);
    assert.match(home, /if \(topic\.categoryID !== Number\(publicMatch\[1\]\)\) throw new Error\('Topic identity changed'\)/);
    assert.match(html, /\/js\/home\.js\?v=[^"']+/);
});

test('weight blocks enlarge within their viewport and active blocks render last', () => {
    assert.match(styles, /#weight-pie \.bp-weight-tile-lift\s*\{[^}]*transform-box:\s*view-box/s);
    assert.match(styles, /#weight-pie g\[data-object-id\]:is\(:hover, :focus-visible\) \.bp-weight-tile-lift\s*\{[^}]*scale\(var\(--bp-tile-hover-scale\)\)/s);
    assert.match(workspace, /treemapHoverTransform\(tile, width, height\)/);
    assert.match(workspace, /pieSvg\.append\(active\.group\)/);
});

test('category creation actions are absent while legal links stay in the sidebar', () => {
    assert.doesNotMatch(html, /id="(?:category-actions-menu|new-category-button|adjust-category-button)"/);
    assert.doesNotMatch(home, /buildContributeURL\('new_category'\)/);
    assert.match(html, /class="bp-sidebar-footer"/);
    assert.match(html, />Terms</);
    assert.match(html, /https:\/\/x\.com\/BenchPoll/);
});

test('personal benchmark focus captures wheel input only in the pie and benchmark workspace', () => {
    assert.match(workspace, /function isPersonalBenchmarkFocus\(\)/);
    assert.match(workspace, /document\.addEventListener\('wheel'/);
    assert.match(workspace, /isWeightWheelTarget\(event\.target\)/);
    assert.match(workspace, /queueSelectedWeightWheel\(event\)/);
    assert.match(workspace, /renderSelectedWeightHeading\(\)/);
    assert.doesNotMatch(workspace, /Scroll to adjust \$\{focusedName\}/);
    assert.doesNotMatch(workspace, /Scroll anywhere outside the sidebar/);
    assert.doesNotMatch(workspace, /These weights belong only to the selected category and context/);
});

test('focused weight adjustment leaves the sidebar, context controls, and model ranking scrollable', () => {
    const wheelListener = workspace.slice(
        workspace.indexOf("document.addEventListener('wheel'"),
        workspace.indexOf("pieSvg.addEventListener('wheel'")
    );
    assert.match(wheelListener, /isWeightWheelTarget\(event\.target\)/);
    assert.doesNotMatch(wheelListener, /preventDefault\(\)/);
    assert.doesNotMatch(wheelListener, /bp-sidebar|bp-context-row|bp-model-card/);
    assert.match(wheelListener, /queueSelectedWeightWheel\(event\)/);
});

test('benchmark names inspect information while the rest of a row selects its weight target', () => {
    assert.match(workspace, /const name = createBenchmarkInformationLink\(object/);
    assert.match(workspace, /onInspect: onBenchmarkInspection, className: 'bp-benchmark-name'/);
    assert.match(workspace, /onBenchmarkActivation\(event, object\)/);
    assert.doesNotMatch(workspace, /informationLink\.click\(\)/);
    assert.match(workspace, /if \(isPersonalBenchmarkFocus\(\)\) setWorkspaceView\('leaderboard'\)/);
    assert.doesNotMatch(workspace, /Exit weight adjustment for/);
});

test('benchmark leaderboard stays public-ranked and can pin personal benchmarks as a separate group', () => {
    const personalPinStart = html.indexOf('<button id="benchmark-personal-pin"');
    const personalPin = html.slice(personalPinStart, html.indexOf('</button>', personalPinStart) + '</button>'.length);
    assert.doesNotMatch(html, /id="benchmark-sort-(?:public|personal)"/);
    assert.match(html, /id="benchmark-personal-pin"[^>]*aria-pressed="false"/);
    assert.match(personalPin, /fa-thumbtack/);
    assert.equal(personalPin.replace(/<[^>]+>/g, '').trim(), '');
    assert.match(workspace, /pinPersonalBenchmarks:\s*false/);
    assert.match(workspace, /const personalControlsActive = state\.mode === 'personal'/);
    assert.match(workspace, /benchmarkPersonalPin\.hidden = !canPinPersonal/);
    assert.match(rankingPages, /snapshot\.personalWeights\.get/);
    assert.match(rankingPages, /return rightWeight - leftWeight/);
    assert.match(rankingPages, /right\.publicWeightBasisPoints - left\.publicWeightBasisPoints/);
    assert.match(rankingPages, /benchmarkVersionTieOrder\(left, right\)/);
    assert.match(workspace, /reloadBenchmarkPage\(\)/);
    assert.doesNotMatch(workspace, /benchmarkSort/);
    assert.match(workspace, /rank\.textContent = object\.isFamily \? '' : String\(object\.rank\)/);
    assert.match(workspace, /row\.append\(rank, identity, personalValue, publicValue\)/);
    assert.doesNotMatch(workspace, /identity\.append\(name, type\)/);
    assert.match(styles, /\.bp-benchmark-head,\s*\.bp-benchmark-row\s*\{[^}]*grid-template-columns:\s*20px minmax\(0, 1fr\) 52px 52px 68px/s);
});

test('personal-mode benchmark rows keep a persistent remove action without exposing it in public mode', () => {
    assert.match(workspace, /function removeObjectFromPersonalPie\(object\)/);
    assert.match(workspace, /state\.personalEntries\.filter\(entry => !removedIDs\.has\(entry\.conditionID\)\)/);
    assert.match(workspace, /distributeToTarget\([\s\S]*state\.limits\.totalBasisPoints[\s\S]*\)/);
    assert.match(workspace, /if \(personalControlsActive && inPersonalPie && !fallbackTargetActive\) \{[\s\S]*classList\.add\('has-personal-remove'\)[\s\S]*bp-personal-weight-remove/);
    assert.match(workspace, /actionCell\.append\(remove\)/);
    assert.doesNotMatch(workspace, /actionCell\.append\(discussion\)/);
    assert.match(styles, /\.bp-benchmark-action-cell\.has-personal-remove\s*\{[^}]*width:\s*32px/s);
    assert.match(styles, /\.bp-personal-weight-remove\s*\{[^}]*opacity:\s*1/s);
    assert.match(styles, /\.bp-row-edit-action\s*\{[^}]*opacity:\s*0/s);
    assert.doesNotMatch(styles, /\.bp-benchmark-row\.is-personal-pinned::before/);
});

test('new benchmark uses the fixed heading action and compact sidebar legal content stays on one row', () => {
    assert.match(html, /<h2 id="benchmark-heading">Evaluation items<\/h2>\s*<a id="contribute-button"/);
    assert.match(html, /id="contribute-button"[^>]*>[\s\S]*?fa-plus[\s\S]*?<\/a>/);
    assert.match(styles, /\.bp-inline-create-evaluation,\s*\.bp-contribute-data\s*\{[^}]*background:\s*transparent/s);
    assert.match(styles, /\.bp-sidebar-footer\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/s);
});

test('empty personal state uses a creation card instead of an inactive mode switch', () => {
    assert.match(html, /id="personal-pie-create"[^>]*hidden/);
    assert.match(html, /Create your own index/);
    assert.match(html, /Choose what counts\. Set your weights\./);
    assert.match(html, /id="personal-empty-public-return"/);
    assert.match(workspace, /modeSwitch\.hidden = !hasPersonalWeights/);
    assert.match(workspace, /personalPieCreate\.hidden = !showCreatePersonal/);
    assert.match(workspace, /personalPieEmpty.hidden = !showEmptyPersonal/);
    assert.doesNotMatch(workspace, /No weights in this context/);
});

test('benchmark contribution links are unboxed and benchmark weight labels stay neutral', () => {
    assert.doesNotMatch(html, /id="contribute-data-button"[\s\S]*?fa-chart-line[\s\S]*?<\/a>/);
    assert.match(styles, /\.bp-inline-create-evaluation,\s*\.bp-contribute-data\s*\{[^}]*border:\s*0[^}]*background:\s*transparent[^}]*box-shadow:\s*none/s);
    assert.doesNotMatch(html, /href="\/css\/home\.css/);
    assert.doesNotMatch(styles, /\.bp-benchmark-public-order::after/);
    assert.match(workspace, /Math\.round\(Number\(personalWeight\)\)/);
});

test('benchmark conditions render as separate muted labels and default stays hidden', () => {
    assert.match(workspace, /function benchmarkConditionLabel\(object\)/);
    const labelHelper = workspace.slice(
        workspace.indexOf('function benchmarkConditionLabel(object)'),
        workspace.indexOf('function benchmarkAccessibleName(', workspace.indexOf('function benchmarkConditionLabel(object)'))
    );
    assert.match(labelHelper, /conditionName\.toLocaleLowerCase\('en-US'\) === 'default'/);
    assert.doesNotMatch(labelHelper, /object\.isDefaultCondition/);
    assert.match(workspace, /condition\.className = 'bp-benchmark-condition'/);
    assert.match(workspace, /kind: 'version', text, size: 11/);
    assert.match(rankingPages, /if \(query && !snapshot\.search\)/);
    assert.match(rankingPages, /snapshot\.search = benchmarkSearchIndex\(snapshot\.benchmarks, snapshot\.familiesByEntrance\)/);
    assert.match(rankingPages, /createSearchIndex\(benchmarks, row => \[row\.name, row\.conditionName,/);
    assert.doesNotMatch(rankingPages, /\.\.\.row\.tags/);
    assert.match(rankingPages, /family\.familyEntries/);
    assert.match(styles, /\.bp-benchmark-condition\s*\{[^}]*color:\s*var\(--bp-muted\)/s);
    assert.match(styles, /#weight-pie \[data-label-kind="version"\]\s*\{[^}]*fill:\s*#596575/s);
});

test('leaderboard headers leave action cells unlabeled', () => {
    const benchmarkHeadStart = html.indexOf('<div class="bp-benchmark-head">');
    const benchmarkHead = html.slice(benchmarkHeadStart, html.indexOf('</div>', benchmarkHeadStart));
    const modelHeadStart = html.indexOf('<div class="bp-model-head"');
    const modelHead = html.slice(modelHeadStart, html.indexOf('</div>', modelHeadStart));
    assert.doesNotMatch(benchmarkHead, /fa-circle-info/);
    assert.doesNotMatch(modelHead, /fa-circle-info/);
    assert.match(benchmarkHead, />Personal</);
    assert.match(benchmarkHead, />Public</);
    assert.doesNotMatch(benchmarkHead, /Personal Weight|Public Weight/);
});

test('benchmark rows have one information entry; model changes live in the score panel', () => {
    const rows = workspace.slice(workspace.indexOf('function renderBenchmarks('), workspace.indexOf('function renderModeState('));
    assert.doesNotMatch(rows, /className = 'bp-row-edit-action bp-benchmark-edit'/);
    assert.match(rows, /createBenchmarkInformationLink\(object, \{ getURL: getBenchmarkMemberURL/);
    assert.match(workspace, /member\.benchmarkID, member\.conditionID \?\? member\.ID/);
    const modelRows = fs.readFileSync(new URL('../public/js/workspace/model-list.js', import.meta.url), 'utf8');
    assert.doesNotMatch(modelRows, /buildModelEditURL|bp-row-edit-action|bp-model-action-cell/);
    assert.match(workspace, /createAction\(\{ label:[\s\S]*?className: 'bp-model-change-information'/);
    assert.match(workspace, /Change information/);
    assert.match(html, /id="model-scores-change-controls"/);
    assert.doesNotMatch(styles, /\.bp-benchmark-edit i::before\s*\{[^}]*content:\s*"i"/s);
});

test('mobile header and explicit panel navigation keep every workspace available', () => {
    assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*?\.bp-sidebar\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
    assert.match(html, /data-mobile-panel="mix"/);
    assert.match(html, /data-mobile-panel="models"/);
    assert.match(styles, /\.bp-mobile-panels button\[aria-pressed="true"\]/);
    assert.match(styles, /data-mobile-panel="models".*\.bp-left-workspace/);
    assert.match(styles, /\.bp-context-actions\s*\{[^}]*flex-wrap:\s*wrap[^}]*overflow:\s*visible/s);
});

test('model leaderboard is fixed to lower-bound ranking without a visible bound control', () => {
    const headStart = html.indexOf('<div class="bp-model-head"');
    const head = html.slice(headStart, html.indexOf('</div>', headStart) + '</div>'.length);
    assert.match(head, /class="bp-model-score-heading">Score</);
    assert.doesNotMatch(head, /Lower|Upper|bound-toggle|fa-right-left/);
    assert.doesNotMatch(workspace, /state\.bound|boundToggle/);
    assert.match(rankingPages, /Number\(right\.lower\) - Number\(left\.lower\)/);
    assert.match(workspace, /const selectedScore = Number\(model\.lower\)/);
    assert.match(styles, /\.bp-model-score-heading\s*\{/);
    assert.match(styles, /\.bp-score-track\s*\{[^}]*grid-row:\s*2/s);
});

test('pie geometry remains contained while wheel and touch adjustments are active', () => {
    assert.match(styles, /\.bp-pie-stage\s*\{[^}]*overflow:\s*hidden[^}]*contain:\s*paint/s);
    assert.match(styles, /#weight-pie\s*\{[^}]*width:\s*100%[^}]*height:\s*100%[^}]*overflow:\s*hidden[^}]*transform:\s*none/s);
    assert.match(styles, /\.bp-pie-card\.is-adjusting-weight #weight-pie g\[data-object-id\] \.bp-weight-tile-lift\s*\{[^}]*transform:\s*none/s);
    assert.match(workspace, /setPieAdjustmentActive\(true\)/);
    assert.match(workspace, /setPieAdjustmentActive\(false\)/);
});
