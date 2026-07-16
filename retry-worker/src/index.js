import { getRosterEntry, insertMagicLink, getPendingLogins, markPendingLoginAttempt, deletePendingLogin } from '../../functions/_lib/db.js';
import { generateRandomToken, magicLinkExpiry } from '../../functions/_lib/auth.js';
import { sendMagicLinkEmail } from '../../functions/_lib/resend.js';
import { peekDailyCounter, incrementDailyCounter } from '../../functions/_lib/rateLimit.js';

const RESEND_DAILY_SOFT_CAP = 90; // matches functions/login.js — shared budget, same KV keys
const BATCH_SIZE = 20; // per cron tick, well under Resend's 10 req/sec limit
const MAX_ATTEMPTS = 10; // give up after this many failed retries for one email

export default {
  async scheduled(controller, env, ctx) {
    const { results: pending } = await getPendingLogins(env.DB, BATCH_SIZE);

    for (const row of pending) {
      const sentToday = await peekDailyCounter(env.RATE_LIMIT, 'rl:login:resend_daily');
      if (sentToday >= RESEND_DAILY_SOFT_CAP) {
        console.log('retry_worker_stopping_at_daily_cap', sentToday);
        break; // still capped — leave the rest queued for the next tick
      }

      const rosterEntry = await getRosterEntry(env.DB, row.email);
      if (!rosterEntry) {
        // Resident was removed from the roster while queued — nothing to send.
        await deletePendingLogin(env.DB, row.id);
        continue;
      }

      const token = generateRandomToken();
      await insertMagicLink(env.DB, token, rosterEntry.email, magicLinkExpiry());
      const verifyUrl = `${env.APP_URL}/verify?token=${token}`;

      const sent = await sendMagicLinkEmail(env, rosterEntry.email, verifyUrl);
      if (sent) {
        await incrementDailyCounter(env.RATE_LIMIT, 'rl:login:resend_daily');
        await deletePendingLogin(env.DB, row.id);
        console.log('retry_worker_sent', rosterEntry.email);
      } else {
        await markPendingLoginAttempt(env.DB, row.id);
        if (row.attempts + 1 >= MAX_ATTEMPTS) {
          console.error('retry_worker_giving_up', rosterEntry.email, row.attempts + 1);
          await deletePendingLogin(env.DB, row.id);
        }
      }
    }
  },
};
