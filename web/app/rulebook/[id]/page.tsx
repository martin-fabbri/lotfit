import Link from "next/link";
import { notFound } from "next/navigation";
import { LAYER_NAMES, exists, provision } from "@/lib/rulebook";
import { fmt } from "@/lib/format";

export const dynamic = "force-dynamic";

/** The provision's neighbourhood in the graph, drawn from its own records: Provision → Version → Clause | Parameter, Operator → Tool, Fact. */
function Neighbourhood({ p }: { p: NonNullable<ReturnType<typeof provision>> }) {
  const W = 980, H = 366;
  type N = { x: number; y: number; w: number; label: string; sub: string; kind: "data" | "code" };
  const mk = (x: number, y: number, label: string, sub: string, kind: "data" | "code" = "data"): N => ({ x, y, label, sub, kind, w: Math.max(132, Math.max(label.length * 7.4, sub.length * 6.6) + 26) });
  const modeled = p.clauses.filter((c) => c.status === "modeled").length;
  const op = p.operators[0];
  const prov = mk(110, 50, "Provision", p.id.length > 22 ? p.id.slice(0, 22) + "…" : p.id);
  const ver = mk(400, 50, "Version", p.effective_from ? `from ${p.effective_from}` : "in force");
  const cl = mk(720, 50, `Clause × ${p.clauses.length}`, `${modeled} modeled`);
  const params = p.params.slice(0, 4).map((x, i) => mk(300 + i * 190, 150, String(x.name).slice(0, 24), `${typeof x.value === "number" ? fmt(x.value) : String(x.value)} ${x.unit ?? ""}`));
  const opN = op ? mk(110, 250, "Operator", op.id, "code") : null;
  const tool = op ? mk(400, 250, "Tool", op.tool, "code") : null;
  const facts = op ? (op.reads as string[]).slice(0, 3).map((f, i) => mk(800, 225 + i * 52, "Fact", f, "code")) : [];
  const box = (n: N, key: string) => (
    <g key={key}>
      <rect x={n.x - n.w / 2} y={n.y - 21} width={n.w} height={42} rx={2} fill={n.kind === "code" ? "#16443d" : "#18201d"} stroke={n.kind === "code" ? "#5ec4b0" : "#a2aba5"} strokeWidth={1.4} />
      <text x={n.x} y={n.y - 3} textAnchor="middle" fill="#ebeee8" fontSize={13} fontWeight={600} fontFamily="var(--font-sans)">{n.label}</text>
      <text x={n.x} y={n.y + 13} textAnchor="middle" fill="#a2aba5" fontSize={11} fontFamily="var(--font-mono)">{n.sub}</text>
    </g>
  );
  const arrow = (x1: number, y1: number, x2: number, y2: number, label: string, key: string, col = "#6e7a74", lx = 0, ly = -6) => (
    <g key={key}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={1.3} markerEnd="url(#ah)" />
      {label ? <text x={(x1 + x2) / 2 + lx} y={(y1 + y2) / 2 + ly} textAnchor="middle" fill={col} fontSize={10} fontFamily="var(--font-mono)">{label}</text> : null}</g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="svgbox" style={{ maxWidth: 1100, margin: "0 auto" }} role="img" aria-label={`Graph neighbourhood of ${p.id}`}>
      <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#6e7a74" /></marker></defs>
      {arrow(prov.x + prov.w / 2, 50, ver.x - ver.w / 2, 50, "HAS_VERSION", "e1")}
      {arrow(ver.x + ver.w / 2, 50, cl.x - cl.w / 2, 50, "HAS_CLAUSE", "e2")}
      {params.map((n, i) => arrow(ver.x, 71, n.x, n.y - 21, i === 0 ? "HAS_PARAMETER" : "", `ep${i}`, "#6e7a74", -46, 0))}
      {opN ? arrow(opN.x, opN.y - 21, prov.x, prov.y + 21, "MODELS", "eo", "#5ec4b0", 30, 0) : null}
      {opN && tool ? arrow(opN.x + opN.w / 2, 250, tool.x - tool.w / 2, 250, "RUNS_TOOL", "et", "#5ec4b0") : null}
      {facts.map((f, i) => arrow(tool!.x + tool!.w / 2, 250, f.x - f.w / 2, f.y, i === 0 ? "READS_FACT" : "", `ef${i}`, "#5ec4b0", 0, -8))}
      {[prov, ver, cl, ...params, ...(opN ? [opN] : []), ...(tool ? [tool] : []), ...facts].map((n, i) => box(n, `n${i}`))}
      {!op ? <text x={W / 2} y={255} textAnchor="middle" fill="#6e7a74" fontSize={12} fontFamily="var(--font-mono)">no operator models this provision: it is read, not measured</text> : null}
    </svg>
  );
}

export default async function ProvisionPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const p = provision(id);
  if (!p) notFound();
  return (
    <>
      <div className="head">
        <div>
          <div className="kicker"><Link href="/rulebook">Rulebook</Link> · {LAYER_NAMES[p.layer] ?? p.layer} · {p.type}</div>
          <h1><span className="mono sect">{p.id}</span></h1>
          <p className="muted" style={{ margin: 0 }}>{p.title}{p.section ? ` · section ${p.section}` : ""}{p.page ? ` · page ${p.page}` : ""}{p.effective_from ? ` · in force from ${p.effective_from}` : ""}</p>
          {p.document ? <p className="tiny" style={{ margin: "4px 0 0" }}>{p.document.url ? <a href={p.document.url} target="_blank" rel="noreferrer">{p.document.title}</a> : p.document.title} <span className="muted">· {p.document.version}</span></p> : null}
        </div>
      </div>
      <section className="panel" style={{ marginBottom: 16 }}><div className="ph">In the graph</div><Neighbourhood p={p} /></section>
      <div className="grid g-side">
        <section className="panel">
          <div className="ph">Clauses · the text, cut into pieces that cover it exactly <span className="mono">{p.clauses.length}</span></div>
          <div className="pb">
            {p.clauses.map((c) => (
              <div key={c.id} className={`clause ${c.status}`}>
                <div className="row tiny"><span className="mono muted">{c.id} · {c.kind}</span><span className={`chip ${c.status === "modeled" ? "c-ok" : c.status === "not_modeled" ? "c-am" : "c-dim"}`}>{String(c.status).replace("_", " ")}</span></div>
                <div style={{ marginTop: 4 }}>{c.quote}</div>
                {(c.guards ?? []).length ? <div className="src">guards: {(c.guards as any[]).map((g) => `${g.fact} ${g.op} ${g.value ?? ""}`).join(" · ")}</div> : null}
                {(c.by ?? []).length ? <div className="src">modeled by {(c.by as string[]).join(", ")}</div> : null}
              </div>
            ))}
          </div>
        </section>
        <div className="grid" style={{ alignContent: "start" }}>
          <section className="panel">
            <div className="ph">Parameters · numbers the law sets <span className="mono">{p.params.length}</span></div>
            <div className="rows">
              {p.params.length ? p.params.map((x, i) => (
                <div key={i}><div className="row"><span className="mono">{x.name}</span><b className="mono">{typeof x.value === "number" ? fmt(x.value) : String(x.value)} {x.unit ?? ""}</b></div>
                  {x.quote ? <div className="q">{x.quote}</div> : x.cell ? <div className="src">from table cell {x.cell}</div> : null}</div>)) : <div className="muted">none</div>}
            </div>
          </section>
          {p.operators.map((o: any) => (
            <section key={o.id} className="panel">
              <div className="ph">Operator · how code evaluates it <span className="chip c-ok">{o.kind}</span></div>
              <div className="rows">
                <div className="row"><span className="muted">operator</span><span className="mono">{o.id}</span></div>
                <div className="row"><span className="muted">instrument</span><span className="mono">{o.tool}</span></div>
                <div><span className="muted">reads</span> <span className="mono tiny">{o.reads.join(", ")}</span></div>
                <div><span className="muted">parameters</span> <span className="mono tiny">{o.params.map((x: any) => `${x.provision}:${x.param}`).join(", ")}</span></div>
                {o.note ? <div className="tiny muted">{o.note}</div> : null}
              </div>
            </section>
          ))}
          {p.relations.length || p.refers_to.length ? (
            <section className="panel">
              <div className="ph">Relations</div>
              <div className="rows">
                {p.relations.map((r, i) => <div key={i}><span className="chip c-dim">{String(r.kind).toUpperCase()}</span> <Link className="mono" href={`/rulebook/${encodeURIComponent(r.from === p.id ? r.to : r.from)}`}>{r.from === p.id ? r.to : r.from}</Link>{r.quote ? <div className="q">{r.quote}</div> : null}</div>)}
                {p.refers_to.filter(exists).map((x) => <div key={x}><span className="chip c-dim">REFERS TO</span> <Link className="mono" href={`/rulebook/${encodeURIComponent(x)}`}>{x}</Link></div>)}
              </div>
            </section>
          ) : null}
          {p.cells_total ? <section className="panel"><div className="ph">Table cells <span className="mono">{p.cells_total}</span></div>
            <div className="rows">{p.cells.slice(0, 12).map((c: any, i: number) => <div key={i} className="row tiny"><span className="mono muted">{[c.row, c.column].filter(Boolean).join(" · ") || c.id}</span><span className="mono">{c.text ?? c.value}</span></div>)}</div></section> : null}
        </div>
      </div>
    </>
  );
}
