import {describe, expect, it} from 'vitest';
import {Tree} from '../../../src/tree/tree';

/** The reporting desk: primary id 3 at Mutter index 1, television id 2 at index 0. */
const outputs = [{id: 2, index: 0}, {id: 3, index: 1}];

describe('Tree, per-output', () => {
  it('gives workspace 0 the primary and workspace 1 the other output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.outputOf(0)).toBe(3);
    expect(t.outputOf(1)).toBe(2);
  });

  it('shows workspace 0 on the primary and workspace 1 on the other, and focuses the primary', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.visible.get(3)).toBe(0);
    expect(t.visible.get(2)).toBe(1);
    expect(t.focusedOutput).toBe(3);
  });

  it('derives activeWorkspace from the focused output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.activeWorkspace).toBe(0);
    t.focusedOutput = 2;
    expect(t.activeWorkspace).toBe(1);
  });

  it('gives every workspace exactly one root', () => {
    const t = new Tree(10, outputs, 3);
    for (let index = 0; index < 10; index++) {
      const root = t.root(index);
      expect(root.root).toBe(true);
      expect(root.children).toEqual([]);
    }
  });

  it('assigns surplus workspaces to the primary so every workspace has an output', () => {
    const t = new Tree(10, outputs, 3);
    for (let index = 2; index < 10; index++) expect(t.outputOf(index)).toBe(3);
  });

  it('lists an output’s workspaces in ascending order', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.workspacesOn(2)).toEqual([1]);
    expect(t.workspacesOn(3)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('honours a pinned assignment', () => {
    const t = new Tree(4, outputs, 3, new Map([[2, 2]]));
    expect(t.outputOf(2)).toBe(2);
    expect(t.workspacesOn(2)).toEqual([1, 2]);
  });

  it('inserts into the workspace’s own root without being told an output', () => {
    const t = new Tree(2, outputs, 3);
    const leaf = t.insert(101, 1);
    expect(t.root(1).children).toContain(leaf);
    expect(t.location(101)).toEqual({workspace: 1, output: 2, floating: false});
  });

  it('reports a floating window’s output as its workspace’s', () => {
    const t = new Tree(2, outputs, 3);
    t.addFloating(102, 1);
    expect(t.location(102)).toEqual({workspace: 1, output: 2, floating: true});
  });

  it('works with a single output', () => {
    const t = new Tree(3, [{id: 0, index: 0}], 0);
    expect(t.visible.get(0)).toBe(0);
    expect(t.workspacesOn(0)).toEqual([0, 1, 2]);
    expect(t.activeWorkspace).toBe(0);
  });

  it('raises the workspace count so every output gets one of its own, never sharing one', () => {
    const t = new Tree(1, [{id: 2, index: 0}, {id: 3, index: 1}], 3);
    expect(t.workspaces.size).toBe(2);
    expect(t.visible.get(3)).not.toBe(t.visible.get(2));
    expect(t.outputOf(t.visible.get(3)!)).toBe(3);
    expect(t.outputOf(t.visible.get(2)!)).toBe(2);
  });

  // A pin can concentrate every workspace on one output at birth (here: pinning workspace 1, which
  // would otherwise be output 1's, onto output 0 as well), stranding output 1 with nothing of its own.
  it('repairs a birth pin that would strand an output, giving every output one it owns', () => {
    const t = new Tree(10, [{id: 0, index: 0}, {id: 1, index: 1}], 0, new Map([[1, 0]]));
    for (const output of [0, 1]) {
      const shown = t.visible.get(output);
      expect(shown).not.toBeUndefined();
      expect(t.outputOf(shown!)).toBe(output);
    }
  });

  // Unplug then replug, with no shrink: the workspace output 1 owned moves to the primary on loss and
  // does not come back on its own when output 1 returns — reconfigure must repair that, not just the
  // constructor.
  it('repairs an output that regains liveness owning nothing, after an unplug and replug', () => {
    const t = new Tree(10, [{id: 0, index: 0}, {id: 1, index: 1}], 0);
    t.reconfigure(10, [{id: 0, index: 0}], 0);
    t.reconfigure(10, [{id: 0, index: 0}, {id: 1, index: 1}], 0);
    const shown = t.visible.get(1);
    expect(shown).not.toBeUndefined();
    expect(t.outputOf(shown!)).toBe(1);
  });

  it('reconfigure also raises a request below the live output count', () => {
    const t = new Tree(4, outputs, 3);
    t.reconfigure(1, outputs, 3);
    expect(t.workspaces.size).toBe(2);
    expect(t.visible.get(3)).not.toBe(t.visible.get(2));
    expect(t.outputOf(t.visible.get(3)!)).toBe(3);
    expect(t.outputOf(t.visible.get(2)!)).toBe(2);
  });

  // Invariant 3 (the focused output is always live) is only enforced by one line, and every other
  // loss test in this suite has the primary focused, which never dies — so this is its only exercise.
  it('moves focus to the primary when the focused, non-primary output is lost', () => {
    const t = new Tree(2, outputs, 3);
    t.focusedOutput = 2;

    t.reconfigure(2, [{id: 3, index: 1}], 3);

    expect(t.focusedOutput).toBe(3);
    expect(t.activeWorkspace).toBe(t.visible.get(3));
  });
});

describe('enterOutput', () => {
  it('descends into the neighbour from the entering edge', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    const a = t.insert(1, 1), b = t.insert(2, 1);
    t.focusedOutput = 3;
    // Moving right into output 2 enters at its left, which is its first child.
    expect(t.enterOutput(2, 'right')).toBe(a);
    expect(t.focusedOutput).toBe(2);
    expect(b).toBeDefined();
  });

  it('enters from the far edge when moving left', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    t.insert(1, 1); const b = t.insert(2, 1);
    t.focusedOutput = 3;
    expect(t.enterOutput(2, 'left')).toBe(b);
  });

  it('focuses an empty output’s root and returns null', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.enterOutput(2, 'right')).toBeNull();
    expect(t.focusedOutput).toBe(2);
    expect(t.selection()).toEqual({kind: 'tiled', con: t.root(1)});
  });
});

describe('moveIntoOutput', () => {
  it('reseats the moved subtree at the front of the target root for a forward direction, keeping percents in step', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    const existing = t.insert(1, 1);
    t.focusedOutput = 3;
    t.insert(2, 0);

    const moved = t.moveIntoOutput(2, 'right');

    expect(moved).toEqual([2]);
    const root = t.root(1);
    expect(root.children).toEqual([t.find(2), existing]);
    expect(root.percents.length).toBe(2);
    expect(root.percents.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1);
    expect(t.focusedOutput).toBe(2);
  });

  it('reseats the moved subtree at the back of the target root for a backward direction', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    const first = t.insert(10, 1);
    t.insert(11, 1);
    // Focus the *first* child, so the plain insertion point lands the moved subtree in the middle --
    // otherwise a backward reseat would be a no-op even if `_reseatAtEdge` did nothing at all.
    t.select(first);
    t.focusedOutput = 3;
    t.insert(99, 0);

    const moved = t.moveIntoOutput(2, 'left');

    expect(moved).toEqual([99]);
    const root = t.root(1);
    expect(root.children.map(con => con.kind === 'leaf' ? con.window : null)).toEqual([10, 11, 99]);
    expect(root.percents.length).toBe(3);
    expect(root.percents.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1);
  });

  it('leaves the normal insertion point alone when direction is null', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    const existing = t.insert(1, 1);
    t.focusedOutput = 3;
    t.insert(2, 0);

    const moved = t.moveIntoOutput(2, null);

    expect(moved).toEqual([2]);
    const root = t.root(1);
    // No reseat: the moved subtree stays wherever insertionPoint put it (after the existing focused
    // child), not forced to an edge.
    expect(root.children).toEqual([existing, t.find(2)]);
  });

  it('is a no-op when the output already shows the active workspace', () => {
    const t = new Tree(10, outputs, 3);
    t.insert(1, 0);
    expect(t.moveIntoOutput(3, 'right')).toEqual([]);
  });

  // Fix round 1, I1: `insertionPoint` can attach the moved subtree inside a pre-existing nested split
  // rather than as a direct child of the target root -- an entirely ordinary state after one `splitv`.
  // The reseat must lift the moved window out of that split, not relocate the split (and the unrelated
  // windows it already held) to the edge instead.
  it('lifts the moved window out of a nested split at the target, without disturbing the split itself', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    t.insert(10, 1);            // leafA: a direct child of the target root, untouched throughout.
    const b = t.insert(11, 1);  // about to be wrapped in a nested splitv.
    t.split('v');
    const c = t.insert(12, 1);  // inserted next to b, inside the new split -- not at the root.
    const nested = b.parent!;
    t.select(b);                // leafB focused, so the incoming window's insertion point is inside the split.
    t.focusedOutput = 3;
    t.insert(2, 0);

    const moved = t.moveIntoOutput(2, 'right');

    expect(moved).toEqual([2]);
    const root = t.root(1);
    // The moved window stands alone at the entering edge, as a direct child of root...
    expect(root.children[0]).toBe(t.find(2));
    // ...and the nested split it passed through keeps exactly its original two children, in their
    // original relative order -- nothing about it changed, only the moved window was ever there.
    expect(nested.children).toEqual([b, c]);
    expect(nested.percents.length).toBe(2);
  });
});

describe('showWorkspace', () => {
  it('moves focus to the output already showing that workspace, and swaps nothing', () => {
    const t = new Tree(10, outputs, 3);           // 0 on primary 3, 1 on 2
    expect(t.showWorkspace(1)).toEqual({output: 2, swap: false});
    expect(t.focusedOutput).toBe(2);
    expect(t.visible.get(3)).toBe(0);
  });

  it('brings an unshown workspace to the focused output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.showWorkspace(4)).toEqual({output: 3, swap: true});
    expect(t.outputOf(4)).toBe(3);
    expect(t.focusedOutput).toBe(3);
  });

  it('brings an unshown workspace to whichever output is focused', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    expect(t.showWorkspace(4)).toEqual({output: 2, swap: true});
    expect(t.outputOf(4)).toBe(2);
  });

  it('is a no-op for the workspace already visible on the focused output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.showWorkspace(0)).toEqual({output: 3, swap: false});
  });

  it('never leaves an output showing a workspace it does not own', () => {
    const t = new Tree(10, outputs, 3);
    t.showWorkspace(4);
    for (const [output, index] of t.visible) expect(t.outputOf(index)).toBe(output);
  });
});
