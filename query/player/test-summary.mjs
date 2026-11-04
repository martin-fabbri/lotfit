// Summary-card truth, rounding, and static-site checks. Plain node, no network, no browser.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, summaryCard } from "./summary.js";

const here = dirname(fileURLToPath(import.meta.url));
let n = 0, t = 0;
const ok = (name, cond, detail = "") => { t++; if (cond) n++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : " — " + detail}`); };
const shoelace = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const rowFor = (html, pid) => html.split('<div class="chk">').find((chunk) => chunk.startsWith("<i") && chunk.includes(pid)) ?? "";
const decimalsOf = (html) => html.replace(/[A-Z]+\.[0-9A-Za-z._-]*/g, "");

for (const [input, want] of [[6.359999999999999, "6.36"], [31.159999999999997, "31.16"], [20, "20"], [0, "0"], [-1.005, "-1"], [2000, "2000"]])
  ok(`fmt(${input}) is ${want}`, fmt(input) === want, fmt(input));

const kit = JSON.parse(readFileSync(join(here, "demo", "eug-demo-24x24.trace.json"), "utf8"));
const kitHtml = summaryCard(kit.options[0], shoelace(kit.options[0].outline), kit.constraints);
ok("kit card header is Needs a check", kitHtml.includes("Needs a check") && kitHtml.includes("NEEDS CHECK"));
for (const [pid, mark] of [["EUG.9.2751.17.b.4.a.setback", "≈"], ["EUG.9.2751.17.b.4.a.slope", "?"]]) {
  const row = rowFor(kitHtml, pid);
  ok(`${pid} row is amber ${mark}, never ✓`, row.includes('class="warn"') && row.includes(mark) && !row.includes("✓"), row.slice(0, 140));
}

const nasty = { id: "client_spot", status: "selected", placement: { x: 6.359999999999999, y: 31.159999999999997 } };
const passRows = [{ provision_id: "PDX.33.110.220.B", outcome: "pass" }];
const fitsHtml = summaryCard(nasty, 576.0, passRows);
ok("selected with all rows pass gives Fits", fitsHtml.includes(">Fits<") && fitsHtml.includes(">FITS<") && fitsHtml.includes("✓"));
const failHtml = summaryCard(nasty, 576.0, [...passRows, { provision_id: "PDX.33.110.245.C.2", outcome: "fail" }]);
ok("one fail row shows ×", failHtml.includes("×") && failHtml.includes("fail"));

const longDec = /\d+\.\d{3,}/;
for (const [name, html] of [["kit", kitHtml], ["fits", fitsHtml], ["fail", failHtml]]) {
  const stripped = decimalsOf(html);
  ok(`no number in the ${name} card has more than 2 decimals`, !longDec.test(stripped), (stripped.match(longDec) || [])[0] || "");
}

for (const f of ["index.html", "scene.js"]) {
  const src = readFileSync(join(here, f), "utf8");
  ok(`${f} has no node_modules/ path`, !src.includes("node_modules/"));
  ok(`${f} has no ../ path`, !src.includes("../"));
}

console.log(`${n}/${t} summary checks passed`);
process.exit(n === t ? 0 : 1);
