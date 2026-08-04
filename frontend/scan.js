// Same-origin by default (Worker routed under this domain, see wrangler.toml).
// Override by setting window.API_BASE before this script loads if the Worker
// runs on a different origin during local development.
const API_BASE = window.API_BASE || '';

const loginScreen = document.getElementById('login-screen');
const scanScreen = document.getElementById('scan-screen');
const emailInput = document.getElementById('email-input');
const loginButton = document.getElementById('login-button');
const loginMessage = document.getElementById('login-message');
const welcomeMessage = document.getElementById('welcome-message');
const scanButton = document.getElementById('scan-button');
const scanMessage = document.getElementById('scan-message');
const logoutButton = document.getElementById('logout-button');
const video = document.getElementById('scan-video');
const scanViewport = document.getElementById('scan-viewport');
const canvas = document.getElementById('scan-canvas');
const zoomControls = document.getElementById('zoom-controls');
const zoomSlider = document.getElementById('zoom-slider');
const zoomOutButton = document.getElementById('zoom-out');
const zoomInButton = document.getElementById('zoom-in');
const zoomLevel = document.getElementById('zoom-level');
const loginTurnstile = document.getElementById('login-turnstile');

let loginChallengeToken = '';
let loginWidgetId = null;

function setMessage(el, text, kind) {
  el.textContent = text;
  el.className = 'message' + (kind ? ` ${kind}` : '');
}

async function checkSession() {
  try {
    const res = await fetch(`${API_BASE}/me`, { credentials: 'include' });
    if (!res.ok) {
      loginScreen.classList.remove('hidden');
      scanScreen.classList.add('hidden');
      renderLoginChallenge();
      return;
    }
    const data = await res.json();
    welcomeMessage.textContent = `Signed in as ${data.name}`;
    loginScreen.classList.add('hidden');
    scanScreen.classList.remove('hidden');
  } catch {
    loginScreen.classList.remove('hidden');
    scanScreen.classList.add('hidden');
    setMessage(loginMessage, 'Could not load sign-in. Refresh and try again.', 'error');
  }
}

function renderLoginChallenge() {
  if (loginWidgetId !== null) return;
  if (!window.turnstile || !loginTurnstile?.dataset.sitekey) {
    setMessage(loginMessage, 'Security check failed to load. Refresh and try again.', 'error');
    return;
  }
  loginWidgetId = window.turnstile.render(loginTurnstile, {
    sitekey: loginTurnstile.dataset.sitekey,
    action: 'login',
    callback(token) {
      loginChallengeToken = token;
      loginButton.disabled = false;
      if (loginMessage.textContent.startsWith('Security check')) {
        setMessage(loginMessage, '', '');
      }
    },
    'expired-callback'() {
      loginChallengeToken = '';
      loginButton.disabled = true;
    },
    'error-callback'() {
      loginChallengeToken = '';
      loginButton.disabled = true;
      setMessage(loginMessage, 'Security check failed to load. Try again.', 'error');
      return true;
    },
  });
}

function resetLoginChallenge() {
  loginChallengeToken = '';
  loginButton.disabled = true;
  if (loginWidgetId !== null) window.turnstile.reset(loginWidgetId);
}

loginButton.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email || !loginChallengeToken) return;
  const submittedChallenge = loginChallengeToken;
  loginButton.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, turnstileToken: submittedChallenge }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      setMessage(loginMessage, 'Check your email for a sign-in link.', 'success');
    } else {
      setMessage(loginMessage, data.message || 'Something went wrong. Try again.', 'error');
    }
  } catch {
    setMessage(loginMessage, 'Something went wrong. Try again.', 'error');
  } finally {
    resetLoginChallenge();
  }
});

logoutButton.addEventListener('click', async () => {
  stopScan();
  await fetch(`${API_BASE}/logout`, { credentials: 'include' });
  window.location.reload();
});

let stream = null;
let scanning = false;

// A lecture-hall QR is small in frame, so ask for the highest sensible capture
// resolution and let zoom work on those extra pixels.
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1080;

// Decode budget for the pure-JS fallback. Measured on desktop Chrome, jsQR runs
// ~380ms/frame on a 1080x1920 frame versus ~40ms for the native detector; on
// mid-range Android that became seconds per frame, so a hand-held scan never
// landed a clean one — preview running, nothing decoded, no error reported.
//
// The cap is on the LONG edge, which is the actual fix. The previous cap was on
// WIDTH, so a 1920x1080 landscape frame (iOS) was correctly reduced to 1280x720
// while a 1080x1920 portrait frame (Android) slipped through at full 2M pixels
// because its *width* was already under the limit. Keeping the number at 1280
// leaves iOS byte-for-byte as it is today — it is the platform currently
// working, and distant-QR sensitivity there must not regress.
const MAX_JSQR_EDGE = 1280;
// Throttle decode attempts so a slow decode can't saturate the main thread and
// stall the live preview. rAF alone gave no upper bound on work per second.
const DECODE_INTERVAL_MS = 100;
// Cameras that expose no zoom capability fall back to cropping the frame.
const MAX_DIGITAL_ZOOM = 4;

// How long the native detector may run without a single hit before we give up on
// it and hand the rest of the session to jsQR. The failure this guards against is
// silent by construction: Chrome on Android downloads the Play Services barcode
// module on demand, and until it lands getSupportedFormats() already advertises
// 'qr_code' while detect() just resolves [] forever. Nothing throws, so the
// catch-based demotion in decodeFrame() never fires -- preview running, decode
// rate healthy, no error, and the code never reads. Generous enough that a
// resident lining a QR up normally is never demoted off the fast path.
const NATIVE_PROBATION_MS = 6000;

// How long to scan with nothing decoded before saying something to the resident.
// Silence is the one outcome this scanner must never produce: it is
// indistinguishable from a broken app, which is exactly how the bug above got
// reported ("the camera doesn't recognise the code").
const NO_DECODE_HINT_MS = 12000;

let zoom = 1;
let zoomRange = { min: 1, max: MAX_DIGITAL_ZOOM, step: 0.1 };
// Set when the camera can zoom optically/natively; null means digital cropping.
let zoomTrack = null;
let zoomApplyQueued = false;

// getUserMedia fails for several distinct reasons that need different actions
// from the resident — a single "could not access camera" leaves them (and us)
// with nothing to go on. Chrome on Android in particular remembers a denied
// camera permission per-origin forever, so the fix is in site settings, not a
// retry.
function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Tap the icon to the left of the address bar → Permissions → allow Camera, then try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Another app is using the camera. Close your camera app (and other browser tabs), then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable camera found on this device.';
    default:
      return 'Could not start the camera. Try again, or reload the page.';
  }
}

async function startScan() {
  setMessage(scanMessage, '', '');
  scanButton.disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('unsupported'), { name: 'NotFoundError' });
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: CAPTURE_WIDTH },
        height: { ideal: CAPTURE_HEIGHT },
      },
    });
    // Unhide BEFORE play(). Chrome on Android won't start playback on a
    // display:none element — play() rejects (or never resolves), which used to
    // land in the catch below and leave the viewport hidden forever, so the
    // resident saw a bare error with no preview even though the camera had
    // been granted and opened.
    scanViewport.classList.remove('hidden');
    video.srcObject = stream;
    await video.play();
    scanning = true;
    setupZoom();
    scanButton.textContent = 'Stop Camera';
    scanButton.disabled = false;
    debugDecodes = 0;
    debugStartedAt = performance.now();
    scanStartedAt = debugStartedAt;
    noDecodeHintShown = false;
    nativeProbationStart = 0;
    lastDecodeAt = 0;
    requestAnimationFrame(scanFrame);
  } catch (err) {
    console.error('camera_start_failed', err?.name, err?.message);
    stopScan();
    setMessage(scanMessage, cameraErrorMessage(err), 'error');
    scanButton.disabled = false;
  }
}

function stopScan() {
  scanning = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  zoomTrack = null;
  scanViewport.classList.add('hidden');
  zoomControls.classList.add('hidden');
  video.style.transform = '';
  scanButton.textContent = 'Scan QR Code';
  scanButton.disabled = false;
}

function setupZoom() {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  // Keeps a distant code sharp while the resident holds the phone up.
  track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});

  const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const nativeZoom = capabilities.zoom;
  if (nativeZoom && nativeZoom.max > nativeZoom.min) {
    zoomTrack = track;
    zoomRange = {
      min: nativeZoom.min,
      max: nativeZoom.max,
      step: nativeZoom.step || (nativeZoom.max - nativeZoom.min) / 100,
    };
  } else {
    zoomTrack = null;
    zoomRange = { min: 1, max: MAX_DIGITAL_ZOOM, step: 0.1 };
  }

  zoomSlider.min = String(zoomRange.min);
  zoomSlider.max = String(zoomRange.max);
  zoomSlider.step = String(zoomRange.step);
  // Carry the previous zoom across restarts — the room hasn't moved.
  setZoom(zoom);
  zoomControls.classList.remove('hidden');
}

function setZoom(value) {
  zoom = Math.min(zoomRange.max, Math.max(zoomRange.min, value));
  zoomSlider.value = String(zoom);
  zoomLevel.textContent = `${(zoom / zoomRange.min).toFixed(1)}×`;

  if (zoomTrack) {
    video.style.transform = '';
    // Coalesce drag events: applyConstraints is async and rejects if it piles up.
    if (!zoomApplyQueued) {
      zoomApplyQueued = true;
      requestAnimationFrame(() => {
        zoomApplyQueued = false;
        if (zoomTrack) zoomTrack.applyConstraints({ advanced: [{ zoom }] }).catch(() => {});
      });
    }
  } else {
    video.style.transform = `scale(${zoom})`;
  }
}

function zoomStep() {
  return zoomTrack ? Math.max(zoomRange.step, (zoomRange.max - zoomRange.min) / 10) : 0.5;
}

zoomSlider.addEventListener('input', () => setZoom(Number(zoomSlider.value)));
zoomInButton.addEventListener('click', () => setZoom(zoom + zoomStep()));
zoomOutButton.addEventListener('click', () => setZoom(zoom - zoomStep()));

// Resolved once per page load: a native BarcodeDetector supporting QR, or null
// to mean "use jsQR". Cached as a promise so the async capability probe runs
// once rather than on every decode attempt.
let detectorPromise = null;

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      try {
        if (!('BarcodeDetector' in window)) {
          debugDetector = 'jsQR (no BarcodeDetector)';
          return null;
        }
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (!formats.includes('qr_code')) {
          debugDetector = 'jsQR (no qr_code format)';
          return null;
        }
        debugDetector = 'BarcodeDetector (native)';
        return new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (err) {
        debugDetector = `jsQR (probe threw ${err?.name})`;
        return null;
      }
    })();
  }
  return detectorPromise;
}

// Timestamp of the first native decode attempt in the current scan session, or 0
// once the detector has proved itself by finding something. Reset per startScan
// so a detector that works is never demoted because of an earlier session.
let nativeProbationStart = 0;

// Permanently hand the rest of the session to jsQR. Slower, but a working slow
// decoder beats a fast one that silently returns nothing.
function demoteDetector(reason) {
  detectorPromise = Promise.resolve(null);
  debugDetector = `jsQR (demoted: ${reason})`;
  debugNote = `demoted: ${reason}`;
  console.warn('barcode_detector_demoted', reason);
}

// Draws the current frame into `canvas`, honouring digital zoom, and returns the
// 2d context. maxEdge caps the longest side; 0 means full resolution.
function drawFrame(maxEdge) {
  // Native zoom already crops in hardware, so only crop here for digital zoom.
  const crop = zoomTrack ? 1 : zoom;
  const sourceWidth = video.videoWidth / crop;
  const sourceHeight = video.videoHeight / crop;
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight)) : 1;

  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(
    video,
    sourceX, sourceY, sourceWidth, sourceHeight,
    0, 0, canvas.width, canvas.height,
  );
  return ctx;
}

async function decodeFrame() {
  const detector = await getDetector();
  if (detector) {
    // Hardware-backed, so hand it the untouched video element when we aren't
    // digitally cropping — that skips a canvas copy entirely. No resolution cap
    // on this path: it is fast enough to keep the full distant-QR sensitivity.
    let source = video;
    if (!zoomTrack && zoom !== 1) {
      drawFrame(0);
      source = canvas;
    }
    try {
      const codes = await detector.detect(source);
      const hit = codes.find((c) => c.rawValue);
      if (hit) {
        nativeProbationStart = 0; // proved it works; never demote this session
        return hit.rawValue;
      }
      // An empty result is ambiguous -- no QR in frame, or a detector that will
      // never return one. Only the passage of time separates them, so start a
      // clock on the first miss and fall through to jsQR once it runs out.
      const nowMs = performance.now();
      if (!nativeProbationStart) nativeProbationStart = nowMs;
      if (nowMs - nativeProbationStart < NATIVE_PROBATION_MS) return null;
      demoteDetector(`no hit in ${Math.round(NATIVE_PROBATION_MS / 1000)}s`);
    } catch (err) {
      // Some Android builds expose BarcodeDetector but throw on detect(). Demote
      // to jsQR for the rest of the session rather than wedging the scanner.
      demoteDetector(`detect() threw ${err?.name}`);
    }
  }
  if (typeof jsQR !== 'function') {
    // jsQR is a CDN script (see index.html). A network that blocks
    // cdn.jsdelivr.net never defines it, and with no usable BarcodeDetector that
    // leaves no decoder at all. This used to throw a bare ReferenceError every
    // frame into scanFrame()'s catch, which logged it and kept looping: preview
    // up, nothing decoded, not a word to the resident. Name it so the caller can
    // stop and say so.
    throw Object.assign(new Error('jsQR unavailable'), { name: 'DecoderUnavailableError' });
  }
  const ctx = drawFrame(MAX_JSQR_EDGE);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // dontInvert halves the work: these QRs are always dark-on-light, generated by
  // scripts/generate_qr.py, so probing for an inverted code is wasted effort.
  const code = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert',
  });
  return code && code.data ? code.data : null;
}

// Bump on every scanner change that needs verifying on a handset. Shown in the
// ?debug=1 readout so "is the fix actually live on this phone?" is answered by
// looking at the screen, instead of by trusting that a reload picked up new JS.
const SCAN_BUILD = '2026-08-04c';

// ?debug=1 reports which decoder is live, the real stream resolution and the
// achieved decode rate. It diagnosed the Android/portrait throughput bug (a
// 1080x1920 stream decoding at 2M px).
//
// f0dc650 moved this readout into the console alone, on the grounds that it must
// never appear during a real check-in. That still holds — but console-only means
// reading it requires chrome://inspect from a laptop, and that barrier is exactly
// what left a live scanner undiagnosable on the one device that reproduces the
// bug. So it renders on screen *and* logs, both strictly behind the flag; a
// resident checking in never has the flag, so nothing leaks into normal use.
const debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1';
let debugDecodes = 0;
let debugStartedAt = 0;
let debugLoggedAt = 0;
let debugDetector = 'probing';
let debugNote = '';
let debugEl = null;

// A camera that is running but handing back black or flat frames decodes nothing
// and looks identical on screen to a code the scanner simply can't read. Sampling
// the luminance spread separates the two: a real QR in frame spans nearly the
// full range, while a black or washed-out frame collapses to almost none. Uses
// its own tiny canvas so it can never race the decode path's shared one.
let probeCanvas = null;

function frameBrightness() {
  if (!video.videoWidth) return null;
  if (!probeCanvas) probeCanvas = document.createElement('canvas');
  probeCanvas.width = 48;
  probeCanvas.height = 48;
  const ctx = probeCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 48, 48);
  const { data } = ctx.getImageData(0, 0, 48, 48);
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    sum += lum;
  }
  return {
    mean: Math.round(sum / (data.length / 4)),
    min: Math.round(min),
    max: Math.round(max),
  };
}

function updateDebug(frameReady) {
  if (!debugEnabled || !debugStartedAt) return;
  const nowMs = performance.now();
  // One line per second — every animation frame would flood the console.
  if (nowMs - debugLoggedAt < 1000) return;
  debugLoggedAt = nowMs;
  const secs = (nowMs - debugStartedAt) / 1000;
  const rate = secs ? (debugDecodes / secs).toFixed(1) : '0';
  const lum = frameBrightness();
  const lumText = lum ? `mean=${lum.mean} min=${lum.min} max=${lum.max} spread=${lum.max - lum.min}` : 'n/a';

  console.log(
    `scan_debug build=${SCAN_BUILD} decoder=${debugDetector} ` +
      `stream=${video.videoWidth}x${video.videoHeight} canvas=${canvas.width}x${canvas.height} ` +
      `readyState=${video.readyState} frameReady=${frameReady} ` +
      `zoom=${zoom.toFixed(2)}/${zoomTrack ? 'native' : 'digital'} ` +
      `decodes=${debugDecodes} rate=${rate}/s frame=${lumText}` +
      (debugNote ? ` note=${debugNote}` : ''),
  );

  if (!debugEl) {
    debugEl = document.createElement('pre');
    debugEl.style.cssText =
      'font:11px/1.4 ui-monospace,monospace;text-align:left;background:#111;color:#0f0;' +
      'padding:.5rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap';
    scanMessage.parentNode.insertBefore(debugEl, scanMessage);
  }
  debugEl.textContent = [
    `build      ${SCAN_BUILD}`,
    `decoder    ${debugDetector}`,
    `stream     ${video.videoWidth}x${video.videoHeight}`,
    `canvas     ${canvas.width}x${canvas.height}`,
    `readyState ${video.readyState} (frameReady=${frameReady})`,
    `zoom       ${zoom.toFixed(2)} (${zoomTrack ? 'native' : 'digital'})`,
    `decodes    ${debugDecodes} in ${secs.toFixed(1)}s = ${rate}/s`,
    `frame      ${lumText}`,
    debugNote ? `note       ${debugNote}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

let decodeInFlight = false;
let lastDecodeAt = 0;
let scanStartedAt = 0;
let noDecodeHintShown = false;

// Break the silence after NO_DECODE_HINT_MS of scanning with nothing decoded.
// Deliberately not styled as an error -- most of the time the camera is simply
// too far from the code, and this is the nudge that fixes it. Shown once, then
// replaced by the real result the moment anything decodes.
function maybeHintNoDecode(now) {
  if (noDecodeHintShown || !scanStartedAt || now - scanStartedAt < NO_DECODE_HINT_MS) return;
  noDecodeHintShown = true;
  setMessage(
    scanMessage,
    'Still looking for a code — move closer, hold steady, and keep the whole square in frame.',
    ''
  );
}

async function scanFrame(now) {
  if (!scanning) return;
  // A live MediaStream is not a buffered file: Chrome on Android commonly holds
  // readyState at HAVE_CURRENT_DATA and never advertises HAVE_ENOUGH_DATA, so
  // the old `=== HAVE_ENOUGH_DATA` check spun this loop forever — preview
  // visible, no frame ever decoded, no error. Decode as soon as there's a frame
  // to decode, and require real dimensions so the first ticks (videoWidth 0)
  // don't hand the decoder a zero-sized buffer.
  const frameReady = video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0;
  if (frameReady && !decodeInFlight && now - lastDecodeAt >= DECODE_INTERVAL_MS) {
    lastDecodeAt = now;
    decodeInFlight = true;
    try {
      const data = await decodeFrame();
      debugDecodes += 1;
      // decodeFrame() awaits, so the resident may have hit "Stop Camera" in the
      // meantime — don't check them in after they cancelled.
      if (!scanning) return;
      if (data) {
        stopScan();
        submitCheckin(data);
        return;
      }
      maybeHintNoDecode(now);
    } catch (err) {
      if (err?.name === 'DecoderUnavailableError') {
        // No decoder exists at all, so every further frame is wasted work and
        // the resident would sit in front of a live preview forever. Stop and
        // say so instead.
        stopScan();
        setMessage(
          scanMessage,
          'The QR scanner failed to load. Check your network connection, then reload the page.',
          'error'
        );
        return;
      }
      // An exception here used to kill the rAF loop outright, which looked
      // exactly like "the app does nothing" — keep looping, but leave a trace.
      debugNote = `decode_failed: ${err?.name}`;
      console.error('decode_failed', err?.name, err?.message);
    } finally {
      decodeInFlight = false;
    }
  }
  updateDebug(frameReady);
  if (scanning) requestAnimationFrame(scanFrame);
}

async function submitCheckin(token) {
  try {
    const res = await fetch(`${API_BASE}/checkin`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    setMessage(scanMessage, data.message || 'Check-in failed. Try again.', data.ok ? 'success' : 'error');
  } catch {
    setMessage(scanMessage, 'Network error. Try again.', 'error');
  }
}

scanButton.addEventListener('click', () => {
  if (scanning) {
    stopScan();
  } else {
    startScan();
  }
});

checkSession();
