// RVT-3: buildReviewItems and renderItem (RVS-06, RVS-07). Frozen acceptance test (kit).
//   npx tsx src/test-rvt-3.mts      (from query/)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubric, buildReviewItems, renderItem, resetFactRegistry, type ItemInputs } from "./reviewer.mts";
import { canonicalJson, sha256Hex } from "./events.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => JSON.parse(readFileSync(join(here, "..", "reviewer", "fixtures", f), "utf8"));
let ok = 0, n = 0;
function check(id: string, name: string, pass: boolean, detail = "") {
  n++; if (pass) { ok++; console.log(`PASS  ${id} ${name}`); } else console.log(`FAIL  ${id} ${name} — ${detail}`);
}
const J = (x: unknown) => JSON.stringify(x);
const rubric = loadRubric();
const run = { thread_id: "019a4a00-0000-7000-8000-000000000001", graph_load_id: "94ee5cce@file-graph", config_hash: "a".repeat(64), as_of: "2026-11-15" };
const K = fx("case-sample.json"); const P = structuredClone(K); P.site.zone.status = "unconfirmed";
const events = fx("events-sample.json");
const mk = (kase: any, o: Partial<ItemInputs> = {}): ItemInputs => ({
  events, index: new Map(fx("index-entries.json").map((x: any) => [x.provision_id, x])),
  ruleFamilies: new Map(fx("rule-families.json").map((x: any) => [x.provision_id, x])), kase, run, rubric, ...o });

const REG = join(here, "..", "reviewer", "fixtures", "facts-registry.json");
// T9.10 (D1, D4): with the registry pointed at a missing file, building an item throws; then back to the sample registry
{ resetFactRegistry(join(here, "no-such-facts.json")); let m = ""; try { buildReviewItems(mk(P)); } catch (e) { m = (e as Error).message; }
  check("T9.10", "missing registry throws", m.startsWith("facts registry not readable: "), m); }
resetFactRegistry(REG);

const items = buildReviewItems(mk(P));
check("T9.1", "one item, 17.c", items.length === 1 && items[0]!.provision.provision_id === "EUG.9.2751.17.c", J(items.map(i => i.provision.provision_id)));
const it = items[0]!;
check("T9.2", "same inputs, same hash", buildReviewItems(mk(P))[0]!.item_sha256 === it.item_sha256);
check("T9.2b", "planted hash", it.item_sha256 === "1901c3da7d2179114f88bbc3e8265c5feadeffcf10123f1ab02f1560bb09b838", it.item_sha256);
{ const h = buildReviewItems(mk(K))[0]!.item_sha256; check("T9.2c", "known hash", h === "49e762e69e7bfe178e859c1a8bf4185200ec90aa607d0d38e15031d51883c9a4", h); }
check("T9.3", "title, section, rule_facts", it.provision.title.includes("Amazon") && it.provision.section === "9.2751(17)(c)" &&
  !it.case_facts.some(f => f.fact === "site.neighborhood") && J(it.rule_facts) === '["site.zone"]');
check("T9.4", "no nested-array values", !it.case_facts.some(f => Array.isArray(f.value) && (f.value as unknown[]).some(Array.isArray)));
check("T9.5", "not truncated, 4 clauses", it.text_truncated === false && it.text.length === 4);
{ const golden = fx("expected-item-planted.json"); check("T9.6", "equals golden", canonicalJson(it) === canonicalJson(golden)); }
// T9.7: append, in order, after the four clauses of 17.c: 27 clauses {clause_id "EUG.9.2751.17.c#v1::sentence:<i>" (i = 4..30),
// kind "sentence", quote "Filler clause <i>.", modeled false, guards [], disposition null, needs []}, then one blank clause
// {clause_id "EUG.9.2751.17.c#v1::blank", kind "sentence", quote "   ", …same}. On sentence:2 (the scope clause) set the
// disposition below and needs ["site.flag_lot", "site.neighborhood"].
const variant = (disp: Record<string, unknown>) => { const fams = fx("rule-families.json"); const f = fams.find((x: any) => x.provision_id === "EUG.9.2751.17.c");
  for (let i = 4; i <= 30; i++) f.clauses.push({ clause_id: `EUG.9.2751.17.c#v1::sentence:${i}`, kind: "sentence", quote: `Filler clause ${i}.`, modeled: false, guards: [], disposition: null, needs: [] });
  f.clauses.push({ clause_id: "EUG.9.2751.17.c#v1::blank", kind: "sentence", quote: "   ", modeled: false, guards: [], disposition: null, needs: [] });
  const s2 = f.clauses.find((c: any) => c.clause_id === "EUG.9.2751.17.c#v1::sentence:2"); s2.disposition = disp; s2.needs = ["site.flag_lot", "site.neighborhood"];
  return buildReviewItems(mk(P, { ruleFamilies: new Map(fams.map((x: any) => [x.provision_id, x])) }))[0]!; };
const D = (o: Record<string, unknown>) => ({ ...o, reason: "sample", by: "Martin Fabbri", date: "2026-11-03" });
{ const disp = D({ kind: "inert_for", scope: "detached_adu" }); const r = variant(disp);
  check("T9.7", "truncation at 30, blank dropped, disposition relied on, registered needs only", r.text.length === 30 && r.text.at(-1)?.clause_id === "EUG.9.2751.17.c#v1::sentence:29" && r.text.every(t => t.quote.trim() !== "") &&
    r.text_truncated === true && J(r.rule_facts) === '["site.flag_lot","site.zone"]' &&
    canonicalJson(r.dispositions_relied_on) === canonicalJson([{ clause_id: "EUG.9.2751.17.c#v1::sentence:2", disposition: disp }]) &&
    r.item_sha256 === "7a5fb0499dcdf5bc1458499e70b22dd37895c837dd49068458f33249d3bdc764", `${r.text.length} ${r.item_sha256} ${J(r.rule_facts)}`); }
// D7: only an inert_for for this project kind (detached_adu here) or for every kind is relied on
{ const a = variant(D({ kind: "inert_for", scope: "attached_adu" })), b = variant(D({ kind: "inert_for" })), c = variant(D({ kind: "needs_fact", fact: "site.zone" }));
  check("T9.7b", "inert_for for another kind is not relied on", a.dispositions_relied_on === undefined && a.item_sha256 === "6634c0c1490431cc0cc40aa26ded181ba37f0d266722f4b289606f3e4a9f083a", a.item_sha256);
  check("T9.7c", "inert_for with no scope is relied on", b.dispositions_relied_on?.length === 1 && b.dispositions_relied_on[0]!.disposition.scope === undefined, J(b.dispositions_relied_on));
  check("T9.7d", "needs_fact is not relied on", c.dispositions_relied_on === undefined, J(c.dispositions_relied_on)); }
{ const evs = structuredClone(events); evs[0].data.provision_id = "EUG.9.9999.x"; evs.splice(1, 2);
  check("T9.8", "unindexed provision gives none", buildReviewItems(mk(P, { events: evs })).length === 0); }
// T9.9 (D5): a reviewed exclusion with no rule family throws (Step 7 makes the review not_run: reviewed "no")
{ let m = ""; try { buildReviewItems(mk(P, { events: [events[0]], ruleFamilies: new Map() })); } catch (e) { m = (e as Error).message; }
  check("T9.9", "no rule family throws", m === "no rule family for EUG.9.2751.17.c: the review cannot read the rule (D5)", m); }
// T9.11 (R2-6, ADV-15): a registered rule fact the case does not hold is listed with status absent
{ const fams = fx("rule-families.json"); const f = fams.find((x: any) => x.provision_id === "EUG.9.2751.17.c");
  f.clauses.find((c: any) => c.clause_id === "EUG.9.2751.17.c#v1::sentence:3").needs.push("plan.parking");
  const r = buildReviewItems(mk(P, { ruleFamilies: new Map(fams.map((x: any) => [x.provision_id, x])) }))[0]!;
  check("T9.11", "absent rule fact listed", J(r.rule_facts) === '["plan.parking","site.zone"]' && J(r.case_facts.find(c => c.fact === "plan.parking")) === J({ fact: "plan.parking", status: "absent" }), J(r.rule_facts)); }
// T9.12 (D6): one item per provision; the last exclusion event for it counts
{ const again = structuredClone(events[0]); again.seq = 9; again.data.basis = "computed_known_false";
  const a = buildReviewItems(mk(P, { events: [events[0], again] })), b = buildReviewItems(mk(P, { events: [again, events[0], events[0]] }));
  check("T9.12", "deduplicated, last event wins", a.length === 0 && b.length === 1 && b[0]!.item_sha256 === it.item_sha256, `${a.length} ${b.length}`); }

// RVS-07
const golden = fx("expected-item-planted.json");
const txt = readFileSync(join(here, "..", "reviewer", "fixtures", "expected-render-planted.txt"), "utf8");
{ const out = renderItem(golden);
  check("RR1", "render equals golden text", out === txt && out.length === 1642 && sha256Hex(out) === "b48069a225768bfb7ab6f8afb7c489fa85b22b0a2b612569548dc96788430775", `${out.length} ${sha256Hex(out)}`); }
{ const g = structuredClone(golden); g.provision.section = null; g.provision.zones = []; g.case_facts = [];
  const out = renderItem(g); const l2 = out.split("\n")[1]!;
  check("RR2", "n/a, not stated, empty facts", l2.endsWith("(section n/a; stage placement_constraint; zones not stated)") && out.endsWith("Lot facts:\n"), JSON.stringify(out.slice(-30))); }
{ const g = structuredClone(golden); g.text_truncated = true;
  g.dispositions_relied_on = [{ clause_id: "EUG.9.2751.17.c#v1::sentence:2", disposition: { kind: "inert_for", scope: "adu", reason: "r", by: "Martin Fabbri", date: "2026-11-03" } },
    { clause_id: "x::y", disposition: { kind: "needs_fact", reason: "r", by: "b", date: "2026-11-03" } }];
  const L = renderItem(g).split("\n");
  check("RR3", "signed and cut lines", L[9] === "Signed by a person for the scope clause: inert_for (adu); needs_fact" && L[10] === "(The rule text above is cut at 30 clauses.)" && L[11] === "Lot facts:", J(L.slice(8, 13))); }
check("RR4", "render is deterministic", renderItem(golden) === renderItem(golden));

console.log(`${ok}/${n} checks passed`);
process.exit(ok === n ? 0 : 1);
