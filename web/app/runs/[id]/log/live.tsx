"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buildLog, type LogLine } from "@/lib/format";

/** The run's event log: replayed at a chosen speed, or followed live while the run is still going. */
export function LiveLog({ id, initial, done, model }: { id: string; initial: LogLine[]; done: boolean; model: string }) {
  const router = useRouter();
  const [lines, setLines] = useState(initial);
  const [shown, setShown] = useState(done ? 0 : initial.length);
  const [speed, setSpeed] = useState(done ? 8 : 0);
  const [live, setLive] = useState(!done);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {   // follow a run in progress
    if (!live) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/runs/${id}/events.jsonl`, { cache: "no-store" });
      if (!r.ok) return;
      const ev = (await r.text()).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const next = buildLog(ev);
      setLines(next); setShown(next.length);
      const rep = await fetch(`/api/runs/${id}/report.json`, { cache: "no-store" });
      if (rep.ok) { setLive(false); router.refresh(); }
    }, 1500);
    return () => clearInterval(t);
  }, [live, id, router]);

  useEffect(() => {   // replay a finished run
    if (live || speed === 0 || shown >= lines.length) return;
    const t = setTimeout(() => setShown((n) => Math.min(lines.length, n + 1)), 1000 / speed);
    return () => clearTimeout(t);
  }, [live, speed, shown, lines.length]);

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [shown]);

  const c = shown > 0 ? lines[shown - 1].counts : { turns: 0, calls: 0, cost: 0, findings: 0, exclusions: 0, errors: 0 };
  const stats: [string, string][] = [["Model", model], ["Turns", String(c.turns)], ["Tool calls", String(c.calls)], ["Model cost", `$${c.cost.toFixed(2)}`],
    ["Findings", String(c.findings)], ["Exclusions", String(c.exclusions)], ["Refused and repaired", String(c.errors)]];
  return (
    <div className="grid g-side">
      <section className="panel">
        <div className="ph">
          <span>Event log · {live ? <span className="chip c-am">LIVE</span> : <span className="mono">{shown} / {lines.length}</span>}</span>
          {!live ? (
            <span className="inline">
              {[0, 2, 8, 30].map((s) => <button key={s} className="btn" style={{ padding: "3px 8px" }} onClick={() => setSpeed(s)} aria-pressed={speed === s}>{s === 0 ? "pause" : `${s}×`}</button>)}
              <button className="btn" style={{ padding: "3px 8px" }} onClick={() => { setShown(lines.length); setSpeed(0); }}>all</button>
              <button className="btn" style={{ padding: "3px 8px" }} onClick={() => { setShown(0); setSpeed(8); }}>replay</button>
            </span>
          ) : null}
        </div>
        <div className="term" ref={box}>
          {lines.slice(0, shown).map((l, i) => <div key={i} className={`ln ${l.cls}`} dangerouslySetInnerHTML={{ __html: l.html }} />)}
        </div>
      </section>
      <section className="panel" style={{ alignSelf: "start" }}>
        <div className="ph">The run</div>
        <div className="rows">{stats.map(([k, v]) => <div key={k} className="row"><span className="muted">{k}</span><span className="mono">{v}</span></div>)}</div>
        <div className="pb tiny muted">Every line is an event the harness appended to <span className="mono">events.jsonl</span>: the model&apos;s calls, the instruments&apos; results, the harness refusing a wrong step and the model repairing it, each finding, the verifier, and the verdict computed by deterministic code.</div>
      </section>
    </div>
  );
}
