// RVT-2: rubric, people, canonicalModel, factStatus, facts registry (RVS-03, RVS-04, RVS-05). Frozen acceptance test (kit).
//   npx tsx src/test-rvt-2.mts      (from query/)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadRubric, loadPeople, canonicalModel, factStatus, isScalarish, loadFactRegistry, resetFactRegistry, registeredFacts, projectKindOf } from "./reviewer.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(readFileSync(join(here, "..", "reviewer", "fixtures", f), "utf8"));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const J = (x: unknown) => JSON.stringify(x);
const tmp = mkdtempSync(join(tmpdir(), "rvt2-"));

// RB1 (D13: rubric v1.1)
{ const r = loadRubric();
  const set = (s: Set<string>) => J([...s].sort());
  check("RB1", "rubric v1.1 loads with its pinned sha256", r.id === "lotfit.reviewer-rubric" && r.version === "1.1" &&
    r.sha256 === "18b8b450f5286a81c5b00c89b2861bd73091f34025962673bd159adef6c0fcce" &&
    r.system.includes("from its scope sentence or its text; a sound answer may also quote its title") &&
    set(r.enabled) === J(["exclusion_on_unknown_fact", "wrong_exclusion", "scope_sentence_not_scope"].sort()) &&
    set(r.reviewed_stages) === J(["gate", "plan_constraint", "placement_constraint", "exception", "preemption"].sort()) &&
    r.min_quote_chars === 20 && r.system.split("\n").length === 8, J({ id: r.id, sha: r.sha256, n: r.system.split("\n").length })); }
// RB2
{ const raw = JSON.parse(readFileSync(join(here, "..", "reviewer", "rubric-v1.json"), "utf8")); raw.enabled.push("wrong_paramter");
  const p = join(tmp, "bad-rubric.json"); writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
  let threw = false; try { loadRubric(p); } catch { threw = true; }
  check("RB2", "typo category throws", threw); }
// RB2b (D12): a typo in a reviewed stage, a severity row's stage, severity or route throws
{ const base = () => JSON.parse(readFileSync(join(here, "..", "reviewer", "rubric-v1.json"), "utf8"));
  const bad = [(j: any) => { j.reviewed_stages.push("placment_constraint"); }, (j: any) => { j.severity[0].stages.push("gat"); },
    (j: any) => { j.severity[0].severity = "urgent"; }, (j: any) => { j.severity[0].route = "hold"; }, (j: any) => { j.severity[0].category = "wrong_paramter"; }];
  const got = bad.map((f, i) => { const j = base(); f(j); const p = join(tmp, `bad-${i}.json`); writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    try { loadRubric(p); return false; } catch { return true; } });
  check("RB2b", "bad stage, severity, route or row category throws", got.every(Boolean), J(got)); }
// RP1
{ const p = loadPeople(); check("RP1", "people", J(p.people) === J([{ name: "Martin Fabbri", role: "owner" }]), J(p)); }
// RB3 (data assertion: the severity table rows, as RVS-03 gives them)
{ const r = loadRubric();
  const look = (category: string, stage: string) => { const row = r.severity.find(x => x.category === category && x.stages.includes(stage)); return row ? [row.severity, row.route] : ["low", "attach"]; };
  const got = [look("wrong_exclusion", "gate"), look("exclusion_on_unknown_fact", "exception"), look("scope_sentence_not_scope", "placement_constraint")];
  check("RB3", "severity table", J(got) === J([["high", "hold_if_fits"], ["medium", "attach"], ["low", "rulebook_queue"]]), J(got)); }

// T4
const cm = canonicalModel;
check("T4.1", "open-weight spellings equal", cm("accounts/fireworks/models/muse-spark-open") === "muse-spark-open" && cm("meta-models/muse-spark-open-1026") === "muse-spark-open");
check("T4.2", "contributor suffix dropped", cm("muse-spark-1.3-contributor") === "muse-spark-1.3" && cm("muse-spark-1.3") === "muse-spark-1.3");
check("T4.2b", "1p3 and :standard", cm("accounts/fireworks/models/muse-spark-1p3") === "muse-spark-1.3" && cm("meta/muse-spark-1.3:standard") === "muse-spark-1.3");
check("T4.2c", "underscores and date", cm("Muse_Spark_1.3-0926") === "muse-spark-1.3", cm("Muse_Spark_1.3-0926"));
check("T4.2d", "case, space, endpoint", cm("  META/Muse-Spark-1.3:contributor ") === "muse-spark-1.3" && cm("muse-spark-1.3:contributor") === "muse-spark-1.3");
check("T4.2e", "different models differ", cm("muse-spark-1.3") !== cm("muse-spark-open"));
// D11: -contributor is removed after underscores and the date suffix
check("T4.2f", "contributor before a date, or with an underscore", cm("muse-spark-1.3-contributor-0926") === "muse-spark-1.3" && cm("muse-spark-1.3_contributor") === "muse-spark-1.3",
  J([cm("muse-spark-1.3-contributor-0926"), cm("muse-spark-1.3_contributor")]));

// S
const K = fx("case-sample.json"); const P = structuredClone(K); P.site.zone.status = "unconfirmed";
const mod = (f: (c: any) => void) => { const c = structuredClone(K); f(c); return c; };
check("S1", "zone known", J(factStatus(K, "site.zone")) === J({ status: "known", value: "R-1" }), J(factStatus(K, "site.zone")));
check("S2", "zone unconfirmed", J(factStatus(P, "site.zone")) === J({ status: "unconfirmed", value: "R-1" }));
check("S3", "flag_lot false", J(factStatus(K, "site.flag_lot")) === J({ status: "false", value: false }));
check("S4", "detached true", J(factStatus(K, "plan.detached")) === J({ status: "true", value: true }));
check("S5", "unknowns", J(factStatus(K, "site.slope_pct")) === J({ status: "unknown" }) && J(factStatus(K, "site.trees")) === J({ status: "unknown" }));
check("S6", "absent", J(factStatus(K, "site.neighborhood")) === J({ status: "absent" }));
check("S7", "prototype key absent", J(factStatus(K, "site.constructor")) === J({ status: "absent" }) && J(factStatus(K, "site.toString")) === J({ status: "absent" }));
check("S8", "lot_outline unconfirmed", J(factStatus(K, "site.lot_outline")) === J({ status: "unconfirmed", value: [[0, 0], [60, 0], [60, 100], [0, 100]] }));
check("S9", "known scalars", J(factStatus(K, "site.primary_living_area_sqft")) === J({ status: "known", value: 1400 }) && J(factStatus(K, "plan.kind")) === J({ status: "known", value: "adu" }) && J(factStatus(K, "plan.height_ft")) === J({ status: "known", value: 14 }));
{ const c = mod(c => { c.site.house_outline = { observations: [{ value: 1, prov: [] }, { value: 2, prov: [] }] }; });
  check("S10", "observations conflicting", J(factStatus(c, "site.house_outline")) === J({ status: "conflicting" })); }
{ const c = mod(c => { c.site.flag_lot = { status: "conflicting", value: true }; });
  check("S11", "status conflicting", J(factStatus(c, "site.flag_lot")) === J({ status: "conflicting" })); }
{ const c = mod(c => { c.site.zone_family = "single_dwelling"; });
  check("S12", "bare scalar", J(factStatus(c, "site.zone_family")) === J({ status: "known", value: "single_dwelling" })); }
{ const c = mod(c => { c.site.alley = { prov: [] }; }); const r = factStatus(c, "site.alley");
  check("S13", "entry without value", r.status === "known" && !("value" in r), J(r)); }
{ const a = factStatus(mod(c => { c.site.zone = null; }), "site.zone"), b = factStatus({}, "site.zone");
  const c1 = factStatus(mod(c => { delete c.plan; }), "plan.kind"), c2 = factStatus(K, "plan");
  check("S14", "null / empty / no plan bag are absent", [a, b, c1, c2].every(r => r.status === "absent"), J([a, b, c1, c2])); }
check("S15", "isScalarish", ["R-1", 14, false, null, ["a", "b"]].every(isScalarish) && ![[[0, 0], [1, 1]], { a: 1 }, [1, 2]].some(isScalarish));
{ const repo = loadFactRegistry(), f = loadFactRegistry(join(here, "..", "reviewer", "fixtures", "facts-registry.json"));
  check("S16", "sample registry: 51 names; the repo's registry loads", f.size === 51 && f.has("site.zone") && f.has("site.slope_pct") && f.has("plan.detached") && !f.has("site.neighborhood") &&
    repo.size > 0 && repo.has("site.zone"), `${repo.size} ${f.size}`); }
{ const empty = join(tmp, "empty.json"); writeFileSync(empty, '{"facts": []}');
  const t = (p: string) => { try { loadFactRegistry(p); return ""; } catch (e) { return (e as Error).message; } };
  const m1 = t(join(tmp, "missing.json")), m2 = t(empty);
  const junk = join(tmp, "junk.json"); writeFileSync(junk, '{"about": "x", "source_kinds": []}');
  const m3 = t(junk);
  check("S19", "a file with no registered names throws (ADV-20)", m3 === `facts registry not readable: ${junk}`, m3);
  check("S17", "unreadable registry throws", m1.startsWith("facts registry not readable: ") && m2.startsWith("facts registry not readable: "), m1 + " | " + m2); }

// S18 (ADV-22): every dot splits; a third part is ignored
check("S18", "site.zone.value reads site.zone", J(factStatus(K, "site.zone.value")) === J({ status: "known", value: "R-1" }), J(factStatus(K, "site.zone.value")));
// S20 (D4): resetFactRegistry points the cached registry at another file; a missing file throws on next use
{ resetFactRegistry(join(tmp, "nope.json")); let m = ""; try { registeredFacts(); } catch (e) { m = (e as Error).message; }
  resetFactRegistry(join(here, "..", "reviewer", "fixtures", "facts-registry.json")); const s2 = registeredFacts();
  check("S20", "resetFactRegistry", m === `facts registry not readable: ${join(tmp, "nope.json")}` && s2.size === 51, m); }
// S21 (D7): projectKindOf, the Judge's rule
check("S21", "projectKindOf", projectKindOf(K) === "detached_adu" && projectKindOf(mod(c => { c.plan.detached.value = false; })) === "attached_adu" &&
  projectKindOf(mod(c => { delete c.plan.detached; })) === "adu" && projectKindOf({}) === null, J(projectKindOf(K)));

rmSync(tmp, { recursive: true, force: true });
console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
