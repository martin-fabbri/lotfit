import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import * as C from "./types.mts";

export type CaseInput = z.infer<typeof C.Case>;
export type ReportInput = z.infer<typeof C.Report>;
export type TraceOutput = z.infer<typeof C.Trace>;
export type PolygonType = z.infer<typeof C.Polygon>;
export type PlacementType = z.infer<typeof C.Placement>;
export type MeasureResultType = z.infer<typeof C.MeasureResult>;
export type ReportFindingType = z.infer<typeof C.ReportFinding>;

export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const src = value as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const v = src[k];
      if (v !== undefined) {
        out[k] = sortKeysDeep(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function formatTraceJson(trace: TraceOutput): string {
  return JSON.stringify(sortKeysDeep(trace), null, 2) + "\n";
}

function cleanNum(x: number): number {
  const r = Math.round(x * 1e6) / 1e6;
  if (Object.is(r, -0) || r === 0) return 0;
  if (Math.abs(r - Math.round(r)) < 1e-9) return Math.round(r);
  return r;
}

function unwrapFactValue(
  entry: z.infer<typeof C.FactEntry> | undefined,
  fact: string,
  conflicts: ReadonlySet<string>,
): unknown {
  if (entry === undefined) return undefined;
  if ("observations" in entry) {
    if (!conflicts.has(fact)) {
      throw new Error(`${fact} is conflicting in the case and the report does not list the conflict`);
    }
    return entry.observations[0]?.value;
  }
  return entry.value;
}

const conflictSet: (report: ReportInput | null) => ReadonlySet<string> = (report) =>
  new Set((report?.conflicts ?? []).map((c) => c.fact));

const normRot: (r: number | undefined) => number = (r) => (((r ?? 0) % 360) + 360) % 360;

function polygonBbox(poly: PolygonType): { x0: number; x1: number; y0: number; y1: number } {
  const xs = poly.map(([x]) => x);
  const ys = poly.map(([, y]) => y);
  return {
    x0: cleanNum(Math.min(...xs)),
    x1: cleanNum(Math.max(...xs)),
    y0: cleanNum(Math.min(...ys)),
    y1: cleanNum(Math.max(...ys)),
  };
}

export function placedOutline(footprint: PolygonType, placement: PlacementType): PolygonType {
  const rot = (((placement.rotation ?? 0) % 360) + 360) % 360;
  if (rot % 90 !== 0) {
    throw new Error(`placement.rotation must be a multiple of 90 degrees, got ${placement.rotation}`);
  }
  const [cosR, sinR]: [number, number] = rot === 0 ? [1, 0] : rot === 90 ? [0, 1] : rot === 180 ? [-1, 0] : [0, -1];
  const { x, y } = placement;
  return footprint.map(([px, py]) => [
    cleanNum(x + cosR * px - sinR * py),
    cleanNum(y + sinR * px + cosR * py),
  ]) as PolygonType;
}

export function traceFrame(): TraceOutput["frame"] {
  return {
    origin: "front-left",
    x: "along the front lot line",
    y: "to the rear",
    z: "up",
    units: "ft",
    three: { X: "x", Y: "z", Z: "-y" },
  };
}

export function buildSite(kase: CaseInput, conflicts: ReadonlySet<string> = new Set()): TraceOutput["site"] {
  const lotRaw = C.Polygon.parse(unwrapFactValue(kase.site["lot_outline"], "site.lot_outline", conflicts));
  const lot = lotRaw.map(([x, y]) => [cleanNum(x), cleanNum(y)]) as PolygonType;
  const north_deg = kase.context?.north_angle_deg ?? kase.capture?.north?.angle_deg ?? null;
  const north_uncertainty_deg =
    kase.context?.north_uncertainty_deg ?? kase.capture?.north?.uncertainty_deg ?? null;
  const existing: TraceOutput["site"]["existing"] = [];
  const houseParsed = C.Polygon.safeParse(
    unwrapFactValue(kase.site["house_outline"], "site.house_outline", conflicts),
  );
  if (houseParsed.success) {
    const hh = kase.context?.house_height_ft;
    existing.push({
      id: "house",
      kind: "house",
      outline: houseParsed.data.map(([x, y]) => [cleanNum(x), cleanNum(y)]) as PolygonType,
      height_ft: typeof hh === "number" ? cleanNum(hh) : null,
    });
  }
  const structures = unwrapFactValue(kase.site["structures"], "site.structures", conflicts);
  if (Array.isArray(structures)) {
    for (let idx = 0; idx < structures.length; idx++) {
      const item: unknown = structures[idx];
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`site.structures[${idx}] has no valid outline`);
      }
      const rec = item as Record<string, unknown>;
      const outlineParsed = C.Polygon.safeParse(rec["outline"]);
      if (!outlineParsed.success) {
        throw new Error(`site.structures[${idx}] has no valid outline`);
      }
      const rawId = rec["id"];
      const id = typeof rawId === "string" && rawId !== "" ? rawId : `structure_${idx + 1}`;
      const rawKind = rec["kind"];
      const kind =
        typeof rawKind === "string" && rawKind !== ""
          ? rawKind
          : typeof rawId === "string" && rawId !== ""
            ? rawId
            : "structure";
      const rawHft = rec["height_ft"];
      const rawH = rec["height"];
      const height_ft =
        typeof rawHft === "number" ? cleanNum(rawHft) : typeof rawH === "number" ? cleanNum(rawH) : null;
      if (existing.some((e) => e.id === id)) {
        throw new Error(`site.structures[${idx}] repeats the id ${id}`);
      }
      existing.push({
        id,
        kind,
        outline: outlineParsed.data.map(([x, y]) => [cleanNum(x), cleanNum(y)]) as PolygonType,
        height_ft,
      });
    }
  }
  return { lot, north_deg, north_uncertainty_deg, existing };
}

export function buildConstraints(report: ReportInput, lot: PolygonType): TraceOutput["constraints"] {
  const lotBox = polygonBbox(lot);
  const constraints: TraceOutput["constraints"] = [];
  for (const f of report.findings) {
    if (f.target !== "case") continue;
    const m0 = f.measures[0];
    const p0 = f.params[0];
    constraints.push({
      provision_id: f.provision_id,
      kind: f.evaluation_stage,
      zone: null,
      value: m0 ? cleanNum(m0.value) : p0 ? cleanNum(p0.value) : null,
      unit: m0 ? m0.unit : p0 ? p0.unit : null,
      outcome: f.outcome,
      measures: f.measures.map((m) => structuredClone(m)),
    });
  }
  const seen = new Set<string>();
  const order: string[] = [];
  for (const f of report.findings) {
    if (f.target === "case") continue;
    if (!seen.has(f.provision_id)) {
      seen.add(f.provision_id);
      order.push(f.provision_id);
    }
  }
  for (const provision_id of order) {
    const group = report.findings.filter((f) => f.target !== "case" && f.provision_id === provision_id);
    const preferred = group.find((f) => f.target === "selected_placement") ?? group[0]!;
    const sideParam = preferred.params.find((p) => p.param.includes("side_building_setback"));
    const rearParam = preferred.params.find((p) => p.param.includes("rear_building_setback"));
    const frontParam = preferred.params.find((p) => p.param.includes("front_lot_line_setback"));
    const cloneMeasures = () => preferred.measures.map((m) => structuredClone(m));
    if (sideParam || rearParam) {
      const { x0, x1, y0, y1 } = lotBox;
      if (sideParam && sideParam.value > 0 && x1 - x0 > sideParam.value * 2) {
        const s = cleanNum(sideParam.value);
        constraints.push({
          provision_id,
          kind: "setback",
          zone: [
            [x0, y0],
            [cleanNum(x0 + s), y0],
            [cleanNum(x0 + s), y1],
            [x0, y1],
          ],
          value: s,
          unit: sideParam.unit,
          outcome: preferred.outcome,
          measures: cloneMeasures(),
        });
        constraints.push({
          provision_id,
          kind: "setback",
          zone: [
            [cleanNum(x1 - s), y0],
            [x1, y0],
            [x1, y1],
            [cleanNum(x1 - s), y1],
          ],
          value: s,
          unit: sideParam.unit,
          outcome: preferred.outcome,
          measures: [],
        });
      }
      if (rearParam && rearParam.value > 0 && y1 - y0 > rearParam.value) {
        const r = cleanNum(rearParam.value);
        constraints.push({
          provision_id,
          kind: "setback",
          zone: [
            [x0, cleanNum(y1 - r)],
            [x1, cleanNum(y1 - r)],
            [x1, y1],
            [x0, y1],
          ],
          value: r,
          unit: rearParam.unit,
          outcome: preferred.outcome,
          measures: sideParam ? [] : cloneMeasures(),
        });
      }
    } else if (frontParam && frontParam.value > 0 && lotBox.y1 - lotBox.y0 > frontParam.value) {
      const fr = cleanNum(frontParam.value);
      constraints.push({
        provision_id,
        kind: "setback",
        zone: [
          [lotBox.x0, lotBox.y0],
          [lotBox.x1, lotBox.y0],
          [lotBox.x1, cleanNum(lotBox.y0 + fr)],
          [lotBox.x0, cleanNum(lotBox.y0 + fr)],
        ],
        value: fr,
        unit: frontParam.unit,
        outcome: preferred.outcome,
        measures: cloneMeasures(),
      });
    } else {
      const m0 = preferred.measures[0];
      const p0 = preferred.params[0];
      constraints.push({
        provision_id,
        kind: preferred.evaluation_stage,
        zone: null,
        value: m0 ? cleanNum(m0.value) : p0 ? cleanNum(p0.value) : null,
        unit: m0 ? m0.unit : p0 ? p0.unit : null,
        outcome: preferred.outcome,
        measures: cloneMeasures(),
      });
    }
  }
  return constraints;
}

function samePlacement(a: PlacementType | undefined | null, b: PlacementType | undefined | null): boolean {
  if (!a || !b) return false;
  return (
    cleanNum(a.x) === cleanNum(b.x) &&
    cleanNum(a.y) === cleanNum(b.y) &&
    cleanNum(normRot(a.rotation)) === cleanNum(normRot(b.rotation))
  );
}

function resolvePlacedOutlineInLotFrame(
  kase: CaseInput,
  placement: PlacementType,
  conflicts: ReadonlySet<string>,
): PolygonType {
  const outline = C.Polygon.safeParse(unwrapFactValue(kase.plan["outline"], "plan.outline", conflicts));
  if (outline.success) {
    const that = C.Placement.safeParse(unwrapFactValue(kase.plan["placement"], "plan.placement", conflicts));
    if (that.success && samePlacement(that.data, placement)) {
      return outline.data.map(([x, y]) => [cleanNum(x), cleanNum(y)]) as PolygonType;
    }
  }
  const footprint = C.Polygon.safeParse(unwrapFactValue(kase.plan["footprint"], "plan.footprint", conflicts));
  if (!footprint.success) {
    throw new Error("Case is missing a valid plan.footprint polygon");
  }
  return placedOutline(footprint.data, placement);
}

function summarizeFindingWhy(f: ReportFindingType): string {
  const parts = f.measures.map((m) => {
    const limit = m.limit;
    let limStr = "";
    if (limit) {
      const v = limit.value;
      const lim = typeof v === "number" ? cleanNum(v) : v;
      limStr = ` vs limit ${lim} ${limit.unit} (${limit.param})`;
    }
    const sign = m.margin >= 0 ? `+${cleanNum(m.margin)}` : `${cleanNum(m.margin)}`;
    return `${cleanNum(m.value)} ${m.unit}${limStr}, margin ${sign} ${m.unit}`;
  });
  const detail = parts.length > 0 ? parts.join("; ") : (f.citations[0]?.clause_id ?? f.evaluation_stage);
  return `${f.provision_id} [${f.outcome}]: ${detail}`;
}

export function buildOptions(report: ReportInput, kase: CaseInput): TraceOutput["options"] {
  const conflicts = conflictSet(report);
  const clientSpot = report.placement.client_spot;
  const recommended = report.placement.recommended;
  const clientFindings = report.findings.filter((f) => f.target === "client_spot");
  const selectedFindings = report.findings.filter((f) => f.target === "selected_placement");
  const options: TraceOutput["options"] = [];
  if (clientSpot) {
    const outline = resolvePlacedOutlineInLotFrame(kase, clientSpot.placement, conflicts);
    const why = clientFindings.map(summarizeFindingWhy);
    for (const id of clientSpot.failing) {
      if (!why.some((line) => line.startsWith(`${id} [`))) {
        why.push(`${id} [fail]: failed at client_spot`);
      }
    }
    for (const id of clientSpot.rejected_exceptions) {
      if (!why.some((line) => line.startsWith(`${id} [`))) {
        why.push(`${id} [fail]: exception conditions not met at client_spot`);
      }
    }
    const margins = clientFindings.flatMap((f) => f.measures.map((m) => structuredClone(m)));
    const status =
      clientSpot.passes === false || clientSpot.failing.length > 0 || clientSpot.rejected_exceptions.length > 0
        ? "rejected"
        : "conditional";
    options.push({
      id: "client_spot",
      status,
      placement: {
        x: cleanNum(clientSpot.placement.x),
        y: cleanNum(clientSpot.placement.y),
        rotation: cleanNum(clientSpot.placement.rotation ?? 0),
      },
      outline,
      why,
      margins,
    });
  }
  if (recommended) {
    const outline = resolvePlacedOutlineInLotFrame(kase, recommended.placement, conflicts);
    const why = selectedFindings.map(summarizeFindingWhy);
    if (why.length === 0) {
      why.push(`verdict ${report.verdict}: recommended placement clears required setbacks`);
    }
    const margins = recommended.margins.map((m) => structuredClone(m));
    for (const f of selectedFindings) {
      for (const m of f.measures) {
        const js = canonicalJson(m);
        if (!margins.some((e) => canonicalJson(e) === js)) {
          margins.push(structuredClone(m));
        }
      }
    }
    const status =
      report.verdict === "FITS"
        ? "selected"
        : report.verdict === "FITS_IF" || report.verdict === "NEEDS_CHECK" || report.verdict === "NOT_MODELED"
          ? "conditional"
          : "rejected";
    options.push({
      id: "selected_placement",
      status,
      placement: {
        x: cleanNum(recommended.placement.x),
        y: cleanNum(recommended.placement.y),
        rotation: cleanNum(recommended.placement.rotation ?? 0),
      },
      outline,
      why,
      margins,
    });
  }
  return options;
}
