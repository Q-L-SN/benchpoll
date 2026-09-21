import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
    return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const home = read('private/home.html');
const homeStyles = read('public/css/workspace-layout.css');
const styles = read('public/css/home-welcome.css');
const script = read('public/js/home-welcome.js');

test('homepage contains a first-visit promotional dialog with one clear primary action', () => {
    assert.match(home, /id="welcome-overlay"[^>]*hidden/);
    assert.match(home, /id="welcome-dialog"[^>]*role="dialog"[^>]*aria-modal="true"/s);
    assert.match(home, /Build your own benchmark mix\./);
    assert.match(home, /Explore Public Weights or create your own model ranking/);
    assert.doesNotMatch(home, /class="bp-welcome-weight-preview"|class="bp-welcome-signals"|class="bp-welcome-eyebrow"/);
    assert.match(home, /id="welcome-primary"/);
    assert.match(home, /Explore rankings/);
    assert.match(home, /id="welcome-methodology"[^>]*href="\/how-it-works"/);
    assert.match(home, /id="mission-welcome-trigger"[^>]*aria-haspopup="dialog"[^>]*aria-controls="welcome-dialog"/s);
    assert.doesNotMatch(home, /post on X|share on X|Join the movement on X|cherry-picked|Shape what AI labs/i);
});

test('welcome is persisted per browser while the page headline can explicitly reopen it', () => {
    assert.match(script, /benchpoll-welcome-seen-v1/);
    assert.match(script, /localStorage\.getItem\(WELCOME_STORAGE_KEY\)/);
    assert.match(script, /localStorage\.setItem\(WELCOME_STORAGE_KEY, '1'\)/);
    assert.match(script, /function showWelcome\(\{ force = false \} = \{\}\)/);
    assert.match(script, /if \(!overlay \|\| !dialog \|\| \(!force && hasSeenWelcome\(\)\)\) return/);
    assert.match(script, /overlay\.hidden = false/);
    assert.match(script, /primaryButton\?\.addEventListener\('click', dismissWelcome\)/);
    assert.match(script, /methodologyLink\?\.addEventListener\('click', rememberWelcome\)/);
    assert.match(script, /missionWelcomeTrigger\?\.addEventListener\('click', \(\) => showWelcome\(\{ force: true \}\)\)/);
    assert.match(home, /<h1><button id="mission-welcome-trigger"[^>]*>Models, measured your way\.<\/button><\/h1>/);
    assert.doesNotMatch(home, /class="bp-mission-banner"/);
    const triggerStyles = homeStyles.match(/#mission-welcome-trigger\s*\{([^}]+)\}/)[1];
    assert.match(triggerStyles, /background:\s*none/);
    assert.match(triggerStyles, /border:\s*0/);
    assert.match(triggerStyles, /cursor:\s*pointer/);
});

test('welcome supports keyboard, backdrop, responsive, and reduced-motion behavior', () => {
    assert.match(script, /event\.key === 'Escape'/);
    assert.match(script, /event\.key !== 'Tab'/);
    assert.match(script, /event\.target === overlay/);
    assert.match(script, /activeElement === dialog \|\| !dialog\.contains\(activeElement\)/);
    assert.match(script, /previouslyFocusedElement\?\.focus/);
    assert.match(styles, /\.bp-welcome-overlay\s*\{[^}]*position:\s*fixed[^}]*backdrop-filter:/s);
    assert.match(styles, /\.bp-welcome-dialog\s*\{[^}]*border-radius:\s*8px[^}]*box-shadow:/s);
    assert.match(styles, /@media \(max-width:\s*640px\)/);
    assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);
});
