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
const section = id => guide.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))?.[0] ?? '';
const model = (ID, scores) => ({ ID, modelID: ID, name: `Model ${ID}`, modelName: `Model ${ID}`,
    condition: { parameters: {}, scoreFields: [] },
    results: new Map(Object.entries(scores).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }];

test('homepage How it works control navigates to a page instead of opening a dialog', () => {
    assert.match(home, /id="how-it-works-link"[^>]*href="\/how-it-works"/);
    assert.doesNotMatch(home, /how-it-works-dialog|how-it-works-button/);
    assert.doesNotMatch(workspace, /howItWorksDialog|howItWorksButton/);
});

test('Back to topics belongs to the configuration page rather than the guide', () => {
    assert.doesNotMatch(guide, /Back to topics/i);
    assert.match(home, /id="back-to-topics"[^>]*class="[^"]*bp-quiet-action[^\"]*"[^>]*href="\/"/);
    assert.match(home, /<a id="back-to-topics"[\s\S]*?fa-arrow-left[\s\S]*?<span>Back to topics<\/span><\/a>/);
    const context = home.match(/<div class="bp-context-identity">([\s\S]*?)<\/div>/)[1];
    assert.match(context, /id="back-to-topics"/);
    assert.match(context, /id="bp-breadcrumb"/);
});

test('guide keeps the first read short with optional calculation details', () => {
    assert.match(guide, /How BenchPoll works/);
    assert.equal([...guide.matchAll(/<h1>/g)].length, 1);
    const article = guide.match(/<article[\s\S]*?<\/article>/)[0];
    assert.ok(words(article) <= 1150, `Guide has ${words(article)} words`);
    assert.ok(words(article.replace(/<details[\s\S]*?<\/details>/g, '')) <= 400);
    assert.doesNotMatch(article, /<ol\b|<table\b|Expand all|Full calculation rules|&radic;|Public weight =/);
    assert.doesNotMatch(plain(article), /\b(?:overview|showcase|subcategories|descendants|import|themes)\b|View composition/i);
    assert.doesNotMatch(article, /72 hours|percentile|denominator|basis points|pairwise-anchored/);
    for (const [, paragraph] of article.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
        assert.ok(words(paragraph) <= 55, plain(paragraph));
    }
});

test('Topics introduction leads to the public index, evidence and personal weights', () => {
    const topics = section('topics');
    assert.match(topics, /Browse Popular, Recent, or Mine/);
    assert.match(topics, /Open a topic for its public index/);
    assert.match(topics, /a model for its results and sources/);
    assert.match(topics, /Personal weights let you build your own index/);
    assert.match(topics, /Filters apply to every card/);
    assert.match(topics, /<strong>Estimated score<\/strong> is the default/);
    assert.match(guide, /href="\/">Browse Topics/);
});

test('Personal and Public copy keeps saving, independent topics and privacy distinct', () => {
    assert.match(section('personal'), /Personal Weights/);
    assert.match(section('personal'), /<strong>Index composition<\/strong> totals 100% when nonempty/);
    assert.match(section('personal'), /With two or more items, select a block and adjust its weight/);
    assert.match(section('personal'), /Try it without signing in/);
    assert.match(section('personal'), /Sign in to save your weights/);
    assert.match(section('personal'), /Unsaved changes are marked/);
    assert.match(section('public'), /saved personal weight configurations in this topic/);
    assert.match(section('public'), /shaped by recent activity/);
    assert.match(section('public'), /Each person contributes one configuration, updated with their edits/);
    assert.match(section('public'), /Another topic contributes only through an explicit reference/);
    assert.match(section('public'), /Private topics and their weights never contribute to Public Weights/);
    assert.match(section('public'), /id="calculation-details"/, 'Existing Public help links still reach the relevant short explanation');
});

test('guide explains concrete scene identity and dynamic weight resolution without double scoring', () => {
    assert.match(section('topics'), /one level of scenes/);
    assert.match(section('topics'), /default scene comes first/);
    assert.match(section('topics'), /Search results show matching scenes within their topic card/);
    assert.match(section('references'), /specific scene if it has scenes/);
    assert.match(section('references'), /stay linked to the scene you selected/);
    assert.match(section('references'), /Public indices always follow public target weights/);
    assert.match(section('references'), /Personal indices prefer your saved target weights/);
    assert.match(section('references'), /coverage correction are calculated after expansion/);
    assert.match(section('references'), /Empty or unavailable targets retain their missing weight/);
    assert.match(section('account'), /Propose a configured private topic through the hall/);
});

test('score copy distinguishes normalized measurements, estimates and unresolved gaps', () => {
    const scores = section('rankings');
    assert.match(scores, /test's score range and direction/);
    assert.match(scores, /same qualifying measurements/);
    assert.match(scores, /Fallback is resolved first/);
    assert.match(scores, /Estimated score:[\s\S]*shared-test estimates/);
    assert.match(scores, /Isolated extreme results have less influence on estimates/);
    assert.match(scores, /incomplete measured coverage reduces the whole total/);
    assert.match(scores, /missing scores count as 0 at the lower end and 100 at the upper end; measured scores stay fixed/);
    assert.match(scores, /Models rank by the lower end/);
    assert.match(scores, /missing scores count as 0 at the lower end and 100 at the upper end/);
    assert.match(scores, /Coverage is the share of weight with measured results/);
    assert.match(scores, /including successful fallbacks/);
    assert.match(scores, /Estimates do not increase coverage/);
    assert.match(scores, /Unresolved gaps are left out/);
    assert.match(scores, /Without a real result on a weighted test, a model cannot rank/);
    assert.match(scores, /effort or harness to rank settings separately/);
    assert.match(scores, /best qualifying score per test/);
    assert.match(scores, /Missing settings stay in an unknown group/);
});

test('fallback copy preserves explicit order, community inheritance, and real zero and negative results', () => {
    const fallback = section('fallback');
    assert.match(fallback, /choose a saved order or edit your own/);
    assert.match(fallback, /chosen version first, then backups in order/);
    assert.match(fallback, /first available score counts/);
    assert.match(fallback, /including zero and negative scores/);
    assert.match(fallback, /No fallback uses the chosen version alone, with estimation still available/);
    assert.match(fallback, /Explicit choices updated within 14 days shape version and fallback proportions per topic\/scene, weighted by benchmark allocation/);
    assert.match(fallback, /Following adds no vote/);
    assert.match(fallback, /deselect your configuration to follow the community again/);
    assert.match(fallback, /Added benchmarks <strong>follow the community<\/strong>/);
    assert.match(fallback, /If nobody has chosen, the index works normally without backups/);
    assert.match(fallback, /Backup versions are selected explicitly/);
    assert.match(fallback, /New versions never join an existing order automatically/);
    assert.doesNotMatch(fallback, /All Other Versions|New versions join automatically/);
});

test('account and evidence copy covers public/private creation and editable identity', () => {
    assert.match(section('account'), /Support up to 3 collecting proposals and author 1/);
    assert.match(section('account'), /Collection lasts 14 days/);
    assert.match(section('account'), /30 other supporters trigger administrator review/);
    assert.doesNotMatch(guide, /topic-proposals|Created by me|Configured by me/);
    assert.match(section('account'), /Private topics and scenes are immediate, editable, and visible only to you/);
    assert.match(section('account'), /display name and avatar in the account dialog/);
    assert.match(section('account'), /GitHub links are your choice/);
    assert.match(section('trust'), /measured results and estimates/);
    assert.match(section('trust'), /All scores/);
    assert.match(section('trust'), /Change information/);
    assert.match(section('trust'), /href="\/contribute\/scores\/new"/);
});

test('guide keeps branded navigation, quiet actions, focus and disclosure behavior', () => {
    assert.match(guide, /class="hi-topbar"/);
    assert.match(guide, /class="bp-brand-lockup"[^>]*src="\/assets\/benchpoll-logo\.svg"/);
    for (const id of ['overview', 'topics', 'personal', 'public', 'rankings', 'fallback', 'account', 'trust']) {
        assert.match(guide, new RegExp(`id="${id}"`));
    }
    for (const id of ['overview', 'personal', 'rankings', 'details']) assert.match(guide, new RegExp(`href="#${id}"`));
    assert.match(styles, /\.bp-how-section\s*\{[^}]*border-top:\s*1px solid var\(--bp-line\)/s);
    assert.doesNotMatch(styles, /border-(?:left|right|bottom):|inset\s+.*var\(--bp-(?:accent|purple)/);
    assert.match(styles, /\.bp-how-primary-link:hover\s*\{[^}]*text-decoration:\s*none/s);
    assert.match(styles, /\.bp-how-primary-link i\s*\{[^}]*color:\s*inherit/s);
    assert.match(styles, /focus-visible/);
    assert.match(styles, /min-height:\s*44px/);
    assert.match(styles, /@media \(max-width:\s*760px\)/);
    assert.match(guide, /id="how-motion"/);
    assert.match(styles, /prefers-reduced-motion/);
    assert.match(script, /requestAnimationFrame\(updateActiveSection\)/);
    assert.match(script, /mountDisclosureMotion\(document\.querySelector\('\.bp-how-content'\), 'details'\)/);
    assert.match(script, /setDisclosureOpen\(details, true, \{ animate: false \}\)/);
    assert.doesNotMatch(script, /how-expand-rules|updateExpandLabel|ruleDetails/);
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

test('Estimated score really uses shared-test estimates and the current coverage multiplier', () => {
    const models = [model(1, { 1: 80 }), model(2, { 1: 60, 2: 50 }), model(3, { 1: 100, 2: 90 }),
        model(4, { 1: 70, 2: 65 }), model(5, { 1: 90, 2: 80 })];
    const [range] = scoreModels(models, weights, 10000, { scoreMode: 'range' });
    const [available] = scoreModels(models, weights, 10000, { scoreMode: 'available' });
    assert.equal(available.availableInference.method, 'pairwise-anchored-rational-coverage-factor');
    assert.equal(available.inferredScores.length, 1);
    assert.equal(available.coverage, 60, 'The estimate must not increase measured coverage');
    assert.deepEqual(available.calculationScores.map(score => [score.conditionID, score.normalizedScore]),
        range.calculationScores.map(score => [score.conditionID, score.normalizedScore]));
    assert.equal(available.availableInference.coverageFactor, 3 / 3.4);
    assert.equal(available.lower, Math.round(available.availableInference.unpenalizedScore * (3 / 3.4) * 100) / 100);
});

test('unresolved gaps stay unmeasured and incomplete coverage does not improve negative totals', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 2500 }, { conditionID: 2, weightBasisPoints: 7500 }];
    const [row] = scoreModels([model(1, { 1: -20 })], entries, 10000, { scoreMode: 'available' });
    assert.equal(row.coverage, 25);
    assert.equal(row.inferredScores.length, 0);
    assert.equal(row.availableInference.unresolvedFraction, .75);
    assert.equal(row.availableInference.unpenalizedScore, -20);
    assert.equal(row.lower, -27.5);
    const missing = [model(2, { 3: 100 })];
    const [unranked] = scoreComparison(missing, entries, 10000, { scoreMode: 'available' },
        comparisonOptions(missing, { mode: 'best', keys: ['model'] }));
    assert.equal(unranked.comparable, false);
    assert.equal(unranked.lower, null);
});

test('both score modes resolve the first fallback before totals, including zero and negative scores', () => {
    const fallbackRules = [{ primaryConditionID: 2, mode: 'ordered', familyID: 9,
        entries: [{ conditionID: 3 }, { conditionID: 4 }] }];
    for (const value of [0, -20]) {
        for (const scoreMode of ['range', 'available']) {
            const [row] = scoreModels([model(1, { 1: 80, 3: value, 4: 90 })], weights, 10000, { scoreMode, fallbackRules });
            assert.equal(row.coverage, 100);
            assert.equal(row.lower, 48 + value * .4);
            assert.equal(row.upper, row.lower);
            assert.deepEqual(row.calculationScores.map(score => score.conditionID), [1, 3]);
            assert.deepEqual(row.fallbackResolutions[0].attemptedConditionIDs, [2, 3]);
            assert.equal(row.inferredScores.length, 0);
        }
    }
});
