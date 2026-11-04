// Post-training data and scoring (no network): the builder keeps verifier-passed runs only,
// splits hold-out cases, never leaks banned text; the scorer grades plans and decisions by code.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildData, caseSummary } from "./build_data.mts";
import { extractJson, scorePlan, scoreDecision } from "./eval_plan.mts";

let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };

const here = path.dirname(fileURLToPath(import.meta.url));
const runs = path.join(here, "fixtures", "runs");

const { train, eval: evalRows, stats, stages } = buildData(runs, ["CASE-EVAL"]);
ok("only verified, non-martin, complete runs become rows",
  stats.runs === 4 && stats.verified === 2 && stats.trainRuns === 1 && stats.evalRuns === 1,
  JSON.stringify(stats));
ok("one plan plus one decision per provision",
  train.length === 4 && evalRows.length === 4 &&
  train.filter((r) => r.kind === "plan").length === 1 &&
  train.filter((r) => r.kind === "decision").length === 3);
ok("hold-out case stays out of train",
  train.every((r) => r.case_id === "CASE-TRAIN") && evalRows.every((r) => r.case_id === "CASE-EVAL"));
ok("rows are system/user/assistant chat turns",
  [...train, ...evalRows].every((r) => r.messages.map((m) => m.role).join(",") === "system,user,assistant"));
ok("case summary keeps facts, drops the rest",
  caseSummary(JSON.parse(readFileSync(path.join(runs, "run-train", "case.json"), "utf8"))) === "zone R5; lot 50 x 100 ft; slope 2 pct; plan detached adu; footprint 24 x 24 ft; height 15 ft; spot 2 ft from the left, 74 ft back",
  caseSummary(JSON.parse(readFileSync(path.join(runs, "run-train", "case.json"), "utf8"))));
ok("no banned text in any row",
  ![...train, ...evalRows].some((r) => /address|taxlot|tax_lot|parcel|owner|mailing|eug-martin/i.test(JSON.stringify(r.messages))));
ok("eval labels carry stages per case",
  stages["CASE-EVAL"]?.["P.2"] === "placement_constraint" && stages["CASE-TRAIN"] === undefined);

const want = {
  applies: [{ provision_id: "P.1" }, { provision_id: "P.2" }],
  excluded_at_index: [{ provision_id: "P.3" }],
};
const st = { "P.1": "gate", "P.2": "placement_constraint", "P.3": "plan_constraint" };
const perfect = scorePlan(JSON.parse(JSON.stringify(want)), want, st);
ok("exact plan scores valid with f1 1", perfect.valid && perfect.f1 === 1 && perfect.placeF1 === 1);
const partial = scorePlan({ applies: [{ provision_id: "P.1" }], excluded_at_index: [{ provision_id: "P.3" }] }, want, st);
ok("skipped placement rule fails validity and halves recall",
  !partial.valid && Math.abs(partial.f1 - 2 / 3) < 1e-9 && partial.placeF1 === 0, JSON.stringify(partial));
ok("garbage plan scores zero", scorePlan(extractJson("no json here"), want, st).f1 === 0);
ok("fenced json extracts", extractJson('```json\n{"a":1}\n```')?.a === 1);
ok("decisions score by code",
  scoreDecision({ decision: "applies" }, { decision: "applies" }).acc === 1 &&
  scoreDecision({ decision: "excluded" }, { decision: "applies" }).acc === 0 &&
  !scoreDecision({ no: "decision" }, { decision: "applies" }).valid);

console.log(`${n}/${t} post-training checks passed`);
process.exit(n === t ? 0 : 1);
