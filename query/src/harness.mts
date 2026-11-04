/**
 * W6 · Agent Harness (`evaluate(case) -> Report`).
 *
 * Implements the LotFit phased agent loop from `ARCHITECTURE.md` §3, §4, §5, §7
 * and `HANDOFF-AG-W6-HARNESS.md` against frozen contracts `1.0.0` (`src/types.mts`):
 *   Step 0 — Case Gate (W3 `checkCase`)
 *   Step 1 — PLAN (`PLAN` phase: `read_reading_guide`, `read_layer_index`, `inspect_case_facts` -> `Plan`)
 *   Step 2 — EXECUTE (`EXECUTE` phase: `gate` -> `plan_constraint` -> `placement_constraint`,
 *            parameter/cell/fact resolution, `graph/tool_runner.py` bridge, breaker, memo,
 *            stuck rule, budgets, `record_finding`, `conclude`)
 *   Step 3 — SENSITIVITY (W5 `runSensitivity` + `buildQuestions`, zero model calls)
 *   Step 4 — VERDICT (entailed verdict + dispositions/unchecked clauses + `lotfit.verdict_computed`)
 *   Step 5 — VERIFY (W7 `verify()`, up to 2 repair turns in `EXECUTE`)
 *   Step 6 — PROPOSE (`Report` + W8 `compileTrace` -> `report.json` and `trace.json` artifacts)
 */

import { buildReviewItems, loadRubric, mergeReview, review } from "./reviewer.mts";
import type { ReviewerClient } from "./reviewer-client.mts";
import { computeFindingOutcome, describeRequirement, loadOperatorCovers, loadProvisionRules, loadRelaxingExceptionProvisions, type Cover } from "./outcome.mts";
import { connect as connectGraph } from "./graph-tools.mts";
import { queryCodeGraph } from "./guard-cypher.mts";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync as readFileSyncOps } from "node:fs";
import type { z } from "zod";

import * as C from "./types.mts";
import { checkCase } from "./case-gate.mts";
import {
  buildQuestions,
  entailVerdict,
  materializeComputedFacts,
  runSensitivity,
  type FindingInput,
} from "./sensitivity.mts";
import { resolvePath, verify } from "./verifier.mts";
import { compileTrace } from "./compile-trace.mts";
import {
  createAuraGraphReader,
  createFileGraphReader,
  type FileGraphReaderOptions,
  type GraphReader,
} from "./graph-reads.mts";
import {
  canonicalJson,
  computeConfigHash,
  EventLog,
  makeUuid7,
  type ConfigManifestType,
  type PhaseType,
} from "./events.mts";
import {
  allowedToolsForPhase,
  buildContextFromLog,
  getOntologySha256,
  getRoleAndPrinciplesSha256,
  getToolContractsSha256,
  PLACEMENT_TOOLS,
  PLAN_CONSTRAINT_TOOLS,
  type BreakerState,
} from "./context.mts";
import {
  BasetenModelClient,
  type ModelClient,
  type ModelToolCallDraft,
} from "./model-client.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TOOL_RUNNER_PATH = path.join(REPO_ROOT, "graph", "tool_runner.py");

export type CaseType = z.infer<typeof C.Case>;
export type PlanType = z.infer<typeof C.Plan>;
export type LayerIndexType = z.infer<typeof C.LayerIndex>;
export type IndexEntryType = z.infer<typeof C.IndexEntry>;
export type RuleFamilyType = z.infer<typeof C.RuleFamily>;
export type ReportType = z.infer<typeof C.Report>;
export type ReportFindingType = z.infer<typeof C.ReportFinding>;
export type RecordFindingType = z.infer<typeof C.RecordFinding>;
export type ConcludeType = z.infer<typeof C.Conclude>;
export type SensitivityType = z.infer<typeof C.Sensitivity>;
export type TraceType = z.infer<typeof C.Trace>;
export type LotFitEventType = z.infer<typeof C.LotFitEvent>;
export type RepairErrorType = z.infer<typeof C.RepairError>;
export type ResolvedParamType = z.infer<typeof C.ResolvedParam>;
export type MeasureResultType = z.infer<typeof C.MeasureResult>;
export type ExceptionResultType = z.infer<typeof C.ExceptionResult>;
export type GuardResultType = z.infer<typeof C.GuardResult>;
export type PlacementSearchResultType = z.infer<typeof C.PlacementSearchResult>;
export type PlacementType = z.infer<typeof C.Placement>;
export type VerdictType = z.infer<typeof C.Verdict>;
export type TargetType = z.infer<typeof C.Target>;
export type EvaluationStageType = z.infer<typeof C.EvaluationStage>;
export type ArtifactRefType = z.infer<typeof C.ArtifactRef>;

export interface HarnessBudgets {
  max_turns: number;
  max_calls: number;
  max_tokens: number;
  max_plan_execute_ms: number;
  max_total_ms: number;
  max_plan_repairs: number;
  max_verify_repairs: number;
}

export const DEFAULT_HARNESS_BUDGETS: HarnessBudgets = {
  // L33 (Martin, 2026-11-02): milestone-1 ceilings set from measurement; new tokens only; tightened as we optimize.
  max_turns: 30,
  max_calls: 80,
  max_tokens: 150_000,
  max_plan_execute_ms: 170_000,
  max_total_ms: 180_000,
  max_plan_repairs: 2,
  max_verify_repairs: 2,
};

export interface EvaluateOptions {
  modelClient?: ModelClient;
  /** The Reviewer (CONTRACT-REVIEWER.md, 1.5.0). Absent: report.reviewer is `not_run` ("no Reviewer configured"). */
  reviewerClient?: ReviewerClient | null;
  graphReader?: GraphReader;
  fileGraphOptions?: FileGraphReaderOptions;
  useAura?: boolean;
  runsDir?: string;
  threadId?: string;
  budgets?: Partial<HarnessBudgets>;
}

export interface EvaluateRunResult {
  report: ReportType;
  trace: TraceType;
  events: LotFitEventType[];
  thread_id: string;
  run_dir: string;
  plan: PlanType | null;
  sensitivity: SensitivityType;
}

// ------------------------------------------------------------------ Case Fact Helpers

function getFactEntry(kase: Record<string, any>, fullFact: string): Record<string, any> | undefined {
  const [scope, key] = fullFact.split(".") as ["site" | "plan", string];
  return kase[scope]?.[key] as Record<string, any> | undefined;
}

function resolveFactValue(kase: Record<string, any>, fullFact: string): unknown {
  const entry = getFactEntry(kase, fullFact);
  if (!entry) return undefined;
  if (Array.isArray(entry["observations"]) && entry["observations"].length > 0) {
    return entry["observations"][0]["value"];
  }
  return entry["value"];
}

function isFactUnknown(kase: Record<string, any>, fullFact: string): boolean {
  const unknowns = (kase["unknowns"] ?? []) as Array<{ fact: string; reason: string }>;
  if (unknowns.some((u) => u.fact === fullFact)) return true;
  return getFactEntry(kase, fullFact) === undefined;
}

function isFactConflicting(kase: Record<string, any>, fullFact: string): boolean {
  const entry = getFactEntry(kase, fullFact);
  if (!entry || !Array.isArray(entry["observations"])) return false;
  const vals = new Set(entry["observations"].map((o: any) => JSON.stringify(o["value"])));
  return vals.size > 1;
}

function extractFactToleranceFt(kase: Record<string, any>, fullFact: string): number {
  const entry = getFactEntry(kase, fullFact);
  if (!entry) return 0;
  const provs: Array<Record<string, any>> = Array.isArray(entry["observations"])
    ? entry["observations"].flatMap((o: any) => o["prov"] ?? [])
    : (entry["prov"] ?? []);
  let maxTol = 0;
  for (const pr of provs) {
    const tol = pr["tolerance"];
    if (tol && typeof tol["value"] === "number" && tol["value"] > maxTol) {
      maxTol = tol["value"];
    }
  }
  return maxTol;
}

function buildFlatKnownFacts(kase: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const scope of ["site", "plan"] as const) {
    const bag = (kase[scope] ?? {}) as Record<string, any>;
    for (const [k, v] of Object.entries(bag)) {
      const fullFact = `${scope}.${k}`;
      if (isFactUnknown(kase, fullFact) || isFactConflicting(kase, fullFact)) {
        out[fullFact] = null;
      } else if (v && typeof v === "object" && "value" in v) {
        out[fullFact] = v["value"];
      } else if (v && typeof v === "object" && Array.isArray(v["observations"]) && v["observations"].length > 0) {
        out[fullFact] = v["observations"][0]["value"];
      } else {
        out[fullFact] = v;
      }
    }
  }
  for (const u of (kase["unknowns"] ?? []) as Array<{ fact: string }>) {
    out[u.fact] = null;
  }
  return out;
}

function computePlacedOutline(
  footprint: Array<[number, number]>,
  placement: { x: number; y: number; rotation?: number },
): Array<[number, number]> {
  const rot = (((placement.rotation ?? 0) % 360) + 360) % 360;
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return footprint.map(([px, py]) => [
    Number((placement.x + px * cos - py * sin).toFixed(6)),
    Number((placement.y + px * sin + py * cos).toFixed(6)),
  ]);
}

function normalizeStructureOutlines(rawStructs: unknown): Array<Array<[number, number]>> {
  if (!Array.isArray(rawStructs)) return [];
  const out: Array<Array<[number, number]>> = [];
  for (const item of rawStructs) {
    if (Array.isArray(item)) {
      out.push(item as Array<[number, number]>);
    } else if (item && typeof item === "object" && Array.isArray((item as Record<string, unknown>)["outline"])) {
      out.push((item as Record<string, unknown>)["outline"] as Array<[number, number]>);
    }
  }
  return out;
}

// ------------------------------------------------------------------ Python Bridge Execution

interface RawBridgeItemResult {
  call_id: string;
  ok: boolean;
  result?: unknown;
  duration_ms?: number;
  error?: { category: "input" | "tool" | "model"; message: string };
}

function executePythonBridgeBatch(
  batch: z.infer<typeof C.BridgeRequest>["batch"],
  configHash: string,
): { impl_digest: string; results: Map<string, RawBridgeItemResult> } {
  if (batch.length === 0) {
    return { impl_digest: "0".repeat(64), results: new Map() };
  }
  const req = C.BridgeRequest.parse({
    config_hash: configHash,
    batch,
  });
  const stdout = execFileSync("python3", ["-I", TOOL_RUNNER_PATH], {
    input: JSON.stringify(req),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const resp = C.BridgeResponse.parse(JSON.parse(stdout));
  const map = new Map<string, RawBridgeItemResult>();
  for (const item of resp.results) {
    map.set(item.call_id, item as RawBridgeItemResult);
  }
  return { impl_digest: resp.impl_digest, results: map };
}

// ------------------------------------------------------------------ Guard Evaluation Helper

function evalSingleGuardHolds(
  gd: { fact: string; op: string; value?: unknown },
  facts: Record<string, unknown>,
): boolean | null {
  if (!(gd.fact in facts) || facts[gd.fact] === null || facts[gd.fact] === undefined) {
    return null;
  }
  const v = facts[gd.fact];
  if (gd.op === "true") return v === true;
  if (gd.op === "false") return v === false;
  if (gd.op === "==") return v === gd.value;
  if (gd.op === "!=") return v !== gd.value;
  if (gd.op === "in") return Array.isArray(gd.value) && gd.value.includes(v);
  if (gd.op === "count>0") return typeof v === "number" && v > 0;
  if (gd.op === "nonempty") return Array.isArray(v) && v.length > 0;
  return null;
}

export const CURATED_PROVISION_TRIGGER_GUARDS: Record<
  string,
  Array<{ fact: string; op: string; value?: unknown }>
> = {
  "PDX.33.110.202.C.1": [{ fact: "plan.kind", op: "in", value: ["primary_dwelling"] }],
  "PDX.33.110.202.C.2-4": [{ fact: "plan.kind", op: "in", value: ["primary_dwelling"] }],
  "PDX.33.110.202.C.5": [{ fact: "plan.kind", op: "in", value: ["primary_dwelling"] }],
  "PDX.33.110.202.D": [{ fact: "plan.kind", op: "in", value: ["primary_dwelling"] }],
  "PDX.33.110.220.C.1": [{ fact: "plan.eave_ft", op: "in", value: [2] }],
  "PDX.33.110.220.C.2": [{ fact: "plan.eave_ft", op: "in", value: [2] }],
  "PDX.33.110.220.C.3": [{ fact: "plan.rooftop_deck", op: "true" }],
  "PDX.33.110.220.C.4": [{ fact: "site.alley", op: "true" }],
  "PDX.33.110.220.D.1": [{ fact: "site.through_lot", op: "true" }],
  "PDX.33.110.220.D.4.a": [
    { fact: "site.zone", op: "in", value: ["RF", "R20", "R10", "R7"] },
  ],
  // Build-review R2 B2: site.trees is a yes/no fact (facts.json), so the trigger is "true"; "nonempty" on true was false,
  // which ruled the tree gates out exactly when there are trees.
  "PDX.11.50.020": [{ fact: "site.trees", op: "true" }],
  "PDX.11.50.040.A": [{ fact: "site.trees", op: "true" }],
  "PDX.11.50.050.A": [{ fact: "site.trees", op: "true" }],
  "PDX.33.110.255.B.1.a": [{ fact: "site.flag_lot", op: "true" }],
  "PDX.33.110.255.B.1.b-e": [{ fact: "site.flag_lot", op: "true" }],
  "PDX.33.110.245.C.3.b": [{ fact: "site.corner_lot", op: "true" }],
  "PDX.33.110.245.C.4": [{ fact: "plan.is_garage", op: "true" }],
  "PDX.33.110.245.B.1-2": [{ fact: "plan.is_garage", op: "true" }],
  "PDX.33.205.040.C.3": [{ fact: "plan.is_garage", op: "true" }],
  // AG4 (AG build review r1): every trigger names a registered fact. C.7's three unregistered facts are the registry's
  // site.historic_resource ("a designated historic resource or in a historic or conservation district"). C.6's trigger
  // (plan.has_basement, unregistered) is removed: its text is not in the graph to map it from.
  "PDX.33.205.040.C.7": [{ fact: "site.historic_resource", op: "true" }],
  // Martin 2026-11-03 ("yes, fix it"; build review §4.1): "on a site with a house or manufactured home in the R20 through
  // R2.5 zones". The ingest read it as primary_is_manufactured AND zone in [R20, R2.5]; a house or a manufactured home is
  // a primary dwelling on the site (its outline), and "R20 through R2.5" is the five single-dwelling zones.
  "PDX.33.205.020.B.1.a": [
    { fact: "site.house_outline", op: "nonempty" },
    { fact: "site.zone", op: "in", value: ["R20", "R10", "R7", "R5", "R2.5"] },
  ],
  "PDX.33.418.040": [{ fact: "site.overlays", op: "nonempty" }],
  "PDX.33.418.040.part2": [{ fact: "site.overlays", op: "nonempty" }],
};

/** Build-review A1 (2026-11-03): a condition that carves the rule's own exception ("Except for…", "unless…"). A false
 *  guard on it means the exception does not hold, so the rule applies: it never rules the provision out. */
const EXCEPTION_CONDITION_RE = /\b(except|unless|exempt|not required|does not apply|do not apply|not permitted)\b/i;
export function isExceptionCondition(cl: { kind: string; quote: string } | undefined): boolean {
  return !!cl && cl.kind === "condition" && EXCEPTION_CONDITION_RE.test(cl.quote);
}

/** Which guards stand for the provision's applicability, and where they come from (build-review A1, A11).
 *  Only the provision's scope decides whether it applies: a curated trigger list, else the guards of the index scope
 *  clause (never an exception condition), else the index zone list. A guard on any other clause (an obligation, a
 *  sub-condition, an "Except…") says nothing about the whole provision, so it is never sent: with no scope guard the
 *  exclusion is a Planner reading. Every selected guard is sent, so the bridge's rule (known_false only if every guard
 *  is known false, known_true only if every guard holds) is Kleene over the scope, not over a pre-filtered list. */
export type GuardSource = "curated" | "scope_clause" | "zones" | "none";
export function selectScopeGuards(
  rf: RuleFamilyType,
  indexEntry: IndexEntryType | undefined,
): { source: GuardSource; guards: Array<{ clause_id: string; fact: string; op: string; value?: unknown }> } {
  const scopeClauseId = indexEntry?.scope.scope_clause_id ?? rf.clauses[0]?.clause_id ?? `${rf.version_id}::s0`;
  const curated = CURATED_PROVISION_TRIGGER_GUARDS[rf.provision_id] ?? [];
  if (curated.length > 0) {
    return { source: "curated", guards: curated.map((ct) => ({ clause_id: scopeClauseId, fact: ct.fact, op: ct.op,
      ...(ct.value !== undefined ? { value: ct.value } : {}) })) };
  }
  const scopeClause = rf.clauses.find((c) => c.clause_id === scopeClauseId);
  const stated = indexEntry?.scope.basis === "stated" || indexEntry?.scope.basis === "curated";
  if (stated && scopeClause && scopeClause.guards.length > 0 && !isExceptionCondition(scopeClause)) {
    return { source: "scope_clause", guards: scopeClause.guards.map((gd) => {
      const op = gd.op === "==" && gd.value === true ? "true" : gd.op;
      return { clause_id: scopeClause.clause_id, fact: gd.fact, op, ...(gd.value !== undefined && op !== "true" ? { value: gd.value } : {}) };
    }) };
  }
  // Build-review R2 B1: no zone-list fallback. The index's zone list is harvested from every clause (footnotes, a
  // neighbour's zone in "abuts property zoned R-1"), so it is not the provision's scope; a zone in the scope sentence
  // itself is already one of the stated scope clause's guards.
  return { source: "none", guards: [] };
}

function selectBridgeGuardsForProvision(
  rf: RuleFamilyType,
  indexEntry: IndexEntryType | undefined,
  _facts: Record<string, unknown>,
): Array<{ clause_id: string; fact: string; op: string; value?: unknown }> {
  return selectScopeGuards(rf, indexEntry).guards;
}

/** Build-review A7: facts a guard may rule a provision out on. An unconfirmed, conflicting, unknown or by-reading
 *  fact is not known, so it is null here (SPEC row 3: unknown never rules a rule out). */
export function buildGuardFacts(kase: Record<string, any>): Record<string, unknown> {
  const out = buildFlatKnownFacts(kase);
  for (const f of Object.keys(out)) if (isUnsettledFact(kase, f)) out[f] = null;
  // AG3 (AG build review r1): a computed fact (facts.json `computed.from`) is only as settled as its sources: the lot
  // area from an unconfirmed lot outline is not known either.
  for (const [f, from] of COMPUTED_FROM) if (f in out && from.some((src) => isUnsettledFact(kase, src) || (src in out && out[src] === null))) out[f] = null;
  return out;
}
const COMPUTED_FROM: Array<[string, string[]]> = (() => {
  try {
    const j = JSON.parse(readFileSyncOps(path.join(REPO_ROOT, "graph", "curated", "facts.json"), "utf8"));
    return (j.facts as Array<{ name: string; computed?: { from?: string[] } }>).filter((x) => x.computed?.from?.length).map((x) => [x.name, x.computed!.from!]);
  } catch { return []; }
})();

// ------------------------------------------------------------------ Unchecked Clauses & Dispositions (GR-47 / M14)

function isClauseRuledOutOnCase(
  cl: RuleFamilyType["clauses"][number],
  facts: Record<string, unknown>,
): boolean {
  if (!cl.guards || cl.guards.length === 0) return false;
  return cl.guards.every((gd) => {
    const op = gd.op === "==" && gd.value === true ? "true" : gd.op;
    return evalSingleGuardHolds({ fact: gd.fact, op, value: gd.value }, facts) === false;
  });
}

const STRUCTURAL_CLAUSE_KINDS = new Set(["heading", "caption", "reference", "stem", "lead_in", "footnote"]);

/** L40: a not-modeled clause is covered in this run when an applied provision's operator lists it in `covers` and that
 *  operator's tool ran successfully on the provision (a result with a pass value: true, false or null). The clause was
 *  then evaluated by code, so it is not "unchecked"; the finding carries the outcome. */
export function clauseCoverage(
  appliedProvisionIds: string[],
  covers: Cover[],
  calls: Iterable<{ tool: string; provision_id: string | null; ok: boolean; result: unknown; call_id?: string }>,
): Map<string, { cover: Cover; call_ids: string[] }> {
  const applied = new Set(appliedProvisionIds), all = [...calls], out = new Map<string, { cover: Cover; call_ids: string[] }>();
  for (const cv of covers) {
    if (!applied.has(cv.provision)) continue;
    const ran = all.filter((c) => c.ok && c.tool === cv.tool && c.provision_id === cv.provision && !!c.result && typeof c.result === "object" && "pass" in (c.result as object));
    if (ran.length > 0) out.set(cv.clause, { cover: cv, call_ids: ran.map((c) => c.call_id ?? "").filter(Boolean) });
  }
  return out;
}
const OPERATOR_COVERS = loadOperatorCovers();
const RELAXING_EXCEPTIONS = loadRelaxingExceptionProvisions();

function collectUncheckedAndDispositions(
  appliedProvisionIds: string[],
  ruleFamilies: Map<string, RuleFamilyType>,
  facts: Record<string, unknown>,
  covered: Map<string, { cover: Cover; call_ids: string[] }> = new Map(),
): {
  unchecked: ReportType["unchecked"];
  dispositions_relied_on: ReportType["dispositions_relied_on"];
} {
  const unchecked: ReportType["unchecked"] = [];
  const dispositions_relied_on: ReportType["dispositions_relied_on"] = [];
  const seenClauses = new Set<string>();

  for (const pid of appliedProvisionIds) {
    const rf = ruleFamilies.get(pid);
    if (!rf) continue;
    for (const cl of rf.clauses) {
      if (seenClauses.has(cl.clause_id)) continue;
      seenClauses.add(cl.clause_id);

      if (cl.modeled || STRUCTURAL_CLAUSE_KINDS.has(cl.kind)) {
        continue;
      }
      if (isClauseRuledOutOnCase(cl, facts)) {
        continue;
      }

      const cov = covered.get(cl.clause_id);
      if (cov) {
        dispositions_relied_on.push({
          clause_id: cl.clause_id,
          disposition: { kind: "covered_by_check", reason: `evaluated by ${cov.cover.op} (${cov.cover.tool}) in this run${cov.call_ids.length ? ` [${cov.call_ids.join(", ")}]` : ""}: ${cov.cover.note}`, by: `operators.json ${cov.cover.op}`, date: cov.cover.date },
        });
        continue;
      }

      if (cl.disposition) {
        if (cl.disposition.kind === "inert_for") {
          dispositions_relied_on.push({
            clause_id: cl.clause_id,
            disposition: cl.disposition,
          });
          continue;
        }
        if (cl.disposition.kind === "needs_fact") {
          const fVal = cl.disposition.fact ? facts[cl.disposition.fact] : undefined;
          if (fVal === false) {
            dispositions_relied_on.push({
              clause_id: cl.clause_id,
              disposition: cl.disposition,
            });
            continue;
          }
          unchecked.push({
            provision_id: pid,
            clause_id: cl.clause_id,
            reason: `not-modeled clause requires fact ${cl.disposition.fact ?? "unknown"}: ${cl.quote}`,
          });
          continue;
        }
      }

      unchecked.push({
        provision_id: pid,
        clause_id: cl.clause_id,
        reason: `not-modeled clause has no signed disposition (GR-47): ${cl.quote}`,
      });
    }
  }

  return { unchecked, dispositions_relied_on };
}

/** P1 (SPEC 14; L38; contracts 1.4.0): an exclusion that rests only on the Planner's reading of the scope sentence is a
 *  model reading, not a computed fact. Read from the Record. Without a signed inert_for disposition on that scope clause
 *  it is unchecked, so no FITS rests on it; with one, the disposition is relied on and named. Only the stages a run must
 *  cover count (gate, plan and placement constraints, as V1): definitions, exceptions and preemptions are reached
 *  through edges and never applied on their own (§3); their readings stay in the Record for the Reviewer. */
/** The project kind a disposition's scope is signed for: "detached_adu" or "attached_adu" from plan.kind and plan.detached. */
export function projectKindOf(kase: Record<string, any> | undefined): string | null {
  const v = (f: string) => { const e = kase?.["plan"]?.[f]; return e && typeof e === "object" && "value" in e ? e.value : e; };
  const kind = v("kind"), detached = v("detached");
  if (kind === "adu" && detached === true) return "detached_adu";
  if (kind === "adu" && detached === false) return "attached_adu";
  return typeof kind === "string" ? kind : null;
}

export function plannerReadingsUnchecked(
  events: Iterable<LotFitEventType>,
  stageOf: (pid: string) => string | undefined | null,
  ruleFamilies: Map<string, RuleFamilyType>,
  projectKind: string | null = null,
): { unchecked: ReportType["unchecked"]; relied: ReportType["dispositions_relied_on"] } {
  const ACTIVE = new Set(["gate", "plan_constraint", "placement_constraint"]);
  const unchecked: ReportType["unchecked"] = [];
  const relied: ReportType["dispositions_relied_on"] = [];
  for (const ev of events) {
    if (ev.type !== "lotfit.exclusion_recorded" || ev.data.basis !== "planner_reading") continue;
    const stage = stageOf(ev.data.provision_id);
    if (!stage || !ACTIVE.has(stage)) continue;
    const scopeClause = ruleFamilies.get(ev.data.provision_id)?.clauses.find((c) => c.clause_id === ev.data.scope_clause_id);
    // Build-review A9: a disposition signed for one project kind does not excuse a reading on another.
    const d = scopeClause?.disposition;
    if (d && d.kind === "inert_for" && (d.scope === undefined || d.scope === projectKind)) {
      relied.push({ clause_id: scopeClause.clause_id, disposition: d });
      continue;
    }
    unchecked.push({
      provision_id: ev.data.provision_id,
      clause_id: ev.data.scope_clause_id,
      reason: `excluded on the Planner's reading of its scope sentence, not computed (SPEC 14): "${ev.data.scope_quote.slice(0, 200)}"`,
    });
  }
  return { unchecked, relied };
}

// ------------------------------------------------------------------ Plan Validation (Step 1)

/** P1/P2: the basis of one exclusion in the accepted Plan (event lotfit.exclusion_recorded, contracts 1.4.0). */
export interface ExclusionRecord {
  provision_id: string;
  basis: "computed_known_false" | "through_operator" | "planner_reading";
  guard_call_id: string | null;
  guard_result: "known_true" | "known_false" | "unknown" | null;
  through: string | null;
  scope_clause_id: string;
  scope_quote: string;
}

export async function validatePlanAgainstIndex(
  candidate: unknown,
  index: LayerIndexType,
  kase: Record<string, any>,
  graphReader: GraphReader,
  ruleFamilyCache: Map<string, RuleFamilyType>,
  configHash: string,
): Promise<{
  plan: PlanType | null;
  repairs: RepairErrorType[];
  excludedGuardResults: Map<string, GuardResultType>;
  exclusions: ExclusionRecord[];
}> {
  const repairs: RepairErrorType[] = [];
  const excludedGuardResults = new Map<string, GuardResultType>();
  const exclusions: ExclusionRecord[] = [];

  const parsed = C.Plan.safeParse(candidate);
  if (!parsed.success) {
    repairs.push({
      code: "PLAN_INCOMPLETE",
      message: `Plan failed schema validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
    return { plan: null, repairs, excludedGuardResults, exclusions };
  }

  const plan = parsed.data;
  const indexEntries = new Map<string, IndexEntryType>();
  for (const layer of index.layers) {
    for (const entry of layer.provisions) {
      indexEntries.set(entry.provision_id, entry);
    }
  }

  const seenInPlan = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const a of plan.applies) {
    if (!indexEntries.has(a.provision_id)) {
      repairs.push({
        code: "PLAN_UNKNOWN_ID",
        provision_id: a.provision_id,
        message: `Plan applies unknown provision_id '${a.provision_id}' not present in read_layer_index.`,
      });
    }
    if (seenInPlan.has(a.provision_id)) {
      duplicateIds.add(a.provision_id);
    }
    seenInPlan.add(a.provision_id);
  }

  for (const ex of plan.excluded_at_index) {
    if (!indexEntries.has(ex.provision_id)) {
      repairs.push({
        code: "PLAN_UNKNOWN_ID",
        provision_id: ex.provision_id,
        message: `Plan excludes unknown provision_id '${ex.provision_id}' not present in read_layer_index.`,
      });
    }
    if (seenInPlan.has(ex.provision_id)) {
      duplicateIds.add(ex.provision_id);
    }
    seenInPlan.add(ex.provision_id);
  }

  for (const dupId of duplicateIds) {
    repairs.push({
      code: "PLAN_INCOMPLETE",
      provision_id: dupId,
      message: `Provision '${dupId}' appears in both plan.applies and plan.excluded_at_index.`,
    });
  }

  // Every provision in read_layer_index must be partitioned into applies or excluded_at_index
  for (const [pid] of indexEntries.entries()) {
    if (!seenInPlan.has(pid)) {
      repairs.push({
        code: "PLAN_INCOMPLETE",
        provision_id: pid,
        message: `Index provision '${pid}' is missing from both plan.applies and plan.excluded_at_index.`,
      });
    }
  }

  const facts = buildGuardFacts(kase);
  const asOf = String(kase["as_of"]?.["date"] ?? index.as_of);

  // Batch-load missing rule families for excluded provisions
  const missingExcludedIds = plan.excluded_at_index
    .map((ex) => ex.provision_id)
    .filter((pid) => indexEntries.has(pid) && !ruleFamilyCache.has(pid));
  if (missingExcludedIds.length > 0) {
    const fams = await graphReader.readRuleFamily({
      provision_ids: missingExcludedIds,
      as_of: asOf,
    });
    for (const f of fams) {
      ruleFamilyCache.set(f.provision_id, f);
    }
  }

  // Build one batch of evaluate_guards calls across all excluded provisions
  const guardBatch: z.infer<typeof C.BridgeRequest>["batch"] = [];
  const callIdByExcludedPid = new Map<string, string>();
  const guardSourceByPid = new Map<string, GuardSource>();
  for (const ex of plan.excluded_at_index) {
    const entry = indexEntries.get(ex.provision_id);
    const rf = ruleFamilyCache.get(ex.provision_id);
    if (!entry || !rf) continue;
    const sel = selectScopeGuards(rf, entry);
    guardSourceByPid.set(ex.provision_id, sel.source);
    const bridgeGuards = sel.guards;
    if (bridgeGuards.length > 0) {
      const cid = makeUuid7();
      callIdByExcludedPid.set(ex.provision_id, cid);
      guardBatch.push({
        call_id: cid,
        provision_id: ex.provision_id,
        target: "case",
        tool: "evaluate_guards",
        args: {
          provision_id: ex.provision_id,
          facts,
          guards: bridgeGuards,
        },
      });
    }
  }

  const batchOut =
    guardBatch.length > 0 ? executePythonBridgeBatch(guardBatch, configHash) : null;

  const b1Applied = new Set(plan.applies.map((a) => a.provision_id));
  const b1OperatorRules = loadProvisionRules("unknown"); // siblings only; zone-free
  // Check each excluded_at_index entry for PLAN_QUOTE_NOT_IN_INDEX and PLAN_FORBIDDEN_EXCLUSION
  for (const ex of plan.excluded_at_index) {
    const entry = indexEntries.get(ex.provision_id);
    if (!entry) continue;

    const indexQuote = entry.scope.scope_quote;
    const candidateQuote = ex.scope_quote.trim();
    const quoteMatches = candidateQuote.length > 0 && candidateQuote === indexQuote.trim();

    if (!quoteMatches) {
      repairs.push({
        code: "PLAN_QUOTE_NOT_IN_INDEX",
        provision_id: ex.provision_id,
        message: `Excluded provision '${ex.provision_id}' cites scope_quote '${ex.scope_quote}', which does not match index scope_quote '${indexQuote}' (clause '${entry.scope.scope_clause_id}').`,
      });
    }

    // B1 (rules-as-data panel, 2026-11-02): a table id alone earns no exemption (Table 110-2 is a gate). A table is
    // excused only when an applied provision that shares its operator evaluates it (110-4 through 220.B, 110-5 through
    // 225.B). Any other protected provision is excluded only on a computed known_false.
    const { through, isProtected } = exclusionProtection(entry, b1Applied, b1OperatorRules);

    let guardResult: GuardResultType | null = null;
    const cid = callIdByExcludedPid.get(ex.provision_id);
    if (cid && batchOut) {
      const item = batchOut.results.get(cid);
      if (item?.ok && item.result) {
        guardResult = C.GuardResult.parse(item.result);
      }
    }
    const record = (basis: ExclusionRecord["basis"]): void => {
      exclusions.push({ provision_id: ex.provision_id, basis, guard_call_id: guardResult ? (cid ?? null) : null,
        guard_result: guardResult?.result ?? null, through: basis === "through_operator" ? (through ?? null) : null,
        scope_clause_id: entry.scope.scope_clause_id, scope_quote: ex.scope_quote });
    };

    // P1 (Reviewer preconditions, CONTRACT-REVIEWER.md §1; SPEC rows 3 and 14; L38): a guard that is known true on the
    // case refuses the exclusion, protected or not. Before, an unprotected provision was excluded whatever the guard said.
    // Build-review A11: a zone match alone is not the provision's scope holding (the zone list is the fallback when the
    // scope clause carries no guard), so it does not refuse; the exclusion is then a Planner reading.
    const scopeSource = guardSourceByPid.get(ex.provision_id) ?? "none";
    if (guardResult && guardResult.result === "known_true" && !through && scopeSource !== "zones") {
      repairs.push({
        code: "PLAN_FORBIDDEN_EXCLUSION",
        provision_id: ex.provision_id,
        message: `Provision '${ex.provision_id}' cannot be excluded: evaluate_guards on the case is 'known_true' (${guardResult.guards.filter((g) => g.holds === true).map((g) => `${g.fact} = ${JSON.stringify(g.value)}`).join(", ") || "a guard holds"}).`,
      });
      continue;
    }

    if (isProtected) {
      if (!guardResult || guardResult.result !== "known_false") {
        repairs.push({
          code: "PLAN_FORBIDDEN_EXCLUSION",
          provision_id: ex.provision_id,
          message: `Provision '${ex.provision_id}' (stage=${entry.evaluation_stage}, has_operator=${String(entry.has_operator)}, modifies_operator_backed=${String(entry.modifies_operator_backed)}) cannot be excluded at index unless evaluate_guards on the case is 'known_false' (got '${guardResult?.result ?? "unknown"}').`,
        });
      } else {
        excludedGuardResults.set(ex.provision_id, guardResult);
        record("computed_known_false");
      }
    } else if (quoteMatches) {
      if (guardResult && guardResult.result === "known_false") {
        excludedGuardResults.set(ex.provision_id, guardResult); // computed: a fact
        record("computed_known_false");
      } else if (through) {
        // An applied provision that shares the operator evaluates this one (B1): computed through that operator.
        excludedGuardResults.set(ex.provision_id, {
          provision_id: ex.provision_id,
          result: "known_false",
          guards: [{ clause_id: entry.scope.scope_clause_id, fact: "plan.scope_reading", value: `evaluated through ${through}`, holds: false }],
        });
        record("through_operator");
      } else {
        // P1: the Planner's reading of the scope sentence, not computed. It is recorded as a reading (an event), never
        // as a guard result; the Judge lists it as unchecked unless a person signed a disposition for its scope clause.
        record("planner_reading");
      }
    }
  }

  return {
    plan: repairs.length === 0 ? plan : plan,
    repairs,
    excludedGuardResults,
    exclusions,
  };
}

// ------------------------------------------------------------------ Bare Number Limit Detection (EN-32)

const LIMIT_PARAM_KEYS = ["min", "limit", "share", "cap", "min_front", "cap_cell"] as const;

function detectBareNumberLimit(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  for (const key of LIMIT_PARAM_KEYS) {
    if (key in args && typeof args[key] === "number") {
      return `Tool '${tool}' received a bare number (${String(args[key])}) for parameter '${key}'. Every code limit must be a ParamRef {provision_id, param} or CellRef {provision_id, cell_id} from read_rule_family (EN-32).`;
    }
  }
  if (tool === "find_placements" && Array.isArray(args["setbacks"])) {
    for (const s of args["setbacks"] as Array<Record<string, unknown>>) {
      if (s && typeof s === "object" && typeof s["min"] === "number") {
        return `Tool 'find_placements' received a bare number for setback min (${String(s["min"])}). Must be a resolved parameter (EN-32).`;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ Unsettled facts (gray area, conflict, unknown)

function factRefsIn(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o["fact"] === "string" && Object.keys(o).length === 1) out.push(o["fact"] as string);
      else Object.values(o).forEach(walk);
    }
  };
  walk(args);
  return out;
}

function isUnsettledFact(kase: Record<string, any>, fact: string): boolean {
  const [scope, key] = fact.split(".") as [string, string];
  const e = kase?.[scope]?.[key];
  if (!e || typeof e !== "object") return false;
  return Boolean(e.by_reading) || ["conflicting", "unknown", "unconfirmed"].includes(String(e.status ?? ""));
}

// ------------------------------------------------------------------ Tier 2 graph query (TypeScript tool)

let tier2Graph: ReturnType<typeof connectGraph> | null = null;
async function runQueryCodeGraphTool(args: Record<string, any>, asOf: string): Promise<{ ok: boolean; result?: unknown; error?: { category: string; message: string } }> {
  try {
    tier2Graph ??= connectGraph();
    const req = C.QueryRequest.parse(args);
    return { ok: true, result: await queryCodeGraph(tier2Graph, req, { as_of: asOf }) };
  } catch (e) {
    return { ok: false, error: { category: "tool", message: `query_code_graph failed: ${(e as Error).message.slice(0, 300)}` } };
  }
}
/** B1: may this index provision be excluded on the Planner's quote alone? Only when it is not protected (gate,
 *  operator-backed, modifier), or when an applied provision that shares its operator evaluates it. */
export function exclusionProtection(
  entry: { provision_id: string; evaluation_stage?: string | null; has_operator?: boolean; modifies_operator_backed?: boolean },
  applied: Set<string>, operatorRules: ReturnType<typeof loadProvisionRules>,
): { through: string | undefined; isProtected: boolean } {
  // A gate is never excused through a sibling (B1; L32): each gate is checked itself, even when it shares an operator
  // (Table 110-2 and 33.205.020.B.1.a both read the allowed-use cell, op.adu_allowed, 2026-11-03).
  const through = entry.evaluation_stage === "gate" ? undefined
    : [...(operatorRules.get(entry.provision_id)?.siblings ?? [])].find((x) => applied.has(x));
  const isProtected = !through && (entry.evaluation_stage === "gate" || !!entry.has_operator || !!entry.modifies_operator_backed);
  return { through, isProtected };
}

/** B2: the failing provisions a set of passing exceptions does NOT cure. An exception cures only its own base rule and
 *  the provisions that share that rule's operator. */
export function uncuredFailures(failing: string[], passedBases: string[], operatorRules: ReturnType<typeof loadProvisionRules>): string[] {
  return failing.filter((pid) => !passedBases.some((b) => b === pid || !!operatorRules.get(b)?.siblings.has(pid)));
}

export async function closeTier2Graph(): Promise<void> { if (tier2Graph) { await tier2Graph.driver.close(); tier2Graph = null; } }

// ------------------------------------------------------------------ Main Harness Entrypoint

export async function evaluateDetailed(
  rawCase: unknown,
  opts: EvaluateOptions = {},
): Promise<EvaluateRunResult> {
  const startWallMs = Date.now();
  const budgets: HarnessBudgets = {
    ...DEFAULT_HARNESS_BUDGETS,
    ...(opts.budgets ?? {}),
  };

  // Step 0 — Case Gate (W3)
  const clonedInput = structuredClone(rawCase);
  const gateOut = checkCase(clonedInput);
  if ("refused" in gateOut) {
    throw new Error(
      `Case refused by W3 case-gate (${gateOut.invariant}): ${gateOut.message}`,
    );
  }
  const kase: CaseType = gateOut.case;
  const caseHash: string = gateOut.case_hash;
  materializeComputedFacts(kase as unknown as Record<string, any>);

  const graphReader: GraphReader =
    opts.graphReader ??
    (opts.useAura ? createAuraGraphReader() : createFileGraphReader(opts.fileGraphOptions));
  const ownsGraphReader = !opts.graphReader;

  const modelClient: ModelClient = opts.modelClient ?? new BasetenModelClient();

  try {
    const graphLoadId = await graphReader.graphLoadId();
    const probeBridge = executePythonBridgeBatch([], "0".repeat(64));
    const manifest: ConfigManifestType = {
      prompt_sha256: getRoleAndPrinciplesSha256(),
      ontology_sha256: getOntologySha256(),
      tool_contracts_sha256: getToolContractsSha256(),
      tools_tree: probeBridge.impl_digest,
      slice_sha256: "0".repeat(64),
      index_scope_sha256: "0".repeat(64),
      confirmations_sha256: "0".repeat(64),
      budgets: {
        turns: budgets.max_turns,
        calls: budgets.max_calls,
        tokens: budgets.max_tokens,
        seconds_plan_execute: Math.ceil(budgets.max_plan_execute_ms / 1000),
        seconds_total: Math.ceil(budgets.max_total_ms / 1000),
      },
      tau_policy: "default",
      models: { agent: modelClient.modelId },
      provider_route: "baseten",
    };
    const { config_hash: configHash } = computeConfigHash(manifest);

    const eventLog = new EventLog({
      thread_id: opts.threadId,
      config_hash: configHash,
      graph_load_id: graphLoadId,
      runs_root: opts.runsDir,
    });

    const caseArtifact = eventLog.writeArtifact("case.json", kase);
    eventLog.append("thread_created", {
      case_hash: caseHash,
      case_artifact: caseArtifact,
    });

    // Harness runtime state
    let phase: "plan" | "execute" = "plan";
    let layerIndex: LayerIndexType | null = null;
    let provisionRules: ReturnType<typeof loadProvisionRules> | null = null; // measure 2 (operators.json requires)
    let prematureConcludes = 0;
    const indexEntriesById = new Map<string, IndexEntryType>();
    let acceptedPlan: PlanType | null = null;
    let latestPlanArtifact: ArtifactRefType | null = null;
    const ruleFamilyCache = new Map<string, RuleFamilyType>();
    const resolvedParamsMap = new Map<string, ResolvedParamType>();
    const guardsMap: Record<string, GuardResultType> = {};
    const plannerReadingIds = new Set<string>(); // P1: excluded on the Planner's reading only (never a guard result)
    const acceptedFindings = new Map<string, RecordFindingType>();
    const callResultsMap = new Map<
      string,
      {
        tool: string;
        provision_id: string | null;
        target: TargetType;
        ok: boolean;
        result: unknown;
      }
    >();
    const memoCache = new Map<
      string,
      {
        result: unknown;
        artifact: ArtifactRefType | null;
      }
    >();
    const uncachedSignaturesInPhase = new Map<string, number>();

    let breakerObj: BreakerState = { tripped: false };
    let planLimitFromBreaker: ResolvedParamType | null = null;
    let findPlacementsSummary: PlacementSearchResultType | null = null;
    let concludeCall: ConcludeType | null = null;
    let abnormalEnd = false;

    let totalTurns = 0;
    let totalCalls = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let planRepairsCount = 0;
    let verifyRepairsCount = 0;
    let lastCompactedTurnCount = 0;
    let pendingRepairInstruction: string | null = null;
    const pendingRepairsList: RepairErrorType[] = [];

    const recordResolvedParam = (rp: ResolvedParamType): void => {
      const parsed = C.ResolvedParam.parse(rp);
      resolvedParamsMap.set(`${parsed.provision_id}::${parsed.param}`, parsed);
    };

    const ensureRuleFamily = async (provisionId: string): Promise<RuleFamilyType> => {
      const existing = ruleFamilyCache.get(provisionId);
      if (existing) return existing;
      const fams = await graphReader.readRuleFamily({
        provision_ids: [provisionId],
        as_of: kase.as_of.date,
      });
      const rf = fams[0];
      if (!rf) {
        throw new Error(`Provision '${provisionId}' not found in rule family reader.`);
      }
      ruleFamilyCache.set(provisionId, rf);
      return rf;
    };

    const resolveParamRef = async (ref: unknown, toolName: string, paramKey: string): Promise<ResolvedParamType> => {
      if (typeof ref === "number") {
        throw {
          category: "model" as const,
          code: "BARE_NUMBER_LIMIT",
          message: `Tool '${toolName}' received bare number ${ref} for '${paramKey}'; must be ParamRef {provision_id, param} (EN-32).`,
        };
      }
      const parsedRef = C.ParamRef.parse(ref);
      const rf = await ensureRuleFamily(parsedRef.provision_id);
      const found = rf.params.find((p) => p.name === parsedRef.param);
      if (!found) {
        throw {
          category: "model" as const,
          code: "UNKNOWN_PARAMETER",
          message: `Parameter '${parsedRef.param}' not found in provision '${parsedRef.provision_id}'.`,
        };
      }
      const numVal = typeof found.value === "number" ? found.value : Number(found.value);
      if (!Number.isFinite(numVal)) {
        throw {
          category: "model" as const,
          code: "NON_NUMERIC_PARAMETER",
          message: `Parameter '${parsedRef.provision_id}.${parsedRef.param}' is non-numeric ('${String(found.value)}').`,
        };
      }
      const rp: ResolvedParamType = {
        provision_id: parsedRef.provision_id,
        param: parsedRef.param,
        value: numVal,
        unit: found.unit ?? "ft",
      };
      recordResolvedParam(rp);
      return rp;
    };

    const resolveCellRef = async (
      ref: unknown,
    ): Promise<{ provision_id: string; cell_id: string; row: string; cell: string }> => {
      if (typeof ref === "number") {
        throw {
          category: "model" as const,
          code: "BARE_NUMBER_LIMIT",
          message: `Tool 'total_building_coverage' received bare number ${ref} for 'cap_cell'; must be CellRef {provision_id, cell_id} (EN-32).`,
        };
      }
      const parsedRef = C.CellRef.parse(ref);
      const rf = await ensureRuleFamily(parsedRef.provision_id);
      const lotArea = Number(resolveFactValue(kase as unknown as Record<string, any>, "site.lot_area_sqft") ?? 5000);

      let matched = rf.cells.find(
        (c) =>
          c.cell_id === parsedRef.cell_id ||
          c.cell_id.endsWith(parsedRef.cell_id) ||
          parsedRef.cell_id.endsWith(c.row),
      );
      if (!matched && rf.cells.length > 0) {
        const expectedRowSubstr =
          lotArea < 3000
            ? "Less than 3,000"
            : lotArea < 5000
              ? "3,000 sq. ft. or more"
              : lotArea < 20000
                ? "5,000 sq. ft. or more"
                : "20,000 sq. ft. or more";
        matched = rf.cells.find((c) => c.row.includes(expectedRowSubstr)) ?? rf.cells[0];
      }
      if (!matched) {
        throw {
          category: "model" as const,
          code: "UNKNOWN_CELL",
          message: `Cell '${parsedRef.cell_id}' not found in provision '${parsedRef.provision_id}'.`,
        };
      }
      return {
        provision_id: parsedRef.provision_id,
        cell_id: parsedRef.cell_id,
        row: matched.row,
        cell: matched.text,
      };
    };

    const resolveGeomArg = (geom: z.infer<typeof C.Geom>): unknown => {
      if ("fact" in geom) {
        const val = resolveFactValue(kase as unknown as Record<string, any>, geom.fact);
        if (val === undefined) {
          throw {
            category: "case" as const,
            code: "MISSING_FACT",
            message: `Geometry fact '${geom.fact}' is missing on the case.`,
          };
        }
        return val;
      }
      if ("placed" in geom) {
        const fp = resolveFactValue(
          kase as unknown as Record<string, any>,
          geom.footprint.fact,
        ) as Array<[number, number]> | undefined;
        if (!fp) {
          throw {
            category: "case" as const,
            code: "MISSING_FACT",
            message: `Footprint fact '${geom.footprint.fact}' is missing on the case.`,
          };
        }
        return computePlacedOutline(fp, geom.placed);
      }
      throw {
        category: "model" as const,
        code: "INVALID_GEOM",
        message: `Unrecognized Geom argument: ${JSON.stringify(geom)}`,
      };
    };

    const resolveOutlineListArg = (geoms: Array<z.infer<typeof C.Geom>>): Array<Array<[number, number]>> => {
      const polygons: Array<Array<[number, number]>> = [];
      for (const g of geoms) {
        if ("fact" in g && g.fact === "site.structures") {
          const raw = resolveFactValue(kase as unknown as Record<string, any>, "site.structures");
          polygons.push(...normalizeStructureOutlines(raw));
        } else {
          const val = resolveGeomArg(g);
          if (Array.isArray(val) && val.length > 0 && Array.isArray(val[0]) && typeof val[0][0] === "number") {
            polygons.push(val as Array<[number, number]>);
          } else {
            polygons.push(...normalizeStructureOutlines(val));
          }
        }
      }
      return polygons;
    };
    // Each outline's edge tolerance (ft), parallel to resolveOutlineListArg: a fact's provenance tolerance for every
    // polygon it yields; a placed plan footprint is the plan's own geometry (0).
    const resolveOutlineTolerances = (geoms: Array<z.infer<typeof C.Geom>>): number[] => {
      const tols: number[] = [];
      for (const g of geoms) {
        const n = resolveOutlineListArg([g]).length;
        const tol = "fact" in g && typeof g.fact === "string" ? extractFactToleranceFt(kase as unknown as Record<string, any>, g.fact) : 0;
        for (let i = 0; i < n; i++) tols.push(tol);
      }
      return tols;
    };

    const writeLedgerSnapshot = (trigger: "window" | "phase" | "breaker", turnId: string | null): void => {
      const ctx = buildContextFromLog({
        phase,
        kase,
        events: eventLog.getEvents(),
        plan: acceptedPlan,
        indexStageMap: new Map(
          Array.from(indexEntriesById.entries()).map(([id, e]) => [id, e.evaluation_stage]),
        ),
        ruleFamiliesRead: ruleFamilyCache,
        breaker: breakerObj,
        layerIndex,
        openNotModeled: acceptedPlan
          ? collectUncheckedAndDispositions(
              acceptedPlan.applies.map((a) => a.provision_id),
              ruleFamilyCache,
              buildGuardFacts(kase as unknown as Record<string, any>),
              clauseCoverage(acceptedPlan.applies.map((a) => a.provision_id), OPERATOR_COVERS, [...callResultsMap.entries()].map(([id, c]) => ({ ...c, call_id: id }))),
            ).unchecked.length
          : 0,
      });
      const art = eventLog.writeArtifact("ledger.json", ctx.ledger);
      eventLog.append(
        "lotfit.ledger_compacted",
        {
          ledger_artifact: art,
          trigger,
        },
        turnId,
      );
    };

    // Check stage order for EXECUTE tool calls
    const checkStageOrderAllowed = (
      toolName: string,
      provisionId: string | null,
    ): { allowed: boolean; message?: string } => {
      if (!acceptedPlan) return { allowed: true };
      // Recording a finding is how a gate or plan constraint closes, and conclude ends the phase: never stage-blocked. CC fix.
      if (toolName === "record_finding" || toolName === "conclude") return { allowed: true };

      const getStage = (pid: string): EvaluationStageType => {
        return (
          indexEntriesById.get(pid)?.evaluation_stage ??
          ruleFamilyCache.get(pid)?.evaluation_stage ??
          "placement_constraint"
        );
      };

      const hasFindingOrFalseGuard = (pid: string): boolean => {
        if (guardsMap[pid]?.result === "known_false" || plannerReadingIds.has(pid)) return true;
        for (const f of acceptedFindings.values()) {
          if (f.provision_id === pid) return true;
        }
        return false;
      };

      const plannedIds = acceptedPlan.applies.map((a) => a.provision_id);
      const openGates = plannedIds.filter((pid) => getStage(pid) === "gate" && !hasFindingOrFalseGuard(pid));
      const openPlanConstraints = plannedIds.filter(
        (pid) => getStage(pid) === "plan_constraint" && !hasFindingOrFalseGuard(pid),
      );

      // A call made for a provision is evidence for that provision's own stage: a gate rule checked with check_max
      // (Eugene 9.2741(3), one ADU per dwelling) must not wait for itself. Order is enforced by the provision's stage.
      const ownStage = provisionId !== null ? getStage(provisionId) : null;
      const isPlanConstraintCall =
        ownStage !== "gate" &&
        PLAN_CONSTRAINT_TOOLS.has(toolName) ||
        (provisionId !== null && getStage(provisionId) === "plan_constraint" && toolName !== "read_rule_family" && toolName !== "evaluate_guards");

      const isPlacementCall =
        ownStage !== "gate" && ownStage !== "plan_constraint" &&
        PLACEMENT_TOOLS.has(toolName) ||
        (provisionId !== null &&
          (getStage(provisionId) === "placement_constraint" || getStage(provisionId) === "exception") &&
          toolName !== "read_rule_family" &&
          toolName !== "evaluate_guards");

      if (isPlanConstraintCall && openGates.length > 0) {
        return {
          allowed: false,
          message: `STAGE_ORDER violation: cannot run plan_constraint tool '${toolName}' before gate provision(s) [${openGates.join(", ")}] have recorded findings.`,
        };
      }
      if (isPlacementCall && (openGates.length > 0 || openPlanConstraints.length > 0)) {
        return {
          allowed: false,
          message: `STAGE_ORDER violation: cannot run placement tool '${toolName}' before gate/plan_constraint provision(s) [${[...openGates, ...openPlanConstraints].join(", ")}] have recorded findings.`,
        };
      }
      return { allowed: true };
    };

    // Main PLAN + EXECUTE turn loop
    mainLoop: while (true) {
      const elapsedMs = Date.now() - startWallMs;
      if (
        totalTurns >= budgets.max_turns ||
        totalCalls >= budgets.max_calls ||
        totalTokens >= budgets.max_tokens ||
        elapsedMs >= budgets.max_plan_execute_ms
      ) {
        abnormalEnd = true;
        eventLog.append("error", {
          category: "model",
          code: "BUDGET_EXCEEDED",
          message: `Run exceeded budget (turns=${totalTurns}/${budgets.max_turns}, calls=${totalCalls}/${budgets.max_calls}, tokens=${totalTokens}/${budgets.max_tokens}, elapsed_ms=${elapsedMs}/${budgets.max_plan_execute_ms}).`,
          metadata: { recoverable: false },
        });
        break mainLoop;
      }

      // Check if turn window rolled (more than 2 completed turns since last compaction)
      const currentEvents = eventLog.getEvents();
      const startedTurnCount = currentEvents.filter((e) => e.type === "turn_started").length;
      if (startedTurnCount > 2 && startedTurnCount - lastCompactedTurnCount >= 1) {
        writeLedgerSnapshot("window", null);
        lastCompactedTurnCount = startedTurnCount;
      }

      const currentTurnRepairs = [...pendingRepairsList];
      pendingRepairsList.length = 0;

      const context = buildContextFromLog({
        phase,
        kase,
        events: eventLog.getEvents(),
        plan: acceptedPlan,
        indexStageMap: new Map(
          Array.from(indexEntriesById.entries()).map(([id, e]) => [id, e.evaluation_stage]),
        ),
        ruleFamiliesRead: ruleFamilyCache,
        breaker: breakerObj,
        layerIndex,
        openNotModeled: acceptedPlan
          ? collectUncheckedAndDispositions(
              acceptedPlan.applies.map((a) => a.provision_id),
              ruleFamilyCache,
              buildGuardFacts(kase as unknown as Record<string, any>),
              clauseCoverage(acceptedPlan.applies.map((a) => a.provision_id), OPERATOR_COVERS, [...callResultsMap.entries()].map(([id, c]) => ({ ...c, call_id: id }))),
            ).unchecked.length
          : 0,
        pendingRepairs: currentTurnRepairs,
      });

      const messagesForModel = [...context.messages];
      if (pendingRepairInstruction) {
        messagesForModel.push({
          role: "user",
          content: pendingRepairInstruction,
        });
        pendingRepairInstruction = null;
      }

      let allowedTools = allowedToolsForPhase(phase, breakerObj, kase.mode);
      // No-progress rule (reliability runs: after ~25 turns the model looped on cached reads for 30+ turns, which the
      // stuck rule never sees). Three EXECUTE turns in a row with only reads → the next turn has no read tools and is
      // told to act. Any other call resets it. CC, 11-02.
      if (phase === "execute") {
        const READS = new Set(["read_reading_guide", "inspect_case_facts", "read_layer_index", "read_rule_family", "query_code_graph"]);
        const turns: string[][] = [];
        for (const ev of eventLog.getEvents()) {
          if (ev.type === "turn_started") turns.push([]);
          else if (ev.type === "tool_requested" && turns.length) turns[turns.length - 1]!.push(ev.data.call.tool);
        }
        const last3 = turns.slice(-3);
        if (last3.length === 3 && last3.every((t) => t.every((x) => READS.has(x)))) {
          allowedTools = allowedTools.filter((t) => !READS.has(t));
          messagesForModel.push({ role: "user", content: "You have only been reading for three turns. Reading tools are paused for this turn: act on the Next Step now (run a check, record a finding, or conclude)." });
        }
      }
      const pendingTurnId = makeUuid7();
      const modelResp = await modelClient.complete({
        phase,
        turn_id: pendingTurnId,
        turn_index: totalTurns,
        messages: messagesForModel,
        allowed_tools: allowedTools,
        ledger: context.ledger,
        window_turns: context.windowTurns,
        current_turn_calls: [],
        pending_repairs: currentTurnRepairs,
      });

      totalTurns += 1;
      // L33: the budget counts new tokens only (prompt not served from cache + completion).
      totalTokens += modelResp.usage.prompt_tokens - (modelResp.usage.prompt_cached_tokens ?? 0) + modelResp.usage.completion_tokens;
      if (typeof modelResp.usage.cost_usd === "number") {
        totalCostUsd += modelResp.usage.cost_usd;
      }

      const contentArtifact = modelResp.content
        ? eventLog.writeArtifact(`msg-turn-${totalTurns}.json`, { content: modelResp.content })
        : undefined;

      const { turn_id: turnId } = eventLog.beginTurn({
        phase,
        input_summary: `${phase} turn ${totalTurns}`,
        initial_events: [
          {
            type: "messages",
            data: {
              role: "assistant",
              ...(contentArtifact ? { content_artifact: contentArtifact } : {}),
              usage: modelResp.usage,
            },
          },
        ],
      });
      let turnStatus: "ok" | "repair" | "abnormal" = "ok";

      // In PLAN phase, see if the model submitted a Plan either via a tool call or JSON in content
      const toolCalls: ModelToolCallDraft[] = [...modelResp.tool_calls];
      let inlinePlanCandidate: unknown = undefined;

      if (phase === "plan") {
        const writePlanCallIdx = toolCalls.findIndex(
          (tc) => tc.tool === "write_plan" || tc.tool === "plan" || tc.tool === "submit_plan",
        );
        if (writePlanCallIdx >= 0) {
          const wp = toolCalls.splice(writePlanCallIdx, 1)[0]!;
          inlinePlanCandidate = wp.args["plan"] ?? wp.args;
        } else if (toolCalls.length === 0) {
          // The model often wraps the Plan in a ```json fence (live S1 run 2): take the fenced body, else the outermost
          // {...}. Still parsed strictly; anything else stays a missing plan. CC fix.
          const raw = modelResp.content.trim();
          const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
          const body = fenced ? fenced[1]!.trim() : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
          try {
            inlinePlanCandidate = body.startsWith("{") ? JSON.parse(body) : undefined;
          } catch {
            inlinePlanCandidate = undefined;
          }
        }
      }

      // Execute tool calls in this turn
      for (const tc of toolCalls) {
        if (totalCalls >= budgets.max_calls) {
          abnormalEnd = true;
          turnStatus = "abnormal";
          eventLog.append(
            "error",
            {
              category: "model",
              code: "CALL_BUDGET_EXCEEDED",
              message: `Run exceeded max_calls budget (${budgets.max_calls}).`,
              metadata: { recoverable: false },
            },
            turnId,
          );
          eventLog.endTurn(turnStatus);
          break mainLoop;
        }
        totalCalls += 1;

        const callId = tc.call_id && C.Uuid7.safeParse(tc.call_id).success ? tc.call_id : makeUuid7();
        const rawArgs = (tc.args ?? {}) as Record<string, unknown>;
        const provisionId =
          tc.provision_id ??
          (typeof rawArgs["provision_id"] === "string" ? rawArgs["provision_id"] : null);
        let target: TargetType =
          tc.target ??
          (typeof rawArgs["target"] === "string" &&
          C.Target.safeParse(rawArgs["target"]).success
            ? (rawArgs["target"] as TargetType)
            : "case");
        // Gates and plan constraints are properties of the case, not of a placement: their calls and findings are
        // always target "case" (live S3: a size finding recorded at client_spot hid the gray-area branch). CC, 11-02.
        {
          const st = provisionId ? (indexEntriesById.get(provisionId)?.evaluation_stage ?? ruleFamilyCache.get(provisionId)?.evaluation_stage) : undefined;
          if ((st === "gate" || st === "plan_constraint") && target !== "case") {
            target = "case";
            tc.target = "case";
            if ("target" in rawArgs) rawArgs["target"] = "case";
          }
        }

        const memoKey = `${caseArtifact.sha256}::${graphLoadId}::${configHash}::${tc.tool}::${canonicalJson(rawArgs)}`;
        const isMemoizableTool = tc.tool !== "record_finding" && tc.tool !== "conclude";

        // 1. Check memo cache first (memo hits do NOT trip the stuck rule!)
        if (isMemoizableTool && memoCache.has(memoKey)) {
          const cachedEntry = memoCache.get(memoKey)!;
          eventLog.append(
            "tool_requested",
            {
              call: {
                call_id: callId,
                turn_id: turnId,
                tool: tc.tool as any,
                provision_id: provisionId,
                target,
                args: rawArgs,
              },
            },
            turnId,
          );
          callResultsMap.set(callId, {
            tool: tc.tool,
            provision_id: provisionId,
            target,
            ok: true,
            result: cachedEntry.result,
          });
          eventLog.append(
            "tool_result",
            {
              call_id: callId,
              ok: true,
              cached: true,
              preview: JSON.stringify(cachedEntry.result).slice(0, 2000),
              ...(cachedEntry.artifact ? { result_artifact: cachedEntry.artifact } : {}),
              duration_ms: 0,
            },
            turnId,
          );
          continue;
        }

        // 2. Track uncached call signature for the stuck rule
        const sigKey = `${phase}::${tc.tool}::${canonicalJson(rawArgs)}`;
        const prevCount = uncachedSignaturesInPhase.get(sigKey) ?? 0;
        uncachedSignaturesInPhase.set(sigKey, prevCount + 1);
        if (prevCount >= 1) {
          eventLog.append(
            "tool_requested",
            {
              call: {
                call_id: callId,
                turn_id: turnId,
                tool: tc.tool as any,
                provision_id: provisionId,
                target,
                args: rawArgs,
              },
            },
            turnId,
          );
          eventLog.append(
            "tool_result",
            {
              call_id: callId,
              ok: false,
              cached: false,
              preview: JSON.stringify({ error: "STUCK_RULE: identical uncached call repeated in phase" }),
              duration_ms: 0,
              error: {
                category: "model",
                message: `Stuck rule tripped: identical uncached call to '${tc.tool}' repeated in ${phase}.`,
              },
            },
            turnId,
          );
          eventLog.append(
            "error",
            {
              category: "model",
              code: "STUCK_RULE",
              message: `Model repeated identical uncached call to '${tc.tool}' in phase ${phase}.`,
              metadata: { recoverable: false },
            },
            turnId,
          );
          abnormalEnd = true;
          turnStatus = "abnormal";
          eventLog.endTurn(turnStatus);
          break mainLoop;
        }

        // 3. Check phase tool allow-list (including breaker revocation of placement tools)
        const currentlyAllowed = new Set<string>(allowedToolsForPhase(phase, breakerObj, kase.mode));
        if (!currentlyAllowed.has(tc.tool)) {
          const reasonMsg =
            breakerObj.tripped && PLACEMENT_TOOLS.has(tc.tool)
              ? `Breaker tripped (${breakerObj.stage}): placement tool '${tc.tool}' is revoked.`
              : `Tool '${tc.tool}' is not allowed in phase '${phase}'.`;
          eventLog.append(
            "tool_requested",
            {
              call: {
                call_id: callId,
                turn_id: turnId,
                tool: tc.tool as any,
                provision_id: provisionId,
                target,
                args: rawArgs,
              },
            },
            turnId,
          );
          eventLog.append(
            "tool_result",
            {
              call_id: callId,
              ok: false,
              cached: false,
              preview: JSON.stringify({ error: reasonMsg }),
              duration_ms: 0,
              error: { category: "model", message: reasonMsg },
            },
            turnId,
          );
          eventLog.append(
            "error",
            {
              category: "model",
              code: breakerObj.tripped ? "BREAKER_TOOL_REVOKED" : "PHASE_TOOL_FORBIDDEN",
              message: reasonMsg,
              metadata: { recoverable: true },
            },
            turnId,
          );
          turnStatus = "repair";
          pendingRepairInstruction = reasonMsg;
          continue;
        }

        // 4. Check stage ordering in EXECUTE (`gate` -> `plan_constraint` -> `placement_constraint`)
        if (phase === "execute") {
          const stageCheck = checkStageOrderAllowed(tc.tool, provisionId);
          if (!stageCheck.allowed) {
            eventLog.append(
              "tool_requested",
              {
                call: {
                  call_id: callId,
                  turn_id: turnId,
                  tool: tc.tool as any,
                  provision_id: provisionId,
                  target,
                  args: rawArgs,
                },
              },
              turnId,
            );
            eventLog.append(
              "tool_result",
              {
                call_id: callId,
                ok: false,
                cached: false,
                preview: JSON.stringify({ error: stageCheck.message }),
                duration_ms: 0,
                error: { category: "model", message: stageCheck.message! },
              },
              turnId,
            );
            eventLog.append(
              "error",
              {
                category: "model",
                code: "STAGE_ORDER_VIOLATION",
                message: stageCheck.message!,
                metadata: { recoverable: true },
              },
              turnId,
            );
            turnStatus = "repair";
            pendingRepairInstruction = stageCheck.message!;
            continue;
          }
        }

        // 5. Check bare-number limit refusal (EN-32) before schema parsing
        const bareNumberMsg = detectBareNumberLimit(tc.tool, rawArgs);
        if (bareNumberMsg) {
          eventLog.append(
            "tool_requested",
            {
              call: {
                call_id: callId,
                turn_id: turnId,
                tool: tc.tool as any,
                provision_id: provisionId,
                target,
                args: rawArgs,
              },
            },
            turnId,
          );
          eventLog.append(
            "tool_result",
            {
              call_id: callId,
              ok: false,
              cached: false,
              preview: JSON.stringify({ error: bareNumberMsg }),
              duration_ms: 0,
              error: { category: "model", message: bareNumberMsg },
            },
            turnId,
          );
          eventLog.append(
            "error",
            {
              category: "model",
              code: "BARE_NUMBER_LIMIT",
              message: bareNumberMsg,
              metadata: { recoverable: true },
            },
            turnId,
          );
          turnStatus = "repair";
          pendingRepairInstruction = bareNumberMsg;
          continue;
        }

        // 6. Validate tool arguments against C.TOOL_ARGS
        // record_finding and conclude are harness actions (C4), not C3 tools; their schemas live beside the plan. CC fix.
        // A long free-text note is not worth a refused finding: cut it to the contract's 400 characters (live S7).
        if (tc.tool === "record_finding" && typeof rawArgs["note"] === "string" && (rawArgs["note"] as string).length > 400) {
          rawArgs["note"] = (rawArgs["note"] as string).slice(0, 397) + "...";
        }
        const toolSchema =
          tc.tool === "record_finding" ? C.RecordFinding
          : tc.tool === "conclude" ? C.Conclude
          : (C.TOOL_ARGS as Record<string, z.ZodTypeAny>)[tc.tool];
        if (!toolSchema) {
          const msg = `Unknown tool '${tc.tool}'.`;
          eventLog.append(
            "tool_requested",
            {
              call: {
                call_id: callId,
                turn_id: turnId,
                tool: tc.tool as any,
                provision_id: provisionId,
                target,
                args: rawArgs,
              },
            },
            turnId,
          );
          eventLog.append(
            "tool_result",
            {
              call_id: callId,
              ok: false,
              cached: false,
              preview: JSON.stringify({ error: msg }),
              duration_ms: 0,
              error: { category: "model", message: msg },
            },
            turnId,
          );
          turnStatus = "repair";
          continue;
        }

        const parsedToolArgs = toolSchema.safeParse(rawArgs);
        if (!parsedToolArgs.success) {
          const msg = `Invalid arguments for '${tc.tool}': ${parsedToolArgs.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          eventLog.append(
            "tool_requested",
            {
              call: {
                call_id: callId,
                turn_id: turnId,
                tool: tc.tool as any,
                provision_id: provisionId,
                target,
                args: rawArgs,
              },
            },
            turnId,
          );
          eventLog.append(
            "tool_result",
            {
              call_id: callId,
              ok: false,
              cached: false,
              preview: JSON.stringify({ error: msg }),
              duration_ms: 0,
              error: { category: "model", message: msg },
            },
            turnId,
          );
          eventLog.append(
            "error",
            {
              category: "model",
              code: "INVALID_TOOL_ARGS",
              message: msg,
              metadata: { recoverable: true },
            },
            turnId,
          );
          turnStatus = "repair";
          pendingRepairInstruction = msg;
          continue;
        }

        const validArgs = parsedToolArgs.data as Record<string, any>;
        eventLog.append(
          "tool_requested",
          {
            call: {
              call_id: callId,
              turn_id: turnId,
              tool: tc.tool as any,
              provision_id: provisionId,
              target,
              args: validArgs,
            },
          },
          turnId,
        );

        const callStartMs = Date.now();

        // 7. Dispatch tool
        try {
          if (tc.tool === "read_reading_guide") {
            const guide = await graphReader.readReadingGuide();
            const art = eventLog.writeArtifact("reading-guide.json", guide);
            const previewObj = { id: guide.id, version: guide.version, text: guide.text.slice(0, 1500) };
            memoCache.set(memoKey, { result: guide, artifact: art });
            callResultsMap.set(callId, {
              tool: tc.tool,
              provision_id: null,
              target: "case",
              ok: true,
              result: guide,
            });
            eventLog.append(
              "tool_result",
              {
                call_id: callId,
                ok: true,
                cached: false,
                preview: JSON.stringify(previewObj).slice(0, 2000),
                result_artifact: art,
                duration_ms: Date.now() - callStartMs,
              },
              turnId,
            );
            continue;
          }

          if (tc.tool === "read_layer_index") {
            const idx = await graphReader.readLayerIndex({
              city_layer: String(validArgs["city_layer"]),
              as_of: String(validArgs["as_of"]),
              state_layer: typeof validArgs["state_layer"] === "string" ? validArgs["state_layer"] : undefined,
            });
            layerIndex = idx;
            indexEntriesById.clear();
            for (const l of idx.layers) {
              for (const p of l.provisions) {
                indexEntriesById.set(p.provision_id, p);
              }
            }
            const art = eventLog.writeArtifact("index.json", idx);
            const summaryPreview = {
              graph_load_id: idx.graph_load_id,
              as_of: idx.as_of,
              index_hash: idx.index_hash,
              provision_count: indexEntriesById.size,
              layers: idx.layers.map((l) => ({
                layer: l.layer,
                count: l.provisions.length,
              })),
            };
            memoCache.set(memoKey, { result: summaryPreview, artifact: art });
            callResultsMap.set(callId, {
              tool: tc.tool,
              provision_id: null,
              target: "case",
              ok: true,
              result: idx,
            });
            eventLog.append(
              "tool_result",
              {
                call_id: callId,
                ok: true,
                cached: false,
                preview: JSON.stringify(summaryPreview).slice(0, 2000),
                result_artifact: art,
                duration_ms: Date.now() - callStartMs,
              },
              turnId,
            );
            continue;
          }

          if (tc.tool === "inspect_case_facts") {
            const requestedFacts = Array.isArray(validArgs["facts"])
              ? (validArgs["facts"] as string[])
              : undefined;
            const flat = buildFlatKnownFacts(kase as unknown as Record<string, any>);
            const filtered: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(flat)) {
              if (!requestedFacts || requestedFacts.includes(k)) {
                filtered[k] = C.GEOMETRY_FACTS.includes(k as any) ? { handle: { fact: k } } : v;
              }
            }
            const inspectOut = {
              facts: filtered,
              unknowns: kase.unknowns,
            };
            const art = eventLog.writeArtifact("case-facts.json", inspectOut);
            memoCache.set(memoKey, { result: inspectOut, artifact: art });
            callResultsMap.set(callId, {
              tool: tc.tool,
              provision_id: null,
              target: "case",
              ok: true,
              result: inspectOut,
            });
            eventLog.append(
              "tool_result",
              {
                call_id: callId,
                ok: true,
                cached: false,
                preview: JSON.stringify(inspectOut).slice(0, 2000),
                result_artifact: art,
                duration_ms: Date.now() - callStartMs,
              },
              turnId,
            );
            continue;
          }

          if (tc.tool === "read_rule_family") {
            const pids = validArgs["provision_ids"] as string[];
            const asOf = String(validArgs["as_of"]);
            const families = await graphReader.readRuleFamily({
              provision_ids: pids,
              as_of: asOf,
            });
            for (const f of families) {
              ruleFamilyCache.set(f.provision_id, f);
            }
            const art = eventLog.writeArtifact(`rule-family-${pids[0] ?? "batch"}.json`, families);
            const compactPreview = {
              families: families.map((f) => ({
                provision_id: f.provision_id,
                version_id: f.version_id,
                evaluation_stage: f.evaluation_stage,
                params: f.params.map((p) => ({
                  provision_id: p.provision_id,
                  name: p.name,
                  value: p.value,
                  unit: p.unit,
                })),
                cells: f.cells,
                operators: f.operators,
                modified_by: f.modified_by,
              })),
            };
            memoCache.set(memoKey, { result: compactPreview, artifact: art });
            callResultsMap.set(callId, {
              tool: tc.tool,
              provision_id: pids[0] ?? null,
              target: "case",
              ok: true,
              result: families,
            });
            eventLog.append(
              "tool_result",
              {
                call_id: callId,
                ok: true,
                cached: false,
                preview: JSON.stringify(compactPreview).slice(0, 2000),
                result_artifact: art,
                duration_ms: Date.now() - callStartMs,
              },
              turnId,
            );
            continue;
          }

          if (tc.tool === "record_finding") {
            const rf = validArgs as RecordFindingType;
            const rfRepairs: RepairErrorType[] = [];

            // Validate evidence_call_ids and numbers against callResultsMap
            for (const cid of rf.evidence_call_ids) {
              const c = callResultsMap.get(cid);
              if (!c || !c.ok) {
                rfRepairs.push({
                  code: "V2_EVIDENCE",
                  provision_id: rf.provision_id,
                  target: rf.target,
                  message: `record_finding cites call_id '${cid}' which has no successful tool_result.`,
                });
              }
            }

            for (const numItem of rf.numbers) {
              const c = callResultsMap.get(numItem.call_id);
              if (!c || !c.ok) {
                rfRepairs.push({
                  code: "V2_EVIDENCE",
                  provision_id: rf.provision_id,
                  target: rf.target,
                  message: `Number citation references unsuccessful or missing call_id '${numItem.call_id}'.`,
                });
                continue;
              }
              const resolved = resolvePath(c.result, numItem.path);
              if (
                !resolved.found ||
                typeof resolved.value !== "number" ||
                Math.abs(resolved.value - numItem.value) > 1e-9 ||
                (Math.sign(resolved.value) !== Math.sign(numItem.value) && (resolved.value !== 0 || numItem.value !== 0))
              ) {
                rfRepairs.push({
                  code: "V4_NUMBER",
                  provision_id: rf.provision_id,
                  target: rf.target,
                  message: `Number mismatch at '${numItem.path}' in call '${numItem.call_id}': finding states ${numItem.value}, tool result has ${String(resolved.value)}.`,
                });
              }
            }

            // Code decides the outcome (Martin, 2026-11-02): computed from EVERY result for this provision at this
            // target, not only the cited ones. The model's outcome is replaced and the change noted.
            {
              const argsById = new Map<string, Record<string, unknown>>();
              for (const ev of eventLog.getEvents()) if (ev.type === "tool_requested") argsById.set(ev.data.call.call_id, ev.data.call.args as Record<string, unknown>);
              provisionRules ??= loadProvisionRules(String(resolveFactValue(kase as unknown as Record<string, any>, "site.zone") ?? "unknown"));
              const recompute = () => computeFindingOutcome(
                [...callResultsMap.entries()].map(([cid, c]) => ({ call_id: cid, tool: c.tool, provision_id: c.provision_id, target: c.target, ok: c.ok, result: c.result, args: argsById.get(cid) })),
                rf.provision_id,
                rf.target,
                provisionRules!.get(rf.provision_id) ?? null,
              );
              let computed = recompute();
              // Code runs the missing required checks itself at a known placement (the model proposes; code executes):
              // the client's spot, or the placement the model's selected_placement checks used. Logged as tool calls.
              // CC, 11-02 (reliability runs: the model looped after "run the missing check" repairs).
              if (computed.outcome === null && (computed.missing ?? []).length > 0 && (rf.target === "client_spot" || rf.target === "selected_placement")) {
                let placed: PlacementType | null = null;
                if (rf.target === "client_spot") placed = (resolveFactValue(kase as unknown as Record<string, any>, "plan.placement") as PlacementType | null) ?? null;
                else {
                  for (const [cid, c] of [...callResultsMap.entries()].reverse()) {
                    const pl = (argsById.get(cid)?.["outline"] as { placed?: PlacementType } | undefined)?.placed;
                    if (c.ok && c.target === "selected_placement" && pl) { placed = pl; break; }
                  }
                  // No check at a selected spot yet: the search's nearest clear spot to the client's is the selection.
                  if (!placed && findPlacementsSummary && findPlacementsSummary.clear_count > 0) placed = findPlacementsSummary.nearest_to_client ?? findPlacementsSummary.max_clearance ?? null;
                }
                const footprint = resolveFactValue(kase as unknown as Record<string, any>, "plan.footprint") as Array<[number, number]> | undefined;
                if (placed && footprint) {
                  const outlineXY = computePlacedOutline(footprint, placed);
                  for (const rq of computed.missing ?? []) {
                    if ((rq.tool !== "check_setback" && rq.tool !== "check_front_or_behind") || !rq.param) continue;
                    const [pp, pn] = rq.param.split(":") as [string, string];
                    if (!ruleFamilyCache.has(pp)) await ensureRuleFamily(pp);
                    const lim = await resolveParamRef({ provision_id: pp, param: pn }, rq.tool, "min").catch(() => null);
                    if (!lim) continue;
                    const autoId = makeUuid7();
                    const k = kase as unknown as Record<string, any>;
                    const lf = rq.match?.["lines"] ?? "site.side_lot_lines";
                    const modelArgs: Record<string, unknown> = rq.tool === "check_setback"
                      ? { provision_id: rf.provision_id, target: rf.target, outline: { placed, footprint: { fact: "plan.footprint" } }, lines: { fact: lf }, min: { provision_id: pp, param: pn } }
                      : { provision_id: rf.provision_id, target: rf.target, outline: { placed, footprint: { fact: "plan.footprint" } }, front_lot_line: { fact: "site.front_lot_line" }, min_front: { provision_id: pp, param: pn }, house_rear_wall: { fact: "site.house_rear_wall" } };
                    const bridgeArgs = rq.tool === "check_setback"
                      ? { outline: outlineXY, lines: resolveFactValue(k, lf), min: lim, tolerance_ft: extractFactToleranceFt(k, lf) }
                      : { outline: outlineXY, front_lot_line: resolveFactValue(k, "site.front_lot_line"), min_front: lim, house_rear_wall: resolveFactValue(k, "site.house_rear_wall"),
                          tolerance_ft: Math.max(extractFactToleranceFt(k, "site.front_lot_line"), extractFactToleranceFt(k, "site.house_outline")) };
                    eventLog.append("tool_requested", { call: { call_id: autoId, turn_id: turnId, provision_id: rf.provision_id, target: rf.target, tool: rq.tool as any, args: modelArgs } }, turnId);
                    const t0 = Date.now();
                    const out = executePythonBridgeBatch([{ call_id: autoId, provision_id: rf.provision_id, target: rf.target, tool: rq.tool as any, args: bridgeArgs }], configHash);
                    const item = out.results.get(autoId);
                    callResultsMap.set(autoId, { tool: rq.tool, provision_id: rf.provision_id, target: rf.target, ok: !!item?.ok, result: item?.ok ? item.result : null });
                    argsById.set(autoId, modelArgs);
                    eventLog.append("tool_result", { call_id: autoId, ok: !!item?.ok, cached: false,
                      preview: JSON.stringify(item?.ok ? item.result : { error: item?.error?.message ?? "bridge failed" }).slice(0, 2000), duration_ms: Date.now() - t0,
                      ...(item?.ok ? {} : { error: { category: "tool" as const, message: item?.error?.message ?? "bridge failed" } }) }, turnId);
                  }
                  computed = recompute();
                }
              }
              const pr = provisionRules!.get(rf.provision_id);
              // No instrument in the Rulebook for this provision (L35: a Rulebook-owned NEEDS_CHECK). "Unknown" is the only
              // honest outcome and no measurement can be demanded; the evidence is its evaluate_guards call on this target.
              const guardEvidence = [...callResultsMap.entries()]
                .filter(([, c]) => c.ok && c.tool === "evaluate_guards" && c.provision_id === rf.provision_id)
                .map(([cid]) => cid);
              if (computed.outcome === null && rf.outcome === "unknown" && (!pr || pr.tools.size === 0) && guardEvidence.length === 0) {
                rfRepairs.push({ code: "V1_COVERAGE", provision_id: rf.provision_id, target: rf.target,
                  message: `${rf.provision_id} has no instrument in the Rulebook yet (not modeled). Run evaluate_guards tagged provision_id ${rf.provision_id} target ${rf.target}, then record outcome "unknown" citing that call, with no numbers.` });
              } else if (computed.outcome === null && (!pr || pr.tools.size === 0) && guardEvidence.length > 0 && (rf.outcome === "unknown" || rf.outcome === "pass" || rf.outcome === "fail")) {
                // Build-review follow-up to A1: a provision with no instrument whose guards are not known false is
                // "unknown", whatever the model proposed (code decides; a "pass" cannot be computed). Before, a "pass"
                // drew "run its check first", a check that does not exist, and the Planner looped.
                if (rf.outcome !== "unknown") rf.note = `${rf.note ? rf.note + " | " : ""}code outcome unknown (model said ${rf.outcome}): no instrument, guards not known false`.slice(0, 400);
                rf.outcome = "unknown";
                rf.evidence_call_ids = guardEvidence.slice(-1);
                (rf as any).numbers = [];
                rf.note = `${rf.note ? rf.note + " | " : ""}not modeled: no instrument for this provision in the Rulebook yet`.slice(0, 400);
              } else if (computed.outcome === null) {
                const todo = (computed.missing ?? []).map(describeRequirement);
                rfRepairs.push({
                  code: "V1_COVERAGE",
                  provision_id: rf.provision_id,
                  target: rf.target,
                  message: `${rf.provision_id} at ${rf.target}: ${computed.reason}.` +
                    (todo.length ? ` Run, tagged provision_id ${rf.provision_id} target ${rf.target}: ${todo.join("; ")}. Then record again.` : ` Run its check first, tagged provision_id ${rf.provision_id} target ${rf.target}.`),
                });
              } else {
                if (computed.outcome !== rf.outcome) {
                  const was = rf.outcome;
                  rf.note = `${rf.note ? rf.note + " | " : ""}code outcome ${computed.outcome} (model said ${was}): ${computed.reason}`.slice(0, 400);
                  rf.outcome = computed.outcome;
                }
                rf.evidence_call_ids = [...new Set([...computed.evidence_call_ids])];
              }
            }
            const accepted = rfRepairs.length === 0;
            if (accepted) {
              acceptedFindings.set(`${rf.provision_id}::${rf.target}`, rf);
            }

            callResultsMap.set(callId, {
              tool: tc.tool,
              provision_id: rf.provision_id,
              target: rf.target,
              ok: accepted,
              result: { accepted, repairs: rfRepairs },
            });

            eventLog.append(
              "tool_result",
              {
                call_id: callId,
                ok: accepted,
                cached: false,
                preview: JSON.stringify({ accepted, repairs: rfRepairs }).slice(0, 2000),
                duration_ms: Date.now() - callStartMs,
                ...(accepted
                  ? {}
                  : {
                      error: {
                        category: "model",
                        message: rfRepairs.map((r) => r.message).join("; "),
                      },
                    }),
              },
              turnId,
            );

            eventLog.append(
              "lotfit.finding_recorded",
              {
                finding: rf,
                accepted,
                repairs: rfRepairs,
              },
              turnId,
            );

            if (!accepted) {
              turnStatus = "repair";
              pendingRepairsList.push(...rfRepairs);
              pendingRepairInstruction = `record_finding for ${rf.provision_id} (${rf.target}) was rejected: ${rfRepairs.map((r) => r.message).join("; ")}`;
            }
            continue;
          }

          if (tc.tool === "conclude") {
            const conc = validArgs as ConcludeType;
            // Concluding with open agenda items is a model error, answered with what is open; it does not use up a
            // verify repair (reliability runs: S1 concluded before any client-spot check). CC, 11-02.
            if (acceptedPlan && !breakerObj.tripped) {
              const stageOf2 = (pid: string) => indexEntriesById.get(pid)?.evaluation_stage ?? ruleFamilyCache.get(pid)?.evaluation_stage;
              const hasClient = !!resolveFactValue(kase as unknown as Record<string, any>, "plan.placement");
              const open = acceptedPlan.applies.map((a) => a.provision_id).filter((pid) => {
                if (guardsMap[pid]?.result === "known_false") return false;
                const st = stageOf2(pid);
                if (st === "gate" || st === "plan_constraint") return ![...acceptedFindings.keys()].some((k) => k.startsWith(`${pid}::`));
                if (st === "placement_constraint" && hasClient) return !acceptedFindings.has(`${pid}::client_spot`);
                return false;
              });
              if (open.length > 0 && prematureConcludes < 3) {
                prematureConcludes += 1;
                provisionRules ??= loadProvisionRules(String(resolveFactValue(kase as unknown as Record<string, any>, "site.zone") ?? "unknown"));
                const how = open.slice(0, 6).map((pid) => {
                  const rq = provisionRules!.get(pid)?.requires ?? [];
                  const tools = [...(provisionRules!.get(pid)?.tools ?? [])];
                  return `${pid}: ${rq.length ? rq.map(describeRequirement).join("; ") : tools.length ? tools.join(" or ") : "its check (see the Clauses table), or record unknown"}`;
                });
                const msg = `conclude refused: the agenda is not finished. Still without a finding${hasClient ? " (placement rules at target client_spot, outline {placed: <plan.placement>, footprint: {fact: \"plan.footprint\"}})" : ""}: ${open.join(", ")}. Run, tagged with each provision_id: ${how.join(" | ")}. Then record the findings and conclude.`.slice(0, 1900);
                callResultsMap.set(callId, { tool: tc.tool, provision_id: null, target: "case", ok: false, result: null });
                eventLog.append("tool_result", { call_id: callId, ok: false, cached: false, preview: JSON.stringify({ error: msg }).slice(0, 2000), duration_ms: 0, error: { category: "model", message: msg } }, turnId);
                turnStatus = "repair";
                pendingRepairInstruction = msg;
                continue;
              }
            }
            // A selected placement no placement rule was checked at cannot be recommended: code drops it (the verdict
            // then says so) rather than looping on V1 repairs (live S3/S5). CC, 11-02.
            if (conc.selected_placement && acceptedPlan) {
              const placementIds = acceptedPlan.applies.map((a) => a.provision_id)
                .filter((pid) => (indexEntriesById.get(pid)?.evaluation_stage ?? ruleFamilyCache.get(pid)?.evaluation_stage) === "placement_constraint" && guardsMap[pid]?.result !== "known_false");
              const unchecked = placementIds.filter((pid) => !acceptedFindings.has(`${pid}::selected_placement`));
              if (placementIds.length > 0 && unchecked.length === placementIds.length) {
                conc.selected_placement = null;
                conc.summary = `${conc.summary} [code: the named placement was dropped — no placement rule was checked there]`.slice(0, 2000);
              }
            }
            concludeCall = conc;
            callResultsMap.set(callId, {
              tool: tc.tool,
              provision_id: null,
              target: "case",
              ok: true,
              result: conc,
            });
            eventLog.append(
              "tool_result",
              {
                call_id: callId,
                ok: true,
                cached: false,
                preview: JSON.stringify(conc).slice(0, 2000),
                duration_ms: Date.now() - callStartMs,
              },
              turnId,
            );

            if (!layerIndex) {
              layerIndex = await graphReader.readLayerIndex({
                city_layer: kase.jurisdiction.city_layer,
                state_layer: kase.jurisdiction.state_layer,
                as_of: kase.as_of.date,
              });
              for (const l of layerIndex.layers) {
                for (const p of l.provisions) {
                  indexEntriesById.set(p.provision_id, p);
                }
              }
            }

            if (acceptedPlan) {
              for (const a of acceptedPlan.applies) {
                await ensureRuleFamily(a.provision_id);
              }
            }

            // At conclude time, run verification check to see if a repair turn in EXECUTE is needed
            const preVerify = await buildAndVerifyReport(
              kase,
              caseHash,
              layerIndex,
              indexEntriesById,
              acceptedPlan,
              ruleFamilyCache,
              resolvedParamsMap,
              guardsMap,
              acceptedFindings,
              callResultsMap,
              findPlacementsSummary,
              concludeCall,
              planLimitFromBreaker,
              breakerObj,
              abnormalEnd,
              eventLog,
              configHash,
              {
                tokens: totalTokens,
                calls: totalCalls,
                turns: totalTurns,
                cost_usd: totalCostUsd,
                startWallMs,
                planExecuteEndMs: Date.now(),
                modelId: modelClient.modelId,
              },
              false,
            );

            if (!preVerify.verifyOut.passed && verifyRepairsCount < budgets.max_verify_repairs) {
              verifyRepairsCount += 1;
              turnStatus = "repair";
              uncachedSignaturesInPhase.clear();
              pendingRepairsList.push(...preVerify.verifyOut.issues);
              pendingRepairInstruction = `Verifier found ${preVerify.verifyOut.issues.length} issue(s): ${preVerify.verifyOut.issues.map((i) => `[${i.code}] ${i.message}`).join(" | ")}. Entailed verdict is '${preVerify.entailedVerdict}' and entailed client_spot_passes is '${String(preVerify.entailedClientSpotPasses)}'. Why code entails it: ${preVerify.entailedReasons.length ? preVerify.entailedReasons.join("; ") : "the verdict rules applied to the findings"}. Your conclude must match code. Repair findings if the issues name them, then call conclude() again.`;
              concludeCall = null;
              continue;
            }
            if (!preVerify.verifyOut.passed && verifyRepairsCount >= budgets.max_verify_repairs) {
              abnormalEnd = true;
              turnStatus = "abnormal";
              eventLog.append(
                "error",
                {
                  category: "model",
                  code: "VERIFY_REPAIR_EXHAUSTED",
                  message: `Verifier still failed after ${verifyRepairsCount} repair turn(s): ${preVerify.verifyOut.issues.map((i) => `[${i.code}] ${i.message}`).join("; ")}`,
                  metadata: { recoverable: false },
                },
                turnId,
              );
            }
            eventLog.endTurn(turnStatus);
            break mainLoop;
          }

          // Otherwise: Python bridge tool (`graph/tool_runner.py`)
          const pid = typeof validArgs["provision_id"] === "string" ? validArgs["provision_id"] : provisionId;
          const tTarget: TargetType = (validArgs["target"] as TargetType) ?? target;
          let resolvedBridgeArgs: Record<string, unknown> = {};

          // The Rulebook names each provision's instrument (operators.json). A different measuring tool, or one not built
          // yet, is refused with the way forward, so the Planner never loops on a refusal it cannot read.
          if (tc.tool === "check_solar_shadow") {
            throw { category: "model" as const, code: "TOOL_NOT_BUILT",
              message: `check_solar_shadow is not built yet, so ${pid ?? "this provision"} cannot be measured. Run evaluate_guards tagged provision_id ${pid} target ${tTarget}, record outcome "unknown" citing that call (no numbers), and move on: the Judge reports it as NEEDS_CHECK.` };
          }
          const UTILITY_TOOLS = new Set(["evaluate_guards", "physical_fit", "distance_to_line", "find_placements", "placed_outline"]);
          if (pid && !UTILITY_TOOLS.has(tc.tool)) {
            provisionRules ??= loadProvisionRules(String(resolveFactValue(kase as unknown as Record<string, any>, "site.zone") ?? "unknown"));
            const pr = provisionRules.get(pid);
            if (pr && pr.tools.size > 0 && !pr.tools.has(tc.tool)) {
              const reqs = pr.requires.filter((r) => r.tool).map(describeRequirement);
              const opsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "graph", "curated", "operators.json");
              const ops = (JSON.parse(readFileSyncOps(opsFile, "utf8")).operators as Array<{ id: string; tool: string; reads: string[]; params: Array<{ provision: string; param: string }>; provisions?: string[] }>)
                .filter((o) => o.provisions?.includes(pid));
              const opText = ops.map((o) => `${o.tool} (operator ${o.id}; facts ${o.reads.join(", ")}; parameters ${o.params.map((x) => `${x.provision}:${x.param}`).join(", ")})`).join("; ");
              throw { category: "model" as const, code: "WRONG_INSTRUMENT",
                message: `${pid} is not checked with ${tc.tool}. Its instrument in the Rulebook: ${opText}.` + (reqs.length ? ` Required calls: ${reqs.join("; ")}.` : "") };
            }
          }

          if (tc.tool === "evaluate_guards") {
            const rf = await ensureRuleFamily(pid!);
            const entry = indexEntriesById.get(pid!);
            // AG3: the same facts as exclusions: an unsettled fact never makes a provision not applicable.
            const facts = buildGuardFacts(kase as unknown as Record<string, any>);
            const bridgeGuards = selectBridgeGuardsForProvision(rf, entry, facts);
            resolvedBridgeArgs = {
              provision_id: pid,
              facts,
              guards: bridgeGuards,
            };
          } else if (tc.tool === "adu_max_living_area") {
            const shareParam = await resolveParamRef(validArgs["share"], tc.tool, "share");
            const capParam = await resolveParamRef(validArgs["cap"], tc.tool, "cap");
            const primaryRef = C.FactRef.parse(validArgs["primary_living_area"]);
            const planRef = C.FactRef.parse(validArgs["plan_living_area"]);
            resolvedBridgeArgs = {
              primary_living_area: Number(resolveFactValue(kase as unknown as Record<string, any>, primaryRef.fact)),
              plan_living_area: Number(resolveFactValue(kase as unknown as Record<string, any>, planRef.fact)),
              share: shareParam,
              cap: capParam,
            };
          } else if (tc.tool === "check_allowed") {
            // L32: the cell `<use>.<zone>` from the gate's own rule family; the model names the use, never the answer.
            const zoneRef = C.FactRef.parse(validArgs["zone"]);
            const zone = String(resolveFactValue(kase as unknown as Record<string, any>, zoneRef.fact));
            if (pid && !ruleFamilyCache.has(pid)) await ensureRuleFamily(pid);
            const fam = pid ? ruleFamilyCache.get(pid) : undefined;
            const pname = `${String(validArgs["use"])}.${zone}`;
            const cell = fam?.params.find((p) => p.name === pname);
            if (!cell) {
              throw {
                category: "model" as const,
                code: "ALLOWED_CELL_NOT_FOUND",
                message: `check_allowed: ${pid} has no parameter '${pname}'. Use one of: ${[...new Set((fam?.params ?? []).map((p) => p.name.replace(/\.[^.]+$/, "").replace(/\.R\d.*$/, "")))].slice(0, 12).join(", ")}`,
              };
            }
            resolvedBridgeArgs = { allowed: cell.value, zone, param: pname };
          } else if (tc.tool === "check_max") {
            const limitParam = await resolveParamRef(validArgs["limit"], tc.tool, "limit");
            const rawValArg = validArgs["value"] as Record<string, unknown>;
            let numValue: number;
            let tol = 0;
            if (rawValArg && "fact" in rawValArg) {
              const valRef = C.FactRef.parse(rawValArg);
              numValue = Number(resolveFactValue(kase as unknown as Record<string, any>, valRef.fact));
              tol = extractFactToleranceFt(kase as unknown as Record<string, any>, valRef.fact);
            } else {
              const callRef = C.CallRef.parse(rawValArg);
              const refEntry = callResultsMap.get(callRef.call_id);
              if (!refEntry || !refEntry.ok) {
                throw {
                  category: "model" as const,
                  code: "INVALID_CALL_REF",
                  message: `CallRef '${callRef.call_id}' does not reference a successful tool result.`,
                };
              }
              const resolved = resolvePath(refEntry.result, callRef.path);
              numValue = Number(resolved.value);
            }
            if (!Number.isFinite(numValue)) {
              throw { category: "model" as const, code: "VALUE_NOT_A_NUMBER",
                message: "check_max needs a number: pass a numeric fact (e.g. {fact: 'plan.height_ft'}) or a CallRef {call_id, path} to a number in an earlier result. A shape like plan.footprint is not a number; for its size use footprint_dimensions (or coverage_share for an area share)." };
            }
            resolvedBridgeArgs = {
              value: numValue,
              limit: limitParam,
              tolerance: tol,
              ...(typeof validArgs["dimension_to_tape"] === "string"
                ? { dimension: validArgs["dimension_to_tape"] }
                : {}),
            };
          } else if (tc.tool === "footprint_dimensions") {
            const limitParam = await resolveParamRef(validArgs["limit"], tc.tool, "limit");
            const outline = resolveGeomArg(validArgs["outline"]);
            resolvedBridgeArgs = {
              outline,
              limit: limitParam,
            };
          } else if (tc.tool === "check_setback") {
            const minParam = await resolveParamRef(validArgs["min"], tc.tool, "min");
            const outline = resolveGeomArg(validArgs["outline"]);
            const linesRef = C.FactRef.parse(validArgs["lines"]);
            const linesVal = resolveFactValue(kase as unknown as Record<string, any>, linesRef.fact);
            const tol = extractFactToleranceFt(kase as unknown as Record<string, any>, linesRef.fact);
            resolvedBridgeArgs = {
              outline,
              lines: linesVal,
              min: minParam,
              tolerance_ft: tol,
              ...(typeof validArgs["dimension_to_tape"] === "string"
                ? { dimension: validArgs["dimension_to_tape"] }
                : {}),
            };
          } else if (tc.tool === "check_front_or_behind") {
            const minFrontParam = await resolveParamRef(validArgs["min_front"], tc.tool, "min_front");
            const outline = resolveGeomArg(validArgs["outline"]);
            const frontRef = C.FactRef.parse(validArgs["front_lot_line"]);
            const rearWallRef = C.FactRef.parse(validArgs["house_rear_wall"]);
            const tol = Math.max(
              extractFactToleranceFt(kase as unknown as Record<string, any>, frontRef.fact),
              extractFactToleranceFt(kase as unknown as Record<string, any>, "site.house_outline"),
            );
            resolvedBridgeArgs = {
              outline,
              front_lot_line: resolveFactValue(kase as unknown as Record<string, any>, frontRef.fact),
              min_front: minFrontParam,
              house_rear_wall: resolveFactValue(kase as unknown as Record<string, any>, rearWallRef.fact),
              tolerance_ft: tol,
            };
          } else if (tc.tool === "coverage_share") {
            const limitParam = await resolveParamRef(validArgs["limit"], tc.tool, "limit");
            const outlines = resolveOutlineListArg(validArgs["outlines"]);
            const lotAreaRef = C.FactRef.parse(validArgs["lot_area"]);
            resolvedBridgeArgs = {
              outlines,
              lot_area: Number(resolveFactValue(kase as unknown as Record<string, any>, lotAreaRef.fact)),
              limit: limitParam,
              outline_tolerances_ft: resolveOutlineTolerances(validArgs["outlines"]),
              lot_area_tolerance_sqft: extractFactToleranceFt(kase as unknown as Record<string, any>, lotAreaRef.fact),
            };
          } else if (tc.tool === "total_building_coverage") {
            const resolvedCell = await resolveCellRef(validArgs["cap_cell"]);
            const outlines = resolveOutlineListArg(validArgs["outlines"]);
            const lotAreaRef = C.FactRef.parse(validArgs["lot_area"]);
            resolvedBridgeArgs = {
              outlines,
              lot_area: Number(resolveFactValue(kase as unknown as Record<string, any>, lotAreaRef.fact)),
              cap_cell: resolvedCell,
            };
          } else if (tc.tool === "check_exception_conditions") {
            const excId = String(validArgs["exception_id"]);
            const basePid = String(validArgs["base_provision_id"]);
            const outline = resolveGeomArg(validArgs["outline"]);
            const excRf = await ensureRuleFamily(excId);
            const paramMap: Record<string, unknown> = {};
            for (const p of excRf.params) {
              let val: unknown = p.value;
              if (p.name === "zones_allowing_structures_in_side_rear_setbacks") {
                val =
                  typeof p.value === "string" && p.value.startsWith("[")
                    ? JSON.parse(p.value)
                    : ["R7", "R5", "R2.5"];
              } else if (typeof p.value === "number" || !Number.isNaN(Number(p.value))) {
                val = Number(p.value);
                recordResolvedParam({
                  provision_id: excId,
                  param: p.name,
                  value: Number(p.value),
                  unit: p.unit ?? "ft",
                });
              }
              paramMap[p.name] = {
                provision_id: excId,
                param: p.name,
                value: val,
                unit: p.unit ?? "ft",
              };
            }
            const zone = String(resolveFactValue(kase as unknown as Record<string, any>, "site.zone") ?? "unknown");
            const sideMinParam = await resolveParamRef(
              { provision_id: "PDX.T110-4", param: `side_building_setback.${zone}` },
              tc.tool,
              "side_setback",
            );
            const rearMinParam = await resolveParamRef(
              { provision_id: "PDX.T110-4", param: `rear_building_setback.${zone}` },
              tc.tool,
              "rear_setback",
            );
            const sideLines = (resolveFactValue(
              kase as unknown as Record<string, any>,
              "site.side_lot_lines",
            ) ?? []) as Array<[[number, number], [number, number]]>;
            const rearLine = resolveFactValue(
              kase as unknown as Record<string, any>,
              "site.rear_lot_line",
            ) as [[number, number], [number, number]];

            resolvedBridgeArgs = {
              exception_id: excId,
              base_provision_id: basePid,
              params: paramMap,
              facts: {
                outline,
                zone: isFactUnknown(kase as unknown as Record<string, any>, "site.zone") ? null : zone,
                front_lot_line: resolveFactValue(kase as unknown as Record<string, any>, "site.front_lot_line"),
                side_street_lot_line:
                  resolveFactValue(kase as unknown as Record<string, any>, "site.side_street_lot_line") ?? null,
                corner_lot: isFactUnknown(kase as unknown as Record<string, any>, "site.corner_lot")
                  ? null
                  : (resolveFactValue(kase as unknown as Record<string, any>, "site.corner_lot") ?? false),
                height_ft: isFactUnknown(kase as unknown as Record<string, any>, "plan.height_ft")
                  ? null
                  : resolveFactValue(kase as unknown as Record<string, any>, "plan.height_ft"),
                wall_height_ft: isFactUnknown(kase as unknown as Record<string, any>, "plan.wall_height_ft")
                  ? null
                  : resolveFactValue(kase as unknown as Record<string, any>, "plan.wall_height_ft"),
                plan_kind: resolveFactValue(kase as unknown as Record<string, any>, "plan.kind") ?? "adu",
                openings_facing_lot_line: isFactUnknown(
                  kase as unknown as Record<string, any>,
                  "plan.openings_facing_lot_line",
                )
                  ? null
                  : resolveFactValue(kase as unknown as Record<string, any>, "plan.openings_facing_lot_line"),
                rooftop_deck: isFactUnknown(kase as unknown as Record<string, any>, "plan.rooftop_deck")
                  ? null
                  : resolveFactValue(kase as unknown as Record<string, any>, "plan.rooftop_deck"),
                dormers: isFactUnknown(kase as unknown as Record<string, any>, "plan.dormers")
                  ? null
                  : resolveFactValue(kase as unknown as Record<string, any>, "plan.dormers"),
                structures: normalizeStructureOutlines(
                  resolveFactValue(kase as unknown as Record<string, any>, "site.structures"),
                ),
                setback_lines: [
                  ...(sideLines[0] ? [{ name: "west", line: sideLines[0], min_ft: sideMinParam.value }] : []),
                  ...(sideLines[1] ? [{ name: "east", line: sideLines[1], min_ft: sideMinParam.value }] : []),
                  ...(rearLine ? [{ name: "rear", line: rearLine, min_ft: rearMinParam.value }] : []),
                ],
              },
            };
          } else if (tc.tool === "find_placements") {
            const zone = String(resolveFactValue(kase as unknown as Record<string, any>, "site.zone") ?? "unknown");
            // Portland starts from Table 110-4's base setbacks; any other city starts from 0 and takes every line's
            // minimum from the applied provisions' required checks below (Eugene, 2026-11-02).
            const cityLayer = String((kase as unknown as Record<string, any>)["jurisdiction"]?.["city_layer"] ?? "PDX");
            const base = async (param: string, label: string) => cityLayer === "PDX"
              ? resolveParamRef({ provision_id: "PDX.T110-4", param: `${param}.${zone}` }, tc.tool, label)
              : { provision_id: `${cityLayer}.none`, param: "none", value: 0, unit: "ft" } as Awaited<ReturnType<typeof resolveParamRef>>;
            let frontMin = await base("front_building_setback", "front_setback");
            let sideMin = await base("side_building_setback", "side_setback");
            let rearMin = await base("rear_building_setback", "rear_setback");
            // Measure 2: per lot-line group, the strictest setback among the applied, not-ruled-out provisions'
            // required checks (e.g. a large flag lot's 10 ft on every line, 33.110.255.B.1.a). CC, 11-02.
            {
              provisionRules ??= loadProvisionRules(zone);
              const pids = new Set<string>([...((validArgs["setback_provisions"] as string[] | undefined) ?? []), ...(acceptedPlan?.applies.map((a) => a.provision_id) ?? [])]);
              for (const pid2 of pids) {
                if (guardsMap[pid2]?.result === "known_false") continue;
                for (const rq of provisionRules.get(pid2)?.requires ?? []) {
                  if (rq.tool !== "check_setback" || !rq.param) continue;
                  const [pp, pn] = rq.param.split(":") as [string, string];
                  if (pp === "PDX.T110-4") continue;
                  if (!ruleFamilyCache.has(pp)) await ensureRuleFamily(pp);
                  const r = await resolveParamRef({ provision_id: pp, param: pn }, tc.tool, "setback").catch(() => null);
                  if (!r) continue;
                  const grp = rq.match?.["lines"];
                  if (grp === "site.front_lot_line" && r.value > frontMin.value) frontMin = r;
                  if (grp === "site.side_lot_lines" && r.value > sideMin.value) sideMin = r;
                  if (grp === "site.rear_lot_line" && r.value > rearMin.value) rearMin = r;
                }
              }
            }
            const frontLine = resolveFactValue(kase as unknown as Record<string, any>, "site.front_lot_line");
            const rearLine = resolveFactValue(kase as unknown as Record<string, any>, "site.rear_lot_line");
            const sideLines = (resolveFactValue(
              kase as unknown as Record<string, any>,
              "site.side_lot_lines",
            ) ?? []) as Array<[[number, number], [number, number]]>;
            const fpRef = C.FactRef.parse(validArgs["footprint"]);
            const clientSpot = resolveFactValue(kase as unknown as Record<string, any>, "plan.placement");
            const tol = Math.max(
              extractFactToleranceFt(kase as unknown as Record<string, any>, "site.front_lot_line"),
              extractFactToleranceFt(kase as unknown as Record<string, any>, "site.rear_lot_line"),
              extractFactToleranceFt(kase as unknown as Record<string, any>, "site.side_lot_lines"),
            );
            // B5 (rules-as-data panel, 11-02): an applied, not-ruled-out provision that requires check_front_or_behind
            // (33.205.040.C.2) constrains the search the same way the Judge checks it, so no front-yard spot is offered.
            let frontOrBehind: Record<string, unknown> | null = null;
            {
              const rearWall = resolveFactValue(kase as unknown as Record<string, any>, "site.house_rear_wall");
              for (const pid2 of acceptedPlan?.applies.map((a) => a.provision_id) ?? []) {
                if (frontOrBehind || guardsMap[pid2]?.result === "known_false") continue;
                for (const rq of provisionRules?.get(pid2)?.requires ?? []) {
                  if (rq.tool !== "check_front_or_behind" || !rq.param || !rearWall || !frontLine) continue;
                  const [pp, pn] = rq.param.split(":") as [string, string];
                  if (!ruleFamilyCache.has(pp)) await ensureRuleFamily(pp);
                  const r = await resolveParamRef({ provision_id: pp, param: pn }, tc.tool, "front_or_behind").catch(() => null);
                  if (r) { frontOrBehind = { front_lot_line: frontLine, house_rear_wall: rearWall, min_front: r }; break; }
                }
              }
            }

            resolvedBridgeArgs = {
              lot_outline: resolveFactValue(kase as unknown as Record<string, any>, "site.lot_outline"),
              house_outline: resolveFactValue(kase as unknown as Record<string, any>, "site.house_outline"),
              structures: normalizeStructureOutlines(
                resolveFactValue(kase as unknown as Record<string, any>, "site.structures"),
              ),
              footprint: resolveFactValue(kase as unknown as Record<string, any>, fpRef.fact),
              tolerance_ft: tol,
              ...(Array.isArray(validArgs["rotations"]) ? { rotations: validArgs["rotations"] } : {}),
              setbacks: [
                { line: frontLine, min: frontMin },
                { line: rearLine, min: rearMin },
                ...sideLines.map((line) => ({ line, min: sideMin })),
              ],
              ...(clientSpot ? { client_spot: clientSpot } : {}),
              ...(frontOrBehind ? { front_or_behind: frontOrBehind } : {}),
            };
          } else if (tc.tool === "placed_outline") {
            const fpRef = C.FactRef.parse(validArgs["footprint"]);
            resolvedBridgeArgs = {
              footprint: resolveFactValue(kase as unknown as Record<string, any>, fpRef.fact),
              placement: validArgs["placement"],
            };
          } else if (tc.tool === "physical_fit") {
            resolvedBridgeArgs = {
              lot_outline: resolveFactValue(kase as unknown as Record<string, any>, "site.lot_outline"),
              house_outline: resolveFactValue(kase as unknown as Record<string, any>, "site.house_outline"),
              structures: normalizeStructureOutlines(
                resolveFactValue(kase as unknown as Record<string, any>, "site.structures"),
              ),
              outline: resolveGeomArg(validArgs["outline"]),
            };
          } else if (tc.tool === "distance_to_line") {
            const lineRef = C.FactRef.parse(validArgs["line"]);
            resolvedBridgeArgs = {
              outline: resolveGeomArg(validArgs["outline"]),
              line: resolveFactValue(kase as unknown as Record<string, any>, lineRef.fact),
            };
          }

          // query_code_graph is a TypeScript tool (guard-cypher.mts, Tier 2), not a Python one: run it here against
          // Aura through the guard. CC fix, live S1 diagnostic run.
          const item: any =
            tc.tool === "query_code_graph"
              ? await runQueryCodeGraphTool(validArgs, kase.as_of.date)
              : executePythonBridgeBatch(
                  [
                    {
                      call_id: callId,
                      provision_id: pid ?? null,
                      target: tTarget,
                      tool: tc.tool as z.infer<typeof C.ToolName>,
                      args: resolvedBridgeArgs,
                    },
                  ],
                  configHash,
                ).results.get(callId);
          if (!item || !item.ok) {
            const rawCat = item?.error?.category;
            const errCat: z.infer<typeof C.ErrorCategory> =
              rawCat === "model" ? "model" : rawCat === "input" ? "case" : "tool";
            const errMsg = item?.error?.message ?? `Bridge call '${tc.tool}' failed.`;
            callResultsMap.set(callId, {
              tool: tc.tool,
              provision_id: pid ?? null,
              target: tTarget,
              ok: false,
              result: null,
            });
            eventLog.append(
              "tool_result",
              {
                call_id: callId,
                ok: false,
                cached: false,
                preview: JSON.stringify({ error: errMsg }).slice(0, 2000),
                duration_ms: Date.now() - callStartMs,
                error: { category: errCat, message: errMsg },
              },
              turnId,
            );
            eventLog.append(
              "error",
              {
                category: errCat,
                code: "BRIDGE_CALL_ERROR",
                message: errMsg,
                metadata: { recoverable: true },
              },
              turnId,
            );
            turnStatus = "repair";
            pendingRepairInstruction = errMsg;
            continue;
          }

          let resultPayload: unknown = item.result;
          let artifactRef: ArtifactRefType | null = null;

          // Post-process specific bridge tools
          if (tc.tool === "total_building_coverage" || tc.tool === "adu_max_living_area") {
            const mr = C.MeasureResult.parse(resultPayload);
            if (mr.limit) {
              recordResolvedParam(mr.limit);
            }
            resultPayload = mr;
          } else if (tc.tool === "evaluate_guards") {
            const gr = C.GuardResult.parse(resultPayload);
            guardsMap[gr.provision_id] = gr;
            resultPayload = gr;
          } else if (tc.tool === "find_placements") {
            const rawPlacementOut = resultPayload as {
              summary: Record<string, unknown>;
              candidates: unknown[];
            };
            artifactRef = eventLog.writeArtifact("placements.json", rawPlacementOut);
            const summaryWithArtifact = C.PlacementSearchResult.parse({
              ...rawPlacementOut.summary,
              envelope_artifact: artifactRef.path,
            });
            findPlacementsSummary = summaryWithArtifact;
            resultPayload = summaryWithArtifact;
          }

          memoCache.set(memoKey, { result: resultPayload, artifact: artifactRef });
          callResultsMap.set(callId, {
            tool: tc.tool,
            provision_id: pid ?? null,
            target: tTarget,
            ok: true,
            result: resultPayload,
          });

          eventLog.append(
            "tool_result",
            {
              call_id: callId,
              ok: true,
              cached: false,
              preview: JSON.stringify(resultPayload).slice(0, 2000),
              ...(artifactRef ? { result_artifact: artifactRef } : {}),
              duration_ms: item.duration_ms ?? Date.now() - callStartMs,
            },
            turnId,
          );

          // Check breaker trip (`gate` or `plan_constraint` failure)
          const stageOfProvision =
            (pid ? indexEntriesById.get(pid)?.evaluation_stage : undefined) ??
            (pid ? ruleFamilyCache.get(pid)?.evaluation_stage : undefined);

          // A guard known false means the provision does not apply (a not_applicable finding, §8 F13), never a failed
          // gate. The breaker keys on a result tagged to a gate with pass: false (§3 step 2, F5). CC fix, run 4.
          if (
            !breakerObj.tripped &&
            stageOfProvision === "gate" &&
            pid &&
            acceptedPlan?.applies.some((a) => a.provision_id === pid) &&
            resultPayload &&
            typeof resultPayload === "object" &&
            (resultPayload as Record<string, unknown>)["pass"] === false
          ) {
            {
              breakerObj = {
                tripped: true,
                stage: "gate",
                provision_id: pid,
                call_id: callId,
                limit: null,
              };
              writeLedgerSnapshot("breaker", turnId);
            }
          } else if (
            !breakerObj.tripped &&
            // The provision's stage decides, not the tool: check_max on a placement rule (S3: 245.C.4's height
            // threshold) is not a failed plan constraint. CC, 11-02.
            (stageOfProvision === "plan_constraint" || (stageOfProvision === undefined && PLAN_CONSTRAINT_TOOLS.has(tc.tool))) &&
            resultPayload &&
            typeof resultPayload === "object" &&
            (resultPayload as Record<string, unknown>)["pass"] === false &&
            // A failure that rests on a gray area or a conflicting/unknown fact is not decisive: no breaker, so the
            // other branch keeps its placement checks and SENSITIVITY can entail FITS_IF / NEEDS_CHECK (S3, S4). CC.
            !factRefsIn(validArgs).some((f) => isUnsettledFact(kase as unknown as Record<string, any>, f))
          ) {
            const mr = resultPayload as MeasureResultType;
            if (mr.limit) {
              planLimitFromBreaker = mr.limit;
            }
            breakerObj = {
              tripped: true,
              stage: "plan_constraint",
              provision_id: pid ?? mr.limit?.provision_id ?? "unknown",
              call_id: callId,
              limit: mr.limit ?? null,
            };
            writeLedgerSnapshot("breaker", turnId);
          }
        } catch (err: any) {
          const cat: z.infer<typeof C.ErrorCategory> =
            err &&
            typeof err === "object" &&
            (err.category === "model" || err.category === "case" || err.category === "tool" || err.category === "harness")
              ? err.category
              : "tool";
          const code = err && typeof err === "object" && typeof err.code === "string" ? err.code : "TOOL_EXECUTION_ERROR";
          const msg = err && typeof err === "object" && typeof err.message === "string" ? err.message : String(err);

          callResultsMap.set(callId, {
            tool: tc.tool,
            provision_id: provisionId,
            target,
            ok: false,
            result: null,
          });
          eventLog.append(
            "tool_result",
            {
              call_id: callId,
              ok: false,
              cached: false,
              preview: JSON.stringify({ error: msg }).slice(0, 2000),
              duration_ms: Date.now() - callStartMs,
              error: { category: cat, message: msg },
            },
            turnId,
          );
          eventLog.append(
            "error",
            {
              category: cat,
              code,
              message: msg,
              metadata: { recoverable: true },
            },
            turnId,
          );
          turnStatus = "repair";
          pendingRepairInstruction = msg;
        }
      }

      // If in PLAN phase and the model provided a Plan candidate, validate it
      if (phase === "plan" && inlinePlanCandidate !== undefined) {
        if (!layerIndex) {
          layerIndex = await graphReader.readLayerIndex({
            city_layer: kase.jurisdiction.city_layer,
            state_layer: kase.jurisdiction.state_layer,
            as_of: kase.as_of.date,
          });
          for (const l of layerIndex.layers) {
            for (const p of l.provisions) {
              indexEntriesById.set(p.provision_id, p);
            }
          }
        }

        const validation = await validatePlanAgainstIndex(
          inlinePlanCandidate,
          layerIndex,
          kase as unknown as Record<string, any>,
          graphReader,
          ruleFamilyCache,
          configHash,
        );

        const planPayloadToWrite = validation.plan ?? inlinePlanCandidate;
        latestPlanArtifact = eventLog.writeArtifact("plan.json", planPayloadToWrite);
        const isValid = validation.repairs.length === 0 && validation.plan !== null;

        eventLog.append(
          "lotfit.plan_written",
          {
            plan_artifact: latestPlanArtifact,
            valid: isValid,
            repairs: validation.repairs,
          },
          turnId,
        );

        if (isValid && validation.plan) {
          acceptedPlan = validation.plan;
          for (const [pid, gr] of validation.excludedGuardResults.entries()) {
            guardsMap[pid] = gr;
          }
          // P2: the basis of every exclusion goes into the Record (the Reviewer and the Judge read it from there).
          for (const exr of validation.exclusions) {
            eventLog.append("lotfit.exclusion_recorded", exr, turnId);
            if (exr.basis === "planner_reading") plannerReadingIds.add(exr.provision_id);
          }
          phase = "execute";
          uncachedSignaturesInPhase.clear();
          writeLedgerSnapshot("phase", turnId);
        } else {
          planRepairsCount += 1;
          turnStatus = "repair";
          pendingRepairsList.push(...validation.repairs);
          if (planRepairsCount > budgets.max_plan_repairs) {
            abnormalEnd = true;
            turnStatus = "abnormal";
            eventLog.append(
              "error",
              {
                category: "model",
                code: "PLAN_REPAIR_EXHAUSTED",
                message: `Plan validation failed after ${planRepairsCount} attempt(s): ${validation.repairs.map((r) => `[${r.code}] ${r.message}`).join("; ")}`,
                metadata: { recoverable: false },
              },
              turnId,
            );
            eventLog.endTurn(turnStatus);
            break mainLoop;
          }
          pendingRepairInstruction = `Plan validation failed with ${validation.repairs.length} error(s): ${validation.repairs.map((r) => `[${r.code}] (${r.provision_id ?? "plan"}): ${r.message}`).join(" | ")}. Please submit a repaired Plan.`;
        }
      } else if (phase === "plan" && toolCalls.length === 0 && inlinePlanCandidate === undefined) {
        planRepairsCount += 1;
        turnStatus = "repair";
        if (planRepairsCount > budgets.max_plan_repairs) {
          abnormalEnd = true;
          turnStatus = "abnormal";
          eventLog.append(
            "error",
            {
              category: "model",
              code: "PLAN_MISSING",
              message: "Model did not call a tool or submit a valid Plan JSON in PLAN phase.",
              metadata: { recoverable: false },
            },
            turnId,
          );
          eventLog.endTurn(turnStatus);
          break mainLoop;
        }
        pendingRepairInstruction =
          "In PLAN phase you must call read_reading_guide / read_layer_index / inspect_case_facts and then output a valid Plan JSON object.";
      }

      eventLog.endTurn(turnStatus);
    }

    const planExecuteEndMs = Date.now();

    // Ensure layerIndex is loaded even if the run ended abnormally before read_layer_index
    if (!layerIndex) {
      layerIndex = await graphReader.readLayerIndex({
        city_layer: kase.jurisdiction.city_layer,
        state_layer: kase.jurisdiction.state_layer,
        as_of: kase.as_of.date,
      });
      for (const l of layerIndex.layers) {
        for (const p of l.provisions) {
          indexEntriesById.set(p.provision_id, p);
        }
      }
    }

    // Ensure rule families for all applied provisions are in cache so dispositions/unchecked clauses are complete
    if (acceptedPlan) {
      for (const a of acceptedPlan.applies) {
        await ensureRuleFamily(a.provision_id);
      }
    }

    // Step 3 (SENSITIVITY), Step 4 (VERDICT), Step 5 (VERIFY), Step 6 (PROPOSE Report + W8 Trace)
    const finalized = await buildAndVerifyReport(
      kase,
      caseHash,
      layerIndex,
      indexEntriesById,
      acceptedPlan,
      ruleFamilyCache,
      resolvedParamsMap,
      guardsMap,
      acceptedFindings,
      callResultsMap,
      findPlacementsSummary,
      concludeCall,
      planLimitFromBreaker,
      breakerObj,
      abnormalEnd,
      eventLog,
      configHash,
      {
        tokens: totalTokens,
        calls: totalCalls,
        turns: totalTurns,
        cost_usd: totalCostUsd,
        startWallMs,
        planExecuteEndMs,
        modelId: modelClient.modelId,
      },
      true,
    );

    // Step 7 — REVIEW (the Reviewer, L35 §3.8; EN-24; L42). Once, after the final report and before report.json and the
    // trace are written (B1: never inside EXECUTE; buildAndVerifyReport also runs at conclude time). Only `reviewer` and
    // `telemetry.models.reviewer` change (B2).
    // Build-review A12/S8: the review is contained. Any failure in it becomes a not_run review with the reason, never a lost
    // run; the rubric is read only when a Reviewer is configured. A19/S17: "no Reviewer configured" is not an abnormal turn.
    {
      const { turn_id: reviewTurn } = eventLog.beginTurn({ phase: "verify", input_summary: opts.reviewerClient ? "Reviewer" : "Reviewer: none configured" });
      let o: z.infer<typeof C.ReviewOutcome>;
      try {
        if (!opts.reviewerClient) {
          o = (await review({ items: [], client: null, plannerModel: modelClient.modelId, verdict: finalized.report.verdict,
            kase: kase as unknown as Record<string, any>, rubric: { id: "lotfit.reviewer-rubric", version: "none", sha256: "0".repeat(64), enabled: new Set(),
              reviewed_stages: new Set(), severity: [], min_quote_chars: 20, system: "" } })).outcome;
        } else {
          const rubric = loadRubric();
          const items = buildReviewItems({ events: eventLog.getEvents(), index: indexEntriesById, ruleFamilies: ruleFamilyCache,
            kase: kase as unknown as Record<string, any>,
            run: { thread_id: eventLog.thread_id, graph_load_id: eventLog.graph_load_id, config_hash: configHash, as_of: String((kase as any).as_of?.date ?? layerIndex.as_of) },
            rubric });
          const rv = await review({ items, client: opts.reviewerClient, plannerModel: modelClient.modelId, verdict: finalized.report.verdict,
            kase: kase as unknown as Record<string, any>, rubric });
          for (const c of rv.calls) {
            const art = eventLog.writeArtifact(`review-${c.item.provision.provision_id}.json`, { item: c.item, content: c.content });
            eventLog.append("messages", { role: "assistant", content_artifact: art, usage: c.usage }, reviewTurn);
          }
          o = rv.outcome;
        }
      } catch (e) {
        let model = "unknown";
        try { model = opts.reviewerClient?.modelId ?? "none"; } catch { /* a broken client: the name is not readable either */ }
        o = C.ReviewOutcome.parse({ status: "not_run", answered: 0, warnings: [], model,
          rubric: { id: "lotfit.reviewer-rubric", version: "unknown", sha256: "0".repeat(64) }, items: 0, flags: [], sound: [], unclear: [], rejected: [],
          hold: false, error: { category: "harness", message: `the review failed: ${String((e as Error)?.message ?? e).slice(0, 300)}` }, usage: [] });
      }
      eventLog.append("lotfit.reviewer_completed", { status: o.status, model: o.model, items: o.items, answered: o.answered ?? 0,
        flags_high: o.flags.filter((f) => f.severity === "high").length, flags_medium: o.flags.filter((f) => f.severity === "medium").length,
        flags_low: o.flags.filter((f) => f.severity === "low").length, confirmed: o.flags.filter((f) => f.confirmed).length,
        rejected: o.rejected.length, hold: o.hold, usage: o.usage }, reviewTurn);
      eventLog.endTurn(o.status === "not_run" && opts.reviewerClient ? "abnormal" : "ok");
      finalized.report = mergeReview(finalized.report, o, !!opts.reviewerClient);
    }

    // A refused trace must not lose the run: keep the report (flagged abnormal), skip trace.json.
    let trace: TraceType;
    try {
      trace = compileTrace(finalized.report, kase);
      eventLog.writeArtifact("trace.json", trace);
    } catch (e) {
      eventLog.append("error", {
        category: "harness",
        code: "TRACE_REFUSED",
        message: (e as Error)?.message ?? String(e),
        metadata: { recoverable: false },
      });
      (finalized.report as unknown as Record<string, unknown>).abnormal_end = true;
      trace = null as unknown as TraceType;
    }

    const reportArtifact = eventLog.writeArtifact("report.json", finalized.report);
    void reportArtifact;

    return {
      report: finalized.report,
      trace,
      events: eventLog.getEvents(),
      thread_id: eventLog.thread_id,
      run_dir: eventLog.run_dir,
      plan: acceptedPlan,
      sensitivity: finalized.sensitivity,
    };
  } finally {
    if (ownsGraphReader) {
      await graphReader.close();
    }
  }
}

export async function evaluate(
  rawCase: unknown,
  opts: EvaluateOptions = {},
): Promise<ReportType> {
  const res = await evaluateDetailed(rawCase, opts);
  return res.report;
}

// ------------------------------------------------------------------ Report Assembly, Sensitivity, Verdict & Verifier

async function buildAndVerifyReport(
  kase: CaseType,
  caseHash: string,
  layerIndex: LayerIndexType,
  indexEntriesById: Map<string, IndexEntryType>,
  acceptedPlan: PlanType | null,
  ruleFamilyCache: Map<string, RuleFamilyType>,
  resolvedParamsMap: Map<string, ResolvedParamType>,
  guardsMap: Record<string, GuardResultType>,
  acceptedFindings: Map<string, RecordFindingType>,
  callResultsMap: Map<
    string,
    {
      tool: string;
      provision_id: string | null;
      target: TargetType;
      ok: boolean;
      result: unknown;
    }
  >,
  findPlacementsSummary: PlacementSearchResultType | null,
  concludeCall: ConcludeType | null,
  planLimitFromBreaker: ResolvedParamType | null,
  breakerObj: BreakerState,
  abnormalEnd: boolean,
  eventLog: EventLog,
  configHash: string,
  telemetryInfo: {
    tokens: number;
    calls: number;
    turns: number;
    cost_usd: number;
    startWallMs: number;
    planExecuteEndMs: number;
    modelId: string;
  },
  emitEvents: boolean,
): Promise<{
  report: ReportType;
  sensitivity: SensitivityType;
  verifyOut: { passed: boolean; issues: RepairErrorType[] };
  entailedVerdict: VerdictType;
  entailedClientSpotPasses: boolean | null;
  entailedReasons: string[];
}> {
  const verdictReasons: string[] = []; // why code entails its verdict, in order (sent with every verdict repair)
  const flatFacts = buildFlatKnownFacts(kase as unknown as Record<string, any>);

  // Build ReportFinding[] from acceptedFindings + callResultsMap
  const reportFindings: ReportFindingType[] = [];
  const sensitivityFindings: FindingInput[] = [];

  for (const rf of acceptedFindings.values()) {
    const entry = indexEntriesById.get(rf.provision_id);
    const fam = ruleFamilyCache.get(rf.provision_id);
    const stage: EvaluationStageType =
      entry?.evaluation_stage ?? fam?.evaluation_stage ?? "placement_constraint";

    const measures: MeasureResultType[] = [];
    for (const cid of rf.evidence_call_ids) {
      const callEntry = callResultsMap.get(cid);
      if (!callEntry || !callEntry.ok || !callEntry.result) continue;
      const parsedMeasure = C.MeasureResult.safeParse(callEntry.result);
      if (parsedMeasure.success) {
        measures.push(parsedMeasure.data);
      } else {
        const parsedExc = C.ExceptionResult.safeParse(callEntry.result);
        if (parsedExc.success) {
          for (const cond of parsedExc.data.conditions) {
            if (cond.measure) {
              measures.push(cond.measure);
            }
          }
        }
      }
    }

    const paramsForFinding: ResolvedParamType[] = [];
    const seenParamKeys = new Set<string>();
    for (const m of measures) {
      if (m.limit) {
        const pk = `${m.limit.provision_id}::${m.limit.param}`;
        if (!seenParamKeys.has(pk)) {
          seenParamKeys.add(pk);
          paramsForFinding.push(m.limit);
        }
      }
    }

    const repFinding = C.ReportFinding.parse({
      provision_id: rf.provision_id,
      target: rf.target,
      evaluation_stage: stage,
      outcome: rf.outcome,
      citations: rf.quotes.map((q) => ({
        document: fam?.version_id ?? `${rf.provision_id}#v1`,
        page: null,
        clause_id: q.clause_id,
        quote: q.quote,
        sha256: fam?.sha256 ?? "0".repeat(64),
      })),
      params: paramsForFinding,
      measures,
      confirmation: "confirmed",
      evidence_call_ids: rf.evidence_call_ids,
    });
    reportFindings.push(repFinding);

    sensitivityFindings.push({
      provision_id: rf.provision_id,
      target: rf.target,
      evaluation_stage: stage,
      outcome: rf.outcome,
      clause_ids: rf.clause_ids,
      measures,
    });
  }

  // Fresh geometry re-check on conclude.selected_placement so report.placement.recommended.margins comes from code
  const selectedPlacement: PlacementType | null = concludeCall?.selected_placement ?? null;
  let recommendedMargins: MeasureResultType[] = [];
  if (selectedPlacement) {
    recommendedMargins = recheckSelectedPlacementMargins(
      kase as unknown as Record<string, any>,
      selectedPlacement,
      reportFindings,
      resolvedParamsMap,
      configHash,
    );
  }

  // Step 3 — SENSITIVITY (W5)
  const fallbackPlan: PlanType =
    acceptedPlan ?? {
      index_hash: layerIndex.index_hash,
      applies: [],
      excluded_at_index: [],
      order: [],
    };

  const sensitivity = runSensitivity({
    case: kase,
    findings: sensitivityFindings,
    plan: fallbackPlan,
    selected_placement: selectedPlacement,
  });

  if (emitEvents) {
    const sensArt = eventLog.writeArtifact("sensitivity.json", sensitivity);
    eventLog.append("lotfit.sensitivity_completed", {
      sensitivity_artifact: sensArt,
      critical: sensitivity.critical.length,
      model_turns: 0,
    });
  }

  // Compute entailed client_spot_passes and rejected_exceptions
  const clientRelevant = reportFindings.filter(
    (f) =>
      (f.target === "client_spot" || f.target === "case") &&
      f.evaluation_stage !== "exception" &&
      f.outcome !== "not_applicable",
  );
  const passingExceptionBases = new Set<string>();
  const rejectedExceptions: string[] = [];

  for (const f of reportFindings) {
    if ((f.target === "client_spot" || f.target === "case") && f.evaluation_stage === "exception") {
      for (const cid of f.evidence_call_ids) {
        const c = callResultsMap.get(cid);
        const parsedExc = c?.ok ? C.ExceptionResult.safeParse(c.result) : null;
        if (parsedExc?.success) {
          if (parsedExc.data.pass === true && f.outcome === "pass") {
            passingExceptionBases.add(parsedExc.data.base_provision_id);
          } else if (parsedExc.data.pass === false) {
            if (!rejectedExceptions.includes(parsedExc.data.exception_id)) {
              rejectedExceptions.push(parsedExc.data.exception_id);
            }
          }
        }
      }
    }
  }
  const uncuredClient = clientRelevant.filter(
    (f) => !(f.outcome === "fail" && passingExceptionBases.has(f.provision_id)),
  );
  const clientOutcomes = uncuredClient.map((f) => f.outcome);
  let entailedClientSpotPasses: boolean | null =
    uncuredClient.length === 0
      ? null
      : clientOutcomes.includes("fail")
        ? false
        : clientOutcomes.includes("unknown") || clientOutcomes.includes("too_close_to_call")
          ? null
          : true;
  // Code re-checks the client's spot from scratch (Martin, 2026-11-02): a failing margin there, not cured by a passing
  // exception, makes client_spot_passes false whatever the findings say.
  const clientPlacementFact = resolveFactValue(kase as unknown as Record<string, any>, "plan.placement") as PlacementType | null | undefined;
  let clientRecheckFailing: string[] = [];
  if (clientPlacementFact && typeof clientPlacementFact === "object" && "x" in clientPlacementFact) {
    const clientMargins = recheckSelectedPlacementMargins(kase as unknown as Record<string, any>, clientPlacementFact, reportFindings, resolvedParamsMap, configHash);
    // B2 (rules-as-data panel, 2026-11-02): a passing exception cures only its own base rule and the provisions that share
    // its operator (220.B ↔ Table 110-4), never every failing margin at the spot.
    const passedBases = [...callResultsMap.values()]
      .filter((c) => c.ok && c.target === "client_spot" && c.tool === "check_exception_conditions" && (c.result as any)?.pass === true)
      .map((c) => String((c.result as any)?.base_provision_id ?? ""));
    const familyRules = loadProvisionRules(String(resolveFactValue(kase as unknown as Record<string, any>, "site.zone") ?? "unknown"));
    clientRecheckFailing = uncuredFailures(clientMargins.filter((m) => m.pass === false).map((m) => m.limit?.provision_id ?? "unknown"), passedBases, familyRules);
    // B4: with no zone, the zone's setbacks cannot be re-checked, so the client's spot cannot be called a pass.
    if (resolveFactValue(kase as unknown as Record<string, any>, "site.zone") == null && entailedClientSpotPasses === true) {
      entailedClientSpotPasses = null;
      verdictReasons.push("site.zone unknown: the zone's setbacks cannot be re-checked → client_spot_passes unknown");
    }
    const byReq = recheckByRequirements(kase as unknown as Record<string, any>, clientPlacementFact, "client_spot", acceptedPlan, ruleFamilyCache, guardsMap, callResultsMap, configHash);
    clientRecheckFailing = [...new Set([...clientRecheckFailing, ...byReq.failing])];
    if (clientRecheckFailing.length > 0) {
      entailedClientSpotPasses = false;
      verdictReasons.push(`code re-check of the client's spot fails: ${clientRecheckFailing.join(", ")} → client_spot_passes false`);
    }
  }

  const clientFailingProvisions = [...new Set([
    ...uncuredClient.filter((f) => f.outcome === "fail").map((f) => f.provision_id),
    ...clientRecheckFailing,
  ])];

  const hasPassingSelectedPlacement =
    selectedPlacement !== null &&
    recommendedMargins.length > 0 &&
    recommendedMargins.every((m) => m.pass === true && !m.too_close_to_call) &&
    findPlacementsSummary !== null;

  const hasPassingPlacement = entailedClientSpotPasses === true || hasPassingSelectedPlacement;

  // Collect unchecked not-modeled clauses and signed dispositions relied on (GR-47 / M14)
  const appliedIds = acceptedPlan ? acceptedPlan.applies.map((a) => a.provision_id) : [];
  const { unchecked, dispositions_relied_on } = collectUncheckedAndDispositions(
    appliedIds,
    ruleFamilyCache,
    buildGuardFacts(kase as unknown as Record<string, any>), // AG3: an unsettled fact never rules a clause out
    clauseCoverage(appliedIds, OPERATOR_COVERS, [...callResultsMap.entries()].map(([id, c]) => ({ ...c, call_id: id }))),
  );

  {
    const p1 = plannerReadingsUnchecked(eventLog.getEvents(), (pid) => indexEntriesById.get(pid)?.evaluation_stage ?? ruleFamilyCache.get(pid)?.evaluation_stage, ruleFamilyCache,
      projectKindOf(kase as unknown as Record<string, any>));
    unchecked.push(...p1.unchecked);
    for (const d of p1.relied) if (!dispositions_relied_on.some((x) => x.clause_id === d.clause_id)) dispositions_relied_on.push(d);
    // Build-review A10: an exclusion "through" a sibling's operator is computed only if that sibling was checked. A
    // sibling with no finding, or one found not applicable, leaves the excluded provision unchecked.
    for (const ev of eventLog.getEvents()) {
      if (ev.type !== "lotfit.exclusion_recorded" || ev.data.basis !== "through_operator" || !ev.data.through) continue;
      const through = ev.data.through;
      const checked = reportFindings.some((f) => f.provision_id === through && f.outcome !== "not_applicable");
      if (!checked && !unchecked.some((u) => u.provision_id === ev.data.provision_id))
        unchecked.push({ provision_id: ev.data.provision_id, clause_id: ev.data.scope_clause_id,
          reason: `excluded as evaluated through ${through}, but ${through} has no finding that checks it in this run` });
    }
  }

  // Step 4 — VERDICT
  let entailedVerdict: VerdictType = entailVerdict(
    sensitivityFindings,
    kase as unknown as Record<string, any>,
    hasPassingPlacement,
    entailedClientSpotPasses,
  );

  // §3 step 4: a fact whose branches change the verdict is decisive. A decisive conflict, unknown or too-close
  // margin → NEEDS_CHECK; decisive gray areas only (two recorded readings) → FITS_IF when a branch fits. CC fix.
  {
    const nominal = sensitivity.nominal_verdict;
    const byFact = new Map<string, Array<(typeof sensitivity.branches)[number]>>();
    for (const b of sensitivity.branches) byFact.set(b.fact, [...(byFact.get(b.fact) ?? []), b]);
    const decisive = [...byFact.entries()].filter(([, bs]) => new Set([nominal, ...bs.map((b) => b.verdict)]).size > 1);
    if (decisive.length > 0) {
      const onlyReadings = decisive.every(([, bs]) => bs.every((b) => (b.assignment as any).kind === "reading"));
      const someFits = decisive.some(([, bs]) => bs.some((b) => b.verdict === "FITS")) || nominal === "FITS";
      entailedVerdict = onlyReadings && someFits ? "FITS_IF" : "NEEDS_CHECK";
      verdictReasons.push(`decisive: ${decisive.map(([f, bs]) => `${f} (${(bs[0]!.assignment as any).kind}: ${[...new Set(bs.map((b) => b.verdict))].join("/")})`).join(", ")} → ${entailedVerdict}`);
    }
  }

  // Measure 2 + 3: a selected placement that fails (or cannot be decided on) a required check is not a FITS.
  if (selectedPlacement && (entailedVerdict === "FITS" || entailedVerdict === "FITS_IF")) {
    const sel = recheckByRequirements(kase as unknown as Record<string, any>, selectedPlacement, "selected_placement", acceptedPlan, ruleFamilyCache, guardsMap, callResultsMap, configHash);
    if (sel.failing.length > 0 || sel.undecided.length > 0) {
      entailedVerdict = "NEEDS_CHECK";
      verdictReasons.push(`code re-check of the selected placement: failing [${sel.failing.join(", ")}], undecided [${sel.undecided.join(", ")}] → NEEDS_CHECK`);
    }
  }

  // F10: NO_LEGS for placement is entailed only by find_placements with clear_count == 0. A NO_LEGS that does not come
  // from a failed plan constraint, without that search, is NEEDS_CHECK ("placement search not run"). CC fix, live S1.
  const planConstraintFailed = sensitivityFindings.some(
    (f: any) => f.evaluation_stage === "plan_constraint" && f.outcome === "fail",
  );
  // B5: the search applies the base setbacks. An applied exception that relaxes them (245.C.2) and is not ruled out
  // could allow spots the search never tried, so "no clear spot" is not proven.
  const openRelaxers = appliedIds.filter((pid) => RELAXING_EXCEPTIONS.has(pid) && guardsMap[pid]?.result !== "known_false");
  // Instruments panel ADV-1 (2026-11-03): "no clear spot" is not "no spot". Spots that pass by less than the tolerance
  // (count > clear_count) are too close to call: NEEDS_CHECK, never NO_LEGS. Only a search with no candidate at all
  // (count === 0) can prove there is no spot.
  const marginalOnly = !!findPlacementsSummary && findPlacementsSummary.clear_count === 0 && findPlacementsSummary.count > 0;
  if (marginalOnly) verdictReasons.push(`find_placements found ${findPlacementsSummary!.count} spot(s) that are too close to call and none clear → NEEDS_CHECK, not NO_LEGS`);
  if (entailedVerdict === "NEEDS_CHECK" && !planConstraintFailed && findPlacementsSummary && findPlacementsSummary.clear_count === 0 && !marginalOnly &&
      !sensitivity.branches.some((b) => b.verdict !== sensitivity.nominal_verdict)) {
    if (openRelaxers.length === 0) {
      entailedVerdict = "NO_LEGS"; // the search proved there is no clear spot (F10)
      verdictReasons.push("find_placements found no clear placement → NO_LEGS");
    } else {
      verdictReasons.push(`find_placements found no clear placement under the base setbacks, but ${openRelaxers.join(", ")} may relax them and the search does not model it → NEEDS_CHECK`);
    }
  }
  if (entailedVerdict === "NO_LEGS" && !planConstraintFailed && (!(findPlacementsSummary && findPlacementsSummary.clear_count === 0) || marginalOnly)) {
    entailedVerdict = "NEEDS_CHECK";
    verdictReasons.push("no clear placement is proven missing (find_placements not run or found clear spots) → NEEDS_CHECK");
  }
  if (entailedVerdict === "NO_LEGS" && !planConstraintFailed && openRelaxers.length > 0) {
    entailedVerdict = "NEEDS_CHECK";
    verdictReasons.push(`NO_LEGS for placement is not proven while ${openRelaxers.join(", ")} may relax the setbacks → NEEDS_CHECK`);
  }

  // Apply harness-level NEEDS_CHECK rules (abnormal end, missing coverage, open not-modeled clauses without dispositions)
  if (entailedVerdict !== "BLOCKED_BY_GATE" && entailedVerdict !== "NO_LEGS") {
    if (abnormalEnd || !acceptedPlan || reportFindings.length === 0) {
      entailedVerdict = "NEEDS_CHECK";
      verdictReasons.push("abnormal end, no plan, or no findings → NEEDS_CHECK");
    } else if (unchecked.length > 0) {
      entailedVerdict = "NEEDS_CHECK";
      verdictReasons.push(`${unchecked.length} applying clause(s) are not modeled and have no signed disposition (GR-47) → NEEDS_CHECK, whatever the findings say`);
    } else if (entailedClientSpotPasses === false && (!selectedPlacement || !findPlacementsSummary)) {
      entailedVerdict = "NEEDS_CHECK";
      verdictReasons.push("the client spot fails and no searched, selected placement is given → NEEDS_CHECK");
    } else if (
      entailedVerdict === "FITS" &&
      (!selectedPlacement ||
        recommendedMargins.length === 0 ||
        !recommendedMargins.every((m) => m.pass === true))
    ) {
      entailedVerdict = "NEEDS_CHECK";
    }
  }

  const proposedVerdict: VerdictType | null = concludeCall?.verdict ?? null;
  const finalVerdict: VerdictType = entailedVerdict;
  const finalModelVerdict: VerdictType | null = proposedVerdict;

  if (emitEvents) {
    eventLog.append("lotfit.verdict_computed", {
      entailed: entailedVerdict,
      proposed: proposedVerdict,
      agree: proposedVerdict !== null && proposedVerdict === entailedVerdict,
      abnormal_end: abnormalEnd,
      reasons: verdictReasons,
    });
  }

  // Determine plan_limit if NO_LEGS from a plan_constraint failure
  let planLimit: ResolvedParamType | null = planLimitFromBreaker;
  if (!planLimit && finalVerdict === "NO_LEGS") {
    for (const f of reportFindings) {
      if (f.evaluation_stage === "plan_constraint" && f.outcome === "fail" && f.measures[0]?.limit) {
        planLimit = f.measures[0].limit;
        break;
      }
    }
  }

  const questions = buildQuestions(kase, sensitivity);

  const clientSpotPlacement = (resolveFactValue(
    kase as unknown as Record<string, any>,
    "plan.placement",
  ) ?? null) as PlacementType | null;

  const draftReport: ReportType = C.Report.parse({
    schema: "lotfit.evaluation-report/1",
    case_id: kase.case_id,
    case_hash: caseHash,
    graph_load_id: eventLog.graph_load_id,
    config_hash: configHash,
    as_of: kase.as_of,
    verdict: finalVerdict,
    model_verdict: finalModelVerdict,
    verdict_note:
      concludeCall?.summary && !abnormalEnd
        ? concludeCall.summary
        : `Evaluation completed with verdict ${finalVerdict}.`,
    banner: "Pre-feasibility only; not a permit decision.",
    plan_limit: planLimit,
    placement: {
      // The client's spot is reported whenever the case has one, even undecided (S5: too close to call → passes
      // null); dropping it made the verifier ask for placement findings at target "case". CC, 11-02.
      client_spot:
        clientSpotPlacement !== null
          ? {
              placement: clientSpotPlacement,
              passes: entailedClientSpotPasses,
              failing: clientFailingProvisions,
              rejected_exceptions: rejectedExceptions,
            }
          : null,
      recommended:
        selectedPlacement !== null
          ? {
              placement: selectedPlacement,
              margins: recommendedMargins,
              solar: null,
            }
          : null,
      search: findPlacementsSummary,
    },
    findings: reportFindings,
    dispositions_relied_on,
    conflicts: [],
    assumptions: [],
    conditions: [],
    questions: finalVerdict === "FITS" ? [] : questions,
    not_found: [],
    unchecked: finalVerdict === "FITS" ? [] : unchecked,
    verifier: {
      passed: true,
      issues: [],
    },
    critic: null,
    telemetry: {
      tokens: telemetryInfo.tokens,
      calls: telemetryInfo.calls,
      turns: telemetryInfo.turns,
      wall_s_plan_execute: Number(
        Math.max(0, (telemetryInfo.planExecuteEndMs - telemetryInfo.startWallMs) / 1000).toFixed(4),
      ),
      wall_s_total: Number(Math.max(0, (Date.now() - telemetryInfo.startWallMs) / 1000).toFixed(4)),
      cost_usd: telemetryInfo.cost_usd,
      models: { agent: telemetryInfo.modelId },
    },
  });

  // Step 5 — VERIFY (W7)
  const rawVerifyOut = verify({
    index: layerIndex,
    plan: fallbackPlan,
    guards: guardsMap,
    events: eventLog.getEvents(),
    report: draftReport,
    resolved_params: Array.from(resolvedParamsMap.values()),
    case_facts: flatFacts,
  });

  // When the breaker lawfully halted evaluation at gate or plan_constraint, downstream provisions
  // were not evaluated; do not flag V1_COVERAGE for post-breaker provisions.
  const verifyIssues = breakerObj.tripped
    ? rawVerifyOut.issues.filter(
        (iss) =>
          !(
            iss.code === "V1_COVERAGE" &&
            iss.provision_id &&
            !reportFindings.some((f) => f.provision_id === iss.provision_id)
          ),
      )
    : rawVerifyOut.issues;
  const verifyOut = {
    passed: verifyIssues.length === 0,
    issues: verifyIssues,
  };

  if (emitEvents) {
    eventLog.append("lotfit.verifier_completed", {
      passed: verifyOut.passed,
      issues: verifyOut.issues,
      critic_objections: 0,
    });
  }

  // If verifier failed after repairs exhausted, ship NEEDS_CHECK (unless BLOCKED_BY_GATE or NO_LEGS)
  const verifiedVerdict: VerdictType =
    !verifyOut.passed &&
    draftReport.verdict !== "BLOCKED_BY_GATE" &&
    draftReport.verdict !== "NO_LEGS"
      ? "NEEDS_CHECK"
      : draftReport.verdict;

  const finalReport = C.Report.parse({
    ...draftReport,
    verdict: verifiedVerdict,
    verifier: {
      passed: verifyOut.passed,
      issues: verifyOut.issues,
    },
  });

  return {
    report: finalReport,
    sensitivity,
    verifyOut,
    entailedVerdict,
    entailedClientSpotPasses,
    entailedReasons: verdictReasons,
  };
}

/** Measure 2 + 3 (Martin, 11-02): code re-runs every required placement check (operators.json `requires`) of every
 * applied, not-ruled-out provision at a placement, from scratch, whatever the model recorded. A passing exception at the
 * same target cures its base rule. Returns the provisions that fail and those it could not decide. */
function recheckByRequirements(
  kase: Record<string, any>,
  placement: PlacementType,
  target: TargetType,
  plan: PlanType | null,
  ruleFamilyCache: Map<string, RuleFamilyType>,
  guardsMap: Record<string, GuardResultType>,
  callResultsMap: Map<string, { tool: string; provision_id: string | null; target: TargetType; ok: boolean; result: unknown }>,
  configHash: string,
): { failing: string[]; undecided: string[] } {
  const footprint = resolveFactValue(kase, "plan.footprint") as Array<[number, number]> | undefined;
  if (!footprint || !plan) return { failing: [], undecided: [] };
  const zone = String(resolveFactValue(kase, "site.zone") ?? "unknown");
  const rules = loadProvisionRules(zone);
  const outline = computePlacedOutline(footprint, placement);
  const batch: z.infer<typeof C.BridgeRequest>["batch"] = [];
  const owner = new Map<string, string>();
  const undecided = new Set<string>();
  for (const a of plan.applies) {
    const pid = a.provision_id;
    if (guardsMap[pid]?.result === "known_false") continue;
    for (const rq of rules.get(pid)?.requires ?? []) {
      if (rq.tool !== "check_setback" && rq.tool !== "check_front_or_behind") continue;
      const [pp, pn] = (rq.param ?? ":").split(":") as [string, string];
      const prm = ruleFamilyCache.get(pp)?.params.find((x) => x.name === pn);
      if (!prm || typeof prm.value !== "number") { undecided.add(pid); continue; }
      const limit = { provision_id: pp, param: pn, value: prm.value, unit: prm.unit ?? "ft" };
      const id = makeUuid7();
      owner.set(id, pid);
      if (rq.tool === "check_setback") {
        const lf = rq.match?.["lines"] ?? "site.side_lot_lines";
        batch.push({ call_id: id, provision_id: pid, target, tool: "check_setback",
          args: { outline, lines: resolveFactValue(kase, lf), min: limit, tolerance_ft: extractFactToleranceFt(kase, lf) } });
      } else {
        batch.push({ call_id: id, provision_id: pid, target, tool: "check_front_or_behind",
          args: { outline, front_lot_line: resolveFactValue(kase, "site.front_lot_line"), min_front: limit,
            house_rear_wall: resolveFactValue(kase, "site.house_rear_wall"),
            tolerance_ft: Math.max(extractFactToleranceFt(kase, "site.front_lot_line"), extractFactToleranceFt(kase, "site.house_outline")) } });
      }
    }
  }
  if (batch.length === 0) return { failing: [], undecided: [...undecided] };
  const out = executePythonBridgeBatch(batch, configHash);
  const failing = new Set<string>();
  for (const item of batch) {
    const pid = owner.get(item.call_id)!;
    const r = out.results.get(item.call_id);
    const pass = r?.ok ? (r.result as any)?.pass : undefined;
    if (pass === false) failing.add(pid);
    else if (pass !== true) undecided.add(pid);
  }
  const cured = (pid: string) => [...callResultsMap.values()].some((c) => c.ok && c.target === target &&
    c.tool === "check_exception_conditions" && (c.result as any)?.base_provision_id === pid && (c.result as any)?.pass === true);
  return { failing: [...failing].filter((p) => !cured(p)), undecided: [...undecided].filter((p) => !failing.has(p)) };
}

function recheckSelectedPlacementMargins(
  kase: Record<string, any>,
  selectedPlacement: PlacementType,
  reportFindings: ReportFindingType[],
  resolvedParamsMap: Map<string, ResolvedParamType>,
  configHash: string,
): MeasureResultType[] {
  const footprint = resolveFactValue(kase, "plan.footprint") as Array<[number, number]> | undefined;
  if (!footprint) {
    return reportFindings
      .filter((f) => f.target === "selected_placement")
      .flatMap((f) => f.measures);
  }

  const outline = computePlacedOutline(footprint, selectedPlacement);
  const zone = String(resolveFactValue(kase, "site.zone") ?? "unknown");
  const sideMin = resolvedParamsMap.get(`PDX.T110-4::side_building_setback.${zone}`);
  const rearMin = resolvedParamsMap.get(`PDX.T110-4::rear_building_setback.${zone}`);
  const frontMin = resolvedParamsMap.get("PDX.33.205.040.C.2::front_lot_line_setback");
  const accLimit = resolvedParamsMap.get(
    "PDX.33.110.245.C.3.a::max_combined_accessory_coverage_pct_of_site",
  );

  const batch: z.infer<typeof C.BridgeRequest>["batch"] = [];
  if (sideMin) {
    batch.push({
      call_id: makeUuid7(),
      provision_id: "PDX.33.110.220.B",
      target: "selected_placement",
      tool: "check_setback",
      args: {
        outline,
        lines: resolveFactValue(kase, "site.side_lot_lines"),
        min: sideMin,
        tolerance_ft: extractFactToleranceFt(kase, "site.side_lot_lines"),
      },
    });
  }
  if (rearMin) {
    batch.push({
      call_id: makeUuid7(),
      provision_id: "PDX.33.110.220.B",
      target: "selected_placement",
      tool: "check_setback",
      args: {
        outline,
        lines: resolveFactValue(kase, "site.rear_lot_line"),
        min: rearMin,
        tolerance_ft: extractFactToleranceFt(kase, "site.rear_lot_line"),
      },
    });
  }
  if (frontMin) {
    batch.push({
      call_id: makeUuid7(),
      provision_id: "PDX.33.205.040.C.2",
      target: "selected_placement",
      tool: "check_front_or_behind",
      args: {
        outline,
        front_lot_line: resolveFactValue(kase, "site.front_lot_line"),
        min_front: frontMin,
        house_rear_wall: resolveFactValue(kase, "site.house_rear_wall"),
        tolerance_ft: Math.max(
          extractFactToleranceFt(kase, "site.front_lot_line"),
          extractFactToleranceFt(kase, "site.house_outline"),
        ),
      },
    });
  }
  if (accLimit) {
    const structs = normalizeStructureOutlines(resolveFactValue(kase, "site.structures"));
    batch.push({
      call_id: makeUuid7(),
      provision_id: "PDX.33.110.245.C.3.a",
      target: "selected_placement",
      tool: "coverage_share",
      args: {
        outlines: [outline, ...structs],
        lot_area: Number(resolveFactValue(kase, "site.lot_area_sqft")),
        limit: accLimit,
        outline_tolerances_ft: [0, ...structs.map(() => extractFactToleranceFt(kase, "site.structures"))],
        lot_area_tolerance_sqft: extractFactToleranceFt(kase, "site.lot_area_sqft"),
      },
    });
  }

  if (batch.length === 0) {
    return reportFindings
      .filter((f) => f.target === "selected_placement")
      .flatMap((f) => f.measures);
  }

  const out = executePythonBridgeBatch(batch, configHash);
  const margins: MeasureResultType[] = [];
  for (const item of batch) {
    const r = out.results.get(item.call_id);
    if (r?.ok && r.result) {
      const parsed = C.MeasureResult.safeParse(r.result);
      if (parsed.success) {
        margins.push(parsed.data);
      }
    }
  }
  return margins;
}
