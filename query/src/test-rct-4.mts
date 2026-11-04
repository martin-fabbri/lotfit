// RCT-4 frozen acceptance tests: constraints (RCS-09) and options (RCS-10). No network. Do not edit.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { buildConstraints, buildOptions, buildSite, canonicalJson, placedOutline } from "./compile-trace.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(readFileSync(join(here, "..", "record", "fixtures", f), "utf8"));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const J = (x: unknown) => JSON.stringify(x);
const thr = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
const pair = (p: string) => ({ r: C.Report.parse(fx(`${p}-report.json`)), k: C.Case.parse(fx(`${p}-case.json`)), t: fx(`${p}-trace.json`) });
const P = { s1: pair("s1"), a: pair("a"), b: pair("b") };
const cons = (r: any, k: any) => buildConstraints(r, buildSite(k).lot);

/** The coverage rule of F13 (ARCHITECTURE.md §11.6): every finding and every margin appears in the trace. */
function coverage(report: any, constraints: any[], options: any[]): string[] {
  const miss: string[] = [];
  for (const f of report.findings.filter((x: any) => x.target === "case")) {
    const c = constraints.find((x) => x.provision_id === f.provision_id && x.outcome === f.outcome && x.zone === null);
    if (!c) { miss.push(`case ${f.provision_id}`); continue; }
    for (const m of f.measures) if (!c.measures.some((cm: any) => canonicalJson(cm) === canonicalJson(m))) miss.push(`case measure ${f.provision_id}`);
  }
  for (const target of ["client_spot", "selected_placement"]) {
    const fs = report.findings.filter((x: any) => x.target === target);
    if (!fs.length) continue;
    const o = options.find((x) => x.id === target);
    if (!o) { miss.push(`option ${target}`); continue; }
    for (const f of fs) {
      if (!o.why.some((w: string) => w.includes(f.provision_id) && w.includes(f.outcome))) miss.push(`why ${target} ${f.provision_id}`);
      for (const m of f.measures) if (!o.margins.some((om: any) => canonicalJson(om) === canonicalJson(m))) miss.push(`margin ${target} ${f.provision_id}`);
    }
  }
  if (report.placement.recommended) {
    const o = options.find((x) => x.id === "selected_placement");
    const count = (arr: any[]) => { const m = new Map<string, number>(); for (const x of arr) m.set(canonicalJson(x), (m.get(canonicalJson(x)) ?? 0) + 1); return m; };
    const need = count(report.placement.recommended.margins), have = count(o?.margins ?? []);
    for (const [k, v] of need) if ((have.get(k) ?? 0) < v) miss.push(`recommended margin x${v}`);
  }
  return miss;
}

// ---- RCS-09 constraints
for (const [p, v] of Object.entries(P)) {
  const c = cons(v.r, v.k);
  check(`CN1.${p}`, `${p}: constraints equal the golden trace's`, canonicalJson(c) === canonicalJson(v.t.constraints), J(c).slice(0, 300));
}
{ const c = cons(P.s1.r, P.s1.k).filter((x) => x.provision_id === "PDX.33.110.220.B");
  check("CN2", "S1 side and rear setback: west strip (with the finding's measures), east strip (no measures), rear strip (no measures, a side param exists)",
    J(c.map((x) => [x.kind, x.zone, x.value, x.measures.length])) === J([
      ["setback", [[0, 0], [5, 0], [5, 100], [0, 100]], 5, 2], ["setback", [[45, 0], [50, 0], [50, 100], [45, 100]], 5, 0],
      ["setback", [[0, 95], [50, 95], [50, 100], [0, 100]], 5, 0]]), J(c.map((x) => [x.kind, x.zone, x.value, x.measures.length]))); }
{ const c = cons(P.s1.r, P.s1.k).filter((x) => x.provision_id === "PDX.33.205.040.C.2");
  check("CN3", "S1 front setback: one strip from the front line, with the measures", J(c.map((x) => [x.kind, x.zone, x.value, x.measures.length])) === J([["setback", [[0, 0], [50, 0], [50, 40], [0, 40]], 40, 1]]),
    J(c.map((x) => [x.kind, x.zone, x.value, x.measures.length]))); }
{ const c = cons(P.s1.r, P.s1.k);
  check("CN4", "a provision with a selected_placement finding takes that finding's outcome (S1 220.B: client fail, selected pass)", c.filter((x) => x.provision_id === "PDX.33.110.220.B").every((x) => x.outcome === "pass")); }
{ const r = structuredClone(fx("s1-report.json")); r.findings = r.findings.filter((f: any) => f.target !== "selected_placement");
  const c = cons(C.Report.parse(r), P.s1.k).filter((x) => x.provision_id === "PDX.33.110.220.B");
  check("CN5", "with only a client_spot finding, its outcome is used", c.length === 3 && c.every((x) => x.outcome === "fail"), J(c.map((x) => x.outcome))); }
{ const c = cons(P.b.r, P.b.k);
  check("CN6", "R-D3 (known limitation): Eugene-style param names draw no setback strip; one zone-null entry per provision, kind = its stage",
    !c.some((x) => x.kind === "setback") && J(c.filter((x) => x.provision_id === "PDX.33.110.220.B").map((x) => [x.kind, x.zone, x.value])) === J([["placement_constraint", null, 13]]),
    J(c.map((x) => [x.provision_id, x.kind, x.zone !== null]))); }
{ const k = structuredClone(fx("s1-case.json")); k.site.lot_outline.value = [[0, 0], [10, 0], [10, 120], [0, 120]];
  const c = cons(P.s1.r, C.Case.parse(k)).filter((x) => x.provision_id === "PDX.33.110.220.B");
  check("CN7", "lot width not more than twice the side setback: no side strips; the rear strip still carries no measures while a side param exists",
    J(c.map((x) => [x.zone, x.measures.length])) === J([[[[0, 115], [10, 115], [10, 120], [0, 120]], 0]]), J(c.map((x) => [x.zone, x.measures.length]))); }
{ const k = structuredClone(fx("s1-case.json")); k.site.lot_outline.value = [[0, 0], [50, 0], [50, 30], [0, 30]];
  const c = cons(P.s1.r, C.Case.parse(k)).filter((x) => x.provision_id === "PDX.33.205.040.C.2");
  check("CN8", "lot depth not more than the front setback: the front provision falls to one zone-null entry", J(c.map((x) => [x.kind, x.zone, x.value])) === J([["placement_constraint", null, 65]]),
    J(c.map((x) => [x.kind, x.zone, x.value]))); }
{ const c = cons(P.s1.r, P.s1.k).filter((x) => x.zone === null);
  check("CN9", "case findings come first, in report order, value from the first measure else the first param else null",
    J(c.slice(0, 4).map((x) => [x.provision_id, x.kind, x.value, x.unit])) === J([["PDX.33.205.020.B.1.a", "gate", null, null], ["PDX.11.50.020", "gate", null, null],
      ["PDX.33.205.040.C.1", "plan_constraint", 576, "sqft"], ["PDX.33.110.245.C.1", "plan_constraint", 15, "ft"]]), J(c.slice(0, 4).map((x) => [x.provision_id, x.kind, x.value, x.unit]))); }

// ---- RCS-10 options
for (const [p, v] of Object.entries(P)) {
  const o = buildOptions(v.r, v.k);
  check(`OP1.${p}`, `${p}: options equal the golden trace's`, canonicalJson(o) === canonicalJson(v.t.options), J(o).slice(0, 300));
  const miss = coverage(v.r, cons(v.r, v.k), o);
  check(`OP2.${p}`, `${p}: every finding and every margin is covered (F13)`, miss.length === 0, miss.join("; "));
}
{ const c = cons(P.s1.r, P.s1.k), o = buildOptions(P.s1.r, P.s1.k);
  const c2 = structuredClone(c); c2.find((x) => x.provision_id === "PDX.33.205.040.C.1")!.measures = [];
  const o2 = structuredClone(o); o2.find((x) => x.id === "selected_placement")!.margins.pop();
  const o3 = structuredClone(o); o3.find((x) => x.id === "client_spot")!.why.shift();
  check("OP3", "negative controls: a dropped case measure, a dropped margin, a dropped why line are each caught",
    coverage(P.s1.r, c2, o).length > 0 && coverage(P.s1.r, c, o2).length > 0 && coverage(P.s1.r, c, o3).length > 0); }
{ const o = buildOptions(P.s1.r, P.s1.k), fp = fx("s1-case.json").plan.footprint.value;
  check("OP4", "outlines are in the lot frame, never the plan-frame footprint (A6)",
    J(o[0]!.outline) === J([[2, 74], [26, 74], [26, 98], [2, 98]]) && J(o[1]!.outline) === J([[13, 65], [37, 65], [37, 89], [13, 89]]) &&
    J(o[0]!.outline) !== J(fp) && J(o[1]!.outline) !== J(fp)); }
check("OP5", "a rotation-90 placement is placed with placedOutline", J(buildOptions(P.a.r, P.a.k)[1]!.outline) === J(placedOutline(fx("a-case.json").plan.footprint.value, { x: 40, y: 60, rotation: 90 })));
{ const m = C.Case.parse(fx("s1-case-materialized.json"));
  const o = buildOptions(P.s1.r, m);
  check("OP6", "a case with plan.outline for the same placement uses it, and gives the same outlines", canonicalJson(o) === canonicalJson(buildOptions(P.s1.r, P.s1.k)));
  const mm = structuredClone(fx("s1-case-materialized.json")); mm.plan.outline.value = [[2, 74], [26, 74], [26, 99], [2, 99]];
  const o2 = buildOptions(P.s1.r, C.Case.parse(mm));
  check("OP7", "plan.outline is used only for the placement it was made for", J(o2[0]!.outline) === J([[2, 74], [26, 74], [26, 99], [2, 99]]) && J(o2[1]!.outline) === J([[13, 65], [37, 65], [37, 89], [13, 89]]), J(o2.map((x) => x.outline))); }
{ const st = (p: keyof typeof P) => buildOptions(P[p].r, P[p].k).map((x) => `${x.id}:${x.status}`).join(",");
  check("OP8", "status (R-D12): a client spot that fails anything → rejected, else conditional; selected FITS → selected, FITS_IF/NEEDS_CHECK/NOT_MODELED → conditional, NO_LEGS/BLOCKED_BY_GATE → rejected",
    st("s1") === "client_spot:rejected,selected_placement:selected" && st("a") === "client_spot:rejected,selected_placement:conditional" && st("b") === "client_spot:rejected,selected_placement:rejected",
    [st("s1"), st("a"), st("b")].join(" | "));
  const r = structuredClone(fx("b-report.json")); r.verdict = "NEEDS_CHECK"; r.model_verdict = "NEEDS_CHECK";
  check("OP9", "NEEDS_CHECK: selected_placement is conditional", buildOptions(C.Report.parse(r), P.b.k)[1]!.status === "conditional"); }
{ const w = buildOptions(P.a.r, P.a.k)[0]!.why;
  check("OP10", "client why: one line per client finding, then a line for each failing id and each rejected exception with no line of its own",
    w.length === 7 && w[5] === "PDX.33.110.250.X [fail]: failed at client_spot" && w[6] === "PDX.33.110.245.C.9 [fail]: exception conditions not met at client_spot" &&
    !w.some((x) => x === "PDX.33.110.220.B [fail]: failed at client_spot"), J(w)); }
{ const w = buildOptions(P.s1.r, P.s1.k)[0]!.why;
  check("OP11", "a why line: <id> [<outcome>]: <value> <unit> vs limit <limit> <unit> (<param>), margin <signed margin> <unit>; several measures joined by \"; \"",
    w.includes("PDX.33.110.225.B [pass]: 1566 sqft vs limit 2250 sqft (T110-5:R3), margin +684 sqft") &&
    w.some((x) => x.startsWith("PDX.33.110.220.B [fail]: ") && x.includes("; ") && x.includes("margin -")), J(w)); }
{ const r = structuredClone(fx("s1-report.json"));
  const f = r.findings.find((x: any) => x.target === "client_spot" && x.provision_id === "PDX.33.110.225.B"); f.measures = [];
  const w = buildOptions(C.Report.parse(r), P.s1.k)[0]!.why;
  check("OP12", "a finding with no measures: the detail is its first citation's clause id", w.includes(`PDX.33.110.225.B [pass]: ${f.citations[0].clause_id}`), J(w)); }
{ const r = structuredClone(fx("s1-report.json")); r.findings = r.findings.filter((x: any) => x.target !== "selected_placement");
  const o = buildOptions(C.Report.parse(r), P.s1.k);
  check("OP13", "no selected_placement findings: one default why line", J(o[1]!.why) === J(["verdict FITS: recommended placement clears required setbacks"]), J(o[1]!.why)); }
{ const o = buildOptions(P.a.r, P.a.k)[1]!, rec = fx("a-report.json").placement.recommended.margins;
  check("OP14", "selected margins: recommended.margins first, in order, duplicates kept; then each selected-finding measure not already there",
    o.margins.length === 8 && J(o.margins.slice(0, 3)) === J(rec) && canonicalJson(o.margins[0]) === canonicalJson(o.margins[1]), String(o.margins.length)); }
{ const k = structuredClone(fx("s1-case.json")); delete k.plan.footprint;
  check("OP15", "no footprint and no matching plan.outline: throws the exact message", thr(() => buildOptions(P.s1.r, C.Case.parse(k))) === "Case is missing a valid plan.footprint polygon"); }
{ const r = structuredClone(fx("s1-report.json")); r.placement.client_spot = null;
  const o = buildOptions(C.Report.parse(r), P.s1.k);
  check("OP16", "no client spot: only selected_placement", J(o.map((x) => x.id)) === J(["selected_placement"])); }
{ const o = buildOptions(P.s1.r, P.s1.k);
  check("OP17", "placement numbers are cleaned and rotation defaults to 0", J(o[1]!.placement) === J({ x: 13, y: 65, rotation: 0 })); }

// ---- v2: R-D12 statuses, R-D14 id prefixes, R-D18 negative rotation, R-D19 limit values
{ const st = (r: any, k: any) => buildOptions(r, k).map((x) => `${x.id}:${x.status}`).join(",");
  const v = (verdict: string) => { const r = structuredClone(fx("a-report.json")); r.verdict = verdict; r.model_verdict = verdict; return C.Report.parse(r); };
  check("OP18", "NOT_MODELED → conditional, BLOCKED_BY_GATE → rejected, NEEDS_CHECK → conditional (R-D12)",
    st(v("NOT_MODELED"), P.a.k).endsWith("selected_placement:conditional") && st(v("BLOCKED_BY_GATE"), P.a.k).endsWith("selected_placement:rejected") && st(v("NEEDS_CHECK"), P.a.k).endsWith("selected_placement:conditional"));
  const r2 = structuredClone(fx("b-report.json")); r2.placement.client_spot.failing = []; r2.placement.client_spot.rejected_exceptions = []; r2.placement.client_spot.passes = null;
  check("OP19", "a client spot that fails nothing and is undecided is conditional", st(C.Report.parse(r2), P.b.k).startsWith("client_spot:conditional"));
  const r3 = structuredClone(fx("b-report.json")); r3.placement.client_spot.passes = true; r3.placement.client_spot.failing = ["PDX.33.110.220.B"];
  check("OP20", "passes true with a failing id is still rejected", st(C.Report.parse(r3), P.b.k).startsWith("client_spot:rejected"));
  const r4 = structuredClone(fx("s1-report.json"));
  const fid = r4.placement.client_spot.failing[0] as string; const longer = r4.findings.find((f: any) => f.target === "client_spot" && f.provision_id !== fid);
  r4.findings = r4.findings.filter((f: any) => !(f.target === "client_spot" && f.provision_id === fid));
  if (longer) { longer.provision_id = `${fid}.9`; }
  const why = buildOptions(C.Report.parse(r4), P.s1.k).find((o) => o.id === "client_spot")!.why;
  check("WY1", "a failing id that is the start of another id still gets its own line (R-D14)", why.includes(`${fid} [fail]: failed at client_spot`), J(why));
  const k5 = structuredClone(fx("s1-case.json")) as any; const r5 = structuredClone(fx("s1-report.json"));
  const cp = r5.placement.client_spot.placement; const pl = k5.plan.placement?.value;
  if (pl) { k5.plan.placement.value = { ...pl, rotation: (pl.rotation ?? 0) - 360 }; }
  const o5 = buildOptions(C.Report.parse(r5), C.Case.parse(k5)).find((o) => o.id === "client_spot")!;
  const o5ref = buildOptions(P.s1.r, P.s1.k).find((o) => o.id === "client_spot")!;
  check("RO1", "a case placement written as rotation − 360 still matches (R-D18): the outline is plan.outline, unchanged", !!pl && J(o5.outline) === J(o5ref.outline), J([cp, pl]));
  const r6 = structuredClone(fx("s1-report.json")); const f6 = r6.findings.find((f: any) => f.target === "client_spot" && f.measures.some((m: any) => m.limit));
  const m6 = f6.measures.find((m: any) => m.limit); m6.limit.value = 0.1 + 0.2;
  const w6 = buildOptions(C.Report.parse(r6), P.s1.k).find((o) => o.id === "client_spot")!.why.join("\n");
  check("WY2", "limit values in why lines are cleaned (R-D19)", w6.includes("vs limit 0.3 ") && !w6.includes("0.30000000000000004"), w6.slice(0, 200));
}
console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
