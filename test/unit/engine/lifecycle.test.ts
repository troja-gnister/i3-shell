import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fakeEngine, topology, windowInfo, type EngineFixture} from './fakeEngine';
import {parseCommands} from '../../../src/commands/parse';
import type {NodeSnapshot, TreeSnapshot} from '../../../src/runtime/snapshot';
import type {NodeId, WindowId} from '../../../src/tree/node';

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
    f.add(3); f.flush();
    // Moving window 3 onto a genuinely different workspace must not change which workspace is active:
    // adding (or moving) content elsewhere is not a switch. There is no `workspace N` yet (Task 7), so
    // this uses `move_to_workspace` rather than the old `workspace: 4` fixture shorthand -- adoption no
    // longer reads `info.workspace`, so that shorthand would leave window 3 on workspace 0 too, and the
    // assertion below could never fail.
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 5, name: '5'}}], 2);
    expect(f.engine.treeSnapshot().activeWorkspace).toBe(0);
  });
  it.each(['fullscreen', 'minimized', 'maximized'] as const)('reapplies an unchanged tile after %s exit', event => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    const before = f.engine.windowsSnapshot()[0].generation!;
    f.change(1, event === 'fullscreen' ? {fullscreen: true} : event === 'minimized' ? {minimized: true} : {maximizedH: true, maximizedV: true}, event); f.flush();
    // Minimizing evicts a window from the tree outright (excludedFromTree), and occupancy is now read
    // from the tree, not from WindowInfo.workspace: a minimized window no longer keeps its workspace's
    // pill lit.
    if (event === 'minimized') expect(f.pills[0].occupied).toBe(false);
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
  it('applies a deferred frame-read normally, but drops one that resolves after onClosing()', () => {
    // Meta.Display::closing fires while the session tears down, but a frame
    // read queued before it does not resolve synchronously -- it comes back
    // on a later main-loop turn (see the 'frame' branch of onWindowEvent).
    // Gating only the synchronous entry point would let that deferred tail
    // still reach commit() -> _layoutAndPublish() after closing.
    //
    // Two windows, each observed exactly once: RectReconciler.observe()
    // gives a window's *first* mismatch a correction and only marks it
    // stubborn (and permanently silent) on a second one, so reusing one
    // window for both halves of this test would make the "after" half
    // pass whether or not onClosing() actually did anything.
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush(); f.applied.length = 0; f.calls.length = 0;
    f.change(1, {rect: {x: 3, y: 3, width: 3, height: 3}}, 'frame'); f.flush();
    expect(f.applied.length).toBeGreaterThan(0); // still works normally: closing has not fired

    f.applied.length = 0; f.calls.length = 0;
    f.change(2, {rect: {x: 9, y: 9, width: 9, height: 9}}, 'frame'); // queues a deferred read
    f.engine.onClosing();
    f.flush(); // drains the queue; the read must not reach commit()
    expect(f.applied).toEqual([]);
    expect(f.calls).not.toContain('decorations');
  });
  it('isolates failed subscribers and publishes detached values', () => {
    const f = fakeEngine(); f.engine.start(); let notified = 0;
    f.engine.subscribeTreeChanged(() => { throw new Error('listener failed'); });
    f.engine.subscribeTreeChanged(() => notified++); f.add(1); f.flush();
    const snap = f.engine.treeSnapshot(); snap.workspaces.length = 0;
    expect(f.engine.treeSnapshot().workspaces).toHaveLength(10); expect(notified).toBeGreaterThan(0);
    f.add(2); f.flush(); expect(f.engine.windowsSnapshot()).toHaveLength(2);
  });
  it('workspace move acknowledgement keeps unchanged geometry for a workspace that is not shown', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush(); f.applied.length = 0;
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 1); f.flush();
    // Workspace 1 is not the (single) output's visible workspace, so its geometry is never computed --
    // there is nothing to apply, per the note at engine.ts's layout loop -- and the parked leaf's rect
    // is therefore null rather than the one it had while still on the visible workspace.
    expect(f.applied).toHaveLength(0);
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{kind: 'leaf', window: 1, rect: null}]});
    // A native 'workspace' echo for a window the tree already tracks is a no-op now: Mutter's workspace
    // field says nothing about which i3 workspace a window belongs to (spec 2.6), so it can no longer
    // relocate a tracked window the way it once could.
    f.change(1, {workspace: 3}, 'workspace'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{kind: 'leaf', window: 1, rect: null}]});
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
    // A duplicate focus report still runs a commit — which still republishes
    // the (unchanged) decoration plan — but does nothing else observable.
    f.focus(1); f.calls.length = 0; f.focus(1); f.flush(); expect(f.calls).toEqual(['decorations']);
  });
  it('enforces effective count for zero and moves before shrinking', () => {
    const f = fakeEngine(); f.engine.start(); expect(f.engine.config.workspaceCount).toBe(0);
    // Self-healing now targets GNOME's own pinned count -- two, live + attic -- not the i3 workspace
    // count: GNOME's raw number stopped meaning anything i3-relevant once the attic landed.
    f.setNativeCount(7); expect(f.ports.workspaces.count).toBe(2);
    // A new window always adopts onto the visible workspace now (there is no `workspace N` yet to move
    // it away with a real switch), so getting it onto workspace 9 goes through `move_to_workspace`.
    f.add(1); f.flush();
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 10, name: '10'}}], 0); f.flush();
    const old = f.engine.treeSnapshot().workspaces[9].monitors[0].root;
    const loaded = f.load('bindsym Mod4+q kill');
    f.setNextLoad({...loaded, config: {...loaded.config!, workspaceCount: 2}}); f.calls.length = 0;
    f.engine.run([{type: 'reload'}], 0); f.flush();
    expect(f.calls.indexOf('moveTo:1:1')).toBeLessThan(f.calls.indexOf('settings.apply'));
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{children: old.kind === 'split' ? old.children : []}]});
    f.setNextLoad({...loaded, config: {...loaded.config!, workspaceCount: 12}});
    f.applied.length = 0; f.engine.run([{type: 'reload'}], 0); f.flush();
    // Work areas are per output now (Task 4), not per workspace, so growing the count no longer strands
    // the new workspaces without geometry the way the old per-workspace work-area map could: there is
    // nothing left to defer.
    expect(f.engine.treeSnapshot()).toMatchObject({ready: true});
    expect(f.engine.treeSnapshot().workspaces).toHaveLength(12);
    expect(f.applied).toEqual([]);
  });
  it('does not consume stale observations against a newer generation', () => {
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.change(1, {rect: {x: 9, y: 9, width: 9, height: 9}}, 'frame');
    f.refuseGeometry = true; f.emitFrames = false; f.engine.onMonitorsChanged();
    const before = f.applied.length; f.flush(); expect(f.applied.length).toBe(before);
    f.engine.onWindowEvent({type: 'frame', id: 1}); f.flush(); expect(f.applied.length).toBe(before + 1);
  });
  it('ignores a mismatched native workspace report while fullscreen', () => {
    // A native 'workspace' echo that disagrees with the tree is not trusted any more: Mutter's
    // workspace field says nothing about which i3 workspace a window belongs to (spec 2.6). Fullscreen
    // never excludes a window from the tree either, so it stays exactly where the tree's own move put it.
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    f.ports.windows.moveToWorkspace = id => { f.change(id, {workspace: 4, fullscreen: true}, 'workspace'); return true; };
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 0); f.flush();
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{window: 1}]});
    f.change(1, {fullscreen: false}, 'fullscreen'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{window: 1}]});
  });
  it('re-adopts a minimized window onto the workspace it came from, not Mutter’s mismatched report', () => {
    // Minimizing evicts a window from the tree outright. `_minimized` remembers the i3 workspace it
    // was on -- read from the tree's own location, not from Mutter's report -- alongside its
    // floating-ness, so a mismatched native report at the moment it minimizes (4 here, matching
    // nothing the move itself did) changes nothing: on restore it comes back onto workspace 1, where
    // the move actually put it, not onto workspace 0 (the output's visible one) or 4 (Mutter's report).
    const f = fakeEngine(); f.engine.start(); f.add(1); f.flush();
    // The mismatch fires only for the move itself; F2's own adoption-time re-sync on restore (below)
    // must not re-trigger it, or restoring would immediately re-evict the window it just placed.
    let mismatched = false;
    f.ports.windows.moveToWorkspace = (id, index) => {
      if (!mismatched) { mismatched = true; f.change(id, {workspace: 4, minimized: true}, 'workspace'); }
      else f.change(id, {workspace: index}, 'workspace');
      return true;
    };
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 0); f.flush();
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: []});
    f.change(1, {minimized: false}, 'minimized'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[1].monitors[0].root).toMatchObject({children: [{window: 1}]});
    expect(f.engine.treeSnapshot().workspaces[0].monitors[0].root).toMatchObject({children: []});
  });
  it('re-adopts a minimized window onto the workspace it came from, not the one now visible', () => {
    // Addition beyond the brief (Task 6, item beyond the swap): before Phase 5, WindowInfo.workspace
    // (a GNOME index) happened to remember where a window came from; the attic made that field always
    // 0 or 1, so without this, a window evicted from a non-visible workspace re-adopted onto whichever
    // workspace is visible when it returns -- and its pill went dark while it was away.
    //
    // F2: re-adopting onto the *tree* workspace is only half of it -- nothing previously moved the
    // window's *native* GNOME workspace to match, so it could sit on a hidden tree workspace while
    // GNOME still rendered it live. Asserts the GNOME workspace alongside the tree one for that.
    const f = fakeEngine(); f.engine.start();
    f.tree().visible.set(f.tree().focusedOutput, 2);
    f.add(1); f.flush();   // adopts onto workspace 2, which is visible right now
    expect(f.engine.treeSnapshot().workspaces[2].monitors[0].root).toMatchObject({children: [{window: 1}]});
    expect(f.windows.get(1)!.workspace).toBe(0);   // LIVE: workspace 2 is visible
    f.tree().visible.set(f.tree().focusedOutput, 0);   // the output now shows workspace 0 instead
    f.change(1, {minimized: true}, 'minimized'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[2].monitors[0].root).toMatchObject({children: []});
    f.change(1, {minimized: false}, 'minimized'); f.flush();
    expect(f.engine.treeSnapshot().workspaces[2].monitors[0].root).toMatchObject({children: [{window: 1}]});
    expect(f.windows.get(1)!.workspace).toBe(1);   // ATTIC: workspace 2 is hidden now
    expect(f.engine.treeSnapshot().workspaces[0].monitors[0].root).toMatchObject({children: []});
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

    expect(state.pills[0]).toEqual({name: '1', active: true, occupied: true, urgent: false});
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
    // The stale workspace: 9 must be set *after* adoption, not in the initial patch -- F2's own
    // adoption-time sync (workspace 0 is visible, so LIVE) would otherwise immediately correct it
    // away from 9 before the vestigial-count check below ever saw it.
    const f = fakeEngine(); f.engine.start(); f.add(1); f.add(2); f.flush();
    f.change(1, {workspace: 9}, 'workspace'); f.change(2, {workspace: 9}, 'workspace'); f.flush();
    const loaded = f.load('bindsym Mod4+x kill');
    f.setNextLoad({...loaded, config: {...loaded.config!, workspaceCount: 2}});
    const moved: number[] = [];
    f.ports.windows.moveToWorkspace = id => { moved.push(id); f.engine.stop(); return false; };
    f.calls.length = 0; f.applied.length = 0;
    f.engine.run([{type: 'reload'}], 0); f.flush();
    expect(moved).toHaveLength(1);
    // _moveReconfigured now warns on a refused move (F1); the mock refuses and disposes in the same
    // call, and the warn is logged before the disposed check runs.
    expect(f.calls).toEqual([
      'launcher.close', 'ungrabAll', 'settings.restore',
      'warn:could not move window 1 to workspace 2; leaving it where it was',
    ]);
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

describe('accent colours', () => {
  it('paints focused chrome with the desktop accent when the config asks for no colour', () => {
    const f = fakeEngine('bindsym Mod4+q kill');
    f.engine.start();
    expect(f.pushedColors!.focused.background).toBe('#6f8396');
  });

  it('keeps the config colour when the config does specify one', () => {
    const f = fakeEngine('bindsym Mod4+q kill\nclient.focused #13BEAA #13BEAA #FFFFFF');
    f.engine.start();
    expect(f.pushedColors!.focused.background).toBe('#13BEAA');
  });

  it('repaints when the desktop accent changes', () => {
    const f = fakeEngine('bindsym Mod4+q kill');
    f.engine.start();
    f.setAccent({background: '#e62d42', text: '#ffffff'});
    expect(f.pushedColors!.focused.background).toBe('#e62d42');
  });

  it('does not repaint on an accent change when the config pinned the colour', () => {
    const f = fakeEngine('bindsym Mod4+q kill\nclient.focused #13BEAA #13BEAA #FFFFFF');
    f.engine.start();
    f.setAccent({background: '#e62d42', text: '#ffffff'});
    expect(f.pushedColors!.focused.background).toBe('#13BEAA');
  });

  it('repaints on an accent change normally, but not once onClosing() has fired', () => {
    // notify::accent-color pushes straight to the indicator/decorations ports
    // (Engine.start()'s accent.subscribe callback), bypassing commit()
    // entirely -- so gating commit() alone would leave this path open.
    const f = fakeEngine('bindsym Mod4+q kill');
    f.engine.start();
    f.setAccent({background: '#e62d42', text: '#ffffff'});
    expect(f.pushedColors!.focused.background).toBe('#e62d42'); // still works normally: closing has not fired

    f.engine.onClosing();
    f.setAccent({background: '#111111', text: '#ffffff'});
    expect(f.pushedColors!.focused.background).toBe('#e62d42'); // unchanged: the push after onClosing() never happened
  });
});

describe('decorations', () => {
  it('pushes a plan on every commit, including the one that empties it', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.flush();
    expect(f.plan!.borders.map(b => b.window)).toEqual([1]);
    f.remove(1);
    f.flush();
    expect(f.plan!.borders).toEqual([]);
  });

  it('lays out with the row height the shell measured', () => {
    const f = fakeEngine();
    f.engine.start();
    f.engine.setRowHeight(20);
    f.add(1);
    f.flush();
    f.engine.run(parseCommands('layout tabbed').commands, 0);
    f.flush();
    // The tabbed root reserved one row, so the window starts 20px lower.
    const applied = f.applied.at(-1)!;
    expect(applied.get(1)!.y).toBe(50);   // work area y 30 + 20
  });

  it('draws nothing for a workspace that is not shown on any output', () => {
    // Every output's visible workspace is on screen at once now and is decorated (Task 5); a workspace
    // that no output shows is parked -- untiled, unobserved -- and gets no chrome. There is no
    // `workspace N` yet (Task 7) to change what is shown, so the only way to get content onto a parked
    // workspace during this task is `move_to_workspace`.
    const f = fakeEngine('bindsym Mod4+q kill', {monitors: [{id: 10, index: 0}, {id: 11, index: 1}], primary: 10, workspaceCount: 3});
    f.engine.start();
    f.engine.setRowHeight(20);
    f.add(1); f.flush();                 // workspace 0, output 10 -- visible
    f.add(2, {monitor: 11}); f.flush();  // workspace 1, output 11 -- visible
    f.add(3); f.flush();                 // adopts onto workspace 0, output 10's visible workspace

    f.engine.focusWindow(3);
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 3, name: '3'}}], 0); f.flush();
    // Workspace 2 belongs to output 10 (the surplus goes to the primary) but neither output shows it.
    expect(f.engine.treeSnapshot().workspaces[2].monitors[0].root).toMatchObject({children: [{window: 3}]});
    expect(f.plan!.borders.map(b => b.window).sort()).toEqual([1, 2]);
  });
});

describe('focusWindow', () => {
  /** Two windows in a tabbed container -- the shape whose title row is clickable. */
  const tabbed = () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.add(2);
    f.flush();
    f.engine.run(parseCommands('layout tabbed').commands, 0);
    f.flush();
    return f;
  };

  it('selects the clicked leaf and activates its window', () => {
    const f = tabbed();
    f.calls.length = 0;
    f.engine.focusWindow(1);
    f.flush();
    expect(f.calls).toContain('focus:1');
    // The plan the renderer gets back marks the clicked tab, not the old one.
    const tabs = f.plan!.titleRows[0].tabs;
    expect(tabs.map(tab => [tab.window, tab.selected])).toEqual([[1, true], [2, false]]);
  });

  it('commits once for one click', () => {
    const f = tabbed();
    f.calls.length = 0;
    f.engine.focusWindow(1);
    // One activation, the tabbed container's restack with the clicked window
    // on top, and one publish for the selection -- then the publish that
    // carries the native focus report back, exactly what a `focus` command
    // costs. A second commit for the click itself would show up as a third
    // 'decorations', and every publish re-pushes each window's rect.
    expect(f.calls).toEqual(['focus:1', 'raise:2', 'raise:1', 'decorations', 'decorations']);
  });

  it('ignores a window that is not in the tree', () => {
    // A tab click reaches the engine one main-loop turn late (Decorations
    // defers it, so the click's own `clicked` emission has returned before
    // apply() can destroy the button), so the window can be gone by then.
    const f = tabbed();
    f.remove(2);
    f.flush();
    f.calls.length = 0;
    f.engine.focusWindow(2);
    f.engine.focusWindow(99);
    expect(f.calls).toEqual([]);
  });

  it('ignores a window on another workspace', () => {
    // Only the active workspace has chrome on screen, and activating the
    // selection reads the active workspace's selection -- so accepting one
    // from elsewhere would move the focus to whatever that workspace happened
    // to have selected.
    //
    // There is no `workspace N` yet (Task 7) to switch what is active, so getting window 3 onto
    // "another workspace" goes through `move_to_workspace` instead of the old `workspace: 4` fixture shorthand.
    const f = tabbed();
    f.add(3);
    f.flush();
    f.engine.focusWindow(3);
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 0);
    f.flush();
    f.calls.length = 0;
    f.engine.focusWindow(3);
    expect(f.calls).toEqual([]);
  });
});

describe('focusNode', () => {
  /**
   * `A | (B over C)` inside a tabbed root: two tabs, the second of which
   * titles a nested container rather than a window. That tab's `window` is
   * null -- its nodeId is the only thing a click on it can report.
   */
  const nested = () => {
    const f = fakeEngine();
    f.engine.start();
    f.engine.setRowHeight(20);
    f.add(1);
    f.add(2);
    f.flush();
    f.engine.run(parseCommands('layout tabbed').commands, 0);
    f.flush();
    f.engine.focusWindow(2);
    f.flush();
    f.engine.run(parseCommands('split v').commands, 0);
    f.flush();
    f.add(3);
    f.flush();
    return f;
  };

  /** The nodeId of the tab that titles a container rather than a window. */
  const containerTab = (f: EngineFixture): number => {
    const tab = f.plan!.titleRows[0].tabs.find(candidate => candidate.window === null);
    expect(tab).toBeDefined();
    return tab!.nodeId;
  };

  it(`focuses the container tab's focused leaf`, () => {
    const f = nested();
    const nodeId = containerTab(f);
    f.engine.focusWindow(1);             // focus the other tab first
    f.flush();
    f.calls.length = 0;
    f.engine.focusNode(nodeId);
    f.flush();
    // The container's focused descendant, not the first leaf under it and not
    // the container itself: i3 titles a nested tab with that descendant, so a
    // click on it has to land on the same window the tab is showing.
    expect(f.calls).toContain('focus:3');
    expect(f.plan!.titleRows[0].tabs.map(tab => [tab.window, tab.selected]))
      .toEqual([[1, false], [null, true]]);
  });

  it('leaves the selection a leaf, so no container outline appears', () => {
    // Selecting the container itself would activate the same window but also
    // draw the $mod+a frame, which no click on a tab should produce.
    const f = nested();
    const nodeId = containerTab(f);
    f.engine.focusWindow(1);
    f.flush();
    f.engine.focusNode(nodeId);
    f.flush();
    expect(f.plan!.frames).toEqual([]);
  });

  it('commits once for one click', () => {
    const f = nested();
    const nodeId = containerTab(f);
    f.engine.focusWindow(1);
    f.flush();
    f.calls.length = 0;
    f.engine.focusNode(nodeId);
    // One commit for the selection plus the one carrying the native focus
    // report back -- what a `focus` command costs. A second commit for the
    // click itself would show up as a third 'decorations', and every publish
    // re-pushes each window's rect.
    expect(f.calls.filter(call => call === 'decorations')).toHaveLength(2);
  });

  it('ignores a node id that is not in the tree', () => {
    // The click reaches the engine a main-loop turn late, so the container may
    // have been flattened away by then.
    const f = nested();
    f.calls.length = 0;
    f.engine.focusNode(999999);
    expect(f.calls).toEqual([]);
  });

  it('ignores a node on another workspace', () => {
    // Same reason focusWindow refuses one: only the active workspace has
    // chrome on screen, and activating the selection reads that workspace's
    // selection.
    //
    // There is no `workspace N` yet (Task 7), so a node lands on "another workspace" via
    // `move_to_workspace` rather than the old `workspace: 4` fixture shorthand; the refusal itself
    // (searching only the active workspace's root) does not care whether the id names a leaf or a
    // nested container, so a plain leaf id exercises the same code path.
    const f = fakeEngine();
    f.engine.start();
    f.engine.setRowHeight(20);
    f.add(1);
    f.flush();
    const nodeId = f.tree().find(1)!.id;
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 0);
    f.flush();
    f.calls.length = 0;
    f.engine.focusNode(nodeId);
    expect(f.calls).toEqual([]);
  });
});

/** The nodeId of the leaf holding `window` on workspace 0's only monitor. */
function leafOf(snapshot: TreeSnapshot, window: WindowId): NodeId {
  const walk = (node: NodeSnapshot): NodeId | null => {
    if (node.kind === 'leaf') return node.window === window ? node.id : null;
    for (const child of node.children) { const found = walk(child); if (found !== null) return found; }
    return null;
  };
  const found = walk(snapshot.workspaces[0].monitors[0].root);
  if (found === null) throw new Error(`window ${window} has no leaf`);
  return found;
}

describe('exclusion from the tree', () => {
  it('removes a window from the tiling when it becomes sticky', () => {
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {sticky: true}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
    expect(f.applied.at(-1)!.get(1)).toEqual({x: 0, y: 30, width: 1000, height: 700});
  });

  it('returns it beside the focused window when sticky clears', () => {
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {sticky: true}, 'membership'); f.flush();
    f.change(2, {sticky: false}, 'membership'); f.flush();
    const rects = f.applied.at(-1)!;
    expect(rects.get(1)!.width).toBe(500);
    expect(rects.get(2)!.width).toBe(500);
  });

  it('excludes a skip-taskbar window the same way', () => {
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {skipTaskbar: true}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
  });

  it('rejoins only when every reason has cleared', () => {
    // Review Focus: minimized AND sticky together.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {sticky: true, minimized: true}, 'membership'); f.flush();
    f.change(2, {sticky: false, minimized: true}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
    f.change(2, {sticky: false, minimized: false}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(true);
  });

  it('does not leave the selection dangling when the selected window leaves', () => {
    // Review Focus: removing the selected window must move the selection, not
    // leave it pointing at a con that no longer exists.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.focus(2); f.flush();
    f.change(2, {sticky: true}, 'membership'); f.flush();
    expect(f.engine.state().mode).toBe('default');
    expect(() => f.engine.run(parseCommands('focus left').commands, 0)).not.toThrow();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
    // Where it landed, not merely that nothing threw: the assertions above all
    // hold with the selection still pointing at the removed leaf.
    const snapshot = f.engine.treeSnapshot();
    expect(snapshot.workspaces[0].selected).toEqual({kind: 'tiled', nodeId: leafOf(snapshot, 1)});
  });

  it('admits a window that is already sticky at its first frame', () => {
    // Review Focus: the fix is about a transition, but a window mapped straight
    // onto a secondary output is sticky before it is ever classified. It must be
    // tracked and excluded, never dropped.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2, {sticky: true}); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(false);
    f.change(2, {sticky: false}, 'membership'); f.flush();
    expect(f.applied.at(-1)!.has(2)).toBe(true);
  });

  it('keeps a floating skip-taskbar window in the floating list, not excluded', () => {
    // Review Focus: regression for scenario A13. A modal dialog floats (type
    // modal-dialog, transient) and Mutter also reports it skip-taskbar; before
    // this fix it would be dropped from the tree *and* never reach
    // tree.addFloating, so it vanished from workspace_snapshot().floating too.
    const f = fakeEngine(); f.engine.start();
    f.add(1);
    f.add(2, {kind: 'floating', skipTaskbar: true});
    f.flush();
    expect(f.engine.treeSnapshot().workspaces[0].floating).toEqual([2]);
  });

  it('excludes a tiled skip-taskbar window from the tree and the floating list', () => {
    const f = fakeEngine(); f.engine.start();
    f.add(1);
    f.add(2, {skipTaskbar: true}); // kind defaults to 'tiled'
    f.flush();
    expect(f.engine.treeSnapshot().workspaces[0].floating).toEqual([]);
    expect(f.applied.at(-1)!.has(2)).toBe(false);
  });

  it('does not unmaximize a pinned window the user maximized', () => {
    // Review Focus: the unmaximize gate must ask the same question tree
    // membership asks. A sticky window is not ours: it is excluded from
    // `expected`, so unmaximizing it cannot tile it -- it only undoes the
    // user's own maximize, once per maximize, forever, because
    // _unmaximizeAttempts resets every time the window reports unmaximized.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {sticky: true}, 'membership'); f.flush();

    f.change(2, {maximizedH: true, maximizedV: true}, 'maximized'); f.flush();

    expect(f.calls).not.toContain('unmaximize:2');
  });

  it('does not unmaximize an excluded skip-taskbar window', () => {
    // Review Focus: the same omission for the third exclusion reason.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {skipTaskbar: true}, 'membership'); f.flush();

    f.change(2, {maximizedH: true}, 'maximized'); f.flush();

    expect(f.calls).not.toContain('unmaximize:2');
  });

  it('does not commit a rectangle correction for a window that has left the tree', () => {
    // Review Focus: _observe carries the same gate. A pinned window the user
    // drags is not drifting from a target we set -- its reconciler state is
    // merely stale -- so queueing a correction publishes a commit that can
    // never apply anything.
    const f = fakeEngine(); f.engine.start();
    f.add(1); f.add(2); f.flush();
    f.change(2, {sticky: true}, 'membership'); f.flush();
    const revision = f.engine.treeSnapshot().revision;

    f.change(2, {rect: {x: 7, y: 9, width: 11, height: 13}}, 'frame'); f.flush();

    expect(f.engine.treeSnapshot().revision).toBe(revision);
  });
});

describe('workspace pill labels', () => {
  const config = (extra: string) => [
    'bindsym Mod4+1 workspace number "1:I"',
    'bindsym Mod4+2 workspace number "2:II"',
    extra,
  ].join('\n');

  it('labels pills with the full configured name by default', () => {
    const f = fakeEngine(config('# no bar block'));
    f.engine.start();
    expect(f.pills.map(p => p.name)).toEqual(['1:I', '2:II']);
  });

  it('drops the leading number when the bar block asks it to', () => {
    const f = fakeEngine(config('bar {\n  strip_workspace_numbers yes\n}'));
    f.engine.start();
    expect(f.pills.map(p => p.name)).toEqual(['I', 'II']);
  });

  it('still resolves a workspace command by its full name while stripping', () => {
    const f = fakeEngine(config('bar {\n  strip_workspace_numbers yes\n}'));
    f.engine.start();
    f.engine.run(parseCommands('workspace "2:II"').commands, 0);
    expect(f.calls).toContain('activate:1');
  });
});
