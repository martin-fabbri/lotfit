// RVT-5: the clients (RVS-09) and review() (RVS-10). Frozen acceptance test (kit). No network: the Meta client is only
// constructed, or given a recording fetch.
//   npx tsx src/test-rvt-5.mts      (from query/)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubric, buildReviewItems, review, resetFactRegistry } from "./reviewer.mts";
import { MetaReviewerClient, ScriptedReviewerClient } from "./reviewer-client.mts";

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
const index = new Map(fx("index-entries.json").map((x: any) => [x.provision_id, x]));
const fams = new Map(fx("rule-families.json").map((x: any) => [x.provision_id, x]));
const events = fx("events-sample.json");
const events2 = structuredClone(events); events2[2].data.basis = "planner_reading";
const build = (evs: any) => buildReviewItems({ events: evs, index: index as any, ruleFamilies: fams as any, kase: P, run, rubric });
const items = build(events), items2 = build(events2), item = items[0]!;
const PLANNER = "accounts/fireworks/models/muse-spark-open";
const ans = (o: Record<string, unknown> = {}) => JSON.stringify({ item_sha256: item.item_sha256, answer: "unclear", category: "exclusion_on_unknown_fact",
  quote: "within the city-recognized boundaries of Amazon Neighbors", fact: "site.neighborhood", fact_claim: "absent",
  claim: "Whether 17.c applies turns on the lot's neighborhood, which the case does not hold.", ...o });
const H = { fact: "site.zone", fact_claim: "unconfirmed" };
const cl = (h: (i: any, a: number) => string | Promise<string>, model = "muse-spark-1.3") => new ScriptedReviewerClient(model, h);
const go = (client: any, o: any = {}) => review({ items, client, plannerModel: PLANNER, verdict: "FITS", kase: P, rubric, ...o });
const rej = (r: any) => r.outcome.rejected.map((x: any) => `${x.reason}|${x.detail ?? ""}`);

(async () => {
  // RVS-09: the Meta client. Constructing it makes no request; the recording fetch stands in for the network (D14).
  const msg = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
  check("C9.1", "contributor model refused", msg(() => new MetaReviewerClient({ apiKey: "k", model: "muse-spark-1.3-contributor" })) === "the Reviewer sends a client's case facts; muse-spark-1.3-contributor is a contributor endpoint (L27)");
  check("C9.2", "contributor route refused", msg(() => new MetaReviewerClient({ apiKey: "k", baseURL: "https://x/contributor/v1" })).endsWith("is a contributor endpoint (L27)"));
  { const saved = process.env["META_API_KEY"]; delete process.env["META_API_KEY"];
    check("C9.3", "key missing", msg(() => new MetaReviewerClient()) === "META_API_KEY is not set (read from the environment only, MM-04)");
    if (saved !== undefined) process.env["META_API_KEY"] = saved; }
  { const c = new MetaReviewerClient({ apiKey: "k" }); check("C9.4", "defaults", c.modelId === "muse-spark-1.3" && c.providerRoute === "https://api.meta.ai/v1"); }
  { const bodies: any[] = []; let urls: string[] = [];
    const rec = (status: number) => (async (url: any, init: any) => { urls.push(String(url)); bodies.push(JSON.parse(init.body));
      return status === 200 ? new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "muse-spark-1.3",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: { message: "boom" } }), { status, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    const c = new MetaReviewerClient({ apiKey: "k", fetch: rec(200), costPerMillionPromptUsd: 1, costPerMillionCompletionUsd: 2 });
    const r = await c.answer({ item, system: "SYS", user: "USER", timeoutMs: 5000 }); const b = bodies[0];
    check("C9.7", "one request: temperature 0, max_tokens 2500, no tools, system then user", bodies.length === 1 && urls[0] === "https://api.meta.ai/v1/chat/completions" &&
      b.model === "muse-spark-1.3" && b.temperature === 0 && b.max_tokens === 2500 && !("tools" in b) && !("response_format" in b) &&
      J(b.messages) === J([{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]) &&
      r.content === "hi" && r.usage.prompt_tokens === 3 && r.usage.completion_tokens === 2 && r.usage.cost_usd === 7e-6 && r.usage.model === "muse-spark-1.3", J([b, r]));
    bodies.length = 0; urls = [];
    const c2 = new MetaReviewerClient({ apiKey: "k", fetch: rec(500) }); let m = ""; try { await c2.answer({ item, system: "S", user: "U", timeoutMs: 5000 }); } catch (e) { m = (e as Error).message; }
    check("C9.8", "a 500 is thrown after exactly one request (maxRetries 0)", bodies.length === 1 && m !== "", `${bodies.length} ${m}`);
    const c3 = new MetaReviewerClient({ apiKey: "k", fetch: rec(200) }); const r3 = await c3.answer({ item, system: "S", user: "U", timeoutMs: 5000 });
    check("C9.9", "no prices set: no cost reported", r3.usage.cost_usd === undefined && !("cost_usd" in r3.usage), J(r3.usage)); }

  // RVS-09 scripted rows
  { const c = cl((_i, a) => String(a)); const r1 = await c.answer({ item, system: "s", user: "u", timeoutMs: 1 }); const r2 = await c.answer({ item: items2[1]!, system: "s", user: "u", timeoutMs: 1 });
    check("C9.5", "scripted client", r1.content === "1" && r2.content === "2" && c.calls === 2 && J(r1.usage) === J({ model: "muse-spark-1.3", prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 }), J([r1, r2, c.calls])); }
  { const c = cl(() => { throw new Error("503 upstream"); }); let m = ""; try { await c.answer({ item, system: "s", user: "u", timeoutMs: 1 }); } catch (e) { m = (e as Error).message; }
    check("C9.6", "scripted handler throws", m === "503 upstream" && c.calls === 1, m); }

  { const c = cl(() => ans({}), "meta-models/muse-spark-open-1026"); const r = await go(c);
    check("T4.3", "same model refused", r.outcome.status === "not_run" && J(r.outcome.error) === J({ category: "harness", message: "the Reviewer must be a different model from the Planner (B4): both are muse-spark-open" }) && r.calls.length === 0 && c.calls === 0 && r.outcome.model === c.modelId, J(r.outcome)); }
  { const r = await go(null); const o = r.outcome;
    check("T6.1", "no client", o.status === "not_run" && J(o.error) === J({ category: "harness", message: "no Reviewer configured for this run" }) && o.model === "none" && o.hold === false && o.items === 1, J(o)); }
  { const c = cl(() => { throw new Error("503 upstream"); }); const r = await go(c);
    check("T6.2", "provider outage", r.outcome.status === "not_run" && J(rej(r)) === J(["no_answer|503 upstream", "no_answer|503 upstream"]) && J(r.outcome.error) === J({ category: "model", message: "no answer for any of 1 item(s): 503 upstream" }) && r.outcome.hold === false, J(r.outcome)); }
  { const c = cl(() => "not json"); const r = await go(c);
    check("T6.3", "not json twice", c.calls === 2 && r.calls.length === 2 && J(rej(r)) === J(["bad_schema|not a JSON object", "bad_schema|not a JSON object"]) && r.outcome.status === "not_run" &&
      J(r.outcome.error) === J({ category: "model", message: "no accepted answer for any of 1 item(s): not a JSON object" }) && r.outcome.hold === false, J(r.outcome)); }
  { const c = cl((_i, a) => (a === 1 ? "oops" : ans(H))); const r = await go(c); const f = r.outcome.flags[0];
    check("T6.4", "retry after bad schema", r.outcome.status === "flagged" && r.outcome.flags.length === 1 && f?.category === "exclusion_on_unknown_fact" && f.severity === "high" && f.confirmed && f.route === "hold_if_fits" &&
      c.calls === 2 && r.outcome.rejected.length === 1 && r.outcome.rejected[0]!.reason === "bad_schema" && r.outcome.hold === true && r.calls.length === 2, J(r.outcome)); }
  { const c = cl(() => ans({ quote: "this sentence is nowhere in the rule text at all" })); const r = await go(c);
    check("T6.5", "bad quote: one call, never retried", r.outcome.status === "not_run" && r.outcome.answered === 0 && c.calls === 1 && J(r.outcome.rejected.map((x: any) => x.reason)) === J(["quote_not_in_item"]), J(r.outcome)); }
  { const c = cl((it) => { if (it.provision.provision_id !== "EUG.9.2751.17.c") throw new Error("timeout"); return ans({ ...H, item_sha256: it.item_sha256 }); });
    const r = await go(c, { items: items2 }); const o = r.outcome;
    check("T6.6", "partial review still holds", o.status === "partial" && o.answered === 1 && o.items === 2 && o.hold === true && J(rej(r)) === J(["no_answer|timeout", "no_answer|timeout"]) &&
      J(o.error) === J({ category: "model", message: "1 of 2 item(s) have no accepted answer" }), J(o)); }
  { const c = cl(() => new Promise<string>(() => {})); const t0 = Date.now(); const r = await go(c, { timeoutMs: 100, deadlineMs: 300 }); const dt = Date.now() - t0;
    check("T6.7", "deadline", r.outcome.status === "not_run" && J(rej(r)) === J(["no_answer|review deadline reached"]) &&
      r.outcome.error?.message === "no answer for any of 1 item(s): review deadline reached" && dt < 2000, `${dt} ms ${J(r.outcome)}`); }
  { const c = cl(() => new Promise<string>(() => {})); const t0 = Date.now(); const r = await go(c, { timeoutMs: 50, deadlineMs: 5000 }); const dt = Date.now() - t0;
    check("T6.7b", "a hung call is cut at timeoutMs + 1000, not at the deadline, and not retried", r.outcome.status === "not_run" && c.calls === 1 &&
      J(rej(r)) === J(["no_answer|review deadline reached"]) && dt >= 1000 && dt < 1500, `${dt} ms ${J(rej(r))}`); }
  { const c = cl((_i, a) => { if (a === 1) throw new Error("429 rate limited"); return ans(H); }); const r = await go(c);
    check("T6.8", "retry after 429", r.outcome.status === "flagged" && r.outcome.flags.length === 1 && c.calls === 2 && J(rej(r)) === J(["no_answer|429 rate limited"]) && r.calls.length === 1, J(r.outcome)); }
  { const r = await go(cl(() => ans(H))); const f = r.outcome.flags[0];
    check("T7.1", "hold on FITS", r.outcome.hold === true && f?.severity === "high" && f.route === "hold_if_fits" && f.confirmed === true); }
  { const r = await go(cl(() => ans({}))); const f = r.outcome.flags[0];
    check("T7.0", "unregistered fact: unconfirmed, no hold", !!f && f.confirmed === false && r.outcome.hold === false &&
      r.outcome.warnings?.some(w => w.detail === "site.neighborhood is not a fact of this item or of the facts registry; the flag is not confirmed") === true, J(r.outcome)); }
  { const r = await go(cl(() => ans(H)), { verdict: "NEEDS_CHECK" }); check("T7.2", "no hold on NEEDS_CHECK", r.outcome.status === "flagged" && r.outcome.hold === false, J(r.outcome)); }
  { const r = await go(cl(() => ans(H)), { verdict: "FITS_IF" }); check("T7.2b", "hold on FITS_IF", r.outcome.hold === true); }
  { const r = await go(cl(() => ans({ category: "scope_sentence_not_scope", fact: null, fact_claim: null }))); const f = r.outcome.flags[0];
    check("T7.3", "scope sentence flag low", f?.severity === "low" && f.route === "rulebook_queue" && f.confirmed === false && r.outcome.hold === false); }
  { const r = await go(cl(() => ans({ answer: "unsound", category: "wrong_exclusion", fact: null, fact_claim: null }))); const f = r.outcome.flags[0];
    check("T7.4", "wrong_exclusion without fact", f?.severity === "high" && f.confirmed === false && r.outcome.hold === false); }
  { const c = cl(() => ans(H)); const r = await go(c, { items: [] }); const o = r.outcome;
    check("T10.0", "no items is clean", o.status === "clean" && o.answered === 0 && o.items === 0 && c.calls === 0 && r.calls.length === 0, J(o)); }

  console.log(`${ok}/${n} checks passed`);
  process.exit(ok === n ? 0 : 1);
})();
