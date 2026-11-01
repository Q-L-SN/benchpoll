import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/workspace/model-scores.js', import.meta.url), 'utf8');
const copy = vm.runInNewContext(source.slice(source.indexOf('const SCORE_SEARCH_COPY'),
    source.indexOf('export function createModelScoresView(')).replace('export ', '') + '\nmodelScoreSearchCopy');

test('score search names its actual evidence level and uses matching empty-state copy', () => {
    for (const [scope, placeholder, empty] of [
        ['ranking', 'Search scores in this ranking', 'No matching scores in this ranking.'],
        ['configurations', 'Find a configuration, benchmark or version', 'No matching configurations or benchmark versions.'],
        ['versions', 'Find a benchmark or version', 'No matching benchmark versions.'],
        ['sources', 'Find a source or score', 'No matching source scores.']
    ]) {
        assert.equal(copy(scope).placeholder, placeholder);
        assert.equal(copy(scope).empty, empty);
    }
    for (const scope of ['unknown', '__proto__', null]) assert.throws(() => copy(scope), /Unknown score search scope/);
});

test('changing evidence levels synchronizes the prompt and accessible name', () => {
    assert.match(source, /search\.placeholder = copy\.placeholder;\s*search\.setAttribute\('aria-label', copy\.placeholder\)/);
    assert.match(source, /noMatches\.textContent = copy\.empty/);
    assert.match(source, /setSearchScope\('ranking'\)/);
    assert.match(source, /setSearchScope\('configurations'\)/);
});

test('ranking searches filter loaded source rows and restore disclosure states on clear', () => {
    assert.match(source, /function filterRankingScores\(view\)/);
    assert.match(source, /item\.sample\.hidden = Boolean\(query\)/);
    assert.match(source, /view\.browsing = new Map/);
    assert.match(source, /setDisclosureOpen\(row, open, \{ animate: false \}\)/);
    assert.match(source, /querySelectorAll\('a\[href\]'\)/);
    assert.match(source, /createTreeWalker\(row, globalThis\.NodeFilter\.SHOW_TEXT\)/);
    assert.match(source, /text\.join\(' '\)/);
    const configurations = source.slice(source.indexOf('function renderAllConfigurations('), source.indexOf('function filterAllConfigurations('));
    assert.match(configurations, /filterScores\(\);\s*animateContent/);
});
