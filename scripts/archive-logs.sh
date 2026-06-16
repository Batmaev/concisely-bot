#!/usr/bin/env bash
# Move daily logs older than KEEP_DAYS into logs/old/*.jsonl.zst.
# Recent logs stay as plain logs/YYYY-MM-DD.jsonl
#
# Read archived day:  zstdcat logs/old/2026-02-07.jsonl.zst | jq .

set -euo pipefail

KEEP_DAYS="${KEEP_DAYS:-3}"
LOGDIR="${WIDE_LOG_DIR:-logs}"
OLD_DIR="$LOGDIR/old"

if ! command -v zstd >/dev/null; then
  echo "error: zstd is required" >&2
  exit 1
fi

mkdir -p "$LOGDIR" "$OLD_DIR"

CUTOFF=$(date -u -d "$KEEP_DAYS days ago" +%Y-%m-%d)

to_archive=()
for f in "$LOGDIR"/*.jsonl; do
  [[ -f "$f" ]] || continue
  base=$(basename "$f" .jsonl)
  [[ "$base" > "$CUTOFF" ]] && continue
  to_archive+=("$f")
done

if [[ ${#to_archive[@]} -eq 0 ]]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) nothing to archive (cutoff=$CUTOFF)"
  exit 0
fi

archived=0
for f in "${to_archive[@]}"; do
  base=$(basename "$f" .jsonl)
  dest="$OLD_DIR/${base}.jsonl.zst"

  if [[ -f "$dest" ]]; then
    rm "$f"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) removed duplicate $base.jsonl (already in old/)"
    continue
  fi

  zstd -19 -f "$f" -o "$dest"
  rm "$f"
  archived=$((archived + 1))
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) archived ${base}.jsonl.zst"
done

size=$(du -sh "$OLD_DIR" | cut -f1)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) old/ total: $size ($archived new file(s))"
