// Shared by functions/login.js (Pages Function) and retry-worker/src/index.js
// (standalone scheduled Worker) so both send emails identically.
export async function sendMagicLinkEmail(env, email, verifyUrl) {
  const body = JSON.stringify({
    from: env.RESEND_FROM || 'onboarding@resend.dev',
    to: email,
    subject: 'Your sign-in link',
    html: `<p>Click to sign in: <a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
  });

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
      console.error('resend_send_failed', res.status, await res.text().catch(() => ''));
    } catch (err) {
      console.error('resend_send_threw', err);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}
