#!/usr/bin/env bash
# Phase 1 acceptance in the nested shell: A1, A4, A5, A7. Run via: npm run test:integration
set -uo pipefail
DEST=org.i3shell.Control
OBJ=/org/i3shell/Control
FAILS=0

call() { gdbus call --session --dest "$DEST" --object-path "$OBJ" --method "$1" "${@:2}"; }
# field <Method> <jsonKey>: calls a JSON-returning method and prints one field
field() {
  call "org.i3shell.Control.$1" | python3 -c '
import sys, ast, json
value = ast.literal_eval(sys.stdin.read().strip())[0]
print(json.loads(value)[sys.argv[1]])' "$2"
}
cmd()   { call org.i3shell.Control.Command "$1"; }
press() { call org.i3shell.Debug.PressKey "$1" >/dev/null; sleep 0.4; }
lock()  { call org.i3shell.Debug.SimulateSessionMode "$1" >/dev/null; sleep 0.2; }
expect() {
  local what=$1 got=$2 want=$3
  if [[ "$got" == "$want" ]]; then echo "ok    $what = $got"
  else echo "FAIL  $what: got '$got', want '$want'"; FAILS=$((FAILS + 1)); fi
}
wait_grabbed() { # wait_grabbed <count> <label>
  local want=$1 label=$2 i
  for i in $(seq 1 10); do
    [[ "$(field GetState grabbed)" == "$want" ]] && { echo "ok    $label (grabbed $want)"; return 0; }
    sleep 0.5
  done
  echo "FAIL  $label: grabbed $(field GetState grabbed), want $want"; FAILS=$((FAILS + 1)); return 1
}

# gnome-shell enables the extension (and its D-Bus name appears) before its startup-complete
# handler settles the action mode; keybindings only fire once GetState.ready is true, and the
# ~25 bindings that collide with mutter's own at enable only succeed on a 500 ms retry. Wait for
# both before running any scenario, so the checks below observe steady state, not the race.
echo "== wait for ready"
READY_OK=0
for i in $(seq 1 40); do
  if [[ "$(field GetState ready)" == "True" ]]; then
    echo "ready after $i tries"
    READY_OK=1
    break
  fi
  sleep 0.5
done
if [[ $READY_OK -ne 1 ]]; then
  echo "FAIL  GetState never reported ready=true within 40 tries"
  call org.i3shell.Control.GetState
  exit 1
fi

GRABBED_OK=0
for i in $(seq 1 20); do
  if [[ "$(field GetState grabbed)" == "65" ]]; then
    echo "grabbed 65 after $i tries"
    GRABBED_OK=1
    break
  fi
  sleep 0.5
done
if [[ $GRABBED_OK -ne 1 ]]; then
  echo "FAIL  grabbed never reached 65 within 20 tries"
  call org.i3shell.Control.GetState
  exit 1
fi

echo "== config"
expect "source"           "$(field GetConfigStatus source)" file
expect "errors"           "$(field GetConfigStatus errors)" 0
expect "workspace count"  "$(field GetState workspaceCount)" 10
GRABBED=$(field GetState grabbed)
expect "grabbed default bindings" "$GRABBED" 65

echo "== A1 workspaces"
cmd "workspace number 3" >/dev/null
expect "Command workspace 3 -> index" "$(field GetState activeWorkspace)" 2
press "<Super>4";  expect "Super+4 -> index" "$(field GetState activeWorkspace)" 3
press "<Super>0";  expect "Super+0 -> index" "$(field GetState activeWorkspace)" 9
press "<Super>1";  expect "Super+1 -> index" "$(field GetState activeWorkspace)" 0

OUT=$(cmd "move container to workspace number 5")
[[ "$OUT" == *"no focused window"* ]] && echo "ok    A1 move dispatches (no window to move in the sandbox)" || { echo "FAIL  A1 move: $OUT"; FAILS=$((FAILS+1)); }
press "<Super><Shift>5"; expect "A1 Shift+5 leaves workspace unchanged (nothing to move)" "$(field GetState activeWorkspace)" 0

echo "== A4 modes"
press "<Super>r";  expect "Super+r enters resize" "$(field GetState mode)" resize
expect "resize mode grabs 11" "$(field GetState grabbed)" 11
LOG="$I3SHELL_SANDBOX/shell.log"
BEFORE=$(grep -c 'resize: not implemented' "$LOG" || true)
press "j"
AFTER=$(grep -c 'resize: not implemented' "$LOG" || true)
[[ "$AFTER" -gt "$BEFORE" ]] && echo "ok    A4 bare j is grabbed in resize mode (dispatched to the engine)" || { echo "FAIL  A4 bare j did not reach the engine ($BEFORE -> $AFTER)"; FAILS=$((FAILS+1)); }
expect "A4 still in resize after j" "$(field GetState mode)" resize
press "Escape";    expect "Escape leaves resize" "$(field GetState mode)" default
press "<Super>r";  press "Return"; expect "Return leaves resize" "$(field GetState mode)" default
press "<Super>r";  press "<Super>r"; expect "Super+r toggles back" "$(field GetState mode)" default
expect "default grabs restored" "$(field GetState grabbed)" "$GRABBED"

echo "== A7 lock"
press "<Super>r"
lock true
expect "locked: mode reset" "$(field GetState mode)" default
expect "locked: nothing grabbed" "$(field GetState grabbed)" 0
lock false
expect "unlocked: grabs back" "$(field GetState grabbed)" "$GRABBED"
press "<Super>2";  expect "unlocked: bindings work" "$(field GetState activeWorkspace)" 1

echo "== A5 reload"
CFG="$XDG_CONFIG_HOME/i3/config"
cp "$CFG" "$CFG.orig"
printf '\nbogus_directive 1\n' >> "$CFG"
OUT=$(cmd reload)
[[ "$OUT" == *"rejected"* ]] && echo "ok    broken config rejected" || { echo "FAIL  reload accepted a broken config: $OUT"; FAILS=$((FAILS + 1)); }
expect "still grabbed after rejection" "$(field GetState grabbed)" "$GRABBED"
press "<Super>3"; expect "A5 bindings work after rejection" "$(field GetState activeWorkspace)" 2
cp "$CFG.orig" "$CFG"
printf 'bindsym Mod4+F9 workspace number 5\n' >> "$CFG"
OUT=$(cmd reload)
[[ "$OUT" == *"reloaded"* ]] && echo "ok    changed config reloaded" || { echo "FAIL  reload failed: $OUT"; FAILS=$((FAILS + 1)); }
wait_grabbed $((GRABBED + 1)) "new binding grabbed"
press "<Super>F9"; expect "new binding works" "$(field GetState activeWorkspace)" 4
cp "$CFG.orig" "$CFG"; cmd reload >/dev/null
wait_grabbed "$GRABBED" "original grabs after restore"

echo "== result: $FAILS failure(s)"
exit "$FAILS"
