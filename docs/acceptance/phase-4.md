# Phase 4 acceptance — live session

**Product revision:** Phase 4 fidelity (`for_window` rules applied at first frame and on a title change,
once per rule per window; urgency hints raising a workspace pill, cleared by focusing it; directional
`focus`/`move` crossing the display edge; and monitor displacement — windows reachable when an output
goes away, returned when it comes back, and left alone where the user deliberately moved them). Record
the exact revision you built from — `git rev-parse --short HEAD` — next to your result at the end. "The
dialog was the wrong size" is only useful against a known build.
**Build under test:** release `make install` (no `org.i3shell.Debug` interface or methods).
**Environment:** GNOME Shell 50.5 / Mutter 18, Wayland, Fedora Silverblue 44. Hardware: the 1728x1048
laptop panel and the 1920x1080 external display (a television works as the second display too; note
which you used). **A38-A42 need one display. A43-A49 need two, and A46-A48 need one of them to be the laptop panel with a lid that closes.**
**Date prepared:** 2026-10-06. **Result: not yet walked.**

This checklist is Phase 4's debt, not a new phase: the code has been in `main` since Phase 4 merged and
Phase 4's own documentation task never ran. The criteria are §8 of
`docs/superpowers/specs/2026-09-24-phase-4-fidelity-design.md`, lines 244-259, unchanged.

The boxes record a human verification, so they are ticked by the person who did the walk and never by an
agent on its own. The unit and native suites are separate evidence and are listed at the end only so the
walk can concentrate on what no fake can reach.

---

## Read this before you start

**You will need to log out.** Wayland cannot reload extension code in place, so
`gnome-extensions disable`/`enable` on an old build does not give you the new one.

```sh
make install                      # release build + symlink
# log out and back in
gnome-extensions enable i3-shell@troja
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell   # second terminal
```

To read the extension's own view of the world at any point:

```sh
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetState      # mode, active workspace, grabs, pills, focusedOutput
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetTree       # per workspace: its output, work area, root, selection
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetWindows    # per window: rect, state, title, class
```

**Find your own `for_window` line before you start A38**, because A38-A40 are about *your* config and not
about an example:

```sh
rg -n 'for_window' ~/.config/i3/config
```

The spec's A38 describes the rule whose effect is *floating, 720×420, centred, 2px border*. If your line
has different numbers, use yours and write them next to the box. If you have no `for_window` line at all,
say so and skip A38-A40 — they cannot be walked without one, and inventing a rule for the walk would test
a config you do not run.

Reading a GSetting is fine anywhere below. **Writing one is a defect for this phase** (that is A49).

---

## A38 — the real config's `for_window` rule fires

- [ ] Open GNOME Settings → Sound, and open the **Audio output** chooser dialog (the one your
      `for_window` line matches; confirm the title with `GetWindows` if you are unsure which window it is).
- [ ] The dialog is **floating**: it does not take a tile, and the windows already on the workspace do
      not shrink to make room for it.
- [ ] It is **720 wide by 420 tall**, **centred** on the work area, with a **2px border** —
      your `for_window` line's own numbers. Check the frame against `GetWindows`, whose `rect` for that
      window should read 720×420 with `x` and `y` placing it centrally in the output's work area.
- [ ] `GetWindows` reports its `state` as `floating`.
- [ ] Nothing in the journal warns about the rule.

## A39 — the rule fires even when the dialog sets its title after mapping

- [ ] Close the dialog and open it again, watching the journal. GNOME routinely maps a dialog with a
      placeholder title and sets the real one a moment later, and your rule matches on the real one.
- [ ] The dialog still ends up floating, 720×420, centred, 2px border — the rule caught the later title,
      not only the one at first frame.
- [ ] Do it four or five more times. It happens **every** time, not most times: the title arrives
      asynchronously and a race here would be intermittent.

## A40 — the rule does not re-fire and re-resize on a later title change

A dialog's title cannot be changed on demand, so force it with a terminal whose title you set yourself.
Both titles below match your rule's regex `^Audio (output|input)$` (config line 50).

- [ ] Open a terminal and run `printf '\e]0;Audio output\a'`. The rule fires: floating, 720x420,
      centred, 2px border.
- [ ] Resize it by dragging a corner to something clearly different from 720x420, and move it.
- [ ] Run `printf '\e]0;Audio input\a'`, then `printf '\e]0;Audio output\a'` again. Confirm in the
      terminal's title bar (or `GetWindows`' `title`) that the title really did change each time.
- [ ] **Your size and position survive.** The window is not snapped back to 720x420 or re-centred. A rule
      that re-fires fights the user for the rectangle once per title change.
- [ ] `GetWindows` confirms the frame is still the one you dragged to.
- [ ] **If you could not observe the title change, this box is unwalkable, not passed.** Say so in your
      report instead of ticking it.

## A41 — an urgency hint on an inactive workspace turns that workspace's pill

- [ ] On workspace **2**, open a terminal and run `sleep 5; printf '\a'`, then press `$mod+1` at once so
      you are looking at **1** when it fires. (Command-completion urgency in terminals is unreliable; the
      bell is not.)
- [ ] Workspace **2**'s pill changes colour while you are on **1**, to your config's `client.urgent`
      colours (config line 277: border `#EC69A0`, background `#DB3279`). Compare the pill's colour with
      those values, not just "it changed". This is styled from `client.urgent` deliberately: i3 would use
      a `bar { colors { ... } }` block, which this project ignores.
- [ ] The pill for the workspace you are **on** does not change.
- [ ] `GetState`'s `pills` array marks that workspace `urgent: true`.

## A42 — focusing the workspace clears the urgency

- [ ] Press `$mod+2`. The pill stops being urgent **immediately**, not after the window is clicked or
      after the hint is withdrawn by the application.
- [ ] `GetState`'s `pills` now reports `urgent: false` for it.
- [ ] Go back to **I** and confirm it does not come back: focusing a workspace is how i3 clears
      urgency, and nothing should re-raise it on its own.

## A43 — `focus right` at the laptop panel's right edge moves to the external display

**For A43-A45, do not touch the mouse.** GNOME's focus mode is `sloppy` and a workspace switch that
crosses displays warps the pointer, so focus can reach the other display without `focus right` ever
running. Also do not press `$mod+Ctrl+Right` (`focus output right`, config line 203): it gives the same
visible result by a different command. Press the **directional** binding, `$mod+semicolon` or
`$mod+Right`. (`$mod+l` is `focus up` in your config, not right.) Read the state before and after:

```sh
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetState    # note focusedOutput
```

- [ ] Two displays, side by side: the 1728x1048 panel on the left and the 1920x1080 external to the
      **right** of it (GNOME Settings -> Displays). One window on each.
- [ ] Focus the window on the panel by keyboard (`$mod+j`/`$mod+Left`). `GetState`'s `focusedOutput`
      names the panel.
- [ ] Press `$mod+semicolon` (or `$mod+Right`). **Focus lands on the external display's window.** Type:
      the characters go there. `GetState`'s `focusedOutput` now names the external display.
- [ ] It did not wrap back to the leftmost window on the panel.

## A44 — `focus left` at the external display's left edge returns

- [ ] From there, press `$mod+j` (or `$mod+Left`). Focus comes back to the panel's window, and
      `focusedOutput` names the panel again. Mouse untouched.
- [ ] Repeat the pair five or six times. It works every time and nothing drifts: no window moves, no
      workspace changes, and the journal stays quiet.
- [ ] With two windows side by side **inside** the external display, `focus left` from the right-hand one
      moves to the left-hand one first and only then crosses. Crossing must not beat an ordinary move
      inside the output.

## A45 — `move right` at the edge carries the container across

Same rule: no mouse, and not `$mod+Ctrl+Right`. The bindings are `$mod+Shift+semicolon` or
`$mod+Shift+Right`. (`$mod+Shift+l` is `move up`.)

- [ ] Focus the panel's window and press `$mod+Shift+semicolon`. The **window** moves to the external
      display's visible workspace; `GetWindows`/`GetTree` show it there.
- [ ] Build a nested layout first: two windows, `$mod+v`, a third. Focus the split with `$mod+a`, and
      `move right` again. The whole subtree lands intact: same split, same order, same proportions, the
      same child focused inside it.
- [ ] The panel's remaining windows re-fill its work area with no gap and no overlap.

## A46 — with the lid closed and the panel off, its windows are reachable on the external display

If closing the lid suspends the machine, this cannot be walked as written: either set the lid action to
"do nothing" in GNOME Settings -> Power for the walk (and say so in your report), or write A46-A48 up as
unwalked. Do not tick them from a resume.

- [ ] Open two windows on the panel's workspace and note which they are.
- [ ] Close the lid (the 1920x1080 external stays attached and awake). The panel goes dark and GNOME
      drops that output.
- [ ] **Confirm the panel is really off before going on:** run
      `gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetTree` and check that
      only the external output is listed. If the panel is still there, this box has not been tested.
- [ ] **Those two windows are reachable on the external display**: `$mod+N` for the workspace they were
      on brings it up there, with both windows, in the same layout.
- [ ] Nothing was closed: `GetWindows` lists both, and whichever workspace is on screen draws them.
- [ ] The journal has no warning about outputs, assignment or coverage.

## A47 — on undock they return to the laptop panel

- [ ] Open the lid again; the 1728x1048 panel comes back. Confirm with `GetTree` that both outputs are
      listed before judging anything.
- [ ] The workspaces that lived on the panel **go back to the panel**, with their windows, their layout
      and their split proportions.
- [ ] The external display keeps what it had: this is a return, not a reshuffle.
- [ ] `GetTree` agrees: each workspace names the output you expect, and `visible` has one entry per
      attached display.

## A48 — a window the user deliberately moved while undocked stays put

- [ ] Close the lid again and confirm with `GetTree` that the panel is gone (as in A46).
- [ ] Pick a window that lived on the panel, and a workspace whose home **was the external display**
      (not one that only ended up there). Deliberately move the window there: focus it and press
      `$mod+Shift+N` for that workspace number, or run, with the external's output name from `GetTree`
      (for example `HDMI-A-1`):
      `gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "move container to output HDMI-A-1"`
- [ ] Open the lid and confirm with `GetTree` that both outputs are back. **That window stays where you
      put it.** Everything else returns to the panel as in A47; only the one you moved does not.
- [ ] This is the box that separates "remembering where a workspace lived" from "overruling the user", and
      it is the only test of the displacement-origin rule the spec settles in §7.

## A49 — none of A38-A48 needs a hand-edited GSetting or an outside script

Observe this rather than remember it. Before A38, in a spare terminal, start
`dconf watch /org/gnome/` and leave it running for the whole walk.

- [ ] At the end, the `dconf watch` output shows no write you made on purpose to get a box to pass.
      (Writes GNOME makes on its own, such as window geometry or recent files, are not yours; name any you
      are unsure of.)
- [ ] You did not run `gsettings set` or `dconf write` for anything during A38-A48.
- [ ] You did not run a script, a systemd unit or a `sudo` command to make any box pass. Every step was:
      edit `~/.config/i3/config`, press a binding, close or open the lid, or call `org.i3shell.Control`
      over D-Bus. (The lid-action setting in A46 is a Settings change, not a workaround, but record it.)
- [ ] If any box above needed one, **that box fails and so does this one**; name it here.

---

## Automated evidence (not acceptance)

The unit suite and the nested integration suite both cover Phase 4's code paths, and neither ticks
anything above. What they cannot reach, and what therefore rests entirely on this walk:

- **A real `for_window` subject.** The rules engine is unit-tested against fabricated `WindowInfo`
  records, and the nested harness's own GTK fixture sets its title when told to. Whether GNOME Settings'
  Audio dialog maps, titles and resizes in the order the rule needs is A38-A40's business alone.
- **A real urgency hint.** No fake raises one the way a terminal does.
- **A real lid.** Every automated output is a `--virtual-monitor` in a headless nested shell; nothing
  closes a lid or changes a scale factor. A46-A48 are the only evidence for a physical undock.
- **Whether any of it needs a GSetting.** A49 is a claim about the whole product and can only be checked
  by someone who did the walk.

## The user's report

_To be filled in by the user after the walk. Record `git rev-parse --short HEAD`, which displays were
attached and how they were arranged, your own `for_window` line, and for every box either a tick or what
happened instead._
