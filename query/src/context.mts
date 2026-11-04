// W6 · Context builder and running ledger (ARCHITECTURE.md round 4.1 §5).
// Rebuilt on every model call from the append-only event log:
//   1. Role and principles (<= 25 lines, frozen per version)
//   2. Compact ontology (`renderOntologyPromptBlock`)
//   3. Tool contracts for the active phase only (respecting stage / breaker revocations)
//   4. Case summary: scalar facts with status; geometry by handle (`{fact: "site.lot_outline"}`)
//   5. Running ledger: agenda by stage, one-line findings with evidence ids, active constraints,
//      and persistent parameter table `{provision_id: {param: {value, unit}}}` for every family read
//   6. Working window: full text and results for the last two turns (prior reasoning never re-sent).

import type { z } from "zod";
import type { LotFitEventType, PhaseType } from "./events.mts";
import { sha256Hex } from "./events.mts";
import { labelOf, loadOntology, type Ontology, patterns } from "./ontology.mts";
import * as C from "./types.mts";

export type CaseType = z.infer<typeof C.Case>;
export type PlanType = z.infer<typeof C.Plan>;
export type RuleFamilyType = z.infer<typeof C.RuleFamily>;
export type RecordFindingType = z.infer<typeof C.RecordFinding>;
export type RepairErrorType = z.infer<typeof C.RepairError>;

/**
 * Frozen Role and Principles prompt block (<= 25 lines, ARCHITECTURE.md §0 & §5).
 * Note: The reading guide is never embedded here; it enters only as the result of `read_reading_guide` (EN-13).
 */
export const ROLE_AND_PRINCIPLES = [
  "# LotFit Evaluating Agent — Role & Principles (v1.0.0)",
  "You are the LotFit zoning evaluation agent. You evaluate a single property Case against the pinned code graph.",
  "1. Models propose; code decides; people confirm only what flips the answer.",
  "2. Every number comes from a tool; every rule comes from a verbatim clause in force on the case's as_of date.",
  "3. Never type a legal number (limit, setback, share, or cap) into a tool call.",
  "   Always pass a parameter reference `{provision_id, param}` or cell reference `{provision_id, cell_id}`.",
  "4. Pass geometry and case values by handle `{fact: \"site.<name>\"}` or `{fact: \"plan.<name>\"}`.",
  "5. In PLAN, call `read_reading_guide`, `read_layer_index`, and `inspect_case_facts`, then return a JSON `Plan`",
  "   partitioning every index provision into `applies` or `excluded_at_index` with verbatim `scope_quote`s.",
  "   Never exclude a gate, an operator-backed provision, or one modifying an operator-backed provision unless",
  "   one of its guards is known false on the case.",
  "6. In EXECUTE, follow the stage order strictly: `gate` -> `plan_constraint` -> `placement_constraint`.",
  "   Every evaluation tool call must state `provision_id` and `target` (`case`, `client_spot`, or `selected_placement`).",
  "7. Record each finding with `record_finding`, citing real `evidence_call_ids`, verbatim `quotes`, and exact",
  "   result paths for `numbers`. A `not_applicable` finding must cite an `evaluate_guards` call returning `known_false`.",
  "8. Finish EXECUTE by calling `conclude` with your proposed `verdict`, `summary`, `selected_placement`, and `client_spot_passes`.",
  "9. Work in batches: issue every independent tool call of a stage in one response, and record every waiting finding in one response.",
].join("\n");

export function getRoleAndPrinciplesSha256(): string {
  return sha256Hex(ROLE_AND_PRINCIPLES);
}

/**
 * Compact ontology renderer (`renderOntologyPromptBlock`, ARCHITECTURE.md §5 item 2).
 * Renders labels, key properties, allowed values, and relationship patterns compactly.
 */
export function renderOntologyPromptBlock(ontology?: Ontology): string {
  const o = ontology ?? loadOntology();
  const lines: string[] = [
    `# Ontology: ${o.name ?? o.id} (v${o.version})`,
    o.description ?? "",
    "",
    "## Nodes",
  ];

  for (const [nodeId, n] of Object.entries(o.nodes)) {
    const label = n.label ?? nodeId;
    const props = Object.entries(n.properties ?? {}).map(([k, p]) => {
      const keyTag = p.key ? " [KEY]" : "";
      const oneOfTag = p.one_of ? `∈{${p.one_of.join("|")}}` : "";
      return `${k}:${p.type ?? "ANY"}${keyTag}${oneOfTag}`;
    });
    const desc = (n.description ?? "").replace(/\s+/g, " ").trim();
    lines.push(`- (:${label}) — ${desc}`);
    if (props.length > 0) {
      lines.push(`  props: ${props.join(", ")}`);
    }
  }

  lines.push("", "## Relationships");
  for (const pat of patterns(o)) {
    const rel = o.relationships[pat.id];
    const desc = (rel?.description ?? "").replace(/\s+/g, " ").trim();
    lines.push(`- (:${pat.from})-[:${pat.type}]->(:${pat.to}) — ${desc}`);
  }

  return lines.join("\n");
}

export function getOntologySha256(ontology?: Ontology): string {
  return sha256Hex(renderOntologyPromptBlock(ontology));
}

export const PLAN_PHASE_TOOLS = [
  "read_reading_guide",
  "read_layer_index",
  "inspect_case_facts",
] as const;

export const PLACEMENT_TOOLS = new Set<string>([
  "placed_outline",
  "physical_fit",
  "distance_to_line",
  "check_setback",
  "check_front_or_behind",
  "coverage_share",
  "total_building_coverage",
  "check_exception_conditions",
  "find_placements",
  "check_solar_shadow",
]);

export const PLAN_CONSTRAINT_TOOLS = new Set<string>([
  "adu_max_living_area",
  "check_max",
  "footprint_dimensions",
]);

export const ALL_EXECUTE_TOOLS = [
  ...Object.keys(C.TOOL_ARGS),
  ...C.LEDGER_TOOLS,
] as const;

export interface ToolContractSpec {
  name: string;
  description: string;
  argsShape: string;
}

export const TOOL_DESCRIPTIONS: Record<string, ToolContractSpec> = {
  read_reading_guide: {
    name: "read_reading_guide",
    description: "Read the evaluation reading guide (stages, rules of reading, verdicts).",
    argsShape: "{}",
  },
  read_layer_index: {
    name: "read_layer_index",
    description: "Read the in-force provision index for the state and city layers on the case as_of date.",
    argsShape: "{ city_layer: string, as_of: IsoDate }",
  },
  read_rule_family: {
    name: "read_rule_family",
    description: "Read full rule families (version, params, cells, clauses, readings, operators, relations) for up to 12 provisions.",
    argsShape: "{ provision_ids: ProvisionId[], as_of: IsoDate }",
  },
  query_code_graph: {
    name: "query_code_graph",
    description: "Run a read-only parameterized Cypher query against the code graph (Tier 2).",
    argsShape: "{ question: string, cypher: string, params?: Record<string, unknown> }",
  },
  inspect_case_facts: {
    name: "inspect_case_facts",
    description: "Inspect scalar facts, statuses, provenance, and tolerances from the case.",
    argsShape: "{ facts?: FactName[] }",
  },
  evaluate_guards: {
    name: "evaluate_guards",
    description: "Evaluate clause guards three-valued (known_true | known_false | unknown) for a provision.",
    argsShape: "{ provision_id: ProvisionId, target: Target }",
  },
  adu_max_living_area: {
    name: "adu_max_living_area",
    description: "Check ADU living area against min(share * primary_living_area, cap). Limits must be ParamRef.",
    argsShape: "{ provision_id: ProvisionId, target: Target, primary_living_area: FactRef, plan_living_area: FactRef, share: ParamRef, cap: ParamRef }",
  },
  check_allowed: {
    name: "check_allowed",
    description: "Decide a gate: is this use allowed in the case's zone? Reads the gate's allowed-use table cell (param `<use>.<zone>`) and returns pass true/false. Use it for every gate that is not ruled out by a known_false guard.",
    argsShape: "{ provision_id: ProvisionId, target: Target, use: string (param name prefix, e.g. 'accessory_dwelling_unit_see_chapter_33_205'), zone: FactRef (site.zone) }",
  },
  check_max: {
    name: "check_max",
    description: "Check that a fact or call result does not exceed a ParamRef limit.",
    argsShape: "{ provision_id: ProvisionId, target: Target, value: FactRef | CallRef, limit: ParamRef }",
  },
  footprint_dimensions: {
    name: "footprint_dimensions",
    description: "Check maximum footprint width/depth against a ParamRef limit.",
    argsShape: "{ provision_id: ProvisionId, target: Target, outline: Geom, limit: ParamRef }",
  },
  coverage_share: {
    name: "coverage_share",
    description: "Check combined accessory structure coverage percentage against a ParamRef limit.",
    argsShape: "{ provision_id: ProvisionId, target: Target, outlines: Geom[], lot_area: FactRef, limit: ParamRef }",
  },
  placed_outline: {
    name: "placed_outline",
    description: "Place a footprint polygon at `{x, y, rotation}` in the lot frame.",
    argsShape: "{ provision_id: ProvisionId, target: Target, footprint: FactRef, placement: Placement }",
  },
  physical_fit: {
    name: "physical_fit",
    description: "Check whether a placed outline sits inside the lot and clear of the house and existing structures.",
    argsShape: "{ provision_id: ProvisionId, target: Target, outline: Geom }",
  },
  distance_to_line: {
    name: "distance_to_line",
    description: "Measure minimum distance in feet from an outline to a lot line.",
    argsShape: "{ provision_id: ProvisionId, target: Target, outline: Geom, line: FactRef }",
  },
  check_setback: {
    name: "check_setback",
    description: "Check distance from an outline to lot line(s) against a ParamRef minimum setback.",
    argsShape: "{ provision_id: ProvisionId, target: Target, outline: Geom, lines: FactRef, min: ParamRef }",
  },
  check_front_or_behind: {
    name: "check_front_or_behind",
    description: "Check whether an outline is at least min_front (ParamRef) from the front line or behind the house rear wall.",
    argsShape: "{ provision_id: ProvisionId, target: Target, outline: Geom, front_lot_line: FactRef, min_front: ParamRef, house_rear_wall: FactRef }",
  },
  total_building_coverage: {
    name: "total_building_coverage",
    description: "Check total covered building area against a Table 110-5 CellRef cap.",
    argsShape: "{ provision_id: ProvisionId, target: Target, outlines: Geom[], lot_area: FactRef, cap_cell: CellRef }",
  },
  check_exception_conditions: {
    name: "check_exception_conditions",
    description: "Evaluate all conditions of a setback exception (e.g. PDX.33.110.245.C.2) three-valued.",
    argsShape: "{ provision_id: ProvisionId, target: Target, exception_id: ProvisionId, base_provision_id: ProvisionId, outline: Geom }",
  },
  find_placements: {
    name: "find_placements",
    description: "Search the lot for clear placements satisfying setback provisions with margin >= tolerance.",
    argsShape: "{ provision_id: ProvisionId, target: Target, footprint: FactRef, rotations?: number[], setback_provisions: ProvisionId[] }",
  },
  check_solar_shadow: {
    name: "check_solar_shadow",
    description: "Evaluate winter-noon solar shadow over the north uncertainty interval.",
    argsShape: "{ provision_id: ProvisionId, target: Target, outline: Geom }",
  },
  record_finding: {
    name: "record_finding",
    description: "Record a grounded finding for `(provision_id, target)` citing tool call IDs, verbatim clause quotes, and result paths.",
    argsShape: "{ provision_id: ProvisionId, target: Target, clause_ids: ClauseId[], outcome: Outcome, evidence_call_ids: Uuid7[], numbers?: {value: number, unit: string, call_id: Uuid7, path: string}[], quotes: {clause_id: ClauseId, quote: string}[], note?: string }",
  },
  conclude: {
    name: "conclude",
    description: "Propose the final evaluation verdict, summary, selected_placement, and client_spot_passes (triggers V1-V8 verification).",
    argsShape: "{ verdict: Verdict, summary: string, selected_placement: Placement | null, client_spot_passes: boolean | null }",
  },
};

export type BreakerState =
  | { tripped: false }
  | {
      tripped: true;
      stage: "gate" | "plan_constraint";
      provision_id: string;
      call_id: string;
      limit: z.infer<typeof C.ResolvedParam> | null;
    };

/**
 * Returns the list of allowed tool names for the current phase and breaker state.
 */
export function allowedToolsForPhase(
  phase: "plan" | "execute",
  breaker: BreakerState = { tripped: false },
  caseMode: z.infer<typeof C.Mode> = "check_spot",
): string[] {
  if (phase === "plan") {
    return [...PLAN_PHASE_TOOLS];
  }
  if (!breaker.tripped) {
    return [...ALL_EXECUTE_TOOLS];
  }
  if (breaker.stage === "gate") {
    // Failed gate revokes every measuring and placement tool (EN-16)
    return ["read_reading_guide", "read_layer_index", "read_rule_family", "inspect_case_facts", "evaluate_guards", "record_finding", "conclude"];
  }
  // Failed plan_constraint revokes placement tools in check_spot and find_spots (§3)
  if (caseMode !== "propose") {
    return ALL_EXECUTE_TOOLS.filter((t) => !PLACEMENT_TOOLS.has(t));
  }
  return [...ALL_EXECUTE_TOOLS];
}

export function renderPhaseToolContracts(
  phase: "plan" | "execute",
  breaker: BreakerState = { tripped: false },
  caseMode: z.infer<typeof C.Mode> = "check_spot",
): string {
  const allowed = allowedToolsForPhase(phase, breaker, caseMode);
  const lines: string[] = [
    `# Allowed Tools for Phase: ${phase.toUpperCase()}`,
    "ParamRef = `{provision_id: ProvisionId, param: string}`; CellRef = `{provision_id: ProvisionId, cell_id: string}`;",
    "FactRef = `{fact: FactName}`; Geom = `FactRef | {placed: {x, y, rotation}, footprint: FactRef}`.",
  ];
  for (const name of allowed) {
    const spec = TOOL_DESCRIPTIONS[name];
    if (spec) {
      lines.push(`- **${spec.name}**(${spec.argsShape}): ${spec.description}`);
    }
  }
  return lines.join("\n");
}

export function getToolContractsSha256(): string {
  return sha256Hex(
    renderPhaseToolContracts("plan") + "\n---\n" + renderPhaseToolContracts("execute"),
  );
}

const GEOMETRY_HANDLE_FACTS = new Set<string>([
  ...C.GEOMETRY_FACTS,
  "site.house_rear_wall",
  "plan.footprint",
  "plan.outline",
]);

/**
 * Renders the Case summary with scalar facts + statuses and geometry by handle (`{fact: "..."}`),
 * never dumping raw polygon coordinate arrays into the model prompt (§5 item 4).
 */
export function renderCaseSummary(kase: CaseType): string {
  const lines: string[] = [
    `# Case Summary (case_id: ${kase.case_id})`,
    `- as_of: ${kase.as_of.date} (${kase.as_of.meaning})`,
    `- jurisdiction: state=${kase.jurisdiction.state_layer}, city=${kase.jurisdiction.city_layer}`,
    `- mode: ${kase.mode}`,
  ];

  const renderScope = (scope: "site" | "plan", rec: Record<string, z.infer<typeof C.FactEntry>>) => {
    lines.push(`## ${scope} facts`);
    for (const key of Object.keys(rec).sort()) {
      const fullFact = `${scope}.${key}`;
      const entry = rec[key]!;
      if (GEOMETRY_HANDLE_FACTS.has(fullFact)) {
        const tol =
          "observations" in entry
            ? entry.observations[0]?.prov[0]?.tolerance
            : entry.prov[0]?.tolerance;
        const tolStr = tol ? ` (tolerance: ±${tol.value} ${tol.unit})` : "";
        lines.push(`- ${fullFact}: <geometry handle \`{"fact": "${fullFact}"}\`>${tolStr}`);
        continue;
      }
      if ("observations" in entry) {
        const vals = entry.observations.map((o) => JSON.stringify(o.value)).join(" vs ");
        lines.push(`- ${fullFact}: CONFLICTING [${vals}] (handle \`{"fact": "${fullFact}"}\`)`);
      } else {
        const tol = entry.prov[0]?.tolerance;
        const tolStr = tol ? `, τ=±${tol.value} ${tol.unit}` : "";
        const readingStr = entry.by_reading
          ? `, by_reading=${JSON.stringify(entry.by_reading)}`
          : "";
        lines.push(
          `- ${fullFact}: ${JSON.stringify(entry.value)} [status=${entry.status}${tolStr}${readingStr}] (handle \`{"fact": "${fullFact}"}\`)`,
        );
      }
    }
  };

  renderScope("site", kase.site);
  renderScope("plan", kase.plan);

  if (kase.unknowns.length > 0) {
    lines.push("## Listed unknowns");
    for (const u of kase.unknowns) {
      lines.push(`- ${u.fact}: unknown (${u.reason})`);
    }
  }

  return lines.join("\n");
}

export interface PersistentParamEntry {
  value: number | string;
  unit: string | null;
  clause_id: string | null;
}

export interface RunningLedger {
  phase: PhaseType;
  agenda_by_stage: {
    gate: Array<{ provision_id: string; status: "pending" | "done" }>;
    plan_constraint: Array<{ provision_id: string; status: "pending" | "done" }>;
    placement_constraint: Array<{ provision_id: string; status: "pending" | "done" }>;
  };
  findings: Array<{
    provision_id: string;
    target: z.infer<typeof C.Target>;
    outcome: z.infer<typeof C.Outcome>;
    evidence_call_ids: string[];
    clause_ids: string[];
  }>;
  breaker: BreakerState;
  parameter_table: Record<string, Record<string, PersistentParamEntry>>;
  cell_table: Record<string, Array<{ cell_id: string; row: string; column: string; text: string }>>;
  /** Checks already run for a provision whose finding is not yet recorded (CC, live S1: the model re-ran guards
   * once their turn left the 2-turn window instead of recording findings). */
  awaiting_finding?: Array<{ provision_id: string; target: string; tool: string; call_id: string; preview: string }>;
  /** Clause ids and verbatim quotes of every family read, so record_finding can cite them without re-reading
   * (CC, live S1: the model hunted quotes with query_code_graph because previews carried only numbers). */
  clause_table?: Record<string, Array<{ clause_id: string; quote: string; modeled: boolean }>>;
  placement_search_run?: boolean;
}

/**
 * Rebuilds the running ledger and persistent parameter table from the event log (§5 item 5).
 * Every `read_rule_family` result populates `parameter_table`, which stays in the ledger
 * for the entire EXECUTE phase even after the turn that read it rolls out of the 2-turn window (A7).
 */
export function buildLedgerFromEvents(
  events: LotFitEventType[],
  opts: {
    phase: PhaseType;
    plan?: PlanType | null;
    indexStageMap?: Map<string, z.infer<typeof C.EvaluationStage>>;
    ruleFamiliesRead?: Map<string, RuleFamilyType>;
    breaker?: BreakerState;
  },
): RunningLedger {
  const findingsMap = new Map<
    string,
    {
      provision_id: string;
      target: z.infer<typeof C.Target>;
      outcome: z.infer<typeof C.Outcome>;
      evidence_call_ids: string[];
      clause_ids: string[];
    }
  >();

  const parameter_table: Record<string, Record<string, PersistentParamEntry>> = {};
  const cell_table: Record<string, Array<{ cell_id: string; row: string; column: string; text: string }>> = {};

  const clause_table: Record<string, Array<{ clause_id: string; quote: string; modeled: boolean }>> = {};
  // Populate from ruleFamiliesRead map if passed by harness
  if (opts.ruleFamiliesRead) {
    for (const [pid, rf] of opts.ruleFamiliesRead.entries()) {
      clause_table[pid] = [...rf.clauses]
        .sort((a, b) => Number(b.modeled) - Number(a.modeled))
        .slice(0, 6)
        .map((c) => ({ clause_id: c.clause_id, quote: c.quote.length > 220 ? c.quote.slice(0, 220) : c.quote, modeled: c.modeled }));
      const pMap: Record<string, PersistentParamEntry> = parameter_table[pid] ?? {};
      for (const pa of rf.params) {
        pMap[pa.name] = {
          value: pa.value,
          unit: pa.unit,
          clause_id: pa.clause_id,
        };
      }
      parameter_table[pid] = pMap;
      if (rf.cells.length > 0) {
        cell_table[pid] = rf.cells.map((c) => ({
          cell_id: c.cell_id,
          row: c.row,
          column: c.column,
          text: c.text,
        }));
      }
    }
  }

  // Also scan events for tool_result of read_rule_family and lotfit.finding_recorded
  const callToolById = new Map<string, string>();
  const callMetaById = new Map<string, { provision_id: string | null; target: string; tool: string }>();
  const resultsByProv = new Map<string, { provision_id: string; target: string; tool: string; call_id: string; preview: string }>();
  for (const ev of events) {
    if (ev.type === "tool_requested") {
      callToolById.set(ev.data.call.call_id, ev.data.call.tool);
      callMetaById.set(ev.data.call.call_id, { provision_id: ev.data.call.provision_id, target: ev.data.call.target, tool: ev.data.call.tool });
    } else if (ev.type === "tool_result" && ev.data.ok) {
      const meta = callMetaById.get(ev.data.call_id);
      if (meta?.provision_id && !["read_rule_family", "read_layer_index", "read_reading_guide", "inspect_case_facts", "query_code_graph", "record_finding", "conclude"].includes(meta.tool)) {
        resultsByProv.set(`${meta.provision_id}::${meta.target}::${meta.tool}`, { provision_id: meta.provision_id, target: meta.target, tool: meta.tool, call_id: ev.data.call_id, preview: ev.data.preview.slice(0, 240) });
      }
      const tool = callToolById.get(ev.data.call_id);
      if (tool === "read_rule_family") {
        try {
          const parsed = JSON.parse(ev.data.preview);
          const families = Array.isArray(parsed) ? parsed : [];
          for (const rf of families) {
            if (rf && typeof rf.provision_id === "string" && Array.isArray(rf.params)) {
              const pMap: Record<string, PersistentParamEntry> = parameter_table[rf.provision_id] ?? {};
              for (const pa of rf.params) {
                pMap[String(pa.name)] = {
                  value: pa.value,
                  unit: pa.unit ?? null,
                  clause_id: pa.clause_id ?? null,
                };
              }
              parameter_table[rf.provision_id] = pMap;
            }
            if (rf && typeof rf.provision_id === "string" && Array.isArray(rf.cells) && rf.cells.length > 0) {
              cell_table[rf.provision_id] = rf.cells.map((c: any) => ({
                cell_id: String(c.cell_id),
                row: String(c.row),
                column: String(c.column),
                text: String(c.text),
              }));
            }
          }
        } catch {
          // preview truncated or already loaded via ruleFamiliesRead
        }
      }
    } else if (ev.type === "lotfit.finding_recorded" && ev.data.accepted) {
      const f = ev.data.finding;
      findingsMap.set(`${f.provision_id}::${f.target}`, {
        provision_id: f.provision_id,
        target: f.target,
        outcome: f.outcome,
        evidence_call_ids: f.evidence_call_ids,
        clause_ids: f.clause_ids,
      });
    }
  }

  const findings = Array.from(findingsMap.values());
  // A gate whose guard is known false is ruled out (the harness stage order and V1 both accept it): done, no finding.
  const ruledOut = new Set(
    Array.from(resultsByProv.values())
      .filter((r) => r.tool === "evaluate_guards" && /"result":"known_false"/.test(r.preview))
      .map((r) => r.provision_id),
  );
  // Guard results are not findings to record: known_false rules the provision out; otherwise its check comes next.
  const awaiting_finding = Array.from(resultsByProv.values()).filter(
    (r) => r.tool !== "evaluate_guards" &&
      !findingsMap.has(`${r.provision_id}::${r.target}`) && !(r.target !== "case" && findingsMap.has(`${r.provision_id}::case`)),
  );
  const doneProvisions = new Set([...findings.map((f) => f.provision_id), ...ruledOut]);

  const agenda_by_stage: RunningLedger["agenda_by_stage"] = {
    gate: [],
    plan_constraint: [],
    placement_constraint: [],
  };

  if (opts.plan) {
    for (const pid of opts.plan.order) {
      const st = opts.indexStageMap?.get(pid) ?? "placement_constraint";
      const status: "pending" | "done" = doneProvisions.has(pid) ? "done" : "pending";
      if (st === "gate") {
        agenda_by_stage.gate.push({ provision_id: pid, status });
      } else if (st === "plan_constraint") {
        agenda_by_stage.plan_constraint.push({ provision_id: pid, status });
      } else if (st === "placement_constraint") {
        agenda_by_stage.placement_constraint.push({ provision_id: pid, status });
      }
    }
  }

  return {
    phase: opts.phase,
    agenda_by_stage,
    findings,
    breaker: opts.breaker ?? { tripped: false },
    parameter_table,
    cell_table,
    awaiting_finding,
    clause_table,
    placement_search_run: Array.from(callMetaById.values()).some((m) => m.tool === "find_placements"),
  };
}

export function renderLedgerBlock(ledger: RunningLedger): string {
  const lines: string[] = [
    `# Running Ledger (phase: ${ledger.phase})`,
    "## Agenda by Stage",
    `- gate: ${ledger.agenda_by_stage.gate.map((x) => `${x.provision_id} [${x.status}]`).join(", ") || "(none)"}`,
    `- plan_constraint: ${ledger.agenda_by_stage.plan_constraint.map((x) => `${x.provision_id} [${x.status}]`).join(", ") || "(none)"}`,
    `- placement_constraint: ${ledger.agenda_by_stage.placement_constraint.map((x) => `${x.provision_id} [${x.status}]`).join(", ") || "(none)"}`,
  ];

  if (ledger.breaker.tripped) {
    lines.push(
      `## Active Breaker: TRIPPED on ${ledger.breaker.stage} (${ledger.breaker.provision_id}, call ${ledger.breaker.call_id}) — placement tools revoked.`,
    );
  }

  lines.push("## Accepted Findings");
  if (ledger.findings.length === 0) {
    lines.push("- (no findings recorded yet)");
  } else {
    for (const f of ledger.findings) {
      lines.push(
        `- ${f.provision_id} (${f.target}): outcome=${f.outcome} | evidence=[${f.evidence_call_ids.join(", ")}] | clauses=[${f.clause_ids.join(", ")}]`,
      );
    }
  }

  if (ledger.awaiting_finding && ledger.awaiting_finding.length > 0) {
    lines.push("## Checks Already Run, Finding Not Yet Recorded — do NOT re-run these; call record_finding citing the call_id");
    for (const a of ledger.awaiting_finding) {
      lines.push(`- ${a.provision_id} (${a.target}): ${a.tool} call_id=${a.call_id} → ${a.preview}`);
    }
  }

  if (ledger.clause_table && Object.keys(ledger.clause_table).length > 0) {
    lines.push("## Clauses You Can Cite (record_finding: clause_ids from here; each quote an exact substring of the text shown)");
    // Only provisions that may still need a finding: placement ones (client spot and selected placement) and any
    // gate or plan constraint still pending.
    const closed = new Set([...ledger.agenda_by_stage.gate, ...ledger.agenda_by_stage.plan_constraint]
      .filter((x) => x.status === "done").map((x) => x.provision_id));
    for (const [pid, cls] of Object.entries(ledger.clause_table).sort()) {
      if (closed.has(pid)) continue;
      for (const c of cls.slice(0, 3)) lines.push(`- ${pid} | ${c.clause_id} | ${JSON.stringify(c.quote)}`);
    }
  }

  // Compact, one line per entry (pretty JSON doubled the uncached part of every turn). The parameter table stays for
  // the whole EXECUTE phase (A7); cells only for provisions still open. CC, prompt trim after L33.
  const openIds = new Set([
    ...ledger.agenda_by_stage.gate.filter((x) => x.status === "pending"),
    ...ledger.agenda_by_stage.plan_constraint.filter((x) => x.status === "pending"),
    ...ledger.agenda_by_stage.placement_constraint,
  ].map((x) => x.provision_id));
  lines.push("## Persistent Parameter Table (from read_rule_family) — ParamRef {provision_id, param}");
  const paramProvIds = Object.keys(ledger.parameter_table).sort();
  if (paramProvIds.length === 0) {
    lines.push("- (no rule families read yet)");
  } else {
    for (const pid of paramProvIds) {
      const entries = Object.entries(ledger.parameter_table[pid]!);
      if (entries.length === 0) continue;
      lines.push(`- ${pid}: ${entries.map(([k, v]) => `${k}=${typeof v.value === "string" ? v.value : v.value}${v.unit ? " " + v.unit : ""}`).join("; ")}`);
    }
  }
  const cellProvIds = Object.keys(ledger.cell_table).filter((pid) => openIds.has(pid)).sort();
  if (cellProvIds.length > 0) {
    lines.push("## Table Cells (open provisions) — CellRef {provision_id, cell_id}");
    for (const pid of cellProvIds) {
      for (const c of ledger.cell_table[pid]!) lines.push(`- ${pid} ${c.cell_id} | ${c.row} | ${c.column} | ${c.text}`);
    }
  }

  return lines.join("\n");
}

export interface TurnWindowEntry {
  turn_id: string;
  phase: PhaseType;
  input_summary: string;
  calls: Array<{
    call_id: string;
    tool: string;
    provision_id: string | null;
    target: string;
    args: Record<string, unknown>;
    ok?: boolean;
    cached?: boolean;
    preview?: string;
    error?: { category: string; message: string };
  }>;
  repairs: RepairErrorType[];
  status: string | null;
}

/**
 * Extracts completed turns from the event log and returns the last two turns in full (§5 item 6),
 * plus whether an older turn rolled off the 2-turn window.
 */
export function extractLastTwoTurns(events: LotFitEventType[]): {
  allCompletedTurns: TurnWindowEntry[];
  windowTurns: TurnWindowEntry[];
  rolledOffTurnCount: number;
} {
  const turnsById = new Map<string, TurnWindowEntry>();
  const turnOrder: string[] = [];

  for (const ev of events) {
    if (ev.type === "turn_started" && ev.turn_id) {
      const entry: TurnWindowEntry = {
        turn_id: ev.turn_id,
        phase: ev.data.phase,
        input_summary: ev.data.input_summary,
        calls: [],
        repairs: [],
        status: null,
      };
      turnsById.set(ev.turn_id, entry);
      turnOrder.push(ev.turn_id);
    } else if (ev.turn_id && turnsById.has(ev.turn_id)) {
      const entry = turnsById.get(ev.turn_id)!;
      if (ev.type === "tool_requested") {
        entry.calls.push({
          call_id: ev.data.call.call_id,
          tool: ev.data.call.tool,
          provision_id: ev.data.call.provision_id,
          target: ev.data.call.target,
          args: ev.data.call.args,
        });
      } else if (ev.type === "tool_result") {
        const call = entry.calls.find((c) => c.call_id === ev.data.call_id);
        if (call) {
          call.ok = ev.data.ok;
          call.cached = ev.data.cached;
          call.preview = ev.data.preview;
          if (ev.data.error) {
            call.error = ev.data.error;
          }
        }
      } else if (ev.type === "lotfit.plan_written" && ev.data.repairs.length > 0) {
        entry.repairs.push(...ev.data.repairs);
      } else if (ev.type === "lotfit.finding_recorded" && ev.data.repairs.length > 0) {
        entry.repairs.push(...ev.data.repairs);
      } else if (ev.type === "lotfit.verifier_completed" && ev.data.issues.length > 0) {
        entry.repairs.push(...ev.data.issues);
      } else if (ev.type === "turn_ended") {
        entry.status = ev.data.status;
      }
    }
  }

  const completed = turnOrder
    .map((id) => turnsById.get(id)!)
    .filter((t) => t.status !== null);

  const windowTurns = completed.slice(-2);
  const rolledOffTurnCount = Math.max(0, completed.length - 2);

  return {
    allCompletedTurns: completed,
    windowTurns,
    rolledOffTurnCount,
  };
}

export function renderWorkingWindowBlock(
  windowTurns: TurnWindowEntry[],
  currentTurnCalls: TurnWindowEntry["calls"] = [],
  pendingRepairs: RepairErrorType[] = [],
): string {
  const lines: string[] = ["# Working Window (Last Two Turns in Full)"];

  if (windowTurns.length === 0 && currentTurnCalls.length === 0) {
    lines.push("- (first turn of the evaluation)");
  }

  for (const t of windowTurns) {
    lines.push(`## Turn ${t.turn_id} [phase=${t.phase}, status=${t.status}]`);
    lines.push(`Summary: ${t.input_summary}`);
    for (const c of t.calls) {
      lines.push(
        `- Call ${c.call_id}: ${c.tool}(provision=${c.provision_id ?? "null"}, target=${c.target}, args=${JSON.stringify(c.args)})`,
      );
      if (c.ok !== undefined) {
        lines.push(
          `  Result [ok=${c.ok}, cached=${Boolean(c.cached)}]: ${c.error ? JSON.stringify(c.error) : (c.preview ?? "")}`,
        );
      }
    }
    if (t.repairs.length > 0) {
      lines.push(`  Repairs required: ${JSON.stringify(t.repairs)}`);
    }
  }

  if (currentTurnCalls.length > 0) {
    lines.push("## Current Turn Tool Results So Far");
    for (const c of currentTurnCalls) {
      lines.push(
        `- Call ${c.call_id}: ${c.tool}(provision=${c.provision_id ?? "null"}, target=${c.target}, args=${JSON.stringify(c.args)})`,
      );
      if (c.ok !== undefined) {
        lines.push(
          `  Result [ok=${c.ok}, cached=${Boolean(c.cached)}]: ${c.error ? JSON.stringify(c.error) : (c.preview ?? "")}`,
        );
      }
    }
  }

  if (pendingRepairs.length > 0) {
    lines.push("## Active Repair Instructions (Fix These Issues)");
    lines.push(JSON.stringify(pendingRepairs, null, 2));
  }

  return lines.join("\n");
}

/** The layer index in full during PLAN (C2): the plan must partition exactly these provisions and copy their scope
 * quotes verbatim, so the model sees every entry, not the 2,000-char event preview. CC, live S1 run 1. */
export function renderIndexBlock(idx: z.infer<typeof C.LayerIndex>): string {
  const lines = [`# Layer Index (as_of ${idx.as_of}, index_hash ${idx.index_hash}) — partition ALL of these; copy scope_quote verbatim`,
    "provision_id | type | stage | has_operator | modifies_operator_backed | scope_quote"];
  const tail = [
    "",
    "## Plan format (answer with ONLY this JSON object; no other keys, no comments)",
    `{"index_hash": "${idx.index_hash}",`,
    ' "applies": [{"provision_id": "...", "scope_quote": "<copied from the table>", "facts_needed": ["site.zone", "..."]}],',
    ' "excluded_at_index": [{"provision_id": "...", "scope_quote": "<copied from the table>"}],',
    ' "order": ["<every applied provision_id once: gates, then plan_constraints, then placement_constraints>"]}',
    "Every provision above appears in exactly one of applies / excluded_at_index. Exclude a gate, an operator-backed",
    "provision or one that modifies it only when one of its guards is known false on the case.",
  ];
  for (const l of idx.layers) for (const p of l.provisions)
    lines.push(`${p.provision_id} | ${p.type} | ${p.evaluation_stage} | ${p.has_operator} | ${p.modifies_operator_backed} | ${JSON.stringify(p.scope.scope_quote)}`);
  return [...lines, ...tail].join("\n");
}

/** One explicit next step, last in the prompt (recency). Code states the step; the model still makes the call and
 * code still checks it. CC, live S1: in a ~30k-token context the model never recorded a finding, though a small probe
 * showed it records correctly when the step is stated. */
export function renderNextStep(ledger: RunningLedger, openNotModeled = 0): string {
  const stages = ["gate", "plan_constraint", "placement_constraint"] as const;
  if (ledger.breaker.tripped && !(ledger.awaiting_finding ?? []).length) {
    return [
      "# Next Step",
      `The breaker tripped: ${ledger.breaker.stage} ${ledger.breaker.provision_id} failed (call ${ledger.breaker.call_id}). Placement checks are revoked; nothing else is evaluated for this plan.`,
      "Call conclude now, with selected_placement null and client_spot_passes null. Verdict rules: a failed gate → BLOCKED_BY_GATE;",
      "a failed plan constraint → NO_LEGS; but if the failing number rests on a gray area with two recorded readings, or on a fact",
      "that is conflicting or unknown, code will run sensitivity and may entail FITS_IF or NEEDS_CHECK instead — say so in the summary.",
    ].join("\n");
  }
  const stageOf = (pid: string) => stages.find((st) => ledger.agenda_by_stage[st].some((x) => x.provision_id === pid)) ?? "placement_constraint";
  const waiting = [...(ledger.awaiting_finding ?? [])].sort((a, b) => stages.indexOf(stageOf(a.provision_id)) - stages.indexOf(stageOf(b.provision_id)));
  if (waiting.length > 0) {
    const w = waiting[0]!;
    // A guard result names the clause it read; cite that one. Otherwise the family's first clause.
    let guardClause: string | undefined, outcome = "";
    try {
      const pr = JSON.parse(w.preview);
      if (w.tool === "evaluate_guards") {
        guardClause = pr.guards?.find((g: any) => g.holds === false)?.clause_id ?? pr.guards?.[0]?.clause_id;
        outcome = pr.result === "known_false" ? "not_applicable" : pr.result === "unknown" ? "" : "";
      } else if (typeof pr.pass === "boolean") outcome = pr.pass ? "pass" : "fail";
      else if (pr.pass === null && pr.too_close_to_call) outcome = "too_close_to_call";
    } catch { /* preview cut; fall back to the family's clauses */ }
    const fam = ledger.clause_table?.[w.provision_id] ?? [];
    const cl = (guardClause && fam.find((c) => c.clause_id === guardClause)) || fam[0];
    const clauseLine = guardClause && !cl
      ? ` and clause_ids ["${guardClause}"] (its quote: the clause text from read_rule_family ${w.provision_id}).`
      : cl ? ` and clause_ids ["${cl.clause_id}"], quote ${JSON.stringify(cl.quote.slice(0, 120))}.`
      : ` (read_rule_family ${w.provision_id} once to get its clause; do not re-read after that).`;
    const more = waiting.slice(1, 12).map((x) => `- ${x.provision_id} (${x.target}): ${x.tool} call_id=${x.call_id} → ${x.preview.slice(0, 160)}`);
    return [`# Next Step`,
      `Record ALL waiting findings in THIS turn: one record_finding call each, all in the same response.`,
      `First: record_finding for ${w.provision_id} (target ${w.target})${outcome ? `, outcome "${outcome}"` : ""}, citing evidence_call_ids ["${w.call_id}"]` + clauseLine,
      `Result to record: ${w.preview}`,
      ...(more.length ? ["Also record, in the same response (cite each call_id; clauses from the Clauses table):", ...more] : [])].join("\n");
  }
  for (const st of stages) {
    const open = ledger.agenda_by_stage[st].filter((x) => x.status === "pending");
    if (open.length > 0) {
      const hint = st === "gate" ? "evaluate_guards, then check_allowed if the guard does not rule it out"
        : st === "plan_constraint" ? "its plan-constraint tool (adu_max_living_area, check_max, footprint_dimensions)"
        : "its placement tool (check_setback, check_front_or_behind, coverage_share, total_building_coverage, find_placements)";
      return `# Next Step\nStage ${st}: in THIS turn, run the checks for ALL open provisions of this stage at once (several tool calls in one response), using ${hint}. Open: ${open.map((x) => x.provision_id).join(", ")}. Next turn you record all their findings together.`;
    }
  }
  const clientFails = ledger.findings.some((f) => f.target === "client_spot" && f.outcome === "fail");
  // Any searched placement that will be named in conclude needs every placement rule checked there (V1), whether or
  // not the client's spot failed (S4: the model picked a spot and never checked it). CC, 11-02.
  if (ledger.placement_search_run) {
    // V1: every placement provision needs a finding at the selected placement too.
    const placed = ledger.agenda_by_stage.placement_constraint.map((x) => x.provision_id);
    const missing = placed.filter((pid) => !ledger.findings.some((f) => f.provision_id === pid && f.target === "selected_placement"));
    if (missing.length > 0) {
      return `# Next Step\nPick the placement from the find_placements result (nearest_to_client unless it is not clear) and, in THIS turn, run the same placement checks at it with target "selected_placement" (outline {placed: <that placement>, footprint: {fact: "plan.footprint"}}) for ALL of: ${missing.join(", ")}. Next turn record all their findings together, then conclude with that selected_placement.`;
    }
  }
  if (clientFails && !ledger.placement_search_run) {
    return "# Next Step\nThe client's spot fails a placement rule. Before concluding, call find_placements (footprint {fact: \"plan.footprint\"}, setback_provisions = the setback provisions you evaluated) to search for a spot that passes; then check the selected placement (target selected_placement) and record those findings.";
  }
  return [
    "# Next Step",
    "Every agenda item has a finding. Call conclude with your verdict, summary, selected_placement and client_spot_passes.",
    "Verdict rules (code applies them; your verdict must match): a failed gate → BLOCKED_BY_GATE; a failed plan constraint → NO_LEGS;",
    "an unknown or too-close-to-call decisive result → NEEDS_CHECK; a decisive gray area with two recorded readings → FITS_IF;",
    "any applying clause that is not modeled and has no signed disposition → NEEDS_CHECK; a client spot that fails with a clear",
    "selected placement whose every margin passes → FITS (client_spot_passes false); no clear placement found → NO_LEGS.",
    `Open not-modeled clauses without a signed disposition on this case: ${openNotModeled}.`,
  ].join("\n");
}

export interface BuiltContext {
  messages: Array<{ role: "system" | "user"; content: string }>;
  ledger: RunningLedger;
  windowTurns: TurnWindowEntry[];
  rolledOffTurnCount: number;
  allowedTools: string[];
}

/**
 * Rebuilds the complete prompt context for a model call from the event log (§5).
 * Stable blocks come first (`system`: Role & Principles + Ontology + Phase Tool Contracts),
 * followed by dynamic case & ledger state (`user`: Case Summary + Running Ledger + Last 2 Turns).
 * Prior model reasoning is never included or re-sent.
 */
export function buildContextFromLog(opts: {
  phase: "plan" | "execute";
  kase: CaseType;
  events: LotFitEventType[];
  plan?: PlanType | null;
  indexStageMap?: Map<string, z.infer<typeof C.EvaluationStage>>;
  ruleFamiliesRead?: Map<string, RuleFamilyType>;
  breaker?: BreakerState;
  currentTurnCalls?: TurnWindowEntry["calls"];
  pendingRepairs?: RepairErrorType[];
  ontology?: Ontology;
  layerIndex?: z.infer<typeof C.LayerIndex> | null;
  openNotModeled?: number;
}): BuiltContext {
  const breaker = opts.breaker ?? { tripped: false };
  const allowedTools = allowedToolsForPhase(opts.phase, breaker, opts.kase.mode);

  const systemContent = [
    ROLE_AND_PRINCIPLES,
    "",
    renderOntologyPromptBlock(opts.ontology),
    "",
    renderPhaseToolContracts(opts.phase, breaker, opts.kase.mode),
  ].join("\n");

  const ledger = buildLedgerFromEvents(opts.events, {
    phase: opts.phase,
    plan: opts.plan,
    indexStageMap: opts.indexStageMap,
    ruleFamiliesRead: opts.ruleFamiliesRead,
    breaker,
  });

  const { windowTurns, rolledOffTurnCount } = extractLastTwoTurns(opts.events);

  const userContent = [
    renderCaseSummary(opts.kase),
    "",
    renderLedgerBlock(ledger),
    "",
    ...(opts.phase === "plan" && opts.layerIndex ? [renderIndexBlock(opts.layerIndex), ""] : []),
    renderWorkingWindowBlock(windowTurns, opts.currentTurnCalls ?? [], opts.pendingRepairs ?? []),
    ...(opts.phase === "execute" ? ["", renderNextStep(ledger, opts.openNotModeled ?? 0)] : []),
  ].join("\n");

  return {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    ledger,
    windowTurns,
    rolledOffTurnCount,
    allowedTools,
  };
}
