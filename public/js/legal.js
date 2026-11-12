import { createTaxonomyDrawer } from './shared/taxonomy-drawer.js?v=privacy-mobile-20261002';
import { enhanceUI } from './shared/ui-components.js';

enhanceUI();
document.querySelectorAll('[data-history-back]').forEach(link => link.addEventListener('click', event => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || history.length < 2) return;
    event.preventDefault(); history.back();
}));

const toggle = document.getElementById('taxonomy-toggle');
const sidebar = document.querySelector('.bp-sidebar');
const setTaxonomyOpen = createTaxonomyDrawer(toggle, sidebar);
const main = document.querySelector('.bp-legal-main');
const links = [...document.querySelectorAll('[data-legal-link]')];
const sections = links.map(link => document.getElementById(link.hash.slice(1)));
const mobile = window.matchMedia('(max-width: 760px)');
let scheduled = false;

function updateCurrentSection() {
    scheduled = false;
    const activationLine = mobile.matches ? 100 : 42;
    let current = sections[0];
    for (const section of sections) {
        if (section.getBoundingClientRect().top <= activationLine) current = section;
    }
    for (const link of links) {
        if (link.hash === `#${current.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
    }
}

function scheduleCurrentSection() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(updateCurrentSection);
}

toggle.addEventListener('click', () => setTaxonomyOpen(!document.body.classList.contains('taxonomy-open')));
document.getElementById('taxonomy-close').addEventListener('click', () => setTaxonomyOpen(false));
document.getElementById('taxonomy-scrim').addEventListener('click', () => setTaxonomyOpen(false));
for (const link of links) link.addEventListener('click', async event => {
    event.preventDefault();
    setTaxonomyOpen(false);
    // The mobile header returns to document flow when the drawer closes.
    // Position the section after that layout change, not before it.
    await new Promise(resolve => {
        function afterDrawerClose() {
            if (document.body.classList.contains('taxonomy-open')) requestAnimationFrame(afterDrawerClose);
            else resolve();
        }
        afterDrawerClose();
    });
    const section = document.getElementById(link.hash.slice(1));
    history.pushState(null, '', link.hash);
    section.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    section.focus({ preventScroll: true });
    scheduleCurrentSection();
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') setTaxonomyOpen(false); });
mobile.addEventListener('change', () => { if (!mobile.matches) setTaxonomyOpen(false); scheduleCurrentSection(); });
main.addEventListener('scroll', scheduleCurrentSection, { passive: true });
window.addEventListener('scroll', scheduleCurrentSection, { passive: true });
window.addEventListener('resize', scheduleCurrentSection, { passive: true });
window.addEventListener('hashchange', scheduleCurrentSection);
document.fonts.ready.then(scheduleCurrentSection);
updateCurrentSection();

void fetch('/api/privacy_information', { headers: { Accept: 'application/json' } })
    .then(response => response.ok ? response.json() : null)
    .then(data => {
        if (!data?.operator) return;
        for (const element of document.querySelectorAll('[data-operator-name]')) {
            element.textContent = data.operator.displayName;
        }
        if (data.operator.email) for (const element of document.querySelectorAll('[data-privacy-email]')) {
            const link = document.createElement('a');
            link.href = `mailto:${data.operator.email}`;
            link.textContent = data.operator.email;
            element.replaceChildren(link);
        }
    }).catch(() => {});
