firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const map = L.map('map').setView([0, 0], 2);

const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
});

// Satellite imagery has no text on its own, so it's paired with a labels
// overlay (place names, roads, borders) that Esri serves specifically to
// sit on top of their imagery — this is the standard "satellite + labels"
// combo, equivalent to what most map apps call "Hybrid" view.
const satelliteImagery = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics', maxZoom: 19 }
);
const satelliteLabels = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, pane: 'shadowPane' } // renders labels above imagery
);
const satelliteLayer = L.layerGroup([satelliteImagery, satelliteLabels]);

streetLayer.addTo(map); // default view
L.control.layers({ 'Street': streetLayer, 'Satellite': satelliteLayer }, {}, { position: 'topright' }).addTo(map);

const markers = {};      // deviceId -> L.marker
const listeners = {};    // deviceId -> firebase ref
const listEl = document.getElementById('deviceList');
const addForm = document.getElementById('addDeviceForm');
const idInput = document.getElementById('newDeviceId');

let myLocationMarker = null;
let routeLine = null;
const myLocationIcon = L.divIcon({
  className: 'my-location-dot',
  iconSize: [16, 16]
});

// Keep in sync with tracker.js — same safe character set for Firebase keys.
const SAFE_ID_PATTERN = /[^a-zA-Z0-9_-]/g;
function sanitizeDeviceId(raw) {
  return raw.trim().replace(SAFE_ID_PATTERN, '');
}

// A device that hasn't reported in this long is probably not actively
// sharing anymore (tab closed, screen locked, etc.) — flag it visually
// rather than implying the pin/marker is current.
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function getSavedDevices() {
  return JSON.parse(localStorage.getItem('watched_devices') || '[]');
}
function saveDevices(list) {
  localStorage.setItem('watched_devices', JSON.stringify(list));
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function renderDeviceRow(deviceId, data) {
  let row = document.getElementById('row-' + deviceId);
  if (!row) {
    row = document.createElement('div');
    row.id = 'row-' + deviceId;
    row.className = 'device-row';
    listEl.appendChild(row);
  }
  if (!data) {
    row.classList.remove('stale');
    row.innerHTML = `<strong>${deviceId}</strong><br><span class="hint">No location yet…</span>
      <button class="remove" data-id="${deviceId}">✕</button>`;
    return;
  }
  const isStale = (Date.now() - data.timestamp) > STALE_THRESHOLD_MS;
  row.classList.toggle('stale', isStale);
  row.innerHTML = `
    <strong>${deviceId}</strong>
    <button class="remove" data-id="${deviceId}">✕</button><br>
    <span class="hint">${isStale ? '⚠️ Not currently sharing — ' : ''}Last seen ${timeAgo(data.timestamp)} · ±${Math.round(data.accuracy)}m
    ${data.battery !== null && data.battery !== undefined ? ' · 🔋' + data.battery + '%' : ''}</span>
    <br><button class="locate" data-id="${deviceId}">Center on map</button>
    <button class="directions" data-id="${deviceId}">🧭 Directions</button>
  `;
}

function clearRoute() {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
}

async function showDirectionsTo(deviceId) {
  const marker = markers[deviceId];
  if (!marker) return;
  const dest = marker.getLatLng();

  // Turn-by-turn navigation is best handled by the phone's own Maps app —
  // this works immediately without needing our own geolocation permission,
  // since Google/Apple Maps fills in "current location" as the starting
  // point on the device that opens the link.
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving`;
  window.open(mapsUrl, '_blank');

  // Best-effort: also sketch the route on this map for a quick visual,
  // using our own location if the browser grants it.
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const origin = [pos.coords.latitude, pos.coords.longitude];
    if (myLocationMarker) {
      myLocationMarker.setLatLng(origin);
    } else {
      myLocationMarker = L.marker(origin, { icon: myLocationIcon }).addTo(map).bindPopup('Your location');
    }
    clearRoute();

    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${origin[1]},${origin[0]};${dest.lng},${dest.lat}?overview=full&geometry=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('routing service unavailable');
      const data = await res.json();
      const route = data.routes && data.routes[0];
      if (!route) throw new Error('no route found');
      const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
      routeLine = L.polyline(coords, { color: '#2f6fed', weight: 4, opacity: 0.85 }).addTo(map);
    } catch (e) {
      // Fall back to a straight "as the crow flies" line if the free
      // routing service is unreachable or can't find a driving route.
      routeLine = L.polyline([origin, [dest.lat, dest.lng]], { color: '#2f6fed', weight: 3, dashArray: '6 6' }).addTo(map);
    }
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
  }, () => {
    // Geolocation denied/unavailable — the external Maps tab we already
    // opened still works fine, so there's nothing more to do here.
  }, { enableHighAccuracy: true, timeout: 15000 });
}

function watchDevice(deviceId) {
  if (listeners[deviceId]) return; // already watching
  renderDeviceRow(deviceId, null);

  const ref = db.ref('devices/' + deviceId);
  listeners[deviceId] = ref;

  ref.on('value', (snap) => {
    const data = snap.val();
    if (!data) return;
    renderDeviceRow(deviceId, data);

    const latlng = [data.lat, data.lng];
    if (markers[deviceId]) {
      markers[deviceId].setLatLng(latlng);
    } else {
      markers[deviceId] = L.marker(latlng).addTo(map).bindPopup(deviceId);
      map.setView(latlng, 15);
    }
    markers[deviceId].setPopupContent(`<strong>${deviceId}</strong><br>${timeAgo(data.timestamp)}`);
  }, (err) => {
    const row = document.getElementById('row-' + deviceId);
    if (row) row.innerHTML = `<strong>${deviceId}</strong><br><span class="hint">Read failed: ${err.message}</span>
      <button class="remove" data-id="${deviceId}">✕</button>`;
  });
}

function removeDevice(deviceId) {
  if (listeners[deviceId]) {
    listeners[deviceId].off();
    delete listeners[deviceId];
  }
  if (markers[deviceId]) {
    map.removeLayer(markers[deviceId]);
    delete markers[deviceId];
  }
  const row = document.getElementById('row-' + deviceId);
  if (row) row.remove();
  saveDevices(getSavedDevices().filter(d => d !== deviceId));
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = sanitizeDeviceId(idInput.value);
  if (!id) return;
  const devices = getSavedDevices();
  if (!devices.includes(id)) {
    devices.push(id);
    saveDevices(devices);
  }
  watchDevice(id);
  idInput.value = '';
});

listEl.addEventListener('click', (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  if (e.target.classList.contains('remove')) removeDevice(id);
  if (e.target.classList.contains('locate') && markers[id]) {
    map.setView(markers[id].getLatLng(), 16);
    markers[id].openPopup();
  }
  if (e.target.classList.contains('directions')) showDirectionsTo(id);
});

// Load previously watched devices on page load
getSavedDevices().forEach(watchDevice);

// "time ago" text and the stale flag both depend on the clock moving
// forward, not just on new Firebase writes — refresh periodically so a
// device that stopped reporting visibly flips to stale without needing a
// fresh value event.
setInterval(() => {
  Object.keys(listeners).forEach(deviceId => {
    listeners[deviceId].once('value', (snap) => renderDeviceRow(deviceId, snap.val()));
  });
}, 15000);
