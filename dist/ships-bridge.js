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
//
// Follow view, like skyaware-card's (after FlightRadar24's 3D view): the vessel in 3D with an orbit camera round it.
// Drag to circle it, wheel or pinch to zoom; View steps through Behind, Side, Front, Above and Auto. The ship is built
// here (shipGlb) from its AIS type and its own reported length and beam: container ship or bulk carrier, tanker, cruise
// ship, ferry, tug / pilot / workboat, fishing boat, sailing boat, motor yacht, warship. No model files.
// Smooth (both views): the vessel is shown SMOOTH_DELAY_S behind live, on a curve between two real position reports
// that matches each one's speed and course, instead of being extrapolated and corrected.

const CESIUM_VERSION = "1.146";
const CESIUM_BASE = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;
const GOOGLE_3D_ASSET = 2275207; // Google Photorealistic 3D Tiles on Cesium ion

const KT = 0.514444;
const HEADING_SLEW_DPS = 6; // ships turn slowly
const STALE_S = 180; // extrapolate up to this; older positions are held
const NOTE_S = 60;
const LOST_S = 600;
const VIEW_PITCH_DEG = -2;
const SMOOTH_DELAY_S = 20; // the card polls every 10 s; class A ships report every 2-10 s under way
const SMOOTH_GAP_S = 75; // longer between two reports: extrapolate instead
const FOLLOW_SPRING = 0.6; // rad/s: the follow camera's heading spring (critically damped)
const ORBIT_TAU_S = 1.1;
const AUTO_TAU_S = 2.8;
const AUTO_SHOT_S = 12;
const AUTO_DRIFT_DPS = 1.2;
// Camera angles round the vessel: yaw from astern (+ = round to starboard), pitch down onto it, range in ship lengths.
const VIEWS = {
  behind: { name: "Behind", yaw: 0, pitch: 14, range: 1.6 },
  side: { name: "Side", yaw: 90, pitch: 8, range: 1.4 },
  front: { name: "Front", yaw: 155, pitch: 10, range: 1.5 },
  above: { name: "Above", yaw: 20, pitch: 60, range: 2.6 },
  auto: { name: "Auto", yaw: 0, pitch: 14, range: 1.6 },
};
const VIEW_ORDER = ["behind", "side", "front", "above", "auto"];
const AUTO_SHOTS = [
  { yaw: 0, pitch: 14, range: 1.6 }, { yaw: -100, pitch: 6, range: 1.3 }, { yaw: 40, pitch: 3, range: 1.2 },
  { yaw: 150, pitch: 12, range: 1.6 }, { yaw: 75, pitch: 38, range: 2.2 }, { yaw: -25, pitch: 22, range: 3.5 },
];

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

// ---- the follow view's ship ----------------------------------------------------------------------------------

// Which kind of ship to build, from the AIS type (and the name, for bulk carriers and pilots).
function shipKind(v) {
  const t = v.type, name = String(v.name || "").toUpperCase();
  if (t === 35 || v.cls === "mil") return "navy";
  if (t >= 60 && t <= 69) return (v.length || 0) >= 150 ? "cruise" : "ferry"; // smaller cruise ships start ~150 m
  if (t >= 80 && t <= 89) return "tanker";
  if (t >= 70 && t <= 79) return /BULK|ORE |CEMENT|\bBC\b/.test(name) ? "bulk" : "container";
  if (t === 30) return "fishing";
  if (t === 36) return "sail";
  if (t === 37) return "yacht";
  if (t === 50 || /\bPILOT\b/.test(name)) return "pilot";
  if ([31, 32, 33, 34, 51, 52, 53, 54, 55, 56, 57, 58, 59].includes(t) || v.cls === "gov") return "tug";
  const L = v.length || 0;
  return L >= 120 ? "container" : L >= 40 ? "ferry" : v.classB ? "yacht" : "tug";
}
const KIND_LENGTH = { container: 180, bulk: 180, tanker: 180, cruise: 290, ferry: 110, navy: 130, fishing: 25, sail: 12, yacht: 14, pilot: 18, tug: 30 };
const KIND_BEAM = { container: 7, bulk: 6.3, tanker: 5.8, cruise: 8, ferry: 5.5, navy: 8, fishing: 3.6, sail: 3.4, yacht: 3.5, pilot: 3.3, tug: 2.8 }; // L/B

// Low-poly ship in metres (bow +X, up +Y, waterline y = 0) as a binary glTF: a lofted hull (transom stern, pointed
// bow with a little sheer), then boxes for superstructure, containers, funnel and so on. `seed` picks colours.
function shipGlb(kind, L, B, seed) {
  const pos = [], nrm = [], col = [];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let rnd = (seed >>> 0) % 2147483647 || 1;
  const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  // A convex polygon, turned to face away from `centre(faceCentre)`; `rgb` may be a function of the unit normal.
  const face = (pts, rgb, centre) => {
    const fc = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
    let n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    if (dot(n, sub(fc, centre(fc))) < 0) (pts = [...pts].reverse()), (n = n.map((v) => -v));
    const l = Math.hypot(...n) || 1;
    n = n.map((v) => v / l);
    const c = typeof rgb === "function" ? rgb(n, fc) : rgb;
    for (let i = 1; i + 1 < pts.length; i++) for (const p of [pts[0], pts[i], pts[i + 1]]) pos.push(...p), nrm.push(...n), col.push(...c);
  };
  const box = (x0, x1, y0, y1, hw, rgb, z = 0) => {
    const c = [(x0 + x1) / 2, (y0 + y1) / 2, z], cf = () => c;
    const P = (x, y, s) => [x, y, z + s * hw];
    face([P(x0, y1, -1), P(x1, y1, -1), P(x1, y1, 1), P(x0, y1, 1)], rgb, cf);
    face([P(x0, y0, -1), P(x1, y0, -1), P(x1, y0, 1), P(x0, y0, 1)], rgb, cf);
    face([P(x0, y0, -1), P(x1, y0, -1), P(x1, y1, -1), P(x0, y1, -1)], rgb, cf);
    face([P(x0, y0, 1), P(x1, y0, 1), P(x1, y1, 1), P(x0, y1, 1)], rgb, cf);
    face([P(x0, y0, -1), P(x0, y0, 1), P(x0, y1, 1), P(x0, y1, -1)], rgb, cf);
    face([P(x1, y0, -1), P(x1, y0, 1), P(x1, y1, 1), P(x1, y1, -1)], rgb, cf);
  };
  const tri = (a, b, c, t, rgb) => {
    // A thin triangular sail/plate of thickness t across Z.
    const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, 0], cf = () => m;
    const o = (p, s) => [p[0], p[1], s * t];
    face([o(a, 1), o(b, 1), o(c, 1)], rgb, cf);
    face([o(a, -1), o(b, -1), o(c, -1)], rgb, cf);
  };
  const pick = (a) => a[Math.floor(rand() * a.length) % a.length];
  const WHITE = [0.93, 0.94, 0.95], GREY = [0.55, 0.58, 0.6], DECK = [0.42, 0.45, 0.47], RED = [0.62, 0.12, 0.1];
  const hb = B / 2;
  const F = { container: 0.05, bulk: 0.06, tanker: 0.045, cruise: 0.045, ferry: 0.06, navy: 0.055, fishing: 0.09, sail: 0.08, yacht: 0.1, pilot: 0.1, tug: 0.09 }[kind] * L + 0.6;
  const D = Math.min(0.06 * L, 14) + 0.5;
  const hullCol = {
    container: pick([[0.12, 0.2, 0.38], [0.15, 0.15, 0.17], [0.55, 0.1, 0.1], [0.1, 0.32, 0.3]]),
    bulk: pick([[0.15, 0.15, 0.17], [0.45, 0.12, 0.1], [0.12, 0.22, 0.38]]),
    tanker: pick([[0.15, 0.15, 0.17], [0.5, 0.12, 0.1], [0.12, 0.22, 0.38]]),
    cruise: WHITE, ferry: pick([WHITE, [0.12, 0.25, 0.5]]), navy: [0.48, 0.52, 0.55], fishing: pick([[0.55, 0.12, 0.1], [0.12, 0.28, 0.45], [0.2, 0.42, 0.25]]),
    sail: WHITE, yacht: WHITE, pilot: [0.12, 0.13, 0.15], tug: pick([[0.15, 0.15, 0.17], [0.55, 0.1, 0.1], [0.12, 0.25, 0.45]]),
  }[kind];
  const deckCol = kind === "tanker" ? [0.55, 0.2, 0.15] : ["sail", "yacht"].includes(kind) ? [0.7, 0.6, 0.45] : DECK;
  // Hull: sections [x fraction, width fraction, deck rise fraction] stern to bow.
  const SEC = ["sail", "yacht"].includes(kind)
    ? [[-0.5, 0.75, 0], [-0.3, 0.98, 0], [0, 1, 0.02], [0.25, 0.85, 0.06], [0.4, 0.55, 0.1], [0.5, 0.02, 0.14]]
    : [[-0.5, 0.88, 0], [-0.35, 1, 0], [0.25, 1, 0.01], [0.38, 0.8, 0.04], [0.46, 0.45, 0.08], [0.5, 0.02, 0.12]];
  const ring = ([fx, fw, fr]) => {
    const x = fx * L, h = hb * fw, top = F * (1 + fr);
    return [[x, top, h], [x, 0, h * 0.97], [x, -D * 0.7, h * 0.8], [x, -D, h * 0.3], [x, -D, -h * 0.3], [x, -D * 0.7, -h * 0.8], [x, 0, -h * 0.97], [x, top, -h]];
  };
  const rings = SEC.map(ring), centreAt = (fc) => [fc[0], (F - D) / 2, 0];
  const hullRgb = (n, fc) => (n[1] > 0.7 ? deckCol : fc[1] < -0.3 ? RED : hullCol);
  for (let k = 1; k < rings.length; k++)
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      face([rings[k - 1][i], rings[k - 1][j], rings[k][j], rings[k][i]], hullRgb, centreAt);
    }
  face(rings[0], hullCol, centreAt); // transom
  // Superstructure, by kind.
  const sh = (x0, x1, y0, y1, w, c, z) => box(x0 * L, x1 * L, F + y0, F + y1, w, c, z);
  const deckH = 2.8;
  if (kind === "container" || kind === "bulk" || kind === "tanker") {
    const bridgeX = kind === "container" && L > 250 ? -0.12 : -0.38, tiers = Math.round(clamp(L / 22, 4, 9));
    sh(bridgeX - 0.06, bridgeX + 0.02, 0, tiers * deckH, hb * 0.85, WHITE);
    sh(bridgeX - 0.03, bridgeX + 0.015, tiers * deckH, tiers * deckH + 1.2, hb * 1.05, WHITE); // bridge wings
    const funnel = pick([[0.85, 0.2, 0.15], [0.1, 0.3, 0.6], [0.9, 0.7, 0.1], [0.15, 0.15, 0.17]]);
    sh(-0.46, -0.42, 0, tiers * deckH * 0.8, hb * 0.25, funnel);
    if (kind === "container") {
      const BOXC = [[0.8, 0.2, 0.15], [0.15, 0.35, 0.65], [0.2, 0.55, 0.3], [0.85, 0.6, 0.15], [0.55, 0.55, 0.58], [0.95, 0.95, 0.95], [0.45, 0.3, 0.2]];
      const bay = 12.8 / L, cols = Math.max(2, Math.round(B / 10));
      for (let x = -0.4; x + bay < 0.4; x += bay + 0.4 / L) {
        if (x + bay > bridgeX - 0.07 && x < bridgeX + 0.03) continue;
        for (let c = 0; c < cols; c++) {
          const w = (hb * 0.9) / cols, z = -hb * 0.9 + w * (2 * c + 1);
          const h = (Math.floor(rand() * 4) + (x > 0.3 ? 1 : 3)) * 2.6;
          sh(x, x + bay, 0, h, w * 0.95, pick(BOXC), z);
        }
      }
    } else if (kind === "bulk") {
      for (let x = -0.3; x < 0.38; x += 0.085) sh(x, x + 0.06, 0, 1.6, hb * 0.65, pick([[0.6, 0.15, 0.12], [0.2, 0.35, 0.2], [0.55, 0.55, 0.58]]));
      for (let x = -0.26; x < 0.38; x += 0.17) (sh(x - 0.004, x + 0.004, 0, 22, 0.7, [0.85, 0.75, 0.2]), sh(x - 0.004, x + 0.08, 20, 21, 0.4, [0.85, 0.75, 0.2]));
    } else {
      sh(-0.3, 0.42, 0.4, 1.4, 0.5, [0.75, 0.75, 0.7]); // pipe rack along the centreline
      sh(-0.05, 0.02, 0, 3.5, hb * 0.7, [0.75, 0.75, 0.7]); // manifold
    }
  } else if (kind === "cruise" || kind === "ferry") {
    const decks = kind === "cruise" ? Math.round(clamp(L / 22, 8, 16)) : Math.round(clamp(L / 30, 3, 6));
    const x0 = kind === "cruise" ? -0.45 : -0.38, x1 = kind === "cruise" ? 0.32 : 0.28;
    for (let d = 0; d < decks; d++) {
      const inset = d > decks - 3 ? 0.08 * (d - decks + 3) : 0;
      sh(x0 + inset, x1 - inset * 0.5, d * deckH, (d + 1) * deckH, hb * 0.92, d % 3 === 1 ? [0.3, 0.45, 0.6] : WHITE);
    }
    const funnel = kind === "cruise" ? pick([[0.85, 0.2, 0.15], [0.1, 0.3, 0.6], [0.95, 0.95, 0.95], [0.9, 0.7, 0.1]]) : [0.85, 0.2, 0.15];
    sh(-0.3, -0.2, decks * deckH, decks * deckH + 8, hb * 0.3, funnel);
  } else if (kind === "navy") {
    const G = [0.6, 0.63, 0.66];
    sh(-0.15, 0.15, 0, 3 * deckH, hb * 0.7, G);
    sh(-0.05, 0.12, 3 * deckH, 5 * deckH, hb * 0.5, G);
    sh(0.02, 0.03, 5 * deckH, 5 * deckH + 14, 0.5, [0.3, 0.3, 0.32]); // mast
    sh(0.22, 0.27, 0, 2, 1.6, G); // gun
    sh(0.27, 0.34, 1.4, 1.8, 0.25, [0.3, 0.3, 0.32]);
    sh(-0.42, -0.2, 0, 0.6, hb * 0.8, [0.45, 0.48, 0.5]); // flight deck
  } else if (kind === "sail") {
    sh(-0.25, 0.1, 0, 0.8, hb * 0.55, WHITE);
    sh(0.08, 0.1, 0, L * 1.3, 0.12, [0.8, 0.8, 0.82]); // mast
    tri([0.09 * L, F + L * 1.25, 0], [0.09 * L, F + 1.2, 0], [-0.4 * L, F + 1.4, 0], 0.03, [0.97, 0.97, 0.95]);
    tri([0.1 * L, F + L * 1.15, 0], [0.48 * L, F + 0.3, 0], [0.1 * L, F + 1.0, 0], 0.03, [0.97, 0.97, 0.95]);
  } else if (kind === "yacht") {
    sh(-0.3, 0.2, 0, 1.6, hb * 0.75, WHITE);
    sh(-0.2, 0.08, 1.6, 2.7, hb * 0.6, [0.2, 0.25, 0.3]);
  } else {
    // Tug, pilot boat, workboat, fishing boat: wheelhouse forward of amidships.
    const wh = kind === "fishing" ? [0.08, 0.32] : kind === "pilot" ? [-0.15, 0.2] : [-0.05, 0.25];
    const supCol = kind === "pilot" ? [0.95, 0.5, 0.1] : WHITE;
    sh(wh[0], wh[1], 0, deckH, hb * 0.75, supCol);
    sh(wh[0] + 0.03, wh[1] - 0.02, deckH, deckH * 1.8, hb * 0.6, supCol);
    sh(wh[0] + 0.08, wh[0] + 0.1, deckH * 1.8, deckH * 1.8 + 4, 0.15, [0.3, 0.3, 0.32]); // mast
    if (kind === "fishing") (sh(-0.46, -0.44, 0, 6, 0.15, [0.85, 0.6, 0.1], hb * 0.7), sh(-0.46, -0.44, 0, 6, 0.15, [0.85, 0.6, 0.1], -hb * 0.7), sh(-0.46, -0.44, 5.6, 6, hb * 0.7, [0.85, 0.6, 0.1]));
    if (kind === "tug") sh(-0.2, -0.15, 0, 1.2, 0.6, [0.2, 0.2, 0.22]); // towing hook
  }

  // Binary glTF: one primitive (POSITION, NORMAL, COLOR_0), white material so the vertex colours show.
  const f32 = (a) => new Float32Array(a);
  const parts = [f32(pos), f32(nrm), f32(col)], n = pos.length / 3;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) (mn[i % 3] = Math.min(mn[i % 3], pos[i])), (mx[i % 3] = Math.max(mx[i % 3], pos[i]));
  let off = 0;
  const views = parts.map((p) => ({ buffer: 0, byteOffset: (off += p.byteLength) - p.byteLength, byteLength: p.byteLength }));
  const json = {
    asset: { version: "2.0", generator: "ships-bridge" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.1, roughnessFactor: 0.6 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: "VEC3", min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: n, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: n, type: "VEC3" },
    ],
    bufferViews: views, buffers: [{ byteLength: off }],
  };
  const js = new TextEncoder().encode(JSON.stringify(json));
  const jl = Math.ceil(js.length / 4) * 4, bl = Math.ceil(off / 4) * 4;
  const glb = new Uint8Array(12 + 8 + jl + 8 + bl), dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true), dv.setUint32(4, 2, true), dv.setUint32(8, glb.length, true);
  dv.setUint32(12, jl, true), dv.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jl), glb.set(js, 20);
  dv.setUint32(20 + jl, bl, true), dv.setUint32(24 + jl, 0x004e4942, true);
  let o = 28 + jl;
  for (const p of parts) glb.set(new Uint8Array(p.buffer), o), (o += p.byteLength);
  return glb;
}
// Fill light on the ship (Cesium lights models from the sun alone; the shaded side went near black).
const FILL_SHADER = `void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  material.emissive += material.diffuse * 0.3;
}`;

// Shown in place of the model if it can't be built: the vessel from astern (hull, superstructure, funnel).
const STERN_SVG = "data:image/svg+xml;base64," + btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -40 120 70">
  <g stroke="#1b2430" stroke-width="2" stroke-linejoin="round">
    <path d="M-50,4 L50,4 L42,26 L-42,26 Z" fill="#2a3442"/>
    <path d="M-50,4 L50,4 L49,10 L-49,10 Z" fill="#c62828"/>
    <path d="M-34,4 L-34,-14 L34,-14 L34,4 Z" fill="#e8edf5"/>
    <path d="M-24,-14 L-24,-26 L24,-26 L24,-14 Z" fill="#e8edf5"/>
    <path d="M-7,-26 L-6,-38 L6,-38 L7,-26 Z" fill="#d4a72c"/>
  </g></svg>`);

// Why Cesium ion didn't hand over the Google 3D tiles, in words. Its errors are RequestErrorEvents: an HTTP status
// (none when ion couldn't be reached at all) and a response that's often JSON with a message.
function tilesReason(e) {
  const code = e?.statusCode;
  let msg = "";
  try {
    msg = String(typeof e?.response === "string" ? JSON.parse(e.response).message || "" : e?.response?.message || "");
  } catch (x) {
    msg = String(e?.response || "");
  }
  const text = msg + " " + String(e?.message || "");
  if (/quota|usage|exceeded/i.test(text)) return "this Cesium ion account's usage allowance is used up";
  if (code === 429 || /too many/i.test(text)) return "Cesium ion is limiting requests for now";
  if (code === 404) return "the Google Photorealistic 3D Tiles asset isn't in this Cesium ion account (add it from the Asset Depot)";
  if (code === 401 || code === 403) return `Cesium ion refused it from ${location.origin} (check the token's Allowed URLs and its assets:read scope)`;
  if (!code) return "couldn't reach Cesium ion";
  return `Cesium ion answered HTTP ${code}${msg ? " (" + msg + ")" : ""}`;
}

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
  .br .btns button.on { background: var(--primary-color, #03a9f4); border-color: transparent; }
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
    this.mode = "bridge"; // or "chase" (the follow view)
    this.look = { yaw: 0, pitch: 0 };
    this.fov = 60;
    this.destroyed = false;
    this._listeners = [];
    this._render();
    const saved = (k, d) => {
      try {
        return localStorage.getItem("ships-card:" + k) ?? d;
      } catch (e) {
        return d;
      }
    };
    this._setView(VIEWS[saved("view", "")] ? saved("view", "") : "behind");
    this._setSmooth(saved("smooth", "1") !== "0");
    this._setMode("bridge");
  }

  _save(k, v) {
    try {
      localStorage.setItem("ships-card:" + k, v);
    } catch (e) {}
  }

  _setMode(m) {
    this.mode = m;
    const follow = m === "chase";
    this.$.mode.textContent = follow ? "Bridge view" : "Follow view";
    this.$.viewBtn.style.display = follow ? "" : "none";
    this.$.reset.textContent = follow ? "Reset view" : "Look ahead";
    this.look = { yaw: 0, pitch: 0 };
    this.camHdg = null;
  }

  // Follow view camera angle: a preset (eased into), or Auto.
  _setView(v) {
    this.view = v;
    const t = VIEWS[v] || VIEWS.behind;
    this.orbitT = { yaw: t.yaw, pitch: t.pitch, range: t.range };
    if (!this.orbit) this.orbit = { ...this.orbitT };
    this._shot = 0;
    this._shotMs = performance.now();
    this.$.viewBtn.textContent = "View: " + t.name;
    this.$.viewBtn.classList.toggle("on", v === "auto");
    this._save("view", v);
  }

  _setSmooth(on) {
    this.smooth = !!on;
    this.$.smoothBtn.classList.toggle("on", this.smooth);
    this._save("smooth", this.smooth ? "1" : "0");
  }

  _resetView() {
    if (this.mode === "bridge") (this.look = { yaw: 0, pitch: 0 }), (this.fov = 60);
    else this._setView(this.view === "custom" ? "behind" : this.view);
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
            <button data-br="mode">Follow view</button>
            <button data-br="view" title="Camera angle: Behind, Side, Front, Above, or Auto (a new angle every few seconds). Drag to circle the vessel, wheel or pinch to zoom">View: Behind</button>
            <button data-br="smooth" title="Smooth: show the vessel ${SMOOTH_DELAY_S} s behind live, on its real path between position reports, instead of estimating ahead">Smooth</button>
            <button data-br="reset" title="Look ahead again">Look ahead</button>
            <button data-br="exit">Map</button>
          </div>
        </div>
        <div class="credits"></div>
        <div class="msg">Loading the 3D world…</div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = { scene: q(".scene"), nm: q(".ident .nm"), sub: q(".ident .sub"), tape: q(".tape"), nav: q(".nav"), sog: q(".sog b"),
      cog: q(".cog b"), hdgv: q(".cog .hdgv"), status: q(".status"), msg: q(".msg"), credits: q(".credits"), mode: q('[data-br="mode"]'),
      viewBtn: q('[data-br="view"]'), smoothBtn: q('[data-br="smooth"]'), reset: q('[data-br="reset"]') };
    this._on(this.el, "click", (e) => {
      const b = e.target.closest("[data-br]");
      if (!b) return;
      const act = b.dataset.br;
      if (act === "exit") this.opts.onExit?.();
      else if (act === "next" || act === "prev") this._step(act === "next" ? 1 : -1);
      else if (act === "mode") this._setMode(this.mode === "bridge" ? "chase" : "bridge");
      else if (act === "view") this._setView(VIEW_ORDER[(VIEW_ORDER.indexOf(this.view) + 1) % VIEW_ORDER.length]);
      else if (act === "smooth") this._setSmooth(!this.smooth);
      else if (act === "reset") this._resetView();
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
    this._token = token;
    try {
      const tiles = await this._loadTiles();
      if (this.destroyed) return void tiles.destroy();
      this.tiles = scene.primitives.add(tiles);
      scene.globe.show = false;
    } catch (e) {
      // No Google tiles: Cesium World Terrain + imagery meanwhile, and try the tiles again later (_tilesFailed).
      console.warn("ships-bridge: Google 3D tiles unavailable, falling back to terrain", e);
      try {
        w.scene.imageryLayers.add(C.ImageryLayer.fromProviderAsync(C.IonImageryProvider.fromAssetId(2)));
        w.scene.terrainProvider = await C.createWorldTerrainAsync();
        this._tilesFailed(e, "terrain");
      } catch (e2) {
        // The terrain comes from Cesium ion too, so a refused token or a rate limit stops it as well. A refused token
        // needs a new one; anything else carries on over a plain globe until the tiles come back.
        if ([401, 403].includes(e2?.statusCode) || /Invalid access token|Unauthorized/i.test(String(e2?.message || e2))) {
          this._askToken(`<b>Cesium ion refused the token.</b> Check it was copied whole, and that its Allowed URLs include <code>${esc(location.origin)}</code>, or paste another.`);
          return;
        }
        this._tilesFailed(e, "a plain globe");
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

  // Google's photorealistic 3D tiles, through Cesium ion. Throws Cesium's RequestErrorEvent (statusCode, response).
  async _loadTiles() {
    const C = this.C;
    const res = await C.IonResource.fromAssetId(GOOGLE_3D_ASSET, { accessToken: this._token });
    return C.Cesium3DTileset.fromUrl(res, { cacheBytes: 768 * 1024 * 1024, enableCollision: true, asynchronouslyLoadImagery: true });
  }

  // The tiles didn't load: say why in the status line, and try again in 1, 2, 5, then every 10 minutes. When they do
  // load they replace the fallback (`showing`: what's shown meanwhile).
  _tilesFailed(e, showing) {
    this._tilesTry = (this._tilesTry || 0) + 1;
    const min = [1, 2, 5][this._tilesTry - 1] || 10;
    this._note = `Google 3D tiles unavailable: ${tilesReason(e)}. Showing ${showing}; trying again in ${min} min`;
    clearTimeout(this._tilesTimer);
    this._tilesTimer = setTimeout(async () => {
      if (this.destroyed || !this.w || this.tiles) return;
      try {
        const tiles = await this._loadTiles();
        if (this.destroyed || !this.w) return void tiles.destroy();
        this.tiles = this.w.scene.primitives.add(tiles);
        this.w.scene.globe.show = false;
        this._note = "";
        this._tilesTry = 0;
      } catch (err) {
        console.warn("ships-bridge: Google 3D tiles still unavailable", err);
        this._tilesFailed(err, showing);
      }
    }, min * 60000);
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

  // Bridge: drag looks around, the wheel zooms the lens. Follow: drag circles the vessel, the wheel or a pinch moves
  // the camera in and out. Moving the camera by hand leaves Auto.
  _initInput() {
    const cv = this.w.canvas;
    const ptrs = new Map();
    let drag = null, pinch = null;
    const manual = () => {
      if (this.view !== "auto") return;
      this.view = "custom";
      this.$.viewBtn.textContent = "View: Auto (off)";
      this.$.viewBtn.classList.remove("on");
    };
    this._on(cv, "pointerdown", (e) => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cv.setPointerCapture?.(e.pointerId);
      if (ptrs.size === 2) {
        const [p, q] = [...ptrs.values()];
        pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, range: this.orbitT.range };
        drag = null;
      } else if (ptrs.size === 1)
        drag = { x: e.clientX, y: e.clientY, yaw: this.look.yaw, pitch: this.look.pitch, oyaw: this.orbit.yaw, opitch: this.orbit.pitch };
    });
    this._on(cv, "pointermove", (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size === 2 && this.mode !== "bridge") {
        const [p, q] = [...ptrs.values()];
        manual();
        this.orbitT.range = clamp((pinch.range * pinch.d) / (Math.hypot(p.x - q.x, p.y - q.y) || 1), 0.4, 60);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (this.mode === "bridge") {
        const k = this.fov / Math.max(200, cv.clientWidth);
        this.look.yaw = norm360(drag.yaw - dx * k + 180) - 180;
        this.look.pitch = clamp(drag.pitch + dy * k, -80, 60);
      } else {
        if (Math.abs(dx) + Math.abs(dy) > 3) manual();
        // Straight onto the camera (no easing) while dragging.
        this.orbitT.yaw = this.orbit.yaw = norm360(drag.oyaw - dx * 0.35 + 180) - 180;
        this.orbitT.pitch = this.orbit.pitch = clamp(drag.opitch + dy * 0.25, 1, 85);
      }
    });
    const end = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (!ptrs.size) drag = null;
    };
    this._on(cv, "pointerup", end);
    this._on(cv, "pointercancel", end);
    this._on(cv, "dblclick", () => this._resetView());
    this._on(cv, "wheel", (e) => {
      e.preventDefault();
      if (this.mode === "bridge") this.fov = clamp(this.fov * Math.exp(e.deltaY * 0.001), 15, 100);
      else {
        manual();
        this.orbitT.range = clamp(this.orbitT.range * Math.exp(e.deltaY * 0.0015), 0.4, 60);
      }
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
      else {
        const e = { v, recvMs: now - (fin(v.posAge) ? v.posAge : 0) * 1000, fixes: old?.fixes || [] };
        // Reports for Smooth: the last few minutes, in time order.
        const fx = { t: e.recvMs, lat: v.lat, lon: v.lon, sog: fin(v.sog) ? v.sog * KT : 0, cog: fin(v.cog) ? v.cog : null };
        while (e.fixes.length && e.fixes[e.fixes.length - 1].t >= fx.t) e.fixes.pop();
        e.fixes.push(fx);
        while (e.fixes.length > 2 && fx.t - e.fixes[0].t > 300000) e.fixes.shift();
        this.vs.set(v.mmsi, e);
      }
    }
    for (const m of this.vs.keys()) if (!seen.has(m)) this.vs.delete(m);
    if (selMmsi !== this.sel) {
      this.sel = selMmsi;
      this.anchor = null;
      this.heading = this.camHdg = null;
      this.look = { yaw: 0, pitch: 0 };
    }
  }

  _step(dir) {
    const list = [...this.vs.values()].map((x) => x.v).sort((p, q) => (p.dist ?? 1e9) - (q.dist ?? 1e9));
    if (!list.length) return;
    const i = list.findIndex((v) => v.mmsi === this.sel);
    this.opts.onPick?.(list[(i + dir + list.length) % list.length].mmsi);
  }

  // Where to show a vessel at `nowMs`: live, or with Smooth on, SMOOTH_DELAY_S earlier on a cubic Hermite curve
  // between the reports either side (matching each one's position, speed and course). Outside them (one report so
  // far, a long gap): extrapolated, from the newest report.
  _pos(entry, nowMs) {
    if (!this.smooth) return this._project(entry, nowMs);
    const tr = nowMs - SMOOTH_DELAY_S * 1000, f = entry.fixes || [];
    let j = -1;
    for (let k = f.length - 1; k > 0; k--)
      if (f[k - 1].t <= tr && tr <= f[k].t) {
        j = k;
        break;
      }
    const A = f[j - 1], B = f[j];
    if (j < 0 || B.t - A.t > SMOOTH_GAP_S * 1000) return this._project(entry, tr);
    const T = (B.t - A.t) / 1000, s = (tr - A.t) / (B.t - A.t), s2 = s * s, s3 = s2 * s;
    const kx = 111320 * Math.cos((A.lat * Math.PI) / 180), ky = 110540;
    const PB = [(B.lon - A.lon) * kx, (B.lat - A.lat) * ky];
    // Velocity from speed and course; a vessel barely moving (or with no course) uses the straight line instead.
    const vel = (F) => (F.cog != null && F.sog > 0.3 ? [F.sog * Math.sin((F.cog * Math.PI) / 180), F.sog * Math.cos((F.cog * Math.PI) / 180)] : [PB[0] / T, PB[1] / T]);
    const vA = vel(A), vB = vel(B);
    const h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d10 = 3 * s2 - 4 * s + 1, d01 = -6 * s2 + 6 * s, d11 = 3 * s2 - 2 * s;
    const P = [0, 1].map((i) => h10 * T * vA[i] + h01 * PB[i] + h11 * T * vB[i]);
    const V = [0, 1].map((i) => d10 * vA[i] + (d01 * PB[i]) / T + d11 * vB[i]);
    const sog = Math.hypot(V[0], V[1]), v = entry.v;
    const cog = sog > 0.3 ? norm360((Math.atan2(V[0], V[1]) * 180) / Math.PI) : B.cog ?? 0;
    const hdg = fin(v.hdg) && v.hdg < 360 ? v.hdg : sog > 0.5 * KT ? cog : null;
    return { lat: A.lat + P[1] / ky, lon: A.lon + P[0] / kx, sog, cog, hdg, stale: false, age: (nowMs - entry.recvMs) / 1000, smooth: true };
  }

  // Extrapolated position at `nowMs`, along the course over ground at the speed over ground (back in time too, for
  // Smooth before a second report).
  _project(entry, nowMs) {
    const v = entry.v;
    const age = Math.max(-SMOOTH_DELAY_S, (nowMs - entry.recvMs) / 1000);
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
      const exclude = [this.points, this.labels, this.bbs, this.model].filter(Boolean); // not the ship itself
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
      if (this.model) this.model.show = false;
      this.$.status.textContent = this.sel ? "Vessel out of range" : "Pick a vessel on the map, or use ◀ ▶";
      this._hud(null);
      return;
    }
    const v = entry.v;
    const p = this._pos(entry, now);
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
    else if (p.smooth) {
      // On a Smooth curve: follow it (eased over half a second, to hide the step between the curve and extrapolation).
      const corr = C.Cartesian3.subtract(target, this.anchor, new C.Cartesian3());
      if (C.Cartesian3.magnitude(corr) > 1500) C.Cartesian3.clone(target, this.anchor);
      else C.Cartesian3.add(this.anchor, C.Cartesian3.multiplyByScalar(corr, 1 - Math.exp(-dt / 0.5), corr), this.anchor);
    } else {
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

    const follow = this.mode === "chase";
    this._placeShip(v, follow);
    this.w.camera.frustum.fov = C.Math.toRadians(follow ? 60 : this.fov);
    if (follow) this._followCam(dt, now, surf);
    else {
      const enu = C.Transforms.eastNorthUpToFixedFrame(this.anchor, C.Ellipsoid.WGS84, this._enu || (this._enu = new C.Matrix4()));
      const cam = C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(0, 0, eyeHeight(v)), new C.Cartesian3());
      this.w.camera.setView({
        destination: cam,
        orientation: { heading: C.Math.toRadians(norm360(this.heading + this.look.yaw)), pitch: C.Math.toRadians(VIEW_PITCH_DEG + this.look.pitch), roll: 0 },
      });
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

  // The follow view's ship at the anchor (waterline on the surface), along the heading. Built for this vessel's kind
  // and dimensions, and rebuilt when they change (static data can arrive after the position); the stern silhouette
  // stands in until it's ready. `this.size` (its length) sets the camera's distance.
  _placeShip(v, show) {
    const C = this.C;
    if (this.model) this.model.show = false;
    this.chaseBb.show = false;
    if (!show) return;
    const kind = shipKind(v), L = clamp(fin(v.length) ? v.length : KIND_LENGTH[kind], 4, 460);
    const B = clamp(fin(v.beam) ? v.beam : L / KIND_BEAM[kind], 1.5, 70);
    const key = `${v.mmsi}|${kind}|${L}|${B}`;
    if (key !== this._shipKey && !this._shipBusy) this._loadShip(key, kind, L, B, v.mmsi);
    this.size = L;
    if (this.model) {
      const hpr = new C.HeadingPitchRoll(C.Math.toRadians(this.heading - 90), 0, 0); // bow is +X: heading 0 = east
      this.model.modelMatrix = C.Transforms.headingPitchRollToFixedFrame(this.anchor, hpr, C.Ellipsoid.WGS84, undefined, this._mm || (this._mm = new C.Matrix4()));
      this.model.show = true; // also while it loads (a hidden model isn't loaded)
    }
    if (!this.model?.ready) {
      this.chaseBb.show = true;
      this.chaseBb.position = this.anchor;
      const s = clamp(L / 100, 0.6, 1.6);
      this.chaseBb.width = 110 * s;
      this.chaseBb.height = 64 * s;
    }
  }

  async _loadShip(key, kind, L, B, seed) {
    const C = this.C;
    this._shipBusy = true;
    const url = URL.createObjectURL(new Blob([shipGlb(kind, L, B, seed)], { type: "model/gltf-binary" }));
    try {
      const m = await C.Model.fromGltfAsync({ url, forwardAxis: C.Axis.X, minimumPixelSize: 36, maximumScale: 20000, show: false,
        customShader: new C.CustomShader({ lightingModel: C.LightingModel.PBR, fragmentShaderText: FILL_SHADER }) });
      if (this.destroyed || !this.w) return void m.destroy();
      this.w.scene.primitives.add(m);
      if (this.model) this.w.scene.primitives.remove(this.model);
      this.model = m;
      this._shipKey = key;
    } catch (e) {
      console.warn("ships-bridge: ship model", e);
      this._shipKey = key; // don't retry this one
    } finally {
      URL.revokeObjectURL(url);
      this._shipBusy = false;
    }
  }

  // Follow camera: orbits the anchor at the current angle (eased onto the target angle), its bearing trailing the
  // heading on a critically damped spring; aimed at the ship's middle, kept above the water.
  _followCam(dt, now, surf) {
    const C = this.C;
    if (this.camHdg == null) (this.camHdg = this.heading), (this.camHdgV = 0);
    const w = FOLLOW_SPRING;
    const err = ((this.heading - this.camHdg + 540) % 360) - 180;
    this.camHdgV += (w * w * err - 2 * w * this.camHdgV) * dt;
    this.camHdg = norm360(this.camHdg + this.camHdgV * dt);
    const t = this.orbitT, o = this.orbit;
    if (this.view === "auto") {
      if (now - this._shotMs > AUTO_SHOT_S * 1000) {
        this._shotMs = now;
        this._shot = (this._shot + 1) % AUTO_SHOTS.length;
        Object.assign(t, AUTO_SHOTS[this._shot]);
      }
      t.yaw = norm360(t.yaw + AUTO_DRIFT_DPS * dt + 180) - 180;
    }
    const k = 1 - Math.exp(-dt / (this.view === "auto" ? AUTO_TAU_S : ORBIT_TAU_S));
    o.yaw = norm360(o.yaw + (((t.yaw - o.yaw + 540) % 360) - 180) * k + 180) - 180;
    o.pitch += (t.pitch - o.pitch) * k;
    o.range *= Math.exp(Math.log(t.range / o.range) * k);
    const L = this.size || 60, range = o.range * L + 15, b = C.Math.toRadians(this.camHdg + 180 - o.yaw), pr = C.Math.toRadians(o.pitch);
    const enu = C.Transforms.eastNorthUpToFixedFrame(this.anchor, C.Ellipsoid.WGS84, this._enu || (this._enu = new C.Matrix4()));
    const aim = C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(0, 0, Math.min(L * 0.05, 12)), new C.Cartesian3()); // a little above the waterline
    const cam = C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(Math.sin(b) * range * Math.cos(pr), Math.cos(b) * range * Math.cos(pr), range * Math.sin(pr) + Math.min(L * 0.05, 12)), new C.Cartesian3());
    const cc = C.Cartographic.fromCartesian(cam);
    if (cc && cc.height < surf + 2) (cc.height = surf + 2), C.Cartographic.toCartesian(cc, C.Ellipsoid.WGS84, cam);
    const dir = C.Cartesian3.normalize(C.Cartesian3.subtract(aim, cam, new C.Cartesian3()), new C.Cartesian3());
    const surfUp = C.Ellipsoid.WGS84.geodeticSurfaceNormal(cam, new C.Cartesian3());
    const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, surfUp, new C.Cartesian3()), new C.Cartesian3());
    this.w.camera.setView({ destination: cam, orientation: { direction: dir, up: C.Cartesian3.cross(right, dir, new C.Cartesian3()) } });
  }

  _drawTraffic(now) {
    const C = this.C;
    const keep = new Set();
    for (const [mmsi, entry] of this.vs) {
      if (mmsi === this.sel) continue;
      const p = this._pos(entry, now);
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
    clearTimeout(this._tilesTimer);
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
