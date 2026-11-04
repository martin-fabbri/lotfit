# Post-training: a planner specialist on Meta open weights

LotFit's planner step (partition the layer index into `applies` / `excluded_at_index`) is
taught to Muse Glimmer 30B with LoRA SFT on Fireworks serverless, using only runs the
deterministic Judge accepted. Base and tuned are scored by code on the same held-out cases.

## What and where

- Base model: `accounts/fireworks/models/muse-glimmer-30b`, LoRA (rank 8, alpha 32), 1 epoch, batch 16.
- Platform: Fireworks serverless training (`muse_glimmer_starter`, `--max-seq-len 8192`).
- Tuned model: `accounts/martin-fabbri-a-c4b16b/models/muse-starter-sl-r20261104-201722`
  (LoRA adapter, promoted 2026-11-04 ~21:24 UTC). Serving it needs an on-demand
  deployment, which needs a payment method on the account (not present): the held-out
  tuned eval below is blocked on that. To run it: `bash posttrain/deploy.sh create
  <model-id>`, then `node posttrain/eval_plan.mts --model <model-id> --key-file .env.local
  --rows eval.jsonl --labels labels.json`, then `bash posttrain/deploy.sh delete <id>`.
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
`launch` ran the LoRA loop (62 steps, ~1 h) with in-session sampling on a 40-row
holdout carved from the training file. Training is free under the Glimmer promotion
(until 11/30).

Cost: $0.00 training (promotion). Eval sampling used 12,380 prompt + 53,251 sampled
tokens, billed at published rates. No deployment was created (payment method required).

## Results (scored by code on the 2 held-out cases)

| Metric | Spark Open today | Glimmer 30B base | Glimmer 30B tuned |
|---|---|---|---|
| Plan applies F1 (10 plans) | 0.952 | n/a (no serverless endpoint) | blocked (no deploy) |
| Plan placement-slice F1 | 1.000 | — | blocked (no deploy) |
| Plan validity (exact partition) | 1.000 | — | blocked (no deploy) |
| Decision accuracy (40 sampled) | 0.725 | — | blocked (no deploy) |

On the trainer's internal holdout (40 decision rows unseen in training, from training
cases), scored with this repo's scorer (`scoreDecision`): Glimmer base 0.000 → tuned
0.900. The trainer's own exact-match agrees: 0.0 → 0.9 (paired p ≈ 3e-11).

How measured: `eval_plan.mts` sends each eval row to the model (temperature 0,
reasoning effort low), extracts the plan JSON, and compares the applies set, the
placement-constraint slice, and partition validity against the verified plan. Same rows,
same scorer, both models. The 0.725 includes 2 rows where Fireworks stayed overloaded
through retries (counted as misses) and 2 rows where the model returned JSON without a
decision; without the overloads it is 29/38 = 0.763.

## What is not yet known

- Tuned-model numbers on the held-out cases: serving the adapter needs an on-demand
  deployment, which needs a payment method on the Fireworks account. The eval command is
  above; `eval_plan.mts --model` takes the tuned id unchanged.
- Whether plan F1 transfers to Eugene cases (no verified Eugene runs exist to score
  against); only Portland hold-outs are measured.
- The base column is Muse Spark Open, the model that wrote the training plans, so a high
  base score is imitation, not reasoning. The tuned column tests whether the smaller
  Glimmer learns the task.
- Untuned Glimmer 30B scored 0/40 exact-match on the trainer's internal holdout during
  launch (it emits `{"applies": false}`-shaped JSON, not our decision rows): it does not
  know this task zero-shot. Exact-match there is stricter than the F1/accuracy above, so
  the numbers are not comparable across columns.
