import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { betaFeedbackTemplate, bulkImportTemplate, mergeRequestTemplate, privacyRequestTemplate,
    feedbackGuidance, feedbackMessageLimit, feedbackSubmission } from '../public/js/shared/feedback-templates.js';

test('all templates are short instruction paragraphs without editable filler', () => {
    const templates = [betaFeedbackTemplate(), bulkImportTemplate(),
        mergeRequestTemplate({ name: 'A benchmark', kind: 'benchmark', ID: 7 }), privacyRequestTemplate()];
    for (const text of templates) {
        assert.doesNotMatch(text, /[\r\n]|\[[^\]]+\]/);
        assert.ok(text.length < 500);
        assert.doesNotMatch(text, /What I was doing|What I expected|Steps to reproduce|Additional notes|Object page/);
    }
});

test('instructions ask for concrete information rather than field annotations', () => {
    const templates = [betaFeedbackTemplate(), bulkImportTemplate(),
        mergeRequestTemplate({ name: 'A benchmark', kind: 'benchmark', ID: 7 }), privacyRequestTemplate()];
    for (const text of templates) {
        assert.doesNotMatch(text, /\b(?:editable|public|optional):/i);
    }
    assert.match(betaFeedbackTemplate(), /change.*problem.*link or example/);
    assert.match(privacyRequestTemplate(), /access, correct, or delete/);
});

test('template record names retain semantic Public and Editable text', () => {
    assert.match(mergeRequestTemplate({ name: 'Public Weights', kind: 'benchmark', ID: 7 }),
        /To merge Public Weights \(benchmark #7\)/);
    assert.match(bulkImportTemplate({ query: 'Editable benchmark', categoryPath: 'Public/Tools' }),
        /Requested benchmark: Editable benchmark.*Topic: Public\/Tools/);
});

test('bulk requests retain the searched benchmark and context without asking for them twice', () => {
    const text = bulkImportTemplate({ query: '  CyberGym  ', categoryPath: 'Intelligence/Work', contextValues: { operating_system: 'Linux' } });
    assert.match(text, /Requested benchmark: CyberGym/);
    assert.equal((text.match(/CyberGym/g) ?? []).length, 1);
    assert.match(text, /Topic: Intelligence\/Work/);
    assert.match(text, /operating system: Linux/);
    assert.match(text, /model scores and versions to include/);
});

test('merge requests make source and destination direction explicit', () => {
    const text = mergeRequestTemplate({ name: 'Duplicate name', kind: 'model', ID: 11 });
    assert.match(text, /To merge Duplicate name \(model #11\)/);
    assert.match(text, /which item to keep \(name, ID, or link\)/);
});

test('legacy handoffs become paragraphs while retaining object and topic context', () => {
    const bulk = ['Bulk import request', '', 'Benchmarks:', 'CyberGym', '', 'Official sources:', '[Links]', '',
        'Scores to include:', '[Models and versions]', '', 'Category: Intelligence/Work', 'Task options: operating system: Linux'].join('\n');
    const text = feedbackGuidance(bulk);
    assert.match(text, /Requested benchmark: CyberGym.*Topic: Intelligence\/Work.*operating system: Linux/);
    assert.doesNotMatch(text, /\[|\n/);
    assert.equal((text.match(/CyberGym/g) ?? []).length, 1);
    const merge = feedbackGuidance('Merge request\n\nDuplicate to merge:\nPublic Weights (benchmark #7)\n\nItem to keep:\n[Name, ID, or link]\n\nWhy they are duplicates:\n[Explain why]');
    assert.match(merge, /To merge Public Weights \(benchmark #7\)/);
    assert.doesNotMatch(merge, /\[|\n/);
    assert.equal(feedbackGuidance('Beta feedback\n\nSuggested change:\n[What should change?]'), betaFeedbackTemplate());
    assert.equal(feedbackGuidance('Privacy request\n\nWhat I need:\n[Describe the request]'), privacyRequestTemplate());
    assert.equal(feedbackGuidance(), betaFeedbackTemplate());
    assert.equal(feedbackGuidance('Existing context\nsecond line'), 'Existing context second line');
    const supplied = feedbackGuidance('Bulk import request\n\nBenchmarks:\n[Research] benchmark\n\nOfficial sources:\nhttps://example.com/one\nhttps://example.com/two\n\nScores to include:\nGPT models\nTask options: operating system: Linux');
    assert.match(supplied, /\[Research\] benchmark/);
    assert.match(supplied, /https:\/\/example\.com\/one https:\/\/example\.com\/two/);
    assert.equal((supplied.match(/operating system: Linux/g) ?? []).length, 1);
});

test('submission prepends guidance once without changing the message, including retry and Unicode', () => {
    const guidance = bulkImportTemplate({ query: 'CyberGym' });
    const message = 'Please import these scores.\nKeep the original source links. \u6d4b\u8bd5';
    const first = feedbackSubmission(guidance, message);
    assert.equal(first, guidance + '\n\n' + message);
    assert.equal(feedbackSubmission(guidance, message), first);
    assert.equal((first.match(/For a bulk import/g) ?? []).length, 1);
    assert.equal(message, 'Please import these scores.\nKeep the original source links. \u6d4b\u8bd5');
    for (const invalid of ['', ' ', 'too short']) assert.throws(() => feedbackSubmission(guidance, invalid), /more detail/);
});

test('length budgeting includes the full prefix and never silently truncates user content', () => {
    for (const guidance of [betaFeedbackTemplate(), bulkImportTemplate(), mergeRequestTemplate({ name: 'Example', kind: 'model', ID: 3 }), privacyRequestTemplate()]) {
        const limit = feedbackMessageLimit(guidance);
        assert.equal(feedbackSubmission(guidance, 'x'.repeat(limit)).length, 4000);
        assert.throws(() => feedbackSubmission(guidance, 'x'.repeat(limit + 1)), /too long/);
    }
    assert.equal(feedbackMessageLimit('x'.repeat(4000)), 0);
    assert.throws(() => feedbackSubmission('x'.repeat(4000), 'A valid message.'), /too long/);
});

test('the editor is separate from browser-translatable instructions and submits a composed payload', async () => {
    const code = await readFile(new URL('../public/js/contribute.js', import.meta.url), 'utf8');
    assert.match(code, /const feedbackInstructions = feedbackGuidance\(params\.get\('details'\)\)/);
    assert.match(code, /feedback: \{\s*details: ''\s*\}/);
    assert.match(code, /<p id="feedback-guidance"[^>]*translate="yes">\$\{escapeHTML\(feedbackInstructions\)\}/);
    assert.match(code, /aria-describedby="feedback-guidance"/);
    assert.match(code, /details: feedbackSubmission\(feedbackInstructions, draft\.feedback\.details\)/);
    assert.match(code, /window\.addEventListener\('hashchange'/);
    assert.match(code, /new URLSearchParams\(location\.hash\.slice\(1\)\)\.has\('entry'\)\) location\.reload\(\)/);
});

test('the contribution sidebar opens shared bulk-import guidance', async () => {
    const html = await readFile(new URL('../private/contribute.html', import.meta.url), 'utf8');
    const code = await readFile(new URL('../public/js/contribute.js', import.meta.url), 'utf8');
    assert.match(html, /id="contribution-bulk-import" class="bp-sidebar-action"/);
    assert.match(html, /Request bulk import/);
    assert.match(code, /getElementById\('contribution-bulk-import'\)\.addEventListener\('click'/);
    assert.match(code, /details: bulkImportTemplate\(\), pageURL:/);
});

test('all prefilled feedback entry points use the shared templates', async () => {
    for (const [file, name] of [['topics-home.js', 'betaFeedbackTemplate'],
        ['contribute.js', 'mergeRequestTemplate'], ['home-workspace.js', 'bulkImportTemplate']]) {
        const text = await readFile(new URL('../public/js/' + file, import.meta.url), 'utf8');
        assert.match(text, new RegExp(`import.*${name}.*feedback-templates`));
        assert.match(text, /pageURL:/);
    }
});

test('privacy requests no longer depend on the signed-in contribution form', async () => {
    const privacy = await readFile(new URL('../private/privacy.html', import.meta.url), 'utf8');
    const code = await readFile(new URL('../public/js/legal.js', import.meta.url), 'utf8');
    assert.match(privacy, /href="\/account\/privacy#request"/);
    assert.doesNotMatch(code, /privacyRequestTemplate|buildContributionURL/);
});

test('account actions share the site primitives and keep destructive operations separately confirmed', async () => {
    const html = await readFile(new URL('../private/home.html', import.meta.url), 'utf8');
    const account = await readFile(new URL('../public/js/shared/account-center.js', import.meta.url), 'utf8');
    assert.match(account, /Close your account/);
    assert.match(account, /createAction/);
    assert.doesNotMatch(account, /innerHTML|global-dialog-action|slot="actions"/);
    assert.match(account, /startView\('logout', 'Log out\?'\)/);
    assert.match(account, /startView\('deactivate', 'Deactivate your account\?'\)/);
    assert.match(account, /commit\('\/api\/logout', 'logout'\)/);
    assert.match(account, /commit\('\/api\/delete_account', 'deactivate'\)/);
    assert.match(account, /pageAccountWriteScope\.write/);
    assert.doesNotMatch(html, /<global-dialog id="user-account-dialog"/);
});
