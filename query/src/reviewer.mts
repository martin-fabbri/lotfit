import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import * as C from "./types.mts";
import { canonicalJson, makeUuid7, sha256Hex } from "./events.mts";
import type { ReviewerClient, ReviewerReply } from "./reviewer-client.mts";

type FactStatus = z.infer<typeof C.FactStatus>;
export type LotFitEvent = z.infer<typeof C.LotFitEvent>;
export type IndexEntry = z.infer<typeof C.IndexEntry>;
export type RuleFamily = z.infer<typeof C.RuleFamily>;
export type ReviewItem = z.infer<typeof C.ReviewItem>;
export type ReviewOutcome = z.infer<typeof C.ReviewOutcome>;
export type ReviewFlag = z.infer<typeof C.ReviewFlag>;
export type Report = z.infer<typeof C.Report>;
type UsageRecord = z.infer<typeof C.UsageRecord>;
const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_RUBRIC_PATH: string = join(HERE, "..", "reviewer", "rubric-v1.json");
export const DEFAULT_PEOPLE_PATH: string = join(HERE, "..", "reviewer", "people.json");

export interface Rubric {
  id: string;
  version: string;
  sha256: string;
  enabled: Set<string>;
  reviewed_stages: Set<string>;
  severity: Array<{
    category: string;
    stages: string[];
    severity: "high" | "medium" | "low";
    route: "hold_if_fits" | "attach" | "rulebook_queue";
  }>;
  min_quote_chars: number;
  system: string;
}

export function loadRubric(path: string = DEFAULT_RUBRIC_PATH): Rubric {
  const raw = readFileSync(path, "utf8");
  const j = JSON.parse(raw);
  for (const c of j.enabled) {
    C.FlagCategory.parse(c);
  }
  for (const st of j.reviewed_stages) {
    C.EvaluationStage.parse(st);
  }
  for (const r of j.severity) {
    C.FlagCategory.parse(r.category);
    for (const st of r.stages) {
      C.EvaluationStage.parse(st);
    }
    C.Severity.parse(r.severity);
    C.ReviewFlag.shape.route.parse(r.route);
  }
  return {
    id: j.id,
    version: String(j.version),
    sha256: sha256Hex(raw),
    enabled: new Set(j.enabled),
    reviewed_stages: new Set(j.reviewed_stages),
    severity: j.severity,
    min_quote_chars: j.min_quote_chars,
    system: (j.system as string[]).join("\n"),
  };
}

export interface People {
  people: Array<{ name: string; role: string }>;
}

export function loadPeople(path: string = DEFAULT_PEOPLE_PATH): People {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function canonicalModel(id: string): string {
  let s = id.trim().toLowerCase().split("/").pop() ?? "";
  s = s.replace(/:[a-z0-9_-]+$/, "");
  s = s.replace(/(\d)p(\d)/g, "$1.$2");
  s = s.replace(/_/g, "-").replace(/-\d{4}$/, "");
  s = s.replace(/-contributor$/, "");
  if (s.startsWith("muse-spark-open")) return "muse-spark-open";
  return s;
}

type Kase = Record<string, any>;

export function factStatus(kase: Kase, fact: string): { status: FactStatus; value?: unknown } {
  const [scope, key] = fact.split(".") as [string, string];
  const bag = kase?.[scope];
  const e = bag && typeof bag === "object" && Object.hasOwn(bag, key) ? bag[key] : undefined;
  if (e === undefined || e === null) {
    if ((kase?.unknowns ?? []).some((u: any) => u.fact === fact)) {
      return { status: "unknown" };
    }
    return { status: "absent" };
  }
  if (typeof e !== "object" || Array.isArray(e)) {
    return { status: "known", value: e };
  }
  if (Array.isArray(e.observations) || e.status === "conflicting") {
    return { status: "conflicting" };
  }
  if (!("value" in e)) {
    return { status: "known" };
  }
  if (e.status === "unconfirmed") {
    return { status: "unconfirmed", value: e.value };
  }
  if (e.value === true) {
    return { status: "true", value: true };
  }
  if (e.value === false) {
    return { status: "false", value: false };
  }
  return { status: "known", value: e.value };
}

export const isScalarish: (v: unknown) => boolean = (v) =>
  v === null ||
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  (Array.isArray(v) && v.every((x) => typeof x === "string"));

export const DEFAULT_FACTS_PATH: string = join(HERE, "..", "..", "graph", "curated", "facts.json");

let factsPath: string = DEFAULT_FACTS_PATH;
let factsCache: Set<string> | null = null;

export function loadFactRegistry(path?: string): Set<string> {
  const p = path ?? factsPath;
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error(`facts registry not readable: ${p}`);
  }
  let raw: unknown[];
  if (Array.isArray(j)) {
    raw = j;
  } else if (j !== null && typeof j === "object" && Array.isArray((j as { facts?: unknown }).facts)) {
    raw = (j as { facts: unknown[] }).facts;
  } else if (j !== null && typeof j === "object") {
    const o = j as Record<string, unknown>;
    raw = Object.keys((o.facts as Record<string, unknown>) ?? o);
  } else {
    raw = [];
  }
  const kept: string[] = [];
  const re = /^(site|plan)\.[a-z0-9_]+$/;
  for (const f of raw) {
    let name: unknown;
    if (typeof f === "string") {
      name = f;
    } else if (f !== null && typeof f === "object") {
      const o = f as Record<string, unknown>;
      name = o.name ?? o.fact ?? o.id;
    } else {
      continue;
    }
    if (typeof name === "string" && re.test(name)) {
      kept.push(name);
    }
  }
  if (kept.length === 0) {
    throw new Error(`facts registry not readable: ${p}`);
  }
  return new Set(kept);
}

export function registeredFacts(): Set<string> {
  if (factsCache === null) {
    factsCache = loadFactRegistry(factsPath);
  }
  return factsCache;
}

export function resetFactRegistry(path: string = DEFAULT_FACTS_PATH): void {
  factsPath = path;
  factsCache = null;
}

export interface ItemInputs {
  events: Iterable<LotFitEvent>;                 // the run's events (C6)
  index: Map<string, IndexEntry>;                // provision_id → index entry (C2)
  ruleFamilies: Map<string, RuleFamily>;         // provision_id → rule family (C2)
  kase: Record<string, any>;                     // the case (C1), read through factStatus (RVS-05)
  run: { thread_id: string; graph_load_id: string; config_hash: string; as_of: string };
  rubric: Rubric;                                // RVS-03
}

export function buildReviewItems(inp: ItemInputs): ReviewItem[] {
  const byProv = new Map<string, Extract<LotFitEvent, { type: "lotfit.exclusion_recorded" }>>();
  for (const ev of inp.events) {
    if (ev.type !== "lotfit.exclusion_recorded") continue;
    byProv.set(ev.data.provision_id, ev);
  }
  const kind = projectKindOf(inp.kase);
  const items: ReviewItem[] = [];
  for (const ev of byProv.values()) {
    if (ev.data.basis !== "planner_reading") continue;
    const e = inp.index.get(ev.data.provision_id);
    if (!e) continue;
    if (!inp.rubric.reviewed_stages.has(e.evaluation_stage)) continue;
    const rf = inp.ruleFamilies.get(e.provision_id);
    if (!rf) {
      throw new Error(`no rule family for ${e.provision_id}: the review cannot read the rule (D5)`);
    }
    const allText = rf.clauses.filter((c) => c.quote.trim() !== "");
    const text = allText.slice(0, 30).map((c) => ({ clause_id: c.clause_id, quote: c.quote }));
    const scopeClause = rf.clauses.find((c) => c.clause_id === ev.data.scope_clause_id);
    const d = scopeClause?.disposition;
    const relied =
      d !== null && d !== undefined && d.kind === "inert_for" && (d.scope === undefined || d.scope === kind)
        ? [{ clause_id: scopeClause!.clause_id, disposition: d }]
        : [];
    const guardFacts = new Set<string>();
    for (const c of rf.clauses) {
      for (const g of c.guards) {
        guardFacts.add(g.fact);
      }
    }
    const registry = registeredFacts();
    const ruleFacts = new Set<string>(guardFacts);
    for (const c of rf.clauses) {
      for (const name of c.needs ?? []) {
        if (registry.has(name)) ruleFacts.add(name);
      }
    }
    const byHandle = (name: string): { fact: string; status: FactStatus; value?: unknown } => {
      const st = factStatus(inp.kase, name);
      if (st.value === undefined || isScalarish(st.value)) {
        return { fact: name, ...st };
      }
      return { fact: name, status: st.status };
    };
    const map = new Map<string, { fact: string; status: FactStatus; value?: unknown }>();
    for (const name of ruleFacts) {
      if (!map.has(name)) map.set(name, byHandle(name));
    }
    for (const scope of ["site", "plan"] as const) {
      const bag: Record<string, unknown> = inp.kase[scope] ?? {};
      for (const k of Object.keys(bag)) {
        const name = `${scope}.${k}`;
        if (!map.has(name)) map.set(name, byHandle(name));
      }
    }
    for (const u of inp.kase.unknowns ?? []) {
      if (!map.has(u.fact)) map.set(u.fact, { fact: u.fact, status: "unknown" });
    }
    const body: Record<string, unknown> = {
      schema: "lotfit.review-item/1",
      run: inp.run,
      provision: {
        provision_id: e.provision_id,
        title: e.title,
        section: e.section,
        type: e.type,
        evaluation_stage: e.evaluation_stage,
        zones: e.scope.applies_to_zones,
        project_kinds: e.scope.project_kinds,
      },
      scope: { clause_id: ev.data.scope_clause_id, quote: e.scope.scope_quote },
      text,
      exclusion: { basis: ev.data.basis, planner_quote: ev.data.scope_quote },
      text_truncated: allText.length > 30,
      rule_facts: [...ruleFacts].sort(),
      ...(relied.length > 0 ? { dispositions_relied_on: relied } : {}),
      case_facts: [...map.values()].sort((a, b) => a.fact.localeCompare(b.fact)),
      rubric: { id: inp.rubric.id, version: inp.rubric.version, sha256: inp.rubric.sha256 },
    };
    const item_sha256 = sha256Hex(canonicalJson(body));
    items.push(C.ReviewItem.parse({ ...body, item_sha256 }));
  }
  return items;
}

export function renderItem(item: ReviewItem): string {
  const p = item.provision;
  const lines: string[] = [];
  lines.push(`item_sha256: ${item.item_sha256}`);
  lines.push(`Rule: ${p.provision_id} — ${p.title} (section ${p.section ?? "n/a"}; stage ${p.evaluation_stage}; zones ${p.zones.join(", ") || "not stated"})`);
  lines.push(`Scope sentence (${item.scope.clause_id}): "${item.scope.quote}"`);
  lines.push(`The analyst excluded it, quoting: "${item.exclusion.planner_quote}"`);
  lines.push(`Rule text:`);
  for (const t of item.text) {
    lines.push(`  [${t.clause_id}] ${t.quote}`);
  }
  const relied = item.dispositions_relied_on ?? [];
  if (relied.length > 0) {
    const list = relied
      .map((r) =>
        r.disposition.scope !== undefined ? `${r.disposition.kind} (${r.disposition.scope})` : r.disposition.kind,
      )
      .join("; ");
    lines.push(`Signed by a person for the scope clause: ${list}`);
  }
  if (item.text_truncated === true) {
    lines.push(`(The rule text above is cut at 30 clauses.)`);
  }
  lines.push(`Lot facts:`);
  lines.push(
    item.case_facts
      .map((f) => {
        const suffix =
          f.value !== undefined && f.status !== "true" && f.status !== "false"
            ? ` (${JSON.stringify(f.value)})`
            : "";
        return `- ${f.fact}: ${f.status}${suffix}`;
      })
      .join("\n"),
  );
  return lines.join("\n");
}

export function projectKindOf(kase: Kase | undefined): string | null {
  const read = (entry: unknown): unknown =>
    entry !== null && typeof entry === "object" && "value" in entry
      ? (entry as { value: unknown }).value
      : entry;
  const bag = kase?.plan;
  const rec = bag !== null && typeof bag === "object" ? (bag as Record<string, unknown>) : undefined;
  const kind = read(rec?.kind);
  const detached = read(rec?.detached);
  if (kind === "adu" && detached === true) return "detached_adu";
  if (kind === "adu" && detached === false) return "attached_adu";
  if (typeof kind === "string") return kind;
  return null;
}
