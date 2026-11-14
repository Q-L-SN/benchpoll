import { createTopicCreator } from './topic-identity.js';
import { createFavoriteButton, createConfiguredIndicator } from './topic-actions.js';

// A compact topic card for profile collections; all card state/actions use the
// same controls as the homepage and workspace topic headers.
export function createTopicCard(topic, { onError = () => {}, onFavoriteChange = () => {} } = {}) {
    const card = document.createElement('article'); card.className = 'bp-profile-topic-card';
    const heading = document.createElement('h2');
    const link = document.createElement('a'); link.textContent = topic.name;
    if (typeof topic.url === 'string' && /^\/(?!\/)[^\\\s]*$/.test(topic.url)) link.href = topic.url;
    heading.append(link, createConfiguredIndicator(topic));
    if (topic.isPrivate) {
        const lock = document.createElement('span'); lock.className = 'pf-private-note';
        lock.setAttribute('role', 'img'); lock.setAttribute('aria-label', 'Private topic');
        const icon = document.createElement('i'); icon.className = 'fa-solid fa-lock'; icon.setAttribute('aria-hidden', 'true');
        lock.append(icon); heading.append(lock);
    }
    const description = document.createElement('p'); description.textContent = topic.description || '';
    const footer = document.createElement('footer');
    const creator = createTopicCreator(topic.isOfficial ? { isOfficial: true } : topic.creator);
    const attribution = document.createElement('div'); attribution.className = 'bp-profile-topic-attribution';
    attribution.append(creator);
    const favorite = createFavoriteButton(topic, { onChange: onFavoriteChange, onError });
    footer.append(attribution, favorite); card.append(heading, description, footer);
    card.dispose = () => favorite.dispose?.();
    return card;
}
