import { clamp } from './weights.js';
import { buildModelEditURL } from './links.js';

export function createModelListView({ state, modelRows, openApprovedModelResults }) {
    function vendorMark(vendor) {
        const key = String(vendor || 'openai').toLowerCase();
        const mark = document.createElement('span');
        mark.className = `bp-vendor-mark vendor-${key}`;
        const assets = {
            openai: 'openai.png', anthropic: 'anthropic.png', google: 'google.png',
            meta: 'meta.png', mistral: 'mistral.png', amazon: 'amazon.png',
            cohere: 'cohere.png', qwen: 'qwen.png', microsoft: 'microsoft.png',
            xai: 'xai.png', deepseek: 'deepseek.png', zhipu: 'zhipu.png'
        };
        if (assets[key]) {
            const image = document.createElement('img');
            image.src = `/assets/vendors/${assets[key]}`;
            image.alt = '';
            image.setAttribute('aria-hidden', 'true');
            image.addEventListener('error', () => {
                mark.textContent = key.slice(0, 1).toUpperCase();
            }, { once: true });
            mark.append(image);
        } else {
            mark.textContent = key.slice(0, 1).toUpperCase();
        }
        return mark;
    }

    function renderModels() {
        modelRows.replaceChildren();
        if (state.loading) {
            const loading = document.createElement('div');
            loading.className = 'bp-loading-state';
            loading.textContent = 'Calculating model ranges…';
            modelRows.append(loading);
            return;
        }
        const models = [...(state.modelLeaderboards[state.mode] ?? [])]
            .sort((a, b) => (
                Number(b.lower) - Number(a.lower)
                || Number(b.coverage) - Number(a.coverage)
                || a.name.localeCompare(b.name)
            ));
        if (models.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'bp-empty-state';
            empty.textContent = state.mode === 'personal'
                ? 'Add benchmarks to Personal Weights to calculate a model ranking.'
                : 'No public model ranking is available in this context yet.';
            modelRows.append(empty);
            return;
        }
        let previousScore = null;
        let previousRank = 0;
        models.forEach((model, index) => {
            const selectedScore = Number(model.lower);
            const rankValue = previousScore !== null && Math.abs(selectedScore - previousScore) < 0.0001
                ? previousRank
                : index + 1;
            previousScore = selectedScore;
            previousRank = rankValue;

            const row = document.createElement('div');
            row.className = 'bp-model-row';
            row.title = `${model.lower.toFixed(2)}–${model.upper.toFixed(2)} · ${model.coverage.toFixed(2)}% benchmark coverage`;
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', `View approved scores for ${model.name}`);
            const rank = document.createElement('span');
            rank.className = 'bp-model-rank';
            rank.textContent = String(rankValue);
            const identity = document.createElement('span');
            identity.className = 'bp-model-name-wrap';
            const name = document.createElement('span');
            name.className = 'bp-model-name';
            name.textContent = model.name;
            identity.append(vendorMark(model.logoKey || model.vendorSlug), name);
            if (state.mode === 'personal' && Number(model.fallbackUsageCount) > 0) {
                const fallbackBadge = document.createElement('span');
                fallbackBadge.className = 'bp-model-fallback-badge';
                fallbackBadge.title = `Fallback used for ${model.fallbackUsageCount} benchmark${Number(model.fallbackUsageCount) === 1 ? '' : 's'}`;
                fallbackBadge.setAttribute('aria-label', fallbackBadge.title);
                fallbackBadge.innerHTML = `<i class="fa-solid fa-code-branch" aria-hidden="true"></i><span>${Number(model.fallbackUsageCount)}</span>`;
                identity.append(fallbackBadge);
                row.title += ` · ${fallbackBadge.title}`;
            }

            const track = document.createElement('span');
            track.className = 'bp-score-track';
            track.setAttribute('aria-label', `Verified lower bound ${model.lower.toFixed(2)}, possible upper bound ${model.upper.toFixed(2)}`);
            const known = document.createElement('span');
            known.className = 'bp-score-known';
            known.style.width = `${clamp(Number(model.lower), 0, 100)}%`;
            const uncertain = document.createElement('span');
            uncertain.className = 'bp-score-uncertain';
            uncertain.style.left = `${clamp(Number(model.lower), 0, 100)}%`;
            uncertain.style.width = `${clamp(Number(model.upper) - Number(model.lower), 0, 100)}%`;
            track.append(known, uncertain);

            const score = document.createElement('span');
            score.className = 'bp-model-score';
            score.textContent = selectedScore.toFixed(2);
            const actionCell = document.createElement('span');
            actionCell.className = 'bp-model-action-cell';
            if (state.authenticated) {
                const edit = document.createElement('a');
                edit.className = 'bp-row-edit-action bp-benchmark-edit';
                edit.href = buildModelEditURL(model);
                edit.title = 'Change model';
                edit.setAttribute('aria-label', `Change ${model.name}`);
                edit.innerHTML = '<i class="fa-solid fa-pencil" aria-hidden="true"></i>';
                edit.addEventListener('click', event => event.stopPropagation());
                actionCell.append(edit);
            }
            const activate = event => {
                if (event.target.closest('a, button')) {
                    return;
                }
                if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') {
                    return;
                }
                if (event.type === 'keydown') {
                    event.preventDefault();
                }
                void openApprovedModelResults(model);
            };
            row.addEventListener('click', activate);
            row.addEventListener('keydown', activate);
            row.append(rank, identity, track, score, actionCell);
            modelRows.append(row);
        });
    }

    return { renderModels };
}
