import { notFound } from "next/navigation";
import { readCase } from "@/lib/records";
import { fmt } from "@/lib/format";
import { CloudView } from "./cloud";

export const dynamic = "force-dynamic";

export default async function Capture({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const kase = readCase(name);
  if (!kase?.capture) notFound();
  const cap = kase.capture, tol = cap.tolerances_95pct ?? {}, co = tol.coefficients ?? {};
  const rear = kase.site?.rear_lot_line;
  const at10 = typeof co.sigma_lidar_m === "number" ? 1.96 * Math.sqrt(co.sigma_lidar_m ** 2 + (co.scale_error_eff * 10) ** 2 + (co.loop_gap_per_m * 10) ** 2 + co.sigma_tracking_m ** 2) : null;
  const scanned = name.startsWith("eug-demo") && name.includes("scanline");
  return (
    <>
      <div className="head">
        <div>
          <div className="kicker">Capture · {cap.capture_id}</div>
          <h1>The scan behind this case</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 820 }}>Phone LiDAR and printed ArUco markers, merged into one point cloud of the lot, placed on the county records.
            Every fact the scan gives carries its 95 % error into the case, so a margin smaller than that error is never called pass or fail.</p>
        </div>
        <span className={`chip ${cap.grade === "fail" ? "c-am" : "c-ok"}`}>GRADE {String(cap.grade).toUpperCase()}{cap.provisional ? " · PROVISIONAL" : ""}</span>
      </div>
      <div className="grid g-side">
        <section className="panel">
          <div className="ph">Point cloud, lot frame <span className="mono">{scanned ? "200,000 of 3,762,133 points" : "not available"}</span></div>
          {scanned ? <CloudView src="/capture/eug-demo-cloud.bin" lot={kase.site?.lot_outline?.value ?? []} house={kase.site?.house_outline?.value ?? []}
            spot={kase.plan?.footprint?.value && kase.plan?.placement?.value ? { fp: kase.plan.footprint.value, pl: kase.plan.placement.value } : null} />
            : <p className="pb muted">This case's capture has no cloud on this host.</p>}
        </section>
        <div className="grid">
          <section className="panel">
            <div className="ph">How sure the scan is</div>
            <div className="pb stack">
              <code className="tiny" style={{ whiteSpace: "pre-wrap" }}>{tol.formula}</code>
              <div className="rows" style={{ margin: "0 -14px" }}>
                {[["σ LiDAR", co.sigma_lidar_m, "m"], ["scale error (effective)", co.scale_error_eff, ""], ["loop-closure gap", co.loop_closure_gap_m, "m"],
                  ["walk length", co.walk_length_m, "m"], ["σ tracking", co.sigma_tracking_m, "m"]].map(([k, v, u]) => (
                  <div key={String(k)} className="row"><span className="muted">{k}</span><span className="mono">{typeof v === "number" ? (Math.abs(v as number) < 1 ? Number((v as number).toPrecision(3)).toString() : fmt(v as number)) : "–"} {u}</span></div>))}
                <div className="row"><b>95 % error at {tol.reference_range_m ?? 10} m</b><b className="mono">{at10 != null ? `${fmt(at10)} m · ${fmt(at10 * 3.28084)} ft` : "–"}</b></div>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="ph">Scan meets the record · rear lot line</div>
            <div className="rows">
              {(rear?.prov ?? []).map((p: any, i: number) => (
                <div key={i}>
                  <div className="row"><span className={`chip ${p.role === "used" ? "c-ok" : "c-dim"}`}>{p.role === "used" ? "USED" : String(p.role ?? p.kind).toUpperCase()}</span><span className="mono">{p.tolerance ? `±${fmt(p.tolerance.value)} ${p.tolerance.unit}` : ""}</span></div>
                  <div className="tiny" style={{ marginTop: 4 }}>{p.document}</div>
                  {p.where ? <div className="tiny muted">{p.where}</div> : null}
                  {p.status ? <div className="tiny muted">{p.status}</div> : null}
                </div>))}
              <div className="tiny muted">Status of every lot line: {rear?.status}</div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
