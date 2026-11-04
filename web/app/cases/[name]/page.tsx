import Link from "next/link";
import { notFound } from "next/navigation";
import { readCase } from "@/lib/records";
import { engineAvailable } from "@/lib/paths";
import { fmt } from "@/lib/format";
import { CaseEditor } from "./editor";

export const dynamic = "force-dynamic";

const show = (v: any): string => {
  if (v === null || v === undefined) return "not stated";
  if (typeof v === "number") return fmt(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return Array.isArray(v[0]) ? `${v.length} points` : v.join(", ") || "none";
  if (typeof v === "object") return Object.entries(v).map(([k, x]) => `${k} ${typeof x === "number" ? fmt(x) : x}`).join(" · ");
  return String(v);
};

function FactTable({ title, group }: { title: string; group: Record<string, any> }) {
  return (
    <section className="panel">
      <div className="ph">{title} <span className="mono">{Object.keys(group).length}</span></div>
      <table>
        <thead><tr><th>Fact</th><th>Value</th><th>Status</th><th>Source</th><th className="num">Tolerance</th></tr></thead>
        <tbody>
          {Object.entries(group).map(([k, f]) => {
            const p = f?.prov?.find((x: any) => x.role === "used") ?? f?.prov?.[0];
            const tol = (f?.prov ?? []).map((x: any) => x.tolerance?.value).filter((x: any) => typeof x === "number");
            return (
              <tr key={k}>
                <td className="mono">{k}</td>
                <td className="mono">{show(f?.value)}</td>
                <td><span className={`chip ${f?.status === "known" ? "c-ok" : f?.status === "unconfirmed" ? "c-am" : "c-dim"}`}>{f?.status ?? "–"}</span></td>
                <td className="tiny muted">{p?.document ?? "–"}{(f?.prov ?? []).some((x: any) => x.role === "conflicting record") ? <span className="src">a conflicting record is kept beside it</span> : null}</td>
                <td className="num">{tol.length ? `±${fmt(Math.max(...tol))} ft` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export default async function CasePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const kase = readCase(name);
  if (!kase) notFound();
  const city = { EUG: "Eugene", PDX: "Portland", GRE: "Gresham" }[kase.jurisdiction?.city_layer as string] ?? kase.jurisdiction?.city_layer;
  return (
    <>
      <div className="head">
        <div>
          <div className="kicker">Case · {name}</div>
          <h1>{city}, zone {kase.site?.zone?.value} {(kase.site?.overlays?.value ?? []).join(" ")}</h1>
          <p className="muted" style={{ margin: 0 }}>As of {kase.as_of?.date} ({String(kase.as_of?.meaning ?? "").replace(/_/g, " ")}) · {kase.mode === "check_spot" ? "check the owner's spot" : "find a spot"}</p>
        </div>
        {kase.capture ? <Link className="btn" href={`/cases/${name}/capture`}>The scan behind this case →</Link> : null}
      </div>
      <CaseEditor name={name} initial={kase} engine={engineAvailable()} />
      <div className="grid" style={{ marginTop: 16 }}>
        <FactTable title="Site facts" group={kase.site ?? {}} />
        <FactTable title="Plan facts" group={kase.plan ?? {}} />
      </div>
    </>
  );
}
