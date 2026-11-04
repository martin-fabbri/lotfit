// Web app formatting and log tests (no network): pure functions from lib/format.ts run
// against the recorded demo run; app sources reach outside the repo only via lib/paths.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, verdictView, buildLog } from "../lib/format.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const repo = join(here, "..", "..");
const demo = join(repo, "query", "viewer", "demo", "eug-demo-24x24");
const report = JSON.parse(readFileSync(join(demo, "report.json"), "utf8"));
const events = readFileSync(join(demo, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("fmt", () => {
  it("rounds to 2 decimals and groups thousands", () => {
    assert.equal(fmt(1234567.891), "1,234,567.89");
    assert.equal(fmt(576), "576");
    assert.equal(fmt(6.36), "6.36");
  });
  it("never prints -0", () => {
    assert.equal(fmt(-0.004), "0");
    assert.equal(fmt(-0), "0");
  });
});

describe("verdictView", () => {
  it("gives Needs a check for the recorded run", () => {
    assert.equal(report.verdict, "NEEDS_CHECK");
    assert.equal(verdictView(report).big, "Needs a check");
  });
  it("says It fits only for FITS", () => {
    assert.equal(verdictView({ ...report, verdict: "FITS" }).big, "It fits");
    for (const v of ["NEEDS_CHECK", "FITS_IF", "DOESNT_FIT", "NO_LEGS", "BLOCKED_BY_GATE", "NOT_MODELED"]) {
      assert.notEqual(verdictView({ ...report, verdict: v }).big, "It fits", v);
    }
  });
});

describe("buildLog", () => {
  it("counts every tool_requested on the recorded run", () => {
    const want = events.filter((e) => e.type === "tool_requested").length;
    const lines = buildLog(events);
    assert.ok(want > 0);
    assert.equal(lines.filter((l) => l.cls === "call").length, want);
  });
  it("cost equals the report telemetry", () => {
    const lines = buildLog(events);
    assert.ok(Math.abs(lines[lines.length - 1].counts.cost - report.telemetry.cost_usd) < 1e-9);
  });
  it("escapes a preview containing script", () => {
    const html = buildLog([{ type: "tool_result", data: { ok: true, preview: "<script>alert(1)</script>" } }])[0].html;
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });
});

describe("paths", () => {
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f)) files.push(p);
    }
  };
  walk(join(web, "app"));
  walk(join(web, "lib"));
  it("no source reaches outside the repo except through lib/paths.ts", () => {
    assert.ok(files.length > 0);
    for (const f of files) {
      if (f.endsWith(join("lib", "paths.ts"))) continue;
      const src = readFileSync(f, "utf8");
      const noImports = src.replace(/^import .*$/gm, "");
      assert.ok(!/["'`]\.\.\//.test(noImports), `${f}: ../ literal outside an import`);
      assert.ok(!src.includes("process.cwd()"), `${f}: process.cwd()`);
      assert.ok(!/\/(Users|tmp|var|home)\//.test(noImports), `${f}: absolute path literal`);
      if (src.includes("node:fs")) assert.match(src, /from\s+["'].*paths["']/, `${f}: fs without a paths import`);
    }
  });
});
