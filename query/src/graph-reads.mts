// W6 · Graph read interface with two implementations:
//   1. AuraGraphReader (live against Neo4j Aura via CC's W1 `graph-tools.mts`)
//   2. FileGraphReader (deterministic file-backed reader over `graph/out/graph-or.json`,
//      `graph/curated/slice-pdx-adu-detached.json`, `graph/curated/index-scope.json`,
//      `graph/curated/reading-guide.md`, and `graph/curated/confirmations.jsonl` for offline tests).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import {
  connect,
   type Graph,
  graphLoadId as auraGraphLoadId,
  PLAN_CONSTRAINT_OPERATORS,
  readLayerIndex as auraReadLayerIndex,
  readReadingGuide as auraReadReadingGuide,
  readRuleFamily as auraReadRuleFamily,
  stageOf,
} from "./graph-tools.mts";
import * as C from "./types.mts";

export type ReadingGuideType = z.infer<typeof C.ReadingGuide>;
export type LayerIndexType = z.infer<typeof C.LayerIndex>;
export type IndexEntryType = z.infer<typeof C.IndexEntry>;
export type RuleFamilyType = z.infer<typeof C.RuleFamily>;
export type DispositionType = z.infer<typeof C.Disposition>;
export type EvaluationStageType = z.infer<typeof C.EvaluationStage>;

export interface GraphReader {
  graphLoadId(): Promise<string>;
  readReadingGuide(): Promise<ReadingGuideType>;
  readLayerIndex(args: { city_layer: string; as_of: string; state_layer?: string }): Promise<LayerIndexType>;
  readRuleFamily(args: { provision_ids: string[]; as_of: string }): Promise<RuleFamilyType[]>;
  close(): Promise<void>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CURATED = join(ROOT, "graph", "curated");
const DEFAULT_GRAPH_OR_PATH = join(ROOT, "graph", "out", "graph-or.json");
const DEFAULT_SLICE_PATH = join(CURATED, "slice-pdx-adu-detached.json");
const DEFAULT_INDEX_SCOPE_PATH = join(CURATED, "index-scope.json");
const DEFAULT_READING_GUIDE_PATH = join(CURATED, "reading-guide.md");
const DEFAULT_CONFIRMATIONS_PATH = join(CURATED, "confirmations.jsonl");
const DEFAULT_OPERATORS_PATH = join(CURATED, "operators.json");
const DEFAULT_RELATIONS_PATH = join(CURATED, "relations.json");
const DEFAULT_AMBIGUITIES_PATH = join(CURATED, "ambiguities.json");

const canon = (x: unknown): string =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function normText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------------ 1. Aura implementation (W1)

export class AuraGraphReader implements GraphReader {
  private readonly graph: Graph;

  constructor(envFile?: string) {
    this.graph = connect(envFile);
  }

  async graphLoadId(): Promise<string> {
    return auraGraphLoadId(this.graph);
  }

  async readReadingGuide(): Promise<ReadingGuideType> {
    return auraReadReadingGuide(this.graph);
  }

  async readLayerIndex(args: { city_layer: string; as_of: string; state_layer?: string }): Promise<LayerIndexType> {
    return auraReadLayerIndex(this.graph, args);
  }

  async readRuleFamily(args: { provision_ids: string[]; as_of: string }): Promise<RuleFamilyType[]> {
    return auraReadRuleFamily(this.graph, args);
  }

  async close(): Promise<void> {
    await this.graph.driver.close();
  }
}

export function createAuraGraphReader(envFile?: string): GraphReader {
  return new AuraGraphReader(envFile);
}

// ------------------------------------------------------------------ 2. File-backed implementation (offline / tests)

export interface FileGraphReaderOptions {
  graphPath?: string;
  slicePath?: string;
  indexScopePath?: string;
  readingGuidePath?: string;
  confirmationsPath?: string;
  operatorsPath?: string;
  relationsPath?: string;
  ambiguitiesPath?: string;
  /** Optional override for graph_load_id (defaults to sha256 prefix of graph-or.json). */
  graphLoadIdOverride?: string;
  /** Optional in-memory dispositions map or record for testing with/without signed dispositions. */
  dispositionsOverride?: Map<string, DispositionType> | Record<string, DispositionType>;
}

let cachedDefaultGraphJson: Record<string, any> | null = null;
let cachedDefaultGraphSha: string | null = null;

function loadDefaultGraphJson(): { data: Record<string, any>; sha: string } {
  if (!cachedDefaultGraphJson || !cachedDefaultGraphSha) {
    const raw = readFileSync(DEFAULT_GRAPH_OR_PATH, "utf8");
    cachedDefaultGraphSha = sha256Hex(raw);
    cachedDefaultGraphJson = JSON.parse(raw) as Record<string, any>;
  }
  return { data: cachedDefaultGraphJson, sha: cachedDefaultGraphSha };
}

function versionWhenFrom(v: Record<string, any>): string | null {
  if (typeof v["when_from"] === "string") return v["when_from"];
  const eff = typeof v["effective_from"] === "string" ? v["effective_from"] : null;
  const op = typeof v["operative_from"] === "string" ? v["operative_from"] : null;
  if (eff && op) return eff > op ? eff : op;
  return eff ?? op ?? null;
}

function versionWhenTo(v: Record<string, any>): string | null {
  if (typeof v["when_to"] === "string") return v["when_to"];
  if (typeof v["effective_to"] === "string") return v["effective_to"];
  return null;
}

function isVersionInForce(v: Record<string, any>, asOf: string): boolean {
  const from = versionWhenFrom(v);
  const to = versionWhenTo(v);
  const afterFrom = from === null || from <= asOf;
  const beforeTo = to === null || to > asOf;
  return afterFrom && beforeTo;
}

/** Build-review R2 B7: lead quotes keep raw newlines, clause quotes are whitespace-normalised; compare both normalised. */
const ws = (s: string) => s.replace(/\s+/g, " ").trim();

export class FileGraphReader implements GraphReader {
  private readonly graphData: Record<string, any>;
  private readonly loadId: string;
  private readonly sliceProvisionIds: string[];
  private readonly scopeOverrides: Map<string, z.infer<typeof C.IndexScopeOverride>>;
  private readonly readingGuideText: string;
  private readonly dispositionsMap: Map<string, DispositionType>;
  private readonly operatorsList: Array<{
    id: string;
    tool: string;
    provisions: string[];
  }>;
  private readonly relationsList: Array<{
    from: string;
    to: string;
    kind: string;
  }>;
  private readonly ambiguitiesList: Array<{
    id: string;
    provision: string;
    phrase: string;
    settled_by?: string;
    effects?: Array<{
      fact?: string;
      provision?: string;
      param?: string;
    }>;
  }>;

  constructor(opts: FileGraphReaderOptions = {}) {
    if (!opts.graphPath || opts.graphPath === DEFAULT_GRAPH_OR_PATH) {
      const { data, sha } = loadDefaultGraphJson();
      this.graphData = data;
      this.loadId = opts.graphLoadIdOverride ?? `${sha.slice(0, 8)}@file-graph`;
    } else {
      const raw = readFileSync(opts.graphPath, "utf8");
      const sha = sha256Hex(raw);
      this.graphData = JSON.parse(raw) as Record<string, any>;
      this.loadId = opts.graphLoadIdOverride ?? `${sha.slice(0, 8)}@file-graph`;
    }

    const slicePath = opts.slicePath ?? DEFAULT_SLICE_PATH;
    // One slice per city layer (slice-<layer>-adu-detached.json); merged, and readLayerIndex keeps the case's layers.
    const sliceFiles = opts.slicePath ? [slicePath]
      : readdirSync(CURATED).filter((f) => /^slice-[a-z]+-adu-detached\.json$/.test(f)).sort().map((f) => join(CURATED, f));
    this.sliceProvisionIds = [...new Set(sliceFiles.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).provisions as string[]))];

    const indexScopePath = opts.indexScopePath ?? DEFAULT_INDEX_SCOPE_PATH;
    const scopeFile = C.IndexScopeFile.parse(JSON.parse(readFileSync(indexScopePath, "utf8")));
    this.scopeOverrides = new Map(scopeFile.entries.map((e) => [e.provision_id, e]));

    const readingGuidePath = opts.readingGuidePath ?? DEFAULT_READING_GUIDE_PATH;
    this.readingGuideText = readFileSync(readingGuidePath, "utf8");

    this.dispositionsMap = new Map<string, DispositionType>();
    const confPath = opts.confirmationsPath ?? DEFAULT_CONFIRMATIONS_PATH;
    if (existsSync(confPath)) {
      for (const line of readFileSync(confPath, "utf8").split("\n").filter((l) => l.trim())) {
        const entry = C.ConfirmationEntry.parse(JSON.parse(line));
        if (entry.disposition) {
          this.dispositionsMap.set(entry.item, entry.disposition);
        }
      }
    }
    if (opts.dispositionsOverride) {
      const entries =
        opts.dispositionsOverride instanceof Map
          ? opts.dispositionsOverride.entries()
          : Object.entries(opts.dispositionsOverride);
      for (const [k, v] of entries) {
        this.dispositionsMap.set(k, C.Disposition.parse(v));
      }
    }

    const opsPath = opts.operatorsPath ?? DEFAULT_OPERATORS_PATH;
    const rawOps = existsSync(opsPath)
      ? (JSON.parse(readFileSync(opsPath, "utf8")).operators as any[])
      : ((this.graphData["model"]?.["operators"]?.["operators"] ?? []) as any[]);
    this.operatorsList = rawOps.map((o) => ({
      id: String(o.id),
      tool: String(o.tool),
      provisions: Array.isArray(o.provisions) ? o.provisions.map(String) : [],
    }));

    const relPath = opts.relationsPath ?? DEFAULT_RELATIONS_PATH;
    const rawRels = existsSync(relPath)
      ? (JSON.parse(readFileSync(relPath, "utf8")).relations as any[])
      : ((this.graphData["model"]?.["relations"]?.["relations"] ?? []) as any[]);
    this.relationsList = rawRels.map((r) => ({
      from: String(r.from),
      to: String(r.to),
      kind: String(r.kind),
    }));

    const ambPath = opts.ambiguitiesPath ?? DEFAULT_AMBIGUITIES_PATH;
    const rawAmbs = existsSync(ambPath)
      ? (JSON.parse(readFileSync(ambPath, "utf8")).ambiguities as any[])
      : ((this.graphData["model"]?.["ambiguities"]?.["ambiguities"] ?? []) as any[]);
    this.ambiguitiesList = rawAmbs.map((a) => ({
      id: String(a.id),
      provision: String(a.provision),
      phrase: String(a.phrase ?? ""),
      settled_by: typeof a.settled_by === "string" ? a.settled_by : undefined,
      effects: Array.isArray(a.effects) ? a.effects : [],
    }));
  }

  async graphLoadId(): Promise<string> {
    return this.loadId;
  }

  async readReadingGuide(): Promise<ReadingGuideType> {
    return C.ReadingGuide.parse({
      id: "reading-guide",
      version: this.loadId,
      text: this.readingGuideText,
    });
  }

  async readLayerIndex(args: { city_layer: string; as_of: string; state_layer?: string }): Promise<LayerIndexType> {
    const layers = [args.state_layer ?? "OR", args.city_layer];
    const provisions = (this.graphData["provisions"] ?? []) as Array<Record<string, any>>;
    const provById = new Map<string, Record<string, any>>(provisions.map((p) => [String(p["id"]), p]));

    const operatorBackedProvisions = new Set<string>();
    for (const op of this.operatorsList) {
      for (const pid of op.provisions) {
        operatorBackedProvisions.add(pid);
      }
    }

    const byLayer = new Map<string, IndexEntryType[]>();

    for (const pid of this.sliceProvisionIds) {
      const p = provById.get(pid);
      if (!p) continue;
      const layer = String(p["layer"] ?? "");
      if (!layers.includes(layer)) continue;

      const versions = ((p["versions"] ?? []) as Array<Record<string, any>>)
        .filter((v) => isVersionInForce(v, args.as_of))
        .sort((a, b) => Number(b["version"] ?? 1) - Number(a["version"] ?? 1));
      const v = versions[0];
      if (!v) continue;

      const verNum = Number(v["version"] ?? 1);
      const versionId = `${pid}#v${verNum}`;

      const rawClauses = ((v["clauses"] ?? []) as Array<Record<string, any>>)
        .map((c, idx) => {
          const span = Array.isArray(c["span"]) ? c["span"] : [idx, idx];
          return {
            id: `${versionId}::${String(c["id"])}`,
            kind: String(c["kind"] ?? "sentence"),
            quote: String(c["quote"] ?? ""),
            start: Number(span[0] ?? idx),
            guards: Array.isArray(c["guards"]) ? (c["guards"] as Array<Record<string, any>>) : [],
          };
        })
        .sort((a, b) => a.start - b.start);

      const appliesToQuote =
        typeof v["applies_to_quote"] === "string"
          ? v["applies_to_quote"]
          : typeof v["applies_to"]?.["quote"] === "string"
            ? v["applies_to"]["quote"]
            : null;
      const zonesQuote =
        typeof v["zones_quote"] === "string"
          ? v["zones_quote"]
          : typeof v["zones"]?.["quote"] === "string"
            ? v["zones"]["quote"]
            : null;
      const lead = appliesToQuote ?? zonesQuote;

      let scope_clause_id: string;
      let scope_quote: string;
      let source: "graph" | "curated";
      let basis: "stated" | "curated" | "guessed";

      if (lead) {
        const matched = rawClauses.find(
          (cl) =>
            cl.kind !== "heading" &&
            cl.kind !== "footnote" &&
            (ws(cl.quote).includes(ws(lead)) || ws(lead).includes(ws(cl.quote) || "\u0000")),
        );
        const c =
          matched ??
          rawClauses.find((cl) => cl.kind !== "heading" && cl.guards.length > 0) ??
          rawClauses[0]!;
        scope_clause_id = c.id;
        scope_quote = lead;
        source = "graph";
        basis = matched ? "stated" : "guessed";
      } else if (this.scopeOverrides.has(pid)) {
        const o = this.scopeOverrides.get(pid)!;
        scope_clause_id = o.scope_clause_id;
        scope_quote = o.scope_quote;
        source = "curated";
        basis = "curated";
      } else {
        const c = rawClauses.find((cl) => cl.kind !== "heading" && cl.kind !== "footnote") ?? rawClauses[0]!;
        scope_clause_id = c.id;
        scope_quote = c.quote;
        source = "graph";
        basis = "guessed";
      }

      const zones = new Set<string>();
      for (const cl of rawClauses) {
        for (const gd of cl.guards) {
          if (gd["fact"] === "site.zone" && gd["op"] === "in" && Array.isArray(gd["value"])) {
            for (const zVal of gd["value"]) {
              zones.add(String(zVal));
            }
          }
        }
      }

      const ops = this.operatorsList.filter((o) => o.provisions.includes(pid)).map((o) => o.id);
      const modifiesOp = this.relationsList.some(
        (r) => r.kind === "modifies" && r.from === pid && operatorBackedProvisions.has(r.to),
      );
      const whenFrom = versionWhenFrom(v);
      const whenTo = versionWhenTo(v);
      const paramNames = Array.from(
        new Set(((v["params"] ?? []) as Array<Record<string, any>>).map((pa) => String(pa["name"])).filter(Boolean)),
      ).sort();
      const readingsCount = Array.isArray(v["readings"]) ? v["readings"].length : 0;

      const entry = C.IndexEntry.parse({
        provision_id: pid,
        layer,
        type: String(p["type"]),
        evaluation_stage: stageOf(String(p["type"]), ops),
        title: typeof p["title"] === "string" && p["title"].length > 0 ? p["title"] : pid,
        section: typeof p["section"] === "string" ? p["section"] : null,
        param_names: paramNames,
        gray_areas: readingsCount,
        scope: {
          applies_to_zones: [...zones],
          project_kinds: [],
          scope_clause_id,
          scope_quote,
          source,
          basis,
        },
        in_force: {
          from: whenFrom,
          to: whenTo,
          date_not_stated: whenFrom === null,
        },
        has_operator: ops.length > 0,
        modifies_operator_backed: modifiesOp,
      });

      const list = byLayer.get(layer) ?? [];
      list.push(entry);
      byLayer.set(layer, list);
    }

    const out = layers
      .filter((l) => byLayer.has(l))
      .map((l, i) => ({
        layer: l,
        order: i,
        provisions: byLayer.get(l)!.sort((a, b) => a.provision_id.localeCompare(b.provision_id)),
      }));

    return C.LayerIndex.parse({
      graph_load_id: this.loadId,
      as_of: args.as_of,
      index_hash: sha256Hex(canon(out)),
      layers: out,
    });
  }

  async readRuleFamily(args: { provision_ids: string[]; as_of: string }): Promise<RuleFamilyType[]> {
    const provisions = (this.graphData["provisions"] ?? []) as Array<Record<string, any>>;
    const provById = new Map<string, Record<string, any>>(provisions.map((p) => [String(p["id"]), p]));
    const docById = new Map<string, Record<string, any>>(
      ((this.graphData["documents"] ?? []) as Array<Record<string, any>>).map((d) => [String(d["id"]), d]),
    );

    const results: RuleFamilyType[] = [];

    for (const pid of args.provision_ids) {
      const p = provById.get(pid);
      if (!p) continue;

      const versions = ((p["versions"] ?? []) as Array<Record<string, any>>)
        .filter((v) => isVersionInForce(v, args.as_of))
        .sort((a, b) => Number(b["version"] ?? 1) - Number(a["version"] ?? 1));
      const v = versions[0] ?? (p["versions"] as Array<Record<string, any>>)?.slice(-1)[0];
      if (!v) continue;

      const verNum = Number(v["version"] ?? 1);
      const versionId = `${pid}#v${verNum}`;
      const docId = String(v["source"]?.["document"] ?? v["document_id"] ?? "");
      const docSha = docById.get(docId)?.["sha256"];
      const versionSha =
        typeof v["sha256"] === "string" && /^[0-9a-f]{64}$/.test(v["sha256"])
          ? v["sha256"]
          : typeof docSha === "string" && /^[0-9a-f]{64}$/.test(docSha)
            ? docSha
            : sha256Hex(
                JSON.stringify({
                  v: verNum,
                  text: v["text"],
                  params: v["params"] ?? [],
                  from: versionWhenFrom(v),
                }),
              );

      const rawClauses = ((v["clauses"] ?? []) as Array<Record<string, any>>)
        .map((c, idx) => {
          const span = Array.isArray(c["span"]) ? c["span"] : [idx, idx];
          return { raw: c, start: Number(span[0] ?? idx) };
        })
        .sort((a, b) => a.start - b.start)
        .map((x) => x.raw);

      const clauses: RuleFamilyType["clauses"] = rawClauses.map((c) => {
        const clauseId = `${versionId}::${String(c["id"])}`;
        const rawGuards = Array.isArray(c["guards"]) ? (c["guards"] as Array<Record<string, any>>) : [];
        const guards = rawGuards
          .filter((gd) => typeof gd["fact"] === "string" && /^(site|plan)\.[a-z0-9_]+$/.test(gd["fact"]))
          .map((gd) => ({
            fact: String(gd["fact"]),
            op: String(gd["op"] ?? "=="),
            ...(gd["value"] !== undefined ? { value: gd["value"] } : {}),
          }));
        return {
          clause_id: clauseId,
          kind: String(c["kind"] ?? "sentence"),
          quote: String(c["quote"] ?? ""),
          modeled: c["status"] === "modeled",
          guards,
          disposition: this.dispositionsMap.get(clauseId) ?? null,
          needs: (Array.isArray(c["needs"]) ? (c["needs"] as unknown[]) : []).filter((x): x is string => typeof x === "string" && /^(site|plan)\.[a-z0-9_]+$/.test(x)),
        };
      });

      const rawParams = (v["params"] ?? []) as Array<Record<string, any>>;
      const params: RuleFamilyType["params"] = rawParams.map((pa) => {
        const name = String(pa["name"]);
        const modelingClause = rawClauses.find(
          (c) => Array.isArray(c["by"]) && (c["by"] as string[]).includes(`param:${name}`),
        );
        const clauseId = modelingClause ? `${versionId}::${String(modelingClause["id"])}` : null;
        const rawVal = pa["value"];
        const val: number | string =
          typeof rawVal === "number"
            ? rawVal
            : typeof rawVal === "string"
              ? rawVal
              : rawVal !== undefined && rawVal !== null
                ? JSON.stringify(rawVal)
                : "";
        const quote =
          typeof pa["quote"] === "string"
            ? pa["quote"]
            : pa["cell"]
              ? JSON.stringify(pa["cell"])
              : String(val);
        return {
          param_id: `${versionId}::param:${name}`,
          provision_id: pid,
          name,
          value: val,
          unit: typeof pa["unit"] === "string" ? pa["unit"] : null,
          quote,
          clause_id: clauseId,
        };
      });

      const rawCells = (v["table_cells"] ?? []) as Array<Record<string, any>>;
      const cells: RuleFamilyType["cells"] = rawCells.map((tc) => {
        const table = String(tc["table"] ?? "");
        const rg = String(tc["row_group"] ?? "");
        const ri = String(tc["row_index"] ?? "");
        const row = String(tc["row"] ?? "");
        const cg = String(tc["column_group"] ?? "");
        const column = String(tc["column"] ?? "");
        const text = String(tc["cell"] ?? "");
        const cellId =
          typeof tc["id"] === "string"
            ? tc["id"]
            : `${versionId}::cell:${table}|${rg}|${ri}|${row}|${cg}|${column}`;
        return {
          cell_id: cellId,
          table,
          row,
          column,
          text,
        };
      });

      const rawReadings = (v["readings"] ?? []) as Array<Record<string, any>>;
      const readings: RuleFamilyType["readings"] = [];
      const grayAreaEffects: RuleFamilyType["gray_area_effects"] = [];

      for (const rd of rawReadings) {
        const phrase = String(rd["phrase"] ?? "");
        const matchedAmb = this.ambiguitiesList.find(
          (a) => a.provision === pid && normText(a.phrase) === normText(phrase),
        );
        if (!matchedAmb) continue;
        const rdList = Array.isArray(rd["readings"])
          ? (rd["readings"] as unknown[]).map((item) =>
              typeof item === "string"
                ? item
                : item && typeof item === "object" && "text" in (item as Record<string, unknown>)
                  ? String((item as Record<string, unknown>)["text"])
                  : item && typeof item === "object" && "reading" in (item as Record<string, unknown>)
                    ? String((item as Record<string, unknown>)["reading"])
                    : JSON.stringify(item),
            )
          : [];
        if (rdList.length >= 2) {
          readings.push({
            ambiguity_id: matchedAmb.id,
            phrase,
            readings: rdList,
            settled_by: matchedAmb.settled_by ?? "",
          });
        }
        for (const eff of matchedAmb.effects ?? []) {
          grayAreaEffects.push({
            ambiguity_id: matchedAmb.id,
            ...(eff.fact ? { fact: eff.fact } : {}),
            ...(eff.provision ? { provision_id: eff.provision } : {}),
            ...(eff.param ? { param: eff.param } : {}),
          });
        }
      }

      const ops = this.operatorsList
        .filter((o) => o.provisions.includes(pid))
        .map((o) => ({ operator_id: o.id, tool: o.tool }));

      const modifiedBy = Array.from(
        new Set(this.relationsList.filter((r) => r.kind === "modifies" && r.to === pid).map((r) => r.from)),
      ).sort();

      const preemptedBy = Array.from(
        new Set(this.relationsList.filter((r) => r.kind === "preempts" && r.to === pid).map((r) => r.from)),
      ).sort();

      const usesFromRels = this.relationsList.filter((r) => r.kind === "uses" && r.from === pid).map((r) => r.to);
      const usesFromProp = Array.isArray(p["uses"])
        ? (p["uses"] as unknown[]).map(String).filter((u) => provById.has(u))
        : [];
      const usesDefinitions = Array.from(new Set([...usesFromRels, ...usesFromProp])).sort();

      results.push(
        C.RuleFamily.parse({
          provision_id: pid,
          version_id: versionId,
          sha256: versionSha,
          evaluation_stage: stageOf(
            String(p["type"]),
            ops.map((o) => o.operator_id),
          ),
          params,
          cells,
          clauses,
          readings,
          gray_area_effects: grayAreaEffects,
          operators: ops,
          modified_by: modifiedBy,
          preempted_by: preemptedBy,
          uses_definitions: usesDefinitions,
        }),
      );
    }

    return results;
  }

  async close(): Promise<void> {
    // No-op for file-backed reader.
  }
}

export function createFileGraphReader(opts?: FileGraphReaderOptions): FileGraphReader {
  return new FileGraphReader(opts);
}

export { PLAN_CONSTRAINT_OPERATORS, stageOf };
