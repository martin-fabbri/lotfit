# Record and traces: every run is replayable

Every LotFit run leaves a typed, append-only, hash-pinned log. From it the Harness rebuilds the model's context each
turn, the verifier checks evidence, the viewer replays the run, and failures can be attributed to the version that
made them.

## The event log

`events.jsonl`, one per run (`query/src/events.mts`, `class EventLog`):

- **append-only**: every event is validated against its contract before it is written; `seq` rises by exactly 1;
  UUIDv7 ids; the reader refuses mixed threads, gaps or repeated ids;
- **artifacts by hash**: everything the run produces (plan, ledgers, case facts, rule families, report) is written
  once, versioned, addressed by sha256 and logged as `artifact_written`;
- **pinned**: every event carries `thread_id`, `turn_id`, `seq`, `created_at`, `config_hash` and `graph_load_id`.

Event types: `thread_created`, `turn_started`, `messages` (with tokens, cached tokens, reasoning tokens, cost and
duration), `tool_requested`, `tool_result`, `artifact_written`, `turn_ended`, `error` (category `harness | model |
tool | database | case`), and the domain events `lotfit.plan_written`, `lotfit.exclusion_recorded`,
`lotfit.finding_recorded`, `lotfit.ledger_compacted`, `lotfit.sensitivity_completed`, `lotfit.verdict_computed`,
`lotfit.verifier_completed`, `lotfit.reviewer_completed`, `lotfit.flag_resolved`.

The demo run in [`query/viewer/demo/eug-demo-24x24/`](../query/viewer/demo/eug-demo-24x24/) has 193 events: 16 turns,
33 tool calls, 7 findings, 8 exclusions, 4 repairs.

## Which version decided

| Hash | Pins |
|---|---|
| `case_hash` | the validated case, canonical JSON |
| `graph_load_id` | the Rulebook load the run read (`777403f1…@2026-11-04T02:06:22Z`) |
| `config_hash` | the prompt, the ontology, the tool contracts, the instruments' source tree, the budgets, the models |

Same case, same graph, same config: same verdict. Nothing changes prompts, tools or examples during a run.

## The decision trace

`trace.json` (`buildnexus.decision-trace/1`, compiled by `compile-trace.mts`) is the report in geometric form: a fixed
frame (origin front-left, x along the front lot line, y to the rear, z up, feet), the site (lot, existing
structures, north), the constraints (provision, zone, value, outcome, measures), the placement options (selected,
conditional or rejected, each with its margins and why), and narrative beats (establish, constrain, height, envelope,
place, summary). Keys are sorted; **the trace is byte-identical when compiled twice**, and so is the sensitivity
output. Before writing, the trace checks that it covers every measure of every finding; a trace that doesn't is
refused and the run is flagged.

## Built for agents that improve

LotFit's harness follows the runtime pattern of [exo](https://github.com/exoharness/exo), an open-source agent
runtime: the runtime owns durability (threads, append-only events, artifacts), the harness owns meaning (context,
tools, planning). LotFit implements that structure in TypeScript. What it gives an improving agent today:

- **Replayable failures**: every turn's context can be rebuilt from the log, and every error carries a category, so
  a failure is attributable to the harness, the model, a tool, the database or the case.
- **Per-call economics**: tokens, cached tokens, reasoning tokens, cost and duration on every model call.
- **Planted-error mutants**: [`query/eval/mutants/`](../query/eval/mutants/) holds 7 reports with one planted error
  each and 1 clean report; the verifier must refuse each with its own code and pass the clean one.
- **A gold query set**: 50 questions with gold Cypher and expected rows; all pass the guard live.
- **Reliability runs**: the same scenario run repeatedly, scored on three things: the right verdict, the right
  reason, a clean end (see [results](results.md)).
- **Live findings that become fixes**: e.g. the verifier's coverage check (V1) names every rule the model skipped
  for a spot; a refused trace is logged instead of lost.

The improvement loop itself is offline and gated by design: collect logs, classify failures by code, one atomic patch
per failure to one artifact (an ontology description, a scope quote, a tool docstring, a reading-guide line), accept
it only if the mutants are still all caught and the reliability scores don't regress, and record it as a new
`config_hash`. Legal numbers and gray areas are never learned: they live in the Rulebook.
