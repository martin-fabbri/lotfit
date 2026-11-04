// LotFit W3 — Case Gate (Milestone 1)
// Validates an agent Case against types.mts (Zod) and graph/model.py + graph/tools/geometry.py (Python),
// enforces invariants I1..I12, and materializes the 5 COMPUTED_FACTS with provenance and propagated tolerance.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import * as C from "./types.mts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_CASE_PY = path.resolve(__dirname, "../py/validate_case.py");
const FALLBACK_CASE_ID = "019a4000-0000-7000-8000-000000000000";

export type CaseType = z.infer<typeof C.Case>;
export type FactEntryType = z.infer<typeof C.FactEntry>;
export type CaseRefusalType = z.infer<typeof C.CaseRefusal>;
export type InvariantCodeType = z.infer<typeof C.InvariantCode>;

export type CheckCaseOptions = {
  expected_case_hash?: string;
};

export type CheckCaseOk = {
  ok: true;
  case: CaseType;
  case_hash: string;
  computed: Record<string, FactEntryType>;
};

export type CheckCaseResult = CheckCaseOk | CaseRefusalType;

function extractCaseId(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "case_id" in raw) {
    const cid = (raw as Record<string, unknown>).case_id;
    const parsed = C.Uuid7.safeParse(cid);
    if (parsed.success) return parsed.data;
  }
  return FALLBACK_CASE_ID;
}

function makeRefusal(
  case_id: string,
  invariant: InvariantCodeType,
  message: string,
  refusalPath?: string,
): CaseRefusalType {
  return C.CaseRefusal.parse({
    case_id,
    refused: true,
    invariant,
    message,
    ...(refusalPath !== undefined ? { path: refusalPath } : {}),
  });
}

function mapZodIssueToInvariant(issue: { path: PropertyKey[]; message: string }): {
  invariant: InvariantCodeType;
  path?: string;
} {
  const pathStr = issue.path.map(String).join(".");
  const msg = issue.message;
  const top = String(issue.path[0] ?? "");

  if (top === "schema" || top === "case_id" || top === "mode" || top === "capture" || top === "parcel" || top === "context") {
    return { invariant: "I1", path: pathStr || "schema" };
  }
  if (top === "as_of") {
    return { invariant: "I2", path: pathStr || "as_of.date" };
  }
  if (top === "jurisdiction") {
    return { invariant: "I3", path: pathStr || "jurisdiction" };
  }
  if (top === "unknowns" || msg.includes("both unknown and given a value")) {
    return { invariant: "I11", path: pathStr || "unknowns" };
  }
  if (pathStr.startsWith("plan.placement") || msg.includes("I8")) {
    return { invariant: "I8", path: "plan.placement" };
  }
  if (msg.includes("entered geometry needs rests_on") || msg.includes("issuing agency")) {
    const factPath = issue.path.slice(0, 2).map(String).join(".");
    return { invariant: "I6", path: factPath || pathStr };
  }
  if (msg.includes("observations")) {
    const factPath = issue.path.slice(0, 2).map(String).join(".");
    return { invariant: "I9", path: factPath || pathStr };
  }
  if (top === "site" || top === "plan") {
    const factPath = issue.path.slice(0, 2).map(String).join(".");
    return { invariant: "I4", path: factPath || pathStr };
  }
  return { invariant: "I1", path: pathStr || "schema" };
}

export function checkCase(raw: unknown, opts?: CheckCaseOptions): CheckCaseResult {
  const case_id = extractCaseId(raw);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return makeRefusal(case_id, "I1", "Case input must be a JSON object", "schema");
  }

  // Call the Python validator & geometry/fact computer (`python3 -I`)
  const args = ["-I", VALIDATE_CASE_PY];
  if (opts?.expected_case_hash !== undefined) {
    // Pass via payload or env/arg; validate_case.py reads stdin when argc == 1,
    // so attach expected_case_hash if needed.
  }

  const rawObj = raw as Record<string, unknown>;
  const payloadForPy =
    opts?.expected_case_hash !== undefined
      ? { ...rawObj, case_hash: opts.expected_case_hash }
      : rawObj;

  let pyOutText: string;
  try {
    pyOutText = execFileSync("python3", args, {
      input: JSON.stringify(payloadForPy),
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeRefusal(case_id, "I1", `Case validator execution failed: ${msg}`, "schema");
  }

  let pyRes: Record<string, unknown>;
  try {
    pyRes = JSON.parse(pyOutText) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeRefusal(case_id, "I1", `Invalid validator output: ${msg}`, "schema");
  }

  if (pyRes.refused === true) {
    return C.CaseRefusal.parse(pyRes);
  }

  // Also parse with C.Case (stripping any top-level case_hash that was already verified by I10)
  const { case_hash: _ignoredHash, ...caseCandidate } = rawObj;
  const zodParsed = C.Case.safeParse(caseCandidate);
  if (!zodParsed.success) {
    const firstIssue = zodParsed.error.issues[0];
    if (!firstIssue) {
      return makeRefusal(case_id, "I1", "Invalid Case schema", "schema");
    }
    const mapped = mapZodIssueToInvariant(firstIssue);
    return makeRefusal(case_id, mapped.invariant, firstIssue.message, mapped.path);
  }

  const validatedCase = zodParsed.data;
  const rawComputed = (pyRes.computed ?? {}) as Record<string, unknown>;
  const computed: Record<string, FactEntryType> = {};

  for (const factName of C.COMPUTED_FACTS) {
    if (factName in rawComputed) {
      const entry = C.FactEntry.parse(rawComputed[factName]);
      computed[factName] = entry;
      const [ns, key] = factName.split(".", 2);
      if (ns === "site" && key) {
        validatedCase.site[key] = entry;
      } else if (ns === "plan" && key) {
        validatedCase.plan[key] = entry;
      }
    }
  }

  return {
    ok: true,
    case: validatedCase,
    case_hash: String(pyRes.case_hash),
    computed,
  };
}

// Optional CLI entrypoint: `npx tsx src/case-gate.mts <case.json>`
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.error("Usage: tsx src/case-gate.mts <case.json>");
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
  const res = checkCase(raw);
  console.log(JSON.stringify(res, null, 2));
  process.exit("refused" in res ? 1 : 0);
}
