import { setLoading } from '../shared/loading.js';
import { postJSON } from '../shared/http.js';
import { isMissingInferenceMethod } from '../shared/estimation-algorithms.js';
import { validateApprovedModelResultsPayload, invalidModelScoresResponse } from './contracts.js?v=review-evidence-20261008';
import { buildModelEditURL, buildResultEditURL } from './links.js?v=model-change-panel-20261006';
import { animateContent, isDisclosureOpen, mountDisclosureMotion, setDisclosureOpen, setVisible } from '../shared/motion.js';
import { searchItems } from '../shared/search.js';
import { actualScoreFallbackPath } from './model-score-fallback.js?v=model-change-panel-20261006';
import { benchmarkAccessibleName } from './weights.js';
import { createBenchmarkInformationLink } from './benchmark-link.js';
import { protectModelName } from '../shared/model-name.js?v=model-name-translation-20261006';
import { renderComparisonName } from '../shared/comparison-display.js?v=launch-layout-20261007';
import { setHelpText } from '../shared/help-popover.js?v=help-popovers-20261008';
import { configureAction, createAction, mountSegmentedControl, mountDisclosureChevron } from '../shared/ui-components.js';
import { rankingNumber } from '../shared/ranking-number.js';
import { comparisonValueEligible, fieldKey, matchesValueFilters } from '../shared/score-fields.js';
import { AA_DISPLAY_RESTRICTION, hasAADisplayRestriction } from '../shared/aa-ranking-policy.js';

const AA_ALL_SCORES_MESSAGE = 'Artificial Analysis benchmarks and scores are hidden to respect their data-use terms.';

const restrictedScoreGroup = group => hasAADisplayRestriction({ ...group,
    conditionKey: group.conditionKey ?? group.benchmarkConditionKey,
    conditionName: group.benchmarkConditionName ?? group.conditionName });

function requireAllScoresDisplayPolicy(payload) {
    // Unversioned lazy responses may still contain AA-derived values on otherwise normal versions.
    if (payload.displayPolicy !== AA_DISPLAY_RESTRICTION) {
        throw invalidModelScoresResponse('displayPolicy', 'must confirm the current score display policy');
    }
}

const evidenceSearchFields = row => {
    const text = [];
    const walker = row.ownerDocument.createTreeWalker(row, globalThis.NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) text.push(walker.currentNode.textContent);
    return [text.join(' '), ...[...row.querySelectorAll('a[href]')].map(link => link.href)];
};

export function validateModelScoreConfigurationIndex(payload, modelIDs) {
    const invalid = () => { throw invalidModelScoresResponse('configurations', 'has invalid approved version summaries'); };
    if (!Array.isArray(payload?.configurations)) invalid();
    const configurations = new Set();
    for (const item of payload.configurations) {
        if (!item || !modelIDs.includes(item.modelID) || typeof item.modelName !== 'string'
            || typeof item.configurationName !== 'string' || !Array.isArray(item.scoreFields)
            || !Number.isSafeInteger(item.scoreCount) || item.scoreCount < 1
            || !Array.isArray(item.scoreGroups) || !item.scoreGroups.length) invalid();
        const key = JSON.stringify([item.modelID, item.scoreFields]);
        if (configurations.has(key)) invalid();
        configurations.add(key);
        const conditions = new Set();
        let count = 0;
        for (const group of item.scoreGroups) {
            if (!group || !Number.isSafeInteger(group.benchmarkID) || group.benchmarkID < 1
                || !Number.isSafeInteger(group.benchmarkConditionID) || group.benchmarkConditionID < 1
                || conditions.has(group.benchmarkConditionID)
                || typeof group.benchmarkName !== 'string' || typeof group.benchmarkConditionName !== 'string'
                || typeof group.benchmarkConditionIsDefault !== 'boolean' || typeof group.usesPercentageScale !== 'boolean'
                || !Number.isFinite(group.medianRawScore) || !Number.isFinite(group.medianNormalizedScore)
                || !Number.isSafeInteger(group.sampleCount) || group.sampleCount < 1
                || !Number.isSafeInteger(group.distinctScoreCount) || group.distinctScoreCount < 1
                || group.distinctScoreCount > group.sampleCount) invalid();
            conditions.add(group.benchmarkConditionID);
            count += group.sampleCount;
        }
        if (count !== item.scoreCount) invalid();
    }
    return payload;
}

export function allScoresSearchResults(entries, query) {
    const configurationMatches = new Set(searchItems(entries, query, entry => entry.searchFields));
    const versions = entries.flatMap(entry => configurationMatches.has(entry) ? []
        : (entry.payload?.scoreGroups ?? entry.member.scoreGroups).map(group => ({ entry, group })));
    const found = searchItems(versions, query, item => [...item.entry.searchFields,
        item.group.benchmarkName, item.group.benchmarkConditionName,
        item.group.benchmarkConditionIsDefault ? 'Default benchmark version' : '']);
    const groups = new Map(entries.map(entry => [entry, new Set()]));
    for (const item of found) groups.get(item.entry).add(item.group.benchmarkConditionID);
    return entries.map(entry => ({ entry, configurationMatch: configurationMatches.has(entry), groups: groups.get(entry) }));
}

export function matchingScoreConfigurations(configurations, model, comparison) {
    const keys = comparison.keys ?? ['model'];
    let projection;
    try {
        const parsed = JSON.parse(model.comparisonIdentity);
        if (Array.isArray(parsed) && parsed.length === keys.length
            && parsed.every(part => Array.isArray(part) && part.length === 3
                && keys.includes(part[0]) && typeof part[1] === 'boolean')
            && new Set(parsed.map(part => part[0])).size === keys.length) projection = parsed;
    } catch { /* A non-grouped entry is projected from its recorded assignments. */ }
    if (!projection) {
        const member = model.members?.[0] ?? model;
        const values = { ...(member.condition?.parameters ?? {}), model: member.modelID };
        for (const field of member.condition?.scoreFields ?? []) values[fieldKey(field.fieldID)] = field.value;
        projection = keys.map(key => [key, Object.hasOwn(values, key), values[key] ?? null]);
    }
    const selectedFields = (comparison.fields ?? []).filter(field => keys.includes(fieldKey(field.ID)));
    return configurations.filter(item => {
        const values = { model: item.modelID };
        for (const field of item.scoreFields) values[fieldKey(field.fieldID)] = field.value;
        return projection.every(([key, present, value]) => Object.hasOwn(values, key) === present
            && (!present || values[key] === value))
            && matchesValueFilters(values, comparison.filters ?? [])
            && selectedFields.every(field => {
                const key = fieldKey(field.ID);
                const unspecified = !Object.hasOwn(values, key) || values[key] === null;
                return (comparison.mode === 'best' && unspecified) || comparisonValueEligible(field, values);
            });
    });
}

const SCORE_SEARCH_COPY = {
    ranking: ['Search scores in this ranking', 'No matching scores in this ranking.'],
    configurations: ['Find a configuration, benchmark or version', 'No matching configurations or benchmark versions.'],
    versions: ['Find a benchmark or version', 'No matching benchmark versions.'],
    sources: ['Find a source or score', 'No matching source scores.']
};

export function modelScoreSearchCopy(scope) {
    if (!Object.hasOwn(SCORE_SEARCH_COPY, scope)) throw new TypeError('Unknown score search scope');
    const [placeholder, empty] = SCORE_SEARCH_COPY[scope];
    return { placeholder, empty };
}

export function createModelScoresView({ state, modelScoresDialog, modelScoresTitle, modelScoresSummary, modelScoresList,
    getMemberURL, onInspectVersion }) {
    protectModelName(modelScoresTitle);
    let modelScoresRequestSequence = 0;
    const search = modelScoresDialog.querySelector('#model-scores-search');
    modelScoresDialog.querySelector('#model-scores-expand')?.remove();
    const changeControls = modelScoresDialog.querySelector('#model-scores-change-controls');
    let activeModel = null;
    let allScoresView = null;
    let rankingView = null;
    function cancelAllScores() {
        allScoresView?.controller.abort();
        rankingView?.controller.abort();
        allScoresView = null;
        rankingView = null;
        modelScoresList.removeAttribute('aria-busy');
    }
    function readGuard(sequence, model) {
        const { authenticated, userID, loadSequence } = state;
        return () => sequence === modelScoresRequestSequence && activeModel === model
            && !modelScoresDialog.hidden && state.authenticated === authenticated
            && state.userID === userID && state.loadSequence === loadSequence;
    }
    const informationLink = member => createBenchmarkInformationLink(member, { getURL: getMemberURL,
        onInspect: event => {
            cancelAllScores();
            ++modelScoresRequestSequence;
            modelScoresDialog.returnFocus = null;
            modelScoresDialog.hidden = true;
            onInspectVersion?.(event);
        } });
    const tabs = document.createElement('div');
    tabs.className = 'bp-model-evidence-tabs';
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Score evidence view');
    const usedTab = document.createElement('button');
    usedTab.type = 'button'; usedTab.textContent = 'Used in this ranking';
    const allTab = document.createElement('button');
    allTab.type = 'button'; allTab.textContent = 'All scores';
    tabs.append(usedTab, allTab);
    modelScoresDialog.querySelector('.bp-model-evidence-toolbar').prepend(tabs);
    mountSegmentedControl(tabs);
    usedTab.addEventListener('click', () => openApprovedModelResults(activeModel));
    allTab.addEventListener('click', () => showAllScores(activeModel));
    function selectTab(used) {
        usedTab.setAttribute('aria-pressed', String(used));
        allTab.setAttribute('aria-pressed', String(!used));
    }
    mountDisclosureMotion(modelScoresList, 'details');
    mountDisclosureMotion(changeControls, 'details');

    function renderModelChangeControls(model) {
        changeControls.replaceChildren();
        changeControls.hidden = !state.authenticated;
        if (!state.authenticated) return;
        const models = [...new Map((model.members ?? [model]).map(member => [member.modelID, member])).values()];
        const makeLink = (item, multiple) => {
            const link = createAction({ label: multiple ? item.name : 'Change information',
                icon: 'fa-regular fa-pen-to-square', href: buildModelEditURL(item), className: 'bp-model-change-information' });
            link.setAttribute('aria-label', `Change information for ${item.name}`);
            if (multiple) protectModelName(link.querySelector('.bp-ui-action-label'));
            return link;
        };
        if (models.length === 1) { changeControls.append(makeLink(models[0], false)); return; }
        const picker = document.createElement('details'); picker.className = 'bp-model-change-picker';
        const toggle = document.createElement('summary');
        configureAction(toggle);
        toggle.innerHTML = '<i class="fa-regular fa-pen-to-square" aria-hidden="true"></i><span>Change information</span>';
        mountDisclosureChevron(toggle);
        const options = document.createElement('div'); options.className = 'bp-model-change-options';
        for (const item of models) options.append(makeLink(item, true));
        picker.append(toggle, options); changeControls.append(picker);
    }
    const noMatches = document.createElement('p');
    noMatches.className = 'bp-model-scores-empty';
    const aaNotice = document.createElement('p');
    aaNotice.className = 'bp-model-scores-empty';
    aaNotice.dataset.displayRestriction = AA_DISPLAY_RESTRICTION;
    aaNotice.textContent = AA_ALL_SCORES_MESSAGE;
    function renderAllScoresNotice(view) {
        aaNotice.remove();
        if (view.omitted) modelScoresList.append(aaNotice);
    }
    let searchScope = 'ranking';
    function setSearchScope(scope) {
        searchScope = scope;
        const copy = modelScoreSearchCopy(scope);
        search.placeholder = copy.placeholder;
        search.setAttribute('aria-label', copy.placeholder);
        noMatches.textContent = copy.empty;
    }
    function filterScores() {
        if (searchScope === 'configurations' && allScoresView) {
            filterAllConfigurations(allScoresView);
            return;
        }
        if (searchScope === 'ranking' && rankingView) {
            filterRankingScores(rankingView);
            return;
        }
        const query = search.value.trim();
        let matches = 0;
        const sourceRows = searchScope === 'sources';
        const rows = [...modelScoresList.querySelectorAll(sourceRows ? '.bp-model-score-sample' : '.bp-model-score-detail-row')];
        const found = new Set(searchItems(rows, query, evidenceSearchFields));
        rows.forEach(row => {
            row.hidden = !found.has(row);
            if (!row.hidden) matches++;
        });
        if (sourceRows) modelScoresList.querySelectorAll('.bp-model-score-detail-row').forEach(group => {
            group.hidden = Boolean(query) && [...group.querySelectorAll('.bp-model-score-sample')].every(row => row.hidden);
        });
        noMatches.remove();
        if (query && !matches) modelScoresList.append(noMatches);
    }
    search.addEventListener('input', filterScores);

    function approvedResultScore(rawScore, usesPercentageScale) {
        const numericValue = Number(rawScore);
        // Stored scores have six decimal places; a two-value median may need seven.
        const displayValue = String(Number(numericValue.toFixed(7)));
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

    function appendApprovedScoreGroups(payload, target, open = false, onSourcesOpen = null) {
        const records = [];
        if (payload.scoreGroups.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'bp-model-scores-empty';
            empty.textContent = 'No approved scores are available for this score configuration.';
            target.append(empty);
            return records;
        }
        payload.scoreGroups.forEach(group => {
            const row = document.createElement('details');
            row.className = 'bp-model-score-detail-row';
            row.dataset.conditionId = String(group.benchmarkConditionID);
            row.open = open;
            const heading = approvedScoreHeading(group);
            const samples = document.createElement('div');
            samples.className = 'bp-model-score-samples';
            const record = { group, row, samples, loaded: false };
            records.push(record);
            if (onSourcesOpen) {
                setLoading(samples, 'Loading approved scores…');
                samples.dataset.sourceState = 'loading';
                row.addEventListener('toggle', () => onSourcesOpen(record));
            } else renderApprovedScoreSamples(group, samples);
            row.append(heading, samples);
            target.append(row);
        });
        return records;
    }

    function approvedScoreHeading(group) {
        const heading = document.createElement('summary');
        heading.className = 'bp-model-score-detail-heading';
        const identity = document.createElement('div');
        identity.className = 'bp-model-score-detail-identity';
        const benchmarkTitle = document.createElement('div');
        benchmarkTitle.className = 'bp-model-score-detail-benchmark';
        benchmarkTitle.append(informationLink({ benchmarkID: group.benchmarkID, conditionID: group.benchmarkConditionID,
            name: group.benchmarkName, conditionName: group.benchmarkConditionIsDefault
                ? 'Default benchmark version' : group.benchmarkConditionName }));
        const sampleDescription = document.createElement('small');
        const distinctCount = group.distinctScoreCount;
        sampleDescription.textContent = distinctCount === 1
            ? '1 distinct score value'
            : `Median of ${distinctCount} distinct score values`;
        identity.append(benchmarkTitle, sampleDescription);

        const aggregate = document.createElement('div');
        aggregate.className = 'bp-model-score-aggregate';
        const aggregateLabel = document.createElement('small');
        aggregateLabel.textContent = distinctCount === 1 ? 'Reported score' : 'Reported median';
        const aggregateValue = document.createElement('strong');
        aggregateValue.className = 'bp-model-score-detail-value';
        aggregateValue.textContent = approvedResultScore(group.medianRawScore, group.usesPercentageScale);
        const normalized = document.createElement('span');
        normalized.textContent = `Ranking value ${Number(group.medianNormalizedScore).toFixed(2)} / 100`;
        aggregate.append(aggregateLabel, aggregateValue, normalized);
        heading.append(identity, aggregate);

        return heading;
    }

    function renderApprovedScoreSamples(group, samples) {
        delete samples.dataset.sourceState;
        samples.replaceChildren();
        const columns = document.createElement('div');
        columns.className = 'bp-model-score-columns';
        columns.innerHTML = '<span>#</span><span>Reported</span><span>Source</span><span>Normalized</span><span></span>';
        samples.append(columns);
        group.samples.forEach((sample, index) => {
            const sampleRow = document.createElement('div');
            sampleRow.className = 'bp-model-score-sample';
            const sampleIndex = document.createElement('span');
            sampleIndex.className = 'bp-model-score-sample-index';
            sampleIndex.textContent = String(index + 1);
            const sampleScore = document.createElement('strong');
            sampleScore.className = 'bp-model-score-sample-value';
            sampleScore.textContent = approvedResultScore(sample.rawScore, group.usesPercentageScale);
            const sourceURL = sample.sourceURL?.trim();
            const source = document.createElement(sourceURL ? 'a' : 'span');
            source.className = 'bp-model-score-source';
            if (sourceURL) {
                source.href = sourceURL;
                source.target = '_blank';
                source.rel = 'noopener noreferrer';
                source.dataset.tooltip = sourceURL;
                source.setAttribute('aria-label', `Open source for ${group.benchmarkName}`);
            }
            const sourceLabel = document.createElement('span');
            sourceLabel.textContent = sourceURL ? approvedResultSourceLabel(sample) : 'No source link';
            const sourceDate = document.createElement('small');
            sourceDate.textContent = approvedResultDate(sample.createdAt);
            const sourceText = document.createElement('span');
            sourceText.className = 'bp-model-score-source-text';
            sourceText.append(sourceLabel, sourceDate);
            source.append(sourceText);
            if (sourceURL) {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-arrow-up-right-from-square';
                icon.setAttribute('aria-hidden', 'true');
                source.append(icon);
            }
            const sourceCell = document.createElement('div');
            sourceCell.className = 'bp-model-score-source-cell';
            sourceCell.append(source);
            if (sample.excludedAsDuplicate) {
                const duplicateHelp = document.createElement('button');
                duplicateHelp.type = 'button';
                duplicateHelp.setAttribute('aria-label', 'Why this score is counted once');
                duplicateHelp.innerHTML = '<i class="fa-regular fa-circle-question" aria-hidden="true"></i>';
                setHelpText(duplicateHelp, 'Another source reports this same score. We keep both sources, but count the numeric value once when calculating the middle score (median).');
                sourceCell.append(duplicateHelp);
            }
            const normalizedSample = document.createElement('span');
            normalizedSample.className = 'bp-model-score-sample-normalized';
            normalizedSample.textContent = `${Number(sample.normalizedScore).toFixed(2)} / 100`;
            const edit = document.createElement('a');
            edit.className = 'bp-row-edit-action';
            edit.href = buildResultEditURL(sample);
            edit.dataset.tooltip = 'Change approved score';
            edit.setAttribute('aria-label', `Change source score ${index + 1} for ${group.benchmarkName}`);
            edit.innerHTML = '<i class="fa-regular fa-pen-to-square" aria-hidden="true"></i>';
            edit.hidden = !state.authenticated;
            sampleRow.append(sampleIndex, sampleScore, sourceCell, normalizedSample, edit);
            samples.append(sampleRow);
        });
    }

    function benchmarkDetails(conditionID) {
        return state.benchmarkDetailsByID.get(Number(conditionID))
            ?? [...state.personalEntries, ...state.publicEntries,
                ...(state.personalFallbackRules ?? []).flatMap(rule => rule.entries),
                ...(state.personalCommunityComposition ?? []).flatMap(group => group.families.flatMap(family => family.entries)),
                ...(state.publicFamilyComposition ?? []).flatMap(group => group.families.flatMap(family => family.entries))]
                .find(item => Number(item.conditionID) === Number(conditionID));
    }

    function renderCalculationResults(model) {
        const scores = model.calculationScores;
        const range = !model.availableInference && Number.isFinite(model.upper) && model.upper !== model.lower;
        modelScoresSummary.textContent = model.comparable === false ? 'Not ranked: no measured result matches these weights and settings.'
            : `${range ? `Score range ${rankingNumber(model.lower)} to ${rankingNumber(model.upper)}` : `Index score ${rankingNumber(model.lower)}`}; measured results cover ${rankingNumber(model.coverage)}% of the weight.`;
        if (range && model.comparable !== false) {
            const detail = document.createElement('p');
            detail.className = 'bp-model-inference-summary';
            detail.textContent = 'Missing results count as 0 at the lower end and 100 at the upper end. Measured results stay fixed. Models rank by the lower end.';
            modelScoresSummary.append(detail);
        }
        const inference = model.availableInference;
        const missingOnly = isMissingInferenceMethod(inference?.method);
        const usesCoverageFactor = inference && [inference.coverageFactor, inference.appliedFactor,
            inference.unpenalizedScore].every(Number.isFinite);
        if (inference && (model.missingWeight > 0 || usesCoverageFactor || missingOnly)) {
            const detail = document.createElement('p');
            detail.className = 'bp-model-inference-summary';
            detail.textContent = model.missingWeight <= 0 ? '' : inference.inferredFraction > 0
                ? `${(inference.inferredFraction * 100).toFixed(2)}% of the weight uses estimates from shared-test comparisons.`
                : 'Estimates are unavailable for the missing results.';
            if (inference.unresolvedFraction > 0) detail.textContent += missingOnly
                ? ` ${(inference.unresolvedFraction * 100).toFixed(2)}% of the weight has no measurement or prediction and starts at 50.`
                : ` ${(inference.unresolvedFraction * 100).toFixed(2)}% of the weight has no measurement or estimate and is left out of the average.`;
            if (usesCoverageFactor || missingOnly) {
                modelScoresSummary.append(detail);
                const calculation = document.createElement('div');
                calculation.className = 'bp-model-calculation-details';
                const before = document.createElement('p');
                before.textContent = `Before adjustment: ${rankingNumber(inference.unpenalizedScore)}`;
                const after = document.createElement('p');
                after.textContent = `After adjustment: ${rankingNumber(model.lower)}`;
                const help = document.createElement('a');
                help.href = '/how-it-works#rankings'; help.textContent = 'How it works';
                calculation.append(before, after, help);
                modelScoresSummary.append(calculation);
            } else {
                if (inference.coveragePenalty > 0) detail.textContent += ` Before adjustment: ${rankingNumber(inference.unpenalizedScore)}. After adjustment: ${rankingNumber(model.lower)}.`;
                modelScoresSummary.append(detail);
            }
        }
        for (const score of scores) {
            const path = actualScoreFallbackPath(score);
            const benchmark = benchmarkDetails(path[0]);
            const row = document.createElement('details');
            row.className = 'bp-model-score-detail-row';
            row.dataset.conditionId = String(score.conditionID);
            row.open = true;
            const heading = document.createElement('summary');
            heading.className = 'bp-model-score-detail-heading';
            heading.addEventListener('click', event => {
                if (!event.target.closest('a, button, input, select, textarea') && rankingView?.query) {
                    rankingView.overrides.set(row, !isDisclosureOpen(row));
                }
            });
            const identity = document.createElement('div');
            identity.className = 'bp-model-score-detail-identity';
            const benchmarkName = benchmark?.name ?? `Benchmark #${path[0]}`;
            const title = document.createElement('div');
            title.className = 'bp-model-score-detail-benchmark';
            title.append(benchmark ? informationLink(benchmark) : document.createTextNode(benchmarkName));
            const explanation = document.createElement('small');
            explanation.textContent = `${score.effectiveWeight.toFixed(2)}% weight`;
            explanation.dataset.tooltip = score.matchedCount === null ? 'How much this result counts toward the total' : `${score.matchedCount} shared sets of run settings, each counted equally`;
            identity.append(title, explanation);
            if (path.length > 1) {
                const toggle = createAction({ label: 'Show fallback steps used for this result',
                    iconOnly: true, className: 'bp-model-fallback-toggle' });
                mountDisclosureChevron(toggle);
                const branch = document.createElement('i');
                branch.className = 'fa-solid fa-code-branch bp-model-fallback-indicator';
                branch.setAttribute('aria-hidden', 'true');
                toggle.prepend(branch);
                toggle.setAttribute('aria-expanded', 'false');
                title.append(toggle);
                const chain = document.createElement('ol'); chain.className = 'bp-model-fallback-path bp-fallback-chain'; chain.hidden = true;
                chain.setAttribute('role', 'list');
                chain.id = `model-fallback-path-${modelScoresRequestSequence}-${scores.indexOf(score)}`;
                chain.setAttribute('aria-label', `Fallback steps for ${benchmark ? benchmarkAccessibleName(benchmark) : path[0]}`);
                toggle.setAttribute('aria-controls', chain.id);
                path.slice(1).forEach((ID, index) => {
                    const member = benchmarkDetails(ID);
                    const item = document.createElement('li'); item.className = 'bp-fallback-chain-step'; item.dataset.conditionId = String(ID);
                    const label = member ? informationLink(member) : document.createElement('span');
                    if (!member) label.textContent = `Benchmark #${ID}`;
                    const status = document.createElement('small'); status.textContent = index === path.length - 2 ? 'Used' : 'No score';
                    item.append(label, status); chain.append(item);
                });
                toggle.addEventListener('click', event => {
                    event.preventDefault(); event.stopPropagation();
                    const open = toggle.getAttribute('aria-expanded') !== 'true';
                    toggle.setAttribute('aria-expanded', String(open));
                    toggle.dataset.tooltip = open ? 'Hide fallback steps' : 'Show fallback steps used for this result';
                    toggle.setAttribute('aria-label', toggle.dataset.tooltip);
                    void setVisible(chain, open, { collapse: true });
                });
                identity.append(chain);
            }
            const aggregate = document.createElement('div');
            aggregate.className = 'bp-model-score-aggregate';
            const label = document.createElement('small');
            label.textContent = 'Ranking score';
            const value = document.createElement('strong');
            value.className = 'bp-model-score-detail-value';
            value.textContent = score.normalizedScore.toFixed(2);
            const scale = document.createElement('span');
            scale.textContent = `${score.contribution.toFixed(2)} added to total`;
            aggregate.append(label, value, scale);
            heading.append(identity, aggregate);
            const configurations = document.createElement('div');
            configurations.className = 'bp-model-score-configurations';
            row.append(heading, configurations);
            for (const ID of score.memberIDs) {
                const member = (model.members ?? [model]).find(item => item.ID === ID);
                if (!member) throw invalidModelScoresResponse('calculationScores.memberIDs', 'has an unknown source configuration');
                const source = document.createElement('details');
                source.className = 'bp-model-configuration-source';
                const sourceHeading = document.createElement('summary');
                sourceHeading.className = 'bp-model-configuration-link';
                const name = document.createElement('span');
                name.textContent = member.name;
                protectModelName(name);
                const label = document.createElement('small');
                label.textContent = 'Source scores';
                if (score.matchedCount !== null) {
                    const share = score.memberWeights.filter(item => item.ID === ID).reduce((sum, item) => sum + item.weight, 0);
                    label.textContent = `${(share * 100).toFixed(1)}% of this result`;
                }
                sourceHeading.append(name, label);
                sourceHeading.dataset.tooltip = 'View this configuration’s approved source scores';
                const samples = document.createElement('div');
                samples.className = 'bp-model-score-samples';
                setLoading(samples, 'Loading approved scores…');
                samples.dataset.sourceState = 'loading';
                const entry = { member, row, heading, source, sourceHeading, samples,
                    conditionID: score.conditionID, hash: score.memberEvidence.find(item => item.ID === ID).hash,
                    group: null, rendered: false, pending: false, error: null };
                rankingView.entries.push(entry);
                sourceHeading.addEventListener('click', () => {
                    const open = !isDisclosureOpen(source);
                    if (rankingView?.query) rankingView.overrides.set(source, open);
                    if (open && rankingView) requestRankingSource(rankingView, entry);
                });
                source.addEventListener('toggle', () => {
                    if (rankingView && isDisclosureOpen(source)) requestRankingSource(rankingView, entry);
                });
                source.append(sourceHeading, samples);
                configurations.append(source);
            }
            modelScoresList.append(row);
        }
        if (model.inferredScores?.length) {
            const section = document.createElement('h3'); section.className = 'bp-model-inferred-heading';
            section.textContent = 'Estimated missing results'; modelScoresList.append(section);
            for (const score of model.inferredScores) {
                const benchmark = benchmarkDetails(score.conditionID);
                const row = document.createElement('div'); row.className = 'bp-model-score-detail-row bp-model-inferred-row';
                const title = benchmark ? informationLink(benchmark) : document.createElement('strong');
                if (!benchmark) title.textContent = `Benchmark #${score.conditionID}`;
                const description = document.createElement('small');
                description.textContent = `Estimate for ${score.originalWeight.toFixed(2)}% of the Pie, based on ${score.referenceCount} comparison entries`;
                const value = document.createElement('strong'); value.textContent = score.normalizedScore.toFixed(2);
                const contribution = document.createElement('span'); contribution.textContent = `${score.contribution.toFixed(2)} added to total`;
                row.append(title, value, description, contribution); modelScoresList.append(row);
            }
        }
        if (!scores.length) {
            const empty = document.createElement('p');
            empty.textContent = 'No recorded scores contributed to this ranking.';
            modelScoresList.append(empty);
        }
        filterScores();
    }

    function filterRankingScores(view) {
        if (!view.current()) return;
        const query = search.value.trim();
        if (query !== view.query) {
            if (!view.query && query) view.browsing = new Map([...modelScoresList.querySelectorAll('details')]
                .map(row => [row, isDisclosureOpen(row)]));
            view.overrides = new WeakMap();
            view.query = query;
            if (!query) for (const [row, open] of view.browsing) {
                void setDisclosureOpen(row, open, { animate: false });
            }
        }
        const rows = [...modelScoresList.children].filter(row => row.classList.contains('bp-model-score-detail-row'));
        const candidates = [];
        for (const row of rows) {
            const heading = row.querySelector(':scope > summary') ?? row;
            const fields = evidenceSearchFields(heading);
            candidates.push({ kind: 'row', row, fields });
            for (const entry of view.entries.filter(item => item.row === row)) {
                const entryFields = [...fields, ...evidenceSearchFields(entry.sourceHeading)];
                candidates.push({ kind: 'entry', row, entry, fields: entryFields });
                for (const sample of entry.samples.querySelectorAll('.bp-model-score-sample')) {
                    candidates.push({ kind: 'sample', row, entry, sample, fields: [...entryFields, ...evidenceSearchFields(sample)] });
                }
            }
        }
        const found = new Set(searchItems(candidates, query, item => item.fields));
        let matches = 0;
        for (const row of rows) {
            const items = candidates.filter(item => item.row === row);
            const rowMatch = items.some(item => item.kind === 'row' && found.has(item));
            const entryMatches = new Map();
            for (const entry of view.entries.filter(item => item.row === row)) {
                const entryMatch = items.some(item => item.kind === 'entry' && item.entry === entry && found.has(item));
                const sampleItems = items.filter(item => item.kind === 'sample' && item.entry === entry);
                const sampleMatch = sampleItems.some(item => found.has(item));
                entryMatches.set(entry, entryMatch || sampleMatch);
                entry.source.hidden = Boolean(query) && !rowMatch && !entryMatch && !sampleMatch;
                for (const item of sampleItems) item.sample.hidden = Boolean(query) && !rowMatch && !entryMatch && !found.has(item);
                if (query && sampleMatch && !rowMatch && !entryMatch) {
                    void setDisclosureOpen(entry.source, view.overrides.get(entry.source) ?? true, { animate: false });
                }
            }
            row.hidden = Boolean(query) && !rowMatch && ![...entryMatches.values()].some(Boolean);
            if (!row.hidden) matches++;
            if (query && !rowMatch && !row.hidden && row.matches('details')) {
                void setDisclosureOpen(row, view.overrides.get(row) ?? true, { animate: false });
            }
        }
        noMatches.remove();
        if (query && !matches) modelScoresList.append(noMatches);
    }

    function requestRankingSource(view, entry) {
        if (!view.current()) return;
        if (entry.group) {
            if (!entry.rendered) {
                renderApprovedScoreSamples(entry.group, entry.samples);
                entry.rendered = true;
                filterRankingScores(view);
            }
            return;
        }
        if (entry.pending || entry.error) return;
        entry.pending = true;
        setLoading(entry.samples, 'Loading approved scores…');
        entry.samples.dataset.sourceState = 'loading';
        entry.samples.setAttribute('aria-busy', 'true');
        void loadRankingSource(view, entry);
    }

    async function loadRankingSource(view, entry) {
        try {
            const payload = validateApprovedModelResultsPayload(await postJSON('/api/get_approved_benchmark_results', {
                modelID: Number(entry.member.modelID), scoreFields: entry.member.condition.scoreFields,
                expectedEvidence: { conditionID: entry.conditionID, hash: entry.hash }
            }, { signal: view.controller.signal, timeoutMs: 20000 }));
            if (!view.current()) return;
            if (payload.model.modelID !== Number(entry.member.modelID)
                || JSON.stringify(payload.model.scoreFields) !== JSON.stringify(entry.member.condition.scoreFields)) {
                throw invalidModelScoresResponse('model', 'does not match the requested score configuration');
            }
            const group = payload.scoreGroups.find(item => item.benchmarkConditionID === entry.conditionID);
            if (!group || group.evidenceHash !== entry.hash) throw { payload: { error: 'ranking_evidence_changed' } };
            entry.group = group;
            if (isDisclosureOpen(entry.source)) requestRankingSource(view, entry);
        } catch (error) {
            if (!view.current()) return;
            entry.error = error;
            const changed = error?.payload?.error === 'ranking_evidence_changed';
            const message = document.createElement('p');
            message.className = 'bp-model-configuration-error';
            message.textContent = changed ? 'Scores have changed since this ranking was calculated.'
                : 'Approved scores could not be loaded.';
            const action = createAction({ label: changed ? 'Refresh ranking' : 'Retry',
                icon: 'fa-solid fa-rotate', className: 'bp-inline-link' });
            action.addEventListener('click', () => {
                if (!view.current()) return;
                if (changed) {
                    modelScoresDialog.hidden = true;
                    document.getElementById('workspace-refresh').click();
                } else {
                    entry.error = null;
                    entry.sourceHeading.focus({ preventScroll: true });
                    requestRankingSource(view, entry);
                }
            });
            entry.samples.dataset.sourceState = 'error';
            entry.samples.replaceChildren(message, action);
        } finally {
            entry.pending = false;
            entry.samples.removeAttribute('aria-busy');
            if (view.current()) filterRankingScores(view);
        }
    }

    function openApprovedModelResults(model) {
        cancelAllScores();
        activeModel = model;
        ++modelScoresRequestSequence;
        renderComparisonName(modelScoresTitle, model, state.comparison);
        modelScoresList.replaceChildren();
        search.value = '';
        setSearchScope('ranking');
        modelScoresDialog.hidden = false;
        renderModelChangeControls(model);
        selectTab(true);
        rankingView = { current: readGuard(modelScoresRequestSequence, model), controller: new globalThis.AbortController(),
            entries: [], query: '', browsing: new Map(), overrides: new WeakMap() };
        renderCalculationResults(model);
        animateContent(modelScoresList);
    }

    async function showAllScores(model) {
        if (!model) return;
        cancelAllScores();
        activeModel = model;
        renderModelChangeControls(model);
        selectTab(false);
        search.value = '';
        setSearchScope('configurations');
        const sequence = ++modelScoresRequestSequence;
        const current = readGuard(sequence, model);
        const view = { current, entries: [], ready: false, omitted: false, controller: new globalThis.AbortController(), active: 0,
            query: '', browsing: new Map() };
        allScoresView = view;
        renderComparisonName(modelScoresTitle, model, state.comparison);
        modelScoresList.replaceChildren();
        setLoading(modelScoresSummary, 'Loading all recorded configurations…');
        try {
            const modelIDs = [...new Set((model.members ?? [model]).map(member => member.modelID))];
            const batches = [];
            for (let index = 0; index < modelIDs.length; index += 32) batches.push(modelIDs.slice(index, index + 32));
            const results = new Array(batches.length);
            let nextBatch = 0;
            async function loadBatch() {
                while (current()) {
                    const index = nextBatch++;
                    if (index >= batches.length) return;
                    const modelIDs = batches[index];
                    const response = await postJSON('/api/get_model_score_configurations', { modelIDs, includeVersions: true },
                        { signal: view.controller.signal, timeoutMs: 20000 });
                    requireAllScoresDisplayPolicy(response);
                    if (!Array.isArray(response.omittedConfigurations) || response.omittedConfigurations.some(item => !item
                        || !modelIDs.includes(item.modelID) || !Array.isArray(item.scoreFields)
                        || item.displayRestriction !== AA_DISPLAY_RESTRICTION)) {
                        throw invalidModelScoresResponse('omittedConfigurations', 'must identify restricted score configurations');
                    }
                    view.omitted ||= matchingScoreConfigurations(response.omittedConfigurations, model, state.comparison).length > 0;
                    results[index] = matchingScoreConfigurations(validateModelScoreConfigurationIndex(response, modelIDs).configurations,
                        model, state.comparison).map(item => {
                        const scoreGroups = item.scoreGroups.filter(group => !restrictedScoreGroup(group));
                        view.omitted ||= scoreGroups.length !== item.scoreGroups.length;
                        return { ...item, scoreGroups, scoreCount: scoreGroups.reduce((sum, group) => sum + group.sampleCount, 0) };
                    }).filter(item => item.scoreGroups.length);
                }
            }
            await Promise.all(Array.from({ length: Math.min(3, batches.length) }, loadBatch));
            if (!current()) return;
            const members = matchingScoreConfigurations(results.flat(), model, state.comparison).map(item => ({ modelID: item.modelID,
                modelName: item.modelName,
                name: item.modelName + (item.configurationName ? ', ' + item.configurationName : ''),
                configurationName: item.configurationName,
                condition: { scoreFields: item.scoreFields }, scoreCount: item.scoreCount, scoreGroups: item.scoreGroups }));
            renderAllConfigurations(members, model, view);
        } catch (error) {
            if (!current()) return;
            view.controller.abort();
            modelScoresSummary.textContent = 'All scores could not be loaded.';
            const retry = createAction({ label: 'Retry', className: 'bp-inline-link' });
            retry.addEventListener('click', () => showAllScores(model));
            modelScoresList.append(retry);
            console.error('[BenchPoll] Model configuration evidence unavailable', error);
        }
    }

    function renderAllConfigurations(members, model, view) {
        renderComparisonName(modelScoresTitle, model, state.comparison);
        modelScoresList.replaceChildren();
        for (const member of members) {
            const row = document.createElement('details');
            row.className = 'bp-model-score-detail-row bp-model-score-configuration';
            const heading = document.createElement('summary');
            heading.className = 'bp-model-configuration-heading';
            const name = document.createElement('span');
            renderComparisonName(name, member, { ...state.comparison, keys: ['model', ...member.condition.scoreFields.map(item => `field:${item.fieldID}`)] });
            if (!member.condition.scoreFields.length) {
                const label = document.createElement('span');
                label.className = 'bp-model-display-parameter bp-model-empty-fields';
                label.textContent = 'No fields recorded'; name.append(label);
            }
            const count = document.createElement('small'); count.textContent = `${member.scoreCount} scores`;
            heading.append(name, count);
            const body = document.createElement('div'); body.className = 'bp-model-configuration-evidence';
            const entry = { member, row, body, count, versions: new Map(), payload: null, rendered: false,
                error: null, pending: false, requested: false,
                searchOverride: null, searchFields: [member.modelName, member.configurationName || 'No fields recorded',
                    ...[...name.querySelectorAll('[data-tooltip]')].map(item => item.dataset.tooltip)] };
            view.entries.push(entry);
            heading.addEventListener('click', () => {
                if (!view.current()) return;
                const open = !isDisclosureOpen(row);
                entry.searchOverride = open;
                if (open) renderConfiguration(view, entry);
                else entry.requested = false;
            });
            row.addEventListener('toggle', () => {
                if (!view.current()) return;
                if (isDisclosureOpen(row)) renderConfiguration(view, entry);
                else entry.requested = false;
            });
            row.append(heading, body); modelScoresList.append(row);
        }
        view.ready = true;
        updateAllScoresSummary(view);
        filterScores();
        animateContent(modelScoresList);
    }

    function filterAllConfigurations(view) {
        if (!view.current() || !view.ready) return;
        const query = search.value.trim();
        const changed = query !== view.query;
        if (changed) {
            if (!view.query && query) view.browsing = new Map([...modelScoresList.querySelectorAll('details')]
                .map(row => [row, isDisclosureOpen(row)]));
            view.entries.forEach(entry => { entry.searchOverride = null; });
            view.query = query;
            if (!query) for (const row of modelScoresList.querySelectorAll('details')) {
                void setDisclosureOpen(row, view.browsing.get(row) ?? false, { animate: false });
            }
        }
        const results = allScoresSearchResults(view.entries, query);
        let matches = 0;
        for (const { entry, configurationMatch, groups } of results) {
            entry.row.hidden = Boolean(query) && !configurationMatch && !groups.size;
            if (!entry.row.hidden) matches++;
            const open = query ? entry.searchOverride ?? (!configurationMatch && groups.size > 0)
                : isDisclosureOpen(entry.row);
            if (open && !entry.row.hidden) renderConfiguration(view, entry);
            entry.body.querySelectorAll('.bp-model-score-detail-row').forEach(row => {
                row.hidden = Boolean(query) && !configurationMatch && !groups.has(Number(row.dataset.conditionId));
            });
            if (query) {
                void setDisclosureOpen(entry.row, open, { animate: false });
            }
        }
        noMatches.remove();
        modelScoresList.setAttribute('aria-busy', 'false');
        if (query && !matches) modelScoresList.append(noMatches);
        renderAllScoresNotice(view);
    }

    function addConfigurationGroups(view, entry, groups) {
        const records = appendApprovedScoreGroups({ scoreGroups: groups }, entry.body, false, record => {
            if (!view.current() || entry.versions.get(record.group.benchmarkConditionID) !== record) return;
            if (isDisclosureOpen(record.row) && !record.row.hidden && !entry.row.hidden && isDisclosureOpen(entry.row)) {
                requestConfiguration(view, entry);
            } else if (![...entry.versions.values()].some(item => isDisclosureOpen(item.row))) entry.requested = false;
        });
        for (const record of records) entry.versions.set(record.group.benchmarkConditionID, record);
    }

    function renderConfiguration(view, entry) {
        if (entry.rendered) return;
        addConfigurationGroups(view, entry, entry.member.scoreGroups);
        entry.rendered = true;
    }

    function renderOpenConfigurationSources(entry) {
        for (const record of entry.versions.values()) {
            if (!isDisclosureOpen(record.row) || record.loaded) continue;
            renderApprovedScoreSamples(record.group, record.samples);
            record.loaded = true;
        }
    }

    function applyConfigurationPayload(view, entry, payload) {
        const scoreGroups = payload.scoreGroups.filter(group => !restrictedScoreGroup(group));
        view.omitted ||= hasAADisplayRestriction(payload) || scoreGroups.length !== payload.scoreGroups.length;
        payload = { ...payload, scoreGroups };
        entry.payload = payload;
        let focusHeading = null;
        const present = new Set(payload.scoreGroups.map(group => group.benchmarkConditionID));
        for (const [ID, record] of entry.versions) {
            if (present.has(ID)) continue;
            if (record.row.contains(document.activeElement)) entry.row.querySelector('summary').focus({ preventScroll: true });
            record.row.remove();
            entry.versions.delete(ID);
        }
        for (const group of payload.scoreGroups) {
            const record = entry.versions.get(group.benchmarkConditionID);
            if (!record) addConfigurationGroups(view, entry, [group]);
            else {
                const heading = record.row.querySelector('summary');
                const focused = heading.contains(document.activeElement);
                const updated = approvedScoreHeading(group);
                heading.replaceWith(updated);
                if (focused) focusHeading = updated;
                record.group = group;
                record.loaded = false;
                record.samples.replaceChildren();
            }
            entry.body.append(entry.versions.get(group.benchmarkConditionID).row);
        }
        if (!payload.scoreGroups.length) {
            if (entry.row.contains(document.activeElement)) search.focus({ preventScroll: true });
            entry.row.remove();
            view.entries = view.entries.filter(item => item !== entry);
        }
        focusHeading?.focus({ preventScroll: true });
        entry.member.scoreCount = payload.scoreGroups.reduce((sum, group) => sum + group.sampleCount, 0);
        entry.count.textContent = `${entry.member.scoreCount} scores`;
        updateAllScoresSummary(view);
        renderOpenConfigurationSources(entry);
    }

    function updateAllScoresSummary(view) {
        modelScoresSummary.textContent = `${view.entries.length} recorded configurations, ${view.entries.reduce((sum, item) => sum + item.member.scoreCount, 0)} approved scores`;
        view.empty?.remove();
        if (!view.entries.length) {
            view.empty = document.createElement('p'); view.empty.className = 'bp-model-scores-empty';
            view.empty.textContent = 'No approved scores match this ranking entry.';
            modelScoresList.append(view.empty);
        }
    }

    function renderConfigurationError(view, entry) {
        for (const record of entry.versions.values()) {
            if (!isDisclosureOpen(record.row)) continue;
            const message = document.createElement('p'); message.className = 'bp-model-configuration-error';
            message.textContent = 'Approved scores could not be loaded.';
            const retry = createAction({ label: 'Retry', icon: 'fa-solid fa-rotate', className: 'bp-inline-link' });
            retry.addEventListener('click', () => {
                if (!view.current()) return;
                entry.error = null;
                record.row.querySelector('summary').focus({ preventScroll: true });
                requestConfiguration(view, entry);
            });
            record.samples.dataset.sourceState = 'error';
            record.samples.replaceChildren(message, retry);
        }
    }

    function requestConfiguration(view, entry) {
        if (!view.current()) return;
        if (entry.payload) {
            renderOpenConfigurationSources(entry);
            return;
        }
        if (entry.error) { renderConfigurationError(view, entry); return; }
        entry.requested = true;
        pumpConfigurations(view);
    }

    function pumpConfigurations(view) {
        if (!view.current()) return;
        // Only explicit version-source expansions enqueue full evidence reads.
        while (view.active < 3) {
            const entry = view.entries.find(item => item.requested && !item.pending && !item.payload && !item.error);
            if (!entry) break;
            entry.pending = true;
            view.active++;
            for (const record of entry.versions.values()) if (isDisclosureOpen(record.row)) {
                setLoading(record.samples, 'Loading approved scores…');
                record.samples.dataset.sourceState = 'loading';
                record.samples.setAttribute('aria-busy', 'true');
            }
            void loadConfiguration(view, entry);
        }
    }

    async function loadConfiguration(view, entry) {
        const member = entry.member;
        try {
            const payload = validateApprovedModelResultsPayload(await postJSON('/api/get_approved_benchmark_results', {
                modelID: Number(member.modelID), scoreFields: member.condition.scoreFields
            }, { signal: view.controller.signal, timeoutMs: 20000 }));
            if (!view.current()) return;
            requireAllScoresDisplayPolicy(payload);
            if (payload.model.modelID !== Number(member.modelID)
                || JSON.stringify(payload.model.scoreFields) !== JSON.stringify(member.condition.scoreFields)) {
                throw invalidModelScoresResponse('model', 'does not match the requested score configuration');
            }
            applyConfigurationPayload(view, entry, payload);
        } catch (error) {
            if (!view.current()) return;
            entry.error = error;
            renderConfigurationError(view, entry);
            console.error('[BenchPoll] Model configuration evidence unavailable', error);
        } finally {
            entry.pending = false;
            view.active--;
            if (view.current()) {
                entry.versions.forEach(record => record.samples.removeAttribute('aria-busy'));
                filterAllConfigurations(view);
                pumpConfigurations(view);
            }
        }
    }

    return { openApprovedModelResults };
}
