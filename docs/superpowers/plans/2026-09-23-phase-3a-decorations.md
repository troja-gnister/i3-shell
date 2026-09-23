# Phase 3A Decorations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw i3's window chrome — per-leaf borders, a focused-container frame, tab and stack title rows — and put a mirrored workspace bar on every non-primary monitor.

**Architecture:** `commit()` already computes every rectangle. It additionally computes a pure `DecorationPlan` and pushes it through a new `decorations` port; `src/shell/decorations.ts` is a renderer that diffs that plan against its actors and makes no decisions of its own. Title-row height is therefore part of the *layout* computation in Layer 0, not a cosmetic afterthought — `layoutWithRects` subtracts it before dividing space among children.

**Tech Stack:** TypeScript bundled by esbuild to a single ESM file; GNOME Shell 50.5 / Mutter 18 on Wayland; St / Clutter actors; vitest on Node for Layer 0 and adapter doubles; a private nested `gnome-shell --headless` for native checks.

**Spec:** `docs/superpowers/specs/2026-09-23-phase-3a-decorations-design.md` — binding. Read it before Task 1.

## Global Constraints

- Layer 0 (`src/config`, `src/commands`, `src/tree`, `src/runtime`, `src/engine.ts`) must never import `gi://`, `resource://`, or `src/shell/`. `npm run check:layer0` enforces this.
- No blanket `any` and no `@ts-ignore`. The only sanctioned cast in the codebase is `Main.actionMode as Shell.ActionMode`.
- Release builds must never contain `org.i3shell.Debug` XML or its methods; the interface is gated behind `__I3SHELL_TEST__`.
- The nested harness's native-critical gate must not be weakened. Exactly one upstream Mutter assertion is filtered, by exact text, in `test/integration/inside.sh`.
- Actors are created, updated and destroyed **only** from `commit()`. No other path may touch a decoration actor.
- Every task is RED before GREEN: write the failing test, run it, watch it fail for the right reason, then implement.
- **The controller owns all builds, native harness runs and installs.** A worker requests an exact command and freezes the affected files until output comes back. A worker never runs `npm run build*`, `test/integration/*`, `make install`, or `gnome-extensions`.
- Commit messages carry no attribution trailers.

## Review Focus

Five conditions the spec implies that no task's happy path would exercise. Each has its test added to the task that owns the code.

- **`rowHeight` measured as zero.** A theme or font failure returning 0 would make tab bars invisible and silently reintroduce the pre-Phase-3A layout. Must clamp to the 24px fallback. — Task 6.
- **A container shorter than its reserved rows.** A stacked container with many children on a short monitor reserves more height than it has. Children must come out zero-height, never negative, and `assertValidRect` must still hold. — Task 1.
- **A window destroyed between plan and render.** The plan names a `WindowId`; by the time the renderer looks for its actor the window may be gone. The renderer must skip it, not write to a disposed actor. — Task 4.
- **A monitor removed while its bar exists.** The bar actor must be untracked and destroyed and the strut released, or the work area stays shrunk for a monitor that no longer exists. — Task 5.
- **A window title containing markup or unbounded length.** Titles come from arbitrary applications. A tab label must not interpret markup and must not stretch its container. — Task 4.

---

### Task 1: `layoutWithRects` reserves the title row

**Files:**
- Modify: `src/tree/layout.ts:9-45`
- Test: `test/unit/tree/layout.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `layoutWithRects(con: Con, rect: Rect, rowHeight?: number): LayoutResult`. `rowHeight` defaults to `0`, which reproduces today's behaviour exactly, so the existing suite is unaffected. The engine is the only production caller that passes a non-zero value.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tree/layout.test.ts`:

```typescript
describe('title row reservation', () => {
  it('reserves one row for a tabbed container, whatever the child count', () => {
    const root = split('tabbed', [leaf(1), leaf(2), leaf(3)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300}, 20);
    // i3 draws a single row of tabs across the top, so every child starts at y+20
    // and every child is 20px shorter -- three children, one row.
    for (const id of [1, 2, 3])
      expect(windows.get(id)).toEqual({x: 0, y: 20, width: 400, height: 280});
  });

  it('reserves one row per child for a stacked container', () => {
    const root = split('stacked', [leaf(1), leaf(2), leaf(3)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300}, 20);
    // i3 shows every stacked child's title row simultaneously: 3 x 20 = 60.
    for (const id of [1, 2, 3])
      expect(windows.get(id)).toEqual({x: 0, y: 60, width: 400, height: 240});
  });

  it('leaves split containers untouched', () => {
    const root = split('splith', [leaf(1), leaf(2)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300}, 20);
    expect(windows.get(1)).toEqual({x: 0, y: 0, width: 200, height: 300});
    expect(windows.get(2)).toEqual({x: 200, y: 0, width: 200, height: 300});
  });

  it('clamps to zero height rather than going negative when the rows do not fit', () => {
    // Review Focus: a stacked container shorter than its own title rows.
    const root = split('stacked', [leaf(1), leaf(2), leaf(3)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 40}, 20);
    const rect = windows.get(1)!;
    expect(rect.height).toBe(0);
    expect(rect.y).toBe(40);
  });

  it('defaults to no reservation so existing callers are unchanged', () => {
    const root = split('tabbed', [leaf(1)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300});
    expect(windows.get(1)).toEqual({x: 0, y: 0, width: 400, height: 300});
  });
});
```

If `split()` and `leaf()` helpers are not already exported by that test file, copy the constructors the neighbouring tests in the same file use; do not invent new ones.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/tree/layout.test.ts`
Expected: the tabbed, stacked and clamping tests FAIL with received `y: 0` / `height: 300` — children currently get the full container rect. The split and default tests PASS from the start; they are over-correction guards.

- [ ] **Step 3: Implement the reservation**

In `src/tree/layout.ts`, change the signature and the tabbed/stacked branch:

```typescript
export function layoutWithRects(con: Con, rect: Rect, rowHeight = 0): LayoutResult {
  assertValidRect(rect);

  const windows = new Map<WindowId, Rect>();
  const containers = new Map<Con, Rect>();

  function visit(current: Con, currentRect: Rect): void {
    containers.set(current, currentRect);

    if (current.kind === 'leaf') {
      windows.set(current.window, {...currentRect});
      return;
    }

    if (current.layout === 'tabbed' || current.layout === 'stacked') {
      // i3 draws one row of tabs for `tabbed`, but one row per child for
      // `stacked`, where every title stays visible at once.
      const rows = current.layout === 'tabbed' ? 1 : current.children.length;
      const reserved = Math.min(currentRect.height, rowHeight * rows);
      const childRect = {
        x: currentRect.x,
        y: currentRect.y + reserved,
        width: currentRect.width,
        height: currentRect.height - reserved,
      };
      for (const child of current.children) visit(child, {...childRect});
      return;
    }
    // ... the existing split branch is unchanged
```

`Math.min` against the container's own height is what keeps the result non-negative.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/tree/layout.test.ts && npm test`
Expected: the new block passes and the whole suite stays at its prior count plus the five new tests. A failure anywhere else means a caller depended on tabbed children getting the full rect — report it rather than changing the other test.

- [ ] **Step 5: Commit**

```bash
git add src/tree/layout.ts test/unit/tree/layout.test.ts
git commit -m "feat: reserve title-row height in tabbed and stacked layout"
```

---

### Task 2: the pure `decorationPlan()`

**Files:**
- Create: `src/runtime/decoration.ts`
- Test: `test/unit/runtime/decoration.test.ts`

**Interfaces:**
- Consumes: `Con`, `LeafCon`, `SplitCon`, `NodeId`, `Rect`, `WindowId` from `src/tree/node`; `WindowInfo` from `src/runtime/model`.
- Produces:

```typescript
export type BorderState = 'focused' | 'focused_inactive' | 'unfocused' | 'urgent';

export interface DecorationPlan {
  borders: Array<{window: WindowId; rect: Rect; state: BorderState; width: number}>;
  frames: Array<{nodeId: NodeId; rect: Rect}>;
  titleRows: Array<{
    nodeId: NodeId;
    rect: Rect;
    rowHeight: number;
    layout: 'tabbed' | 'stacked';
    tabs: Array<{window: WindowId; title: string; selected: boolean}>;
  }>;
}

export function decorationPlan(input: DecorationInput): DecorationPlan;

export interface DecorationInput {
  roots: ReadonlyArray<{root: SplitCon; active: boolean}>;
  rects: ReadonlyMap<Con, Rect>;
  windows: ReadonlyMap<WindowId, WindowInfo>;
  focused: Con | null;
  rowHeight: number;
  borderWidth: number;
}
```

`roots` is one entry per monitor root that currently has rectangles, with `active` true for the roots of the active workspace. `focused` is the engine's current tiled selection.

`borderWidth` is the fallback from `default_border pixel N`. `borderOverrides` carries what the
`border` command set for individual windows, which acceptance A19 requires and which nothing in the
codebase stores today, so Task 3 must add it:

```typescript
  borderWidth: number;
  borderOverrides: ReadonlyMap<WindowId, number>;
```

A window absent from `borderOverrides` uses `borderWidth`. `border none` is stored as `0`, and a
zero-width border still produces a plan entry with `width: 0` rather than no entry, so the renderer
keeps one actor per window and the state colour still tracks focus.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/runtime/decoration.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {decorationPlan} from '../../../src/runtime/decoration';
import type {Con, SplitCon} from '../../../src/tree/node';
import type {WindowInfo} from '../../../src/runtime/model';

// Build the same shapes the tree tests build; copy the local helpers from
// test/unit/tree/layout.test.ts rather than inventing new ones.
function info(id: number, patch: Partial<WindowInfo> = {}): WindowInfo {
  return {id, workspace: 0, monitor: 1, kind: 'tiled',
    rect: {x: 0, y: 0, width: 10, height: 10}, title: `Window ${id}`, wmClass: 'fixture',
    minimized: false, fullscreen: false, maximizedH: false, maximizedV: false, ...patch};
}

describe('decorationPlan', () => {
  it('marks the focused leaf focused and its siblings focused_inactive', () => {
    const root = split('splith', [leaf(1), leaf(2)]);
    const [a, b] = root.children;
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [a, R(0, 0, 200, 300)], [b, R(200, 0, 200, 300)]]),
      windows: new Map([[1, info(1)], [2, info(2)]]),
      focused: a, rowHeight: 20, borderWidth: 2,
    });
    expect(plan.borders.find(x => x.window === 1)!.state).toBe('focused');
    expect(plan.borders.find(x => x.window === 2)!.state).toBe('focused_inactive');
  });

  it('marks leaves on an inactive workspace unfocused', () => {
    const root = split('splith', [leaf(1)]);
    const [a] = root.children;
    const plan = decorationPlan({
      roots: [{root, active: false}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [a, R(0, 0, 400, 300)]]),
      windows: new Map([[1, info(1)]]),
      focused: null, rowHeight: 20, borderWidth: 2,
    });
    expect(plan.borders[0].state).toBe('unfocused');
  });

  it('produces a frame only when the selection is a container', () => {
    const root = split('splith', [leaf(1), leaf(2)]);
    const rects = new Map<Con, Rect>([[root, R(0, 0, 400, 300)],
      [root.children[0], R(0, 0, 200, 300)], [root.children[1], R(200, 0, 200, 300)]]);
    const base = {roots: [{root, active: true}], rects,
      windows: new Map([[1, info(1)], [2, info(2)]]), rowHeight: 20, borderWidth: 2};
    expect(decorationPlan({...base, focused: root.children[0]}).frames).toEqual([]);
    expect(decorationPlan({...base, focused: root}).frames)
      .toEqual([{nodeId: root.id, rect: R(0, 0, 400, 300)}]);
  });

  it('describes a tabbed container as one row with the selected child marked', () => {
    const root = split('tabbed', [leaf(1), leaf(2)]);
    root.focusedChild = root.children[1];
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)],
        [root.children[0], R(0, 20, 400, 280)], [root.children[1], R(0, 20, 400, 280)]]),
      windows: new Map([[1, info(1)], [2, info(2, {title: 'Second'})]]),
      focused: root.children[1], rowHeight: 20, borderWidth: 2,
    });
    expect(plan.titleRows).toEqual([{
      nodeId: root.id, rect: R(0, 0, 400, 300), rowHeight: 20, layout: 'tabbed',
      tabs: [{window: 1, title: 'Window 1', selected: false},
             {window: 2, title: 'Second', selected: true}],
    }]);
  });

  it('gives a fullscreen leaf neither a border nor a title row', () => {
    const root = split('tabbed', [leaf(1)]);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [root.children[0], R(0, 20, 400, 280)]]),
      windows: new Map([[1, info(1, {fullscreen: true})]]),
      focused: root.children[0], rowHeight: 20, borderWidth: 2,
    });
    expect(plan.borders).toEqual([]);
    expect(plan.titleRows).toEqual([]);
  });

  it('prefers a per-window border override to the configured default', () => {
    // Acceptance A19: the `border` command changes one window's width.
    const root = split('splith', [leaf(1), leaf(2)]);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)],
        [root.children[0], R(0, 0, 200, 300)], [root.children[1], R(200, 0, 200, 300)]]),
      windows: new Map([[1, info(1)], [2, info(2)]]),
      focused: null, rowHeight: 20, borderWidth: 2,
      borderOverrides: new Map([[1, 0]]),
    });
    expect(plan.borders.find(x => x.window === 1)!.width).toBe(0);
    expect(plan.borders.find(x => x.window === 2)!.width).toBe(2);
  });

  it('carries the configured border width on every border', () => {
    const root = split('splith', [leaf(1)]);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [root.children[0], R(0, 0, 400, 300)]]),
      windows: new Map([[1, info(1)]]),
      focused: null, rowHeight: 20, borderWidth: 5, borderOverrides: new Map(),
    });
    expect(plan.borders[0].width).toBe(5);
  });
});
```

Add the local helpers `R(x, y, width, height)`, `split(layout, children)` and `leaf(window)` at the top of the file, copying the constructors used in `test/unit/tree/layout.test.ts`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/runtime/decoration.test.ts`
Expected: FAIL with `Cannot find module '../../../src/runtime/decoration'`.

- [ ] **Step 3: Implement the module**

Create `src/runtime/decoration.ts`. Rules, all from spec §3.2:

- Walk every entry of `roots`. For each leaf, look up its rect in `rects`; skip a leaf with no rect, and skip a leaf whose `WindowInfo` is missing, `fullscreen` or `minimized`.
- State: `focused` when the leaf is `focused`; `focused_inactive` when the root is active and the leaf shares its parent chain with `focused` (that is, `focused` is an ancestor of the leaf, or they share a parent); `unfocused` otherwise. `urgent` is never produced.
- `frames` gets one entry — `{nodeId: focused.id, rect}` — only when `focused` is a `SplitCon` with a rect.
- `titleRows` gets one entry per `tabbed` or `stacked` container that has a rect and at least one child whose window is not fullscreen; `tabs` is in child order, `selected` is `child === current.focusedChild`, and `title` comes from `windows.get(id)?.title ?? ''`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/runtime/decoration.test.ts && npm run check:layer0`
Expected: PASS, and `layer0 check ok`. If `check:layer0` fails, the new file imported something from `src/shell/` — remove it; the plan is pure data.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/decoration.ts test/unit/runtime/decoration.test.ts
git commit -m "feat: compute a pure decoration plan from the tree"
```

---

### Task 3: the `decorations` port, and `rowHeight` in the snapshot

**Files:**
- Modify: `src/engine.ts` (the `EnginePorts` interface near line 40; the commit body near line 288)
- Modify: `src/runtime/snapshot.ts:7-42`
- Test: `test/unit/engine/fakeEngine.ts`, `test/unit/engine/lifecycle.test.ts`, `test/unit/runtime/snapshot.test.ts`

**Interfaces:**
- Consumes: `decorationPlan`, `DecorationPlan` from Task 2; `layoutWithRects(con, rect, rowHeight)` from Task 1.
- Produces: `EnginePorts.decorations: {apply(plan: DecorationPlan): void}` and, separately, the public methods `Engine.setRowHeight(height: number): void` and `Engine.setBorder(window: WindowId, width: number): void`. `rowHeight` is deliberately **not** a port method: the shell measures it and calls the engine directly, the way it already calls `onMonitorsChanged()`. A port the shell invokes on itself would be a port in name only. `NodeSnapshot` for a split gains `rowHeight: number` (0 for split layouts).

- [ ] **Step 1: Write the failing tests**

Extend the fake in `test/unit/engine/fakeEngine.ts` exactly as the `accent` port was extended: add

```typescript
    decorations: {
      apply: plan => { f.plan = plan; calls.push('decorations'); },
    },
```

and `plan: null as DecorationPlan | null,` to the returned object.

Append to `test/unit/engine/lifecycle.test.ts`:

```typescript
describe('decorations', () => {
  it('pushes a plan on every commit, including the one that empties it', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.flush();
    expect(f.plan!.borders.map(b => b.window)).toEqual([1]);
    f.remove(1);
    f.flush();
    expect(f.plan!.borders).toEqual([]);
  });

  it('lays out with the row height the shell measured', () => {
    const f = fakeEngine();
    f.engine.start();
    f.engine.setRowHeight(20);
    f.add(1);
    f.flush();
    f.engine.run(parseCommands('layout tabbed'), 0);
    f.flush();
    // The tabbed root reserved one row, so the window starts 20px lower.
    const applied = f.applied.at(-1)!;
    expect(applied.get(1)!.y).toBe(50);   // work area y 30 + 20
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/engine/lifecycle.test.ts`
Expected: FAIL — `f.plan` is null because nothing pushes a plan, and the second test fails on `y` still being 30.

- [ ] **Step 3: Implement**

In `src/engine.ts`: add the port to `EnginePorts`; store `private _rowHeight = 0;` and add `setRowHeight(height: number): void` which records the value and requests a commit if it changed. Pass `this._rowHeight` as the third argument to `layoutWithRects`. After the reconciler plan is applied, build the input from the workspaces already walked and call `this._ports.decorations.apply(decorationPlan(...))`. `borderWidth` comes from `this._config.defaultBorder.width`, and `borderOverrides` from a new `private _borderOverrides = new Map<WindowId, number>()` that `setBorder` writes and the `border` command handler calls; a window's entry is dropped when the window is removed.

In `src/runtime/snapshot.ts`, add `rowHeight` to the split branch: `current.layout === 'tabbed' ? rowHeight : current.layout === 'stacked' ? rowHeight * children.length : 0`, threaded in as a new parameter to `serializeTree`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test && npm run typecheck && npm run check:layer0`
Expected: all green. `src/extension.ts` will now fail typecheck with "Property 'decorations' is missing" — that is Task 6's job; note it and continue.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/runtime/snapshot.ts test/unit/engine/ test/unit/runtime/snapshot.test.ts
git commit -m "feat: push a decoration plan from commit and expose row height"
```

---

### Task 4: the renderer

**Files:**
- Create: `src/shell/decorations.ts`
- Test: `test/unit/shell/decorations.test.ts`

**Interfaces:**
- Consumes: `DecorationPlan` (Task 2); `effectiveColors` and `Accent` from `src/config/colors`; `Colors` from `src/config/model`.
- Produces: `class Decorations { constructor(colors: Colors); apply(plan: DecorationPlan): void; setColors(colors: Colors): void; destroy(): void; }`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/shell/decorations.test.ts`. Mock `gi://St` and `gi://Clutter` and
`resource:///org/gnome/shell/ui/main.js` the way `test/unit/shell/indicator.test.ts` already does,
and build actors from the recording doubles in `test/unit/shell/fakes/actors.ts`, which log access
to a destroyed actor instead of throwing.

```typescript
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {DecorationPlan} from '../../../src/runtime/decoration';
import {DEFAULT_COLORS} from '../../../src/config/model';

// windowActors is what global.get_window_actors() returns; a window missing from
// it stands for one destroyed between commit and render.
const windowActors = new Map<number, FakeActor>();
vi.mock('gi://St', () => ({default: stFakes}));
vi.mock('gi://Clutter', () => ({default: clutterFakes}));

const {Decorations} = await vi.importActual<{
  Decorations: new (colors: typeof DEFAULT_COLORS, focus: (w: number) => void) => {
    apply(plan: DecorationPlan): void;
    destroy(): void;
  };
}>('../../../src/shell/decorations');

const R = (x: number, y: number, width: number, height: number) => ({x, y, width, height});
const empty: DecorationPlan = {borders: [], frames: [], titleRows: []};
const border = (window: number, rect = R(0, 0, 100, 100)) =>
  ({borders: [{window, rect, state: 'focused' as const, width: 2}], frames: [], titleRows: []});

beforeEach(() => { windowActors.clear(); resetFakeActors(); });

describe('Decorations', () => {
  it('reuses a border actor when only its rectangle changed', () => {
    windowActors.set(1, new FakeActor());
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply(border(1, R(0, 0, 100, 100)));
    const first = lastCreated('border');
    d.apply(border(1, R(50, 0, 100, 100)));
    expect(lastCreated('border')).toBe(first);
    expect(first.destroyed).toBe(false);
    expect(first.geometry).toEqual(R(50, 0, 100, 100));
  });

  it('destroys actors the plan no longer contains', () => {
    windowActors.set(1, new FakeActor());
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply(border(1));
    const actor = lastCreated('border');
    d.apply(empty);
    expect(actor.destroyCount).toBe(1);
  });

  it('keys title rows by nodeId, not by rectangle', () => {
    windowActors.set(1, new FakeActor());
    const row = (rect: ReturnType<typeof R>) => ({
      borders: [], frames: [],
      titleRows: [{nodeId: 7, rect, rowHeight: 20, layout: 'tabbed' as const,
        tabs: [{window: 1, title: 'One', selected: true}]}],
    });
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply(row(R(0, 0, 400, 300)));
    const first = lastCreated('row');
    d.apply(row(R(0, 0, 200, 300)));
    // A rectangle key would have destroyed and rebuilt an actor that only moved.
    expect(lastCreated('row')).toBe(first);
    expect(first.destroyCount).toBe(0);
  });

  it('skips a window whose actor has gone away between plan and render', () => {
    // Review Focus: the plan names a WindowId; the window may be gone by now.
    const d = new Decorations(DEFAULT_COLORS, () => {});
    expect(() => d.apply(border(99))).not.toThrow();
    expect(disposedAccesses()).toEqual([]);
  });

  it('does not interpret markup in a tab title', () => {
    // Review Focus: titles come from arbitrary applications.
    windowActors.set(1, new FakeActor());
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply({borders: [], frames: [], titleRows: [{nodeId: 7, rect: R(0, 0, 400, 300),
      rowHeight: 20, layout: 'tabbed', tabs: [{window: 1, title: '<b>x</b>', selected: true}]}]});
    const label = lastCreated('tab');
    expect(label.text).toBe('<b>x</b>');
    expect(label.useMarkup).toBe(false);
  });

  it('focuses the tab that was clicked, without touching the tree', () => {
    windowActors.set(1, new FakeActor());
    const focused: number[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w));
    d.apply({borders: [], frames: [], titleRows: [{nodeId: 7, rect: R(0, 0, 400, 300),
      rowHeight: 20, layout: 'tabbed', tabs: [{window: 1, title: 'One', selected: false}]}]});
    lastCreated('tab').emit('clicked');
    expect(focused).toEqual([1]);
  });

  it('destroys every actor on destroy(), and touches none afterwards', () => {
    windowActors.set(1, new FakeActor());
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply({...border(1), frames: [{nodeId: 3, rect: R(0, 0, 400, 300)}]});
    d.destroy();
    d.destroy();                       // idempotent, as disable() is
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors()).toEqual([]);
  });
});
```

`lastCreated(kind)`, `liveActors()`, `disposedAccesses()` and `resetFakeActors()` are helpers to add
beside the existing doubles in `test/unit/shell/fakes/actors.ts`; follow the naming already there
rather than inventing a parallel scheme.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/shell/decorations.test.ts`
Expected: FAIL with `Cannot find module '../../../src/shell/decorations'`.

- [ ] **Step 3: Implement the renderer**

`Decorations` holds `Map<WindowId, St.Widget>` for borders, `Map<NodeId, St.Widget>` for frames and `Map<NodeId, St.BoxLayout>` for rows. `apply()` diffs: create what is new, update geometry and style on what persists, destroy what the plan omits. Border colour is `effectiveColors(...)[state]`; border width comes from the plan. Actors go in `global.window_group`; a border is lowered to sit immediately below its window actor via `set_child_below_sibling`. A tab is an `St.Button` whose `clicked` handler calls the focus callback passed to the constructor — the renderer never mutates the tree. Labels are set with plain text; `use_markup` is never set.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/shell/decorations.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/decorations.ts test/unit/shell/decorations.test.ts
git commit -m "feat: render the decoration plan"
```

---

### Task 5: per-monitor workspace bars

**Files:**
- Create: `src/shell/bars.ts`
- Test: `test/unit/shell/bars.test.ts`

**Interfaces:**
- Consumes: `PillState` from `src/runtime/model`; `Colors`.
- Produces: `class MonitorBars { constructor(onPill: (index: number) => void); setPills(pills: PillState[]): void; setMode(name: string | null): void; setColors(colors: Colors): void; setVisible(visible: boolean): void; monitorsChanged(): void; destroy(): void; }`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/shell/bars.test.ts` with a fake `Main.layoutManager` exposing `monitors`,
`primaryIndex`, `addChrome`, `untrackChrome` and `removeChrome`, recording every call.

```typescript
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {PillState} from '../../../src/runtime/model';
import {DEFAULT_COLORS} from '../../../src/config/model';

const chrome: Array<{actor: FakeActor; params: {affectsStruts?: boolean}}> = [];
const untracked: FakeActor[] = [];
let monitors = [
  {index: 0, x: 0, y: 0, width: 1728, height: 1048},
  {index: 1, x: 1728, y: 0, width: 1920, height: 1080},
];
let primaryIndex = 0;

vi.mock('resource:///org/gnome/shell/ui/main.js', () => ({
  layoutManager: {
    get monitors() { return monitors; },
    get primaryIndex() { return primaryIndex; },
    addChrome: (actor: FakeActor, params = {}) => { chrome.push({actor, params}); },
    untrackChrome: (actor: FakeActor) => { untracked.push(actor); },
    removeChrome: (actor: FakeActor) => { untracked.push(actor); },
  },
}));

const {MonitorBars} = await vi.importActual<{
  MonitorBars: new (onPill: (index: number) => void) => {
    setPills(pills: PillState[]): void;
    setMode(name: string | null): void;
    setColors(colors: typeof DEFAULT_COLORS): void;
    setVisible(visible: boolean): void;
    monitorsChanged(): void;
    destroy(): void;
  };
}>('../../../src/shell/bars');

const pills: PillState[] = [
  {name: '1:I', active: true, occupied: true},
  {name: '2:II', active: false, occupied: false},
];

beforeEach(() => {
  chrome.length = 0; untracked.length = 0; resetFakeActors();
  monitors = [{index: 0, x: 0, y: 0, width: 1728, height: 1048},
              {index: 1, x: 1728, y: 0, width: 1920, height: 1080}];
  primaryIndex = 0;
});

describe('MonitorBars', () => {
  it('creates one bar per non-primary monitor and none for the primary', () => {
    new MonitorBars(() => {});
    expect(chrome).toHaveLength(1);
    expect(chrome[0].actor.geometry.x).toBe(1728);
  });

  it('reserves strut space along the monitor edge', () => {
    new MonitorBars(() => {});
    expect(chrome[0].params.affectsStruts).toBe(true);
    expect(chrome[0].actor.geometry.y).toBe(0);
    expect(chrome[0].actor.geometry.width).toBe(1920);
  });

  it('mirrors the same pills onto every bar', () => {
    const bars = new MonitorBars(() => {});
    bars.setPills(pills);
    expect(labelsOf(chrome[0].actor)).toEqual(['1:I', '2:II']);
    expect(activeIndexOf(chrome[0].actor)).toBe(0);
  });

  it('switches the shared workspace when a mirrored pill is clicked', () => {
    const switched: number[] = [];
    const bars = new MonitorBars(i => switched.push(i));
    bars.setPills(pills);
    pillsOf(chrome[0].actor)[1].emit('clicked');
    expect(switched).toEqual([1]);
  });

  it('removes a bar and releases its strut when its monitor goes away', () => {
    // Review Focus: a stale strut would shrink the work area of a monitor
    // that no longer exists.
    const bars = new MonitorBars(() => {});
    const actor = chrome[0].actor;
    monitors = [monitors[0]];
    bars.monitorsChanged();
    expect(untracked).toContain(actor);
    expect(actor.destroyCount).toBe(1);
  });

  it('hides every bar when the session has no windows', () => {
    const bars = new MonitorBars(() => {});
    bars.setVisible(false);
    expect(chrome[0].actor.visible).toBe(false);
  });

  it('destroys every bar on destroy(), and touches none afterwards', () => {
    const bars = new MonitorBars(() => {});
    bars.destroy();
    bars.destroy();
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors()).toEqual([]);
  });
});
```

`labelsOf`, `activeIndexOf` and `pillsOf` read the fake actor tree; add them beside the helpers
Task 4 introduced rather than duplicating them.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/shell/bars.test.ts`
Expected: FAIL with `Cannot find module '../../../src/shell/bars'`.

- [ ] **Step 3: Implement**

`MonitorBars` rebuilds its set on construction and whenever it is told the monitor layout changed. Each bar is an `St.BoxLayout` spanning its monitor's width at that monitor's top edge, added with `Main.layoutManager.addChrome(actor, {affectsStruts: true, trackFullscreen: true})`. `setPills` renders the same `PillState[]` the panel indicator receives — mirrored by design, spec §4.3. Teardown untracks before destroying.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/unit/shell/bars.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/bars.ts test/unit/shell/bars.test.ts
git commit -m "feat: mirrored workspace bar on every non-primary monitor"
```

---

### Task 6: measure `rowHeight` and wire everything into the extension

**Files:**
- Create: `src/shell/rowHeight.ts`
- Modify: `src/extension.ts`
- Test: `test/unit/shell/rowHeight.test.ts`

**Interfaces:**
- Consumes: `Decorations` (Task 4), `MonitorBars` (Task 5), `Engine.setRowHeight` (Task 3).
- Produces: `export const FALLBACK_ROW_HEIGHT = 24;` and `export function measureRowHeight(): number;`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/shell/rowHeight.test.ts`, mocking `gi://St` so the label's preferred height and
its constructor are controllable:

```typescript
import {beforeEach, describe, expect, it, vi} from 'vitest';

let preferred: [number, number] = [0, 26];
let constructorThrows = false;

vi.mock('gi://St', () => ({
  default: {
    Label: class {
      constructor() { if (constructorThrows) throw new Error('no theme'); }
      get_preferred_height() { return preferred; }
      destroy() {}
    },
  },
}));

const {measureRowHeight, FALLBACK_ROW_HEIGHT} = await vi.importActual<{
  measureRowHeight(): number;
  FALLBACK_ROW_HEIGHT: number;
}>('../../../src/shell/rowHeight');

beforeEach(() => { preferred = [0, 26]; constructorThrows = false; });

describe('measureRowHeight', () => {
  it('returns the themed actor\'s preferred height', () => {
    expect(measureRowHeight()).toBe(26);
  });

  it('falls back when the theme reports zero', () => {
    // Review Focus: a zero measurement would silently restore the pre-3A
    // layout, with tab bars invisible and children back at the full rect.
    preferred = [0, 0];
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    expect(FALLBACK_ROW_HEIGHT).toBe(24);
  });

  it('falls back on a negative or non-finite measurement', () => {
    preferred = [0, -5];
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    preferred = [0, Number.NaN];
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
  });

  it('falls back when measuring throws, without rethrowing', () => {
    constructorThrows = true;
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/unit/shell/rowHeight.test.ts`
Expected: FAIL with `Cannot find module '../../../src/shell/rowHeight'`.

- [ ] **Step 3: Implement and wire up**

`measureRowHeight()` builds one throwaway themed `St.Label` with the tab style class, reads `get_preferred_height(-1)[1]`, destroys it, and returns the value or `FALLBACK_ROW_HEIGHT` when it is `0`, negative, non-finite, or the call throws.

In `src/extension.ts`: construct `Decorations` and `MonitorBars`, pass `decorations: {apply: plan => decorations.apply(plan)}` into `EnginePorts`, call `engine.setRowHeight(measureRowHeight())` after `engine.start()`, re-measure on `St.Settings` `notify::font-name`, and destroy both in `disable()` beside the existing `_indicator` teardown.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test && npm run typecheck`
Expected: all green, including the `src/extension.ts` error left over from Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/shell/rowHeight.ts src/extension.ts test/unit/shell/rowHeight.test.ts
git commit -m "feat: measure the title row height and wire decorations into the extension"
```

---

### Task 7: stop servicing compositor signals at shutdown

**Files:**
- Modify: `src/extension.ts`
- Test: `test/unit/shell/sessionState.test.ts` (or a new `test/unit/shell/closing.test.ts` if that file has no room)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exported surface; behaviour only.

- [ ] **Step 1: Write the failing test**

```typescript
it('stops servicing compositor signals once the display reports closing', () => {
  // Meta.Display::closing fires while the session tears down. Today
  // workareas-changed still drives a full commit, so geometry.apply can call
  // move_resize_frame on windows being destroyed and decorations can write to
  // actors the shell is disposing.
  const f = fixture();
  f.emitDisplay('closing');
  f.emitDisplay('workareas-changed');
  expect(f.commits).toBe(0);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/unit/shell/sessionState.test.ts`
Expected: FAIL — a commit still runs after `closing`.

- [ ] **Step 3: Implement**

Connect `global.display` `closing` in `enable()`, set a `_closing` flag, and have every compositor-signal handler return early when it is set. Disconnect the handler in `disable()` with the others.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts test/unit/shell/
git commit -m "fix: stop servicing compositor signals once the display is closing"
```

---

### Task 8: native scenarios and the acceptance checklist

**Files:**
- Modify: `test/integration/phase2-checks.py`
- Create: `docs/acceptance/phase-3.md`
- Modify: `README.md`, `PROJECT.md` (counts only, after the controller reports measured numbers)

**Interfaces:**
- Consumes: `GetTree`'s new `rowHeight` field (Task 3).

- [ ] **Step 1: Write the failing scenarios**

Add `scenario_decorations()` asserting, against real GTK windows:

- Two windows in a `tabbed` container: each child's `y` equals the container's `y` plus the container's reported `rowHeight`, and both children share one rect.
- Three windows in a `stacked` container: each child's `y` equals the container's `y` plus `rowHeight`, where the container's reported `rowHeight` is already the per-child total.
- Returning the container to `splith` restores the children to the full rect.

Extend the two-monitor scenario to assert the secondary monitor's work area height is smaller than the monitor height by the bar height, and that tiles on it respect the reduced area.

Register `scenario_decorations` in `single_monitor()`.

- [ ] **Step 2: Request the harness run**

The worker does not run this. Hand the controller: `bash test/integration/run.sh`, and freeze the touched files until the output returns.
Expected: the new assertions FAIL before Tasks 1–7 are merged, and PASS after.

- [ ] **Step 3: Write the acceptance checklist**

Create `docs/acceptance/phase-3.md` in the same shape as `docs/acceptance/phase-2.md`: product revision, build under test, environment, a "how to run this walk" block, then one unchecked box per acceptance criterion A15–A21, then an "automated evidence" table and a "what the automation does not cover" list. **Nothing in the repository may tick a box.** State explicitly that window title bars remain (spec §1) so the user does not report that as a defect.

- [ ] **Step 4: Verify**

Run: `python3 -m py_compile test/integration/phase2-checks.py` and request `bash test/integration/run.sh` from the controller.
Expected: green, with the assertion count risen. The controller supplies the measured number; do not guess it when updating `README.md` and `PROJECT.md`.

- [ ] **Step 5: Commit**

```bash
git add test/integration/phase2-checks.py docs/acceptance/phase-3.md README.md PROJECT.md
git commit -m "test: native decoration scenarios and the phase 3 acceptance checklist"
```
