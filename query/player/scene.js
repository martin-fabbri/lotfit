// Deterministic, seekable 3D player driven entirely by `trace.json` (`buildnexus.decision-trace/1`).
// Everything on screen is a pure function of time `t` and `trace.json` (plus optional `timeline.json`).
// World mapping per `trace.frame.three`: `(X = x, Y = z, Z = -y)`, so a viewer in the street (`y < 0 => Z > 0`)
// looking toward the rear (`y > 0 => Z < 0`) sees `x = 0` at the front-left corner, unmirrored (A6, A8).
import * as THREE from "three";
import { fmt, summaryCard } from "./summary.js";

const W = 1280, H = 720;
const pageParams = new URLSearchParams(location.search);
const TRACE_URL =
  pageParams.get("trace") || document.body?.dataset?.trace || "demo/eug-demo-24x24.trace.json";

async function fetchJsonOptional(primaryUrl, fallbackUrl) {
  for (const url of [primaryUrl, fallbackUrl]) {
    if (!url) continue;
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      // ignore and try fallback
    }
  }
  return null;
}

const trace = await fetchJsonOptional(TRACE_URL, "trace.json");
if (!trace) {
  throw new Error(`Failed to load decision trace from ${TRACE_URL}`);
}
const rawTimeline = await fetchJsonOptional(pageParams.get("timeline") || "timeline.json", null);

// ---------- math & geometry helpers ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x) => {
  x = clamp(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const lerp = (a, b, k) => a + (b - a) * k;

// Right-handed lot frame -> Three.js world frame: (X = x, Y = z, Z = -y)
const frameThree = trace.frame?.three ?? { X: "x", Y: "z", Z: "-y" };
function toWorld(x, y, z = 0) {
  const X = frameThree.X === "-x" ? -x : x;
  const Y = frameThree.Y === "-z" ? -z : z;
  const Z = frameThree.Z === "-y" ? -y : y;
  return new THREE.Vector3(X, Y, Z);
}

function polyBbox(poly) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return {
    x0,
    x1,
    y0,
    y1,
    w: x1 - x0,
    d: y1 - y0,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
  };
}

function polyAreaSqft(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

// ---------- beat schedule (from trace.beats, merged with optional timeline.json) ----------
const BEAT_DURATION_S = 5.4;
const BEAT_GAP_S = 0.6;
const INTRO_S = 1.0;
const OUTRO_S = 2.0;

const rawBeats = Array.isArray(trace.beats) && trace.beats.length > 0
  ? trace.beats
  : [{ id: "b1", kind: "establish", refs: [] }];

const timelineBeatsById = Object.fromEntries(
  (rawTimeline?.beats ?? []).map((b) => [b.id, b]),
);

const scheduledBeats = rawBeats.map((b, idx) => {
  const tb = timelineBeatsById[b.id];
  const start = typeof tb?.start === "number" ? tb.start : +(INTRO_S + idx * (BEAT_DURATION_S + BEAT_GAP_S)).toFixed(3);
  const end = typeof tb?.end === "number" ? tb.end : +(start + BEAT_DURATION_S).toFixed(3);
  const kind = b.kind || b.scene || "establish";
  const chapterNum = String(idx + 1).padStart(2, "0");
  return {
    ...b,
    id: b.id,
    kind,
    refs: Array.isArray(b.refs) ? b.refs : [],
    start,
    end,
    chapter: tb?.chapter || `${chapterNum} · ${kind.replace(/_/g, " ")}`,
    speaker: tb?.speaker || null,
    words: Array.isArray(tb?.words) ? tb.words : null,
  };
});

const totalDuration =
  typeof rawTimeline?.duration === "number"
    ? rawTimeline.duration
    : +(scheduledBeats[scheduledBeats.length - 1].end + OUTRO_S).toFixed(3);
const fps = typeof rawTimeline?.fps === "number" ? rawTimeline.fps : 30;

function beatProgress(beatObj, a, b, t) {
  if (!beatObj) return 0;
  return clamp((t - (beatObj.start + a)) / Math.max(0.001, b - a));
}

function beatLife(t, fromBeat, untilBeat, inDur = 0.7, outDur = 0.7, fromOffset = 0) {
  if (!fromBeat) return 0;
  const s = fromBeat.start + fromOffset;
  const k = ease((t - s) / inDur);
  if (!untilBeat) return k;
  const e = untilBeat.start - 0.3;
  return Math.min(k, 1 - ease((t - e) / outDur));
}

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
document.getElementById("stage").prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0d1117");
scene.fog = new THREE.Fog("#0d1117", 260, 560);
const camera = new THREE.PerspectiveCamera(38, W / H, 1, 2000);

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...o });
const ghost = (color, opacity = 0.32) =>
  new THREE.MeshStandardMaterial({ color, transparent: true, opacity, depthWrite: false, roughness: 0.6 });

// ---------- site lot & context ----------
const lotPoly = Array.isArray(trace.site?.lot)
  ? trace.site.lot
  : Array.isArray(trace.site?.lot?.polygon)
    ? trace.site.lot.polygon
    : [[0, 0], [50, 0], [50, 100], [0, 100]];
const lotBox = polyBbox(lotPoly);
const lotAreaSqft = Math.round(polyAreaSqft(lotPoly));
const units = trace.frame?.units || trace.site?.units || "ft";

const hemi = new THREE.HemisphereLight("#d8e8ff", "#2a313a", 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#fff3dc", 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const shadowSpan = Math.max(lotBox.w, lotBox.d) * 0.95;
Object.assign(sun.shadow.camera, {
  left: -shadowSpan,
  right: shadowSpan,
  top: shadowSpan,
  bottom: -shadowSpan,
  near: 1,
  far: 500,
});
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.target.position.copy(toWorld(lotBox.cx, lotBox.cy, 0));
scene.add(sun, sun.target);

// Ground plane
const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), mat("#151b23"));
ground.rotation.x = -Math.PI / 2;
ground.position.copy(toWorld(lotBox.cx, lotBox.cy, -0.02));
ground.receiveShadow = true;
scene.add(ground);

// Lot surface from trace.site.lot
const lotMesh = new THREE.Mesh(new THREE.PlaneGeometry(lotBox.w, lotBox.d), mat("#4b6345"));
lotMesh.rotation.x = -Math.PI / 2;
lotMesh.position.copy(toWorld(lotBox.cx, lotBox.cy, 0));
lotMesh.receiveShadow = true;
scene.add(lotMesh);

// Street in front of front lot line (y < lotBox.y0 => Z > -lotBox.y0)
const streetDepth = 26;
const street = new THREE.Mesh(new THREE.PlaneGeometry(lotBox.w * 4.8, streetDepth), mat("#22272f"));
street.rotation.x = -Math.PI / 2;
street.position.copy(toWorld(lotBox.cx, lotBox.y0 - streetDepth * 0.6, 0.01));
street.receiveShadow = true;
scene.add(street);

// Neighbor context lots
for (const sideSign of [-1, 1]) {
  const nx = lotBox.cx + sideSign * (lotBox.w + 2);
  const nLot = new THREE.Mesh(new THREE.PlaneGeometry(lotBox.w, lotBox.d), mat("#26302a"));
  nLot.rotation.x = -Math.PI / 2;
  nLot.position.copy(toWorld(nx, lotBox.cy, 0));
  nLot.receiveShadow = true;
  scene.add(nLot);
}

// 10-unit grid over lot in world coordinates
{
  const pts = [];
  const step = 10;
  for (let x = lotBox.x0; x <= lotBox.x1 + 1e-6; x += step) {
    const a = toWorld(x, lotBox.y0, 0.03);
    const b = toWorld(x, lotBox.y1, 0.03);
    pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  for (let y = lotBox.y0; y <= lotBox.y1 + 1e-6; y += step) {
    const a = toWorld(lotBox.x0, y, 0.03);
    const b = toWorld(lotBox.x1, y, 0.03);
    pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  scene.add(
    new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.07 }),
    ),
  );
}

// Dashed lot boundary polyline from trace.site.lot
const lotLine = (() => {
  const closedPts = [...lotPoly, lotPoly[0]].map(([x, y]) => toWorld(x, y, 0.08));
  const g = new THREE.BufferGeometry().setFromPoints(closedPts);
  const l = new THREE.Line(
    g,
    new THREE.LineDashedMaterial({ color: "#ffffff", dashSize: 2, gapSize: 1.2, transparent: true, opacity: 0.85 }),
  );
  l.computeLineDistances();
  scene.add(l);
  return l;
})();

// ---------- HTML labels helper ----------
const labelRoot = document.getElementById("labels");
const labels = {};
function ensureLabel(id, cls = "") {
  if (!labels[id]) {
    const el = document.createElement("div");
    el.className = ("lbl " + cls).trim();
    el.style.opacity = "0";
    labelRoot.appendChild(el);
    labels[id] = { el, html: null };
  }
  return labels[id];
}

const projVec = new THREE.Vector3();
function placeLabel(id, worldPos, html, opacity, color) {
  const L = ensureLabel(id);
  if (opacity <= 0.01 || !worldPos) {
    L.el.style.opacity = "0";
    return;
  }
  if (L.html !== html) {
    L.el.innerHTML = html;
    L.html = html;
  }
  projVec.copy(worldPos).project(camera);
  const behind = projVec.z > 1;
  L.el.style.left = (((projVec.x + 1) / 2) * W).toFixed(1) + "px";
  L.el.style.top = (((1 - projVec.y) / 2) * H).toFixed(1) + "px";
  L.el.style.opacity = String(behind ? 0 : opacity);
  L.el.style.borderColor = color || "rgba(232,237,243,.14)";
  L.el.style.color = color || "#e8edf3";
}

// ---------- existing structures from trace.site.existing[] (A8) ----------
const existingStructures = [];
const existingList = Array.isArray(trace.site?.existing) ? trace.site.existing : [];

for (const st of existingList) {
  const poly = st.outline || st.footprint;
  if (!Array.isArray(poly) || poly.length < 3) continue;
  const sb = polyBbox(poly);
  const areaSqft = Math.round(polyAreaSqft(poly));
  const isHouse = st.kind === "house" || st.id === "house";
  const totalH =
    typeof st.height_ft === "number"
      ? st.height_ft
      : typeof st.height === "number"
        ? st.height
        : isHouse
          ? 18
          : 9.5;
  const wallH = isHouse ? Math.min(12, totalH * 0.72) : totalH * 0.85;
  const roofH = Math.max(1.2, totalH - wallH);

  const group = new THREE.Group();
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(sb.w, wallH, sb.d),
    mat(isHouse ? "#b9b2a6" : "#8c8275"),
  );
  walls.position.set(0, wallH / 2, 0);
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  const roofShape = new THREE.Shape();
  roofShape.moveTo(-sb.w / 2 - 0.6, 0);
  roofShape.lineTo(sb.w / 2 + 0.6, 0);
  roofShape.lineTo(0, roofH);
  roofShape.closePath();
  const roof = new THREE.Mesh(
    new THREE.ExtrudeGeometry(roofShape, { depth: sb.d + 1.2, bevelEnabled: false }),
    mat(isHouse ? "#59606b" : "#4b525c"),
  );
  roof.position.set(0, wallH, -(sb.d / 2 + 0.6));
  roof.castShadow = true;
  roof.receiveShadow = true;
  group.add(roof);

  group.position.copy(toWorld(sb.cx, sb.cy, 0));
  scene.add(group);

  // Guard optional window features on existing structure
  const featureMeshes = [];
  if (Array.isArray(st.features)) {
    for (const feat of st.features) {
      if (Array.isArray(feat.x) && feat.x.length === 2 && typeof feat.sill === "number" && typeof feat.head === "number") {
        const fw = Math.abs(feat.x[1] - feat.x[0]);
        const fh = Math.max(0.5, feat.head - feat.sill);
        const fMat = new THREE.MeshStandardMaterial({
          color: "#ffd98a",
          emissive: "#ffb648",
          emissiveIntensity: 0.5,
          roughness: 0.3,
        });
        const fMesh = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), fMat);
        fMesh.position.copy(toWorld((feat.x[0] + feat.x[1]) / 2, sb.y1 + 0.06, (feat.sill + feat.head) / 2));
        scene.add(fMesh);
        featureMeshes.push(fMesh);
      }
    }
  }

  existingStructures.push({
    id: st.id,
    kind: st.kind || st.id,
    bbox: sb,
    areaSqft,
    totalH,
    group,
    featureMeshes,
    labelId: `existing_${st.id}`,
  });
}

// ---------- constraint zones, front-or-behind dashed line & height limit ----------
const constraintList = Array.isArray(trace.constraints) ? trace.constraints : [];
const zoneColorByKind = {
  setback: "#ff5d5d",
  separation: "#ff8a4c",
  easement: "#f5b342",
  plan_constraint: "#7fd8ff",
  gate: "#5ee08a",
  exception: "#f5b342",
};

function isFrontOrBehindConstraint(c, polyBox) {
  if (
    Array.isArray(c.measures) &&
    c.measures.some((m) => m.limit?.param?.includes("front_lot_line_setback"))
  ) {
    return true;
  }
  // A deep front strip starting at y0 that overlaps the primary house in the front half
  if (
    polyBox &&
    Math.abs(polyBox.y0 - lotBox.y0) < 1e-3 &&
    Math.abs(polyBox.w - lotBox.w) < 1e-3 &&
    polyBox.d >= lotBox.d * 0.25
  ) {
    return true;
  }
  return false;
}

const zoneVisuals = [];
const lineVisuals = []; // dashed threshold lines (e.g. 40 ft front-or-behind line)

constraintList.forEach((c, idx) => {
  const polyList = [];
  if (Array.isArray(c.zone) && c.zone.length >= 3) {
    polyList.push(c.zone);
  }
  if (Array.isArray(c.zones)) {
    for (const zItem of c.zones) {
      const p = zItem?.polygon || zItem;
      if (Array.isArray(p) && p.length >= 3) polyList.push(p);
    }
  }

  polyList.forEach((poly, pIdx) => {
    const zb = polyBbox(poly);

    // Draw front-or-behind rule (e.g. 40 ft from front lot line) as a dashed line across the lot,
    // never as a filled zone over the primary house.
    if (isFrontOrBehindConstraint(c, zb)) {
      const lineY = zb.y1;
      const linePts = [
        toWorld(lotBox.x0, lineY, 0.22),
        toWorld(lotBox.x1, lineY, 0.22),
      ];
      const lineGeom = new THREE.BufferGeometry().setFromPoints(linePts);
      const lineMat = new THREE.LineDashedMaterial({
        color: "#f5b342",
        dashSize: 1.8,
        gapSize: 1.0,
        transparent: true,
        opacity: 0,
      });
      const dashedLine = new THREE.Line(lineGeom, lineMat);
      dashedLine.computeLineDistances();
      scene.add(dashedLine);

      lineVisuals.push({
        constraint: c,
        lineY,
        dashedLine,
        labelId: `line_${idx}_${pIdx}`,
      });
      return;
    }

    const color = zoneColorByKind[c.kind] || "#ff5d5d";
    const planeMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(zb.w, zb.d), planeMat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.copy(toWorld(zb.cx, zb.cy, 0.12 + zoneVisuals.length * 0.01));

    const slabMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(zb.w, 1, zb.d), slabMat);
    slab.position.copy(toWorld(zb.cx, zb.cy, 0.5));

    const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0 });
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(zb.w, 1, zb.d)), edgeMat);
    edge.position.copy(slab.position);

    // Stagger setback label anchor positions so west, east, and rear setback labels never collide
    const isWest = Math.abs(zb.x0 - lotBox.x0) < 1e-3 && zb.w < lotBox.w * 0.5;
    const isEast = Math.abs(zb.x1 - lotBox.x1) < 1e-3 && zb.w < lotBox.w * 0.5;
    const isRear = Math.abs(zb.y1 - lotBox.y1) < 1e-3 && zb.d < lotBox.d * 0.5;
    const labelAnchor = isWest
      ? toWorld(zb.cx, lotBox.y0 + lotBox.d * 0.68, 2.2)
      : isEast
        ? toWorld(zb.cx, lotBox.y0 + lotBox.d * 0.34, 2.2)
        : isRear
          ? toWorld(lotBox.cx, zb.cy, 2.2)
          : toWorld(zb.cx, zb.cy, 2.2);

    scene.add(plane, slab, edge);
    zoneVisuals.push({
      key: `${c.provision_id || c.id || idx}_${pIdx}`,
      constraint: c,
      bbox: zb,
      isWest,
      isEast,
      isRear,
      labelAnchor,
      plane,
      slab,
      edge,
      color,
      labelId: `zone_${idx}_${pIdx}`,
    });
  });
});

// Find height constraint dynamically from trace.constraints
const heightConstraint = constraintList.find(
  (c) =>
    c.kind === "height" ||
    (Array.isArray(c.measures) && c.measures.some((m) => m.limit?.param?.includes("height"))),
);
const maxAllowedHeightFt =
  heightConstraint?.measures?.[0]?.limit?.value ??
  heightConstraint?.height ??
  heightConstraint?.value ??
  20;
const planHeightFt = heightConstraint?.measures?.[0]?.value ?? maxAllowedHeightFt;

// Derive buildable envelope from trace.envelope or from lotBox minus setback zones
const derivedEnvPoly = (() => {
  if (Array.isArray(trace.envelope?.polygon) && trace.envelope.polygon.length >= 3) {
    return trace.envelope.polygon;
  }
  let x0 = lotBox.x0;
  let x1 = lotBox.x1;
  let y0 = lotBox.y0;
  let y1 = lotBox.y1;
  for (const zv of zoneVisuals) {
    if (zv.constraint.kind !== "setback") continue;
    const b = zv.bbox;
    if (zv.isWest) x0 = Math.max(x0, b.x1);
    if (zv.isEast) x1 = Math.min(x1, b.x0);
    if (zv.isRear) y1 = Math.min(y1, b.y0);
  }
  const houseStruct = existingStructures.find((s) => s.kind === "house" || s.id === "house");
  if (houseStruct && houseStruct.bbox.y1 > y0 && houseStruct.bbox.y1 < y1) {
    y0 = Math.max(y0, houseStruct.bbox.y1);
  }
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
})();

const envBox = polyBbox(derivedEnvPoly);
const envAreaSqft = Math.round(trace.envelope?.area_sqft ?? polyAreaSqft(derivedEnvPoly));

const heightPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(envBox.w, envBox.d),
  new THREE.MeshBasicMaterial({
    color: "#7fd8ff",
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
);
heightPlane.rotation.x = -Math.PI / 2;
heightPlane.position.copy(toWorld(envBox.cx, envBox.cy, maxAllowedHeightFt));

const heightEdge = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(envBox.w, envBox.d)),
  new THREE.LineBasicMaterial({ color: "#7fd8ff", transparent: true, opacity: 0 }),
);
heightEdge.rotation.x = -Math.PI / 2;
heightEdge.position.copy(heightPlane.position);
scene.add(heightPlane, heightEdge);

const envVolume = new THREE.Mesh(
  new THREE.BoxGeometry(envBox.w, 1, envBox.d),
  new THREE.MeshBasicMaterial({ color: "#4fd1c5", transparent: true, opacity: 0, depthWrite: false }),
);
const envVolumeEdge = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(envBox.w, 1, envBox.d)),
  new THREE.LineBasicMaterial({ color: "#4fd1c5", transparent: true, opacity: 0 }),
);
const envFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(envBox.w, envBox.d),
  new THREE.MeshBasicMaterial({
    color: "#4fd1c5",
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
);
envFloor.rotation.x = -Math.PI / 2;
envFloor.position.copy(toWorld(envBox.cx, envBox.cy, 0.2));
scene.add(envVolume, envVolumeEdge, envFloor);

// ---------- options from trace.options[] (no hardcoded R1..R3, F1) ----------
const optionVisuals = [];
const optionList = Array.isArray(trace.options) ? trace.options : [];

for (const opt of optionList) {
  const poly = opt.outline || opt.footprint;
  if (!Array.isArray(poly) || poly.length < 3) continue;
  const ob = polyBbox(poly);
  const areaSqft = Math.round(polyAreaSqft(poly));
  const isSelected = opt.status === "selected" || opt.status === "conditional";
  const baseColor = isSelected ? "#eef1f4" : "#dfe7ef";
  const edgeColor = isSelected ? "#4fd1c5" : "#ff5d5d";
  const optHeight = typeof opt.height === "number" ? opt.height : planHeightFt;

  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(ob.w, 1, ob.d),
    isSelected ? mat(baseColor, { roughness: 0.7, transparent: true, opacity: 0 }) : ghost(baseColor, 0),
  );
  body.position.y = 0.5;
  group.add(body);

  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(ob.w, 1, ob.d)),
    new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0 }),
  );
  edge.position.y = 0.5;
  group.add(edge);

  group.position.copy(toWorld(ob.cx, ob.cy, 0));
  group.visible = false;
  scene.add(group);

  optionVisuals.push({
    id: opt.id,
    option: opt,
    bbox: ob,
    areaSqft,
    heightFt: optHeight,
    isSelected,
    group,
    body,
    edge,
    labelId: `opt_${opt.id}`,
  });
}

// ---------- dimension line helper ----------
function createDimLine(color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(18), 3));
  const l = new THREE.LineSegments(
    g,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false }),
  );
  l.renderOrder = 10;
  scene.add(l);
  return {
    line: l,
    set(a, b, op, tick = 1.2) {
      if (op <= 0.01) {
        l.material.opacity = 0;
        return;
      }
      const p = l.geometry.attributes.position.array;
      const dir = new THREE.Vector3().subVectors(b, a).normalize();
      const n =
        Math.abs(dir.y) > 0.9
          ? new THREE.Vector3(tick, 0, 0)
          : new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(tick);
      const pts = [a, b, a.clone().add(n), a.clone().sub(n), b.clone().add(n), b.clone().sub(n)];
      pts.forEach((q, i) => {
        p[i * 3] = q.x;
        p[i * 3 + 1] = q.y;
        p[i * 3 + 2] = q.z;
      });
      l.geometry.attributes.position.needsUpdate = true;
      l.material.opacity = op;
    },
  };
}

const dims = {
  height: createDimLine("#7fd8ff"),
  envW: createDimLine("#4fd1c5"),
  sideWest: createDimLine("#5ee08a"),
  sideEast: createDimLine("#5ee08a"),
  rear: createDimLine("#5ee08a"),
};

// ---------- camera shots (unmirrored street-to-rear view in world coordinates) ----------
function shotForBeat(b, t) {
  const dt = Math.max(0, t - b.start);
  const kind = b.kind;
  let basePos;
  let baseTgt;

  if (kind === "establish") {
    const k = ease((t - 0.2) / Math.max(2.5, (b.end - b.start) * 0.75));
    const topPos = toWorld(lotBox.cx, lotBox.cy, Math.max(lotBox.w, lotBox.d) * 2.1);
    const obliquePos = toWorld(lotBox.cx - lotBox.w * 1.1, -lotBox.d * 0.55, lotBox.d * 0.9);
    const tgt = toWorld(lotBox.cx, lotBox.cy, 0);
    return { pos: topPos.lerp(obliquePos, k), tgt };
  }

  if (kind === "constrain") {
    basePos = toWorld(lotBox.cx - lotBox.w * 0.7, -lotBox.d * 0.45, lotBox.d * 0.85);
    baseTgt = toWorld(lotBox.cx, lotBox.cy * 1.1, 0);
  } else if (kind === "height") {
    basePos = toWorld(lotBox.cx + lotBox.w * 1.15, -lotBox.d * 0.35, maxAllowedHeightFt * 2.2);
    baseTgt = toWorld(envBox.cx, envBox.cy, maxAllowedHeightFt * 0.5);
  } else if (kind === "envelope") {
    basePos = toWorld(lotBox.cx - lotBox.w * 0.95, -lotBox.d * 0.4, lotBox.d * 0.72);
    baseTgt = toWorld(envBox.cx, envBox.cy, maxAllowedHeightFt * 0.35);
  } else if (kind === "reject") {
    const rej = optionVisuals.find((o) => b.refs.includes(o.id) || !o.isSelected) || optionVisuals[0];
    const focusBox = rej ? rej.bbox : envBox;
    basePos = toWorld(lotBox.cx - lotBox.w * 0.85, focusBox.cy - lotBox.d * 0.65, lotBox.d * 0.55);
    baseTgt = toWorld(focusBox.cx, focusBox.cy, (rej?.heightFt ?? 12) * 0.35);
  } else if (kind === "place" || kind === "shadow") {
    const sel = optionVisuals.find((o) => b.refs.includes(o.id) || o.isSelected) || optionVisuals[optionVisuals.length - 1];
    const focusBox = sel ? sel.bbox : envBox;
    basePos = toWorld(lotBox.cx + lotBox.w * 0.95, focusBox.cy - lotBox.d * 0.68, lotBox.d * 0.58);
    baseTgt = toWorld(focusBox.cx, focusBox.cy, (sel?.heightFt ?? 15) * 0.35);
  } else {
    // caveats or summary
    basePos = toWorld(lotBox.cx - lotBox.w * 1.1, -lotBox.d * 0.55, lotBox.d * 1.05);
    baseTgt = toWorld(lotBox.cx, lotBox.cy * 1.08, 0);
  }

  const off = basePos.clone().sub(baseTgt);
  const ang = 0.012 * dt;
  const c = Math.cos(ang), sn = Math.sin(ang);
  const rot = new THREE.Vector3(off.x * c - off.z * sn, off.y, off.x * sn + off.z * c);
  return { pos: baseTgt.clone().add(rot), tgt: baseTgt };
}

function cameraAt(t) {
  let idx = scheduledBeats.findIndex((b) => t < b.start - 0.5);
  idx = idx === -1 ? scheduledBeats.length - 1 : Math.max(0, idx - 1);
  const cur = shotForBeat(scheduledBeats[idx], t);
  if (idx > 0) {
    const k = ease((t - (scheduledBeats[idx].start - 0.5)) / 1.8);
    if (k < 1) {
      const prev = shotForBeat(scheduledBeats[idx - 1], t);
      return { pos: prev.pos.lerp(cur.pos, k), tgt: prev.tgt.lerp(cur.tgt, k) };
    }
  }
  return cur;
}

// ---------- HUD ----------
const $ = (s) => document.querySelector(s);
const hud = {
  chapter: $("#chapter"),
  card: $("#card"),
  sun: $("#sun"),
  sunTxt: $("#sun span"),
  who: $("#cap .who"),
  txt: $("#cap .txt"),
  cap: $("#cap"),
  title: $("#title"),
};

const selectedOptVis = optionVisuals.find((o) => o.isSelected) || optionVisuals[optionVisuals.length - 1];
const titleHeading = trace.project?.title
  ? trace.project.title.split(" — ")[0]
  : `Lot ${fmt(lotBox.w)} × ${fmt(lotBox.d)} ${units} · ADU Feasibility`;
const titleSub = trace.project?.purpose
  ? `${trace.project.purpose} · ${trace.project.jurisdiction || ""}`
  : `Schema ${trace.schema} · Frame ${trace.frame?.origin || "front-left"} (${frameThree.X}, ${frameThree.Y}, ${frameThree.Z})`;
$("#title h1").textContent = titleHeading;
$("#title p").textContent = titleSub;

const chip = (cls, txt) => `<span class="chip ${cls}">${txt}</span>`;
let lastCardHtml = null;
let lastCapBeatId = null;
let lastChapter = null;

function activeBeatAt(t) {
  let cur = scheduledBeats[0];
  for (const b of scheduledBeats) {
    if (t >= b.start - 0.3) cur = b;
  }
  return cur;
}

function renderCardForBeat(b) {
  if (!b) return "";
  const kind = b.kind;

  if (kind === "establish") {
    const structRows = existingStructures
      .map(
        (s) =>
          `<div class="metric"><span>${s.id} (${s.kind})</span><b>${fmt(s.bbox.w)} × ${fmt(s.bbox.d)} ${units} (${fmt(s.areaSqft)} sq ft)</b></div>`,
      )
      .join("");
    return `<div class="src"><span>Site geometry</span>${chip("ok", "LOT FRAME")}</div>
      <div class="ttl">${fmt(lotBox.w)} × ${fmt(lotBox.d)} ${units} (${fmt(lotAreaSqft)} sq ft)</div>
      <div class="val">Origin: ${trace.frame?.origin || "front-left"} · Three: (${frameThree.X}, ${frameThree.Y}, ${frameThree.Z})</div>
      ${structRows}`;
  }

  if (kind === "constrain" || kind === "height") {
    const refConstraints = constraintList.filter((c) => b.refs.includes(c.provision_id));
    const shown = (refConstraints.length > 0 ? refConstraints : constraintList).slice(0, 5);
    const rows = shown
      .map((c) => {
        const m0 = c.measures?.[0];
        const valTxt =
          m0 && m0.limit
            ? `${fmt(m0.value)} / ${fmt(m0.limit.value)} ${m0.unit}`
            : c.value !== null && c.value !== undefined
              ? `${fmt(c.value)} ${c.unit || ""}`.trim()
              : c.outcome || c.kind;
        return `<div class="metric"><span>${c.provision_id}</span><b>${valTxt}</b></div>`;
      })
      .join("");
    const badge = kind === "height" ? "HEIGHT" : "CONSTRAINTS";
    return `<div class="src"><span>Code provisions</span>${chip("rule", badge)}</div>
      <div class="ttl">${kind === "height" ? `Max height ${fmt(maxAllowedHeightFt)} ${units}` : "Active code rules"}</div>
      ${rows}`;
  }

  if (kind === "envelope") {
    return `<div class="src"><span>Derived from setbacks</span>${chip("ok", "ENVELOPE")}</div>
      <div class="ttl">Buildable rear envelope</div>
      <div class="metric"><span>Ground area</span><b>${fmt(envAreaSqft)} sq ft</b></div>
      <div class="metric"><span>Max height</span><b>${fmt(maxAllowedHeightFt)} ${units}</b></div>
      <div class="metric"><span>Width × depth</span><b>${fmt(envBox.w)} × ${fmt(envBox.d)} ${units}</b></div>`;
  }

  if (kind === "reject") {
    const optVis =
      optionVisuals.find((o) => b.refs.includes(o.id)) ||
      optionVisuals.find((o) => !o.isSelected);
    if (!optVis) return "";
    const opt = optVis.option;
    const whyHtml = (opt.why || [])
      .slice(0, 4)
      .map((w) => `<div class="rsn">• ${w}</div>`)
      .join("");
    return `<div class="src"><span>${opt.id} at (${fmt(opt.placement.x)}, ${fmt(opt.placement.y)})</span>${chip("no", "REJECTED")}</div>
      <div class="ttl">${fmt(optVis.bbox.w)} × ${fmt(optVis.bbox.d)} ${units} (${fmt(optVis.areaSqft)} sq ft)</div>
      ${whyHtml}`;
  }

  if (kind === "place" || kind === "shadow") {
    const optVis =
      optionVisuals.find((o) => b.refs.includes(o.id)) || selectedOptVis;
    if (!optVis) return "";
    const opt = optVis.option;
    const marginRows = (opt.margins || [])
      .slice(0, 5)
      .map((m) => {
        const label = m.limit?.param || m.limit?.provision_id || m.unit;
        const sign = m.margin >= 0 ? `+${fmt(m.margin)}` : `${fmt(m.margin)}`;
        return `<div class="metric"><span>${label}</span><b>${fmt(m.value)} ${m.unit} (${sign} ${m.unit})</b></div>`;
      })
      .join("");
    return `<div class="src"><span>${opt.id} at (${fmt(opt.placement.x)}, ${fmt(opt.placement.y)})</span>${chip("ok", opt.status.toUpperCase())}</div>
      <div class="ttl">${fmt(optVis.bbox.w)} × ${fmt(optVis.bbox.d)} ${units} · ${fmt(optVis.areaSqft)} sq ft</div>
      ${marginRows}`;
  }

  if (kind === "summary" || kind === "caveats") {
    return summaryCard(selectedOptVis?.option ?? null, selectedOptVis?.areaSqft ?? 0, constraintList);
  }

  return "";
}

// ---------- optional solar configuration (guarded when solar block is absent) ----------
const solarConstraint = constraintList.find((c) => c.kind === "solar" && c.sun);
const hasSolar = Boolean(solarConstraint?.sun);

function sunDir(altDeg, azDeg) {
  const a = THREE.MathUtils.degToRad(altDeg);
  const z = THREE.MathUtils.degToRad(azDeg);
  return new THREE.Vector3(Math.sin(z) * Math.cos(a), Math.sin(a), Math.cos(z) * Math.cos(a));
}

// ---------- deterministic seek(t) ----------
const establishBeat = scheduledBeats.find((b) => b.kind === "establish") || scheduledBeats[0];
const constrainBeat = scheduledBeats.find((b) => b.kind === "constrain") || scheduledBeats[1] || establishBeat;
const heightBeat = scheduledBeats.find((b) => b.kind === "height") || constrainBeat;
const envelopeBeat = scheduledBeats.find((b) => b.kind === "envelope") || heightBeat;
const rejectBeat = scheduledBeats.find((b) => b.kind === "reject") || null;
const placeBeat = scheduledBeats.find((b) => b.kind === "place") || null;
const shadowBeat = scheduledBeats.find((b) => b.kind === "shadow") || null;
const summaryBeat = scheduledBeats[scheduledBeats.length - 1];

function seek(t) {
  const cam = cameraAt(t);
  camera.position.copy(cam.pos);
  camera.lookAt(cam.tgt);
  camera.updateMatrixWorld(true);

  // Sun position (guarded if solar is absent)
  const shadowMix =
    hasSolar && shadowBeat
      ? beatLife(t, shadowBeat, summaryBeat, 0.8, 0.8, 0)
      : 0;
  const sunAlt = hasSolar ? lerp(52, solarConstraint.sun.altitude_deg ?? 22.5, shadowMix) : 52;
  const sunAz = lerp(-35, 0, shadowMix);
  sun.position.copy(sun.target.position).add(sunDir(sunAlt, sunAz).multiplyScalar(220));
  sun.intensity = lerp(2.5, 3.1, shadowMix);
  hemi.intensity = lerp(1.15, 0.65, shadowMix);
  hud.sun.style.opacity = String(hasSolar ? shadowMix : 0);
  if (hasSolar && hud.sunTxt) {
    hud.sunTxt.textContent = `SOLAR · ${fmt(solarConstraint.sun.altitude_deg ?? 22.5)}°`;
  }

  // Title overlay fades out after intro
  hud.title.style.opacity = String(1 - ease((t - 2.6) / 1.1));
  lotLine.material.opacity = 0.85;

  // Lot & existing structure labels (computed from trace.site; lot label placed at front street edge so it never overlaps east setback)
  const siteLabelOp = Math.max(
    beatLife(t, establishBeat, constrainBeat, 0.8, 0.6, 0.4),
    beatProgress(summaryBeat, 0.3, 1.5, t) * 0.85,
  );
  placeLabel(
    "lot",
    toWorld(lotBox.cx, lotBox.y0 - 6, 1.2),
    `<span class="k">LOT</span>${fmt(lotBox.w)} × ${fmt(lotBox.d)} ${units} · ${fmt(lotAreaSqft)} sq ft`,
    siteLabelOp,
  );

  for (const st of existingStructures) {
    placeLabel(
      st.labelId,
      toWorld(st.bbox.cx, st.bbox.cy, st.totalH + 3.5),
      `<span class="k">${st.kind.toUpperCase()}</span>${st.id} (${fmt(st.bbox.w)} × ${fmt(st.bbox.d)} ${units})`,
      siteLabelOp,
    );
  }

  // Setback zones & dashed front-or-behind threshold line
  const zoneIn = beatProgress(constrainBeat, 0.2, 1.4, t);
  const zoneRecede = beatProgress(envelopeBeat, 0.4, 2.0, t) * 0.55;
  const zoneOp = clamp(zoneIn * (0.48 - zoneRecede * 0.35), 0, 0.65);
  const constrainLblOp = beatLife(t, constrainBeat, envelopeBeat, 0.6, 0.6, 0.4);

  for (const zv of zoneVisuals) {
    zv.plane.material.opacity = zoneOp;
    const slabH = 0.08 + 1.1 * zoneIn;
    zv.slab.scale.y = slabH;
    zv.slab.position.y = slabH / 2;
    zv.edge.scale.y = slabH;
    zv.edge.position.y = slabH / 2;
    zv.slab.material.opacity = zoneOp * 0.35;
    zv.edge.material.opacity = Math.min(1, zoneOp * 1.8);

    // Show a single side-setback label on the west strip and a rear-setback label on the rear strip
    // so side-setback labels never duplicate or overlap on the east edge.
    const cVal = zv.constraint.value;
    const cUnit = zv.constraint.unit || units;
    if (cVal !== null && cVal !== undefined && !zv.isEast) {
      const sideKindTag = zv.isWest ? "side setback" : zv.isRear ? "rear setback" : zv.constraint.kind;
      placeLabel(
        zv.labelId,
        zv.labelAnchor,
        `<span class="k">${zv.constraint.provision_id}</span>${fmt(cVal)} ${cUnit} ${sideKindTag}`,
        constrainLblOp,
        "#ff9e9e",
      );
    }
  }

  for (const lv of lineVisuals) {
    lv.dashedLine.material.opacity = Math.min(0.95, zoneOp * 2.0);
    const cVal = lv.constraint.value;
    const cUnit = lv.constraint.unit || units;
    placeLabel(
      lv.labelId,
      toWorld(lotBox.x0 + lotBox.w * 0.22, lv.lineY, 2.2),
      `<span class="k">${lv.constraint.provision_id}</span>${fmt(cVal)} ${cUnit} front line / rear wall`,
      constrainLblOp,
      "#f5c66b",
    );
  }

  // Height limit plane
  const hOp = beatLife(t, heightBeat, rejectBeat || placeBeat || summaryBeat, 0.7, 0.7, 0.2);
  const hGrow = beatProgress(heightBeat, 0.2, 1.8, t);
  const curH = lerp(0, maxAllowedHeightFt, hGrow);
  heightPlane.position.y = curH;
  heightEdge.position.y = curH;
  heightPlane.material.opacity = 0.16 * hOp;
  heightEdge.material.opacity = 0.85 * hOp;
  dims.height.set(
    toWorld(envBox.x1 + 2, envBox.y1, 0),
    toWorld(envBox.x1 + 2, envBox.y1, curH),
    hOp,
  );
  placeLabel(
    "height_limit",
    toWorld(envBox.x1 + 2, envBox.y1, maxAllowedHeightFt + 2.5),
    `<span class="k">${heightConstraint?.provision_id || "MAX HEIGHT"}</span>${fmt(maxAllowedHeightFt)} ${units}`,
    hOp,
    "#9fe2ff",
  );

  // Buildable envelope
  const eGrow = beatProgress(envelopeBeat, 0.3, 2.2, t);
  const eFade = 1 - beatProgress(rejectBeat || placeBeat || summaryBeat, 0, 1.4, t) * 0.7;
  const eh = Math.max(0.1, maxAllowedHeightFt * eGrow);
  envVolume.scale.y = eh;
  envVolumeEdge.scale.y = eh;
  envVolume.position.copy(toWorld(envBox.cx, envBox.cy, eh / 2));
  envVolumeEdge.position.copy(envVolume.position);
  envVolume.material.opacity = 0.15 * eGrow * eFade;
  envVolumeEdge.material.opacity = 0.9 * eGrow * eFade;
  envFloor.material.opacity = 0.2 * eGrow * eFade;

  const envLblOp = beatLife(t, envelopeBeat, rejectBeat || placeBeat || summaryBeat, 0.7, 0.6, 0.6);
  placeLabel(
    "envelope",
    toWorld(envBox.cx, envBox.cy, eh + 3),
    `<span class="k">ENVELOPE</span>${fmt(envBox.w)} × ${fmt(envBox.d)} ${units} · ${fmt(envAreaSqft)} sq ft`,
    envLblOp,
    "#7ee8de",
  );
  dims.envW.set(
    toWorld(envBox.x0, envBox.y0 - 1.5, 0.3),
    toWorld(envBox.x1, envBox.y0 - 1.5, 0.3),
    envLblOp * 0.9,
  );

  // Options (rejected options during rejectBeat, selected/conditional during placeBeat -> summaryBeat)
  for (const ov of optionVisuals) {
    if (!ov.isSelected) {
      const kIn = rejectBeat ? beatProgress(rejectBeat, 0.2, 1.4, t) : 0;
      const kOut = placeBeat ? beatProgress(placeBeat, -0.3, 0.8, t) : 0;
      const visOp = clamp(kIn * (1 - kOut), 0, 1);
      ov.group.visible = visOp > 0.01;
      ov.group.position.y = (1 - kIn) * 16;
      ov.body.scale.y = ov.heightFt;
      ov.edge.scale.y = ov.heightFt;
      ov.body.position.y = ov.heightFt / 2;
      ov.edge.position.y = ov.heightFt / 2;
      ov.body.material.color.set("#ff6b6b");
      ov.body.material.opacity = 0.34 * visOp;
      ov.edge.material.opacity = visOp;

      const failMargin = ov.option.margins?.find((m) => m.pass === false) || ov.option.margins?.[0];
      const failText = failMargin
        ? `${ov.id} (${fmt(ov.option.placement.x)}, ${fmt(ov.option.placement.y)}) · margin ${fmt(failMargin.margin)} ${failMargin.unit}`
        : `${ov.id} (${fmt(ov.option.placement.x)}, ${fmt(ov.option.placement.y)}) · rejected`;
      placeLabel(
        ov.labelId,
        toWorld(ov.bbox.cx, ov.bbox.cy, ov.heightFt + 3.2),
        `<span class="k">REJECTED</span>${failText}`,
        visOp,
        "#ff8a8a",
      );
    } else {
      const kIn = placeBeat ? beatProgress(placeBeat, 0.2, 1.6, t) : beatProgress(summaryBeat, 0.2, 1.4, t);
      ov.group.visible = kIn > 0.01;
      ov.body.scale.y = ov.heightFt;
      ov.edge.scale.y = ov.heightFt;
      ov.body.position.y = ov.heightFt / 2;
      ov.edge.position.y = ov.heightFt / 2;
      ov.body.material.opacity = kIn;
      ov.body.castShadow = kIn > 0.5;
      ov.edge.material.opacity = kIn * 0.95;

      placeLabel(
        ov.labelId,
        toWorld(ov.bbox.cx, ov.bbox.cy, ov.heightFt + 3.8),
        `<span class="k">${ov.option.status.toUpperCase()}</span>${ov.id} (${fmt(ov.option.placement.x)}, ${fmt(ov.option.placement.y)}) · ${fmt(ov.areaSqft)} sq ft · ${fmt(ov.heightFt)} ${units}`,
        kIn,
        "#7ee8de",
      );

      // Show clearance dimensions from lot lines to selected placement outline
      const westDist = ov.bbox.x0 - lotBox.x0;
      const eastDist = lotBox.x1 - ov.bbox.x1;
      const rearDist = lotBox.y1 - ov.bbox.y1;
      dims.sideWest.set(
        toWorld(lotBox.x0, ov.bbox.cy, 0.4),
        toWorld(ov.bbox.x0, ov.bbox.cy, 0.4),
        kIn * 0.85,
      );
      dims.sideEast.set(
        toWorld(ov.bbox.x1, ov.bbox.cy, 0.4),
        toWorld(lotBox.x1, ov.bbox.cy, 0.4),
        kIn * 0.85,
      );
      dims.rear.set(
        toWorld(ov.bbox.cx, ov.bbox.y1, 0.4),
        toWorld(ov.bbox.cx, lotBox.y1, 0.4),
        kIn * 0.85,
      );
      placeLabel(
        "margin_west",
        toWorld((lotBox.x0 + ov.bbox.x0) / 2, ov.bbox.cy, 2.0),
        `${fmt(westDist)} ${units}`,
        kIn * 0.9,
        "#8ff0b0",
      );
      placeLabel(
        "margin_east",
        toWorld((ov.bbox.x1 + lotBox.x1) / 2, ov.bbox.cy, 2.0),
        `${fmt(eastDist)} ${units}`,
        kIn * 0.9,
        "#8ff0b0",
      );
      placeLabel(
        "margin_rear",
        toWorld(ov.bbox.cx, (ov.bbox.y1 + lotBox.y1) / 2, 2.0),
        `${fmt(rearDist)} ${units} rear`,
        kIn * 0.9,
        "#8ff0b0",
      );
    }
  }

  // HUD chapter, card, and optional narration captions
  const curBeat = activeBeatAt(t);
  if (curBeat && curBeat.chapter !== lastChapter) {
    hud.chapter.textContent = curBeat.chapter;
    lastChapter = curBeat.chapter;
  }
  hud.chapter.style.opacity = String(curBeat ? ease((t - 2.6) / 0.8) : 0);

  const cardHtml = curBeat ? renderCardForBeat(curBeat) : "";
  if (cardHtml !== lastCardHtml) {
    hud.card.innerHTML = cardHtml;
    lastCardHtml = cardHtml;
  }
  const cardIn = curBeat && cardHtml ? ease((t - (curBeat.start + 0.15)) / 0.5) : 0;
  hud.card.style.opacity = String(cardIn);
  hud.card.style.transform = `translateX(${(1 - cardIn) * 20}px)`;

  // Guard optional word-level captions (WK-06 narration is a separate artifact)
  const capBeat = scheduledBeats.find(
    (x) => Array.isArray(x.words) && x.words.length > 0 && t >= x.start - 0.2 && t <= x.end + 0.5,
  );
  if (capBeat) {
    if (capBeat.id !== lastCapBeatId) {
      hud.who.textContent = capBeat.speaker || "";
      hud.txt.innerHTML = capBeat.words.map((w) => `<span>${w.w}</span>`).join(" ");
      lastCapBeatId = capBeat.id;
    }
    const spans = hud.txt.children;
    capBeat.words.forEach((w, i) => {
      if (spans[i]) spans[i].classList.toggle("on", t >= w.s);
    });
    hud.cap.style.opacity = String(
      Math.min(ease((t - (capBeat.start - 0.2)) / 0.3), 1 - ease((t - (capBeat.end + 0.3)) / 0.3)),
    );
  } else {
    hud.cap.style.opacity = "0";
  }

  renderer.render(scene, camera);
}

window.__trace = trace;
window.__duration = totalDuration;
window.__fps = fps;
window.__seek = seek;

try {
  await Promise.all(
    ["400", "500", "600", "700"]
      .map((w) => document.fonts.load(`${w} 16px Inter`))
      .concat(["400", "500"].map((w) => document.fonts.load(`${w} 12px Mono`))),
  );
  await document.fonts.ready;
} catch {
  // continue if offline fonts are still settling
}

seek(0);
window.__ready = true;
