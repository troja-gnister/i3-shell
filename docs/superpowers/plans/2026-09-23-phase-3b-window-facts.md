# Phase 3B Window-Fact Mutability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop caching two mutable window facts, so a window moved to a secondary output is excluded from the tiling while it is there instead of being dropped permanently — and take ownership of the GNOME setting that causes it.

**Architecture:** `sticky` and `skipTaskbar` move out of read-once `WindowFacts` into per-commit `WindowInfo`. `classifyWindow()` therefore gets *simpler*: `null` comes to mean only "this window type is not ours", so the tracker always allocates an id and keeps its watch, and the permanent drop disappears by construction rather than by repair. Tree membership becomes a per-commit engine decision through one pure predicate, reusing the minimize/unminimize path that already removes and re-inserts a window.

**Tech Stack:** TypeScript bundled by esbuild to a single ESM file; GNOME Shell 50.5 / Mutter 18 on Wayland; vitest on Node for Layer 0 and adapter doubles; a private nested `gnome-shell --headless` for native checks.

**Spec:** `docs/superpowers/specs/2026-09-23-phase-3b-window-facts-design.md` — binding. Read it before Task 1. Its §6 lists four amendments to the main spec, `docs/superpowers/specs/2026-09-20-i3-shell-design.md`, which Task 5 applies.

## Global Constraints

- Layer 0 (`src/config`, `src/commands`, `src/tree`, `src/runtime`, `src/engine.ts`) must never import `gi://`, `resource://`, or `src/shell/`. `npm run check:layer0` enforces this.
- No blanket `any` and no `@ts-ignore`. The only sanctioned idiom is the pre-existing `(...args: any[])` in `src/shell/util/signals.ts`.
- Release builds must never contain `org.i3shell.Debug` XML or its methods.
- The nested harness's native-critical gate must not be weakened: exactly one upstream Mutter assertion is filtered by exact text in `test/integration/inside.sh`.
- Every task is RED before GREEN: write the failing test, run it, and **paste the actual failure output** in your report. A bare claim of RED is not evidence.
- Where a test covers already-correct behaviour and cannot go red, prove it load-bearing with a one-at-a-time mutation that kills exactly that test, and tabulate the mutants.
- **The controller owns all builds, native harness runs and installs.** Request an exact command and freeze the affected files until output returns. Never run `npm run build*`, anything under `test/integration/`, `make install`, or `gnome-extensions`.
- Commit messages carry no attribution trailers.

## Review Focus

Five conditions the spec implies that no happy path would exercise. Each has its test assigned to the task that owns the code.

- **A window that is sticky at its *first frame*, not by transition.** The whole fix is about the transition, but a window mapped straight onto the secondary output is sticky before it is ever classified. It must be admitted and then excluded, not dropped. — Task 1 and Task 3.
- **The two new signal handlers leaking past window destruction.** This project has already shipped a disposed-actor critical; a handler surviving its window is the same class. — Task 2.
- **A window both minimized *and* sticky.** It must rejoin the tree only when **both** clear, not when either does. — Task 3.
- **A window that goes sticky while it is the selected one.** Removing the selected window from the tree must not leave the selection dangling at a con that no longer exists. — Task 3.
- **`workspaces-only-on-primary` when the shell dies before `disable()`.** The original must stay persisted in the snapshot for a later restore, exactly as the other overrides do — otherwise a crash silently keeps the user's GNOME setting changed. — Task 4.

---

### Task 1: Layer 0 — the fact move, the simpler classifier, and the exclusion predicate

**Files:**
- Modify: `src/runtime/model.ts` (`WindowFacts`, `WindowInfo`, `WindowEvent`)
- Modify: `src/runtime/classify.ts:3-8`
- Test: `test/unit/runtime/classify.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `WindowFacts` without `sticky`/`skipTaskbar`; `WindowInfo` with `sticky: boolean` and `skipTaskbar: boolean`; `WindowEvent` gaining `'membership'`; `classifyWindow(f: WindowFacts): WindowKind | null` returning `null` only for `type === 'ignored'`; and `excludedFromTree(info: WindowInfo): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/runtime/classify.test.ts`. The first two are the defect stated as assertions — they fail today because `classifyWindow` returns `null` for both.

```typescript
describe('classifyWindow after the fact move', () => {
  it('tiles a window that is on all workspaces, instead of refusing it', () => {
    // `sticky` used to map to null, which made the tracker dispose the watch
    // and drop the window forever. It is not a classification input any more.
    expect(classify({...normal})).toBe('tiled');
  });

  it('returns null only for a window type that is not ours', () => {
    expect(classify({...normal, type: 'ignored'})).toBeNull();
    expect(classify({...normal, type: 'dialog'})).toBe('floating');
    expect(classify({...normal, type: 'utility'})).toBe('floating');
  });
});

describe('excludedFromTree', () => {
  const info = (patch: Partial<WindowInfo>): WindowInfo => ({
    id: 1, kind: 'tiled', workspace: 0, monitor: 1,
    rect: {x: 0, y: 0, width: 10, height: 10}, title: 'w', wmClass: null,
    minimized: false, fullscreen: false, maximizedH: false, maximizedV: false,
    sticky: false, skipTaskbar: false, ...patch,
  });

  it('keeps an ordinary window in the tree', () => {
    expect(excludedFromTree(info({}))).toBe(false);
  });

  it('excludes a minimized, a sticky and a skip-taskbar window', () => {
    expect(excludedFromTree(info({minimized: true}))).toBe(true);
    expect(excludedFromTree(info({sticky: true}))).toBe(true);
    expect(excludedFromTree(info({skipTaskbar: true}))).toBe(true);
  });

  it('stays excluded while any one reason remains', () => {
    // Review Focus: a window both minimized and sticky rejoins only when BOTH
    // clear. Task 3 pins the engine half; this pins the predicate.
    expect(excludedFromTree(info({minimized: true, sticky: true}))).toBe(true);
    expect(excludedFromTree(info({minimized: false, sticky: true}))).toBe(true);
    expect(excludedFromTree(info({minimized: true, sticky: false}))).toBe(true);
  });
});
```

The existing `normal`/`classify` helpers are already in that file — read it and reuse them; remove `sticky` and `skipTaskbar` from the fixtures they build, since those fields leave `WindowFacts`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/runtime/classify.test.ts`
Expected: the sticky test FAILS with `expected null to be 'tiled'`; the `excludedFromTree` block FAILS to import. Also expect `npm run typecheck` to report errors in `src/shell/windows.ts` and `src/engine.ts` — those are Tasks 2 and 3; note them and do not fix them here.

- [ ] **Step 3: Implement**

In `src/runtime/model.ts`: delete `skipTaskbar` and `sticky` from `WindowFacts`; add `sticky: boolean;` and `skipTaskbar: boolean;` to `WindowInfo`; extend the last `WindowEvent` member to `{type: 'frame' | 'workspace' | 'minimized' | 'fullscreen' | 'maximized' | 'membership'; id: WindowId}`.

In `src/runtime/classify.ts`:

```typescript
export function classifyWindow(f: WindowFacts): WindowKind | null {
  if (f.type === 'ignored') return null;
  if (f.type !== 'normal' || f.transient || f.attached || !f.resizable)
    return 'floating';
  return 'tiled';
}

/**
 * Whether a window is currently outside the tiling tree.
 *
 * All three reasons are read every commit, never cached: `minimized` already
 * was, and `sticky`/`skipTaskbar` moved here from `WindowFacts` precisely
 * because caching them dropped a window permanently. Any one reason excludes;
 * the window rejoins only when every reason has cleared.
 */
export function excludedFromTree(info: WindowInfo): boolean {
  return info.minimized || info.sticky || info.skipTaskbar;
}
```

`classify.ts` will need `WindowInfo` added to its `import type` line.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/runtime/classify.test.ts && npm run check:layer0`
Expected: PASS and `layer0 check ok`. `npm test` will still fail in the shell and engine suites — those are Tasks 2 and 3.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/model.ts src/runtime/classify.ts test/unit/runtime/classify.test.ts
git commit -m "feat: make sticky and skip-taskbar per-commit facts"
```

---

### Task 2: the shell adapter — move the reads, and watch the two signals

**Files:**
- Modify: `src/shell/windows.ts` — `windowFacts()`, `windowInfo()`, `watchWindow()`
- Test: `test/unit/shell/windows.test.ts`, `test/unit/shell/nativeWindowLifecycle.test.ts`

**Interfaces:**
- Consumes: `WindowFacts`, `WindowInfo`, `WindowEvent` from Task 1.
- Produces: `windowInfo()` returning `sticky` and `skipTaskbar`; `watchWindow()` emitting `'membership'` on `notify::on-all-workspaces` and on `notify::skip-taskbar`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('reports sticky and skip-taskbar as per-commit info, not as facts', () => {
  const window = fakeWindow({onAllWorkspaces: true, skipTaskbar: true});
  const info = infoOf(window);
  expect(info.sticky).toBe(true);
  expect(info.skipTaskbar).toBe(true);
  expect('sticky' in factsOf(window)).toBe(false);
  expect('skipTaskbar' in factsOf(window)).toBe(false);
});

it('emits membership when a window is put on all workspaces', () => {
  const window = fakeWindow({});
  const events: string[] = [];
  watchWindow(window, e => events.push(e));
  window.emit('notify::on-all-workspaces');
  expect(events).toEqual(['membership']);
});

it('emits membership when the skip-taskbar hint changes', () => {
  const window = fakeWindow({});
  const events: string[] = [];
  watchWindow(window, e => events.push(e));
  window.emit('notify::skip-taskbar');
  expect(events).toEqual(['membership']);
});

it('disposes both new handlers with the rest of the watch', () => {
  // Review Focus: a handler that survives its window is the defect class this
  // project has already shipped. Both must go through the existing dispose
  // array, not a second teardown path.
  const window = fakeWindow({});
  const dispose = watchWindow(window, () => {});
  dispose();
  expect(window.connectedSignals()).toEqual([]);
});
```

Read `test/unit/shell/windows.test.ts` first and build these against the doubles it already uses — do not invent a parallel fake. If it has no `fakeWindow` helper, follow whatever shape that file already uses to stand in for a `Meta.Window`, and extend it with `is_on_all_workspaces()` / `is_skip_taskbar()` rather than creating a second family.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/shell/windows.test.ts`
Expected: the info test FAILS because `sticky` is `undefined` on `WindowInfo`; both `membership` tests FAIL with `expected [] to equal ['membership']`.

- [ ] **Step 3: Implement**

In `windowFacts()` (`src/shell/windows.ts`), delete the `skipTaskbar: window.is_skip_taskbar(),` and `sticky: window.is_on_all_workspaces(),` lines.

In `windowInfo()`, add them to the returned object:

```typescript
    maximizedV: window.maximized_vertically,
    sticky: window.is_on_all_workspaces(),
    skipTaskbar: window.is_skip_taskbar(),
```

In `watchWindow()`, add two lines beside the existing ones — the `connectWindow` helper already pushes each disposer onto the shared `dispose` array, which is the whole reason no second teardown path appears:

```typescript
  connectWindow('notify::minimized', 'minimized');
  connectWindow('notify::fullscreen', 'fullscreen');
  connectWindow('notify::on-all-workspaces', 'membership');
  connectWindow('notify::skip-taskbar', 'membership');
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/shell/ && npm run typecheck`
Expected: the shell suites pass. `src/engine.ts` still fails typecheck — Task 3 owns that.

- [ ] **Step 5: Commit**

```bash
git add src/shell/windows.ts test/unit/shell/
git commit -m "feat: read sticky and skip-taskbar per commit and watch their signals"
```

---

### Task 3: the engine — one exclusion gate, and the round trip

**Files:**
- Modify: `src/engine.ts:391` (the `normalize` live set) and `:485` (the `_syncWindow` branch)
- Test: `test/unit/engine/lifecycle.test.ts`, `test/unit/engine/fakeEngine.ts`

**Interfaces:**
- Consumes: `excludedFromTree(info)` from Task 1; the `'membership'` event from Task 2.
- Produces: no new exported surface; behaviour only.

- [ ] **Step 1: Write the failing tests**

Extend `test/unit/engine/fakeEngine.ts` so `windowInfo()` defaults `sticky: false, skipTaskbar: false`, and so `f.change(id, {sticky: true}, 'membership')` works — the existing `change` helper already takes an event type, so no new machinery is needed.

```typescript
describe('exclusion from the tree', () => {
  it('removes a window from the tiling when it becomes sticky', () => {
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {sticky: true}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
    expect(f.applied.at(-1)!.get(1)).toEqual({x: 0, y: 30, width: 1000, height: 700});
  });

  it('returns it beside the focused window when sticky clears', () => {
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {sticky: true}, 'membership'); f.flush();
    f.change(2, {sticky: false}, 'membership'); f.flush();
    const rects = f.applied.at(-1)!;
    expect(rects.get(1)!.width).toBe(500);
    expect(rects.get(2)!.width).toBe(500);
  });

  it('excludes a skip-taskbar window the same way', () => {
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {skipTaskbar: true}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
  });

  it('rejoins only when every reason has cleared', () => {
    // Review Focus: minimized AND sticky together.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {sticky: true, minimized: true}, 'membership'); f.flush();
    f.change(2, {sticky: false, minimized: true}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
    f.change(2, {sticky: false, minimized: false}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(true);
  });

  it('does not leave the selection dangling when the selected window leaves', () => {
    // Review Focus: removing the selected window must move the selection, not
    // leave it pointing at a con that no longer exists.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.focus(2); f.flush();
    f.change(2, {sticky: true}, 'membership'); f.flush();
    expect(f.engine.state().mode).toBe('default');
    expect(() => f.engine.run(parseCommands('focus left').commands, 0)).not.toThrow();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
  });

  it('admits a window that is already sticky at its first frame', () => {
    // Review Focus: the fix is about a transition, but a window mapped straight
    // onto a secondary output is sticky before it is ever classified. It must be
    // tracked and excluded, never dropped.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2, {sticky: true}); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
    f.change(2, {sticky: false}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/engine/lifecycle.test.ts`
Expected: the sticky and skip-taskbar tests FAIL — the window stays in the applied rectangles, because nothing consults those fields yet.

- [ ] **Step 3: Implement**

Import `excludedFromTree` from `./runtime/classify` in `src/engine.ts`. Then:

At `src/engine.ts:391`, replace the live-set filter:

```typescript
      tree.normalize(new Set(live.filter(w => !excludedFromTree(w)).map(w => w.id)));
```

At `src/engine.ts:485`, replace the branch condition:

```typescript
    if (excludedFromTree(info)) {
      this._minimized.set(id, this._minimized.get(id) ?? this._floating(info));
      tree.remove(id);
    } else {
```

Leave the else-branch exactly as it is: it already re-inserts an absent window beside the focus and already restores the floating state, which is the behaviour the spec chose. Do not rename `_minimized` — it now holds "the floating state this window had when it left the tree, for any reason", and renaming it is a larger change than this task; add a one-line comment saying so.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test && npm run typecheck && npm run check:layer0`
Expected: all green, typecheck now completely clean, `layer0 check ok`.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts test/unit/engine/
git commit -m "feat: exclude sticky and skip-taskbar windows from the tree per commit"
```

---

### Task 4: take ownership of `workspaces-only-on-primary`

**Files:**
- Modify: `src/shell/settings.ts:86-95`
- Test: `test/unit/shell/settings.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exported surface. `OverridePlan` is unchanged — the value is unconditional, like `dynamic-workspaces`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('clears workspaces-only-on-primary so a secondary output can tile', () => {
  const f = fixture();
  const mutter = new FakeSettings(MUTTER, {
    'dynamic-workspaces': true, 'workspaces-only-on-primary': true,
  });
  overrides(f.extension).apply(plan);
  expect(mutter.values['workspaces-only-on-primary']).toBe(false);
});

it('restores workspaces-only-on-primary on disable', () => {
  const f = fixture();
  const mutter = new FakeSettings(MUTTER, {
    'dynamic-workspaces': true, 'workspaces-only-on-primary': true,
  });
  const settings = overrides(f.extension);
  settings.apply(plan);
  settings.restoreAll();
  expect(mutter.values['workspaces-only-on-primary']).toBe(true);
});

it('keeps the original persisted when the restore has not run yet', () => {
  // Review Focus: if the shell dies before disable(), the user's GNOME setting
  // must not be silently left changed with no record of what it was.
  const f = fixture();
  new FakeSettings(MUTTER, {'dynamic-workspaces': true, 'workspaces-only-on-primary': true});
  overrides(f.extension).apply(plan);
  const snapshot = JSON.parse(
    writes.filter(w => w.schema === EXTENSION).at(-1)!.value as string);
  expect(snapshot['org.gnome.mutter']['workspaces-only-on-primary']).toBe(true);
});
```

The existing `fixture()` in that file already builds a `MUTTER` `FakeSettings` with `dynamic-workspaces` — read it and extend that one rather than constructing a second instance for the same schema, which would overwrite it in the shared `schemas` map.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/shell/settings.test.ts`
Expected: FAIL with `expected true to be false` on the first, and an `undefined` snapshot entry on the third.

- [ ] **Step 3: Implement**

In `src/shell/settings.ts`, beside the existing `dynamic-workspaces` handling:

```typescript
      const mutter = this._settings(MUTTER);
      if (mutter) {
        this._applyValue(MUTTER, mutter, 'dynamic-workspaces', false);
        // A window on a secondary output is on_all_workspaces while this is
        // true, and i3-shell keeps sticky windows out of the tree -- so the
        // external display could never tile. Phase 3B owns this key; the
        // original is snapshotted and restored on disable.
        this._applyValue(MUTTER, mutter, 'workspaces-only-on-primary', false);
      }
```

and in the `else` branch beside `this._restoreSaved(MUTTER, 'dynamic-workspaces');` add `this._restoreSaved(MUTTER, 'workspaces-only-on-primary');`.

**Read the surrounding code before editing:** the `dynamic-workspaces` apply sits inside `if (plan.workspaceCount > 0)`. `workspaces-only-on-primary` must **not** be conditional on the workspace count — a config with no named workspaces still needs its secondary output to tile. Place it outside that branch, beside the `mouse-button-modifier` apply, and restore it unconditionally.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/shell/settings.ts test/unit/shell/settings.test.ts
git commit -m "feat: clear workspaces-only-on-primary so secondary outputs tile"
```

---

### Task 5: spec amendments, native scenarios, and the acceptance checklist

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-i3-shell-design.md` — §7.10, §8.2, §16.2, §17
- Modify: `test/integration/phase2-checks.py`
- Create: `docs/acceptance/phase-3b.md`
- Modify: `README.md`, `PROJECT.md` — counts only, after the controller reports measured numbers

**Interfaces:**
- Consumes: the `'membership'` event and the exclusion behaviour from Tasks 2 and 3; the setting from Task 4.

- [ ] **Step 1: Apply the four main-spec amendments**

From spec §6, verbatim in intent:
- **§16.2** currently says "`org.gnome.mutter workspaces-only-on-primary` is left as is (single monitor today; Phase 4 revisits)". Replace: Phase 3B sets it to `false` on enable and restores it on disable, because a window on a secondary output is `on_all_workspaces` while it is true and i3-shell keeps sticky windows out of the tree.
- **§17's Phase 4 list** drops `workspaces-only-on-primary`; per-output focus and movement stay.
- **§7.10** gains the pinned-versus-derived note: a window returning to the tree has its floating state written into `_manualFloating`, converting a derived state into a pinned one. It is a no-op while kind cannot change, and becomes real if a later phase makes `transient` or `attached` mutable.
- **§8.2** records that `sticky` and `skipTaskbar` are no longer classification inputs, and that they are watched through `notify::on-all-workspaces` and `notify::skip-taskbar`.

- [ ] **Step 2: Write the failing native scenario**

Add `scenario_membership()` to `test/integration/phase2-checks.py`, registered in the **two-monitor** entry point (it needs a secondary output), asserting against real GTK windows:

- `org.gnome.mutter workspaces-only-on-primary` reads `false` while the extension is enabled;
- a window created on the secondary output is **tracked** — it appears in `GetWindows` with an id — and is `tiled` there, with a rect inside that monitor's work area;
- moving it to the primary output keeps it tracked and tiles it there;
- moving it back tiles it on the secondary again, which is the assertion that would have failed before this phase, because the window would have been dropped on the first move.

Extend the existing `--settings` scenario so its snapshot covers `('org.gnome.mutter', 'workspaces-only-on-primary')` and its `EXPECTED_CLEARINGS`-equivalent expects it cleared on enable and restored on disable — the mechanism `scenario_settings` already uses for the IBus keys.

- [ ] **Step 3: Request the harness run**

You do not run this. Hand the controller: `bash test/integration/run.sh`, and freeze `test/integration/phase2-checks.py` until the output returns.
Expected: the new assertions pass; the run reports a higher assertion count than 228.

- [ ] **Step 4: Write the acceptance checklist**

Create `docs/acceptance/phase-3b.md` in the same shape as `docs/acceptance/phase-3.md` — read that file and follow it. Product revision, build under test, environment, a "how to run this walk" block, one **unchecked** box per criterion A22–A27 from the spec, an automated-evidence table, and a "what the automation does not cover" list. **Nothing in this repository may tick a box.**

State these explicitly so the user does not report them as defects:
- while the extension is enabled, GNOME treats workspaces as spanning every output, which changes behaviour for **every** application, and `disable()` puts it back;
- a window pinned to all workspaces deliberately leaves the tiling;
- there is still no `tiled ⇄ floating` reclassification — a window's kind is fixed at its first frame (spec §3.4);
- the walk needs a logout and login, because Wayland cannot reload extension code in place.

- [ ] **Step 5: Verify and commit**

Run: `python3 -m py_compile test/integration/phase2-checks.py`, then request `bash test/integration/run.sh` from the controller. Do not guess the assertion counts for `README.md` / `PROJECT.md`; the controller measures them and supplies the numbers.

```bash
git add docs/superpowers/specs/2026-09-20-i3-shell-design.md test/integration/phase2-checks.py docs/acceptance/phase-3b.md README.md PROJECT.md
git commit -m "test: native membership scenarios and the phase 3B acceptance checklist"
```
