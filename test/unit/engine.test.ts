import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {Binding, Config} from '../../src/config/model';
import {LIVE_WORKSPACE} from '../../src/runtime/model';
import {leaves, type WindowId} from '../../src/tree/node';
import {fakeEngine as fakePorts, outputsTopology} from './engine/fakeEngine';

const referenceText = readFileSync(new URL('./fixtures/reference.i3config', import.meta.url), 'utf8');

const binding = (config: Config, mode: string, accel: string): Binding =>
  config.modes.get(mode)!.bindings.find(b => b.accel === accel)!;

/** The window ids tiled on one i3 workspace, read from the tree rather than from a rendered plan. */
const leafWindows = (f: ReturnType<typeof fakePorts>, workspace: number): WindowId[] =>
  [...leaves(f.tree().root(workspace))].map(leaf => leaf.window);

describe('Engine', () => {
  it('start() applies settings, grabs the default mode and sets colours', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    // 'decorations' trails every commit — see the `decorations` describe block in lifecycle.test.ts.
    expect(f.calls).toEqual(['settings.apply', 'grab:65', 'mode:null', 'colors', 'decorations.colors', 'launcher.colors', 'decorations']);
    expect(e.mode).toBe('default');
    expect(e.state()).toMatchObject({mode: 'default', activeWorkspace: 0, workspaceCount: 10, grabbed: 65, configSource: 'file', errors: 0, warnings: 0});
  });

  it('workspace bindings switch and move; names and numbers resolve', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    f.calls.length = 0;
    e.onBinding(binding(e.config, 'default', '<Super>3'), 1);
    // `workspace N` really switches now (Task 7): the focused output's own visible workspace moves to
    // 2 outright, with no window on it yet, so the only port call is the relayout every commit trails.
    expect(f.calls).toEqual(['decorations']);
    expect(e.state().activeWorkspace).toBe(2);

    // A new window always adopts onto the active workspace, which is now 2 -- and visible, so it lands
    // on LIVE, not the attic.
    f.add(1); f.flush();
    expect(f.calls.filter(c => c !== 'decorations')).toEqual(['moveTo:1:0']);

    f.calls.length = 0;
    e.onBinding(binding(e.config, 'default', '<Super><Shift>0'), 2);
    // Workspace 9 (i3 "number 10") is not visible on any output, so the move parks window 1 in the
    // attic -- see F1's fix to `_moveReconfigured`.
    expect(f.calls.filter(c => c !== 'decorations')).toEqual(['moveTo:1:1']);

    f.calls.length = 0;
    expect(e.run([{type: 'workspace', target: {kind: 'name', name: '10:X'}}], 3)).toBe('workspace 10');
    // Workspace 9 just became visible again, bringing window 1 back out of the attic and re-focusing it.
    expect(f.calls.filter(c => c !== 'decorations')).toEqual(['moveTo:1:0', 'focus:1']);
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 11, name: '11'}}], 7)).toBe('workspace: no such workspace');

    // "already active"/"already there" resolve against the tree's own active workspace (spec 2.6),
    // which `workspace N` now really moves -- no poking `tree.visible` needed to exercise this.
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 3, name: '3'}}], 4)).toBe('workspace 3');
    expect(e.state().activeWorkspace).toBe(2);
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 3, name: '3'}}], 5)).toBe('workspace: already active');
    expect(e.run([{type: 'move_to_workspace', target: {kind: 'number', number: 3, name: '3'}}], 8)).toBe('move container to workspace: already there');
    // `next`/`prev` cycle the workspaces that exist and wrap (i3's own semantics), so this stretch had
    // to be rewritten: it used to assert the numeric neighbours 2 and 3. Window 1 is parked on workspace
    // 9 (i3 "10") by the move above and nothing else is open, so the cycle is {2, 9} -- `prev` from the
    // lowest member wraps up to the highest, and `next` from it steps straight across the eight empty
    // workspaces in between. The old rule would have answered 'workspace 2' and 'workspace 4' here.
    expect(e.run([{type: 'workspace', target: {kind: 'prev'}}], 6)).toBe('workspace 10');
    expect(e.state().activeWorkspace).toBe(9);
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 3, name: '3'}}], 9)).toBe('workspace 3');
    // `next` resolves against the tree's own active workspace too; `prev`'s own coverage above does not
    // exercise `next`'s branch of `_workspaceIndex`.
    expect(e.run([{type: 'workspace', target: {kind: 'next'}}], 10)).toBe('workspace 10');
    expect(e.state().activeWorkspace).toBe(9);
  });

  it('moves the tree\'s own active workspace for real, not just GNOME\'s index', () => {
    // Before Task 7, `workspace N` moved only GNOME's raw index -- immediately reverted by the attic
    // guard -- so the tree's own active workspace never moved, and a following `move_to_workspace`
    // comparing its target against it could never see "already there" for a workspace `workspace N`
    // had just switched to. It drives `Tree.showWorkspace` for real now, so the comparison is
    // meaningful: window 1 -- still on workspace 0, since switching moves no window -- is untouched,
    // but the active workspace itself really did move.
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    f.add(1); f.flush();
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 3, name: '3'}}], 1)).toBe('workspace 3');
    expect(e.state().activeWorkspace).toBe(2); // the tree's own active workspace really moved
    expect(f.tree().location(1)?.workspace).toBe(0); // window 1 itself never moved
    expect(e.run([{type: 'move_to_workspace', target: {kind: 'number', number: 3, name: '3'}}], 2))
      .toBe('move container to workspace: already there');
  });

  it('modes swap the grabbed set and show the label; Escape returns to default', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    f.calls.length = 0;
    e.onBinding(binding(e.config, 'default', '<Super>r'), 1);
    expect(e.mode).toBe('resize');
    expect(f.calls).toEqual(['grab:11', 'mode:resize']);
    expect(f.grabbedAccels()).toContain('j');
    e.onBinding(binding(e.config, 'resize', 'Escape'), 2);
    expect(e.mode).toBe('default');
    expect(f.calls.slice(2)).toEqual(['grab:65', 'mode:null']);
    expect(e.run([{type: 'mode', name: 'nope'}], 3)).toBe('mode "nope" is not defined');
    expect(e.mode).toBe('default');
  });

  it('lock releases grabs and resets the mode; unlock re-grabs the default mode', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    e.onBinding(binding(e.config, 'default', '<Super>r'), 1);
    f.calls.length = 0;
    e.onLocked();
    expect(e.mode).toBe('default');
    expect(f.calls).toEqual(['launcher.close', 'mode:null', 'ungrabAll']);
    expect(f.ports.keys.grabbedCount).toBe(0);
    e.onUnlocked();
    expect(f.calls.slice(3)).toEqual(['grab:65', 'decorations']);
  });

  it('exec, kill and fullscreen reach their selected-id ports', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    f.calls.length = 0;
    f.add(1);
    e.onBinding(binding(e.config, 'default', '<Super>Return'), 1);
    e.onBinding(binding(e.config, 'default', '<Super><Shift>q'), 2);
    e.onBinding(binding(e.config, 'default', '<Super>f'), 3);
    // 'moveTo:1:0' is F2's adoption-time sync: window 1 lands on workspace 0, which is visible, so
    // it is confirmed onto LIVE even though it was already there. The extra 'decorations' is the
    // one that move's own queued workspace-changed event triggers, same as any other move.
    expect(f.calls).toEqual(['moveTo:1:0', 'decorations', 'decorations', 'exec:kitty', 'kill:1', 'fullscreen:1:toggle']);
    expect(e.run([{type: 'nop', text: ''}, {type: 'unknown', text: 'frob'}], 5)).toBe('nop; unknown command: frob');
  });

  it('reload keeps the running config when the new one is rejected', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    f.calls.length = 0;
    f.setNextLoad(f.load('bindsym Mod4+q kill\nbogus 1'));
    expect(e.run([{type: 'reload'}], 1)).toBe('reload: config rejected, keeping previous');
    expect(f.calls).toEqual([
      'launcher.close',
      'warn:config error line 2: unknown directive bogus',
      'notify:i3-shell: config rejected|line 2: unknown directive bogus',
    ]);
    expect(e.config.modes.get('default')!.bindings).toHaveLength(65);
    expect(e.state().grabbed).toBe(65);
  });

  it('reload applies a valid new config and reports warnings once', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    f.calls.length = 0;
    f.setNextLoad(f.load('bindsym Mod4+q kill\nexec --no-startup-id nm-applet'));
    expect(e.run([{type: 'reload'}], 1)).toBe('reloaded');
    expect(f.calls).toEqual([
      'launcher.close',
      'warn:config warning line 2: exec is not supported by i3-shell yet; line skipped',
      'settings.apply', 'grab:1', 'mode:null', 'colors', 'decorations.colors', 'launcher.colors',
      'notify:i3-shell|1 config warning(s) — see the shell log',
      'decorations',
    ]);
    expect(e.state()).toMatchObject({grabbed: 1, warnings: 1, errors: 0});
  });

  it('a cache or fallback source is announced', () => {
    const f = fakePorts(referenceText);
    f.setNextLoad({...f.load(referenceText), source: 'fallback'});
    const e = f.engine;
    e.start();
    // 'decorations' trails every commit, so the notification is second-to-last.
    expect(f.calls.slice(-2)).toEqual(['notify:i3-shell|using the built-in fallback config', 'decorations']);
  });

  it('stop() releases grabs and restores GNOME settings', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    f.calls.length = 0;
    e.stop();
    expect(f.calls).toEqual(['ungrabAll', 'settings.restore']);
  });

  it('lays out only the visible workspace of each output', () => {
    // Two outputs, ten workspaces. The old loop laid out twenty roots; two are visible.
    const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
    const e = f.engine;
    e.start();
    f.mapOn(0, 1);
    f.mapOn(1, 2);
    // One window on each output's own visible workspace, which is what makes "each output" meaningful.
    expect(f.tree().location(1)).toMatchObject({output: 0, workspace: 0});
    expect(f.tree().location(2)).toMatchObject({output: 1, workspace: 1});
    const laid = f.appliedRects();
    expect([...laid.keys()].sort()).toEqual([1, 2]);
  });

  it('derives a pill’s occupancy from the tree, not from the window’s GNOME workspace', () => {
    // Every window's GNOME workspace is 0 under the attic; occupancy must still follow the tree.
    const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
    const e = f.engine;
    e.start();
    f.mapOn(1, 1);   // mapped while output 1, showing workspace 1, is the focused output
    expect(e.state().pills[1]!.occupied).toBe(true);
    expect(e.state().pills[0]!.occupied).toBe(false);
  });

  it('reports the focused output', () => {
    const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
    const e = f.engine;
    e.start();
    expect(e.state().focusedOutput).toBe(0);
  });

  /**
   * Task 23, D7. The two halves of adoption, and the whole point is that they disagree:
   *
   * - A window Mutter maps while the session is running joins the FOCUSED output's workspace, i3
   *   semantics, whatever monitor the compositor chose for it.
   * - A window the engine adopts because it is starting up (or being re-enabled, or restarting) keeps
   *   the workspace of the monitor it is already on; those windows predate the tree, and pulling them
   *   onto one workspace would collapse a multi-monitor desktop at every enable.
   *
   * Both fixtures below therefore show DIFFERENT workspaces on the two outputs (output 0 shows
   * workspace 0, output 1 shows workspace 1) and point the window's `monitor` at the output that is
   * NOT focused, so the two candidate answers are different numbers. A topology where the focused
   * output's workspace were also the mapped monitor's would pass either way.
   */
  describe('Task 23, D7: adoption', () => {
    it('maps a live window onto the focused output’s workspace, not the monitor Mutter chose', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      expect(f.tree().visible.get(0)).toBe(0);
      expect(f.tree().visible.get(1)).toBe(1);
      expect(e.run([{type: 'focus_output', target: 'right'}], 1)).toBe('focus output');
      expect(f.tree().focusedOutput).toBe(1);

      // Mutter maps it on output 0 -- the display the user is not looking at. This is the Steam-on-the-
      // television report: before this it was adopted onto output 0's workspace 0 while focus stayed on
      // output 1's empty workspace 1, so the user typed into a screen they were not watching.
      f.add(7, {monitor: 0}); f.flush();
      expect(f.tree().location(7)).toEqual({workspace: 1, output: 1, floating: false});
      // Workspace 1 is on screen, so the native side is LIVE, not the attic.
      expect(f.windows.get(7)!.workspace).toBe(LIVE_WORKSPACE);
    });

    it('keeps each pre-existing window on its own monitor’s workspace when the engine starts', () => {
      // Spec 2.6: the pre-enable workspace is unrecoverable once num-workspaces drops to 2, but the
      // output is observable and is what the user sees. Focus is on the primary (output 0) for the whole
      // of this adoption, so collapsing onto the focused output would put all three on workspace 0.
      const f = fakePorts(referenceText, {
        monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10,
        existingWindows: [{id: 5, workspace: 0, monitor: 1}, {id: 6, workspace: 0, monitor: 0},
          {id: 7, workspace: 0, monitor: 1}],
      });
      const e = f.engine;
      e.start();
      expect(f.tree().location(5)).toEqual({workspace: 1, output: 1, floating: false});
      expect(f.tree().location(6)).toEqual({workspace: 0, output: 0, floating: false});
      expect(f.tree().location(7)).toEqual({workspace: 1, output: 1, floating: false});
      expect([...leafWindows(f, 0)]).toEqual([6]);
      expect([...leafWindows(f, 1)].sort()).toEqual([5, 7]);
    });

    it('re-adopts per monitor after `restart` rebuilds the tree', () => {
      // `restart` nulls the tree, so its next commit re-adopts every live window exactly as enable does.
      // Without that, a restart with focus on output 1 would drag output 0's windows across.
      const f = fakePorts(referenceText, {
        monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10,
        existingWindows: [{id: 5, workspace: 0, monitor: 0}, {id: 6, workspace: 0, monitor: 1}],
      });
      const e = f.engine;
      e.start();
      // Focus lands on output 1 because the startup pass restores a selection per workspace and the
      // last one it touches is output 1's; asserted rather than assumed, since the whole test turns on
      // output 0's window NOT following the focused output across the rebuild.
      expect(f.tree().focusedOutput).toBe(1);
      expect(e.run([{type: 'restart'}], 2)).toBe('restarted');
      expect(f.tree().location(5)).toEqual({workspace: 0, output: 0, floating: false});
      expect(f.tree().location(6)).toEqual({workspace: 1, output: 1, floating: false});
    });
  });

  // Task 3, the transient ruling. i3 4.25.1 uses WM_TRANSIENT_FOR for two things only -- it floats the
  // window, and it answers `popup_during_fullscreen smart` -- and places a transient on the FOCUSED
  // workspace like any other new window. These tests exist so that a future patch which "makes dialogs
  // follow their parent" fails loudly instead of silently moving a modal grab onto a display nobody is
  // looking at. See the ruling in docs/superpowers/plans/2026-10-06-cleanup-and-toggle.md, Task 3.
  //
  // The engine cannot see `transient_for` (the adapter reduces it to kind: 'floating'), so "a dialog"
  // here is a floating window whose Mutter monitor is its parent's. Fixture: the parent is on the
  // NON-focused output and the dialog's `monitor` names that same output, so "follow the parent" and
  // "follow Mutter's monitor" both answer workspace 1 while "follow the focus" answers workspace 0.
  describe('a transient opens where the user is, the way i3 places one', () => {
    const twoOutputs = () => fakePorts(referenceText,
      {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});

    it('a dialog lands on the focused output workspace, not on its parent’s', () => {
      const f = twoOutputs();
      f.engine.start();
      f.mapOn(1, 1);   // the parent, on output 1's workspace 1
      expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: false});
      // The user goes back to the primary, then the parent opens a dialog beside itself.
      expect(f.engine.run([{type: 'focus_output', target: 'left'}], 1)).toBe('focus output');
      expect(f.tree().focusedOutput).toBe(0);
      f.add(2, {monitor: 1, kind: 'floating'}); f.flush();

      expect(f.tree().location(2)).toEqual({workspace: 0, output: 0, floating: true});
      expect(f.engine.state().focusedOutput).toBe(0);
    });

    it('a dialog whose parent is not in the tree still lands on the focused output workspace', () => {
      // A parent that is sticky (or skip-taskbar, or closed between map and sync) has no tree location to
      // follow. Nothing consults the parent today; this makes a parent-following patch fail rather than
      // throw or park the dialog in the attic.
      const f = twoOutputs();
      f.engine.start();
      f.mapOn(1, 1, {sticky: true});
      expect(f.tree().location(1)).toBeNull();   // sticky is excluded from the tree from birth
      expect(f.engine.run([{type: 'focus_output', target: 'left'}], 1)).toBe('focus output');
      f.add(2, {monitor: 1, kind: 'floating'}); f.flush();

      expect(f.tree().location(2)).toEqual({workspace: 0, output: 0, floating: true});
    });
  });

  describe('showOnOutputForTest (the attic swap)', () => {
    it('parks the outgoing workspace’s windows and un-parks the incoming ones', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.add(1, {workspace: 0, monitor: 0});   // lands on i3-workspace 0, visible on output 0
      f.add(2, {workspace: 0, monitor: 0});
      e.showOnOutputForTest(0, 4);
      expect(f.windows.get(1)!.workspace).toBe(1);   // ATTIC
      expect(f.windows.get(2)!.workspace).toBe(1);
      e.showOnOutputForTest(0, 0);
      expect(f.windows.get(1)!.workspace).toBe(0);   // LIVE
      expect(f.windows.get(2)!.workspace).toBe(0);
    });

    it('does nothing when the incoming workspace is the one already shown', () => {
      // Review Focus 2: the naive swap would park and immediately un-park, flashing the screen.
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.add(1, {workspace: 0, monitor: 0});
      const before = f.calls.filter(c => c.startsWith('moveTo:')).length;
      e.showOnOutputForTest(0, 0);
      expect(f.calls.filter(c => c.startsWith('moveTo:')).length).toBe(before);
    });

    it('warns and continues when Mutter refuses to move a window', () => {
      // Review Focus 1: a half-swapped output is recoverable; an exception mid-swap is not.
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.add(1, {workspace: 0, monitor: 0});
      f.add(2, {workspace: 0, monitor: 0});
      f.refuseMove(1);
      expect(() => e.showOnOutputForTest(0, 4)).not.toThrow();
      expect(f.windows.get(2)!.workspace).toBe(1);   // ATTIC despite window 1's refusal
      expect(f.calls.filter(c => c.startsWith('warn:')).join('\n')).toMatch(/could not park window 1/);
    });

    it('forces the active GNOME workspace back to live and warns', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.calls.length = 0;
      f.setActiveIndex(1);
      e.onWorkspacesChanged();
      expect(f.calls).toContain('activate:0');
      expect(f.calls.filter(c => c.startsWith('warn:')).join('\n')).toMatch(/active workspace left live/);
    });

    // Task 19, D2: the guard's own `activate()` re-emits `active-workspace-changed` before Mutter
    // reports the new index, so the handler re-entered itself unboundedly -- 3376 corrections in four
    // seconds at every login, ending in repeated `JS ERROR: too much recursion` inside the compositor.
    // It failed closed, which is why nothing else caught it, but it also meant the touchpad-gesture
    // cover this guard exists to provide never worked.
    it('corrects a workspace gesture exactly once, however Mutter re-emits the signal', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.staleActivate = true;
      f.setActiveIndex(1);
      f.calls.length = 0;

      e.onWorkspacesChanged();

      expect(f.calls.filter(call => call === 'activate:0')).toEqual(['activate:0']);
      expect(f.calls.filter(call => call.startsWith('warn:active workspace left live')))
        .toEqual(['warn:active workspace left live; switching back']);
    });

    it('still corrects the next genuine gesture after a re-entrant correction', () => {
      // The guard must bound the self-inflicted signal without going deaf: a second gesture, arriving
      // after the first correction has returned, has to be corrected too.
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.staleActivate = true;
      f.setActiveIndex(1);
      e.onWorkspacesChanged();
      f.calls.length = 0;

      f.setActiveIndex(1);
      e.onWorkspacesChanged();

      expect(f.calls.filter(call => call === 'activate:0')).toEqual(['activate:0']);
    });

    // Task 19 round 1, I1: the re-entrancy flag is set around a call that crosses the GJS boundary three
    // times. Reset it sequentially instead of in a `finally` and one throw from Mutter latches it `true`
    // for the rest of the session: `onWorkspacesChanged` goes permanently deaf, silently removing both
    // the touchpad-gesture cover this guard exists to be and the `n-workspaces` re-apply beside it, with
    // no warn to say so. The whole shipped suite was green against that.
    it('does not go deaf for the session when Mutter throws out of activate', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.activateThrows = true;
      f.setActiveIndex(1);
      expect(() => e.onWorkspacesChanged()).toThrow(/GJS boundary/);

      f.activateThrows = false;
      f.calls.length = 0;
      e.onWorkspacesChanged();

      expect(f.calls.filter(call => call === 'activate:0')).toEqual(['activate:0']);
    });

    it('warns again when the forced switch back to live itself is refused', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.setActiveIndex(1);
      f.ports.workspaces.activate = () => false;
      f.calls.length = 0;
      e.onWorkspacesChanged();
      expect(f.calls.filter(c => c.startsWith('warn:'))).toEqual([
        'warn:active workspace left live; switching back',
        'warn:could not switch the active workspace back to live',
      ]);
    });

    it('ends the swap with the incoming workspace’s selection activated', () => {
      // What this asserts: the *final* state after the swap is the incoming workspace's own
      // selection, activated -- exactly what _activateSelection's trailing, always-last report
      // re-establishes (see the comment on _showOnOutput). It does NOT prove Mutter's replacement
      // pick (fired here, since window 2 is parked while it holds focus) never transiently runs
      // _selectWindow on some *other* workspace in between: that is a real, unverified residual a
      // synchronous fake cannot observe, since such a transient leaves no trace once the trailing
      // report re-settles the workspace this test can see. Task 17's native harness is what could
      // show whether Mutter actually produces such a report and, if so, what it does elsewhere.
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.add(1, {workspace: 0, monitor: 0});
      e.showOnOutputForTest(0, 4);
      f.add(2, {workspace: 0, monitor: 0});   // adopts onto workspace 4, now visible on output 0
      f.focus(2);
      f.calls.length = 0;
      e.showOnOutputForTest(0, 0);
      const activated = f.calls.filter(c => c.startsWith('focus:')).map(c => Number(c.split(':')[1]));
      expect(activated).toEqual([1]);
    });

    it('selects the incoming workspace’s root when it has no window, leaving native focus to Mutter’s pick until Task 13 (F3)', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.mapOn(0, 1);   // output 0's own window
      f.mapOn(1, 2);   // output 1's own window, unrelated to this swap
      f.focus(1);
      e.showOnOutputForTest(0, 5);   // workspace 5 has no window
      // The tree-side half of the fix: activeWorkspace, selection and pills all agree the incoming
      // workspace's own (empty) root is what output 0 shows now.
      expect(f.tree().selection(5)).toMatchObject({kind: 'tiled', con: {kind: 'split', children: []}});
      expect(e.state().pills[5]!.occupied).toBe(false);
      // The residual this fix does not (and per the ruling, must not) touch: _activateSelection never
      // runs its own confirming activate() when the incoming workspace is empty, so Mutter's own
      // replacement pick (fired when window 1, focused, is parked) is the last word on native focus
      // until Task 13 gives an empty output its own explicit focus (spec §4.1).
      expect(f.ports.windows.focused()).toBe(2);
    });

    it('refuses an unknown incoming workspace instead of bricking the tree (F4)', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.add(1, {workspace: 0, monitor: 0});
      expect(() => e.showOnOutputForTest(0, 99)).not.toThrow();
      expect(f.calls.filter(c => c.startsWith('warn:')).join('\n')).toMatch(/cannot show unknown workspace 99/);
      // Nothing moved, and the tree is still usable: still workspace 0, and later commits do not throw.
      expect(f.tree().visible.get(0)).toBe(0);
      f.add(2, {workspace: 0, monitor: 0});
      expect(() => e.state()).not.toThrow();
    });
  });

  describe('Task 8: focused vs visible, per output', () => {
    it('marks the workspace on the focused output focused, and the other output’s visible', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      const pills = e.state().pills;
      expect(pills[0]!.focused).toBe(true);
      expect(pills[0]!.visible).toBe(true);
      expect(pills[1]!.focused).toBe(false);
      expect(pills[1]!.visible).toBe(true);     // on screen, on the other output
      expect(pills[2]!.visible).toBe(false);
    });

    it('gives each output only its own workspaces’ pills', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      const byOutput = f.pillsByOutput;
      expect(byOutput.get(1)!.map(p => p.name)).toEqual(['2:II']);
      expect(byOutput.get(0)!.map(p => p.name)).toEqual(
        ['1:I', '3:III', '4:IV', '5:V', '6:VI', '7:VII', '8:VIII', '9:IX', '10:X']);
    });

    it('retains the last known per-output pills across a commit with no tree', () => {
      // F3: a commit that runs with no tree -- topology not ready yet, or momentarily gone mid-restart
      // -- must not blank the map the panel and every bar are currently showing with an empty one.
      // `restart` sets `_tree = null` inside a `commit()` that synchronously re-runs
      // `_layoutAndPublish()`; with the topology already unready at that moment (set below) the
      // tree-recreate branch is skipped and `_tree` stays null through the pill section -- the same
      // `f.setTopology(null)` + `restart` construction already used at commands.test.ts's and
      // lifecycle.test.ts's own restart-rejection tests, not a state fabricated for this test alone.
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      const before = new Map(f.pillsByOutput);
      expect(before.size).toBeGreaterThan(0);

      f.setTopology(null);
      expect(e.run([{type: 'restart'}], 0)).toBe('restarted');

      expect(f.pillsByOutput).toEqual(before);
    });
  });

  describe('Task 10: workspace N output', () => {
    it('honours a pinned workspace output', () => {
      const f = fakePorts('workspace 3 output DP-1\n', {
        monitors: [{id: 0, index: 0, connectors: ['HDMI-1']}, {id: 1, index: 1, connectors: ['DP-1']}],
        primary: 0, workspaceCount: 4,
      });
      f.engine.start();
      expect(f.tree().outputOf(2)).toBe(1);
    });

    it('warns with the config line when a pinned output is not attached, and falls back', () => {
      // A config written for another machine must still load: the pin is ignored, not fatal.
      const f = fakePorts('workspace 3 output VGA-9\n', {
        monitors: [{id: 0, index: 0, connectors: ['HDMI-1']}],
        primary: 0, workspaceCount: 4,
      });
      f.engine.start();
      expect(f.tree().outputOf(2)).toBe(0);
      expect(f.calls.filter(c => c.startsWith('warn:')).join('\n')).toMatch(/line 1.*VGA-9/);
    });

    it('resolves a connector name case-insensitively, in either direction', () => {
      const f = fakePorts('workspace 3 output dp-1\n', {
        monitors: [{id: 0, index: 0, connectors: ['HDMI-1']}, {id: 1, index: 1, connectors: ['DP-1']}],
        primary: 0, workspaceCount: 4,
      });
      f.engine.start();
      expect(f.tree().outputOf(2)).toBe(1);
    });

    it("accepts i3's list of outputs, skipping a name that is not live and matching primary by name", () => {
      const f = fakePorts('workspace 3 output nonexistent primary\n', {
        monitors: [{id: 0, index: 0, connectors: ['HDMI-1']}, {id: 1, index: 1, connectors: ['DP-1']}],
        primary: 0, workspaceCount: 4,
      });
      f.engine.start();
      expect(f.tree().outputOf(2)).toBe(0);
      expect(f.calls.filter(c => c.startsWith('warn:'))).toEqual([]);
    });

    // Fix round 1, F1: a pin must also apply to a workspace born later, by `Tree.reconfigure`'s growth
    // loop, not only to one born at `Tree` construction. Two paths reach that loop; both are tested.
    it('honours a pin for a workspace growth creates when a display attaches', () => {
      const f = fakePorts('workspace 2 output DP-1\n', {
        monitors: [{id: 0, index: 0, connectors: ['HDMI-1']}],
        primary: 0, workspaceCount: 1,
      });
      f.engine.start();
      expect(f.tree().workspaces.size).toBe(1); // one output, one workspace -- nothing to grow into yet

      // Two displays attach at once, so growth creates two workspaces, not one: with only one new
      // workspace, coverOutputs's own repair for the newly attached output happens to land in the same
      // place a correctly-honoured pin would, and a test could not tell "the pin worked" from "coverage
      // would have put it there anyway" (see topology.test.ts for the isolated version of this same
      // concern). Only workspace 2 (index 1) is pinned; workspace 3 (index 2) takes the unpinned
      // default and is what coverOutputs sweeps onto the other new output instead.
      f.setTopology(outputsTopology(
        [{id: 0, index: 0, connectors: ['HDMI-1']}, {id: 1, index: 1, connectors: ['DP-1']},
          {id: 2, index: 2, connectors: ['VGA-1']}], 0));
      f.engine.onMonitorsChanged();

      expect(f.tree().outputOf(1)).toBe(1);
    });

    it('honours a pin for a workspace growth creates when a config reload raises workspaceCount', () => {
      const f = fakePorts('bindsym Mod4+q kill', {
        monitors: [{id: 0, index: 0, connectors: ['HDMI-1']}, {id: 1, index: 1, connectors: ['DP-1']}],
        primary: 0, workspaceCount: 2,
      });
      f.engine.start();
      expect(f.tree().workspaces.size).toBe(2);

      const loaded = f.load('workspace 3 output DP-1\n');
      f.setNextLoad({...loaded, config: {...loaded.config!, workspaceCount: 3}});
      f.engine.run([{type: 'reload'}], 0);
      f.flush();

      expect(f.tree().outputOf(2)).toBe(1);
    });
  });

  // Task 12, rule 4: an output whose visible workspace is empty has no window to take focus, so sloppy
  // focus (rule 1) can never report it. The pointer crossing onto it is the only remaining evidence the
  // user is there -- the whole of the "$mod+d opens on the wrong screen" defect for an unoccupied output.
  describe('onPointerOutput (rule 4)', () => {
    it('takes the focused output from the pointer when that output’s workspace is empty', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.add(1, {workspace: 0, monitor: 0});
      e.onPointerOutput(1);
      expect(e.state().focusedOutput).toBe(1);
      expect(e.launcherAreaForTest()).toEqual(f.topology!.workAreas.get(1));
    });

    // Task 19, D4: this test used to assert the opposite -- that the pointer leaves a *populated*
    // output alone, on the reasoning that sloppy focus (rule 1) owns that case and two mechanisms
    // racing would flap. It does not own it: GNOME's sloppy focus reports a focus change only when the
    // pointer enters a *window*, so crossing onto another display's gaps, its bar or its background
    // produced nothing at all. Combined with the empty case being claimed, focus could only ever drain
    // onto whichever display showed an empty workspace and the pointer could never pull it back -- the
    // user's focused output reverting from the external display to the panel on its own. Neither
    // mechanism triggers the other, so there is no flap: a focus report moves the focused output to the
    // focused window's display (D5), and the pointer moves it to the display under the pointer.
    it('claims the display under the pointer even when its workspace has windows', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.add(1, {workspace: 0, monitor: 0});
      f.add(2, {workspace: 0, monitor: 1});
      e.onPointerOutput(1);
      expect(e.state().focusedOutput).toBe(1);
    });

    it('lets the pointer take focus back off an empty display, not only onto one', () => {
      // The drain, end to end: output 1 holds the windows, output 0 shows an empty workspace. Focus must
      // be able to make the round trip under the pointer alone.
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      f.add(2, {workspace: 0, monitor: 1});
      e.onPointerOutput(0);
      expect(e.state().focusedOutput).toBe(0);
      e.onPointerOutput(1);
      expect(e.state().focusedOutput).toBe(1);
      e.onPointerOutput(0);
      expect(e.state().focusedOutput).toBe(0);
    });

    it('keeps the focused output when the pointer’s output empties under it', () => {
      // Review Focus 4: the launcher must not jump screens because a window closed. Rule 4 fires while
      // output 1 is still empty; the window then arrives and leaves again, and neither transition may
      // touch focusedOutput a second time -- only a pointer crossing does that.
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      e.onPointerOutput(1);
      expect(e.state().focusedOutput).toBe(1);
      f.add(2, {workspace: 0, monitor: 1});
      f.remove(2);
      expect(e.state().focusedOutput).toBe(1);
    });

    // Fix round 1, folded item 1: `focus_follows_mouse` gates rule 4 too. The "takes the focused
    // output..." test above already covers the default (`yes`, i3's own default); this covers `no`.
    it('does not move the focused output when focus_follows_mouse is off', () => {
      const f = fakePorts('focus_follows_mouse no\n',
        {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      e.onPointerOutput(1);
      expect(e.state().focusedOutput).toBe(0);
    });

    // Fix round 1, folded item 4: consistent with the `launcher` command, which already refuses while
    // locked. Pointer motion over a lock screen must not reassign the focused output underneath it.
    it('does not move the focused output while the session is locked', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      e.onLocked();
      e.onPointerOutput(1);
      expect(e.state().focusedOutput).toBe(0);
    });
  });

  // Fix round 1, folded item 2: `onPointerMonitorIndex` is the only production entry point (extension.ts
  // calls it, nothing calls `onPointerOutput` directly outside tests), and every other test in this file
  // uses `{id: n, index: n}` monitors, so a swapped `m.index`/`m.id` in its translation is invisible to
  // them. `{id: 7, index: 1}` makes the two numbers different on purpose.
  describe('onPointerMonitorIndex', () => {
    it('translates Mutter’s own monitor index to this project’s MonitorId before touching the tree', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 7, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      e.onPointerMonitorIndex(1); // Mutter's index 1 -- this project's MonitorId 7, not 1
      expect(e.state().focusedOutput).toBe(7);
    });
  });

  // Fix round 1, C1: `_launcherOpen` (a flag the engine set on the `launcher` command and cleared only
  // where it itself called `close()`) could never see the launcher closing itself -- seven sites in
  // src/shell/launcher.ts do that with no call back into the engine at all. Deleted in favour of asking
  // `ports.launcher.isOpen()` live. `warpToFocusedOutputForTest` is the test-only entry point for
  // `_warpToFocusedOutput`, which (per the controller's ruling) has no production caller until Task 13.
  describe('_warpToFocusedOutput and the launcher’s grab', () => {
    it('suppresses the warp while the launcher holds its grab', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      e.run([{type: 'launcher', term: null}], 0);
      e.warpToFocusedOutputForTest();
      expect(f.pointer.warps()).toEqual([]);
    });

    it('does not stay suppressed once the launcher closes itself, unseen by the engine', () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      e.run([{type: 'launcher', term: null}], 0);
      f.launcherClosedItself(); // a dismiss, a launch, a toggling second open -- the engine hears none of it
      e.warpToFocusedOutputForTest();
      expect(f.pointer.warps().length).toBe(1);
    });
  });

  /**
   * Task 20, D6. A floating window dragged onto another display belongs to that display's workspace,
   * so `floating disable` tiles it there. Before this, `Tree.setFloating(false)` re-inserted into
   * `location.workspace` -- the workspace the window came from, which lives on the output it came from
   * -- so the native A23 walk saw the secondary output's root stay empty.
   *
   * Every fixture here gives the two outputs DIFFERENT visible workspaces (output 0 shows workspace 0,
   * output 1 shows workspace 1) and asserts the window lands on the destination's, not its own: a
   * topology where both outputs showed the same workspace would pass with or without the fix.
   */
  describe('Task 20, D6: a floating window’s workspace follows the output it sits on', () => {
    /** Two outputs showing two different workspaces, one tiled window on the primary's. */
    const twoOutputs = () => {
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      f.engine.start();
      // The fixture trap this guards against: if output 1 showed workspace 0 too, the re-home would be
      // indistinguishable from the old "put it back where it was".
      expect(f.tree().visible.get(0)).toBe(0);
      expect(f.tree().visible.get(1)).toBe(1);
      return f;
    };

    /** The drag itself: Mutter reports the floating frame on `monitor`, and a frame event follows. */
    const dragTo = (f: ReturnType<typeof fakePorts>, id: number, monitor: number, x: number) => {
      f.change(id, {monitor, rect: {x, y: 40, width: 400, height: 300}}, 'frame');
      f.flush();
    };

    it('tiles a window dragged onto the secondary output into that output’s workspace', () => {
      const f = twoOutputs();
      f.add(1, {workspace: 0, monitor: 0});
      f.focus(1);
      expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: false});

      f.engine.run([{type: 'floating', action: 'enable'}], 0);
      dragTo(f, 1, 1, 1040);
      // Continuous truth: GetTree already says output 1 while the window is still floating.
      expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: true});

      f.engine.run([{type: 'floating', action: 'disable'}], 0);
      expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: false});
      expect([...leafWindows(f, 1)]).toEqual([1]);
      expect([...leafWindows(f, 0)]).toEqual([]);
    });

    it('survives the round trip back to the primary output', () => {
      const f = twoOutputs();
      f.add(1, {workspace: 0, monitor: 0});
      f.focus(1);
      f.engine.run([{type: 'floating', action: 'enable'}], 0);
      dragTo(f, 1, 1, 1040);
      f.engine.run([{type: 'floating', action: 'disable'}], 0);
      expect(f.tree().location(1)).toEqual({workspace: 1, output: 1, floating: false});

      f.engine.run([{type: 'floating', action: 'enable'}], 0);
      dragTo(f, 1, 0, 40);
      expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: true});
      f.engine.run([{type: 'floating', action: 'disable'}], 0);
      expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: false});
      expect([...leafWindows(f, 0)]).toEqual([1]);
      expect([...leafWindows(f, 1)]).toEqual([]);
    });

    it('moves the focused output with the window, so the next command acts on it', () => {
      const f = twoOutputs();
      f.add(1, {workspace: 0, monitor: 0});
      f.focus(1);
      f.engine.run([{type: 'floating', action: 'enable'}], 0);
      dragTo(f, 1, 1, 1040);
      // Without this, `activeWorkspace` still names workspace 0 and the `floating disable` above would
      // find no selection at all -- which is how the native A23 walk reaches `floating disable`.
      expect(f.tree().focusedOutput).toBe(1);
      expect(f.tree().activeWorkspace).toBe(1);
      expect(f.tree().selection()).toEqual({kind: 'floating', window: 1});
    });

    it('keeps a re-homed window on the live GNOME workspace, out of the attic', () => {
      const f = twoOutputs();
      f.add(1, {workspace: 0, monitor: 0});
      f.focus(1);
      f.engine.run([{type: 'floating', action: 'enable'}], 0);
      // Mutter parked it for its own reasons while its i3 workspace was on screen; the re-home has to
      // assert the native side rather than assume it.
      f.windows.set(1, {...f.windows.get(1)!, workspace: 1});
      dragTo(f, 1, 1, 1040);
      expect(f.tree().location(1)).toMatchObject({workspace: 1, output: 1});
      expect(f.windows.get(1)!.workspace).toBe(0);
    });

    it('lets the workspace an evicted window left outrank the output it comes back on', () => {
      // `_adoptionWorkspace` deliberately prefers the workspace a minimised window left. The monitor it
      // comes back on changed while it had no workspace at all, so that is not a drag, and reading it as
      // one would delete the memory the eviction exists to keep.
      const f = twoOutputs();
      f.add(1, {kind: 'floating', workspace: 0, monitor: 0});
      expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: true});
      f.change(1, {minimized: true}, 'minimized');
      expect(f.tree().location(1)).toBeNull();
      // Task 23, D7: the user walks to the other display before un-minimising, so all three candidate
      // answers are different -- remembered (workspace 0), the focused output's workspace (1), and the
      // monitor Mutter now reports (output 1, also workspace 1). Without this the fixture would let the
      // remembered answer and the live-adoption answer coincide at workspace 0 and prove nothing.
      expect(f.engine.run([{type: 'focus_output', target: 'right'}], 0)).toBe('focus output');
      expect(f.tree().activeWorkspace).toBe(1);
      f.change(1, {minimized: false, monitor: 1}, 'minimized');
      expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: true});
    });

    it('leaves a floating window on a parked workspace alone when Mutter relocates it', () => {
      // Task 16's remembering: an unplug relocates the lost output's windows, which changes their
      // reported monitor without the user having dragged anything. A window the user cannot see has
      // not been dragged, so its workspace must not follow the relocation -- otherwise the displaced
      // workspace comes home on replug with its floating windows scattered onto the refuge.
      const f = twoOutputs();
      f.add(1, {workspace: 0, monitor: 0});
      f.focus(1);
      f.engine.run([{type: 'floating', action: 'enable'}], 0);
      // Output 0 now shows workspace index 3; workspace 0 (with the floating window) is parked.
      f.engine.run([{type: 'workspace', target: {kind: 'number', number: 4, name: '4'}}], 0);
      expect(f.tree().visible.get(0)).toBe(3);
      expect(f.tree().outputShowing(0)).toBeNull();

      dragTo(f, 1, 1, 1040);
      expect(f.tree().location(1)).toEqual({workspace: 0, output: 0, floating: true});
    });
  });
});
