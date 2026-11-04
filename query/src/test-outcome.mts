// Planted-error tests for code-decided outcomes (outcome.mts). The headline case is the live S1 cherry-pick: a side
// setback "pass" citing only the passing front-line check while the side-line check failed. CC, 2026-11-02.
import { computeFindingOutcome, loadProvisionRules, type CallRecord } from "./outcome.mts";

let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };
const m = (pass: boolean | null, margin: number, extra: Record<string, unknown> = {}) =>
  ({ value: 0, unit: "ft", limit: { provision_id: "PDX.T110-4", param: "side_building_setback.R5", value: 5, unit: "ft" }, margin, tolerance: 0.5, pass, too_close_to_call: pass === null, dimension_to_tape: null, ...extra });
const call = (id: string, tool: string, pid: string | null, target: string, result: unknown, okv = true): CallRecord => ({ call_id: id, tool, provision_id: pid, target, ok: okv, result });

const front = call("c-front", "check_setback", "PDX.33.110.220.B", "client_spot", { ...m(true, 64), limit: { provision_id: "PDX.T110-4", param: "front_building_setback.R5", value: 10, unit: "ft" } });
const side = call("c-side", "check_setback", "PDX.33.110.220.B", "client_spot", m(false, -3));

// 1. The cherry-pick: the model would cite only c-front; code reads both.
const r1 = computeFindingOutcome([front, side], "PDX.33.110.220.B", "client_spot");
ok("cherry-picked pass becomes fail (side line failed)", r1.outcome === "fail" && r1.evidence_call_ids.includes("c-side"), JSON.stringify(r1));

// 2. A failing check tagged to another provision but whose limit is T110-4's parameter counts for T110-4.
const borrowed = call("c-borrow", "check_setback", "PDX.33.205.040.C.3", "client_spot", m(false, -3));
ok("a failing T110-4 limit used under another provision still fails T110-4",
  computeFindingOutcome([borrowed], "PDX.T110-4", "client_spot").outcome === "fail");

// 3. A passing exception cures the failed base rule at the same target.
const exc = call("c-exc", "check_exception_conditions", "PDX.33.110.245.C.2", "client_spot", { exception_id: "PDX.33.110.245.C.2", base_provision_id: "PDX.33.110.220.B", pass: true, conditions: [] });
const r3 = computeFindingOutcome([front, side, exc], "PDX.33.110.220.B", "client_spot");
ok("a passing exception cures the failed base rule", r3.outcome === "pass" && r3.evidence_call_ids.includes("c-exc"), JSON.stringify(r3));

// 4. A failed exception does not cure.
const excNo = call("c-exc2", "check_exception_conditions", "PDX.33.110.245.C.2", "client_spot", { exception_id: "PDX.33.110.245.C.2", base_provision_id: "PDX.33.110.220.B", pass: false, conditions: [] });
ok("a failed exception does not cure", computeFindingOutcome([front, side, excNo], "PDX.33.110.220.B", "client_spot").outcome === "fail");

// 5. Targets do not mix: a failure at the client spot says nothing about the selected placement.
const selOk = call("c-sel", "check_setback", "PDX.33.110.220.B", "selected_placement", m(true, 1));
ok("results at another target are ignored", computeFindingOutcome([side, selOk], "PDX.33.110.220.B", "selected_placement").outcome === "pass");

// 6. Too close to call wins over pass.
const tcc = call("c-tcc", "check_setback", "PDX.33.110.220.B", "client_spot", m(null, 0.15, { too_close_to_call: true, dimension_to_tape: "rear line" }));
ok("a margin inside tolerance → too_close_to_call", computeFindingOutcome([front, tcc], "PDX.33.110.220.B", "client_spot").outcome === "too_close_to_call");

// 7. Guard known false and nothing else → not_applicable; guards only → no outcome (the check must still run).
const gF = call("c-g", "evaluate_guards", "PDX.11.50.020", "case", { provision_id: "PDX.11.50.020", result: "known_false", guards: [] });
const gU = call("c-gu", "evaluate_guards", "PDX.T110-2", "case", { provision_id: "PDX.T110-2", result: "unknown", guards: [] });
ok("guard known false → not_applicable", computeFindingOutcome([gF], "PDX.11.50.020", "case").outcome === "not_applicable");
ok("guard unknown alone → no outcome (run the check)", computeFindingOutcome([gU], "PDX.T110-2", "case").outcome === null);

// 8. Failed calls and no calls give no outcome.
ok("a failed call is not evidence", computeFindingOutcome([call("c-x", "check_setback", "PDX.33.110.220.B", "client_spot", m(true, 3), false)], "PDX.33.110.220.B", "client_spot").outcome === null);

// ---- Measure 2: required checks from graph/curated/operators.json (S7: flag-lot "pass" proven with physical_fit)
const rules = loadProvisionRules("R5");
const flag = rules.get("PDX.33.110.255.B.1.a");
ok("operators.json gives the flag-lot rule three required line checks at 10 ft (R5)",
  !!flag && flag.requires.length === 3 && flag.requires.every((r) => r.param === "PDX.33.110.255.B.1.a:setback.R5"), JSON.stringify(flag?.requires));
const fit = call("c-fit", "physical_fit", "PDX.33.110.255.B.1.a", "client_spot", { inside_lot: true, overlaps: [], pass: true });
const dist = call("c-dist", "distance_to_line", "PDX.33.110.255.B.1.a", "client_spot", { value: 70, pass: true });
ok("physical_fit / distance_to_line are not evidence for a setback rule",
  computeFindingOutcome([fit, dist], "PDX.33.110.255.B.1.a", "client_spot", flag).outcome === null);
const fl = (id: string, fact: string, pass: boolean, margin: number): CallRecord => ({ ...call(id, "check_setback", "PDX.33.110.255.B.1.a", "client_spot",
  { ...m(pass, margin), limit: { provision_id: "PDX.33.110.255.B.1.a", param: "setback.R5", value: 10, unit: "ft" } }), args: { lines: { fact } } });
const r9 = computeFindingOutcome([fl("f1", "site.front_lot_line", true, 60), fl("f2", "site.side_lot_lines", true, 2)], "PDX.33.110.255.B.1.a", "client_spot", flag);
ok("a pass with the rear-line check missing is not a pass (names the missing check)", r9.outcome === null && (r9.missing ?? []).length === 1, JSON.stringify(r9));
const r10 = computeFindingOutcome([fl("f1", "site.front_lot_line", true, 60), fl("f2", "site.side_lot_lines", true, 2), fl("f3", "site.rear_lot_line", false, -4)], "PDX.33.110.255.B.1.a", "client_spot", flag);
ok("the S7 client spot fails the 10 ft flag-lot setback on the rear line", r10.outcome === "fail" && r10.evidence_call_ids.includes("f3"));
const r11 = computeFindingOutcome([fl("f1", "site.front_lot_line", true, 60), fl("f2", "site.side_lot_lines", true, 2), fl("f3", "site.rear_lot_line", true, 1)], "PDX.33.110.255.B.1.a", "client_spot", flag);
ok("all three line checks passing at 10 ft → pass", r11.outcome === "pass");
const base = rules.get("PDX.33.110.220.B");
const wrongParam = { ...call("w1", "check_setback", "PDX.33.110.220.B", "client_spot", { ...m(true, 3), limit: { provision_id: "PDX.T110-4", param: "front_building_setback.R5", value: 10, unit: "ft" } }), args: { lines: { fact: "site.side_lot_lines" } } };
ok("a side-line check run against the FRONT setback number does not satisfy the side requirement",
  computeFindingOutcome([wrongParam], "PDX.33.110.220.B", "client_spot", base).outcome === null);

console.log(`${n}/${t} outcome checks passed`);
process.exit(n === t ? 0 : 1);
