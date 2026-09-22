# Phase 2A — Pure Container Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic container-tree model and algorithms underlying A8–A14, with scenario and property tests, ready for the GNOME window lifecycle and geometry integration plan.

**Architecture:** Plain TypeScript nodes, workspace/monitor ownership and selection live in `src/tree/`. The `Tree` facade coordinates mutations; focused algorithms and geometry calculations are independent modules. Only the engine will call mutations in the running extension. This deliverable introduces no window manipulation or new bindings into the live extension.

**Tech Stack:** Existing TypeScript 5.9, vitest 4, esbuild and GNOME Shell 50 types; add fast-check and ESLint for the pure tree. No GNOME imports in this subsystem.

**Spec:** `docs/superpowers/specs/2026-09-20-i3-shell-design.md`, especially §7, §9 and §16.1, including the approved 2026-09-21 clarifications. Read `docs/superpowers/plans/2026-09-21-phase-1-carry-forward.md` too.

**Status:** The user resumed Phase 2A on 2026-09-21. Pure-tree implementation, delivery verification and all reviews are complete. The user authorized merging `phase-2` into `main` on 2026-09-22; the fast-forward to `849e181` passed all 234 tests, and the completed branch was deleted. Phase 1 A1–A7 passed by user report on 2026-09-21. Audit baseline `df0187d`, 64 unit tests; the delivery suite now has 234 tests. The two recovery fixes and fake-Gio regression tests remain part of that baseline.

## Global Constraints

- Target: GNOME Shell 50.x (Mutter 18), Wayland session, Fedora Silverblue 44.
- Layer 0 never imports `gi://`, `resource://` or `src/shell/`; preserve `npm run check:layer0`.
- Reuse `Direction` and `Layout` from `src/commands/model.ts`; `stacking` is already parsed to `stacked`.
- Opaque `WindowId`s come from the future window adapter. The core never holds a `Meta.Window` or reads `global.display.focus_window`.
- Level order is workspace → monitor → containers. A monitor root is a split with `root: true`; its layout is only `splith` or `splitv`.
- Preserve one-leaf splits: they represent the user's pending split direction.
- Per-child percents are positive, finite and sum to one; insertion uses `1/n`, removal redistributes proportionally, swap keeps percents at their positions.
- Tabbed/stacked children share their parent rectangle in Phase 2; bars and borders belong to Phase 3.
- Maximize/minimize/fullscreen reconciliation and real window moves belong to the following integration plan. Fullscreen does not remove a tiled leaf; minimize does.
- Marks and scratchpad are outside v1. Docking/scaling questions belong to Phase 4, not this plan.
- Work on branch `phase-2` in this checkout at execution time. Do not create a worktree: the installed extension symlinks this checkout's `dist/`.
- Preserve `.npmrc` and the current `@girs` pins. No new `@girs` packages.
- Commit each reviewed task with a conventional subject and a trailer naming the authoring model.

## Review Focus

These five classes have dedicated scenarios and randomized coverage below:

1. A selected parent container must remain selected across normalization, movement and resize; keyboard focus is a separate engine concern (Tasks 2, 4, 5, 6).
2. Empty roots, duplicate window ids, dead selections and nested one-leaf splits must not corrupt membership or consume ids on failed validation (Tasks 1, 2, 3, 8).
3. Resize rejection must leave every percent unchanged; pixel conversion must use the matching ancestor's actual rectangle, including nested layouts (Tasks 3, 6).
4. Repeated tiled/floating transitions and whole-container workspace transfers must preserve unique membership, source focus and subtree identity (Tasks 2, 7, 8).
5. Odd-sized/tiny work areas and overlapping tab/stack descendants need local, layout-specific geometric assertions, not global leaf non-overlap (Tasks 3, 8).

## Scope and integration boundary

This is the first independently testable subsystem of Phase 2. It covers the pure semantics of A8–A13 and the structural portion of A14. It does **not** claim desktop acceptance for any A8–A14 item. After it is implemented and reviewed, write the Phase 2B window lifecycle/geometry plan against these tested interfaces. That plan must deliver actual tiling and resizing before Phase 2 is complete.

Phase 2B owns: first-frame adoption and MRU ordering; normal/dialog/fixed-size classification; id-based window commands; engine command dispatch and commit; geometry reconciliation with the four forced-reapply events; minimized/fullscreen state; expected-workspace acknowledgements; monitor-change migration; GetTree/GetWindows/TreeChanged; GTK test windows and nested-shell A8–A14 scenarios. Preserve the existing Phase 1 integration checks, replacing the assertion that resize logs “not implemented” once resize is implemented.

Phase 1 carry-forward that touches shell behavior (settings default reset/sync, initial lock state, D-Bus ownership loss, smooth scrolling and keybinding cleanup) stays in that integration plan. Parser diagnostics/variable-name improvements and cosmetic texts remain explicit carry-forward items; they are not prerequisites for the pure tree. Do not silently widen this task to fix them.

## Files and ownership

| File | Responsibility |
|---|---|
| `src/tree/node.ts` | Types, traversal, orientation and local child-list operations |
| `src/tree/tree.ts` | Workspace/monitor roots, membership, selection, insert/remove/normalize/check |
| `src/tree/layout.ts` | Integer rectangles and tab/stack raise ordering |
| `src/tree/focus.ts` | Directional/parent/child navigation without window activation |
| `src/tree/operations.ts` | Split, layout switching and directional movement |
| `src/tree/resize.ts` | Transactional percent adjustment |
| `test/unit/tree/helpers.ts` | Literal tree fixtures and independent snapshots |
| `test/unit/tree/*.test.ts` | Scenarios, exact rectangles and generated operation sequences |
| `eslint.config.mjs` | Rules scoped to the new tree and its tests |
| `package.json`, `package-lock.json` | New development dependencies and `lint:tree` |

`operations.ts` separates structural editing from workspace bookkeeping instead of growing one large `tree.ts`. No circular imports: `node` → command types only; `layout`, `focus`, `resize` → `node`; `operations` → `node` and `focus`; `tree` → those modules. Modules receive node references or allocation callbacks; they never import `Tree` at runtime. `descendFocused` lives in `node.ts` from Task 1 because membership and normalization need it in Task 2. `descendDirection` arrives in `focus.ts` in Task 4, before movement uses it in Task 5.

---

## Task 1: Node model, child-list arithmetic and test tooling

**Files:** create `src/tree/node.ts`, `test/unit/tree/node.test.ts`, `test/unit/tree/helpers.ts`, `eslint.config.mjs`; modify `package.json` and lockfile.

**Interfaces produced:** the following types and functions. Window ids are positive integers; workspace and monitor indices are nonnegative integers. Node ids are allocated by a `Tree` instance and never reused within it.

```ts
import type {Direction, Layout} from '../commands/model';
export type WindowId = number;
export type NodeId = number;
export type MonitorId = number;
export type Axis = 'h' | 'v';
export type SplitLayout = 'splith' | 'splitv';
export interface Rect { x: number; y: number; width: number; height: number }
export interface LeafCon {
  kind: 'leaf'; id: NodeId; parent: SplitCon | null; window: WindowId;
}
export interface SplitCon {
  kind: 'split'; id: NodeId; parent: SplitCon | null; root: boolean;
  layout: Layout; lastSplitLayout: SplitLayout;
  children: Con[]; percents: number[]; focusedChild: Con | null;
}
export type Con = LeafCon | SplitCon;
export interface WorkspaceCon {
  index: number;
  monitors: Map<MonitorId, SplitCon>;
  focusedCon: Con | null; // tiled selection retained while floating is active
  floating: WindowId[]; // MRU first
  focusedFloating: WindowId | null;
}
export type Selection = {kind: 'tiled'; con: Con} | {kind: 'floating'; window: WindowId} | null;
export type AllocateSplit = (layout: Layout, root?: boolean) => SplitCon;

export function axis(layout: Layout): Axis;
export function directionAxis(direction: Direction): Axis;
export function isForward(direction: Direction): boolean;
export function walk(con: Con): Generator<Con>;
export function leaves(con: Con): Generator<LeafCon>;
export function descendFocused(con: Con): LeafCon | null;
export function rootOf(con: Con): SplitCon;
export function attach(parent: SplitCon, child: Con, index: number): void;
export function detach(child: Con): SplitCon;
export function replace(parent: SplitCon, oldChild: Con, newChild: Con): void;
export function focusChain(con: Con): void;
```

The declarations above specify the public API, not a file to install verbatim. Function bodies are built and tested in this task. Every Tree facade that changes structure must normalize before returning; raw node/algorithm helpers may leave intermediate structures for their facade to normalize. This keeps direct callers and later engine commits on the same invariant contract.

- [x] **Step 1: Write failing arithmetic tests.** `helpers.ts` creates literal fixtures without calling `Tree` methods. Fixture ids are local to the fixture builder, never production ids:

```ts
import type {Layout} from '../../../src/commands/model';
import type {Con, LeafCon, SplitCon, WindowId} from '../../../src/tree/node';
export type Shape = WindowId | readonly [Layout, readonly Shape[]];
let nextFixtureId = 1;
export function leaf(window: WindowId): LeafCon {
  return {kind: 'leaf', id: nextFixtureId++, parent: null, window};
}
export function split(layout: Layout, children: Con[], root = false): SplitCon {
  const con: SplitCon = {
    kind: 'split', id: nextFixtureId++, parent: null, root, layout,
    lastSplitLayout: layout === 'splitv' ? 'splitv' : 'splith',
    children, percents: children.map(() => 1 / children.length),
    focusedChild: children.at(-1) ?? null,
  };
  for (const child of children) child.parent = con;
  return con;
}
export function shape(con: Con): Shape {
  return con.kind === 'leaf' ? con.window : [con.layout, con.children.map(shape)];
}
export function fromShape(value: Shape, root = true): Con {
  return typeof value === 'number' ? leaf(value)
    : split(value[0], value[1].map(child => fromShape(child, false)), root);
}
export function findLeaf(con: Con, window: WindowId): LeafCon | null {
  if (con.kind === 'leaf') return con.window === window ? con : null;
  for (const child of con.children) {
    const result = findLeaf(child, window);
    if (result) return result;
  }
  return null;
}
```

```ts
import {expect, it} from 'vitest';
import {attach, detach, replace} from '../../../src/tree/node';
import {leaf, split} from './helpers';

it('insertion grants 1/n and removal restores proportional shares', () => {
  const a = leaf(1), b = leaf(2), c = leaf(3);
  const p = split('splith', [a, b], true);
  p.percents = [0.75, 0.25];
  attach(p, c, 1);
  expect(p.children).toEqual([a, c, b]);
  expect(p.percents[0]).toBeCloseTo(0.5);
  expect(p.percents[1]).toBeCloseTo(1 / 3);
  expect(p.percents[2]).toBeCloseTo(1 / 6);
  detach(c);
  expect(p.percents).toEqual([0.75, 0.25]);
  expect(c.parent).toBeNull();
});
it('replacement preserves the parent slot percentage and focus', () => {
  const a = leaf(1), b = leaf(2), replacement = split('splitv', []);
  const p = split('splith', [a, b], true);
  p.percents = [0.6, 0.4];
  p.focusedChild = a;
  replace(p, a, replacement);
  expect(p.children).toEqual([replacement, b]);
  expect(p.percents).toEqual([0.6, 0.4]);
  expect(p.focusedChild).toBe(replacement);
  expect(a.parent).toBeNull();
});
```

Also reject out-of-range/noninteger insertion, attachment of an already attached node, attachment of a root, self/ancestor attachment and root detachment before changing either side. Apply the same detached-node/cycle checks to `replace`; reject an absent old child before mutation. Snapshot children, parents, percentages and focus to prove failed operations are atomic. `detach` repairs a removed `focusedChild` to the first remaining child, or null. Test `descendFocused` on a leaf, nested selected children, an empty root, and a null/stale `focusedChild` (first-child fallback without mutation).

- [x] **Step 2: Run** `npm test -- test/unit/tree/node.test.ts`. Expect unresolved imports before implementation, then behavior failures as individual primitives are introduced.

- [x] **Step 3: Implement node operations.** Use the following attach/detach arithmetic after validation. `replace` swaps exactly one slot and reparents both nodes, without renormalizing percents. `focusChain` follows parents, assigning each parent's `focusedChild` to the child just visited. `rootOf` follows parents and requires the terminal node to be a root split. Traversal yields self before children; leaves filters that traversal. `descendFocused` follows a current `focusedChild`, otherwise the first child, until a leaf; an empty split returns null.

```ts
// attach, after validating a detached child and index in [0, children.length]:
const n = parent.children.length + 1;
parent.percents = parent.percents.map(p => p * (n - 1) / n);
parent.children.splice(index, 0, child);
parent.percents.splice(index, 0, 1 / n);
child.parent = parent;
parent.focusedChild ??= child;

// detach, after validating the parent and locating index:
parent.children.splice(index, 1);
parent.percents.splice(index, 1);
const total = parent.percents.reduce((sum, value) => sum + value, 0);
parent.percents = parent.percents.map(value => value / total);
if (parent.focusedChild === child)
  parent.focusedChild = parent.children[0] ?? null;
child.parent = null;
return parent;
```

For empty arrays the division map has no entries. Validate preexisting weights (matching length, finite, positive and sum within `1e-9` of one; empty splits have no weights) before editing either side. Normalization must not silently repair arbitrary corruption into a plausible layout.

- [x] **Step 4: Add test tooling without changing GNOME dependencies.** Install the exact versions below and commit the lockfile. These versions' published npm metadata was checked during preparation against local Node `22.23.1` and TypeScript `5.9.3`: fast-check requires Node ≥12.17; ESLint/TypeScript ESLint accept Node ≥21.1; TypeScript ESLint accepts ESLint 9 and TypeScript ≥4.8.4 <6.1. Respect `.npmrc`; do not use unversioned `latest` or update existing dependencies.

```sh
npm install --save-dev --save-exact fast-check@4.10.2 eslint@9.39.5 @eslint/js@9.39.5 typescript-eslint@8.70.1
```

This installation is an implementation step, not part of the preparation audit. Add `"lint:tree": "eslint src/tree test/unit/tree"`. Use this flat config:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {ignores: ['dist/**', 'node_modules/**']},
  {
    files: ['src/tree/**/*.ts', 'test/unit/tree/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {ecmaVersion: 2022, sourceType: 'module'},
    rules: {'@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}]},
  },
);
```

Remove unused imports from the test example as its final suite takes shape. Do not add global suppressions or lint unrelated shell adapters in this task.

- [x] **Step 5: Verify** `npm test && npm run typecheck && npm run check:layer0 && npm run lint:tree`, review and commit: `feat(tree): define containers and child-list operations`.

## Task 2: Workspace ownership, selection, membership and normalization

**Files:** create `src/tree/tree.ts`, `test/unit/tree/tree.test.ts`, `test/unit/tree/normalize.test.ts`.

**Consumes:** all Task 1 node types and primitives.

**Produces:** `Tree` with the following public contract. Methods that accept a con validate ownership; adding an already tracked window throws without mutating the tree. Unknown window removal is an idempotent no-op. Monitor roots and `WorkspaceCon`s keep their identities until explicitly removed by the future integration code.

```ts
export class Tree {
  readonly workspaces: Map<number, WorkspaceCon>;
  activeWorkspace: number;
  constructor(workspaceCount: number, monitors: readonly MonitorId[]);
  workspace(index: number): WorkspaceCon;
  root(workspace: number, monitor: MonitorId): SplitCon;
  allocateSplit: AllocateSplit;
  find(window: WindowId): LeafCon | null;
  owner(con: Con): WorkspaceCon;
  location(window: WindowId): {workspace: number; monitor: MonitorId | null; floating: boolean} | null;
  selection(workspace?: number): Selection;
  select(con: Con): void;
  selectFloating(window: WindowId): void;
  activateWorkspace(index: number): void;
  insert(window: WindowId, workspace: number, monitor: MonitorId): LeafCon;
  remove(window: WindowId): void;
  normalize(live?: ReadonlySet<WindowId>): void;
  check(live?: ReadonlySet<WindowId>): void;
}
```

`allocateSplit` is an arrow property so passing it to operations retains the Tree instance. It allocates ids, initializes arrays empty, `root` false by default, and `lastSplitLayout` to the selected split layout or `splith` for tabs/stacks. Only root creation sets `root: true`.

- [x] **Step 1: Write failing scenarios.** Start from literal expectations; no expected values computed with production layout/normalization.

```ts
it('inserts after a selected leaf and keeps inactive workspace focus local', () => {
  const t = new Tree(2, [0]);
  const a = t.insert(1, 0, 0);
  const b = t.insert(2, 0, 0);
  t.select(a);
  const c = t.insert(3, 0, 0);
  expect(t.root(0, 0).children).toEqual([a, c, b]);
  t.insert(4, 1, 0);
  expect(t.activeWorkspace).toBe(0);
  expect(t.selection()).toEqual({kind: 'tiled', con: c});
  expect(t.selection(1)).toEqual({kind: 'tiled', con: t.find(4)});
  t.check(new Set([1, 2, 3, 4]));
});
it('rejects duplicate ids without changing membership', () => {
  const t = new Tree(1, [0]);
  const a = t.insert(1, 0, 0);
  expect(() => t.insert(1, 0, 0)).toThrow();
  expect(t.root(0, 0).children).toEqual([a]);
  t.check(new Set([1]));
});
it('removes the last window but keeps its monitor root', () => {
  const t = new Tree(1, [0]);
  const root = t.root(0, 0);
  t.insert(1, 0, 0);
  t.remove(1);
  t.remove(1);
  expect(t.root(0, 0)).toBe(root);
  expect(root.children).toEqual([]);
  expect(root.percents).toEqual([]);
  t.check(new Set());
});
```

Normalize fixtures to cover exactly: `H(root) → V → H → leaf` flattens the middle V; `H(root) → V → leaf` preserves the V; `H(root) → tabbed → V → leaf` does not apply the split-only flatten rule. Record selected node references before normalization and assert repair when the selected wrapper disappears. A leaf absent from a supplied `live` set is removed; a live one is preserved. Removing an unselected leaf must preserve a surviving selected parent. Reject negative workspace/monitor ids, nonpositive window ids and noninteger ids. Rejected insertion must not consume a node id: compare the next valid insertion against the corresponding insertion in an identical control tree.

Use `new Tree(2, [0, 2])` for a deterministic ownership test: keep selection on monitor 0, insert into monitor 2 after that root's remembered focused leaf, and assert monitor 0's children are unchanged. Check duplicate window ids across monitors and workspaces, foreign-tree selections, and a detached node whose forged parent points at an owned root. This tests monitor ownership only; cross-monitor directional navigation remains Phase 4.

Standalone fixtures from Task 1 are for raw algorithms. For fixtures tested through a `Tree`, obtain leaf ids via that Tree's `insert` and splits via its `allocateSplit`, then wire the literal topology/percent/focus arrays directly. Keep its existing roots and reparent every child. Do not mix the standalone fixture counter with the Tree's allocator: later allocations could otherwise duplicate node ids. Initial leaf allocation uses a valid temporary tree; after wiring the literal fixture, do not normalize or move it before the test's action. Expected results remain literal.

- [x] **Step 2: Run** `npm test -- test/unit/tree/tree.test.ts test/unit/tree/normalize.test.ts`; observe missing behavior before adding it.

- [x] **Step 3: Implement ownership and selection.** The constructor creates 1–36 workspaces and at least one unique monitor root per workspace, in supplied monitor order. Roots start with layout and `lastSplitLayout` both `splith`. Initial `activeWorkspace` is zero and each workspace's `focusedCon` is its first root. Validate all constructor inputs before allocating nodes. A `Tree` owns one monotonic node-id counter. Membership queries traverse its roots and floating lists; a separate leaf registry is unnecessary at this scale. Ownership requires actual reachability through the tree's child arrays, not merely a parent pointer ending at an owned root. Use Task 1's `descendFocused`; do not import a not-yet-created Task 4 module.

```ts
// selection(index = this.activeWorkspace):
const ws = this.workspace(index);
return ws.focusedFloating !== null
  ? {kind: 'floating', window: ws.focusedFloating}
  : ws.focusedCon ? {kind: 'tiled', con: ws.focusedCon} : null;

// select(con), after owner validation:
const ws = this.owner(con);
ws.focusedCon = con;
ws.focusedFloating = null;
focusChain(con);
```

Selecting a con on an inactive workspace does not activate that workspace. `selectFloating` finds the workspace, moves the id to the front of its MRU list, sets `focusedFloating` and keeps `focusedCon` intact. `activateWorkspace` validates and changes only `activeWorkspace`.

For insertion, use the addressed monitor root. Use the workspace's selected tiled con only if it belongs to that root; otherwise use that root's focused descendant (or the empty root). A selected leaf inserts after itself; a selected split appends. Create the leaf only after validation, attach it and select it locally. This avoids inserting a window onto the wrong monitor when focus was elsewhere.

- [x] **Step 4: Implement removal and normalization.** Before detaching a selected leaf, retain its ancestor chain for focus repair. Removing the selected floating id chooses the next MRU id, or falls back to the retained tiled selection; removing an unselected floating id leaves selection unchanged. Normalize bottom-up, and iterate flattening until stable. Repair selection and all `focusedChild` pointers after each pass. The flatten predicate is exactly:

```ts
const only = con.children.length === 1 ? con.children[0] : undefined;
const splitOnly = (layout: Layout) => layout === 'splith' || layout === 'splitv';
const flatten = !con.root && con.parent !== null && splitOnly(con.layout)
  && only?.kind === 'split' && splitOnly(only.layout)
  && only.layout !== con.layout && only.layout === con.parent.layout;
```

Empty non-root splits are detached; roots remain. To flatten, detach `only` from `con`, then replace `con` with `only` in the grandparent so the grandparent's percent slot is preserved. If selection was `con`, redirect it to `only`. When a selection's container was deleted completely, choose the focused descendant of the nearest surviving ancestor; an empty root itself is a valid selection. Capture fallback ancestors before detaching or deleting nodes, since parent pointers are cleared by those operations. Preserve any surviving selected parent as a parent, rather than descending it to a leaf. For `normalize(live)`, remove dead tiled and floating ids before structural cleanup, without recursively calling the public `remove` method. Repeated normalization is idempotent, including selections and percentages.

- [x] **Step 5: Implement `check`.** Walk with `Set<Con>`, `Set<NodeId>` and `Set<WindowId>`, checking a node before descending so corrupt cycles throw instead of recursing forever. Throw on cycles/shared children, duplicate or invalid node/window ids, bad parent links, a root under another con, an unflagged/parented monitor root, invalid root layout or `lastSplitLayout`, an empty non-root split, a remaining flatten opportunity, nonfinite/nonpositive weights, length mismatch, or sum error above `1e-9`. Empty roots have empty weights and null focus; every nonempty split's `focusedChild` must be a current child. Every selected con must belong to its workspace; floating ids must be unique and disjoint from leaves; selected floating ids must be members. The active workspace must exist. If supplied, `live` must contain every tracked window. Include node ids in errors. Add deliberately corrupted fixtures for each invariant class, and assert `check` never repairs them.

- [x] **Step 6: Verify the whole suite and static checks; review and commit:** `feat(tree): own workspace trees and repair structural invariants`.

## Task 3: Exact rectangles and tab/stack ordering

**Files:** create `src/tree/layout.ts`, `test/unit/tree/layout.test.ts`.

**Consumes:** `Con`, `Rect`, `WindowId`, `walk`, `leaves`.

**Produces:**

```ts
export interface LayoutResult {
  windows: Map<WindowId, Rect>;
  containers: Map<Con, Rect>;
}
export function layoutWithRects(con: Con, rect: Rect): LayoutResult;
export function layout(con: Con, rect: Rect): Map<WindowId, Rect>;
export function stackingOrder(con: Con): WindowId[]; // bottom to top
```

`layout` is the spec's Map-returning entry point; `layoutWithRects` additionally supplies ancestor rectangles for resize and later decorations. No node mutation occurs in either function.

- [x] **Step 1: Write exact-rect tests.** Use an offset, odd width and a vertical subdivision:

```ts
it('tiles odd dimensions with the last child absorbing rounding', () => {
  const root = split('splith', [leaf(1), split('splitv', [leaf(2), leaf(3)])], true);
  const rects = layout(root, {x: 7, y: 31, width: 1919, height: 1049});
  expect([...rects]).toEqual([
    [1, {x: 7, y: 31, width: 960, height: 1049}],
    [2, {x: 967, y: 31, width: 959, height: 525}],
    [3, {x: 967, y: 556, width: 959, height: 524}],
  ]);
});
it.each(['tabbed', 'stacked'] as const)('%s gives every child the same rectangle', kind => {
  const con = split(kind, [leaf(1), leaf(2)]);
  const rect = {x: -100, y: 0, width: 800, height: 600};
  expect([...layout(con, rect).values()]).toEqual([rect, rect]);
  expect(stackingOrder(con)).toEqual([1, 2]);
  con.focusedChild = con.children[0];
  expect(stackingOrder(con)).toEqual([2, 1]);
});
```

Add zero-sized work area, 1-pixel width with four children, empty root and nonuniform percentages. Rectangles with negative width/height, fractional components or nonfinite components are invalid; negative x/y are valid for monitors left/above primary. Verify input nodes and input rect are unchanged.

- [x] **Step 2: Run** `npm test -- test/unit/tree/layout.test.ts` and observe failure.

- [x] **Step 3: Implement recursive layout.** Record every node's rectangle in `containers`. A leaf adds its window to `windows`. Tabs/stacks recurse into each child with an independent copy of the same rect. For splits, round each requested size and clamp it to the remaining space; the last child takes all remaining space. Clamping prevents earlier rounding from producing a negative final rectangle in tiny work areas.

```ts
let cursor = horizontal ? rect.x : rect.y;
let remaining = horizontal ? rect.width : rect.height;
const extent = remaining;
con.children.forEach((child, i) => {
  const size = i === con.children.length - 1
    ? remaining : Math.min(remaining, Math.max(0, Math.round(extent * con.percents[i])));
  const childRect = horizontal
    ? {x: cursor, y: rect.y, width: size, height: rect.height}
    : {x: rect.x, y: cursor, width: rect.width, height: size};
  visit(child, childRect);
  cursor += size;
  remaining -= size;
});
```

`visit` is a private recursive closure inside `layoutWithRects`. Zero-sized tiles are allowed by the mathematical model; client minimum sizes are handled in Phase 2B. For stacking order, recurse over ordinary split children in order. At each tabbed/stacked container, recurse over all inactive children first and its focused child last; raise the entire active subtree, not just one leaf.

- [x] **Step 4: Verify whole suite/static checks, review and commit:** `feat(tree): calculate exact layouts and active-subtree stacking`.

## Task 4: Directional and structural focus

**Files:** create `src/tree/focus.ts`, `test/unit/tree/focus.test.ts`; add focused facade methods to `tree.ts`.

**Consumes:** orientation helpers, `descendFocused` from `node.ts`, parent links, `focusedChild`, Tree selection.

**Produces:**

```ts
export type Wrapping = 'yes' | 'no' | 'force' | 'workspace';
export function descendDirection(con: Con, direction: Direction): LeafCon | null;
export function nextFocus(con: Con, direction: Direction, wrapping: Wrapping): LeafCon | null;
// Tree additions:
focus(direction: Direction, wrapping: Wrapping): LeafCon | null;
focusParent(): Con | null;
focusChild(): Con | null;
```

Returned null from `focus` means no focus change. `focusParent`/`focusChild` select only a structural target; they perform no window activation. All three methods are no-ops when the active selection is floating; `focusModeToggle` is Task 7.

- [x] **Step 1: Write scenarios.** Cover every direction and wrap setting with horizontal/vertical fixtures, nested tabbed/stacked containers, a selected parent and an empty root.

```ts
it('searches higher matching ancestors before wrapping locally', () => {
  const a = leaf(1), b = leaf(2), c = leaf(3);
  const inner = split('splith', [a, b]);
  split('splith', [inner, c], true);
  expect(nextFocus(b, 'right', 'yes')).toBe(c);
  expect(nextFocus(b, 'right', 'force')).toBe(a);
  expect(nextFocus(c, 'right', 'yes')).toBe(b); // inner's focused child
  expect(nextFocus(c, 'right', 'no')).toBeNull();
  expect(nextFocus(c, 'right', 'workspace')).toBe(b);
});
it('workspace wrapping never falls back to a non-root split', () => {
  const a = leaf(1), b = leaf(2);
  const inner = split('splith', [a, b]);
  split('splitv', [inner], true);
  expect(nextFocus(b, 'right', 'workspace')).toBeNull();
  expect(nextFocus(b, 'right', 'yes')).toBe(a);
});
```

The `descendDirection` cases differ from `descendFocused`: entering a matching horizontal subtree from the left chooses its left edge even if its focused child is on the right. They are used by move, not directional focus's sibling descent.

- [x] **Step 2: Run** `npm test -- test/unit/tree/focus.test.ts` and observe failure.

- [x] **Step 3: Implement the spec's ancestor search.** The following is the complete recursion; return the candidate instead of activating anything:

```ts
export function nextFocus(con: Con, dir: Direction, wrapping: Wrapping): LeafCon | null {
  const parent = con.parent;
  if (!parent) return null;
  if (axis(parent.layout) !== directionAxis(dir))
    return nextFocus(parent, dir, wrapping);
  const step = isForward(dir) ? 1 : -1;
  const sibling = parent.children[parent.children.indexOf(con) + step];
  if (sibling) return descendFocused(sibling);
  if (wrapping !== 'force') {
    const higher = nextFocus(parent, dir, wrapping);
    if (higher) return higher;
    if (wrapping === 'no' || (wrapping === 'workspace' && !parent.root))
      return null;
  }
  const edge = parent.children[isForward(dir) ? 0 : parent.children.length - 1];
  return !edge || edge === con ? null : descendFocused(edge);
}
```

Reuse Task 1's `descendFocused`. `descendDirection` chooses the edge against travel when orientation matches; otherwise follows a current focused child or the first child. Empty splits return null. `Tree.focus` calls `nextFocus` on its tiled selection, then `select` if non-null. Parent selection stops at the monitor root. Child selection uses `focusedChild` without descending all the way to a leaf.

- [x] **Step 4: Verify whole suite/static checks, review and commit:** `feat(tree): navigate containers with i3 focus wrapping`.

## Task 5: Split, layout and directional movement

**Files:** create `src/tree/operations.ts`, `test/unit/tree/operations.test.ts`, `test/unit/tree/move.test.ts`; add facade methods to `tree.ts`.

**Consumes:** allocation callback, attach/detach/replace, orientation and directional descent.

**Produces:**

```ts
export function splitCon(con: Con, orientation: 'h' | 'v' | 'toggle', allocate: AllocateSplit): Con;
export function setLayout(con: Con, layout: Layout, allocate: AllocateSplit): Con;
export function toggleLayout(con: Con, cycle: 'split' | 'all' | readonly Layout[], allocate: AllocateSplit): Con;
export function moveCon(con: Con, direction: Direction): boolean;
// Tree additions: select returned targets, normalize, and repair focus after edits.
split(orientation: 'h' | 'v' | 'toggle'): void;
setLayout(layout: Layout): void;
toggleLayout(cycle: 'split' | 'all' | readonly Layout[]): void;
move(direction: Direction): boolean;
```

On floating selection all four are no-ops. Empty-root tabbed/stacked layout is a no-op: creating a childless wrapper would violate normalization. For `split toggle` on the root, use the opposite of the root's own orientation. These are boundary completions of §7.4–7.5, not new layout modes.

- [x] **Step 1: Write split/layout scenarios.** Verify no needless wrapper for a leaf whose split parent has one child; preserve a wrapper when the parent has siblings; root with multiple children wraps them; tab/stack on a lone leaf preserves a legal split-only root; `lastSplitLayout` is preserved through tabs and stacks; explicit toggle lists cycle and choose their first entry when current layout is absent. Reject an empty toggle list before mutation.

```ts
it('keeps the pending vertical split for the next insertion', () => {
  const t = new Tree(1, [0]);
  t.insert(1, 0, 0);
  const b = t.insert(2, 0, 0);
  t.split('v');
  expect(b.parent?.layout).toBe('splitv');
  expect(b.parent?.children).toEqual([b]);
  t.insert(3, 0, 0);
  expect(shape(t.root(0, 0))).toEqual(['splith', [1, ['splitv', [2, 3]]]]);
  t.check(new Set([1, 2, 3]));
});
it('toggles from tabbed back to the last split orientation', () => {
  const t = new Tree(1, [0]);
  t.insert(1, 0, 0);
  t.split('v');
  t.setLayout('tabbed');
  t.toggleLayout('split');
  expect(t.find(1)?.parent?.layout).toBe('splitv');
});
```

- [x] **Step 2: Write all four §7.7 worked examples, plus moving a selected SplitCon.** Build literal trees with `helpers` and exercise `moveCon`; normalize via the Tree facade in additional integration-of-core cases. Expected shapes:

```ts
const examples = [
  // Outer arrays describe roots; the helper assigns all parent/focus links.
  {before: ['splith', [1, ['splitv', [2, 3]]]], window: 3, dir: 'left',
   after: ['splith', [1, 3, ['splitv', [2]]]]},
  {before: ['splith', [1, ['splith', [3, 4]]]], window: 1, dir: 'right',
   after: ['splith', [['splith', [1, 3, 4]]]]},
  {before: ['splith', [['splitv', [1, ['splith', [4, 2]]]], 3]], window: 2, dir: 'right',
   after: ['splith', [['splitv', [1, ['splith', [4]]]], 2, 3]]},
  {before: ['splitv', [['splith', [1, 2]]]], window: 2, dir: 'right',
   after: ['splitv', [['splith', [1, 2]]]]},
] as const;
```

Use `fromShape` and `findLeaf` from Task 1 for these tests. They are literal fixtures, not an alternative implementation of movement. Add a swap with weights `[0.7, 0.3]` and verify they remain `[0.7, 0.3]` after child order changes. Invalid/no-op movement must not change selection or percentages.

- [x] **Step 3: Run the new tests and observe failures.**

- [x] **Step 4: Implement split and layout.** Wrapping replaces the selected con in its parent's existing slot, then attaches the old con to the new wrapper with percent one. If a root's children are wrapped together, transfer its children/percents/focusedChild wholesale to a new split, repoint every child's parent, and leave the root with one child at percent one. Do not repeatedly attach transferred children and destroy their relative percentages.

```ts
// Core of wrapping all children, with wrapper already allocated:
wrapper.children = [...root.children];
wrapper.percents = [...root.percents];
wrapper.focusedChild = root.focusedChild;
for (const child of wrapper.children) child.parent = wrapper;
root.children = [wrapper];
root.percents = [1];
root.focusedChild = wrapper;
wrapper.parent = root;
```

When tab/stack wrapping, initialize wrapper.lastSplitLayout from the root's current split orientation. `splitCon` returns the originally selected con, including roots with zero or one child; when splitting a root with multiple children, return the new wrapper so subsequent insertion lands inside it. `setLayout` returns the prior selected leaf or split, except an explicitly selected root wrapped for tabs/stacks returns its new wrapper. All layout setters update `lastSplitLayout` only for splith/splitv.

- [x] **Step 5: Implement movement from the spec.** Find the nearest matching ancestor starting at `con.parent`. If that is the immediate parent and a sibling exists, swap with a leaf sibling in place; for a split sibling, descend against travel and insert before/after its target leaf using §7.7. If there is no sibling, stop at a root or find the next matching ancestor above the exhausted parent. Otherwise insert next to the branch directly under the matching ancestor. Decide the target before detaching; only normalize after reinsertion.

```ts
function matching(start: SplitCon | null, wanted: Axis): SplitCon | null {
  for (let p = start; p; p = p.parent)
    if (axis(p.layout) === wanted) return p;
  return null;
}
// In the sibling-is-split path:
const target = descendDirection(sibling, direction);
if (!target || !target.parent) return false;
const parent = target.parent;
const after = axis(parent.layout) !== directionAxis(direction) || !isForward(direction);
detach(con);
attach(parent, con, parent.children.indexOf(target) + (after ? 1 : 0));
```

For upward traversal, walk from `con` until its parent is the matching ancestor; this gives `above`. Insert before `above` for left/up and after for right/down. A selected root does not move directionally. Facades retain/select the operation's target before normalization; normalization then owns any replacement of a deleted wrapper and repairs the focus chain. Never restore the old reference after normalization has replaced it. Add a move where normalization removes the selected wrapper, and assert that the surviving replacement is selected.

- [x] **Step 6: Verify whole suite/static checks, review and commit:** `feat(tree): split layouts and move nested containers`.

## Task 6: Transactional tiled resize

**Files:** create `src/tree/resize.ts`, `test/unit/tree/resize.test.ts`; add a facade to `tree.ts`.

**Consumes:** selected con, ancestor rectangles from `layoutWithRects`, parsed resize command.

**Produces:**

```ts
export interface ResizeRequest {
  action: 'grow' | 'shrink'; dimension: 'width' | 'height'; px: number; ppt: number | null;
}
export function resizeCon(con: Con, request: ResizeRequest, rectangles: ReadonlyMap<Con, Rect>): boolean;
// Tree addition:
resize(request: ResizeRequest, rectangles: ReadonlyMap<Con, Rect>): boolean;
```

Returns false on unsupported/no-op input; otherwise commits all new percents together. Floating pixel resize is in Phase 2B and must never be routed through this function.

- [x] **Step 1: Write failures for known rectangles and no-op boundaries.**

```ts
it('uses the matching ancestor width for pixels', () => {
  const a = leaf(1), b = leaf(2);
  const inner = split('splith', [a, b]);
  const root = split('splith', [leaf(3), inner], true);
  const {containers} = layoutWithRects(root, {x: 0, y: 0, width: 1000, height: 600});
  expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 50, ppt: null}, containers)).toBe(true);
  expect(inner.percents[0]).toBeCloseTo(0.6);
  expect(inner.percents[1]).toBeCloseTo(0.4);
  expect(root.percents).toEqual([0.5, 0.5]);
});
it('rejects a request atomically when any sibling crosses the clamp', () => {
  const a = leaf(1), b = leaf(2), c = leaf(3);
  const root = split('splith', [a, b, c], true);
  root.percents = [0.85, 0.1, 0.05];
  const {containers} = layoutWithRects(root, {x: 0, y: 0, width: 1000, height: 600});
  expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 10, ppt: 10}, containers)).toBe(false);
  expect(root.percents).toEqual([0.85, 0.1, 0.05]);
});
```

Also test shrink, height, selected parent resize, ppt preference over px, one-child matching ancestor, nonfinite/negative effective amounts and exactly 5%/95% bounds. Pixel requests with missing rectangles or zero extent return false. Percentage requests work without rectangles and with zero-sized work areas: the spec's ppt arithmetic does not depend on pixel geometry. When ppt is present, px is unused. Per the binding spec, a nearest matching ancestor with one child is a no-op; do not silently skip it for a higher ancestor.

```ts
it('resizes in percentage points without pixel geometry', () => {
  const a = leaf(1), b = leaf(2);
  const root = split('splith', [a, b], true);
  expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 50000, ppt: 10}, new Map()))
    .toBe(true);
  expect(root.percents[0]).toBeCloseTo(0.6);
  expect(root.percents[1]).toBeCloseTo(0.4);
});
```

- [x] **Step 2: Run** `npm test -- test/unit/tree/resize.test.ts` and observe failure.

- [x] **Step 3: Implement candidate-first arithmetic.** Walk ancestors starting at the parent, remembering the child branch at each step. Select the first matching orientation. Tabs count horizontal and stacks vertical, as specified. No matching ancestor or one child returns false. Resolve the effective amount before constructing candidates; validate only the unit being used.

```ts
let amount: number;
if (request.ppt !== null) {
  amount = request.ppt / 100;
} else {
  const rect = rectangles.get(ancestor);
  if (!rect) return false;
  const extent = request.dimension === 'width' ? rect.width : rect.height;
  if (!Number.isFinite(extent) || extent <= 0) return false;
  amount = request.px / extent;
}
if (!Number.isFinite(amount) || amount < 0) return false;
const delta = request.action === 'grow' ? amount : -amount;
const next = ancestor.percents.map((p, i) =>
  p + (i === selectedIndex ? delta : -delta / (ancestor.children.length - 1)));
if (next.some(p => !Number.isFinite(p) || p < 0.05 - 1e-12 || p > 0.95 + 1e-12))
  return false;
if (delta === 0) return false;
ancestor.percents = next;
return true;
```

Floating-point tolerance prevents rejection of an exact mathematical boundary due to binary rounding; assertions use closeness. Do not independently clamp each sibling, which would change the total. `Tree.resize` delegates only for its active tiled selection and keeps selection unchanged.

- [x] **Step 4: Verify whole suite/static checks, review and commit:** `feat(tree): resize split shares with atomic bounds checks`.

## Task 7: Floating membership and container transfer between workspaces

**Files:** extend `tree.ts`; create `test/unit/tree/membership.test.ts`.

**Consumes:** ownership, selection, structural primitives and normalization.

**Produces Tree methods:**

```ts
addFloating(window: WindowId, workspace: number): void;
setFloating(window: WindowId, enabled: boolean, monitor: MonitorId): void;
focusModeToggle(): WindowId | null;
moveToWorkspace(target: number, monitor: MonitorId): WindowId[];
```

`moveToWorkspace` moves the active selection, returns all affected window ids in traversal order, and leaves `activeWorkspace` unchanged. It does not call a window adapter. All leaves of a selected container move, including when a nonempty monitor root is selected (§7.6 and §9). Because monitor roots cannot be detached, move a selected root's contents in an equivalent non-root split, keeping the source root's identity. Existing descendant nodes, layout, shares and focused child survive, subject to normal §7.2 flattening at the destination. Validate target workspace/monitor before allocating or detaching anything. A same-workspace target or an empty selected root is a no-op.

- [x] **Step 1: Write tiled/floating round-trip and MRU scenarios.**

```ts
it('returns focus to the remembered tiled container from floating', () => {
  const t = new Tree(1, [0]);
  const a = t.insert(1, 0, 0);
  t.addFloating(2, 0);
  t.addFloating(3, 0);
  t.select(a);
  expect(t.focusModeToggle()).toBe(3);
  expect(t.selection()).toEqual({kind: 'floating', window: 3});
  expect(t.focusModeToggle()).toBe(1);
  expect(t.selection()).toEqual({kind: 'tiled', con: a});
  t.check(new Set([1, 2, 3]));
});
it('moves a selected subtree intact without following it', () => {
  const t = new Tree(2, [0]);
  t.insert(1, 0, 0);
  t.insert(2, 0, 0);
  t.split('v');
  t.insert(3, 0, 0);
  const selected = t.find(3)!.parent!;
  t.select(selected);
  expect(t.moveToWorkspace(1, 0)).toEqual([2, 3]);
  expect(t.activeWorkspace).toBe(0);
  expect(t.root(1, 0).children).toEqual([selected]);
  expect(shape(t.root(0, 0))).toEqual(['splith', [1]]);
  expect(t.selection()).toEqual({kind: 'tiled', con: t.find(1)});
  t.check(new Set([1, 2, 3]));
});
it('moves every leaf of a selected root while retaining the source root', () => {
  const t = new Tree(2, [0]);
  const a = t.insert(1, 0, 0), b = t.insert(2, 0, 0);
  const source = t.root(0, 0);
  source.percents = [0.7, 0.3];
  t.select(source);
  expect(t.moveToWorkspace(1, 0)).toEqual([1, 2]);
  expect(t.root(0, 0)).toBe(source);
  expect(source.children).toEqual([]);
  const transferred = t.root(1, 0).children[0];
  expect(transferred.kind).toBe('split');
  if (transferred.kind !== 'split') throw new Error('expected transferred split');
  expect(transferred.root).toBe(false);
  expect(transferred.children).toEqual([a, b]);
  expect(transferred.percents).toEqual([0.7, 0.3]);
  expect(transferred.focusedChild).toBe(b);
  expect(t.selection()).toEqual({kind: 'tiled', con: source});
  expect(t.activeWorkspace).toBe(0);
  t.check(new Set([1, 2]));
});
```

Add floating → tiled → floating sequences, repeated enable/disable no-ops, selected versus unselected floating removal, duplicate ids across tiled/floating membership, an unknown id transition, a workspace containing only floating windows, an empty workspace mode toggle, invalid destination rollback and transfer into a target whose selected leaf has siblings. Confirm target insertion is after that selected leaf, not always at root end. Include a transfer whose former parent is emptied and removed, proving source selection reaches the nearest surviving ancestor's focused descendant. Check that removal/transfer repairs a retained tiled selection even while floating selection is active.

- [x] **Step 2: Run the membership tests and observe failure.**

- [x] **Step 3: Implement transitions.** `addFloating` validates globally unique membership, records the id and selects it. `setFloating` rejects an invalid or untracked id before mutation; repeated requests for the current state return without allocating nodes or reordering windows. `setFloating(true)` detaches the leaf, normalizes its old parent, adds the id to that workspace's floating list and selects it. Keep the source workspace's repaired tiled selection; the monitor argument is unused for enabling floating. `setFloating(false)` validates the destination monitor before removing the floating id, then calls tiled insertion, preserving source workspace ownership.

```ts
// MRU update used when a floating window receives focus:
ws.floating = [window, ...ws.floating.filter(id => id !== window)];
ws.focusedFloating = window;
// focusModeToggle, tiled -> floating:
const target = ws.floating[0];
if (target === undefined) return null;
this.selectFloating(target);
return target;
// floating -> tiled:
const tiled = ws.focusedCon ? descendFocused(ws.focusedCon) : null;
if (!tiled) return null; // leave floating selection unchanged
this.select(tiled);
return tiled.window;
```

For a tiled transfer, capture leaf ids and the source fallback ancestor chain first. For a non-root selection, detach that con. For a nonempty root selection, allocate a non-root split with the root's layout and `lastSplitLayout`; transfer its children/percents/focusedChild wholesale and reparent those children, then clear the source root's arrays and focused child. This is the same content-preserving transfer technique used in Task 5; do not reinsert children one by one. Repair source selection using the nearest surviving former ancestor (the source root itself for a root-content move). Insert the moved con into the addressed target root using the same target-selection rule as insertion, select it locally before normalization, then normalize and repair both workspaces. If flattening replaces the transferred wrapper, retain normalization's replacement selection. For floating transfer, remove from source MRU, repair source selection, and add/select it in target MRU. Returning ids lets Phase 2B set expected workspaces before issuing real window moves.

- [x] **Step 4: Verify whole suite/static checks, review and commit:** `feat(tree): track floating focus and transfer containers between workspaces`.

## Task 8: Property tests, independent geometry assertions and delivery contract

**Files:** create `test/unit/tree/properties.test.ts`; update the plan's execution record and `PROJECT.md` only after verification.

**Consumes:** all pure tree APIs above. No shell imports or real display required.

- [x] **Step 1: Add an independent recursive geometry checker.** Check the reported rectangles from `layoutWithRects`, not a second call to `layout`. For each split's direct children, assert shared cross-axis bounds, contiguous positions, integer/nonnegative sizes and exact terminal edge. For tab/stack direct children, assert rectangle equality. Recursively repeat within children. Empty roots are exempt from coverage because they contain no windows.

```ts
function checkGeometry(con: Con, rects: ReadonlyMap<Con, Rect>): void {
  const rect = rects.get(con)!;
  for (const value of Object.values(rect)) expect(Number.isInteger(value)).toBe(true);
  expect(rect.width).toBeGreaterThanOrEqual(0);
  expect(rect.height).toBeGreaterThanOrEqual(0);
  if (con.kind === 'leaf' || con.children.length === 0) return;
  if (con.layout === 'tabbed' || con.layout === 'stacked') {
    for (const child of con.children) expect(rects.get(child)).toEqual(rect);
  } else {
    const horizontal = con.layout === 'splith';
    let edge = horizontal ? rect.x : rect.y;
    for (const child of con.children) {
      const r = rects.get(child)!;
      expect(horizontal ? r.x : r.y).toBe(edge);
      expect(horizontal ? [r.y, r.height] : [r.x, r.width])
        .toEqual(horizontal ? [rect.y, rect.height] : [rect.x, rect.width]);
      edge += horizontal ? r.width : r.height;
    }
    expect(edge).toBe(horizontal ? rect.x + rect.width : rect.y + rect.height);
  }
  for (const child of con.children) checkGeometry(child, rects);
}
```

Keep this helper in the property-test file; it uses no production orientation or partition helpers, so a shared axis bug cannot make actual and expected agree.

- [x] **Step 2: Generate bounded operation sequences and independent membership expectations.** Use ids 1–12 and two workspaces. Record a plain `Map<WindowId, number>` outside the Tree as the membership model. Choose existing ids through an index into that map; a new id comes from its complement. Inserts/removals update both; moves update the ids returned by `moveToWorkspace` after asserting they exactly match the selected subtree's pre-move leaf ids. Do not use `Tree.find` as the only oracle for whether a window should exist.

```ts
const kinds = ['insert', 'remove', 'select', 'split', 'layout', 'toggleLayout', 'focus',
  'parent', 'child', 'move', 'resize', 'floating', 'modeToggle', 'workspace', 'transfer'] as const;
const operation = fc.record({
  kind: fc.constantFrom(...kinds),
  pick: fc.nat(11), workspace: fc.integer({min: 0, max: 1}),
  direction: fc.constantFrom<Direction>('left', 'right', 'up', 'down'),
  orientation: fc.constantFrom<'h' | 'v' | 'toggle'>('h', 'v', 'toggle'),
  layout: fc.constantFrom<Layout>('splith', 'splitv', 'tabbed', 'stacked'),
  wrapping: fc.constantFrom<Wrapping>('yes', 'no', 'force', 'workspace'),
  amount: fc.constantFrom(1, 5, 10, 50),
  grow: fc.boolean(), width: fc.boolean(), pixels: fc.boolean(),
});
```

Import `Direction`, `Layout` from `src/commands/model`, `Wrapping` from `src/tree/focus`, and tree/node/layout symbols normally. The dispatcher is local to this test file:

```ts
interface GeneratedOperation {
  kind: typeof kinds[number]; pick: number; workspace: number;
  direction: Direction; orientation: 'h' | 'v' | 'toggle'; layout: Layout;
  wrapping: Wrapping; amount: number; grow: boolean; width: boolean; pixels: boolean;
}
function applyGeneratedOperation(
  tree: Tree, expected: Map<WindowId, number>, op: GeneratedOperation, area: Rect,
): void {
  const ids = [...expected.keys()].sort((a, b) => a - b);
  const id = ids.length ? ids[op.pick % ids.length] : undefined;
  switch (op.kind) {
    case 'insert': {
      const free = Array.from({length: 12}, (_, i) => i + 1).find(candidate => !expected.has(candidate));
      if (free !== undefined) {
        tree.insert(free, op.workspace, 0);
        expected.set(free, op.workspace);
      }
      return;
    }
    case 'remove':
      if (id !== undefined) { tree.remove(id); expected.delete(id); }
      return;
    case 'select':
      if (id !== undefined) {
        tree.activateWorkspace(expected.get(id)!);
        const con = tree.find(id);
        if (con) tree.select(con); else tree.selectFloating(id);
      }
      return;
    case 'split': tree.split(op.orientation); return;
    case 'layout': tree.setLayout(op.layout); return;
    case 'toggleLayout': tree.toggleLayout(op.grow ? 'all' : 'split'); return;
    case 'focus': tree.focus(op.direction, op.wrapping); return;
    case 'parent': tree.focusParent(); return;
    case 'child': tree.focusChild(); return;
    case 'move': tree.move(op.direction); return;
    case 'resize': {
      const rects = new Map<Con, Rect>();
      for (const root of tree.workspace(tree.activeWorkspace).monitors.values())
        for (const [con, rect] of layoutWithRects(root, area).containers) rects.set(con, rect);
      tree.resize({action: op.grow ? 'grow' : 'shrink', dimension: op.width ? 'width' : 'height',
        px: op.amount, ppt: op.pixels ? null : op.amount}, rects);
      return;
    }
    case 'floating':
      if (id !== undefined) tree.setFloating(id, !tree.location(id)!.floating, 0);
      return;
    case 'modeToggle': tree.focusModeToggle(); return;
    case 'workspace': tree.activateWorkspace(op.workspace); return;
    case 'transfer': {
      const selection = tree.selection();
      const candidates = selection?.kind === 'floating' ? [selection.window]
        : selection?.kind === 'tiled' ? [...leaves(selection.con)].map(con => con.window) : [];
      const want = op.workspace === tree.activeWorkspace ? [] : candidates;
      const moved = tree.moveToWorkspace(op.workspace, 0);
      expect(moved).toEqual(want);
      for (const movedId of moved) expected.set(movedId, op.workspace);
      return;
    }
    default: {
      const unhandled: never = op.kind;
      throw new Error(`unhandled generated operation: ${unhandled}`);
    }
  }
}
```

Empty candidate sets make an operation a no-op, not a discarded property run. Throws from supposedly valid operations must fail the property.

- [x] **Step 3: Add the property runner with fixed seeds and replay support.**

```ts
it('preserves membership, focus and exact local coverage through operation sequences', () => {
  fc.assert(fc.property(
    fc.array(operation, {minLength: 1, maxLength: 100}),
    fc.constantFrom(1, 17, 1919, 1920), fc.constantFrom(1, 19, 1049, 1080),
    (operations, width, height) => {
      const tree = new Tree(2, [0]);
      const expected = new Map<WindowId, number>();
      for (const op of operations) {
        applyGeneratedOperation(tree, expected, op, {x: -13, y: 27, width, height});
        const live = new Set(expected.keys());
        // Facades must leave a normalized tree; do not repair defects in the test.
        tree.check(live);
        const actual = new Map<WindowId, number>();
        for (const ws of tree.workspaces.values()) {
          for (const root of ws.monitors.values()) {
            const result = layoutWithRects(root, {x: -13, y: 27, width, height});
            checkGeometry(root, result.containers);
            for (const id of result.windows.keys()) {
              expect(actual.has(id)).toBe(false);
              actual.set(id, ws.index);
            }
          }
          for (const id of ws.floating) {
            expect(actual.has(id)).toBe(false);
            actual.set(id, ws.index);
          }
        }
        expect([...actual].sort((a, b) => a[0] - b[0]))
          .toEqual([...expected].sort((a, b) => a[0] - b[0]));
      }
    },
  ), {numRuns: 300, seed: 20260921, verbose: true});
});
```

The dispatcher in Step 2 is the only source of expected membership changes. Comparing against the independent map catches loss even when `Tree.check()` still finds the reduced tree structurally valid. The facades perform their own normalization after structural edits; the runner checks their postconditions directly. Explicit normalization and its idempotence are tested in Task 2.

- [x] **Step 4: Run the property suite and turn every discovered semantic failure into a minimal deterministic scenario before fixing it.** Record fast-check seed and shrink path in the scenario's comment. Run both the fixed seed above and one additional fixed seed `8675309` before delivery. Keep the normal suite bounded; longer stress runs are on demand.

- [x] **Step 5: Verify once on the final code.** Run `npm test`, `npm run typecheck`, `npm run check:layer0`, `npm run lint:tree`, and a release build. Inspect the diff for accidental changes to `src/shell`, `src/engine.ts`, live config or installation. This subsystem does not need the nested shell; if integration is nevertheless run, finish with a release `make install` as required by PROJECT.md.

- [x] **Step 6: Review and commit:** `test(tree): exercise invariants across generated command sequences`. Update the execution record with test counts, any rulings, public signatures as actually implemented and the exact remaining Phase 2B scope. Do not mark A8–A14 passed or say that live tiling/resizing works yet.

## Self-review and handoff

- Node ownership and selection remain pure; no new GNOME dependency reaches Layer 0.
- All §7 pure operations have a task and scenario coverage. Native fullscreen, floating frame resize/position and application/window lifecycle actions are explicitly assigned to Phase 2B.
- The property checker tests direct split children for coverage and tab/stack children for equality.
- The existing failed-restore and config-cache tests remain part of the baseline.
- Shell-related carry-forward items remain visible and are not silently declared complete.
- The implementation method remains the documented subagent-driven workflow: one implementer and reviewer per task, then a whole-branch review. The user released the preparation pause; all eight task reviews and the whole-branch review passed.

## Preparation audit — 2026-09-21

- [x] Read the binding spec, Phase 1 carry-forward and the full Phase 2A plan; check public signatures against the existing command types.
- [x] Fix task ordering for `descendFocused`, the module dependency map, and declaration syntax in the interface examples.
- [x] Align selected-root workspace transfers and geometry-independent ppt resize with the binding command semantics; add regression scenarios.
- [x] Specify ownership validation, atomic failure, stale focus, normalization replacement/idempotence and floating membership edge cases.
- [x] Add deterministic ownership tests across two monitors, layout-toggle generation, and property checks that cannot mask missing facade normalization.
- [x] Resolve exact tooling versions against published engines/peer dependencies; installation remains Task 1 work.
- [x] Re-run the unchanged baseline: 64/64 unit tests, both TypeScript programs and `check:layer0` passed. Documentation diff passes `git diff --check`. No nested-shell run was needed for this preparation-only change.
- [x] The user resumed Phase 2A after this preparation audit. All eight tasks, delivery verification and the whole-branch review are complete; merged into `main` on 2026-09-22.

## Execution record — 2026-09-21

The user resumed the plan on branch `phase-2` in the existing checkout. The implementation base was `8291d64`; no remote, push, nested-shell run or installation was requested. Tasks 1–7 were implemented, verified, task-reviewed and committed before Task 8 began. Task 8 was committed in `cd27f31` and `8ad4552` and reviewed clean. The whole-branch review approved `8291d64..8ad4552` with no findings. Integration into `main` completed on 2026-09-22; see the merge record below.

### Reviewed task history

| Task | Commit | Verified suite at task boundary | Review outcome |
|---|---|---:|---|
| 1 — nodes and tooling | `11b2a5e` | 84 tests | Clean after fix round 1 corrected `axis('stacked')` to vertical and added focused RED/GREEN evidence |
| 2 — ownership and normalization | `8e6a477` | 140 tests | Approved with one diagnostic-context minor deferred to Task 4 |
| 3 — layout and stacking | `71355db` | 154 tests | Clean |
| 4 — navigation | `3062b86` | 174 tests | Clean; resolved Task 2's deferred diagnostic minor |
| 5 — split/layout/move | `276c25a` | 199 tests | Clean; self-review first corrected root-wrapper `lastSplitLayout` with RED/GREEN coverage |
| 6 — resize | `8d451c5` | 218 tests | Clean |
| 7 — floating and workspace transfer | `d58902f` | 232 tests | Clean |
| 8 — properties and delivery | `cd27f31`, `8ad4552` | 234 tests | Clean |

Task 8's focused property run passed two tests: seeds `20260921` and `8675309`, 300 runs each, arrays of 1–100 generated operations, ids 1–12, two workspaces and odd/tiny work areas. Neither seed exposed a semantic failure, so there is no shrink path or production fix to record. The independent membership `Map` is the sole expected-membership model; transfer expectations are captured from the selected subtree before mutation. Geometry is checked recursively from `layoutWithRects` output with direct split-child coverage and tabbed/stacked equality, without importing production orientation/partition helpers or calling `Tree.normalize()` in the test.

### Delivery verification

The controller verified the frozen Task 8 source/tests. The following results are the permanent record; temporary verification and review artifacts are disposable execution files:

- `npm test`: 22 files, 234/234 tests passed.
- `npm run typecheck`: both source and test TypeScript programs passed.
- `npm run check:layer0`: passed (`layer0 check ok`).
- `npm run lint:tree`: passed.
- `npm run build`: passed and produced a release build after its typecheck and Layer 0 prerequisites.
- Scope inspection from `8291d64` found no changes under `src/shell`, to `src/engine.ts`, or to `.npmrc`. No integration suite or install was run.

These checks verify the pure Phase 2A subsystem. All task reviews and the whole-branch review subsequently passed. The merge and its test run are recorded below. Live tiling/resizing and A8–A14 desktop acceptance remain Phase 2B work.

### Public Layer 0 signatures as implemented

`Direction` and `Layout` remain owned by `src/commands/model.ts`. The new tree modules expose the following surface:

```ts
type WindowId = number;
type NodeId = number;
type MonitorId = number;
type Axis = 'h' | 'v';
type SplitLayout = 'splith' | 'splitv';
interface Rect { x: number; y: number; width: number; height: number }
interface LeafCon { kind: 'leaf'; id: NodeId; parent: SplitCon | null; window: WindowId }
interface SplitCon {
  kind: 'split'; id: NodeId; parent: SplitCon | null; root: boolean;
  layout: Layout; lastSplitLayout: SplitLayout;
  children: Con[]; percents: number[]; focusedChild: Con | null;
}
type Con = LeafCon | SplitCon;
interface WorkspaceCon {
  index: number; monitors: Map<MonitorId, SplitCon>;
  focusedCon: Con | null; floating: WindowId[]; focusedFloating: WindowId | null;
}
type Selection =
  | {kind: 'tiled'; con: Con}
  | {kind: 'floating'; window: WindowId}
  | null;
type AllocateSplit = (layout: Layout, root?: boolean) => SplitCon;

function axis(layout: Layout): Axis;
function directionAxis(direction: Direction): Axis;
function isForward(direction: Direction): boolean;
function walk(con: Con): Generator<Con>;
function leaves(con: Con): Generator<LeafCon>;
function descendFocused(con: Con): LeafCon | null;
function rootOf(con: Con): SplitCon;
function attach(parent: SplitCon, child: Con, index: number): void;
function detach(child: Con): SplitCon;
function replace(parent: SplitCon, oldChild: Con, newChild: Con): void;
function focusChain(con: Con): void;

interface LayoutResult { windows: Map<WindowId, Rect>; containers: Map<Con, Rect> }
function layoutWithRects(con: Con, rect: Rect): LayoutResult;
function layout(con: Con, rect: Rect): Map<WindowId, Rect>;
function stackingOrder(con: Con): WindowId[];

type Wrapping = 'yes' | 'no' | 'force' | 'workspace';
function descendDirection(con: Con, direction: Direction): LeafCon | null;
function nextFocus(con: Con, direction: Direction, wrapping: Wrapping): LeafCon | null;

function splitCon(con: Con, orientation: 'h' | 'v' | 'toggle', allocate: AllocateSplit): Con;
function setLayout(con: Con, layout: Layout, allocate: AllocateSplit): Con;
function toggleLayout(con: Con, cycle: 'split' | 'all' | readonly Layout[], allocate: AllocateSplit): Con;
function moveCon(con: Con, direction: Direction): boolean;

interface ResizeRequest {
  action: 'grow' | 'shrink'; dimension: 'width' | 'height'; px: number; ppt: number | null;
}
function resizeCon(con: Con, request: ResizeRequest, rectangles: ReadonlyMap<Con, Rect>): boolean;
```

The `Tree` facade exposes:

```ts
class Tree {
  readonly workspaces: Map<number, WorkspaceCon>;
  activeWorkspace: number;
  allocateSplit: AllocateSplit;
  constructor(workspaceCount: number, monitors: readonly MonitorId[]);
  workspace(index: number): WorkspaceCon;
  root(workspace: number, monitor: MonitorId): SplitCon;
  find(window: WindowId): LeafCon | null;
  owner(con: Con): WorkspaceCon;
  location(window: WindowId):
    {workspace: number; monitor: MonitorId | null; floating: boolean} | null;
  selection(workspace?: number): Selection;
  focus(direction: Direction, wrapping: Wrapping): LeafCon | null;
  focusParent(): Con | null;
  focusChild(): Con | null;
  split(orientation: 'h' | 'v' | 'toggle'): void;
  setLayout(layout: Layout): void;
  toggleLayout(cycle: 'split' | 'all' | readonly Layout[]): void;
  move(direction: Direction): boolean;
  resize(request: ResizeRequest, rectangles: ReadonlyMap<Con, Rect>): boolean;
  select(con: Con): void;
  selectFloating(window: WindowId): void;
  activateWorkspace(index: number): void;
  addFloating(window: WindowId, workspace: number): void;
  setFloating(window: WindowId, enabled: boolean, monitor: MonitorId): void;
  focusModeToggle(): WindowId | null;
  moveToWorkspace(target: number, monitor: MonitorId): WindowId[];
  insert(window: WindowId, workspace: number, monitor: MonitorId): LeafCon;
  remove(window: WindowId): void;
  normalize(live?: ReadonlySet<WindowId>): void;
  check(live?: ReadonlySet<WindowId>): void;
}
```

### Exact Phase 2B remainder

Phase 2B must connect this pure API to GNOME without changing its ownership model:

- Assign and resolve opaque `WindowId`s; adopt existing windows in MRU order; connect `window-created` and `first-frame`, `unmanaged`, GNOME focus, minimize, maximize, fullscreen, workspace and monitor lifecycle events.
- Classify normal/dialog/fixed-size windows, including ignored splash windows and floating fixed-size normal windows; implement native fullscreen plus floating frame resize/position and every id-based application/window action.
- Route all tree commands through engine dispatch and one `commit()` pipeline: normalize, layout, expected-rect diff/application, stacking/decorations/indicator updates and `TreeChanged`.
- Implement bounded geometry reconciliation: at most one corrective re-apply per expected-rect generation. Fullscreen exit, unminimize, `monitors-changed`, and completion of an engine-initiated unmaximize must force a fresh application even when the expected rect is unchanged. `workspace-changed` uses the normal tree mutation and rect diff; it is not a forced-reapply event.
- Record expected-workspace acknowledgements for engine-initiated moves; rebuild/migrate monitor roots on monitor changes; expose `GetTree`, `GetWindows` and `TreeChanged`; rebuild the tree on restart.
- Add GTK test windows and nested-shell A8–A14 scenarios while preserving the Phase 1 integration suite, replacing only its temporary resize “not implemented” assertion. A8–A14 remain live acceptance items and are not passed by Phase 2A.
- Carry forward the Phase 1 shell work: settings default reset plus `Gio.Settings.sync()`, initial lock-state seeding, D-Bus name-loss handling, smooth-scroll support and keybinding cleanup. Parser diagnostics/variable-name improvements and cosmetic log/comment text remain explicit carry-forward work; Phase 4 still owns the criteria-regex and custom-keybinding enumeration items.

### Final whole-branch review

The final reviewer approved `8291d64..8ad4552` as ready to merge, with no Critical, Important or Minor findings. It checked cross-module ownership/selection/normalization, all pure §7 operations and deterministic scenarios, generated-test independence, geometry, public integration contracts and tooling. Every pre-existing lockfile package entry was unchanged; all 105 added entries were development dependencies. Task 2's diagnostic-context minor was resolved and reviewed in Task 4; no deferred or parked findings remain.

The controller confirmed both explicit scope boundaries noted by the reviewer: native window actions and geometry reconciliation remain Phase 2B, and navigation/movement across monitor roots remains Phase 4. These preserve the approved phase boundaries; no new scope ruling or deferral was introduced. Phase 2A tests cover the pure contracts and root-boundary behavior.

The final documentation update only records completed reviews. Source and tests remain exactly those covered by the 234-test verification and release build. At review completion, `phase-2` was based on `main` at `8291d64`; its subsequent merge is recorded below. No remote or push has been configured or performed.

### Merge record — 2026-09-22

The user authorized the local merge. `main` fast-forwarded from `8291d64` to `849e181`; `npm test` on the merged result passed all 234 tests in 22 files. The fully merged `phase-2` branch was deleted. The subsequent documentation commit records this integration only; source and tests are unchanged. No remote, push, nested-shell run or install was performed during the merge.
