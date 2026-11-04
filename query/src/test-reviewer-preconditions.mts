/**
 * Planted tests for the Reviewer's preconditions (CONTRACT-REVIEWER.md §1, test T0; contracts 1.4.0). CC, 2026-11-03.
 *
 *   P1  no forged facts: a Planner exclusion is recorded with its basis. A guard that is known true refuses the
 *       exclusion; a guard that is unknown leaves it the Planner's reading, never `known_false`; the Judge then lists
 *       it as unchecked (no FITS rests on it) unless a person signed a disposition for its scope clause.
 *       (SPEC rows 3 and 14; L38; the bug was harness.mts validatePlanAgainstIndex storing known_false for any
 *       unprotected exclusion.)
 *   P2  the Record holds the basis of every exclusion (lotfit.exclusion_recorded) and the verdict's reasons.
 *   P3  an operator that checks only part of a provision cannot make it pass (EUG.9.2751.17.b.4.a.slope: the 25-ft cap
 *       only, the sloped plane has no tool): the outcome is unknown, naming what is missing.
 *
 * Expected values are written here before the run. Exit 1 on any surprise.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { createFileGraphReader } from "./graph-reads.mts";
import { CURATED_PROVISION_TRIGGER_GUARDS, buildGuardFacts, plannerReadingsUnchecked, validatePlanAgainstIndex, type RuleFamilyType } from "./harness.mts";
import { computeFindingOutcome, loadProvisionRules } from "./outcome.mts";
import { makeUuid7 } from "./events.mts";
import { checkLimitAgainstResolvedParams, combineCitedOutcome, verify } from "./verifier.mts";
import { materializeComputedFacts } from "./sensitivity.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const S1 = JSON.parse(readFileSync(path.join(here, "..", "cases", "s1.json"), "utf8"));
const CONFIG = "a".repeat(64);
let n = 0, ok = 0;
function check(name: string, cond: boolean, detail = ""): void {
  n++;
  if (cond) { ok++; console.log(`PASS  ${name}`); } else console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const reader = createFileGraphReader();
const fullIndex = await reader.readLayerIndex({ city_layer: "PDX", as_of: "2026-11-15" });
const entryOf = (pid: string) => fullIndex.layers.flatMap((l) => l.provisions).find((p) => p.provision_id === pid)!;
/** An index of one provision and a Plan that excludes it with the index's own scope sentence. */
function oneProvision(pid: string) {
  const e = entryOf(pid);
  const index = { ...fullIndex, layers: [{ layer: e.layer, order: 1, provisions: [e] }] };
  const plan = { index_hash: fullIndex.index_hash, applies: [], excluded_at_index: [{ provision_id: pid, scope_quote: e.scope.scope_quote }], order: [] };
  return { e, index, plan };
}
// The planted provision's scope is its curated trigger, site.flag_lot. Build-review A1: before, a false guard anywhere in
// the provision (site.alley on a "when" condition) also ruled it out; now only the scope decides. Both facts are still
// planted together so the test is the same as before on the old code.
const GUARD_FACTS = ["flag_lot", "alley"];
const withFlag = (value: boolean | "unknown") => {
  const k = structuredClone(S1);
  for (const f of GUARD_FACTS) {
    if (value === "unknown") { delete k.site[f]; k.unknowns = [...(k.unknowns ?? []), { fact: `site.${f}`, reason: "planted: not on record" }]; }
    else k.site[f].value = value;
  }
  return k;
};

// ---- P1 on an unprotected placement constraint with a guard on the case (Portland flag-lot landscaping, guard: site.alley)
const PID = "PDX.33.110.255.B.1.b-e";
{
  const { e, index, plan } = oneProvision(PID);
  check("P1.0 the planted provision is unprotected (not a gate, no operator, not a modifier)",
    e.evaluation_stage !== "gate" && !e.has_operator && !e.modifies_operator_backed, JSON.stringify({ stage: e.evaluation_stage, op: e.has_operator }));

  const vFalse = await validatePlanAgainstIndex(plan, index, withFlag(false), reader, new Map(), CONFIG);
  check("P1.1 flag_lot and alley false → guard known_false → exclusion accepted, basis computed_known_false",
    vFalse.repairs.length === 0 && vFalse.exclusions[0]?.basis === "computed_known_false" && vFalse.excludedGuardResults.get(PID)?.result === "known_false",
    JSON.stringify({ repairs: vFalse.repairs.map((r) => r.code), ex: vFalse.exclusions }));

  const vTrue = await validatePlanAgainstIndex(plan, index, withFlag(true), reader, new Map(), CONFIG);
  // Depending on the lot area the guard may still be false (the rule covers flag lots ≤ 10,000 sq ft): then the
  // exclusion stays computed. Either way it must never be accepted while a guard is known true.
  const guardTrue = vTrue.exclusions.length === 0 && vTrue.repairs.some((r) => r.code === "PLAN_FORBIDDEN_EXCLUSION" && r.provision_id === PID);
  const stillFalse = vTrue.exclusions[0]?.basis === "computed_known_false";
  check("P1.2 flag_lot and alley true → the guard is known true and the exclusion is refused (PLAN_FORBIDDEN_EXCLUSION)",
    guardTrue && !stillFalse, JSON.stringify({ repairs: vTrue.repairs, ex: vTrue.exclusions }));
  check("P1.2b flag_lot and alley true never yields basis planner_reading or a synthetic known_false",
    !vTrue.exclusions.some((x) => x.basis === "planner_reading") && (vTrue.excludedGuardResults.get(PID)?.guards.every((g) => g.fact !== "plan.scope_reading") ?? true));

  const vUnk = await validatePlanAgainstIndex(plan, index, withFlag("unknown"), reader, new Map(), CONFIG);
  check("P1.3 flag_lot and alley unknown → exclusion kept as the Planner's reading (basis planner_reading)",
    vUnk.repairs.length === 0 && vUnk.exclusions[0]?.basis === "planner_reading", JSON.stringify({ repairs: vUnk.repairs, ex: vUnk.exclusions }));
  check("P1.4 flag_lot and alley unknown → NO guard result is stored for it (the old code stored known_false here)",
    !vUnk.excludedGuardResults.has(PID), JSON.stringify(vUnk.excludedGuardResults.get(PID)));

  // ---- the Judge side, on the recorded event
  const ev = (basis: string, pid = PID, scope = e.scope.scope_clause_id) => C.LotFitEvent.parse({
    id: makeUuid7(), thread_id: makeUuid7(), session_id: null, turn_id: makeUuid7(), seq: 1, created_at: new Date().toISOString(),
    config_hash: CONFIG, graph_load_id: fullIndex.graph_load_id, type: "lotfit.exclusion_recorded",
    data: { provision_id: pid, basis, guard_call_id: null, guard_result: basis === "planner_reading" ? "unknown" : null, through: null, scope_clause_id: scope, scope_quote: e.scope.scope_quote },
  });
  const fams = new Map<string, RuleFamilyType>((await reader.readRuleFamily({ provision_ids: [PID], as_of: "2026-11-15" })).map((f) => [f.provision_id, f]));
  const stage = () => e.evaluation_stage;
  const j1 = plannerReadingsUnchecked([ev("planner_reading")], stage, fams);
  check("P1.5 Judge: a planner_reading exclusion of a placement constraint is unchecked (so the verdict cannot be FITS)",
    j1.unchecked.length === 1 && j1.unchecked[0]!.provision_id === PID && /Planner's reading/.test(j1.unchecked[0]!.reason), JSON.stringify(j1));
  const j2 = plannerReadingsUnchecked([ev("computed_known_false"), ev("through_operator")], stage, fams);
  check("P1.6 Judge: computed and through-operator exclusions are not unchecked", j2.unchecked.length === 0 && j2.relied.length === 0);
  const j3 = plannerReadingsUnchecked([ev("planner_reading")], () => "definition", fams);
  check("P1.7 Judge: a definition excluded on a reading is not unchecked (reached through edges, §3)", j3.unchecked.length === 0);
  const signed = new Map(fams); const f0 = structuredClone(fams.get(PID)!);
  const sc = f0.clauses.find((c) => c.clause_id === e.scope.scope_clause_id);
  if (sc) sc.disposition = { kind: "inert_for", scope: "detached_adu", reason: "planted: signed for the test", by: "Martin Fabbri", date: "2026-11-03" };
  signed.set(PID, f0);
  const j4 = plannerReadingsUnchecked([ev("planner_reading")], stage, signed, "detached_adu");
  check("P1.8 Judge: a signed inert_for disposition on the scope clause is relied on and named, not unchecked",
    !!sc && j4.unchecked.length === 0 && j4.relied.length === 1, JSON.stringify({ hasScopeClause: !!sc, j4 }));
  const j5 = plannerReadingsUnchecked([ev("planner_reading")], stage, signed, "attached_adu");
  check("P1.9 Judge: a disposition signed for detached ADUs does not excuse a reading on an attached ADU (A9)", j5.unchecked.length === 1 && j5.relied.length === 0);
}

// ---- Build-review A1, A7, A11 (2026-11-03): only the provision's scope rules it out; never a guard on an "Except…"
// clause, an obligation sentence or a sub-condition; never an unconfirmed fact; a zone match alone refuses nothing.
{
  const EUG = JSON.parse(readFileSync(path.join(here, "..", "cases", "eug-demo-16x36.json"), "utf8"));
  const eIdx = await reader.readLayerIndex({ city_layer: "EUG", as_of: EUG.as_of.date });
  const one = (idx: typeof eIdx, pid: string) => { const e = idx.layers.flatMap((l) => l.provisions).find((p) => p.provision_id === pid)!;
    return { e, index: { ...idx, layers: [{ layer: e.layer, order: 1, provisions: [e] }] },
      plan: { index_hash: idx.index_hash, applies: [], excluded_at_index: [{ provision_id: pid, scope_quote: e.scope.scope_quote }], order: [] } }; };
  const excl = async (idx: typeof eIdx, kase: any, pid: string) => { const o = one(idx, pid);
    return validatePlanAgainstIndex(o.plan, o.index, kase, reader, new Map(), CONFIG); };
  const v1 = await excl(eIdx, EUG, "EUG.9.2751.17.b.4.a.setback");
  check("A1.1 Eugene interior setback (\"Except for … flag lots\") on a non-flag lot cannot be excluded: flag_lot false means it applies",
    v1.exclusions.length === 0 && v1.repairs.some((r) => r.code === "PLAN_FORBIDDEN_EXCLUSION"), JSON.stringify({ r: v1.repairs.map((x) => x.code), x: v1.exclusions }));
  const v2 = await excl(fullIndex, S1, "PDX.33.205.040.C.1");
  check("A1.2 Portland ADU size cap on S1 cannot be excluded on its basement/duplex special cases",
    v2.exclusions.length === 0 && v2.repairs.some((r) => r.code === "PLAN_FORBIDDEN_EXCLUSION"), JSON.stringify({ r: v2.repairs.map((x) => x.code), x: v2.exclusions }));
  const v3 = await excl(fullIndex, S1, "PDX.33.205.020.B.1.a");
  check("A1.3 Portland \"where ADUs are allowed\" gate cannot be excluded because the house is not manufactured",
    v3.exclusions.length === 0 && v3.repairs.some((r) => r.code === "PLAN_FORBIDDEN_EXCLUSION"), JSON.stringify({ r: v3.repairs.map((x) => x.code), x: v3.exclusions }));
  const v4 = await excl(eIdx, EUG, "EUG.9.2751.17.b.2");
  check("A1.4 Eugene walkway (\"from the street or alley\") with no alley is a Planner reading, never computed",
    v4.exclusions[0]?.basis === "planner_reading", JSON.stringify(v4.exclusions));
  const k7 = structuredClone(EUG); k7.site.flag_lot = { ...k7.site.flag_lot, status: "unconfirmed" };
  const v5 = await excl(eIdx, k7, "EUG.9.2775.5.e.1.a");
  check("A7.1 an unconfirmed flag_lot = false does not rule e.1.a out: the exclusion is a Planner reading", v5.exclusions[0]?.basis === "planner_reading", JSON.stringify(v5.exclusions));
  const v6 = await excl(eIdx, EUG, "EUG.9.2751.17.c");
  check("A11.1 17.c on an R-1 lot: a zone match alone does not refuse the exclusion; it is a Planner reading",
    v6.repairs.length === 0 && v6.exclusions[0]?.basis === "planner_reading", JSON.stringify({ r: v6.repairs, x: v6.exclusions }));
}

// ---- Build-review round 2 (B1, B2, B7, B8; L45): the scope sources the fix trusts, pinned.
{
  const EUG = JSON.parse(readFileSync(path.join(here, "..", "cases", "eug-demo-16x36.json"), "utf8"));
  const eIdx = await reader.readLayerIndex({ city_layer: "EUG", as_of: EUG.as_of.date });
  const pick = (idx: typeof eIdx, pid: string) => { const e = idx.layers.flatMap((l) => l.provisions).find((p) => p.provision_id === pid)!;
    return { e, index: { ...idx, layers: [{ layer: e.layer, order: 1, provisions: [e] }] },
      plan: { index_hash: idx.index_hash, applies: [], excluded_at_index: [{ provision_id: pid, scope_quote: e.scope.scope_quote }], order: [] } }; };
  const excl = async (idx: typeof eIdx, kase: any, pid: string) => { const o = pick(idx, pid); return validatePlanAgainstIndex(o.plan, o.index, kase, reader, new Map(), CONFIG); };
  const zoned = (k: any, z: string) => { const c = structuredClone(k); c.site.zone = { ...c.site.zone, value: z }; return c; };

  const b1a = await excl(fullIndex, zoned(S1, "R2.5"), "PDX.T110-4");
  check("R2.B1.1 Table 110-4 on an R2.5 lot is never computed out from footnote zones", !b1a.exclusions.some((x) => x.basis === "computed_known_false"), JSON.stringify(b1a.exclusions));
  const b1b = await excl(eIdx, zoned(EUG, "R-2"), "EUG.9.2751.17.a.2");
  check("R2.B1.2 Eugene 17.a.2 on an R-2 lot is not computed out from the neighbour's zone (\"abuts property zoned R-1\")", !b1b.exclusions.some((x) => x.basis === "computed_known_false"), JSON.stringify(b1b.exclusions));

  const trees = structuredClone(S1); trees.site.trees = { ...trees.site.trees, value: true };
  for (const pid of ["PDX.11.50.020", "PDX.11.50.040.A", "PDX.11.50.050.A"]) {
    const v = await excl(fullIndex, trees, pid);
    check(`R2.B2 ${pid} with trees on the lot cannot be excluded`, v.exclusions.length === 0 && v.repairs.some((r) => r.code === "PLAN_FORBIDDEN_EXCLUSION"), JSON.stringify({ r: v.repairs.map((x) => x.code), x: v.exclusions }));
  }
  const reg = new Map((JSON.parse(readFileSync(path.join(here, "..", "..", "graph", "curated", "facts.json"), "utf8")).facts as Array<{ name: string; type: string }>).map((f) => [f.name, f.type]));
  const OP_FOR: Record<string, string[]> = { bool: ["true"], list: ["nonempty"], polygon: ["nonempty"], enum: ["in"], quantity: ["in", "count>0"], count: ["count>0", "in"] };
  const bad = Object.entries(CURATED_PROVISION_TRIGGER_GUARDS).flatMap(([pid, gs]) => gs.filter((g) => !reg.has(g.fact) || !(OP_FOR[reg.get(g.fact)!] ?? []).includes(g.op)).map((g) => `${pid}: ${g.fact} ${g.op} (${reg.get(g.fact)})`));
  check("R2.B2b every curated trigger names a registered fact and its op fits the fact's type (AG4)", bad.length === 0, JSON.stringify(bad));

  // L45: the corrected Portland ADU-allowed gate (house or manufactured home, R20 through R2.5)
  const b1aIdx = (k: any) => excl(fullIndex, k, "PDX.33.205.020.B.1.a");
  for (const z of ["R5", "R2.5", "R10"]) {
    const v = await b1aIdx(zoned(S1, z));
    check(`L45.${z} a house in ${z}: the gate's scope holds, so it cannot be excluded`, v.exclusions.length === 0 && v.repairs.some((r) => /'known_true'/.test(r.message)), JSON.stringify(v.repairs.map((r) => r.message.slice(0, 120))));
  }
  const noHouse = structuredClone(S1); delete noHouse.site.house_outline; noHouse.unknowns = [...(noHouse.unknowns ?? []), { fact: "site.house_outline", reason: "planted" }];
  const vNo = await b1aIdx(noHouse);
  check("L45.unknown house: the gate is not ruled out (unknown never rules a rule out)", vNo.exclusions.length === 0, JSON.stringify(vNo.exclusions));

  // M6: only an inert_for disposition excuses a reading
  const e = entryOf(PID);
  const fams = new Map<string, RuleFamilyType>((await reader.readRuleFamily({ provision_ids: [PID], as_of: "2026-11-15" })).map((f) => [f.provision_id, f]));
  const f0 = structuredClone(fams.get(PID)!); const sc = f0.clauses.find((c) => c.clause_id === e.scope.scope_clause_id)!;
  sc.disposition = { kind: "needs_fact", fact: "site.alley", reason: "planted", by: "Martin Fabbri", date: "2026-11-03" } as any;
  const evR = C.LotFitEvent.parse({ id: makeUuid7(), thread_id: makeUuid7(), session_id: null, turn_id: makeUuid7(), seq: 1, created_at: new Date().toISOString(),
    config_hash: CONFIG, graph_load_id: fullIndex.graph_load_id, type: "lotfit.exclusion_recorded",
    data: { provision_id: PID, basis: "planner_reading", guard_call_id: null, guard_result: null, through: null, scope_clause_id: e.scope.scope_clause_id, scope_quote: e.scope.scope_quote } });
  const jm = plannerReadingsUnchecked([evR], () => e.evaluation_stage, new Map([[PID, f0]]), "detached_adu");
  // B5: a provision with no instrument (rules = null) takes no measuring call as evidence
  const walk = { call_id: makeUuid7(), tool: "check_max", provision_id: "EUG.9.2751.17.b.2", target: "case", ok: true, args: {},
    result: { value: 15, unit: "ft", limit: { provision_id: "EUG.9.2751.17.b.4.a.slope", param: "max_height", value: 25, unit: "ft" }, margin: 10, tolerance: 0, pass: true, too_close_to_call: false, dimension_to_tape: null } };
  const o5 = computeFindingOutcome([walk], "EUG.9.2751.17.b.2", "case", null);
  check("R2.B5 an uninstrumented rule (walkway 17.b.2) does not pass on a height check tagged to it", o5.outcome === null, JSON.stringify(o5));
  // AG3: unsettled facts, and facts computed from them, are not known on any guard path
  const kg = structuredClone(EUG); kg.site.lot_area_sqft = 6425.42; // as materialised from the (unconfirmed) lot outline
  const gfa = buildGuardFacts(kg);
  check("AG3.1 an unconfirmed lot outline leaves it, and the lot area computed from it, unknown to guards", gfa["site.lot_outline"] === null && gfa["site.lot_area_sqft"] === null,
    JSON.stringify({ outline: gfa["site.lot_outline"] === null, area: gfa["site.lot_area_sqft"] }));
  check("AG3.2 a fact on record (site.zone, an official record) stays known", gfa["site.zone"] === "R-1");
  // AG 4b: only the ADU row of Table 110-2 is evidence for B.1.a
  const pr = loadProvisionRules("R5").get("PDX.33.205.020.B.1.a");
  const allowed = (use: string) => ({ call_id: makeUuid7(), tool: "check_allowed", provision_id: "PDX.T110-2", target: "case", ok: true,
    args: { provision_id: "PDX.T110-2", use, zone: { fact: "site.zone" } }, result: { pass: true, allowed: true, cell: `${use}.R5` } });
  const oHouse = computeFindingOutcome([allowed("house")], "PDX.33.205.020.B.1.a", "case", pr);
  const oAdu = computeFindingOutcome([allowed("accessory_dwelling_unit_see_chapter_33_205")], "PDX.33.205.020.B.1.a", "case", pr);
  check("AG4b.1 the house row of Table 110-2 is not evidence for the ADU gate", oHouse.outcome !== "pass", JSON.stringify(oHouse));
  check("AG4b.2 the ADU row is", oAdu.outcome === "pass", JSON.stringify(oAdu));
  // AG r2 R2-5, R2-7: Eugene's size cap is a plan constraint, its composite limit verifies, R-1 is single-dwelling
  const e171 = eIdx.layers.flatMap((l) => l.provisions).find((p) => p.provision_id === "EUG.9.2751.17.a.1");
  check("AG-R2-5.1 Eugene 17.a.1 (10 % of lot area or 800 sq ft) is a plan constraint", e171?.evaluation_stage === "plan_constraint", String(e171?.evaluation_stage));
  const rp = [{ provision_id: "EUG.9.2751.17.a.1", param: "max_share_of_lot_area", value: 10, unit: "%" }, { provision_id: "EUG.9.2751.17.a.1", param: "max_building_sqft", value: 800, unit: "sqft" }];
  const lim = (v: number) => ({ provision_id: "EUG.9.2751.17.a.1", param: "max_sqft = min(max_share_of_lot_area × primary, max_building_sqft)", value: v, unit: "sqft" });
  const okL = (checkLimitAgainstResolvedParams as any)(lim(642.542), rp, { "site.lot_area_sqft": 6425.42 });
  const badL = (checkLimitAgainstResolvedParams as any)(lim(800), rp, { "site.lot_area_sqft": 6425.42 });
  check("AG-R2-5.2 V7 accepts Eugene's composite limit (10 % of the 6,425 sq ft lot = 642.5) and refuses 800", okL?.ok === true && badL?.ok === false, JSON.stringify({ okL, badL }));
  const kz = structuredClone(EUG); delete kz.site.zone_family; materializeComputedFacts(kz);
  check("AG-R2-7 Eugene R-1 materialises zone_family single_dwelling", (kz.site.zone_family?.value ?? kz.site.zone_family) === "single_dwelling", JSON.stringify(kz.site.zone_family));
  check("R2.M6 a needs_fact disposition does not excuse a reading (only inert_for does)", jm.unchecked.length === 1 && jm.relied.length === 0);

  // B7: Eugene scope sentences match their clause after whitespace normalisation
  // A guessed scope is right only when the graph states none; every provision with an applies_to/zones quote is stated.
  const g = JSON.parse(readFileSync(path.join(here, "..", "..", "graph", "out", "graph-or.json"), "utf8"));
  const hasLead = new Set((g.provisions as any[]).filter((p) => { const v = p.versions.at(-1); return !!(v.applies_to_quote || v.zones_quote); }).map((p) => p.id));
  const wrong = eIdx.layers.flatMap((l) => l.provisions).filter((p) => hasLead.has(p.provision_id) && p.scope.basis === "guessed").map((p) => p.provision_id);
  check("R2.B7 no Eugene provision with a stated scope quote is marked guessed (whitespace normalised)", wrong.length === 0 && hasLead.size > 0, JSON.stringify(wrong));
}

// ---- Step 3 (Rulebook): EUG.9.2775.5.e.1.a now carries its own scope sentence and the flag-lot guard, so on Martin's lot
// (not a flag lot, known) the exclusion is computed, not the Planner's reading. Before: scope = the rule's command, no
// guard on the case → planner_reading (the panel's finding A1/S1).
{
  const EUG = JSON.parse(readFileSync(path.join(here, "..", "cases", "eug-demo-16x36.json"), "utf8"));
  const eIdx = await reader.readLayerIndex({ city_layer: "EUG", as_of: EUG.as_of?.date ?? "2026-11-15" });
  const e = eIdx.layers.flatMap((l) => l.provisions).find((p) => p.provision_id === "EUG.9.2775.5.e.1.a");
  check("S3.1 e.1.a's index scope sentence is the flag-lot heading, not the command",
    e?.scope.scope_quote === "Additional Standards for Accessory Dwellings on Flag Lots", JSON.stringify(e?.scope));
  if (e) {
    const index = { ...eIdx, layers: [{ layer: e.layer, order: 1, provisions: [e] }] };
    const plan = { index_hash: eIdx.index_hash, applies: [], excluded_at_index: [{ provision_id: e.provision_id, scope_quote: e.scope.scope_quote }], order: [] };
    const asFlag = (v: boolean | "unknown") => { const k = structuredClone(EUG);
      if (v === "unknown") { delete k.site.flag_lot; k.unknowns = [...(k.unknowns ?? []), { fact: "site.flag_lot", reason: "planted" }]; } else k.site.flag_lot.value = v; return k; };
    const a = await validatePlanAgainstIndex(plan, index, asFlag(false), reader, new Map(), CONFIG);
    check("S3.2 Martin's lot (flag_lot = false, known) → exclusion computed_known_false",
      a.repairs.length === 0 && a.exclusions[0]?.basis === "computed_known_false", JSON.stringify({ r: a.repairs, ex: a.exclusions }));
    const b = await validatePlanAgainstIndex(plan, index, asFlag(true), reader, new Map(), CONFIG);
    check("S3.3 a flag lot → the exclusion is refused", b.repairs.some((r) => r.code === "PLAN_FORBIDDEN_EXCLUSION"), JSON.stringify({ r: b.repairs, ex: b.exclusions }));
    const c = await validatePlanAgainstIndex(plan, index, asFlag("unknown"), reader, new Map(), CONFIG);
    check("S3.4 flag_lot unknown → the Planner's reading, never computed", c.exclusions[0]?.basis === "planner_reading", JSON.stringify({ r: c.repairs, ex: c.exclusions }));
  }
}

// ---- P2: the contract carries the new event and the verdict reasons
{
  const base = { id: makeUuid7(), thread_id: makeUuid7(), session_id: null, turn_id: makeUuid7(), seq: 1, created_at: new Date().toISOString(), config_hash: CONFIG, graph_load_id: "x" };
  const good = { ...base, type: "lotfit.exclusion_recorded", data: { provision_id: PID, basis: "planner_reading", guard_call_id: null, guard_result: "unknown", through: null, scope_clause_id: "PDX.x#v1::sentence:1", scope_quote: "q" } };
  check("P2.1 lotfit.exclusion_recorded parses", C.LotFitEvent.safeParse(good).success);
  check("P2.2 an unknown basis is refused", !C.LotFitEvent.safeParse({ ...good, data: { ...good.data, basis: "assumed" } }).success);
  const vc = { ...base, type: "lotfit.verdict_computed", data: { entailed: "NEEDS_CHECK", proposed: null, agree: false, abnormal_end: false } };
  const parsed = C.LotFitEvent.safeParse(vc);
  check("P2.3 verdict_computed without reasons still parses (recorded runs), defaulting to []",
    parsed.success && Array.isArray((parsed.data as any).data.reasons) && (parsed.data as any).data.reasons.length === 0);
  const [maj, min] = String(C.CONTRACTS_VERSION).split(".").map(Number);
  check("P2.4 contracts version is 1.4.0 or later (additive)", maj === 1 && (min ?? 0) >= 4, C.CONTRACTS_VERSION);
}

// ---- P3: the slope operator is partial; a pass on it alone is unknown
{
  const rules = loadProvisionRules("R-1");
  const r = rules.get("EUG.9.2751.17.b.4.a.slope");
  check("P3.1 operators.json marks the slope operator partial", !!r?.partial?.length, JSON.stringify(r?.partial));
  const call = { call_id: makeUuid7(), tool: "check_max", provision_id: "EUG.9.2751.17.b.4.a.slope", target: "case", ok: true,
    args: {}, result: { value: 15, unit: "ft", limit: { provision_id: "EUG.9.2751.17.b.4.a.slope", param: "max_height", value: 25, unit: "ft" },
      margin: 10, tolerance: 0, pass: true, too_close_to_call: false, dimension_to_tape: null } };
  const o = computeFindingOutcome([call], "EUG.9.2751.17.b.4.a.slope", "case", r);
  check("P3.2 height 15 ft under the 25-ft cap → unknown (not pass), naming the sloped plane", o.outcome === "unknown" && /sloped/.test(o.reason), JSON.stringify(o));
  const fail = { ...call, call_id: makeUuid7(), result: { ...call.result, value: 30, margin: -5, pass: false } };
  const o2 = computeFindingOutcome([fail], "EUG.9.2751.17.b.4.a.slope", "case", r);
  check("P3.3 a failed cap still fails (partial never softens a fail)", o2.outcome === "fail", JSON.stringify(o2));
  const pdx = loadProvisionRules("R5");
  check("P3.4 no Portland operator is marked partial (Suite B unaffected)", ![...pdx.entries()].some(([k, v]) => k.startsWith("PDX.") && v.partial?.length));
  // Build-review S1 (blocker) and A8: the verifier and the Judge agree on a partial operator, and a cure does not lift it.
  check("P3.5 V3: a passing partial check entails unknown, not pass", combineCitedOutcome([call.result], [], false, "unknown", true).outcome === "unknown"
    && combineCitedOutcome([call.result], [], false, "pass", false).outcome === "pass");
  const cure = { call_id: makeUuid7(), tool: "check_exception_conditions", provision_id: "EUG.9.2751.17.b.4.a.slope", target: "case", ok: true, args: {},
    result: { exception_id: "EUG.x", base_provision_id: "EUG.9.2751.17.b.4.a.slope", pass: true, conditions: [] } };
  const o3 = computeFindingOutcome([fail, cure], "EUG.9.2751.17.b.4.a.slope", "case", r);
  check("P3.6 a failed partial check cured by an exception is unknown, not pass (A8)", o3.outcome === "unknown", JSON.stringify(o3));
  const tr = (type: string, data: unknown) => ({ id: makeUuid7(), thread_id: makeUuid7(), session_id: null, turn_id: makeUuid7(), seq: 1, created_at: new Date().toISOString(), config_hash: CONFIG, graph_load_id: "x", type, data });
  const events = [tr("tool_requested", { call: { call_id: call.call_id, turn_id: makeUuid7(), provision_id: call.provision_id, target: "case", tool: "check_max", args: {} } }),
    tr("tool_result", { call_id: call.call_id, ok: true, cached: false, preview: JSON.stringify(call.result), duration_ms: 1, result: call.result })];
  let v3: unknown[] = [];
  try {
    const out = verify({ index: { layers: [] }, guards: {}, events, resolved_params: [], case_facts: {},
      report: { findings: [{ provision_id: call.provision_id, target: "case", outcome: "unknown", evaluation_stage: "placement_constraint", citations: [], params: [],
        measures: [call.result], confirmation: "confirmed", evidence_call_ids: [call.call_id] }], placement: { client_spot: null, recommended: null, search: null },
        verdict: "NEEDS_CHECK", model_verdict: "NEEDS_CHECK", unchecked: [] } } as any);
    v3 = out.issues.filter((i: any) => i.code === "V3_OUTCOME" && i.provision_id === call.provision_id);
  } catch (e) { v3 = [String(e)]; }
  check("P3.7 verify(): an unknown finding on the partial slope check, citing a passing call, raises no V3_OUTCOME (S1)", v3.length === 0, JSON.stringify(v3).slice(0, 300));
}

await reader.close?.();
console.log(`${ok}/${n} reviewer-precondition checks passed`);
process.exit(ok === n ? 0 : 1);
