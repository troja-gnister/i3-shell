import {describe, expect, it} from 'vitest';
import type {Layout} from '../../../src/commands/model';
import type {SplitCon} from '../../../src/tree/node';
import {Tree} from '../../../src/tree/tree';
import {shape} from './helpers';

describe('split and layout operations', () => {
  it('keeps the pending vertical split for the next insertion', () => {
    const t = new Tree(1, [0]);
    t.insert(1, 0, 0);
    const b = t.insert(2, 0, 0);
    t.split('v');
    expect(b.parent?.layout).toBe('splitv');
    expect(b.parent?.children).toEqual([b]);
    t.insert(3, 0, 0);
    expect(shape(t.root(0, 0))).toEqual(['splith', [1, ['splitv', [2, 3]]]]);
    t.check(new Set([1, 2, 3]));
  });

  it('changes a single-child split parent without adding a wrapper', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);

    t.split('v');

    expect(t.root(0, 0).layout).toBe('splitv');
    expect(t.root(0, 0).children).toEqual([leaf]);
    expect(t.selection()).toEqual({kind: 'tiled', con: leaf});
    t.check(new Set([1]));
  });

  it('wraps a selected child when its parent has siblings and preserves its slot weight', () => {
    const t = new Tree(1, [0]);
    const a = t.insert(1, 0, 0);
    const b = t.insert(2, 0, 0);
    const root = t.root(0, 0);
    root.percents = [0.7, 0.3];
    t.select(b);

    t.split('v');

    const wrapper = b.parent;
    expect(wrapper).toMatchObject({kind: 'split', layout: 'splitv', children: [b], percents: [1]});
    expect(root.children).toEqual([a, wrapper]);
    expect(root.percents).toEqual([0.7, 0.3]);
    expect(t.selection()).toEqual({kind: 'tiled', con: b});
    t.check(new Set([1, 2]));
  });

  it('wraps every root child and transfers percentages and focus wholesale', () => {
    const t = new Tree(1, [0]);
    const a = t.insert(1, 0, 0);
    const b = t.insert(2, 0, 0);
    const root = t.root(0, 0);
    root.percents = [0.75, 0.25];
    root.focusedChild = a;
    t.select(root);

    t.split('v');

    const wrapper = root.children[0] as SplitCon;
    expect(wrapper).toMatchObject({
      kind: 'split',
      layout: 'splitv',
      children: [a, b],
      percents: [0.75, 0.25],
      focusedChild: a,
    });
    expect(root.children).toEqual([wrapper]);
    expect(root.percents).toEqual([1]);
    expect(root.focusedChild).toBe(wrapper);
    expect(t.selection()).toEqual({kind: 'tiled', con: wrapper});
    t.check(new Set([1, 2]));
  });

  it('uses the root orientation for split toggle', () => {
    const t = new Tree(1, [0]);
    const root = t.root(0, 0);

    t.split('toggle');
    expect(root.layout).toBe('splitv');
    t.split('toggle');
    expect(root.layout).toBe('splith');
    t.check();
  });

  it.each(['tabbed', 'stacked'] as const)(
    'keeps a split-only root when setting %s on a lone leaf',
    layout => {
      const t = new Tree(1, [0]);
      const leaf = t.insert(1, 0, 0);
      const root = t.root(0, 0);
      root.layout = 'splitv';

      t.setLayout(layout);

      expect(root.layout).toBe('splitv');
      expect(root.children).toHaveLength(1);
      expect(root.children[0]).toMatchObject({
        kind: 'split',
        layout,
        lastSplitLayout: 'splitv',
        children: [leaf],
      });
      expect(t.selection()).toEqual({kind: 'tiled', con: leaf});
      t.check(new Set([1]));
    },
  );

  it('does not create a childless tabbed or stacked wrapper at an empty root', () => {
    const t = new Tree(1, [0]);
    const root = t.root(0, 0);

    t.setLayout('tabbed');
    t.setLayout('stacked');

    expect(root).toMatchObject({layout: 'splith', children: [], percents: [], focusedChild: null});
    expect(t.selection()).toEqual({kind: 'tiled', con: root});
    t.check();
  });

  it('selects a tabbed wrapper when an explicitly selected root is wrapped', () => {
    const t = new Tree(1, [0]);
    const a = t.insert(1, 0, 0);
    const b = t.insert(2, 0, 0);
    const root = t.root(0, 0);
    root.percents = [0.8, 0.2];
    root.focusedChild = a;
    t.select(root);

    t.setLayout('tabbed');

    const wrapper = root.children[0] as SplitCon;
    expect(wrapper).toMatchObject({
      layout: 'tabbed',
      lastSplitLayout: 'splith',
      children: [a, b],
      percents: [0.8, 0.2],
      focusedChild: a,
    });
    expect(t.selection()).toEqual({kind: 'tiled', con: wrapper});
    t.check(new Set([1, 2]));
  });

  it('toggles from tabbed back to the last split orientation', () => {
    const t = new Tree(1, [0]);
    t.insert(1, 0, 0);
    t.split('v');
    t.setLayout('tabbed');
    t.toggleLayout('split');
    expect(t.find(1)?.parent?.layout).toBe('splitv');
    expect(t.find(1)?.parent?.lastSplitLayout).toBe('splitv');
    t.check(new Set([1]));
  });

  it('preserves the last split orientation through both tabbed and stacked layouts', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    t.split('v');
    t.setLayout('tabbed');
    t.setLayout('stacked');
    expect(leaf.parent).toMatchObject({layout: 'stacked', lastSplitLayout: 'splitv'});
    t.toggleLayout('split');
    expect(leaf.parent).toMatchObject({layout: 'splitv', lastSplitLayout: 'splitv'});
    t.check(new Set([1]));
  });

  it('cycles explicit toggle lists and chooses the first layout when absent', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    const cycle = ['tabbed', 'stacked'] satisfies Layout[];

    t.toggleLayout(cycle);
    expect(leaf.parent?.layout).toBe('tabbed');
    t.toggleLayout(cycle);
    expect(leaf.parent?.layout).toBe('stacked');
    t.toggleLayout(cycle);
    expect(leaf.parent?.layout).toBe('tabbed');
    t.check(new Set([1]));
  });

  it('cycles all layouts in order while keeping the root split-only', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);

    t.toggleLayout('all');
    expect(leaf.parent?.layout).toBe('splitv');
    t.toggleLayout('all');
    expect(leaf.parent?.layout).toBe('tabbed');
    t.toggleLayout('all');
    expect(leaf.parent?.layout).toBe('stacked');
    t.toggleLayout('all');
    expect(leaf.parent?.layout).toBe('splith');
    expect(t.root(0, 0).layout).toBe('splitv');
    t.check(new Set([1]));
  });

  it('rejects an empty toggle list before changing the tree', () => {
    const t = new Tree(1, [0]);
    const leaf = t.insert(1, 0, 0);
    const root = t.root(0, 0);
    const before = shape(root);

    expect(() => t.toggleLayout([])).toThrow(/empty|layout/i);

    expect(shape(root)).toEqual(before);
    expect(t.selection()).toEqual({kind: 'tiled', con: leaf});
    t.check(new Set([1]));
  });

  it('makes split and layout commands no-ops for a floating selection', () => {
    const t = new Tree(1, [0]);
    const tiled = t.insert(1, 0, 0);
    const workspace = t.workspace(0);
    workspace.floating = [2];
    t.selectFloating(2);
    const before = shape(t.root(0, 0));

    t.split('v');
    t.setLayout('tabbed');
    t.toggleLayout('all');

    expect(shape(t.root(0, 0))).toEqual(before);
    expect(t.selection()).toEqual({kind: 'floating', window: 2});
    expect(workspace.focusedCon).toBe(tiled);
    t.check(new Set([1, 2]));
  });
});
