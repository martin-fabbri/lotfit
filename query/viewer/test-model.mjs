// node test-model.mjs  (from query/viewer/; no network)
import { readFileSync } from "node:fs";
import { fmt, modelName, outcomeView, verdictView, buildLog, factRows, ruleRows, findingRows } from "./model.js";

const D = new URL("./demo/eug-demo-24x24/", import.meta.url);
const j = (n) => JSON.parse(readFileSync(new URL(n, D), "utf8"));
const kase = j("case.json"), facts = j("case-facts.json"), plan = j("plan.json"), report = j("report.json");
const events = readFileSync(new URL("events.jsonl", D), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

let pass = 0, total = 0;
const ok = (name, cond) => { total++; if (cond) pass++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

ok("fmt rounds to 2 decimals", fmt(6.359999999999999) === "6.36" && fmt(31.159999999999997) === "31.16");
ok("fmt keeps integers and groups thousands", fmt(20) === "20" && fmt(6827.2484) === "6,827.25" && fmt(0) === "0");
ok("fmt never shows -0", fmt(-0.001) === "0");
ok("model name says Meta", modelName("accounts/fireworks/models/muse-spark-open") === "Muse Spark Open (Meta)");
ok("outcomes: pass green, fail red, too close and unknown amber",
  outcomeView("pass").tone === "ok" && outcomeView("fail").tone === "no" &&
  outcomeView("too_close_to_call").tone === "am" && outcomeView("unknown").tone === "am");
ok("unknown reads 'not measured', never pass", outcomeView("unknown").label === "not measured" && outcomeView("unknown").icon !== "✓");

const v = verdictView(report);
ok("verdict view follows report.verdict (NEEDS_CHECK)", report.verdict === "NEEDS_CHECK" && v.big === "Needs a check" && v.tone === "am");
ok("FITS is only said for a FITS report", verdictView({ ...report, verdict: "FITS" }).big === "It fits" && v.big !== "It fits");
ok("the too-close setback is named with its numbers", v.why.some((w) => w.includes("EUG.9.2751.17.b.4.a.setback") && w.includes("6.36") && w.includes("5 ft")));

const log = buildLog(events);
const last = log.at(-1).counts;
const calls = events.filter((e) => e.type === "tool_requested").length;
ok("log counts every tool call", last.calls === calls);
ok("log counts every finding and exclusion",
  last.findings === events.filter((e) => e.type === "lotfit.finding_recorded").length &&
  last.exclusions === events.filter((e) => e.type === "lotfit.exclusion_recorded").length);
ok("log cost equals the run's cost", Math.abs(last.cost - report.telemetry.cost_usd) < 1e-6);
ok("log shows the verdict computed in code", log.some((l) => l.html.includes("verdict computed in code · NEEDS_CHECK")));
ok("log html escapes '<'", log.every((l) => !/<(?!\/?span)/.test(l.html.replace(/<span class="[a-z]+">/g, "<span>"))));

const r = ruleRows(plan);
ok("rules: every applied and excluded provision, with a quote",
  r.applies.length === plan.applies.length && r.excluded.length === plan.excluded_at_index.length &&
  [...r.applies, ...r.excluded].every((x) => x.id && x.quote));

const f = findingRows(report);
ok("findings: one row per finding, each with a verbatim quote prefix",
  f.length === report.findings.length && f.every((x, i) => report.findings[i].citations[0].quote.startsWith(x.quote.replace(/…$/, ""))));
ok("no number on screen has more than 2 decimals",
  [...f.map((x) => x.nums), ...factRows(kase, facts).map((x) => x.v), ...v.why]
    .map((s) => s.replace(/\b(?:EUG|PDX|ORS|OR|GRE)\.[\w.]+/g, "")) // provision ids are not numbers
    .every((s) => !/\d\.\d{3,}/.test(s)));
const fr = factRows(kase, facts);
ok("facts: zone, lot, plan and spot present", ["Zone", "Lot", "Plan", "Spot"].every((k) => fr.some((x) => x.k === k)));

console.log(`${pass}/${total} checks passed`);
process.exit(pass === total ? 0 : 1);
