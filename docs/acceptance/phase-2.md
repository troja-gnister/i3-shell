# Phase 2 acceptance — live session

**Product revision:** `91020d2` on branch `phase-2b`
(`test: verify live tree integration and document phase two acceptance`).
**Build under test:** release `make install` (no `org.i3shell.Debug` interface or methods).
**Environment:** GNOME Shell 50.5 / Mutter 18, Wayland, Fedora Silverblue 44.
**Date prepared:** 2026-09-22. **Result: not yet walked — every A8–A14 box below is the user's to tick.**

Nothing in this repository ticks these boxes. The automated suite below is separate evidence and
is listed only so the walk can concentrate on what automation cannot reach.

## How to run this walk

```sh
make install                      # release build + symlink; run it even if integration failed
# log out and back in — Wayland cannot reload extension code in place
gnome-extensions enable i3-shell@troja
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell   # in a second terminal
```

Open two terminals (`$mod+Return`) unless a check says otherwise. `$mod` is `Super`.

---

## A8 — opening and closing tiles
- [ ] On an empty workspace, open one window: it fills the whole work area (below the top panel).
- [ ] Open a second: the two split the screen into equal left/right halves, no gap, no overlap.
- [ ] Close the right one (`$mod+Shift+q`): the survivor grows back to the full work area.
- [ ] Open and immediately close a third window: nothing is left behind, the survivor keeps the
      full work area, and no `i3-shell` error appears in the journal.

## A9 — where the next window lands
- [ ] With two tiles and the right one focused, press `$mod+v`, then open a window: it appears
      *below* the focused tile; the right half is now split top/bottom, the left half unchanged.
- [ ] With that new window focused, press `$mod+h`, then open another: it appears *beside* it,
      inside the lower-right quarter.

## A10 — directional focus and moving windows
Arrange `A | (B over C)` as in A9 and focus `C`.
- [ ] `$mod+l` focuses `B`; `$mod+l` again wraps back to `C`.
- [ ] `$mod+j` focuses `A`; `$mod+j` again wraps to the right column.
- [ ] `$mod+semicolon` moves focus right, wrapping at the workspace edge.
- [ ] `$mod+Shift+j` with `C` focused lifts it out of the column: three columns side by side.
- [ ] `$mod+Shift+semicolon` puts it back into the column; typing goes to `C` throughout.
- [ ] Repeat the two focus checks with the arrow keys (`$mod+Left/Down/Up/Right`).

## A11 — parent containers
- [ ] With `C` focused, `$mod+a` selects the container holding `B` and `C` (no window title bar
      changes; the next command acts on both).
- [ ] `$mod+Shift+j` moves `B` and `C` together to the left half; `A` takes the right half.
- [ ] `$mod+e` flips that container between vertical and horizontal; both windows follow.
- [ ] Clicking inside `C` does not silently reduce the selection to `C` alone before you move it.

## A12 — resize mode
- [ ] `$mod+r` shows `resize` next to the pills.
- [ ] `k` and `l` grow/shrink the focused tile's height in 10% steps; the neighbour above or below
      takes the difference and nothing else moves.
- [ ] `semicolon` and `j` do the same for width.
- [ ] While in resize mode, those keys never type into a focused terminal.
- [ ] `Escape`, `Return` and `$mod+r` each leave the mode.

## A13 — floating windows
- [ ] A dialog (for example GIMP's export dialog, or `Files` → Properties) floats above the tiles
      and does not change the tiling underneath.
- [ ] A modal dialog and a fixed-size window (for example `gnome-calculator` in basic mode) also
      float automatically.
- [ ] `$mod+Shift+space` on a tiled window floats it; the remaining tiles re-fill the work area.
- [ ] `$mod+space` toggles focus between the floating window and the tiled group, both ways.
- [ ] `$mod+Shift+space` again returns it to the tree at the position next to the focused tile.
- [ ] A splash screen (for example LibreOffice starting) is left alone by i3-shell.

## A14 — lock, re-enable and monitors
- [ ] Lock the screen and unlock: every window is exactly where it was, the mode label is gone,
      the pills are visible.
- [ ] `gnome-extensions disable i3-shell@troja` leaves the windows where they are; enabling again
      adopts them and re-tiles without losing any window.
- [ ] **Laptop alone (`eDP-1`):** tiles fill the built-in display's work area.

> **Before the multi-display boxes, read this.** With GNOME's default
> `org.gnome.mutter workspaces-only-on-primary = true`, Mutter marks every window on a **secondary**
> output as being on all workspaces, and i3-shell deliberately does not track sticky windows
> (spec §8.2). Windows on the external display will therefore simply not be tiled. That is the
> current design, not a Phase 2 failure — the spec leaves this key alone and Phase 4 revisits it.
> To exercise real multi-output tiling now, set it yourself first and revert it afterwards:
> ```sh
> gsettings set org.gnome.mutter workspaces-only-on-primary false   # revert with: reset
> ```
> The automated two-output scenario sets exactly this key for the same reason.

- [ ] **Dock with an external display, with `workspaces-only-on-primary=false` set:** windows already
      open stay on their displays, both outputs tile independently, and `$mod+1..0` switches
      workspaces on both. *(With the GNOME default left in place, expect windows on the external
      display to be untracked — that is the Phase 4 item, not a failure of this phase.)*
- [ ] **Undock (or close the lid):** the external display's windows move to the internal one and
      nothing is lost. *(Same caveat: only meaningful with `workspaces-only-on-primary=false`.)*
- [ ] **Re-dock:** the external display comes back as an empty workspace area; windows do not jump
      back on their own. Cross-monitor focus/movement commands, workspace-per-monitor policy and
      full dock/lid fidelity are **Phase 4** and are not expected to work here.

## Known conflicts to check explicitly

These two are the only keys the automated suite deliberately cannot certify, because the harness
suppresses IBus to stay deterministic (see below). Check them first — they are the ones at risk.

- [ ] `$mod+semicolon` really moves focus right, and does **not** open the emoji picker.
      IBus claims `<Super>semicolon` through `org.freedesktop.ibus.panel.emoji hotkey`, using the
      same external-grab mechanism i3-shell uses, and i3-shell's override scan does not cover the
      IBus schema.
- [ ] `$mod+space` really toggles tiled/floating focus, and does **not** switch input source.
      IBus also claims `<Super>space` through `org.freedesktop.ibus.general.hotkey triggers`.
- [ ] If either fails, note whether it fails every time or only after a login (the automated
      evidence suggests the losing subset varies per session).

## Automated evidence (not acceptance)

Run with `npm run test:integration` on 2026-09-22 in a private nested GNOME Shell — separate bus,
settings, runtime and Wayland socket, never the live session. It does not tick anything above.

| Scenario | Result |
|---|---|
| Retained Phase 1 checks (A1–A5, A7) | passed |
| Phase 2 single-monitor (A8–A14, tabbed/stacked, geometry states, refusing client, kill/transfer, reload/restart) | 102 assertions passed |
| Two virtual outputs: migration, real output removal and reconnection | 15 assertions passed |
| A6 settings: real originals cleared, restored, re-cleared on repeated enable | 12 assertions passed |
| `org.i3shell.Control` owned by another client | 12 assertions passed |

Every rectangle in those scenarios is computed from the reported work area by an independent
implementation of the layout rule, and compared against both the native Mutter frame and the
engine's own target.

**What the automation deliberately does not cover**, and why the live walk matters:

- **IBus is suppressed in the harness.** With IBus running, a varying subset of i3-shell's
  accelerators never dispatches. The two checks above exist for exactly this.
- **Xwayland clients and a visible nested compositor are unverified** (the harness runs `--no-x11`).
- **Physical displays.** Virtual output removal *and* reconnection both work on the headless
  backend, so that path is automated; a real dock, real lid switch, mixed resolutions and scaling
  are not, and are the A14 monitor boxes above.
- **A Wayland client cannot restore itself from minimized** (xdg-shell has `set_minimized` with no
  inverse), so the automated unminimize is triggered compositor-side; a real user click is not.

## The user's report

Record the outcome here after the walk: date, `gnome-shell --version`, which boxes passed, and any
failure with the journal lines around it. Phase 2 is not complete until this section is filled in.
