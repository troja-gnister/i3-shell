import fc from 'fast-check';
import {expect, it} from 'vitest';
import type {Direction, Layout} from '../../../src/commands/model';
import type {Wrapping} from '../../../src/tree/focus';
import {layoutWithRects} from '../../../src/tree/layout';
import {leaves, type Con, type Rect, type WindowId} from '../../../src/tree/node';
import {Tree} from '../../../src/tree/tree';

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
      const childRect = rects.get(child)!;
      expect(horizontal ? childRect.x : childRect.y).toBe(edge);
      expect(horizontal
        ? [childRect.y, childRect.height]
        : [childRect.x, childRect.width]
      ).toEqual(horizontal
        ? [rect.y, rect.height]
        : [rect.x, rect.width]
      );
      edge += horizontal ? childRect.width : childRect.height;
    }
    expect(edge).toBe(horizontal ? rect.x + rect.width : rect.y + rect.height);
  }

  for (const child of con.children) checkGeometry(child, rects);
}

const kinds = [
  'insert',
  'remove',
  'select',
  'split',
  'layout',
  'toggleLayout',
  'focus',
  'parent',
  'child',
  'move',
  'resize',
  'floating',
  'modeToggle',
  'workspace',
  'transfer',
] as const;

interface GeneratedOperation {
  kind: typeof kinds[number];
  pick: number;
  workspace: number;
  direction: Direction;
  orientation: 'h' | 'v' | 'toggle';
  layout: Layout;
  wrapping: Wrapping;
  amount: number;
  grow: boolean;
  width: boolean;
  pixels: boolean;
}

const operation = fc.record({
  kind: fc.constantFrom(...kinds),
  pick: fc.nat(11),
  workspace: fc.integer({min: 0, max: 1}),
  direction: fc.constantFrom<Direction>('left', 'right', 'up', 'down'),
  orientation: fc.constantFrom<'h' | 'v' | 'toggle'>('h', 'v', 'toggle'),
  layout: fc.constantFrom<Layout>('splith', 'splitv', 'tabbed', 'stacked'),
  wrapping: fc.constantFrom<Wrapping>('yes', 'no', 'force', 'workspace'),
  amount: fc.constantFrom(1, 5, 10, 50),
  grow: fc.boolean(),
  width: fc.boolean(),
  pixels: fc.boolean(),
});

function applyGeneratedOperation(
  tree: Tree,
  expected: Map<WindowId, number>,
  op: GeneratedOperation,
  area: Rect,
): void {
  const ids = [...expected.keys()].sort((a, b) => a - b);
  const id = ids.length ? ids[op.pick % ids.length] : undefined;

  switch (op.kind) {
    case 'insert': {
      const free = Array.from({length: 12}, (_, index) => index + 1)
        .find(candidate => !expected.has(candidate));
      if (free !== undefined) {
        tree.insert(free, op.workspace, 0);
        expected.set(free, op.workspace);
      }
      return;
    }
    case 'remove':
      if (id !== undefined) {
        tree.remove(id);
        expected.delete(id);
      }
      return;
    case 'select':
      if (id !== undefined) {
        tree.activateWorkspace(expected.get(id)!);
        const con = tree.find(id);
        if (con) tree.select(con);
        else tree.selectFloating(id);
      }
      return;
    case 'split':
      tree.split(op.orientation);
      return;
    case 'layout':
      tree.setLayout(op.layout);
      return;
    case 'toggleLayout':
      tree.toggleLayout(op.grow ? 'all' : 'split');
      return;
    case 'focus':
      tree.focus(op.direction, op.wrapping);
      return;
    case 'parent':
      tree.focusParent();
      return;
    case 'child':
      tree.focusChild();
      return;
    case 'move':
      tree.move(op.direction);
      return;
    case 'resize': {
      const rects = new Map<Con, Rect>();
      for (const root of tree.workspace(tree.activeWorkspace).monitors.values()) {
        for (const [con, rect] of layoutWithRects(root, area).containers)
          rects.set(con, rect);
      }
      tree.resize({
        action: op.grow ? 'grow' : 'shrink',
        dimension: op.width ? 'width' : 'height',
        px: op.amount,
        ppt: op.pixels ? null : op.amount,
      }, rects);
      return;
    }
    case 'floating':
      if (id !== undefined) tree.setFloating(id, !tree.location(id)!.floating, 0);
      return;
    case 'modeToggle':
      tree.focusModeToggle();
      return;
    case 'workspace':
      tree.activateWorkspace(op.workspace);
      return;
    case 'transfer': {
      const selection = tree.selection();
      const candidates = selection?.kind === 'floating'
        ? [selection.window]
        : selection?.kind === 'tiled'
          ? [...leaves(selection.con)].map(con => con.window)
          : [];
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

it.each([20260921, 8675309])(
  'preserves membership, focus and exact local coverage through operation sequences (seed %i)',
  seed => {
    fc.assert(fc.property(
      fc.array(operation, {minLength: 1, maxLength: 100}),
      fc.constantFrom(1, 17, 1919, 1920),
      fc.constantFrom(1, 19, 1049, 1080),
      (operations, width, height) => {
        const tree = new Tree(2, [0]);
        const expected = new Map<WindowId, number>();
        const area = {x: -13, y: 27, width, height};

        for (const op of operations) {
          applyGeneratedOperation(tree, expected, op, area);
          const live = new Set(expected.keys());

          // Facades must leave a normalized tree; do not repair defects in the test.
          tree.check(live);

          const actual = new Map<WindowId, number>();
          for (const workspace of tree.workspaces.values()) {
            for (const root of workspace.monitors.values()) {
              const result = layoutWithRects(root, area);
              checkGeometry(root, result.containers);
              for (const id of result.windows.keys()) {
                expect(actual.has(id)).toBe(false);
                actual.set(id, workspace.index);
              }
            }
            for (const id of workspace.floating) {
              expect(actual.has(id)).toBe(false);
              actual.set(id, workspace.index);
            }
          }

          expect([...actual].sort((a, b) => a[0] - b[0]))
            .toEqual([...expected].sort((a, b) => a[0] - b[0]));
        }
      },
    ), {numRuns: 300, seed, verbose: true});
  },
);
