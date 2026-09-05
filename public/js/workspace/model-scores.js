import { postJSON } from '../shared/http.js';
import { validateApprovedModelResultsPayload, invalidModelScoresResponse } from './contracts.js';
import { buildResultEditURL } from './links.js';

export function createModelScoresView({ state, modelScoresDialog, modelScoresTitle, modelScoresSummary, modelScoresList }) {
    let modelScoresRequestSequence = 0;

    function approvedResultScore(rawScore, usesPercentageScale) {
        const numericValue = Number(rawScore);
        const displayValue = String(Number(numericValue.toFixed(usesPercentageScale ? 1 : 3)));
        return `${displayValue}${usesPercentageScale ? '%' : ''}`;
    }

    function approvedResultSourceLabel(sample) {
        if (typeof sample.sourceTitle === 'string' && sample.sourceTitle.trim()) {
            return sample.sourceTitle.trim();
        }
        try {
            return new URL(sample.sourceURL).hostname.replace(/^www\./, '');
        } catch {
            return 'Source';
        }
    }

    function approvedResultDate(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) {
            return '';
        }
        return new Intl.DateTimeFormat('en', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        }).format(date);
    }

    function renderApprovedModelResults(payload) {
        modelScoresTitle.textContent = `${payload.model.modelName} · approved scores`;
        const sampleCount = payload.scoreGroups.reduce((total, group) => total + group.sampleCount, 0);
        modelScoresSummary.replaceChildren();
        const vendor = document.createElement('span');
        vendor.textContent = payload.model.vendorName;
        const condition = document.createElement('span');
        condition.className = 'bp-model-scores-condition';
        const conditionLabel = document.createElement('small');
        conditionLabel.textContent = 'Model condition';
        const conditionName = document.createElement('strong');
        conditionName.textContent = payload.model.modelConditionName;
        condition.append(conditionLabel, conditionName);
        const count = document.createElement('span');
        count.textContent = `${payload.scoreGroups.length} benchmark ${payload.scoreGroups.length === 1 ? 'condition' : 'conditions'} · ${sampleCount} accepted source ${sampleCount === 1 ? 'score' : 'scores'}`;
        modelScoresSummary.append(vendor, condition, count);
        modelScoresList.replaceChildren();
        if (payload.scoreGroups.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'bp-model-scores-empty';
            empty.textContent = 'No approved scores are available for this model condition.';
            modelScoresList.append(empty);
            return;
        }
        payload.scoreGroups.forEach(group => {
            const row = document.createElement('article');
            row.className = 'bp-model-score-detail-row';
            const heading = document.createElement('header');
            heading.className = 'bp-model-score-detail-heading';
            const identity = document.createElement('div');
            identity.className = 'bp-model-score-detail-identity';
            const benchmarkTitle = document.createElement('div');
            benchmarkTitle.className = 'bp-model-score-detail-benchmark';
            const name = document.createElement('strong');
            name.textContent = group.benchmarkName;
            benchmarkTitle.append(name);
            const benchmarkCondition = document.createElement('span');
            benchmarkCondition.className = 'bp-benchmark-condition';
            benchmarkCondition.textContent = group.benchmarkConditionIsDefault
                ? 'Default benchmark condition'
                : group.benchmarkConditionName;
            benchmarkTitle.append(benchmarkCondition);
            const sampleDescription = document.createElement('small');
            sampleDescription.textContent = group.sampleCount === 1
                ? '1 accepted source score'
                : `Median of ${group.sampleCount} accepted source scores`;
            identity.append(benchmarkTitle, sampleDescription);

            const aggregate = document.createElement('div');
            aggregate.className = 'bp-model-score-aggregate';
            const aggregateLabel = document.createElement('small');
            aggregateLabel.textContent = group.sampleCount === 1 ? 'Reported score' : 'Reported median';
            const aggregateValue = document.createElement('strong');
            aggregateValue.className = 'bp-model-score-detail-value';
            aggregateValue.textContent = approvedResultScore(group.medianRawScore, group.usesPercentageScale);
            const normalized = document.createElement('span');
            normalized.textContent = `Ranking value ${Number(group.medianNormalizedScore).toFixed(2)} / 100`;
            aggregate.append(aggregateLabel, aggregateValue, normalized);
            heading.append(identity, aggregate);

            const samples = document.createElement('div');
            samples.className = 'bp-model-score-samples';
            group.samples.forEach((sample, index) => {
                const sampleRow = document.createElement('div');
                sampleRow.className = 'bp-model-score-sample';
                const sampleIndex = document.createElement('span');
                sampleIndex.className = 'bp-model-score-sample-index';
                sampleIndex.textContent = String(index + 1);
                const sampleScore = document.createElement('strong');
                sampleScore.className = 'bp-model-score-sample-value';
                sampleScore.textContent = approvedResultScore(sample.rawScore, group.usesPercentageScale);
                const source = document.createElement('a');
                source.className = 'bp-model-score-source';
                source.href = sample.sourceURL;
                source.target = '_blank';
                source.rel = 'noopener';
                source.title = sample.sourceURL;
                source.setAttribute('aria-label', `Open source for ${group.benchmarkName}`);
                const sourceLabel = document.createElement('span');
                sourceLabel.textContent = approvedResultSourceLabel(sample);
                const sourceDate = document.createElement('small');
                sourceDate.textContent = approvedResultDate(sample.createdAt);
                source.append(sourceLabel, sourceDate, document.createElement('i'));
                source.lastElementChild.className = 'fa-solid fa-arrow-up-right-from-square';
                source.lastElementChild.setAttribute('aria-hidden', 'true');
                const normalizedSample = document.createElement('span');
                normalizedSample.className = 'bp-model-score-sample-normalized';
                normalizedSample.textContent = `${Number(sample.normalizedScore).toFixed(2)} / 100`;
                const edit = document.createElement('a');
                edit.className = 'bp-row-edit-action bp-benchmark-edit';
                edit.href = buildResultEditURL(sample);
                edit.title = 'Change approved score';
                edit.setAttribute('aria-label', `Change source score ${index + 1} for ${group.benchmarkName}`);
                edit.innerHTML = '<i class="fa-solid fa-pencil" aria-hidden="true"></i>';
                edit.hidden = !state.authenticated;
                sampleRow.append(sampleIndex, sampleScore, source, normalizedSample, edit);
                samples.append(sampleRow);
            });
            row.append(heading, samples);
            modelScoresList.append(row);
        });
    }

    async function openApprovedModelResults(model) {
        const requestSequence = ++modelScoresRequestSequence;
        modelScoresTitle.textContent = `${model.name} · approved scores`;
        modelScoresSummary.textContent = 'Loading approved scores…';
        modelScoresList.replaceChildren();
        modelScoresDialog.hidden = false;
        try {
            const payload = validateApprovedModelResultsPayload(await postJSON('/api/get_approved_benchmark_results', {
                modelID: Number(model.modelID),
                modelConditionID: Number(model.ID)
            }));
            if (requestSequence !== modelScoresRequestSequence) return;
            if (payload.model.modelID !== Number(model.modelID)
                || payload.model.modelConditionID !== Number(model.ID)) {
                throw invalidModelScoresResponse('model', 'does not match the requested model condition');
            }
            renderApprovedModelResults(payload);
        } catch (error) {
            if (requestSequence !== modelScoresRequestSequence) return;
            modelScoresSummary.textContent = 'Approved scores could not be loaded.';
            const message = document.createElement('p');
            message.className = 'bp-model-scores-empty';
            message.textContent = error?.payload?.error ?? 'Try again after refreshing the workspace.';
            modelScoresList.replaceChildren(message);
        }
    }

    return { openApprovedModelResults };
}
