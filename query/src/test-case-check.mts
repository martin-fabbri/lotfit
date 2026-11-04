// Case-check coverage (handout step 3): hash stability, the expected-hash refusal, the five computed
// facts for s1 (values, computed provenance, tolerance), shoelace agreement, and the refusal paths the
// copied gate test does not pin down. No Aura needed. Muse, 2026-11-04.
import { readFileSync } from "node:fs";
import { checkCase } from "./case-gate.mts";
import * as C from "./types.mts";

let n = 0, t = 0;
const ok = (name: string, cond: boolean, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };

const readJson = (rel: string): Record<string, any> => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const s1 = readJson("../cases/s1.json");
const refusals: unknown[] = [];
const accepted: unknown[] = [];

const r1 = checkCase(structuredClone(s1));
const r2 = checkCase(structuredClone(s1));
if (!("refused" in r1)) accepted.push(r1.case);
ok("the same case gives the same case_hash twice",
  !("refused" in r1) && !("refused" in r2) && r1.case_hash === r2.case_hash && C.Sha256.safeParse("refused" in r1 ? "" : r1.case_hash).success,
  "refused" in r1 ? r1.message : ("refused" in r2 ? r2.message : `${r1.case_hash.slice(0, 12)} vs ${r2.case_hash.slice(0, 12)}`));

const mutated = structuredClone(s1);
mutated.plan.height_ft.value = 16;
const rm = checkCase(mutated);
if (!("refused" in rm)) accepted.push(rm.case);
ok("changing one fact value changes the case_hash",
  !("refused" in r1) && !("refused" in rm) && rm.case_hash !== r1.case_hash,
  "refused" in rm ? rm.message : "hash unchanged");

const wrong = checkCase(structuredClone(s1), { expected_case_hash: "0".repeat(64) });
if ("refused" in wrong) refusals.push(wrong);
ok("expected_case_hash set to a wrong value is refused (I10)",
  "refused" in wrong && wrong.invariant === "I10" && wrong.path === "case_hash",
  "refused" in wrong ? `[${wrong.invariant}] at ${wrong.path}` : "accepted");

const right = !("refused" in r1) ? checkCase(structuredClone(s1), { expected_case_hash: r1.case_hash }) : null;
if (right && !("refused" in right)) accepted.push(right.case);
ok("the correct expected_case_hash is accepted",
  right !== null && !("refused" in right), right && "refused" in right ? right.message : "");

if (!("refused" in r1)) {
  for (const name of C.COMPUTED_FACTS) {
    const entry = r1.computed[name] as { value?: unknown; prov?: { kind?: string; tolerance?: unknown }[] } | undefined;
    const good = entry !== undefined && "value" in entry && entry.prov?.[0]?.kind === "computed" && entry.prov[0].tolerance !== undefined;
    ok(`s1 computed fact ${name} exists with computed provenance and a tolerance`, good, good ? "" : JSON.stringify(entry)?.slice(0, 160));
  }
  const area = r1.computed["site.lot_area_sqft"] as { value?: unknown } | undefined;
  const outline = (s1.site.lot_outline as { value: [number, number][] }).value;
  let shoelace = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x1, y1] = outline[i]!, [x2, y2] = outline[(i + 1) % outline.length]!;
    shoelace += x1 * y2 - x2 * y1;
  }
  shoelace = Math.abs(shoelace) / 2;
  const areaVal = typeof area?.value === "number" ? area.value : NaN;
  ok("site.lot_area_sqft equals the shoelace area of lot_outline (to 0.01 sq ft)",
    Math.abs(areaVal - shoelace) <= 0.01, `area ${areaVal}, shoelace ${shoelace}`);
} else {
  ok("s1 computed facts (skipped: s1 refused)", false, r1.message);
}

const BOGUS = "plan.rocket_pad";
const registry = readJson("../../graph/curated/facts.json");
const registered: string[] = (registry.facts as { name: string }[]).map((f) => f.name);
ok(`${BOGUS} is really absent from facts.json`, !registered.includes(BOGUS));
const bogusCase = structuredClone(s1);
bogusCase.plan.rocket_pad = { value: true, prov: [] };
const rb = checkCase(bogusCase);
if ("refused" in rb) refusals.push(rb);
ok("a fact name not in facts.json is refused (I4)",
  "refused" in rb && rb.invariant === "I4" && rb.path === BOGUS,
  "refused" in rb ? `[${rb.invariant}] at ${rb.path}` : "accepted");

const noAsOf = structuredClone(s1) as Record<string, unknown>;
delete noAsOf.as_of;
const ra = checkCase(noAsOf);
if ("refused" in ra) refusals.push(ra);
ok("a case whose as_of date is missing is refused (I2)",
  "refused" in ra && ra.invariant === "I2",
  "refused" in ra ? `[${ra.invariant}] at ${ra.path}` : "accepted");

for (const f of ["s2", "s3", "s4", "s5", "s7"]) {
  const r = checkCase(readJson(`../cases/${f}.json`));
  if (!("refused" in r)) accepted.push(r.case); else refusals.push(r);
}
for (const f of ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9", "i10", "i11", "i12"]) {
  const r = checkCase(readJson(`../cases/invalid/${f}.json`));
  if ("refused" in r) refusals.push(r); else accepted.push(r.case);
}
ok(`every refusal (${refusals.length}) parses as CaseRefusal`, refusals.every((r) => C.CaseRefusal.safeParse(r).success));
ok(`every accepted case (${accepted.length}) parses as Case`, accepted.every((c) => C.Case.safeParse(c).success));

console.log(`${n}/${t} checks passed`);
process.exit(n === t ? 0 : 1);
