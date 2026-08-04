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
// resolution and let zoom work on those extra pixels. Frames are decoded at
// most MAX_SCAN_WIDTH wide to keep jsQR fast enough for a live preview.
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1080;
const MAX_SCAN_WIDTH = 1280;
// Cameras that expose no zoom capability fall back to cropping the frame.
const MAX_DIGITAL_ZOOM = 4;

// Bump on every scanner change that needs confirming on a handset. Reported in
// the stall readout below, so "is this phone running the new code?" is answered
// by looking at the screen rather than by trusting that a reload took.
const SCAN_BUILD = '2026-08-04g';

// How long to scan with nothing decoded before reporting what the scanner is
// actually doing. Silence reads exactly like a broken app, and every round of
// "it doesn't work" so far has cost a deploy to learn one number. Short enough
// that nobody has to wait for it deliberately; a scan that is going to succeed
// lands well inside it, so a normal check-in still never sees it.
const STALL_REPORT_MS = 4000;

// What the camera actually gave us, as opposed to what was asked for. Every
// browser honours these constraints differently — notably iOS Chrome, which
// routes through its own camera layer rather than Safari's — so a stream that
// came back tiny, or from the front camera despite facingMode 'environment',
// is invisible without reading it back off the track.
let cameraLabel = '';
let cameraFacing = '';
let cameraExactRejected = false;

// How long the native detector may run without a single hit before we give up on
// it and hand the rest of the session to jsQR. Generous enough that a resident
// lining a QR up normally is never demoted off the fast path.
const NATIVE_PROBATION_MS = 6000;
let nativeProbationStart = 0;
let decodeInFlight = false;
let activeDecoder = 'probing';
let scanStartedAt = 0;
let decodeAttempts = 0;
let stallReported = false;

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

// `facingMode: 'environment'` is only a preference — a browser is free to hand
// back the front camera and still be conformant. iOS Chrome reaches the camera
// through its own layer rather than Safari's, and a front-facing stream there
// looks exactly like the failure being chased: preview live, nothing decoded,
// no error, because the code was never in shot.
//
// `exact` turns that from a silent wrong answer into an OverconstrainedError we
// can see. Only that error (or a device with no rear camera at all) falls back
// to the old soft hint — a denied permission must keep propagating so
// cameraErrorMessage() can explain it.
async function openCamera() {
  cameraExactRejected = false;
  const size = { width: { ideal: CAPTURE_WIDTH }, height: { ideal: CAPTURE_HEIGHT } };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { ...size, facingMode: { exact: 'environment' } },
    });
  } catch (err) {
    if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
    console.warn('camera_exact_environment_rejected', err?.name);
    cameraExactRejected = true;
    return navigator.mediaDevices.getUserMedia({ video: { ...size, facingMode: 'environment' } });
  }
}

async function startScan() {
  setMessage(scanMessage, '', '');
  scanButton.disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('unsupported'), { name: 'NotFoundError' });
    }
    stream = await openCamera();
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

    // Read back what we were actually given. track.label names the physical
    // camera on iOS ("Back Camera" / "Front Camera"), which settles the
    // wrong-camera case outright.
    const activeTrack = stream.getVideoTracks()[0];
    const settings = typeof activeTrack?.getSettings === 'function' ? activeTrack.getSettings() : {};
    cameraLabel = activeTrack?.label || 'unnamed';
    cameraFacing = settings.facingMode || 'unreported';
    console.log(
      'camera_started', SCAN_BUILD, cameraLabel, cameraFacing,
      `${settings.width || '?'}x${settings.height || '?'}`,
    );

    scanStartedAt = performance.now();
    decodeAttempts = 0;
    stallReported = false;
    nativeProbationStart = 0;
    decodeInFlight = false;
    scanButton.textContent = 'Stop Camera';
    scanButton.disabled = false;
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

// Draws the current frame into `canvas` and returns the 2d context.
//
// The cap is on WIDTH, deliberately. A previous revision capped the LONG edge
// instead, reasoning that iOS streams landscape 1920x1080 so nothing would
// change there. iPhones stream portrait 1080x1920: the width cap never engaged
// and frames decoded at full resolution, while a long-edge cap scaled them to
// 720x1280 and took a third of the linear resolution off the one platform whose
// only decoder is jsQR. That regression is what stopped iOS scanning at all.
// Do not "fix" this to Math.max without testing on a real iPhone.
function drawScanFrame() {
  // Native zoom already crops in hardware, so only crop here for digital zoom.
  const crop = zoomTrack ? 1 : zoom;
  const sourceWidth = video.videoWidth / crop;
  const sourceHeight = video.videoHeight / crop;
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  const scale = Math.min(1, MAX_SCAN_WIDTH / sourceWidth);

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

// Resolved once per page load: a native BarcodeDetector supporting QR, or null
// meaning "use jsQR". Cached as a promise so the async capability probe runs
// once rather than on every frame. Android Chrome has one and it is an order of
// magnitude faster than jsQR; iOS has none, so an iPhone always takes the jsQR
// path below and nothing here changes its behaviour.
let detectorPromise = null;

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      try {
        if (!('BarcodeDetector' in window)) {
          activeDecoder = 'jsQR (no BarcodeDetector)';
          return null;
        }
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (!formats.includes('qr_code')) {
          activeDecoder = 'jsQR (no qr_code format)';
          return null;
        }
        activeDecoder = 'BarcodeDetector';
        return new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (err) {
        activeDecoder = `jsQR (probe threw ${err?.name})`;
        return null;
      }
    })();
  }
  return detectorPromise;
}

// Hand the rest of the session to jsQR. A working slow decoder beats a fast one
// that silently returns nothing.
function demoteDetector(reason) {
  detectorPromise = Promise.resolve(null);
  activeDecoder = `jsQR (demoted: ${reason})`;
  console.warn('barcode_detector_demoted', reason);
}

async function decodeFrame() {
  const detector = await getDetector();
  if (detector) {
    // Hardware-backed, so hand it the untouched video element unless digital
    // zoom means we owe it a cropped frame.
    const source = !zoomTrack && zoom !== 1 ? (drawScanFrame(), canvas) : video;
    try {
      const codes = await detector.detect(source);
      const hit = codes.find((c) => c.rawValue);
      if (hit) {
        nativeProbationStart = 0; // proved it works; never demote this session
        return hit.rawValue;
      }
      // An empty result is ambiguous — no QR in frame, or a detector that will
      // never return one. Android downloads the Play Services barcode module on
      // demand, and until it lands getSupportedFormats() already advertises
      // qr_code while detect() resolves [] forever without ever throwing. Only
      // elapsed time separates the two cases.
      const nowMs = performance.now();
      if (!nativeProbationStart) nativeProbationStart = nowMs;
      if (nowMs - nativeProbationStart < NATIVE_PROBATION_MS) return null;
      demoteDetector(`no hit in ${Math.round(NATIVE_PROBATION_MS / 1000)}s`);
    } catch (err) {
      // Some Android builds expose BarcodeDetector but throw on detect().
      demoteDetector(`detect() threw ${err?.name}`);
    }
  }

  if (typeof jsQR !== 'function') {
    // jsQR is a CDN script (see index.html). A network that blocks
    // cdn.jsdelivr.net leaves it undefined, and with no usable BarcodeDetector
    // that leaves no decoder at all. Named so the caller can stop and say so
    // rather than throwing a bare ReferenceError every frame forever.
    throw Object.assign(new Error('jsQR unavailable'), { name: 'DecoderUnavailableError' });
  }
  const ctx = drawScanFrame();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height);
  return code && code.data ? code.data : null;
}

async function scanFrame() {
  if (!scanning) return;
  // A live MediaStream is not a buffered file: Chrome on Android commonly holds
  // readyState at HAVE_CURRENT_DATA and never advertises HAVE_ENOUGH_DATA, so
  // the old `=== HAVE_ENOUGH_DATA` check spun this loop forever — preview
  // visible, no frame ever decoded, no error. Decode as soon as there's a frame
  // to decode, and require real dimensions so the first ticks (videoWidth 0)
  // don't hand the decoder a zero-sized buffer.
  const frameReady = video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0;
  // Guarded on in-flight rather than on a clock, so the attempt rate stays what
  // it was when iOS was confirmed working: as fast as decoding allows.
  if (frameReady && !decodeInFlight) {
    decodeInFlight = true;
    try {
      const data = await decodeFrame();
      decodeAttempts += 1;
      // decodeFrame() awaits, so the resident may have hit Stop Camera meanwhile.
      if (!scanning) return;
      if (data) {
        stopScan();
        submitCheckin(data);
        return;
      }
      reportStall();
    } catch (err) {
      if (err?.name === 'DecoderUnavailableError') {
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
      console.error('decode_failed', err?.name, err?.message);
    } finally {
      decodeInFlight = false;
    }
  }
  if (scanning) requestAnimationFrame(scanFrame);
}

// After STALL_REPORT_MS of decoding nothing, say so and show what the camera
// handed back. Shown once per scan and only in a state that has already failed,
// so a normal check-in never sees it. The technical line is what turns "it
// doesn't work" into something actionable without wiring the phone to a laptop.
function reportStall() {
  if (stallReported || !scanStartedAt) return;
  const elapsed = performance.now() - scanStartedAt;
  if (elapsed < STALL_REPORT_MS) return;
  stallReported = true;

  setMessage(
    scanMessage,
    'Still looking for a code — move closer, hold steady, and keep the whole square in frame.',
    ''
  );
  // Luminance spread over the frame just decoded. A camera that is running but
  // handing back black or washed-out frames decodes nothing and looks identical
  // on screen to a code that simply cannot be read; a real QR in shot spans
  // nearly the full range, so a collapsed spread separates the two.
  let spread = 'n/a';
  try {
    const d = canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255;
    let max = 0;
    for (let i = 0; i < d.length; i += 4 * 97) { // sparse stride; this runs once
      const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    spread = `${Math.round(max - min)}`;
  } catch { /* tainted or zero-sized canvas — leave as n/a */ }

  const detail = document.createElement('div');
  detail.style.cssText = 'margin-top:.4rem;font:11px/1.4 ui-monospace,monospace;opacity:.6';
  detail.textContent =
    `${SCAN_BUILD} · ${activeDecoder} · ${cameraLabel} (${cameraFacing}${cameraExactRejected ? ', soft' : ''}) · ` +
    `${video.videoWidth}x${video.videoHeight} → ${canvas.width}x${canvas.height} · ` +
    `spread ${spread} · ${(decodeAttempts / (elapsed / 1000)).toFixed(1)}/s`;
  scanMessage.appendChild(detail);
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
