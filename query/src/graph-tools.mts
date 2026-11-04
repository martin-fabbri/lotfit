// W1 · Tier 1 graph reads against Aura (ARCHITECTURE.md round 4.1 §6; contract C2). Three fixed, parameterized,
// read-only queries: the reading guide, the layer index, and rule families. They are the spine of every evaluation;
// model-written Cypher (Tier 2, W2) is never needed for them. Every result parses as its frozen contract type.
// CC, 2026-11-02.
//
// Sources besides Aura: the slice (graph/curated/slice-pdx-adu-detached.json; extended to 42 provisions, L31) chooses
// which provisions an ADU evaluation reads; graph/curated/index-scope.json gives a scope sentence to provisions the
// graph stores without one (M12, F1); graph/curated/confirmations.jsonl carries signed clause dispositions (GR-47).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import neo4j, { type Driver, type Session } from "neo4j-driver";
import { z } from "zod";
import * as C from "./types.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CURATED = join(ROOT, "graph", "curated");

/** Plan constraints: limits no placement can cure (M13). Every other operator-backed constraint is a placement constraint. */
// AG r2 R2-5: Eugene's size cap and height cap are plan constraints too (no placement cures them).
export const PLAN_CONSTRAINT_OPERATORS = new Set(["op.adu_size", "op.accessory_height", "op.footprint_dimension", "op.eug_adu_size", "op.eug_adu_height"]);

export type Graph = { driver: Driver; database?: string };
export function connect(envFile = join(ROOT, ".env.aura")): Graph {
  const env = Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter((l) => /^NEO4J_/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
  return { driver: neo4j.driver(env.NEO4J_URI!, neo4j.auth.basic(env.NEO4J_USERNAME!, env.NEO4J_PASSWORD!)), database: env.NEO4J_DATABASE || undefined };
}
async function read<T = Record<string, unknown>>(g: Graph, cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const s: Session = g.driver.session({ defaultAccessMode: neo4j.session.READ, database: g.database });
  try {
    const r = await s.run(cypher, params);
    return r.records.map((x) => x.toObject() as T);
  } finally { await s.close(); }
}
const num = (v: unknown) => (neo4j.isInt(v) ? (v as neo4j.Integer).toNumber() : v);
const canon = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function graphLoadId(g: Graph): Promise<string> {
  const r = await read<{ id: string }>(g, "MATCH (l:GraphLoad) RETURN l.id AS id ORDER BY l.loaded_at DESC LIMIT 1");
  if (!r.length) throw new Error("no GraphLoad in the database");
  return r[0]!.id;
}

// ------------------------------------------------------------------ curated inputs
/** Every city's slice (`slice-<layer>-adu-detached.json`), merged; the index keeps only the case's layers. */
export function sliceIds(): string[] {
  const files = readdirSync(CURATED).filter((f) => /^slice-[a-z]+-adu-detached\.json$/.test(f)).sort();
  return [...new Set(files.flatMap((f) => JSON.parse(readFileSync(join(CURATED, f), "utf8")).provisions as string[]))];
}
function scopeOverrides(): Map<string, z.infer<typeof C.IndexScopeOverride>> {
  const f = C.IndexScopeFile.parse(JSON.parse(readFileSync(join(CURATED, "index-scope.json"), "utf8")));
  return new Map(f.entries.map((e) => [e.provision_id, e]));
}
function dispositions(): Map<string, z.infer<typeof C.Disposition>> {
  const p = join(CURATED, "confirmations.jsonl"), m = new Map<string, z.infer<typeof C.Disposition>>();
  if (!existsSync(p)) return m;
  for (const line of readFileSync(p, "utf8").split("\n").filter((l) => l.trim())) {
    const e = C.ConfirmationEntry.parse(JSON.parse(line));
    if (e.disposition) m.set(e.item, e.disposition);
  }
  return m;
}

/** The evaluation stage is derived by code from the graph type and operator kind, never by the model (§3, M13).
 *  "procedural" provisions (pointers to other sections) are reached by reference, like definitions. */
export function stageOf(type: string, operators: string[]): z.infer<typeof C.EvaluationStage> {
  if (type === "gate") return "gate";
  if (type === "exception") return "exception";
  if (type === "preemption") return "preemption";
  if (type === "definition" || type === "procedural") return "definition";
  return operators.some((o) => PLAN_CONSTRAINT_OPERATORS.has(o)) ? "plan_constraint" : "placement_constraint";
}

// The version in force on a date; a null when_from is included and flagged (ORS.197A.425 has none; D11).
const IN_FORCE = "(v.when_from IS NULL OR v.when_from <= $as_of) AND (v.when_to IS NULL OR v.when_to > $as_of)";

// ------------------------------------------------------------------ read_reading_guide
export async function readReadingGuide(g: Graph): Promise<z.infer<typeof C.ReadingGuide>> {
  const [r] = await read<{ id: string; text: string }>(g, "MATCH (r:ReadingGuide) RETURN r.id AS id, r.text AS text LIMIT 1");
  if (!r) throw new Error("no ReadingGuide in the graph");
  return C.ReadingGuide.parse({ id: r.id, version: await graphLoadId(g), text: r.text });
}

// ------------------------------------------------------------------ read_layer_index
type Row = { pid: string; layer: string; type: string; title: string | null; section: string | null; version: number; text: string;
  when_from: string | null; when_to: string | null; applies_to_quote: string | null; zones_quote: string | null;
  params: string[]; readings: number; ops: string[]; modifies_op: boolean;
  clauses: { id: string; kind: string; quote: string; start: number; guards: string }[] };

export async function readLayerIndex(g: Graph, args: { city_layer: string; as_of: string; state_layer?: string }): Promise<z.infer<typeof C.LayerIndex>> {
  const layers = [args.state_layer ?? "OR", args.city_layer];
  const rows = await read<Row>(g, `
    UNWIND $ids AS pid
    MATCH (p:Provision {id: pid})-[:HAS_VERSION]->(v:Version)
    WHERE p.layer IN $layers AND ${IN_FORCE}
    WITH p, v ORDER BY v.version DESC
    WITH p, collect(v)[0] AS v
    OPTIONAL MATCH (v)-[:HAS_PARAMETER]->(pa:Parameter)
    WITH p, v, collect(DISTINCT pa.name) AS params
    OPTIONAL MATCH (v)-[:HAS_READING]->(rd:Reading)
    WITH p, v, params, count(DISTINCT rd) AS readings
    OPTIONAL MATCH (o:Operator)-[:MODELS]->(p)
    WITH p, v, params, readings, collect(DISTINCT o.id) AS ops
    OPTIONAL MATCH (p)-[:MODIFIES]->(:Provision)<-[:MODELS]-(mo:Operator)
    WITH p, v, params, readings, ops, count(mo) > 0 AS modifies_op
    OPTIONAL MATCH (v)-[:HAS_CLAUSE]->(c:Clause)
    WITH p, v, params, readings, ops, modifies_op, c ORDER BY c.span_start
    RETURN p.id AS pid, p.layer AS layer, p.type AS type, p.title AS title, p.section AS section, v.version AS version, v.text AS text,
           v.when_from AS when_from, v.when_to AS when_to, v.applies_to_quote AS applies_to_quote, v.zones_quote AS zones_quote,
           params, readings, ops, modifies_op,
           collect({id: c.id, kind: c.kind, quote: c.quote, start: c.span_start, guards: c.guards_json}) AS clauses`,
    { ids: sliceIds(), layers, as_of: args.as_of });
  const over = scopeOverrides();
  const byLayer = new Map<string, z.infer<typeof C.IndexEntry>[]>();
  for (const r of rows) {
    const clauses = r.clauses.filter((c) => c.id).map((c) => ({ ...c, start: Number(num(c.start)) }));
    let scope_clause_id: string, scope_quote: string, source: "graph" | "curated", basis: "stated" | "curated" | "guessed";
    const lead = r.applies_to_quote ?? r.zones_quote;
    if (lead) {
      // the scope clause: the first non-heading clause by position that contains the scope sentence or carries guards (A7)
      const ws = (s: string) => s.replace(/\s+/g, " ").trim();
      const matched = clauses.find((c) => c.kind !== "heading" && c.kind !== "footnote" && (ws(c.quote ?? "").includes(ws(lead)) || ws(lead).includes(ws(c.quote ?? "") || "\u0000")));
      const c = matched ?? clauses.find((c) => c.kind !== "heading" && c.guards && c.guards !== "[]") ?? clauses[0]!;
      scope_clause_id = c.id; scope_quote = lead; source = "graph"; basis = matched ? "stated" : "guessed";
    } else if (over.has(r.pid)) {
      const o = over.get(r.pid)!; scope_clause_id = o.scope_clause_id; scope_quote = o.scope_quote; source = "curated"; basis = "curated";
    } else {
      const c = clauses.find((c) => c.kind !== "heading" && c.kind !== "footnote") ?? clauses[0]!;
      scope_clause_id = c.id; scope_quote = c.quote; source = "graph"; basis = "guessed";
    }
    const zones = new Set<string>();
    for (const c of clauses) for (const gd of JSON.parse(c.guards || "[]") as { fact: string; op: string; value?: string[] }[])
      if (gd.fact === "site.zone" && gd.op === "in") for (const z of gd.value ?? []) zones.add(z);
    const ops = r.ops.filter(Boolean);
    const e = C.IndexEntry.parse({
      provision_id: r.pid, layer: r.layer, type: r.type, evaluation_stage: stageOf(r.type, ops), title: r.title ?? r.pid, section: r.section ?? null,
      param_names: r.params.filter(Boolean).sort(), gray_areas: Number(num(r.readings)),
      scope: { applies_to_zones: [...zones], project_kinds: [], scope_clause_id, scope_quote, source, basis },
      in_force: { from: r.when_from ?? null, to: r.when_to ?? null, date_not_stated: r.when_from == null },
      has_operator: ops.length > 0, modifies_operator_backed: Boolean(r.modifies_op),
    });
    (byLayer.get(r.layer) ?? byLayer.set(r.layer, []).get(r.layer)!).push(e);
  }
  const out = layers.filter((l) => byLayer.has(l)).map((l, i) => ({ layer: l, order: i, provisions: byLayer.get(l)!.sort((a, b) => a.provision_id.localeCompare(b.provision_id)) }));
  return C.LayerIndex.parse({ graph_load_id: await graphLoadId(g), as_of: args.as_of, index_hash: sha(canon(out)), layers: out });
}

// ------------------------------------------------------------------ read_rule_family
export async function readRuleFamily(g: Graph, args: { provision_ids: string[]; as_of: string }): Promise<z.infer<typeof C.RuleFamily>[]> {
  const rows = await read<any>(g, `
    UNWIND $ids AS pid
    MATCH (p:Provision {id: pid})-[:HAS_VERSION]->(v:Version)
    WHERE ${IN_FORCE}
    WITH p, v ORDER BY v.version DESC
    WITH p, collect(v)[0] AS v
    CALL (v) { OPTIONAL MATCH (v)-[:HAS_PARAMETER]->(pa:Parameter) OPTIONAL MATCH (c0:Clause)-[:MODELED_BY]->(pa)
               RETURN collect(DISTINCT {id: pa.id, name: pa.name, num: pa.value_num, str: pa.value_str, bool: pa.value_bool, json: pa.value_json,
                                        unit: pa.unit, quote: pa.quote, clause: c0.id}) AS params }
    CALL (v) { OPTIONAL MATCH (v)-[:HAS_TABLE_CELL]->(tc:TableCell)
               RETURN collect(DISTINCT {id: tc.id, table: tc.table, row: tc.row, column: tc.column, cell: tc.cell}) AS cells }
    CALL (v) { OPTIONAL MATCH (v)-[:HAS_CLAUSE]->(c:Clause) WITH c ORDER BY c.span_start
               RETURN collect({id: c.id, kind: c.kind, quote: c.quote, status: c.status, guards: c.guards_json}) AS clauses }
    CALL (v) { OPTIONAL MATCH (v)-[:HAS_READING]->(rd:Reading) OPTIONAL MATCH (ge:GrayAreaEffect)-[:EFFECT_OF]->(rd)
               RETURN collect(DISTINCT {ge: ge.id, phrase: rd.phrase, readings: rd.readings, settled_by: ge.settled_by, effects: ge.effects_json}) AS readings }
    CALL (p) { OPTIONAL MATCH (o:Operator)-[:MODELS]->(p) OPTIONAL MATCH (o)-[:RUNS_TOOL]->(t:Tool)
               RETURN collect(DISTINCT {id: o.id, tool: t.id}) AS ops }
    CALL (p) { OPTIONAL MATCH (m:Provision)-[:MODIFIES]->(p) RETURN collect(DISTINCT m.id) AS modified_by }
    CALL (p) { OPTIONAL MATCH (x:Provision)-[:PREEMPTS]->(p) RETURN collect(DISTINCT x.id) AS preempted_by }
    CALL (p) { OPTIONAL MATCH (p)-[:USES_DEFINITION]->(d:Provision) RETURN collect(DISTINCT d.id) AS uses }
    RETURN p.id AS pid, p.type AS type, v.id AS vid, v.sha256 AS sha, params, cells, clauses, readings, ops, modified_by, preempted_by, uses`,
    { ids: args.provision_ids, as_of: args.as_of });
  const disp = dispositions();
  return rows.map((r) => {
    const ops = (r.ops as any[]).filter((o) => o.id);
    const value = (p: any) => p.num != null ? Number(num(p.num)) : p.str != null ? p.str : p.json != null ? p.json : p.bool != null ? String(p.bool) : "";
    const effects = (r.readings as any[]).filter((x) => x.ge).flatMap((x) => (JSON.parse(x.effects || "[]") as any[]).map((e) => ({ ambiguity_id: x.ge, ...(e.fact ? { fact: e.fact } : {}),
      ...(e.provision ? { provision_id: e.provision } : {}), ...(e.param ? { param: e.param } : {}) })));
    return C.RuleFamily.parse({
      provision_id: r.pid, version_id: r.vid, sha256: r.sha, evaluation_stage: stageOf(r.type, ops.map((o) => o.id)),
      params: (r.params as any[]).filter((p) => p.id).map((p) => ({ param_id: p.id, provision_id: r.pid, name: p.name, value: value(p), unit: p.unit ?? null, quote: p.quote ?? "", clause_id: p.clause ?? null })),
      cells: (r.cells as any[]).filter((c) => c.id).map((c) => ({ cell_id: c.id, table: c.table, row: c.row, column: c.column, text: c.cell })),
      clauses: (r.clauses as any[]).filter((c) => c.id).map((c) => ({ clause_id: c.id, kind: c.kind, quote: c.quote ?? "", modeled: c.status === "modeled",
        guards: (JSON.parse(c.guards || "[]") as any[]).map((gd) => ({ fact: gd.fact, op: gd.op, ...(gd.value !== undefined ? { value: gd.value } : {}) })),
        disposition: disp.get(c.id) ?? null,
        ...(Array.isArray(c.needs) ? { needs: (c.needs as unknown[]).filter((x): x is string => typeof x === "string" && /^(site|plan)\.[a-z0-9_]+$/.test(x)) } : {}) })),
      readings: (r.readings as any[]).filter((x) => x.ge && x.readings?.length >= 2).map((x) => ({ ambiguity_id: x.ge, phrase: x.phrase, readings: x.readings, settled_by: x.settled_by ?? "" })),
      gray_area_effects: effects,
      operators: ops.map((o) => ({ operator_id: o.id, tool: o.tool })),
      modified_by: (r.modified_by as string[]).filter(Boolean).sort(), preempted_by: (r.preempted_by as string[]).filter(Boolean).sort(),
      uses_definitions: (r.uses as string[]).filter(Boolean).sort(),
    });
  });
}
