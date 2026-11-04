// Pure summary-card logic and the one on-screen number formatter (no THREE, no DOM).
// The card tells the truth: header from the option status, one row per provision with its
// real outcome. Every number rendered as text goes through fmt().

/** At most 2 decimals, trailing zeros dropped. Non-numbers pass through as strings. */
export function fmt(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

const HEADER = {
  selected: { title: "Fits", chipCls: "ok", chipTxt: "FITS" },
  conditional: { title: "Needs a check", chipCls: "warn", chipTxt: "NEEDS CHECK" },
  rejected: { title: "Does not fit", chipCls: "no", chipTxt: "NO" },
};

const MARK = {
  pass: { mark: "✓", cls: "", words: "pass" },
  fail: { mark: "×", cls: "bad", words: "fail" },
  too_close_to_call: { mark: "≈", cls: "warn", words: "too close to call" },
  unknown: { mark: "?", cls: "warn", words: "not measured" },
};

const chip = (cls, txt) => `<span class="chip ${cls}">${txt}</span>`;

/**
 * The summary card HTML.
 * @param {{id: string, status: string, placement: {x: number, y: number}} | null} option
 * @param {number} areaSqft precomputed option area
 * @param {Array<{provision_id: string, outcome: string}>} constraints
 */
export function summaryCard(option, areaSqft, constraints) {
  const rows = [];
  const seen = new Set();
  for (const c of constraints || []) {
    if (!c.provision_id || seen.has(c.provision_id)) continue;
    seen.add(c.provision_id);
    const m = MARK[c.outcome] || MARK.unknown;
    rows.push(
      `<div class="chk"><i${m.cls ? ` class="${m.cls}"` : ""}>${m.mark}</i>${c.provision_id}<span class="s">${m.words}</span></div>`,
    );
    if (rows.length >= 7) break;
  }
  if (!option) {
    return `<div class="src"><span>Summary</span>${chip("rule", "—")}</div>\n      <div class="ttl">No placement found</div>\n      ${rows.join("")}`;
  }
  const h = HEADER[option.status] || HEADER.conditional;
  const p = option.placement || { x: 0, y: 0 };
  return `<div class="src"><span>Summary</span>${chip(h.chipCls, h.chipTxt)}</div>\n      <div class="ttl">${h.title}</div>\n      <div class="val">${option.id} at (${fmt(p.x)}, ${fmt(p.y)}) · ${fmt(areaSqft)} sq ft</div>\n      ${rows.join("")}`;
}
