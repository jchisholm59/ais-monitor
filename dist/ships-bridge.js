// Bridge view for ships-card: the selected vessel's view from its bridge over Google's photorealistic 3D world
// (CesiumJS + Cesium ion), with a HUD. Loaded by ships-card.js only when the Bridge tab opens, so the map never pays
// for Cesium (several MB, from Cesium's CDN). A sibling of skyaware-card's cockpit view (adsb-monitor).
//
// Needs a Cesium ion token (scope assets:read; restrict its Allowed URLs to your Home Assistant addresses, since
// anyone who can open the dashboard can read it). Paste it into the tab: it's saved to the HA user's profile.
//
// Camera: at the reported position (the AIS antenna, normally on the bridge), at an eye height scaled from the
// vessel's length, above the water surface of the 3D tiles, looking along the true heading (or the course over
// ground when no heading is sent). Between reports it advances at the reported speed and course, then converges on
// the extrapolated position at a bounded rate, as God's Eye View's cockpit does, so a late report never lurches the
// view. Ships don't report pitch or roll, so the deck stays level.

const CESIUM_VERSION = "1.146";
const CESIUM_BASE = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;
const GOOGLE_3D_ASSET = 2275207; // Google Photorealistic 3D Tiles on Cesium ion

const KT = 0.514444;
const HEADING_SLEW_DPS = 6; // ships turn slowly
const STALE_S = 180; // extrapolate up to this; older positions are held
const NOTE_S = 60;
const LOST_S = 600;
const VIEW_PITCH_DEG = -2;

let cesiumLoading = null;
function loadCesium() {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (cesiumLoading) return cesiumLoading;
  window.CESIUM_BASE_URL = CESIUM_BASE;
  cesiumLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CESIUM_BASE + "Cesium.js";
    s.async = true;
    s.onload = () => (window.Cesium ? resolve(window.Cesium) : reject(new Error("Cesium did not load")));
    s.onerror = () => {
      cesiumLoading = null;
      s.remove();
      reject(new Error("Couldn't download CesiumJS from cesium.com"));
    };
    document.head.appendChild(s);
  });
  return cesiumLoading;
}

const norm360 = (v) => ((v % 360) + 360) % 360;
const slewAngle = (cur, target, max) => {
  const d = ((norm360(target) - norm360(cur) + 540) % 360) - 180;
  return norm360(cur + Math.max(-max, Math.min(max, d)));
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, d = 0) => (fin(v) ? v.toLocaleString([], { maximumFractionDigits: d, minimumFractionDigits: d }) : "–");

function correctionStep(distM, speedMps, dt) {
  if (!(distM > 0) || !(dt > 0)) return 0;
  dt = Math.min(0.1, dt);
  const eased = distM * (1 - Math.exp(-1.25 * dt));
  const rate = Math.max(0.5, Math.max(0, speedMps) * 0.25);
  return Math.min(distM, eased, rate * dt);
}

// Bridge eye height above the waterline, from the vessel's length: ~4 m for a small boat, ~25 m for a 200 m cargo
// ship, ~45 m for the largest cruise ships.
const eyeHeight = (v) => clamp(3 + (fin(v.length) ? v.length : 20) * 0.12, 3.5, 46);

// The chased vessel from astern: hull, superstructure, funnel.
const STERN_SVG = "data:image/svg+xml;base64," + btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -40 120 70">
  <g stroke="#1b2430" stroke-width="2" stroke-linejoin="round">
    <path d="M-50,4 L50,4 L42,26 L-42,26 Z" fill="#2a3442"/>
    <path d="M-50,4 L50,4 L49,10 L-49,10 Z" fill="#c62828"/>
    <path d="M-34,4 L-34,-14 L34,-14 L34,4 Z" fill="#e8edf5"/>
    <path d="M-24,-14 L-24,-26 L24,-26 L24,-14 Z" fill="#e8edf5"/>
    <path d="M-7,-26 L-6,-38 L6,-38 L7,-26 Z" fill="#d4a72c"/>
  </g></svg>`);

const STYLE = `
  .br { position: relative; width: 100%; height: min(70vh, 640px); min-height: 320px; border-radius: 12px; overflow: hidden; background: #0b1020; color: #e8f0ff; font-variant-numeric: tabular-nums; }
  .br .scene { position: absolute; inset: 0; }
  .br .scene canvas { display: block; touch-action: none; }
  .br .credits { position: absolute; left: 8px; bottom: 6px; font-size: 10px; opacity: .8; max-width: 55%; pointer-events: auto; }
  .br .credits img { max-height: 16px; vertical-align: middle; }
  .br .credits a { color: inherit; }
  .br .credits .cesium-credit-lightbox-overlay { position: fixed; }
  .br .hud { position: absolute; inset: 0; pointer-events: none; font-family: ui-monospace, "JetBrainsMono Nerd Font", monospace; text-shadow: 0 1px 2px #000, 0 0 6px rgba(0,0,0,.6); }
  .br .hud * { pointer-events: none; }
  .br .hud .btns, .br .hud .btns *, .br .credits * { pointer-events: auto; }
  .br .ident { position: absolute; left: 12px; top: 10px; line-height: 1.35; max-width: 45%; }
  .br .ident .nm { font-size: 1.25em; font-weight: 700; letter-spacing: .03em; }
  .br .ident .sub { opacity: .85; font-size: .85em; }
  .br .tape { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); width: min(60%, 420px); height: 34px; }
  .br .box { position: absolute; top: 50%; transform: translateY(-50%); padding: 4px 8px; border: 1.5px solid rgba(255,255,255,.85); border-radius: 6px; background: rgba(8,14,24,.82); text-align: center; min-width: 64px; }
  .br .box b { display: block; font-size: 1.35em; }
  .br .box span { font-size: .75em; opacity: .85; display: block; }
  .br .sog { left: 12px; } .br .cog { right: 12px; }
  .br .status { position: absolute; left: 50%; top: 58%; transform: translateX(-50%); padding: 6px 12px; border-radius: 8px; background: rgba(0,0,0,.55); font-size: .9em; text-align: center; }
  .br .status:empty { display: none; }
  .br .nav { position: absolute; left: 50%; top: 50px; transform: translateX(-50%); padding: 2px 10px; border-radius: 6px; background: rgba(0,0,0,.35); font-size: .85em; white-space: nowrap; }
  .br .nav:empty { display: none; }
  .br .btns { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .br .btns button { font: inherit; font-size: .85em; color: #fff; background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.35); border-radius: 999px; padding: 5px 11px; cursor: pointer; }
  .br .btns button:hover { background: rgba(255,255,255,.18); }
  .br .msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; line-height: 1.5; background: #0b1020; }
  .br .msg > div { max-width: 560px; text-align: left; }
  .br .msg ol { margin: 8px 0 0; padding-left: 22px; } .br .msg li { margin: 4px 0; }
  .br .msg form { display: flex; gap: 6px; margin-top: 12px; }
  .br .msg input { flex: 1; min-width: 0; font: inherit; color: inherit; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.3); border-radius: 8px; padding: 7px 10px; }
  .br .msg button { font: inherit; color: #fff; background: var(--primary-color, #03a9f4); border: 0; border-radius: 8px; padding: 7px 14px; cursor: pointer; }
  .br .msg button:disabled { opacity: .6; }
  .br .msg .note { font-size: .85em; opacity: .8; margin-top: 8px; }
  .br .msg code { background: rgba(255,255,255,.12); padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
  .br .msg:empty { display: none; }
`;

export class Bridge {
  // opts: { token, saveToken(token) -> Promise, color(v) -> css colour, onPick(mmsi), onExit(),
  //         label(v) -> {nm, sub}, status(v) -> navigational status text }
  constructor(container, opts) {
    this.el = container;
    this.opts = opts;
    this.vs = new Map(); // mmsi -> { v, recvMs }
    this.sel = null;
    this.mode = "bridge"; // or "chase"
    this.look = { yaw: 0, pitch: 0 };
    this.fov = 60;
    this.destroyed = false;
    this._listeners = [];
    this._render();
  }

  _render() {
    this.el.innerHTML = `<style>${STYLE}</style>
      <div class="br">
        <div class="scene"></div>
        <div class="hud">
          <div class="ident"><div class="nm"></div><div class="sub"></div></div>
          <svg class="tape" viewBox="-210 0 420 34"></svg>
          <div class="nav"></div>
          <div class="box sog"><b>–</b><span>SOG kn</span></div>
          <div class="box cog"><b>–</b><span>COG °</span><span class="hdgv"></span></div>
          <div class="status"></div>
          <div class="btns">
            <button data-br="prev" title="Previous vessel (by distance)">◀</button>
            <button data-br="next" title="Next vessel (by distance)">▶</button>
            <button data-br="mode">Chase view</button>
            <button data-br="reset" title="Look ahead again">Look ahead</button>
            <button data-br="exit">Map</button>
          </div>
        </div>
        <div class="credits"></div>
        <div class="msg">Loading the 3D world…</div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = { scene: q(".scene"), nm: q(".ident .nm"), sub: q(".ident .sub"), tape: q(".tape"), nav: q(".nav"), sog: q(".sog b"),
      cog: q(".cog b"), hdgv: q(".cog .hdgv"), status: q(".status"), msg: q(".msg"), credits: q(".credits"), mode: q('[data-br="mode"]') };
    this._on(this.el, "click", (e) => {
      const b = e.target.closest("[data-br]");
      if (!b) return;
      const act = b.dataset.br;
      if (act === "exit") this.opts.onExit?.();
      else if (act === "next" || act === "prev") this._step(act === "next" ? 1 : -1);
      else if (act === "mode") {
        this.mode = this.mode === "bridge" ? "chase" : "bridge";
        this.$.mode.textContent = this.mode === "bridge" ? "Chase view" : "Bridge view";
        this.look = { yaw: 0, pitch: 0 };
      } else if (act === "reset") (this.look = { yaw: 0, pitch: 0 }), (this.fov = 60);
    });
  }

  _on(t, type, fn, opt) {
    t.addEventListener(type, fn, opt);
    this._listeners.push(() => t.removeEventListener(type, fn, opt));
  }

  async start() {
    const token = String(this.opts.token || "").trim();
    if (!token) {
      this._askToken("<b>The bridge view needs a Cesium ion token.</b>");
      return;
    }
    let C;
    try {
      C = this.C = await loadCesium();
    } catch (e) {
      this.$.msg.innerHTML = `<div>${esc(e.message)}</div>`;
      return;
    }
    if (this.destroyed) return;
    const root = this.el.getRootNode();
    if (!root.querySelector?.("link[data-cesium]")) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = CESIUM_BASE + "Widgets/widgets.css";
      l.dataset.cesium = "1";
      (root.host ? root : document.head).appendChild(l);
    }
    C.Ion.defaultAccessToken = token;
    const w = (this.w = new C.CesiumWidget(this.$.scene, {
      baseLayer: false,
      skyAtmosphere: new C.SkyAtmosphere(),
      shadows: false,
      msaaSamples: 4,
      creditContainer: this.$.credits,
    }));
    const scene = w.scene;
    scene.globe.baseColor = C.Color.fromCssColorString("#1d3550");
    scene.globe.depthTestAgainstTerrain = true;
    scene.screenSpaceCameraController.enableInputs = false;
    w.camera.frustum.fov = C.Math.toRadians(this.fov);
    try {
      const res = await C.IonResource.fromAssetId(GOOGLE_3D_ASSET, { accessToken: token });
      if (this.destroyed) return;
      this.tiles = await C.Cesium3DTileset.fromUrl(res, { cacheBytes: 768 * 1024 * 1024, enableCollision: true, asynchronouslyLoadImagery: true });
      if (this.destroyed) return;
      scene.primitives.add(this.tiles);
      scene.globe.show = false;
    } catch (e) {
      console.warn("ships-bridge: Google 3D tiles unavailable, falling back to terrain", e);
      try {
        w.scene.imageryLayers.add(C.ImageryLayer.fromProviderAsync(C.IonImageryProvider.fromAssetId(2)));
        w.scene.terrainProvider = await C.createWorldTerrainAsync();
        this._note = "Google 3D tiles unavailable on this token: showing terrain";
      } catch (e2) {
        const m = String(e2?.message || e?.message || e2 || e);
        if (/401|403|Invalid access token|Unauthorized/i.test(m))
          this._askToken(`<b>Cesium ion refused the token.</b> Check it was copied whole, and that its Allowed URLs include <code>${esc(location.origin)}</code>, or paste another.`);
        else this.$.msg.innerHTML = `<div>Couldn't load the 3D world: ${esc(m)}</div>`;
        return;
      }
    }
    if (this.destroyed) return;
    this.points = scene.primitives.add(new C.PointPrimitiveCollection());
    this.labels = scene.primitives.add(new C.LabelCollection());
    this.bbs = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.chaseBb = this.bbs.add({ image: STERN_SVG, width: 110, height: 64, show: false, verticalOrigin: C.VerticalOrigin.BOTTOM });
    this.marks = new Map();
    this.$.msg.textContent = "";
    this._initInput();
    this._last = performance.now();
    this._removePre = scene.preUpdate.addEventListener(() => this._frame());
  }

  _askToken(intro) {
    const canSave = typeof this.opts.saveToken === "function";
    this.$.msg.innerHTML = `<div>${intro}<ol>
        <li>Create one at <a href="https://ion.cesium.com/tokens" target="_blank" rel="noreferrer" style="color:inherit">ion.cesium.com/tokens</a>
          with only the <code>assets:read</code> scope, its Allowed URLs limited to your Home Assistant addresses.</li>
        <li>${canSave ? "Paste it here:" : "Add <code>cesium_token: &lt;token&gt;</code> to this card's YAML."}</li></ol>
      ${canSave ? `<form><input type="password" placeholder="Cesium ion token" autocomplete="off" spellcheck="false"><button type="submit">Save</button></form>
        <div class="note">Saved to your Home Assistant profile, so it works on every device you're signed in on.</div>` : ""}</div>`;
    const form = this.$.msg.querySelector("form");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const t = form.querySelector("input").value.trim();
      if (!t) return;
      const btn = form.querySelector("button");
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        await this.opts.saveToken(t);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Save";
        this.$.msg.querySelector(".note").textContent = "Couldn't save it: " + (err?.message || err);
      }
    });
    form.addEventListener("keydown", (e) => e.stopPropagation());
  }

  _initInput() {
    const cv = this.w.canvas;
    let drag = null;
    this._on(cv, "pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, yaw: this.look.yaw, pitch: this.look.pitch };
      cv.setPointerCapture?.(e.pointerId);
    });
    this._on(cv, "pointermove", (e) => {
      if (!drag) return;
      const k = this.fov / Math.max(200, cv.clientWidth);
      this.look.yaw = norm360(drag.yaw - (e.clientX - drag.x) * k + 180) - 180;
      this.look.pitch = clamp(drag.pitch + (e.clientY - drag.y) * k, -80, 60);
    });
    const end = () => (drag = null);
    this._on(cv, "pointerup", end);
    this._on(cv, "pointercancel", end);
    this._on(cv, "dblclick", () => (this.look = { yaw: 0, pitch: 0 }));
    this._on(cv, "wheel", (e) => {
      e.preventDefault();
      this.fov = clamp(this.fov * Math.exp(e.deltaY * 0.001), 15, 100);
    }, { passive: false });
  }

  // Called by the card after every poll, with every vessel it knows about (and the selected one's fuller record).
  setData(vessels, selMmsi) {
    const now = performance.now();
    const seen = new Set();
    for (const v of vessels) {
      if (!v || !fin(v.lat) || !fin(v.lon)) continue;
      seen.add(v.mmsi);
      const old = this.vs.get(v.mmsi);
      if (old && old.v.lat === v.lat && old.v.lon === v.lon) old.v = { ...old.v, ...v };
      else this.vs.set(v.mmsi, { v, recvMs: now - (fin(v.posAge) ? v.posAge : 0) * 1000 });
    }
    for (const m of this.vs.keys()) if (!seen.has(m)) this.vs.delete(m);
    if (selMmsi !== this.sel) {
      this.sel = selMmsi;
      this.anchor = null;
      this.heading = null;
      this.look = { yaw: 0, pitch: 0 };
    }
  }

  _step(dir) {
    const list = [...this.vs.values()].map((x) => x.v).sort((p, q) => (p.dist ?? 1e9) - (q.dist ?? 1e9));
    if (!list.length) return;
    const i = list.findIndex((v) => v.mmsi === this.sel);
    this.opts.onPick?.(list[(i + dir + list.length) % list.length].mmsi);
  }

  // Extrapolated position at `nowMs`, along the course over ground at the speed over ground.
  _project(entry, nowMs) {
    const v = entry.v;
    const age = Math.max(0, (nowMs - entry.recvMs) / 1000);
    const stale = age > STALE_S;
    const sog = fin(v.sog) ? v.sog * KT : 0;
    const cog = fin(v.cog) ? v.cog : fin(v.hdg) ? v.hdg : 0;
    const d = sog > 0.15 && !stale ? sog * age : 0;
    const r = 6371008.8;
    const lat = v.lat + ((d * Math.cos((cog * Math.PI) / 180)) / r) * (180 / Math.PI);
    const lon = v.lon + ((d * Math.sin((cog * Math.PI) / 180)) / (r * Math.cos((v.lat * Math.PI) / 180))) * (180 / Math.PI);
    // Where the bow points: the true heading when sent (511 = not available), else the course when under way.
    const hdg = fin(v.hdg) && v.hdg < 360 ? v.hdg : sog > 0.5 ? cog : null;
    return { lat, lon, sog, cog, hdg, stale, age };
  }

  // Water/quay surface height (ellipsoid metres), from the 3D tiles at full detail. scene.sampleHeight() reads
  // whatever coarse tiles happen to be loaded and can be off by kilometres (found in the cockpit view), so this waits
  // for the detailed tiles. Async; null when unknown.
  async _surfaceAt(lat, lon) {
    const C = this.C, scene = this.w?.scene;
    if (!scene) return null;
    try {
      const pos = [C.Cartographic.fromDegrees(lon, lat)];
      const exclude = [this.points, this.labels, this.bbs].filter(Boolean);
      const out = this.tiles ? await scene.sampleHeightMostDetailed(pos, exclude) : await C.sampleTerrainMostDetailed(scene.terrainProvider, pos);
      const h = out?.[0]?.height;
      return fin(h) ? h : null;
    } catch (e) {
      return null;
    }
  }

  _frame() {
    if (this.destroyed || !this.w) return;
    const C = this.C, now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this._drawTraffic(now);
    const entry = this.sel && this.vs.get(this.sel);
    if (!entry) {
      if (this.chaseBb) this.chaseBb.show = false;
      this.$.status.textContent = this.sel ? "Vessel out of range" : "Pick a vessel on the map, or use ◀ ▶";
      this._hud(null);
      return;
    }
    const v = entry.v;
    const p = this._project(entry, now);
    // Water (or quay) surface under the vessel; tide and waves aren't in the tiles, so this is mean sea level-ish.
    // Sampled every 2 s (async). A ship is on the water, so anything far from sea level is junk (lakes and rivers
    // reach a few hundred metres at most).
    if (!this._surfBusy && now - (this._surfMs || 0) > 2000) {
      this._surfMs = now;
      this._surfBusy = true;
      this._surfaceAt(p.lat, p.lon).then((g) => {
        this._surfBusy = false;
        if (g != null && g > -150 && g < 600) this._surface = g;
      });
    }
    const surf = this._surface ?? 0;
    const target = C.Cartesian3.fromDegrees(p.lon, p.lat, surf);
    if (p.hdg != null) this.heading = this.heading == null ? p.hdg : slewAngle(this.heading, p.hdg, HEADING_SLEW_DPS * dt);
    else if (this.heading == null) this.heading = fin(v.cog) ? v.cog : 0;

    if (!this.anchor) this.anchor = C.Cartesian3.clone(target);
    else if (p.stale) C.Cartesian3.clone(target, this.anchor);
    else {
      const enu = C.Transforms.eastNorthUpToFixedFrame(this.anchor, C.Ellipsoid.WGS84, this._enu || (this._enu = new C.Matrix4()));
      const cr = C.Math.toRadians(p.cog);
      const step = new C.Cartesian3(Math.sin(cr) * p.sog * dt, Math.cos(cr) * p.sog * dt, 0);
      C.Cartesian3.add(this.anchor, C.Matrix4.multiplyByPointAsVector(enu, step, step), this.anchor);
      const corr = C.Cartesian3.subtract(target, this.anchor, new C.Cartesian3());
      const dist = C.Cartesian3.magnitude(corr);
      if (dist > 1500) C.Cartesian3.clone(target, this.anchor);
      else {
        const s = correctionStep(dist, p.sog, dt);
        if (s > 0) C.Cartesian3.add(this.anchor, C.Cartesian3.multiplyByScalar(corr, s / dist, corr), this.anchor);
      }
    }
    // Keep the anchor on the surface (the correction is 3D).
    const ac = C.Cartographic.fromCartesian(this.anchor);
    if (ac) {
      ac.height = surf;
      C.Cartographic.toCartesian(ac, C.Ellipsoid.WGS84, this.anchor);
    }

    const eye = eyeHeight(v);
    const enu = C.Transforms.eastNorthUpToFixedFrame(this.anchor, C.Ellipsoid.WGS84, this._enu || (this._enu = new C.Matrix4()));
    const hr = C.Math.toRadians(this.heading);
    const back = Math.max(80, (fin(v.length) ? v.length : 30) * 1.6 + 60), up = Math.max(18, (fin(v.length) ? v.length : 30) * 0.3 + 12);
    const off = this.mode === "bridge" ? new C.Cartesian3(0, 0, eye) : new C.Cartesian3(-Math.sin(hr) * back, -Math.cos(hr) * back, up);
    const cam = C.Matrix4.multiplyByPoint(enu, off, new C.Cartesian3());
    const pitch = (this.mode === "bridge" ? VIEW_PITCH_DEG : (-Math.atan2(up - eye * 0.6, back) * 180) / Math.PI) + this.look.pitch;
    this.w.camera.frustum.fov = C.Math.toRadians(this.fov);
    this.w.camera.setView({
      destination: cam,
      orientation: { heading: C.Math.toRadians(norm360(this.heading + this.look.yaw)), pitch: C.Math.toRadians(pitch), roll: 0 },
    });
    this.chaseBb.show = this.mode === "chase";
    if (this.mode === "chase") {
      this.chaseBb.position = this.anchor;
      const s = clamp((fin(v.length) ? v.length : 30) / 100, 0.6, 1.6);
      this.chaseBb.width = 110 * s;
      this.chaseBb.height = 64 * s;
    }
    const age = (now - entry.recvMs) / 1000;
    const underWay = p.sog > 0.5 * KT;
    this.$.status.textContent = !underWay ? this._note || "" : age > LOST_S ? "No recent position: holding the last one"
      : age > NOTE_S ? `Last position ${age < 120 ? Math.round(age) + " s" : Math.round(age / 60) + " min"} ago${p.stale ? ": holding" : ": estimating"}` : this._note || "";
    if (now - (this._hudMs || 0) > 150) {
      this._hudMs = now;
      this._hud(v, p);
    }
  }

  _drawTraffic(now) {
    const C = this.C;
    const keep = new Set();
    for (const [mmsi, entry] of this.vs) {
      if (mmsi === this.sel) continue;
      const p = this._project(entry, now);
      const pos = C.Cartesian3.fromDegrees(p.lon, p.lat, (this._surface ?? 0) + 6);
      keep.add(mmsi);
      let m = this.marks.get(mmsi);
      if (!m) {
        m = {
          pt: this.points.add({ pixelSize: 10, outlineColor: C.Color.BLACK, outlineWidth: 1.5 }),
          lb: this.labels.add({ font: "600 13px sans-serif", fillColor: C.Color.WHITE, showBackground: true,
            backgroundColor: new C.Color(0, 0, 0, 0.55), backgroundPadding: new C.Cartesian2(5, 3),
            pixelOffset: new C.Cartesian2(10, -10), horizontalOrigin: C.HorizontalOrigin.LEFT,
            distanceDisplayCondition: new C.DistanceDisplayCondition(0, 20000),
            translucencyByDistance: new C.NearFarScalar(1500, 1, 9000, 0), scaleByDistance: new C.NearFarScalar(500, 1.1, 8000, 0.75) }),
        };
        this.marks.set(mmsi, m);
      }
      m.pt.position = pos;
      m.lb.position = pos;
      if (now - (m.styledMs || 0) > 2000) {
        m.styledMs = now;
        const v = entry.v;
        m.pt.color = C.Color.fromCssColorString(this.opts.color?.(v) || "#4ea1ff");
        m.lb.text = `${v.name || v.mmsi}${fin(v.sog) && v.sog > 0.5 ? `  ${fmt(v.sog, 1)} kn` : ""}`;
      }
    }
    for (const [mmsi, m] of this.marks) {
      if (keep.has(mmsi)) continue;
      this.points.remove(m.pt);
      this.labels.remove(m.lb);
      this.marks.delete(mmsi);
    }
  }

  _hud(v, p) {
    if (!v) {
      this.$.nm.textContent = this.$.sub.textContent = this.$.nav.textContent = "";
      this.$.sog.textContent = this.$.cog.textContent = "–";
      this.$.hdgv.textContent = "";
      this.$.tape.innerHTML = "";
      return;
    }
    const lab = this.opts.label?.(v) || {};
    this.$.nm.textContent = lab.nm || v.name || String(v.mmsi);
    this.$.sub.textContent = lab.sub || "";
    this.$.nav.textContent = this.opts.status?.(v) || "";
    this.$.sog.textContent = fmt(v.sog, 1);
    this.$.cog.textContent = fin(v.cog) && fin(v.sog) && v.sog >= 0.5 ? String(Math.round(v.cog)).padStart(3, "0") : "–";
    this.$.hdgv.textContent = p.hdg != null && fin(v.hdg) && v.hdg < 360 ? `HDG ${String(Math.round(v.hdg)).padStart(3, "0")}°` : "no heading sent";
    const hdg = norm360((this.heading ?? 0) + this.look.yaw);
    let g = "";
    for (let d = Math.ceil((hdg - 60) / 5) * 5; d <= hdg + 60; d += 5) {
      const x = ((d - hdg) / 60) * 200;
      const n = norm360(d);
      const big = n % 30 === 0;
      g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${big ? 16 : 21}" y2="28" stroke="#fff" stroke-width="${big ? 1.6 : 1}"/>`;
      if (big && Math.abs(x) > 30) g += `<text x="${x.toFixed(1)}" y="12" fill="#fff" font-size="11" text-anchor="middle">${({ 0: "N", 90: "E", 180: "S", 270: "W" })[n] ?? String(n / 10).padStart(2, "0")}</text>`;
    }
    // COG marker on the tape, where the vessel is actually going.
    if (fin(v.cog) && fin(v.sog) && v.sog >= 0.5) {
      const cx = (((((v.cog - hdg + 540) % 360) - 180) / 60) * 200);
      if (Math.abs(cx) <= 200) g += `<path d="M${(cx - 5).toFixed(1)},34 L${cx.toFixed(1)},28 L${(cx + 5).toFixed(1)},34 Z" fill="#ffcc00"/>`;
    }
    g += `<path d="M-6,34L0,28L6,34" fill="#7CFC9A"/>`;
    g += `<rect x="-20" y="-1" width="40" height="15" rx="3" fill="rgba(0,0,0,.55)" stroke="#7CFC9A"/><text x="0" y="11" fill="#7CFC9A" font-size="12" text-anchor="middle">${String(Math.round(hdg) % 360).padStart(3, "0")}</text>`;
    this.$.tape.innerHTML = g;
  }

  destroy() {
    this.destroyed = true;
    this._removePre?.();
    for (const off of this._listeners) off();
    this._listeners = [];
    try {
      this.w?.destroy();
    } catch (e) {}
    this.w = null;
    this.el.innerHTML = "";
  }
}
