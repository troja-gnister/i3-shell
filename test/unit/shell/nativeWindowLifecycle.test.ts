import {afterEach, describe, expect, it, vi} from 'vitest';
import type {WindowTracker} from '../../../src/shell/windowTracker';
import type {WindowEvent} from '../../../src/runtime/model';

vi.mock('gi://Meta', () => ({default: {WindowType: {NORMAL: 0}, TabList: {NORMAL_ALL_MRU: 0}}}));
vi.mock('gi://GLib', () => ({default: {idle_add: () => 1, source_remove: () => {}, PRIORITY_DEFAULT_IDLE: 200}}));

// Load the real adapter at runtime with GI doubles; its global Shell declarations
// belong to the native TS program, not the separate Node test program.
const {ManagedWindows} = await vi.importActual<{
  ManagedWindows: new (emit: (event: WindowEvent) => void, monitorId: (index: number) => number | undefined) => WindowTracker<object>;
}>('../../../src/shell/windows');

type Callback = (...args: unknown[]) => void;
class Signals {
  private next = 1;
  handlers = new Map<number, {signal: string; callback: Callback}>();
  disposed = false;
  connect(signal: string, callback: Callback): number {
    const id = this.next++;
    this.handlers.set(id, {signal, callback});
    return id;
  }
  disconnect(id: number): void {
    if (this.disposed) throw new Error('disconnect on disposed actor');
    if (!this.handlers.delete(id)) throw new Error('missing signal handler');
  }
  emit(signal: string): void {
    for (const [id, handler] of [...this.handlers]) {
      if (this.handlers.has(id) && handler.signal === signal) handler.callback(this);
    }
  }
  destroy(): void {
    this.emit('destroy');
    this.disposed = true;
    this.handlers.clear();
  }
}
class NativeWindow extends Signals {
  actor = new Signals();
  retiring = false;
  workspace: {index(): number} | null = {index: () => 0};
  minimized = false;
  maximized_horizontally = false;
  maximized_vertically = false;
  // The four readings windowFacts uses for the fixed-size fact. Mutter reports
  // an unset program size hint as 0 with a false "known" flag, and the default
  // below is that pair -- an absent hint, not a zero-sized window.
  resizeFunction = true;
  fullscreenState = false;
  minSize: [boolean, number, number] = [false, 0, 0];
  maxSize: [boolean, number, number] = [false, 0, 0];
  // Read live on every snapshot, unlike the fixed-at-classification facts
  // above: a window can move onto every workspace, or gain/lose its taskbar
  // hint, long after its first frame.
  onAllWorkspaces = false;
  skipTaskbar = false;
  private read(): void { if (this.retiring) throw new Error('native read on retiring window'); }
  get_compositor_private(): Signals { this.read(); return this.actor; }
  get_window_type(): number { this.read(); return 0; }
  is_skip_taskbar(): boolean { this.read(); return this.skipTaskbar; }
  get_transient_for(): null { this.read(); return null; }
  is_attached_dialog(): boolean { this.read(); return false; }
  is_on_all_workspaces(): boolean { this.read(); return this.onAllWorkspaces; }
  get resizeable(): boolean { this.read(); return this.resizeFunction; }
  get_min_size(): [boolean, number, number] { this.read(); return this.minSize; }
  get_max_size(): [boolean, number, number] { this.read(); return this.maxSize; }
  get_workspace(): {index(): number} | null { this.read(); return this.workspace; }
  get_frame_rect(): {x: number; y: number; width: number; height: number} {
    this.read(); return {x: 0, y: 32, width: 800, height: 600};
  }
  get_monitor(): number { this.read(); return 0; }
  get_title(): string { this.read(); return 'fixture'; }
  get_wm_class(): string { this.read(); return 'fixture'; }
  is_fullscreen(): boolean { this.read(); return this.fullscreenState; }
  activate(): void { this.read(); }
  delete(): void { this.read(); }
  make_fullscreen(): void { this.read(); }
  unmake_fullscreen(): void { this.read(); }
  change_workspace_by_index(): void { this.read(); }
  unmaximize(): void { this.read(); }
  raise(): void { this.read(); }
}

function setup() {
  const display = Object.assign(new Signals(), {focus_window: null as NativeWindow | null,
    get_tab_list: () => {
      if (order.some(w => w.retiring)) throw new Error('MRU enumeration during native unmanage');
      return [...order];
    }});
  let order: NativeWindow[] = [];
  vi.stubGlobal('display', display);
  vi.stubGlobal('workspace_manager', {get_n_workspaces: () => 1, get_workspace_by_index: () => ({index: () => 0})});
  const events: WindowEvent[] = [];
  let observer: ((event: WindowEvent) => void) | undefined;
  const tracker = new ManagedWindows(event => { events.push(event); observer?.(event); }, () => 1);
  tracker.start();
  function create(draw = true, configure?: (window: NativeWindow) => void): NativeWindow {
    const window = new NativeWindow();
    configure?.(window);
    order.unshift(window);
    for (const handler of display.handlers.values())
      if (handler.signal === 'window-created') handler.callback(display, window);
    if (draw) window.actor.emit('first-frame');
    return window;
  }
  function retire(window: NativeWindow): void {
    window.retiring = true;
    window.emit('unmanaging');
  }
  function finish(window: NativeWindow): void {
    window.actor.destroy();
    window.workspace = null;
    window.emit('workspace-changed');
    order = order.filter(w => w !== window);
    window.emit('unmanaged');
  }
  return {tracker, display, events, create, retire, finish,
    observe: (callback: (event: WindowEvent) => void) => { observer = callback; },
    order: (value: NativeWindow[]) => { order = value; }};
}

afterEach(() => vi.unstubAllGlobals());

describe('native window lifetime', () => {
  it('closes a pending window after its actor is disposed without disconnecting that actor', () => {
    const f = setup();
    const pending = f.create(false);
    f.retire(pending);
    expect(() => f.finish(pending)).not.toThrow();
    expect(f.events).toEqual([]);
    f.tracker.destroy();
    expect(pending.handlers.size).toBe(0);
    expect(f.display.handlers.size).toBe(0);
  });

  it('excludes retiring windows from reads, operations and another window focus enumeration until safe removal', () => {
    const f = setup();
    const dying = f.create();
    const live = f.create();
    const [liveId, dyingId] = f.tracker.list().map(w => w.id);
    f.retire(dying);
    f.display.focus_window = dying;
    expect(f.tracker.focused()).toBeNull();
    expect(f.tracker.get(dyingId)).toBeUndefined();
    expect(f.tracker.resolve(dyingId)).toBeUndefined();
    expect(f.tracker.activate(dyingId, 1)).toBe(false);
    expect(f.tracker.kill(dyingId, 1)).toBe(false);
    expect(f.tracker.fullscreen(dyingId, 'enable')).toBe(false);
    expect(f.tracker.moveToWorkspace(dyingId, 0)).toBe(false);
    expect(f.tracker.unmaximize(dyingId)).toBe(false);
    expect(f.tracker.raise(dyingId)).toBe(false);
    f.observe(event => {
      if (event.type === 'focused') expect(f.tracker.list().map(w => w.id)).toEqual([liveId]);
    });
    f.display.focus_window = live;
    f.display.emit('notify::focus-window');
    expect(f.tracker.list().map(w => w.id)).toEqual([liveId]);
    expect(f.events.filter(e => e.type === 'removed')).toEqual([]);
    expect(() => f.finish(dying)).not.toThrow();
    expect(f.events.filter(e => e.type === 'removed')).toEqual([{type: 'removed', id: dyingId}]);
    f.tracker.destroy();
    expect(live.handlers.size).toBe(0);
    expect(dying.handlers.size).toBe(0);
    expect(f.display.handlers.size).toBe(0);
  });

  it('keeps cached enumeration only through overlapping retirements and resumes fresh native MRU', () => {
    const f = setup();
    const a = f.create(); const b = f.create(); const c = f.create(); const d = f.create();
    const [dId, cId] = f.tracker.list().map(w => w.id);
    f.retire(a); f.retire(b);
    f.order([c, d, b, a]);
    expect(f.tracker.list().map(w => w.id)).toEqual([dId, cId]);
    f.finish(b);
    expect(f.tracker.list().map(w => w.id)).toEqual([dId, cId]);
    f.finish(a);
    expect(f.tracker.list().map(w => w.id)).toEqual([cId, dId]);
    f.tracker.destroy();
    for (const window of [a, b, c, d]) expect(window.handlers.size).toBe(0);
    expect(f.display.handlers.size).toBe(0);
  });

  // Classification happens once, at the first frame, from whatever Mutter
  // reports then. The two cases below pin the native readings windowFacts
  // depends on -- their names and their shapes -- which no Layer 0 test can
  // reach, and which the 2026-09-23 live defect got wrong: allows_resize() is
  // false for a merely maximized window, so every window opened maximized was
  // filed as floating for its lifetime and tiling never engaged.
  it('adopts a window that is already maximized at its first frame as tiled', () => {
    const f = setup();
    f.create(true, window => {
      window.maximized_horizontally = true;
      window.maximized_vertically = true;
    });
    expect(f.tracker.list().map(w => w.kind)).toEqual(['tiled']);
    f.tracker.destroy();
  });

  it('adopts a window that is already fullscreen at its first frame as tiled', () => {
    const f = setup();
    // Mutter clears has_resize_func while a window is fullscreen, so this is
    // exactly what it reports for a player that opens fullscreen.
    f.create(true, window => {
      window.fullscreenState = true;
      window.resizeFunction = false;
    });
    expect(f.tracker.list().map(w => w.kind)).toEqual(['tiled']);
    f.tracker.destroy();
  });

  it('floats a window whose client fixed its size', () => {
    const f = setup();
    f.create(true, window => {
      window.resizeFunction = false;
      window.minSize = [true, 360, 240];
      window.maxSize = [true, 360, 240];
    });
    expect(f.tracker.list().map(w => w.kind)).toEqual(['floating']);
    f.tracker.destroy();
  });

  it('disconnects every owned handler if destroyed during a pending retirement', () => {
    const f = setup();
    const pending = f.create(false);
    f.retire(pending);
    f.tracker.destroy();
    f.tracker.destroy();
    expect(pending.handlers.size).toBe(0);
    expect(pending.actor.handlers.size).toBe(0);
    expect(f.display.handlers.size).toBe(0);
    expect(() => f.finish(pending)).not.toThrow();
    expect(f.events).toEqual([]);
  });

  // Phase 3B: sticky and skip-taskbar moved off the cached facts and onto the
  // per-commit info, so a window that is dragged onto every workspace, or
  // whose skip-taskbar hint flips, must be re-read live rather than frozen
  // at first-frame classification.
  it('reads sticky and skip-taskbar live per commit rather than caching them at classification', () => {
    const f = setup();
    const window = f.create();
    const [id] = f.tracker.list().map(w => w.id);
    expect(f.tracker.get(id)?.sticky).toBe(false);
    expect(f.tracker.get(id)?.skipTaskbar).toBe(false);
    window.onAllWorkspaces = true;
    window.skipTaskbar = true;
    expect(f.tracker.get(id)?.sticky).toBe(true);
    expect(f.tracker.get(id)?.skipTaskbar).toBe(true);
    f.tracker.destroy();
  });

  it('emits a membership event when a window is put on all workspaces', () => {
    const f = setup();
    const window = f.create();
    const [id] = f.tracker.list().map(w => w.id);
    window.emit('notify::on-all-workspaces');
    expect(f.events.filter(e => e.type === 'membership')).toEqual([{type: 'membership', id}]);
    f.tracker.destroy();
  });

  it('emits a membership event when the skip-taskbar hint changes', () => {
    const f = setup();
    const window = f.create();
    const [id] = f.tracker.list().map(w => w.id);
    window.emit('notify::skip-taskbar');
    expect(f.events.filter(e => e.type === 'membership')).toEqual([{type: 'membership', id}]);
    f.tracker.destroy();
  });

  it('connects and disposes the on-all-workspaces and skip-taskbar watches with the rest of the window handlers', () => {
    // Review Focus: a handler that survives its window is the defect class
    // this project has already shipped. Both new watches must go through the
    // existing connectWindow/dispose array, not a second teardown path.
    const f = setup();
    const window = f.create();
    const signals = [...window.handlers.values()].map(h => h.signal);
    expect(signals).toContain('notify::on-all-workspaces');
    expect(signals).toContain('notify::skip-taskbar');
    f.tracker.destroy();
    expect(window.handlers.size).toBe(0);
  });
});
