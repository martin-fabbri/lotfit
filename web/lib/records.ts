import "server-only";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CASES, RUN_DIRS, SAFE_NAME } from "./paths";

export type CaseSummary = { name: string; city: string; mode: string; as_of: string; zone: string; plan_sqft: number | null; capture: boolean };
export type RunSummary = {
  id: string; started: string; done: boolean; verdict: string | null; city: string | null; mode: string | null;
  cost_usd: number | null; turns: number | null; calls: number | null; findings: number | null; recorded: boolean;
};

const readJson = (p: string): any => JSON.parse(readFileSync(/*turbopackIgnore: true*/ p, "utf8"));

export function listCases(): CaseSummary[] {
  return readdirSync(/*turbopackIgnore: true*/ CASES).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const c = readJson(join(CASES, f));
    return { name: f.replace(/\.json$/, ""), city: c.jurisdiction?.city_layer ?? "", mode: c.mode ?? "", as_of: c.as_of?.date ?? "",
      zone: c.site?.zone?.value ?? "", plan_sqft: c.plan?.total_building_sqft?.value ?? null, capture: Boolean(c.capture) };
  });
}

export function readCase(name: string): any | null {
  if (!SAFE_NAME.test(name)) return null;
  const p = join(CASES, `${name}.json`);
  return existsSync(/*turbopackIgnore: true*/ p) ? readJson(p) : null;
}

export function runDir(id: string): string | null {
  if (!SAFE_NAME.test(id)) return null;
  for (const d of RUN_DIRS) if (existsSync(/*turbopackIgnore: true*/ join(d, id, "events.jsonl"))) return join(d, id);
  return null;
}

export function listRuns(): RunSummary[] {
  const out: RunSummary[] = [];
  RUN_DIRS.forEach((d, i) => {
    if (!existsSync(/*turbopackIgnore: true*/ d)) return;
    for (const id of readdirSync(/*turbopackIgnore: true*/ d)) {
      const dir = join(d, id);
      if (!existsSync(/*turbopackIgnore: true*/ join(dir, "events.jsonl"))) continue;
      let r: any = null, c: any = null;
      try { r = readJson(join(dir, "report.json")); } catch {}
      try { c = readJson(join(dir, "case.json")); } catch {}
      const first = readFileSync(/*turbopackIgnore: true*/ join(dir, "events.jsonl"), "utf8").split("\n", 1)[0];
      let started = statSync(/*turbopackIgnore: true*/ join(dir, "events.jsonl")).mtime.toISOString();
      try { started = JSON.parse(first).created_at ?? started; } catch {}
      out.push({ id, started, done: Boolean(r), verdict: r?.verdict ?? null, city: c?.jurisdiction?.city_layer ?? null,
        mode: c?.mode ?? null, cost_usd: r?.telemetry?.cost_usd ?? null, turns: r?.telemetry?.turns ?? null,
        calls: r?.telemetry?.calls ?? null, findings: r?.findings?.length ?? null, recorded: i > 0 });
    }
  });
  return out.sort((a, b) => b.started.localeCompare(a.started));
}

export const RUN_FILES = new Set(["case.json", "case-facts.json", "plan.json", "events.jsonl", "report.json", "trace.json",
  "sensitivity.json", "timeline.json", "narration.json", "narration.mp3"]);

export function runFile(id: string, f: string): Buffer | null {
  const dir = runDir(id);
  if (!dir || !RUN_FILES.has(f)) return null;
  const path = [dir, f].join("/");
  if (!existsSync(/*turbopackIgnore: true*/ path)) return null;
  return readFileSync(/*turbopackIgnore: true*/ path);
}

export function runJson(id: string, f: string): any | null {
  const b = runFile(id, f);
  if (!b) return null;
  try { return JSON.parse(String(b)); } catch { return null; }
}

export function runEvents(id: string): any[] {
  const b = runFile(id, "events.jsonl");
  if (!b) return [];
  return String(b).split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
