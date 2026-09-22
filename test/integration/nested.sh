#!/usr/bin/env bash
# Isolated GNOME Shell TEST build; clients only connect to its private socket/bus.
# nested.sh [--visible] [--keep] [--disabled] [--monitor WxH ...] -- <command...>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VISIBLE=0; KEEP=0; DISABLED=0
MONITORS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --visible) VISIBLE=1 ;;
    --keep) KEEP=1 ;;
    --disabled) DISABLED=1 ;;
    --monitor)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]] || { echo 'expected --monitor WxH' >&2; exit 2; }
      MONITORS+=("$2"); shift ;;
    --) shift; break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ ${#MONITORS[@]} -gt 0 ]] || MONITORS=(1920x1080)
[[ -f "$ROOT/dist/extension.js" ]] || { echo 'dist/ missing — run: npm run build:test' >&2; exit 2; }

# Preserve only the compositor's parent socket, before replacing the runtime.
PARENT_WAYLAND=''
if [[ $VISIBLE -eq 1 ]]; then
  [[ -n "${WAYLAND_DISPLAY:-}" ]] || { echo '--visible requires a parent Wayland display' >&2; exit 2; }
  if [[ "$WAYLAND_DISPLAY" == /* ]]; then PARENT_WAYLAND="$WAYLAND_DISPLAY"
  else PARENT_WAYLAND="${XDG_RUNTIME_DIR:?}/$WAYLAND_DISPLAY"; fi
  [[ -S "$PARENT_WAYLAND" ]] || { echo 'parent Wayland socket is absent' >&2; exit 2; }
fi
SANDBOX="$(mktemp -d /tmp/i3-shell-nested.XXXXXX)"
# Portal services started on the private bus mount FUSE filesystems inside the
# private XDG_RUNTIME_DIR (xdg-document-portal mounts runtime/doc). rm -rf
# cannot remove those, so teardown must unmount first, deepest mount first, or
# a completely successful run would exit non-zero.
unmount_sandbox() {
  local mountpoint
  while read -r mountpoint; do
    [[ -n "$mountpoint" ]] || continue
    fusermount3 -u "$mountpoint" 2>/dev/null ||
      fusermount3 -z -u "$mountpoint" 2>/dev/null ||
      echo "could not unmount $mountpoint" >&2
  done < <(awk -v prefix="$SANDBOX/" 'index($5, prefix) == 1 {print length($5), $5}' \
             /proc/self/mountinfo 2>/dev/null | sort -rn | cut -d' ' -f2-)
}
cleanup() {
  local status=$?
  trap - EXIT
  unmount_sandbox
  if [[ $KEEP -eq 1 || $status -ne 0 ]]; then
    echo "sandbox kept: $SANDBOX"
    if [[ $status -ne 0 ]]; then
      for log in "$SANDBOX/shell.log" "$SANDBOX/fixture.log" "$SANDBOX/startup-diagnostics.log"; do
        echo "--- $log ---" >&2
        [[ ! -f "$log" ]] || cat "$log" >&2
      done
    fi
  elif ! rm -rf "$SANDBOX" 2>/dev/null; then
    echo "sandbox not fully removed: $SANDBOX" >&2
  fi
  # Always the inner command's status: cleanup must neither mask a failure nor
  # invent one.
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$SANDBOX/config/i3" "$SANDBOX/config/glib-2.0/settings" \
         "$SANDBOX/data/gnome-shell/extensions" "$SANDBOX/cache"
mkdir -m 0700 "$SANDBOX/runtime"
ln -s "$ROOT/dist" "$SANDBOX/data/gnome-shell/extensions/i3-shell@troja"
# Shell 50 awaits its first-major-version online update check before importing
# extensions. This disposable session tests our local build, not that updater.
touch "$SANDBOX/data/gnome-shell/update-check-50"
CFG="${I3SHELL_TEST_CONFIG:-$ROOT/test/unit/fixtures/reference.i3config}"
[[ ! -f "$CFG" ]] || cp "$CFG" "$SANDBOX/config/i3/config"
# --disabled seeds an empty list instead of loading and then disabling, so a
# scenario can read the untouched GNOME originals before the first enable().
ENABLED="['i3-shell@troja']"
[[ $DISABLED -eq 0 ]] || ENABLED='@as []'
cat > "$SANDBOX/config/glib-2.0/settings/keyfile" <<SETTINGS
[org/gnome/shell]
enabled-extensions=$ENABLED
disable-user-extensions=false
welcome-dialog-last-shown-version='999.0'
SETTINGS
if [[ ${#MONITORS[@]} -gt 1 ]]; then
  # With the default (true), Mutter makes every window on a secondary output
  # sticky, and sticky windows are deliberately not tracked. Only the private
  # multi-output scenario needs this key.
  cat >> "$SANDBOX/config/glib-2.0/settings/keyfile" <<'SETTINGS'

[org/gnome/mutter]
workspaces-only-on-primary=false
SETTINGS
fi

# GNOME Shell spawns `ibus-daemon --panel disable` through SEARCH_PATH and never
# respawns it, so a stub that exits leaves the private session without IBus.
# IBus registers its own accelerators (emoji `<Super>semicolon`, triggers
# `<Super>space`) through the shell's GrabAccelerators — the same external-grab
# mechanism this extension uses — and with IBus present a varying subset of our
# grabs never dispatches. Suppressing it makes this suite deterministic, and
# means **automated coverage excludes the IBus conflict**, exactly as --no-x11
# excludes Xwayland clients. The live checklist covers those keys instead.
mkdir -p "$SANDBOX/bin"
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/bin/ibus-daemon"
chmod +x "$SANDBOX/bin/ibus-daemon"

export I3SHELL_SANDBOX="$SANDBOX" I3SHELL_VISIBLE="$VISIBLE" I3SHELL_ROOT="$ROOT"
export I3SHELL_DISABLED="$DISABLED"
export PATH="$SANDBOX/bin:$PATH"
export I3SHELL_PARENT_WAYLAND="$PARENT_WAYLAND" I3SHELL_PARENT_BUS="${DBUS_SESSION_BUS_ADDRESS:-}"
export I3SHELL_MONITORS="${MONITORS[*]}"
export XDG_CONFIG_HOME="$SANDBOX/config" XDG_DATA_HOME="$SANDBOX/data" XDG_CACHE_HOME="$SANDBOX/cache"
export XDG_RUNTIME_DIR="$SANDBOX/runtime" GSETTINGS_BACKEND=keyfile
export PYTHONDONTWRITEBYTECODE=1
unset DISPLAY WAYLAND_DISPLAY GDK_BACKEND
dbus-run-session -- bash "$ROOT/test/integration/inside.sh" "$@"
