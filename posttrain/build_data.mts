// Build SFT data for LotFit's planner step from past live runs. Only runs the deterministic
// Judge accepted (report.verifier.passed) become rows; anything else is refused. Cases whose id
// mentions martin are excluded, and the case summary uses an allowlist of fact fields only, so no
// address, tax lot or owner name can reach the training data. Hold-out cases stay out of train.
// Usage: node posttrain/build_data.mts <runs-dir> <out-dir> [--holdout case_id,case_id]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const HOLDOUT_DEFAULT = [
  "019a4000-0000-7000-8000-000000000004",
  "019a4000-0000-7000-8000-000000000007",
];
const BANNED = /address|taxlot|tax_lot|parcel|owner|mailing|eug-martin/i;

const v = (x: any): any => (x && typeof x === "object" && "value" in x ? x.value : x);

function bbox(pts: any): string | null {
  if (!Array.isArray(pts) || pts.length < 3) return null;
  const xs = pts.map((p: any) => p[0]).filter((n: any) => typeof n === "number");
  const ys = pts.map((p: any) => p[1]).filter((n: any) => typeof n === "number");
  if (!xs.length) return null;
  const r = (n: number): number => Math.round(n * 100) / 100;
  return `${r(Math.max(...xs) - Math.min(...xs))} x ${r(Math.max(...ys) - Math.min(...ys))} ft`;
}

/** Case facts for the prompt: allowlisted fields only, never free text. */
export function caseSummary(c: any): string {
  const s = c.site ?? {}, p = c.plan ?? {};
  const out: string[] = [];
  if (v(s.zone)) out.push(`zone ${v(s.zone)}`);
  if (v(s.zone_family)) out.push(`family ${v(s.zone_family)}`);
  const ov = v(s.overlays);
  if (Array.isArray(ov) && ov.length) out.push(`overlays ${ov.join(", ")}`);
  const lot = bbox(v(s.lot_outline));
  if (lot) out.push(`lot ${lot}`);
  if (typeof v(s.lot_area_sqft) === "number") out.push(`lot area ${v(s.lot_area_sqft)} sq ft`);
  if (typeof v(s.slope_pct) === "number") out.push(`slope ${v(s.slope_pct)} pct`);
  for (const f of ["corner_lot", "flag_lot", "through_lot", "alley", "historic_resource"]) {
    if (v(s[f]) === true) out.push(f);
  }
  if (v(p.kind)) out.push(`plan ${v(p.detached) ? "detached " : ""}${v(p.kind)}`);
  const fp = bbox(v(p.footprint));
  if (fp) out.push(`footprint ${fp}`);
  if (typeof v(p.total_building_sqft) === "number") out.push(`building ${v(p.total_building_sqft)} sq ft`);
  if (typeof v(p.height_ft) === "number") out.push(`height ${v(p.height_ft)} ft`);
  const pl = v(p.placement);
  if (pl && typeof pl.x === "number") out.push(`spot ${pl.x} ft from the left, ${pl.y} ft back`);
  return out.join("; ");
}

const SYSTEM = "You are LotFit's planner. Partition every index provision into applies or excluded_at_index, copying each scope_quote verbatim. Answer with ONLY the plan JSON object.";

export interface BuiltRow {
  messages: Array<{ role: string; content: string }>;
  kind: "plan" | "decision";
  case_id: string;
}

export function planRow(caseText: string, index: any, plan: any, caseId: string): BuiltRow {
  const lines = ["provision_id | stage | scope_quote"];
  for (const l of index.layers ?? []) for (const p of l.provisions ?? []) {
    lines.push(`${p.provision_id} | ${p.evaluation_stage} | ${JSON.stringify(p.scope?.scope_quote ?? "")}`);
  }
  const answer = {
    index_hash: index.index_hash,
    applies: (plan.applies ?? []).map((a: any) => ({ provision_id: a.provision_id, scope_quote: a.scope_quote, facts_needed: a.facts_needed ?? [] })),
    excluded_at_index: (plan.excluded_at_index ?? []).map((a: any) => ({ provision_id: a.provision_id, scope_quote: a.scope_quote })),
    order: plan.order ?? [],
  };
  return {
    kind: "plan",
    case_id: caseId,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `## Case\n${caseText}\n\n## Layer index\n${lines.join("\n")}` },
      { role: "assistant", content: JSON.stringify(answer) },
    ],
  };
}

export function decisionRow(caseText: string, prov: any, decision: "applies" | "excluded", quote: string, caseId: string): BuiltRow {
  return {
    kind: "decision",
    case_id: caseId,
    messages: [
      { role: "system", content: "You are LotFit's planner. Say whether one provision applies to the case. Answer with ONLY the JSON object." },
      { role: "user", content: `## Case\n${caseText}\n\n## Provision\n${prov.provision_id} | ${prov.evaluation_stage} | ${JSON.stringify(prov.scope?.scope_quote ?? "")}` },
      { role: "assistant", content: JSON.stringify({ provision_id: prov.provision_id, decision, scope_quote: quote }) },
    ],
  };
}

export interface BuildStats {
  runs: number;
  verified: number;
  trainRuns: number;
  evalRuns: number;
  trainRows: number;
  evalRows: number;
  trainCases: string[];
  evalCases: string[];
}

export function buildData(runsDir: string, holdout: string[]): { train: BuiltRow[]; eval: BuiltRow[]; stats: BuildStats; stages: Record<string, Record<string, string>> } {
  const train: BuiltRow[] = [];
  const evalRows: BuiltRow[] = [];
  const stages: Record<string, Record<string, string>> = {};
  const stats: BuildStats = { runs: 0, verified: 0, trainRuns: 0, evalRuns: 0, trainRows: 0, evalRows: 0, trainCases: [], evalCases: [] };
  const trainCases = new Set<string>();
  const evalCases = new Set<string>();
  for (const d of readdirSync(runsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(runsDir, d.name);
    const need = ["report.json", "plan.json", "case.json", "index.json"].map((f) => join(dir, f));
    if (!need.every(existsSync)) continue;
    stats.runs++;
    const report = JSON.parse(readFileSync(need[0]!, "utf8"));
    if (!report?.verifier?.passed) continue;
    const caseId = String(report.case_id ?? "");
    if (!caseId || BANNED.test(caseId)) continue;
    stats.verified++;
    const kase = JSON.parse(readFileSync(need[2]!, "utf8"));
    const index = JSON.parse(readFileSync(need[3]!, "utf8"));
    const plan = JSON.parse(readFileSync(need[1]!, "utf8"));
    const summary = caseSummary(kase);
    const isEval = holdout.includes(caseId);
    const dest = isEval ? evalRows : train;
    if (isEval) {
      stats.evalRuns++; evalCases.add(caseId);
      if (!stages[caseId]) {
        stages[caseId] = {};
        for (const l of index.layers ?? []) for (const p of l.provisions ?? []) stages[caseId]![p.provision_id] = p.evaluation_stage;
      }
    } else { stats.trainRuns++; trainCases.add(caseId); }
    dest.push(planRow(summary, index, plan, caseId));
    const byId = new Map<string, any>();
    for (const l of index.layers ?? []) for (const p of l.provisions ?? []) byId.set(p.provision_id, p);
    for (const a of plan.applies ?? []) {
      const p = byId.get(a.provision_id);
      if (p) dest.push(decisionRow(summary, p, "applies", a.scope_quote, caseId));
    }
    for (const e of plan.excluded_at_index ?? []) {
      const p = byId.get(e.provision_id);
      if (p) dest.push(decisionRow(summary, p, "excluded", e.scope_quote, caseId));
    }
  }
  stats.trainRows = train.length;
  stats.evalRows = evalRows.length;
  stats.trainCases = [...trainCases].sort();
  stats.evalCases = [...evalCases].sort();
  for (const rows of [train, evalRows]) {
    for (const r of rows) {
      const text = JSON.stringify(r.messages);
      if (BANNED.test(text)) throw new Error(`banned text leaked into a ${r.kind} row for ${r.case_id}`);
    }
  }
  return { train, eval: evalRows, stats, stages };
}

function main(): void {
  const args = process.argv.slice(2);
  const runsDir = args[0];
  const outDir = args[1];
  if (!runsDir || !outDir) throw new Error("usage: build_data.mts <runs-dir> <out-dir> [--holdout id,id]");
  const hi = args.indexOf("--holdout");
  const holdout = hi >= 0 ? args[hi + 1]!.split(",").map((s) => s.trim()).filter(Boolean) : HOLDOUT_DEFAULT;
  const { train, eval: evalRows, stats, stages: evalStages } = buildData(runsDir, holdout);
  mkdirSync(outDir, { recursive: true });
  const strip = (rows: BuiltRow[]): string => rows.map((r) => JSON.stringify({ messages: r.messages })).join("\n") + "\n";
  writeFileSync(join(outDir, "train.jsonl"), strip(train));
  writeFileSync(join(outDir, "eval.jsonl"), strip(evalRows));
  writeFileSync(join(outDir, "labels.json"), JSON.stringify({
    eval: evalRows.map((r) => ({ kind: r.kind, case_id: r.case_id, assistant: r.messages[2]!.content })),
    stages: evalStages,
  }, null, 2));
  console.log(`runs ${stats.runs} verified ${stats.verified} train_runs ${stats.trainRuns} eval_runs ${stats.evalRuns}`);
  console.log(`train_rows ${stats.trainRows} eval_rows ${stats.evalRows}`);
  console.log(`train_cases ${stats.trainCases.join(",")}`);
  console.log(`eval_cases ${stats.evalCases.join(",")}`);
}

const invoked = process.argv[1]?.endsWith("build_data.mts");
if (invoked) main();
