'use strict';

const API = 'https://api.transitous.org/api';
const COPENHAGEN = [55.6761, 12.5683];
const SAMPLE_STEP_M = 30; // route geometry is resampled at this spacing before zone lookup
const BORDER_M = 200; // less travel than this inside a zone = only touched (border station / edge graze)
const LABEL_MIN_ZOOM = 10;

const ZONE_STYLE = { color: '#1f2a33', weight: 1.6, opacity: 0.75, fillColor: '#1f2a33', fillOpacity: 0.04 };
const ZONE_HIT_STYLE = { color: '#0f5f59', weight: 2.5, opacity: 0.95, fillColor: '#14b8a6', fillOpacity: 0.22 };
const ZONE_PICK_STYLE = { color: '#0f5f59', weight: 4, opacity: 1, fillColor: '#14b8a6', fillOpacity: 0.4 };

// The routing feed has no route colours; use the official Copenhagen ones.
const LINE_COLORS = {
  SUBURBAN: { A: '#0094d9', B: '#4cb848', BX: '#8fc73e', C: '#f39200', E: '#7671b3', F: '#ffc20e', H: '#e2001a' },
  SUBWAY: { M1: '#00814a', M2: '#ffc600', M3: '#e5011c', M4: '#0098d4' },
};
const MODE_COLORS = {
  BUS: '#e8a200', COACH: '#e8a200', TRAM: '#5b6770', FERRY: '#1f6fb2', SUBWAY: '#00814a', SUBURBAN: '#b41730',
};
const DARK_TEXT = new Set(['#ffc20e', '#ffc600', '#e8a200', '#8fc73e']);

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' });

// ---------- map ----------

const map = L.map('map', { zoomControl: false }).setView(COPENHAGEN, 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  opacity: 0.7, // faded over the light container background; much cheaper than a CSS filter while panning
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    + ' · Routing <a href="https://transitous.org">Transitous</a>',
}).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const endpointLayer = L.layerGroup().addTo(map);

// ---------- zones ----------

/** @type {{id:string, short:string, name:string, ring:number[][], bbox:number[], layer:L.Polygon, label:L.Marker}[]} */
const zones = [];
const zoneById = new Map();
// Own pane below the default overlay pane, so zones stay under routes no matter when they're (re)mounted.
map.createPane('zones').style.zIndex = 350;
const zoneLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);
let highlighted = new Set(); // zones on the selected route
let picked = null; // zone id the user clicked

const zonesReady = fetch('data/zones.geojson')
  .then((r) => {
    if (!r.ok) throw new Error(`zones.geojson: HTTP ${r.status}`);
    return r.json();
  })
  .then((gj) => {
    L.geoJSON(gj, {
      pane: 'zones',
      style: ZONE_STYLE,
      onEachFeature(feature, layer) {
        const p = feature.properties;
        const ring = feature.geometry.coordinates[0];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        const zone = {
          id: p.id, short: p.short, name: p.name, ring, bbox: [minX, minY, maxX, maxY], layer,
          bounds: L.latLngBounds([minY, minX], [maxY, maxX]),
          label: L.marker(p.center, { icon: labelIcon(p.short, false), interactive: false, keyboard: false }),
        };
        zones.push(zone);
        zoneById.set(zone.id, zone);
        layer.on('click', (e) => {
          L.DomEvent.stopPropagation(e); // keep the map's click handler from clearing it again
          pickZone(picked === zone.id ? null : zone.id);
        });
      },
    });
    updateZonesInView();
  });

function labelIcon(text, hit) {
  // Zero-size icon; the inner span centres itself on the point via CSS so labels can size to their text.
  return L.divIcon({ className: hit ? 'zone-label hit' : 'zone-label', html: `<span>${escapeHtml(text)}</span>`, iconSize: [0, 0] });
}

/**
 * Mount only zones and labels near the viewport. Leaflet re-projects every mounted polygon on each zoom and
 * repositions every mounted marker on each zoom frame; with all 948 zones that stalled the page ~100 ms per zoom.
 */
function updateZonesInView() {
  const showLabels = map.getZoom() >= LABEL_MIN_ZOOM;
  const view = map.getBounds().pad(0.5);
  for (const z of zones) {
    toggle(zoneLayer, z.layer, view.intersects(z.bounds));
    toggle(labelLayer, z.label, showLabels && view.contains(z.label.getLatLng()));
  }
}
map.on('moveend', updateZonesInView);

function toggle(group, layer, want) {
  if (want === group.hasLayer(layer)) return;
  if (want) group.addLayer(layer);
  else group.removeLayer(layer);
}

function highlightZones(ids) {
  const before = highlighted;
  highlighted = new Set(ids);
  for (const id of new Set([...before, ...highlighted])) restyleZone(id);
}

/** Click a zone to highlight it; click it again or anywhere off-zone to clear. */
function pickZone(id) {
  const before = picked;
  picked = id;
  if (before) restyleZone(before);
  if (picked) restyleZone(picked);
}
map.on('click', () => pickZone(null));

function restyleZone(id) {
  const z = zoneById.get(id);
  const isPicked = id === picked;
  const onRoute = highlighted.has(id);
  z.layer.setStyle(isPicked ? ZONE_PICK_STYLE : onRoute ? ZONE_HIT_STYLE : ZONE_STYLE);
  z.label.setIcon(labelIcon(z.short, isPicked || onRoute));
}

function insideRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function zoneContains(z, lat, lon) {
  const [minX, minY, maxX, maxY] = z.bbox;
  return lon >= minX && lon <= maxX && lat >= minY && lat <= maxY && insideRing(lon, lat, z.ring);
}

function zoneAt(lat, lon, hint) {
  if (hint && zoneContains(hint, lat, lon)) return hint;
  for (const z of zones) if (zoneContains(z, lat, lon)) return z;
  return null;
}

/**
 * Zones crossed by a polyline ([lat, lon][]), in travel order, mapped to metres travelled inside each.
 * A zone with (near) zero metres is only touched at a stop, e.g. a border station such as Hellerup (2/30).
 */
function zonesAlong(coords) {
  const metres = new Map();
  let current = null;
  const visit = (lat, lon, m) => {
    current = zoneAt(lat, lon, current);
    if (current) metres.set(current.id, (metres.get(current.id) ?? 0) + m);
  };
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lon1] = coords[i - 1];
    const [lat2, lon2] = coords[i];
    const d = distanceM(lat1, lon1, lat2, lon2);
    const steps = Math.max(1, Math.ceil(d / SAMPLE_STEP_M));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      visit(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t, d / steps);
    }
  }
  if (coords.length) visit(...coords[coords.length - 1], 0);
  return metres;
}

function distanceM(lat1, lon1, lat2, lon2) {
  const kx = 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot((lat2 - lat1) * 110540, (lon2 - lon1) * kx);
}

// ---------- search fields ----------

async function geocode(text) {
  const params = new URLSearchParams({
    text, language: 'da', place: COPENHAGEN.join(','), placeBias: '3',
  });
  const r = await fetch(`${API}/v1/geocode?${params}`);
  if (!r.ok) throw new Error(`Place search failed (HTTP ${r.status})`);
  const results = await r.json();
  return results
    .filter((x) => x.country === 'DK' || x.country === 'SE')
    .slice(0, 6)
    .map((x) => ({
      name: x.name,
      lat: x.lat,
      lon: x.lon,
      id: x.id,
      type: x.type,
      area: (x.areas || []).find((a) => a.default)?.name ?? '',
    }));
}

const TYPE_LABEL = { STOP: 'Stop', ADDRESS: 'Address', PLACE: 'Place' };

function setupField(input, color) {
  const list = input.parentElement.querySelector('.suggest');
  let place = null;
  let items = [];
  let active = -1;
  let timer = 0;
  let seq = 0;
  let marker = null;

  function render(next) {
    items = next;
    active = -1;
    list.replaceChildren(...items.map((item, i) => {
      const li = el('li', { role: 'option' }, item.name, el('small', {}, [TYPE_LABEL[item.type] ?? item.type, item.area].filter(Boolean).join(' · ')));
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus so blur doesn't close the list first
        choose(items[i]);
      });
      return li;
    }));
  }

  function setActive(i) {
    active = (i + items.length) % items.length;
    [...list.children].forEach((li, k) => li.classList.toggle('active', k === active));
  }

  function choose(item) {
    set(item);
    render([]);
    clearTimeout(timer);
    seq++;
  }

  function set(item) {
    place = item;
    input.value = item ? item.name : '';
    if (marker) endpointLayer.removeLayer(marker);
    marker = item
      ? L.circleMarker([item.lat, item.lon], { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 })
        .bindTooltip(item.name).addTo(endpointLayer)
      : null;
  }

  input.addEventListener('input', () => {
    place = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      seq++;
      render([]);
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const found = await geocode(q);
        if (mine === seq) render(found);
      } catch (err) {
        if (mine === seq) showStatus(err.message, true);
      }
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') render([]);
  });
  input.addEventListener('blur', () => render([]));

  return {
    get place() { return place; },
    set,
    /** The chosen place, or the best geocoder match for the typed text. */
    async resolve(what) {
      if (place) return place;
      const q = input.value.trim();
      if (!q) throw new Error(`Enter a ${what}.`);
      const [best] = await geocode(q);
      if (!best) throw new Error(`No place found for “${q}”.`);
      choose(best);
      return best;
    },
  };
}

const fromField = setupField(document.getElementById('from'), getComputedStyle(document.documentElement).getPropertyValue('--from').trim());
const toField = setupField(document.getElementById('to'), getComputedStyle(document.documentElement).getPropertyValue('--to').trim());

document.getElementById('swap').addEventListener('click', () => {
  const a = fromField.place;
  const b = toField.place;
  const aText = document.getElementById('from').value;
  const bText = document.getElementById('to').value;
  fromField.set(b);
  toField.set(a);
  if (!b) document.getElementById('from').value = bText;
  if (!a) document.getElementById('to').value = aText;
});

// ---------- routing ----------

function placeParam(p) {
  return p.type === 'STOP' ? p.id : `${p.lat},${p.lon}`;
}

async function planTrips(from, to) {
  const params = new URLSearchParams({ fromPlace: placeParam(from), toPlace: placeParam(to), numItineraries: '6' });
  const r = await fetch(`${API}/v5/plan?${params}`);
  if (!r.ok) throw new Error(`Route search failed (HTTP ${r.status}).`);
  return r.json();
}

function decodePolyline(str, precision) {
  const factor = 10 ** precision;
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let result = 0, scale = 1, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result += (b & 0x1f) * scale;
        scale *= 32;
      } while (b >= 0x20);
      const delta = result % 2 ? -(result + 1) / 2 : result / 2;
      if (k === 0) lat += delta; else lon += delta;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

function legCoords(leg) {
  if (leg.legGeometry?.points) return decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6);
  return [leg.from, ...(leg.intermediateStops || []), leg.to].map((s) => [s.lat, s.lon]);
}

function analyse(itinerary) {
  const legs = itinerary.legs.map((leg) => {
    const coords = legCoords(leg);
    const transit = Boolean(leg.tripId);
    const metres = transit ? zonesAlong(coords) : new Map();
    return { leg, coords, transit, metres, zones: zoneList(metres) };
  });
  const total = new Map();
  for (const l of legs) for (const [id, m] of l.metres) total.set(id, (total.get(id) ?? 0) + m);
  return { itinerary, legs, zones: zoneList(total) };
}

function zoneList(metres) {
  return [...metres].map(([id, m]) => ({ id, border: m < BORDER_M }));
}

function lineColor(leg) {
  const name = (leg.displayName || leg.routeShortName || '').toUpperCase();
  return LINE_COLORS[leg.mode]?.[name] ?? MODE_COLORS[leg.mode] ?? '#b41730';
}

function lineBadge(leg) {
  const bg = lineColor(leg);
  return el('span', { className: 'line', style: `background:${bg};color:${DARK_TEXT.has(bg) ? '#222' : '#fff'}` },
    leg.displayName || leg.routeShortName || leg.mode);
}

function zoneChip({ id, border }) {
  const z = zoneById.get(id);
  const title = border
    ? `${z.name}: the route only touches this zone (< ${BORDER_M} m), e.g. a border station like Hellerup (2/30)`
    : z.name;
  return el('span', { className: border ? 'zone border' : 'zone', title }, z.short);
}

const ZONE_PREVIEW = 3; // chips kept at each end of a collapsed zone list

/** Zone chips, optionally joined by arrows; long lists collapse to "first … +N … last" and toggle on click. */
function zoneSequence(list, arrows) {
  const join = (chips) => (arrows ? chips.flatMap((c, i) => (i ? [' → ', c] : [c])) : chips);
  if (list.length <= ZONE_PREVIEW * 2 + 2) return join(list.map(zoneChip));
  const seq = el('span', { className: 'zone-seq' });
  const toggleButton = (label, title, expand) => {
    const b = el('button', { type: 'button', className: 'zone more', title }, label);
    b.addEventListener('click', (e) => {
      e.stopPropagation(); // don't (re)select the trip card
      render(expand);
    });
    return b;
  };
  const render = (expanded) => seq.replaceChildren(...(expanded
    ? [...join(list.map(zoneChip)), ' ', toggleButton('less', 'Collapse zones', false)]
    : join([
      ...list.slice(0, ZONE_PREVIEW).map(zoneChip),
      toggleButton(`+${list.length - ZONE_PREVIEW * 2}`, 'Show all zones', true),
      ...list.slice(-ZONE_PREVIEW).map(zoneChip),
    ])));
  render(false);
  return [seq];
}

function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function renderTrips(trips) {
  const list = document.getElementById('results');
  const items = trips.map((trip, index) => {
    const { itinerary: it, legs, zones: tripZones } = trip;
    const transitLegs = legs.filter((l) => l.transit);
    const changes = it.transfers === 1 ? '1 change' : `${it.transfers} changes`;

    const lines = el('div', { className: 'lines' });
    transitLegs.forEach((l, i) => {
      if (i) lines.append('›');
      lines.append(lineBadge(l.leg));
    });
    if (!transitLegs.length) lines.append('Walk only');

    const counted = tripZones.filter((z) => !z.border);
    const touched = tripZones.filter((z) => z.border);
    const zoneRow = el('div', { className: 'zones' },
      counted.length === 1 ? '1 zone:' : `${counted.length} zones:`, ...zoneSequence(counted, false));
    if (touched.length) zoneRow.append(' · border:', ...zoneSequence(touched, false));

    const legList = el('ul', { className: 'legs' }, ...transitLegs.map((l) => el('li', {},
      lineBadge(l.leg), ` ${l.leg.from.name} → ${l.leg.to.name}`,
      el('div', { className: 'stops' },
        `${timeFmt.format(new Date(l.leg.startTime))}–${timeFmt.format(new Date(l.leg.endTime))} · zones `,
        ...zoneSequence(l.zones, true)))));

    const li = el('li', { className: 'trip' },
      el('div', { className: 'trip-head' },
        el('span', {}, `${timeFmt.format(new Date(it.startTime))} – ${timeFmt.format(new Date(it.endTime))}`),
        el('span', {}, `${formatDuration(it.duration)} · ${changes}`)),
      lines, zoneRow, legList);
    li.addEventListener('click', () => selectTrip(trips, index));
    return li;
  });
  list.replaceChildren(...items);
}

function selectTrip(trips, index) {
  [...document.getElementById('results').children].forEach((li, i) => li.classList.toggle('selected', i === index));
  const trip = trips[index];
  routeLayer.clearLayers();
  const bounds = L.latLngBounds([]);
  for (const l of trip.legs) {
    if (!l.coords.length) continue;
    bounds.extend(l.coords);
    if (l.transit) {
      L.polyline(l.coords, { color: '#fff', weight: 9, opacity: 0.9 }).addTo(routeLayer);
      L.polyline(l.coords, { color: lineColor(l.leg), weight: 5 })
        .bindTooltip(`${l.leg.displayName || l.leg.mode}: ${l.leg.from.name} → ${l.leg.to.name}`, { sticky: true })
        .addTo(routeLayer);
      for (const stop of [l.leg.from, l.leg.to]) {
        L.circleMarker([stop.lat, stop.lon], { radius: 5, color: '#222', weight: 2, fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(stop.name).addTo(routeLayer);
      }
    } else {
      L.polyline(l.coords, { color: '#555', weight: 4, dashArray: '2 8', lineCap: 'round' }).addTo(routeLayer);
    }
  }
  highlightZones(trip.zones.filter((z) => !z.border).map((z) => z.id));
  if (bounds.isValid()) {
    const panel = document.getElementById('panel');
    const wide = window.innerWidth > 760;
    const top = wide ? document.getElementById('search').offsetHeight + 30 : panel.offsetHeight + 20;
    map.fitBounds(bounds, { paddingTopLeft: [wide ? 450 : 20, top], paddingBottomRight: [40, 30], maxZoom: 15 });
  }
}

document.getElementById('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = document.getElementById('go');
  go.disabled = true;
  document.getElementById('results').replaceChildren();
  routeLayer.clearLayers();
  highlightZones([]);
  showStatus('Searching…');
  try {
    const [from, to] = await Promise.all([fromField.resolve('start'), toField.resolve('destination')]);
    const [plan] = await Promise.all([planTrips(from, to), zonesReady]);
    const trips = (plan.itineraries || []).map(analyse);
    if (!trips.length) throw new Error('No public transport routes found.');
    showStatus('');
    renderTrips(trips);
    selectTrip(trips, 0);
  } catch (err) {
    showStatus(err.message, true);
  } finally {
    go.disabled = false;
  }
});

// ---------- helpers ----------

function showStatus(text, isError = false) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

zonesReady.catch((err) => showStatus(`Could not load zone map: ${err.message}`, true));
