import {describe, expect, it} from 'vitest';
import type {Con, SplitCon} from '../../../src/tree/node';
import {Tree} from '../../../src/tree/tree';

function wire(parent: SplitCon, children: Con[], percents = children.map(() => 1 / children.length)): void {
  parent.children = children;
  parent.percents = percents;
  parent.focusedChild = children.at(-1) ?? null;
  for (const child of children) child.parent = parent;
}

describe('Tree normalization', () => {
  it('flattens H(root) -> V -> H -> leaf and repairs a selected wrapper', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    const vertical = t.allocateSplit('splitv');
    const horizontal = t.allocateSplit('splith');
    const root = t.root(0, 0);
    wire(horizontal, [leaf], [1]);
    wire(vertical, [horizontal], [1]);
    wire(root, [vertical], [1]);
    t.select(vertical);

    t.normalize();

    expect(root.children).toEqual([horizontal]);
    expect(horizontal.parent).toBe(root);
    expect(vertical.parent).toBeNull();
    expect(vertical.children).toEqual([]);
    expect(t.selection()).toEqual({kind: 'tiled', con: horizontal});
    t.check(new Set([1]));
  });

  it('preserves H(root) -> V -> leaf', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    const vertical = t.allocateSplit('splitv');
    const root = t.root(0, 0);
    wire(vertical, [leaf], [1]);
    wire(root, [vertical], [1]);
    t.select(vertical);

    t.normalize();

    expect(root.children).toEqual([vertical]);
    expect(vertical.children).toEqual([leaf]);
    expect(t.selection()).toEqual({kind: 'tiled', con: vertical});
    t.check(new Set([1]));
  });

  it('does not apply split-only flattening through a tabbed container', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    const tabbed = t.allocateSplit('tabbed');
    const vertical = t.allocateSplit('splitv');
    const root = t.root(0, 0);
    wire(vertical, [leaf], [1]);
    wire(tabbed, [vertical], [1]);
    wire(root, [tabbed], [1]);

    t.normalize();

    expect(root.children).toEqual([tabbed]);
    expect(tabbed.children).toEqual([vertical]);
    expect(vertical.children).toEqual([leaf]);
    t.check(new Set([1]));
  });

  it('removes dead tiled and floating windows while preserving live members', () => {
    const t = new Tree(1, [0]);
    const dead = t.insert(1, 0, 0);
    const live = t.insert(2, 0, 0);
    const ws = t.workspace(0);
    ws.floating = [4, 3];
    t.select(dead);

    t.normalize(new Set([2, 3]));

    expect(t.find(1)).toBeNull();
    expect(t.find(2)).toBe(live);
    expect(ws.floating).toEqual([3]);
    expect(t.selection()).toEqual({kind: 'tiled', con: live});
    t.check(new Set([2, 3]));
  });

  it('preserves a surviving selected parent when removing an unselected leaf', () => {
    const t = new Tree(1, [0]);
    const a = t.insert(1, 0, 0);
    const b = t.insert(2, 0, 0);
    const vertical = t.allocateSplit('splitv');
    const root = t.root(0, 0);
    wire(vertical, [a, b], [0.25, 0.75]);
    wire(root, [vertical], [1]);
    t.select(vertical);

    t.remove(2);

    expect(vertical.children).toEqual([a]);
    expect(vertical.percents).toEqual([1]);
    expect(t.selection()).toEqual({kind: 'tiled', con: vertical});
    t.check(new Set([1]));
  });

  it('deletes empty non-root splits and selects the nearest surviving focused descendant', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    const empty = t.allocateSplit('splitv');
    const parent = t.allocateSplit('tabbed');
    const root = t.root(0, 0);
    wire(parent, [leaf, empty], [0.4, 0.6]);
    wire(root, [parent], [1]);
    t.select(empty);

    t.normalize();

    expect(parent.children).toEqual([leaf]);
    expect(parent.percents).toEqual([1]);
    expect(empty.parent).toBeNull();
    expect(t.selection()).toEqual({kind: 'tiled', con: leaf});
    t.check(new Set([1]));
  });

  it('keeps an empty monitor root as the tiled selection', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    t.select(leaf);
    t.normalize(new Set());
    expect(t.selection()).toEqual({kind: 'tiled', con: t.root(0, 0)});
    t.check(new Set());
  });

  it('is idempotent for topology, percentages and selection', () => {
    const t = new Tree(1, [0]);
    const a = t.insert(1, 0, 0);
    const b = t.insert(2, 0, 0);
    const vertical = t.allocateSplit('splitv');
    const horizontal = t.allocateSplit('splith');
    const root = t.root(0, 0);
    wire(horizontal, [a, b], [0.7, 0.3]);
    wire(vertical, [horizontal], [1]);
    wire(root, [vertical], [1]);
    t.select(b);
    t.normalize();
    const once = {
      rootChildren: [...root.children],
      innerChildren: [...horizontal.children],
      rootPercents: [...root.percents],
      innerPercents: [...horizontal.percents],
      selection: t.selection(),
    };

    t.normalize();

    expect(root.children).toEqual(once.rootChildren);
    expect(horizontal.children).toEqual(once.innerChildren);
    expect(root.percents).toEqual(once.rootPercents);
    expect(horizontal.percents).toEqual(once.innerPercents);
    expect(t.selection()).toEqual(once.selection);
    t.check(new Set([1, 2]));
  });
});

describe('Tree invariant checks', () => {
  it('rejects cycles and shared children without recursing forever or repairing them', () => {
    const cycleTree = new Tree(1, [0]);
    const cycle = cycleTree.allocateSplit('splitv');
    wire(cycleTree.root(0, 0), [cycle], [1]);
    cycle.children = [cycle];
    cycle.percents = [1];
    cycle.focusedChild = cycle;
    expect(() => cycleTree.check()).toThrow(/cycle|shared/i);
    expect(cycle.children).toEqual([cycle]);
    expect(() => cycleTree.check()).toThrow(/cycle|shared/i);

    const sharedTree = new Tree(1, [0]);
    const leaf = sharedTree.insert(1, 0, 0);
    wire(sharedTree.root(0, 0), [leaf, leaf], [0.5, 0.5]);
    expect(() => sharedTree.check()).toThrow(/cycle|shared/i);
    expect(sharedTree.root(0, 0).children).toEqual([leaf, leaf]);
  });

  it('rejects a leaf stored in a monitor root slot', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    leaf.parent = null;
    t.workspace(0).monitors.set(0, leaf as unknown as SplitCon);

    expect(() => t.check()).toThrow(/monitor root|split/i);
    expect(t.workspace(0).monitors.get(0)).toBe(leaf);
  });

  it.each([
    ['duplicate node id', (t: Tree) => {
      const a = t.insert(1, 0, 0), b = t.insert(2, 0, 0);
      b.id = a.id;
    }, /node.*id/i],
    ['invalid node id', (t: Tree) => {
      t.root(0, 0).id = 0;
    }, /node.*id/i],
    ['duplicate window id', (t: Tree) => {
      const a = t.insert(1, 0, 0), b = t.insert(2, 0, 0);
      b.window = a.window;
    }, /window.*id/i],
    ['invalid window id', (t: Tree) => {
      t.insert(1, 0, 0).window = 0;
    }, /window.*id/i],
    ['bad parent link', (t: Tree) => {
      t.insert(1, 0, 0).parent = null;
    }, /parent/i],
    ['root under another con', (t: Tree) => {
      t.insert(1, 0, 0);
      const child = t.allocateSplit('splitv', true);
      wire(t.root(0, 0), [child], [1]);
    }, /root/i],
    ['unflagged monitor root', (t: Tree) => {
      t.root(0, 0).root = false;
    }, /root/i],
    ['parented monitor root', (t: Tree) => {
      t.root(0, 0).parent = t.allocateSplit('splith');
    }, /root|parent/i],
    ['invalid root layout', (t: Tree) => {
      t.root(0, 0).layout = 'tabbed';
    }, /layout/i],
    ['invalid last split layout', (t: Tree) => {
      t.root(0, 0).lastSplitLayout = 'tabbed' as 'splith';
    }, /layout/i],
    ['empty non-root split', (t: Tree) => {
      wire(t.root(0, 0), [t.allocateSplit('splitv')], [1]);
    }, /empty/i],
    ['remaining flatten opportunity', (t: Tree) => {
      const leaf = t.insert(1, 0, 0);
      const vertical = t.allocateSplit('splitv');
      const horizontal = t.allocateSplit('splith');
      wire(horizontal, [leaf], [1]);
      wire(vertical, [horizontal], [1]);
      wire(t.root(0, 0), [vertical], [1]);
    }, /flatten/i],
    ['percentage length mismatch', (t: Tree) => {
      t.insert(1, 0, 0);
      t.root(0, 0).percents = [];
    }, /length/i],
    ['nonfinite percentage', (t: Tree) => {
      t.insert(1, 0, 0);
      t.root(0, 0).percents = [Infinity];
    }, /finite/i],
    ['nonpositive percentage', (t: Tree) => {
      t.insert(1, 0, 0);
      t.root(0, 0).percents = [0];
    }, /positive/i],
    ['percentage sum error', (t: Tree) => {
      t.insert(1, 0, 0);
      t.root(0, 0).percents = [0.5];
    }, /sum/i],
    ['invalid focused child', (t: Tree) => {
      t.insert(1, 0, 0);
      t.root(0, 0).focusedChild = t.allocateSplit('splitv');
    }, /focus/i],
  ] as const)('rejects %s without repairing it', (_name, corrupt, message) => {
    const t = new Tree(1, [0]);
    corrupt(t);
    expect(() => t.check()).toThrow(message);
    expect(() => t.check()).toThrow(message);
  });

  it('rejects invalid workspace and selection state', () => {
    const inactive = new Tree(1, [0]);
    inactive.activeWorkspace = 2;
    expect(() => inactive.check()).toThrow(/active workspace/i);

    const foreignSelection = new Tree(2, [0]);
    foreignSelection.workspace(0).focusedCon = foreignSelection.root(1, 0);
    expect(() => foreignSelection.check()).toThrow(/selection|workspace/i);

    const missingFloating = new Tree(1, [0]);
    missingFloating.workspace(0).focusedFloating = 4;
    expect(() => missingFloating.check()).toThrow(/floating/i);
  });

  it('rejects invalid, duplicate and tiled floating ids', () => {
    const invalid = new Tree(1, [0]);
    invalid.workspace(0).floating = [0];
    expect(() => invalid.check()).toThrow(/window.*id/i);

    const duplicate = new Tree(2, [0]);
    duplicate.workspace(0).floating = [2];
    duplicate.workspace(1).floating = [2];
    expect(() => duplicate.check()).toThrow(/window.*id|duplicate/i);

    const tiled = new Tree(1, [0]);
    tiled.insert(1, 0, 0);
    tiled.workspace(0).floating = [1];
    expect(() => tiled.check()).toThrow(/window.*id|duplicate/i);
  });

  it('requires every tracked window to be live when a live set is supplied', () => {
    const t = new Tree(1, [0]);
    t.insert(1, 0, 0);
    t.workspace(0).floating = [2];
    expect(() => t.check(new Set([1]))).toThrow(/live/i);
    expect(t.find(1)).not.toBeNull();
    expect(t.workspace(0).floating).toEqual([2]);
  });
});
