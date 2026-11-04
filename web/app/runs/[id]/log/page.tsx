import { runEvents, runJson } from "@/lib/records";
import { buildLog, modelName } from "@/lib/format";
import { LiveLog } from "./live";

export const dynamic = "force-dynamic";

export default async function Log({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = runJson(id, "report.json");
  const lines = buildLog(runEvents(id));
  return <LiveLog id={id} initial={lines} done={Boolean(report)} model={modelName(report?.telemetry?.models?.agent ?? "accounts/fireworks/models/muse-spark-open")} />;
}
