# Run viewer

Plays one LotFit run folder as four screens, every number and quote read from the run's own files:

1. **The case**: the site plan (top view) and the case facts, each with its source.
2. **Which rules apply**: the Planner's plan, provisions that apply and provisions excluded, each with its scope quote.
3. **The agent at work**: the event log replayed (turns, Muse Spark's tool calls, results, repairs, findings,
   exclusions, the verifier and the verdict computed in code), with running counts and model cost.
4. **The answer**: each finding (measured value, limit, margin, tolerance, outcome, verbatim quote), the spot on the
   site plan, and the verdict with its reasons.

A run folder needs `case.json`, `case-facts.json`, `plan.json`, `events.jsonl`, `report.json` and `trace.json`.

- Open: serve this folder (`python3 -m http.server`) and open `index.html?run=demo/eug-demo-24x24`. Space pauses,
  arrows skip 5 s, the bar scrubs.
- Stills: `python3 render.py stills [--run <dir>] 5 14 60 90` → `stills/`.
- Video: `python3 render.py video [--run <dir>] [--fps 30] out.mp4`.
- Tests: `node test-model.mjs` (formatting, outcome and verdict wording, log counts, rows; no network).
