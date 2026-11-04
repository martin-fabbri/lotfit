import Link from "next/link";
import { LAYER_NAMES, rulebookStats, searchProvisions } from "@/lib/rulebook";
import { fmt } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Rulebook({ searchParams }: { searchParams: Promise<{ q?: string; layer?: string }> }) {
  const sp = await searchParams;
  const q = sp.q ?? "", layer = sp.layer && sp.layer in LAYER_NAMES ? sp.layer : "";
  const stats = rulebookStats();
  const res = searchProvisions(q, layer || undefined);
  return (
    <>
      <div className="head">
        <div>
          <div className="kicker">The Rulebook · graph {stats.sha.slice(0, 8)} · {stats.schema}</div>
          <h1>Zoning code as data</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 820 }}>Every provision with its versions, its clauses (each with the verbatim words), the numbers the law sets and the
            operator that says which instrument evaluates it. Built mechanically from {stats.documents} hashed source documents; no number is typed by a model.</p>
        </div>
      </div>
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="pb grid g3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
          {Object.entries(stats.layers).map(([k, L]) => (
            <Link key={k} href={`/rulebook?layer=${k}`} style={{ color: "var(--text)" }}>
              <div className="big-num">{fmt(L.provisions)}</div>
              <div className="stat-l">{LAYER_NAMES[k]} · {fmt(L.clauses)} clauses ({fmt(L.modeled)} modeled) · {fmt(L.params)} parameters · {fmt(L.cells)} table cells</div>
            </Link>
          ))}
        </div>
      </section>
      <form className="inline" style={{ marginBottom: 14 }} action="/rulebook">
        <input name="q" defaultValue={q} placeholder="Search: setback, accessory dwelling, 9.2751, flag lot…" aria-label="Search the Rulebook" style={{ maxWidth: 520 }} />
        <select name="layer" defaultValue={layer} aria-label="Layer" style={{ width: 170 }}>
          <option value="">All layers</option>
          {Object.entries(LAYER_NAMES).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
        <button className="btn primary" type="submit">Search</button>
      </form>
      <section className="panel">
        <div className="ph">Provisions <span className="mono">{fmt(res.total)}{res.total > res.items.length ? ` · first ${res.items.length}` : ""}</span></div>
        <table>
          <thead><tr><th>Provision</th><th>Title</th><th>Layer</th><th>Type</th><th className="num">Clauses (modeled)</th><th className="num">Parameters</th></tr></thead>
          <tbody>
            {res.items.map((p: any) => (
              <tr key={p.id}>
                <td><Link href={`/rulebook/${encodeURIComponent(p.id)}`} className="mono sect">{p.id}</Link></td>
                <td>{p.title}</td><td>{LAYER_NAMES[p.layer] ?? p.layer}</td><td className="muted">{p.type}</td>
                <td className="num">{p.clauses} ({p.modeled})</td><td className="num">{p.params}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
