'use strict';

const COPENHAGEN = [55.6761, 12.5683];
const LABEL_MIN_ZOOM = 10;
const NUM_TRIPS = 6;

const ZONE_STYLE = { color: '#1f2a33', weight: 1.6, opacity: 0.75, fillColor: '#1f2a33', fillOpacity: 0.04 };
const ZONE_HIT_STYLE = { color: '#0f5f59', weight: 2.5, opacity: 0.95, fillColor: '#14b8a6', fillOpacity: 0.22 };
const ZONE_PICK_STYLE = { color: '#0f5f59', weight: 4, opacity: 1, fillColor: '#14b8a6', fillOpacity: 0.4 };

// ---------- map ----------

const map = L.map('map', { zoomControl: false }).setView(COPENHAGEN, 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  opacity: 0.7, // faded over the light container background; much cheaper than a CSS filter while panning
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const endpointLayer = L.layerGroup().addTo(map);

// ---------- zones ----------

/** @type {{id:string, short:string, name:string, bounds:L.LatLngBounds, layer:L.Polygon, label:L.Marker}[]} */
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
        const zone = {
          id: p.id, short: p.short, name: p.name, layer,
          bounds: layer.getBounds(),
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
  highlighted = new Set(ids.filter((id) => zoneById.has(id)));
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

// ---------- Rejseplanen (HAFAS mgate, the same endpoint and client id as the rejseplanen.dk web app) ----------

const RP_URL = 'https://rejseplanen.dk/bin/iphone.exe';
const RP_BASE = {
  ver: '1.24',
  lang: 'dan',
  auth: { type: 'AID', aid: 'j1sa92pcj72ksh0-web' },
  client: { id: 'DK', type: 'WEB', name: 'rejseplanwebapp', l: 'vs_webapp', v: '1.0.5' },
  formatted: false,
  ext: 'DK.11',
};
const RP_NO_TRIPS = new Set(['H890', 'H891', 'H892', 'H895', 'H899', 'H9220', 'H9240', 'H9360', 'H9380']);
let rpRequestSeq = 0;

async function rp(meth, req) {
  const r = await fetch(RP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...RP_BASE, id: `zonemap${++rpRequestSeq}`, svcReqL: [{ meth, id: '1|1|', req }] }),
  });
  if (!r.ok) throw new Error(`Rejseplanen: HTTP ${r.status}`);
  const data = await r.json();
  const svc = data.svcResL?.[0];
  if (data.err !== 'OK' || svc?.err !== 'OK') {
    const code = svc?.err ?? data.err;
    throw Object.assign(new Error(`Rejseplanen ${meth} failed: ${svc?.errTxt || code}`), { code });
  }
  return svc.res;
}

async function searchPlaces(text) {
  const res = await rp('LocMatch', {
    input: { field: 'S', loc: { name: `${text}?`, type: 'ALL', dist: 1000 }, maxLoc: 7 },
  });
  return (res.match?.locL ?? [])
    .filter((l) => l.crd)
    .map((l) => ({ name: l.name, type: l.type, lid: l.lid, lat: l.crd.y / 1e6, lon: l.crd.x / 1e6 }));
}

/** Current date/time in Copenhagen as HAFAS wants it ("YYYYMMDD", "HHMMSS"), whatever the device timezone. */
function copenhagenNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}${parts.month}${parts.day}`, time: `${parts.hour}${parts.minute}${parts.second}` };
}

async function searchTrips(from, to) {
  const now = copenhagenNow();
  let res;
  try {
    res = await rp('TripSearch', {
      depLocL: [{ lid: from.lid, type: from.type, name: from.name }],
      arrLocL: [{ lid: to.lid, type: to.type, name: to.name }],
      outFrwd: true,
      outDate: now.date,
      outTime: now.time,
      jnyFltrL: [
        { type: 'GROUP', mode: 'INC', value: 'RQ_WALK_OEV' },
        { type: 'PROD', mode: 'INC', value: 4095 },
      ],
      getPolyline: true,
      getPasslist: true,
      numF: NUM_TRIPS,
    });
  } catch (err) {
    if (RP_NO_TRIPS.has(err.code)) return [];
    throw err;
  }
  return (res.outConL ?? []).map((con) => parseTrip(con, res.common));
}

/**
 * Zones the commuter card (pendlerkort) for this exact trip must cover, from Rejseplanen's fare engine.
 * TripSearch never includes fares, so each trip is reconstructed with a tariff request.
 */
async function fetchTripZones(ctxRecon) {
  const res = await rp('Reconstruction', {
    outReconL: [{ ctx: ctxRecon }],
    getPasslist: false,
    getPolyline: false,
    getTariff: true,
    trfReq: { tvlrProfData: '{}' },
  });
  let fallback = null;
  for (const fareSet of res.outConL?.[0]?.trfRes?.fareSetL ?? []) {
    for (const fare of fareSet.fareL ?? []) {
      let info;
      try { info = JSON.parse(fare.addData ?? '{}'); } catch { continue; }
      if (!Array.isArray(info.vz)) continue;
      const zoneIds = info.vz.map(String);
      if (info.trf === 'SP' && info.zn) return zoneIds; // SP = season pass, i.e. the commuter card
      fallback ??= zoneIds;
    }
  }
  return fallback ?? [];
}

function parseTrip(con, common) {
  const locs = common.locL ?? [];
  const prods = common.prodL ?? [];
  const polys = common.polyL ?? [];
  const icons = common.icoL ?? [];
  const point = (locX) => {
    const l = locs[locX];
    return { name: l.name, lat: l.crd.y / 1e6, lon: l.crd.x / 1e6 };
  };
  const legs = (con.secL ?? []).filter((sec) => sec.dep && sec.arr).map((sec) => {
    const from = point(sec.dep.locX);
    const to = point(sec.arr.locX);
    const transit = Boolean(sec.jny);
    const polyXL = transit ? sec.jny.polyG?.polyXL : sec.gis?.polyG?.polyXL;
    const coords = (polyXL ?? []).flatMap((i) => (polys[i]?.crdEncYX ? decodePolyline(polys[i].crdEncYX) : []));
    const passlist = transit ? sec.jny.stopL ?? [] : [];
    const depIndex = passlist.findIndex((stop) => stop.idx === sec.dep.idx && stop.locX === sec.dep.locX);
    const arrIndex = passlist.findIndex((stop) => stop.idx === sec.arr.idx && stop.locX === sec.arr.locX);
    // stopL can cover the whole service; idx is a stop identifier, not an array offset.
    const riddenStops = depIndex >= 0 && arrIndex >= depIndex
      ? passlist.slice(depIndex + 1, arrIndex)
      : passlist.filter((stop) => (
        (sec.dep.idx == null || stop.idx == null || stop.idx > sec.dep.idx)
        && (sec.arr.idx == null || stop.idx == null || stop.idx < sec.arr.idx)
      ));
    const stops = riddenStops
      .filter((stop) => stop.locX !== sec.dep.locX && stop.locX !== sec.arr.locX)
      .filter((stop) => Number.isFinite(locs[stop.locX]?.crd?.x) && Number.isFinite(locs[stop.locX]?.crd?.y))
      .map((stop) => point(stop.locX));
    return {
      transit,
      from,
      to,
      stops,
      dep: sec.dep.dTimeS, // scheduled; real-time values exist only for some stops, and mixing them misleads
      arr: sec.arr.aTimeS,
      line: transit ? lineInfo(prods[sec.jny.prodX], icons) : null,
      coords: coords.length ? coords : [[from.lat, from.lon], [to.lat, to.lon]],
    };
  });
  return {
    ctxRecon: con.ctxRecon,
    dep: con.dep.dTimeS,
    arr: con.arr.aTimeS,
    minutes: hafasMinutes(con.dur),
    changes: con.chg ?? 0,
    legs,
    zones: null, // null = loading, [] = unavailable
  };
}

/** Badge text and colours. Numbered trains ("IC 70866", "Re 52538") show their category; lines show the line. */
function lineInfo(prod, icons) {
  if (!prod) return { label: '?', title: '', bg: '#555', fg: '#fff' };
  const short = prod.nameS || prod.name;
  const category = prod.prodCtx?.catOutL?.trim();
  const label = /^\d{3,}$/.test(short) && category ? category : short;
  const ico = icons[prod.icoX] ?? {};
  const rgb = (c, dflt) => (c ? `rgb(${c.r},${c.g},${c.b})` : dflt);
  return { label, title: prod.name, bg: rgb(ico.bg, '#555'), fg: rgb(ico.fg, '#fff') };
}

/** HAFAS polyline: Google encoding at 1e5 precision. */
function decodePolyline(str) {
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
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}

/** "HHMMSS", or "DDHHMMSS" with a day offset, already in Danish local time → "HH:MM" (+N for later days). */
function hafasClock(t) {
  const days = t.length > 6 ? Number(t.slice(0, -6)) : 0;
  const hhmm = `${t.slice(-6, -4)}:${t.slice(-4, -2)}`;
  return days ? `${hhmm} (+${days})` : hhmm;
}

function hafasMinutes(d) {
  const days = d.length > 6 ? Number(d.slice(0, -6)) : 0;
  return days * 1440 + Number(d.slice(-6, -4)) * 60 + Number(d.slice(-4, -2));
}

// ---------- search fields ----------

const TYPE_LABEL = { S: 'Stop', A: 'Address', P: 'Place' };

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
      const li = el('li', { role: 'option' }, item.name, el('small', {}, TYPE_LABEL[item.type] ?? ''));
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
        const found = await searchPlaces(q);
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
    /** The chosen place, or the best match for the typed text. */
    async resolve(what) {
      if (place) return place;
      const q = input.value.trim();
      if (!q) throw new Error(`Enter a ${what}.`);
      const [best] = await searchPlaces(q);
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

/** Draw stations last so every dot stays above all route polylines. */
function drawRouteStops(legs) {
  const endpoints = new Map();
  const intermediate = new Map();
  const key = (stop) => `${stop.lat},${stop.lon}`;
  for (const leg of legs) {
    if (!leg.transit) continue;
    for (const stop of [leg.from, leg.to]) endpoints.set(key(stop), stop);
    for (const stop of leg.stops ?? []) intermediate.set(key(stop), stop);
  }
  const draw = (stop, radius) => {
    // Leaflet treats tooltip strings as HTML; a text-only element keeps station names safe.
    const label = document.createElement('span');
    label.textContent = stop.name;
    L.circleMarker([stop.lat, stop.lon], {
      radius, color: '#222', weight: radius === 5 ? 2 : 1.5, fillColor: '#fff', fillOpacity: 1,
    }).bindTooltip(label, { direction: 'top', offset: [0, -radius] })
      .on('click', function () { this.openTooltip(); })
      .addTo(routeLayer);
  };
  for (const [id, stop] of intermediate) {
    if (!endpoints.has(id)) draw(stop, 3);
  }
  for (const stop of endpoints.values()) draw(stop, 5);
}

// ---------- results ----------

let shownTrips = [];
let selectedIndex = -1;
let searchSeq = 0;
let routeBounds = null;
let sheetExpanded = false;
let editingJourney = true;
let fitFrame = 0;
let lastFitKey = '';
const phoneLayout = window.matchMedia('(max-width: 760px)');
const searchForm = document.getElementById('search');
const resultsList = document.getElementById('results');
const routeSheet = document.getElementById('route-sheet');
const journeyBar = document.getElementById('journey-bar');
const routesToggle = document.getElementById('toggle-routes');
const editJourney = document.getElementById('edit-journey');

function syncJourneyLayout() {
  const phone = phoneLayout.matches;
  const hasTrips = shownTrips.length > 0;
  const compactSearch = phone && hasTrips && !editingJourney;
  searchForm.hidden = compactSearch;
  journeyBar.hidden = !compactSearch;
  editJourney.setAttribute('aria-expanded', String(!compactSearch));
  routeSheet.hidden = !hasTrips;
  resultsList.hidden = phone && !sheetExpanded;
  routesToggle.setAttribute('aria-expanded', String(sheetExpanded));
  routesToggle.textContent = sheetExpanded ? 'Hide routes & details' : `Show ${shownTrips.length} routes & details`;
  if (resultsList.hidden && resultsList.contains(document.activeElement)) routesToggle.focus();
  if (compactSearch && searchForm.contains(document.activeElement)) document.activeElement.blur();
  scheduleRouteFit();
}

function setSheetExpanded(expanded) {
  sheetExpanded = expanded;
  syncJourneyLayout();
  if (expanded) {
    const selected = resultsList.children[selectedIndex];
    if (selected) {
      resultsList.scrollTop += selected.getBoundingClientRect().top - resultsList.getBoundingClientRect().top;
    }
  }
}

function renderSelectedSummary() {
  const trip = shownTrips[selectedIndex];
  const summary = document.getElementById('route-summary');
  if (!trip) { summary.replaceChildren(); return; }
  const lines = el('div', { className: 'lines' });
  for (const leg of trip.legs) {
    if (leg.transit) lines.append(lineBadge(leg.line));
  }
  if (!lines.childNodes.length) lines.append('Walk only');
  const zones = el('div', { className: 'zones' }, ...zoneRowContent(trip, false));
  summary.replaceChildren(
    el('div', { className: 'trip-head' },
      el('span', {}, `${hafasClock(trip.dep)} – ${hafasClock(trip.arr)}`),
      el('span', {}, formatDuration(trip.minutes))),
    lines, zones);
}

/** Refit the existing route, not its layers, when the space around the map changes. */
function scheduleRouteFit() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    document.documentElement.style.setProperty('--route-sheet-height',
      `${phoneLayout.matches && !routeSheet.hidden ? routeSheet.getBoundingClientRect().height : 0}px`);
    if (!routeBounds?.isValid()) return;
    const mapRect = document.getElementById('map').getBoundingClientRect();
    const visibleRect = (node) => node.hidden || !node.getClientRects().length ? null : node.getBoundingClientRect();
    const topRects = [searchForm, journeyBar, document.getElementById('status')].map(visibleRect).filter(Boolean);
    const top = Math.max(0, ...topRects.map((rect) => rect.bottom - mapRect.top)) + 16;
    const sheetRect = visibleRect(routeSheet);
    const left = !phoneLayout.matches && sheetRect ? sheetRect.right - mapRect.left + 20 : 20;
    const bottom = phoneLayout.matches && sheetRect ? mapRect.bottom - sheetRect.top + 16 : 30;
    const key = [mapRect.width, mapRect.height, top, left, bottom].join(',');
    if (key === lastFitKey) return;
    lastFitKey = key;
    map.invalidateSize({ pan: false });
    map.fitBounds(routeBounds, { paddingTopLeft: [left, top], paddingBottomRight: [20, bottom], maxZoom: 15, animate: false });
  });
}

routesToggle.addEventListener('click', () => setSheetExpanded(!sheetExpanded));
editJourney.addEventListener('click', () => {
  editingJourney = true;
  setSheetExpanded(false);
  document.getElementById('from').focus();
});
phoneLayout.addEventListener('change', syncJourneyLayout);
window.addEventListener('resize', scheduleRouteFit);
const journeyLayoutObserver = new ResizeObserver(scheduleRouteFit);
[searchForm, journeyBar, routeSheet, document.getElementById('status')].forEach((node) => journeyLayoutObserver.observe(node));
syncJourneyLayout();

function lineBadge(line) {
  return el('span', { className: 'line', title: line.title, style: `background:${line.bg};color:${line.fg}` }, line.label);
}

function zoneChip(id) {
  const z = zoneById.get(id);
  return el('span', { className: 'zone', title: z?.name ?? '' }, z?.short ?? id);
}

const ZONE_PREVIEW = 3; // chips kept at each end of a collapsed zone list

/** Zone chips; long lists collapse to "first … +N … last" and toggle on click. */
function zoneSequence(ids, expandable = true) {
  if (ids.length <= ZONE_PREVIEW * 2 + 2) return ids.map(zoneChip);
  const seq = el('span', { className: 'zone-seq' });
  const toggleButton = (label, title, expand) => {
    if (!expandable) return el('span', { className: 'zone', title: `${ids.length - ZONE_PREVIEW * 2} more zones` }, label);
    const b = el('button', { type: 'button', className: 'zone more', title }, label);
    b.addEventListener('click', (e) => {
      e.stopPropagation(); // don't (re)select the trip card
      render(expand);
    });
    return b;
  };
  const render = (expanded) => seq.replaceChildren(...(expanded
    ? [...ids.map(zoneChip), ' ', toggleButton('less', 'Collapse zones', false)]
    : [
      ...ids.slice(0, ZONE_PREVIEW).map(zoneChip),
      toggleButton(`+${ids.length - ZONE_PREVIEW * 2}`, 'Show all zones', true),
      ...ids.slice(-ZONE_PREVIEW).map(zoneChip),
    ]));
  render(false);
  return [seq];
}

function zoneRowContent(trip, expandable = true) {
  if (trip.zones === null) return ['Zones: loading…'];
  if (!trip.zones.length) return ['Zones: not available'];
  return [trip.zones.length === 1 ? '1 zone:' : `${trip.zones.length} zones:`, ...zoneSequence(trip.zones, expandable)];
}

function formatDuration(m) {
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function renderTrips(trips) {
  const list = document.getElementById('results');
  list.replaceChildren(...trips.map((trip, index) => {
    const transitLegs = trip.legs.filter((l) => l.transit);
    const changes = trip.changes === 1 ? '1 change' : `${trip.changes} changes`;

    const lines = el('div', { className: 'lines' });
    transitLegs.forEach((l, i) => {
      if (i) lines.append('›');
      lines.append(lineBadge(l.line));
    });
    if (!transitLegs.length) lines.append('Walk only');

    trip.zoneRow = el('div', { className: 'zones' }, ...zoneRowContent(trip));

    const legList = el('ul', { className: 'legs' }, ...trip.legs.map((l) => el('li', {},
      l.transit ? lineBadge(l.line) : 'Walk', ` ${l.from.name} → ${l.to.name}`,
      el('div', { className: 'stops' }, `${hafasClock(l.dep)}–${hafasClock(l.arr)}`))));

    const selectButton = el('button', { type: 'button', className: 'trip-select' },
      el('div', { className: 'trip-head' },
        el('span', {}, `${hafasClock(trip.dep)} – ${hafasClock(trip.arr)}`),
        el('span', {}, `${formatDuration(trip.minutes)} · ${changes}`)));
    selectButton.setAttribute('aria-pressed', 'false');
    const li = el('li', { className: 'trip' }, selectButton,
      lines, trip.zoneRow, legList);
    li.addEventListener('click', () => selectTrip(index));
    return li;
  }));
}

function setTripZones(trip, zoneIds) {
  trip.zones = zoneIds;
  trip.zoneRow.replaceChildren(...zoneRowContent(trip));
  if (shownTrips[selectedIndex] === trip) {
    highlightZones(zoneIds);
    renderSelectedSummary();
  }
}

function selectTrip(index) {
  if (index === selectedIndex) return;
  selectedIndex = index;
  [...resultsList.children].forEach((li, i) => {
    li.classList.toggle('selected', i === index);
    li.querySelector('.trip-select').setAttribute('aria-pressed', String(i === index));
  });
  const trip = shownTrips[index];
  routeLayer.clearLayers();
  const bounds = L.latLngBounds([]);
  for (const l of trip.legs) {
    bounds.extend(l.coords);
    if (l.transit) {
      L.polyline(l.coords, { color: '#fff', weight: 9, opacity: 0.9 }).addTo(routeLayer);
      L.polyline(l.coords, { color: l.line.bg, weight: 5 })
        .bindTooltip(`${l.line.title}: ${l.from.name} → ${l.to.name}`, { sticky: true })
        .addTo(routeLayer);
    } else {
      L.polyline(l.coords, { color: '#555', weight: 4, dashArray: '2 8', lineCap: 'round' }).addTo(routeLayer);
    }
  }
  drawRouteStops(trip.legs);
  routeBounds = bounds;
  lastFitKey = '';
  renderSelectedSummary();
  highlightZones(trip.zones ?? []);
  if (phoneLayout.matches) setSheetExpanded(false);
  else syncJourneyLayout();
}

document.getElementById('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mine = ++searchSeq;
  const go = document.getElementById('go');
  go.disabled = true;
  document.getElementById('results').replaceChildren();
  shownTrips = [];
  selectedIndex = -1;
  routeBounds = null;
  lastFitKey = '';
  sheetExpanded = false;
  editingJourney = true;
  renderSelectedSummary();
  syncJourneyLayout();
  routeLayer.clearLayers();
  highlightZones([]);
  showStatus('Searching…');
  try {
    const [from, to] = await Promise.all([fromField.resolve('start'), toField.resolve('destination')]);
    const [trips] = await Promise.all([searchTrips(from, to), zonesReady]);
    if (mine !== searchSeq) return;
    if (!trips.length) throw new Error('No public transport routes found.');
    showStatus('');
    shownTrips = trips;
    renderTrips(trips);
    editingJourney = false;
    document.getElementById('journey-name').replaceChildren(
      el('span', { title: from.name }, from.name),
      el('span', { title: to.name }, `→ ${to.name}`));
    selectTrip(0);
    // Parallel single requests: ~0.4 s in total, versus ~1.8 s for one batched request.
    for (const trip of trips) {
      fetchTripZones(trip.ctxRecon)
        .catch(() => [])
        .then((ids) => { if (mine === searchSeq) setTripZones(trip, ids); });
    }
  } catch (err) {
    if (mine === searchSeq) showStatus(err.message, true);
  } finally {
    if (mine === searchSeq) go.disabled = false;
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
