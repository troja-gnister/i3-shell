import {describe, expect, it} from 'vitest';
import {layoutWithRects} from '../../../src/tree/layout';
import type {Con, Rect, SplitCon} from '../../../src/tree/node';
import {resizeCon} from '../../../src/tree/resize';
import {Tree} from '../../../src/tree/tree';
import {leaf, split} from './helpers';

describe('tiled resize', () => {
  it('uses the matching ancestor width for pixels', () => {
    const a = leaf(1), b = leaf(2);
    const inner = split('splith', [a, b]);
    const root = split('splith', [leaf(3), inner], true);
    const {containers} = layoutWithRects(root, {x: 0, y: 0, width: 1000, height: 600});

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 50, ppt: null}, containers))
      .toBe(true);
    expect(inner.percents[0]).toBeCloseTo(0.6);
    expect(inner.percents[1]).toBeCloseTo(0.4);
    expect(root.percents).toEqual([0.5, 0.5]);
  });

  it('shrinks the selected branch and resizes by height', () => {
    const a = leaf(1), b = leaf(2), c = leaf(3);
    const vertical = split('splitv', [a, b, c], true);
    const {containers} = layoutWithRects(vertical, {x: 0, y: 0, width: 500, height: 600});

    expect(resizeCon(b, {action: 'shrink', dimension: 'height', px: 60, ppt: null}, containers))
      .toBe(true);
    expect(vertical.percents[0]).toBeCloseTo(0.3833333333333333);
    expect(vertical.percents[1]).toBeCloseTo(0.2333333333333333);
    expect(vertical.percents[2]).toBeCloseTo(0.3833333333333333);
  });

  it('rejects a request atomically when any sibling crosses the clamp', () => {
    const a = leaf(1), b = leaf(2), c = leaf(3);
    const root = split('splith', [a, b, c], true);
    root.percents = [0.85, 0.1, 0.05];
    const {containers} = layoutWithRects(root, {x: 0, y: 0, width: 1000, height: 600});
    const before = [...root.percents];

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 10, ppt: 10}, containers))
      .toBe(false);
    expect(root.percents).toEqual(before);
  });

  it('resizes in percentage points without pixel geometry', () => {
    const a = leaf(1), b = leaf(2);
    const root = split('splith', [a, b], true);

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 50000, ppt: 10}, new Map()))
      .toBe(true);
    expect(root.percents[0]).toBeCloseTo(0.6);
    expect(root.percents[1]).toBeCloseTo(0.4);
  });

  it('prefers ppt and accepts a zero-sized work area', () => {
    const a = leaf(1), b = leaf(2);
    const root = split('splith', [a, b], true);
    const zero = new Map<Con, Rect>([[root, {x: 0, y: 0, width: 0, height: 0}]]);

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: Number.NaN, ppt: 10}, zero))
      .toBe(true);
    expect(root.percents[0]).toBeCloseTo(0.6);
  });

  it.each([
    ['tabbed', 'width'],
    ['stacked', 'height'],
  ] as const)('treats %s as a %s matching ancestor', (layout, dimension) => {
    const a = leaf(1), b = leaf(2);
    const root = split(layout, [a, b], true);

    expect(resizeCon(a, {action: 'grow', dimension, px: 0, ppt: 10}, new Map())).toBe(true);
    expect(root.percents).toEqual([0.6, 0.4]);
  });

  it('uses the nearest matching ancestor and treats a one-child match as a no-op', () => {
    const a = leaf(1), b = leaf(2);
    const inner = split('splith', [a]);
    const root = split('splith', [inner, b], true);
    root.percents = [0.7, 0.3];
    const before = [...root.percents];

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 1, ppt: 10}, new Map()))
      .toBe(false);
    expect(inner.percents).toEqual([1]);
    expect(root.percents).toEqual(before);
  });

  it('rejects a zero amount or a tree without a matching ancestor', () => {
    const a = leaf(1), b = leaf(2);
    const vertical = split('splitv', [a, b], true);
    const before = [...vertical.percents];

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 0, ppt: null},
      new Map<Con, Rect>([[vertical, {x: 0, y: 0, width: 100, height: 100}]]))).toBe(false);
    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 10, ppt: 10}, new Map())).toBe(false);
    expect(vertical.percents).toEqual(before);
  });

  it('rejects pixel resize when the matching ancestor rectangle is missing', () => {
    const a = leaf(1), b = leaf(2);
    const root = split('splith', [a, b], true);

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 10, ppt: null}, new Map()))
      .toBe(false);
    expect(root.percents).toEqual([0.5, 0.5]);
  });

  it('rejects pixel resize when the matching ancestor extent is zero', () => {
    const a = leaf(1), b = leaf(2);
    const root = split('splith', [a, b], true);
    const rectangles = new Map<Con, Rect>([[root, {x: 0, y: 0, width: 0, height: 100}]]);

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px: 10, ppt: null}, rectangles))
      .toBe(false);
    expect(root.percents).toEqual([0.5, 0.5]);
  });

  it.each([
    {name: 'negative', px: -1, ppt: null},
    {name: 'nonfinite', px: Number.POSITIVE_INFINITY, ppt: null},
    {name: 'negative ppt', px: 1, ppt: -1},
    {name: 'nonfinite ppt', px: 1, ppt: Number.NaN},
  ])('rejects $name effective amounts', ({px, ppt}) => {
    const a = leaf(1), b = leaf(2);
    const root = split('splith', [a, b], true);
    const rectangles = new Map<Con, Rect>([[root, {x: 0, y: 0, width: 100, height: 100}]]);

    expect(resizeCon(a, {action: 'grow', dimension: 'width', px, ppt}, rectangles)).toBe(false);
    expect(root.percents).toEqual([0.5, 0.5]);
  });

  it.each([
    [[0.05, 0.95], 'grow'],
    [[0.95, 0.05], 'shrink'],
  ] as const)('accepts the exact 5%%/95%% boundary (%j, %s)', (start, action) => {
    const a = leaf(1), b = leaf(2);
    const root = split('splith', [a, b], true);
    root.percents = [...start];

    expect(resizeCon(a, {action, dimension: 'width', px: 0, ppt: 90}, new Map())).toBe(true);
    expect(root.percents[0]).toBeCloseTo(action === 'grow' ? 0.95 : 0.05);
    expect(root.percents[1]).toBeCloseTo(action === 'grow' ? 0.05 : 0.95);
  });

  it('keeps a selected parent container as the resize target', () => {
    const tree = new Tree(1, [0]);
    const root = tree.root(0, 0);
    const first = tree.insert(1, 0, 0);
    const second = tree.insert(2, 0, 0);
    const third = tree.insert(3, 0, 0);
    const inner = tree.allocateSplit('splitv');
    wire(inner, [first, second]);
    wire(root, [inner, third]);
    tree.select(inner);

    expect(tree.resize({action: 'grow', dimension: 'width', px: 10, ppt: 10}, new Map()))
      .toBe(true);
    expect(root.percents).toEqual([0.6, 0.4]);
    expect(inner.percents).toEqual([0.5, 0.5]);
    expect(tree.selection()).toEqual({kind: 'tiled', con: inner});
    expect(tree.resize({action: 'grow', dimension: 'height', px: 10, ppt: null}, new Map())).toBe(false);
    expect(tree.selection()).toEqual({kind: 'tiled', con: inner});
    tree.check(new Set([1, 2, 3]));
  });

  it('does nothing for floating selection', () => {
    const tree = new Tree(1, [0]);
    const tiled = tree.insert(1, 0, 0);
    tree.workspace(0).floating = [2];
    tree.selectFloating(2);
    const root = tree.root(0, 0);
    const before = [...root.percents];

    expect(tree.resize({action: 'grow', dimension: 'width', px: 10, ppt: 10}, new Map())).toBe(false);
    expect(root.percents).toEqual(before);
    expect(tree.selection()).toEqual({kind: 'floating', window: 2});
    expect(tree.workspace(0).focusedCon).toBe(tiled);
  });
});

function wire(parent: SplitCon, children: Con[]): void {
  parent.children = children;
  parent.percents = children.map(() => 1 / children.length);
  parent.focusedChild = children.at(-1) ?? null;
  for (const child of children) child.parent = parent;
}
