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
    expect(f.calls).toEqual(['settings.apply', 'grab:65', 'mode:null', 'colors', 'decorations.colors', 'decorations']);
    expect(e.mode).toBe('default');
    expect(e.state()).toMatchObject({mode: 'default', activeWorkspace: 0, workspaceCount: 10, grabbed: 65, configSource: 'file', errors: 0, warnings: 0});
  });

  it('workspace bindings switch and move; names and numbers resolve', () => {
    const f = fakePorts(referenceText);
    const e = f.engine;
    e.start();
    f.calls.length = 0;
    e.onBinding(binding(e.config, 'default', '<Super>3'), 1);
    expect(f.calls).toEqual(['activate:2', 'decorations']);
    f.add(1, {workspace: 2});
    e.onBinding(binding(e.config, 'default', '<Super><Shift>0'), 2);
    // 'decorations' trails every commit, including the extra one a moved window's
    // own workspace-changed event queues; filter it out to keep this assertion
    // about the port calls the move itself makes.
    expect(f.calls.filter(c => c !== 'decorations')).toEqual(['activate:2', 'moveTo:1:9']);
    expect(e.run([{type: 'workspace', target: {kind: 'name', name: '10:X'}}], 3)).toBe('workspace 10');
    expect(e.run([{type: 'workspace', target: {kind: 'next'}}], 4)).toBe('workspace: no such workspace');
    expect(e.run([{type: 'workspace', target: {kind: 'prev'}}], 5)).toBe('workspace 9');
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 9, name: '9'}}], 6)).toBe('workspace: already active');
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 11, name: '11'}}], 7)).toBe('workspace: no such workspace');
    expect(e.run([{type: 'move_to_workspace', target: {kind: 'number', number: 9, name: '9'}}], 8)).toBe('move container to workspace: already there');
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
    expect(f.calls).toEqual(['mode:null', 'ungrabAll']);
    expect(f.ports.keys.grabbedCount).toBe(0);
    e.onUnlocked();
    expect(f.calls.slice(2)).toEqual(['grab:65', 'decorations']);
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
    expect(f.calls).toEqual(['decorations', 'exec:kitty', 'kill:1', 'fullscreen:1:toggle']);
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
      'warn:config warning line 2: exec is not supported by i3-shell yet; line skipped',
      'settings.apply', 'grab:1', 'mode:null', 'colors', 'decorations.colors',
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
});
