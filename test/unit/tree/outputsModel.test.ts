import {describe, expect, it} from 'vitest';
import {Tree} from '../../../src/tree/tree';
import type {MonitorId} from '../../../src/tree/node';

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
    // `outgoing` is the workspace the resolved output stops showing -- Task 19, D1: the engine can no
    // longer derive it from the focused output, because the resolved output need not be the focused one.
    expect(t.showWorkspace(4)).toEqual({output: 3, swap: true, outgoing: 0});
    expect(t.outputOf(4)).toBe(3);
    expect(t.focusedOutput).toBe(3);
  });

  it('brings an unshown workspace to whichever output is focused', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    expect(t.showWorkspace(4)).toEqual({output: 2, swap: true, outgoing: 1});
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

describe('moveWorkspaceToOutput', () => {
  it('moves the focused workspace and gives the vacated output one of its own', () => {
    const t = new Tree(10, outputs, 3);            // 0 on 3, 1 on 2, 2..9 on 3
    const result = t.moveWorkspaceToOutput(2);
    expect(result).toEqual({vacated: 3, nowVisible: 2});
    expect(t.outputOf(0)).toBe(2);
    expect(t.visible.get(2)).toBe(0);
    expect(t.visible.get(3)).toBe(2);
  });

  it('never leaves an output showing nothing', () => {
    const t = new Tree(2, outputs, 3);             // only workspaces 0 and 1
    t.moveWorkspaceToOutput(2);                    // workspace 0 leaves output 3, which owns nothing else
    expect(t.visible.get(3)).toBeDefined();
    expect(t.outputOf(t.visible.get(3)!)).toBe(3);
  });

  it('is a no-op when the workspace is already on that output', () => {
    const t = new Tree(10, outputs, 3);
    expect(t.moveWorkspaceToOutput(3)).toBeNull();
  });
});

describe('reconfigure across outputs', () => {
  it('keeps a lost output’s layout and moves the workspace to the primary', () => {
    const t = new Tree(10, outputs, 3);
    t.focusedOutput = 2;
    t.insert(1, 1); t.insert(2, 1);
    const rootBefore = t.root(1);
    const childrenBefore = [...rootBefore.children];
    t.reconfigure(10, [{id: 3, index: 1}], 3);
    expect(t.root(1)).toBe(rootBefore);                 // the same root object
    expect(t.root(1).children).toEqual(childrenBefore); // with the same layout
    expect(t.outputOf(1)).toBe(3);
    expect(t.focusedOutput).toBe(3);
  });

  it('restores the original assignment when the output comes back', () => {
    // Round 1, M1: the brief's fixture put the television on workspace 1, which is also what the
    // lowest-free rule hands a gained output -- so the test passed with the remembering switched off
    // entirely. Pinning workspace 1 to the primary instead leaves coverOutputs to give the television
    // workspace 9 at birth, so memory (9) and lowest-free (1) are different answers and the assertion
    // can only be met by the memory.
    const t = new Tree(10, outputs, 3, new Map([[1, 3]]));
    expect(t.outputOf(9)).toBe(2);
    t.reconfigure(10, [{id: 3, index: 1}], 3);
    expect(t.outputOf(9)).toBe(3);
    t.reconfigure(10, outputs, 3);
    expect(t.outputOf(9)).toBe(2);
    expect(t.visible.get(2)).toBe(9);
    expect(t.outputOf(1)).toBe(3);   // and the lowest-free rule did not fire in its place
  });

  it('survives every workspace living on the output that vanished', () => {
    // Review Focus 5: the primary already shows one of its own, so the rest must park with layouts intact.
    const t = new Tree(3, [{id: 2, index: 0}, {id: 3, index: 1}], 3,
      new Map([[0, 2], [1, 2], [2, 2]]));
    t.reconfigure(3, [{id: 3, index: 1}], 3);
    for (let index = 0; index < 3; index++) expect(t.outputOf(index)).toBe(3);
    expect(t.visible.size).toBe(1);
    expect(t.outputOf(t.visible.get(3)!)).toBe(3);
  });

  it('gives a brand-new output the lowest-numbered workspace not spoken for', () => {
    const t = new Tree(10, [{id: 3, index: 0}], 3);
    t.reconfigure(10, [{id: 3, index: 0}, {id: 9, index: 1}], 3);
    expect(t.visible.get(9)).toBe(1);
    expect(t.outputOf(1)).toBe(9);
  });

  it('forgets a workspace once it has come home, and remembers only the displaced', () => {
    const t = new Tree(10, outputs, 3);
    t.reconfigure(10, [{id: 3, index: 1}], 3);
    expect([...t.remembered()]).toEqual([[1, 2]]);   // workspace 1 alone was displaced
    t.reconfigure(10, outputs, 3);
    expect([...t.remembered()]).toEqual([]);
  });

  it('brings every workspace the returning output held home, not just the adopted one', () => {
    // Two of the television's own workspaces, so the reclaim of one cannot be mistaken for the rest.
    const t = new Tree(10, outputs, 3);
    t.moveWorkspaceToOutput(2);                     // workspace 0 joins workspace 1 on output 2
    expect(t.workspacesOn(2)).toEqual([0, 1]);
    t.reconfigure(10, [{id: 3, index: 1}], 3);
    expect(t.workspacesOn(2)).toEqual([]);
    t.reconfigure(10, outputs, 3);
    expect(t.workspacesOn(2)).toEqual([0, 1]);
  });

  it('leaves a workspace displaced in this very call waiting for its own output', () => {
    // Undock and plug a television in, in one event: the new output takes an untouched workspace, and
    // the displaced one keeps its home so a re-dock still restores it. Claiming the displaced workspace
    // instead would erase that memory -- and it is not free to claim either, since the whole point of
    // the remembering is that it is going somewhere.
    const t = new Tree(10, outputs, 3);
    t.insert(7, 1);
    t.reconfigure(10, [{id: 3, index: 1}, {id: 9, index: 2}], 3);
    expect(t.visible.get(9)).toBe(2);
    expect(t.outputOf(1)).toBe(3);
    expect([...t.remembered()]).toEqual([[1, 2]]);
    t.check(new Set([7]));
    t.reconfigure(10, outputs.concat([{id: 9, index: 2}]), 3);
    expect(t.outputOf(1)).toBe(2);              // the television came back and took its workspace back
    expect(t.visible.get(2)).toBe(1);
    expect(t.visible.get(9)).toBe(2);           // and the new panel kept what it had been given
    t.check(new Set([7]));
  });

  it('memory beats a pin that names the gained output itself', () => {
    // Round 1, I1: the shipped version of this test pinned workspace 1 to output 3, which the
    // reconfigure never gains -- and `_claimForGained` is only ever called for a gained output, so the
    // pin was never read and inverting the precedence left the whole suite green. The pin has to name
    // the output coming back for the two tiers to compete at all.
    const t = new Tree(10, outputs, 3);
    t.reconfigure(10, [{id: 3, index: 1}], 3);            // television 2 unplugged: ws 1 remembered on 2
    expect([...t.remembered()]).toEqual([[1, 2]]);
    t.reconfigure(10, outputs, 3, new Map([[5, 2]]));      // replug, with workspace 5 pinned AT output 2
    expect(t.visible.get(2)).toBe(1);                      // memory wins
    expect(t.outputOf(5)).toBe(3);                         // the pin did not take effect
  });

  it('lets a deliberate move beat a memory when the home output returns', () => {
    // Round 1, I3. A memory records where the compositor's own change left a workspace; a command is
    // newer and better evidence about where it belongs. Without this, `move workspace to output` made
    // while the home output is asleep is silently undone the moment it wakes -- the very thing the
    // growth loop's comment gives as the reason a pin is never re-read for an existing workspace.
    const t = new Tree(3, [{id: 10, index: 0}, {id: 20, index: 1}, {id: 30, index: 2}], 10);
    t.insert(7, 1);
    t.reconfigure(3, [{id: 10, index: 0}, {id: 30, index: 2}], 10);   // the television sleeps
    expect([...t.remembered()]).toEqual([[1, 20]]);

    t.focusedOutput = 10;
    t.showWorkspace(1);                          // Mod+2: look at it where it is, on the laptop
    expect([...t.remembered()]).toEqual([[1, 20]]);   // merely looking re-homes nothing, so memory stands
    t.moveWorkspaceToOutput(30);                 // now park it on the third output on purpose
    expect(t.outputOf(1)).toBe(30);
    expect([...t.remembered()]).toEqual([]);

    t.reconfigure(3, [{id: 10, index: 0}, {id: 20, index: 1}, {id: 30, index: 2}], 10);
    expect(t.outputOf(1)).toBe(30);              // the television's return does not undo the move
    t.check(new Set([7]));
  });

  it('remembers the first home across a chained unplug, not the refuge', () => {
    // Round 1, I4. The television sleeps, so workspace 1 takes refuge on the laptop; the laptop is then
    // undocked in the same event that wakes the television. Recording that second displacement would
    // replace workspace 1's true home (20) with the refuge (10), and the re-dock would drag it off the
    // television it had just got back. First displacement wins; every later hop is a refuge.
    const t = new Tree(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    t.reconfigure(3, [{id: 10, index: 0}], 10);
    expect([...t.remembered()]).toEqual([[1, 20]]);

    t.reconfigure(3, [{id: 20, index: 1}], 20);
    expect(t.outputOf(1)).toBe(20);                         // home, by its own memory
    expect([...t.remembered()]).toEqual([[0, 10], [2, 10]]); // and 20 is nowhere in the map

    t.reconfigure(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    expect(t.outputOf(1)).toBe(20);   // stays on the television
    expect(t.outputOf(0)).toBe(10);   // while the laptop's own two come home
    expect(t.outputOf(2)).toBe(10);
  });

  it('drops the memory of a workspace a gained output claims out of exile', () => {
    // Round 1, M2: the only path that exercises the claim pass's own `_remembered.delete`. Nothing else
    // is free, so the gained output takes the exile itself (`?? candidates[0]`); if the memory survived
    // that, the original output's return would yank the workspace off the output now showing it.
    const t = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    t.reconfigure(2, [{id: 10, index: 0}], 10);
    expect([...t.remembered()]).toEqual([[1, 20]]);
    t.reconfigure(2, [{id: 10, index: 0}, {id: 30, index: 2}], 10);
    expect(t.outputOf(1)).toBe(30);
    expect([...t.remembered()]).toEqual([]);
    t.reconfigure(3, [{id: 10, index: 0}, {id: 20, index: 1}, {id: 30, index: 2}], 10);
    expect(t.outputOf(1)).toBe(30);
    t.check();
  });

  it('hands out a copy of the remembered map rather than the live one', () => {
    // Round 1, M5: `ReadonlyMap` is a compile-time fiction over the real object -- a caller keeps a view
    // that mutates under it, and one cast writes straight through into the tree's own state.
    const t = new Tree(10, outputs, 3);
    t.reconfigure(10, [{id: 3, index: 1}], 3);
    const view = t.remembered();
    (view as Map<number, MonitorId>).clear();
    expect([...t.remembered()]).toEqual([[1, 2]]);
  });

  it('honours a pin for a gained output that nothing is remembered on', () => {
    const t = new Tree(10, [{id: 3, index: 0}], 3);
    t.reconfigure(10, [{id: 3, index: 0}, {id: 9, index: 1}], 3, new Map([[5, 9]]));
    expect(t.outputOf(5)).toBe(9);
    expect(t.visible.get(9)).toBe(5);
    expect(t.outputOf(1)).toBe(3);   // the lowest-free rule did not fire as well
  });
});

/**
 * Task 19, D1: `workspace N` resolves the output it materialises on at switch time, by the controller's
 * precedence -- occupied, then a config pin, then Task 16's memory, then the focused output. The desk
 * here is the user's own: the laptop panel (id 2, the primary) plus one external display (id 3), ten
 * workspaces, so eight of the ten are *stored* on the primary by the birth spread's surplus rule. That
 * stored output is bookkeeping for coverage and the bars; it is not an affinity, and none of these
 * tests may let it behave like one.
 */
describe('showWorkspace precedence (Task 19, D1)', () => {
  /** The user's desk: laptop panel 2 (primary, Mutter index 0), external display 3 (index 1). */
  const desk = [{id: 2, index: 0}, {id: 3, index: 1}];

  it('still spreads the first K workspaces one per output at birth', () => {
    // The feature the user asked for in the first place: "primary is workspace 1, external is
    // workspace 2". Fixing D1 must not quietly undo it, so this pins the whole visible map at birth.
    const t = new Tree(10, desk, 2);
    expect([...t.visible]).toEqual([[2, 0], [3, 1]]);
    expect(t.outputOf(0)).toBe(2);
    expect(t.outputOf(1)).toBe(3);
    expect(t.focusedOutput).toBe(2);
  });

  it('materialises an empty high-numbered workspace on the focused output', () => {
    // Rule 4, on the user's own topology: workspace 9 is *stored* on the primary (the surplus rule),
    // and switching to it from the external display must not drag the user's focus to the primary.
    const t = new Tree(10, desk, 2);
    t.focusedOutput = 3;
    expect(t.showWorkspace(8)).toEqual({output: 3, swap: true, outgoing: 1});
    expect([...t.visible]).toEqual([[2, 0], [3, 8]]);
    expect(t.outputOf(8)).toBe(3);
    expect(t.focusedOutput).toBe(3);
  });

  it('shows an occupied workspace on its own output instead of dragging its windows to the focused one', () => {
    // Rule 1, and the whole reason the precedence exists: a number key must never move a window
    // between displays. Workspace 1 holds a window on the external display and is hidden there (the
    // external is showing an empty workspace 5); pressing Mod+2 from the laptop must take the user to
    // the external display, not fetch the window onto the laptop.
    const t = new Tree(10, desk, 2);
    t.insert(7, 1);
    t.focusedOutput = 3;
    t.showWorkspace(5);
    expect([...t.visible]).toEqual([[2, 0], [3, 5]]);

    t.focusedOutput = 2;
    expect(t.showWorkspace(1)).toEqual({output: 3, swap: true, outgoing: 5});
    expect(t.outputOf(1)).toBe(3);
    expect([...t.visible]).toEqual([[2, 0], [3, 1]]);
    expect(t.focusedOutput).toBe(3);
    t.check(new Set([7]));
  });

  it('shows a workspace holding only a FLOATING window on its own output too', () => {
    // Final review, I2. Rule 1 reads `Tree.occupied`, and `occupied` is a disjunction --
    // `workspace.floating.length > 0 || !leaves(workspace.root).next().done`. The tiled half is pinned
    // by the test above and four others; the floating half was pinned by nothing, so dropping it left
    // the whole suite green while every floating-only workspace silently lost rule 1 and `$mod+N`
    // dragged it, windows and all, onto whichever display the user was looking at -- D1's exact
    // symptom. The fixture therefore gives workspace 1 NO tiled window at all, and parks it on the
    // external while the laptop is focused, so "its own output" (3) and "the focused output" (2) are
    // different answers.
    const t = new Tree(10, desk, 2);
    t.addFloating(7, 1);
    expect(t.occupied(1)).toBe(true);
    t.focusedOutput = 3;
    t.showWorkspace(5);
    expect([...t.visible]).toEqual([[2, 0], [3, 5]]);
    expect(t.outputShowing(1)).toBeNull();        // parked, so rule 1 is the only thing holding it

    t.focusedOutput = 2;
    expect(t.showWorkspace(1)).toEqual({output: 3, swap: true, outgoing: 5});
    expect(t.outputOf(1)).toBe(3);
    expect([...t.visible]).toEqual([[2, 0], [3, 1]]);
    expect(t.focusedOutput).toBe(3);
    t.check(new Set([7]));
  });

  it('honours a config pin at switch time for an empty workspace, not only at birth', () => {
    // Rule 2. `workspace 9 output <external>`: i3 honours that every time workspace 9 comes into
    // existence, not once at startup. Without it the first Mod+9 from the laptop re-homes workspace 9
    // onto the laptop and the pin never applies again for the rest of the session.
    const t = new Tree(10, desk, 2, new Map([[8, 3]]));
    expect(t.outputOf(8)).toBe(3);
    t.focusedOutput = 2;
    expect(t.showWorkspace(8)).toEqual({output: 3, swap: true, outgoing: 1});
    expect([...t.visible]).toEqual([[2, 0], [3, 8]]);
    expect(t.focusedOutput).toBe(3);
  });

  it('lets a pin lose to a workspace that holds windows', () => {
    // Rule 1 outranks rule 2: an occupied workspace the user moved off its pinned output stays where
    // its windows are. Only an empty workspace has nothing to lose by honouring the pin.
    const t = new Tree(10, desk, 2, new Map([[8, 3]]));
    t.focusedOutput = 2;
    t.showWorkspace(8);          // on the external, by the pin
    t.insert(7, 8);
    t.moveWorkspaceToOutput(2);  // the user moves it to the laptop on purpose
    expect(t.outputOf(8)).toBe(2);
    t.showWorkspace(0);          // the laptop looks elsewhere, so 9 is hidden but still occupied
    expect([...t.visible]).toEqual([[2, 0], [3, 1]]);

    t.focusedOutput = 3;
    expect(t.showWorkspace(8)).toEqual({output: 2, swap: true, outgoing: 0});
    expect(t.outputOf(8)).toBe(2);
    t.check(new Set([7]));
  });

  it('keeps a displaced workspace’s memory when a switch only gives it a refuge', () => {
    // Task 16 must survive D1: while the external is unplugged, Mod+2 shows workspace 1 on whatever is
    // live -- a refuge, not a home -- and the replug must still bring it back.
    //
    // Round 1, I3: this needs a THIRD display to discriminate anything. With two, an unplug reassigns the
    // workspace to the primary and the primary is also the only output left to take refuge on, so
    // `9612ba6`'s guard (`workspace.output !== output`) and this one (`_remembered.get(index) === output`)
    // agree and the fixture cannot see the change it exists to pin. Standing on a third display, where
    // the refuge is neither the remembered home nor the output the unplug left it on, splits them: the
    // old guard reads "this is a re-home" and cancels the homecoming.
    const desk3 = [{id: 2, index: 0}, {id: 3, index: 1}, {id: 4, index: 2}];
    const t = new Tree(10, desk3, 2);
    t.reconfigure(10, [{id: 2, index: 0}, {id: 4, index: 2}], 2);
    expect([...t.remembered()]).toEqual([[1, 3]]);
    expect(t.outputOf(1)).toBe(2);              // the unplug left it on the primary

    t.focusedOutput = 4;
    t.showWorkspace(1);                          // Mod+2 from the third display: a refuge, not a home
    expect(t.outputOf(1)).toBe(4);
    expect([...t.remembered()]).toEqual([[1, 3]]);

    t.reconfigure(10, desk3, 2);
    expect(t.outputOf(1)).toBe(3);
    expect(t.visible.get(3)).toBe(1);
  });
});

/**
 * Task 20, D6's layer-0 half. The tree cannot see monitors, so the engine hands it the output a
 * floating window's frame is actually on and this decides the workspace. Structural only: it moves
 * membership and nothing else -- no `workspace.output`, no `visible`, no `focusedOutput` (D5 keeps that
 * policy in `Engine._selectWindow`), so `coverOutputs` stays the sole authority on coverage.
 *
 * Every fixture below gives the two outputs different visible workspaces -- output 3 (primary) shows
 * workspace 0, output 2 shows workspace 1 -- so "re-homed to the destination's workspace" and "left on
 * its own" are distinguishable outcomes. With one output, or with both showing the same workspace, the
 * pre-fix behaviour would pass unchanged.
 */
describe('rehomeFloating', () => {
  const twoOutputs = (): Tree => {
    const t = new Tree(10, outputs, 3);
    expect(t.visible.get(3)).toBe(0);
    expect(t.visible.get(2)).toBe(1);
    return t;
  };

  it('moves a floating window to the workspace the output it sits on is showing', () => {
    const t = twoOutputs();
    t.addFloating(7, 0);
    expect(t.rehomeFloating(7, 2)).toBe(1);
    expect(t.location(7)).toEqual({workspace: 1, output: 2, floating: true});
    expect(t.workspace(0).floating).toEqual([]);
    expect(t.workspace(1).floating).toEqual([7]);
    t.check(new Set([7]));
  });

  it('brings it home again on the trip back, so A23’s round trip holds', () => {
    const t = twoOutputs();
    t.addFloating(7, 0);
    t.rehomeFloating(7, 2);
    expect(t.rehomeFloating(7, 3)).toBe(0);
    expect(t.location(7)).toEqual({workspace: 0, output: 3, floating: true});
    expect(t.workspace(1).floating).toEqual([]);
    t.setFloating(7, false);
    expect(t.find(7)).not.toBeNull();
    expect(t.outputOf(0)).toBe(3);
    t.check(new Set([7]));
  });

  it('leaves the vacated workspace’s floating focus on a survivor, not on the window that left', () => {
    const t = twoOutputs();
    t.addFloating(7, 0);
    t.addFloating(8, 0);
    t.selectFloating(7);
    expect(t.rehomeFloating(7, 2)).toBe(1);
    expect(t.workspace(0).focusedFloating).toBe(8);
    t.check(new Set([7, 8]));
  });

  it('does not take over the destination’s own floating focus, nor raise above its windows', () => {
    // The engine calls `_selectWindow` for the dragged window itself; a window re-homed for any other
    // reason must not steal the focus of a workspace on another screen.
    const t = twoOutputs();
    t.addFloating(7, 0);
    t.addFloating(9, 1);
    expect(t.rehomeFloating(7, 2)).toBe(1);
    expect(t.workspace(1).floating).toEqual([9, 7]);
    expect(t.workspace(1).focusedFloating).toBe(9);
    t.check(new Set([7, 9]));
  });

  it('is a no-op for a window already on that output, for a tiled one, and for a dead output', () => {
    const t = twoOutputs();
    t.addFloating(7, 0);
    const tiled = t.insert(8, 0);
    expect(t.rehomeFloating(7, 3)).toBeNull();
    expect(t.rehomeFloating(8, 2)).toBeNull();
    expect(t.rehomeFloating(7, 99)).toBeNull();
    expect(t.rehomeFloating(77, 2)).toBeNull();
    expect(t.location(7)).toEqual({workspace: 0, output: 3, floating: true});
    expect(t.find(8)).toBe(tiled);
    t.check(new Set([7, 8]));
  });

  it('changes neither coverage nor the focused output', () => {
    const t = twoOutputs();
    t.addFloating(7, 0);
    const visible = new Map(t.visible);
    const owners = new Map([...t.workspaces].map(([index, ws]) => [index, ws.output]));
    t.rehomeFloating(7, 2);
    expect(t.visible).toEqual(visible);
    expect(new Map([...t.workspaces].map(([index, ws]) => [index, ws.output]))).toEqual(owners);
    expect(t.focusedOutput).toBe(3);
    t.check(new Set([7]));
  });
});
