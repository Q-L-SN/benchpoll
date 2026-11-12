import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { updateEvidenceCount } from '../public/js/shared/evidence-count.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
function countElement() {
    const value = { textContent: '' }, attributes = {};
    return { value, attributes, dataset: {}, querySelector(selector) {
        assert.equal(selector, '.bp-evidence-count-value');
        return value;
    }, setAttribute(name, text) { attributes[name] = text; } };
}

test('model evidence counts retain zero, singular and plural values without visible prose', () => {
    const element = countElement();
    for (const count of [0, 1, 12345]) {
        assert.equal(updateEvidenceCount(element, count, { kind: 'models' }), element);
        assert.equal(element.value.textContent, String(count));
        assert.equal(element.dataset.tooltip, `Scores from ${count} ${count === 1 ? 'model' : 'models'}.`);
        assert.equal(element.attributes['aria-label'], element.dataset.tooltip);
    }
});

test('approved score counts preserve their independent model count, including zero', () => {
    const element = countElement();
    for (const [count, modelCount, description] of [
        [0, 0, '0 approved scores from 0 models.'],
        [1, 1, '1 approved score from 1 model.'],
        [8, 6, '8 approved scores from 6 models.'],
        [14, 0, '14 approved scores from 0 models.']
    ]) {
        updateEvidenceCount(element, count, { modelCount });
        assert.equal(element.value.textContent, String(count));
        assert.equal(element.dataset.tooltip, description);
        assert.equal(element.attributes['aria-label'], description);
    }
    updateEvidenceCount(element, 2);
    assert.equal(element.dataset.tooltip, '2 approved scores.');
});

test('counts share a focusable FontAwesome component and the existing tooltip contract', () => {
    const component = read('public/js/shared/evidence-count.js');
    assert.match(component, /element\.tabIndex = 0/);
    assert.match(component, /setAttribute\('role', 'img'\)/);
    assert.match(component, /fa-solid fa-chart-simple" aria-hidden="true"/);
    assert.match(component, /bp-evidence-count-value" aria-hidden="true"/);
    assert.doesNotMatch(component, /\.title\s*=|data-help-text|addEventListener/);
    const styles = read('public/css/ui/evidence-count.css');
    assert.match(styles, /:focus-visible\s*\{[^}]*outline: 2px solid/);
    assert.match(styles, /@media \(pointer: coarse\)[\s\S]*min-width: 44px; min-height: 44px/);
    assert.doesNotMatch(styles, /border-(left|right|top|bottom):|box-shadow|::before|::after/);
});

test('workspace links the selected block and shows model counts beside its name plus a public saved-set count', () => {
    const source = read('public/js/home-workspace.js');
    assert.match(source, /createEvidenceCount\(object\.scoredModelCount \?\? object\.scoreCount, \{ kind: object\.scoredModelCount == null \? 'scores' : 'models' \}\)/);
    assert.match(source, /!isTopicReference\(selected\) && typeof selected.scoredModelCount === 'number'/);
    assert.match(source, /updateEvidenceCount\(pieModelCount, selected.scoredModelCount, \{ kind: 'models' \}\)/);
    assert.match(source, /pieModelCount\.parentElement !== pieContextNote/);
    assert.match(source, /personalPieGuidance\.hidden = !selected \|\| personalPieStart\.isOpen/);
    assert.match(source, /pieInstruction\.replaceChildren\(\)/);
    assert.match(source, /if \(selected\) pieInstruction\.append\(createBenchmarkInformationLink\(selected, \{/);
    assert.match(source, /className: 'bp-selected-weight-link'/);
    assert.match(source, /publicPieCount\.textContent = state\.publicParticipantCount\.toLocaleString\('en-US'\)/);
    assert.match(source, /publicPieSummary\.dataset\.tooltip = `[^`]*saved weight[^`]*shape these public weights\./);
    assert.match(source, /publicPieSummary\.setAttribute\('aria-label', publicPieSummary\.dataset\.tooltip\)/);
    const html = read('private/home.html');
    assert.match(html, /id="personal-pie-guidance"[^>]*>[\s\S]*?<p id="pie-instruction"><\/p>\s*<p id="pie-context-note"><\/p>/);
    const publicCount = html.match(/<div id="public-pie-summary"[^>]*>[\s\S]*?<\/div>/)?.[0];
    assert.match(publicCount, /role="img" tabindex="0"/);
    assert.match(publicCount, /<i class="fa-solid fa-users"[^>]*><\/i><span id="public-pie-count"/);
    assert.doesNotMatch(publicCount, /circle-question|public-pie-tooltip|<strong>/);
    const styles = read('public/css/ui/workspace-redesign.css');
    assert.match(styles, /\.bp-pie-tools-row \.bp-pie-guidance \{[^}]*display: flex;[^}]*flex-wrap: nowrap;[^}]*align-items: baseline;[^}]*justify-content: flex-start/);
    assert.doesNotMatch(source, /Tap a block, then swipe to adjust\./);
    const heading = source.slice(source.indexOf('function renderSelectedWeightHeading()'), source.indexOf('function renderReferenceState()'));
    assert.doesNotMatch(heading, /Select a weight block to inspect its benchmark\./);
    assert.match(source, /<strong>No benchmark selected<\/strong><span>Select a weight block to inspect its benchmark\.<\/span>/);
    assert.doesNotMatch(source, /Tap a slice|Select a slice|Select a weight slice|scoreCount\.textContent/);
});

test('the remaining fallback action spans the entire former two-action footer', () => {
    const styles = read('public/css/ui/fallback.css');
    assert.match(styles, /@import url\('\.\/evidence-count\.css'\);/);
    assert.match(styles, /\.bp-fallback-add-actions \{[^}]*width: 100%; grid-template-columns: minmax\(0, 1fr\)/);
    assert.doesNotMatch(styles, /\.bp-fallback-add-actions \{[^}]*repeat\(2/);
    assert.match(styles, /\.bp-fallback-add-actions > button \{[^}]*min-height: 44px/);
    const html = read('private/home.html');
    assert.match(html, /id="inline-fallback-add-benchmark"/);
    assert.doesNotMatch(html, /inline-fallback-add-other-versions|All Other Versions/);
});
