const contents = document.querySelector('.hi-toc details');
const contentsLinks = contents.querySelectorAll('a');
const narrow = window.matchMedia('(max-width: 760px)');

function updateContentsLayout() {
    contents.open = !narrow.matches;
}

function updateCurrentLink() {
    const current = window.location.hash || '#overview';
    for (const link of contentsLinks) {
        if (link.hash === current) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
    }
}

window.addEventListener('hashchange', updateCurrentLink);
window.addEventListener('pageshow', updateCurrentLink);
narrow.addEventListener('change', updateContentsLayout);
contents.addEventListener('click', event => {
    if (narrow.matches && event.target.closest('a') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        contents.open = false;
    }
});
updateContentsLayout();
updateCurrentLink();
