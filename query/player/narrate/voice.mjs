// One ElevenLabs call per narration beat, saving audio + character alignment.
// usage: node voice.mjs <run_dir>   -> <run_dir>/narration/<beatId>.mp3 + .json
// env: ELEVENLABS_API_KEY (or the repo's .env.local), LOTFIT_VOICE_ID. The key is never printed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
if (!dir) { console.error("usage: node voice.mjs <run_dir>"); process.exit(1); }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  const f = join(ROOT, ".env.local");
  const line = existsSync(f) ? readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("ELEVENLABS_API_KEY=")) : undefined;
  if (line) key = line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "").trim();
}
if (!key) { console.error("Set ELEVENLABS_API_KEY in the environment or the repo .env.local"); process.exit(1); }
const voice = process.env.LOTFIT_VOICE_ID;
if (!voice) { console.error("Set LOTFIT_VOICE_ID to the narration voice"); process.exit(1); }

const narration = JSON.parse(readFileSync(join(dir, "narration.json"), "utf8"));
mkdirSync(join(dir, "narration"), { recursive: true });
for (const b of narration.beats) {
  const hash = createHash("sha256").update(b.text, "utf8").digest("hex");
  const mp3 = join(dir, "narration", `${b.id}.mp3`);
  const meta = join(dir, "narration", `${b.id}.json`);
  if (existsSync(mp3) && existsSync(meta)) {
    try {
      if (JSON.parse(readFileSync(meta, "utf8")).textHash === hash) { console.log(`${b.id}: cached`); continue; }
    } catch { /* fall through and re-render */ }
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text: b.text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`${b.id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  writeFileSync(mp3, Buffer.from(j.audio_base64, "base64"));
  writeFileSync(meta, JSON.stringify({ textHash: hash, alignment: j.alignment }));
  console.log(`${b.id}: ${(j.alignment.character_end_times_seconds.at(-1) ?? 0).toFixed(2)}s`);
}
