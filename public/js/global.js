import * as S from '/js/shared.js';

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

export const SUPPORT_EMAIL_ADDRESS = 'support@yourdomain.com' // 示例邮箱
export const APPEAL_EMAIL_SUBJECT = 'Appeal for Suspended Account';

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
    openCenterPopup('/github_login', 'Login with GitHub', 600, 700);
}

export function listenStorageChange(key, callback) {
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
setTimeout(() => {
    canReloadOnPopstate = true;
}, 1000);
window.addEventListener('popstate', function(event) {
    if (event.state?.doNotReload) {
        delete event.state.doNotReload;
        window.history.replaceState(event.state, '');
    } else if (!canReloadOnPopstate) {
        return; // Safari等移动浏览器可能在初次加载时触发popstate
    } else {
        window.location.reload(); // 这之后执行的任何代码都无效
    }
});

class globalHeader extends HTMLElement { // 定义全局导航栏组件
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        const template = document.createElement('template');
        template.innerHTML = `
            <style>
                :host {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    max-width: 100%;
                    height: var(--nav-height);
                    background-color: rgba(255, 255, 255, 0.94);
                    backdrop-filter: blur(18px) saturate(1.04);
                    border-bottom: 1px solid #e7e9f1;
                    display: flex;
                    justify-content: flex-start;
                    align-items: center;
                    gap: 22px;
                    padding: 0 clamp(18px, 2.6vw, 40px) !important;
                    box-shadow: 0 1px 2px rgba(21, 31, 67, 0.035), inset 0 -1px rgba(255, 255, 255, 0.9);
                    z-index: 1100;
                }
                #logo-container {
                    flex: 0 0 auto;
                    min-width: 0;
                    display: flex;
                    align-items: center;
                    justify-content: flex-start;
                }
                .header-slot {
                    flex: 1 1 auto;
                    min-width: 0;
                    display: flex;
                    align-items: center;
                    justify-content: flex-end;
                }
                .logo {
                    display: inline-flex;
                    align-items: center;
                    color: #111a3d;
                    text-decoration: none;
                    cursor: pointer;
                }
                .logo-art {
                    position: relative;
                    display: block;
                    width: 145px;
                    height: 29px;
                    flex: 0 0 145px;
                    overflow: hidden;
                }
                .logo-art img {
                    position: absolute;
                    top: -30.8px;
                    left: -22.5px;
                    display: block;
                    width: 182px;
                    max-width: none;
                    height: auto;
                    filter: contrast(1.04);
                }
                .logo-mark {
                    position: relative;
                    display: block;
                    width: 28px;
                    height: 28px;
                    flex: 0 0 28px;
                    overflow: hidden;
                    border-radius: 50%;
                    background: conic-gradient(from -90deg, #7059e9 0 24%, #69a8ea 24% 50%, #72d0cd 50% 75%, #5e8bdc 75% 100%);
                    box-shadow: inset 0 0 0 1px rgba(38, 45, 91, 0.05), 0 2px 5px rgba(58, 73, 119, 0.08);
                }
                .logo-mark::before,
                .logo-mark::after,
                .logo-mark > span {
                    position: absolute;
                    z-index: 2;
                    display: block;
                    content: "";
                    background: #fff;
                }
                .logo-mark::before {
                    top: -2px;
                    left: 12px;
                    width: 3px;
                    height: 18px;
                }
                .logo-mark::after {
                    top: 12px;
                    right: -2px;
                    width: 18px;
                    height: 3px;
                }
                .logo-mark > span {
                    top: 7px;
                    left: 12px;
                    width: 12px;
                    height: 12px;
                    border-bottom: 3px solid #fff;
                    border-left: 3px solid #fff;
                    border-radius: 0 100% 0 0;
                    background: transparent;
                }
                .brand-copy {
                    display: flex;
                    min-width: 0;
                    flex-direction: column;
                    gap: 2px;
                }
                .brand-name {
                    color: #111a3d;
                    font-family: var(--font-sans);
                    font-size: 18px;
                    font-weight: 740;
                    line-height: 1;
                }
                .logo .highlight {
                    color: inherit;
                }
                .brand-index {
                    color: #8188a1;
                    font-family: var(--font-sans);
                    font-size: 8px;
                    font-weight: 650;
                    line-height: 1.2;
                }
                slot { /* 插槽 */
                    display: flex;
                    width: 100%;
                    min-width: 0;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 12px;
                }
                @media (max-width: 640px) {
                    :host {
                        gap: 12px;
                        padding-inline: 14px !important;
                    }
                    slot {
                        gap: 8px;
                    }
                }
            </style>
            <div id="logo-container">
                <a href="/" class="logo" aria-label="BenchPoll home">
                    <span class="logo-art" aria-hidden="true">
                        <img src="/assets/logo-archive/benchpoll-logo-approved-g-transparent.png" alt="" width="1774" height="887">
                    </span>
                </a>
            </div>
            <div class="header-slot">
                <slot></slot>
            </div>
        `;
        shadow.appendChild(template.content.cloneNode(true));
    }
}

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
                    z-index: var(--dialog-z-index);
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
                    <div class="dialog-content" part="content" role="dialog" aria-modal="true">
                        <div class="dialog-title" part="title">
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
        if (!this.hidden) {
            this.focusInitialAction();
        }
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'hidden' && oldValue !== newValue && !this.hidden) {
            this.focusInitialAction();
        }
    }

    focusInitialAction() {
        requestAnimationFrame(() => {
            const actions = [...this.querySelectorAll('global-dialog-action')]
                .filter(action => !action.hidden && !action.hasAttribute('disabled'));
            const preferredAction = actions.find(action => action.classList.contains('main')) ?? actions[0];
            preferredAction?.focus();
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
                    --button-color: #263153;
                    --button-background: #ffffff;
                    --button-border-color: #dfe2ec;
                    --button-hover-background: #f7f7fc;
                    --button-hover-color: #111a3d;
                    --button-hover-border-color: #c9cde0;
                    display: inline-flex;
                }
                :host([accent]) {
                    --button-color: #5949ce;
                    --button-background: #f3f1ff;
                    --button-border-color: #dcd7fa;
                    --button-hover-background: #ebe7ff;
                    --button-hover-color: #4c3dc2;
                    --button-hover-border-color: #c9c1f5;
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
                #button {
                    min-height: var(--dialog-button-height);
                    padding: 0 var(--dialog-button-padding-inline);
                    border: 1px solid var(--button-border-color);
                    border-radius: 8px;
                    background-color: var(--button-background);
                    color: var(--button-color);
                    font-family: var(--font-sans);
                    font-size: 13px;
                    font-weight: 650;
                    line-height: 1;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    cursor: pointer;
                    user-select: none;
                    box-shadow: inset 0 1px rgba(255, 255, 255, 0.92), 0 2px 5px rgba(25, 32, 64, 0.055);
                    transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease, box-shadow 180ms ease;
                }
                #button:disabled {
                    cursor: default;
                }
                #button:hover {
                    background-color: var(--button-hover-background);
                    color: var(--button-hover-color);
                    border-color: var(--button-hover-border-color);
                    box-shadow: inset 0 1px rgba(255, 255, 255, 0.94), 0 5px 12px rgba(35, 41, 77, 0.08);
                }
                #button:active:not(:disabled) {
                    box-shadow: inset 0 1px 3px rgba(35, 41, 77, 0.1);
                }
                #button:focus-visible {
                    outline: none;
                    border-color: #7b6cee;
                    box-shadow: 0 0 0 3px rgba(109, 92, 231, 0.16);
                }
                @media (max-width: 420px) {
                    :host,
                    #button {
                        width: 100%;
                    }
                }
            </style>
            <button id="button" part="button" type="button"><slot></slot></button>
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
        const previousFocus = document.activeElement;
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
            document.removeEventListener('keydown', handleKeydown);
            dialog.remove();
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
                previousFocus.focus();
            }
            resolve(value);
        };
        const handleKeydown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                finish(false);
            }
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
        document.addEventListener('keydown', handleKeydown);
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

customElements.define('global-header', globalHeader);
customElements.define('global-dialog', globalDialog);
customElements.define('global-dialog-action', globalDialogAction);
