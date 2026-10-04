// Progressive enhancement for the check-in form.
//
// The page works without this file, and that is why the submit button is
// disabled from here rather than in the server-rendered HTML: if this script is
// blocked or never arrives, a resident gets exactly the behaviour they had
// before it existed, instead of a button nobody can press.
//
// What it fixes. Turnstile tokens are single-use and expire after a few
// minutes. The form would submit with no token at all, or with a spent one, and
// the rejection re-rendered a page that could do the same thing again — so a
// resident could tap Check in over and over and never be recorded. That is what
// happened at noon conference on 2026-08-20: two people got through at 12:12
// and 12:14, and the resident photographed at 12:15 was still looking at "the
// security check timed out" with nothing written to the database.
(function () {
  'use strict';

  var form = document.getElementById('checkin-form');
  var button = document.getElementById('checkin-submit');
  var note = document.getElementById('checkin-note');
  if (!form || !button || !note) return;

  // Generous on purpose. Hospital Wi-Fi is slow, and declaring failure on a
  // challenge that was about to succeed is its own way of losing a check-in.
  var READY_TIMEOUT_MS = 15000;

  var LABEL = button.textContent;
  var waiting = null;
  var stalled = false;

  function say(text) {
    note.textContent = text;
    note.hidden = !text;
  }

  function hold(label) {
    button.disabled = true;
    button.textContent = label;
  }

  function release() {
    button.disabled = false;
    button.textContent = LABEL;
  }

  // Backstop for a callback that never reaches us. functions/checkin.js orders
  // the script tags so this file always runs before Turnstile binds the
  // callback names, but if that ever slips the token still lands in the form —
  // read the response field directly rather than refusing a challenge that
  // already passed.
  function solved() {
    var field = form.querySelector('[name="cf-turnstile-response"]');
    return !!(field && field.value);
  }

  function arm() {
    clearTimeout(waiting);
    waiting = setTimeout(giveUp, READY_TIMEOUT_MS);
  }

  // Never leave a dead button behind. Submitting without a token is refused
  // server-side, so offer the one retry that can change the outcome — a fresh
  // challenge — rather than another identical POST.
  function giveUp() {
    if (solved()) return ready();
    stalled = true;
    say('The security check could not load. Tap Try again — if it keeps failing, turn Wi-Fi off to use cellular data, or see a chief resident.');
    button.disabled = false;
    button.textContent = 'Try again';
  }

  function ready() {
    clearTimeout(waiting);
    stalled = false;
    say('');
    release();
  }

  // The address the QR opened, rebuilt from the form's own fields.
  function formUrl() {
    return window.location.pathname +
      '?e=' + encodeURIComponent(form.elements.e.value) +
      '&t=' + encodeURIComponent(form.elements.t.value);
  }

  // If Turnstile's script is here, run the challenge again in place, so the
  // typed name survives and a resident who has just switched to cellular gets
  // a real second attempt. If it never arrived, only a fresh page can fetch it
  // — and that page is asked for with GET, not reload(): this page is often
  // itself the response to a refused POST, and reloading one of those re-sends
  // the POST. That means a "send the form again?" prompt, the same missing
  // token, and one more attempt spent against the per-person rate limit.
  function retry() {
    stalled = false;
    say('');
    hold('Checking…');
    if (window.turnstile && typeof window.turnstile.reset === 'function') {
      try {
        window.turnstile.reset();
        arm();
        return;
      } catch (err) {
        // Loaded but never rendered a widget; nothing to reset.
      }
    }
    window.location.replace(formUrl());
  }

  form.addEventListener('submit', function (event) {
    if (stalled) {
      event.preventDefault();
      retry();
      return;
    }
    // A second POST reuses a token Cloudflare has already spent, and comes back
    // as a failed challenge — so the double-tap that feels like impatience is
    // itself a way to not get recorded.
    hold('Checking in…');
  });

  // Called by name from the widget's data-*-callback attributes, which are set
  // in functions/checkin.js. Renaming either end breaks the other silently.
  window.checkinChallengeReady = ready;

  window.checkinChallengeExpired = function () {
    hold('Refreshing…');
    if (window.turnstile && typeof window.turnstile.reset === 'function') {
      window.turnstile.reset();
      arm();
    } else {
      giveUp();
    }
  };

  window.checkinChallengeFailed = function () {
    clearTimeout(waiting);
    giveUp();
  };

  hold('Checking…');
  arm();
})();
