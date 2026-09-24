# Phase 3B acceptance — live session

**Product revision:** branch `phase-3b`, Phase 3B tasks 1–5 (`sticky` and `skipTaskbar` moved from
the read-once `WindowFacts` to the per-commit `WindowInfo`; `notify::on-all-workspaces` and
`notify::skip-taskbar` watched; one `excludedFromTree` gate at both engine call sites; the extension
takes ownership of `org.gnome.mutter workspaces-only-on-primary`). Record the exact revision you
built from — `git rev-parse --short HEAD` — next to your result at the end, because "the external
display did not tile" is only useful against a known build.
**Build under test:** release `make install` (no `org.i3shell.Debug` interface or methods).
**Environment:** GNOME Shell 50.5 / Mutter 18, Wayland, Fedora Silverblue 44. **An external display
is required for A22–A25 and A27.**
**Date prepared:** 2026-09-23. **Result: not walked yet.**

Nothing in this repository ticks these boxes. The automated suite at the end is separate evidence and
is listed only so the walk can concentrate on what automation cannot reach: this phase exists because
a fact that only a *real* compositor flips was read once and cached, and the harness can only
approximate the way a real display and a real drag produce that flip.

---

## Read this before you start

**One deliberate behaviour change reaches every application on your desktop.** While i3-shell is
enabled, `org.gnome.mutter workspaces-only-on-primary` is `false`, so GNOME treats a workspace as
spanning **every** output instead of only the primary one. Switching workspaces now changes what is
on the external display too, and a window there belongs to one workspace rather than being shown on
all of them. That is not a side effect to file: it is the only way an external display can tile at
all, because while the key is `true` Mutter marks every window on a secondary output "on all
workspaces", and i3-shell deliberately keeps such windows out of the tiling (main spec §8.2, §9).
`disable()` puts your original value back — A22 is the box that proves it.

**Three things are deliberately not in this phase.** None of them is a failure of these boxes:

| Not here | Where it goes |
|---|---|
| `tiled ⇄ floating` **reclassification** — a window's kind is fixed at its first frame. Only *membership* of the tree became mutable, never *kind* | Phase 4 (Phase 3B design §3.4) |
| Per-output workspace **sets**, per-output focus and `move container to output` | Phase 4 |
| Borders on floating windows, the `urgent` colour | Phase 4 (carried from Phase 3A) |

**A pinned window leaves the tiling on purpose.** "Always on Visible Workspace" is exactly the fact
this phase made mutable. A pinned window is still *tracked* — it keeps its window id, and its watch
— but it is not in the tree, so the remaining tiles take the whole work area, just as they do for a
minimized window. Un-pinning returns it **beside the focused window, as if newly opened** (Phase 3B
design §1), *not* to the slot it left. That choice is deliberate; do not file the missing slot.

**You will need to log out.** Wayland cannot reload extension code in place, so
`gnome-extensions disable`/`enable` on an old build does not give you the new one. Build, log out,
log back in, and only then start the walk.

## How to run this walk

```sh
make install                      # release build + symlink
# log out and back in — Wayland cannot reload extension code in place
gnome-extensions enable i3-shell@troja
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell   # in a second terminal
```

**Before you start, put the setting back to GNOME's default:**

```sh
gnome-extensions disable i3-shell@troja
gsettings reset org.gnome.mutter workspaces-only-on-primary     # → true, GNOME's default
gsettings get   org.gnome.mutter workspaces-only-on-primary     # confirm: true
gnome-extensions enable i3-shell@troja
```

Not because i3-shell needs it — A27 is the box that denies exactly that — but because you set this
key by hand for the Phase 2 and Phase 3A walks. If you leave your old hand-set `false` behind, A22's
restore box cannot tell a working restore from a setting nobody touched.

Open two terminals (`$mod+Return`) unless a check says otherwise. `$mod` is `Super`. To pin a window
to all workspaces, press **`Alt+Space`** for GNOME's own window menu (i3-shell does not claim that
accelerator; the reference config binds `$mod+space`) and choose **Always on Visible Workspace**, or
right-click the window's title bar for the same menu. If your GNOME build does not offer that item
at all, do not treat A26 as failed on that account — reach the same fact the long way round, with
the `gsettings set … true` in A22's last box, and say in your report which route you used. That
route is not a per-window substitute, though: it makes **every** window on the secondary output
sticky at once, not the one you chose, so A26's first, fourth and fifth boxes — pin one of two
tiles, pin/switch workspaces/un-pin there, and the pin-plus-minimize composition — cannot be walked
that way. Report those three as unreachable rather than passed.

Reading a GSetting is fine anywhere below. **Writing one is a defect for this phase** — except for
the `gsettings reset` above, which sets up A22, and the `gsettings set` in A22's own last box.

---

## A22 — the extension owns `workspaces-only-on-primary`
- [ ] With the extension enabled, `gsettings get org.gnome.mutter workspaces-only-on-primary`
      prints `false`.
- [ ] `gnome-extensions disable i3-shell@troja`: the same command now prints `true` again — the
      value you reset it to before starting.
- [ ] `gnome-extensions enable i3-shell@troja`: back to `false`, and no warning about the setting
      appears in the journal.
- [ ] Log out with the extension enabled and log back in: the key is `false`, and the extension's
      own snapshot names it with your original value inside — a crash before `disable()` must not
      silently keep GNOME changed. The snapshot lives in the extension's schema, which is not on
      `gsettings`' default search path (README):
      ```sh
      GSETTINGS_SCHEMA_DIR=~/.local/share/gnome-shell/extensions/i3-shell@troja/schemas \
        gsettings get org.gnome.shell.extensions.i3-shell overridden-settings
      ```
- [ ] Set it by hand to `true` while the extension is running
      (`gsettings set org.gnome.mutter workspaces-only-on-primary true`): the extension does not
      fight you for it, windows on the external display leave the tiling (that is A26's mechanism,
      reached the long way round), and setting it back to `false` returns them. Nothing crashes and
      no window is lost.

## A23 — a window moved to the external display tiles there
- [ ] Dock the external display. Drag a terminal from the internal display onto it: it **tiles** on
      the external monitor — it snaps to that monitor's work area, below i3-shell's bar there, and
      does not stay where you dropped it.
- [ ] It is still tracked: `$mod+Return` on the external display opens a second terminal and the two
      split that monitor's work area between them; focus keys move between them.
- [ ] Open a window while the external display is focused: it tiles there too, not on the internal
      one.
- [ ] The internal display's remaining tiles re-fill its work area when the window leaves.
- [ ] Nothing in the journal says a window was dropped, and no `i3-shell` warning appears for the
      move.

## A24 — moving it back tiles it on the internal display again
- [ ] Drag that window back to the internal display: it tiles there, beside whatever is focused.
- [ ] Do the round trip three or four times, alternating displays: the window keeps tiling every
      time, and never ends up floating, stuck, or invisible. **This is the box this whole phase
      exists for** — before it, the first move dropped the window permanently and the move back
      could not even be noticed.
- [ ] The external display's remaining tiles re-fill its work area each time.
- [ ] After the last move, `$mod+Shift+q` closes that window normally (it is still a window
      i3-shell knows about, not an orphan).

## A25 — unplugging the display does not lose the window
- [ ] With a window tiled on the external display, unplug it (or undock): the window appears on the
      internal display, tiled, and not behind anything.
- [ ] Plug the display back in: nothing is lost, no duplicate window appears, and the window is
      still usable. (Contents do **not** migrate back on their own — Phase 2's A14 already recorded
      that.)
- [ ] Close the lid with the external display attached, then open it again: no window is lost and no
      `i3-shell` error appears in the journal for either transition.

## A26 — pinning a window to all workspaces
- [ ] With two tiles open, pin one of them (`Alt+Space` → **Always on Visible Workspace**): it
      leaves the tiling, and the other tile grows to fill the whole work area.
- [ ] The pinned window is still there, still usable, and still follows you to every workspace —
      that is GNOME doing its job, not i3-shell losing the window.
- [ ] Un-pin it (`Alt+Space` → the same item, now unchecked): it returns to the tiling **beside the
      focused window**, as if newly opened. It does not come back to the slot it left, and that is
      deliberate.
- [ ] Pin it, switch workspaces, un-pin it there: it joins *that* workspace's tiling beside the
      focused window.
- [ ] Pin a window, **then** minimize it: it is out of the tiling and the other tile keeps the whole
      work area. Un-minimize it (from the overview or `Alt+Tab`): it is back on screen and **still**
      out of the tiling, because it is still pinned. Now un-pin it: only now does it rejoin, beside
      the focused window, exactly once — no duplicate leaf, no empty slot left behind.
      (The order is forced by GNOME, not by i3-shell: a minimized window has no title bar and cannot
      be focused, so neither `Alt+Space` nor a title-bar menu can reach *Always on Visible Workspace*
      while it is minimized — hence pin first and un-pin last. This is the only box that walks two
      exclusion reasons at once, which is what the OR in the membership predicate exists for.)
- [ ] Do the pin/un-pin cycle five or six times on the same window: it lands in the tiling every
      time, and the journal shows no repeated `i3-shell` warning building up.

## A27 — no hand-edited GSetting anywhere in the above
- [ ] Everything in A23–A26 worked without your setting `workspaces-only-on-primary` yourself. (The
      `gsettings reset` in the setup and the deliberate `set true` in A22's last box are the only
      writes in this document; both are there to *test* the ownership, not to enable it.)
- [ ] On a machine where that key has never been touched — or after
      `gsettings reset org.gnome.mutter workspaces-only-on-primary` with the extension disabled —
      enabling i3-shell is enough to make the external display tile. Phase 2's A14 and Phase 3A's
      A20 both told you to set it by hand first; that instruction is now obsolete, and those two
      documents are historical records, not current guidance.

---

## Known limitations to expect — note them, do not file them

- **Workspaces span every output while i3-shell is enabled** (see the top of this document). Your
  original value comes back on `disable()` and on an orderly shutdown; if the shell dies without
  running `disable()`, the original stays in the extension's `overridden-settings` snapshot and is
  restored at the next opportunity, which is what A22's fourth box checks.
- **A window's kind is fixed at its first frame.** This phase made the facts that decide *tree
  membership* (`minimized`, on all workspaces, skip-taskbar) per-commit; it did **not** make the
  facts that decide *kind* (window type, transient, attached dialog, intrinsically resizable)
  per-commit. A dialog will not become a tile because you resized it, and a window that opened
  fixed-size stays floating for its whole life even if the application later allows resizing. Phase
  4 (main spec §8.2, Phase 3B design §3.4).
- **Un-pinning pins the floating state.** A window returning to the tree has the floating state it
  left with written into the engine's explicit `_manualFloating` map, turning a derived state into a
  pinned one (main spec §7.10). Today that cannot be observed — kind cannot change, so the pinned
  value always equals what would be derived. It is recorded because it stops being harmless the
  moment Phase 4 makes `transient` or `attached` mutable.
- **A skip-taskbar window is treated like a pinned one, but only if it would otherwise tile.** A
  modal dialog reports `skip_taskbar` to Mutter as well, and it must keep floating rather than
  disappear from both the tree and the floating list; the predicate is gated on the window's kind
  for exactly that reason (main spec §8.2). If you ever see a dialog vanish instead of floating,
  that *is* a defect and belongs in your report.
- **There is no i3 `sticky` command.** i3-shell does not add one, and pinning stays GNOME's
  operation through the window menu.
- **Phase 3A's limitations are unchanged** and still apply: the border overlaps its client's
  outermost pixels, `border toggle` is two-state, a monitor bar is never shorter than 28px, the
  title row does not re-measure on a text-scaling change, and a monitor showing a fullscreen window
  shows no i3-shell chrome at all. See `docs/acceptance/phase-3.md`.

## Automated evidence (not acceptance)

Run with `bash test/integration/run.sh` on 2026-09-23 in a private nested GNOME Shell — separate
bus, settings, runtime and Wayland socket, never the live session. **254 assertions, exit 0, no
native criticals, and no `LIMITATION` line: every scenario reached the state it set out to reach**
(228 before this phase). It ticks nothing above.

| Scenario | What it pins | Result |
|---|---|---|
| Retained Phase 1, 2 and 3A checks (A1–A21) | unchanged tiling, sessions, settings, decorations, name conflict | passed |
| `scenario_membership`, two virtual outputs (8 assertions) | `workspaces-only-on-primary` reads `false` because the *extension* wrote it — the harness no longer seeds it, so this is the native proof of the ownership; a window tiles on the secondary output with its frame inside that monitor's work area; the primary→secondary→primary→secondary round trip keeps the same window id and re-tiles every time | passed — `ok A22 the extension cleared workspaces-only-on-primary: False` |
| `scenario_membership`, the sticky fact itself | with GNOME's default forced back on by hand, Mutter really does re-mark a **live** window `on_all_workspaces`; it then leaves the tree while staying tracked, and is in no floating list either; clearing the setting returns it to the secondary output's tiling | passed — and these two lines are the phase: `ok MB a sticky window is still tracked, under the same id: 1` / `ok MB the window rejoins the secondary tiling when sticky clears`. Before this phase that window was dropped on the first move and never seen again |
| `settings_scenario` (`--settings`) | `workspaces-only-on-primary` is `true` (GNOME's own default) before the first enable, `false` after it, the original value again after `disable()`, and `false` again after a re-enable — the same snapshot/restore machinery as the IBus hotkeys, asserted against the real schema | passed |
| Native-critical gate | no GJS/Mutter `CRITICAL` across the membership round trips, the sticky transitions, enable, disable and shutdown | passed — a window that is tracked but in no tree, which is new in this phase, provoked none |

Assertions by group in that run: DC 18, MX 8, FS 8, TS 10, GS 11, MM 13, **MB 8**, ST 1.

Unit suite alongside it: **564 tests in 48 files**, both TypeScript programs clean, Layer 0 import
gate and tree lint. What they pin, layer by layer, stated exactly:

- `classifyWindow` returns `null` for **one** reason only, an ignored window type. It cannot be
  asked about a sticky window at all any more: `sticky` left `WindowFacts`, so no test at that
  signature can even express one, and none claims to.
- The tracker allocates an id and **keeps the change watch** for every admitted type — `normal`,
  `dialog`, `modal-dialog`, `utility` — and disposes both watches with no id only for `'ignored'`.
  That is the narrowed contract: the drop path now has exactly one entrance.
- `WindowInfo` is re-read live. The adapter test flips `on_all_workspaces` and `skip_taskbar` on a
  fake window and reads the new values straight back **with no signal emitted at all**, which is
  what "per commit, never cached" means; separately, the two `notify::` handlers emit `'membership'`
  and are disposed with the rest of the window's handlers.
- `windowFacts()` no longer reads `is_on_all_workspaces()` or `is_skip_taskbar()`.
- The engine composes the three exclusion reasons: each alone, two together, rejoining only when the
  last clears, returning the window beside the focused one — and now also *not* unmaximizing and not
  rect-correcting a window that any reason excludes.

No unit test proves that Mutter really re-marks a live window `on_all_workspaces`, or that a window
dragged between displays survives it. The native scenario above is the only automated evidence for
either, and A23–A26 are the only evidence on real hardware.

**What the automation deliberately does not cover:**

- **A real display.** Every automated output above is a `--virtual-monitor` inside a headless nested
  shell. No test docks, undocks, closes a lid, or mixes resolutions and scale factors. **A25 is the
  only evidence that unplugging a physical display keeps the window**, and A23's "drag a window onto
  the external display" is the only evidence that a real drag — rather than the harness's
  float-move-unfloat sequence — produces the same tiling.
- **A window whose *first frame* happens on the secondary output.** That is the case that used to
  drop a window permanently, and a Wayland client cannot ask to be mapped on a chosen output, so the
  harness cannot construct it. It reaches the equivalent state by moving a window there and by
  flipping the setting under a live window; the "open a window while the external display is
  focused" box in A23 is the only check on the real thing.
- **Pinning through GNOME's UI — nothing here is the user's own action.** The harness has no
  pointer and no window menu. It reaches a sticky window by writing
  `workspaces-only-on-primary = true` into the private session's settings **from a second process**,
  which makes Mutter set the same `on_all_workspaces` fact on a live window; that much is real, and
  it is what the two `MB` lines above assert. But a real user pins **one** window through GNOME's
  window menu, which is a different route to the same fact and is exercised by nothing in this
  repository. Nothing automated covers the menu item, pinning one window among several, or un-pinning
  on a *different* workspace than the one it was pinned on. A26 is the whole coverage for those.
- **`skip_taskbar` on a real application.** The suite's evidence is a GTK modal dialog (scenario
  A13) plus unit tests; no real-world utility window that sets `skip_taskbar` and would otherwise
  tile has been seen leaving and rejoining the tiling.
- **What the setting change does to other applications.** Nothing asserts that GNOME's own
  workspace switching, the overview, or another tiling-unaware application behaves sensibly with
  `workspaces-only-on-primary = false`. That is the consequence stated at the top of this document
  and the walk is its only review.
- **IBus is suppressed in the harness** and **Xwayland clients are unverified** (`--no-x11`), both
  carried forward from Phase 2.

## The user's report

_To be filled in by the user after the walk._
