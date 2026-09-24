# Phase 4 — Fidelity design

**Status:** design approved in conversation 2026-09-24; this document is the binding authority for
Phase 4. It extends `2026-09-20-i3-shell-design.md` (the "main spec") and amends §17, named in §7.
Where they disagree, this one wins for Phase 4 subject matter.

**Baseline:** `main` at `93fa6cd`. 909 unit tests in 63 files, 261 nested-shell integration
assertions at exit 0 with zero criticals. Phases 1, 2A, 2B, 3A, 3B and the launcher merged and
pushed; the Phase 1 walk is ticked, the Phase 2 and Phase 3A walks are recorded as passed but their
boxes are unticked, and the Phase 3B and launcher walks are outstanding.

## 1. Brief

Four gaps remain between i3-shell and the user's real config.

1. **`for_window` rules are parsed and ignored.** The config holds one:
   `for_window [title="^Audio (output|input)$"] floating enable, border pixel 2, resize set 720 420, move position center`.
   All four commands already exist; nothing applies them.
2. **`client.urgent` colours are defined and dead.** The config sets
   `client.urgent #EC69A0 #DB3279 #FFFFFF #DB3279 #DB3279`; no code reads urgency.
3. **Directional focus and move stop at a monitor's edge.** `focus_wrapping` is unset, so it defaults
   to `yes`, and `focus right` at the right edge of the laptop panel wraps to that same panel's left
   edge rather than entering the external display. Two displays behave as two islands.
4. **An undocked window never comes home.** `Tree.reconfigure` appends a departing monitor's root
   contents into the primary root and allocates a fresh empty root when the monitor returns, so
   windows pile onto the remaining display and stay there.

**Scope decision (user, 2026-09-24).** Phase 4 builds only what the user's config needs.
`workspace_auto_back_and_forth`, the `back_and_forth` target and `focus_follows_mouse` appear
nowhere in that config and are **dropped from this phase** — see §7. They remain valid i3 and are
still reported as unsupported in the log when encountered.

**Not this phase, and not v1 at all:** marks, scratchpad, `assign`, gaps, `bindcode`,
`bindsym --release`, i3bar `status_command`, top-level `exec`/`exec_always` autostart, layout
persistence across shell restarts.

## 2. `for_window` rules

### 2.1 Every criterion is readable, so none is a silent never-match

`Criteria` (`src/config/model.ts`) already parses `class`, `instance`, `title`, `app_id` and
`window_role` as regexes plus `floating` and `tiling` as booleans. `WindowInfo` carries only `title`
and `wmClass` today, so three of the five could never match and a rule using them would fail
silently. `WindowInfo` therefore gains:

| field | source |
| --- | --- |
| `instance` | `Meta.Window.get_wm_class_instance()` |
| `appId` | `Meta.Window.get_gtk_application_id()` |
| `role` | `Meta.Window.get_role()` |

All three exist in Mutter 18 (verified against `@girs/meta-18`). `floating` and `tiling` are answered
from the existing `WindowInfo.kind`.

Matching is a pure Layer 0 function:

```ts
export function matchesCriteria(criteria: Criteria, info: WindowInfo): boolean;
```

All present criteria must match — i3's semantics. A criterion whose fact is `null` (a window with no
role, say) does not match a regex, including `.*`; absence is not the empty string.

### 2.2 Rules apply before the window is placed

Application point for the **first** pass: at first frame, in the engine, **before** the commit that
places the window. A title-triggered re-evaluation (§2.3) necessarily runs later, after placement,
because the title changed after the window was already on screen; §2.2's "before placement" is a
claim about the first pass only. The
user's rule ends `resize set 720 420, move position center`; applied after placement, the dialog
would visibly tile and then jump. Rules run in config order, and each rule's command string goes
through the existing command path unchanged — `floating enable`, `border`, `resize set` and
`move position center` all already work.

### 2.3 Title is mutable, and this is the rule that depends on it

i3-shell watches no `notify::title` today, so a window that sets its title after mapping — which is
ordinary for a GNOME dialog, and the user's rule matches a title — would never match. The watch is
added, emitting a new `'title'` `WindowEvent`, and rules whose criteria include `title` are
re-evaluated when it changes.

**Each rule fires at most once per window.** A window whose title flaps must not re-run
`resize set 720 420` and fight the user for the rectangle. The engine records which rules have fired
for which window and drops the record when the window closes.

### 2.4 Failure is attributable

A rule whose command is rejected logs at warning level naming the rule's config line. "for_window
did nothing" is otherwise unattributable, and an unattributable failure is one the user cannot
report.

## 3. Urgent state

`Meta.Window` exposes both `urgent` and `demands_attention`, each with a `notify::` signal. A window
may set either, so both are watched and `WindowInfo.urgent` is their disjunction. A new `'urgent'`
`WindowEvent` carries the change.

`PillState` gains `urgent: boolean`. **The urgent pill is styled from `client.urgent`.** i3 takes its
bar colours from `bar { colors { urgent_workspace … } }`, and this project ignores the `bar` block
(main spec §6.3), so `client.urgent` is the only urgent colour the config supplies and the pill
borrows it. That is a deliberate divergence from i3, recorded here so it is not mistaken for an
oversight.

A pill is urgent when **any window on that workspace is urgent
and that workspace is not active** — focusing a workspace clears its urgency, as i3 does. The
focused-window border honours `client.urgent` through the existing `effectiveColors()` path, so the
configured colours stop being dead.

Urgency is derived per commit from the live window set, like `occupied`; it is not separate state to
keep in sync.

## 4. Crossing monitors

### 4.1 Adjacency is geometry

A pure Layer 0 function over the work areas the engine already holds:

```ts
export function neighbourMonitor(
  areas: ReadonlyMap<MonitorId, Rect>,
  from: MonitorId,
  direction: Direction,
): MonitorId | null;
```

The neighbour is the nearest monitor strictly beyond `from`'s edge on the direction's axis **whose
span overlaps `from`'s span on the perpendicular axis**. Overlap is required: two displays diagonal
to one another are not to the right of each other, and guessing produces focus jumps no user can
predict. No overlapping monitor beyond that edge means no neighbour.

### 4.2 Crossing beats wrapping

`focus <direction>`: when `nextFocus` finds nothing inside the current monitor's root *without
wrapping*, the engine looks for a neighbour in that direction and, if there is one, descends into its
root from the **entering** edge — the edge nearest the monitor being left, so moving `right` enters
the neighbour at its left. `descendDirection(root, direction)` already has exactly this behaviour: on
an axis matching the direction it takes `children[0]` for a forward direction, which is the leftmost
or topmost child. Wrapping applies only when there is no neighbour.

This changes observable behaviour with `focus_wrapping: yes`, which is the config's effective
setting: the edge now crosses rather than wrapping. That is i3's behaviour and is the point of the
change.

`move <direction>`: at the edge with a neighbour, the container detaches and inserts into the
neighbour's root at the entering edge rather than wrapping inside its own monitor.

## 5. Coming home after an undock

### 5.1 What is remembered

When `Tree.reconfigure` displaces a window off a departing monitor, the engine records that window's
**origin monitor**. `MonitorIds` (`src/shell/geometryBackend.ts`) already assigns a stable
`MonitorId` keyed on the sorted connector list and remembers it for the session, so a laptop panel
that returns is provably the monitor it was.

Windows still move to the primary root while the display is gone — visible and reachable, which is
what Phase 3B exists to guarantee. The origin is bookkeeping alongside that, not a replacement for
it.

When a monitor with recorded origins reappears, those windows move into its root on their current
workspace.

### 5.2 Three rules, each from a mistake already made

- **The first displacement wins.** A window displaced twice remembers its true home, not the last
  place it was dumped.
- **An explicit move by the user wins permanently.** Any `move`, `move container to workspace`, or a
  drag that changes the window's monitor clears the origin for good. Without this, undocking
  silently undoes a placement the user just chose — the same fight `_manualFloating` precedence was
  written to prevent.
- **Monitor, not workspace.** A window on a different workspace when the display returns lands on
  that display *on its current workspace*. Which workspace a window lives on is the user's decision;
  which monitor it was shoved onto was ours.

### 5.3 Tiled windows only

A floating window carries an absolute position that Mutter relocates itself when an output vanishes.
Putting it back would mean contesting a rectangle the compositor already chose. Floating windows stay
where they land, and this limit is stated in the acceptance document rather than discovered.

## 6. Architecture, errors, testing

### 6.1 Modules

Layer 0, pure, no `gi://`:

- `src/runtime/rules.ts` — `matchesCriteria(criteria, info)`.
- `src/tree/monitors.ts` — `neighbourMonitor(areas, from, direction)`.
- `src/runtime/origins.ts` — the displacement-origin map as pure functions over a readonly map:
  record (first-wins), clear, and the set of windows owed to a returning monitor.

Changed: `src/runtime/model.ts` (`WindowInfo` gains `instance`, `appId`, `role`, `urgent`;
`WindowEvent` gains `'title'` and `'urgent'`; `PillState` gains `urgent`), `src/shell/windows.ts`
(read the facts, watch `notify::title`, `notify::urgent`, `notify::demands-attention`),
`src/engine.ts` (apply rules, cross monitors, hold the origin map, derive urgent pills),
`src/tree/focus.ts` and `src/tree/tree.ts` (crossing entry points), `src/shell/util/pills.ts` and
`stylesheet.css` (urgent pill), `src/shell/decorations.ts` (urgent border).

### 6.2 Errors

- A rejected rule command: warning naming the rule's config line; the remaining rules still run.
- No topology yet: no crossing, fall back to wrapping. Never throw.
- An origin whose window has closed: dropped silently; that is the expected case.
- Every new adapter callback goes through the existing `guard()`, so nothing propagates into a Mutter
  signal handler.

### 6.3 Testing

**Unit.** `matchesCriteria` across all five regex keys, both booleans, combinations, a null fact
against `.*`, and anchoring. `neighbourMonitor` property-tested over generated arrangements: side by
side, stacked, three across, gaps between outputs, and the diagonal case that must yield no
neighbour. The origin rules: first-displacement-wins, explicit-move-clears, close-clears, and the
returning window landing on its current workspace. Rule application order and the once-per-window cap.
Urgent pill derivation, including that the active workspace is never urgent.

**Adapter.** `windows.test.ts` for the five new facts and the three new signals, through the existing
`gi://` mocks — `src/shell/**` is reachable by Node tests through `vi.mock` plus `vi.importActual`,
which eight suites already do.

**Native.** The two-monitor scenario gains: `focus right` crossing from the primary output to the
second and back; `move right` carrying a container across; an output removal followed by
reconnection asserting a displaced window **returns**; and a real `for_window` rule firing on a real
GTK window. Urgency may not be reachable from the harness, since a client must genuinely set the
hint; if it is not, that is recorded as walk-only rather than faked.

## 7. Amendments to the main spec

1. **§17 Phase 4 scope is trimmed.** `workspace_auto_back_and_forth`, `back_and_forth` and
   `focus_follows_mouse` are dropped from this phase by the user's scoping decision of 2026-09-24,
   on the grounds that none appears in the config this project treats as its source of truth. They
   remain valid i3 and are still logged as unsupported when encountered.
2. **§17's monitor arrangements are GNOME's job, not i3-shell's.** The paragraph describing output
   enable/disable, lid policy, the idle policy and the suspend timer — behaviour the user's
   `~/Dev/i3-display-manager` implemented with `xrandr` on X11 — is superseded on Wayland: Mutter
   owns output configuration and lid handling. i3-shell decides only where *windows* go when the set
   of monitors changes.
3. **§7.10 gains the origin precedence rule** of §5.2: an explicit user move clears a window's
   displacement origin permanently. This is the same shape as the `_manualFloating` precedence rule
   that Phase 3B deferred, and it is settled here for monitor displacement only; `tiled ⇄ floating`
   reclassification remains deferred.

## 8. Acceptance criteria

- **A38.** The `for_window` rule in the real config fires: opening GNOME Settings' Audio output
  dialog makes it floating, 720×420, centred, with a 2px border.
- **A39.** That rule fires even when the dialog sets its title after mapping.
- **A40.** The rule does not re-fire and re-resize when the window's title changes again.
- **A41.** A window that sets an urgency hint on an inactive workspace turns that workspace's pill
  urgent, styled from `client.urgent` (§3 records why that key and not a `bar` block colour).
- **A42.** Focusing that workspace clears the urgency.
- **A43.** `focus right` at the right edge of the laptop panel moves focus to the external display
  rather than wrapping.
- **A44.** `focus left` at the external display's left edge returns to the laptop panel.
- **A45.** `move right` at the edge carries the focused container to the external display.
- **A46.** With the lid closed and the laptop panel off, its windows are reachable on the external
  display.
- **A47.** On undock, those windows return to the laptop panel.
- **A48.** A window the user deliberately moved while undocked stays where they put it.
- **A49.** Nothing in A38–A48 requires a hand-edited GSetting or a script outside i3-shell.
