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
