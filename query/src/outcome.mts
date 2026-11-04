// Code decides every finding's outcome (Martin, 2026-11-02, after a live S1 run where a side-setback "pass" cited only
// the front-line check). The model names the provision, target, clauses and quotes; this function reads EVERY successful
// result for that provision at that target, not only the cited ones, and returns the outcome and the evidence behind it.
//
// Measure 2 (Martin, 11-02, after S7 accepted a flag-lot setback "pass" proven with physical_fit): when a provision has
// operators in graph/curated/operators.json, only results from those operators' tools count as its evidence, and every
// `requires` entry (tool + matched argument facts + parameter) must have a result before the outcome can be pass.
// Pure; no I/O. CC.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Outcome = "pass" | "fail" | "not_applicable" | "unknown" | "too_close_to_call";

export interface CallRecord {
  call_id: string;
  tool: string;
  provision_id: string | null;
  target: string;
  ok: boolean;
  result: unknown;
  args?: Record<string, unknown>;
}

/** One check a pass needs: the tool, argument facts it must be called with, and the parameter its limit must be. */
export interface Requirement { tool: string; match?: Record<string, string>; param?: string } // param "PID:name" (zone resolved)
export interface ProvisionRules { tools: Set<string>; requires: Requirement[]; siblings: Set<string>; partial?: string[]; argsMatch?: Array<{ tool: string; args: Record<string, string> }> } // siblings share an operator; partial (P3): operators that check only part of it

export interface ComputedOutcome {
  outcome: Outcome | null;            // null = no decidable evidence yet (see reason)
  evidence_call_ids: string[];        // the results the outcome rests on (what the finding must cite)
  reason: string;
  missing?: Requirement[];            // required checks not yet run
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Rules per provision from operators.json; `{zone}` in a required parameter is replaced by the case's zone. */
/** L40: the clauses each operator's tool evaluates (operators.json `covers`), keyed by operator id. */
export type Cover = { op: string; tool: string; provision: string; clause: string; note: string; date: string };
export function loadOperatorCovers(operatorsPath?: string): Cover[] {
  const p = operatorsPath ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "graph", "curated", "operators.json");
  const ops = JSON.parse(readFileSync(p, "utf8")).operators as Array<{ id: string; tool: string; covers?: Array<{ provision: string; clause: string; note: string; date: string }> }>;
  return ops.flatMap((o) => (o.covers ?? []).map((c) => ({ op: o.id, tool: o.tool, provision: c.provision, clause: c.clause, note: c.note, date: c.date })));
}

/** B5: provisions whose operator is an exception that relaxes required setbacks (kind exception_conditions). */
export function loadRelaxingExceptionProvisions(operatorsPath?: string): Set<string> {
  const p = operatorsPath ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "graph", "curated", "operators.json");
  const ops = JSON.parse(readFileSync(p, "utf8")).operators as Array<{ kind?: string; provisions?: string[] }>;
  return new Set(ops.filter((o) => o.kind === "exception_conditions").flatMap((o) => o.provisions ?? []));
}

export function loadProvisionRules(zone: string, operatorsPath?: string): Map<string, ProvisionRules> {
  const p = operatorsPath ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "graph", "curated", "operators.json");
  const ops = JSON.parse(readFileSync(p, "utf8")).operators as Array<{ id?: string; tool: string; provisions?: string[]; requires?: Requirement[]; partial?: string; args_match?: Record<string, string> }>;
  const out = new Map<string, ProvisionRules>();
  for (const o of ops) {
    for (const pid of o.provisions ?? []) {
      const r = out.get(pid) ?? { tools: new Set<string>(), requires: [], siblings: new Set<string>() };
      r.tools.add(o.tool);
      if (o.partial) (r.partial ??= []).push(`${o.id ?? o.tool}: ${o.partial}`);
      if (o.args_match) (r.argsMatch ??= []).push({ tool: o.tool, args: o.args_match });
      for (const other of o.provisions ?? []) if (other !== pid) r.siblings.add(other);
      for (const rq of o.requires ?? []) r.requires.push({ ...rq, ...(rq.param ? { param: rq.param.replace("{zone}", zone) } : {}) });
      out.set(pid, r);
    }
  }
  return out;
}

function belongs(c: CallRecord, pid: string, target: string, siblings?: Set<string>): boolean {
  if (!c.ok || c.target !== target || !isObj(c.result)) return false;
  if (c.tool === "record_finding" || c.tool === "conclude") return false;
  // Calls tagged to a provision that shares the operator (220.B and Table 110-4 both bind op.base_setbacks) count too.
  return c.provision_id === pid || c.result["limit"]?.provision_id === pid || (!!c.provision_id && !!siblings?.has(c.provision_id));
}

function satisfies(c: CallRecord, rq: Requirement): boolean {
  if (c.tool !== rq.tool) return false;
  for (const [k, fact] of Object.entries(rq.match ?? {})) {
    const a = c.args?.[k] as { fact?: string } | undefined;
    if (!a || a.fact !== fact) return false;
  }
  if (rq.param) {
    const lim = (c.result as any)?.limit;
    if (!lim || `${lim.provision_id}:${lim.param}` !== rq.param) return false;
  }
  return true;
}

/** `rules`: the provision's operator rules; `null` = the Rulebook has no instrument for it (the harness passes null). */
export function computeFindingOutcome(calls: Iterable<CallRecord>, pid: string, target: string, rules?: ProvisionRules | null): ComputedOutcome {
  const all = [...calls];
  let mine = all.filter((c) => belongs(c, pid, target, rules?.siblings));
  const guards = mine.filter((c) => c.tool === "evaluate_guards");
  // With operators, only the operators' tools are evidence for this provision (not physical_fit, not distance_to_line).
  let measures = mine.filter((c) => c.tool !== "evaluate_guards" && "pass" in (c.result as object));
  if (rules && rules.tools.size > 0) measures = measures.filter((c) => rules.tools.has(c.tool));
  // AG 4b: an operator may pin argument values (B.1.a's allowed-use check reads the ADU row only); other calls are not evidence.
  if (rules?.argsMatch?.length) measures = measures.filter((c) => rules.argsMatch!.filter((m) => m.tool === c.tool)
    .every((m) => Object.entries(m.args).every(([k, v]) => String((c.args as Record<string, unknown> | undefined)?.[k]) === v)));
  // Build-review R2 B5: with no instrument in the Rulebook, no measuring call is evidence for the provision (a check_max
  // tagged to a walkway rule is not its check): only its guards are, so it is never a pass.
  else if (rules === null || (rules && rules.tools.size === 0)) measures = [];
  // An exception whose conditions all hold cures a failed base rule at the same target (§3 step 3).
  const cures = all.filter((c) => c.ok && c.target === target && c.tool === "check_exception_conditions" && isObj(c.result) &&
    c.result["base_provision_id"] === pid && c.result["pass"] === true);

  if (measures.length === 0) {
    const ruledOut = guards.find((g) => (g.result as any).result === "known_false");
    if (ruledOut) return { outcome: "not_applicable", evidence_call_ids: [ruledOut.call_id], reason: "a guard is known false" };
    const tools = rules && rules.tools.size ? ` with ${[...rules.tools].join(" or ")}` : "";
    return { outcome: null, evidence_call_ids: [], reason: `no check of this provision at this target${tools}`, missing: rules?.requires };
  }
  const failed = measures.filter((c) => (c.result as any).pass === false);
  const undecided = measures.filter((c) => (c.result as any).pass === null);
  const passed = measures.filter((c) => (c.result as any).pass === true);
  if (failed.length > 0) {
    if (cures.length > 0) {
      const cured = `failed ${failed.map((c) => c.call_id).join(", ")} but exception ${String((cures[0]!.result as any).exception_id)} holds`;
      // Build-review A8: a cure lifts the failed part only; a partial operator still leaves the rest unchecked.
      if (rules?.partial?.length) return { outcome: "unknown", evidence_call_ids: [...passed.map((c) => c.call_id), cures[0]!.call_id],
        reason: `${cured}, but only part of the provision is checked by code: ${rules.partial.join("; ")}` };
      return { outcome: "pass", evidence_call_ids: [...passed.map((c) => c.call_id), cures[0]!.call_id], reason: cured };
    }
    // B3 (rules-as-data panel, 2026-11-02): an exception for this rule whose conditions are unknown leaves the outcome
    // unknown ("fails unless the exception holds"), never a plain fail.
    const openCures = all.filter((c) => c.ok && c.target === target && c.tool === "check_exception_conditions" && isObj(c.result) &&
      c.result["base_provision_id"] === pid && c.result["pass"] === null);
    if (openCures.length > 0) return { outcome: "unknown", evidence_call_ids: [...failed.map((c) => c.call_id), openCures[0]!.call_id],
      reason: `failed ${failed.map((c) => c.call_id).join(", ")} unless exception ${String((openCures[0]!.result as any).exception_id)} holds (its conditions are unknown)` };
    return { outcome: "fail", evidence_call_ids: failed.map((c) => c.call_id), reason: `${failed.length} check(s) failed` };
  }
  if (undecided.length > 0) {
    const tcc = undecided.some((c) => (c.result as any).too_close_to_call === true);
    return { outcome: tcc ? "too_close_to_call" : "unknown", evidence_call_ids: [...undecided, ...passed].map((c) => c.call_id),
      reason: tcc ? "a margin is within tolerance" : "a check is undecided" };
  }
  // Everything run so far passed: a pass also needs every required check (measure 2).
  const missing = (rules?.requires ?? []).filter((rq) => !measures.some((c) => satisfies(c, rq)));
  if (missing.length > 0) return { outcome: null, evidence_call_ids: passed.map((c) => c.call_id), missing,
    reason: `required check(s) not run: ${missing.map(describeRequirement).join("; ")}` };
  // P3 (contracts 1.4.0): an operator that checks only part of the provision cannot make it pass; what it checked
  // passed, the rest is not checked by code, so the outcome is unknown, naming what is missing.
  if (rules?.partial?.length) return { outcome: "unknown", evidence_call_ids: passed.map((c) => c.call_id),
    reason: `${passed.length} check(s) passed, but only part of the provision is checked by code: ${rules.partial.join("; ")}` };
  return { outcome: "pass", evidence_call_ids: passed.map((c) => c.call_id), reason: `${passed.length} check(s) passed` };
}

const LIMIT_ARG: Record<string, string> = { check_setback: "min", check_front_or_behind: "min_front", check_max: "limit", footprint_dimensions: "limit", coverage_share: "limit" };
export function describeRequirement(rq: Requirement): string {
  const m = Object.entries(rq.match ?? {}).map(([k, f]) => `${k}: {fact: "${f}"}`).join(", ");
  const [pp, pn] = (rq.param ?? ":").split(":");
  const arg = LIMIT_ARG[rq.tool] ?? "limit";
  return `${rq.tool}(outline: {placed: {x, y, rotation}, footprint: {fact: "plan.footprint"}}, ${m}${m && rq.param ? ", " : ""}${rq.param ? `${arg}: {provision_id: "${pp}", param: "${pn}"}` : ""})`;
}
