import {describe, expect, it} from 'vitest';
import type {LeafCon} from '../../../src/tree/node';
import {Tree} from '../../../src/tree/tree';

describe('Tree ownership and selection', () => {
  it('inserts after a selected leaf and keeps inactive workspace focus local', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const a = t.insert(1, 0);
    const b = t.insert(2, 0);
    t.select(a);
    const c = t.insert(3, 0);
    expect(t.root(0).children).toEqual([a, c, b]);
    t.insert(4, 1);
    expect(t.activeWorkspace).toBe(0);
    expect(t.selection()).toEqual({kind: 'tiled', con: c});
    expect(t.selection(1)).toEqual({kind: 'tiled', con: t.find(4)});
    t.check(new Set([1, 2, 3, 4]));
  });

  it('rejects duplicate ids without changing membership', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const a = t.insert(1, 0);
    expect(() => t.insert(1, 0)).toThrow();
    expect(t.root(0).children).toEqual([a]);
    t.check(new Set([1]));
  });

  it('removes the last window but keeps its monitor root', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const root = t.root(0);
    t.insert(1, 0);
    t.remove(1);
    t.remove(1);
    expect(t.root(0)).toBe(root);
    expect(root.children).toEqual([]);
    expect(root.percents).toEqual([]);
    t.check(new Set());
  });

  it('assigns each workspace its own output and root in supplied order', () => {
    // Rewritten from the old spanning model: `new Tree(2, [2, 0])` used to give workspace 0 a root
    // per monitor. Now each workspace has exactly one output and one root, so this asserts the birth
    // assignment instead — primary 2 first, then 0 — and that separate workspaces never share a root.
    const t = new Tree(2, [{id: 2, index: 0}, {id: 0, index: 1}], 2);
    expect([...t.workspaces.keys()]).toEqual([0, 1]);
    expect(t.outputOf(0)).toBe(2);
    expect(t.outputOf(1)).toBe(0);
    expect(t.workspace(0).focusedCon).toBe(t.root(0));
    expect(t.root(0)).toMatchObject({
      root: true,
      parent: null,
      layout: 'splith',
      lastSplitLayout: 'splith',
      children: [],
      percents: [],
      focusedChild: null,
    });
    expect(t.root(0)).not.toBe(t.root(1));
    t.check();
  });

  it('keeps insertion and remembered focus within the addressed workspace', () => {
    // Rewritten: the old test addressed two monitors within a single workspace to show insertion
    // stays local. Each workspace now owns one root, so the same property is shown across two
    // workspaces (each on its own output) instead of two monitor roots within one.
    const t = new Tree(2, [{id: 0, index: 0}, {id: 2, index: 1}], 0);
    const left = t.insert(1, 0);
    const firstRight = t.insert(2, 1);
    const secondRight = t.insert(3, 1);
    t.select(left);
    const leftBefore = [...t.root(0).children];

    const thirdRight = t.insert(4, 1);

    expect(t.root(0).children).toEqual(leftBefore);
    expect(t.root(1).children).toEqual([firstRight, secondRight, thirdRight]);
    expect(t.selection(1)).toEqual({kind: 'tiled', con: thirdRight});
    t.check(new Set([1, 2, 3, 4]));
  });

  it('appends after a selected split and updates its local focus chain', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const a = t.insert(1, 0);
    const nested = t.allocateSplit('splitv');
    const root = t.root(0);
    root.children = [nested];
    root.percents = [1];
    root.focusedChild = nested;
    nested.parent = root;
    nested.children = [a];
    nested.percents = [1];
    nested.focusedChild = a;
    a.parent = nested;
    t.select(nested);

    const b = t.insert(2, 0);

    expect(nested.children).toEqual([a, b]);
    expect(nested.focusedChild).toBe(b);
    expect(root.focusedChild).toBe(nested);
    t.check(new Set([1, 2]));
  });

  it('selects tiled and floating members without activating their workspace', () => {
    const t = new Tree(2, [{id: 0, index: 0}], 0);
    const tiled = t.insert(1, 1);
    const ws = t.workspace(1);
    ws.floating = [3, 2];

    t.selectFloating(2);
    expect(t.activeWorkspace).toBe(0);
    expect(ws.floating).toEqual([2, 3]);
    expect(t.selection(1)).toEqual({kind: 'floating', window: 2});
    expect(ws.focusedCon).toBe(tiled);

    t.select(tiled);
    expect(t.activeWorkspace).toBe(0);
    expect(t.selection(1)).toEqual({kind: 'tiled', con: tiled});
    // was t.activateWorkspace(1): the test then reads t.selection() for the now-active workspace, so
    // both focusedOutput and visible must move (a read-only rewatch would leave the test on workspace 0).
    t.focusedOutput = t.outputOf(1);
    t.visible.set(t.outputOf(1), 1);
    expect(t.selection()).toEqual({kind: 'tiled', con: tiled});
    t.check(new Set([1, 2, 3]));
  });

  it('reports tiled and floating locations and rejects duplicate windows globally', () => {
    const t = new Tree(2, [{id: 0, index: 0}, {id: 2, index: 1}], 0);
    const tiled = t.insert(1, 1);
    t.workspace(0).floating.push(2);
    expect(t.find(1)).toBe(tiled);
    expect(t.find(2)).toBeNull();
    expect(t.location(1)).toEqual({workspace: 1, output: 2, floating: false});
    expect(t.location(2)).toEqual({workspace: 0, output: 0, floating: true});
    expect(t.location(9)).toBeNull();
    expect(() => t.insert(1, 0)).toThrow(/tracked|duplicate/i);
    expect(() => t.insert(2, 1)).toThrow(/tracked|duplicate/i);
    // The old two assertions here checked that the *other* monitor's root within each workspace
    // stayed empty; with one root per workspace there is no other root to check, so only the
    // untouched workspace 0's root remains meaningful.
    expect(t.root(0).children).toEqual([]);
  });

  it('rejects foreign, detached and forged-parent selections', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const foreignTree = new Tree(1, [{id: 0, index: 0}], 0);
    const foreign = foreignTree.insert(1, 0);
    const detached = t.allocateSplit('splitv');
    const forged: LeafCon = {kind: 'leaf', id: 500, parent: t.root(0), window: 500};

    expect(() => t.owner(foreign)).toThrow(/own/i);
    expect(() => t.select(foreign)).toThrow(/own/i);
    expect(() => t.select(detached)).toThrow(/own/i);
    expect(() => t.owner(forged)).toThrow(/own/i);
    expect(() => t.select(forged)).toThrow(/own/i);
    expect(t.selection()).toEqual({kind: 'tiled', con: t.root(0)});
  });

  it('removes selected and unselected floating windows with MRU fallback', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const tiled = t.insert(1, 0);
    const ws = t.workspace(0);
    ws.floating = [4, 3, 2];
    t.selectFloating(3);
    t.remove(4);
    expect(t.selection()).toEqual({kind: 'floating', window: 3});
    t.remove(3);
    expect(t.selection()).toEqual({kind: 'floating', window: 2});
    t.remove(2);
    expect(t.selection()).toEqual({kind: 'tiled', con: tiled});
    t.check(new Set([1]));
  });

  it.each([
    [0, [{id: 0, index: 0}], 0],
    [37, [{id: 0, index: 0}], 0],
    [1.5, [{id: 0, index: 0}], 0],
    [1, [], 0],
    [1, [{id: -1, index: 0}], -1],
    [1, [{id: 0.5, index: 0}], 0.5],
    [1, [{id: 0, index: 0}, {id: 0, index: 1}], 0],
  ])('rejects invalid constructor input (%s, %j, %s)', (count, outputs, primary) => {
    expect(() => new Tree(count, outputs, primary)).toThrow();
  });

  it.each([
    [-1, 0],
    [0, 0],
    [1.5, 0],
    [1, -1],
    [1, 0.5],
  ])('rejects invalid insertion (%s, %s) without consuming a node id', (window, workspace) => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    const control = new Tree(1, [{id: 0, index: 0}], 0);
    expect(() => t.insert(window, workspace)).toThrow();
    expect(t.insert(10, 0).id).toBe(control.insert(10, 0).id);
  });

  it('rejects invalid workspace operations and unknown floating selection', () => {
    const t = new Tree(1, [{id: 0, index: 0}], 0);
    expect(() => t.workspace(-1)).toThrow();
    expect(() => t.workspace(1)).toThrow();
    // was t.root(0, -1) / t.root(0, 2): root() no longer takes a monitor to validate.
    // was t.activateWorkspace(1): the method is deleted; outputOf(1) covers "no such workspace".
    expect(() => t.outputOf(1)).toThrow();
    expect(() => t.selectFloating(99)).toThrow();
    expect(t.activeWorkspace).toBe(0);
  });
});
