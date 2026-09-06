firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---- Map styles: two raster-tile style definitions (Street / Satellite).
// Each includes an empty "route" GeoJSON layer up front, because
// map.setStyle() wipes any sources/layers added at runtime — keeping the
// route layer defined in both styles from the start means the Directions
// feature survives switching between Street and Satellite. ----
function emptyRouteFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

function buildStreetStyle() {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap contributors',
        maxzoom: 19
      },
      route: { type: 'geojson', data: emptyRouteFeatureCollection() }
    },
    layers: [
      { id: 'osm-layer', type: 'raster', source: 'osm' },
      { id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2f6fed', 'line-width': 4, 'line-opacity': 0.85 } }
    ]
  };
}

function buildSatelliteStyle() {
  return {
    version: 8,
    sources: {
      esriImagery: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
        maxzoom: 19
      },
      esriLabels: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19
      },
      route: { type: 'geojson', data: emptyRouteFeatureCollection() }
    },
    layers: [
      { id: 'esri-imagery-layer', type: 'raster', source: 'esriImagery' },
      { id: 'esri-labels-layer', type: 'raster', source: 'esriLabels' },
      { id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2f6fed', 'line-width': 4, 'line-opacity': 0.85 } }
    ]
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: buildSatelliteStyle(), // satellite is the default view
  center: [0, 20],
  zoom: 1.3
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');

let currentStyleName = 'satellite';
let lastRouteGeoJSON = null;

// Runs on the initial load AND every time setStyle() swaps the style out —
// both cases fire 'style.load', so this is the one place that needs to
// re-apply the globe projection (a runtime map property, not part of the
// style spec) and restore any in-progress route (which setStyle wipes).
function onStyleLoad() {
  map.setProjection({ type: 'globe' });
  if (lastRouteGeoJSON && map.getSource('route')) {
    map.getSource('route').setData({ type: 'FeatureCollection', features: [lastRouteGeoJSON] });
  }
}
map.on('style.load', onStyleLoad);

function switchStyle(name) {
  if (name === currentStyleName) return;
  currentStyleName = name;
  map.setStyle(name === 'street' ? buildStreetStyle() : buildSatelliteStyle());
}

// MapLibre doesn't ship Leaflet's L.control.layers equivalent, so this is a
// small custom control for the Street/Satellite toggle.
const styleToggle = document.createElement('div');
styleToggle.className = 'style-toggle maplibregl-ctrl';
styleToggle.innerHTML = `
  <button type="button" data-style="street">Street</button>
  <button type="button" data-style="satellite" class="active">Satellite</button>
`;
document.getElementById('map').appendChild(styleToggle);
styleToggle.addEventListener('click', (e) => {
  const name = e.target.dataset.style;
  if (!name) return;
  switchStyle(name);
  styleToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.style === name));
});

const markers = {};      // deviceId -> maplibregl.Marker
const listeners = {};    // deviceId -> firebase ref
const listEl = document.getElementById('deviceList');
const addForm = document.getElementById('addDeviceForm');
const idInput = document.getElementById('newDeviceId');

let myLocationMarker = null;

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
  lastRouteGeoJSON = null;
  const src = map.getSource('route');
  if (src) src.setData(emptyRouteFeatureCollection());
}

function setRoute(coordsLngLat) {
  lastRouteGeoJSON = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coordsLngLat },
    properties: {}
  };
  const src = map.getSource('route');
  if (src) src.setData({ type: 'FeatureCollection', features: [lastRouteGeoJSON] });
}

function boundsFromCoords(coordsLngLat) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  coordsLngLat.forEach(([lng, lat]) => {
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  });
  return [[minLng, minLat], [maxLng, maxLat]];
}

async function showDirectionsTo(deviceId) {
  const marker = markers[deviceId];
  if (!marker) return;
  const dest = marker.getLngLat(); // {lng, lat}

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
    const origin = [pos.coords.longitude, pos.coords.latitude]; // [lng, lat]
    if (myLocationMarker) {
      myLocationMarker.setLngLat(origin);
    } else {
      const el = document.createElement('div');
      el.className = 'my-location-dot';
      myLocationMarker = new maplibregl.Marker({ element: el })
        .setLngLat(origin)
        .setPopup(new maplibregl.Popup().setText('Your location'))
        .addTo(map);
    }

    let coords;
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${origin[0]},${origin[1]};${dest.lng},${dest.lat}?overview=full&geometry=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('routing service unavailable');
      const data = await res.json();
      const route = data.routes && data.routes[0];
      if (!route) throw new Error('no route found');
      coords = route.geometry.coordinates; // OSRM already returns [lng, lat] pairs
    } catch (e) {
      // Fall back to a straight "as the crow flies" line if the free
      // routing service is unreachable or can't find a driving route.
      coords = [origin, [dest.lng, dest.lat]];
    }
    setRoute(coords);
    map.fitBounds(boundsFromCoords(coords), { padding: 60 });
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

    const lngLat = [data.lng, data.lat];
    if (markers[deviceId]) {
      markers[deviceId].setLngLat(lngLat);
    } else {
      const popup = new maplibregl.Popup().setHTML(`<strong>${deviceId}</strong><br>${timeAgo(data.timestamp)}`);
      markers[deviceId] = new maplibregl.Marker().setLngLat(lngLat).setPopup(popup).addTo(map);
      map.flyTo({ center: lngLat, zoom: 15 });
    }
    markers[deviceId].getPopup().setHTML(`<strong>${deviceId}</strong><br>${timeAgo(data.timestamp)}`);
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
    markers[deviceId].remove();
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
    map.flyTo({ center: markers[id].getLngLat(), zoom: 16 });
    const popup = markers[id].getPopup();
    if (popup && !popup.isOpen()) markers[id].togglePopup();
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
