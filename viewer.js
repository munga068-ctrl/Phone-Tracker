import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.7.0/dist/maplibre-gl.mjs';

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Firebase's ".info/connected" is a special path the SDK maintains locally —
// it reflects the actual realtime socket state, not just "did a fetch
// succeed once", so this genuinely shows whether device updates are live.
const connectionStatusEl = document.getElementById('connectionStatus');
db.ref('.info/connected').on('value', (snap) => {
  const online = snap.val() === true;
  connectionStatusEl.classList.toggle('online', online);
  connectionStatusEl.classList.toggle('offline', !online);
  connectionStatusEl.querySelector('.label').textContent = online ? 'Live' : 'Offline';
  connectionStatusEl.title = online
    ? 'Connected to Firebase — device locations update in real time.'
    : 'Not connected — locations shown may be out of date.';
});

const COUNTRIES_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_110m_admin_0_countries.geojson';

// ---- Map styles ----
// Each style includes an empty "route" GeoJSON layer up front, because
// map.setStyle() wipes any sources/layers added at runtime — keeping the
// route layer defined in every style from the start means the Directions
// feature survives switching styles.
function emptyRouteFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}
function routeLineLayer() {
  return {
    id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#2f6fed', 'line-width': 4, 'line-opacity': 0.85 }
  };
}

// One shared source holds every watched device's recent-path trail as a
// separate LineString feature (rather than one source/layer per device) —
// simpler to keep in sync, and plenty for the handful of phones a personal
// tracker realistically watches at once.
function emptyTrailsFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}
function trailsLineLayer() {
  return {
    id: 'trails-line', type: 'line', source: 'trails',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#a78bfa', 'line-width': 3, 'line-opacity': 0.65, 'line-dasharray': [2, 1.5] }
  };
}

// A single polygon covering the whole sphere's surface, used as the ocean
// fill underneath the country polygons. There's deliberately no separate
// "background" style layer — that would also paint the empty space around
// the globe solid, hiding the starfield behind it. Leaving that area
// untouched lets the transparent map canvas show the page's own starfield
// background through, while the globe itself still reads as solid (ocean +
// countries) since this polygon covers every bit of its surface.
function oceanFeature() {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]] }
  };
}

// Natural Earth's MAPCOLOR9 property is pre-computed graph coloring — it
// guarantees no two neighboring countries ever share the same color, which
// is exactly what gives a political map that clean, distinct-region look.
const COUNTRY_COLOR_PALETTE = {
  1: '#e0575b', 2: '#3fa9f5', 3: '#3ecf8e', 4: '#f5a623', 5: '#a56ce2',
  6: '#f2d94e', 7: '#4ecdc4', 8: '#ff8fa3', 9: '#7fd1e0'
};

function buildGlobeStyle(countriesGeoJSON) {
  return {
    version: 8,
    // Setting this directly in the style (matching MapLibre's own official
    // globe examples) is more robust than only calling setProjection() at
    // runtime — some versions/contexts don't reliably pick up a
    // runtime-only call.
    projection: { type: 'globe' },
    sources: {
      ocean: { type: 'geojson', data: oceanFeature() },
      countries: { type: 'geojson', data: countriesGeoJSON || { type: 'FeatureCollection', features: [] } },
      route: { type: 'geojson', data: emptyRouteFeatureCollection() },
      trails: { type: 'geojson', data: emptyTrailsFeatureCollection() }
    },
    layers: [
      { id: 'ocean-fill', type: 'fill', source: 'ocean', paint: { 'fill-color': '#050912' } },
      {
        id: 'countries-fill', type: 'fill', source: 'countries',
        paint: {
          'fill-color': [
            'match', ['get', 'MAPCOLOR9'],
            1, COUNTRY_COLOR_PALETTE[1], 2, COUNTRY_COLOR_PALETTE[2], 3, COUNTRY_COLOR_PALETTE[3],
            4, COUNTRY_COLOR_PALETTE[4], 5, COUNTRY_COLOR_PALETTE[5], 6, COUNTRY_COLOR_PALETTE[6],
            7, COUNTRY_COLOR_PALETTE[7], 8, COUNTRY_COLOR_PALETTE[8], 9, COUNTRY_COLOR_PALETTE[9],
            '#8a8a8a'
          ],
          'fill-opacity': 0.95
        }
      },
      { id: 'countries-outline', type: 'line', source: 'countries', paint: { 'line-color': '#050912', 'line-width': 0.6 } },
      trailsLineLayer(),
      routeLineLayer()
    ],
    sky: {
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]
    },
    light: { anchor: 'map', position: [1.5, 90, 80] }
  };
}

function buildStreetStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
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
      route: { type: 'geojson', data: emptyRouteFeatureCollection() },
      trails: { type: 'geojson', data: emptyTrailsFeatureCollection() }
    },
    layers: [
      { id: 'osm-layer', type: 'raster', source: 'osm' },
      trailsLineLayer(),
      routeLineLayer()
    ]
  };
}

function buildSatelliteStyle() {
  return {
    version: 8,
    projection: { type: 'globe' },
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
      route: { type: 'geojson', data: emptyRouteFeatureCollection() },
      trails: { type: 'geojson', data: emptyTrailsFeatureCollection() }
    },
    layers: [
      { id: 'esri-imagery-layer', type: 'raster', source: 'esriImagery' },
      { id: 'esri-labels-layer', type: 'raster', source: 'esriLabels' },
      trailsLineLayer(),
      routeLineLayer()
    ]
  };
}

const markers = {};      // deviceId -> maplibregl.Marker
const listeners = {};    // deviceId -> firebase ref (current location)
const historyListeners = {}; // deviceId -> firebase ref (history ring buffer)
const deviceHistories = {};  // deviceId -> array of {lat, lng, timestamp}, sorted oldest-first
const listEl = document.getElementById('deviceList');
const addForm = document.getElementById('addDeviceForm');
const idInput = document.getElementById('newDeviceId');

let myLocationMarker = null;
let map = null;
let currentStyleName = 'world';
let lastRouteGeoJSON = null;
let countriesGeoJSON = null;

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

function rebuildTrailsGeoJSON() {
  const features = Object.keys(deviceHistories)
    .map(deviceId => {
      const points = deviceHistories[deviceId];
      if (!points || points.length < 2) return null; // a line needs 2+ points
      return {
        type: 'Feature',
        properties: { deviceId },
        geometry: {
          type: 'LineString',
          coordinates: points.map(p => [p.lng, p.lat])
        }
      };
    })
    .filter(Boolean);
  return { type: 'FeatureCollection', features };
}

function applyTrailsToMap() {
  const src = map.getSource('trails');
  if (src) src.setData(rebuildTrailsGeoJSON());
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

  // Recent-path trail — a ring buffer of up to 30 points (~1 hour), written
  // by tracker.js/the app's background task alongside each location update.
  const historyRef = db.ref('deviceHistory/' + deviceId);
  historyListeners[deviceId] = historyRef;
  historyRef.on('value', (snap) => {
    const data = snap.val();
    const points = data
      ? Object.values(data).sort((a, b) => a.timestamp - b.timestamp)
      : [];
    deviceHistories[deviceId] = points;
    applyTrailsToMap();
  }, (err) => {
    console.error('deviceHistory read failed for', deviceId, ':', err);
  });
}

function removeDevice(deviceId) {
  if (listeners[deviceId]) {
    listeners[deviceId].off();
    delete listeners[deviceId];
  }
  if (historyListeners[deviceId]) {
    historyListeners[deviceId].off();
    delete historyListeners[deviceId];
  }
  delete deviceHistories[deviceId];
  applyTrailsToMap();
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

function styleForName(name) {
  if (name === 'street') return buildStreetStyle();
  if (name === 'satellite') return buildSatelliteStyle();
  return buildGlobeStyle(countriesGeoJSON);
}

function switchStyle(name) {
  if (name === currentStyleName) return;
  currentStyleName = name;
  map.setStyle(styleForName(name));
}

async function init() {
  try {
    const res = await fetch(COUNTRIES_URL);
    countriesGeoJSON = await res.json();
  } catch (e) {
    // Falls back to an empty countries layer (just the dark ocean sphere)
    // if the CDN is unreachable — the globe still renders, just without
    // the colored country fills, and Street/Satellite are unaffected.
    countriesGeoJSON = { type: 'FeatureCollection', features: [] };
  }

  map = new maplibregl.Map({
    container: 'map',
    style: buildGlobeStyle(countriesGeoJSON), // colorful political globe is the default view
    center: [0, 20],
    zoom: 1.3,
    // MapLibre renders at devicePixelRatio by default for crisp vector
    // content, but our raster sources (OSM Street, Esri Satellite) have no
    // @2x/retina variant — at DPR > 1 that just stretches their native
    // 256px tiles across more physical pixels, blurring everything baked
    // into them, place-name text included. Forcing 1 keeps raster tiles at
    // their native sharp resolution; it has no real downside here since the
    // World style's fills/lines don't rely on crisp hi-DPI vector text.
    pixelRatio: 1
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  // Runs on the initial load AND every time setStyle() swaps the style out —
  // both cases fire 'style.load', so this is the one place that needs to
  // re-apply the globe projection (a runtime map property, not part of the
  // style spec) and restore any in-progress route (which setStyle wipes).
  map.on('style.load', () => {
    map.setProjection({ type: 'globe' });
    if (lastRouteGeoJSON && map.getSource('route')) {
      map.getSource('route').setData({ type: 'FeatureCollection', features: [lastRouteGeoJSON] });
    }
    applyTrailsToMap();
  });

  // MapLibre doesn't ship Leaflet's L.control.layers equivalent, so this is
  // a small custom control for switching map styles.
  const styleToggle = document.createElement('div');
  styleToggle.className = 'style-toggle maplibregl-ctrl';
  styleToggle.innerHTML = `
    <button type="button" data-style="world" class="active">World</button>
    <button type="button" data-style="street">Street</button>
    <button type="button" data-style="satellite">Satellite</button>
  `;
  document.getElementById('map').appendChild(styleToggle);
  styleToggle.addEventListener('click', (e) => {
    const name = e.target.dataset.style;
    if (!name) return;
    switchStyle(name);
    styleToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.style === name));
  });

  // Load previously watched devices now that the map exists
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
}

init();
