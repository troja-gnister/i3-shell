import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {Binding, Config} from '../../src/config/model';
import {fakeEngine as fakePorts} from './engine/fakeEngine';

const referenceText = readFileSync(new URL('./fixtures/reference.i3config', import.meta.url), 'utf8');

const binding = (config: Config, mode: string, accel: string): Binding =>
  config.modes.get(mode)!.bindings.find(b => b.accel === accel)!;

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
    expect(e.run([{type: 'workspace', target: {kind: 'prev'}}], 6)).toBe('workspace 2');
    expect(e.run([{type: 'move_to_workspace', target: {kind: 'number', number: 2, name: '2'}}], 8)).toBe('move container to workspace: already there');
    // `next` resolves against the tree's own active workspace too (active is 1 here, from `prev`
    // above); `prev`'s own coverage above does not exercise `next`'s branch of `_workspaceIndex`.
    expect(e.run([{type: 'workspace', target: {kind: 'next'}}], 9)).toBe('workspace 3');
    expect(e.state().activeWorkspace).toBe(2);
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
    f.add(1, {workspace: 0, monitor: 0});
    f.add(2, {workspace: 0, monitor: 1});
    const laid = f.appliedRects();
    expect([...laid.keys()].sort()).toEqual([1, 2]);
  });

  it('derives a pill’s occupancy from the tree, not from the window’s GNOME workspace', () => {
    // Every window's GNOME workspace is 0 under the attic; occupancy must still follow the tree.
    const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
    const e = f.engine;
    e.start();
    f.add(1, {workspace: 0, monitor: 1});
    expect(e.state().pills[1]!.occupied).toBe(true);
    expect(e.state().pills[0]!.occupied).toBe(false);
  });

  it('reports the focused output', () => {
    const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
    const e = f.engine;
    e.start();
    expect(e.state().focusedOutput).toBe(0);
  });

  it('adopts a window onto the visible workspace of the output it is on', () => {
    // Spec 2.6: the pre-enable workspace is unrecoverable once num-workspaces drops to 2.
    const f = fakePorts(referenceText, {
      monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10,
      existingWindows: [{id: 5, workspace: 0, monitor: 1}],
    });
    const e = f.engine;
    e.start();
    expect(f.tree().location(5)).toEqual({workspace: 1, output: 1, floating: false});
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
      f.add(1, {workspace: 0, monitor: 0});   // output 0's own window, currently focused
      f.add(2, {workspace: 0, monitor: 1});   // output 1's own window, unrelated to this swap
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
      // `_tree` is poked directly (as `fakeEngine.ts`'s own `tree()` helper does) because there is no
      // public way to force "no tree, no ready topology" back onto an engine that already has both.
      const f = fakePorts(referenceText, {monitors: [{id: 0, index: 0}, {id: 1, index: 1}], primary: 0, workspaceCount: 10});
      const e = f.engine;
      e.start();
      const before = new Map(f.pillsByOutput);
      expect(before.size).toBeGreaterThan(0);

      f.setTopology(null);
      (e as unknown as {_tree: unknown})._tree = null;
      e.onMonitorsChanged();

      expect(f.pillsByOutput).toEqual(before);
    });
  });
});
