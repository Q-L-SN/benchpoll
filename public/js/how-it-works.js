const taxonomyToggle = document.getElementById('taxonomy-toggle');
const taxonomyClose = document.getElementById('taxonomy-close');
const taxonomyScrim = document.getElementById('taxonomy-scrim');
const main = document.querySelector('.bp-how-main');
const links = [...document.querySelectorAll('[data-how-link]')];
const sections = links.map(link => document.querySelector(link.hash)).filter(Boolean);

function setTaxonomyOpen(open) {
    document.body.classList.toggle('taxonomy-open', open);
    taxonomyToggle.setAttribute('aria-expanded', String(open));
}

function setActiveSection(sectionID) {
    links.forEach(link => {
        const active = link.hash === `#${sectionID}`;
        link.classList.toggle('is-active', active);
        if (active) {
            link.setAttribute('aria-current', 'location');
        } else {
            link.removeAttribute('aria-current');
        }
    });
}

let activeFrame = null;
function updateActiveSection() {
    activeFrame = null;
    const activationLine = window.matchMedia('(max-width: 760px)').matches ? 92 : 36;
    let current = sections[0];
    sections.forEach(section => {
        if (section.getBoundingClientRect().top <= activationLine) {
            current = section;
        }
    });
    if (current) {
        setActiveSection(current.id);
    }
}

function scheduleActiveSectionUpdate() {
    if (activeFrame !== null) {
        return;
    }
    activeFrame = requestAnimationFrame(updateActiveSection);
}

taxonomyToggle.addEventListener('click', () => {
    setTaxonomyOpen(!document.body.classList.contains('taxonomy-open'));
});
taxonomyClose.addEventListener('click', () => setTaxonomyOpen(false));
taxonomyScrim.addEventListener('click', () => setTaxonomyOpen(false));
links.forEach(link => link.addEventListener('click', () => setTaxonomyOpen(false)));

window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        setTaxonomyOpen(false);
    }
});
window.addEventListener('scroll', scheduleActiveSectionUpdate, { passive: true });
window.addEventListener('resize', scheduleActiveSectionUpdate, { passive: true });
main.addEventListener('scroll', scheduleActiveSectionUpdate, { passive: true });

updateActiveSection();
