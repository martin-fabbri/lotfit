// LotFit run viewer: plays one run folder (case, plan, events, report, trace) as four screens.
// Everything on screen is a pure function of time t and the run's files. window.__seek(t) and window.__duration
// let render.py capture it frame by frame; in a browser it plays in real time with a scrubber.
import { fmt, modelName, outcomeView, verdictView, buildLog, factRows, ruleRows, findingRows } from "./model.js";

const params = new URLSearchParams(location.search);
const RUN = (params.get("run") || "demo/eug-demo-24x24").replace(/\/$/, "");
const RENDER = params.has("render");
if (RENDER) document.body.classList.add("render");

async function json(name) { const r = await fetch(`${RUN}/${name}`); if (!r.ok) throw new Error(`${RUN}/${name}: ${r.status}`); return r.json(); }
async function jsonl(name) { const r = await fetch(`${RUN}/${name}`); if (!r.ok) throw new Error(`${RUN}/${name}: ${r.status}`);
  return (await r.text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); }

const [kase, facts, plan, events, report, trace] = await Promise.all([
  json("case.json"), json("case-facts.json"), json("plan.json"), jsonl("events.jsonl"), json("report.json"), json("trace.json"),
]);

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };

const city = { EUG: "Eugene, Oregon", PDX: "Portland, Oregon" }[kase.jurisdiction?.city_layer] || kase.jurisdiction?.city_layer || "";
const zone = kase.site?.zone?.value ?? "";
const model = modelName(report.telemetry?.models?.agent);
const log = buildLog(events);
const rules = ruleRows(plan);
const finds = findingRows(report);
const vview = verdictView(report);
$("#footl").textContent = `${city} · zone ${zone} · as of ${kase.as_of?.date ?? ""} · Rulebook ${String(report.graph_load_id || "").slice(0, 8)} · ${model}`;

// ---------- site plan (top view, street at the bottom) ----------
function siteSvg(w, h, { spotColor = "#3fd0e0", showDims = true } = {}) {
  const lot = trace.site?.lot || [];
  const xs = lot.map((p) => p[0]), ys = lot.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 34, s = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad - 18) / (maxY - minY));
  const ox = (w - s * (maxX - minX)) / 2, oy = pad;
  const P = ([x, y]) => `${(ox + (x - minX) * s).toFixed(1)},${(oy + (maxY - y) * s).toFixed(1)}`;
  const poly = (pts, attrs) => `<polygon points="${pts.map(P).join(" ")}" ${attrs}/>`;
  let out = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  out += poly(lot, `fill="rgba(79,220,138,.07)" stroke="#8aa0b8" stroke-width="1.5" stroke-dasharray="6 4"`);
  for (const e of trace.site?.existing || []) {
    out += poly(e.outline, `fill="rgba(138,160,184,.22)" stroke="#8aa0b8" stroke-width="1.2"`);
    const cx = e.outline.reduce((a, p) => a + p[0], 0) / e.outline.length, cy = e.outline.reduce((a, p) => a + p[1], 0) / e.outline.length;
    const [tx, ty] = P([cx, cy]).split(",");
    out += `<text x="${tx}" y="${ty}" fill="#8aa0b8" font-size="12" text-anchor="middle">${esc(e.kind)}</text>`;
  }
  for (const o of trace.options || []) {
    if (!o.outline) continue;
    out += poly(o.outline, `fill="${spotColor}33" stroke="${spotColor}" stroke-width="2"`);
    const cx = o.outline.reduce((a, p) => a + p[0], 0) / o.outline.length, cy = o.outline.reduce((a, p) => a + p[1], 0) / o.outline.length;
    const [tx, ty] = P([cx, cy]).split(",");
    out += `<text x="${tx}" y="${+ty + 4}" fill="${spotColor}" font-size="12" text-anchor="middle">ADU</text>`;
  }
  const [bx, by] = P([minX, minY]).split(",").map(Number), [ex] = P([maxX, minY]).split(",").map(Number);
  out += `<text x="${(bx + ex) / 2}" y="${by + 22}" fill="#56708c" font-size="11" text-anchor="middle" letter-spacing="2">STREET</text>`;
  if (showDims) {
    const [, ty] = P([minX, maxY]).split(",").map(Number);
    out += `<text x="${(bx + ex) / 2}" y="${ty - 10}" fill="#8aa0b8" font-size="11" text-anchor="middle">${fmt(maxX - minX)} ft</text>`;
    out += `<text x="${bx - 10}" y="${(by + ty) / 2}" fill="#8aa0b8" font-size="11" text-anchor="middle" transform="rotate(-90 ${bx - 10} ${(by + ty) / 2})">${fmt(maxY - minY)} ft</text>`;
  }
  return out + `</svg>`;
}

// ---------- scenes ----------
const T_RULE = Math.max(0.35, Math.min(0.7, 15 / Math.max(1, rules.applies.length + rules.excluded.length)));
const T_LINE = Math.max(0.12, Math.min(0.5, 28 / Math.max(1, log.length)));
const scenes = [
  {
    id: "case", step: "01 · the case", dur: 9,
    title: "The lot and the plan",
    sub: () => `${city} · zone ${zone}${(kase.site?.overlays?.value || []).length ? " " + kase.site.overlays.value.join(" ") : ""} · ${kase.mode === "check_spot" ? "check the owner's spot" : "find a spot"}`,
    build() {
      const rows = factRows(kase, facts);
      return `<div class="panel" style="left:0;top:0;width:560px;bottom:0"><div class="ph">Site plan <span class="n">top view</span></div>
          <div style="position:absolute;top:41px;left:0;right:0;bottom:0">${siteSvg(558, 519)}</div></div>
        <div class="panel" style="left:584px;top:0;right:0;bottom:0"><div class="ph">Case facts <span class="n">${rows.length}</span></div>
          ${rows.map((r, i) => `<div class="fact" data-i="${i}"><span class="k">${esc(r.k)}<span class="src">${esc(r.src)}</span></span><span class="v">${esc(r.v)}</span></div>`).join("")}</div>`;
    },
    update(t) { document.querySelectorAll(".fact").forEach((el) => { el.style.opacity = ease((t - 0.6 - 0.35 * +el.dataset.i) / 0.4); }); },
  },
  {
    id: "rules", step: "02 · which rules apply", dur: 3 + T_RULE * (rules.applies.length + rules.excluded.length) + 2.5,
    title: "Reading the code",
    sub: () => `The Planner reads the Rulebook for ${city.split(",")[0]} and Oregon, and decides which provisions apply, each with its quote`,
    build() {
      const col = (list, cls) => list.map((r, i) => `<div class="rule ${cls}" data-i="${i}"><div class="id"><span>${esc(r.id)}</span>${cls === "ex" ? `<span class="chip c-dim">EXCLUDED</span>` : `<span class="chip c-cy">APPLIES</span>`}</div><div class="q">“<mark>${esc(r.quote)}</mark>”</div></div>`).join("");
      return `<div class="panel" style="left:0;top:0;width:660px;bottom:0"><div class="ph">Applies <span class="n" id="na">0</span></div><div class="list"><div class="inner" id="la">${col(rules.applies, "ap")}</div></div></div>
        <div class="panel" style="left:684px;top:0;right:0;bottom:0"><div class="ph">Excluded <span class="n" id="ne">0</span></div><div class="list"><div class="inner" id="le">${col(rules.excluded, "ex")}</div></div></div>`;
    },
    update(t) {
      const nA = rules.applies.length;
      const shown = (i, ex) => 1.2 + T_RULE * (ex ? nA + i : i);
      const run = (sel, ex, counter, box) => {
        let last = null, n = 0;
        document.querySelectorAll(sel).forEach((el) => {
          const lt = t - shown(+el.dataset.i, ex);
          el.style.opacity = ease(lt / 0.25);
          el.querySelector("mark").style.setProperty("--hl", `${(ease(lt / 0.8) * 100).toFixed(1)}%`);
          if (lt >= 0) { last = el; n++; }
        });
        $(counter).textContent = String(n);
        const inner = $(box), h = inner.parentElement.clientHeight;
        const y = last ? Math.max(0, last.offsetTop + last.offsetHeight - h + 8) : 0;
        inner.style.transform = `translateY(${-y}px)`;
      };
      run("#la .rule", false, "#na", "#la");
      run("#le .rule", true, "#ne", "#le");
    },
  },
  {
    id: "agent", step: "03 · the agent at work", dur: 1 + T_LINE * log.length + 3,
    title: "Measuring, rule by rule",
    sub: () => `${model} plans and calls LotFit's instruments; code computes every outcome`,
    build() {
      return `<div class="panel" style="left:0;top:0;width:820px;bottom:0"><div class="ph">Event log <span class="n mono" id="nl">0 / ${log.length}</span></div>
          <div id="term"><div class="inner">${log.map((l, i) => `<div class="ln ${l.cls}" data-i="${i}">${l.html}</div>`).join("")}</div></div></div>
        <div class="panel" style="left:844px;top:0;right:0;bottom:0"><div class="ph">Run <span class="n mono">live</span></div>
          <div class="stat"><span class="k">Model</span><span class="v">${esc(model)}</span></div>
          <div class="stat"><span class="k">Turns</span><span class="v" id="st-turns">0</span></div>
          <div class="stat"><span class="k">Tool calls</span><span class="v" id="st-calls">0</span></div>
          <div class="stat"><span class="k">Model cost</span><span class="v" id="st-tok">$0.00</span></div>
          <div class="stat"><span class="k">Findings</span><span class="v" id="st-find">0</span></div>
          <div class="stat"><span class="k">Exclusions</span><span class="v" id="st-ex">0</span></div>
          <div class="stat"><span class="k">Repairs</span><span class="v" id="st-err">0</span></div></div>`;
    },
    update(t) {
      const n = Math.min(log.length, Math.floor(Math.max(0, t - 1) / T_LINE) + (t >= 1 ? 1 : 0));
      document.querySelectorAll("#term .ln").forEach((el) => { el.style.display = +el.dataset.i < n ? "" : "none"; });
      $("#nl").textContent = `${n} / ${log.length}`;
      const c = n > 0 ? log[n - 1].counts : { turns: 0, calls: 0, cost: 0, findings: 0, exclusions: 0, errors: 0 };
      $("#st-turns").textContent = c.turns; $("#st-calls").textContent = c.calls; $("#st-tok").textContent = `$${c.cost.toFixed(2)}`;
      $("#st-find").textContent = c.findings; $("#st-ex").textContent = c.exclusions; $("#st-err").textContent = c.errors;
    },
  },
  {
    id: "verdict", step: "04 · the answer", dur: 4 + 0.8 * finds.length + 6,
    title: "Every outcome, with its clause",
    sub: () => `${finds.length} findings · each number from an instrument, each limit from the Rulebook, each quote verbatim`,
    build() {
      const color = { ok: "#4fdc8a", no: "#ff6464", am: "#f5b342" }[vview.tone] || "#3fd0e0";
      return `<div class="panel" style="left:0;top:0;width:760px;bottom:0"><div class="ph">Findings <span class="n">${finds.length}</span></div>
          ${finds.map((f, i) => { const o = outcomeView(f.outcome); return `<div class="fr" data-i="${i}"><div><span class="pid">${esc(f.id)}</span><span class="tg">${esc(f.target === "case" ? "the plan" : "the spot")}</span></div><span class="chip c-${o.tone}">${o.icon} ${esc(o.label)}</span>
            ${f.nums ? `<div class="nums">${f.nums}</div>` : ""}<div class="q">${esc(f.quote)}</div></div>`; }).join("")}</div>
        <div class="panel" style="left:784px;top:0;right:0;height:300px"><div class="ph">Site plan <span class="n">the spot</span></div>
          <div style="position:absolute;top:41px;left:0;right:0;bottom:0">${siteSvg(462, 258, { spotColor: color, showDims: false })}</div></div>
        <div id="verdict" style="left:784px;top:324px;right:0"><span class="chip c-${vview.tone}" style="align-self:flex-start">${esc(vview.chip)}</span>
          <div class="big">${esc(vview.big)}</div><ul class="why">${vview.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`;
    },
    update(t) {
      document.querySelectorAll(".fr").forEach((el) => { el.style.opacity = ease((t - 0.8 - 0.8 * +el.dataset.i) / 0.4); });
      $("#verdict").style.opacity = ease((t - 1.6 - 0.8 * finds.length) / 0.6);
    },
  },
];

const starts = []; let total = 0;
for (const s of scenes) { starts.push(total); total += s.dur; }
let current = -1;
function render(t) {
  t = clamp(t, 0, total - 1e-6);
  let i = scenes.length - 1; while (i > 0 && t < starts[i]) i--;
  const s = scenes[i], lt = t - starts[i];
  if (i !== current) {
    current = i;
    $("#step").textContent = s.step; $("#title").textContent = s.title; $("#sub").textContent = s.sub();
    $("#body").innerHTML = s.build();
  }
  const fadeIn = ease(lt / 0.5), fadeOut = 1 - ease((lt - (s.dur - 0.4)) / 0.4);
  $("#body").style.opacity = String(Math.min(fadeIn, i === scenes.length - 1 ? 1 : fadeOut));
  s.update(lt);
}
window.__duration = total;
window.__seek = (t) => render(t);
window.__ready = true;

// ---------- live playback ----------
function fit() { const k = Math.min(innerWidth / 1280, (innerHeight - (RENDER ? 0 : 26)) / 720); $("#stage").style.transform = `scale(${k})`; }
if (!RENDER) {
  fit(); addEventListener("resize", fit);
  let t = 0, playing = true, last = performance.now();
  const scrub = $("#scrub"), tc = $("#tc"), pp = $("#pp");
  pp.onclick = () => { playing = !playing; pp.textContent = playing ? "pause" : "play"; };
  scrub.oninput = () => { t = (scrub.value / 1000) * total; render(t); };
  addEventListener("keydown", (e) => {
    if (e.key === " ") { e.preventDefault(); pp.click(); }
    if (e.key === "ArrowRight") t = Math.min(total, t + 5);
    if (e.key === "ArrowLeft") t = Math.max(0, t - 5);
  });
  const loop = (now) => {
    if (playing) t = Math.min(total, t + (now - last) / 1000);
    last = now; render(t);
    scrub.value = String(Math.round((t / total) * 1000)); tc.textContent = `${t.toFixed(1)} / ${total.toFixed(0)} s`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
} else {
  document.body.style.display = "block"; render(0);
}
