// Shared shell for pages that use the global-header custom element.
export class PageHeader extends HTMLElement {
    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { position: fixed; inset: 0 0 auto; display: flex; align-items: center; gap: 22px; height: var(--nav-height, 68px); padding: 0 clamp(16px, 2.6vw, 40px); box-sizing: border-box; background: #edf1eb; border-bottom: 1px solid #dfe5df; z-index: 1100; }
                a { display: flex; align-items: center; gap: 10px; color: #172d28; font: 730 23px "Segoe UI", Arial, sans-serif; letter-spacing: -.8px; text-decoration: none; white-space: nowrap; }
                .brand { display: block; width: 155px; height: auto; }
                .actions { margin-left: auto; min-width: 0; }
                slot { display: flex; align-items: center; justify-content: end; flex-wrap: wrap; gap: 10px; }
                a:focus-visible { outline: 2px solid #246650; outline-offset: 4px; }
                @media (max-width: 600px) { :host { gap: 12px; padding-inline: 14px; } a { font-size: 19px; gap: 7px; } .mark { width: 23px; height: 23px; } slot { gap: 6px; } }
            </style>
            <a href="/" aria-label="BenchPoll home"><img class="brand" src="/assets/benchpoll-logo.svg" alt="BenchPoll" width="155" height="32"></a>
            <div class="actions"><slot></slot></div>`;
    }
}
