// Judge coverage (handout step 4): outcome boundaries at zero and at the tolerance edge, every eval
// mutant refused with its own V-code from the files on disk, sensitivity determinism, and contract
// parses for all three. No Aura needed. Muse, 2026-11-04.
import { readFileSync } from "node:fs";
import { computeFindingOutcome, type CallRecord } from "./outcome.mts";
import { verify, type VerifyInput } from "./verifier.mts";
import { runSensitivityWithQuestions } from "./sensitivity.mts";
import * as C from "./types.mts";

let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };

const readJson = (rel: string): any => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const m = (pass: boolean | null, margin: number, tolerance: number, extra: Record<string, unknown> = {}) =>
  ({ value: 0, unit: "ft", limit: { provision_id: "PDX.T110-4", param: "side_building_setback.R5", value: 5, unit: "ft" },
    margin, tolerance, pass, too_close_to_call: pass === null, dimension_to_tape: null, ...extra });
const call = (id: string, result: unknown): CallRecord =>
  ({ call_id: id, tool: "check_setback", provision_id: "PDX.33.110.220.B", target: "client_spot", ok: true, result });

const outcomes: unknown[] = [];
const r0 = computeFindingOutcome([call("c-zero", m(true, 0, 0))], "PDX.33.110.220.B", "client_spot");
outcomes.push(r0.outcome);
ok("outcome: a margin exactly 0 with tolerance 0 passes", r0.outcome === "pass", JSON.stringify(r0));

const rPlus = computeFindingOutcome([call("c-plus", m(null, 0.15, 0.5))], "PDX.33.110.220.B", "client_spot");
const rMinus = computeFindingOutcome([call("c-minus", m(null, -0.15, 0.5))], "PDX.33.110.220.B", "client_spot");
outcomes.push(rPlus.outcome, rMinus.outcome);
ok("outcome: a margin inside ±tolerance is too_close_to_call, never pass or fail",
  rPlus.outcome === "too_close_to_call" && rMinus.outcome === "too_close_to_call",
  `${rPlus.outcome} / ${rMinus.outcome}`);

const rNeg = computeFindingOutcome([call("c-neg", m(false, -3, 0.5))], "PDX.33.110.220.B", "client_spot");
outcomes.push(rNeg.outcome);
ok("outcome: a negative margin beyond tolerance fails", rNeg.outcome === "fail", JSON.stringify(rNeg));

const mutants: [string, string][] = [
  ["m1-v1-coverage.json", "V1_COVERAGE"],
  ["m2-v2-evidence.json", "V2_EVIDENCE"],
  ["m3-v3-outcome.json", "V3_OUTCOME"],
  ["m4-v4-number.json", "V4_NUMBER"],
  ["m5-v5-verdict.json", "V5_VERDICT"],
  ["m6-v7-parameter.json", "V7_PARAMETER"],
  ["m7-v8-guard.json", "V8_GUARD"],
];
const allIssues: unknown[] = [];
for (const [file, code] of mutants) {
  const input = readJson(`../eval/mutants/${file}`) as VerifyInput;
  const res = verify(input);
  allIssues.push(...res.issues);
  ok(`verifier: ${file} is refused with ${code}`,
    res.passed === false && res.issues.some((i) => i.code === code),
    `passed=${res.passed} codes=${JSON.stringify(res.issues.map((i) => i.code))}`);
}
const clean = readJson("../eval/mutants/s1-clean.json") as VerifyInput;
const rc = verify(clean);
ok("verifier: s1-clean.json passes with no issue", rc.passed === true && rc.issues.length === 0,
  `passed=${rc.passed} issues=${rc.issues.length}`);

const s1Case = C.Case.parse(readJson("../cases/s1.json"));
const sensInput = {
  case: s1Case,
  findings: clean.report.findings,
  plan: clean.plan,
  selected_placement: clean.report.placement.recommended?.placement ?? null,
};
const s1a = runSensitivityWithQuestions(sensInput);
const s1b = runSensitivityWithQuestions(sensInput);
const aBytes = JSON.stringify(s1a), bBytes = JSON.stringify(s1b);
ok("sensitivity is deterministic: same case and report give byte-identical output twice",
  aBytes === bBytes, `${aBytes.length} vs ${bBytes.length} bytes`);

ok("every outcome parses as its contract (C.Outcome)",
  outcomes.every((o) => o !== null && C.Outcome.safeParse(o).success));
ok(`every verifier issue (${allIssues.length}) parses as C.RepairError`,
  allIssues.length > 0 && allIssues.every((i) => C.RepairError.safeParse(i).success));
ok("sensitivity, branches and questions parse as C5 contracts",
  C.Sensitivity.safeParse(s1a.sensitivity).success &&
  s1a.sensitivity.branches.every((b) => C.Branch.safeParse(b).success) &&
  C.QuestionSet.safeParse(s1a.questions).success);

console.log(`${n}/${t} checks passed`);
process.exit(n === t ? 0 : 1);
