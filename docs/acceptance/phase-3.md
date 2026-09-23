# Phase 3A acceptance — live session

**Product revision:** branch `phase-3a`, Phase 3A tasks 1–8 (borders, the focused-container frame,
tab and stack title rows, a workspace bar on every non-primary monitor, the shutdown-`commit()`
fix). Record the exact revision you built from — `git rev-parse --short HEAD` — next to your result
at the end, because "it looked wrong" is only useful against a known build.
**Build under test:** release `make install` (no `org.i3shell.Debug` interface or methods).
**Environment:** GNOME Shell 50.5 / Mutter 18, Wayland, Fedora Silverblue 44.
**Date prepared:** 2026-09-23. **Result: not yet walked.**

Nothing in this repository ticks these boxes. The automated suite at the end is separate evidence
and is listed only so the walk can concentrate on what automation cannot reach: Phase 3A is the
first phase whose whole point is what things *look* like, and no headless harness can see that.

---

## Read this before you start

**Window title bars stay. That is a platform limit, not a defect.** GTK applications on Wayland
draw their own decorations and Mutter cannot strip them; "stripping title bars" has been a v1
non-goal since the main spec (§17), and the Phase 3A design says it again in §1. So i3-shell's
border sits *outside* whatever the application draws for itself, and a tabbed container shows both
i3's title row and each window's own GTK header bar underneath it. Please do not file that.

**Four things are deliberately not in this phase.** If you look for them you will not find them,
and none of them is a failure of these boxes:

| Not here | Where it goes |
|---|---|
| Borders on **floating** windows (`default_floating_border` is parsed and not applied) | Phase 4 |
| The **`urgent`** border colour | Phase 4 — it needs `window-demands-attention` |
| Per-output workspace **sets** (every bar mirrors the same pills on purpose) | Phase 4 |
| Window facts — `sticky`, `skipTaskbar`, re-reading `tiled ⇄ floating` | Phase 3B |

## How to run this walk

```sh
make install                      # release build + symlink
# log out and back in — Wayland cannot reload extension code in place
gnome-extensions enable i3-shell@troja
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell   # in a second terminal
```

Three boxes need a command rather than a key. i3-shell answers on the session bus like `i3-msg`:

```sh
i3msg() {                          # paste this into the terminal you are testing from
  gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
    --method org.i3shell.Control.Command "$1"
}
```

Open two terminals (`$mod+Return`) unless a check says otherwise. `$mod` is `Super`. The keys used
below are the ones in `examples/i3-shell.config`: `$mod+a` focus parent, `$mod+w` tabbed,
`$mod+s` stacking, `$mod+e` toggle split, `$mod+f` fullscreen.

---

## A15 — every tiled window has a border
- [ ] With two tiles open, **both** have a visible border — not just the focused one.
- [ ] The focused window's border is your GNOME accent colour (Settings → Appearance), and the
      unfocused one's is grey.
- [ ] Change the accent colour in Settings without touching anything else: the focused border
      follows it live, with no relogin.
- [ ] Put `client.focused  #13BEAA  #13BEAA  #FFFFFF  #13BEAA  #13BEAA` in `~/.config/i3/config`,
      run `i3msg reload`: the focused border is now that colour and stops following the accent.
      Remove the line and reload again to get the accent back.
- [ ] Move focus between the two tiles: the colours swap immediately, and nothing is left behind
      on the window that lost focus.
- [ ] Make a window fullscreen (`$mod+f`): it has no border at all while fullscreen, and gets one
      back when you leave fullscreen.

## A16 — `$mod+a` visibly outlines the selected container
- [ ] Arrange `A | (B over C)` (`$mod+v` before opening the third window), focus `C`, press
      `$mod+a`: an outline appears around `B` and `C` together — that is the container the next
      command will act on.
- [ ] `$mod+a` again widens the outline to the whole workspace.
- [ ] Clicking inside a window, or focusing one with `$mod+l`, removes the outline (the selection
      is a window again).
- [ ] The outline is drawn *around* the pair, not over either window's contents.

## A17 — a tabbed container
- [ ] With two tiles, press `$mod+w`: one row of tabs appears across the top of the container, one
      tab per window, each showing that window's title.
- [ ] The selected tab is highlighted and the others are not.
- [ ] The windows start **below** the row: no tab is drawn over a window, and no window is
      covered by the row.
- [ ] Clicking a tab focuses that window (typing goes to it afterwards).
- [ ] Open a third window inside the container: a third tab appears and the row does not get
      taller.
- [ ] Close one of them: its tab goes, and the remaining windows keep the same geometry rule
      (rect minus one row).
- [ ] Set a noticeably larger interface font (Settings → Accessibility → Large Text, or
      `gsettings set org.gnome.desktop.interface font-name 'Cantarell 16'`): the row gets taller
      **and the windows move down with it** — the tab text is never clipped. Put the font back.

## A18 — a stacked container
- [ ] With three tiles, press `$mod+s`: **three** title rows appear, stacked one above the other,
      all visible at once — not one row with three tabs.
- [ ] The rows carry the three window titles, and the selected one is highlighted.
- [ ] The windows start below **all three** rows, and the visible window fills what is left.
- [ ] Clicking a row focuses that window.
- [ ] `$mod+e` returns the container to a split: every row disappears and the windows grow back to
      the full rectangle, side by side.

## A19 — border widths
- [ ] `i3msg "border pixel 8"` on a focused window: that window's border gets visibly thicker and
      the other windows' borders do not change.
- [ ] `i3msg "border none"`: the border disappears, and the window still tiles in the same place.
- [ ] `i3msg "border toggle"` brings it back at the configured width, and again removes it.
- [ ] `i3msg "border normal"` behaves the same as `pixel` — there is no title bar for i3-shell to
      draw, so `normal` is a width, not a style.
- [ ] Change `default_border pixel 2` to `default_border pixel 6` in the config and `i3msg reload`:
      windows you have not overridden individually get the wider border.
- [ ] With `$mod+a` selecting a container, `i3msg "border pixel 8"` changes every window in that
      container at once.

## A20 — a bar on every non-primary monitor
> Set `gsettings set org.gnome.mutter workspaces-only-on-primary false` first, for the same reason
> as Phase 2's A14: with GNOME's default, windows on a secondary output are sticky and i3-shell
> does not tile sticky windows. Revert it with `gsettings reset` when you are done.

- [ ] Dock an external display: a bar appears at the top of **that** monitor showing the same
      workspace pills as the panel on the primary, with the same active workspace highlighted.
- [ ] The primary monitor still shows GNOME's own panel and does **not** grow a second bar.
- [ ] Switching workspaces (`$mod+1..0`) moves the highlight on every bar at once.
- [ ] Clicking a pill on the external monitor's bar switches the workspace.
- [ ] `$mod+r` (resize mode): the mode label appears on every bar, and leaving the mode removes it
      from every bar.
- [ ] Windows tiled on the external monitor start **below** its bar — nothing is hidden underneath
      it, and there is no gap either.
- [ ] Undock: no bar or strut is left behind on the primary, and its work area is unchanged.
- [ ] Re-dock: the bar comes back, once, with the current pills already on it.

## A21 — disabling removes everything
- [ ] `gnome-extensions disable i3-shell@troja`: every border, every container outline, every title
      row and every secondary-monitor bar disappears in one go.
- [ ] Each monitor's work area returns to full height — maximize a window on the external display
      and it now reaches the top of that monitor.
- [ ] The windows themselves stay exactly where they were; nothing is moved or closed by disabling.
- [ ] `gnome-extensions enable i3-shell@troja` re-adopts the windows, and the chrome comes back
      without duplicates (one border per window, one bar per monitor).
- [ ] Lock the screen and unlock: no chrome is left drawn over the lock screen, and everything is
      back afterwards.
- [ ] Log out with the extension enabled and log back in: no `i3-shell` error, and no GJS
      `CRITICAL` about a disposed actor, appears in the journal for the shutdown.

---

## Known limitations to expect — note them, do not file them

- **`border toggle` is two-state.** It alternates between the configured width and `0`. i3 cycles
  `normal → none → pixel`; with no title bars to draw, `normal` and `pixel` are the same thing
  here, so the cycle would have two indistinguishable stops out of three.
- **A bar is never shorter than 28px**, whatever the theme says its content needs. It is a floor,
  not a size: the bar grows with the font and the scale factor, and only a very small font can make
  the floor visible as a slightly roomier bar than you expected.
- **A bar can come back on its own while the screen is locked.** The bars are registered with
  `trackFullscreen`, so GNOME sets their `visible` itself whenever it recomputes its regions, and
  that can undo i3-shell's hide. On the lock screen the shield covers them anyway, which is what
  actually keeps them off the screen — if you ever see a bar *through* the shield, that is a
  defect and belongs in your report.
- **Tabs on a container that is also fullscreen are not drawn**, and neither is the fullscreen
  window's border. Fullscreen geometry belongs to Mutter (main spec §19) and chrome over it would
  contradict that.

## Automated evidence (not acceptance)

Run with `bash test/integration/run.sh` in a private nested GNOME Shell — separate bus, settings,
runtime and Wayland socket, never the live session. It ticks nothing above.

| Scenario | What it pins | Result |
|---|---|---|
| Retained Phase 1 and Phase 2 checks (A1–A14) | unchanged tiling, sessions, settings, name conflict | *(fill in from the run)* |
| `scenario_tabbed_stacked` | a tabbed/stacked container's children share the parent rect **minus the title row** | *(fill in from the run)* |
| `scenario_decorations` | one row for tabbed and one row per child for stacked, as real GTK frames; `$mod+e` restores the rectangles byte for byte | *(fill in from the run)* |
| Two virtual outputs | the secondary work area is shorter than its monitor by the bar's strut, and tiles there start below the bar | *(fill in from the run)* |
| Native-critical gate | no GJS/Mutter `CRITICAL` across enable, disable and shutdown with decorations present | *(fill in from the run)* |

Every rectangle in those scenarios is computed by an independent implementation of the layout rule
from the reported work area, and compared against both the native Mutter frame and the engine's own
target. The one number taken from the engine is the title row's height, because it comes from the
theme through the shell's own measurement and the harness has no way to see a theme; the rule that
*uses* that number is still reimplemented in the harness, and a reported zero is refused rather
than reproduced.

**What the automation deliberately does not cover**, and why this walk matters more in 3A than in
any phase before it:

- **Nothing that is painted.** The harness reads geometry over D-Bus. Borders, the container
  outline, the tabs and their titles are `St` actors inside the shell process: their colour, their
  accent-following, which tab is highlighted, whether a title is readable, whether a click on a tab
  lands — none of it is visible to any assertion in the suite. A15, A16, the colour halves of A17
  and A18, and all of A19's *visible* half exist only here.
- **The stylesheet.** `stylesheet.css` is applied by GNOME at runtime; no test renders it. A rule
  with a typo in it fails silently and shows up as chrome that looks wrong, never as a red test.
- **Fonts and scale factors.** The title row's height is measured from the live theme. The suite
  checks that the engine reserves whatever the shell measured — not that the shell measured
  sensibly. The large-font box in A17 is the only check on that.
- **IBus is suppressed in the harness** (carried forward from Phase 2), **Xwayland clients are
  unverified** (`--no-x11`), and **physical displays** — a real dock, a lid switch, mixed
  resolutions and mixed scale factors — are not exercised. A20 is the only evidence for a real
  second monitor.

## The user's report

*(to be written after the walk)*
