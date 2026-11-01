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
    assert.equal(hints.length, 2);
    assert.match(home, /id="inline-fallback-add-benchmark"[^>]*data-help-text=/);
    assert.match(home, /aria-label="About missing scores"[^>]*data-help-text=/);
    assert.doesNotMatch(home, /id="agi-promo"/);
    for (const hint of hints) {
        assert.ok(words(hint) <= 32, hint);
        assert.doesNotMatch(hint, /entrance|denominator|normalized|eligible|configuration identity/);
    }
    const publicHelp = home.match(/id="public-pie-tooltip"[^>]*>([\s\S]*?)<\/span>/)[1];
    assert.ok(words(plain(publicHelp)) <= 40);
    assert.match(publicHelp, /^<strong>/);
    assert.match(publicHelp, /href="\/how-it-works#calculation-details"/);
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
    const sections = [...guide.matchAll(/<section([^>]*)>\s*<h2>([^<]+)<\/h2>([\s\S]*?)<\/section>/g)];
    const fallback = sections.find(([, attributes]) => attributes.includes('id="fallback"'));
    assert.ok(fallback, 'Explain explicit backup choices in the visible guide');
    assert.match(fallback[3], /Backup versions are selected explicitly/);
    assert.match(fallback[3], /New versions never join an existing order automatically/);
    assert.match(fallback[3], /Added benchmarks <strong>follow the community<\/strong>/);
    assert.match(fallback[3], /deselect your configuration to follow the community again/);
    for (const [, , heading, content] of sections) {
        assert.ok(words(heading) <= 14, heading);
        for (const [, paragraph] of content.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) assert.ok(words(plain(paragraph)) <= 50, heading);
    }
    assert.doesNotMatch(guide, /grouping button|optional grouping|fair-comparison control|configuration-share denominator/);
    assert.match(guide, /Browse Popular, Recent, or Mine/);
    assert.deepEqual([...home.matchAll(/data-navigation-view="([^"]+)"/g)].map(match => match[1]),
        ['popular', 'recent', 'configured', 'search']);
    assert.match(home, /data-navigation-view="configured"[^>]*aria-label="Mine"/);
    assert.match(guide, /choose a saved order or edit your own/);
    assert.match(guide, /Another topic contributes only through an explicit reference/);
    assert.match(guide, /Private topics and their weights never contribute to Public Weights/);
    assert.match(guide, /effort or harness to rank settings separately/);
    assert.match(guide, /best qualifying score per test/);
    assert.match(guide, /Missing settings stay in an unknown group/);
    assert.match(guide, /Not a confidence interval/);
});

test('contribution instructions distinguish pending requests, public data and run settings', () => {
    const form = read('private/contribute.html');
    assert.match(form, /You do not have to wait for approval/);
    assert.match(form, /Submitted does not mean published/);
    assert.match(form, /Model settings are not test versions/);
    assert.match(form, /explain the differences/);
    assert.match(form, /latest successful update counts/);
    const editor = read('public/js/contribution/score-fields.js');
    assert.match(editor, /\['effort', 'harness'\]/);
    assert.doesNotMatch(editor, /New options need review|createFieldForm|Propose/);
});

test('the entire guide and contribution guide stay brief without a hidden long manual', () => {
    const main = guide.match(/<article[^>]*>([\s\S]*?)<\/article>/)?.[1];
    assert.ok(main, 'Count the real article, not a slice ending at a removed section');
    assert.ok(words(plain(main)) <= 750, String(words(plain(main))));
    assert.match(main, /Collection lasts 14 days/);
    assert.doesNotMatch(main, /72 hours|Public weight =|48 to 88/);
    assert.doesNotMatch(main, /<ol\b|<table\b|Full calculation rules|Expand all/);
    assert.match(guide, /<p id="calculation-details">[\s\S]*?saved personal weight configurations in this topic/);
    assert.match(main, /Backup versions are selected explicitly/);
    assert.doesNotMatch(guide, /id="fallback-versions"|All Other Versions|New versions join automatically/);
    for (const [, paragraph] of main.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) assert.ok(words(plain(paragraph)) <= 55);
    const form = read('private/contribute.html');
    const start = form.indexOf('<div slot="body" class="contribution-guide">');
    const end = form.indexOf('<div slot="actions"><global-dialog-action class="dialog-close-button main">Back to form', start);
    assert.ok(start >= 0 && end > start, 'Count the actual contribution guide');
    const contribution = form.slice(start, end);
    assert.ok(words(plain(contribution)) <= 280, String(words(plain(contribution))));
});
