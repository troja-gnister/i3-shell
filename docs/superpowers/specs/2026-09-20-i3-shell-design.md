# i3-shell — Design Specification

- **Date:** 2026-09-20
- **Status (2026-09-22):** Approved design; Phase 1 and Phase 2A merged, A1–A7 live walk passed by user report. **Phase 2B is complete on `phase-2b`**: all ten tasks implemented, per-task reviews and the whole-branch review done, A8–A14 covered by the private integration suite. A8–A14 **live** acceptance remains the user's walk ([docs/acceptance/phase-2.md](../../acceptance/phase-2.md), deliberately unchecked), and nothing is merged or pushed. Phases 3–4 are unimplemented. The [pause handoff](../../handoff-2026-09-22.md) is history; current state is in [PROJECT.md](../../../PROJECT.md) and the [Phase 2B plan](../plans/2026-09-22-phase-2b-integration.md).
- **Target:** GNOME Shell 50.x (Mutter 18), Wayland session, Fedora Silverblue 44
- **Repository:** `~/Dev/i3-shell` (GitHub-bound)
- **License:** GPL-2.0-or-later

## 1. Purpose

i3-shell is a GNOME Shell extension that reproduces the i3 window-manager experience inside GNOME: i3's workspace model and navigation, i3's keybindings read from the user's existing `~/.config/i3/config`, and i3's dynamic container-tree tiling with directional navigation. It replaces two previously used extensions (Tiling Shell, Space Bar), both now disabled.

### 1.1 The bar: "must feel like i3"

Three capabilities are the non-negotiable core; the project is not done until all three work as they do in i3:

1. **Workspace management** — static, numbered, named workspaces; switch and move-to by number; a panel indicator that shows them.
2. **Shortcuts** — the user's i3 config is the single source of truth; its `bindsym`s, `mode`s, `set` variables and `exec`s work as written, with `reload`.
3. **Dynamic tiling** — new windows tile into a container tree; split direction, directional focus and move, focus parent, layout switching, resize.

Phases 1 and 2 (§17) deliver exactly this core. Phases 3 and 4 layer appearance and fidelity on top.

### 1.2 Non-goals (v1)

`bindcode`; `bindsym --release`; marks; scratchpad; `assign`; gaps; i3bar `status_command` / `bar {}`; top-level autostart `exec` / `exec_always`; layout persistence across shell restarts; `resize set` on tiled containers; multi-output workspace semantics (Phase 4 at the earliest); stripping application title bars (impossible on Wayland: `Meta.Window` has no `set_decorated`).

## 2. Context and constraints

- GNOME 50.5 on Wayland only (the X11 session was removed in GNOME 49). i3 itself cannot run inside GNOME; an extension is the only route.
- Silverblue: the extension is installed under `~/.local/share/gnome-shell/extensions/i3-shell@troja/`. Nothing is layered with rpm-ostree; OS rebases never touch it.
- Research on 2026-09-20: no container-tree tiling extension is published for GNOME 50. Forge upstream is unmaintained ("Needs a new maintainer"; last release v49-89; open bugs include "can't tile" and "cannot float"). Its active fork (`jcrussell/forge`) declares GNOME 50 but is unpublished. Decision: build from scratch. Forge and Tiling Shell are GPL and may be read as references for individual problems; no code is copied.
- The reference config (`~/.config/i3/config`): `$mod = Mod4`; `j/k/l/semicolon` = left/down/up/right; ten workspaces `"1:I"` … `"10:X"`; a `resize` mode; `split h/v`; `layout stacking/tabbed/toggle split`; `floating toggle`; `focus mode_toggle`; `focus parent`; `fullscreen toggle`; `kill`; `reload`; `restart`; `exec` bindings (kitty, screenshots, brightness/volume, GUIs); `default_border pixel 2`; `floating_modifier $mod`; `client.*` colours except `client.focused`, which it leaves unset so focused chrome follows the GNOME accent; one `for_window` rule; `font`. 76 `bindsym` lines: 65 in the default mode, 11 in `resize`.
- Wayland cannot restart the shell in place. Code changes reach the live session only after logout/login. The fast loop is a nested shell (§16.2).

## 3. Acceptance criteria

Verified with the user's real config, unmodified.

**Phase 1 — workspaces + shortcuts**

- **A1.** `$mod+1…0` switches to workspaces 1–10; `$mod+Shift+1…0` moves the focused window there and stays on the current workspace (i3 default). Exactly ten workspaces exist at all times.
- **A2.** The panel shows ten pills named `1:I … 10:X`; the active one is highlighted; pills with windows and empty pills are visually distinct; clicking a pill switches.
- **A3.** `$mod+Return` launches kitty; `$mod+Shift+q` closes the focused window; `$mod+f` toggles fullscreen; `$mod+Shift+x`, `+d`, `+b`, `+w`, `+u`, `+e` and `Mod1+Shift+4` run their `exec` commands.
- **A4.** `$mod+r` enters `resize` mode: the indicator shows `resize`; `Escape`, `Return` and `$mod+r` leave it; while in it, bare `j` is not delivered to applications.
- **A5.** `$mod+Shift+c` reloads the config: a changed binding takes effect without logout; a config with a syntax error is rejected with a notification and the previous bindings keep working.
- **A6.** Every GNOME default binding that collides with the config (32 on this system, §13) no longer fires, as do the named IBus hotkeys that collide (`<Super>semicolon` for the emoji picker, `<Super>space` for the input-source switch); disabling the extension restores every one of them.
- **A7.** Locking and unlocking the screen leaves bindings working and never leaves a mode active.

**Phase 2 — dynamic tiling**

- **A8.** Opening windows tiles them; the second window splits the workspace horizontally by default; closing a window re-tiles the rest with no gaps or overlap.
- **A9.** `$mod+h` / `$mod+v` decide where the *next* window lands relative to the focused one.
- **A10.** `$mod+j/k/l/;` move focus left/down/up/right through the tree and wrap at the edge; `$mod+Shift+j/k/l/;` move the window, including out of and into nested containers.
- **A11.** `$mod+a` focuses the parent container; a following `$mod+Shift+;` moves the whole container; `$mod+e` toggles its split orientation.
- **A12.** In `resize` mode, `j/;` shrink/grow width and `k/l` grow/shrink height in 10-ppt steps, resizing the tiled neighbours.
- **A13.** Dialogs, modal dialogs, utility and fixed-size normal windows float automatically; `$mod+Shift+space` toggles floating on a tiled window; `$mod+space` toggles focus between tiled and floating windows. Splash windows remain managed by Mutter and are not tracked by the extension.
- **A14.** After lock/unlock, docking a monitor, or disabling and re-enabling the extension, every tiled window is where the tree says it is.

## 4. Architecture

### 4.1 Layers

```
Layer 2 — orchestration     extension.ts, engine.ts
Layer 1 — shell adapters    src/shell/*.ts     (thin; the only code that imports gi://)
Layer 0 — pure core         src/config, src/commands, src/tree   (no gi:// imports; runs on Node)
```

**Rule:** Layer 0 never imports `gi://` or `resource://` modules. It operates on plain rectangles and opaque ids. This is what allows the parser, the command language and the whole tiling algorithm to be unit-tested on Node in milliseconds.

**Rule:** only `engine.ts` mutates the tree, and every mutation goes through `engine.commit()` (§5).

### 4.2 Modules

Layer 0:

- `config/lexer.ts` — lines → tokens (`#` comments, quoted strings, trailing `\` continuation).
- `config/parser.ts` — tokens → AST of directives; produces diagnostics, never throws.
- `config/resolve.ts` — `$variable` substitution, validation, keysym → accelerator mapping; AST → `Config`.
- `config/model.ts` — `Config`, `Binding`, `Mode`, `Rule`, `Colors`, `Diagnostic` types.
- `commands/parse.ts` — i3 command strings → `Command[]` (typed union); handles `,` / `;` chaining.
- `tree/node.ts` — `Con` types (§7.1).
- `tree/tree.ts` — the `Tree` class: insert, detach, split, setLayout, move, swap, normalize, `check()`.
- `tree/layout.ts` — `layout(con, rect) → Map<WindowId, Rect>`.
- `tree/focus.ts` — directional focus, focus parent/child, `descendFocused`, `descendDirection`.
- `tree/resize.ts` — percent adjustments.

Layer 1 (`src/shell/`):

- `windows.ts` — `Meta.Window` ⇄ `WindowId`; connects `window-created`, per-window `unmanaged`, `size-changed`, `position-changed`, `focus`, `workspace-changed`, `notify::minimized`, `notify::maximized-horizontally`, `notify::maximized-vertically`, `notify::fullscreen`, and the window actor's `first-frame`; emits plain events to the engine.
- `keys.ts` — `grab_accelerator` / `ungrab_accelerator`, `accelerator-activated` dispatch, mode stack.
- `workspaces.ts` — enforces static N, applies names, switch/move, `active-workspace-changed`.
- `geometry.ts` — work areas from `Main.layoutManager`; applies rects with `move_resize_frame`.
- `decorations.ts` (Phase 3) — border and tab-bar actors.
- `indicator.ts` — `PanelMenu.Button` with workspace pills and binding-mode label.
- `settings.ts` — snapshot / override / restore of conflicting GNOME settings (§13).
- `control.ts` — D-Bus `org.i3shell.Control` (§14).
- `session.ts` — `Main.sessionMode` `updated` handling (§8.4, item 6).
- `notify.ts` — one-shot GNOME notifications for diagnostics.
- `util/signals.ts` — `SignalTracker` (connect / disconnect-all) and `guard()` for callbacks.

Layer 2:

- `engine.ts` — owns the `Tree`, the current `Config`, focus state; implements every `Command`; `commit()`.
- `extension.ts` — `enable()` constructs Layer 1 + engine, loads the config, adopts windows; `disable()` tears everything down.

### 4.3 Repository layout

```
i3-shell/
  src/                       TypeScript sources (layers above)
  test/unit/                 vitest; fixtures/ holds a copy of the reference i3 config
  test/integration/          nested-shell harness (§16.2)
  schemas/                   org.gnome.shell.extensions.i3-shell.gschema.xml
  metadata.json  stylesheet.css
  package.json  tsconfig.json  esbuild.mjs  Makefile
  docs/superpowers/specs/    this document
  docs/superpowers/plans/    per-phase implementation plans
```

## 5. Data flow and the commit pipeline

```
config file ──parse──▶ Config ──▶ keys.ts (grab accelerators)
                          ├──────▶ workspaces.ts (static N, names)
                          └──────▶ engine (colours, rules, options)

key ──▶ accelerator-activated ──▶ keys.ts ──▶ Command ──▶ engine.dispatch()
window event ──▶ windows.ts ──▶ engine.onWindowAdded / Removed / Focused / Changed()
D-Bus Command() ──▶ control.ts ──▶ engine.dispatch()

engine.commit():
  1. normalize the tree              (§7.2)
  2. layout every workspace          → Map<WindowId, Rect>
  3. diff against the last applied rects; include forced re-applications (§8.4 item 2)
  4. geometry.apply(changed)         (records the expected rect per window)
  5. decorations.update(); indicator.update(); TreeChanged D-Bus signal
```

`commit()` is the only path that changes window geometry. Handlers never call `move_resize_frame` directly.

## 6. Configuration

### 6.1 File and loading

- Path: `~/.config/i3/config` (override via the GSettings key `config-path`; empty = default).
- Loaded on `enable()`, on the `reload` command, and on the `restart` command.
- The file is read in full, parsed and resolved; the result is `{config, diagnostics}`.
- **Errors reject the file**; the last good config stays active. The text of the last accepted config is cached at `$XDG_CACHE_HOME/i3-shell/last-good.config` so it survives shell restarts. If there is no last good config, a built-in fallback (i3's default bindings with `$mod = Mod4`) is loaded so the user is never without bindings.
- On initial load, a missing or unreadable file follows the same cache → built-in fallback chain as an invalid file; its not-found diagnostic remains a warning. On reload, a missing file is rejected and the running config remains active.
- **Warnings** never reject the file.

### 6.2 Grammar (v1)

```
set $name value…
bindsym [--no-repeat] combo command[, command…][; command…]
mode "name" { bindsym … }              # one level; modes do not nest
for_window [criteria] command…          # parsed in Phase 1, applied in Phase 4
default_border pixel N | normal [N] | none
default_floating_border pixel N | normal [N] | none
floating_modifier Mod4 | Mod1 | none
focus_wrapping yes | no | force | workspace   # default yes
workspace_auto_back_and_forth yes | no        # default no
client.focused | focused_inactive | unfocused | urgent   <border> <bg> <text> [indicator] [child_border]
font …                                  # accepted, no effect
client.background | client.placeholder …# accepted, no effect
bar { … }                               # accepted, no effect (block skipped)
# comments, blank lines, trailing '\' continuation
```

Criteria: `[class="re" instance="re" title="re" app_id="re" window_role="re" floating tiling]` — regexes are JavaScript `RegExp`; `class` matches `wm-class`; `app_id` matches `gtk-application-id`, falling back to `wm-class`.

### 6.3 Directive policy — three tiers

1. **Unknown directive** → error (i3 behaviour). The file is rejected.
2. **Valid i3, not implemented** (`bindcode`, `bindsym --release`, `assign`, `workspace_layout`, `focus_follows_mouse`, top-level `exec` / `exec_always`, `gaps`, `hide_edge_borders`, `title_format`, `floating_minimum_size`, …) → warning; the directive is skipped.
3. **Valid i3, accepted with no effect** (`font`, `client.background`, `client.placeholder`, `bar {}`) → silently accepted. A warning on every load for cosmetic lines every real config contains would be noise.

Warnings are shown once per load as a single notification ("i3-shell: N directives skipped — see log") and logged individually with line numbers.

### 6.4 Keysym → accelerator

i3 combos become Mutter accelerator strings: `Mod4` → `<Super>`, `Mod1` → `<Alt>`, `Shift` → `<Shift>`, `Control` / `Ctrl` → `<Control>`, `Mod3` → `<Mod3>`, `Mod5` → `<Mod5>`, `Mod2` → dropped (NumLock). The final token passes through unchanged: X keysym names (`semicolon`, `Return`, `space`, `Left`, `XF86AudioRaiseVolume`, `4`) are what Mutter's accelerator parser accepts. Examples: `$mod+semicolon` → `<Super>semicolon`; `$mod+Shift+4` → `<Super><Shift>4`; `Mod1+Shift+4` → `<Alt><Shift>4`.

### 6.5 Variables

`set $name value` — textual substitution, longest name first, anywhere in the file (i3 semantics: every `set` line is collected in a first pass, then substituted, so definition order does not matter; expansion is not recursive). Quoted values keep their quotes (`set $ws1 "1:I"` → `workspace number "1:I"`).

### 6.6 Reload semantics

`reload`: re-parse; on success diff the bindings — ungrab removed, grab added, rebind changed — update colours and options, keep the tree; the mode stack resets to `default`. `restart`: `reload`, then rebuild the tree from live windows (§8.5).

### 6.7 Command language

Parsed by `commands/parse.ts` into typed commands; `,` and `;` chains execute sequentially (equivalent for bindings without criteria).

| Command | v1 behaviour |
|---|---|
| `exec [--no-startup-id] <cmd…>` | spawn `/bin/sh -c "<cmd>"` detached, cwd `$HOME` |
| `kill` | close (`delete()`) every leaf under the focused con |
| `focus left\|right\|up\|down` | §7.6 |
| `focus parent` / `focus child` | §7.6 |
| `focus mode_toggle` | §7.10 |
| `move left\|right\|up\|down` | §7.7 |
| `move container to workspace number N` / `… workspace <name>` / `… workspace next\|prev` | §9 |
| `split h\|horizontal\|v\|vertical\|toggle` | §7.4 |
| `layout splith\|splitv\|tabbed\|stacking` / `layout toggle split` / `layout toggle all` / `layout toggle <list>` | §7.5 |
| `fullscreen [toggle\|enable\|disable]` | §7.9 |
| `floating toggle\|enable\|disable` | §7.10 |
| `workspace number N` / `workspace <name>` / `workspace next\|prev` | §9 |
| `workspace back_and_forth` / `move container to workspace back_and_forth` | Phase 4 (warning until then) |
| `resize grow\|shrink width\|height N px [or M ppt]` | §7.8 |
| `resize set W H` | floating only |
| `move position center` / `move position X Y` | floating only (rules in Phase 4) |
| `border pixel N\|normal\|none\|toggle` | Phase 3 |
| `mode "name"` | §10 |
| `reload` / `restart` | §6.6 |
| `nop [text]` | no-op |

An unknown command is a parse-time warning; the binding is still grabbed and only logs when pressed, so a typo never silently hands a key back to GNOME.

## 7. Tree model and semantics

### 7.1 Nodes

```
Tree
 └ WorkspaceCon[i]   i = 0..N-1, 1:1 with GNOME workspace index
    └ MonitorCon[m]  one per connected monitor; a SplitCon flagged root=true whose
      │              layout is splith|splitv and whose rect is that monitor's work area
      └ Con*         SplitCon | LeafCon

SplitCon: { layout: 'splith'|'splitv'|'tabbed'|'stacked', children: Con[],
            percents: number[]  (one per child, sum 1), focusedChild: Con|null,
            lastSplitLayout: 'splith'|'splitv', root: boolean }
LeafCon:  { window: WindowId }
```

Focus state: `focused: Con` — may be a SplitCon after `focus parent` — kept per workspace (`workspace.focusedCon`) and globally. Floating windows are not in the tree; each WorkspaceCon has `floating: WindowId[]`, ordered by most recent focus.

Orientation: `splith` / `tabbed` → horizontal; `splitv` / `stacked` → vertical.

Level order: i3 is root → output → workspace; GNOME workspaces span monitors, so here it is workspace → monitor. With one monitor the visible behaviour is identical. Wherever i3 asks "is the parent the workspace?", this design asks `parent.root`.

### 7.2 Invariants and `normalize()`

After every mutation and before layout:

1. No SplitCon without children (empty containers are removed, recursively; root cons are exempt).
2. i3's `tree_flatten` rule: a non-root splith/splitv SplitCon whose only child is a splith/splitv SplitCon of the *other* orientation, where the child's orientation equals the grandparent's, is replaced by its child. A single **leaf** alone in a SplitCon is legal and preserved — that is the pending-split state after `split`.
3. `percents` has one entry per child, each > 0, summing to 1. A new child receives `1/n` and the others scale by `(n−1)/n`; a removed child's share is redistributed proportionally.
4. Every `focusedChild` points at a current child (repaired to the first child if stale).
5. Every LeafCon's window id is live (dead ids are removed; §8.3 removes them eagerly, this is belt and braces).

`Tree.check()` asserts 1–5 and is called by tests after every operation.

### 7.3 Insertion of a new tiled window

Target workspace = the window's GNOME workspace; monitor = the window's monitor. With `f` = that workspace's `focusedCon`:

- `f` is a LeafCon → insert after it in its parent.
- `f` is a SplitCon (including a root) → append as its last child.
- The monitor's root has no children → the leaf becomes its first child.

The new leaf becomes `focused` for that workspace and the `focusedChild` chain up to the root is updated. If the workspace is the active one, it also becomes the global `focused`.

### 7.4 `split`

`split h|v` on the focused con `c` (i3 `tree_split`):

- `c` is a root: 0 children → set its layout; 1 child → apply the rule to that child; ≥ 2 children → wrap all children in a new SplitCon of that orientation.
- Otherwise, with `p = c.parent`: if `p` has exactly one child and `p.layout` is splith/splitv → set `p.layout` (no pointless nesting); else replace `c` in `p` with a new SplitCon of that orientation containing only `c` (percent preserved).
- `split toggle` → the orientation opposite to `c.parent`'s.

### 7.5 `layout`

Target `t` = the focused con if it is a SplitCon, else its parent.

- `t` is a root and the layout is tabbed/stacked: wrap all of `t`'s children in a new SplitCon with that layout (workspace roots may only be splith/splitv — this is why `$mod+w` on a lone window works in i3).
- Otherwise set `t.layout`; when setting splith/splitv also record `t.lastSplitLayout`.
- `layout toggle split`: splith ↔ splitv; from tabbed/stacked → `t.lastSplitLayout`. `layout toggle all`: splith → splitv → tabbed → stacked → splith. `layout toggle a b c`: cycle through the list.

### 7.6 Focus

- `descendFocused(c)`: follow `focusedChild` to a leaf (first child where null).
- `descendDirection(c, dir)` (i3 `con_descend_direction`): the leaf farthest *against* the direction of travel — for `right` the leftmost, for `left` the rightmost, for `down` the topmost, for `up` the bottommost; where a level's orientation does not match, follow `focusedChild`.

`focus <dir>` (i3 `_tree_next`; `focus_wrapping yes` is the default):

```
next(c):
  if c.root: return false                       # Phase 4: focus the monitor in that direction
  p = c.parent
  if orientation(p) ≠ orientation(dir): return next(p)
  s = sibling of c in p toward dir
  if s is null:
    if focus_wrapping == 'force': s = wrap(p)
    else if next(p): return true                # higher levels first
    else if focus_wrapping == 'no': return false
    else: s = wrap(p)                           # wrap at the highest matching level
    if s is c: return false
  focusLeaf(descendFocused(s)); return true

wrap(p) = first child of p for right/down, last child for left/up
```

Tabbed containers count as horizontal and stacked as vertical, so `focus left/right` switches tabs and `up/down` switches stack entries. `focus_wrapping workspace` wraps only at the root level.

- `focusLeaf(leaf)`: set `focused = leaf`, update `focusedChild` on every ancestor, then `window.activate(timestamp)` so GNOME keyboard focus follows.
- `focus parent`: `focused = focused.parent`, stopping at the root (the root itself may be focused; a further `focus parent` is a no-op). GNOME keyboard focus is unchanged — exactly as X focus stays on the leaf in i3.
- `focus child`: `focused = focused.focusedChild` if any.
- Tree focus is also updated from GNOME (§8.3): a `focus` signal on a tiled window sets `focused` to its leaf and repairs the chain.

**Command target (Phase 2):** commands operate on the engine's selected container, or its tracked floating-window selection, never by reading `global.display.focus_window` at dispatch time. After `focus parent`, the selected container remains the target even though GNOME keyboard focus stays on a leaf. The engine resolves the affected leaves to `WindowId`s and calls adapter operations such as `kill(id)`, `fullscreen(id, action)` and `moveToWorkspace(id, index)`, passing timestamps where needed. These replace the Phase 1 focused-window helpers. Existing command semantics still apply: `kill` and workspace moves affect all leaves under the selected container; fullscreen on a SplitCon is a warning and no-op (§7.9).

### 7.7 Move

`move <dir>` for a tiled con `c` (i3 `tree_move`), with `o = orientation(dir)`:

```
same = nearest ancestor of c (starting at c.parent) with orientation o; null if none
if same is null: return                          # Phase 4: move to the monitor in that direction
if same == c.parent:
  s = sibling of c toward dir
  if s ≠ null:
    if s is a LeafCon: swap c and s in place (percents follow positions)
    else: t = descendDirection(s, dir)
          pos = (orientation(t.parent) ≠ o or dir ∈ {up, left}) ? AFTER : BEFORE
          detach c; insert c next to t at pos
    goto done
  if same.root: return                           # edge of this monitor's workspace
  same = nearest ancestor of same.parent with orientation o; if null: return
above = the ancestor of c whose parent is same
detach c; insert c next to above at (dir ∈ {left, up} ? BEFORE : AFTER)
done: normalize; focused = c; repair the focusedChild chain
```

Worked examples (H = splith, V = splitv; the outer bracket is a horizontal root):

- `[A][V:{B,C}]`, focus C, `move left` → `[A][C][V:{B}]` — pops out beside its former container.
- `[A][H:{C,D}]`, focus A, `move right` → `[H:{A,C,D}]` — enters at the near edge.
- `[V:{A, H:{D,B}}][C]`, focus B, `move right` → `[V:{A, H:{D}}][B][C]`.
- Vertical root `[H:{A,B}]`, focus B, `move right` → no-op (no horizontal level above).

A detached con's percent is redistributed among its old siblings; an inserted con receives `1/n`.

### 7.8 Resize

`resize grow|shrink width|height N px [or M ppt]` on a tiled con `c`:

- `anc` = nearest ancestor with horizontal (width) / vertical (height) orientation; `sub` = the ancestor of `c` that is `anc`'s child. No `anc`, or `anc` has one child → no-op.
- Δ = `M/100` when ppt is given, else `N / anc.rect.size` on that axis. grow → +Δ, shrink → −Δ.
- `sub.percent += Δ`; −Δ is distributed equally over `sub`'s siblings. If any percent would fall below 0.05 or exceed 0.95 → no-op.

Floating: change the frame by N px on that axis, keeping position. `resize set W H`: floating → set the frame size; tiled → warning, no-op.

### 7.9 Fullscreen

`fullscreen toggle|enable|disable` on a leaf: Mutter native `make_fullscreen()` / `unmake_fullscreen()`. The leaf keeps its tree slot; other windows keep their rects underneath. On `notify::fullscreen` → false (from the app or the user) the leaf's rect is forcibly re-applied on the next commit, even when unchanged in the geometry diff (§8.4 item 2). On a SplitCon: warning, no-op (v1).

### 7.10 Floating

- `floating enable` on a tiled leaf: detach from the tree (siblings' percents redistributed), append to the workspace's `floating` list, keep the current frame rect; the window is left to Mutter's normal management.
- `floating disable` on a floating window: insert into the tree per §7.3.
- Automatic floating (§8.2) uses the same path.
- `focus mode_toggle`: focused window tiled → activate the workspace's most recently focused floating window (no-op if none); floating → activate `descendFocused(workspace.focusedCon)`.
- `floating_modifier Mod4` ↔ GNOME's `org.gnome.desktop.wm.preferences mouse-button-modifier` (`<Super>` by default; overridden and restored per §13 when the config differs).
- Stacking: floating windows are not forced above tiled ones — Mutter raises the focused window (§19).
- **A window that returns to the tree has its floating state pinned.** When a window leaves the tree — minimized, on all workspaces, or skip-taskbar (§8.2) — the engine remembers the floating state it had; when it comes back, that state is written into `_manualFloating`, turning a **derived** state into an explicit, pinned one. While kind is fixed at a window's first frame this is a no-op, because the pinned value is exactly what classification would derive anyway. It becomes real the moment a later phase makes `transient` or `attached` mutable: a returning window would then be frozen at its old kind. The behaviour is kept deliberately — it is the same path minimize/unminimize has always used, and special-casing it while it cannot be observed would be untestable.

### 7.11 Layout algorithm

`layout(con, rect)`:

- LeafCon → `{ window: rect }`.
- `splith`: children get widths `rect.w × percent[i]` left to right, full height; `splitv` analogous. Sizes are rounded to integers and the last child absorbs the rounding, so the rects tile `rect` exactly.
- `tabbed` / `stacked`: every child gets `rect` (Phase 3: minus the tab/stack bar) and the active child (`focusedChild`) is raised.
- MonitorCon → its work area; WorkspaceCon → each of its MonitorCons.

Rects are integer. For each non-empty `splith` / `splitv` container, direct children's rects do not overlap and their union is the parent rect. For `tabbed` / `stacked`, each direct child receives the same parent rect in Phase 2; overlap is intentional (asserted by tests).

## 8. Windows and lifecycle

### 8.1 Identity

`windows.ts` assigns a monotonically increasing `WindowId` to every managed `Meta.Window` (`Map<WindowId, Meta.Window>` plus `WeakMap<Meta.Window, WindowId>`). The tree and engine only ever hold ids. `resolve(id)` returning `undefined` means "gone; skip". On `unmanaged`, the id is removed from both maps in the same handler that tells the engine.

Native teardown begins earlier, at `unmanaging`: reads, operations and change callbacks must already exclude that window while its actor, focus and workspace are being removed. During this interval the adapter filters its last safe MRU enumeration instead of asking Mutter to enumerate partially removed windows; fresh native enumeration resumes after the final `unmanaged` boundary. A pending first-frame subscription must become inert when its actor is destroyed, so later cleanup never disconnects a disposed actor.

### 8.2 Which windows tile

A window is **tiled** iff all of: `window_type == NORMAL`; `get_transient_for() == null`; not `is_attached_dialog()`; **intrinsically resizable**; not matched by a `floating enable` rule (Phase 4).

**`skip_taskbar` and "on all workspaces" are no longer classification inputs (Phase 3B).** They were until 2026-09-23, and both are mutable at runtime while classification is cached for a window's lifetime, so a flip dropped the window **permanently**: `classifyWindow` returned `null`, the tracker disposed the window's watch and never allocated an id, and the reverse transition could not even be observed. Under GNOME's default `workspaces-only-on-primary` Mutter marks every window on a secondary output `on_all_workspaces`, so that happened routinely, whenever a window reached the external display (§9 now owns that key). Both facts therefore live on the per-commit `WindowInfo` beside `minimized` and `fullscreen`, not on the read-once `WindowFacts`, and they decide **membership of the tree**, never **kind**:

```ts
excludedFromTree(info) = info.minimized || info.sticky || (info.skipTaskbar && info.kind === 'tiled')
```

The `kind === 'tiled'` term is not a new rule; it restores an ordering the old predicate had for free. `skip_taskbar` used to be read on the line that had already ruled out every other reason to float, so it never applied to a dialog, a transient, an attached dialog or a fixed-size window. Mutter reports `is_skip_taskbar()` true for a **modal dialog**, and a flat `minimized || sticky || skipTaskbar` excluded such a window from the tree *and* from the workspace's `floating` list — the only code that adds to that list sits on the branch that is skipped while a window is excluded — so it vanished from both. That was caught by the nested scenario A13 against a real GTK modal, not by any unit test. `minimized` and `sticky` get no such gate: `sticky` mapped to `null` unconditionally in the old code and `minimized` is orthogonal to kind by construction, so gating either would invent behaviour rather than restore it.

`null` from `classifyWindow` now means exactly one thing: **this window type is not ours.** The tracker therefore allocates an id and keeps its watch for every window it admits, and re-entry needs no new lifecycle state — a window that is excluded is still tracked, and rejoins the tree beside the focused window per §7.3 the moment every reason has cleared (§7.10 records what that pins). Both facts are watched natively, through `notify::on-all-workspaces` and `notify::skip-taskbar` (§8.3); without a signal a flipped fact would sit unnoticed until some unrelated commit happened to re-read it, so a window would leave or rejoin the tiling at an arbitrary later moment rather than when the user acted.

**Intrinsically resizable** is the `resizeable` property (Mutter's `has_resize_func` — note the spelling) together with the program size hints from `get_min_size()` / `get_max_size()`, and deliberately *not* `allows_resize()`. In Mutter 50.5 `meta_window_allows_resize()` is `has_resize_func && !maximized && !fullscreen && (min_width < max_width || min_height < max_height)`: it answers "may the user drag this border **right now**", so it is false for a window that merely happens to be maximized. Classification runs once, at the first frame, and is cached for the window's lifetime, so reading `allows_resize()` there filed every window whose application opens maximized as floating forever and tiling never engaged at all (live defect, 2026-09-23). Only the hint term is intrinsic, and that is what `isResizable()` reproduces. `has_resize_func` is not purely intrinsic either: `meta_window_recalc_features()` clears it while a window is fullscreen, so for a normal, non-override-redirect window it is exactly `!(min == max) && !fullscreen`. While a window is fullscreen its `resizeable` therefore says nothing about the window itself and the hints are the whole answer — otherwise a player that *opens* fullscreen would float forever, which is the same defect again and contradicts §19's rule that a fullscreen window keeps its tree slot. A window mapped maximized or mapped fullscreen is adopted tiled. Each getter reports 0 with a false "known" flag when the client set no such hint, while Mutter internally defaults the minimum to 0 and the maximum to `G_MAXINT`: an unknown bound is an absent bound, and reading those zeroes as real limits would call every hintless window fixed-size — the same total failure with the opposite cause. The predicate is pure and lives in Layer 0 (`src/runtime/classify.ts`) so that it can be tested; `windows.ts` only reads the natives and hands them over.

DIALOG, MODAL_DIALOG, UTILITY and transient application windows are tracked in the workspace's `floating` list so `focus mode_toggle` can reach them. Fixed-size NORMAL windows (minimum size equal to maximum size) also enter that list rather than being discarded by the tiling filter. Splash windows, docks, menus and tooltips are ignored entirely, including when transient: Mutter manages them and the extension does not assign them a tracked window id.

### 8.3 Events → engine

| Signal | Handler |
|---|---|
| `display::window-created` | connect per-window signals; on the actor's `first-frame` → `onWindowAdded(id)` → §7.3 or the floating list → commit |
| `window::unmanaged` | `onWindowRemoved(id)` → detach the leaf / remove from floating → commit; if it was focused, focus falls to `descendFocused(parent)` |
| `window::focus` / `display::notify::focus-window` | `onFocused(id)`: tiled → set `focused`, repair the chain; floating → move to the front of the floating list |
| `window::size-changed` / `position-changed` | tiled and frame ≠ expected rect → request at most one corrective re-apply per expected-rect generation through commit (§8.4 item 2); floating → ignore |
| `window::workspace-changed` | if the new workspace equals the id's *expected workspace* (set by an engine-initiated move) → clear it, no tree change; else detach from the old workspace and insert into the new one per §7.3 → commit |
| `window::notify::minimized` | true → detach (remembered as minimized); false → insert as new (§7.3), then force re-apply through commit even if the rect is unchanged |
| `window::notify::maximized-horizontally` / `-vertically` | tiled and now maximized → `unmaximize()`; after unmaximize, force re-apply through commit even if the rect is unchanged |
| `window::notify::fullscreen` | false → force re-apply the rect on the next commit even if unchanged |
| `window::notify::on-all-workspaces` / `notify::skip-taskbar` | one `'membership'` event (named, not folded into `'minimized'`, so a log line or a failing test says which fact moved): the next commit re-reads `WindowInfo` and `excludedFromTree` (§8.2) detaches or re-inserts the window. Both connections are torn down by the same per-window `disposeWatch` as the others — no second teardown path |
| `workspace_manager::active-workspace-changed` | indicator update; global `focused` = that workspace's `focusedCon` |
| `layoutManager::monitors-changed` | rebuild MonitorCons (cons of a vanished monitor are appended under the primary monitor's root) → commit with forced re-apply for tiled windows, including unchanged rects |
| `display::window-demands-attention` | Phase 4 (urgent pills) |

### 8.4 Danger zones — explicit designs

1. **Not yet mapped.** Insert on `first-frame`, not on `window-created`: `move_resize_frame` before the first frame is unreliable and races GNOME's own placement.
2. **Geometry reconciliation.** Each `geometry.apply` records the window's expected rect. A changed expected rect starts a new reconciliation generation. On `size-changed` / `position-changed`, a tiled window whose frame differs from that rect receives at most one corrective re-apply for that generation, through `commit()`. Matching notifications do nothing. If the frame still differs after that corrective application has taken effect, mark the window stubborn for that generation and stop re-applying until a later commit changes its expected rect. Duplicate notifications do not reset the retry allowance. This bounds retries for a client whose minimum size exceeds its tile; fixed-size normal windows float instead (§8.2).

   Four lifecycle events force a fresh application and reconciliation generation even when the expected rect is unchanged: fullscreen exit (`notify::fullscreen` → false), unminimize (`notify::minimized` → false), `monitors-changed`, and completion of the engine's `unmaximize()` after catching a tiled window maximizing (`notify::maximized-horizontally` / `-vertically`). These invalidations bypass the normal rect diff and the old generation's stubborn marker. Fullscreen and minimized windows are not held to tiled geometry while in those states. `workspace-changed` is not a forced-reapply exception; its normal tree mutation and rect diff suffice. All re-applications go through the single commit pipeline, never directly from signal handlers.
3. **Death mid-commit.** Ids resolve at apply time; `undefined` is skipped; the `unmanaged` handler recommits. Every handler is idempotent.
4. **Focus drift.** GNOME-side focus changes always update tree focus and the `focusedChild` chain (§8.3), so directional focus starts from reality.
5. **Maximize / minimize.** See §19.
6. **Lock screen.** `metadata.json` declares `session-modes: ["user", "unlock-dialog"]` so the extension stays enabled across locking and the tree survives. On `Main.sessionMode` `updated`: entering a mode where `!Main.sessionMode.hasWindows` → ungrab all accelerators, pop to the `default` mode, hide the indicator; returning to `user` → regrab. A live bare-key grab (`resize` mode's `j`) must never reach the password entry.
7. **`disable()` is total.** `SignalTracker.disconnectAll()`, ungrab every accelerator, destroy indicator and decoration actors, unexport D-Bus, restore §13 overrides, drop all maps. Idempotent (a second `disable()` is a no-op). No `move_resize_frame` on disable — windows stay where they are.
8. **Monitors change.** Rebuild MonitorCons and relayout all workspaces (§8.3).

### 8.5 Adoption on enable / restart

`global.get_window_actors()` filtered by §8.2, inserted per workspace in MRU order (`display.get_tab_list(Meta.TabList.NORMAL_ALL_MRU, workspace)`) so the most recent window is `focused`. The current GNOME focus window becomes the global `focused` if tiled. Then commit.

## 9. Workspaces

- Count `N` = the largest workspace number referenced by `workspace number` / `move container to workspace number` commands in the config (minimum 1, maximum 36). If the config references none, `N` = the current `num-workspaces` setting. For the reference config N = 10.
- On enable (snapshot / restore per §13): `org.gnome.mutter dynamic-workspaces = false`, `org.gnome.desktop.wm.preferences num-workspaces = N`, `workspace-names = [configured names]`. `org.gnome.mutter workspaces-only-on-primary = false` (Phase 3B): while it is true Mutter marks every window on a **secondary** output `on_all_workspaces`, and i3-shell keeps such windows out of the tree (§8.2), so an external display could never tile. It is applied unconditionally — independently of the workspace count, because a config that names no workspaces still needs its secondary output to tile — and it is snapshotted and restored on `disable()` through the same machinery as every other override (§13). **Consequence, to state plainly:** while the extension is enabled GNOME treats a workspace as spanning every output, for every application, not only for windows i3-shell tiles. If GNOME changes the workspace count under us (`notify::n-workspaces`), the count settings are re-applied.
- `workspace number N`: the number is the leading digits of the argument (`"1:I"` → 1); activate GNOME workspace N−1; no-op if already active (i3 without `workspace_auto_back_and_forth`). `workspace <name>` without leading digits matches a configured name, else warning.
- `move container to workspace number N`: no-op if N is the current workspace; otherwise the engine detaches the focused con from the source tree, attaches it to the target workspace's tree per §7.3 (structure intact), records the expected workspace for every leaf, then calls `change_workspace_by_index(N−1, false)` on each. Focus stays on the current workspace (i3 default, no follow); it falls to `descendFocused(oldParent)`.
  If the selected con is a monitor root, retain that root and move its contents in an equivalent non-root split, preserving descendant nodes, layout, percentages and focused child before normal §7.2 cleanup. This still moves every selected leaf as required by §7.6. An empty root is a no-op; after a nonempty root-content move, source selection remains on the now-empty root.
- `workspace next|prev`: index ± 1 without wrap.
- `workspace_auto_back_and_forth` and `workspace back_and_forth`: Phase 4.

## 10. Keys and modes

- Each binding → `global.display.grab_accelerator(accel, flags)` with no flags (`IGNORE_AUTOREPEAT` when `--no-repeat`). It returns an action id; 0 means the grab failed (already held by another client) → warning diagnostic naming the combo, and the binding is inactive. `accelerator-activated (action, device, timestamp)` → look up the binding → dispatch its commands with `timestamp`.
- Default-mode bindings are grabbed on load. `mode "x"`: push `x` — ungrab the current mode's accelerators, grab `x`'s; `mode "default"` pops to default. The stack exists for robustness only (i3 modes do not nest; depth is ≤ 2). Reload, lock and disable reset it to `default`.
- Mode bindings may be bare keys (`j`, `Escape`, `Return`); grabbing them globally while the mode is active is intended (i3 behaviour).
- The overlay key (`Super` tap → Activities) is not touched (§19).

## 11. Panel indicator

- A `PanelMenu.Button` in the left panel box at index 0; GNOME's own workspace-indicator button (`Main.panel.statusArea.activities`) is hidden while enabled and shown again on disable.
- One pill per workspace, in order, showing the configured name (`1:I`); style classes `active`, `occupied`, `empty`, `urgent` (urgent in Phase 4).
- Colours derive from the config so no new syntax is needed: active = `client.focused` (bg / text), occupied = `client.unfocused.text` on transparent, empty = the same at 50 % opacity, urgent = `client.urgent`, binding-mode label = `client.focused_inactive`.
- **When the config never sets `client.focused`, focused chrome follows the GNOME accent instead of i3's default blue** (`effectiveColors()` in `config/colors.ts`). `Config.specifiedColors` records which `client.*` keys the config actually set, because the resolved `Colors` is always fully populated from i3's defaults and so cannot answer "did the user ask for this?". The accent is read from `St.ThemeContext.get_accent_color()` -- the resolved pair, not the `St.Settings` enum, so a distro that retunes the palette is followed without this repository carrying a copy of it -- and re-pushed on `notify::accent-color`, which changes colours only and never runs a commit. Cogl reports each component as a 0-255 byte: a live nested shell returns `53,132,228` for GNOME blue, i.e. `#3584e4`.
- Only the **focused** state is taken from the accent. `unfocused`, `focused_inactive` and `urgent` carry meaning the accent cannot express -- urgent must stay a warning colour, not the user's favourite one.
- Rationale for the deviation: real i3 takes workspace button colours from `bar { colors { focused_workspace } }`, not from `client.focused`, so sourcing the pill from `client.focused` was already a deviation; `bar {}` remains a v1 non-goal. A config that does set `client.focused` still wins, so the config remains the single source of truth and the accent only fills a silence.
- Click a pill → `workspace number N`; scroll over the indicator → `workspace prev` / `next`.
- While a non-default mode is active, a label with the mode name appears right of the pills (i3bar's `binding_mode`).

## 12. Decorations (Phase 3)

- Border: one `St.Widget` per tiled leaf in `global.window_group`, kept just below its window actor, sized to the leaf rect and drawn as a `default_border pixel N` frame; colour by state: focused = `client.focused.border` (the GNOME accent when the config does not set it, per §16.1); focused_inactive = `client.focused_inactive` (the other leaves of the focused con, and the focused leaf of an inactive workspace); unfocused = `client.unfocused`; urgent = `client.urgent`. When `focused` is a SplitCon, one frame surrounds the whole con rect (i3 behaviour). `border pixel N|none|normal` per con; `normal` is treated as `pixel N` (no title bars on Wayland).
- Tabbed / stacked bars: an `St.BoxLayout` of title labels (`window.title`) along the con's top edge; tabbed = one row of equal-width tabs, stacked = one row per child. Bar height = one label line plus padding from the shell theme (not the `font` directive). Clicking a title focuses that child. The children's rect is the con rect minus the bar.
- All actors are created, updated and destroyed only from `commit()`, and destroyed in `disable()`.

## 13. GNOME settings overrides

On enable, after the config is parsed, `settings.ts` enumerates every key of type `as` (and `s` for the `-static` media keys) in `org.gnome.desktop.wm.keybindings`, `org.gnome.shell.keybindings`, `org.gnome.mutter.keybindings`, `org.gnome.mutter.wayland.keybindings` and `org.gnome.settings-daemon.plugins.media-keys`, canonicalises each accelerator (sorted modifiers, lower-cased key), and clears any that equals one of the config's **default-mode** accelerators. Mode-only bindings are transient grabs and need no clearing. It also applies `dynamic-workspaces`, `num-workspaces`, `workspace-names`, `workspaces-only-on-primary = false` (§9, from Phase 3B), and `mouse-button-modifier` when `floating_modifier` differs from the current value.

- Every original value is saved first into the extension's GSettings key `overridden-settings` (JSON `{schema: {key: value}}`) — the mechanism Tiling Shell uses. If that key is already non-empty on enable (the shell died before a restore), the existing snapshot is kept, not overwritten with already-overridden values, and the overrides are re-applied on top.
- `disable()` attempts to restore every saved value and removes only successfully restored entries from the snapshot. If a setter returns `false` or throws, or its schema is unavailable, keep that original persisted for a later restore attempt and log the failure. The snapshot is empty only when all entries have been restored.
- Re-evaluated on `reload`: new conflicts are cleared; keys whose conflicting binding left the config are restored.
- **Accelerators claimed outside GNOME's own schemas are cleared too, but by name rather than by scan.** `FOREIGN_BINDING_KEYS` lists `org.freedesktop.ibus.panel.emoji` `hotkey` / `unicode-hotkey` and `org.freedesktop.ibus.general.hotkey` `triggers`; they go through the same snapshot, clear and restore path. IBus is **not** competing for the grab: GNOME Shell's `GrabAccelerator` D-Bus API is restricted to `org.gnome.Settings`, `org.gnome.SettingsDaemon.MediaKeys` and `org.freedesktop.impl.portal.desktop.gnome` (`ui/shellDBus.js`), and IBus is on none of that list, so this extension wins every grab it asks for -- a live session reports all 65 grabbed with no failures while the emoji picker still opened. `ibus-extension-gtk3` reads these settings and acts on the same accelerator independently of the grab, so the conflict is at the settings layer and clearing the setting is the remedy. **An earlier revision of this document claimed IBus registers its hotkeys through GNOME's API before the extension can; that was wrong on both counts and is corrected here.**
- These keys are **named, never discovered by type.** Their schemas are not keybinding schemas: `org.freedesktop.ibus.general` holds `xkb-latin-layouts`, a long `as` list of layout names, and `org.freedesktop.ibus.general.hotkey` holds `trigger`, which uses IBus's own `Control+space` spelling rather than GTK's. A type-driven scan of those schemas would corrupt data that has nothing to do with accelerators. A named key that the installed schema does not have is skipped, since these schemas belong to another project and may drop one in any release.
- The config wins over GNOME defaults by design, including `XF86Audio*`: the reference config binds them explicitly to `wpctl` / `pactl`, so GNOME's volume-OSD handler is released. Removing those lines returns the keys to GNOME on the next reload.

Measured against the reference config on 2026-09-20: 32 conflicting default bindings, among them `switch-to-application-1…9` (`<Super>1…9`), `toggle-tiled-left/right` (`<Super>Left/Right`), `maximize` / `unmaximize` (`<Super>Up/Down`), `minimize` (`<Super>h`), `toggle-application-view` (`<Super>a`), `toggle-message-tray` (`<Super>v`), `toggle-quick-settings` (`<Super>s`), `screensaver` (`<Super>l`), `switch-input-source[-backward]` (`<Super>space`, `<Shift><Super>space`), `move-to-monitor-*` (`<Super><Shift>` arrows), the four `XF86Audio*` keys and the four brightness keys. The list is illustrative; the mechanism is dynamic.

## 14. D-Bus control — `org.i3shell.Control`

Object path `/org/i3shell/Control` on the session bus, owned while enabled.

- `Command(s: string) → (ok: boolean, message: string)` — parses and dispatches exactly like a binding.
- `GetTree() → string` — JSON of the full tree: rects, layouts, percents, focus, window ids / titles / wm-classes.
- `GetWindows() → string` — JSON of every managed window with its id, tiled/floating state, workspace, and real frame rect.
- `GetConfigStatus() → string` — JSON: config path, load time, diagnostics.
- Signal `TreeChanged()` after each commit.

Usage: `gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control --method org.i3shell.Control.Command "workspace number 3"`. This is the `i3-msg` equivalent and the integration-test driver. Builds made with `--test` additionally export `org.i3shell.Debug` (`SimulateSessionMode(mode)`, `Relayout()`) for the harness; release builds do not.

## 15. Error handling

- Parser, resolver and command parser never throw; they return diagnostics `{line, severity: 'error' | 'warning', message}`.
- Config load: any error → reject the file, keep the last good config (or the built-in fallback on first load); notification "i3-shell: config rejected (line N: …)". Warnings → one aggregated notification plus individual log lines.
- Runtime: every Layer 1 callback and every D-Bus method body is wrapped by `guard()`: it catches, logs `console.error` with a stack, and returns. Nothing propagates into a Shell signal handler. A command that fails validation throws *before* any mutation; mutations are small and total, and `commit()` runs `normalize()` first, so the tree is always valid at the next commit.
- Accelerator grab failure → warning listing the combo.
- Logging: `console.log` / `warn` / `error` with the prefix `[i3-shell]`; readable via `journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell`.

## 16. Testing

### 16.1 Unit — vitest on Node (`npm test`)

- Parser golden test: the reference config parses with zero errors and no warnings other than its known tier-2 lines, into an expected binding table (all 76 `bindsym`s, both modes, all variables resolved, all colours).
- Resolver: keysym mapping table; substitution order; criteria parsing.
- Command parser: every row of §6.7, chaining, error cases.
- Tree property tests (fast-check): random sequences of insert / remove / split / layout / move / focus / resize on trees of up to 12 leaves keep `Tree.check()` true. Run `layout()` at 1920×1080 and check each non-empty container's direct children: `splith` / `splitv` children cover the parent exactly with no gaps or overlaps; `tabbed` / `stacked` children each equal the parent's rect in Phase 2. Do not assert global non-overlap across leaves in tabbed or stacked subtrees.
- Layout exact-rect tests: hand-written trees → exact integer rects.
- Geometry adapter/engine tests: matching notifications cause no retry; repeated mismatches cause at most one corrective re-apply per expected-rect generation; stubborn clients retry when the expected rect changes. Each of the four lifecycle invalidations in §8.4 item 2 forces application even for an unchanged rect; workspace changes use the normal diff.
- Focus and move scenario tests: the worked examples of §7.6–7.7 plus edge and wrap cases. Where a semantic is disputed, real i3 (still installed) under Xvfb is the oracle.
- `tsc --noEmit` type-checks all layers; an additional check fails the build if `gi://` appears anywhere in Layer 0's import graph.

### 16.2 Integration — nested shell (`npm run test:integration`)

- Harness: `dbus-run-session -- gnome-shell --headless --wayland --virtual-monitor 1920x1080` with `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` pointing at a temp dir containing the built extension, a dconf keyfile with `enabled-extensions=['i3-shell@troja']`, and a test i3 config. It never touches the live session.
- Test windows: a small GJS/GTK4 program that opens a titled window and stays alive, spawned by the harness with distinct titles. Its fixture kinds must cover the states a window can already be in when the shell first sees it, not only the plain case: classification happens once, at the first frame, so fixtures that are **mapped maximized** and **mapped fullscreen** are the only way to exercise it. Every fixture mapping in the plain state is what let §8.2's defect through a passing suite.
- Assertions through `org.i3shell.Control`: `GetTree()` rects equal the expected rects, and `GetWindows()` frame rects equal the tree rects.
- Scenarios: A8–A14 from §3, adoption of a window that is mapped maximized and of one that is mapped fullscreen (§8.2), lock/unlock (`org.i3shell.Debug.SimulateSessionMode`), relayout, and a disable/enable cycle. With two virtual outputs, membership (A22–A24): the extension's own value for `workspaces-only-on-primary`, a window tiled on the secondary output that survives the round trip to the primary and back, and — with GNOME's default forced back on by hand — a window that Mutter really does mark `on_all_workspaces`, which must leave the tiling while **staying tracked** and rejoin it when the fact clears.
- The native-critical gate fails the run on any `Gjs` / `GLib` / `libmutter` / `GNOME Shell` CRITICAL in the shell log, with exactly one exception, filtered by exact text and always reported: Mutter 50.5 raises a window that is not yet in its stack when a client maps fullscreen (`meta_window_make_fullscreen_internal` → `meta_window_raise` → `meta_stack_raise` while `meta_window_wayland_is_stackable()` is still false). That happens before any first frame, so before this extension calls anything on the window, and the scenario asserts the complementary prediction — mapped alone it does not appear — so the exception is characterised rather than ignored. Remove the filter when Mutter fixes it.
- Run on demand; it takes on the order of 20 s and is not required for every commit.

### 16.3 Live session

Daily driving is the final test. Bugs found there are reproduced in 16.1 or 16.2 before they are fixed.

## 17. Phases and deliverables

Each phase gets its own implementation plan in `docs/superpowers/plans/` and is usable on its own.

**Phase 1 — Foundation (workspaces + shortcuts).** First task: a nested-shell smoke test confirming `grab_accelerator` + `accelerator-activated` and the window actor's `first-frame` behave as assumed on Mutter 18. Then Layer 0 `config/` and `commands/`; Layer 1 `keys`, `workspaces`, `settings`, `indicator`, `session`, `notify`, `control` (`Command`, `GetConfigStatus`); `engine` with the non-tree commands (`exec`, `kill`, `fullscreen`, `workspace`, `move container to workspace`, `mode`, `reload`, `restart`, `nop`). Tree commands and `floating` are accepted and log "not implemented in this phase". Toolchain, build, install symlink, unit tests, nested-shell harness skeleton. Acceptance: A1–A7.

**Phase 2 — Tree (dynamic tiling).** Layer 0 `tree/`; Layer 1 `windows`, `geometry`; engine `commit()`; all tree commands; floating; auto-floating; adoption; lock and monitor handling; `GetTree` / `GetWindows`; property tests; integration scenarios. Tabbed / stacked as same-rect-active-raised. Acceptance: A8–A14.

**Phase 3 — Layouts & appearance.** `decorations.ts`: borders with `client.*` colours, `default_border`, the `border` command, tab / stack bars with titles, the focused-container frame. Acceptance: borders and tab bars match the config colours; clicking a tab focuses it.

**Phase 4 — Fidelity.** `for_window` rules applied at first-frame (`floating enable`, `border`, `resize set`, `move position center`, `move container to workspace`); `workspace_auto_back_and_forth` / `back_and_forth`; urgent state in pills; multi-monitor (per-monitor focus / move across MonitorCons; `workspaces-only-on-primary` is owned from Phase 3B, see §9); `focus_follows_mouse` ↔ `org.gnome.desktop.wm.preferences focus-mode`. Marks and scratchpad stay outside v1.

Required monitor arrangements are laptop alone (`eDP-1`) and docked with external display(s), lid closed. Windows migrate off the internal display when it becomes inactive and return to the internal display on undock. The user's existing `~/Dev/i3-display-manager` and `~/Dev/i3-lid-sleep` document the expected transitions. Confirm scaling and exact resolutions with the user when Phase 4 planning begins; those details are not prerequisites for Phase 2.

## 18. Toolchain, build, install, dev loop

- `package.json`: TypeScript 5, `@girs/gnome-shell@50.x` (with its `@girs/*` peers for Meta 18 / Clutter 18 / St / Gio / GLib), esbuild, vitest, fast-check, eslint.
- `npm run build`: `tsc --noEmit`, then esbuild bundles `src/extension.ts` → `dist/extension.js` (ESM; `gi://` and `resource://` imports left external), copies `metadata.json` and `stylesheet.css`, and compiles `schemas/` with `glib-compile-schemas` into `dist/schemas/`.
- `make install`: symlink `~/.local/share/gnome-shell/extensions/i3-shell@troja` → `dist/`. `make pack`: zip for distribution.
- `metadata.json`: `uuid i3-shell@troja`, `shell-version ["50"]`, `session-modes ["user", "unlock-dialog"]`, `settings-schema org.gnome.shell.extensions.i3-shell`.
- GSettings schema keys: `config-path (s)`, `overridden-settings (s, JSON)`.
- Dev loop: unit tests continuously; nested shell for behaviour; log out / in to update the live session (Wayland cannot reload extension code in place — `gnome-extensions disable` / `enable` re-runs `disable()` / `enable()` on the old module).
- Git: `main` branch; spec and plans live in-repo; `.gitignore`: `node_modules/`, `dist/`, `*.zip`.

## 19. Decisions log

| Decision | Choice | Why |
|---|---|---|
| Build vs adopt the Forge fork | Build from scratch | User decision (2026-09-20); Forge upstream unmaintained, fork unpublished. Forge / Tiling Shell are references only. |
| Config source | Parse `~/.config/i3/config` | The existing file is already a complete specification; highest fidelity; `reload` works like i3. |
| Who owns workspaces and the bar | This extension; Space Bar and Tiling Shell disabled | Single source of truth; one accelerator mechanism; no double grabs. |
| Language | TypeScript + esbuild | `@girs/gnome-shell@50` turns Mutter API drift into compile errors (e.g. `maximize()` losing its flags in Mutter 18); the tree's invariants benefit from types. |
| Accelerators | `grab_accelerator` per binding | Bindings come from a text file, so they cannot be predeclared GSettings keys as `Main.wm.addKeybinding` requires. |
| Conflict handling | Dynamic enumeration; config wins; snapshot + restore | 32 real conflicts on this system, several unexpected (`<Super>h` minimize, `<Super>l` lock, `<Super>space` input source); a static list would rot. |
| Overlay key (Super tap → Activities) | Untouched | Not an i3 concept; harmless; press-and-hold combos are unaffected. |
| Maximized tiled window | Unmaximize and retile | i3 has no maximize; keeps the tree authoritative. State is read from `maximized-horizontally` / `-vertically`. |
| Minimized tiled window | Detach; re-insert as new on unminimize | i3 has no minimize; simplest consistent behaviour. |
| Fixed-size windows (minimum size == maximum size) | Float | They cannot fill a tile; i3 tiles them anyway, but the result there is a window that ignores its rect. The test is the `resizeable` property plus `get_min_size()` / `get_max_size()`, **not** `allows_resize()`: that is state-dependent (false while a window is maximized or fullscreen) and classification is cached for the window's lifetime, so it made every window that opens maximized float forever. `resizeable` is itself cleared while a window is fullscreen, so the hints decide on their own in that state — §8.2. |
| Fullscreen | Mutter native, tree slot kept | Compositor unredirection and app-initiated fullscreen keep working. This holds from the first frame: a window that is *mapped* fullscreen is adopted **tiled** and takes its tile when it leaves fullscreen. It needs saying because Mutter clears `has_resize_func` while a window is fullscreen, so the fixed-size test must not read that property on its own (§8.2). |
| Tabbed / stacked hidden children | Same rect, active raised | No unmap on Wayland; identical on screen; no state changes on the windows. |
| Floating stacking | Not forced above tiled | Mutter raises the focused window; forcing `above` would change user-visible window state. Revisit in Phase 4 if it grates. |
| Title bars | Not stripped | No API on Wayland; CSD headerbars are drawn by the app. |
| Level order | workspace → monitor → cons | GNOME workspaces span monitors; single-monitor behaviour identical to i3. |
| Session modes | `user` + `unlock-dialog`, ungrab on lock | Keeps the tree across locks without risking bare-key grabs on the password field. |
| Cosmetic directives (`font`, `bar {}`) | Accepted silently | A warning on every load would be noise for lines every real config contains. |
| `kill` on a container | Closes every window inside | i3 behaviour; the user asked for the tree to be real. |
