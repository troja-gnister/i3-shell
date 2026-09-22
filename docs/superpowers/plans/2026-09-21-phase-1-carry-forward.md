# Phase 1 — execution record and carry-forward

Phase 1 (Foundation) was executed from `docs/superpowers/plans/2026-09-20-phase-1-foundation.md` on branch `phase-1`
(29 commits on top of `e4628e2`). Every task passed a spec + quality review; a whole-branch review ended
"with fixes", the fix wave landed (`0da16d4`, `bc21876`, `f79660f`) and its scoped re-review was clean.
Automated acceptance (`npm run test:integration`: A1, A3, A4, A5, A7 in a nested headless shell) is green.
**The live walk in `docs/acceptance/phase-1.md` (A1–A7 on the real desktop) passed by user report on 2026-09-21.** No Phase 1 findings were reported. Phase 2A was subsequently implemented, reviewed and merged into `main` on 2026-09-22, with 234 tests passing on the merged result. The [Phase 2B integration plan](2026-09-22-phase-2b-integration.md) is now prepared for written-plan review; implementation has not started.

## Follow-up analysis (2026-09-21, baseline `a41638f`)

At the start of the follow-up analysis, the live walk was pending. Fresh verification on that baseline: 52/52 unit tests, both TypeScript programs and the Layer 0 check passed. Integration was not rerun during this analysis.

Two defects were reproduced with in-memory adapter fakes and fixed in the follow-up:

- `SettingsOverrides.restoreAll()` cleared the entire persisted snapshot even when a restore setter returned `false` or threw. It now removes only successfully restored entries, retaining failed entries and unavailable schemas for a later retry. Fake-`Gio.Settings` tests exercise successful apply/restore, both failure paths across all saved value types, partial restoration, unavailable schemas, restart recovery and re-applying overrides after a crash.
- `ConfigLoader.load('initial')` skipped a valid last-good cache when the config file was missing or unreadable. Both cases now share the invalid-file recovery path: try the cache before the built-in fallback, keeping the not-found diagnostic as a warning. Regression tests cover cache recovery, absent/invalid caches, valid-file cache replacement and unchanged missing-file reload rejection.

Fix commits on `main`: `19eac12` (ConfigLoader) and `7bb138b` (settings restoration). Verification: 64/64 unit tests, both TypeScript programs, the Layer 0 check and a release build in a temporary checkout passed. Independent review of both fixes and their tests reported no findings. Integration was not rerun and the installed `dist/` was left unchanged during the user's live walk; run `make install` and log out/in before live retesting these commits.

The user authorized these two fixes on `main` while doing the live A1–A7 walk, and subsequently reported the full checklist green after confirming that tiling and tiled-window resizing belong to Phase 2. The acceptance record identifies the repository revision at that report; the exact loaded revision was not independently captured. The binding spec contains the approved Phase 2 clarifications. `2026-09-21-phase-2a-tree.md` plans the pure tree and property tests; window lifecycle and geometry integration follow in Phase 2B.

The binding spec now records the approved Phase 2 rulings: ignore splash windows, track fixed-size normal windows as floating, target engine-selected containers through `WindowId` adapter operations, and assert coverage/non-overlap only for split children (equal rects for tabbed/stacked children). Geometry reconciliation permits one corrective re-apply per expected-rect generation, then stops for stubborn clients. Fullscreen exit, unminimize, monitor changes and completion of engine-initiated unmaximize force a fresh application even for an unchanged expected rect; workspace changes use the normal diff. These are design amendments, not implemented Phase 2 behavior.

Phase 4 target arrangements: laptop alone (`eDP-1` was the only connected output when reported) and docked with external display(s), lid closed. Windows must migrate off the internal display when it becomes inactive and return to it on undock. Consult `~/Dev/i3-display-manager` and `~/Dev/i3-lid-sleep` (installed copies in `~/.local/bin/`) for the user's expected transitions. Ask about scaling and exact resolutions when Phase 4 planning starts, not earlier. Marks and scratchpad remain outside v1.

## Rulings made during execution (plan defects fixed on the branch)

1. Work on branch `phase-1` in the repo itself (no worktree): the Makefile symlinks `$(CURDIR)/dist` for the live acceptance.
2. Task 14's manual walk is the human's; its automated parts (release `make install`, checklist, README) were done by a subagent.
3. Commit trailers name the model that authored each commit (subagent commits carry their own model).
4. Nested-shell key presses only fire once `Main.actionMode` is NORMAL or OVERVIEW; gnome-shell enables extensions before `startup-complete`, a window-less session rests in OVERVIEW, and the sandbox must suppress the first-run Welcome dialog (`welcome-dialog-last-shown-version`). `GetState` reports `actionMode` + `ready`; the harness waits on `ready`.
5. `nested.sh` teardown made tolerant (`rm -rf … || true`) — a gvfsd race could turn a passing run into exit 1.
6. i3 variable substitution is whole-file (all `set` lines first), not order-dependent; the spec's wording was corrected.
7. `bar { … }` skipping tracks brace depth (`bar { colors { } }` is common).
8. The plan's fallback config has 25 bindings (its test said ≥ 26 — test corrected); tests get Node types through a separate `tsconfig.test.json` (`@types/node` declared; `src/shell/**` and `src/extension.ts` excluded from that program because Node's `global` clashes with the shell's); `check-layer0` also scans `src/global.d.ts`.
9. `log.error` prefixes every detail line with `[i3-shell]`.
10. `SettingsOverrides._remember` persists each original before the live mutation (crash-safe snapshot).
11. The indicator's raw `scroll-event`/`clicked` connects are wrapped with `guard()`.
12. The Debug D-Bus interface is constructed at the call site under `__I3SHELL_TEST__` and its export branch is guarded by the compile-time literal, so release bundles contain neither the class nor the XML (`grep -c 'name="org.i3shell.Debug"' dist/extension.js` → 0).
13. `KeyBinder` logs each retry round's result; grabs that collide with mutter's own bindings at enable succeed on retry.
14. All three D-Bus method bodies catch and log.
15. In the window-less sandbox, A1's move binding is proven via the command's "no focused window" reply; A4's bare `j` via the engine's "not implemented" log line; `wait_grabbed` guards post-reload counts.
16. Final fix wave: grab retry backoff `[500, 1500, 4000]` ms; pre-existing windows are watched at enable; README `config-path` command uses `GSETTINGS_SCHEMA_DIR`; `enable()` rolls back via `disable()` on failure; `reload` with a missing file is rejected (running config kept); notification wording "N config warning(s)"; A3 exec check; acceptance caveats.
17. Parked (cosmetic): `engine.ts` still logs "retrying once" (it is a 3-round backoff); a `phase1-checks.sh` comment still says "500 ms".

## Deferred to Phase 2 (from the final review's triage, in priority order)

- Completed in the follow-up above: fake-`Gio.Settings` unit coverage for `SettingsOverrides` apply / restore / crash recovery, including preservation of failed restores. Keep these regressions in the Phase 2 baseline.
- `settings.reset(key)` when a restored value equals the schema default, and `Gio.Settings.sync()` at the end of `restoreAll()` (logout-time disable).
- Fix the two parked log/comment texts (ruling 17).
- `assertNever` default in `resolve.ts`'s directive switch; lexer tests for EOF continuation / no trailing newline; a `set: missing value` diagnostic; relax `NAME_RE` (i3 accepts `$ws-1`, `$my.var`).
- Engine tests: numeric-name workspace branch, cache-source announcement; check `workspaces.activate()`'s result.
- Indicator: handle `Clutter.ScrollDirection.SMOOTH` (touchpads); consider CSS classes `active`/`occupied`/`empty` instead of inline styles.
- `KeyBinder`: `Main.wm.allowKeybinding` entries accumulate per grab (mode switches re-grab everything) — keep default-mode grabs and toggle only the mode set, or document.
- Seed the engine's `_locked` from `SessionWatcher.isLocked` at start; pass a `name_lost` callback to `bus_own_name`.
- `esbuild` `minifySyntax` (cosmetic); README: recovery steps if the extension is removed without ever being disabled (`overridden-settings` stays in dconf).
- Harness: A6 via `gsettings get` + `gnome-extensions disable/enable` over the private bus; A2 via a `pills` field in `GetState`.

## Deferred to Phase 4

- `for_window` criteria regex stops at the first `]` (a literal `]` inside a quoted value); user-defined GNOME shortcuts (`media-keys` `custom-keybindings` relocatable schema) are not enumerated by the override scan.

## Security note (final review)

`exec` runs `/bin/sh -c` on the user's own config; `org.i3shell.Control.Command` is reachable by any process on the session bus (the same exposure as i3's IPC socket; Flatpak apps with `--socket=session-bus` included). Acceptable for a user-session extension; documented in the README.
