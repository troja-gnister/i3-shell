import {describe, expect, it} from 'vitest';
import {ATTIC_WORKSPACE, LIVE_WORKSPACE} from '../../../src/runtime/model';
import {fakeEngine} from './fakeEngine';

/**
 * The Quick Settings toggle's engine half. OFF is a PAUSE, not a disable: the toggle itself has to stay
 * on the panel or there is no way back on, so the engine stops acting while keeping every object alive.
 *
 * The substantive half of OFF is the attic flush. Every window on an i3 workspace no output is showing
 * is parked on ATTIC_WORKSPACE, which Mutter refuses to render. Switching off without flushing would
 * leave those windows invisible and unreachable with nothing left running to bring them back -- the
 * exact "audible but invisible window" failure this project was started to fix.
 */
describe('setTilingEnabled', () => {
  /**
   * One window parked in the attic: tracked, on a tree workspace no output shows.
   *
   * TWO windows, deliberately. Window 1 stays on LIVE for the whole fixture and is the control that
   * proves `_flushAttic`'s `info.workspace === LIVE_WORKSPACE` skip is real: with one window a flush
   * that re-asserted every window's workspace and a flush that touched only the parked one would make
   * exactly the same port calls.
   */
  function parked() {
    const f = fakeEngine('bindsym Mod4+q kill', {workspaceCount: 10});
    f.engine.start();
    f.add(1);
    f.add(2);
    f.flush();
    // Window 2 goes to workspace 2, which the single output is not showing, so it is parked.
    f.focus(2);
    expect(f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 1))
      .toBe('moved to workspace 2');
    expect(f.windows.get(2)!.workspace).toBe(ATTIC_WORKSPACE);
    expect(f.windows.get(1)!.workspace).toBe(LIVE_WORKSPACE);
    f.calls.length = 0;
    return f;
  }

  it('returns every parked window to the live workspace when switched off', () => {
    const f = parked();
    f.engine.setTilingEnabled(false);
    expect(f.engine.tilingEnabled).toBe(false);
    expect(f.calls).toContain(`moveTo:2:${LIVE_WORKSPACE}`);
    expect(f.windows.get(2)!.workspace).toBe(LIVE_WORKSPACE);
    // The control: the window that was already live is not re-asserted.
    expect(f.calls).not.toContain(`moveTo:1:${LIVE_WORKSPACE}`);
  });

  it('returns a minimized window from the attic too, not only the tree own members', () => {
    // Review Focus 1. A minimized, sticky or skip-taskbar window is EVICTED from the tree and held in
    // `_minimized`, so a flush that walks the tree's workspaces never sees it -- and it is sitting in the
    // attic, because it was parked before it was minimized. That window is the project's founding
    // failure reintroduced by its own off switch.
    const f = parked();
    f.change(2, {minimized: true}, 'minimized');
    expect(f.tree().location(2)).toBeNull();
    expect(f.windows.get(2)!.workspace).toBe(ATTIC_WORKSPACE);
    f.calls.length = 0;

    f.engine.setTilingEnabled(false);
    expect(f.calls).toContain(`moveTo:2:${LIVE_WORKSPACE}`);
  });

  it('flushes the attic before restoring the GSettings, never after', () => {
    // restoreAll() puts GNOME's own num-workspaces back. Restoring first can remove the workspace the
    // parked windows are sitting on, and Mutter then moves them wherever it likes -- which may be another
    // inactive workspace, i.e. still invisible. Flush first, and the attic is empty before it can go away.
    const f = parked();
    f.engine.setTilingEnabled(false);
    expect(f.calls.indexOf(`moveTo:2:${LIVE_WORKSPACE}`)).toBeGreaterThanOrEqual(0);
    expect(f.calls.indexOf(`moveTo:2:${LIVE_WORKSPACE}`)).toBeLessThan(f.calls.indexOf('settings.restore'));
  });

  it('warns rather than desyncing when the native move out of the attic is refused', () => {
    const f = parked();
    f.refuseMove(2);
    f.engine.setTilingEnabled(false);
    expect(f.calls).toContain('warn:could not return window 2 from the attic; it may stay hidden');
  });

  it('ungrabs the keys, hides the pills and empties the decorations when switched off', () => {
    const f = parked();
    f.engine.setTilingEnabled(false);
    expect(f.calls).toContain('ungrabAll');
    expect(f.ports.keys.grabbedCount).toBe(0);
    // And nothing re-grabbed on the way out. `setTilingEnabled(false)` resets the binding mode, and
    // `_enterMode` re-grabs unless the engine is suspended -- which is the `_locked` read that had to
    // become `_suspended`. Reverted, the grabs are taken and then dropped again a line later, so the
    // final `grabbedCount` cannot see it: the ungrab is not the assertion, the absence of the grab is.
    expect(f.calls.filter(call => call.startsWith('grab:'))).toEqual([]);
    expect(f.visible).toBe(false);
    expect(f.plan).toEqual({borders: [], frames: [], titleRows: []});
  });

  it('closes the launcher when switched off, so its modal grab cannot keep the keyboard', () => {
    // Fix round 1, I1. The worst outcome anything in this task can produce: the launcher holds a modal
    // grab on the whole session, so a launcher left open with the engine paused -- its own bindings
    // ungrabbed, its commands refused -- takes the keyboard away from everything and gives it to a window
    // that will not answer. `reload`, `restart`, `onMonitorsChanged` and `onLocked` all close it first for
    // this reason; switching tiling off is the fifth, and the only one the user reaches by mouse while the
    // launcher is in front of them.
    const f = parked();
    expect(f.engine.run([{type: 'launcher', term: null}], 1)).toBe('launcher');
    expect(f.ports.launcher.isOpen()).toBe(true);
    f.calls.length = 0;

    f.engine.setTilingEnabled(false);
    expect(f.ports.launcher.isOpen()).toBe(false);
    expect(f.calls).toContain('launcher.close');
  });

  it('does not restore the workspace count and then re-force it from under the user', () => {
    // Fix round 1, I2: what the paused `commit()` is really for, now that the fake's `restoreAll()` puts
    // GNOME's own `num-workspaces` back the way the real settings port does.
    //
    // Restoring that count raises GNOME's `n-workspaces` signal, which arrives as
    // `onWorkspacesChanged()`. That handler exists to force the count back to two and to drag the active
    // workspace back to live -- correct while tiling is on, and the exact opposite of what switching off
    // just did. Without the `_paused` guard in `commit()` the restore is undone a main-loop turn after it
    // lands: the user's workspaces vanish again, with no pills, no bindings and nothing to explain it.
    const f = parked();
    f.engine.setTilingEnabled(false);
    expect(f.ports.workspaces.count).toBe(10);
    f.calls.length = 0;

    // The native signal the restore itself raises (the fixture's own convention for a change no port call
    // of the engine's made; see `setActiveIndex`).
    f.engine.onWorkspacesChanged();
    expect(f.calls).toEqual([]);
    expect(f.ports.workspaces.count).toBe(10);
  });

  it('stops committing while off: a new window is neither tiled nor parked', () => {
    const f = parked();
    f.engine.setTilingEnabled(false);
    f.calls.length = 0;
    f.applied.length = 0;

    f.add(3);
    f.flush();
    expect(f.applied).toEqual([]);
    expect(f.calls.filter(call => call.startsWith('moveTo:'))).toEqual([]);
  });

  it('refuses commands while off, so a reload cannot half-apply', () => {
    const f = parked();
    f.engine.setTilingEnabled(false);
    expect(f.engine.run([{type: 'kill'}], 1)).toBe('tiling is switched off');
    expect(f.calls.filter(call => call.startsWith('kill:'))).toEqual([]);
  });

  it('re-adopts every live window, re-applies the settings and re-grabs when switched back on', () => {
    const f = parked();
    f.engine.setTilingEnabled(false);
    f.add(3);
    f.calls.length = 0;

    f.engine.setTilingEnabled(true);
    expect(f.engine.tilingEnabled).toBe(true);
    expect(f.calls).toContain('settings.apply');
    expect(f.calls).toContain(`grab:${f.engine.config.modes.get('default')!.bindings.length}`);
    expect(f.visible).toBe(true);
    // Every window the port lists is in the tree again, including the one that opened while it was off.
    for (const id of [1, 2, 3]) expect(f.tree().location(id)).not.toBeNull();
  });

  it('re-applies the settings before the rebuild writes any window workspace', () => {
    // GNOME is back to live + attic BEFORE the rebuild decides, per window, which of the two it belongs
    // on: `_parkOrShow` names ATTIC_WORKSPACE by index, and that index exists only once `settings.apply`
    // has forced num-workspaces back to two. `restoreAll()` on the way off gave the user's own count
    // back, so between the two calls the attic is not there at all.
    const f = parked();
    f.engine.setTilingEnabled(false);
    f.calls.length = 0;
    f.engine.setTilingEnabled(true);
    const firstMove = f.calls.findIndex(call => call.startsWith('moveTo:'));
    expect(firstMove).toBeGreaterThanOrEqual(0);
    expect(f.calls.indexOf('settings.apply')).toBeGreaterThanOrEqual(0);
    expect(f.calls.indexOf('settings.apply')).toBeLessThan(firstMove);
  });

  it('returns a tree-excluded window from the attic when switched back on, not only the tiled ones', () => {
    // The mirror of `_flushAttic` on the way back ON, and the founding bug of this project in the one
    // direction the off switch made routine.
    //
    // While tiling is off the user has their own GNOME workspaces back, so index 1 is an ordinary
    // workspace of theirs and a window can be sitting on it when the toggle goes back on -- the user put
    // it there, or Mutter did when `restoreAll` changed the count. `settings.apply` then makes index 1 the
    // attic again, a workspace Mutter refuses to render, and the rebuild rescues every window that ENTERS
    // THE TREE because `_syncWindow` calls `_parkOrShow` for it. A minimized, sticky or skip-taskbar
    // window takes the `excludedFromTree` branch, which calls `tree.remove` and nothing else: nothing
    // moves it, and nothing is left that would. Audible and impossible to find.
    //
    // FOUR windows, and the three beside the subject are what make this test fail for one reason only:
    //   - 2 is an ordinary tiled window in the SAME position (index 1 at the moment of ON). It is rescued
    //     today, by `_parkOrShow`, so without it this could not tell "the rescue is missing for excluded
    //     windows" from "the rescue is missing for everything".
    //   - 4 is skip-taskbar and already LIVE, so a blanket "move every excluded window" would pass the
    //     subject and fail here: the guard that asks only about a window not already live is pinned too.
    //   - 1 is `parked()`'s own control, live and in the tree throughout.
    const f = parked();
    f.add(3, {skipTaskbar: true});
    f.add(4, {skipTaskbar: true});
    f.flush();
    // Both are evicted from the tree, which is the whole difficulty: a tree walk cannot see either.
    expect(f.tree().location(3)).toBeNull();
    expect(f.tree().location(4)).toBeNull();

    f.engine.setTilingEnabled(false);
    // The engine is paused, so these native reports change nothing -- exactly like the user moving a
    // window onto their own second workspace with the extension switched off.
    f.change(2, {workspace: ATTIC_WORKSPACE}, 'workspace');
    f.change(3, {workspace: ATTIC_WORKSPACE}, 'workspace');
    expect(f.windows.get(4)!.workspace).toBe(LIVE_WORKSPACE);
    f.calls.length = 0;

    f.engine.setTilingEnabled(true);
    // The control first, so one RED run shows both halves: the ordinary window IS rescued today.
    expect(f.calls).toContain(`moveTo:2:${LIVE_WORKSPACE}`);
    expect(f.windows.get(2)!.workspace).toBe(LIVE_WORKSPACE);
    // The window that needs nothing done to it is left alone, as `_flushAttic`'s own skip does.
    expect(f.calls).not.toContain(`moveTo:4:${LIVE_WORKSPACE}`);
    // And the subject, which is the one that fails.
    expect(f.calls).toContain(`moveTo:3:${LIVE_WORKSPACE}`);
    expect(f.windows.get(3)!.workspace).toBe(LIVE_WORKSPACE);
    // Still out of the tree: it is rescued as the excluded window it is, not by being tiled.
    expect(f.tree().location(3)).toBeNull();
  });

  it('warns rather than desyncing when the excluded window refuses to leave the attic', () => {
    // The twin of the OFF-path refusal test above, for the ON path's rescue. Same sentence deliberately:
    // it is the same event, and the user reading the journal does not care which switch direction found it.
    const f = parked();
    f.add(3, {skipTaskbar: true});
    f.flush();
    f.engine.setTilingEnabled(false);
    f.change(3, {workspace: ATTIC_WORKSPACE}, 'workspace');
    f.refuseMove(3);
    f.calls.length = 0;

    f.engine.setTilingEnabled(true);
    expect(f.calls).toContain('warn:could not return window 3 from the attic; it may stay hidden');
    expect(f.windows.get(3)!.workspace).toBe(ATTIC_WORKSPACE);
  });

  it('is idempotent: switching off twice flushes once', () => {
    const f = parked();
    f.engine.setTilingEnabled(false);
    f.calls.length = 0;
    f.engine.setTilingEnabled(false);
    expect(f.calls).toEqual([]);
  });

  it('unlocking does not turn tiling back on when the toggle is off', () => {
    // Review Focus 3. onUnlocked() re-grabs and re-shows unconditionally today, so without this the lock
    // screen would be a second, invisible on switch.
    const f = parked();
    f.engine.setTilingEnabled(false);
    f.engine.onLocked();
    f.calls.length = 0;

    f.engine.onUnlocked();
    expect(f.engine.tilingEnabled).toBe(false);
    expect(f.ports.keys.grabbedCount).toBe(0);
    expect(f.visible).toBe(false);
    expect(f.calls.filter(call => call.startsWith('grab:'))).toEqual([]);
  });

  it('switching on over a locked screen rebuilds but grabs nothing and shows no pills', () => {
    const f = parked();
    f.engine.setTilingEnabled(false);
    f.engine.onLocked();
    f.engine.setTilingEnabled(true);
    expect(f.engine.tilingEnabled).toBe(true);
    expect(f.ports.keys.grabbedCount).toBe(0);
    expect(f.visible).toBe(false);
    expect(f.tree().location(1)).not.toBeNull();
    // And the ordinary unlock then arms everything, exactly as it does after a plain lock.
    f.engine.onUnlocked();
    expect(f.ports.keys.grabbedCount).toBeGreaterThan(0);
    expect(f.visible).toBe(true);
  });

  it('refuses the launcher while off, opening nothing', () => {
    // The sharpest of the refusals, and the reason `run()` guards rather than relying on the paused
    // `commit()`: `_runOne`'s launcher case calls `launcher.open` DIRECTLY, outside any commit, so a
    // Mod4+d arriving by D-Bus while tiling is off would otherwise put a modal grab on screen with no
    // engine behind it. There is deliberately no launcher-specific message -- `run()` refuses before
    // `_runOne` is reached, so a second refusal inside that case would be unreachable code.
    const f = parked();
    f.engine.setTilingEnabled(false);
    expect(f.engine.run([{type: 'launcher', term: null}], 1)).toBe('tiling is switched off');
    expect(f.ports.launcher.isOpen()).toBe(false);
    expect(f.calls).not.toContain('launcher.open');
  });

  it('forgets a Task 1 floating-carry record on the way back on, so the next carry is not suppressed', () => {
    // The one line this task adds beyond the brief: `_carriedFloating.clear()` in the ON commit.
    //
    // A carry record suppresses ONE repeat translation of a floating frame while the compositor is still
    // reporting the output the frame was carried away FROM. For a client that refuses the rect -- the
    // README's `stubborn` clients -- that report never changes, so the record only ends when the window is
    // carried elsewhere or closed (Task 1 wrote that residual down). A pause can last an hour. Carrying
    // the record across it would suppress the user's next genuine `move container to output` back to that
    // same display: a floating window left drawn on the screen it was told to leave, which is the defect
    // Task 1 exists to fix. A fresh enable starts with no records, and ON is a fresh enable.
    //
    // THREE outputs of DIFFERENT SIZE, following this describe's older sibling in commands.test.ts: with
    // two, "the focused output" and "the output showing the destination workspace" coincide, and with
    // equal areas a proportional translation and a plain origin offset coincide.
    const WIDE = {x: 0, y: 0, width: 1920, height: 1080};
    const NARROW = {x: 1920, y: 0, width: 1280, height: 720};
    const TALL = {x: 3200, y: 0, width: 1024, height: 1280};
    const f = fakeEngine('bindsym Mod4+q kill', {
      monitors: [{id: 0, index: 0, area: WIDE}, {id: 1, index: 1, area: NARROW}, {id: 2, index: 2, area: TALL}],
      primary: 0,
      workspaceCount: 10,
    });
    f.engine.start();
    f.mapOn(0, 1, {kind: 'floating', rect: {x: 1340, y: 490, width: 200, height: 100}});
    f.flush();

    // The carry is commanded and the client refuses the frame, so the compositor goes on reporting output
    // 0 and the record stays live -- the one state in which this matters.
    f.refuseGeometry = true;
    expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 1))
      .toBe('move container to output');
    f.refuseGeometry = false;
    expect(f.windows.get(1)!.monitor).toBe(0);

    f.engine.setTilingEnabled(false);
    f.engine.setTilingEnabled(true);
    expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: true});
    f.applied.length = 0;

    expect(f.engine.run([{type: 'move_container_to_output', target: 'right'}], 2))
      .toBe('move container to output');
    expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});
    // Centre (1440, 540) is 75% and 50% across WIDE; the same fractions of NARROW are 960 and 360, less
    // half the width and height -- the identical arithmetic commands.test.ts asserts for this carry.
    expect(f.appliedRects().get(1)).toEqual({x: 2780, y: 310, width: 200, height: 100});
  });

  it('does nothing at all before start()', () => {
    const f = fakeEngine();
    f.engine.setTilingEnabled(false);
    expect(f.engine.tilingEnabled).toBe(true);
    expect(f.calls).toEqual([]);
  });
});
