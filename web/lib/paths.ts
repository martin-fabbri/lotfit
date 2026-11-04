import { join } from "node:path";
import { existsSync } from "node:fs";

// The app lives in web/; LotFit's records live beside it in the repo (cases, runs, the Rulebook graph).
export const REPO = process.env.LOTFIT_REPO || join(/*turbopackIgnore: true*/ process.cwd(), "..");
export const QUERY = join(REPO, "query");
export const CASES = join(QUERY, "cases");
export const GRAPH_FILE = join(REPO, "graph", "out", "graph-or.json");
export const PLAYER = join(QUERY, "player");
/** Run folders, newest kind first: live runs on this machine, then the runs recorded in the repo. */
export const RUN_DIRS = [join(QUERY, "out", "runs-live"), join(QUERY, "viewer", "demo")];

/** The engine (python3, query/src, its keys) is present only where LOTFIT_ENGINE=1, never on the hosted app. */
export function engineAvailable(): boolean {
  return process.env.LOTFIT_ENGINE === "1" && existsSync(/*turbopackIgnore: true*/ join(QUERY, "src", "run-live.mts"));
}

export const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
