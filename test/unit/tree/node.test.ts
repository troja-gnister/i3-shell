import {describe, expect, it} from 'vitest';
import {
  attach,
  axis,
  descendFocused,
  detach,
  directionAxis,
  focusChain,
  isForward,
  leaves,
  replace,
  rootOf,
  walk,
} from '../../../src/tree/node';
import {leaf, split} from './helpers';

function parentState(parent: ReturnType<typeof split>) {
  return {
    children: [...parent.children],
    percents: [...parent.percents],
    focusedChild: parent.focusedChild,
    parents: parent.children.map(child => child.parent),
  };
}

function expectUnchanged(parent: ReturnType<typeof split>, before: ReturnType<typeof parentState>) {
  expect(parent.children).toEqual(before.children);
  expect(parent.percents).toEqual(before.percents);
  expect(parent.focusedChild).toBe(before.focusedChild);
  expect(parent.children.map(child => child.parent)).toEqual(before.parents);
}

describe('container helpers', () => {
  it('maps layouts and directions to axes', () => {
    expect(axis('splith')).toBe('h');
    expect(axis('splitv')).toBe('v');
    expect(axis('tabbed')).toBe('h');
    expect(axis('stacked')).toBe('v');
    expect(directionAxis('left')).toBe('h');
    expect(directionAxis('right')).toBe('h');
    expect(directionAxis('up')).toBe('v');
    expect(directionAxis('down')).toBe('v');
    expect(isForward('right')).toBe(true);
    expect(isForward('down')).toBe(true);
    expect(isForward('left')).toBe(false);
    expect(isForward('up')).toBe(false);
  });

  it('walks containers in preorder and filters leaves', () => {
    const a = leaf(1), b = leaf(2), c = leaf(3);
    const nested = split('splitv', [b, c]);
    const root = split('splith', [a, nested], true);
    expect([...walk(root)]).toEqual([root, a, nested, b, c]);
    expect([...leaves(root)]).toEqual([a, b, c]);
  });

  it('descends selected children and falls back to the first valid child', () => {
    const a = leaf(1), b = leaf(2), c = leaf(3);
    const nested = split('splitv', [b, c]);
    nested.focusedChild = c;
    const root = split('splith', [a, nested], true);
    root.focusedChild = nested;
    expect(descendFocused(root)).toBe(c);
    expect(descendFocused(a)).toBe(a);

    root.focusedChild = nested;
    nested.focusedChild = null;
    expect(descendFocused(root)).toBe(b);
    expect(nested.focusedChild).toBeNull();

    root.focusedChild = leaf(99);
    expect(descendFocused(root)).toBe(a);
    expect(root.focusedChild).not.toBe(root.children[0]);

    expect(descendFocused(split('splith', [], true))).toBeNull();
  });

  it('finds the containing root and rejects a detached container', () => {
    const a = leaf(1);
    const nested = split('splitv', [a]);
    const root = split('splith', [nested], true);
    expect(rootOf(a)).toBe(root);
    expect(() => rootOf(leaf(2))).toThrow(/root/i);
  });

  it('updates each ancestor focus chain to the visited child', () => {
    const a = leaf(1), b = leaf(2);
    const nested = split('splitv', [a, b]);
    const root = split('splith', [nested], true);
    root.focusedChild = null;
    nested.focusedChild = a;
    focusChain(b);
    expect(nested.focusedChild).toBe(b);
    expect(root.focusedChild).toBe(nested);
  });
});

describe('child-list operations', () => {
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

  it('repairs focus to the first remaining child when detaching it', () => {
    const a = leaf(1), b = leaf(2);
    const p = split('splith', [a, b], true);
    p.focusedChild = b;
    expect(detach(b)).toBe(p);
    expect(p.focusedChild).toBe(a);
  });

  it.each([-1, 0.5, 3])('rejects insertion index %s without mutation', index => {
    const a = leaf(1), b = leaf(2), child = leaf(3);
    const p = split('splith', [a, b], true);
    const before = parentState(p);
    expect(() => attach(p, child, index)).toThrow(/index/i);
    expectUnchanged(p, before);
    expect(child.parent).toBeNull();
  });

  it('rejects attached and root children without mutation', () => {
    const a = leaf(1), b = leaf(2);
    const p = split('splith', [a], true);
    const other = split('splitv', [b], true);
    const before = parentState(p);
    expect(() => attach(p, b, 1)).toThrow(/detached/i);
    expectUnchanged(p, before);
    expect(() => attach(p, other, 1)).toThrow(/root/i);
    expectUnchanged(p, before);
  });

  it('rejects self and ancestor attachment without mutation', () => {
    const parent = split('splith', []);
    const beforeSelf = parentState(parent);
    expect(() => attach(parent, parent, 0)).toThrow(/cycle/i);
    expectUnchanged(parent, beforeSelf);

    const ancestor = split('splith', []);
    attach(ancestor, parent, 0);
    const beforeAncestor = parentState(parent);
    expect(() => attach(parent, ancestor, 0)).toThrow(/cycle/i);
    expectUnchanged(parent, beforeAncestor);
  });

  it.each([
    [[0.5], 'length'],
    [[0, 1], 'positive'],
    [[Infinity, 0], 'finite'],
    [[0.6, 0.6], 'sum'],
  ])('rejects corrupt weights (%s) before attachment', (percents, message) => {
    const a = leaf(1), b = leaf(2), child = leaf(3);
    const p = split('splith', [a, b], true);
    p.percents = percents;
    const before = parentState(p);
    expect(() => attach(p, child, 1)).toThrow(new RegExp(message, 'i'));
    expectUnchanged(p, before);
    expect(child.parent).toBeNull();
  });

  it('rejects a detached split with corrupt weights without mutation', () => {
    const a = leaf(1), b = leaf(2), nestedLeaf = leaf(3);
    const p = split('splith', [a, b], true);
    const child = split('splitv', [nestedLeaf]);
    child.percents = [0];
    const parentBefore = parentState(p);
    const childBefore = parentState(child);
    expect(() => attach(p, child, 1)).toThrow(/positive/i);
    expectUnchanged(p, parentBefore);
    expectUnchanged(child, childBefore);
    expect(child.parent).toBeNull();
  });

  it('rejects invalid detachment and leaves both sides unchanged', () => {
    const a = leaf(1), b = leaf(2), detached = leaf(3);
    const p = split('splith', [a, b], true);
    const before = parentState(p);
    expect(() => detach(p)).toThrow(/parent/i);
    expectUnchanged(p, before);
    expect(() => detach(detached)).toThrow(/parent/i);
    expectUnchanged(p, before);
    expect(detached.parent).toBeNull();
    p.percents = [0.6, 0.6];
    const corruptBefore = parentState(p);
    expect(() => detach(a)).toThrow(/sum/i);
    expectUnchanged(p, corruptBefore);
    expect(a.parent).toBe(p);
  });

  it('rejects replacement failures before changing either side', () => {
    const a = leaf(1), b = leaf(2), attached = leaf(3), replacement = leaf(4);
    const p = split('splith', [a, b], true);
    const attachedParent = split('splitv', [attached]);
    const before = parentState(p);
    expect(() => replace(p, replacement, leaf(5))).toThrow(/child/i);
    expectUnchanged(p, before);
    expect(() => replace(p, a, attached)).toThrow(/detached/i);
    expectUnchanged(p, before);
    expect(attached.parent).toBe(attachedParent);

    const root = split('splitv', [], true);
    expect(() => replace(p, a, root)).toThrow(/root/i);
    expectUnchanged(p, before);
    const cycleOld = leaf(5);
    const cycleParent = split('splith', [cycleOld]);
    const cycleAncestor = split('splitv', [cycleParent]);
    const cycleBefore = parentState(cycleParent);
    expect(() => replace(cycleParent, cycleOld, cycleAncestor)).toThrow(/cycle/i);
    expectUnchanged(cycleParent, cycleBefore);
  });
});
