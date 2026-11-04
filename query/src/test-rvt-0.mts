// RVT-0: preconditions, checked before RVT-1 (check-only: writes nothing). RVT-1 may begin only when every line passes.
//   npx tsx src/test-rvt-0.mts      (from query/)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const Q = join(here, "..");
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const major = (pkg: string): number | null => {
  const p = join(Q, "node_modules", pkg, "package.json");
  return existsSync(p) ? Number(String(JSON.parse(readFileSync(p, "utf8")).version).split(".")[0]) : null;
};
check("P0.1", "zod 4.x installed", major("zod") === 4, `zod major ${major("zod")}`);
check("P0.2", "openai 7.x installed", major("openai") === 7, `openai major ${major("openai")}`);
check("P0.3", "tsx installed", major("tsx") !== null, "node_modules/tsx missing");
{ let opts: any = {}; try { opts = JSON.parse(readFileSync(join(Q, "tsconfig.json"), "utf8")).compilerOptions ?? {}; } catch { /* reported below */ }
  check("P0.4", "tsconfig allows .mts imports and is strict", opts.allowImportingTsExtensions === true && opts.strict === true, JSON.stringify(opts)); }
{ const p = join(Q, "..", "graph", "curated", "facts.json"); let names: string[] = [];
  try { const j = JSON.parse(readFileSync(p, "utf8")); const list = Array.isArray(j) ? j : Array.isArray(j.facts) ? j.facts : [];
    names = list.map((f: any) => (typeof f === "string" ? f : f?.name)).filter((s: unknown) => typeof s === "string" && /^(site|plan)\.[a-z0-9_]+$/.test(s as string)); } catch { /* reported below */ }
  check("P0.5", "graph/curated/facts.json readable with registered names", names.length > 0 && names.includes("site.zone"), `${names.length} names at ${p}`); }

const T: any = await import("./types.mts").catch((e) => ({ __err: String(e) }));
check("P0.6", "types.mts loads", !T.__err, T.__err);
const has = (k: string) => !!T[k] && typeof T[k].safeParse === "function";
for (const k of ["IndexEntry", "RuleFamily", "ClauseLedgerEntry", "Disposition", "LotFitEvent", "UsageRecord", "Verdict", "EvaluationStage", "ErrorCategory", "Report", "Uuid7", "Sha256", "ProvisionId", "FactName", "FactEntry"])
  check(`P0.7.${k}`, `types.mts exports ${k}`, has(k), "missing or not a zod schema");
{ const needs = has("ClauseLedgerEntry") && T.ClauseLedgerEntry.safeParse({ clause_id: "EUG.x#v1::sentence:1", kind: "sentence", quote: "q", modeled: false, guards: [], disposition: null, needs: ["site.zone"] }).success;
  check("P0.8", "ClauseLedgerEntry carries needs", !!needs); }
{ const types: string[] = has("LotFitEvent") ? T.LotFitEvent.options.map((o: any) => o.shape.type.value) : [];
  for (const t of ["lotfit.exclusion_recorded", "artifact_written", "messages", "turn_started", "turn_ended"])
    check(`P0.9.${t}`, `LotFitEvent has ${t}`, types.includes(t), JSON.stringify(types)); }
const E: any = await import("./events.mts").catch((e) => ({ __err: String(e) }));
for (const k of ["canonicalJson", "sha256Hex", "makeUuid7"]) check(`P0.10.${k}`, `events.mts exports ${k}`, typeof E[k] === "function", E.__err ?? "missing");

console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
