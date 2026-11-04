#!/bin/bash
# Launch LotFit planner LoRA SFT on Muse Glimmer 30B (Fireworks serverless, free until 11/30).
# Needs FIREWORKS_API_KEY exported. Run from the repo root.
# 1. Build the data: node posttrain/build_data.mts <runs-live> <data-dir>
# 2. bash posttrain/launch.sh <data-dir>/train.jsonl
set -euo pipefail
FILE="${1:?usage: launch.sh <train.jsonl>}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}" HF_HOME="${HF_HOME:-/tmp/hf}"
: "${FIREWORKS_API_KEY:?export FIREWORKS_API_KEY first}"
if [ ! -d /tmp/fwcook ]; then git clone -q --depth 1 https://github.com/fw-ai/cookbook.git /tmp/fwcook; fi
if [ ! -x /tmp/fwvenv2/bin/python ]; then
  uv venv /tmp/fwvenv2
  uv pip install --python /tmp/fwvenv2/bin/python -q fireworks-ai tiktoken pillow torch transformers datasets \
    numpy tqdm rich python-dotenv huggingface-hub aiohttp orjson httpx tenacity protobuf grpcio pyqwest \
    h2 hpack hyperframe h11 wsproto
  uv pip install --python /tmp/fwvenv2/bin/python -q -e /tmp/fwcook/training --no-deps
fi
cd /tmp/fwcook/training
RUN_ID="r$(date +%Y%m%d-%H%M%S)"
/tmp/fwvenv2/bin/python -m examples.sft.muse_glimmer_starter prepare --file "$FILE"
/tmp/fwvenv2/bin/python -m examples.sft.muse_glimmer_starter launch --surface serverless \
  --file "$FILE" --run-id "$RUN_ID" --max-seq-len 8192
