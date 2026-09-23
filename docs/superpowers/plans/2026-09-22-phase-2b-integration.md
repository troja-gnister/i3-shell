# Phase 2B — Live window integration Implementation Plan

**Paused by user request, 2026-09-22.** Tasks 1–9 are implemented and independently reviewed on `phase-2b`; Task 10 was stopped after reading its brief, with no edits or active commands. Resume only when asked. See the [handoff](../../handoff-2026-09-22.md) for the exact checkpoint, verified release installation and remaining work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the completed tree to GNOME windows so opening, focusing, moving, resizing, floating and closing windows behave as specified by A8–A14.

**Architecture:** Keep the tested tree pure and make `Engine` its sole runtime owner. Shell adapters translate native objects and signals into ids, snapshots and effects; one commit pipeline applies geometry and publishes state. Test asynchronous behavior with deterministic fakes before exercising real GTK windows in an isolated nested shell.

**Tech Stack:** Existing TypeScript 5.9, GNOME Shell 50 / Mutter 18, GJS, esbuild, Vitest, fast-check and ESLint; GTK4 for integration fixtures. No additional runtime or development dependencies.

**Spec:** [Approved design](../specs/2026-09-20-i3-shell-design.md), especially §§5, 6.6–6.7, 7, 8, 9, 13–16 and A8–A14. Read [PROJECT.md](../../../PROJECT.md), the [Phase 1 carry-forward](2026-09-21-phase-1-carry-forward.md), and the completed [Phase 2A record](2026-09-21-phase-2a-tree.md) first.

**Historical preparation baseline:** `main` at `568855c`; Phase 2A merged and its branch deleted, with 234 tests in 22 files. A1–A7 had passed by user report. Current implementation/verification is recorded below; the completed tasks and native checks do not certify the pending A8–A14 live walk.

During preparation the user configured `origin` as `git@github.com:troja-gnister/i3-shell.git` and pushed `main` at `568855c`, with `origin/main` tracking. This plan's later documentation changes have not been pushed.

## Global Constraints

- Target: `GNOME Shell 50.x (Mutter 18), Wayland session, Fedora Silverblue 44`.
- License: `GPL-2.0-or-later`; UUID `i3-shell@troja`; `shell-version ["50"]`; `session-modes ["user", "unlock-dialog"]`.
- `Layer 0 never imports gi:// or resource:// modules.` Include new `src/runtime/` files in the existing purity check.
- `only engine.ts mutates the tree, and every mutation goes through engine.commit()`. Pure Tree methods remain the structural authority.
- `commit() is the only path that changes window geometry.` This includes floating resize/position commands and corrective applications.
- Window commands target the engine selection, using `WindowId` operations; never query GNOME focus at dispatch.
- Exactly four forced geometry generations: fullscreen exit, unminimize, monitors-changed, and completion of engine-initiated unmaximize. Workspace changes use the normal diff.
- At most one corrective re-apply per expected-rect generation. Fullscreen and minimized windows are exempt while in those states.
- Split coverage/non-overlap applies to `splith`/`splitv` children. Tabbed/stacked children share the parent rect and the active subtree is raised.
- Static workspace count: `minimum 1, maximum 36`. Config count zero means use the current count, still enforce static workspaces.
- Preserve Phase 1 recovery tests and all Phase 2A tree/property tests. Do not weaken checks to accommodate integration.
- Keep pinned `@girs` versions, `legacy-peer-deps` installation convention, and the documented narrow `Main.actionMode` cast; do not solve API errors with blanket casts or `any`.
- Implementation uses a new `phase-2b` branch **in this checkout**, not a worktree, because installation symlinks this checkout's `dist/`. Planning alone does not switch branches.
- Keep subagent-driven execution, per-task review and whole-branch review. The controller owns git staging/commits after a worker has finished. Use the actual authoring model in the co-author trailer.
- Every session that runs integration ends with release `make install`, including a failed integration run. Do not log out the user or claim a live walk on their behalf.
- Phase 3 retains decoration actors/borders/tab bars. Phase 4 retains rules, urgent pills, cross-monitor navigation, workspace back-and-forth and full dock/lid fidelity. Ask about scaling/resolutions when Phase 4 planning begins.
- `marks; scratchpad` remain non-goals for v1. No remote setup or push in this plan.

## Review Focus

1. **A window dies before first-frame or during apply:** no ghost leaf, stale native operation, leaked signal, or reused id. Tasks 3 and 5 test both timings.
2. **Duplicate/late native geometry notifications:** one correction per generation, no retry loop, and all four invalidations retry an unchanged rectangle. Tasks 4 and 5 pin the state transitions.
3. **A selected parent and GNOME's focused leaf disagree by design:** activation acknowledgements preserve the parent; real focus changes update it; kill/transfer act on all selected leaves. Tasks 5 and 6 exercise this.
4. **Reload or monitor reindexing while windows exist:** surviving tree structure and percentages remain intact; vanished roots migrate without losing windows or replaying stale workspace acknowledgements. Tasks 1, 2 and 5 exercise this.
5. **Enable while locked, disable twice, or lose D-Bus ownership:** no bare-key exposure, abandoned callback, or geometry write during teardown; snapshots survive failed restore. Tasks 1 and 7 plus the nested cycle cover these cases.

---

## File boundaries and task order

| Task | Files / responsibility |
|---|---|
| 1 | `src/shell/settings.ts`, existing settings fake/tests: reconcile successive override plans without temporarily restoring workspace settings; reset/sync restoration |
| 2 | `src/tree/tree.ts`, `test/unit/tree/topology.test.ts`: validated workspace/monitor topology changes preserving owned nodes |
| 3 | `src/runtime/model.ts`, `src/runtime/classify.ts`; `src/shell/windowTracker.ts` and existing `windows.ts`: plain contracts, testable id/event lifetime, native bridge |
| 4 | `src/runtime/reconcile.ts`, `src/shell/geometry.ts`, `src/shell/geometryBackend.ts`: retry ledger, stable monitor identity/work areas, sole native rectangle writer |
| 5 | `src/engine.ts`, `src/extension.ts`, `src/shell/workspaces.ts`, `src/runtime/snapshot.ts`: tree ownership, lifecycle, commit, adoption/reload/restart, atomic port cutover |
| 6 | `src/engine.ts`: selection-based commands and floating geometry |
| 7 | `src/shell/control.ts`, `src/shell/session.ts`, `src/extension.ts`: observable state, TreeChanged, initial lock state, total teardown and name loss |
| 8 | `src/util/smoothScroll.ts`, `src/shell/indicator.ts`, `src/shell/keys.ts`, config sources/tests: remaining bounded Phase 1 carry-forward fixes |
| 9 | `test/integration/{nested.sh,inside.sh,windows.js,client.py,phase1-checks.sh}`: isolated GTK fixture and retained Phase 1 acceptance |
| 10 | `test/integration/phase2-checks.py`, package script, `docs/acceptance/phase-2.md`, handbook/README: A8–A14 automation and delivery record |

The runtime helpers contain plain values and pure bookkeeping. `windowTracker.ts` and `geometryBackend.ts` are testable adapter implementations with injected structural native dependencies; their GNOME construction lives in `windows.ts`/`geometry.ts`. Unit tests must not import `extension.ts` or the GNOME-global bridge files into the Node TypeScript program.

### Shared contracts (introduced by the producing task)

Task 3 creates these exports in `src/runtime/model.ts`:

~~~ts
import type {WindowId, MonitorId, Rect} from '../tree/node';

export type WindowKind = 'tiled' | 'floating';
export interface WindowFacts {
  type: 'normal' | 'dialog' | 'modal-dialog' | 'utility' | 'ignored';
  skipTaskbar: boolean;
  transient: boolean;
  attached: boolean;
  sticky: boolean;
  resizable: boolean;
}
export interface WindowInfo {
  id: WindowId;
  kind: WindowKind;                 // initial classification, not a floating override
  workspace: number;                // zero-based
  monitor: MonitorId | null;        // stable adapter id; null while topology is unavailable
  rect: Rect;
  title: string;
  wmClass: string | null;
  minimized: boolean;
  fullscreen: boolean;
  maximizedH: boolean;
  maximizedV: boolean;
}
export type WindowEvent =
  | {type: 'added'; id: WindowId}
  | {type: 'removed'; id: WindowId}
  | {type: 'focused'; id: WindowId | null}
  | {type: 'frame' | 'workspace' | 'minimized' | 'fullscreen' | 'maximized'; id: WindowId};

export interface WindowsPort {
  list(): readonly WindowInfo[];    // ready, still-live windows only, per-workspace MRU order
  get(id: WindowId): WindowInfo | undefined;
  focused(): WindowId | null;       // initialization/adoption only
  activate(id: WindowId, timestamp: number): boolean;
  kill(id: WindowId, timestamp: number): boolean;
  fullscreen(id: WindowId, action: 'toggle' | 'enable' | 'disable'): boolean;
  moveToWorkspace(id: WindowId, index: number): boolean;
  unmaximize(id: WindowId): boolean;
  raise(id: WindowId): boolean;
}
export interface MonitorInfo {
  id: MonitorId;
  index: number;                   // current Mutter index
  connectors: readonly string[];
}
export interface Topology {
  primary: MonitorId;
  monitors: readonly MonitorInfo[];
  workAreas: ReadonlyMap<number, ReadonlyMap<MonitorId, Rect>>;
}
export interface GeometryPort {
  topology(): Topology | null;     // null during an empty/transient monitor topology
  apply(rects: ReadonlyMap<WindowId, Rect>): ReadonlySet<WindowId>;
}
export interface DeferredPort {
  defer(callback: () => void): number;
  cancel(token: number): void;
}
~~~

Task 5 extends `EnginePorts` atomically with `windows: WindowsPort`, `geometry: GeometryPort`, `deferred: DeferredPort`, `now(): number` (Unix milliseconds), `settings.apply(config: Config, workspaceCount: number): void` and `indicator.setPills(pills: PillState[]): void`, `indicator.setVisible(visible: boolean): void`. Define `PillState {name: string; active: boolean; occupied: boolean}` in `runtime/model.ts` and import that type in the indicator. Keep existing keys, logging, config, exec, workspaces and other indicator contracts. Use `Date.now` for the native clock and a fixed fake clock in unit tests.

### Native facts verified during preparation

- `Meta.WindowActor::first-frame` is emitted even for an initially hidden/other-workspace window. The installed GIR explicitly says the actor exists at `display::window-created` and has not yet drawn. Existing mapped windows must be adopted directly; attaching a new first-frame handler to them is ineffective.
- Task 9 native qualification: the synthetic GTK fixture's first frame was delayed in the initial overview. Tests wait for readiness, press Escape and poll NORMAL before creating normal fixtures. Production still waits for the actual first-frame signal.
- `Meta.Window.unmaximize()` takes **no arguments**. Read the two maximized properties; coalesce their notifications.
- `Meta.MonitorManager.get_monitors()`, `Monitor.get_connector()` and `get_monitor_for_connector()` allow connector groups to be associated with current logical-monitor indices. Keep internal numeric ids stable across index changes.
- `Meta.Workspace.get_work_area_for_monitor(index)` provides each workspace's work area. Do not use only the active workspace's work area for every root.
- `gnome-shell --help` confirms `--wayland-display`, `--headless` and repeatable virtual-monitor usage. GTK clients must connect to the nested socket explicitly.
- Installed `windowManager.js` implements `allowKeybinding(name, modes)` by assigning an entry in `_allowedKeybindings`; `removeKeybinding` only clears permission when `display.remove_keybinding` succeeds. It is not an unregister API for external accelerators. Task 8 revokes permission with `NONE` and documents the residual zero-valued entries, preserving exclusive resize-mode grabs.
- No live integration was run to prepare this plan; runtime-dependent claims below remain tests to perform.

## Task 1: Reconcile settings without disrupting running workspaces

**Files:** Modify `src/shell/settings.ts`, `test/unit/shell/fakes/settings.ts`, `test/unit/shell/settings.test.ts`.

**Interfaces:**
- Consumes existing `OverridePlan` and persisted `Snapshot` values.
- Produces unchanged `SettingsOverrides.apply(plan: OverridePlan): ClearedBinding[]`, now safe to call repeatedly without `restoreAll()` between calls; `restoreAll(): void` retains failure recovery and adds reset/sync.
- The engine switches to this contract in Task 5. Until then, existing call sites still compile.

- [x] **Write the reload regression using the existing fixture.**

~~~ts
it('reconciles bindings without restoring the original workspace count', () => {
  const f = fixture();
  const settings = overrides(f.extension);
  settings.apply(plan);
  writes.length = 0;
  settings.apply({...plan, accels: ['<Super>s']});
  expect(f.keys.get_strv('switch-to-application-1')).toEqual(['<Super>1', '<Alt>F1']);
  expect(f.keys.get_strv('toggle-overview')).toEqual([]);
  expect(writes.filter(w => w.key === 'num-workspaces')).toEqual([]);
  expect(f.prefs.get_int('num-workspaces')).toBe(3);
  settings.restoreAll();
  expect(f.prefs.get_int('num-workspaces')).toBe(4);
});
~~~

- [x] **Run RED:** `npx vitest run test/unit/shell/settings.test.ts`. The restored former binding/no redundant workspace write assertions fail.
- [x] **Implement reconciliation.** For a saved binding, derive the next filtered value from its saved original, not its already-filtered current value. For unsaved keys use current values. Restore and retire a saved binding when the new plan no longer overrides it; preserve the snapshot entry on failure. Keep originals for workspace/mouse keys that remain overridden and only write when the desired value differs. Never temporarily restore `dynamic-workspaces` or `num-workspaces` while applying another plan.
- [x] **Extend the fake and write reset/sync tests.** Add explicit `defaults` and `userValues` stores to `FakeSettings`, `get_default_value(key)`, `get_value(key)`, `get_user_value(key)` and `reset(key)`, and an exported `syncCalls` counter incremented by `fakeGio.Settings.sync()`. Add `resetFakeSettings(): void` for beforeEach to clear schemas, writes and the counter. Defaults initially clone constructor values and can be changed by individual tests. Preserve false/throw injection; a false reset failure leaves the value and user override unchanged.

~~~ts
it('resets an original equal to its default and syncs restoration', () => {
  const f = fixture();
  f.prefs.defaults['num-workspaces'] = 4;
  const settings = overrides(f.extension);
  settings.apply(plan);
  settings.restoreAll();
  expect(f.prefs.get_user_value('num-workspaces')).toBeNull();
  expect(f.prefs.get_int('num-workspaces')).toBe(4);
  expect(syncCalls).toBe(1);
});
~~~

Also assert that failed resets retain the original; non-default originals use their typed setter; missing schemas retain entries; repeated restoration remains safe; each live mutation still follows persistence of the original.
- [x] **Implement confirmed restoration.** Compare the saved value with `get_default_value(key)?.deep_unpack()`. If equal, reset and confirm `get_user_value(key) === null` plus effective-value equality before retiring the entry. Otherwise use the existing typed setter path. Save the residual snapshot, then `Gio.Settings.sync()`. Guard failures per key and retain the existing recovery tests.
- [x] **Verify GREEN:** focused settings suite, `npm run typecheck` and `npm run check:layer0`.
- [x] **Commit:** `fix(settings): reconcile overrides without workspace resets`, with actual model trailer. No host settings are read or written by these unit tests.

## Task 2: Preserve tree ownership across topology changes

**Files:** Modify `src/tree/tree.ts`; create `test/unit/tree/topology.test.ts`; extend `test/unit/tree/properties.test.ts` with bounded topology operations.

**Interfaces:**
- Consumes existing Tree/node/layout APIs and its private id allocator.
- Produces `Tree.reconfigure(workspaceCount: number, monitors: readonly MonitorId[], primary: MonitorId): Map<WindowId, number>`. The returned map lists only windows whose workspace changed.
- Existing monitor ids/root objects survive when present in the new topology. No root is attached as a child; transferred root contents get a newly allocated non-root wrapper when needed.

- [x] **Write the vanished-monitor and shrinking-workspace tests.**

~~~ts
it('appends vanished-root contents under the primary without losing descendants', () => {
  const tree = new Tree(2, [10, 20]);
  const a = tree.insert(1, 0, 10);
  const b = tree.insert(2, 0, 20);
  tree.select(b);
  tree.split('v');
  const c = tree.insert(3, 0, 20);
  const keptRoot = tree.root(0, 10);
  expect(tree.reconfigure(2, [10], 10)).toEqual(new Map());
  expect(tree.root(0, 10)).toBe(keptRoot);
  expect(tree.find(1)).toBe(a);
  expect(tree.find(2)).toBe(b);
  expect(tree.find(3)).toBe(c);
  expect([...leaves(keptRoot)].map(n => n.window)).toEqual([1, 2, 3]);
  expect(() => tree.check()).not.toThrow();
});

it('moves removed workspace contents to the last retained workspace', () => {
  const tree = new Tree(3, [10]);
  const a = tree.insert(1, 2, 10);
  tree.addFloating(2, 2);
  const moves = tree.reconfigure(2, [10], 10);
  expect(moves).toEqual(new Map([[1, 1], [2, 1]]));
  expect(tree.find(1)).toBe(a);
  expect(tree.workspace(1).floating).toContain(2);
  expect(() => tree.check()).not.toThrow();
});
~~~

`Tree.check()` returns void and throws on an invalid tree; preserve that existing API.
- [x] **Run RED:** `npx vitest run test/unit/tree/topology.test.ts`. Missing `reconfigure` fails.
- [x] **Implement the transaction.** Validate count, unique nonnegative monitor ids and primary membership before any mutation. Add missing roots/workspaces. In each surviving workspace, append each vanished root's contents under its primary root in old monitor iteration order. Preserve subtree layout, percentages, descendant ids and focus, allowing the already-approved normalization rules.
- [x] **Implement count changes.** Growing adds empty workspaces. Shrinking appends each removed workspace's monitor contents to corresponding roots of index `workspaceCount - 1`, then appends its floating MRU list without duplicates. Record workspace moves for every affected id. Clamp the active index; preserve a moved active selection, otherwise retain the destination's selection. Normalize and repair ownership before returning.
- [x] **Implement root-content transfer inside the Tree module.** Validate the complete target topology first, then use this helper; subsequent normalization uses existing Tree rules.

~~~ts
function appendRootContents(source: SplitCon, target: SplitCon, allocate: AllocateSplit): void {
  if (source.children.length === 0) return;
  const wrapper = allocate(source.layout);
  wrapper.lastSplitLayout = source.lastSplitLayout;
  wrapper.children = source.children;
  wrapper.percents = source.percents;
  wrapper.focusedChild = source.focusedChild;
  for (const child of wrapper.children) child.parent = wrapper;
  source.children = [];
  source.percents = [];
  source.focusedChild = null;
  attach(target, wrapper, target.children.length);
}
~~~

- [x] **Add validation/identity/property coverage.** Invalid count/duplicate monitors/missing primary leave a serialized tree unchanged. Monitor array order changes preserve root identities. Exercise simultaneously removed workspace and monitor, empty roots, selected split/root, floating-only workspaces and growth after shrink. Property model maintains an independent id→workspace map and checks every surviving id exactly once plus existing per-container layout properties.
- [x] **Verify GREEN:** `npx vitest run test/unit/tree`, `npm run lint:tree`, `npm run typecheck`.
- [x] **Commit:** `feat(tree): preserve contents across workspace and monitor changes`.

## Task 3: Track real windows by id and first-frame lifetime

**Files:** Create `src/runtime/model.ts`, `src/runtime/classify.ts`, `src/shell/windowTracker.ts`, `test/unit/runtime/classify.test.ts`, `test/unit/shell/windowTracker.test.ts`; modify `src/shell/windows.ts` and `scripts/check-layer0.mjs`.

**Interfaces:**
- Consumes shared contracts above and injected native operations.
- Produces `classifyWindow(facts: WindowFacts): WindowKind | null` and `WindowTracker<W extends object>` implementing `WindowsPort`.
- Tracker constructor: `new WindowTracker(native: WindowBackend<W>, emit: (event: WindowEvent) => void)`.
- Tracker lifecycle: `start(): void`, `destroy(): void`, `resolve(id: WindowId): W | undefined`.
- `WindowBackend<W>` is structural and GI-free: `existing(): readonly W[]` (per-workspace MRU), `facts(w): WindowFacts`, `info(w): Omit<WindowInfo, 'id' | 'kind'>`, `focused(): W | null`, `watchCreated(cb: (w: W) => void): () => void`, `watch(w, cb: (event: Exclude<WindowEvent['type'], 'added'>) => void): () => void`, `firstFrame(w, cb: () => void): () => void`, and `activate(w,timestamp)`/`kill(w,timestamp)`/`fullscreen(w,action)`/`moveToWorkspace(w,index)`/`unmaximize(w)`/`raise(w)`, each returning boolean.
- `windows.ts` exports `class ManagedWindows extends WindowTracker<Meta.Window>` with constructor `(emit: (event: WindowEvent) => void, monitorId: (index: number) => MonitorId | undefined)`. The injected lookup may return undefined during monitor transitions; snapshots represent that as null, and the engine uses the valid topology's primary id when it needs a destination.
- Keep the old Phase 1 `Windows` wrapper temporarily so this commit builds independently; Task 5 removes it and all focused-window methods in one port cutover.

- [x] **Pin classification priority.**

~~~ts
const normal: WindowFacts = {
  type: 'normal', skipTaskbar: false, transient: false,
  attached: false, sticky: false, resizable: true,
};
expect(classifyWindow(normal)).toBe('tiled');
expect(classifyWindow({...normal, resizable: false})).toBe('floating');
expect(classifyWindow({...normal, transient: true})).toBe('floating');
expect(classifyWindow({...normal, type: 'ignored', transient: true})).toBeNull();
expect(classifyWindow({...normal, sticky: true})).toBeNull();
~~~

Table-test dialog/modal/utility, attached dialogs, hidden-taskbar ordinary windows, and every ignored native type. Ordinary sticky/skip-taskbar windows that meet none of the explicit floating cases are ignored; transient/dialog/fixed-size normal windows use the specified floating path. Map unrecognized native window types to `ignored`.
- [x] **Run RED:** `npx vitest run test/unit/runtime/classify.test.ts test/unit/shell/windowTracker.test.ts`.
- [x] **Implement classification with ignored types first.**

~~~ts
export function classifyWindow(f: WindowFacts): WindowKind | null {
  if (f.type === 'ignored') return null;
  if (f.type !== 'normal' || f.transient || f.attached || !f.resizable)
    return 'floating';
  return f.skipTaskbar || f.sticky ? null : 'tiled';
}
~~~

- [x] **Build a fake backend and lifetime tests.** Define `fakeWindowBackend()` in the test file with `backend: WindowBackend<object>`, `create(facts: WindowFacts): object`, `draw(w: object): void`, `remove(w: object): void`, `focus(w: object | null): void`, `subscriptionCount(): number`, callback maps and recorded operations. Callbacks remove themselves through returned disposers.

~~~ts
const f = fakeWindowBackend();
const events: WindowEvent[] = [];
const tracker = new WindowTracker(f.backend, e => events.push(e));
tracker.start();
const gone = f.create(normal);
expect(tracker.list()).toEqual([]);
f.remove(gone);
f.draw(gone);
expect(events.filter(e => e.type === 'added')).toEqual([]);
const live = f.create(normal);
f.draw(live);
const id = tracker.list()[0].id;
f.remove(live);
expect(tracker.resolve(id)).toBeUndefined();
expect(tracker.kill(id, 7)).toBe(false);
tracker.destroy();
tracker.destroy();
expect(f.subscriptionCount()).toBe(0);
~~~

Also test preexisting windows require no new first-frame, duplicate draw/unmanaged notifications, MRU ordering, untracked splash, no id reuse, operations after destroy, and removal of both map directions before emitting `removed`.
- [x] **Implement tracker and native bridge.** Keep pending native handles without tracked ids; classify and assign a monotonic id at first-frame, when transient/resizable properties are settled. Existing mapped windows take this readiness path immediately. Ignored windows get no id and release their pending subscriptions. Ready windows appear in `list/get`. Register unmanaged before first-frame, cancel every per-window subscription on removal, and deduplicate repeated ready/focus events. The bridge connects both window focus and display focus notifications and reports current focus truth. Include title and `get_wm_class()` in fresh plain snapshots; never leak `Meta.Window` to Engine.
- [x] **Verify GREEN:** focused tests, `npm run typecheck`, `npm run check:layer0`. Add `src/runtime` to purity roots now.
- [x] **Commit:** `feat(windows): add id-based window tracking and first-frame adoption`.

## Task 4: Apply geometry with bounded reconciliation

**Files:** Create `src/runtime/reconcile.ts`, `src/shell/geometryBackend.ts`, `src/shell/geometry.ts`, `test/unit/runtime/reconcile.test.ts`, `test/unit/shell/geometryBackend.test.ts`.

**Interfaces:**
- `RectReconciler.plan(expected: ReadonlyMap<WindowId, Rect>, forced: ReadonlySet<WindowId>): Map<WindowId, Rect>` records targets/generations before native writes and includes queued corrections.
- `observe(id: WindowId, actual: Rect, generation: number): boolean` queues at most one correction and reports whether a commit is needed.
- `generation(id): number | undefined`, `forget(id): void`, `clear(): void`; `status(id): {expected: Rect; generation: number; retried: boolean; stubborn: boolean} | undefined` for snapshots/tests.
- Omitted ids are suspended, not implicitly forgotten; Engine explicitly forgets removed/floating ids. This preserves the old generation while fullscreen/minimized; returning lifecycle events explicitly force a fresh one.
- `GeometryBackend<W>` implements `GeometryPort` with constructor `(resolve: (id: WindowId) => W | undefined, moveResize: (window: W, rect: Rect) => void, readTopology: () => Topology | null, onError: (id: WindowId, error: unknown) => void)`. It also provides `destroy(): void`; apply after destroy returns an empty set. Catch native failure per id, report it through onError and continue with surviving ids.
- `MonitorIds` in `geometryBackend.ts` provides `update(monitors: readonly {index: number; connectors: readonly string[]}[]): MonitorInfo[]`, `id(index: number): MonitorId | undefined` and `clear(): void`. It keeps connector-group identity across update calls and replaces the current index lookup each time.
- `geometry.ts` exports `class Geometry implements GeometryPort` with constructor `(resolve: (id: WindowId) => Meta.Window | undefined)`, `monitorId(index: number): MonitorId | undefined`, and `destroy(): void`; it composes GeometryBackend and MonitorIds. No consumer imports those native types into the engine.

- [x] **Write the complete generation regression.**

~~~ts
const r = new RectReconciler();
const a = {x: 0, y: 30, width: 500, height: 700};
const wrong = {...a, width: 640};
expect(r.plan(new Map([[1, a]]), new Set())).toEqual(new Map([[1, a]]));
const g = r.generation(1)!;
expect(r.observe(1, a, g)).toBe(false);
expect(r.observe(1, wrong, g)).toBe(true);
expect(r.observe(1, wrong, g)).toBe(false);
expect(r.plan(new Map([[1, a]]), new Set())).toEqual(new Map([[1, a]]));
expect(r.observe(1, wrong, g)).toBe(false);
expect(r.status(1)?.stubborn).toBe(true);
expect(r.plan(new Map([[1, a]]), new Set())).toEqual(new Map());
expect(r.plan(new Map([[1, a]]), new Set([1]))).toEqual(new Map([[1, a]]));
expect(r.generation(1)).not.toBe(g);
expect(r.observe(1, wrong, g)).toBe(false); // stale observation cannot spend the new retry
~~~

Add changed target resetting the budget; equal-value fresh rectangle objects not resetting it; duplicated size+position events; observed match after a retry not restoring its allowance; forgotten ids; empty apply; suspended fullscreen/minimized targets.
- [x] **Run RED:** `npx vitest run test/unit/runtime/reconcile.test.ts test/unit/shell/geometryBackend.test.ts`.
- [x] **Implement explicit state transitions.** Each entry owns expected rect, monotonic generation, correctionQueued, retried and stubborn. New target/force creates a generation; first mismatching observation queues correction; emitting that correction consumes the retry; a later mismatching observation marks stubborn. Matching and stale notifications have no effect on the budget. Clear queued correction when the observed frame returns to target before dispatch.
- [x] **Test apply-time resolution and monitor identity.** A fake writer removes id 2 while applying id 1; only id 1 is written and returned in the applied set. Confirm integer x/y/width/height are passed unchanged, repeated destroy is safe, native failure for one id does not prevent the next id's application, and a vanished id is skipped. Feed MonitorIds connector groups at indices 0/1, remove the former index 0, then feed the surviving connector at index 0: its stable id must remain unchanged. Re-add the vanished connector, test mirrored connector groups and verify clear empties the lookup.
- [x] **Implement geometry/topology bridge.** `move_resize_frame(false, x, y, width, height)` exists only in this adapter. Group active connectors by Mutter logical index, sort each connector group into a stable key, and retain an internal key→monotonic numeric id map across topology snapshots. Reindexing preserves ids; genuinely vanished/returned groups use their retained key identity. Read each workspace's work area using the current native index. Return null if no usable logical monitor/work area exists; Engine retains its current tree until a complete snapshot arrives.
- [x] **Pin asynchronous observation behavior.** Native size/position events are coalesced by Engine into a deferred fresh frame read (Task 5). Do not immediately read the pre-configure Wayland frame after `move_resize_frame` and call it a refusal. A consumed retry stays consumed if the client emits no further notification; do not poll forever or manufacture acknowledgement with an arbitrary delay.
- [x] **Verify GREEN:** focused suites, typecheck, Layer 0 check.
- [x] **Commit:** `feat(geometry): bound corrections by expected rectangle generation`.

## Task 5: Make Engine own the tree, lifecycle and commit pipeline

**Files:** Modify `src/engine.ts`, `src/extension.ts`, `src/shell/windows.ts`, `src/shell/workspaces.ts`, `src/shell/indicator.ts`, `test/unit/engine.test.ts`; create `src/runtime/snapshot.ts`, `test/unit/runtime/snapshot.test.ts`, `test/unit/engine/fakeEngine.ts`, `test/unit/engine/lifecycle.test.ts`.

**Interfaces:**
- Consumes Tasks 1–4, `layoutWithRects(root, area)`, `stackingOrder(root)` and the existing Tree facades.
- Produces `Engine.start(locked = false): void`, `onWindowEvent(event: WindowEvent): void`, `onWorkspacesChanged(): void`, `onMonitorsChanged(): void`, `relayout(): void`, `treeSnapshot(): TreeSnapshot`, `windowsSnapshot(): WindowSnapshot[]`, `subscribeTreeChanged(callback: () => void): () => void`.
- `commit(change?: () => void): void` is the engine's internal transaction boundary. Native callbacks received during a commit are queued; they cannot recursively mutate the tree being traversed. Coalesce frame notifications by id with a cancellable `DeferredPort` callback.
- `serializeTree(tree: Tree, topology: Topology, rects: ReadonlyMap<Con, Rect>, windows: ReadonlyMap<WindowId, WindowInfo>, revision: number): TreeSnapshot` in `runtime/snapshot.ts` is a read-only projection. Define snapshot types there:

~~~ts
export type NodeSnapshot =
  | {kind: 'leaf'; id: NodeId; window: WindowId; title: string;
     wmClass: string | null; rect: Rect | null}
  | {kind: 'split'; id: NodeId; layout: Layout; lastSplitLayout: SplitLayout;
     rect: Rect | null; children: NodeSnapshot[]; percents: number[];
     focusedChild: NodeId | null};

export interface TreeSnapshot {
  version: 1;
  revision: number;
  ready: boolean;
  activeWorkspace: number;
  workspaces: Array<{
    index: number;
    selected: {kind: 'tiled'; nodeId: NodeId} |
              {kind: 'floating'; window: WindowId} | null;
    floating: WindowId[];
    monitors: Array<{id: MonitorId; workArea: Rect | null; root: NodeSnapshot}>;
  }>;
}
export interface WindowSnapshot extends WindowInfo {
  state: 'tiled' | 'floating' | 'minimized';
  expectedRect: Rect | null;
  generation: number | null;
  stubborn: boolean;
}
~~~

Import the existing types from `tree/node`, `commands/model` and `runtime/model`. Snapshots contain arrays/values, never Maps, parents, functions or native objects. Before a usable topology exists, return `ready: false` and an empty workspace array; do not invent a monitor. Frame values in `windowsSnapshot()` come from current native observations, not the target rectangles.

- [x] **Create the deterministic engine fixture.** Move the existing config/key/settings fake behavior into `fakeEngine.ts`, preserving all current Phase 1 assertions except those intentionally changed below. Export `fakeEngine(): EngineFixture`, with `engine`, `calls: string[]`, `applied: Array<Map<WindowId, Rect>>`, `windows: Map<WindowId, WindowInfo>`, `add(id, patch?: Partial<WindowInfo>): void`, `change(id, patch, eventType): void`, `focus(id): void`, `remove(id): void`, `flush(): void`, `setNextLoad(loaded): void`, `setTopology(topology): void` and `onApply: ((id: WindowId) => void) | null`. All are test-only exports.

Default windows use workspace 0, monitor 10, normal/tiled classification, rect `{x: 20, y: 40, width: 300, height: 200}`, false state flags, a unique title and `wmClass: 'fixture'`. Topology contains monitor 10 and work area `{x: 0, y: 30, width: 1000, height: 700}` for ten workspaces. `add/change/remove/focus` update native truth before delivering the corresponding event. The fake geometry writer records requests and updates frame truth, except when a test injects refusal/death. `flush()` drains a deterministic callback queue with a failure limit, never a real timer. Window operations record strings such as `kill:1` and `moveTo:1:2`.

- [x] **Write adoption and death-during-apply regressions.**

~~~ts
it('adopts first-frame windows and retiles after removal during apply', () => {
  const f = fakeEngine();
  f.engine.start();
  f.add(1);
  f.add(2);
  f.flush();
  expect(f.engine.windowsSnapshot().find(w => w.id === 1)?.expectedRect)
    .toEqual({x: 0, y: 30, width: 500, height: 700});
  f.onApply = id => { if (id === 1) f.remove(2); };
  f.change(1, {rect: {x: 99, y: 99, width: 400, height: 400}}, 'frame');
  f.flush();
  expect(f.engine.windowsSnapshot().map(w => w.id)).toEqual([1]);
  expect(f.engine.windowsSnapshot()[0].expectedRect)
    .toEqual({x: 0, y: 30, width: 1000, height: 700});
});
~~~

Also populate `f.windows` before start to test existing-window adoption. Iterate each workspace's adapter MRU list in its returned order, then explicitly restore its most recent selection; finally use native focus if tracked. This avoids accidentally selecting the oldest window because insertion updates focus. New windows select their inserted leaf/floating entry; background-workspace insertion must not change the active workspace.

- [x] **Run RED:** `npx vitest run test/unit/engine.test.ts test/unit/engine/lifecycle.test.ts test/unit/runtime/snapshot.test.ts`.
- [x] **Cut over ports and extension wiring atomically.** Construct Geometry with a resolver closure, then ManagedWindows with geometry's monitor-id lookup, then Engine. Start window tracking before Engine adoption. Connect workspace count/active events to `onWorkspacesChanged`, `Main.layoutManager::monitors-changed` to `onMonitorsChanged`, and `display::workareas-changed` to ordinary `relayout`; work-area notifications are not another forced-generation exception. Supply DeferredPort using guarded, cancellable GLib idle sources; cancel all outstanding sources on teardown. Implement indicator `setPills` by forwarding to existing `setWorkspaces`, and `setVisible` through show/hide. Remove the old Windows wrapper and all three focused-window helpers. Route existing kill/fullscreen/move-to-workspace commands to selected ids now; Task 6 expands and tests every command.

Seed Geometry's monitor lookup with `geometry.topology()` before starting the tracker; if no usable topology exists, retain ready windows for later adoption rather than inventing a monitor id. The settings bridge uses the effective count even when the parsed config count was zero:

~~~ts
apply: (config, workspaceCount) => {
  overrides.apply(planOverrides({...config, workspaceCount}));
},
~~~
- [x] **Implement commit in the specified order.**

~~~text
accept/queue the engine mutation
normalize against ready live ids (minimized ids remain known but detached)
layout each workspace/root into window and container rectangle maps
exclude fullscreen/minimized windows from the enforcement map
record expected rectangles/generations and obtain the diff/corrections
merge explicit one-shot floating geometry; apply through GeometryPort
apply changed tabbed/stacked raise order, preserving native floating focus
publish pills + immutable snapshots; increment revision; notify subscribers
drain queued lifecycle work after the current traversal finishes
~~~

Keep the container rect map for resize commands. Raise tiled subtrees only when their required tab/stack ordering changes (or a relevant activation requires it); do not raise every tiled window on a floating focus event. Re-resolve each id at native effect time. Capture a frame event's current reconciliation generation when the event arrives, before deferring its fresh frame read, so an older queued observation cannot spend a newer generation's allowance. Retain pending monitor invalidation while topology is unavailable and apply it when a complete topology returns. Do not mutate a disposed Engine or send geometry from `stop()`.

`relayout()` observes fresh native frames and recomputes layout through this pipeline; unchanged targets retain their existing retry allowance. Pill occupancy includes managed minimized windows even though they are detached from the tree. Test that minimizing a workspace's only window does not make its pill appear empty. Catch/log each subscriber failure independently so one failed listener cannot interrupt remaining notifications or leave the engine's committing flag set.

- [x] **Implement lifecycle membership and acknowledgements.** Keep maps for manual floating membership, minimized membership, expected workspace and engine-requested focus, plus a set of pending engine unmaximizations. Removal clears every map and pending frame read for that id. Minimize detaches and remembers membership; unminimize inserts as new, retaining floating status if applicable. Fullscreen keeps its tree slot. Catch maximization only for tiled windows outside fullscreen/minimized states; call native `unmaximize()` once, and force only after both axes are false. A false/gone native operation clears its pending marker.

Before activating a selected leaf's descendant, record expected focus. A matching activation acknowledgement preserves a selected ancestor; a different genuine native focus selects that leaf/floating id. Deduplicate equal focus notifications even after the acknowledgement is consumed. Null/untracked native focus does not silently replace the engine selection. On unmanaged, source selection falls to the Tree facade's repaired selection and activates its surviving focused descendant.

Before workspace moves, record expected destinations for every selected id. A matching event only clears its acknowledgement. A mismatching event invalidates the old acknowledgement and performs the ordinary external detach/insert using current native truth. Read current workspace at event handling time; do not replay captured stale values. Do not add a forced geometry generation for workspace changes.

- [x] **Test all four invalidations and native-event races.**

~~~ts
it.each(['fullscreen', 'minimized', 'maximized'] as const)(
  'reapplies an unchanged tile after %s exit', event => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.flush();
    const flag = event === 'fullscreen' ? {fullscreen: true} :
      event === 'minimized' ? {minimized: true} : {maximizedH: true, maximizedV: true};
    f.change(1, flag, event);
    f.flush();
    f.applied.length = 0;
    f.change(1, {fullscreen: false, minimized: false, maximizedH: false, maximizedV: false}, event);
    f.flush();
    expect(f.applied.some(batch => batch.has(1))).toBe(true);
  });
~~~

For maximization, configure the fake `unmaximize` to keep both flags true until the test sends the completion notifications; assert one unmaximize call, one fresh generation, and no force after only one axis clears. A separate monitor-change test uses identical work areas and asserts fresh application. Assert workspace move acknowledgement with identical target rect emits no geometry; external move reconciles membership exactly once. Include mismatches while fullscreen/minimized, stale queued generation observations, first-frame/unmanaged duplicates, a stubborn client, and no usable monitors followed by a valid topology.

- [x] **Implement reload/restart/count changes with their regression tests.** Validate the new config before mutation. Resolve effective N from the config or current count (1–36); apply overrides without `restoreAll()` between valid configurations. Reconfigure the existing Tree, recording the returned expected workspace destinations before native count changes. On shrink, issue those per-id workspace moves to the last retained workspace before reducing the native count, so Mutter's own removal fallback cannot choose a different destination and flatten the transferred structure. Test this call order and matching acknowledgements. Preserve surviving nodes/percentages on reload. If work areas for newly created native workspaces have not arrived, publish `ready: false` and defer their geometry until count/work-area notification supplies them. Enforce the desired static count after external changes.

Restart first requires a successful reload, then rebuilds from live windows using fresh initial classification and the same adapter ids. A rejected reload/restart preserves tree/config/grabs and selection; Task 6 adds nested-layout/pending-split regression fixtures once commands can construct those states. Add getter `lastLoadTime: number`, set from `ports.now()` when accepting the LoadedConfig, for the timestamp paired with existing `lastLoad`. Fix the stale “retrying once” message. Test count zero, grow/shrink, rejected restart, cache-source notification and native activation returning false.

- [x] **Verify GREEN:** engine/snapshot suites, `npm test`, `npm run typecheck`, `npm run check:layer0`, `npm run lint:tree`. Existing Phase 1 focused-window fake assertions become id-based assertions; delete only the obsolete “tiling not implemented” expectations.
- [x] **Commit:** `feat(engine): integrate tree lifecycle and geometry commits`.

## Task 6: Dispatch all Phase 2 commands from the engine selection

**Files:** Modify `src/engine.ts`; create `test/unit/engine/commands.test.ts`; extend `test/unit/engine/fakeEngine.ts` only for required native-operation observations.

**Interfaces:**
- Consumes `Engine.run(commands: Command[], timestamp: number): string`, all Tree command facades, `WindowsPort` and the retained container rect map.
- Produces complete Phase 2 command dispatch. Floating geometry is accumulated in `Map<WindowId, Rect>` consumed once by commit; native notifications do not enforce it afterward.

- [x] **Write the selected-parent regression.**

~~~ts
const f = fakeEngine();
f.engine.start();
f.add(1);
f.add(2);
f.flush();
f.focus(2);
f.engine.run([{type: 'focus', target: 'parent'}], 1);
const selected = f.engine.treeSnapshot().workspaces[0].selected;
f.focus(2); // duplicate native leaf focus must not discard the parent
expect(f.engine.treeSnapshot().workspaces[0].selected).toEqual(selected);
f.calls.length = 0;
f.engine.run([{type: 'kill'}], 2);
expect(f.calls.filter(c => c.startsWith('kill:'))).toEqual(['kill:1', 'kill:2']);
~~~

Add a real focus change to a different tracked window (after another focus state) to prove selection follows native reality, and an engine activation acknowledgement to prove it preserves a chosen split. For a parent workspace move, assert all selected ids move once, subtree structure survives, source workspace stays active, source fallback receives focus, and matching acknowledgements do not reinsert leaves.

- [x] **Run RED:** `npx vitest run test/unit/engine/commands.test.ts`. Unimplemented tree-command paths and floating geometry fail.
- [x] **Implement the command-to-facade mapping.**

| Command | Engine action inside commit |
|---|---|
| `focus left/right/up/down` | `tree.focus(direction, config.focusWrapping)`; activate returned leaf |
| `focus parent/child` | corresponding facade; preserve selected con; activate only its focused descendant if needed |
| `focus mode_toggle` | `tree.focusModeToggle()` and activate returned id |
| `split h/v/toggle` | `tree.split(orientation)` |
| `layout` / `layout toggle` | `tree.setLayout` / `tree.toggleLayout` |
| `move direction` | `tree.move(direction)`; retain selected container and focus its descendant |
| tiled `resize` | `tree.resize(command, containerRects)`; commit only if it changes |
| `floating enable/disable/toggle` | resolve leaf/floating id, compute desired state, `tree.setFloating(id, enabled, monitor)`; preserve actual frame on enable |
| `kill` | enumerate all leaves under selection, or the floating id; call `kill(id, timestamp)`; wait for unmanaged before removing |
| `fullscreen` | leaf/floating id → native operation; split selection → warning/no-op |
| `move_to_workspace` | validate target first; `tree.moveToWorkspace(index, monitor)`; set expected workspace then native move for each returned id |
| floating `resize`/`resize_set`/`move_position` | queue one explicit frame operation; no persistent floating reconciliation |

For tiled-only directional/layout/split commands with floating selection, use existing facade no-op semantics. `floating` on a split is a warning/no-op because v1 floating membership represents individual windows. `border` stays explicitly Phase 3; `back_and_forth`/rules stay explicitly Phase 4. Preserve exec, mode, nop and unknown-command behavior.

- [x] **Test floating arithmetic independently of tiled percentages.**

~~~ts
const f = fakeEngine();
f.engine.start();
f.add(1, {kind: 'floating', rect: {x: 11, y: 43, width: 300, height: 200}});
f.flush();
f.engine.run([{type: 'resize', action: 'grow', dimension: 'width', px: 10, ppt: 50}], 1);
expect(f.applied.at(-1)?.get(1)).toEqual({x: 11, y: 43, width: 310, height: 200});
f.engine.run([{type: 'move_position', position: 'center'}], 2);
expect(f.applied.at(-1)?.get(1)).toEqual({x: 345, y: 280, width: 310, height: 200});
~~~

Explicit x/y are absolute logical coordinates; center uses the selected window's workspace/monitor work area and integer rounding. Floating resize uses px even if ppt is present, rejects nonpositive/nonfinite results before mutation, and keeps position. Tiled `resize set` and `move position` warn without mutation. Subsequent floating size notifications cause no corrective writes.

- [x] **Prove reload retention on nested layouts and pending splits (execution ruling).** Use split/add/resize commands to create a vertical subtree with non-default percentages, then a pending horizontal split around its selected leaf. Save the workspace snapshot and reload an accepted config; every node id, layout, percentage and selection must survive. A rejected restart preserves the same snapshot; an accepted restart rebuilds from live windows. This completes the complex reload proof introduced in Task 5 without exposing a mutable Tree test hook.

- [x] **Cover commands through bindings and chains.** Use the real fixture's split/focus/move/resize bindings, 10-ppt resize behavior, parent move and root-content transfer, tabbed/stacked raise order, empty workspace no-op, fixed-size floating, wrong/gone ids, already-enabled floating/fullscreen, numeric string and named workspace targets, failed workspace activation and zero workspace wrap. Compound commands observe prior command mutations in order.
- [x] **Verify GREEN:** command/lifecycle suites plus `npm test`, typecheck and Layer 0 check.
- [x] **Commit:** `feat(engine): dispatch tiling commands against selected containers`.

## Task 7: Expose tree state and make session teardown total

**Files:** Modify `src/engine.ts`, `src/shell/control.ts`, `src/shell/session.ts`, `src/extension.ts`; create `src/shell/controlObject.ts`, `src/shell/sessionState.ts`, `test/unit/shell/controlObject.test.ts`, `test/unit/shell/sessionState.test.ts`; extend `test/unit/engine/lifecycle.test.ts`.

**Interfaces:**
- `controlObject.ts` exports `ControlObject(engine: Engine, timestamp: () => number, shellState: () => {actionMode: number; ready: boolean}, log: {error(message: string, error: unknown): void})` with testable D-Bus method bodies; the GI export and virtual keyboard stay in `control.ts`. The shellState reader computes NORMAL/OVERVIEW from the native action mode using the existing sanctioned cast.
- Control adds `GetTree(): string`, `GetWindows(): string` and signal `TreeChanged()`. Existing methods and reply types remain compatible.
- Add `pills: PillState[]` to `EngineState`. Retain the committed pill values in Engine, use them for the indicator update, and return a detached copy from `state()` so ControlObject forwards the same state without duplicating occupancy/name logic.
- `DebugObject` takes Engine in addition to SessionWatcher and adds `Relayout(): void` calling `engine.relayout()`. Retain `PressKey` and `SimulateSessionMode` exclusively in test builds.
- `sessionState.ts` exports `SessionState(initial: boolean, onLocked: () => void, onUnlocked: () => void)`, getter `isLocked` and `update(locked: boolean): void`; the native watcher supplies `isLocked || !hasWindows`.

- [x] **Write initial-lock and teardown regressions.**

~~~ts
const f = fakeEngine();
f.engine.start(true);
expect(f.engine.state().grabbed).toBe(0);
f.add(1);
f.flush();
const before = f.engine.treeSnapshot();
f.engine.onUnlocked();
expect(f.engine.state().grabbed).toBe(65);
expect(f.engine.treeSnapshot().workspaces).toEqual(before.workspaces);
f.change(1, {rect: {x: 5, y: 5, width: 20, height: 20}}, 'frame');
f.applied.length = 0;
f.engine.stop();
f.engine.stop();
f.flush();
expect(f.applied).toEqual([]);
expect(f.calls.filter(c => c === 'settings.restore')).toHaveLength(1);
~~~

Also enter resize before lock; verify default mode, zero grabs, hidden indicator, same tree after unlock and regrabged default bindings. Locked reload/start must never install bare-key grabs. Do not invent a fifth forced-generation event for unlock: read actual frames and reconcile under the existing generation, retaining the tree.

- [x] **Run RED:** focused lifecycle/session/control suites.
- [x] **Wire seeded session state and cleanup order.** Construct SessionWatcher before `engine.start(session.isLocked)`. Hide/show the indicator from the seeded state and each transition. On disable, stop publishing D-Bus, mark Engine stopped and cancel deferred work before restoring settings, then destroy windows/key/indicator adapters and disconnect all remaining signals. Retain partial-enable rollback. Per-window callbacks and all D-Bus method bodies, including debug methods, catch/log and return valid failure replies rather than throwing into Shell.
- [x] **Implement JSON methods and signal subscription.**

~~~xml
<method name="GetTree"><arg type="s" direction="out" name="json"/></method>
<method name="GetWindows"><arg type="s" direction="out" name="json"/></method>
<signal name="TreeChanged"/>
~~~

Subscribe when exporting; emit with `new GLib.Variant('()', [])` after each completed commit; unsubscribe before unexporting. `GetState` adds `pills` from the same state sent to the indicator. `ready` requires both usable engine topology and Shell NORMAL/OVERVIEW action mode. `GetConfigStatus` includes `loadTime` (the accepted config's Unix millisecond timestamp) alongside its existing source/path/diagnostics. JSON error replies retain the existing `{error: ...}` convention. Test snapshots are immutable copies, contain no parent cycles, include leaf titles/wm-classes, expose actual frames separately from expected frames, and signal exactly after committed state becomes readable.

- [x] **Handle D-Bus name loss without a callback leak.** Supply a guarded `name_lost` callback to `bus_own_name`. On failed acquisition/loss, log and notify once, unsubscribe/unexport the control/debug objects, release ownership, and leave core keyboard/tiling behavior running. Teardown after name loss remains idempotent; acquiring a name owned by another process must not stop that process or replace its owner. Test this with an injected ownership/export facade or in the private-bus scenario in Task 10.
- [x] **Verify GREEN:** focused suites, full tests/typecheck, release build. Assert the release bundle contains none of `name="org.i3shell.Debug"`, `SimulateSessionMode` or the debug-only `Relayout` method implementation; test build exports all three debug methods. Preserve dead-code elimination at both construction and export sites.
- [x] **Commit:** `feat(control): expose tree state and harden session lifecycle`.

## Task 8: Finish bounded input/config carry-forward fixes

**Files:** Modify `src/shell/keys.ts`, `src/shell/indicator.ts`, `src/config/variables.ts`, `src/config/resolve.ts`, `test/unit/config/lexer.test.ts`, `test/unit/config/resolve.test.ts`; create `src/util/smoothScroll.ts`, `test/unit/util/smoothScroll.test.ts`.

**Interfaces:**
- `SmoothScroll.push(deltaY: number): Array<'next' | 'prev'>` accumulates vertical movement in units of 1, preserving the signed fractional remainder; `reset(): void` clears it. Nonfinite deltas produce no actions.
- Variable parsing retains whole-file, longest-first substitution and original line numbers. Extend supported variable names with dots/hyphens while preserving the current requirement that the first name character is a letter/underscore.
- Keep `KeyBinder.setBindings` semantics: only current mode bindings are grabbed (65 default, 11 resize for the reference config).

- [x] **Write input/config regressions.**

~~~ts
const scroll = new SmoothScroll();
expect(scroll.push(0.4)).toEqual([]);
expect(scroll.push(0.7)).toEqual(['next']);
expect(scroll.push(-1.2)).toEqual(['prev']);
scroll.reset();
expect(scroll.push(Number.NaN)).toEqual([]);

expect(substituteVariables(logicalLines('set $ws-1 1:I\nbindsym Mod4+1 workspace $ws-1'))
  .lines[0].text).toBe('bindsym Mod4+1 workspace 1:I');
expect(substituteVariables(logicalLines('set $my.var x\nbindsym Mod4+x exec $my.var'))
  .lines[0].text).toBe('bindsym Mod4+x exec x');
expect(substituteVariables(logicalLines('set $mod')).diagnostics)
  .toEqual([{line: 1, severity: 'error', message: 'set: missing value'}]);
expect(logicalLines('bindsym Mod4+x exec true\\'))
  .toEqual([{line: 1, text: 'bindsym Mod4+x exec true'}]);
~~~

Add ordinary final line with no newline, whitespace-only missing value, existing invalid `$1bad` rejection, long-before-short substitution, horizontal-only scrolling and multiple whole scroll units. Existing lexer behavior can already pass its new EOF regressions; the name/missing-value tests provide the failing behavior.
- [x] **Run RED:** `npx vitest run test/unit/config/lexer.test.ts test/unit/config/resolve.test.ts test/unit/util/smoothScroll.test.ts`.
- [x] **Implement the bounded changes.** Recognize `set` lines before requiring a value and return the explicit diagnostic instead of forwarding them as unknown directives. Use `/^\$[A-Za-z_][A-Za-z0-9_.-]*$/` for the supported name grammar. Add a compile-time exhaustive directive switch default without a runtime throw path for parsed input:

~~~ts
default: {
  const unexpected: never = d;
  diagnostics.push({
    line: 0, severity: 'error',
    message: 'unsupported internal directive: ' + JSON.stringify(unexpected),
  });
}
~~~

No changes to the Phase 4 criteria parser. For `SMOOTH` scroll events read `get_scroll_delta()`, pass its y delta through the accumulator, and use the existing scroll callback. Reset on discrete scroll or indicator hide/destroy. Keep UP/DOWN behavior and existing visual styles.

- [x] **Revoke external key permissions and document the limit.** Before ungrabbing an action, call `Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE)`. Do not use `removeKeybinding` for an external accelerator or retain default-mode grabs through resize mode. GNOME 50 has no public API to delete those permission-map keys; residual entries have value NONE and are inert until shell restart. Record this in carry-forward instead of reaching into `Main.wm` private fields. Integration checks modes/grab counts and disable/re-enable in Tasks 9–10; no mock-only “deleted private map” assertion.
- [x] **Verify GREEN:** focused tests, full tests and typecheck. Keep optional CSS-class and minifySyntax cleanup out of this phase; record them as cosmetic only.
- [x] **Commit:** `fix(input): complete config and scroll compatibility follow-ups`.

## Task 9: Run real GTK fixtures only inside the nested session

**Files:** Modify `test/integration/nested.sh`, `test/integration/inside.sh`, `test/integration/phase1-checks.sh`; create `test/integration/windows.js` and `test/integration/client.py`. Native smoke exposed teardown failures, so this task also modifies `src/shell/windows.ts`, `src/shell/windowTracker.ts` and `test/unit/shell/windowTracker.test.ts`, and creates `src/shell/nativeWindowLifecycle.ts` with `test/unit/shell/nativeWindowLifecycle.test.ts`.

**Interfaces:**
- `windows.js` is a GJS GTK4 process with its own private-bus service `org.i3shell.TestWindows`, object path `/org/i3shell/TestWindows` and matching interface. It is never bundled in the extension.
- Fixture methods: `Create(name: s, kind: s, parent: s) → b`, `Close(name: s) → b`, `Action(name: s, action: s) → b`, `SetMinimum(name: s, width: i, height: i) → b`, `Text(name: s) → s`, `Size(name: s) → (i, i)` and `Reset()`. Size returns the GTK widget's allocated width/height (client size, not a Mutter frame). Accepted kinds are `normal`, `dialog`, `modal` and `fixed`; accepted actions are `present`, `maximize`, `unmaximize`, `minimize`, `unminimize`, `fullscreen` and `unfullscreen`.
- `client.py` exports `call(interface, method, signature='()', args=())`, `state()`, `tree()`, `windows()`, `command(text)`, `fixture(method, signature='()', args=())` and `wait_until(predicate, description, timeout=10)`. It uses Python Gio/GLib (already installed) to unpack D-Bus replies directly; never parse object dumps with shell string matching.
- Nested CLI adds repeatable `--monitor WxH`; default remains one 1920×1080 monitor. `inside.sh` starts the empty fixture service before invoking checks and stops it during teardown.

- [x] **Write the isolation/fixture smoke assertion first.**

~~~python
from pathlib import Path
import os
from client import fixture, windows, wait_until

runtime = Path(os.environ["XDG_RUNTIME_DIR"])
sandbox = Path(os.environ["I3SHELL_SANDBOX"])
assert runtime == sandbox / "runtime"
assert (runtime / os.environ["WAYLAND_DISPLAY"]).is_socket()
assert os.environ["GDK_BACKEND"] == "wayland"
assert fixture("Create", "(sss)", ("Fixture A", "normal", ""))[0]
wait_until(lambda: any(w["title"] == "Fixture A" for w in windows()), "first-frame adoption")
assert fixture("Close", "(s)", ("Fixture A",))[0]
wait_until(lambda: not windows(), "unmanaged removal")
~~~

Put this smoke sequence in the `client.py` CLI command `smoke` so Task 9 has its own runnable acceptance. It initially fails because the fixture/service/private runtime are absent.

Before creating a fixture, wait for Shell readiness, leave the initial overview with Escape, and poll for NORMAL action mode. Native evidence showed the synthetic GTK fixture's first frame is delayed while the initial overview is open. Do not fake first-frame readiness. Closing a pending or adopted fixture must also leave no disposed-actor, null-workspace or unmanaging-window criticals: reproduce those lifecycle orderings in focused unit tests before the native bridge fix. Retiring windows must not receive native reads or operations, removal must occur once at a safe teardown boundary, and MRU adoption plus frame-generation semantics must remain intact. After process cleanup, fail the harness on Shell/GJS/GLib-GObject/Mutter criticals or fixture method failures rather than allowing a successful scenario command to hide them.

- [x] **Prepare a private runtime/socket.** Add `sandbox/runtime` with mode 0700 alongside private config/data/cache and private D-Bus. Set nested `XDG_RUNTIME_DIR` to it. Launch Shell with `--wayland-display=i3-shell-test` and the configured virtual monitors. Only after launching the compositor, set client `WAYLAND_DISPLAY=i3-shell-test`, `GDK_BACKEND=wayland` and unset `DISPLAY`. Headless Shell must not inherit a live display connection. For `--visible`, save the parent Wayland socket as an absolute path before replacing runtime variables and pass it only to the nested compositor process; all fixtures still use the private nested socket. Wait for that socket and the fixture bus name, with bounded timeouts and log dumps on failure.

Run the private compositor with --no-x11: the required GTK fixtures are native Wayland, and the host’s nested Xwayland startup stalls the Shell main loop even with the pre-integration build. Xwayland client behavior is not claimed by these automated checks.

In the disposable data directory, seed `data/gnome-shell/update-check-50` before launching Shell. The installed GNOME 50 loader otherwise awaits its first-major-version network update check before importing extensions; this private harness does not test the GNOME extension updater.

- [x] **Implement the GTK process and D-Bus client.** Use `Gtk.Application` with an explicit hold so it survives an empty window set. Store windows by fixture name; reject duplicate names, absent parents and invalid kinds/actions with false replies. Each window contains a `Gtk.Entry` so the tests can prove resize-mode keys are not typed into applications.

~~~js
const window = new Gtk.ApplicationWindow({
    application: app,
    title: name,
    default_width: 360,
    default_height: 240,
    resizable: kind !== 'fixed',
});
const entry = new Gtk.Entry();
window.set_child(entry);
if (parent !== '')
    window.set_transient_for(windows.get(parent).window);
if (kind === 'modal')
    window.set_modal(true);
windows.set(name, {window, entry});
window.connect('close-request', () => {
    windows.delete(name);
    return false;
});
window.present();
~~~

GTK4 Wayland does not provide all legacy X11 window-type hints. Dialog/modal behavior is tested with real transients; utility/splash/type precedence stays covered by the native-facts classification unit matrix and the live checklist, not by pretending a normal GTK window is a splash.

~~~python
def wait_until(predicate, description, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("timed out waiting for " + description)
~~~

Catch fixture method errors, print stack traces to its private log and return the declared failure type. Kill/wait both fixture and Shell on exit; retain `--keep` for logs. Do not leave a GTK process connected after the private bus shuts down.

- [x] **Replace obsolete Phase 1 dispatch proofs.** Keep empty-window A1 before any fixtures open. For A4 create two normal windows and wait for actual frames to match their independent half-workspace expectations. Focus the second, press `<Super>r`, verify 11 grabs, then press bare `j`. Assert the selected tile shrinks by 10 percentage points and the neighbor grows correspondingly, and both fixture Entry texts remain empty. Escape/Return/mod+r still leave resize mode with 65 grabs. Close the fixtures after the checks.

Correct the retry comment to `500 ms, 1.5 s, 4 s`. Keep real exec, valid/invalid reload, lock/unlock, missing-file rejection and config-source assertions. Add A2 pills/name/active/occupied assertions from `GetState`.

- [x] **Verify GREEN:** `npm run build:test`, then run the smoke and Phase 1 checks through `nested.sh`. A command failure must print the preserved shell/fixture logs; do not silently skip a scenario.
- [x] **Restore release install even if checks fail:** `make install`; verify `dist/extension.js` has no debug interface. Record the actual outcomes; no live logout/login is performed.
- [x] **Commit:** `test(integration): isolate GTK fixtures and retain phase one acceptance`.

## Task 10: Exercise A8–A14 and record delivery evidence

**Pause checkpoint:** No Task 10 code or native checks have run. The user-requested pause documentation updates README/PROJECT and carry-forward status, but final evidence, the Phase 2 checklist, remaining scenarios and reviews below are still required.

**Files:** Create `test/integration/phase2-checks.py`, `test/integration/run.sh` and `docs/acceptance/phase-2.md`; modify `test/integration/nested.sh`, `test/integration/inside.sh`, `package.json`, `README.md`, `PROJECT.md` and the carry-forward/plan execution records.

**Interfaces:**
- Uses Task 9's D-Bus helpers, fixture service and repeatable virtual monitors.
- `npm run test:integration` invokes `bash test/integration/run.sh`, which builds the test bundle, runs Phase 1 plus Phase 2 single-monitor scenarios, then a fresh two-monitor Phase 2 monitor scenario. Restore the release build on exit; the controller still performs the required final `make install`.
- No added production-only test state and no simulated topology substitute for the real monitor event.

- [ ] **Write exact-rectangle assertions before scenarios.**

~~~python
def horizontal_halves(area):
    left_width = round(area["width"] / 2)
    # The fixture uses even widths; odd-pixel rounding remains covered by pure-tree tests.
    return (
        dict(x=area["x"], y=area["y"], width=left_width, height=area["height"]),
        dict(x=area["x"] + left_width, y=area["y"],
             width=area["width"] - left_width, height=area["height"]),
    )

def assert_frame(window, expected):
    assert window["rect"] == expected, (window["title"], window["rect"], expected)
    assert window["expectedRect"] == expected
~~~

Locate windows by unique fixture title, then use their opaque ids. Read the work area from the selected root but calculate expected splits independently; merely comparing native frames with engine targets can let the same layout bug pass twice. Poll for settled frames with a timeout, reporting `GetTree`, `GetWindows` and logs on failure.

- [ ] **Run the new scenario driver before implementing it.** With the test build installed in the nested sandbox, the missing scenario/rectangle assertions fail. Add the scenarios one at a time and verify each on the current implementation; reproduce production failures in a focused unit test before changing production code.

| Criterion | Automated sequence and independent assertion |
|---|---|
| A8 | Open A/B on an empty workspace; two horizontal halves. Close B; A covers the complete work area. Open/close C quickly to exercise first-frame/unmanaged timing. |
| A9 | Focus B, split vertical, open C; A remains the left half and B/C split the right half vertically. Horizontal split orientation is tested separately. |
| A10 | Traverse the known A/B/C tree with actual bound keys and assert selected ids; verify edge wrapping. Move C left and then back into a nested split; check order/rectangles and native focus. |
| A11 | Select a parent with mod+a; move the whole subtree and toggle its layout. Assert both descendant ids remain together and the native keyboard-focused leaf does not replace parent selection. |
| A12 | Enter resize, grow/shrink width and height by 10 ppt using the real bindings; check both neighboring rectangles and unchanged application Entry text. |
| A13 | Real transient dialog, modal and non-resizable normal fixture windows are floating. Toggle a tiled leaf to floating, change its frame, toggle focus between groups, and return it to tiling. Test floating resize-set/center and tiled resize-set no-op. |
| A14 | Simulated lock/unlock preserves the tree and frames; real disable/enable adopts live windows and retiles; separate two-monitor scenario migrates a vanished monitor's contents and forces unchanged targets. |

Tabbed and stacked scenarios additionally assert equal child rectangles and focused-subtree raise behavior using focus/visible entry interaction, not just the presence of a layout label. Kill/transfer a parent affects all its descendants; destination workspace does not become active. Valid reload preserves nested layout/percentages, invalid reload preserves all state, and restart re-adopts live ids.

- [ ] **Exercise native geometry state changes.** For a tiled leaf, request fullscreen then exit; minimize then unminimize; maximize then wait for the engine's unmaximize. Verify native frames return to the unchanged tree rectangle for each. Enlarge a resizable fixture's minimum width beyond its tile to test a refusing client; bounded retry is asserted by the unit ledger, and integration must stay responsive with a stubborn window reported. Change its expected rect to permit a new attempt, then remove it. Do not use fixed sleeps as evidence of correctness.

- [ ] **Exercise actual monitor reconfiguration on the private bus.** Start two virtual outputs using `--monitor 1920x1080 --monitor 1280x720`. In private test settings set `workspaces-only-on-primary=false` solely for this scenario. Move a fixture to the second output using floating enable → explicit position inside that output → floating disable, waiting for its native monitor id between operations. Record its node/id and tree structure.

Use `org.gnome.Mutter.DisplayConfig.GetCurrentState` and reconstruct logical monitor configuration from the returned connector specs/current mode ids. Invoke `ApplyMonitorsConfig` with temporary method 1, retaining only the primary logical monitor, then restore both with a freshly fetched serial:

~~~python
# logical_configs entries:
# (x, y, scale, transform, primary, [(connector, current_mode_id, {})])
parameters = GLib.Variant(
    '(uua(iiduba(ssa{sv}))a{sv})',
    (serial, 1, logical_configs, {}),
)
connection.call_sync(
    'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
    'org.gnome.Mutter.DisplayConfig', 'ApplyMonitorsConfig',
    parameters, None, Gio.DBusCallFlags.NONE, 5000, None,
)
~~~

After removal, assert every tracked id survives under the primary root and frame/target equality returns. Surviving connector identities must not change just because native indices changed. Reconnection must produce valid empty/new roots and stable live membership; richer output history/lid behavior remains Phase 4. If the installed headless backend rejects temporary output removal, record that specific integration limitation and leave physical monitor acceptance unchecked; do not substitute a debug-only fake monitor event and claim hotplug passed.

- [ ] **Cover settings restoration and repeated enable.** On the private keyfile backend capture colliding binding values before enable, wait for their clearing, disable and compare originals, then re-enable and check re-clearing plus adopted windows. Use a separate startup configuration with the extension initially disabled so the “before” values are real originals. Keep actual frames on disable, clear debug/control exports, and return to 65 grabs on re-enable. Test D-Bus name conflict on the private bus and confirm the extension logs/notifies once while keys/tiling continue.

- [ ] **Implement the run wrapper with failure-safe release restoration.**

~~~bash
#!/usr/bin/env bash
set -euo pipefail
restore_release() {
  local result=$?
  trap - EXIT
  if ! npm run build; then
    printf '%s\n' 'release rebuild failed after integration' >&2
    result=1
  fi
  exit "$result"
}
trap restore_release EXIT
npm run build:test
bash test/integration/nested.sh -- bash test/integration/phase1-checks.sh
bash test/integration/nested.sh -- python3 test/integration/phase2-checks.py
bash test/integration/nested.sh --monitor 1920x1080 --monitor 1280x720 -- \
  python3 test/integration/phase2-checks.py --monitors
bash test/integration/nested.sh --disabled -- python3 test/integration/phase2-checks.py --settings
bash test/integration/nested.sh --disabled -- python3 test/integration/phase2-checks.py --name-conflict
~~~

Include the private initially-disabled restoration scenario in `phase2-checks.py --settings`. Add `--disabled` to nested.sh to seed `enabled-extensions=[]` rather than loading then disabling. In that mode inside.sh waits for Shell and the fixture service only; it must skip the extension-enable log and Control-name waits or it would deadlock before the scenario could enable the extension.

For `--name-conflict`, synchronously request `org.i3shell.Control` through `org.freedesktop.DBus.RequestName` on the Python client's private connection before enabling. Assert ownership stays with that connection, the Shell log reports one name-loss warning and the usual successful grab count, and a newly created small normal fixture expands to the workspace via its GTK Size reply. Disable, release the dummy name, re-enable and verify Control/GetTree and frame assertions work again. Do not use GTK client size as a replacement for the normal exact Mutter-frame assertions. Both initially-disabled scenarios start with empty fixture windows and restore their own temporary state.

- [ ] **Write the live checklist while preserving honest provenance.** `docs/acceptance/phase-2.md` begins with exact commit/build/date fields and unchecked A8–A14 boxes. Give concrete keys/window arrangements, expected geometry/focus, floating/dialog behavior, lock/re-enable and laptop monitor checks. Separate automated evidence, physical display checks and the user's future report. The user logs out/in to load the release, enables `i3-shell@troja`, then performs the checklist. No automatic step ticks live acceptance.

Update README with GetTree/GetWindows usage, Phase 2 behavior, the private integration command, and recovery when the extension was removed without disable: reinstall the same UUID/schema, enable so the persisted originals can be loaded, then disable to restore them; never advise clearing `overridden-settings` before restoration. Update PROJECT architecture/current counts/next phase, and the carry-forward dispositions. Record the host-dependent monitor limitation if encountered.

- [ ] **Run final delivery checks once fixes and task reviews are complete:**

~~~bash
npm test
npm run typecheck
npm run check:layer0
npm run lint:tree
npm run test:integration
make install
git diff --check
~~~

Inspect the release bundle for absence of debug XML/methods and verify the installation symlink points to this checkout's `dist`. Any integration failure still requires release `make install`. Do not rerun unchanged checks repeatedly after they have passed unless a later change requires it.

- [ ] **Commit:** `test: verify live tree integration and document phase two acceptance`. Record actual test counts, commands, limitations and install result, rather than predicted results.
- [ ] **Request whole-branch review using the preserved subagent workflow.** Resolve findings with focused verification and record the final outcome. Keep the phase branch until the user requests integration; the earlier Phase 2A merge/push instruction does not authorize future Phase 2B merges or pushes.

## Coverage and carry-forward audit

| Binding requirement | Owning task / proof |
|---|---|
| §5 single commit path; only ids across adapters | 3–5; native writer isolation, death during apply, snapshot tests |
| §§6.1, 6.6 config recovery/reload/restart | Existing cache tests retained; 1 and 5 preserve tree on reload, rebuild only on accepted restart |
| §§7.1–7.11 tree algorithms | Completed Phase 2A retained; 2 adds topology; 6 exercises selection-based dispatch |
| §8.1 identity / §8.2 classification | 3's lifetime and facts matrix; 9–10's real GTK types |
| §8.3 event table | 5 lifecycle matrix; attention stays Phase 4 |
| §8.4 reconciliation / four invalidations | 4 state-machine tests, 5 event tests, 10 real native-state transitions |
| §8.4 focus drift / total disable / lock | 5–7 and 10; parent-selection acknowledgement, initial lock, repeated teardown |
| §8.5 adoption | 3 existing-window enumeration; 5 MRU/ready handling; 10 restart/re-enable |
| §9 workspaces/count/names/no-follow | 1 settings reconciliation; 2 topology; 5–6 command/lifecycle tests; 9–10 |
| §10 keys/modes / §11 indicator | Phase 1 retained, 7 seeded lock/pills, 8 smooth scroll/permission revocation, 9 |
| §12 decoration actors | Explicit Phase 3 boundary; no actor implementation in this plan |
| §13 overrides/recovery | 1 default reset/sync and failed-restore preservation; 10 private A6 and README recovery |
| §14 D-Bus / §15 callback guards | 7 JSON/signal/name loss/release exclusion; 9–10 private-bus assertions |
| §16 tests / A8–A14 | Existing property suite retained/extended; 10 scenario matrix and separate live checklist |

Phase 1 deferred items are accounted for: default reset/sync and reload reconciliation (1), numeric-name/activation/cache tests and retry wording (5–6), seeded lock/name loss (7), parser exhaustiveness/EOF/names/missing-value, smooth scroll and inert key-permission documentation (8), A2/A6 and retry comment (9–10), README recovery (10). CSS-class conversion and `minifySyntax` are optional cosmetic changes and stay out. Criteria quoted-`]` handling and custom-shortcut enumeration remain Phase 4.

## Preparation self-review (2026-09-22)

- [x] Compare every Phase 2 requirement with the coverage table; repair omissions in the owning task.
- [x] Verify all referenced existing method signatures against source and all new signatures against their producing task.
- [x] Check the five Review Focus cases each have a concrete regression in the owning task.
- [x] Scan for placeholders and obsolete Phase 1 geometry assumptions.
- [x] Verify document links, fence balance and `git diff --check`.
- [x] Present the completed plan for the required written-plan review; preserve the previously chosen subagent execution method. The user approved it before implementation.

Self-review corrected the void-returning Tree.check assertions, stable-monitor lookup test seam, nullable monitor transitions, snapshot titles/wm-classes/config load time, callback-generation capture, effective count-zero settings, minimized pill occupancy, and initially-disabled harness startup. Fresh preparation verification: 234/234 tests in 22 files passed on the unchanged implementation; all ten task sections and local document links were checked. No integration suite or installation ran during planning.

## Execution record

Implementation started on `phase-2b` after the user approved this written plan. Base: `b6fe8cc`. The plan-scoped ledger is `.superpowers/sdd/2026-09-22-phase-2b-integration/progress.md`. Tasks 1–9 are complete and independently reviewed. Work was paused before Task 10 on 2026-09-22 and resumed the same day at the user's request; Task 10 is implemented against baseline `2fe055f`. A8–A14 live acceptance and the whole-branch review remain.

Ruling: suppress `ibus-daemon` in the nested harness with a PATH stub, and disclose it. — IBus registers its own accelerators (`<Super>semicolon`, `<Super>space`) through the shell's `GrabAccelerators`, the same external-grab mechanism the extension uses; with IBus running a varying subset of the extension's grabs never dispatches, which made the suite non-deterministic. Removing the claimant made all twelve probed accelerators dispatch 3/3 with the IBus *setting* left untouched, so the claimant's existence is the variable. — Cost if wrong: automated coverage excludes this conflict, exactly as `--no-x11` excludes Xwayland clients; the Phase 2 live checklist covers those two keys by hand and the carry-forward records the product decision as the user's to make.

Ruling: drive unminimize from the compositor side with an activation request. — xdg-shell has `xdg_toplevel.set_minimized` with no inverse, so a Wayland client cannot restore itself and GTK's `unminimize()` silently does nothing; Mutter unminimizes on activation, which is the closest analogue to a user click. — Cost if wrong: the §8.3 restore path is exercised through activation rather than a real user click; the engine behaviour under test (minimized leaves the tree, restore re-inserts and forces a fresh generation) is unchanged.

Ruling: Run the complex nested-layout/pending-split reload and selected-parent acknowledgement regressions in Task 6, once tree command dispatch exists. Task 5 still proves flat-tree retention and native lifecycle transitions. This avoids test-only mutation hooks or prematurely implementing the next task. Cost if wrong: complex reload defects may be discovered one task later; Task 6 must close the proof before completion.

| Task | Implementer / reviewer | Commit | Verification | Status |
|---|---|---|---|---|
| 1 — settings reconciliation | GPT-5.6 Sol / GPT-5.6 Sol | `d36bf17` | 10 focused tests; 239 full-suite tests; both TypeScript programs; Layer 0; diff check | Spec compliant, quality approved; no findings. Task 5 effective-count dependency confirmed in its contract. |
| 2 — topology migration | GPT-5.6 Sol / GPT-5.6 Sol | `0818493` | 16 final focused tests; 253 full-suite tests; tree lint; both TypeScript programs; diff check | Spec compliant, quality approved; no findings. |
| 3 — window tracking | GPT-5.6 Sol / GPT-5.6 Sol | `caf75b6`, `3edcdce` | 29 initial focused tests; 282 full-suite tests; 7 focused fix tests; both TypeScript programs; Layer 0; diff check | MRU enumeration finding fixed and re-reviewed clean. Minor native enum-mapping test coverage deferred to final review. |
| 4 — geometry reconciliation | GPT-5.6 Sol / GPT-5.6 Sol | `3f70af4`, `1e4a455` | 11 initial focused tests; 294 full-suite tests; 11 topology/backend fix tests; both TypeScript programs; Layer 0; staged diff check | Partial topology publication finding fixed with a GI-free transactional collector and re-reviewed clean. |
| 5 — engine lifecycle | GPT-6 Astra / GPT-6 Astra; fix re-review GPT-5.6 Sol | `603bc6f`, `f439d62` | 34 initial focused tests; 324 full-suite tests; 41 focused fix tests; both TypeScript programs; Layer 0; tree lint; staged diff check | Three focus/disposal race findings fixed with seven regressions and re-reviewed clean. |
| 6 — selection-based commands | GPT-5.6 Sol / GPT-5.6 Sol | `d0117df` | 15 command tests; 55 focused compatibility tests; 346 full-suite tests; both TypeScript programs; Layer 0; staged diff check | Spec compliant, quality approved; no findings. Deferred nested reload/pending-split and selected-parent proofs completed. |
| 7 — D-Bus and session lifecycle | GPT-5.6 Sol / GPT-5.6 Sol | `e477139` | 43 focused tests; 358 full-suite tests; both TypeScript programs; Layer 0; test/release builds and Debug exclusions; staged diff check | Spec compliant, quality approved; no findings. Native name-loss ownership proof assigned to Task 10. |
| 8 — config/input follow-ups | GPT-5.6 Sol / GPT-5.6 Sol | `0772df1` | 23 focused tests; 367 full-suite tests; both TypeScript programs; staged diff check | Spec compliant, quality approved; no findings. Native exclusive grabs and re-enable proof assigned to Tasks 9–10. |
| 9 — private GTK fixtures/native lifetime | GPT-6 Astra / GPT-6 Astra; fix re-review GPT-5.6 Sol | `bdf0cb8`, `c8b64cd` | 10 focused tests; 371 full-suite tests; both TypeScript programs/Layer 0; native smoke and Phase 1 acceptance; 14 cleanup-gate cases; release install, Debug exclusions and symlink | Fixture critical-log gate omission fixed and re-reviewed clean. Native teardown regressions fixed. Ancillary host warnings remain disclosed; visible mode and Xwayland clients are unverified. Monitor scenarios follow in Task 10. |
| 10 — A8–A14/delivery | Opus 5 (1M) / pending | pending | 378 full-suite tests in 38 files (7 new focused tests); both TypeScript programs; Layer 0; tree lint; diff check; full `run.sh` with Phase 1 plus 142 Phase 2 assertions; release restored | A8–A14 integration, two-monitor reconfiguration, A6 settings restoration and the Control-name conflict all pass. Two production defects found and fixed after focused RED tests: disposed-actor writes in the indicator at shutdown, and CRITICAL severity for a handled D-Bus name conflict. Live checklist written and unchecked. |

Final review must triage two deferred Minors: the normalized ignored-type table does not independently test every native enum mapping (`test/unit/runtime/classify.test.ts:30`), and successful private sessions retain disclosed ancillary a11y/GJS NetworkManager/GDM/portal warnings. Neither is an open task-review blocker. Full A8–A14 integration, native name-conflict/settings restoration proof, final delivery gates and whole-branch review remain unperformed.

Ruling: Use Meta.TabList.NORMAL_ALL_MRU for per-workspace adoption instead of the NORMAL example in spec §8.5. The installed Mutter 18 API explicitly guarantees pure MRU order for this variant, including minimized windows; classification still decides which windows are managed. — Preserves the binding MRU intent rather than relying on unordered Workspace.list_windows or NORMAL grouping behavior. — Cost if wrong: adoption may include additional eligible windows or choose a different initial order; native integration must verify adoption and minimized-window behavior.

Ruling: Include src/engine.ts in Task 7 so EngineState exposes a copied snapshot of the committed pill state used by the indicator. — Task 7 requires GetState.pills to use those same values, but its file list omitted the engine that produces them; duplicating pill calculation in ControlObject would create two sources of truth. — Cost if wrong: one additional public state field and its engine storage may need adjustment; command semantics are unchanged.

Ruling: Seed GNOME 50’s update-check-50 marker in the disposable private data directory before nested Shell startup. — The installed extension loader awaits a first-major-version network update check before importing extensions, which can delay a fresh private session. Seeding the marker did not resolve the observed startup stall; the subsequent --no-x11 probe isolated that separately. — Cost if wrong: the harness could bypass an unrelated future startup check; these tests do not exercise GNOME’s network updater.

Ruling: Launch the private GTK integration compositor with --no-x11. — A pre-integration build also hung on a single socket read during Xwayland startup; changing only this supported Shell option made Control, retry timers and teardown responsive. The required fixtures use native Wayland. — Cost if wrong: the automated suite does not cover Xwayland client behavior; that coverage remains outside this fixture run.

Ruling: Include the native window lifetime bridge and focused regressions in Task 9. — Real GTK teardown exposed disposed actor disconnection and reads of a window whose workspace had already become null before unmanaged; the fixture task cannot pass honestly while those production errors remain. — Cost if wrong: this expands the harness task into native lifecycle code, and a mistaken ordering fix could change removal timing or MRU behavior; focused ordering tests and native smoke are required before review.
