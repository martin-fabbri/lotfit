// Narration lines and timing (no network): scripted model answers checked, retried, templated;
// spoken values built in code; timeline.mjs estimates; voice.mjs refuses without a key.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedModelClient } from "./model-client.mts";
import { writeNarration, templateLine, templateSummary, checkBeat, buildSpoken, spokenRef, speakMeasure } from "./narration.mts";

let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };

const here = path.dirname(fileURLToPath(import.meta.url));
const trace = JSON.parse(readFileSync(path.join(here, "..", "player", "demo", "eug-demo-24x24.trace.json"), "utf8"));
const report = {
  verdict: "NEEDS_CHECK",
  findings: [
    { provision_id: "EUG.9.2751.17.b.4.a.setback", outcome: "too_close_to_call",
      measures: [{ value: 6.36, unit: "ft", limit: { value: 5, unit: "ft" }, margin: 1.36, tolerance: 3 }],
      citations: [{ quote: "The unit must sit at least 5 feet from the side and rear lines." }] },
    { provision_id: "EUG.9.2751.17.b.4.a.slope", outcome: "unknown", measures: [],
      citations: [{ quote: "Height follows the slope rule." }] },
    { provision_id: "EUG.9.2751.17.a.1", outcome: "pass",
      measures: [{ value: 576, unit: "sqft", limit: { value: 800, unit: "sqft" }, margin: 224 }],
      citations: [{ quote: "The unit may be at most 800 square feet." }] },
  ],
};
const spoken = buildSpoken(trace, report);
const refsOf = (id: string): string[] => trace.beats.find((b: any) => b.id === id).refs ?? [];
const kindOf = (id: string): string => trace.beats.find((b: any) => b.id === id).kind;
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

ok("spoken_ref for EUG, PDX, ORS and table ids",
  spokenRef("EUG.9.2751.17.a.1") === "Eugene code 9.2751, 17 a 1" &&
  spokenRef("EUG.T9.2750") === "Eugene table 9.2750" &&
  spokenRef("PDX.33.110.220.a") === "Portland code 33.110, 220 a" &&
  spokenRef("ORS.197.312.5") === "Oregon code 197.312, 5",
  [spokenRef("EUG.9.2751.17.a.1"), spokenRef("EUG.T9.2750"), spokenRef("PDX.33.110.220.a"), spokenRef("ORS.197.312.5")].join(" | "));
ok("rounded measures say about, exact ones do not",
  speakMeasure(682.72484, "sqft") === "about 683 square feet" &&
  speakMeasure(6.36, "ft") === "about 6.4 feet" &&
  speakMeasure(576, "sqft") === "576 square feet" &&
  speakMeasure(1, "count") === "1 unit",
  [speakMeasure(682.72484, "sqft"), speakMeasure(6.36, "ft")].join(" | "));
ok("a line with 682.72484 is refused",
  !checkBeat("Eugene code 9.2751, 17 a 1 measures 682.72484 square feet and passes.", refsOf("b2"), kindOf("b2"), spoken).ok);

const J = (beats: Array<{ id: string; chapter: string; text: string }>) => JSON.stringify({ beats });
const clean: Array<{ id: string; chapter: string; text: string }> = [
  { id: "b1", chapter: "The lot", text: "The lot measures about 64.2 feet by about 106.4 feet, with the house on it." },
  { id: "b2", chapter: "The rules", text: [
    "Eugene table 9.2740 isn't measured yet.",
    "Eugene code 9.2741, 3 (1 unit) passes.",
    "Eugene code 9.2751, 17 a 1 (576 square feet vs 800 square feet) passes.",
    "Eugene code 9.2751, 17 b 4 a setback (6.4 feet vs 5 feet) is too close to call with the scan, so it gets taped.",
    "Eugene table 9.2750 (76 feet) passes.",
  ].join(" ") },
  { id: "b3", chapter: "Height cap", text: "Eugene code 9.2751, 17 b 4 a slope (15 feet) isn't measured yet." },
  { id: "b4", chapter: "The space", text: "Inside setbacks of 5 feet, space is left to build in." },
  { id: "b5", chapter: "The spot", text: "The unit goes at the client spot, 20 feet from the left and 76 feet back." },
  { id: "b6", chapter: "The answer", text: "It needs a check. Still open: Eugene code 9.2751, 17 b 4 a setback." },
];
const scripted = (answers: string[]) => createScriptedModelClient((_req, i) => ({ content: answers[Math.min(i, answers.length - 1)]! }));

const c0 = scripted([J(clean)]);
const r0 = await writeNarration(trace, report, c0);
ok("clean answer passes, one entry per beat, same ids and order",
  r0.beats.length === trace.beats.length &&
  r0.beats.every((b, i) => b.id === trace.beats[i].id && b.source === "model"),
  r0.beats.map((b) => `${b.id}:${b.source}`).join(","));

const badNum = clean.map((b) => (b.id === "b2" ? { ...b, text: b.text.replace("6.4 feet", "7.5 feet") } : b));
const c1 = scripted([J(badNum), J(badNum)]);
const r1 = await writeNarration(trace, report, c1);
const t1 = r1.beats.find((b) => b.id === "b2")!;
ok("invented number is retried, then templated",
  c1.recordedRequests.length === 2 && t1.source === "template" && !t1.text.includes("7.5"),
  `${t1.source}: ${t1.text}`);
ok("passing beats keep the model line", r1.beats.find((b) => b.id === "b1")!.source === "model");

const badProv = clean.map((b) => (b.id === "b3" ? { ...b, text: "EUG.33.110.220 fails the height check." } : b));
const c2 = scripted([J(badProv), J(badProv)]);
const r2 = await writeNarration(trace, report, c2);
const t2 = r2.beats.find((b) => b.id === "b3")!;
ok("unknown provision is refused the same way",
  t2.source === "template" && !t2.text.includes("33.110"), `${t2.source}: ${t2.text}`);

const badSum = clean.map((b) => (b.id === "b6" ? { ...b, text: "It fits." } : b));
const c3 = scripted([J(badSum), J(clean)]);
const r3 = await writeNarration(trace, report, c3);
const t3 = r3.beats.find((b) => b.id === "b6")!;
ok("fits for NEEDS_CHECK is refused, retry accepted",
  c3.recordedRequests.length === 2 && t3.source === "model" && t3.text.startsWith("It needs a check."), `${t3.source}: ${t3.text}`);

const b2 = trace.beats.find((b: any) => b.id === "b2");
const b2tpl = templateLine({ id: "b2", kind: b2.kind, refs: b2.refs ?? [] }, spoken);
const b2sent = sentences(b2tpl.text);
ok("constrain beat with 5 refs gives 5 sentences in order, each under 25 words",
  b2sent.length === 5 &&
  b2sent.every((s, i) => s.includes(spoken.provisions.get(b2.refs[i])!.ref)) &&
  b2sent.every((s) => s.split(/\s+/).length <= 25),
  b2tpl.text);
ok("template has no bare pass after a number",
  ![...trace.beats.map((b: any) => templateLine({ id: b.id, kind: b.kind, refs: b.refs ?? [] }, spoken).text)]
    .some((text) => /[\d)]\s+pass\b/i.test(text)));

const tplFails: string[] = [];
for (const b of trace.beats) {
  const tpl = b.kind === "summary"
    ? { chapter: "The answer", text: templateSummary(["EUG.9.2751.17.b.4.a.setback", "EUG.9.2751.17.b.4.a.slope"], spoken) }
    : templateLine({ id: b.id, kind: b.kind, refs: b.refs ?? [] }, spoken);
  const chk = checkBeat(tpl.text, b.refs ?? [], b.kind, spoken);
  if (!chk.ok) tplFails.push(`${b.id}: ${chk.reasons.join("; ")}`);
}
ok("template lines alone pass the number check for every beat", tplFails.length === 0, tplFails.join(" | "));

const allSent: Array<{ beat: string; s: string }> = [];
for (const b of trace.beats) {
  const tpl = b.kind === "summary"
    ? templateSummary(["EUG.9.2751.17.b.4.a.setback", "EUG.9.2751.17.b.4.a.slope"], spoken)
    : templateLine({ id: b.id, kind: b.kind, refs: b.refs ?? [] }, spoken).text;
  for (const s of sentences(tpl)) allSent.push({ beat: b.id, s: s.toLowerCase() });
}
const dup = allSent.find((a, i) => allSent.findIndex((b) => b.s === a.s) !== i && allSent.find((b) => b.s === a.s)!.beat !== a.beat);
ok("no beat repeats another beat's sentence", dup === undefined, dup ? `${dup.beat}: ${dup.s}` : "");

const env = templateLine({ id: "b4", kind: "envelope", refs: refsOf("b4") }, spoken);
ok("envelope is one sentence with no rule list",
  sentences(env.text).length === 1 && !/Eugene|Portland|Oregon|code|table/i.test(env.text), env.text);
const sum = templateSummary(["EUG.9.2751.17.b.4.a.setback", "EUG.9.2751.17.b.4.a.slope"], spoken);
ok("summary matches the verdict in at most 35 words",
  /^It needs a check\./.test(sum) && sum.split(/\s+/).length <= 35, sum);

const tmp = mkdtempSync(path.join(tmpdir(), "lotfit-narration-"));
writeFileSync(path.join(tmp, "trace.json"), JSON.stringify(trace));
writeFileSync(path.join(tmp, "narration.json"), JSON.stringify({ beats: clean.map((b) => ({ ...b, numbers: [], provisions: [], source: "model" })) }));
execFileSync(process.execPath, [path.join(here, "..", "player", "narrate", "timeline.mjs"), tmp], { stdio: "pipe" });
const tl = JSON.parse(readFileSync(path.join(tmp, "timeline.json"), "utf8"));
const starts = tl.beats.map((b: any) => b.start);
ok("timeline estimates monotonic starts with words per beat",
  starts.every((s: number, i: number) => i === 0 || s > starts[i - 1]!) && tl.beats.every((b: any) => b.words.length > 0),
  starts.join(","));
ok("timeline has the player shape",
  tl.beats.every((b: any) => ["start", "end", "speaker", "chapter", "text", "words"].every((k) => k in b)));

const scrubbed = { ...process.env } as Record<string, string | undefined>;
delete scrubbed.ELEVENLABS_API_KEY;
delete scrubbed.LOTFIT_VOICE_ID;
let vOut = "", vStatus: number | null = null;
try {
  execFileSync(process.execPath, [path.join(here, "..", "player", "narrate", "voice.mjs"), tmp],
    { env: scrubbed as Record<string, string>, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e: any) {
  vStatus = e.status ?? 1;
  vOut = String(e.stderr ?? "") + String(e.stdout ?? "");
}
ok("voice.mjs with no key exits clearly and never prints a key",
  vStatus !== 0 && /ELEVENLABS_API_KEY/.test(vOut) && !/[A-Za-z0-9_-]{32,}/.test(vOut.replace(/ELEVENLABS_API_KEY/g, "")),
  `status=${vStatus} ${vOut.slice(0, 140)}`);

console.log(`${n}/${t} narration checks passed`);
process.exit(n === t ? 0 : 1);
