(() => {
    const key = 'benchpoll-home-palette';
    const valid = value => value === 'orange' || value === 'berry';
    const root = document.documentElement;

    function apply(value) {
        root.dataset.homePalette = value;
        document.querySelectorAll('[data-palette]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.palette === value));
        });
    }

    try {
        const saved = localStorage.getItem(key);
        if (valid(saved)) apply(saved);
    } catch (error) {
        console.warn('Homepage palette preference could not be read.', error);
    }

    document.addEventListener('DOMContentLoaded', () => {
        apply(root.dataset.homePalette);
        document.querySelector('.bp-palette-switch').addEventListener('click', event => {
            const button = event.target.closest('[data-palette]');
            if (!button || !valid(button.dataset.palette)) return;
            apply(button.dataset.palette);
            try {
                localStorage.setItem(key, button.dataset.palette);
            } catch (error) {
                console.warn('Homepage palette preference could not be saved.', error);
            }
        });
    });

    window.addEventListener('storage', event => {
        if (event.key === key) apply(valid(event.newValue) ? event.newValue : 'orange');
    });
})();
