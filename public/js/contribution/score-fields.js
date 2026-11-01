import { fieldNameKey } from '../shared/score-fields.js';
import { pinnedScoreFields, runFieldIcon } from '../shared/score-field-presets.js';
import { enhanceUI } from '../shared/ui-components.js';

const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
};
const fixedFields = fields => pinnedScoreFields(fields.filter(field => !field.pending
    && ['effort', 'harness'].includes(fieldNameKey(field.name))));
const approvedOptions = field => field.options.filter(option => !option.pending
    && Number.isSafeInteger(option.ID) && option.ID > 0);

export function contributionScoreFields(assignments, fields) {
    const allowed = new Set(fixedFields(fields).map(field => field.ID));
    return structuredClone(assignments.filter(assignment => allowed.has(assignment.fieldID)));
}

export function mountScoreFields(host, { assignments, getFields, refresh, onChange }) {
    const list = element('div', undefined, 'score-fields-list');
    const status = element('p', '', 'score-field-error');
    status.setAttribute('role', 'status');
    host.replaceChildren(element('h3', 'Score fields'), list, status);
    let refreshID = 0;
    const controls = new Map();
    const isMounted = () => list.isConnected && host.contains(list);

    function renderValue(field, select) {
        const assignment = assignments.find(assignment => assignment.fieldID === field.ID);
        select.replaceChildren(new window.Option('Not recorded', ''));
        if (field.allowEmpty) select.add(new window.Option('Empty', '__empty__'));
        for (const option of approvedOptions(field)) select.add(new window.Option(option.label, String(option.ID)));
        const token = !assignment ? '' : assignment.value === null ? '__empty__' : String(assignment.value);
        select.value = token;
        const unavailable = Boolean(assignment) && select.selectedIndex < 0;
        if (unavailable) {
            const option = new window.Option('Value unavailable', token);
            option.disabled = true;
            select.add(option);
            select.value = token;
        }
        select.setCustomValidity(unavailable ? 'Choose an approved value or Not recorded.' : '');
    }

    function renderRows() {
        const fields = fixedFields(getFields());
        for (const [fieldID, control] of controls) {
            if (!fields.some(field => field.ID === fieldID)) {
                control.row.remove();
                controls.delete(fieldID);
            }
        }
        for (const [index, field] of fields.entries()) {
            let control = controls.get(field.ID);
            if (!control) {
                const row = element('div', undefined, 'score-field-row is-pinned');
                const label = element('span', field.name);
                const icon = element('i');
                icon.className = `fa-solid ${runFieldIcon(field)}`;
                icon.setAttribute('aria-hidden', 'true');
                label.prepend(icon);
                const valueHost = element('div', undefined, 'score-field-value');
                const select = element('select');
                select.setAttribute('aria-label', `${field.name} value`);
                valueHost.append(select);
                row.append(label, valueHost);
                select.addEventListener('focus', () => { void refreshChoices(select); });
                select.addEventListener('change', () => {
                    const latest = fixedFields(getFields()).find(item => item.ID === field.ID);
                    const option = latest && approvedOptions(latest).find(item => String(item.ID) === select.value);
                    if (!latest || select.value !== '' && !(latest.allowEmpty && select.value === '__empty__') && !option) return;
                    const index = assignments.findIndex(assignment => assignment.fieldID === field.ID);
                    if (select.value === '') {
                        if (index >= 0) assignments.splice(index, 1);
                    } else {
                        const assignment = { fieldID: field.ID, value: option ? option.ID : null };
                        if (index >= 0) assignments.splice(index, 1, assignment);
                        else assignments.push(assignment);
                    }
                    select.setCustomValidity('');
                    status.textContent = '';
                    onChange();
                });
                control = { row, select };
                controls.set(field.ID, control);
            }
            if (list.children[index] !== control.row) list.insertBefore(control.row, list.children[index] ?? null);
            renderValue(field, control.select);
        }
        enhanceUI(host);
    }

    async function refreshChoices(select) {
        const sequence = ++refreshID;
        status.textContent = '';
        const isCurrent = () => sequence === refreshID && isMounted() && select.isConnected && host.contains(select);
        try {
            const applied = await refresh();
            if (applied !== false && isCurrent()) renderRows();
        } catch {
            if (isCurrent()) status.textContent = 'Could not refresh options. Your draft has been kept.';
        }
    }
    renderRows();
}
