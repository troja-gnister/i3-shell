import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {Binding, Config} from '../../../src/config/model';
import type {NodeSnapshot} from '../../../src/runtime/snapshot';
import {LIVE_WORKSPACE} from '../../../src/runtime/model';
import {fakeEngine} from './fakeEngine';

const referenceText = readFileSync(new URL('../fixtures/reference.i3config', import.meta.url), 'utf8');

function binding(config: Config, mode: string, accel: string): Binding {
  const result = config.modes.get(mode)?.bindings.find(candidate => candidate.accel === accel);
  if (!result) throw new Error(`fixture is missing ${mode} binding ${accel}`);
  return result;
}

function windows(node: NodeSnapshot): number[] {
  return node.kind === 'leaf' ? [node.window] : node.children.flatMap(windows);
}

describe('engine command dispatch', () => {
  it('keeps a selected parent through duplicate focus and activation acknowledgements', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.add(2);
    f.flush();
    f.focus(2);

    f.engine.run([{type: 'focus', target: 'parent'}], 1);
    const selected = f.engine.treeSnapshot().workspaces[0].selected;
    f.focus(2);
    expect(f.engine.treeSnapshot().workspaces[0].selected).toEqual(selected);
    f.calls.length = 0;
    f.engine.run([{type: 'kill'}], 2);
    expect(f.calls.filter(call => call.startsWith('kill:'))).toEqual(['kill:1', 'kill:2']);

    f.focus(1);
    expect(f.engine.treeSnapshot().workspaces[0].selected).not.toEqual(selected);
    f.focus(2);
    expect(f.engine.treeSnapshot().workspaces[0].selected).toMatchObject({kind: 'tiled'});

    f.engine.run([{type: 'split', orientation: 'v'}], 3);
    f.add(3);
    f.focus(3);
    f.engine.run([{type: 'focus', target: 'parent'}], 4);
    const branch = f.engine.treeSnapshot().workspaces[0].selected;
    f.calls.length = 0;
    f.engine.run([{type: 'move', direction: 'left'}], 5);
    expect(f.calls).toContain('focus:3');
    expect(f.engine.treeSnapshot().workspaces[0].selected).toEqual(branch);
  });

  it('moves a selected parent once and keeps source focus through matching acknowledgements', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.add(2);
    f.engine.run([{type: 'split', orientation: 'v'}], 1);
    f.add(3);
    f.flush();
    f.engine.run([{type: 'focus', target: 'parent'}], 2);
    const selectedId = f.engine.treeSnapshot().workspaces[0].selected;
    const sourceBefore = f.engine.treeSnapshot().workspaces[0].root;
    const selectedNodeId = selectedId?.kind === 'tiled' ? selectedId.nodeId : -1;
    const selectedNode = sourceBefore.kind === 'split'
      ? sourceBefore.children.find(child => child.id === selectedNodeId)
      : undefined;
    expect(selectedNode && windows(selectedNode)).toEqual([2, 3]);

    f.calls.length = 0;
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 3);
    f.flush();

    expect(f.calls.filter(call => call.startsWith('moveTo:'))).toEqual(['moveTo:2:1', 'moveTo:3:1']);
    expect(f.calls.filter(call => call.startsWith('focus:'))).toEqual(['focus:1']);
    expect(f.engine.treeSnapshot().activeWorkspace).toBe(0);
    const snapshot = f.engine.treeSnapshot();
    expect(windows(snapshot.workspaces[0].root)).toEqual([1]);
    expect(snapshot.workspaces[0].selected).toMatchObject({kind: 'tiled'});
    const destination = snapshot.workspaces[1].root;
    expect(windows(destination)).toEqual([2, 3]);
    expect(destination.kind === 'split' && destination.children[0]).toMatchObject({
      kind: 'split', layout: 'splitv', children: [{window: 2}, {window: 3}],
    });

    f.change(2, {workspace: 1}, 'workspace');
    f.change(3, {workspace: 1}, 'workspace');
    expect(windows(f.engine.treeSnapshot().workspaces[1].root)).toEqual([2, 3]);
  });

  it('validates a root move target before transferring root contents as one subtree', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    f.engine.run([{type: 'focus', target: 'parent'}], 1);
    const before = f.engine.treeSnapshot().workspaces;
    expect(f.engine.run([
      {type: 'move_to_workspace', target: {kind: 'number', number: 99, name: '99'}},
    ], 2)).toBe('move container to workspace: no such workspace');
    expect(f.engine.treeSnapshot().workspaces).toEqual(before);

    f.calls.length = 0;
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 3);
    expect(f.calls.filter(call => call.startsWith('moveTo:'))).toEqual(['moveTo:1:1', 'moveTo:2:1']);
    const snapshot = f.engine.treeSnapshot();
    expect(snapshot.activeWorkspace).toBe(0);
    expect(snapshot.workspaces[0].root).toMatchObject({children: []});
    expect(snapshot.workspaces[1].root).toMatchObject({
      children: [{kind: 'split', layout: 'splith', children: [{window: 1}, {window: 2}]}],
    });
    f.change(1, {workspace: 1}, 'workspace');
    f.change(2, {workspace: 1}, 'workspace');
    expect(windows(f.engine.treeSnapshot().workspaces[1].root)).toEqual([1, 2]);
  });

  it('dispatches split, focus, move and ten-ppt resize through reference bindings', () => {
    const split = fakeEngine(referenceText);
    split.engine.start(); split.add(1); split.add(2); split.flush();
    split.engine.onBinding(binding(split.engine.config, 'default', '<Super>v'), 1);
    split.add(3); split.flush();
    let root = split.engine.treeSnapshot().workspaces[0].root;
    expect(root).toMatchObject({children: [{window: 1}, {layout: 'splitv', children: [{window: 2}, {window: 3}]}]});

    split.engine.onBinding(binding(split.engine.config, 'default', '<Super>l'), 2);
    expect(split.calls).toContain('focus:2');
    split.engine.onBinding(binding(split.engine.config, 'default', '<Super><Shift>k'), 3);
    root = split.engine.treeSnapshot().workspaces[0].root;
    expect(root).toMatchObject({children: [{window: 1}, {layout: 'splitv', children: [{window: 3}, {window: 2}]}]});

    split.engine.onBinding(binding(split.engine.config, 'default', '<Super>r'), 4);
    split.engine.onBinding(binding(split.engine.config, 'resize', 'semicolon'), 5);
    root = split.engine.treeSnapshot().workspaces[0].root;
    expect(root.kind === 'split' ? root.percents : []).toEqual([0.4, 0.6]);
  });

  it('switches directional, child and mode focus while preserving container selection semantics', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    f.engine.run([{type: 'floating', action: 'enable'}], 1);
    f.focus(1);
    f.calls.length = 0;
    f.engine.run([{type: 'focus', target: 'mode_toggle'}], 2);
    expect(f.calls).toContain('focus:2');
    f.engine.run([{type: 'focus', target: 'mode_toggle'}], 3);
    expect(f.calls).toContain('focus:1');

    f.engine.run([{type: 'floating', action: 'disable'}], 4);
    f.engine.run([{type: 'focus', target: 'parent'}, {type: 'focus', target: 'child'}], 5);
    expect(f.engine.treeSnapshot().workspaces[0].selected).toMatchObject({kind: 'tiled'});
    f.engine.run([{type: 'focus', target: 'left'}], 6);
    expect(f.calls.some(call => call === 'focus:1')).toBe(true);
  });

  it('sets and toggles layouts and raises the focused tab or stack last', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    f.calls.length = 0;
    f.engine.run([{type: 'layout', layout: 'tabbed'}], 1);
    expect(f.engine.treeSnapshot().workspaces[0].root).toMatchObject({
      children: [{layout: 'tabbed', children: [{window: 1}, {window: 2}]}],
    });
    expect(f.calls.filter(call => call.startsWith('raise:'))).toEqual(['raise:1', 'raise:2']);

    f.calls.length = 0;
    f.engine.run([{type: 'focus', target: 'left'}, {type: 'layout', layout: 'stacked'}], 2);
    expect(f.calls.filter(call => call.startsWith('raise:')).at(-2)).toBe('raise:2');
    expect(f.calls.filter(call => call.startsWith('raise:')).at(-1)).toBe('raise:1');
    f.engine.run([{type: 'layout_toggle', cycle: 'split'}], 3);
    expect(f.engine.treeSnapshot().workspaces[0].root).toMatchObject({
      children: [{layout: 'splith'}],
    });
  });

  it('applies floating resize and position arithmetic once per command', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1, {kind: 'floating', rect: {x: 11, y: 43, width: 300, height: 200}});
    f.flush();
    f.applied.length = 0;

    f.engine.run([{type: 'resize', action: 'grow', dimension: 'width', px: 10, ppt: 50}], 1);
    expect(f.applied.at(-1)?.get(1)).toEqual({x: 11, y: 43, width: 310, height: 200});
    f.engine.run([{type: 'move_position', position: 'center'}], 2);
    expect(f.applied.at(-1)?.get(1)).toEqual({x: 345, y: 280, width: 310, height: 200});
    f.engine.run([{type: 'move_position', position: {x: -20, y: 17}}], 3);
    expect(f.applied.at(-1)?.get(1)).toEqual({x: -20, y: 17, width: 310, height: 200});
    f.engine.run([{type: 'resize_set', width: 640, height: 480}], 4);
    expect(f.applied.at(-1)?.get(1)).toEqual({x: -20, y: 17, width: 640, height: 480});
  });

  it('rejects invalid floating sizes and does not reconcile later floating frames', () => {
    const f = fakeEngine(); f.engine.start();
    f.add(1, {kind: 'floating', rect: {x: 1, y: 2, width: 20, height: 30}});
    f.flush(); f.applied.length = 0;

    f.engine.run([{type: 'resize', action: 'shrink', dimension: 'width', px: 20, ppt: null}], 1);
    f.engine.run([{type: 'resize_set', width: Number.POSITIVE_INFINITY, height: 2}], 2);
    expect(f.applied).toEqual([]);
    f.engine.run([{type: 'resize_set', width: 80, height: 90}], 3);
    expect(f.applied.at(-1)?.get(1)).toEqual({x: 1, y: 2, width: 80, height: 90});

    f.applied.length = 0;
    f.change(1, {rect: {x: 8, y: 9, width: 81, height: 91}}, 'frame');
    f.flush();
    expect(f.applied).toEqual([]);
  });

  it('toggles floating membership, preserves the actual frame, and treats repeated state as a no-op', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.windows.set(1, {...f.windows.get(1)!, rect: {x: 9, y: 41, width: 333, height: 222}});
    f.applied.length = 0;
    f.engine.run([{type: 'floating', action: 'enable'}], 1);
    expect(f.engine.windowsSnapshot()[0].state).toBe('floating');
    expect(f.applied.at(-1)?.get(1)).toEqual({x: 9, y: 41, width: 333, height: 222});

    f.applied.length = 0;
    f.engine.run([{type: 'floating', action: 'enable'}], 2);
    expect(f.applied).toEqual([]);
    f.engine.run([{type: 'floating', action: 'disable'}], 3);
    expect(f.engine.windowsSnapshot()[0].state).toBe('tiled');
    expect(f.applied.at(-1)?.get(1)).toEqual({x: 0, y: 30, width: 1000, height: 700});
  });

  it('keeps tiled-only and split-only window commands as warning no-ops', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    f.engine.run([{type: 'focus', target: 'parent'}], 1);
    const before = f.engine.treeSnapshot().workspaces;
    f.calls.length = 0; f.applied.length = 0;
    f.engine.run([
      {type: 'floating', action: 'enable'},
      {type: 'fullscreen', action: 'toggle'},
      {type: 'resize_set', width: 1, height: 1},
      {type: 'move_position', position: 'center'},
    ], 2);
    expect(f.calls.filter(call => call.startsWith('fullscreen:'))).toEqual([]);
    expect(f.calls.filter(call => call.startsWith('warn:'))).toHaveLength(4);
    expect(f.applied).toEqual([]);
    expect(f.engine.treeSnapshot().workspaces).toEqual(before);

    f.engine.run([{type: 'focus', target: 'child'}], 3);
    f.windows.set(2, {...f.windows.get(2)!, fullscreen: true});
    f.calls.length = 0;
    f.engine.run([{type: 'fullscreen', action: 'enable'}], 4);
    expect(f.calls).toEqual(['fullscreen:2:enable']);
  });

  it('preserves nested layouts, percentages and a pending split across reload only', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2);
    f.engine.run([{type: 'split', orientation: 'v'}], 1);
    f.add(3); f.flush();
    f.engine.run([{type: 'resize', action: 'grow', dimension: 'height', px: 10, ppt: 20}], 2);
    f.engine.run([{type: 'split', orientation: 'h'}], 3);
    const before = f.engine.treeSnapshot().workspaces;
    expect(before[0].root).toMatchObject({
      children: [
        {window: 1},
        {layout: 'splitv', percents: [0.3, 0.7], children: [{window: 2}, {layout: 'splith', children: [{window: 3}]}]},
      ],
    });

    f.setNextLoad(f.load('bindsym Mod4+q kill'));
    expect(f.engine.run([{type: 'reload'}], 4)).toBe('reloaded');
    expect(f.engine.treeSnapshot().workspaces).toEqual(before);

    f.setNextLoad(f.load('bogus 1'));
    expect(f.engine.run([{type: 'restart'}], 5)).toContain('rejected');
    expect(f.engine.treeSnapshot().workspaces).toEqual(before);

    f.setNextLoad(f.load('bindsym Mod4+q kill'));
    expect(f.engine.run([{type: 'restart'}], 6)).toBe('restarted');
    const rebuilt = f.engine.treeSnapshot().workspaces;
    expect(rebuilt).not.toEqual(before);
    expect(windows(rebuilt[0].root)).toEqual([1, 2, 3]);
  });

  it('resolves numeric strings and workspace names before moving the selection', () => {
    // `workspace N` (Task 7) is what would let a second move act on window 1 again after switching to
    // where it landed; until then, a second window on the (single, always-visible) active workspace
    // exercises the same name/number resolution for the second move.
    const f = fakeEngine(referenceText); f.engine.start(); f.add(1); f.flush();
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'name', name: '2:II'}}], 1);
    expect(f.calls).toContain('moveTo:1:1');
    f.add(2); f.flush();
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'name', name: '3'}}], 3);
    // i3 workspace 2 (0-indexed) is not visible on any output, so _moveReconfigured translates the
    // move to the attic (1), not the raw i3 index.
    expect(f.calls).toContain('moveTo:2:1');
  });

  it('translates a move destination through visibility, not the raw i3 workspace index (F1)', () => {
    // Before the attic, moveToWorkspace(id, N) meant GNOME's own workspace N. GNOME now has exactly
    // two: whether some output currently shows the i3 workspace the window is moving to -- not the
    // index itself -- decides whether the window lands on LIVE or the attic.
    const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 10, index: 0}, {id: 11, index: 1}], primary: 10, workspaceCount: 3});
    f.engine.start();
    f.add(1); f.add(2); f.flush();   // both land on workspace 0, output 10 -- visible

    f.calls.length = 0;
    // Window 2 (added last, so it is the active workspace's own selection) moves first. Workspace 1
    // (i3 "number 2") is visible on output 11: the window must land on LIVE, not on 1.
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 0);
    expect(f.calls).toContain('moveTo:2:0');

    f.calls.length = 0;
    // Window 1 is still on workspace 0 (the active one), selected now that 2 has left it. Workspace 2
    // (i3 "number 3") is not shown by either output: the window is parked, in the attic.
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 3, name: '3'}}], 1);
    expect(f.calls).toContain('moveTo:1:1');
  });

  it('warns and continues when Mutter refuses a reconfigured move (F1)', () => {
    const f = fakeEngine('bindsym Mod4+q kill', {workspaceCount: 3});
    f.engine.start(); f.add(1); f.flush();
    f.ports.windows.moveToWorkspace = () => false;
    expect(() => f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 0))
      .not.toThrow();
    expect(f.calls.join('\n')).toMatch(/could not move window 1 to workspace 2; leaving it where it was/);
  });

  it('workspace prev stays put when the user is the only member of the cycle', () => {
    // Before Task 7, `workspace N` moved only GNOME's raw active index (real switching came from this
    // task), so this used to be exercised alongside a `ports.workspaces.activate` failure -- a failure
    // mode `workspace N` no longer has: it drives the tree directly, and `_workspaceIndex` gates an
    // unknown target before any of that runs.
    //
    // The old rule dead-ended here ('no such workspace': index 0 has no numeric predecessor). The cycle
    // never dead-ends -- an empty desk's cycle is {the visible workspace}, so `prev` wraps round to the
    // one member there is and the command reports the no-op switch it really made.
    const f = fakeEngine(); f.engine.start();
    expect(f.engine.run([{type: 'workspace', target: {kind: 'prev'}}], 2)).toBe('workspace: already active');
  });

  /**
   * i3's `workspace next`/`prev` walk the workspaces that EXIST and wrap; they are not numeric
   * neighbours. Every fixture below is built so the two rules disagree -- a fixture where 1, 2 and 3 are
   * open and the user is on 1 cannot tell them apart, because both answer 2.
   */
  describe('workspace next/prev cycle through existing workspaces', () => {
    /** Occupies each of `indices` with one window, leaving the engine focused on the last of them. */
    function occupy(f: ReturnType<typeof fakeEngine>, indices: number[]): void {
      let id = 1;
      for (const index of indices) {
        expect(f.engine.run([{type: 'workspace', target: {kind: 'number', number: index + 1, name: String(index + 1)}}], 0))
          .not.toContain('no such');
        f.add(id++);
        f.flush();
      }
    }

    it('wraps next from the highest occupied workspace back to the lowest', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {workspaceCount: 10});
      f.engine.start();
      occupy(f, [0, 1, 2]);
      expect(f.engine.state().activeWorkspace).toBe(2);
      // Numeric neighbour would be index 3 -- an empty workspace of the ten, reported as 'workspace 4'.
      expect(f.engine.run([{type: 'workspace', target: {kind: 'next'}}], 1)).toBe('workspace 1');
      expect(f.engine.state().activeWorkspace).toBe(0);
    });

    it('wraps prev from the lowest occupied workspace up to the highest', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {workspaceCount: 10});
      f.engine.start();
      occupy(f, [0, 1, 2]);
      f.engine.run([{type: 'workspace', target: {kind: 'number', number: 1, name: '1'}}], 1);
      // The old rule had no answer at index 0 at all.
      expect(f.engine.run([{type: 'workspace', target: {kind: 'prev'}}], 2)).toBe('workspace 3');
      expect(f.engine.state().activeWorkspace).toBe(2);
    });

    it('skips the empty workspaces between two occupied ones', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {workspaceCount: 10});
      f.engine.start();
      occupy(f, [0, 4]);
      f.engine.run([{type: 'workspace', target: {kind: 'number', number: 1, name: '1'}}], 1);
      // Numeric neighbour would be index 1, which holds nothing and is not in the cycle.
      expect(f.engine.run([{type: 'workspace', target: {kind: 'next'}}], 3)).toBe('workspace 5');
      expect(f.engine.state().activeWorkspace).toBe(4);
    });

    it('counts a workspace visible on another output as a member even when it is empty', () => {
      // Two outputs show workspaces 0 and 1; only 0 holds a window. The cycle is {0, 1} because 1 is on
      // screen, so `next` from 0 crosses to the other display rather than skipping to the next occupied
      // workspace -- which, with nothing else open, would have been 0 itself.
      const f = fakeEngine('bindsym Mod4+q kill',
        {monitors: [{id: 10, index: 0}, {id: 11, index: 1}], primary: 10, workspaceCount: 10});
      f.engine.start();
      f.add(1); f.flush();
      expect(f.engine.state().activeWorkspace).toBe(0);
      expect(f.engine.run([{type: 'workspace', target: {kind: 'next'}}], 1)).toBe('workspace 2');
      expect(f.engine.state().activeWorkspace).toBe(1);
    });
  });

  it('workspace number moves focus to the output holding that workspace', () => {
    const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
    f.engine.start();
    f.engine.run([{type: 'workspace', target: {kind: 'number', number: 2, name: '2'}}], 1);
    expect(f.engine.state().focusedOutput).toBe(1);
    // This focus-only move (nothing visible changes, `swap: false`) still has to relayout: without it,
    // the cached pills -- and the bar's focused-workspace highlight they drive -- would go stale.
    expect(f.engine.state().pills[1]!.focused).toBe(true);
    // Output 0's own workspace 0 is still on screen, just not where the keyboard is now -- i3bar's
    // third state (Task 8), the whole reason `active` could not describe a two-output desktop.
    expect(f.engine.state().pills[0]).toMatchObject({visible: true, focused: false});
  });

  it('workspaceIndexOn resolves a click position back to the real workspace index, per output', () => {
    const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
    f.engine.start();
    // Output 0 owns workspaces {0,2,3,...,9} (birthAssignment gives the primary every workspace beyond
    // the one each other output takes), so position 1 in its own, compacted list is real workspace
    // index 2, not 1 -- exactly the mismatch a pill click has to resolve through, not around.
    expect(f.engine.workspaceIndexOn(0, 1)).toBe(2);
    // Output 1 owns only workspace 1, at position 0.
    expect(f.engine.workspaceIndexOn(1, 0)).toBe(1);
    // An output nothing lives on, and a position past the end of a real output's own list, both null.
    expect(f.engine.workspaceIndexOn(99, 0)).toBeNull();
    expect(f.engine.workspaceIndexOn(0, 99)).toBeNull();
  });

  it('workspace number brings an unshown workspace to the focused output', () => {
    const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
    f.engine.start();
    f.engine.run([{type: 'workspace', target: {kind: 'number', number: 5, name: '5'}}], 1);
    expect(f.engine.state().focusedOutput).toBe(0);
    expect(f.tree().outputOf(4)).toBe(0);
    expect(f.tree().visible.get(1)).toBe(1);   // the other output did not move
  });

  it('observes earlier mutations in a compound floating command chain', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.refuseGeometry = true;
    f.applied.length = 0;
    f.engine.run([
      {type: 'floating', action: 'enable'},
      {type: 'resize_set', width: 720, height: 420},
      {type: 'move_position', position: 'center'},
      {type: 'border', style: 'pixel', width: 2},
    ], 1);
    expect(f.engine.windowsSnapshot()[0].state).toBe('floating');
    expect(f.applied.at(-1)?.get(1)).toEqual({x: 140, y: 170, width: 720, height: 420});
    // window 1 is floating at this point (the compound chain enabled it above); border only targets a tiled leaf.
    expect(f.engine.run([{type: 'border', style: 'none', width: 0}], 2)).toBe('border none: no tiled container');
  });

  it('sets a per-window border override, targeting every leaf beneath a container selection', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    f.focus(1);
    f.engine.run([{type: 'border', style: 'pixel', width: 5}], 1);
    expect(f.plan!.borders.find(b => b.window === 1)!.width).toBe(5);
    expect(f.plan!.borders.find(b => b.window === 2)!.width).toBe(2); // untouched, configured default

    f.engine.run([{type: 'focus', target: 'parent'}], 2);
    f.engine.run([{type: 'border', style: 'none', width: 0}], 3);
    expect(f.plan!.borders.every(b => b.width === 0)).toBe(true);
  });

  it('applies a border command against a container selection in exactly one commit', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    f.engine.run([{type: 'focus', target: 'parent'}], 1); // selects the shared root, a 2-leaf container
    f.calls.length = 0;
    const before = f.engine.treeSnapshot().revision;
    f.engine.run([{type: 'border', style: 'pixel', width: 5}], 2);
    expect(f.calls.filter(c => c === 'decorations')).toHaveLength(1);
    expect(f.engine.treeSnapshot().revision).toBe(before + 1);
    expect(f.plan!.borders.every(b => b.width === 5)).toBe(true);
  });

  it('treats "normal" the same as "pixel" (there are no title bars to draw)', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.engine.run([{type: 'border', style: 'normal', width: 7}], 1);
    expect(f.plan!.borders[0].width).toBe(7);
  });

  it('toggles a window border between the configured default width and zero', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    expect(f.plan!.borders[0].width).toBe(2); // configured default, no override yet
    f.engine.run([{type: 'border', style: 'toggle', width: 0}], 1);
    expect(f.plan!.borders[0].width).toBe(0);
    f.engine.run([{type: 'border', style: 'toggle', width: 0}], 2);
    expect(f.plan!.borders[0].width).toBe(2);
  });

  it('forgets a border override when the window is removed, so a reused id starts fresh', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.engine.run([{type: 'border', style: 'pixel', width: 9}], 1);
    expect(f.plan!.borders[0].width).toBe(9);
    f.remove(1); f.flush();
    f.add(1); f.flush();
    expect(f.plan!.borders.find(b => b.window === 1)!.width).toBe(2);
  });

  it('handles empty, wrong and gone selections without native operations or mutation', () => {
    const empty = fakeEngine(); empty.engine.start();
    const beforeEmpty = empty.engine.treeSnapshot().workspaces;
    empty.engine.run([
      {type: 'focus', target: 'left'}, {type: 'move', direction: 'right'},
      {type: 'layout', layout: 'tabbed'},
      {type: 'resize', action: 'grow', dimension: 'width', px: 10, ppt: 10},
      {type: 'kill'},
    ], 1);
    expect(empty.engine.treeSnapshot().workspaces).toEqual(beforeEmpty);
    expect(empty.calls.filter(call => /^(focus|kill|fullscreen|moveTo):/.test(call))).toEqual([]);

    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.focus(999);
    f.calls.length = 0;
    f.engine.run([{type: 'kill'}], 2);
    expect(f.calls).toEqual(['kill:1']);
    f.windows.delete(1);
    f.calls.length = 0; f.applied.length = 0;
    f.engine.run([
      {type: 'resize_set', width: 10, height: 10},
      {type: 'move_position', position: 'center'},
      {type: 'fullscreen', action: 'toggle'},
    ], 3);
    expect(f.calls.filter(call => call.startsWith('fullscreen:'))).toEqual([]);
    expect(f.applied).toEqual([]);
  });

  // Task 13: `focus output <left|right|up|down|primary|name>` -- the first production caller of both
  // `resolveOutputArg` (tree/outputs.ts) and `_warpToFocusedOutput` (Task 12).
  describe('focus output', () => {
    it('moves the focused output and the selection with it', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.mapOn(1, 2);   // output 1's own window
      // Task 23, D7: `mapOn` leaves focus on the output it mapped onto, which is where the user who
      // opened the window would be standing; this test needs them back on output 0 before crossing right.
      expect(f.engine.run([{type: 'focus_output', target: 'left'}], 0)).toBe('focus output');
      f.calls.length = 0;
      expect(f.engine.run([{type: 'focus_output', target: 'right'}], 1)).toBe('focus output');
      expect(f.engine.state().focusedOutput).toBe(1);
      expect(f.calls).toContain('focus:2');
    });

    it('focuses an output whose visible workspace is empty', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      expect(f.engine.run([{type: 'focus_output', target: 'right'}], 1)).toBe('focus output');
      expect(f.engine.state().focusedOutput).toBe(1);
    });

    it('is a no-op off the end and never wraps', () => {
      // Outputs are physical; wrapping between them is never what a user means, and an edge is an
      // ordinary thing to hit -- no warning either.
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      expect(f.engine.run([{type: 'focus_output', target: 'left'}], 1)).toBe('focus output: no such output');
      expect(f.engine.state().focusedOutput).toBe(0);
      expect(f.calls.filter(call => call.startsWith('warn:'))).toEqual([]);
    });

    it('warps the pointer when a command changes output, and not when mouse_warping is none', () => {
      const warped = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      warped.engine.start();
      warped.engine.run([{type: 'focus_output', target: 'right'}], 1);
      expect(warped.pointer.warps().length).toBe(1);

      const still = fakeEngine('mouse_warping none\n', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      still.engine.start();
      still.engine.run([{type: 'focus_output', target: 'right'}], 1);
      expect(still.pointer.warps()).toEqual([]);
    });

    it('does not warp while the launcher holds its grab', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.engine.run([{type: 'launcher', term: null}], 0);
      f.engine.run([{type: 'focus_output', target: 'right'}], 1);
      expect(f.pointer.warps()).toEqual([]);
    });

    it('is unchanged, and does not warp, when the target is already the focused output', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      expect(f.engine.run([{type: 'focus_output', target: 'primary'}], 1)).toBe('focus output: unchanged');
      expect(f.engine.state().focusedOutput).toBe(0);
      expect(f.pointer.warps()).toEqual([]);
    });

    it('resolves a connector name', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {
        monitors: [{id: 0, index: 0, connectors: ['HDMI-1']}, {id: 1, index: 1, connectors: ['DP-1']}],
        primary: 0, workspaceCount: 10,
      });
      f.engine.start();
      expect(f.engine.run([{type: 'focus_output', target: {name: 'DP-1'}}], 1)).toBe('focus output');
      expect(f.engine.state().focusedOutput).toBe(1);
    });
  });

  // Task 14: the directional `focus`/`move` commands cross the output edge instead of wrapping. The
  // config's effective focus_wrapping is `yes` (resolve.ts's default), so a fixture with only one
  // window per output cannot tell "wrapped inside" apart from "crossed over" -- both land on the only
  // other window there is. Every output below therefore carries at least two windows.
  describe('focus and move across the output edge', () => {
    it('focus right crosses to the neighbouring output at its edge rather than wrapping', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.mapOn(0, 1);
      f.mapOn(0, 2);
      f.mapOn(1, 3);
      f.mapOn(1, 4);
      f.focus(2); // rightmost/focused window on output 0, which brings the focused output back to 0
      f.calls.length = 0;

      expect(f.engine.run([{type: 'focus', target: 'right'}], 1)).toBe('focus right');
      expect(f.engine.state().focusedOutput).toBe(1);
      // Entering edge for `right` is output 1's left, its first child -- window 3, not window 4.
      expect(f.calls).toContain('focus:3');
    });

    it('focus right still wraps inside one output when there is no neighbour', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1);
      f.add(2);
      f.focus(1); // leftmost child; moving further left has no sibling and no neighbouring output
      f.calls.length = 0;

      expect(f.engine.run([{type: 'focus', target: 'left'}], 1)).toBe('focus left');
      expect(f.engine.state().focusedOutput).toBe(0);
      // No neighbour exists, so the config's own focus_wrapping (`yes`) wraps to the far child.
      expect(f.calls).toContain('focus:2');
    });

    it('move right at the edge inserts into the neighbouring output at its entering edge', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.mapOn(0, 1);
      f.mapOn(1, 3);
      f.mapOn(1, 4);
      f.focus(1);
      f.calls.length = 0;
      // `mapOn` crosses outputs through the real `focus output`, which warps; the warp this test measures
      // is the one the `move` below makes.
      f.pointer.clear();

      expect(f.engine.run([{type: 'move', direction: 'right'}], 1)).toBe('move right');
      expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: false});
      expect(f.engine.state().focusedOutput).toBe(1);
      // Fix round 1, folded minor 2: `moveIntoOutput` changed `focusedOutput` exactly as
      // `enterOutput`/`focus_output` do, so the pointer follows here too -- pinned, not left to
      // inspection.
      expect(f.pointer.warps().length).toBe(1);
    });

    it('move right is a no-op at the edge when there is no neighbour -- move never wraps', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1);
      f.add(2);
      f.focus(2);
      f.calls.length = 0;

      expect(f.engine.run([{type: 'move', direction: 'right'}], 1)).toBe('move right: no target');
      expect(f.engine.state().focusedOutput).toBe(0);
    });

    // Fix round 1, folded minor 1: the engine path is where the user's actual case lives -- this whole
    // phase exists because an empty display was otherwise unreachable by direction. Only the tree-level
    // `enterOutput` test covered this before.
    it('focus right crosses into an empty neighbouring output', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1, {monitor: 0});
      f.add(2, {monitor: 0});
      f.focus(2);
      f.calls.length = 0;

      expect(f.engine.run([{type: 'focus', target: 'right'}], 1)).toBe('focus right');
      expect(f.engine.state().focusedOutput).toBe(1);
      // Nothing on output 1 to activate, but the crossing itself still happened and the pointer follows.
      expect(f.calls.filter(call => call.startsWith('focus:'))).toEqual([]);
      expect(f.pointer.warps().length).toBe(1);
    });
  });

  // Task 15: `move container to output` is the command this whole phase exists for -- before it, a
  // window stranded on a display nobody was looking at could not be moved by any binding at all.
  describe('move container/workspace to output', () => {
    it('move container to output rescues a window stranded on another screen', () => {
      // The defect this phase exists for: a window on the television with no command able to move it.
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.mapOn(1, 8);
      expect(f.engine.state().focusedOutput).toBe(1);   // `mapOn` already took the user to the television
      expect(f.engine.run([{type: 'move_container_to_output', target: 'left'}], 2)).toBe('move container to output');
      expect(f.tree().location(8)).toEqual({workspace: 0, output: 0, floating: false});
    });

    it('move container to output does not follow the window', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1, {monitor: 0});
      expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1)).toBe('move container to output');
      expect(f.engine.state().focusedOutput).toBe(0);
    });

    // Fix round 1, I1: "does not follow the window" has to mean the keyboard does not follow, not
    // merely that focusedOutput is restored. Two windows on the source output so there is a
    // distinguishable fallback -- window 1 should be activated, never window 2, which just left.
    it('move container to output activates the window left behind, not the one that moved', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1, {monitor: 0});
      f.add(2, {monitor: 0});
      f.focus(2);
      f.calls.length = 0;

      expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1)).toBe('move container to output');
      expect(f.tree().location(2)).toEqual({workspace: 1, output: 1, floating: false});
      expect(f.calls.filter(call => call.startsWith('focus:'))).toEqual(['focus:1']);
    });

    // Fix round 1, folded item 1: the user's actual rescue binding is `move container to output
    // primary`, not a direction -- covered only by the typechecker until now, since both tests above
    // use `left`/`right`. `primary` also exercises the direction=null branch (normal insertion point
    // rather than an entering edge) that neither of those does either.
    it('move container to output accepts a primary target, at the normal insertion point rather than a forced edge', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.mapOn(0, 10);
      f.mapOn(1, 9);
      expect(f.engine.state().focusedOutput).toBe(1);
      expect(f.engine.run([{type: 'move_container_to_output', target: 'primary'}], 2)).toBe('move container to output');
      expect(f.tree().location(9)).toEqual({workspace: 0, output: 0, floating: false});
      // `primary` is not a direction: a direction would reseat window 9 at a forced edge (index 0 for
      // `right`), displacing window 10; the normal insertion point instead leaves window 10 in place.
      expect(windows(f.engine.treeSnapshot().workspaces[0].root)).toEqual([10, 9]);
    });

    // Fix round 1, I2: every other moveToWorkspace call site in the engine (_parkAndShow, _parkOrShow)
    // warns rather than throws on a refused native move; these three call sites now match.
    it('move container to output warns rather than desyncing when the native move is refused', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1, {monitor: 0});
      f.refuseMove(1);
      expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1)).toBe('move container to output');
      expect(f.calls).toContain('warn:could not show window 1; leaving it parked');
    });

    it('move workspace to output warns rather than desyncing when the native move is refused', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1, {monitor: 0});
      f.refuseMove(1);
      expect(f.engine.run([{type: 'move_workspace_to_output', target: 'right'}], 1)).toBe('move workspace to output');
      expect(f.calls).toContain('warn:could not show window 1; leaving it parked');
    });

    // Fix round 2: the ATTIC-bound loop -- parking the windows of the workspace displaced off the
    // target output -- fires on the ordinary case where that output already has windows on it, not an
    // edge case. Distinguished from the LIVE-bound warn above by refusing a window that only the
    // displaced (target-output) workspace owns, never the one arriving.
    it('move workspace to output warns rather than desyncing when parking the displaced workspace is refused', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      // Mapped in this order on purpose: `mapOn` leaves focus where it mapped, and the command below
      // moves the focused output's workspace to the right, so the user has to end on output 0.
      f.mapOn(1, 2);
      f.mapOn(0, 1);
      f.refuseMove(2);
      expect(f.engine.run([{type: 'move_workspace_to_output', target: 'right'}], 1)).toBe('move workspace to output');
      expect(f.calls).toContain('warn:could not park window 2; leaving it on screen');
    });

    it('move workspace to output takes the windows with it and parks nothing', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1, {monitor: 0});
      expect(f.engine.run([{type: 'move_workspace_to_output', target: 'right'}], 1)).toBe('move workspace to output');
      expect(f.tree().outputOf(0)).toBe(1);
      expect(f.windows.get(1)!.workspace).toBe(LIVE_WORKSPACE); // still LIVE: it moved output, not visibility
    });

    // The asymmetry's other direction: unlike the container move above, the workspace you were
    // looking at went with it, so focus follows.
    it('move workspace to output follows the workspace', () => {
      const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      f.add(1, {monitor: 0});
      expect(f.engine.run([{type: 'move_workspace_to_output', target: 'right'}], 1)).toBe('move workspace to output');
      expect(f.engine.state().focusedOutput).toBe(1);
    });
  });
});

/**
 * Task 19, the five live defects found on the user's own desk: a laptop panel (id 2, the primary) plus
 * one external display (id 3), ten workspaces. Every test here uses that topology, because the defects
 * are all about which of the two displays a command or a focus report acts on.
 */
describe('workspace and focus on two displays (Task 19)', () => {
  const desk = {monitors: [{id: 2, index: 0}, {id: 3, index: 1}], primary: 2, workspaceCount: 10};
  const number = (n: number) => ({kind: 'number' as const, number: n, name: String(n)});

  // D1, the tree half: rule 1 of the precedence. A number key must never carry a window to another
  // display -- it takes the user to the window.
  it('takes focus to an occupied workspace’s own display instead of dragging its windows', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);
    f.flush();
    expect(f.tree().location(7)).toEqual({workspace: 1, output: 3, floating: false});
    expect(f.engine.state().focusedOutput).toBe(3);   // `mapOn` left the user on the external
    f.engine.run([{type: 'workspace', target: number(6)}], 2);   // the external looks elsewhere
    expect([...f.tree().visible]).toEqual([[2, 0], [3, 5]]);
    f.engine.run([{type: 'focus_output', target: 'left'}], 3);
    expect(f.engine.state().focusedOutput).toBe(2);

    expect(f.engine.run([{type: 'workspace', target: number(2)}], 4)).toBe('workspace 2');
    expect(f.tree().location(7)).toEqual({workspace: 1, output: 3, floating: false});
    expect([...f.tree().visible]).toEqual([[2, 0], [3, 1]]);
    expect(f.engine.state().focusedOutput).toBe(3);
  });

  // D1, the engine half: the park/show must follow the output `showWorkspace` resolved, not the output
  // the user was standing on. Window 8 sits on the workspace being displaced (on the external) and
  // window 9 on the laptop's own visible workspace, which nothing in this switch touches -- reading the
  // outgoing workspace off the focused output parks 9 (which stays on screen) and leaves 8 on screen
  // (which is now hidden), i.e. exactly the "windows carry over and I cannot type into them" report.
  it('parks and shows on the display the switch actually lands on', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);                                               // workspace 1, on the external
    f.mapOn(2, 9);                                               // workspace 0, on the laptop
    f.flush();
    f.engine.run([{type: 'focus_output', target: 'right'}], 1);
    f.engine.run([{type: 'workspace', target: number(6)}], 2);   // the external shows workspace 5
    f.mapOn(3, 8);                                               // workspace 5, on the external
    f.flush();
    f.engine.run([{type: 'focus_output', target: 'left'}], 3);
    f.calls.length = 0;

    expect(f.engine.run([{type: 'workspace', target: number(2)}], 4)).toBe('workspace 2');
    expect(f.windows.get(7)!.workspace).toBe(LIVE_WORKSPACE);    // came out of the attic
    expect(f.windows.get(8)!.workspace).toBe(1);                 // the displaced workspace was parked
    expect(f.windows.get(9)!.workspace).toBe(LIVE_WORKSPACE);    // the laptop still shows its own
    expect(f.calls.filter(call => call.startsWith('focus:'))).toEqual(['focus:7']);
  });

  // D1/D4 together: a switch that crosses displays has to take the pointer with it, or the very next
  // pointer motion gives the focused output back to the display the user left (see
  // `_warpToFocusedOutput`). A switch that stays on one display must not warp anything.
  it('warps the pointer only when the switch crosses to another display', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);                                               // and the user is on the external
    f.flush();
    f.engine.run([{type: 'workspace', target: number(6)}], 2);
    f.engine.run([{type: 'focus_output', target: 'left'}], 3);
    f.calls.length = 0;

    f.engine.run([{type: 'workspace', target: number(4)}], 4);   // empty, materialises on the laptop
    expect(f.calls.filter(call => call === 'pointer.warp')).toEqual([]);
    f.engine.run([{type: 'workspace', target: number(2)}], 5);   // occupied, lands on the external
    expect(f.calls.filter(call => call === 'pointer.warp')).toEqual(['pointer.warp']);
  });

  // D3: the early return skipped the commit, so `$mod+N` for the workspace you are already on did
  // nothing at all -- and under sloppy focus (i3's default, mapped to GNOME's sloppy mode) that is
  // exactly the key the user reaches for when the pointer has given keyboard focus away.
  it('re-activates the focused workspace’s selection when it is already active', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.add(9, {monitor: 2});
    f.flush();
    f.focus(null);                                               // the compositor's focus wandered off
    f.calls.length = 0;

    expect(f.engine.run([{type: 'workspace', target: number(1)}], 1)).toBe('workspace: already active');
    // 'decorations' trails every commit; nothing else does, so no relayout and no park/show ran.
    expect(f.calls.filter(call => call !== 'decorations')).toEqual(['focus:9']);
  });

  // D5: accepting the compositor's focus for a window has to move the focused output to that window's
  // display. Without it every workspace-scoped command acts on the display the user left, and the one
  // the user actually hit -- `move container to workspace N` -- reports "no focused window" because the
  // stale focused output shows an empty workspace.
  it('follows the compositor’s focus onto the other display', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);
    f.flush();
    f.engine.run([{type: 'focus_output', target: 'left'}], 1);
    expect(f.engine.state().focusedOutput).toBe(2);              // the laptop, showing an empty workspace

    f.focus(7);                                                  // a click on the window, or sloppy focus
    expect(f.engine.state().focusedOutput).toBe(3);
    expect(f.engine.state().activeWorkspace).toBe(1);
    expect(f.engine.run([{type: 'move_to_workspace', target: number(4)}], 2)).toBe('moved to workspace 4');
    expect(f.tree().location(7)?.workspace).toBe(3);
  });

  // D5, the other half of "must remain a valid live output": a parked window's focus report has no
  // output showing it, so there is nothing to move the focused output to and it must stay put.
  //
  // Final review, I1 -- this fixture was rebuilt because a LATER fix emptied it. It used to say
  // `f.add(7, {monitor: 3})`, which before Task 23 (D7) adopted window 7 onto output 3's workspace 1;
  // D7 changed live adoption to the FOCUSED output's visible workspace, so window 7 began landing on
  // workspace 0 -- which the laptop *is* showing. `showing` then equalled `focusedOutput` and the
  // correct and the wrong answers coincided, leaving the guard unprotected against
  // `focusedOutput = showing ?? storedOutput`. `mapOn` is the replacement for `{monitor: N}`: it takes
  // the user to the output first, so the window really does join that output's own workspace. Two
  // windows, because the selection moving from 8 to 7 is what proves the focus report reached
  // `_selectWindow` at all rather than being swallowed by `_acceptFocus`'s expected/duplicate guards --
  // without that, "focused output unchanged" would also pass if nothing ran.
  it('leaves the focused output alone for a focus report from a workspace nothing is showing', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);                                               // workspace 1, on the external
    f.mapOn(3, 8);                                               // its neighbour, and the selection
    f.flush();
    expect(f.tree().location(7)).toEqual({workspace: 1, output: 3, floating: false});
    expect(f.tree().selection(1)).not.toEqual({kind: 'tiled', con: f.tree().find(7)});

    f.engine.run([{type: 'workspace', target: number(6)}], 2);   // workspace 1 is parked now
    expect(f.tree().outputShowing(1)).toBeNull();                // the precondition the name claims
    expect(f.tree().outputOf(1)).toBe(3);                        // ... and it is NOT the focused output
    f.engine.run([{type: 'focus_output', target: 'left'}], 3);
    expect(f.engine.state().focusedOutput).toBe(2);

    f.focus(7);
    expect(f.tree().selection(1)).toEqual({kind: 'tiled', con: f.tree().find(7)});
    expect(f.engine.state().focusedOutput).toBe(2);
    expect(f.engine.state().activeWorkspace).toBe(0);
  });

  // D8, the live defect, in the arrival order the compositor produces it: switching the focused output
  // to an EMPTY workspace handed the focused output to the OTHER display, so `$mod+d` opened the
  // launcher on the monitor the user had just looked away from. Nothing here is hand-rolled -- parking
  // the outgoing workspace's focused window makes the compositor pick a replacement on its own (the
  // fake emits it from `moveToWorkspace`, as Mutter does), and the only window left on screen is on the
  // other display, because the incoming workspace is empty and so has nothing of its own to pick. D5
  // then read that involuntary pick as the user having moved there.
  it('keeps the focused output on the display that just switched to an empty workspace', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);                                               // the application still visible on the external
    f.mapOn(2, 9);                                               // the laptop's own window
    f.flush();
    // Mutter focuses a window it has just mapped; the engine never asks for that, so without this the
    // fake holds no native focus at all, nothing is focused to park, and the replacement pick this test
    // is about never happens -- the defect would be invisible here.
    f.focus(9);
    expect(f.engine.state().focusedOutput).toBe(2);
    expect([...f.tree().visible]).toEqual([[2, 0], [3, 1]]);

    expect(f.engine.run([{type: 'workspace', target: number(6)}], 1)).toBe('workspace 6');
    expect([...f.tree().visible]).toEqual([[2, 5], [3, 1]]);
    expect(f.tree().occupied(5)).toBe(false);                    // the precondition the name claims
    expect(f.windows.get(9)!.workspace).not.toBe(LIVE_WORKSPACE); // ... and 9 really was parked
    expect(f.engine.state().focusedOutput).toBe(2);
    expect(f.engine.state().activeWorkspace).toBe(5);
    // What the user actually saw, and the only part of this they could see: `$mod+d`.
    expect(f.engine.launcherAreaForTest()).toEqual(f.topology!.workAreas.get(2));
  });

  // D8, the other arrival order, and the reason the suppression cannot be scoped to the commit that
  // changed the visibility: Mutter hides a window it has moved off the active workspace from a
  // `calc_showing` later, and reassigns the focus from there, so the replacement pick can reach the
  // engine a main-loop turn after the `moveToWorkspace` call that caused it. Two windows on the
  // external, so the report names a window that is not `_lastFocus`: with one, `_acceptFocus`'s
  // duplicate guard swallows it and this test would pass with the defect still in place.
  it('ignores the compositor’s replacement pick when it arrives in a later commit', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);
    f.mapOn(3, 8);                                               // the selection, and the keyboard
    f.flush();
    f.engine.run([{type: 'focus_output', target: 'left'}], 1);
    expect(f.engine.state().focusedOutput).toBe(2);

    expect(f.engine.run([{type: 'workspace', target: number(6)}], 2)).toBe('workspace 6');
    expect([...f.tree().visible]).toEqual([[2, 5], [3, 1]]);
    expect(f.tree().outputShowing(1)).toBe(3);                   // NOT the parked-window guard's case

    f.focus(7);
    expect(f.tree().selection(1)).toEqual({kind: 'tiled', con: f.tree().find(7)});  // it did reach _selectWindow
    expect(f.engine.state().focusedOutput).toBe(2);
    expect(f.engine.state().activeWorkspace).toBe(5);
    expect(f.engine.launcherAreaForTest()).toEqual(f.topology!.workAreas.get(2));
  });

  // D8, round 2, and the reason a one-shot token was too weak: the compositor does not send ONE focus
  // notification for one involuntary pick. Mutter focuses its replacement, unsets the input focus while
  // it hides the window being parked, and focuses the replacement again. A suppression spent by the
  // first report is already gone when the third arrives, which is what the native suite measured
  // against 390f7a1 -- the primary showing the empty workspace and `focusedOutput` on the other display
  // all the same. The first report here is still the fake's own replacement pick, not a hand-rolled
  // one; only the two Mutter adds while hiding are written out.
  it('ignores every report of one involuntary pick, not only the first', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);
    f.mapOn(2, 9);
    f.flush();
    f.focus(9);
    f.engine.run([{type: 'workspace', target: number(6)}], 1);
    expect([...f.tree().visible]).toEqual([[2, 5], [3, 1]]);
    expect(f.engine.state().focusedOutput).toBe(2);               // the replacement pick, suppressed

    f.focus(null);                                                // Mutter unsets the input focus...
    expect(f.engine.state().focusedOutput).toBe(2);
    f.focus(7);                                                   // ... and focuses its pick again
    expect(f.tree().selection(1)).toEqual({kind: 'tiled', con: f.tree().find(7)});
    expect(f.engine.state().focusedOutput).toBe(2);
    expect(f.engine.state().activeWorkspace).toBe(5);
    expect(f.engine.launcherAreaForTest()).toEqual(f.topology!.workAreas.get(2));
  });

  // What ends the suppression instead of a report count: its own premise. It holds only while that
  // output still has nothing to focus, so a window opening on the newly shown workspace ends it -- the
  // compositor has a choice there now, and the next focus report is informative again. This is the
  // legitimate case that a durable suppression must not swallow.
  it('stops suppressing once the newly shown workspace has a window of its own', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);
    f.mapOn(3, 8);
    f.flush();
    f.engine.run([{type: 'focus_output', target: 'left'}], 1);
    f.engine.run([{type: 'workspace', target: number(6)}], 2);    // the laptop shows empty workspace 5
    expect(f.engine.state().focusedOutput).toBe(2);
    f.focus(7);                                                   // the involuntary pick, suppressed
    expect(f.engine.state().focusedOutput).toBe(2);

    f.add(10, {monitor: 2});                                      // a window opens on workspace 5
    f.flush();
    expect(f.tree().location(10)?.workspace).toBe(5);
    expect(f.tree().occupied(5)).toBe(true);

    f.focus(8);                                                   // and then a click on the external
    expect(f.engine.state().focusedOutput).toBe(3);
    expect(f.engine.state().activeWorkspace).toBe(1);
  });

  // Overruled once, overruled for good: a failed clause clears the record instead of merely answering
  // false, so coming back to the display showing that empty workspace does not resurrect a suppression
  // the user has already walked past. Without the clear, the second report below is swallowed and the
  // focused output sticks to a display the user has twice told it to leave.
  it('does not resurrect the suppression when the user comes back to that display', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(3, 7);
    f.mapOn(3, 8);
    f.flush();
    f.engine.run([{type: 'focus_output', target: 'left'}], 1);
    f.engine.run([{type: 'workspace', target: number(6)}], 2);    // the laptop shows empty workspace 5
    expect(f.engine.state().focusedOutput).toBe(2);

    f.engine.run([{type: 'focus_output', target: 'right'}], 3);   // the user crosses to the external
    f.focus(7);                                                   // and a report arrives while there
    expect(f.engine.state().focusedOutput).toBe(3);
    f.engine.run([{type: 'focus_output', target: 'left'}], 4);    // ... then back to the empty workspace
    expect(f.engine.state().focusedOutput).toBe(2);

    f.focus(8);                                                   // a click on the external, not a pick
    expect(f.engine.state().focusedOutput).toBe(3);
    expect(f.engine.state().activeWorkspace).toBe(1);
  });

  // D8's suppression records the output it was armed for, not a bare flag, and that is what makes it
  // lapse rather than linger: once the user has moved the focused output themselves the next focus
  // report is theirs again, even though the involuntary one the suppression was armed for never came. A
  // flag would swallow that report -- and would also swallow the parked-window report the test above
  // this one exists for, leaving that guard pinned by nothing at all.
  //
  // Three displays, because two cannot tell the two answers apart: an armed output shows an empty
  // workspace (that is what arms it), so it has no window of its own to report, and with only one other
  // display the user's own crossing has already taken the focused output to wherever the reported window
  // is -- the correct and the wrong answers would coincide.
  it('stops suppressing as soon as the user moves the focused output themselves', () => {
    const f = fakeEngine(referenceText, {monitors: [{id: 2, index: 0}, {id: 3, index: 1}, {id: 4, index: 2}], primary: 2, workspaceCount: 10});
    f.engine.start();
    f.mapOn(4, 7);                                               // two windows on the third display's
    f.mapOn(4, 8);                                               // own workspace 2
    f.flush();
    f.focus(8);                                                  // ... and the keyboard is on 8, not 7
    expect([...f.tree().visible]).toEqual([[2, 0], [3, 1], [4, 2]]);

    f.engine.run([{type: 'focus_output', target: {name: 'fixture-2'}}], 1);
    f.engine.run([{type: 'workspace', target: number(6)}], 2);   // output 2 shows empty workspace 5
    expect(f.engine.state().focusedOutput).toBe(2);              // armed for output 2
    f.engine.run([{type: 'focus_output', target: {name: 'fixture-3'}}], 3);
    expect(f.engine.state().focusedOutput).toBe(3);              // ... and the user has left it again

    f.focus(7);                                                  // a click on the third display
    expect(f.tree().selection(2)).toEqual({kind: 'tiled', con: f.tree().find(7)});
    expect(f.engine.state().focusedOutput).toBe(4);
    expect(f.engine.state().activeWorkspace).toBe(2);
  });

  // The other half of "cannot suppress the legitimate click": a switch the engine took the keyboard for
  // suppresses nothing at all. The incoming workspace is occupied, so `_activateSelection` really
  // activates, and the focus report that follows is the engine's own -- there is no involuntary pick
  // outstanding, and the user's next click on the other display must move the focused output as always.
  it('suppresses nothing when the switch took the keyboard for itself', () => {
    const f = fakeEngine(referenceText, desk);
    f.engine.start();
    f.mapOn(2, 9);                                               // the laptop's own window, workspace 0
    f.mapOn(3, 7);                                               // the external's, workspace 1
    f.flush();
    f.engine.run([{type: 'workspace', target: number(6)}], 1);   // the external parks workspace 1
    expect(f.tree().outputShowing(1)).toBeNull();
    f.engine.run([{type: 'focus_output', target: 'left'}], 2);
    expect(f.engine.state().focusedOutput).toBe(2);

    // Occupied, so D1 rule 1 shows it on its own display again -- and this time there is a window there
    // to activate, so the engine owns the keyboard.
    expect(f.engine.run([{type: 'workspace', target: number(2)}], 3)).toBe('workspace 2');
    expect(f.engine.state().focusedOutput).toBe(3);
    expect(f.calls.filter(call => call === 'focus:7').length).toBe(1);

    f.focus(9);                                                  // the user clicks back on the laptop
    expect(f.engine.state().focusedOutput).toBe(2);
    expect(f.engine.state().activeWorkspace).toBe(0);
  });
});

/**
 * `Engine.onSwipe` is to `bindgesture` what `onBinding` is to `bindsym`: the one entry point a gesture
 * source pushes into, resolving the bound command text and running it. The direction convention -- left
 * for `workspace next`, right for `workspace prev`, matching GNOME's content-follows-fingers feel -- is
 * expressed in the config these fixtures load, never in the engine, so inverting it is a config edit.
 */
describe('onSwipe', () => {
  const GESTURES = 'bindgesture swipe:left workspace next\nbindgesture swipe:right workspace prev\n';

  /** Occupies workspaces 0, 1 and 2 with one window each and leaves the engine on workspace 0. */
  function threeOccupied(text: string): ReturnType<typeof fakeEngine> {
    const f = fakeEngine(text, {workspaceCount: 10});
    f.engine.start();
    let id = 1;
    for (const index of [0, 1, 2]) {
      f.engine.run([{type: 'workspace', target: {kind: 'number', number: index + 1, name: String(index + 1)}}], 0);
      f.add(id++);
      f.flush();
    }
    f.engine.run([{type: 'workspace', target: {kind: 'number', number: 1, name: '1'}}], 0);
    return f;
  }

  it('runs the command bound to a left swipe', () => {
    const f = threeOccupied(GESTURES);
    f.engine.onSwipe('left', 7);
    expect(f.engine.state().activeWorkspace).toBe(1);
  });

  it('runs the command bound to a right swipe, which wraps the other way', () => {
    const f = threeOccupied(GESTURES);
    f.engine.onSwipe('right', 7);
    // `workspace prev` from the lowest member of the cycle: round to the highest, i3's own wrap.
    expect(f.engine.state().activeWorkspace).toBe(2);
  });

  it('does nothing, and says nothing, when the gesture is unbound', () => {
    // An unbound gesture is not an error -- the user who never wrote a `bindgesture` line still swipes.
    const f = threeOccupied('bindsym Mod4+q kill\n');
    f.calls.length = 0;
    f.engine.onSwipe('left', 7);
    expect(f.engine.state().activeWorkspace).toBe(0);
    expect(f.calls).toEqual([]);
  });

  it('warns with the config line number when the bound command does not parse', () => {
    const f = threeOccupied('bindgesture swipe:left wobble\n');
    f.calls.length = 0;
    f.engine.onSwipe('left', 7);
    expect(f.calls).toContain("warn:config line 1: unknown command 'wobble'");
    expect(f.engine.state().activeWorkspace).toBe(0);
  });

  it('ignores a swipe while the session is locked', () => {
    // Unlike a binding, a gesture has no grab to drop: `onLocked` ungrabs every accelerator, so
    // `onBinding` cannot fire over a lock screen, while the stage subscription a swipe arrives on stays
    // live. Without this guard the lock screen would be the one place gestures still ran commands.
    const f = threeOccupied(GESTURES);
    f.engine.onLocked();
    f.engine.onSwipe('left', 7);
    expect(f.engine.state().activeWorkspace).toBe(0);
  });
});

// Task 1: the mirror image of D6. D6 is "the frame moved, follow it with the tree"; this is "the tree
// moved, follow it with the frame". The defect the Phase 5 ledger carried: a commanded move re-homes a
// floating window and emits no rect at all, so it stays drawn on the display it left and then appears
// to vanish when that display switches away from the workspace it now belongs to. Measured port calls
// at the failure: ["moveTo:1:0","decorations","decorations"].
describe('a floating window moved by command follows the tree with its frame', () => {
  // THREE outputs, all of DIFFERENT SIZE, for both reasons this project has learned the hard way:
  // - different sizes, so a proportional translation and a plain origin offset differ;
  // - three of them, so "translate into the focused output" and "translate into the output showing the
  //   destination workspace" are different answers. With two outputs they coincide, which is how three
  //   earlier tests in this repo passed while testing nothing.
  const WIDE = {x: 0, y: 0, width: 1920, height: 1080};
  const NARROW = {x: 1920, y: 0, width: 1280, height: 720};
  const TALL = {x: 3200, y: 0, width: 1024, height: 1280};
  const threeOutputs = (text = 'bindsym Mod4+q kill') => fakeEngine(text, {
    monitors: [{id: 0, index: 0, area: WIDE}, {id: 1, index: 1, area: NARROW}, {id: 2, index: 2, area: TALL}],
    primary: 0,
    workspaceCount: 10,
  });
  // Centre at x = 1440 (75% of WIDE) and y = 540 (50% of WIDE).
  const floatingOnWide = {kind: 'floating' as const, rect: {x: 1340, y: 490, width: 200, height: 100}};

  it('move container to output carries the frame onto the destination display', () => {
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.applied.length = 0;

    expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1))
      .toBe('move container to output');
    expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});
    // 75% of 1280 is 960; + NARROW.x (1920) - half the width (100) = 2780. y: 50% of 720 - 50 = 310.
    expect(f.appliedRects().get(1)).toEqual({x: 2780, y: 310, width: 200, height: 100});
  });

  it('move container to workspace uses the output showing that workspace, not the focused one', () => {
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.applied.length = 0;

    // Workspace 3 (index 2) is the one output 2 is showing, and the user is standing on output 0.
    expect(f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 3, name: '3'}}], 1))
      .toBe('moved to workspace 3');
    expect(f.tree().location(1)).toEqual({workspace: 2, output: 2, floating: true});
    // 75% of 1024 is 768; + TALL.x (3200) - 100 = 3868. y: 50% of 1280 - 50 = 590.
    expect(f.appliedRects().get(1)).toEqual({x: 3868, y: 590, width: 200, height: 100});
  });

  it('writes nothing while the window sits on a workspace no output is showing, and catches up when it is shown', () => {
    // Workspace 6 is PINNED to output 1 by the config, and output 1 is showing workspace 2. So after the
    // move the window's workspace belongs to an output other than the one its frame is on and is on no
    // output's screen -- the two halves this test needs at once. Without the pin every spare workspace is
    // homed on output 0 (`workspacesOn(0)` is [0,3,4,5,6,7,8,9] in this fixture), the parked workspace
    // would come back on the very output the frame is already on, and the first half would hold for the
    // wrong reason: nothing to translate rather than a parked window left alone.
    const f = threeOutputs('bindsym Mod4+q kill\nworkspace 6 output fixture-1\n');
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.applied.length = 0;

    // Workspace 6 (index 5) is on no output's screen: the window is parked, and a parked frame is
    // unobservable, so there is nothing to translate it against.
    expect(f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 6, name: '6'}}], 1))
      .toBe('moved to workspace 6');
    expect(f.tree().location(1)).toEqual({workspace: 5, output: 1, floating: true});
    expect([...f.tree().visible]).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(f.appliedRects().get(1)).toBeUndefined();

    // Now show workspace 6, which brings it up on output 1 where it lives. The frame is still on output
    // 0, so this is the moment it has an answer -- and a commanded move that parked the window must not
    // lose the follow-up.
    expect(f.engine.run([{type: 'workspace', target: {kind: 'number', number: 6, name: '6'}}], 2))
      .toBe('workspace 6');
    expect([...f.tree().visible]).toEqual([[0, 0], [1, 5], [2, 2]]);
    expect(f.appliedRects().get(1)).toEqual({x: 2780, y: 310, width: 200, height: 100});
  });

  it('writes no frame for a fullscreen floating window', () => {
    // Review Focus 5. Mutter owns a fullscreen window's frame; a rect written at it fights the
    // compositor and can leave the window the size of the output it came from.
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, {...floatingOnWide, fullscreen: true});
    f.flush();
    f.applied.length = 0;

    expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1))
      .toBe('move container to output');
    expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});
    expect(f.appliedRects().get(1)).toBeUndefined();
  });

  it('writes no frame for a tiled window, which the layout pass owns', () => {
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1);
    f.flush();
    f.applied.length = 0;

    expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1))
      .toBe('move container to output');
    // The layout pass gives it the whole of NARROW; the follow pass must not also have queued one.
    expect(f.appliedRects().get(1)).toEqual({x: 1920, y: 0, width: 1280, height: 720});
  });

  it('translates the frame as the command line left it, so a centred window lands centred on the destination', () => {
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.applied.length = 0;

    // Two commands in one run(): `move position center` centres the window on output 0, and the move
    // then re-homes it. The follow pass has to translate the frame as THAT command left it -- the centre
    // of output 0 -- so the window ends up centred on the output it moved to, and not merely somewhere
    // proportional to where it started. This order and not the reverse: `move position` reads the
    // *selection* of the focused output's workspace, and once the move has carried the window to output
    // 1's workspace the user is no longer standing on it, so the reverse order makes `move position`
    // refuse with "move position applies only to a tracked floating window" and tests nothing.
    f.engine.run([
      {type: 'move_position', position: 'center'},
      {type: 'move_container_to_output', target: 'right'},
    ], 1);
    const rect = f.appliedRects().get(1)!;
    expect(rect.x + rect.width / 2).toBe(NARROW.x + NARROW.width / 2);
    expect(rect.y + rect.height / 2).toBe(NARROW.y + NARROW.height / 2);
  });

  it('leaves a dragged window alone: D6 moves the tree to the frame and the two then agree', () => {
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.applied.length = 0;

    // The drag: Mutter reports the window on output 1 with the frame STRADDLING the boundary -- most of
    // it over NARROW, which is why the compositor has handed it to output 1, but its top-left corner
    // still over WIDE. D6 re-homes it; this pass must then write nothing, or it would yank the window
    // out from under the pointer. The straddle is the point: a frame wholly inside NARROW would be left
    // alone by the already-in-the-destination guard whether the monitor guard existed or not, so the
    // test could not tell the two apart. Here only the monitor guard keeps the pass quiet -- without it
    // the clamp would snap the corner to NARROW's left edge mid-drag.
    f.change(1, {monitor: 1, rect: {x: 1850, y: 100, width: 200, height: 100}}, 'frame');
    f.flush();

    expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});
    expect(f.appliedRects().get(1)).toBeUndefined();
  });

  it('writes nothing, and does not throw, while Mutter names a monitor the topology no longer has', () => {
    // Mid-unplug the compositor can report a window on a monitor index that has already gone from the
    // topology, and there is then no source work area to scale the frame against. Without the guard this
    // divided a rect by `undefined` and threw out of the commit, taking the whole relayout with it.
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.applied.length = 0;

    // The window reaches output 1 by a DRAG, so D6 re-homes the tree and this pass has carried nothing --
    // and only then does the compositor name a monitor that is gone. Both halves are needed to reach the
    // source lookup at all: a window this pass had carried to output 1 would be held by its carry record
    // one line earlier (and in fix round 1, with the geometric guard, a frame already inside the
    // destination stopped it one line earlier still -- which is how the first draft of this test passed
    // whether the guard was there or not).
    f.change(1, {monitor: 1, rect: {x: 2000, y: 100, width: 200, height: 100}}, 'frame');
    f.flush();
    expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});
    f.applied.length = 0;

    f.change(1, {monitor: 99}, 'frame');
    f.flush();
    expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});
    expect(f.appliedRects().get(1)).toBeUndefined();
  });

  it('translates once, and not again on each commit that follows while Mutter still reports the old monitor', () => {
    // The pass is level-triggered and runs on every commit, while the compositor may not report the
    // window's new monitor until a later one -- the engine's own geometry write raises a signal it commits
    // on, and this fake never updates `monitor` at all. Without the carry record the second pass
    // re-translated the frame it had just moved and the clamp pinned it at x=3000 instead of 2780, so the
    // window crept into the destination's far corner by itself.
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.applied.length = 0;

    f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1);
    f.flush();
    expect(f.applied.map(rects => [...rects])).toEqual([[[1, {x: 2780, y: 310, width: 200, height: 100}]]]);

    // Another commit, with Mutter still naming output 0 as the window's monitor.
    f.applied.length = 0;
    f.change(1, {}, 'frame');
    f.flush();
    expect(f.windows.get(1)!.monitor).toBe(0);
    expect(f.appliedRects().get(1)).toBeUndefined();
  });

  it('carries a frame that straddles the boundary with its corner already over the destination', () => {
    // Fix round 1, I1. The window the user has just dragged to the seam: 400 wide at x=1900, so 20px over
    // WIDE and 380 over NARROW, which is why the compositor hands it to output 1 and D6 re-homes the tree
    // there. Its top-left corner is now over NARROW while the window is NOT the one this pass carried, so
    // a guard keyed on GEOMETRY mistook it for a frame already carried and wrote nothing at all on the
    // move below -- the original defect, in the one geometry a 1728-wide panel beside a 1920-wide display
    // makes routine. Keyed on "already carried" there is no such false negative.
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.change(1, {monitor: 1, rect: {x: 1900, y: 100, width: 400, height: 200}}, 'frame');
    f.flush();
    expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});
    f.applied.length = 0;

    expect(f.engine.run([{type: 'move_container_to_output', target: 'left'}], 1))
      .toBe('move container to output');
    expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: true});
    // Centre x = 2100, which is 14.0625% across NARROW; the same fraction of WIDE is 270, less half the
    // width = 70. Centre y = 200, 27.7...% of 720; the same fraction of 1080 is 300, less 100 = 200.
    expect(f.appliedRects().get(1)).toEqual({x: 70, y: 200, width: 400, height: 200});
  });

  it('drops the carry record once the compositor confirms it, so a later move across carries again', () => {
    // The walk: command the window across (carried, record held), the compositor catches up, the user
    // drags it back by hand (D6 moves the tree, nothing carried), then commands it across again. If the
    // record were never dropped it would still name output 1 and would suppress that second carry, and the
    // window would stay drawn on the display it was told to leave -- the original defect, once per window.
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1);
    expect(f.appliedRects().get(1)).toEqual({x: 2780, y: 310, width: 200, height: 100});

    // The compositor confirms the carry: the record has done its work.
    f.change(1, {monitor: 1, rect: {x: 2780, y: 310, width: 200, height: 100}}, 'frame');
    f.flush();
    // Dragged back to output 0 by hand. D6 re-homes the tree; this pass carries nothing.
    f.change(1, {monitor: 0, rect: {x: 1340, y: 490, width: 200, height: 100}}, 'frame');
    f.flush();
    expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: true});
    // The hand that dragged it also focused it; the first command left the selection behind on output 0's
    // workspace, so without this the command below has nothing to act on ("nothing moved").
    f.focus(1);
    f.flush();
    f.applied.length = 0;

    expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 2))
      .toBe('move container to output');
    expect(f.appliedRects().get(1)).toEqual({x: 2780, y: 310, width: 200, height: 100});
  });

  it('carries again once the compositor reports the frame anywhere other than where it started', () => {
    // Fix round 2, I5. A client that refuses the frame -- the `stubborn` clients the README names -- never
    // lets the carry land, so the compositor never reports the output the frame was carried TO. The record
    // must still end, or it suppresses the next genuine carry back to that output forever: the original
    // defect, for that window, with no catch-up. It ends on the first report of ANY monitor other than the
    // one the frame was carried FROM, because that report already proves the frame is no longer where the
    // carry started -- which is the whole of the uncertainty the record exists to cover.
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();

    // The carry is attempted and refused: a rect is written, the frame does not move, monitor stays 0.
    f.refuseGeometry = true;
    f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1);
    f.refuseGeometry = false;
    expect(f.windows.get(1)!.rect).toEqual({x: 1340, y: 490, width: 200, height: 100});

    // The user drags it to output 2 by hand. D6 re-homes the tree; the record still names output 1.
    f.change(1, {monitor: 2, rect: {x: 3300, y: 100, width: 200, height: 100}}, 'frame');
    f.focus(1);
    f.flush();
    expect(f.tree().location(1)).toEqual({workspace: 2, output: 2, floating: true});
    f.applied.length = 0;

    // And commands it back to output 1 -- the output the stale record names.
    expect(f.engine.run([{type: 'move_container_to_output', target: 'left'}], 2))
      .toBe('move container to output');
    expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});
    // Centre (3400, 150) is 19.53125% and 11.71875% across TALL; the same fractions of NARROW are 250 and
    // 84.375, less half the width and height = 2070 and 34.
    expect(f.appliedRects().get(1)).toEqual({x: 2070, y: 34, width: 200, height: 100});
  });

  it('does not let a carry record outlive the window it was kept for', () => {
    // The record suppresses a second carry to the same output while the compositor has not confirmed the
    // first. If `_forget` did not drop it, the next window to be given this id would inherit the
    // suppression and get no frame at all -- the defect again, for one window, with no way to recover.
    const f = threeOutputs();
    f.engine.start();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1);
    expect(f.appliedRects().get(1)).toEqual({x: 2780, y: 310, width: 200, height: 100});

    f.remove(1);
    f.flush();
    f.mapOn(0, 1, floatingOnWide);
    f.flush();
    f.applied.length = 0;

    expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 2))
      .toBe('move container to output');
    expect(f.appliedRects().get(1)).toEqual({x: 2780, y: 310, width: 200, height: 100});
  });
});
