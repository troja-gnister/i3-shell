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
# A disposal critical with no stack trace under it and a text that matches no named allowance: fatal
# after the marker by the no-trace rule. Its `St.BoxLayout` name is NOT what makes it fatal any more --
# criticals.sh's header records that GNOME builds St.BoxLayout too, which is what killed the name rule.
# Ownership is pinned by trace instead, in section 16.
OURS='Gjs-CRITICAL **: 10:00:00.005: Object St.BoxLayout (0x8), has been already deallocated'

TRACE_HEADER='== Stack trace for context 0x55b163ce9440 =='
FRAME_GNOME='#0   55b163dbac48 i   resource:///org/gnome/shell/ui/status/backgroundApps.js:196 (3f465a7bb790 @ 163)'
FRAME_MAIN='#1   55b163dbaa78 i   resource:///org/gnome/shell/ui/main.js:277 (2ee75dcf7790 @ 119)'
# A frame from this extension, spelled the way the nested harness makes GJS spell it: the sandbox root is
# /tmp/i3-shell-nested.XXXXXX and the extension directory inside it is the UUID i3-shell@troja. GJS prints
# the URI the module was imported from and does not resolve the symlink to dist/ (measured; see
# criticals.sh's OUR_FRAME).
FRAME_OURS='#1   55b163dbaa78 i   file:///tmp/i3-shell-nested.egGsmS/data/gnome-shell/extensions/i3-shell@troja/extension.js:4127 (2ee75dcf7790 @ 119)'
TOGGLE='(gnome-shell:290300): Gjs-CRITICAL **: 18:29:39.326: Object Gjs_status_backgroundApps_BackgroundAppsToggle (0x55b168846db0), has been already disposed'

log() {                         # log <name> <line>... ; writes $WORK/<name>.log
  local name=$1; shift
  printf '%s\n' "$@" >"$WORK/$name.log"
  printf '%s\n' "$WORK/$name.log"
}

# Same, but the body comes from stdin so a real log excerpt can be pasted in verbatim -- blank lines,
# stack frames and all -- instead of being retyped as one argument per line. Any arguments are written
# first, which is how the marker gets in front of a pasted block.
log_block() {                   # log_block <name> [line]... < <body> ; writes $WORK/<name>.log
  local name=$1; shift
  { (($#)) && printf '%s\n' "$@"; cat; } >"$WORK/$name.log"
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

# 5. All three GNOME-owned disposed widgets, as they actually arrive -- each with a trace block whose
#    frames are GNOME's own -- plus the untraced deferred-work id: allowed after the marker, fatal before.
#    The three names used to be allowed BY NAME; that allowlist is gone and section 16g pins its absence.
gnome_after=$(log gnome_after "$SHUTDOWN_MARKER" \
  "$DISPOSED" "$TRACE_HEADER" "$FRAME_GNOME" \
  "$LISTRESULTS" "$TRACE_HEADER" "$FRAME_GNOME" \
  "$EVENTS" "$TRACE_HEADER" "$FRAME_MAIN" \
  "$WORKID")
check "GNOME's own disposed widgets are allowed after shutdown" '' "$(shutdown_criticals "$gnome_after")"
gnome_before=$(log gnome_before "$DISPOSED" "$SHUTDOWN_MARKER")
check "GNOME's own disposed widget is fatal before shutdown" "$DISPOSED" "$(session_criticals "$gnome_before")"

# 6. THE NO-TRACE RULE'S FATAL DIRECTION. A disposal critical with no trace block and no matching text
#    allowance is still fatal after the marker. This case says nothing about who owns the object -- the
#    St.* type name is not evidence either way; 16b is what pins ownership.
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

# 16. ATTRIBUTION AFTER SHUTDOWN IS BY STACK TRACE, NOT BY OBJECT NAME. Everything in this section uses
#     ONE critical message, GNOME's real BackgroundAppsToggle disposal, and changes nothing but the trace
#     block under it. That is the whole point: if any part of the gate still read the object name, the
#     first two cases below could not disagree, because their critical lines are byte-identical.

# 16a. All frames GNOME's own: allowed, and reported as a note so the allowance cannot go quiet.
traced_gnome=$(log traced_gnome "$SHUTDOWN_MARKER" "$TOGGLE" "$TRACE_HEADER" "$FRAME_GNOME" "$FRAME_MAIN")
check 'a traced critical with only GNOME frames is allowed after shutdown' '' \
  "$(shutdown_criticals "$traced_gnome")"
check 'a traced GNOME critical is reported as a note' "$TOGGLE" \
  "$(gnome_traced_shutdown_notes "$traced_gnome")"
check 'a traced GNOME critical is not reported as a named text allowance' '' \
  "$(allowed_shutdown_notes "$traced_gnome")"

# 16b. THE SAME LINE, one frame naming the extension: still fatal. Byte-identical critical text to 16a,
#      so no object-name rule and no message-text rule can tell these two apart -- only the trace can.
traced_ours=$(log traced_ours "$SHUTDOWN_MARKER" "$TOGGLE" "$TRACE_HEADER" "$FRAME_GNOME" "$FRAME_OURS")
check 'a traced critical with one frame of ours is still fatal after shutdown' "$TOGGLE" \
  "$(shutdown_criticals "$traced_ours")"
check 'a critical attributed to us is not reported as an allowed note' '' \
  "$(gnome_traced_shutdown_notes "$traced_ours")"

# 16c. THE SAME LINE AGAIN with no trace block at all: the text rule decides, and this text matches no
#      allowance, so it is fatal. Three fixtures, one critical line, three different verdicts.
untraced=$(log untraced "$SHUTDOWN_MARKER" "$TOGGLE")
check 'an untraced critical matching no allowance is fatal after shutdown' "$TOGGLE" \
  "$(shutdown_criticals "$untraced")"
check 'an untraced critical is not reported as a traced GNOME note' '' \
  "$(gnome_traced_shutdown_notes "$untraced")"

# 16d. The other half of the no-trace rule, which is the half that keeps libmutter's C criticals working:
#      no trace block, text matches a named allowance, allowed and reported. The GC-sweeping line is the
#      one that matters most, because it is also the actor-leak signature.
untraced_allowed=$(log untraced_allowed "$SHUTDOWN_MARKER" "$SWEEP" "$WORKID")
check 'an untraced critical matching a named allowance is allowed after shutdown' '' \
  "$(shutdown_criticals "$untraced_allowed")"
check 'an untraced allowed critical is reported as a named text allowance' "$SWEEP
$WORKID" "$(allowed_shutdown_notes "$untraced_allowed")"

# 16e. THE SESSION SCOPE DID NOT CHANGE. The same all-GNOME-frames critical BEFORE the marker is still
#      fatal: attribution by trace is a post-marker rule only, and the pre-marker scope -- where
#      --name-conflict disables and re-enables the extension three times -- excuses nothing.
traced_before=$(log traced_before "$TOGGLE" "$TRACE_HEADER" "$FRAME_GNOME" "$FRAME_MAIN" "$SHUTDOWN_MARKER")
check 'a traced GNOME critical is still fatal before shutdown' "$TOGGLE" \
  "$(session_criticals "$traced_before")"
check 'a pre-marker traced critical is not reported as an allowed teardown note' '' \
  "$(gnome_traced_shutdown_notes "$traced_before")"

# 16f. THE REAL FAILING RUN, verbatim. Lines 183-203 of /tmp/i3-shell-nested.egGsmS/shell.log: the three
#      criticals that failed a full native run after every assertion of phase2-checks.py --name-conflict
#      had passed, with their real traces, their real blank lines, and NO trailing blank or further line
#      after the last frame -- so this fixture also pins that a trace block running to end of file is
#      still recognised as a trace block. All three are GNOME's Background Apps toggle tearing down its
#      own menu; one of them is an St.BoxLayout, which is why the old St-type-name reasoning had to go.
real_run=$(log_block real_run "$SHUTDOWN_MARKER" <<'EOF'

(gnome-shell:290300): Gjs-CRITICAL **: 18:29:39.326: Object Gjs_status_backgroundApps_BackgroundAppsToggle (0x55b168846db0), has been already disposed — impossible to set any property on it. This might be caused by the object having been destroyed from C code using something such as destroy(), dispose(), or remove() vfuncs.
== Stack trace for context 0x55b163ce9440 ==
#0   55b163dbac48 i   resource:///org/gnome/shell/ui/status/backgroundApps.js:196 (3f465a7bb790 @ 163)
#1   55b163dbab98 i   resource:///org/gnome/shell/ui/status/backgroundApps.js:200 (3f465a7bb7e0 @ 34)
#2   55b163dbab18 i   resource:///org/gnome/shell/ui/status/backgroundApps.js:163 (3f465a7bb650 @ 12)
#3   55b163dbaa78 i   resource:///org/gnome/shell/ui/main.js:277 (2ee75dcf7790 @ 119)

(gnome-shell:290300): Gjs-CRITICAL **: 18:29:39.327: Object St.BoxLayout (0x55b168876c60), has been already disposed — impossible to access it. This might be caused by the object having been destroyed from C code using something such as destroy(), dispose(), or remove() vfuncs.
== Stack trace for context 0x55b163ce9440 ==
#0   55b163dbac48 i   resource:///org/gnome/shell/ui/popupMenu.js:934 (36d63e64e290 @ 22)
#1   7ffeccecdeb0 b   resource:///org/gnome/shell/ui/popupMenu.js:952 (36d63e64e420 @ 23)
#2   55b163dbab98 i   resource:///org/gnome/shell/ui/status/backgroundApps.js:207 (3f465a7bb7e0 @ 107)
#3   55b163dbab18 i   resource:///org/gnome/shell/ui/status/backgroundApps.js:163 (3f465a7bb650 @ 12)
#4   55b163dbaa78 i   resource:///org/gnome/shell/ui/main.js:277 (2ee75dcf7790 @ 119)

(gnome-shell:290300): Gjs-CRITICAL **: 18:29:39.327: Object Gjs_ui_popupMenu_PopupMenuItem (0x55b168870890), has been already disposed — impossible to set any property on it. This might be caused by the object having been destroyed from C code using something such as destroy(), dispose(), or remove() vfuncs.
== Stack trace for context 0x55b163ce9440 ==
#0   55b163dbab98 i   resource:///org/gnome/shell/ui/status/backgroundApps.js:243 (3f465a7bb7e0 @ 341)
#1   55b163dbab18 i   resource:///org/gnome/shell/ui/status/backgroundApps.js:163 (3f465a7bb650 @ 12)
#2   55b163dbaa78 i   resource:///org/gnome/shell/ui/main.js:277 (2ee75dcf7790 @ 119)
EOF
)
check "the real failing teardown block is allowed after shutdown" '' "$(shutdown_criticals "$real_run")"
check "all three real teardown criticals are reported as notes" '3' \
  "$(gnome_traced_shutdown_notes "$real_run" | wc -l)"
check "the real block's St.BoxLayout is not singled out by type name" '' \
  "$(shutdown_criticals "$real_run" | grep -F 'St.BoxLayout' || true)"
# ...and the same three lines, stripped of their traces, are fatal: nothing in the file excuses them by
# name any more, which is what makes 16f a test of the trace and not of the text.
real_untraced=$(log_block real_untraced "$SHUTDOWN_MARKER" < <(grep -F -- '-CRITICAL' "$real_run"))
check 'the real three criticals without their traces are all fatal' '3' \
  "$(shutdown_criticals "$real_untraced" | wc -l)"

# 16g. GNOME_DISPOSED_WIDGETS IS GONE, and this pins that it does not come back. Every "has been already
#      disposed" critical GJS prints carries a dumpstack -- measured directly with gjs, for a plain
#      Gio.SimpleAction, so it is the code path and not the class that guarantees it -- so the three
#      GNOME widget names the old allowlist held are reached by the trace rule instead. Untraced, they are
#      fatal, deliberately: if one ever shows up without a trace the gate fails, and that is the signal to
#      go and look, not to re-add a name.
ex_allowlisted=$(log ex_allowlisted "$SHUTDOWN_MARKER" "$DISPOSED" "$LISTRESULTS" "$EVENTS")
check 'the three ex-allowlisted GNOME widget names are fatal when untraced' "$DISPOSED
$LISTRESULTS
$EVENTS" "$(shutdown_criticals "$ex_allowlisted")"
# ...and allowed when GNOME's own frames carry them, which is how they actually appear.
ex_traced=$(log ex_traced "$SHUTDOWN_MARKER" "$DISPOSED" "$TRACE_HEADER" "$FRAME_GNOME" "$EVENTS" "$TRACE_HEADER" "$FRAME_MAIN")
check 'the same three names are allowed when their traces are GNOME-only' '' \
  "$(shutdown_criticals "$ex_traced")"

# 16h. THE TRACE BLOCK MUST BE ADJACENT. gnome-shell writes the critical and its dumpstack with separate
#      writes, so another thread's message can land between them; a scanner that searched forward for the
#      next trace block would then attribute one critical's trace to another. Here an unrelated message
#      separates the two, and the critical is treated as untraced -- fatal, the safe direction.
interleaved=$(log interleaved "$SHUTDOWN_MARKER" "$TOGGLE" 'libmutter-Message: 18:29:39.436: Removed virtual monitor Meta-0' "$TRACE_HEADER" "$FRAME_GNOME")
check 'a critical separated from its trace block is treated as untraced' "$TOGGLE" \
  "$(shutdown_criticals "$interleaved")"

# 16i. inside.sh must actually print the new note, or an allowance stops being visible the moment it
#      starts firing. Only the controller can run a session, so pin the call.
check 'inside.sh reports the stack-trace attribution allowance' \
  '1' "$(grep -cF 'gnome_traced_shutdown_notes "$LOG"' "$ROOT/test/integration/inside.sh")"

# 17. WHICH DOMAINS COUNT AS CRITICALS AT ALL -- the gate hole that hid a real bug of ours. Until
#     CRITICAL_SUBSYSTEMS allowed any GLib sub-domain it read `GLib(-GObject)?`, so `GLib-GIO-CRITICAL`
#     matched nothing, was dropped by every one of the three users of that variable, and the line below --
#     our own control skeleton being unexported twice, 1 ms after an [i3-shell] disable, in the session
#     scope where nothing is excused -- passed the gate. Every check in this section fails if the pattern
#     is narrowed back: an unmatched line is not a critical, so each expected-fatal becomes empty.
#     Verbatim from /tmp/i3-shell-nested.egGsmS/shell.log line 129, process prefix and all. It carries NO
#     stack trace there, which is what a C-side g_return_if_fail looks like.
GIO_UNEXPORT="(gnome-shell:290300): GLib-GIO-CRITICAL **: 18:29:37.416: g_dbus_interface_skeleton_unexport: assertion 'interface_->priv->connections != NULL' failed"
# A second GLib sub-domain, to say that the fix is the wildcard and not a second hard-coded name.
GLIB_GMODULE="GLib-GModule-CRITICAL **: 10:00:00.010: g_module_open_full: assertion 'file_name != NULL' failed"

gio_before=$(log gio_before 'GNOME Shell-Message: [i3-shell] disable' "$GIO_UNEXPORT" "$SHUTDOWN_MARKER")
check 'a GLib-GIO critical in the session scope is fatal' "$GIO_UNEXPORT" "$(session_criticals "$gio_before")"
gmodule_before=$(log gmodule_before "$GLIB_GMODULE" "$SHUTDOWN_MARKER")
check 'any GLib sub-domain critical is fatal in the session scope' "$GLIB_GMODULE" \
  "$(session_criticals "$gmodule_before")"
check 'a plain GLib critical is still fatal in the session scope' \
  'GLib-CRITICAL **: 10:00:00.011: g_hash_table_lookup: assertion failed' \
  "$(session_criticals "$(log glib_plain 'GLib-CRITICAL **: 10:00:00.011: g_hash_table_lookup: assertion failed' "$SHUTDOWN_MARKER")")"

# 17a. The same line after the marker, untraced -- which is how a C-side critical really arrives. It
#      matches no named text allowance, so the no-trace rule keeps it fatal there too. This is the check
#      that proves `_by_trace`'s awk copy of the pattern recognises the domain as well: if the awk did not
#      match it, the line would reach neither stream and this would read empty.
gio_after=$(log gio_after "$SHUTDOWN_MARKER" "$GIO_UNEXPORT")
check 'an untraced GLib-GIO critical is fatal after shutdown too' "$GIO_UNEXPORT" \
  "$(shutdown_criticals "$gio_after")"
check 'an untraced GLib-GIO critical is not reported as a traced GNOME note' '' \
  "$(gnome_traced_shutdown_notes "$gio_after")"

# 17b. ...and the trace rule applies to the new domain exactly as to the old ones, in both directions.
#      Same critical line both times; only the frames differ. GIO criticals from C carry no trace, so
#      these two fixtures are synthetic -- they exist to pin that the trace rule and the widened domain
#      compose, rather than that GIO logs this way.
gio_traced_gnome=$(log gio_traced_gnome "$SHUTDOWN_MARKER" "$GIO_UNEXPORT" "$TRACE_HEADER" "$FRAME_GNOME")
check 'a GLib-GIO critical traced to GNOME only is allowed after shutdown' '' \
  "$(shutdown_criticals "$gio_traced_gnome")"
check 'a GLib-GIO critical traced to GNOME only is reported as a note' "$GIO_UNEXPORT" \
  "$(gnome_traced_shutdown_notes "$gio_traced_gnome")"
gio_traced_ours=$(log gio_traced_ours "$SHUTDOWN_MARKER" "$GIO_UNEXPORT" "$TRACE_HEADER" "$FRAME_OURS")
check 'a GLib-GIO critical with a frame of ours is fatal after shutdown' "$GIO_UNEXPORT" \
  "$(shutdown_criticals "$gio_traced_ours")"

# 17c. WHAT THE WILDCARD MUST NOT START MATCHING. Only `-CRITICAL` lines are criticals: GLib's own
#      warnings and messages, under any sub-domain, stay out of every scope.
glib_noise=$(log glib_noise \
  'GLib-GIO-WARNING **: 10:00:00.012: Failed to load module' \
  'GLib-GIO-Message: 10:00:00.013: Using the memory GSettings backend' \
  'GLib-GObject-WARNING **: 10:00:00.014: invalid cast' "$SHUTDOWN_MARKER")
check 'GLib warnings and messages are not criticals' '' "$(session_criticals "$glib_noise")"

# 17d. ...and the sub-domain is ONE ALPHABETIC WORD, not `.*`. This line is synthetic -- nothing logs it --
#      and exists for one purpose, the same as section 13's ERE lookalike: with `GLib(-.*)?-CRITICAL` the
#      `.*` would run from `GLib-` through the message to the `-CRITICAL` later in the text and report a
#      WARNING line as a critical. The sub-domain has to be adjacent to `-CRITICAL` for the line to count.
GLIB_IN_MESSAGE='GNOME Shell-WARNING **: 10:00:00.015: [i3-shell] gate: domain GLib-GIO, suffix -CRITICAL'
glib_in_message=$(log glib_in_message "$GLIB_IN_MESSAGE" "$SHUTDOWN_MARKER")
check 'a warning whose message mentions GLib and -CRITICAL is not a critical' '' \
  "$(session_criticals "$glib_in_message")"

# 17e. THE THREE USERS SHARE ONE VARIABLE. `_critical_lines`, `_by_trace`'s awk and
#      `upstream_hotplug_notes` each reference `$CRITICAL_SUBSYSTEMS`; 17 and 17a exercise the first two
#      directly, and the third cannot be reached with a GIO line because its second filter is the two
#      fixed hotplug texts, which only libmutter prints. So pin the sharing structurally instead: a fourth
#      spelling of the alternation copied into one of them is how these three silently stop agreeing.
check 'all three critical scanners reference the one shared pattern' '3' \
  "$(grep -cF '"$CRITICAL_SUBSYSTEMS"' "$ROOT/test/integration/criticals.sh")"

if ((failures > 0)); then
  echo "$failures critical-gate assertion(s) failed" >&2
  exit 1
fi
echo 'critical-gate self-test: all assertions passed'
