// Build timeline.json from trace.json + narration.json + per-beat alignment (words from character
// timings); without alignment files, timing is estimated from word count.
// usage: node timeline.mjs <run_dir>   -> <run_dir>/timeline.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WPS = 2.6;   // narration speed estimate (words per second)
const GAP = 0.7;   // pause between beats (s)
const INTRO = 1.0; // silent lead-in (s)
const OUTRO = 2.5; // hold on the final frame (s)

const dir = process.argv[2];
if (!dir) { console.error("usage: node timeline.mjs <run_dir>"); process.exit(1); }
const trace = JSON.parse(readFileSync(join(dir, "trace.json"), "utf8"));
const narration = JSON.parse(readFileSync(join(dir, "narration.json"), "utf8"));
const lines = new Map((narration.beats || []).map((b) => [b.id, b]));

function wordsFromAlignment(a) {
  const words = [];
  let cur = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
    if (!cur) cur = { w: "", start: a.character_start_times_seconds[i] };
    cur.w += ch;
    cur.end = a.character_end_times_seconds[i];
  });
  if (cur) words.push(cur);
  return words;
}

function estimatedWords(text) {
  const out = [];
  let t = 0;
  for (const w of String(text || "").split(/\s+/).filter(Boolean)) {
    const d = (1 / WPS) * (0.6 + 0.08 * w.length) + (/[.,:;?!]$/.test(w) ? 0.25 : 0);
    out.push({ w, start: t, end: t + d });
    t += d;
  }
  return out;
}

let t = INTRO;
const beats = trace.beats.map((b) => {
  const line = lines.get(b.id) || { chapter: b.kind, text: "" };
  const f = join(dir, "narration", `${b.id}.json`);
  let words;
  if (existsSync(f)) {
    try { words = wordsFromAlignment(JSON.parse(readFileSync(f, "utf8")).alignment); }
    catch { words = estimatedWords(line.text); }
  } else {
    words = estimatedWords(line.text);
  }
  if (!words.length) words = [{ w: "", start: 0, end: 0.5 }];
  const dur = words.at(-1).end;
  const start = t;
  t += dur + GAP;
  return { id: b.id, start: +start.toFixed(3), end: +(start + dur).toFixed(3), speaker: "LotFit",
    chapter: line.chapter, text: line.text,
    words: words.map((w) => ({ w: w.w, s: +(start + w.start).toFixed(3), e: +(start + w.end).toFixed(3) })) };
});

const timeline = { fps: 30, duration: +(t - GAP + OUTRO).toFixed(3), beats };
writeFileSync(join(dir, "timeline.json"), JSON.stringify(timeline, null, 1) + "\n");
console.log(`timeline: ${beats.length} beats, ${timeline.duration}s`);
