import { createTopicCreator } from './topic-identity.js';
import { createFavoriteButton, createConfiguredIndicator } from './topic-actions.js';
import { createTopicEditButton } from './private-topic-editor.js';

// A compact topic card for profile collections; all card state/actions use the
// same controls as the homepage and workspace topic headers.
export function createTopicCard(topic, { onError = () => {}, onFavoriteChange = () => {}, onEdit } = {}) {
    const card = document.createElement('article'); card.className = 'bp-profile-topic-card';
    card.dataset.topicId = String(topic.ID);
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
    const header = document.createElement('header'); header.className = 'pf-topic-card-header';
    header.append(heading);
    if (onEdit) {
        const edit = createTopicEditButton('Edit topic');
        edit.addEventListener('click', () => onEdit(edit));
        header.append(edit);
    }
    footer.append(attribution, favorite); card.append(header, description, footer);
    card.dispose = () => favorite.dispose?.();
    return card;
}
