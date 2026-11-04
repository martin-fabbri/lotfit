// Narration lines and timing (no network): code assembles every number and outcome; the
// scripted model supplies only glosses, chapters and bridge sentences, checked and fallen back.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedModelClient } from "./model-client.mts";
import { writeNarration, templateSummary, ruleSentence, buildSpoken, buildPrompt, beatFacts, spokenRef, speakMeasure,
  checkGloss, checkSentence, checkChapter, FALLBACK_GLOSS } from "./narration.mts";

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

const SETBACK = "EUG.9.2751.17.b.4.a.setback";
const SLOPE = "EUG.9.2751.17.b.4.a.slope";
const setb = ruleSentence(SETBACK, "keeps the unit back from the lot lines", spoken);
const slope = ruleSentence(SLOPE, "caps height on sloped lots", spoken);
ok("too_close_to_call and unknown get their code phrases",
  setb.endsWith("so it gets taped.") && setb.includes("We measured about 6.4 feet against 5 feet") &&
  slope.endsWith("which isn't measured yet.") && !slope.includes("We measured"), `${setb} | ${slope}`);

const two = buildSpoken({ constraints: [], beats: [], site: {}, options: [] }, { verdict: "", findings: [
  { provision_id: "EUG.9.9999.1", outcome: "pass",
    measures: [{ value: 10, unit: "ft" }, { value: 12, unit: "ft", limit: { value: 15, unit: "ft" } }], citations: [] },
]});
ok("two measures join with and",
  ruleSentence("EUG.9.9999.1", "sets a limit", two).includes("We measured 10 feet and 12 feet against 15 feet"),
  ruleSentence("EUG.9.9999.1", "sets a limit", two));

const Q800 = "The unit may be at most 800 square feet.";
ok("gloss checks: quoted number passes, the rest is refused",
  checkGloss("limits the unit to 800 square feet", Q800).ok &&
  !checkGloss("limits the unit to 900 square feet", Q800).ok &&
  !checkGloss("passes the size check", Q800).ok &&
  !checkGloss("this gloss runs far past the allowed fourteen word cap for a single rule gloss here", "").ok);
ok("sentence and chapter checks",
  checkSentence("Space is left to build in inside the setbacks.", []).ok &&
  !checkSentence("Space of 12 feet is left to build in.", []).ok &&
  !checkSentence("It fits the envelope.", []).ok &&
  checkChapter("The lot").ok && !checkChapter("Lot").ok);

const prompt = buildPrompt(trace, report, spoken);
ok("gloss joins the ref mid-sentence, lowercased",
  ruleSentence("EUG.T9.2740", "Identifies the zone's permitted uses", spoken)
    .startsWith("Eugene table 9.2740 identifies the zone's permitted uses,"));
ok("prompt asks third-person glosses and gives each sentence beat its facts",
  prompt.includes("third person present") &&
  prompt.includes("the lot measures about 64.2 feet by about 106.4 feet; the house") &&
  prompt.includes("setbacks of 5 feet") &&
  prompt.includes("20 feet from the left; 76 feet from the front"));
ok("prompt carries no outcomes",
  prompt.includes("EUG.9.2751.17.a.1") && prompt.includes(Q800) &&
  !prompt.includes("6.36") && !prompt.includes("576 square feet") &&
  !prompt.includes("too_close_to_call") && !prompt.includes("NEEDS_CHECK"));
const estFacts = beatFacts("establish", ["house"], spoken);
ok("a sentence may use its beat's facts, nothing else",
  checkSentence("The lot measures about 64.2 feet by about 106.4 feet.", [], estFacts).ok &&
  !checkSentence("The lot measures about 64.2 feet by about 106.4 feet.", [], []).ok &&
  !checkSentence("The lot measures 20 feet by 76 feet.", [], estFacts).ok);
ok("a sentence naming a feature outside the trace is refused",
  !checkSentence("The unit sits beside the existing landscaping.", [], beatFacts("place", ["client_spot"], spoken)).ok &&
  !checkSentence("The fence marks the rear line.", [], beatFacts("envelope", [], spoken)).ok &&
  checkSentence("The unit goes at the client spot.", [], beatFacts("place", ["client_spot"], spoken)).ok);

const W = (w: { glosses?: Record<string, string>; chapters?: Record<string, string>; sentences?: Record<string, string> }) =>
  JSON.stringify({ glosses: w.glosses ?? {}, chapters: w.chapters ?? {}, sentences: w.sentences ?? {} });
const cleanW = {
  glosses: {
    "EUG.T9.2740": "covers the zone's permitted uses",
    "EUG.9.2741.3": "covers the zone's dwelling count",
    "EUG.9.2751.17.a.1": "limits the unit to 800 square feet",
    [SETBACK]: "keeps the unit 5 feet from the lot lines",
    "EUG.T9.2750": "covers the lot's dimensional standards",
    [SLOPE]: "Caps height on sloped lots",
  },
  chapters: { b1: "The lot", b2: "The rules", b3: "Height cap", b4: "The space", b5: "The spot", b6: "The answer" },
  sentences: {
    b1: "The lot is on screen with the house.",
    b4: "Space is left to build in inside the setbacks.",
    b5: "The unit goes at the client spot.",
  },
};
const scripted = (answers: string[]) => createScriptedModelClient((_req, i) => ({ content: answers[Math.min(i, answers.length - 1)]! }));

const c0 = scripted([W(cleanW)]);
const r0 = await writeNarration(trace, report, c0);
const b2 = r0.beats.find((b) => b.id === "b2")!;
const b2refs = trace.beats.find((b: any) => b.id === "b2").refs;
ok("24x24 gives 6 beats from one model call",
  r0.beats.length === 6 && c0.recordedRequests.length === 1 &&
  r0.beats.every((b, i) => b.id === trace.beats[i].id), r0.beats.map((b) => b.id).join(","));
ok("constrain beat carries one rule sentence per ref, in order",
  b2refs.every((r: string, i: number) => {
    const at = b2.text.indexOf(spoken.provisions.get(r)!.ref);
    const prev = i === 0 ? -1 : b2.text.indexOf(spoken.provisions.get(b2refs[i - 1])!.ref);
    return at > prev;
  }), b2.text);
ok("setback sentence ends so it gets taped",
  sentences(b2.text).some((s) => s.endsWith("so it gets taped.")), b2.text);
ok("capitalized gloss reads lowercase after the ref",
  r0.beats.find((b) => b.id === "b3")!.text.includes("slope caps height on sloped lots"),
  r0.beats.find((b) => b.id === "b3")!.text);
ok("clean words stay model, summary stays code",
  r0.beats.find((b) => b.id === "b1")!.source === "model" && b2.source === "model" &&
  r0.beats.find((b) => b.id === "b6")!.source === "template" &&
  r0.beats.find((b) => b.id === "b6")!.text.startsWith("It needs a check."));

const badOutcome = structuredClone(cleanW);
badOutcome.glosses[SETBACK] = "passes the setback check";
const r1 = await writeNarration(trace, report, scripted([W(badOutcome)]));
const t1 = r1.beats.find((b) => b.id === "b2")!;
ok("an outcome never comes from the model",
  t1.text.includes(FALLBACK_GLOSS) && !t1.text.includes("passes the setback") &&
  sentences(t1.text).some((s) => s.endsWith("so it gets taped.")) && t1.source === "template", t1.text);

const badNum = structuredClone(cleanW);
badNum.glosses["EUG.9.2751.17.a.1"] = "limits the unit to 900 square feet";
const r2 = await writeNarration(trace, report, scripted([W(badNum)]));
ok("a gloss with a number outside its quote is refused",
  r2.beats.find((b) => b.id === "b2")!.text.includes(`Eugene code 9.2751, 17 a 1 ${FALLBACK_GLOSS}.`));

const invented = structuredClone(cleanW);
invented.sentences.b5 = "The unit sits beside the existing landscaping.";
const rLand = await writeNarration(trace, report, scripted([W(invented)]));
const tLand = rLand.beats.find((b) => b.id === "b5")!;
ok("invented landscaping falls back to the code sentence",
  tLand.source === "template" && tLand.text === "The unit goes at the client spot, 20 feet from the left and 76 feet back.",
  `${tLand.source}: ${tLand.text}`);

const r3 = await writeNarration(trace, report, scripted(["not json at all"]));
const b2f = r3.beats.find((b) => b.id === "b2")!;
ok("garbage answer falls back to code, still 6 beats",
  r3.beats.length === 6 && r3.beats.every((b) => b.source === "template") &&
  sentences(b2f.text).some((s) => s.endsWith("so it gets taped.")));

const allSent: Array<{ beat: string; s: string }> = [];
for (const b of r0.beats) for (const s of sentences(b.text)) allSent.push({ beat: b.id, s: s.toLowerCase() });
const dup = allSent.find((a) => allSent.find((b) => b.s === a.s && b.beat !== a.beat));
ok("no beat repeats another beat's sentence", dup === undefined, dup ? `${dup.beat}: ${dup.s}` : "");

const sum = templateSummary([SETBACK, SLOPE], spoken);
ok("summary matches the verdict in at most 35 words",
  /^It needs a check\./.test(sum) && sum.split(/\s+/).length <= 35, sum);

const tmp = mkdtempSync(path.join(tmpdir(), "lotfit-narration-"));
writeFileSync(path.join(tmp, "trace.json"), JSON.stringify(trace));
writeFileSync(path.join(tmp, "narration.json"), JSON.stringify(r0));
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
