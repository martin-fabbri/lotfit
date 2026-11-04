// W2 tests for the guard and the diagnosis: all 50 gold queries pass the guard and return their expected rows through
// queryCodeGraph; planted bad queries are refused with the right reason; an empty result is diagnosed. Live, read-only.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { connect } from "./graph-tools.mts";
import { guard, queryCodeGraph, renderOntologyPromptBlock } from "./guard-cypher.mts";
import { ONTOLOGY_PATH } from "./ontology.mts";

const g = connect();
let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; if (!cond || process.env.VERBOSE) console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };
const canon = (r: Record<string, unknown>) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
const same = (a: Record<string, unknown>[], b: Record<string, unknown>[]) => { const x = a.map(canon).sort(), y = b.map(canon).sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
try {
  const gold = parse(readFileSync(new URL("../eval/lotfit-eval-v0.yaml", import.meta.url), "utf8")).items as any[];
  for (const it of gold) {
    const r = await queryCodeGraph(g, { question: it.questions[0], cypher: it.gold_cypher, params: {} }, { as_of: it.as_of });
    const proj = r.rows.map((row) => Object.fromEntries((it.compare_on as string[]).map((c) => [c, row[c] ?? null])));
    const good = (it.expect_empty ? (r.outcome === "empty") : r.outcome === "ok" || r.outcome === "truncated") && (it.expect_empty || r.outcome === "truncated" || same(proj, it.expected));
    ok(`gold ${it.id} passes the guard and returns its rows`, good, `${r.outcome} ${r.guard_reason ?? r.db_error ?? ""} rows ${r.rows.length}/${(it.expected ?? []).length}`);
  }
  console.log(`gold: ${n}/${t}`);
  const bad: [string, string, string | null][] = [
    ["write", "MATCH (p:Provision) SET p.title = 'x' RETURN p", "read-only"],
    ["unknown label", "MATCH (p:Rule) RETURN p", "schema"],
    ["unknown property", "MATCH (p:Provision) RETURN p.nonexistent", "schema"],
    ["inverted arrow", "MATCH (v:Version)-[:HAS_VERSION]->(p:Provision) RETURN p.id", "direction"],
    ["version without date bounds", "MATCH (p:Provision)-[:HAS_VERSION]->(v:Version) WHERE v.when_from <= '2026-11-15' RETURN p.id", "time"],
  ];
  for (const [name, q, why] of bad) { const v = guard(q, { as_of: "2026-11-15" }); ok(`refused: ${name}`, !v.ok && v.reason.startsWith(why!), v.ok ? "accepted" : v.reason); }
  const inv = guard("MATCH (v:Version)-[:HAS_VERSION]->(p:Provision) RETURN p.id");
  ok("an inverted arrow names the canonical direction, not fixed", !inv.ok && inv.reason.includes("(:Provision)-[:HAS_VERSION]->(:Version)"));
  ok("a valid left arrow passes", guard("MATCH (v:Version)<-[:HAS_VERSION]-(p:Provision {id: 'PDX.T110-4'}) RETURN v.id").ok);
  const e = await queryCodeGraph(g, { question: "rear setback cell", cypher: "MATCH (c:TableCell {table: 'Table 110-4', row: 'Rear setback'}) RETURN c.cell", params: {} });
  ok("an empty result is diagnosed with the first empty part and nearest values", e.outcome === "empty" && e.diagnosis!.first_zero === 0 && e.diagnosis!.nearest_values[0]!.values.some((v) => /rear/i.test(v)),
     JSON.stringify(e.diagnosis).slice(0, 300));
  const raw = readFileSync(ONTOLOGY_PATH, "utf8").length, block = renderOntologyPromptBlock().length;
  ok(`rendered ontology is smaller than the raw YAML (${block} vs ${raw} chars, ~${Math.round(block / 4)} tokens)`, block < raw);
} catch (err) { t++; console.log("FAIL exception", (err as Error).message); }
finally { await g.driver.close(); }
console.log(`${n}/${t} guard checks passed`);
process.exit(n === t ? 0 : 1);
