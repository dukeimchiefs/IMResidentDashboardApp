import { cleanupExpiredCounters } from '../../functions/_lib/rateLimit.js';

// All this Worker does now is take out the rate limiter's rubbish.
//
// It began as the retry queue that redelivered magic-link sign-in emails that
// hit the Resend daily cap. Sign-in is gone, and so is the queue — but the
// cleanup call it made on the side is not optional: rate_limit_counters has no
// TTL mechanism of its own (a D1 table has no equivalent of KV's
// expirationTtl), so without something deleting elapsed rows on a schedule the
// table grows without bound for as long as the app is up.
//
// Cloudflare Pages Functions cannot run Cron Triggers, which is why this is a
// standalone deployable rather than a handler alongside the rest of the app.
export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cleanupExpiredCounters(env.DB));
  },
};
