/**
 * The wiring of P1 and the Reviewer through the whole harness (build-review A6/S12, 2026-11-03). The unit suites prove the
 * pure functions; this proves the events are written, the Judge reads them, the verifier skips them, and the Reviewer gets
 * them, on a real Eugene run (Martin's lot, file graph) with a scripted Planner and a scripted Reviewer. No network.
 * The scripted Planner applies every protected provision and excludes every other one on its reading, then concludes
 * NEEDS_CHECK. CC.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { evaluateDetailed } from "./harness.mts";
import { createFileGraphReader } from "./graph-reads.mts";
import { ScriptedModelClient } from "./model-client.mts";
import { ScriptedReviewerClient } from "./reviewer-client.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
let n = 0, ok = 0;
function check(name: string, cond: boolean, detail = ""): void {
  n++; if (cond) { ok++; console.log(`PASS  ${name}`); } else console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}
const EUG_CASE = JSON.parse(readFileSync(path.join(here, "..", "cases", "eug-demo-16x36.json"), "utf8"));
const S1_CASE = JSON.parse(readFileSync(path.join(here, "..", "cases", "s1.json"), "utf8"));
let KASE: any = EUG_CASE;
const ACTIVE = new Set(["gate", "plan_constraint", "placement_constraint"]);
const REVIEWED = new Set(["gate", "plan_constraint", "placement_constraint", "exception", "preemption"]);

async function run(reviewerMode: "flag" | "none" | "explode", kase: any = EUG_CASE, alsoExclude: string[] = []) {
  KASE = kase;
  const reader = createFileGraphReader();
  const idx = await reader.readLayerIndex({ city_layer: KASE.jurisdiction.city_layer, state_layer: KASE.jurisdiction.state_layer, as_of: KASE.as_of.date });
  const all = idx.layers.flatMap((l) => l.provisions);
  const prot = (p: (typeof all)[number]) => !alsoExclude.includes(p.provision_id) && (p.evaluation_stage === "gate" || p.has_operator || p.modifies_operator_backed);
  const plan = { index_hash: idx.index_hash,
    applies: all.filter(prot).map((p) => ({ provision_id: p.provision_id, scope_quote: p.scope.scope_quote, facts_needed: [] as string[] })),
    excluded_at_index: all.filter((p) => !prot(p)).map((p) => ({ provision_id: p.provision_id, scope_quote: p.scope.scope_quote })),
    order: all.filter(prot).map((p) => p.provision_id) };
  let turn = 0;
  const model = new ScriptedModelClient((req: any) => {
    turn++;
    if (req.phase === "plan" && turn === 1) return { content: "", tool_calls: [
      { call_id: "c1", tool: "read_reading_guide", provision_id: null, target: "case", args: {} },
      { call_id: "c2", tool: "read_layer_index", provision_id: null, target: "case", args: { city_layer: KASE.jurisdiction.city_layer, as_of: KASE.as_of.date } },
      { call_id: "c3", tool: "inspect_case_facts", provision_id: null, target: "case", args: {} }] };
    if (req.phase === "plan") {
      // a refused exclusion (a guard known true on the case) moves to applies, as a Planner repairing its plan would
      for (const id of new Set((req.pending_repairs ?? []).map((r: any) => r.provision_id))) {
        const i = plan.excluded_at_index.findIndex((x) => x.provision_id === id);
        if (i >= 0) { const [x] = plan.excluded_at_index.splice(i, 1); plan.applies.push({ provision_id: x!.provision_id, scope_quote: x!.scope_quote, facts_needed: [] }); plan.order.push(x!.provision_id); }
      }
      return { content: JSON.stringify(plan), plan, tool_calls: [] };
    }
    return { content: "", tool_calls: [{ call_id: `cz${turn}`, tool: "conclude", provision_id: null, target: "case",
      args: { verdict: "NEEDS_CHECK", summary: "wiring test", selected_placement: null, client_spot_passes: null } }] };
  });
  let calls = 0;
  const reviewer = reviewerMode === "none" ? null : reviewerMode === "explode"
    ? ({ get modelId(): string { throw new Error("planted: the Reviewer client is broken"); }, providerRoute: "scripted", answer: async () => ({ content: "", usage: { model: "x", prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 } }) } as any)
    : new ScriptedReviewerClient("muse-spark-1.3", (item) => {
    calls++;
    const quote = item.scope.quote.length >= 20 ? item.scope.quote.slice(0, 60) : (item.text.find((t) => t.quote.length >= 20)?.quote ?? item.scope.quote).slice(0, 60);
    return JSON.stringify({ item_sha256: item.item_sha256, answer: "unclear", category: "exclusion_on_unknown_fact", quote,
      // a rule fact the case does not hold, when the rule has one; else an off-rule fact (kept, never confirmed: R2-1)
      ...(() => { const f = item.case_facts.find((c) => (item.rule_facts ?? []).includes(c.fact) && ["unknown", "unconfirmed", "conflicting"].includes(c.status));
        return f ? { fact: f.fact, fact_claim: f.status } : { fact: "site.slope_pct", fact_claim: "unknown" }; })(),
      claim: "wiring test: turns on a fact the case does not hold" });
  });
  const r = await evaluateDetailed(KASE, { graphReader: reader, modelClient: model, reviewerClient: reviewer,
    runsDir: mkdtempSync(path.join(tmpdir(), "lotfit-wiring-")),
    budgets: { max_tokens: 3_000_000, max_turns: 12, max_calls: 200, max_plan_execute_ms: 600_000, max_total_ms: 660_000 } });
  return { r, idx: new Map(all.map((p) => [p.provision_id, p])), calls: () => calls };
}

const { r, idx, calls } = await run("flag");
const evs = r.events;
const excl = evs.filter((e): e is Extract<typeof e, { type: "lotfit.exclusion_recorded" }> => e.type === "lotfit.exclusion_recorded");
const readings = excl.filter((e) => e.data.basis === "planner_reading");
const activeReadings = readings.filter((e) => ACTIVE.has(idx.get(e.data.provision_id)?.evaluation_stage ?? ""));
const reviewedReadings = readings.filter((e) => REVIEWED.has(idx.get(e.data.provision_id)?.evaluation_stage ?? ""));

check("W1 the accepted plan writes one exclusion_recorded per exclusion, with active-stage Planner readings among them (kills M5)",
  excl.length > 0 && activeReadings.length > 0, JSON.stringify({ excl: excl.length, active: activeReadings.map((e) => e.data.provision_id) }));
const uncheckedIds = new Set(r.report.unchecked.map((u) => u.provision_id));
check("W2 the Judge lists every active-stage Planner reading in report.unchecked (kills M1)",
  activeReadings.every((e) => uncheckedIds.has(e.data.provision_id)), JSON.stringify([...activeReadings.map((e) => e.data.provision_id)].filter((p) => !uncheckedIds.has(p))));
check("W3 the verdict is not FITS while readings are unchecked", r.report.verdict !== "FITS" && r.report.verdict !== "FITS_IF", r.report.verdict);
const vc = evs.find((e) => e.type === "lotfit.verifier_completed") as any;
const v1OnReadings = (vc?.data.issues ?? []).filter((i: any) => i.code === "V1_COVERAGE" && readings.some((e) => e.data.provision_id === i.provision_id));
check("W4 the verifier asks no finding of a provision excluded on a reading (kills M2)", v1OnReadings.length === 0, JSON.stringify(v1OnReadings.slice(0, 3)));
const rv = r.report.reviewer!;
check("W5 the Reviewer gets one item per reviewed-stage reading and is called once per item (kills M10)",
  rv.items === reviewedReadings.length && rv.items > 0 && calls() === rv.items, JSON.stringify({ items: rv.items, readings: reviewedReadings.length, calls: calls() }));
check("W6 every item answered → flagged; a flag is confirmed only on a fact its rule reads (R2-1); none held on a NEEDS_CHECK", rv.status === "flagged" && rv.answered === rv.items &&
  rv.flags.every((f) => { if (!f.confirmed) return true;
    const it = JSON.parse(readFileSync(path.join(r.run_dir, `review-${f.provision_id}.json`), "utf8")).item;
    return (it.rule_facts ?? []).includes(f.fact); }) && !rv.hold, JSON.stringify({ status: rv.status, answered: rv.answered, hold: rv.hold, rejected: rv.rejected.slice(0, 2) }));
const rc = evs.find((e) => e.type === "lotfit.reviewer_completed") as any;
check("W7 reviewer_completed records items and answered", rc?.data.items === rv.items && rc?.data.answered === rv.answered);
check("W8 every event on disk parses (1.5.0)", readFileSync(path.join(r.run_dir, "events.jsonl"), "utf8").trim().split("\n").every((l) => C.LotFitEvent.safeParse(JSON.parse(l)).success));

const { r: r0 } = await run("none");
check("W9 the same run without a Reviewer: same verdict, review not_run, verify turn ok (A19/S17)",
  r0.report.verdict === r.report.verdict && r0.report.reviewer?.status === "not_run" &&
  (r0.events.filter((e) => e.type === "turn_ended").at(-1) as any)?.data.status === "ok", `${r0.report.verdict} / ${r0.report.reviewer?.status}`);

const { r: rx } = await run("explode");
check("W10 a Reviewer that throws inside the review step: the run still writes report.json and trace.json; review not_run (harness) (A12/S8)",
  rx.report.reviewer?.status === "not_run" && rx.report.reviewer?.error?.category === "harness" && rx.report.verdict === r.report.verdict,
  JSON.stringify(rx.report.reviewer?.error));

// Portland S1, same scripted Planner: Table 110-4 and 110-5 are excluded "through" 220.B and 225.B, which are applied but
// never checked (the Planner concludes at once). Build-review A10: they must be unchecked, not computed.
const { r: rp } = await run("none", S1_CASE, ["PDX.T110-4", "PDX.T110-5"]);
const throughs = rp.events.filter((e: any) => e.type === "lotfit.exclusion_recorded" && e.data.basis === "through_operator").map((e: any) => e.data.provision_id);
const unP = new Set(rp.report.unchecked.map((u) => u.provision_id));
check("W11 a through-operator exclusion whose sibling has no finding is unchecked (A10)", throughs.length > 0 && throughs.every((p: string) => unP.has(p)),
  JSON.stringify({ throughs, unchecked: [...unP].slice(0, 12) }));

console.log(`${ok}/${n} review-wiring checks passed`);
process.exit(ok === n ? 0 : 1);
