import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const words = text => text.split(/\s+/).filter(Boolean).length;
const home = read('private/home.html');
const guide = read('private/how-it-works.html');

test('short homepage hints explain the immediate choice without a calculation essay', () => {
    const hints = [...home.matchAll(/data-help-text="([^"]+)"/g)].map(match => match[1]);
    assert.equal(hints.length, 3);
    assert.match(home, /id="inline-fallback-add-benchmark"[^>]*data-help-text=/);
    assert.match(home, /aria-label="About missing scores"[^>]*data-help-text=/);
    assert.doesNotMatch(home, /id="agi-promo"/);
    for (const hint of hints) {
        assert.ok(words(hint) <= 32, hint);
        assert.doesNotMatch(hint, /entrance|denominator|normalized|configuration identity/);
    }
    const publicSummary = home.match(/<div id="public-pie-summary"[^>]*>[\s\S]*?<\/div>/)?.[0];
    assert.ok(publicSummary);
    assert.match(publicSummary, /role="img" tabindex="0"/);
    assert.match(publicSummary, /fa-users[^>]*><\/i><span id="public-pie-count"/);
    assert.doesNotMatch(publicSummary, /circle-question|public-pie-tooltip|data-help-text/);
    const workspace = read('public/js/home-workspace.js');
    const publicHelp = workspace.match(/publicPieSummary\.dataset\.tooltip = `([^`]+)`/)[1];
    assert.ok(words(publicHelp) <= 40);
    assert.match(publicHelp, /saved weight[^`]*shape these public weights\./);
    assert.match(workspace, /publicPieSummary\.setAttribute\('aria-label', publicPieSummary\.dataset\.tooltip\)/);
});

test('static JavaScript question hints remain short and use ordinary language', () => {
    const { parse } = createRequire(import.meta.url)('espree');
    let count = 0;
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.name === 'setHelpText' && node.arguments[1]?.type === 'Literal') {
            const text = node.arguments[1].value;
            assert.ok(words(text) <= 55, text);
            assert.doesNotMatch(text, /denominator|weighted share within this entrance|extra votes to the median/);
            count++;
        }
        for (const child of Object.values(node)) {
            if (Array.isArray(child)) child.forEach(visit);
            else if (child && typeof child === 'object') visit(child);
        }
    };
    for (const path of ['public/js/workspace/fallback-picker.js', 'public/js/workspace/model-scores.js']) {
        visit(parse(read(path), { ecmaVersion: 'latest', sourceType: 'module' }));
    }
    assert.equal(count, 2);
});

test('short explanations name current navigation and preserve practical scoring and privacy choices', () => {
    const fallback = guide.slice(guide.indexOf('<h3 id="fallback"'), guide.indexOf('<h3 id="calibration"'));
    assert.match(fallback, /Versions of the same benchmark are eligible by default, including with no votes or a tie/);
    assert.match(fallback, /Your own vote takes priority for your personal ranking/);
    assert.match(fallback, /Tap the same thumb to clear it/);
    assert.doesNotMatch(guide, /grouping button|optional grouping|fair-comparison control|configuration-share denominator/);
    assert.match(guide, /topic menu to find favorites, topics you configured or created, recent visits, or search/);
    assert.match(home, /id="sidebar-topic-collection" aria-label="Topic collection"/);
    assert.match(guide, /choose a <strong>Scoring version<\/strong>/);
    assert.match(guide, /Another public topic contributes only through an explicit reference/);
    assert.match(guide, /Public topics can reference public topics and scenes/);
    assert.match(guide, /effort or harness to rank settings separately/);
    assert.match(guide, /best qualifying score per test/);
    assert.match(guide, /Missing settings stay in an unknown group/);
    assert.match(guide, /uses 0 at the lower end and 100 at the upper end for missing measurements/);
});

test('contribution instructions distinguish pending requests, public data and run settings', () => {
    const form = read('private/contribute.html');
    assert.match(form, /You can reference your own pending additions while they are reviewed/);
    assert.match(form, /A reviewer checks catalogue contributions before updating public data/);
    assert.match(form, /Topics are created and published directly from Home without review/);
    assert.match(form, /Record model settings with the score/);
    assert.match(form, /explain the differences/);
    assert.match(form, /latest successful update/);
    const editor = read('public/js/contribution/score-fields.js');
    assert.match(editor, /\['effort', 'harness'\]/);
    assert.doesNotMatch(editor, /New options need review|createFieldForm|Propose/);
});

test('guide and contribution instructions use concise copy', () => {
    const main = guide.match(/<article[^>]*>([\s\S]*?)<\/article>/)?.[1].replace(/<nav[\s\S]*?<\/nav>/, '');
    assert.ok(main);
    assert.ok(words(plain(main)) <= 1150, String(words(plain(main))));
    assert.match(main, /Choose <strong>Public<\/strong> or <strong>Private<\/strong> when creating a topic/);
    assert.match(main, /Public topics appear as soon as you publish\. You can have up to three public topics at a time\./);
    assert.doesNotMatch(main, /Collection lasts 14 days|Proposal Hall|proposal hall/);
    assert.match(main, /<h4 id="calculation-details"[^>]*>[^<]+<\/h4>\s*<p>[^<]*past 72 hours/);
    assert.match(main, /eligible measured versions of the same benchmark/);
    for (const [, paragraph] of main.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) assert.ok(words(plain(paragraph)) <= 55);
    const form = read('private/contribute.html');
    const start = form.indexOf('<div slot="body" class="contribution-guide">');
    const end = form.indexOf('<div slot="actions"><global-dialog-action class="dialog-close-button main">Back to form', start);
    assert.ok(start >= 0 && end > start, 'Count the actual contribution guide');
    const contribution = form.slice(start, end);
    assert.ok(words(plain(contribution)) <= 280, String(words(plain(contribution))));
});
