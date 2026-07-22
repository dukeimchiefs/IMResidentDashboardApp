import test from 'node:test';
import assert from 'node:assert/strict';

import { recordSecurityFailure } from '../functions/_lib/securityAlerts.js';

function counterDb() {
  let count = 0;
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              count += 1;
              return { count };
            },
          };
        },
      };
    },
  };
}

test('sends one alert when the cross-IP failure threshold is crossed', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response('{}', { status: 200 });
  };

  const background = [];
  const env = {
    DB: counterDb(),
    RESEND_KEY: 'test-key',
    RESEND_FROM: 'security@example.test',
    SECURITY_ALERT_EMAIL: 'admin@example.test',
  };
  for (let i = 0; i < 6; i++) {
    await recordSecurityFailure(env, (promise) => background.push(promise), 'export_auth_failure');
  }
  await Promise.all(background);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].to, 'admin@example.test');
  assert.match(requests[0].subject, /repeated attendance export authentication failures/);
  assert.doesNotMatch(requests[0].html, /credential value|resident@example/i);
});
