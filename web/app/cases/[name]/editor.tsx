"use client";
import { useMemo, useState, useTransition } from "react";
import { SitePlan, placeFootprint, type Shape } from "../../ui";
import { fmt } from "@/lib/format";
import { checkAction, runAction } from "./actions";

type Pt = [number, number];

/** The editable part of a case: the plan's size and where it sits. Every change is re-checked by the engine's own case check. */
export function CaseEditor({ name, initial, engine }: { name: string; initial: any; engine: boolean }) {
  const fp0: Pt[] = initial.plan?.footprint?.value ?? [];
  const w0 = fp0.length ? Math.max(...fp0.map((p) => p[0])) - Math.min(...fp0.map((p) => p[0])) : 24;
  const d0 = fp0.length ? Math.max(...fp0.map((p) => p[1])) - Math.min(...fp0.map((p) => p[1])) : 24;
  const pl0 = initial.plan?.placement?.value ?? { x: 0, y: 0, rotation: 0 };
  const [w, setW] = useState(String(w0)), [d, setD] = useState(String(d0));
  const [x, setX] = useState(String(pl0.x)), [y, setY] = useState(String(pl0.y)), [rot, setRot] = useState(String(pl0.rotation ?? 0));
  const [h, setH] = useState(String(initial.plan?.height_ft?.value ?? ""));
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState(true);
  const [pending, start] = useTransition();

  const edited = useMemo(() => {
    const num = (s: string) => Number(s);
    const W = num(w), D = num(d), X = num(x), Y = num(y), R = num(rot), H = num(h);
    const changed = W !== w0 || D !== d0 || X !== pl0.x || Y !== pl0.y || R !== (pl0.rotation ?? 0) || (h !== "" && H !== initial.plan?.height_ft?.value);
    if (!changed) return { kase: initial, changed: false };
    const k = structuredClone(initial);
    const area = Math.round(W * D * 100) / 100;
    k.plan.footprint.value = [[0, 0], [W, 0], [W, D], [0, D]];
    k.plan.placement.value = { x: X, y: Y, rotation: R };
    if (k.plan.height_ft && h !== "") k.plan.height_ft.value = H;
    for (const f of ["living_area_sqft", "total_building_sqft"]) if (k.plan[f]) k.plan[f].value = area;
    for (const f of ["footprint", "placement", "height_ft", "living_area_sqft", "total_building_sqft"]) {
      if (k.plan[f]?.prov?.[0]) k.plan[f].prov = [{ ...k.plan[f].prov[0], kind: "entered", document: "LotFit app: edited by the signed-in user", when: new Date().toISOString().slice(0, 10) }];
    }
    return { kase: k, changed: true };
  }, [w, d, x, y, rot, h, initial]);

  const lot: Pt[] = edited.kase.site?.lot_outline?.value ?? [];
  const shapes: Shape[] = [
    ...(edited.kase.site?.house_outline?.value ? [{ outline: edited.kase.site.house_outline.value as Pt[], kind: "house" as const, label: "house" }] : []),
    ...((edited.kase.site?.structures?.value ?? []) as any[]).map((s) => ({ outline: s.outline as Pt[], kind: "structure" as const, label: s.kind ?? "structure" })),
    ...(edited.kase.plan?.footprint?.value ? [{ outline: placeFootprint(edited.kase.plan.footprint.value, edited.kase.plan.placement.value), kind: "adu" as const, label: "ADU", tone: edited.changed ? "am" : "ok" }] : []),
  ];

  const check = () => start(async () => { setErr(null); setResult(await checkAction(JSON.stringify(edited.kase))); });
  const run = () => start(async () => {
    setErr(null);
    const r = await runAction(name, edited.changed ? JSON.stringify(edited.kase) : null, reviewer);
    if (r && "error" in r) setErr(r.error);
  });

  const field = (label: string, v: string, set: (s: string) => void, id: string) => (
    <div className="stack"><label htmlFor={id}>{label}</label><input id={id} inputMode="decimal" value={v} onChange={(e) => { set(e.target.value); setResult(null); }} /></div>
  );

  return (
    <div className="grid g-side">
      <section className="panel">
        <div className="ph">Site plan <span>{edited.changed ? (result?.ok === true ? <span className="chip c-ok">EDITED · CHECKED</span> : <span className="chip c-am">EDITED · NOT CHECKED</span>) : <span className="chip c-dim">AS RECORDED</span>}</span></div>
        <SitePlan lot={lot} shapes={shapes} width={640} height={560} />
      </section>
      <section className="panel">
        <div className="ph">The plan and its spot</div>
        <div className="pb stack" style={{ gap: 14 }}>
          <div className="fields">
            {field("Width (ft)", w, setW, "w")}{field("Depth (ft)", d, setD, "d")}{field("Height (ft)", h, setH, "h")}
            {field("From the left (ft)", x, setX, "x")}{field("From the front (ft)", y, setY, "y")}
            <div className="stack"><label htmlFor="rot">Rotation</label>
              <select id="rot" value={rot} onChange={(e) => { setRot(e.target.value); setResult(null); }}>{["0", "90", "180", "270"].map((r) => <option key={r} value={r}>{r}°</option>)}</select></div>
          </div>
          <p className="tiny muted" style={{ margin: 0 }}>Footprint {fmt(Number(w) * Number(d))} sq ft. The engine&apos;s case check validates the contract and invariants I1–I12 and computes the derived facts with their tolerance.</p>
          <div className="inline">
            <button className="btn" onClick={check} disabled={!engine || pending}>Check case</button>
            <button className="btn primary" onClick={run} disabled={!engine || pending}>Run LotFit on this case</button>
            <label className="inline tiny" style={{ fontWeight: 500 }}><input type="checkbox" checked={reviewer} onChange={(e) => setReviewer(e.target.checked)} style={{ width: "auto" }} /> with the Reviewer (Muse Spark 1.3)</label>
          </div>
          {!engine ? <p className="tiny muted" style={{ margin: 0 }}>Check and Run need the engine (Python instruments, the Rulebook connection, model keys). On this host you can open the recorded runs.</p> : null}
          {err ? <p className="err" role="alert">{err}</p> : null}
          {pending ? <p className="muted">Working…</p> : null}
          {result ? <CheckResult r={result} /> : null}
        </div>
      </section>
    </div>
  );
}

function CheckResult({ r }: { r: any }) {
  if (r.unavailable) return <p className="muted">The engine is not on this host.</p>;
  if (r.ok === true) {
    const computed = Object.entries(r.computed ?? {}) as [string, any][];
    return (
      <div className="panel">
        <div className="ph"><span className="chip c-ok">✓ CASE ACCEPTED</span><span className="mono tiny">case_hash {String(r.case_hash).slice(0, 16)}…</span></div>
        <div className="rows">
          {computed.map(([k, f]) => (
            <div key={k} className="row"><span className="mono">{k}</span><span className="mono">{typeof f.value === "number" ? fmt(f.value) : Array.isArray(f.value) ? `${f.value.length} ${k.endsWith("setbacks_used") ? "lines" : "points"}` : typeof f.value === "object" ? JSON.stringify(f.value).slice(0, 60) : String(f.value)}{f.prov?.[0]?.tolerance?.value ? ` ±${fmt(f.prov[0].tolerance.value)} ${f.prov[0].tolerance.unit ?? ""}` : ""}</span></div>
          ))}
          <div className="tiny muted">Accepted means the case is complete and consistent. Physical fit, the setbacks and every rule are decided by the run.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="ph"><span className="chip c-no">✕ CASE REFUSED</span><span className="mono tiny">{r.invariant ?? ""}</span></div>
      <div className="rows">
        <div className="mono tiny">{r.message ?? r.error ?? JSON.stringify(r).slice(0, 600)}</div>
        {r.path ? <div className="mono tiny muted">at {r.path}</div> : null}
      </div>
    </div>
  );
}
