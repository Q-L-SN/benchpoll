import { setLoading } from '../shared/loading.js';
import { mergeBenchmarkWeights, compositionPercentages } from './expanded-weights.js';
import { createAction } from '../shared/ui-components.js';
import { orderedScenes, sceneURL, searchTopicGroups } from '../navigation/scenes.js';
import { isTopicReference, referenceLabel, topicLabelText, renderTopicLabel } from '../shared/topic-label.js';

export { isTopicReference, referenceLabel };
export function topicReferenceUnavailable(target, currentContextID, sourceIsPrivate) {
    const targetID = Number(target.referenceContextID ?? target.contextID ?? -(target.conditionID ?? target.ID));
    if (targetID === Number(currentContextID)) return 'Cannot reference this same scene or topic';
    if (target.isPrivate && !sourceIsPrivate) return 'Private topics cannot enter public-topic weights';
    if (!target.hasWeights) return 'This topic has no weights yet';
    return '';
}
export function topicReferenceError(error) {
    return {
        topic_reference_depth_limit: 'This reference chain is too deep. Choose a more direct topic.',
        topic_reference_size_limit: 'This reference graph is too large. Remove a reference before saving.',
        topic_reference_not_found: 'A referenced topic is no longer available. Remove it or choose another.',
        topic_reference_self: 'Cannot reference this same scene or topic.',
        topic_reference_empty: 'This topic has no weights yet.',
        private_topic_reference_not_public: 'Private topics cannot be referenced by public-topic weights.'
    }[error?.payload?.error] || '';
}
const node = (tag, className, text) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
};

export function referenceGroups(targets, query = '') {
    const groups = new Map();
    for (const target of targets) {
        const key = Number(target.categoryID);
        if (!groups.has(key)) groups.set(key, { categoryID: key, name: target.topicName || target.name,
            isPrivate: target.isPrivate === true, targets: [] });
        groups.get(key).targets.push(target);
    }
    const topics = [...groups.values()].map(group => {
        // A scene-bearing topic has no selectable root, even if an older response includes it.
        const concrete = group.targets.some(target => target.sceneID != null)
            ? group.targets.filter(target => target.sceneID != null) : group.targets;
        const hasScenes = concrete.some(target => target.sceneID != null);
        return { ...group, targets: concrete, hasScenes, description: hasScenes ? '' : concrete[0]?.description,
            scenes: hasScenes ? concrete.map(target => ({ ...target, name: target.sceneName, target })) : [] };
    });
    return searchTopicGroups(topics, query).map(({ topic, scenes, topicMatch }) => ({ ...topic,
        collapsed: topic.hasScenes && topicMatch && !scenes.length,
        targets: topic.hasScenes ? (scenes.length ? scenes : orderedScenes(topic.scenes)).map(scene => scene.target) : topic.targets }));
}

export function validateReferenceTargets(payload) {
    if (!Array.isArray(payload?.targets)) throw new TypeError('Invalid topic reference targets');
    const ids = new Set();
    for (const item of payload.targets) {
        if (!Number.isSafeInteger(item?.contextID) || item.contextID < 1
            || !Number.isSafeInteger(item.categoryID) || item.categoryID < 1
            || (item.sceneID != null && item.sceneID !== item.contextID)
            || typeof item.name !== 'string' || !item.name.trim()
            || typeof item.topicName !== 'string' || typeof item.isPrivate !== 'boolean'
            || typeof item.hasWeights !== 'boolean' || !sceneURL(item.url)
            || ids.has(item.contextID)) throw new TypeError('Invalid topic reference target');
        ids.add(item.contextID);
    }
    return payload.targets;
}

export function referenceIssueMessage(issue) {
    const reasons = {
        closed_cycle: 'This cycle does not reach a benchmark',
        empty: 'No weights in the referenced topic', empty_target: 'No weights in the referenced topic',
        missing: 'Referenced topic no longer exists', missing_target: 'Referenced topic no longer exists',
        inaccessible: 'Referenced topic is not accessible', private: 'Private topic cannot enter public weights',
        private_target: 'Private topic cannot enter public weights', unavailable: 'Referenced topic is unavailable',
        depth_limit: 'Reference chain exceeds the depth limit', size_limit: 'Reference graph exceeds the size limit'
    };
    return `${issue.name || 'Referenced topic'}: ${reasons[issue.reason] || 'Reference could not be resolved'}.`;
}

export function createTopicReferencePicker({ request, getScope, getCurrentContextID, getEntries, isPrivate, onAdd }) {
    const dialog = node('dialog', 'bp-reference-dialog'); dialog.id = 'topic-reference-dialog';
    dialog.setAttribute('aria-labelledby', 'topic-reference-title');
    const header = node('header', 'bp-reference-header');
    const title = node('h2', '', 'Add a topic'); title.id = 'topic-reference-title';
    const close = createAction({ label: 'Close topic selector', icon: 'fa-solid fa-xmark', iconOnly: true, variant: 'quiet' });
    header.append(title, close);
    const search = node('input', 'bp-ui-input'); search.type = 'search'; search.placeholder = 'Search topics or scenes';
    search.setAttribute('aria-label', 'Search topics or scenes'); search.maxLength = 120;
    const back = createAction({ label: 'All topics', icon: 'fa-solid fa-arrow-left', variant: 'quiet' });
    back.hidden = true;
    const status = node('p', 'bp-reference-status'); status.setAttribute('role', 'status');
    const list = node('div', 'bp-reference-options');
    dialog.append(header, search, back, status, list); document.body.append(dialog);
    let targets = [], scope = '', selectedCategory = null, controller = null, sequence = 0, returnFocus = null, adding = false;
    const valid = () => dialog.open && scope === getScope();
    function hide() { ++sequence; controller?.abort(); dialog.close(); returnFocus?.focus({ preventScroll: true }); }
    close.addEventListener('click', hide);
    dialog.addEventListener('cancel', () => { ++sequence; controller?.abort(); });
    dialog.addEventListener('close', () => { ++sequence; controller?.abort(); });
    back.addEventListener('click', () => { selectedCategory = null; render(); search.focus(); });
    search.addEventListener('input', () => { selectedCategory = null; render(); });

    function appendTarget(target) {
        const row = node('div', 'bp-reference-option'); row.dataset.contextId = String(target.contextID);
        const copy = node('div', 'bp-reference-option-copy');
        const name = node('strong', '');
        renderTopicLabel(name, topicLabelText(target));
        copy.append(name);
        if (target.description) copy.append(node('small', '', target.description));
        const alreadyAdded = getEntries().some(entry => Number(entry.conditionID) === -target.contextID);
        const unavailable = topicReferenceUnavailable(target, getCurrentContextID(), isPrivate());
        const add = createAction({ label: alreadyAdded ? 'Added' : 'Add', icon: alreadyAdded ? 'fa-solid fa-check' : 'fa-solid fa-plus', variant: 'quiet' });
        add.disabled = Boolean(alreadyAdded || unavailable || adding);
        if (unavailable) { row.dataset.tooltip = unavailable; row.tabIndex = 0; }
        add.addEventListener('click', async () => {
            if (!valid() || adding) return;
            adding = true; render();
            try {
                if (await onAdd({ ...target, name: referenceLabel(target), ID: -target.contextID,
                    conditionID: -target.contextID, referenceContextID: target.contextID, type: 'topic' }) && valid()) hide();
                else if (valid()) status.textContent = 'Could not add this reference. Check your current weights.';
            } catch (error) { if (valid()) status.textContent = error.message || 'Could not add this reference.'; }
            finally { adding = false; if (valid()) render(); }
        });
        row.append(copy, add); list.append(row);
    }

    function render() {
        if (!valid()) return;
        const groups = referenceGroups(targets, search.value);
        list.replaceChildren(); back.hidden = selectedCategory === null;
        title.textContent = selectedCategory ? groups.find(group => group.categoryID === selectedCategory)?.name || 'Choose a scene' : 'Add a topic';
        status.textContent = selectedCategory ? 'Choose a scene to reference.' : '';
        for (const group of groups) {
            if (selectedCategory && group.categoryID !== selectedCategory) continue;
            if (group.collapsed && !selectedCategory) {
                const choose = createAction({ label: group.name, icon: 'fa-solid fa-chevron-right', variant: 'quiet', className: 'bp-reference-topic' });
                choose.setAttribute('aria-label', group.name);
                renderTopicLabel(choose.querySelector('span'), topicLabelText(group));
                choose.setAttribute('aria-expanded', 'false');
                choose.addEventListener('click', () => {
                    selectedCategory = group.categoryID; render(); list.querySelector('button:not(:disabled)')?.focus();
                });
                list.append(choose);
            } else group.targets.forEach(appendTarget);
        }
        if (!list.children.length) status.textContent = 'No matching topics or scenes.';
    }

    return {
        async open(trigger) {
            controller?.abort(); controller = new globalThis.AbortController();
            const current = ++sequence; scope = getScope(); targets = []; selectedCategory = null; adding = false;
            returnFocus = trigger; search.value = ''; list.replaceChildren(); back.hidden = true;
            title.textContent = 'Add a topic'; setLoading(status, 'Loading topics...'); dialog.showModal(); search.focus();
            try {
                const result = await request({}, { signal: controller.signal });
                if (current !== sequence || !valid()) return;
                targets = validateReferenceTargets(result).filter(target => isPrivate() || !target.isPrivate); render();
            } catch (error) {
                if (current !== sequence || !valid() || error.name === 'AbortError') return;
                status.textContent = 'Could not load topics.';
                const retry = createAction({ label: 'Retry', icon: 'fa-solid fa-rotate-right', variant: 'quiet' });
                retry.addEventListener('click', () => { hide(); void this.open(trigger); }); list.append(retry);
            }
        },
        close: hide,
        refresh() { if (dialog.open && !valid()) hide(); else render(); }
    };
}

export function renderTopicReferences(host, { entry, composition, versions, dirty = false }) {
    host.replaceChildren();
    host.hidden = !entry;
    if (!entry) { delete host.dataset.referenceId; return; }
    host.dataset.referenceId = String(entry.referenceContextID ?? -entry.conditionID);
    if (dirty || !composition) {
        const status = node('p', 'bp-reference-status');
        if (dirty) setLoading(status, 'Updating topic composition');
        else status.textContent = 'Composition is unavailable. Refresh to try again.';
        host.append(status);
    } else {
        const entries = mergeBenchmarkWeights(composition.entries, versions);
        const percentages = compositionPercentages(entries);
        const list = node('ul', 'bp-reference-composition');
        list.setAttribute('aria-label', 'Selected topic composition');
        entries.forEach((item, index) => {
            const row = node('li', ''); row.dataset.benchmarkId = String(item.benchmarkID ?? '');
            row.append(node('span', '', item.name), node('strong', '', percentages[index]));
            list.append(row);
        });
        host.append(list);
        if (composition.issues?.length) {
            const warnings = node('div', 'bp-reference-warnings'); warnings.setAttribute('role', 'status');
            for (const issue of composition.issues) warnings.append(node('p', '', referenceIssueMessage(issue)));
            host.append(warnings);
        }
    }
    const href = sceneURL(entry.url);
    if (href) {
        const visit = createAction({ label: `Visit ${referenceLabel(entry)}`, icon: 'fa-solid fa-arrow-up-right-from-square',
            href, variant: 'quiet', className: 'bp-reference-visit' });
        host.append(visit);
    }
}
