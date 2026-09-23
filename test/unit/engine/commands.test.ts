import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {Binding, Config} from '../../../src/config/model';
import type {NodeSnapshot} from '../../../src/runtime/snapshot';
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
    const sourceBefore = f.engine.treeSnapshot().workspaces[0].monitors[0].root;
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
    expect(windows(snapshot.workspaces[0].monitors[0].root)).toEqual([1]);
    expect(snapshot.workspaces[0].selected).toMatchObject({kind: 'tiled'});
    const destination = snapshot.workspaces[1].monitors[0].root;
    expect(windows(destination)).toEqual([2, 3]);
    expect(destination.kind === 'split' && destination.children[0]).toMatchObject({
      kind: 'split', layout: 'splitv', children: [{window: 2}, {window: 3}],
    });

    f.change(2, {workspace: 1}, 'workspace');
    f.change(3, {workspace: 1}, 'workspace');
    expect(windows(f.engine.treeSnapshot().workspaces[1].monitors[0].root)).toEqual([2, 3]);
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
    expect(snapshot.workspaces[0].monitors[0].root).toMatchObject({children: []});
    expect(snapshot.workspaces[1].monitors[0].root).toMatchObject({
      children: [{kind: 'split', layout: 'splith', children: [{window: 1}, {window: 2}]}],
    });
    f.change(1, {workspace: 1}, 'workspace');
    f.change(2, {workspace: 1}, 'workspace');
    expect(windows(f.engine.treeSnapshot().workspaces[1].monitors[0].root)).toEqual([1, 2]);
  });

  it('dispatches split, focus, move and ten-ppt resize through reference bindings', () => {
    const split = fakeEngine(referenceText);
    split.engine.start(); split.add(1); split.add(2); split.flush();
    split.engine.onBinding(binding(split.engine.config, 'default', '<Super>v'), 1);
    split.add(3); split.flush();
    let root = split.engine.treeSnapshot().workspaces[0].monitors[0].root;
    expect(root).toMatchObject({children: [{window: 1}, {layout: 'splitv', children: [{window: 2}, {window: 3}]}]});

    split.engine.onBinding(binding(split.engine.config, 'default', '<Super>l'), 2);
    expect(split.calls).toContain('focus:2');
    split.engine.onBinding(binding(split.engine.config, 'default', '<Super><Shift>k'), 3);
    root = split.engine.treeSnapshot().workspaces[0].monitors[0].root;
    expect(root).toMatchObject({children: [{window: 1}, {layout: 'splitv', children: [{window: 3}, {window: 2}]}]});

    split.engine.onBinding(binding(split.engine.config, 'default', '<Super>r'), 4);
    split.engine.onBinding(binding(split.engine.config, 'resize', 'semicolon'), 5);
    root = split.engine.treeSnapshot().workspaces[0].monitors[0].root;
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
    expect(f.engine.treeSnapshot().workspaces[0].monitors[0].root).toMatchObject({
      children: [{layout: 'tabbed', children: [{window: 1}, {window: 2}]}],
    });
    expect(f.calls.filter(call => call.startsWith('raise:'))).toEqual(['raise:1', 'raise:2']);

    f.calls.length = 0;
    f.engine.run([{type: 'focus', target: 'left'}, {type: 'layout', layout: 'stacked'}], 2);
    expect(f.calls.filter(call => call.startsWith('raise:')).at(-2)).toBe('raise:2');
    expect(f.calls.filter(call => call.startsWith('raise:')).at(-1)).toBe('raise:1');
    f.engine.run([{type: 'layout_toggle', cycle: 'split'}], 3);
    expect(f.engine.treeSnapshot().workspaces[0].monitors[0].root).toMatchObject({
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
    expect(before[0].monitors[0].root).toMatchObject({
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
    expect(windows(rebuilt[0].monitors[0].root)).toEqual([1, 2, 3]);
  });

  it('resolves numeric strings and workspace names before moving the selection', () => {
    const f = fakeEngine(referenceText); f.engine.start(); f.add(1); f.flush();
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'name', name: '2:II'}}], 1);
    expect(f.calls).toContain('moveTo:1:1');
    f.ports.workspaces.activate(1, 2);
    f.focus(1);
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'name', name: '3'}}], 3);
    expect(f.calls).toContain('moveTo:1:2');
  });

  it('reports failed workspace activation and does not wrap at workspace zero', () => {
    const f = fakeEngine(); f.engine.start();
    f.ports.workspaces.activate = () => false;
    expect(f.engine.run([{type: 'workspace', target: {kind: 'number', number: 2, name: '2'}}], 1))
      .toBe('workspace: activation failed');
    expect(f.engine.treeSnapshot().activeWorkspace).toBe(0);
    expect(f.engine.run([{type: 'workspace', target: {kind: 'prev'}}], 2)).toBe('workspace: no such workspace');
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
});
