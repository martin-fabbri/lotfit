// Score a chat model on LotFit's planner step: same eval rows, code-scored. For plan rows
// the applies set is scored against the verified plan (F1, plus the placement_constraint
// slice); for decision rows the applies/excluded call is scored per provision. Validity
// (JSON parses, partition covers the index) is reported separately. No model judges.
// Usage: node posttrain/eval_plan.mts --model <fireworks-id> --key-file .env.local
//   --rows eval.jsonl --labels labels.json [--max N] [--out results.json]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export interface Label { kind: string; case_id: string; assistant: string }
export interface RowResult {
  i: number;
  kind: string;
  case_id: string;
  valid: boolean;
  score: number;
  place?: number;
  detail: string;
}

export function extractJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = (fence ? fence[1]! : text).trim();
  try { return JSON.parse(cand); } catch { /* fall through */ }
  const a = cand.indexOf("{"), b = cand.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(cand.slice(a, b + 1)); } catch { return null; }
  }
  return null;
}

const f1 = (tp: number, fp: number, fn: number): number =>
  tp + fp + fn === 0 ? 1 : (2 * tp) / (2 * tp + fp + fn);

export function scorePlan(got: any, want: any, stages: Record<string, string>): { valid: boolean; f1: number; placeF1: number; detail: string } {
  const wantApplies = new Set((want.applies ?? []).map((a: any) => a.provision_id));
  const universe = new Set<string>([
    ...(want.applies ?? []).map((a: any) => a.provision_id),
    ...(want.excluded_at_index ?? []).map((a: any) => a.provision_id),
  ]);
  if (!got || typeof got !== "object") return { valid: false, f1: 0, placeF1: 0, detail: "no json" };
  const gotApplies = (got.applies ?? []).map((a: any) => a.provision_id);
  const gotExcluded = (got.excluded_at_index ?? []).map((a: any) => a.provision_id);
  const seen = new Set([...gotApplies, ...gotExcluded]);
  const dupes = gotApplies.length + gotExcluded.length !== seen.size;
  const covers = universe.size > 0 && seen.size === universe.size && [...universe].every((id) => seen.has(id));
  const valid = covers && !dupes;
  let tp = 0, fp = 0, fn = 0, ptp = 0, pfp = 0, pfn = 0;
  for (const id of new Set([...gotApplies, ...wantApplies])) {
    const g = gotApplies.includes(id), w = wantApplies.has(id);
    if (g && w) tp++; else if (g) fp++; else fn++;
    if (stages[id] === "placement_constraint") {
      if (g && w) ptp++; else if (g) pfp++; else pfn++;
    }
  }
  return { valid, f1: f1(tp, fp, fn), placeF1: f1(ptp, pfp, pfn), detail: `tp ${tp} fp ${fp} fn ${fn}` };
}

export function scoreDecision(got: any, want: any): { valid: boolean; acc: number } {
  if (!got || typeof got.decision !== "string") return { valid: false, acc: 0 };
  return { valid: true, acc: got.decision === want.decision ? 1 : 0 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function chat(model: string, key: string, messages: Array<{ role: string; content: string }>, effort: string): Promise<string> {
  const body = JSON.stringify({ model, messages, temperature: 0, max_tokens: 8000, reasoning_effort: effort });
  let last = "";
  for (const wait of [0, 15000, 60000]) {
    if (wait) await sleep(wait);
    try {
      const out = execFileSync("curl", ["-s", "--max-time", "300",
        "-H", "Content-Type: application/json", "-H", `Authorization: Bearer ${key}`,
        "-d", body, "https://api.fireworks.ai/inference/v1/chat/completions"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const parsed = JSON.parse(out);
      if (parsed.error) { last = JSON.stringify(parsed.error).slice(0, 200); continue; }
      return parsed.choices?.[0]?.message?.content ?? "";
    } catch (e: any) { last = String(e.message ?? e).slice(0, 200); }
  }
  throw new Error(`fireworks: ${last}`);
}

function keyFrom(file: string, name: string): string {
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not found in ${file}`);
  return line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "").trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (k: string): string => {
    const i = args.indexOf(k);
    if (i < 0 || !args[i + 1]) throw new Error(`missing ${k}`);
    return args[i + 1]!;
  };
  const model = get("--model");
  const key = keyFrom(get("--key-file"), "FIREWORKS_API_KEY");
  const allRows = readFileSync(get("--rows"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const labels = JSON.parse(readFileSync(get("--labels"), "utf8")) as { eval: Label[]; stages: Record<string, Record<string, string>> };
  const kind = args.includes("--kind") ? get("--kind") : null;
  const effort = args.includes("--effort") ? get("--effort") : "low";
  const idx = allRows.map((_, i) => i).filter((i) => !kind || labels.eval[i]!.kind === kind);
  const max = args.includes("--max") ? Number(get("--max")) : idx.length;
  const results: RowResult[] = [];
  let errors = 0;
  for (const i of idx.slice(0, max)) {
    const label = labels.eval[i]!;
    try {
      const text = await chat(model, key, allRows[i]!.messages, effort);
      const got = extractJson(text);
      const want = JSON.parse(label.assistant);
      if (label.kind === "plan") {
        const s = scorePlan(got, want, labels.stages[label.case_id] ?? {});
        results.push({ i, kind: "plan", case_id: label.case_id, valid: s.valid, score: s.f1, place: s.placeF1, detail: s.detail });
      } else {
        const s = scoreDecision(got, want);
        results.push({ i, kind: "decision", case_id: label.case_id, valid: s.valid, score: s.acc, detail: "" });
      }
    } catch (e: any) {
      errors++;
      results.push({ i, kind: label.kind, case_id: label.case_id, valid: false, score: 0, detail: String(e.message ?? e).slice(0, 120) });
    }
    const r = results[results.length - 1]!;
    console.log(`${i} ${r.kind} valid=${r.valid ? 1 : 0} score=${r.score.toFixed(3)} ${r.detail}`);
  }
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const plans = results.filter((r) => r.kind === "plan");
  const decs = results.filter((r) => r.kind === "decision");
  const summary = {
    model, n: results.length, errors,
    plan_f1: avg(plans.map((r) => r.score)),
    plan_place_f1: avg(plans.map((r) => r.place ?? 0)),
    plan_valid: avg(plans.map((r) => (r.valid ? 1 : 0))),
    decision_acc: avg(decs.map((r) => r.score)),
  };
  console.log(JSON.stringify(summary));
  if (args.includes("--out")) writeFileSync(get("--out"), JSON.stringify({ summary, results }, null, 2));
}

const invoked = process.argv[1]?.endsWith("eval_plan.mts");
if (invoked) await main();
