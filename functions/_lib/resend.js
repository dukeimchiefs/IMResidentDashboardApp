// Outbound email is now limited to security alerts.
//
// Residents used to receive magic-link sign-in emails from here; that flow is
// gone, and with it the Resend daily-cap accounting and the retry queue. What
// remains is the alert sent to the chiefs when someone repeatedly fails the
// /attendance password or the /export admin key — the only signal either of
// those is being brute-forced, so it outlived the sign-in system it shipped
// with.

const FROM_NAME = 'IM Resident Check-In';

function fromAddress(env) {
  const address = env.RESEND_FROM || 'onboarding@resend.dev';
  return address.includes('<') ? address : `${FROM_NAME} <${address}>`;
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
