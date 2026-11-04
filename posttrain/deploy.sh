#!/bin/bash
# On-demand deployment for the tuned LoRA (billed per GPU-hour while up; delete when done).
# Usage: bash posttrain/deploy.sh create <full-model-id> | status <deployment-id> | delete <deployment-id>
# Needs FIREWORKS_API_KEY exported. After create, eval with:
#   node posttrain/eval_plan.mts --model <full-model-id> --key-file .env.local \
#     --rows <eval.jsonl> --labels <labels.json> --kind plan
set -euo pipefail
ACCT="${FIREWORKS_ACCOUNT_ID:-martin-fabbri-a-c4b16b}"
: "${FIREWORKS_API_KEY:?export FIREWORKS_API_KEY first}"
cmd="${1:?usage: deploy.sh create|status|delete <id>}"
id="${2:?usage: deploy.sh create|status|delete <id>}"
case "$cmd" in
  create)
    curl -s --max-time 60 -X POST "https://api.fireworks.ai/v1/accounts/$ACCT/deployments" \
      -H "Authorization: Bearer $FIREWORKS_API_KEY" -H 'Content-Type: application/json' \
      -d "{\"baseModel\": \"$id\", \"deploymentShape\": \"default\", \"minReplicaCount\": 0, \"maxReplicaCount\": 1}"
    ;;
  status)
    curl -s --max-time 30 -H "Authorization: Bearer $FIREWORKS_API_KEY" \
      "https://api.fireworks.ai/v1/accounts/$ACCT/deployments/$id"
    ;;
  delete)
    curl -s --max-time 60 -X DELETE -H "Authorization: Bearer $FIREWORKS_API_KEY" \
      "https://api.fireworks.ai/v1/accounts/$ACCT/deployments/$id"
    ;;
esac
echo
