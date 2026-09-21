import { frontendSource } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
    return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const home = read('private/home.html');
const guide = read('private/how-it-works.html');
const guideStyles = read('public/css/how-it-works.css');
const guideScript = read('public/js/how-it-works.js');
const workspace = frontendSource('public/js/home-workspace.js');
const server = read('server.js');

test('homepage How it works control navigates to a page instead of opening a dialog', () => {
    assert.match(home, /id="how-it-works-link"[^>]*href="\/how-it-works"/);
    assert.doesNotMatch(home, /how-it-works-dialog|how-it-works-button/);
    assert.doesNotMatch(workspace, /howItWorksDialog|howItWorksButton/);
});

test('methodology page documents the complete ranking pipeline', () => {
    assert.match(guide, /<h1>How BenchPoll works<\/h1>/);
    assert.match(guide, /Build your own benchmark mix/);
    assert.match(guide, /compare it with Public Weights/);
    assert.match(guide, /model leaderboard those public priorities produce/);
    for (const section of ['overview', 'context', 'personal', 'public', 'rankings', 'trust']) {
        assert.match(guide, new RegExp(`id="${section}"`));
        assert.match(guide, new RegExp(`href="#${section}"`));
    }
    assert.match(guide, /either empty or total exactly 100%/);
    assert.match(guide, /Every benchmark test condition is a separate weightable object/);
    assert.match(guide, /Benchmarks absent from a person's allocation count as 0%/);
    assert.match(guide, /W<sub>b<\/sub> = \(1 \/ N\)/);
    assert.match(guide, /lower bound treats that missing share as 0/);
    assert.match(guide, /upper bound treats it as 100/);
    assert.match(guide, /Score submissions require a source URL/);
    assert.match(guide, /uses the median when multiple samples exist/);
    assert.doesNotMatch(guide, /global-dialog|popup|modal/i);
});

test('methodology page follows the homepage sidebar and responsive visual system', () => {
    assert.match(guide, /class="bp-sidebar bp-how-sidebar"/);
    assert.match(guide, /class="bp-brand-lockup"[^>]*src="\/assets\/benchpoll-logo\.svg"/);
    assert.match(guideStyles, /\.bp-how-header\s*\{[^}]*border-radius:\s*8px[^}]*box-shadow:/s);
    assert.match(guideStyles, /\.bp-how-section\s*\{[^}]*border-bottom:/s);
    assert.match(guideStyles, /\.bp-how-nav a\.is-active/);
    assert.match(guideStyles, /@media \(max-width:\s*760px\)/);
    assert.match(guideScript, /classList\.toggle\('taxonomy-open'/);
    assert.match(guideScript, /requestAnimationFrame\(updateActiveSection\)/);
});

test('How it works route resolves before the generic error-page catchall', () => {
    const guideRoute = server.indexOf("page.get('/how-it-works'");
    const catchall = server.indexOf("page.get('/*any_path'");
    assert.ok(guideRoute >= 0);
    assert.ok(catchall > guideRoute);
    assert.match(server.slice(guideRoute, catchall), /private\/how-it-works\.html/);
});
