import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const output = 'D:/Codex-artifacts/website1/disclosure-chevron-20261101';
const launch = { headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } };
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
<link rel="stylesheet" href="/css/global.css"><link rel="stylesheet" href="/css/site-palette.css">
<link rel="stylesheet" href="/css/ui/evidence.css"><link rel="stylesheet" href="/css/ui/fallback.css">
<link rel="stylesheet" href="/css/ui/topic-scenes.css"><link rel="stylesheet" href="/css/how-it-works.css">
<link rel="stylesheet" href="/css/contribute.css"><link rel="stylesheet" href="/css/topics-home.css">
<style>body{margin:0;background:#fff;font:14px Arial,sans-serif}main{width:min(640px,calc(100% - 32px));margin:16px auto}section{padding:12px 0;border-bottom:1px solid #ddd}button,summary{min-height:44px}button{font:inherit}summary{cursor:pointer}p{margin:8px 0}#family,#references{margin-top:12px}</style>
</head><body><main>
<section id="buttons"><button id="plain" data-ui-disclosure aria-expanded="false"><span>Button disclosure</span><i class="fa-solid fa-chevron-down"></i></button>
<button id="tooltip" data-tooltip="An unrelated action" aria-expanded="false"><i class="fa-solid fa-chevron-down"></i></button>
<a id="navigation" href="#destination" aria-expanded="true"><i class="fa-solid fa-chevron-right"></i>Next page</a>
<button id="sort" aria-expanded="true"><i class="fa-solid fa-arrow-down-short-wide"></i></button>
<button id="help" class="bp-help-trigger" aria-expanded="false"><i class="fa-regular fa-circle-question"></i></button></section>
<section><label>Choice<select id="choice"><option>First</option><option>Second</option></select></label></section>
<section id="native-host"><details id="native"><summary>Native disclosure</summary><p>Native contents</p>
<details id="nested"><summary>Nested disclosure</summary><p>Nested contents</p></details></details>
<details id="animated" open><summary class="bp-model-score-detail-heading"><span class="bp-model-score-detail-identity">Animated score</span><span class="bp-model-score-aggregate">42</span></summary><p>Animated contents</p></details>
<details id="configuration"><summary class="bp-model-configuration-heading"><span>Configuration</span><small>12 scores</small></summary><p>Contents</p></details>
<details id="source"><summary class="bp-model-configuration-link"><span>Source</span><small>4 scores</small></summary><p>Contents</p></details>
<details id="interactive"><summary>Interactive summary <button id="nested-action">Action</button></summary><p>Contents</p></details>
<details id="guide" class="bp-how-rule-answer"><summary>Guide answer</summary><p>Answer</p></details>
<details id="version" class="condition-version"><summary><span>Version</span><i class="fa-solid fa-chevron-down"></i></summary><p>Version fields</p></details>
<details id="more"><summary aria-label="More information"><i class="fa-solid fa-ellipsis"></i></summary><p>Menu</p></details>
<details id="menu"><summary aria-haspopup="menu">Actions</summary><p>Menu</p></details></section>
<section id="family"></section><section id="references"></section>
</main><script type="module">
import { enhanceUI, observeDisclosureChevrons, mountDisclosureChevron, createDisclosureTrigger } from '/js/shared/ui-components.js';
import * as motion from '/js/shared/motion.js';
import { createFamilyView } from '/js/workspace/family-view.js';
import { createTopicReferenceSearch } from '/js/workspace/topic-reference-search.js';
window.motion = motion; window.mountChevron = mountDisclosureChevron;
enhanceUI();
observeDisclosureChevrons(); observeDisclosureChevrons(document.querySelector('main'));
motion.mountDisclosureMotion(document.querySelector('#native-host'), '#animated, #interactive');
const plain = document.querySelector('#plain');
plain.onclick = () => plain.setAttribute('aria-expanded', String(plain.getAttribute('aria-expanded') !== 'true'));
const created = createDisclosureTrigger({name:'Created disclosure'}); created.id='created'; document.querySelector('#buttons').append(created);
created.onclick = () => created.setAttribute('aria-expanded', String(created.getAttribute('aria-expanded') !== 'true'));
const primary = {ID:1,conditionID:1,name:'Primary benchmark',conditionName:'Default'};
createFamilyView({container:document.querySelector('#family'),getMemberURL:()=>'/benchmark',onInspectVersion:()=>{}}).renderPublic({primary,
    families:[{primaryConditionID:1,entries:[],weightBasisPoints:9800,overallWeightBasisPoints:9800},
    {primaryConditionID:1,entries:[{ID:2,conditionID:2,name:'Fallback benchmark',conditionName:'Default'}],weightBasisPoints:200,overallWeightBasisPoints:200}]});
const host = document.querySelector('#references');
const targets = [1,2].map(id=>({contextID:5400+id,sceneID:5400+id,categoryID:54,name:'Research / Scene '+id,topicName:'Research',sceneName:'Scene '+id,
    isPrivate:false,hasWeights:true,url:'/research?scene='+String(5400+id)}));
const references = createTopicReferenceSearch({request:async()=>({targets}),getScope:()=> 'one',getCurrentContextID:()=>1,
    getEntries:()=>[],isPrivate:()=>false,canAdd:()=>true,onAdd:()=>true,onChange:()=>references.render(host,'Research',true)});
references.render(host,'Research',true);
window.ready=true;
</script></body></html>`;

async function orientation(page, selector, expected) {
    await page.waitForFunction(({ selector, expected }) => {
        const icon = document.querySelector(selector)?.querySelector(':scope > .bp-ui-disclosure-chevron');
        if (!icon) return false;
        const matrix = new DOMMatrixReadOnly(getComputedStyle(icon).transform);
        const angle = Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI);
        return angle === expected;
    }, { selector, expected });
}

for (const engine of [chromium, webkit]) test(`${engine.name()}: disclosure icons, animation, native semantics and scoped adoption`, async () => {
    const app = await startPreview(), browser = await engine.launch(launch);
    try {
        for (const width of [1280, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 1000 } });
            page.setDefaultTimeout(8000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            await page.route('**/disclosure-fixture', route => route.fulfill({ contentType: 'text/html', body: fixture }));
            await page.goto(app.url + '/disclosure-fixture');
            await page.waitForFunction(() => window.ready);
            await page.locator('#references .bp-reference-topic').waitFor();
            await page.evaluate(() => document.fonts.ready);
            assert.equal(await page.locator('#native > summary > .bp-ui-disclosure-chevron').count(), 1);
            assert.equal(await page.locator('#more > summary > i').count(), 1);
            assert.equal(await page.locator('#more .fa-ellipsis').count(), 1);
            assert.equal(await page.locator('#more > summary, #menu > summary').evaluateAll(nodes => nodes.every(node => !node.hasAttribute('data-ui-disclosure'))), true);
            await page.locator('#more > summary').click();
            assert.equal(await page.locator('#more').evaluate(details => details.open), true);
            await page.evaluate(() => window.motion.setDisclosureOpen(document.querySelector('#menu'), true, { animate: false }));
            assert.equal(await page.locator('#menu .bp-ui-disclosure-chevron').count(), 0);
            assert.equal(await page.locator('#tooltip, #navigation, #sort, #help').evaluateAll(nodes => nodes.every(node => !node.hasAttribute('data-ui-disclosure'))), true);
            assert.equal(await page.locator('#tooltip > i').getAttribute('class'), 'fa-solid fa-chevron-down');
            const css = await page.locator('#plain > i').evaluate(icon => ({
                duration: getComputedStyle(icon).transitionDuration, easing: getComputedStyle(icon).transitionTimingFunction,
                hidden: icon.getAttribute('aria-hidden'), glyph: getComputedStyle(icon, '::before').content
            }));
            assert.equal(css.duration, '0.19s');
            assert.equal(css.easing, 'cubic-bezier(0.22, 1, 0.36, 1)');
            assert.equal(css.hidden, 'true'); assert.notEqual(css.glyph, 'none');
            await orientation(page, '#plain', 0);
            await page.locator('#plain').focus(); await page.keyboard.press('Enter');
            await orientation(page, '#plain', 90);
            assert.equal(await page.locator('#plain').evaluate(node => node === document.activeElement), true);
            await page.keyboard.press('Space'); await orientation(page, '#plain', 0);
            await page.locator('#created').click(); await orientation(page, '#created', 90);
            await page.locator('#native > summary > i').evaluate(icon => {
                window.nativeTransitions = [];
                icon.addEventListener('transitionrun', event => {
                    if (event.propertyName === 'transform') window.nativeTransitions.push(icon.closest('details').open);
                });
            });
            await page.locator('#native > summary').focus(); await page.keyboard.press('Enter');
            await orientation(page, '#native > summary', 90);
            await orientation(page, '#nested > summary', 0);
            await page.locator('#nested > summary').focus(); await page.keyboard.press('Space');
            await orientation(page, '#nested > summary', 90);
            await page.locator('#native').evaluate(details => { details.open = false; });
            await orientation(page, '#native > summary', 0);
            assert.deepEqual(await page.evaluate(() => window.nativeTransitions), [true, false]);
            await page.locator('#nested-action').click();
            assert.equal(await page.locator('#interactive').evaluate(details => details.open), false);
            assert.equal(await page.locator('#guide > summary').evaluate(summary => getComputedStyle(summary, '::after').content), 'none');
            for (const id of ['configuration', 'source']) {
                const bounds = await page.locator(`#${id} > summary`).evaluate(summary => {
                    const icon = summary.querySelector('.bp-ui-disclosure-chevron').getBoundingClientRect();
                    const heading = summary.getBoundingClientRect();
                    return { iconTop: icon.top, iconBottom: icon.bottom, iconRight: icon.right, top: heading.top, bottom: heading.bottom, right: heading.right };
                });
                assert.ok(bounds.iconTop >= bounds.top && bounds.iconBottom <= bounds.bottom && bounds.iconRight <= bounds.right, JSON.stringify(bounds));
            }
            await page.evaluate(() => {
                window.motion.setDisclosureOpen(document.querySelector('#animated'), false);
                window.motion.setDisclosureOpen(document.querySelector('#animated'), true);
                window.lastMotion = window.motion.setDisclosureOpen(document.querySelector('#animated'), false);
            });
            assert.equal(await page.locator('#animated').getAttribute('data-ui-disclosure-open'), 'false');
            assert.equal(await page.locator('#animated').evaluate(details => details.open), true);
            await page.evaluate(() => window.lastMotion);
            assert.equal(await page.locator('#animated').evaluate(details => details.open), false);
            assert.equal(await page.locator('#animated').getAttribute('data-ui-disclosure-open'), null);
            await orientation(page, '#animated > summary', 0);
            const select = page.locator('#choice + .bp-ui-select > button');
            await select.focus(); await page.keyboard.press('ArrowDown');
            await orientation(page, '#choice + .bp-ui-select > button', 90);
            await page.keyboard.press('Escape'); await orientation(page, '#choice + .bp-ui-select > button', 0);
            assert.equal(await select.evaluate(node => node === document.activeElement), true);
            const family = page.locator('#family .bp-family-summary').first();
            await family.click(); await orientation(page, '#family .bp-family-summary', 90);
            await page.locator('#family .bp-family-other-toggle').click();
            await orientation(page, '#family .bp-family-other-toggle', 90);
            const reference = page.locator('#references .bp-reference-topic');
            await reference.evaluate(node => { window.referenceNode = node; window.referenceIcon = node.querySelector('i'); });
            await reference.focus(); await page.keyboard.press('Enter');
            await orientation(page, '#references .bp-reference-topic', 90);
            assert.equal(await reference.evaluate(node => node === window.referenceNode && node.querySelector('i') === window.referenceIcon && node === document.activeElement), true);
            assert.equal(await page.locator('#references .bp-reference-option:visible').count(), 2);
            await page.keyboard.press('Space'); await orientation(page, '#references .bp-reference-topic', 0);
            await page.locator('#references .bp-reference-topic-options').waitFor({ state: 'hidden' });
            await page.evaluate(() => document.querySelector('#native-host').insertAdjacentHTML('beforeend', '<details id="dynamic"><summary>Dynamic</summary><p>Contents</p></details>'));
            await page.locator('#dynamic > summary > .bp-ui-disclosure-chevron').waitFor();
            await page.locator('#dynamic > summary').evaluate(summary => { summary.textContent = 'Replacement'; });
            await page.locator('#dynamic > summary > .bp-ui-disclosure-chevron').waitFor();
            assert.equal(await page.locator('#dynamic > summary > i').count(), 1);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const durations = await page.locator('.bp-ui-disclosure-chevron').evaluateAll(icons => icons.map(icon => getComputedStyle(icon).transitionDuration));
            assert.ok(durations.every(duration => duration === '0s'), JSON.stringify(durations));
            await reference.click(); await orientation(page, '#references .bp-reference-topic', 90);
            await page.locator('#animated > summary').click(); await orientation(page, '#animated > summary', 90);
            assert.equal(await page.locator('#animated').evaluate(node => node.open && !node.hasAttribute('data-ui-disclosure-open')), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await mkdir(output, { recursive: true });
            await page.screenshot({ path: `${output}/${engine.name()}-${width}.png`, fullPage: true });
            assert.deepEqual(errors, []);
            await page.close();
        }
    } finally { await browser.close(); await app.close(); }
});

test('home scene expansion retains the focused trigger and plays the shared transition', async () => {
    const app = await startTopicsPreview(), browser = await chromium.launch(launch);
    try {
        app.state.topics[0].scenes = [{ ID: 101, name: 'General', description: 'General programming', isDefault: true },
            { ID: 102, name: 'Photon design', description: 'Laser systems', isDefault: false }];
        for (const width of [390, 1280]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            page.setDefaultTimeout(8000);
            await page.goto(app.url);
            await page.locator('.th-card[data-topic-id="54"][data-preview-state="loaded"]').waitFor();
            await page.evaluate(() => document.getElementById('topics').scrollIntoView());
            await page.locator('#topic-search-toggle').click();
            await page.locator('#topic-search').fill('Coding');
            const selector = '.th-card[data-topic-id="1"]:not([data-scene-id]) .th-scene-toggle';
            const toggle = page.locator(selector);
            await orientation(page, selector, 0);
            await toggle.evaluate(node => {
                window.homeTrigger = node;
                window.homeTransitions = 0;
                node.querySelector('i').addEventListener('transitionrun', event => {
                    if (event.propertyName === 'transform') window.homeTransitions++;
                });
            });
            await toggle.focus(); await page.keyboard.press('Enter');
            await orientation(page, selector, 90);
            assert.equal(await toggle.evaluate(node => node === window.homeTrigger && node === document.activeElement), true);
            assert.equal(await page.evaluate(() => window.homeTransitions), 1);
            await page.keyboard.press('Space'); await orientation(page, selector, 0);
            assert.equal(await page.evaluate(() => window.homeTransitions), 2);
            assert.equal(await page.locator('.th-card[data-scene-id]:visible').count(), 0);
            await page.close();
        }
    } finally { await browser.close(); await app.close(); }
});
