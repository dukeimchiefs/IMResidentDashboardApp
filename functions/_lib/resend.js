import { MAGIC_LINK_TTL_MINUTES } from './auth.js';

// Residents are on Microsoft 365 (duke.edu -> Exchange Online Protection), which
// weights message shape heavily on top of SPF/DKIM. Three things below exist
// purely for deliverability, so don't "simplify" them away:
//   1. A display name on From — a bare address scores worse than a named sender.
//   2. A text/plain alternative alongside the HTML — HTML-only is one of the
//      strongest single spam signals EOP applies.
//   3. Body copy that isn't one naked URL. A single-link message whose visible
//      anchor text is the link target, wrapped in an expiry countdown, is the
//      literal shape of a credential phish, and filters score it that way.
const FROM_NAME = 'IM Resident Check-In';

function fromAddress(env) {
  const address = env.RESEND_FROM || 'onboarding@resend.dev';
  return address.includes('<') ? address : `${FROM_NAME} <${address}>`;
}

// Shared by functions/login.js (Pages Function) and retry-worker/src/index.js
// (standalone scheduled Worker) so both send emails identically.
export async function sendMagicLinkEmail(env, email, verifyUrl) {
  const payload = {
    from: fromAddress(env),
    to: email,
    subject: 'Sign in to Resident Learning Check-In',
    text: [
      'Hello,',
      '',
      'You asked to sign in to the Internal Medicine Resident Learning Check-In app.',
      'Open this address in your browser to finish signing in:',
      '',
      verifyUrl,
      '',
      `For your security the address stops working after ${MAGIC_LINK_TTL_MINUTES} minutes.`,
      'If you did not request this, no action is needed and you can ignore this message.',
      '',
      'Internal Medicine Residency — conference attendance check-in',
    ].join('\n'),
    html:
      `<p>Hello,</p>` +
      `<p>You asked to sign in to the Internal Medicine Resident Learning Check-In app.</p>` +
      `<p><a href="${verifyUrl}">Finish signing in</a></p>` +
      `<p>For your security that link stops working after ${MAGIC_LINK_TTL_MINUTES} minutes. ` +
      `If you did not request this, no action is needed and you can ignore this message.</p>` +
      `<p style="color:#666;font-size:12px">Internal Medicine Residency — conference attendance check-in</p>`,
  };
  // A monitored reply address beats a silent no-reply: filters and recipients
  // both penalise a From domain that can't be replied to.
  if (env.RESEND_REPLY_TO) payload.reply_to = env.RESEND_REPLY_TO;
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (res.ok) return true;
      // Provider error bodies can echo recipient addresses or request details;
      // the status is enough to diagnose/retry without copying PII into logs.
      console.error('resend_send_failed', res.status);
    } catch (err) {
      console.error('resend_send_threw', err);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

const SECURITY_EVENT_LABELS = {
  export_auth_failure: 'attendance export authentication',
  admin_auth_failure: 'attendance administrator authentication',
};

export async function sendSecurityAlertEmail(env, eventType, count, windowMinutes) {
  const label = SECURITY_EVENT_LABELS[eventType];
  if (!label || !env.RESEND_KEY || !env.SECURITY_ALERT_EMAIL) {
    console.error('security_alert_not_configured', eventType);
    return false;
  }

  const alertText =
    `The application recorded ${count} failed ${label} attempts within ${windowMinutes} minutes.\n\n` +
    'No submitted credentials, email addresses, or IP addresses are included in this alert. ' +
    'Review Cloudflare Access and application logs for authorized investigation.';

  const body = JSON.stringify({
    from: fromAddress(env),
    to: env.SECURITY_ALERT_EMAIL,
    subject: `Security alert: repeated ${label} failures`,
    text: alertText,
    html: `<p>The application recorded ${count} failed ${label} attempts within ${windowMinutes} minutes.</p><p>No submitted credentials, email addresses, or IP addresses are included in this alert. Review Cloudflare Access and application logs for authorized investigation.</p>`,
  });

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (response.ok) return true;
    console.error('security_alert_send_failed', eventType, response.status);
  } catch {
    console.error('security_alert_send_threw', eventType);
  }
  return false;
}
