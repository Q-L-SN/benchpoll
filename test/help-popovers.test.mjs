import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { helpPopoverGeometry } from '../public/js/shared/help-popover.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('help geometry remains within small, scrolled, and zoomed visual viewports', () => {
    for (const width of [160, 320, 390, 1024, 1440]) for (const height of [200, 400, 900]) {
        for (const left of [0, 100]) for (const top of [0, 80]) for (const contentHeight of [40, 180, 1800]) {
            const viewport = { left, top, width, height };
            for (const edge of [0, .5, 1]) {
                const anchor = { top: top + edge * height - 14, bottom: top + edge * height + 14,
                    right: left + edge * width + 14 };
                const result = helpPopoverGeometry(anchor, viewport, contentHeight);
                assert.ok(result.left >= left + 12);
                assert.ok(result.left + result.width <= left + width - 12);
                assert.ok(result.top >= top + 12);
                assert.ok(result.top + Math.min(contentHeight, result.maxHeight) <= top + height - 12);
                assert.ok(result.width <= 380 && result.maxHeight <= height - 24);
            }
        }
    }
});
test('help prefers above and flips below only when above has insufficient space', () => {
    const viewport = { left: 0, top: 0, width: 390, height: 600 };
    assert.equal(helpPopoverGeometry({ right: 230, top: 240, bottom: 268 }, viewport, 120).top, 112);
    assert.equal(helpPopoverGeometry({ right: 230, top: 20, bottom: 48 }, viewport, 120).top, 56);
    assert.equal(helpPopoverGeometry({ right: 230, top: 480, bottom: 508 }, viewport, 120).top, 352);
    assert.equal(helpPopoverGeometry({ right: 230, top: 280, bottom: 320 }, viewport, 120).placement, 'top');
    assert.equal(helpPopoverGeometry({ right: 230, top: 280, bottom: 320 }, viewport, 900).placement, 'top');
    assert.equal(helpPopoverGeometry({ right: 230, top: 180, bottom: 220 }, viewport, 900).placement, 'bottom');
});
test('long help reserves space for the trigger so touch users can tap it again', () => {
    const viewport = { left: 0, top: 0, width: 320, height: 380 };
    for (const top of [20, 160, 330]) {
        const anchor = { top, bottom: top + 28, right: 306 };
        const geometry = helpPopoverGeometry(anchor, viewport, 3000);
        assert.ok(geometry.top + geometry.maxHeight <= anchor.top - 8 || geometry.top >= anchor.bottom + 8);
    }
});
test('the bubble shifts at horizontal edges while its arrow keeps pointing to the trigger', () => {
    const view = { left: 0, top: 0, width: 390, height: 700 };
    for (const left of [8, 160, 338]) {
        const anchor = { left, right: left + 44, top: 300, bottom: 344 };
        const result = helpPopoverGeometry(anchor, view, 80, 240);
        assert.ok(result.left >= 12);
        assert.ok(result.left + result.width <= 378);
        assert.equal(result.left + result.arrowX, left + 22);
        assert.equal(result.placement, 'top');
    }
    const corner = helpPopoverGeometry({ left: 2, right: 12, top: 650, bottom: 694 }, view, 80, 240);
    assert.equal(corner.placement, 'top');
    assert.ok(corner.arrowX >= 12 && corner.arrowX <= corner.width - 12);
});
test('question glyphs provide shared help or direct guide navigation without native titles', () => {
    for (const path of ['private/home.html', 'private/contribute.html']) {
        const html = read(path);
        const questions = [...html.matchAll(/<(button|a)\b([^>]+)>(?:(?!<\/(?:button|a)>)[\s\S])*?fa-circle-question(?:(?!<\/(?:button|a)>)[\s\S])*?<\/(?:button|a)>/g)];
        assert.ok(questions.length);
        for (const [, tag, attrs] of questions) {
            if (tag === 'a' && /id="how-it-works-link"/.test(attrs)) {
                assert.match(attrs, /href="\/how-it-works"/);
                assert.doesNotMatch(attrs, /data-help-(text|content)=/);
            } else assert.match(attrs, /data-help-(text|content)=/);
            assert.doesNotMatch(attrs, /\btitle=/);
        }
    }
    for (const path of ['public/js/home-workspace.js', 'public/js/workspace/comparison-controls.js', 'public/js/workspace/model-scores.js']) {
        assert.match(read(path), /setHelpText\(/);
        assert.doesNotMatch(read(path), /(?:help|duplicateNote)\.title\s*[+=]/);
    }
});
test('duplicate score help is a separate button and does not live inside a source link', () => {
    const source = read('public/js/workspace/model-scores.js');
    assert.match(source, /sourceCell\.append\(source\)/);
    assert.match(source, /sourceCell\.append\(duplicateHelp\)/);
    assert.match(source, /sampleRow\.append\(sampleIndex, sampleScore, sourceCell/);
    assert.doesNotMatch(source, /sourceText\.append\(duplicate/);
});
test('one custom layer handles touch, keyboard, outside dismissal, clipping and resize', () => {
    const source = read('public/js/shared/help-popover.js');
    assert.match(source, /panel\.id = 'bp-help-popover'/);
    assert.match(source, /setAttribute\('popover', 'manual'\)/);
    assert.match(source, /pointerType === 'touch'/);
    assert.match(source, /event\.key === 'Escape'/);
    assert.match(source, /window\.addEventListener\('keydown', event =>/);
    assert.match(source, /!inPath\(event, active\) && !inPath\(event, panel\)/);
    assert.match(source, /window\.visualViewport\?\.addEventListener\('resize'/);
    assert.match(source, /watcher\.observe/);
    assert.match(source, /node\.assignedSlot \?\? node\.parentElement \?\? node\.getRootNode\(\)\.host/);
    assert.match(source, /parent\.removeEventListener\('scroll', schedulePosition\)/);
    assert.match(source, /role', 'tooltip'/);
    assert.doesNotMatch(source, /innerHTML|cursor: help/);
    assert.doesNotMatch(read('public/css/ui/fallback.css'), /bp-inline-fallback-tooltip/);
    assert.doesNotMatch(read('public/css/model-comparison.css'), /bp-quick-comparison-tooltip/);
});
test('Fallback add identifies its target; framed search has no internal underline', () => {
    const html = read('private/home.html');
    assert.match(html, /id="inline-fallback-add-benchmark"[^>]*>[\s\S]*?<span>Add fallback benchmark<\/span>/);
    assert.doesNotMatch(html, /id="inline-fallback-add-other-versions"/);
    assert.doesNotMatch(html + read('public/js/home-workspace.js'), /Adding to fallback|Add other versions to fallback/);
    const style = read('public/css/ui/control-policy.css');
    assert.match(style, /body \.bp-benchmark-search input:focus-visible \{ box-shadow: none !important; \}/);
    assert.match(style, /body \.bp-benchmark-search:has\(input:focus-visible\):not\(\.has-error\):not\(\.has-error \*\) \{ border-color: var\(--bp-accent\) !important; \}/);
});
