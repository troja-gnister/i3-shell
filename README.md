# i3-shell

The i3 experience in GNOME 50. Your real `~/.config/i3/config` is the only source of truth: it drives
the keybindings, the workspaces, the container-tree tiling, the colours and the launcher. There is no
settings UI and nothing to configure twice — edit the file i3 would read and press `$mod+Shift+c`.

This is a from-scratch i3 clone as a GNOME Shell extension, not a tiling helper. Windows live in a real
i3 container tree with splits, tabbed and stacked containers, floating windows, directional focus and
move, resize mode, `for_window` rules, urgent pills, a dmenu-style launcher drawn in-process, and — as
of Phase 5 — **per-output workspaces**: each display owns its workspaces and shows exactly one of them,
as in i3 and sway.

**Start with [PROJECT.md](PROJECT.md)** if you intend to work on it; this file is for running it.

**Status:** Phases 1, 2A, 2B, 3A and 3B are on `main`. The launcher and Phase 4's rules/urgent pills are
implemented; **Phase 5 — per-output workspaces — is implemented on the `phase-5` branch** and awaits its
live walk: [docs/acceptance/phase-5.md](docs/acceptance/phase-5.md), A50–A66, deliberately unticked,
because a second physical display, a real pointer and a real unplug are the only evidence for most of it.
Verification at the time of writing: **1160 unit tests in 71 files**, both TypeScript programs, the
Layer 0 import gate, the tree lint, and the private nested integration suite under `test/integration/` —
**637 assertions, exit 0, zero `LIMITATION` branches**, its first full green run for Phase 5 (2026-10-01,
at `863a8ec`), covering real output removal and restore rather than skipping those branches.

---

## What it deliberately does not do

**Not implemented in v1** (a config line for one of these loads fine and is skipped with a warning in
the journal — i3-shell never rejects your config over an unimplemented feature):

`bindcode`; `bindsym --release`; marks; the scratchpad; `assign`; gaps; i3bar `status_command` and
`bar {}` blocks; top-level autostart `exec` / `exec_always`; layout persistence across shell restarts;
`resize set` on tiled containers; `next_on_output` / `prev_on_output`; stripping application title bars
(impossible on Wayland — `Meta.Window` has no `set_decorated`).

**Three deliberate divergences from i3**, recorded rather than hidden:

1. **A fixed set of workspaces.** i3 creates a workspace on first visit and destroys it when it empties.
   i3-shell keeps the fixed set your config names (`N` = the highest `workspace number` it references;
   10 for a typical config), clamped up to at least one workspace per attached display. For a config that
   names and binds every workspace the behaviour is identical.
2. **All *N* pills are shown**, split between the displays by which output owns each workspace. i3 hides a
   workspace it has never visited, so its output is unobservable there; here every workspace always
   belongs to exactly one display's bar.
3. **GNOME's overview shows the attic.** While the extension runs GNOME has exactly two workspaces: one
   *live* and one *attic* holding the windows of every i3 workspace no display is currently showing.
   Mutter refuses to render a non-active workspace, which is precisely what makes it a safe hiding place
   — a parked window is genuinely unmapped, takes no keyboard input and is in no window list — but
   GNOME's own overview still shows that second workspace and the windows in it.

## Requirements

- **GNOME Shell 50 on Wayland** (developed against 50.5 / Mutter 18, Fedora Silverblue 44). X11 is not
  supported; GNOME dropped it in 49.
- A `~/.config/i3/config`. i3 itself does not need to be installed.
- To build: `node` and `npm`, `glib-compile-schemas`, `make`.
- To run the private integration harness as well: GNOME Shell, `dbus-run-session`, `gdbus`, `rg`, Python
  with Gio/GLib, and GJS with GTK4.

## Install from source

```sh
git clone https://github.com/troja-gnister/i3-shell.git
cd i3-shell
npm install            # or `npm ci`; .npmrc sets legacy-peer-deps, which npm needs for @girs
npm run build          # typecheck + Layer 0 gate + esbuild bundle + compiled schemas -> dist/
make install           # symlinks dist/ into ~/.local/share/gnome-shell/extensions/i3-shell@troja
```

`make install` runs `npm run build` itself, so the explicit build is only useful when you want to see the
bundle succeed on its own.

**Now log out and back in.** Wayland cannot reload extension code in place: `gnome-extensions
disable`/`enable` re-runs `disable()`/`enable()` on the module the session already loaded, so it cannot
give you new code. Then:

```sh
gnome-extensions enable i3-shell@troja
```

The install is a **symlink** to `dist/` in this working tree, which matters: any later `npm run build`
changes what your next login loads.

### Pointing it at a different config

```sh
GSETTINGS_SCHEMA_DIR=~/.local/share/gnome-shell/extensions/i3-shell@troja/schemas \
  gsettings set org.gnome.shell.extensions.i3-shell config-path /path/to/config
```

`$mod+Shift+c` reloads: bindings are diffed (removed ones ungrabbed, new ones grabbed), colours and
options updated, and the tree is kept. A config with an error is **rejected** — the previous config keeps
running and a notification says so. A last-good copy is cached in
`$XDG_CACHE_HOME/i3-shell/last-good.config` and used if the file is missing at startup.

`examples/i3-shell.config` is a working example of the subset that is understood.

## What changes about your desktop

i3-shell takes over a small number of GNOME settings while it is enabled. Every original value is saved
first into the extension's own `overridden-settings` key (JSON, the mechanism Tiling Shell uses) and
restored by `disable()`; if the shell dies without running `disable()`, the snapshot survives and the
values are restored at the next opportunity.

| Setting | While enabled | Why |
|---|---|---|
| `org.gnome.desktop.wm.preferences num-workspaces` | `2` | One *live* workspace plus the *attic*. GNOME no longer represents i3's workspaces at all; `N` is i3-shell's own notion |
| `org.gnome.mutter dynamic-workspaces` | `false` | A fixed set, as in i3 |
| `org.gnome.desktop.wm.preferences focus-mode` | `sloppy`, or `click` for `focus_follows_mouse no` | `sloppy` *is* i3's focus-follows-mouse, and i3's default is `yes` |
| `org.gnome.shell.app-switcher current-workspace-only` | `true` | Otherwise alt-tab lists parked windows — the ones you deliberately cannot see |
| `org.gnome.mutter workspaces-only-on-primary` | `false` | While it is `true` Mutter marks every window on a secondary display "on all workspaces", and such a window cannot be tiled or parked at all |
| `org.gnome.desktop.wm.keybindings switch-to-workspace-*` | cleared | GNOME's own workspace switching must never reach the attic, where every parked window would appear at once and every visible one vanish |
| `org.gnome.desktop.wm.preferences workspace-names` | **not applied** (restored only) | GNOME's two workspaces name nothing you see. A value written by an older build is still restored |
| `org.gnome.desktop.wm.preferences mouse-button-modifier` | your `floating_modifier` | Only when it differs from the current value |
| every GNOME/IBus accelerator that collides with your config | cleared | The config wins, by design. 32 collide with a typical config (`<Super>1…9`, `<Super>h`, `<Super>l`, `<Super>space`, the `XF86Audio*` keys, …), plus the two named IBus hotkeys |

`disable()` puts all of it back. Nothing else on your desktop is touched, and no window is moved on
disable — windows stay where they are.

There is one consequence worth stating plainly: **a touchpad workspace gesture has no GSetting to
clear.** If something outside i3-shell does switch GNOME's active workspace, a guard switches it straight
back and logs a warning; you may see a flash.

## Per-output workspaces in practice

- **At startup** each attached display gets one workspace: the **primary** shows workspace I, the next
  display shows II, and so on. Outputs are ordered primary-first deliberately — "primary is workspace
  one" is the behaviour people mean.
- **`$mod+N` follows a workspace to its display.** If workspace N is already showing somewhere, the
  keyboard (and the pointer) move to *that* display and no window changes workspace. If it is not showing
  anywhere, it is shown on a display chosen in this order:
  1. **Occupied** — a workspace that holds windows stays on the display it is on. A number key never
     drags your windows to another screen.
  2. **A config pin** — `workspace N output <connector>` wins for an empty workspace, on every switch and
     not only at birth, so a pin survives a `$mod+N` pressed from another display.
  3. **Memory** — where an unplug found the workspace. (This tier cannot currently be reached: a replug
     re-homes the workspace and clears the memory, so there is never a surviving entry by the time a
     switch happens. It is documented as such in the code.)
  4. **The display you are looking at** — an empty, unpinned workspace materialises where you are.

  Whatever that display was showing is parked in the attic; the *other* display does not change at all.
- **`$mod+N` on the workspace you are already on is not a no-op.** It re-asserts keyboard focus on that
  workspace's selected window. That is the recovery path when focus has drifted.
- **`$mod+N` moves your mouse when the switch crosses displays.** This is i3's own default
  (`mouse_warping output`): without it, focus-follows-mouse would immediately hand the focused display
  back to whatever sits under the stationary pointer and undo the switch. Put `mouse_warping none` in your
  config if you do not want it. `mouse_warping container` is accepted, treated as `output`, and warned
  about once.
- **Focusing a window on another display moves the focused display**, so the next workspace-scoped
  command (`$mod+Shift+N`, `$mod+N`, `$mod+d`) acts where you are rather than where you were.
- **Moving the pointer onto any display claims it**, including a display showing an empty workspace,
  which is the case no window-based approach can reach. `focus_follows_mouse no` makes pointer motion
  inert, in both halves.
- **Pinning a workspace to a display**, i3's own directive:

  ```
  workspace 3 output DP-1
  # i3's list form: the first attached one wins. `primary` is a valid name.
  workspace 4 output HDMI-1 HDMI-2 primary
  ```

  Note that only **whole-line** `#` comments are supported, as in i3 — a trailing comment on a directive
  would be read as part of the directive.

  A name matching no attached connector is a warning on that line, not an error — a config written for
  another machine must still load.
- **Unplugging a display preserves the layout.** Its workspaces are reassigned to the primary with their
  container trees untouched and parked, not flattened into the primary's tiling, and where they came from
  is remembered so a replug puts them back. **First displacement wins**: a workspace bounced across
  several displays remembers its true home rather than the last refuge. A deliberate `move workspace to
  output` **clears** that memory — a command beats a memory.
- **Each display has its own bar.** The GNOME panel carries the primary's pills; every other display gets
  an i3-shell bar with its own. i3bar's distinction between a *focused* workspace and one merely *visible*
  on another display is drawn, with precedence focused → urgent → visible → occupied.

### Bindings worth adding

i3 ships no default bindings for the output commands, so add them yourself. Copy-pasteable:

```
# Move the keyboard to another display. Works even when that display is empty.
bindsym $mod+Ctrl+Left   focus output left
bindsym $mod+Ctrl+Right  focus output right
bindsym $mod+Ctrl+Up     focus output up
bindsym $mod+Ctrl+Down   focus output down

# Send the whole workspace to another display; focus follows it.
bindsym $mod+Ctrl+comma  move workspace to output left
bindsym $mod+Ctrl+period move workspace to output right

# Send one window to another display; focus deliberately does NOT follow.
# `primary` is the one that rescues a window from a display you cannot see.
bindsym $mod+Ctrl+p      move container to output primary
bindsym $mod+Ctrl+Shift+Right move container to output right
```

All three commands take i3's argument form: `left | right | up | down | primary | <connector name…>`.
A direction with no overlapping display beyond that edge is a no-op, never a wrap — displays are physical.

Directional `focus` and `move` (`$mod+j/k/l/semicolon` and their `Shift` forms) already cross the display
edge on their own: at the edge of a workspace's root they enter the neighbouring display's visible
workspace at the **entering** edge. Wrapping applies only when there is no neighbour.

## Tiling, keys and the launcher

Windows tile into an i3 container tree: the second window on a workspace splits it horizontally,
`$mod+h`/`$mod+v` decide where the next one lands, `$mod+j/k/l/semicolon` (and the arrows) move focus,
`$mod+Shift+…` moves windows between and out of nested containers, `$mod+a` selects the parent container
so a move or `$mod+e` acts on the whole subtree, and `$mod+r` enters resize mode. Dialogs, modal dialogs,
utility and fixed-size windows float automatically; `$mod+Shift+space` floats a tiled window and
`$mod+space` toggles focus between the tiled and floating groups. Tabbed and stacked containers give
every child the parent's rectangle and raise the focused subtree, with title bars drawn above them.
Borders use your `client.*` colours, including `client.urgent`. `for_window` rules are applied at a
window's first frame.

`bindsym $mod+d launcher --term $term` opens a dmenu-style launcher drawn in-process, on the display that
currently has focus — including a display showing nothing at all. Typing narrows a merged list of
installed applications (`Shell.AppSystem`, Flatpak included) and `$PATH` binaries; `Enter` launches,
`Shift+Enter` runs it inside `--term`, and a query matching nothing runs the typed text verbatim the way
`dmenu_run` does. `Tab` completes, `Ctrl+n`/`Ctrl+p` and `Up`/`Down` move the selection, `Escape` or the
opening binding again closes it. `--term` is optional.

## Touchpad swipes

`bindgesture` is **not an i3 directive** — i3 has no gesture syntax at all, so this borrows sway's, the
way the `launcher` command is this project's own addition. Only the two horizontal three-finger swipes are
recognised:

```
bindgesture swipe:left workspace next
bindgesture swipe:right workspace prev
```

Those two lines are the suggested default, not a built-in: swiping left runs whatever `swipe:left` is
bound to, so the direction follows GNOME's content-follows-fingers convention only because that config
says so. Swap the two commands to invert it, or bind something else entirely. With no `bindgesture` line
a swipe does nothing, which is not an error.

`workspace next` / `workspace prev` are i3's own: they cycle through the workspaces that **exist** —
occupied, or on screen on some display — in ascending order, and wrap at both ends. With 1, 2 and 3 open,
a left swipe from 3 lands on 1; they never walk onto an empty workspace nobody opened.

A three-finger horizontal swipe is **claimed outright**, so GNOME's own workspace swipe does not also run
on it — with this extension enabled GNOME has only two workspaces and its swipe would animate toward the
one holding parked windows. Everything else is left alone: four-finger gestures, GNOME's vertical
three-finger swipe to the overview, and every other event on the system still reach GNOME untouched.
Within a horizontal three-finger swipe, a direction is only *reported* when the travel exceeds 100 px and
is further horizontally than vertically — but the gesture is claimed either way, so a hesitant swipe does
nothing rather than falling through to GNOME. A gesture name other than `swipe:left` or `swipe:right` is a config
error, so a typo tells you rather than leaving a swipe that silently does nothing.

**Known conflict: IBus.** IBus registers accelerators through the same mechanism, and two are claimed
outright — `<Super>semicolon` (emoji picker) and `<Super>space` (input source). Those two are cleared by
name. Beyond them, measurement shows that **with IBus running a varying subset of i3-shell's other
accelerators can also fail to arrive**, differing between sessions, even though the grab succeeded; with
IBus absent every probed accelerator worked every time. If a binding silently does nothing, suspect this
first.

## Control it like i3-msg

```sh
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "workspace number 3"
```

Any i3 command the parser understands works, which makes this the way to try a command before binding a
key to it. The other methods:

| Method | Returns |
|---|---|
| `GetState` | mode, active workspace, workspace count, `grabbed` accelerator count, config source/path, error and warning counts, the pill list, `focusedOutput`, GNOME's `actionMode` and `ready` |
| `GetTree` | the committed container snapshot (version 2): per workspace its `index`, its `output`, its work area, its selection, its floating list and its one root, with every split's layout, percentages and focused child; plus the top-level `visible` list of what each output shows |
| `GetWindows` | one entry per tracked window: the **native Mutter frame** (`rect`), the engine's target (`expectedRect`), the reconciliation `generation`, a `stubborn` flag for clients that refuse their tile, `state` (`tiled`/`floating`/`minimized`) and the **native** `workspace` |
| `GetConfigStatus` | the last load's source, path and diagnostics |
| `TreeChanged` | a signal, emitted on every committed change |

If another program already owns `org.i3shell.Control`, i3-shell logs one warning, notifies you once and
withdraws its control interface — **tiling and keybindings keep working**; only this D-Bus surface is
unavailable until you disable and re-enable the extension. Any process on your session bus can call this
interface, the same exposure as i3's IPC socket; a Flatpak app granted `--socket=session-bus` can reach it
too.

## Troubleshooting

### Read the journal first

```sh
journalctl --user -b | grep i3-shell                 # this boot, everything
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell   # follow it live
```

Every line the extension writes is prefixed `[i3-shell]`. What the common ones mean:

| Message | Meaning |
|---|---|
| `cleared conflicting binding <schema> <key> = <accel>` | Normal, once per collision at enable. Your config won that accelerator |
| `line N: no attached output matches <names>; workspace M uses the default` | A `workspace M output …` pin naming a connector that is not attached. Harmless; the workspace falls back to the default assignment |
| `mouse_warping container: … treating it as output` | Normal for that config value |
| `active workspace left live; switching back` | Something outside i3-shell moved GNOME's active workspace — almost always a touchpad workspace gesture. The guard put it back. A storm of these is a defect; one or two around a gesture is the guard working |
| `could not park window N; leaving it on screen` / `could not show window N; leaving it parked` | Mutter refused a workspace move. The tree says one thing and the screen another; switching workspaces again normally resolves it. Worth reporting with the surrounding lines |
| `pill click: no workspace at position N on output M` | A pill was clicked before the extension had resolved that display. Click again |
| `could not grab <combo> (<accel>): another client holds it` | Another client holds that accelerator; i3-shell retries on a short backoff, so one at enable is ordinary and a persistent one is not. Suspect IBus first (above) |

### Ask the running extension what it thinks

```sh
# the one-screen summary
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetState

# which workspace is on which output, and what each root looks like
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetTree

# where Mutter actually put each window, versus where the tree wants it
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetWindows

# run any i3 command directly — the fastest way to test a theory
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "focus output primary"
```

Four things about those payloads that have cost real diagnostic time:

- **`GetTree`'s workspace `index` is an i3 workspace. `GetWindows`'s `workspace` field is the *native*
  GNOME one** — `0` for *live*, `1` for the *attic*. They are different coordinate systems and they look
  alike. If you want to know which i3 workspace a window is on, find its id in `GetTree`.
- **Comparing `rect` with `expectedRect` in `GetWindows`** is the quickest way to see whether a window is
  where the tree says it should be. A persistent mismatch plus `stubborn: true` means the client is
  refusing its tile.
- **A window excluded from the tree is still listed by `GetWindows`** — it is tracked — but it appears
  **nowhere in `GetTree`** and has no `expectedRect`. Minimized, "always on visible workspace" (sticky) and
  skip-taskbar windows are excluded by design; that is not a lost window.
- **A locked session reports `grabbed: 0` and `ready: false`.** That is correct: locking ungrabs every
  binding on purpose, so bare-key grabs can never reach a password field. It looks like a total failure
  and is not — unlock and the counts come back.

### The symptom that confuses everyone

**A window on a display that is powered off, asleep or unplugged is invisible but present.** Nothing has
been lost: it is in the tree, on a workspace belonging to a display that is not showing anything. Pull it
back:

```sh
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "move container to output primary"
```

If you cannot focus it to begin with, go to it first — `focus output <direction>` moves the keyboard to a
display even when it is showing nothing — or switch to its workspace with `$mod+N`, which brings the
workspace to the display you are looking at when nothing else is showing it. Bind
`$mod+Ctrl+p move container to output primary` and this becomes one key.

### Other things that look like failures

- **A binding does nothing after `make install`.** You did not log out. Wayland cannot reload extension
  code in place.
- **The extension is off after a login, with "i3-shell failed to load".** Check whether a build was
  running while you logged in: `dist/` is the symlink target of the installed extension, so a build in
  progress can hand GNOME a half-written `extension.js` and fail the extension outright. Rebuild and log
  in again.
- **Workspaces or windows jumped after you ran the integration suite.** `npm run test:integration`
  rebuilds `dist/`; it restores a release bundle on exit, but only `make install` refreshes the live
  symlink. Finish with `make install`.
- **A floating window you moved with a key landed somewhere you did not expect on the new display.**
  Its frame follows its workspace now, the way i3 does it: the size is kept and the centre keeps the same
  fraction of the work area it had on the display it left, so on a smaller display it lands nearer the
  middle than you may expect. One deliberate difference from i3: the position is clamped so the top-left
  corner stays inside the destination, which is what makes `move container to output primary` a usable
  rescue for a window stranded on a display you cannot see. A window wider or taller than the destination
  sits at its left or top edge, at its original size, and overhangs the far edge.
- **`$mod+N` opened the overview and took the keyboard.** A workspace switch that crosses displays warps
  the pointer (i3's `mouse_warping output` default). A warp out of the **top-left corner** trips GNOME's
  hot-corner pressure barrier. Either veto the warp with `mouse_warping none` in your config, or turn the
  corner off: `gsettings set org.gnome.desktop.interface enable-hot-corners false`. i3-shell deliberately
  does not change that setting for you.
- **GNOME's own workspace shortcuts do nothing.** They are cleared on purpose; see the settings table.
- **The overview shows windows you parked.** That is the attic, and it is how parking works.
- **The extension was removed without being disabled.** Reinstall the same UUID and schema, enable it so
  it can load the saved originals, then disable it to restore them. Do not clear `overridden-settings`
  first; failed restores keep their saved values for another attempt.

## Develop

```sh
npm test                      # unit suite: pure core + adapter doubles, on Node (1160 tests, 71 files)
npm run typecheck             # two programs: tsconfig.json (src + GNOME types), tsconfig.test.json (tests + Layer 0)
npm run check:layer0          # fails if Layer 0 imports gi:// / resource:// / src/shell
npm run lint:tree             # eslint over src/tree and its tests
npm run build                 # release bundle -> dist/
npm run build:test            # bundle with the org.i3shell.Debug test interface
npm run test:integration      # private nested suite; restores a release bundle on exit, even on failure
make install                  # release build + refresh the live symlink — always finish with this
```

**`dist/` is the symlink target of the installed extension.** Any build changes what your next login
loads, and a build that overlaps a login can fail the extension outright. Treat `npm run build`,
`npm run build:test`, `npm run test:integration` and `make install` as operations on the live session, not
on the working tree.

The fast loop is the nested shell rather than a logout:

```sh
bash test/integration/nested.sh --keep -- python3 test/integration/client.py smoke
```

`nested.sh [--visible] [--keep] [--disabled] [--monitor WxH ...] -- <command...>` runs a private GNOME
Shell with its own settings, runtime directory, Wayland socket and D-Bus; `--disabled` starts with the
extension off so a scenario can capture untouched GNOME originals. It differs from a real session in two
disclosed ways: `--no-x11` (Xwayland clients and visible mode are unverified) and IBus is suppressed (so
the conflict above is not covered). Release builds must never contain the `org.i3shell.Debug` surface.

**The suite fails a run when GNOME Shell logs a CRITICAL, and that gate is scanned in two scopes.** The
harness appends a marker to `shell.log` immediately before it signals gnome-shell, and criticals logged
*before* the marker still fail the run — so every mid-run `disable()` is covered, including the three
disable/enable cycles of the `--name-conflict` step. *After* the marker, where GNOME is tearing down its
own widgets, five named GNOME-owned messages are excused and reported as notes instead. One of them is
`Attempting to call back into JSAPI during the sweeping phase of GC`, which is **also the signature of an
actor this extension failed to destroy** — so the accepted cost is that a leaked actor finalised only
during the final session teardown will no longer fail a run, while a leak on any `disable()` still does.
The implementation and the full reasoning are in `test/integration/criticals.sh`; its self-test,
`test/integration/criticals-selftest.sh`, runs first in the suite and needs no GNOME session.

License: GPL-2.0-or-later.
