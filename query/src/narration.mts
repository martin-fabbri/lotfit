// Narration lines: the model writes one spoken line per trace beat from code-built spoken
// values, and code checks every line: each number must appear in a spoken value, limit or
// ref of that beat's refs, each provision named must be in refs, and the verdict sentence
// must match the report. A failing beat gets one retry, then a template line built in code.
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

/** Spoken wordings a beat may draw numbers from: its refs' ref, values and limits. */
export function beatSpoken(refs: string[], spoken: SpokenData): string[] {
  const out: string[] = [];
  for (const r of refs) {
    if (isProvisionId(r)) {
      const p = spoken.provisions.get(r);
      if (p) out.push(p.ref, ...p.values, ...p.limits);
    } else if (r === "house") {
      out.push("the house", ...spoken.lot);
    } else if (r === "client_spot") {
      out.push("the client spot", ...spoken.spot);
    }
  }
  return out;
}

export interface BeatCheck {
  ok: boolean;
  reasons: string[];
  numbers: string[];
  provisions: string[];
}

/** Check one line against its refs' spoken wordings, plus the verdict sentence for summary. */
export function checkBeat(text: string, refs: string[], kind: string, spoken: SpokenData): BeatCheck {
  const reasons: string[] = [];
  const allowed = new Set<string>();
  for (const s of beatSpoken(refs, spoken)) for (const m of textNumbers(s)) allowed.add(m);
  const numbers = textNumbers(text);
  for (const raw of numbers) {
    if (!allowed.has(raw.replace(/,/g, ""))) reasons.push(`number ${raw} is not in a spoken value, limit or ref of this beat's refs`);
  }
  const provisions: string[] = [];
  for (const id of ((text.match(/[A-Z]{2,}\.[A-Za-z0-9._-]+/g) ?? []).map((s) => s.replace(/\.+$/, "")))) {
    if (!refs.includes(id)) reasons.push(`provision ${id} is not in this beat's refs`);
    else provisions.push(id);
  }
  for (const r of refs.filter(isProvisionId)) {
    const ref = spoken.provisions.get(r)?.ref;
    if (ref && text.includes(ref) && !provisions.includes(r)) provisions.push(r);
  }
  if (/\bhouse\b/i.test(text) && refs.includes("house") && !provisions.includes("house")) provisions.push("house");
  if (/client spot/i.test(text) && refs.includes("client_spot") && !provisions.includes("client_spot")) provisions.push("client_spot");
  if (kind === "summary") {
    const t = ` ${text.toLowerCase()} `;
    const v = spoken.verdict;
    const need =
      v === "FITS" ? /\bfits\b/.test(t) && !/does\s+not\s+fit|doesn'?t\s+fit/.test(t) :
      v === "NEEDS_CHECK" ? /needs?\s+a\s+check/.test(t) :
      v === "DOESNT_FIT" ? /does\s+not\s+fit|doesn'?t\s+fit/.test(t) :
      v === "NO_LEGS" ? /no\s+spot\s+found/.test(t) : true;
    if (!need) reasons.push(`verdict sentence does not match ${v}`);
  }
  return { ok: reasons.length === 0, reasons, numbers, provisions };
}

const RESULT_WORDS: Record<string, string> = {
  pass: "passes", fail: "fails",
  too_close_to_call: "is too close to call with the scan, so it gets taped",
  unknown: "isn't measured yet",
};

const bareNum = (s: string): string => s.replace(/\s+(square feet|feet|inches|percent|degrees)$/, "");

/** Template line built in code from the spoken data. Follows the same rules as a model line. */
export function templateLine(beat: { id: string; kind: string; refs: string[] }, spoken: SpokenData): { chapter: string; text: string } {
  if (beat.kind === "establish") {
    return { chapter: "The lot",
      text: spoken.lot.length === 2
        ? `The lot measures ${spoken.lot[0]} by ${spoken.lot[1]}, with the ${spoken.houseId} on it.`
        : "The lot is on screen, with the house on it." };
  }
  if (beat.kind === "place") {
    return { chapter: "The spot",
      text: spoken.spot.length === 2
        ? `The unit goes at the client spot, ${spoken.spot[0]} from the left and ${spoken.spot[1]} back.`
        : "The unit goes at the client spot." };
  }
  if (beat.kind === "summary") {
    const v = spoken.verdict;
    const sentence =
      v === "FITS" ? "It fits." : v === "NEEDS_CHECK" ? "It needs a check." : v === "DOESNT_FIT" ? "It does not fit." :
      v === "NO_LEGS" ? "No spot found." : v === "FITS_IF" ? "It fits, if the conditions hold." :
      v === "BLOCKED_BY_GATE" ? "It is not allowed here." : "It is not measured yet.";
    return { chapter: "The answer", text: sentence };
  }
  if (beat.kind === "envelope") {
    if (spoken.verdict === "NO_LEGS") {
      return { chapter: "The space", text: "No space is left to build in inside the setbacks." };
    }
    const setback = beat.refs.map((r) => spoken.provisions.get(r)).find((p) => p && /setback/i.test(p.ref) && p.limits.length);
    const any = beat.refs.map((r) => spoken.provisions.get(r)).find((p) => p && p.limits.length);
    const limit = setback?.limits[0] ?? any?.limits[0];
    return { chapter: "The space",
      text: limit ? `Inside setbacks of ${limit}, space is left to build in.` : "Space is left to build in inside the setbacks." };
  }
  const sentences: string[] = [];
  for (const pid of beat.refs.filter(isProvisionId)) {
    const p = spoken.provisions.get(pid);
    if (!p) continue;
    const result = RESULT_WORDS[p.outcome ?? ""] ?? "isn't measured yet";
    const v = p.values[0], l = p.limits[0];
    if (v !== undefined && l !== undefined) sentences.push(`${p.ref} (${bareNum(v)} vs ${l}) ${result}.`);
    else if (v !== undefined) sentences.push(`${p.ref} (${v}) ${result}.`);
    else sentences.push(`${p.ref} ${result}.`);
  }
  if (!sentences.length) sentences.push("This rule isn't measured yet.");
  return { chapter: "The rules", text: sentences.join(" ") };
}

function findingQuote(report: any, pid: string): string {
  const f = (report?.findings ?? []).find((x: any) => x.provision_id === pid);
  return (f?.citations ?? [])[0]?.quote ?? "";
}

function buildPrompt(trace: any, report: any, spoken: SpokenData): string {
  const beats = (trace.beats ?? []).map((b: any) => {
    const refs = (b.refs ?? []).map((r: string) => {
      const p = spoken.provisions.get(r);
      if (p) return `  - ${r}: "${p.ref}"${p.values.map((v) => `; measures ${v}`).join("")}${p.limits.map((l) => `; limit ${l}`).join("")}. Rule in its own words: "${findingQuote(report, r)}"`;
      if (r === "house") return `  - the house on a lot measuring ${spoken.lot.join(" by ")}`;
      if (r === "client_spot") return `  - the client spot at ${spoken.spot.join(", ")}`;
      return `  - ${r}`;
    }).join("\n");
    return `Beat ${b.id} (${b.kind}):\n${refs}`;
  }).join("\n");
  return `Write one spoken walkthrough line per beat as JSON {"beats": [{"id", "chapter", "text"}]}.
Use the spoken wordings below verbatim for every number and code section; never write a number
or section any other way. Chapter: 2-4 words. Present tense, plain words for a homeowner.
Constrain and height beats: one sentence per provision, in order, at most 25 words each: what
the rule asks (from its quote), what was measured, the result ("passes", "fails",
"is too close to call with the scan, so it gets taped", "isn't measured yet"). Never write
"pass" as a bare word after a number. Envelope: one sentence about the space left to build
in, no rule list. Summary: the verdict and what remains open, at most 35 words. Reply JSON only.

${beats}
Verdict: ${report?.verdict}`;
}

/** Summary template needs the open findings; the verdict sentence alone is the checkable core. */
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

function parseBeats(content: string): Map<string, { chapter: string; text: string }> {
  const out = new Map();
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1]! : content).trim();
  let parsed: any = null;
  try { parsed = JSON.parse(candidate); } catch {
    const a = candidate.indexOf("{"), b = candidate.lastIndexOf("}");
    if (a >= 0 && b > a) { try { parsed = JSON.parse(candidate.slice(a, b + 1)); } catch { parsed = null; } }
  }
  for (const b of parsed?.beats ?? []) {
    if (b && typeof b.id === "string" && typeof b.text === "string") {
      out.set(b.id, { chapter: typeof b.chapter === "string" ? b.chapter : "", text: b.text });
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

export async function writeNarration(trace: any, report: any, client: ModelClient): Promise<Narration> {
  const spoken = buildSpoken(trace, report);
  const beats: Array<{ id: string; kind: string; refs: string[] }> = trace.beats ?? [];

  const accept = new Map<string, NarrationBeat>();
  const failed: Array<{ id: string; reasons: string[] }> = [];
  const first = parseBeats((await client.complete(requestWith([
    { role: "system", content: "You write spoken walkthrough lines as JSON, using the given spoken wordings verbatim." },
    { role: "user", content: buildPrompt(trace, report, spoken) },
  ]))).content);
  for (const b of beats) {
    const line = first.get(b.id);
    if (!line) { failed.push({ id: b.id, reasons: ["missing line"] }); continue; }
    const chk = checkBeat(line.text, b.refs ?? [], b.kind, spoken);
    if (chk.ok) accept.set(b.id, { id: b.id, chapter: line.chapter, text: line.text, numbers: chk.numbers, provisions: chk.provisions, source: "model" });
    else failed.push({ id: b.id, reasons: chk.reasons });
  }

  if (failed.length) {
    const notes = failed.map((f) => `- ${f.id}: ${f.reasons.join("; ")}`).join("\n");
    const second = parseBeats((await client.complete(requestWith([
      { role: "system", content: "You write spoken walkthrough lines as JSON, using the given spoken wordings verbatim." },
      { role: "user", content: `${buildPrompt(trace, report, spoken)}\n\nThese lines failed the check, rewrite only them:\n${notes}` },
    ]))).content);
    const still: Array<{ id: string; reasons: string[] }> = [];
    for (const f of failed) {
      const b = beats.find((x) => x.id === f.id)!;
      const line = second.get(f.id);
      const chk = line ? checkBeat(line.text, b.refs ?? [], b.kind, spoken) : null;
      if (line && chk!.ok) {
        accept.set(b.id, { id: b.id, chapter: line.chapter, text: line.text, numbers: chk!.numbers, provisions: chk!.provisions, source: "model" });
      } else still.push(f);
    }
    failed.length = 0;
    failed.push(...still);
  }

  const openRefs = (report?.findings ?? []).filter((f: any) => f.outcome !== "pass").map((f: any) => f.provision_id).filter(Boolean);
  const out: NarrationBeat[] = [];
  for (const b of beats) {
    const a = accept.get(b.id);
    if (a) { out.push(a); continue; }
    const tpl = b.kind === "summary"
      ? { chapter: "The answer", text: templateSummary(openRefs.filter((r: string) => (b.refs ?? []).includes(r)), spoken) }
      : templateLine({ id: b.id, kind: b.kind, refs: b.refs ?? [] }, spoken);
    const chk = checkBeat(tpl.text, b.refs ?? [], b.kind, spoken);
    out.push({ id: b.id, chapter: tpl.chapter, text: tpl.text, numbers: chk.numbers, provisions: chk.provisions, source: "template" });
  }
  return { beats: out };
}
