#!/usr/bin/env bash
# Waits for the Task 2 smoke marker in the nested shell log.
LOG="$I3SHELL_SANDBOX/shell.log"
for _ in $(seq 1 40); do
  grep -q 'SMOKE ok' "$LOG" 2>/dev/null && { echo "smoke: ok"; exit 0; }
  grep -q 'SMOKE FAIL' "$LOG" 2>/dev/null && { echo "smoke: FAIL"; exit 1; }
  sleep 0.5
done
echo "smoke: timeout (no marker)"; exit 1
