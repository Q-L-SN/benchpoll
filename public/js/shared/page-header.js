import { mountSiteActions } from './site-header.js';

export class PageHeader extends HTMLElement {
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
            <link rel="stylesheet" href="/css/ui/site-header.css">
            <style>
                :host { position: fixed; inset: 0 0 auto; z-index: 1100; display: block; }
                .bp-site-header { position: static; }
            </style>
            <header class="bp-site-header"><div class="bp-site-header-inner">
                <a class="bp-site-brand" href="/" aria-label="BenchPoll home"><img src="/assets/benchpoll-logo.svg" alt="BenchPoll" width="155" height="32"></a>
                <nav></nav>
            </div></header>`;
        mountSiteActions(shadow.querySelector('nav'), { manageAccount: true });
    }

    connectedCallback() {
        const menu = this.shadowRoot.querySelector('.th-more nav');
        for (const action of [...this.children]) menu.append(action);
    }
}
