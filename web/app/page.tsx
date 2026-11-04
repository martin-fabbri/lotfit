import Link from "next/link";
import { listCases, listRuns } from "@/lib/records";
import { engineAvailable } from "@/lib/paths";
import { liveStatus } from "@/lib/engine";
import { rulebookStats, LAYER_NAMES } from "@/lib/rulebook";
import { fmt } from "@/lib/format";
import { VerdictChip } from "./ui";

export const dynamic = "force-dynamic";

const CITY: Record<string, string> = { EUG: "Eugene", PDX: "Portland", GRE: "Gresham" };
const MODE: Record<string, string> = { check_spot: "check the owner's spot", find_spot: "find a spot", propose: "propose" };

export default function Home() {
  const cases = listCases().filter((c) => !c.name.startsWith("s") || c.city !== "");
  const runs = listRuns();
  const live = liveStatus();
  const liveId = live.running ? live.run : null;
  const rb = rulebookStats();
  return (
    <>
      <div className="head">
        <div>
          <div className="kicker">LotFit · pre-feasibility for backyard cottages</div>
          <h1>Does it fit on this lot?</h1>
          <p className="muted" style={{ maxWidth: 760, margin: 0 }}>
            A case holds the lot, the house and the plan, every fact with its source and tolerance. A run reads the city&apos;s code
            from the Rulebook; Meta Muse Spark plans and calls the instruments; deterministic code computes every outcome and the verdict.
          </p>
        </div>
        <span className={`chip ${engineAvailable() ? "c-ok" : "c-dim"}`}>{engineAvailable() ? "ENGINE ON THIS MACHINE" : "RECORDED RUNS"}</span>
      </div>

      <div className="grid g-side">
        <section className="panel">
          <div className="ph">Runs <span className="mono">{runs.length}</span></div>
          <table>
            <thead><tr><th>Started</th><th>City</th><th>Verdict</th><th className="num">Turns</th><th className="num">Tool calls</th><th className="num">Findings</th><th className="num">Model cost</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/runs/${r.id}`} className="mono">{r.started.slice(0, 16).replace("T", " ")}</Link>{r.recorded ? <span className="src">recorded in the repo</span> : null}</td>
                  <td>{CITY[r.city ?? ""] ?? r.city}</td>
                  <td>{r.done ? <VerdictChip verdict={r.verdict} /> : r.id === liveId ? <span className="chip c-am">● RUNNING</span> : <span className="chip c-dim">STOPPED</span>}</td>
                  <td className="num">{r.turns ?? "–"}</td><td className="num">{r.calls ?? "–"}</td><td className="num">{r.findings ?? "–"}</td>
                  <td className="num">{r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <div className="ph">Cases <span className="mono">{cases.length}</span></div>
          <div className="rows">
            {cases.map((c) => (
              <Link key={c.name} href={`/cases/${c.name}`} className="row" style={{ color: "var(--text)" }}>
                <span><b className="mono">{c.name}</b><span className="src">{CITY[c.city] ?? c.city} · zone {c.zone} · {MODE[c.mode] ?? c.mode}{c.capture ? " · scanned" : ""}</span></span>
                <span className="mono muted">{c.plan_sqft ? `${fmt(c.plan_sqft)} sq ft` : ""}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="ph">The Rulebook <Link href="/rulebook">open</Link></div>
        <div className="pb grid g3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
          {Object.entries(rb.layers).map(([k, L]) => (
            <div key={k}><div className="big-num">{fmt(L.provisions)}</div><div className="stat-l">{LAYER_NAMES[k] ?? k} provisions · {fmt(L.params)} parameters · {fmt(L.modeled)} modeled clauses</div></div>
          ))}
          <div><div className="big-num">{rb.documents}</div><div className="stat-l">source documents · graph {rb.sha.slice(0, 8)}</div></div>
        </div>
      </section>
    </>
  );
}
