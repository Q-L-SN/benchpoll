import { setLoading } from '../shared/loading.js';
import { createAction, mountDisclosureChevron } from '../shared/ui-components.js';
import { setVisible } from '../shared/motion.js';
import { referenceGroups, validateReferenceTargets, topicReferenceUnavailable } from './topic-references.js';
import { referenceLabel, topicLabelText, renderTopicLabel } from '../shared/topic-label.js';
import { sceneURL } from '../navigation/scenes.js';

export function createTopicReferenceSearch({ request, getScope, getCurrentContextID, getEntries, isPrivate, canAdd, onAdd, onChange }) {
    let scope, targets = null, controller, error = '', actionError = '', adding = false, currentQuery = '';
    const expanded = new Set();
    const node = (tag, className, text) => {
        const element = document.createElement(tag); element.className = className;
        if (text) element.textContent = text;
        return element;
    };
    async function load() {
        controller?.abort();
        const pending = new globalThis.AbortController(), requestedScope = scope;
        controller = pending; error = '';
        try {
            const result = validateReferenceTargets(await request({}, { signal: pending.signal }));
            if (controller === pending && getScope() === requestedScope) targets = result;
        } catch (failure) {
            if (controller === pending && getScope() === requestedScope && failure.name !== 'AbortError') error = 'Could not load topics.';
        } finally {
            if (controller === pending) { controller = null; if (getScope() === requestedScope) onChange(); }
        }
    }
    function render(host, query, active) {
        if (scope !== getScope()) {
            controller?.abort(); controller = null; scope = getScope(); targets = null; error = ''; actionError = ''; expanded.clear();
        }
        if (query !== currentQuery) { currentQuery = query; expanded.clear(); }
        host.replaceChildren(); host.hidden = !active || !query;
        if (host.hidden) return;
        host.className = 'bp-benchmark-topic-results';
        if (targets === null) {
            const status = node('p', 'bp-reference-status', error); status.setAttribute('role', 'status');
            if (!error) setLoading(status, 'Loading topics');
            host.append(status);
            if (error) {
                const retry = createAction({ label: 'Retry topics', icon: 'fa-solid fa-rotate-right', variant: 'quiet' });
                retry.addEventListener('click', () => { void load(); onChange(); }); host.append(retry);
            } else if (!controller) void load();
            return;
        }
        const groups = referenceGroups(targets.filter(target => isPrivate() || !target.isPrivate), query);
        host.hidden = !groups.length;
        if (!groups.length) return;
        host.append(node('h3', 'bp-reference-search-heading', 'Topics'));
        if (actionError) { const notice = node('p', 'bp-reference-status', actionError); notice.setAttribute('role', 'status'); host.append(notice); }
        for (const group of groups) {
            let targetHost = host;
            if (group.collapsed) {
                const open = expanded.has(group.categoryID);
                const toggle = createAction({ label: group.name, icon: 'fa-solid fa-chevron-right', variant: 'quiet', className: 'bp-reference-topic' });
                mountDisclosureChevron(toggle);
                toggle.setAttribute('aria-label', group.name); toggle.setAttribute('aria-expanded', String(open));
                renderTopicLabel(toggle.querySelector('span'), topicLabelText(group));
                const options = node('div', 'bp-reference-topic-options'); options.hidden = !open;
                toggle.addEventListener('click', () => {
                    const next = !expanded.has(group.categoryID);
                    if (next) expanded.add(group.categoryID); else expanded.delete(group.categoryID);
                    toggle.setAttribute('aria-expanded', String(next));
                    void setVisible(options, next, { collapse: true });
                });
                toggle.dataset.topicId = String(group.categoryID); host.append(toggle, options);
                targetHost = options;
            }
            for (const target of group.targets) {
                const row = node('div', 'bp-reference-option'); row.dataset.contextId = target.contextID;
                const copy = node('div', 'bp-reference-option-copy');
                const link = node('a', 'bp-reference-result-name');
                link.href = sceneURL(target.url); link.setAttribute('aria-label', referenceLabel(target));
                renderTopicLabel(link, topicLabelText(target)); copy.append(link);
                if (target.description) copy.append(node('small', '', target.description));
                row.append(copy);
                if (canAdd()) {
                    const added = getEntries().some(entry => Number(entry.conditionID) === -target.contextID);
                    const unavailable = topicReferenceUnavailable(target, getCurrentContextID(), isPrivate());
                    const add = createAction({ label: added ? 'Added' : 'Add', icon: added ? 'fa-solid fa-check' : 'fa-solid fa-plus', variant: 'quiet' });
                    add.disabled = Boolean(added || unavailable || adding);
                    if (unavailable) { row.dataset.tooltip = unavailable; row.tabIndex = 0; }
                    add.addEventListener('click', async () => {
                        if (adding || scope !== getScope()) return;
                        const requestedScope = scope; adding = true; actionError = ''; onChange();
                        try {
                            const applied = await onAdd({ ...target, name: referenceLabel(target), ID: -target.contextID,
                                conditionID: -target.contextID, referenceContextID: target.contextID, type: 'topic' });
                            if (!applied && getScope() === requestedScope) actionError = 'Could not add this reference. Check your current weights.';
                        } catch {
                            if (getScope() === requestedScope) actionError = 'Could not add this reference. Please try again.';
                        } finally { adding = false; if (getScope() === requestedScope) onChange(); }
                    });
                    row.append(add);
                }
                targetHost.append(row);
            }
        }
    }
    return { render };
}
