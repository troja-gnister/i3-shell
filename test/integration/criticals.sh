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

# Exactly one upstream Mutter assertion is excluded, by exact text, in BOTH scopes. The suite
# deliberately maps a window fullscreen (phase2-checks.py scenario_fullscreen_at_map) and mutter 50.5
# raises such a window before it is in the stack: xdg_toplevel.set_fullscreen ->
# meta_window_make_fullscreen -> meta_window_make_fullscreen_internal -> meta_window_raise ->
# meta_stack_raise, while meta_window_wayland_is_stackable() is still false because the surface has no
# buffer yet. That is before any first frame, so before this extension has made a single call against the
# window. It is characterised rather than ignored: the scenario asserts the complementary prediction, that
# a fullscreen window mapped alone does not produce it. Its presence is always reported.
# Delete this filter when mutter fixes it; the scenario still passes without it.
UPSTREAM_STACK_ASSERTION="meta_window_set_stack_position_no_sync: assertion 'window->stack_position >= 0' failed"

# ALLOWED AFTER SHUTDOWN ONLY, each by the name of a GNOME-OWNED object.
#
# Three GJS class names from GNOME Shell's own js/ui: the search list's MaxWidthBox and
# ListSearchResults, and the date menu's EventsSection. GNOME disposes them from C during teardown while
# its own JS still holds wrappers. This extension can never be confused with them: it registers no
# GObject class at all (verified -- `rg 'registerClass' src/` finds nothing), so its own actors are
# reported by St type name (St.BoxLayout, St.Button, St.Widget) and are still fatal in both scopes.
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

# Every critical on stdin, less the one always-excluded upstream assertion.
# grep -E, not rg: a missing ripgrep exits 127, the condition reads false and the gate would pass
# silently. Both patterns are plain ERE.
_critical_lines() {
  grep -E '(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL' | grep -vF "$UPSTREAM_STACK_ASSERTION"
}

# Fatal criticals from the session proper. Nothing beyond the upstream assertion is allowed.
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
