#!/usr/bin/env bash
# Tests the critical-log gate itself, against synthetic logs, with no nested session and no gnome-shell.
# Run it directly: bash test/integration/criticals-selftest.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=test/integration/criticals.sh
source "$ROOT/test/integration/criticals.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0

check() {                       # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    echo "  expected: [$2]"
    echo "  observed: [$3]"
    failures=$((failures + 1))
  fi
}

DISPOSED='Gjs-CRITICAL **: 10:00:00.000: Object Gjs_ui_search_MaxWidthBox (0x5), has been already deallocated'
LISTRESULTS='Gjs-CRITICAL **: 10:00:00.001: Object Gjs_ui_search_ListSearchResults (0x6), has been already deallocated'
EVENTS='Gjs-CRITICAL **: 10:00:00.002: Object Gjs_ui_dateMenu_EventsSection (0x7), has been already deallocated'
WORKID='GNOME Shell-CRITICAL **: 10:00:00.003: Invalid work id 2'
SWEEP='Gjs-CRITICAL **: 10:00:00.004: Attempting to call back into JSAPI during the sweeping phase of GC.'
# Deliberately the SAME message as DISPOSED, differing only in the object name: that is what forces the
# allowlist to key on GNOME's class names and not on the generic wording.
OURS='Gjs-CRITICAL **: 10:00:00.005: Object St.BoxLayout (0x8), has been already deallocated'

log() {                         # log <name> <line>... ; writes $WORK/<name>.log
  local name=$1; shift
  printf '%s\n' "$@" >"$WORK/$name.log"
  printf '%s\n' "$WORK/$name.log"
}

# 1. A clean session.
clean=$(log clean 'JS LOG: [i3-shell] enable' "$SHUTDOWN_MARKER" 'JS LOG: bye')
check 'a clean log has no session criticals' '' "$(session_criticals "$clean")"
check 'a clean log has no shutdown criticals' '' "$(shutdown_criticals "$clean")"

# 2. The pre-existing upstream exclusion still applies, in both scopes.
upstream=$(log upstream \
  "libmutter-CRITICAL **: meta_window_set_stack_position_no_sync: assertion 'window->stack_position >= 0' failed" \
  "$SHUTDOWN_MARKER" \
  "libmutter-CRITICAL **: meta_window_set_stack_position_no_sync: assertion 'window->stack_position >= 0' failed")
check 'the upstream stack assertion is excluded before shutdown' '' "$(session_criticals "$upstream")"
check 'the upstream stack assertion is excluded after shutdown' '' "$(shutdown_criticals "$upstream")"

# 3. THE RULING. The GC-sweeping critical is fatal during the session -- that is the window in which
#    --name-conflict disables the extension four times, so it is where an actor leak on disable shows up.
sweep_before=$(log sweep_before "$SWEEP" "$SHUTDOWN_MARKER")
check 'the GC sweeping critical is fatal before shutdown' "$SWEEP" "$(session_criticals "$sweep_before")"
check 'a pre-marker critical is not reported as an allowed teardown note' '' "$(allowed_shutdown_notes "$sweep_before")"

# 4. ...and allowed after it, where it is GNOME tearing its own widgets down.
sweep_after=$(log sweep_after "$SHUTDOWN_MARKER" "$SWEEP")
check 'the GC sweeping critical is allowed after shutdown' '' "$(shutdown_criticals "$sweep_after")"
check 'the GC sweeping critical is not counted as a session critical' '' "$(session_criticals "$sweep_after")"
check 'the allowed GC sweeping critical is reported as a note' "$SWEEP" "$(allowed_shutdown_notes "$sweep_after")"

# 5. All three GNOME-owned disposed widgets, and the deferred-work id: allowed after, fatal before.
gnome_after=$(log gnome_after "$SHUTDOWN_MARKER" "$DISPOSED" "$LISTRESULTS" "$EVENTS" "$WORKID")
check "GNOME's own disposed widgets are allowed after shutdown" '' "$(shutdown_criticals "$gnome_after")"
gnome_before=$(log gnome_before "$DISPOSED" "$SHUTDOWN_MARKER")
check "GNOME's own disposed widget is fatal before shutdown" "$DISPOSED" "$(session_criticals "$gnome_before")"

# 6. THE POINT OF ALLOWLISTING BY NAME. A disposed actor of OUR OWN kind is still fatal after shutdown:
#    the extension registers no GObject class (verified: no `registerClass` anywhere in src/), so its
#    actors are reported as St.* and can never be confused with a Gjs_ui_* name.
ours_after=$(log ours_after "$SHUTDOWN_MARKER" "$OURS")
check 'a disposed St actor of our own is still fatal after shutdown' "$OURS" "$(shutdown_criticals "$ours_after")"

# 7. Fail safe: a log with no marker at all -- the shell died before the harness announced shutdown --
#    is treated as entirely session scope, so nothing is excused.
no_marker=$(log no_marker "$SWEEP" "$DISPOSED" "$OURS")
check 'with no marker every critical is a session critical' "$SWEEP
$DISPOSED
$OURS" "$(session_criticals "$no_marker")"
check 'with no marker nothing is in the shutdown scope' '' "$(shutdown_criticals "$no_marker")"

# 8. A missing log file is not a failure (the shell may never have started), and not a noise source
#    either: without the -f guard awk complains on stderr and the output alone looks identical.
check 'a missing log yields nothing' '' "$(session_criticals "$WORK/absent.log")"
missing_err=$(session_criticals "$WORK/absent.log" 2>&1 >/dev/null)
missing_status=$?
check 'a missing log is silent and succeeds' 'rc=0 err=' "rc=$missing_status err=$missing_err"

# 9. mark_shutdown appends the marker, once, at the end.
marked="$WORK/marked.log"
printf '%s\n' 'JS LOG: hello' >"$marked"
mark_shutdown "$marked"
check 'mark_shutdown appends the marker' "$SHUTDOWN_MARKER" "$(tail -n 1 "$marked")"
check 'mark_shutdown keeps what the log already held' "JS LOG: hello
$SHUTDOWN_MARKER" "$(cat "$marked")"

# 10. The marker only survives because inside.sh opens gnome-shell's stdout in APPEND mode. bash's >>
#     writes at EOF while gnome-shell keeps its own file offset, so with a truncating `>` redirect its
#     shutdown criticals land back on the marker and overwrite it byte for byte (verified by experiment) --
#     the marker vanishes and the whole split degrades to "everything is the session". No synthetic log can
#     catch that, and only the controller can run a session, so pin the redirect itself.
check "inside.sh opens the shell log in append mode, or the marker gets overwritten" \
  '2' "$(grep -cF '>>"$LOG" 2>&1 &' "$ROOT/test/integration/inside.sh")"
check 'inside.sh never truncates the shell log on the gnome-shell redirect' \
  '0' "$(grep -cF 'gnome-shell "${ARGS[@]}" >"$LOG" 2>&1 &' "$ROOT/test/integration/inside.sh")"

if ((failures > 0)); then
  echo "$failures critical-gate assertion(s) failed" >&2
  exit 1
fi
echo 'critical-gate self-test: all assertions passed'
