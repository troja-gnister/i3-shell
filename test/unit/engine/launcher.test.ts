import {describe, it, expect} from 'vitest';
import {fakeEngine, twoMonitorTopology, windowInfo, PRIMARY_AREA, SECOND_AREA} from './fakeEngine';
import {parseCommands} from '../../../src/commands/parse';

const CONFIG = 'bindsym Mod4+d launcher --term kitty';

/** A fixture whose topology has both monitors before the engine starts. */
const twoMonitors = (text = CONFIG) => {
  const f = fakeEngine(text);
  f.setTopology(twoMonitorTopology());
  return f;
};

describe('engine launcher command', () => {
  it('opens on the work area of the monitor holding the focused container', () => {
    const f = twoMonitors();
    f.engine.start();
    f.add(1);                       // windowInfo defaults to monitor 10
    f.engine.run(parseCommands('launcher --term kitty').commands, 0);
    expect(f.launcherRequest).toEqual({area: PRIMARY_AREA, term: 'kitty'});
  });

  it('opens on the output the tree considers focused, not the primary', () => {
    // The launcher reads `tree.focusedOutput` directly now (Task 5); there is no command yet that
    // moves it away from the primary (a later task), so this pokes the tree's own field to exercise
    // that read in isolation.
    const f = twoMonitors();
    f.engine.start();
    f.tree().focusedOutput = 11;
    f.engine.run(parseCommands('launcher').commands, 0);
    expect(f.launcherRequest!.area).toEqual(SECOND_AREA);
    expect(f.launcherRequest!.area).not.toEqual(PRIMARY_AREA);
  });

  it('carries a null term when the binding gave no --term', () => {
    const f = twoMonitors('bindsym Mod4+d launcher');
    f.engine.start();
    f.add(1);
    f.engine.run(parseCommands('launcher').commands, 0);
    expect(f.launcherRequest!.term).toBe(null);
  });

  it('falls back to the primary monitor when the workspace has no selection', () => {
    const f = twoMonitors();
    f.engine.start();
    f.engine.run(parseCommands('launcher').commands, 0);
    expect(f.launcherRequest!.area).toEqual(PRIMARY_AREA);
  });

  it('refuses to open while the session is locked', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1);
    f.engine.onLocked();
    f.engine.run(parseCommands('launcher').commands, 0);
    expect(f.launcherRequest).toBe(null);
  });

  it('closes the launcher when the config reloads', () => {
    // A modal grab that survives a reload holds the keyboard with no actor
    // listening -- unrecoverable without killing the shell.
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1);
    f.engine.run(parseCommands('launcher').commands, 0);
    f.calls.length = 0;
    f.engine.run(parseCommands('reload').commands, 0);
    expect(f.calls).toContain('launcher.close');
  });

  it('closes the launcher when the config restarts', () => {
    const f = twoMonitors();
    f.engine.start();
    f.add(1);
    f.engine.run(parseCommands('launcher').commands, 0);
    f.calls.length = 0;
    f.engine.run(parseCommands('restart').commands, 0);
    expect(f.calls).toContain('launcher.close');
  });

  it('closes the launcher even when a restart rejects the new config', () => {
    const f = twoMonitors();
    f.engine.start();
    f.add(1);
    f.engine.run(parseCommands('launcher').commands, 0);
    // The fixture's loadConfig() returns nextLoad verbatim; a config text
    // that fails to parse is how this fixture makes _applyLoaded() reject
    // (see the "reload keeps the running config when the new one is
    // rejected" test in engine.test.ts and the restart-rejection test in
    // lifecycle.test.ts, both of which use the same f.load('bogus 1') idiom).
    f.setNextLoad(f.load('bogus 1'));
    f.calls.length = 0;
    f.engine.run(parseCommands('restart').commands, 0);
    expect(f.calls).toContain('launcher.close');
  });

  it('closes the launcher when the monitors change', () => {
    // The fourteenth close path. Open it on the external display, then close
    // the lid or pull the cable: the actor keeps its absolute position -- now
    // off-stage -- while the POPUP-mode grab is still held. Every i3-shell
    // binding is dead and there is nothing on screen to explain it.
    const f = twoMonitors();
    f.engine.start();
    f.add(1, {monitor: 11});
    f.flush();
    f.engine.run(parseCommands('launcher').commands, 0);
    f.calls.length = 0;
    f.engine.onMonitorsChanged();
    expect(f.calls).toContain('launcher.close');
  });

  it('closes it on a monitor change even when the topology is gone entirely', () => {
    // What unplugging the only external display looks like between the
    // compositor's signal and the next geometry read.
    const f = twoMonitors();
    f.engine.start();
    f.add(1, {monitor: 11});
    f.flush();
    f.engine.run(parseCommands('launcher').commands, 0);
    f.setTopology(null);
    f.calls.length = 0;
    f.engine.onMonitorsChanged();
    expect(f.calls).toContain('launcher.close');
  });

  it('falls back to the primary silently when the focused output has no work area', () => {
    // The launcher no longer walks a window's selection to find a monitor (Task 5), so a window's own
    // monitor -- unknown or stale -- no longer bears on where it opens; only `tree.focusedOutput` does.
    // Both of the old fallback warnings go with that walk: falling back is no longer the symptom of a
    // missed cross-monitor case ("it opened on the laptop again") that it once was, so it is silent.
    const f = twoMonitors();
    f.engine.start();
    // An output the topology no longer lists -- the shape a mid-flight monitor change leaves behind if
    // the tree has not been reconfigured yet.
    f.tree().focusedOutput = 99;
    f.calls.length = 0;
    f.engine.run(parseCommands('launcher').commands, 0);

    expect(f.launcherRequest!.area).toEqual(PRIMARY_AREA);
    expect(f.calls.filter(call => call.startsWith('warn:launcher:'))).toEqual([]);
  });

  it('says nothing when there is simply nothing focused to follow', () => {
    // An empty workspace is not a fallback failure: the primary output is the
    // right answer and a warning there would be noise on every first open.
    const f = twoMonitors();
    f.engine.start();
    f.calls.length = 0;
    f.engine.run(parseCommands('launcher').commands, 0);

    expect(f.launcherRequest!.area).toEqual(PRIMARY_AREA);
    expect(f.calls.filter(call => call.startsWith('warn:launcher:'))).toEqual([]);
  });

  it('does not change the current mode', () => {
    const f = fakeEngine('bindsym Mod4+d launcher\nmode "resize" {\n  bindsym Escape mode "default"\n}');
    f.engine.start();
    f.add(1);
    f.engine.run(parseCommands('mode "resize"').commands, 0);
    f.engine.run(parseCommands('launcher').commands, 0);
    expect(f.engine.state().mode).toBe('resize');
  });

  it('closes the launcher when the session locks', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1);
    f.engine.run(parseCommands('launcher').commands, 0);
    f.engine.onLocked();
    expect(f.calls).toContain('launcher.close');
  });
});
