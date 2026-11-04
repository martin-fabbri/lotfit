// Narration lines: code writes every number and every outcome; the model writes only
// words (a verb-led gloss per rule, a chapter title per beat, one sentence each for the
// establish, envelope and place beats). Model words are checked: no digit outside the
// rule's own quote, no outcome words, length-capped. A failing item gets the code
// fallback; there is no retry call. The summary beat is code only.
import type { ModelClient, ModelRequest } from "./model-client.mts";
import { makeUuid7 } from "./events.mts";

export interface NarrationBeat {
  id: string;
  chapter: string;
  text: string;
  numbers: string[];
  provisions: string[];
  source: "model" | "template";
}
export interface Narration {
  beats: NarrationBeat[];
}

const isProvisionId = (s: string): boolean => /^[A-Z]{2,}\./.test(s);
const textNumbers = (text: string): string[] => text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

const JURISDICTION: Record<string, string> = { EUG: "Eugene", PDX: "Portland", OR: "Oregon", ORS: "Oregon", GRE: "Gresham" };

/** EUG.9.2751.17.a.1 -> "Eugene code 9.2751, 17 a 1"; EUG.T9.2750 -> "Eugene table 9.2750". */
export function spokenRef(pid: string): string {
  const [head, ...segs] = pid.split(".");
  const place = JURISDICTION[head!] ?? head;
  if (!segs.length) return place!;
  if (/^T\d/i.test(segs[0]!)) return `${place} table ${segs.join(".").slice(1)}`;
  const speak = (s: string): string =>
    s.replace(/([A-Za-z]+)/g, " $1").replace(/(\d+)/g, " $1").replace(/\s+/g, " ").trim();
  const code = segs.slice(0, 2).join(".");
  const rest = segs.slice(2).map(speak).join(" ");
  return rest ? `${place} code ${code}, ${rest}` : `${place} code ${code}`;
}

/** 682.72484 sq ft -> "about 683 square feet"; 6.36 ft -> "about 6.4 feet"; 1 count -> "1 unit". */
export function speakMeasure(value: number, unit: string | null): string {
  if (!isFinite(value)) return String(value);
  const u = unit ?? "";
  const words: Record<string, string> = { sqft: "square feet", ft: "feet", in: "inches", "%": "percent", pct: "percent", degrees: "degrees" };
  if (u === "count") {
    const r = Math.round(value);
    return `${r !== value ? "about " : ""}${r} unit${r === 1 ? "" : "s"}`;
  }
  const uw = words[u] ?? u;
  const r = u === "sqft" ? Math.round(value) : Math.round(value * 10) / 10;
  return `${r !== value ? "about " : ""}${String(r)}${uw ? ` ${uw}` : ""}`;
}

export interface SpokenProvision {
  ref: string;
  values: string[];
  limits: string[];
  outcome: string | null;
}
export interface SpokenData {
  provisions: Map<string, SpokenProvision>;
  lot: string[];
  spot: string[];
  houseId: string;
  verdict: string;
}

function limitOf(limit: any): { value: number; unit: string | null } | null {
  if (typeof limit?.value === "number") return { value: limit.value, unit: limit.unit ?? null };
  if (typeof limit === "number") return { value: limit, unit: null };
  return null;
}

/** Spoken forms for every provision in the trace, plus the lot and spot geometry. */
export function buildSpoken(trace: any, report: any): SpokenData {
  const provisions = new Map<string, SpokenProvision>();
  const pids = new Set<string>();
  for (const c of trace?.constraints ?? []) if (c.provision_id) pids.add(c.provision_id);
  for (const b of trace?.beats ?? []) for (const r of b.refs ?? []) if (isProvisionId(r)) pids.add(r);
  for (const f of report?.findings ?? []) if (f.provision_id) pids.add(f.provision_id);
  for (const pid of pids) {
    const finding = (report?.findings ?? []).find((f: any) => f.provision_id === pid);
    const constraint = (trace?.constraints ?? []).find((c: any) => c.provision_id === pid);
    const values: string[] = [];
    const limits: string[] = [];
    const measures = finding?.measures?.length ? finding.measures : constraint?.value != null ? [constraint] : [];
    for (const m of measures) {
      if (typeof m.value === "number") values.push(speakMeasure(m.value, m.unit ?? null));
      const lim = m.limit !== undefined ? limitOf(m.limit) : null;
      if (lim) limits.push(speakMeasure(lim.value, lim.unit));
    }
    provisions.set(pid, { ref: spokenRef(pid), values, limits, outcome: finding?.outcome ?? constraint?.outcome ?? null });
  }
  const lot: number[][] = trace?.site?.lot ?? [];
  const xs = lot.map((p) => p[0] ?? 0), ys = lot.map((p) => p[1] ?? 0);
  const opt = (trace?.options ?? [])[0];
  return {
    provisions,
    lot: xs.length ? [speakMeasure(Math.max(...xs) - Math.min(...xs), "ft"), speakMeasure(Math.max(...ys) - Math.min(...ys), "ft")] : [],
    spot: opt?.placement && typeof opt.placement.x === "number" && typeof opt.placement.y === "number"
      ? [speakMeasure(opt.placement.x, "ft"), speakMeasure(opt.placement.y, "ft")] : [],
    houseId: (trace?.site?.existing ?? [])[0]?.id ?? "house",
    verdict: report?.verdict ?? "",
  };
}

export const OUTCOME_PHRASE: Record<string, string> = {
  pass: "passes",
  fail: "fails",
  too_close_to_call: "is too close to call with the scan, so it gets taped",
  unknown: "isn't measured yet",
};

/** One rule sentence, assembled in code: "<ref> <gloss>. We measured <values> against <limits>: it <phrase>." */
export function ruleSentence(pid: string, gloss: string, spoken: SpokenData): string {
  const p = spoken.provisions.get(pid);
  const ref = p?.ref ?? spokenRef(pid);
  const clean = gloss.trim().replace(/\.+$/, "").replace(/^[A-Z]/, (c) => c.toLowerCase());
  const head = `${ref} ${clean}.`;
  const phrase = OUTCOME_PHRASE[p?.outcome ?? ""] ?? OUTCOME_PHRASE.unknown!;
  if ((p?.outcome ?? "unknown") === "unknown") return `${ref} ${clean}, which isn't measured yet.`;
  const v = (p?.values ?? []).join(" and ");
  const l = (p?.limits ?? []).join(" and ");
  if (v && l) return `${head} We measured ${v} against ${l}: it ${phrase}.`;
  if (v) return `${head} We measured ${v}: it ${phrase}.`;
  if (l) return `${head} Against ${l}, it ${phrase}.`;
  return `${head} It ${phrase}.`;
}

export function findingQuote(report: any, pid: string): string {
  const f = (report?.findings ?? []).find((x: any) => x.provision_id === pid);
  return (f?.citations ?? [])[0]?.quote ?? "";
}

const BANNED = /\b(pass\w*|fail\w*|fits?|compl\w*|allow\w*|too\s+close)\b/i;

export interface WordCheck { ok: boolean; reasons: string[]; }

/** A model gloss: no digit outside its quote, no outcome word, at most 14 words. */
export function checkGloss(gloss: string, quote: string): WordCheck {
  return checkWords(gloss, [quote], 14);
}

const INVENTED_FEATURE = /\b(trees?|landscaping|gardens?|fences?|driveways?|pools?|decks?|sheds?|garages?|patios?)\b/i;

/** A model beat sentence: digits only from the refs' quotes or the beat's facts, no outcome
 *  word, no feature that isn't in the trace, at most 30 words. */
export function checkSentence(sentence: string, quotes: string[], facts: string[] = []): WordCheck {
  const chk = checkWords(sentence, [...quotes, ...facts], 30);
  const feat = sentence.match(INVENTED_FEATURE);
  if (feat) chk.reasons.push(`names "${feat[0]}", which is not in the trace`);
  return { ok: chk.ok && !feat, reasons: chk.reasons };
}

function checkWords(text: string, quotes: string[], maxWords: number): WordCheck {
  const reasons: string[] = [];
  for (const raw of textNumbers(text)) {
    const digits = raw.replace(/,/g, "");
    if (!quotes.some((q) => q.includes(digits))) reasons.push(`number ${raw} is not in the rule's own quote`);
  }
  const bad = text.match(BANNED);
  if (bad) reasons.push(`outcome word "${bad[0]}" must come from code, not the model`);
  if (words(text).length > maxWords) reasons.push(`over ${maxWords} words`);
  if (!words(text).length) reasons.push("empty");
  return { ok: reasons.length === 0, reasons };
}

/** A model chapter title: 2-4 words. */
export function checkChapter(title: string): WordCheck {
  const n = words(title).length;
  return n >= 2 && n <= 4 ? { ok: true, reasons: [] } : { ok: false, reasons: ["chapter is not 2-4 words"] };
}

export const FALLBACK_GLOSS = "sets a limit";
const FALLBACK_CHAPTER: Record<string, string> = {
  establish: "The lot", constrain: "The rules", height: "The rules",
  envelope: "The space", place: "The spot", summary: "The answer",
};
export const fallbackChapter = (kind: string): string => FALLBACK_CHAPTER[kind] ?? "The rules";

/** Template sentence built in code for the establish, envelope and place beats. */
export function templateLine(kind: string, refs: string[], spoken: SpokenData): string {
  if (kind === "establish") {
    return spoken.lot.length === 2
      ? `The lot measures ${spoken.lot[0]} by ${spoken.lot[1]}, with the ${spoken.houseId} on it.`
      : "The lot is on screen, with the house on it.";
  }
  if (kind === "place") {
    return spoken.spot.length === 2
      ? `The unit goes at the client spot, ${spoken.spot[0]} from the left and ${spoken.spot[1]} back.`
      : "The unit goes at the client spot.";
  }
  if (spoken.verdict === "NO_LEGS") return "No space is left to build in inside the setbacks.";
  const setback = refs.map((r) => spoken.provisions.get(r)).find((p) => p && /setback/i.test(p.ref) && p.limits.length);
  const any = refs.map((r) => spoken.provisions.get(r)).find((p) => p && p.limits.length);
  const limit = setback?.limits[0] ?? any?.limits[0];
  return limit ? `Inside setbacks of ${limit}, space is left to build in.` : "Space is left to build in inside the setbacks.";
}

/** Summary sentence, code only: the verdict and what remains open. */
export function templateSummary(openRefs: string[], spoken: SpokenData): string {
  const v = spoken.verdict;
  const sentence =
    v === "FITS" ? "It fits." : v === "NEEDS_CHECK" ? "It needs a check." : v === "DOESNT_FIT" ? "It does not fit." :
    v === "NO_LEGS" ? "No spot found." : v === "FITS_IF" ? "It fits, if the conditions hold." :
    v === "BLOCKED_BY_GATE" ? "It is not allowed here." : "It is not measured yet.";
  if (!openRefs.length) return `${sentence} Nothing remains open.`;
  const shown = openRefs.slice(0, 3).map((r) => spoken.provisions.get(r)?.ref ?? r).join("; ");
  return `${sentence} Still open: ${shown}${openRefs.length > 3 ? "; and others" : ""}.`;
}

function beatSentenceAsk(kind: string): string | null {
  if (kind === "establish") return "the lot and the house on screen";
  if (kind === "envelope") return "the space left to build in";
  if (kind === "place") return "the unit at the client spot";
  return null;
}

/** Facts a sentence beat may use: establish gets the lot size and the house, envelope the
 *  setbacks, place the spot's distance from the left and from the front. */
export function beatFacts(kind: string, refs: string[], spoken: SpokenData): string[] {
  if (kind === "establish") {
    return spoken.lot.length === 2
      ? [`the lot measures ${spoken.lot[0]} by ${spoken.lot[1]}`, `the ${spoken.houseId}`]
      : ["the lot", "the house"];
  }
  if (kind === "place") {
    return spoken.spot.length === 2
      ? [`${spoken.spot[0]} from the left`, `${spoken.spot[1]} from the front`]
      : ["the client spot"];
  }
  const withLimits = refs.map((r) => spoken.provisions.get(r)).filter((p) => p && p.limits.length);
  const setbacks = withLimits.filter((p) => /setback/i.test(p!.ref));
  const limits = [...new Set((setbacks.length ? setbacks : withLimits).flatMap((p) => p!.limits))];
  return limits.length ? [`setbacks of ${limits.join(" and ")}`] : ["the setbacks"];
}

/** Short prompt: per provision only its id and quote; per sentence beat the facts it may use. */
export function buildPrompt(trace: any, report: any, spoken: SpokenData): string {
  const pids = new Set<string>();
  for (const b of trace?.beats ?? []) for (const r of b.refs ?? []) if (isProvisionId(r)) pids.add(r);
  for (const f of report?.findings ?? []) if (f.provision_id) pids.add(f.provision_id);
  const rules = [...pids].map((pid) => `- ${pid}: "${findingQuote(report, pid)}"`).join("\n");
  const asks = (trace?.beats ?? [])
    .map((b: any) => beatSentenceAsk(b.kind)
      ? `- ${b.id} (${b.kind}): one sentence about ${beatSentenceAsk(b.kind)}. Use only these facts: ${beatFacts(b.kind, b.refs ?? [], spoken).join("; ")}`
      : null)
    .filter(Boolean).join("\n");
  const chapters = (trace?.beats ?? []).map((b: any) => b.id).join(", ");
  return `Write walkthrough words as JSON {"glosses": {"<provision_id>": "..."}, "chapters": {"<beat_id>": "..."}, "sentences": {"<beat_id>": "..."}}.
Per provision: a gloss of what the rule asks, plain words, at most 14 words, third person present starting with a verb ("limits", "sets", "requires").
Per beat (${chapters}): a chapter title of 2-4 words.
One sentence each, at most 30 words, using only the given facts:
${asks}
Glosses: no numbers except numbers in the rule's own quote. Sentences: no numbers except numbers in the given facts or the beat's quotes, and no feature that isn't in the trace. Never write pass, fail, fits, complies, allowed or too close. Reply JSON only.

${rules}`;
}

export interface ModelWords {
  glosses: Map<string, string>;
  chapters: Map<string, string>;
  sentences: Map<string, string>;
}

export function parseWords(content: string): ModelWords {
  const out: ModelWords = { glosses: new Map(), chapters: new Map(), sentences: new Map() };
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1]! : content).trim();
  let parsed: any = null;
  try { parsed = JSON.parse(candidate); } catch {
    const a = candidate.indexOf("{"), b = candidate.lastIndexOf("}");
    if (a >= 0 && b > a) { try { parsed = JSON.parse(candidate.slice(a, b + 1)); } catch { parsed = null; } }
  }
  for (const [key, map] of [["glosses", out.glosses], ["chapters", out.chapters], ["sentences", out.sentences]] as const) {
    const obj = parsed?.[key];
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string") map.set(k, v);
    }
  }
  return out;
}

function requestWith(messages: Array<{ role: "system" | "user"; content: string }>): ModelRequest {
  return {
    phase: "execute", turn_id: makeUuid7(), turn_index: 0, messages, allowed_tools: [],
    ledger: { phase: "execute", agenda_by_stage: { gate: [], plan_constraint: [], placement_constraint: [] },
      findings: [], breaker: {}, parameter_table: {}, cell_table: {} } as unknown as ModelRequest["ledger"],
    window_turns: [], current_turn_calls: [], pending_repairs: [],
  };
}

function beatProvisions(text: string, refs: string[], spoken: SpokenData): string[] {
  const out: string[] = [];
  for (const id of ((text.match(/[A-Z]{2,}\.[A-Za-z0-9._-]+/g) ?? []).map((s) => s.replace(/\.+$/, "")))) {
    if (refs.includes(id) && !out.includes(id)) out.push(id);
  }
  for (const r of refs.filter(isProvisionId)) {
    const ref = spoken.provisions.get(r)?.ref;
    if (ref && text.includes(ref) && !out.includes(r)) out.push(r);
  }
  if (/\bhouse\b/i.test(text) && refs.includes("house") && !out.includes("house")) out.push("house");
  if (/client spot/i.test(text) && refs.includes("client_spot") && !out.includes("client_spot")) out.push("client_spot");
  return out;
}

/** One model call; every failing word falls back to code. Numbers and outcomes are all code. */
export async function writeNarration(trace: any, report: any, client: ModelClient): Promise<Narration> {
  const spoken = buildSpoken(trace, report);
  const beats: Array<{ id: string; kind: string; refs: string[] }> = trace.beats ?? [];
  const words = parseWords((await client.complete(requestWith([
    { role: "system", content: "You write walkthrough words as JSON: rule glosses, chapter titles, bridge sentences." },
    { role: "user", content: buildPrompt(trace, report, spoken) },
  ]))).content);

  const glossFor = (pid: string): { gloss: string; model: boolean } => {
    const g = words.glosses.get(pid);
    if (g !== undefined && checkGloss(g, findingQuote(report, pid)).ok) return { gloss: g, model: true };
    return { gloss: FALLBACK_GLOSS, model: false };
  };
  const chapterFor = (id: string, kind: string): { chapter: string; model: boolean } => {
    const c = words.chapters.get(id);
    if (c !== undefined && checkChapter(c).ok) return { chapter: c, model: true };
    return { chapter: fallbackChapter(kind), model: false };
  };
  const quotesFor = (refs: string[]): string[] =>
    refs.filter(isProvisionId).map((r) => findingQuote(report, r)).filter(Boolean);

  const openRefs = (report?.findings ?? []).filter((f: any) => f.outcome !== "pass").map((f: any) => f.provision_id).filter(Boolean);
  const out: NarrationBeat[] = [];
  for (const b of beats) {
    const refs = b.refs ?? [];
    const ch = b.kind === "summary" ? { chapter: "The answer", model: false } : chapterFor(b.id, b.kind);
    let text = "";
    let model = ch.model;
    if (b.kind === "constrain" || b.kind === "height") {
      const parts: string[] = [];
      for (const pid of refs.filter(isProvisionId)) {
        const g = glossFor(pid);
        model = model && g.model;
        parts.push(ruleSentence(pid, g.gloss, spoken));
      }
      text = parts.length ? parts.join(" ") : "This rule isn't measured yet.";
    } else if (b.kind === "summary") {
      text = templateSummary(openRefs.filter((r: string) => refs.includes(r)), spoken);
      model = false;
    } else {
      const s = words.sentences.get(b.id);
      if (s !== undefined && checkSentence(s, quotesFor(refs), beatFacts(b.kind, refs, spoken)).ok) text = s;
      else { text = templateLine(b.kind, refs, spoken); model = false; }
    }
    out.push({ id: b.id, chapter: ch.chapter, text, numbers: textNumbers(text), provisions: beatProvisions(text, refs, spoken), source: model ? "model" : "template" });
  }
  return { beats: out };
}
