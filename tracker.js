firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const statusEl = document.getElementById('status');
const idEl = document.getElementById('deviceId');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

let watchId = null;

// Reuse a saved device ID/PIN on this phone, or let the user set one
let deviceId = localStorage.getItem('tracker_device_id') || '';
idEl.value = deviceId;

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function sendLocation(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  let battery = null;
  try {
    if (navigator.getBattery) {
      const b = await navigator.getBattery();
      battery = Math.round(b.level * 100);
    }
  } catch (e) {}

  db.ref('devices/' + deviceId).set({
    lat: latitude,
    lng: longitude,
    accuracy: accuracy,
    battery: battery,
    timestamp: Date.now()
  });

  setStatus(`Sharing location — last update ${new Date().toLocaleTimeString()} (±${Math.round(accuracy)}m)`);
}

function onError(err) {
  setStatus('Error: ' + err.message + ' (make sure location permission is allowed)');
}

startBtn.addEventListener('click', () => {
  deviceId = idEl.value.trim();
  if (!deviceId) {
    setStatus('Enter a device ID/PIN first (make it hard to guess).');
    return;
  }
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

  startBtn.disabled = true;
  stopBtn.disabled = false;
  idEl.disabled = true;
  setStatus('Starting…');
});

stopBtn.addEventListener('click', () => {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  idEl.disabled = false;
  setStatus('Stopped sharing location.');
});
