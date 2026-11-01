import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../private/home.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
const context = html.match(/<div class="bp-context-identity">[\s\S]*?<\/div>/)?.[0];

test('every topic summary occupies the former AGI promo position beside the context path', () => {
    assert.ok(context);
    assert.match(context, /id="bp-breadcrumb"[\s\S]*<p id="workspace-topic-summary"[^>]*hidden><\/p>/);
    assert.doesNotMatch(context, /bp-agi|bp-help-trigger|circle-question|data-help-text/);
    assert.doesNotMatch(html, /AGI needs a public standard|id="agi-promo"/);
    const heading = html.match(/<header class="bp-page-heading">[\s\S]*?<\/header>/)?.[0];
    assert.doesNotMatch(heading, /workspace-topic-summary/);
});

test('AGI and private topics render their actual description with no name-specific promotion', () => {
    assert.match(source, /summary\.textContent = state\.topicSummary/);
    assert.match(source, /summary\.hidden = !state\.topicSummary/);
    assert.doesNotMatch(source, /agi-promo|showAGI|topicName\s*===\s*['"]AGI['"]/);
});
