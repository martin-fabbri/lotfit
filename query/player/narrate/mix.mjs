// Lay each beat's mp3 at its timeline start -> narration.mp3 (ffmpeg).
// usage: node mix.mjs <run_dir>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: node mix.mjs <run_dir>"); process.exit(1); }
const tl = JSON.parse(readFileSync(join(dir, "timeline.json"), "utf8"));
const args = ["-y", "-loglevel", "error"];
tl.beats.forEach((b) => args.push("-i", join(dir, "narration", `${b.id}.mp3`)));
const chains = tl.beats.map((b, i) => `[${i}:a]adelay=${Math.round(b.start * 1000)}:all=1[a${i}]`);
const mix = tl.beats.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${tl.beats.length}:normalize=0,apad=whole_dur=${tl.duration}[out]`;
args.push("-filter_complex", [...chains, mix].join(";"), "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", join(dir, "narration.mp3"));
execFileSync("ffmpeg", args, { stdio: "inherit" });
console.log(`narration.mp3 (${tl.duration}s)`);
