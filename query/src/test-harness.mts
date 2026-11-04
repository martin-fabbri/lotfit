/**
 * W6 · Offline Scripted-Model Tests for the Agent Harness (`test-harness.mts`).
 *
 * Exercises `evaluate()` and `evaluateDetailed()` end-to-end using `FileGraphReader`
 * (over `graph/out/graph-or.json`, `graph/curated/slice-pdx-adu-detached.json`,
 * `graph/curated/index-scope.json`, `graph/curated/reading-guide.md`, and
 * `graph/curated/confirmations.jsonl`) and `ScriptedModelClient`:
 *   1. S1 end-to-end without signed dispositions -> `NEEDS_CHECK` naming open not-modeled clauses (`unchecked.length > 0`).
 *   2. S1 end-to-end with a temporary disposition fixture -> `FITS`, `verifier.passed === true`, `recommended.placement` `{x: 13, y: 65, rotation: 0}`, valid `trace.json` and `events.jsonl`.
 *   3. Scripted model that excludes base setbacks (`PDX.33.110.220.B`) with a heading quote -> refused at `PLAN` (`PLAN_QUOTE_NOT_IN_INDEX` + `PLAN_FORBIDDEN_EXCLUSION`), then repairs.
 *   4. Scripted model that passes a bare number for a limit (`min: 5`) -> refused with a `model` error (`BARE_NUMBER_LIMIT`, EN-32).
 *   5. Scripted model that repeats a memoized read (`cached: true`) and then loops on an uncached call -> stopped by `STUCK_RULE` and still returns a valid `NEEDS_CHECK` `Report`.
 *   6. S2 (`query/cases/s2.json`, failed size cap) -> `adu_max_living_area` fails, breaker trips (`trigger: "breaker"`), placement tools are revoked, and report returns `NO_LEGS` with `plan_limit.value === 525`.
 */

import { canonicalJson } from "./events.mts";
import { createHash } from "node:crypto";
import { ScriptedReviewerClient } from "./reviewer-client.mts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

import * as C from "./types.mts";
import { createFileGraphReader, type GraphReader } from "./graph-reads.mts";
import { readEventsJsonl } from "./events.mts";
import { ScriptedModelClient, type ModelRequest, type ModelResponse } from "./model-client.mts";
import { evaluateDetailed } from "./harness.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUERY_ROOT = path.resolve(__dirname, "..");
const CASES_DIR = path.join(QUERY_ROOT, "cases");

const S1_RAW = JSON.parse(readFileSync(path.join(CASES_DIR, "s1.json"), "utf8"));
const S2_RAW = JSON.parse(readFileSync(path.join(CASES_DIR, "s2.json"), "utf8"));

// Core S1 applied provisions from the Portland detached-ADU slice
const S1_APPLIED_PROVISIONS = [
  "PDX.33.205.020.B.1.a",
  "PDX.T110-2", // B1 (2026-11-02): the allowed-use gate is checked (check_allowed), never excluded by quoting its title
  "PDX.33.205.040.C.1",
  "PDX.33.110.245.C.1",
  "PDX.33.110.220.B",
  "PDX.33.110.245.C.2",
  "PDX.33.205.040.C.2",
  "PDX.33.110.245.C.3.a",
  "PDX.33.110.225.B",
] as const;

// Deterministic UUIDv7 call IDs for scripted EXECUTE tool calls
const CALL = {
  read_guide: "019a5000-0000-7000-8000-000000000001",
  read_index: "019a5000-0000-7000-8000-000000000002",
  inspect_facts: "019a5000-0000-7000-8000-000000000003",
  read_families: "019a5000-0000-7000-8000-000000000010",
  read_families_dup: "019a5000-0000-7000-8000-000000000011",
  guard_gate: "019a5000-0000-7000-8000-000000000101",
  rf_gate: "019a5000-0000-7000-8000-000000000102",
  allowed_gate: "019a5000-0000-7000-8000-000000000107",
  rf_allowed: "019a5000-0000-7000-8000-000000000108",
  living_area: "019a5000-0000-7000-8000-000000000103",
  height: "019a5000-0000-7000-8000-000000000104",
  rf_living_area: "019a5000-0000-7000-8000-000000000105",
  rf_height: "019a5000-0000-7000-8000-000000000106",
  bare_setback: "019a5000-0000-7000-8000-000000000199",
  setback_client_side: "019a5000-0000-7000-8000-000000000201",
  setback_client_rear: "019a5000-0000-7000-8000-000000000202",
  exc_client: "019a5000-0000-7000-8000-000000000203",
  front_client: "019a5000-0000-7000-8000-000000000204",
  acc_cov_client: "019a5000-0000-7000-8000-000000000205",
  tot_cov_client: "019a5000-0000-7000-8000-000000000206",
  find_placements: "019a5000-0000-7000-8000-000000000207",
  setback_sel_side: "019a5000-0000-7000-8000-000000000208",
  setback_sel_rear: "019a5000-0000-7000-8000-000000000209",
  setback_sel_front: "019a5000-0000-7000-8000-0000000009f1",
  front_sel: "019a5000-0000-7000-8000-00000000020a",
  acc_cov_sel: "019a5000-0000-7000-8000-00000000020b",
  tot_cov_sel: "019a5000-0000-7000-8000-00000000020c",
  rf_client_220b: "019a5000-0000-7000-8000-000000000301",
  rf_client_245c2: "019a5000-0000-7000-8000-000000000302",
  rf_client_205c2: "019a5000-0000-7000-8000-000000000303",
  rf_client_245c3a: "019a5000-0000-7000-8000-000000000304",
  rf_client_225b: "019a5000-0000-7000-8000-000000000305",
  rf_sel_220b: "019a5000-0000-7000-8000-000000000306",
  rf_sel_205c2: "019a5000-0000-7000-8000-000000000307",
  rf_sel_245c3a: "019a5000-0000-7000-8000-000000000308",
  rf_sel_225b: "019a5000-0000-7000-8000-000000000309",
  conclude: "019a5000-0000-7000-8000-000000000400",
} as const;

/**
 * Build a complete valid `Plan` partitioning all provisions in `LayerIndex`
 * into `applies` (the 8 active S1 provisions) and `excluded_at_index` (everything else,
 * using each entry's exact `scope_clause_id` and `scope_quote` from the index).
 */
async function buildValidPlanFromReader(
  reader: GraphReader,
  asOf = "2026-11-15",
): Promise<{
  plan: z.infer<typeof C.Plan>;
  clauseQuotes: Map<string, { clause_id: string; quote: string }>;
  cellIdT110_5: string;
}> {
  const idx = await reader.readLayerIndex({ city_layer: "PDX", as_of: asOf });
  const appliedSet = new Set<string>(S1_APPLIED_PROVISIONS);

  const applies: z.infer<typeof C.Plan>["applies"] = [];
  const excluded_at_index: z.infer<typeof C.Plan>["excluded_at_index"] = [];

  for (const layer of idx.layers) {
    for (const entry of layer.provisions) {
      if (appliedSet.has(entry.provision_id)) {
        applies.push({
          provision_id: entry.provision_id,
          scope_quote: entry.scope.scope_quote,
          facts_needed: ["site.zone"],
        });
      } else {
        excluded_at_index.push({
          provision_id: entry.provision_id,
          scope_quote: entry.scope.scope_quote,
        });
      }
    }
  }

  const fams = await reader.readRuleFamily({
    provision_ids: [...S1_APPLIED_PROVISIONS, "PDX.T110-4", "PDX.T110-5"],
    as_of: asOf,
  });
  const clauseQuotes = new Map<string, { clause_id: string; quote: string }>();
  let cellIdT110_5 = "T110-5:R3";
  for (const f of fams) {
    const c0 = f.clauses.find((c) => c.quote.trim().length > 0) ?? f.clauses[0];
    if (c0) {
      clauseQuotes.set(f.provision_id, { clause_id: c0.clause_id, quote: c0.quote });
    }
    if (f.provision_id === "PDX.T110-5") {
      const r3 = f.cells.find((c) => c.row.includes("5,000 sq. ft. or more")) ?? f.cells[0];
      if (r3) cellIdT110_5 = r3.cell_id;
    }
  }

  const plan = C.Plan.parse({
    index_hash: idx.index_hash,
    applies,
    excluded_at_index,
    order: [...S1_APPLIED_PROVISIONS],
  });

  return { plan, clauseQuotes, cellIdT110_5 };
}

/**
 * Create a temporary confirmations.jsonl file that signs every unmodeled clause
 * in the applied S1 provisions with `inert_for(detached_adu)`.
 */
async function buildSignedConfirmationsFile(
  reader: GraphReader,
  dir: string,
  asOf = "2026-11-15",
): Promise<string> {
  const fams = await reader.readRuleFamily({
    provision_ids: [...S1_APPLIED_PROVISIONS],
    as_of: asOf,
  });
  const lines: string[] = [];
  for (const f of fams) {
    for (const cl of f.clauses) {
      if (!cl.modeled) {
        const entry = C.ConfirmationEntry.parse({
          item: cl.clause_id,
          by: "Martin Fabbri",
          date: "2026-11-01",
          at: "2026-11-01T20:00:00Z",
          pins: {},
          note: "Signed in temporary test fixture for GR-47 verification.",
          prev: null,
          disposition: {
            kind: "inert_for",
            scope: "detached_adu",
            reason: "Signed in temporary test fixture for GR-47 verification.",
            by: "Martin Fabbri",
            date: "2026-11-01",
          },
        });
        lines.push(JSON.stringify(entry));
      }
    }
  }
  const filePath = path.join(dir, "confirmations-signed.jsonl");
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

/**
 * Build scripted model turns for a complete S1 evaluation run.
 */
function buildS1ScriptedHandler(opts: {
  validPlan: z.infer<typeof C.Plan>;
  clauseQuotes: Map<string, { clause_id: string; quote: string }>;
  cellIdT110_5: string;
  concludeVerdict: z.infer<typeof C.Verdict>;
  badFirstPlan?: z.infer<typeof C.Plan>;
  injectBareNumberOnPlacement?: boolean;
}): (req: ModelRequest, callIndex: number) => ModelResponse {
  const q = (pid: string) =>
    opts.clauseQuotes.get(pid) ?? {
      clause_id: `${pid}#v1::sentence:1`,
      quote: "Applicable code provision.",
    };

  let planSubmitted = false;
  let badPlanTried = false;
  let gateDone = false;
  let planConstraintsDone = false;
  let bareNumberTried = false;
  let placementToolsDone = false;
  let findingsRecorded = false;

  return (req: ModelRequest): ModelResponse => {
    if (req.phase === "plan") {
      if (!planSubmitted) {
        planSubmitted = true;
        return {
          content: "",
          tool_calls: [
            {
              call_id: CALL.read_guide,
              tool: "read_reading_guide",
              provision_id: null,
              target: "case",
              args: {},
            },
            {
              call_id: CALL.read_index,
              tool: "read_layer_index",
              provision_id: null,
              target: "case",
              args: { city_layer: "PDX", as_of: "2026-11-15" },
            },
            {
              call_id: CALL.inspect_facts,
              tool: "inspect_case_facts",
              provision_id: null,
              target: "case",
              args: {},
            },
          ],
          usage: { model: "scripted-test-model", prompt_tokens: 900, completion_tokens: 120 },
        };
      }

      if (opts.badFirstPlan && !badPlanTried) {
        badPlanTried = true;
        return {
          content: JSON.stringify(opts.badFirstPlan),
          tool_calls: [],
          usage: { model: "scripted-test-model", prompt_tokens: 1100, completion_tokens: 250 },
        };
      }

      return {
        content: JSON.stringify(opts.validPlan),
        tool_calls: [],
        usage: { model: "scripted-test-model", prompt_tokens: 1100, completion_tokens: 300 },
      };
    }

    // EXECUTE phase
    // Turn 1 in EXECUTE: read_rule_family + evaluate_guards on gate + record_finding on gate
    if (!gateDone) {
      gateDone = true;
      return {
        content: "",
        tool_calls: [
          {
            call_id: CALL.read_families,
            tool: "read_rule_family",
            provision_id: null,
            target: "case",
            args: {
              provision_ids: [...S1_APPLIED_PROVISIONS, "PDX.T110-4", "PDX.T110-5"],
              as_of: "2026-11-15",
            },
          },
          {
            call_id: CALL.guard_gate,
            tool: "evaluate_guards",
            provision_id: "PDX.33.205.020.B.1.a",
            target: "case",
            args: {
              provision_id: "PDX.33.205.020.B.1.a",
              target: "case",
            },
          },
          {
            call_id: CALL.allowed_gate,
            tool: "check_allowed",
            provision_id: "PDX.T110-2",
            target: "case",
            args: { provision_id: "PDX.T110-2", target: "case", use: "accessory_dwelling_unit_see_chapter_33_205", zone: { fact: "site.zone" } },
          },
          {
            call_id: CALL.rf_gate,
            tool: "record_finding",
            provision_id: "PDX.33.205.020.B.1.a",
            target: "case",
            args: {
              provision_id: "PDX.33.205.020.B.1.a",
              target: "case",
              clause_ids: [q("PDX.33.205.020.B.1.a").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.guard_gate],
              numbers: [],
              quotes: [q("PDX.33.205.020.B.1.a")],
            },
          },
          {
            call_id: CALL.rf_allowed,
            tool: "record_finding",
            provision_id: "PDX.T110-2",
            target: "case",
            args: {
              provision_id: "PDX.T110-2",
              target: "case",
              clause_ids: [q("PDX.T110-2").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.allowed_gate],
              numbers: [],
              quotes: [q("PDX.T110-2")],
            },
          },
        ],
        usage: { model: "scripted-test-model", prompt_tokens: 1400, completion_tokens: 220 },
      };
    }

    // Turn 2 in EXECUTE: plan_constraint tools + record_finding
    if (!planConstraintsDone) {
      planConstraintsDone = true;
      return {
        content: "",
        tool_calls: [
          {
            call_id: CALL.living_area,
            tool: "adu_max_living_area",
            provision_id: "PDX.33.205.040.C.1",
            target: "case",
            args: {
              provision_id: "PDX.33.205.040.C.1",
              target: "case",
              primary_living_area: { fact: "site.primary_living_area_sqft" },
              plan_living_area: { fact: "plan.living_area_sqft" },
              share: {
                provision_id: "PDX.33.205.040.C.1",
                param: "max_share_of_primary_living_area",
              },
              cap: {
                provision_id: "PDX.33.205.040.C.1",
                param: "max_living_area",
              },
            },
          },
          {
            call_id: CALL.height,
            tool: "check_max",
            provision_id: "PDX.33.110.245.C.1",
            target: "case",
            args: {
              provision_id: "PDX.33.110.245.C.1",
              target: "case",
              value: { fact: "plan.height_ft" },
              limit: { provision_id: "PDX.33.110.245.C.1", param: "max_height" },
            },
          },
          {
            call_id: CALL.rf_living_area,
            tool: "record_finding",
            provision_id: "PDX.33.205.040.C.1",
            target: "case",
            args: {
              provision_id: "PDX.33.205.040.C.1",
              target: "case",
              clause_ids: [q("PDX.33.205.040.C.1").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.living_area],
              numbers: [
                { value: 576, unit: "sqft", call_id: CALL.living_area, path: "value" },
                { value: 224, unit: "sqft", call_id: CALL.living_area, path: "margin" },
              ],
              quotes: [q("PDX.33.205.040.C.1")],
            },
          },
          {
            call_id: CALL.rf_height,
            tool: "record_finding",
            provision_id: "PDX.33.110.245.C.1",
            target: "case",
            args: {
              provision_id: "PDX.33.110.245.C.1",
              target: "case",
              clause_ids: [q("PDX.33.110.245.C.1").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.height],
              numbers: [
                { value: 15, unit: "ft", call_id: CALL.height, path: "value" },
                { value: 5, unit: "ft", call_id: CALL.height, path: "margin" },
              ],
              quotes: [q("PDX.33.110.245.C.1")],
            },
          },
        ],
        usage: { model: "scripted-test-model", prompt_tokens: 1600, completion_tokens: 280 },
      };
    }

    // Optional turn to test bare-number limit refusal (EN-32)
    if (opts.injectBareNumberOnPlacement && !bareNumberTried) {
      bareNumberTried = true;
      return {
        content: "",
        tool_calls: [
          {
            call_id: CALL.bare_setback,
            tool: "check_setback",
            provision_id: "PDX.33.110.220.B",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "client_spot",
              outline: { fact: "plan.outline" },
              lines: { fact: "site.side_lot_lines" },
              min: 5,
            },
          },
        ],
        usage: { model: "scripted-test-model", prompt_tokens: 1650, completion_tokens: 90 },
      };
    }

    // Turn 3 in EXECUTE: placement_constraint tools for client_spot + find_placements + selected_placement
    if (!placementToolsDone) {
      placementToolsDone = true;
      const selOutline = {
        placed: { x: 13, y: 65, rotation: 0 },
        footprint: { fact: "plan.footprint" },
      };
      return {
        content: "",
        tool_calls: [
          {
            call_id: CALL.setback_client_side,
            tool: "check_setback",
            provision_id: "PDX.33.110.220.B",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "client_spot",
              outline: { fact: "plan.outline" },
              lines: { fact: "site.side_lot_lines" },
              min: { provision_id: "PDX.T110-4", param: "side_building_setback.R5" },
            },
          },
          {
            call_id: CALL.setback_client_rear,
            tool: "check_setback",
            provision_id: "PDX.33.110.220.B",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "client_spot",
              outline: { fact: "plan.outline" },
              lines: { fact: "site.rear_lot_line" },
              min: { provision_id: "PDX.T110-4", param: "rear_building_setback.R5" },
            },
          },
          {
            call_id: CALL.exc_client,
            tool: "check_exception_conditions",
            provision_id: "PDX.33.110.245.C.2",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.245.C.2",
              target: "client_spot",
              exception_id: "PDX.33.110.245.C.2",
              base_provision_id: "PDX.33.110.220.B",
              outline: { fact: "plan.outline" },
            },
          },
          {
            call_id: CALL.front_client,
            tool: "check_front_or_behind",
            provision_id: "PDX.33.205.040.C.2",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.205.040.C.2",
              target: "client_spot",
              outline: { fact: "plan.outline" },
              front_lot_line: { fact: "site.front_lot_line" },
              min_front: { provision_id: "PDX.33.205.040.C.2", param: "front_lot_line_setback" },
              house_rear_wall: { fact: "site.house_rear_wall" },
            },
          },
          {
            call_id: CALL.acc_cov_client,
            tool: "coverage_share",
            provision_id: "PDX.33.110.245.C.3.a",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.245.C.3.a",
              target: "client_spot",
              outlines: [{ fact: "plan.outline" }, { fact: "site.structures" }],
              lot_area: { fact: "site.lot_area_sqft" },
              limit: {
                provision_id: "PDX.33.110.245.C.3.a",
                param: "max_combined_accessory_coverage_pct_of_site",
              },
            },
          },
          {
            call_id: CALL.tot_cov_client,
            tool: "total_building_coverage",
            provision_id: "PDX.33.110.225.B",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.225.B",
              target: "client_spot",
              outlines: [
                { fact: "plan.outline" },
                { fact: "site.house_outline" },
                { fact: "site.structures" },
              ],
              lot_area: { fact: "site.lot_area_sqft" },
              cap_cell: { provision_id: "PDX.T110-5", cell_id: opts.cellIdT110_5 },
            },
          },
          {
            call_id: CALL.find_placements,
            tool: "find_placements",
            provision_id: "PDX.33.110.220.B",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "client_spot",
              footprint: { fact: "plan.footprint" },
              setback_provisions: ["PDX.33.110.220.B"],
            },
          },
          {
            call_id: CALL.setback_sel_side,
            tool: "check_setback",
            provision_id: "PDX.33.110.220.B",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "selected_placement",
              outline: selOutline,
              lines: { fact: "site.side_lot_lines" },
              min: { provision_id: "PDX.T110-4", param: "side_building_setback.R5" },
            },
          },
          {
            call_id: CALL.setback_sel_rear,
            tool: "check_setback",
            provision_id: "PDX.33.110.220.B",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "selected_placement",
              outline: selOutline,
              lines: { fact: "site.rear_lot_line" },
              min: { provision_id: "PDX.T110-4", param: "rear_building_setback.R5" },
            },
          },
          {
            call_id: CALL.setback_sel_front,
            tool: "check_setback",
            provision_id: "PDX.33.110.220.B",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "selected_placement",
              outline: selOutline,
              lines: { fact: "site.front_lot_line" },
              min: { provision_id: "PDX.T110-4", param: "front_building_setback.R5" },
            },
          },
          {
            call_id: CALL.front_sel,
            tool: "check_front_or_behind",
            provision_id: "PDX.33.205.040.C.2",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.205.040.C.2",
              target: "selected_placement",
              outline: selOutline,
              front_lot_line: { fact: "site.front_lot_line" },
              min_front: { provision_id: "PDX.33.205.040.C.2", param: "front_lot_line_setback" },
              house_rear_wall: { fact: "site.house_rear_wall" },
            },
          },
          {
            call_id: CALL.acc_cov_sel,
            tool: "coverage_share",
            provision_id: "PDX.33.110.245.C.3.a",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.110.245.C.3.a",
              target: "selected_placement",
              outlines: [selOutline, { fact: "site.structures" }],
              lot_area: { fact: "site.lot_area_sqft" },
              limit: {
                provision_id: "PDX.33.110.245.C.3.a",
                param: "max_combined_accessory_coverage_pct_of_site",
              },
            },
          },
          {
            call_id: CALL.tot_cov_sel,
            tool: "total_building_coverage",
            provision_id: "PDX.33.110.225.B",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.110.225.B",
              target: "selected_placement",
              outlines: [selOutline, { fact: "site.house_outline" }, { fact: "site.structures" }],
              lot_area: { fact: "site.lot_area_sqft" },
              cap_cell: { provision_id: "PDX.T110-5", cell_id: opts.cellIdT110_5 },
            },
          },
        ],
        usage: { model: "scripted-test-model", prompt_tokens: 1900, completion_tokens: 550 },
      };
    }

    // Turn 4 in EXECUTE: record_finding for all placement checks + conclude
    if (!findingsRecorded) {
      findingsRecorded = true;
      return {
        content: "",
        tool_calls: [
          {
            call_id: CALL.rf_client_220b,
            tool: "record_finding",
            provision_id: "PDX.33.110.220.B",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "client_spot",
              clause_ids: [q("PDX.33.110.220.B").clause_id],
              outcome: "fail",
              evidence_call_ids: [CALL.setback_client_side, CALL.setback_client_rear],
              numbers: [
                { value: 2, unit: "ft", call_id: CALL.setback_client_side, path: "value" },
                { value: -3, unit: "ft", call_id: CALL.setback_client_side, path: "margin" },
                { value: 2, unit: "ft", call_id: CALL.setback_client_rear, path: "value" },
                { value: -3, unit: "ft", call_id: CALL.setback_client_rear, path: "margin" },
              ],
              quotes: [q("PDX.33.110.220.B")],
            },
          },
          {
            call_id: CALL.rf_client_245c2,
            tool: "record_finding",
            provision_id: "PDX.33.110.245.C.2",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.245.C.2",
              target: "client_spot",
              clause_ids: [q("PDX.33.110.245.C.2").clause_id],
              outcome: "fail",
              evidence_call_ids: [CALL.exc_client],
              numbers: [],
              quotes: [q("PDX.33.110.245.C.2")],
            },
          },
          {
            call_id: CALL.rf_client_205c2,
            tool: "record_finding",
            provision_id: "PDX.33.205.040.C.2",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.205.040.C.2",
              target: "client_spot",
              clause_ids: [q("PDX.33.205.040.C.2").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.front_client],
              numbers: [
                { value: 74, unit: "ft", call_id: CALL.front_client, path: "value" },
                { value: 34, unit: "ft", call_id: CALL.front_client, path: "margin" },
              ],
              quotes: [q("PDX.33.205.040.C.2")],
            },
          },
          {
            call_id: CALL.rf_client_245c3a,
            tool: "record_finding",
            provision_id: "PDX.33.110.245.C.3.a",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.245.C.3.a",
              target: "client_spot",
              clause_ids: [q("PDX.33.110.245.C.3.a").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.acc_cov_client],
              numbers: [
                { value: 13.12, unit: "%", call_id: CALL.acc_cov_client, path: "value" },
                { value: 6.88, unit: "%", call_id: CALL.acc_cov_client, path: "margin" },
              ],
              quotes: [q("PDX.33.110.245.C.3.a")],
            },
          },
          {
            call_id: CALL.rf_client_225b,
            tool: "record_finding",
            provision_id: "PDX.33.110.225.B",
            target: "client_spot",
            args: {
              provision_id: "PDX.33.110.225.B",
              target: "client_spot",
              clause_ids: [q("PDX.33.110.225.B").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.tot_cov_client],
              numbers: [
                { value: 1566, unit: "sqft", call_id: CALL.tot_cov_client, path: "value" },
                { value: 684, unit: "sqft", call_id: CALL.tot_cov_client, path: "margin" },
              ],
              quotes: [q("PDX.33.110.225.B")],
            },
          },
          {
            call_id: CALL.rf_sel_220b,
            tool: "record_finding",
            provision_id: "PDX.33.110.220.B",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.110.220.B",
              target: "selected_placement",
              clause_ids: [q("PDX.33.110.220.B").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.setback_sel_side, CALL.setback_sel_rear, CALL.setback_sel_front],
              numbers: [
                { value: 13, unit: "ft", call_id: CALL.setback_sel_side, path: "value" },
                { value: 8, unit: "ft", call_id: CALL.setback_sel_side, path: "margin" },
                { value: 11, unit: "ft", call_id: CALL.setback_sel_rear, path: "value" },
                { value: 6, unit: "ft", call_id: CALL.setback_sel_rear, path: "margin" },
              ],
              quotes: [q("PDX.33.110.220.B")],
            },
          },
          {
            call_id: CALL.rf_sel_205c2,
            tool: "record_finding",
            provision_id: "PDX.33.205.040.C.2",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.205.040.C.2",
              target: "selected_placement",
              clause_ids: [q("PDX.33.205.040.C.2").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.front_sel],
              numbers: [
                { value: 65, unit: "ft", call_id: CALL.front_sel, path: "value" },
                { value: 25, unit: "ft", call_id: CALL.front_sel, path: "margin" },
              ],
              quotes: [q("PDX.33.205.040.C.2")],
            },
          },
          {
            call_id: CALL.rf_sel_245c3a,
            tool: "record_finding",
            provision_id: "PDX.33.110.245.C.3.a",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.110.245.C.3.a",
              target: "selected_placement",
              clause_ids: [q("PDX.33.110.245.C.3.a").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.acc_cov_sel],
              numbers: [
                { value: 13.12, unit: "%", call_id: CALL.acc_cov_sel, path: "value" },
                { value: 6.88, unit: "%", call_id: CALL.acc_cov_sel, path: "margin" },
              ],
              quotes: [q("PDX.33.110.245.C.3.a")],
            },
          },
          {
            call_id: CALL.rf_sel_225b,
            tool: "record_finding",
            provision_id: "PDX.33.110.225.B",
            target: "selected_placement",
            args: {
              provision_id: "PDX.33.110.225.B",
              target: "selected_placement",
              clause_ids: [q("PDX.33.110.225.B").clause_id],
              outcome: "pass",
              evidence_call_ids: [CALL.tot_cov_sel],
              numbers: [
                { value: 1566, unit: "sqft", call_id: CALL.tot_cov_sel, path: "value" },
                { value: 684, unit: "sqft", call_id: CALL.tot_cov_sel, path: "margin" },
              ],
              quotes: [q("PDX.33.110.225.B")],
            },
          },
          {
            call_id: CALL.conclude,
            tool: "conclude",
            provision_id: null,
            target: "case",
            args: {
              verdict: opts.concludeVerdict,
              summary:
                "Client spot (2, 74) fails the 5 ft side and rear setbacks and the 245.C.2 exception due to wall height 12 ft > 10 ft and openings; recommended spot (13, 65) clears all setbacks.",
              selected_placement: { x: 13, y: 65, rotation: 0 },
              client_spot_passes: false,
            },
          },
        ],
        usage: { model: "scripted-test-model", prompt_tokens: 2200, completion_tokens: 600 },
      };
    }

    return {
      content: "",
      tool_calls: [],
      usage: { model: "scripted-test-model", prompt_tokens: 500, completion_tokens: 50 },
    };
  };
}

// ------------------------------------------------------------------ Test Runner

let passedCount = 0;
let totalCount = 0;

function assertCheck(name: string, cond: boolean, detail = ""): void {
  totalCount += 1;
  if (cond) {
    passedCount += 1;
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

async function main(): Promise<void> {
  const scratchDir = mkdtempSync(path.join(tmpdir(), "lotfit-w6-test-"));
  const baseReader = createFileGraphReader();
  const { plan: validPlan, clauseQuotes, cellIdT110_5 } = await buildValidPlanFromReader(baseReader);
  const signedConfirmationsPath = await buildSignedConfirmationsFile(baseReader, scratchDir);

  // ------------------------------------------------------------------
  // Test 1: S1 end-to-end WITHOUT dispositions -> NEEDS_CHECK naming open clauses
  // ------------------------------------------------------------------
  {
    const readerNoDisp = createFileGraphReader();
    const modelNoDisp = new ScriptedModelClient(
      buildS1ScriptedHandler({
        validPlan,
        clauseQuotes,
        cellIdT110_5,
        concludeVerdict: "NEEDS_CHECK",
      }),
    );

    const run1 = await evaluateDetailed(S1_RAW, {
      graphReader: readerNoDisp,
      modelClient: modelNoDisp,
      runsDir: path.join(scratchDir, "runs-no-disp"),
    });

    assertCheck(
      "T1.1 S1 without dispositions returns NEEDS_CHECK (GR-47)",
      run1.report.verdict === "NEEDS_CHECK",
      `got verdict=${run1.report.verdict}`,
    );
    assertCheck(
      "T1.2 S1 without dispositions names open not-modeled clauses in report.unchecked",
      run1.report.unchecked.length > 0 &&
        run1.report.unchecked.some((u) => u.provision_id === "PDX.33.110.220.B"),
      `unchecked.length=${run1.report.unchecked.length}`,
    );
    assertCheck(
      "T1.3 S1 without dispositions passes verifier when model agrees on NEEDS_CHECK",
      run1.report.verifier.passed === true,
      JSON.stringify(run1.report.verifier.issues),
    );
  }

  // ------------------------------------------------------------------
  // Test 2: S1 end-to-end WITH temporary disposition fixture -> FITS
  // ------------------------------------------------------------------
  {
    const readerWithDisp = createFileGraphReader({
      confirmationsPath: signedConfirmationsPath,
    });
    const modelWithDisp = new ScriptedModelClient(
      buildS1ScriptedHandler({
        validPlan,
        clauseQuotes,
        cellIdT110_5,
        concludeVerdict: "FITS",
      }),
    );

    const run2 = await evaluateDetailed(S1_RAW, {
      graphReader: readerWithDisp,
      modelClient: modelWithDisp,
      runsDir: path.join(scratchDir, "runs-with-disp"),
    });

    assertCheck(
      "T2.1 S1 with signed dispositions fixture returns FITS",
      run2.report.verdict === "FITS" && run2.report.model_verdict === "FITS",
      `verdict=${run2.report.verdict}, model_verdict=${String(run2.report.model_verdict)}`,
    );
    assertCheck(
      "T2.2 S1 with signed dispositions has 0 open unchecked clauses and records dispositions_relied_on",
      run2.report.unchecked.length === 0 && run2.report.dispositions_relied_on.length > 0,
      `unchecked=${run2.report.unchecked.length}, dispositions=${run2.report.dispositions_relied_on.length}`,
    );
    assertCheck(
      "T2.3 S1 client_spot fails and recommended placement is (13, 65, rot 0) with clean re-checked margins",
      run2.report.placement.client_spot?.passes === false &&
        run2.report.placement.recommended?.placement.x === 13 &&
        run2.report.placement.recommended?.placement.y === 65 &&
        (run2.report.placement.recommended?.margins.length ?? 0) >= 3 &&
        run2.report.placement.recommended!.margins.every((m) => m.pass === true),
      JSON.stringify(run2.report.placement),
    );
    assertCheck(
      "T2.4 S1 deterministic verifier (V1..V8) passes with 0 issues",
      run2.report.verifier.passed === true && run2.report.verifier.issues.length === 0,
      JSON.stringify(run2.report.verifier.issues),
    );
    assertCheck(
      "T2.5 W8 trace.json compiled from report validates against C.Trace",
      C.Trace.safeParse(run2.trace).success &&
        run2.trace.options.some((o) => o.status === "selected"),
    );

    const diskEvents = readEventsJsonl(path.join(run2.run_dir, "events.jsonl"));
    assertCheck(
      "T2.6 events.jsonl on disk parses against C.LotFitEvent and includes lotfit.* custom events",
      diskEvents.length === run2.events.length &&
        diskEvents.some((e) => e.type === "lotfit.plan_written") &&
        diskEvents.some((e) => e.type === "lotfit.finding_recorded") &&
        diskEvents.some((e) => e.type === "lotfit.sensitivity_completed") &&
        diskEvents.some((e) => e.type === "lotfit.verdict_computed") &&
        diskEvents.some((e) => e.type === "lotfit.verifier_completed") &&
        diskEvents.some((e) => e.type === "lotfit.ledger_compacted"),
    );
  }

  // ------------------------------------------------------------------
  // Test R: the Reviewer's call site (CONTRACT-REVIEWER.md B1, B2; 1.5.0). S1 with signed dispositions and a scripted
  // Reviewer: the run still ends FITS, report.reviewer is written, one reviewer_completed event in a verify turn after
  // the verdict, and the trace's report hash is the reviewed report's.
  // ------------------------------------------------------------------
  {
    const readerR = createFileGraphReader({ confirmationsPath: signedConfirmationsPath });
    const modelR = new ScriptedModelClient(buildS1ScriptedHandler({ validPlan, clauseQuotes, cellIdT110_5, concludeVerdict: "FITS" }));
    const reviewerR = new ScriptedReviewerClient("muse-spark-1.3", () => "{}");
    const runR = await evaluateDetailed(S1_RAW, { graphReader: readerR, modelClient: modelR, reviewerClient: reviewerR, runsDir: path.join(scratchDir, "runs-reviewer") });
    const evs = runR.events;
    const iVerdict = evs.findIndex((e) => e.type === "lotfit.verdict_computed");
    const iReview = evs.findIndex((e) => e.type === "lotfit.reviewer_completed");
    const entailedR = (evs[iVerdict] as any)?.data?.entailed;
    assertCheck("TR.1 with a Reviewer configured the report's verdict is the Judge's (the Reviewer changes no verdict)", runR.report.verdict === entailedR, `${runR.report.verdict} vs ${entailedR}`);
    assertCheck("TR.2 report.reviewer is written, model recorded in telemetry", !!runR.report.reviewer && runR.report.telemetry.models["reviewer"] === "muse-spark-1.3",
      JSON.stringify({ status: runR.report.reviewer?.status, models: runR.report.telemetry.models }));
    assertCheck("TR.3 one reviewer_completed event, after the verdict (B1)", iReview > iVerdict && iVerdict >= 0 && evs.filter((e) => e.type === "lotfit.reviewer_completed").length === 1);
    // After build-review A1, ORS.197A.425 (a preemption whose only false guard sat on an "except" clause) is a Planner
    // reading: one item. The scripted Reviewer answers "{}", which is no answer: the review is not_run, never clean (A2).
    assertCheck("TR.4 S1's one reviewed reading (ORS.197A.425, preemption) gets \"{}\" twice → not_run (model), never clean",
      runR.report.reviewer?.items === 1 && runR.report.reviewer?.status === "not_run" && runR.report.reviewer?.error?.category === "model" && reviewerR.calls === 2,
      JSON.stringify({ items: runR.report.reviewer?.items, status: runR.report.reviewer?.status, calls: reviewerR.calls }));
    assertCheck("TR.5 the trace hashes the reviewed report", runR.trace.report_sha256 === createHash("sha256").update(canonicalJson(runR.report)).digest("hex"));
  }

  // ------------------------------------------------------------------
  // Test 3: PLAN refusal when excluding PDX.33.110.220.B with a heading quote
  // ------------------------------------------------------------------
  {
    const badPlan: z.infer<typeof C.Plan> = {
      ...validPlan,
      applies: validPlan.applies.filter((a) => a.provision_id !== "PDX.33.110.220.B"),
      excluded_at_index: [
        ...validPlan.excluded_at_index,
        {
          provision_id: "PDX.33.110.220.B",
          scope_quote: "Required setbacks.",
        },
      ],
      order: validPlan.order.filter((id) => id !== "PDX.33.110.220.B"),
    };

    const reader3 = createFileGraphReader({
      confirmationsPath: signedConfirmationsPath,
    });
    const model3 = new ScriptedModelClient(
      buildS1ScriptedHandler({
        validPlan,
        clauseQuotes,
        cellIdT110_5,
        concludeVerdict: "FITS",
        badFirstPlan: badPlan,
      }),
    );

    const run3 = await evaluateDetailed(S1_RAW, {
      graphReader: reader3,
      modelClient: model3,
      runsDir: path.join(scratchDir, "runs-bad-plan"),
    });

    const planWrittenEvents = run3.events.filter((e) => e.type === "lotfit.plan_written");
    const firstPlanEv = planWrittenEvents[0];
    const secondPlanEv = planWrittenEvents[1];

    assertCheck(
      "T3.1 Excluding PDX.33.110.220.B with heading quote is refused at PLAN with PLAN_QUOTE_NOT_IN_INDEX and PLAN_FORBIDDEN_EXCLUSION",
      firstPlanEv !== undefined &&
        firstPlanEv.type === "lotfit.plan_written" &&
        firstPlanEv.data.valid === false &&
        firstPlanEv.data.repairs.some((r) => r.code === "PLAN_QUOTE_NOT_IN_INDEX") &&
        firstPlanEv.data.repairs.some((r) => r.code === "PLAN_FORBIDDEN_EXCLUSION"),
      JSON.stringify(firstPlanEv),
    );
    assertCheck(
      "T3.2 Repaired plan on next turn is version 2 (v2-plan.json) and run completes with FITS",
      secondPlanEv !== undefined &&
        secondPlanEv.type === "lotfit.plan_written" &&
        secondPlanEv.data.valid === true &&
        secondPlanEv.data.plan_artifact.version === 2 &&
        run3.report.verdict === "FITS",
    );
  }

  // ------------------------------------------------------------------
  // Test 4: Bare number limit refusal (EN-32)
  // ------------------------------------------------------------------
  {
    const reader4 = createFileGraphReader({
      confirmationsPath: signedConfirmationsPath,
    });
    const model4 = new ScriptedModelClient(
      buildS1ScriptedHandler({
        validPlan,
        clauseQuotes,
        cellIdT110_5,
        concludeVerdict: "FITS",
        injectBareNumberOnPlacement: true,
      }),
    );

    const run4 = await evaluateDetailed(S1_RAW, {
      graphReader: reader4,
      modelClient: model4,
      runsDir: path.join(scratchDir, "runs-bare-number"),
    });

    const bareErrEvent = run4.events.find(
      (e) => e.type === "error" && e.data.category === "model" && e.data.code === "BARE_NUMBER_LIMIT",
    );
    const bareToolResult = run4.events.find(
      (e) =>
        e.type === "tool_result" &&
        e.data.call_id === CALL.bare_setback &&
        e.data.ok === false &&
        e.data.error?.category === "model",
    );

    assertCheck(
      "T4.1 Bare number limit (min: 5) is refused with a model error (EN-32) and run recovers on repair",
      bareErrEvent !== undefined && bareToolResult !== undefined && run4.report.verdict === "FITS",
    );
  }

  // ------------------------------------------------------------------
  // Test 5: Memoized read (`cached: true`) vs Stuck rule (`STUCK_RULE`) -> NEEDS_CHECK
  // ------------------------------------------------------------------
  {
    let step = 0;
    const loopingModel = new ScriptedModelClient((req) => {
      step += 1;
      if (req.phase === "plan") {
        if (step === 1) {
          return {
            content: "",
            tool_calls: [
              {
                call_id: CALL.read_index,
                tool: "read_layer_index",
                provision_id: null,
                target: "case",
                args: { city_layer: "PDX", as_of: "2026-11-15" },
              },
            ],
            usage: { model: "scripted-test-model", prompt_tokens: 500, completion_tokens: 50 },
          };
        }
        return {
          content: JSON.stringify(validPlan),
          tool_calls: [],
          usage: { model: "scripted-test-model", prompt_tokens: 600, completion_tokens: 200 },
        };
      }

      // In EXECUTE: first call read_rule_family twice with identical args (second is a memo hit with cached: true!)
      // Then repeat an invalid uncached record_finding call twice to trip STUCK_RULE
      if (step === 3) {
        return {
          content: "",
          tool_calls: [
            {
              call_id: CALL.read_families,
              tool: "read_rule_family",
              provision_id: null,
              target: "case",
              args: { provision_ids: ["PDX.33.205.020.B.1.a"], as_of: "2026-11-15" },
            },
            {
              call_id: CALL.read_families_dup,
              tool: "read_rule_family",
              provision_id: null,
              target: "case",
              args: { provision_ids: ["PDX.33.205.020.B.1.a"], as_of: "2026-11-15" },
            },
          ],
          usage: { model: "scripted-test-model", prompt_tokens: 700, completion_tokens: 100 },
        };
      }

      // Repeat the exact same uncached record_finding call
      return {
        content: "",
        tool_calls: [
          {
            call_id: makeUuid7ForTest(step),
            tool: "record_finding",
            provision_id: "PDX.33.205.020.B.1.a",
            target: "case",
            args: {
              provision_id: "PDX.33.205.020.B.1.a",
              target: "case",
              clause_ids: ["PDX.33.205.020.B.1.a#v1::sentence:1"],
              outcome: "pass",
              evidence_call_ids: ["019a5000-0000-7000-8000-000000000999"],
              numbers: [],
              quotes: [{ clause_id: "PDX.33.205.020.B.1.a#v1::sentence:1", quote: "Allowed." }],
            },
          },
        ],
        usage: { model: "scripted-test-model", prompt_tokens: 700, completion_tokens: 100 },
      };
    });

    const run5 = await evaluateDetailed(S1_RAW, {
      graphReader: createFileGraphReader({ confirmationsPath: signedConfirmationsPath }),
      modelClient: loopingModel,
      runsDir: path.join(scratchDir, "runs-stuck"),
    });

    const cachedResultEv = run5.events.find(
      (e) => e.type === "tool_result" && e.data.call_id === CALL.read_families_dup && e.data.cached === true,
    );
    const stuckErrEv = run5.events.find(
      (e) => e.type === "error" && e.data.code === "STUCK_RULE",
    );
    const verdictEv = run5.events.find((e) => e.type === "lotfit.verdict_computed");

    assertCheck(
      "T5.1 Repeated read_rule_family is served from memo with cached: true without tripping stuck rule",
      cachedResultEv !== undefined,
    );
    assertCheck(
      "T5.2 Repeated uncached call trips STUCK_RULE, sets abnormal_end: true, and returns valid NEEDS_CHECK Report",
      stuckErrEv !== undefined &&
        verdictEv !== undefined &&
        verdictEv.type === "lotfit.verdict_computed" &&
        verdictEv.data.abnormal_end === true &&
        run5.report.verdict === "NEEDS_CHECK" &&
        C.Report.safeParse(run5.report).success,
    );
  }

  // ------------------------------------------------------------------
  // Test 6: S2 failed size cap (`plan_constraint` breaker -> NO_LEGS)
  // ------------------------------------------------------------------
  {
    const q = (pid: string) =>
      clauseQuotes.get(pid) ?? {
        clause_id: `${pid}#v1::sentence:1`,
        quote: "Applicable code provision.",
      };

    let s2Step = 0;
    const s2Model = new ScriptedModelClient((req) => {
      s2Step += 1;
      if (req.phase === "plan") {
        if (s2Step === 1) {
          return {
            content: "",
            tool_calls: [
              {
                call_id: CALL.read_index,
                tool: "read_layer_index",
                provision_id: null,
                target: "case",
                args: { city_layer: "PDX", as_of: "2026-11-15" },
              },
            ],
            usage: { model: "scripted-test-model", prompt_tokens: 500, completion_tokens: 60 },
          };
        }
        return {
          content: JSON.stringify(validPlan),
          tool_calls: [],
          usage: { model: "scripted-test-model", prompt_tokens: 600, completion_tokens: 200 },
        };
      }

      // EXECUTE turn 1: gate check
      if (s2Step === 3) {
        return {
          content: "",
          tool_calls: [
            {
              call_id: CALL.read_families,
              tool: "read_rule_family",
              provision_id: null,
              target: "case",
              args: {
                provision_ids: ["PDX.33.205.020.B.1.a", "PDX.33.205.040.C.1", "PDX.33.110.245.C.1"],
                as_of: "2026-11-15",
              },
            },
            {
              call_id: CALL.guard_gate,
              tool: "evaluate_guards",
              provision_id: "PDX.33.205.020.B.1.a",
              target: "case",
              args: { provision_id: "PDX.33.205.020.B.1.a", target: "case" },
            },
            {
              call_id: CALL.allowed_gate,
              tool: "check_allowed",
              provision_id: "PDX.T110-2",
              target: "case",
              args: { provision_id: "PDX.T110-2", target: "case", use: "accessory_dwelling_unit_see_chapter_33_205", zone: { fact: "site.zone" } },
            },
            {
              call_id: CALL.rf_gate,
              tool: "record_finding",
              provision_id: "PDX.33.205.020.B.1.a",
              target: "case",
              args: {
                provision_id: "PDX.33.205.020.B.1.a",
                target: "case",
                clause_ids: [q("PDX.33.205.020.B.1.a").clause_id],
                outcome: "pass",
                evidence_call_ids: [CALL.guard_gate],
                numbers: [],
                quotes: [q("PDX.33.205.020.B.1.a")],
              },
            },
            {
              call_id: CALL.rf_allowed,
              tool: "record_finding",
              provision_id: "PDX.T110-2",
              target: "case",
              args: {
                provision_id: "PDX.T110-2",
                target: "case",
                clause_ids: [q("PDX.T110-2").clause_id],
                outcome: "pass",
                evidence_call_ids: [CALL.allowed_gate],
                numbers: [],
                quotes: [q("PDX.T110-2")],
              },
            },
          ],
          usage: { model: "scripted-test-model", prompt_tokens: 900, completion_tokens: 150 },
        };
      }

      // EXECUTE turn 2: plan_constraint check (adu_max_living_area fails on S2: 600 > 525!)
      // Also attempt a check_setback call in the same batch AFTER adu_max_living_area to verify breaker revokes it immediately!
      if (s2Step === 4) {
        return {
          content: "",
          tool_calls: [
            {
              call_id: CALL.living_area,
              tool: "adu_max_living_area",
              provision_id: "PDX.33.205.040.C.1",
              target: "case",
              args: {
                provision_id: "PDX.33.205.040.C.1",
                target: "case",
                primary_living_area: { fact: "site.primary_living_area_sqft" },
                plan_living_area: { fact: "plan.living_area_sqft" },
                share: {
                  provision_id: "PDX.33.205.040.C.1",
                  param: "max_share_of_primary_living_area",
                },
                cap: {
                  provision_id: "PDX.33.205.040.C.1",
                  param: "max_living_area",
                },
              },
            },
            {
              call_id: CALL.setback_client_side,
              tool: "check_setback",
              provision_id: "PDX.33.110.220.B",
              target: "client_spot",
              args: {
                provision_id: "PDX.33.110.220.B",
                target: "client_spot",
                outline: { fact: "plan.outline" },
                lines: { fact: "site.side_lot_lines" },
                min: { provision_id: "PDX.T110-4", param: "side_building_setback.R5" },
              },
            },
          ],
          usage: { model: "scripted-test-model", prompt_tokens: 1000, completion_tokens: 180 },
        };
      }

      // EXECUTE turn 3: record_finding for failed living area + conclude NO_LEGS
      return {
        content: "",
        tool_calls: [
          {
            call_id: CALL.rf_living_area,
            tool: "record_finding",
            provision_id: "PDX.33.205.040.C.1",
            target: "case",
            args: {
              provision_id: "PDX.33.205.040.C.1",
              target: "case",
              clause_ids: [q("PDX.33.205.040.C.1").clause_id],
              outcome: "fail",
              evidence_call_ids: [CALL.living_area],
              numbers: [
                { value: 600, unit: "sqft", call_id: CALL.living_area, path: "value" },
                { value: -75, unit: "sqft", call_id: CALL.living_area, path: "margin" },
              ],
              quotes: [q("PDX.33.205.040.C.1")],
            },
          },
          {
            call_id: CALL.conclude,
            tool: "conclude",
            provision_id: null,
            target: "case",
            args: {
              verdict: "NO_LEGS",
              summary: "Proposed 600 sq ft ADU exceeds the 525 sq ft cap (75% of 700 sq ft primary dwelling).",
              selected_placement: null,
              client_spot_passes: false,
            },
          },
        ],
        usage: { model: "scripted-test-model", prompt_tokens: 1100, completion_tokens: 160 },
      };
    });

    const run6 = await evaluateDetailed(S2_RAW, {
      graphReader: createFileGraphReader({ confirmationsPath: signedConfirmationsPath }),
      modelClient: s2Model,
      runsDir: path.join(scratchDir, "runs-s2"),
    });

    const breakerCompactEv = run6.events.find(
      (e) => e.type === "lotfit.ledger_compacted" && e.data.trigger === "breaker",
    );
    const revokedToolEv = run6.events.find(
      (e) => e.type === "error" && e.data.code === "BREAKER_TOOL_REVOKED",
    );

    assertCheck(
      "T6.1 S2 size cap failure trips breaker immediately (lotfit.ledger_compacted trigger='breaker') and revokes placement tool in same batch",
      breakerCompactEv !== undefined && revokedToolEv !== undefined,
    );
    assertCheck(
      "T6.2 S2 concludes with verdict NO_LEGS and plan_limit 525 sqft",
      run6.report.verdict === "NO_LEGS" &&
        run6.report.plan_limit !== null &&
        run6.report.plan_limit.value === 525 &&
        run6.report.plan_limit.unit === "sqft",
      JSON.stringify(run6.report.plan_limit),
    );
  }

  await baseReader.close();
  console.log(`\n${passedCount}/${totalCount} W6 harness checks passed`);
  process.exit(passedCount === totalCount ? 0 : 1);
}

function makeUuid7ForTest(idx: number): string {
  return `019a5000-0000-7000-8000-${idx.toString(16).padStart(12, "0")}`;
}

main().catch((err) => {
  console.error("Fatal error in test-harness:", err);
  process.exit(1);
});
