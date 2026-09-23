# Phase 3A — decorations design

**Status:** design approved in conversation 2026-09-23; this document is the binding authority for
Phase 3A. It extends, and does not replace, `2026-09-20-i3-shell-design.md` (referred to below as
"the main spec"). Where the two disagree, this one wins for Phase 3A subject matter.

**Baseline:** `main` at `51dcc3d`. 414 unit tests in 41 files, 204 integration assertions.

## 1. Brief

**What the user asked for.** An i3 experience in GNOME. Phase 3 is the visible gap: tiles have no
borders, a focused parent container is invisible, and tabbed and stacked containers are unlabelled —
you cannot see what is in a stack. The user also asked for a workspace bar on additional monitors,
which nothing in the main spec covers.

**What the user decided, in their words or by explicit choice:**

- Phase 3 splits: **3A decorations first, 3B window-facts after.** The two are different subsystems
  and get separate specs.
- The bar on a secondary output **mirrors the same pills**. Per-output workspaces stay a Phase 4
  decision.
- **All tiled windows get a border**, i3-style — focused in the accent, unfocused in grey — not
  focused-only.
- The engine computes a decoration plan and the shell only draws it (approach A), accepting that
  title-row height therefore belongs in the layout computation rather than in the renderer.

**Assumptions, not statements from the user.** That mirrored pills are useful enough to justify the
work; that reserving strut space on a secondary output is preferable to an overlay bar. Both follow
from consistency with the primary monitor, where GNOME's own panel already reserves 32px.

**Constraint the user should not be surprised by.** i3-shell **cannot remove window title bars**.
GTK applications on Wayland draw decorations client-side and Mutter cannot strip them; "stripping
title bars" is already a v1 non-goal in the main spec §17. i3 borders therefore sit outside whatever
the application draws for itself, and a tabbed container shows both i3's title row and each window's
own title bar. This is a platform limit, not a defect to file.

## 2. Scope

In scope: per-leaf borders; the focused-container frame; tab and stack title rows; a workspace bar
on every non-primary monitor; the shutdown-`commit()` fix.

Out of scope, with reasons:

| Deferred | To | Why |
|---|---|---|
| Floating-window borders | Phase 4 | A floating window's rect comes from Mutter and changes while dragging, so its border needs a per-window geometry subscription. That breaks the "actors change only from `commit()`" invariant this design rests on. `default_floating_border` stays parsed and unapplied. |
| `urgent` border state | Phase 4 | Needs `window-demands-attention`, which is Phase 4. The state exists in the plan type and the renderer handles it, so Phase 4 is a one-line change rather than a re-plumb. |
| Per-output workspace sets | Phase 4 | A tree-model change. See §4.3. |
| `sticky` / `skipTaskbar` re-reading, `tiled ⇄ floating` | Phase 3B | Separate spec; see the carry-forward. |

## 3. Layer 0

### 3.1 `layoutWithRects` reserves the title row

`src/tree/layout.ts` currently hands tabbed and stacked children the container rect untouched
(`visit(child, {...currentRect})`). It must instead subtract the title area:

- **tabbed** — a single row of tabs across the top: reserve `rowHeight` **once**.
- **stacked** — i3 shows one title row **per child**, all visible simultaneously: reserve
  `rowHeight × children.length`.

That difference is i3 behaviour and it changes the arithmetic, so it lives in the pure layout
function where tests pin exact rectangles.

`rowHeight` is an **input** to `layoutWithRects`, never a constant. The shell measures one themed
title actor and supplies the value (§4.2); Layer 0 stays deterministic.

A container whose reserved height meets or exceeds its own height yields zero-height children rather
than negative rectangles. Existing `assertValidRect` behaviour is preserved: no rectangle may have a
negative dimension.

### 3.2 `decorationPlan()`

A new pure module, `src/runtime/decoration.ts`:

```ts
export type BorderState = 'focused' | 'focused_inactive' | 'unfocused' | 'urgent';

export interface DecorationPlan {
  borders: Array<{window: WindowId; rect: Rect; state: BorderState; width: number}>;
  frames: Array<{nodeId: NodeId; rect: Rect}>;
  titleRows: Array<{
    nodeId: NodeId;
    rect: Rect;
    rowHeight: number;
    layout: 'tabbed' | 'stacked';
    tabs: Array<{window: WindowId; title: string; selected: boolean}>;
  }>;
}
```

State assignment, matching i3:

- `focused` — the focused leaf on the active workspace.
- `focused_inactive` — the other leaves of the focused container, and the focused leaf of an
  inactive workspace.
- `unfocused` — everything else.
- `urgent` — never produced in 3A.

`frames` contains at most one entry: the rect of the focused container when the selection is a
`SplitCon` rather than a leaf. This is what makes `$mod+a` visible.

**A monitor root holding a fullscreen leaf anywhere beneath it contributes no decorations at all**
— no borders, no frame, no title rows, including for containers nowhere near the fullscreen window.
The main spec §19 leaves a fullscreen window's geometry to Mutter, and chrome drawn over it would
contradict that; a fullscreen window owns the whole monitor, so the rule is per root and not per
container.

Per container is not enough, and the difference is visible: every decoration is raised explicitly,
on every apply — a border immediately above its own window actor, and a frame or title row above
every window actor in `global.window_group` (§4.1) — so all of them sit above a fullscreen window
too. Suppressing only the row of the container that holds the fullscreen leaf would leave a
*sibling* container's tab bar, and the focused-container frame, painted straight across the
fullscreen client.

**Amended after the whole-branch review.** This paragraph previously justified the rule by frames
and rows having *no* stacking control, and read "should frames and rows ever get explicit stacking,
this rule is worth revisiting". They now have it: unmanaged stacking was never a guarantee, because
Mutter restacks `window_group` on every stacking change and requires a plugin to maintain its own
foreign actors' order itself, so chrome could have landed above one window and below the next. The
rule is unchanged, and its reasoning is now stronger rather than weaker: chrome sits over a
fullscreen client *deterministically*, so suppressing it per root is required rather than merely
prudent.

### 3.3 Where the plan is produced

`commit()` computes the plan alongside the rectangles it already computes and pushes it through a
new `EnginePorts` member:

```ts
decorations: {apply(plan: DecorationPlan): void};
```

`rowHeight` travels the other way and is **not** a port method: the shell measures it (§4.2) and
calls `Engine.setRowHeight(height)` directly, as it already calls `onMonitorsChanged()`. A port
method the shell would invoke on itself is a port in name only.

Nothing outside `commit()` may produce or mutate a plan. `apply` is called on every commit, including
the commit that empties it, so the renderer never has to infer teardown.

## 4. Shell

### 4.1 `src/shell/decorations.ts`

A renderer with no decisions in it. On each plan:

- Diff against existing actors by **stable key**: `window` for borders, `nodeId` for frames and
  title rows. Keying on a rectangle would be wrong -- every resize would destroy and rebuild actors
  that only moved -- and `nodeId` already survives a `tree_flatten` that preserves the container.
  Reuse on match, restyle and re-geometry on change, destroy what the plan no longer contains.
- Border actors are `St.Widget` in `global.window_group`, kept immediately **above** their window
  actor so raising a window raises its border with it. Above, not below: a border is given the
  leaf's rect, which is the very rect the window is moved to, so an actor below an opaque window
  paints nothing anyone can see. The actor is a ring -- an outline with a transparent centre, which
  `stylesheet.css` guarantees by keeping `.i3-shell-border` backgroundless -- and it is
  `reactive: false`, without which an actor covering the client would swallow the input it covers.

  **The trade-off, taken deliberately.** The ring overlaps the client's outermost `width` pixels.
  i3 does not: it shrinks the client instead. Insetting the client here means subtracting the
  border width inside `layoutWithRects`, which is Layer 0 arithmetic and rewrites every rectangle
  assertion in both suites, so it is a **Phase 4 option** and not a Phase 3A one. Until then a
  border is drawn over the edge of its window rather than beside it.
- Colours come from `effectiveColors()` (main spec §16.1), so borders follow the GNOME accent when
  the config leaves `client.focused` unset, and a config that sets it still wins.
- Width comes from the plan, never from the renderer's own reading of config. The engine resolves it
  from `default_border pixel N` and per-window overrides set by the `border` command, which the
  engine must now store; `normal` is treated as `pixel N`, since there are no title bars to draw.
  `border none` yields `width: 0` and still produces a plan entry, so the actor persists and its
  state colour continues to track focus.
- A title row is an `St.BoxLayout` of `St.Button` tabs. Clicking a tab focuses that window by
  issuing a command through the same path a keybinding uses — the renderer never mutates the tree.

### 4.2 Measuring `rowHeight`

The shell constructs one themed title actor at startup and takes its preferred height. The value is
passed to the engine and re-measured when `St.Settings` reports a font or theme change, which
triggers a relayout by the same route a monitor change does. A failure to measure falls back to **24 logical pixels** rather
than zero, so a theme problem degrades to slightly wrong spacing instead of windows overlapping
their own title rows. Zero is never accepted as a measurement.

### 4.3 `src/shell/bars.ts`

One bar per **non-primary** monitor. The primary keeps the existing `PanelMenu.Button` in GNOME's
panel; this is deliberate, so the primary display looks like GNOME and not like two bars.

Each bar renders the same `PillState[]` the indicator already receives, plus the binding-mode label.
Pills are mirrored: every bar shows the same workspaces with the same active highlight, and clicking
one switches the shared workspace. This is honest about today's model, in which a workspace spans
outputs and the tree is `workspace → monitors`. i3's per-output workspace sets are a Phase 4
decision and this design does not prejudge it.

Bars are added with `Main.layoutManager.addChrome(actor, {affectsStruts: true, trackFullscreen: true})`,
the same call GNOME's panel makes (`ui/layout.js`). Struts apply only to an actor along a monitor
edge, so each bar spans its monitor's full width at the top.

**The strut is self-correcting.** Reserving space shrinks that monitor's work area; Mutter emits
`workareas-changed`; the engine re-commits; tiles land inside the reduced area. No new path.

Bars follow the indicator's session rules (main spec §11): hidden when `!Main.sessionMode.hasWindows`,
shown on return to `user`.

## 5. Lifecycle

`disable()` destroys every decoration actor and every bar, and `untrackChrome`s each bar before
destroying it. The existing rule stands: a second `disable()` is a no-op, and no `move_resize_frame`
happens on disable.

**Shutdown.** `workareas-changed` still drives a full commit while the session tears down. With
decorations, that means actor writes during teardown — the class of defect that produced the
disposed-actor critical fixed in Phase 2B's indicator. `Meta.Display::closing` exists in the
installed typelib; the extension connects to it and stops servicing compositor signals at that
point, rather than guarding each consumer individually.

## 6. Testing

**Layer 0, on Node:**
- `layoutWithRects` with a non-zero `rowHeight`: exact rectangles for tabbed (one row) and stacked
  (one row per child), including the degenerate case where the reservation exceeds the container.
- `decorationPlan` state assignment for each of `focused`, `focused_inactive`, `unfocused`; a
  fullscreen leaf contributing neither border nor row; a frame produced only when the selection is a
  container.

**Shell, with fakes:** the renderer's diffing — reuse, restyle, destroy — and its teardown, using the
existing actor doubles that *record* disposed-actor access rather than throwing. That is how the
Phase 2B shutdown defect was found and the same gate must cover the new actors.

**Integration, in the nested shell:**
- A tabbed container's children sit below the title row by exactly the height the engine used.
  `GetTree` gains the container's `rowHeight` so the assertion compares against the engine's own
  number rather than re-deriving it from the theme, which the harness cannot see.
- A stacked container reserves one row per child: children's `y` differs from the container's `y` by
  `rowHeight x childCount`.
- A second virtual monitor's work area shrinks by the bar height, and tiles on it respect it.
- No native criticals across enable, disable and shutdown with decorations present.

## 7. Acceptance criteria

- **A15.** Every tiled window has a border in its state colour; the focused one is the GNOME accent.
- **A16.** `$mod+a` visibly outlines the selected container.
- **A17.** A tabbed container shows one row of tabs with the selected one highlighted; clicking a tab
  focuses that window; children occupy the container rect minus the row.
- **A18.** A stacked container shows one title row per child, all visible; children occupy the rect
  minus all rows.
- **A19.** `default_border pixel N` and the `border` command change border width; `normal` behaves as
  `pixel`.
- **A20.** Each non-primary monitor shows a bar with the same pills and mode label as the primary,
  and its work area shrinks accordingly.
- **A21.** Disabling the extension removes every border, frame, title row and bar, and restores each
  monitor's work area.
