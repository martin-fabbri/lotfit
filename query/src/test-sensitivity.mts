/**
 * Verification suite for LotFit W5 — Deterministic Sensitivity & Question Generation (Milestone 1).
 *
 * Tests:
 *   1. S1 (`query/cases/s1.json` + `query/eval/mutants/s1-clean.json`):
 *      - `nominal_verdict === "FITS"`, no critical fact (`critical.length === 0`), zero questions.
 *   2. S3 (`query/cases/s3.json`):
 *      - `nominal_verdict === "FITS_IF"`, `plan.living_area_sqft` is critical across the two
 *        readings of `amb.living-area.sloped-ceiling` (`864 -> NO_LEGS`, `576 -> FITS`).
 *   3. S4 (`query/cases/s4.json`):
 *      - `nominal_verdict === "NEEDS_CHECK"`, `site.primary_living_area_sqft` is critical across
 *        its two conflicting observations (`1000 -> NO_LEGS`, `1400 -> FITS`), and `buildQuestions`
 *        produces 1 eligible `Question` (`C5_QuestionSet`).
 *   4. S5 (`query/cases/s5.json`):
 *      - `nominal_verdict === "NEEDS_CHECK"`, `site.rear_lot_line` is critical across `±1.6 ft`
 *        (`delta: -1.6` -> `client_spot_passes: false`, `delta: +1.6` -> `client_spot_passes: true`, `verdict: "FITS"`).
 *   5. Contract validation:
 *      - Every result parses against `C5_Sensitivity`, `C5_Branch`, and `C5_QuestionSet`, and
 *        every `ruleFamily(provision_id, as_of)` call parses against `C2_RuleFamily`.
 *   6. Scope (`COMPUTED_FROM⁻¹`), guard opening, and budget cap (`untested`):
 *      - Opening a guard on a guard-excluded provision with no operator (`site.trees = true` on `PDX.11.50.020`)
 *        produces branch finding `unknown` and branch verdict `NEEDS_CHECK`.
 *      - Values beyond the 16-value cap are recorded in `untested`.
 *   7. Zero model calls.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import {
  buildQuestions,
  computedFromInverseClosure,
  DEFAULT_PDX_ADU_PROVISIONS,
  ruleFamily,
  runSensitivity,
  runSensitivityWithQuestions,
  type CaseType,
} from "./sensitivity.mts";
import * as C from "./types.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUERY_DIR = path.resolve(__dirname, "..");
const CASES_DIR = path.resolve(QUERY_DIR, "cases");
const S1_CLEAN_PATH = path.resolve(QUERY_DIR, "eval", "mutants", "s1-clean.json");

let passed = 0;
let total = 0;

function assert(condition: boolean, name: string, detail?: string): void {
  total++;
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function loadCase(filename: string): CaseType {
  const raw = JSON.parse(readFileSync(path.resolve(CASES_DIR, filename), "utf8"));
  return C.Case.parse(raw);
}

console.log("=== LotFit W5: Deterministic Sensitivity & Questions Verification ===");

// ------------------------------------------------------------------
// 0. ruleFamily(provision_id, as_of) -> C2_RuleFamily
// ------------------------------------------------------------------
{
  let allParsed = true;
  for (const pid of DEFAULT_PDX_ADU_PROVISIONS) {
    const rf = ruleFamily(pid, "2026-11-15");
    const parsed = C.RuleFamily.safeParse(rf);
    if (!parsed.success) {
      allParsed = false;
    }
  }
  assert(
    allParsed,
    "0a. ruleFamily(provision_id, as_of) parses against C2_RuleFamily for all 10 PDX ADU provisions",
  );

  const closureLot = computedFromInverseClosure("site.lot_outline");
  const closureFront = computedFromInverseClosure("site.front_lot_line");
  const closureFootprint = computedFromInverseClosure("plan.footprint");
  assert(
    closureLot.has("site.lot_area_sqft") &&
      closureFront.has("site.house_rear_wall") &&
      closureFront.has("plan.setbacks_used") &&
      closureFootprint.has("plan.outline") &&
      closureFootprint.has("plan.setbacks_used"),
    "0b. COMPUTED_FROM⁻¹ closure includes transitive computed dependents from facts.json",
  );
}

// ------------------------------------------------------------------
// 1. S1: Nominal FITS, no critical fact, zero questions
// ------------------------------------------------------------------
{
  const s1Case = loadCase("s1.json");
  const s1Clean = JSON.parse(readFileSync(S1_CLEAN_PATH, "utf8")) as {
    plan: z.infer<typeof C.Plan>;
    report: z.infer<typeof C.Report>;
  };

  const { sensitivity: s1Sens, questions: s1Questions } = runSensitivityWithQuestions({
    case: s1Case,
    findings: s1Clean.report.findings,
    plan: s1Clean.plan,
    selected_placement: s1Clean.report.placement.recommended?.placement ?? null,
  });

  assert(
    C.Sensitivity.safeParse(s1Sens).success &&
      s1Sens.branches.every((b) => C.Branch.safeParse(b).success) &&
      C.QuestionSet.safeParse(s1Questions).success,
    "1a. S1 sensitivity, branches, and questions parse against C5_Sensitivity, C5_Branch, C5_QuestionSet",
  );
  assert(
    s1Sens.nominal_verdict === "FITS",
    "1b. S1 nominal_verdict is FITS",
    `got ${s1Sens.nominal_verdict}`,
  );
  assert(
    s1Sens.critical.length === 0,
    "1c. S1 has no critical fact (critical.length === 0)",
    `got ${JSON.stringify(s1Sens.critical)}`,
  );
  assert(
    s1Questions.length === 0,
    "1d. S1 produces zero questions",
    `got ${s1Questions.length}`,
  );
}

// ------------------------------------------------------------------
// 2. S3: plan.living_area_sqft critical across two readings (NO_LEGS vs FITS)
// ------------------------------------------------------------------
{
  const s3Case = loadCase("s3.json");
  const { sensitivity: s3Sens, questions: s3Questions } = runSensitivityWithQuestions({
    case: s3Case,
  });

  assert(
    C.Sensitivity.safeParse(s3Sens).success &&
      s3Sens.branches.every((b) => C.Branch.safeParse(b).success) &&
      C.QuestionSet.safeParse(s3Questions).success,
    "2a. S3 sensitivity, branches, and questions parse against C5 contracts",
  );
  assert(
    s3Sens.nominal_verdict === "FITS_IF",
    "2b. S3 nominal_verdict is FITS_IF",
    `got ${s3Sens.nominal_verdict}`,
  );

  const readingBranches = s3Sens.branches.filter(
    (b) => b.fact === "plan.living_area_sqft" && b.assignment.kind === "reading",
  );
  const readingVerdicts = readingBranches.map((b) => b.verdict);
  assert(
    readingBranches.length === 2 &&
      readingVerdicts.includes("NO_LEGS") &&
      readingVerdicts.includes("FITS"),
    "2c. S3 reading branches for plan.living_area_sqft yield NO_LEGS (864 sqft) and FITS (576 sqft)",
    `got ${JSON.stringify(readingBranches)}`,
  );
  assert(
    s3Sens.critical.length === 1 &&
      s3Sens.critical[0]?.fact === "plan.living_area_sqft" &&
      s3Sens.critical[0]?.impact === 1,
    "2d. S3 marks plan.living_area_sqft as the critical fact with impact 1",
    `got ${JSON.stringify(s3Sens.critical)}`,
  );
}

// ------------------------------------------------------------------
// 3. S4: site.primary_living_area_sqft critical across two observations -> 1 eligible Question
// ------------------------------------------------------------------
{
  const s4Case = loadCase("s4.json");
  const { sensitivity: s4Sens, questions: s4Questions } = runSensitivityWithQuestions({
    case: s4Case,
  });

  assert(
    C.Sensitivity.safeParse(s4Sens).success &&
      s4Sens.branches.every((b) => C.Branch.safeParse(b).success) &&
      C.QuestionSet.safeParse(s4Questions).success,
    "3a. S4 sensitivity, branches, and questions parse against C5 contracts",
  );
  assert(
    s4Sens.nominal_verdict === "NEEDS_CHECK",
    "3b. S4 nominal_verdict is NEEDS_CHECK",
    `got ${s4Sens.nominal_verdict}`,
  );

  const obsBranches = s4Sens.branches.filter(
    (b) => b.fact === "site.primary_living_area_sqft" && b.assignment.kind === "observation",
  );
  const obsVerdicts = obsBranches.map((b) => b.verdict);
  assert(
    obsBranches.length === 2 &&
      obsVerdicts[0] === "NO_LEGS" &&
      obsVerdicts[1] === "FITS",
    "3c. S4 observation branches for site.primary_living_area_sqft yield NO_LEGS (1000 sqft) and FITS (1400 sqft)",
    `got ${JSON.stringify(obsBranches)}`,
  );
  assert(
    s4Sens.critical.length === 1 &&
      s4Sens.critical[0]?.fact === "site.primary_living_area_sqft" &&
      s4Sens.critical[0]?.impact === 1,
    "3d. S4 marks site.primary_living_area_sqft as the critical fact",
    `got ${JSON.stringify(s4Sens.critical)}`,
  );
  assert(
    s4Questions.length === 1 &&
      s4Questions[0]?.fact === "site.primary_living_area_sqft" &&
      s4Questions[0]?.answers.length === 2 &&
      new Set(s4Questions[0]?.answers.map((a) => a.verdict)).size === 2,
    "3e. S4 produces exactly one eligible Question for site.primary_living_area_sqft",
    `got ${JSON.stringify(s4Questions)}`,
  );
}

// ------------------------------------------------------------------
// 4. S5: site.rear_lot_line critical across ±1.6 ft tolerance
// ------------------------------------------------------------------
{
  const s5Case = loadCase("s5.json");
  const { sensitivity: s5Sens, questions: s5Questions } = runSensitivityWithQuestions({
    case: s5Case,
  });

  assert(
    C.Sensitivity.safeParse(s5Sens).success &&
      s5Sens.branches.every((b) => C.Branch.safeParse(b).success) &&
      C.QuestionSet.safeParse(s5Questions).success,
    "4a. S5 sensitivity, branches, and questions parse against C5 contracts",
  );
  assert(
    s5Sens.nominal_verdict === "NEEDS_CHECK",
    "4b. S5 nominal_verdict is NEEDS_CHECK (margin +0.15 ft < tolerance 1.6 ft)",
    `got ${s5Sens.nominal_verdict}`,
  );

  const rearBranches = s5Sens.branches.filter(
    (b) => b.fact === "site.rear_lot_line" && b.assignment.kind === "tolerance",
  );
  const minusBranch = rearBranches.find(
    (b) => b.assignment.kind === "tolerance" && b.assignment.delta === -1.6,
  );
  const plusBranch = rearBranches.find(
    (b) => b.assignment.kind === "tolerance" && b.assignment.delta === 1.6,
  );

  assert(
    minusBranch !== undefined &&
      plusBranch !== undefined &&
      minusBranch.client_spot_passes === false &&
      plusBranch.client_spot_passes === true &&
      plusBranch.verdict === "FITS",
    "4c. S5 site.rear_lot_line branches flip client_spot_passes (false at -1.6 ft, true at +1.6 ft) and verdict",
    `got ${JSON.stringify(rearBranches)}`,
  );
  assert(
    s5Sens.critical.length === 1 &&
      s5Sens.critical[0]?.fact === "site.rear_lot_line" &&
      s5Sens.critical[0]?.impact === 1,
    "4d. S5 marks site.rear_lot_line as the critical fact",
    `got ${JSON.stringify(s5Sens.critical)}`,
  );
}

// ------------------------------------------------------------------
// 5. Guard opening on an excluded provision & 16-value cap (`untested`)
// ------------------------------------------------------------------
{
  const s1UnconfirmedTrees = structuredClone(loadCase("s1.json")) as Record<string, any>;
  s1UnconfirmedTrees["site"]["trees"]["status"] = "unconfirmed";
  s1UnconfirmedTrees["site"]["trees"]["prov"][0]["status"] = "unconfirmed";

  const sensTrees = runSensitivity({ case: s1UnconfirmedTrees });
  const qTrees = buildQuestions(s1UnconfirmedTrees, sensTrees);
  const treeBranches = sensTrees.branches.filter((b) => b.fact === "site.trees");
  const trueTreeBranch = treeBranches.find(
    (b) => b.assignment.kind === "unconfirmed" && b.assignment.value === true,
  );

  assert(
    trueTreeBranch !== undefined &&
      trueTreeBranch.verdict === "NEEDS_CHECK" &&
      trueTreeBranch.findings_delta.some(
        (d) => d.provision_id === "PDX.11.50.020" && d.from === "not_applicable" && d.to === "unknown",
      ) &&
      sensTrees.critical.some((c) => c.fact === "site.trees") &&
      qTrees.length === 1,
    "5a. Guard-excluded provision PDX.11.50.020 re-runs its guard when site.trees is flipped; opening with no operator yields from='not_applicable' -> to='unknown' and NEEDS_CHECK",
    `got ${JSON.stringify(treeBranches)}`,
  );

  // Test the 16-value cap by adding > 16 unknowns
  const s1ManyUnknowns = structuredClone(loadCase("s1.json")) as Record<string, any>;
  const extraFactNames = [
    "site.corner_lot",
    "site.historic_landmark",
    "site.historic_district",
    "site.conservation_district",
    "site.environmental_overlay",
    "site.greenway_overlay",
    "site.scenic_overlay",
    "site.aircraft_landing_overlay",
    "site.pleasant_valley_natural_resources",
    "site.potential_landslide_hazard",
    "site.flood_hazard_area",
    "site.aloha_reedville_study_area",
    "plan.rooftop_deck",
    "plan.dormers",
    "plan.kitchen",
    "plan.bathroom",
  ];
  for (const fn of extraFactNames) {
    const [sc, k] = fn.split(".") as ["site" | "plan", string];
    delete s1ManyUnknowns[sc]?.[k];
    s1ManyUnknowns["unknowns"].push({ fact: fn, reason: "cap test" });
  }
  const sensCap = runSensitivity({ case: s1ManyUnknowns });
  assert(
    sensCap.untested.length > 0 && C.Sensitivity.safeParse(sensCap).success,
    "5b. Values beyond the 16-value sensitivity cap are recorded in untested[]",
    `untested count = ${sensCap.untested.length}`,
  );
}

console.log(`\n${passed}/${total} sensitivity checks passed.`);
if (passed !== total) {
  process.exit(1);
}
