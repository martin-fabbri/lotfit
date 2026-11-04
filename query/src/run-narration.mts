// Write narration lines for a run folder: reads trace.json + report.json, writes narration.json.
// Same key loading as run-live.mts (Fireworks by default, --baseten for Baseten). CC runs it live.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BasetenModelClient } from "./model-client.mts";
import { writeNarration } from "./narration.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
if (process.argv.includes("--baseten")) process.env.LOTFIT_PROVIDER = "baseten";
else process.env.LOTFIT_PROVIDER = "fireworks";
const KEY = process.env.LOTFIT_PROVIDER === "baseten" ? "BASETEN_META_API_KEY" : "FIREWORKS_API_KEY";
if (!process.env[KEY]) {
  const f = join(ROOT, ".env.local");
  const line = existsSync(f) ? readFileSync(f, "utf8").split("\n").find((l) => l.startsWith(`${KEY}=`)) : undefined;
  if (!line) throw new Error(`${KEY} not found`);
  process.env[KEY] = line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "").trim();
}

const dir = process.argv[2];
if (!dir) throw new Error("usage: run-narration.mts <run_dir>");
const trace = JSON.parse(readFileSync(join(dir, "trace.json"), "utf8"));
const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
const narration = await writeNarration(trace, report, new BasetenModelClient({ maxTokens: 6000, reasoningEffort: "low" }));
writeFileSync(join(dir, "narration.json"), JSON.stringify(narration, null, 2) + "\n");
console.log(`narration.json: ${narration.beats.length} beats (${narration.beats.filter((b) => b.source === "template").length} template)`);
