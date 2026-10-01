import {Engine, type EnginePorts, type LoadedConfig} from '../../../src/engine';
import {loadConfigText} from '../../../src/config';
import type {Binding, Colors} from '../../../src/config/model';
import type {Accent} from '../../../src/config/colors';
import {LIVE_WORKSPACE, type PillState, type Topology, type WindowEvent, type WindowInfo} from '../../../src/runtime/model';
import type {DecorationPlan} from '../../../src/runtime/decoration';
import type {MonitorId, Rect, WindowId} from '../../../src/tree/node';
import type {Tree} from '../../../src/tree/tree';
import type {LauncherRequest} from '../../../src/launcher/model';

export function windowInfo(id: number, patch: Partial<WindowInfo> = {}): WindowInfo {
  return {id, workspace: 0, monitor: 10, kind: 'tiled', rect: {x: 20, y: 40, width: 300, height: 200},
    title: `Window ${id}`, wmClass: 'fixture', instance: null, appId: null, role: null, urgent: false,
    minimized: false, fullscreen: false,
    maximizedH: false, maximizedV: false, sticky: false, skipTaskbar: false, ...patch};
}
// `count` is unused now that workAreas is keyed by output rather than by workspace; kept so callers
// that still pass an explicit workspace count (a concern of Tree, not of Topology) do not need editing.
export function topology(count = 10): Topology {
  void count;
  return {primary: 10, monitors: [{id: 10, index: 0, connectors: ['fixture']}],
    workAreas: new Map([[10, {x: 0, y: 30, width: 1000, height: 700}]])};
}

export const PRIMARY_AREA = {x: 0, y: 30, width: 1000, height: 700};
export const SECOND_AREA = {x: 1000, y: 0, width: 1920, height: 1050};

/** Two monitors: 10 is primary at the origin, 11 sits to its right. */
export function twoMonitorTopology(count = 10): Topology {
  void count;
  return {
    primary: 10,
    monitors: [{id: 10, index: 0, connectors: ['fixture']}, {id: 11, index: 1, connectors: ['second']}],
    workAreas: new Map([[10, {...PRIMARY_AREA}], [11, {...SECOND_AREA}]]),
  };
}

/**
 * A topology built from a plain list of outputs, one work area per output, laid out left to right.
 * Each monitor's connectors default to a synthetic `fixture-<id>` name; a test pinning `workspace N
 * output <name>` passes its own, so the name it configures is the name the fake topology reports.
 */
export function outputsTopology(
  monitors: Array<{id: MonitorId; index: number; connectors?: readonly string[]}>,
  primary: MonitorId,
): Topology {
  return {
    primary,
    monitors: monitors.map(m => ({id: m.id, index: m.index, connectors: m.connectors ?? [`fixture-${m.id}`]})),
    workAreas: new Map(monitors.map(m => [m.id, {x: m.index * 1000, y: 0, width: 1000, height: 700}])),
  };
}

export interface FakeEngineOptions {
  /** Builds the initial topology in place of the single-monitor default. */
  monitors?: Array<{id: MonitorId; index: number; connectors?: readonly string[]}>;
  primary?: MonitorId;
  /** Overrides the fake's native GNOME workspace count (the `count` the ports.workspaces getter reports). */
  workspaceCount?: number;
  /** Windows present in the port's window list before `engine.start()` runs, for adoption-on-enable scenarios. */
  existingWindows?: Array<Partial<WindowInfo> & {id: WindowId}>;
}

export function fakeEngine(initialText = 'bindsym Mod4+q kill', options: FakeEngineOptions = {}) {
  const calls: string[] = [];
  let launcherOpen = false;
  const pointerWarps: Rect[] = [];
  const windows = new Map<WindowId, WindowInfo>();
  const applied: Array<Map<WindowId, Rect>> = [];
  const queue = new Map<number, () => void>();
  let token = 0, active = 0, count = options.workspaceCount ?? 10, staleActivations = 0;
  let focused: WindowId | null = null;
  const refusedMoves = new Set<WindowId>();
  let currentTopology: Topology | null = options.monitors
    ? outputsTopology(options.monitors, options.primary ?? options.monitors[0]!.id)
    : topology();
  let nextLoad: LoadedConfig | null = null;
  for (const patch of options.existingWindows ?? []) windows.set(patch.id, windowInfo(patch.id, patch));
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
      activate: index => {
        calls.push(`activate:${index}`);
        // Task 19 round 1, I1: `Workspaces.activate` crosses the GJS boundary three times
        // (`get_workspace_by_index`, `workspace.activate`, `global.get_current_time`), and any of them
        // can throw. Modelled here so the engine's re-entrancy flag can be proved not to latch.
        if (f.activateThrows) throw new Error('GJS boundary: workspace.activate failed');
        if (!f.staleActivate) { active = index; engine.onWorkspacesChanged(); return true; }
        // Task 19, D2: Mutter's own `workspace.activate()` emits `active-workspace-changed`
        // synchronously, BEFORE `get_active_workspace_index()` reports the new index -- and the switch
        // itself lands later still, so the index is stale for the whole of the handler that follows.
        // That is the re-entrancy the engine's attic guard has to survive; the 25-call cap stands in for
        // the 3376 corrections the journal recorded at login before the stack gave out, and makes a
        // missing guard a legible failure rather than a hung suite.
        if (++staleActivations > 25)
          throw new Error(`re-entrant activate: ${staleActivations} corrections with the index still stale`);
        engine.onWorkspacesChanged();
        return true;
      },
    },
    windows: {
      list: () => [...windows.values()], get: id => windows.get(id), focused: () => focused,
      activate: id => { calls.push(`focus:${id}`); if (f.activationFails) return false; f.focus(id); return windows.has(id); },
      kill: id => { calls.push(`kill:${id}`); return windows.has(id); },
      fullscreen: (id, action) => { calls.push(`fullscreen:${id}:${action}`); return windows.has(id); },
      moveToWorkspace: (id, index) => {
        calls.push(`moveTo:${id}:${index}`);
        if (refusedMoves.has(id) || !windows.has(id)) return false;
        // Mutter picks a replacement focus on its own when the window it is moving away from LIVE
        // currently holds native focus -- observable only because this fake, unlike a synchronous
        // confirm-and-forget stub, actually emits the native report the real compositor would.
        const wasFocused = focused === id;
        f.change(id, {workspace: index}, 'workspace');
        if (wasFocused && index !== LIVE_WORKSPACE) {
          const replacement = [...windows.keys()]
            .find(other => other !== id && windows.get(other)!.workspace === LIVE_WORKSPACE) ?? null;
          f.focus(replacement);
        }
        return true;
      },
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
      // GNOME's own native workspace count is held at two (live + attic) whenever i3-shell is naming
      // any workspaces at all, independent of `wanted` (the i3 workspace count) -- matching what the
      // real SettingsOverrides.apply() now forces num-workspaces to. `wanted <= 0` leaves it alone, as
      // the real adapter restores rather than touches it in that case.
      apply: (_config, wanted) => {
        calls.push('settings.apply');
        if (wanted > 0) count = 2;
        active = Math.min(active, count - 1);
      },
      restoreAll: () => { calls.push('settings.restore'); },
    },
    indicator: {
      setMode: name => { calls.push(`mode:${name}`); },
      setColors: colors => { calls.push('colors'); f.pushedColors = colors; },
      setPills: byOutput => { f.pillsByOutput = new Map(byOutput); },
      setVisible: visible => { f.visible = visible; },
    },
    accent: {
      current: () => accent,
      subscribe: callback => { accentChanged = callback; },
    },
    decorations: {
      apply: plan => { f.plan = plan; calls.push('decorations'); },
      setColors: colors => { f.decorationColors = colors; calls.push('decorations.colors'); },
    },
    launcher: {
      open: request => { f.launcherRequest = request; launcherOpen = true; calls.push('launcher.open'); },
      close: () => { launcherOpen = false; calls.push('launcher.close'); },
      setColors: colors => { f.launcherColors = colors; calls.push('launcher.colors'); },
      isOpen: () => launcherOpen,
    },
    pointer: {warpTo: rect => { pointerWarps.push({...rect}); calls.push('pointer.warp'); }},
    now: () => 123456789,
    exec: command => { calls.push(`exec:${command}`); },
    notify: (title, body) => { calls.push(`notify:${title}|${body}`); },
    log: {info: () => {}, warn: message => { calls.push(`warn:${message}`); }},
    loadConfig: () => nextLoad ?? load(initialText),
  };
  const engine = new Engine(ports);
  const f = {
    engine, ports, calls, applied, windows, load,
    pillsByOutput: new Map<MonitorId, readonly PillState[]>(),
    /**
     * The flat, workspace-ordered view of whatever was last pushed to the indicator port -- the shape
     * every test written before Task 8 (per-output pills) already asserts against. Reconstructed from
     * `pillsByOutput` via the tree's own `workspacesOn`, which is exactly how the engine grouped it in
     * the first place, so this is provably the same data, not a second derivation that could drift.
     */
    get pills(): PillState[] {
      const tree = (engine as unknown as {_tree: Tree | null})._tree;
      if (!tree) return [];
      const flat: PillState[] = [];
      for (const [output, list] of f.pillsByOutput)
        tree.workspacesOn(output).forEach((index, position) => { flat[index] = list[position]!; });
      return flat;
    },
    pushedColors: null as Colors | null, decorationColors: null as Colors | null,
    visible: true, refuseGeometry: false, emitFrames: true, activationFails: false,
    /**
     * Makes `workspaces.activate()` behave the way Mutter's really does: emit the change signal before
     * the index it reports has moved, and leave it unmoved (the switch lands in a later main-loop turn).
     * Off by default, so every test written before Task 19 keeps the confirm-and-forget fake it had.
     */
    staleActivate: false,
    /** Makes `workspaces.activate()` throw, the way a GJS boundary call can. */
    activateThrows: false,
    onApply: null as ((id: WindowId) => void) | null,
    plan: null as DecorationPlan | null,
    launcherRequest: null as LauncherRequest | null,
    launcherColors: null as Colors | null,
    /**
     * Every `pointer.warpTo` call the engine has made, in call order -- Task 13's `mouse_warping` tests
     * read this. `clear()` is the same convenience `f.calls.length = 0` is: `mapOn` below drives the real
     * `focus output` command, which warps, so a test that measures warps clears the setup's first.
     */
    pointer: {
      warps: (): Rect[] => pointerWarps.map(r => ({...r})),
      clear(): void { pointerWarps.length = 0; },
    },
    /**
     * Fix round 1, C1: the real `Launcher` closes itself at seven sites the engine never calls
     * `close()` for. This models exactly that -- the launcher's own open/closed state flips with no
     * `close()` port call and nothing pushed to `calls`, the way a dismiss or a launch really looks
     * from the engine's side.
     */
    launcherClosedItself() { launcherOpen = false; },
    get topology() { return currentTopology; },
    add(id: WindowId, patch: Partial<WindowInfo> = {}) { windows.set(id, windowInfo(id, patch)); engine.onWindowEvent({type: 'added', id}); },
    /**
     * Task 23, D7: a window Mutter maps while the user is looking at `monitor`. Adoption follows the
     * FOCUSED output now, not the monitor the compositor chose, so a test that wants a newly mapped
     * window on a particular output has to put focus there first -- which is exactly what the user who
     * opened it would have done. `info.monitor` is set to the same output, so these fixtures say nothing
     * about the two agreeing or disagreeing; the D7 tests in engine.test.ts are the ones that make them
     * disagree on purpose.
     *
     * Goes through the production `focus output <name>` command (the connector names `outputsTopology`
     * invents) rather than poking `tree.focusedOutput`, so the fixture cannot drift from the engine.
     */
    mapOn(monitor: MonitorId, id: WindowId, patch: Partial<WindowInfo> = {}) {
      const connector = currentTopology?.monitors.find(m => m.id === monitor)?.connectors[0];
      if (connector === undefined) throw new Error(`mapOn: no output ${monitor} in the topology`);
      const result = engine.run([{type: 'focus_output', target: {name: connector}}], 0);
      if (result !== 'focus output' && result !== 'focus output: unchanged')
        throw new Error(`mapOn: could not focus output ${monitor}: ${result}`);
      f.add(id, {monitor, ...patch});
    },
    change(id: WindowId, patch: Partial<WindowInfo>, eventType: Exclude<WindowEvent['type'], 'added' | 'removed' | 'focused'>) {
      const old = windows.get(id); if (!old) return;
      windows.set(id, {...old, ...patch}); engine.onWindowEvent({type: eventType, id});
    },
    focus(id: WindowId | null) { focused = id; engine.onWindowEvent({type: 'focused', id}); },
    remove(id: WindowId) { windows.delete(id); engine.onWindowEvent({type: 'removed', id}); },
    flush() { let limit = 1000; while (queue.size) { if (--limit === 0) throw new Error('deferred loop'); const [id, cb] = queue.entries().next().value!; queue.delete(id); cb(); } },
    setNextLoad(loaded: LoadedConfig | null) { nextLoad = loaded; },
    setTopology(value: Topology | null) { currentTopology = value; },
    /** Makes a subsequent `moveToWorkspace(id, ...)` report refusal, the way Mutter itself might. */
    refuseMove(id: WindowId) { refusedMoves.add(id); },
    /**
     * Pokes GNOME's own active workspace directly, without going through `activate()` (which would
     * itself call `engine.onWorkspacesChanged()`) -- the way a touchpad gesture changes it, with no
     * port call the engine issued. The test then calls `engine.onWorkspacesChanged()` itself to
     * simulate the native signal that change would raise.
     */
    setActiveIndex(value: number) { active = value; },
    setNativeCount(value: number) { count = value; engine.onWorkspacesChanged(); },
    grabbedAccels: () => grabbed.map(b => b.accel),
    setAccent(value: Accent | null) { accent = value; accentChanged?.(); },
    /** Every rect ever applied, merged in call order — the union of what has been laid out so far. */
    appliedRects(): Map<WindowId, Rect> {
      const merged = new Map<WindowId, Rect>();
      for (const rects of applied) for (const [id, rect] of rects) merged.set(id, rect);
      return merged;
    },
    /** The engine's live tree, for assertions the JSON snapshot cannot make (e.g. exact `location()`). */
    tree(): Tree {
      const tree = (engine as unknown as {_tree: Tree | null})._tree;
      if (!tree) throw new Error('engine has no tree yet');
      return tree;
    },
  };
  return f;
}
export type EngineFixture = ReturnType<typeof fakeEngine>;
