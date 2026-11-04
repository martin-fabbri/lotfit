/**
 * The Reviewer's tests T1–T9 (CONTRACT-REVIEWER.md §8; EN-24; L42). Scripted model only: no network, no credits.
 * The real item is Eugene's 17.c (Amazon / Fairmount / South University neighborhoods) on Martin's lot, the exclusion
 * the panel confirmed rests on a fact the case does not hold. Expected values are written before the run. CC, 2026-11-03.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./types.mts";
import { canonicalJson, makeUuid7 } from "./events.mts";
import { createFileGraphReader } from "./graph-reads.mts";
import { compileTrace } from "./compile-trace.mts";
import { ScriptedReviewerClient } from "./reviewer-client.mts";
import { buildReviewItems, canonicalModel, deliveryAllowed, judgeAnswer, loadPeople, loadRubric, mergeReview, review } from "./reviewer.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(readFileSync(path.join(here, "..", "contracts", "fixtures", "valid", f), "utf8"));
let n = 0, ok = 0;
function check(name: string, cond: boolean, detail = ""): void {
  n++; if (cond) { ok++; console.log(`PASS  ${name}`); } else console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}
const rubric = loadRubric(), people = loadPeople();
const PLANNER = "accounts/fireworks/models/muse-spark-open";
const EUG = JSON.parse(readFileSync(path.join(here, "..", "cases", "eug-demo-16x36.json"), "utf8"));
const EUG_KNOWN = structuredClone(EUG); // the case as recorded: zone known
// Planted: the zone is unconfirmed, so 17.c (whose only guard reads site.zone) has a rule fact the case does not hold.
EUG.site.zone = { ...EUG.site.zone, status: "unconfirmed" };
const reader = createFileGraphReader();
const idx = await reader.readLayerIndex({ city_layer: "EUG", as_of: EUG.as_of.date });
const index = new Map(idx.layers.flatMap((l) => l.provisions).map((p) => [p.provision_id, p]));
const PID = "EUG.9.2751.17.c", DEF = [...index.values()].find((p) => p.evaluation_stage === "definition")!.provision_id;
const fams = new Map((await reader.readRuleFamily({ provision_ids: [PID, DEF, "EUG.9.2751.17.a.4"], as_of: EUG.as_of.date })).map((f) => [f.provision_id, f]));
const ev = (pid: string, basis: string) => C.LotFitEvent.parse({ id: makeUuid7(), thread_id: makeUuid7(), session_id: null, turn_id: makeUuid7(), seq: 1,
  created_at: new Date().toISOString(), config_hash: "a".repeat(64), graph_load_id: idx.graph_load_id, type: "lotfit.exclusion_recorded",
  data: { provision_id: pid, basis, guard_call_id: null, guard_result: null, through: null, scope_clause_id: index.get(pid)!.scope.scope_clause_id, scope_quote: index.get(pid)!.scope.scope_quote } });
const run = { thread_id: makeUuid7(), graph_load_id: idx.graph_load_id, config_hash: "a".repeat(64), as_of: EUG.as_of.date };
const items = buildReviewItems({ events: [ev(PID, "planner_reading"), ev(DEF, "planner_reading"), ev("EUG.9.2751.17.a.4", "computed_known_false")], index, ruleFamilies: fams, kase: EUG, run, rubric });
const item = items[0]!;
// Two reviewed items, for partial reviews (build-review A2/S5).
const items2 = buildReviewItems({ events: [ev(PID, "planner_reading"), ev("EUG.9.2751.17.a.4", "planner_reading")], index, ruleFamilies: fams, kase: EUG, run, rubric });
const ans = (o: Record<string, unknown>) => JSON.stringify({ item_sha256: item.item_sha256, answer: "unclear", category: "exclusion_on_unknown_fact",
  quote: "within the city-recognized boundaries of Amazon Neighbors", fact: "site.neighborhood", fact_claim: "absent",
  claim: "Whether 17.c applies turns on the lot's neighborhood, which the case does not hold.", ...o });

// ---- T9 items: only reading-only exclusions of reviewed stages; deterministic
check("T9.1 one item: 17.c (the definition and the computed exclusion are not reviewed)", items.length === 1 && item.provision.provision_id === PID, JSON.stringify(items.map((i) => i.provision.provision_id)));
const again = buildReviewItems({ events: [ev(PID, "planner_reading")], index, ruleFamilies: fams, kase: EUG, run, rubric });
check("T9.2 same run → same item_sha256", again[0]?.item_sha256 === item.item_sha256);
check("T9.3 the item carries title, section and the case's status for the neighborhood (absent)",
  /Amazon/.test(item.provision.title) && !!item.provision.section && !item.case_facts.some((f) => f.fact === "site.neighborhood"),
  JSON.stringify(item.provision));
check("T9.4 no geometry in the item (facts by handle, §5)", !item.case_facts.some((f) => Array.isArray(f.value) && (f.value as unknown[]).some((x) => Array.isArray(x))));

check("T9.5 the item records whether its text was cut (S19)", item.text_truncated === false);

// ---- T5 validation
const j = (raw: string) => judgeAnswer(raw, item, EUG, rubric);
// A fact the item lists (site.slope_pct, unknown in the case): the flag can be confirmed.
const HOLDABLE = { fact: "site.zone", fact_claim: "unconfirmed" };
const good = j(ans(HOLDABLE));
check("T5.0 a well-formed, true answer on a fact the item lists becomes a confirmed flag", !!good.flag && good.flag.confirmed && good.rejected.length === 0, JSON.stringify(good));
const unreg = j(ans({}));
check("T5.0b on an absent fact neither the item nor the registry knows (site.neighborhood) → kept, not confirmed, with a warning (A4/S6)",
  !!unreg.flag && !unreg.flag.confirmed && (unreg.warnings ?? []).some((w) => /registry/.test(w)), JSON.stringify(unreg));
const offRule = j(ans({ fact: "site.slope_pct", fact_claim: "unknown" }));
check("T5.0d an unsettled fact the rule's guards do not read (site.slope_pct) → kept, not confirmed (R2-1)", !!offRule.flag && !offRule.flag.confirmed, JSON.stringify(offRule.flag));
check("T5.0c an invented fact claimed known (prototype key site.constructor) → fact_claim_false (A4)", j(ans({ fact: "site.constructor", fact_claim: "known" })).rejected[0]?.reason === "fact_claim_false");
check("T5.1 quote not in the item → quote_not_in_item", j(ans({ quote: "this sentence is nowhere in the rule text at all" })).rejected[0]?.reason === "quote_not_in_item");
check("T5.2 quote too short → quote_not_in_item", j(ans({ quote: "Amazon" })).rejected[0]?.reason === "quote_not_in_item");
check("T5.3 fact claim contradicting the case → fact_claim_false", j(ans({ fact: "site.flag_lot", fact_claim: "unknown" })).rejected[0]?.reason === "fact_claim_false");
check("T5.4 a disabled category → category_disabled", j(ans({ category: "wrong_parameter", answer: "unsound" })).rejected[0]?.reason === "category_disabled");
check("T5.5 not JSON → bad_schema", j("I think this is fine.").rejected[0]?.reason === "bad_schema");
const badSha = j(ans({ ...HOLDABLE, item_sha256: "b".repeat(64) }));
check("T5.6 wrong item hash → bound by call, judged, with a warning (S3)", !!badSha.flag && (badSha.warnings ?? []).some((w) => /item_sha256/.test(w)));
// A sound answer rests on a fact the rule's guards read (17.c: site.zone) that the case holds (the recorded case: known).
const SOUND = { answer: "sound", category: null, fact: "site.zone", fact_claim: "known", quote: "Area-specific accessory dwelling standards" };
const jk = (raw: string) => judgeAnswer(raw, item, EUG_KNOWN, rubric);
check("T5.7 sound on a rule fact the case holds → listed sound, no flag", jk(ans(SOUND)).sound === PID, JSON.stringify(jk(ans(SOUND))));
check("T5.7b sound on a fact the rule does not read (plan.detached) → rejected (R2 B6)", jk(ans({ ...SOUND, fact: "plan.detached", fact_claim: "true" })).rejected[0]?.reason === "fact_claim_false");
check("T5.8 sound with a 1-character quote → quote_not_in_item (A5/S13)", jk(ans({ ...SOUND, quote: "A" })).rejected[0]?.reason === "quote_not_in_item");
check("T5.9 sound with a wrong fact claim → fact_claim_false (A5)", jk(ans({ ...SOUND, fact_claim: "unknown" })).rejected[0]?.reason === "fact_claim_false");
check("T5.10 sound resting on no fact → rejected (A5)", jk(ans({ ...SOUND, fact: null, fact_claim: null })).rejected[0]?.reason === "fact_claim_false");
check("T5.11 an unsound quote from the title only → quote_not_in_item (A16)", j(ans({ ...HOLDABLE, answer: "unsound", category: "wrong_exclusion", quote: "(Amazon, Fairmount, South University)" })).rejected[0]?.reason === "quote_not_in_item");
check("T5.12 quote differing only in case and hyphenation → accepted (A16)", !!j(ans({ ...HOLDABLE, quote: "Within The City Recognized-Boundaries of Amazon Neighbors".replace("City Recognized-", "city - recognized ") })).flag);
const longClaim = j(ans({ ...HOLDABLE, claim: "x".repeat(400) }));
check("T5.13 an over-long claim is cut, not rejected (S15)", !!longClaim.flag && longClaim.flag.claim.length === 300);

// ---- T3 authority
const t3 = j(ans({ verdict: "FITS", outcome: "pass", severity: "low" }));
check("T3 keys outside the answer are dropped as out_of_authority; the answer is still judged; severity comes from code",
  t3.rejected.filter((r) => r.reason === "out_of_authority").length === 3 && t3.flag?.severity === "high", JSON.stringify(t3));

// ---- T4 different model
check("T4.1 canonical model: Fireworks and Baseten Muse Spark Open are the same", canonicalModel(PLANNER) === canonicalModel("meta-models/muse-spark-open-1026"));
check("T4.2 contributor endpoint = same weights", canonicalModel("muse-spark-1.3-contributor") === canonicalModel("muse-spark-1.3"));
check("T4.2b 1p3 and :standard spell the same model (A17)", canonicalModel("accounts/fireworks/models/muse-spark-1p3") === "muse-spark-1.3" && canonicalModel("meta/muse-spark-1.3:standard") === "muse-spark-1.3");
const same = await review({ items, client: new ScriptedReviewerClient("meta-models/muse-spark-open-1026", () => ans({})), plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric });
check("T4.3 a Reviewer on the Planner's model is refused (not_run, harness)", same.outcome.status === "not_run" && same.outcome.error?.category === "harness" && same.calls.length === 0);

// ---- T6 outages and malformed answers
const none = await review({ items, client: null, plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric });
check("T6.1 no Reviewer configured → not_run with its reason, no hold", none.outcome.status === "not_run" && !none.outcome.hold && /no Reviewer configured/.test(none.outcome.error!.message));
const down = await review({ items, client: new ScriptedReviewerClient("muse-spark-1.3", () => { throw new Error("503 upstream"); }), plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric });
check("T6.2 provider error on every item → not_run (model), no hold", down.outcome.status === "not_run" && down.outcome.error?.category === "model" && !down.outcome.hold, JSON.stringify(down.outcome.error));
const junkClient = new ScriptedReviewerClient("muse-spark-1.3", () => "not json");
const junk = await review({ items, client: junkClient, plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric });
check("T6.3 non-JSON → one retry, then not_run (model), both rejections recorded, no hold (contract T6; A2/S2)", junkClient.calls === 2 && junk.outcome.rejected.length === 2 && junk.outcome.rejected.every((x) => x.reason === "bad_schema") && junk.outcome.status === "not_run" && junk.outcome.error?.category === "model" && !junk.outcome.hold, JSON.stringify(junk.outcome));
const fixClient = new ScriptedReviewerClient("muse-spark-1.3", (_i, attempt) => (attempt === 1 ? "oops" : ans(HOLDABLE)));
const fixed = await review({ items, client: fixClient, plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric });
check("T6.4 a malformed first reply repaired on the retry is accepted; the first rejection stays on the record (S14)", fixed.outcome.flags.length === 1 && fixClient.calls === 2 && fixed.outcome.rejected.length === 1);
const allBadQuote = await review({ items, client: new ScriptedReviewerClient("muse-spark-1.3", () => ans({ quote: "this sentence is nowhere in the rule text at all" })), plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric });
check("T6.5 every answer rejected → not_run, never clean (A2)", allBadQuote.outcome.status === "not_run" && allBadQuote.outcome.answered === 0);
const half = await review({ items: items2, client: new ScriptedReviewerClient("muse-spark-1.3", (it) => { if (it.provision.provision_id !== PID) throw new Error("timeout"); return ans({ ...HOLDABLE, item_sha256: it.item_sha256 }); }), plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric });
check("T6.6 one item answered, one not → partial, answered 1 of 2; the confirmed high flag still holds (A2/S5)",
  items2.length === 2 && half.outcome.status === "partial" && half.outcome.answered === 1 && half.outcome.hold, JSON.stringify({ n: items2.length, s: half.outcome.status, a: half.outcome.answered, h: half.outcome.hold }));
const hang = new ScriptedReviewerClient("muse-spark-1.3", () => new Promise<string>(() => {}));
const t0 = Date.now();
const hung = await review({ items, client: hang, plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric, timeoutMs: 100, deadlineMs: 300 });
check("T6.7 a client that never answers is cut at the review deadline → not_run (A18/S9)", hung.outcome.status === "not_run" && Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
const flaky = new ScriptedReviewerClient("muse-spark-1.3", (_i, attempt) => { if (attempt === 1) throw new Error("429 rate limited"); return ans(HOLDABLE); });
const fl = await review({ items, client: flaky, plannerModel: PLANNER, verdict: "FITS", kase: EUG, rubric });
check("T6.8 a provider error is retried once (S16)", fl.outcome.flags.length === 1 && flaky.calls === 2);

// ---- T7 the hold (L42)
const r = (verdict: "FITS" | "NEEDS_CHECK", raw: string) => review({ items, client: new ScriptedReviewerClient("muse-spark-1.3", () => raw), plannerModel: PLANNER, verdict, kase: EUG, rubric });
const h1 = await r("FITS", ans(HOLDABLE));
check("T7.1 confirmed high flag on FITS → hold", h1.outcome.hold && h1.outcome.flags[0]?.severity === "high" && h1.outcome.flags[0]?.route === "hold_if_fits");
const h2 = await r("NEEDS_CHECK", ans(HOLDABLE));
const h1u = await r("FITS", ans({}));
check("T7.0 a high flag resting on an unregistered absent fact never holds (A4/S6)", !h1u.outcome.hold && h1u.outcome.flags[0]?.confirmed === false);
check("T7.2 the same flag on NEEDS_CHECK → no hold (attached to the review it already needs)", !h2.outcome.hold && h2.outcome.status === "flagged");
const h3 = await r("FITS", ans({ category: "scope_sentence_not_scope", fact: null, fact_claim: null }));
check("T7.3 scope_sentence_not_scope → low, Rulebook queue, never a hold", !h3.outcome.hold && h3.outcome.flags[0]?.severity === "low" && h3.outcome.flags[0]?.route === "rulebook_queue");
const h4 = await r("FITS", ans({ category: "wrong_exclusion", answer: "unsound", fact: null, fact_claim: null }));
check("T7.4 a high flag with no checkable fact is not confirmed → no hold", !h4.outcome.hold && h4.outcome.flags[0]?.confirmed === false);

// ---- T1 contract refinements
const o = h1.outcome;
check("T1.1 ReviewOutcome parses", C.ReviewOutcome.safeParse(o).success);
check("T1.2 clean with a flag is refused", !C.ReviewOutcome.safeParse({ ...o, status: "clean" }).success);
check("T1.3 not_run without an error is refused", !C.ReviewOutcome.safeParse({ ...o, status: "not_run", flags: [], hold: false, error: null }).success);
check("T1.4 a hold without a confirmed high flag is refused", !C.ReviewOutcome.safeParse({ ...o, flags: [{ ...o.flags[0]!, confirmed: false }] }).success);
const rep = C.Report.parse(fx("C7_Report.s1-fits.json"));
check("T1.5 a report without reviewer still parses (reports before 1.5.0)", rep.reviewer === undefined);
check("T1.6 a hold on a NEEDS_CHECK report is refused", !C.Report.safeParse({ ...rep, verdict: "NEEDS_CHECK", reviewer: o }).success);

// ---- T2 monotone (B2)
const merged = mergeReview(rep, o, true);
const strip = (x: any) => { const c = structuredClone(x); delete c.reviewer; delete c.telemetry.models.reviewer; return canonicalJson(c); };
check("T2.1 after review the report differs only in reviewer and telemetry.models.reviewer", strip(merged) === strip(rep) && merged.verdict === rep.verdict && merged.banner === rep.banner);
const tr = compileTrace(merged, fx("C1_Case.pdx-r5-example.json"));
check("T2.2 the trace carries no Reviewer text", !JSON.stringify(tr).includes(o.flags[0]!.claim) && !JSON.stringify(tr).includes("reviewer"));

// ---- T8 closing the hold
const held = merged;
const RUN_THREAD = makeUuid7();
const resolved = (by: string, note: string, x: { action?: string; on_behalf_of?: string | null; thread?: string } = {}) => C.LotFitEvent.parse({ id: makeUuid7(), thread_id: x.thread ?? RUN_THREAD, session_id: null, turn_id: null, seq: 9, created_at: new Date().toISOString(),
  config_hash: "a".repeat(64), graph_load_id: "x", type: "lotfit.flag_resolved",
  data: { flag_id: o.flags[0]!.flag_id, by, role: "owner", when: new Date().toISOString(), action: x.action ?? "dismissed", note, fork_thread_id: null, on_behalf_of: x.on_behalf_of ?? null } });
const da = (evs: any[]) => deliveryAllowed(held, evs, people, RUN_THREAD);
check("T8.1 with the hold open, delivery is refused", !da([]).allowed);
check("T8.2 closed by \"cc\" without delegation → still refused", !da([resolved("cc", "looks fine")]).allowed);
check("T8.3 closed by a named person → allowed", da([resolved("Martin Fabbri", "neighborhood checked on the city map: none of the three")]).allowed);
check("T8.4 closed by an agent naming the person in on_behalf_of → allowed", da([resolved("cc", "chat 2026-11-03", { on_behalf_of: "Martin Fabbri" })]).allowed);
check("T8.6 a note saying \"NOT on Martin Fabbri's delegation\" closes nothing (A3/S7)", !da([resolved("cc", "NOT on Martin Fabbri's delegation; he has not reviewed this")]).allowed);
check("T8.7 fact_corrected or rerun_requested by Martin leaves this report held (a fork, B6; A3)", !da([resolved("Martin Fabbri", "lot line fixed", { action: "fact_corrected" })]).allowed && !da([resolved("Martin Fabbri", "rerun", { action: "rerun_requested" })]).allowed);
check("T8.8 a resolution from another run's thread closes nothing (A3)", !da([resolved("Martin Fabbri", "ok", { thread: makeUuid7() })]).allowed);
check("T8.9 the name must match people.json exactly (A3)", !da([resolved("martin fabbri", "ok")]).allowed);
check("T8.10 delivery says whether a review ran (A19)", deliveryAllowed(rep, [], people, RUN_THREAD).reviewed === "no" && da([]).reviewed === "yes");
check("T8.5 resolving never edits the report", canonicalJson(held) === canonicalJson(merged));

await reader.close?.();
console.log(`${ok}/${n} reviewer checks passed`);
process.exit(ok === n ? 0 : 1);
