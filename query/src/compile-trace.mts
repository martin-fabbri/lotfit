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
