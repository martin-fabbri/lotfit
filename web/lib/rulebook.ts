import "server-only";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { GRAPH_FILE } from "./paths";

// The Rulebook as built (graph/out/graph-or.json, the file loaded into Aura). Read once per server instance.
let cache: { g: any; sha: string; byId: Map<string, any> } | null = null;
function load() {
  if (cache) return cache;
  const raw = readFileSync(/*turbopackIgnore: true*/ GRAPH_FILE);
  const g = JSON.parse(String(raw));
  cache = { g, sha: createHash("sha256").update(raw).digest("hex"), byId: new Map(g.provisions.map((p: any) => [p.id, p])) };
  return cache;
}

const latest = (p: any) => [...(p.versions ?? [])].sort((a: any, b: any) => b.version - a.version)[0] ?? {};

export const LAYER_NAMES: Record<string, string> = { OR: "Oregon", PDX: "Portland", GRE: "Gresham", EUG: "Eugene" };

export function rulebookStats() {
  const { g, sha } = load();
  const layers: Record<string, { provisions: number; clauses: number; modeled: number; params: number; cells: number }> = {};
  for (const p of g.provisions) {
    const v = latest(p), L = (layers[p.layer] ??= { provisions: 0, clauses: 0, modeled: 0, params: 0, cells: 0 });
    L.provisions++; L.clauses += (v.clauses ?? []).length; L.params += (v.params ?? []).length;
    L.cells += (v.table_cells ?? []).length; L.modeled += (v.clauses ?? []).filter((c: any) => c.status === "modeled").length;
  }
  return { sha, schema: g.schema, documents: (g.documents ?? []).length, operators: (g.model?.operators?.operators ?? []).length,
    facts: Object.keys(g.model?.facts?.facts ?? g.model?.facts ?? {}).length, layers };
}

export function searchProvisions(q: string, layer?: string) {
  const { g } = load();
  const s = q.trim().toLowerCase();
  const hits = g.provisions.filter((p: any) => (!layer || p.layer === layer) && (!s || p.id.toLowerCase().includes(s) ||
    String(p.title ?? "").toLowerCase().includes(s) || String(latest(p).text ?? "").toLowerCase().includes(s)));
  return { total: hits.length, items: hits.slice(0, 50).map((p: any) => {
    const v = latest(p);
    return { id: p.id, layer: p.layer, type: p.type, title: p.title, section: p.section,
      params: (v.params ?? []).length, clauses: (v.clauses ?? []).length,
      modeled: (v.clauses ?? []).filter((c: any) => c.status === "modeled").length };
  }) };
}

export function provision(id: string) {
  const { g, byId } = load();
  const p = byId.get(id);
  if (!p) return null;
  const v = latest(p);
  const doc = (g.documents ?? []).find((d: any) => d.id === v.source?.document);
  const ops = (g.model?.operators?.operators ?? []).filter((o: any) => (o.provisions ?? []).includes(id));
  const rels = (g.model?.relations?.relations ?? []).filter((r: any) => r.from === id || r.to === id);
  return {
    id: p.id, layer: p.layer, type: p.type, title: p.title, section: v.source?.section ?? p.section, page: v.source?.page ?? null,
    text: String(v.text ?? ""), effective_from: v.effective_from ?? null, effective_basis: v.effective_basis ?? null,
    document: doc ? { id: doc.id, title: doc.title, version: doc.version, url: doc.url } : null,
    params: (v.params ?? []) as any[], cells: (v.table_cells ?? []).slice(0, 60) as any[], cells_total: (v.table_cells ?? []).length,
    clauses: (v.clauses ?? []) as any[], readings: (v.readings ?? []) as any[],
    operators: ops.map((o: any) => ({ id: o.id, kind: o.kind, tool: o.tool, reads: o.reads ?? [], params: o.params ?? [],
      requires: o.requires ?? null, partial: o.partial ?? null, note: o.note ?? null })),
    relations: rels as any[], refers_to: (p.refers_to_ids ?? []) as string[], terms: (p.defined_terms_used ?? []) as string[],
  };
}

export function exists(id: string) { return load().byId.has(id); }
