# Phase 3B — window-fact mutability design

**Status:** design approved in conversation 2026-09-23; this document is the binding authority for
Phase 3B. It extends `2026-09-20-i3-shell-design.md` (the "main spec") and amends two of its
sentences, named in §6. Where they disagree, this one wins for Phase 3B subject matter.

**Baseline:** `main` at `c2eb746`. 538 unit tests in 48 files, 228 integration assertions, Phases 1,
2, 3A merged and all three acceptance walks passed.

## 1. Brief

**The defect.** `classifyWindow()` runs once, at a window's first frame, and its answer is cached for
the window's lifetime (`windowTracker.ts` `_makeReady`). When it returns `null` the tracker disposes
the window's watch and never allocates an id. Two of the facts it reads are mutable at runtime, and
one of them changes routinely:

Under GNOME's default `org.gnome.mutter workspaces-only-on-primary = true`, Mutter marks every window
on a **secondary** output as `on_all_workspaces`. `classifyWindow` maps that `sticky` fact to `null`.
So moving a window to the external display drops it **permanently** — and because the watch is gone,
the reverse transition cannot even be observed.

**What the user decided, by explicit choice:**

- Phase 3B fixes the drop **and** takes ownership of `workspaces-only-on-primary`, so the external
  display tiles without a hand-edited GSetting on any machine.
- A window that rejoins the tree lands **beside the focused window, as if newly opened** — not in a
  remembered slot, not appended, not floating.
- `sticky` and `skipTaskbar` become per-commit facts. `transient` and `attached` stay read-once.

**Assumption, not a statement from the user:** that managing `workspaces-only-on-primary` is
preferable to leaving it manual. It follows from their already having set it by hand and run on it,
and from `disable()` restoring it — which a hand-edit never did.

**What this phase is not.** No `tiled ⇄ floating` reclassification; see §3.4. No new window
lifecycle state; see §2.

## 2. Why there is no "known but untracked" state

The Phase 1 carry-forward deferred `null ⇄ tracked` promotion to Phase 4, on the grounds that it
needs a new lifecycle state — the tracker would have to keep watching windows it ignored and allocate
ids lazily, with its own teardown and leak surface.

That is true only while `sticky` remains an input to `classifyWindow`. Moving it out makes the
tracker admit the window unconditionally: an id is allocated, the watch is kept, and whether the
window belongs in the **tree** becomes a per-commit decision the engine already knows how to make.
The permanent drop disappears because the fact stops being cached, not because anything detects and
repairs it. No promotion, no new state.

## 3. Design

### 3.1 The fact move

`WindowFacts` loses `sticky` and `skipTaskbar`. `WindowInfo` gains them, beside `minimized` and
`fullscreen`, which the engine already re-reads on every `_syncWindow`.

`WindowFacts` keeps only read-once facts: `type`, `transient`, `attached`, `resizable`.

### 3.2 `classifyWindow` gets simpler

```ts
export function classifyWindow(f: WindowFacts): WindowKind | null {
  if (f.type === 'ignored') return null;
  if (f.type !== 'normal' || f.transient || f.attached || !f.resizable) return 'floating';
  return 'tiled';
}
```

`null` now means exactly one thing: **this window type is not ours.** The tracker therefore always
allocates an id and keeps its watch for any window it admits.

### 3.3 One exclusion gate, two call sites

A pure predicate in Layer 0:

```ts
export function excludedFromTree(info: WindowInfo): boolean {
  return info.minimized || info.sticky || (info.skipTaskbar && info.kind === 'tiled');
}
```

**Amendment (post-implementation, native scenario A13):** the first draft of this section wrote the
predicate flatly, as `info.minimized || info.sticky || info.skipTaskbar`, with no `kind` term. That
was wrong, and the `kind` term is not a new rule — it restores one this phase silently dropped.

Before this phase, `classifyWindow` read `skipTaskbar` itself, on the line that already assumed the
window had survived every other reason to float:

```ts
if (f.type !== 'normal' || f.transient || f.attached || !f.resizable) return 'floating';
return f.skipTaskbar || f.sticky ? null : 'tiled';
```

A window that floats for type, transience, attachment, or fixed size never reached that line, so
`skipTaskbar` never applied to it. §3.1 moved `skipTaskbar` out of `WindowFacts` and into `WindowInfo`
precisely so it could be read per-commit instead of cached — but the flat OR above applies it to
*every* window, floating or not, because `WindowFacts`'s type/transient/attached distinction is gone
from this predicate's inputs. Mutter reports `is_skip_taskbar()` true for a modal dialog (confirmed by
scenario A13: `'A13 dialog'`, a plain transient with no `set_modal()`, passed; `'A13 modal'`, differing
only in that call, failed) — a window that was always meant to float regardless. Under the flat OR it
is excluded from the tree *and*, because `_syncWindow`'s else-branch (the only place that calls
`tree.addFloating`) is skipped while excluded, from the floating list too: `assert window['id'] in
workspace_snapshot()['floating']` failed with the modal absent from both.

`info.kind` is exactly the type/transient/attached/fixed-size verdict, carried forward from
classification into `WindowInfo` (§3.1 already relies on this: it is what `_floating()` reads). Gating
`skipTaskbar` on `info.kind === 'tiled'` reproduces the old ordering — skip-taskbar only ever mattered
for a window that would otherwise be a tiling candidate — without reintroducing `skipTaskbar` as a
classification input, which §1 and §2 both rule out. `minimized` and `sticky` get no such gate: neither
was ever behind that ordering (`sticky` mapped to `null` unconditionally in the pre-phase code above,
and `minimized` is orthogonal to `kind` by construction), so gating them would be inventing new
behaviour, not restoring old.

The predicate replaces the bare `info.minimized` at `engine.ts:485` and the `!w.minimized` filter in
the `tree.normalize(...)` live set at `engine.ts:391`. Both sites exist today; both consult a predicate
instead of a field.

Re-entry needs no new **engine** code. `_syncWindow`'s else-branch already re-inserts a window that
is absent from the tree via `tree.insert(id, workspace, monitor)`, which places it beside the focus —
the behaviour chosen in §1 — and already restores the floating state it had before it left. That path
is what minimize/unminimize uses and it has passed an acceptance walk.

### 3.3.1 Detection: the two signals nobody is watching

The engine re-reads `WindowInfo` on `_syncWindow`, which fires from a window event
(`engine.ts:241`) or from the commit loop (`engine.ts:379`). The tracker watches
`notify::minimized`, `notify::fullscreen`, `notify::maximized*` and `notify::appears-focused` — and
**nothing for `on-all-workspaces` or `skip-taskbar`**. Without a signal, a flipped fact would sit
unnoticed until some unrelated commit happened to re-read it, so the window would leave or rejoin the
tiling at an arbitrary later moment rather than when the user acted.

The native lifecycle backend therefore gains two connections, `notify::on-all-workspaces` and
`notify::skip-taskbar`, each emitting an existing `ChangeEvent`. `WindowEvent`
(`src/runtime/model.ts:25-29`) gains one variant name for them — `'membership'` — rather than reusing
`'minimized'`, so a log line or a test failure says which fact moved. Both connections are disposed
by the same per-window `disposeWatch` that already tears the others down; they must not introduce a
second teardown path.

This is the one place the phase adds a native subscription, and it is the half that makes the rest
observable. A fix that moved the fact without watching it would pass every unit test and still feel
broken on a real desktop.

### 3.4 There is no `tiled ⇄ floating` reclassification in this phase

The facts moving to per-commit affect **membership**, not **kind**. Every fact `classifyWindow` still
reads is read-once, so a window's kind cannot change after its first frame.

The precedence rule the carry-forward demanded for main spec §7.10 — "an explicit `floating enable`
must win, or a monitor move would silently undo the user's choice" — is therefore **not needed**: a
monitor move no longer touches kind at all.

One subtlety must still be recorded in §7.10, because it stops being harmless later.
`engine.ts:489-490` writes the remembered floating state into `_manualFloating` when a window
returns, converting a **derived** state into a **pinned** one. Reusing that path means a sticky round
trip pins it too. In this phase that is a no-op, because kind cannot change; it becomes real the
moment a later phase makes `transient` or `attached` mutable, at which point a returning window would
be frozen at its old kind. The choice here is to keep the behaviour, for consistency with minimize
and because special-casing it now would be untestable.

### 3.5 The ignored-window boundary

Docks, desktops, toolbars, menus, splash screens and popup menus are `'ignored'` by **type**
(`windows.ts:127-133`), which stays read-once. `skipTaskbar` is therefore not load-bearing for them,
and admitting skip-taskbar windows costs one id and one watch for a class already excluded for a
better reason. This boundary is deliberate and must not be widened without a new decision.

## 4. The GNOME setting

`org.gnome.mutter workspaces-only-on-primary = false` joins the existing apply/restore pair beside
`dynamic-workspaces` (`settings.ts:88` and `:95`), through the same `_applyValue` / `_restoreSaved`
machinery that covers five GNOME keybinding schemas, the two IBus hotkeys and the workspace
preferences. It inherits that machinery's guarantee: the original is snapshotted into the extension's
`overridden-settings` key before the write, and a failed or deferred restore keeps the original
persisted for a later attempt.

`OverridePlan` needs no new field — the value is unconditional, like `dynamic-workspaces = false`.

**Consequence to state plainly:** this changes what GNOME considers a workspace across outputs, for
every application, while the extension is enabled. `disable()` puts it back.

## 5. Testing

**Layer 0, on Node:**
- `classifyWindow` returns `'tiled'` for a sticky window and for a skip-taskbar window — the two
  cases that return `null` today, so both fail before the change.
- `classifyWindow` returns `null` only for `type === 'ignored'`.
- `excludedFromTree` for each of the three reasons and for none of them.

**Shell, with doubles:**
- `windowTracker` allocates an id and **keeps the watch** for a window whose facts would previously
  have classified `null`. This is the permanent drop written as an assertion.
- `windowFacts()` no longer reads `is_on_all_workspaces()` or `is_skip_taskbar()`; `WindowInfo` does.
- the lifecycle backend emits a `'membership'` event on `notify::on-all-workspaces` and on
  `notify::skip-taskbar`, and both handlers are disposed by the existing `disposeWatch` — asserted by
  the doubles that record post-dispose access, since a leaked handler on a destroyed window is the
  defect class this project has already shipped once.
- `SettingsOverrides` clears `workspaces-only-on-primary`, restores it on `restoreAll()`, and
  re-clears on a repeated enable — the shape the IBus keys already use.

**Engine:**
- a window that becomes sticky leaves the tree; the remaining tiles re-fill the work area;
- it returns **beside the focused window** when sticky clears, with its floating state intact;
- a skip-taskbar window is excluded and recovers the same way;
- `excludedFromTree`'s three reasons compose: a window both minimized and sticky returns only when
  both clear.

**Integration, in the nested shell** — the payoff, and the assertion that matters most because
Phase 3A taught us a correct tree is not a correct screen:
- with the setting managed, a window moved to the secondary output is tracked, is tiled on that
  output, and survives the move back;
- the setting is cleared on enable and restored on disable, asserted against the real schema.

## 6. Amendments to the main spec

- **§16.2** currently reads "`org.gnome.mutter workspaces-only-on-primary` is left as is (single
  monitor today; Phase 4 revisits)". That becomes false: Phase 3B sets it to `false` on enable and
  restores it on disable.
- **§17's Phase 4 list** drops `workspaces-only-on-primary`; per-output focus and movement stay.
- **§7.10** gains the pinned-versus-derived note from §3.4.
- **§8.2** must record that `sticky` and `skipTaskbar` are no longer classification inputs, and that
  they are watched through `notify::on-all-workspaces` and `notify::skip-taskbar`.

## 7. Acceptance criteria

- **A22.** With the extension enabled, `org.gnome.mutter workspaces-only-on-primary` is `false`;
  disabling the extension restores the value it had before.
- **A23.** A window moved to the external display is tiled there, not left floating or untracked.
- **A24.** Moving that window back to the internal display tiles it there again.
- **A25.** Unplugging the external display while a window is on it does not lose the window.
- **A26.** A window pinned to all workspaces (GNOME's "Always on Visible Workspace") leaves the
  tiling, and un-pinning it returns it beside the focused window.
- **A27.** Nothing in the above requires a hand-edited GSetting.
