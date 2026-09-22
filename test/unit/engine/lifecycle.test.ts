import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fakeEngine, topology, windowInfo} from './fakeEngine';

const referenceText = readFileSync(new URL('../fixtures/reference.i3config', import.meta.url), 'utf8');

describe('engine lifecycle', () => {
  it('adopts first-frame windows and retiles after removal during apply', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    expect(f.engine.windowsSnapshot()[0].expectedRect).toEqual({x: 0, y: 30, width: 500, height: 700});
    f.onApply = id => { if (id === 1) f.remove(2); };
    f.change(1, {rect: {x: 99, y: 99, width: 400, height: 400}}, 'frame'); f.flush();
    expect(f.engine.windowsSnapshot().map(w => w.id)).toEqual([1]);
    expect(f.engine.windowsSnapshot()[0].expectedRect).toEqual({x: 0, y: 30, width: 1000, height: 700});
  });
  it('adopts per-workspace MRU and restores most recent selection', () => {
    const f = fakeEngine(); f.windows.set(1, windowInfo(1)); f.windows.set(2, windowInfo(2));
    f.engine.start(); f.flush();
    f.engine.run([{type: 'kill'}], 1); expect(f.calls).toContain('kill:1');
    f.add(3, {workspace: 4}); expect(f.engine.treeSnapshot().activeWorkspace).toBe(0);
  });
  it.each(['fullscreen', 'minimized', 'maximized'] as const)('reapplies an unchanged tile after %s exit', event => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    const before = f.engine.windowsSnapshot()[0].generation!;
    f.change(1, event === 'fullscreen' ? {fullscreen: true} : event === 'minimized' ? {minimized: true} : {maximizedH: true, maximizedV: true}, event); f.flush();
    if (event === 'minimized') expect(f.pills[0].occupied).toBe(true);
    if (event === 'maximized') {
      f.change(1, {maximizedH: false}, event); f.flush();
      expect(f.calls.filter(c => c === 'unmaximize:1')).toHaveLength(1);
      expect(f.engine.windowsSnapshot()[0].generation).toBe(before);
    }
    f.applied.length = 0;
    f.change(1, {fullscreen: false, minimized: false, maximizedH: false, maximizedV: false}, event); f.flush();
    expect(f.applied.some(batch => batch.has(1))).toBe(true);
    expect(f.engine.windowsSnapshot()[0].generation).toBe(before + 1);
  });
  it('retains pending monitor invalidation across unavailable topology', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush(); f.applied.length = 0;
    f.setTopology(null); f.engine.onMonitorsChanged(); expect(f.engine.treeSnapshot().ready).toBe(false);
    f.setTopology(topology()); f.engine.relayout(); f.flush(); expect(f.applied).toHaveLength(1);
  });
  it('waits for topology without inventing a monitor', () => {
    const f = fakeEngine(); f.setTopology(null); f.engine.start(); f.add(1, {monitor: null});
    expect(f.engine.treeSnapshot()).toMatchObject({ready: false, workspaces: []}); expect(f.applied).toEqual([]);
    f.setTopology(topology()); f.change(1, {monitor: 10}, 'frame'); f.engine.onMonitorsChanged(); f.flush();
    expect(f.engine.windowsSnapshot()[0].expectedRect?.width).toBe(1000);
  });
  it('bounds stubborn corrections and observes native frames', () => {
    const f = fakeEngine(); f.refuseGeometry = true; f.engine.start(); f.add(1); f.flush();
    expect(f.applied).toHaveLength(2); expect(f.engine.windowsSnapshot()[0]).toMatchObject({stubborn: true, rect: {x: 20, y: 40, width: 300, height: 200}});
    f.engine.relayout(); f.flush(); expect(f.applied).toHaveLength(2);
  });
  it('deduplicates lifecycle signals and stops deferred geometry', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.engine.onWindowEvent({type: 'added', id: 1}); f.flush();
    expect(f.engine.windowsSnapshot()).toHaveLength(1);
    f.change(1, {rect: {x: 2, y: 2, width: 2, height: 2}}, 'frame'); f.engine.stop();
    const count = f.applied.length; f.flush(); f.engine.relayout(); f.remove(1); expect(f.applied).toHaveLength(count);
  });
  it('isolates failed subscribers and publishes detached values', () => {
    const f = fakeEngine(); f.engine.start(); let notified = 0;
    f.engine.subscribeTreeChanged(() => { throw new Error('listener failed'); });
    f.engine.subscribeTreeChanged(() => notified++); f.add(1); f.flush();
    const snap = f.engine.treeSnapshot(); snap.workspaces.length = 0;
    expect(f.engine.treeSnapshot().workspaces).toHaveLength(10); expect(notified).toBeGreaterThan(0);
    f.add(2); f.flush(); expect(f.engine.windowsSnapshot()).toHaveLength(2);
  });
  it('workspace move acknowledgement keeps unchanged geometry and external move occurs once', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush(); f.applied.length = 0;
    const node = f.engine.treeSnapshot().workspaces[0].monitors[0].root;
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 1); f.flush();
    expect(f.applied).toHaveLength(0); expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: node.kind === 'split' ? node.children : []});
    f.change(1, {workspace: 3}, 'workspace'); f.change(1, {workspace: 3}, 'workspace'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[3].monitors[0].root).toMatchObject({children: [{window: 1}]});
  });
  it('retains nodes on reload and rejects restart without changing selection', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    const before = f.engine.treeSnapshot().workspaces;
    f.setNextLoad(f.load('bindsym Mod4+q kill')); f.engine.run([{type: 'reload'}], 0); f.flush();
    expect(f.engine.treeSnapshot().workspaces).toEqual(before); expect(f.calls).not.toContain('settings.restore');
    f.setNextLoad(f.load('bogus 1')); expect(f.engine.run([{type: 'restart'}], 0)).toContain('rejected');
    expect(f.engine.treeSnapshot().workspaces).toEqual(before); expect(f.engine.lastLoadTime).toBe(123456789);
  });
  it('preserves floating membership over minimize and honors initial state flags', () => {
    const f = fakeEngine();
    f.windows.set(1, windowInfo(1, {kind: 'floating', minimized: true}));
    f.windows.set(2, windowInfo(2, {fullscreen: true}));
    f.windows.set(3, windowInfo(3, {maximizedH: true, maximizedV: true}));
    f.engine.start(); f.flush(); expect(f.applied).toEqual([]); expect(f.calls).toContain('unmaximize:3');
    f.change(1, {minimized: false}, 'minimized'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[0].floating).toEqual([1]);
    expect(f.engine.windowsSnapshot()[0].state).toBe('floating');
    f.focus(1); f.calls.length = 0; f.focus(1); f.flush(); expect(f.calls).toEqual([]);
  });
  it('enforces effective count for zero, moves before shrinking, and defers growing geometry', () => {
    const f = fakeEngine(); f.engine.start(); expect(f.engine.config.workspaceCount).toBe(0);
    f.setNativeCount(7); expect(f.ports.workspaces.count).toBe(10);
    f.add(1, {workspace: 9}); f.flush(); const old = f.engine.treeSnapshot().workspaces[9].monitors[0].root;
    const loaded = f.load('bindsym Mod4+q kill');
    f.setNextLoad({...loaded, config: {...loaded.config!, workspaceCount: 2}}); f.calls.length = 0;
    f.engine.run([{type: 'reload'}], 0); f.flush();
    expect(f.calls.indexOf('moveTo:1:1')).toBeLessThan(f.calls.indexOf('settings.apply'));
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{children: old.kind === 'split' ? old.children : []}]});
    f.setNextLoad({...loaded, config: {...loaded.config!, workspaceCount: 12}});
    f.applied.length = 0; f.engine.run([{type: 'reload'}], 0);
    expect(f.engine.treeSnapshot()).toMatchObject({ready: false, workspaces: []}); expect(f.applied).toEqual([]);
    f.setTopology(topology(12)); f.engine.onWorkspacesChanged(); f.flush(); expect(f.engine.treeSnapshot().workspaces).toHaveLength(12);
  });
  it('does not consume stale observations against a newer generation', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.change(1, {rect: {x: 9, y: 9, width: 9, height: 9}}, 'frame');
    f.refuseGeometry = true; f.emitFrames = false; f.engine.onMonitorsChanged();
    const before = f.applied.length; f.flush(); expect(f.applied.length).toBe(before);
    f.engine.onWindowEvent({type: 'frame', id: 1}); f.flush(); expect(f.applied.length).toBe(before + 1);
  });
  it.each(['fullscreen', 'minimized'] as const)('uses current truth for mismatched move acknowledgements while %s', state => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.ports.windows.moveToWorkspace = id => { f.change(id, {workspace: 4, [state]: true}, 'workspace'); return true; };
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 0); f.flush();
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: []});
    f.change(1, {[state]: false}, state); f.flush();
    expect(f.engine.treeSnapshot().workspaces[4].monitors[0].root).toMatchObject({children: [{window: 1}]});
  });
  it('preserves pending destination until an asynchronous native acknowledgement', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.ports.windows.moveToWorkspace = () => true;
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 0);
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{window: 1}]});
    f.change(1, {workspace: 1}, 'workspace'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{window: 1}]});
  });
  it('rebuilds restart from live classification with stable ids and announces cache', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.windows.set(1, {...f.windows.get(1)!, kind: 'floating'});
    f.setNextLoad({...f.load('bindsym Mod4+q kill'), source: 'cache'});
    expect(f.engine.run([{type: 'restart'}], 0)).toBe('restarted'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[0].floating).toEqual([1]);
    expect(f.calls.some(c => c.includes('last good config'))).toBe(true);
  });
  it('starts locked and handles surviving selection activation failure', () => {
    const f = fakeEngine(); f.engine.start(true); expect(f.ports.keys.grabbedCount).toBe(0); expect(f.visible).toBe(false);
    f.add(1); f.add(2); f.flush(); f.activationFails = true; f.remove(2); f.flush(); expect(f.calls).toContain('focus:1');
    f.focus(null); f.engine.run([{type: 'kill'}], 0); expect(f.calls.at(-1)).toBe('kill:1');
    f.engine.onUnlocked(); expect(f.visible).toBe(true); expect(f.ports.keys.grabbedCount).toBe(1);
  });

  it('retains its tree and reconciles native frames when the initial lock ends', () => {
    const f = fakeEngine(referenceText);
    f.engine.start(true);
    expect(f.engine.state().grabbed).toBe(0);
    f.add(1);
    f.flush();
    const before = f.engine.treeSnapshot();
    const generation = f.engine.windowsSnapshot()[0].generation;
    f.windows.set(1, {...f.windows.get(1)!, rect: {x: 5, y: 5, width: 20, height: 20}});
    f.applied.length = 0;

    f.engine.onUnlocked();
    f.flush();

    expect(f.engine.state().grabbed).toBe(65);
    expect(f.engine.treeSnapshot().workspaces).toEqual(before.workspaces);
    expect(f.applied.some(batch => batch.has(1))).toBe(true);
    expect(f.engine.windowsSnapshot()[0].generation).toBe(generation);
  });

  it('resets resize mode while locked and never installs bare-key grabs on locked reload', () => {
    const f = fakeEngine(referenceText);
    f.engine.start();
    f.add(1);
    f.flush();
    const before = f.engine.treeSnapshot().workspaces;
    f.engine.run([{type: 'mode', name: 'resize'}], 0);
    f.engine.onLocked();
    expect(f.engine.state()).toMatchObject({mode: 'default', grabbed: 0});
    expect(f.visible).toBe(false);

    f.setNextLoad(f.load(referenceText));
    f.engine.run([{type: 'reload'}], 0);
    expect(f.engine.state()).toMatchObject({mode: 'default', grabbed: 0});
    expect(f.grabbedAccels()).toEqual([]);

    f.engine.onUnlocked();
    f.flush();
    expect(f.engine.state()).toMatchObject({mode: 'default', grabbed: 65});
    expect(f.visible).toBe(true);
    expect(f.engine.treeSnapshot().workspaces).toEqual(before);
  });

  it('ignores session edges before startup and honors the final seeded state', () => {
    const f = fakeEngine(referenceText);

    expect(() => {
      f.engine.onLocked();
      f.engine.onUnlocked();
    }).not.toThrow();
    expect(f.calls).toEqual([]);

    f.engine.start(true);
    expect(f.engine.state()).toMatchObject({mode: 'default', grabbed: 0});
  });

  it('cancels pending frames and restores settings exactly once on repeated stop', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.flush();
    f.change(1, {rect: {x: 5, y: 5, width: 20, height: 20}}, 'frame');
    f.applied.length = 0;

    f.engine.stop();
    f.engine.stop();
    f.flush();

    expect(f.applied).toEqual([]);
    expect(f.calls.filter(call => call === 'settings.restore')).toHaveLength(1);
  });

  it('returns pills detached from the values committed to the indicator', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    const state = f.engine.state();

    expect(state.pills[0]).toEqual({name: '1', active: true, occupied: true});
    state.pills[0].name = 'caller mutation';
    expect(f.engine.state().pills[0].name).toBe('1');
    expect(f.pills[0].name).toBe('1');
  });

  it('retains selection from native focus over the adoption MRU default', () => {
    const f = fakeEngine(); f.windows.set(1, windowInfo(1)); f.windows.set(2, windowInfo(2)); f.focus(2);
    f.engine.start(); f.engine.run([{type: 'kill'}], 0); expect(f.calls.at(-1)).toBe('kill:2');
  });
  it('rejects invalid effective workspace counts without changing the running state', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush(); const before = f.engine.treeSnapshot();
    const loaded = f.load('bindsym Mod4+x kill');
    f.setNextLoad({...loaded, config: {...loaded.config!, workspaceCount: 37}}); f.calls.length = 0;
    expect(f.engine.run([{type: 'reload'}], 0)).toContain('rejected');
    expect(f.engine.treeSnapshot()).toEqual(before); expect(f.calls).not.toContain('settings.apply');
    expect(f.grabbedAccels()).toEqual(['<Super>q']);
  });
  it('applies a reload requested from a subscriber as one queued transaction', () => {
    const f = fakeEngine(); f.engine.start();
    f.setNextLoad(f.load('bindsym Mod4+x kill\nbindsym Mod4+y kill'));
    const off = f.engine.subscribeTreeChanged(() => { off(); f.engine.run([{type: 'reload'}], 0); });
    f.add(1); f.flush();
    expect(f.grabbedAccels()).toEqual(['<Super>x', '<Super>y']);
  });

  it('retains newer generation frame notifications when coalescing an older read', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.change(1, {rect: {x: 9, y: 9, width: 9, height: 9}}, 'frame');
    f.refuseGeometry = true; f.applied.length = 0; f.engine.onMonitorsChanged(); f.flush();
    expect(f.applied).toHaveLength(2); expect(f.engine.windowsSnapshot()[0].stubborn).toBe(true);
  });

  it('invalidates an asynchronous focus request when another genuine focus wins', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.add(3); f.flush();
    const requests: number[] = [];
    f.ports.windows.activate = id => { requests.push(id); return true; };
    f.remove(3); expect(requests).toEqual([1]);
    f.focus(2); f.focus(1); f.engine.run([{type: 'kill'}], 0);
    expect(f.calls.at(-1)).toBe('kill:1');
  });

  it.each([null, 999])('processes returning tracked focus after native focus becomes %s', other => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.focus(1); f.add(2);
    f.focus(other); f.engine.run([{type: 'kill'}], 0);
    expect(f.calls.at(-1)).toBe('kill:2');
    f.focus(1); f.engine.run([{type: 'kill'}], 0);
    expect(f.calls.at(-1)).toBe('kill:1');
  });

  it('stops adoption immediately when native unmaximize disposes the engine', () => {
    const f = fakeEngine();
    f.windows.set(1, windowInfo(1, {maximizedH: true, maximizedV: true}));
    f.windows.set(2, windowInfo(2));
    let stoppedTree: ReturnType<typeof f.engine.treeSnapshot> | undefined;
    f.ports.windows.unmaximize = () => {
      f.engine.stop(); stoppedTree = f.engine.treeSnapshot(); return false;
    };
    f.engine.start(); f.flush();
    expect(f.applied).toEqual([]);
    expect(f.engine.treeSnapshot()).toEqual(stoppedTree);
    expect(f.engine.windowsSnapshot().map(w => w.id)).toEqual([1]);
    expect(f.pills).toEqual([]);
  });

  it('stops delivering captured subscribers when a listener disposes the engine', () => {
    const f = fakeEngine(); f.engine.start();
    let laterCalls = 0;
    f.engine.subscribeTreeChanged(() => f.engine.stop());
    f.engine.subscribeTreeChanged(() => laterCalls++);
    f.add(1); f.flush();
    expect(laterCalls).toBe(0);
  });

  it('stops a shrinking reload after a native workspace move disposes the engine', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1, {workspace: 9}); f.add(2, {workspace: 9}); f.flush();
    const loaded = f.load('bindsym Mod4+x kill');
    f.setNextLoad({...loaded, config: {...loaded.config!, workspaceCount: 2}});
    const moved: number[] = [];
    f.ports.windows.moveToWorkspace = id => { moved.push(id); f.engine.stop(); return false; };
    f.calls.length = 0; f.applied.length = 0;
    f.engine.run([{type: 'reload'}], 0); f.flush();
    expect(moved).toHaveLength(1);
    expect(f.calls).toEqual(['ungrabAll', 'settings.restore']);
    expect(f.applied).toEqual([]);
  });

  it('does not resume startup effects after settings application disposes the engine', () => {
    const f = fakeEngine();
    f.ports.settings.apply = () => f.engine.stop();
    f.engine.start();
    expect(f.calls).toEqual(['ungrabAll', 'settings.restore']);
    expect(f.ports.keys.grabbedCount).toBe(0);
    expect(f.applied).toEqual([]);
  });

});
