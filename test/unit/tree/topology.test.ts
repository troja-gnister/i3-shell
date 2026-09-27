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
      output: workspace.output,
      root: con(workspace.root),
      focusedCon: workspace.focusedCon?.id ?? null,
      floating: workspace.floating,
      focusedFloating: workspace.focusedFloating,
    })),
  };
}

describe('Tree topology reconfiguration', () => {
  // Rewritten: this is the phase's behaviour change. The old model gave a workspace one root per
  // monitor, and losing a monitor flattened that root's contents into the primary's. Now a workspace
  // owns exactly one root and one output, so losing the output it lives on reassigns the workspace to
  // the primary and leaves its root — and everything under it — untouched.
  it('keeps a lost output\'s workspace and its root, reassigning it to the primary', () => {
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    const a = tree.insert(1, 0);
    const b = tree.insert(2, 1);
    tree.select(b);
    tree.split('v');
    const c = tree.insert(3, 1);
    const keptRoot = tree.root(1);

    expect(tree.reconfigure(2, [{id: 10, index: 0}], 10)).toEqual(new Map());

    expect(tree.outputOf(0)).toBe(10);
    expect(tree.outputOf(1)).toBe(10);
    expect(tree.root(1)).toBe(keptRoot);
    expect(tree.find(1)).toBe(a);
    expect(tree.find(2)).toBe(b);
    expect(tree.find(3)).toBe(c);
    expect([...leaves(keptRoot)].map(node => node.window)).toEqual([2, 3]);
    expect(() => tree.check()).not.toThrow();
  });

  it('moves removed workspace contents to the last retained workspace', () => {
    const tree = new Tree(3, [{id: 10, index: 0}], 10);
    const a = tree.insert(1, 2);
    tree.addFloating(2, 2);

    const moves = tree.reconfigure(2, [{id: 10, index: 0}], 10);

    expect(moves).toEqual(new Map([[1, 1], [2, 1]]));
    expect(tree.find(1)).toBe(a);
    expect(tree.workspace(1).floating).toContain(2);
    expect(() => tree.check()).not.toThrow();
  });

  it.each([
    [0, [{id: 10, index: 0}], 10],
    [37, [{id: 10, index: 0}], 10],
    [1.5, [{id: 10, index: 0}], 10],
    [2, [], 10],
    [2, [{id: 10, index: 0}, {id: 10, index: 1}], 10],
    [2, [{id: -1, index: 0}], -1],
    [2, [{id: 10.5, index: 0}], 10.5],
    [2, [{id: 10, index: 0}], 20],
  ])('validates the complete target (%s, %j, %s) before mutation', (count, outputs, primary) => {
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    tree.insert(1, 0);
    tree.addFloating(2, 1);
    const before = snapshot(tree);
    const control = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    control.insert(1, 0);
    control.addFloating(2, 1);

    expect(() => tree.reconfigure(count, outputs, primary)).toThrow();
    expect(snapshot(tree)).toEqual(before);
    expect(tree.allocateSplit('splitv').id).toBe(control.allocateSplit('splitv').id);
  });

  // Rewritten: the old test reordered monitors within every workspace's root map and checked each
  // monitor's root survived the reorder. There is no such map now, so this checks the analogous
  // property instead: changing which output is primary does not disturb any existing workspace's
  // output or root (reassignment only happens on loss), and growth adds new workspaces to the primary.
  it('changing the primary preserves every existing workspace root, and growth adds to the primary', () => {
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    const rootA = tree.root(0);
    const rootB = tree.root(1);

    expect(tree.reconfigure(3, [{id: 20, index: 0}, {id: 10, index: 1}, {id: 30, index: 2}], 20))
      .toEqual(new Map());

    expect(tree.root(0)).toBe(rootA);
    expect(tree.root(1)).toBe(rootB);
    expect(tree.outputOf(0)).toBe(10);
    expect(tree.outputOf(1)).toBe(20);
    expect(tree.outputOf(2)).toBe(20);
    tree.check();
  });

  it('combines workspace and output removal, retains moved active focus, and supports later growth', () => {
    const tree = new Tree(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    const destination = tree.insert(1, 1);
    const moved = tree.insert(2, 2);
    tree.addFloating(3, 2);
    tree.select(moved);
    // was tree.activateWorkspace(2): reconfigure below only carries over the active workspace's
    // selection when it is one of the workspaces being removed, so workspace 2 must genuinely be
    // active, not just read.
    tree.focusedOutput = tree.outputOf(2);
    tree.visible.set(tree.outputOf(2), 2);

    expect(tree.reconfigure(2, [{id: 10, index: 0}], 10)).toEqual(new Map([[2, 1], [3, 1]]));

    expect(tree.activeWorkspace).toBe(1);
    expect(tree.selection()).toEqual({kind: 'tiled', con: moved});
    expect([...leaves(tree.root(1))].map(node => node.window)).toEqual([1, 2]);
    expect(tree.find(1)).toBe(destination);
    expect(tree.workspace(1).floating).toEqual([3]);
    expect(tree.reconfigure(4, [{id: 10, index: 0}, {id: 30, index: 1}], 10)).toEqual(new Map());
    expect([...tree.workspaces.keys()]).toEqual([0, 1, 2, 3]);
    expect(tree.root(2).children).toEqual([]);
    tree.check(new Set([1, 2, 3]));
  });

  it('keeps destination selection when a different removed workspace moves empty and floating-only state', () => {
    const tree = new Tree(4, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    const selected = tree.insert(1, 1);
    tree.addFloating(2, 2);
    tree.addFloating(3, 2);
    tree.selectFloating(2);
    // was tree.activateWorkspace(0): reconfigure below only rescues the active workspace's selection
    // when one of the removed workspaces was it, so workspace 0 must genuinely be current.
    tree.focusedOutput = tree.outputOf(0);
    tree.visible.set(tree.outputOf(0), 0);

    expect(tree.reconfigure(2, [{id: 10, index: 0}], 10)).toEqual(new Map([[2, 1], [3, 1]]));

    expect(tree.workspace(1).focusedCon).toBe(selected);
    expect(tree.workspace(1).floating).toEqual([2, 3]);
    expect(tree.selection(1)).toEqual({kind: 'tiled', con: selected});
    tree.check(new Set([1, 2, 3]));
  });

  it('maps a selected transferred root to its contents but does not replace focus for an empty root', () => {
    const moved = new Tree(2, [{id: 10, index: 0}], 10);
    const destination = moved.insert(1, 0);
    moved.insert(2, 1);
    moved.select(moved.root(1));
    // was moved.activateWorkspace(1): reconfigure below only carries over the active workspace's
    // selected root, so workspace 1 must genuinely be active, not just read.
    moved.focusedOutput = moved.outputOf(1);
    moved.visible.set(moved.outputOf(1), 1);

    moved.reconfigure(1, [{id: 10, index: 0}], 10);

    const selection = moved.selection();
    expect(selection?.kind).toBe('tiled');
    expect(selection?.kind === 'tiled'
      ? [...leaves(selection.con)].map(node => node.window)
      : []).toEqual([2]);
    expect(moved.find(1)).toBe(destination);

    const empty = new Tree(2, [{id: 10, index: 0}], 10);
    const retained = empty.insert(3, 0);
    empty.select(empty.root(1));
    empty.focusedOutput = empty.outputOf(1);
    empty.visible.set(empty.outputOf(1), 1);
    empty.reconfigure(1, [{id: 10, index: 0}], 10);
    expect(empty.selection()).toEqual({kind: 'tiled', con: retained});
    empty.check(new Set([3]));
  });
});
