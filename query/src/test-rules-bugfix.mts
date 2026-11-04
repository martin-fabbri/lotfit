// Planted-error tests for the rules-as-data panel's live bugs B1–B4 (2026-11-02). Each test fails on the code before
// the fix. Report: factory/private/rooms/lotfit/RULES-BUGFIX-2026-11-02.md. CC.
import { readFileSync } from "node:fs";
import { clauseCoverage, exclusionProtection, uncuredFailures } from "./harness.mts";
import { combineCitedOutcome } from "./verifier.mts";
import { coverageCellFor } from "./sensitivity.mts";
import { loadOperatorCovers, loadRelaxingExceptionProvisions } from "./outcome.mts";
import { computeFindingOutcome, loadProvisionRules, type CallRecord } from "./outcome.mts";

let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };
const rules = loadProvisionRules("R5");

// B1 — the allowed-use gate cannot be excluded by quoting its title
const t1102 = { provision_id: "PDX.T110-2", evaluation_stage: "gate", has_operator: false, modifies_operator_backed: false };
const t1104 = { provision_id: "PDX.T110-4", evaluation_stage: "placement_constraint", has_operator: true, modifies_operator_backed: false };
ok("B1 Table 110-2 (gate) is protected even when other gates apply",
  exclusionProtection(t1102, new Set(["PDX.33.205.020.B.1.a"]), rules).isProtected === true);
const via = exclusionProtection(t1104, new Set(["PDX.33.110.220.B"]), rules);
ok("B1 Table 110-4 may be excluded when 220.B applies, recorded as evaluated through 220.B",
  via.isProtected === false && via.through === "PDX.33.110.220.B", JSON.stringify(via));
ok("B1 Table 110-4 is protected when 220.B is not applied", exclusionProtection(t1104, new Set(), rules).isProtected === true);
const src = readFileSync(new URL("./harness.mts", import.meta.url), "utf8");
ok("B1 no exclusion record claims a computed plan.kind fact", !/fact: "plan\.kind",\s*value: facts\["plan\.kind"\]/.test(src));

// B2 — a passing exception cures only its own base rule (and its operator siblings)
const failing = ["PDX.T110-4", "PDX.33.205.040.C.2", "PDX.33.110.245.C.3.a"];
const left = uncuredFailures(failing, ["PDX.33.110.220.B"], rules);
ok("B2 the 245.C.2 cure (base 220.B) clears Table 110-4's side/rear margins only",
  JSON.stringify(left) === JSON.stringify(["PDX.33.205.040.C.2", "PDX.33.110.245.C.3.a"]), JSON.stringify(left));
ok("B2 with no passing exception nothing is cured", uncuredFailures(failing, [], rules).length === 3);

// B3 — a failed base rule whose exception is unknown is unknown, not fail
const call = (id: string, tool: string, pid: string | null, result: unknown): CallRecord => ({ call_id: id, tool, provision_id: pid, target: "client_spot", ok: true, result });
const side = call("c-side", "check_setback", "PDX.33.110.220.B", { value: 2, unit: "ft", limit: { provision_id: "PDX.T110-4", param: "side_building_setback.R5", value: 5, unit: "ft" }, margin: -3, tolerance: 0.5, pass: false, too_close_to_call: false, dimension_to_tape: null });
const excUnknown = call("c-exc", "check_exception_conditions", "PDX.33.110.245.C.2", { exception_id: "PDX.33.110.245.C.2", base_provision_id: "PDX.33.110.220.B", pass: null, conditions: [] });
const r3 = computeFindingOutcome([side, excUnknown], "PDX.33.110.220.B", "client_spot");
ok("B3 fail + unknown exception → unknown, naming the exception", r3.outcome === "unknown" && r3.evidence_call_ids.includes("c-exc") && /245\.C\.2/.test(r3.reason), JSON.stringify(r3));
ok("B3 fail + no exception → still fail", computeFindingOutcome([side], "PDX.33.110.220.B", "client_spot").outcome === "fail");

// B4 — an unknown zone is never assumed to be R5
ok("B4 no '?? \"R5\"' default for site.zone remains", !/"site\.zone"\)\s*\?\?\s*"R5"/.test(src));
const unknownZone = loadProvisionRules("unknown").get("PDX.33.110.220.B")?.requires.map((r) => r.param) ?? [];
ok("B4 with no zone the required setback parameters cannot resolve to a zone's value", unknownZone.length > 0 && unknownZone.every((p) => !p || p.endsWith(".unknown")), JSON.stringify(unknownZone));

// L40 — a not-modeled clause an operator's tool evaluated in this run is covered, not unchecked
const covers = loadOperatorCovers();
const fob = { tool: "check_front_or_behind", provision_id: "PDX.33.205.040.C.2", ok: true, result: { pass: true, margin_ft: 3 }, call_id: "c-fob" };
ok("L40 C.2 item b is covered when check_front_or_behind ran on C.2", clauseCoverage(["PDX.33.205.040.C.2"], covers, [fob]).has("item:b."));
ok("L40 not covered when the check did not run", !clauseCoverage(["PDX.33.205.040.C.2"], covers, []).has("item:b."));
ok("L40 not covered when the provision is not applied", !clauseCoverage([], covers, [fob]).has("item:b."));
ok("L40 not covered by a failed call", !clauseCoverage(["PDX.33.205.040.C.2"], covers, [{ ...fob, ok: false }]).has("item:b."));
ok("L40 a failing check still covers the clause (the finding carries the fail)", clauseCoverage(["PDX.33.205.040.C.2"], covers, [{ ...fob, result: { pass: false } }]).has("item:b."));
const exc = { tool: "check_exception_conditions", provision_id: "PDX.33.110.245.C.2", ok: true, result: { pass: null }, call_id: "c-ex" };
ok("L40 245.C.2 b.(5) and its 'unless' are covered by the exception check", ["item:b.(5)", "condition:b.(5)/unless#1", "condition:b.(2)/excluding#1"].every((c) => clauseCoverage(["PDX.33.110.245.C.2"], covers, [exc]).has(c)));
ok("L40 sources: harness passes coverage to every unchecked count", (src.match(/clauseCoverage\(/g) ?? []).length >= 4);

// B6 — null means two things: too close (a measurement in tolerance) vs unknown (an exception or unknown input)
const tcc = { value: 4.9, limit: { provision_id: "PDX.T110-4", param: "x", value: 5, unit: "ft" }, margin: -0.1, tolerance: 0.5, pass: null, too_close_to_call: true };
const unk = { ...tcc, too_close_to_call: false };
const excNull = { exception_id: "PDX.33.110.245.C.2", base_provision_id: "PDX.33.110.220.B", pass: null, conditions: [{ clause_id: "x", name: "y", holds: null, measure: null }] };
const failM = { ...tcc, pass: false, too_close_to_call: false, margin: -3 };
ok("B6 a measurement inside tolerance → too_close_to_call", combineCitedOutcome([tcc], [], false, "too_close_to_call").outcome === "too_close_to_call");
ok("B6 a measurement with an unknown input → unknown", combineCitedOutcome([unk], [], false, "unknown").outcome === "unknown");
ok("B6 an exception with unknown conditions → unknown, not too_close", combineCitedOutcome([excNull], [], false, "unknown").outcome === "unknown");
ok("B6+B3 a failed check with an unknown exception → unknown (matches the Judge)", combineCitedOutcome([failM, excNull], [], false, "unknown").outcome === "unknown");
ok("B6 a failed check alone → fail", combineCitedOutcome([failM], [], false, "fail").outcome === "fail");

// B9 — Table 110-5's row comes from the graph, at every bracket boundary
const rows = [2999, 3000, 4999, 5000, 19999, 20000].map((a) => coverageCellFor(a, "2026-11-15"));
ok("B9 brackets change exactly at 3,000, 5,000 and 20,000 sq ft", rows[0]!.cell_id !== rows[1]!.cell_id && rows[1]!.cell_id === rows[2]!.cell_id && rows[3]!.cell_id !== rows[2]!.cell_id && rows[4]!.cell_id !== rows[5]!.cell_id, JSON.stringify(rows.map((r) => r.cell_id)));
ok("B9 the cell text is the graph's (no hard-coded copy left)", rows[3]!.cell.includes("15% of lot area over 5,000") && !/cell_id: "T110-5:R3"/.test(readFileSync(new URL("./sensitivity.mts", import.meta.url), "utf8")));

// B5 — the search honours front-or-behind, and NO_LEGS is not entailed while a relaxing exception is open
ok("B5 245.C.2 is a relaxing exception", loadRelaxingExceptionProvisions().has("PDX.33.110.245.C.2"));
ok("B5 sources: the harness passes front_or_behind to find_placements and guards NO_LEGS", /front_or_behind: frontOrBehind/.test(src) && /may relax the setbacks/.test(src));

console.log(`\n${n}/${t} rules-bugfix checks passed`);
process.exit(n === t ? 0 : 1);
