import { mountDisclosureMotion, setDisclosureOpen } from './shared/motion.js';
import { enhanceUI } from './shared/ui-components.js';

enhanceUI();
mountDisclosureMotion(document.querySelector('.bp-how-content'), 'details');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionButton = document.getElementById('how-motion');
const demo = document.querySelector('.hi-demo');
const priorityButtons = [...document.querySelectorAll('[data-priority]')];
const columns = [...document.querySelectorAll('[data-demo-model]')];
// A complete, synthetic score matrix keeps the illustration independent of live rankings.
const measurements = { a: [78, 96, 64], b: [94, 62, 89], c: [83, 83, 83], d: [65, 81, 96] };
const priorities = { balanced: [34, 33, 33], coding: [15, 70, 15], reasoning: [70, 15, 15] };
let selected = 'balanced', paused = reduced.matches, demoVisible = true, timer;
function applyPriority(key, announce = false) {
    selected = key;
    const ranking = Object.entries(measurements).map(([id, scores]) => ({ id,
        score: scores.reduce((total, score, i) => total + score * priorities[key][i] / 100, 0)
    })).sort((a, b) => b.score - a.score);
    columns.forEach(column => {
        const slot = ranking.findIndex(row => row.id === column.dataset.demoModel);
        column.style.setProperty('--slot', String(slot));
        column.style.setProperty('--height', `${ranking[slot].score - 4}%`);
        column.setAttribute('aria-label', `Rank ${slot + 1}: Model ${column.dataset.demoModel.toUpperCase()}`);
    });
    priorityButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.priority === key)));
    if (announce) document.getElementById('how-demo-status').textContent = `${priorityButtons.find(button => button.dataset.priority === key).textContent} priorities. Model ${ranking[0].id.toUpperCase()} ranks first.`;
}
function updateMotion() {
    clearInterval(timer);
    document.body.dataset.motionPaused = String(paused || reduced.matches || document.hidden);
    motionButton.hidden = reduced.matches;
    motionButton.setAttribute('aria-pressed', String(paused));
    motionButton.setAttribute('aria-label', paused ? 'Play animations' : 'Pause animations');
    motionButton.querySelector('i').className = `fa-solid fa-${paused ? 'play' : 'pause'}`;
    if (paused || reduced.matches || document.hidden || !demoVisible) return;
    timer = setInterval(() => {
        const keys = Object.keys(priorities);
        applyPriority(keys[(keys.indexOf(selected) + 1) % keys.length]);
    }, 5500);
}
priorityButtons.forEach(button => button.addEventListener('click', () => {
    paused = true; updateMotion(); applyPriority(button.dataset.priority, true);
}));
motionButton.addEventListener('click', () => { paused = !paused; updateMotion(); });
reduced.addEventListener('change', () => { paused = reduced.matches; updateMotion(); });
document.addEventListener('visibilitychange', updateMotion);
if ('IntersectionObserver' in window) {
    const visibility = new window.IntersectionObserver(([entry]) => { demoVisible = entry.isIntersecting; updateMotion(); });
    visibility.observe(demo);
    const reveals = new window.IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('is-visible'); reveals.unobserve(entry.target);
        });
    }, { rootMargin: '0px 0px -30px 0px', threshold: .06 });
    document.body.classList.add('motion-ready');
    document.querySelectorAll('[data-reveal]').forEach(element => reveals.observe(element));
}
applyPriority(selected);
updateMotion();

const scoreExample = document.querySelector('.hi-score-art');
const scoreButtons = [...document.querySelectorAll('[data-how-score]')];
scoreButtons.forEach(button => button.addEventListener('click', () => {
    const range = button.dataset.howScore === 'range';
    scoreExample.dataset.mode = button.dataset.howScore;
    scoreButtons.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    document.getElementById('how-score-number').textContent = range ? '48–88' : '60';
    const caption = range ? 'Measured results stay fixed. The range reflects missing results.' : 'An illustrative score after coverage adjustment.';
    document.getElementById('how-score-caption').textContent = caption;
    document.getElementById('how-score-status').textContent = `${range ? 'Score range 48 to 88' : 'Estimated score 60'}. Measured coverage 60%.`;
}));

const links = [...document.querySelectorAll('[data-how-link]')];
let activeFrame;
function updateActiveSection() {
    activeFrame = null;
    let current = links[0];
    for (const link of links) if (document.querySelector(link.hash).getBoundingClientRect().top <= 160) current = link;
    links.forEach(link => {
        if (link === current) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
    });
}
window.addEventListener('scroll', () => {
    if (!activeFrame) activeFrame = requestAnimationFrame(updateActiveSection);
}, { passive: true });
updateActiveSection();
async function revealLinkedDetails() {
    const target = document.getElementById(window.location.hash.slice(1));
    if (!target) return;
    const ancestors = [];
    for (let node = target.closest('details'); node; node = node.parentElement.closest('details')) ancestors.unshift(node);
    if (target.matches('section') && target.querySelector(':scope > details')) ancestors.push(target.querySelector(':scope > details'));
    for (const details of ancestors) await setDisclosureOpen(details, true, { animate: false });
    if (ancestors.length) target.scrollIntoView({ block: 'start', behavior: 'instant' });
}
window.addEventListener('hashchange', () => { void revealLinkedDetails(); });
void revealLinkedDetails();
