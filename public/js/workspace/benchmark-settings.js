import { createAction } from '../shared/ui-components.js';
import { versionChoiceOrder } from '../shared/benchmark-version-choice.js';
import { createEvidenceCount, updateEvidenceCount } from '../shared/evidence-count.js';
import { setHelpText } from '../shared/help-popover.js';

function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

const versionName = version => version.conditionName?.toLowerCase() === 'default' ? 'Default evaluation' : version.conditionName;
const shareLabel = points => points > 0 && points < 1 ? '<0.01%' : `${Number(((points ?? 0) / 100).toFixed(2))}%`;
const communityHelp = 'The percentage is the community’s scoring version share, weighted by each person’s allocation to this benchmark. '
    + 'The thumbs show votes in this scene about using that version to estimate missing scores.';
const personalHelp = 'Choose one version for scoring. Select it again to follow the community. '
    + 'Use the thumbs to support or oppose a version as a source for estimating missing scores. Select the same thumb again to clear your vote. ';

function selectedCondition(entries) {
    return entries.length === 1 && entries[0].followCommunityVersion !== true ? entries[0].conditionID : null;
}

function icon(className) {
    const element = node('i', className);
    element.setAttribute('aria-hidden', 'true');
    return element;
}

function choiceElement(className, readOnly) {
    const element = node(readOnly ? 'span' : 'button', className);
    if (!readOnly) element.type = 'button';
    return element;
}

export function createBenchmarkSettings({ host, selectedHeader, getScope, getData, onVersion, onVote }) {
    const title = node('h3', 'bp-benchmark-settings-title');
    title.hidden = Boolean(selectedHeader);
    const status = node('p', 'bp-benchmark-settings-status');
    status.setAttribute('role', 'status');
    const heading = node('div', 'bp-version-choices-heading');
    const voteHeading = node('div', 'bp-estimation-votes-heading');
    const help = createAction({ label: 'About scoring versions and score estimation', icon: 'fa-regular fa-circle-question', iconOnly: true });
    voteHeading.append(node('span', '', 'Estimation'), help);
    heading.append(node('span', '', 'Scoring version'), voteHeading);
    const list = node('ul', 'bp-version-choices');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Benchmark versions');
    host.append(title, status, heading, list);

    const rows = new Map();
    let intent = null;

    function close() {
        if (intent) {
            rows.clear();
            list.replaceChildren();
        }
        host.hidden = true;
        intent = null;
    }

    function data() {
        return intent && intent.scope === getScope() ? getData(intent.benchmarkID) : null;
    }

    function chooseVersion(conditionID) {
        const current = data();
        if (!current?.editable || current.busy || current.readOnly) return;
        const next = selectedCondition(current.entries) === conditionID ? null : conditionID;
        if (onVersion(current.group, next)) refresh();
    }

    function chooseVote(conditionID, vote) {
        const current = data();
        if (!current?.editable || current.busy || current.readOnly) return;
        const previous = current.personalEstimationVotes.find(item => item.conditionID === conditionID)?.vote;
        if (onVote(current.group, conditionID, previous === vote ? null : vote)) refresh();
    }

    function createVote(conditionID, vote, readOnly) {
        const element = choiceElement('bp-estimation-vote', readOnly);
        const glyph = icon('');
        const value = node('span', 'bp-estimation-vote-count');
        value.setAttribute('aria-hidden', 'true');
        element.dataset.vote = vote;
        element.append(glyph, value);
        if (readOnly) element.setAttribute('role', 'img');
        else element.addEventListener('click', () => chooseVote(conditionID, vote));
        return { element, glyph, value };
    }

    function createRow(conditionID, readOnly) {
        const row = node('li', 'bp-version-choice-row');
        row.dataset.conditionId = String(conditionID);
        const choice = choiceElement('bp-version-choice', readOnly);
        choice.dataset.conditionId = String(conditionID);
        const indicator = icon('fa-regular fa-circle');
        indicator.hidden = readOnly;
        const details = node('span', 'bp-version-choice-details');
        const name = node('span', 'bp-version-choice-name');
        const metadata = node('span', 'bp-version-choice-metadata');
        const scores = createEvidenceCount(0);
        scores.removeAttribute('tabindex');
        const share = node('span', 'bp-version-choice-share');
        share.setAttribute('role', 'img');
        metadata.append(scores, share);
        details.append(name, metadata);
        choice.append(indicator, details);
        if (!readOnly) choice.addEventListener('click', () => chooseVersion(conditionID));
        const votes = node('div', 'bp-estimation-votes');
        const support = createVote(conditionID, 'support', readOnly);
        const oppose = createVote(conditionID, 'oppose', readOnly);
        votes.append(support.element, oppose.element);
        row.append(choice, votes);
        list.append(row);
        return { row, choice, name, indicator, scores, share, support, oppose };
    }

    function updateVote(button, vote, name, count, pressed, readOnly, disabled) {
        const { element, glyph, value } = button;
        const supporting = vote === 'support';
        const description = `${count} ${count === 1 ? 'vote' : 'votes'} ${supporting ? 'supporting' : 'opposing'} ${name} for score estimation`;
        glyph.className = `fa-${pressed ? 'solid' : 'regular'} fa-thumbs-${supporting ? 'up' : 'down'}`;
        value.textContent = String(count);
        if (readOnly) {
            element.setAttribute('aria-label', description);
            element.dataset.tooltip = description;
            return;
        }
        const label = `${supporting ? 'Support' : 'Oppose'} ${name} for score estimation`;
        element.disabled = disabled;
        element.setAttribute('aria-pressed', String(pressed));
        element.setAttribute('aria-label', label);
        element.setAttribute('aria-description', description);
        element.dataset.tooltip = `${label}. ${count} community ${count === 1 ? 'vote' : 'votes'}.`;
    }

    function updateRow(row, version, selected, vote, counts, readOnly, disabled) {
        const name = versionName(version), share = shareLabel(version.selectionBasisPoints);
        const shareDescription = `${share} community scoring version share`;
        row.name.textContent = name;
        updateEvidenceCount(row.scores, version.scoreCount);
        row.share.textContent = share;
        row.share.setAttribute('aria-label', shareDescription);
        row.share.dataset.tooltip = shareDescription;
        if (!readOnly) {
            row.choice.disabled = disabled;
            row.choice.setAttribute('aria-pressed', String(selected));
            row.choice.setAttribute('aria-label', `Use ${name} for scoring`);
            row.choice.setAttribute('aria-description', `${row.scores.getAttribute('aria-label')} ${shareDescription}.`);
            row.indicator.className = selected ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle';
        }
        updateVote(row.support, 'support', name, counts?.supportCount ?? 0, !readOnly && vote === 'support', readOnly, disabled);
        updateVote(row.oppose, 'oppose', name, counts?.opposeCount ?? 0, !readOnly && vote === 'oppose', readOnly, disabled);
    }

    function refresh(primary, expanded) {
        if (primary !== undefined) {
            if (!primary || !expanded) { close(); return; }
            const scope = getScope();
            if (intent?.scope !== scope || intent?.benchmarkID !== primary.benchmarkID) {
                close();
                intent = { scope, benchmarkID: primary.benchmarkID };
            }
        }
        const current = data();
        if (!current) { close(); return; }
        const { group, entries, readOnly, editable, busy, personalEstimationVotes, communityEstimationVotes } = current;
        const selected = readOnly ? null : selectedCondition(entries);
        const message = readOnly ? 'Read-only' : entries.length > 1 ? 'Choose a scoring version to replace your saved version mix.'
            : selected !== null ? 'Select it again to follow the community.'
                : group.isDefault ? 'Using the default scoring version.' : 'Following community scoring versions.';
        if (status.textContent !== message) status.textContent = message;
        if (title.textContent !== group.name) title.textContent = group.name;
        host.setAttribute('aria-label', `Advanced settings for ${group.name}`);
        if (host.dataset.readonly !== String(readOnly)) {
            host.dataset.readonly = String(readOnly);
            setHelpText(help, readOnly ? communityHelp : personalHelp + communityHelp);
        }
        const personalVotes = new Map(personalEstimationVotes.map(({ conditionID, vote }) => [conditionID, vote]));
        const counts = new Map(communityEstimationVotes.map(item => [item.conditionID, item]));
        const versions = new Map(group.versions.map(version => [version.conditionID, version]));
        for (const [conditionID, row] of rows) {
            if (!versions.has(conditionID)) { row.row.remove(); rows.delete(conditionID); }
        }
        // Existing rows stay in place through rank refreshes. A new visit starts with current community proportions.
        for (const version of [...versions.values()].sort(versionChoiceOrder)) {
            const { conditionID } = version;
            if (!rows.has(conditionID)) rows.set(conditionID, createRow(conditionID, readOnly));
            updateRow(rows.get(conditionID), version, selected === conditionID, personalVotes.get(conditionID),
                counts.get(conditionID), readOnly, !editable || busy);
        }
        host.hidden = false;
    }

    return { refresh, close };
}
