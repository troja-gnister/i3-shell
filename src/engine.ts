import {Tree} from './tree/tree';
import {descendFocused, leaves, walk, type Con, type Rect, type SplitCon, type WindowId} from './tree/node';
import {layoutWithRects, stackingOrder} from './tree/layout';
import {RectReconciler} from './runtime/reconcile';
import {serializeTree, type TreeSnapshot, type WindowSnapshot} from './runtime/snapshot';
import {decorationPlan, type DecorationPlan} from './runtime/decoration';
import type {WindowsPort, GeometryPort, DeferredPort, PillState, Topology, WindowInfo, WindowEvent} from './runtime/model';
import {parseCommands} from './commands/parse';
import type {Command, WorkspaceTarget} from './commands/model';
import type {Binding, Colors, Config, Diagnostic} from './config/model';
import {effectiveColors, type Accent} from './config/colors';

/**
 * How many commits a window may still report itself maximized before the engine
 * stops waiting for the unmaximize it asked for. Generous enough that the normal
 * asynchronous round trip never reaches it.
 */
const UNMAXIMIZE_OBSERVATIONS = 10;

export interface LoadedConfig {
  config: Config | null;
  diagnostics: Diagnostic[];
  source: 'file' | 'cache' | 'fallback';
  path: string;
}

/** Everything GNOME-facing the engine needs, as plain interfaces (fakes in tests, adapters in the shell). */
export interface EnginePorts {
  keys: {
    setBindings(bindings: Binding[]): {failed: Binding[]};
    ungrabAll(): void;
    readonly grabbedCount: number;
  };
  workspaces: {
    readonly count: number;
    readonly activeIndex: number;
    activate(index: number, timestamp: number): boolean;
  };
  windows: WindowsPort;
  geometry: GeometryPort;
  deferred: DeferredPort;
  now(): number;
  settings: {
    apply(config: Config, workspaceCount: number): void;
    restoreAll(): void;
  };
  indicator: {
    setMode(name: string | null): void;
    setColors(colors: Colors): void;
    setPills(pills: PillState[]): void;
    setVisible(visible: boolean): void;
  };
  /**
   * The desktop accent, and a way to hear about changes to it. Chrome the
   * config did not colour follows it; see effectiveColors().
   */
  accent: {
    current(): Accent | null;
    subscribe(callback: () => void): void;
  };
  /**
   * Receives a fresh plan on every commit, including the commit that empties
   * it (a window removed, a workspace switched away from) — the renderer
   * never has to infer teardown on its own.
   */
  decorations: {apply(plan: DecorationPlan): void};
  exec(command: string): void;
  notify(title: string, body: string): void;
  log: {info(message: string): void; warn(message: string): void};
  /** 'initial' always yields a config (the loader falls back); 'reload' may yield null = keep the running config. */
  loadConfig(mode: 'initial' | 'reload'): LoadedConfig;
}

export interface EngineState {
  mode: string;
  activeWorkspace: number;
  workspaceCount: number;
  grabbed: number;
  configSource: string;
  configPath: string;
  errors: number;
  warnings: number;
  pills: PillState[];
}

export class Engine {
  private _config!: Config;
  private _loaded!: LoadedConfig;
  private _mode = 'default';
  private _locked = false;
  private _started = false;
  private _disposed = false;
  private _lastLoadTime = 0;
  private _workspaceCount = 1;
  private _tree: Tree | null = null;
  private _topology: Topology | null = null;
  private _ready = false;
  private _revision = 0;
  private _committing = false;
  private readonly _queued: Array<() => boolean | void> = [];
  private readonly _windows = new Map<WindowId, WindowInfo>();
  private readonly _manualFloating = new Map<WindowId, boolean>();
  private readonly _minimized = new Map<WindowId, boolean>();
  private readonly _expectedWorkspace = new Map<WindowId, number>();
  private readonly _expectedFocus = new Set<WindowId>();
  private _lastFocus: WindowId | null = null;
  private readonly _unmaximizing = new Set<WindowId>();
  private readonly _unmaximizeAttempts = new Map<WindowId, number>();
  private readonly _forced = new Set<WindowId>();
  private _monitorInvalidation = false;
  private readonly _reconciler = new RectReconciler();
  private _containerRects = new Map<Con, Rect>();
  private _rowHeight = 0;
  private readonly _borderOverrides = new Map<WindowId, number>();
  private readonly _floatingRects = new Map<WindowId, Rect>();
  private readonly _frameReads = new Map<WindowId, {token: number; generation: number | undefined}>();
  private readonly _listeners = new Set<() => void>();
  private readonly _raiseOrders = new Map<number, string>();
  private _pills: PillState[] = [];


  constructor(private readonly _ports: EnginePorts) {}

  get config(): Config {
    return this._config;
  }

  get mode(): string {
    return this._mode;
  }

  get lastLoad(): LoadedConfig {
    return this._loaded;
  }

  get lastLoadTime(): number { return this._lastLoadTime; }

  start(locked = false): void {
    if (this._started || this._disposed) return;
    const loaded = this._ports.loadConfig('initial');
    if (!loaded.config) throw new Error('loadConfig("initial") must always provide a config');
    this._locked = locked;
    this._started = true;
    this._ports.accent.subscribe(() => {
      // Only the pushed colours change; the tree and every rectangle are
      // untouched, so this deliberately does not run a commit.
      if (!this._disposed && this._started) this._pushColors();
    });
    this._applyLoaded(loaded);
  }

  private _pushColors(): void {
    this._ports.indicator.setColors(
      effectiveColors(this._config.colors, this._config.specifiedColors, this._ports.accent.current()));
  }

  stop(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const read of this._frameReads.values()) this._ports.deferred.cancel(read.token);
    this._frameReads.clear();
    this._queued.length = 0;
    this._listeners.clear();
    this._ports.keys.ungrabAll();
    this._ports.settings.restoreAll();
  }

  treeSnapshot(): TreeSnapshot {
    if (!this._ready || !this._tree || !this._topology)
      return {version: 1, revision: this._revision, ready: false,
        activeWorkspace: this._ports.workspaces.activeIndex, workspaces: []};
    return serializeTree(this._tree, this._topology, this._containerRects, this._windows, this._revision, this._rowHeight);
  }

  windowsSnapshot(): WindowSnapshot[] {
    return [...this._windows.keys()].flatMap(id => {
      const info = this._ports.windows.get(id);
      if (!info) return [];
      const status = this._reconciler.status(id);
      return [{...info, rect: {...info.rect}, state: info.minimized ? 'minimized' : this._floating(info) ? 'floating' : 'tiled',
        expectedRect: status?.expected ?? null, generation: status?.generation ?? null, stubborn: status?.stubborn ?? false}];
    });
  }

  subscribeTreeChanged(callback: () => void): () => void {
    if (!this._disposed) this._listeners.add(callback);
    return () => { this._listeners.delete(callback); };
  }

  onWindowEvent(event: WindowEvent): void {
    if (!this._started || this._disposed) return;
    if (event.type === 'frame') {
      const generation = this._reconciler.generation(event.id);
      const pending = this._frameReads.get(event.id);
      if (pending) {
        pending.generation = generation;
        return;
      }
      const token = this._ports.deferred.defer(() => {
        const read = this._frameReads.get(event.id);
        this._frameReads.delete(event.id);
        // The commit publishes only when _observe queued something: relayout()
        // and unlock stay unconditional, because scenarios use their revision
        // bump as an ordering barrier.
        if (read) this.commit(() => this._observe(event.id, read.generation));
      });
      this._frameReads.set(event.id, {token, generation});
      return;
    }
    this.commit(() => {
      if (event.type === 'focused') {
        this._acceptFocus(event.id);
      } else if (event.type === 'removed') {
        const location = this._tree?.location(event.id);
        const selected = this._selectedIds().includes(event.id);
        this._forget(event.id);
        // 0 = no native event timestamp here (this is a signal callback, not a
        // command); the windows adapter substitutes the current server time so
        // focus-stealing prevention cannot drop the activation.
        if (selected && location?.workspace === this._tree?.activeWorkspace) this._activateSelection(0);
      } else {
        this._syncWindow(event.id, event.type === 'workspace');
      }
    });
  }

  onWorkspacesChanged(): void {
    this.commit(() => {
      if (this._ports.workspaces.count !== this._workspaceCount)
        this._ports.settings.apply(this._config, this._workspaceCount);
    });
  }

  onMonitorsChanged(): void {
    this.commit(() => { this._monitorInvalidation = true; });
  }

  /** The shell measures the title-row height once fonts are known and reports it here; not a port, since it is the shell asking the engine, not the other way round. */
  setRowHeight(height: number): void {
    if (this._rowHeight === height) return;
    this._rowHeight = height;
    this.commit();
  }

  /** Records a per-window border-width override; `border` command handling calls this per targeted leaf. */
  setBorder(window: WindowId, width: number): void {
    this._borderOverrides.set(window, width);
    this.commit();
  }

  relayout(): void {
    this.commit(() => {
      for (const id of this._windows.keys()) this._observe(id, this._reconciler.generation(id));
    });
  }

  /** Native callbacks may enqueue work, but never mutate a tree during its traversal. */
  private commit(change: () => boolean | void = () => {}): void {
    if (!this._started || this._disposed) return;
    this._queued.push(change);
    if (this._committing) return;
    this._committing = true;
    try {
      while (this._queued.length && !this._disposed) {
        const changed = this._queued.shift()!();
        if (this._disposed) break;
        if (changed !== false) this._layoutAndPublish();
      }
    } finally {
      this._committing = false;
    }
  }

  private _layoutAndPublish(): void {
    const topology = this._ports.geometry.topology();
    this._ready = !!topology && topology.monitors.length > 0 &&
      Array.from({length: this._workspaceCount}, (_, i) => i).every(index =>
        topology.monitors.every(m => topology.workAreas.get(index)?.has(m.id)));
    const decoRoots: Array<{root: SplitCon; active: boolean}> = [];
    let decoFocused: Con | null = null;
    if (this._ready && topology) {
      const isNew = !this._tree;
      this._topology = topology;
      if (!this._tree) this._tree = new Tree(this._workspaceCount, topology.monitors.map(m => m.id));
      else if (this._tree.workspaces.size !== this._workspaceCount ||
        [...this._tree.workspace(0).monitors.keys()].join(',') !== topology.monitors.map(m => m.id).join(','))
        this._moveReconfigured(this._tree.reconfigure(this._workspaceCount, topology.monitors.map(m => m.id), topology.primary));
      if (this._disposed) return;
      const tree = this._tree;
      tree.activateWorkspace(Math.min(this._workspaceCount - 1, Math.max(0, this._ports.workspaces.activeIndex)));
      const live = this._ports.windows.list();
      const ids = new Set(live.map(w => w.id));
      for (const id of this._windows.keys()) if (!ids.has(id)) this._forget(id);
      for (const info of live) {
        this._syncWindow(info.id);
        if (this._disposed) return;
      }
      if (isNew) {
        const restored = new Set<number>();
        for (const info of live) {
          if (info.minimized || restored.has(info.workspace) || !tree.location(info.id)) continue;
          this._selectWindow(info.id);
          restored.add(info.workspace);
        }
        this._acceptFocus(this._ports.windows.focused());
      }
      tree.normalize(new Set(live.filter(w => !w.minimized).map(w => w.id)));
      const expected = new Map<WindowId, Rect>();
      this._containerRects = new Map();
      for (const ws of tree.workspaces.values()) {
        for (const [monitor, root] of ws.monitors) {
          const layout = layoutWithRects(root, topology.workAreas.get(ws.index)!.get(monitor)!, this._rowHeight);
          for (const [con, rect] of layout.containers) this._containerRects.set(con, rect);
          for (const [id, rect] of layout.windows) {
            const info = this._ports.windows.get(id);
            if (info && !info.fullscreen && !info.minimized && !this._unmaximizing.has(id)) expected.set(id, rect);
          }
          decoRoots.push({root, active: ws.index === tree.activeWorkspace});
        }
      }
      const selection = tree.selection();
      decoFocused = selection?.kind === 'tiled' ? selection.con : null;
      if (this._monitorInvalidation) {
        for (const id of this._windows.keys()) this._forced.add(id);
        this._monitorInvalidation = false;
      }
      const changes = this._reconciler.plan(expected, this._forced);
      for (const id of expected.keys()) this._forced.delete(id);
      for (const [id, rect] of this._floatingRects) changes.set(id, rect);
      this._floatingRects.clear();
      if (changes.size) this._ports.geometry.apply(changes);
      if (this._disposed) return;
      this._raiseChanged();
    } else {
      // Keep ready ids known even while the compositor has no complete topology,
      // but still drop ids that are gone: the pill occupancy below is computed
      // from this map, so a stale id would keep its workspace lit forever.
      const live = this._ports.windows.list();
      const ids = new Set(live.map(w => w.id));
      for (const id of this._windows.keys()) if (!ids.has(id)) this._forget(id);
      for (const info of live) this._windows.set(info.id, {...info, rect: {...info.rect}});
    }
    if (this._disposed) return;
    this._pills = Array.from({length: this._workspaceCount}, (_, index) => ({
      name: this._config.workspaceNames.get(index + 1) ?? String(index + 1),
      active: index === this._ports.workspaces.activeIndex,
      occupied: [...this._windows.values()].some(w => w.workspace === index),
    }));
    this._ports.indicator.setPills(this._copyPills());
    if (this._disposed) return;
    this._ports.decorations.apply(decorationPlan({
      roots: decoRoots,
      rects: this._containerRects,
      windows: this._windows,
      focused: decoFocused,
      rowHeight: this._rowHeight,
      borderWidth: this._config.defaultBorder.width,
      borderOverrides: this._borderOverrides,
    }));
    if (this._disposed) return;
    this._revision++;
    for (const callback of [...this._listeners]) {
      if (this._disposed) return;
      try { callback(); } catch (error) {
        if (this._disposed) return;
        this._ports.log.warn(`tree subscriber failed: ${String(error)}`);
      }
    }
  }

  private _floating(info: WindowInfo): boolean {
    return this._manualFloating.get(info.id) ?? info.kind === 'floating';
  }

  private _syncWindow(id: WindowId, workspaceEvent = false): void {
    const info = this._ports.windows.get(id);
    if (!info) { this._forget(id); return; }
    const old = this._windows.get(id);
    this._windows.set(id, {...info, rect: {...info.rect}});
    if (old?.fullscreen && !info.fullscreen) this._forced.add(id);
    if (old?.minimized && !info.minimized) this._forced.add(id);
    const expected = this._expectedWorkspace.get(id);
    if (workspaceEvent) this._expectedWorkspace.delete(id);
    const tree = this._tree;
    if (!tree) return;
    const location = tree.location(id);
    if (info.minimized) {
      this._minimized.set(id, this._minimized.get(id) ?? this._floating(info));
      tree.remove(id);
    } else {
      const floating = this._minimized.get(id);
      if (floating !== undefined) { this._manualFloating.set(id, floating); this._minimized.delete(id); }
      const workspace = expected !== undefined && !workspaceEvent ? expected : info.workspace;
      if (location && location.workspace !== workspace) tree.remove(id);
      if (!tree.location(id) && tree.workspaces.has(workspace)) {
        const monitor = info.monitor !== null && tree.workspace(workspace).monitors.has(info.monitor)
          ? info.monitor : this._topology?.primary;
        if (monitor !== undefined && monitor !== null) {
          if (this._floating(info)) tree.addFloating(id, workspace);
          else tree.insert(id, workspace, monitor);
        }
      }
    }
    if (!info.fullscreen && !info.minimized && !this._floating(info)) {
      if (info.maximizedH || info.maximizedV) {
        const seen = (this._unmaximizeAttempts.get(id) ?? 0) + 1;
        this._unmaximizeAttempts.set(id, seen);
        if (seen > UNMAXIMIZE_OBSERVATIONS) {
          // A client that keeps its maximized state would otherwise stay out of
          // the layout forever, because _unmaximizing excludes it from expected.
          if (this._unmaximizing.delete(id))
            this._ports.log.warn(
              `window ${id} is still maximized ${seen} commits after its unmaximize request; tiling it as it is`);
        } else if (!this._unmaximizing.has(id)) {
          this._unmaximizing.add(id);
          const requested = this._ports.windows.unmaximize(id);
          if (this._disposed) return;
          if (!requested) this._unmaximizing.delete(id);
        }
      } else {
        this._unmaximizeAttempts.delete(id);
        if (this._unmaximizing.delete(id)) this._forced.add(id);
      }
    }
  }

  private _forget(id: WindowId): void {
    this._tree?.remove(id);
    this._windows.delete(id);
    this._manualFloating.delete(id);
    this._minimized.delete(id);
    this._expectedWorkspace.delete(id);
    this._expectedFocus.delete(id);
    this._unmaximizing.delete(id);
    this._unmaximizeAttempts.delete(id);
    this._forced.delete(id);
    this._floatingRects.delete(id);
    this._borderOverrides.delete(id);
    this._reconciler.forget(id);
    const read = this._frameReads.get(id);
    if (read) this._ports.deferred.cancel(read.token);
    this._frameReads.delete(id);
    if (this._lastFocus === id) this._lastFocus = null;
  }

  /**
   * Returns true when the observation queued a corrective re-apply, so a frame
   * notification for a window already at its target costs nothing: measured at
   * ~2 commits per floating move, half of which were this echo.
   */
  private _observe(id: WindowId, generation: number | undefined): boolean {
    const info = this._ports.windows.get(id);
    if (!info || info.fullscreen || info.minimized || this._floating(info) || this._unmaximizing.has(id)) return false;
    if (generation === undefined) return false;
    return this._reconciler.observe(id, info.rect, generation);
  }

  private _selectWindow(id: WindowId): void {
    const tree = this._tree;
    const location = tree?.location(id);
    if (!tree || !location) return;
    if (location.floating) tree.selectFloating(id);
    else { const leaf = tree.find(id); if (leaf) tree.select(leaf); }
  }

  private _acceptFocus(id: WindowId | null): void {
    const expected = id !== null && this._expectedFocus.has(id);
    // Any native focus report resolves or supersedes the one pending request.
    this._expectedFocus.clear();
    const duplicate = id === this._lastFocus;
    this._lastFocus = id;
    if (id === null || !this._tree?.location(id)) return;
    if (!expected && !duplicate) this._selectWindow(id);
  }

  private _selectedIds(): WindowId[] {
    const selection = this._tree?.selection();
    return selection?.kind === 'floating' ? [selection.window] : selection?.kind === 'tiled'
      ? [...leaves(selection.con)].map(leaf => leaf.window) : [];
  }

  private _selectedWindow(): WindowId | null {
    const selection = this._tree?.selection();
    if (selection?.kind === 'floating') return selection.window;
    return selection?.kind === 'tiled' && selection.con.kind === 'leaf'
      ? selection.con.window : null;
  }

  private _selectionIsSplit(): boolean {
    const selection = this._tree?.selection();
    return selection?.kind === 'tiled' && selection.con.kind === 'split';
  }

  private _floatingFrame(commandFrames: ReadonlyMap<WindowId, Rect>): {id: WindowId; info: WindowInfo} | null {
    const selection = this._tree?.selection();
    if (selection?.kind !== 'floating') return null;
    const info = this._ports.windows.get(selection.window);
    const rect = commandFrames.get(selection.window);
    return info ? {id: selection.window, info: rect ? {...info, rect: {...rect}} : info} : null;
  }

  private _queueFloatingFrame(id: WindowId, rect: Rect, commandFrames: Map<WindowId, Rect>): boolean {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 || rect.height <= 0) return false;
    this._floatingRects.set(id, {...rect});
    commandFrames.set(id, {...rect});
    return true;
  }

  private _activateSelection(timestamp: number): void {
    const selection = this._tree?.selection();
    const id = selection?.kind === 'floating' ? selection.window : selection?.kind === 'tiled'
      ? descendFocused(selection.con)?.window : undefined;
    this._expectedFocus.clear();
    if (id === undefined) return;
    this._expectedFocus.add(id);
    const activated = this._ports.windows.activate(id, timestamp);
    if (this._disposed) return;
    if (!activated) this._expectedFocus.delete(id);
  }

  private _moveReconfigured(moves: ReadonlyMap<WindowId, number>): void {
    for (const [id, destination] of moves) this._expectedWorkspace.set(id, destination);
    for (const [id, destination] of moves) {
      const moved = this._ports.windows.moveToWorkspace(id, destination);
      if (this._disposed) return;
      if (!moved) this._expectedWorkspace.delete(id);
    }
  }

  private _raiseChanged(): void {
    if (!this._tree) return;
    const active = new Set<number>();
    let raised = false;
    for (const ws of this._tree.workspaces.values()) {
      for (const root of ws.monitors.values()) {
        if (![...walk(root)].some(con => con.kind === 'split' && (con.layout === 'tabbed' || con.layout === 'stacked'))) continue;
        active.add(root.id);
        const order = stackingOrder(root);
        const key = order.join(',');
        if (this._raiseOrders.get(root.id) === key) continue;
        this._raiseOrders.set(root.id, key);
        for (const id of order) {
          this._ports.windows.raise(id);
          if (this._disposed) return;
        }
        raised = true;
      }
    }
    for (const id of this._raiseOrders.keys()) if (!active.has(id)) this._raiseOrders.delete(id);
    if (raised && this._lastFocus !== null && this._tree.location(this._lastFocus)?.floating)
      this._ports.windows.raise(this._lastFocus);
  }

  state(): EngineState {
    const l = this._loaded;
    return {
      mode: this._mode,
      activeWorkspace: this._ports.workspaces.activeIndex,
      workspaceCount: this._ports.workspaces.count,
      grabbed: this._ports.keys.grabbedCount,
      configSource: l.source,
      configPath: l.path,
      errors: l.diagnostics.filter(d => d.severity === 'error').length,
      warnings: l.diagnostics.filter(d => d.severity === 'warning').length,
      pills: this._copyPills(),
    };
  }

  /** A grabbed accelerator fired. */
  onBinding(binding: Binding, timestamp: number): void {
    const {commands, diagnostics} = parseCommands(binding.command);
    for (const d of diagnostics)
      this._ports.log.warn(`config line ${binding.line}: ${d}`);
    this.run(commands, timestamp);
  }

  /** Executes commands in order; returns a short human-readable result (also the D-Bus reply). */
  run(commands: Command[], timestamp: number): string {
    if (this._disposed) return 'stopped';
    const commandFrames = new Map<WindowId, Rect>();
    const messages = commands.map(c => this._runOne(c, timestamp, commandFrames)).filter(m => m !== '');
    return messages.length > 0 ? messages.join('; ') : 'ok';
  }

  onLocked(): void {
    if (!this._started || this._disposed) return;
    this._locked = true;
    this._ports.indicator.setVisible(false);
    this._enterMode('default');
    this._ports.keys.ungrabAll();
  }

  onUnlocked(): void {
    if (!this._started || this._disposed) return;
    this._locked = false;
    this._ports.indicator.setVisible(true);
    if (this._disposed) return;
    this._ports.keys.setBindings(this._modeBindings('default'));
    if (this._disposed) return;
    this.commit(() => {
      for (const id of this._windows.keys()) {
        this._observe(id, this._reconciler.generation(id));
        if (this._disposed) return false;
      }
    });
  }

  private _copyPills(): PillState[] {
    return this._pills.map(pill => ({...pill}));
  }

  private _modeBindings(name: string): Binding[] {
    return this._config.modes.get(name)?.bindings ?? [];
  }

  private _enterMode(name: string): boolean {
    if (!this._config.modes.has(name)) {
      this._ports.log.warn(`mode "${name}" is not defined`);
      return false;
    }
    this._mode = name;
    if (!this._locked)
      this._ports.keys.setBindings(this._modeBindings(name));
    this._ports.indicator.setMode(name === 'default' ? null : name);
    return true;
  }

  /** Logs diagnostics, then either rejects (keeping the running config) or activates the new config. */
  private _applyLoaded(loaded: LoadedConfig): boolean {
    const errors = loaded.diagnostics.filter(d => d.severity === 'error');
    const warnings = loaded.diagnostics.filter(d => d.severity === 'warning');
    for (const e of errors)
      this._ports.log.warn(`config error line ${e.line}: ${e.message}`);
    for (const w of warnings)
      this._ports.log.warn(`config warning line ${w.line}: ${w.message}`);

    if (!loaded.config) {
      const first = errors[0];
      this._ports.notify('i3-shell: config rejected', first ? `line ${first.line}: ${first.message}` : 'unknown error');
      return false;
    }

    const config = loaded.config;
    const count = config.workspaceCount || this._ports.workspaces.count;
    if (!Number.isInteger(count) || count < 1 || count > 36) {
      this._ports.notify('i3-shell: config rejected', 'workspace count must be between 1 and 36');
      return false;
    }
    this.commit(() => {
      this._loaded = loaded;
      this._lastLoadTime = this._ports.now();
      this._config = config;
      this._workspaceCount = count;
      if (this._tree && this._topology) {
        const moves = this._tree.reconfigure(count, this._topology.monitors.map(m => m.id), this._topology.primary);
        for (const info of this._windows.values()) if (info.workspace >= count) moves.set(info.id, count - 1);
        this._moveReconfigured(moves);
        if (this._disposed) return;
      }
      this._ports.settings.apply(config, count);
      if (this._disposed) return;
      this._mode = 'default';
      if (!this._locked) {
        const report = this._ports.keys.setBindings(this._modeBindings('default'));
        if (this._disposed) return;
        if (report.failed.length > 0)
          this._ports.log.warn(`${report.failed.length} binding(s) could not be grabbed`);
      }
      this._ports.indicator.setMode(null);
      if (this._disposed) return;
      this._pushColors();
      if (this._disposed) return;
      this._ports.indicator.setVisible(!this._locked);
      if (this._disposed) return;

      if (warnings.length > 0)
        this._ports.notify('i3-shell', `${warnings.length} config warning(s) — see the shell log`);
      if (this._config.rules.length > 0)
        this._ports.log.info(`${this._config.rules.length} for_window rule(s) parsed; they are applied from Phase 4`);
      if (loaded.source === 'cache')
        this._ports.notify('i3-shell', 'using the last good config (the current file was rejected)');
      else if (loaded.source === 'fallback')
        this._ports.notify('i3-shell', 'using the built-in fallback config');
    });
    return true;
  }

  /** i3 workspace target → GNOME workspace index, or null when it does not exist (§9). */
  private _workspaceIndex(target: WorkspaceTarget): number | null {
    const count = this._ports.workspaces.count;
    const current = this._ports.workspaces.activeIndex;
    switch (target.kind) {
      case 'number':
        return target.number >= 1 && target.number <= count ? target.number - 1 : null;
      case 'name': {
        for (const [number, name] of this._config.workspaceNames) {
          if (name === target.name)
            return number - 1;
        }
        if (/^\d+$/.test(target.name)) {
          const number = parseInt(target.name, 10);
          return number >= 1 && number <= count ? number - 1 : null;
        }
        return null;
      }
      case 'next':
        return current + 1 < count ? current + 1 : null;
      case 'prev':
        return current > 0 ? current - 1 : null;
      case 'back_and_forth':
        return null;
    }
  }

  private _runOne(command: Command, timestamp: number, commandFrames: Map<WindowId, Rect>): string {
    const ports = this._ports;
    switch (command.type) {
      case 'exec':
        ports.exec(command.command);
        return `exec ${command.command}`;
      case 'kill': {
        const ids = this._selectedIds().filter(id => ports.windows.get(id) !== undefined);
        return ids.map(id => ports.windows.kill(id, timestamp)).some(Boolean) ? 'kill' : 'kill: no focused window';
      }
      case 'fullscreen': {
        if (this._selectionIsSplit()) {
          ports.log.warn('fullscreen applies only to individual windows');
          return 'fullscreen: selected container is not a window';
        }
        const id = this._selectedWindow();
        return id !== null && ports.windows.get(id) !== undefined && ports.windows.fullscreen(id, command.action)
          ? `fullscreen ${command.action}` : 'fullscreen: no focused window';
      }
      case 'workspace': {
        if (command.target.kind === 'back_and_forth')
          return 'workspace back_and_forth: not implemented until Phase 4';
        const index = this._workspaceIndex(command.target);
        if (index === null)
          return 'workspace: no such workspace';
        if (index === ports.workspaces.activeIndex)
          return 'workspace: already active';
        return ports.workspaces.activate(index, timestamp)
          ? `workspace ${index + 1}` : 'workspace: activation failed';
      }
      case 'move_to_workspace': {
        if (command.target.kind === 'back_and_forth')
          return 'move container to workspace back_and_forth: not implemented until Phase 4';
        const index = this._workspaceIndex(command.target);
        if (index === null)
          return 'move container to workspace: no such workspace';
        if (index === ports.workspaces.activeIndex)
          return 'move container to workspace: already there';
        let moved = false;
        this.commit(() => {
          if (!this._tree || !this._topology) return false;
          const ids = this._tree.moveToWorkspace(index, this._topology.primary);
          moved = ids.length > 0;
          if (!moved) return false;
          this._moveReconfigured(new Map(ids.map(id => [id, index])));
          if (this._disposed) return false;
          this._activateSelection(timestamp);
          return true;
        });
        return moved ? `moved to workspace ${index + 1}` : 'move container to workspace: no focused window';
      }
      case 'focus': {
        let changed = false;
        this.commit(() => {
          const tree = this._tree;
          if (!tree) return false;
          if (command.target === 'parent') {
            changed = tree.focusParent() !== null;
            return changed;
          }
          if (command.target === 'child') {
            changed = tree.focusChild() !== null;
            if (changed) this._activateSelection(timestamp);
            return changed;
          }
          if (command.target === 'mode_toggle') {
            changed = tree.focusModeToggle() !== null;
            if (changed) this._activateSelection(timestamp);
            return changed;
          }
          changed = tree.focus(command.target, this._config.focusWrapping) !== null;
          if (changed) this._activateSelection(timestamp);
          return changed;
        });
        return changed ? `focus ${command.target}` : `focus ${command.target}: no target`;
      }
      case 'move': {
        let moved = false;
        this.commit(() => {
          moved = this._tree?.move(command.direction) ?? false;
          if (moved) this._activateSelection(timestamp);
          return moved;
        });
        return moved ? `move ${command.direction}` : `move ${command.direction}: no target`;
      }
      case 'split': {
        let changed = false;
        this.commit(() => {
          const selection = this._tree?.selection();
          if (selection?.kind !== 'tiled') return false;
          this._tree!.split(command.orientation);
          changed = true;
          return true;
        });
        return changed ? `split ${command.orientation}` : `split ${command.orientation}: no tiled container`;
      }
      case 'layout': {
        let changed = false;
        this.commit(() => {
          const selection = this._tree?.selection();
          if (selection?.kind !== 'tiled') return false;
          this._tree!.setLayout(command.layout);
          changed = true;
          return true;
        });
        return changed ? `layout ${command.layout}` : `layout ${command.layout}: no tiled container`;
      }
      case 'layout_toggle': {
        let changed = false;
        this.commit(() => {
          const selection = this._tree?.selection();
          if (selection?.kind !== 'tiled') return false;
          this._tree!.toggleLayout(command.cycle);
          changed = true;
          return true;
        });
        return changed ? 'layout toggle' : 'layout toggle: no tiled container';
      }
      case 'resize': {
        let changed = false;
        this.commit(() => {
          const floating = this._floatingFrame(commandFrames);
          if (floating) {
            const delta = command.action === 'grow' ? command.px : -command.px;
            const rect = {...floating.info.rect};
            if (command.dimension === 'width') rect.width += delta;
            else rect.height += delta;
            changed = this._queueFloatingFrame(floating.id, rect, commandFrames);
            return changed;
          }
          changed = this._tree?.resize(command, this._containerRects) ?? false;
          return changed;
        });
        return changed ? `resize ${command.action} ${command.dimension}` : 'resize: no change';
      }
      case 'resize_set': {
        let changed = false;
        this.commit(() => {
          const floating = this._floatingFrame(commandFrames);
          if (!floating) return false;
          changed = this._queueFloatingFrame(floating.id, {
            ...floating.info.rect, width: command.width, height: command.height,
          }, commandFrames);
          return changed;
        });
        if (!changed) ports.log.warn('resize set applies only to a tracked floating window');
        return changed ? 'resize set' : 'resize set: no floating window';
      }
      case 'move_position': {
        let changed = false;
        this.commit(() => {
          const floating = this._floatingFrame(commandFrames);
          if (!floating || !this._topology) return false;
          let position: {x: number; y: number};
          if (command.position === 'center') {
            const monitor = floating.info.monitor ?? this._topology.primary;
            const area = this._topology.workAreas.get(floating.info.workspace)?.get(monitor);
            if (!area) return false;
            position = {
              x: area.x + Math.round((area.width - floating.info.rect.width) / 2),
              y: area.y + Math.round((area.height - floating.info.rect.height) / 2),
            };
          } else position = command.position;
          changed = this._queueFloatingFrame(floating.id, {...floating.info.rect, ...position}, commandFrames);
          return changed;
        });
        if (!changed) ports.log.warn('move position applies only to a tracked floating window');
        return changed ? 'move position' : 'move position: no floating window';
      }
      case 'floating': {
        let changed = false;
        let split = false;
        this.commit(() => {
          const tree = this._tree;
          const id = this._selectedWindow();
          if (!tree || id === null) {
            split = this._selectionIsSplit();
            return false;
          }
          const info = ports.windows.get(id);
          const location = tree.location(id);
          if (!info || !location) return false;
          const enabled = command.action === 'toggle' ? !location.floating : command.action === 'enable';
          if (enabled === location.floating) return false;
          const workspace = tree.workspace(location.workspace);
          const monitor = location.monitor !== null && workspace.monitors.has(location.monitor)
            ? location.monitor
            : info.monitor !== null && workspace.monitors.has(info.monitor)
              ? info.monitor : this._topology?.primary;
          if (monitor === undefined) return false;
          this._manualFloating.set(id, enabled);
          tree.setFloating(id, enabled, monitor);
          if (enabled) {
            this._reconciler.forget(id);
            this._queueFloatingFrame(id, info.rect, commandFrames);
          }
          changed = true;
          return true;
        });
        if (split) ports.log.warn('floating applies only to individual windows');
        return changed ? `floating ${command.action}` : `floating ${command.action}: no change`;
      }
      case 'border': {
        const selection = this._tree?.selection();
        const targets = selection?.kind === 'tiled' ? [...leaves(selection.con)] : [];
        if (targets.length === 0) return `border ${command.style}: no tiled container`;
        for (const target of targets) {
          const width = command.style === 'toggle'
            ? (this._borderOverrides.get(target.window) ?? this._config.defaultBorder.width) > 0
              ? 0 : this._config.defaultBorder.width
            : command.style === 'none' ? 0 : command.width;
          this.setBorder(target.window, width);
        }
        return `border ${command.style}`;
      }
      case 'mode':
        return this._enterMode(command.name) ? `mode ${command.name}` : `mode "${command.name}" is not defined`;
      case 'reload':
        return this._applyLoaded(ports.loadConfig('reload')) ? 'reloaded' : 'reload: config rejected, keeping previous';
      case 'restart':
        if (!this._applyLoaded(ports.loadConfig('reload'))) return 'restart: config rejected, keeping previous';
        this.commit(() => {
          this._tree = null;
          this._manualFloating.clear();
          this._minimized.clear();
          this._raiseOrders.clear();
          this._lastFocus = null;
        });
        return 'restarted';
      case 'nop':
        return 'nop';
      case 'unknown':
        ports.log.warn(`unknown command: ${command.text}`);
        return `unknown command: ${command.text}`;
    }
  }
}
