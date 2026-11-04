import { runJson } from "@/lib/records";
import { ruleRows } from "@/lib/format";
import { RuleLists } from "./lists";

export const dynamic = "force-dynamic";

export default async function Rules({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = runJson(id, "plan.json");
  if (!plan) return <p className="muted">The plan is written once the Planner has read the code.</p>;
  const { applies, excluded } = ruleRows(plan);
  const ex = new Map<string, string>((plan.excluded_at_index ?? []).map((e: any) => [e.provision_id, e.basis ?? ""]));
  return (
    <>
      <p className="muted" style={{ marginTop: 0, maxWidth: 900 }}>
        Muse Spark read the in-force index for the city and Oregon on the case&apos;s date and sorted every provision: what applies to this
        cottage, and what is excluded, each with the verbatim words of its scope. Deterministic code checked the plan against the index before any measuring.
      </p>
      <RuleLists applies={applies} excluded={excluded.map((e) => ({ ...e, basis: ex.get(e.id) ?? "" }))} />
    </>
  );
}
