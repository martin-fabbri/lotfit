/**
 * Test runner for the LotFit case gate (W3, milestone 1).
 *
 * Loads valid scenario cases (s1..s5, s7) and invalid invariant cases (i1..i12),
 * runs checkCase on each, verifies all expected invariants, computed facts, and
 * scenario properties, prints one line per case, and exits 1 on any mismatch.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as C from "./types.mts";
import { checkCase, type CheckCaseOk, type InvariantCodeType } from "./case-gate.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CASES_DIR = path.resolve(__dirname, "..", "cases");

interface ValidExpectation {
  file: string;
  case_id: string;
  setbacks_used: string[];
  extraCheck?: (res: CheckCaseOk) => string | null;
}

const VALID_CASES: ValidExpectation[] = [
  {
    file: "s1.json",
    case_id: "019a4000-0000-7000-8000-000000000001",
    setbacks_used: ["side", "rear"],
  },
  {
    file: "s2.json",
    case_id: "019a4000-0000-7000-8000-000000000002",
    setbacks_used: [],
  },
  {
    file: "s3.json",
    case_id: "019a4000-0000-7000-8000-000000000003",
    setbacks_used: [],
    extraCheck: (res) => {
      const la = res.case.plan["living_area_sqft"];
      if (!la || !("value" in la)) return "plan.living_area_sqft is not a KnownFact";
      const br = la.by_reading?.["amb.living-area.sloped-ceiling"];
      if (!Array.isArray(br) || br[0] !== 864 || br[1] !== 576) {
        return `expected by_reading [864, 576], got ${JSON.stringify(br)}`;
      }
      return null;
    },
  },
  {
    file: "s4.json",
    case_id: "019a4000-0000-7000-8000-000000000004",
    setbacks_used: [],
    extraCheck: (res) => {
      const pla = res.case.site["primary_living_area_sqft"];
      if (!pla || !("observations" in pla) || pla.observations.length !== 2) {
        return "expected 2 conflicting observations on site.primary_living_area_sqft";
      }
      return null;
    },
  },
  {
    file: "s5.json",
    case_id: "019a4000-0000-7000-8000-000000000005",
    setbacks_used: [],
    extraCheck: (res) => {
      const rll = res.case.site["rear_lot_line"];
      if (!rll || !("value" in rll) || rll.prov[0]?.tolerance?.value !== 1.6) {
        return `expected site.rear_lot_line.prov[0].tolerance.value === 1.6, got ${JSON.stringify(rll)}`;
      }
      return null;
    },
  },
  {
    file: "s7.json",
    case_id: "019a4000-0000-7000-8000-000000000007",
    setbacks_used: [],
    extraCheck: (res) => {
      const fl = res.case.site["flag_lot"];
      if (!fl || !("value" in fl) || fl.value !== true) {
        return "expected site.flag_lot.value === true";
      }
      const area = res.computed["site.lot_area_sqft"];
      if (!area || !("value" in area) || Number(area.value) < 3000) {
        return `expected lot_area_sqft >= 3000, got ${JSON.stringify(area)}`;
      }
      return null;
    },
  },
];

interface InvalidExpectation {
  file: string;
  invariant: InvariantCodeType;
  pathPrefix: string;
}

const INVALID_CASES: InvalidExpectation[] = [
  { file: "invalid/i1.json", invariant: "I1", pathPrefix: "schema" },
  { file: "invalid/i2.json", invariant: "I2", pathPrefix: "as_of.date" },
  { file: "invalid/i3.json", invariant: "I3", pathPrefix: "jurisdiction.city_layer" },
  { file: "invalid/i4.json", invariant: "I4", pathPrefix: "site.swimming_pool" },
  { file: "invalid/i5.json", invariant: "I5", pathPrefix: "site.primary_living_area_sqft" },
  { file: "invalid/i6.json", invariant: "I6", pathPrefix: "site.lot_outline" },
  { file: "invalid/i7.json", invariant: "I7", pathPrefix: "site.house_outline" },
  { file: "invalid/i8.json", invariant: "I8", pathPrefix: "plan.placement" },
  { file: "invalid/i9.json", invariant: "I9", pathPrefix: "site.primary_living_area_sqft" },
  { file: "invalid/i10.json", invariant: "I10", pathPrefix: "case_hash" },
  { file: "invalid/i11.json", invariant: "I11", pathPrefix: "unknowns" },
  { file: "invalid/i12.json", invariant: "I12", pathPrefix: "plan.living_area_sqft.by_reading" },
];

let passed = 0;
const total = VALID_CASES.length + INVALID_CASES.length;

for (const exp of VALID_CASES) {
  const fullPath = path.join(CASES_DIR, exp.file);
  const raw = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
  const res = checkCase(raw);

  const errors: string[] = [];
  if ("refused" in res) {
    errors.push(`unexpected refusal: [${res.invariant}] ${res.path ?? ""}: ${res.message}`);
  } else {
    if (res.case.case_id !== exp.case_id) {
      errors.push(`expected case_id ${exp.case_id}, got ${res.case.case_id}`);
    }
    if (!C.Sha256.safeParse(res.case_hash).success) {
      errors.push(`invalid case_hash: ${res.case_hash}`);
    }
    if (!C.Case.safeParse(res.case).success) {
      errors.push("materialized case failed C.Case check");
    }
    for (const key of C.COMPUTED_FACTS) {
      const entry = res.computed[key];
      if (!entry || !C.FactEntry.safeParse(entry).success) {
        errors.push(`missing or invalid computed fact ${key}`);
        continue;
      }
      if (!("value" in entry) || entry.prov[0]?.kind !== "computed" || entry.prov[0]?.by !== "lotfit.case-gate") {
        errors.push(`computed fact ${key} lacks computed source attribution`);
      }
    }
    const sbEntry = res.computed["plan.setbacks_used"];
    const sbVal = sbEntry && "value" in sbEntry ? sbEntry.value : undefined;
    if (JSON.stringify(sbVal) !== JSON.stringify(exp.setbacks_used)) {
      errors.push(`expected setbacks_used ${JSON.stringify(exp.setbacks_used)}, got ${JSON.stringify(sbVal)}`);
    }
    if (exp.extraCheck) {
      const extraErr = exp.extraCheck(res);
      if (extraErr) errors.push(extraErr);
    }
  }

  if (errors.length === 0 && !("refused" in res)) {
    passed += 1;
    console.log(`OK   ${exp.file.padEnd(18)} -> valid (${res.case.case_id}, sha256=${res.case_hash.slice(0, 12)}...)`);
  } else {
    console.log(`FAIL ${exp.file.padEnd(18)} -> ${errors.join("; ")}`);
  }
}

for (const exp of INVALID_CASES) {
  const fullPath = path.join(CASES_DIR, exp.file);
  const raw = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
  const res = checkCase(raw);

  const errors: string[] = [];
  if (!("refused" in res)) {
    errors.push(`expected refusal ${exp.invariant}, but case passed with hash ${res.case_hash}`);
  } else {
    if (!C.CaseRefusal.safeParse(res).success) {
      errors.push("refusal failed C.CaseRefusal schema check");
    }
    if (res.invariant !== exp.invariant) {
      errors.push(`expected invariant ${exp.invariant}, got ${res.invariant} (${res.message})`);
    }
    if (!res.path || !res.path.startsWith(exp.pathPrefix)) {
      errors.push(`expected path starting with ${exp.pathPrefix}, got ${res.path ?? "undefined"}`);
    }
  }

  if (errors.length === 0 && "refused" in res) {
    passed += 1;
    console.log(`OK   ${exp.file.padEnd(18)} -> refused [${res.invariant}] at ${res.path}`);
  } else {
    console.log(`FAIL ${exp.file.padEnd(18)} -> ${errors.join("; ")}`);
  }
}

console.log(`${passed}/${total} as expected`);
if (passed !== total) {
  process.exit(1);
}
