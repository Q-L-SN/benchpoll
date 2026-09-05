import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
    return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const home = read('private/home.html');
const homeStyles = read('public/css/home-v2.css');
const styles = read('public/css/home-welcome.css');
const script = read('public/js/home-welcome.js');

test('homepage contains a first-visit promotional dialog with one clear primary action', () => {
    assert.match(home, /id="welcome-overlay"[^>]*hidden/);
    assert.match(home, /id="welcome-dialog"[^>]*role="dialog"[^>]*aria-modal="true"/s);
    assert.match(home, /Build your own benchmark mix\./);
    assert.match(home, /compare your mix with Public Weights/);
    assert.match(home, /View the public model ranking/);
    assert.match(home, /id="welcome-primary"/);
    assert.match(home, /Explore weights and rankings/);
    assert.match(home, /id="welcome-methodology"[^>]*href="\/how-it-works"/);
    assert.match(home, /id="mission-welcome-trigger"[^>]*aria-haspopup="dialog"[^>]*aria-controls="welcome-dialog"/s);
    assert.doesNotMatch(home, /post on X|share on X|Join the movement on X|cherry-picked|Shape what AI labs/i);
});

test('welcome is persisted per browser while the mission banner can explicitly reopen it', () => {
    assert.match(script, /benchpoll-welcome-seen-v1/);
    assert.match(script, /localStorage\.getItem\(WELCOME_STORAGE_KEY\)/);
    assert.match(script, /localStorage\.setItem\(WELCOME_STORAGE_KEY, '1'\)/);
    assert.match(script, /function showWelcome\(\{ force = false \} = \{\}\)/);
    assert.match(script, /if \(!overlay \|\| !dialog \|\| \(!force && hasSeenWelcome\(\)\)\) return/);
    assert.match(script, /overlay\.hidden = false/);
    assert.match(script, /primaryButton\?\.addEventListener\('click', dismissWelcome\)/);
    assert.match(script, /methodologyLink\?\.addEventListener\('click', rememberWelcome\)/);
    assert.match(script, /missionWelcomeTrigger\?\.addEventListener\('click', \(\) => showWelcome\(\{ force: true \}\)\)/);
    assert.match(homeStyles, /\.bp-mission-trigger\s*\{[^}]*border:\s*0[^}]*background:\s*transparent[^}]*cursor:\s*pointer/s);
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
