function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

export function createIdentityAvatar(name, value) {
    const initial = [...String(name || '?')][0].toUpperCase();
    const avatar = node('span', 'bp-identity-avatar', initial);
    avatar.setAttribute('aria-hidden', 'true');
    let src = null;
    if (typeof value === 'string' && value.length <= 300 * 1024) {
        if (/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) src = value;
        else try {
            const url = new URL(value, location.origin);
            if (['http:', 'https:'].includes(url.protocol)) src = url.href;
        } catch { /* Invalid profile images use the initial. */ }
    }
    if (src) {
        const image = document.createElement('img');
        image.src = src; image.alt = ''; image.loading = 'lazy';
        image.addEventListener('error', () => avatar.replaceChildren(document.createTextNode(initial)), { once: true });
        avatar.replaceChildren(image);
    }
    return avatar;
}

export function publicGitHubURL(value) {
    const match = typeof value === 'string' && value.match(/^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)$/);
    return match && !match[1].includes('--') ? value : null;
}

export function createTopicCreator(creator, className = '') {
    const byline = node('span', `bp-topic-byline ${className}`.trim());
    if (!creator?.name) { byline.hidden = true; return byline; }
    const name = creator.name;
    const githubURL = publicGitHubURL(creator.githubURL);
    const identity = node(githubURL ? 'a' : 'span', githubURL ? 'bp-public-github-link' : 'bp-topic-creator-identity');
    if (githubURL) {
        identity.href = githubURL; identity.target = '_blank'; identity.rel = 'noopener noreferrer nofollow';
        identity.referrerPolicy = 'no-referrer';
    }
    identity.append(createIdentityAvatar(name, creator.avatarURL), node('span', 'bp-topic-byline-name', name));
    byline.append(node('span', 'bp-topic-byline-prefix', 'by'), identity);
    byline.dataset.tooltip = `Created by ${name}`;
    return byline;
}
