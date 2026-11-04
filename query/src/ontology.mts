// The ontology file is the single source of truth: the model's context, the query checks and (later) the graph type
// are all generated from it (research: v2/docs/research/2026-11-01-text2cypher-priors.md, section 3).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface PropertyDef {
  type?: string;
  description?: string;
  aliases?: string[];
  one_of?: unknown[];
  key?: boolean;
  unique?: boolean;
  must_exist?: boolean;
}
export interface NodeDef {
  label?: string;
  description?: string;
  aliases?: string[];
  properties?: Record<string, PropertyDef>;
}
export interface RelDef {
  type: string;
  from: { node: string };
  to: { node: string };
  description?: string;
  properties?: Record<string, PropertyDef>;
}
export interface Ontology {
  schema: string;
  id: string;
  version: string;
  name?: string;
  description?: string;
  nodes: Record<string, NodeDef>;
  relationships: Record<string, RelDef>;
}

export const ONTOLOGY_PATH = fileURLToPath(new URL("../ontology/lotfit.ontology.yaml", import.meta.url));
export const SPEC_SCHEMA_PATH = fileURLToPath(new URL("../ontology/neo4j-ontology-spec-1.0.0.schema.json", import.meta.url));

export function loadOntology(path = ONTOLOGY_PATH): Ontology {
  return parse(readFileSync(path, "utf8")) as Ontology;
}

/** The label of a node definition (the spec allows `label` or `labels.identifier`; we use `label`). */
export const labelOf = (o: Ontology, nodeId: string): string => {
  const n = o.nodes[nodeId];
  if (!n?.label) throw new Error(`ontology node '${nodeId}' has no label`);
  return n.label;
};

/** Every (from label, type, to label) pattern the ontology allows. */
export function patterns(o: Ontology): { from: string; type: string; to: string; id: string }[] {
  return Object.entries(o.relationships).map(([id, r]) => ({ id, type: r.type, from: labelOf(o, r.from.node), to: labelOf(o, r.to.node) }));
}
