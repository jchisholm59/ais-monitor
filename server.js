'use strict';
// AIS monitor: keeps a live table of vessels from aisstream.io (a free, keyed AIS websocket feed) for an area, and
// serves the ones closest to a chosen location, classified (military, government, commercial, service, fishing,
// private…), to the Home Assistant Ships card. The key stays here: aisstream doesn't allow browser connections.
// No dependencies (Node 22's built-in WebSocket). Vessel details and last positions persist in data/.

const http = require('http');
const fs = require('fs');
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {}

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k, d) => (env(k) !== '' && Number.isFinite(Number(env(k))) ? Number(env(k)) : d);
const PORT = num('PORT', 7110);
const KEY = env('AISSTREAM_KEY');
const AREA = { lat: num('AREA_LAT', NaN), lon: num('AREA_LON', NaN), radius: num('AREA_RADIUS_NM', 100) };
// Quick-pick locations for the card: "Name:lat,lon;Name:lat,lon". The first is the default.
const LOCATIONS = env('LOCATIONS')
  .split(';')
  .map((s) => /^\s*([^:]+):\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(s))
  .filter(Boolean)
  .map((m) => ({ name: m[1].trim(), lat: Number(m[2]), lon: Number(m[3]) }));
if (!LOCATIONS.length && Number.isFinite(AREA.lat)) LOCATIONS.push({ name: env('AREA_NAME', 'Area centre'), lat: AREA.lat, lon: AREA.lon });
// What to receive: a box around each location (LOCATION_RADIUS_NM), plus the wider AREA if set. One connection.
const LOCATION_RADIUS = num('LOCATION_RADIUS_NM', 40);
const AREAS = [...(Number.isFinite(AREA.lat) ? [AREA] : []), ...LOCATIONS.map((l) => ({ lat: l.lat, lon: l.lon, radius: LOCATION_RADIUS }))];
const CLOSEST = num('CLOSEST', 50);
const HA_WEBHOOK = env('HA_WEBHOOK');

const DATA_DIR = path.join(__dirname, 'data');
const VESSELS_FILE = path.join(DATA_DIR, 'vessels.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const NM = 3440.065;
const RAD = Math.PI / 180;
const KEEP_POSITION_MS = 3 * 3600_000; // drop vessels not heard for 3 h from the live list
const KEEP_STATIC_MS = 30 * 86400_000; // remember names/types for 30 days
const TRACK_MS = 2 * 3600_000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}
function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return dflt;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj));
  fs.renameSync(file + '.tmp', file);
}
function dist(a1, o1, a2, o2) {
  const dA = (a2 - a1) * RAD, dO = (o2 - o1) * RAD;
  const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * RAD) * Math.cos(a2 * RAD) * Math.sin(dO / 2) ** 2;
  return 2 * NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a1, o1, a2, o2) {
  const y = Math.sin((o2 - o1) * RAD) * Math.cos(a2 * RAD);
  const x = Math.cos(a1 * RAD) * Math.sin(a2 * RAD) - Math.sin(a1 * RAD) * Math.cos(a2 * RAD) * Math.cos((o2 - o1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
const clean = (s) => String(s ?? '').replace(/@+$/, '').replace(/\s+/g, ' ').trim();

// ---- classification ------------------------------------------------------

// AIS ship type (0-99) -> description.
function typeLabel(t) {
  if (t >= 20 && t <= 29) return 'Wing in ground';
  if (t >= 40 && t <= 49) return 'High-speed craft';
  if (t >= 60 && t <= 69) return 'Passenger';
  if (t >= 70 && t <= 79) return 'Cargo';
  if (t >= 80 && t <= 89) return 'Tanker';
  if (t >= 90 && t <= 99) return 'Other';
  return {
    30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging / underwater ops', 34: 'Diving ops', 35: 'Military ops',
    36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender',
    54: 'Anti-pollution', 55: 'Law enforcement', 58: 'Medical transport', 59: 'Noncombatant',
  }[t] || '';
}
// Navy ship prefixes -> navy.
const NAVIES = [
  [/^(HMCS|CFAV|NCSM)\b/, 'RCN', 'Royal Canadian Navy'], [/^(USS|USNS)\b/, 'USN', 'US Navy'], [/^(HMS|RFA)\b/, 'RN', 'Royal Navy'],
  [/^HNLMS\b/, 'RNLN', 'Royal Netherlands Navy'], [/^HDMS\b/, 'RDN', 'Royal Danish Navy'], [/^FGS\b/, 'GN', 'German Navy'],
  [/^(FS|BSAM)\b/, 'FN', 'French Navy'], [/^ITS\b/, 'ItN', 'Italian Navy'], [/^ESPS\b/, 'SpN', 'Spanish Navy'],
  [/^NRP\b/, 'PoN', 'Portuguese Navy'], [/^KNM\b/, 'RNoN', 'Royal Norwegian Navy'], [/^HMNZS\b/, 'RNZN', 'Royal New Zealand Navy'],
  [/^HMAS\b/, 'RAN', 'Royal Australian Navy'], [/^TCG\b/, 'TN', 'Turkish Navy'], [/^BNS\b/, 'BN', 'Belgian Navy'],
  [/^(ORP)\b/, 'PN', 'Polish Navy'], [/^(HSwMS)\b/, 'SwN', 'Swedish Navy'],
];
const GOV_NAME = /^(CCGS|USCGC|CGS|RCMP|NOAA|DFO|CCG|GC)\b|COAST ?GUARD|POLICE|RCMP|FISHERIES|CUSTOMS|BORDER/;

// -> { cls, sub, navy? }. Classes: mil, gov, com, svc, fish, priv, other, unk.
function classify(v) {
  const name = (v.name || '').toUpperCase(), t = v.type;
  const navy = NAVIES.find(([re]) => re.test(name));
  if (navy || t === 35) return { cls: 'mil', sub: navy ? navy[2] : 'Military', navy: navy ? navy[1] : null };
  if (t === 51 || t === 55 || GOV_NAME.test(name)) return { cls: 'gov', sub: t === 51 ? 'Search and rescue' : t === 55 ? 'Law enforcement' : /COAST ?GUARD|CCGS|USCGC|CGS/.test(name) ? 'Coast Guard' : 'Government' };
  if (t >= 60 && t <= 69) return { cls: 'com', sub: v.length >= 200 ? 'Cruise ship' : 'Passenger / ferry' };
  if ((t >= 70 && t <= 89) || (t >= 40 && t <= 49)) return { cls: 'com', sub: typeLabel(t) };
  if ([31, 32, 33, 34, 50, 52, 53, 54, 56, 57, 58, 59].includes(t)) return { cls: 'svc', sub: typeLabel(t) || 'Service' };
  if (t === 30) return { cls: 'fish', sub: 'Fishing' };
  if (t === 36 || t === 37) return { cls: 'priv', sub: typeLabel(t) };
  if (/\bPILOT\b/.test(name)) return { cls: 'svc', sub: 'Pilot vessel' };
  if (t) return { cls: 'other', sub: typeLabel(t) || `Type ${t}` };
  // Ships send their type every 6 minutes (class B less reliably), so a new arrival has none yet.
  return { cls: 'unk', sub: v.classB ? 'Small craft (class B)' : name ? 'Waiting for details' : '' };
}

// MMSI maritime identification digits -> ISO country (common flags and flags of convenience).
const MID = {
  201: 'AL', 202: 'AD', 203: 'AT', 204: 'PT', 205: 'BE', 206: 'BY', 207: 'BG', 208: 'VA', 209: 'CY', 210: 'CY', 211: 'DE', 212: 'CY',
  213: 'GE', 214: 'MD', 215: 'MT', 216: 'AM', 218: 'DE', 219: 'DK', 220: 'DK', 224: 'ES', 225: 'ES', 226: 'FR', 227: 'FR', 228: 'FR',
  229: 'MT', 230: 'FI', 231: 'FO', 232: 'GB', 233: 'GB', 234: 'GB', 235: 'GB', 236: 'GI', 237: 'GR', 238: 'HR', 239: 'GR', 240: 'GR',
  241: 'GR', 242: 'MA', 243: 'HU', 244: 'NL', 245: 'NL', 246: 'NL', 247: 'IT', 248: 'MT', 249: 'MT', 250: 'IE', 251: 'IS', 252: 'LI',
  253: 'LU', 254: 'MC', 255: 'PT', 256: 'MT', 257: 'NO', 258: 'NO', 259: 'NO', 261: 'PL', 263: 'PT', 264: 'RO', 265: 'SE', 266: 'SE',
  267: 'SK', 268: 'SM', 269: 'CH', 270: 'CZ', 271: 'TR', 272: 'UA', 273: 'RU', 274: 'MK', 275: 'LV', 276: 'EE', 277: 'LT', 278: 'SI',
  279: 'RS', 301: 'AI', 303: 'US', 304: 'AG', 305: 'AG', 306: 'CW', 307: 'AW', 308: 'BS', 309: 'BS', 310: 'BM', 311: 'BS', 312: 'BZ',
  314: 'BB', 316: 'CA', 319: 'KY', 321: 'CR', 323: 'CU', 325: 'DM', 327: 'DO', 329: 'GP', 330: 'GD', 331: 'GL', 332: 'GT', 334: 'HN',
  336: 'HT', 338: 'US', 339: 'JM', 341: 'KN', 343: 'LC', 345: 'MX', 347: 'MQ', 348: 'MS', 350: 'NI', 351: 'PA', 352: 'PA', 353: 'PA',
  354: 'PA', 355: 'PA', 356: 'PA', 357: 'PA', 358: 'PR', 359: 'SV', 361: 'PM', 362: 'TT', 364: 'TC', 366: 'US', 367: 'US', 368: 'US',
  369: 'US', 370: 'PA', 371: 'PA', 372: 'PA', 373: 'PA', 374: 'PA', 375: 'VC', 376: 'VC', 377: 'VC', 378: 'VG', 379: 'VI',
  401: 'AF', 403: 'SA', 405: 'BD', 408: 'BH', 412: 'CN', 413: 'CN', 414: 'CN', 416: 'TW', 417: 'LK', 419: 'IN', 422: 'IR', 425: 'IQ',
  428: 'IL', 431: 'JP', 432: 'JP', 436: 'KZ', 438: 'JO', 440: 'KR', 441: 'KR', 445: 'KP', 447: 'KW', 450: 'LB', 461: 'OM', 463: 'PK',
  466: 'QA', 468: 'SY', 470: 'AE', 471: 'AE', 472: 'TJ', 473: 'YE', 477: 'HK', 501: 'TF', 503: 'AU', 506: 'MM', 508: 'BN', 512: 'NZ',
  514: 'KH', 515: 'KH', 518: 'CK', 520: 'FJ', 525: 'ID', 529: 'KI', 533: 'MY', 536: 'MP', 538: 'MH', 548: 'PH', 553: 'PG', 557: 'SB',
  563: 'SG', 564: 'SG', 565: 'SG', 566: 'SG', 567: 'TH', 570: 'TO', 572: 'TV', 574: 'VN', 576: 'VU', 577: 'VU', 601: 'ZA', 603: 'AO',
  605: 'DZ', 609: 'BI', 612: 'CF', 613: 'CM', 616: 'KM', 619: 'CI', 620: 'KM', 621: 'DJ', 622: 'EG', 624: 'ET', 626: 'GA', 627: 'GH',
  629: 'GM', 630: 'GW', 631: 'GQ', 632: 'GN', 634: 'KE', 636: 'LR', 637: 'LR', 642: 'LY', 645: 'MU', 647: 'MG', 649: 'ML', 650: 'MZ',
  654: 'MR', 655: 'MW', 656: 'NE', 657: 'NG', 659: 'NA', 661: 'RW', 662: 'SD', 663: 'SN', 664: 'SC', 667: 'SL', 668: 'ST', 670: 'TD',
  671: 'TG', 672: 'TN', 674: 'TZ', 675: 'UG', 676: 'CD', 677: 'TZ', 678: 'ZM', 679: 'ZW', 701: 'AR', 710: 'BR', 720: 'BO', 725: 'CL',
  730: 'CO', 735: 'EC', 740: 'FK', 745: 'GF', 750: 'GY', 755: 'PY', 760: 'PE', 765: 'SR', 770: 'UY', 775: 'VE',
};
function flagOf(mmsi) {
  const s = String(mmsi);
  return s.length === 9 && /^[2-7]/.test(s) ? MID[s.slice(0, 3)] || '' : '';
}
// Only ships: MMSIs of base stations (00…), aids to navigation (99…), SAR aircraft (111…), SART/EPIRB (97…) are skipped.
const isShip = (mmsi) => /^[2-7]\d{8}$/.test(String(mmsi));

// ---- vessel table ----------------------------------------------------------

const vessels = new Map(); // mmsi -> vessel
for (const v of readJson(VESSELS_FILE, [])) if (Date.now() - (v.staticAt || v.posAt || 0) < KEEP_STATIC_MS) vessels.set(v.mmsi, { ...v, track: v.track || [] });
let stats = { connected: false, since: 0, messages: 0, lastMsg: 0, error: null, reconnects: 0 };

function vessel(mmsi) {
  let v = vessels.get(mmsi);
  if (!v) vessels.set(mmsi, (v = { mmsi, track: [] }));
  return v;
}
function setDims(v, d) {
  if (!d) return;
  const L = (d.A || 0) + (d.B || 0), B = (d.C || 0) + (d.D || 0);
  if (L > 0 && L < 500) v.length = L;
  if (B > 0 && B < 80) v.beam = B;
}
function setName(v, n) {
  n = clean(n);
  if (n) v.name = n;
}

function onPosition(v, p, meta) {
  const lat = p.Latitude, lon = p.Longitude;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (lat === 0 && lon === 0)) return;
  const now = Date.now();
  v.lat = lat;
  v.lon = lon;
  v.sog = p.Sog >= 102.2 ? null : p.Sog;
  v.cog = p.Cog >= 360 ? null : p.Cog;
  v.hdg = p.TrueHeading === 511 ? null : p.TrueHeading;
  if (p.NavigationalStatus !== undefined) v.status = p.NavigationalStatus;
  v.posAt = now;
  if (meta?.ShipName) setName(v, meta.ShipName);
  // Track: a point when it has moved ~50 m, or every 5 min.
  const last = v.track[v.track.length - 1];
  if (!last || dist(last[1], last[2], lat, lon) > 0.027 || now - last[0] > 300_000) v.track.push([now, lat, lon, v.sog]);
  while (v.track.length && now - v.track[0][0] > TRACK_MS) v.track.shift();
  checkHarbours(v);
}

function onMessage(m) {
  stats.messages++;
  stats.lastMsg = Date.now();
  const type = m.MessageType, body = m.Message?.[type], meta = m.MetaData || {};
  const mmsi = meta.MMSI || body?.UserID;
  if (!body || !isShip(mmsi)) return;
  const v = vessel(mmsi);
  switch (type) {
    case 'PositionReport':
      return onPosition(v, body, meta);
    case 'StandardClassBPositionReport':
      v.classB = true;
      return onPosition(v, body, meta);
    case 'ExtendedClassBPositionReport':
      v.classB = true;
      setName(v, body.Name);
      if (body.Type) v.type = body.Type;
      setDims(v, body.Dimension);
      v.staticAt = Date.now();
      return onPosition(v, body, meta);
    case 'ShipStaticData': {
      setName(v, body.Name);
      if (body.Type) v.type = body.Type;
      const cs = clean(body.CallSign);
      if (cs) v.callsign = cs;
      if (body.ImoNumber) v.imo = body.ImoNumber;
      setDims(v, body.Dimension);
      if (body.MaximumStaticDraught) v.draught = body.MaximumStaticDraught;
      v.dest = clean(body.Destination) || v.dest;
      const e = body.Eta || {};
      v.eta = e.Month && e.Day && e.Hour < 24 && e.Minute < 60 ? { m: e.Month, d: e.Day, h: e.Hour, min: e.Minute } : null;
      v.staticAt = Date.now();
      return;
    }
    case 'StaticDataReport': {
      v.classB = true;
      if (body.ReportA?.Valid) setName(v, body.ReportA.Name);
      if (body.ReportB?.Valid) {
        if (body.ReportB.ShipType) v.type = body.ReportB.ShipType;
        const cs = clean(body.ReportB.CallSign);
        if (cs) v.callsign = cs;
        setDims(v, body.ReportB.Dimension);
      }
      v.staticAt = Date.now();
      return;
    }
  }
}

// ---- aisstream connection -----------------------------------------------------

let ws = null, backoff = 5000;
function boxOf(a) {
  const dLat = a.radius / 60, dLon = a.radius / (60 * Math.cos(a.lat * RAD));
  return [[a.lat - dLat, a.lon - dLon], [a.lat + dLat, a.lon + dLon]];
}
function connect() {
  if (!KEY) return (stats.error = 'AISSTREAM_KEY is not set in .env');
  if (!AREAS.length) return (stats.error = 'Set LOCATIONS (or AREA_LAT / AREA_LON) in .env');
  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.onopen = () => {
    // Must subscribe within 3 s of connecting.
    ws.send(JSON.stringify({ APIKey: KEY, BoundingBoxes: AREAS.map(boxOf),
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'] }));
    Object.assign(stats, { connected: true, since: Date.now(), error: null });
    backoff = 5000;
    log('connected to aisstream');
  };
  ws.onmessage = async (e) => {
    try {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : await e.data.text());
      if (m.error) {
        stats.error = m.error;
        log('aisstream error:', m.error);
        return;
      }
      onMessage(m);
    } catch (err) {}
  };
  ws.onclose = () => {
    stats.connected = false;
    stats.reconnects++;
    log(`aisstream closed; reconnecting in ${backoff / 1000} s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 300_000);
  };
  ws.onerror = (e) => {
    stats.error = e?.message || 'websocket error';
  };
}
// aisstream sometimes goes quiet without closing; reconnect if nothing for 5 minutes.
setInterval(() => {
  if (stats.connected && Date.now() - stats.lastMsg > 300_000) {
    log('no AIS messages for 5 min; reconnecting');
    try {
      ws.close();
    } catch (e) {}
  }
}, 60_000);

function save() {
  const now = Date.now();
  for (const [k, v] of vessels) if (now - Math.max(v.staticAt || 0, v.posAt || 0) > KEEP_STATIC_MS) vessels.delete(k);
  writeJson(VESSELS_FILE, [...vessels.values()].map(({ track, ...v }) => ({ ...v, track: now - (v.posAt || 0) < KEEP_POSITION_MS ? track : [] })));
}

// ---- alerts ----------------------------------------------------------------
// Warships and cruise ships entering a harbour: crossing into ALERT radius around a chosen location after having been
// seen outside it (so ships already in port when the monitor starts never alert). Sent to Home Assistant's webhook.

const DEFAULT_SETTINGS = {
  warships: true,
  cruise: true,
  coastguard: false,
  radius: num('ALERT_RADIUS_NM', 6), // nm around each harbour location
  harbours: LOCATIONS.length ? [LOCATIONS[0].name] : [],
  cooldownHours: 12,
};
let settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
let alerts = readJson(ALERTS_FILE, []);

function alertKind(v) {
  const k = classify(v);
  if (k.cls === 'mil' && settings.warships) return { kind: 'warship', k };
  if (k.cls === 'com' && k.sub === 'Cruise ship' && settings.cruise) return { kind: 'cruise', k };
  if (k.cls === 'gov' && k.sub === 'Coast Guard' && settings.coastguard) return { kind: 'coastguard', k };
  return null;
}

function checkHarbours(v) {
  if (!settings.harbours.length) return;
  v.harb ||= {};
  for (const name of settings.harbours) {
    const h = LOCATIONS.find((l) => l.name === name);
    if (!h) continue;
    const st = (v.harb[name] ||= {});
    const d = dist(h.lat, h.lon, v.lat, v.lon);
    if (d > settings.radius) {
      st.out = Date.now();
      st.alerted = false;
      continue;
    }
    if (!st.out || Date.now() - st.out > 6 * 3600_000 || st.alerted) continue; // must have been outside recently
    const a = alertKind(v);
    if (!a) continue; // type may still arrive while it's inside
    st.alerted = true;
    if (alerts.some((x) => x.mmsi === v.mmsi && x.harbour === name && Date.now() - x.t < settings.cooldownHours * 3600_000)) continue;
    sendAlert(v, a, h, d);
  }
}

const FLAGNAME = (() => {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    return (cc) => (cc ? dn.of(cc) : '');
  } catch (e) {
    return (cc) => cc;
  }
})();

function sendAlert(v, a, h, d) {
  const name = v.name || `MMSI ${v.mmsi}`, flag = flagOf(v.mmsi);
  const what = a.kind === 'warship' ? (a.k.navy ? `${a.k.navy} warship` : 'Warship') : a.kind === 'cruise' ? 'Cruise ship' : 'Coast Guard ship';
  const icon = a.kind === 'warship' ? '⚓' : a.kind === 'cruise' ? '🛳️' : '🛟';
  const bits = [a.k.sub && a.k.sub !== 'Military' && a.kind !== 'cruise' ? a.k.sub : '', v.length ? `${v.length} m` : '', FLAGNAME(flag)].filter(Boolean).join(' · ');
  const move = [v.sog != null ? `${v.sog.toFixed(1)} kn` : '', `${d.toFixed(1)} nm from ${h.name}`, v.dest ? `destination ${v.dest}` : ''].filter(Boolean).join(', ');
  return send({
    kind: a.kind, mmsi: v.mmsi, harbour: h.name, priority: 'high', tag: `ais-${a.kind}-${v.mmsi}`,
    title: `${icon} ${what} entering ${h.name}`,
    message: `${name}${bits ? ` · ${bits}` : ''}\n${move}`,
  });
}

async function send(alert) {
  const rec = { t: Date.now(), ...alert };
  alerts.push(rec);
  alerts = alerts.slice(-200);
  writeJson(ALERTS_FILE, alerts);
  log('alert', alert.kind, alert.title, '|', alert.message.replace(/\n/g, ' | '));
  if (!HA_WEBHOOK) return rec;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(HA_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alert), signal: ctl.signal });
    clearTimeout(to);
    rec.sent = r.ok;
  } catch (e) {
    rec.sent = false;
    log('webhook failed:', e.message);
  }
  writeJson(ALERTS_FILE, alerts);
  return rec;
}

function updateSettings(p) {
  for (const k of ['warships', 'cruise', 'coastguard']) if (typeof p[k] === 'boolean') settings[k] = p[k];
  for (const [k, max] of [['radius', 50], ['cooldownHours', 168]]) {
    const n = Number(p[k]);
    if (p[k] !== undefined && Number.isFinite(n) && n > 0 && n <= max) settings[k] = n;
  }
  if (Array.isArray(p.harbours)) settings.harbours = p.harbours.filter((n) => LOCATIONS.some((l) => l.name === n));
  writeJson(SETTINGS_FILE, settings);
  return settings;
}

// ---- HTTP ------------------------------------------------------------------

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 50_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}
function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(obj));
}
function publicVessel(v, c) {
  const k = classify(v);
  const out = {
    mmsi: v.mmsi, name: v.name || '', callsign: v.callsign || '', imo: v.imo || null, type: v.type ?? null, typeLabel: typeLabel(v.type),
    cls: k.cls, sub: k.sub, navy: k.navy || null, flag: flagOf(v.mmsi), length: v.length || null, beam: v.beam || null, draught: v.draught || null,
    dest: v.dest || '', eta: v.eta || null, lat: v.lat, lon: v.lon, sog: v.sog ?? null, cog: v.cog ?? null, hdg: v.hdg ?? null,
    status: v.status ?? null, classB: !!v.classB, posAge: v.posAt ? Math.round((Date.now() - v.posAt) / 1000) : null,
    staticAge: v.staticAt ? Math.round((Date.now() - v.staticAt) / 1000) : null,
  };
  if (c && v.lat !== undefined) {
    out.dist = Math.round(dist(c.lat, c.lon, v.lat, v.lon) * 100) / 100;
    out.brg = Math.round(bearing(c.lat, c.lon, v.lat, v.lon));
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const center = () => {
    const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
    return url.searchParams.has('lat') && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : LOCATIONS[0] || AREAS[0];
  };
  if (p === '/api/status' || p === '/api/config') {
    const live = [...vessels.values()].filter((v) => v.posAt && Date.now() - v.posAt < KEEP_POSITION_MS).length;
    return sendJson(res, {
      ok: stats.connected && Date.now() - stats.lastMsg < 120_000, ...stats, key: !!KEY, areas: AREAS,
      locations: LOCATIONS, closest: CLOSEST, vessels: live, known: vessels.size,
    });
  }
  if (p === '/api/vessels') {
    const c = center(), n = Math.min(500, Number(url.searchParams.get('n')) || CLOSEST);
    const live = [...vessels.values()].filter((v) => v.lat !== undefined && Date.now() - v.posAt < KEEP_POSITION_MS);
    const list = live.map((v) => publicVessel(v, c)).sort((a, b) => a.dist - b.dist);
    const counts = {};
    for (const v of list.slice(0, n)) counts[v.cls] = (counts[v.cls] || 0) + 1;
    return sendJson(res, { center: c, total: live.length, counts, vessels: list.slice(0, n) });
  }
  const m = /^\/api\/vessel\/(\d{9})$/.exec(p);
  if (m) {
    const v = vessels.get(Number(m[1]));
    if (!v) return sendJson(res, { error: 'unknown vessel' }, 404);
    return sendJson(res, { ...publicVessel(v, center()), track: v.track.map(([t, lat, lon, sog]) => ({ t, lat, lon, sog })) });
  }
  if (p === '/api/settings' && req.method === 'GET') return sendJson(res, { ...settings, webhook: !!HA_WEBHOOK });
  if (p === '/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
    try {
      return sendJson(res, { ...updateSettings(await body(req)), webhook: !!HA_WEBHOOK });
    } catch (e) {
      return sendJson(res, { error: e.message }, 400);
    }
  }
  if (p === '/api/alerts') return sendJson(res, alerts.slice(-100).reverse());
  if (p === '/api/test-alert' && req.method === 'POST') {
    const t = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return sendJson(res, await send({ kind: 'test', priority: 'normal', tag: 'ais-test', title: '🚢 Ship alerts are working', message: `Test from ais-monitor at ${t}.` }));
  }
  if (p === '/' || p === '/api') return sendJson(res, { service: 'ais-monitor', endpoints: ['/api/status', '/api/vessels?lat=&lon=&n=', '/api/vessel/<mmsi>', '/api/settings', '/api/alerts', '/api/test-alert'] });
  sendJson(res, { error: 'not found' }, 404);
});

server.listen(PORT, () => log(`ais-monitor on :${PORT}, ${AREAS.length} areas, ${LOCATIONS.length} locations, ${vessels.size} vessels remembered`));
connect();
setInterval(save, 120_000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    save();
    process.exit(0);
  });
}
