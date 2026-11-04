// RCT-0: is the repo ready for the Record? Check only: this script writes nothing. Run from query/.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const ver = (pkg: string): string | null => {
  const p = join(root, "node_modules", pkg, "package.json");
  return existsSync(p) ? String(JSON.parse(readFileSync(p, "utf8")).version) : null;
};
const zv = ver("zod");
check("RP0.1", "zod 4 is installed", !!zv && zv.startsWith("4."), String(zv));
check("RP0.2", "tsx is installed", !!ver("tsx"), "node_modules/tsx missing");
let tsconfig: any = null;
try { tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")); } catch { /* reported below */ }
check("RP0.3", "tsconfig allows .mts imports with their extension", tsconfig?.compilerOptions?.allowImportingTsExtensions === true, "compilerOptions.allowImportingTsExtensions must be true");
check("RP0.5", "tsconfig is strict", tsconfig?.compilerOptions?.strict === true, "compilerOptions.strict must be true");
check("RP0.6", "typescript is installed", !!ver("typescript"), "node_modules/typescript missing");
check("RP0.7", "@types/node is installed", !!ver("@types/node"), "node_modules/@types/node missing");
// The contracts kit: one types.mts shared by every component, copied in by Martin (never written by a card).
const CONTRACTS_SHA = "fed00915fd224cf6a8e6d5dfd4d727ed62cdef0260df868ba694dd5a2ef63f7a";
const typesPath = join(here, "types.mts");
const typesSha = existsSync(typesPath) ? createHash("sha256").update(readFileSync(typesPath)).digest("hex") : "missing";
check("RP0.8", "query/src/types.mts is the contracts kit (sha256 pinned)", typesSha === CONTRACTS_SHA, `sha256 ${typesSha}: copy the contracts kit's types.mts unchanged`);

let C: Record<string, any> = {};
try { C = await import("./types.mts"); } catch (e) { check("RP0.4", "query/src/types.mts loads", false, (e as Error).message); }
if (Object.keys(C).length) check("RP0.4", "query/src/types.mts loads", true);
const shapes = ["Uuid7", "Sha256", "IsoDate", "IsoDateTime", "ProvisionId", "ClauseId", "FactName", "Polygon", "Placement",
  "Verdict", "EvaluationStage", "Outcome", "ErrorCategory", "ToolCall", "RecordFinding", "RepairError", "UsageRecord",
  "ArtifactRef", "ConfigManifest", "LotFitEvent", "FactEntry", "Case", "MeasureResult", "ReportFinding", "Report", "Trace"];
for (const s of shapes) check(`RP1.${s}`, `types.mts exports ${s}`, !!C[s] && typeof C[s].safeParse === "function", "missing");

// The C6 event union must have every member the Record writes or reads (RCS-01).
const MEMBERS = ["thread_created", "thread_forked", "turn_started", "messages", "tool_requested", "tool_result",
  "artifact_written", "turn_ended", "error", "lotfit.plan_written", "lotfit.finding_recorded",
  "lotfit.sensitivity_completed", "lotfit.verifier_completed", "lotfit.ledger_compacted", "lotfit.verdict_computed",
  "lotfit.reviewer_completed", "lotfit.flag_resolved", "lotfit.exclusion_recorded"];
const have = new Set<string>(((C.LotFitEvent?.options ?? []) as any[]).map((o) => o.shape?.type?.value));
const missing = MEMBERS.filter((m) => !have.has(m));
check("RP2.1", "LotFitEvent has all 18 members", missing.length === 0, `missing: ${missing.join(", ")}`);
const extra = [...have].filter((m) => !MEMBERS.includes(m));
check("RP2.2", "LotFitEvent has no member the Record does not know", extra.length === 0, `unknown: ${extra.join(", ")}`);
const baseKeys = Object.keys(C.LotFitEvent?.options?.[0]?.shape ?? {}).sort().join(",");
check("RP2.3", "every event carries the common fields", baseKeys === "config_hash,created_at,data,graph_load_id,id,seq,session_id,thread_id,turn_id,type", baseKeys);

// Information only (not scored): RCT-1 writes events.mts, so after RCT-1 this line says "already there", which is fine.
const helpers = existsSync(join(here, "events.mts"));
console.log(`INFO  RP3.1 query/src/events.mts ${helpers ? "already exists (expected after RCT-1; before it, tell Martin)" : "does not exist yet (RCT-1 writes it)"}`);
console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
