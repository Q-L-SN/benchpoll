import dotenv from 'dotenv';
import { inspectModerationEmailConfiguration } from '../moderation-email.js';

dotenv.config({ quiet: true });

// Inspect configuration only: do not create a transport, access the outbox or start delivery.
const status = inspectModerationEmailConfiguration();
console.log(JSON.stringify({
    ...status,
    smtpConnectionVerified: false,
    mailWorkerStarted: false
}, null, 2));
if (!status.deliveryConfigured) process.exitCode = 1;
