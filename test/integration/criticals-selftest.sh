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

# 11. THE HOTPLUG EXCLUSION. `phase5-checks.py --hotplug` makes Mutter log this pair, twice in one
#     millisecond, while every scenario assertion passes. Measurement attributes it to GNOME's own
#     hotplug handling and not to this extension -- the full accounting is in criticals.sh. These two
#     texts are excluded in BOTH scopes, so both halves of the split have to be checked.
HOTPLUG_NUMBER="libmutter-CRITICAL **: 10:00:00.006: meta_monitor_manager_get_logical_monitor_from_number: assertion '(unsigned int) number < g_list_length (manager->logical_monitors)' failed"
HOTPLUG_WORKAREA="libmutter-CRITICAL **: 10:00:00.007: meta_workspace_get_work_area_for_monitor: assertion 'logical_monitor != NULL' failed"
# Any OTHER libmutter critical. The exclusion is by exact text, never by subsystem, so this one has to
# survive the filter in the scope where nothing is excused.
OTHER_MUTTER="libmutter-CRITICAL **: 10:00:00.008: meta_window_get_frame_rect: assertion 'window != NULL' failed"

hotplug_before=$(log hotplug_before "$HOTPLUG_NUMBER" "$HOTPLUG_WORKAREA" "$SHUTDOWN_MARKER")
check 'both hotplug assertions are excluded before shutdown' '' "$(session_criticals "$hotplug_before")"
hotplug_after=$(log hotplug_after "$SHUTDOWN_MARKER" "$HOTPLUG_NUMBER" "$HOTPLUG_WORKAREA")
check 'both hotplug assertions are excluded after shutdown' '' "$(shutdown_criticals "$hotplug_after")"

# 12. What the exclusion must NOT swallow: a different libmutter critical in the session scope.
other_before=$(log other_before "$HOTPLUG_NUMBER" "$OTHER_MUTTER" "$SHUTDOWN_MARKER")
check 'a different libmutter critical is still fatal before shutdown' "$OTHER_MUTTER" \
  "$(session_criticals "$other_before")"
other_after=$(log other_after "$SHUTDOWN_MARKER" "$OTHER_MUTTER")
check 'a different libmutter critical is still fatal after shutdown' "$OTHER_MUTTER" \
  "$(shutdown_criticals "$other_after")"

# 13. FIXED STRINGS, NOT ERE. Both excluded texts contain `(unsigned int)` and
#     `(manager->logical_monitors)`, which as an ERE are groups that match the same words WITHOUT their
#     parentheses. The line below is synthetic -- Mutter does not print it -- and exists for exactly one
#     purpose: swapping either `grep -vF` in `_critical_lines` for `grep -vE` makes this check fail,
#     because the filter would then match more than the one text it is allowed to match.
ERE_LOOKALIKE="libmutter-CRITICAL **: 10:00:00.009: meta_monitor_manager_get_logical_monitor_from_number: assertion 'unsigned int number < g_list_length manager->logical_monitors' failed"
ere_before=$(log ere_before "$ERE_LOOKALIKE" "$SHUTDOWN_MARKER")
check 'the exclusion matches the literal text, not it as a regex' "$ERE_LOOKALIKE" \
  "$(session_criticals "$ere_before")"

# 14. The allowance is REPORTED whenever it is used, so it cannot quietly stop being needed. inside.sh
#     prints the note from this function; the function lives here so the note is provable without a
#     session. It reads the whole log, because the pair lands in the session scope.
check 'the hotplug assertions are reported as a note when present' "$HOTPLUG_NUMBER
$HOTPLUG_WORKAREA" "$(upstream_hotplug_notes "$hotplug_before")"
check 'the hotplug note also fires for the pair after shutdown' "$HOTPLUG_NUMBER
$HOTPLUG_WORKAREA" "$(upstream_hotplug_notes "$hotplug_after")"
check 'a clean log produces no hotplug note' '' "$(upstream_hotplug_notes "$clean")"
check 'a different libmutter critical is not reported as the hotplug note' '' \
  "$(upstream_hotplug_notes "$other_after")"
check 'a missing log produces no hotplug note' '' "$(upstream_hotplug_notes "$WORK/absent.log")"

# 15. inside.sh must actually print the note. Only the controller can run a session, so pin the call.
check 'inside.sh reports the hotplug allowance' \
  '1' "$(grep -cF 'upstream_hotplug_notes "$LOG"' "$ROOT/test/integration/inside.sh")"

if ((failures > 0)); then
  echo "$failures critical-gate assertion(s) failed" >&2
  exit 1
fi
echo 'critical-gate self-test: all assertions passed'
