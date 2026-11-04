// INT-7 (frozen): the bridge's output parses as contract C3 (IN-02, IN-09). Runs the self-test with --write-fixtures in a
// temporary copy of graph/tools, graph/tool_runner.py and graph/examples (the repo is never written), then parses the
// request and the response with the contracts kit (query/src/types.mts): BridgeRequest, BridgeResponse, and every
// result by its tool (MeasureResult, ExceptionResult, GuardResult, the search summary). No network.
// Run from query/: npx tsx src/test-int-7.mts
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";

const here = dirname(fileURLToPath(import.meta.url));
const GRAPH = join(here, "..", "..", "graph");
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const issues = (r: { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } }) =>
  r.success ? "" : r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

const d = mkdtempSync(join(tmpdir(), "int7-"));
try {
  const g = join(d, "graph");
  mkdirSync(g);
  cpSync(join(GRAPH, "tools"), join(g, "tools"), { recursive: true, filter: (s) => !s.includes("__pycache__") });
  cpSync(join(GRAPH, "examples"), join(g, "examples"), { recursive: true });
  cpSync(join(GRAPH, "tool_runner.py"), join(g, "tool_runner.py"));
  const fx = join(d, "query", "contracts", "fixtures", "valid");
  mkdirSync(fx, { recursive: true });
  let out = "";
  try { out = execFileSync("python3", ["-I", join(g, "tool_runner.py"), "--self-test", "--write-fixtures"], { encoding: "utf8" }); }
  catch (e) { out = String((e as { stdout?: string }).stdout ?? e); }
  check("T7.1", "the self-test passes and writes the two fixtures", /^16\/16 bridge checks/m.test(out), out.slice(-300));

  const req = JSON.parse(readFileSync(join(fx, "C3_BridgeRequest.self-test.json"), "utf8"));
  const resp = JSON.parse(readFileSync(join(fx, "C3_BridgeResponse.self-test.json"), "utf8"));
  const pr = C.BridgeRequest.safeParse(req);
  check("T7.2", "the request parses as C3 BridgeRequest", pr.success, issues(pr));
  const ps = C.BridgeResponse.safeParse(resp);
  check("T7.3", "the response parses as C3 BridgeResponse", ps.success, issues(ps));

  const tools = new Map<string, string>(req.batch.map((c: { call_id: string; tool: string }) => [c.call_id, c.tool]));
  const MEASURE = new Set(["check_setback", "check_allowed", "check_max", "footprint_dimensions", "adu_max_living_area", "coverage_share",
    "total_building_coverage", "check_front_or_behind"]);
  let measured = 0, exc = 0, guards = 0, search = 0, errors = 0;
  for (const r of resp.results as Array<{ call_id: string; ok: boolean; result?: unknown; error?: unknown }>) {
    const tool = tools.get(r.call_id) ?? "?";
    if (!r.ok) { errors++; continue; }
    if (MEASURE.has(tool)) { measured++; const p = C.MeasureResult.safeParse(r.result); check(`T7.4.${tool}.${r.call_id.slice(-2)}`, `${tool} result is a C3 MeasureResult`, p.success, issues(p)); }
    else if (tool === "check_exception_conditions") { exc++; const p = C.ExceptionResult.safeParse(r.result); check("T7.5", "the exception result is a C3 ExceptionResult", p.success, issues(p)); }
    else if (tool === "evaluate_guards") { guards++; const p = C.GuardResult.safeParse(r.result); check("T7.6", "the guard result is a C3 GuardResult", p.success, issues(p)); }
    else if (tool === "find_placements") {
      search++;
      const p = C.PlacementSearchResult.safeParse((r.result as { summary: unknown }).summary);
      check("T7.7", "the search summary is a C3 PlacementSearchResult", p.success, issues(p));
    }
  }
  check("T7.8", "every kind of result was seen: 10 measures, 1 exception, 1 guard result, 1 search, 2 errors (the typed limit, the solar check)",
    measured === 10 && exc === 1 && guards === 1 && search === 1 && errors === 2, JSON.stringify({ measured, exc, guards, search, errors }));
} finally {
  rmSync(d, { recursive: true, force: true });
}
console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
