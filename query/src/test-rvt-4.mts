// RVT-4: judgeAnswer (RVS-08). Frozen acceptance test (kit).
//   npx tsx src/test-rvt-4.mts      (from query/)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubric, buildReviewItems, judgeAnswer, resetFactRegistry } from "./reviewer.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(readFileSync(join(here, "..", "reviewer", "fixtures", f), "utf8"));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const J = (x: unknown) => JSON.stringify(x);
resetFactRegistry(join(here, "..", "reviewer", "fixtures", "facts-registry.json"));
const rubric = loadRubric();
const run = { thread_id: "019a4a00-0000-7000-8000-000000000001", graph_load_id: "94ee5cce@file-graph", config_hash: "a".repeat(64), as_of: "2026-11-15" };
const K = fx("case-sample.json"); const P = structuredClone(K); P.site.zone.status = "unconfirmed";
const mkItems = (kase: any) => buildReviewItems({ events: fx("events-sample.json"), kase, run, rubric,
  index: new Map(fx("index-entries.json").map((x: any) => [x.provision_id, x])), ruleFamilies: new Map(fx("rule-families.json").map((x: any) => [x.provision_id, x])) })[0]!;
const item = mkItems(P), itemK = mkItems(K);
const ans = (o: Record<string, unknown> = {}, it = item) => JSON.stringify({ item_sha256: it.item_sha256, answer: "unclear", category: "exclusion_on_unknown_fact",
  quote: "within the city-recognized boundaries of Amazon Neighbors", fact: "site.neighborhood", fact_claim: "absent",
  claim: "Whether 17.c applies turns on the lot's neighborhood, which the case does not hold.", ...o });
const HOLDABLE = { fact: "site.zone", fact_claim: "unconfirmed" };
const SOUND = { item_sha256: itemK.item_sha256, answer: "sound", category: null, fact: "site.zone", fact_claim: "known", quote: "Area-specific accessory dwelling standards" };
const jp = (raw: string) => judgeAnswer(raw, item, P, rubric);
const jk = (raw: string) => judgeAnswer(raw, itemK, K, rubric);
const rej = (r: ReturnType<typeof jp>) => r.rejected.map(x => `${x.reason}|${x.detail ?? ""}`);

{ const r = jp(ans(HOLDABLE)); const f = r.flag;
  check("T5.0", "holdable flag", f?.category === "exclusion_on_unknown_fact" && f.severity === "high" && f.route === "hold_if_fits" && f.confirmed === true && J(r.rejected) === "[]" && J(r.warnings) === "[]", J(r)); }
{ const r = jp(ans()); check("T5.0b", "unregistered fact: kept, unconfirmed", !!r.flag && r.flag.confirmed === false &&
  J(r.warnings) === J(["site.neighborhood is not a fact of this item or of the facts registry; the flag is not confirmed"]), J(r)); }
{ const r = jp(ans({ fact: "site.constructor", fact_claim: "known" })); check("T5.0c", "prototype key rejected", !r.flag && J(rej(r)) === J(["fact_claim_false|site.constructor is absent in the case, not known"]), J(r)); }
{ const r = jp(ans({ fact: "site.slope_pct", fact_claim: "unknown" })); check("T5.0d", "fact not read by guards", !!r.flag && r.flag.confirmed === false &&
  J(r.warnings) === J(["site.slope_pct is not read by this rule's guards; the flag is not confirmed"]), J(r)); }
{ const r = jp(ans({ quote: "this sentence is nowhere in the rule text at all" })); check("T5.1", "quote not in item", J(rej(r)) === J(["quote_not_in_item|48 chars; an unsound or unclear quote comes from the scope sentence or the rule text"]), J(rej(r))); }
{ const r = jp(ans({ quote: "Amazon" })); check("T5.2", "short quote", r.rejected.length === 1 && r.rejected[0]!.reason === "quote_not_in_item" && r.rejected[0]!.detail!.startsWith("6 chars"), J(rej(r))); }
{ const r = jp(ans({ fact: "site.flag_lot", fact_claim: "unknown" })); check("T5.3", "false fact claim", J(rej(r)) === J(["fact_claim_false|site.flag_lot is false in the case, not unknown"]), J(rej(r))); }
{ const r = jp(ans({ category: "wrong_parameter", answer: "unsound" })); check("T5.4", "disabled category", r.rejected.length === 1 && r.rejected[0]!.reason === "category_disabled" && !("detail" in r.rejected[0]!), J(r.rejected)); }
{ const r = jp("I think this is fine."); check("T5.5", "not JSON", r.rejected.length === 1 && r.rejected[0]!.reason === "bad_schema" && r.rejected[0]!.detail === "not a JSON object" && r.rejected[0]!.raw === "I think this is fine.", J(r.rejected)); }
{ const r = jp(ans({ ...HOLDABLE, item_sha256: "b".repeat(64) })); check("T5.6", "hash echo wrong", !!r.flag && r.flag.confirmed && r.flag.item_sha256 === item.item_sha256 && J(r.warnings) === J(["item_sha256 echo does not match; bound by call"]), J(r)); }
{ const o = JSON.parse(ans(HOLDABLE)); delete o.item_sha256; const r = jp(JSON.stringify(o)); check("T5.6b", "hash echo missing", !!r.flag && J(r.warnings) === J(["item_sha256 echo missing; bound by call"]), J(r)); }
{ const r = jk(ans(SOUND, itemK)); check("T5.7", "sound accepted", r.sound === "EUG.9.2751.17.c" && !r.flag && J(r.rejected) === "[]", J(r)); }
{ const r = jk(ans({ ...SOUND, fact: "plan.detached", fact_claim: "true" }, itemK)); check("T5.7b", "sound on non-rule fact", J(rej(r)) === J(["fact_claim_false|a sound answer rests on a fact this rule's guards read (site.zone)"]) &&
  J(r.warnings) === J(["plan.detached is not read by this rule's guards; the flag is not confirmed"]), J(r)); }
{ const r = jk(ans({ ...SOUND, quote: "A" }, itemK)); check("T5.8", "sound short quote", J(rej(r)) === J(["quote_not_in_item|1 chars"]), J(rej(r))); }
{ const r = jk(ans({ ...SOUND, fact_claim: "unknown" }, itemK)); check("T5.9", "sound false claim", J(rej(r)) === J(["fact_claim_false|site.zone is known in the case, not unknown"]), J(rej(r))); }
{ const r = jk(ans({ ...SOUND, fact: null, fact_claim: null }, itemK)); check("T5.10", "sound without fact", J(rej(r)) === J(["fact_claim_false|a sound answer rests on a fact the case holds as true, false or known"]), J(rej(r))); }
{ const r = jp(ans({ ...HOLDABLE, answer: "unsound", category: "wrong_exclusion", quote: "(Amazon, Fairmount, South University)" })); check("T5.11", "title quote refused for unsound", J(rej(r)) === J(["quote_not_in_item|37 chars; an unsound or unclear quote comes from the scope sentence or the rule text"]), J(rej(r))); }
{ const r = jp(ans({ ...HOLDABLE, quote: "Within The city - recognized Boundaries of Amazon Neighbors" })); check("T5.12", "quote normalised", !!r.flag && r.rejected.length === 0, J(r)); }
// ADV-14: the normalised characters, as code points: U+2010–U+2015 and U+2212 → "-"; U+2018/2019/201B → "'"; U+201C/201D/201F → '"'
{ const r = jp(ans({ ...HOLDABLE, quote: "within the city\u2010recognized boundaries of Amazon Neighbors" }));
  const r2 = jp(ans({ ...HOLDABLE, quote: "within the city\u2212recognized boundaries of Amazon Neighbors" }));
  check("T5.12b", "Unicode hyphen and minus match a hyphen", !!r.flag && r.rejected.length === 0 && !!r2.flag, J([r.rejected, r2.rejected])); }
{ const it2 = structuredClone(item); it2.scope.quote = "the owner's lot within the \"recognized\" boundaries";
  const r = judgeAnswer(ans({ ...HOLDABLE, quote: "the owner\u2019s lot within the \u201Crecognized\u201D boundaries" }, it2), it2, P, rubric);
  const r2 = judgeAnswer(ans({ ...HOLDABLE, quote: "the owner\u201Bs lot within the \u201Frecognized\u201D" }, it2), it2, P, rubric);
  check("T5.12c", "curly quotes match straight ones", !!r.flag && !!r2.flag, J([r.rejected, r2.rejected])); }
{ const r = jp(ans({ ...HOLDABLE, claim: "x".repeat(400) })); check("T5.13", "long claim cut", !!r.flag && r.flag.claim.length === 300 && r.warnings!.includes("claim cut at 300 characters"), J(r.warnings)); }
{ const r = jp(ans({ ...HOLDABLE, verdict: "FITS", outcome: "pass", severity: "low" }));
  check("T3", "authority keys rejected", J(r.rejected.map(x => [x.reason, x.raw])) === J([["out_of_authority", { verdict: "FITS" }], ["out_of_authority", { outcome: "pass" }], ["out_of_authority", { severity: "low" }]]) && r.flag?.severity === "high", J(r)); }
{ const base = jp(ans(HOLDABLE)).flag!; const same = (f?: any) => !!f && f.category === base.category && f.severity === base.severity && f.route === base.route && f.confirmed === base.confirmed && f.quote === base.quote && f.fact === base.fact && f.fact_claim === base.fact_claim && f.claim === base.claim;
  check("J1", "fenced JSON", same(jp("```json\n" + ans(HOLDABLE) + "\n```").flag));
  check("J2", "prose around JSON", same(jp("Here: " + ans(HOLDABLE) + " thanks").flag)); }
{ const r = jp("[1,2]"); check("J3", "array is not an object", J(rej(r)) === J(["bad_schema|not a JSON object"]), J(rej(r))); }
{ const r = jp(ans({ answer: "sound" })); check("J4", "sound with category", J(rej(r)) === J(["bad_schema|a sound answer carries no category"]), J(rej(r))); }
{ const r = jp(ans({ fact: "site.zone", fact_claim: null })); check("J5", "fact without claim", J(rej(r)) === J(["bad_schema|fact and fact_claim come together"]), J(rej(r))); }
{ const r = jp(ans({ category: null, fact: null, fact_claim: null })); check("J6", "unclear without category", r.unclear === "EUG.9.2751.17.c" && !r.flag, J(r)); }
{ const r = jp(ans({ category: "scope_sentence_not_scope", fact: null, fact_claim: null })); check("T7.3j", "scope sentence flag is low and unconfirmed", r.flag?.severity === "low" && r.flag.route === "rulebook_queue" && r.flag.confirmed === false, J(r)); }
{ const r = jp(ans({ category: "wrong_exclusion", answer: "unsound", fact: null, fact_claim: null })); check("T7.4j", "wrong_exclusion without fact: high, unconfirmed", r.flag?.severity === "high" && r.flag.route === "hold_if_fits" && r.flag.confirmed === false, J(r)); }

// D8: the category says what the status must be
{ const quote = "within the city-recognized boundaries of Amazon Neighbors";
  const a = jk(ans({ fact: "site.zone", fact_claim: "known", quote }, itemK));
  check("T5.14a", "exclusion_on_unknown_fact on a known fact: kept, not confirmed", !!a.flag && a.flag.confirmed === false && a.flag.severity === "high" &&
    J(a.warnings) === J(["site.zone is known in the case; exclusion_on_unknown_fact needs an unsettled fact, so the flag is not confirmed"]), J(a));
  const b = jp(ans({ answer: "unsound", category: "wrong_exclusion", ...HOLDABLE }));
  check("T5.14b", "wrong_exclusion on an unconfirmed fact: kept, not confirmed", !!b.flag && b.flag.confirmed === false &&
    J(b.warnings) === J(["site.zone is unconfirmed in the case; wrong_exclusion needs a fact the case holds, so the flag is not confirmed"]), J(b));
  const c = jk(ans({ answer: "unsound", category: "wrong_exclusion", fact: "site.zone", fact_claim: "known" }, itemK));
  check("T5.14c", "wrong_exclusion on a known rule fact: confirmed, high, hold route", !!c.flag && c.flag.confirmed === true && c.flag.route === "hold_if_fits" && J(c.warnings) === "[]", J(c)); }
// R2-6 + D8: an absent registered rule fact the item lists confirms an unknown-fact flag
{ const fams = fx("rule-families.json"); fams.find((x: any) => x.provision_id === "EUG.9.2751.17.c").clauses.find((c: any) => c.clause_id === "EUG.9.2751.17.c#v1::sentence:3").needs.push("plan.parking");
  const it3 = buildReviewItems({ events: fx("events-sample.json"), kase: P, run, rubric, index: new Map(fx("index-entries.json").map((x: any) => [x.provision_id, x])),
    ruleFamilies: new Map(fams.map((x: any) => [x.provision_id, x])) })[0]!;
  const r = judgeAnswer(ans({ fact: "plan.parking", fact_claim: "absent" }, it3), it3, P, rubric);
  check("T5.15", "absent listed rule fact confirms", !!r.flag && r.flag.confirmed === true && J(r.warnings) === "[]", J(r)); }

console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
