#!/usr/bin/env bash
# Runs inside dbus-run-session (started by nested.sh): starts gnome-shell, waits for the
# extension to enable, runs the given command, then stops the shell.
set -uo pipefail
LOG="$I3SHELL_SANDBOX/shell.log"
ARGS=(--wayland --virtual-monitor 1920x1080)
[[ "$I3SHELL_VISIBLE" == "1" ]] || ARGS=(--headless "${ARGS[@]}")

gnome-shell "${ARGS[@]}" >"$LOG" 2>&1 &
SHELL_PID=$!
cleanup() { kill "$SHELL_PID" 2>/dev/null; wait "$SHELL_PID" 2>/dev/null; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  grep -q '\[i3-shell\] enable' "$LOG" 2>/dev/null && break
  if ! kill -0 "$SHELL_PID" 2>/dev/null; then
    echo "gnome-shell exited early; last log lines:"; tail -40 "$LOG"; exit 1
  fi
  sleep 0.5
done
grep -q '\[i3-shell\] enable' "$LOG" || { echo "extension did not enable within 30 s; log:"; tail -40 "$LOG"; exit 1; }
# Give org.i3shell.Control up to 10 s to appear (absent in the Task 2 smoke build; that is fine).
for _ in $(seq 1 20); do
  gdbus introspect --session --dest org.i3shell.Control --object-path /org/i3shell/Control >/dev/null 2>&1 && break
  sleep 0.5
done

status=0
if [[ $# -gt 0 ]]; then "$@" || status=$?; else sleep 5; fi
echo "--- [i3-shell] log lines ---"
grep '\[i3-shell\]' "$LOG" || true
exit $status
