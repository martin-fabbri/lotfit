// Narration lines: the model writes one spoken line per trace beat; code checks every number,
// provision and the verdict sentence against the trace and report. A failing beat gets one retry,
// then a template line built in code. Pure except the model calls.
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

const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmt2 = (n: number): string => String(round2(n));
const isProvisionId = (s: string): boolean => /^[A-Z]{2,}\./.test(s);
const numericSegments = (pid: string): string[] => pid.split(".").slice(1).filter((s) => /^\d+$/.test(s));

function collectNumbers(node: unknown, into: Set<number>): void {
  if (typeof node === "number" && isFinite(node)) { into.add(round2(node)); return; }
  if (Array.isArray(node)) { for (const v of node) collectNumbers(v, into); return; }
  if (node && typeof node === "object") { for (const v of Object.values(node)) collectNumbers(v, into); }
}

/** Section numbers a beat may speak: individual segments and dotted prefixes of its ref provisions. */
export function sectionNumbers(refs: string[]): Set<string> {
  const out = new Set<string>();
  for (const r of refs.filter(isProvisionId)) {
    const segs = numericSegments(r);
    for (const s of segs) out.add(s);
    for (let i = 2; i <= segs.length; i++) out.add(segs.slice(0, i).join("."));
  }
  return out;
}

const textNumbers = (text: string): string[] => text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
const literalIds = (text: string): string[] =>
  (text.match(/[A-Z]{2,}\.[A-Za-z0-9._-]+/g) ?? []).map((s) => s.replace(/\.+$/, ""));

function spokenMatches(code: string | undefined, section: string | undefined, refs: string[]): string[] {
  const codeParts = code ? code.split(".").filter((p) => /^\d+$/.test(p)) : [];
  return refs.filter(isProvisionId).filter((r) => {
    const segs = numericSegments(r);
    if (section && !segs.includes(section)) return false;
    let at = 0;
    for (const p of codeParts) { const i = segs.indexOf(p, at); if (i < 0) return false; at = i + 1; }
    return codeParts.length > 0 || !!section;
  });
}

export interface BeatCheck {
  ok: boolean;
  reasons: string[];
  numbers: string[];
  provisions: string[];
}

/** Check one line: numbers, provisions, and (summary) the verdict sentence. */
export function checkBeat(
  text: string, refs: string[], kind: string, numberPool: Set<number>, sections: Set<string>, verdict: string,
): BeatCheck {
  const reasons: string[] = [];
  const numbers = textNumbers(text);
  for (const raw of numbers) {
    const bare = raw.replace(/,/g, "");
    if (sections.has(bare)) continue;
    if (numberPool.has(round2(Number(bare)))) continue;
    reasons.push(`number ${raw} is not in the trace or report`);
  }
  const provisions: string[] = [];
  for (const id of literalIds(text)) {
    if (!refs.includes(id)) reasons.push(`provision ${id} is not in this beat's refs`);
    else provisions.push(id);
  }
  const spoken = new Set<string>();
  for (const m of text.matchAll(/code\s+([\d.]+)(?:,?\s*section\s+(\d+))?/gi)) {
    const hit = spokenMatches(m[1], m[2], refs);
    if (!hit.length) reasons.push(`spoken ref code ${m[1]}${m[2] ? `, section ${m[2]}` : ""} matches no ref provision`);
    else for (const h of hit) if (!spoken.has(h)) { spoken.add(h); provisions.push(h); }
  }
  const codeSpans: Array<[number, number]> = [...text.matchAll(/code\s+[\d.]+(?:,?\s*section\s+\d+)?/gi)]
    .map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const m of text.matchAll(/section\s+(\d+)/gi)) {
    if (codeSpans.some(([a, b]) => (m.index ?? 0) >= a && (m.index ?? 0) < b)) continue;
    const hit = spokenMatches(undefined, m[1], refs);
    if (!hit.length) reasons.push(`spoken section ${m[1]} matches no ref provision`);
    else for (const h of hit) if (!spoken.has(h)) { spoken.add(h); provisions.push(h); }
  }
  if (kind === "summary") {
    const t = ` ${text.toLowerCase()} `;
    const need =
      verdict === "FITS" ? /\bfits\b/.test(t) && !/does\s+not\s+fit|doesn'?t\s+fit/.test(t) :
      verdict === "NEEDS_CHECK" ? /needs?\s+a\s+check/.test(t) :
      verdict === "DOESNT_FIT" ? /does\s+not\s+fit|doesn'?t\s+fit/.test(t) :
      verdict === "NO_LEGS" ? /no\s+spot\s+found/.test(t) : true;
    if (!need) reasons.push(`verdict sentence does not match ${verdict}`);
  }
  return { ok: reasons.length === 0, reasons, numbers, provisions };
}

const JURISDICTION: Record<string, string> = { EUG: "Eugene", PDX: "Portland", OR: "Oregon", ORS: "Oregon", GRE: "Gresham" };

function spoken(pid: string): string {
  const place = JURISDICTION[pid.split(".")[0]!] ?? "The code";
  const segs = numericSegments(pid);
  if (segs.length >= 3) return `${place} code ${segs[0]}.${segs[1]}, section ${segs[2]}`;
  if (segs.length === 2) return `${place} code ${segs[0]}.${segs[1]}`;
  if (segs.length === 1) return `${place} code ${segs[0]}`;
  return place;
}

const OUTCOME_WORDS: Record<string, string> = {
  pass: "passes", fail: "fails", too_close_to_call: "is too close to call", unknown: "is not measured yet",
};

export interface TemplateData {
  lotW: number; lotD: number; houseId: string;
  constraints: Map<string, { value: number | null; limit: number | null; unit: string | null; outcome: string | null }>;
  spot: { x: number; y: number } | null;
  verdict: string;
}

export function templateData(trace: any, report: any): TemplateData {
  const lot: number[][] = trace?.site?.lot ?? [];
  const xs = lot.map((p) => p[0] ?? 0), ys = lot.map((p) => p[1] ?? 0);
  const constraints = new Map();
  for (const c of trace?.constraints ?? []) {
    constraints.set(c.provision_id, { value: c.value ?? null, limit: c.limit?.value ?? c.limit ?? null,
      unit: c.unit ?? c.limit?.unit ?? null, outcome: c.outcome ?? null });
  }
  const opt = (trace?.options ?? [])[0];
  return {
    lotW: xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
    lotD: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
    houseId: (trace?.site?.existing ?? [])[0]?.id ?? "house",
    constraints, verdict: report?.verdict ?? "",
    spot: opt?.placement ? { x: opt.placement.x, y: opt.placement.y } : null,
  };
}

/** Template line built in code from the same data the model sees. Always checkable. */
export function templateLine(beat: { id: string; kind: string; refs: string[] }, data: TemplateData): { chapter: string; text: string } {
  if (beat.kind === "establish") {
    return { chapter: "The lot", text: `The lot measures ${fmt2(data.lotW)} by ${fmt2(data.lotD)} feet, with the ${data.houseId} on it.` };
  }
  if (beat.kind === "place") {
    return { chapter: "The spot",
      text: data.spot ? `The unit goes at the client spot, ${fmt2(data.spot.x)} feet from the left and ${fmt2(data.spot.y)} feet back.`
        : "The unit goes at the client spot." };
  }
  if (beat.kind === "summary") {
    const v = data.verdict;
    const text =
      v === "FITS" ? "It fits." : v === "NEEDS_CHECK" ? "It needs a check." : v === "DOESNT_FIT" ? "It does not fit." :
      v === "NO_LEGS" ? "No spot found." : v === "FITS_IF" ? "It fits, if the conditions hold." :
      v === "BLOCKED_BY_GATE" ? "It is not allowed here." : "It is not measured yet.";
    return { chapter: "The answer", text };
  }
  const pid = beat.refs.find(isProvisionId);
  if (!pid) return { chapter: "A rule", text: "This rule is not measured yet." };
  const c = data.constraints.get(pid);
  const words = OUTCOME_WORDS[c?.outcome ?? ""] ?? "is not measured yet";
  const chapter = `Rule ${pid.split(".").slice(1, 3).join(".")}`;
  const u = !c?.unit || c.unit === "count" ? "" : ` ${c.unit}`;
  if (typeof c?.value === "number" && typeof c?.limit === "number" && c.outcome !== "unknown") {
    return { chapter, text: `${spoken(pid)}: the measured ${fmt2(c.value)}${u} against a limit of ${fmt2(c.limit)}${u} ${words}.` };
  }
  if (typeof c?.value === "number" && c.outcome !== "unknown") {
    return { chapter, text: `${spoken(pid)}: the measured ${fmt2(c.value)}${u} ${words}.` };
  }
  return { chapter, text: `${spoken(pid)} ${words}.` };
}

function findingLines(report: any): string {
  return (report?.findings ?? []).map((f: any) => {
    const m = (f.measures ?? [])[0] ?? {};
    return `- ${f.provision_id} (${f.outcome}): value ${m.value ?? "?"} ${m.unit ?? ""}, limit ${m.limit?.value ?? "?"} ${m.limit?.unit ?? ""}, margin ${m.margin ?? "?"}. Quote: "${(f.citations ?? [])[0]?.quote ?? ""}"`;
  }).join("\n");
}

function buildPrompt(trace: any, report: any): string {
  const beats = (trace.beats ?? []).map((b: any) => `- ${b.id} (${b.kind}): refs ${JSON.stringify(b.refs ?? [])}`).join("\n");
  return `Write one spoken line per beat of this walkthrough, as JSON {"beats": [{"id", "chapter", "text"}]}.
Chapter: 2-4 words. Text: one or two plain sentences for a homeowner, present tense, no jargon, at most 40 words.
establish: the lot and the house. Constraint beats: each rule — what it requires, the measured value, pass or fail,
saying the code section as "Eugene code 9.2751, section 17". place: where the unit goes. summary: the verdict in one sentence.
Use only numbers from the data below. Reply with JSON only.

Beats:
${beats}
Verdict: ${report?.verdict}
Findings:
${findingLines(report)}`;
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
  const pool = new Set<number>();
  collectNumbers(trace, pool);
  collectNumbers(report, pool);
  const data = templateData(trace, report);
  const beats: Array<{ id: string; kind: string; refs: string[] }> = trace.beats ?? [];

  const accept = new Map<string, NarrationBeat>();
  const failed: Array<{ id: string; reasons: string[] }> = [];
  const first = parseBeats((await client.complete(requestWith([
    { role: "system", content: "You write spoken walkthrough lines as JSON." },
    { role: "user", content: buildPrompt(trace, report) },
  ]))).content);
  for (const b of beats) {
    const line = first.get(b.id);
    if (!line) { failed.push({ id: b.id, reasons: ["missing line"] }); continue; }
    const refs = (b.refs ?? []).filter(isProvisionId);
    const chk = checkBeat(line.text, refs, b.kind, pool, sectionNumbers(refs), report?.verdict ?? "");
    if (chk.ok) accept.set(b.id, { id: b.id, chapter: line.chapter, text: line.text, numbers: chk.numbers, provisions: chk.provisions, source: "model" });
    else failed.push({ id: b.id, reasons: chk.reasons });
  }

  if (failed.length) {
    const notes = failed.map((f) => `- ${f.id}: ${f.reasons.join("; ")}`).join("\n");
    const second = parseBeats((await client.complete(requestWith([
      { role: "system", content: "You write spoken walkthrough lines as JSON." },
      { role: "user", content: `${buildPrompt(trace, report)}\n\nThese lines failed the check, rewrite only them:\n${notes}` },
    ]))).content);
    const still: Array<{ id: string; reasons: string[] }> = [];
    for (const f of failed) {
      const b = beats.find((x) => x.id === f.id)!;
      const line = second.get(f.id);
      const refs = (b.refs ?? []).filter(isProvisionId);
      const chk = line ? checkBeat(line.text, refs, b.kind, pool, sectionNumbers(refs), report?.verdict ?? "") : null;
      if (line && chk!.ok) {
        accept.set(b.id, { id: b.id, chapter: line.chapter, text: line.text, numbers: chk!.numbers, provisions: chk!.provisions, source: "model" });
      } else still.push(f);
    }
    failed.length = 0;
    failed.push(...still);
  }

  const out: NarrationBeat[] = [];
  for (const b of beats) {
    const a = accept.get(b.id);
    if (a) { out.push(a); continue; }
    const refs = (b.refs ?? []).filter(isProvisionId);
    const tpl = templateLine({ id: b.id, kind: b.kind, refs: b.refs ?? [] }, data);
    const chk = checkBeat(tpl.text, refs, b.kind, pool, sectionNumbers(refs), report?.verdict ?? "");
    out.push({ id: b.id, chapter: tpl.chapter, text: tpl.text, numbers: chk.numbers, provisions: chk.provisions, source: "template" });
  }
  return { beats: out };
}
