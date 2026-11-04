/**
 * LotFit deterministic verifier (W7, milestone 1).
 *
 * Implements verify(input) -> { passed: boolean, issues: RepairError[] }
 * against frozen contracts 1.0.0 (query/src/types.mts) and ARCHITECTURE.md
 * round 4.1 §11 (V1_COVERAGE through V8_GUARD).
 */

import type { z } from "zod";
import * as C from "./types.mts";
import { loadProvisionRules } from "./outcome.mts";
import { readFileSync as readOps } from "node:fs";
import { dirname as dn, join as jn } from "node:path";
import { fileURLToPath as f2p } from "node:url";

/** The fact a composite size limit's share is of: the site.* fact the operator binding the share parameter reads. */
function compositeBaseFact(provisionId: string, shareParam: string): string {
  try {
    const ops = JSON.parse(readOps(jn(dn(f2p(import.meta.url)), "..", "..", "graph", "curated", "operators.json"), "utf8")).operators as
      Array<{ reads?: string[]; params?: Array<{ provision: string; param: string }> }>;
    const op = ops.find((o) => (o.params ?? []).some((p) => p.provision === provisionId && p.param === shareParam));
    return op?.reads?.find((r) => r.startsWith("site.")) ?? "site.primary_living_area_sqft";
  } catch { return "site.primary_living_area_sqft"; }
}

export type LayerIndex = z.infer<typeof C.LayerIndex>;
export type IndexEntry = z.infer<typeof C.IndexEntry>;
export type GuardResult = z.infer<typeof C.GuardResult>;
export type Plan = z.infer<typeof C.Plan>;
export type LotFitEvent = z.infer<typeof C.LotFitEvent>;
export type Report = z.infer<typeof C.Report>;
export type ReportFinding = z.infer<typeof C.ReportFinding>;
export type RecordFinding = z.infer<typeof C.RecordFinding>;
export type ResolvedParam = z.infer<typeof C.ResolvedParam>;
export type MeasureResult = z.infer<typeof C.MeasureResult>;
export type ExceptionResult = z.infer<typeof C.ExceptionResult>;
export type RepairError = z.infer<typeof C.RepairError>;
export type Target = z.infer<typeof C.Target>;
export type Outcome = z.infer<typeof C.Outcome>;

export interface VerifyInput {
  index: LayerIndex;
  guards: Record<string, GuardResult>;
  plan: Plan;
  events: LotFitEvent[];
  report: Report;
  resolved_params: ResolvedParam[];
  case_facts: Record<string, unknown>;
}

export interface VerifyOutput {
  passed: boolean;
  issues: RepairError[];
}

interface IndexedCall {
  call_id: string;
  tool: string;
  provision_id: string | null;
  target: Target;
  args: Record<string, unknown>;
  ok: boolean;
  has_result: boolean;
  result: unknown;
}

/**
 * Resolve a dot/bracket path (e.g. "margin", "limit.value", "details.per_segment.0.margin_ft",
 * "conditions[4].measure.margin", or "/margin") inside an object.
 */
export function resolvePath(obj: unknown, rawPath: string): { found: boolean; value: unknown } {
  const trimmed = rawPath.trim().replace(/^(\$|\.)+/, "").replace(/^\//, "");
  if (trimmed === "") {
    return { found: obj !== undefined, value: obj };
  }
  const normalized = trimmed.replace(/\[(\d+)\]/g, ".$1").replace(/\//g, ".");
  const parts = normalized.split(".").filter((p) => p.length > 0);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return { found: false, value: undefined };
    }
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        return { found: false, value: undefined };
      }
      cur = cur[idx];
    } else {
      const rec = cur as Record<string, unknown>;
      if (!(part in rec)) {
        return { found: false, value: undefined };
      }
      cur = rec[part];
    }
  }
  return { found: cur !== undefined, value: cur };
}

function parseJsonSafe(preview: string): unknown {
  try {
    return JSON.parse(preview);
  } catch {
    return undefined;
  }
}

/**
 * Extract tool calls and their results from the event log.
 */
function indexToolCalls(events: LotFitEvent[]): {
  calls: Map<string, IndexedCall>;
  recordedFindings: RecordFinding[];
  concludeCall: z.infer<typeof C.Conclude> | null;
} {
  const requested = new Map<
    string,
    {
      call_id: string;
      tool: string;
      provision_id: string | null;
      target: Target;
      args: Record<string, unknown>;
    }
  >();
  const results = new Map<
    string,
    {
      ok: boolean;
      result: unknown;
    }
  >();
  const recordedFindings: RecordFinding[] = [];
  let concludeCall: z.infer<typeof C.Conclude> | null = null;

  for (const ev of events) {
    if (ev.type === "tool_requested") {
      const c = ev.data.call;
      requested.set(c.call_id, {
        call_id: c.call_id,
        tool: c.tool,
        provision_id: c.provision_id,
        target: c.target,
        args: c.args,
      });
      if (c.tool === "record_finding") {
        const parsed = C.RecordFinding.safeParse(c.args);
        if (parsed.success) {
          recordedFindings.push(parsed.data);
        }
      } else if (c.tool === "conclude") {
        const parsed = C.Conclude.safeParse(c.args);
        if (parsed.success) {
          concludeCall = parsed.data;
        }
      }
    } else if (ev.type === "tool_result") {
      const d = ev.data as Record<string, unknown>;
      const parsedPreview = typeof d["preview"] === "string" ? parseJsonSafe(d["preview"]) : undefined;
      const rawResult = "result" in d && d["result"] !== undefined ? d["result"] : parsedPreview;
      results.set(ev.data.call_id, {
        ok: ev.data.ok,
        result: rawResult,
      });
    } else if (ev.type === "lotfit.finding_recorded") {
      if (ev.data.accepted) {
        recordedFindings.push(ev.data.finding);
      }
    }
  }

  // Deduplicate recordedFindings by (provision_id, target), keeping the latest accepted one
  const dedupedFindings = new Map<string, RecordFinding>();
  for (const rf of recordedFindings) {
    dedupedFindings.set(`${rf.provision_id}::${rf.target}`, rf);
  }

  const calls = new Map<string, IndexedCall>();
  for (const [id, req] of requested.entries()) {
    const res = results.get(id);
    calls.set(id, {
      ...req,
      has_result: res !== undefined,
      ok: res?.ok === true,
      result: res?.result,
    });
  }

  return {
    calls,
    recordedFindings: Array.from(dedupedFindings.values()),
    concludeCall,
  };
}

function passToExpectedOutcome(pass: boolean | null): Outcome {
  if (pass === true) return "pass";
  if (pass === false) return "fail";
  return "too_close_to_call";
}

function isMeasureLike(val: unknown): val is {
  value: number;
  unit: string;
  limit: ResolvedParam | null;
  margin: number;
  tolerance: number;
  pass: boolean | null;
  too_close_to_call: boolean;
} {
  if (!val || typeof val !== "object") return false;
  const r = val as Record<string, unknown>;
  return (
    typeof r["value"] === "number" &&
    typeof r["margin"] === "number" &&
    typeof r["tolerance"] === "number" &&
    (typeof r["pass"] === "boolean" || r["pass"] === null) &&
    typeof r["too_close_to_call"] === "boolean"
  );
}

function isExceptionResultLike(val: unknown): val is ExceptionResult {
  if (!val || typeof val !== "object") return false;
  const r = val as Record<string, unknown>;
  return (
    typeof r["exception_id"] === "string" &&
    typeof r["base_provision_id"] === "string" &&
    Array.isArray(r["conditions"]) &&
    (typeof r["pass"] === "boolean" || r["pass"] === null)
  );
}

function isGuardResultLike(val: unknown): val is GuardResult {
  if (!val || typeof val !== "object") return false;
  const r = val as Record<string, unknown>;
  return (
    typeof r["provision_id"] === "string" &&
    (r["result"] === "known_true" || r["result"] === "known_false" || r["result"] === "unknown") &&
    Array.isArray(r["guards"])
  );
}

/**
 * Determine whether two numbers match (including sign, distinguishing -0 vs +0 is not needed,
 * but -3 vs +3 must fail).
 */
function numbersMatch(a: number, b: number): boolean {
  if (Math.sign(a) !== Math.sign(b) && (a !== 0 || b !== 0)) {
    return false;
  }
  return Math.abs(a - b) <= 1e-9;
}

/**
 * Recursively collect all numbers inside an object for fallback when a ReportFinding
 * does not carry explicit RecordFinding paths.
 */
function collectAllNumbers(obj: unknown, out: number[] = []): number[] {
  if (typeof obj === "number" && Number.isFinite(obj)) {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectAllNumbers(item, out);
  } else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      collectAllNumbers(v, out);
    }
  }
  return out;
}

/**
 * Match a limit against resolved_params.
 * Note: `adu_max_living_area` synthesizes a derived limit param string
 * `max_sqft = min(max_share_of_primary_living_area × primary, max_living_area)`;
 * for that composite param we check that its numeric value matches either the resolved
 * `max_living_area` cap or `(max_share_of_primary_living_area / 100) * primary_living_area`.
 */
export function checkLimitAgainstResolvedParams(
  limit: ResolvedParam,
  resolvedParams: ResolvedParam[],
  caseFacts: Record<string, unknown>,
): { ok: boolean; expected?: ResolvedParam; reason?: string } {
  const exact = resolvedParams.find(
    (p) => p.provision_id === limit.provision_id && p.param === limit.param,
  );
  if (exact) {
    if (!numbersMatch(limit.value, exact.value) || limit.unit !== exact.unit) {
      return {
        ok: false,
        expected: exact,
        reason: `limit ${limit.provision_id}.${limit.param} has value ${limit.value} ${limit.unit}, but resolved_params has ${exact.value} ${exact.unit}`,
      };
    }
    return { ok: true };
  }

  // Handle adu_max_living_area's composite limit param name if the individual params are in resolved_params
  if (limit.param.startsWith("max_sqft = min(")) {
    // AG r2 R2-5: the share and cap parameter names come from the limit itself ("max_sqft = min(<share> × primary,
    // <cap>)", graph/tool_runner.py), and the base fact from the operator that binds them (operators.json `reads`):
    // Portland's share is of the primary living area, Eugene's of the lot area.
    const m = limit.param.match(/^max_sqft = min\((\S+) × primary, ([^)]+)\)$/);
    const shareName = m?.[1] ?? "max_share_of_primary_living_area", capName = m?.[2] ?? "max_living_area";
    const capParam = resolvedParams.find(
      (p) => p.provision_id === limit.provision_id && p.param === capName,
    );
    const shareParam = resolvedParams.find(
      (p) => p.provision_id === limit.provision_id && p.param === shareName,
    );
    if (capParam && shareParam) {
      const baseFact = compositeBaseFact(limit.provision_id, shareName);
      const rawPrimary = caseFacts[baseFact];
      const primarySqft =
        typeof rawPrimary === "number"
          ? rawPrimary
          : rawPrimary && typeof rawPrimary === "object" && "value" in (rawPrimary as Record<string, unknown>)
            ? Number((rawPrimary as Record<string, unknown>)["value"])
            : NaN;
      const expectedVal = Number.isFinite(primarySqft)
        ? Math.min((shareParam.value / 100) * primarySqft, capParam.value)
        : capParam.value;
      if (numbersMatch(limit.value, expectedVal) && limit.unit === capParam.unit) {
        return { ok: true };
      }
      return {
        ok: false,
        expected: capParam,
        reason: `composite ADU living area limit has value ${limit.value} ${limit.unit}, expected ${expectedVal} ${capParam.unit}`,
      };
    }
  }

  // Check if there is any resolved param for the same provision with a different value
  const sameProvision = resolvedParams.filter((p) => p.provision_id === limit.provision_id);
  return {
    ok: false,
    expected: sameProvision[0],
    reason: `limit ${limit.provision_id}.${limit.param} (${limit.value} ${limit.unit}) does not match any resolved_params entry`,
  };
}

/**
 * Run all eight deterministic verification checks (V1–V8) on a LotFit evaluation run.
 */
/** V3 / B6 (rules-as-data panel, 2026-11-02): the outcome a finding's cited results entail, in three-valued logic.
 *  A null from a measurement inside its tolerance is "too close to call"; a null from an exception (or a measurement
 *  with an unknown input) is "unknown". An exception that holds cures the failed checks it is cited with; one whose
 *  conditions are unknown leaves them unknown (B3). Gate guards: known_false passes; unknown stays undecided. */
export function combineCitedOutcome(cited: unknown[], fallbackMeasures: unknown[], isGate: boolean, reported: string, partial = false):
    { outcome: Outcome | null; citedPasses: Array<boolean | null> } {
  const citedPasses: Array<boolean | null> = [];
  let nullTooClose = false, nullUnknown = false, cureHolds = false, cureOpen = false, gateUnknown = false;
  const measure = (r: { pass: boolean | null }) => {
    citedPasses.push(r.pass);
    if (r.pass === null) { if ((r as { too_close_to_call?: boolean }).too_close_to_call === true) nullTooClose = true; else nullUnknown = true; }
  };
  for (const r of cited) {
    if (isExceptionResultLike(r)) {
      if (r.pass === true) cureHolds = true; else if (r.pass === null) cureOpen = true; else citedPasses.push(false);
    } else if (isMeasureLike(r)) measure(r);
    else if (isGuardResultLike(r) && isGate) {
      if (r.result === "known_false") citedPasses.push(true);
      else if (r.result === "unknown") { citedPasses.push(null); gateUnknown = true; }
    }
  }
  if (citedPasses.length === 0 && !cureHolds && !cureOpen) for (const m of fallbackMeasures) if (isMeasureLike(m)) measure(m);
  if (cureOpen && !cureHolds) nullUnknown = true;
  if (citedPasses.length === 0 && !cureHolds && !cureOpen) return { outcome: null, citedPasses };
  let outcome: Outcome;
  if (citedPasses.includes(false)) outcome = cureHolds ? "pass" : cureOpen ? "unknown" : "fail";
  else if (cureHolds && !citedPasses.includes(null)) outcome = "pass";
  else if (citedPasses.includes(null) || nullUnknown) outcome = gateUnknown && reported === "unknown" ? "unknown" : nullTooClose ? "too_close_to_call" : "unknown";
  else outcome = "pass";
  // P3 / build-review S1, A8: a partial operator (it checks only part of the provision) never entails a pass, cured or
  // not; what it checked passed, the rest is not checked by code, so the provision is unknown (outcome.mts agrees).
  if (partial && outcome === "pass") outcome = "unknown";
  return { outcome, citedPasses };
}

export function verify(input: VerifyInput): VerifyOutput {
  const issues: RepairError[] = [];
  const { index, guards, events, report, resolved_params, case_facts } = input;

  const { calls, recordedFindings, concludeCall } = indexToolCalls(events);
  const partialPids = new Set([...loadProvisionRules("unknown")].filter(([, r]) => (r.partial?.length ?? 0) > 0).map(([pid]) => pid));

  // Map report findings by (provision_id, target)
  const reportFindingsByKey = new Map<string, ReportFinding>();
  const reportFindingsByProvision = new Map<string, ReportFinding[]>();
  for (const f of report.findings) {
    reportFindingsByKey.set(`${f.provision_id}::${f.target}`, f);
    const list = reportFindingsByProvision.get(f.provision_id) ?? [];
    list.push(f);
    reportFindingsByProvision.set(f.provision_id, list);
  }

  // Map recordedFindings by (provision_id, target)
  const recordedByKey = new Map<string, RecordFinding>();
  for (const rf of recordedFindings) {
    recordedByKey.set(`${rf.provision_id}::${rf.target}`, rf);
  }

  // Determine which placement targets are active in this run
  const hasClientSpot = report.placement.client_spot !== null;
  const hasRecommendedSpot = report.placement.recommended !== null;

  // ------------------------------------------------------------------
  // V1_COVERAGE: every index provision not ruled out by a known_false guard has a finding
  // (per target where it is a placement constraint); computed against the index, never against plan.applies.
  // ------------------------------------------------------------------
  const ACTIVE_STAGES = new Set(["gate", "plan_constraint", "placement_constraint"]);
  // P1 (contracts 1.4.0): an exclusion on the Planner's reading is not ruled out by a guard, but it is not a coverage gap
  // either: the Judge lists it as unchecked (no FITS rests on it). Read from the Record.
  const excludedOnReading = new Set<string>();
  for (const ev of events) {
    if (ev.type === "lotfit.exclusion_recorded" && ev.data.basis === "planner_reading") excludedOnReading.add(ev.data.provision_id);
  }
  for (const layer of index.layers) {
    for (const entry of layer.provisions) {
      if (!ACTIVE_STAGES.has(entry.evaluation_stage)) {
        // definitions, preemptions, and standalone exceptions are reached through edges (§3)
        continue;
      }
      const guard = guards[entry.provision_id];
      if (guard && guard.result === "known_false") {
        continue;
      }
      if (excludedOnReading.has(entry.provision_id)) continue;

      if (entry.evaluation_stage === "placement_constraint") {
        const expectedTargets: Target[] = [];
        if (hasClientSpot) expectedTargets.push("client_spot");
        if (hasRecommendedSpot) expectedTargets.push("selected_placement");
        if (expectedTargets.length === 0) expectedTargets.push("case");

        for (const t of expectedTargets) {
          const f = reportFindingsByKey.get(`${entry.provision_id}::${t}`);
          // Also allow a case-level not_applicable finding if the provision was ruled out at case level
          const caseFinding = reportFindingsByKey.get(`${entry.provision_id}::case`);
          if (!f && !(caseFinding && caseFinding.outcome === "not_applicable")) {
            issues.push({
              code: "V1_COVERAGE",
              provision_id: entry.provision_id,
              target: t,
              message: `Index provision ${entry.provision_id} (${entry.evaluation_stage}) is not ruled out by a known_false guard and has no finding for target '${t}'.`,
            });
          }
        }
      } else {
        const list = reportFindingsByProvision.get(entry.provision_id) ?? [];
        if (list.length === 0) {
          issues.push({
            code: "V1_COVERAGE",
            provision_id: entry.provision_id,
            target: "case",
            message: `Index provision ${entry.provision_id} (${entry.evaluation_stage}) is not ruled out by a known_false guard and has no finding.`,
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // V2_EVIDENCE: every evidence_call_ids entry is a tool_requested + successful tool_result in the events.
  // ------------------------------------------------------------------
  for (const f of report.findings) {
    const rf = recordedByKey.get(`${f.provision_id}::${f.target}`);
    const callIdsToCheck = new Set<string>(f.evidence_call_ids);
    if (rf) {
      for (const cid of rf.evidence_call_ids) callIdsToCheck.add(cid);
    }

    for (const cid of callIdsToCheck) {
      const c = calls.get(cid);
      if (!c) {
        issues.push({
          code: "V2_EVIDENCE",
          provision_id: f.provision_id,
          target: f.target,
          message: `Finding for ${f.provision_id} (${f.target}) cites call_id ${cid}, which was never requested in the event log.`,
          detail: { call_id: cid },
        });
      } else if (!c.has_result || !c.ok) {
        issues.push({
          code: "V2_EVIDENCE",
          provision_id: f.provision_id,
          target: f.target,
          message: `Finding for ${f.provision_id} (${f.target}) cites call_id ${cid}, which has no successful tool_result in the event log.`,
          detail: { call_id: cid, has_result: c.has_result, ok: c.ok },
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // V3_OUTCOME: each finding's outcome equals its cited result's pass
  // (true -> pass, false -> fail, null -> too_close_to_call).
  // ------------------------------------------------------------------
  for (const f of report.findings) {
    if (f.outcome === "not_applicable") {
      // Checked by V8_GUARD
      continue;
    }

    // Collect pass values from cited tool results and report measures
    const cited = f.evidence_call_ids.map((cid) => calls.get(cid)).filter((c) => c && c.ok && c.result !== undefined).map((c) => c!.result);
    const combined = combineCitedOutcome(cited, f.measures, f.evaluation_stage === "gate", f.outcome, partialPids.has(f.provision_id));
    const citedPasses = combined.citedPasses;
    if (combined.outcome !== null) {
      const combinedOutcome: Outcome = combined.outcome;
      if (f.outcome !== combinedOutcome) {
        issues.push({
          code: "V3_OUTCOME",
          provision_id: f.provision_id,
          target: f.target,
          message: `Finding for ${f.provision_id} (${f.target}) has outcome '${f.outcome}', but cited tool result entails '${combinedOutcome}'.`,
          detail: { reported: f.outcome, expected: combinedOutcome, cited_passes: citedPasses },
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // V4_NUMBER: every number in a finding (numbers[].value, at its path) is found at that path
  // in the cited result, sign included. Also check ReportFinding.measures against cited results.
  // ------------------------------------------------------------------
  for (const f of report.findings) {
    const rf = recordedByKey.get(`${f.provision_id}::${f.target}`);
    if (rf && rf.numbers.length > 0) {
      for (const numEntry of rf.numbers) {
        const c = calls.get(numEntry.call_id);
        if (!c || !c.ok || c.result === undefined) {
          // If call_id is missing/failed, V2_EVIDENCE already flags if it's in evidence_call_ids;
          // if it's not in evidence_call_ids or has no result, flag V4_NUMBER only if the call exists with a result
          if (!f.evidence_call_ids.includes(numEntry.call_id)) {
            issues.push({
              code: "V4_NUMBER",
              provision_id: f.provision_id,
              target: f.target,
              message: `Number ${numEntry.value} at path '${numEntry.path}' cites call_id ${numEntry.call_id} which is not in evidence_call_ids.`,
              detail: numEntry,
            });
          }
          continue;
        }
        const resolved = resolvePath(c.result, numEntry.path);
        if (!resolved.found || typeof resolved.value !== "number") {
          issues.push({
            code: "V4_NUMBER",
            provision_id: f.provision_id,
            target: f.target,
            message: `Path '${numEntry.path}' in call ${numEntry.call_id} did not resolve to a number (got ${JSON.stringify(resolved.value)}).`,
            detail: { ...numEntry, actual: resolved.value },
          });
        } else if (!numbersMatch(numEntry.value, resolved.value)) {
          issues.push({
            code: "V4_NUMBER",
            provision_id: f.provision_id,
            target: f.target,
            message: `Number mismatch at '${numEntry.path}' in call ${numEntry.call_id}: finding states ${numEntry.value}, cited result has ${resolved.value}.`,
            detail: { ...numEntry, actual: resolved.value },
          });
        }
      }
    }

    // Also verify that every MeasureResult in ReportFinding.measures matches a cited tool result's numbers (value & margin, sign included)
    if (f.measures.length > 0) {
      const citedMeasures: MeasureResult[] = [];
      for (const cid of f.evidence_call_ids) {
        const c = calls.get(cid);
        if (!c || !c.ok || c.result === undefined) continue;
        if (isMeasureLike(c.result)) {
          citedMeasures.push(c.result as MeasureResult);
        } else if (isExceptionResultLike(c.result)) {
          for (const cond of c.result.conditions) {
            if (cond.measure) citedMeasures.push(cond.measure);
          }
        }
      }

      if (citedMeasures.length > 0 && (!rf || rf.numbers.length === 0)) {
        for (const m of f.measures) {
          const match = citedMeasures.find(
            (cm) => numbersMatch(cm.value, m.value) && numbersMatch(cm.margin, m.margin),
          );
          if (!match) {
            const allNums = citedMeasures.flatMap((cm) => collectAllNumbers(cm));
            issues.push({
              code: "V4_NUMBER",
              provision_id: f.provision_id,
              target: f.target,
              message: `Measure in report finding for ${f.provision_id} (${f.target}) (value=${m.value}, margin=${m.margin}) does not match any cited tool result.`,
              detail: { measure: m, cited_numbers: allNums },
            });
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // V5_VERDICT: report.model_verdict == report.verdict (the model's proposal vs code's entailed verdict),
  // and client_spot_passes agrees with the client-spot findings.
  // ------------------------------------------------------------------
  if (report.model_verdict !== report.verdict) {
    issues.push({
      code: "V5_VERDICT",
      message: `Model verdict '${String(report.model_verdict)}' disagrees with entailed verdict '${report.verdict}'.`,
      detail: { model_verdict: report.model_verdict, verdict: report.verdict },
    });
  } else if (concludeCall && concludeCall.verdict !== report.verdict) {
    issues.push({
      code: "V5_VERDICT",
      message: `conclude() verdict '${concludeCall.verdict}' disagrees with entailed verdict '${report.verdict}'.`,
      detail: { conclude_verdict: concludeCall.verdict, verdict: report.verdict },
    });
  }

  if (report.placement.client_spot !== null) {
    const clientRelevant = report.findings.filter(
      (f) =>
        (f.target === "client_spot" || f.target === "case") &&
        f.evaluation_stage !== "exception" &&
        f.outcome !== "not_applicable",
    );
    if (clientRelevant.length > 0) {
      // Determine whether each failing client_spot base provision is cured by a passing exception
      const passingExceptions = new Set<string>();
      for (const f of report.findings) {
        if ((f.target === "client_spot" || f.target === "case") && f.evaluation_stage === "exception" && f.outcome === "pass") {
          for (const cid of f.evidence_call_ids) {
            const c = calls.get(cid);
            if (c?.ok && isExceptionResultLike(c.result) && c.result.pass === true) {
              passingExceptions.add(c.result.base_provision_id);
            }
          }
        }
      }

      const uncuredRelevant = clientRelevant.filter((f) => !(f.outcome === "fail" && passingExceptions.has(f.provision_id)));
      const outcomes = uncuredRelevant.map((f) => f.outcome);
      const expectedClientPasses: boolean | null = outcomes.includes("fail")
        ? false
        : outcomes.includes("unknown") || outcomes.includes("too_close_to_call")
          ? null
          : true;

      // Code's from-scratch re-check may fail the client's spot on a rule the findings missed (L34, measure 3); a
      // report that is stricter than the findings, naming the failing provisions, is not a discrepancy.
      const codeStricter = report.placement.client_spot.passes === false && report.placement.client_spot.failing.length > 0;
      if (report.placement.client_spot.passes !== expectedClientPasses && !codeStricter) {
        issues.push({
          code: "V5_VERDICT",
          target: "client_spot",
          message: `placement.client_spot.passes is ${String(report.placement.client_spot.passes)}, but client-spot findings entail ${String(expectedClientPasses)}.`,
          detail: {
            reported: report.placement.client_spot.passes,
            expected: expectedClientPasses,
          },
        });
      } else if (concludeCall && concludeCall.client_spot_passes !== expectedClientPasses) {
        issues.push({
          code: "V5_VERDICT",
          target: "client_spot",
          message: `conclude.client_spot_passes is ${String(concludeCall.client_spot_passes)}, but client-spot findings entail ${String(expectedClientPasses)}.`,
          detail: {
            conclude_client_spot_passes: concludeCall.client_spot_passes,
            expected: expectedClientPasses,
          },
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // V6_GEOMETRY: for FITS, the selected placement re-checks clean:
  // every report.placement.recommended.margins[] has pass: true.
  // ------------------------------------------------------------------
  if (report.verdict === "FITS") {
    const rec = report.placement.recommended;
    if (!rec || rec.margins.length === 0) {
      issues.push({
        code: "V6_GEOMETRY",
        target: "selected_placement",
        message: "Verdict is FITS, but report.placement.recommended has no recorded margins.",
      });
    } else {
      for (let i = 0; i < rec.margins.length; i++) {
        const m = rec.margins[i]!;
        if (m.pass !== true || m.too_close_to_call || m.margin < m.tolerance - 1e-9) {
          issues.push({
            code: "V6_GEOMETRY",
            provision_id: m.limit?.provision_id,
            target: "selected_placement",
            message: `Selected placement margin[${i}] fails geometry re-check for FITS (pass=${String(m.pass)}, margin=${m.margin}, tolerance=${m.tolerance}).`,
            detail: { index: i, margin: m },
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // V7_PARAMETER: every numeric limit in a cited MeasureResult equals a resolved_params
  // entry with the same provision and param (a model-typed or drifted number fails).
  // ------------------------------------------------------------------
  const checkedMeasureLimits = new Set<string>();
  const checkMeasureForV7 = (
    m: MeasureResult,
    provisionId: string | undefined,
    target: Target | undefined,
    sourceLabel: string,
  ) => {
    if (!m.limit) return;
    const dedupKey = `${provisionId ?? ""}::${target ?? ""}::${m.limit.provision_id}::${m.limit.param}::${m.limit.value}::${m.limit.unit}`;
    if (checkedMeasureLimits.has(dedupKey)) return;
    checkedMeasureLimits.add(dedupKey);

    const check = checkLimitAgainstResolvedParams(m.limit, resolved_params, case_facts);
    if (!check.ok) {
      issues.push({
        code: "V7_PARAMETER",
        provision_id: provisionId ?? m.limit.provision_id,
        target,
        message: `Numeric limit drift in ${sourceLabel}: ${check.reason}`,
        detail: { limit: m.limit, expected: check.expected },
      });
    }
  };

  for (const f of report.findings) {
    for (const m of f.measures) {
      checkMeasureForV7(m, f.provision_id, f.target, `report finding ${f.provision_id} (${f.target})`);
    }
    for (const cid of f.evidence_call_ids) {
      const c = calls.get(cid);
      if (!c || !c.ok || c.result === undefined) continue;
      if (isMeasureLike(c.result)) {
        checkMeasureForV7(c.result as MeasureResult, f.provision_id, f.target, `cited call ${cid}`);
      } else if (isExceptionResultLike(c.result)) {
        for (const cond of c.result.conditions) {
          if (cond.measure) {
            checkMeasureForV7(
              cond.measure,
              f.provision_id,
              f.target,
              `exception condition ${cond.clause_id} in call ${cid}`,
            );
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // V8_GUARD: every not_applicable finding cites an evaluate_guards call whose result is known_false.
  // ------------------------------------------------------------------
  for (const f of report.findings) {
    if (f.outcome !== "not_applicable") continue;

    let hasKnownFalseGuardCall = false;
    const citedGuardStatuses: string[] = [];

    for (const cid of f.evidence_call_ids) {
      const c = calls.get(cid);
      if (!c || !c.ok || c.tool !== "evaluate_guards" || !isGuardResultLike(c.result)) {
        continue;
      }
      citedGuardStatuses.push(c.result.result);
      if (c.result.result === "known_false" && c.result.provision_id === f.provision_id) {
        hasKnownFalseGuardCall = true;
      }
    }

    if (!hasKnownFalseGuardCall) {
      issues.push({
        code: "V8_GUARD",
        provision_id: f.provision_id,
        target: f.target,
        message: `Finding for ${f.provision_id} (${f.target}) has outcome 'not_applicable', but does not cite an evaluate_guards call with result 'known_false' (cited guard results: ${citedGuardStatuses.length ? citedGuardStatuses.join(", ") : "none"}).`,
        detail: { evidence_call_ids: f.evidence_call_ids, cited_guard_results: citedGuardStatuses },
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}
