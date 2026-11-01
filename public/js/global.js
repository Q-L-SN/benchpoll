import { PageHeader } from './shared/page-header.js';
import './shared/help-popover.js?v=help-popovers-20261008';
import * as S from '/js/shared.js';
import { enhanceUI, observeCustomSelects, handleCustomSelectKeydown } from './shared/ui-components.js?v=custom-select-20261013';
import { openSignIn, installSignInLinks, listenAccountChange } from './shared/sign-in.js';
import { installLegalAcceptance } from './shared/legal-acceptance.js';

export const params = new URLSearchParams(location.search);

export function editURL(newURL, pushInHistory, withRequest) {
    switch (true) {
    case withRequest && pushInHistory:
        window.location.href = newURL;
        break;
    case withRequest && !pushInHistory:
        window.location.replace(newURL);
        break;
    case !withRequest && pushInHistory:
        window.history.pushState(null, '', newURL);
        break;
    case !withRequest && !pushInHistory:
        window.history.replaceState(null, '', newURL);
        break;
    }
}

export function openCenterPopup(url, title, width, height) {  // 居中显示window
    // 1. 获取当前窗口坐标
    const windowLeft = window.screenLeft !== undefined ? window.screenLeft : window.screenX;
    const windowTop = window.screenTop !== undefined ? window.screenTop : window.screenY;
    // 2. 获取当前窗口可见宽高
    const windowWidth = window.innerWidth || document.documentElement.clientWidth || window.screen.width;
    const windowHeight = window.innerHeight || document.documentElement.clientHeight || window.screen.height;
    // 3. 计算居中坐标
    const left = windowLeft + (windowWidth - width) / 2;
    const top = windowTop + (windowHeight - height) / 2;
    // 4. 拼接配置字符串
    const windowFeatures = 'width=' + width + ',height=' + height + ',top=' + top + ',left=' + left;
    // 5. 打开窗口
    const popup = window.open(url, title, windowFeatures);
    if (popup && window.focus) {
        popup.focus();
    }
    return popup;
}

export function loginWithGitHub() {
    openSignIn();
}
installSignInLinks();

export function listenStorageChange(key, callback) {
    if (key === 'user-profile-update') return listenAccountChange(callback);
    window.addEventListener('storage', function(event) { // 同域“公共频道”
        if (event.key === key) {
            let newValue;
            if (event.newValue === null) {
                newValue = null;
            } else {
                newValue = JSON.parse(event.newValue); // storage事件只能传递字符串
            }
            callback(newValue);
        }
    });
}

function gotoErrorPage(side, errorCode = null) {
    switch (side) {
    case 'client':
        window.history.replaceState({
            ...(window.history.state || {}),
            doNotReload: true,
        }, '') // 第三个参数省略，表示不修改显示的URL
        editURL('/dialogPage?dialogCode=6&side=client', true, true);
        break;
    case 'server':
        editURL('/dialogPage?dialogCode=6&side=server&errorCode=' + errorCode, false, true);
        break;
    }
}
export async function checkErrorCodeInURL(response) {
    if (response.status === 204) {
        return; // No Content，表示成功但没有数据返回
    }
    if (response.status === 401) {
        editURL('/dialogPage?dialogCode=2&displayURL=' + encodeURIComponent(window.location.href), false, true);
        S.breakInThen();
    }
    if (response.status === 429) {
        editURL('/dialogPage?dialogCode=5&displayURL=' + encodeURIComponent(window.location.href), false, true);
        S.breakInThen();
    }
    if (!response.ok) {
        gotoErrorPage('server', response.status);
        S.breakInThen();
    }
    return response.json();
}

// 副作用代码，即使不显式export，只要有人import就会执行
window.addEventListener('error', function(event) { // 同步错误捕获
    if (event.target !== window) {
        return; // 资源加载失败不应该当成客户端脚本错误跳转
    }
    if (location.pathname.toLowerCase() === '/dialogpage') {
        return;
    }
    gotoErrorPage('client', event);
}, true); // 捕获阶段监听，也能捕获到资源加载错误
window.addEventListener('unhandledrejection', function(event) { // 异步错误捕获
    if (event.reason?.payload?.error === 'legal_acceptance_required') {
        event.preventDefault(); // The inline notice handles this gate without discarding the current draft.
        return;
    }
    if (event.reason === 'ImNotAnError') {
        event.preventDefault(); // 这是一个正常的流程，不需要被视为错误
        return;
    }
    if (location.pathname.toLowerCase() === '/dialogpage') {
        return;
    }
    gotoErrorPage('client', event);
});

let canReloadOnPopstate = false;
let historyNavigationHandler = null;
let historyDocumentURL = window.location.pathname + window.location.search;
export function setHistoryNavigationHandler(handler) {
    if (typeof handler !== 'function' || historyNavigationHandler) {
        throw new TypeError('A page must register exactly one history navigation handler.');
    }
    historyNavigationHandler = handler;
}
setTimeout(() => {
    canReloadOnPopstate = true;
    historyDocumentURL = window.location.pathname + window.location.search;
}, 1000);
window.addEventListener('popstate', function(event) {
    const currentDocumentURL = window.location.pathname + window.location.search;
    const sameDocument = currentDocumentURL === historyDocumentURL;
    historyDocumentURL = currentDocumentURL;
    // In-page anchors and their Back entries must preserve form drafts and dialogs.
    if (sameDocument && !historyNavigationHandler) return;
    if (event.state?.doNotReload) {
        delete event.state.doNotReload;
        window.history.replaceState(event.state, '');
    } else if (historyNavigationHandler) {
        void historyNavigationHandler(event);
    } else if (!canReloadOnPopstate) {
        return; // Safari等移动浏览器可能在初次加载时触发popstate
    } else {
        window.location.reload(); // 这之后执行的任何代码都无效
    }
});



const openDialogs = [];
document.addEventListener('keydown', event => {
    if (handleCustomSelectKeydown(event)) return;
    const dialog = openDialogs.at(-1);
    if (!dialog || !['Escape', 'Tab'].includes(event.key)) return;
    if (document.body.classList.contains('dialog-page') && (event.key === 'Tab'
        || event.composedPath().some(node => node instanceof PageHeader || node instanceof globalThis.HTMLDialogElement && node.open))) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
        event.preventDefault();
        dialog.requestClose();
        return;
    }
    const controls = dialog.focusableControls();
    event.preventDefault();
    if (!controls.length) { dialog.focusInitialAction(); return; }
    const current = controls.indexOf(document.activeElement);
    const next = current < 0 ? event.shiftKey ? controls.length - 1 : 0
        : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    controls[next].focus({ preventScroll: true });
}, true);

class globalDialog extends HTMLElement { // 定义全局对话框组件
    static get observedAttributes() {
        return ['hidden'];
    }

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        const template = document.createElement('template');
        template.innerHTML = `
            <style>
                :host {
                    position: fixed;
                    inset: 0;
                    display: block;
                    z-index: calc(var(--dialog-z-index) + var(--dialog-stack-index, 0));
                    pointer-events: none;
                }
                :host([hidden]) {
                    display: none;
                }
                .dialog-root {
                    width: 100%;
                    height: 100%;
                    position: relative;
                }
                .dialog-overlay {
                    position: absolute;
                    inset: 0;
                    display: var(--dialog-overlay-display);
                    background: var(--dialog-overlay-background);
                    backdrop-filter: var(--dialog-overlay-backdrop-filter);
                    pointer-events: auto;
                    animation: dialog-overlay-in 180ms ease-out both;
                }
                .dialog-stage {
                    position: absolute;
                    inset: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 24px;
                    pointer-events: none;
                }
                .dialog-content {
                    box-sizing: border-box;
                    width: fit-content;
                    min-width: min(var(--dialog-min-width, 240px), calc(100vw - 48px));
                    max-width: min(var(--dialog-width), calc(100vw - 48px));
                    max-height: min(100%, calc(100vh - 48px));
                    display: flex;
                    flex-direction: column;
                    gap: var(--dialog-gap);
                    padding: var(--dialog-padding);
                    background: var(--dialog-background);
                    border: 1px solid var(--dialog-border-color);
                    border-radius: var(--dialog-radius);
                    box-shadow:
                        var(--dialog-shadow),
                        inset 0 1px rgba(255, 255, 255, 0.92);
                    color: var(--text-primary);
                    pointer-events: auto;
                    overflow: auto;
                    animation: dialog-content-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
                }
                .dialog-title {
                    display: flex;
                    align-items: center;
                    justify-content: flex-start;
                    min-height: 24px;
                    text-align: left;
                    color: var(--dialog-title-color);
                    font-size: var(--dialog-title-size);
                    font-family: var(--font-display);
                    font-weight: 700;
                    letter-spacing: 0;
                }
                .dialog-body {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    color: var(--dialog-text-color);
                    font-size: var(--dialog-text-size);
                    line-height: 1.6;
                }
                .dialog-actions {
                    display: flex;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 12px;
                    flex-wrap: wrap;
                }
                ::slotted([slot="title"]) {
                    margin: 0;
                    color: inherit;
                    font: inherit;
                    text-align: left;
                }
                ::slotted([slot="content"]) {
                    color: inherit;
                }
                ::slotted([slot="actions"]) {
                    display: flex;
                    flex: 0 0 auto;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 10px;
                    flex-wrap: wrap;
                }
                @keyframes dialog-overlay-in {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes dialog-content-in {
                    from {
                        opacity: 0;
                        transform: translateY(8px) scale(0.985);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0) scale(1);
                    }
                }
                @media (max-width: 640px) {
                    .dialog-stage {
                        padding: 16px;
                    }
                    .dialog-content {
                        width: fit-content;
                        min-width: min(var(--dialog-min-width, 220px), calc(100vw - 32px));
                        max-width: min(var(--dialog-width), calc(100vw - 32px));
                        max-height: calc(100vh - 32px);
                        padding: 16px;
                    }
                    .dialog-actions {
                        gap: 8px;
                    }
                }
                @media (max-width: 420px) {
                    .dialog-content {
                        width: calc(100vw - 32px);
                    }
                    .dialog-actions {
                        align-items: stretch;
                    }
                    ::slotted([slot="actions"]) {
                        width: 100%;
                        align-items: stretch;
                        flex-direction: column-reverse;
                    }
                }
                @media (prefers-reduced-motion: reduce) {
                    .dialog-overlay,
                    .dialog-content {
                        animation: none;
                    }
                }
            </style>
            <div class="dialog-root" part="root">
                <div class="dialog-overlay" part="overlay"></div>
                <div class="dialog-stage" part="stage">
                    <div class="dialog-content" part="content" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1">
                        <div id="dialog-title" class="dialog-title" part="title">
                            <slot name="title"></slot>
                        </div>
                        <div class="dialog-body" part="body">
                            <slot name="body"></slot>
                        </div>
                        <div class="dialog-actions" part="actions">
                            <slot name="actions"></slot>
                        </div>
                    </div>
                </div>
            </div>
        `;
        shadow.appendChild(template.content.cloneNode(true));
    }

    connectedCallback() {
        this.syncDialogState();
    }

    disconnectedCallback() {
        this.syncDialogState();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'hidden' && oldValue !== newValue) this.syncDialogState();
    }

    syncDialogState() {
        const index = openDialogs.indexOf(this);
        if (!this.hidden && this.isConnected && index < 0) {
            this.returnFocus = document.activeElement;
            openDialogs.push(this);
            this.focusInitialAction();
        } else if ((this.hidden || !this.isConnected) && index >= 0) {
            const wasTopmost = openDialogs.at(-1) === this;
            openDialogs.splice(index, 1);
            for (const dialog of openDialogs) {
                if (this.contains(dialog.returnFocus)) dialog.returnFocus = this.returnFocus;
            }
            if (wasTopmost) {
                const next = openDialogs.at(-1), target = this.returnFocus;
                requestAnimationFrame(() => {
                    if (openDialogs.at(-1) !== next) return;
                    if (target?.isConnected && target.getClientRects().length
                        && !target.closest('[hidden], [inert]') && !target.hasAttribute('disabled')
                        && (!next || next.contains(target))) target.focus({ preventScroll: true });
                    else next?.focusInitialAction();
                });
            }
        }
        openDialogs.forEach((dialog, order) => dialog.style.setProperty('--dialog-stack-index', order));
    }

    focusableControls() {
        return [...this.querySelectorAll('global-dialog-action:not([disabled]), button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')]
            .filter(control => control.getClientRects().length && (control.tabIndex >= 0 || control.matches('global-dialog-action'))
                && !control.closest('[hidden], [inert]'));
    }

    requestClose() {
        const event = new CustomEvent('dialog-cancel', { cancelable: true });
        if (!this.dispatchEvent(event)) return;
        this.focusableControls().find(control => control.classList.contains('dialog-close-button'))?.click();
    }

    focusInitialAction() {
        requestAnimationFrame(() => {
            if (openDialogs.at(-1) !== this || this.hidden || !this.isConnected) return;
            const controls = this.focusableControls();
            const preferredAction = controls.find(action => action.classList.contains('main')) ?? controls[0];
            (preferredAction ?? this.shadowRoot.querySelector('.dialog-content')).focus({ preventScroll: true });
        });
    }
}

class globalDialogAction extends HTMLElement { // 定义全局对话框操作按钮组件
    static get observedAttributes() {
        return ['disabled'];
    }

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        const template = document.createElement('template');
        template.innerHTML = `
            <style>
                :host {
                    --button-color: var(--bp-text, #39414e);
                    --button-background: #ffffff;
                    --button-border-color: var(--bp-line, #e3e6ec);
                    --button-hover-background: var(--bp-hover, #f5f6f9);
                    --button-hover-color: var(--bp-ink, #242c37);
                    --button-hover-border-color: var(--bp-line-strong, #cfd4de);
                    display: inline-flex;
                }
                :host([accent]) {
                    --button-color: var(--bp-purple, #b84400);
                    --button-background: var(--bp-purple-soft, #fff0e5);
                    --button-border-color: var(--bp-line-strong, #cfd4de);
                    --button-hover-background: var(--bp-selected, #fff2e8);
                    --button-hover-color: var(--bp-purple-dark, #993800);
                    --button-hover-border-color: var(--bp-purple, #b84400);
                }
                :host([danger]) {
                    --button-color: #b34e57;
                    --button-background: #fff1f2;
                    --button-border-color: #eed0d3;
                    --button-hover-background: #ffe8ea;
                    --button-hover-color: #a13f48;
                    --button-hover-border-color: #e3b8bc;
                }
                :host([disabled]) {
                    opacity: 0.5;
                    pointer-events: none;
                }
                :host(:focus-visible) { outline: none; }
                @media (max-width: 420px) {
                    :host,
                    #button {
                        width: 100%;
                    }
                }
            </style>
            <link rel="stylesheet" href="/css/ui/components.css?v=custom-select-20261013">
            <button id="button" class="bp-ui-action" part="button" type="button"><slot></slot></button>
        `;
        shadow.appendChild(template.content.cloneNode(true));
        this.syncDisabledState();
    }

    connectedCallback() {
        this.syncDisabledState();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'disabled' && oldValue !== newValue) {
            this.syncDisabledState();
        }
    }

    syncDisabledState() {
        const button = this.shadowRoot?.getElementById('button');
        if (!button) {
            return;
        }
        button.disabled = this.hasAttribute('disabled');
    }

    focus(options) {
        this.shadowRoot?.getElementById('button')?.focus(options);
    }
}

export function showDialog({
    title,
    message = '',
    confirmLabel = 'OK',
    cancelLabel = null,
    tone = 'default'
}) {
    return new Promise(resolve => {
        const dialog = document.createElement('global-dialog');
        dialog.className = 'global-system-dialog';
        dialog.hidden = true;

        const titleElement = document.createElement('div');
        titleElement.slot = 'title';
        titleElement.textContent = title;

        const bodyElement = document.createElement('div');
        bodyElement.slot = 'body';
        bodyElement.textContent = message;

        const actionsElement = document.createElement('div');
        actionsElement.slot = 'actions';

        let settled = false;
        const finish = value => {
            if (settled) {
                return;
            }
            settled = true;
            dialog.removeEventListener('dialog-cancel', handleCancel);
            dialog.remove();
            resolve(value);
        };
        const handleCancel = event => {
            event.preventDefault();
            finish(false);
        };

        if (cancelLabel) {
            const cancelAction = document.createElement('global-dialog-action');
            cancelAction.textContent = cancelLabel;
            cancelAction.addEventListener('click', () => finish(false));
            actionsElement.append(cancelAction);
        }

        const confirmAction = document.createElement('global-dialog-action');
        confirmAction.className = tone === 'danger' ? 'danger' : 'main';
        confirmAction.textContent = confirmLabel;
        confirmAction.addEventListener('click', () => finish(true));
        actionsElement.append(confirmAction);

        dialog.append(titleElement, bodyElement, actionsElement);
        document.body.append(dialog);
        dialog.addEventListener('dialog-cancel', handleCancel);
        requestAnimationFrame(() => {
            dialog.hidden = false;
        });
    });
}

export function showAlert(message, options = {}) {
    return showDialog({
        title: options.title ?? 'BenchPoll',
        message,
        confirmLabel: options.confirmLabel ?? 'OK',
        tone: options.tone ?? 'default'
    });
}

export function showConfirm(message, options = {}) {
    return showDialog({
        title: options.title ?? 'Confirm action',
        message,
        confirmLabel: options.confirmLabel ?? 'Confirm',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        tone: options.tone ?? 'default'
    });
}

customElements.define('global-header', PageHeader);
customElements.define('global-dialog', globalDialog);
customElements.define('global-dialog-action', globalDialogAction);
enhanceUI();
observeCustomSelects();
installLegalAcceptance();
