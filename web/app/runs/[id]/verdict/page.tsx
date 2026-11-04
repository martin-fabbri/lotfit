import Link from "next/link";
import { runJson } from "@/lib/records";
import { findingRows, fmt, verdictView, unitWord } from "@/lib/format";
import { OutcomeChip, SitePlan, type Dim, type Shape } from "../../../ui";

export const dynamic = "force-dynamic";
type Pt = [number, number];

/** A dimension line is drawn only where a measured value from the report matches the gap between the spot and a lot line. */
function dimsFor(lot: Pt[], outline: Pt[], margins: any[]): Dim[] {
  const lx = lot.map((p) => p[0]), ly = lot.map((p) => p[1]), sx = outline.map((p) => p[0]), sy = outline.map((p) => p[1]);
  const L = { x0: Math.min(...lx), x1: Math.max(...lx), y0: Math.min(...ly), y1: Math.max(...ly) };
  const S = { x0: Math.min(...sx), x1: Math.max(...sx), y0: Math.min(...sy), y1: Math.max(...sy) };
  const mx = (S.x0 + S.x1) / 2, my = (S.y0 + S.y1) / 2;
  const sides: { d: number; from: Pt; to: Pt }[] = [
    { d: L.y1 - S.y1, from: [mx, S.y1], to: [mx, L.y1] }, { d: S.x0 - L.x0, from: [S.x0, my], to: [L.x0, my] },
    { d: L.x1 - S.x1, from: [S.x1, my], to: [L.x1, my] }, { d: S.y0 - L.y0, from: [mx, S.y0], to: [mx, L.y0] },
  ];
  const out: Dim[] = [];
  for (const m of margins) {
    if (typeof m?.value !== "number" || m.unit !== "ft") continue;
    const side = sides.find((s) => Math.abs(s.d - m.value) < 0.06);
    if (side && !out.some((o) => o.from[0] === side.from[0] && o.from[1] === side.from[1]))
      out.push({ ...side, label: `${fmt(m.value)} ft${m.limit ? ` · min ${fmt(m.limit.value)}` : ""}`, tone: m.too_close_to_call ? "am" : m.pass === false ? "no" : "ok" });
  }
  return out;
}

export default async function Answer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = runJson(id, "report.json"), trace = runJson(id, "trace.json");
  if (!report) return <p className="muted">The answer is written at the end of the run. <Link href={`/runs/${id}/log`}>Watch the run →</Link></p>;
  const v = verdictView(report);
  const rows = findingRows(report);
  const opt = (trace?.options ?? []).find((o: any) => o.status === "selected") ?? (trace?.options ?? [])[0];
  const lot: Pt[] = trace?.site?.lot ?? [];
  const shapes: Shape[] = [
    ...(trace?.site?.existing ?? []).map((e: any) => ({ outline: e.outline, kind: "house" as const, label: e.kind })),
    ...(opt?.outline ? [{ outline: opt.outline, kind: "adu" as const, label: "ADU", tone: opt.status === "selected" ? "fit" : opt.status === "conditional" ? "am" : "no" }] : []),
  ];
  const dims = opt?.outline ? dimsFor(lot, opt.outline, opt.margins ?? []) : [];
  const tape = (report.findings ?? []).flatMap((f: any) => (f.measures ?? []).filter((m: any) => m.too_close_to_call).map((m: any) => ({ f, m })));
  const tone = v.tone === "ok" ? "var(--fit)" : v.tone === "no" ? "var(--no)" : "var(--check)";
  return (
    <div className="grid g-side">
      <section className="panel">
        <div className="ph">Findings <span className="mono">{rows.length}</span></div>
        <div className="rows">
          {rows.map((r, i) => (
            <div key={i}>
              <div className="row"><span><Link href={`/rulebook/${encodeURIComponent(r.id)}`} className="mono sect">{r.id}</Link> <span className="src" style={{ display: "inline" }}>{r.target === "case" ? "the plan" : "the spot"}</span></span><OutcomeChip outcome={r.outcome} /></div>
              {r.nums ? <div className="mono" style={{ fontSize: 13, marginTop: 4 }} dangerouslySetInnerHTML={{ __html: r.nums }} /> : null}
              <div className="q" style={{ marginTop: 4 }}>{r.quote}</div>
            </div>
          ))}
        </div>
      </section>
      <div className="grid" style={{ alignContent: "start" }}>
        <section className="panel">
          <div className="ph">The spot</div>
          <SitePlan lot={lot} shapes={shapes} dims={dims} width={560} height={420} />
        </section>
        <section className="panel"><div className="pb">
          <div className="verdict-big" style={{ color: tone }}>{v.big}</div>
          <ul className="why">{v.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div></section>
        {tape.length ? (
          <section className="panel" style={{ borderColor: "var(--check)" }}>
            <div className="ph" style={{ color: "var(--check)" }}>Tape this</div>
            <div className="rows">{tape.map(({ f, m }: any, i: number) => (
              <div key={i}><b>{m.dimension_to_tape ?? "this distance"}</b>
                <div className="mono tiny" style={{ marginTop: 4 }}>{fmt(m.value)} {unitWord(m.unit)} measured · limit {fmt(m.limit?.value)} {unitWord(m.unit)} · margin {fmt(m.margin)} · tolerance ±{fmt(m.tolerance)} {unitWord(m.unit)}</div>
                <div className="src">{f.provision_id}: the margin is inside the measurement&apos;s tolerance, so LotFit doesn&apos;t guess.</div></div>))}</div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
