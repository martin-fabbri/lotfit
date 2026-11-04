import Link from "next/link";
import { runEvents, runJson } from "@/lib/records";
import { fmt, verdictView } from "@/lib/format";
import { SitePlan, type Shape } from "../../ui";

export const dynamic = "force-dynamic";

export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = runJson(id, "report.json"), trace = runJson(id, "trace.json"), plan = runJson(id, "plan.json");
  const ev = runEvents(id);
  const t = report?.telemetry ?? {};
  const v = report ? verdictView(report) : null;
  const shapes: Shape[] = [
    ...(trace?.site?.existing ?? []).map((e: any) => ({ outline: e.outline, kind: "house" as const, label: e.kind })),
    ...(trace?.options ?? []).filter((o: any) => o.outline).map((o: any) => ({ outline: o.outline, kind: "adu" as const, label: "ADU",
      tone: o.status === "selected" ? "fit" : o.status === "conditional" ? "am" : "no" })),
  ];
  const stats: [string, string][] = [
    ["turns", String(t.turns ?? ev.filter((e) => e.type === "turn_started").length)],
    ["tool calls", String(t.calls ?? ev.filter((e) => e.type === "tool_requested").length)],
    ["rules that apply", String(plan?.applies?.length ?? "–")],
    ["findings", String(report?.findings?.length ?? ev.filter((e) => e.type === "lotfit.finding_recorded").length)],
    ["events", fmt(ev.length)],
    ["model cost", t.cost_usd != null ? `$${t.cost_usd.toFixed(2)}` : "–"],
  ];
  return (
    <div className="grid g-side">
      <section className="panel">
        <div className="ph">The spot on the lot</div>
        {trace ? <SitePlan lot={trace.site?.lot ?? []} shapes={shapes} width={640} height={520} /> : <p className="pb muted">The trace is written at the end of the run.</p>}
      </section>
      <div className="grid" style={{ alignContent: "start" }}>
        <section className="panel"><div className="pb grid g3">{stats.map(([k, x]) => <div key={k}><div className="big-num">{x}</div><div className="stat-l">{k}</div></div>)}</div></section>
        {v ? (
          <section className="panel"><div className="pb">
            <div className="verdict-big" style={{ color: v.tone === "ok" ? "var(--fit)" : v.tone === "no" ? "var(--no)" : "var(--check)" }}>{v.big}</div>
            <ul className="why">{v.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
            <p style={{ marginBottom: 0 }}><Link href={`/runs/${id}/verdict`}>Every outcome, with its clause →</Link></p>
          </div></section>
        ) : <section className="panel"><div className="pb"><p className="muted" style={{ margin: 0 }}>This run is still going. <Link href={`/runs/${id}/log`}>Watch the agent at work →</Link></p></div></section>}
      </div>
    </div>
  );
}
