# i3-shell — project handbook

Everything needed to get up to speed on this project and finish it. Read this first; it points at the
detailed documents rather than repeating them.

**Goal:** a GNOME Shell 50 extension that gives GNOME the i3 window-manager experience — i3's workspace
model, i3's keybindings read straight from `~/.config/i3/config`, and i3's dynamic container-tree tiling
with directional navigation. Three things are the non-negotiable core: **workspace management**,
**shortcuts**, **dynamic tiling**. Phases 1 and 2 deliver that core; Phases 3 and 4 add appearance and
fidelity.

**State (2026-10-01):** Phases 1, 2A, 2B, 3A and 3B are merged and pushed, and the user walked and passed the Phase 2 and Phase 3A checklists. Phase 3B's **live A22–A27 walk** is still outstanding ([docs/acceptance/phase-3b.md](docs/acceptance/phase-3b.md), 25 unchecked boxes). The launcher is implemented across ten reviewed tasks and awaits its **A28–A37 walk** ([docs/acceptance/launcher.md](docs/acceptance/launcher.md)). **Phase 4 is partial:** its Tasks 1–4 landed (`for_window` criteria matching and rule application, the five new window facts, urgent pills and the urgent border); its Tasks 5–10 were never executed and are annotated in the plan with where each one went instead. **Phase 5 — per-output workspaces — is implemented on branch `phase-5`** (Tasks 1–19, each reviewed, plus a five-defect bugfix round found on real hardware on 2026-09-30): each output owns its workspaces and shows exactly one, `focusedOutput` is first-class state, GNOME is pinned to two workspaces (`live` + the `attic`, since Mutter refuses to render a non-active workspace), `workspace <n> output <name…>` / `focus_follows_mouse` / `mouse_warping` are implemented, `focus output` / `move container to output` / `move workspace to output` are added, directional `focus`/`move` cross the display edge, and hotplug reassigns a lost output's workspaces with their layout intact and remembers where they came from. What remains there is the user's **live A50–A66 walk** — [docs/acceptance/phase-5.md](docs/acceptance/phase-5.md), deliberately unchecked — and the whole-branch review. Nothing from Phase 4 or Phase 5 is on `main`.

Latest verification (`phase-5`, measured by an actual `npm test` run at the tip of the branch, not arithmetic): **1160 tests in 71 files**, both TypeScript programs, the Layer 0 import gate and the tree lint, all clean. The nested suite **has** now been re-run for Phase 5 and is green: **637 integration assertions, exit 0, zero `LIMITATION` branches**, at `863a8ec` on 2026-10-01 — the first end-to-end native pass of this phase, and the run that found the D6 and D7 regressions 1159 unit tests could not see. Zero `LIMITATION` lines means it really removed *and* restored an output. The superseded figure was 261 assertions on 2026-09-24; do not quote it. Counts in this repository's docs have been wrong **seven** times — take them from a run, never from arithmetic.

---

## 1. Where things live

| Path | What |
|---|---|
| `docs/superpowers/specs/2026-09-20-i3-shell-design.md` | **The design spec — the binding authority** (19 sections: acceptance criteria A1–A14, architecture, config grammar, command language, the tree algorithms, window lifecycle, workspaces, keys, indicator, decorations, GNOME overrides, D-Bus, error handling, testing, phases, toolchain, decisions log). Its §3 holds **A1–A14 only**: A15–A21 are defined in the Phase 3A design doc, A22–A27 in the Phase 3B one, and A28–A37 in `docs/superpowers/specs/2026-09-24-launcher-design.md` §8, so do not widen this range. |
| `docs/superpowers/specs/2026-09-26-phase-5-per-output-workspaces-design.md` | **The Phase 5 design.** Its §9 lists the eleven amendments it makes to the main spec (all applied there, marked "amended by Phase 5"); its §10 holds A50–A66. Read §2 (the workspace model), §5 (the attic) and §7 (hotplug) before touching `src/tree/tree.ts`. Where it and the code disagree, the code and the Phase 5 ledger win — the ledger records every ruling that changed it during execution. |
| `.superpowers/sdd/2026-09-26-phase-5-per-output-workspaces/progress.md` | **The Phase 5 ledger — the execution record.** Every ruling, every correction, every deferred minor, the whole Task 19 bugfix diagnosis. Not in `docs/`; it is the SDD working directory. Read it before writing anything about Phase 5's behaviour. |
| `docs/superpowers/plans/2026-09-24-phase-4-fidelity.md` | The Phase 4 plan. Tasks 1–4 were executed; **Tasks 5–10 never were** and each carries an annotation saying where it went (5 absorbed into Phase 5 Task 1, 6–7 superseded by Phase 5 Tasks 13–15, 8–10 folded into Phase 5 Tasks 17–18). |
| `docs/superpowers/plans/2026-09-20-phase-1-foundation.md` | The Phase 1 implementation plan (14 TDD tasks with full code). Several of its code blocks were wrong and were fixed during execution — where plan and code differ, the code (and the carry-forward doc) wins. |
| `docs/superpowers/plans/2026-09-21-phase-1-carry-forward.md` | Execution record: every ruling made while building Phase 1, items deferred to Phases 2/4, security note. **Read before planning Phase 2.** |
| `docs/superpowers/plans/2026-09-21-phase-2a-tree.md` | Completed/merged Phase 2A plan, audit and execution record. Its tree/property tests are retained in Phase 2B's integration. |
| `docs/superpowers/plans/2026-09-22-phase-2b-integration.md` | Approved Phase 2B plan and execution record. All ten tasks complete and reviewed, with every ruling. **The only record of this phase that survives a clone.** |
| `docs/handoff-2026-09-22.md` | Exact pause checkpoint, verified evidence, native environment findings, remaining Task 10 work, review obligations and all six rulings. |
| `docs/acceptance/phase-1.md` | The live-session checklist for A1–A7, passed by user report on 2026-09-21. |
| `README.md` | User-facing: install, control via D-Bus, dev commands. |
| `src/` | The extension (TypeScript, see §4). |
| `test/unit/` | Vitest on Node: pure core and native adapter doubles, including `fixtures/reference.i3config`, the reference i3 config used by golden/native tests. |
| `test/integration/` | Private nested harness (`nested.sh`, `inside.sh`), GTK4 fixture (`windows.js`), typed D-Bus client/smoke (`client.py`), Phase 1 checks (`phase1-checks.sh`), the Phase 2 A8–A14 driver (`phase2-checks.py`) and the failure-safe wrapper (`run.sh`). |
| `docs/acceptance/phase-2.md` | The live-session checklist for A8–A14. The user **walked and passed** it; the boxes are left unticked as the record of what was walked. |
| `docs/acceptance/phase-3.md` | The live-session checklist for A15–A21 (Phase 3A decorations), **unchecked**: the user's walk. |
| `docs/acceptance/phase-3b.md` | The live-session checklist for A22–A27 (Phase 3B window-fact mutability and `workspaces-only-on-primary` ownership), **unchecked**: the user's walk. |
| `docs/acceptance/launcher.md` | The live-session checklist for A28–A37 (the launcher), **unchecked**: the user's walk. |
| `docs/acceptance/phase-5.md` | The live-session checklist for A50–A66 (per-output workspaces), **unchecked**: the user's walk, and it needs two real displays. |
| `schemas/`, `metadata.json`, `stylesheet.css`, `esbuild.mjs`, `Makefile`, `tsconfig*.json` | Build and packaging. |

The user's i3 config (`~/.config/i3/config`) is the source of truth for behaviour and stays outside the repo.

## 2. Environment facts (verified on the target machine — do not re-derive)

- Fedora Silverblue 44, GNOME Shell 50.5, Mutter 18, **Wayland only** (X11 session gone since GNOME 49). The extension installs as a symlink in `~/.local/share/gnome-shell/extensions/i3-shell@troja` → `dist/`; nothing is layered with rpm-ostree.
- Wayland cannot reload extension code in place: after `make install`, **log out and back in**. `gnome-extensions disable/enable` re-runs `disable()/enable()` on the old module. The fast loop is the nested shell (`bash test/integration/nested.sh -- <cmd>`; `--visible` for a window, `--keep` to retain the sandbox log).
- `gnome-shell --nested` no longer exists; nested is the default mode. The harness launches headless Wayland Shell with `--no-x11 --wayland-display=i3-shell-test --virtual-monitor 1920x1080` inside `dbus-run-session`, with private `XDG_*` directories and `GSETTINGS_BACKEND=keyfile` (keyfile at `$XDG_CONFIG_HOME/glib-2.0/settings/keyfile`). It uses separate settings, bus and display from the live session.
- The harness now uses a mode-0700 private `XDG_RUNTIME_DIR`, socket `i3-shell-test`, and `--no-x11`. Headless Shell inherits no live display; `--visible` passes the absolute parent Wayland socket only to the compositor. Nested Xwayland startup stalled even the pre-integration baseline; disabling X11 resolved that host issue. Automated coverage is native Wayland only. The private `update-check-50` marker avoids the first-major-version network update check, but was not the cause of that stall.
- gnome-shell enables extensions **before** `layoutManager`'s `startup-complete` sets `Main.actionMode`; keybindings are filtered while the mode is `NONE`. A window-less session rests in `OVERVIEW` (2). Grabs are allowed for `NORMAL | OVERVIEW`. The first-run Welcome dialog is suppressed in the sandbox. Synthetic GTK fixtures wait for readiness, press Escape, then poll `NORMAL` (1) before creation: the native smoke established that their first frame can be delayed in the initial overview.
- Every grabbed accelerator needs `Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW)` or the shell silently drops it (see the shell's own `shellDBus.js`).
- At enable, ~25 of the 65 default-mode grabs collide with mutter's own bindings until the cleared GSettings propagate; a retry backoff (500 ms, 1.5 s, 4 s) picks them up. Keys held by `gsd-media-keys` (`XF86Audio*`, brightness) take longest.
- `@girs/gnome-shell@50.0.4` provides the GNOME 50 types but pins `@girs/*@^4.x` — do not add those packages separately (5.x collides). `@girs` mistypes `Main.actionMode` as the literal `NONE`; the one sanctioned cast is `Main.actionMode as Shell.ActionMode`.
- `npm install` needs `legacy-peer-deps=true` (`.npmrc` has it) — npm's arborist crashes on `@girs`'s peer graph ("Cannot read properties of null (reading 'edgesOut')").
- Mutter 18: `Meta.Window.maximize()` takes no flags; state comes from `maximized-horizontally`/`-vertically`. No `set_decorated` on Wayland (title bars cannot be stripped). `Meta.WindowActor` has `first-frame`; `Meta.Display` has `accelerator-activated` (both verified at runtime).
- Mutter emits `unmanaging` before actor removal, focus changes and workspace clearing, then `unmanaged`. The adapter excludes retiring windows immediately and uses a filtered last-safe MRU list during overlapping teardown; removal publishes at `unmanaged`. First-frame cleanup becomes inert on actor destruction. Do not query a retiring window's workspace or disconnect its disposed actor.
- The private Shell Extensions API is `org.gnome.Shell.Extensions` on `/org/gnome/Shell`, bus name `org.gnome.Shell`. `/org/gnome/Shell/Extensions` is not its object path. Sandbox `ps` can hide escalated compositor PIDs; an empty listing does not prove process death.
- The shell's JS lives in `/usr/lib64/gnome-shell/libshell-18.so`'s GResource; extract with Python `ctypes.CDLL` + `Gio.resources_lookup_data('/org/gnome/shell/ui/<file>.js')` when you need to read `main.js`, `windowManager.js`, `panel.js`, `messageTray.js`, `sessionMode.js`, etc.
- 32 GNOME default bindings collide with the reference config (e.g. `<Super>1..9` app switching, `<Super>h` minimize, `<Super>l` lock, `<Super>space` input source, `<Super>Left/Right` snap, `<Super>Up/Down` maximize, `<Super>a/s/v`, the XF86 keys). They are cleared dynamically and restored on disable (spec §13). The `--settings` scenario asserts four representative clearings, that no accelerator is ever *added*, and that all 234 captured values are identical again after disable; it reports the total cleared count (32 on this host) rather than asserting it.
- **IBus competes for accelerators through the same mechanism we use.** `org.freedesktop.ibus.panel.emoji hotkey` claims `<Super>semicolon` and `org.freedesktop.ibus.general.hotkey triggers` claims `<Super>space`, registered via the shell's `GrabAccelerators`. With IBus running, a varying subset of our grabs never dispatches even though `grab_accelerator` returned a valid action, `allowKeybinding` was called with `NORMAL|OVERVIEW` and `Main.actionMode` is `NORMAL`; with IBus absent, all twelve probed accelerators dispatch 3/3. The precise mechanism for the non-IBus-claimed keys is unconfirmed. The five schemas of spec §13 do not include IBus. `nested.sh` suppresses `ibus-daemon` with a PATH stub so the suite is deterministic — **automated coverage therefore excludes this conflict**, like `--no-x11` excludes Xwayland.
- **A Wayland client cannot restore itself from minimized:** xdg-shell has `xdg_toplevel.set_minimized` with no inverse, so GTK's `unminimize()` silently does nothing. Restoring is the compositor's business; an activation request (`present()`) is honoured by Mutter and is what the suite uses.
- **The private `XDG_RUNTIME_DIR` acquires FUSE mounts** from portal services (`xdg-document-portal` mounts `runtime/doc`). `rm -rf` cannot remove them, so teardown unmounts first, deepest mount first, and always exits with the inner command's status.
- `g_bus_get_sync`'s shared connection is held by a **weak** reference: drop the last language-level reference and the connection is finalised, closing it and releasing any bus name it owned. A test client that wants to hold a name must keep the connection alive.
- `g_bus_own_name` with `BusNameOwnerFlags.NONE` **does** invoke `name_lost` when another connection owns the name, and `name_acquired` later when that owner releases it — verified directly, including for the own → unown → re-own cycle. Queuing is therefore the right choice: it reports the conflict *and* recovers the name.

## 3. Toolchain and commands

```sh
npm ci                      # or npm install; .npmrc sets legacy-peer-deps
npm test                    # vitest on Node — pure core + native adapter doubles (1160 tests, 71 files)
npm run typecheck           # two programs: tsconfig.json (src, GNOME types) + tsconfig.test.json (tests + Layer 0, Node types)
npm run check:layer0        # fails if Layer 0 imports gi:// / resource:// / src/shell (also part of `npm run build`)
npm run lint:tree           # eslint over src/tree and test/unit/tree
npm run build               # release bundle → dist/  (esbuild, single ESM file; schemas compiled)
npm run build:test          # TEST bundle: Debug PressKey, SimulateSessionMode, Relayout
bash test/integration/nested.sh --keep -- python3 test/integration/client.py smoke
npm run test:integration    # bash test/integration/run.sh: builds TEST, runs Phase 1 + all four
                            # Phase 2 scenarios, restores the release bundle on exit (even on failure)
make install                # release build + symlink; then log out/in and `gnome-extensions enable i3-shell@troja`
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell     # every line is prefixed [i3-shell]
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "workspace number 3"          # the i3-msg equivalent
```
Other D-Bus methods: `GetState` (mode, workspace, grabs, config status, pills, actionMode and readiness), `GetConfigStatus`, `GetTree`, `GetWindows`; `TreeChanged` signals a committed update. Snapshots contain plain ids and values, never native objects.

Always finish a session with a **release** `make install` if you ran integration, even on failure. `run.sh` already restores a release bundle on exit, but only `make install` refreshes the live symlink. Check exact Debug XML `name="org.i3shell.Debug"` and the methods `PressKey`, `SimulateSessionMode`, `Relayout` are absent. A bare `org.i3shell.Debug` search also matches an inert release log/comment.

## 4. Architecture (as built)

Three layers; the rule that makes the project testable: **Layer 0 never imports `gi://`, `resource://` or `src/shell/`** (`scripts/check-layer0.mjs` enforces it).

```
Layer 2  src/extension.ts     enable()/disable() wiring, guarded callbacks and teardown
Layer 1  src/shell/keys.ts            KeyBinder: grab_accelerator/ungrab, retry backoff, accelerator-activated dispatch
         src/shell/settings.ts        SettingsOverrides: enumerate 5 keybinding schemas, clear colliding accels,
                                      static workspaces + names, mouse-button-modifier; crash-safe JSON snapshot in
                                      the extension's `overridden-settings` key; reconcile on reload, restore on disable
         src/shell/workspaces.ts      count/active/activate/isOccupied + change events (watches existing windows too)
         src/shell/windows.ts         Native bridge; WindowId operations and first-frame/lifetime signals
         src/shell/windowTracker.ts   GI-free pending/ready ids, liveness guards, snapshots and event deduplication
         src/shell/nativeWindowLifecycle.ts, windowEnumeration.ts — safe retirement and per-workspace MRU
         src/shell/geometry*.ts       Atomic work areas/stable monitor ids; sole native move_resize_frame writer
         src/shell/pointer.ts         NEW (Phase 5): cursor-tracker subscription (which output the pointer is on)
                                      and the pointer warp — i3's `mouse_warping output`
         src/shell/bars.ts            One bar per non-primary monitor, each showing only its own output's pills
         src/shell/indicator.ts       PanelMenu.Button with St.Button pills + mode label; hides the Activities button
         src/shell/session.ts         lock/unlock edge detection on Main.sessionMode 'updated' (+ simulate() for tests)
         src/shell/configLoader.ts    file → cached last-good ($XDG_CACHE_HOME/i3-shell/last-good.config) → built-in fallback
         src/shell/control.ts         Control/GetTree/GetWindows/TreeChanged; guarded name loss; test-only Debug
         src/shell/{controlObject,sessionState}.ts — GI-free D-Bus/session bridges
         src/shell/{log,notify,exec}.ts, src/shell/util/signals.ts (SignalTracker + guard())
Layer 0  src/engine.ts        Sole runtime Tree owner; commit applies geometry, raises, publishes snapshots/pills
         src/runtime/{model,classify,reconcile,snapshot}.ts — contracts, classification, bounded corrections
         src/config/{lexer,variables,parser,resolve,accel,overridePlan,defaultConfig,index,model}.ts
         src/commands/{model,parse}.ts
         src/tree/{node,tree,layout,focus,operations,resize}.ts — pure tree connected through Engine ports
         src/tree/monitors.ts NEW (Phase 5): `neighbourMonitor` — geometric output adjacency, no wrapping
         src/tree/outputs.ts  NEW (Phase 5): birth assignment, `resolveShowOutput` (the switch-time
                              precedence occupied > pin > memory > focused), `coverOutputs` (every live
                              output owns and shows one of its own), hotplug reassignment and remembering
         src/util/{text,bindingDiff,smoothScroll}.ts
```

Config pipeline: `logicalLines` (whole-line `#` comments, `\` continuation) → `substituteVariables` (all `set` lines collected first, whole-file substitution, longest name first — i3 semantics) → `parse` (directives; three tiers: unknown → error/reject, valid-but-unimplemented → warning/skip, cosmetic like `font`/`bar {}` → silent) → `resolve` (bindings with Mutter accelerators, modes, colours, rules, workspace names/count) → `Config`. Errors reject the file; the previous config keeps running.

Key semantics already decided (spec §19 decisions log): parse the real i3 config (no GSettings UI); config wins over GNOME defaults; overlay key (Super tap) untouched; maximize → unmaximize+retile; minimize → detach; fullscreen native; tabbed/stacked = same rect + raise; floating not forced above; output→workspace→cons level order (reversed by Phase 5; it was workspace→monitor→cons while GNOME owned workspace identity); session-modes `user`+`unlock-dialog` with ungrab on lock; commit trailers name the authoring model.

## 5. What is done — Phase 1 (Foundation)

Delivered in 31 commits (`e4628e2..463ca10`, now on `main`; the `phase-1` branch was merged and deleted): toolchain; config lexer/parser/resolver with the golden test against the real config (65 default + 11 resize-mode bindings, zero diagnostics); command parser; engine; accelerator binder; dynamic GNOME override + snapshot/restore; static workspaces with names; pill indicator; lock handling; config loader; D-Bus; nested-shell harness with automated scenarios; README and checklist.

Verification: unit 52/52; typecheck both programs; `npm run test:integration` green (workspace switching by real key press, `exec`, resize-mode entry/exit with bare-key grabs, reload rejection and acceptance with a newly grabbed binding, lock/unlock). A whole-branch review ended "with fixes"; the fix wave landed and re-reviewed clean.

**Live acceptance passed:** the user reported all A1–A7 checks green on 2026-09-21, with no Phase 1 findings. `docs/acceptance/phase-1.md` records that report and its provenance. Tiling and tiled resizing were outside that Phase 1 walk; it does not certify Phase 2.

The follow-up fixes restore last-good-cache recovery for a missing config at startup and preserve saved GNOME settings when restoration fails. The 64-test Phase 1 regression baseline is preserved in the current 414-test suite. Phase 2A delivery passed 234 tests and its reviews/merge completed; it did not rerun native integration. Phase 2B Task 9 subsequently passed the updated Phase 1 native checks with real GTK tiles. Remaining carry-forward items and their owners are recorded in the carry-forward doc.

**Two production defects were found by the Phase 2 integration suite and fixed (Task 10), each reproduced in a focused unit test before any source change:**
1. `src/shell/indicator.ts` wrote to already-disposed `St.Button` actors. At shell shutdown the panel is destroyed before `disable()` runs, but `workareas-changed` still drives a `commit()` that publishes pills, so `_restyle()` hit disposed actors — a burst of `Gjs-CRITICAL` in the journal on **every logout**. Found by Task 9's critical-log gate, not by an assertion. The indicator now watches its own button's `destroy` signal and stops touching actors afterwards.
2. `src/shell/control.ts` reported a rival owner of `org.i3shell.Control` through `log.error`, which GJS emits as `CRITICAL` with a synthetic stack trace — claiming the extension had failed when only its optional control surface was unavailable. It is now a warning with the same text; the one-time user notification is unchanged.

Compositor signals still drive `commit()` during shutdown, so `geometry.apply` can call `move_resize_frame` on windows being torn down. That is outside the evidence Task 10 gathered and is recorded as a follow-up rather than changed on spec.

## 6. What remains — Phases 2, 3, 4

Each phase gets its own implementation plan (`docs/superpowers/plans/`) written from the spec, executed task by task with review. The spec sections below are complete designs, not sketches.

### Phase 2 — remaining integration acceptance — spec §7, §8, §16, A8–A14

Phase 2A's pure tree is merged and retained unchanged except the reviewed topology extension. Its bounded property suite runs 300 sequences for each fixed seed `20260921` and `8675309`, up to 100 operations, including odd/tiny geometry. Phase 2B Tasks 1–9 add native window identity/lifetime, atomic topology, one-correction geometry generations, Engine ownership/commands, D-Bus snapshots, lock handling, config/input fixes and private GTK fixtures. Commands target engine-selected ids/containers; `commit()` alone changes geometry. Tabbed/stacked children share rectangles and raise the selected subtree; bars and borders wait for Phase 3.

Four kinds of change force a new geometry generation: fullscreen exit, a window rejoining the tree (**any** §8.2 exclusion reason clearing — minimize, on-all-workspaces or skip-taskbar — not unminimize alone, per Phase 3B), monitors-changed and completion of engine-initiated unmaximize. Workspace/work-area/unlock use ordinary reconciliation. Reload preserves the tree; accepted restart rebuilds from live windows in per-workspace MRU order. Settings reconcile successive configurations without a temporary restore.

**Task 10 is implemented.** `test/integration/phase2-checks.py` drives A8–A14 against real GTK windows: independent-rectangle assertions computed from the reported work area, real bound keys for focus/move/parent/layout/resize, transient/modal/fixed floating, fullscreen/unminimize/unmaximize forced generations, a client that refuses its tile, kill/transfer of a selected parent, reload/rejected-reload/restart, lock/unlock and a real disable/enable cycle; plus `--monitors` (the Phase 3B membership round trip between outputs, then real output removal *and* reconnection over `org.gnome.Mutter.DisplayConfig`), `--settings` (A6 before/after with real originals, including the value the extension owns) and `--name-conflict`. The user walked and passed the Phase 2 checklist on 2026-09-23; the whole-branch review completed before that merge.

### Phase 3 — layouts & appearance — spec §12
`src/shell/decorations.ts`: per-leaf `St.Widget` borders in `global.window_group` sized to the leaf rect with `client.*` colours (focused / focused_inactive / unfocused / urgent), a single frame around a focused SplitCon, `default_border pixel N` and the `border` command (`normal` treated as `pixel`); tab/stack bars as `St.BoxLayout` of titles above tabbed/stacked containers (children get rect minus bar; click focuses). All actors created/updated/destroyed only from `commit()`.

### Phase 4 — fidelity — spec §17 — **partial**
Done (Tasks 1–4): `for_window` criteria matching and rules applied at first-frame (`floating enable`, `border`, `resize set`, `move position center`, `move container to workspace`); the five new window facts and three new `notify::` watches; urgent pills (`window-demands-attention`) and the urgent border.

Not done, and not planned here any more: `workspace_auto_back_and_forth` / `back_and_forth` (still warns). Tasks 5–10 of the plan were never executed — Task 5's `neighbourMonitor` was absorbed into Phase 5 Task 1, Tasks 6–7 were superseded by Phase 5 Tasks 13–15, and Tasks 8–10 were folded into Phase 5 Tasks 17–18; the plan says so at each task. Multi-monitor and `focus_follows_mouse` ↔ `focus-mode` moved to Phase 5, which removes `MonitorCon` entirely rather than navigating across it. Still open: user-defined GNOME shortcuts (`custom-keybindings` relocatable schema) are not enumerated by the override scan, and the criteria regex stops at the first `]`.

### Phase 5 — per-output workspaces — Phase 5 design doc, A50–A66 — **implemented, unmerged**
Each output owns a set of workspaces and shows exactly one; `Tree.workspaces` maps an index to one root plus an `output`, `Tree.visible` maps an output to the workspace it shows, and `Tree.focusedOutput` is stored state. GNOME drops to two workspaces — `LIVE_WORKSPACE = 0`, always active, and `ATTIC_WORKSPACE = 1`, holding every hidden window — because Mutter declines to render a non-active workspace, which makes that the hiding primitive and is why GNOME's overview shows the attic. `workspace N` resolves its output at **switch time** by `occupied > config pin > memory > focused output` (`resolveShowOutput`), so an occupied workspace is never relocated by a number press and a pin survives a `$mod+N` from another display; the memory tier is unreachable through the `Tree` today and is documented as such in the code. A switch that crosses displays warps the pointer (i3's `mouse_warping output`; `none` vetoes it, `container` is accepted as `output` with a warning). `focus_follows_mouse` is honoured by handing GNOME `focus-mode = sloppy`, and pointer motion onto **any** output claims the focused output. Focusing a window moves the focused output, so workspace-scoped commands follow the user. An unplugged output's layout survives and its workspaces' positions are remembered — first displacement wins, and a deliberate `move workspace to output` clears the memory. Three new modules, listed in §4. The whole-branch review and the A50–A66 walk are what remain.

Two user-facing limitations are carried out of this phase deliberately, and are listed in the acceptance doc's Known Limitations and in the README's Troubleshooting so the walk does not misreport them as defects:
- **A floating window moved by *command* keeps its old frame.** `move container to output` and `move container to workspace N` re-home it in the tree but emit no frame change (verified by execution: the commit's port calls are `["moveTo:1:0","decorations","decorations"]`, no rect), so it stays drawn where it was and appears to vanish when the other display switches away. D6's re-home cannot correct it — no monitor *change* occurred. The real fix is translating a floating rect into the target work area, with its own clamping questions; that is its own task. Workaround: drag it, or tile it first.
- **GNOME's hot corner can swallow the pointer warp.** `workspace N` warps the pointer when the switch crosses displays (`mouse_warping output`, i3's default); warping out of the top-left corner trips Mutter's pressure barrier, opening the overview and taking the keyboard. Workarounds: `mouse_warping none`, or `org.gnome.desktop.interface enable-hot-corners false`. **An open decision, not settled behaviour** — it changes the user's desktop and was not taken unilaterally.

Target arrangements: laptop alone (`eDP-1`) and docked with external display(s), lid closed. Windows migrate off the internal display when inactive and return on undock. Existing `~/Dev/i3-display-manager` and `~/Dev/i3-lid-sleep` (also installed in `~/.local/bin/`) document expected transitions. Ask about scaling and exact resolutions when Phase 4 planning starts.

### Explicit non-goals (v1)
`bindcode`, `bindsym --release`, marks, scratchpad, `assign`, gaps, i3bar `status_command`/`bar {}`, top-level autostart `exec`, layout persistence across shell restarts, `resize set` on tiled containers, stripping title bars.

## 7. How to continue (process that worked)

0. **Phase 5 is the live front.** It is on branch `phase-5`, unmerged and unpushed, with its ledger at `.superpowers/sdd/2026-09-26-phase-5-per-output-workspaces/progress.md`. Read that ledger before describing or changing any Phase 5 behaviour: it records every ruling, including six false soundness claims the controller made and the corrections that followed, and the Task 19 bugfix round that changed user-visible behaviour after the spec was written. What remains is the whole-branch review and the user's A50–A66 walk. **A build is an operation on the live session:** `dist/` is the symlink target of the installed extension, so `npm run build`, `npm run build:test`, `npm run test:integration` and `make install` all change what the next login loads, and a build that overlaps a login in progress can hand GNOME a half-written `extension.js` and fail the extension outright. Build when the session is locked or the user says so, never speculatively.
1. Phases 1, 2A, 2B, 3A and 3B are merged and pushed; the Phase 2 and Phase 3A walks passed. What remains for Phase 3B is the user's **live A22–A27 walk** ([docs/acceptance/phase-3b.md](docs/acceptance/phase-3b.md), 25 unchecked boxes), which needs a logout because Wayland cannot reload extension code in place. The permanent-drop fix is proven against a real compositor (`ok MB a sticky window is still tracked, under the same id`), but no user has yet moved a window between real displays with this build. The launcher is implemented on the `launcher` branch across ten reviewed tasks and awaits its **whole-branch review** and the user's **live A28–A37 walk** ([docs/acceptance/launcher.md](docs/acceptance/launcher.md), 34 unchecked boxes).
2. Phase 2A is reviewed and merged into `main`; the completed `phase-2` branch is deleted. `origin` is `git@github.com:troja-gnister/i3-shell.git`, and `main` tracks `origin/main`. The user authorized the initial push at `568855c`.
3. Two items need a decision from the user rather than a unilateral fix, both recorded in the [carry-forward](docs/superpowers/plans/2026-09-21-phase-1-carry-forward.md): accelerators claimed by another external grabber outside spec §13's five schemas (IBus takes `<Super>semicolon` and `<Super>space`), and compositor signals still driving `commit()` during shutdown.
4. Continue with `superpowers:subagent-driven-development`: one implementer per task, a reviewer per task, and a whole-branch review at the end. Keep the ledger and record every ruling.
5. Verify claims before trusting them: type-check GNOME API usage against `@girs` in a scratch project, extract the shell's JS to check behaviour, and run the nested shell for anything runtime-dependent.
6. Controller owns all native builds/runs/install and git commits; workers freeze code during those runs. Do not change the harness under a running invocation. A whole-branch review covers the full range of commits on the branch, triages every deferred finding from the individual task reviews, then at most one complete fix wave and a scoped re-review. Keep the phase branch until the user requests integration.

## 8. People and conventions

- Author/owner: `troja-gnister <iskrydev@gmail.com>` (repo-local git identity). GitHub: [troja-gnister/i3-shell](https://github.com/troja-gnister/i3-shell). The initial push is complete; do not infer permission for future phase merges or pushes.
- License GPL-2.0-or-later (required by extensions.gnome.org; also lets Forge/Tiling Shell be read as references — no code is copied).
- Commits: conventional subjects (`feat(config): …`, `fix(shell): …`, `test: …`, `docs: …`) and **no attribution trailers of any kind** — no `Co-Authored-By`, no "Generated with". Standing project rule; earlier phases carried a model trailer and no longer do. Every Phase 5 task review verified their absence.
- Branching: `main` holds reviewed phases; work on `phase-N` branches in this directory (the Makefile symlinks `$(CURDIR)/dist`, so a separate worktree would confuse the live install).
