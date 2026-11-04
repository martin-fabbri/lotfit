// W1 tests: the three Tier 1 reads, live against Aura (read-only). Every result parses as its contract (the functions
// parse before returning), and the facts the evaluation depends on are present. CC, 2026-11-02.
import { connect, graphLoadId, readLayerIndex, readReadingGuide, readRuleFamily, sliceIds } from "./graph-tools.mts";

const g = connect();
let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };
try {
  const load = await graphLoadId(g);
  ok("graph load is the reloaded graph (reloaded 11-04 with Eugene)", load.startsWith("777403f1"), load);

  const guide = await readReadingGuide(g);
  ok("reading guide states the three stages (M13)", guide.text.includes("Plan constraints next") && guide.text.includes("Placement constraints"));

  const t0 = Date.now();
  const idx = await readLayerIndex(g, { city_layer: "PDX", as_of: "2026-11-15" });
  const ms = Date.now() - t0;
  const all = idx.layers.flatMap((l) => l.provisions);
  // Slices of other cities (EUG, GRE) are merged into sliceIds(); a PDX index holds the state and Portland part only.
  const pdxSlice = sliceIds().filter((id) => !/^(EUG|GRE)\./.test(id));
  ok(`index holds the whole slice in force (${all.length} of ${pdxSlice.length}) in ${ms} ms`, all.length === pdxSlice.length, `${all.length}`);
  ok("ORS.197A.425 is present with date_not_stated (D11)", all.some((e) => e.provision_id === "ORS.197A.425" && e.in_force.date_not_stated));
  ok("no scope quote is a bare heading for the 17 (F1)", !all.some((e) => /^(Required setbacks\.|Table 110-\d .*)$/.test(e.scope.scope_quote) && e.scope.source === "graph" && e.type !== "gate"));
  ok("curated scope quotes are used where the graph has none", all.filter((e) => e.scope.source === "curated").length >= 20, `${all.filter((e) => e.scope.source === "curated").length}`);
  const st = (id: string) => all.find((e) => e.provision_id === id)?.evaluation_stage;
  ok("stages: size cap is a plan constraint, base setbacks a placement constraint, tree rule a gate (M13)",
     st("PDX.33.205.040.C.1") === "plan_constraint" && st("PDX.33.110.220.B") === "placement_constraint" && st("PDX.11.50.020") === "gate",
     `${st("PDX.33.205.040.C.1")} ${st("PDX.33.110.220.B")} ${st("PDX.11.50.020")}`);
  ok("ADU allowance gate applies to R5 after the zone-range fix (D7)", all.find((e) => e.provision_id === "PDX.33.205.020.B.1.a")!.scope.applies_to_zones.includes("R5"));
  ok("245.C.2 is flagged as modifying an operator-backed rule (F1 validator input)", all.find((e) => e.provision_id === "PDX.33.110.245.C.2")!.modifies_operator_backed);

  const fam = await readRuleFamily(g, { provision_ids: ["PDX.33.110.220.B", "PDX.T110-4", "PDX.33.205.040.C.2", "PDX.33.910.030.living-area", "PDX.33.110.245.C.2"], as_of: "2026-11-15" });
  const F = Object.fromEntries(fam.map((f) => [f.provision_id, f]));
  ok("T110-4 carries side_building_setback.R5 = 5 ft", F["PDX.T110-4"]!.params.some((p) => p.name === "side_building_setback.R5" && p.value === 5 && p.unit === "ft"));
  ok("220.B is modified by 245.C.2 and 220.C.2 (F7)", ["PDX.33.110.245.C.2", "PDX.33.110.220.C.2"].every((m) => F["PDX.33.110.220.B"]!.modified_by.includes(m)));
  ok("205.040.C.2 runs check_front_or_behind (W4 rebinding)", F["PDX.33.205.040.C.2"]!.operators.some((o) => o.tool === "check_front_or_behind"));
  ok("245.C.2 runs check_exception_conditions", F["PDX.33.110.245.C.2"]!.operators.some((o) => o.tool === "check_exception_conditions"));
  ok("living-area carries the sloped-ceiling gray area with who settles it", F["PDX.33.910.030.living-area"]!.readings.some((r) => r.ambiguity_id === "amb.living-area.sloped-ceiling" && r.settled_by.length > 0));
  ok("definition clauses carry no exclusion guards (D7)", F["PDX.33.910.030.living-area"]!.clauses.every((c) => c.guards.length === 0));
  ok("clause ledger keeps not-modeled clauses visible", F["PDX.33.110.220.B"]!.clauses.some((c) => !c.modeled && c.quote.startsWith("Other setbacks may apply")));
} catch (e) { t++; console.log("FAIL  exception —", (e as Error).message); }
finally { await g.driver.close(); }
console.log(`${n}/${t} graph-tool checks passed`);
process.exit(n === t ? 0 : 1);
