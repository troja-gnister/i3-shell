# Phase 5 — Per-output workspaces design

**Status:** approved design, not yet planned.
**Main spec:** `docs/superpowers/specs/2026-09-20-i3-shell-design.md`. §9 amends it substantially; see §9 of this document.
**Supersedes:** Phase 4 Tasks 6–7 (`docs/superpowers/plans/2026-09-24-phase-4-fidelity.md`). Task 5's `neighbourMonitor` is absorbed here unchanged. Tasks 1–4 stand and are a prerequisite.

---

## 1. Brief

i3-shell hands workspace identity to GNOME. Mutter has exactly one global active workspace index, so
a workspace here spans every output: `Tree.workspaces` maps an index to a `WorkspaceCon` holding
`monitors: Map<MonitorId, SplitCon>`, and ten workspaces own twenty live roots that all switch at
once. i3 and sway invert this — each output owns an ordered set of workspaces and exactly one is
visible per output — and the difference is not cosmetic. It is the reason for two defects observed on
real hardware on 2026-09-26.

The session ran two outputs: `HDMI-1` (Samsung Odyssey G93SC, 3840×1080 at x=0, primary) and `DP-1`
(a television, 1920×1080 at x=3840). `eDP-1`, the laptop panel, was not driven.

- **Steam was unreachable.** Its window was tiled as node 37 on `DP-1` — the television — while the
  user worked on the Samsung. Nothing had failed: the process was running and the window was mapped
  and tiled. But `grep -rn "output" src/commands/ src/config/ src/tree/` matches nothing, and
  `src/tree/focus.ts` and `src/tree/operations.ts` never mention monitors, so **no command in the
  program could move it.** A window on the wrong output is permanently stranded there.
- **`$mod+d` opened on the wrong output.** `_launcherArea()` (`engine.ts:921`) resolves the monitor
  from the tree's selection, deliberately refusing `Main.layoutManager.currentMonitor` because that
  is the pointer's monitor (`engine.ts:74-78`, `launcher.ts:35-38`). That was right for the defect it
  was written for and leaves two holes. `focus_follows_mouse` is unimplemented — it sits in
  `parser.ts:30`'s `UNSUPPORTED` set — and i3's default is `yes`, so moving to the television focuses
  nothing there and the launcher faithfully opens where focus still is. And an output whose visible
  workspace is empty has **no selection to read at all**, so `_launcherArea()` falls through to
  `topology.primary`: on the unoccupied workspaces the launcher could not open anywhere else.

Both reduce to one absence. **i3-shell has no concept of the focused output.** It infers an output
from the focused *window*, so when there is no window — or when attention moved without a click — the
inference has nothing to work from. That concept is also the keystone of per-output workspaces: in
i3 the focused output is what `workspace N` acts on, what a new window attaches to, and what a
launcher opens on. Building it fixes both defects as by-products.

**Goal.** Each output owns its workspaces; exactly one is visible per output; switching a workspace
affects only the focused output. One global set of workspaces, as in i3, so `$mod+3` means "show
workspace III" and not "show this output's third workspace".

---

## 2. The workspace model

### 2.1 Structure

Layer 0, in `src/tree/tree.ts`:

```ts
// A workspace lives on exactly one output and owns exactly one root.
Tree.workspaces:     Map<number, {output: MonitorId; root: SplitCon; floating: WindowId[]}>
// Each output shows exactly one of its own workspaces.
Tree.visible:        Map<MonitorId, number>
// First-class state; the absence of this is the whole of §1.
Tree.focusedOutput:  MonitorId
```

`activeWorkspace` survives as a **derived getter**, `visible.get(focusedOutput)`. It keeps meaning
"the workspace the user is on", which is what its nineteen call sites already assume, so most of them
neither change nor need to.

`MonitorCon` ceases to be a per-workspace child. A workspace's single root *is* what `MonitorCon`
was; which output it belongs to is the workspace's `output` field. `root.root === true` still marks
it, so §7.2's invariants and every `parent.root` test in the main spec are unaffected.

### 2.2 Invariants

Pinned by `normalize()` and by property tests:

1. Every workspace has exactly one output, and that output is live.
2. Every output shows exactly one workspace, and that workspace's `output` is that output.
3. `focusedOutput` always names a live output.
4. A window **in a workspace's tree** (tiled or floating) is on GNOME's *live* workspace if and only
   if that workspace is visible; otherwise it is on the *attic* (§5). Windows `excludedFromTree`
   rejects — minimised, sticky, `skipTaskbar` — belong to no tree and are never parked; a sticky
   window showing on every output is GNOME's own behaviour and is left alone.

### 2.3 Birth assignment and `workspace N output`

At startup workspace *N* is assigned to output *N* for as many outputs as exist — i3's own rule, and
the one a user describes as "primary is workspace one, external is workspace two". Outputs are ordered **primary
first**, then the remainder by ascending Mutter monitor index. The primary must come first because
"primary is workspace one" is the behaviour being asked for; `geometryTopology.ts:55` sorts monitors by
index and tracks the primary separately, so the primary is not index 0 in general and sorting by index
alone would hand workspace I to whichever output Mutter happened to enumerate first. Workspaces beyond the output count are unassigned until
first shown (§2.4).

`workspace <number|name> output <name…>` graduates from `UNSUPPORTED` to implemented. It accepts
i3's list form, first live output wins, with `primary` valid as a name. A configured assignment
overrides the default and is authoritative at birth; it does not pin the workspace forever, because
`move workspace to output` must still work (§4.3).

An output name that matches no connector is a warning on the directive's line, and the workspace
falls back to the default rule. This is the ordinary case of a config written for a machine with
different displays and must not reject the config.

### 2.4 What `workspace N` does

- If **N is visible** on some output: move `focusedOutput` to that output. Nothing is parked or
  un-parked; the screen does not change. This is i3's "go to where that workspace is".
- Otherwise: assign N to the focused output, show it there, park whatever that output was showing.

This is i3's behaviour exactly. In i3 workspaces 3–10 do not exist until visited, and a visited
workspace is created on the focused output; here "does not exist yet" is replaced by "has not been
placed yet", which is the same thing observed from the keyboard.

`workspace next|prev` keeps the main spec's global numeric order, unwrapped. Per-output cycling
(`next_on_output`) is not in scope: no known config binds it.

### 2.5 A fixed set of workspaces — a divergence, stated

i3 creates a workspace on first visit and destroys it when it empties and stops being visible. This
design keeps the main spec's fixed set of *N* workspaces (§9: N = 10 for the reference config), each
named and bound. For a config that names and binds every workspace the observable behaviour is
identical, and a fixed set is simpler to model and to test. The divergence is recorded rather than
hidden: a config relying on i3's dynamic workspace lifecycle is out of scope for v1.

---

## 3. The focused output

### 3.1 Four sources, one variable

`focusedOutput` is stored state, changed from exactly four places:

1. **A window gains focus** → its output. One rule covering sloppy focus, clicks, alt-tab and
   `_activateSelection`.
2. **`focus output <arg>`**, and a directional `focus` that walks off the edge of the visible
   workspace's root (§4.4).
3. **`workspace N` landing on another output** (§2.4).
4. **The pointer crossing onto an output whose visible workspace is empty.** The one case rule 1
   cannot cover, structurally: there is no window there to take focus. This is the defect on the
   unoccupied workspaces in §1.

Rule 4 is the only one needing a new subscription. It hangs on Mutter's cursor tracker and early-outs
on an integer comparison unless the pointer's monitor actually changed, so the per-motion cost is a
compare and emptiness is consulted only on a real crossing.

### 3.2 `focus_follows_mouse` is one GSettings override

`org.gnome.desktop.wm.preferences focus-mode` accepts `click | sloppy | mouse`. `sloppy` is Mutter's
own focus-follows-mouse and its semantics match i3's: the window under the pointer takes focus, but
crossing empty desktop leaves focus where it was. It joins the apply/restore pair in
`settings.ts:88-106`, and the existing chain then does all the work — `windows.ts:192` already watches
`notify::focus-window` and `_acceptFocus` (`engine.ts:249`) already calls `_selectWindow`. No new
pointer plumbing for the common case, which is why rule 1 above covers so much.

`focus_follows_mouse` leaves `UNSUPPORTED`. `yes` (i3's default, and the effective setting for a
config that omits it) maps to `sloppy`; `no` maps to `click`.

### 3.3 `mouse_warping` is load-bearing, not cosmetic

`mouse_warping` also leaves `UNSUPPORTED`. i3's default is `output`: when focus moves to a different
output, the pointer warps to the newly focused window's centre — or the output's work-area centre
when the workspace is empty.

This is required, not a nicety. Without it, sloppy focus would immediately pull focus back to
whatever lies under the stationary pointer, and every keyboard output command in §4 would fight the
mouse. The two features only work as a pair; implementing `focus-mode = sloppy` without warping would
be a regression. `mouse_warping none` disables the warp and is honoured.

Warping is suppressed while the launcher holds its modal grab, and when the change of focused output
was itself caused by rule 4 (the pointer is already there).

### 3.4 What this fixes

- `_launcherArea()` stops inferring an output from the selection and reads `focusedOutput`. Both
  halves of the `$mod+d` defect go, including the empty-workspace case, and the two fallback warnings
  it logs become unreachable for that reason.
- New windows attach to the focused output's visible workspace instead of wherever Mutter placed
  them, which is how Steam reached the television.

---

## 4. Commands

All three take i3's argument form: `left | right | up | down | primary | <output name>`.

### 4.1 `focus output <arg>`

Moves `focusedOutput`, then focuses that output's visible workspace's selection, or the output
itself when that workspace is empty — focus being output-level is what makes an empty output
reachable at all. Warps the pointer per §3.3. A direction with no neighbour is a no-op, not a wrap:
outputs are physical and wrapping between them is never what a user means.

### 4.2 `move container to output <arg>`

Detaches the selected con from its root and inserts it into the target output's **visible**
workspace's root at the entering edge (§4.4), structure intact, exactly as the main spec's
`move container to workspace number` preserves a moved subtree. Focus does not follow, matching i3
and matching `move container to workspace`. If the selected con is a root, its contents move in an
equivalent non-root split, per §9 of the main spec.

This is the command that rescues a stranded window, and the direct answer to §1's first defect.

### 4.3 `move workspace to output <arg>`

Reassigns the focused workspace's `output` to the target and makes it visible there, parking whatever
the target was showing. The vacated output falls back to showing its lowest-numbered assigned
workspace, or — if it has none left — the lowest-numbered unassigned workspace, which is then
assigned to it. Invariant 2 forbids an output showing nothing.

### 4.4 Adjacency

Unchanged from the Phase 4 design, §4.1–4.2, which this document adopts verbatim:

```ts
export function neighbourMonitor(
  areas: ReadonlyMap<MonitorId, Rect>,
  from: MonitorId,
  direction: Direction,
): MonitorId | null;
```

The neighbour is the nearest output strictly beyond `from`'s edge on the direction's axis whose span
overlaps `from`'s span on the perpendicular axis. Overlap is required: two displays diagonal to one
another are not to the right of each other. No overlapping output beyond that edge means no
neighbour.

Crossing beats wrapping. When `focus <direction>` finds nothing inside the visible workspace's root
without wrapping, the engine looks for a neighbour and descends into that output's visible
workspace's root from the **entering** edge — moving `right` enters at the left — via
`descendDirection`. Wrapping applies only when there is no neighbour, which changes observable
behaviour under the config's effective `focus_wrapping: yes` and is the point. `move <direction>` at
such an edge inserts into the neighbour's root at the entering edge instead of wrapping.

---

## 5. The attic

### 5.1 Two GNOME workspaces

GNOME drops to two. Index 0 is **live** and is the active workspace for the extension's whole
lifetime. Index 1 is the **attic**. Mutter already declines to render a non-active workspace, so
hiding is native: parked windows are genuinely unmapped, take no keyboard input and leak into no
window list. No actor is hidden and nothing is minimised.

Minimising was considered and rejected outright: Phase 3B made `minimized` mean "not in the tree"
(`excludedFromTree`), so using it to hide a parked window would make the tree consume its own
contents. `actor.hide()` was rejected too — the window stays mapped and focusable, still takes
keyboard input, still appears in alt-tab, and Mutter still considers it for focus.

`settings.ts:91` applies `num-workspaces = plan.workspaceCount`; it becomes the constant 2. The
config's *N* workspaces become purely i3-shell's own notion, which is the separation this phase is
for: GNOME stops knowing what a workspace means.

`workspaces-only-on-primary = false` is a prerequisite, already delivered by Phase 3B. While it is
true Mutter marks every window on a secondary output `on_all_workspaces`, and a sticky window cannot
be parked — it would remain visible on the attic. The attic model is only sound because that setting
is already owned.

### 5.2 The swap

Showing workspace *W* on output *M*:

1. Un-park: every window on *W* → `moveToWorkspace(id, LIVE)`.
2. Park: every window on *M*'s outgoing visible workspace → `moveToWorkspace(id, ATTIC)`.
3. Set `visible[M] = W` and `W.output = M`.
4. Relayout (§5.4).
5. Drive focus explicitly to *W*'s selection, or to the output when *W* is empty.

Step 5 is the subtlest thing in this phase and the one most likely to pass a test while being wrong.
Parking the focused window makes **Mutter choose a replacement on its own**, which fires
`notify::focus-window`, reaches `_acceptFocus`, and calls `_selectWindow` on an arbitrary window —
silently corrupting the selection mid-swap. The engine already owns the instrument for this:
`_expectedFocus`, which `_acceptFocus` consults to tell a focus change it asked for from one it must
react to. The swap brackets its parking with those expectations. A test whose window fake confirms
focus synchronously cannot observe this failure, so §8.4 requires a native scenario for it.

The whole swap is one `Engine.commit()`, so Mutter paints once, at the end.

### 5.3 Keeping the active workspace on live

If GNOME's active workspace ever became the attic, every parked window would appear at once and every
visible one would vanish. Two defences:

- GNOME's `switch-to-workspace-*` bindings are cleared through the conflict machinery that
  `settings.ts:7` already applies to `org.gnome.desktop.wm.keybindings`.
- A `workspace-switched` guard forces the active workspace back to live and logs a warning. Touchpad
  workspace gestures have no GSetting, so the guard is the only cover for them and is not optional.

### 5.4 Layout only for visible workspaces

`engine.ts:423-426` lays out every workspace × monitor pair — twenty roots for a ten-workspace,
two-output session. Only **visible** workspaces are laid out now: a parked workspace's windows are
not on screen and its geometry is unobservable until it is shown, at which point step 4 of the swap
computes it. Two roots instead of twenty, and a simpler rule.

### 5.5 `Topology.workAreas` collapses to one map

`Topology.workAreas` is today `ReadonlyMap<number, ReadonlyMap<MonitorId, Rect>>`, keyed first by
workspace index, and `geometryTopology.ts:41` builds it by looping to the **GNOME** workspace
manager's count. Once GNOME holds two workspaces that loop produces entries for 0 and 1 only, so any
lookup by an i3 workspace index of 2 or above returns `undefined` — `_launcherArea()`'s
`workAreas.get(workspace)` would fail on seven of ten workspaces.

It therefore becomes a single map keyed by output:

```ts
Topology.workAreas: ReadonlyMap<MonitorId, Rect>
```

read from the *live* workspace, which is the only one any visible window occupies. A workspace's rect
is `topology.workAreas.get(ws.output)!`. This is also the honest shape: a work area is a property of
an output, and the per-workspace keying only ever existed because GNOME owned workspaces.

---

## 6. Bars and pills

Each output's bar shows only the workspaces assigned to it, with its visible one marked. `bars.ts`
draws a bar on every monitor **except** the primary, which uses the GNOME panel indicator instead
(`bars.ts:44-45`); the indicator shows the primary's workspaces, keeping that split intact.

`PillState` gains i3bar's missing distinction. i3 separates a workspace that is **focused** from one
merely **visible** on another output; today `active` collapses both:

```ts
interface PillState { name: string; focused: boolean; visible: boolean; occupied: boolean; urgent: boolean }
```

`stylePill` keeps the branch shape Phase 4 Task 4 established, with precedence
**focused → urgent → visible → occupied**. `samePills` compares all five fields — Phase 4 Task 4
shipped a version that omitted `urgent` and left the feature dead at runtime, so the diff is part of
the contract, not an optimisation. `urgent`'s doc comment changes from "not active" to "not focused".

`snapshot.ts` produces pills per output rather than one global list.

---

## 7. Monitor hotplug

Today `Tree.reconfigure()` handles a lost output by calling `appendRootContents` (`tree.ts:245`) to
flatten its roots into the primary's tree. **The layout is destroyed and cannot be recovered** — the
common case being a closed lid or a sleeping television.

Under per-output workspaces a lost output's workspaces are **reassigned**, roots untouched:

- Each workspace on the lost output is reassigned to the **primary** — deterministic, and simpler to
  test than nearest-by-position.
- Its layout survives intact. Only visibility changes: the lost output's visible workspace becomes
  parked, since the primary already shows one of its own.
- The pre-loss assignment is remembered so a replug restores it. This is meaningful precisely because
  `MonitorIds` already derives a stable `MonitorId` from the sorted connector list, so an output that
  comes back is recognised as the same one.
- A gained output takes, in order: the lowest-numbered workspace whose remembered assignment names
  it; else the lowest-numbered unassigned workspace; else the **highest**-numbered workspace of
  whichever output currently holds the most, ties broken by lowest `MonitorId`. Taking the highest
  leaves that output's lowest-numbered — usually its visible one — undisturbed. Invariant 2 forbids
  an output showing nothing, so this chain always terminates.
- `focusedOutput` moves to the primary if the output it named is gone.

Mutter always reports at least one output, so "no outputs" is an assertion, not a branch.

---

## 8. Architecture, errors, testing

### 8.1 Modules

- `src/tree/tree.ts` — a genuine rewrite of workspace structure, not an extension: `workspaces`,
  `visible`, `focusedOutput`, `root(workspace)`, `location()`, `insert()`, `moveToWorkspace()`,
  `reconfigure()`.
- `src/tree/monitors.ts` — **new**, pure: `neighbourMonitor` (§4.4).
- `src/tree/outputs.ts` — **new**, pure: birth assignment, `workspace N` resolution, the three
  output commands' target resolution, hotplug reassignment and remembering.
- `src/commands/` — three new `Command` members and their parsing. `_runOne`'s switch has no
  `default:`, so adding a member is a compile error until every site handles it; this is relied upon.
- `src/config/parser.ts` — `workspace`, `focus_follows_mouse` and `mouse_warping` leave `UNSUPPORTED`.
- `src/runtime/snapshot.ts`, `src/runtime/model.ts` — per-output pills, `PillState`,
  `Topology.workAreas` (§5.5), and `TreeSnapshot` **version 2**: a workspace carries `output` and one
  `root` instead of a `monitors` array. The version bump is required because `GetTree` is a public
  D-Bus surface and `test/integration/phase2-checks.py` parses it.
- `src/shell/geometryTopology.ts` — builds the collapsed `workAreas` (§5.5) from the live workspace
  only, so its workspace loop disappears.
- `src/shell/settings.ts` — the overrides in §8.2.
- `src/shell/workspaces.ts` — the attic swap, `moveToWorkspace` bracketing, the `workspace-switched`
  guard.
- `src/shell/pointer.ts` — **new**: the cursor-tracker subscription for rule 4, and the warp for §3.3.
- `src/shell/bars.ts` — per-output pill lists.
- Layer 0 (`src/config`, `src/commands`, `src/tree`, `src/runtime`, `src/launcher`) must never import
  `gi://`, `resource://` or `src/shell/`. `scripts/check-layer0.mjs` enforces it; `src/tree/outputs.ts`
  and `src/tree/monitors.ts` are covered by the existing `src/tree` root.

### 8.2 GNOME settings overrides

All through the existing snapshot/apply/restore machinery (main spec §13):

| Key | Value | Status |
|---|---|---|
| `org.gnome.desktop.wm.preferences num-workspaces` | `2` | changed from *N* |
| `org.gnome.desktop.wm.preferences focus-mode` | `sloppy` / `click` per `focus_follows_mouse` | new |
| `org.gnome.shell.app-switcher current-workspace-only` | `true` | new — alt-tab must not list parked windows |
| `org.gnome.mutter dynamic-workspaces` | `false` | unchanged |
| `org.gnome.mutter workspaces-only-on-primary` | `false` | unchanged (Phase 3B prerequisite, §5.1) |
| `org.gnome.desktop.wm.preferences workspace-names` | no longer applied | GNOME's two workspaces correspond to nothing the user sees; the saved original is still restored on disable |
| `org.gnome.desktop.wm.keybindings switch-to-workspace-*` | cleared | §5.3 |

### 8.3 Errors

- An `output` name matching no connector: warning on that line, default assignment used (§2.3).
- `focus output <direction>` with no neighbour: no-op, no warning — an ordinary edge.
- `moveToWorkspace` failing for a window during a swap: warn once naming the window, leave it where
  it is, and continue. A half-swapped output is recoverable by switching again; an exception thrown
  mid-swap is not.
- The `workspace-switched` guard firing: warning, since it means something outside i3-shell moved the
  active workspace and the user may see a flash.

### 8.4 Testing

Most of this is Layer 0 and pure: the model and its four invariants, birth assignment, `workspace N`
resolution, `neighbourMonitor`, the three commands' target resolution, hotplug reassignment and
remembering, and pill derivation.

`src/shell/**` additions are unit-tested against `test/unit/shell/fakes/` — the attic swap and its
`_expectedFocus` bracketing, the settings overrides, the cursor tracker, the `workspace-switched`
guard, per-output bars. (`tsconfig.test.json` excludes `src/shell/**` from the *typecheck* program
only; it does not put the code beyond the suite's reach.)

Native scenarios in the nested harness, for the claims a fake cannot support:

1. A parked window is not rendered and does not take focus.
2. Switching one output's workspace leaves the other output's windows and geometry untouched.
3. After a swap, focus is on the incoming workspace's selection — not on whatever Mutter picked when
   the focused window was parked (§5.2, step 5).
4. Unplugging an output preserves its workspaces' layout; replugging restores the assignment.
5. `focus-mode`, `num-workspaces` and `current-workspace-only` are restored on `disable()`.
6. `focus_follows_mouse` moves the focused output, and a keyboard `focus output` warps the pointer.

The critical-log gate in `test/integration/inside.sh` is not weakened. The swap moves many windows in
one commit, which is the shape of change that produced 34 St-CRITICALs in Phase 3B.

**Migration cost, measured:** 15 of 71 test files assert per-monitor workspace structure
(`test/unit/tree/{tree,membership,normalize,properties,topology}.test.ts`,
`test/unit/engine{,/commands,/lifecycle}.test.ts`, `test/unit/runtime/snapshot.test.ts`,
`test/unit/shell/{bars,pills,controlObject}.test.ts`, `test/unit/shell/fakes/actors.ts`,
`test/integration/phase1-checks.sh`, `test/integration/phase2-checks.py`).

---

## 9. Amendments to the main spec

1. **§7.1, level order.** "GNOME workspaces span monitors, so here it is workspace → monitor" is
   reversed: the order is **output → workspace**, as in i3. A `WorkspaceCon` holds one root and an
   `output`; `MonitorCon` is no longer a per-workspace child. `root.root === true` still marks a
   root, so every `parent.root` test in §7 stands.
2. **§9, count and settings.** `num-workspaces = N` becomes `num-workspaces = 2` (live + attic).
   `workspace-names` is no longer applied. The paragraph beginning "**Consequence, to state
   plainly:** while the extension is enabled GNOME treats a workspace as spanning every output" is
   replaced by the attic model (§5): GNOME holds two workspaces and no longer represents i3
   workspaces at all. *N* remains i3-shell's own workspace count, derived from the config as before.
3. **§9, `workspace number N`.** No longer "activate GNOME workspace N−1". It resolves per §2.4 and
   the GNOME active workspace never changes.
4. **§9, `move container to workspace number N`.** The detach/attach semantics stand. The target of
   `change_workspace_by_index` is live or attic depending on whether N is visible, not N−1. "No-op if
   N is the current workspace" now means N is visible on the focused output.
5. **§9, `workspace next|prev`.** Global numeric order retained; explicitly not per-output.
6. **§6.3, directive tiers.** `workspace`, `focus_follows_mouse` and `mouse_warping` move from tier 2
   (unsupported, warning) to implemented.
7. **§6.7, command language.** Adds `focus output`, `move container to output`,
   `move workspace to output`.
8. **§13, overrides.** Adds `focus-mode` and `app-switcher current-workspace-only`; removes the
   `workspace-names` apply; adds the `switch-to-workspace-*` clears.
9. **Roadmap line (§17, "Phases and deliverables").** Phase 4's "multi-monitor (per-monitor focus / move across MonitorCons)"
   and "`focus_follows_mouse` ↔ `focus-mode`" move to Phase 5, which replaces `MonitorCon` entirely.
10. **§8.2 / §7.10.** Unchanged, and noted as such: a window is excluded from the tree by
    `excludedFromTree` exactly as Phase 3B defined. Parking is not exclusion — a parked window stays
    in its workspace's tree — and nothing about `minimized`, `sticky` or `skipTaskbar` changes.

---

## 10. Acceptance criteria

- **A50** With two outputs, workspace I is visible on the **primary** and workspace II on the other at
  startup, whatever order Mutter enumerates them in; each bar shows only its own output's workspaces.
- **A51** `workspace III output <name>` in the config places III on that output at birth; an unknown
  output name warns on that line and III falls back to the default assignment.
- **A52** `$mod+3` with III unplaced shows III on the focused output and parks what was there; the
  other output does not change.
- **A53** `$mod+2` with II visible on another output moves focus to that output and changes no
  window's workspace.
- **A54** A window on a parked workspace is not rendered, takes no keyboard input, and does not
  appear in alt-tab.
- **A55** After a workspace swap, focus is on the incoming workspace's selection; parking the
  previously focused window does not leave focus on a window Mutter chose.
- **A56** `move container to output right` moves the selected window to the neighbouring output's
  visible workspace, preserving a moved subtree's structure, layout, percentages and focused child;
  focus does not follow.
- **A57** `focus output <direction>` with no overlapping output beyond that edge is a no-op; it never
  wraps.
- **A58** `focus <direction>` at the edge of a visible workspace's root crosses into the neighbouring
  output's visible workspace at the entering edge rather than wrapping.
- **A59** Moving the pointer onto an output whose visible workspace is **empty** makes it the focused
  output, and `$mod+d` then opens the launcher on that output.
- **A60** With `focus-mode = sloppy` applied, moving the pointer onto a window on another output makes
  that output focused; a keyboard `focus output` warps the pointer to the newly focused window.
- **A61** `mouse_warping none` suppresses the warp; the launcher's modal grab suppresses it too.
- **A62** Unplugging an output reassigns its workspaces to the primary with layout intact; replugging
  restores the original assignment.
- **A63** GNOME's active workspace is `live` at all times; a forced switch to the attic is reverted
  and logged.
- **A64** `focus-mode`, `num-workspaces`, `current-workspace-only`, `workspace-names` and the cleared
  `switch-to-workspace-*` bindings are all restored on `disable()`.
- **A65** A pill is styled focused, urgent, visible, occupied in that precedence; `samePills` compares
  all five fields.
- **A66** No new `(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL` in the nested harness,
  including during a swap that moves several windows at once.
