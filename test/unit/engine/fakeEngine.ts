import {Engine, type EnginePorts, type LoadedConfig} from '../../../src/engine';
import {loadConfigText} from '../../../src/config';
import type {Binding, Colors} from '../../../src/config/model';
import type {Accent} from '../../../src/config/colors';
import type {PillState, Topology, WindowEvent, WindowInfo} from '../../../src/runtime/model';
import type {DecorationPlan} from '../../../src/runtime/decoration';
import type {Rect, WindowId} from '../../../src/tree/node';

export function windowInfo(id: number, patch: Partial<WindowInfo> = {}): WindowInfo {
  return {id, workspace: 0, monitor: 10, kind: 'tiled', rect: {x: 20, y: 40, width: 300, height: 200},
    title: `Window ${id}`, wmClass: 'fixture', minimized: false, fullscreen: false,
    maximizedH: false, maximizedV: false, sticky: false, skipTaskbar: false, ...patch};
}
export function topology(count = 10): Topology {
  return {primary: 10, monitors: [{id: 10, index: 0, connectors: ['fixture']}],
    workAreas: new Map(Array.from({length: count}, (_, i) => [i, new Map([[10, {x: 0, y: 30, width: 1000, height: 700}]])]))};
}
export function fakeEngine(initialText = 'bindsym Mod4+q kill') {
  const calls: string[] = [];
  const windows = new Map<WindowId, WindowInfo>();
  const applied: Array<Map<WindowId, Rect>> = [];
  const queue = new Map<number, () => void>();
  let token = 0, active = 0, count = 10;
  let focused: WindowId | null = null;
  let currentTopology: Topology | null = topology();
  let nextLoad: LoadedConfig | null = null;
  let grabbed: Binding[] = [];
  let accent: Accent | null = {background: '#6f8396', text: '#ffffff'};
  let accentChanged: (() => void) | null = null;
  const load = (text: string): LoadedConfig => ({...loadConfigText(text), source: 'file', path: '/fake/config'});
  const ports: EnginePorts = {
    keys: {
      setBindings: bindings => { grabbed = bindings; calls.push(`grab:${bindings.length}`); return {failed: []}; },
      ungrabAll: () => { grabbed = []; calls.push('ungrabAll'); },
      get grabbedCount() { return grabbed.length; },
    },
    workspaces: {
      get count() { return count; }, get activeIndex() { return active; },
      activate: index => { active = index; calls.push(`activate:${index}`); engine.onWorkspacesChanged(); return true; },
    },
    windows: {
      list: () => [...windows.values()], get: id => windows.get(id), focused: () => focused,
      activate: id => { calls.push(`focus:${id}`); if (f.activationFails) return false; f.focus(id); return windows.has(id); },
      kill: id => { calls.push(`kill:${id}`); return windows.has(id); },
      fullscreen: (id, action) => { calls.push(`fullscreen:${id}:${action}`); return windows.has(id); },
      moveToWorkspace: (id, index) => { calls.push(`moveTo:${id}:${index}`); f.change(id, {workspace: index}, 'workspace'); return windows.has(id); },
      unmaximize: id => { calls.push(`unmaximize:${id}`); return windows.has(id); },
      raise: id => { calls.push(`raise:${id}`); return windows.has(id); },
    },
    geometry: {topology: () => currentTopology, apply: rects => {
      applied.push(new Map(rects));
      const done = new Set<WindowId>();
      for (const [id, rect] of rects) {
        f.onApply?.(id);
        if (!windows.has(id)) continue;
        if (!f.refuseGeometry) windows.set(id, {...windows.get(id)!, rect: {...rect}});
        if (f.emitFrames) engine.onWindowEvent({type: 'frame', id});
        done.add(id);
      }
      return done;
    }},
    deferred: {defer: callback => { queue.set(++token, callback); return token; }, cancel: id => { queue.delete(id); }},
    settings: {
      apply: (_config, wanted) => { calls.push('settings.apply'); count = wanted; active = Math.min(active, count - 1); },
      restoreAll: () => { calls.push('settings.restore'); },
    },
    indicator: {
      setMode: name => { calls.push(`mode:${name}`); },
      setColors: colors => { calls.push('colors'); f.pushedColors = colors; },
      setPills: pills => { f.pills = pills; }, setVisible: visible => { f.visible = visible; },
    },
    accent: {
      current: () => accent,
      subscribe: callback => { accentChanged = callback; },
    },
    decorations: {
      apply: plan => { f.plan = plan; calls.push('decorations'); },
      setColors: colors => { f.decorationColors = colors; calls.push('decorations.colors'); },
    },
    now: () => 123456789,
    exec: command => { calls.push(`exec:${command}`); },
    notify: (title, body) => { calls.push(`notify:${title}|${body}`); },
    log: {info: () => {}, warn: message => { calls.push(`warn:${message}`); }},
    loadConfig: () => nextLoad ?? load(initialText),
  };
  const engine = new Engine(ports);
  const f = {
    engine, ports, calls, applied, windows, load,
    pills: [] as PillState[], pushedColors: null as Colors | null, decorationColors: null as Colors | null,
    visible: true, refuseGeometry: false, emitFrames: true, activationFails: false,
    onApply: null as ((id: WindowId) => void) | null,
    plan: null as DecorationPlan | null,
    add(id: WindowId, patch: Partial<WindowInfo> = {}) { windows.set(id, windowInfo(id, patch)); engine.onWindowEvent({type: 'added', id}); },
    change(id: WindowId, patch: Partial<WindowInfo>, eventType: Exclude<WindowEvent['type'], 'added' | 'removed' | 'focused'>) {
      const old = windows.get(id); if (!old) return;
      windows.set(id, {...old, ...patch}); engine.onWindowEvent({type: eventType, id});
    },
    focus(id: WindowId | null) { focused = id; engine.onWindowEvent({type: 'focused', id}); },
    remove(id: WindowId) { windows.delete(id); engine.onWindowEvent({type: 'removed', id}); },
    flush() { let limit = 1000; while (queue.size) { if (--limit === 0) throw new Error('deferred loop'); const [id, cb] = queue.entries().next().value!; queue.delete(id); cb(); } },
    setNextLoad(loaded: LoadedConfig | null) { nextLoad = loaded; },
    setTopology(value: Topology | null) { currentTopology = value; },
    setNativeCount(value: number) { count = value; engine.onWorkspacesChanged(); },
    grabbedAccels: () => grabbed.map(b => b.accel),
    setAccent(value: Accent | null) { accent = value; accentChanged?.(); },
  };
  return f;
}
export type EngineFixture = ReturnType<typeof fakeEngine>;
