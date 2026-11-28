import { frontendSource } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { normalizedResultScore, scoreModels, scoreComparison } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const words = text => plain(text).split(/\s+/).length;
const home = read('private/home.html');
const guide = read('private/how-it-works.html');
const styles = read('public/css/how-it-works.css');
const script = read('public/js/how-it-works.js');
const workspace = frontendSource('public/js/home-workspace.js');
const server = read('server.js');
const article = guide.match(/<article[\s\S]*?<\/article>/)[0];
const mainCopy = article.replace(/<nav[\s\S]*?<\/nav>/, '');
const headings = [...mainCopy.matchAll(/<h([1-4]) id="([^"]+)" tabindex="-1">/g)];
function section(id) {
    const headingIndex = headings.findIndex(([, , key]) => key === id);
    assert.ok(headingIndex >= 0, id);
    const heading = headings[headingIndex];
    const next = headings.slice(headingIndex + 1).find(([, level]) => Number(level) <= Number(heading[1]));
    return mainCopy.slice(heading.index, next?.index);
}
const model = (ID, scores) => ({ ID, modelID: ID, name: `Model ${ID}`, modelName: `Model ${ID}`,
    condition: { parameters: {}, scoreFields: [] },
    results: new Map(Object.entries(scores).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }];

test('homepage How it works control navigates to a page instead of opening a dialog', () => {
    assert.match(home, /id="how-it-works-link"[^>]*href="\/how-it-works"/);
    assert.doesNotMatch(home, /how-it-works-dialog|how-it-works-button/);
    assert.doesNotMatch(workspace, /howItWorksDialog|howItWorksButton/);
});

test('Home navigation belongs to the configuration page rather than the guide', () => {
    assert.doesNotMatch(guide, /Back to topics/i);
    assert.match(home, /id="back-to-topics"[^>]*class="[^"]*bp-quiet-action[^\"]*"[^>]*href="\/"/);
    const heading = home.match(/<header class="bp-workspace-header">[\s\S]*?<\/header>/)[0];
    assert.match(heading, /<a id="back-to-topics"[^>]*aria-label="Home"[^>]*><i class="fa-solid fa-house"[^>]*><\/i><\/a>\s*<button id="header-user-profile"/);
    assert.match(home, /id="workspace-topic-summary"/);
});

test('guide provides a short, uninterrupted article and matches each heading to a native link', () => {
    assert.match(mainCopy, /How BenchPoll works/);
    assert.equal(headings.filter(([, level]) => level === '1').length, 1);
    assert.ok(words(mainCopy) <= 1150, `Guide has ${words(mainCopy)} words`);
    assert.doesNotMatch(mainCopy, /<(?:details|summary|button|figure|canvas|svg|img)\b|\bhidden\b|role="(?:tab|tablist|tabpanel)"/);
    const contents = article.match(/<nav class="hi-toc"[\s\S]*?<\/nav>/)[0];
    const links = [...contents.matchAll(/href="([^"]+)"/g)].map(([, href]) => href);
    assert.deepEqual(links, headings.map(([, , id]) => '#' + id));
    for (const id of ['overview', 'topics', 'personal', 'public', 'calculation-details', 'rankings',
        'details', 'references', 'fallback', 'account', 'trust']) {
        assert.ok(links.includes('#' + id), id);
    }
    for (const [, paragraph] of mainCopy.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
        assert.ok(words(paragraph) <= 55, plain(paragraph));
    }
});

test('topics and scenes lead to the public index, search and evidence', () => {
    const topics = section('topics');
    assert.match(topics, /Open a topic to see its public index/);
    assert.match(topics, /one level of scenes, with the default scene first/);
    assert.match(topics, /Each scene has its own weights and discussion/);
    assert.match(topics, /topic menu to find favorites, topics you configured or created, recent visits, or search/);
    assert.match(topics, /Search shows matching scenes inside their topic card/);
    assert.match(topics, /Favorite topics appear in your profile/);
    assert.match(topics, /recent favorites carrying more weight/);
    assert.match(topics, /Open a model to see its results and sources/);
    assert.match(topics, /Filters apply to every ranking card/);
});

test('Personal and Public copy explains saving weights and the shared public sample', () => {
    const personal = section('personal');
    assert.match(personal, /Personal Weights/);
    assert.match(personal, /<strong>Index composition<\/strong> adds up to 100%/);
    assert.match(personal, /With two or more items, select a block and scroll over the chart/);
    assert.match(personal, /You can try adjusting weights without signing in/);
    assert.match(personal, /Sign in to save your weights/);
    assert.match(personal, /marks unsaved changes/);
    const community = section('public');
    assert.match(community, /Each person contributes one configuration, updated as they save edits/);
    assert.match(community, /Another public topic contributes only through an explicit reference/);
    assert.match(community, /Private topics and their weights are visible only to their creator/);
    const sample = section('calculation-details');
    assert.match(sample, /all nonempty configurations updated for the topic or scene in the past 72 hours/);
    assert.match(sample, /If fewer than 10 qualify, it uses the latest 10 or as many as exist/);
    assert.match(sample, /The same sample determines community scoring version shares/);
});

test('topic references follow specific scenes and retain missing shares', () => {
    const references = section('references');
    assert.match(references, /specific scene if it has scenes/);
    assert.match(references, /stays linked to that scene’s live weights/);
    assert.match(references, /Public indices use the referenced scene’s public weights/);
    assert.match(references, /Personal indices use your saved weights there when available and otherwise use public weights/);
    assert.match(references, /Public topics can reference public topics and scenes\. Private topics can reference those and your other private topics/);
    assert.match(references, /multiplies weights along each path and adds the shares for each benchmark version/);
    assert.match(references, /Pair votes apply across scenes/);
    assert.match(references, /If references form a loop, BenchPoll includes the benchmark shares reached along repeated paths/);
    assert.match(references, /Empty or unavailable targets and loops with no path to benchmarks keep their missing weight/);
});

test('score copy explains version shares, treemap estimates, peer medians and measured coverage', () => {
    const scores = section('rankings');
    assert.match(scores, /each benchmark version’s scoring scale and direction/);
    assert.match(scores, /A direct score on a scoring version takes priority, including zero and negative scores/);
    assert.match(scores, /path with the highest product of link weights/);
    assert.match(scores, /support rate times [^<]*<span class="hi-formula"><var>n<\/var> \/ \(<var>n<\/var> \+ 2\)/);
    assert.match(scores, /divides each benchmark’s weight among usable sources/);
    assert.match(scores, /median of other models’ scores on the target version, using one measurement or earlier estimate per model/);
    assert.match(scores, /<var>W<\/var> × Σ\(<var>p<sub>a<\/sub><\/var> <var>s<sub>a<\/sub><\/var>\)/);
    assert.match(scores, /sum to 100%/);
    assert.doesNotMatch(scores, /Score range|lower end|upper end/);
    assert.match(scores, /Coverage is the share of weight with measured results<\/strong> on selected versions/);
    assert.match(scores, /A faded tile in the score preview marks a missing measurement/);
    assert.match(scores, /Models need measured or calibrated evidence to rank/);
    assert.match(scores, /effort or harness to rank settings separately/);
    assert.match(scores, /best qualifying score per test/);
    assert.match(scores, /Missing settings stay in an unknown group/);
    assert.match(scores, /Matched comparisons calibrate each qualifying run separately/);
});

test('the guide explains sitewide pair votes and dynamic cross-benchmark nominations', () => {
    const sectionText = section('fallback');
    for (const phrase of ['Scoring version', 'Estimation support', 'Either version opens the same sitewide vote',
        'last 72 hours', 'reach ten', 'Versions of the same benchmark are eligible by default',
        'Your own vote takes priority', 'Add version', 'Search for a version from another benchmark', 'Both versions list the pair while its sample has at least one supporter']) {
        assert.ok(sectionText.includes(phrase), phrase);
    }
});

test('version estimation explains joint evidence, shrinkage, extrapolation and run settings', () => {
    const calibration = section('calibration');
    assert.match(calibration, /eligible measured versions of the same benchmark together/);
    assert.match(calibration, /at least one other model under the same run settings/);
    assert.match(calibration, /model measured on A and B can contribute without C/);
    assert.match(calibration, /Sparse samples favor a shared starting correlation/);
    assert.match(calibration, /less influence outside the observed source range/);
    assert.match(calibration, /C can predict A through B/);
    assert.match(calibration, /Each link follows the pair vote/);
    assert.match(calibration, /the shortest path/);
    assert.match(calibration, /Best performance uses the highest qualifying run prediction/);
    assert.match(calibration, /Matched comparisons average predictions within each matched control setting/);
    assert.match(calibration, /When same-benchmark versions cannot fill the gap, BenchPoll tries nominated external versions/);
});

test('publication and evidence copy includes settings, visibility and score contributions', () => {
    const account = section('account');
    assert.match(account, /Choose <strong>Public<\/strong> or <strong>Private<\/strong> at the top of the topic editor/);
    assert.match(account, /select <strong>Public<\/strong> in its editor/);
    assert.match(account, /Public topics appear as soon as you publish/);
    assert.match(account, /up to three public topics at a time/);
    assert.match(account, /Make a public topic private before deleting it/);
    assert.match(account, /href="\/me"/);
    assert.match(account, /href="\/settings"/);
    assert.match(account, /edit your details and privacy choices/);
    assert.match(account, /Showing a GitHub link is optional/);
    const evidence = section('trust');
    assert.match(evidence, /measured results and estimates/);
    assert.match(evidence, /All scores/);
    assert.match(evidence, /Change information/);
    assert.match(evidence, /href="\/contribute\/scores\/new"/);
});

test('the shell provides a skip link, a responsive table of contents and focus styling', () => {
    assert.match(guide, /class="hi-topbar"/);
    assert.match(guide, /class="bp-brand-lockup"[^>]*src="\/assets\/benchpoll-logo\.svg"/);
    assert.match(guide, /<a class="hi-skip" href="#overview">/);
    assert.match(guide, /<summary>Contents/);
    assert.match(styles, /focus-visible/);
    assert.match(styles, /@media \(max-width: 760px\)/);
    assert.match(script, /addEventListener\('hashchange', updateCurrentLink\)/);
    assert.doesNotMatch(script, /preventDefault|pushState|replaceState|scrollIntoView/);
});

test('How it works route resolves before the generic error-page catchall', () => {
    const guideRoute = server.indexOf("page.get('/how-it-works'");
    const catchall = server.indexOf("page.get('/*any_path'");
    assert.ok(guideRoute >= 0);
    assert.ok(catchall > guideRoute);
    assert.match(server.slice(guideRoute, catchall), /private\/how-it-works\.html/);
});

test('short score explanation agrees with current conversion and range endpoints', () => {
    assert.equal(normalizedResultScore({ rawScore: 30, scoreMin: 10, scoreMax: 50, scoreDirection: 'higher' }), 50);
    assert.equal(normalizedResultScore({ rawScore: 20, scoreMin: 10, scoreMax: 50, scoreDirection: 'lower' }), 75);
    assert.equal(normalizedResultScore({ rawScore: 20, scoreMin: 0, scoreMax: 100, scoreDirection: 'closer_to_target', targetValue: 50 }), 40);
    const [row] = scoreModels([model(1, { 1: 80 })], weights, 10000, { scoreMode: 'range' });
    assert.deepEqual([row.lower, row.upper, row.coverage], [48, 88, 60]);
    assert.equal(row.inferredScores.length, 0);
});

test('the peer median uses other models on the target version without increasing measured coverage', () => {
    const models = [model(1, { 1: 80 }), model(2, { 1: 60, 2: 50 }), model(3, { 1: 100, 2: 90 }),
        model(4, { 1: 70, 2: 65 }), model(5, { 1: 90, 2: 80 })];
    const [range] = scoreModels(models, weights, 10000, { scoreMode: 'range' });
    const [available] = scoreModels(models, weights, 10000, { scoreMode: 'available' });
    assert.equal(available.availableInference.method, 'calibrated-fallback');
    assert.deepEqual(available.inferredScores.map(item => [item.conditionID, item.estimationMethod, item.contribution]),
        [[2, 'peer-median', 29]]);
    assert.equal(available.coverage, 60, 'The estimate must not increase measured coverage');
    assert.deepEqual(available.calculationScores.map(score => [score.conditionID, score.normalizedScore]),
        range.calculationScores.map(score => [score.conditionID, score.normalizedScore]));
    assert.equal(available.availableInference.unresolvedFraction, 0);
    assert.equal(available.availableInference.unresolvedContribution, 0);
    assert.equal(available.lower, 77);
});

test('without peer scores an unscored slot leaves the negative evidence undiluted', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 2500 }, { conditionID: 2, weightBasisPoints: 7500 }];
    const [row] = scoreModels([model(1, { 1: -20 })], entries, 10000, { scoreMode: 'available' });
    assert.equal(row.coverage, 25);
    assert.deepEqual(row.inferredScores, []);
    assert.equal(row.availableInference.unresolvedFraction, .75);
    assert.equal(row.availableInference.unpenalizedScore, -20);
    assert.equal(row.lower, -20);
    const missing = [model(2, { 3: 100 })];
    const [unranked] = scoreComparison(missing, entries, 10000, { scoreMode: 'available' },
        comparisonOptions(missing, { mode: 'best', keys: ['model'] }));
    assert.equal(unranked.comparable, false);
    assert.equal(unranked.lower, null);
});

test('uncalibrated scores outside the treemap do not supply evidence for a treemap estimate', () => {
    const plannedWeights = weights.map(entry => ({ ...entry, estimationSourceIDs: entry.conditionID === 2 ? [3, 4] : [] }));
    for (const value of [0, -20]) {
        for (const scoreMode of ['range', 'available']) {
            const [row] = scoreModels([model(1, { 1: 80, 3: value, 4: 90 })], plannedWeights, 10000, { scoreMode });
            assert.equal(row.coverage, 60);
            assert.deepEqual([row.lower, row.upper], scoreMode === 'range' ? [48, 88] : [80, 80]);
            assert.deepEqual(row.calculationScores.map(score => score.conditionID), [1]);
            assert.deepEqual(row.inferredScores, []);
        }
    }
});
