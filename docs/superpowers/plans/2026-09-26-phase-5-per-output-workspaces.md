# Phase 5 — Per-output workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every output its own workspaces — exactly one visible per output, one global workspace set as in i3 — so a window on a second display is reachable and `$mod+d` opens where the user is.

**Architecture:** The tree inverts: a workspace owns one root and names one output, instead of holding a root per monitor. GNOME drops to two workspaces — *live* (always active) and an *attic* — and windows on a non-visible workspace are parked in the attic, because Mutter already declines to render a non-active workspace. `focusedOutput` becomes first-class state, and the tree becomes the sole authority for workspace membership; Mutter is driven, never read, for it.

**Tech Stack:** TypeScript, GNOME Shell 50 / Mutter 18 (Wayland), esbuild, vitest, a nested `gnome-shell --headless` harness.

**Spec:** `docs/superpowers/specs/2026-09-26-phase-5-per-output-workspaces-design.md`

## Global Constraints

- Layer 0 (`src/config`, `src/commands`, `src/tree`, `src/runtime`, `src/launcher`) must never import `gi://`, `resource://` or anything under `src/shell/`. Enforced by `npm run check:layer0`.
- `src/tree/**` does not import from `src/runtime/**`. Where a tree module needs monitor data, it takes a structural parameter type, not a `runtime/model` import.
- `src/shell/**` **is** unit-testable against `test/unit/shell/fakes/`. `tsconfig.test.json` excludes it from the *typecheck* program only; that is not an exemption from tests.
- No blanket `any`, no `@ts-ignore`.
- Release builds must never contain `org.i3shell.Debug`; it is gated behind `__I3SHELL_TEST__`.
- The critical-log gate in `test/integration/inside.sh` — which greps `(Gjs|GLib(-GObject)?|libmutter|GNOME Shell)-CRITICAL` — must not be weakened.
- `_runOne`'s `switch` in `src/engine.ts` has no `default:` clause. Adding a `Command` union member is therefore a compile error until every site handles it. This is deliberate and relied upon; do not add a `default:`.
- TDD: write the failing test, **run it and paste the actual failure output** into the task record, then implement. A test that covers already-correct behaviour must be **mutation-proven** — break the code, watch that exact test fail, restore it, and record both outputs.
- The controller owns all builds, all native-harness runs and all installs. Implementers run `npm test`, `npm run typecheck` and `npm run check:layer0` only.
- Commits carry **no** attribution trailers — no `Co-Authored-By`, no "Generated with".
- Baseline before Task 1: 941 unit tests in 66 files, 9 integration files, all green.

## Review Focus

Five conditions the spec implies that no task's happy path exercises, most likely to bite first. Each has its test pinned to the task named.

1. **A window Mutter refuses to move during a swap.** `moveToWorkspace` returns false and the window stays visible on a workspace that is now parked, or invisible on one that is now shown. Expected: warn once naming the window, leave it, continue — never throw, because a half-swapped output is recoverable by switching again and an exception mid-swap is not. → Task 6.
2. **A swap where the incoming and outgoing workspace are the same.** `workspace N` when N is already visible on the focused output must move nothing and fire no focus change; the naive five-step swap would park a window and immediately un-park it, flashing the screen. → Task 6 (the engine guard) and Task 7 (the `swap: false` branch).
3. **An output name in the config that matches no connector.** A config written for another machine must warn on that line and fall back to the default assignment, never reject the config or throw. → Task 10.
4. **The pointer resting on an output whose visible workspace becomes empty** because its last window closed. `focusedOutput` must stay on that output rather than silently reverting to the primary, or the launcher jumps screens when a window closes. → Task 12.
5. **Every workspace assigned to an output that then disappears, with the primary already showing one of its own.** Invariant 2 must still hold: the primary shows exactly one workspace and the rest are parked with layouts intact. → Task 16.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/tree/monitors.ts` | `neighbourMonitor` — pure geometric adjacency over work areas. |
| `src/tree/outputs.ts` | Pure output↔workspace arithmetic: ordering, birth assignment, target resolution, hotplug reassignment. No `Tree` import. |
| `src/shell/pointer.ts` | Cursor-tracker subscription (focused-output rule 4) and the `mouse_warping` warp. |
| `docs/acceptance/phase-5.md` | A50–A66, nothing ticked. |

**Modified**

| File | Change |
|---|---|
| `src/tree/node.ts` | `WorkspaceCon`: `monitors` map → `output: MonitorId` + `root: SplitCon`. |
| `src/tree/tree.ts` | Structural rewrite: `visible`, `focusedOutput`, derived `activeWorkspace`, one-root signatures. |
| `src/runtime/model.ts` | `Topology.workAreas` collapses to `ReadonlyMap<MonitorId, Rect>`; `PillState` gains `focused`/`visible`. |
| `src/runtime/snapshot.ts` | `TreeSnapshot` version 2: a workspace carries `output` and one `root`. |
| `src/shell/geometryTopology.ts` | Builds the collapsed `workAreas` from the live workspace; its workspace loop goes. |
| `src/shell/settings.ts` | `num-workspaces` = 2, `focus-mode`, `current-workspace-only`; drops the `workspace-names` apply; clears `switch-to-workspace-*`. |
| `src/shell/workspaces.ts` | `LIVE`/`ATTIC` constants and the `workspace-switched` guard. |
| `src/shell/util/pills.ts` | `samePills` compares five fields; `stylePill` precedence focused → urgent → visible → occupied. |
| `src/shell/indicator.ts`, `src/shell/bars.ts` | Per-output pill lists. |
| `src/commands/model.ts`, `src/commands/parse.ts` | Three new `Command` members and their parsing. |
| `src/config/model.ts`, `src/config/parser.ts` | `workspace N output`, `focus_follows_mouse`, `mouse_warping`. |
| `src/config/overridePlan.ts` | Carries `focusMode` and drops `workspaceNames` from the applied set. |
| `src/engine.ts` | Tree wiring, the swap, `focusedOutput`, pills from the tree, layout of visible workspaces only, `_launcherArea`, three command cases. |

---

## Task 1: `neighbourMonitor` — geometric output adjacency

**Files:**
- Create: `src/tree/monitors.ts`
- Test: `test/unit/tree/monitors.test.ts`

**Interfaces:**
- Consumes: `Direction` from `src/commands/model`, `MonitorId` and `Rect` from `src/tree/node`.
- Produces: `neighbourMonitor(areas: ReadonlyMap<MonitorId, Rect>, from: MonitorId, direction: Direction): MonitorId | null`. Tasks 13, 14 and 15 all resolve direction arguments through it.

- [ ] **Step 1: Write the failing test**

`test/unit/tree/monitors.test.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {neighbourMonitor} from '../../../src/tree/monitors';
import type {MonitorId, Rect} from '../../../src/tree/node';

const rect = (x: number, y: number, width: number, height: number): Rect => ({x, y, width, height});

/** The reporter's real desk: a 3840-wide ultrawide at the origin, a 1920 television to its right. */
const desk = new Map<MonitorId, Rect>([
  [3, rect(0, 32, 3840, 1048)],
  [2, rect(3840, 28, 1920, 1052)],
]);

describe('neighbourMonitor', () => {
  it('finds the output beyond the edge on the direction axis', () => {
    expect(neighbourMonitor(desk, 3, 'right')).toBe(2);
    expect(neighbourMonitor(desk, 2, 'left')).toBe(3);
  });

  it('has no neighbour off the ends', () => {
    expect(neighbourMonitor(desk, 2, 'right')).toBeNull();
    expect(neighbourMonitor(desk, 3, 'left')).toBeNull();
  });

  it('has no vertical neighbour for side-by-side outputs', () => {
    expect(neighbourMonitor(desk, 3, 'down')).toBeNull();
    expect(neighbourMonitor(desk, 3, 'up')).toBeNull();
  });

  it('refuses a diagonal output: it is not to the right of anything', () => {
    const diagonal = new Map<MonitorId, Rect>([
      [0, rect(0, 0, 100, 100)],
      [1, rect(200, 200, 100, 100)],
    ]);
    expect(neighbourMonitor(diagonal, 0, 'right')).toBeNull();
    expect(neighbourMonitor(diagonal, 0, 'down')).toBeNull();
  });

  it('picks the nearest of two candidates beyond the edge', () => {
    const three = new Map<MonitorId, Rect>([
      [0, rect(0, 0, 100, 100)],
      [1, rect(100, 0, 100, 100)],
      [2, rect(200, 0, 100, 100)],
    ]);
    expect(neighbourMonitor(three, 0, 'right')).toBe(1);
    expect(neighbourMonitor(three, 2, 'left')).toBe(1);
  });

  it('treats a touching edge as beyond, and an overlap as not', () => {
    const touching = new Map<MonitorId, Rect>([[0, rect(0, 0, 100, 100)], [1, rect(100, 0, 100, 100)]]);
    expect(neighbourMonitor(touching, 0, 'right')).toBe(1);
    const overlapping = new Map<MonitorId, Rect>([[0, rect(0, 0, 100, 100)], [1, rect(50, 0, 100, 100)]]);
    expect(neighbourMonitor(overlapping, 0, 'right')).toBeNull();
  });

  it('stacked outputs are neighbours vertically, not horizontally', () => {
    const stacked = new Map<MonitorId, Rect>([[0, rect(0, 0, 100, 100)], [1, rect(0, 100, 100, 100)]]);
    expect(neighbourMonitor(stacked, 0, 'down')).toBe(1);
    expect(neighbourMonitor(stacked, 0, 'right')).toBeNull();
  });

  it('returns null for an output it does not know', () => {
    expect(neighbourMonitor(desk, 99, 'right')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/tree/monitors.test.ts`

Expected: the suite fails to collect, with a resolution error naming `src/tree/monitors`. **Paste the actual output into your task record** — a plan's "expected" is a prediction, and the record needs the real thing.

- [ ] **Step 3: Implement**

`src/tree/monitors.ts`:

```ts
import type {Direction} from '../commands/model';
import type {MonitorId, Rect} from './node';

/**
 * The output nearest strictly beyond `from`'s edge on the direction's axis whose span overlaps
 * `from`'s span on the perpendicular axis.
 *
 * Overlap is required. Two displays diagonal to one another are not to the right of each other, and
 * guessing otherwise produces focus jumps no user can predict. A touching edge counts as beyond; an
 * overlap does not, because "beyond" is what makes the relation asymmetric and therefore navigable.
 */
export function neighbourMonitor(
  areas: ReadonlyMap<MonitorId, Rect>,
  from: MonitorId,
  direction: Direction,
): MonitorId | null {
  const origin = areas.get(from);
  if (!origin) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const forward = direction === 'right' || direction === 'down';
  let best: MonitorId | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [id, area] of areas) {
    if (id === from) continue;
    if (!spansOverlap(origin, area, horizontal)) continue;
    const distance = forward
      ? nearEdge(area, horizontal) - farEdge(origin, horizontal)
      : nearEdge(origin, horizontal) - farEdge(area, horizontal);
    if (distance < 0 || distance >= bestDistance) continue;
    bestDistance = distance;
    best = id;
  }
  return best;
}

function nearEdge(rect: Rect, horizontal: boolean): number {
  return horizontal ? rect.x : rect.y;
}

function farEdge(rect: Rect, horizontal: boolean): number {
  return horizontal ? rect.x + rect.width : rect.y + rect.height;
}

/** Overlap on the axis *perpendicular* to the movement. */
function spansOverlap(a: Rect, b: Rect, horizontal: boolean): boolean {
  return horizontal
    ? b.y < a.y + a.height && a.y < b.y + b.height
    : b.x < a.x + a.width && a.x < b.x + b.width;
}
```

- [ ] **Step 4: Run the test and the guards**

Run: `npx vitest run test/unit/tree/monitors.test.ts && npm run typecheck && npm run check:layer0 && npm run lint:tree`

Expected: 8 passing, typecheck clean, Layer 0 clean, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/tree/monitors.ts test/unit/tree/monitors.test.ts
git commit -m "feat(tree): add neighbourMonitor for geometric output adjacency"
```

---

## Task 2: `src/tree/outputs.ts` — pure output↔workspace arithmetic

Every decision about *which* output a workspace belongs to lives here, as pure functions over plain
maps. The `Tree` (Task 3) and the engine (Task 5 onward) call these; none of it touches a `Con`.

**Files:**
- Create: `src/tree/outputs.ts`
- Test: `test/unit/tree/outputs.test.ts`

**Interfaces:**
- Consumes: `MonitorId`, `Rect` from `src/tree/node`; `Direction` from `src/commands/model`; `neighbourMonitor` from Task 1.
- Produces, all pure:
  - `type OutputRef = {id: MonitorId; index: number}`
  - `type OutputArg = Direction | 'primary' | {name: string}`
  - `orderOutputs(outputs: readonly OutputRef[], primary: MonitorId): MonitorId[]`
  - `birthAssignment(ordered: readonly MonitorId[], workspaceCount: number, pinned: ReadonlyMap<number, MonitorId>): Map<number, MonitorId>`
  - `resolveOutputArg(arg: OutputArg, areas: ReadonlyMap<MonitorId, Rect>, from: MonitorId, primary: MonitorId, byName: ReadonlyMap<string, MonitorId>): MonitorId | null`
  - `reassignLost(assignment: ReadonlyMap<number, MonitorId>, live: ReadonlySet<MonitorId>, primary: MonitorId): Map<number, MonitorId>`
  - `adoptOutput(remembered: ReadonlyMap<number, MonitorId>, gained: MonitorId, assignment: ReadonlyMap<number, MonitorId>): number | null`

- [ ] **Step 1: Write the failing test**

`test/unit/tree/outputs.test.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {
  adoptOutput, birthAssignment, orderOutputs, reassignLost, resolveOutputArg,
} from '../../../src/tree/outputs';
import type {MonitorId, Rect} from '../../../src/tree/node';

const rect = (x: number, y: number, width: number, height: number): Rect => ({x, y, width, height});
const desk = new Map<MonitorId, Rect>([[3, rect(0, 32, 3840, 1048)], [2, rect(3840, 28, 1920, 1052)]]);

describe('orderOutputs', () => {
  it('puts the primary first, then ascending Mutter index', () => {
    // The reporter's desk: the primary (HDMI-1) is Mutter index 1, the television index 0.
    // Ordering by index alone would hand workspace I to the television.
    expect(orderOutputs([{id: 2, index: 0}, {id: 3, index: 1}], 3)).toEqual([3, 2]);
  });

  it('is stable for three outputs', () => {
    expect(orderOutputs([{id: 7, index: 2}, {id: 5, index: 0}, {id: 6, index: 1}], 6)).toEqual([6, 5, 7]);
  });

  it('throws when the primary is not among the outputs', () => {
    expect(() => orderOutputs([{id: 1, index: 0}], 9)).toThrow(/primary/);
  });
});

describe('birthAssignment', () => {
  it("gives workspace N to output N, i3's startup rule", () => {
    expect(birthAssignment([3, 2], 10, new Map())).toEqual(new Map([
      [0, 3], [1, 2], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3],
    ]));
  });

  it('assigns every workspace, so a workspace always has exactly one output', () => {
    const assignment = birthAssignment([3, 2], 10, new Map());
    for (let index = 0; index < 10; index++) expect(assignment.has(index)).toBe(true);
  });

  it('lets a pinned assignment win over the default', () => {
    // `workspace 3 output <television>` in the config.
    expect(birthAssignment([3, 2], 4, new Map([[2, 2]]))).toEqual(new Map([[0, 3], [1, 2], [2, 2], [3, 3]]));
  });

  it('ignores a pin naming an output that is not live', () => {
    expect(birthAssignment([3, 2], 3, new Map([[2, 99]])).get(2)).toBe(3);
  });

  it('puts everything on the single output when there is only one', () => {
    expect(birthAssignment([3], 3, new Map())).toEqual(new Map([[0, 3], [1, 3], [2, 3]]));
  });
});

describe('resolveOutputArg', () => {
  it('resolves a direction through geometry', () => {
    expect(resolveOutputArg('right', desk, 3, 3, new Map())).toBe(2);
    expect(resolveOutputArg('right', desk, 2, 3, new Map())).toBeNull();
  });

  it('resolves primary', () => {
    expect(resolveOutputArg('primary', desk, 2, 3, new Map())).toBe(3);
  });

  it('resolves a connector name, case-insensitively', () => {
    const byName = new Map([['hdmi-1', 3], ['dp-1', 2]]);
    expect(resolveOutputArg({name: 'DP-1'}, desk, 3, 3, byName)).toBe(2);
  });

  it('returns null for a name matching no connector', () => {
    expect(resolveOutputArg({name: 'VGA-9'}, desk, 3, 3, new Map([['dp-1', 2]]))).toBeNull();
  });
});

describe('reassignLost', () => {
  it('moves a lost output’s workspaces to the primary and leaves the others alone', () => {
    const before = new Map([[0, 3], [1, 2], [2, 3], [3, 2]]);
    expect(reassignLost(before, new Set([3]), 3)).toEqual(new Map([[0, 3], [1, 3], [2, 3], [3, 3]]));
  });

  it('is a no-op when every assigned output is still live', () => {
    const before = new Map([[0, 3], [1, 2]]);
    expect(reassignLost(before, new Set([3, 2]), 3)).toEqual(before);
  });

  it('survives every workspace living on the output that vanished', () => {
    const before = new Map([[0, 2], [1, 2], [2, 2]]);
    expect(reassignLost(before, new Set([3]), 3)).toEqual(new Map([[0, 3], [1, 3], [2, 3]]));
  });
});

describe('adoptOutput', () => {
  it('prefers the lowest-numbered workspace remembered on the returning output', () => {
    expect(adoptOutput(new Map([[1, 2], [4, 2]]), 2, new Map([[0, 3], [1, 3], [4, 3]]))).toBe(1);
  });

  it('falls back to the lowest-numbered workspace not already elsewhere', () => {
    expect(adoptOutput(new Map(), 2, new Map([[0, 3], [1, 3]]))).toBeNull();
  });

  it('ignores a remembered workspace that no longer exists', () => {
    expect(adoptOutput(new Map([[7, 2]]), 2, new Map([[0, 3]]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/tree/outputs.test.ts`

Expected: collection failure naming `src/tree/outputs`. Paste the real output.

- [ ] **Step 3: Implement**

`src/tree/outputs.ts`:

```ts
import type {Direction} from '../commands/model';
import {neighbourMonitor} from './monitors';
import type {MonitorId, Rect} from './node';

/** An output as the topology knows it: a stable id plus Mutter's enumeration index. */
export interface OutputRef {
  id: MonitorId;
  index: number;
}

/** The argument shared by `focus output`, `move container to output` and `move workspace to output`. */
export type OutputArg = Direction | 'primary' | {name: string};

/**
 * Outputs in the order workspaces are handed out: **primary first**, then ascending Mutter index.
 *
 * The primary must come first because "the primary display is workspace one" is the behaviour being
 * asked for. Mutter's index order is not that: on the reporting desk the primary is index 1 and the
 * television index 0, so sorting by index alone would put workspace I on the television.
 */
export function orderOutputs(outputs: readonly OutputRef[], primary: MonitorId): MonitorId[] {
  if (!outputs.some(output => output.id === primary))
    throw new Error(`primary output ${primary} is not among the outputs`);
  const rest = outputs.filter(output => output.id !== primary).sort((a, b) => a.index - b.index);
  return [primary, ...rest.map(output => output.id)];
}

/**
 * i3's startup rule: workspace N to output N, for as many outputs as exist.
 *
 * Every workspace gets an output — the surplus go to the primary — so "a workspace has exactly one
 * output" is total and needs no separate notion of being placed. `workspace N` moves an unshown
 * workspace to the focused output regardless of what this assigned it (see the Tree's `showWorkspace`).
 */
export function birthAssignment(
  ordered: readonly MonitorId[],
  workspaceCount: number,
  pinned: ReadonlyMap<number, MonitorId>,
): Map<number, MonitorId> {
  if (ordered.length === 0) throw new Error('at least one output is required');
  const live = new Set(ordered);
  const primary = ordered[0]!;
  const assignment = new Map<number, MonitorId>();
  for (let index = 0; index < workspaceCount; index++) {
    const pin = pinned.get(index);
    // A pin naming a connector that is not attached is ignored rather than fatal: a config written
    // on another machine must still work here.
    if (pin !== undefined && live.has(pin)) {
      assignment.set(index, pin);
      continue;
    }
    assignment.set(index, ordered[index] ?? primary);
  }
  return assignment;
}

/** `left|right|up|down` through geometry, `primary`, or a connector name. Null = no such output. */
export function resolveOutputArg(
  arg: OutputArg,
  areas: ReadonlyMap<MonitorId, Rect>,
  from: MonitorId,
  primary: MonitorId,
  byName: ReadonlyMap<string, MonitorId>,
): MonitorId | null {
  if (arg === 'primary') return primary;
  if (typeof arg === 'object') return byName.get(arg.name.toLowerCase()) ?? null;
  return neighbourMonitor(areas, from, arg);
}

/** Workspaces on an output that has gone move to the primary; their roots are untouched. */
export function reassignLost(
  assignment: ReadonlyMap<number, MonitorId>,
  live: ReadonlySet<MonitorId>,
  primary: MonitorId,
): Map<number, MonitorId> {
  const next = new Map(assignment);
  for (const [workspace, output] of assignment)
    if (!live.has(output)) next.set(workspace, primary);
  return next;
}

/**
 * Which workspace a returning output should show: the lowest-numbered one remembered on it that still
 * exists. Null means nothing was remembered, and the caller picks by its own rule.
 */
export function adoptOutput(
  remembered: ReadonlyMap<number, MonitorId>,
  gained: MonitorId,
  assignment: ReadonlyMap<number, MonitorId>,
): number | null {
  const candidates = [...remembered]
    .filter(([workspace, output]) => output === gained && assignment.has(workspace))
    .map(([workspace]) => workspace)
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}
```

- [ ] **Step 4: Run the tests and the guards**

Run: `npx vitest run test/unit/tree/outputs.test.ts && npm run typecheck && npm run check:layer0 && npm run lint:tree`

Expected: 17 passing across the five describes; guards clean.

- [ ] **Step 5: Mutation-prove the primary-first rule**

`orderOutputs` is the function whose failure would silently put workspace I on the television, so
prove its test can fail. Change `return [primary, ...rest.map(output => output.id)]` to
`return [...outputs].sort((a, b) => a.index - b.index).map(o => o.id)` and run
`npx vitest run test/unit/tree/outputs.test.ts`.

Expected: `orderOutputs > puts the primary first` fails with received `[2, 3]`, want `[3, 2]`. Restore
the implementation, re-run, and record **both** outputs.

- [ ] **Step 6: Commit**

```bash
git add src/tree/outputs.ts test/unit/tree/outputs.test.ts
git commit -m "feat(tree): add pure output-to-workspace assignment arithmetic"
```

---

## Task 3: Invert the tree — a workspace owns one root and names one output

The largest task, and deliberately not split: `tree.ts` cannot compile half-inverted, so the structure
change, every signature that mentions a monitor, and the five tree test files move together. Nothing
outside `src/tree/**` and `test/unit/tree/**` changes here — `src/engine.ts` and
`src/runtime/snapshot.ts` will not typecheck at the end of this task, and that is expected. Task 4
and Task 5 close it. Run `npx vitest run test/unit/tree` rather than the whole suite while working.

**Files:**
- Modify: `src/tree/node.ts:37-43` (`WorkspaceCon`)
- Modify: `src/tree/tree.ts` (structure, constructor, and every signature naming a monitor)
- Test: `test/unit/tree/tree.test.ts`, `membership.test.ts`, `normalize.test.ts`, `properties.test.ts`, `topology.test.ts`

**Interfaces:**
- Consumes: `orderOutputs`, `birthAssignment` from Task 2.
- Produces, relied on by Tasks 4–16:
  - `WorkspaceCon = {index: number; output: MonitorId; root: SplitCon; focusedCon: Con | null; floating: WindowId[]; focusedFloating: WindowId | null}`
  - `new Tree(workspaceCount: number, outputs: readonly OutputRef[], primary: MonitorId, pinned?: ReadonlyMap<number, MonitorId>)`
  - `tree.visible: Map<MonitorId, number>`, `tree.focusedOutput: MonitorId`, `get activeWorkspace(): number`
  - `tree.root(workspace: number): SplitCon`
  - `tree.location(window): {workspace: number; output: MonitorId; floating: boolean} | null`
  - `tree.insert(window: WindowId, workspace: number): LeafCon`
  - `tree.moveToWorkspace(target: number): WindowId[]`
  - `tree.setFloating(window: WindowId, enabled: boolean): void`
  - `tree.outputOf(workspace: number): MonitorId`
  - `tree.outputSignature(): string` — the live output ids, sorted and joined; Task 5 uses it to tell a real monitor change from a no-op
  - `tree.workspacesOn(output: MonitorId): number[]` — ascending; Task 8 draws each bar from it.

- [ ] **Step 1: Write the failing structural test**

Create `test/unit/tree/outputsModel.test.ts` — a new file, so the five existing tree files can be
migrated in Step 5 without fighting a red suite they did not cause:

```ts
import {describe, expect, it} from 'vitest';
import {Tree} from '../../../src/tree/tree';

/** The reporting desk: primary id 3 at Mutter index 1, television id 2 at index 0. */
const outputs = [{id: 2, index: 0}, {id: 3, index: 1}];

describe('Tree, per-output', () => {
  it('gives workspace 0 the primary and workspace 1 the other output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.outputOf(0)).toBe(3);
    expect(t.outputOf(1)).toBe(2);
  });

  it('shows workspace 0 on the primary and workspace 1 on the other, and focuses the primary', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.visible.get(3)).toBe(0);
    expect(t.visible.get(2)).toBe(1);
    expect(t.focusedOutput).toBe(3);
  });

  it('derives activeWorkspace from the focused output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.activeWorkspace).toBe(0);
    t.focusedOutput = 2;
    expect(t.activeWorkspace).toBe(1);
  });

  it('gives every workspace exactly one root', () => {
    const t = new Tree(10, outputs, 3);
    for (let index = 0; index < 10; index++) {
      const root = t.root(index);
      expect(root.root).toBe(true);
      expect(root.children).toEqual([]);
    }
  });

  it('assigns surplus workspaces to the primary so every workspace has an output', () => {
    const t = new Tree(10, outputs, 3);
    for (let index = 2; index < 10; index++) expect(t.outputOf(index)).toBe(3);
  });

  it('lists an output’s workspaces in ascending order', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.workspacesOn(2)).toEqual([1]);
    expect(t.workspacesOn(3)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('honours a pinned assignment', () => {
    const t = new Tree(4, outputs, 3, new Map([[2, 2]]));
    expect(t.outputOf(2)).toBe(2);
    expect(t.workspacesOn(2)).toEqual([1, 2]);
  });

  it('inserts into the workspace’s own root without being told an output', () => {
    const t = new Tree(2, outputs, 3);
    const leaf = t.insert(101, 1);
    expect(t.root(1).children).toContain(leaf);
    expect(t.location(101)).toEqual({workspace: 1, output: 2, floating: false});
  });

  it('reports a floating window’s output as its workspace’s', () => {
    const t = new Tree(2, outputs, 3);
    t.addFloating(102, 1);
    expect(t.location(102)).toEqual({workspace: 1, output: 2, floating: true});
  });

  it('works with a single output', () => {
    const t = new Tree(3, [{id: 0, index: 0}], 0);
    expect(t.visible.get(0)).toBe(0);
    expect(t.workspacesOn(0)).toEqual([0, 1, 2]);
    expect(t.activeWorkspace).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/tree/outputsModel.test.ts`

Expected: failures on `t.outputOf is not a function` and a constructor that rejects
`[{id, index}]` where it wants `MonitorId[]`. Paste the real output.

- [ ] **Step 3: Change `WorkspaceCon`**

`src/tree/node.ts`, replacing lines 37-43:

```ts
export interface WorkspaceCon {
  index: number;
  /**
   * The output this workspace lives on. Exactly one, always set — including for a workspace nobody
   * has shown yet, which the birth assignment puts on the primary. Totality is what lets every
   * caller skip a null check; `Tree.showWorkspace` is what moves it.
   */
  output: MonitorId;
  /** The one root. Was a `Map<MonitorId, SplitCon>`; i3's level order is output → workspace. */
  root: SplitCon;
  focusedCon: Con | null;
  floating: WindowId[];
  focusedFloating: WindowId | null;
}
```

- [ ] **Step 4: Rewrite the `Tree` structure**

In `src/tree/tree.ts`:

Add to the imports: `import {birthAssignment, orderOutputs, type OutputRef} from './outputs';`

Replace the class head and constructor (currently `tree.ts:26-70`):

```ts
export class Tree {
  readonly workspaces: Map<number, WorkspaceCon>;
  /** Which workspace each live output currently shows. Exactly one entry per live output. */
  readonly visible: Map<MonitorId, number>;
  focusedOutput: MonitorId;
  private nextNodeId = 1;

  allocateSplit: AllocateSplit = (layout, root = false) => { /* unchanged */ };

  constructor(
    workspaceCount: number,
    outputs: readonly OutputRef[],
    primary: MonitorId,
    pinned: ReadonlyMap<number, MonitorId> = new Map(),
  ) {
    assertInteger(workspaceCount, 'workspace count');
    if (workspaceCount < 1 || workspaceCount > 36)
      throw new Error('workspace count must be between 1 and 36');
    if (outputs.length === 0) throw new Error('at least one monitor is required');
    const seen = new Set<MonitorId>();
    for (const output of outputs) {
      assertNonnegativeInteger(output.id, 'monitor id');
      if (seen.has(output.id)) throw new Error(`duplicate monitor id ${output.id}`);
      seen.add(output.id);
    }
    assertNonnegativeInteger(primary, 'primary monitor id');

    const ordered = orderOutputs(outputs, primary);
    const assignment = birthAssignment(ordered, workspaceCount, pinned);
    this.workspaces = new Map();
    for (let index = 0; index < workspaceCount; index++) {
      this.workspaces.set(index, {
        index,
        output: assignment.get(index)!,
        root: this.allocateSplit('splith', true),
        focusedCon: null,
        floating: [],
        focusedFloating: null,
      });
    }
    // focusedCon starts at the workspace's own root, as it did when the first monitor's root was taken.
    for (const workspace of this.workspaces.values()) workspace.focusedCon = workspace.root;

    this.visible = new Map();
    for (const output of ordered) {
      const own = [...this.workspaces.values()].filter(w => w.output === output).map(w => w.index);
      // Invariant 2: every output shows exactly one of its own. The birth assignment guarantees the
      // primary has at least one, and an output with none cannot occur because assignment is total.
      this.visible.set(output, own[0]!);
    }
    this.focusedOutput = primary;
  }

  /** The output a workspace lives on. */
  outputOf(workspace: number): MonitorId {
    return this.workspace(workspace).output;
  }

  /** An output's workspaces, ascending. Each bar is drawn from this. */
  workspacesOn(output: MonitorId): number[] {
    return [...this.workspaces.values()]
      .filter(workspace => workspace.output === output)
      .map(workspace => workspace.index)
      .sort((a, b) => a - b);
  }

  /** The workspace the user is on. Derived — GNOME's active workspace is a constant now. */
  get activeWorkspace(): number {
    const workspace = this.visible.get(this.focusedOutput);
    if (workspace === undefined)
      throw new Error(`focused output ${this.focusedOutput} shows no workspace`);
    return workspace;
  }
```

Then change each member that named a monitor. Every one is mechanical; the compiler finds them all.

```ts
  // was root(workspace, monitor)
  root(workspace: number): SplitCon {
    return this.workspace(workspace).root;
  }

  // was: for (const root of workspace.monitors.values())
  find(window: WindowId): LeafCon | null {
    assertWindowId(window);
    for (const workspace of this.workspaces.values()) {
      const found = findLeaf(workspace.root, window);
      if (found) return found;
    }
    return null;
  }

  owner(con: Con): WorkspaceCon {
    for (const workspace of this.workspaces.values())
      if (contains(workspace.root, con)) return workspace;
    throw new Error(`container ${con.id} is not owned by this tree`);
  }

  // `monitor` becomes `output`, and is never null: a floating window's output is its workspace's.
  location(window: WindowId): {workspace: number; output: MonitorId; floating: boolean} | null {
    assertWindowId(window);
    for (const [index, workspace] of this.workspaces) {
      if (findLeaf(workspace.root, window))
        return {workspace: index, output: workspace.output, floating: false};
      if (workspace.floating.includes(window))
        return {workspace: index, output: workspace.output, floating: true};
    }
    return null;
  }

  // was insert(window, workspace, monitor)
  insert(window: WindowId, workspace: number): LeafCon {
    assertWindowId(window);
    const ws = this.workspace(workspace);
    if (this.location(window)) throw new Error(`window ${window} is already tracked`);
    const insertion = this.insertionPoint(ws, ws.root);
    const leaf: LeafCon = {kind: 'leaf', id: this.nextNodeId++, parent: null, window};
    attach(insertion.parent, leaf, insertion.index);
    ws.focusedCon = leaf;
    ws.focusedFloating = null;
    focusChain(leaf);
    return leaf;
  }

  // was moveToWorkspace(target, monitor); the target workspace's root is the only candidate now
  moveToWorkspace(target: number): WindowId[] {
    const targetWorkspace = this.workspace(target);
    const targetRoot = targetWorkspace.root;
    /* the rest of the body is unchanged, with `this.root(target, monitor)` gone */
  }

  // was setFloating(window, enabled, monitor)
  setFloating(window: WindowId, enabled: boolean): void {
    /* body unchanged, using this.workspace(location.workspace).root where it used the monitor root */
  }
```

Delete `activateWorkspace(index)` entirely. Nothing may derive an i3 workspace from GNOME's active
index (spec §2.6); Task 7 adds `showWorkspace` in its place, and leaving a method that sets
`activeWorkspace` would make the derived getter a lie.

For `reconfigure(workspaceCount, outputs, primary)`: keep the workspace-count-shrink half exactly as
it is, with `source.monitors.get(monitor)` replaced by `source.root` and the per-monitor loop removed.
Replace the monitor-loss half — the `appendRootContents` block at `tree.ts:238-252` — with reassignment:

```ts
    const live = new Set(outputs.map(output => output.id));
    const ordered = orderOutputs(outputs, primary);
    for (const workspace of this.workspaces.values())
      if (!live.has(workspace.output)) workspace.output = primary;
    // Rebuild visibility: an output keeps showing its workspace if it still owns it, else takes its
    // lowest-numbered. Roots are never merged, so no layout is lost.
    for (const output of [...this.visible.keys()]) if (!live.has(output)) this.visible.delete(output);
    for (const output of ordered) {
      const own = this.workspacesOn(output);
      const current = this.visible.get(output);
      if (current === undefined || !own.includes(current)) this.visible.set(output, own[0]!);
    }
    if (!live.has(this.focusedOutput)) this.focusedOutput = primary;
```

`appendRootContents` stays in the file — the workspace-count-shrink path still uses it.

- [ ] **Step 5: Migrate the five existing tree test files**

Mechanical, and the compiler plus the suite name every site:

- `new Tree(n, [0])` → `new Tree(n, [{id: 0, index: 0}], 0)`; `new Tree(2, [2, 0])` → `new Tree(2, [{id: 2, index: 0}, {id: 0, index: 1}], 2)` where the test means "2 is primary", otherwise pick the primary the test's assertions imply.
- `t.root(ws, mon)` → `t.root(ws)`; `t.insert(w, ws, mon)` → `t.insert(w, ws)`; `t.moveToWorkspace(ws, mon)` → `t.moveToWorkspace(ws)`; `t.setFloating(w, on, mon)` → `t.setFloating(w, on)`.
- `workspace.monitors.get(m)` → `workspace.root`; `workspace.monitors.size` → `1`.
- `location(w)` assertions: `{workspace, monitor: m, floating}` → `{workspace, output: m, floating}`.
- `t.activateWorkspace(i)` → `t.focusedOutput = t.outputOf(i)` where the test only needs
  `activeWorkspace` to read `i`, **and** `t.visible.set(t.outputOf(i), i)` where the test then acts on
  that workspace. A test that used `activateWorkspace` to mean "make this workspace current" needs both.
- `topology.test.ts`'s `reconfigure` cases asserting that a lost monitor's windows are appended into the
  primary's root now assert the opposite: the workspace keeps its root and changes its `output`. Rewrite
  each such assertion to check `outputOf` and that the root's `children` are unchanged. This is the
  behaviour change of the phase; a test still asserting flattening is asserting the bug.

- [ ] **Step 6: Run the tree suite and the guards**

Run: `npx vitest run test/unit/tree && npm run check:layer0 && npm run lint:tree`

Expected: the whole of `test/unit/tree` green, including the new `outputsModel.test.ts` (10 tests).
`npm run typecheck` **will still fail**, in `src/engine.ts` and `src/runtime/snapshot.ts` only; list
those errors in the task record so Tasks 4 and 5 can be checked against the list. A typecheck error
anywhere else means this task changed something it should not have.

- [ ] **Step 7: Commit**

```bash
git add src/tree/node.ts src/tree/tree.ts test/unit/tree
git commit -m "refactor(tree)!: a workspace owns one root and names one output

Inverts the level order from workspace-to-monitor to i3's
output-to-workspace. WorkspaceCon holds one root and one output; Tree
gains visible and focusedOutput, and activeWorkspace becomes a derived
getter over them. activateWorkspace is deleted: GNOME's active workspace
is no longer an i3 workspace.

reconfigure now reassigns a lost output's workspaces to the primary
instead of flattening their roots into it, so a layout survives an
unplug. src/engine.ts and src/runtime/snapshot.ts do not typecheck until
the next two tasks."
```

---

## Task 4: Collapse `Topology.workAreas` to one map per output

A work area is a property of an output. It was keyed by workspace only because GNOME owned workspaces,
and `geometryTopology.ts:41` builds it by looping to the **GNOME** workspace manager's count — which
Task 6 reduces to 2. Left alone, a lookup by i3 workspace 2 or above would return `undefined` and
`_launcherArea()` would fail on seven of ten workspaces. Doing this before the attic lands means that
failure never exists in the tree of commits.

**Files:**
- Modify: `src/runtime/model.ts:56` (`Topology.workAreas`)
- Modify: `src/shell/geometryTopology.ts:40-74`
- Modify: `src/engine.ts:388-391` (`_ready`), `src/engine.ts:425` (layout), `src/engine.ts:925` (`_launcherArea`), `src/engine.ts:1119`
- Modify: `src/runtime/snapshot.ts:51`
- Test: `test/unit/shell/geometryTopology.test.ts`

**Interfaces:**
- Produces: `Topology.workAreas: ReadonlyMap<MonitorId, Rect>`. Tasks 5, 8, 13, 14 and 16 all read it.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/shell/geometryTopology.test.ts`:

```ts
it('yields one work area per output, keyed by MonitorId', () => {
  // Two outputs, ten GNOME workspaces: the old shape produced ten maps of two entries.
  const topology = buildTopology(sourceWithMonitors([
    {index: 0, connectors: ['HDMI-1'], area: {x: 0, y: 32, width: 3840, height: 1048}},
    {index: 1, connectors: ['DP-1'], area: {x: 3840, y: 28, width: 1920, height: 1052}},
  ], {primary: 0, workspaceCount: 10}));
  expect(topology).not.toBeNull();
  expect([...topology!.workAreas.keys()].sort()).toEqual([...topology!.monitors.map(m => m.id)].sort());
  expect(topology!.workAreas.get(topology!.monitors[0]!.id)).toEqual({x: 0, y: 32, width: 3840, height: 1048});
});

it('reads work areas from the live workspace only, so a reduced workspace count cannot shrink it', () => {
  // The attic leaves GNOME with two workspaces. Every output must still have a work area.
  const topology = buildTopology(sourceWithMonitors([
    {index: 0, connectors: ['HDMI-1'], area: {x: 0, y: 32, width: 3840, height: 1048}},
    {index: 1, connectors: ['DP-1'], area: {x: 3840, y: 28, width: 1920, height: 1052}},
  ], {primary: 0, workspaceCount: 2}));
  expect(topology!.workAreas.size).toBe(2);
});
```

Match the helper names already in that file; if it builds its source inline rather than through
helpers, follow its existing shape instead of introducing `sourceWithMonitors`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/shell/geometryTopology.test.ts`

Expected: `workAreas.keys()` yields workspace indices (`0, 1, …`) where monitor ids were wanted, and
`workAreas.get(id)` is a `Map`, not a `Rect`. Paste the real output.

- [ ] **Step 3: Change the type**

`src/runtime/model.ts`:

```ts
export interface Topology {
  primary: MonitorId;
  monitors: readonly MonitorInfo[];
  /**
   * One work area per output, read from the *live* GNOME workspace.
   *
   * A work area belongs to an output, not to a workspace. It was keyed by workspace only because
   * GNOME owned workspaces; with two GNOME workspaces (live + attic) that keying would produce
   * entries for 0 and 1 alone, and every i3 workspace above 1 would miss.
   */
  workAreas: ReadonlyMap<MonitorId, Rect>;
}
```

- [ ] **Step 4: Build the collapsed map**

`src/shell/geometryTopology.ts` — the workspace loop goes entirely. Replace the `rawWorkAreas` loop
(lines 40-51) with a single read of the live workspace, and the rebuild loop (63-73) with one pass:

```ts
  // Workspace 0 is `live`: the only GNOME workspace any visible window occupies.
  const liveWorkspace = source.workspace(0);
  if (!liveWorkspace) return null;
  const rawWorkAreas = new Map<number, Rect>();
  for (const monitorIndex of groups.keys()) {
    const area = source.workArea(liveWorkspace, monitorIndex);
    if (!area || !usableRect(area)) return null;
    rawWorkAreas.set(monitorIndex, copyRect(area));
  }
```

and:

```ts
  const workAreas = new Map<MonitorId, Rect>();
  for (const [monitorIndex, area] of rawWorkAreas) {
    const id = idsByIndex.get(monitorIndex);
    if (id === undefined) throw new Error('validated monitor was not assigned an id');
    workAreas.set(id, area);
  }
  return {primary, monitors, workAreas};
```

The `workspaceCount` parameter becomes unused by the work-area logic. Keep it if the signature is
shared, and delete it if `buildTopology` is its only caller — do not leave a parameter the body ignores
without a comment saying why.

- [ ] **Step 5: Update the four read sites**

`src/engine.ts`, the readiness check at 388-391:

```ts
    this._ready = !!topology && topology.monitors.length > 0 &&
      topology.monitors.every(m => topology.workAreas.has(m.id));
```

The layout call at 425 becomes `topology.workAreas.get(ws.output)!` (Task 5 rewrites this loop
wholesale; make it compile here). `_launcherArea` at 925 drops its `areas` indirection:
`const areas = topology.workAreas;` with the `if (!areas) return null;` deleted, since a
`ReadonlyMap` is always present. Line 1119's
`this._topology.workAreas.get(floating.info.workspace)?.get(monitor)` becomes
`this._topology.workAreas.get(monitor)`.

`src/runtime/snapshot.ts:51`: `topology.workAreas.get(ws.index)?.get(id)` → `topology.workAreas.get(output)`.

- [ ] **Step 6: Run the suite and the guards**

Run: `npx vitest run test/unit/shell/geometryTopology.test.ts test/unit/tree && npm run check:layer0`

Expected: the new tests pass and `test/unit/tree` stays green. `npm run typecheck` still fails in
`src/engine.ts` and `src/runtime/snapshot.ts`; the list must be **shorter** than Task 3 Step 6's, and
must not contain anything new. Record the diff between the two lists.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/model.ts src/shell/geometryTopology.ts src/engine.ts src/runtime/snapshot.ts test/unit/shell/geometryTopology.test.ts
git commit -m "refactor(geometry)!: key work areas by output instead of workspace

geometryTopology built workAreas by looping to the GNOME workspace
manager's count. The attic reduces that count to two, which would leave
every i3 workspace above 1 without a work area and break the launcher on
seven of ten workspaces. A work area belongs to an output; the
per-workspace keying only existed because GNOME owned workspaces."
```

---

## Task 5: Wire the engine to the inverted tree

Closes the typecheck. Everything the engine did by asking Mutter which workspace a window is on, it now
does from the tree — the inversion the spec calls for in §2.6. No new user-visible behaviour lands
here: the attic is Task 6 and `workspace N` is Task 7. The deliverable is a green suite and a clean
typecheck with the new model underneath.

**Files:**
- Modify: `src/engine.ts` — `_layoutAndPublish` (387-470), `_pills` (471-484), `_syncWindow`, `_launcherArea` (921-950), `onMonitorsChanged` (273-)
- Test: `test/unit/engine.test.ts`, `test/unit/engine/lifecycle.test.ts`, `test/unit/engine/commands.test.ts`, `test/unit/runtime/snapshot.test.ts`

**Interfaces:**
- Consumes: everything Tasks 2–4 produce.
- Produces: `engine.state().focusedOutput: MonitorId` on the `GetState` payload, read by Task 17's native scenarios.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/engine.test.ts`, using that file's existing harness helpers:

```ts
it('lays out only the visible workspace of each output', () => {
  // Two outputs, ten workspaces. The old loop laid out twenty roots; two are visible.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.addWindow({id: 2, workspace: 1, monitor: 1});
  const laid = h.geometry.appliedRects();
  expect([...laid.keys()].sort()).toEqual([1, 2]);
});

it('derives a pill’s occupancy from the tree, not from the window’s GNOME workspace', () => {
  // Every window's GNOME workspace is 0 under the attic; occupancy must still follow the tree.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 1});
  expect(h.state().pills[1]!.occupied).toBe(true);
  expect(h.state().pills[0]!.occupied).toBe(false);
});

it('reports the focused output', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  expect(h.state().focusedOutput).toBe(0);
});

it('adopts a window onto the visible workspace of the output it is on', () => {
  // Spec 2.6: the pre-enable workspace is unrecoverable once num-workspaces drops to 2.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10,
    existingWindows: [{id: 5, workspace: 0, monitor: 1}]});
  expect(h.tree().location(5)).toEqual({workspace: 1, output: 1, floating: false});
});
```

Adapt the harness option names to what `engine.test.ts` already uses; the assertions are the contract.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/engine.test.ts`

Expected: typecheck/collection errors from the still-unmigrated call sites, then assertion failures on
`focusedOutput` being absent and occupancy reading `false`. Paste the real output.

- [ ] **Step 3: Construct and reconfigure the tree with outputs**

In `_layoutAndPublish`, replace the construction and reconfigure block (`engine.ts:395-400`):

```ts
      const outputs = topology.monitors.map(m => ({id: m.id, index: m.index}));
      if (!this._tree)
        this._tree = new Tree(this._workspaceCount, outputs, topology.primary, this._pinnedOutputs());
      else if (this._tree.workspaces.size !== this._workspaceCount ||
        this._tree.outputSignature() !== outputs.map(o => o.id).sort((a, b) => a - b).join(','))
        this._moveReconfigured(this._tree.reconfigure(this._workspaceCount, outputs, topology.primary));
```

Add to `Tree` in `src/tree/tree.ts`:

```ts
  /** The live output set, as a stable string, so the engine can tell a monitor change from a no-op. */
  outputSignature(): string {
    return [...this.visible.keys()].sort((a, b) => a - b).join(',');
  }
```

`_pinnedOutputs()` returns `new Map()` for now and Task 10 fills it in from the config:

```ts
  /** `workspace N output <name>` pins, resolved against the live topology. Task 10 populates this. */
  private _pinnedOutputs(): ReadonlyMap<number, MonitorId> {
    return new Map();
  }
```

Delete the `tree.activateWorkspace(...)` line at `engine.ts:402` outright.

- [ ] **Step 4: Lay out visible workspaces only**

Replace the layout loop (`engine.ts:423-431`):

```ts
      for (const output of topology.monitors) {
        const index = tree.visible.get(output.id);
        if (index === undefined) continue;
        const ws = tree.workspace(index);
        const layout = layoutWithRects(ws.root, topology.workAreas.get(output.id)!, this._rowHeight);
        for (const [con, rect] of layout.containers) this._containerRects.set(con, rect);
        for (const [id, rect] of layout.windows) {
          const info = this._ports.windows.get(id);
          /* the body of the inner loop is unchanged */
        }
      }
```

A parked workspace's windows are not on screen, so their geometry is unobservable until the swap that
shows them recomputes it (Task 6, step 4).

- [ ] **Step 5: Derive pills from the tree**

Replace `_pills` (`engine.ts:471-484`). `focused` and `visible` arrive in Task 8 with `PillState`; here
only the *source* of `occupied` and `urgent` changes, from `WindowInfo.workspace` to the tree:

```ts
    const tree = this._tree;
    this._pills = Array.from({length: this._workspaceCount}, (_, index) => {
      // From the tree, never from WindowInfo.workspace: under the attic that field is 0 or 1 for
      // every window, so a workspace's occupancy is not observable from Mutter any more.
      const members = tree ? this._workspaceMembers(tree, index) : [];
      const active = tree ? tree.activeWorkspace === index : index === 0;
      return {
        name: displayWorkspaceName(
          this._config.workspaceNames.get(index + 1) ?? String(index + 1),
          this._config.stripWorkspaceNumbers,
        ),
        active,
        occupied: members.length > 0,
        urgent: !active && members.some(id => this._windows.get(id)?.urgent === true),
      };
    });
```

with:

```ts
  /** Every window the tree places on a workspace, tiled or floating. */
  private _workspaceMembers(tree: Tree, index: number): WindowId[] {
    if (!tree.workspaces.has(index)) return [];
    const ws = tree.workspace(index);
    return [...[...leaves(ws.root)].map(leaf => leaf.window), ...ws.floating];
  }
```

Import `leaves` from `./tree/node` if it is not already imported.

- [ ] **Step 6: Place a new window on the focused output's visible workspace**

In `_syncWindow`, every use of `info.workspace` to choose a target workspace becomes the tree's own
answer. For a window the tree does not yet know:

```ts
      // The engine is the authority now (spec 2.6). Mutter's workspace for this window is 0 or 1 and
      // says nothing about which i3 workspace it belongs to.
      const target = existing ? existing.workspace : this._adoptionWorkspace(tree, info);
```

```ts
  /**
   * Where a window the tree has not seen belongs: the visible workspace of the output it is on.
   *
   * On enable its pre-enable workspace is unrecoverable — reducing num-workspaces to 2 makes Mutter
   * collapse the removed workspaces — but its output is observable and is what the user sees.
   */
  private _adoptionWorkspace(tree: Tree, info: WindowInfo): number {
    return tree.visible.get(info.monitor) ?? tree.activeWorkspace;
  }
```

- [ ] **Step 7: Read `_launcherArea` from the focused output**

Replace the body of `_launcherArea` (`engine.ts:921-950`) entirely. The selection-walking and both
fallback warnings go: the focused output is stored state and always answers.

```ts
  private _launcherArea(): Rect | null {
    const topology = this._topology;
    if (!topology || !this._tree) return null;
    // Stored state, not inferred from the selection. An output whose visible workspace is empty has
    // no selection to read, which is why the launcher used to open on the primary instead.
    return topology.workAreas.get(this._tree.focusedOutput)
      ?? topology.workAreas.get(topology.primary)
      ?? null;
  }
```

- [ ] **Step 8: Expose `focusedOutput` on the state payload**

In the `state()` return (`engine.ts:759`), add `focusedOutput: this._tree?.focusedOutput ?? null`, and
add `focusedOutput: MonitorId | null` to the state interface at `engine.ts:96`.

- [ ] **Step 9: Migrate the four affected test files**

`engine.test.ts`, `engine/lifecycle.test.ts`, `engine/commands.test.ts` and `runtime/snapshot.test.ts`
construct monitors and assert on `location().monitor`, per-monitor roots, and pills keyed by GNOME
workspace. Apply the same mechanical rules as Task 3 Step 5. A test that asserted a window lands on the
workspace Mutter reported now asserts it lands on the visible workspace of the output Mutter reported —
that is the behaviour change, not a broken test.

- [ ] **Step 10: Run everything**

Run: `npm test && npm run typecheck && npm run check:layer0`

Expected: **the full suite green and the typecheck clean.** This is the task where both come back; if
either is red, do not proceed to Task 6.

- [ ] **Step 11: Mutation-prove the pill source**

The occupancy test would pass against the old `w.workspace === index` whenever a window happens to sit
on GNOME workspace 0 and i3 workspace 0 at once. Change `_workspaceMembers` to
`[...this._windows.values()].filter(w => w.workspace === index).map(w => w.id)` and run
`npx vitest run test/unit/engine.test.ts`.

Expected: `derives a pill's occupancy from the tree` fails, with `pills[1].occupied` received `false`.
Restore, re-run, record both outputs. If it *passes* with the mutation, the test is placing its window
on an output whose visible workspace index equals its GNOME workspace index — change the fixture so the
two differ, as the one above does by putting the window on output 1 / workspace 1 via GNOME workspace 0.

- [ ] **Step 12: Commit**

```bash
git add src/engine.ts src/tree/tree.ts test/unit/engine.test.ts test/unit/engine test/unit/runtime/snapshot.test.ts
git commit -m "refactor(engine): take workspace membership from the tree, not from Mutter

WindowInfo.workspace is a GNOME workspace index. Under the attic it is 0
or 1 for every window, so the pills' occupancy and urgency, the adoption
of an existing window, and tree.activateWorkspace would all have
computed nonsense while staying green. The tree is the authority; Mutter
is driven for workspace membership, never read.

The launcher now reads the focused output directly, which removes both
of the fallbacks that made it open on the primary when the focused
output had no window to infer from. Only visible workspaces are laid
out: two roots instead of twenty."
```

---

## Task 6: The attic — two GNOME workspaces, and the swap

GNOME drops to two workspaces: `live` (index 0, active for the extension's whole lifetime) and `attic`
(index 1). Parking a window there hides it using Mutter's own rule that a non-active workspace is not
rendered — genuinely unmapped, no input, no window list. Nothing is minimised and no actor is hidden.

**Files:**
- Modify: `src/runtime/model.ts` (the two constants)
- Modify: `src/shell/settings.ts:84-95` and `src/shell/settings.ts:5-11`
- Modify: `src/engine.ts` (the swap, the guard in `onWorkspacesChanged`)
- Modify: `src/config/overridePlan.ts`
- Test: `test/unit/shell/settings.test.ts`, `test/unit/config/overridePlan.test.ts`, `test/unit/engine.test.ts`

**Interfaces:**
- Produces: `LIVE_WORKSPACE = 0` and `ATTIC_WORKSPACE = 1` in `src/runtime/model.ts`; `Engine._showOnOutput(output: MonitorId, incoming: number): void`, whose only caller is Task 7 — Task 15 parks inline because `moveWorkspaceToOutput` has already changed visibility, and Task 16 uses `_reconcileParking` instead.

- [ ] **Step 1: Write the failing tests**

`test/unit/shell/settings.test.ts`:

```ts
it('holds GNOME at two workspaces regardless of the config count', () => {
  const h = settingsHarness();
  h.apply({...plan, workspaceCount: 10});
  expect(h.written('org.gnome.desktop.wm.preferences', 'num-workspaces')).toBe(2);
});

it('stops alt-tab listing parked windows', () => {
  const h = settingsHarness();
  h.apply({...plan, workspaceCount: 10});
  expect(h.written('org.gnome.shell.app-switcher', 'current-workspace-only')).toBe(true);
});

it('does not apply workspace-names: GNOME’s two workspaces name nothing the user sees', () => {
  const h = settingsHarness();
  h.apply({...plan, workspaceCount: 10});
  expect(h.written('org.gnome.desktop.wm.preferences', 'workspace-names')).toBeUndefined();
});

it('restores num-workspaces, current-workspace-only and workspace-names on restore', () => {
  const h = settingsHarness();
  h.apply({...plan, workspaceCount: 10});
  h.restoreAll();
  expect(h.restored()).toContain('org.gnome.desktop.wm.preferences/num-workspaces');
  expect(h.restored()).toContain('org.gnome.shell.app-switcher/current-workspace-only');
  expect(h.restored()).toContain('org.gnome.desktop.wm.preferences/workspace-names');
});

it('clears GNOME’s own workspace-switch bindings so the active workspace cannot leave live', () => {
  const h = settingsHarness({existing: {'org.gnome.desktop.wm.keybindings': {'switch-to-workspace-1': ['<Super>1']}}});
  h.apply({...plan, workspaceCount: 10});
  expect(h.written('org.gnome.desktop.wm.keybindings', 'switch-to-workspace-1')).toEqual([]);
});
```

`test/unit/engine.test.ts`:

```ts
it('parks the outgoing workspace’s windows and un-parks the incoming ones', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});   // lands on workspace 0, visible on output 0
  h.addWindow({id: 2, workspace: 0, monitor: 0});
  h.engine.showOnOutputForTest(0, 4);
  expect(h.windows.workspaceOf(1)).toBe(1);        // ATTIC
  expect(h.windows.workspaceOf(2)).toBe(1);
  h.engine.showOnOutputForTest(0, 0);
  expect(h.windows.workspaceOf(1)).toBe(0);        // LIVE
});

it('does nothing when the incoming workspace is the one already shown', () => {
  // Review Focus 2: the naive swap would park and immediately un-park, flashing the screen.
  const h = harness({monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  const before = h.windows.moveCount();
  h.engine.showOnOutputForTest(0, 0);
  expect(h.windows.moveCount()).toBe(before);
});

it('keeps focus on the incoming workspace’s selection, not on Mutter’s replacement pick', () => {
  const h = harness({monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.engine.showOnOutputForTest(0, 4);
  h.addWindow({id: 2, workspace: 0, monitor: 0});   // now on workspace 4
  h.engine.showOnOutputForTest(0, 0);
  expect(h.windows.activated()).toEqual([1]);
});

it('warns and continues when Mutter refuses to move a window', () => {
  // Review Focus 1: a half-swapped output is recoverable; an exception mid-swap is not.
  const h = harness({monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.addWindow({id: 2, workspace: 0, monitor: 0});
  h.windows.refuseMove(1);
  expect(() => h.engine.showOnOutputForTest(0, 4)).not.toThrow();
  expect(h.windows.workspaceOf(2)).toBe(1);
  expect(h.log.warnings().join('\n')).toMatch(/could not park window 1/);
});

it('forces the active GNOME workspace back to live and warns', () => {
  const h = harness({monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
  h.workspaces.setActiveIndex(1);
  h.engine.onWorkspacesChanged();
  expect(h.workspaces.activated()).toContain(0);
  expect(h.log.warnings().join('\n')).toMatch(/active workspace left live/);
});
```

`showOnOutputForTest` is a thin public wrapper the engine exposes for the suite, in the same spirit as
the existing `focusWindow`/`focusContainer` entry points; name it to match that file's convention.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/shell/settings.test.ts test/unit/engine.test.ts`

Expected: `num-workspaces` written as 10, `current-workspace-only` absent, `showOnOutputForTest` not a
function. Paste the real output.

- [ ] **Step 3: Add the constants**

`src/runtime/model.ts`:

```ts
/**
 * GNOME holds exactly two workspaces while the extension is enabled.
 *
 * `live` is the active one for the extension's whole lifetime and holds every window that should be on
 * screen. `attic` holds every window on a workspace no output is showing: Mutter does not render a
 * non-active workspace, so this is the hiding primitive, and it costs nothing.
 */
export const LIVE_WORKSPACE = 0;
export const ATTIC_WORKSPACE = 1;
```

- [ ] **Step 4: Change the settings**

`src/shell/settings.ts`. Add `'org.gnome.shell.app-switcher'` handling and the workspace keys:

```ts
    if (plan.workspaceCount > 0) {
      const mutter = this._settings(MUTTER);
      if (mutter)
        this._applyValue(MUTTER, mutter, 'dynamic-workspaces', false);
      const prefs = this._settings(WM_PREFS);
      // Two, always: `live` plus the attic. The config's own workspace count is i3-shell's notion and
      // GNOME no longer represents it, so applying workspace-names would name nothing the user sees.
      if (prefs)
        this._applyValue(WM_PREFS, prefs, 'num-workspaces', 2);
      const switcher = this._settings(APP_SWITCHER);
      // Without this, alt-tab lists every parked window.
      if (switcher)
        this._applyValue(APP_SWITCHER, switcher, 'current-workspace-only', true);
    } else {
      this._restoreSaved(MUTTER, 'dynamic-workspaces');
      this._restoreSaved(WM_PREFS, 'num-workspaces');
      this._restoreSaved(APP_SWITCHER, 'current-workspace-only');
    }
    // Restored unconditionally: it was applied by earlier versions and a user upgrading in place must
    // get their own names back even though nothing applies them now.
    this._restoreSaved(WM_PREFS, 'workspace-names');
```

with `const APP_SWITCHER = 'org.gnome.shell.app-switcher';` beside the other schema constants, and
`'org.gnome.shell.app-switcher'` added to the snapshot set so `_restoreSaved` has something to restore.

`switch-to-workspace-*` needs no new code: `org.gnome.desktop.wm.keybindings` is already in
`KEYBINDING_SCHEMAS` (`settings.ts:5-11`), so any such binding equal to one of the config's accelerators
is already cleared. Add the explicit clear for the rest:

```ts
/**
 * GNOME's own workspace switching must never move the active workspace off `live`: every parked window
 * would appear at once and every visible one would vanish. These are cleared whatever they are bound
 * to, not only when they collide with a config accelerator.
 */
const WORKSPACE_SWITCH_KEYS = Array.from({length: 12}, (_, i) => `switch-to-workspace-${i + 1}`)
  .concat(['switch-to-workspace-left', 'switch-to-workspace-right',
           'switch-to-workspace-up', 'switch-to-workspace-down', 'switch-to-workspace-last']);
```

applied by clearing each present key to `[]` through `_applyValue`.

Drop `workspaceNames` from `OverridePlan` in `src/config/overridePlan.ts` and from `planOverrides`, and
update `test/unit/config/overridePlan.test.ts`. `displayWorkspaceName` stays — `_pills` still uses it.

- [ ] **Step 5: Implement the swap**

`src/engine.ts`:

```ts
  /**
   * Show workspace `incoming` on `output`. The five steps, in this order.
   *
   * Step 5 is the subtle one. Parking the focused window makes Mutter choose a replacement on its own,
   * which fires notify::focus-window, reaches _acceptFocus and calls _selectWindow on an arbitrary
   * window — silently corrupting the selection mid-swap. Bracketing the parking with _expectedFocus is
   * what tells _acceptFocus to ignore those reports. A window fake that confirms focus synchronously
   * cannot observe this, which is why Task 17 proves it natively too.
   */
  private _showOnOutput(output: MonitorId, incoming: number): void {
    const tree = this._tree;
    if (!tree) return;
    const outgoing = tree.visible.get(output);
    // Not merely an optimisation: parking and immediately un-parking the same windows flashes them.
    if (outgoing === incoming) return;
    this.commit(() => {
      const parked = outgoing === undefined ? [] : this._workspaceMembers(tree, outgoing);
      for (const id of parked) this._expectedFocus.add(id);
      for (const id of this._workspaceMembers(tree, incoming))
        if (!this._ports.windows.moveToWorkspace(id, LIVE_WORKSPACE))
          this._ports.log.warn(`could not show window ${id}; leaving it parked`);
      for (const id of parked)
        if (!this._ports.windows.moveToWorkspace(id, ATTIC_WORKSPACE))
          this._ports.log.warn(`could not park window ${id}; leaving it on screen`);
      tree.visible.set(output, incoming);
      tree.workspace(incoming).output = output;
      // 0 = no native event timestamp; the windows adapter substitutes the current server time.
      this._activateSelection(0);
      return true;
    });
  }
```

`_expectedFocus` is cleared by the first native focus report (`_acceptFocus` clears it wholesale), so
the adds above cover exactly the window in which Mutter's replacement pick arrives.

- [ ] **Step 6: Add the guard**

Replace `onWorkspacesChanged` (`engine.ts:266-271`):

```ts
  onWorkspacesChanged(): void {
    this.commit(() => {
      // GNOME's active workspace is a constant while the extension is enabled. Touchpad workspace
      // gestures have no GSetting to clear, so this is the only cover for them.
      if (this._started && !this._disposed && this._ports.workspaces.activeIndex !== LIVE_WORKSPACE) {
        this._ports.log.warn('active workspace left live; switching back');
        this._ports.workspaces.activate(LIVE_WORKSPACE, 0);
      }
      if (this._ports.workspaces.count !== 2)
        this._ports.settings.apply(this._config, this._workspaceCount);
    });
  }
```

- [ ] **Step 7: Run the suite and the guards**

Run: `npm test && npm run typecheck && npm run check:layer0`

Expected: all green, including the five new settings tests and five new engine tests.

- [ ] **Step 8: Mutation-prove the `_expectedFocus` bracketing**

This is the assertion most likely to be vacuous. Delete the
`for (const id of parked) this._expectedFocus.add(id);` line and run
`npx vitest run test/unit/engine.test.ts`.

Expected: `keeps focus on the incoming workspace's selection` fails. **If it still passes, the test is
worthless** — the fake is not reporting a replacement focus when a focused window is parked. In that
case teach the windows fake to emit a `focused` event naming another live window when the focused one
moves to a non-active workspace, which is what Mutter does, and re-run. Record both outputs and any fake
change.

- [ ] **Step 9: Commit**

```bash
git add src/runtime/model.ts src/shell/settings.ts src/config/overridePlan.ts src/engine.ts test/unit/shell/settings.test.ts test/unit/config/overridePlan.test.ts test/unit/engine.test.ts
git commit -m "feat(engine): park hidden workspaces in a GNOME attic workspace

GNOME drops to two workspaces: live, active for the extension's
lifetime, and an attic. Mutter does not render a non-active workspace, so
parking is the hiding primitive and costs nothing; nothing is minimised,
which would collide with excludedFromTree, and no actor is hidden, which
would leave the window focusable.

The swap brackets its parking in _expectedFocus: parking the focused
window makes Mutter pick a replacement, and without the bracket
_acceptFocus would select an arbitrary window mid-swap. A refused move
warns and continues rather than throwing, because a half-swapped output
is recoverable and an exception is not.

Also clears GNOME's switch-to-workspace bindings and guards
active-workspace-changed, since touchpad gestures have no GSetting."
```

---

## Task 7: `workspace N` follows the workspace to its output

**Files:**
- Modify: `src/tree/tree.ts` (`showWorkspace`)
- Modify: `src/engine.ts` (the `workspace` command case)
- Test: `test/unit/tree/outputsModel.test.ts`, `test/unit/engine/commands.test.ts`

**Interfaces:**
- Consumes: `Engine._showOnOutput` from Task 6.
- Produces: `tree.showWorkspace(index: number): {output: MonitorId; swap: boolean}` — `swap` false means the workspace was already visible and only focus moved.

- [ ] **Step 1: Write the failing tests**

`test/unit/tree/outputsModel.test.ts`:

```ts
describe('showWorkspace', () => {
  it('moves focus to the output already showing that workspace, and swaps nothing', () => {
    const t = new Tree(10, outputs, 3);           // 0 on primary 3, 1 on 2
    expect(t.showWorkspace(1)).toEqual({output: 2, swap: false});
    expect(t.focusedOutput).toBe(2);
    expect(t.visible.get(3)).toBe(0);
  });

  it('brings an unshown workspace to the focused output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.showWorkspace(4)).toEqual({output: 3, swap: true});
    expect(t.outputOf(4)).toBe(3);
    expect(t.focusedOutput).toBe(3);
  });

  it('brings an unshown workspace to whichever output is focused', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    expect(t.showWorkspace(4)).toEqual({output: 2, swap: true});
    expect(t.outputOf(4)).toBe(2);
  });

  it('is a no-op for the workspace already visible on the focused output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.showWorkspace(0)).toEqual({output: 3, swap: false});
  });

  it('never leaves an output showing a workspace it does not own', () => {
    const t = new Tree(10, outputs, 3);
    t.showWorkspace(4);
    for (const [output, index] of t.visible) expect(t.outputOf(index)).toBe(output);
  });
});
```

`test/unit/engine/commands.test.ts`:

```ts
it('workspace number moves focus to the output holding that workspace', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.run('workspace number 2');
  expect(h.state().focusedOutput).toBe(1);
});

it('workspace number brings an unshown workspace to the focused output', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.run('workspace number 5');
  expect(h.state().focusedOutput).toBe(0);
  expect(h.tree().outputOf(4)).toBe(0);
  expect(h.tree().visible.get(1)).toBe(1);   // the other output did not move
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/tree/outputsModel.test.ts test/unit/engine/commands.test.ts`

Expected: `t.showWorkspace is not a function`. Paste the real output.

- [ ] **Step 3: Implement `showWorkspace`**

`src/tree/tree.ts`:

```ts
  /**
   * i3's `workspace N`. Two cases, and only two.
   *
   * Visible somewhere already: move the focused output to it, changing no window's workspace — this is
   * i3's "go to where that workspace is", and it is why a keypress can move you to another screen.
   * Not visible: bring it to the focused output, which is what i3 does for a workspace that does not
   * exist yet. With the fixed set of workspaces this design keeps, "not yet placed" plays that role.
   */
  showWorkspace(index: number): {output: MonitorId; swap: boolean} {
    this.workspace(index);
    for (const [output, visible] of this.visible) {
      if (visible !== index) continue;
      this.focusedOutput = output;
      return {output, swap: false};
    }
    const output = this.focusedOutput;
    this.workspace(index).output = output;
    this.visible.set(output, index);
    return {output, swap: true};
  }
```

Note `showWorkspace` sets `visible` itself, so the engine must not call `_showOnOutput` for the same
workspace afterwards — see Step 4.

- [ ] **Step 4: Wire the command**

In `_runOne`'s `case 'workspace':`, replace the `workspaces.activate(...)` call. The engine needs the
window moves that `showWorkspace` does not do, so it reads the *outgoing* workspace before asking:

```ts
      case 'workspace': {
        const tree = this._tree;
        if (!tree) return 'workspace: not ready';
        const index = this._resolveWorkspaceTarget(command.target);
        if (index === null) return 'workspace: unknown target';
        const outgoing = tree.visible.get(tree.focusedOutput);
        const {output, swap} = tree.showWorkspace(index);
        if (swap && outgoing !== undefined && outgoing !== index)
          this._parkAndShow(output, outgoing, index);
        this._activateSelection(0);
        return 'workspace';
      }
```

Refactor Task 6's `_showOnOutput` into `_parkAndShow(output, outgoing, incoming)` — the same body with
`tree.visible.set` and `workspace.output` assignment removed, since `showWorkspace` has already done
them — and keep `_showOnOutput(output, incoming)` as the wrapper that reads `outgoing` itself, calls
`tree.visible.set`/`workspace.output`, and delegates. Tasks 14 and 15 call `_showOnOutput`.

`_resolveWorkspaceTarget` is the existing helper behind `move_to_workspace`; reuse it rather than
writing a second resolver.

- [ ] **Step 5: Run the suite**

Run: `npm test && npm run typecheck`

Expected: all green.

- [ ] **Step 6: Mutation-prove the already-visible branch**

Change `return {output, swap: false};` to `return {output, swap: true};` and run
`npx vitest run test/unit/tree/outputsModel.test.ts test/unit/engine/commands.test.ts`.

Expected: `moves focus to the output already showing that workspace` fails on `swap`, and the engine
test `workspace number moves focus to the output holding that workspace` still passes — which is itself
worth recording, because it shows the engine test alone does not cover the distinction. Restore and
record both outputs.

- [ ] **Step 7: Commit**

```bash
git add src/tree/tree.ts src/engine.ts test/unit/tree/outputsModel.test.ts test/unit/engine/commands.test.ts
git commit -m "feat(tree): workspace N follows the workspace to its output

Visible already: move the focused output to it and change no window's
workspace. Not visible: bring it to the focused output. Both are i3's
behaviour, the second being what i3 does for a workspace that does not
exist yet.

The same-workspace case returns swap: false so the engine parks nothing;
parking and immediately un-parking the same windows would flash them."
```

---

## Task 8: Per-output pills, and i3bar's focused-versus-visible distinction

i3 separates a workspace that is **focused** from one merely **visible** on another output. `PillState`
collapses both into `active`, which cannot express a two-output desktop: with workspace I on the primary
and II on the television, both are on screen and exactly one is focused.

**Files:**
- Modify: `src/runtime/model.ts` (`PillState`)
- Modify: `src/shell/util/pills.ts` (`samePills`, `stylePill`)
- Modify: `src/shell/indicator.ts`, `src/shell/bars.ts`
- Modify: `src/engine.ts` (`_pills` → `_pillsByOutput`, the `IndicatorPort` signature at `engine.ts:60-ish`)
- Modify: `resources/stylesheet.css` (the `visible` class)
- Test: `test/unit/shell/pills.test.ts`, `test/unit/shell/indicator.test.ts`, `test/unit/shell/bars.test.ts`, `test/unit/engine.test.ts`

**Interfaces:**
- Produces: `PillState = {name: string; focused: boolean; visible: boolean; occupied: boolean; urgent: boolean}`; `IndicatorPort.setPills(byOutput: ReadonlyMap<MonitorId, readonly PillState[]>): void`.

- [ ] **Step 1: Write the failing tests**

`test/unit/shell/pills.test.ts`:

```ts
const pill = (over: Partial<PillState> = {}): PillState =>
  ({name: 'I', focused: false, visible: false, occupied: false, urgent: false, ...over});

it('samePills compares all five fields', () => {
  expect(samePills([pill()], [pill({visible: true})])).toBe(false);
  expect(samePills([pill()], [pill({focused: true})])).toBe(false);
  expect(samePills([pill()], [pill({urgent: true})])).toBe(false);
  expect(samePills([pill()], [pill({occupied: true})])).toBe(false);
  expect(samePills([pill()], [pill({name: 'II'})])).toBe(false);
  expect(samePills([pill()], [pill()])).toBe(true);
});

it('styles focused ahead of urgent', () => {
  const button = new St.Button({});
  stylePill(button, pill({focused: true, urgent: true, visible: true}), colors);
  expect(button.get_style()).toContain(colors.focused.background);
});

it('styles urgent ahead of visible', () => {
  const button = new St.Button({});
  stylePill(button, pill({urgent: true, visible: true}), colors);
  expect(button.get_style()).toContain(colors.urgent.background);
});

it('styles a workspace visible on another output distinctly from an idle one', () => {
  const onOther = new St.Button({});
  stylePill(onOther, pill({visible: true, occupied: true}), colors);
  const idle = new St.Button({});
  stylePill(idle, pill({occupied: true}), colors);
  expect(onOther.get_style()).not.toEqual(idle.get_style());
  expect(onOther.get_style()).toContain(colors.focusedInactive.background);
});

it('keeps the urgent ring off a focused pill', () => {
  const button = new St.Button({});
  stylePill(button, pill({focused: true, urgent: true}), colors);
  expect(button.style_class).toBe('i3-shell-ws');
});
```

`test/unit/engine.test.ts`:

```ts
it('marks the workspace on the focused output focused, and the other output’s visible', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  const pills = h.state().pills;
  expect(pills[0]!.focused).toBe(true);
  expect(pills[0]!.visible).toBe(true);
  expect(pills[1]!.focused).toBe(false);
  expect(pills[1]!.visible).toBe(true);     // on screen, on the other output
  expect(pills[2]!.visible).toBe(false);
});

it('gives each output only its own workspaces’ pills', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  const byOutput = h.indicator.lastPills();
  expect(byOutput.get(1)!.map(p => p.name)).toEqual(['II']);
  expect(byOutput.get(0)!.map(p => p.name)).toEqual(['I', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/shell/pills.test.ts test/unit/engine.test.ts`

Expected: `focused`/`visible` are not properties of `PillState`, and `lastPills()` returns an array
rather than a map. Paste the real output.

- [ ] **Step 3: Change `PillState`**

`src/runtime/model.ts`:

```ts
export interface PillState {
  name: string;
  /** Visible on the focused output. At most one pill across all outputs is focused. */
  focused: boolean;
  /** Visible on some output — possibly another one. i3bar's third state, which `active` could not express. */
  visible: boolean;
  occupied: boolean;
  /**
   * Any window the tree places on this workspace is urgent and this workspace is not focused. Derived
   * per commit from the tree, never separate state. Focusing a workspace is how i3 clears it.
   *
   * Styled from client.urgent: i3 takes bar colours from `bar { colors { … } }` and this project
   * ignores the bar block, so client.urgent is the only urgent colour the config supplies. A deliberate
   * divergence; see the spec.
   */
  urgent: boolean;
}
```

- [ ] **Step 4: Change `samePills` and `stylePill`**

`src/shell/util/pills.ts`:

```ts
export function samePills(current: readonly PillState[], next: readonly PillState[]): boolean {
  return current.length === next.length && current.every((pill, index) =>
    pill.name === next[index].name && pill.focused === next[index].focused &&
    pill.visible === next[index].visible && pill.occupied === next[index].occupied &&
    pill.urgent === next[index].urgent);
}
```

Every field is compared because this diff is the only thing that makes a state change reach the screen:
a field missing here is a feature that is dead at runtime with its own unit test green, which is exactly
how the `urgent` field shipped inert once already.

```ts
export function stylePill(pill: St.Button, state: PillState, colors: Colors): void {
  pill.label = state.name;
  pill.style_class = state.urgent && !state.focused ? 'i3-shell-ws i3-shell-ws-urgent' : 'i3-shell-ws';
  // Precedence: focused, then urgent, then visible on another output, then merely occupied.
  if (state.focused) {
    pill.set_style(`background-color: ${colors.focused.background}; color: ${colors.focused.text};`);
    pill.opacity = 255;
  } else if (state.urgent) {
    pill.set_style(`background-color: ${colors.urgent.background}; color: ${colors.urgent.text};`);
    pill.opacity = 255;
  } else if (state.visible) {
    // i3's client.focused_inactive: on screen, but not where the keyboard is.
    pill.set_style(
      `background-color: ${colors.focusedInactive.background}; color: ${colors.focusedInactive.text};`);
    pill.opacity = 255;
  } else {
    pill.set_style(`background-color: transparent; color: ${colors.unfocused.text};`);
    pill.opacity = state.occupied ? 255 : 128;
  }
}
```

- [ ] **Step 5: Publish pills per output**

In `src/engine.ts`, replace `_pills: PillState[]` with
`_pillsByOutput: Map<MonitorId, PillState[]> = new Map()`, and build it from the tree:

```ts
    const byOutput = new Map<MonitorId, PillState[]>();
    if (tree) {
      const focusedWorkspace = tree.activeWorkspace;
      const visibleSet = new Set(tree.visible.values());
      for (const output of tree.visible.keys()) {
        byOutput.set(output, tree.workspacesOn(output).map(index => {
          const members = this._workspaceMembers(tree, index);
          const focused = index === focusedWorkspace;
          return {
            name: displayWorkspaceName(
              this._config.workspaceNames.get(index + 1) ?? String(index + 1),
              this._config.stripWorkspaceNumbers,
            ),
            focused,
            visible: visibleSet.has(index),
            occupied: members.length > 0,
            urgent: !focused && members.some(id => this._windows.get(id)?.urgent === true),
          };
        }));
      }
    }
    this._pillsByOutput = byOutput;
    this._ports.indicator.setPills(this._copyPillsByOutput());
```

`state()`'s `pills` field keeps its flat, workspace-ordered shape for `GetState` — build it by walking
workspaces 0..N-1 and reading the pill out of `byOutput` — so `test/unit/shell/controlObject.test.ts`
and the integration checks keep a stable surface.

In `src/shell/indicator.ts` the panel indicator renders the **primary's** list; `src/shell/bars.ts`
renders each non-primary output's own. `bars.ts:44-45` already documents that split; update the comment
to say each bar now shows its own output's workspaces rather than the same ones everywhere. A pill click
still issues `workspace <n>`, i3bar's own behaviour, so a click on the television's `II` focuses the
television.

- [ ] **Step 6: Add the stylesheet class**

`resources/stylesheet.css` needs nothing new if `focusedInactive` is applied inline as above; confirm by
grepping for `i3-shell-ws` in that file and adding a rule only if the urgent class's neighbours require
one for the border geometry. Record which it was.

- [ ] **Step 7: Run the suite**

Run: `npm test && npm run typecheck && npm run check:layer0`

Expected: all green.

- [ ] **Step 8: Mutation-prove the `visible` comparison**

Drop `pill.visible === next[index].visible` from `samePills` and run
`npx vitest run test/unit/shell/pills.test.ts`. Expected: `samePills compares all five fields` fails on
the first expectation. Restore and record both outputs.

- [ ] **Step 9: Commit**

```bash
git add src/runtime/model.ts src/shell/util/pills.ts src/shell/indicator.ts src/shell/bars.ts src/engine.ts resources/stylesheet.css test/unit/shell test/unit/engine.test.ts
git commit -m "feat(bar): give each output its own pills, and split focused from visible

i3 distinguishes a focused workspace from one merely visible on another
output; PillState collapsed both into active, which cannot describe a
two-output desktop where two workspaces are on screen and one is
focused. Precedence is focused, urgent, visible, occupied.

samePills compares all five fields, because that diff is the only thing
that makes a state change reach the screen -- a field missing there is a
feature that is dead at runtime with its unit test green, which is how
urgent shipped inert once already."
```

---

## Task 9: `TreeSnapshot` version 2

`GetTree` is a public D-Bus surface and `test/integration/phase2-checks.py` parses it, so the shape
change gets a version bump rather than a silent edit.

**Files:**
- Modify: `src/runtime/snapshot.ts`
- Modify: `test/integration/phase2-checks.py`
- Test: `test/unit/runtime/snapshot.test.ts`, `test/unit/shell/controlObject.test.ts`

**Interfaces:**
- Produces: `TreeSnapshot` with `version: 2`, a top-level `focusedOutput: MonitorId | null` and `visible: Array<{output: MonitorId; workspace: number}>`, and each workspace carrying `output: MonitorId`, `workArea: Rect | null` and one `root: NodeSnapshot`.

- [ ] **Step 1: Write the failing test**

`test/unit/runtime/snapshot.test.ts`:

```ts
it('is version 2 and gives each workspace one root and one output', () => {
  const {tree, topology} = fixture({monitors: [{id: 3, index: 1}, {id: 2, index: 0}], primary: 3});
  const snap = serializeTree(tree, topology, new Map(), new Map(), 7, 0);
  expect(snap.version).toBe(2);
  const first = snap.workspaces[0]!;
  expect(first.output).toBe(3);
  expect(first.root.kind).toBe('split');
  expect('monitors' in first).toBe(false);
});

it('reports the focused output and what each output shows', () => {
  const {tree, topology} = fixture({monitors: [{id: 3, index: 1}, {id: 2, index: 0}], primary: 3});
  const snap = serializeTree(tree, topology, new Map(), new Map(), 7, 0);
  expect(snap.focusedOutput).toBe(3);
  expect(snap.visible).toEqual([{output: 3, workspace: 0}, {output: 2, workspace: 1}]);
});

it('gives a workspace the work area of its own output', () => {
  const {tree, topology} = fixture({monitors: [{id: 3, index: 1}, {id: 2, index: 0}], primary: 3});
  const snap = serializeTree(tree, topology, new Map(), new Map(), 7, 0);
  expect(snap.workspaces[1]!.workArea).toEqual(topology.workAreas.get(2));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/runtime/snapshot.test.ts`

Expected: `version` received 1, and `workspaces[0].output` undefined. Paste the real output.

- [ ] **Step 3: Implement**

`src/runtime/snapshot.ts`:

```ts
export interface TreeSnapshot {
  version: 2;
  revision: number;
  ready: boolean;
  activeWorkspace: number;
  /** Null before the first topology; every other field is meaningless then too. */
  focusedOutput: MonitorId | null;
  /** What each output currently shows, in the tree's output order. */
  visible: Array<{output: MonitorId; workspace: number}>;
  workspaces: Array<{
    index: number;
    output: MonitorId;
    workArea: Rect | null;
    selected: {kind: 'tiled'; nodeId: NodeId} | {kind: 'floating'; window: WindowId} | null;
    floating: WindowId[];
    root: NodeSnapshot;
  }>;
}
```

and the return:

```ts
  return {
    version: 2, revision, ready: true, activeWorkspace: tree.activeWorkspace,
    focusedOutput: tree.focusedOutput,
    visible: [...tree.visible].map(([output, workspace]) => ({output, workspace})),
    workspaces: [...tree.workspaces.values()].map(ws => {
      const selection = tree.selection(ws.index);
      const area = topology.workAreas.get(ws.output);
      return {
        index: ws.index,
        output: ws.output,
        workArea: area ? {...area} : null,
        selected: selection?.kind === 'tiled'
          ? {kind: 'tiled', nodeId: selection.con.id} : selection ? {...selection} : null,
        floating: [...ws.floating],
        root: node(ws.root),
      };
    }),
  };
```

The `ready: false` early return in `engine.treeSnapshot()` (`engine.ts:206-209`) needs
`version: 2, focusedOutput: null, visible: []`.

- [ ] **Step 4: Update the integration parser**

`test/integration/phase2-checks.py` walks `workspaces[].monitors[]`. Change it to read
`workspaces[].root` with `workspaces[].output`, and assert `version == 2`. Do not leave it accepting
both shapes: a checker that tolerates the old shape cannot detect a regression to it.

- [ ] **Step 5: Run the suite**

Run: `npm test && npm run typecheck`

Expected: all green. The controller runs the integration suite separately.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/snapshot.ts src/engine.ts test/unit/runtime/snapshot.test.ts test/unit/shell/controlObject.test.ts test/integration/phase2-checks.py
git commit -m "feat(control): TreeSnapshot version 2, one root and one output per workspace

GetTree is a public D-Bus surface and the integration checker parses it,
so the shape change is versioned rather than edited silently. Adds
focusedOutput and the visible map, which is what a client needs to know
which screen a workspace is on."
```

---

## Task 10: `workspace <N> output <name…>` in the config

**Files:**
- Modify: `src/config/parser.ts:28-36` (drop `'workspace'` from `UNSUPPORTED`; add the directive)
- Modify: `src/config/model.ts` (`Config.workspaceOutputs`)
- Modify: `src/engine.ts` (`_pinnedOutputs`)
- Test: `test/unit/config/parser.test.ts`, `test/unit/engine.test.ts`

**Interfaces:**
- Produces: `Config.workspaceOutputs: Map<number, {names: string[]; line: number}>`. The engine resolves it against the live connector list; the line number is carried so the unresolvable case can warn where the user wrote it.

- [ ] **Step 1: Write the failing tests**

`test/unit/config/parser.test.ts`:

```ts
it('parses workspace N output', () => {
  const {config, diagnostics} = parse('workspace 2 output DP-1\n');
  expect(diagnostics).toEqual([]);
  expect(config.workspaceOutputs.get(1)).toEqual({names: ['DP-1'], line: 1});
});

it("takes the workspace number from a name's leading digits, as workspace number does", () => {
  const {config} = parse('workspace "3:III" output HDMI-1\n');
  expect(config.workspaceOutputs.get(2)).toEqual({names: ['HDMI-1'], line: 1});
});

it("accepts i3's list of outputs, first live one winning at resolution", () => {
  const {config} = parse('workspace 1 output primary DP-1 HDMI-1\n');
  expect(config.workspaceOutputs.get(0)!.names).toEqual(['primary', 'DP-1', 'HDMI-1']);
});

it('warns on a workspace directive with no output clause, rather than accepting it silently', () => {
  const {diagnostics} = parse('workspace 1 gaps inner 5\n');
  expect(diagnostics.map(d => d.severity)).toEqual(['warning']);
  expect(diagnostics[0]!.message).toMatch(/workspace/);
});

it('rejects a workspace directive whose number is not a number', () => {
  const {diagnostics} = parse('workspace bogus output DP-1\n');
  expect(diagnostics.map(d => d.severity)).toEqual(['warning']);
});
```

`test/unit/engine.test.ts`:

```ts
it('honours a pinned workspace output', () => {
  const h = harness({monitors: [{id: 0, index: 0, connectors: ['HDMI-1']},
                                {id: 1, index: 1, connectors: ['DP-1']}],
                     primary: 0, workspaceCount: 4,
                     config: 'workspace 3 output DP-1\n'});
  expect(h.tree().outputOf(2)).toBe(1);
});

it('warns with the config line when a pinned output is not attached, and falls back', () => {
  // Review Focus 3: a config written for another machine must still work here.
  const h = harness({monitors: [{id: 0, index: 0, connectors: ['HDMI-1']}],
                     primary: 0, workspaceCount: 4,
                     config: 'workspace 3 output VGA-9\n'});
  expect(h.tree().outputOf(2)).toBe(0);
  expect(h.log.warnings().join('\n')).toMatch(/line 1.*VGA-9/);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/config/parser.test.ts test/unit/engine.test.ts`

Expected: the current parser warns "workspace: not implemented" on every one of those lines, so
`config.workspaceOutputs` is undefined. Paste the real output.

- [ ] **Step 3: Parse the directive**

Remove `'workspace'` from the `UNSUPPORTED` set in `src/config/parser.ts:31`, and add a case beside the
other directives:

```ts
    case 'workspace': {
      // `workspace <number|name> output <name...>` is the only form implemented. Everything else i3
      // allows here (gaps, layout) still warns, so silence never means acceptance.
      const number = workspaceNumber(words[1]);
      if (number === null) {
        warn(line, `workspace: expected a workspace number, got '${words[1] ?? ''}'`);
        return;
      }
      if (words[2] !== 'output' || words.length < 4) {
        warn(line, `workspace: only 'workspace <n> output <name...>' is implemented`);
        return;
      }
      config.workspaceOutputs.set(number - 1, {names: words.slice(3), line});
      return;
    }
```

`workspaceNumber` is the existing helper behind `workspace number` — the leading-digits rule, so
`"3:III"` yields 3. Reuse it; do not write a second parser for the same grammar. Keys are stored
**zero-based** to match every other workspace index in the program.

Add to `Config` in `src/config/model.ts`:

```ts
  /**
   * `workspace N output <names>`: zero-based workspace index → the outputs it prefers, in order, with
   * the config line that said so. Names are resolved against the live connector list by the engine,
   * not here: at parse time no display is known, and a config written on another machine must load.
   */
  workspaceOutputs: Map<number, {names: string[]; line: number}>;
```

Initialise it to an empty `Map` wherever the parser builds its `Config`, and in every test fixture and
default-config helper the compiler names.

- [ ] **Step 4: Resolve the pins**

Replace the stub from Task 5 Step 3 in `src/engine.ts`:

```ts
  /**
   * `workspace N output <names>` resolved against the attached displays. First live name wins, `primary`
   * included. An unattached name warns once, naming the config line, and the workspace falls back to the
   * default assignment — a config written for a different desk must still load.
   */
  private _pinnedOutputs(): ReadonlyMap<number, MonitorId> {
    const topology = this._topology;
    const pinned = new Map<number, MonitorId>();
    if (!topology) return pinned;
    const byName = new Map<string, MonitorId>();
    for (const monitor of topology.monitors)
      for (const connector of monitor.connectors) byName.set(connector.toLowerCase(), monitor.id);
    for (const [workspace, {names, line}] of this._config.workspaceOutputs) {
      const resolved = names
        .map(name => name.toLowerCase() === 'primary' ? topology.primary : byName.get(name.toLowerCase()))
        .find(id => id !== undefined);
      if (resolved === undefined) {
        this._ports.log.warn(
          `line ${line}: no attached output matches ${names.join(' ')}; workspace ${workspace + 1} uses the default`);
        continue;
      }
      pinned.set(workspace, resolved);
    }
    return pinned;
  }
```

`_pinnedOutputs()` is read when the tree is constructed and when it is reconfigured, so a pin starts
working the moment its display is plugged in.

- [ ] **Step 5: Run the suite and the guards**

Run: `npm test && npm run typecheck && npm run check:layer0`

Expected: all green, including `test/unit/config/golden.test.ts` — if the reference config contains a
`workspace` line, its golden output changes from a warning to an accepted directive. Update the golden
and say so in the record.

- [ ] **Step 6: Commit**

```bash
git add src/config/parser.ts src/config/model.ts src/engine.ts test/unit/config test/unit/engine.test.ts
git commit -m "feat(config): implement workspace N output <name...>

Resolved against the attached connectors by the engine rather than the
parser: at parse time no display is known, and a config written on
another machine must still load. An unattached name warns with its
config line and the workspace falls back to the default assignment.

Other workspace directive forms still warn, so silence never means
acceptance."
```

---

## Task 11: `focus_follows_mouse` — one GSettings override

Mutter's `focus-mode = sloppy` **is** focus-follows-mouse, with i3's semantics: the window under the
pointer takes focus, crossing empty desktop leaves focus where it was. The existing chain then does
everything — `windows.ts:192` already watches `notify::focus-window` and `_acceptFocus` already calls
`_selectWindow`, so rule 1 of the focused-output state needs no new code at all.

**Files:**
- Modify: `src/config/parser.ts:30` (drop `'focus_follows_mouse'` from `UNSUPPORTED`), `src/config/model.ts`
- Modify: `src/config/overridePlan.ts`, `src/shell/settings.ts`
- Test: `test/unit/config/parser.test.ts`, `test/unit/config/overridePlan.test.ts`, `test/unit/shell/settings.test.ts`

**Interfaces:**
- Produces: `Config.focusFollowsMouse: boolean` (default `true`); `OverridePlan.focusMode: 'sloppy' | 'click'`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/config/parser.test.ts
it("defaults focus_follows_mouse to yes, as i3 does", () => {
  expect(parse('').config.focusFollowsMouse).toBe(true);
});
it('parses focus_follows_mouse no', () => {
  const {config, diagnostics} = parse('focus_follows_mouse no\n');
  expect(diagnostics).toEqual([]);
  expect(config.focusFollowsMouse).toBe(false);
});
it('warns on a focus_follows_mouse value it does not understand', () => {
  expect(parse('focus_follows_mouse perhaps\n').diagnostics.map(d => d.severity)).toEqual(['warning']);
});

// test/unit/config/overridePlan.test.ts
it('maps focus_follows_mouse to a GNOME focus mode', () => {
  expect(planOverrides({...config, focusFollowsMouse: true}).focusMode).toBe('sloppy');
  expect(planOverrides({...config, focusFollowsMouse: false}).focusMode).toBe('click');
});

// test/unit/shell/settings.test.ts
it('applies and restores focus-mode', () => {
  const h = settingsHarness();
  h.apply({...plan, focusMode: 'sloppy'});
  expect(h.written('org.gnome.desktop.wm.preferences', 'focus-mode')).toBe('sloppy');
  h.restoreAll();
  expect(h.restored()).toContain('org.gnome.desktop.wm.preferences/focus-mode');
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/config test/unit/shell/settings.test.ts`

Expected: `focusFollowsMouse` undefined; the parser warns "focus_follows_mouse: not implemented".
Paste the real output.

- [ ] **Step 3: Implement**

Remove `'focus_follows_mouse'` from `UNSUPPORTED`. Add a case using the same yes/no helper the other
boolean directives use (`workspaceAutoBackAndForth` is the nearest model):

```ts
    case 'focus_follows_mouse': {
      const value = booleanWord(words[1]);
      if (value === null) {
        warn(line, `focus_follows_mouse: expected yes or no, got '${words[1] ?? ''}'`);
        return;
      }
      config.focusFollowsMouse = value;
      return;
    }
```

`Config` gains, defaulting to `true`:

```ts
  /**
   * i3's default is yes, so a config that never mentions it still wants it. Maps to
   * org.gnome.desktop.wm.preferences focus-mode = sloppy, which is Mutter's own focus-follows-mouse and
   * has i3's semantics: the window under the pointer takes focus, empty desktop changes nothing.
   */
  focusFollowsMouse: boolean;
```

`OverridePlan` gains `focusMode: 'sloppy' | 'click'`, set by `planOverrides` from that boolean, and
`settings.ts` applies it beside `mouse-button-modifier`:

```ts
    const prefs = this._settings(WM_PREFS);
    if (prefs) {
      this._applyValue(WM_PREFS, prefs, 'mouse-button-modifier', plan.mouseButtonModifier);
      this._applyValue(WM_PREFS, prefs, 'focus-mode', plan.focusMode);
    }
```

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck`

Expected: all green. If the reference config sets `focus_follows_mouse`, the golden changes; update it.

- [ ] **Step 5: Commit**

```bash
git add src/config src/shell/settings.ts test/unit/config test/unit/shell/settings.test.ts
git commit -m "feat(config): implement focus_follows_mouse via GNOME focus-mode

sloppy is Mutter's own focus-follows-mouse and shares i3's semantics, so
the feature costs one override: the existing notify::focus-window watch
and _acceptFocus already turn a pointer-driven focus change into a
selection change. i3's default is yes, so a config that never mentions it
still gets it."
```

---

## Task 12: The pointer — an empty output becomes reachable, and `mouse_warping`

Two halves of one pair. Rule 4 of the focused-output state needs the pointer because an output whose
visible workspace is **empty** has no window to take focus — that is the defect on the unoccupied
workspaces. And `mouse_warping output`, i3's default, is what stops sloppy focus dragging focus straight
back to whatever sits under a stationary pointer every time a keyboard command changes output. Neither
works without the other, so they land together.

**Files:**
- Create: `src/shell/pointer.ts`
- Modify: `src/config/parser.ts:32` (drop `'mouse_warping'`), `src/config/model.ts`
- Modify: `src/engine.ts` (the `pointer` port, `onPointerOutput`, `_warpToFocusedOutput`)
- Modify: `src/extension.ts` (construct and wire it)
- Test: `test/unit/shell/pointer.test.ts`, `test/unit/config/parser.test.ts`, `test/unit/engine.test.ts`

**Interfaces:**
- Produces: `Config.mouseWarping: 'output' | 'none'` (default `'output'`); `PointerPort = {warpTo(rect: Rect): void}`; `new Pointer(tracker: SignalTracker, onCrossed: (monitorIndex: number) => void)`; `Engine.onPointerOutput(output: MonitorId): void`.

- [ ] **Step 1: Write the failing tests**

`test/unit/shell/pointer.test.ts` — a new file, following `test/unit/shell/windows.test.ts`'s pattern of
`vi.mock('gi://Clutter')` plus `await import(...)`:

```ts
it('reports a crossing only when the pointer changes output', async () => {
  const crossed: number[] = [];
  const h = await pointerHarness(index => crossed.push(index));
  h.movePointerTo(0, 10, 10);
  h.movePointerTo(0, 20, 20);   // same output: not a crossing
  h.movePointerTo(1, 4000, 30);
  h.movePointerTo(1, 4100, 30);
  expect(crossed).toEqual([1]);   // the first position establishes the baseline, it is not a crossing
});

it('warps the pointer to the centre of a rect', async () => {
  const h = await pointerHarness(() => {});
  h.pointer.warpTo({x: 3840, y: 28, width: 1920, height: 1052});
  expect(h.warps()).toEqual([[4800, 554]]);
});

it('disconnects its cursor subscription when the tracker is torn down', async () => {
  const h = await pointerHarness(() => {});
  h.tracker.disconnectAll();
  h.movePointerTo(1, 4000, 30);
  expect(h.crossings()).toEqual([]);
});
```

`test/unit/engine.test.ts`:

```ts
it('takes the focused output from the pointer when that output’s workspace is empty', () => {
  // The whole of the "$mod+d opens on the wrong screen" defect: output 1 shows an empty workspace, so
  // no window there can take focus and rule 1 can never fire.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.engine.onPointerOutput(1);
  expect(h.state().focusedOutput).toBe(1);
  expect(h.engine.launcherAreaForTest()).toEqual(h.topology.workAreas.get(1));
});

it('leaves the focused output alone when the pointer’s output has a window to focus', () => {
  // Sloppy focus owns that case; two mechanisms racing for it would flap.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.addWindow({id: 2, workspace: 1, monitor: 1});
  h.engine.onPointerOutput(1);
  expect(h.state().focusedOutput).toBe(0);
});

it('keeps the focused output when the pointer’s output empties under it', () => {
  // Review Focus 4: the launcher must not jump screens because a window closed.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 2, workspace: 1, monitor: 1});
  h.engine.onPointerOutput(1);
  h.closeWindow(2);
  expect(h.state().focusedOutput).toBe(1);
});

it('warps the pointer when a command changes output, and not when mouse_warping is none', () => {
  const warped = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  warped.run('focus output right');
  expect(warped.pointer.warps().length).toBe(1);
  const still = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0,
                         workspaceCount: 10, config: 'mouse_warping none\n'});
  still.run('focus output right');
  expect(still.pointer.warps()).toEqual([]);
});

it('does not warp while the launcher holds its grab', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.run('launcher');
  h.run('focus output right');
  expect(h.pointer.warps()).toEqual([]);
});
```

The last two depend on Task 13's `focus output`; write them now and expect them red until Task 13, or
move just those two into Task 13 — either is fine, but say which in the record.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/shell/pointer.test.ts test/unit/engine.test.ts`

Expected: `src/shell/pointer` unresolved; `engine.onPointerOutput is not a function`. Paste the real output.

- [ ] **Step 3: Implement the adapter**

`src/shell/pointer.ts`:

```ts
import Meta from 'gi://Meta';
import type {Rect} from '../tree/node';
import {guard, type SignalTracker} from './util/signals';

export interface PointerPort {
  /** Put the pointer at the centre of `rect`. i3's `mouse_warping output`. */
  warpTo(rect: Rect): void;
}

/**
 * The pointer, for the two things the focused output needs from it.
 *
 * Crossings feed rule 4: an output whose visible workspace is empty has no window to take focus, so
 * sloppy focus can never report it and the pointer is the only evidence the user is there.
 *
 * Every pointer motion reaches this class, so the handler must stay cheap: it reads the position, maps
 * it to a monitor index, and returns immediately unless that index changed. Emptiness is the engine's
 * question and is only asked on a real crossing.
 */
export class Pointer implements PointerPort {
  private _lastMonitor: number | null = null;

  constructor(tracker: SignalTracker, onCrossed: (monitorIndex: number) => void) {
    const cursor = global.backend.get_cursor_tracker();
    tracker.connect(cursor, 'position-invalidated', guard('position-invalidated', () => {
      const [x, y] = cursor.get_pointer();
      const monitor = global.display.get_monitor_index_for_rect(
        new Meta.Rectangle({x: Math.round(x), y: Math.round(y), width: 1, height: 1}));
      if (monitor === this._lastMonitor) return;
      const first = this._lastMonitor === null;
      this._lastMonitor = monitor;
      // The first report establishes where the pointer already is; it is not the user crossing.
      if (!first) onCrossed(monitor);
    }));
  }

  warpTo(rect: Rect): void {
    const seat = global.backend.get_default_seat();
    seat.warp_pointer(
      Math.round(rect.x + rect.width / 2),
      Math.round(rect.y + rect.height / 2));
  }
}
```

If `Meta.Rectangle` is unavailable on Mutter 18, use the plain-object overload
`global.display.get_monitor_index_for_rect({x, y, width: 1, height: 1})` and record which the API
accepted — do not guess, check against the running shell's introspection.

- [ ] **Step 4: Parse `mouse_warping`**

Drop `'mouse_warping'` from `UNSUPPORTED` and add:

```ts
    case 'mouse_warping': {
      if (words[1] !== 'output' && words[1] !== 'none') {
        warn(line, `mouse_warping: expected output or none, got '${words[1] ?? ''}'`);
        return;
      }
      config.mouseWarping = words[1];
      return;
    }
```

`Config.mouseWarping: 'output' | 'none'`, defaulting to `'output'` — i3's default, and load-bearing:

```ts
  /**
   * i3's default is `output`: when focus moves to another output the pointer follows.
   *
   * Not cosmetic. With focus-mode sloppy and no warp, the stationary pointer's window would take focus
   * straight back and every keyboard output command would fight the mouse. The two are a pair.
   */
  mouseWarping: 'output' | 'none';
```

- [ ] **Step 5: Wire the engine**

Add `pointer: PointerPort` to `EnginePorts`. Then:

```ts
  /** Rule 4: the pointer crossed onto an output whose visible workspace is empty. */
  onPointerOutput(output: MonitorId): void {
    if (!this._started || this._disposed) return;
    const tree = this._tree;
    if (!tree || tree.focusedOutput === output) return;
    const visible = tree.visible.get(output);
    // Sloppy focus owns the non-empty case (rule 1). Two mechanisms racing for it would flap.
    if (visible === undefined || this._workspaceMembers(tree, visible).length > 0) return;
    this.commit(() => {
      tree.focusedOutput = output;
      return true;
    });
  }

  /**
   * The warp half of the pair. Called after rules 2 and 3 move the focused output — never after rule 4,
   * where the pointer is already there, and never while the launcher holds a modal grab.
   */
  private _warpToFocusedOutput(): void {
    if (this._config.mouseWarping === 'none' || this._launcherOpen) return;
    const tree = this._tree;
    const topology = this._topology;
    if (!tree || !topology) return;
    const selection = tree.selection();
    const target = selection?.kind === 'tiled'
      ? this._containerRects.get(selection.con)
      : selection?.kind === 'floating'
        ? this._windows.get(selection.window)?.rect
        : undefined;
    // An empty workspace has no window to aim at, so the output's own centre is the only answer.
    const rect = target ?? topology.workAreas.get(tree.focusedOutput);
    if (rect) this._ports.pointer.warpTo(rect);
  }
```

`_launcherOpen` is a boolean the engine already needs for the launcher's lifecycle; if it does not exist,
add it, set in the `launcher` command case and cleared wherever `this._ports.launcher.close()` is called.

In `src/extension.ts`, construct `new Pointer(tracker, index => { … })` and translate the monitor index to
a `MonitorId` through the engine's topology before calling `onPointerOutput`; the engine owns that
mapping, so pass the raw index into a small engine entry point `onPointerMonitorIndex(index: number)`
that resolves it and delegates. Keeping the translation in Layer 0 is what stops `src/shell` needing to
know about `MonitorId` allocation.

- [ ] **Step 6: Run the suite and the guards**

Run: `npm test && npm run typecheck && npm run check:layer0`

Expected: green apart from the two `focus output` tests, which Task 13 closes. Record exactly which are
red and why.

- [ ] **Step 7: Mutation-prove the emptiness condition**

Delete `|| this._workspaceMembers(tree, visible).length > 0` from `onPointerOutput` and run
`npx vitest run test/unit/engine.test.ts`. Expected: `leaves the focused output alone when the pointer's
output has a window to focus` fails, received `1`. Restore and record both outputs.

- [ ] **Step 8: Commit**

```bash
git add src/shell/pointer.ts src/config src/engine.ts src/extension.ts test/unit/shell/pointer.test.ts test/unit/config test/unit/engine.test.ts
git commit -m "feat(pointer): make an empty output reachable, and warp on output change

An output whose visible workspace is empty has no window to take focus,
so sloppy focus can never report that the user is there -- which is why
the launcher could not open on an unoccupied workspace. The pointer is
the only evidence, and the handler stays cheap: emptiness is asked only
when the monitor index actually changes.

mouse_warping output is i3's default and is load-bearing rather than
cosmetic: with sloppy focus and no warp, the stationary pointer's window
takes focus straight back and every keyboard output command fights the
mouse."
```

---

## Task 13: `focus output <left|right|up|down|primary|name>`

**Files:**
- Modify: `src/commands/model.ts`, `src/commands/parse.ts:73-78`
- Modify: `src/engine.ts` (`_runOne`, `_resolveOutput`)
- Test: `test/unit/commands/parse.test.ts`, `test/unit/engine/commands.test.ts`

**Interfaces:**
- Produces: `{type: 'focus_output'; target: OutputArg}` on the `Command` union; `Engine._resolveOutput(arg: OutputArg): MonitorId | null`, reused by Tasks 14 and 15.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/commands/parse.test.ts
it('parses focus output in every argument form', () => {
  expect(parseCommand('focus output right')).toEqual({type: 'focus_output', target: 'right'});
  expect(parseCommand('focus output primary')).toEqual({type: 'focus_output', target: 'primary'});
  expect(parseCommand('focus output DP-1')).toEqual({type: 'focus_output', target: {name: 'DP-1'}});
});
it('still parses the focus targets it always did', () => {
  expect(parseCommand('focus left')).toEqual({type: 'focus', target: 'left'});
  expect(parseCommand('focus parent')).toEqual({type: 'focus', target: 'parent'});
});
it('rejects focus output with no argument', () => {
  expect(parseCommand('focus output')).toMatch(/focus output/);
});

// test/unit/engine/commands.test.ts
it('focus output moves the focused output and the selection with it', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 2, workspace: 1, monitor: 1});
  h.run('focus output right');
  expect(h.state().focusedOutput).toBe(1);
  expect(h.windows.activated()).toContain(2);
});
it('focus output focuses an output whose workspace is empty', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.run('focus output right');
  expect(h.state().focusedOutput).toBe(1);
});
it('focus output is a no-op off the end and never wraps', () => {
  // Review Focus: outputs are physical; wrapping between them is never what a user means.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.run('focus output left');
  expect(h.state().focusedOutput).toBe(0);
  expect(h.log.warnings()).toEqual([]);
});
it('focus output resolves a connector name', () => {
  const h = harness({monitors: [{id: 0, index: 0, connectors: ['HDMI-1']},
                                {id: 1, index: 1, connectors: ['DP-1']}], primary: 0, workspaceCount: 10});
  h.run('focus output DP-1');
  expect(h.state().focusedOutput).toBe(1);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/commands/parse.test.ts test/unit/engine/commands.test.ts`

Expected: `parseCommand('focus output right')` returns `focus: unknown target 'output'`. Paste the real
output.

- [ ] **Step 3: Add the `Command` member**

`src/commands/model.ts`, beside the existing `focus` member:

```ts
  | {type: 'focus_output'; target: OutputArg}
```

Import `OutputArg` from `../tree/outputs`. `_runOne`'s switch has no `default:`, so the typecheck now
fails until Step 5 handles it — that is the intended guard, not a problem to work around.

- [ ] **Step 4: Parse it**

In `src/commands/parse.ts`'s `case 'focus':`, before the existing target test:

```ts
      if (args[0] === 'output') {
        const target = outputArg(args.slice(1));
        return target ? {type: 'focus_output', target} : 'focus output: expected left|right|up|down|primary|<name>';
      }
```

with a helper shared by all three output commands:

```ts
/** i3's output argument: a direction, `primary`, or a connector name. */
function outputArg(args: readonly string[]): OutputArg | null {
  const first = args[0];
  if (first === undefined) return null;
  if (isDirection(first) || first === 'primary') return first;
  return {name: first};
}
```

- [ ] **Step 5: Handle it in the engine**

```ts
      case 'focus_output': {
        const output = this._resolveOutput(command.target);
        // No neighbour beyond that edge is an ordinary edge, not an error: outputs are physical and
        // wrapping between them is never what a user means.
        if (output === null) return 'focus output: no such output';
        return this.commit(() => {
          const tree = this._tree;
          if (!tree || tree.focusedOutput === output) return false;
          tree.focusedOutput = output;
          this._activateSelection(timestamp);
          this._warpToFocusedOutput();
          return true;
        }) ? 'focus output' : 'focus output: unchanged';
      }
```

and:

```ts
  private _resolveOutput(arg: OutputArg): MonitorId | null {
    const tree = this._tree;
    const topology = this._topology;
    if (!tree || !topology) return null;
    const byName = new Map<string, MonitorId>();
    for (const monitor of topology.monitors)
      for (const connector of monitor.connectors) byName.set(connector.toLowerCase(), monitor.id);
    return resolveOutputArg(arg, topology.workAreas, tree.focusedOutput, topology.primary, byName);
  }
```

`_activateSelection` already focuses an empty workspace's root gracefully — confirm it does; if it
requires a window, give it an early return for a rootless selection rather than special-casing here.

- [ ] **Step 6: Run the suite**

Run: `npm test && npm run typecheck && npm run check:layer0`

Expected: **all green**, including the two warp tests deferred from Task 12.

- [ ] **Step 7: Commit**

```bash
git add src/commands src/engine.ts test/unit/commands/parse.test.ts test/unit/engine/commands.test.ts
git commit -m "feat(commands): add focus output

Resolves a direction geometrically, primary, or a connector name. An
output whose visible workspace is empty is focusable, which is the point:
focus is output-level, so there is always an answer even with nothing
open there. A direction with no neighbour is a silent no-op rather than a
wrap, because outputs are physical."
```

---

## Task 14: `focus` and `move` cross the output edge instead of wrapping

Adopted verbatim from the Phase 4 design §4.2, which this phase inherits. The engine owns the crossing,
because `neighbourMonitor` needs work areas and those live in the topology, not the tree.

**Files:**
- Modify: `src/tree/tree.ts` (`enterOutput`, `moveIntoOutput`)
- Modify: `src/engine.ts` (the `focus` and `move` command cases)
- Test: `test/unit/tree/outputsModel.test.ts`, `test/unit/engine/commands.test.ts`

**Interfaces:**
- Produces: `tree.enterOutput(output: MonitorId, direction: Direction): LeafCon | null`; `tree.moveIntoOutput(output: MonitorId, direction: Direction | null): WindowId[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/tree/outputsModel.test.ts
describe('enterOutput', () => {
  it('descends into the neighbour from the entering edge', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    const a = t.insert(1, 1), b = t.insert(2, 1);
    t.focusedOutput = 3;
    // Moving right into output 2 enters at its left, which is its first child.
    expect(t.enterOutput(2, 'right')).toBe(a);
    expect(t.focusedOutput).toBe(2);
    expect(b).toBeDefined();
  });

  it('enters from the far edge when moving left', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    t.insert(1, 1); const b = t.insert(2, 1);
    t.focusedOutput = 3;
    expect(t.enterOutput(2, 'left')).toBe(b);
  });

  it('focuses an empty output’s root and returns null', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.enterOutput(2, 'right')).toBeNull();
    expect(t.focusedOutput).toBe(2);
    expect(t.selection()).toEqual({kind: 'tiled', con: t.root(1)});
  });
});

// test/unit/engine/commands.test.ts
it('focus right crosses to the neighbouring output at its edge rather than wrapping', () => {
  // The config's effective focus_wrapping is yes; crossing beats wrapping, which is i3's behaviour.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.addWindow({id: 2, workspace: 1, monitor: 1});
  h.run('focus right');
  expect(h.state().focusedOutput).toBe(1);
  expect(h.windows.activated()).toContain(2);
});

it('focus right still wraps inside one output when there is no neighbour', () => {
  const h = harness({monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.addWindow({id: 2, workspace: 0, monitor: 0});
  h.run('focus left');   // from id 2, wraps to id 1's far side per focus_wrapping yes
  expect(h.state().focusedOutput).toBe(0);
});

it('move right at the edge inserts into the neighbouring output', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.run('move right');
  expect(h.tree().location(1)).toEqual({workspace: 1, output: 1, floating: false});
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/tree/outputsModel.test.ts test/unit/engine/commands.test.ts`

Expected: `t.enterOutput is not a function`, and `focus right` wrapping inside output 0. Paste the real
output.

- [ ] **Step 3: Implement the tree half**

`src/tree/tree.ts`, using the existing `descendDirection` from `./focus` (it already takes `children[0]`
for a forward direction on a matching axis, which is exactly the entering edge):

```ts
  /**
   * Enter an output's visible workspace from the edge nearest the output being left: moving `right`
   * enters at its left. Returns the leaf focused, or null when that workspace is empty — in which case
   * its root is selected, because focus is output-level and an empty output is still focusable.
   */
  enterOutput(output: MonitorId, direction: Direction): LeafCon | null {
    const index = this.visible.get(output);
    if (index === undefined) return null;
    this.focusedOutput = output;
    const root = this.workspace(index).root;
    const target = descendDirection(root, direction);
    if (!target) {
      this.select(root);
      return null;
    }
    this.select(target);
    return target;
  }

  /**
   * Move the selection into an output's visible workspace. `direction` null means the workspace's normal
   * insertion point (a named or `primary` target); a direction means the entering edge.
   */
  moveIntoOutput(output: MonitorId, direction: Direction | null): WindowId[] {
    const index = this.visible.get(output);
    if (index === undefined) return [];
    if (index === this.activeWorkspace) return [];
    // moveToWorkspace already preserves a moved subtree's structure, layout, percentages and focused
    // child, including the root-contents case, so the cross-output move is that plus an edge choice.
    const moved = this.moveToWorkspace(index);
    if (moved.length > 0 && direction !== null) this._reseatAtEdge(index, direction);
    if (moved.length > 0) this.focusedOutput = output;
    return moved;
  }
```

`_reseatAtEdge(index, direction)` moves the just-attached child to the front of the target root's
children for a forward direction and to the back for a backward one, adjusting `percents` alongside.
Write it beside `insertionPoint`, reusing whatever that helper uses to keep `percents` in step — do not
recompute percentages by hand in a second place.

Import `descendDirection` from `./focus` if it is not already imported.

- [ ] **Step 4: Implement the engine half**

In `_runOne`'s `case 'focus':`, after the existing `tree.focus(...)` attempt:

```ts
        const wrapping = wrappingFor(this._config.focusWrapping);
        // Crossing beats wrapping: try strictly inside this output first, with wrapping off.
        const inside = tree.focus(command.target, 'none');
        if (inside) { this._activateSelection(timestamp); return 'focus'; }
        const neighbour = isDirection(command.target)
          ? neighbourMonitor(topology.workAreas, tree.focusedOutput, command.target) : null;
        if (neighbour !== null) {
          tree.enterOutput(neighbour, command.target);
          this._activateSelection(timestamp);
          this._warpToFocusedOutput();
          return 'focus';
        }
        // No neighbour: fall back to whatever the config's wrapping asks for, inside this output.
        if (tree.focus(command.target, wrapping)) { this._activateSelection(timestamp); return 'focus'; }
        return 'focus: nothing there';
```

Keep the existing `parent`/`child`/`mode_toggle` branches untouched — only a `Direction` target crosses.
`wrappingFor` is the existing mapping from `Config.focusWrapping` to `Wrapping`; if the current code
inlines it, extract it rather than duplicating the mapping.

`case 'move':` takes the same shape: attempt `tree.move(direction)` inside the output, and on failure
resolve a neighbour and call `tree.moveIntoOutput(neighbour, direction)`.

- [ ] **Step 5: Run the suite**

Run: `npm test && npm run typecheck && npm run check:layer0`

Expected: all green. `test/unit/tree/focus.test.ts` and `move.test.ts` are single-output and should be
untouched; if either changed, the crossing leaked into the single-output path.

- [ ] **Step 6: Mutation-prove that crossing precedes wrapping**

Change `tree.focus(command.target, 'none')` to `tree.focus(command.target, wrapping)` and run
`npx vitest run test/unit/engine/commands.test.ts`. Expected: `focus right crosses to the neighbouring
output` fails with `focusedOutput` received `0`, because wrapping satisfied the move inside output 0.
Restore and record both outputs — this is the assertion that distinguishes the feature from the old
behaviour, and it is the one most likely to be vacuous if the fixture has only one window per output.

- [ ] **Step 7: Commit**

```bash
git add src/tree/tree.ts src/engine.ts test/unit/tree/outputsModel.test.ts test/unit/engine/commands.test.ts
git commit -m "feat(engine): focus and move cross the output edge instead of wrapping

Adopted from the Phase 4 design: the neighbour is tried before the
config's focus_wrapping, so the edge crosses rather than wrapping, which
is i3's behaviour and the point of the change. The engine owns the
crossing because neighbourMonitor needs work areas and those belong to
the topology.

An empty neighbour is entered and its root selected: focus is
output-level, so an output with nothing open is still focusable."
```

---

## Task 15: `move container to output` and `move workspace to output`

**Files:**
- Modify: `src/commands/model.ts`, `src/commands/parse.ts` (`case 'move'`)
- Modify: `src/tree/tree.ts` (`moveWorkspaceToOutput`)
- Modify: `src/engine.ts` (two `_runOne` cases)
- Test: `test/unit/commands/parse.test.ts`, `test/unit/tree/outputsModel.test.ts`, `test/unit/engine/commands.test.ts`

**Interfaces:**
- Produces: `{type: 'move_container_to_output'; target: OutputArg}` and `{type: 'move_workspace_to_output'; target: OutputArg}`; `tree.moveWorkspaceToOutput(output: MonitorId): {vacated: MonitorId; nowVisible: number} | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/commands/parse.test.ts
it('parses both output move forms', () => {
  expect(parseCommand('move container to output right'))
    .toEqual({type: 'move_container_to_output', target: 'right'});
  expect(parseCommand('move workspace to output DP-1'))
    .toEqual({type: 'move_workspace_to_output', target: {name: 'DP-1'}});
});
it('still parses move container to workspace', () => {
  expect(parseCommand('move container to workspace number 3'))
    .toEqual({type: 'move_to_workspace', target: {kind: 'number', number: 3, name: '3'}});
});

// test/unit/tree/outputsModel.test.ts
describe('moveWorkspaceToOutput', () => {
  it('moves the focused workspace and gives the vacated output one of its own', () => {
    const t = new Tree(10, outputs, 3);            // 0 on 3, 1 on 2, 2..9 on 3
    const result = t.moveWorkspaceToOutput(2);
    expect(result).toEqual({vacated: 3, nowVisible: 2});
    expect(t.outputOf(0)).toBe(2);
    expect(t.visible.get(2)).toBe(0);
    expect(t.visible.get(3)).toBe(2);
  });

  it('never leaves an output showing nothing', () => {
    const t = new Tree(2, outputs, 3);             // only workspaces 0 and 1
    t.moveWorkspaceToOutput(2);                    // workspace 0 leaves output 3, which owns nothing else
    expect(t.visible.get(3)).toBeDefined();
    expect(t.outputOf(t.visible.get(3)!)).toBe(3);
  });

  it('is a no-op when the workspace is already on that output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.moveWorkspaceToOutput(3)).toBeNull();
  });
});

// test/unit/engine/commands.test.ts
it('move container to output rescues a window stranded on another screen', () => {
  // The defect this phase exists for: a window on the television with no command able to move it.
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 8, workspace: 1, monitor: 1});
  h.run('focus output right');
  h.run('move container to output left');
  expect(h.tree().location(8)).toEqual({workspace: 0, output: 0, floating: false});
});

it('move container to output does not follow the window', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.run('move container to output right');
  expect(h.state().focusedOutput).toBe(0);
});

it('move workspace to output takes the windows with it and parks nothing', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 1, workspace: 0, monitor: 0});
  h.run('move workspace to output right');
  expect(h.tree().outputOf(0)).toBe(1);
  expect(h.windows.workspaceOf(1)).toBe(0);   // still LIVE: it moved output, not visibility
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/commands/parse.test.ts test/unit/tree/outputsModel.test.ts test/unit/engine/commands.test.ts`

Expected: `move: unsupported form 'container to output right'`, and
`t.moveWorkspaceToOutput is not a function`. Paste the real output.

- [ ] **Step 3: Parse both forms**

In `case 'move':`, before the existing `container to workspace` branch:

```ts
      if (args[0] === 'container' && args[1] === 'to' && args[2] === 'output') {
        const target = outputArg(args.slice(3));
        return target
          ? {type: 'move_container_to_output', target}
          : 'move container to output: expected left|right|up|down|primary|<name>';
      }
      if (args[0] === 'workspace' && args[1] === 'to' && args[2] === 'output') {
        const target = outputArg(args.slice(3));
        return target
          ? {type: 'move_workspace_to_output', target}
          : 'move workspace to output: expected left|right|up|down|primary|<name>';
      }
```

`outputArg` is Task 13's helper. Both new members go on the `Command` union.

- [ ] **Step 4: Implement `moveWorkspaceToOutput`**

```ts
  /**
   * Reassign the focused workspace to `output` and show it there. The vacated output falls back to its
   * lowest-numbered remaining workspace, or — owning none — takes the lowest-numbered workspace whose
   * output has the most, because invariant 2 forbids an output showing nothing.
   */
  moveWorkspaceToOutput(output: MonitorId): {vacated: MonitorId; nowVisible: number} | null {
    if (!this.visible.has(output)) return null;
    const index = this.activeWorkspace;
    const vacated = this.workspace(index).output;
    if (vacated === output) return null;
    this.workspace(index).output = output;
    this.visible.set(output, index);
    this.focusedOutput = output;
    const own = this.workspacesOn(vacated);
    if (own.length > 0) {
      this.visible.set(vacated, own[0]!);
      return {vacated, nowVisible: own[0]!};
    }
    const donor = [...this.visible.keys()]
      .filter(candidate => candidate !== vacated)
      .sort((a, b) => this.workspacesOn(b).length - this.workspacesOn(a).length || a - b)[0]!;
    const taken = this.workspacesOn(donor).at(-1)!;
    this.workspace(taken).output = vacated;
    this.visible.set(vacated, taken);
    // Taking the donor's highest-numbered leaves its visible workspace — usually its lowest — alone.
    if (this.visible.get(donor) === taken) this.visible.set(donor, this.workspacesOn(donor)[0]!);
    return {vacated, nowVisible: taken};
  }
```

- [ ] **Step 5: Handle both commands**

```ts
      case 'move_container_to_output': {
        const output = this._resolveOutput(command.target);
        if (output === null) return 'move container to output: no such output';
        return this.commit(() => {
          const tree = this._tree;
          if (!tree) return false;
          const direction = isDirection(command.target) ? command.target : null;
          const moved = tree.moveIntoOutput(output, direction);
          if (moved.length === 0) return false;
          // i3 does not follow the window here, matching move container to workspace. moveIntoOutput
          // sets focusedOutput, so put it back.
          tree.focusedOutput = this._outputBefore;
          for (const id of moved) this._ports.windows.moveToWorkspace(id, LIVE_WORKSPACE);
          return true;
        }) ? 'move container to output' : 'move container to output: nothing moved';
      }

      case 'move_workspace_to_output': {
        const output = this._resolveOutput(command.target);
        if (output === null) return 'move workspace to output: no such output';
        return this.commit(() => {
          const tree = this._tree;
          if (!tree) return false;
          const before = tree.visible.get(output);
          const result = tree.moveWorkspaceToOutput(output);
          if (!result) return false;
          // Whatever the target was showing is now on no output's screen.
          if (before !== undefined) for (const id of this._workspaceMembers(tree, before))
            this._ports.windows.moveToWorkspace(id, ATTIC_WORKSPACE);
          for (const id of this._workspaceMembers(tree, tree.activeWorkspace))
            this._ports.windows.moveToWorkspace(id, LIVE_WORKSPACE);
          this._activateSelection(timestamp);
          this._warpToFocusedOutput();
          return true;
        }) ? 'move workspace to output' : 'move workspace to output: unchanged';
      }
```

`_outputBefore` is the focused output captured before `moveIntoOutput` runs; read it into a local at the
top of the case rather than adding a field.

Note the asymmetry and keep it: `move container to output` does **not** move focus (i3's behaviour, and
`move container to workspace`'s), while `move workspace to output` does, because the workspace you are
looking at went with it.

- [ ] **Step 6: Run the suite**

Run: `npm test && npm run typecheck && npm run check:layer0`

Expected: all green.

- [ ] **Step 7: Mutation-prove that focus does not follow a container**

Delete `tree.focusedOutput = this._outputBefore;` and run
`npx vitest run test/unit/engine/commands.test.ts`. Expected: `move container to output does not follow
the window` fails, received `1`. Restore and record both outputs.

- [ ] **Step 8: Commit**

```bash
git add src/commands src/tree/tree.ts src/engine.ts test/unit/commands/parse.test.ts test/unit/tree/outputsModel.test.ts test/unit/engine/commands.test.ts
git commit -m "feat(commands): add move container to output and move workspace to output

move container to output is the command the phase exists for: before it,
a window on a second display could not be moved by any binding at all. It
does not follow the window, matching i3 and move container to workspace;
move workspace to output does follow, because the workspace you were
looking at went with it.

The vacated output falls back to its lowest-numbered remaining workspace,
or takes one from the output holding the most, since an output showing
nothing would break the visibility invariant."
```

---

## Task 16: Hotplug — reassign instead of flatten, and remember

The sleeper win of the phase. Today `reconfigure` folds a lost output's roots into the primary's with
`appendRootContents`, so closing a lid or letting a television sleep **destroys the layout
irrecoverably**. Task 3 already stopped the flattening; this task adds the remembering, the gained-output
rule, and the window moves the engine owes Mutter afterwards.

**Files:**
- Modify: `src/tree/tree.ts` (`reconfigure`, the remembered map)
- Modify: `src/engine.ts` (`_moveReconfigured`, parking after a reconfigure)
- Test: `test/unit/tree/topology.test.ts`, `test/unit/tree/outputsModel.test.ts`, `test/unit/engine/lifecycle.test.ts`

**Interfaces:**
- Consumes: `reassignLost`, `adoptOutput` from Task 2.
- Produces: `tree.remembered(): ReadonlyMap<number, MonitorId>` — exposed for the tests and for `GetTree` if a later phase wants it.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/tree/outputsModel.test.ts
describe('reconfigure across outputs', () => {
  it('keeps a lost output’s layout and moves the workspace to the primary', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    t.insert(1, 1); t.insert(2, 1);
    const rootBefore = t.root(1);
    const childrenBefore = [...rootBefore.children];
    t.reconfigure(10, [{id: 3, index: 1}], 3);
    expect(t.root(1)).toBe(rootBefore);                 // the same root object
    expect(t.root(1).children).toEqual(childrenBefore); // with the same layout
    expect(t.outputOf(1)).toBe(3);
    expect(t.focusedOutput).toBe(3);
  });

  it('restores the original assignment when the output comes back', () => {
    const t = new Tree(10, outputs, 3);
    t.reconfigure(10, [{id: 3, index: 1}], 3);
    expect(t.outputOf(1)).toBe(3);
    t.reconfigure(10, outputs, 3);
    expect(t.outputOf(1)).toBe(2);
    expect(t.visible.get(2)).toBe(1);
  });

  it('survives every workspace living on the output that vanished', () => {
    // Review Focus 5: the primary already shows one of its own, so the rest must park with layouts intact.
    const t = new Tree(3, [{id: 2, index: 0}, {id: 3, index: 1}], 3,
      new Map([[0, 2], [1, 2], [2, 2]]));
    t.reconfigure(3, [{id: 3, index: 1}], 3);
    for (let index = 0; index < 3; index++) expect(t.outputOf(index)).toBe(3);
    expect(t.visible.size).toBe(1);
    expect(t.outputOf(t.visible.get(3)!)).toBe(3);
  });

  it('gives a brand-new output the lowest-numbered workspace not spoken for', () => {
    const t = new Tree(10, [{id: 3, index: 0}], 3);
    t.reconfigure(10, [{id: 3, index: 0}, {id: 9, index: 1}], 3);
    expect(t.visible.get(9)).toBe(1);
    expect(t.outputOf(1)).toBe(9);
  });
});

// test/unit/engine/lifecycle.test.ts
it('un-parks the newly visible workspace after a monitor change', () => {
  const h = harness({monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
  h.addWindow({id: 5, workspace: 0, monitor: 1});   // workspace 1, visible on output 1
  h.setMonitors([{id: 0, index: 0}]);               // output 1 goes away
  expect(h.windows.workspaceOf(5)).toBe(1);         // ATTIC: workspace 1 is no longer visible anywhere
  h.setMonitors([{id: 0, index: 0}, {id: 1, index: 1}]);
  expect(h.windows.workspaceOf(5)).toBe(0);         // LIVE again, on the returning output
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/unit/tree test/unit/engine/lifecycle.test.ts`

Expected: the replug test fails — `outputOf(1)` stays `3` because nothing is remembered. Paste the real
output.

- [ ] **Step 3: Remember, and adopt**

In `src/tree/tree.ts`, add a private field and expose it read-only:

```ts
  /**
   * Where a workspace lived before its output went away, so a replug puts it back.
   *
   * Meaningful only because MonitorIds derives a stable id from the sorted connector list: an output
   * that comes back is recognised as the same one rather than as a new one.
   */
  private _remembered = new Map<number, MonitorId>();

  remembered(): ReadonlyMap<number, MonitorId> {
    return this._remembered;
  }
```

Replace the reassignment block from Task 3 Step 4 with:

```ts
    const live = new Set(outputs.map(output => output.id));
    const ordered = orderOutputs(outputs, primary);
    // Remember before reassigning, and only for a workspace actually displaced: a workspace that never
    // left must not have its home rewritten by an unrelated unplug.
    for (const workspace of this.workspaces.values())
      if (!live.has(workspace.output)) this._remembered.set(workspace.index, workspace.output);
    const reassigned = reassignLost(
      new Map([...this.workspaces.values()].map(w => [w.index, w.output])), live, primary);
    for (const [index, output] of reassigned) this.workspace(index).output = output;

    // A returning output reclaims what it had.
    for (const output of ordered) {
      if (this.visible.has(output)) continue;
      const reclaimed = adoptOutput(this._remembered, output, reassigned);
      if (reclaimed !== null) {
        this.workspace(reclaimed).output = output;
        this._remembered.delete(reclaimed);
      }
    }
    // Every other workspace this output used to hold comes home too, so a replug restores the desk.
    for (const [index, output] of [...this._remembered])
      if (live.has(output)) { this.workspace(index).output = output; this._remembered.delete(index); }

    for (const output of [...this.visible.keys()]) if (!live.has(output)) this.visible.delete(output);
    for (const output of ordered) {
      const own = this.workspacesOn(output);
      const current = this.visible.get(output);
      if (current !== undefined && own.includes(current)) continue;
      if (own.length > 0) { this.visible.set(output, own[0]!); continue; }
      // Invariant 2: an output must show one of its own, so take one from whoever holds the most.
      const donor = ordered
        .filter(candidate => candidate !== output && this.workspacesOn(candidate).length > 1)
        .sort((a, b) => this.workspacesOn(b).length - this.workspacesOn(a).length || a - b)[0];
      if (donor === undefined) throw new Error('no output can spare a workspace');
      const taken = this.workspacesOn(donor).at(-1)!;
      this.workspace(taken).output = output;
      this.visible.set(output, taken);
    }
    if (!live.has(this.focusedOutput)) this.focusedOutput = primary;
```

Import `adoptOutput` and `reassignLost` from `./outputs`.

- [ ] **Step 4: Park and un-park after a reconfigure**

`_moveReconfigured` currently applies the `Map<WindowId, number>` the workspace-count shrink returns. Add
a pass that reconciles every window's GNOME workspace against the new visibility, since a monitor change
can make a workspace visible or parked without moving any window between workspaces:

```ts
  /** After any tree reconfigure, every window's GNOME workspace must agree with the new visibility. */
  private _reconcileParking(tree: Tree): void {
    const visible = new Set(tree.visible.values());
    for (const [index] of tree.workspaces) {
      const target = visible.has(index) ? LIVE_WORKSPACE : ATTIC_WORKSPACE;
      for (const id of this._workspaceMembers(tree, index)) {
        if (this._windows.get(id)?.workspace === target) continue;
        if (!this._ports.windows.moveToWorkspace(id, target))
          this._ports.log.warn(`could not move window ${id} to ${target === LIVE_WORKSPACE ? 'live' : 'the attic'}`);
      }
    }
  }
```

Call it from `_layoutAndPublish` immediately after the reconfigure branch, and once after the tree is
first constructed so adoption on enable parks anything that is not on a visible workspace.

- [ ] **Step 5: Rewrite the flattening assertions in `topology.test.ts`**

Every case there that asserts a lost monitor's windows were appended into the primary's root now asserts
the workspace kept its root and changed its `output`. A test still asserting flattening is asserting the
bug this task removes. Keep the workspace-count-shrink cases exactly as they are — that path still
flattens, deliberately, because the workspaces themselves cease to exist.

- [ ] **Step 6: Run the suite and the guards**

Run: `npm test && npm run typecheck && npm run check:layer0 && npm run lint:tree`

Expected: all green.

- [ ] **Step 7: Mutation-prove the remembering**

Change `if (!live.has(workspace.output)) this._remembered.set(...)` to set unconditionally and run
`npx vitest run test/unit/tree/outputsModel.test.ts`. Expected: `restores the original assignment when
the output comes back` fails, because a workspace that never moved has been given a stale home and gets
dragged to it. Restore and record both outputs.

- [ ] **Step 8: Commit**

```bash
git add src/tree/tree.ts src/engine.ts test/unit/tree test/unit/engine/lifecycle.test.ts
git commit -m "feat(tree): remember a workspace's output across an unplug

reconfigure folded a lost output's roots into the primary's, destroying
the layout for good -- the common case being a closed lid or a sleeping
television. Workspaces are reassigned instead, roots untouched, and their
old output is remembered so a replug restores the desk. That is only
meaningful because MonitorIds derives a stable id from the sorted
connector list, so a returning output is recognised as the same one.

Only a displaced workspace is remembered: recording every workspace would
let an unrelated unplug rewrite a home that never changed."
```

---

## Task 17: Native scenarios — the six claims a synchronous fake cannot support

Every assertion here exists because a unit fake confirms synchronously what Mutter does asynchronously,
or reports success where Mutter reports nothing at all.

**Files:**
- Create: `test/integration/phase5-checks.py`
- Modify: `test/integration/run.sh`
- Test: itself; the controller runs it.

**Interfaces:**
- Consumes: `org.i3shell.Control` (`GetState`, `GetTree`, `GetWindows`) and the `__I3SHELL_TEST__`-gated `org.i3shell.Debug`, through `test/integration/client.py`.
- Produces: nothing other tasks consume; this is a leaf.

- [ ] **Step 1: Write the scenarios**

`test/integration/phase5-checks.py`, following `phase2-checks.py`'s structure and its
`org.i3shell.Control` / `org.i3shell.Debug` client from `test/integration/client.py`:

1. **A parked window is not rendered and takes no focus.** Open two windows, `workspace number 5`, then
   assert through `GetWindows` that the parked window's GNOME workspace is the attic, that
   `GetTree`'s `visible` shows workspace 5 on the output, and that the focused window is not the parked
   one. The unit fake cannot show "not rendered"; only Mutter can.
2. **Switching one output leaves the other untouched.** Two virtual monitors, a window on each, then
   `workspace number 5` on the first: assert the second output's `visible` entry and its window's rect
   are byte-identical before and after.
3. **Focus after a swap is the incoming workspace's selection.** The Task 6 assertion, natively: park a
   focused window and assert the focused window afterwards is the incoming workspace's, not whichever
   one Mutter picked. This is the scenario that justifies `_expectedFocus`, and the only place the real
   replacement-focus behaviour exists.
4. **An unplugged output preserves its workspace's layout; a replug restores the assignment.** Start
   with two monitors, split a workspace on the second so its root has two children with non-equal
   percentages, drop to one monitor, assert the root's children and percentages are unchanged and its
   `output` is now the primary, then restore two monitors and assert the `output` is the second again.
5. **The overrides are restored on `disable()`.** `--disabled` run: assert `focus-mode`,
   `num-workspaces`, `workspace-names` and `app-switcher current-workspace-only` all read their
   pre-enable values.
6. **`focus_follows_mouse` moves the focused output, and a keyboard `focus output` warps the pointer.**
   Warp the pointer onto the second monitor via the Debug surface, assert `GetState`'s `focusedOutput`
   followed; then `focus output left` and assert the pointer's position is inside the primary's work
   area. If the Debug interface has no pointer entry point, add one behind `__I3SHELL_TEST__` — never
   in a release build.

- [ ] **Step 2: Wire them into the suite**

`test/integration/run.sh`, after the existing lines:

```bash
bash test/integration/nested.sh --monitor 1920x1080 --monitor 1280x720 -- \
  python3 test/integration/phase5-checks.py
bash test/integration/nested.sh --monitor 1920x1080 --monitor 1280x720 -- \
  python3 test/integration/phase5-checks.py --hotplug
bash test/integration/nested.sh --disabled -- python3 test/integration/phase5-checks.py --settings
```

- [ ] **Step 3: Run the suite (controller only)**

Run: `npm run test:integration`

Expected: every scenario passes and **the critical-log gate stays clean**. The swap moves several
windows in one commit, which is the shape of change that produced 34 St-CRITICALs in Phase 3B — if
criticals appear, they are a real defect in the swap, not noise to filter. Do not weaken the gate;
record the full critical text and fix the cause.

- [ ] **Step 4: Commit**

```bash
git add test/integration/phase5-checks.py test/integration/run.sh
git commit -m "test(integration): prove the six per-output claims natively

Each of these exists because a unit fake confirms synchronously what
Mutter does asynchronously: a parked window genuinely not being rendered,
the replacement focus Mutter picks when the focused window is parked, and
a work area surviving an unplug. The swap moves several windows in one
commit, so the critical-log gate is doing real work here."
```

---

## Task 18: Documentation — amendments, acceptance, README

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-i3-shell-design.md` (§7.1, §9, §6.3, §6.7, §8.5, §13, §17)
- Create: `docs/acceptance/phase-5.md`
- Modify: `README.md`, `PROJECT.md`
- Modify: `docs/superpowers/plans/2026-09-24-phase-4-fidelity.md` (mark Tasks 5–10's disposition)

**Interfaces:**
- Consumes: the acceptance criteria A50–A66 from §10 of the Phase 5 spec, and the eleven amendments from §9.
- Produces: nothing other tasks consume; this is a leaf.

- [ ] **Step 1: Apply the eleven main-spec amendments**

Spec §9 of the Phase 5 design lists them. Apply each verbatim, in place, and do not leave the old text
alongside the new. The one most easily missed is §7.1's level-order sentence — "GNOME workspaces span
monitors, so here it is workspace → monitor" — which reverses to **output → workspace**. §9's
"Consequence, to state plainly" paragraph is replaced wholesale by the attic; a reader who finds the old
paragraph will conclude the extension still makes GNOME workspaces span outputs.

- [ ] **Step 2: Write the acceptance document**

`docs/acceptance/phase-5.md`, matching `docs/acceptance/phase-3b.md`'s format: A50–A66 from §10 of the
Phase 5 spec, each as an unticked checkbox with the steps to walk it by hand on a real two-output desk.
**Nothing is ticked** — these are walked by the user after a logout, not by the implementer.

- [ ] **Step 3: Rewrite the README as the end-product document**

It must carry every step needed to run this on a different system, from nothing:

- What it is, and what it deliberately does not do (§1.2 non-goals, plus the three recorded divergences: the fixed workspace set, all *N* pills shown where i3 hides unvisited workspaces, and GNOME's overview showing the attic).
- Requirements: GNOME Shell 50, Wayland, `~/.config/i3/config`.
- Build and install: `npm install`, `npm run build`, `make install`, then **log out and back in** — Wayland cannot reload extension code in place.
- Enable: `gnome-extensions enable i3-shell@troja`.
- The GSettings it takes over and gives back, as a table — the eight keys from §8.2 of the Phase 5 spec — so a reader knows exactly what changes about their desktop and that `disable()` restores all of it.
- What per-output workspaces mean in practice: one workspace per output at startup, primary first; `$mod+N` follows a workspace to its output; `workspace N output <connector>` to pin.
- The new bindings a user should add, as copy-pasteable config lines: `focus output`, `move container to output`, `move workspace to output`.
- Troubleshooting: how to read `journalctl --user -b | grep i3-shell`, what `GetState`/`GetTree` over `org.i3shell.Control` report, and the single most confusing symptom — a window on an output that is powered off is invisible but present, and `move container to output` is how it comes back.
- Development: `npm test`, `npm run typecheck`, `npm run check:layer0`, `npm run test:integration`, and that `dist/` is a symlink target for the installed extension so a stray build changes what the next login loads.

- [ ] **Step 4: Update `PROJECT.md` and the Phase 4 plan**

`PROJECT.md`: Phase 5 lands; the phase table, the module list (three new files) and the test counts all
change. Take the counts from an actual `npm test` run rather than arithmetic — the count has been wrong
in this project's docs six times.

In `docs/superpowers/plans/2026-09-24-phase-4-fidelity.md`, annotate Tasks 5–10: 5 absorbed into Phase 5
Task 1, 6–7 superseded by Phase 5 Tasks 13–15, 8–10 folded into Phase 5 Tasks 17–18. Leave the text in
place; a reader of that plan needs to know why those tasks were never executed.

- [ ] **Step 5: Verify the documentation claims**

For every command, file path, setting key and npm script the README names, confirm it exists. Six
documentation errors in this project so far have been a stale count or a path that had moved. Grep, do
not trust.

- [ ] **Step 6: Commit**

```bash
git add docs README.md PROJECT.md
git commit -m "docs: amend the main spec for per-output workspaces, add phase-5 acceptance

Eleven amendments, of which 7.1's level order is the load-bearing one:
i3's order is output then workspace, and the main spec said the reverse
because GNOME used to own workspace identity. 9's 'a workspace spans
every output' paragraph is replaced by the attic outright, since a reader
who finds it would conclude the extension still behaves that way.

README is rewritten as the end-product document: requirements, build,
install, the eight GSettings taken over and given back, what per-output
workspaces mean in practice, the bindings to add, and the symptom that
will confuse everyone -- a window on a powered-off output is invisible
but present."
```

---
