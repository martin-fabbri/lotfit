# LotFit

## What LotFit does

A homeowner's lot and a proposed backyard unit (ADU) go in; the answer that comes out is
whether it fits (FITS / DOESN'T FIT / NEEDS_CHECK / NO_LEGS), with every number traced to
the code section it comes from. The input is a case file with the lot, the house, and the
plan with its placement; the output is a verdict, the findings behind it, and a trace.

## How it works

All parts speak through frozen contracts in `query/src/types.mts`.

Rulebook. The zoning code as a graph in Neo4j Aura: Eugene, Portland, and Oregon state
layers. Fixed read functions fetch the reading guide, the layer index, and rule families
(`query/src/graph-tools.mts`, `query/src/graph-reads.mts`); anything the model asks the
graph goes through a read-only guard checked against the ontology
(`query/src/guard-cypher.mts`, `query/ontology/lotfit.ontology.yaml`). The curated
inputs live in `graph/curated/`, the loaded graph in `graph/out/graph-or.json`.

Case check. Every case is validated before a run. The TypeScript gate checks the contract
and invariants I1–I12 (`query/src/case-gate.mts`); a Python validator computes the derived
facts — lot area, the house's rear wall, the plan outline, the setbacks used — each with
provenance and tolerance (`query/py/validate_case.py`).

Planner. Muse Spark reads the case, the Rulebook, and the reading guide, plans which rules
apply, and calls the tools (`query/src/model-client.mts`). The prompt for each turn is
built by `query/src/context.mts`.

Instruments. Deterministic Python tools for geometry and code checks: setbacks, heights,
areas, coverage, placements (`graph/tools/`, run through `graph/tool_runner.py`).

Harness. The loop: plan, measure, record findings, repair turns
(`query/src/harness.mts`). `query/src/run-live.mts` runs one case end to end.

Judge. Code decides each finding's outcome from the tool results (`query/src/outcome.mts`),
checks the whole report against rules V1–V8 before a verdict is allowed
(`query/src/verifier.mts`), and asks which facts, moved within their tolerance, would flip
the verdict (`query/src/sensitivity.mts`).

Record. An append-only event log of the run (`query/src/events.mts`) and a trace compiled
from the report (`query/src/compile-trace.mts`), byte-identical when compiled twice.

Reviewer. A second model checks the report's flags before it goes out (`query/src/reviewer.mts`,
`query/src/reviewer-client.mts`).

## The rule that matters

The model never decides a fact. It proposes; code disposes. Every outcome is computed by
code from tool results and cited to a provision, and anything code cannot check stays
visible as unchecked instead of passing quietly.

## Tests

Each suite runs with `node src/<suite>.mts` from `query/`:

| suite | checks |
|---|---|
| test-rct-0 | 37/37 |
| test-rct-1 | 25/25 |
| test-rct-2 | 62/62 |
| test-rct-3 | 27/27 |
| test-rct-4 | 38/38 |
| test-rct-5 | 35/35 |
| test-int-7 | 17/17 |
| test-rvt-0 | 30/30 |
| test-rvt-1 | 22/22 |
| test-rvt-2 | 33/33 |
| test-rvt-3 | 21/21 |
| test-rvt-4 | 34/34 |
| test-rvt-5 | 26/26 |
| test-rvt-6 | 25/25 |
| test-graph-tools | live: run against Aura |
| test-guard | live: run against Aura |
| test-rulebook-reader | 15/15 (12 skip without Aura; live: run against Aura) |
| test-case-gate | 18/18 |
| test-case-check | 15/15 |
| test-outcome | 15/15 |
| test-verifier | 9/9 |
| test-sensitivity | 21/21 |
| test-judge | 15/15 |
| test-harness | 21/21 |
| test-rules-bugfix | 26/26 |
| test-review-wiring | 11/11 |
| test-reviewer | 59/59 |
| test-reviewer-preconditions | 52/52 |
| test-harness-extra | 21/21 |
| pytest graph/tests | 213 passed |

Plus `npx tsc --noEmit` from `query/`, clean.

## How to run

Install: `cd query && npm install`. The Python side uses the standard library only;
the graph tests need pytest.

Tests: `node src/test-<suite>.mts` from `query/`, and
`python3 -m pytest graph/tests` from the repo root.

Live run: `node src/run-live.mts <case>` from `query/`, with a case from `query/cases`
(`s1`, `eug-demo-16x36`). The model runs on Fireworks; put the key in the environment
or the repo-root `.env.local`. Aura credentials go in the repo-root `.env.aura`. Both
files are gitignored and never printed.

## Walkthrough player

`query/player/` plays a decision trace as a 3D walkthrough: the lot and house, the
setback zones, the buildable envelope, the placements tried, and a summary card with the
outcome of each rule. Open it by serving that folder over HTTP, for example
`python3 -m http.server` inside it, then opening `index.html`; `?trace=<url>` plays a
different trace, and the default is `demo/eug-demo-24x24.trace.json`. Stills and video
render with `python3 render.py stills <t…>` and `python3 render.py video <name>`
(playwright, Chromium, and ffmpeg).

## Repository layout

```
graph/
  curated/      rulebook inputs: operators, facts, relations, slices, guides
  out/          the loaded graph (graph-or.json)
  tools/        deterministic instruments (geometry, measures)
  tool_runner.py  bridge the harness calls into
  common.py     shared text and dating pieces
  model.py      the modeled layer over the graph
  tests/        pytest suite
query/
  src/          TypeScript: gate, planner, harness, judge, record, reviewer, tests
  cases/        PDX scenarios (s1..s7), invalid cases, Eugene demo cases
  eval/         gold queries and verifier mutants
  ontology/     the graph ontology and its schema
  contracts/    contract fixtures
  py/           the Python case validator
  player/       3D walkthrough of a decision trace
```
