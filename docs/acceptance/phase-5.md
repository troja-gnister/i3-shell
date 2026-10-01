# Phase 5 acceptance — live session

**Product revision:** branch `phase-5`, Phase 5 Tasks 1–19 (per-output workspaces: each output owns its
workspaces and shows exactly one; `focusedOutput` as first-class state; GNOME pinned to two workspaces,
`live` + the `attic`; `workspace <n> output <name…>`, `focus_follows_mouse` and `mouse_warping`
implemented; `focus output`, `move container to output`, `move workspace to output` added; directional
`focus`/`move` crossing the display edge; hotplug reassignment with remembering; and the five-defect
bugfix round found on this hardware on 2026-09-30). Record the exact revision you built from —
`git rev-parse --short HEAD` — next to your result at the end. "It opened on the wrong display" is only
useful against a known build.
**Build under test:** release `make install` (no `org.i3shell.Debug` interface or methods).
**Environment:** GNOME Shell 50.5 / Mutter 18, Wayland, Fedora Silverblue 44. **Two outputs are
required for almost everything here.** A50–A66 are the per-output criteria; A61b needs one config edit.
**Date prepared:** 2026-10-01. **Result: not walked yet.**

Nothing in this repository ticks these boxes, and nobody has walked them. The unit suite at the end is
separate evidence and is listed only so the walk can concentrate on what no fake can reach: a second
real display, a real pointer, a real unplug, and a compositor that decides focus for itself.

---

## Read this before you start

**Six things change about your desktop, not only about i3-shell's own windows.**

| What changes | Why | Where it shows |
|---|---|---|
| GNOME has exactly **two** workspaces while the extension runs | Mutter refuses to render a non-active workspace, so the second one — the **attic** — is the hiding primitive for every i3 workspace no display is showing | **GNOME's overview shows the attic**, holding your hidden windows. A recorded divergence, not a defect: do not file it |
| **Sloppy focus** is on (`focus-mode = sloppy`) | i3's `focus_follows_mouse` default is `yes`, and your config does not override it | The window under the pointer takes focus; crossing empty desktop leaves focus where it was |
| **The pointer is warped** when a command moves focus to another display | i3's `mouse_warping` default is `output`. Without it, sloppy focus would hand the focused display straight back to the stationary pointer and undo the switch | `$mod+N` that crosses displays, `focus output`, `move workspace to output` and a directional `focus`/`move` that crosses all move your mouse. `mouse_warping none` in the config turns it off |
| GNOME's own **`switch-to-workspace-*`** bindings are cleared outright | One of them reaching the attic would show every parked window at once and hide every visible one | `Ctrl+Alt+Up/Down` and friends do nothing while the extension is enabled; `disable()` gives them back |
| **Alt-tab lists only the current workspace** (`current-workspace-only = true`) | Otherwise it lists parked windows, which are the ones you deliberately cannot see | Alt-tab is narrower than you may be used to |
| **`workspace-names` is no longer applied** | GNOME's two workspaces name nothing you see | If an earlier build wrote your workspace names into GNOME, `disable()` still puts your originals back |

**Two things are deliberately not here.** Neither is a failure of these boxes:

| Not here | Why |
|---|---|
| i3's dynamic workspace lifecycle — a workspace created on first visit and destroyed when it empties | i3-shell keeps the fixed set of *N* from the config, so **all *N* pills are shown**, split between the displays, where i3 hides a workspace it has never visited. Phase 5 design §2.5 |
| `next_on_output` / `prev_on_output` | `workspace next` / `workspace prev` stay in global numeric order. No known config binds the per-output forms |

**You will need to log out.** Wayland cannot reload extension code in place, so
`gnome-extensions disable`/`enable` on an old build does not give you the new one.

## How to run this walk

```sh
make install                      # release build + symlink
# log out and back in — Wayland cannot reload extension code in place
gnome-extensions enable i3-shell@troja
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell   # second terminal
```

The bindings this walk uses, as your config has them (`~/.config/i3/config`, DISPLAYS section):

```
bindsym $mod+Ctrl+Left   focus output left
bindsym $mod+Ctrl+Right  focus output right
bindsym $mod+Ctrl+Up     focus output up
bindsym $mod+Ctrl+Down   focus output down
bindsym $mod+Ctrl+comma  move workspace to output left
bindsym $mod+Ctrl+period move workspace to output right
```

`move container to output` is implemented but **not bound** in your config. Where a box needs it, run it
over D-Bus:

```sh
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "move container to output right"
```

To read the extension's own view of the world at any point:

```sh
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetState      # mode, active workspace, grabs, pills, focusedOutput
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetTree       # per workspace: its output, work area, root, selection
```

**`GetTree`'s workspace `index` is an i3 workspace. `GetWindows`'s `workspace` field is the *native*
GNOME one — 0 (`live`) or 1 (`attic`).** Confusing the two cost real diagnostic time during this phase.

Reading a GSetting is fine anywhere below. **Writing one is a defect for this phase**, except where a box
says otherwise.

---

## A50 — one workspace per output at startup, primary first

- [ ] With both displays attached, log in. The **primary** display shows workspace **I** and the other
      display shows workspace **II** — not the reverse, and not whichever display Mutter happens to
      enumerate first. (If you have ever wondered which one GNOME thinks is primary:
      `gnome-monitor-config list` or Settings → Displays.)
- [ ] The GNOME panel's pills are the **primary's** workspaces. The other display carries its own
      i3-shell bar showing **its** workspaces. No workspace appears on both bars.
- [ ] Every one of the ten workspaces appears on exactly one of the two bars, and the two lists
      together are 1…10 with nothing missing and nothing duplicated.
- [ ] `GetTree` agrees: each entry under `workspaces` names one `output`, and the top-level `visible`
      list has exactly one entry per attached display.
- [ ] Nothing in the journal warns about outputs, assignment or coverage at startup.

## A51 — `workspace N output <name>` places a workspace at birth

- [ ] Find your connector names (`HDMI-1`, `DP-1`, `eDP-1`, …):
      ```sh
      gdbus call --session --dest org.gnome.Mutter.DisplayConfig \
        --object-path /org/gnome/Mutter/DisplayConfig \
        --method org.gnome.Mutter.DisplayConfig.GetCurrentState
      ```
- [ ] Add `workspace 3 output <the non-primary connector>` to `~/.config/i3/config`, then `$mod+Shift+c`
      (reload). Nothing is rejected and no error notification appears.
- [ ] Log out and back in (a pin applies at a workspace's **birth**). Workspace **III** now belongs to
      that display: its pill is on that display's bar, and `$mod+3` shows it there.
- [ ] Change the line to `workspace 3 output NOSUCHOUTPUT` and reload. A **warning** appears in the
      journal naming the config line, workspace III falls back to the default assignment, and the
      config still loads — a config written for another machine must not be rejected.
- [ ] Remove the line again before continuing.

## A52 — `$mod+3` with III unplaced shows it where you are, and leaves the other display alone

- [ ] Remove any pin for III. Open a window on each display so you can see what moves.
- [ ] Stand on the primary (click one of its windows) and press `$mod+3`. Workspace III appears on the
      **primary**; what the primary was showing is gone from the screen (it is parked, not closed).
- [ ] **The other display does not change at all** — same workspace, same windows, same geometry, no
      flicker.
- [ ] `$mod+1` brings the primary's first workspace back with its windows in the same layout, same
      sizes, same focused window.
- [ ] Now stand on the **other** display and press `$mod+4`. Workspace IV materialises **there**, and
      the primary does not change. An empty unplaced workspace follows you; it does not drag you to it.

## A53 — `$mod+2` with II visible elsewhere moves focus, not windows

- [ ] With workspace I on the primary and II on the other display, stand on the primary and press
      `$mod+2`. **Focus moves to the other display** — type, and the characters land in the window
      there.
- [ ] No window changed display or workspace: both displays show exactly what they showed before.
- [ ] Your **pointer** followed, landing on the newly focused window (that is `mouse_warping output`).
- [ ] The pills agree: II is drawn *focused* on its bar and I is drawn *visible but not focused* on the
      primary's — two visibly different styles, which i3bar also distinguishes and earlier builds did
      not.
- [ ] Press `$mod+2` again while II is already focused. Nothing moves, and focus is **re-asserted** on
      that workspace's selection — this is the recovery path if focus has drifted, so it must not be a
      silent no-op.

## A54 — a parked window is really hidden

- [ ] Open a window on workspace I of the primary, then `$mod+3` to park it.
- [ ] It is not drawn anywhere on either display, not even as a sliver at an edge.
- [ ] `Alt+Tab` does not list it.
- [ ] Type: nothing reaches it. `$mod+1`, then type: the characters arrive.
- [ ] In GNOME's overview you **do** see it, on the second GNOME workspace — that is the attic, and it
      is the documented divergence at the top of this file. Note it, do not file it.
- [ ] `GetWindows` still lists it, with its native `workspace` field reading **1**.

## A55 — after a switch, focus is right *and* no other workspace's selection moved

- [ ] On the primary's workspace I open three windows and focus the **middle** one. On the other
      display's workspace II open two and focus the **second**. Note both choices.
- [ ] From the primary, `$mod+3` (an empty workspace), then `$mod+1` to come back. The **middle**
      window of workspace I is focused again, not the first or last.
- [ ] Workspace II's own focused window is **unchanged** — still the second one. This is the half that
      matters: parking the previously focused window makes Mutter pick a replacement of its own, and
      this box is the only evidence that the replacement did not quietly re-select on a workspace you
      were not looking at.
- [ ] Repeat the round trip five or six times, alternating which display you stand on. Both selections
      survive every time.
- [ ] Switch to a workspace that is **empty**: keyboard focus ends up on that display (type and nothing
      lands in a window on the other display), and the pills show the empty workspace as focused.

## A56 — `move container to output right` moves a window, keeps its shape, and does not take focus with it

- [ ] On the primary build a nested layout: two windows, then `$mod+v` and a third, so the second and
      third share a vertical split. Focus the **split** with `$mod+a`.
- [ ] Run `move container to output right` over D-Bus (command above). The whole subtree lands on the
      other display's visible workspace: still a vertical split, still two children, same order, same
      proportions, and the same one of them focused inside it.
- [ ] **Focus stays on the display you were on** — type, and the characters land there, not on the
      display the window just went to. (That is i3's behaviour, and it is deliberate: you may not be
      able to see the display it went to.)
- [ ] The source display's remaining windows re-fill its work area with no gap and no overlap.
- [ ] Repeat with a single window and with `move container to output primary`. Both work; `primary` is
      the one that rescues a window from a display you cannot see.

## A57 — `focus output <direction>` never wraps

- [ ] With the displays side by side, stand on the **leftmost** and press `$mod+Ctrl+Left`. **Nothing
      happens** — focus stays, no window changes, the pointer does not move, and there is **no warning**
      in the journal: an edge is ordinary, not an error.
- [ ] `$mod+Ctrl+Right` from there moves you to the other display; `$mod+Ctrl+Left` brings you back.
- [ ] `$mod+Ctrl+Up` and `$mod+Ctrl+Down` do nothing with two side-by-side displays — they are not
      aliases for "the other one".
- [ ] `$mod+Ctrl+Right` while standing on an **empty** workspace on the right-hand display still does
      nothing (no neighbour), and crossing *onto* an empty workspace works: focus the empty display and
      type — nothing reaches the other display's windows.

## A58 — directional `focus` crosses the display edge instead of wrapping

- [ ] Two windows on each display, side by side. Stand on the **rightmost window of the left display**
      and press `$mod+semicolon` (focus right).
- [ ] Focus lands on the **leftmost** window of the right-hand display — the entering edge — not back
      on the left display's own first window, which is what wrapping would have done.
- [ ] From that window, `$mod+j` (focus left) comes back to the **rightmost** window of the left
      display.
- [ ] With only **one** window on the left display, `$mod+semicolon` still crosses rather than staying
      put.
- [ ] `$mod+Shift+semicolon` (move right) at the same edge **moves the window** into the right-hand
      display's workspace at its entering edge, standing alone there rather than being buried inside an
      existing split, and focus travels with it.
- [ ] On the right-hand display's rightmost window, `$mod+semicolon` wraps inside that workspace (your
      config's `focus_wrapping` is i3's default `yes`) — wrapping applies only where there is no
      neighbour.

## A59 — the pointer claims an empty display, and `$mod+d` opens there

- [ ] Make the non-primary display show an **empty** workspace. Leave every window on the primary.
- [ ] Move the pointer onto the empty display, over its background — not over any window.
- [ ] Press `$mod+d`. The launcher opens on **that** display. This is the case no window-based approach
      can reach: there is no window there to take focus.
- [ ] `Escape` closes it. Move the pointer back to the primary and `$mod+d` again: it opens on the
      primary.
- [ ] `GetState`'s `focusedOutput` changes as the pointer crosses, and changes **only** on a real
      crossing — moving the pointer around within one display does not churn it.

## A60 — sloppy focus moves the focused display, and `focus output` warps the pointer

- [ ] `gsettings get org.gnome.desktop.wm.preferences focus-mode` prints `sloppy` while the extension is
      enabled.
- [ ] Windows on both displays. Move the pointer onto a **window** on the other display without
      clicking: it takes focus, and typing lands there.
- [ ] Move the pointer onto a **non-empty** display's window and back again, several times: focus
      follows every time, in both directions. (An earlier build claimed only an *empty* display, so
      focus could drain onto one and never be pulled back — if you ever see focus you cannot reclaim
      with the pointer, that is the defect returning.)
- [ ] Click a window on the other display. `$mod+Shift+5` (move container to workspace 5) then acts on
      **that** window, not on something on the display you came from. This is the box that proves
      focusing a window moves the focused *output*, which every workspace-scoped command depends on.
- [ ] Put the pointer on the primary, then press `$mod+Ctrl+Right`: the **pointer jumps** to the newly
      focused window on the other display. Keyboard focus and the pointer end up on the same display,
      which is the whole point of the pair.

## A61 — `mouse_warping none`, and the launcher's grab

- [ ] Add `mouse_warping none` to the config and `$mod+Shift+c`. No error.
- [ ] `$mod+Ctrl+Right`: focus moves to the other display and **the pointer does not move**.
- [ ] Remove the line (back to i3's default `output`) and reload; the warp is back.
- [ ] Change it to `mouse_warping container`: the config **loads** with a warning in the journal saying
      the finer granularity is not implemented, and warping behaves exactly like `output`. It must never
      reject the file.
- [ ] `$mod+d` to open the launcher, and while it is open press `$mod+Ctrl+Right`. The pointer is **not**
      warped out from under the launcher.
- [ ] Now the part that regressed once: `$mod+d`, then close the launcher **itself** — `Escape`, or
      launch something, or press `$mod+d` again to toggle it shut. Then `$mod+Ctrl+Right`: the pointer
      **is** warped again. The suppression must not latch on after the launcher's first use.
- [ ] Remove `mouse_warping container` before continuing.

## A61b — `focus_follows_mouse no` makes pointer motion inert

- [ ] Add `focus_follows_mouse no` to the config, `$mod+Shift+c`, and confirm
      `gsettings get org.gnome.desktop.wm.preferences focus-mode` now prints `click`.
- [ ] Make the other display show an **empty** workspace and move the pointer onto it. `$mod+d` opens
      the launcher on the display you were already on — crossing the pointer onto an empty display no
      longer moves the focused output.
- [ ] Moving the pointer over a **window** on the other display does not focus it either; a **click**
      does.
- [ ] `$mod+Ctrl+Right` still works — with the mouse inert, the keyboard is the way across, which is
      exactly why the setting must not be half-honoured.
- [ ] Remove the line and reload; sloppy focus is back (`focus-mode` prints `sloppy` again).

## A62 — unplugging a display keeps the layout; replugging puts it back

- [ ] Build a recognisable layout on the non-primary display: three windows, one split nested, not all
      equal sizes.
- [ ] Unplug that display (or undock, or close the lid if it is the panel). No window is lost and no
      error appears in the journal.
- [ ] That workspace's windows are **not** flattened into the primary's tiling. They are parked, and its
      pill has moved to the primary's bar.
- [ ] `$mod+<that workspace's number>` on the primary shows it with its **layout intact** — same nesting,
      same order, same proportions as before the unplug.
- [ ] Plug the display back in. The workspace returns **to that display**, still intact, and the primary
      goes back to showing its own.
- [ ] First displacement wins: with three displays, unplug the display holding workspace *W*, then
      unplug the display *W* landed on, then plug both back in. *W* returns to its **original** home, not
      to the display that merely sheltered it.
- [ ] A command beats a memory: unplug a display, `$mod+Ctrl+period` (`move workspace to output right`)
      to move a workspace deliberately, then plug the display back in. Your move **stands** — the replug
      does not undo it.
- [ ] Through all of the above, every attached display is showing one of its own workspaces at every
      moment. No display is ever left blank or showing another display's workspace.

## A63 — GNOME's active workspace is always `live`

- [ ] `gsettings get org.gnome.desktop.wm.preferences num-workspaces` prints `2`.
- [ ] GNOME's own workspace-switch shortcuts (`Ctrl+Alt+Up`/`Down` by default) do nothing while the
      extension is enabled.
- [ ] Use a **touchpad workspace gesture** (four-finger swipe up/down, if your hardware has it), which
      has no GSetting to clear. The desktop snaps back; a warning appears in the journal saying the
      active workspace left live. You may see a flash — that is expected, and the warning is the point.
- [ ] After that, both displays still show the right workspaces and nothing is stranded in the attic.
- [ ] Do it five or six times in a row: no runaway loop, no repeated storm of identical warnings
      building up, and the session stays responsive. (An earlier build recursed into a stack overflow on
      this path at every login, so a quiet journal here is a real result.)
- [ ] Switch workspaces in **GNOME's overview** by dragging: the same guard brings it back.

## A64 — every setting comes back on `disable()`

Note the four values before you start, with the extension **disabled**:

```sh
gnome-extensions disable i3-shell@troja
gsettings get org.gnome.desktop.wm.preferences num-workspaces
gsettings get org.gnome.desktop.wm.preferences focus-mode
gsettings get org.gnome.shell.app-switcher current-workspace-only
gsettings get org.gnome.desktop.wm.preferences workspace-names
gsettings get org.gnome.desktop.wm.keybindings switch-to-workspace-1
gnome-extensions enable i3-shell@troja
```

- [ ] Enabled: `num-workspaces` is `2`, `focus-mode` is `sloppy`, `current-workspace-only` is `true`,
      and `switch-to-workspace-1` is empty (`@as []`).
- [ ] `gnome-extensions disable i3-shell@troja`: **all five** print the values you noted, including
      `workspace-names` — which the extension no longer applies but still restores if an older build
      saved it.
- [ ] Re-enable: back to the overridden values, with no warning in the journal about any of them.
- [ ] Log out with the extension **enabled** and log back in: the extension's snapshot still holds your
      originals, so a crash before `disable()` cannot keep GNOME changed —
      ```sh
      GSETTINGS_SCHEMA_DIR=~/.local/share/gnome-shell/extensions/i3-shell@troja/schemas \
        gsettings get org.gnome.shell.extensions.i3-shell overridden-settings
      ```
- [ ] After a `disable()`, GNOME's own workspace switching works again (`Ctrl+Alt+Up`/`Down`), and the
      overview shows GNOME's usual dynamic workspaces rather than exactly two.

## A65 — pill styling precedence

- [ ] A workspace that is focused is styled **focused** even when it also holds windows and even when
      another of its own windows is urgent — `focused` wins over everything.
- [ ] A workspace that is **visible on the other display but not focused** is styled differently from
      both the focused one and from an occupied-but-hidden one. Three distinguishable styles on screen
      at once; this distinction is new in Phase 5.
- [ ] An **occupied** hidden workspace is distinguishable from an empty hidden one.
- [ ] Urgency: a window on a **hidden** workspace must demand attention. The reliable recipe is to
      leave an application open there and then ask it to open something from the workspace you are on,
      so Mutter turns the activation request it cannot grant into `window-demands-attention` — e.g. a
      browser on the hidden workspace plus `xdg-open https://example.com` here. That pill takes the
      **urgent** style, which outranks `visible` and `occupied` but not `focused`.
- [ ] Switch to the urgent workspace: the urgency clears (a focused workspace is never urgent).
- [ ] Click a pill on the **non-primary** display's bar: it switches to **that** workspace, not to the
      workspace at the same position on the primary's list. (Per-output pill lists are compacted, so a
      position-to-workspace mix-up here is the specific bug this box exists for.)
- [ ] Unplug a display and plug it back in, then click pills on both bars again: each bar still switches
      its **own** workspaces. (A bar rebuilt against a stale monitor table was a real defect in this
      phase.)

## A66 — no new criticals

- [ ] `journalctl --user -b | grep -E '(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL'` after the
      whole walk shows nothing new attributable to i3-shell — in particular not during a workspace swap,
      which moves several windows in one go.
- [ ] Nothing new appears during the unplug/replug of A62, the gesture of A63, or the disable/enable of
      A64.
- [ ] Log out at the end: no burst of criticals on shutdown.

---

## Known limitations to expect — note them, do not file them

- **GNOME's overview shows the attic.** Two GNOME workspaces exist while the extension runs, and the
  second holds every parked window. It is the hiding primitive, not a leak (main spec §9).
- **All *N* pills are shown**, split between the displays, where i3 hides a workspace it has never
  visited. i3-shell keeps a fixed set of *N* workspaces from the config, so there is no "does not exist
  yet" state to hide — only "has not been placed yet" (Phase 5 design §2.5, §2.3).
- **`workspace N` can relocate an *empty* workspace**, which real i3 never does, because of that same
  conflation between "hidden" and "not yet placed". An **occupied** workspace is never relocated by a
  number press, which is the half that matters.
- **The memory tier of the switch-time precedence is unreachable through the tree today.** A replug
  re-homes a remembered workspace and clears its entry, so by the time a switch happens there is nothing
  left to consult. The code says so where it is implemented; A62's replug boxes are the behaviour you can
  actually observe.
- **The pointer moves on keys you press all day.** `$mod+N` across displays warps it, because otherwise
  sloppy focus hands the display straight back. `mouse_warping none` is the config-level veto (A61).
- **A window on a powered-off or unplugged output is invisible but present.** It has not been lost.
  `move container to output primary` over D-Bus brings it back (README, Troubleshooting).
- **Alt-tab is narrower** (`current-workspace-only`), and GNOME's `switch-to-workspace-*` shortcuts are
  gone while the extension runs. Both come back on `disable()` (A64).
- **A locked session reports `grabbed: 0` and `ready: false`** in `GetState`. That is correct — locking
  ungrabs every binding by design — and is not a failure.
- **`move container to output` is implemented but unbound.** i3 ships no default binding for it either;
  bind it yourself if you want it (`bindsym $mod+Ctrl+p move container to output primary` is the useful
  one).
- **A floating window moved by *command* keeps its old frame.** `move container to output` and
  `move container to workspace N` re-home a floating window in the tree but emit **no frame change**, so
  it stays drawn exactly where it was — and then appears to *vanish* when the other display switches away
  from the workspace it now belongs to. Confirmed by execution, not inference: the commit's port calls
  are `["moveTo:1:0","decorations","decorations"]`, with no rect. The D6 cross-output re-home cannot
  correct it either, because no monitor *change* occurred. Workaround: drag the window instead, or
  `floating disable` first and move it tiled. Pre-existing, but Phase 5 is what made `$mod+Shift+N` a
  cross-display operation, so expect to meet it.
- **GNOME's hot corner can swallow the pointer warp.** `workspace N` warps the pointer when the switch
  crosses displays (i3's `mouse_warping output` default, A61). Warping *out of* the top-left corner trips
  Mutter's pressure barrier, which opens the overview and takes the keyboard — mid-walk, from a key you
  press all day. Two workarounds: `mouse_warping none` in the config, or
  `gsettings set org.gnome.desktop.interface enable-hot-corners false`. This is an **open decision, not
  settled behaviour**: i3-shell deliberately does not change that setting for you, so if it bites, note
  which workaround you want rather than filing it.
- **Everything Phase 3A/3B listed still applies**: the border overlaps its client's outermost pixels,
  `border toggle` is two-state, a bar is never shorter than 28px, a monitor showing a fullscreen window
  shows no i3-shell chrome, a window's *kind* is still fixed at its first frame, and IBus can swallow a
  varying subset of accelerators. See `docs/acceptance/phase-3.md` and `phase-3b.md`.

## Automated evidence (not acceptance)

**Unit suite: 1160 tests in 71 files**, green at the tip of `phase-5`, alongside both TypeScript
programs, the Layer 0 import gate and the tree lint. **Nested integration suite: 637 assertions, exit 0,
zero `LIMITATION` branches**, green at `863a8ec` on 2026-10-01 — the first end-to-end native pass of
Phase 5, and the run that found two real regressions (D6 and D7) no unit test could see. Zero
`LIMITATION` lines means the headless backend really removed *and* restored an output rather than
skipping those branches. Neither suite ticks anything above. What they cannot reach, and what therefore
rests entirely on this walk:

- **A second real display.** Every automated output is a `--virtual-monitor` in a headless nested shell.
  Nothing docks, undocks, closes a lid, or mixes resolutions and scale factors. A62 is the only evidence
  for a physical unplug.
- **A real pointer.** The cursor tracker is faked in units. A59, A60 and A61 are the only evidence that
  sloppy focus and warping behave as a pair on real hardware.
- **Mutter's own focus replacement.** When a focused window is parked, the compositor picks a replacement
  by itself. The visible outcome self-corrects, so no unit test can see whether another workspace's
  selection was damaged on the way. **A55 is the only test of that**, by design (Phase 5 design §5.2).
- **The overview, the touchpad gesture, and GNOME's own workspace UI.** A63 is their only coverage.
- **Whether two GNOME workspaces upset anything else on the desktop.** Nothing asserts that other
  applications, the overview or window-list extensions behave sensibly with the attic. The walk is the
  only review.

The native run above is evidence, not acceptance: it exercises `--virtual-monitor` outputs in a nested
headless shell, so every item in the list above still rests on this walk.

## The user's report

_To be filled in by the user after the walk. Record `git rev-parse --short HEAD`, which displays were
attached and how they were arranged, and for every box either a tick or what happened instead._
