#!/bin/zsh
# Restart-on-stall driver for wasm-runner.mjs: the browser pipeline has no
# cancellation, so a hung verification is escaped by killing the process; the
# runner marks the unfinished file as hung on the next start and skips it.
set -u
cd "$(dirname "$0")"
OUT=wasm-results.jsonl
STALL_SECONDS=180
while true; do
  node wasm-runner.mjs &
  pid=$!
  while kill -0 $pid 2>/dev/null; do
    sleep 15
    if [ -f "$OUT" ]; then
      age=$(( $(date +%s) - $(stat -f %m "$OUT") ))
      if [ $age -gt $STALL_SECONDS ]; then
        echo "no progress for ${age}s — killing runner"
        kill -9 $pid 2>/dev/null
        break
      fi
    fi
  done
  wait $pid
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "driver: runner finished cleanly"
    break
  fi
  echo "driver: runner exited $rc — restarting"
  sleep 1
done
