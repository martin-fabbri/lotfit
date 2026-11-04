// RCT-3 frozen acceptance tests: trace helpers (RCS-07), frame and site (RCS-08). No network. Do not edit.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { buildSite, canonicalJson, formatTraceJson, placedOutline, sortKeysDeep, traceFrame } from "./compile-trace.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(readFileSync(join(here, "..", "record", "fixtures", f), "utf8"));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const J = (x: unknown) => JSON.stringify(x);
const thr = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
const FP: [number, number][] = [[0, 0], [24, 0], [24, 24], [0, 24]];

// ---- RCS-07 helpers
{ const v = sortKeysDeep({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }, 3] } }) as any;
  check("TR1", "sortKeysDeep sorts keys at every depth and keeps array order", J(v) === '{"a":{"c":[{"y":2,"z":1},3],"d":2},"b":1}', J(v)); }
{ const v = sortKeysDeep({ a: undefined, b: null, c: { d: undefined } }) as any;
  check("TR2", "sortKeysDeep drops undefined-valued keys, keeps null", J(v) === '{"b":null,"c":{}}', J(v)); }
check("TR3", "canonicalJson is compact and sorted", canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } }) === '{"a":{"c":[2,1]},"b":1}');
{ const t = formatTraceJson({ z: 1, a: [1] } as any);
  check("TR4", "formatTraceJson is sorted, 2-space indented, one trailing newline", t === '{\n  "a": [\n    1\n  ],\n  "z": 1\n}\n', J(t)); }
check("TR5", "placedOutline rotation 0", J(placedOutline(FP, { x: 2, y: 74, rotation: 0 })) === J([[2, 74], [26, 74], [26, 98], [2, 98]]));
check("TR6", "placedOutline rotation 90", J(placedOutline(FP, { x: 40, y: 60, rotation: 90 })) === J([[40, 60], [40, 84], [16, 84], [16, 60]]),
  J(placedOutline(FP, { x: 40, y: 60, rotation: 90 })));
check("TR7", "placedOutline rotation 180", J(placedOutline(FP, { x: 40, y: 60, rotation: 180 })) === J([[40, 60], [16, 60], [16, 36], [40, 36]]),
  J(placedOutline(FP, { x: 40, y: 60, rotation: 180 })));
check("TR8", "placedOutline rotation 270", J(placedOutline(FP, { x: 40, y: 60, rotation: 270 })) === J([[40, 60], [40, 36], [64, 36], [64, 60]]),
  J(placedOutline(FP, { x: 40, y: 60, rotation: 270 })));
check("TR9", "rotation -90 equals 270 and 450 equals 90",
  J(placedOutline(FP, { x: 1, y: 2, rotation: -90 })) === J(placedOutline(FP, { x: 1, y: 2, rotation: 270 })) &&
  J(placedOutline(FP, { x: 1, y: 2, rotation: 450 })) === J(placedOutline(FP, { x: 1, y: 2, rotation: 90 })));
check("TR10", "rotation 45 is refused with the exact message",
  thr(() => placedOutline(FP, { x: 0, y: 0, rotation: 45 })) === "placement.rotation must be a multiple of 90 degrees, got 45");
{ const p = placedOutline([[0.1 + 0.2, 0], [2.0000000001, 0], [0, 1.23456789]], { x: -0, y: 0, rotation: 0 });
  check("TR11", "numbers are cleaned: 6 decimals, near-integers become integers, -0 becomes 0",
    J(p) === J([[0.3, 0], [2, 0], [0, 1.234568]]) && Object.is(p[2]![0], 0) && Number.isInteger(p[1]![0]), J(p)); }
check("TR12", "placedOutline without rotation means 0", J(placedOutline(FP, { x: 2, y: 74 } as any)) === J([[2, 74], [26, 74], [26, 98], [2, 98]]));

// ---- RCS-08 frame and site
check("TR13", "traceFrame is the fixed lot frame (A6)", J(traceFrame()) === J({ origin: "front-left", x: "along the front lot line", y: "to the rear", z: "up", units: "ft", three: { X: "x", Y: "z", Z: "-y" } }));
const S1 = C.Case.parse(fx("s1-case.json")), A = C.Case.parse(fx("a-case.json")), B = C.Case.parse(fx("b-case.json"));
{ const s = buildSite(S1);
  check("TR14", "S1 site: lot, no north, house and shed (A8)",
    J(s.lot) === J((fx("s1-case.json").site.lot_outline.value)) && s.north_deg === null && s.north_uncertainty_deg === null &&
    J(s.existing) === J([{ id: "house", kind: "house", outline: [[12, 20], [38, 20], [38, 55], [12, 55]], height_ft: null },
      { id: "shed", kind: "shed", outline: [[40, 85], [48, 85], [48, 95], [40, 95]], height_ft: null }]), J(s)); }
{ const s = buildSite(A);
  check("TR15", "A site: north from context; house height from context", s.north_deg === 12 && s.north_uncertainty_deg === 3 && s.existing[0]!.height_ft === 18, J(s.existing[0]));
  check("TR16", "A site: structures named by id, else structure_<index+1>; kind from kind, else id, else \"structure\"; height_ft, else height, else null; invalid outlines and non-objects skipped",
    J(s.existing.map((e) => [e.id, e.kind, e.height_ft])) === J([["house", "house", 18], ["shed", "shed", null], ["structure_2", "garage", 11.5], ["structure_3", "structure", 7], ["structure_4", "structure", null]]),
    J(s.existing.map((e) => [e.id, e.kind, e.height_ft]))); }
{ const s = buildSite(B); check("TR17", "B site: north from capture.north when context has none", s.north_deg === -7.5 && s.north_uncertainty_deg === 2, J([s.north_deg, s.north_uncertainty_deg])); }
{ const raw = fx("b-case.json"); raw.context = { lat: 44, lon: -123, north_angle_deg: 30 };
  const s = buildSite(C.Case.parse(raw));
  check("TR18", "context north wins over capture north; a missing context uncertainty falls back to capture", s.north_deg === 30 && s.north_uncertainty_deg === 2, J([s.north_deg, s.north_uncertainty_deg])); }
{ const raw = fx("s1-case.json"); delete raw.site.house_outline;
  const s = buildSite(C.Case.parse(raw));
  check("TR19", "no house outline: no house entry", J(s.existing.map((e) => e.id)) === J(["shed"]), J(s.existing.map((e) => e.id))); }
{ const raw = fx("s1-case.json"); raw.site.lot_outline.value = [[0, 0], [10.0000001, 0], [10, 20.123456789]];
  const s = buildSite(C.Case.parse(raw));
  check("TR20", "the lot polygon is cleaned the same way", J(s.lot) === J([[0, 0], [10, 0], [10, 20.123457]]), J(s.lot)); }
{ const raw = fx("s1-case.json"); delete raw.site.lot_outline;
  check("TR21", "no lot outline: buildSite throws", thr(() => buildSite(C.Case.parse(raw))) !== ""); }

// ---- v2: R-D16 structures, R-D17 conflicting geometry, R-D19 house height
{ const thr = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
  const k0 = C.Case.parse(fx("s1-case.json"));
  const withS = (st: unknown[]) => { const k = structuredClone(k0) as any; k.site.structures = { ...k.site.structures, value: st }; return k; };
  const sq = [[1, 1], [3, 1], [3, 3], [1, 3]];
  check("ST1", "a structure that is not an object throws (R-D16)", thr(() => buildSite(withS([{ id: "shed", outline: sq }, "x"]))) === "site.structures[1] has no valid outline");
  check("ST2", "a structure without a valid outline throws", thr(() => buildSite(withS([{ id: "a", outline: [[0, 0], [1, 1]] }]))) === "site.structures[0] has no valid outline");
  check("ST3", "a repeated id throws, \"house\" included", thr(() => buildSite(withS([{ id: "house", outline: sq }]))) === "site.structures[0] repeats the id house" &&
    thr(() => buildSite(withS([{ id: "a", outline: sq }, { id: "a", outline: sq }]))) === "site.structures[1] repeats the id a");
  const kc = structuredClone(k0) as any; const lotv = kc.site.lot_outline.value, prov = kc.site.lot_outline.prov;
  kc.site.lot_outline = { observations: [{ value: lotv, prov }, { value: lotv.map(([x, y]: number[]) => [x! + 1, y]), prov }] };
  check("CF1", "a conflicting lot outline the report does not list throws (R-D17)", thr(() => buildSite(kc)) === "site.lot_outline is conflicting in the case and the report does not list the conflict");
  check("CF2", "listed in the report's conflicts, its first observation is drawn", J(buildSite(kc, new Set(["site.lot_outline"])).lot) === J(lotv));
  const kh = structuredClone(k0) as any; kh.context = { ...(kh.context ?? {}), house_height_ft: 0.1 + 0.2 };
  check("HH1", "context.house_height_ft is cleaned to six decimals (R-D19)", buildSite(kh).existing.find((e) => e.id === "house")?.height_ft === 0.3);
}
console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
