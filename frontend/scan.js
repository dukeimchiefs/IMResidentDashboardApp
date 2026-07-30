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
      return hit ? hit.rawValue : null;
    } catch {
      // Some Android builds expose BarcodeDetector but throw on detect(). Demote
      // to jsQR for the rest of the session rather than wedging the scanner.
      detectorPromise = Promise.resolve(null);
    }
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

// ?debug=1 logs which decoder is live, the real stream resolution and the
// achieved decode rate. Console-only and flag-gated: this diagnosed the Android/
// portrait throughput bug (a 1080x1920 stream decoding at 2M px), and keeping it
// beats remote-debugging a resident's handset the next time scanning "does
// nothing" — but it must never put anything on screen during a real check-in.
const debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1';
let debugDecodes = 0;
let debugStartedAt = 0;
let debugLoggedAt = 0;
let debugDetector = 'probing';

function updateDebug(frameReady) {
  if (!debugEnabled || !debugStartedAt) return;
  const nowMs = performance.now();
  // One line per second — every animation frame would flood the console.
  if (nowMs - debugLoggedAt < 1000) return;
  debugLoggedAt = nowMs;
  const secs = (nowMs - debugStartedAt) / 1000;
  console.log(
    `scan_debug decoder=${debugDetector} stream=${video.videoWidth}x${video.videoHeight} ` +
      `canvas=${canvas.width}x${canvas.height} readyState=${video.readyState} ` +
      `frameReady=${frameReady} zoom=${zoom.toFixed(2)}/${zoomTrack ? 'native' : 'digital'} ` +
      `decodes=${debugDecodes} rate=${secs ? (debugDecodes / secs).toFixed(1) : '0'}/s`,
  );
}

let decodeInFlight = false;
let lastDecodeAt = 0;

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
    } catch (err) {
      // An exception here used to kill the rAF loop outright, which looked
      // exactly like "the app does nothing" — keep looping, but leave a trace.
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
