import {describe, expect, it} from 'vitest';
import type {Direction} from '../../../src/commands/model';
import type {Con, SplitCon} from '../../../src/tree/node';
import {moveCon} from '../../../src/tree/operations';
import {Tree} from '../../../src/tree/tree';
import {findLeaf, fromShape, shape, type Shape} from './helpers';

describe('directional container movement', () => {
  const examples = [
    {
      before: ['splith', [1, ['splitv', [2, 3]]]], window: 3, direction: 'left',
      moved: true, after: ['splith', [1, 3, ['splitv', [2]]]],
    },
    {
      before: ['splith', [1, ['splith', [3, 4]]]], window: 1, direction: 'right',
      moved: true, after: ['splith', [['splith', [1, 3, 4]]]],
    },
    {
      before: ['splith', [['splitv', [1, ['splith', [4, 2]]]], 3]], window: 2, direction: 'right',
      moved: true, after: ['splith', [['splitv', [1, ['splith', [4]]]], 2, 3]],
    },
    {
      before: ['splitv', [['splith', [1, 2]]]], window: 2, direction: 'right',
      moved: false, after: ['splitv', [['splith', [1, 2]]]],
    },
  ] as const satisfies readonly {
    before: Shape;
    window: number;
    direction: Direction;
    moved: boolean;
    after: Shape;
  }[];

  it.each(examples)(
    'moves window $window $direction through the literal worked example',
    ({before, window, direction, moved, after}) => {
      const root = fromShape(before) as SplitCon;
      const selected = findLeaf(root, window);
      if (!selected) throw new Error(`fixture is missing window ${window}`);

      const result = moveCon(selected, direction);

      expect(result).toBe(moved);
      expect(shape(root)).toEqual(after);
    },
  );

  it('swaps leaf siblings while keeping percentages attached to their positions', () => {
    const root = fromShape(['splith', [1, 2]]) as SplitCon;
    root.percents = [0.7, 0.3];
    const selected = findLeaf(root, 2);
    if (!selected) throw new Error('fixture is missing window 2');

    expect(moveCon(selected, 'left')).toBe(true);

    expect(shape(root)).toEqual(['splith', [2, 1]]);
    expect(root.percents).toEqual([0.7, 0.3]);
  });

  it('moves a selected split container as one unit', () => {
    const root = fromShape(['splith', [1, ['splitv', [2, 3]], 4]]) as SplitCon;
    const selected = root.children[1];

    expect(moveCon(selected, 'right')).toBe(true);

    expect(shape(root)).toEqual(['splith', [1, 4, ['splitv', [2, 3]]]]);
  });

  it('leaves a root and a blocked move unchanged', () => {
    const root = fromShape(['splitv', [['splith', [1, 2]]]]) as SplitCon;
    const leaf = findLeaf(root, 2);
    if (!leaf) throw new Error('fixture is missing window 2');
    const before = shape(root);
    const percentages = [root.percents, (root.children[0] as SplitCon).percents].map(p => [...p]);

    expect(moveCon(root, 'down')).toBe(false);
    expect(moveCon(leaf, 'right')).toBe(false);

    expect(shape(root)).toEqual(before);
    expect(root.percents).toEqual(percentages[0]);
    expect((root.children[0] as SplitCon).percents).toEqual(percentages[1]);
  });
});

describe('Tree move facade', () => {
  it('normalizes after moving a selected split and keeps its surviving replacement selected', () => {
    const t = new Tree(1, [0]);
    const a = t.insert(1, 0, 0);
    const b = t.insert(2, 0, 0);
    const d = t.insert(3, 0, 0);
    const root = t.root(0, 0);
    const branch = t.allocateSplit('splitv');
    const selected = t.allocateSplit('splitv');
    const replacement = t.allocateSplit('splith');
    wire(replacement, [b]);
    wire(selected, [replacement]);
    wire(branch, [a, selected]);
    wire(root, [branch, d]);
    t.select(selected);
    t.check(new Set([1, 2, 3]));

    expect(t.move('right')).toBe(true);

    expect(shape(root)).toEqual(['splith', [['splitv', [1]], ['splith', [2]], 3]]);
    expect(t.selection()).toEqual({kind: 'tiled', con: replacement});
    expect(selected.parent).toBeNull();
    t.check(new Set([1, 2, 3]));
  });

  it('does not change selection or percentages when movement is blocked', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    const root = t.root(0, 0);
    const before = [...root.percents];

    expect(t.move('left')).toBe(false);

    expect(t.selection()).toEqual({kind: 'tiled', con: leaf});
    expect(root.percents).toEqual(before);
    t.check(new Set([1]));
  });

  it('does nothing for a floating selection', () => {
    const t = new Tree(1, [0]);
    const tiled = t.insert(1, 0, 0);
    const workspace = t.workspace(0);
    workspace.floating = [2];
    t.selectFloating(2);

    expect(t.move('right')).toBe(false);

    expect(t.selection()).toEqual({kind: 'floating', window: 2});
    expect(workspace.focusedCon).toBe(tiled);
    t.check(new Set([1, 2]));
  });
});

function wire(parent: SplitCon, children: Con[]): void {
  parent.children = children;
  parent.percents = children.map(() => 1 / children.length);
  parent.focusedChild = children.at(-1) ?? null;
  for (const child of children) child.parent = parent;
}
