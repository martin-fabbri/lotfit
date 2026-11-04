"use client";
import Link from "next/link";
import { useState } from "react";

type R = { id: string; quote: string; basis?: string };

export function RuleLists({ applies, excluded }: { applies: R[]; excluded: R[] }) {
  const [q, setQ] = useState("");
  const f = (r: R) => !q || r.id.toLowerCase().includes(q.toLowerCase()) || r.quote.toLowerCase().includes(q.toLowerCase());
  const col = (title: string, list: R[], chip: string, cls: string) => (
    <section className="panel">
      <div className="ph">{title} <span className="mono">{list.filter(f).length} of {list.length}</span></div>
      <div className="rows">
        {list.filter(f).map((r) => (
          <div key={r.id}>
            <div className="row"><Link href={`/rulebook/${encodeURIComponent(r.id)}`} className="mono sect">{r.id}</Link><span className={`chip ${cls}`}>{chip}</span></div>
            <div className="q" style={{ marginTop: 4 }}>{r.quote}</div>
            {r.basis ? <div className="src">{r.basis.replace(/_/g, " ")}</div> : null}
          </div>
        ))}
      </div>
    </section>
  );
  return (
    <>
      <div className="inline" style={{ marginBottom: 12, maxWidth: 420 }}>
        <label htmlFor="rq" className="tiny">Filter</label>
        <input id="rq" placeholder="setback, 9.2751, flag lot…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid g2">{col("Applies", applies, "APPLIES", "c-ok")}{col("Excluded", excluded, "EXCLUDED", "c-dim")}</div>
    </>
  );
}
