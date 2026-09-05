import * as S from '/js/shared.js';
import * as G from '/js/global.js';

const requestedDialogCode = Number(G.params.get('dialogCode') || 1);
const dialogCode = Number.isInteger(requestedDialogCode) && requestedDialogCode >= 1 && requestedDialogCode <= 7
    ? requestedDialogCode
    : 1; // 默认为Not Found错误
const side = G.params.get('side');
const displayURL = new URLSearchParams(location.search).get('displayURL');
const oldURL = G.params.get('oldURL'); // dialogCode === 2 || dialogCode === 3

G.editURL(displayURL ?? document.referrer, false, false);

function handleUserProfileUpdate(newValue) {
    if (newValue !== null) {
        G.editURL(displayURL ?? oldURL ?? '/', false, true);
    }
}

G.listenStorageChange('user-profile-update', handleUserProfileUpdate);
G.listenStorageChange('user-profile', handleUserProfileUpdate);

const errorCode = G.params.get('errorCode'); // side !== 'client'
const errorName = G.params.get('error');
const upstreamStatus = G.params.get('upstreamStatus');
const minAge = G.params.get('minAge'); // dialogCode === 4
const actualAge = G.params.get('actualAge') // dialogCode === 4
const bannedUntilValue = G.params.get('bannedUntil');
const bannedUntil = bannedUntilValue
    ? new Intl.DateTimeFormat(navigator.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    }).format(new Date(bannedUntilValue))
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
        'To maintain a secure platform environment, ' +
        'we currently only allow login and registration with GitHub accounts that are at least ' + minAge +
        ' days old.';
    p2.textContent =
        'We detected that your GitHub account is currently ' + actualAge +
        ' days old. Please try again once your account meets this requirement.';
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
        dialogTitle.textContent = 'A server-side error occurred: ' + errorCode;
        break;
    case 'callback': {
        const callbackMessages = {
            invalid_oauth_state: 'The sign-in session expired or could not be verified. Please start sign-in again.',
            github_token_exchange_timeout: 'GitHub did not respond while BenchPoll was completing sign-in.',
            github_token_exchange_unavailable: 'BenchPoll could not reach GitHub\'s sign-in service.',
            github_token_exchange_failed: 'GitHub rejected the authorization-code exchange.',
            github_token_response_invalid: 'GitHub returned an invalid authorization response.',
            github_authorization_failed: 'GitHub could not authorize this sign-in.',
            github_profile_timeout: 'GitHub did not respond while BenchPoll was loading your profile.',
            github_profile_unavailable: 'BenchPoll could not reach GitHub\'s profile service.',
            github_profile_failed: 'GitHub rejected the profile request.',
            github_profile_response_invalid: 'GitHub returned an invalid profile response.',
            github_profile_invalid: 'The GitHub profile response was incomplete.',
            github_email_timeout: 'GitHub did not respond while BenchPoll was checking your verified email.',
            github_email_unavailable: 'BenchPoll could not reach GitHub\'s email service.',
            github_email_permission_required: 'BenchPoll could not read a verified email from GitHub. Check the app email permission and try again.',
            github_email_failed: 'GitHub rejected the verified-email request.',
            github_email_response_invalid: 'GitHub returned an invalid email response.',
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
        dialogTitle.textContent = 'A client-side error occurred';
        dialogBody.textContent = 'You may still be able to view the error after returning to this page, ' +
            'but enabling “Preserve log” in Developer Tools provides a more reliable record.';
        break;
    }
    break;
case 7:
    const p3 = document.createElement('p');
    const p4 = document.createElement('p');
    const a = document.createElement('a');
    p3.textContent =
        'Due to a violation of our Terms of Service, ' +
        'your account is currently restricted from logging in. This suspension will be lifted on ' + bannedUntil + '.';
    p4.textContent =
        'If you believe this was done in error, you may submit an appeal by contacting us at ';
    a.href = 'mailto:' + G.SUPPORT_EMAIL_ADDRESS + '?subject=' + encodeURIComponent(G.APPEAL_EMAIL_SUBJECT);
    a.textContent = G.SUPPORT_EMAIL_ADDRESS;
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
            if (oldURL) {
                return;
            }
            break;
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
        G.editURL(oldURL, false, true);
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
