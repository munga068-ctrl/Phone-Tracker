firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const statusEl = document.getElementById('status');
const idEl = document.getElementById('deviceId');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

let watchId = null;
let heartbeatInterval = null;
let wakeLock = null;
let lastWriteAt = 0;
let lastPosition = null;

// Firebase Realtime Database keys can't contain . # $ [ ] / — strip anything
// outside a safe set so a stray character doesn't silently break the write.
const SAFE_ID_PATTERN = /[^a-zA-Z0-9_-]/g;
function sanitizeDeviceId(raw) {
  return raw.trim().replace(SAFE_ID_PATTERN, '');
}

// Don't hammer Firebase on every GPS callback (which can fire multiple times
// a minute while moving) — write at most once per this interval.
const MIN_WRITE_INTERVAL_MS = 8000;
// Independent of movement, re-send the last known fix on this cadence so
// "last seen" stays fresh even if watchPosition goes quiet (e.g. stationary
// indoors) or a write gets throttled right as sharing starts.
const HEARTBEAT_INTERVAL_MS = 30000;

let deviceId = localStorage.getItem('tracker_device_id') || '';
idEl.value = deviceId;

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function getBatteryLevel() {
  try {
    if (navigator.getBattery) {
      const b = await navigator.getBattery();
      return Math.round(b.level * 100);
    }
  } catch (e) { /* fall through */ }
  return null; // not supported on this browser (e.g. iOS Safari, modern Firefox)
}

async function writeLocation(pos, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastWriteAt < MIN_WRITE_INTERVAL_MS) return;
  lastWriteAt = now;

  const { latitude, longitude, accuracy } = pos.coords;
  const battery = await getBatteryLevel();

  try {
    await db.ref('devices/' + deviceId).set({
      lat: latitude,
      lng: longitude,
      accuracy: accuracy,
      battery: battery, // null if the browser doesn't support the Battery Status API
      timestamp: now
    });
    const batteryText = battery !== null ? ` · 🔋${battery}%` : '';
    setStatus(`Sharing location — last update ${new Date(now).toLocaleTimeString()} (±${Math.round(accuracy)}m)${batteryText}`);
  } catch (err) {
    setStatus('Firebase write failed: ' + err.message);
  }
}

function sendLocation(pos) {
  lastPosition = pos;
  writeLocation(pos);
}

function onError(err) {
  setStatus('Error: ' + err.message + ' (make sure location permission is allowed)');
}

// Best-effort: keep the screen on while sharing so mobile browsers don't
// suspend JS execution the moment the screen locks. This only helps while
// the tab stays in the foreground — see the note in the UI about background
// limitations, which no website can fully work around.
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* e.g. denied, or unsupported — sharing still works, just less reliably */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId !== null && !wakeLock) {
    acquireWakeLock();
  }
});

startBtn.addEventListener('click', () => {
  const cleanId = sanitizeDeviceId(idEl.value);
  if (!cleanId) {
    setStatus('Enter a device ID/PIN first — letters, numbers, "-", and "_" only.');
    return;
  }
  if (cleanId.length < 6) {
    setStatus('Device ID must be at least 6 characters (the database rules require this).');
    return;
  }
  if (cleanId !== idEl.value.trim()) {
    idEl.value = cleanId; // reflect the cleanup so it's obvious what got saved
  }
  deviceId = cleanId;
  localStorage.setItem('tracker_device_id', deviceId);

  if (!navigator.geolocation) {
    setStatus('Geolocation is not supported on this browser.');
    return;
  }

  watchId = navigator.geolocation.watchPosition(sendLocation, onError, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 20000
  });

  heartbeatInterval = setInterval(() => {
    if (lastPosition) writeLocation(lastPosition, { force: true });
  }, HEARTBEAT_INTERVAL_MS);

  acquireWakeLock();

  startBtn.disabled = true;
  stopBtn.disabled = false;
  idEl.disabled = true;
  setStatus('Starting…');
});

stopBtn.addEventListener('click', () => {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (heartbeatInterval !== null) clearInterval(heartbeatInterval);
  watchId = null;
  heartbeatInterval = null;
  lastPosition = null;
  releaseWakeLock();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  idEl.disabled = false;
  setStatus('Stopped sharing location.');
});
