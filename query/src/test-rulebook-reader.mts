// Step 5 tests: what the copied tests leave out. The file reader (graph/out/graph-or.json, no Aura) is
// checked directly; every Aura comparison sits behind a skip so the file checks still run where Aura is
// unreachable (this sandbox: port 7687 blocked). CC runs the live part. Muse, 2026-11-04.
import { connect } from "./graph-tools.mts";
import { createAuraGraphReader, createFileGraphReader, type GraphReader, type IndexEntryType } from "./graph-reads.mts";
import { guard } from "./guard-cypher.mts";
import * as C from "./types.mts";

const AS_OF = "2026-11-15";
const FAMILY_IDS = ["PDX.33.110.220.B", "PDX.T110-4", "PDX.33.205.040.C.2", "PDX.33.910.030.living-area",
  "PDX.33.110.245.C.2", "EUG.9.2751.17.a.2", "EUG.9.2775.5.e.1.a", "EUG.9.2795.3"];

let n = 0, t = 0, s = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };
const skip = (name: string) => { s++; console.log(`SKIP (no Aura)  ${name}`); };

const canon = (x: unknown): string => JSON.stringify(x, (_k, v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v);
// A param value with JSON-insensitive comparison (Aura stores list values with spaces, the file without).
const pval = (v: unknown): string => {
  if (typeof v === "string") { try { const p: unknown = JSON.parse(v); if (p && typeof p === "object") return JSON.stringify(p); } catch { /* plain string */ } }
  return JSON.stringify(v);
};

const file = createFileGraphReader();
let aura: GraphReader | null = null;
try {
  const guide = await file.readReadingGuide();
  ok("file reading guide states the three stages (M13)",
    guide.text.includes("Plan constraints next") && guide.text.includes("Placement constraints"));

  const eug = await file.readLayerIndex({ city_layer: "EUG", as_of: AS_OF });
  const eugCity = eug.layers.find((l) => l.layer === "EUG"), eugState = eug.layers.find((l) => l.layer === "OR");
  ok("file EUG index holds the 32 Eugene provisions (+ state layer)",
    eugCity?.provisions.length === 32 && eugState?.provisions.length === 1,
    `EUG ${eugCity?.provisions.length} OR ${eugState?.provisions.length}`);
  const ors = eug.layers.flatMap((l) => l.provisions).find((e) => e.provision_id === "ORS.197A.425");
  ok("file EUG index carries ORS.197A.425 with date_not_stated (D11)",
    ors !== undefined && ors.in_force.date_not_stated === true);

  const pdx = await file.readLayerIndex({ city_layer: "PDX", as_of: AS_OF });
  const pdxCity = pdx.layers.find((l) => l.layer === "PDX"), pdxState = pdx.layers.find((l) => l.layer === "OR");
  ok("file PDX index holds the 41 Portland provisions (+ state layer)",
    pdxCity?.provisions.length === 41 && pdxState?.provisions.length === 1,
    `PDX ${pdxCity?.provisions.length} OR ${pdxState?.provisions.length}`);

  const fam = await file.readRuleFamily({ provision_ids: FAMILY_IDS, as_of: AS_OF });
  const F = Object.fromEntries(fam.map((f) => [f.provision_id, f]));
  const has = (pid: string, name: string, value: unknown, unit: string | null) =>
    F[pid]?.params.some((p) => p.name === name && p.value === value && p.unit === unit) ?? false;
  ok("EUG.9.2751.17.a.2 carries front_zone_min_interior_setback = 5 ft",
    has("EUG.9.2751.17.a.2", "front_zone_min_interior_setback", 5, "ft"));
  ok("EUG.9.2775.5.e.1.a carries slope_rise_in = 10 in and slope_run_in = 12 in",
    has("EUG.9.2775.5.e.1.a", "slope_rise_in", 10, "in") && has("EUG.9.2775.5.e.1.a", "slope_run_in", 12, "in"));
  ok("EUG.9.2795.3 carries exempt_slope_direction_min_from_north = 45 degrees",
    has("EUG.9.2795.3", "exempt_slope_direction_min_from_north", 45, "degrees"));

  const contracts: [string, boolean][] = [
    ["ReadingGuide", C.ReadingGuide.safeParse(guide).success],
    ["LayerIndex/EUG", C.LayerIndex.safeParse(eug).success],
    ["LayerIndex/PDX", C.LayerIndex.safeParse(pdx).success],
    ...fam.map((f): [string, boolean] => [`RuleFamily/${f.provision_id}`, C.RuleFamily.safeParse(f).success]),
  ];
  ok("every file result parses as its contract in types.mts",
    contracts.every(([, good]) => good), contracts.filter(([, good]) => !good).map(([w]) => w).join(","));

  const writes: [string, string][] = [
    ["CREATE", "CREATE (p:Provision {id: 'x'}) RETURN p"],
    ["MERGE", "MERGE (p:Provision {id: 'x'}) RETURN p"],
    ["SET", "MATCH (p:Provision {id: 'PDX.T110-4'}) SET p.title = 'x' RETURN p"],
    ["DELETE", "MATCH (p:Provision {id: 'x'}) DELETE p"],
  ];
  for (const [kw, q] of writes) {
    const v = guard(q);
    ok(`guard refuses a write query (${kw})`, !v.ok && v.reason.startsWith("read-only"), v.ok ? "accepted" : v.reason);
  }
  const outside = guard("MATCH (r:Rule) RETURN r");
  ok("guard refuses a query outside the ontology (unknown label)",
    !outside.ok && outside.reason.startsWith("schema"), outside.ok ? "accepted" : outside.reason);

  let envMsg = "";
  try { connect("/nonexistent-dir-xyz/.env.aura"); } catch (e) { envMsg = (e as Error).message; }
  ok("a missing .env.aura gives a clear error", /ENOENT|no such file/i.test(envMsg) && envMsg.includes(".env.aura"), envMsg.slice(0, 200));
  ok("that error never carries credentials", envMsg.length > 0 && !/password|secret|passwd|NEO4J_/i.test(envMsg), envMsg.slice(0, 200));

  // One Aura probe; every check below skips when Aura is unreachable.
  try {
    const r = createAuraGraphReader();
    await r.graphLoadId();
    aura = r;
  } catch { aura = null; }

  const normEntry = (e: IndexEntryType) =>
    ({ ...e, scope: { ...e.scope, applies_to_zones: [...e.scope.applies_to_zones].sort() } });
  const indexParity = (fname: string, fl: typeof eug.layers, al: typeof eug.layers): [boolean, string] => {
    const fids = fl.flatMap((l) => l.provisions.map((e) => e.provision_id)).sort();
    const aids = al.flatMap((l) => l.provisions.map((e) => e.provision_id)).sort();
    if (canon(fids) !== canon(aids)) return [false, `id sets differ: file ${fids.length}, Aura ${aids.length}`];
    const am = new Map(al.flatMap((l) => l.provisions).map((e) => [e.provision_id, e]));
    for (const l of fl) for (const e of l.provisions) {
      if (canon(normEntry(e)) !== canon(normEntry(am.get(e.provision_id)!))) return [false, `entry differs: ${e.provision_id}`];
    }
    return [true, `${fname} ${fids.length}/${aids.length}`];
  };
  // Aura fans a param out to one row per modeling clause (75 params) and resolves cell-sourced param
  // quotes to cell text (graph-reads.mts keeps the cell ref), so params compare by name/value/unit with
  // the file's clause_id required to be one of Aura's — quotes excluded.
  const familyParity = (fp: (typeof fam)[number], ap: (typeof fam)[number]): [boolean, string] => {
    if (fp.version_id !== ap.version_id || fp.sha256 !== ap.sha256 || fp.evaluation_stage !== ap.evaluation_stage)
      return [false, "version/sha/stage"];
    const ag = new Map<string, typeof ap.params>();
    for (const p of ap.params) ag.set(p.name, [...(ag.get(p.name) ?? []), p]);
    if (fp.params.length !== ag.size || !fp.params.every((p) => ag.has(p.name))) return [false, "param names"];
    for (const p of fp.params) {
      const rows = ag.get(p.name)!;
      if (!rows.every((r) => pval(r.value) === pval(p.value) && r.unit === p.unit)) return [false, `param ${p.name} value/unit`];
      if (!rows.some((r) => r.clause_id === p.clause_id)) return [false, `param ${p.name} clause`];
    }
    const byId = (a: { cell_id: string }[]) => [...a].sort((x, y) => x.cell_id.localeCompare(y.cell_id));
    if (canon(byId(fp.cells)) !== canon(byId(ap.cells))) return [false, "cells"];
    const byClause = (a: { clause_id: string }[]) => [...a].sort((x, y) => x.clause_id.localeCompare(y.clause_id));
    if (canon(byClause(fp.clauses)) !== canon(byClause(ap.clauses))) return [false, "clauses"];
    const byAmb = (a: { ambiguity_id: string }[]) => [...a].sort((x, y) => x.ambiguity_id.localeCompare(y.ambiguity_id));
    if (canon(byAmb(fp.readings)) !== canon(byAmb(ap.readings))) return [false, "readings"];
    const eff = (a: unknown[]) => [...a].sort().map(canon);
    if (canon(eff(fp.gray_area_effects)) !== canon(eff(ap.gray_area_effects))) return [false, "gray_area_effects"];
    const byOp = (a: { operator_id: string }[]) => [...a].sort((x, y) => x.operator_id.localeCompare(y.operator_id));
    if (canon(byOp(fp.operators)) !== canon(byOp(ap.operators))) return [false, "operators"];
    for (const k of ["modified_by", "preempted_by", "uses_definitions"] as const)
      if (canon(fp[k]) !== canon(ap[k])) return [false, k];
    return [true, ""];
  };

  if (!aura) {
    skip("Aura graph load is the current load");
    skip("reading guide text matches Aura");
    skip("EUG layer index matches Aura");
    skip("PDX layer index matches Aura");
    for (const pid of FAMILY_IDS) skip(`rule family matches Aura (${pid})`);
  } else {
    const load = await aura.graphLoadId();
    ok("Aura graph load is the current load (reloaded 11-04 with Eugene)", load.startsWith("777403f1"), load);
    const aguard = await aura.readReadingGuide();
    const norm = (x: string) => x.replace(/\r\n/g, "\n").trim();
    ok("reading guide text matches Aura", norm(guide.text) === norm(aguard.text),
      `file ${guide.text.length} chars, Aura ${aguard.text.length} chars`);
    const aeug = await aura.readLayerIndex({ city_layer: "EUG", as_of: AS_OF });
    const [eok, ed] = indexParity("EUG", eug.layers, aeug.layers);
    ok("EUG layer index matches Aura", eok, ed);
    const apdx = await aura.readLayerIndex({ city_layer: "PDX", as_of: AS_OF });
    const [pok, pd] = indexParity("PDX", pdx.layers, apdx.layers);
    ok("PDX layer index matches Aura", pok, pd);
    const afam = await aura.readRuleFamily({ provision_ids: FAMILY_IDS, as_of: AS_OF });
    const A = Object.fromEntries(afam.map((f) => [f.provision_id, f]));
    for (const f of fam) {
      if (!A[f.provision_id]) { ok(`rule family matches Aura (${f.provision_id})`, false, "missing on Aura"); continue; }
      const [good, part] = familyParity(f, A[f.provision_id]!);
      ok(`rule family matches Aura (${f.provision_id})`, good, part);
    }
    for (const pid of FAMILY_IDS) if (!F[pid]) ok(`rule family matches Aura (${pid})`, false, "missing on file");
  }
} catch (e) { t++; console.log("FAIL  exception —", (e as Error).message); }
finally { await file.close(); if (aura) await aura.close(); }
console.log(`${n}/${t} rulebook-reader checks passed${s ? ` (${s} skipped, no Aura)` : ""}`);
process.exit(n === t ? 0 : 1);
