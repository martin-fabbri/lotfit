import { fmt } from "@/lib/format";

// Shared, server-rendered pieces. Every shape drawn comes from a case or a trace; nothing is placed by hand.

export function VerdictChip({ verdict }: { verdict: string | null }) {
  const v = verdict ?? "RUNNING";
  const map: Record<string, [string, string]> = {
    FITS: ["c-fit", "✓ FITS"], FITS_IF: ["c-ok", "if FITS IF"], NEEDS_CHECK: ["c-am", "± NEEDS CHECK"],
    NO_LEGS: ["c-no", "✕ NO SPOT"], BLOCKED_BY_GATE: ["c-no", "✕ NOT ALLOWED"], NOT_MODELED: ["c-dim", "NOT MODELED"], RUNNING: ["c-dim", "NO VERDICT YET"],
  };
  const [cls, word] = map[v] ?? ["c-dim", v];
  return <span className={`chip ${cls}`}>{word}</span>;
}

export function OutcomeChip({ outcome }: { outcome: string }) {
  const map: Record<string, [string, string]> = {
    pass: ["c-ok", "✓ pass"], fail: ["c-no", "✕ fail"], too_close_to_call: ["c-am", "± too close to call"],
    unknown: ["c-am", "? not measured"], not_applicable: ["c-dim", "n/a"],
  };
  const [cls, word] = map[outcome] ?? ["c-dim", outcome];
  return <span className={`chip ${cls}`}>{word}</span>;
}

type Pt = [number, number];
export type Shape = { outline: Pt[]; kind: "house" | "adu" | "structure"; label?: string; tone?: string };
export type Dim = { from: Pt; to: Pt; label: string; tone?: string };

/** Top view in the lot frame (x along the front line, y to the rear, feet), street at the bottom. */
export function SitePlan({ lot, shapes, dims = [], width = 560, height = 560 }: { lot: Pt[]; shapes: Shape[]; dims?: Dim[]; width?: number; height?: number }) {
  if (!lot?.length) return null;
  const xs = lot.map((p) => p[0]), ys = lot.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 40, s = Math.min((width - 2 * pad) / (maxX - minX), (height - 2 * pad - 20) / (maxY - minY));
  const ox = (width - s * (maxX - minX)) / 2, oy = pad;
  const X = (x: number) => ox + (x - minX) * s, Y = (y: number) => oy + (maxY - y) * s;
  const pts = (o: Pt[]) => o.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
  const col: Record<string, string> = { ok: "#5ec4b0", fit: "#7eb6e6", am: "#e2b553", no: "#f28b82" };
  const center = (o: Pt[]): Pt => [o.reduce((a, p) => a + p[0], 0) / o.length, o.reduce((a, p) => a + p[1], 0) / o.length];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="svgbox" role="img" aria-label="Site plan, top view">
      <polygon points={pts(lot)} fill="rgba(94,196,176,.06)" stroke="#a2aba5" strokeWidth={1.5} strokeDasharray="6 4" />
      {shapes.map((sh, i) => {
        const c = sh.kind === "adu" ? col[sh.tone ?? "ok"] ?? col.ok : "#a2aba5";
        const [cx, cy] = center(sh.outline);
        return (
          <g key={i}>
            <polygon points={pts(sh.outline)} fill={sh.kind === "adu" ? `${c}33` : "rgba(162,171,165,.16)"} stroke={c} strokeWidth={sh.kind === "adu" ? 2.5 : 1.2} />
            <text x={X(cx)} y={Y(cy) + 4} textAnchor="middle" fill={c} fontSize={12} fontFamily="var(--font-mono)">{sh.label ?? sh.kind}</text>
          </g>
        );
      })}
      {dims.map((d, i) => {
        const c = col[d.tone ?? "am"] ?? "#f08a4b";
        const mx = (X(d.from[0]) + X(d.to[0])) / 2, my = (Y(d.from[1]) + Y(d.to[1])) / 2;
        return (
          <g key={`d${i}`}>
            <line x1={X(d.from[0])} y1={Y(d.from[1])} x2={X(d.to[0])} y2={Y(d.to[1])} stroke="#f08a4b" strokeWidth={2} />
            <circle cx={X(d.from[0])} cy={Y(d.from[1])} r={3} fill="#f08a4b" /><circle cx={X(d.to[0])} cy={Y(d.to[1])} r={3} fill="#f08a4b" />
            <rect x={mx + 6} y={my - 11} width={d.label.length * 7.4 + 12} height={22} rx={2} fill="#18201d" stroke={c} />
            <text x={mx + 12} y={my + 4} fill="#ebeee8" fontSize={12} fontFamily="var(--font-mono)">{d.label}</text>
          </g>
        );
      })}
      <text x={(X(minX) + X(maxX)) / 2} y={Y(minY) + 24} textAnchor="middle" fill="#6e7a74" fontSize={11} letterSpacing={3} fontFamily="var(--font-mono)">STREET</text>
      <text x={(X(minX) + X(maxX)) / 2} y={Y(maxY) - 10} textAnchor="middle" fill="#a2aba5" fontSize={11} fontFamily="var(--font-mono)">{fmt(maxX - minX)} ft</text>
      <text x={X(minX) - 12} y={(Y(minY) + Y(maxY)) / 2} textAnchor="middle" fill="#a2aba5" fontSize={11} fontFamily="var(--font-mono)" transform={`rotate(-90 ${X(minX) - 12} ${(Y(minY) + Y(maxY)) / 2})`}>{fmt(maxY - minY)} ft</text>
    </svg>
  );
}

/** A plan footprint placed at {x, y, rotation} (rotation 0 or 90, as the cases use). */
export function placeFootprint(fp: Pt[], pl: { x: number; y: number; rotation?: number }): Pt[] {
  const r = ((pl.rotation ?? 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return fp.map(([x, y]) => [pl.x + x * c - y * s, pl.y + x * s + y * c] as Pt);
}
