# Launcher design

**Status:** design approved in conversation 2026-09-24; this document is the binding authority for
the launcher. It extends `2026-09-20-i3-shell-design.md` (the "main spec"). Where they disagree,
this one wins for launcher subject matter.

**Baseline:** `main` at `ece2aaf`. 588 unit tests in 49 files, 254 integration assertions; Phases 1,
2, 3A and 3B merged; the Phase 2 and Phase 3A acceptance walks passed, and Phase 3B's is
outstanding at the time of writing.

## 1. Brief

**The problem.** The user binds `$mod+d` to a launcher. On a two-monitor setup the launcher must
appear where they are working. ArcMenu, the current stand-in, cannot do this: `menuController.js`
consults `hotkey-open-primary-monitor` only when more than one ArcMenu controller exists — that is,
only with "Display on all monitors" enabled — and otherwise calls `this._menuButton.toggleMenu()`,
opening a popup anchored to the single button on the primary panel. GNOME draws a panel only on the
primary monitor, so enabling that option does not help. ArcMenu's standalone Runner is the one
layout that computes its own placement (`menulayouts/runner.js:226`), but it resolves the monitor
through `Main.layoutManager.currentMonitor`, which is `global.display.get_current_monitor()` — the
monitor holding the **pointer**. For a keyboard-driven workflow the pointer is routinely on the
other screen.

**Why not an external launcher.** `wofi`, `fuzzel`, `tofi`, `rofi-wayland` and `bemenu`'s Wayland
backend all require the `wlr-layer-shell` protocol. The user's `/usr/lib64/libmutter-18.so.0.0.0`
contains `xdg_wm_base` and `gtk_shell1` and **zero** occurrences of `zwlr_layer_shell_v1` or
`ext_layer_shell_v1`; Mutter has never implemented layer-shell. None of that family can run here.
`/usr/bin/dmenu` exists but is an X11 client reached through XWayland, and no external Wayland
client can position itself on a chosen monitor in any case.

**The decision.** i3-shell draws the launcher itself. It already owns the monitor topology, the
container tree and therefore the **focused** monitor — not the pointer's monitor — so correct
placement is a property of the design rather than a heuristic.

## 2. Invocation

### 2.1 The command

A new command, `launcher [--term <command>]`, bound from the i3 config:

```
bindsym $mod+d launcher --term $term
```

`src/config/variables.ts` substitutes `set` variables textually before the parser runs, so a config
with `set $term kitty` yields `launcher --term kitty`. The variable table is discarded after
substitution and is deliberately not plumbed into `Config`; the binding line carries the terminal.

`launcher` is **not an i3 command**. Real i3 would reject that line. This is an accepted divergence,
recorded here so no later reader mistakes it for an oversight. The alternative — recognising
`exec dmenu_run` and quietly substituting our own launcher — was rejected: a config line that says
it runs dmenu and does not is worse than one i3 refuses outright.

`--term` is optional. Without it, the launcher still opens and `Enter` still works; only the
run-in-terminal action is unavailable (§4.3).

### 2.2 Placement

The launcher opens on the monitor holding the **focused container**, read from i3-shell's own tree.
Resolution order:

1. if the active workspace's selection is a floating window, that window's monitor;
2. otherwise the monitor whose root contains the workspace's `focusedCon`. `WorkspaceCon.focusedCon`
   is initialised to a monitor root when the workspace is built (`src/tree/tree.ts:66`) and repaired
   when containers are removed, so it names a monitor even on an empty workspace — there is no
   "no focus yet" case to fall back from;
3. if the engine is not ready at all (no topology), the launcher does not open and logs a warning.

`Main.layoutManager.currentMonitor` must not be used. It is the pointer's monitor, and using it is
precisely the defect this feature exists to avoid.

The box is centred horizontally on that monitor's **work area** and anchored near its top, so it
sits below i3-shell's own bar rather than beneath it. The engine resolves the monitor and passes its
work area in the request; the adapter draws where it is told and makes no placement decision.

### 2.3 Lifecycle

- `$mod+d` while the launcher is open closes it.
- `Escape` closes it. Losing focus closes it.
- On close, keyboard focus returns to the window that had it. Opening and dismissing the launcher
  leaves the tree byte-for-byte as it was: no commit, no relayout, no focus change.
- Only one launcher exists at a time.
- Opening does not change the current i3 mode; closing returns to it.
- While the session is locked, `launcher` is refused like every other command.

### 2.4 Input while open

The launcher takes a modal grab. i3-shell's own accelerators do not fire while it is up: `$mod+1`
will not switch workspaces mid-search, and a bare letter binding will not fire while that letter is
being typed into the entry. This matches dmenu, which grabs the keyboard outright.

If the grab is refused — the overview is open, or another modal owns input — the launcher does not
open. It logs a warning and leaves no actor behind. A half-opened launcher holding the keyboard is
the worst available outcome and the code is written to make it unreachable.

## 3. The catalogue

### 3.1 Sources

**Desktop applications** come from `Shell.AppSystem`, used as GNOME's already-monitored cache of
`Gio.DesktopAppInfo` — its list and its `installed-changed` signal, **not** its search provider.
This yields display name, `GenericName`, `Keywords`, icon and correct launching, and it covers
Flatpak automatically: the user's `XDG_DATA_DIRS` includes both Flatpak export roots, which hold 34
exported `.desktop` files, and an exported entry launches through its own `flatpak run` line.

Entries are filtered by `should_show()`, so `NoDisplay` and `OnlyShowIn` are honoured.

**`$PATH` binaries** come from our own scan: executable regular files and symlinks to them, taken
directory by directory in `$PATH` order, first occurrence winning on a name clash — the same
resolution the shell performs.

### 3.2 Scan cost and cache

The first `$PATH` scan happens at extension enable, off the path that opens the launcher. On each
open, the launcher `stat`s each `$PATH` directory and reuses the cache unless a directory's mtime
changed. That is a handful of syscalls. On Fedora Silverblue `/usr/bin` changes only on rebase, so
in practice the scan never repeats within a session.

A `$PATH` directory that cannot be read is skipped, with one warning, and does not abort the scan.

### 3.3 Dedup

Dedup is keyed on the **lowercased display name**, with the application winning. The `firefox`
binary is suppressed behind the `Firefox` application, so the user gets the icon and the correct
launch path. Where the names genuinely differ — `gimp` against *GNU Image Manipulation Program* —
both entries survive, because either is a reasonable thing to type.

Dedup must **not** be done by parsing `Exec=`. A Flatpak's exported `Exec` is
`/usr/bin/flatpak run …`, so an `Exec`-basename rule would hide the real `flatpak` binary.

## 4. Matching, ranking and actions

### 4.1 Ranking

Matching is case-insensitive. Tiers, best first:

1. the name equals the query;
2. the name starts with the query;
3. some word in the name starts with the query;
4. the name contains the query;
5. a `Keywords` or `GenericName` entry matches (applications only).

Ties break on: recency, then application before binary, then shorter name, then alphabetical.

**No fuzzy subsequence matching.** dmenu has none, prefix plus substring covers typing from memory,
and a poor fuzzy scorer ranks worse than no fuzzy scorer. It can be added later without disturbing
the tiers above.

### 4.2 Recency

A short list of recently launched item ids, most recent first, persisted in the extension's existing
GSettings schema. Its only job is to make `Firefox` outrank *Firewall Configuration* after one use.

### 4.3 Actions

- `Enter` launches the selected item bare.
- `Shift+Enter` launches it through `--term`, as `<term> -e <command>`. `-e` is assumed rather
  than probed: kitty, alacritty, foot, gnome-terminal and xterm all accept it. A terminal that
  does not will fail the launch and surface the notification of §6.3, which is the correct
  signal — i3's own `$term -e` idiom makes the same assumption.
- With **no match** and a non-empty query, `Enter` runs the typed text verbatim through the existing
  `exec` port, and `Shift+Enter` runs that text in the terminal. `dmenu_run` behaves this way and it
  is half of why the tool is useful; losing it would make the launcher strictly weaker than what it
  replaces.
- Without `--term` configured, the terminal actions warn once in the log and do nothing.

### 4.4 Keys

| Key | Action |
| --- | --- |
| printable | append to the query |
| `Up` / `Ctrl+p` | previous item |
| `Down` / `Ctrl+n` | next item |
| `Tab` | complete the entry to the selected item's name |
| `Enter` | accept |
| `Shift+Enter` | accept in terminal |
| `Escape`, `$mod+d` | dismiss |

An **empty query lists everything**, recency first, so `$mod+d` with no typing is a browsable list
rather than a blank box.

The mouse works: a click on a row launches it, and the list scrolls. Rows are reactive only while
the launcher is open, and the actor is destroyed on close. This is called out because Phase 3A
shipped reactive tab rows that silently swallowed clicks meant for windows.

## 5. Rendering

An `St.BoxLayout` holding an `St.Entry` and a scrolling list of rows, added to
`Main.layoutManager.uiGroup` under a modal grab — not `Main.layoutManager.addChrome` with struts.
The launcher is transient and must never resize the tiling.

Row height comes from the existing theme measurement in `src/shell/rowHeight.ts`, the same one the
tab rows use, so it follows the font and the scale factor rather than a hardcoded pixel count. Width
is a clamped fraction of the target monitor's work area, so the box reads the same on a 1728-wide
panel and a 1920-wide external display.

Colours come from `effectiveColors()`. The selected row carries the GNOME accent, exactly as the
active workspace pill and the focused window border do, so the three never disagree. New
`.i3-shell-launcher*` classes join the existing ones in `stylesheet.css`.

Application icons come from `AppInfo`. Binaries get a generic icon. Icon size is tied to the
measured row height.

## 6. Architecture

### 6.1 Layer 0

A new `src/launcher/`, pure and free of `gi://`:

- `model.ts` — the item, source and request types.
- `catalogue.ts` — merge, dedup, `$PATH` ordering.
- `match.ts` — the tiers and tie-breaks of §4.1.
- `session.ts` — a reducer holding query text and selection. It takes abstract actions
  (`type`, `up`, `down`, `complete`, `accept`, `acceptInTerminal`, `dismiss`) and returns the next
  state plus the effect to run.

The reducer is the load-bearing boundary. The adapter's only jobs are translating Clutter key events
into those actions and drawing the state that comes back. Every behaviour in §4.3 and §4.4 is
therefore a Node unit test rather than something only a human at a keyboard can check.

### 6.2 Ports and adapters

`EnginePorts` gains `launcher: {open(request): void; close(): void}`. The engine handles
`{type: 'launcher'}` by resolving the monitor per §2.2 and passing that monitor's work area in the
request. The engine decides **where**; the adapter decides nothing.

`src/shell/launcher.ts` owns the actor, the modal grab and spawning. `src/shell/appCatalogue.ts`
owns `Shell.AppSystem` and the `$PATH` scan, and returns raw items.

### 6.3 Failure handling

- An unreadable `$PATH` directory: skipped, one warning, scan continues.
- A failed launch: user notification and a log line.
- A refused modal grab: no open, one warning, no stray actor.
- Close always releases the grab — including on session lock and on extension disable, both of which
  close the launcher first.

## 7. Testing

**Unit.** The catalogue merge, including the Flatpak `Exec=` wrapper case and `$PATH` ordering;
every ranking tier and every tie-break; the reducer's whole key map, including `Enter` on a query
with no match; `launcher --term` parsing with and without the flag; and the engine resolving the
focused container's monitor rather than the primary, through fake ports.

**Native.** In the nested harness with a second virtual monitor: put focus on the non-primary
monitor, open the launcher, and assert its rect falls inside **that** monitor's work area. This is
the exact defect the feature exists to fix, so it is pinned against a real compositor rather than a
fake. Also asserted there: i3-shell's bindings do not fire while the launcher is open; closing
restores focus to the previously focused window; the grab is released; and the run produces no
native criticals.

This needs one new `org.i3shell.Debug` method reporting the launcher's rect and current selection.
It is test-build only, and the existing release-build gate already asserts that surface is absent.

## 8. Acceptance criteria

- **A28.** `bindsym $mod+d launcher --term $term` in the i3 config opens the launcher; the config
  loads with no errors and no warnings.
- **A29.** With focus on the external display, the launcher opens on the external display — with
  the pointer parked on the laptop panel.
- **A30.** With focus on the laptop panel, the launcher opens on the laptop panel — with the
  pointer parked on the external display.
- **A31.** Typing `fire` selects Firefox; `Enter` launches it; the launcher closes.
- **A32.** Typing `steam` finds the Flatpak-installed Steam and launches it.
- **A33.** Typing `htop` and pressing `Shift+Enter` opens htop inside kitty.
- **A34.** Typing a command that matches nothing and pressing `Enter` runs it.
- **A35.** `$mod+1` pressed while the launcher is open does not switch workspace.
- **A36.** `Escape` closes the launcher and returns focus to the window that had it, with the
  tiling unchanged.
- **A37.** Opening the launcher does not resize or reflow any tiled window.
