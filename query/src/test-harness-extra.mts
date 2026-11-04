// Harness extras (handout §5): the L48 verdict rule on placement search, the verifier repair loop, run-live
// key loading, the Eugene demo cases, and run-folder outputs. Scripted model client + file graph only: no
// network, no model, no Aura. Muse, 2026-11-04.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCase } from "./case-gate.mts";
import { compileTrace } from "./compile-trace.mts";
import { makeUuid7 } from "./events.mts";
import { createFileGraphReader } from "./graph-reads.mts";
import { evaluateDetailed } from "./harness.mts";
import { ScriptedModelClient, type ModelRequest, type ModelResponse, type ModelToolCallDraft } from "./model-client.mts";
import * as C from "./types.mts";

let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };

const readJson = (rel: string): any => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(path.join(tmpdir(), "lotfit-harness-extra-"));
const reader = createFileGraphReader();
const usage = { model: "scripted-harness-extra", prompt_tokens: 10, completion_tokens: 10 };

async function appliesAllPlan(city: string): Promise<Record<string, unknown>> {
  const idx = await reader.readLayerIndex({ city_layer: city, as_of: "2026-11-15" });
  const all = idx.layers.flatMap((l) => l.provisions);
  return {
    index_hash: idx.index_hash,
    applies: all.map((e) => ({ provision_id: e.provision_id, scope_quote: e.scope.scope_quote, facts_needed: [] as string[] })),
    excluded_at_index: [],
    order: all.map((e) => e.provision_id),
  };
}
let concludeN = 0;
const concludeTurn = (verdict = "NEEDS_CHECK"): ModelResponse => {
  concludeN++;
  return {
    content: "",
    tool_calls: [{ call_id: makeUuid7(), tool: "conclude", provision_id: null, target: "case",
      args: { verdict, summary: `scripted conclude #${concludeN}`, selected_placement: null, client_spot_passes: null } }],
    usage,
  };
};
const reasonsOf = (run: { events: { type: string; data: any }[] }): string[] =>
  (run.events.find((e) => e.type === "lotfit.verdict_computed")?.data.reasons ?? []) as string[];

// EUG stage closure: guards for the 4 gates/plan-constraints, real checks for the 3 with instruments,
// findings for all four. Only then is find_placements reachable (stage order).
const EUG_GATE_PLAN = ["EUG.9.2741.3", "EUG.9.2751.17.a.1", "EUG.9.2751.17.b.4.a.slope", "EUG.T9.2740"];
function eugClosureScript(plan: unknown, searchPid: string, extraExecTurns: ModelToolCallDraft[][] = []) {
  const gids = EUG_GATE_PLAN.map(() => makeUuid7());
  const cGate = makeUuid7(), cSize = makeUuid7(), cSlope = makeUuid7();
  const finding = (pid: string, outcome: string, ev: string[]): ModelToolCallDraft => ({
    call_id: makeUuid7(), tool: "record_finding", provision_id: pid, target: "case",
    args: { provision_id: pid, target: "case", clause_ids: [`${pid}#v1::sentence:1`], outcome,
      evidence_call_ids: ev, numbers: [], quotes: [{ clause_id: `${pid}#v1::sentence:1`, quote: "scope" }] },
  });
  const turns: ModelToolCallDraft[][] = [
    [{ call_id: makeUuid7(), tool: "read_layer_index", provision_id: null, target: "case", args: { city_layer: "EUG", as_of: "2026-11-15" } }],
    [],
    EUG_GATE_PLAN.map((pid, i) => ({ call_id: gids[i], tool: "evaluate_guards", provision_id: pid, target: "case", args: { provision_id: pid, target: "case" } })),
    [{ call_id: cGate, tool: "check_max", provision_id: "EUG.9.2741.3", target: "case",
      args: { provision_id: "EUG.9.2741.3", target: "case", value: { fact: "plan.accessory_dwellings_on_lot" },
        limit: { provision_id: "EUG.9.2741.3", param: "max_accessory_dwellings_per_dwelling" } } },
      finding("EUG.T9.2740", "unknown", [gids[3]!])],
    [finding("EUG.9.2741.3", "pass", [cGate])],
    [{ call_id: cSize, tool: "adu_max_living_area", provision_id: "EUG.9.2751.17.a.1", target: "case",
      args: { provision_id: "EUG.9.2751.17.a.1", target: "case",
        share: { provision_id: "EUG.9.2751.17.a.1", param: "max_share_of_lot_area" },
        cap: { provision_id: "EUG.9.2751.17.a.1", param: "max_building_sqft" },
        primary_living_area: { fact: "site.lot_area_sqft" }, plan_living_area: { fact: "plan.total_building_sqft" } } },
      { call_id: cSlope, tool: "check_max", provision_id: "EUG.9.2751.17.b.4.a.slope", target: "case",
        args: { provision_id: "EUG.9.2751.17.b.4.a.slope", target: "case", value: { fact: "plan.height_ft" },
          limit: { provision_id: "EUG.9.2751.17.b.4.a.slope", param: "max_height" } } }],
    [finding("EUG.9.2751.17.a.1", "pass", [cSize]), finding("EUG.9.2751.17.b.4.a.slope", "pass", [cSlope])],
    [{ call_id: makeUuid7(), tool: "find_placements", provision_id: searchPid, target: "client_spot",
      args: { provision_id: searchPid, target: "client_spot", footprint: { fact: "plan.footprint" }, setback_provisions: [searchPid] } }],
    ...extraExecTurns,
  ];
  let planStep = 0, execStep = 0;
  return (req: ModelRequest): ModelResponse => {
    if (req.phase === "plan") {
      planStep++;
      if (planStep === 1) return { content: "", tool_calls: turns[0]!, usage };
      return { content: JSON.stringify(plan), tool_calls: [], usage };
    }
    const calls = turns[2 + execStep] ?? [];
    execStep++;
    if (calls.length) return { content: "", tool_calls: calls, usage };
    return concludeTurn();
  };
}

const EUG_BASE = readJson("../cases/eug-demo-16x36.json");
const nolot = structuredClone(EUG_BASE);
nolot.site.house_outline.value = structuredClone(nolot.site.lot_outline.value);
// Marginal-only search: original geometry, but 30 ft line tolerances, so no placement clears every
// margin (the lot is 64 ft wide; the far side margin tops out at 23 ft) while all survive.
const narrow = structuredClone(EUG_BASE);
for (const k of ["front_lot_line", "rear_lot_line", "side_lot_lines"])
  for (const p of narrow.site[k].prov) { p.tolerance = { value: 30, unit: "ft" }; if (!p.status) p.status = "measured"; }

const eugPlan = await appliesAllPlan("EUG");
const SEARCH_PID = "EUG.9.2751.17.b.4.a.setback";
const rNoLegs = await evaluateDetailed(nolot, { graphReader: reader,
  modelClient: new ScriptedModelClient(eugClosureScript(eugPlan, SEARCH_PID)),
  runsDir: path.join(scratch, "runs-nolegs"), budgets: { max_verify_repairs: 1 } });
const sNoLegs = rNoLegs.report.placement.search;
ok("L48: a search with no candidate at all gives NO_LEGS",
  rNoLegs.report.verdict === "NO_LEGS" && sNoLegs?.count === 0,
  `verdict=${rNoLegs.report.verdict} count=${sNoLegs?.count} clear=${sNoLegs?.clear_count}`);
ok("L48: its reason cites no-clear-placement",
  reasonsOf(rNoLegs).some((r) => r.includes("found no clear placement")),
  reasonsOf(rNoLegs).join(" | ").slice(0, 300));

const rMarg = await evaluateDetailed(narrow, { graphReader: reader,
  modelClient: new ScriptedModelClient(eugClosureScript(eugPlan, SEARCH_PID)),
  runsDir: path.join(scratch, "runs-marginal"), budgets: { max_verify_repairs: 1 } });
const sMarg = rMarg.report.placement.search;
const margVerdict: string = rMarg.report.verdict;
ok("L48: an all-too-close search gives NEEDS_CHECK, never NO_LEGS",
  margVerdict !== "NO_LEGS" && margVerdict === "NEEDS_CHECK" &&
  (sMarg?.count ?? 0) > 0 && sMarg?.clear_count === 0,
  `verdict=${margVerdict} count=${sMarg?.count} clear=${sMarg?.clear_count}`);
ok("L48: its reason cites the marginal-only rule",
  reasonsOf(rMarg).some((r) => r.includes("too close to call and none clear")),
  reasonsOf(rMarg).join(" | ").slice(0, 300));

// Repair loop on s1: conclude with no findings skips every placement rule, gets a V1 repair turn,
// then exhausts the repair budget and ends abnormally.
const s1 = readJson("../cases/s1.json");
const pdxPlan = await appliesAllPlan("PDX");
let rStep = 0;
const repairModel = new ScriptedModelClient((req: ModelRequest): ModelResponse => {
  rStep++;
  if (req.phase === "plan") {
    if (rStep === 1) return { content: "", tool_calls: [{ call_id: makeUuid7(), tool: "read_layer_index", provision_id: null, target: "case", args: { city_layer: "PDX", as_of: "2026-11-15" } }], usage };
    return { content: JSON.stringify(pdxPlan), tool_calls: [], usage };
  }
  return concludeTurn();
});
const rRep = await evaluateDetailed(s1, { graphReader: reader, modelClient: repairModel,
  runsDir: path.join(scratch, "runs-repair"), budgets: { max_verify_repairs: 1 } });
const v1Repair = repairModel.recordedRequests.find((q) =>
  (q.pending_repairs ?? []).some((p: any) => p.code === "V1_COVERAGE" && JSON.stringify(p).includes("PDX.33.110.220.B")));
ok("repair loop: skipping a placement rule gets a V1 repair turn naming it",
  v1Repair !== undefined,
  v1Repair ? "" : `pending codes seen: ${JSON.stringify(repairModel.recordedRequests.flatMap((q) => (q.pending_repairs ?? []).map((p: any) => p.code)).slice(0, 8))}`);
const vcEv = rRep.events.find((e) => e.type === "lotfit.verdict_computed");
const exhausted = rRep.events.some((e) => e.type === "error" && (e.data as any).code === "VERIFY_REPAIR_EXHAUSTED");
ok("repair loop: after the repair limit the run ends abnormally (no verdict claimed)",
  (vcEv?.data as any)?.abnormal_end === true && exhausted,
  `abnormal_end=${(vcEv?.data as any)?.abnormal_end} exhausted=${exhausted}`);

// run-live key loading: subprocesses, never past the key check or the case read (no network).
const RUN_LIVE = fileURLToPath(new URL("./run-live.mts", import.meta.url));
const scrubbed = { ...process.env } as Record<string, string | undefined>;
for (const k of ["FIREWORKS_API_KEY", "BASETEN_META_API_KEY", "LOTFIT_PROVIDER", "META_API_KEY"]) delete scrubbed[k];
const envLocal = existsSync(path.join(ROOT, ".env.local")) ? readFileSync(path.join(ROOT, ".env.local"), "utf8") : "";
const localHasKeys = /^(FIREWORKS_API_KEY|BASETEN_META_API_KEY)=/m.test(envLocal);
const spawn = (env: Record<string, string | undefined>, args: string[]): { status: number | null; out: string } => {
  try {
    const out = execFileSync(process.execPath, [RUN_LIVE, ...args], { env: env as Record<string, string>, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, out: String(out) };
  } catch (e: any) {
    return { status: e.status ?? 1, out: String(e.stderr ?? "") + String(e.stdout ?? "") + String(e.message ?? "") };
  }
};
if (localHasKeys) {
  console.log("SKIP (.env.local supplies keys)  run-live: no key anywhere exits clearly");
  console.log("SKIP (.env.local supplies keys)  run-live: --baseten selects Baseten");
} else {
  const noKey = spawn(scrubbed, ["s1"]);
  ok("run-live: no key anywhere exits with a clear message", noKey.status !== 0 && /FIREWORKS_API_KEY not found/.test(noKey.out),
    `status=${noKey.status} ${noKey.out.slice(0, 160)}`);
  const baseten = spawn(scrubbed, ["--baseten"]);
  ok("run-live: --baseten selects Baseten", baseten.status !== 0 && /BASETEN_META_API_KEY not found/.test(baseten.out),
    `status=${baseten.status} ${baseten.out.slice(0, 160)}`);
}
const FAKE = "fake-test-marker-KEY123";
// End to end, no network: the child imports the real run-live (a bad case name stops it at the case
// read, past the key block), then builds the default model client run-live would build.
const childScript = [
  `process.argv.splice(1, 0, "run-live.mts");`,
  `try { await import(${JSON.stringify(pathToFileURL(RUN_LIVE).href)}); console.error("UNEXPECTED_SUCCESS"); process.exit(2); }`,
  `catch (e) { const m = String((e && e.message) || e);`,
  `  if (!/no-such-case-xyz/.test(m)) { console.error("UNEXPECTED " + m.slice(0, 200)); process.exit(2); } }`,
  `const { BasetenModelClient } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "query", "src", "model-client.mts")).href)});`,
  `const c = new BasetenModelClient();`,
  `console.log("MODELID=" + c.modelId);`,
  `console.log("ROUTE=" + c.providerRoute);`,
].join("\n");
let withKey: { status: number | null; out: string };
try {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", childScript, "no-such-case-xyz"],
    { env: { ...scrubbed, FIREWORKS_API_KEY: FAKE } as Record<string, string>, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  withKey = { status: 0, out: String(out) };
} catch (e: any) {
  withKey = { status: e.status ?? 1, out: String(e.stderr ?? "") + String(e.stdout ?? "") + String(e.message ?? "") };
}
ok("run-live: with FIREWORKS_API_KEY set it chooses Fireworks",
  withKey.status === 0 && !/FIREWORKS_API_KEY not found/.test(withKey.out) &&
  withKey.out.includes("MODELID=accounts/fireworks/models/muse-spark-open") &&
  withKey.out.includes("ROUTE=https://api.fireworks.ai/inference/v1"), withKey.out.slice(0, 300));
ok("run-live: the key is never printed", !withKey.out.includes(FAKE));

// The four demo cases pass the Case check; a scripted run on the scanline case reports and traces.
for (const f of ["eug-demo-16x36.json", "eug-demo-24x24.json", "eug-demo-16x36.scanline.json", "eug-demo-24x24.scanline.json"]) {
  const r = checkCase(readJson(`../cases/${f}`));
  ok(`${f} passes the Case check`, !("refused" in r), "refused" in r ? `[${r.invariant}] ${r.message}` : "");
}
const scanInput = readJson("../cases/eug-demo-16x36.scanline.json");
const rScan = await evaluateDetailed(scanInput, { graphReader: reader,
  modelClient: new ScriptedModelClient(eugClosureScript(eugPlan, SEARCH_PID)),
  runsDir: path.join(scratch, "runs-scan"), budgets: { max_verify_repairs: 1 } });
ok("scripted scanline run: report parses as Report", C.Report.safeParse(rScan.report).success);
const traceKase = structuredClone(scanInput);
const { materializeComputedFacts } = await import("./sensitivity.mts");
materializeComputedFacts(traceKase);
const trace1 = compileTrace(rScan.report, traceKase);
ok("scripted scanline run: trace compiles and parses as Trace", C.Trace.safeParse(trace1).success);
ok("run folder holds events.jsonl, report.json and trace.json",
  ["events.jsonl", "report.json", "trace.json"].every((f) => existsSync(path.join(rScan.run_dir, f))), rScan.run_dir);
const trace2 = compileTrace(rScan.report, traceKase);
ok("trace is byte-identical when compiled twice", JSON.stringify(trace1) === JSON.stringify(trace2));

await reader.close();
console.log(`${n}/${t} checks passed`);
process.exit(n === t ? 0 : 1);
