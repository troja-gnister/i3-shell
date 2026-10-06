# The nested harness's critical-log gate. Sourced by inside.sh and by criticals-selftest.sh.
#
# Definitions only: no `set`, no side effects, nothing that needs a session, so the self-test can source
# it on any machine. Every allowance below is named, commented with WHY it is GNOME's and not ours, and
# reported as a note whenever it actually appears -- the contract UPSTREAM_STACK_ASSERTION already set.
#
# THE SCAN IS SPLIT IN TWO at the moment the harness itself starts shutting gnome-shell down.
#
#   before the marker -- the session.  Nothing new is allowed. In particular the GC-sweeping critical is
#       FATAL here, because it is also the signature of an actor leak ("most likely caused by not
#       destroying a Clutter actor or Gtk+ widget with ::destroy signals connected") and this extension
#       creates bars, borders, a launcher actor and a Quick Settings toggle. phase2-checks.py
#       --name-conflict disables and re-enables the extension THREE times, all of them in this window, so
#       this is where a leak on disable() shows up and this is where the detector has to stay.
#
#   after the marker -- GNOME's own teardown.  The five messages below are allowed. They are GNOME
#       tearing down its own search results, date menu and deferred-work queue in a race with its own
#       collector; measured flake rate on --name-conflict before this split was 1/3, then two consecutive
#       full-suite failures, then 1/2, with the SAME build passing and failing across attempts.
#
# What this narrows, said rather than hidden: an actor leaked by this extension and collected only during
# the final teardown, after the marker, is now allowed. The alternatives are worse -- allowlisting the GC
# message by text loses the detector outright, and re-running the step on failure would hide a genuine
# intermittent leak -- but the narrowing is real and this comment is the record of it.
#
# The marker's position in the file is trustworthy because GLib's default log writer writes each message
# to the fd directly rather than through a libc buffer, so a critical already emitted is already in the
# file when bash appends the marker. (Ordinary JS `print()` output IS buffered and may land out of order;
# the gate greps only *-CRITICAL lines, which never take that path.)

SHUTDOWN_MARKER='--- i3-shell harness: gnome-shell shutdown begins ---'

# THREE upstream Mutter assertions are excluded, by exact text, in BOTH scopes: this one, and the
# hotplug pair after it. This one first. The suite
# deliberately maps a window fullscreen (phase2-checks.py scenario_fullscreen_at_map) and mutter 50.5
# raises such a window before it is in the stack: xdg_toplevel.set_fullscreen ->
# meta_window_make_fullscreen -> meta_window_make_fullscreen_internal -> meta_window_raise ->
# meta_stack_raise, while meta_window_wayland_is_stackable() is still false because the surface has no
# buffer yet. That is before any first frame, so before this extension has made a single call against the
# window. It is characterised rather than ignored: the scenario asserts the complementary prediction, that
# a fullscreen window mapped alone does not produce it. Its presence is always reported.
# Delete this filter when mutter fixes it; the scenario still passes without it.
UPSTREAM_STACK_ASSERTION="meta_window_set_stack_position_no_sync: assertion 'window->stack_position >= 0' failed"

# TWO MORE upstream Mutter assertions, excluded by exact text in BOTH scopes. phase5-checks.py --hotplug
# removes an output and plugs it back in, and Mutter logs this pair -- twice, inside one millisecond --
# while every scenario assertion around it passes, including the workspace going home to the second
# output and keeping its children and percentages.
#
# WHY THESE ARE GNOME'S AND NOT OURS, measured rather than argued. src/shell/geometry.ts holds the only
# call site in this project that reaches any Mutter work-area or logical-monitor API (grepped over src/
# for work_area|workArea|get_monitor_geometry|logical_monitor: one hit). That call site was instrumented
# to log the monitor number it passes and the live get_logical_monitors().length on every call, and the
# hotplug scenario was run: 106 probe lines, every one with index < liveLogicalCount, and our FIRST
# work-area call of the reconfiguration landed 39 ms AFTER the criticals were already in the log. So the
# caller is not this extension; it is GNOME's own hotplug handling, reacting to the unplug before our
# monitors-changed handler runs. What exactly it was doing there is not established -- relocating the two
# windows that were on the removed output is the plausible guess, and it stays a guess.
#
# THE COST, stated rather than hidden. `meta_workspace_get_work_area_for_monitor: assertion
# 'logical_monitor != NULL' failed` is also the exact text a bad call of OURS would print, so this
# exclusion blinds the gate to that. The replacement for the lost detection is readTopology's
# `index >= logicalCount` guard in src/shell/geometryTopology.ts, which rejects a monitor number Mutter's
# logical-monitor list does not have BEFORE `workArea` is called with it, plus the unit test that pins it:
# "never asks Mutter for the work area of a logical monitor number it no longer has" in
# test/unit/shell/geometryTopology.test.ts, which asserts the number never reaches Mutter at all.
#
# FIXED STRINGS, one `grep -vF` each, never `grep -vE`. Both texts contain ERE metacharacters --
# `(unsigned int)` and `(manager->logical_monitors)` -- and as an ERE those parentheses are groups, so the
# pattern would also match lines without them: more than the one text each allowance covers, which is the
# one error this file cannot afford. criticals-selftest.sh pins it with an ERE-lookalike line that must
# still be reported. Their presence is always reported, via upstream_hotplug_notes below, so the
# allowance cannot quietly stop being needed. Delete both filters when mutter fixes this; the scenario
# passes without them -- it is only the gate that fails.
UPSTREAM_HOTPLUG_LOGICAL_MONITOR="meta_monitor_manager_get_logical_monitor_from_number: assertion '(unsigned int) number < g_list_length (manager->logical_monitors)' failed"
UPSTREAM_HOTPLUG_WORK_AREA="meta_workspace_get_work_area_for_monitor: assertion 'logical_monitor != NULL' failed"

# ALLOWED AFTER SHUTDOWN ONLY, each by the name of a GNOME-OWNED object.
#
# Three GJS class names from GNOME Shell's own js/ui: the search list's MaxWidthBox and
# ListSearchResults, and the date menu's EventsSection. GNOME disposes them from C during teardown while
# its own JS still holds wrappers. This extension can never be confused with them: it registers no
# GObject class at all (verified -- `rg 'registerClass' src/` finds nothing), so its own actors are
# reported either by St type name (St.BoxLayout, St.Button, St.Widget) or, where it instantiates a class
# GNOME itself registered, by that class's own Gjs_ name -- `PanelMenu.Button`, and
# `QuickSettings.QuickToggle` and `QuickSettings.SystemIndicator` since the Quick Settings toggle landed,
# which report as `Gjs_ui_quickSettings_*`. Neither kind is allowlisted, so both stay fatal in both
# scopes: the allowance is by exact name and the three names it grants belong to objects this extension
# never builds.
GNOME_DISPOSED_WIDGETS='Gjs_ui_search_MaxWidthBox|Gjs_ui_search_ListSearchResults|Gjs_ui_dateMenu_EventsSection'

# GNOME Shell's own deferred-work queue (js/ui/main.js `queueDeferredWork`), which it drains after the
# work ids have been dropped. This extension never calls it -- verified, `rg 'queueDeferredWork' src/`
# finds nothing; it defers through GLib.idle_add in src/extension.ts -- so any such line is GNOME's by
# construction. Matched on the message rather than the id, because the id varies between runs.
GNOME_DEFERRED_WORK='Invalid work id'

# GJS's collector refusing to re-enter JS during a sweep. Allowed AFTER the marker only; see the ruling
# in the header. This is the one entry whose text alone cannot tell GNOME's teardown from an actor leak of
# ours, which is the entire reason the scan is split by time instead.
GC_SWEEPING='Attempting to call back into JSAPI during the sweeping phase of GC'

# Appends the marker. Called by inside.sh's cleanup() immediately before it signals gnome-shell.
mark_shutdown() {
  printf '%s\n' "$SHUTDOWN_MARKER" >>"$1"
}

# Everything logged strictly before the marker. With no marker -- the shell died before the harness
# announced shutdown -- this is the whole file, so nothing is excused. Fail safe, on purpose.
_before_shutdown() {
  awk -v marker="$SHUTDOWN_MARKER" 'index($0, marker) { exit } { print }' "$1"
}

# Everything logged after the marker; empty when there is none.
_after_shutdown() {
  awk -v marker="$SHUTDOWN_MARKER" 'seen { print } index($0, marker) { seen = 1 }' "$1"
}

# Every critical on stdin, less the three always-excluded upstream assertions.
# grep -E, not rg: a missing ripgrep exits 127, the condition reads false and the gate would pass
# silently. The one ERE here is the subsystem alternation, which is plain ERE; the three exclusions are
# matched as fixed strings, one -F each, because two of those texts contain ERE metacharacters.
_critical_lines() {
  grep -E '(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL' |
    grep -vF "$UPSTREAM_STACK_ASSERTION" |
    grep -vF "$UPSTREAM_HOTPLUG_LOGICAL_MONITOR" |
    grep -vF "$UPSTREAM_HOTPLUG_WORK_AREA"
}

# Fatal criticals from the session proper. Nothing beyond the three upstream assertions is allowed.
session_criticals() {
  [[ -f "$1" ]] || return 0
  _before_shutdown "$1" | _critical_lines || true
}

# Fatal criticals from GNOME's own teardown: everything that is not one of the five named allowances.
shutdown_criticals() {
  [[ -f "$1" ]] || return 0
  _after_shutdown "$1" | _critical_lines |
    grep -vE "$GNOME_DISPOSED_WIDGETS" | grep -vF "$GNOME_DEFERRED_WORK" | grep -vF "$GC_SWEEPING" || true
}

# The allowed teardown criticals that actually appeared, so every allowance is reported and none of them
# can quietly stop being needed.
allowed_shutdown_notes() {
  [[ -f "$1" ]] || return 0
  _after_shutdown "$1" | _critical_lines |
    grep -E "$GNOME_DISPOSED_WIDGETS|$GNOME_DEFERRED_WORK|$GC_SWEEPING" || true
}

# The excluded hotplug pair, whenever it actually appeared, so that allowance is reported too. Unlike the
# teardown notes this reads the WHOLE log and not just one scope, because the pair is logged during the
# session, before the marker -- which is exactly where nothing else is excused. inside.sh prints it; it
# lives here so criticals-selftest.sh can prove the note fires without a session. -F with two -e
# patterns, for the same reason the exclusions use -F.
upstream_hotplug_notes() {
  [[ -f "$1" ]] || return 0
  grep -E '(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL' "$1" |
    grep -F -e "$UPSTREAM_HOTPLUG_LOGICAL_MONITOR" -e "$UPSTREAM_HOTPLUG_WORK_AREA" || true
}
