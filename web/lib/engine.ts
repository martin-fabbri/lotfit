import "server-only";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, QUERY, SAFE_NAME, engineAvailable } from "./paths";
import { listRuns } from "./records";

// The bridge to LotFit's engine in query/. The app never re-implements a check: it runs the engine's own code.

/** checkCase() from query/src/case-gate.mts (contract, invariants I1–I12, the Python validator), in a child process. */
export function checkCaseWithEngine(kase: unknown): Promise<any> {
  if (!engineAvailable()) return Promise.resolve({ unavailable: true });
  const script = `import { checkCase } from ${JSON.stringify("file://" + join(QUERY, "src", "case-gate.mts"))};
let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => {
  try { process.stdout.write(JSON.stringify(checkCase(JSON.parse(s)))); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 400) })); }
});`;
  return new Promise((resolve) => {
    const p = execFile(process.execPath, ["--input-type=module", "-e", script], { cwd: QUERY, timeout: 60_000, maxBuffer: 20_000_000 },
      (err, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: String(err?.message ?? "no output").slice(0, 400) }); }
      });
    p.stdin!.end(JSON.stringify(kase));
  });
}

/** Saves an edited case under a new name (only where the engine runs). */
export function saveCase(name: string, kase: unknown): string {
  if (!engineAvailable() || !SAFE_NAME.test(name)) throw new Error("cannot save here");
  writeFileSync(/*turbopackIgnore: true*/ join(CASES, `${name}.json`), JSON.stringify(kase, null, 2) + "\n");
  return name;
}

// One live run at a time: query/src/run-live.mts as a child process, its output in query/out/app-runs/.
type Live = { case: string; started: number; exit: number | null; log: string };
const g = globalThis as unknown as { __lotfitLive?: Live };

export function startRun(name: string, reviewer: boolean): { ok: true } | { error: string } {
  if (!engineAvailable()) return { error: "the engine is not on this machine" };
  if (g.__lotfitLive && g.__lotfitLive.exit === null) return { error: "a run is already in progress" };
  if (!SAFE_NAME.test(name) || !existsSync(/*turbopackIgnore: true*/ join(CASES, `${name}.json`))) return { error: "unknown case" };
  const logDir = join(QUERY, "out", "app-runs");
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });
  const log = join(logDir, `${Date.now()}-${name}.log`);
  const fd = openSync(/*turbopackIgnore: true*/ log, "a");
  const proc = spawn(process.execPath, ["src/run-live.mts", name, ...(reviewer ? ["--reviewer"] : [])],
    { cwd: QUERY, env: process.env, stdio: ["ignore", fd, fd], detached: true });
  const live: Live = { case: name, started: Date.now(), exit: null, log };
  g.__lotfitLive = live;
  proc.on("exit", (code) => { live.exit = code ?? 1; });
  proc.unref();
  return { ok: true };
}

export function liveStatus() {
  const L = g.__lotfitLive;
  if (!L) return { running: false as const };
  const run = listRuns().find((r) => !r.recorded && Date.parse(r.started) >= L.started - 5000);
  return { running: L.exit === null, exit: L.exit, case: L.case, started: L.started, run: run?.id ?? null };
}
