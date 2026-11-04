# Post-training: a planner specialist on Meta open weights

LotFit's planner step (partition the layer index into `applies` / `excluded_at_index`) is
taught to Muse Glimmer 30B with LoRA SFT on Fireworks serverless, using only runs the
deterministic Judge accepted. Base and tuned are scored by code on the same held-out cases.

## What and where

- Base model: `accounts/fireworks/models/muse-glimmer-30b`, LoRA (rank 8, alpha 32), 1 epoch, batch 16.
- Platform: Fireworks serverless training (`muse_glimmer_starter`, `--max-seq-len 8192`).
- Tuned model: `accounts/martin-fabbri-a-c4b16b/models/lotfit-planner-glimmer-v1`
  (served on an on-demand deployment for evaluation, deleted after).
- Code: `posttrain/build_data.mts` (data), `posttrain/eval_plan.mts` (scoring),
  `posttrain/launch.sh` (exact launch), `posttrain/test-posttrain.mts` (12 checks).

## Data

Source: 87 past live runs with a report; 34 passed the deterministic verifier, all
Portland R5. Train cases: 4 Portland cases, 24 verified runs. Hold-out: 2 Portland cases
(`…0004`, `…0007`), 10 verified runs, never in training.

| Split | Plan rows | Decision rows | Total |
|---|---|---|---|
| Train | 24 | 1,008 | 1,032 |
| Eval | 10 | 420 | 430 |

A plan row is the full planner turn (case facts + index table → plan JSON, the same shape
as the harness prompt). A decision row is one provision's applies/excluded call with its
scope quote. Case facts use an allowlisted field list only; the builder refuses any row
containing address, tax lot, parcel, owner or mailing text, and any `eug-martin` case.

## Method

Fireworks `muse_glimmer_starter`, serverless surface: `prepare` validated the JSONL
(992 train + 40 internal holdout rendered, longest plan row ≈ 4,300 tokens), then
`launch` ran the LoRA loop with in-session sampling on the holdout. Training is free
under the Glimmer promotion (until 11/30); the on-demand deployment for eval is billed
per GPU-hour while up and deleted after.

Cost: $0.00 training (promotion). Deployment: TBD GPU-hours, deleted after eval.

## Results (scored by code on the 2 held-out cases)

| Metric | Spark Open today | Glimmer 30B base | Glimmer 30B tuned |
|---|---|---|---|
| Plan applies F1 (10 plans) | 0.952 | n/a (no serverless endpoint) | training |
| Plan placement-slice F1 | 1.000 | — | training |
| Plan validity (exact partition) | 1.000 | — | training |
| Decision accuracy (40 sampled) | 0.725 | — | training |

How measured: `eval_plan.mts` sends each eval row to the model (temperature 0,
reasoning effort low), extracts the plan JSON, and compares the applies set, the
placement-constraint slice, and partition validity against the verified plan. Same rows,
same scorer, both models. The 0.725 includes 2 rows where Fireworks stayed overloaded
through retries (counted as misses) and 2 rows where the model returned JSON without a
decision; without the overloads it is 29/38 = 0.763.

## What is not yet known

- Tuned-model numbers: the training job is running; this table is updated when its eval
  lands. A tuned LoRA needs an on-demand deployment to serve; that step is still ahead.
- Whether plan F1 transfers to Eugene cases (no verified Eugene runs exist to score
  against); only Portland hold-outs are measured.
- The base column is Muse Spark Open, the model that wrote the training plans, so a high
  base score is imitation, not reasoning. The tuned column tests whether the smaller
  Glimmer learns the task.
- Untuned Glimmer 30B scored 0/40 exact-match on the trainer's internal holdout during
  launch (it emits `{"applies": false}`-shaped JSON, not our decision rows): it does not
  know this task zero-shot. Exact-match there is stricter than the F1/accuracy above, so
  the numbers are not comparable across columns.
