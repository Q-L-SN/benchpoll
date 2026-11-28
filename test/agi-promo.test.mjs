import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../private/home.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/css/ui/workspace-redesign.css', import.meta.url), 'utf8');

test('the workspace stacks its brand, topic heading and actual summary without layout controls', () => {
    assert.doesNotMatch(html, /AGI needs a public standard|id="agi-promo"/);
    const heading = html.match(/<header class="bp-workspace-header">[\s\S]*?<\/header>/)?.[0];
    assert.ok(heading);
    assert.match(heading, /id="workspace-brand-slot"[\s\S]*<h1 id="workspace-headline"[\s\S]*<p id="workspace-topic-summary"[^>]*hidden><\/p>/);
    assert.match(heading, /<h1 id="workspace-headline"[^>]*><span id="bp-breadcrumb"/);
    assert.doesNotMatch(heading, /bp-agi|bp-help-trigger|circle-question|data-help-text|data-headline-mode/);
    assert.doesNotMatch(html + source + styles, /workspace-header-layout|data-header-layout|benchpoll:header-layout/);
    assert.match(styles, /\.bp-heading-topic-row \{[^}]*flex-direction: column/);
    assert.match(heading, /class="bp-config-header-account">\s*<a id="back-to-topics"[^>]*href="\/"[^>]*aria-label="Home"[^>]*><i class="fa-solid fa-house"[^>]*><\/i><\/a>\s*<button id="header-user-profile"/);
    const actions = html.match(/<div class="bp-context-actions">[\s\S]*?<\/div>/)?.[0];
    assert.match(actions, /id="discussion-entry"/);
    assert.doesNotMatch(actions, /workspace-topic-summary|back-to-topics/);
});

test('AGI and private topics render their actual description with no name-specific promotion', () => {
    assert.match(source, /summary\.textContent = state\.topicSummary/);
    assert.match(source, /summary\.hidden = !state\.topicSummary/);
    assert.doesNotMatch(source, /agi-promo|showAGI|topicName\s*===\s*['"]AGI['"]/);
});
