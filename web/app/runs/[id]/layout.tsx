import { notFound } from "next/navigation";
import { runDir, runJson } from "@/lib/records";
import { modelName } from "@/lib/format";
import { RunTabs } from "./tabs";
import { VerdictChip } from "../../ui";

export default async function RunLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!runDir(id)) notFound();
  const kase = runJson(id, "case.json"), report = runJson(id, "report.json");
  const city = ({ EUG: "Eugene", PDX: "Portland", GRE: "Gresham" } as Record<string, string>)[kase?.jurisdiction?.city_layer] ?? kase?.jurisdiction?.city_layer ?? "";
  const rv = report?.reviewer;
  return (
    <>
      <div className="head">
        <div>
          <div className="kicker">Run · <span className="mono">{id}</span></div>
          <h1>{city}{kase?.site?.zone?.value ? `, zone ${kase.site.zone.value}` : ""} · {kase?.plan?.total_building_sqft?.value ?? "?"} sq ft cottage</h1>
          <p className="muted" style={{ margin: 0 }}>Planner {modelName(report?.telemetry?.models?.agent ?? "accounts/fireworks/models/muse-spark-open")} · Rulebook <span className="mono">{String(report?.graph_load_id ?? "").slice(0, 8)}</span>{rv && rv.status !== "not_run" ? ` · Reviewer ${rv.model}` : ""}</p>
        </div>
        <VerdictChip verdict={report?.verdict ?? null} />
      </div>
      <RunTabs id={id} />
      {children}
    </>
  );
}
