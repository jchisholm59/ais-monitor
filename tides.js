'use strict';
// Tides for the Tides tab, from the best source for each place:
//   CHS    Canadian Hydrographic Service (IWLS API, free, no key): Canadian stations. Station id: 24 hex characters.
//          Its certificate is from Entrust, which browsers stopped trusting for certificates issued after late 2024, so
//          a browser can't call it directly; Node can.
//   NOAA   CO-OPS tide predictions (free, no key): US stations. Station id: noaa:<id>.
//   Model  anywhere else, at a point (id geo:<lat>,<lon>): WorldTides (WORLDTIDES_KEY; paid, accurate near coasts) or
//          else Open-Meteo Marine's sea_level_height_msl (free, no key; a coarse global ocean model, so only roughly
//          right in bays and harbours, and nothing on land).
//   GET /api/tides?station=<id>            the place, 15-minute heights (yesterday to 7.5 days ahead), highs and lows,
//                                          and a CHS gauge's observed level for the last 8 h when it has one
//   GET /api/tides/stations?q=&lat=&lon=   search the stations with predictions, nearest first
//   GET /api/tides/defaults                the nearest station to each of the monitor's locations (within 40 km)
//   GET / PUT /api/tides/saved             the Tides tab's station list, saved from the card
const fs = require('fs');
const path = require('path');

const IWLS = 'https://api-iwls.dfo-mpo.gc.ca/api/v1/stations';
const NOAA = 'https://api.tidesandcurrents.noaa.gov';
const fin = Number.isFinite;
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function km(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dla = (la2 - la1) * r, dlo = (lo2 - lo1) * r;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dlo / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Highs and lows from a height series: local extremes, refined with a parabola through the three points.
function extremes(curve) {
  const out = [];
  for (let i = 1; i < curve.length - 1; i++) {
    const [t0, a] = curve[i - 1], [t1, b] = curve[i], [, c] = curve[i + 1];
    if ((b > a && b >= c) || (b < a && b <= c)) {
      const den = a - 2 * b + c, dt = curve[i + 1][0] - t1, x = den ? (0.5 * (a - c)) / den : 0;
      out.push([Math.round(t1 + x * dt), Math.round((b - 0.25 * (a - c) * x) * 1000) / 1000]);
    }
  }
  return out;
}
// A smooth curve through highs and lows (half-cosine between each pair), for stations that only publish those.
function cosineCurve(ev, step = 15 * 60e3) {
  const out = [];
  for (let i = 0; i < ev.length - 1; i++) {
    const [ta, va] = ev[i], [tb, vb] = ev[i + 1];
    for (let t = Math.ceil(ta / step) * step; t < tb; t += step) out.push([t, va + ((vb - va) * (1 - Math.cos((Math.PI * (t - ta)) / (tb - ta)))) / 2]);
  }
  return out;
}

module.exports = function createTides({ dataDir, isAdmin, locations, worldtidesKey = '' }) {
  const SAVED = path.join(dataDir, 'tide-stations.json');
  const cache = new Map(); // station -> { at, obsAt, data }
  let catalogue = null;

  async function iwls(p) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(`${IWLS}/${p}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`CHS HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(to);
    }
  }

  async function getJson(url) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error?.message || j.reason || j.error || `HTTP ${r.status}`);
      return j;
    } finally {
      clearTimeout(to);
    }
  }

  // The place's time zone (Open-Meteo's lookup from coordinates), so the card shows local tide times anywhere.
  const tzCache = new Map();
  async function tzFor(lat, lon) {
    const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (tzCache.has(k)) return tzCache.get(k);
    try {
      const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1&current=temperature_2m`);
      tzCache.set(k, j.timezone || null);
    } catch (e) {
      return null;
    }
    return tzCache.get(k);
  }

  async function station(id) {
    const d = await stationData(id);
    if (d.meta && d.meta.tz === undefined && fin(d.meta.latitude)) d.meta.tz = await tzFor(d.meta.latitude, d.meta.longitude);
    return d;
  }
  async function stationData(id) {
    id = String(id || '');
    if (id.startsWith('noaa:')) return cached(id, 3 * 3600e3, () => noaaStation(id.slice(5)));
    if (id.startsWith('geo:')) return cached(id, 6 * 3600e3, () => modelPoint(id.slice(4)));
    if (!/^[0-9a-f]{24}$/.test(id)) throw new Error('station must be a CHS id (24 hex characters), noaa:<id> or geo:<lat>,<lon>');
    return chsStation(id);
  }
  async function cached(id, ttl, load) {
    const c = cache.get(id);
    if (c && Date.now() - c.at < ttl) return c.data;
    const data = { ...(await load()), obs: [], fetched: Date.now() };
    cache.set(id, { at: Date.now(), obsAt: Date.now(), data });
    return data;
  }

  // NOAA: 15-minute predictions and highs/lows (metric, MLLW, GMT). Subordinate stations only publish highs/lows, so
  // their curve is drawn through those.
  async function noaaStation(sid) {
    if (!/^\w{5,10}$/.test(sid)) throw new Error('bad NOAA station id');
    const st = (await noaaStations()).find((x) => x.code === sid);
    const d = new Date(Date.now() - 864e5), begin = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const q = (interval) => getJson(`${NOAA}/api/prod/datagetter?product=predictions&datum=MLLW&station=${sid}&begin_date=${begin}&range=${9 * 24}&interval=${interval}&units=metric&time_zone=gmt&format=json&application=ais-monitor`);
    const toT = (s) => Date.parse(s.replace(' ', 'T') + ':00Z');
    const hilo = (await q('hilo')).predictions.map((x) => [toT(x.t), Number(x.v)]);
    let curve;
    try {
      curve = (await q('15')).predictions.map((x) => [toT(x.t), Number(x.v)]);
    } catch (e) {
      curve = cosineCurve(hilo);
    }
    return { meta: { code: sid, name: st?.name || `NOAA ${sid}`, latitude: st?.lat, longitude: st?.lon, series: ['wlp'], source: 'NOAA', datum: 'mean lower low water (MLLW)' }, curve, events: hilo };
  }

  // A model point: WorldTides if there's a key, else Open-Meteo Marine.
  async function modelPoint(ll) {
    const [lat, lon] = ll.split(',').map(Number);
    if (!fin(lat) || !fin(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('bad geo:<lat>,<lon>');
    const name = (locations().find((l) => Math.abs(l.lat - lat) < 1e-4 && Math.abs(l.lon - lon) < 1e-4) || {}).name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    const meta = { code: `${lat.toFixed(3)},${lon.toFixed(3)}`, name, latitude: lat, longitude: lon, series: ['model'] };
    if (worldtidesKey) {
      const start = Math.floor((Date.now() - 864e5) / 1000);
      const j = await getJson(`https://www.worldtides.info/api/v3?heights&extremes&lat=${lat}&lon=${lon}&start=${start}&length=${8 * 86400}&step=900&datum=CD&key=${encodeURIComponent(worldtidesKey)}`);
      const curve = (j.heights || []).map((x) => [x.dt * 1000, x.height]);
      if (!curve.length) throw new Error('WorldTides has no tides at this point');
      return { meta: { ...meta, source: 'WorldTides', datum: j.responseDatum ? `${j.responseDatum} (WorldTides)` : 'chart datum (WorldTides)', near: j.station || null }, curve, events: (j.extremes || []).map((x) => [x.dt * 1000, x.height]) };
    }
    const j = await getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&minutely_15=sea_level_height_msl&past_days=1&forecast_days=8&timezone=GMT`);
    const m = j.minutely_15 || {};
    const curve = (m.time || []).map((t, i) => [Date.parse(t + 'Z'), m.sea_level_height_msl?.[i]]).filter((x) => fin(x[1]));
    if (!curve.length) throw new Error('No tide model data at this point (on land, or too far up an inlet): pick a point on open water');
    return { meta: { ...meta, source: 'Open-Meteo', datum: 'mean sea level (a coarse model: rough in bays and harbours)' }, curve, events: extremes(curve) };
  }

  async function chsStation(id) {
    const c = cache.get(id), now = Date.now();
    if (c && now - c.at < 30 * 60e3 && now - c.obsAt < 10 * 60e3) return c.data;
    const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
    const q = (code, from, to, res) => iwls(`${id}/data?time-series-code=${code}&from=${iso(from)}&to=${iso(to)}${res ? '&resolution=' + res : ''}`);
    const fresh = !c || now - c.at >= 30 * 60e3;
    const [meta, curve, hilo, obs] = await Promise.all([
      c?.data.meta || iwls(id).then((m) => ({ code: m.code, name: m.officialName, latitude: m.latitude, longitude: m.longitude, series: (m.timeSeries || []).map((t) => t.code), source: 'CHS', datum: 'chart datum (about the lowest tides)' })),
      fresh ? q('wlp', now - 26 * 3600e3, now + 7.5 * 864e5, 'FIFTEEN_MINUTES') : null,
      fresh ? q('wlp-hilo', now - 1.5 * 864e5, now + 8 * 864e5) : null,
      q('wlo', now - 8 * 3600e3, now).catch(() => []),
    ]);
    const pts = (a) => (Array.isArray(a) ? a : []).map((x) => [Date.parse(x.eventDate), x.value]).filter((x) => fin(x[1]));
    const data = { meta, curve: fresh ? pts(curve) : c.data.curve, events: fresh ? pts(hilo) : c.data.events, obs: pts(obs), fetched: now };
    cache.set(id, { at: fresh ? now : c.at, obsAt: now, data });
    return data;
  }

  // The catalogue (~1,600 stations, ~1,100 with predictions), cached 6 h.
  async function stations() {
    if (catalogue && Date.now() - catalogue.at < 6 * 3600e3) return catalogue.list;
    const list = (await iwls(''))
      .filter((x) => (x.timeSeries || []).some((t) => t.code === 'wlp'))
      .map((x) => ({ id: x.id, code: x.code, name: x.officialName, alt: x.alternativeName || '', lat: x.latitude, lon: x.longitude, gauge: !!x.operating && (x.timeSeries || []).some((t) => t.code === 'wlo') }));
    catalogue = { at: Date.now(), list };
    return list;
  }

  let noaaCat = null;
  async function noaaStations() {
    if (noaaCat && Date.now() - noaaCat.at < 24 * 3600e3) return noaaCat.list;
    const j = await getJson(`${NOAA}/mdapi/prod/webapi/stations.json?type=tidepredictions`);
    const list = (j.stations || []).map((x) => ({ id: 'noaa:' + x.id, code: x.id, name: x.name + (x.state ? `, ${x.state}` : ''), alt: '', lat: x.lat, lon: x.lng, gauge: false, source: 'NOAA' }));
    noaaCat = { at: Date.now(), list };
    return list;
  }
  async function everyStation() {
    const [chs, noaa] = await Promise.all([stations(), noaaStations().catch(() => [])]);
    return [...chs.map((x) => ({ ...x, source: 'CHS' })), ...noaa];
  }

  async function search(q, lat, lon) {
    const near = fin(lat) && fin(lon), f = fold(q).trim();
    const all = (await everyStation()).map((x) => ({ ...x, km: near ? Math.round(km(lat, lon, x.lat, x.lon)) : null }));
    const hits = f ? all.filter((x) => fold(x.name).includes(f) || fold(x.alt).includes(f) || x.code === f.padStart(5, '0')) : all;
    hits.sort((a, b) => (f ? (fold(a.name).startsWith(f) ? 0 : 1) - (fold(b.name).startsWith(f) ? 0 : 1) : 0) || (near ? a.km - b.km : a.name.localeCompare(b.name)));
    const out = hits.slice(0, 25);
    // Anywhere else: "lat, lon" typed in, or places by name (Open-Meteo's geocoder), as model points.
    const ll = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q || '');
    if (ll) out.unshift({ id: `geo:${Number(ll[1]).toFixed(4)},${Number(ll[2]).toFixed(4)}`, code: 'model', name: `Tide model at ${ll[1]}, ${ll[2]}`, alt: '', lat: Number(ll[1]), lon: Number(ll[2]), gauge: false, source: 'model', km: null });
    else if (f.length >= 3) {
      try {
        const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.trim())}&count=4&language=en&format=json`);
        for (const x of g.results || []) out.push({ id: `geo:${x.latitude.toFixed(4)},${x.longitude.toFixed(4)}`, code: 'model', name: [...new Set([x.name, x.admin1, x.country].filter(Boolean))].join(', '), alt: 'tide model at this place (best on open coast)', lat: x.latitude, lon: x.longitude, gauge: false, source: 'model', km: near ? Math.round(km(lat, lon, x.latitude, x.longitude)) : null });
      } catch (e) {}
    }
    return out;
  }

  // The nearest station to each location, named after the location; locations with none within 40 km are left out.
  // Each location's tides: the nearest CHS or NOAA station within 40 km, else the tide model at the location.
  async function defaults() {
    const all = await everyStation(), out = [];
    for (const l of locations()) {
      let best = null;
      for (const x of all) {
        const d = km(l.lat, l.lon, x.lat, x.lon);
        if (!best || d < best.d) best = { x, d };
      }
      const id = best && best.d <= 40 ? best.x.id : `geo:${l.lat.toFixed(4)},${l.lon.toFixed(4)}`;
      if (!out.some((o) => o.id === id)) out.push({ id, name: l.name });
    }
    return out;
  }

  const readSaved = () => {
    try {
      return JSON.parse(fs.readFileSync(SAVED, 'utf8'));
    } catch (e) {
      return null;
    }
  };

  // Handles /api/tides*: returns true if it answered.
  return async function handle(req, res, url, sendJson, body) {
    const p = url.pathname;
    if (!p.startsWith('/api/tides')) return false;
    if (p === '/api/tides') return sendJson(res, await station(url.searchParams.get('station'))), true;
    if (p === '/api/tides/stations') return sendJson(res, await search(url.searchParams.get('q') || '', Number(url.searchParams.get('lat') ?? NaN), Number(url.searchParams.get('lon') ?? NaN))), true;
    if (p === '/api/tides/defaults') return sendJson(res, await defaults()), true;
    if (p === '/api/tides/saved' && req.method === 'GET') return sendJson(res, readSaved()), true;
    if (p === '/api/tides/saved' && (req.method === 'PUT' || req.method === 'POST')) {
      if (!isAdmin(req)) return sendJson(res, { error: 'sign in to change the tide stations' }, 401), true;
      const b = await body(req);
      const list = (Array.isArray(b) ? b : []).filter((x) => x && /^([0-9a-f]{24}|noaa:\w{5,10}|geo:-?\d+(\.\d+)?,-?\d+(\.\d+)?)$/.test(x.id)).slice(0, 20).map((x) => ({ id: x.id, name: String(x.name || '').slice(0, 40) || 'Station' }));
      fs.writeFileSync(SAVED, JSON.stringify(list));
      return sendJson(res, list), true;
    }
    return false;
  };
};
