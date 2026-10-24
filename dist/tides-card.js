// Tides card: Canadian Hydrographic Service tide predictions (IWLS API, free, no key) for one or more
// stations, in the style of the Ecowitt card, laid out after the fred.tides bar widget:
//   Now     current height (from the 15-minute predictions), rising / falling and how fast, the next high and low,
//           today's range with a level bar, sunrise / sunset, the moon and whether it's spring or neap tides
//   Curve   24 hours (6 h back, 18 h ahead) with daylight shading, "now", highs and lows; touch or hover to read it;
//           the gauge's observed level over it when the station reports one (shows a surge against the prediction)
//   Week    7 days of curve and each day's highs and lows
// Config:
//   type: custom:tides-card
//   stations:                       # IWLS station ids (not the 5-digit codes): see the TideWatch README
//     - { id: 5cebf1df3d0f4a073c4bbcb5, name: Boutiliers Pt }
//     - { id: 5cebf1e33d0f4a073c4bc207, name: Merigomish }
//   units: m                        # or ft
//   monitor: [http://192.168.2.210:7120]   # ecowitt-monitor, which relays CHS (first that answers)
//   auto_stations: true             # no `stations`: the monitor's nearest station to each of its locations (ais-monitor)
//   embedded: true                  # inside another card (the Ships card's Tides tab): no frame, no title
// The pencil by the station buttons edits the list (search all CHS stations, add, rename, reorder, remove); it's saved
// in ecowitt-monitor, so every device shows the same stations, and replaces `stations` above once saved.
// CHS's certificate is from Entrust, which browsers stopped trusting for certificates issued after late 2024, so the
// card can't call CHS itself: ecowitt-monitor's /api/tides fetches and caches it. Nothing is stored in Home Assistant.

const SOURCES = { CHS: "Canadian Hydrographic Service", NOAA: "NOAA", "Open-Meteo": "Open-Meteo tide model", WorldTides: "WorldTides" };
const DEFAULT_STATIONS = [
  { id: "5cebf1df3d0f4a073c4bbcb5", name: "Boutiliers Pt" },
  { id: "5cebf1e33d0f4a073c4bc207", name: "Merigomish" },
];
const fin = Number.isFinite;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const store = {
  get(k, d) {
    try {
      return localStorage.getItem("tides-card:" + k) ?? d;
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("tides-card:" + k, v);
    } catch (e) {}
  },
};
const HOUR = 3600e3, DAY = 864e5;
// Times are shown in the station's own time zone (meta.tz from the monitor), set before each paint.
let TZ;
const MY_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const hm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: TZ });
// "America/Halifax" -> "America/Halifax"; "Etc/GMT-4" (an ocean zone) -> "GMT+4".
const tzName = (z) => (/^Etc\//.test(z) ? new Intl.DateTimeFormat("en", { timeZone: z, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || z : z.replace(/_/g, " "));
const dayKey = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
// Local midnight (in TZ) of the day containing t.
function midnight(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return t - (((Number(p.hour) % 24) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 - (t % 1000);
}
const inHM = (ms) => {
  const m = Math.max(0, Math.round(ms / 60e3));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
};
const sameDay = (a, b) => dayKey(a) === dayKey(b);

const STYLE = `
  :host { --td-water: #29b6f6; --td-high: #26c6da; --td-low: #ffa726; --td-obs: #ffee58; --td-day: rgba(255, 235, 150, .07); }
  ha-card { padding: 14px 16px 16px; overflow: hidden; }
  .top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .title { font-size: 1.25em; font-weight: 500; flex: 1; min-width: 120px; display: flex; align-items: center; gap: 8px; }
  .title ha-icon { color: var(--primary-color); }
  .seg { display: inline-flex; padding: 3px; border-radius: 999px; background: var(--secondary-background-color); gap: 2px; }
  .seg button { border: none; background: transparent; color: var(--secondary-text-color); font: inherit; font-weight: 500; padding: 6px 14px; border-radius: 999px; cursor: pointer; }
  .seg button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .stsel { font: inherit; font-weight: 500; padding: 6px 10px; border-radius: 999px; border: none; background: var(--primary-color); color: var(--text-primary-color, #fff); max-width: 260px; }
  .pill { font-size: .8em; padding: 4px 10px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); white-space: nowrap; }
  .tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--secondary-background-color); margin: 12px 0 14px; }
  .tabs button { flex: 1; border: none; background: transparent; color: var(--secondary-text-color); font: inherit; font-weight: 500; padding: 7px; border-radius: 999px; cursor: pointer; }
  .tabs button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  @media (max-width: 1100px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  .panel { background: var(--secondary-background-color); border-radius: 14px; padding: 12px 14px; min-width: 0; }
  .panel.wide { grid-column: 1 / -1; }
  .ph { display: flex; align-items: center; gap: 6px; font-size: .8em; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
  .ph ha-icon { --mdc-icon-size: 18px; }
  .ph .phs { text-transform: none; letter-spacing: 0; }
  .big { font-size: 3.2em; font-weight: 300; line-height: 1; }
  .big small { font-size: .4em; color: var(--secondary-text-color); margin-left: 2px; }
  .sub { color: var(--secondary-text-color); font-size: .95em; margin-top: 6px; }
  .kv { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; font-size: .95em; margin-top: 8px; }
  .kv span:nth-child(odd) { color: var(--secondary-text-color); }
  .kv b { font-weight: 500; text-align: right; }
  .now { display: flex; gap: 70px; align-items: stretch; }
  .now .lvl { width: 26px; flex: none; position: relative; border-radius: 13px; background: linear-gradient(0deg, var(--td-low), var(--td-water) 50%, var(--td-high)); opacity: .9; min-height: 150px; }
  .now .lvl i { position: absolute; left: -5px; right: -5px; height: 4px; border-radius: 2px; background: var(--primary-text-color); box-shadow: 0 0 0 2px var(--secondary-background-color); }
  .now .lvl span { position: absolute; left: 32px; font-size: .75em; color: var(--secondary-text-color); white-space: nowrap; }
  .next { display: flex; flex-direction: column; gap: 10px; }
  .ev { display: flex; align-items: baseline; gap: 10px; }
  .ev .k { font-size: .8em; text-transform: uppercase; letter-spacing: .06em; width: 44px; }
  .ev .k.high { color: var(--td-high); } .ev .k.low { color: var(--td-low); }
  .ev .t { font-size: 1.6em; font-weight: 300; }
  .ev .h { color: var(--secondary-text-color); }
  .ev .in { color: var(--secondary-text-color); font-size: .85em; margin-left: auto; white-space: nowrap; }
  .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
  @media (max-width: 640px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .tc { background: var(--card-background-color, #1c1c1c); border-radius: 12px; padding: 8px 10px; border-top: 3px solid var(--td-high); }
  .tc.low { border-top-color: var(--td-low); }
  .tc.past { opacity: .45; }
  .tc .k { font-size: .75em; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .06em; }
  .tc .t { font-size: 1.25em; font-weight: 400; }
  .tc .h { font-size: .9em; color: var(--secondary-text-color); }
  .chart { position: relative; }
  .chart svg { width: 100%; display: block; touch-action: pan-y; }
  .chart .tip { position: absolute; pointer-events: none; background: var(--card-background-color, #222); color: var(--primary-text-color); border: 1px solid var(--divider-color);
                border-radius: 8px; padding: 6px 8px; font-size: .8em; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.3); display: none; z-index: 2; }
  .axis { fill: var(--secondary-text-color); font-size: 10px; }
  .gridl { stroke: var(--divider-color); stroke-width: 1; }
  .lg { font-size: .85em; color: var(--secondary-text-color); display: inline-flex; gap: 4px; align-items: center; margin-right: 10px; }
  .lg i { width: 10px; height: 3px; border-radius: 2px; display: inline-block; }
  .days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
  @media (max-width: 900px) { .days { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (max-width: 500px) { .days { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .day { background: var(--card-background-color, #1c1c1c); border-radius: 12px; padding: 8px 10px; font-size: .9em; }
  .day .d { font-weight: 500; margin-bottom: 4px; }
  .day .r { display: flex; justify-content: space-between; gap: 6px; }
  .day .r.high b { color: var(--td-high); font-weight: 500; } .day .r.low b { color: var(--td-low); font-weight: 500; }
  .day .r span { color: var(--secondary-text-color); }
  .day .r.past { opacity: .45; }
  .msg { color: var(--secondary-text-color); padding: 18px 4px; }
  .editb { border: none; background: var(--secondary-background-color); color: var(--secondary-text-color); border-radius: 999px; width: 36px; height: 36px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .editb.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .editb ha-icon { --mdc-icon-size: 18px; }
  .ed { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  @media (max-width: 800px) { .ed { grid-template-columns: 1fr; } }
  .row { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px solid var(--divider-color); }
  .row input, .ed input[type=search] { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--card-background-color, #fff); color: var(--primary-text-color); min-width: 0; color-scheme: light dark; }
  .row input { flex: 1; }
  .row .code, .res .code { color: var(--secondary-text-color); font-size: .8em; white-space: nowrap; }
  .ib { border: 1px solid var(--divider-color); background: var(--card-background-color, transparent); color: var(--primary-text-color); border-radius: 8px; padding: 4px 8px; cursor: pointer; font: inherit; }
  .ib:disabled { opacity: .35; cursor: default; }
  .ib.pri { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .res { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--divider-color); }
  .res .n { flex: 1; min-width: 0; }
  .res .n small { display: block; color: var(--secondary-text-color); font-size: .8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gauge { font-size: .7em; padding: 1px 6px; border-radius: 6px; background: color-mix(in srgb, var(--td-obs) 25%, transparent); color: var(--primary-text-color); }
  #res { max-height: 430px; overflow-y: auto; margin-top: 6px; }
  .edbar { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  .msg.bad { color: var(--error-color, #db4437); }
  .mn { display: flex; gap: 14px; align-items: center; }
  .mn svg { width: 90px; height: 90px; flex: none; }
  .mn .kv { flex: 1; margin-top: 0; }
`;

class TidesCard extends HTMLElement {
  setConfig(config) {
    const m = config?.monitor;
    this._config = { title: "Tides", units: "m", ...config, stations: config?.stations?.length ? config.stations : config?.auto_stations ? [] : DEFAULT_STATIONS,
      monitor: (Array.isArray(m) ? m : m ? [m] : ["http://192.168.2.210:7120"]).map((u) => String(u).replace(/\/+$/, "")) };
    this._tab = store.get("tab", "now");
    this._stations = this._config.stations;
    this._st = store.get("station", this._stations[0]?.id || "");
    if (!this._stations.some((s) => s.id === this._st)) this._st = this._stations[0]?.id || "";
    this._data = {}; // station id -> { at, curve: [[t, m]], events: [{t, v, high}], obs: [[t, m]], meta }
    if (this.isConnected) this._start();
  }

  set hass(h) {
    this._hass = h;
  }

  getCardSize() {
    return 9;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  static getStubConfig() {
    return {};
  }

  connectedCallback() {
    if (this._config) this._start();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  _start() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._built) {
      const emb = this._config.embedded;
      this.shadowRoot.innerHTML = `<style>${STYLE}${emb ? "ha-card{padding:0;background:none;box-shadow:none;border:none}.title span{display:none}" : ""}</style><ha-card>
        <div class="top"><div class="title"><ha-icon icon="mdi:waves"></ha-icon><span>${esc(this._config.title)}</span></div>
          <div class="seg" id="st"></div><button class="editb" id="edit" title="Edit the stations"><ha-icon icon="mdi:pencil"></ha-icon></button><span class="pill" id="trend"></span></div>
        <div class="tabs" id="tabs">${[["now", "Now"], ["curve", "24 hours"], ["week", "Week"]].map(([k, n]) => `<button data-tab="${k}">${n}</button>`).join("")}</div>
        <div id="body"><div class="msg">Loading tides…</div></div></ha-card>`;
      this._built = true;
      const $ = (id) => this.shadowRoot.getElementById(id);
      this.$ = { st: $("st"), trend: $("trend"), tabs: $("tabs"), body: $("body"), edit: $("edit") };
      this.$.edit.addEventListener("click", () => {
        this._editing = !this._editing;
        if (this._editing) this._draft = this._stations.map((x) => ({ ...x }));
        this._paint();
      });
      this.$.tabs.addEventListener("click", (e) => {
        const b = e.target.closest("[data-tab]");
        if (!b) return;
        this._tab = b.dataset.tab;
        this._editing = false;
        store.set("tab", this._tab);
        this._paint();
      });
      this.$.st.addEventListener("change", (e) => {
        if (!e.target.matches("select") || e.target.value === this._st) return;
        this._pick(e.target.value);
      });
      this.$.st.addEventListener("click", (e) => {
        const b = e.target.closest("[data-st]");
        if (!b || b.dataset.st === this._st) return;
        this._pick(b.dataset.st);
      });
      new ResizeObserver(() => this._tab !== "now" && this._paint()).observe(this.$.body);
    }
    if (!this._timer) {
      this._loadSaved();
      this._timer = setInterval(() => this._load(), 60e3); // repaint every minute (predictions refetched hourly)
      this._load();
    }
    this._paint();
  }

  // ---- data -------------------------------------------------------------------------------------------------------
  _pick(id) {
    this._st = id;
    store.set("station", id);
    this._paint();
    this._load();
  }

  // For a host card (the Ships card's location picker): show the station named after this place, else the nearest.
  showPlace(place) {
    this._place = place;
    if (!place || !this._stations.length) return;
    let s = this._stations.find((x) => x.name === place.name);
    if (!s && Number.isFinite(place.lat)) {
      let best = Infinity;
      for (const x of this._stations) {
        const m = this._data[x.id]?.meta;
        const d = m ? (m.latitude - place.lat) ** 2 + ((m.longitude - place.lon) * Math.cos((place.lat * Math.PI) / 180)) ** 2 : Infinity;
        if (d < best) (best = d), (s = x);
      }
    }
    if (s && s.id !== this._st) this._pick(s.id);
  }

  // A request to ecowitt-monitor (the first address that answers).
  async _mon(path, opts = {}) {
    let last;
    for (const base of this._base ? [this._base, ...this._config.monitor.filter((b) => b !== this._base)] : this._config.monitor) {
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 25000);
        const tok = typeof this.authToken === "function" ? this.authToken() : ""; // set by a host card that has signed in
        const headers = { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(tok ? { Authorization: "Bearer " + tok } : {}) };
        const r = await fetch(base + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctl.signal, cache: "no-store" });
        clearTimeout(to);
        this._base = base;
        const j = await r.json();
        if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { answered: true });
        return j;
      } catch (e) {
        last = e;
        if (e.answered) break;
      }
    }
    throw last || new Error("ecowitt-monitor didn't answer");
  }

  // The saved station list, if one has been saved from the card.
  async _loadSaved() {
    try {
      let saved = await this._mon("/api/tides/saved");
      if (!(Array.isArray(saved) && saved.length) && this._config.auto_stations) saved = await this._mon("/api/tides/defaults");
      if (Array.isArray(saved) && saved.length) {
        const was = this._st;
        this._stations = saved;
        if (this._place && saved.some((x) => x.name === this._place.name)) this._st = saved.find((x) => x.name === this._place.name).id;
        if (!saved.some((s) => s.id === this._st)) this._st = saved[0].id;
        this._paint();
        if (this._st !== was) this._load();
      }
    } catch (e) {}
  }

  async _load() {
    const id = this._st;
    if (!id) return this._paint();
    const d = this._data[id];
    if (!d || Date.now() - d.at > 5 * 60e3) {
      try {
        const j = await this._mon(`/api/tides?station=${encodeURIComponent(id)}`);
        const events = j.events.map(([t, v]) => ({ t, v }));
        // High or low: compare each event with its neighbours.
        events.forEach((e, i) => (e.high = e.v > (events[i - 1]?.v ?? events[i + 1]?.v ?? -Infinity) && e.v > (events[i + 1]?.v ?? events[i - 1]?.v ?? -Infinity)));
        this._data[id] = { at: Date.now(), meta: j.meta, curve: j.curve, events, obs: j.obs };
        this._err = null;
      } catch (e) {
        this._err = e.message;
      }
    }
    if (id === this._st) this._paint();
  }

  // Predicted level at time t (linear between the 15-minute points).
  _levelAt(d, t) {
    const c = d.curve;
    for (let i = 1; i < c.length; i++)
      if (c[i][0] >= t) {
        const [t0, v0] = c[i - 1], [t1, v1] = c[i];
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    return null;
  }

  _u(m, d = 2) {
    if (!fin(m)) return "–";
    const ft = this._config.units === "ft";
    return `${(ft ? m * 3.28084 : m).toFixed(ft ? 1 : d)} ${ft ? "ft" : "m"}`;
  }

  // ---- paint ------------------------------------------------------------------------------------------------------
  _paint() {
    if (!this.$) return;
    const S = this._stations;
    // Up to four stations as buttons; more as a dropdown.
    this.$.st.innerHTML = S.length > 4
      ? `<select class="stsel">${S.map((s) => `<option value="${esc(s.id)}" ${s.id === this._st ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`
      : S.map((s) => `<button data-st="${esc(s.id)}" class="${s.id === this._st ? "on" : ""}">${esc(s.name)}</button>`).join("");
    this.$.st.style.display = S.length > 1 ? "" : "none";
    this.$.edit.classList.toggle("on", !!this._editing);
    for (const b of this.$.tabs.querySelectorAll("button")) b.classList.toggle("on", !this._editing && b.dataset.tab === this._tab);
    if (this._editing) return this._paintEdit();
    if (!S.length) {
      this.$.trend.textContent = "";
      this.$.body.innerHTML = `<div class="msg">${this._config.auto_stations ? "No tide station near your locations yet: add one with the pencil." : "No stations."}</div>`;
      return;
    }
    const d = this._data[this._st];
    if (!d) {
      this.$.trend.textContent = "";
      this.$.body.innerHTML = this._err ? `<div class="msg bad">Couldn't load the tides: ${esc(this._err)}</div>` : `<div class="msg">Loading tides…</div>`;
      return;
    }
    TZ = d.meta?.tz || undefined;
    const now = Date.now();
    const lvl = this._levelAt(d, now), rate = (this._levelAt(d, now + 15 * 60e3) - this._levelAt(d, now - 15 * 60e3)) * 2; // m/h
    const rising = rate > 0;
    this.$.trend.textContent = fin(rate) ? `${rising ? "▲ Rising" : "▼ Falling"} ${this._u(Math.abs(rate), 2)}/h` : "";
    if (this._tab === "now") this._paintNow(d, now, lvl, rate);
    else if (this._tab === "curve") this._paintCurve(d, now);
    else this._paintWeek(d, now);
  }

  _paintNow(d, now, lvl, rate) {
    const ev = d.events;
    const nextHigh = ev.find((e) => e.t > now && e.high), nextLow = ev.find((e) => e.t > now && !e.high);
    // Today's events (local day), or the next four if today's are all past.
    let today = ev.filter((e) => sameDay(e.t, now));
    if (!today.some((e) => e.t > now)) today = ev.filter((e) => e.t > now).slice(0, 4);
    const day = ev.filter((e) => sameDay(e.t, now));
    const hi = Math.max(...day.map((e) => e.v)), lo = Math.min(...day.map((e) => e.v));
    const pos = fin(lvl) && hi > lo ? Math.min(1, Math.max(0, (lvl - lo) / (hi - lo))) : 0.5;
    const st = this._stations.find((s) => s.id === this._st);
    const lat = d.meta?.latitude, lon = d.meta?.longitude;
    const sun = fin(lat) ? sunTimes(new Date(), lat, lon) : null;
    const m = moonIllum(new Date());
    // Spring tides come a day or two after full and new moon, neaps after the quarters.
    const p = m.phase, fromSyzygy = Math.min(Math.abs(p - 0), Math.abs(p - 0.5), Math.abs(p - 1)) * 29.53;
    const kind = fromSyzygy < 3.5 ? "Spring tides (big range)" : fromSyzygy > 5.5 ? "Neap tides (small range)" : "Between spring and neap";
    const obsNow = d.obs.length ? d.obs[d.obs.length - 1] : null;
    const card = (e) => `<div class="tc ${e.high ? "" : "low"} ${e.t < now ? "past" : ""}"><div class="k">${e.high ? "High" : "Low"}${sameDay(e.t, now) ? "" : " · " + new Date(e.t).toLocaleDateString(undefined, { weekday: "short", timeZone: TZ })}</div><div class="t">${hm(e.t)}</div><div class="h">${this._u(e.v)}</div></div>`;
    const evRow = (e, k) => (e ? `<div class="ev"><span class="k ${e.high ? "high" : "low"}">${k}</span><span class="t">${hm(e.t)}</span><span class="h">${this._u(e.v)}</span><span class="in">in ${inHM(e.t - now)}</span></div>` : "");
    const first = [nextHigh, nextLow].filter(Boolean).sort((a, b) => a.t - b.t);
    this.$.body.innerHTML = `<div class="grid">
      <div class="panel"><div class="ph"><ha-icon icon="mdi:waves-arrow-up"></ha-icon>Now <span class="phs">· ${esc(d.meta?.name || st?.name || "")}</span></div>
        <div class="now"><div class="lvl">${fin(hi) ? `<span style="top:-2px">${this._u(hi)}</span><span style="bottom:-2px">${this._u(lo)}</span>` : ""}<i style="bottom:calc(${(pos * 100).toFixed(1)}% - 2px)"></i></div>
          <div><div class="big">${fin(lvl) ? (this._config.units === "ft" ? (lvl * 3.28084).toFixed(1) : lvl.toFixed(2)) : "–"}<small>${this._config.units === "ft" ? "ft" : "m"}</small></div>
            <div class="sub">${rate > 0 ? "▲ Rising" : "▼ Falling"}, ${this._u(Math.abs(rate))} an hour</div>
            <div class="kv"><span>Today's range</span><b>${fin(hi) ? this._u(hi - lo) : "–"}</b>
              ${obsNow && now - obsNow[0] < 30 * 60e3 ? `<span>Gauge reads</span><b>${this._u(obsNow[1])} (${obsNow[1] - this._levelAt(d, obsNow[0]) >= 0 ? "+" : ""}${this._u(obsNow[1] - this._levelAt(d, obsNow[0]))})</b>` : ""}
              </div><div class="sub" style="font-size:.8em">${esc(SOURCES[d.meta?.source] || "Canadian Hydrographic Service")}: heights above ${esc(d.meta?.datum || "chart datum (about the lowest tides)")}${d.meta?.modelAt ? ` · <span title="The model has no data at this place itself (it counts it as land), so this is the nearest water it covers">model point ${esc(d.meta.modelAt.km)} km ${esc(d.meta.modelAt.dir)} of here</span>` : ""}</div></div></div></div>
      <div class="panel"><div class="ph"><ha-icon icon="mdi:clock-outline"></ha-icon>Next</div>
        <div class="next">${first.map((e) => evRow(e, e.high ? "High" : "Low")).join("")}</div>
        <div class="kv">${sun ? `<span>Sunrise</span><b>${hm(sun.rise)}</b><span>Sunset</span><b>${hm(sun.set)}</b>` : ""}</div>
                ${TZ && TZ !== MY_TZ ? `<div class="sub" style="font-size:.8em">Times are local there (${esc(tzName(TZ))}: ${esc(hm(now))} now)</div>` : ""}</div>
      <div class="panel"><div class="ph"><ha-icon icon="mdi:moon-waning-crescent"></ha-icon>Moon</div>
        <div class="mn">${moonSvg(m.phase, fin(lat) ? moonTilt(new Date(), lat, lon) : 0)}<div class="kv"><span>Phase</span><b>${moonPhaseName(m.phase)}</b><span>Illuminated</span><b>${Math.round(m.fraction * 100)} %</b><span>Tides</span><b style="white-space:normal">${kind}</b></div></div></div>
      <div class="panel wide"><div class="ph"><ha-icon icon="mdi:chart-bell-curve"></ha-icon>Today <span class="phs">· highs and lows</span></div>
        <div class="chart" id="mini"><svg></svg><div class="tip"></div></div>
        <div class="cards">${today.map(card).join("")}</div></div>
    </div>`;
    this._drawCurve(this.$.body.querySelector("#mini"), d, now - 6 * HOUR, now + 18 * HOUR, 200, lat, lon);
  }

  // The station editor: the list (rename, reorder, remove) and a search of every CHS station with predictions,
  // nearest to the station being viewed first.
  _paintEdit() {
    const D = this._draft;
    const here = this._data[this._st]?.meta;
    this.$.body.innerHTML = `<div class="ed">
      <div class="panel"><div class="ph"><ha-icon icon="mdi:format-list-bulleted"></ha-icon>Your stations</div>
        <div id="list">${D.map((x, i) => `<div class="row"><input data-i="${i}" value="${esc(x.name)}" maxlength="40">
          <button class="ib" data-up="${i}" ${i ? "" : "disabled"} title="Move up">▲</button><button class="ib" data-down="${i}" ${i < D.length - 1 ? "" : "disabled"} title="Move down">▼</button>
          <button class="ib" data-del="${i}" ${D.length > 1 ? "" : "disabled"} title="Remove">✕</button></div>`).join("")}</div>
        <div class="edbar"><button class="ib pri" id="save" ${D.length ? "" : "disabled"}>Save</button><button class="ib" id="cancel">Cancel</button><span class="sub" id="emsg" style="margin:0"></span></div></div>
      <div class="panel"><div class="ph"><ha-icon icon="mdi:magnify"></ha-icon>Add a station <span class="phs">· ${this._config.auto_stations ? "CHS (Canada), NOAA (US), or a tide model anywhere" : "Canadian Hydrographic Service"}</span></div>
        <input type="search" id="q" placeholder="${this._config.auto_stations ? "A station or place name, or lat, lon (e.g. Pictou, The Battery, Dubai, 26.6, 56.3)" : "Search by name or code, e.g. Pictou, Halifax, 00490"}" style="width:100%;box-sizing:border-box">
        <div id="res"><div class="msg">${here ? "Stations near " + esc(here.name) + "…" : "Loading…"}</div></div></div></div>`;
    const B = this.$.body;
    const redraw = () => this._paintEdit();
    B.querySelectorAll("#list input").forEach((el) => el.addEventListener("input", () => (D[Number(el.dataset.i)].name = el.value)));
    B.querySelectorAll("[data-up]").forEach((el) => el.addEventListener("click", () => {
      const i = Number(el.dataset.up);
      [D[i - 1], D[i]] = [D[i], D[i - 1]];
      redraw();
    }));
    B.querySelectorAll("[data-down]").forEach((el) => el.addEventListener("click", () => {
      const i = Number(el.dataset.down);
      [D[i + 1], D[i]] = [D[i], D[i + 1]];
      redraw();
    }));
    B.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", () => {
      D.splice(Number(el.dataset.del), 1);
      redraw();
    }));
    B.querySelector("#cancel").addEventListener("click", () => {
      this._editing = false;
      this._paint();
    });
    B.querySelector("#save").addEventListener("click", async () => {
      const list = D.map((x) => ({ id: x.id, name: x.name.trim() || "Station" }));
      try {
        this._stations = await this._mon("/api/tides/saved", { method: "PUT", body: list });
        if (!this._stations.some((x) => x.id === this._st)) this._st = this._stations[0].id;
        store.set("station", this._st);
        this._editing = false;
        this._paint();
        this._load();
      } catch (e) {
        B.querySelector("#emsg").textContent = "Couldn't save: " + e.message;
      }
    });
    const q = B.querySelector("#q");
    let timer;
    const search = async () => {
      const box = B.querySelector("#res");
      try {
        const params = new URLSearchParams({ q: q.value.trim() });
        if (here) (params.set("lat", here.latitude), params.set("lon", here.longitude));
        const hits = await this._mon(`/api/tides/stations?${params}`);
        if (!box.isConnected) return;
        box.innerHTML = hits.length ? hits.map((x) => {
          const have = D.some((y) => y.id === x.id);
          return `<div class="res"><div class="n">${esc(x.name)} ${x.gauge ? `<span class="gauge" title="Has a working tide gauge (observed levels)">gauge</span>` : ""}${x.source && x.source !== "CHS" ? `<span class="gauge" style="background:color-mix(in srgb, var(--primary-color) 25%, transparent)">${x.source === "model" ? "model" : esc(x.source)}</span>` : ""}<small>${esc(x.code)}${x.km !== null && x.km !== undefined ? ` · ${x.km} km away` : ""}${x.alt ? ` · ${esc(x.alt)}` : ""}</small></div>
            <button class="ib ${have ? "" : "pri"}" data-add="${esc(x.id)}" data-name="${esc(x.name)}" ${have || D.length >= 20 ? "disabled" : ""}>${have ? "Added" : "Add"}</button></div>`;
        }).join("") : `<div class="msg">No stations match.</div>`;
        box.querySelectorAll("[data-add]").forEach((el) => el.addEventListener("click", () => {
          D.push({ id: el.dataset.add, name: el.dataset.name });
          const keep = q.value;
          redraw();
          const q2 = this.$.body.querySelector("#q");
          q2.value = keep;
          q2.dispatchEvent(new Event("input"));
        }));
      } catch (e) {
        box.innerHTML = `<div class="msg bad">${esc(e.message)}</div>`;
      }
    };
    q.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(search, 250);
    });
    q.addEventListener("keydown", (e) => e.stopPropagation()); // keep HA's keyboard shortcuts out of the box
    search();
  }

  _paintCurve(d, now) {
    const lat = d.meta?.latitude, lon = d.meta?.longitude;
    this.$.body.innerHTML = `<div class="panel"><div class="ph"><ha-icon icon="mdi:chart-bell-curve"></ha-icon>24 hours <span class="phs">· 6 h back, 18 h ahead</span></div>
      <div><span class="lg"><i style="background:var(--td-water)"></i>Predicted</span>${d.obs.length ? `<span class="lg"><i style="background:var(--td-obs)"></i>Observed (gauge)</span>` : ""}<span class="lg"><i style="background:rgba(255,235,150,.5)"></i>Daylight</span></div>
      <div class="chart" id="c24"><svg></svg><div class="tip"></div></div></div>`;
    this._drawCurve(this.$.body.querySelector("#c24"), d, now - 6 * HOUR, now + 18 * HOUR, 340, lat, lon);
  }

  _paintWeek(d, now) {
    const lat = d.meta?.latitude, lon = d.meta?.longitude;
    const d0 = new Date(midnight(now));
    const days = Array.from({ length: 7 }, (_, i) => new Date(midnight(d0.getTime() + i * DAY + 3 * HOUR)));
    this.$.body.innerHTML = `<div class="panel"><div class="ph"><ha-icon icon="mdi:calendar-week"></ha-icon>Week</div>
      <div class="chart" id="cw"><svg></svg><div class="tip"></div></div>
      <div class="days">${days.map((dd) => {
        const evs = d.events.filter((e) => sameDay(e.t, dd));
        return `<div class="day"><div class="d">${dd.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: TZ })}</div>
          ${evs.map((e) => `<div class="r ${e.high ? "high" : "low"} ${e.t < now ? "past" : ""}"><b>${e.high ? "High" : "Low"} ${hm(e.t)}</b><span>${this._u(e.v)}</span></div>`).join("")}</div>`;
      }).join("")}</div></div>`;
    this._drawCurve(this.$.body.querySelector("#cw"), d, d0.getTime(), d0.getTime() + 7 * DAY, 220, lat, lon, true);
  }

  // The tide curve between t0 and t1: daylight bands, grid, predicted line with a soft fill, observed level, highs and
  // lows labelled, "now", and a scrubbable readout.
  _drawCurve(el, d, t0, t1, H, lat, lon, week) {
    if (!el) return;
    const svg = el.querySelector("svg"), tip = el.querySelector(".tip");
    const W = Math.max(300, el.clientWidth), L = 40, R = 10, T = week ? 10 : 22, B = 20;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.height = H + "px";
    const pts = d.curve.filter(([t]) => t >= t0 - HOUR && t <= t1 + HOUR);
    const evs = d.events.filter((e) => e.t >= t0 && e.t <= t1);
    const obs = week ? [] : d.obs.filter(([t]) => t >= t0 && t <= t1);
    const vals = [...pts.map((p) => p[1]), ...obs.map((p) => p[1])];
    if (!vals.length) return void (svg.outerHTML = `<div class="msg">No predictions for this period.</div>`);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.12 || 0.2;
    (lo -= pad), (hi += pad);
    const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let s = "";
    // Daylight.
    if (fin(lat)) {
      for (let day = new Date(t0 - DAY); day.getTime() < t1 + DAY; day = new Date(day.getTime() + DAY)) {
        const st = sunTimes(day, lat, lon);
        if (!st.rise || !st.set) continue;
        const a = Math.max(t0, st.rise.getTime()), b = Math.min(t1, st.set.getTime());
        if (b > a) s += `<rect x="${X(a)}" y="${T}" width="${X(b) - X(a)}" height="${H - T - B}" fill="var(--td-day)"/>`;
      }
    }
    // Grid: heights and times.
    const step = hi - lo > 3 ? 1 : hi - lo > 1.2 ? 0.5 : 0.25;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) s += `<line class="gridl" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${this._config.units === "ft" ? (v * 3.28084).toFixed(0) : +v.toFixed(2)}</text>`;
    const m0 = midnight(t0);
    if (week) {
      for (let t = m0; t <= t1; t += DAY) {
        if (t >= t0) s += `<line class="gridl" x1="${X(t)}" x2="${X(t)}" y1="${T}" y2="${H - B}"/>`;
        if (t + DAY / 2 >= t0 && t + DAY / 2 <= t1) s += `<text class="axis" x="${X(t + DAY / 2)}" y="${H - 5}" text-anchor="middle">${new Date(t + DAY / 2).toLocaleDateString(undefined, { weekday: "short", timeZone: TZ })}</text>`;
      }
    } else {
      for (let t = m0; t <= t1; t += 3 * HOUR)
        if (t >= t0) {
          const lab = (t - m0) % DAY === 0 ? new Date(t).toLocaleDateString(undefined, { weekday: "short", timeZone: TZ }) : new Date(t).toLocaleTimeString(undefined, { hour: "numeric", timeZone: TZ });
          s += `<line class="gridl" x1="${X(t)}" x2="${X(t)}" y1="${T}" y2="${H - B}" stroke-dasharray="2 3"/><text class="axis" x="${X(t)}" y="${H - 5}" text-anchor="middle">${lab}</text>`;
        }
    }
    // Predicted curve (smooth: the 15-minute points are dense enough to join straight).
    const line = pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    s += `<defs><linearGradient id="wf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--td-water)" stop-opacity=".45"/><stop offset="1" stop-color="var(--td-water)" stop-opacity=".03"/></linearGradient>
      <clipPath id="cp"><rect x="${L}" y="0" width="${W - L - R}" height="${H}"/></clipPath></defs>`;
    s += `<g clip-path="url(#cp)"><path d="${line}L${X(pts[pts.length - 1][0])},${H - B}L${X(pts[0][0])},${H - B}Z" fill="url(#wf)"/>
      <path d="${line}" fill="none" stroke="var(--td-water)" stroke-width="2.4" stroke-linejoin="round"/>`;
    if (obs.length > 1) s += `<path d="${obs.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("")}" fill="none" stroke="var(--td-obs)" stroke-width="1.6"/>`;
    s += `</g>`;
    // Highs and lows.
    for (const e of evs) {
      const x = X(e.t), y = Y(e.v);
      s += `<circle cx="${x}" cy="${y}" r="4" fill="${e.high ? "var(--td-high)" : "var(--td-low)"}" stroke="var(--secondary-background-color)" stroke-width="1.5"/>`;
      // Labels near an edge are anchored inwards, so they aren't cut off.
      const anchor = x > W - R - 60 ? "end" : x < L + 60 ? "start" : "middle";
      if (!week) s += `<text x="${x}" y="${e.high ? y - 9 : y + 16}" text-anchor="${anchor}" style="font-size:11px;fill:var(--primary-text-color)">${hm(e.t)} · ${this._u(e.v)}</text>`;
    }
    // Now.
    const now = Date.now();
    if (now > t0 && now < t1) {
      const v = this._levelAt(d, now);
      s += `<line x1="${X(now)}" x2="${X(now)}" y1="${T}" y2="${H - B}" stroke="var(--primary-text-color)" stroke-opacity=".7" stroke-dasharray="3 3"/>`;
      if (fin(v)) s += `<circle cx="${X(now)}" cy="${Y(v)}" r="5.5" fill="var(--primary-text-color)" stroke="var(--td-water)" stroke-width="2.5"/>`;
    }
    s += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--primary-text-color)" stroke-opacity=".45" style="display:none"/><circle class="dot" r="4" fill="var(--td-water)" style="display:none"/>`;
    svg.innerHTML = s;
    const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot");
    const move = (e) => {
      const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      if (px < L || px > W - R) return hide();
      let t = t0 + ((px - L) / (W - L - R)) * (t1 - t0);
      // Snap to a nearby high/low or to now.
      for (const s2 of [...evs.map((x) => x.t), now]) if (Math.abs(X(s2) - px) < 8) t = s2;
      const v = this._levelAt(d, t);
      if (!fin(v)) return hide();
      cross.setAttribute("x1", X(t));
      cross.setAttribute("x2", X(t));
      cross.style.display = "";
      dot.setAttribute("cx", X(t));
      dot.setAttribute("cy", Y(v));
      dot.style.display = "";
      const ev = evs.find((x) => x.t === t);
      tip.innerHTML = `<div style="opacity:.7">${new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: TZ })}${t === now ? " · now" : ""}</div><b>${ev ? (ev.high ? "High " : "Low ") : ""}${this._u(v)}</b>`;
      tip.style.display = "block";
      tip.style.left = Math.min(Math.max(4, (X(t) / W) * r.width + 12), el.clientWidth - tip.offsetWidth - 4) + "px";
      tip.style.top = "6px";
    };
    const hide = () => {
      cross.style.display = dot.style.display = tip.style.display = "none";
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", hide);
  }
}

// ---- sun and moon (from SunCalc (c) Vladimir Agafonkin, BSD 2-Clause, github.com/mourner/suncalc) ---------------
const RAD = Math.PI / 180, J1970 = 2440588, J2000 = 2451545, OBL = RAD * 23.4397, J0 = 0.0009;
const toJulian = (d) => d.valueOf() / DAY - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY);
const toDays = (d) => toJulian(d) - J2000;
const rightAsc = (l, b) => Math.atan2(Math.sin(l) * Math.cos(OBL) - Math.tan(b) * Math.sin(OBL), Math.cos(l));
const decl = (l, b) => Math.asin(Math.sin(b) * Math.cos(OBL) + Math.cos(b) * Math.sin(OBL) * Math.sin(l));
const solarMean = (d) => RAD * (357.5291 + 0.98560028 * d);
const eclLon = (M) => M + RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + RAD * 102.9372 + Math.PI;
function sunCoords(d) {
  const L = eclLon(solarMean(d));
  return { dec: decl(L, 0), ra: rightAsc(L, 0) };
}
// Sunrise and sunset on the day of `date` (SunCalc's getTimes, -0.833° for refraction and the sun's radius).
function sunTimes(date, lat, lng) {
  const lw = RAD * -lng, phi = RAD * lat, d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * Math.PI)), ds = J0 + lw / (2 * Math.PI) + n;
  const M = solarMean(ds), L = eclLon(M), dec = decl(L, 0);
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const w = Math.acos((Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  if (!fin(w)) return { rise: null, set: null };
  const Jset = J2000 + J0 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  return { rise: fromJulian(Jnoon - (Jset - Jnoon)), set: fromJulian(Jset) };
}
function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F), dt = 385001 - 20905 * Math.cos(M);
  return { ra: rightAsc(l, b), dec: decl(l, b), dist: dt };
}
function moonIllum(date) {
  const d = toDays(date), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI, angle };
}
function moonPhaseName(p) {
  return ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"][Math.round(p * 8) % 8];
}
// How the moon is tilted in the sky at a place and time: the bright limb's angle from the observer's zenith
// (SunCalc: the illumination angle minus the moon's parallactic angle). Returned as the clockwise rotation, in degrees,
// that turns moonSvg's upright drawing (lit on the right while waxing, on the left while waning) to match: near the
// tropics a crescent lies on its back, further north it stands up, and south of the equator it's the other way round.
function moonTilt(date, lat, lng) {
  const d = toDays(date), c = moonCoords(d), lw = RAD * -lng, phi = RAD * lat;
  const H = RAD * (280.16 + 360.9856235 * d) - lw - c.ra;
  const pa = Math.atan2(Math.sin(H), Math.tan(phi) * Math.cos(c.dec) - Math.sin(c.dec) * Math.cos(H));
  const m = moonIllum(date), z = ((m.angle - pa) * 180) / Math.PI;
  return -z - (m.phase < 0.5 ? 90 : 270);
}
// The same moon drawing as the Ecowitt card.
function moonSvg(phase, rot = 0) {
  const r = 70, c = 75, k = Math.cos(phase * 2 * Math.PI) * r;
  const waxing = phase < 0.5, gibbous = phase > 0.25 && phase < 0.75;
  const sweepOuter = waxing ? 1 : 0, sweepTerm = waxing ? (gibbous ? 1 : 0) : gibbous ? 0 : 1;
  const lit = `M${c},${c - r} A${r},${r} 0 0 ${sweepOuter} ${c},${c + r} A${Math.abs(k)},${r} 0 0 ${sweepTerm} ${c},${c - r} Z`;
  const tilt = fin(rot) && rot ? ` transform="rotate(${rot.toFixed(1)} ${c} ${c})"` : "";
  return `<svg viewBox="0 0 150 150"><defs>
      <radialGradient id="tmlit" cx="40%" cy="38%" r="70%"><stop offset="0" stop-color="#fbfbf4"/><stop offset=".7" stop-color="#d9d9cf"/><stop offset="1" stop-color="#a8a89e"/></radialGradient>
      <clipPath id="tmclip"><path d="${lit}"/></clipPath></defs>
    <circle cx="${c}" cy="${c}" r="${r}" fill="#262a30"/>
    <g${tilt}><g clip-path="url(#tmclip)"><circle cx="${c}" cy="${c}" r="${r}" fill="url(#tmlit)"/>
      <g fill="#9e9e94" opacity=".45"><ellipse cx="58" cy="52" rx="16" ry="12"/><ellipse cx="88" cy="48" rx="11" ry="9"/><ellipse cx="96" cy="72" rx="13" ry="10"/>
        <ellipse cx="70" cy="80" rx="9" ry="7"/><ellipse cx="52" cy="98" rx="12" ry="8"/><circle cx="84" cy="112" r="5"/><circle cx="110" cy="96" r="4"/></g></g></g>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,.15)"/></svg>`;
}

// Guarded: the Ships card loads this file too, and HA may already have it as a resource.
if (!customElements.get("tides-card")) {
  customElements.define("tides-card", TidesCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "tides-card", name: "Tides", description: "Canadian Hydrographic Service tide predictions: now, a 24-hour curve, the week, highs and lows." });
}
