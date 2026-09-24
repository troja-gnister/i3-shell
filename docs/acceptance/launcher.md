# Launcher acceptance — live session

**Product revision:** branch `launcher`, ten tasks, base `0bbce0d` (`git rev-parse --short HEAD` to
confirm). Adds a dmenu-style launcher drawn in-process: `src/launcher/**` (Layer 0 — model,
catalogue, matching, key map, the row window, recency), `src/shell/launcher.ts` (the actor, the
modal grab and spawning) and `src/shell/appCatalogue.ts` (`Shell.AppSystem` plus a `$PATH` scan).
**Build under test:** release `make install` (no `org.i3shell.Debug` interface or methods).
**Environment:** GNOME Shell 50.5 / Mutter 18, Wayland, Fedora Silverblue 44, laptop panel
1728×1048 plus an external display 1920×1080. **The external display is required for A29/A30 and
hand-checks 6–7.**
**Date prepared:** 2026-09-24. **Result: not walked yet.**

Nothing in this repository ticks these boxes. The automated suite at the end is separate evidence
and is listed only so the walk can concentrate on what automation cannot reach: this feature exists
because the user's previous launcher always opened on the *primary* monitor (menu anchored to a
panel button that only exists there) or followed the *pointer* (which, for a keyboard-driven
workflow, is routinely on the other screen). The launcher documented here opens on the monitor
holding the **focused container**, resolved from i3-shell's own tree, and that specific claim is
pinned against a real compositor — see "What the native suite already proves" below.

---

## Read this before you start

**You will need to log out.** Wayland cannot reload extension code in place, so
`gnome-extensions disable`/`enable` on an old build does not give you the new one. Build, log out,
log back in, and only then start the walk.

```sh
make install                      # release build + symlink
# log out and back in — Wayland cannot reload extension code in place
gnome-extensions enable i3-shell@troja
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell   # in a second terminal
```

**Add the binding.** The reference config used by this project's own tests does not bind the
launcher, and your live `~/.config/i3/config` may not either. Add, or confirm you already have:

```
bindsym $mod+d launcher --term $term
```

`$mod` is `Super`. If `$term` is not already `set` in your config, either set it (e.g.
`set $term kitty`) or bind without `--term` and skip the `Shift+Enter` boxes (A33, hand-check 12)
— without `--term`, that action is deliberately a no-op plus one log line, not a missing feature.

**What the native suite already proves — do not re-derive it, just watch for it.** Confirmed
against a real compositor, with the pointer never moved:

- the launcher opens inside the work area of the monitor holding focus;
- it is not on the primary output when focus is elsewhere;
- a workspace binding does not fire while the launcher is open — this assertion can fail: reverting
  the launcher's grab from `Shell.ActionMode.POPUP` to `NORMAL` made it fail with
  `got 1, want 0`, so a passing run is real evidence, not a vacuous one;
- focus returns to the window that had it when the launcher closes;
- the grab is released — a binding works again immediately afterwards.

**What only this walk can confirm.** Everything about how it looks and feels: rendering, the accent
colour matching the workspace pills and window borders, icons, the row window and scrolling, the
search entry having no visible caret (deliberate — a focusable entry would close the launcher when
clicked, see hand-check 30), the terminal wrapping on `Shift+Enter`, the dmenu fallthrough that runs
typed text when nothing matches, recency ordering across a logout, and every keyboard behaviour
except the single binding-suppression case above.

**A leaked keyboard grab is recoverable only by killing the shell.** The grab/teardown boxes below
(1–5 in the "Grab and dismissal" group) are the ones to do carefully and in full, not skim.

---

## A28 — the binding opens it, and the config is clean
- [ ] With `bindsym $mod+d launcher --term $term` in the config, reload (or start with) it: no
      config error and no warning in the journal for that line.
- [ ] Press `$mod+d`. A box actually appears on screen. (Every other box below silently assumes
      this one passed — if the launcher never appears, check the journal for
      `launcher: the modal grab was refused` before doing anything else.)

## A29 — focus on the external display places it there
- [ ] Park the pointer on the laptop panel. Focus a window on the external display (click it, or
      focus-key your way there). Press `$mod+d`: the launcher appears on the **external** display,
      inside its work area, not under the pointer.

## A30 — focus on the laptop panel places it there
- [ ] Park the pointer on the external display. Focus a window on the laptop panel. Press `$mod+d`:
      the launcher appears on the **laptop panel**, inside its work area, not under the pointer.

## A31 — typing narrows to an app, Enter launches it
- [ ] Type `fire`: Firefox is selected (or the top match if Firefox is not installed — note which).
- [ ] Press `Enter`: it launches, and the launcher closes.

## A32 — a Flatpak is found and launched
- [ ] Type `steam`: the Flatpak-installed Steam appears in the list with its icon.
- [ ] Press `Enter`: it launches.

## A33 — Shift+Enter runs a binary in the terminal
- [ ] Type `htop` and press `Shift+Enter`: a terminal window opens with `htop` running inside it
      (`<term> -e htop`).

## A34 — no match falls through to a shell command
- [ ] Type a command that matches nothing in the list (e.g. a shell one-liner or a binary name you
      know is not installed) and press `Enter`: it runs verbatim, the way `dmenu_run` would.

## A35 — a workspace binding does not fire while the launcher is open
- [ ] With the launcher open, press `$mod+1` (or any bound workspace number): the workspace does
      not change, and no digit appears in the search query. (Pinned natively by Task 9 — see above
      — this box is the human confirmation of the same claim.)

## A36 — Escape dismisses cleanly
- [ ] With something typed and a row selected, press `Escape`: the launcher closes, nothing
      launches, and the window that had focus before you opened the launcher has it again.
- [ ] The tiling is unchanged — no window moved, resized, or changed stacking order.

## A37 — opening the launcher does not disturb the tiling
- [ ] With two or more tiled windows visible, open the launcher: no tile resizes, reflows, or
      changes position while the launcher is up or after it closes.

## The catalogue and the key map (implied by the spec, not separately numbered there)
- [ ] Press `$mod+d` with nothing typed: the list is populated with applications (not blank), and
      it is recency-ordered — launch something, close the launcher, reopen it, and that item is
      first.
- [ ] Type a few characters: the list narrows to matching items as you type.
- [ ] Highlight an item with `Down` and press `Tab`: the query is completed to that item's full
      name.
- [ ] `Ctrl+n` moves the selection down and `Ctrl+p` moves it up, the same as `Down`/`Up`.
- [ ] The selected row's highlight is the same accent colour as the active workspace's pill in the
      bar and the focused window's border — look at all three together and confirm they agree, and
      confirm they still agree if you change the GNOME accent colour while the launcher is open.

## Grab and dismissal — the dangerous ones, check these carefully
1. - [ ] Open the launcher and press `Escape`. Immediately type into a terminal: the keyboard must
        work normally. Repeat this open/close/type cycle **ten times in a row**: no stray actor is
        left on screen, and the keyboard is never captured afterwards. A leaked grab here is the
        failure mode that would cost you the session — it is recoverable only by killing the shell,
        so do the full ten reps rather than stopping early.
2. - [ ] Open the launcher, then from a TTY or another seat run
        `gnome-extensions disable i3-shell@troja` while it is still open: the session stays usable
        and the journal shows no `incorrect pop`.
   - [ ] Re-enable and open the launcher, then lock the screen (`$mod+Shift+x` or your usual lock
        bind): the launcher is gone on unlock, and the keyboard works on the lock screen itself.
3. - [ ] Open the launcher, then reload the i3 config (however your config reload is bound): the
        launcher closes.
4. - [ ] Hold `$mod+d` down past the keyboard repeat delay (about half a second) instead of
        tapping it: the launcher appears and **stays** open — it must not flicker open and
        immediately close from the held key's auto-repeat.
5. - [ ] Type `fire`, press `Delete`, then `Enter`: nothing is added to the query (no invisible
        character), and the item that launches is the one that was selected — not a shell spawn of
        `fire` plus a stray character. Check the journal for a failed command if anything looks
        wrong.

## More keyboard behaviour
- [ ] Select something recognisable, then press `$mod+Return`: the launcher closes and **nothing
      launches** — in this user's config `$mod+Return` opens a terminal, so an accept here would be
      an arbitrary process spawn. `$mod+Up` and `$mod+Down` must likewise dismiss rather than move
      the selection.
- [ ] Press `Alt+Tab` while the launcher is open: it dismisses. Nothing is typed into the query and
      no completion happens.
- [ ] Press `$mod+d` a second time while the launcher is open: it closes (no launch).
- [ ] Press and release `Super` alone: the GNOME overview does not open behind the grab, and the
      launcher stays open with the keyboard still captured.
- [ ] Hold `Down` past the tenth row (`VISIBLE_ROWS` is 10): the viewport scrolls to keep the
      selection visible and the highlight never disappears. Hold `Up` back to the top.

## Mouse and focus edge cases
- [ ] Click a row with the mouse: it launches, and the click does not double-fire or get swallowed.
- [ ] Click inside the search entry itself: the launcher stays open (it is deliberately
      non-focusable, so this does not behave like a normal text field — see below).
- [ ] Click outside the launcher: on the desktop, on another window, and on the launcher's own
      padding (inside the box but not on a row). Confirm what happens in each case — under the
      current design none of these three is expected to dismiss it, which may surprise a dmenu
      habit; note if that reads as wrong rather than just unfamiliar.
- [ ] Trigger a GNOME modal mid-search — a polkit prompt, or click a notification banner. Afterwards
      the keyboard works normally and the journal has no `incorrect pop`.
- [ ] Accept an item (`Enter`) and immediately press the opening chord again within an instant: the
      new launcher opens and stays open — it must not be closed by a leftover close from the one
      that just accepted.

## Appearance
- [ ] The search entry shows no blinking caret even while it holds typed text — this is deliberate,
      not a bug (a focusable entry would close the launcher on click). Confirm it still reads as "a
      search box with your text in it" rather than as broken.
- [ ] Icons render for applications; a `$PATH` binary with no `.desktop` entry gets a generic icon.
- [ ] Type a very long `$PATH` binary name: check whether a horizontal scrollbar appears inside the
      row list and eats a row's worth of vertical height. Note it either way.
- [ ] On a HiDPI or fractional-scale display, the box is centred horizontally and sits roughly an
      eighth of the way down the work area, and no row's text clips.

## Recency across a logout
- [ ] Launch something distinctive (e.g. an app you rarely use), then log out and back in. Open the
      launcher with an empty query: that item is still ranked ahead of items you have not launched,
      confirming recency survived the restart (it is persisted in a GSettings key, not held only in
      memory).

---

## Known limitations to expect — note them, do not file them

- **No fuzzy subsequence matching.** Prefix and substring matching only, by design (spec §4.1) — a
  poor fuzzy scorer ranks worse than none, and this can be added later without disturbing the tiers
  above.
- **Without `--term` configured, `Shift+Enter` is a no-op** plus one log line
  (`launcher: Shift+Enter needs a terminal`), logged once per session, not on every press.
- **Clicking outside the launcher does not dismiss it.** Under the stage grab this is a deliberate
  choice, not an oversight; it is one of the boxes above precisely because it may not match dmenu
  habits.
- **The launcher does not reclassify a window's kind or otherwise touch tiling state.** It only
  reads the focused container's monitor; nothing about tiled/floating membership changes because
  the launcher opened.
- **`launcher` is not a real i3 command.** A config from a real i3 installation using this same line
  would be rejected there; this is an accepted, documented divergence (spec §2.1), not something to
  file as a bug against i3 compatibility.

## Automated evidence (not acceptance)

Native suite, run in a private nested GNOME Shell with two virtual monitors — separate bus,
settings, runtime and Wayland socket, never the live session: **261 assertions, exit 0, zero
criticals** (baseline before this branch: 254). The launcher's own scenario contributes 7 of those
assertions (prefixed `LA`): the box opens inside the primary work area, the same command closes it,
it follows focus to the second output and is not on the primary output there, a workspace binding
does not fire while it is open (confirmed non-vacuous — reverting the grab's action mode from
`POPUP` to `NORMAL` makes this assertion fail with `got 1, want 0`), focus returns to the window
that had it on `Escape`, and the grab is released so bindings work again afterward. It ticks nothing
above.

Unit suite alongside it: **726 tests in 58 files**, both TypeScript programs clean, Layer 0 import
gate. This is where the reducer, the key map, the catalogue merge/dedup, every ranking tier and
tie-break, and `launcher --term` parsing are pinned — everything in `src/launcher/**`, which is pure
and excluded from no test file. `src/shell/launcher.ts` (the actor, the grab, spawning) is Layer 1
and is outside `tsconfig.test.json`'s reach entirely; nothing there is proven by any automated
suite except the seven native `LA` assertions above. That is the entire reason this document's
"Grab and dismissal" and "Mouse and focus edge cases" sections exist.

**What the automation deliberately does not cover**, beyond what is stated inline above:

- Rendering, colour, icons and layout — nothing automated looks at a pixel.
- The dmenu fallthrough (A34), the Flatpak launch (A32) and the terminal launch (A33) as real
  process spawns — the native harness never presses `Enter` on a real catalogue entry, because
  doing so would spawn arbitrary processes inside the test session.
- Recency surviving a real logout — the GSettings key is real and unit-tested, but no automated run
  restarts the session to read it back.
- Every keyboard behaviour except the single binding-suppression case (`LA a workspace binding does
  not fire while the launcher is open`). `Tab`, `Ctrl+n`/`Ctrl+p`, `Delete`, held-key auto-repeat,
  `$mod+Return`/`$mod+Up`/`$mod+Down` dismissal, `Alt+Tab` dismissal, and the ten-cycle open/close
  grab check are all this walk's alone.
- A GNOME modal (polkit, notification) stealing focus mid-search — the one code path
  (`key-focus-out` → deferred close → `popModal`) that nothing else in this project's automated
  suite exercises.

## The user's report

_To be filled in by the user after the walk._
