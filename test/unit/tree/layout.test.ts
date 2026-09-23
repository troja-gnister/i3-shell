import {describe, expect, it} from 'vitest';
import {layout, layoutWithRects, stackingOrder} from '../../../src/tree/layout';
import type {Rect} from '../../../src/tree/node';
import {leaf, split} from './helpers';

describe('tree layout', () => {
  it('tiles odd dimensions with the last child absorbing rounding', () => {
    const root = split('splith', [leaf(1), split('splitv', [leaf(2), leaf(3)])], true);

    const rects = layout(root, {x: 7, y: 31, width: 1919, height: 1049});

    expect([...rects]).toEqual([
      [1, {x: 7, y: 31, width: 960, height: 1049}],
      [2, {x: 967, y: 31, width: 959, height: 525}],
      [3, {x: 967, y: 556, width: 959, height: 524}],
    ]);
  });

  it.each(['tabbed', 'stacked'] as const)('%s gives every child the same rectangle', kind => {
    const con = split(kind, [leaf(1), leaf(2)]);
    const rect = {x: -100, y: 0, width: 800, height: 600};

    expect([...layout(con, rect).values()]).toEqual([rect, rect]);
    expect(stackingOrder(con)).toEqual([1, 2]);

    con.focusedChild = con.children[0];
    expect(stackingOrder(con)).toEqual([2, 1]);
  });

  it('raises an active subtree after all inactive tab children', () => {
    const active = split('splith', [leaf(1), leaf(2)]);
    const con = split('tabbed', [active, leaf(3)]);
    con.focusedChild = active;

    expect(stackingOrder(con)).toEqual([3, 1, 2]);
  });

  it('allows zero-sized work areas', () => {
    const root = split('splitv', [leaf(1), leaf(2)], true);

    expect(layout(root, {x: 4, y: -8, width: 0, height: 0})).toEqual(new Map([
      [1, {x: 4, y: -8, width: 0, height: 0}],
      [2, {x: 4, y: -8, width: 0, height: 0}],
    ]));
  });

  it('gives the final child all remaining pixels in a one-pixel work area', () => {
    const root = split('splith', [leaf(1), leaf(2), leaf(3), leaf(4)], true);

    expect([...layout(root, {x: 0, y: 0, width: 1, height: 10})]).toEqual([
      [1, {x: 0, y: 0, width: 0, height: 10}],
      [2, {x: 0, y: 0, width: 0, height: 10}],
      [3, {x: 0, y: 0, width: 0, height: 10}],
      [4, {x: 0, y: 0, width: 1, height: 10}],
    ]);
  });

  it('uses each child percentage and leaves the remainder to the final child', () => {
    const root = split('splith', [leaf(1), leaf(2), leaf(3)], true);
    root.percents = [0.2, 0.3, 0.5];

    expect([...layout(root, {x: 10, y: 20, width: 10, height: 5})]).toEqual([
      [1, {x: 10, y: 20, width: 2, height: 5}],
      [2, {x: 12, y: 20, width: 3, height: 5}],
      [3, {x: 15, y: 20, width: 5, height: 5}],
    ]);
  });

  it('returns ancestor rectangles without mutating the tree or input rectangle', () => {
    const first = leaf(1);
    const second = leaf(2);
    const root = split('splith', [first, second], true);
    const focused = root.focusedChild;
    const children = [...root.children];
    const percents = [...root.percents];
    const rect: Rect = {x: -3, y: 8, width: 11, height: 9};
    const originalRect = {...rect};

    const result = layoutWithRects(root, rect);

    expect(result.containers.get(root)).toEqual(rect);
    expect(result.containers.get(first)).toEqual({x: -3, y: 8, width: 6, height: 9});
    expect(result.containers.get(second)).toEqual({x: 3, y: 8, width: 5, height: 9});
    expect(result.windows).toEqual(new Map([
      [1, {x: -3, y: 8, width: 6, height: 9}],
      [2, {x: 3, y: 8, width: 5, height: 9}],
    ]));
    expect(root.children).toEqual(children);
    expect(root.percents).toEqual(percents);
    expect(root.focusedChild).toBe(focused);
    expect(first.parent).toBe(root);
    expect(second.parent).toBe(root);
    expect(rect).toEqual(originalRect);
  });

  it('records an empty root rectangle and no windows', () => {
    const root = split('splith', [], true);
    const rect = {x: 1, y: 2, width: 3, height: 4};

    const result = layoutWithRects(root, rect);

    expect(result.windows).toEqual(new Map());
    expect(result.containers).toEqual(new Map([[root, rect]]));
  });

  it.each([
    ['negative width', {x: 0, y: 0, width: -1, height: 1}],
    ['negative height', {x: 0, y: 0, width: 1, height: -1}],
    ['fractional component', {x: 0.5, y: 0, width: 1, height: 1}],
    ['nonfinite component', {x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1}],
  ])('rejects %s rectangles', (_name, rect) => {
    const root = split('splith', [leaf(1)], true);

    expect(() => layout(root, rect)).toThrow(/rectangle|finite|integer|negative|invalid/i);
  });

  it('accepts negative monitor coordinates', () => {
    const root = split('splith', [leaf(1)], true);

    expect(layout(root, {x: -1920, y: -1200, width: 1920, height: 1200})).toEqual(new Map([
      [1, {x: -1920, y: -1200, width: 1920, height: 1200}],
    ]));
  });
});

describe('title row reservation', () => {
  it('reserves one row for a tabbed container, whatever the child count', () => {
    const root = split('tabbed', [leaf(1), leaf(2), leaf(3)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300}, 20);
    // i3 draws a single row of tabs across the top, so every child starts at y+20
    // and every child is 20px shorter -- three children, one row.
    for (const id of [1, 2, 3])
      expect(windows.get(id)).toEqual({x: 0, y: 20, width: 400, height: 280});
  });

  it('reserves one row per child for a stacked container', () => {
    const root = split('stacked', [leaf(1), leaf(2), leaf(3)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300}, 20);
    // i3 shows every stacked child's title row simultaneously: 3 x 20 = 60.
    for (const id of [1, 2, 3])
      expect(windows.get(id)).toEqual({x: 0, y: 60, width: 400, height: 240});
  });

  it('leaves split containers untouched', () => {
    const root = split('splith', [leaf(1), leaf(2)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300}, 20);
    expect(windows.get(1)).toEqual({x: 0, y: 0, width: 200, height: 300});
    expect(windows.get(2)).toEqual({x: 200, y: 0, width: 200, height: 300});
  });

  it('clamps to zero height rather than going negative when the rows do not fit', () => {
    // Review Focus: a stacked container shorter than its own title rows.
    const root = split('stacked', [leaf(1), leaf(2), leaf(3)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 40}, 20);
    const rect = windows.get(1)!;
    expect(rect.height).toBe(0);
    expect(rect.y).toBe(40);
  });

  it('defaults to no reservation so existing callers are unchanged', () => {
    const root = split('tabbed', [leaf(1)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300});
    expect(windows.get(1)).toEqual({x: 0, y: 0, width: 400, height: 300});
  });

  it('reserves nothing for a negative row height', () => {
    // No caller passes one today -- measureRowHeight() has a floor and the
    // engine's own default is 0 -- but a negative reservation is the one input
    // that makes a child start ABOVE its container and be taller than it, a
    // rectangle every consumer downstream would then trust. One clamp closes
    // it for good rather than relying on every future caller.
    const root = split('tabbed', [leaf(1)]);
    const {windows} = layoutWithRects(root, {x: 0, y: 0, width: 400, height: 300}, -20);
    expect(windows.get(1)).toEqual({x: 0, y: 0, width: 400, height: 300});
  });
});
