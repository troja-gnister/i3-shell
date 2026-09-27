import {describe, expect, it} from 'vitest';
import type {Con, SplitCon} from '../../../src/tree/node';
import {Tree} from '../../../src/tree/tree';
import {shape} from './helpers';

function wire(parent: SplitCon, children: Con[], percents = children.map(() => 1 / children.length)): void {
  parent.children = children;
  parent.percents = percents;
  parent.focusedChild = children.at(-1) ?? null;
  for (const child of children) child.parent = parent;
}

describe('floating membership', () => {
  it('returns focus to the remembered tiled container from floating', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const a = t.insert(1, 0);
    t.addFloating(2, 0);
    t.addFloating(3, 0);
    t.select(a);

    expect(t.focusModeToggle()).toBe(3);
    expect(t.selection()).toEqual({kind: 'floating', window: 3});
    expect(t.focusModeToggle()).toBe(1);
    expect(t.selection()).toEqual({kind: 'tiled', con: a});
    t.check(new Set([1, 2, 3]));
  });

  it('moves a window from floating to tiled and back while repeated requests are no-ops', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const tiled = t.insert(1, 0);
    t.addFloating(2, 0);
    t.addFloating(3, 0);
    t.selectFloating(3);

    t.setFloating(2, true);
    expect(t.workspace(0).floating).toEqual([3, 2]);
    expect(t.selection()).toEqual({kind: 'floating', window: 3});

    t.setFloating(2, false);
    const converted = t.find(2);
    expect(converted).not.toBeNull();
    expect(t.workspace(0).floating).toEqual([3]);
    expect(t.selection()).toEqual({kind: 'tiled', con: converted});

    t.setFloating(2, false);
    expect(t.find(2)).toBe(converted);
    expect(t.root(0).children).toEqual([tiled, converted]);

    t.setFloating(2, true);
    expect(t.find(2)).toBeNull();
    expect(t.workspace(0).floating).toEqual([2, 3]);
    expect(t.selection()).toEqual({kind: 'floating', window: 2});
    t.check(new Set([1, 2, 3]));
  });

  it('rejects duplicate and unknown ids without changing membership', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const tiled = t.insert(1, 0);
    t.addFloating(2, 1);

    expect(() => t.addFloating(1, 1)).toThrow(/tracked|duplicate/i);
    expect(() => t.addFloating(2, 0)).toThrow(/tracked|duplicate/i);
    expect(() => t.setFloating(9, true)).toThrow(/tracked|unknown/i);
    expect(() => t.setFloating(9, false)).toThrow(/tracked|unknown/i);

    expect(t.root(0).children).toEqual([tiled]);
    expect(t.workspace(0).floating).toEqual([]);
    expect(t.workspace(1).floating).toEqual([2]);
    t.check(new Set([1, 2]));
  });

  // Rewritten: setFloating no longer takes (or validates) a monitor, so the old "throws /monitor/i for
  // the wrong monitor" assertion has no equivalent. What remains meaningful — that re-tiling is
  // deterministic and doesn't burn an extra node id — is kept.
  it('re-tiles a floating window deterministically without consuming an extra node id', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const control = new Tree(1, [{id: 0, index: 0}], 0);
    t.addFloating(1, 0);
    control.addFloating(1, 0);

    t.setFloating(1, false);
    control.setFloating(1, false);
    expect(t.find(1)?.id).toBe(control.find(1)?.id);
    t.check(new Set([1]));
  });

  it('repairs remembered tiled focus while a floating window remains selected', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const a = t.insert(1, 0);
    const b = t.insert(2, 0);
    t.select(a);
    t.addFloating(3, 0);
    t.addFloating(4, 0);
    t.selectFloating(3);

    t.remove(4);
    expect(t.selection()).toEqual({kind: 'floating', window: 3});
    t.remove(1);
    expect(t.selection()).toEqual({kind: 'floating', window: 3});
    expect(t.workspace(0).focusedCon).toBe(b);
    t.remove(3);
    expect(t.selection()).toEqual({kind: 'tiled', con: b});
    t.check(new Set([2]));
  });

  it('leaves floating focus selected when no tiled leaf exists and toggles do nothing when both modes are empty', () => {
    const floatingOnly = new Tree(1, [{id: 0, index: 0}], 0);
    floatingOnly.addFloating(1, 0);
    expect(floatingOnly.focusModeToggle()).toBeNull();
    expect(floatingOnly.selection()).toEqual({kind: 'floating', window: 1});

    const empty = new Tree(1, [{id: 0, index: 0}], 0);
    const root = empty.root(0);
    expect(empty.focusModeToggle()).toBeNull();
    expect(empty.selection()).toEqual({kind: 'tiled', con: root});
    floatingOnly.check(new Set([1]));
    empty.check(new Set());
  });
});

describe('workspace transfer', () => {
  it('moves a selected subtree intact without following it', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    t.insert(1, 0);
    t.insert(2, 0);
    t.split('v');
    t.insert(3, 0);
    const selected = t.find(3)!.parent!;
    t.select(selected);

    expect(t.moveToWorkspace(1)).toEqual([2, 3]);
    expect(t.activeWorkspace).toBe(0);
    expect(t.root(1).children).toEqual([selected]);
    expect(shape(t.root(0))).toEqual(['splith', [1]]);
    expect(t.selection()).toEqual({kind: 'tiled', con: t.find(1)});
    t.check(new Set([1, 2, 3]));
  });

  it('moves every leaf of a selected root while retaining the source root', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const a = t.insert(1, 0), b = t.insert(2, 0);
    const source = t.root(0);
    source.percents = [0.7, 0.3];
    t.select(source);

    expect(t.moveToWorkspace(1)).toEqual([1, 2]);
    expect(t.root(0)).toBe(source);
    expect(source.children).toEqual([]);
    const transferred = t.root(1).children[0];
    expect(transferred.kind).toBe('split');
    if (transferred.kind !== 'split') throw new Error('expected transferred split');
    expect(transferred.root).toBe(false);
    expect(transferred.lastSplitLayout).toBe(source.lastSplitLayout);
    expect(transferred.children).toEqual([a, b]);
    expect(transferred.percents).toEqual([0.7, 0.3]);
    expect(transferred.focusedChild).toBe(b);
    expect(t.selection()).toEqual({kind: 'tiled', con: source});
    expect(t.activeWorkspace).toBe(0);
    t.check(new Set([1, 2]));
  });

  it('moves floating focus by MRU order and keeps the source workspace selection local', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const tiled = t.insert(1, 0);
    t.addFloating(2, 0);
    t.addFloating(3, 0);

    expect(t.moveToWorkspace(1)).toEqual([3]);
    expect(t.workspace(0).floating).toEqual([2]);
    expect(t.selection()).toEqual({kind: 'floating', window: 2});
    expect(t.workspace(0).focusedCon).toBe(tiled);
    expect(t.workspace(1).floating).toEqual([3]);
    expect(t.selection(1)).toEqual({kind: 'floating', window: 3});
    expect(t.activeWorkspace).toBe(0);
    t.check(new Set([1, 2, 3]));
  });

  // Rewritten: moveToWorkspace no longer takes a monitor, so the old "throws /monitor/i for the wrong
  // monitor" assertion has no equivalent; the unknown-workspace validation it shared the test with
  // still applies.
  it('validates the destination before detaching or allocating a root transfer wrapper', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const control = new Tree(2, [{id: 0, index: 0}], 0);
    const leaf = t.insert(1, 0);
    control.insert(1, 0);
    const source = t.root(0);
    t.select(source);
    control.select(control.root(0));

    expect(() => t.moveToWorkspace(2)).toThrow(/workspace/i);
    expect(t.root(0)).toBe(source);
    expect(source.children).toEqual([leaf]);
    expect(t.root(1).children).toEqual([]);

    expect(t.allocateSplit('splitv').id).toBe(control.allocateSplit('splitv').id);
    t.check(new Set([1]));
  });

  it('inserts after the target selected leaf instead of at the root end', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const moved = t.insert(1, 0);
    const first = t.insert(2, 1);
    const last = t.insert(3, 1);
    t.select(first);
    // was t.activateWorkspace(0): moveToWorkspace below reads the active workspace's selection, so
    // both focusedOutput and visible must name workspace 0 (already the default here, but explicit).
    t.focusedOutput = t.outputOf(0);
    t.visible.set(t.outputOf(0), 0);

    expect(t.moveToWorkspace(1)).toEqual([1]);
    expect(t.root(1).children).toEqual([first, moved, last]);
    expect(t.selection(1)).toEqual({kind: 'tiled', con: moved});
    expect(t.activeWorkspace).toBe(0);
    t.check(new Set([1, 2, 3]));
  });

  it('removes an emptied former parent and selects the nearest surviving focused descendant', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const survivor = t.insert(1, 0);
    const moved = t.insert(2, 0);
    t.split('v');
    const formerParent = moved.parent!;

    expect(t.moveToWorkspace(1)).toEqual([2]);
    expect(formerParent.parent).toBeNull();
    expect(t.root(0).children).toEqual([survivor]);
    expect(t.selection()).toEqual({kind: 'tiled', con: survivor});
    expect(t.find(2)).toBe(moved);
    t.check(new Set([1, 2]));
  });

  it('keeps normalization replacement selected when destination flattening replaces the moved wrapper', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const leaf = t.insert(1, 0);
    const replacement = t.allocateSplit('splith');
    const moved = t.allocateSplit('splitv');
    wire(replacement, [leaf]);
    wire(moved, [replacement]);
    const source = t.root(0);
    source.layout = 'splitv';
    source.lastSplitLayout = 'splitv';
    wire(source, [moved]);
    t.select(moved);

    expect(t.moveToWorkspace(1)).toEqual([1]);
    expect(t.root(1).children).toEqual([replacement]);
    expect(moved.parent).toBeNull();
    expect(t.selection(1)).toEqual({kind: 'tiled', con: replacement});
    t.check(new Set([1]));
  });

  it('does nothing for the same workspace or an empty selected root', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const selected = t.insert(1, 0);
    expect(t.moveToWorkspace(0)).toEqual([]);
    expect(t.selection()).toEqual({kind: 'tiled', con: selected});

    // was t.activateWorkspace(1): the test then reads/acts on workspace 1's selection, so both
    // focusedOutput and visible must move onto it.
    t.focusedOutput = t.outputOf(1);
    t.visible.set(t.outputOf(1), 1);
    const emptyRoot = t.root(1);
    expect(t.moveToWorkspace(0)).toEqual([]);
    expect(t.root(1)).toBe(emptyRoot);
    expect(t.selection()).toEqual({kind: 'tiled', con: emptyRoot});
    t.check(new Set([1]));
  });
});
