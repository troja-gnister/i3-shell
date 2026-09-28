import {describe, expect, it} from 'vitest';
import {leaves, type Con} from '../../../src/tree/node';
import {Tree} from '../../../src/tree/tree';

function snapshot(tree: Tree): unknown {
  function con(value: Con): unknown {
    return value.kind === 'leaf'
      ? {kind: value.kind, id: value.id, window: value.window}
      : {
          kind: value.kind,
          id: value.id,
          root: value.root,
          layout: value.layout,
          lastSplitLayout: value.lastSplitLayout,
          percents: value.percents,
          focusedChild: value.focusedChild?.id ?? null,
          children: value.children.map(con),
        };
  }
  return {
    activeWorkspace: tree.activeWorkspace,
    workspaces: [...tree.workspaces].map(([index, workspace]) => ({
      index,
      output: workspace.output,
      root: con(workspace.root),
      focusedCon: workspace.focusedCon?.id ?? null,
      floating: workspace.floating,
      focusedFloating: workspace.focusedFloating,
    })),
  };
}

describe('Tree topology reconfiguration', () => {
  // Rewritten: this is the phase's behaviour change. The old model gave a workspace one root per
  // monitor, and losing a monitor flattened that root's contents into the primary's. Now a workspace
  // owns exactly one root and one output, so losing the output it lives on reassigns the workspace to
  // the primary and leaves its root — and everything under it — untouched.
  it('keeps a lost output\'s workspace and its root, reassigning it to the primary', () => {
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    const a = tree.insert(1, 0);
    const b = tree.insert(2, 1);
    tree.select(b);
    tree.split('v');
    const c = tree.insert(3, 1);
    const keptRoot = tree.root(1);

    expect(tree.reconfigure(2, [{id: 10, index: 0}], 10)).toEqual(new Map());

    expect(tree.outputOf(0)).toBe(10);
    expect(tree.outputOf(1)).toBe(10);
    expect(tree.root(1)).toBe(keptRoot);
    expect(tree.find(1)).toBe(a);
    expect(tree.find(2)).toBe(b);
    expect(tree.find(3)).toBe(c);
    expect([...leaves(keptRoot)].map(node => node.window)).toEqual([2, 3]);
    expect(() => tree.check()).not.toThrow();
  });

  it('moves removed workspace contents to the last retained workspace', () => {
    const tree = new Tree(3, [{id: 10, index: 0}], 10);
    const a = tree.insert(1, 2);
    tree.addFloating(2, 2);

    const moves = tree.reconfigure(2, [{id: 10, index: 0}], 10);

    expect(moves).toEqual(new Map([[1, 1], [2, 1]]));
    expect(tree.find(1)).toBe(a);
    expect(tree.workspace(1).floating).toContain(2);
    expect(() => tree.check()).not.toThrow();
  });

  it.each([
    // A nonnegative requested count below the output count is no longer invalid on its own: reconfigure
    // raises it to cover every output instead (see outputsModel.test.ts). A negative count is rejected
    // explicitly rather than silently absorbed by that clamp, so it remains invalid here alongside a
    // count too high to fix by raising it further, and otherwise-malformed input.
    [-1, [{id: 10, index: 0}], 10],
    [37, [{id: 10, index: 0}], 10],
    [1.5, [{id: 10, index: 0}], 10],
    [2, [], 10],
    [2, [{id: 10, index: 0}, {id: 10, index: 1}], 10],
    [2, [{id: -1, index: 0}], -1],
    [2, [{id: 10.5, index: 0}], 10.5],
    [2, [{id: 10, index: 0}], 20],
  ])('validates the complete target (%s, %j, %s) before mutation', (count, outputs, primary) => {
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    tree.insert(1, 0);
    tree.addFloating(2, 1);
    const before = snapshot(tree);
    const control = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    control.insert(1, 0);
    control.addFloating(2, 1);

    expect(() => tree.reconfigure(count, outputs, primary)).toThrow();
    expect(snapshot(tree)).toEqual(before);
    expect(tree.allocateSplit('splitv').id).toBe(control.allocateSplit('splitv').id);
  });

  // Rewritten: the old test reordered monitors within every workspace's root map and checked each
  // monitor's root survived the reorder. There is no such map now, so this checks the analogous
  // property instead: changing which output is primary does not disturb any existing workspace's
  // output or root (reassignment only happens on loss), and growth adds new workspaces to the primary.
  // Growth gives the earliest new workspace to whichever live output currently owns nothing — here,
  // the newly added output 30 — rather than blindly to the primary; a needy output would otherwise
  // have to share another output's workspace, which invariant 2 forbids.
  it('changing the primary preserves every existing workspace root, and growth covers a new output first', () => {
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    const rootA = tree.root(0);
    const rootB = tree.root(1);

    expect(tree.reconfigure(3, [{id: 20, index: 0}, {id: 10, index: 1}, {id: 30, index: 2}], 20))
      .toEqual(new Map());

    expect(tree.root(0)).toBe(rootA);
    expect(tree.root(1)).toBe(rootB);
    expect(tree.outputOf(0)).toBe(10);
    expect(tree.outputOf(1)).toBe(20);
    expect(tree.outputOf(2)).toBe(30);
    tree.check();
  });

  it("honours a pin for a workspace growth creates, F1: `workspace N output` at birth on reconfigure too", () => {
    // Output 30 attaches and the requested count rises by two, so growth creates workspaces 2 and 3;
    // only workspace 2 is pinned, to the newly attached output. Workspace 3 defaults to the primary,
    // which already owns workspace 0, so after growth every output already owns something and
    // coverOutputs has nothing left to repair (see the next test for when it does) -- this isolates the
    // pin itself from being incidentally satisfied by coverOutputs's own, separate safety net.
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    expect(tree.reconfigure(4, [{id: 10, index: 0}, {id: 20, index: 1}, {id: 30, index: 2}], 10,
      new Map([[2, 30]]))).toEqual(new Map());
    expect(tree.outputOf(2)).toBe(30);
    expect(tree.outputOf(3)).toBe(10);
    tree.check();
  });

  it('does not let a pin move a workspace that already existed before this reconfigure', () => {
    // §2.3: a pin says where a workspace is *born*, not where it stays forever -- otherwise
    // `move workspace to output` would be silently undone on the very next reconfigure. Three
    // workspaces across two outputs is a surplus: moving workspace 2 from 10 to 20 would still leave
    // both outputs owning at least one, so coverOutputs stays a no-op either way and cannot mask a pin
    // wrongly applied to an existing workspace by quietly moving it back (the same confound the growth
    // tests above must avoid, mirrored here).
    const tree = new Tree(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    expect(tree.outputOf(2)).toBe(10);
    expect(tree.reconfigure(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10, new Map([[2, 20]])))
      .toEqual(new Map());
    expect(tree.outputOf(2)).toBe(10);
    tree.check();
  });

  it('lets coverOutputs override a birth pin rather than leave a newly attached output with nothing', () => {
    // The pin asks for workspace 2 on output 20, which already owns workspace 1 -- so honouring it
    // literally would leave the newly attached output 30 owning nothing, breaking the invariant that
    // every live output shows one of its own. coverOutputs runs after assignment (same order as the
    // constructor) and takes the freshly pinned workspace back for the output that would be starved.
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    tree.reconfigure(2, [{id: 10, index: 0}, {id: 20, index: 1}, {id: 30, index: 2}], 10,
      new Map([[2, 20]]));
    expect(tree.outputOf(2)).toBe(30);
    expect(tree.workspacesOn(30).length).toBeGreaterThan(0);
    tree.check();
  });

  it('ignores a birth pin naming an output that is not among the outputs passed to reconfigure', () => {
    // Asserting merely that workspace 2 doesn't land on 99 would pass by construction -- nothing in
    // `outputs` is 99, so no correct *or* buggy code can assign it there directly. What a missing
    // liveness check actually breaks is coverOutputs's own invariant: an unchecked pin of 99 would
    // still count as an "owner" in its tally, diluting it and potentially leaving output 30 -- the one
    // actually newly attached -- without a workspace of its own. That is what this asserts.
    const tree = new Tree(2, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    tree.reconfigure(2, [{id: 10, index: 0}, {id: 20, index: 1}, {id: 30, index: 2}], 10,
      new Map([[2, 99]]));
    for (const output of [10, 20, 30]) expect(tree.workspacesOn(output).length).toBeGreaterThan(0);
    tree.check();
  });

  it('combines workspace and output removal, retains moved active focus, and supports later growth', () => {
    const tree = new Tree(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    const destination = tree.insert(1, 1);
    const moved = tree.insert(2, 2);
    tree.addFloating(3, 2);
    tree.select(moved);
    // was tree.activateWorkspace(2): reconfigure below only carries over the active workspace's
    // selection when it is one of the workspaces being removed, so workspace 2 must genuinely be
    // active, not just read.
    tree.focusedOutput = tree.outputOf(2);
    tree.visible.set(tree.outputOf(2), 2);

    expect(tree.reconfigure(2, [{id: 10, index: 0}], 10)).toEqual(new Map([[2, 1], [3, 1]]));

    expect(tree.activeWorkspace).toBe(1);
    expect(tree.selection()).toEqual({kind: 'tiled', con: moved});
    expect([...leaves(tree.root(1))].map(node => node.window)).toEqual([1, 2]);
    expect(tree.find(1)).toBe(destination);
    expect(tree.workspace(1).floating).toEqual([3]);
    expect(tree.reconfigure(4, [{id: 10, index: 0}, {id: 30, index: 1}], 10)).toEqual(new Map());
    expect([...tree.workspaces.keys()]).toEqual([0, 1, 2, 3]);
    expect(tree.root(2).children).toEqual([]);
    tree.check(new Set([1, 2, 3]));
  });

  it('keeps destination selection when a different removed workspace moves empty and floating-only state', () => {
    const tree = new Tree(4, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    const selected = tree.insert(1, 1);
    tree.addFloating(2, 2);
    tree.addFloating(3, 2);
    tree.selectFloating(2);
    // was tree.activateWorkspace(0): reconfigure below only rescues the active workspace's selection
    // when one of the removed workspaces was it, so workspace 0 must genuinely be current.
    tree.focusedOutput = tree.outputOf(0);
    tree.visible.set(tree.outputOf(0), 0);

    expect(tree.reconfigure(2, [{id: 10, index: 0}], 10)).toEqual(new Map([[2, 1], [3, 1]]));

    expect(tree.workspace(1).focusedCon).toBe(selected);
    expect(tree.workspace(1).floating).toEqual([2, 3]);
    expect(tree.selection(1)).toEqual({kind: 'tiled', con: selected});
    tree.check(new Set([1, 2, 3]));
  });

  it('maps a selected transferred root to its contents but does not replace focus for an empty root', () => {
    const moved = new Tree(2, [{id: 10, index: 0}], 10);
    const destination = moved.insert(1, 0);
    moved.insert(2, 1);
    moved.select(moved.root(1));
    // was moved.activateWorkspace(1): reconfigure below only carries over the active workspace's
    // selected root, so workspace 1 must genuinely be active, not just read.
    moved.focusedOutput = moved.outputOf(1);
    moved.visible.set(moved.outputOf(1), 1);

    moved.reconfigure(1, [{id: 10, index: 0}], 10);

    const selection = moved.selection();
    expect(selection?.kind).toBe('tiled');
    expect(selection?.kind === 'tiled'
      ? [...leaves(selection.con)].map(node => node.window)
      : []).toEqual([2]);
    expect(moved.find(1)).toBe(destination);

    const empty = new Tree(2, [{id: 10, index: 0}], 10);
    const retained = empty.insert(3, 0);
    empty.select(empty.root(1));
    empty.focusedOutput = empty.outputOf(1);
    empty.visible.set(empty.outputOf(1), 1);
    empty.reconfigure(1, [{id: 10, index: 0}], 10);
    expect(empty.selection()).toEqual({kind: 'tiled', con: retained});
    empty.check(new Set([3]));
  });

  // Reproduces a corruption the visibility rebuild used to have when it ran before the shrink: it
  // repointed *every* output whose shown workspace was deleted at the destination by index alone,
  // without checking that output actually owned it — so an unrelated output could end up showing a
  // workspace another output owns. Running the rebuild after the shrink (and letting an output that
  // owns nothing of its own fall back to its own lowest, never to another output's) fixes it.
  it('never lets two outputs show one workspace after a shrink', () => {
    const tree = new Tree(5, [{id: 0, index: 0}, {id: 1, index: 1}], 0);
    tree.visible.set(0, 2);

    tree.reconfigure(2, [{id: 0, index: 0}, {id: 1, index: 1}], 0);

    expect(tree.visible.get(0)).not.toBe(tree.visible.get(1));
    expect(tree.outputOf(tree.visible.get(0)!)).toBe(0);
    expect(tree.outputOf(tree.visible.get(1)!)).toBe(1);
    tree.check();
  });

  // Task 16's three additions. The flattening assertions this file used to make were already rewritten
  // to the reassign behaviour by Task 3 and are left exactly as they stand; these only add the
  // remembering and the gained-output rule on top.
  it('brings a lost output\u2019s layout back on the replug, roots and all', () => {
    // Round 1, M1: the first fixture put output 20 on workspace 1, which is also what the lowest-free
    // rule gives a gained output, so the test passed with the remembering switched off. Pinning
    // workspace 1 to the primary leaves coverOutputs to give output 20 workspace 2 instead, so the
    // layout comes back only if the memory brought it.
    const tree = new Tree(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10, new Map([[1, 10]]));
    expect(tree.outputOf(2)).toBe(20);
    const a = tree.insert(1, 2);
    tree.select(a);
    tree.split('v');
    const b = tree.insert(2, 2);
    const keptRoot = tree.root(2);

    tree.reconfigure(3, [{id: 10, index: 0}], 10);
    expect(tree.outputOf(2)).toBe(10);
    expect(tree.reconfigure(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10)).toEqual(new Map());

    // Nothing moved between workspaces in either direction, so the whole layout is the same objects.
    expect(tree.outputOf(2)).toBe(20);
    expect(tree.visible.get(20)).toBe(2);
    expect(tree.outputOf(1)).toBe(10);   // the lowest-free rule did not fire in its place
    expect(tree.root(2)).toBe(keptRoot);
    expect(tree.find(1)).toBe(a);
    expect(tree.find(2)).toBe(b);
    expect([...leaves(keptRoot)].map(node => node.window)).toEqual([1, 2]);
    tree.check(new Set([1, 2]));
  });

  it('drops a remembered home for a workspace a later shrink deletes', () => {
    // Otherwise a growth much later resurrects that index straight onto an output it has no claim to.
    const tree = new Tree(3, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    expect(tree.outputOf(1)).toBe(20);
    tree.reconfigure(3, [{id: 10, index: 0}], 10);
    expect([...tree.remembered()]).toEqual([[1, 20]]);
    tree.reconfigure(1, [{id: 10, index: 0}], 10);   // workspaces 1 and 2 cease to exist
    expect([...tree.remembered()]).toEqual([]);
    tree.check();
  });

  it('gives a newly attached output the lowest workspace nothing is showing, not the highest spare', () => {
    // Five workspaces all on output 10, which shows workspace 0. coverOutputs's own repair would hand
    // output 20 the donor's *highest* unshown workspace (4); the gained-output rule hands it the
    // lowest (1), which is i3's. The two differ here on purpose, so this cannot pass by either.
    const tree = new Tree(5, [{id: 10, index: 0}], 10);
    tree.reconfigure(5, [{id: 10, index: 0}, {id: 20, index: 1}], 10);
    expect(tree.outputOf(1)).toBe(20);
    expect(tree.visible.get(20)).toBe(1);
    expect(tree.workspacesOn(10)).toEqual([0, 2, 3, 4]);
    tree.check();
  });
});
