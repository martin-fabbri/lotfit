// Extra run-viewer checks (no network): every verdict headline, log failures and escaping,
// rule order, measureless findings, and the static-site path audit. Do not edit test-model.mjs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verdictView, buildLog, ruleRows, findingRows } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const D = join(here, "demo", "eug-demo-24x24") + "/";
const j = (n) => JSON.parse(readFileSync(D + n, "utf8"));
const report = j("report.json");

let n = 0, t = 0;
const ok = (name, cond, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };

const headlines = {
  FITS: ["It fits", "ok"], FITS_IF: ["It fits, if…", "am"], NEEDS_CHECK: ["Needs a check", "am"],
  NO_LEGS: ["No spot found", "no"], BLOCKED_BY_GATE: ["Not allowed here", "no"], NOT_MODELED: ["Not modeled yet", "dim"],
};
for (const [verdict, [big, tone]] of Object.entries(headlines)) {
  const v = verdictView({ ...report, verdict });
  ok(`${verdict} headline and tone`, v.big === big && v.tone === tone, `${v.big} / ${v.tone}`);
}
ok("never It fits unless FITS",
  Object.keys(headlines).filter((v) => v !== "FITS").every((v) => verdictView({ ...report, verdict: v }).big !== "It fits"));

const log = buildLog([
  { type: "tool_requested", data: { call: { tool: "check_setback", args: { provision_id: "EUG.9.2751.17.b.4.a.setback" } } } },
  { type: "tool_result", data: { ok: false, preview: "margin -3 ft" } },
  { type: "error", data: { code: "STAGE_ORDER_VIOLATION", message: "retry after the gate" } },
]);
ok("failed tool result shows ✗", log.some((l) => l.html.includes("✗")));
ok("error event counts the repair", log.at(-1).counts.errors === 1, JSON.stringify(log.at(-1).counts));
const xss = buildLog([{ type: "tool_result", data: { ok: true, preview: "<script>alert(1)</script>" } }]);
ok("tool preview escapes <script>", xss[0].html.includes("&lt;script&gt;") && !xss[0].html.includes("<script>"), xss[0].html.slice(0, 120));

const rr = ruleRows({ order: ["B", "A"], applies: [{ provision_id: "A", scope_quote: "a" }, { provision_id: "B", scope_quote: "b" }], excluded_at_index: [] });
ok("ruleRows keeps the plan order", rr.applies.map((r) => r.id).join(",") === "B,A");

const fr = findingRows({ findings: [{ provision_id: "EUG.9.2751.17.b.4.a.slope", target: "case", outcome: "unknown", measures: [],
  citations: [{ quote: "The slope rule sets the height limit for the back wall and the gable" }] }] })[0];
ok("measureless finding has no numbers line", fr.nums === "", JSON.stringify(fr.nums));
ok("its quote is a prefix of the citation",
  "The slope rule sets the height limit for the back wall and the gable".startsWith(fr.quote.replace(/…$/, "")));

for (const f of ["index.html", "viewer.js", "model.js"]) {
  const src = readFileSync(join(here, f), "utf8");
  ok(`${f} has no node_modules/ path`, !src.includes("node_modules/"));
  ok(`${f} has no ../ path`, !src.includes("../"));
}

console.log(`${n}/${t} checks passed`);
process.exit(n === t ? 0 : 1);
