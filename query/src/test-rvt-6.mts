// RVT-6: the hold, delivery and the merge (RVS-11, RVS-12). Frozen acceptance test (kit). The outcomes come from the
// fixtures (outcome-hold, outcome-partial, outcome-not-run), so this card needs nothing from RVT-5's tests.
//   npx tsx src/test-rvt-6.mts      (from query/)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { canonicalJson, makeUuid7, sha256Hex } from "./events.mts";
import { loadRubric, loadPeople, buildReviewItems, review, mergeReview, resolutionValid, deliveryAllowed, deliveryAllowedForRun, recordResolution, resetFactRegistry } from "./reviewer.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(readFileSync(join(here, "..", "reviewer", "fixtures", f), "utf8"));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const J = (x: unknown) => JSON.stringify(x);
resetFactRegistry(join(here, "..", "reviewer", "fixtures", "facts-registry.json"));
const rubric = loadRubric(); const people = loadPeople();
const run = { thread_id: "019a4a00-0000-7000-8000-000000000001", graph_load_id: "94ee5cce@file-graph", config_hash: "a".repeat(64), as_of: "2026-11-15" };
const K = fx("case-sample.json"); const P = structuredClone(K); P.site.zone.status = "unconfirmed";
const T = "019a4a00-0000-7000-8000-0000000000aa";
const repRaw = fx("report-fits.json");
const PLANNER = "accounts/fireworks/models/muse-spark-open";

(async () => {
  const rep = C.Report.parse(repRaw);
  const h1 = { outcome: C.ReviewOutcome.parse(fx("outcome-hold.json")) };
  const held = mergeReview(rep, h1.outcome, true);
  const heldBefore = canonicalJson(held);
  const flagId = h1.outcome.flags[0]!.flag_id;
  const res = (by: string, note: string, x: { action?: string; on_behalf_of?: string | null; thread?: string } = {}) => C.LotFitEvent.parse({
    id: makeUuid7(), thread_id: x.thread ?? T, session_id: null, turn_id: null, seq: 1, created_at: "2026-11-03T12:00:00.000Z", config_hash: "a".repeat(64), graph_load_id: "g",
    type: "lotfit.flag_resolved", data: { flag_id: flagId, by, role: "owner", when: "2026-11-03T12:00:00.000Z", action: x.action ?? "dismissed", note, fork_thread_id: null, on_behalf_of: x.on_behalf_of ?? null } }) as any;
  const del = (evs: any[]) => deliveryAllowed(held, evs, people, T);

  { const d = del([]); check("T8.1", "no events: held", d.allowed === false && J(d.open) === J([flagId]) && d.reviewed === "yes", J(d)); }
  { const e = res("cc", "looks fine"); const v = resolutionValid(e, people);
    check("T8.2", "agent alone refused", !v.ok && v.why === "cc is not a named person on reviewer/people.json and names no one on it in on_behalf_of" && del([e]).allowed === false, v.why); }
  { const e = res("Martin Fabbri", "neighborhood checked on the city map: none of the three"); const v = resolutionValid(e, people); const d = del([e]);
    check("T8.3", "named person closes", d.allowed && d.open.length === 0 && v.ok && v.why === "named person", J([d, v])); }
  { const d = del([res(" Martin Fabbri ", "x")]); check("T8.3b", "candidate trimmed", d.allowed, J(d)); }
  { const e = res("cc", "chat 2026-11-03", { on_behalf_of: "Martin Fabbri" }); const v = resolutionValid(e, people);
    check("T8.4", "agent on delegation", del([e]).allowed && v.why === "agent on Martin Fabbri's delegation", v.why); }
  { const d = del([res("cc", "NOT on Martin Fabbri's delegation; he has not reviewed this")]); check("T8.6", "note grants nothing", d.allowed === false, J(d)); }
  { const e1 = res("Martin Fabbri", "lot line fixed", { action: "fact_corrected" }), e2 = res("Martin Fabbri", "again", { action: "rerun_requested" });
    check("T8.7", "forks never close", resolutionValid(e1, people).why === "fact_corrected forks a new run (B6); this report stays held until the flag is dismissed" && !del([e1]).allowed && !del([e2]).allowed && !resolutionValid(e2, people).ok); }
  { const d = del([res("Martin Fabbri", "ok", { thread: "019a4a00-0000-7000-8000-0000000000bb" })]); check("T8.8", "other thread ignored", d.allowed === false, J(d)); }
  { const d = del([res("martin fabbri", "ok")]); check("T8.9", "case matters", d.allowed === false, J(d)); }
  { const a = deliveryAllowed(rep, [], people, T), b = del([]);
    check("T8.10", "no reviewer / reviewed yes", J(a) === J({ allowed: true, open: [], reviewed: "no" }) && b.reviewed === "yes", J([a, b])); }
  { const outP = { outcome: C.ReviewOutcome.parse(fx("outcome-partial.json")) };
    const d = deliveryAllowed(mergeReview(rep, outP.outcome, true), [], people, T);
    check("T8.10b", "partial review", d.allowed === false && d.reviewed === "partly", J([outP.outcome.status, d])); }
  { const out = { outcome: C.ReviewOutcome.parse(fx("outcome-not-run.json")) }; const d = deliveryAllowed(mergeReview(rep, out.outcome, true), [], people, T);
    check("T8.10c", "not_run review", J(d) === J({ allowed: true, open: [], reviewed: "no" }), J(d)); }
  // T8.11 (D9): deliveryAllowed recomputes the held flags; a hand-built FITS report claiming hold false is still refused
  { const forged: any = structuredClone(held); forged.reviewer.hold = false; const d = deliveryAllowed(forged, [], people, T);
    check("T8.11", "stored hold:false never releases a holding flag on FITS", d.allowed === false && J(d.open) === J([flagId]), J(d)); }
  { const nc: any = { ...structuredClone(held), verdict: "NEEDS_CHECK" }; nc.reviewer.hold = false;
    check("T8.11b", "the same flag on NEEDS_CHECK does not hold", deliveryAllowed(nc, [], people, T).allowed === true); }
  check("T8.5", "held report unchanged by every call", canonicalJson(held) === heldBefore);

  // D10: the run-folder entry points. A run folder = events.jsonl + report.json, with an artifact_written for report.json.
  { const dir = mkdtempSync(join(tmpdir(), "rvt6-run-")); const RT = "019a4a00-0000-7000-8000-0000000000cc";
    const text = JSON.stringify(held, null, 2) + "\n"; writeFileSync(join(dir, "report.json"), text);
    const ev = C.LotFitEvent.parse({ id: makeUuid7(), thread_id: RT, session_id: null, turn_id: null, seq: 0, created_at: "2026-11-03T12:00:00.000Z",
      config_hash: "a".repeat(64), graph_load_id: "g", type: "artifact_written", data: { artifact: { artifact_id: makeUuid7(), path: "report.json", version: 1,
        sha256: sha256Hex(text), created_at: "2026-11-03T12:00:00.000Z", size_bytes: Buffer.byteLength(text), scope: "case" } } });
    writeFileSync(join(dir, "events.jsonl"), JSON.stringify(ev) + "\n");
    const d1 = deliveryAllowedForRun(dir, people);
    check("T8.12", "run folder: held", d1.allowed === false && J(d1.open) === J([flagId]) && d1.reviewed === "yes" && d1.why === "1 held flag(s) open", J(d1));
    const thr = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
    const base = { flag_id: flagId, by: "cc", role: "agent", action: "dismissed" as const, note: "checked" };
    check("T8.13", "recordResolution refuses an unnamed agent", thr(() => recordResolution(dir, base, people)) === "cc is not a named person on reviewer/people.json and names no one on it in on_behalf_of");
    check("T8.14", "recordResolution refuses a flag not in this run", thr(() => recordResolution(dir, { ...base, by: "Martin Fabbri", flag_id: "019a4a00-0000-7000-8000-0000000000ff" }, people)) === "flag 019a4a00-0000-7000-8000-0000000000ff is not in this run's review");
    const fc = recordResolution(dir, { ...base, by: "Martin Fabbri", role: "owner", action: "fact_corrected", note: "zone confirmed on the city map" }, people, "2026-11-03T13:00:00.000Z");
    check("T8.15", "a fork reason is recorded in the run's thread, and the report stays held", fc.thread_id === RT && fc.seq === 1 && deliveryAllowedForRun(dir, people).allowed === false, J(fc));
    const ds = recordResolution(dir, { ...base, by: "cc", on_behalf_of: "Martin Fabbri", note: "chat 2026-11-03" }, people, "2026-11-03T13:05:00.000Z");
    const d2 = deliveryAllowedForRun(dir, people);
    check("T8.16", "a dismissal on Martin's delegation releases it", ds.seq === 2 && d2.allowed === true && d2.why === "no open hold" && readFileSync(join(dir, "report.json"), "utf8") === text, J(d2));
    writeFileSync(join(dir, "report.json"), text.replace('"hold": true', '"hold": false'));
    const d3 = deliveryAllowedForRun(dir, people);
    check("T8.17", "an edited report.json is refused", d3.allowed === false && d3.why === "report.json is not the file this run wrote", J(d3));
    { let msg = ""; try { recordResolution(dir, { flag_id: flagId, by: "Martin Fabbri", role: "owner", action: "dismissed", note: "ok" }, people); } catch (e) { msg = (e as Error).message; }
      check("T8.18", "no dismissal is recorded against an edited report.json", msg === "report.json is not the file this run wrote", msg); }
    rmSync(dir, { recursive: true, force: true }); }

  // RVS-12
  const strip = (x: any) => { const c = JSON.parse(JSON.stringify(x)); delete c.reviewer; delete c.telemetry?.models?.reviewer; return canonicalJson(c); };
  const repBefore = canonicalJson(rep);
  const o = h1.outcome;
  { const m = mergeReview(rep, o, true);
    check("T2.1", "merge changes only review fields", strip(m) === strip(rep) && m.verdict === rep.verdict && m.verdict === "FITS" && m.banner === rep.banner && m.telemetry.models["reviewer"] === "muse-spark-1.3", m.telemetry.models["reviewer"]); }
  { const nr = (await review({ items: [], client: null, plannerModel: PLANNER, verdict: "FITS", kase: {}, rubric })).outcome; const m = mergeReview(rep, nr, false);
    check("T2.1b", "no client: no models.reviewer", m.telemetry.models["reviewer"] === undefined && m.reviewer?.status === "not_run" && strip(m) === strip(rep)); }
  check("T2.1c", "input report not mutated", canonicalJson(rep) === repBefore);

  console.log(`${ok}/${n} checks passed`);
  process.exit(ok === n ? 0 : 1);
})();
