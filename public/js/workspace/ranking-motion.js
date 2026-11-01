const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function rankingRowKey(model) {
    return model.comparisonIdentity ?? JSON.stringify([model.modelID, model.condition?.scoreFields ?? model.condition?.parameters ?? {}]);
}

export function captureRankingRows(container) {
    return new Map([...container.querySelectorAll('[data-model-key]')].map(row => {
        const bars = {};
        for (const name of ['known', 'uncertain', 'fill']) {
            const element = row.querySelector(`.bp-score-${name}`);
            const style = getComputedStyle(element);
            bars[name] = name === 'fill' ? { clipPath: style.clipPath } : { left: style.left, width: style.width };
        }
        return [row.dataset.modelKey, { top: row.getBoundingClientRect().top, rank: Number(row.dataset.rank), bars }];
    }));
}

export function animateRankingChanges(container, previous) {
    if (reducedMotion()) return;
    const options = { duration: 650, easing: 'cubic-bezier(.22, 1, .36, 1)' };
    for (const row of container.querySelectorAll('[data-model-key]')) {
        const old = previous.get(row.dataset.modelKey);
        if (!old) {
            row.animate([{ opacity: .25 }, { opacity: 1 }], options);
            continue;
        }
        const dy = old.top - row.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], options);
        for (const name of ['known', 'uncertain', 'fill']) {
            const element = row.querySelector(`.bp-score-${name}`);
            const style = getComputedStyle(element);
            const end = name === 'fill' ? { clipPath: style.clipPath } : { left: style.left, width: style.width };
            element.animate([old.bars[name], end], options);
        }
        const delta = old.rank - Number(row.dataset.rank);
        if (Number.isFinite(delta) && old.rank > 0 && Number(row.dataset.rank) > 0 && delta) {
            const change = document.createElement('small');
            change.className = 'bp-rank-change';
            change.dataset.tooltip = `${Math.abs(delta)} places ${delta > 0 ? 'up' : 'down'}`;
            change.innerHTML = `<i class="fa-solid fa-arrow-${delta > 0 ? 'up' : 'down'}" aria-hidden="true"></i>`;
            change.append(String(Math.abs(delta)));
            row.querySelector('.bp-model-rank').append(change);
            const fade = change.animate([{ opacity: 1 }, { opacity: 1, offset: .75 }, { opacity: 0 }], { duration: 5000 });
            fade.finished.then(() => change.remove(), () => change.remove());
        }
    }
}
