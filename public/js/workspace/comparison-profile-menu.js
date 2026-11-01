import { comparisonProfileKey } from '../shared/comparison-profile-key.js';
import { setVisible } from '../shared/motion.js';

export function createComparisonProfileMenu({ heading, getComparison, isInvalid, onUse, onSave, onRename, onDelete }) {
    let state = { profiles: [] }, editing = null, busy = false, closeTimer = null;
    const host = document.createElement('div');
    host.className = 'bp-profile-menu';
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'bp-profile-toggle';
    toggle.dataset.tooltip = 'Saved configurations'; toggle.setAttribute('aria-label', toggle.dataset.tooltip);
    toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'comparison-profile-popover');
    toggle.innerHTML = '<i class="fa-regular fa-bookmark" aria-hidden="true"></i>';
    const popover = document.createElement('div');
    popover.id = 'comparison-profile-popover'; popover.className = 'bp-profile-popover'; popover.hidden = true;
    popover.setAttribute('role', 'region'); popover.setAttribute('aria-label', 'Saved configurations');
    const title = document.createElement('strong'); title.textContent = 'Saved configurations';
    const list = document.createElement('div'); list.className = 'bp-profile-list';
    const editor = document.createElement('div'); editor.className = 'bp-comparison-profile-editor'; editor.hidden = true;
    const name = document.createElement('input'); name.type = 'text'; name.maxLength = 80;
    name.placeholder = 'Configuration name'; name.setAttribute('aria-label', name.placeholder);
    const confirm = document.createElement('button'), cancel = document.createElement('button');
    confirm.type = cancel.type = 'button'; confirm.textContent = 'Save'; cancel.textContent = 'Cancel';
    editor.append(name, confirm, cancel);
    const status = document.createElement('p'); status.className = 'bp-comparison-profile-status'; status.setAttribute('role', 'status');
    const save = document.createElement('button'); save.type = 'button'; save.className = 'bp-profile-save';
    save.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i><span>Save current configuration</span>';
    popover.append(title, list, editor, status, save); host.append(toggle);
    document.body.append(popover);
    heading.insertBefore(host, heading.querySelector('#model-comparison-close'));

    const contains = target => host.contains(target) || popover.contains(target);
    function position() {
        if (!isOpen()) return;
        const anchor = toggle.getBoundingClientRect(), bounds = popover.getBoundingClientRect();
        popover.style.left = `${Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12))}px`;
        popover.style.top = `${Math.max(12, Math.min(anchor.bottom + 5, window.innerHeight - bounds.height - 12))}px`;
    }
    function setOpen(open) {
        clearTimeout(closeTimer);
        toggle.setAttribute('aria-expanded', String(open));
        setVisible(popover, open);
        if (open) position();
        if (!open) { editing = null; void setVisible(editor, false, { collapse: true }); status.textContent = ''; }
    }
    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
    toggle.addEventListener('click', () => {
        setOpen(window.matchMedia('(hover: none)').matches ? !isOpen() : true);
    });
    for (const surface of [host, popover]) {
        surface.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch' && window.matchMedia('(hover: hover)').matches) { clearTimeout(closeTimer); if (!isOpen()) setOpen(true); } });
        surface.addEventListener('pointerleave', event => {
            if (event.pointerType !== 'touch' && window.matchMedia('(hover: hover)').matches) closeTimer = setTimeout(() => {
                if (!contains(document.activeElement) && !editing) setOpen(false);
            }, 170);
        });
        surface.addEventListener('focusout', () => { setTimeout(() => {
            if (!contains(document.activeElement) && !host.matches(':hover') && !popover.matches(':hover')) setOpen(false);
        }, 0); });
        surface.addEventListener('keydown', onKeydown);
    }
    document.addEventListener('pointerdown', event => { if (!contains(event.target)) setOpen(false); });
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, { capture: true, passive: true });
    function onKeydown(event) {
        if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); toggle.focus(); }
        if (event.key === 'ArrowDown' && event.target === toggle) { event.preventDefault(); setOpen(true); list.querySelector('button')?.focus(); }
    }
    function showEditor(profile = null) {
        editing = profile?.name ?? '';
        name.value = profile?.name ?? '';
        confirm.textContent = profile ? 'Rename' : 'Save';
        status.textContent = '';
        setVisible(editor, true, { collapse: true });
        position();
        name.focus(); name.select();
    }
    const errorMessage = error => ({
        comparison_profile_duplicate: `Already saved as "${error.payload?.name ?? 'an existing configuration'}".`,
        comparison_profile_name_exists: 'That configuration name is already in use.',
        comparison_profile_not_found: 'That configuration no longer exists.',
        comparison_profile_limit_reached: 'You can save up to 25 configurations.'
    }[error.message] ?? error.message ?? 'Could not save this configuration.');
    function render(next = state) {
        state = next;
        const currentKey = comparisonProfileKey(getComparison());
        const duplicate = state.profiles.find(profile => comparisonProfileKey(profile.comparison) === currentKey);
        list.replaceChildren();
        for (const profile of state.profiles) {
            const row = document.createElement('div'); row.className = 'bp-profile-row';
            const use = document.createElement('button'); use.type = 'button'; use.className = 'bp-profile-use';
            use.textContent = profile.name; use.dataset.tooltip = profile.name;
            use.setAttribute('aria-pressed', String(comparisonProfileKey(profile.comparison) === currentKey));
            use.addEventListener('click', () => { onUse(profile.comparison); setOpen(false); });
            const rename = document.createElement('button'), remove = document.createElement('button');
            rename.type = remove.type = 'button'; rename.className = remove.className = 'bp-profile-action';
            rename.dataset.tooltip = `Rename ${profile.name}`; remove.dataset.tooltip = `Delete ${profile.name}`;
            rename.setAttribute('aria-label', rename.dataset.tooltip); remove.setAttribute('aria-label', remove.dataset.tooltip);
            rename.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i>';
            remove.innerHTML = '<i class="fa-regular fa-trash-can" aria-hidden="true"></i>';
            rename.addEventListener('click', () => showEditor(profile));
            remove.addEventListener('click', async () => {
                busy = true; render();
                try { render(await onDelete(profile.name)); status.textContent = 'Configuration deleted.'; }
                catch (error) { status.textContent = errorMessage(error); }
                finally { busy = false; render(); }
            });
            use.disabled = rename.disabled = remove.disabled = busy;
            row.append(use, rename, remove); list.append(row);
        }
        if (!state.profiles.length) { const empty = document.createElement('p'); empty.textContent = 'No saved configurations.'; list.append(empty); }
        save.disabled = busy || Boolean(duplicate) || Boolean(isInvalid());
        save.querySelector('span').textContent = duplicate ? `Saved as ${duplicate.name}` : 'Save current configuration';
        save.dataset.tooltip = duplicate ? 'This configuration is already saved.' : 'Save current configuration';
        confirm.disabled = cancel.disabled = name.disabled = busy;
        position();
    }
    save.addEventListener('click', () => showEditor());
    cancel.addEventListener('click', () => { editing = null; setVisible(editor, false, { collapse: true }); status.textContent = ''; });
    name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); confirm.click(); } });
    confirm.addEventListener('click', async () => {
        const newName = name.value.trim();
        if (!newName) { status.textContent = 'Enter a configuration name.'; name.focus(); return; }
        if (editing === null || (editing === '' && isInvalid())) return;
        const from = editing;
        busy = true; render();
        try {
            render(from ? await onRename(from, newName) : await onSave(newName, getComparison()));
            editing = null; setVisible(editor, false, { collapse: true });
            status.textContent = from ? 'Configuration renamed.' : 'Configuration saved.';
        } catch (error) { status.textContent = errorMessage(error); }
        finally { busy = false; render(); }
    });
    render();
    return { render, close: () => setOpen(false) };
}
