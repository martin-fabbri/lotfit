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

export type Rejected = ReviewOutcome["rejected"][number];  // { provision_id: string | null; raw: unknown; reason: RejectReason; detail?: string }
export interface Judged { flag?: ReviewFlag; sound?: string; unclear?: string; rejected: Rejected[]; warnings?: string[] }

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
// write the classes with these \u escapes, never as typed glyphs (ADV-14: a typed U+2010 looks like "-" and
// turns the class into a range that eats every letter)
const qnorm = (s: string) => norm(s.toLowerCase().replace(/[\u2018\u2019\u201b]/g, "'").replace(/[\u201c\u201d\u201f]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s*-\s*/g, "-"));
const ANSWER_KEYS = new Set(["item_sha256", "answer", "category", "quote", "fact", "fact_claim", "claim"]);

function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = m && m[1] !== undefined ? m[1].trim() : t;
  const tries = [cand, cand.slice(cand.indexOf("{"), cand.lastIndexOf("}") + 1)];
  for (const c of tries) {
    try {
      const v: unknown = JSON.parse(c);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    } catch {
      // swallowed: try the next candidate
    }
  }
  return null;
}

export function judgeAnswer(raw: string, item: ReviewItem, kase: Record<string, any>, rubric: Rubric): Judged {
  const pid = item.provision.provision_id;
  const rejected: Rejected[] = [];
  const obj = parseJsonObject(raw);
  if (obj === null) {
    return { rejected: [{ provision_id: pid, raw: raw.slice(0, 500), reason: "bad_schema", detail: "not a JSON object" }], warnings: [] };
  }
  for (const k of Object.keys(obj)) {
    if (!ANSWER_KEYS.has(k)) {
      rejected.push({ provision_id: pid, raw: { [k]: obj[k] }, reason: "out_of_authority" });
      delete obj[k];
    }
  }
  const warnings: string[] = [];
  if (typeof obj.claim === "string" && obj.claim.length > 300) {
    obj.claim = obj.claim.slice(0, 300);
    warnings.push("claim cut at 300 characters");
  }
  if (obj.item_sha256 !== item.item_sha256) {
    warnings.push(`item_sha256 echo ${obj.item_sha256 === undefined ? "missing" : "does not match"}; bound by call`);
    obj.item_sha256 = item.item_sha256;
  }
  const p = C.ReviewerAnswer.safeParse(obj);
  if (!p.success) {
    return { rejected: [...rejected, { provision_id: pid, raw: obj, reason: "bad_schema", detail: p.error.issues.map((i) => i.message).join("; ") }], warnings };
  }
  const a = p.data;
  const textHay = [item.scope.quote, ...item.text.map((t) => t.quote)].map(qnorm);
  const hay = a.answer === "sound" ? [qnorm(item.provision.title), ...textHay] : textHay;
  const q = qnorm(a.quote);
  if (q.length < rubric.min_quote_chars || !hay.some((h) => h.includes(q))) {
    const detail = `${q.length} chars` + (a.answer !== "sound" ? "; an unsound or unclear quote comes from the scope sentence or the rule text" : "");
    return { rejected: [...rejected, { provision_id: pid, raw: obj, reason: "quote_not_in_item", detail }], warnings };
  }
  let confirmed = false;
  if (a.fact !== null) {
    const listed = item.case_facts.some((e) => e.fact === a.fact);
    const known = listed || registeredFacts().has(a.fact);
    const actual = factStatus(kase, a.fact).status;
    if (actual !== a.fact_claim) {
      return { rejected: [...rejected, { provision_id: pid, raw: obj, reason: "fact_claim_false", detail: `${a.fact} is ${actual} in the case, not ${a.fact_claim}` }], warnings };
    }
    if (!known) {
      warnings.push(`${a.fact} is not a fact of this item or of the facts registry; the flag is not confirmed`);
    }
    const ruleFact = (item.rule_facts ?? []).includes(a.fact);
    if (known && !ruleFact) {
      warnings.push(`${a.fact} is not read by this rule's guards; the flag is not confirmed`);
    }
    confirmed = known && ruleFact && (actual !== "absent" || listed);
    const unsettled = ["unknown", "unconfirmed", "conflicting", "absent"].includes(actual);
    if (a.category === "exclusion_on_unknown_fact" && !unsettled) {
      confirmed = false;
      warnings.push(`${a.fact} is ${actual} in the case; exclusion_on_unknown_fact needs an unsettled fact, so the flag is not confirmed`);
    }
    if (a.category === "wrong_exclusion" && unsettled) {
      confirmed = false;
      warnings.push(`${a.fact} is ${actual} in the case; wrong_exclusion needs a fact the case holds, so the flag is not confirmed`);
    }
  }
  if (a.answer === "sound") {
    if (a.fact === null || !["true", "false", "known"].includes(String(a.fact_claim))) {
      return { rejected: [...rejected, { provision_id: pid, raw: obj, reason: "fact_claim_false", detail: "a sound answer rests on a fact the case holds as true, false or known" }], warnings };
    }
    if (!(item.rule_facts ?? []).includes(a.fact)) {
      return { rejected: [...rejected, { provision_id: pid, raw: obj, reason: "fact_claim_false", detail: `a sound answer rests on a fact this rule's guards read (${(item.rule_facts ?? []).join(", ") || "none"})` }], warnings };
    }
    return { sound: pid, rejected, warnings };
  }
  if (a.category === null) {
    return { unclear: pid, rejected, warnings };
  }
  if (!rubric.enabled.has(a.category)) {
    return { rejected: [...rejected, { provision_id: pid, raw: obj, reason: "category_disabled" }], warnings };
  }
  const row = rubric.severity.find((r) => r.category === a.category && r.stages.includes(item.provision.evaluation_stage));
  const severity = row?.severity ?? "low";
  const route = row?.route ?? "attach";
  if (a.category === "scope_sentence_not_scope") {
    confirmed = false;
  }
  return {
    flag: C.ReviewFlag.parse({ flag_id: makeUuid7(), provision_id: pid, category: a.category, severity, confirmed, quote: a.quote, fact: a.fact, fact_claim: a.fact_claim, claim: a.claim, item_sha256: item.item_sha256, route }),
    rejected,
    warnings,
  };
}

export interface ReviewOptions {
  items: ReviewItem[];
  client: ReviewerClient | null;
  plannerModel: string;                 // the Planner's modelId, for the different-model rule
  verdict: z.infer<typeof C.Verdict>;   // the final report's verdict
  kase: Record<string, any>;
  rubric: Rubric;
  timeoutMs?: number;                   // per call; default 20_000
  deadlineMs?: number;                  // the whole review; default 60_000
}

export interface ReviewResult {
  outcome: ReviewOutcome;               // C.ReviewOutcome, parsed
  calls: Array<{ item: ReviewItem; content: string; usage: UsageRecord }>;  // replies that arrived, in arrival order
}

export async function review(o: ReviewOptions): Promise<ReviewResult> {
  const rub = { id: o.rubric.id, version: o.rubric.version, sha256: o.rubric.sha256 };
  const notRun = (
    category: string,
    message: string,
    usage: UsageRecord[] = [],
    rejected: Rejected[] = [],
    warnings: ReviewOutcome["warnings"] = [],
    calls: ReviewResult["calls"] = [],
  ): ReviewResult => ({
    outcome: C.ReviewOutcome.parse({
      status: "not_run", answered: 0, warnings, model: o.client?.modelId ?? "none",
      rubric: rub, items: o.items.length, flags: [], sound: [], unclear: [], rejected, hold: false,
      error: { category, message }, usage,
    }),
    calls,
  });
  if (o.client === null) {
    return notRun("harness", "no Reviewer configured for this run");
  }
  const client = o.client;
  if (canonicalModel(client.modelId) === canonicalModel(o.plannerModel)) {
    return notRun("harness", `the Reviewer must be a different model from the Planner (B4): both are ${canonicalModel(o.plannerModel)}`);
  }
  const timeoutMs = o.timeoutMs ?? 20_000;
  const deadline = Date.now() + (o.deadlineMs ?? 60_000);
  const calls: ReviewResult["calls"] = [];
  const withDeadline = <T,>(p: Promise<T>): Promise<T> => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(new Error("review deadline reached"));
    p.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("review deadline reached")), Math.min(left, timeoutMs + 1000));
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };
  const results: Judged[] = await Promise.all(o.items.map(async (item): Promise<Judged> => {
    const pid = item.provision.provision_id;
    const user = renderItem(item);
    const earlier: Rejected[] = [];
    const warnings: string[] = [];
    let last: Judged = { rejected: [] };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const msg = attempt === 1 || last.rejected.length === 0
        ? user
        : `${user}\n\nYour previous reply was not valid: ${last.rejected.map((r) => r.detail ?? r.reason).join("; ")}. Reply with the JSON object only.`;
      let reply: ReviewerReply;
      try {
        reply = await withDeadline(client.answer({ item, system: o.rubric.system, user: msg, timeoutMs }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const r: Rejected = { provision_id: pid, raw: null, reason: "no_answer", detail: message.slice(0, 300) };
        if (attempt === 1 && !/deadline/.test(r.detail ?? "")) {
          earlier.push(r);
          last = { rejected: [] };
          continue;
        }
        return { rejected: [...earlier, r], warnings };
      }
      calls.push({ item, content: reply.content, usage: reply.usage });
      last = judgeAnswer(reply.content, item, o.kase, o.rubric);
      warnings.push(...(last.warnings ?? []));
      const answeredThis = last.flag !== undefined || last.sound !== undefined || last.unclear !== undefined;
      const retryable = !answeredThis && last.rejected.some((x) => x.reason === "bad_schema");
      if (!retryable) {
        return { ...last, rejected: [...earlier, ...last.rejected], warnings };
      }
      earlier.push(...last.rejected);
    }
    return { ...last, rejected: [...earlier.filter((r) => !last.rejected.includes(r)), ...last.rejected], warnings };
  }));
  const usage = calls.map((c) => c.usage);
  const rejected = results.flatMap((r) => r.rejected);
  const warnings = results.flatMap((r, i) => (r.warnings ?? []).map((detail) => ({ provision_id: o.items[i]!.provision.provision_id, detail })));
  const answered = results.filter((r) => r.flag !== undefined || r.sound !== undefined || r.unclear !== undefined).length;
  if (o.items.length > 0 && answered === 0) {
    const why = results.every((r) => r.rejected.some((x) => x.reason === "no_answer")) ? "no answer" : "no accepted answer";
    return notRun("model", `${why} for any of ${o.items.length} item(s): ${rejected[rejected.length - 1]?.detail ?? rejected[0]?.reason ?? "provider error"}`, usage, rejected, warnings, calls);
  }
  const flags = results.flatMap((r) => (r.flag ? [r.flag] : []));
  const hold = (o.verdict === "FITS" || o.verdict === "FITS_IF") && flags.some((f) => f.severity === "high" && f.confirmed && f.route === "hold_if_fits");
  const status = answered < o.items.length ? "partial" : flags.length > 0 ? "flagged" : "clean";
  const sound = results.flatMap((r) => (r.sound ? [r.sound] : []));
  const unclear = results.flatMap((r) => (r.unclear ? [r.unclear] : []));
  const error = status === "partial"
    ? { category: "model", message: `${o.items.length - answered} of ${o.items.length} item(s) have no accepted answer` }
    : null;
  return { calls, outcome: C.ReviewOutcome.parse({ status, answered, warnings, model: client.modelId, rubric: rub, items: o.items.length, flags, sound, unclear, rejected, hold, error, usage }) };
}

export type FlagResolvedData = Extract<LotFitEvent, { type: "lotfit.flag_resolved" }>["data"];

export function resolutionValid(
  ev: Extract<LotFitEvent, { type: "lotfit.flag_resolved" }>,
  people: People,
): { ok: boolean; why: string } {
  const named = (n: unknown): n is string =>
    typeof n === "string" && n.length > 0 && people.people.some((p) => p.name === n.trim());
  if (ev.data.action !== "dismissed") {
    return { ok: false, why: `${ev.data.action} forks a new run (B6); this report stays held until the flag is dismissed` };
  }
  if (named(ev.data.by)) {
    return { ok: true, why: "named person" };
  }
  const obo = ev.data.on_behalf_of;
  if (named(obo)) {
    return { ok: true, why: `agent on ${obo}'s delegation` };
  }
  return { ok: false, why: `${ev.data.by} is not a named person on reviewer/people.json and names no one on it in on_behalf_of` };
}

export function deliveryAllowed(
  report: Report,
  events: Iterable<LotFitEvent>,
  people: People,
  threadId: string,                      // required: the thread of the run that made this report
): { allowed: boolean; open: string[]; reviewed: "yes" | "partly" | "no" } {
  const r = report.reviewer;
  const reviewed: "yes" | "partly" | "no" = !r || r.status === "not_run" ? "no" : r.status === "partial" ? "partly" : "yes";
  const held: string[] = !r || (report.verdict !== "FITS" && report.verdict !== "FITS_IF")
    ? []
    : r.flags.filter((f) => f.severity === "high" && f.confirmed && f.route === "hold_if_fits").map((f) => f.flag_id);
  if (held.length === 0) {
    return { allowed: true, open: [], reviewed };
  }
  const closed = new Set<string>();
  for (const ev of events) {
    if (ev.type === "lotfit.flag_resolved" && ev.thread_id === threadId && resolutionValid(ev, people).ok) {
      closed.add(ev.data.flag_id);
    }
  }
  const open = held.filter((id) => !closed.has(id));
  return { allowed: open.length === 0, open, reviewed };
}

export function deliveryAllowedForRun(runDir: string, people: People = loadPeople()):
  { allowed: boolean; open: string[]; reviewed: "yes" | "partly" | "no"; why: string } {
  const raw = readFileSync(join(runDir, "events.jsonl"), "utf8");
  const events = raw.split("\n").filter((line) => line.trim() !== "").map((line) => C.LotFitEvent.parse(JSON.parse(line)));
  if (events.length === 0) {
    throw new Error(`no events in ${runDir}`);
  }
  const thread = events[0]!.thread_id;
  const text = readFileSync(join(runDir, "report.json"), "utf8");
  let written: Extract<LotFitEvent, { type: "artifact_written" }> | undefined;
  for (const ev of events) {
    if (ev.type === "artifact_written" && ev.data.artifact.path === "report.json") {
      written = ev;
    }
  }
  if (!written || written.data.artifact.sha256 !== sha256Hex(text)) {
    return { allowed: false, open: [], reviewed: "no", why: "report.json is not the file this run wrote" };
  }
  const report = C.Report.parse(JSON.parse(text));
  const d = deliveryAllowed(report, events, people, thread);
  return { ...d, why: d.allowed ? "no open hold" : `${d.open.length} held flag(s) open` };
}

export function recordResolution(runDir: string,
  data: Omit<FlagResolvedData, "when" | "fork_thread_id"> & { fork_thread_id?: string | null },
  people: People = loadPeople(), when: string = new Date().toISOString()): LotFitEvent {
  const raw = readFileSync(join(runDir, "events.jsonl"), "utf8");
  const events = raw.split("\n").filter((line) => line.trim() !== "").map((line) => C.LotFitEvent.parse(JSON.parse(line)));
  if (events.length === 0) {
    throw new Error(`no events in ${runDir}`);
  }
  const thread = events[0]!.thread_id;
  const last = events[events.length - 1]!;
  const text = readFileSync(join(runDir, "report.json"), "utf8");
  let written: Extract<LotFitEvent, { type: "artifact_written" }> | undefined;
  for (const ev of events) {
    if (ev.type === "artifact_written" && ev.data.artifact.path === "report.json") {
      written = ev;
    }
  }
  if (!written || written.data.artifact.sha256 !== sha256Hex(text)) {
    throw new Error("report.json is not the file this run wrote");
  }
  const report = C.Report.parse(JSON.parse(text));
  const flags = report.reviewer?.flags ?? [];
  if (!flags.some((f) => f.flag_id === data.flag_id)) {
    throw new Error(`flag ${data.flag_id} is not in this run's review`);
  }
  const ev = C.LotFitEvent.parse({
    id: makeUuid7(), thread_id: thread, session_id: null, turn_id: null, seq: last.seq + 1,
    created_at: when, config_hash: last.config_hash, graph_load_id: last.graph_load_id,
    type: "lotfit.flag_resolved",
    data: { ...data, when, fork_thread_id: data.fork_thread_id ?? null, on_behalf_of: data.on_behalf_of ?? null },
  }) as Extract<LotFitEvent, { type: "lotfit.flag_resolved" }>;
  const named = (n: unknown): n is string =>
    typeof n === "string" && n.length > 0 && people.people.some((p) => p.name === n.trim());
  if (!named(ev.data.by) && !named(ev.data.on_behalf_of)) {
    throw new Error(`${data.by} is not a named person on reviewer/people.json and names no one on it in on_behalf_of`);
  }
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(ev) + "\n");
  return ev;
}

export function mergeReview(report: Report, outcome: ReviewOutcome, configured: boolean): Report {
  return C.Report.parse({ ...report, reviewer: outcome, telemetry: { ...report.telemetry, models: { ...report.telemetry.models, ...(configured ? { reviewer: outcome.model } : {}) } } });
}
