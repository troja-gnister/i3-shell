# Phase 1 — execution record and carry-forward

Phase 1 (Foundation) was executed from `docs/superpowers/plans/2026-09-20-phase-1-foundation.md` on branch `phase-1`
(29 commits on top of `e4628e2`). Every task passed a spec + quality review; a whole-branch review ended
"with fixes", the fix wave landed (`0da16d4`, `bc21876`, `f79660f`) and its scoped re-review was clean.
Automated acceptance (`npm run test:integration`: A1, A3, A4, A5, A7 in a nested headless shell) is green.
**The live walk in `docs/acceptance/phase-1.md` (A1–A7 on the real desktop) is still to be done by the user.**

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

- A fake-`Gio.Settings` unit test for `SettingsOverrides` apply / restore / crash recovery — the one component that can damage user settings and is covered only by the harness and the live walk.
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
