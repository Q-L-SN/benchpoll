import { buildModelEditURL } from './links.js?v=clean-urls-20260908';

export function modelScoreScale(models) {
    let min = 0;
    let max = 100;
    for (const model of models) {
        if (model.comparable === false) continue;
        if (!Number.isFinite(model.lower) || !Number.isFinite(model.upper) || model.lower > model.upper) {
            throw new TypeError('Model score intervals must be finite and ordered');
        }
        min = Math.min(min, model.lower);
        max = Math.max(max, model.upper);
    }
    // Halving first also keeps the mapping finite for very large opposite endpoints.
    const position = value => (value / 2 - min / 2) / (max / 2 - min / 2) * 100;
    return { min, max, zero: position(0), position };
}

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
        if (state.comparisonNeedsSelection) {
            const message = document.createElement('div');
            message.className = 'bp-empty-state';
            message.textContent = state.comparisonError || 'Select at least one key to compare.';
            modelRows.append(message);
            return;
        }
        if (state.loading || state.comparisonPending) {
            const loading = document.createElement('div');
            loading.className = 'bp-loading-state';
            loading.textContent = 'Calculating model ranges…';
            modelRows.append(loading);
            return;
        }
        const models = [...(state.modelLeaderboards[state.mode] ?? [])]
            .sort((a, b) => (
                Number(b.comparable !== false) - Number(a.comparable !== false)
                || Number(b.lower) - Number(a.lower)
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
        const scale = modelScoreScale(models);
        let previousScore = null;
        let previousRank = 0;
        models.forEach((model, index) => {
            const comparable = model.comparable !== false;
            const selectedScore = Number(model.lower);
            const rankValue = previousScore !== null && Math.abs(selectedScore - previousScore) < 0.0001
                ? previousRank
                : index + 1;
            previousScore = selectedScore;
            previousRank = rankValue;

            const row = document.createElement('div');
            row.className = 'bp-model-row';
            row.classList.toggle('is-incomparable', !comparable);
            row.title = !comparable ? 'Not comparable: no common recorded configuration for every weighted benchmark.' : `${model.lower.toFixed(2)}–${model.upper.toFixed(2)} · ${model.coverage.toFixed(2)}% benchmark coverage`;
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', `View approved scores for ${model.name}`);
            const rank = document.createElement('span');
            rank.className = 'bp-model-rank';
            rank.textContent = comparable ? String(rankValue) : '-';
            const identity = document.createElement('span');
            identity.className = 'bp-model-name-wrap';
            const name = document.createElement('span');
            name.className = 'bp-model-name';
            name.textContent = model.name;
            if (!model.members || new Set(model.members.map(member => member.modelID)).size === 1) {
                identity.append(vendorMark(model.logoKey || model.vendorSlug));
            }
            identity.append(name);
            if (Number(model.fallbackUsageCount) > 0) {
                row.title += ` · Fallback used for ${model.fallbackUsageCount} benchmark${Number(model.fallbackUsageCount) === 1 ? '' : 's'}`;
            }

            const track = document.createElement('span');
            track.className = 'bp-score-track';
            track.setAttribute('aria-label', !comparable ? 'No matched total score' : `Score range ${model.lower.toFixed(2)} to ${model.upper.toFixed(2)}; chart scale ${scale.min.toFixed(2)} to ${scale.max.toFixed(2)}. Missing scores use 0 to 100.`);
            const lowerPosition = scale.position(model.lower);
            const upperPosition = scale.position(model.upper);
            track.classList.toggle('bp-score-negative-range', model.lower < 0 && model.upper > model.lower);
            const known = document.createElement('span');
            known.className = 'bp-score-known';
            known.style.left = `${Math.min(scale.zero, lowerPosition)}%`;
            known.style.width = `${Math.abs(lowerPosition - scale.zero)}%`;
            const uncertain = document.createElement('span');
            uncertain.className = 'bp-score-uncertain';
            uncertain.style.left = `${lowerPosition}%`;
            uncertain.style.width = `${upperPosition - lowerPosition}%`;
            track.append(known, uncertain);
            if (scale.min < 0) {
                const zero = document.createElement('span');
                zero.className = 'bp-score-zero';
                zero.style.left = `${scale.zero}%`;
                zero.title = '0';
                zero.setAttribute('aria-hidden', 'true');
                track.append(zero);
            }

            const score = document.createElement('span');
            score.className = 'bp-model-score';
            score.textContent = comparable ? selectedScore.toFixed(2) : 'No match';
            const actionCell = document.createElement('span');
            actionCell.className = 'bp-model-action-cell';
            if (state.authenticated && (!model.members || model.members.length === 1)) {
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
