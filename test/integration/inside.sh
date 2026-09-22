#!/usr/bin/env bash
# Runs only inside nested.sh's private bus and runtime.
set -euo pipefail
[[ "$XDG_RUNTIME_DIR" == "$I3SHELL_SANDBOX/runtime" && -n "$DBUS_SESSION_BUS_ADDRESS" &&
   "$DBUS_SESSION_BUS_ADDRESS" != "$I3SHELL_PARENT_BUS" ]] || { echo 'private session required' >&2; exit 1; }
LOG="$I3SHELL_SANDBOX/shell.log"
FIXTURE_LOG="$I3SHELL_SANDBOX/fixture.log"
# Fixtures are Wayland-only. On this host Xwayland startup blocks Shell's main
# thread in a socket poll; --no-x11 also keeps this harness off X11 entirely.
ARGS=(--wayland --no-x11 --wayland-display=i3-shell-test)
read -ra MONITORS <<< "$I3SHELL_MONITORS"
for monitor in "${MONITORS[@]}"; do ARGS+=(--virtual-monitor "$monitor"); done
[[ "$I3SHELL_VISIBLE" == 1 ]] || ARGS=(--headless "${ARGS[@]}")
SHELL_PID=''; FIXTURE_PID=''
stop_process() {
  local pid=$1 label=$2
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for ((attempt=0; attempt<50; attempt++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "$label did not exit after TERM; sending KILL" >&2
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  local status=$?
  trap - EXIT
  # Reap the GTK client before the compositor and private bus go away.
  stop_process "$FIXTURE_PID" fixture
  stop_process "$SHELL_PID" gnome-shell
  if [[ -f "$LOG" ]] && rg -q '(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL' "$LOG"; then
    echo 'native criticals found in shell.log' >&2
    status=1
  fi
  if [[ -f "$FIXTURE_LOG" ]] && rg -q 'fixture [[:alnum:]]+ failed|(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL' "$FIXTURE_LOG"; then
    echo 'fixture failures found in fixture.log' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "$I3SHELL_VISIBLE" == 1 ]]; then
  env -u DISPLAY WAYLAND_DISPLAY="$I3SHELL_PARENT_WAYLAND" gnome-shell "${ARGS[@]}" >"$LOG" 2>&1 &
else
  env -u DISPLAY -u WAYLAND_DISPLAY gnome-shell "${ARGS[@]}" >"$LOG" 2>&1 &
fi
SHELL_PID=$!
unset I3SHELL_PARENT_WAYLAND DISPLAY
export WAYLAND_DISPLAY=i3-shell-test GDK_BACKEND=wayland

wait_for() {
  local description=$1 pid=$2 seconds=$3
  shift 3
  local deadline=$((SECONDS + seconds))
  while ((SECONDS < deadline)); do
    kill -0 "$pid" 2>/dev/null || { echo "$description: process exited" >&2; return 1; }
    if "$@"; then return 0; fi
    sleep 0.1
  done
  echo "timed out waiting for $description" >&2
  return 1
}
wait_for 'private Wayland socket' "$SHELL_PID" 10 test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
control_ready() {
  timeout 1s gdbus introspect --session --dest org.i3shell.Control --object-path /org/i3shell/Control >/dev/null 2>&1
}
shell_ready() {
  # Raw introspection only: property reads can block during Shell startup.
  timeout 2s gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.freedesktop.DBus.Introspectable.Introspect >/dev/null 2>&1
}
if [[ "${I3SHELL_DISABLED:-0}" == 1 ]]; then
  # enabled-extensions is empty, so neither the enable log line nor the Control
  # name can appear until the scenario itself enables the extension. Waiting for
  # either here would deadlock before the scenario ever runs.
  wait_for 'gnome-shell session bus name' "$SHELL_PID" 30 shell_ready
elif ! wait_for 'extension control service' "$SHELL_PID" 30 control_ready; then
  {
    echo '--- private session bus names ---'
    timeout 2s gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
      --method org.freedesktop.DBus.ListNames || true
    echo '--- Shell extension state ---'
    timeout 2s gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
      --method org.gnome.Shell.Extensions.ListExtensions || true
    echo '--- Shell responsiveness ---'
    timeout 2s gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
      --method org.freedesktop.DBus.Introspectable.Introspect || true
  } >"$I3SHELL_SANDBOX/startup-diagnostics.log" 2>&1
  exit 1
fi

GTK_A11Y=none gjs -m "$I3SHELL_ROOT/test/integration/windows.js" >"$FIXTURE_LOG" 2>&1 &
FIXTURE_PID=$!
fixture_ready() {
  timeout 1s gdbus introspect --session --dest org.i3shell.TestWindows --object-path /org/i3shell/TestWindows >/dev/null 2>&1
}
wait_for 'fixture service' "$FIXTURE_PID" 10 fixture_ready

if [[ $# -gt 0 ]]; then "$@"
else python3 "$I3SHELL_ROOT/test/integration/client.py" smoke; fi
kill -0 "$FIXTURE_PID" "$SHELL_PID"
echo '--- [i3-shell] log lines ---'
rg '\[i3-shell\]' "$LOG" || true
