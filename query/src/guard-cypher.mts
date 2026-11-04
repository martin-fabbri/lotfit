// W2 · the Cypher guard, the empty-result diagnosis, and the ontology prompt block (ARCHITECTURE.md round 4.1 §6;
// explainer Part 4A; contract C2 QueryResult). Every model-written query passes these steps in order; the first
// failure stops it and becomes the reason returned for the one retry:
//   1 read-only · 2 schema (labels, types, properties, one_of values) · 3 direction (after a symbol table resolves each
//   variable's label across all MATCH clauses; rejected with the canonical direction, never auto-fixed: M5)
//   · 4 time (a :Version read on a date bounds when_from and when_to, null included) · 5 EXPLAIN on Aura · 6 run, ≤ 50 rows.
// An empty result is diagnosed by the harness without the model: the pattern is split into parts, each part counted,
// and the first part that matched nothing is returned with the nearest real values. CC, 2026-11-02.
import neo4j from "neo4j-driver";
import { z } from "zod";
import { type Graph } from "./graph-tools.mts";
import { loadOntology, type Ontology } from "./ontology.mts";
import * as C from "./types.mts";

type QR = z.infer<typeof C.QueryResult>;
const ONT = loadOntology();

// ------------------------------------------------------------------ the ontology, rendered for the model (§5 block 2)
/** A dense, line-oriented rendering of the whole ontology with every description kept (≈ a third of the raw YAML). */
export function renderOntologyPromptBlock(o: Ontology = ONT): string {
  const L: string[] = [`# Graph schema: ${o.name ?? o.id} v${o.version}`, (o.description ?? "").trim(), "", "## Nodes"];
  for (const n of Object.values(o.nodes)) {
    L.push(`(:${n.label}) ${(n.description ?? "").trim().replace(/\s+/g, " ")}`);
    for (const [p, d] of Object.entries(n.properties ?? {})) {
      const extra = [d.type, d.key ? "key" : "", d.one_of ? `one of ${JSON.stringify(d.one_of)}` : ""].filter(Boolean).join("; ");
      L.push(`  .${p} [${extra}] ${(d.description ?? "").trim().replace(/\s+/g, " ")}`);
    }
  }
  L.push("", "## Relationships (direction matters)");
  for (const r of Object.values(o.relationships))
    L.push(`(:${o.nodes[r.from.node]!.label})-[:${r.type}]->(:${o.nodes[r.to.node]!.label}) ${(r.description ?? "").trim().replace(/\s+/g, " ")}`);
  return L.join("\n");
}

// ------------------------------------------------------------------ parsing (enough of Cypher for patterns)
type Node = { v: string; label?: string; props: Record<string, string> };
type Rel = { v: string; type?: string; types: string[]; dir: "->" | "<-" | "--" };
type Path = { nodes: Node[]; rels: Rel[]; text: string; clause: string };

const stripStrings = (q: string) => q.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (m) => m[0] + "_".repeat(m.length - 2) + m[0]);
function parseProps(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const m of s.matchAll(/(\w+)\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\$\w+|[\w.\-]+)/g)) out[m[1]!] = m[2]!;
  return out;
}
function parseNode(inner: string): Node {
  const m = inner.match(/^\s*(\w*)\s*(?::\s*(\w+))?\s*(\{.*\})?\s*$/s);
  return { v: m?.[1] ?? "", label: m?.[2], props: parseProps(m?.[3]) };
}
const KW = /\b(OPTIONAL\s+MATCH|MATCH|WHERE|WITH|RETURN|UNWIND|ORDER\s+BY|CALL|UNION|LIMIT|SKIP)\b/gi;
/** Every path in every MATCH / OPTIONAL MATCH clause (also inside CALL subqueries), in order. */
export function paths(q: string): Path[] {
  const s = stripStrings(q), out: Path[] = [];
  const marks = [...s.matchAll(KW)].map((m) => ({ i: m.index!, kw: m[0].toUpperCase().replace(/\s+/g, " ") }));
  marks.forEach((m, k) => {
    if (!m.kw.endsWith("MATCH")) return;
    const body = q.slice(m.i + m.kw.length, k + 1 < marks.length ? marks[k + 1]!.i : q.length);
    let depth = 0, cur = "";
    const parts: string[] = [];
    for (const ch of body) { if ("([{".includes(ch)) depth++; if (")]}".includes(ch)) depth--; if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch; }
    parts.push(cur);
    for (const part of parts) {
      const p: Path = { nodes: [], rels: [], text: part.trim(), clause: m.kw };
      const pathVar = part.match(/^\s*\w+\s*=\s*/);
      const src = pathVar ? part.slice(pathVar[0].length) : part;
      for (const t of src.matchAll(/\(([^()]*)\)|(<)?-\[([^\]]*)\]-(>)?|(<)?--(>)?/g)) {
        if (t[1] !== undefined) p.nodes.push(parseNode(t[1]));
        else {
          const inner = t[3] ?? "", left = t[2] ?? t[5], right = t[4] ?? t[6];
          const rm = inner.match(/^\s*(\w*)\s*(?::\s*([\w|:]+))?/);
          const types = (rm?.[2] ?? "").split(/[|:]/).filter(Boolean);
          p.rels.push({ v: rm?.[1] ?? "", type: types[0], types, dir: left ? "<-" : right ? "->" : "--" });
        }
      }
      if (p.nodes.length) out.push(p);
    }
  });
  return out;
}

// ------------------------------------------------------------------ the guard
const LABELS = new Map(Object.values(ONT.nodes).map((n) => [n.label!, n]));
const NODE_KEY_TO_LABEL = new Map(Object.entries(ONT.nodes).map(([k, n]) => [k, n.label!]));
const RELS = Object.values(ONT.relationships).map((r) => ({ type: r.type, from: NODE_KEY_TO_LABEL.get(r.from.node)!, to: NODE_KEY_TO_LABEL.get(r.to.node)!, props: r.properties ?? {} }));
const REL_TYPES = new Set(RELS.map((r) => r.type));
const WRITE = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD\s+CSV|FOREACH|IN\s+TRANSACTIONS)\b|\bCALL\s+(dbms|apoc|db\.(?!labels|relationshipTypes|propertyKeys))/i;

export type GuardVerdict = { ok: true; symbols: Map<string, string> } | { ok: false; reason: string; snippet: string };

function snippetFor(labels: string[]): string {
  const lines: string[] = [];
  for (const l of labels) {
    const n = LABELS.get(l); if (!n) continue;
    lines.push(`(:${l}) properties: ${Object.keys(n.properties ?? {}).join(", ")}`);
    for (const r of RELS.filter((r) => r.from === l || r.to === l)) lines.push(`  (:${r.from})-[:${r.type}]->(:${r.to})`);
  }
  return lines.join("\n");
}

export function guard(cypher: string, opts: { as_of?: string | null } = {}): GuardVerdict {
  const s = stripStrings(cypher);
  // 1 read-only
  const w = s.match(WRITE);
  if (w) return { ok: false, reason: `read-only: '${w[0]}' is not allowed; queries run in a read session as a read-only user`, snippet: "" };
  const ps = paths(cypher);
  // symbol table: every variable's label across all MATCH clauses (A7)
  const sym = new Map<string, string>();
  for (const p of ps) for (const n of p.nodes) if (n.v && n.label) sym.set(n.v, n.label);
  const relSym = new Map<string, string>();
  for (const p of ps) for (const r of p.rels) if (r.v && r.type) relSym.set(r.v, r.type);
  // 2 schema
  for (const p of ps) {
    for (const n of p.nodes) {
      if (n.label && !LABELS.has(n.label)) return { ok: false, reason: `schema: there is no node label :${n.label}. Labels: ${[...LABELS.keys()].join(", ")}`, snippet: "" };
      const lab = n.label ?? sym.get(n.v);
      if (lab) for (const [k, val] of Object.entries(n.props)) {
        const pd = LABELS.get(lab)!.properties?.[k];
        if (!pd) return { ok: false, reason: `schema: :${lab} has no property '${k}'`, snippet: snippetFor([lab]) };
        if (pd.one_of && /^'/.test(val) && !pd.one_of.includes(val.slice(1, -1))) return { ok: false, reason: `schema: :${lab}.${k} is one of ${JSON.stringify(pd.one_of)}, not ${val}`, snippet: snippetFor([lab]) };
      }
    }
    for (const r of p.rels) for (const t of r.types) if (!REL_TYPES.has(t)) return { ok: false, reason: `schema: there is no relationship type :${t}`, snippet: "" };
  }
  for (const m of cypher.matchAll(/\b([a-zA-Z_]\w*)\.(\w+)\b/g)) {
    const [, v, k] = m; const lab = sym.get(v!);
    if (lab && !LABELS.get(lab)!.properties?.[k!]) return { ok: false, reason: `schema: :${lab} (variable ${v}) has no property '${k}'`, snippet: snippetFor([lab]) };
    const rt = relSym.get(v!);
    if (rt && !RELS.some((r) => r.type === rt && r.props[k!])) return { ok: false, reason: `schema: relationship :${rt} (variable ${v}) has no property '${k}'`, snippet: "" };
  }
  for (const m of cypher.matchAll(/\b([a-zA-Z_]\w*)\.(\w+)\s*(?:=|<>)\s*'((?:[^'\\]|\\.)*)'/g)) {
    const lab = sym.get(m[1]!), pd = lab ? LABELS.get(lab)!.properties?.[m[2]!] : undefined;
    if (pd?.one_of && !pd.one_of.includes(m[3]!)) return { ok: false, reason: `schema: :${lab}.${m[2]} is one of ${JSON.stringify(pd.one_of)}, not '${m[3]}'`, snippet: snippetFor([lab!]) };
  }
  // 3 direction, with labels resolved through the symbol table (valid left arrows pass)
  for (const p of ps) p.rels.forEach((r, i) => {
    void r; void i;
  });
  for (const p of ps) for (let i = 0; i < p.rels.length; i++) {
    const r = p.rels[i]!, a = p.nodes[i], b = p.nodes[i + 1];
    if (!r.types.length || !a || !b || r.dir === "--") continue;
    const la = a.label ?? sym.get(a.v), lb = b.label ?? sym.get(b.v);
    if (!la || !lb) continue;
    const [from, to] = r.dir === "->" ? [la, lb] : [lb, la];
    if (r.types.some((t) => RELS.some((x) => x.type === t && x.from === from && x.to === to))) continue;
    const rev = RELS.find((x) => r.types.includes(x.type) && x.from === to && x.to === from);
    const reason = rev ? `direction: (:${from})-[:${rev.type}]->(:${to}) is not in the graph; the relationship is (:${rev.from})-[:${rev.type}]->(:${rev.to})`
      : `schema: no (:${from})-[:${r.types.join("|")}]->(:${to}) pattern exists`;
    return { ok: false, reason, snippet: snippetFor([la, lb]) };
  }
  // 4 time: the version of a provision read on a date (reached through HAS_VERSION) bounds both ends, null included (D11).
  // A version reached otherwise (from a table cell, through OPERATIVE_BY or SUPERSEDES) is already a specific version.
  const inForce = new Set<string>();
  for (const p of ps) for (let i = 0; i < p.rels.length; i++) {
    const r = p.rels[i]!; if (!r.types.includes("HAS_VERSION")) continue;
    const a = p.nodes[i]!, b = p.nodes[i + 1]!, ver = r.dir === "<-" ? a : b;
    if (ver.v && (ver.label ?? sym.get(ver.v)) === "Version") inForce.add(ver.v);
  }
  if (opts.as_of) for (const v of inForce) {
    const re = (f: string) => new RegExp(`\\b${v}\\.${f}\\s+IS\\s+NULL\\b`, "i");
    if (!re("when_from").test(cypher) || !re("when_to").test(cypher))
      return { ok: false, reason: `time: ${v}:Version must be bounded on the date, nulls included: (${v}.when_from IS NULL OR ${v}.when_from <= $as_of) AND (${v}.when_to IS NULL OR ${v}.when_to > $as_of)`, snippet: "" };
  }
  return { ok: true, symbols: sym };
}

// ------------------------------------------------------------------ run, with EXPLAIN, the cap and the diagnosis
const toPlain = (v: unknown): unknown => neo4j.isInt(v) ? (v as neo4j.Integer).toNumber() : Array.isArray(v) ? v.map(toPlain)
  : v && typeof v === "object" && (v as any).properties ? toPlain((v as any).properties) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)])) : v;

async function run(g: Graph, cypher: string, params: Record<string, unknown>) {
  const s = g.driver.session({ defaultAccessMode: neo4j.session.READ, database: g.database });
  try { return (await s.run(cypher, params)).records.map((r) => toPlain(r.toObject()) as Record<string, unknown>); } finally { await s.close(); }
}

/** The empty-result diagnosis: count each part of the first MATCH path, adding one hop at a time, then the WHERE. */
export async function diagnose(g: Graph, cypher: string, params: Record<string, unknown>): Promise<z.infer<typeof C.Diagnosis>> {
  const ps = paths(cypher), parts: { pattern: string; count: number }[] = [];
  const nearest: { property: string; values: string[] }[] = [];
  const p = ps[0];
  let first_zero: number | null = null;
  if (p) {
    const nodeTxt = (n: Node) => `(${n.v}${n.label ? ":" + n.label : ""}${Object.keys(n.props).length ? " {" + Object.entries(n.props).map(([k, v]) => `${k}: ${v}`).join(", ") + "}" : ""})`;
    const relTxt = (r: Rel) => `${r.dir === "<-" ? "<-" : "-"}[${r.v}${r.types.length ? ":" + r.types.join("|") : ""}]${r.dir === "->" ? "->" : "-"}`;
    let pat = nodeTxt(p.nodes[0]!);
    const steps = [pat];
    for (let i = 0; i < p.rels.length; i++) { pat += relTxt(p.rels[i]!) + nodeTxt(p.nodes[i + 1]!); steps.push(pat); }
    const where = cypher.match(/\bWHERE\b([\s\S]*?)(?=\b(WITH|RETURN|OPTIONAL\s+MATCH|MATCH|ORDER\s+BY|UNWIND|CALL)\b|$)/i)?.[1]?.trim();
    const qs = steps.map((st) => ({ pattern: st, q: `MATCH ${st} RETURN count(*) AS c` }));
    if (where) qs.push({ pattern: `${steps.at(-1)} WHERE ${where}`, q: `MATCH ${steps.at(-1)} WHERE ${where} RETURN count(*) AS c` });
    for (const x of qs) {
      let c = 0; try { c = Number((await run(g, x.q, params))[0]?.c ?? 0); } catch { c = 0; }
      parts.push({ pattern: x.pattern, count: c });
      if (c === 0 && first_zero === null) {
        first_zero = parts.length - 1;
        const lastNode = p.nodes[Math.min(parts.length - 1, p.nodes.length - 1)] ?? p.nodes[0]!;
        const lab = lastNode.label;
        for (const [k, v] of Object.entries(lastNode.props)) if (lab && /^'/.test(v)) {
          // suggest values only for a property whose own value matches nothing
          const alone = Number((await run(g, `MATCH (n:${lab}) WHERE n.${k} = ${v} RETURN count(n) AS c`, params))[0]?.c ?? 0);
          if (alone > 0) continue;
          const vals = (await run(g, `MATCH (n:${lab}) WHERE n.${k} IS NOT NULL RETURN DISTINCT toString(n.${k}) AS v LIMIT 500`, {})).map((r) => String(r.v));
          const want = v.slice(1, -1).toLowerCase(), words = new Set(want.split(/\W+/).filter(Boolean));
          const score = (s: string) => [...words].filter((w) => s.toLowerCase().includes(w)).length;
          nearest.push({ property: `${lab}.${k}`, values: vals.sort((a, b) => score(b) - score(a)).slice(0, 5) });
        }
        break;
      }
    }
  }
  if (!parts.length) parts.push({ pattern: "(no MATCH pattern)", count: 0 });
  return C.Diagnosis.parse({ parts, first_zero, nearest_values: nearest });
}

/** One attempt of query_code_graph: guard → EXPLAIN → run (≤ 50 rows) → diagnosis if empty. Never throws. */
export async function queryCodeGraph(g: Graph, req: z.infer<typeof C.QueryRequest>, opts: { as_of?: string | null; attempt?: 1 | 2 } = {}): Promise<QR> {
  const attempt = opts.attempt ?? 1;
  const gv = guard(req.cypher, opts);
  if (!gv.ok) return C.QueryResult.parse({ outcome: "guard_rejected", attempt, rows: [], guard_reason: gv.reason, ontology_snippet: gv.snippet || undefined });
  try { await run(g, "EXPLAIN " + req.cypher, req.params); }
  catch (e) { return C.QueryResult.parse({ outcome: "db_error", attempt, rows: [], db_error: (e as Error).message.split("\n")[0]!.slice(0, 500) }); }
  let rows: Record<string, unknown>[];
  try { rows = await run(g, req.cypher, req.params); }
  catch (e) { return C.QueryResult.parse({ outcome: "db_error", attempt, rows: [], db_error: (e as Error).message.split("\n")[0]!.slice(0, 500) }); }
  if (rows.length > 50) return C.QueryResult.parse({ outcome: "truncated", attempt, rows: rows.slice(0, 50), total: rows.length });
  if (rows.length === 0) {
    const d = await diagnose(g, req.cypher, req.params);
    return C.QueryResult.parse({ outcome: attempt === 2 ? "empty_after_diagnosis" : "empty", attempt, rows: [], diagnosis: d });
  }
  return C.QueryResult.parse({ outcome: "ok", attempt, rows });
}
