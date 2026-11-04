// RCT-5 frozen acceptance tests: beats (RCS-11), compileTrace and the CLI (RCS-12). No network. Do not edit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { buildBeats, buildConstraints, buildOptions, buildSite, canonicalJson, checkCoverage, compileTrace, formatTraceJson } from "./compile-trace.mts";

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "..", "record", "fixtures");
const raw = (f: string) => readFileSync(join(FX, f), "utf8");
const fx = (f: string) => JSON.parse(raw(f));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const J = (x: unknown) => JSON.stringify(x);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const thr = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
const beatsOf = (rr: any, kk: any) => { const r = C.Report.parse(rr), k = C.Case.parse(kk), s = buildSite(k), c = buildConstraints(r, s.lot); return buildBeats(r, s.existing, c, buildOptions(r, k)); };
const kinds = (b: any[]) => b.map((x) => x.kind).join(",");
const GOLD: Record<string, string> = {
  s1: "499efe481045a79a061af603df14acc0d746d136309817787f48398973d5bd1a",
  a: "3693da451b4be5f73b506ea2c6c077031da68a6c40ce92130978f51530290eb9",
  b: "55a69d04fdc9c9eb3498e1574fdc83915d3cc92066045ea2fa414f7c646513d1",
};

// ---- RCS-11 beats
for (const p of ["s1", "a", "b"]) {
  const b = beatsOf(fx(`${p}-report.json`), fx(`${p}-case.json`));
  check(`BT1.${p}`, `${p}: beats equal the golden trace's`, canonicalJson(b) === canonicalJson(fx(`${p}-trace.json`).beats), J(b).slice(0, 300));
  check(`BT2.${p}`, `${p}: ids are b1..bN in order`, b.every((x, i) => x.id === `b${i + 1}`));
}
check("BT3", "S1 order: establish, constrain, height, envelope, reject, place, summary", kinds(beatsOf(fx("s1-report.json"), fx("s1-case.json"))) === "establish,constrain,height,envelope,reject,place,summary");
check("BT4", "A order adds shadow (recommended.solar) and caveats", kinds(beatsOf(fx("a-report.json"), fx("a-case.json"))) === "establish,constrain,height,envelope,reject,place,shadow,caveats,summary");
{ const b = beatsOf(fx("s1-report.json"), fx("s1-case.json"));
  check("BT5", "height beat: provisions whose id is PDX.33.110.245.C.1 or with a measure whose limit param contains \"height\"; they leave the constrain beat",
    J(b[2]!.refs) === J(["PDX.33.110.245.C.1", "PDX.33.110.245.C.2"]) && !b[1]!.refs.includes("PDX.33.110.245.C.1"), J(b.slice(1, 3))); }
{ const b = beatsOf(fx("b-report.json"), fx("b-case.json"));
  check("BT6", "B: height found by the param name (max_height); with no setback strips the envelope beat lists every constraint provision (R-D3)",
    b[2]!.refs[0] === "EUG.9.2751.17.b.4" && b[3]!.kind === "envelope" && b[3]!.refs.length === 9, J(b.slice(2, 4))); }
{ const b = beatsOf(fx("a-report.json"), fx("a-case.json"));
  check("BT7", "reject beat for the client spot: [client_spot, ...failing, ...rejected_exceptions], de-duplicated",
    J(b.find((x) => x.kind === "reject")!.refs) === J(["client_spot", "PDX.33.110.220.B", "PDX.33.110.250.X", "PDX.33.110.245.C.2", "PDX.33.110.245.C.9"]));
  check("BT8", "caveats: condition ids, assumption facts, conflict facts, question facts, disposition clause ids, in that order",
    J(b.find((x) => x.kind === "caveats")!.refs) === J(["amb.sample.reading", "site.trees", "site.slope_pct", "site.alley", "PDX.33.110.220.B#v1::sentence:1"])); }
{ const b = beatsOf(fx("b-report.json"), fx("b-case.json"));
  check("BT9", "B (NO_LEGS, client spot with failing ids and passes null): both options get reject beats, no place beat (R-D12)",
    J(b.filter((x) => x.kind === "reject" || x.kind === "place").map((x) => [x.kind, x.refs])) === J([["reject", ["client_spot", "PDX.33.110.220.B", "PDX.33.110.245.C.2"]], ["reject", ["selected_placement"]]]),
    J(b.filter((x) => x.kind === "reject" || x.kind === "place").map((x) => [x.kind, x.refs]))); }
{ const b = beatsOf(fx("s1-report.json"), fx("s1-case.json")), last = b[b.length - 1]!;
  check("BT10", "summary: every finding's provision id (first seen, no repeats), then every option id", last.kind === "summary" && last.refs.length === 11 &&
    J(last.refs.slice(-2)) === J(["client_spot", "selected_placement"])); }
{ const r = fx("s1-report.json"); r.findings = r.findings.filter((f: any) => f.provision_id !== "PDX.33.110.245.C.1" && f.provision_id !== "PDX.33.110.245.C.2");
  check("BT11", "no height provision: no height beat", !kinds(beatsOf(r, fx("s1-case.json"))).includes("height")); }
{ const r = fx("s1-report.json"); r.findings = r.findings.filter((f: any) => f.provision_id !== "PDX.33.110.245.C.1" && f.provision_id !== "PDX.33.110.245.C.2");
  const rp = C.Report.parse(r), k = C.Case.parse(fx("s1-case.json")), st = buildSite(k), cs = buildConstraints(rp, st.lot), b = buildBeats(rp, st.existing, cs, buildOptions(rp, k));
  const c = b.find((x) => x.kind === "constrain"), want = [...new Set(cs.map((x) => x.provision_id))];
  check("BT12", "no height provision: the constrain beat is still there and lists every constraint provision (first seen)", !!c && J(c.refs) === J(want), J({ c, want })); }

// ---- RCS-12 compileTrace
for (const p of ["s1", "a", "b"]) {
  const t = formatTraceJson(compileTrace(fx(`${p}-report.json`), fx(`${p}-case.json`)));
  check(`CT1.${p}`, `${p}: byte-identical to the golden trace (sha256 pinned)`, t === raw(`${p}-trace.json`) && sha(t) === GOLD[p], sha(t));
}
{ const r = fx("s1-report.json"), k = fx("s1-case.json"), r0 = J(r), k0 = J(k);
  const t1 = formatTraceJson(compileTrace(r, k)), t2 = formatTraceJson(compileTrace(structuredClone(r), structuredClone(k)));
  check("CT2", "two compilations are byte-identical (WK-02), and the inputs are not changed", t1 === t2 && J(r) === r0 && J(k) === k0); }
check("CT3", "the trace parses as C.Trace", C.Trace.safeParse(compileTrace(fx("s1-report.json"), fx("s1-case.json"))).success);
check("CT4", "report_sha256 = sha256 of canonicalJson of the parsed report",
  compileTrace(fx("s1-report.json"), fx("s1-case.json")).report_sha256 === sha(canonicalJson(C.Report.parse(fx("s1-report.json")))));
check("CT5", "raw case and gated case (plan.outline materialized) give the same bytes",
  formatTraceJson(compileTrace(fx("s1-report.json"), fx("s1-case-materialized.json"))) === raw("s1-trace.json"));
{ const r = fx("s1-report.json"); r.reviewer = fx("reviewer-outcome-hold.json");
  const t = compileTrace(r, fx("s1-case.json")), text = formatTraceJson(t), base = compileTrace(fx("s1-report.json"), fx("s1-case.json"));
  const claim = fx("reviewer-outcome-hold.json").flags[0].claim;
  check("CT6", "a reviewed report: the trace has no reviewer key and no flag text; only report_sha256 changes (RC-09)",
    !text.includes("reviewer") && !text.includes(claim) && t.report_sha256 !== base.report_sha256 &&
    canonicalJson({ ...t, report_sha256: "" }) === canonicalJson({ ...base, report_sha256: "" })); }
{ const r = fx("s1-report.json"); r.verdict = "MAYBE";
  check("CT7", "an invalid report is refused (C.Report.parse throws)", thr(() => compileTrace(r, fx("s1-case.json"))) !== ""); }
{ const t = compileTrace(fx("s1-report.json"), fx("s1-case.json"));
  check("CT8", "top-level keys are exactly the contract's, sorted", J(Object.keys(t)) === J(["beats", "constraints", "frame", "options", "report_sha256", "schema", "site"]) && t.schema === "buildnexus.decision-trace/1"); }

// ---- the CLI
const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(here, "compile-trace.mts"), ...args], { encoding: "utf8" });
{ const r = cli([join(FX, "s1-report.json"), join(FX, "s1-case.json")]);
  check("CL1", "CLI: report and case → the trace on stdout, exit 0", r.status === 0 && r.stdout === raw("s1-trace.json"), `${r.status} ${r.stderr.slice(0, 200)}`); }
{ const dir = mkdtempSync(join(tmpdir(), "rct5-"));
  writeFileSync(join(dir, "wrapped.json"), J({ index: {}, report: fx("s1-report.json") }));
  const r = cli([join(dir, "wrapped.json"), join(FX, "s1-case.json"), join(dir, "out.json")]);
  check("CL2", "CLI: a {report: …} wrapper is unwrapped; with a third argument the trace goes to that file and nothing to stdout",
    r.status === 0 && r.stdout === "" && readFileSync(join(dir, "out.json"), "utf8") === raw("s1-trace.json"), `${r.status} ${r.stderr.slice(0, 200)}`);
  rmSync(dir, { recursive: true, force: true }); }
{ const r = cli([]);
  check("CL3", "CLI: no arguments → the usage line on stderr, exit 2",
    r.status === 2 && r.stderr.trim() === "Usage: tsx src/compile-trace.mts <report-or-fixture.json> <case.json> [out-trace.json]", `${r.status} ${J(r.stderr)}`); }

// ---- v2: R-D13 inconsistent FITS, R-D15 coverage in code
{ const thr = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
  const r = structuredClone(fx("s1-report.json")); const sf = r.findings.find((f: any) => f.target === "selected_placement");
  sf.outcome = "fail";
  check("FT1", "a FITS with a failing selected-placement finding is never drawn (R-D13)", thr(() => compileTrace(r, fx("s1-case.json"))) === `report says FITS but ${sf.provision_id} fails at the selected placement`);
  const r2 = structuredClone(fx("s1-report.json")); const m = r2.placement.recommended.margins[0];
  m.margin = -1; m.pass = false;
  check("FT2", "a FITS whose recommended margin does not pass is never drawn (the Report contract refuses it first)", thr(() => compileTrace(r2, fx("s1-case.json"))).includes("FITS needs every margin of the selected placement"));
  const rep = C.Report.parse(fx("s1-report.json")); const t = compileTrace(rep, fx("s1-case.json"));
  check("CV1", "checkCoverage passes on the compiled trace", thr(() => checkCoverage(rep, t)) === "");
  const caseF = rep.findings.find((f) => f.target === "case")!;
  const t1 = structuredClone(t) as any; t1.constraints = t1.constraints.filter((c: any) => c.provision_id !== caseF.provision_id);
  check("CV2", "a trace missing a case finding fails the check in code (R-D15)", thr(() => checkCoverage(rep, t1)) === `trace does not cover the case finding ${caseF.provision_id}`);
  const t2 = structuredClone(t) as any; for (const o of t2.options) o.margins = o.margins.slice(1);
  check("CV3", "a trace missing a margin fails the check in code", /^trace does not cover (a measure of|a margin of the recommended placement)/.test(thr(() => checkCoverage(rep, t2))));
  const t3 = structuredClone(t) as any; const mm = t3.options.find((o: any) => o.margins.length).margins[0]; mm.margin = mm.margin + 0.5;
  check("CV4", "a margin with a changed number is not covered (canonical equality, not substring)", thr(() => checkCoverage(rep, t3)) !== "");
}
console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
