import { runJson } from "@/lib/records";
import { fmt } from "@/lib/format";
import { VerdictChip } from "../../../ui";

export const dynamic = "force-dynamic";

const V: Record<string, string> = {
  V1_COVERAGE: "every provision in force has a finding (per target for placement rules)",
  V2_EVIDENCE: "every cited call has a request and a successful result in the log",
  V3_OUTCOME: "each finding's outcome equals its cited result",
  V4_NUMBER: "every number in a finding is found in the cited result",
  V5_VERDICT: "the model's proposed verdict equals the verdict code entails",
  V6_GEOMETRY: "the selected placement re-checks with every margin ≥ tolerance",
  V7_PARAMETER: "every limit equals the Rulebook parameter it cites",
  V8_GUARD: "every not-applicable cites a known-false guard",
};

export default async function Checks({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = runJson(id, "report.json"), sens = runJson(id, "sensitivity.json");
  if (!report) return <p className="muted">Checks run at the end of the run.</p>;
  const issues: any[] = report.verifier?.issues ?? [];
  const byCode = new Map<string, any[]>(); for (const i of issues) byCode.set(i.code, [...(byCode.get(i.code) ?? []), i]);
  const rv = report.reviewer ?? {};
  const branches: any[] = sens?.branches ?? [];
  const flips = branches.filter((b) => b.verdict !== sens?.nominal_verdict);
  return (
    <div className="grid g2">
      <section className="panel">
        <div className="ph">Verifier · deterministic code <span className={`chip ${report.verifier?.passed ? "c-ok" : "c-am"}`}>{report.verifier?.passed ? "PASSED" : `${issues.length} OPEN`}</span></div>
        <table>
          <tbody>
            {Object.entries(V).map(([code, what]) => {
              const open = byCode.get(code) ?? [];
              return (
                <tr key={code}>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{code.replace("_", " ")}</td>
                  <td>{what}{open.length ? <ul className="why">{open.map((o, i) => <li key={i} className="mono tiny">{o.provision_id ?? ""}{o.target ? ` → ${o.target}` : ""}</li>)}</ul> : null}</td>
                  <td>{open.length ? <span className="chip c-am">{open.length} open</span> : <span className="chip c-ok">✓</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <div className="grid" style={{ alignContent: "start" }}>
        <section className="panel">
          <div className="ph">Sensitivity · 0 model calls</div>
          <div className="pb">
            <p style={{ marginTop: 0 }}>Each fact moved within its tolerance, every finding recomputed. {branches.length} branches tried; {flips.length ? `${flips.length} would change the verdict` : "none changes the verdict"}.</p>
            <div className="inline">Nominal verdict <VerdictChip verdict={sens?.nominal_verdict ?? report.verdict} /></div>
            {(sens?.critical ?? []).length ? <p className="tiny muted">Critical facts: <span className="mono">{(sens.critical as any[]).map((c) => c.fact ?? c).join(", ")}</span></p> : null}
          </div>
        </section>
        <section className="panel">
          <div className="ph">Reviewer · Meta Muse Spark 1.3 <span className={`chip ${rv.status === "not_run" ? "c-dim" : rv.hold ? "c-am" : "c-ok"}`}>{String(rv.status ?? "not run").replace(/_/g, " ").toUpperCase()}</span></div>
          <div className="rows">
            <div className="row"><span className="muted">Items read</span><span className="mono">{rv.items ?? 0}</span></div>
            <div className="row"><span className="muted">Flags raised</span><span className="mono">{(rv.flags ?? []).length}</span></div>
            <div className="row"><span className="muted">Hold on the report</span><span className="mono">{rv.hold ? "yes" : "no"}</span></div>
            {(rv.flags ?? []).slice(0, 6).map((f: any, i: number) => <div key={i} className="tiny"><span className="mono">{f.severity ?? ""} {f.category ?? ""}</span> {f.message ?? f.note ?? ""}</div>)}
            <div className="tiny muted">A second, different model reads the report&apos;s flags. It can hold a report; it never changes a verdict.</div>
          </div>
        </section>
        <section className="panel">
          <div className="ph">Which version decided</div>
          <div className="rows">
            <div className="row"><span className="muted">case_hash</span><span className="mono tiny">{String(report.case_hash).slice(0, 24)}…</span></div>
            <div className="row"><span className="muted">graph_load_id</span><span className="mono tiny">{String(report.graph_load_id).slice(0, 24)}…</span></div>
            <div className="row"><span className="muted">config_hash</span><span className="mono tiny">{String(report.config_hash).slice(0, 24)}…</span></div>
            <div className="row"><span className="muted">model tokens</span><span className="mono">{fmt(report.telemetry?.tokens ?? 0)}</span></div>
          </div>
        </section>
      </div>
    </div>
  );
}
