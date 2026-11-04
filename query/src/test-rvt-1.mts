// RVT-1: contracts and sample data for the Reviewer (RVS-01, RVS-02). Frozen acceptance test (kit).
//   npx tsx src/test-rvt-1.mts      (from query/)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { canonicalJson, sha256Hex, makeUuid7 } from "./events.mts";

const here = dirname(fileURLToPath(import.meta.url));
const qroot = join(here, "..");
const fx = (f: string) => JSON.parse(readFileSync(join(qroot, "reviewer", "fixtures", f), "utf8"));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const errs = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.success ? "" : r.error!.issues.map(i => i.message).join("; ");

// H1
{ const a = fx("index-entries.json") as unknown[]; const rs = a.map(x => C.IndexEntry.safeParse(x));
  check("H1", "index entries parse", a.length === 3 && rs.every(r => r.success), rs.map(errs).join(" | ")); }
// H2
{ const a = fx("rule-families.json") as unknown[]; const rs = a.map(x => C.RuleFamily.safeParse(x));
  check("H2", "rule families parse", a.length === 3 && rs.every(r => r.success), rs.map(errs).join(" | ")); }
// H3
{ const a = fx("events-sample.json") as any[]; const rs = a.map(x => C.LotFitEvent.safeParse(x));
  check("H3", "events parse", a.length === 3 && rs.every(r => r.success) && a.every(e => e.type === "lotfit.exclusion_recorded"), rs.map(errs).join(" | ")); }
// H4
{ const base = fx("case-sample.json"); const planted = structuredClone(base); planted.site.zone.status = "unconfirmed";
  const bad: string[] = [];
  for (const [label, c] of [["case-sample", base], ["planted", planted]] as const)
    for (const sc of ["site", "plan"]) for (const [k, v] of Object.entries(c[sc])) if (!C.FactEntry.safeParse(v).success) bad.push(`${label} ${sc}.${k}`);
  for (const u of base.unknowns) if (!C.FactName.safeParse(u.fact).success) bad.push(`unknown ${u.fact}`);
  check("H4", "fact entries and unknowns parse", bad.length === 0, bad.join(", ")); }
// H5
{ const got = canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }); const want = '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}';
  check("H5", "canonicalJson sorts keys", got === want, got); }
// H6
{ const got = sha256Hex("abc"); check("H6", "sha256Hex abc", got === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", got); }
// H7
{ const u = makeUuid7(); check("H7", "makeUuid7 is a Uuid7", C.Uuid7.safeParse(u).success, u); }
// H8
{ const fam = (fx("rule-families.json") as any[]).find(f => f.provision_id === "EUG.9.2751.17.c");
  const cl = fam?.clauses ?? []; const s3 = cl.find((c: any) => c.clause_id === "EUG.9.2751.17.c#v1::sentence:3");
  const g = s3?.guards?.[0];
  check("H8", "17.c family shape", cl.length === 4 && g?.fact === "site.zone" && g?.op === "in" && JSON.stringify(g?.value) === '["R-1"]' && JSON.stringify(s3.needs) === '["site.zone"]'); }

// T1
const O = fx("outcome-hold.json"); const F = O.flags[0];
const planted = F.item_sha256;
const A = { item_sha256: planted, answer: "unclear", category: "exclusion_on_unknown_fact", quote: "within the city-recognized boundaries of Amazon Neighbors",
  fact: "site.zone", fact_claim: "unconfirmed", claim: "x" };
const oc = (x: unknown) => C.ReviewOutcome.safeParse(x);
const ac = (x: unknown) => C.ReviewerAnswer.safeParse(x);
{ const r = oc(O); check("T1.1", "outcome-hold parses", r.success, errs(r)); }
check("T1.2", "clean with flags refused", !oc({ ...O, status: "clean" }).success);
check("T1.3", "not_run with flags/hold refused", !oc({ ...O, status: "not_run", flags: [], hold: false, error: null }).success);
check("T1.4", "hold without confirmed flag refused", !oc({ ...O, flags: [{ ...F, confirmed: false }] }).success);
check("T1.4b", "partial with answered == items refused", !oc({ ...O, status: "partial", answered: 1 }).success);
{ const r = oc({ ...O, status: "not_run", answered: 0, flags: [], hold: false, error: { category: "model", message: "x" } }); check("T1.4c", "not_run with error accepted", r.success, errs(r)); }
{ const rep = fx("report-fits.json");
  const r1 = C.Report.safeParse(rep); const r2 = C.Report.safeParse({ ...rep, reviewer: O });
  check("T1.5", "FITS report parses with and without reviewer", r1.success && (r1 as any).data.reviewer === undefined && r2.success, errs(r1 as any) + errs(r2 as any));
  const r3 = C.Report.safeParse({ ...rep, verdict: "NEEDS_CHECK", reviewer: O });
  check("T1.6", "hold on NEEDS_CHECK refused", !r3.success && errs(r3 as any).includes("a hold applies only to FITS or FITS_IF (L42)"), errs(r3 as any));
  // D9: and the other way: a FITS (or FITS_IF) carrying a confirmed high hold_if_fits flag with hold false is refused
  const r4 = C.Report.safeParse({ ...rep, reviewer: { ...O, hold: false } }), r5 = C.Report.safeParse({ ...rep, verdict: "FITS_IF", reviewer: { ...O, hold: false } });
  const msg = "a FITS or FITS_IF with a confirmed high flag routed to hold must be held (L42)";
  check("T1.9", "unheld FITS with a holding flag refused", !r4.success && errs(r4 as any).includes(msg) && !r5.success && errs(r5 as any).includes(msg), errs(r4 as any));
  const r6 = C.Report.safeParse({ ...rep, verdict: "NEEDS_CHECK", reviewer: { ...O, hold: false } });
  check("T1.10", "the same flag unheld on NEEDS_CHECK parses", r6.success, errs(r6 as any)); }
// the RVT-6 fixtures parse too
for (const f of ["outcome-partial.json", "outcome-not-run.json"]) { const r = oc(fx(f)); check(`T1.11.${f}`, `${f} parses`, r.success, errs(r)); }
{ const r = ac(A), r2 = ac({ ...A, answer: "unclear", category: null }); check("T1.7", "answer parses", r.success && r2.success, errs(r) + errs(r2)); }
{ const bad = [{ ...A, answer: "sound" }, { ...A, answer: "unsound", category: null }, { ...A, fact: null }, { ...A, claim: "x".repeat(301) }, { ...A, verdict: "FITS" }];
  const got = bad.map(b => !ac(b).success); check("T1.8", "bad answers refused", got.every(Boolean), JSON.stringify(got)); }

console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
