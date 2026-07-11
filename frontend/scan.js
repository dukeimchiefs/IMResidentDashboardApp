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
const canvas = document.getElementById('scan-canvas');

function setMessage(el, text, kind) {
  el.textContent = text;
  el.className = 'message' + (kind ? ` ${kind}` : '');
}

async function checkSession() {
  const res = await fetch(`${API_BASE}/me`, { credentials: 'include' });
  if (!res.ok) {
    loginScreen.classList.remove('hidden');
    scanScreen.classList.add('hidden');
    return;
  }
  const data = await res.json();
  welcomeMessage.textContent = `Signed in as ${data.name}`;
  loginScreen.classList.add('hidden');
  scanScreen.classList.remove('hidden');
}

loginButton.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email) return;
  loginButton.disabled = true;
  try {
    await fetch(`${API_BASE}/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setMessage(loginMessage, 'Check your email for a sign-in link.', 'success');
  } catch {
    setMessage(loginMessage, 'Something went wrong. Try again.', 'error');
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  await fetch(`${API_BASE}/logout`, { credentials: 'include' });
  window.location.reload();
});

let stream = null;
let scanning = false;

async function startScan() {
  setMessage(scanMessage, '', '');
  scanButton.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    requestAnimationFrame(scanFrame);
  } catch {
    setMessage(scanMessage, 'Could not access camera.', 'error');
    scanButton.disabled = false;
  }
}

function stopScan() {
  scanning = false;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  scanButton.disabled = false;
}

function scanFrame() {
  if (!scanning) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if (code && code.data) {
      stopScan();
      submitCheckin(code.data);
      return;
    }
  }
  requestAnimationFrame(scanFrame);
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

scanButton.addEventListener('click', startScan);

checkSession();
