import { incrementFixedWindowCounter } from './rateLimit.js';
import { sendSecurityAlertEmail } from './resend.js';

const ALERT_THRESHOLD = 5;
const ALERT_WINDOW_SECONDS = 600;

// Records failures across all source IPs, so rotating addresses does not avoid
// detection. Exactly one notification is sent per event type/window when the
// threshold is crossed; later failures in the same window do not spam email.
export async function recordSecurityFailure(env, waitUntil, eventType) {
  try {
    const count = await incrementFixedWindowCounter(
      env.DB,
      `security:${eventType}`,
      'all',
      ALERT_WINDOW_SECONDS
    );
    if (count !== ALERT_THRESHOLD) return;

    const task = sendSecurityAlertEmail(env, eventType, count, ALERT_WINDOW_SECONDS / 60);
    if (typeof waitUntil === 'function') waitUntil(task);
    else await task;
  } catch {
    // Authentication must continue to fail closed even if alert bookkeeping or
    // the email provider is temporarily unavailable.
    console.error('security_alert_failed', eventType);
  }
}
