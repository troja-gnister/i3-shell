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
#   after the marker -- GNOME's own teardown.  A critical here is attributed by the STACK TRACE GJS
#       prints under it, not by the name of the object it mentions. With a trace block: fatal if and only
#       if some frame of that block names this extension (OUR_FRAME, below). With no trace block at all:
#       exactly the old rule, fatal unless the text matches one of the two named allowances -- which is
#       the case that keeps libmutter's C-side criticals handled, since those carry no trace. Measured
#       flake rate on --name-conflict before the scan was split was 1/3, then two consecutive full-suite
#       failures, then 1/2, with the SAME build passing and failing across attempts.
#
# What this narrows, said rather than hidden. THREE costs, two old and one new:
#
#   1. An actor leaked by this extension and collected only during the final teardown, after the marker,
#      is allowed. The alternatives are worse -- allowlisting the GC message by text loses the detector
#      outright, and re-running the step on failure would hide a genuine intermittent leak -- but the
#      narrowing is real and this comment is the record of it.
#   2. NEW, and the price of attributing by trace: a critical from OUR OWN code that GJS prints with NO
#      stack trace, after the marker, is now allowed where a match on the object's name might have caught
#      it. Whether that case occurs at all is NOT established here -- it is not claimed to be impossible,
#      only unmeasured. The compensating control is the pre-marker scope, which is untouched and excuses
#      nothing, and which is where --name-conflict does its three disable/enable cycles.
#   3. Also new, and the narrower half of the same trade: a disposed-object critical that names an actor
#      of ours but is raised entirely from GNOME's own frames is allowed, where matching `St.BoxLayout` by
#      name would have failed the run. What is given up there is a check that was shown not to work --
#      GNOME builds St.BoxLayout too, and that exact reading is what produced a false positive on
#      GNOME's Background Apps toggle. See OUR_FRAME for the measurement.
#
# The marker's position in the file is trustworthy because GLib's default log writer writes each message
# to the fd directly rather than through a libc buffer, so a critical already emitted is already in the
# file when bash appends the marker. (Ordinary JS `print()` output IS buffered and may land out of order;
# the gate greps only *-CRITICAL lines, which never take that path.)

SHUTDOWN_MARKER='--- i3-shell harness: gnome-shell shutdown begins ---'

# WHICH LINES ARE CRITICALS, in one place. `_critical_lines`, `upstream_hotplug_notes` and the trace
# scanner in `_by_trace` all have to agree on this exactly, and three copies of one ERE are three things
# to keep in step. Plain ERE, the same in grep -E and in awk: an alternation of subsystem prefixes, no
# metacharacter that depends on the dialect.
CRITICAL_SUBSYSTEMS='(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL'

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

# ATTRIBUTION AFTER SHUTDOWN: the substring that marks a stack frame as THIS EXTENSION'S.
#
# WHAT THIS REPLACED. Until now three GNOME object names were allowed in the post-marker scope by name --
# `GNOME_DISPOSED_WIDGETS`, holding Gjs_ui_search_MaxWidthBox, Gjs_ui_search_ListSearchResults and
# Gjs_ui_dateMenu_EventsSection -- on the argument that this extension registers no GObject class of its
# own (still true: `rg 'registerClass' src/` finds nothing) and so would be reported by St type name,
# St.BoxLayout / St.Button / St.Widget, or by `Gjs_ui_quickSettings_*` for the classes it instantiates
# from GNOME's own code. The St half of that argument is false, and a full native run proved it: three
# criticals after the marker -- a Gjs_status_backgroundApps_BackgroundAppsToggle, a
# Gjs_ui_popupMenu_PopupMenuItem, and an `St.BoxLayout` built by GNOME's own popupMenu.js:934 -- every
# frame of all three inside resource:///org/gnome/shell/..., GNOME's Background Apps toggle tearing down
# its own menu, after every assertion of phase2-checks.py --name-conflict had passed. The name list was
# also an open set over GNOME internals: each new GNOME object that happens to log during teardown fails
# the suite. Attribution by trace is a closed set over code this project owns, and it is strictly stronger
# for our own leaks -- it catches a leaked object of ANY type, not only the three names it used to list.
#
# GNOME_DISPOSED_WIDGETS IS GONE RATHER THAN KEPT AS A SECOND LINE, because nothing reaches it: every
# "has been already disposed" critical GJS emits carries a dumpstack, so all three of those names arrive
# WITH a trace and the trace decides. That is the code path, not the class -- measured directly, outside
# any session: `o = new Gio.SimpleAction(...); o.run_dispose(); o.enabled = false` under plain gjs printed
# the critical and a `== Stack trace` block under it. A filter nothing can reach is worse than no filter:
# it reads as live attribution logic and invites a fourth name. If one of those three ever does appear
# untraced the gate fails, and that is the signal to go and look at it, not to re-add a name.
#
# WHAT IDENTIFIES OUR FRAMES, measured rather than argued. GNOME Shell's own JS is loaded from a
# GResource, so its frames read `resource:///org/gnome/...` and carry no filesystem path at all. This
# extension is loaded from a directory, and every spelling that directory can have contains this
# substring: the installed UUID is `i3-shell@troja` (Makefile EXTDIR), the nested harness symlinks that
# same name inside its `/tmp/i3-shell-nested.XXXXXX` sandbox root (nested.sh), and the symlink's target is
# this repo's own `.../i3-shell/dist`.
#   * GJS prints a frame as the URI the module was imported from and does NOT resolve the symlink: an
#     import of `<dir>/i3-shell@troja/extension.js` whose target path contained no `i3-shell` at all
#     printed `#0 ... file:///<dir>/i3-shell@troja/extension.js:5`. So the UUID spelling is the one that
#     actually shows up, and the sandbox root is a second, independent occurrence.
#   * dist/extension.js is a single bundle with no sourceMappingURL (checked), so nothing rewrites those
#     frames to src/ paths.
#   * No frame in any of the four nested shell.logs from this session's failing runs contains it; all of
#     their frames are resource:/// frames.
# Only FRAME lines are tested, never the critical's own message text. The message names the object, and
# reading ownership out of an object name is precisely the discriminator this change exists to remove.
OUR_FRAME='i3-shell'

# ALLOWED AFTER SHUTDOWN BY TEXT, and only when the critical carries no stack trace at all. Two of them.
#
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

# Splits post-marker criticals by WHO their stack trace blames. Reads a log scope on stdin and emits
# whole critical lines, nothing else -- the trace blocks themselves are consumed here, which is also why
# this has to run BEFORE `_critical_lines` throws the non-critical lines away.
#
#   _by_trace fatal  -- the criticals this gate must still judge: every one with no trace block, plus
#                       every traced one with at least one frame of ours. GNOME_DEFERRED_WORK and
#                       GC_SWEEPING are applied to THIS stream, so a text allowance can now only ever
#                       excuse an untraced critical.
#   _by_trace gnome  -- the criticals attribution excused: a trace block, and no frame of ours in it.
# `gnome` is the mode that has to be spelled exactly; anything else is treated as `fatal`, so a mistyped
# mode over-reports to shutdown_criticals instead of silently emptying it. (A mistyped `gnome` empties the
# note, which criticals-selftest.sh catches; a gate that fails open would not be caught by anything.)
#
# A trace block is the `== Stack trace for context` line IMMEDIATELY after a critical plus the contiguous
# `#N ` frame lines under it. Both halves of that are read off the real log rather than assumed:
#   * nothing separates a critical from its trace header in /tmp/i3-shell-nested.egGsmS/shell.log, and
#   * the frame run is NOT blank-line terminated -- the third trace's last frame (line 203 of that file)
#     is followed directly by a libmutter-Message. The blank lines in that file belong to the NEXT
#     message, because GLib's default handler prefixes each critical with a newline. So the block ends at
#     the first line that is not a frame, and at end of file -- which is where the last real trace ends.
# Requiring adjacency rather than searching forward for the next trace block is deliberate. gnome-shell
# writes the critical and its dumpstack as separate writes, so another thread's message can land between
# them; a forward search would then hand one critical another's trace. Here the critical simply looks
# untraced, which routes it to the text rule and keeps it fatal -- the safe direction.
_by_trace() {                   # _by_trace <fatal|gnome>
  awk -v want="$1" -v pat="$CRITICAL_SUBSYSTEMS" -v mine="$OUR_FRAME" '
    function decide() {
      if (pending == "") return
      if (traced && !ours) { if (want == "gnome") print pending }
      else if (want != "gnome") print pending
      pending = ""; traced = 0; ours = 0
    }
    $0 ~ pat                                                   { decide(); pending = $0; next }
    pending != "" && !traced && /^== Stack trace for context/   { traced = 1; next }
    pending != "" && traced && /^#[0-9]+[[:space:]]/            { if (index($0, mine)) ours = 1; next }
                                                                { decide() }
    END                                                        { decide() }
  '
}

# Every critical on stdin, less the three always-excluded upstream assertions.
# grep -E, not rg: a missing ripgrep exits 127, the condition reads false and the gate would pass
# silently. The one ERE here is the subsystem alternation, which is plain ERE; the three exclusions are
# matched as fixed strings, one -F each, because two of those texts contain ERE metacharacters.
_critical_lines() {
  grep -E "$CRITICAL_SUBSYSTEMS" |
    grep -vF "$UPSTREAM_STACK_ASSERTION" |
    grep -vF "$UPSTREAM_HOTPLUG_LOGICAL_MONITOR" |
    grep -vF "$UPSTREAM_HOTPLUG_WORK_AREA"
}

# Fatal criticals from the session proper. Nothing beyond the three upstream assertions is allowed.
session_criticals() {
  [[ -f "$1" ]] || return 0
  _before_shutdown "$1" | _critical_lines || true
}

# Fatal criticals from GNOME's own teardown: a traced critical with a frame of ours, or an untraced one
# whose text matches neither named allowance.
shutdown_criticals() {
  [[ -f "$1" ]] || return 0
  _after_shutdown "$1" | _by_trace fatal | _critical_lines |
    grep -vF "$GNOME_DEFERRED_WORK" | grep -vF "$GC_SWEEPING" || true
}

# The two text allowances, whenever they actually fired, so neither can quietly stop being needed. Reads
# the `fatal` stream on purpose: a traced critical is already decided by attribution, so these texts can
# only excuse an untraced one and this note only reports the cases where they did the work. Should the
# GC-sweeping or deferred-work critical ever start arriving WITH a trace, this note goes quiet and the one
# below picks it up -- and a GC-sweeping critical whose trace names us becomes fatal even after the
# marker, which is stronger than the text rule ever was.
# grep -F with two -e patterns, for the same reason the exclusions use -F: these are fixed texts.
allowed_shutdown_notes() {
  [[ -f "$1" ]] || return 0
  _after_shutdown "$1" | _by_trace fatal | _critical_lines |
    grep -F -e "$GNOME_DEFERRED_WORK" -e "$GC_SWEEPING" || true
}

# The post-marker criticals that stack-trace attribution excused, reported for the same reason every other
# allowance is: so it cannot go quiet unnoticed, and so the count is in the run's own output.
#
# WHAT THIS NOTE CANNOT TELL YOU, since the note is the record. It says that no frame of the trace GJS
# printed names this extension -- nobody in our code was on the stack that logged. It does NOT say the
# object was GNOME's. An actor leaked by this extension and disposed during teardown entirely from GNOME's
# frames would be reported here, indistinguishable from GNOME's own widgets; cost 3 in the header. What
# rules that case out is the pre-marker scope, not this message.
gnome_traced_shutdown_notes() {
  [[ -f "$1" ]] || return 0
  _after_shutdown "$1" | _by_trace gnome | _critical_lines || true
}

# The excluded hotplug pair, whenever it actually appeared, so that allowance is reported too. Unlike the
# teardown notes this reads the WHOLE log and not just one scope, because the pair is logged during the
# session, before the marker -- which is exactly where nothing else is excused. inside.sh prints it; it
# lives here so criticals-selftest.sh can prove the note fires without a session. -F with two -e
# patterns, for the same reason the exclusions use -F.
upstream_hotplug_notes() {
  [[ -f "$1" ]] || return 0
  grep -E "$CRITICAL_SUBSYSTEMS" "$1" |
    grep -F -e "$UPSTREAM_HOTPLUG_LOGICAL_MONITOR" -e "$UPSTREAM_HOTPLUG_WORK_AREA" || true
}
