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
