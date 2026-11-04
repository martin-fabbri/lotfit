// Milestone 1, live: one scenario end to end with the real model (Muse Spark on Fireworks) and the real graph (Aura).
//   npx tsx src/run-live.mts [s1|s2|...]
// The key is read from the environment or this repo's .env.local, never printed. Prints the verdict line and where
// the run folder (events.jsonl, report.json, trace.json) is. CC, 2026-11-02.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeTier2Graph, evaluateDetailed } from "./harness.mts";
import { MetaReviewerClient } from "./reviewer-client.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// --baseten routes to Baseten (BASETEN_META_API_KEY); default Fireworks (FIREWORKS_API_KEY). Keys never printed.
if (process.argv.includes("--baseten")) process.env.LOTFIT_PROVIDER = "baseten";
else process.env.LOTFIT_PROVIDER = "fireworks";
const KEY = process.env.LOTFIT_PROVIDER === "baseten" ? "BASETEN_META_API_KEY" : "FIREWORKS_API_KEY";
if (!process.env[KEY]) {
  const f = join(ROOT, ".env.local");
  const line = existsSync(f) ? readFileSync(f, "utf8").split("\n").find((l) => l.startsWith(`${KEY}=`)) : undefined;
  if (!line) throw new Error(`${KEY} not found`);
  process.env[KEY] = line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "").trim();
}
// --reviewer (build-review S4): run the Reviewer (muse-spark-1.3 on the Meta Model API, META_API_KEY from the environment
// or .env.local). Off by default: a live Reviewer call needs Martin's go and Meta's price checked (L29, MM-03).
let reviewerClient: MetaReviewerClient | null = null;
if (process.argv.includes("--reviewer")) {
  if (!process.env.META_API_KEY) {
    const f = join(ROOT, ".env.local");
    const line = existsSync(f) ? readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("META_API_KEY=")) : undefined;
    if (line) process.env.META_API_KEY = line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "").trim();
  }
  reviewerClient = new MetaReviewerClient();
}
const name = process.argv[2] ?? "s1";
const kase = JSON.parse(readFileSync(new URL(`../cases/${name}.json`, import.meta.url), "utf8"));
const t0 = Date.now();
// Experiments run on loose budgets by default (Martin: the budget never stops an experiment); L33 usage is reported.
// --strict enforces the L33 milestone ceilings.
const DIAG = !process.argv.includes("--strict");
// --local reads the graph from graph/out/graph-or.json (FileGraphReader), e.g. before a new city is loaded into Aura.
const r = await evaluateDetailed(kase, { useAura: !process.argv.includes("--local"), runsDir: new URL("../out/runs-live", import.meta.url).pathname, reviewerClient,
  ...(DIAG ? { budgets: { max_tokens: 3_000_000, max_turns: 60, max_calls: 200, max_plan_execute_ms: 1_800_000, max_total_ms: 1_860_000 } } : {}) });
const rep = r.report as any;
console.log(JSON.stringify({
  scenario: name, diagnostic: DIAG, verdict: rep.verdict, model_verdict: rep.model_verdict, abnormal_end: rep.abnormal_end ?? null,
  unchecked: (rep.unchecked ?? []).length, findings: (rep.findings ?? []).length,
  reviewer: rep.reviewer ? { status: rep.reviewer.status, items: rep.reviewer.items, answered: rep.reviewer.answered, flags: rep.reviewer.flags.length, hold: rep.reviewer.hold } : null,
  usage: rep.usage ?? rep.budget ?? null, wall_s: +((Date.now() - t0) / 1000).toFixed(1), run_dir: r.run_dir,
}, null, 1));
await closeTier2Graph();
process.exit(0);
