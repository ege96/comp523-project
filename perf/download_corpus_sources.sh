#!/usr/bin/env bash
# Download the open text sources for the real-text performance corpus (swayambhu_perf.corpus)
# into DIR (default data/): about 460 MB. Needs huggingface.co and its CDN.
#   FLEURS transcripts, Nepali and English (CC BY 4.0): google/fleurs on Hugging Face
#   Wikipedia, Nepali (all) and English (first of 41 files), 2023-11-01 (CC BY-SA 4.0):
#   wikimedia/wikipedia on Hugging Face
set -euo pipefail
dir=${1:-data}
mkdir -p "$dir/fleurs" "$dir/wiki"
hf=https://huggingface.co
for lang in ne_np en_us; do
  for split in train dev test; do
    curl -fsSL -o "$dir/fleurs/$lang.$split.tsv" "$hf/datasets/google/fleurs/resolve/main/data/$lang/$split.tsv"
  done
done
curl -fsSL -o "$dir/wiki/ne.parquet" "$hf/api/datasets/wikimedia/wikipedia/parquet/20231101.ne/train/0.parquet"
curl -fsSL -o "$dir/wiki/en0.parquet" "$hf/api/datasets/wikimedia/wikipedia/parquet/20231101.en/train/0.parquet"
echo "Downloaded to $dir"
