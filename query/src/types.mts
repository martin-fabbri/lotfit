// LotFit contracts C1–C9, executable. The single source of every shape that crosses a boundary between parts built
// by different hands (ARCHITECTURE.md §23; EXPLAINER-ARCHITECTURE.md Part 8). JSON Schema for Python and Muse's repo
// is emitted from here (`npm run contracts:emit`); fixtures prove each schema (`npm run contracts:test`).
//
// Rules this file enforces by type (each names the section of ARCHITECTURE.md round 4.1 it implements):
//   - the model never types a legal number: limits are ParamRef, never numbers (§0 rule 3, §7, V7)
//   - every finding and placement call names its target (§3 "Targets")
//   - every measuring tool returns one envelope with pass: true | false | null (§7)
//   - a run always ends with a verdict; abnormal ends are errors attached to a verdict (§3)
//   - LotFit's own events are namespaced `lotfit.*` and typed, never an untyped payload (§4)
//
// Versioning: each top-level contract carries `schema: "<name>/<major>"`. A breaking change bumps the major and is
// recorded as a note in the LotFit room; nothing changes silently once frozen.
import { z } from "zod";

export const CONTRACTS_VERSION = "1.5.0"; // 1.5.0 (additive, 2026-11-03, the Reviewer, CONTRACT-REVIEWER.md §4–§7, L42 hold): C10 ReviewItem, ReviewerAnswer, Report.reviewer (optional), events reviewer_completed and flag_resolved; Report.critic optional and deprecated; // 1.4.0 (additive, 2026-11-03, Reviewer preconditions P1–P3, CONTRACT-REVIEWER.md §1): event lotfit.exclusion_recorded (basis of every Planner exclusion), verdict_computed.reasons, OperatorBinding.partial; // 1.3.0 (additive, 2026-11-02, L40): Disposition kind covered_by_check, a not-modeled clause an operator's tool evaluated in this run; // 1.0.0 frozen 2026-11-01 (ACK-AG-CONTRACTS.md); 1.1.0 adds check_allowed (Martin, 2026-11-02, L32); 1.2.0 accepts EUG provision ids (Eugene, 2026-11-02)

// ------------------------------------------------------------------ common
export const Uuid7 = z.uuid({ version: "v7" });
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");
export const IsoDate = z.iso.date();
export const IsoDateTime = z.iso.datetime({ offset: true });
export const ProvisionId = z.string().regex(/^(OR|ORS|OAR|ORLAW|PDX|GRE|EUG)\.[A-Za-z0-9._\-]+$/, "a graph provision id");
export const ClauseId = z.string().min(3); // e.g. "PDX.33.110.245.C.2#v1::item:b.(6)"
export const FactName = z.string().regex(/^(site|plan)\.[a-z0-9_]+$/, "a registered fact name (curated/facts.json)");
export const Point = z.tuple([z.number(), z.number()]);
export const Line = z.tuple([Point, Point]);
export const Polygon = z.array(Point).min(3);
export const Placement = z.strictObject({ x: z.number(), y: z.number(), rotation: z.number().default(0) });

export const Verdict = z.enum(["FITS", "FITS_IF", "NO_LEGS", "BLOCKED_BY_GATE", "NEEDS_CHECK", "NOT_MODELED"]);
export const EvaluationStage = z.enum(["gate", "plan_constraint", "placement_constraint", "exception", "definition", "preemption"]);
export const Target = z.enum(["case", "client_spot", "selected_placement"]);
export const Outcome = z.enum(["pass", "fail", "not_applicable", "unknown", "too_close_to_call"]);
export const ErrorCategory = z.enum(["harness", "model", "tool", "database", "case"]);
export const Mode = z.enum(["check_spot", "find_spots", "propose"]);

// ------------------------------------------------------------------ C1 · Case (lotfit.case/1) §2
export const SourceKind = z.enum(["capture", "official_record", "plan_document", "owner_statement", "entered", "computed", "vision"]);
export const Tolerance = z.object({
  value: z.number().nonnegative(),
  unit: z.enum(["ft", "m", "sqft", "deg"]),
  at_range_m: z.number().positive().optional(), // τ is stated at the quantity's range (§14.3)
  method: z.string().optional(),                // e.g. "grade.json formula", "scan picking 0.08 m ⊕ τ(r)"
});
export const Provenance = z.object({
  kind: SourceKind,
  document: z.string().min(1),
  where: z.string().min(1),
  when: z.string().min(4),          // the date of the source; the validator (graph/model.py validate_input) reads `when`
  by: z.string().min(1),
  issuer: z.string().optional(),    // required for official_record
  tolerance: Tolerance.optional(),  // a tolerance or a status is required
  status: z.string().optional(),
  rests_on: z.string().optional(),  // required for entered geometry: the capture id or document it was read from
  role: z.string().optional(),
}).superRefine((p, ctx) => {
  if (p.tolerance === undefined && !p.status) ctx.addIssue({ code: "custom", message: "provenance needs a tolerance or a status (GR-22)" });
  if (p.kind === "official_record" && (!p.issuer || p.issuer.toLowerCase() === "owner" || p.role === "owner"))
    ctx.addIssue({ code: "custom", message: "an official record names its issuing agency and is never the owner's word" });
});
const KnownFact = z.object({ value: z.unknown(), prov: z.array(Provenance).min(1), status: z.enum(["known", "unconfirmed"]).default("known"),
  by_reading: z.record(z.string(), z.array(z.unknown()).min(2)).optional(), // per-ambiguity values, one per reading (I12; AG review 1.1)
});
const ConflictingFact = z.object({
  status: z.literal("conflicting").default("conflicting"), // existing data omits it: observations alone mean conflicting
  observations: z.array(z.object({ value: z.unknown(), prov: z.array(Provenance).min(1) })).min(2),
});
export const FactEntry = z.union([ConflictingFact, KnownFact]);
export const GEOMETRY_FACTS = ["site.lot_outline", "site.house_outline", "site.structures", "site.front_lot_line",
  "site.rear_lot_line", "site.side_lot_lines"] as const;

export const Case = z.object({
  schema: z.literal("lotfit.case/1"),
  case_id: Uuid7,
  as_of: z.strictObject({ date: IsoDate, meaning: z.enum(["planned_submittal", "submitted_on", "today"]) }),
  jurisdiction: z.strictObject({ state_layer: z.string(), city_layer: z.string() }),
  mode: Mode,
  capture: z.object({
    capture_id: z.string(), manifest_sha256: Sha256, grade: z.enum(["A", "B", "C", "fail"]),
    provisional: z.boolean().default(false),
    tolerances_95pct: z.object({ formula: z.string(), coefficients: z.record(z.string(), z.number()), reference_range_m: z.number() }),
    registration: z.object({ method: z.enum(["similarity_fit", "two_front_markers"]), translation_ft: Point, rotation_deg: z.number(),
      scale: z.number(), rms_residual_ft: z.number().nonnegative() }).optional(),
    north: z.object({ angle_deg: z.number(), uncertainty_deg: z.number().nonnegative() }).optional(),
  }).nullable(),
  parcel: z.object({ address: z.string(), parcel_id: z.string().optional(), prov: z.array(Provenance).min(1) }).optional(),
  context: z.object({ lat: z.number(), lon: z.number(), north_angle_deg: z.number().optional(), north_uncertainty_deg: z.number().optional(),
    house_height_ft: z.number().optional(), house_roof: z.string().optional() }).optional(),
  site: z.record(z.string().regex(/^[a-z0-9_]+$/), FactEntry),
  plan: z.record(z.string().regex(/^[a-z0-9_]+$/), FactEntry),
  unknowns: z.array(z.strictObject({ fact: FactName, reason: z.string().min(1) })).default([]),
}).superRefine((c, ctx) => {
  // entered geometry rests on a capture or document, by a named person (§2, D2)
  for (const full of GEOMETRY_FACTS) {
    const key = full.split(".")[1]!; const e = c.site[key];
    if (!e) continue;
    const provs = "observations" in e ? e.observations.flatMap(o => o.prov) : e.prov;
    for (const p of provs) if (p.kind === "entered" && !p.rests_on)
      ctx.addIssue({ code: "custom", path: ["site", key], message: "entered geometry needs rests_on (the capture or document it was read from)" });
  }
  // an unknown fact is absent from site/plan (I5, I11; AG review §3.2)
  for (const u of c.unknowns) { const [sc, k] = u.fact.split(".") as ["site" | "plan", string]; if (c[sc][k])
    ctx.addIssue({ code: "custom", path: ["unknowns"], message: `${u.fact} is listed as unknown and also given a value` }); }
  // check_spot carries exactly one client placement (I8)
  if (c.mode === "check_spot" && !c.plan["placement"]) ctx.addIssue({ code: "custom", path: ["plan", "placement"], message: "check_spot needs plan.placement" });
  if (c.mode !== "check_spot" && c.plan["placement"]) ctx.addIssue({ code: "custom", path: ["plan", "placement"], message: "only check_spot carries a placement" });
});
// Invariants checked by code (case gate), not expressible in a schema: I2 coverage, I3 jurisdiction in graph, I4 every key a
// registered fact of the right type and accepted source (graph/model.py validate_input), I5 required facts, I7 geometry
// (simple polygons, containment, lot lines on edges), I10 case hash, I12 by_reading present for an active ambiguity.
export const InvariantCode = z.enum(["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10", "I11", "I12"]);
export const CaseRefusal = z.strictObject({ case_id: z.string(), refused: z.literal(true), invariant: InvariantCode, message: z.string(), path: z.string().optional() });
export const COMPUTED_FACTS = ["site.zone_family", "site.lot_area_sqft", "site.house_rear_wall", "plan.outline", "plan.setbacks_used"] as const;

// ------------------------------------------------------------------ C2 · Graph read §6, explainer Part 4A
export const ReadingGuide = z.strictObject({ id: z.string(), version: z.string(), text: z.string().min(1) });
export const IndexEntry = z.strictObject({
  provision_id: ProvisionId, layer: z.string(), type: z.string(), evaluation_stage: EvaluationStage,
  title: z.string(), section: z.string().nullable(), param_names: z.array(z.string()), gray_areas: z.number().int().nonnegative(),
  scope: z.strictObject({ applies_to_zones: z.array(z.string()), project_kinds: z.array(z.string()), scope_clause_id: ClauseId,
    scope_quote: z.string().min(1), source: z.enum(["graph", "curated"]),
    // Build-review A1 (1.5.0, additive): how the scope clause was found. "stated": the graph's applies_to/zones quote
    // matched a clause; "curated": a signed override (index-scope.json); "guessed": no stated scope, the first clause
    // (or the first guarded one) stands in. Only a stated or curated scope clause's guards can rule the provision out.
    basis: z.enum(["stated", "curated", "guessed"]).optional() }),
  in_force: z.strictObject({ from: IsoDate.nullable(), to: IsoDate.nullable(), date_not_stated: z.boolean() }),
  has_operator: z.boolean(), modifies_operator_backed: z.boolean(),
});
export const LayerIndex = z.strictObject({
  graph_load_id: z.string(), as_of: IsoDate, index_hash: Sha256,
  layers: z.array(z.strictObject({ layer: z.string(), order: z.number().int(), provisions: z.array(IndexEntry) })).min(1),
});
export const Parameter = z.strictObject({ param_id: z.string(), provision_id: ProvisionId, name: z.string(), value: z.union([z.number(), z.string()]),
  unit: z.string().nullable(), quote: z.string(), clause_id: ClauseId.nullable() });
export const Disposition = z.strictObject({ kind: z.enum(["inert_for", "needs_fact", "covered_by_check"]), scope: z.string().optional(), fact: FactName.optional(),
  reason: z.string(), by: z.string(), date: IsoDate });
export const ClauseLedgerEntry = z.strictObject({ clause_id: ClauseId, kind: z.string(), quote: z.string(), modeled: z.boolean(),
  guards: z.array(z.strictObject({ fact: FactName, op: z.string(), value: z.unknown().optional() })), disposition: Disposition.nullable(),
  // AG5 (1.5.0, additive): the facts the clause's words point at (the ingest lexicon), whether or not they guard it.
  needs: z.array(FactName).optional() });
export const RuleFamily = z.strictObject({
  provision_id: ProvisionId, version_id: z.string(), sha256: Sha256, evaluation_stage: EvaluationStage,
  params: z.array(Parameter), cells: z.array(z.strictObject({ cell_id: z.string(), table: z.string(), row: z.string(), column: z.string(), text: z.string() })),
  clauses: z.array(ClauseLedgerEntry),
  readings: z.array(z.strictObject({ ambiguity_id: z.string(), phrase: z.string(), readings: z.array(z.string()).min(2), settled_by: z.string() })),
  gray_area_effects: z.array(z.strictObject({ ambiguity_id: z.string(), fact: FactName.optional(), provision_id: ProvisionId.optional(), param: z.string().optional() })),
  operators: z.array(z.strictObject({ operator_id: z.string(), tool: z.string() })),
  modified_by: z.array(ProvisionId), preempted_by: z.array(ProvisionId), uses_definitions: z.array(ProvisionId),
});
export const QueryOutcome = z.enum(["ok", "truncated", "guard_rejected", "db_error", "empty", "empty_after_diagnosis"]);
export const QueryRequest = z.strictObject({ question: z.string().min(5), cypher: z.string().min(10), params: z.record(z.string(), z.unknown()).default({}) });
export const Diagnosis = z.strictObject({
  parts: z.array(z.strictObject({ pattern: z.string(), count: z.number().int().nonnegative() })).min(1),
  first_zero: z.number().int().nonnegative().nullable(), // index into parts, or null when every part matches but the join does not
  nearest_values: z.array(z.strictObject({ property: z.string(), values: z.array(z.string()) })).default([]),
});
export const QueryResult = z.strictObject({
  outcome: QueryOutcome, attempt: z.union([z.literal(1), z.literal(2)]),
  rows: z.array(z.record(z.string(), z.unknown())).max(50).default([]), total: z.number().int().nonnegative().optional(),
  guard_reason: z.string().optional(), db_error: z.string().optional(), ontology_snippet: z.string().optional(),
  diagnosis: Diagnosis.optional(), profile_db_hits: z.number().int().nonnegative().optional(),
}).superRefine((r, ctx) => {
  const need = (k: keyof typeof r, when: string) => { if (r.outcome === when && r[k] === undefined) ctx.addIssue({ code: "custom", message: `${when} needs ${String(k)}` }); };
  need("guard_reason", "guard_rejected"); need("db_error", "db_error"); need("diagnosis", "empty"); need("diagnosis", "empty_after_diagnosis"); need("total", "truncated");
});

// ------------------------------------------------------------------ C3 · Tools §7
export const ParamRef = z.strictObject({ provision_id: ProvisionId, param: z.string() });       // what the model writes
export const ResolvedParam = ParamRef.extend({ value: z.number(), unit: z.string() });          // what the harness supplies
export const CellRef = z.strictObject({ provision_id: ProvisionId, cell_id: z.string() });
export const FactRef = z.strictObject({ fact: FactName });                                     // geometry and values by handle (§5)
export const CallRef = z.strictObject({ call_id: Uuid7, path: z.string() });                    // a number taken from an earlier result
export const Geom = z.union([FactRef, z.strictObject({ placed: Placement, footprint: FactRef })]);

/** Every call that evaluates a provision names it and its target (§3 step 2); the model passes them in the arguments. */
const Eval = { provision_id: ProvisionId, target: Target };
export const TOOL_ARGS = {
  read_reading_guide: z.strictObject({}),
  read_layer_index: z.strictObject({ city_layer: z.string(), as_of: IsoDate }),
  read_rule_family: z.strictObject({ provision_ids: z.array(ProvisionId).min(1).max(12), as_of: IsoDate }),
  query_code_graph: QueryRequest,
  inspect_case_facts: z.strictObject({ facts: z.array(FactName).optional() }),
  evaluate_guards: z.strictObject({ provision_id: ProvisionId, target: Target }),
  // 1.1.0 (L32): a gate passes or fails through a result, not through its guards. Reads the "allowed" cell for the
  // case's zone (e.g. Table 110-2, use "accessory_dwelling_unit_see_chapter_33_205") → MeasureResult, pass = allowed.
  check_allowed: z.strictObject({ ...Eval, use: z.string().min(1), zone: FactRef }),
  adu_max_living_area: z.strictObject({ ...Eval, primary_living_area: FactRef, plan_living_area: FactRef, share: ParamRef, cap: ParamRef }),
  check_max: z.strictObject({ ...Eval, value: z.union([FactRef, CallRef]), limit: ParamRef }),
  footprint_dimensions: z.strictObject({ ...Eval, outline: Geom, limit: ParamRef }),
  coverage_share: z.strictObject({ ...Eval, outlines: z.array(Geom).min(1), lot_area: FactRef, limit: ParamRef }),
  placed_outline: z.strictObject({ ...Eval, footprint: FactRef, placement: Placement }),
  physical_fit: z.strictObject({ ...Eval, outline: Geom }),
  distance_to_line: z.strictObject({ ...Eval, outline: Geom, line: FactRef }),
  check_setback: z.strictObject({ ...Eval, outline: Geom, lines: FactRef, min: ParamRef }),
  check_front_or_behind: z.strictObject({ ...Eval, outline: Geom, front_lot_line: FactRef, min_front: ParamRef, house_rear_wall: FactRef }),
  total_building_coverage: z.strictObject({ ...Eval, outlines: z.array(Geom).min(1), lot_area: FactRef, cap_cell: CellRef }),
  check_exception_conditions: z.strictObject({ ...Eval, exception_id: ProvisionId, base_provision_id: ProvisionId, outline: Geom }),
  find_placements: z.strictObject({ ...Eval, footprint: FactRef, rotations: z.array(z.number()).default([0, 90]), setback_provisions: z.array(ProvisionId).min(1) }),
  check_solar_shadow: z.strictObject({ ...Eval, outline: Geom }),
} as const;
export const ToolName = z.enum(Object.keys(TOOL_ARGS) as [keyof typeof TOOL_ARGS, ...(keyof typeof TOOL_ARGS)[]]);
export const LEDGER_TOOLS = ["record_finding", "conclude"] as const; // C4; 20 + 2 = 22 tools (§7; check_allowed added in 1.1.0)

/** The one envelope every measuring tool returns (§7). pass is null when |margin| < tolerance. */
export const MeasureResult = z.strictObject({
  value: z.number(), unit: z.string(), limit: ResolvedParam.nullable(),
  margin: z.number(),                 // negative = violation
  tolerance: z.number().nonnegative(), pass: z.boolean().nullable(), too_close_to_call: z.boolean(),
  dimension_to_tape: z.string().nullable(), details: z.record(z.string(), z.unknown()).optional(),
}).superRefine((r, ctx) => {
  const tcc = Math.abs(r.margin) < r.tolerance - 1e-9; // same epsilon as graph/tools (d >= min - 1e-9)
  if (tcc !== r.too_close_to_call) ctx.addIssue({ code: "custom", message: "too_close_to_call must equal |margin| < tolerance" });
  if (tcc && r.pass !== null) ctx.addIssue({ code: "custom", message: "pass must be null when too close to call" });
  if (!tcc && r.pass !== (r.margin >= 0)) ctx.addIssue({ code: "custom", message: "pass must agree with the sign of margin" });
  if (tcc && !r.dimension_to_tape) ctx.addIssue({ code: "custom", message: "too close to call names the dimension to tape" });
});
export const GuardResult = z.strictObject({ provision_id: ProvisionId, result: z.enum(["known_true", "known_false", "unknown"]),
  guards: z.array(z.strictObject({ clause_id: ClauseId, fact: FactName, value: z.unknown().nullable(), holds: z.boolean().nullable() })) });
/** check_exception_conditions: three-valued AND over the exception's conditions (EN-17); numeric conditions carry a MeasureResult. */
export const ExceptionResult = z.strictObject({
  exception_id: ProvisionId, base_provision_id: ProvisionId, pass: z.boolean().nullable(),
  conditions: z.array(z.strictObject({ clause_id: ClauseId, name: z.string(), holds: z.boolean().nullable(), measure: MeasureResult.nullable().default(null), reason: z.string().optional() })).min(1),
}).superRefine((r, ctx) => {
  const h = r.conditions.map(c => c.holds), want = h.includes(false) ? false : h.includes(null) ? null : true;
  if (r.pass !== want) ctx.addIssue({ code: "custom", message: "pass must be the three-valued AND of the conditions" });
});
export const PlacementSearchResult = z.strictObject({
  count: z.number().int().nonnegative(), clear_count: z.number().int().nonnegative(), // clear = every margin ≥ τ
  client_spot: z.strictObject({ passes: z.boolean().nullable(), failing: z.array(ProvisionId) }).nullable(),
  nearest_to_client: Placement.nullable(), max_clearance: Placement.nullable(),
  envelope_artifact: z.string().nullable(), // full candidates stay in L2 (§5)
});

export const ToolCall = z.strictObject({ call_id: Uuid7, turn_id: Uuid7, provision_id: ProvisionId.nullable(), target: Target,
  tool: z.union([ToolName, z.enum(LEDGER_TOOLS)]), // ledger tools run in TypeScript and never cross the bridge
  args: z.record(z.string(), z.unknown()) });
/** Bridge: the harness (TypeScript) ↔ the tools (Python), over stdio locally and HTTP on Vercel (§7). Args are resolved. */
export const BridgeRequest = z.strictObject({
  config_hash: Sha256,
  batch: z.array(z.strictObject({ call_id: Uuid7, provision_id: ProvisionId.nullable(), target: Target, tool: ToolName, args: z.record(z.string(), z.unknown()) })).min(1),
});
export const BridgeResponse = z.strictObject({
  impl_digest: Sha256, // git tree hash of graph/tools + the runner; part of config_hash (§4)
  results: z.array(z.discriminatedUnion("ok", [
    z.strictObject({ call_id: Uuid7, ok: z.literal(true), result: z.unknown(), duration_ms: z.number().nonnegative() }),
    z.strictObject({ call_id: Uuid7, ok: z.literal(false), error: z.strictObject({ category: ErrorCategory, message: z.string() }) }),
  ])),
});

// ------------------------------------------------------------------ C4 · Model outputs §3
export const Plan = z.strictObject({
  index_hash: Sha256,
  applies: z.array(z.strictObject({ provision_id: ProvisionId, scope_quote: z.string().min(1), facts_needed: z.array(FactName).default([]) })),
  excluded_at_index: z.array(z.strictObject({ provision_id: ProvisionId, scope_quote: z.string().min(1) })),
  order: z.array(ProvisionId),
}).superRefine((p, ctx) => {
  const a = new Set(p.applies.map(x => x.provision_id)), e = new Set(p.excluded_at_index.map(x => x.provision_id));
  for (const id of a) if (e.has(id)) ctx.addIssue({ code: "custom", message: `${id} is both applied and excluded` });
  for (const id of p.order) if (!a.has(id)) ctx.addIssue({ code: "custom", message: `order names ${id}, which is not applied` });
  if (p.order.length !== a.size || new Set(p.order).size !== a.size) ctx.addIssue({ code: "custom", message: "order is a permutation of the applied provisions" });
});
// Validated by code against the index (not expressible here): partition complete; quotes are substrings of the index;
// no exclusion of a gate, an operator-backed provision or one modifying it unless a guard is known false (§3 step 1).
export const RecordFinding = z.strictObject({
  provision_id: ProvisionId, target: Target, clause_ids: z.array(ClauseId).min(1), outcome: Outcome,
  evidence_call_ids: z.array(Uuid7).min(1), // not_applicable cites its evaluate_guards call (V8)
  numbers: z.array(z.strictObject({ value: z.number(), unit: z.string(), call_id: Uuid7, path: z.string() })).default([]),
  quotes: z.array(z.strictObject({ clause_id: ClauseId, quote: z.string().min(1) })).min(1),
  note: z.string().max(400).optional(),
});
export const Conclude = z.strictObject({
  verdict: Verdict, summary: z.string().min(1).max(1200),
  selected_placement: Placement.nullable(), client_spot_passes: z.boolean().nullable(),
});
export const RepairCode = z.enum(["PLAN_INCOMPLETE", "PLAN_QUOTE_NOT_IN_INDEX", "PLAN_FORBIDDEN_EXCLUSION", "PLAN_UNKNOWN_ID",
  "V1_COVERAGE", "V2_EVIDENCE", "V3_OUTCOME", "V4_NUMBER", "V5_VERDICT", "V6_GEOMETRY", "V7_PARAMETER", "V8_GUARD", "SCHEMA"]);
export const RepairError = z.strictObject({ code: RepairCode, provision_id: ProvisionId.optional(), target: Target.optional(), message: z.string(), detail: z.unknown().optional() });

// ------------------------------------------------------------------ C5 · Sensitivity and questions §3 steps 3, 5
export const Branch = z.strictObject({
  fact: FactName,
  assignment: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unconfirmed"), value: z.unknown() }),
    z.strictObject({ kind: z.literal("unknown"), value: z.unknown() }),
    z.strictObject({ kind: z.literal("observation"), index: z.number().int().nonnegative() }),
    z.strictObject({ kind: z.literal("tolerance"), delta: z.number() }),
    z.strictObject({ kind: z.literal("reading"), ambiguity_id: z.string(), index: z.number().int().nonnegative() }),
  ]),
  verdict: Verdict, client_spot_passes: z.boolean().nullable(),
  findings_delta: z.array(z.strictObject({ provision_id: ProvisionId, target: Target, from: Outcome, to: Outcome })),
});
export const Sensitivity = z.strictObject({
  nominal_verdict: Verdict, branches: z.array(Branch),
  critical: z.array(z.strictObject({ fact: FactName, impact: z.number().min(0).max(1) })),
  untested: z.array(z.strictObject({ fact: FactName, reason: z.string() })), // beyond the cap (§3 budgets)
});
const DECIDED = new Set(["FITS", "NO_LEGS", "BLOCKED_BY_GATE"]);
export const Question = z.strictObject({
  question_id: Uuid7, fact: FactName, prompt: z.string().min(5), clause_id: ClauseId.nullable(), who_can_settle: z.string(),
  answers: z.array(z.strictObject({ label: z.string(), value: z.unknown(), verdict: Verdict })).min(2),
  skip: z.strictObject({ assumed_value: z.unknown(), verdict: Verdict }),
}).superRefine((q, ctx) => {
  if (!q.answers.some(a => DECIDED.has(a.verdict))) ctx.addIssue({ code: "custom", message: "a question is eligible only if some answer yields a decided verdict" });
  if (new Set(q.answers.map(a => a.verdict)).size < 2) ctx.addIssue({ code: "custom", message: "a question is asked only if the answers flip the verdict" });
});
export const QuestionSet = z.array(Question).max(3);
export const Answer = z.strictObject({ question_id: Uuid7, value: z.unknown(), by: z.string().min(1), when: IsoDateTime, role: z.string() });

// ------------------------------------------------------------------ C6 · Events §4 (exo-aligned, typed)
export const UsageRecord = z.strictObject({
  model: z.string(), prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(),
  prompt_cached_tokens: z.number().int().nonnegative().optional(), prompt_cache_creation_tokens: z.number().int().nonnegative().optional(),
  completion_reasoning_tokens: z.number().int().nonnegative().optional(), cost_usd: z.number().nonnegative().optional(),
  ttft_ms: z.number().nonnegative().optional(), duration_ms: z.number().nonnegative().optional(),
});
export const ArtifactRef = z.strictObject({ artifact_id: Uuid7, path: z.string(), version: z.number().int().positive(), sha256: Sha256,
  created_at: IsoDateTime, size_bytes: z.number().int().nonnegative(), scope: z.enum(["case", "institutional"]) });
export const ConfigManifest = z.strictObject({
  prompt_sha256: Sha256, ontology_sha256: Sha256, tool_contracts_sha256: Sha256, tools_tree: z.string(), slice_sha256: Sha256,
  index_scope_sha256: Sha256, confirmations_sha256: Sha256, budgets: z.strictObject({ turns: z.number().int(), calls: z.number().int(),
    tokens: z.number().int(), seconds_plan_execute: z.number(), seconds_total: z.number() }),
  tau_policy: z.string(), models: z.record(z.string(), z.string()), provider_route: z.string(),
}); // config_hash = sha256 of the canonical JSON of this manifest
const base = { id: Uuid7, thread_id: Uuid7, session_id: Uuid7.nullable(), turn_id: Uuid7.nullable(), seq: z.number().int().nonnegative(),
  created_at: IsoDateTime, config_hash: Sha256, graph_load_id: z.string() };
const ev = <T extends string, S extends z.ZodRawShape>(type: T, data: S) => z.strictObject({ ...base, type: z.literal(type), data: z.strictObject(data) });
export const LotFitEvent = z.discriminatedUnion("type", [
  ev("thread_created", { case_hash: Sha256, case_artifact: ArtifactRef }),
  ev("thread_forked", { source_thread_id: Uuid7, up_to_inclusive: Uuid7, reason: z.enum(["answer", "alternative_plan"]) }),
  ev("turn_started", { phase: z.enum(["plan", "execute", "sensitivity", "verdict", "ask", "verify", "propose"]), input_summary: z.string() }),
  ev("messages", { role: z.enum(["assistant", "user", "system"]), content_artifact: ArtifactRef.optional(), usage: UsageRecord }),
  ev("tool_requested", { call: ToolCall }),
  ev("tool_result", { call_id: Uuid7, cached: z.boolean(), ok: z.boolean(), result_artifact: ArtifactRef.optional(), preview: z.string().max(2000),
    error: z.strictObject({ category: ErrorCategory, message: z.string() }).optional(), duration_ms: z.number().nonnegative() }),
  ev("artifact_written", { artifact: ArtifactRef }),
  ev("turn_ended", { status: z.enum(["ok", "repair", "abnormal"]) }),
  ev("error", { category: ErrorCategory, code: z.string(), message: z.string(), metadata: z.record(z.string(), z.unknown()).default({}) }),
  ev("lotfit.plan_written", { plan_artifact: ArtifactRef, valid: z.boolean(), repairs: z.array(RepairError) }),
  ev("lotfit.finding_recorded", { finding: RecordFinding, accepted: z.boolean(), repairs: z.array(RepairError) }),
  ev("lotfit.sensitivity_completed", { sensitivity_artifact: ArtifactRef, critical: z.number().int().nonnegative(), model_turns: z.literal(0) }),
  ev("lotfit.verifier_completed", { passed: z.boolean(), issues: z.array(RepairError), critic_objections: z.number().int().nonnegative() }),
  ev("lotfit.ledger_compacted", { ledger_artifact: ArtifactRef, trigger: z.enum(["window", "phase", "breaker"]) }),
  ev("lotfit.verdict_computed", { entailed: Verdict, proposed: Verdict.nullable(), agree: z.boolean(), abnormal_end: z.boolean(),
    reasons: z.array(z.string()).default([]) }), // 1.4.0: why code entails the verdict (P2)
  // 1.4.0 (P1, P2): one per exclusion in the accepted Plan. Only computed_known_false and through_operator are computed;
  // planner_reading is the Planner's reading of the scope sentence and is never recorded as a guard result (SPEC 3, 14; L38).
  ev("lotfit.reviewer_completed", { status: z.enum(["clean", "flagged", "partial", "not_run"]), model: z.string(), items: z.number().int().nonnegative(),
    answered: z.number().int().nonnegative().optional(),
    flags_high: z.number().int().nonnegative(), flags_medium: z.number().int().nonnegative(), flags_low: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), hold: z.boolean(), usage: z.array(UsageRecord) }),
  ev("lotfit.flag_resolved", { flag_id: Uuid7, by: z.string().min(1), role: z.string().min(1), when: IsoDateTime,
    action: z.enum(["dismissed", "fact_corrected", "rulebook_change", "rerun_requested"]), note: z.string().min(1), fork_thread_id: Uuid7.nullable(),
    // Build-review A3/S7: an agent closing a hold names the person whose delegation it acts on, exactly as on people.json.
    on_behalf_of: z.string().min(1).nullable().optional() }),
  ev("lotfit.exclusion_recorded", { provision_id: ProvisionId, basis: z.enum(["computed_known_false", "through_operator", "planner_reading"]),
    guard_call_id: Uuid7.nullable(), guard_result: z.enum(["known_true", "known_false", "unknown"]).nullable(), through: ProvisionId.nullable(),
    scope_clause_id: ClauseId, scope_quote: z.string().min(1) }),
]);

// ------------------------------------------------------------------ C10 · Reviewer (CONTRACT-REVIEWER.md, 1.5.0)
/** Categories only grow: never removed or renamed; a rubric version may disable one (EN-24 "its rubric only grows"). */
export const FlagCategory = z.enum(["exclusion_on_unknown_fact", "wrong_exclusion", "scope_sentence_not_scope",
  "wrong_parameter", "wrong_fact_or_line", "ignored_exception_condition", "unknown_treated_as_no", "open_clause_bites",
  "inconsistent_reading", "misread_definition", "verdict_rests_on_unexamined", "partial_check", "preempted_by_state", "definition_wrong_layer"]);
export const FactStatus = z.enum(["absent", "unknown", "unconfirmed", "conflicting", "true", "false", "known"]);
export const ReviewItem = z.strictObject({
  schema: z.literal("lotfit.review-item/1"), item_sha256: Sha256,
  run: z.strictObject({ thread_id: Uuid7, graph_load_id: z.string(), config_hash: Sha256, as_of: IsoDate }),
  provision: z.strictObject({ provision_id: ProvisionId, title: z.string(), section: z.string().nullable(), type: z.string(), evaluation_stage: EvaluationStage,
    zones: z.array(z.string()), project_kinds: z.array(z.string()) }),
  scope: z.strictObject({ clause_id: ClauseId, quote: z.string().min(1) }),
  text: z.array(z.strictObject({ clause_id: ClauseId, quote: z.string() })).max(30),
  exclusion: z.strictObject({ basis: z.enum(["computed_known_false", "through_operator", "planner_reading"]), planner_quote: z.string() }),
  // Build-review S19: the text is cut at 30 clauses; the cut is recorded. A13/S10: a person's signed disposition on the
  // scope clause, when the exclusion relies on it, travels with the item.
  text_truncated: z.boolean().optional(),
  // Build-review R2-1: the facts the rule's own guards read. A flag is confirmed only on one of these.
  rule_facts: z.array(z.string()).optional(),
  dispositions_relied_on: z.array(z.strictObject({ clause_id: ClauseId, disposition: Disposition })).optional(),
  case_facts: z.array(z.strictObject({ fact: z.string(), value: z.unknown().optional(), status: FactStatus })),
  rubric: z.strictObject({ id: z.string(), version: z.string(), sha256: Sha256 }),
});
export const ReviewerAnswer = z.strictObject({
  item_sha256: Sha256, answer: z.enum(["sound", "unsound", "unclear"]), category: FlagCategory.nullable(),
  quote: z.string(), fact: z.string().nullable(), fact_claim: FactStatus.nullable(), claim: z.string().max(300),
}).superRefine((a, ctx) => {
  if (a.answer === "sound" && a.category !== null) ctx.addIssue({ code: "custom", message: "a sound answer carries no category" });
  if (a.answer === "unsound" && a.category === null) ctx.addIssue({ code: "custom", message: "an unsound answer names its category" });
  if ((a.fact === null) !== (a.fact_claim === null)) ctx.addIssue({ code: "custom", message: "fact and fact_claim come together" });
});
export const RejectReason = z.enum(["bad_schema", "quote_not_in_item", "fact_claim_false", "category_disabled", "out_of_authority", "no_answer"]);
export const Severity = z.enum(["high", "medium", "low"]);
export const ReviewFlag = z.strictObject({ flag_id: Uuid7, provision_id: ProvisionId, category: FlagCategory, severity: Severity, confirmed: z.boolean(),
  quote: z.string(), fact: z.string().nullable(), fact_claim: FactStatus.nullable(), claim: z.string(), item_sha256: Sha256,
  route: z.enum(["hold_if_fits", "attach", "rulebook_queue"]) });
export const ReviewOutcome = z.strictObject({
  // Build-review A2/S2/S5: "clean" only when every item has an accepted answer; "partial" when some items have none
  // (a partial review may still hold: a confirmed high flag is not dropped because another item went unanswered).
  status: z.enum(["clean", "flagged", "partial", "not_run"]),
  answered: z.number().int().nonnegative().optional(),
  warnings: z.array(z.strictObject({ provision_id: ProvisionId.nullable(), detail: z.string() })).optional(),
  model: z.string(), rubric: z.strictObject({ id: z.string(), version: z.string(), sha256: Sha256 }), items: z.number().int().nonnegative(),
  flags: z.array(ReviewFlag), sound: z.array(ProvisionId), unclear: z.array(ProvisionId),
  rejected: z.array(z.strictObject({ provision_id: ProvisionId.nullable(), raw: z.unknown(), reason: RejectReason, detail: z.string().optional() })),
  hold: z.boolean(),
  error: z.strictObject({ category: ErrorCategory, message: z.string() }).nullable(),
  usage: z.array(UsageRecord),
}).superRefine((r, ctx) => {
  if (r.status === "clean" && (r.flags.length || r.error)) ctx.addIssue({ code: "custom", message: "clean means no flags and no error" });
  if (r.status === "clean" && r.answered !== undefined && r.answered !== r.items) ctx.addIssue({ code: "custom", message: "clean means every item was answered" });
  if (r.status === "partial" && (r.answered === undefined || r.answered >= r.items || r.answered === 0)) ctx.addIssue({ code: "custom", message: "partial means some, not all, items were answered" });
  if (r.status === "flagged" && !r.flags.length) ctx.addIssue({ code: "custom", message: "flagged means at least one flag" });
  if (r.status === "not_run" && (!r.error || r.flags.length || r.hold)) ctx.addIssue({ code: "custom", message: "not_run carries its error, no flags and no hold" });
  if (r.hold && !r.flags.some((f) => f.severity === "high" && f.confirmed && f.route === "hold_if_fits"))
    ctx.addIssue({ code: "custom", message: "a hold needs a confirmed high flag routed to hold (B6)" });
});

// ------------------------------------------------------------------ C7 · Report (lotfit.evaluation-report/1) §13
export const Citation = z.strictObject({ document: z.string(), page: z.string().nullable(), clause_id: ClauseId, quote: z.string().min(1), sha256: Sha256 });
export const ReportFinding = z.strictObject({
  provision_id: ProvisionId, target: Target, outcome: Outcome, evaluation_stage: EvaluationStage,
  citations: z.array(Citation).min(1), params: z.array(ResolvedParam), measures: z.array(MeasureResult),
  confirmation: z.enum(["confirmed", "unconfirmed", "assumed"]), evidence_call_ids: z.array(Uuid7).min(1),
});
export const Report = z.strictObject({
  schema: z.literal("lotfit.evaluation-report/1"),
  case_id: Uuid7, case_hash: Sha256, graph_load_id: z.string(), config_hash: Sha256,
  as_of: z.strictObject({ date: IsoDate, meaning: z.enum(["planned_submittal", "submitted_on", "today"]) }),
  verdict: Verdict, model_verdict: Verdict.nullable(), verdict_note: z.string().nullable(),
  banner: z.string().min(1), // WK-07 pre-feasibility banner
  plan_limit: ResolvedParam.nullable(), // set when a plan constraint failed: "max living area 525 sq ft"
  placement: z.strictObject({
    client_spot: z.strictObject({ placement: Placement, passes: z.boolean().nullable(), failing: z.array(ProvisionId), rejected_exceptions: z.array(ProvisionId) }).nullable(),
    recommended: z.strictObject({ placement: Placement, margins: z.array(MeasureResult), solar: z.record(z.string(), z.unknown()).nullable() }).nullable(),
    search: PlacementSearchResult.nullable(),
  }),
  findings: z.array(ReportFinding),
  dispositions_relied_on: z.array(z.strictObject({ clause_id: ClauseId, disposition: Disposition })),
  conflicts: z.array(z.strictObject({ fact: FactName, observations: z.array(z.unknown()).min(2) })),
  assumptions: z.array(z.strictObject({ fact: FactName, value: z.unknown(), flips: z.boolean() })),
  conditions: z.array(z.strictObject({ ambiguity_id: z.string(), provision_id: ProvisionId, phrase: z.string(),
    readings: z.array(z.strictObject({ index: z.number().int().nonnegative(), reading: z.string(), value: z.unknown().optional(), verdict: Verdict })).min(2),
    settled_by: z.string() })).default([]), // the gray areas a FITS_IF rests on
  questions: QuestionSet,
  not_found: z.array(z.strictObject({ question: z.string(), cypher: z.string(), diagnosis: Diagnosis })),
  unchecked: z.array(z.strictObject({ provision_id: ProvisionId, clause_id: ClauseId.nullable(), reason: z.string() })),
  verifier: z.strictObject({ passed: z.boolean(), issues: z.array(RepairError) }),
  critic: z.strictObject({ model: z.string(), objections: z.array(z.strictObject({ severity: z.enum(["low", "medium", "high"]), provision_id: ProvisionId,
    category: z.enum(["wrong_parameter", "waved_unmodeled_clause", "ignored_exception_condition", "misread_definition"]), quote: z.string() })) }).nullable().optional(), // deprecated (1.5.0): see reviewer
  reviewer: ReviewOutcome.optional(), // 1.5.0; absent on reports made before it
  telemetry: z.strictObject({ tokens: z.number().int(), calls: z.number().int(), turns: z.number().int(), wall_s_plan_execute: z.number(), wall_s_total: z.number(),
    cost_usd: z.number(), models: z.record(z.string(), z.string()) }),
}).superRefine((r, ctx) => {
  if (r.verdict === "FITS" && !r.placement.recommended) ctx.addIssue({ code: "custom", message: "FITS needs a recommended placement" });
  if (r.verdict === "FITS" && r.placement.recommended && (!r.placement.recommended.margins.length || r.placement.recommended.margins.some(m => m.pass !== true)))
    ctx.addIssue({ code: "custom", message: "FITS needs every margin of the selected placement ≥ τ (and at least one margin)" });
  if (r.verdict === "FITS" && r.unchecked.length) ctx.addIssue({ code: "custom", message: "FITS carries no unchecked clause" });
  if (r.verdict === "FITS_IF" && !r.conditions.length) ctx.addIssue({ code: "custom", message: "FITS_IF names the gray-area conditions it rests on" });
  if (r.verdict === "FITS" && r.questions.length) ctx.addIssue({ code: "custom", message: "FITS carries no open question" });
  if (r.reviewer?.hold && r.verdict !== "FITS" && r.verdict !== "FITS_IF") ctx.addIssue({ code: "custom", message: "a hold applies only to FITS or FITS_IF (L42)" });
  // Reviewer D9 (ADV-6): and the other way: a FITS or FITS_IF with a confirmed high flag routed to hold is held
  if ((r.verdict === "FITS" || r.verdict === "FITS_IF") && r.reviewer && !r.reviewer.hold && r.reviewer.flags.some((f) => f.severity === "high" && f.confirmed && f.route === "hold_if_fits"))
    ctx.addIssue({ code: "custom", message: "a FITS or FITS_IF with a confirmed high flag routed to hold must be held (L42)" });
});

// ------------------------------------------------------------------ C8 · Trace (buildnexus.decision-trace/1) and narration §13
export const Trace = z.strictObject({
  schema: z.literal("buildnexus.decision-trace/1"),
  report_sha256: Sha256,
  frame: z.strictObject({ origin: z.literal("front-left"), x: z.literal("along the front lot line"), y: z.literal("to the rear"), z: z.literal("up"),
    units: z.literal("ft"), three: z.strictObject({ X: z.literal("x"), Y: z.literal("z"), Z: z.literal("-y") }) }),
  site: z.strictObject({ lot: Polygon, north_deg: z.number().nullable(), north_uncertainty_deg: z.number().nullable(),
    existing: z.array(z.strictObject({ id: z.string(), kind: z.string(), outline: Polygon, height_ft: z.number().nullable() })) }),
  constraints: z.array(z.strictObject({ provision_id: ProvisionId, kind: z.string(), zone: Polygon.nullable(), value: z.number().nullable(), unit: z.string().nullable(),
    outcome: Outcome.optional(), measures: z.array(MeasureResult).default([]) })), // case-level findings and their margins (F13)
  options: z.array(z.strictObject({ id: z.string(), status: z.enum(["selected", "conditional", "rejected"]), placement: Placement, outline: Polygon,
    why: z.array(z.string()), margins: z.array(MeasureResult) })),
  beats: z.array(z.strictObject({ id: z.string(), kind: z.enum(["establish", "constrain", "height", "envelope", "reject", "place", "shadow", "caveats", "summary"]), refs: z.array(z.string()) })).min(1),
});
export const Narration = z.strictObject({ trace_sha256: Sha256, model: z.string(),
  lines: z.array(z.strictObject({ beat_id: z.string(), text: z.string(), numbers: z.array(z.strictObject({ value: z.number(), path: z.string() })), templated: z.boolean() })) });

// ------------------------------------------------------------------ C9 · Curated data §6, §8
/** One line of curated/confirmations.jsonl: the existing log shape (graph/model.py confirm) plus a disposition. */
export const ConfirmationEntry = z.object({
  item: z.string(), by: z.string().min(1), date: IsoDate, at: IsoDateTime, pins: z.unknown(), note: z.string().default(""),
  prev: Sha256.nullable(), disposition: Disposition.optional(),
}).superRefine((e, ctx) => {
  if (["cc", "ag", "claude", "model", "agent", "system"].includes(e.by.trim().toLowerCase()) && !/on .*delegation/i.test(e.note))
    ctx.addIssue({ code: "custom", message: "a confirmation is a named person's act; an agent signs only on stated delegation (L18)" });
});
export const IndexScopeOverride = z.strictObject({ provision_id: ProvisionId, scope_clause_id: ClauseId, scope_quote: z.string().min(1),
  by: z.string(), date: IsoDate, reason: z.string() });
export const IndexScopeFile = z.strictObject({ schema: z.literal("lotfit.index-scope/1"), entries: z.array(IndexScopeOverride) });
export const OperatorBinding = z.object({ id: z.string(), kind: z.string(), places: z.boolean(), tool: z.union([ToolName, z.literal("record_finding")]),
  reads: z.array(FactName), params: z.array(z.strictObject({ provision: ProvisionId, param: z.string() })), // already references, as rule 3 requires
  cells: z.array(CellRef).optional(), // e.g. the T110-5 piecewise cell for total_building_coverage
  partial: z.string().min(1).optional(), // 1.4.0 (P3): the operator checks only part of the provision (the reason); a pass becomes unknown
  args_match: z.record(z.string(), z.string()).optional(), // 1.5.0 (AG 4b): only calls whose args carry these values are evidence
  provisions: z.array(ProvisionId) });

// ------------------------------------------------------------------ registry (for emit and test)
export const CONTRACTS = {
  C1_Case: Case, C1_CaseRefusal: CaseRefusal, C1_Provenance: Provenance,
  C2_ReadingGuide: ReadingGuide, C2_LayerIndex: LayerIndex, C2_RuleFamily: RuleFamily, C2_QueryRequest: QueryRequest, C2_QueryResult: QueryResult,
  C3_ParamRef: ParamRef, C3_MeasureResult: MeasureResult, C3_GuardResult: GuardResult, C3_ExceptionResult: ExceptionResult, C3_PlacementSearchResult: PlacementSearchResult,
  C3_ToolCall: ToolCall, C3_BridgeRequest: BridgeRequest, C3_BridgeResponse: BridgeResponse,
  C4_Plan: Plan, C4_RecordFinding: RecordFinding, C4_Conclude: Conclude, C4_RepairError: RepairError,
  C5_Branch: Branch, C5_Sensitivity: Sensitivity, C5_Question: Question, C5_Answer: Answer,
  C6_LotFitEvent: LotFitEvent, C6_UsageRecord: UsageRecord, C6_ArtifactRef: ArtifactRef, C6_ConfigManifest: ConfigManifest,
  C7_Report: Report, C8_Trace: Trace, C8_Narration: Narration,
  C10_ReviewItem: ReviewItem, C10_ReviewerAnswer: ReviewerAnswer, C10_ReviewOutcome: ReviewOutcome,
  C9_ConfirmationEntry: ConfirmationEntry, C9_IndexScopeFile: IndexScopeFile, C9_OperatorBinding: OperatorBinding,
} as const;
export type ContractName = keyof typeof CONTRACTS;
for (const [k, s] of Object.entries(TOOL_ARGS)) (CONTRACTS as Record<string, z.ZodType>)[`C3_args_${k}`] = s;
