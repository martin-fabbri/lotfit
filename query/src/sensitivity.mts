/**
 * LotFit deterministic sensitivity engine and question generator (W5, milestone 1).
 *
 * Implements:
 *   - `ruleFamily(provision_id, as_of) -> RuleFamily` (C2_RuleFamily; single seam over
 *     `graph/out/graph-or.json` so W1's `graph-tools.mts` can swap in cleanly)
 *   - `runSensitivity({ case, findings, plan, selected_placement }) -> Sensitivity` (C5_Sensitivity)
 *   - `buildQuestions(case, sensitivity) -> QuestionSet` (C5_QuestionSet)
 *   - `buildNominalContext(case)` for deterministic zero-model baseline evaluation via `graph/tool_runner.py`
 *
 * Model calls: ZERO. Every tool evaluation runs through `graph/tool_runner.py` over a C3 `BridgeRequest`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { checkCase } from "./case-gate.mts";
import * as C from "./types.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GRAPH_OR_PATH = path.resolve(REPO_ROOT, "graph", "out", "graph-or.json");
const FACTS_PATH = path.resolve(REPO_ROOT, "graph", "curated", "facts.json");
const OPERATORS_PATH = path.resolve(REPO_ROOT, "graph", "curated", "operators.json");
const AMBIGUITIES_PATH = path.resolve(REPO_ROOT, "graph", "curated", "ambiguities.json");
const RELATIONS_PATH = path.resolve(REPO_ROOT, "graph", "curated", "relations.json");
const CONFIRMATIONS_PATH = path.resolve(REPO_ROOT, "graph", "curated", "confirmations.jsonl");
const TOOL_RUNNER_PATH = path.resolve(REPO_ROOT, "graph", "tool_runner.py");

export type CaseType = z.infer<typeof C.Case>;
export type PlanType = z.infer<typeof C.Plan>;
export type PlacementType = z.infer<typeof C.Placement>;
export type RuleFamilyType = z.infer<typeof C.RuleFamily>;
export type BridgeRequestType = z.infer<typeof C.BridgeRequest>;
export type BridgeResponseType = z.infer<typeof C.BridgeResponse>;
export type SensitivityType = z.infer<typeof C.Sensitivity>;
export type BranchType = z.infer<typeof C.Branch>;
export type QuestionType = z.infer<typeof C.Question>;
export type QuestionSetType = z.infer<typeof C.QuestionSet>;
export type VerdictType = z.infer<typeof C.Verdict>;
export type OutcomeType = z.infer<typeof C.Outcome>;
export type TargetType = z.infer<typeof C.Target>;
export type EvaluationStageType = z.infer<typeof C.EvaluationStage>;
export type MeasureResultType = z.infer<typeof C.MeasureResult>;
export type ExceptionResultType = z.infer<typeof C.ExceptionResult>;
export type GuardResultType = z.infer<typeof C.GuardResult>;
export type PlacementSearchResultType = z.infer<typeof C.PlacementSearchResult>;

/**
 * Minimal finding shape accepted by `runSensitivity` (compatible with both `C4_RecordFinding`
 * and `C7_ReportFinding`).
 */
export interface FindingInput {
  provision_id: string;
  target: TargetType;
  outcome: OutcomeType;
  evaluation_stage?: EvaluationStageType;
  clause_ids?: string[];
  measures?: MeasureResultType[];
  ambiguous_reading_split?: boolean;
}

export interface SensitivityInput {
  case: CaseType | Record<string, unknown>;
  findings?: FindingInput[];
  plan?: PlanType;
  selected_placement?: PlacementType | null;
}

export interface SensitivityWithQuestions {
  sensitivity: SensitivityType;
  questions: QuestionSetType;
}

// ------------------------------------------------------------------ Caches & Graph Data

interface RawFactDef {
  name: string;
  scope: string;
  type: string;
  unit?: string;
  values?: unknown[];
  accepted_sources: string[];
  required_for?: string[];
  computed?: {
    from: string[];
    how: string;
  };
  description?: string;
}

interface RawOperatorDef {
  id: string;
  kind: string;
  places: boolean;
  tool: string;
  reads: string[];
  params: Array<{ provision: string; param: string }>;
  cells?: Array<{ provision_id: string; cell_id: string }>;
  provisions: string[];
  requires?: Array<{ tool: string; match?: Record<string, string>; param?: string }>;
}

interface RawAmbiguityDef {
  id: string;
  provision: string;
  phrase: string;
  status: "active" | "settled";
  settled_by: string;
  matters_when: Array<{ fact: string; op: string; value?: unknown }>;
  effects: Array<{
    provision?: string;
    param?: string;
    by_reading?: unknown[];
    fact?: string;
    per_reading?: string;
  }>;
}

interface RawRelationDef {
  from: string;
  to: string;
  kind: "modifies" | "preempts" | "uses";
  quote: string;
  term?: string;
}

let cachedGraph: Record<string, any> | null = null;
let cachedFacts: Map<string, RawFactDef> | null = null;
let cachedOperators: RawOperatorDef[] | null = null;
let cachedAmbiguities: RawAmbiguityDef[] | null = null;
let cachedRelations: RawRelationDef[] | null = null;
let cachedConfirmations: Array<Record<string, any>> | null = null;

function getGraph(): Record<string, any> {
  if (!cachedGraph) {
    cachedGraph = JSON.parse(readFileSync(GRAPH_OR_PATH, "utf8")) as Record<string, any>;
  }
  return cachedGraph;
}

function getFactsRegistry(): Map<string, RawFactDef> {
  if (!cachedFacts) {
    const raw = JSON.parse(readFileSync(FACTS_PATH, "utf8")) as { facts: RawFactDef[] };
    cachedFacts = new Map(raw.facts.map((f) => [f.name, f]));
  }
  return cachedFacts;
}

function getOperators(): RawOperatorDef[] {
  if (!cachedOperators) {
    const raw = JSON.parse(readFileSync(OPERATORS_PATH, "utf8")) as { operators: RawOperatorDef[] };
    cachedOperators = raw.operators;
  }
  return cachedOperators;
}

function getAmbiguities(): RawAmbiguityDef[] {
  if (!cachedAmbiguities) {
    const raw = JSON.parse(readFileSync(AMBIGUITIES_PATH, "utf8")) as { ambiguities: RawAmbiguityDef[] };
    cachedAmbiguities = raw.ambiguities;
  }
  return cachedAmbiguities;
}

function getRelations(): RawRelationDef[] {
  if (!cachedRelations) {
    const raw = JSON.parse(readFileSync(RELATIONS_PATH, "utf8")) as { relations: RawRelationDef[] };
    cachedRelations = raw.relations;
  }
  return cachedRelations;
}

function getConfirmations(): Array<Record<string, any>> {
  if (!cachedConfirmations) {
    try {
      const lines = readFileSync(CONFIRMATIONS_PATH, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      cachedConfirmations = lines.map((l) => JSON.parse(l) as Record<string, any>);
    } catch {
      cachedConfirmations = [];
    }
  }
  return cachedConfirmations;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic UUIDv7 generator from a seed string so sensitivity runs and Question IDs
 * are reproducible across invocations.
 */
export function deterministicUuid7(seed: string, timestampMs = 1762032000000): string {
  const hash = createHash("sha256").update(seed, "utf8").digest();
  const b = Buffer.alloc(16);
  hash.copy(b, 0, 0, 16);
  const ts = BigInt(timestampMs);
  for (let i = 0; i < 6; i++) {
    b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function normText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function statusOnDate(v: Record<string, any>, asOf: string): string {
  const effFrom = typeof v["effective_from"] === "string" ? v["effective_from"] : null;
  const opFrom = typeof v["operative_from"] === "string" ? v["operative_from"] : null;
  const start = effFrom && opFrom ? (effFrom > opFrom ? effFrom : opFrom) : effFrom ?? opFrom;
  if (typeof v["effective_to"] === "string" && asOf >= v["effective_to"]) {
    return "ended";
  }
  if (!start) {
    return "in_force_date_not_stated";
  }
  return asOf >= start ? "in_force" : "not_yet_in_force";
}

// ------------------------------------------------------------------ C2 · ruleFamily(provision_id, as_of)

/**
 * Single seam for reading a `RuleFamily` (`C2_RuleFamily`) from `graph/out/graph-or.json`
 * so W1's `graph-tools.mts` can swap in cleanly.
 */
/** B9 (rules-as-data panel, 2026-11-02): Table 110-5's row for a lot area, read from the graph's cells (the same row
 *  grammar the tool parses), so the cell id, row and text are the graph's, never a copy typed into code. */
const NUM = String.raw`([\d,]+(?:\.\d+)?)`;
export function coverageRowRange(row: string): [number, number] {
  const t = row.toLowerCase(), n = (x: string) => Number(x.replace(/,/g, ""));
  let m = t.match(new RegExp(`^less than ${NUM}`)); if (m) return [0, n(m[1]!)];
  m = t.match(new RegExp(`^${NUM} sq\\. ft\\.? or more but less than ${NUM}`)); if (m) return [n(m[1]!), n(m[2]!)];
  m = t.match(new RegExp(`^${NUM} sq\\. ft\\.? or more`)); if (m) return [n(m[1]!), Infinity];
  throw new Error(`coverageRowRange: unrecognised row label: ${row}`);
}
export function coverageCellFor(lotArea: number, asOf: string, provisionId = "PDX.T110-5"): { provision_id: string; cell_id: string; row: string; cell: string } {
  if (!Number.isFinite(lotArea)) throw new Error("coverageCellFor: lot area unknown");
  const rf = ruleFamily(provisionId, asOf);
  for (const c of rf.cells.filter((x) => /coverage/i.test(x.column))) {
    const [lo, hi] = coverageRowRange(c.row);
    if (lotArea >= lo && lotArea < hi) return { provision_id: provisionId, cell_id: c.cell_id, row: c.row, cell: c.text };
  }
  throw new Error(`coverageCellFor: no ${provisionId} row covers a lot area of ${lotArea} sq ft`);
}

export function ruleFamily(provision_id: string, as_of: string): RuleFamilyType {
  const g = getGraph();
  const provisions = (g["provisions"] ?? []) as Array<Record<string, any>>;
  const p = provisions.find((pv) => pv["id"] === provision_id);
  if (!p) {
    throw new Error(`ruleFamily: unknown provision_id '${provision_id}'`);
  }

  const versions = (p["versions"] ?? []) as Array<Record<string, any>>;
  const liveVersions = versions.filter((ver) => {
    const st = statusOnDate(ver, as_of);
    return st === "in_force" || st === "in_force_date_not_stated";
  });
  const v = (liveVersions.length > 0 ? liveVersions[liveVersions.length - 1] : versions[versions.length - 1])!;
  const verNum = Number(v["version"] ?? 1);
  const versionId = `${provision_id}#v${verNum}`;

  const versionHash = sha256Hex(
    JSON.stringify({
      v: verNum,
      text: v["text"],
      params: v["params"] ?? [],
      from: v["effective_from"] ?? null,
    }),
  );

  const ops = getOperators().filter((o) => o.provisions.includes(provision_id));
  let evaluationStage: EvaluationStageType;
  if (p["type"] === "gate") {
    evaluationStage = "gate";
  } else if (p["type"] === "exception") {
    evaluationStage = "exception";
  } else if (p["type"] === "definition") {
    evaluationStage = "definition";
  } else if (p["type"] === "preemption") {
    evaluationStage = "preemption";
  } else {
    const isPlacement = ops.some(
      (o) =>
        o.places ||
        o.reads.includes("plan.outline") ||
        o.reads.includes("plan.placement") ||
        o.reads.includes("plan.setbacks_used"),
    );
    evaluationStage = isPlacement ? "placement_constraint" : "plan_constraint";
  }

  const rawClauses = (v["clauses"] ?? []) as Array<Record<string, any>>;
  const confirmations = getConfirmations();

  const clauses: RuleFamilyType["clauses"] = rawClauses.map((c) => {
    const clauseId = `${versionId}::${String(c["id"])}`;
    const rawGuards = (c["guards"] ?? []) as Array<Record<string, unknown>>;
    const validGuards = rawGuards
      .filter((gd) => typeof gd["fact"] === "string" && /^(site|plan)\.[a-z0-9_]+$/.test(gd["fact"]))
      .map((gd) => ({
        fact: String(gd["fact"]),
        op: String(gd["op"] ?? "=="),
        ...(gd["value"] !== undefined ? { value: gd["value"] } : {}),
      }));

    const confWithDisp = [...confirmations]
      .reverse()
      .find((cf) => cf["item"] === clauseId && cf["disposition"] != null);
    const disposition = confWithDisp ? (confWithDisp["disposition"] as RuleFamilyType["clauses"][number]["disposition"]) : null;

    return {
      clause_id: clauseId,
      kind: String(c["kind"] ?? "sentence"),
      quote: String(c["quote"] ?? ""),
      modeled: c["status"] === "modeled" || c["status"] === "structural",
      guards: validGuards,
      disposition,
    };
  });

  const rawParams = (v["params"] ?? []) as Array<Record<string, any>>;
  const params: RuleFamilyType["params"] = rawParams.map((q) => {
    const name = String(q["name"]);
    const modelingClause = rawClauses.find(
      (c) => Array.isArray(c["by"]) && (c["by"] as string[]).includes(`param:${name}`),
    );
    const clauseId = modelingClause ? `${versionId}::${String(modelingClause["id"])}` : null;
    const rawVal = q["value"];
    const val: number | string =
      typeof rawVal === "number" || typeof rawVal === "string"
        ? rawVal
        : Array.isArray(rawVal)
          ? rawVal.join(", ")
          : String(rawVal ?? "");
    const quote =
      typeof q["quote"] === "string"
        ? q["quote"]
        : q["cell"]
          ? JSON.stringify(q["cell"])
          : String(val);

    return {
      param_id: `${versionId}::param:${name}`,
      provision_id,
      name,
      value: val,
      unit: typeof q["unit"] === "string" ? q["unit"] : null,
      quote,
      clause_id: clauseId,
    };
  });

  const rawCells = (v["table_cells"] ?? []) as Array<Record<string, any>>;
  const cells: RuleFamilyType["cells"] = rawCells.map((c, idx) => ({
    cell_id: `${versionId}::cell:${idx + 1}`,
    table: String(c["table"] ?? ""),
    row: String(c["row"] ?? ""),
    column: String(c["column"] ?? ""),
    text: String(c["cell"] ?? ""),
  }));

  const ambiguities = getAmbiguities();
  const rawReadings = (v["readings"] ?? []) as Array<Record<string, any>>;
  const readings: RuleFamilyType["readings"] = rawReadings.map((r, idx) => {
    const phrase = String(r["phrase"] ?? "");
    const matchedAmb = ambiguities.find(
      (a) => a.provision === provision_id && normText(a.phrase) === normText(phrase),
    );
    const rdList = Array.isArray(r["readings"])
      ? (r["readings"] as unknown[]).map((item) =>
          typeof item === "string"
            ? item
            : item && typeof item === "object" && "text" in (item as Record<string, unknown>)
              ? String((item as Record<string, unknown>)["text"])
              : item && typeof item === "object" && "reading" in (item as Record<string, unknown>)
                ? String((item as Record<string, unknown>)["reading"])
                : JSON.stringify(item),
        )
      : ["reading 1", "reading 2"];
    return {
      ambiguity_id: matchedAmb?.id ?? `${provision_id}::reading:${idx + 1}`,
      phrase,
      readings: rdList.length >= 2 ? rdList : [...rdList, "alternative reading"],
      settled_by: matchedAmb?.settled_by ?? "building official",
    };
  });

  const grayAreaEffects: RuleFamilyType["gray_area_effects"] = [];
  for (const a of ambiguities) {
    if (a.provision !== provision_id && !a.effects.some((e) => e.provision === provision_id)) {
      continue;
    }
    for (const e of a.effects) {
      grayAreaEffects.push({
        ambiguity_id: a.id,
        ...(e.fact ? { fact: e.fact } : {}),
        ...(e.provision ? { provision_id: e.provision } : {}),
        ...(e.param ? { param: e.param } : {}),
      });
    }
  }

  const relations = getRelations();
  const modifiedBy: string[] = [];
  const todoMod = [provision_id];
  while (todoMod.length > 0) {
    const cur = todoMod.pop()!;
    for (const r of relations) {
      if (r.kind === "modifies" && r.to === cur && !modifiedBy.includes(r.from)) {
        modifiedBy.push(r.from);
        todoMod.push(r.from);
      }
    }
  }
  const familyMembers = [provision_id, ...modifiedBy];
  const preemptedBy = Array.from(
    new Set(
      relations
        .filter((r) => r.kind === "preempts" && familyMembers.includes(r.to))
        .map((r) => r.from),
    ),
  );

  const provById = new Map(provisions.map((pv) => [String(pv["id"]), pv]));
  const usesDefinitions: string[] = [];
  const todoDefs = [...familyMembers, ...preemptedBy];
  const seenDefs = new Set(todoDefs);
  while (todoDefs.length > 0) {
    const cur = todoDefs.pop()!;
    for (const r of relations) {
      if (r.kind === "uses" && r.from === cur && !usesDefinitions.includes(r.to)) {
        usesDefinitions.push(r.to);
        if (!seenDefs.has(r.to)) {
          seenDefs.add(r.to);
          todoDefs.push(r.to);
        }
      }
    }
    const pv = provById.get(cur);
    for (const u of (pv?.["uses"] ?? []) as string[]) {
      if (provById.has(u) && !usesDefinitions.includes(u)) {
        usesDefinitions.push(u);
        if (!seenDefs.has(u)) {
          seenDefs.add(u);
          todoDefs.push(u);
        }
      }
    }
  }

  return C.RuleFamily.parse({
    provision_id,
    version_id: versionId,
    sha256: versionHash,
    evaluation_stage: evaluationStage,
    params,
    cells,
    clauses,
    readings,
    gray_area_effects: grayAreaEffects,
    operators: ops.map((o) => ({ operator_id: o.id, tool: o.tool })),
    modified_by: modifiedBy,
    preempted_by: preemptedBy,
    uses_definitions: usesDefinitions,
  });
}

// ------------------------------------------------------------------ C3 · Python Tool Bridge (`graph/tool_runner.py`)

const DEFAULT_CONFIG_HASH = "0".repeat(64);

/**
 * Execute a batch of tool calls through `graph/tool_runner.py` and validate both
 * `BridgeRequest` and `BridgeResponse` against C3.
 */
export function callToolBridge(
  batch: BridgeRequestType["batch"],
  configHash = DEFAULT_CONFIG_HASH,
): Map<string, unknown> {
  if (batch.length === 0) {
    return new Map();
  }
  const req: BridgeRequestType = C.BridgeRequest.parse({
    config_hash: configHash,
    batch,
  });

  const stdout = execFileSync("python3", ["-I", TOOL_RUNNER_PATH], {
    input: JSON.stringify(req),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  const resp: BridgeResponseType = C.BridgeResponse.parse(JSON.parse(stdout));
  const out = new Map<string, unknown>();
  for (const r of resp.results) {
    if (!r.ok) {
      throw new Error(`Tool bridge call ${r.call_id} failed (${r.error.category}): ${r.error.message}`);
    }
    out.set(r.call_id, r.result);
  }
  return out;
}

// ------------------------------------------------------------------ COMPUTED_FROM⁻¹ & Fact Helpers

/**
 * Compute the transitive closure of `factName` under `COMPUTED_FROM⁻¹` using `graph/curated/facts.json`
 * and the case materializer's `COMPUTED_FROM` edges (`ARCHITECTURE.md` §3 step 3, panel finding F6).
 */
export function computedFromInverseClosure(factName: string): Set<string> {
  const factsMap = getFactsRegistry();
  const reverseDeps = new Map<string, string[]>();
  for (const [name, def] of factsMap.entries()) {
    const sources = def.computed?.from ?? [];
    for (const src of sources) {
      const list = reverseDeps.get(src) ?? [];
      if (!list.includes(name)) {
        list.push(name);
      }
      reverseDeps.set(src, list);
    }
  }

  // Include materializer COMPUTED_FROM edges alongside facts.json
  const materializerEdges: Array<[string, string]> = [
    ["site.zone", "site.zone_family"],
    ["site.lot_outline", "site.lot_area_sqft"],
    ["site.house_outline", "site.house_rear_wall"],
    ["site.front_lot_line", "site.house_rear_wall"],
    ["plan.footprint", "plan.outline"],
    ["plan.placement", "plan.outline"],
    ["plan.outline", "plan.setbacks_used"],
    ["site.front_lot_line", "plan.setbacks_used"],
    ["site.side_lot_lines", "plan.setbacks_used"],
    ["site.rear_lot_line", "plan.setbacks_used"],
  ];
  for (const [src, dst] of materializerEdges) {
    const list = reverseDeps.get(src) ?? [];
    if (!list.includes(dst)) {
      list.push(dst);
      reverseDeps.set(src, list);
    }
  }

  // Transitive BFS over COMPUTED_FROM⁻¹ (e.g. plan.footprint -> plan.outline -> plan.setbacks_used)
  const closure = new Set<string>([factName]);
  const queue = [factName];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const dep of reverseDeps.get(cur) ?? []) {
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }
  return closure;
}

function getFactEntry(kase: Record<string, any>, fullFact: string): Record<string, any> | undefined {
  const [scope, key] = fullFact.split(".") as ["site" | "plan", string];
  return kase[scope]?.[key] as Record<string, any> | undefined;
}

function setKnownFactValue(
  kase: Record<string, any>,
  fullFact: string,
  newValue: unknown,
  overrideToleranceFt?: number,
): void {
  const [scope, key] = fullFact.split(".") as ["site" | "plan", string];
  if (!kase[scope]) kase[scope] = {};
  const existing = kase[scope][key] as Record<string, any> | undefined;

  let baseProv: Array<Record<string, any>> = [
    {
      kind: "entered",
      document: "sensitivity branch",
      where: fullFact,
      when: kase["as_of"]?.["date"] ?? "2026-11-01",
      by: "sensitivity-engine",
      status: "assumed",
      rests_on: "sensitivity-branch",
    },
  ];

  if (existing) {
    if (Array.isArray(existing["observations"]) && existing["observations"].length > 0) {
      baseProv = structuredClone(existing["observations"][0]["prov"]);
    } else if (Array.isArray(existing["prov"]) && existing["prov"].length > 0) {
      baseProv = structuredClone(existing["prov"]);
    }
  }

  if (overrideToleranceFt !== undefined) {
    for (const pr of baseProv) {
      if (pr["tolerance"] && typeof pr["tolerance"] === "object") {
        pr["tolerance"]["value"] = overrideToleranceFt;
      }
    }
  }

  kase[scope][key] = {
    value: newValue,
    prov: baseProv,
    status: "known",
  };

  if (Array.isArray(kase["unknowns"])) {
    kase["unknowns"] = kase["unknowns"].filter((u: any) => u?.fact !== fullFact);
  }
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

function resolveScalarFactValue(kase: Record<string, any>, fullFact: string): unknown {
  const entry = getFactEntry(kase, fullFact);
  if (!entry) return undefined;
  if (Array.isArray(entry["observations"]) && entry["observations"].length > 0) {
    return entry["observations"][0]["value"];
  }
  return entry["value"];
}

function isFactConflicting(kase: Record<string, any>, fullFact: string): boolean {
  const entry = getFactEntry(kase, fullFact);
  if (!entry || !Array.isArray(entry["observations"])) return false;
  const serialized = new Set(entry["observations"].map((o: any) => JSON.stringify(o["value"])));
  return serialized.size > 1;
}

function isFactUnknown(kase: Record<string, any>, fullFact: string): boolean {
  const unknowns = (kase["unknowns"] ?? []) as Array<{ fact: string; reason: string }>;
  if (unknowns.some((u) => u.fact === fullFact)) return true;
  return getFactEntry(kase, fullFact) === undefined;
}

function isFactUnconfirmed(kase: Record<string, any>, fullFact: string): boolean {
  const entry = getFactEntry(kase, fullFact);
  if (!entry || Array.isArray(entry["observations"])) return false;
  if (entry["status"] === "unconfirmed") return true;
  const provs = (entry["prov"] ?? []) as Array<Record<string, any>>;
  return provs.some((p) => p["status"] === "unconfirmed");
}

function getFactActiveReadingValues(kase: Record<string, any>, fullFact: string): unknown[] | null {
  const entry = getFactEntry(kase, fullFact);
  if (!entry || typeof entry !== "object" || !entry["by_reading"] || typeof entry["by_reading"] !== "object") {
    return null;
  }
  const activeAmbs = new Set(
    getAmbiguities()
      .filter((a) => a.status === "active")
      .map((a) => a.id),
  );
  const byReading = entry["by_reading"] as Record<string, unknown[]>;
  for (const [ambId, vals] of Object.entries(byReading)) {
    if ((activeAmbs.size === 0 || activeAmbs.has(ambId)) && Array.isArray(vals) && vals.length >= 2) {
      return vals;
    }
  }
  return null;
}

// ------------------------------------------------------------------ Geometry Perturbation & Materialization

function polygonArea(poly: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  const qx = ax + t * vx;
  const qy = ay + t * vy;
  return Math.hypot(px - qx, py - qy);
}

function segmentsIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const ccw = (p1: [number, number], p2: [number, number], p3: [number, number]) =>
    (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
  const d1 = ccw(a, b, c);
  const d2 = ccw(a, b, d);
  const d3 = ccw(c, d, a);
  const d4 = ccw(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function distancePolygonToSegment(
  poly: Array<[number, number]>,
  seg: [[number, number], [number, number]],
): number {
  const [a, b] = seg;
  let minD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i]!;
    const p2 = poly[(i + 1) % poly.length]!;
    if (segmentsIntersect(p1, p2, a, b)) return 0;
    minD = Math.min(
      minD,
      pointToSegmentDistance(p1[0], p1[1], a[0], a[1], b[0], b[1]),
      pointToSegmentDistance(a[0], a[1], p1[0], p1[1], p2[0], p2[1]),
      pointToSegmentDistance(b[0], b[1], p1[0], p1[1], p2[0], p2[1]),
    );
  }
  return minD;
}

function computePlacedOutline(
  footprint: Array<[number, number]>,
  placement: { x: number; y: number; rotation?: number },
): Array<[number, number]> {
  const rot = ((placement.rotation ?? 0) % 360 + 360) % 360;
  const rad = (rot * Math.PI) / 180;
  const c = Math.round(Math.cos(rad));
  const s = Math.round(Math.sin(rad));
  return footprint.map(([px, py]) => [
    Number((placement.x + px * c - py * s).toFixed(6)),
    Number((placement.y + px * s + py * c).toFixed(6)),
  ]);
}

function computeHouseRearWall(
  houseOutline: Array<[number, number]>,
  frontLotLine: [[number, number], [number, number]],
): [[number, number], [number, number]] {
  let bestEdge: [[number, number], [number, number]] = [houseOutline[0]!, houseOutline[1]!];
  let bestDist = -1;
  for (let i = 0; i < houseOutline.length; i++) {
    const p1 = houseOutline[i]!;
    const p2 = houseOutline[(i + 1) % houseOutline.length]!;
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    const d = pointToSegmentDistance(mx, my, frontLotLine[0][0], frontLotLine[0][1], frontLotLine[1][0], frontLotLine[1][1]);
    if (d > bestDist) {
      bestDist = d;
      bestEdge = [p1, p2];
    }
  }
  return bestEdge;
}

// AG r2 R2-7 / panel A20: facts.json says R-1 is single-dwelling (Eugene 9.2700).
const SINGLE_DWELLING_ZONES = new Set(["RF", "R20", "R10", "R7", "R5", "R2.5", "LDR-5", "LDR-7", "TLDR", "TR", "R-1"]);

/**
 * Re-materialize computed facts (`COMPUTED_FACTS`) in `kase` after a fact perturbation.
 * If `closure` is provided, only re-materializes computed facts in `closure` (or all if omitted).
 */
export function materializeComputedFacts(kase: Record<string, any>, closure?: Set<string>): void {
  const shouldUpdate = (name: string) => !closure || closure.has(name) || !getFactEntry(kase, name);
  const whenDate = kase["as_of"]?.["date"] ?? "2026-11-01";
  const computedProv = (whereStr: string) => [
    {
      kind: "computed",
      document: "query/src/sensitivity.mts",
      where: whereStr,
      when: whenDate,
      by: "case-gate",
      status: "computed",
    },
  ];

  if (shouldUpdate("site.zone_family")) {
    const zone = resolveScalarFactValue(kase, "site.zone");
    if (typeof zone === "string") {
      kase["site"]["zone_family"] = {
        value: SINGLE_DWELLING_ZONES.has(zone) ? "single_dwelling" : "other",
        prov: computedProv("zone -> zone_family"),
      };
    }
  }

  if (shouldUpdate("site.lot_area_sqft")) {
    const lotOutline = resolveScalarFactValue(kase, "site.lot_outline") as Array<[number, number]> | undefined;
    if (Array.isArray(lotOutline) && lotOutline.length >= 3) {
      kase["site"]["lot_area_sqft"] = {
        value: Number(polygonArea(lotOutline).toFixed(6)),
        prov: computedProv("shoelace(site.lot_outline)"),
      };
    }
  }

  if (shouldUpdate("site.house_rear_wall")) {
    const houseOutline = resolveScalarFactValue(kase, "site.house_outline") as Array<[number, number]> | undefined;
    const frontLotLine = resolveScalarFactValue(kase, "site.front_lot_line") as [[number, number], [number, number]] | undefined;
    if (Array.isArray(houseOutline) && houseOutline.length >= 3 && Array.isArray(frontLotLine) && frontLotLine.length === 2) {
      kase["site"]["house_rear_wall"] = {
        value: computeHouseRearWall(houseOutline, frontLotLine),
        prov: computedProv("furthest_edge(site.house_outline, site.front_lot_line)"),
      };
    }
  }

  if (shouldUpdate("plan.outline")) {
    const footprint = resolveScalarFactValue(kase, "plan.footprint") as Array<[number, number]> | undefined;
    const placement = resolveScalarFactValue(kase, "plan.placement") as { x: number; y: number; rotation?: number } | undefined;
    if (Array.isArray(footprint) && footprint.length >= 3 && placement && typeof placement.x === "number") {
      kase["plan"]["outline"] = {
        value: computePlacedOutline(footprint, placement),
        prov: computedProv("placed_outline(plan.footprint, plan.placement)"),
      };
    }
  }

  if (shouldUpdate("plan.setbacks_used")) {
    const outline = resolveScalarFactValue(kase, "plan.outline") as Array<[number, number]> | undefined;
    const frontLine = resolveScalarFactValue(kase, "site.front_lot_line") as [[number, number], [number, number]] | undefined;
    const rearLine = resolveScalarFactValue(kase, "site.rear_lot_line") as [[number, number], [number, number]] | undefined;
    const sideLines = resolveScalarFactValue(kase, "site.side_lot_lines") as Array<[[number, number], [number, number]]> | undefined;
    if (Array.isArray(outline) && frontLine && rearLine && Array.isArray(sideLines) && sideLines.length > 0) {
      const frontFt = Number(distancePolygonToSegment(outline, frontLine).toFixed(6));
      const rearFt = Number(distancePolygonToSegment(outline, rearLine).toFixed(6));
      const sideFt = Number(Math.min(...sideLines.map((s) => distancePolygonToSegment(outline, s))).toFixed(6));
      kase["plan"]["setbacks_used"] = {
        value: { front_ft: frontFt, rear_ft: rearFt, side_ft: sideFt },
        prov: computedProv("distance_to_line(plan.outline, site.*_lot_line)"),
      };
    }
  }
}

/**
 * Perturb a measured geometry fact by `delta` feet (positive = outward / more clearance,
 * negative = inward / less clearance) and set its realized branch tolerance to 0.
 */
function applyGeometryToleranceDelta(kase: Record<string, any>, factName: string, delta: number): void {
  const current = structuredClone(resolveScalarFactValue(kase, factName));
  if (!current) return;

  if (factName === "site.rear_lot_line") {
    const line = current as [[number, number], [number, number]];
    const shifted: [[number, number], [number, number]] = [
      [line[0][0], Number((line[0][1] + delta).toFixed(6))],
      [line[1][0], Number((line[1][1] + delta).toFixed(6))],
    ];
    setKnownFactValue(kase, factName, shifted, 0);
  } else if (factName === "site.front_lot_line") {
    const line = current as [[number, number], [number, number]];
    const shifted: [[number, number], [number, number]] = [
      [line[0][0], Number((line[0][1] - delta).toFixed(6))],
      [line[1][0], Number((line[1][1] - delta).toFixed(6))],
    ];
    setKnownFactValue(kase, factName, shifted, 0);
  } else if (factName === "site.side_lot_lines") {
    const lines = current as Array<[[number, number], [number, number]]>;
    const xs = lines.flatMap((seg) => [seg[0][0], seg[1][0]]);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const shifted = lines.map((seg) => {
      const segMidX = (seg[0][0] + seg[1][0]) / 2;
      const dir = segMidX < midX ? -1 : 1;
      return [
        [Number((seg[0][0] + dir * delta).toFixed(6)), seg[0][1]],
        [Number((seg[1][0] + dir * delta).toFixed(6)), seg[1][1]],
      ] as [[number, number], [number, number]];
    });
    setKnownFactValue(kase, factName, shifted, 0);
  } else if (factName === "site.lot_outline") {
    const poly = current as Array<[number, number]>;
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const shifted = poly.map(([x, y]) => [
      x > minX ? Number((x + delta).toFixed(6)) : x,
      y > minY ? Number((y + delta).toFixed(6)) : y,
    ]);
    setKnownFactValue(kase, factName, shifted, 0);
  } else if (factName === "site.house_outline") {
    const poly = current as Array<[number, number]>;
    const ys = poly.map((p) => p[1]);
    const maxY = Math.max(...ys);
    const shifted = poly.map(([x, y]) => [
      x,
      Math.abs(y - maxY) < 1e-6 ? Number((y - delta).toFixed(6)) : y,
    ]);
    setKnownFactValue(kase, factName, shifted, 0);
  } else if (factName === "site.structures") {
    const structs = current as Array<{ id: string; outline: Array<[number, number]> }>;
    const shifted = structs.map((s) => {
      const xs = s.outline.map((p) => p[0]);
      const minX = Math.min(...xs);
      return {
        ...s,
        outline: s.outline.map(([x, y]) => [
          Math.abs(x - minX) < 1e-6 ? Number((x + delta).toFixed(6)) : x,
          y,
        ]),
      };
    });
    setKnownFactValue(kase, factName, shifted, 0);
  } else if (typeof current === "number") {
    setKnownFactValue(kase, factName, Number((current + delta).toFixed(6)), 0);
  }
}

// ------------------------------------------------------------------ Provision Dependency & Evaluation Engine

/**
 * Facts read by a provision (union of its operators' `reads`, its tool's declared `reads`,
 * its `plan.applies` `facts_needed`, and its clauses' `needs` and `guards`).
 */
function factsReadByProvision(
  provisionId: string,
  asOf: string,
  plan?: PlanType,
): Set<string> {
  const out = new Set<string>();

  if (plan) {
    const app = plan.applies.find((a) => a.provision_id === provisionId);
    if (app) {
      for (const f of app.facts_needed) out.add(f);
    }
  }

  for (const op of getOperators()) {
    if (op.provisions.includes(provisionId)) {
      for (const r of op.reads) out.add(r);
    }
  }

  // Known operator-backed dependencies for the Portland detached-ADU provisions
  const STATIC_PROVISION_FACTS: Record<string, string[]> = {
    "PDX.33.205.020.B.1.a": ["site.zone", "site.zone_family"],
    "PDX.11.50.020": ["site.trees"],
    "PDX.33.110.255.B.1.a": ["site.flag_lot"],
    "PDX.33.205.040.C.1": ["site.primary_living_area_sqft", "plan.living_area_sqft"],
    "PDX.33.110.245.C.1": ["plan.height_ft"],
    "PDX.33.110.220.B": [
      "site.front_lot_line",
      "site.side_lot_lines",
      "site.rear_lot_line",
      "plan.outline",
      "plan.setbacks_used",
    ],
    "PDX.33.110.245.C.2": [
      "plan.outline",
      "site.front_lot_line",
      "site.side_lot_lines",
      "site.rear_lot_line",
      "site.side_street_lot_line",
      "site.corner_lot",
      "site.zone",
      "plan.height_ft",
      "plan.wall_height_ft",
      "plan.rooftop_deck",
      "plan.openings_facing_lot_line",
      "plan.dormers",
      "site.screening",
      "site.structures",
      "plan.setbacks_used",
    ],
    "PDX.33.205.040.C.2": [
      "plan.outline",
      "site.front_lot_line",
      "site.house_rear_wall",
      "site.house_outline",
    ],
    "PDX.33.110.245.C.3.a": ["plan.outline", "site.structures", "site.lot_area_sqft"],
    "PDX.33.110.225.B": [
      "plan.outline",
      "site.structures",
      "site.house_outline",
      "site.lot_area_sqft",
    ],
  };

  for (const f of STATIC_PROVISION_FACTS[provisionId] ?? []) {
    out.add(f);
  }

  try {
    const rf = ruleFamily(provisionId, asOf);
    for (const cl of rf.clauses) {
      for (const gd of cl.guards) {
        out.add(gd.fact);
      }
    }
  } catch {
    // Provision not in graph-or.json
  }

  return out;
}

function measurePassToOutcome(pass: boolean | null): OutcomeType {
  if (pass === true) return "pass";
  if (pass === false) return "fail";
  return "too_close_to_call";
}

function combineOutcomes(outcomes: OutcomeType[]): OutcomeType {
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.includes("unknown")) return "unknown";
  if (outcomes.includes("too_close_to_call")) return "too_close_to_call";
  return "pass";
}

/**
 * Look up a numeric parameter from `ruleFamily(provisionId, asOf)` (never hardcode legal numbers).
 */
function resolveGraphParam(
  provisionId: string,
  paramName: string,
  asOf: string,
): { provision_id: string; param: string; value: number; unit: string } {
  const rf = ruleFamily(provisionId, asOf);
  const found = rf.params.find((p) => p.name === paramName);
  if (!found || typeof found.value !== "number") {
    throw new Error(`resolveGraphParam: parameter ${provisionId}:${paramName} not found or non-numeric`);
  }
  return {
    provision_id: provisionId,
    param: paramName,
    value: found.value,
    unit: found.unit ?? "ft",
  };
}

/**
 * Evaluate a set of affected provisions on `kase` for the given targets via `graph/tool_runner.py`.
 */
function evaluateProvisionsOnCase(
  kase: Record<string, any>,
  provisionIds: Set<string>,
  clientPlacement: PlacementType | null,
  selectedPlacement: PlacementType | null,
  seedPrefix: string,
): {
  findings: FindingInput[];
  searchResult: PlacementSearchResultType | null;
  effectiveSelectedPlacement: PlacementType | null;
} {
  const asOf = String(kase["as_of"]?.["date"] ?? "2026-11-15");
  const zone = String(resolveScalarFactValue(kase, "site.zone") ?? "R5");
  const footprint = resolveScalarFactValue(kase, "plan.footprint") as Array<[number, number]>;
  const clientOutline = clientPlacement
    ? computePlacedOutline(footprint, clientPlacement)
    : (resolveScalarFactValue(kase, "plan.outline") as Array<[number, number]>);

  const batch: BridgeRequestType["batch"] = [];
  let callCounter = 0;
  const nextCallId = (tag: string) => deterministicUuid7(`${seedPrefix}::${tag}::${++callCounter}`);

  // Track pending evaluations
  interface PendingEval {
    provision_id: string;
    target: TargetType;
    evaluation_stage: EvaluationStageType;
    call_ids: string[];
    forced_outcome?: OutcomeType;
    has_operator: boolean;
    is_reading_check?: boolean;
  }
  const pending: PendingEval[] = [];

  const targetOutlines: Array<{ target: TargetType; outline: Array<[number, number]>; placement: PlacementType }> = [];
  if (clientPlacement && clientOutline) {
    targetOutlines.push({ target: "client_spot", outline: clientOutline, placement: clientPlacement });
  }
  if (selectedPlacement) {
    targetOutlines.push({
      target: "selected_placement",
      outline: computePlacedOutline(footprint, selectedPlacement),
      placement: selectedPlacement,
    });
  }

  for (const pid of provisionIds) {
    // 1. Gates and guard-excluded provisions
    if (pid === "PDX.33.205.020.B.1.a") {
      if (isFactUnknown(kase, "site.zone") || isFactConflicting(kase, "site.zone")) {
        pending.push({
          provision_id: pid,
          target: "case",
          evaluation_stage: "gate",
          call_ids: [],
          forced_outcome: "unknown",
          has_operator: true,
        });
      } else {
        const cid = nextCallId(pid);
        batch.push({
          call_id: cid,
          provision_id: pid,
          target: "case",
          tool: "evaluate_guards",
          args: {
            provision_id: pid,
            facts: { "site.zone": zone },
            guards: [
              {
                clause_id: "PDX.33.205.020.B.1.a#v1::sentence:1",
                fact: "site.zone",
                op: "in",
                value: ["RF", "R20", "R10", "R7", "R5", "R2.5"],
              },
            ],
          },
        });
        pending.push({
          provision_id: pid,
          target: "case",
          evaluation_stage: "gate",
          call_ids: [cid],
          has_operator: true,
        });
      }
      continue;
    }

    if (pid === "PDX.11.50.020") {
      const treesVal = isFactUnknown(kase, "site.trees") ? null : resolveScalarFactValue(kase, "site.trees");
      const cid = nextCallId(pid);
      batch.push({
        call_id: cid,
        provision_id: pid,
        target: "case",
        tool: "evaluate_guards",
        args: {
          provision_id: pid,
          facts: { "site.trees": treesVal ?? null },
          guards: [
            {
              clause_id: "PDX.11.50.020#v1::sentence:1",
              fact: "site.trees",
              op: "true",
            },
          ],
        },
      });
      pending.push({
        provision_id: pid,
        target: "case",
        evaluation_stage: "gate",
        call_ids: [cid],
        has_operator: false,
      });
      continue;
    }

    if (pid === "PDX.33.110.255.B.1.a") {
      const flagVal = isFactUnknown(kase, "site.flag_lot") ? null : resolveScalarFactValue(kase, "site.flag_lot");
      const cid = nextCallId(pid);
      batch.push({
        call_id: cid,
        provision_id: pid,
        target: "case",
        tool: "evaluate_guards",
        args: {
          provision_id: pid,
          facts: { "site.flag_lot": flagVal ?? null },
          guards: [
            {
              clause_id: "PDX.33.110.255.B.1.a#v1::sentence:1",
              fact: "site.flag_lot",
              op: "true",
            },
          ],
        },
      });
      pending.push({
        provision_id: pid,
        target: "case",
        evaluation_stage: "placement_constraint",
        call_ids: [cid],
        has_operator: false,
      });
      continue;
    }

    // 2. Plan constraints (`target: "case"`)
    if (pid === "PDX.33.205.040.C.1") {
      const planReadingVals = getFactActiveReadingValues(kase, "plan.living_area_sqft");
      if (
        isFactUnknown(kase, "site.primary_living_area_sqft") ||
        isFactConflicting(kase, "site.primary_living_area_sqft") ||
        isFactUnknown(kase, "plan.living_area_sqft") ||
        isFactConflicting(kase, "plan.living_area_sqft")
      ) {
        pending.push({
          provision_id: pid,
          target: "case",
          evaluation_stage: "plan_constraint",
          call_ids: [],
          forced_outcome: "unknown",
          has_operator: true,
        });
      } else if (planReadingVals !== null) {
        // Active ambiguity on plan.living_area_sqft: evaluate all readings via the bridge;
        // do not take the first reading's value as nominal.
        const readingCallIds: string[] = [];
        for (let rIdx = 0; rIdx < planReadingVals.length; rIdx++) {
          const cid = nextCallId(`${pid}::reading:${rIdx}`);
          readingCallIds.push(cid);
          batch.push({
            call_id: cid,
            provision_id: pid,
            target: "case",
            tool: "adu_max_living_area",
            args: {
              primary_living_area: Number(resolveScalarFactValue(kase, "site.primary_living_area_sqft")),
              plan_living_area: Number(planReadingVals[rIdx]),
              share: resolveGraphParam("PDX.33.205.040.C.1", "max_share_of_primary_living_area", asOf),
              cap: resolveGraphParam("PDX.33.205.040.C.1", "max_living_area", asOf),
            },
          });
        }
        pending.push({
          provision_id: pid,
          target: "case",
          evaluation_stage: "plan_constraint",
          call_ids: readingCallIds,
          has_operator: true,
          is_reading_check: true,
        });
      } else {
        const cid = nextCallId(pid);
        batch.push({
          call_id: cid,
          provision_id: pid,
          target: "case",
          tool: "adu_max_living_area",
          args: {
            primary_living_area: Number(resolveScalarFactValue(kase, "site.primary_living_area_sqft")),
            plan_living_area: Number(resolveScalarFactValue(kase, "plan.living_area_sqft")),
            share: resolveGraphParam("PDX.33.205.040.C.1", "max_share_of_primary_living_area", asOf),
            cap: resolveGraphParam("PDX.33.205.040.C.1", "max_living_area", asOf),
          },
        });
        pending.push({
          provision_id: pid,
          target: "case",
          evaluation_stage: "plan_constraint",
          call_ids: [cid],
          has_operator: true,
        });
      }
      continue;
    }

    if (pid === "PDX.33.110.245.C.1") {
      if (isFactUnknown(kase, "plan.height_ft") || isFactConflicting(kase, "plan.height_ft")) {
        pending.push({
          provision_id: pid,
          target: "case",
          evaluation_stage: "plan_constraint",
          call_ids: [],
          forced_outcome: "unknown",
          has_operator: true,
        });
      } else {
        const cid = nextCallId(pid);
        batch.push({
          call_id: cid,
          provision_id: pid,
          target: "case",
          tool: "check_max",
          args: {
            value: Number(resolveScalarFactValue(kase, "plan.height_ft")),
            limit: resolveGraphParam("PDX.33.110.245.C.1", "max_height", asOf),
            tolerance: extractFactToleranceFt(kase, "plan.height_ft"),
          },
        });
        pending.push({
          provision_id: pid,
          target: "case",
          evaluation_stage: "plan_constraint",
          call_ids: [cid],
          has_operator: true,
        });
      }
      continue;
    }

    // 3. Placement constraints & exceptions (per target)
    if (pid === "PDX.33.110.220.B") {
      const sideMin = resolveGraphParam("PDX.T110-4", `side_building_setback.${zone}`, asOf);
      const rearMin = resolveGraphParam("PDX.T110-4", `rear_building_setback.${zone}`, asOf);
      const sideLines = resolveScalarFactValue(kase, "site.side_lot_lines");
      const rearLine = resolveScalarFactValue(kase, "site.rear_lot_line");
      const sideTol = extractFactToleranceFt(kase, "site.side_lot_lines");
      const rearTol = extractFactToleranceFt(kase, "site.rear_lot_line");

      for (const t of targetOutlines) {
        const cidSide = nextCallId(`${pid}::${t.target}::side`);
        const cidRear = nextCallId(`${pid}::${t.target}::rear`);
        batch.push({
          call_id: cidSide,
          provision_id: pid,
          target: t.target,
          tool: "check_setback",
          args: {
            outline: t.outline,
            lines: sideLines,
            min: sideMin,
            tolerance_ft: sideTol,
            dimension_to_tape: "side lot line",
          },
        });
        batch.push({
          call_id: cidRear,
          provision_id: pid,
          target: t.target,
          tool: "check_setback",
          args: {
            outline: t.outline,
            lines: rearLine,
            min: rearMin,
            tolerance_ft: rearTol,
            dimension_to_tape: "rear lot line",
          },
        });
        pending.push({
          provision_id: pid,
          target: t.target,
          evaluation_stage: "placement_constraint",
          call_ids: [cidSide, cidRear],
          has_operator: true,
        });
      }
      continue;
    }

    if (pid === "PDX.33.110.245.C.2") {
      const rf = ruleFamily("PDX.33.110.245.C.2", asOf);
      const paramMap: Record<string, unknown> = {};
      for (const p of rf.params) {
        paramMap[p.name] = {
          provision_id: "PDX.33.110.245.C.2",
          param: p.name,
          value: p.name === "zones_allowing_structures_in_side_rear_setbacks" ? ["R7", "R5", "R2.5"] : p.value,
          unit: p.unit ?? "ft",
        };
      }
      const sideMin = resolveGraphParam("PDX.T110-4", `side_building_setback.${zone}`, asOf).value;
      const rearMin = resolveGraphParam("PDX.T110-4", `rear_building_setback.${zone}`, asOf).value;
      const sideLines = (resolveScalarFactValue(kase, "site.side_lot_lines") ?? []) as Array<
        [[number, number], [number, number]]
      >;
      const rearLine = resolveScalarFactValue(kase, "site.rear_lot_line") as [[number, number], [number, number]];

      for (const t of targetOutlines) {
        if (t.target !== "client_spot") continue;
        const cid = nextCallId(`${pid}::${t.target}`);
        batch.push({
          call_id: cid,
          provision_id: pid,
          target: t.target,
          tool: "check_exception_conditions",
          args: {
            exception_id: "PDX.33.110.245.C.2",
            base_provision_id: "PDX.33.110.220.B",
            params: paramMap,
            facts: {
              outline: t.outline,
              rotation: t.placement.rotation ?? 0,
              zone: isFactUnknown(kase, "site.zone") ? null : zone,
              front_lot_line: resolveScalarFactValue(kase, "site.front_lot_line"),
              side_street_lot_line: resolveScalarFactValue(kase, "site.side_street_lot_line") ?? null,
              corner_lot: isFactUnknown(kase, "site.corner_lot")
                ? null
                : (resolveScalarFactValue(kase, "site.corner_lot") ?? false),
              height_ft: isFactUnknown(kase, "plan.height_ft")
                ? null
                : resolveScalarFactValue(kase, "plan.height_ft"),
              wall_height_ft: isFactUnknown(kase, "plan.wall_height_ft")
                ? null
                : resolveScalarFactValue(kase, "plan.wall_height_ft"),
              plan_kind: resolveScalarFactValue(kase, "plan.kind") ?? "adu",
              openings_facing_lot_line: isFactUnknown(kase, "plan.openings_facing_lot_line")
                ? null
                : resolveScalarFactValue(kase, "plan.openings_facing_lot_line"),
              rooftop_deck: isFactUnknown(kase, "plan.rooftop_deck")
                ? null
                : resolveScalarFactValue(kase, "plan.rooftop_deck"),
              dormers: isFactUnknown(kase, "plan.dormers")
                ? null
                : resolveScalarFactValue(kase, "plan.dormers"),
              structures: resolveScalarFactValue(kase, "site.structures") ?? [],
              tolerance_ft: Math.max(
                extractFactToleranceFt(kase, "site.front_lot_line"),
                extractFactToleranceFt(kase, "site.side_lot_lines"),
                extractFactToleranceFt(kase, "site.rear_lot_line"),
              ),
              setback_lines: [
                ...(sideLines[0] ? [{ name: "west", line: sideLines[0], min_ft: sideMin }] : []),
                ...(sideLines[1] ? [{ name: "east", line: sideLines[1], min_ft: sideMin }] : []),
                ...(rearLine ? [{ name: "rear", line: rearLine, min_ft: rearMin }] : []),
              ],
            },
          },
        });
        pending.push({
          provision_id: pid,
          target: t.target,
          evaluation_stage: "exception",
          call_ids: [cid],
          has_operator: true,
        });
      }
      continue;
    }

    if (pid === "PDX.33.205.040.C.2") {
      const minFront = resolveGraphParam("PDX.33.205.040.C.2", "front_lot_line_setback", asOf);
      const frontLine = resolveScalarFactValue(kase, "site.front_lot_line");
      const rearWall = resolveScalarFactValue(kase, "site.house_rear_wall");
      const tol = Math.max(
        extractFactToleranceFt(kase, "site.front_lot_line"),
        extractFactToleranceFt(kase, "site.house_outline"),
      );
      for (const t of targetOutlines) {
        const cid = nextCallId(`${pid}::${t.target}`);
        batch.push({
          call_id: cid,
          provision_id: pid,
          target: t.target,
          tool: "check_front_or_behind",
          args: {
            outline: t.outline,
            front_lot_line: frontLine,
            min_front: minFront,
            house_rear_wall: rearWall,
            tolerance_ft: tol,
          },
        });
        pending.push({
          provision_id: pid,
          target: t.target,
          evaluation_stage: "placement_constraint",
          call_ids: [cid],
          has_operator: true,
        });
      }
      continue;
    }

    if (pid === "PDX.33.110.245.C.3.a") {
      const limitParam = resolveGraphParam(
        "PDX.33.110.245.C.3.a",
        "max_combined_accessory_coverage_pct_of_site",
        asOf,
      );
      const structs = (resolveScalarFactValue(kase, "site.structures") ?? []) as unknown[];
      const lotArea = Number(resolveScalarFactValue(kase, "site.lot_area_sqft"));
      for (const t of targetOutlines) {
        const cid = nextCallId(`${pid}::${t.target}`);
        batch.push({
          call_id: cid,
          provision_id: pid,
          target: t.target,
          tool: "coverage_share",
          args: {
            outlines: [t.outline, ...structs],
            lot_area: lotArea,
            limit: limitParam,
            outline_tolerances_ft: [0, ...structs.map(() => extractFactToleranceFt(kase, "site.structures"))],
            lot_area_tolerance_sqft: extractFactToleranceFt(kase, "site.lot_area_sqft"),
          },
        });
        pending.push({
          provision_id: pid,
          target: t.target,
          evaluation_stage: "placement_constraint",
          call_ids: [cid],
          has_operator: true,
        });
      }
      continue;
    }

    if (pid === "PDX.33.110.225.B") {
      const structs = (resolveScalarFactValue(kase, "site.structures") ?? []) as unknown[];
      const houseOutline = resolveScalarFactValue(kase, "site.house_outline");
      const lotArea = Number(resolveScalarFactValue(kase, "site.lot_area_sqft"));
      for (const t of targetOutlines) {
        const cid = nextCallId(`${pid}::${t.target}`);
        batch.push({
          call_id: cid,
          provision_id: pid,
          target: t.target,
          tool: "total_building_coverage",
          args: {
            outlines: [t.outline, houseOutline, ...structs],
            lot_area: lotArea,
            cap_cell: coverageCellFor(lotArea, asOf), // B9: the row and cell come from the graph, never from text in code
          },
        });
        pending.push({
          provision_id: pid,
          target: t.target,
          evaluation_stage: "placement_constraint",
          call_ids: [cid],
          has_operator: true,
        });
      }
      continue;
    }

    // Any other city (Eugene first, 2026-11-02): evaluate from the operators that model the provision, never by id.
    // A provision this cannot evaluate gets `unknown` (it is never silently skipped).
    if (!pid.startsWith("PDX.") && !pid.startsWith("OR")) {
      const ops = getOperators().filter((o) => o.provisions.includes(pid));
      const forced = (stage: EvaluationStageType, target: TargetType = "case") =>
        pending.push({ provision_id: pid, target, evaluation_stage: stage, call_ids: [], forced_outcome: "unknown", has_operator: ops.length > 0 });
      if (ops.length === 0) { forced("placement_constraint"); continue; }
      const param = (ref: string) => {
        const [pp, pn] = ref.split(":") as [string, string];
        try { return resolveGraphParam(pp, pn.replace("{zone}", zone), asOf); } catch { return null; }
      };
      const val = (f: string) => (isFactUnknown(kase, f) || isFactConflicting(kase, f) ? undefined : resolveScalarFactValue(kase, f));
      for (const op of ops) {
        if (op.tool === "check_setback" && op.requires?.length) {
          for (const t of targetOutlines) {
            const ids: string[] = [];
            let missing = false;
            for (const rq of op.requires) {
              const lim = rq.param ? param(rq.param) : null;
              const lf = rq.match?.["lines"];
              const lines = lf ? val(lf) : undefined;
              if (!lim || !lf || lines === undefined) { missing = true; continue; }
              const cid = nextCallId(`${pid}:${t.target}:${lf}`);
              batch.push({ call_id: cid, provision_id: pid, target: t.target, tool: "check_setback",
                args: { outline: t.outline, lines, min: lim, tolerance_ft: extractFactToleranceFt(kase, lf) } });
              ids.push(cid);
            }
            if (missing) forced("placement_constraint", t.target);
            else pending.push({ provision_id: pid, target: t.target, evaluation_stage: "placement_constraint", call_ids: ids, has_operator: true });
          }
        } else if (op.tool === "adu_max_living_area") {
          const share = param(`${op.params[0]!.provision}:${op.params[0]!.param}`), cap = param(`${op.params[1]!.provision}:${op.params[1]!.param}`);
          const base = val(op.reads[0]!), planSqft = val(op.reads[1]!);
          if (!share || !cap || typeof base !== "number" || typeof planSqft !== "number") { forced("plan_constraint"); continue; }
          const cid = nextCallId(`${pid}:size`);
          batch.push({ call_id: cid, provision_id: pid, target: "case", tool: "adu_max_living_area",
            args: { primary_living_area: base, share, cap, plan_living_area: planSqft } });
          pending.push({ provision_id: pid, target: "case", evaluation_stage: "plan_constraint", call_ids: [cid], has_operator: true });
        } else if (op.tool === "check_max") {
          const lim = param(`${op.params[0]!.provision}:${op.params[0]!.param}`);
          const v = val(op.reads[0]!);
          if (!lim || typeof v !== "number") { forced("plan_constraint"); continue; }
          const cid = nextCallId(`${pid}:max`);
          batch.push({ call_id: cid, provision_id: pid, target: "case", tool: "check_max",
            args: { value: v, limit: lim, unit: lim.unit, tolerance: 0 } });
          pending.push({ provision_id: pid, target: "case", evaluation_stage: "plan_constraint", call_ids: [cid], has_operator: true });
        } else if (op.tool === "coverage_share") {
          const ref = op.params.find((x) => x.param.endsWith(`.${zone}`));
          const lim = ref ? param(`${ref.provision}:${ref.param}`) : null;
          const lotArea = val("site.lot_area_sqft"), house = val("site.house_outline");
          const structures = (val("site.structures") as Array<Record<string, any>> | undefined) ?? [];
          for (const t of targetOutlines) {
            if (!lim || typeof lotArea !== "number" || !house) { forced("placement_constraint", t.target); continue; }
            const cid = nextCallId(`${pid}:${t.target}:coverage`);
            batch.push({ call_id: cid, provision_id: pid, target: t.target, tool: "coverage_share",
              args: { outlines: [house, ...structures, t.outline], lot_area: lotArea, limit: lim,
                outline_tolerances_ft: [extractFactToleranceFt(kase, "site.house_outline"), ...structures.map(() => extractFactToleranceFt(kase, "site.structures")), 0],
                lot_area_tolerance_sqft: extractFactToleranceFt(kase, "site.lot_area_sqft") } });
            pending.push({ provision_id: pid, target: t.target, evaluation_stage: "placement_constraint", call_ids: [cid], has_operator: true });
          }
        } else {
          forced("placement_constraint");
        }
      }
      continue;
    }
  }

  const results = callToolBridge(batch);
  const findings: FindingInput[] = [];

  for (const item of pending) {
    if (item.forced_outcome) {
      findings.push({
        provision_id: item.provision_id,
        target: item.target,
        outcome: item.forced_outcome,
        evaluation_stage: item.evaluation_stage,
      });
      continue;
    }

    const itemOutcomes: OutcomeType[] = [];
    const itemMeasures: MeasureResultType[] = [];

    for (const cid of item.call_ids) {
      const res = results.get(cid) as Record<string, any> | undefined;
      if (!res) continue;

      if ("result" in res && Array.isArray(res["guards"])) {
        // GuardResult
        const gr = res as GuardResultType;
        if (gr.result === "known_false") {
          itemOutcomes.push(item.provision_id === "PDX.33.205.020.B.1.a" ? "fail" : "not_applicable");
        } else if (gr.result === "known_true") {
          // If a guard opens on a provision with no operator, the branch finding is `unknown`
          itemOutcomes.push(item.has_operator ? "pass" : "unknown");
        } else {
          itemOutcomes.push("unknown");
        }
      } else if ("exception_id" in res && Array.isArray(res["conditions"])) {
        // ExceptionResult
        const er = res as ExceptionResultType;
        itemOutcomes.push(er.pass === true ? "pass" : er.pass === false ? "fail" : "unknown");
        for (const cond of er.conditions) {
          if (cond.measure) itemMeasures.push(cond.measure);
        }
      } else if ("margin" in res && "pass" in res) {
        // MeasureResult
        const mr = res as MeasureResultType;
        itemOutcomes.push(measurePassToOutcome(mr.pass));
        itemMeasures.push(mr);
      }
    }

    const isReadingSplit = item.is_reading_check === true && new Set(itemOutcomes).size > 1;
    const finalOutcome: OutcomeType = isReadingSplit
      ? "unknown"
      : itemOutcomes.length === 1 && itemOutcomes[0] === "not_applicable"
        ? "not_applicable"
        : combineOutcomes(itemOutcomes);

    findings.push({
      provision_id: item.provision_id,
      target: item.target,
      outcome: finalOutcome,
      evaluation_stage: item.evaluation_stage,
      measures: itemMeasures,
      ...(isReadingSplit ? { ambiguous_reading_split: true } : {}),
    });
  }

  return {
    findings,
    searchResult: null,
    effectiveSelectedPlacement: selectedPlacement,
  };
}

/**
 * Run `find_placements` via `graph/tool_runner.py` when `selected_placement` fails in a branch
 * (or when building nominal context and `client_spot` fails).
 */
export function runFindPlacementsBridge(
  kase: Record<string, any>,
  clientSpot: PlacementType | null,
  seedPrefix: string,
): PlacementSearchResultType {
  const asOf = String(kase["as_of"]?.["date"] ?? "2026-11-15");
  // B4/B5 (11-02): never assume a zone. With no zone there is no base setback to search with, so no spot is offered.
  const zoneFact = resolveScalarFactValue(kase, "site.zone");
  if (zoneFact == null) return C.PlacementSearchResult.parse({ count: 0, clear_count: 0, client_spot: null, nearest_to_client: null, max_clearance: null, envelope_artifact: null });
  const zone = String(zoneFact);
  const frontMin = resolveGraphParam("PDX.T110-4", `front_building_setback.${zone}`, asOf);
  const rearMin = resolveGraphParam("PDX.T110-4", `rear_building_setback.${zone}`, asOf);
  const sideMin = resolveGraphParam("PDX.T110-4", `side_building_setback.${zone}`, asOf);

  const frontLine = resolveScalarFactValue(kase, "site.front_lot_line");
  const rearLine = resolveScalarFactValue(kase, "site.rear_lot_line");
  const rearWall = resolveScalarFactValue(kase, "site.house_rear_wall");
  const sideLines = (resolveScalarFactValue(kase, "site.side_lot_lines") ?? []) as Array<
    [[number, number], [number, number]]
  >;

  const tol = Math.max(
    extractFactToleranceFt(kase, "site.front_lot_line"),
    extractFactToleranceFt(kase, "site.rear_lot_line"),
    extractFactToleranceFt(kase, "site.side_lot_lines"),
    extractFactToleranceFt(kase, "site.house_outline"),
    extractFactToleranceFt(kase, "site.structures"),
  );

  const cid = deterministicUuid7(`${seedPrefix}::find_placements`);
  const map = callToolBridge([
    {
      call_id: cid,
      provision_id: "PDX.33.110.220.B",
      target: "client_spot",
      tool: "find_placements",
      args: {
        lot_outline: resolveScalarFactValue(kase, "site.lot_outline"),
        house_outline: resolveScalarFactValue(kase, "site.house_outline"),
        structures: resolveScalarFactValue(kase, "site.structures") ?? [],
        footprint: resolveScalarFactValue(kase, "plan.footprint"),
        tolerance_ft: tol,
        setbacks: [
          { line: frontLine, min: frontMin },
          { line: rearLine, min: rearMin },
          ...sideLines.map((line) => ({ line, min: sideMin })),
        ],
        ...(clientSpot ? { client_spot: clientSpot } : {}),
        // B5: Portland's ADU rule, 40 ft from the front line or behind the rear wall, filters the search as the Judge checks it
        ...(rearWall && frontLine ? { front_or_behind: { front_lot_line: frontLine, house_rear_wall: rearWall, min_front: resolveGraphParam("PDX.33.205.040.C.2", "front_lot_line_setback", asOf) } } : {}),
      },
    },
  ]);

  const raw = map.get(cid) as { summary: PlacementSearchResultType };
  return C.PlacementSearchResult.parse(raw.summary);
}

// ------------------------------------------------------------------ Verdict Entailment

function hasActiveUnresolvedAmbiguity(kase: Record<string, any>): boolean {
  for (const scope of ["site", "plan"] as const) {
    const rec = (kase[scope] ?? {}) as Record<string, any>;
    for (const entry of Object.values(rec)) {
      if (
        entry &&
        typeof entry === "object" &&
        entry["by_reading"] &&
        typeof entry["by_reading"] === "object" &&
        Object.keys(entry["by_reading"]).length > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

function deriveClientSpotPasses(findings: FindingInput[]): boolean | null {
  const clientFindings = findings.filter(
    (f) =>
      (f.target === "client_spot" || f.target === "case") &&
      f.evaluation_stage !== "exception" &&
      f.outcome !== "not_applicable" &&
      !f.ambiguous_reading_split,
  );
  if (clientFindings.length === 0) return null;

  const exceptionPasses = findings.some(
    (f) => f.target === "client_spot" && f.evaluation_stage === "exception" && f.outcome === "pass",
  );

  const uncured = clientFindings.filter(
    (f) => !(f.provision_id === "PDX.33.110.220.B" && f.outcome === "fail" && exceptionPasses),
  );
  const outcomes = uncured.map((f) => f.outcome);
  if (outcomes.includes("fail")) return false;
  if (outcomes.includes("unknown") || outcomes.includes("too_close_to_call")) return null;
  return true;
}

/**
 * Entail a Verdict from a set of findings, active placement status, and case state
 * following the precedence: `BLOCKED_BY_GATE > NO_LEGS > NEEDS_CHECK > FITS_IF > FITS`.
 */
export function entailVerdict(
  findings: FindingInput[],
  kase: Record<string, any>,
  hasPassingPlacement: boolean,
  clientSpotPasses: boolean | null,
): VerdictType {
  const activeFindings = findings.filter((f) => f.outcome !== "not_applicable");

  // 1. Gate fail -> BLOCKED_BY_GATE
  const gates = activeFindings.filter((f) => f.evaluation_stage === "gate");
  if (gates.some((f) => f.outcome === "fail")) {
    return "BLOCKED_BY_GATE";
  }

  // 2. Plan constraint fail -> NO_LEGS
  const planConstraints = activeFindings.filter((f) => f.evaluation_stage === "plan_constraint");
  if (planConstraints.some((f) => f.outcome === "fail")) {
    return "NO_LEGS";
  }

  // 3. Unknown on a gate or plan constraint (e.g. unresolved conflict or unknown fact, not a reading split) -> NEEDS_CHECK
  if (
    gates.some((f) => !f.ambiguous_reading_split && (f.outcome === "unknown" || f.outcome === "too_close_to_call")) ||
    planConstraints.some(
      (f) => !f.ambiguous_reading_split && (f.outcome === "unknown" || f.outcome === "too_close_to_call"),
    )
  ) {
    return "NEEDS_CHECK";
  }

  // 4. Active gray-area reading ambiguity on the case (decisive gray area, ARCHITECTURE.md §3 step 4) -> FITS_IF
  if (activeFindings.some((f) => f.ambiguous_reading_split) || hasActiveUnresolvedAmbiguity(kase)) {
    return "FITS_IF";
  }

  // 5. Placement constraints: if client_spot is too_close_to_call / unknown and no separate selected_placement passes
  const selectedFindings = activeFindings.filter((f) => f.target === "selected_placement");
  if (selectedFindings.length > 0) {
    if (selectedFindings.some((f) => f.outcome === "unknown" || f.outcome === "too_close_to_call")) {
      return "NEEDS_CHECK";
    }
    if (selectedFindings.every((f) => f.outcome === "pass") && hasPassingPlacement) {
      return "FITS";
    }
  } else {
    if (clientSpotPasses === null) {
      return "NEEDS_CHECK";
    }
    if (clientSpotPasses === true) {
      return "FITS";
    }
  }

  // F10: NO_LEGS for placement is proven only by a search with no clear spot; without a passing placement this branch
  // is undecided (the harness restores NO_LEGS when find_placements found clear_count == 0). CC, 11-02 (live S4: a
  // plan-passing branch scored NO_LEGS hid a decisive conflict).
  return hasPassingPlacement ? "FITS" : "NEEDS_CHECK";
}

// ------------------------------------------------------------------ Baseline Context Builder

export const DEFAULT_PDX_ADU_PROVISIONS = [
  "PDX.33.205.020.B.1.a",
  "PDX.11.50.020",
  "PDX.33.110.255.B.1.a",
  "PDX.33.205.040.C.1",
  "PDX.33.110.245.C.1",
  "PDX.33.110.220.B",
  "PDX.33.110.245.C.2",
  "PDX.33.205.040.C.2",
  "PDX.33.110.245.C.3.a",
  "PDX.33.110.225.B",
] as const;

export function buildDefaultPlan(asOf = "2026-11-15"): PlanType {
  return C.Plan.parse({
    index_hash: sha256Hex(`default-pdx-adu-index@${asOf}`),
    applies: [
      {
        provision_id: "PDX.33.205.020.B.1.a",
        scope_quote: "An accessory dwelling unit may be added to a house in RF through R2.5 zones.",
        facts_needed: ["site.zone"],
      },
      {
        provision_id: "PDX.33.205.040.C.1",
        scope_quote:
          "The maximum living area for an ADU is 75 percent of the living area of the primary structure or 800 square feet, whichever is less.",
        facts_needed: ["site.primary_living_area_sqft", "plan.living_area_sqft"],
      },
      {
        provision_id: "PDX.33.110.245.C.1",
        scope_quote: "The maximum height allowed for all detached covered accessory structures is 20 feet.",
        facts_needed: ["plan.height_ft"],
      },
      {
        provision_id: "PDX.33.110.220.B",
        scope_quote: "The required building setbacks are stated in Table 110-4.",
        facts_needed: ["site.side_lot_lines", "site.rear_lot_line", "plan.outline"],
      },
      {
        provision_id: "PDX.33.205.040.C.2",
        scope_quote:
          "Detached ADUs must be at least 40 feet from a front lot line or behind the rear wall of the primary structure.",
        facts_needed: ["site.front_lot_line", "site.house_rear_wall", "plan.outline"],
      },
      {
        provision_id: "PDX.33.110.245.C.3.a",
        scope_quote:
          "The combined building coverage of all detached covered accessory structures may not exceed 20 percent of the total area of the site.",
        facts_needed: ["site.lot_area_sqft", "site.structures", "plan.outline"],
      },
      {
        provision_id: "PDX.33.110.225.B",
        scope_quote:
          "The maximum combined building coverage for all covered structures on the site is stated in Table 110-5.",
        facts_needed: ["site.lot_area_sqft", "site.house_outline", "site.structures", "plan.outline"],
      },
    ],
    excluded_at_index: [
      {
        provision_id: "PDX.11.50.020",
        scope_quote: "Tree preservation requirements apply when trees are present on the site.",
      },
      {
        provision_id: "PDX.33.110.255.B.1.a",
        scope_quote: "Large flag lots have required building setbacks that are the same along all lot lines.",
      },
    ],
    order: [
      "PDX.33.205.020.B.1.a",
      "PDX.33.205.040.C.1",
      "PDX.33.110.245.C.1",
      "PDX.33.110.220.B",
      "PDX.33.205.040.C.2",
      "PDX.33.110.245.C.3.a",
      "PDX.33.110.225.B",
    ],
  });
}

/**
 * Deterministically build the nominal `{ case, findings, plan, selected_placement }` context
 * using `checkCase` and `graph/tool_runner.py` with zero model calls.
 */
export function buildNominalContext(rawCase: CaseType | Record<string, unknown>): {
  case: CaseType;
  findings: FindingInput[];
  plan: PlanType;
  selected_placement: PlacementType | null;
} {
  const cloned = structuredClone(rawCase) as Record<string, any>;
  const gate = checkCase(cloned);
  const kase: CaseType = "refused" in gate ? (cloned as CaseType) : gate.case;
  if ("refused" in gate) {
    materializeComputedFacts(kase as unknown as Record<string, any>);
  }

  const asOf = kase.as_of.date;
  const plan = buildDefaultPlan(asOf);
  const clientPlacement = (resolveScalarFactValue(kase as Record<string, any>, "plan.placement") ??
    null) as PlacementType | null;

  // Initial pass at client_spot
  const initialEval = evaluateProvisionsOnCase(
    kase as Record<string, any>,
    new Set(DEFAULT_PDX_ADU_PROVISIONS),
    clientPlacement,
    null,
    `${kase.case_id}::nominal-initial`,
  );

  const clientPasses = deriveClientSpotPasses(initialEval.findings);
  let selectedPlacement: PlacementType | null = null;

  // If client_spot fails outright, search for a clear placement via find_placements
  if (clientPasses === false) {
    const search = runFindPlacementsBridge(
      kase as Record<string, any>,
      clientPlacement,
      `${kase.case_id}::nominal-search`,
    );
    selectedPlacement = search.nearest_to_client ?? search.max_clearance ?? null;
  }

  if (!selectedPlacement) {
    return {
      case: kase,
      findings: initialEval.findings,
      plan,
      selected_placement: null,
    };
  }

  const fullEval = evaluateProvisionsOnCase(
    kase as Record<string, any>,
    new Set(DEFAULT_PDX_ADU_PROVISIONS),
    clientPlacement,
    selectedPlacement,
    `${kase.case_id}::nominal-full`,
  );

  return {
    case: kase,
    findings: fullEval.findings,
    plan,
    selected_placement: selectedPlacement,
  };
}

// ------------------------------------------------------------------ C5 · runSensitivity & buildQuestions

const MAX_SENSITIVITY_VALUES = 16;
const MAX_BRANCHES_PER_VALUE = 2;

interface CandidateFlipGroup {
  fact: string;
  assignments: Array<BranchType["assignment"]>;
  excessBranches: number;
}

/**
 * Collect all candidate value groups to flip in deterministic priority order:
 *   1. Active ambiguity readings (`by_reading` on case facts or active `ambiguities.json` entries)
 *   2. Conflicting facts (`observations` with >= 2 distinct values)
 *   3. Listed `unknowns` (`case.unknowns`)
 *   4. `unconfirmed` facts (`status === "unconfirmed"` on entry or provenance)
 *   5. Measured geometry facts ± their tolerance (`GEOMETRY_FACTS` with `tolerance.value > 0`)
 */
function collectCandidateFlipGroups(kase: Record<string, any>): CandidateFlipGroup[] {
  const groups: CandidateFlipGroup[] = [];
  const factsReg = getFactsRegistry();
  const seenFacts = new Set<string>();

  // 1. Active ambiguity readings
  const activeAmbiguities = getAmbiguities().filter((a) => a.status === "active");
  for (const scope of ["plan", "site"] as const) {
    const rec = (kase[scope] ?? {}) as Record<string, any>;
    for (const key of Object.keys(rec).sort()) {
      const fullFact = `${scope}.${key}`;
      const entry = rec[key];
      if (!entry || typeof entry !== "object" || !entry["by_reading"]) continue;
      const byReading = entry["by_reading"] as Record<string, unknown[]>;
      for (const ambId of Object.keys(byReading).sort()) {
        const readingsArr = byReading[ambId];
        if (!Array.isArray(readingsArr) || readingsArr.length < 2) continue;
        const ambDef = activeAmbiguities.find((a) => a.id === ambId);
        if (ambDef && ambDef.status !== "active") continue;
        const allAssignments: Array<BranchType["assignment"]> = readingsArr.map((_, idx) => ({
          kind: "reading" as const,
          ambiguity_id: ambId,
          index: idx,
        }));
        groups.push({
          fact: fullFact,
          assignments: allAssignments.slice(0, MAX_BRANCHES_PER_VALUE),
          excessBranches: Math.max(0, allAssignments.length - MAX_BRANCHES_PER_VALUE),
        });
        seenFacts.add(`${fullFact}::reading::${ambId}`);
      }
    }
  }

  // 2. Conflicting facts
  for (const scope of ["site", "plan"] as const) {
    const rec = (kase[scope] ?? {}) as Record<string, any>;
    for (const key of Object.keys(rec).sort()) {
      const fullFact = `${scope}.${key}`;
      const entry = rec[key];
      if (!entry || !Array.isArray(entry["observations"]) || entry["observations"].length < 2) continue;
      if (!isFactConflicting(kase, fullFact)) continue;
      const obs = entry["observations"] as unknown[];
      const allAssignments: Array<BranchType["assignment"]> = obs.map((_, idx) => ({
        kind: "observation" as const,
        index: idx,
      }));
      groups.push({
        fact: fullFact,
        assignments: allAssignments.slice(0, MAX_BRANCHES_PER_VALUE),
        excessBranches: Math.max(0, allAssignments.length - MAX_BRANCHES_PER_VALUE),
      });
      seenFacts.add(fullFact);
    }
  }

  // 3. Listed unknowns
  const unknowns = ((kase["unknowns"] ?? []) as Array<{ fact: string; reason: string }>).slice();
  unknowns.sort((a, b) => a.fact.localeCompare(b.fact));
  for (const u of unknowns) {
    const def = factsReg.get(u.fact);
    let candidateVals: unknown[] = [false, true];
    if (def?.type === "bool") {
      candidateVals = [false, true];
    } else if (def?.type === "enum" && Array.isArray(def.values) && def.values.length >= 2) {
      candidateVals = def.values;
    } else if (def?.type === "quantity" || def?.type === "count") {
      candidateVals = [0, 10];
    }
    const allAssignments: Array<BranchType["assignment"]> = candidateVals.map((val) => ({
      kind: "unknown" as const,
      value: val,
    }));
    groups.push({
      fact: u.fact,
      assignments: allAssignments.slice(0, MAX_BRANCHES_PER_VALUE),
      excessBranches: Math.max(0, allAssignments.length - MAX_BRANCHES_PER_VALUE),
    });
    seenFacts.add(u.fact);
  }

  // 4. Unconfirmed facts
  for (const scope of ["site", "plan"] as const) {
    const rec = (kase[scope] ?? {}) as Record<string, any>;
    for (const key of Object.keys(rec).sort()) {
      const fullFact = `${scope}.${key}`;
      if (C.COMPUTED_FACTS.includes(fullFact as any)) continue;
      if (!isFactUnconfirmed(kase, fullFact)) continue;
      const curVal = resolveScalarFactValue(kase, fullFact);
      const def = factsReg.get(fullFact);
      let altValues: unknown[] = [];
      if (typeof curVal === "boolean" || def?.type === "bool") {
        altValues = [!curVal];
      } else if (def?.type === "enum" && Array.isArray(def.values)) {
        altValues = def.values.filter((v) => v !== curVal);
      } else if (typeof curVal === "number") {
        altValues = [curVal === 0 ? 1 : 0];
      }
      if (altValues.length === 0) continue;
      const allAssignments: Array<BranchType["assignment"]> = altValues.map((val) => ({
        kind: "unconfirmed" as const,
        value: val,
      }));
      groups.push({
        fact: fullFact,
        assignments: allAssignments.slice(0, MAX_BRANCHES_PER_VALUE),
        excessBranches: Math.max(0, allAssignments.length - MAX_BRANCHES_PER_VALUE),
      });
      seenFacts.add(fullFact);
    }
  }

  // 5. Measured geometry facts ± tolerance
  const geomPriority: string[] = [
    "site.rear_lot_line",
    "site.side_lot_lines",
    "site.front_lot_line",
    "site.house_outline",
    "site.structures",
    "site.lot_outline",
  ];
  for (const fullFact of geomPriority) {
    const tol = extractFactToleranceFt(kase, fullFact);
    if (tol <= 0) continue;
    groups.push({
      fact: fullFact,
      assignments: [
        { kind: "tolerance", delta: -tol },
        { kind: "tolerance", delta: tol },
      ],
      excessBranches: 0,
    });
    seenFacts.add(fullFact);
  }

  // Any additional non-computed facts with a positive numeric tolerance not yet visited
  for (const scope of ["site", "plan"] as const) {
    const rec = (kase[scope] ?? {}) as Record<string, any>;
    for (const key of Object.keys(rec).sort()) {
      const fullFact = `${scope}.${key}`;
      if (seenFacts.has(fullFact) || C.COMPUTED_FACTS.includes(fullFact as any)) continue;
      const tol = extractFactToleranceFt(kase, fullFact);
      if (tol <= 0) continue;
      groups.push({
        fact: fullFact,
        assignments: [
          { kind: "tolerance", delta: -tol },
          { kind: "tolerance", delta: tol },
        ],
        excessBranches: 0,
      });
      seenFacts.add(fullFact);
    }
  }

  return groups;
}

/**
 * Apply a single branch `assignment` to a cloned `Case` object and re-materialize
 * all computed facts in `COMPUTED_FROM⁻¹(fact)`.
 */
function applyBranchAssignment(
  baseCase: Record<string, any>,
  fact: string,
  assignment: BranchType["assignment"],
  closure: Set<string>,
): Record<string, any> {
  const branched = structuredClone(baseCase);

  if (assignment.kind === "unconfirmed" || assignment.kind === "unknown") {
    setKnownFactValue(branched, fact, assignment.value);
  } else if (assignment.kind === "observation") {
    const entry = getFactEntry(branched, fact);
    const obs = entry?.["observations"]?.[assignment.index];
    if (obs) {
      setKnownFactValue(branched, fact, structuredClone(obs["value"]));
    }
  } else if (assignment.kind === "reading") {
    const entry = getFactEntry(branched, fact);
    const readingVals = entry?.["by_reading"]?.[assignment.ambiguity_id];
    if (Array.isArray(readingVals) && assignment.index < readingVals.length) {
      setKnownFactValue(branched, fact, structuredClone(readingVals[assignment.index]));
    }
  } else if (assignment.kind === "tolerance") {
    applyGeometryToleranceDelta(branched, fact, assignment.delta);
  }

  materializeComputedFacts(branched, closure);
  return branched;
}

/**
 * Run deterministic sensitivity analysis (`C5_Sensitivity`) with **zero model calls**.
 */
export function runSensitivity(input: SensitivityInput): SensitivityType {
  const baseCtx =
    input.findings && input.plan
      ? (() => {
          const cloned = structuredClone(input.case) as Record<string, any>;
          materializeComputedFacts(cloned);
          return {
            case: cloned as CaseType,
            findings: input.findings,
            plan: input.plan,
            selected_placement: input.selected_placement ?? null,
          };
        })()
      : buildNominalContext(input.case);

  const kase = baseCtx.case as unknown as Record<string, any>;
  const asOf = String(kase["as_of"]?.["date"] ?? "2026-11-15");
  const nominalFindings = baseCtx.findings;
  const plan = baseCtx.plan;
  const nominalSelectedPlacement = baseCtx.selected_placement;
  const clientPlacement = (resolveScalarFactValue(kase, "plan.placement") ?? null) as PlacementType | null;

  // Map nominal findings by (provision_id, target)
  const nominalByKey = new Map<string, FindingInput>();
  for (const f of nominalFindings) {
    nominalByKey.set(`${f.provision_id}::${f.target}`, f);
  }

  // Ensure every provision in `plan.applies`, `plan.excluded_at_index`, and `nominalFindings` is tracked
  // Portland's default ADU set applies only to Portland cases; other cities use what the plan and findings name.
  const isPdxCase = ((kase as any).jurisdiction?.city_layer ?? "PDX") === "PDX";
  const allTrackedProvisions = new Set<string>([
    ...(isPdxCase ? DEFAULT_PDX_ADU_PROVISIONS : []),
    ...plan.applies.map((a) => a.provision_id),
    ...plan.excluded_at_index.map((e) => e.provision_id),
    ...nominalFindings.map((f) => f.provision_id),
  ]);

  const nominalClientSpotPasses = deriveClientSpotPasses(nominalFindings);
  const nominalHasPassingPlacement =
    nominalClientSpotPasses === true ||
    (nominalSelectedPlacement !== null &&
      nominalFindings
        .filter((f) => f.target === "selected_placement" && f.outcome !== "not_applicable")
        .every((f) => f.outcome === "pass"));
  const nominalVerdict = entailVerdict(
    nominalFindings,
    kase,
    nominalHasPassingPlacement,
    nominalClientSpotPasses,
  );

  // Precompute facts read by each tracked provision
  const provisionReadsMap = new Map<string, Set<string>>();
  for (const pid of allTrackedProvisions) {
    provisionReadsMap.set(pid, factsReadByProvision(pid, asOf, plan));
  }

  const candidateGroups = collectCandidateFlipGroups(kase);
  const testedGroups = candidateGroups.slice(0, MAX_SENSITIVITY_VALUES);
  const overflowGroups = candidateGroups.slice(MAX_SENSITIVITY_VALUES);

  const untested: SensitivityType["untested"] = [];
  for (const g of testedGroups) {
    if (g.excessBranches > 0) {
      untested.push({
        fact: g.fact,
        reason: `capped at ${MAX_BRANCHES_PER_VALUE} branches per value (${g.excessBranches} additional branch(es) untested)`,
      });
    }
  }
  for (const g of overflowGroups) {
    untested.push({
      fact: g.fact,
      reason: `exceeds sensitivity cap of ${MAX_SENSITIVITY_VALUES} values`,
    });
  }

  const branches: BranchType[] = [];

  for (const group of testedGroups) {
    const closure = computedFromInverseClosure(group.fact);

    // Determine which provisions read any fact in `closure`
    const affectedProvisions = new Set<string>();
    for (const [pid, reads] of provisionReadsMap.entries()) {
      for (const f of closure) {
        if (reads.has(f)) {
          affectedProvisions.add(pid);
          break;
        }
      }
    }
    // If PDX.33.110.220.B is affected, also include its exception PDX.33.110.245.C.2
    if (affectedProvisions.has("PDX.33.110.220.B")) {
      affectedProvisions.add("PDX.33.110.245.C.2");
    }

    for (let bIdx = 0; bIdx < group.assignments.length; bIdx++) {
      const assignment = group.assignments[bIdx]!;
      const branchedCase = applyBranchAssignment(kase, group.fact, assignment, closure);

      // Start from a clone of the nominal findings map
      const branchFindingsMap = new Map<string, FindingInput>();
      for (const [k, v] of nominalByKey.entries()) {
        branchFindingsMap.set(k, { ...v });
      }

      if (affectedProvisions.size > 0) {
        const reeval = evaluateProvisionsOnCase(
          branchedCase,
          affectedProvisions,
          clientPlacement,
          nominalSelectedPlacement,
          `${kase["case_id"]}::branch::${group.fact}::${bIdx}`,
        );
        for (const bf of reeval.findings) {
          branchFindingsMap.set(`${bf.provision_id}::${bf.target}`, bf);
        }
      }

      let branchFindings = Array.from(branchFindingsMap.values());
      const branchClientSpotPasses = deriveClientSpotPasses(branchFindings);

      // Check whether gates and plan constraints pass in this branch
      const gatesAndPlanPass = branchFindings
        .filter(
          (f) =>
            (f.evaluation_stage === "gate" || f.evaluation_stage === "plan_constraint") &&
            f.outcome !== "not_applicable",
        )
        .every((f) => f.outcome === "pass");

      let branchHasPassingPlacement = false;
      if (branchClientSpotPasses === true && gatesAndPlanPass) {
        branchHasPassingPlacement = true;
      } else if (nominalSelectedPlacement !== null) {
        const selFindings = branchFindings.filter(
          (f) => f.target === "selected_placement" && f.outcome !== "not_applicable",
        );
        const selPasses = selFindings.length > 0 && selFindings.every((f) => f.outcome === "pass");
        if (selPasses && gatesAndPlanPass) {
          branchHasPassingPlacement = true;
        } else if (!selPasses && gatesAndPlanPass) {
          // Selected placement failed in this branch -> re-run find_placements in this branch
          const search = runFindPlacementsBridge(
            branchedCase,
            clientPlacement,
            `${kase["case_id"]}::branch-search::${group.fact}::${bIdx}`,
          );
          const altPlacement = search.nearest_to_client ?? search.max_clearance ?? null;
          if (altPlacement && search.clear_count > 0) {
            const altEval = evaluateProvisionsOnCase(
              branchedCase,
              new Set(isPdxCase ? DEFAULT_PDX_ADU_PROVISIONS : allTrackedProvisions),
              clientPlacement,
              altPlacement,
              `${kase["case_id"]}::branch-alt::${group.fact}::${bIdx}`,
            );
            for (const bf of altEval.findings) {
              branchFindingsMap.set(`${bf.provision_id}::${bf.target}`, bf);
            }
            branchFindings = Array.from(branchFindingsMap.values());
            const altSelFindings = branchFindings.filter(
              (f) => f.target === "selected_placement" && f.outcome !== "not_applicable",
            );
            branchHasPassingPlacement =
              altSelFindings.length > 0 && altSelFindings.every((f) => f.outcome === "pass");
          }
        }
      }

      const branchVerdict = entailVerdict(
        branchFindings,
        branchedCase,
        branchHasPassingPlacement,
        branchClientSpotPasses,
      );

      // Compute findings_delta against nominal findings
      const findingsDelta: BranchType["findings_delta"] = [];
      for (const [key, bf] of branchFindingsMap.entries()) {
        const nom = nominalByKey.get(key);
        const fromOutcome: OutcomeType = nom ? nom.outcome : "not_applicable";
        if (fromOutcome !== bf.outcome) {
          findingsDelta.push({
            provision_id: bf.provision_id,
            target: bf.target,
            from: fromOutcome,
            to: bf.outcome,
          });
        }
      }

      branches.push(
        C.Branch.parse({
          fact: group.fact,
          assignment,
          verdict: branchVerdict,
          client_spot_passes: branchClientSpotPasses,
          findings_delta: findingsDelta,
        }),
      );
    }
  }

  // Compute `critical`: facts whose branches differ in `verdict` or in `client_spot_passes`
  const branchesByFact = new Map<string, BranchType[]>();
  for (const b of branches) {
    const list = branchesByFact.get(b.fact) ?? [];
    list.push(b);
    branchesByFact.set(b.fact, list);
  }

  const critical: SensitivityType["critical"] = [];
  for (const [fact, factBranches] of branchesByFact.entries()) {
    const verdicts = new Set(factBranches.map((b) => b.verdict));
    const clientSpots = new Set(factBranches.map((b) => b.client_spot_passes));
    const differsAcrossBranches = verdicts.size > 1 || clientSpots.size > 1;
    const differsFromNominal = factBranches.some(
      (b) => b.verdict !== nominalVerdict || b.client_spot_passes !== nominalClientSpotPasses,
    );

    if (differsAcrossBranches || differsFromNominal) {
      const flippedCount = factBranches.filter(
        (b) => b.verdict !== nominalVerdict || b.client_spot_passes !== nominalClientSpotPasses,
      ).length;
      const impact = differsAcrossBranches
        ? 1
        : Number(Math.min(1, Math.max(0, flippedCount / factBranches.length)).toFixed(4));
      critical.push({ fact, impact });
    }
  }

  return C.Sensitivity.parse({
    nominal_verdict: nominalVerdict,
    branches,
    critical,
    untested,
  });
}

// ------------------------------------------------------------------ C5 · Question Generation

const DECIDED_VERDICTS = new Set<VerdictType>(["FITS", "NO_LEGS", "BLOCKED_BY_GATE"]);

function formatValueLabel(val: unknown, unit?: string): string {
  if (typeof val === "number") {
    const formatted = val.toLocaleString("en-US");
    return unit ? `${formatted} ${unit}` : formatted;
  }
  if (typeof val === "boolean") {
    return val ? "Yes" : "No";
  }
  return String(val);
}

/**
 * Build eligible `Question` objects (`C5_QuestionSet`, max 3) from critical facts:
 *   - Built from critical facts that a person can answer (`observation` conflicts, `unknown`, `unconfirmed`).
 *   - Filtered by eligibility:
 *     1. At least 2 answers (`answers.length >= 2`)
 *     2. Answers have >= 2 distinct verdicts (`new Set(answers.map(a => a.verdict)).size >= 2`)
 *     3. At least one answer yields a decided verdict (`FITS`, `NO_LEGS`, `BLOCKED_BY_GATE`).
 */
export function buildQuestions(
  rawCase: CaseType | Record<string, unknown>,
  sensitivity: SensitivityType,
): QuestionSetType {
  const kase = rawCase as Record<string, any>;
  const asOf = String(kase["as_of"]?.["date"] ?? "2026-11-15");
  const factsReg = getFactsRegistry();
  const questions: QuestionType[] = [];

  for (const crit of sensitivity.critical) {
    const fact = crit.fact;
    const factBranches = sensitivity.branches.filter((b) => b.fact === fact);
    if (factBranches.length === 0) continue;

    // Only build user-settleable questions from observation conflicts, unknowns, or unconfirmed facts
    const kind = factBranches[0]!.assignment.kind;
    if (kind !== "observation" && kind !== "unknown" && kind !== "unconfirmed") {
      continue;
    }

    const factDef = factsReg.get(fact);
    const unit = factDef?.unit;
    const entry = getFactEntry(kase, fact);

    // Find the first provision in findings_delta to link a clause_id if available
    const firstDeltaProv =
      factBranches.flatMap((b) => b.findings_delta)[0]?.provision_id ?? null;
    let clauseId: string | null = null;
    if (firstDeltaProv) {
      try {
        const rf = ruleFamily(firstDeltaProv, asOf);
        clauseId = rf.clauses[0]?.clause_id ?? null;
      } catch {
        clauseId = null;
      }
    }

    let answers: QuestionType["answers"] = [];
    let prompt = "";
    let whoCanSettle = "the property owner";
    let assumedValue: unknown = null;

    if (kind === "observation" && entry && Array.isArray(entry["observations"])) {
      const obsList = entry["observations"] as Array<{ value: unknown; prov: Array<Record<string, any>> }>;
      answers = factBranches.map((b) => {
        const idx = (b.assignment as { kind: "observation"; index: number }).index;
        const obs = obsList[idx];
        const val = obs ? obs.value : idx;
        const srcKind = obs?.prov?.[0]?.["kind"] ?? `observation ${idx + 1}`;
        return {
          label: `${formatValueLabel(val, unit)} (${srcKind})`,
          value: val,
          verdict: b.verdict,
        };
      });
      const valSummaries = obsList.map((o) => formatValueLabel(o.value, unit)).join(" vs. ");
      prompt = `Sources disagree on ${fact} (${valSummaries}). Which value is right?`;
      whoCanSettle = "the owner, with the county record or building plans";
      assumedValue = obsList[0]?.value ?? null;
    } else if (kind === "unknown") {
      answers = factBranches.map((b) => {
        const val = (b.assignment as { kind: "unknown"; value: unknown }).value;
        return {
          label: formatValueLabel(val, unit),
          value: val,
          verdict: b.verdict,
        };
      });
      prompt = `What is the value of ${fact}?`;
      whoCanSettle = "the property owner or surveyor";
      assumedValue = answers[0]?.value ?? null;
    } else if (kind === "unconfirmed") {
      const nominalVal = resolveScalarFactValue(kase, fact);
      answers = [
        {
          label: `${formatValueLabel(nominalVal, unit)} (current)`,
          value: nominalVal,
          verdict: sensitivity.nominal_verdict,
        },
        ...factBranches.map((b) => {
          const val = (b.assignment as { kind: "unconfirmed"; value: unknown }).value;
          return {
            label: formatValueLabel(val, unit),
            value: val,
            verdict: b.verdict,
          };
        }),
      ];
      prompt = `Please confirm ${fact} (currently ${formatValueLabel(nominalVal, unit)}).`;
      whoCanSettle = "the property owner";
      assumedValue = nominalVal;
    }

    // Eligibility filter (Contract C5):
    // 1. At least 2 answers
    // 2. Answers have >= 2 distinct verdicts
    // 3. At least one answer yields a decided verdict (`FITS`, `NO_LEGS`, `BLOCKED_BY_GATE`)
    const distinctVerdicts = new Set(answers.map((a) => a.verdict));
    const hasDecidedAnswer = answers.some((a) => DECIDED_VERDICTS.has(a.verdict));
    if (answers.length < 2 || distinctVerdicts.size < 2 || !hasDecidedAnswer) {
      continue;
    }

    const questionObj: QuestionType = C.Question.parse({
      question_id: deterministicUuid7(`${kase["case_id"] ?? "case"}::question::${fact}`),
      fact,
      prompt,
      clause_id: clauseId,
      who_can_settle: whoCanSettle,
      answers,
      skip: {
        assumed_value: assumedValue,
        verdict: sensitivity.nominal_verdict,
      },
    });

    questions.push(questionObj);
    if (questions.length >= 3) break;
  }

  return C.QuestionSet.parse(questions);
}

/**
 * Convenience wrapper returning both `sensitivity` (`C5_Sensitivity`) and `questions` (`C5_QuestionSet`).
 */
export function runSensitivityWithQuestions(input: SensitivityInput): SensitivityWithQuestions {
  const sensitivity = runSensitivity(input);
  const questions = buildQuestions(input.case, sensitivity);
  return { sensitivity, questions };
}
