/**
 * Test runner and fixture builder for the LotFit deterministic verifier (W7, milestone 1).
 *
 * Builds the clean S1 run fixture and the seven mutants (M1..M7), validates their
 * individual parts against the frozen contracts in `types.mts`, writes all fixtures
 * to `query/eval/mutants/`, runs `verify()` on each, and asserts:
 *   - clean S1 passes with 0 issues
 *   - M1 fails with only V1_COVERAGE
 *   - M2 fails with only V2_EVIDENCE
 *   - M3 fails with only V3_OUTCOME
 *   - M4 fails with only V4_NUMBER
 *   - M5 fails with only V5_VERDICT
 *   - M6 fails with only V7_PARAMETER
 *   - M7 fails with only V8_GUARD
 * Also tests V6_GEOMETRY directly on a synthetic marginal-recommended-placement run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { z } from "zod";
import * as C from "./types.mts";
import { verify, type VerifyInput } from "./verifier.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MUTANTS_DIR = path.resolve(__dirname, "..", "eval", "mutants");
mkdirSync(MUTANTS_DIR, { recursive: true });

const H_CASE = "c0d40163ebed0000000000000000000000000000000000000000000000000001";
const H_INDEX = "1111111111111111111111111111111111111111111111111111111111111111";
const H_CONFIG = "2222222222222222222222222222222222222222222222222222222222222222";
const H_QUOTE = "3333333333333333333333333333333333333333333333333333333333333333";
const GRAPH_LOAD_ID = "3e6c8679@2026-11-01T20:14:59Z";
const CASE_ID = "019a4000-0000-7000-8000-000000000001";
const THREAD_ID = "019a4000-0000-7000-8000-000000000010";
const TURN_ID = "019a4000-0000-7000-8000-000000000020";
const CREATED_AT = "2026-11-01T20:30:00Z";
const AS_OF = "2026-11-15";

// UUIDv7 call IDs for S1 tool calls
const CALL = {
  guard_gate_allow: "019a4000-0000-7000-8000-000000000101",
  guard_tree: "019a4000-0000-7000-8000-000000000102",
  guard_flag_lot: "019a4000-0000-7000-8000-000000000103",
  living_area: "019a4000-0000-7000-8000-000000000104",
  height: "019a4000-0000-7000-8000-000000000105",
  footprint_dim: "019a4000-0000-7000-8000-000000000106",
  setback_client_side: "019a4000-0000-7000-8000-000000000107",
  setback_client_rear: "019a4000-0000-7000-8000-000000000108",
  exception_client_245c2: "019a4000-0000-7000-8000-000000000109",
  front_or_behind_client: "019a4000-0000-7000-8000-00000000010a",
  acc_cov_client: "019a4000-0000-7000-8000-00000000010b",
  tot_cov_client: "019a4000-0000-7000-8000-00000000010c",
  find_placements: "019a4000-0000-7000-8000-00000000010d",
  setback_sel_side: "019a4000-0000-7000-8000-00000000010e",
  setback_sel_rear: "019a4000-0000-7000-8000-00000000010f",
  front_or_behind_sel: "019a4000-0000-7000-8000-000000000110",
  acc_cov_sel: "019a4000-0000-7000-8000-000000000111",
  tot_cov_sel: "019a4000-0000-7000-8000-000000000112",
  conclude: "019a4000-0000-7000-8000-000000000113",
  fake_unrequested: "019a4000-0000-7000-8000-000000000999",
} as const;

export function buildCleanS1(): VerifyInput {
  const resolved_params: VerifyInput["resolved_params"] = [
    {
      provision_id: "PDX.33.205.040.C.1",
      param: "max_share_of_primary_living_area",
      value: 75,
      unit: "%",
    },
    {
      provision_id: "PDX.33.205.040.C.1",
      param: "max_living_area",
      value: 800,
      unit: "sqft",
    },
    {
      provision_id: "PDX.33.110.245.C.1",
      param: "max_height",
      value: 20,
      unit: "ft",
    },
    {
      provision_id: "PDX.33.110.245.C.2",
      param: "max_footprint_dimension",
      value: 24,
      unit: "ft",
    },
    {
      provision_id: "PDX.33.110.245.C.2",
      param: "min_distance_from_front_lot_line",
      value: 40,
      unit: "ft",
    },
    {
      provision_id: "PDX.33.110.245.C.2",
      param: "max_wall_height_in_setback",
      value: 10,
      unit: "ft",
    },
    {
      provision_id: "PDX.T110-4",
      param: "side_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    {
      provision_id: "PDX.T110-4",
      param: "rear_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    {
      provision_id: "PDX.33.205.040.C.2",
      param: "front_lot_line_setback",
      value: 40,
      unit: "ft",
    },
    {
      provision_id: "PDX.33.110.245.C.3.a",
      param: "max_combined_accessory_coverage_pct_of_site",
      value: 20,
      unit: "%",
    },
    {
      provision_id: "PDX.T110-5",
      param: "T110-5:R3",
      value: 2250,
      unit: "sqft",
    },
  ];

  const index: VerifyInput["index"] = {
    graph_load_id: GRAPH_LOAD_ID,
    as_of: AS_OF,
    index_hash: H_INDEX,
    layers: [
      {
        layer: "PDX",
        order: 1,
        provisions: [
          {
            provision_id: "PDX.33.205.020.B.1.a",
            layer: "PDX",
            type: "gate",
            evaluation_stage: "gate",
            title: "Where ADUs are allowed in single-dwelling zones",
            section: "33.205.020",
            param_names: [],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.205.020.B.1.a#v1::sentence:1",
              scope_quote: "An accessory dwelling unit may be added to a house in RF through R2.5 zones.",
              source: "graph",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: false,
            modifies_operator_backed: false,
          },
          {
            provision_id: "PDX.11.50.020",
            layer: "PDX",
            type: "gate",
            evaluation_stage: "gate",
            title: "Tree preservation gate",
            section: "11.50.020",
            param_names: [],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.11.50.020#v1::sentence:1",
              scope_quote: "Tree preservation requirements apply when trees are present on the site.",
              source: "curated",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: false,
            modifies_operator_backed: false,
          },
          {
            provision_id: "PDX.33.110.255.B.1.a",
            layer: "PDX",
            type: "constraint",
            evaluation_stage: "placement_constraint",
            title: "Flag lot setbacks (large flag lots)",
            section: "33.110.255",
            param_names: ["flag_lot_setback.R5"],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.110.255.B.1.a#v1::sentence:1",
              scope_quote: "Large flag lots have required building setbacks that are the same along all lot lines.",
              source: "graph",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: true,
            modifies_operator_backed: true,
          },
          {
            provision_id: "PDX.33.205.040.C.1",
            layer: "PDX",
            type: "constraint",
            evaluation_stage: "plan_constraint",
            title: "Maximum living area for an ADU",
            section: "33.205.040",
            param_names: ["max_share_of_primary_living_area", "max_living_area"],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.205.040.C.1#v1::sentence:1",
              scope_quote: "The maximum living area for an ADU is 75 percent of the living area of the primary structure or 800 square feet, whichever is less.",
              source: "graph",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: true,
            modifies_operator_backed: false,
          },
          {
            provision_id: "PDX.33.110.245.C.1",
            layer: "PDX",
            type: "constraint",
            evaluation_stage: "plan_constraint",
            title: "Maximum height for detached covered accessory structures",
            section: "33.110.245",
            param_names: ["max_height"],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.110.245.C.1#v1::sentence:1",
              scope_quote: "The maximum height allowed for all detached covered accessory structures is 20 feet.",
              source: "graph",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: true,
            modifies_operator_backed: false,
          },
          {
            provision_id: "PDX.33.110.220.B",
            layer: "PDX",
            type: "constraint",
            evaluation_stage: "placement_constraint",
            title: "Required building setbacks",
            section: "33.110.220",
            param_names: ["side_building_setback.R5", "rear_building_setback.R5"],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.110.220.B#v1::sentence:1",
              scope_quote: "The required building setbacks are stated in Table 110-4.",
              source: "curated",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: true,
            modifies_operator_backed: false,
          },
          {
            provision_id: "PDX.33.205.040.C.2",
            layer: "PDX",
            type: "constraint",
            evaluation_stage: "placement_constraint",
            title: "ADU setback from front lot line or behind rear wall",
            section: "33.205.040",
            param_names: ["front_lot_line_setback"],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.205.040.C.2#v1::sentence:1",
              scope_quote: "Detached ADUs must be at least 40 feet from a front lot line or behind the rear wall of the primary structure.",
              source: "graph",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: true,
            modifies_operator_backed: true,
          },
          {
            provision_id: "PDX.33.110.245.C.3.a",
            layer: "PDX",
            type: "constraint",
            evaluation_stage: "placement_constraint",
            title: "Maximum combined coverage for detached covered accessory structures",
            section: "33.110.245",
            param_names: ["max_combined_accessory_coverage_pct_of_site"],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.110.245.C.3.a#v1::sentence:1",
              scope_quote: "The combined building coverage of all detached covered accessory structures may not exceed 20 percent of the total area of the site.",
              source: "graph",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: true,
            modifies_operator_backed: false,
          },
          {
            provision_id: "PDX.33.110.225.B",
            layer: "PDX",
            type: "constraint",
            evaluation_stage: "placement_constraint",
            title: "Maximum total building coverage",
            section: "33.110.225",
            param_names: [],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.110.225.B#v1::sentence:1",
              scope_quote: "The maximum combined building coverage for all covered structures on the site is stated in Table 110-5.",
              source: "curated",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: true,
            modifies_operator_backed: false,
          },
          {
            provision_id: "PDX.33.110.245.C.2",
            layer: "PDX",
            type: "exception",
            evaluation_stage: "exception",
            title: "Side and rear setback exception for detached covered accessory structures",
            section: "33.110.245",
            param_names: ["max_footprint_dimension", "max_wall_height_in_setback"],
            gray_areas: 0,
            scope: {
              applies_to_zones: ["R5"],
              project_kinds: ["adu"],
              scope_clause_id: "PDX.33.110.245.C.2#v1::item:b.",
              scope_quote: "In R7, R5, and R2.5 zones, detached covered accessory structures are allowed in the side and rear building setbacks if all of the following are met.",
              source: "graph",
            },
            in_force: { from: "2026-11-01", to: null, date_not_stated: false },
            has_operator: true,
            modifies_operator_backed: true,
          },
        ],
      },
    ],
  };

  const guards: VerifyInput["guards"] = {
    "PDX.33.205.020.B.1.a": {
      provision_id: "PDX.33.205.020.B.1.a",
      result: "known_true",
      guards: [
        {
          clause_id: "PDX.33.205.020.B.1.a#v1::sentence:1",
          fact: "site.zone",
          value: "R5",
          holds: true,
        },
      ],
    },
    "PDX.11.50.020": {
      provision_id: "PDX.11.50.020",
      result: "known_false",
      guards: [
        {
          clause_id: "PDX.11.50.020#v1::sentence:1",
          fact: "site.trees",
          value: false,
          holds: false,
        },
      ],
    },
    "PDX.33.110.255.B.1.a": {
      provision_id: "PDX.33.110.255.B.1.a",
      result: "known_false",
      guards: [
        {
          clause_id: "PDX.33.110.255.B.1.a#v1::sentence:1",
          fact: "site.flag_lot",
          value: false,
          holds: false,
        },
      ],
    },
  };

  const plan: VerifyInput["plan"] = {
    index_hash: H_INDEX,
    applies: [
      {
        provision_id: "PDX.33.205.020.B.1.a",
        scope_quote: "An accessory dwelling unit may be added to a house in RF through R2.5 zones.",
        facts_needed: ["site.zone"],
      },
      {
        provision_id: "PDX.33.205.040.C.1",
        scope_quote: "The maximum living area for an ADU is 75 percent of the living area of the primary structure or 800 square feet, whichever is less.",
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
        scope_quote: "Detached ADUs must be at least 40 feet from a front lot line or behind the rear wall of the primary structure.",
        facts_needed: ["site.front_lot_line", "site.house_rear_wall", "plan.outline"],
      },
      {
        provision_id: "PDX.33.110.245.C.3.a",
        scope_quote: "The combined building coverage of all detached covered accessory structures may not exceed 20 percent of the total area of the site.",
        facts_needed: ["site.lot_area_sqft", "site.structures", "plan.outline"],
      },
      {
        provision_id: "PDX.33.110.225.B",
        scope_quote: "The maximum combined building coverage for all covered structures on the site is stated in Table 110-5.",
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
  };

  // Real S1 MeasureResults & tool outputs
  const mrLivingArea = {
    value: 576,
    unit: "sqft",
    limit: {
      provision_id: "PDX.33.205.040.C.1",
      param: "max_living_area",
      value: 800,
      unit: "sqft",
    },
    margin: 224,
    tolerance: 0,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
    details: { share_sqft: 1050, cap_sqft: 800, binding: "cap" },
  };

  const mrHeight = {
    value: 15,
    unit: "ft",
    limit: {
      provision_id: "PDX.33.110.245.C.1",
      param: "max_height",
      value: 20,
      unit: "ft",
    },
    margin: 5,
    tolerance: 0,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
  };

  const mrClientWestSetback = {
    value: 2,
    unit: "ft",
    limit: {
      provision_id: "PDX.T110-4",
      param: "side_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    margin: -3,
    tolerance: 0.5,
    pass: false,
    too_close_to_call: false,
    dimension_to_tape: null,
    details: {
      nearest_segment: 0,
      per_segment: [
        { distance_ft: 2, margin_ft: -3 },
        { distance_ft: 24, margin_ft: 19 },
      ],
    },
  };

  const mrClientRearSetback = {
    value: 2,
    unit: "ft",
    limit: {
      provision_id: "PDX.T110-4",
      param: "rear_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    margin: -3,
    tolerance: 0.5,
    pass: false,
    too_close_to_call: false,
    dimension_to_tape: null,
  };

  const resExceptionClient = {
    exception_id: "PDX.33.110.245.C.2",
    base_provision_id: "PDX.33.110.220.B",
    pass: false,
    conditions: [
      {
        clause_id: "PDX.33.110.245.C.2#v1::item:b.(4)",
        name: "walls no more than 10 ft high in setback",
        holds: false,
        measure: {
          value: 12,
          unit: "ft",
          limit: {
            provision_id: "PDX.33.110.245.C.2",
            param: "max_wall_height_in_setback",
            value: 10,
            unit: "ft",
          },
          margin: -2,
          tolerance: 0,
          pass: false,
          too_close_to_call: false,
          dimension_to_tape: null,
        },
      },
      {
        clause_id: "PDX.33.110.245.C.2#v1::item:b.(6)",
        name: "no openings facing the lot line",
        holds: false,
        measure: null,
      },
    ],
  };

  const mrClientFrontOrBehind = {
    value: 74,
    unit: "ft",
    limit: {
      provision_id: "PDX.33.205.040.C.2",
      param: "front_lot_line_setback",
      value: 40,
      unit: "ft",
    },
    margin: 34,
    tolerance: 0.25,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
  };

  const mrAccCov = {
    value: 13.12,
    unit: "%",
    limit: {
      provision_id: "PDX.33.110.245.C.3.a",
      param: "max_combined_accessory_coverage_pct_of_site",
      value: 20,
      unit: "%",
    },
    margin: 6.88,
    tolerance: 0,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
    details: { covered_sqft: 656, allowed_sqft: 1000 },
  };

  const mrTotCov = {
    value: 1566,
    unit: "sqft",
    limit: {
      provision_id: "PDX.T110-5",
      param: "T110-5:R3",
      value: 2250,
      unit: "sqft",
    },
    margin: 684,
    tolerance: 0,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
  };

  const mrSelWestEastSetback = {
    value: 13,
    unit: "ft",
    limit: {
      provision_id: "PDX.T110-4",
      param: "side_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    margin: 8,
    tolerance: 0.5,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
    details: {
      nearest_segment: 0,
      per_segment: [
        { distance_ft: 13, margin_ft: 8 },
        { distance_ft: 13, margin_ft: 8 },
      ],
    },
  };

  const mrSelRearSetback = {
    value: 11,
    unit: "ft",
    limit: {
      provision_id: "PDX.T110-4",
      param: "rear_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    margin: 6,
    tolerance: 0.5,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
  };

  const mrSelFrontOrBehind = {
    value: 65,
    unit: "ft",
    limit: {
      provision_id: "PDX.33.205.040.C.2",
      param: "front_lot_line_setback",
      value: 40,
      unit: "ft",
    },
    margin: 25,
    tolerance: 0.25,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
  };

  const resFindPlacements = {
    count: 478,
    clear_count: 408,
    client_spot: {
      passes: false,
      failing: ["PDX.33.110.220.B"],
    },
    nearest_to_client: { x: 13, y: 65, rotation: 0 },
    max_clearance: { x: 13, y: 65, rotation: 0 },
    envelope_artifact: null,
  };

  // Helper to build tool_requested + tool_result event pairs
  let seq = 1;
  const events: VerifyInput["events"] = [];
  function addToolCallEvent(
    call_id: string,
    provision_id: string | null,
    target: z.infer<typeof C.Target>,
    tool: z.infer<typeof C.ToolName> | "record_finding" | "conclude",
    args: Record<string, unknown>,
    resultObj: unknown,
    ok = true,
  ) {
    const reqId = `019a4000-0000-7000-8000-${String(1000 + seq).padStart(12, "0")}`;
    events.push({
      id: reqId,
      thread_id: THREAD_ID,
      session_id: null,
      turn_id: TURN_ID,
      seq: seq++,
      created_at: CREATED_AT,
      config_hash: H_CONFIG,
      graph_load_id: GRAPH_LOAD_ID,
      type: "tool_requested",
      data: {
        call: {
          call_id,
          turn_id: TURN_ID,
          provision_id,
          target,
          tool,
          args,
        },
      },
    });
    const resId = `019a4000-0000-7000-8000-${String(1000 + seq).padStart(12, "0")}`;
    events.push({
      id: resId,
      thread_id: THREAD_ID,
      session_id: null,
      turn_id: TURN_ID,
      seq: seq++,
      created_at: CREATED_AT,
      config_hash: H_CONFIG,
      graph_load_id: GRAPH_LOAD_ID,
      type: "tool_result",
      data: {
        call_id,
        cached: false,
        ok,
        preview: JSON.stringify(resultObj),
        duration_ms: 1.5,
      },
    });
  }

  function addRecordedFindingEvent(finding: z.infer<typeof C.RecordFinding>) {
    const evId = `019a4000-0000-7000-8000-${String(1000 + seq).padStart(12, "0")}`;
    events.push({
      id: evId,
      thread_id: THREAD_ID,
      session_id: null,
      turn_id: TURN_ID,
      seq: seq++,
      created_at: CREATED_AT,
      config_hash: H_CONFIG,
      graph_load_id: GRAPH_LOAD_ID,
      type: "lotfit.finding_recorded",
      data: {
        finding,
        accepted: true,
        repairs: [],
      },
    });
  }

  // Populate tool calls in events
  addToolCallEvent(
    CALL.guard_gate_allow,
    "PDX.33.205.020.B.1.a",
    "case",
    "evaluate_guards",
    { provision_id: "PDX.33.205.020.B.1.a", target: "case" },
    guards["PDX.33.205.020.B.1.a"],
  );
  addToolCallEvent(
    CALL.guard_tree,
    "PDX.11.50.020",
    "case",
    "evaluate_guards",
    { provision_id: "PDX.11.50.020", target: "case" },
    guards["PDX.11.50.020"],
  );
  addToolCallEvent(
    CALL.guard_flag_lot,
    "PDX.33.110.255.B.1.a",
    "case",
    "evaluate_guards",
    { provision_id: "PDX.33.110.255.B.1.a", target: "case" },
    guards["PDX.33.110.255.B.1.a"],
  );
  addToolCallEvent(
    CALL.living_area,
    "PDX.33.205.040.C.1",
    "case",
    "adu_max_living_area",
    {
      provision_id: "PDX.33.205.040.C.1",
      target: "case",
      primary_living_area: { fact: "site.primary_living_area_sqft" },
      plan_living_area: { fact: "plan.living_area_sqft" },
      share: { provision_id: "PDX.33.205.040.C.1", param: "max_share_of_primary_living_area" },
      cap: { provision_id: "PDX.33.205.040.C.1", param: "max_living_area" },
    },
    mrLivingArea,
  );
  addToolCallEvent(
    CALL.height,
    "PDX.33.110.245.C.1",
    "case",
    "check_max",
    {
      provision_id: "PDX.33.110.245.C.1",
      target: "case",
      value: { fact: "plan.height_ft" },
      limit: { provision_id: "PDX.33.110.245.C.1", param: "max_height" },
    },
    mrHeight,
  );
  addToolCallEvent(
    CALL.setback_client_side,
    "PDX.33.110.220.B",
    "client_spot",
    "check_setback",
    {
      provision_id: "PDX.33.110.220.B",
      target: "client_spot",
      outline: { fact: "plan.outline" },
      lines: { fact: "site.side_lot_lines" },
      min: { provision_id: "PDX.T110-4", param: "side_building_setback.R5" },
    },
    mrClientWestSetback,
  );
  addToolCallEvent(
    CALL.setback_client_rear,
    "PDX.33.110.220.B",
    "client_spot",
    "check_setback",
    {
      provision_id: "PDX.33.110.220.B",
      target: "client_spot",
      outline: { fact: "plan.outline" },
      lines: { fact: "site.rear_lot_line" },
      min: { provision_id: "PDX.T110-4", param: "rear_building_setback.R5" },
    },
    mrClientRearSetback,
  );
  addToolCallEvent(
    CALL.exception_client_245c2,
    "PDX.33.110.245.C.2",
    "client_spot",
    "check_exception_conditions",
    {
      provision_id: "PDX.33.110.245.C.2",
      target: "client_spot",
      exception_id: "PDX.33.110.245.C.2",
      base_provision_id: "PDX.33.110.220.B",
      outline: { fact: "plan.outline" },
    },
    resExceptionClient,
  );
  addToolCallEvent(
    CALL.front_or_behind_client,
    "PDX.33.205.040.C.2",
    "client_spot",
    "check_front_or_behind",
    {
      provision_id: "PDX.33.205.040.C.2",
      target: "client_spot",
      outline: { fact: "plan.outline" },
      front_lot_line: { fact: "site.front_lot_line" },
      min_front: { provision_id: "PDX.33.205.040.C.2", param: "front_lot_line_setback" },
      house_rear_wall: { fact: "site.house_rear_wall" },
    },
    mrClientFrontOrBehind,
  );
  addToolCallEvent(
    CALL.acc_cov_client,
    "PDX.33.110.245.C.3.a",
    "client_spot",
    "coverage_share",
    {
      provision_id: "PDX.33.110.245.C.3.a",
      target: "client_spot",
      outlines: [{ fact: "plan.outline" }, { fact: "site.structures" }],
      lot_area: { fact: "site.lot_area_sqft" },
      limit: { provision_id: "PDX.33.110.245.C.3.a", param: "max_combined_accessory_coverage_pct_of_site" },
    },
    mrAccCov,
  );
  addToolCallEvent(
    CALL.tot_cov_client,
    "PDX.33.110.225.B",
    "client_spot",
    "total_building_coverage",
    {
      provision_id: "PDX.33.110.225.B",
      target: "client_spot",
      outlines: [{ fact: "plan.outline" }, { fact: "site.house_outline" }, { fact: "site.structures" }],
      lot_area: { fact: "site.lot_area_sqft" },
      cap_cell: { provision_id: "PDX.T110-5", cell_id: "T110-5:R3" },
    },
    mrTotCov,
  );
  addToolCallEvent(
    CALL.find_placements,
    "PDX.33.110.220.B",
    "selected_placement",
    "find_placements",
    {
      provision_id: "PDX.33.110.220.B",
      target: "selected_placement",
      footprint: { fact: "plan.footprint" },
      rotations: [0],
      setback_provisions: ["PDX.33.110.220.B", "PDX.33.205.040.C.2"],
    },
    resFindPlacements,
  );
  addToolCallEvent(
    CALL.setback_sel_side,
    "PDX.33.110.220.B",
    "selected_placement",
    "check_setback",
    {
      provision_id: "PDX.33.110.220.B",
      target: "selected_placement",
      outline: { placed: { x: 13, y: 65, rotation: 0 }, footprint: { fact: "plan.footprint" } },
      lines: { fact: "site.side_lot_lines" },
      min: { provision_id: "PDX.T110-4", param: "side_building_setback.R5" },
    },
    mrSelWestEastSetback,
  );
  addToolCallEvent(
    CALL.setback_sel_rear,
    "PDX.33.110.220.B",
    "selected_placement",
    "check_setback",
    {
      provision_id: "PDX.33.110.220.B",
      target: "selected_placement",
      outline: { placed: { x: 13, y: 65, rotation: 0 }, footprint: { fact: "plan.footprint" } },
      lines: { fact: "site.rear_lot_line" },
      min: { provision_id: "PDX.T110-4", param: "rear_building_setback.R5" },
    },
    mrSelRearSetback,
  );
  addToolCallEvent(
    CALL.front_or_behind_sel,
    "PDX.33.205.040.C.2",
    "selected_placement",
    "check_front_or_behind",
    {
      provision_id: "PDX.33.205.040.C.2",
      target: "selected_placement",
      outline: { placed: { x: 13, y: 65, rotation: 0 }, footprint: { fact: "plan.footprint" } },
      front_lot_line: { fact: "site.front_lot_line" },
      min_front: { provision_id: "PDX.33.205.040.C.2", param: "front_lot_line_setback" },
      house_rear_wall: { fact: "site.house_rear_wall" },
    },
    mrSelFrontOrBehind,
  );
  addToolCallEvent(
    CALL.acc_cov_sel,
    "PDX.33.110.245.C.3.a",
    "selected_placement",
    "coverage_share",
    {
      provision_id: "PDX.33.110.245.C.3.a",
      target: "selected_placement",
      outlines: [
        { placed: { x: 13, y: 65, rotation: 0 }, footprint: { fact: "plan.footprint" } },
        { fact: "site.structures" },
      ],
      lot_area: { fact: "site.lot_area_sqft" },
      limit: { provision_id: "PDX.33.110.245.C.3.a", param: "max_combined_accessory_coverage_pct_of_site" },
    },
    mrAccCov,
  );
  addToolCallEvent(
    CALL.tot_cov_sel,
    "PDX.33.110.225.B",
    "selected_placement",
    "total_building_coverage",
    {
      provision_id: "PDX.33.110.225.B",
      target: "selected_placement",
      outlines: [
        { placed: { x: 13, y: 65, rotation: 0 }, footprint: { fact: "plan.footprint" } },
        { fact: "site.house_outline" },
        { fact: "site.structures" },
      ],
      lot_area: { fact: "site.lot_area_sqft" },
      cap_cell: { provision_id: "PDX.T110-5", cell_id: "T110-5:R3" },
    },
    mrTotCov,
  );

  // Record findings in event log with explicit numbers[] and paths
  const recordedList: z.infer<typeof C.RecordFinding>[] = [
    {
      provision_id: "PDX.33.205.020.B.1.a",
      target: "case",
      clause_ids: ["PDX.33.205.020.B.1.a#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.guard_gate_allow],
      numbers: [],
      quotes: [
        {
          clause_id: "PDX.33.205.020.B.1.a#v1::sentence:1",
          quote: "An accessory dwelling unit may be added to a house in RF through R2.5 zones.",
        },
      ],
    },
    {
      provision_id: "PDX.11.50.020",
      target: "case",
      clause_ids: ["PDX.11.50.020#v1::sentence:1"],
      outcome: "not_applicable",
      evidence_call_ids: [CALL.guard_tree],
      numbers: [],
      quotes: [
        {
          clause_id: "PDX.11.50.020#v1::sentence:1",
          quote: "Tree preservation requirements apply when trees are present on the site.",
        },
      ],
    },
    {
      provision_id: "PDX.33.205.040.C.1",
      target: "case",
      clause_ids: ["PDX.33.205.040.C.1#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.living_area],
      numbers: [
        { value: 576, unit: "sqft", call_id: CALL.living_area, path: "value" },
        { value: 800, unit: "sqft", call_id: CALL.living_area, path: "limit.value" },
        { value: 224, unit: "sqft", call_id: CALL.living_area, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.205.040.C.1#v1::sentence:1",
          quote: "The maximum living area for an ADU is 75 percent of the living area of the primary structure or 800 square feet, whichever is less.",
        },
      ],
    },
    {
      provision_id: "PDX.33.110.245.C.1",
      target: "case",
      clause_ids: ["PDX.33.110.245.C.1#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.height],
      numbers: [
        { value: 15, unit: "ft", call_id: CALL.height, path: "value" },
        { value: 20, unit: "ft", call_id: CALL.height, path: "limit.value" },
        { value: 5, unit: "ft", call_id: CALL.height, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.110.245.C.1#v1::sentence:1",
          quote: "The maximum height allowed for all detached covered accessory structures is 20 feet.",
        },
      ],
    },
    {
      provision_id: "PDX.33.110.220.B",
      target: "client_spot",
      clause_ids: ["PDX.33.110.220.B#v1::sentence:1"],
      outcome: "fail",
      evidence_call_ids: [CALL.setback_client_side, CALL.setback_client_rear],
      numbers: [
        { value: 2, unit: "ft", call_id: CALL.setback_client_side, path: "value" },
        { value: 5, unit: "ft", call_id: CALL.setback_client_side, path: "limit.value" },
        { value: -3, unit: "ft", call_id: CALL.setback_client_side, path: "margin" },
        { value: -3, unit: "ft", call_id: CALL.setback_client_rear, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.110.220.B#v1::sentence:1",
          quote: "The required building setbacks are stated in Table 110-4.",
        },
      ],
    },
    {
      provision_id: "PDX.33.110.245.C.2",
      target: "client_spot",
      clause_ids: ["PDX.33.110.245.C.2#v1::item:b.(4)", "PDX.33.110.245.C.2#v1::item:b.(6)"],
      outcome: "fail",
      evidence_call_ids: [CALL.exception_client_245c2],
      numbers: [
        { value: 12, unit: "ft", call_id: CALL.exception_client_245c2, path: "conditions.0.measure.value" },
        { value: 10, unit: "ft", call_id: CALL.exception_client_245c2, path: "conditions.0.measure.limit.value" },
        { value: -2, unit: "ft", call_id: CALL.exception_client_245c2, path: "conditions.0.measure.margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.110.245.C.2#v1::item:b.(4)",
          quote: "The structure is no more than 15 feet high, and the walls of the structure are no more than 10 feet high, excluding the portion of the wall within a gable.",
        },
      ],
    },
    {
      provision_id: "PDX.33.205.040.C.2",
      target: "client_spot",
      clause_ids: ["PDX.33.205.040.C.2#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.front_or_behind_client],
      numbers: [
        { value: 74, unit: "ft", call_id: CALL.front_or_behind_client, path: "value" },
        { value: 40, unit: "ft", call_id: CALL.front_or_behind_client, path: "limit.value" },
        { value: 34, unit: "ft", call_id: CALL.front_or_behind_client, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.205.040.C.2#v1::sentence:1",
          quote: "Detached ADUs must be at least 40 feet from a front lot line or behind the rear wall of the primary structure.",
        },
      ],
    },
    {
      provision_id: "PDX.33.110.245.C.3.a",
      target: "client_spot",
      clause_ids: ["PDX.33.110.245.C.3.a#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.acc_cov_client],
      numbers: [
        { value: 13.12, unit: "%", call_id: CALL.acc_cov_client, path: "value" },
        { value: 20, unit: "%", call_id: CALL.acc_cov_client, path: "limit.value" },
        { value: 6.88, unit: "%", call_id: CALL.acc_cov_client, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.110.245.C.3.a#v1::sentence:1",
          quote: "The combined building coverage of all detached covered accessory structures may not exceed 20 percent of the total area of the site.",
        },
      ],
    },
    {
      provision_id: "PDX.33.110.225.B",
      target: "client_spot",
      clause_ids: ["PDX.33.110.225.B#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.tot_cov_client],
      numbers: [
        { value: 1566, unit: "sqft", call_id: CALL.tot_cov_client, path: "value" },
        { value: 2250, unit: "sqft", call_id: CALL.tot_cov_client, path: "limit.value" },
        { value: 684, unit: "sqft", call_id: CALL.tot_cov_client, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.110.225.B#v1::sentence:1",
          quote: "The maximum combined building coverage for all covered structures on the site is stated in Table 110-5.",
        },
      ],
    },
    {
      provision_id: "PDX.33.110.220.B",
      target: "selected_placement",
      clause_ids: ["PDX.33.110.220.B#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.setback_sel_side, CALL.setback_sel_rear],
      numbers: [
        { value: 8, unit: "ft", call_id: CALL.setback_sel_side, path: "margin" },
        { value: 8, unit: "ft", call_id: CALL.setback_sel_side, path: "details.per_segment.1.margin_ft" },
        { value: 6, unit: "ft", call_id: CALL.setback_sel_rear, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.110.220.B#v1::sentence:1",
          quote: "The required building setbacks are stated in Table 110-4.",
        },
      ],
    },
    {
      provision_id: "PDX.33.205.040.C.2",
      target: "selected_placement",
      clause_ids: ["PDX.33.205.040.C.2#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.front_or_behind_sel],
      numbers: [
        { value: 65, unit: "ft", call_id: CALL.front_or_behind_sel, path: "value" },
        { value: 40, unit: "ft", call_id: CALL.front_or_behind_sel, path: "limit.value" },
        { value: 25, unit: "ft", call_id: CALL.front_or_behind_sel, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.205.040.C.2#v1::sentence:1",
          quote: "Detached ADUs must be at least 40 feet from a front lot line or behind the rear wall of the primary structure.",
        },
      ],
    },
    {
      provision_id: "PDX.33.110.245.C.3.a",
      target: "selected_placement",
      clause_ids: ["PDX.33.110.245.C.3.a#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.acc_cov_sel],
      numbers: [
        { value: 13.12, unit: "%", call_id: CALL.acc_cov_sel, path: "value" },
        { value: 20, unit: "%", call_id: CALL.acc_cov_sel, path: "limit.value" },
        { value: 6.88, unit: "%", call_id: CALL.acc_cov_sel, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.110.245.C.3.a#v1::sentence:1",
          quote: "The combined building coverage of all detached covered accessory structures may not exceed 20 percent of the total area of the site.",
        },
      ],
    },
    {
      provision_id: "PDX.33.110.225.B",
      target: "selected_placement",
      clause_ids: ["PDX.33.110.225.B#v1::sentence:1"],
      outcome: "pass",
      evidence_call_ids: [CALL.tot_cov_sel],
      numbers: [
        { value: 1566, unit: "sqft", call_id: CALL.tot_cov_sel, path: "value" },
        { value: 2250, unit: "sqft", call_id: CALL.tot_cov_sel, path: "limit.value" },
        { value: 684, unit: "sqft", call_id: CALL.tot_cov_sel, path: "margin" },
      ],
      quotes: [
        {
          clause_id: "PDX.33.110.225.B#v1::sentence:1",
          quote: "The maximum combined building coverage for all covered structures on the site is stated in Table 110-5.",
        },
      ],
    },
  ];

  for (const rf of recordedList) {
    addRecordedFindingEvent(rf);
  }

  addToolCallEvent(
    CALL.conclude,
    null,
    "case",
    "conclude",
    {
      verdict: "FITS",
      summary: "Client spot (2, 74) fails the 5 ft west and rear setbacks by 3 ft and fails 245.C.2 (12 ft wall height, openings facing lot line); recommended placement (13, 65) clears all setbacks with margins 8 ft, 8 ft, and 6 ft.",
      selected_placement: { x: 13, y: 65, rotation: 0 },
      client_spot_passes: false,
    },
    { accepted: true },
  );

  // Build ReportFindings matching recordedList
  const makeCitation = (clause_id: string, quote: string) => ({
    document: "Portland Zoning Code Title 33",
    page: null,
    clause_id,
    quote,
    sha256: H_QUOTE,
  });

  const reportFindings: VerifyInput["report"]["findings"] = [
    {
      provision_id: "PDX.33.205.020.B.1.a",
      target: "case",
      outcome: "pass",
      evaluation_stage: "gate",
      citations: [
        makeCitation(
          "PDX.33.205.020.B.1.a#v1::sentence:1",
          "An accessory dwelling unit may be added to a house in RF through R2.5 zones.",
        ),
      ],
      params: [],
      measures: [],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.guard_gate_allow],
    },
    {
      provision_id: "PDX.11.50.020",
      target: "case",
      outcome: "not_applicable",
      evaluation_stage: "gate",
      citations: [
        makeCitation(
          "PDX.11.50.020#v1::sentence:1",
          "Tree preservation requirements apply when trees are present on the site.",
        ),
      ],
      params: [],
      measures: [],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.guard_tree],
    },
    {
      provision_id: "PDX.33.205.040.C.1",
      target: "case",
      outcome: "pass",
      evaluation_stage: "plan_constraint",
      citations: [
        makeCitation(
          "PDX.33.205.040.C.1#v1::sentence:1",
          "The maximum living area for an ADU is 75 percent of the living area of the primary structure or 800 square feet, whichever is less.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.33.205.040.C.1",
          param: "max_living_area",
          value: 800,
          unit: "sqft",
        },
      ],
      measures: [mrLivingArea],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.living_area],
    },
    {
      provision_id: "PDX.33.110.245.C.1",
      target: "case",
      outcome: "pass",
      evaluation_stage: "plan_constraint",
      citations: [
        makeCitation(
          "PDX.33.110.245.C.1#v1::sentence:1",
          "The maximum height allowed for all detached covered accessory structures is 20 feet.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.33.110.245.C.1",
          param: "max_height",
          value: 20,
          unit: "ft",
        },
      ],
      measures: [mrHeight],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.height],
    },
    {
      provision_id: "PDX.33.110.220.B",
      target: "client_spot",
      outcome: "fail",
      evaluation_stage: "placement_constraint",
      citations: [
        makeCitation(
          "PDX.33.110.220.B#v1::sentence:1",
          "The required building setbacks are stated in Table 110-4.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.T110-4",
          param: "side_building_setback.R5",
          value: 5,
          unit: "ft",
        },
        {
          provision_id: "PDX.T110-4",
          param: "rear_building_setback.R5",
          value: 5,
          unit: "ft",
        },
      ],
      measures: [mrClientWestSetback, mrClientRearSetback],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.setback_client_side, CALL.setback_client_rear],
    },
    {
      provision_id: "PDX.33.110.245.C.2",
      target: "client_spot",
      outcome: "fail",
      evaluation_stage: "exception",
      citations: [
        makeCitation(
          "PDX.33.110.245.C.2#v1::item:b.(4)",
          "The structure is no more than 15 feet high, and the walls of the structure are no more than 10 feet high, excluding the portion of the wall within a gable.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.33.110.245.C.2",
          param: "max_wall_height_in_setback",
          value: 10,
          unit: "ft",
        },
      ],
      measures: [resExceptionClient.conditions[0]!.measure!],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.exception_client_245c2],
    },
    {
      provision_id: "PDX.33.205.040.C.2",
      target: "client_spot",
      outcome: "pass",
      evaluation_stage: "placement_constraint",
      citations: [
        makeCitation(
          "PDX.33.205.040.C.2#v1::sentence:1",
          "Detached ADUs must be at least 40 feet from a front lot line or behind the rear wall of the primary structure.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.33.205.040.C.2",
          param: "front_lot_line_setback",
          value: 40,
          unit: "ft",
        },
      ],
      measures: [mrClientFrontOrBehind],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.front_or_behind_client],
    },
    {
      provision_id: "PDX.33.110.245.C.3.a",
      target: "client_spot",
      outcome: "pass",
      evaluation_stage: "placement_constraint",
      citations: [
        makeCitation(
          "PDX.33.110.245.C.3.a#v1::sentence:1",
          "The combined building coverage of all detached covered accessory structures may not exceed 20 percent of the total area of the site.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.33.110.245.C.3.a",
          param: "max_combined_accessory_coverage_pct_of_site",
          value: 20,
          unit: "%",
        },
      ],
      measures: [mrAccCov],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.acc_cov_client],
    },
    {
      provision_id: "PDX.33.110.225.B",
      target: "client_spot",
      outcome: "pass",
      evaluation_stage: "placement_constraint",
      citations: [
        makeCitation(
          "PDX.33.110.225.B#v1::sentence:1",
          "The maximum combined building coverage for all covered structures on the site is stated in Table 110-5.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.T110-5",
          param: "T110-5:R3",
          value: 2250,
          unit: "sqft",
        },
      ],
      measures: [mrTotCov],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.tot_cov_client],
    },
    {
      provision_id: "PDX.33.110.220.B",
      target: "selected_placement",
      outcome: "pass",
      evaluation_stage: "placement_constraint",
      citations: [
        makeCitation(
          "PDX.33.110.220.B#v1::sentence:1",
          "The required building setbacks are stated in Table 110-4.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.T110-4",
          param: "side_building_setback.R5",
          value: 5,
          unit: "ft",
        },
        {
          provision_id: "PDX.T110-4",
          param: "rear_building_setback.R5",
          value: 5,
          unit: "ft",
        },
      ],
      measures: [mrSelWestEastSetback, mrSelRearSetback],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.setback_sel_side, CALL.setback_sel_rear],
    },
    {
      provision_id: "PDX.33.205.040.C.2",
      target: "selected_placement",
      outcome: "pass",
      evaluation_stage: "placement_constraint",
      citations: [
        makeCitation(
          "PDX.33.205.040.C.2#v1::sentence:1",
          "Detached ADUs must be at least 40 feet from a front lot line or behind the rear wall of the primary structure.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.33.205.040.C.2",
          param: "front_lot_line_setback",
          value: 40,
          unit: "ft",
        },
      ],
      measures: [mrSelFrontOrBehind],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.front_or_behind_sel],
    },
    {
      provision_id: "PDX.33.110.245.C.3.a",
      target: "selected_placement",
      outcome: "pass",
      evaluation_stage: "placement_constraint",
      citations: [
        makeCitation(
          "PDX.33.110.245.C.3.a#v1::sentence:1",
          "The combined building coverage of all detached covered accessory structures may not exceed 20 percent of the total area of the site.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.33.110.245.C.3.a",
          param: "max_combined_accessory_coverage_pct_of_site",
          value: 20,
          unit: "%",
        },
      ],
      measures: [mrAccCov],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.acc_cov_sel],
    },
    {
      provision_id: "PDX.33.110.225.B",
      target: "selected_placement",
      outcome: "pass",
      evaluation_stage: "placement_constraint",
      citations: [
        makeCitation(
          "PDX.33.110.225.B#v1::sentence:1",
          "The maximum combined building coverage for all covered structures on the site is stated in Table 110-5.",
        ),
      ],
      params: [
        {
          provision_id: "PDX.T110-5",
          param: "T110-5:R3",
          value: 2250,
          unit: "sqft",
        },
      ],
      measures: [mrTotCov],
      confirmation: "confirmed",
      evidence_call_ids: [CALL.tot_cov_sel],
    },
  ];

  // Recommended placement margins (8 ft west, 8 ft east, 6 ft rear)
  const mrMarginWest = {
    value: 13,
    unit: "ft",
    limit: {
      provision_id: "PDX.T110-4",
      param: "side_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    margin: 8,
    tolerance: 0.5,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
  };
  const mrMarginEast = {
    value: 13,
    unit: "ft",
    limit: {
      provision_id: "PDX.T110-4",
      param: "side_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    margin: 8,
    tolerance: 0.5,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
  };
  const mrMarginRear = {
    value: 11,
    unit: "ft",
    limit: {
      provision_id: "PDX.T110-4",
      param: "rear_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    margin: 6,
    tolerance: 0.5,
    pass: true,
    too_close_to_call: false,
    dimension_to_tape: null,
  };

  const report: VerifyInput["report"] = {
    schema: "lotfit.evaluation-report/1",
    case_id: CASE_ID,
    case_hash: H_CASE,
    graph_load_id: GRAPH_LOAD_ID,
    config_hash: H_CONFIG,
    as_of: { date: AS_OF, meaning: "planned_submittal" },
    verdict: "FITS",
    model_verdict: "FITS",
    verdict_note: null,
    banner: "Pre-feasibility only; not a permit decision.",
    plan_limit: null,
    placement: {
      client_spot: {
        placement: { x: 2, y: 74, rotation: 0 },
        passes: false,
        failing: ["PDX.33.110.220.B"],
        rejected_exceptions: ["PDX.33.110.245.C.2"],
      },
      recommended: {
        placement: { x: 13, y: 65, rotation: 0 },
        margins: [mrMarginWest, mrMarginEast, mrMarginRear],
        solar: null,
      },
      search: resFindPlacements,
    },
    findings: reportFindings,
    dispositions_relied_on: [],
    conflicts: [],
    assumptions: [],
    conditions: [],
    questions: [],
    not_found: [],
    unchecked: [],
    verifier: { passed: true, issues: [] },
    critic: null,
    telemetry: {
      tokens: 24500,
      calls: 19,
      turns: 7,
      wall_s_plan_execute: 28.4,
      wall_s_total: 34.1,
      cost_usd: 0.032,
      models: { agent: "meta-models/muse-spark-open-1026" },
    },
  };

  const case_facts: VerifyInput["case_facts"] = {
    "site.zone": "R5",
    "site.lot_area_sqft": 5000,
    "site.primary_living_area_sqft": 1400,
    "site.trees": false,
    "site.flag_lot": false,
    "plan.kind": "adu",
    "plan.detached": true,
    "plan.living_area_sqft": 576,
    "plan.height_ft": 15,
    "plan.wall_height_ft": 12,
    "plan.openings_facing_lot_line": true,
    "plan.placement": { x: 2, y: 74, rotation: 0 },
  };

  return {
    index,
    guards,
    plan,
    events,
    report,
    resolved_params,
    case_facts,
  };
}

// ------------------------------------------------------------------
// Mutants M1..M7
// ------------------------------------------------------------------

/**
 * M1 (V1_COVERAGE): a planned provision's finding is deleted (`PDX.33.110.245.C.1` height cap).
 */
function buildMutantM1(clean: VerifyInput): VerifyInput {
  const m = structuredClone(clean);
  m.report.findings = m.report.findings.filter((f) => f.provision_id !== "PDX.33.110.245.C.1");
  return m;
}

/**
 * M2 (V2_EVIDENCE): a finding cites a fake call_id (`019a4000-0000-7000-8000-000000000999`)
 * in addition to its valid call_id so V3/V4/V7 remain clean and only V2_EVIDENCE fires.
 */
function buildMutantM2(clean: VerifyInput): VerifyInput {
  const m = structuredClone(clean);
  const f = m.report.findings.find(
    (x) => x.provision_id === "PDX.33.110.245.C.1" && x.target === "case",
  )!;
  f.evidence_call_ids.push(CALL.fake_unrequested);
  return m;
}

/**
 * M3 (V3_OUTCOME): an outcome is flipped from `fail` to `pass` (`PDX.33.110.245.C.2` exception at
 * client_spot; client_spot still fails `PDX.33.110.220.B` so `client_spot.passes` stays `false`
 * and V5 does not fire).
 */
function buildMutantM3(clean: VerifyInput): VerifyInput {
  const m = structuredClone(clean);
  const f = m.report.findings.find(
    (x) => x.provision_id === "PDX.33.110.245.C.2" && x.target === "client_spot",
  )!;
  f.outcome = "pass";
  return m;
}

/**
 * M4 (V4_NUMBER): a dropped minus sign on the client-spot setback margin (`-3` written as `3`
 * in the recorded finding's `numbers[]` for `PDX.33.110.220.B` at `client_spot`).
 */
function buildMutantM4(clean: VerifyInput): VerifyInput {
  const m = structuredClone(clean);
  for (const ev of m.events) {
    if (
      ev.type === "lotfit.finding_recorded" &&
      ev.data.finding.provision_id === "PDX.33.110.220.B" &&
      ev.data.finding.target === "client_spot"
    ) {
      const marginEntry = ev.data.finding.numbers.find(
        (n) => n.call_id === CALL.setback_client_side && n.path === "margin",
      )!;
      marginEntry.value = 3; // dropped minus sign (-3 -> 3)
    }
  }
  return m;
}

/**
 * M5 (V5_VERDICT): `report.model_verdict` flipped to `NO_LEGS` while code's entailed `verdict` is `FITS`.
 */
function buildMutantM5(clean: VerifyInput): VerifyInput {
  const m = structuredClone(clean);
  m.report.model_verdict = "NO_LEGS";
  return m;
}

/**
 * M6 (V7_PARAMETER): a limit of 4 ft where the resolved parameter is 5 ft (`side_building_setback.R5`
 * in the cited `check_setback` result and finding measure, keeping numbers consistent so V4 stays quiet
 * and only V7_PARAMETER catches the drifted legal limit).
 */
function buildMutantM6(clean: VerifyInput): VerifyInput {
  const m = structuredClone(clean);
  // Update the cited tool result for CALL.setback_client_side: limit 4 ft instead of 5 ft
  for (const ev of m.events) {
    if (ev.type === "tool_result" && ev.data.call_id === CALL.setback_client_side) {
      const parsed = JSON.parse(ev.data.preview);
      parsed.limit.value = 4;
      parsed.margin = -2;
      ev.data.preview = JSON.stringify(parsed);
    }
    if (
      ev.type === "lotfit.finding_recorded" &&
      ev.data.finding.provision_id === "PDX.33.110.220.B" &&
      ev.data.finding.target === "client_spot"
    ) {
      for (const n of ev.data.finding.numbers) {
        if (n.call_id === CALL.setback_client_side && n.path === "limit.value") n.value = 4;
        if (n.call_id === CALL.setback_client_side && n.path === "margin") n.value = -2;
      }
    }
  }
  const f = m.report.findings.find(
    (x) => x.provision_id === "PDX.33.110.220.B" && x.target === "client_spot",
  )!;
  f.measures[0]!.limit!.value = 4;
  f.measures[0]!.margin = -2;
  return m;
}

/**
 * M7 (V8_GUARD): a `not_applicable` finding (`PDX.11.50.020`) cites an `evaluate_guards` call
 * whose result is `unknown` instead of `known_false`.
 */
function buildMutantM7(clean: VerifyInput): VerifyInput {
  const m = structuredClone(clean);
  m.guards["PDX.11.50.020"] = {
    provision_id: "PDX.11.50.020",
    result: "unknown",
    guards: [
      {
        clause_id: "PDX.11.50.020#v1::sentence:1",
        fact: "site.trees",
        value: null,
        holds: null,
      },
    ],
  };
  for (const ev of m.events) {
    if (ev.type === "tool_result" && ev.data.call_id === CALL.guard_tree) {
      ev.data.preview = JSON.stringify(m.guards["PDX.11.50.020"]);
    }
  }
  return m;
}

// ------------------------------------------------------------------
// Contract validation of clean S1 and mutant fixtures + test execution
// ------------------------------------------------------------------

function validateFixtureSchemas(name: string, input: VerifyInput, checkReportRefinements = true): string[] {
  const errs: string[] = [];
  const rIndex = C.LayerIndex.safeParse(input.index);
  if (!rIndex.success) errs.push(`${name}: index failed C.LayerIndex: ${rIndex.error.message}`);

  for (const [k, g] of Object.entries(input.guards)) {
    const rGuard = C.GuardResult.safeParse(g);
    if (!rGuard.success) errs.push(`${name}: guards[${k}] failed C.GuardResult: ${rGuard.error.message}`);
  }

  const rPlan = C.Plan.safeParse(input.plan);
  if (!rPlan.success) errs.push(`${name}: plan failed C.Plan: ${rPlan.error.message}`);

  for (let i = 0; i < input.events.length; i++) {
    const rEv = C.LotFitEvent.safeParse(input.events[i]);
    if (!rEv.success) errs.push(`${name}: events[${i}] failed C.LotFitEvent: ${rEv.error.message}`);
  }

  for (let i = 0; i < input.resolved_params.length; i++) {
    const rParam = C.ResolvedParam.safeParse(input.resolved_params[i]);
    if (!rParam.success) errs.push(`${name}: resolved_params[${i}] failed C.ResolvedParam: ${rParam.error.message}`);
  }

  if (checkReportRefinements) {
    const rReport = C.Report.safeParse(input.report);
    if (!rReport.success) errs.push(`${name}: report failed C.Report: ${rReport.error.message}`);
  }
  return errs;
}

const cleanS1 = buildCleanS1();

interface MutantTestCase {
  name: string;
  file: string;
  input: VerifyInput;
  expectedPass: boolean;
  expectedCodes: Array<z.infer<typeof C.RepairError>["code"]>;
  checkReportSchema?: boolean;
}

const TEST_CASES: MutantTestCase[] = [
  {
    name: "clean-s1",
    file: "s1-clean.json",
    input: cleanS1,
    expectedPass: true,
    expectedCodes: [],
  },
  {
    name: "M1 (missing planned provision finding -> V1_COVERAGE)",
    file: "m1-v1-coverage.json",
    input: buildMutantM1(cleanS1),
    expectedPass: false,
    expectedCodes: ["V1_COVERAGE"],
  },
  {
    name: "M2 (fake call_id -> V2_EVIDENCE)",
    file: "m2-v2-evidence.json",
    input: buildMutantM2(cleanS1),
    expectedPass: false,
    expectedCodes: ["V2_EVIDENCE"],
  },
  {
    name: "M3 (flipped outcome fail->pass -> V3_OUTCOME)",
    file: "m3-v3-outcome.json",
    input: buildMutantM3(cleanS1),
    expectedPass: false,
    expectedCodes: ["V3_OUTCOME"],
  },
  {
    name: "M4 (dropped minus sign -3->3 -> V4_NUMBER)",
    file: "m4-v4-number.json",
    input: buildMutantM4(cleanS1),
    expectedPass: false,
    expectedCodes: ["V4_NUMBER"],
  },
  {
    name: "M5 (model_verdict flipped to NO_LEGS -> V5_VERDICT)",
    file: "m5-v5-verdict.json",
    input: buildMutantM5(cleanS1),
    expectedPass: false,
    expectedCodes: ["V5_VERDICT"],
  },
  {
    name: "M6 (limit 4 ft vs resolved 5 ft -> V7_PARAMETER)",
    file: "m6-v7-parameter.json",
    input: buildMutantM6(cleanS1),
    expectedPass: false,
    expectedCodes: ["V7_PARAMETER"],
  },
  {
    name: "M7 (not_applicable citing unknown guard -> V8_GUARD)",
    file: "m7-v8-guard.json",
    input: buildMutantM7(cleanS1),
    expectedPass: false,
    expectedCodes: ["V8_GUARD"],
  },
];

let passedCount = 0;

for (const tc of TEST_CASES) {
  const outPath = path.join(MUTANTS_DIR, tc.file);
  writeFileSync(outPath, JSON.stringify(tc.input, null, 2) + "\n");

  const schemaErrors = validateFixtureSchemas(tc.name, tc.input, tc.checkReportSchema ?? true);
  const res = verify(tc.input);

  const errors: string[] = [...schemaErrors];

  for (const issue of res.issues) {
    if (!C.RepairError.safeParse(issue).success) {
      errors.push(`issue failed C.RepairError schema: ${JSON.stringify(issue)}`);
    }
  }

  if (res.passed !== tc.expectedPass) {
    errors.push(`expected passed=${String(tc.expectedPass)}, got ${String(res.passed)}`);
  }

  const actualUniqueCodes = Array.from(new Set(res.issues.map((i) => i.code)));
  if (JSON.stringify(actualUniqueCodes) !== JSON.stringify(tc.expectedCodes)) {
    errors.push(
      `expected issue codes ${JSON.stringify(tc.expectedCodes)}, got ${JSON.stringify(actualUniqueCodes)} (${res.issues.map((i) => `${i.code}: ${i.message}`).join(" | ")})`,
    );
  }

  if (errors.length === 0) {
    passedCount += 1;
    const summary = res.passed
      ? "PASS (0 issues)"
      : `CAUGHT [${res.issues.map((i) => i.code).join(", ")}] — ${res.issues[0]?.message ?? ""}`;
    console.log(`OK   ${tc.file.padEnd(24)} -> ${summary}`);
  } else {
    console.log(`FAIL ${tc.file.padEnd(24)} -> ${errors.join("; ")}`);
  }
}

// Extra unit check for V6_GEOMETRY (FITS with a non-passing recommended margin)
{
  const v6Input = structuredClone(cleanS1);
  v6Input.report.placement.recommended!.margins[2] = {
    value: 5.15,
    unit: "ft",
    limit: {
      provision_id: "PDX.T110-4",
      param: "rear_building_setback.R5",
      value: 5,
      unit: "ft",
    },
    margin: 0.15,
    tolerance: 1.6,
    pass: null,
    too_close_to_call: true,
    dimension_to_tape: "rear lot line",
  };
  const v6Res = verify(v6Input);
  const v6Codes = Array.from(new Set(v6Res.issues.map((i) => i.code)));
  if (!v6Res.passed && JSON.stringify(v6Codes) === JSON.stringify(["V6_GEOMETRY"])) {
    passedCount += 1;
    console.log(`OK   ${"v6-geometry-check".padEnd(24)} -> CAUGHT [V6_GEOMETRY] — ${v6Res.issues[0]?.message ?? ""}`);
  } else {
    console.log(`FAIL ${"v6-geometry-check".padEnd(24)} -> expected [V6_GEOMETRY], got ${JSON.stringify(v6Codes)}`);
  }
}

const totalTests = TEST_CASES.length + 1;
console.log(`${passedCount}/${totalTests} verifier checks as expected · fixtures -> ${MUTANTS_DIR}`);
if (passedCount !== totalTests) {
  process.exit(1);
}
