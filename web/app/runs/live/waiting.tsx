"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Waits for the run the engine just started to open its event log, then follows it. */
export function Waiting() {
  const router = useRouter();
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    const t = setInterval(async () => {
      const r = await fetch("/api/live", { cache: "no-store" });
      const j = await r.json(); setS(j);
      if (j.run) { clearInterval(t); router.replace(`/runs/${j.run}/log`); }
    }, 1000);
    return () => clearInterval(t);
  }, [router]);
  return (
    <section className="panel" style={{ maxWidth: 640 }}>
      <div className="ph">Starting the run</div>
      <div className="pb">
        <p style={{ marginTop: 0 }}>Gate: the case check runs first; then the Planner reads the code.</p>
        <p className="mono tiny muted" style={{ marginBottom: 0 }}>{s ? (s.running ? `case ${s.case} · running` : s.exit != null ? `ended with code ${s.exit}` : "waiting") : "waiting"}</p>
      </div>
    </section>
  );
}
