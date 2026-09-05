import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../private/home.html', import.meta.url), 'utf8');
const home = fs.readFileSync(new URL('../public/js/home.js', import.meta.url), 'utf8');
const workspace = fs.readFileSync(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/css/home-v2.css', import.meta.url), 'utf8');
const legacyStyles = fs.readFileSync(new URL('../public/css/home.css', import.meta.url), 'utf8');

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
    assert.match(styles, /\.bp-workspace-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 2\.15fr\) minmax\(310px, 0\.9fr\)/s);
    assert.match(styles, /\.bp-left-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(300px, 0\.92fr\) minmax\(365px, 1\.08fr\)/s);
    assert.match(workspace, /state\.workspaceView === 'focus' && selected/);
    assert.match(workspace, /row\.classList\.toggle\('is-muted'/);
    assert.doesNotMatch(html, /id="pie-focus-close"/);
    assert.doesNotMatch(workspace, /pieFocusClose/);
});

test('non-root breadcrumbs omit the AI Evaluation root while the root remains visible alone', () => {
    assert.match(workspace, /const rootOffset = displayParts\.length > 1 \? 1 : 0/);
    assert.match(workspace, /displayParts\.slice\(rootOffset\)/);
});

test('the current homepage category is emphasized above context selectors', () => {
    assert.match(workspace, /if \(isCurrent\) node\.className = 'bp-breadcrumb-current'/);
    assert.match(styles, /\.bp-breadcrumb-current\s*\{[^}]*font-size:\s*17px[^}]*font-weight:\s*680/s);
});

test('taxonomy renders the database root directly without an All Categories wrapper', () => {
    assert.doesNotMatch(home, /name:\s*'All Categories'/);
    assert.doesNotMatch(home, /dataset\.categoryId\s*=\s*root\s*\?/);
    assert.match(home, /treeContent\.replaceChildren\(\.\.\.currentTree\.map\(category =>/);
    assert.match(home, /currentCategoryID === null && currentTree\.length === 1 \? currentTree\[0\] : null/);
    assert.match(html, /\/js\/home\.js\?v=[^"']+/);
});

test('pie slices scale around the center on hover and selected slices render last', () => {
    assert.match(styles, /\.bp-pie-slice-lift\s*\{[^}]*transform-origin:\s*180px 180px/s);
    assert.match(styles, /g\[data-object-id\]:hover \.bp-pie-slice-lift\s*\{[^}]*transform:\s*scale\(1\.05\)/s);
    assert.doesNotMatch(styles, /g\[data-object-id\]:hover \.bp-pie-slice-lift\s*\{[^}]*translate/s);
    assert.match(workspace, /pieSvg\.append\(selectedGroup\)/);
});

test('category creation actions live in the path-aligned overflow menu and legal links stay in the sidebar', () => {
    assert.match(html, /id="category-actions-menu"/);
    assert.match(html, /id="new-category-button"/);
    assert.match(html, /class="bp-sidebar-footer"/);
    assert.match(html, />Terms</);
    assert.match(html, /https:\/\/x\.com\/BenchPoll/);
});

test('personal benchmark focus captures wheel input only in the pie and benchmark workspace', () => {
    assert.match(workspace, /function isPersonalBenchmarkFocus\(\)/);
    assert.match(workspace, /document\.addEventListener\('wheel'/);
    assert.match(workspace, /!event\.target\.closest\('\.bp-left-workspace'\)/);
    assert.match(workspace, /queueSelectedWeightWheel\(event\)/);
    assert.match(workspace, /Scroll to adjust \$\{focusedName\}/);
    assert.doesNotMatch(workspace, /Scroll anywhere outside the sidebar/);
    assert.doesNotMatch(workspace, /These weights belong only to the selected category and context/);
});

test('focused weight adjustment leaves the sidebar, context controls, and model ranking scrollable', () => {
    const wheelListener = workspace.slice(
        workspace.indexOf("document.addEventListener('wheel'"),
        workspace.indexOf("pieSvg.addEventListener('wheel'")
    );
    assert.match(wheelListener, /closest\('\.bp-left-workspace'\)/);
    assert.doesNotMatch(wheelListener, /preventDefault\(\)/);
    assert.doesNotMatch(wheelListener, /bp-sidebar|bp-context-row|bp-model-card/);
    assert.match(wheelListener, /queueSelectedWeightWheel\(event\)/);
});

test('clicking any benchmark row exits personal weight focus instead of changing the target', () => {
    assert.match(workspace, /state\.workspaceView === 'focus' && state\.mode === 'personal'/);
    assert.match(workspace, /Exit weight adjustment for/);
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
    assert.match(workspace, /rightIsPinned - leftIsPinned/);
    assert.match(workspace, /personalWeightFor\(right\) - personalWeightFor\(left\)/);
    assert.match(workspace, /Number\(right\.publicWeight\) - Number\(left\.publicWeight\)/);
    assert.doesNotMatch(workspace, /benchmarkSort/);
    assert.match(workspace, /rank\.textContent = String\(object\.rank\)/);
    assert.match(workspace, /row\.append\(rank, identity, personalValue, publicValue, actionCell\)/);
    assert.doesNotMatch(workspace, /identity\.append\(name, type\)/);
    assert.match(styles, /\.bp-benchmark-head,\s*\.bp-benchmark-row\s*\{[^}]*grid-template-columns:\s*32px minmax\(0, 1fr\) 64px 64px 24px/s);
});

test('personal-mode benchmark rows keep a persistent remove action without exposing it in public mode', () => {
    assert.match(workspace, /function removeObjectFromPersonalPie\(object\)/);
    assert.match(workspace, /state\.personalEntries\.filter\(entry => Number\(entry\.conditionID\) !== objectID\)/);
    assert.match(workspace, /distributeToTarget\([\s\S]*state\.limits\.totalBasisPoints[\s\S]*\)/);
    assert.match(workspace, /if \(personalControlsActive && inPersonalPie\) \{[\s\S]*classList\.add\('has-personal-remove'\)[\s\S]*bp-personal-weight-remove/);
    assert.match(workspace, /actionCell\.append\(edit\)[\s\S]*actionCell\.append\(remove\)/);
    assert.match(styles, /\.bp-benchmark-action-cell\.has-personal-remove\s*\{[^}]*width:\s*50px[^}]*margin-left:\s*-25px/s);
    assert.match(styles, /\.bp-personal-weight-remove\s*\{[^}]*opacity:\s*1/s);
    assert.match(styles, /\.bp-row-edit-action\s*\{[^}]*opacity:\s*0/s);
    assert.doesNotMatch(styles, /\.bp-benchmark-row\.is-personal-pinned::before/);
});

test('new benchmark is a subdued text link and sidebar legal content stays on one row', () => {
    assert.doesNotMatch(html, /id="contribute-button"[^>]*>[\s\S]*?fa-plus[\s\S]*?<\/a>/);
    assert.match(styles, /body\.bp-home \.bp-inline-create-evaluation,\s*body\.bp-home \.bp-contribute-data\s*\{[^}]*background:\s*transparent/s);
    assert.match(styles, /\.bp-sidebar-footer\s*\{[^}]*display:\s*flex[^}]*white-space:\s*nowrap/s);
});

test('empty personal state uses a creation card instead of an inactive mode switch', () => {
    assert.match(html, /id="personal-pie-create"[^>]*hidden/);
    assert.match(html, /Build your benchmark mix and personal leaderboard/);
    assert.match(html, /id="personal-empty-public-return"/);
    assert.match(workspace, /modeSwitch\.hidden = !hasPersonalWeights/);
    assert.match(workspace, /personalPieCreate\.hidden = !showCreatePersonal/);
    assert.match(workspace, /Choose a benchmark on the right to begin/);
    assert.doesNotMatch(workspace, /No weights in this context/);
});

test('benchmark contribution links are unboxed and benchmark weight labels stay neutral', () => {
    assert.doesNotMatch(html, /id="contribute-data-button"[\s\S]*?fa-chart-line[\s\S]*?<\/a>/);
    assert.match(styles, /body\.bp-home \.bp-inline-create-evaluation,\s*body\.bp-home \.bp-contribute-data\s*\{[^}]*border:\s*0[^}]*background:\s*transparent[^}]*box-shadow:\s*none/s);
    assert.doesNotMatch(legacyStyles, /#contribute-button\s*\{[^}]*background:\s*linear-gradient/s);
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
    assert.match(workspace, /class: 'bp-pie-condition'/);
    assert.match(workspace, /benchmarkConditionLabel\(object\)\.toLowerCase\(\)\.includes\(query\)/);
    assert.match(styles, /\.bp-benchmark-condition\s*\{[^}]*color:\s*#8b93a7/s);
    assert.match(styles, /\.bp-pie-condition\s*\{[^}]*fill:\s*#7f879b/s);
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

test('model and benchmark edit actions use the same circled information icon treatment', () => {
    assert.ok((workspace.match(/className = 'bp-row-edit-action bp-benchmark-edit'/g) ?? []).length >= 3);
    assert.match(styles, /\.bp-benchmark-edit i::before\s*\{[^}]*content:\s*"i"/s);
});

test('mobile header stays visible and narrow homepage actions do not create an overflow scroller', () => {
    assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*?\.bp-sidebar\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
    assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*?\.bp-context-actions\s*\{[^}]*flex-wrap:\s*wrap[^}]*overflow:\s*visible/s);
    assert.match(styles, /\.bp-benchmark-card\s*\{[^}]*grid-template-rows:\s*auto 30px minmax\(0, 1fr\)/s);
    assert.match(styles, /\.bp-benchmark-toolbar\s*\{[^}]*flex-wrap:\s*wrap/s);
    assert.match(styles, /\.bp-benchmark-toolbar-actions\s*\{[^}]*flex:\s*1 1 320px/s);
    assert.match(styles, /body\.bp-home \.bp-inline-create-evaluation,[\s\S]*?flex:\s*0 0 auto/s);
    assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*?\.bp-benchmark-toolbar-actions\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*flex:\s*1 1 100%/s);
});

test('model leaderboard is fixed to lower-bound ranking without a visible bound control', () => {
    const headStart = html.indexOf('<div class="bp-model-head"');
    const head = html.slice(headStart, html.indexOf('</div>', headStart) + '</div>'.length);
    assert.match(head, /class="bp-model-score-heading">Score</);
    assert.doesNotMatch(head, /Lower|Upper|bound-toggle|fa-right-left/);
    assert.doesNotMatch(workspace, /state\.bound|boundToggle/);
    assert.match(workspace, /Number\(b\.lower\) - Number\(a\.lower\)/);
    assert.match(workspace, /const selectedScore = Number\(model\.lower\)/);
    assert.match(styles, /\.bp-model-score-heading\s*\{/);
    assert.match(styles, /\.bp-model-card\s*\{[^}]*grid-template-rows:\s*48px 36px minmax\(0, 1fr\)/s);
});

test('pie geometry remains contained while wheel and touch adjustments are active', () => {
    assert.match(styles, /\.bp-pie-stage\s*\{[^}]*overflow:\s*hidden[^}]*contain:\s*paint/s);
    assert.match(styles, /#weight-pie\s*\{[^}]*width:\s*100%[^}]*height:\s*100%[^}]*overflow:\s*hidden[^}]*transform:\s*none/s);
    assert.match(styles, /\.bp-pie-card\.is-adjusting-weight #weight-pie g\[data-object-id\]:hover \.bp-pie-slice-lift\s*\{[^}]*scale\(1\)/s);
    assert.match(workspace, /setPieAdjustmentActive\(true\)/);
    assert.match(workspace, /setPieAdjustmentActive\(false\)/);
});
