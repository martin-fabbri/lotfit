# Results and validation

## Tests: 1,120 checks in 35 suites, all passing

Run on 2026-11-04 against the current code; the Rulebook suites run live on Aura (graph `777403f1`).

| Component | Suites | Checks |
|---|---|---:|
| Record (events, artifacts, trace) | `test-rct-0` … `test-rct-5` | 224 |
| Instruments (Python geometry and code tools) | `pytest graph/tests` · `test-int-7` | 213 + 17 |
| Reviewer | `test-rvt-0` … `test-rvt-6` · `test-reviewer` · `test-reviewer-preconditions` · `test-review-wiring` | 313 |
| Rulebook reader and guard | `test-graph-tools` · `test-guard` · `test-rulebook-reader` | 102 |
| Case check | `test-case-gate` · `test-case-check` | 33 |
| Judge (outcome, verifier, sensitivity) | `test-outcome` · `test-verifier` · `test-sensitivity` · `test-judge` | 60 |
| Harness and model client | `test-harness` · `test-rules-bugfix` · `test-harness-extra` · `test-model-client` | 78 |
| Narration | `test-narration` | 25 |
| Player and viewer | `test-summary` · `test-model` · `test-viewer-extra` | 55 |
| **Total** | **35** | **1,120** |

What the suites prove, among others:
- every one of the 7 planted-error reports is refused with its own verifier code, the clean one passes;
- all 50 gold Cypher queries pass the read-only guard and return their expected rows on the live graph; write
  queries, unknown labels or properties, inverted arrows and undated version reads are refused;
- a margin of exactly 0 with tolerance 0 passes; a margin inside ±tolerance is too close to call, never pass or fail;
- the trace and the sensitivity output are byte-identical when computed twice;
- a placement search whose spots are all too close to call gives NEEDS_CHECK, never NO_LEGS;
- narration never takes an outcome from the model, and refuses invented numbers and features.

## Live runs on the Rulebook (2026-11-04)

Muse Spark Open on Fireworks, Aura graph `777403f1`, streamed, temperature 0.

| Case | City | Verdict | Turns | Tool calls | Findings | Model cost | Time |
|---|---|---|---:|---:|---|---:|---:|
| 24×24 studio, scanned lot | Eugene | NEEDS_CHECK | 15 | 33 | 3 pass · 1 too close to call · 2 not measured | $0.40 | 12 min |
| 16×36 cottage, scanned lot | Eugene | NEEDS_CHECK | 16 | 39 | 3 pass · 1 too close to call · 2 not measured | $0.51 | 16 min |
| R5 lot, client spot (`s1`) | Portland | NEEDS_CHECK | 10 | 23 | 1 pass | $0.30 | 10 min |

Why NEEDS_CHECK on the 24×24: the size cap passes (576 sq ft against 682.72 sq ft), the front setback passes (76 ft
against 10 ft), one unit per lot passes; the interior setback is 6.36 ft against 5 ft, a margin of 1.36 ft inside the
measurement's ±3 ft tolerance, so it gets taped; the sloped height envelope has no instrument yet, and the verifier lists the
placement rules the model left unchecked for the spot. Every one of those reasons is on the last screen of the viewer.

## Reliability (2026-11-02)

Six scenarios, five runs each, scored on three things: the verdict code entails is the right one, the reason is
the right one, and the run ends cleanly.

| Scenario | What it tests | Right verdict | Right reason | Clean end | All three | Avg turns | Avg cost |
|---|---|---:|---:|---:|---:|---:|---:|
| s1 | client spot fails, a clear placement passes | 5/5 | 3/5 | 4/5 | 3/5 | 27 | $0.147 |
| s2 | size cap fails | 5/5 | 5/5 | 4/5 | 4/5 | 10 | $0.044 |
| s3 | a gray-area reading decides it | 5/5 | 5/5 | 5/5 | 5/5 | 25 | $0.146 |
| s4 | a conflicting living-area record decides it | 5/5 | 5/5 | 4/5 | 4/5 | 20 | $0.108 |
| s5 | the rear margin is too close to call | 5/5 | 5/5 | 5/5 | 5/5 | 15 | $0.077 |
| s7 | flag-lot setback fails the spot, a placement passes | 5/5 | 5/5 | 5/5 | 5/5 | 34 | $0.194 |
| **All** | | **30/30** | **28/30** | **27/30** | **26/30** | 22 | **$0.12** |

The verdict was right in every run because code, not the model, decides it: when the model's work is incomplete,
the verifier holds the verdict at NEEDS_CHECK instead of letting a guess through.

## The Rulebook gate

Last run before the Aura load (2026-11-04 02:05 UTC): every stage green, 0 failures. 5,171 nodes and 9,568
relationships verified count by count after the load. See [rulebook.md](rulebook.md).

## The capture

Reference walk: 70.6 m, 4.09 million points, 95 % error 0.42 m at 10 m. Five walks merged: 3,762,133 points; back
fence agreement 3 mm; lot width 19.49 m against the record's 19.47 m. See [capture.md](capture.md).
