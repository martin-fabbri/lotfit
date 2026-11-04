// Pure wording and formatting for runs (shared with query/viewer/model.js): every number passes through fmt, every
// word about an outcome comes from outcomeView or verdictView.
/* eslint-disable @typescript-eslint/no-explicit-any */

export function fmt(n: any): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "");
  const r = Math.round(n * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export const esc = (s: any): string => String(s ?? "").replace(/[&<>"]/g, (c: any) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
export const cut = (s: any, n: number): string => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
export const unitWord = (u: any): string => ({ sqft: "sq ft", count: "", pct: "%", deg: "°", in: "in" } as Record<string, string>)[u] ?? (u || "");

export function modelName(id: any): string {
  const s = String(id || "").split("/").pop() ?? "";
  return ({ "muse-spark-open": "Muse Spark Open (Meta)", "muse-spark-open-1026": "Muse Spark Open (Meta)" } as Record<string, string>)[s] || s;
}

export function outcomeView(o: any): { icon: string; label: string; tone: string } {
  return ({
    pass: { icon: "✓", label: "pass", tone: "ok" },
    fail: { icon: "×", label: "fail", tone: "no" },
    too_close_to_call: { icon: "≈", label: "too close to call", tone: "am" },
    unknown: { icon: "?", label: "not measured", tone: "am" },
  } as Record<string, { icon: string; label: string; tone: string }>)[o] || { icon: "·", label: String(o ?? ""), tone: "dim" };
}

export function verdictView(report: any): { chip: string; big: string; tone: string; why: string[] } {
  const f = report.findings || [];
  const pass = f.filter((x: any) => x.outcome === "pass").length;
  const why: string[] = [];
  for (const x of f) {
    if (x.outcome === "too_close_to_call") {
      const m = (x.measures || []).find((m: any) => m.too_close_to_call) || (x.measures || [])[0];
      why.push(m ? `${x.provision_id}: ${fmt(m.value)} ${unitWord(m.unit)} against ${fmt(m.limit?.value)} ${unitWord(m.unit)}, inside its ±${fmt(m.tolerance)} ${unitWord(m.unit)} tolerance: tape it`
        : `${x.provision_id}: too close to call`);
    }
    if (x.outcome === "fail") why.push(`${x.provision_id}: fails`);
  }
  const unknown = f.filter((x: any) => x.outcome === "unknown").map((x: any) => x.provision_id);
  if (unknown.length) why.push(`Not measured: ${unknown.join(", ")}`);
  const open = (report.verifier?.issues || []).filter((i: any) => i.code === "V1_COVERAGE").length;
  if (open) why.push(`${open} placement rules still to check for the spot`);
  const v = report.verdict;
  if (v === "FITS") return { chip: "FITS", big: "It fits", tone: "ok", why: [`All ${pass} rules checked pass`, ...why] };
  if (v === "FITS_IF") return { chip: "FITS IF", big: "It fits, if…", tone: "am", why: [...(report.conditions || []).map((c: any) => c.text || c.condition || JSON.stringify(c)), ...why] };
  if (v === "NEEDS_CHECK") return { chip: "NEEDS CHECK", big: "Needs a check", tone: "am", why: [`${pass} rules pass`, ...why] };
  if (v === "NO_LEGS") return { chip: "NO", big: "No spot found", tone: "no", why };
  if (v === "BLOCKED_BY_GATE") return { chip: "NO", big: "Not allowed here", tone: "no", why };
  if (v === "NOT_MODELED") return { chip: "NOT MODELED", big: "Not modeled yet", tone: "dim", why };
  return { chip: String(v), big: String(v), tone: "dim", why };
}

export type LogLine = { cls: string; html: string; counts: { turns: number; calls: number; cost: number; findings: number; exclusions: number; errors: number } };
export function buildLog(events: any[]): LogLine[] {
  const lines: LogLine[] = [];
  const c = { turns: 0, calls: 0, cost: 0, findings: 0, exclusions: 0, errors: 0 };
  const push = (cls: string, html: string) => lines.push({ cls, html, counts: { ...c } });
  for (const e of events) {
    const d = e.data || {};
    switch (e.type) {
      case "turn_started": c.turns++; push("turn", `── turn ${c.turns} ──`); break;
      case "messages": {
        const u = d.usage; if (!u) break;
        c.cost += u.cost_usd || 0;
        push("model", `  ${esc(modelName(u.model))} · ${fmt(u.prompt_tokens || 0)} in · ${fmt(u.completion_tokens || 0)} out`);
        break;
      }
      case "tool_requested": {
        const k = d.call || {}; c.calls++;
        const args = k.args && Object.keys(k.args).length ? cut(JSON.stringify(k.args), 56) : "";
        push("call", `▸ ${esc(k.tool)}(${esc(args)})${k.provision_id ? `  <span class="d">${esc(k.provision_id)} → ${esc(k.target)}</span>` : ""}`);
        break;
      }
      case "tool_result":
        push("ok", d.ok ? `  <span class="g">✓</span> ${esc(cut(d.preview, 96))}` : `  <span class="r">✗</span> ${esc(cut(d.preview || d.error, 96))}`);
        break;
      case "error": c.errors++; push("err", `  ! ${esc(d.code)} · ${esc(cut(d.message, 104))}`); break;
      case "lotfit.finding_recorded": {
        const f = d.finding || {}; c.findings++;
        const o = outcomeView(f.outcome), col = { ok: "g", no: "r", am: "a" }[o.tone] || "d";
        push("find", `● finding ${esc(f.provision_id)} <span class="d">[${esc(f.target === "case" ? "plan" : "spot")}]</span> <span class="${col}">${o.icon} ${esc(o.label)}</span>`);
        break;
      }
      case "lotfit.exclusion_recorded": c.exclusions++; push("ex", `○ excluded ${esc(d.provision_id)} · “${esc(cut(d.scope_quote, 70))}”`); break;
      case "lotfit.plan_written":
        push("sys", `■ plan written${d.valid ? "" : ` <span class="a">· repair: ${esc((d.repairs || []).map((r: any) => r.code).join(", "))}</span>`}`);
        break;
      case "lotfit.verifier_completed":
        push("sys", `■ verifier · ${d.passed ? `<span class="g">passed</span>` : `<span class="a">${(d.issues || []).length} open</span>`}`);
        break;
      case "lotfit.sensitivity_completed": push("sys", "■ sensitivity · done"); break;
      case "lotfit.verdict_computed": push("sys", `■ verdict computed in code · ${esc(d.entailed)}`); break;
      case "lotfit.reviewer_completed": if (d.status && d.status !== "not_run") push("sys", `■ reviewer · ${esc(d.status)}`); break;
      default: break;
    }
  }
  return lines;
}

const src = (fact: any) => cut(fact?.prov?.[0]?.document, 64);

export function factRows(kase: any, facts: any): { k: string; v: string; src: string }[] {
  const s = kase.site || {}, p = kase.plan || {}, f = facts.facts || {};
  const rows: { k: string; v: string; src: string }[] = [];
  if (s.zone) rows.push({ k: "Zone", v: [s.zone.value, ...(s.overlays?.value || [])].join(" "), src: src(s.zone) });
  const lot = s.lot_outline?.value;
  if (Array.isArray(lot)) {
    const xs = lot.map((q: any) => q[0]), ys = lot.map((q: any) => q[1]);
    const area = f["site.lot_area_sqft"];
    rows.push({ k: "Lot", v: `${fmt(Math.max(...xs) - Math.min(...xs))} × ${fmt(Math.max(...ys) - Math.min(...ys))} ft${typeof area === "number" ? ` · ${fmt(area)} sq ft` : ""}`, src: src(s.lot_outline) });
  }
  if (s.primary_living_area_sqft) rows.push({ k: "House", v: `${fmt(s.primary_living_area_sqft.value)} sq ft living area`, src: src(s.primary_living_area_sqft) });
  if (s.slope_pct) rows.push({ k: "Slope", v: `${fmt(s.slope_pct.value)} %`, src: src(s.slope_pct) });
  const fp = p.footprint?.value;
  if (Array.isArray(fp)) {
    const xs = fp.map((q: any) => q[0]), ys = fp.map((q: any) => q[1]);
    rows.push({ k: "Plan", v: `${p.detached?.value ? "Detached " : ""}${String(p.kind?.value || "").toUpperCase()} · ${fmt(Math.max(...xs) - Math.min(...xs))} × ${fmt(Math.max(...ys) - Math.min(...ys))} ft${p.total_building_sqft ? ` · ${fmt(p.total_building_sqft.value)} sq ft` : ""}`, src: src(p.footprint) });
  }
  if (p.height_ft) rows.push({ k: "Height", v: `${fmt(p.height_ft.value)} ft`, src: src(p.height_ft) });
  if (p.placement?.value) rows.push({ k: "Spot", v: `${fmt(p.placement.value.x)} ft from the left, ${fmt(p.placement.value.y)} ft back`, src: src(p.placement) });
  if (kase.as_of?.date) rows.push({ k: "As of", v: kase.as_of.date, src: String(kase.as_of.meaning || "").replace(/_/g, " ") });
  return rows;
}

export function ruleRows(plan: any): { applies: { id: string; quote: string }[]; excluded: { id: string; quote: string }[] } {
  const order = new Map<string, number>((plan.order || []).map((id: string, i: number) => [id, i] as [string, number]));
  const applies = [...(plan.applies || [])].sort((a: any, b: any) => (order.get(a.provision_id) ?? 1e9) - (order.get(b.provision_id) ?? 1e9))
    .map((r: any) => ({ id: r.provision_id, quote: cut(r.scope_quote, 150) }));
  const excluded = (plan.excluded_at_index || []).map((r: any) => ({ id: r.provision_id, quote: cut(r.scope_quote, 150) }));
  return { applies, excluded };
}

export function findingRows(report: any): { id: string; target: string; outcome: string; nums: string; quote: string }[] {
  return (report.findings || []).map((x: any) => {
    const nums = (x.measures || []).slice(0, 2).map((m: any) => {
      const u = unitWord(m.unit), sp = u ? " " : "";
      const sign = typeof m.margin === "number" && m.margin > 0 ? "+" : "";
      return `${esc(fmt(m.value))}${sp}${esc(u)} <span class="d">vs limit</span> ${esc(fmt(m.limit?.value))}${sp}${esc(u)} <span class="d">· margin</span> ${sign}${esc(fmt(m.margin))}${sp}${esc(u)}${m.tolerance ? ` <span class="d">· ±${esc(fmt(m.tolerance))}${sp}${esc(u)}</span>` : ""}`;
    }).join("<br>");
    return { id: x.provision_id, target: x.target, outcome: x.outcome, nums, quote: cut(x.citations?.[0]?.quote, 170) };
  });
}
