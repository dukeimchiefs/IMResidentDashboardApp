import test from 'node:test';
import assert from 'node:assert/strict';

import { validateTurnstile } from '../functions/_lib/turnstile.js';

const env = {
  TURNSTILE_SECRET: 'test-secret',
  TURNSTILE_HOSTNAME: 'imresidentdashboardapp.pages.dev',
};

test('accepts a successful token for the expected action and hostname', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    action: 'login',
    hostname: 'imresidentdashboardapp.pages.dev',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  assert.equal(await validateTurnstile(env, 'valid-token', '203.0.113.1', 'login'), true);
});

test('rejects tokens minted for a different action or hostname', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    action: 'verify',
    hostname: 'attacker.example',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  assert.equal(await validateTurnstile(env, 'wrong-context', '203.0.113.1', 'login'), false);
});

test('rejects missing or oversized tokens without calling Siteverify', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; };

  assert.equal(await validateTurnstile(env, '', '203.0.113.1', 'login'), false);
  assert.equal(await validateTurnstile(env, 'x'.repeat(2049), '203.0.113.1', 'login'), false);
  assert.equal(calls, 0);
});
