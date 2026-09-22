import {describe, expect, it} from 'vitest';
import {leaves, type Con} from '../../../src/tree/node';
import {Tree} from '../../../src/tree/tree';

function snapshot(tree: Tree): unknown {
  function con(value: Con): unknown {
    return value.kind === 'leaf'
      ? {kind: value.kind, id: value.id, window: value.window}
      : {
          kind: value.kind,
          id: value.id,
          root: value.root,
          layout: value.layout,
          lastSplitLayout: value.lastSplitLayout,
          percents: value.percents,
          focusedChild: value.focusedChild?.id ?? null,
          children: value.children.map(con),
        };
  }
  return {
    activeWorkspace: tree.activeWorkspace,
    workspaces: [...tree.workspaces].map(([index, workspace]) => ({
      index,
      monitors: [...workspace.monitors].map(([monitor, root]) => [monitor, con(root)]),
      focusedCon: workspace.focusedCon?.id ?? null,
      floating: workspace.floating,
      focusedFloating: workspace.focusedFloating,
    })),
  };
}

describe('Tree topology reconfiguration', () => {
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
    expect([...leaves(keptRoot)].map(node => node.window)).toEqual([1, 2, 3]);
    expect(keptRoot.children.every(child => child.kind !== 'split' || !child.root)).toBe(true);
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

  it.each([
    [0, [10], 10],
    [37, [10], 10],
    [1.5, [10], 10],
    [2, [], 10],
    [2, [10, 10], 10],
    [2, [-1], -1],
    [2, [10.5], 10.5],
    [2, [10], 20],
  ])('validates the complete target (%s, %j, %s) before mutation', (count, monitors, primary) => {
    const tree = new Tree(2, [10, 20]);
    tree.insert(1, 0, 20);
    tree.addFloating(2, 1);
    const before = snapshot(tree);
    const control = new Tree(2, [10, 20]);
    control.insert(1, 0, 20);
    control.addFloating(2, 1);

    expect(() => tree.reconfigure(count, monitors, primary)).toThrow();
    expect(snapshot(tree)).toEqual(before);
    expect(tree.allocateSplit('splitv').id).toBe(control.allocateSplit('splitv').id);
  });

  it('reorders monitors and grows workspaces while preserving every existing root', () => {
    const tree = new Tree(2, [10, 20]);
    const roots = [...tree.workspaces.values()].map(workspace => [...workspace.monitors.values()]);

    expect(tree.reconfigure(3, [20, 10, 30], 20)).toEqual(new Map());

    expect([...tree.workspace(0).monitors.keys()]).toEqual([20, 10, 30]);
    expect(tree.root(0, 20)).toBe(roots[0][1]);
    expect(tree.root(0, 10)).toBe(roots[0][0]);
    expect(tree.root(1, 20)).toBe(roots[1][1]);
    expect(tree.root(1, 10)).toBe(roots[1][0]);
    expect(tree.workspace(2).monitors.size).toBe(3);
    tree.check();
  });

  it('combines workspace and monitor removal, retains moved active focus, and supports later growth', () => {
    const tree = new Tree(3, [10, 20]);
    const destination = tree.insert(1, 1, 10);
    const moved = tree.insert(2, 2, 20);
    tree.addFloating(3, 2);
    tree.select(moved);
    tree.activateWorkspace(2);

    expect(tree.reconfigure(2, [10], 10)).toEqual(new Map([[2, 1], [3, 1]]));

    expect(tree.activeWorkspace).toBe(1);
    expect(tree.selection()).toEqual({kind: 'tiled', con: moved});
    expect([...leaves(tree.root(1, 10))].map(node => node.window)).toEqual([1, 2]);
    expect(tree.find(1)).toBe(destination);
    expect(tree.workspace(1).floating).toEqual([3]);
    expect(tree.reconfigure(4, [10, 30], 10)).toEqual(new Map());
    expect([...tree.workspaces.keys()]).toEqual([0, 1, 2, 3]);
    expect(tree.root(2, 30).children).toEqual([]);
    tree.check(new Set([1, 2, 3]));
  });

  it('keeps destination selection when a different removed workspace moves empty and floating-only state', () => {
    const tree = new Tree(4, [10, 20]);
    const selected = tree.insert(1, 1, 10);
    tree.addFloating(2, 2);
    tree.addFloating(3, 2);
    tree.selectFloating(2);
    tree.activateWorkspace(0);

    expect(tree.reconfigure(2, [10], 10)).toEqual(new Map([[2, 1], [3, 1]]));

    expect(tree.workspace(1).focusedCon).toBe(selected);
    expect(tree.workspace(1).floating).toEqual([2, 3]);
    expect(tree.selection(1)).toEqual({kind: 'tiled', con: selected});
    tree.check(new Set([1, 2, 3]));
  });

  it('maps a selected transferred root to its contents but does not replace focus for an empty root', () => {
    const moved = new Tree(2, [10]);
    const destination = moved.insert(1, 0, 10);
    moved.insert(2, 1, 10);
    moved.select(moved.root(1, 10));
    moved.activateWorkspace(1);

    moved.reconfigure(1, [10], 10);

    const selection = moved.selection();
    expect(selection?.kind).toBe('tiled');
    expect(selection?.kind === 'tiled'
      ? [...leaves(selection.con)].map(node => node.window)
      : []).toEqual([2]);
    expect(moved.find(1)).toBe(destination);

    const empty = new Tree(2, [10]);
    const retained = empty.insert(3, 0, 10);
    empty.select(empty.root(1, 10));
    empty.activateWorkspace(1);
    empty.reconfigure(1, [10], 10);
    expect(empty.selection()).toEqual({kind: 'tiled', con: retained});
    empty.check(new Set([3]));
  });
});
