import '/js/shared.js';
import * as G from '/js/global.js';
import { noticeNavigationTarget } from './shared/notice-navigation.js';

const serverNotice = document.querySelector('meta[name="benchpoll-page-error"]');
const params = serverNotice ? new URLSearchParams(serverNotice.content) : G.params;
const requestedDialogCode = Number(params.get('dialogCode') || 1);
const dialogCode = Number.isInteger(requestedDialogCode) && requestedDialogCode >= 1 && requestedDialogCode <= 7
    ? requestedDialogCode
    : 1; // 默认为Not Found错误
const side = params.get('side');
const displayURL = noticeNavigationTarget(params.get('displayURL'), location.origin);
const oldURL = noticeNavigationTarget(params.get('oldURL'), location.origin);
const referrerURL = noticeNavigationTarget(document.referrer, location.origin);

if (!serverNotice && (displayURL || referrerURL)) G.editURL(displayURL ?? referrerURL, false, false);

function handleUserProfileUpdate(newValue) {
    if (newValue !== null) {
        G.editURL(displayURL ?? oldURL ?? '/', false, true);
    }
}

G.listenStorageChange('user-profile-update', handleUserProfileUpdate);
G.listenStorageChange('user-profile', handleUserProfileUpdate);

const errorCode = params.get('errorCode'); // side !== 'client'
const errorName = params.get('error');
const upstreamStatus = params.get('upstreamStatus');
const minAge = params.get('minAge'); // dialogCode === 4
const actualAge = params.get('actualAge') // dialogCode === 4
const bannedUntilValue = params.get('bannedUntil');
const bannedUntilDate = bannedUntilValue ? new Date(bannedUntilValue) : null;
const bannedUntil = dialogCode === 7 && bannedUntilDate && Number.isFinite(bannedUntilDate.getTime())
    ? new Intl.DateTimeFormat(navigator.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    }).format(bannedUntilDate)
    : 'the date shown in your suspension notice';

const displayDialog = document.getElementById('code-' + dialogCode + '-dialog')
const closeButton = displayDialog.querySelector('.dialog-close-button');
const dialogTitle = displayDialog.querySelector('[slot="title"]');
const dialogBody = displayDialog.querySelector('[slot="body"]');

switch (dialogCode) {
case 4:
    const p1 = document.createElement('p');
    const p2 = document.createElement('p');
    p1.textContent = 
        'Your GitHub account must be at least ' + minAge + ' days old to sign in.';
    p2.textContent =
        'Your account is ' + actualAge + ' days old. Please try again when it is old enough.';
    dialogBody.appendChild(p1);
    dialogBody.appendChild(p2);
    break;
case 5:
    if (side === 'callback') {
        closeButton.hidden = false;
    }
    break;
case 6:
    switch (side) {
    case 'server':
        dialogTitle.textContent = 'This page could not be loaded';
        dialogBody.textContent = 'Please try again. If it keeps happening, send us feedback and include error code ' + errorCode + '.';
        break;
    case 'callback': {
        const callbackMessages = {
            invalid_oauth_state: 'The sign-in session expired or could not be verified. Please start sign-in again.',
            github_token_exchange_timeout: 'GitHub did not respond while BenchPoll was completing sign-in.',
            github_token_exchange_unavailable: 'BenchPoll could not reach GitHub\'s sign-in service.',
            github_token_exchange_failed: 'GitHub could not complete sign-in. Please try signing in again.',
            github_token_response_invalid: 'We could not confirm your GitHub sign-in. Please try again.',
            github_authorization_failed: 'GitHub could not authorize this sign-in.',
            github_profile_timeout: 'GitHub did not respond while BenchPoll was loading your profile.',
            github_profile_unavailable: 'BenchPoll could not reach GitHub\'s profile service.',
            github_profile_failed: 'GitHub rejected the profile request.',
            github_profile_response_invalid: 'We could not read your GitHub profile. Please try signing in again.',
            github_profile_invalid: 'Your GitHub profile is missing required information. Please try signing in again.',
            github_email_timeout: 'GitHub did not respond while BenchPoll was checking your verified email.',
            github_email_unavailable: 'BenchPoll could not reach GitHub\'s email service.',
            github_email_permission_required: 'BenchPoll could not read a verified email from GitHub. Check the app email permission and try again.',
            github_email_failed: 'GitHub rejected the verified-email request.',
            github_email_response_invalid: 'We could not read your GitHub email address. Please try signing in again.',
            github_verified_email_required: 'A verified email address is required on your GitHub account.'
        };
        dialogTitle.textContent = 'Couldn\'t complete GitHub sign-in';
        const message = document.createElement('p');
        message.textContent = callbackMessages[errorName]
            ?? 'BenchPoll could not complete the GitHub sign-in request.';
        dialogBody.appendChild(message);
        if (errorName) {
            const diagnostic = document.createElement('p');
            diagnostic.textContent = `Diagnostic code: ${errorName}`
                + (upstreamStatus ? ` (GitHub ${upstreamStatus})` : '');
            dialogBody.appendChild(diagnostic);
        }
        break;
    }
    case 'client':
        dialogTitle.textContent = 'The page stopped working';
        dialogBody.textContent = 'Reload the page to try again. If the problem continues, send us feedback.';
        break;
    }
    break;
case 7:
    const p3 = document.createElement('p');
    const p4 = document.createElement('p');
    const a = document.createElement('a');
    p3.textContent =
        'Your account is suspended until ' + bannedUntil + '. You cannot sign in during this time.';
    p4.textContent =
        'Think this is a mistake? ';
    a.href = '/privacy#operator';
    a.textContent = 'Contact us to appeal';
    dialogBody.appendChild(p3);
    p4.appendChild(a);
    dialogBody.appendChild(p4);
    break;
}

(() => {
    if (side !== 'callback' && closeButton) { //防御性编程，虽然目前side === 'client'是不需要隐藏的
        switch (dialogCode) {
        case 2:
        case 3:
            return;
        case 6:
            if (window.history.length > 1) {
                return;
            }
            break;
        }
        closeButton.hidden = true;
    }
})();
closeButton.addEventListener('click', function(event) {
    if (side === 'callback') {
        return window.close();
    }
    switch (dialogCode) {
    case 1:
        G.editURL('/', false, true);
        break;
    case 2:
    case 3:
        G.editURL(oldURL ?? '/', false, true);
        break;
    case 6:
        window.history.back();
        break;
    }
});

document.querySelector('#code-2-dialog .dialog-login-button').addEventListener('click', function() {
    G.loginWithGitHub();
});

displayDialog.hidden = false; // 显示对应的对话框
document.title = `${dialogTitle.textContent || 'Notice'} - BenchPoll`;
