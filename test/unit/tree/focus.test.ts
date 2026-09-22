import {describe, expect, it} from 'vitest';
import type {Direction} from '../../../src/commands/model';
import {descendDirection, nextFocus, type Wrapping} from '../../../src/tree/focus';
import type {Con, SplitCon} from '../../../src/tree/node';
import {Tree} from '../../../src/tree/tree';
import {leaf, split} from './helpers';

describe('directional focus helpers', () => {
  it.each([
    ['splith', 'right', 1],
    ['splith', 'left', 2],
    ['splitv', 'down', 1],
    ['splitv', 'up', 2],
  ] as const)('descends to the edge against %s travel for %s', (layout, direction, expected) => {
    const a = leaf(1), b = leaf(2);
    const con = split(layout, [a, b]);
    con.focusedChild = direction === 'right' || direction === 'down' ? b : a;

    expect(descendDirection(con, direction)).toBe(expected === 1 ? a : b);
  });

  it('follows focused children when nested tabbed and stacked axes do not match', () => {
    const a = leaf(1), b = leaf(2), c = leaf(3);
    const innerStacked = split('stacked', [a, b]);
    const outerTabbed = split('tabbed', [c, innerStacked]);
    innerStacked.focusedChild = b;
    outerTabbed.focusedChild = innerStacked;
    expect(descendDirection(outerTabbed, 'down')).toBe(a);

    const d = leaf(4), e = leaf(5), f = leaf(6);
    const innerTabbed = split('tabbed', [d, e]);
    const outerStacked = split('stacked', [f, innerTabbed]);
    innerTabbed.focusedChild = e;
    outerStacked.focusedChild = innerTabbed;
    expect(descendDirection(outerStacked, 'right')).toBe(d);

    outerTabbed.focusedChild = null;
    outerStacked.focusedChild = null;
    expect(descendDirection(outerTabbed, 'down')).toBe(c);
    expect(descendDirection(outerStacked, 'right')).toBe(f);
    expect(descendDirection(split('splith', []), 'right')).toBeNull();
  });

  it('searches higher matching ancestors before wrapping locally', () => {
    const a = leaf(1), b = leaf(2), c = leaf(3);
    const inner = split('splith', [a, b]);
    split('splith', [inner, c], true);
    expect(nextFocus(b, 'right', 'yes')).toBe(c);
    expect(nextFocus(b, 'right', 'force')).toBe(a);
    expect(nextFocus(c, 'right', 'yes')).toBe(b);
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

  it.each([
    ['left', 'splith', 1, 2],
    ['right', 'splith', 2, 1],
    ['up', 'splitv', 1, 2],
    ['down', 'splitv', 2, 1],
  ] as const)('applies every wrapping policy at the %s root edge', (direction, layout, start, wrapped) => {
    const a = leaf(1), b = leaf(2);
    split(layout, [a, b], true);
    const selected = start === 1 ? a : b;
    const target = wrapped === 1 ? a : b;
    const expected = new Map<Wrapping, Con | null>([
      ['no', null],
      ['yes', target],
      ['force', target],
      ['workspace', target],
    ]);

    for (const [wrapping, result] of expected)
      expect(nextFocus(selected, direction, wrapping)).toBe(result);
  });

  it('descends through a directional sibling by remembered focus', () => {
    const a = leaf(1), b = leaf(2), c = leaf(3);
    const tabbed = split('tabbed', [b, c]);
    tabbed.focusedChild = c;
    split('splith', [a, tabbed], true);

    expect(nextFocus(a, 'right', 'no')).toBe(c);
  });

  it('returns null for detached containers', () => {
    expect(nextFocus(leaf(1), 'left', 'yes')).toBeNull();
  });
});

function wire(parent: SplitCon, children: Con[]): void {
  parent.children = children;
  parent.percents = children.map(() => 1 / children.length);
  parent.focusedChild = children.at(-1) ?? null;
  for (const child of children) child.parent = parent;
}

describe('Tree focus selection', () => {
  it('selects a directional target and reports a blocked direction without changing selection', () => {
    const tree = new Tree(1, [0]);
    const a = tree.insert(1, 0, 0);
    const b = tree.insert(2, 0, 0);
    tree.select(a);

    expect(tree.focus('right', 'no')).toBe(b);
    expect(tree.selection()).toEqual({kind: 'tiled', con: b});
    expect(tree.focus('right', 'no')).toBeNull();
    expect(tree.selection()).toEqual({kind: 'tiled', con: b});
  });

  it('selects immediate parents up to and including the monitor root', () => {
    const tree = new Tree(1, [0]);
    const child = tree.insert(1, 0, 0);
    const parent = tree.allocateSplit('tabbed');
    const root = tree.root(0, 0);
    wire(parent, [child]);
    wire(root, [parent]);
    tree.select(child);

    expect(tree.focusParent()).toBe(parent);
    expect(tree.selection()).toEqual({kind: 'tiled', con: parent});
    expect(tree.focusParent()).toBe(root);
    expect(tree.selection()).toEqual({kind: 'tiled', con: root});
    expect(tree.focusParent()).toBeNull();
    expect(tree.selection()).toEqual({kind: 'tiled', con: root});
  });

  it('selects only the immediate focused child of a selected parent', () => {
    const tree = new Tree(1, [0]);
    const child = tree.insert(1, 0, 0);
    const inner = tree.allocateSplit('stacked');
    const parent = tree.allocateSplit('tabbed');
    const root = tree.root(0, 0);
    wire(inner, [child]);
    wire(parent, [inner]);
    wire(root, [parent]);
    tree.select(parent);

    expect(tree.focusChild()).toBe(inner);
    expect(tree.selection()).toEqual({kind: 'tiled', con: inner});
  });

  it('does nothing for floating selections', () => {
    const tree = new Tree(1, [0]);
    const tiled = tree.insert(1, 0, 0);
    const workspace = tree.workspace(0);
    workspace.floating = [2];
    tree.selectFloating(2);

    expect(tree.focus('right', 'yes')).toBeNull();
    expect(tree.focusParent()).toBeNull();
    expect(tree.focusChild()).toBeNull();
    expect(tree.selection()).toEqual({kind: 'floating', window: 2});
    expect(workspace.focusedCon).toBe(tiled);
  });

  it('does nothing when the selected root is empty', () => {
    const tree = new Tree(1, [0]);
    const root = tree.root(0, 0);

    for (const direction of ['left', 'right', 'up', 'down'] satisfies Direction[])
      expect(tree.focus(direction, 'yes')).toBeNull();
    expect(tree.focusParent()).toBeNull();
    expect(tree.focusChild()).toBeNull();
    expect(tree.selection()).toEqual({kind: 'tiled', con: root});
  });
});
