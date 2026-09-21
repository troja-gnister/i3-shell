#!/usr/bin/env bash
# Runs the TEST build of the extension inside an isolated nested/headless GNOME Shell.
#   test/integration/nested.sh [--visible] [--keep] -- <command...>
# --visible : show the nested shell window (default: --headless)
# --keep    : keep the sandbox directory for inspection
# The command runs inside the private session bus with XDG_* pointing at the sandbox.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VISIBLE=0; KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --visible) VISIBLE=1 ;;
    --keep) KEEP=1 ;;
    --) shift; break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -f "$ROOT/dist/extension.js" ]] || { echo "dist/ missing — run: npm run build:test" >&2; exit 2; }

SANDBOX="$(mktemp -d /tmp/i3-shell-nested.XXXXXX)"
mkdir -p "$SANDBOX/config/i3" "$SANDBOX/config/glib-2.0/settings" \
         "$SANDBOX/data/gnome-shell/extensions" "$SANDBOX/cache"
ln -s "$ROOT/dist" "$SANDBOX/data/gnome-shell/extensions/i3-shell@troja"
CFG="${I3SHELL_TEST_CONFIG:-$ROOT/test/unit/fixtures/reference.i3config}"
[[ -f "$CFG" ]] && cp "$CFG" "$SANDBOX/config/i3/config"
cat > "$SANDBOX/config/glib-2.0/settings/keyfile" <<'EOF'
[org/gnome/shell]
enabled-extensions=['i3-shell@troja']
disable-user-extensions=false
welcome-dialog-last-shown-version='999.0'
EOF

export I3SHELL_SANDBOX="$SANDBOX" I3SHELL_VISIBLE="$VISIBLE" I3SHELL_ROOT="$ROOT"
export XDG_CONFIG_HOME="$SANDBOX/config" XDG_DATA_HOME="$SANDBOX/data" XDG_CACHE_HOME="$SANDBOX/cache"
export GSETTINGS_BACKEND=keyfile

status=0
dbus-run-session -- bash "$ROOT/test/integration/inside.sh" "$@" || status=$?
if [[ $KEEP -eq 1 ]]; then echo "sandbox kept: $SANDBOX"; else rm -rf "$SANDBOX" 2>/dev/null || true; fi
exit $status
