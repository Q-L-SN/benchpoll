import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
    return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const home = read('private/home.html');
test('homepage opens directly into rankings without a welcome overlay', () => {
    assert.match(home, /id="workspace-headline"/);
    assert.match(home, /id="how-it-works-link"[^>]*href="\/how-it-works"/);
    assert.doesNotMatch(home, /welcome-overlay|welcome-dialog|home-welcome\.js|home-welcome\.css|mission-welcome-trigger/);
});
