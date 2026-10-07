// Ships card for Home Assistant (custom:ships-card). See README.md.
// The vessels closest to a chosen location from ais-monitor (AIS via aisstream.io), on a map, in a sortable list and
// one at a time, classified as military, government, commercial, service, fishing or private.
// Install: copy to /config/www/, add /local/ships-card.js as a JavaScript module resource.

const DEFAULTS = {
  title: "Ships",
  monitor: [], // ais-monitor, e.g. ["http://192.168.1.20:7110", "http://100.x.y.z:7110"] (LAN, then VPN)
  n: 50, // how many closest vessels
  rings: [1, 2, 5, 10, 25], // nm around the chosen location
  refresh: 10, // seconds
  map_height: null,
};

const NM = 3440.065;
const RAD = Math.PI / 180;
const TABS = [["map", "Map", "mdi:map"], ["list", "Vessels", "mdi:format-list-bulleted"], ["vessel", "Vessel", "mdi:ferry"]];
const CLASSES = [
  ["mil", "Military", "mdi:shield-star", "#d4a72c"],
  ["gov", "Government", "mdi:lifebuoy", "#ff7043"],
  ["com", "Commercial", "mdi:ferry", "#4ea1ff"],
  ["svc", "Service", "mdi:ship-wheel", "#26a69a"],
  ["fish", "Fishing", "mdi:fish", "#8bc34a"],
  ["priv", "Private", "mdi:sail-boat", "#b07cf0"],
  ["other", "Other", "mdi:shape-outline", "#9e9e9e"],
  ["unk", "Unknown", "mdi:help-circle-outline", "#7a7a7a"],
];
const CLASS = Object.fromEntries(CLASSES.map(([k, l, i, c]) => [k, { k, l, i, c }]));
const STATUS = {
  0: "Under way", 1: "At anchor", 2: "Not under command", 3: "Restricted manoeuvrability", 4: "Constrained by draught", 5: "Moored",
  6: "Aground", 7: "Fishing", 8: "Sailing", 11: "Towing astern", 12: "Pushing ahead", 14: "AIS-SART",
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString([], { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (b) => COMPASS[Math.round((((b % 360) + 360) % 360) / 22.5) % 16];
const flagEmoji = (cc) => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "");
let regionNames = null;
function country(cc) {
  try {
    regionNames ||= new Intl.DisplayNames(["en"], { type: "region" });
    return cc ? regionNames.of(cc) : "";
  } catch (e) {
    return cc;
  }
}
function ago(s) {
  if (s === null || s === undefined) return "–";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
// Reported ETA (UTC month/day/hour/minute, no year) -> Date, this year or next.
function etaDate(e) {
  if (!e) return null;
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), e.m - 1, e.d, e.h, e.min));
  if (d - now < -180 * 86400000) d = new Date(Date.UTC(now.getUTCFullYear() + 1, e.m - 1, e.d, e.h, e.min));
  return d;
}
function destPoint(lat, lon, brg, d) {
  const δ = d / NM, θ = brg * RAD, φ1 = lat * RAD, λ1 = lon * RAD;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 / RAD, λ2 / RAD];
}
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => {
  const s = Math.sin(Math.max(-85, Math.min(85, lat)) * RAD);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const unx = (x) => x * 360 - 180;
const uny = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD);

async function getJSON(url, opt = {}, ms = 8000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

// Hull pointing up (bow at -y), for moving vessels; stationary ones are drawn as dots.
const HULL = "M0,-11C2.6,-7 3.6,-3 3.6,1L3.6,9L-3.6,9L-3.6,1C-3.6,-3 -2.6,-7 0,-11Z";

class ShipsCard extends HTMLElement {
  setConfig(config) {
    this._config = { ...DEFAULTS, ...(config || {}) };
    if (!Array.isArray(this._config.monitor)) this._config.monitor = this._config.monitor ? [this._config.monitor] : [];
    if (!this._config.monitor.length) throw new Error("ships-card: set `monitor` (the ais-monitor URL)");
    const get = (k, d) => {
      try {
        return localStorage.getItem("ships-card:" + k) ?? d;
      } catch (e) {
        return d;
      }
    };
    this._tab = get("tab", "map");
    this._loc = get("loc", "");
    this._labels = get("labels", "1") === "1";
    this._sort = get("sort", "dist");
    this._sortDir = Number(get("sortdir", "1"));
    this._listCls = get("listcls", "all");
    this._fCls = new Set(get("mapcls", "").split(",").filter(Boolean));
    this._vessels = [];
    this._view = null;
  }

  static getStubConfig() {
    return { monitor: ["http://192.168.1.20:7110"] };
  }
  getCardSize() {
    return 12;
  }
  getGridOptions() {
    return { columns: "full", min_columns: 6, rows: "auto" };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    const dark = !!hass.themes?.darkMode;
    if (dark !== this._dark) {
      this._dark = dark;
      this._tiles?.clear();
      if (this.$("tiles")) this.$("tiles").innerHTML = "";
      this._renderMap();
    }
  }

  connectedCallback() {
    if (!this._built && this._config) this._build();
    this._start();
    if (!this._ro) this._ro = new ResizeObserver(() => this._renderMap());
    if (this._built) this._ro.observe(this.$("map"));
  }
  disconnectedCallback() {
    for (const t of this._timers || []) clearInterval(t);
    this._timers = [];
    this._ro?.disconnect();
  }
  $(id) {
    return this.shadowRoot.getElementById(id);
  }
  _save(k, v) {
    try {
      localStorage.setItem("ships-card:" + k, String(v));
    } catch (e) {}
  }

  // ---- data ----------------------------------------------------------------------------------

  async _mon(path) {
    const all = this._config.monitor;
    const urls = this._base ? [this._base, ...all.filter((u) => u !== this._base)] : all;
    let err;
    for (const u of urls) {
      try {
        const d = await getJSON(u.replace(/\/$/, "") + path, {}, 6000);
        this._base = u;
        return d;
      } catch (e) {
        err = e;
      }
    }
    this._base = null;
    throw err;
  }

  _start() {
    if (this._timers?.length) return;
    const every = (fn, ms) => {
      fn();
      return setInterval(() => document.visibilityState === "visible" && fn(), ms);
    };
    this._timers = [every(() => this._loadStatus(), 30000), every(() => this._poll(), Math.max(5, this._config.refresh) * 1000)];
  }

  async _loadStatus() {
    try {
      this._status = await this._mon("/api/status");
      this._err = null;
    } catch (e) {
      this._err = e.message || String(e);
    }
    this._renderHead();
  }

  // The chosen location: one of the monitor's LOCATIONS, or a point picked with "Centre of map".
  _center() {
    const locs = this._status?.locations || [];
    if (this._loc.startsWith("pt:")) {
      const [lat, lon] = this._loc.slice(3).split(",").map(Number);
      if (Number.isFinite(lat)) return { name: "Map centre", lat, lon };
    }
    return locs.find((l) => l.name === this._loc) || locs[0] || null;
  }

  async _poll() {
    if (!this._status) await this._loadStatus();
    const c = this._center();
    const q = c ? `?lat=${c.lat}&lon=${c.lon}&n=${this._config.n}` : `?n=${this._config.n}`;
    try {
      const d = await this._mon("/api/vessels" + q);
      this._vessels = d.vessels;
      this._total = d.total;
      this._err = null;
      this._byMmsi = new Map(d.vessels.map((v) => [v.mmsi, v]));
      if (this._sel) await this._loadSel();
    } catch (e) {
      this._err = e.message || String(e);
    }
    this._renderAll();
  }

  async _loadSel() {
    const c = this._center();
    try {
      this._selData = await this._mon(`/api/vessel/${this._sel}${c ? `?lat=${c.lat}&lon=${c.lon}` : ""}`);
    } catch (e) {}
  }

  // ---- UI ------------------------------------------------------------------------------------

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config;
    this.shadowRoot.innerHTML = `
      <style>
        :host { --sh-good: var(--success-color, #3fb68b); --sh-warn: var(--warning-color, #e5a93a); --sh-bad: var(--error-color, #e5534b);
                --sh-h: ${c.map_height ? Number(c.map_height) + "px" : "max(440px, calc(100vh - 230px))"}; }
        ha-card { padding: 16px; overflow: hidden; }
        .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .title { display: flex; align-items: center; gap: 8px; font-size: 1.25em; font-weight: 500; }
        .title ha-icon { color: var(--primary-color); }
        .pill { font-size: .8em; padding: 3px 10px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
        .pill.ok { background: color-mix(in srgb, var(--sh-good) 18%, transparent); color: var(--sh-good); }
        .pill.warn { background: color-mix(in srgb, var(--sh-warn) 18%, transparent); color: var(--sh-warn); }
        .pill.bad { background: color-mix(in srgb, var(--sh-bad) 18%, transparent); color: var(--sh-bad); }
        .pill.dim { background: var(--secondary-background-color); color: var(--secondary-text-color); font-weight: 500; }
        .meta { margin-left: auto; font-size: .78em; color: var(--secondary-text-color); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        select.loc { font: inherit; font-size: .85em; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--divider-color);
                     background: var(--card-background-color, #fff); color: var(--primary-text-color); cursor: pointer; }
        .tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--secondary-background-color); margin: 12px 0; width: fit-content; max-width: 100%; overflow-x: auto; }
        .tabs button { border: none; background: transparent; color: var(--secondary-text-color); font: inherit; font-size: .88em; padding: 6px 14px;
                       border-radius: 999px; cursor: pointer; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
        .tabs button ha-icon { --mdc-icon-size: 18px; }
        .tabs button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
        .tabs .n { font-size: .8em; opacity: .8; }
        .pane { display: none; } .pane.on { display: block; }
        .muted { color: var(--secondary-text-color); }
        .good { color: var(--sh-good); } .warn { color: var(--sh-warn); } .bad { color: var(--sh-bad); }
        a { color: var(--primary-color); }

        .map { position: relative; height: var(--sh-h); border-radius: 12px; overflow: hidden; background: var(--secondary-background-color);
               touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; }
        .map.drag { cursor: grabbing; }
        #tiles { position: absolute; inset: 0; z-index: 0; }
        #tiles img { position: absolute; left: 0; top: 0; pointer-events: none; }
        #ov { position: absolute; inset: 0; width: 100%; height: 100%; }
        .ring { fill: none; stroke: var(--sh-ring); stroke-width: 1.2; }
        .ringl { fill: var(--sh-ring-t); font-size: 11px; font-weight: 600; paint-order: stroke; stroke: var(--sh-halo); stroke-width: 3px; }
        .lbl { font-size: 11px; font-weight: 600; fill: var(--sh-text); paint-order: stroke; stroke: var(--sh-halo); stroke-width: 3px; stroke-linejoin: round; }
        .lbl2 { font-size: 10px; font-weight: 500; fill: var(--sh-text2); paint-order: stroke; stroke: var(--sh-halo); stroke-width: 3px; }
        .selring { fill: none; stroke: var(--primary-color); stroke-width: 2; }
        .trk { fill: none; stroke: var(--primary-color); stroke-width: 2.2; stroke-dasharray: 4 3; opacity: .85; }
        .ctrls { position: absolute; top: 10px; right: 10px; display: flex; flex-direction: column; gap: 6px; }
        .ctrls button { width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--divider-color); cursor: pointer; position: relative;
               background: var(--card-background-color, #fff); color: var(--primary-text-color); display: flex; align-items: center; justify-content: center; padding: 0; }
        .ctrls button ha-icon { --mdc-icon-size: 20px; }
        .ctrls button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        .ctrls .badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; border-radius: 8px; background: var(--sh-warn); color: #000;
                        font-size: 10px; font-weight: 700; display: none; align-items: center; justify-content: center; padding: 0 3px; }
        .ctrls .badge.on { display: flex; }
        .legend { position: absolute; left: 10px; bottom: 10px; background: color-mix(in srgb, var(--card-background-color, #fff) 88%, transparent);
                  border-radius: 8px; padding: 6px 8px; font-size: 10px; color: var(--secondary-text-color); display: flex; flex-wrap: wrap; gap: 4px 10px; max-width: calc(100% - 160px); }
        .legend span { display: inline-flex; align-items: center; gap: 4px; }
        .legend i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
        .attr { position: absolute; right: 6px; bottom: 4px; font-size: 9px; color: var(--secondary-text-color);
                background: color-mix(in srgb, var(--card-background-color, #fff) 70%, transparent); padding: 1px 4px; border-radius: 4px; }
        .attr a { color: inherit; }
        .pop, .fpanel { position: absolute; top: 10px; background: var(--card-background-color, #fff); border-radius: 12px; z-index: 2;
               box-shadow: var(--ha-card-box-shadow, 0 2px 10px rgba(0,0,0,.25)); padding: 10px 12px; display: none; cursor: default; }
        .pop { left: 10px; width: min(310px, calc(100% - 70px)); }
        .fpanel { right: 56px; width: min(300px, calc(100% - 76px)); }
        .pop.on, .fpanel.on { display: block; }
        .pop .nm { font-size: 1.1em; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .pop .x { margin-left: auto; cursor: pointer; color: var(--secondary-text-color); --mdc-icon-size: 18px; }
        .pop .sub { font-size: .82em; color: var(--secondary-text-color); margin: 2px 0 6px; }
        .kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px; font-size: .78em; }
        .kv b { display: block; font-size: 1.12em; font-variant-numeric: tabular-nums; }
        .kv span { color: var(--secondary-text-color); }
        .acts { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
        .btn { border: 1px solid var(--divider-color); background: var(--card-background-color, #fff); color: var(--primary-text-color); font: inherit; font-size: .82em;
               padding: 5px 10px; border-radius: 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
        .btn.pri { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        .btn ha-icon { --mdc-icon-size: 16px; }
        .ctag { display: inline-flex; align-items: center; gap: 4px; font-size: .74em; font-weight: 600; padding: 2px 8px 2px 6px; border-radius: 999px;
                color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); white-space: nowrap; vertical-align: middle; }
        .ctag ha-icon { --mdc-icon-size: 14px; }
        .chips { display: flex; gap: 6px; flex-wrap: wrap; }
        .chips button { border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); font: inherit; font-size: .8em;
                        padding: 4px 10px; border-radius: 999px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
        .chips button ha-icon { --mdc-icon-size: 15px; color: var(--c); }
        .chips button.on { border-color: var(--c, var(--primary-color)); background: color-mix(in srgb, var(--c, var(--primary-color)) 18%, transparent); }
        .chips .n { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .fpanel h5 { margin: 4px 0 8px; font-size: .72em; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color); display: flex; }
        .fpanel h5 a { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; cursor: pointer; }
        .fnote { font-size: .75em; color: var(--secondary-text-color); margin-top: 8px; }

        .scroll { overflow: auto; max-height: var(--sh-h); margin-top: 10px; border-radius: 12px; background: var(--secondary-background-color); }
        table { width: 100%; border-collapse: collapse; font-size: .85em; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--divider-color); white-space: nowrap; }
        th { color: var(--secondary-text-color); font-weight: 500; position: sticky; top: 0; background: var(--secondary-background-color); cursor: pointer; z-index: 1; }
        th.r, td.r { text-align: right; font-variant-numeric: tabular-nums; }
        th.on { color: var(--primary-color); }
        tbody tr { cursor: pointer; }
        tbody tr:hover { background: color-mix(in srgb, var(--primary-color) 8%, transparent); }
        tbody tr.sel { background: color-mix(in srgb, var(--primary-color) 16%, transparent); }
        tbody tr.stale td { opacity: .55; }
        td.pin, th.pin { width: 30px; padding: 2px 0 2px 6px; }
        td.pin button { border: none; background: transparent; color: var(--primary-color); cursor: pointer; padding: 3px; border-radius: 8px; display: flex; }
        td.pin button:hover { background: color-mix(in srgb, var(--primary-color) 18%, transparent); }
        td.pin ha-icon { --mdc-icon-size: 20px; }
        .fl { font-size: 1.15em; margin-right: 6px; }

        .vhead { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
        .vflag { font-size: 3.2em; line-height: 1; }
        .vname { font-size: 1.9em; font-weight: 600; line-height: 1.1; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .vname .ctag { font-size: .42em; } .vname .pill { font-size: .42em; }
        .vsub { font-size: .9em; color: var(--secondary-text-color); margin-top: 3px; }
        .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-top: 12px; }
        .tile { background: var(--secondary-background-color); border-radius: 12px; padding: 9px 11px; min-width: 0; }
        .tile .l { font-size: .78em; color: var(--secondary-text-color); }
        .tile .v { font-size: 1.3em; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tile .v small { font-size: .55em; font-weight: 500; color: var(--secondary-text-color); margin-left: 2px; }
        .tile .s { font-size: .72em; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .panel { background: var(--secondary-background-color); border-radius: 12px; padding: 10px 12px; margin-top: 10px; }
        .panel h4 { margin: 0 0 6px; font-size: .75em; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color); }
        .ch svg { display: block; width: 100%; }
        .ch .grid { stroke: var(--divider-color); stroke-width: 1; }
        .ch .ax { fill: var(--secondary-text-color); font-size: 10px; }
        .empty { padding: 30px 10px; text-align: center; color: var(--secondary-text-color); }
        .picks { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 14px; }
        .listbar { margin-top: 10px; font-size: .8em; color: var(--secondary-text-color); }
      </style>
      <ha-card>
        <div class="head">
          <div class="title"><ha-icon icon="mdi:ferry"></ha-icon><span>${esc(c.title)}</span></div>
          <span class="pill dim" id="state">Connecting…</span>
          <select class="loc" id="loc" title="Closest vessels to"></select>
          <span class="meta" id="meta"></span>
        </div>
        <div class="tabs" id="tabs">${TABS.map(([k, l, i]) => `<button data-t="${k}"><ha-icon icon="${i}"></ha-icon><span>${l}</span><span class="n" id="n-${k}"></span></button>`).join("")}</div>
        <div class="pane" id="p-map">
          <div class="map" id="map">
            <div id="tiles"></div>
            <svg id="ov"></svg>
            <div class="ctrls">
              <button id="zin" title="Zoom in"><ha-icon icon="mdi:plus"></ha-icon></button>
              <button id="zout" title="Zoom out"><ha-icon icon="mdi:minus"></ha-icon></button>
              <button id="home" title="Back to the location"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>
              <button id="lbl" title="Labels"><ha-icon icon="mdi:label-outline"></ha-icon></button>
              <button id="flt" title="Filter by class"><ha-icon icon="mdi:filter-variant"></ha-icon><span class="badge" id="fbadge"></span></button>
            </div>
            <div class="pop" id="pop"></div>
            <div class="fpanel" id="fpanel"></div>
            <div class="legend">${CLASSES.slice(0, 6).map(([, l, , col]) => `<span><i style="background:${col}"></i>${l}</span>`).join("")}<span>● stopped</span><span>▲ moving</span></div>
            <div class="attr">AIS: aisstream.io · Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></div>
          </div>
        </div>
        <div class="pane" id="p-list">
          <div class="chips" id="lchips"></div>
          <div class="scroll"><table><thead id="lhead"></thead><tbody id="lbody"></tbody></table></div>
          <div class="listbar" id="lfoot"></div>
        </div>
        <div class="pane" id="p-vessel"><div id="vessel"></div></div>
      </ha-card>`;

    this.$("tabs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-t]");
      if (b) this._setTab(b.dataset.t);
    });
    this.$("loc").addEventListener("change", (e) => {
      let v = e.target.value;
      if (v === "__map") {
        const vw = this._view || this._defaultView();
        v = vw ? `pt:${uny(vw.y).toFixed(4)},${unx(vw.x).toFixed(4)}` : "";
      }
      this._loc = v;
      this._save("loc", v);
      this._view = null;
      this._poll();
    });
    this.$("zin").addEventListener("click", () => this._zoomBy(1));
    this.$("zout").addEventListener("click", () => this._zoomBy(-1));
    this.$("home").addEventListener("click", () => {
      this._view = null;
      this._renderMap();
    });
    this.$("lbl").addEventListener("click", () => {
      this._labels = !this._labels;
      this._save("labels", this._labels ? 1 : 0);
      this._renderMap();
    });
    this.$("flt").addEventListener("click", () => {
      this._fOpen = !this._fOpen;
      this._renderMap();
    });
    this.$("fpanel").addEventListener("click", (e) => {
      const b = e.target.closest("[data-f]");
      if (!b) return;
      if (b.dataset.f === "reset") this._fCls.clear();
      else if (b.dataset.f === "close") this._fOpen = false;
      else this._fCls.has(b.dataset.v) ? this._fCls.delete(b.dataset.v) : this._fCls.add(b.dataset.v);
      this._save("mapcls", [...this._fCls].join(","));
      this._renderMap();
    });
    this.$("lchips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-c]");
      if (!b) return;
      this._listCls = b.dataset.c === this._listCls ? "all" : b.dataset.c;
      this._save("listcls", this._listCls);
      this._renderList();
    });
    this.$("lhead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-k]");
      if (!th) return;
      if (this._sort === th.dataset.k) this._sortDir = -this._sortDir;
      else {
        this._sort = th.dataset.k;
        this._sortDir = ["sog", "len"].includes(th.dataset.k) ? -1 : 1;
      }
      this._save("sort", this._sort);
      this._save("sortdir", this._sortDir);
      this._renderList();
    });
    this.$("lbody").addEventListener("click", (e) => {
      if (e.target.closest("[data-act]")) return;
      const tr = e.target.closest("tr[data-m]");
      if (!tr) return;
      this._select(Number(tr.dataset.m));
      this._setTab("vessel");
    });
    this.shadowRoot.addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]");
      if (!a) return;
      const act = a.dataset.act;
      if (act === "details") this._setTab("vessel");
      else if (act === "close") this._select(null);
      else if (act === "locate") this._locate(Number(a.dataset.m));
      else if (act === "pick") this._select(Number(a.dataset.m));
    });
    this._initMapInput();
    this._built = true;
    if (this.isConnected && this._ro) this._ro.observe(this.$("map"));
    this._setTab(this._tab);
  }

  _setTab(t) {
    if (!TABS.some(([k]) => k === t)) t = "map";
    this._tab = t;
    this._save("tab", t);
    for (const b of this.$("tabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.t === t);
    for (const [k] of TABS) this.$("p-" + k).classList.toggle("on", k === t);
    this._renderAll();
  }

  async _select(mmsi) {
    this._sel = mmsi || null;
    this._selData = mmsi ? this._byMmsi?.get(mmsi) || null : null;
    this._renderAll();
    if (mmsi) {
      await this._loadSel();
      this._renderAll();
    }
  }

  _locate(mmsi) {
    const v = this._byMmsi?.get(mmsi);
    if (!v) return;
    this._select(mmsi);
    const z = this._view?.z || this._defaultView()?.z || 12;
    this._view = { x: mx(v.lon), y: my(v.lat), z: Math.max(z, 13) };
    this._flash = { mmsi, until: Date.now() + 3500 };
    setTimeout(() => this._renderMap(), 3600);
    this._setTab("map");
  }

  _renderAll() {
    if (!this._built) return;
    this._renderHead();
    if (this._tab === "map") this._renderMap();
    if (this._tab === "list") this._renderList();
    if (this._tab === "vessel") this._renderVessel();
  }

  _renderHead() {
    if (!this._built) return;
    const st = this.$("state"), s = this._status;
    if (this._err) {
      st.className = "pill bad";
      st.textContent = "Can't reach ais-monitor";
      st.title = this._err;
    } else if (s && !s.ok) {
      st.className = "pill warn";
      st.textContent = s.error ? "AIS feed problem" : "AIS feed quiet";
      st.title = s.error || "No AIS messages in the last 2 minutes";
    } else if (this._vessels) {
      st.className = "pill ok";
      st.textContent = `${this._vessels.length} closest of ${this._total ?? "?"}`;
      st.title = "";
    }
    const sel = this.$("loc"), locs = s?.locations || [], cur = this._center();
    const opts = locs.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join("") +
      (this._loc.startsWith("pt:") ? `<option value="${esc(this._loc)}">Map centre (${esc(this._loc.slice(3))})</option>` : "") +
      `<option value="__map">Centre of the map…</option>`;
    if (sel.dataset.o !== opts) {
      sel.innerHTML = opts;
      sel.dataset.o = opts;
    }
    sel.value = this._loc.startsWith("pt:") ? this._loc : cur?.name || "";
    this.$("meta").innerHTML = s ? `<span>${num(s.vessels)} vessels in the area</span><span>${s.ok ? "● live" : "○"} aisstream</span>` : "";
    this.$("n-list").textContent = this._vessels?.length || "";
    const v = this._sel && (this._byMmsi?.get(this._sel) || this._selData);
    this.$("n-vessel").textContent = v ? v.name || v.mmsi : "";
  }

  _tag(v) {
    const c = CLASS[v.cls] || CLASS.unk;
    const label = v.cls === "mil" && v.navy ? v.navy : c.l;
    return `<span class="ctag" style="--c:${c.c}" title="${esc(v.sub || c.l)}"><ha-icon icon="${c.i}"></ha-icon>${esc(label)}</span>`;
  }

  // ---- map -----------------------------------------------------------------------------------

  _size() {
    const el = this.$("map");
    return [el.clientWidth, el.clientHeight];
  }
  // Default view: the location in the middle, zoomed to fit most of the listed vessels (the closest 80%).
  _defaultView() {
    const [w, h] = this._size(), c = this._center();
    if (!c || !w) return null;
    const ds = this._vessels.map((v) => v.dist || 0).sort((a, b) => a - b);
    const far = ds.length ? ds[Math.floor((ds.length - 1) * 0.8)] : 5;
    const r = Math.min(Math.max(...this._config.rings), Math.max(1, far * 1.15));
    const span = Math.abs(my(destPoint(c.lat, c.lon, 0, r)[0]) - my(c.lat));
    const z = Math.max(3, Math.min(16, Math.log2((Math.min(w, h) / 2 - 24) / (span * 256))));
    return { x: mx(c.lon), y: my(c.lat), z };
  }
  _pt(lat, lon, v, w, h) {
    const S = 256 * 2 ** v.z;
    return [(mx(lon) - v.x) * S + w / 2, (my(lat) - v.y) * S + h / 2];
  }
  _zoomBy(dz, px, py) {
    const [w, h] = this._size();
    const v = this._view || this._defaultView();
    if (!v) return;
    const z = Math.max(3, Math.min(17, v.z + dz));
    if (Math.abs(z - v.z) < 1e-3) return;
    if (px === undefined) [px, py] = [w / 2, h / 2];
    const S = 256 * 2 ** v.z, S2 = 256 * 2 ** z;
    const ux = v.x + (px - w / 2) / S, uy = v.y + (py - h / 2) / S;
    this._view = { x: ux - (px - w / 2) / S2, y: uy - (py - h / 2) / S2, z };
    this._frame();
  }
  _frame() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._renderMap();
    });
  }
  _initMapInput() {
    const el = this.$("map");
    const pts = new Map();
    let moved = 0, pinch = null;
    const skip = (e) => e.target.closest(".ctrls, .pop, .attr, .fpanel");
    el.addEventListener("pointerdown", (e) => {
      if (skip(e)) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      moved = 0;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const [px, py] = pts.get(e.pointerId);
      const dx = e.clientX - px, dy = e.clientY - py;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const v = this._view || (this._view = this._defaultView());
      if (!v) return;
      if (pts.size === 1) {
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved < 4) return;
        el.classList.add("drag");
        const S = 256 * 2 ** v.z;
        v.x -= dx / S;
        v.y -= dy / S;
        this._frame();
      } else if (pts.size === 2 && pinch) {
        moved = 99;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const r = el.getBoundingClientRect();
        this._zoomBy(Math.log2(d / pinch), (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
        pinch = d;
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      el.classList.remove("drag");
      if (pts.size === 0 && moved < 4 && e.type === "pointerup") {
        const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        let best = null, bd = 22;
        for (const [m, px, py] of this._hits || []) {
          const d = Math.hypot(px - x, py - y);
          if (d < bd) (bd = d), (best = m);
        }
        this._select(best);
      }
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", (e) => {
      if (e.target.closest(".pop, .fpanel")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      this._zoomBy(Math.max(-0.5, Math.min(0.5, -px / 250)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    el.addEventListener("dblclick", (e) => {
      if (skip(e)) return;
      const r = el.getBoundingClientRect();
      this._zoomBy(1, e.clientX - r.left, e.clientY - r.top);
    });
  }

  // Esri's gray canvas basemap (free, no key) plus its labels; tiles from the nearest whole zoom, scaled.
  _renderTiles(v, w, h) {
    const box = this.$("tiles");
    if (!this._tiles) this._tiles = new Map();
    const tz = Math.max(0, Math.min(16, Math.round(v.z))), n = 2 ** tz;
    const S = 256 * 2 ** v.z, T = S / n;
    const x0 = Math.floor((v.x * S - w / 2) / T), x1 = Math.floor((v.x * S + w / 2) / T);
    const y0 = Math.max(0, Math.floor((v.y * S - h / 2) / T)), y1 = Math.min(n - 1, Math.floor((v.y * S + h / 2) / T));
    const shade = this._dark ? "Dark" : "Light";
    const keep = new Set();
    for (const layer of ["Base", "Reference"]) {
      for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) {
          const wx = ((tx % n) + n) % n, key = `${layer}/${tz}/${tx}/${ty}`;
          keep.add(key);
          let img = this._tiles.get(key);
          if (!img) {
            img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            img.style.zIndex = layer === "Base" ? 0 : 1;
            img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${shade}_Gray_${layer}/MapServer/tile/${tz}/${ty}/${wx}`;
            this._tiles.set(key, img);
            box.appendChild(img);
          }
          const left = Math.round(tx * T - v.x * S + w / 2), top = Math.round(ty * T - v.y * S + h / 2);
          img.style.transform = `translate(${left}px, ${top}px)`;
          img.style.width = img.style.height = `${Math.round((tx + 1) * T - v.x * S + w / 2) - left}px`;
        }
      }
    }
    for (const [k, img] of this._tiles) if (!keep.has(k)) (img.remove(), this._tiles.delete(k));
  }

  _renderMap() {
    if (!this._built || this._tab !== "map") return;
    const [w, h] = this._size();
    if (!w || !h) return;
    const v = this._view || this._defaultView();
    if (!v) return;
    const map = this.$("map");
    map.style.setProperty("--sh-ring", this._dark ? "rgba(140,170,255,.5)" : "rgba(40,70,160,.45)");
    map.style.setProperty("--sh-ring-t", this._dark ? "#b4c6ff" : "#28469f");
    map.style.setProperty("--sh-halo", this._dark ? "rgba(0,0,0,.85)" : "rgba(255,255,255,.9)");
    map.style.setProperty("--sh-text", this._dark ? "#f2f2f2" : "#1d1d1d");
    map.style.setProperty("--sh-text2", this._dark ? "#c9c9c9" : "#444");
    this._renderTiles(v, w, h);
    this.$("lbl").classList.toggle("on", this._labels);
    const P = (lat, lon) => this._pt(lat, lon, v, w, h);
    const inView = ([x, y], m = 40) => x > -m && y > -m && x < w + m && y < h + m;
    let g = "";
    const c = this._center();
    if (c) {
      for (const r of this._config.rings) {
        let d = "";
        for (let b = 0; b <= 360; b += 6) {
          const [x, y] = P(...destPoint(c.lat, c.lon, b, r));
          d += `${b ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
        }
        g += `<path class="ring" d="${d}Z"/>`;
        const [lx, ly] = P(...destPoint(c.lat, c.lon, 0, r));
        if (inView([lx, ly], 0)) g += `<text class="ringl" x="${lx + 4}" y="${ly - 4}">${r} nm</text>`;
      }
      const [cx, cy] = P(c.lat, c.lon);
      g += `<g transform="translate(${cx},${cy})"><circle r="7" fill="none" stroke="var(--primary-color)" stroke-width="2.5"/><circle r="2.5" fill="var(--primary-color)"/></g>`;
    }
    // Selected vessel's track (last 2 h).
    const sd = this._selData;
    if (sd?.track?.length > 1) {
      g += `<path class="trk" d="${sd.track.map((p, i) => {
        const [x, y] = P(p.lat, p.lon);
        return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join("")}"/>`;
    }
    const shown = (x) => !this._fCls.size || this._fCls.has(x.cls) || x.mmsi === this._sel;
    const list = this._vessels.filter((x) => x.lat !== undefined && shown(x)).sort((a, b) => (a.mmsi === this._sel) - (b.mmsi === this._sel));
    this._hits = [];
    for (const x of list) {
      const p = P(x.lat, x.lon);
      if (!inView(p)) continue;
      const isSel = x.mmsi === this._sel, col = (CLASS[x.cls] || CLASS.unk).c;
      const stopped = x.status === 1 || x.status === 5 || (x.sog ?? 0) < 0.5;
      const rot = x.hdg ?? x.cog ?? 0;
      const sc = Math.max(0.8, Math.min(1.8, (x.length || 60) / 100));
      this._hits.push([x.mmsi, p[0], p[1]]);
      g += `<g transform="translate(${p[0].toFixed(1)},${p[1].toFixed(1)})"${x.posAge > 900 ? ` opacity=".5"` : ""}>`;
      if (isSel) g += `<circle class="selring" r="${14 * sc}"/>`;
      if (this._flash?.mmsi === x.mmsi && Date.now() < this._flash.until)
        g += `<circle r="16" fill="none" stroke="var(--primary-color)" stroke-width="3"><animate attributeName="r" values="12;42" dur="1.1s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="1.1s" repeatCount="indefinite"/></circle>`;
      g += stopped
        ? `<circle r="${(4.5 * sc).toFixed(1)}" fill="${col}" stroke="${this._dark ? "#000" : "#222"}" stroke-width="1"/>`
        : `<path d="${HULL}" transform="rotate(${Math.round(rot)}) scale(${sc.toFixed(2)})" fill="${col}" stroke="${this._dark ? "#000" : "#222"}" stroke-width=".9"/>`;
      // Stopped vessels crowd a harbour: label them only when zoomed in (or selected).
      if (isSel || (this._labels && (!stopped || v.z >= 13))) {
        g += `<text class="lbl" x="${10 * sc + 3}" y="-1">${esc(x.name || x.mmsi)}</text>`;
        if (!stopped || isSel) g += `<text class="lbl2" x="${10 * sc + 3}" y="11">${x.sog != null ? `${num(x.sog, 1)} kn` : ""}${x.dest && !stopped ? ` → ${esc(x.dest)}` : ""}</text>`;
      }
      g += `</g>`;
    }
    this.$("ov").innerHTML = g;
    this._renderPop();
    this._renderFilter();
  }

  _renderFilter() {
    const on = this._fCls.size > 0, badge = this.$("fbadge");
    badge.classList.toggle("on", on);
    badge.textContent = on ? this._fCls.size : "";
    this.$("flt").classList.toggle("on", !!this._fOpen);
    const panel = this.$("fpanel");
    panel.classList.toggle("on", !!this._fOpen);
    if (!this._fOpen) return;
    const cc = {};
    for (const x of this._vessels) cc[x.cls] = (cc[x.cls] || 0) + 1;
    const shown = this._vessels.filter((x) => !on || this._fCls.has(x.cls)).length;
    const html = `<h5>Show on the map${on ? `<a data-f="reset">Show all</a>` : ""}<a data-f="close" style="${on ? "margin-left:10px" : ""}">Close</a></h5>
      <div class="chips">${CLASSES.filter(([k]) => cc[k] || this._fCls.has(k)).map(([k, l, i, col]) =>
        `<button data-f="cls" data-v="${k}" class="${this._fCls.has(k) ? "on" : ""}" style="--c:${col}"><ha-icon icon="${i}"></ha-icon>${l} <span class="n">${cc[k] || 0}</span></button>`).join("")}</div>
      <div class="fnote">${on ? `Showing ${shown} of ${this._vessels.length}. ` : ""}The selected vessel always stays visible.</div>`;
    if (html !== this._fHtml) panel.innerHTML = this._fHtml = html;
  }

  _renderPop() {
    const pop = this.$("pop");
    const x = this._sel && (this._byMmsi?.get(this._sel) || this._selData);
    pop.classList.toggle("on", !!x);
    if (!x) return;
    pop.innerHTML = `
      <div class="nm"><span>${flagEmoji(x.flag)}</span>${esc(x.name || x.mmsi)}${this._tag(x)}<ha-icon class="x" icon="mdi:close" data-act="close"></ha-icon></div>
      <div class="sub">${esc([x.sub && x.sub !== CLASS[x.cls]?.l ? x.sub : x.typeLabel, x.length ? `${x.length} m` : ""].filter(Boolean).join(" · ")) || "&nbsp;"}</div>
      <div class="kv">
        <div><span>Status</span><b>${esc(STATUS[x.status] || (x.sog > 0.5 ? "Moving" : x.sog != null ? "Stopped" : "–"))}</b></div>
        <div><span>Speed</span><b>${x.sog != null ? `${num(x.sog, 1)} kn` : "–"}</b></div>
        <div><span>Course</span><b>${x.cog != null ? `${num(x.cog)}°` : "–"}</b></div>
        <div><span>Distance</span><b>${num(x.dist, 1)} nm</b></div>
        <div><span>Bearing</span><b>${x.brg != null ? `${x.brg}° ${compass(x.brg)}` : "–"}</b></div>
        <div><span>Heading to</span><b>${esc(x.dest || "–")}</b></div>
      </div>
      <div class="acts"><button class="btn pri" data-act="details"><ha-icon icon="mdi:information-outline"></ha-icon>Vessel details</button></div>`;
  }

  // ---- list ----------------------------------------------------------------------------------

  _renderList() {
    if (!this._built || this._tab !== "list") return;
    const vs = this._vessels || [];
    const counts = {};
    for (const v of vs) counts[v.cls] = (counts[v.cls] || 0) + 1;
    if (this._listCls !== "all" && !counts[this._listCls]) this._listCls = "all";
    const f = this._listCls;
    this.$("lchips").innerHTML = `<button data-c="all" class="${f === "all" ? "on" : ""}">All <span class="n">${vs.length}</span></button>` +
      CLASSES.filter(([k]) => counts[k]).map(([k, l, i, col]) => `<button data-c="${k}" class="${f === k ? "on" : ""}" style="--c:${col}"><ha-icon icon="${i}"></ha-icon>${l} <span class="n">${counts[k]}</span></button>`).join("");
    const cols = [["pin", ""], ["name", "Vessel"], ["cls", "Class"], ["type", "Type"], ["status", "Status"], ["sog", "Speed", 1], ["cog", "Course", 1],
      ["dist", "Dist", 1], ["dest", "Destination"], ["len", "Length", 1], ["seen", "Seen", 1]];
    const key = (v, k) => {
      switch (k) {
        case "name": return v.name || "~" + v.mmsi;
        case "cls": return CLASSES.findIndex(([c]) => c === v.cls);
        case "type": return v.sub || v.typeLabel || "~";
        case "status": return STATUS[v.status] || "~";
        case "sog": return v.sog ?? -1;
        case "cog": return v.cog ?? -1;
        case "dist": return v.dist ?? 1e9;
        case "dest": return v.dest || "~";
        case "len": return v.length ?? -1;
        case "seen": return v.posAge ?? 1e9;
      }
    };
    const k = this._sort, dir = this._sortDir;
    const rows = vs.filter((v) => f === "all" || v.cls === f).sort((a, b) => {
      const x = key(a, k), y = key(b, k);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    this.$("lhead").innerHTML = `<tr>${cols.map(([c, l, r]) => (c === "pin" ? `<th class="pin"></th>` :
      `<th data-k="${c}" class="${r ? "r" : ""}${c === k ? " on" : ""}">${l}${c === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`)).join("")}</tr>`;
    this.$("lbody").innerHTML = rows.map((v) => `<tr data-m="${v.mmsi}" class="${v.mmsi === this._sel ? "sel" : ""}${v.posAge > 900 ? " stale" : ""}">
        <td class="pin"><button data-act="locate" data-m="${v.mmsi}" title="Show on the map"><ha-icon icon="mdi:map-marker-radius"></ha-icon></button></td>
        <td><span class="fl" title="${esc(country(v.flag))}">${flagEmoji(v.flag)}</span><b>${esc(v.name || "")}</b>${v.name ? "" : `<span class="muted">${v.mmsi}</span>`}</td>
        <td>${this._tag(v)}</td>
        <td>${esc(v.sub && v.sub !== CLASS[v.cls]?.l ? v.sub : v.typeLabel)}</td>
        <td>${esc(STATUS[v.status] || "")}</td>
        <td class="r">${v.sog != null ? num(v.sog, 1) : ""}</td>
        <td class="r">${v.cog != null && (v.sog ?? 0) >= 0.5 ? `${num(v.cog)}°` : ""}</td>
        <td class="r">${num(v.dist, 1)}</td>
        <td>${esc(v.dest)}</td>
        <td class="r">${v.length ? `${v.length} m` : ""}</td>
        <td class="r">${ago(v.posAge)}</td></tr>`).join("") || `<tr><td colspan="${cols.length}" class="muted">No vessels yet</td></tr>`;
    const c = this._center();
    this.$("lfoot").textContent = `The ${vs.length} closest vessels to ${c?.name || "the location"} (of ${this._total ?? "?"} in the area). Speeds in knots, distances in nm. Tap a row for details, or 📍 for the map. Vessel types fill in as ships send them (every ~6 min).`;
  }

  // ---- vessel --------------------------------------------------------------------------------

  _renderVessel() {
    if (!this._built || this._tab !== "vessel") return;
    const box = this.$("vessel");
    const v = this._sel && { ...(this._selData || {}), ...(this._byMmsi?.get(this._sel) || {}) };
    if (!v?.mmsi) {
      const near = this._vessels.filter((x) => x.name).slice(0, 8);
      box.innerHTML = `<div class="empty"><ha-icon icon="mdi:ferry" style="--mdc-icon-size:40px"></ha-icon><div style="margin-top:8px">Pick a vessel on the map or in the list${near.length ? ", or one of the closest:" : "."}</div>
        <div class="picks">${near.map((x) => `<button class="btn" data-act="pick" data-m="${x.mmsi}">${flagEmoji(x.flag)} ${esc(x.name)} <span class="muted">${num(x.dist, 1)} nm</span></button>`).join("")}</div></div>`;
      return;
    }
    const tile = (l, val, s) => `<div class="tile"><div class="l">${l}</div><div class="v">${val}</div><div class="s">${s || "&nbsp;"}</div></div>`;
    const eta = etaDate(v.eta);
    const status = STATUS[v.status] || (v.sog > 0.5 ? "Moving" : v.sog != null ? "Stopped" : "–");
    const sub = v.sub && v.sub !== CLASS[v.cls]?.l ? v.sub : v.typeLabel;
    box.innerHTML = `
      <div class="vhead"><div class="vflag" title="${esc(country(v.flag))}">${flagEmoji(v.flag) || "🚢"}</div>
        <div><div class="vname">${esc(v.name || `MMSI ${v.mmsi}`)}${this._tag(v)}<span class="pill dim">${esc(status)}</span></div>
          <div class="vsub">${esc([sub, v.length ? `${v.length} × ${v.beam || "?"} m` : "", v.draught ? `draught ${v.draught} m` : "", country(v.flag)].filter(Boolean).join(" · "))}</div>
          <div class="vsub">MMSI ${v.mmsi}${v.imo ? ` · IMO ${v.imo}` : ""}${v.callsign ? ` · callsign ${esc(v.callsign)}` : ""}${v.classB ? " · class B transponder" : ""}</div></div></div>
      <div class="tiles">
        ${tile("Speed", v.sog != null ? `${num(v.sog, 1)}<small>kn</small>` : "–", v.sog != null ? `${num(v.sog * 1.852, 1)} km/h` : "")}
        ${tile("Course", v.cog != null ? `${num(v.cog)}°` : "–", v.hdg != null ? `heading ${v.hdg}° ${compass(v.hdg)}` : "")}
        ${tile("Distance", v.dist != null ? `${num(v.dist, 1)}<small>nm</small>` : "–", v.brg != null ? `${v.brg}° ${compass(v.brg)} of ${esc(this._center()?.name || "the location")}` : "")}
        ${tile("Destination", esc(v.dest || "–"), "as reported by the crew")}
        ${tile("ETA", eta ? eta.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–", eta ? "reported, your local time" : "")}
        ${tile("Size", v.length ? `${v.length}<small>m</small>` : "–", v.beam ? `beam ${v.beam} m` : "")}
        ${tile("Draught", v.draught ? `${v.draught}<small>m</small>` : "–", "maximum, as reported")}
        ${tile("Last position", ago(v.posAge), v.staticAge != null ? `details ${ago(v.staticAge)} ago` : "no details yet")}
      </div>
      <div class="panel"><h4>Speed, last 2 hours (kn)</h4><div class="ch" id="c-sog"></div></div>
      <div class="acts" style="margin-top:12px">
        <button class="btn pri" data-act="locate" data-m="${v.mmsi}"><ha-icon icon="mdi:map-marker-radius"></ha-icon>Show on map</button>
        <a class="btn" href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}" target="_blank" rel="noreferrer"><ha-icon icon="mdi:open-in-new"></ha-icon>MarineTraffic</a>
        <a class="btn" href="https://www.vesselfinder.com/vessels/details/${v.imo || v.mmsi}" target="_blank" rel="noreferrer"><ha-icon icon="mdi:open-in-new"></ha-icon>VesselFinder</a>
        <a class="btn" href="https://www.myshiptracking.com/vessels/mmsi-${v.mmsi}" target="_blank" rel="noreferrer"><ha-icon icon="mdi:open-in-new"></ha-icon>MyShipTracking</a>
      </div>`;
    this._spark(this.$("c-sog"), (v.track || []).filter((p) => p.sog != null).map((p) => ({ t: p.t / 1000, v: p.sog })));
  }

  _spark(el, pts) {
    if (pts.length < 2) {
      el.innerHTML = `<div class="muted" style="font-size:.85em;padding:24px 0;text-align:center">Not enough track yet</div>`;
      return;
    }
    const W = Math.max(260, el.clientWidth || 300), H = 120, pad = { l: 34, r: 8, t: 6, b: 18 };
    const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 60);
    const hi = Math.max(2, ...pts.map((p) => p.v)) * 1.1;
    const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r), y = (v) => pad.t + (1 - v / hi) * (H - pad.t - pad.b);
    const hh = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    let g = `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}"/><text class="ax" x="${pad.l - 4}" y="${y(0) + 3}" text-anchor="end">0</text>`;
    g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(hi / 1.1)}" y2="${y(hi / 1.1)}"/><text class="ax" x="${pad.l - 4}" y="${y(hi / 1.1) + 3}" text-anchor="end">${num(hi / 1.1, 1)}</text>`;
    g += `<text class="ax" x="${pad.l}" y="${H - 4}">${hh(t0)}</text><text class="ax" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${hh(t1)}</text>`;
    g += `<polyline fill="none" stroke="var(--primary-color)" stroke-width="2" points="${pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}</svg>`;
  }
}

customElements.define("ships-card", ShipsCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "ships-card",
  name: "Ships",
  description: "AIS vessels closest to a location (from ais-monitor / aisstream.io): map, list and vessel details, classified.",
});
