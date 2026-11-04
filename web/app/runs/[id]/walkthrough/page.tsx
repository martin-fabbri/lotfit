import { runFile } from "@/lib/records";

export const dynamic = "force-dynamic";

export default async function Walkthrough({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!runFile(id, "trace.json")) return <p className="muted">The walkthrough is drawn from the run&apos;s trace, written at the end of the run.</p>;
  const hasTimeline = Boolean(runFile(id, "timeline.json"));
  const src = `/player/index.html?trace=${encodeURIComponent(`/api/runs/${id}/trace.json`)}${hasTimeline ? `&timeline=${encodeURIComponent(`/api/runs/${id}/timeline.json`)}` : ""}`;
  return (
    <>
      <p className="muted" style={{ marginTop: 0, maxWidth: 900 }}>The homeowner&apos;s walkthrough: a 3D scene drawn only from this run&apos;s decision trace. Every zone, margin and outcome on screen is a record of the run.</p>
      <section className="panel">
        <div className="ph">3D walkthrough <a href={src} target="_blank" rel="noreferrer">open full screen</a></div>
        <iframe src={src} title="3D walkthrough" style={{ width: "100%", aspectRatio: "16 / 9", border: 0, display: "block", background: "#0d1117" }} />
      </section>
    </>
  );
}
