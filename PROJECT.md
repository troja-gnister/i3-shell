# i3-shell — project handbook

Everything needed to get up to speed on this project and finish it. Read this first; it points at the
detailed documents rather than repeating them.

**Goal:** a GNOME Shell 50 extension that gives GNOME the i3 window-manager experience — i3's workspace
model, i3's keybindings read straight from `~/.config/i3/config`, and i3's dynamic container-tree tiling
with directional navigation. Three things are the non-negotiable core: **workspace management**,
**shortcuts**, **dynamic tiling**. Phases 1 and 2 deliver that core; Phases 3 and 4 add appearance and
fidelity.

**State (2026-09-21):** Phase 1 (Foundation) is implemented, reviewed and merged into `main`, with the two recovery fixes in `19eac12` and `7bb138b`. The user reported the full live A1–A7 walk green on 2026-09-21. The user resumed Phase 2A; its pure-tree implementation and delivery checks are complete on branch `phase-2`. Tasks 1–7 are reviewed and committed, while Task 8 review/commit, the whole-branch review and integration into `main` remain pending. Phase 2B window/geometry integration has not been planned or built, so live A8–A14 acceptance remains unclaimed. Phases 3–4 are designed but not yet planned in detail or built.

---

## 1. Where things live

| Path | What |
|---|---|
| `docs/superpowers/specs/2026-09-20-i3-shell-design.md` | **The design spec — the binding authority** (19 sections: acceptance criteria A1–A14, architecture, config grammar, command language, the tree algorithms, window lifecycle, workspaces, keys, indicator, decorations, GNOME overrides, D-Bus, error handling, testing, phases, toolchain, decisions log). |
| `docs/superpowers/plans/2026-09-20-phase-1-foundation.md` | The Phase 1 implementation plan (14 TDD tasks with full code). Several of its code blocks were wrong and were fixed during execution — where plan and code differ, the code (and the carry-forward doc) wins. |
| `docs/superpowers/plans/2026-09-21-phase-1-carry-forward.md` | Execution record: every ruling made while building Phase 1, items deferred to Phases 2/4, security note. **Read before planning Phase 2.** |
| `docs/superpowers/plans/2026-09-21-phase-2a-tree.md` | Phase 2A pure-tree plan, preparation audit and execution record. Implementation and delivery checks are complete on `phase-2`; Task 8/final review and integration remain pending. Window lifecycle and geometry integration follow in Phase 2B. |
| `docs/acceptance/phase-1.md` | The live-session checklist for A1–A7, passed by user report on 2026-09-21. |
| `README.md` | User-facing: install, control via D-Bus, dev commands. |
| `src/` | The extension (TypeScript, see §4). |
| `test/unit/` | vitest tests on Node (pure core only) incl. `fixtures/reference.i3config` — a byte-identical copy of the user's real i3 config, used as a golden test. |
| `test/integration/` | Nested-shell harness (`nested.sh`, `inside.sh`) and the Phase 1 scenarios (`phase1-checks.sh`). |
| `schemas/`, `metadata.json`, `stylesheet.css`, `esbuild.mjs`, `Makefile`, `tsconfig*.json` | Build and packaging. |

The user's i3 config (`~/.config/i3/config`) is the source of truth for behaviour and stays outside the repo.

## 2. Environment facts (verified on the target machine — do not re-derive)

- Fedora Silverblue 44, GNOME Shell 50.5, Mutter 18, **Wayland only** (X11 session gone since GNOME 49). The extension installs as a symlink in `~/.local/share/gnome-shell/extensions/i3-shell@troja` → `dist/`; nothing is layered with rpm-ostree.
- Wayland cannot reload extension code in place: after `make install`, **log out and back in**. `gnome-extensions disable/enable` re-runs `disable()/enable()` on the old module. The fast loop is the nested shell (`bash test/integration/nested.sh -- <cmd>`; `--visible` for a window, `--keep` to retain the sandbox log).
- `gnome-shell --nested` no longer exists; nested is the default mode. The harness uses `gnome-shell --headless --wayland --virtual-monitor 1920x1080` inside `dbus-run-session` with `XDG_*` dirs in a temp sandbox and `GSETTINGS_BACKEND=keyfile` (keyfile at `$XDG_CONFIG_HOME/glib-2.0/settings/keyfile`), so it never touches the live session.
- gnome-shell enables extensions **before** `layoutManager`'s `startup-complete` sets `Main.actionMode`; keybindings are filtered while the mode is `NONE`. A window-less session rests in `OVERVIEW` (2). Grabs are allowed for `NORMAL | OVERVIEW`. The first-run Welcome dialog is a modal — the sandbox suppresses it via `welcome-dialog-last-shown-version`.
- Every grabbed accelerator needs `Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW)` or the shell silently drops it (see the shell's own `shellDBus.js`).
- At enable, ~25 of the 65 default-mode grabs collide with mutter's own bindings until the cleared GSettings propagate; a retry backoff (500 ms, 1.5 s, 4 s) picks them up. Keys held by `gsd-media-keys` (`XF86Audio*`, brightness) take longest.
- `@girs/gnome-shell@50.0.4` provides the GNOME 50 types but pins `@girs/*@^4.x` — do not add those packages separately (5.x collides). `@girs` mistypes `Main.actionMode` as the literal `NONE`; the one sanctioned cast is `Main.actionMode as Shell.ActionMode`.
- `npm install` needs `legacy-peer-deps=true` (`.npmrc` has it) — npm's arborist crashes on `@girs`'s peer graph ("Cannot read properties of null (reading 'edgesOut')").
- Mutter 18: `Meta.Window.maximize()` takes no flags; state comes from `maximized-horizontally`/`-vertically`. No `set_decorated` on Wayland (title bars cannot be stripped). `Meta.WindowActor` has `first-frame`; `Meta.Display` has `accelerator-activated` (both verified at runtime).
- The shell's JS lives in `/usr/lib64/gnome-shell/libshell-18.so`'s GResource; extract with Python `ctypes.CDLL` + `Gio.resources_lookup_data('/org/gnome/shell/ui/<file>.js')` when you need to read `main.js`, `windowManager.js`, `panel.js`, `messageTray.js`, `sessionMode.js`, etc.
- 32 GNOME default bindings collide with the reference config (e.g. `<Super>1..9` app switching, `<Super>h` minimize, `<Super>l` lock, `<Super>space` input source, `<Super>Left/Right` snap, `<Super>Up/Down` maximize, `<Super>a/s/v`, the XF86 keys). They are cleared dynamically and restored on disable (spec §13).

## 3. Toolchain and commands

```sh
npm ci                      # or npm install; .npmrc sets legacy-peer-deps
npm test                    # vitest on Node — pure core + fake Gio adapter tests (64 tests)
npm run typecheck           # two programs: tsconfig.json (src, GNOME types) + tsconfig.test.json (tests + Layer 0, Node types)
npm run check:layer0        # fails if Layer 0 imports gi:// / resource:// / src/shell (also part of `npm run build`)
npm run build               # release bundle → dist/  (esbuild, single ESM file; schemas compiled)
npm run build:test          # same with __I3SHELL_TEST__=true → exports org.i3shell.Debug (PressKey, SimulateSessionMode)
npm run test:integration    # nested headless shell: phase1-checks.sh (A1, A3, A4, A5, A7), ~1 min; leaves a TEST build in dist/
make install                # release build + symlink; then log out/in and `gnome-extensions enable i3-shell@troja`
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell     # every line is prefixed [i3-shell]
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "workspace number 3"          # the i3-msg equivalent
```
Other D-Bus methods: `GetState` (mode, activeWorkspace, workspaceCount, grabbed, configSource/Path, errors, warnings, actionMode, ready), `GetConfigStatus`.

Always finish a session with a **release** `make install` if you ran the integration suite — it leaves a test build in `dist/`.

## 4. Architecture (as built)

Three layers; the rule that makes the project testable: **Layer 0 never imports `gi://`, `resource://` or `src/shell/`** (`scripts/check-layer0.mjs` enforces it).

```
Layer 2  src/extension.ts     enable()/disable() wiring (rolls back on a failed enable)
         src/engine.ts        Engine: current config + mode, command dispatch, reload, lock/unlock —
                              talks to GNOME only through EnginePorts (unit-tested with fake ports)
Layer 1  src/shell/keys.ts            KeyBinder: grab_accelerator/ungrab, retry backoff, accelerator-activated dispatch
         src/shell/settings.ts        SettingsOverrides: enumerate 5 keybinding schemas, clear colliding accels,
                                      static workspaces + names, mouse-button-modifier; crash-safe JSON snapshot in
                                      the extension's `overridden-settings` key; restoreAll() on disable/reload
         src/shell/workspaces.ts      count/active/activate/isOccupied + change events (watches existing windows too)
         src/shell/windows.ts         Phase 1 stub: kill/fullscreen/move the focused window (Phase 2 replaces it)
         src/shell/indicator.ts       PanelMenu.Button with St.Button pills + mode label; hides the Activities button
         src/shell/session.ts         lock/unlock edge detection on Main.sessionMode 'updated' (+ simulate() for tests)
         src/shell/configLoader.ts    file → cached last-good ($XDG_CACHE_HOME/i3-shell/last-good.config) → built-in fallback
         src/shell/control.ts         D-Bus org.i3shell.Control (+ Debug in test builds only, tree-shaken from release)
         src/shell/{log,notify,exec}.ts, src/shell/util/signals.ts (SignalTracker + guard())
Layer 0  src/config/{lexer,variables,parser,resolve,accel,overridePlan,defaultConfig,index,model}.ts
         src/commands/{model,parse}.ts
         src/util/{text,bindingDiff}.ts
```

Config pipeline: `logicalLines` (whole-line `#` comments, `\` continuation) → `substituteVariables` (all `set` lines collected first, whole-file substitution, longest name first — i3 semantics) → `parse` (directives; three tiers: unknown → error/reject, valid-but-unimplemented → warning/skip, cosmetic like `font`/`bar {}` → silent) → `resolve` (bindings with Mutter accelerators, modes, colours, rules, workspace names/count) → `Config`. Errors reject the file; the previous config keeps running.

Key semantics already decided (spec §19 decisions log): parse the real i3 config (no GSettings UI); config wins over GNOME defaults; overlay key (Super tap) untouched; maximize → unmaximize+retile; minimize → detach; fullscreen native; tabbed/stacked = same rect + raise; floating not forced above; workspace→monitor→cons level order; session-modes `user`+`unlock-dialog` with ungrab on lock; commit trailers name the authoring model.

## 5. What is done — Phase 1 (Foundation)

Delivered in 31 commits (`e4628e2..463ca10`, now on `main`; the `phase-1` branch was merged and deleted): toolchain; config lexer/parser/resolver with the golden test against the real config (65 default + 11 resize-mode bindings, zero diagnostics); command parser; engine; accelerator binder; dynamic GNOME override + snapshot/restore; static workspaces with names; pill indicator; lock handling; config loader; D-Bus; nested-shell harness with automated scenarios; README and checklist.

Verification: unit 52/52; typecheck both programs; `npm run test:integration` green (workspace switching by real key press, `exec`, resize-mode entry/exit with bare-key grabs, reload rejection and acceptance with a newly grabbed binding, lock/unlock). A whole-branch review ended "with fixes"; the fix wave landed and re-reviewed clean.

**Live acceptance passed:** the user reported all A1–A7 checks green on 2026-09-21, with no Phase 1 findings. `docs/acceptance/phase-1.md` records that report and its provenance. Dynamic tiling and tiled-window resizing remain Phase 2 work.

The follow-up fixes restore last-good-cache recovery for a missing config at startup and preserve saved GNOME settings when restoration fails. Fake-`Gio.Settings` apply/restore/crash-recovery coverage and ConfigLoader regression tests are included in the 64-test Phase 1 baseline. Remaining deferred items are listed in the carry-forward doc. The live Phase 1 acceptance checkpoint is satisfied. Phase 2A now has 234 passing unit tests on `phase-2`, including the preserved Phase 1 regressions; its review and branch-integration gates remain open.

## 6. What remains — Phases 2, 3, 4

Each phase gets its own implementation plan (`docs/superpowers/plans/`) written from the spec, executed task by task with review. The spec sections below are complete designs, not sketches.

### Phase 2 — the tree (dynamic tiling) — spec §7, §8, §16.1–16.2, acceptance A8–A14
The hard one; it is what makes this "i3".

Phase 2A now implements the pure `src/tree/` subsystem on `phase-2`: ownership and normalization, exact layout and stacking order, focus traversal, split/layout/move operations, transactional resize, floating membership and workspace transfer. The bounded property suite runs 300 sequences for each fixed seed `20260921` and `8675309`, with up to 100 operations over ids 1–12, two workspaces and odd/tiny geometry. Delivery verification passed 234/234 tests, both TypeScript programs, the Layer 0 boundary check, tree lint and a release build. This is pure-model evidence only; Task 8 review/commit, whole-branch review and merge into `main` are still pending.

- `src/tree/{node,tree,layout,focus,operations,resize}.ts` (Layer 0): `WorkspaceCon → MonitorCon(root) → SplitCon|LeafCon`; `percents`, `focusedChild`, `lastSplitLayout`; `normalize()` with i3's `tree_flatten` rule (a lone leaf in a split is legal — pending split); `Tree.check()` invariants.
- Algorithms are specified step by step in §7.3–§7.11: insertion after the focused leaf; `split` (no pointless nesting); `layout` (workspace roots wrap children for tabbed/stacked); `focus <dir>` = i3's `_tree_next` with wrapping at the highest matching level; `move <dir>` = i3's `tree_move` with worked examples; resize in ppt with 5 %/95 % clamps; fullscreen native; floating layer + `focus mode_toggle`; layout as exact integer rects (tabbed/stacked = same rect, active raised).
- `src/shell/windows.ts` becomes the full adapter (§8): opaque window ids only (`Map<id, Meta.Window>` + `WeakMap`), insert on the actor's `first-frame`, expected-rect tracking to stop resize feedback loops, focus-follows-GNOME updating the `focusedChild` chain, minimize/maximize/fullscreen/workspace-changed handling (engine-initiated moves carry an "expected workspace"), monitors-changed relayout; `src/shell/geometry.ts` applies rects with `move_resize_frame`.
- `engine.commit()` becomes the single mutation pipeline: normalize → layout → diff rects → apply → decorations/indicator update → `TreeChanged` signal. Adoption of existing windows in MRU order on enable/restart.
- D-Bus: `GetTree()`, `GetWindows()`; `restart` rebuilds the tree.
- Tests: Phase 2A has deterministic scenarios, exact-rect tests, the §7.6–7.7 worked examples and bounded `fast-check` properties for all pure facades. Phase 2B must add integration scenarios A8–A14 using a small GJS/GTK4 test-window program (Gtk 4 typelib is installed). Real i3 is still installed (`i3` layered package) and can serve as an oracle under Xvfb for disputed semantics.
- Phase 2A added the pinned `eslint` and `fast-check` development tooling.

### Phase 3 — layouts & appearance — spec §12
`src/shell/decorations.ts`: per-leaf `St.Widget` borders in `global.window_group` sized to the leaf rect with `client.*` colours (focused / focused_inactive / unfocused / urgent), a single frame around a focused SplitCon, `default_border pixel N` and the `border` command (`normal` treated as `pixel`); tab/stack bars as `St.BoxLayout` of titles above tabbed/stacked containers (children get rect minus bar; click focuses). All actors created/updated/destroyed only from `commit()`.

### Phase 4 — fidelity — spec §17
`for_window` rules applied at first-frame (`floating enable`, `border`, `resize set`, `move position center`, `move container to workspace`); `workspace_auto_back_and_forth` / `back_and_forth`; urgent pills (`window-demands-attention`); multi-monitor (per-monitor focus/move across MonitorCons, `workspaces-only-on-primary`); `focus_follows_mouse` ↔ `org.gnome.desktop.wm.preferences focus-mode`. Marks and scratchpad stay outside v1. Also: user-defined GNOME shortcuts (`custom-keybindings` relocatable schema) are not yet enumerated by the override scan; the criteria regex stops at the first `]`.

Target arrangements: laptop alone (`eDP-1`) and docked with external display(s), lid closed. Windows migrate off the internal display when inactive and return on undock. Existing `~/Dev/i3-display-manager` and `~/Dev/i3-lid-sleep` (also installed in `~/.local/bin/`) document expected transitions. Ask about scaling and exact resolutions when Phase 4 planning starts.

### Explicit non-goals (v1)
`bindcode`, `bindsym --release`, marks, scratchpad, `assign`, gaps, i3bar `status_command`/`bar {}`, top-level autostart `exec`, layout persistence across shell restarts, `resize set` on tiled containers, stripping title bars.

## 7. How to continue (process that worked)

1. Phase 1 live acceptance is recorded as passed; preserve its 64-test regression baseline, including the failed-restore and config-cache regressions, inside the current 234-test suite.
2. Finish the Task 8 review/commit and the Phase 2A whole-branch review, then integrate the reviewed `phase-2` branch into `main`. Do not treat delivery verification alone as review or merge evidence.
3. Write and execute the Phase 2B window lifecycle/geometry integration plan against the implemented Tree interfaces. Phase 2 is complete only after live tiling/resizing and A8–A14 acceptance are delivered.
4. Continue with `superpowers:subagent-driven-development`: one implementer per task, a reviewer per task, and a whole-branch review at the end. Keep the ledger and record every ruling.
5. Verify claims before trusting them: type-check GNOME API usage against `@girs` in a scratch project, extract the shell's JS to check behaviour, and run the nested shell for anything runtime-dependent.

## 8. People and conventions

- Author/owner: `troja-gnister <iskrydev@gmail.com>` (repo-local git identity). GitHub remote to be added by the owner; do not push without being asked.
- License GPL-2.0-or-later (required by extensions.gnome.org; also lets Forge/Tiling Shell be read as references — no code is copied).
- Commits: conventional subjects (`feat(config): …`, `fix(shell): …`, `test: …`, `docs: …`); trailer `Co-Authored-By: <the model that authored it> <noreply@anthropic.com>`.
- Branching: `main` holds reviewed phases; work on `phase-N` branches in this directory (the Makefile symlinks `$(CURDIR)/dist`, so a separate worktree would confuse the live install).
