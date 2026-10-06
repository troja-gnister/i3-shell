import {Tree} from './tree/tree';
import {descendFocused, leaves, walk, type Con, type MonitorId, type NodeId, type Rect, type SplitCon, type WindowId} from './tree/node';
import {effectiveWorkspaceCount, resolveOutputArg, type OutputArg} from './tree/outputs';
import {layoutWithRects, stackingOrder} from './tree/layout';
import {cycleWorkspace} from './tree/cycle';
import {fixFloatingCoordinates} from './tree/floating';
import {RectReconciler} from './runtime/reconcile';
import {serializeTree, type TreeSnapshot, type WindowSnapshot} from './runtime/snapshot';
import {decorationPlan, type DecorationPlan} from './runtime/decoration';
import type {WindowsPort, GeometryPort, DeferredPort, PillState, Topology, WindowInfo, WindowEvent} from './runtime/model';
import {LIVE_WORKSPACE, ATTIC_WORKSPACE} from './runtime/model';
import {displayWorkspaceName} from './config/workspaceNames';
import {excludedFromTree} from './runtime/classify';
import {matchesCriteria} from './runtime/rules';
import {isDirection, parseCommands} from './commands/parse';
import type {Command, WorkspaceTarget} from './commands/model';
import type {LauncherRequest} from './launcher/model';
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
    /**
     * Every live output's own pills, keyed by output -- i3bar's focused/visible distinction cannot be
     * expressed as one flat list once two outputs are both on screen (spec 4.3, Task 8).
     */
    setPills(byOutput: ReadonlyMap<MonitorId, readonly PillState[]>): void;
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
   * never has to infer teardown on its own. `setColors` mirrors the
   * indicator's: the same effectiveColors() result _pushColors() computes
   * goes to both, so a border and the workspace pill never disagree.
   */
  decorations: {apply(plan: DecorationPlan): void; setColors(colors: Colors): void};
  /**
   * The launcher is told WHERE to draw; it never decides. The engine resolves
   * the monitor from its own tree, because the only other source GNOME offers
   * -- Main.layoutManager.currentMonitor -- is the POINTER's monitor, and a
   * keyboard-driven user's pointer is routinely on the other screen. That is
   * the entire defect this feature exists to fix.
   */
  launcher: {
    open(request: LauncherRequest): void;
    close(): void;
    setColors(colors: Colors): void;
    /**
     * Fix round 1, C1: queried, not mirrored. `Launcher` closes itself at seven sites the engine never
     * hears about (a toggling second `open()`, a dismiss, three launch paths, a deferred key-focus-out
     * and `destroy()`) and abandons without opening when its modal grab is refused, so an engine-side
     * flag set on the `launcher` command and cleared only where the engine itself calls `close()` would
     * latch `true` after the first ordinary use and silently disable `_warpToFocusedOutput` for the
     * rest of the session. This asks the launcher's own state instead.
     */
    isOpen(): boolean;
  };
  /**
   * i3's `mouse_warping output`: when a keyboard command moves the focused output, the pointer follows
   * it, or sloppy focus (focus-mode = sloppy) would immediately drag focus back to whatever sits under
   * the stationary pointer. Told a rect, never a monitor -- the engine already resolved which one; see
   * `_warpToFocusedOutput`. Kept as an inline shape rather than importing `PointerPort` from
   * `src/shell/pointer.ts`: `engine.ts` is one of the roots `check-layer0.mjs` scans for imports under
   * `src/shell/`, so this shape and that interface are duplicated on purpose and must be kept in sync
   * by hand -- see the comment on `PointerPort` itself.
   */
  pointer: {warpTo(rect: Rect): void};
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
  /** The output the tree considers focused, read by Task 17's native scenarios. Null before the tree exists. */
  focusedOutput: MonitorId | null;
}

/**
 * Task 23, D7: why a window the tree has not seen is entering it, which is the only thing that decides
 * which workspace it joins (see `_adoptionWorkspace`). 'startup' is the commit that builds the tree --
 * enable, or `restart` -- and nothing else; `_syncWindow` defaults to 'live' so a caller that forgets
 * gets i3's semantics rather than the compositor's.
 */
type Adoption = 'live' | 'startup';

export class Engine {
  private _config!: Config;
  private _loaded!: LoadedConfig;
  private _mode = 'default';
  private _locked = false;
  private _started = false;
  private _disposed = false;
  private _closing = false;
  private _lastLoadTime = 0;
  private _workspaceCount = 1;
  private _tree: Tree | null = null;
  /** Every live output's own pills, rebuilt each commit; `_flatPills` is the same data, flattened. */
  private _pillsByOutput: Map<MonitorId, PillState[]> = new Map();
  /** `state().pills`'s flat, workspace-ordered shape -- the stable `GetState` surface. */
  private _flatPills: PillState[] = [];
  private _topology: Topology | null = null;
  private _ready = false;
  private _revision = 0;
  private _committing = false;
  private readonly _queued: Array<() => boolean | void> = [];
  private readonly _windows = new Map<WindowId, WindowInfo>();
  private readonly _manualFloating = new Map<WindowId, boolean>();
  /** State a window that leaves the tree (minimized, sticky, or skip-taskbar) keeps until it returns. */
  private readonly _minimized = new Map<WindowId, {floating: boolean; workspace: number | undefined}>();
  private readonly _expectedFocus = new Set<WindowId>();
  private _lastFocus: WindowId | null = null;
  /**
   * D8: the output the engine last pointed the focus at by changing what that output shows.
   * `_armInvoluntaryFocus` records it, `_involuntaryFocus` re-derives from it whether a native focus
   * report is the compositor's own doing; see both for the whole of the rule.
   */
  private _shownOnFocusedOutput: MonitorId | null = null;
  private readonly _unmaximizing = new Set<WindowId>();
  private readonly _unmaximizeAttempts = new Map<WindowId, number>();
  private readonly _forced = new Set<WindowId>();
  private _monitorInvalidation = false;
  private readonly _reconciler = new RectReconciler();
  private _containerRects = new Map<Con, Rect>();
  private _rowHeight = 0;
  private readonly _borderOverrides = new Map<WindowId, number>();
  private readonly _floatingRects = new Map<WindowId, Rect>();
  /**
   * Task 1: for each floating frame `_followFloatingFrames` has carried, the output it was carried `from`
   * and the output it was carried `to`. It is what stops a level-triggered pass from carrying the same
   * frame twice, and it says "already carried", which is the fact that matters. Geometry cannot say it: a
   * frame straddling an output boundary has its origin on the destination side before anything has moved
   * it, and a window near the seam between a 1728-wide panel and a 1920-wide display is the ordinary case,
   * not an exotic one.
   *
   * `from` is why the entry has two fields (fix round 2, I5). The record ends on the first report of any
   * monitor OTHER than `from`, not on a report of `to`: a frame may never be observed at `to` at all -- a
   * client can refuse the rect, and then the compositor goes on reporting the output the frame started on
   * -- and keying the end on `to` alone left the suppression in place after the uncertainty had been
   * resolved by some third output, which silently swallowed the next genuine carry back to `to`.
   */
  private readonly _carriedFloating = new Map<WindowId, {from: MonitorId; to: MonitorId}>();
  /** window -> indexes into Config.rules that have already fired for it. */
  private readonly _firedRules = new Map<WindowId, Set<number>>();
  private readonly _frameReads = new Map<WindowId, {token: number; generation: number | undefined}>();
  private readonly _listeners = new Set<() => void>();
  private readonly _raiseOrders = new Map<number, string>();


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
      // untouched, so this deliberately does not run a commit. It bypasses
      // commit() entirely, so it needs its own _closing check: gating
      // commit() alone would not stop this push.
      if (!this._disposed && this._started && !this._closing) this._pushColors();
    });
    this._applyLoaded(loaded);
  }

  private _pushColors(): void {
    const colors = effectiveColors(this._config.colors, this._config.specifiedColors, this._ports.accent.current());
    this._ports.indicator.setColors(colors);
    this._ports.decorations.setColors(colors);
    this._ports.launcher.setColors(colors);
  }

  /**
   * Meta.Display::closing has fired: the session is tearing down and GNOME
   * will start destroying its own windows and actors underneath the
   * extension, ahead of disable(). Unlike stop() this is not the teardown
   * path -- it does not cancel grabs or deferred reads, only stops new work
   * from reaching commit() (which covers every deferred continuation, not
   * just the signals that call it synchronously) and stops the accent
   * subscription's direct port push.
   */
  onClosing(): void {
    this._closing = true;
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
      return {version: 2, revision: this._revision, ready: false,
        activeWorkspace: this._ports.workspaces.activeIndex, focusedOutput: null, visible: [], workspaces: []};
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
        //
        // Task 20, D6: a floating window is exempt from reconciliation, so `_observe` returns false for
        // every frame it reports and the commit used to publish nothing at all -- which meant
        // `_syncWindow` never ran and the engine never learned that a *drag* had carried the window to
        // another display. The second disjunct is that one fact, and nothing more; `_observe` still runs
        // first, since it owns the corrective re-apply, and the re-home itself is `_syncWindow`'s.
        if (read) this.commit(() => {
          const reconciling = this._observe(event.id, read.generation);
          return reconciling || this._crossedOutput(event.id);
        });
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
        this._syncWindow(event.id);
        if (event.type === 'added' || event.type === 'title') this._applyRules(event.id, 0);
      }
    });
  }

  /**
   * Task 19, D2. Mutter emits `active-workspace-changed` from inside `workspace.activate()`, before
   * `get_active_workspace_index()` reports the new index -- and the switch itself lands a main-loop turn
   * later, so the index is stale for the whole of the handler below. The correction therefore re-entered
   * itself: 3376 corrections in four seconds at every login, ending in repeated `JS ERROR: too much
   * recursion` inside the compositor.
   *
   * The guard lives here, not in `src/shell/workspaces.ts`, because this is the only layer that can tell
   * the two apart. The loop is a policy loop -- the handler's own response to the signal is what raises
   * the signal -- and `LIVE_WORKSPACE` is this layer's notion: the adapter forwards a signal and has no
   * idea that any particular re-emission wants correcting, so suppressing it there would be a blanket
   * deafness during `activate()` that also silences the `n-workspaces` branch below. Held here it also
   * holds for every `WorkspacesPort` implementation rather than for one adapter, and it is provable by
   * the unit suite, which does not typecheck `src/shell` at all.
   */
  private _correctingActiveWorkspace = false;

  onWorkspacesChanged(): void {
    // Our own `activate()` below is still on the stack: this signal is the one it just caused, so
    // correcting again would be correcting a change nobody made. A genuine gesture's signal never
    // arrives inside that window.
    if (this._correctingActiveWorkspace) return;
    this.commit(() => {
      // GNOME's active workspace is a constant while the extension is enabled. Touchpad workspace
      // gestures have no GSetting to clear, so this is the only cover for them.
      //
      // Fix round 1, B2: `src/shell/gestures.ts` now answers EVENT_STOP for the three-finger horizontal
      // swipe it recognises, so for THAT gesture GNOME's tracker never runs and this no longer has to
      // correct anything -- preventing beats undoing, and undoing it would have flashed the attic's
      // windows on every swipe. This stays, and stays the only cover, for every swipe that file does not
      // claim: a vertical three-finger swipe, any other finger count, and whatever a future Shell adds.
      if (this._started && !this._disposed && this._ports.workspaces.activeIndex !== LIVE_WORKSPACE) {
        this._ports.log.warn('active workspace left live; switching back');
        this._correctingActiveWorkspace = true;
        try {
          if (!this._ports.workspaces.activate(LIVE_WORKSPACE, 0))
            this._ports.log.warn('could not switch the active workspace back to live');
        } finally {
          this._correctingActiveWorkspace = false;
        }
      }
      // GNOME's own workspace count is always two now (live + attic), independent of the config's
      // i3 workspace count, which the settings port never sees translated 1:1 into GNOME any more.
      if (this._ports.workspaces.count !== 2)
        this._ports.settings.apply(this._config, this._workspaceCount);
    });
  }

  onMonitorsChanged(): void {
    // The fourteenth close path, and the one nobody reaches on purpose: the
    // launcher is drawn at an absolute position on a monitor that has just
    // stopped existing. Close the lid, or pull the cable, with the launcher
    // open on the external display and the actor keeps that position -- now
    // off-stage -- while its POPUP-mode grab is still held. Every i3-shell
    // binding is dead and there is nothing on screen to explain why. `reload`
    // and `restart` below close for the same reason; a monitor change is the
    // only one of the three the user does not initiate.
    this._ports.launcher.close();
    this.commit(() => { this._monitorInvalidation = true; });
  }

  /**
   * Rule 4 of the focused-output state: the pointer crossed onto `output`, so that is the display the
   * user is on.
   *
   * Task 19, D4: this used to fire only for an output whose visible workspace was *empty*, on the
   * reasoning that sloppy focus (rule 1) owned the populated case and two mechanisms racing would flap.
   * Sloppy focus does not own it: GNOME reports a focus change only when the pointer enters a *window*,
   * so crossing onto another display's gaps, bar or background reported nothing at all. With only the
   * empty case claimed, the focused output could drain onto whichever display showed an empty workspace
   * and the pointer could never bring it back -- measured on the user's desk as the focused output
   * reverting from the external display to the panel on its own. There is no flap, because neither
   * mechanism triggers the other: a focus report moves the focused output to the focused window's
   * display (D5), this moves it to the display under the pointer, and both agree wherever both apply.
   *
   * Fix round 1, folded item 1: gated on `focus_follows_mouse`. With it off, i3 treats pointer motion
   * as inert and `focus output` is how the user reaches another display; a rule that still followed
   * the pointer here would leave a documented setting half-effective in its least visible half.
   *
   * Fix round 1, folded item 4: gated on `_locked` too, for the same reason the `launcher` command is
   * -- pointer motion over a lock screen must not reassign the focused output underneath it.
   */
  onPointerOutput(output: MonitorId): void {
    if (!this._started || this._disposed || this._locked || !this._config.focusFollowsMouse) return;
    const tree = this._tree;
    if (!tree || tree.focusedOutput === output) return;
    // An output with no visible entry is not one the focus can sit on: `activeWorkspace` reads
    // `visible.get(focusedOutput)` and throws without one. `coverOutputs` makes that unreachable for a
    // live output; this keeps it unreachable for anything else the pointer can name.
    if (!tree.visible.has(output)) return;
    this.commit(() => {
      tree.focusedOutput = output;
      return true;
    });
  }

  /**
   * `onPointerOutput` in Mutter's own coordinate system. The shell reports the raw monitor index a
   * pointer signal carries; only the engine's topology can turn that into this project's stable
   * `MonitorId`, which is why the translation lives here rather than in `src/shell` (see Task 12's
   * brief: keeping `MonitorId` allocation out of `src/shell` is the point of this indirection).
   */
  onPointerMonitorIndex(index: number): void {
    const monitor = this._topology?.monitors.find(m => m.index === index);
    if (monitor) this.onPointerOutput(monitor.id);
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

  /**
   * Focuses one window by id -- what a click on its tab means. Like
   * setRowHeight() this is the shell asking the engine, not a port and not an
   * i3 command: i3 has no "focus that window" syntax, so widening the `focus`
   * command's target would invent one and drag it through the parser, the
   * config and the D-Bus surface for a click.
   *
   * The id is refused unless it is on the active workspace: only that
   * workspace has chrome on screen, and _activateSelection() reads the active
   * workspace's selection, so accepting one from elsewhere would focus
   * whatever that workspace had selected instead.
   */
  focusWindow(id: WindowId): void {
    this.commit(() => {
      const tree = this._tree;
      const location = tree?.location(id);
      // The click reaches here a main-loop turn after it happened (the
      // renderer defers it), so the window may have closed in between.
      if (!tree || !location || location.workspace !== tree.activeWorkspace) return false;
      this._selectWindow(id);
      // 0 = no native event timestamp: a deferred click no longer carries one,
      // and the windows adapter substitutes the current server time so
      // focus-stealing prevention cannot drop the activation.
      this._activateSelection(0);
      return true;
    });
  }

  /**
   * Show workspace `incoming` on `output`: validates, then makes `tree.visible`/`workspace.output` say
   * so, then delegates the window moves to `_parkAndShow` below, where the five-step account of what
   * actually happens now lives (this wrapper does none of those five itself).
   */
  private _showOnOutput(output: MonitorId, incoming: number): void {
    const tree = this._tree;
    if (!tree) return;
    const outgoing = tree.visible.get(output);
    // Not merely an optimisation: parking and immediately un-parking the same windows flashes them.
    if (outgoing === incoming) return;
    // Validated before any window is moved: tree.workspace() throws on an unknown index, and by then
    // the park loop would already have moved every outgoing window into the attic and tree.visible
    // would already point at a workspace that does not exist -- Tree.activeWorkspace and
    // _layoutAndPublish would throw on every commit after that, with no way back short of a restart.
    // `Tree.showWorkspace` guards the same thing for the `workspace` command's own call to
    // `_parkAndShow` below, by never returning without having already thrown on an unknown index.
    if (!tree.workspaces.has(incoming)) {
      this._ports.log.warn(`cannot show unknown workspace ${incoming} on output ${output}`);
      return;
    }
    this.commit(() => {
      tree.visible.set(output, incoming);
      tree.workspace(incoming).output = output;
      this._parkAndShow(outgoing, incoming);
      return true;
    });
  }

  /**
   * The window moves behind showing `incoming`, once whatever decided that -- `_showOnOutput` above
   * (for a given `output`), or `Tree.showWorkspace` (for the focused output, from the `workspace`
   * command) -- has already set `tree.visible` and `workspace.output` to match. Takes no output of its
   * own: every window it touches goes to LIVE or the attic, never to a specific output, so the caller's
   * output choice has nothing left for this method to act on. Callers must already be inside a
   * `commit()` closure: this method does not open one itself, so a caller can bracket it with tree
   * mutations of its own (as `workspace` does with `Tree.showWorkspace`) and still see one relayout,
   * not two. The five steps, in this order.
   *
   * 1. Collect `parked`: the outgoing workspace's members (empty if there was no outgoing workspace).
   * 2. Collect `arriving`: the incoming workspace's members.
   * 3. Move every arriving window onto LIVE, warning (naming the window) rather than throwing if
   *    Mutter refuses one.
   * 4. Move every parked window into the attic, the same way.
   * 5. `_activateSelection`, with one piece of tree-only bookkeeping immediately before it for an
   *    incoming workspace with no window (below): the subtle step.
   *
   * Step 5 is the subtle one. Parking the focused window makes Mutter pick a replacement on its own,
   * which arrives as an unexpected focus report. There is no pre-registration that can suppress it:
   * `_expectedFocus` holds ids we *asked* to focus, and Mutter's replacement is a still-visible
   * window, never one of the ids being parked -- so bracketing the parking with it, as an earlier
   * version of this method did, could never match the report it was meant to catch. Provided the
   * incoming workspace has a selection *and* the trailing `_activateSelection` below succeeds in
   * activating it, that call settles things: its own report arrives last (native reports are FIFO
   * relative to this synchronous method, and this one is queued after any replacement's) and
   * re-selects the intended window regardless of what an earlier unexpected report did. Two residuals
   * are unverified by any test here: such an earlier report can transiently re-select on a
   * *different* workspace than the one this swap is showing, and if `_activateSelection` never
   * activates -- an empty incoming workspace (handled below), or Mutter refusing the activate
   * request -- the replacement pick stands, since nothing follows it. Both are out of reach of a
   * synchronous fake; Task 17's native harness is what can show whether Mutter actually produces one.
   * Native focus for an empty incoming workspace is Task 13's job (spec §4.1): step 5's tree-only
   * bookkeeping only makes the *tree* agree that the incoming workspace's root is selected, so
   * `activeWorkspace`, the selection and the pills are right regardless of whether anything native
   * follows.
   */
  private _parkAndShow(outgoing: number | undefined, incoming: number): void {
    const tree = this._tree;
    if (!tree) return;
    const parked = outgoing === undefined ? [] : this._workspaceMembers(tree, outgoing);
    const arriving = this._workspaceMembers(tree, incoming);
    for (const id of arriving)
      if (!this._ports.windows.moveToWorkspace(id, LIVE_WORKSPACE))
        this._ports.log.warn(`could not show window ${id}; leaving it parked`);
    for (const id of parked)
      if (!this._ports.windows.moveToWorkspace(id, ATTIC_WORKSPACE))
        this._ports.log.warn(`could not park window ${id}; leaving it on screen`);
    if (arriving.length === 0) tree.select(tree.workspace(incoming).root);
    // 0 = no native event timestamp; the windows adapter substitutes the current server time.
    this._activateSelection(0);
  }

  /**
   * Test-only entry point for `_showOnOutput`, which has no production caller of its own -- the
   * `workspace` command drives `_parkAndShow` directly, through `Tree.showWorkspace` instead, and
   * neither Task 14 (`move`/`focus` crossing an output edge, via `Tree.moveIntoOutput`/`enterOutput`)
   * nor Task 15 (`move container/workspace to output`) turned out to need it either: `_showOnOutput`
   * sets `tree.visible`/`workspace.output` with no `coverOutputs` repair for the output a workspace
   * moved away from, which is exactly the gap `Tree.moveWorkspaceToOutput` exists to close. It is
   * exercised only through this test-only wrapper, driven by Task 6's swap tests; whether it should
   * still exist is for a later review to decide.
   */
  showOnOutputForTest(output: MonitorId, incoming: number): void {
    this._showOnOutput(output, incoming);
  }

  /**
   * Focuses one container by node id -- what a click on the tab of a *nested*
   * container means. Such a tab titles no window of its own (its plan entry's
   * `window` is null; it shows the container's focused descendant's title),
   * so its nodeId is the only thing the click can report.
   *
   * Like focusWindow() this is the shell asking the engine, not a port and not
   * an i3 command, and it lands on the same place i3 does: the container's
   * focused leaf. Selecting the *container* would activate the same window but
   * would also make the selection a SplitCon, drawing the `$mod+a` outline
   * around it -- which no tab click should produce.
   *
   * The node is refused unless it is on the active workspace, for the reason
   * focusWindow() gives: only that workspace has chrome on screen, and
   * _activateSelection() reads the active workspace's selection.
   */
  focusNode(nodeId: NodeId): void {
    this.commit(() => {
      const tree = this._tree;
      if (!tree) return false;
      // Searching only the active workspace's root is what enforces the
      // refusal: a node anywhere else is simply never found.
      const workspace = tree.workspaces.get(tree.activeWorkspace);
      let target: Con | null = null;
      if (workspace) for (const con of walk(workspace.root)) if (con.id === nodeId) target = con;
      // The click reaches here a main-loop turn after it happened (the
      // renderer defers it), so the container may have been flattened away.
      const leaf = target ? descendFocused(target) : null;
      if (!leaf) return false;
      tree.select(leaf);
      // 0 = no native event timestamp, as in focusWindow().
      this._activateSelection(0);
      return true;
    });
  }

  relayout(): void {
    this.commit(() => {
      for (const id of this._windows.keys()) this._observe(id, this._reconciler.generation(id));
    });
  }

  /** Native callbacks may enqueue work, but never mutate a tree during its traversal. */
  private commit(change: () => boolean | void = () => {}): void {
    if (!this._started || this._disposed || this._closing) return;
    this._queued.push(change);
    if (this._committing) return;
    this._committing = true;
    try {
      while (this._queued.length && !this._disposed) {
        // D8: snapshotted per queued change rather than once per drain, because a focus report the
        // compositor raises from inside this change's own port calls is queued *behind* it and drains as
        // the next one -- so the arming below has to be in place before that one runs.
        const showing = this._tree ? new Map(this._tree.visible) : null;
        const changed = this._queued.shift()!();
        if (this._disposed) break;
        if (changed !== false) this._layoutAndPublish();
        this._armInvoluntaryFocus(showing);
      }
    } finally {
      this._committing = false;
    }
  }

  private _layoutAndPublish(): void {
    const topology = this._ports.geometry.topology();
    this._ready = !!topology && topology.monitors.length > 0 &&
      topology.monitors.every(m => topology.workAreas.has(m.id));
    const decoRoots: Array<{root: SplitCon; active: boolean}> = [];
    let decoFocused: Con | null = null;
    if (this._ready && topology) {
      const isNew = !this._tree;
      this._topology = topology;
      const outputs = topology.monitors.map(m => ({id: m.id, index: m.index}));
      // The Tree clamps its own count to at least one workspace per output (i3 creates one per output
      // at startup whatever the config names), so the comparison below must clamp identically or it is
      // permanently unequal and reconfigure runs on every commit. Same function, one definition.
      const wanted = effectiveWorkspaceCount(this._workspaceCount, outputs.length);
      let reconfigured = false;
      if (!this._tree)
        this._tree = new Tree(this._workspaceCount, outputs, topology.primary, this._pinnedOutputs());
      else if (this._tree.workspaces.size !== wanted ||
        this._tree.outputSignature() !== outputs.map(o => o.id).sort((a, b) => a - b).join(',')) {
        reconfigured = true;
        this._moveReconfigured(
          this._tree.reconfigure(this._workspaceCount, outputs, topology.primary, this._pinnedOutputs()));
      }
      if (this._disposed) return;
      const tree = this._tree;
      const live = this._ports.windows.list();
      const ids = new Set(live.map(w => w.id));
      for (const id of this._windows.keys()) if (!ids.has(id)) this._forget(id);
      // Task 23, D7: `isNew` is the whole of the live-map/startup distinction, and it is not a new
      // source of truth -- it is the same local the selection restore below already reads. The commit
      // that BUILDS the tree is, by construction, the only one that adopts windows which predate the
      // tree: `windows.start()` runs before `engine.start()` (see src/extension.ts), so every 'added'
      // event for a pre-existing window is dropped by the `!this._started` guard in `onWindowEvent` and
      // those windows reach the engine only through `windows.list()` right here. `restart` nulls the
      // tree and lands in the same branch for the same reason. Every other adoption -- an 'added' event,
      // or a window that was sticky/skip-taskbar from birth and has only now become eligible -- happens
      // against a tree that already exists, and is a live map.
      for (const info of live) {
        this._syncWindow(info.id, isNew ? 'startup' : 'live');
        if (this._disposed) return;
      }
      if (isNew) {
        const restored = new Set<number>();
        for (const info of live) {
          const location = tree.location(info.id);
          if (info.minimized || !location || restored.has(location.workspace)) continue;
          this._selectWindow(info.id);
          restored.add(location.workspace);
        }
        this._acceptFocus(this._ports.windows.focused());
      }
      tree.normalize(new Set(live.filter(w => !excludedFromTree(w)).map(w => w.id)));
      // After a reconfigure, every window's native GNOME workspace is reconciled against the new
      // visibility. Deliberately after the sync loop above, not immediately after the reconfigure call:
      // windows enter the tree only in that loop, so at the earlier point a tree this commit just built
      // would have no members to reconcile at all.
      //
      // Round 1, I2: a freshly built tree needs no pass of its own. `_syncWindow` calls `_parkOrShow`
      // for every window entering the tree, and on the commit that builds it no window has a location
      // yet, so every member goes through that call; nothing between the sync loop and here changes
      // visibility (`_selectWindow` moves only the tree selection, `normalize` only prunes containers).
      // The `isNew` half of this gate could therefore only re-issue a port call already made.
      if (reconfigured) {
        this._reconcileParking(tree);
        if (this._disposed) return;
      }
      const expected = new Map<WindowId, Rect>();
      this._containerRects = new Map();
      // Only a visible workspace -- one per output -- is laid out. A parked workspace's windows are
      // not on screen, so their geometry is unobservable until the swap that shows them recomputes it
      // (Task 6, step 4).
      for (const output of topology.monitors) {
        const index = tree.visible.get(output.id);
        if (index === undefined) continue;
        const ws = tree.workspace(index);
        const layout = layoutWithRects(ws.root, topology.workAreas.get(output.id)!, this._rowHeight);
        for (const [con, rect] of layout.containers) this._containerRects.set(con, rect);
        for (const [id, rect] of layout.windows) {
          const info = this._ports.windows.get(id);
          if (info && !info.fullscreen && !info.minimized && !this._unmaximizing.has(id)) expected.set(id, rect);
        }
        // Every output's visible workspace is on screen at once now, so every one of them is drawn --
        // src/shell/decorations.ts parents its actors to window_group with no tie to window visibility,
        // so an unpainted visible workspace would leave its borders, frame and tab bar simply absent.
        //
        // `active` is therefore true for every root the engine pushes, as it always was: decorationPlan()
        // keeps the flag because it is a pure function of its input and the spec's state table is written
        // in terms of it (an inactive workspace's focused leaf is `focused_inactive`); the engine simply
        // never asks it to draw one.
        decoRoots.push({root: ws.root, active: true});
      }
      const selection = tree.selection();
      decoFocused = selection?.kind === 'tiled' ? selection.con : null;
      if (this._monitorInvalidation) {
        for (const id of this._windows.keys()) this._forced.add(id);
        this._monitorInvalidation = false;
      }
      // Task 1: after the layout loop (which owns tiled geometry) and before the floating drain below,
      // because this pass both reads and writes `_floatingRects`.
      this._followFloatingFrames(tree, topology);
      const changes = this._reconciler.plan(expected, this._forced);
      for (const id of expected.keys()) this._forced.delete(id);
      for (const [id, rect] of this._floatingRects) changes.set(id, rect);
      this._floatingRects.clear();
      if (changes.size) this._ports.geometry.apply(changes);
      if (this._disposed) return;
      this._raiseChanged();
    } else {
      // Keep ready ids known even while the compositor has no complete topology, but still drop ids
      // that are gone: pill occupancy is computed from the tree below, and `_forget` (called from the
      // loop right after this) removes a dropped id from the tree too, so a stale id would otherwise
      // keep its workspace lit forever.
      const live = this._ports.windows.list();
      const ids = new Set(live.map(w => w.id));
      for (const id of this._windows.keys()) if (!ids.has(id)) this._forget(id);
      for (const info of live) this._windows.set(info.id, {...info, rect: {...info.rect}});
    }
    if (this._disposed) return;
    const tree = this._tree;
    // The tree's own size, not `_workspaceCount`: the clamp can raise it above what the config named,
    // and a workspace with no pill is a workspace the user cannot see or click.
    const count = tree ? tree.workspaces.size : this._workspaceCount;
    const byOutput = new Map<MonitorId, PillState[]>();
    // Reads back out of `byOutput` below to build the flat, workspace-ordered shape `state()` keeps --
    // one pass over the tree, not two derivations of the same thing that could drift apart.
    const byIndex = new Map<number, PillState>();
    if (tree) {
      const focusedWorkspace = tree.activeWorkspace;
      const visibleSet = new Set(tree.visible.values());
      for (const output of tree.visible.keys()) {
        const list: PillState[] = [];
        for (const index of tree.workspacesOn(output)) {
          // From the tree, never from WindowInfo.workspace: under the attic that field is 0 or 1 for
          // every window, so a workspace's occupancy is not observable from Mutter any more.
          const members = this._workspaceMembers(tree, index);
          const focused = index === focusedWorkspace;
          const pill: PillState = {
            name: displayWorkspaceName(
              this._config.workspaceNames.get(index + 1) ?? String(index + 1),
              this._config.stripWorkspaceNumbers,
            ),
            focused,
            visible: visibleSet.has(index),
            occupied: members.length > 0,
            // Derived per commit from the live window set, like `occupied` -- never separate state to
            // keep in sync. The focused workspace is never urgent: focusing a workspace clears it.
            urgent: !focused && members.some(id => this._windows.get(id)?.urgent === true),
          };
          list.push(pill);
          byIndex.set(index, pill);
        }
        byOutput.set(output, list);
      }
    } else {
      // No tree (no usable topology yet, or momentarily none -- e.g. mid-restart): there is no output
      // to key pills by, so only the flat fallback below is populated here. `_pillsByOutput` itself is
      // deliberately left untouched below rather than replaced with this empty `byOutput` -- see there.
      for (let index = 0; index < count; index++) {
        const focused = index === 0;
        byIndex.set(index, {
          name: displayWorkspaceName(
            this._config.workspaceNames.get(index + 1) ?? String(index + 1),
            this._config.stripWorkspaceNumbers,
          ),
          focused,
          visible: focused,
          occupied: false,
          urgent: false,
        });
      }
    }
    // Only overwrite the per-output map when there is a tree to rebuild it from. Without this, a
    // commit that runs with no tree -- topology not ready yet, or momentarily gone mid-restart --
    // would replace whatever the panel and every bar are currently showing with nothing at all: a
    // full-row blank flicker on exactly the kind of transient outage this project otherwise tolerates
    // gracefully everywhere else. `_flatPills` (the `GetState` surface) keeps the fallback it always
    // had in this case; only the rendered map is retained.
    if (tree) this._pillsByOutput = byOutput;
    this._flatPills = Array.from({length: count}, (_, index) => byIndex.get(index)!);
    this._ports.indicator.setPills(this._copyPillsByOutput());
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

  /** Every window the tree places on a workspace, tiled or floating. */
  private _workspaceMembers(tree: Tree, index: number): WindowId[] {
    if (!tree.workspaces.has(index)) return [];
    const ws = tree.workspace(index);
    return [...[...leaves(ws.root)].map(leaf => leaf.window), ...ws.floating];
  }

  /**
   * `workspace N output <names>` resolved against the attached displays: the names are tried in order
   * and the first one naming a live output wins, with `primary` recognised among them as a name in its
   * own right (§2.3's list-of-outputs form). An unattached name warns once, naming the config line, and
   * the workspace falls back to the default assignment — a config written for a different desk must
   * still load.
   *
   * `byName`'s keys are lowercased on insert: `resolveOutputArg` in tree/outputs.ts (Task 13's
   * `_resolveOutput` is its production caller) only lowercases the query side of the map it is handed,
   * so any map built for that lookup must normalise on the way in. This map is built the same way.
   */
  private _pinnedOutputs(): ReadonlyMap<number, MonitorId> {
    const topology = this._topology;
    const pinned = new Map<number, MonitorId>();
    if (!topology) return pinned;
    const byName = new Map<string, MonitorId>();
    for (const monitor of topology.monitors)
      for (const connector of monitor.connectors) byName.set(connector.toLowerCase(), monitor.id);
    for (const [workspace, {names, line}] of this._config.workspaceOutputs) {
      const resolved = names
        .map(name => name.toLowerCase() === 'primary' ? topology.primary : byName.get(name.toLowerCase()))
        .find(id => id !== undefined);
      if (resolved === undefined) {
        this._ports.log.warn(
          `line ${line}: no attached output matches ${names.join(' ')}; workspace ${workspace + 1} uses the default`);
        continue;
      }
      pinned.set(workspace, resolved);
    }
    return pinned;
  }

  /**
   * `focus output`'s argument (a direction, `primary`, or a connector name), resolved against the
   * current topology and the focused output. Null when there is no such output -- a direction with no
   * neighbour, or a name matching no attached connector.
   *
   * `byName` is built exactly like `_pinnedOutputs`'s own map (lowercased on insert, since
   * `resolveOutputArg` only lowercases the query side of the map it is handed).
   */
  private _resolveOutput(arg: OutputArg): MonitorId | null {
    const tree = this._tree;
    const topology = this._topology;
    if (!tree || !topology) return null;
    const byName = new Map<string, MonitorId>();
    for (const monitor of topology.monitors)
      for (const connector of monitor.connectors) byName.set(connector.toLowerCase(), monitor.id);
    return resolveOutputArg(arg, topology.workAreas, tree.focusedOutput, topology.primary, byName);
  }

  private _floating(info: WindowInfo): boolean {
    return this._manualFloating.get(info.id) ?? info.kind === 'floating';
  }

  private _syncWindow(id: WindowId, adopting: Adoption = 'live'): void {
    const info = this._ports.windows.get(id);
    if (!info) { this._forget(id); return; }
    const old = this._windows.get(id);
    this._windows.set(id, {...info, rect: {...info.rect}});
    if (old?.fullscreen && !info.fullscreen) this._forced.add(id);
    if (old && excludedFromTree(old) && !excludedFromTree(info)) this._forced.add(id);
    const tree = this._tree;
    if (!tree) return;
    const existing = tree.location(id);
    if (excludedFromTree(info)) {
      // _minimized now holds "the floating state and the i3 workspace this window had when it left
      // the tree, for any reason" (minimized, sticky, or skip-taskbar), not just minimize; the name
      // predates that and is left alone here. Recorded once, on the eviction that first removes it,
      // and preserved across any later eviction while it stays excluded.
      //
      // `workspace` is left undefined when `existing` is: that is not a repeat eviction (which truly
      // has no tree location left to read) but the *common* case of a window excluded from birth --
      // sticky or skip-taskbar from the moment it is first seen, which never had a tree location at
      // all. Falling back to _adoptionWorkspace here, as an earlier version of this did, would make
      // such a window remember whichever workspace happened to be visible when it first appeared and
      // stick to that forever, rather than adopting normally -- onto whatever is current -- the first
      // time it actually becomes eligible for the tree.
      this._minimized.set(id, this._minimized.get(id) ?? {
        floating: this._floating(info),
        workspace: existing?.workspace,
      });
      tree.remove(id);
    } else {
      const evicted = this._minimized.get(id);
      if (evicted !== undefined) { this._manualFloating.set(id, evicted.floating); this._minimized.delete(id); }
      // The engine is the authority now (spec 2.6). Mutter's workspace for this window is 0 or 1 and
      // says nothing about which i3 workspace it belongs to.
      const target = existing ? existing.workspace : this._adoptionWorkspace(tree, info, adopting, evicted?.workspace);
      if (!tree.location(id) && tree.workspaces.has(target)) {
        if (this._floating(info)) tree.addFloating(id, target);
        else tree.insert(id, target);
        // A window re-entering the tree (adopted fresh, or returning from eviction) is laid out only
        // if `target` is visible (_layoutAndPublish lays out visible workspaces alone), but nothing
        // upstream of here ever moves its *native* GNOME workspace to match: without this it can sit
        // on a hidden tree workspace while GNOME still renders it live, or the reverse.
        this._parkOrShow(id, target);
        if (this._disposed) return;
      }
      // Task 20, D6, and edge-triggered on purpose: only a monitor the compositor reports as having
      // *changed* since the last observation says the window moved. A level-triggered comparison of
      // `info.monitor` against `location.output` would fire on every commit and would therefore undo
      // every deliberate cross-output move of a floating window -- `move container to output`,
      // `move workspace to output`, `move to workspace N` where N lives elsewhere -- because none of
      // those translates the window's frame onto the new display, so the monitor legitimately
      // disagrees with the new workspace until the user drags it.
      //
      // `existing` too, not just `old`: a window that has only now (re-)entered the tree took its
      // workspace from `_adoptionWorkspace` a few lines up, and that call owns the choice outright.
      // Task 23, D7 strengthened this guard rather than weakening it. The original reason was that
      // adoption "already consulted `info.monitor`", so a re-home could only agree with it; adoption no
      // longer consults it for a live map, which means a re-home here would now *overrule* the decision
      // instead of echoing it -- handing the window straight back to the monitor Mutter chose and
      // reinstating D7 on any path where the monitor also happened to change. The eviction half of the
      // reason is untouched and is still the sharper one: a monitor that changed while the window was
      // minimised, sticky or skip-taskbar is measured against a time when it had no workspace at all, so
      // reading it as a drag would quietly delete the memory the eviction exists to keep.
      //
      // (`old` alone would not cover either case: a brand-new window has no `old`, but one returning
      // from eviction does, having been tracked throughout.)
      if (existing && old && old.monitor !== info.monitor) {
        this._rehomeFloating(tree, id, info);
        if (this._disposed) return;
      }
    }
    // The same predicate as tree membership, not `minimized` alone: a window
    // excluded for any reason is not ours, and is not in `expected` either, so
    // an unmaximize request could never tile it -- it would only undo the
    // user's own maximize, once per maximize, forever.
    if (!info.fullscreen && !excludedFromTree(info) && !this._floating(info)) {
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

  /**
   * Where a window the tree has not seen belongs. Three answers, in order:
   *
   * 1. The workspace it left, if a window that was evicted (minimized, sticky, or skip-taskbar) and is
   *    now returning still remembers one that exists. This outranks everything: it is the only case
   *    where the engine's own earlier decision survives, and the eviction exists to keep it.
   * 2. `adopting === 'startup'`: the visible workspace of the output the window is already on. Its
   *    pre-enable workspace is unrecoverable -- reducing num-workspaces to 2 makes Mutter collapse the
   *    removed workspaces -- but its output is observable and is what the user sees. These windows
   *    predate the tree, so there is no i3 "focused workspace" they could ever have been mapped onto,
   *    and dragging them all onto one would collapse a multi-monitor desktop at every enable.
   * 3. `adopting === 'live'`: the focused output's visible workspace, i3 semantics, whatever monitor
   *    Mutter chose. Task 23, D7: this used to read `info.monitor` here too, so with focus on output 2
   *    and Mutter mapping a window on output 1 the window was adopted onto output 1's workspace while
   *    focus stayed on output 2 -- the user typing into a display they were not looking at. Real i3
   *    opens a new window on the focused workspace and never asks the compositor where it would go.
   *    (`tree.activeWorkspace` *is* `visible.get(focusedOutput)`, with the throw for an output showing
   *    nothing, which `coverOutputs` makes unreachable.)
   */
  private _adoptionWorkspace(tree: Tree, info: WindowInfo, adopting: Adoption, remembered?: number): number {
    if (remembered !== undefined && tree.workspaces.has(remembered)) return remembered;
    if (adopting === 'live') return tree.activeWorkspace;
    return tree.visible.get(info.monitor ?? tree.focusedOutput) ?? tree.activeWorkspace;
  }

  /**
   * Task 20, D6: a floating window's workspace follows the output its frame is really on.
   *
   * A23 is a Phase 3B acceptance criterion -- a window on the secondary output is tracked and tiled
   * there -- and the only way a client can change output here is the mouse workflow the user lives on:
   * float it, drag it across, tile it again. Real i3 re-homes a floating window to the output it is
   * dropped on, so `floating disable` tiles it there; before this it tiled back into the workspace it
   * came from, which lives on the output it came from, and the secondary root stayed empty.
   *
   * Placed here rather than at `floating disable` because `_syncWindow` already runs for every live
   * window on every commit and already holds both the previous and the current `WindowInfo`, so the
   * monitor change costs no new signal and no per-motion work -- the re-home happens once per crossing.
   * `GetTree`, the bars and `move`/`focus` therefore tell the truth while the window is still floating,
   * instead of for the one instant `floating disable` corrected them.
   *
   * Two guards, and they carry the whole of the risk:
   *
   * - **The window must be on screen.** A floating window whose workspace no output is showing is in
   *   the attic, where its frame is unobservable; a change in its reported monitor is the compositor
   *   relocating it off a display that has just gone away, not the user dragging it. Without this,
   *   unplugging an output would scatter the displaced workspace's floating windows onto whichever
   *   workspace the surviving output happened to show, and Task 16's replug would bring the workspace
   *   home without them.
   * - **Only a floating window.** A tiled window's frame is the engine's own output; its monitor
   *   changing is the engine's doing or a transient mid-relayout, never a statement of intent.
   *
   * The focus half is `_selectWindow`'s, per Task 19 D5: the window the user is dragging keeps the
   * keyboard, so i3's focused output is now the one it landed on. Skipping that would leave the tree's
   * selection stranded on the old display and make the very next `floating disable` a no-op, since the
   * `floating` command reads the selection of `activeWorkspace`.
   */
  private _rehomeFloating(tree: Tree, id: WindowId, info: WindowInfo): void {
    const monitor = info.monitor;
    if (monitor === null) return;
    const location = tree.location(id);
    if (!location || !location.floating || monitor === location.output) return;
    if (tree.outputShowing(location.workspace) === null) return;
    const dragged = this._selectedWindow() === id;
    const target = tree.rehomeFloating(id, monitor);
    if (target === null) return;
    if (dragged) this._selectWindow(id);
    // Both workspaces are on screen, so this resolves to LIVE; it is here because every mover of a
    // window's i3 workspace in this file asserts the native side rather than assuming it (_parkAndShow,
    // _moveReconfigured, `move container to output`), and a window Mutter parked for its own reasons
    // is put back on screen by it. One call per crossing, not per motion.
    this._parkOrShow(id, target);
  }

  /**
   * Task 1, the mirror image of D6: a floating window whose frame is still on the output its workspace
   * has LEFT is given a frame on the output its workspace now lives on.
   *
   * D6 (`_rehomeFloating` above) is "the frame moved, follow it with the tree": the user drags a window
   * onto another display and its tree membership follows. This is "the tree moved, follow it with the
   * frame", and it is the half that was missing. `move container to output`, `move container to
   * workspace N`, a directional `move` that crossed an output edge, `move workspace to output` and a
   * workspace shown on a different output after being parked all move a floating window's workspace
   * without touching its frame. (A replug is NOT in that list, and was wrongly claimed to be in the first
   * round: an output that has left takes its work area with it, so there is no source to scale a
   * proportion against, and the `source === undefined` arm below skips the window. Mutter relocates such a
   * frame itself, and once it reports the surviving monitor the monitor and the output agree, so this pass
   * is silent by design -- see the report for why covering it is not worth the state.) The measured symptom: the window stays drawn on the display it
   * left and then appears to VANISH when that display switches away from the workspace it now belongs
   * to. The commit's port calls were `["moveTo:1:0","decorations","decorations"]` -- no rect at all.
   *
   * LEVEL-TRIGGERED, and on exactly the fact D6's own guard is edge-triggered on: does the monitor the
   * compositor reports for this window disagree with the output showing its tree workspace? That is why
   * this is one pass instead of a call at each of the five commands that can cause it -- and why there is
   * no sixth place for the next command to forget.
   *
   * It cannot resurrect the mid-drag hazard D6's edge trigger exists to avoid. Mid-drag, before Mutter
   * reports the new monitor, `info.monitor` still names the old output AND the workspace is still on the
   * old output: they agree, so nothing happens. Once Mutter reports it, `_rehomeFloating` moves the tree
   * and they agree again. Only a tree-side move leaves them disagreeing, and only then does this write.
   * (`_syncWindow` runs for every window earlier in this same commit, so `_windows` already holds the
   * fresh monitor by the time this reads it -- the same view `_crossedOutput` compares against.)
   *
   * Three exclusions, each its own sentence because each is its own reason:
   *
   * - **A workspace no output is showing is skipped**, by construction: this iterates `tree.visible`, so
   *   a parked workspace is never reached. A parked window is in the attic where its frame is
   *   unobservable, and it gets its frame the moment some output shows that workspace -- which is this
   *   same pass, on the commit that shows it.
   * - **A fullscreen window is skipped.** Mutter owns a fullscreen window's geometry (main spec 19), and
   *   the layout pass above excludes it for the same reason; writing a rect here would fight the
   *   compositor and could leave the window the size of the output it came from.
   * - **A rect already in `_floatingRects` is translated, not overwritten** -- `this._floatingRects.get(id)
   *   ?? info.rect`. This is a defensive composition invariant with NO caller today and it is not pinned by
   *   any test: every command drains `_floatingRects` through its own `commit()` before the next one runs,
   *   so the map is empty whenever this pass reads it (measured, including from a `for_window` rule whose
   *   commands run inside a drain). It is the correct read order for a map this pass itself writes, and if
   *   a later task ever queues a rect and re-homes in one commit, composing is right and clobbering would
   *   silently discard the user's own command. Round 1 justified it with `move container to output right,
   *   move position center`; that sequence is REFUSED by the engine, because `move position` reads the
   *   selection of the focused output's workspace and the move has just carried the window off it.
   * - **A frame this pass has already carried to that output is left alone**, which is what makes a
   *   level-triggered pass safe to run on every commit. Writing the frame raises a geometry signal the
   *   engine commits on, and the compositor MAY not report the window's new monitor by then -- the fake
   *   never does, and whether real Mutter does is unproven here, since nothing in this repo has observed
   *   it natively (`Meta.Window` recomputes its monitor on a move, which is an inference about Mutter, not
   *   a measurement). Without the record the pass would therefore translate the SAME window again on that
   *   next commit, and because the result is clamped each pass drags it further into the destination's far
   *   corner: measured, commit one wrote x=2780 and the next x=3000, the clamp's limit. It keys on "already
   *   carried" and NOT on where the frame happens to be: round 1 asked `originWithin(current, destination)`
   *   instead, and a frame straddling the boundary -- 400px wide at x=1900, which Mutter hands to the
   *   output on the right -- then got no rect at all on `move container to output left`, leaving the window
   *   drawn on the display it was told to leave. That is the defect this pass exists to fix, so the key had
   *   to be the fact and not a proxy.
   *
   *   **Exactly when the suppression ends, and what it still covers that it should not.** It ends on the
   *   first report of any monitor other than the `from` of the carry, on a carry to a different output, and
   *   in `_forget`. It does NOT end while the compositor goes on reporting the output the frame was carried
   *   from, and that is a real residual, not a theoretical one: a client that refuses the rect (the
   *   README's `stubborn` clients) is reported on `from` indefinitely, and so is a window the user is still
   *   dragging within `from` when the command lands. In both of those the next carry back to the same
   *   output is suppressed, so the frame stays where the client left it until the window is carried
   *   elsewhere or closed. Measured, and written down in `docs/acceptance/phase-5.md` with the rest of this
   *   task's uncovered cases, because this comment is where a maintainer meets the trade: round 1 claimed
   *   here that "the suppression lasts exactly as long as the uncertainty", and that was simply false.
   * - It is an addition to the monitor test and not a replacement for it: the monitor test is what leaves
   *   a window the user is mid-drag alone.
   */
  private _followFloatingFrames(tree: Tree, topology: Topology): void {
    // Shaped like the layout loop in `_layoutAndPublish`, deliberately and line for line: over
    // `topology.monitors`, taking the index from `tree.visible` and asserting the work area, because the
    // `_ready` gate at the top of that method has already established that every monitor in this topology
    // has one. Iterating the topology rather than `tree.visible` also means an output that has left can
    // never be reached, so there is no third unreachable branch to justify.
    for (const output of topology.monitors) {
      const index = tree.visible.get(output.id);
      if (index === undefined) continue;
      const destination = topology.workAreas.get(output.id)!;
      for (const id of tree.workspace(index).floating) {
        const info = this._windows.get(id);
        if (!info || info.monitor === null) continue;
        // The compositor has moved on from where the carry started -- to the output it was carried to, or
        // to any other -- so the carry is no longer in doubt and the record must go, or it would suppress
        // the next genuine carry back to that same output. `!== from`, and not `=== to`, because a frame
        // the client refused is never reported at `to` at all (fix round 2, I5).
        if ((this._carriedFloating.get(id)?.from ?? info.monitor) !== info.monitor)
          this._carriedFloating.delete(id);
        if (info.monitor === output.id || info.fullscreen) continue;
        if (this._carriedFloating.get(id)?.to === output.id) continue;
        // Reachable, unlike the two above: the compositor can name a monitor that has already left the
        // topology, and there is then no source work area to scale the frame against.
        const source = topology.workAreas.get(info.monitor);
        if (source === undefined) continue;
        this._floatingRects.set(id, fixFloatingCoordinates(this._floatingRects.get(id) ?? info.rect,
          source, destination));
        this._carriedFloating.set(id, {from: info.monitor, to: output.id});
      }
    }
  }

  private _forget(id: WindowId): void {
    this._tree?.remove(id);
    this._windows.delete(id);
    this._manualFloating.delete(id);
    this._minimized.delete(id);
    this._expectedFocus.delete(id);
    this._unmaximizing.delete(id);
    this._unmaximizeAttempts.delete(id);
    this._forced.delete(id);
    this._floatingRects.delete(id);
    this._carriedFloating.delete(id);
    this._borderOverrides.delete(id);
    this._firedRules.delete(id);
    this._reconciler.forget(id);
    const read = this._frameReads.get(id);
    if (read) this._ports.deferred.cancel(read.token);
    this._frameReads.delete(id);
    if (this._lastFocus === id) this._lastFocus = null;
  }

  /**
   * i3's for_window. Runs at first frame and again when a title-matching
   * rule's subject changes its title, because a GNOME dialog routinely sets
   * its title after mapping and the user's own rule matches one.
   *
   * Each rule fires at most once per window: a window whose title flaps must
   * not have `resize set` re-applied and fight the user for the rectangle.
   *
   * Commands go through run() unchanged. commit() queues rather than rejecting
   * a nested call and the drain is synchronous, so the extra layout passes are
   * never painted -- see the plan's mechanism note.
   *
   * Warnings come only from parseCommands()'s diagnostics -- a parse failure
   * is synchronous and truthful. The command's own run() *result* is not
   * sniffed for a rejection: several of _runOne's cases set their result flag
   * inside a commit() closure, and commit() queues rather than running that
   * closure when a drain is already in progress -- which it always is here,
   * since rules apply from inside the 'added'/'title' commit. Reading the
   * result would therefore read it before the closure runs, which is false
   * for a command that is about to succeed. A warning that fires on success
   * is worse than none: it teaches the reader to ignore the only channel
   * that would ever tell them a rule genuinely failed.
   */
  private _applyRules(id: WindowId, timestamp: number): void {
    const info = this._ports.windows.get(id);
    if (!info) return;
    const fired = this._firedRules.get(id) ?? new Set<number>();
    this._firedRules.set(id, fired);
    this._config.rules.forEach((rule, index) => {
      if (fired.has(index)) return;
      if (!matchesCriteria(rule.criteria, info)) return;
      fired.add(index);
      const {commands, diagnostics} = parseCommands(rule.command);
      for (const problem of diagnostics)
        this._ports.log.warn(`for_window line ${rule.line}: ${problem}`);
      // ONE map for the whole rule, exactly as run() does for a comma-separated
      // command line. _floatingFrame() reads it to see a rect a prior command
      // has queued but Mutter has not yet confirmed, so a fresh map per command
      // would make `move position center` centre on the pre-resize size -- and,
      // worse, re-apply it, reverting the resize. Silent: nothing fails, the
      // wrong rect is just computed and applied successfully.
      const commandFrames = new Map<WindowId, Rect>();
      for (const command of commands) {
        // A command the parser could not understand is already covered,
        // 1:1, by the diagnostics loop above (parseCommands() pushes both
        // together for every unparseable segment) -- running it here would
        // only repeat the same rejection through _runOne's own unprefixed
        // "unknown command: ..." warning.
        if (command.type === 'unknown') continue;
        this._runOne(command, timestamp, commandFrames);
      }
    });
  }

  /**
   * Returns true when the observation queued a corrective re-apply, so a frame
   * notification for a window already at its target costs nothing: measured at
   * ~2 commits per floating move, half of which were this echo.
   */
  private _observe(id: WindowId, generation: number | undefined): boolean {
    const info = this._ports.windows.get(id);
    if (!info || info.fullscreen || excludedFromTree(info) || this._floating(info) ||
      this._unmaximizing.has(id)) return false;
    if (generation === undefined) return false;
    return this._reconciler.observe(id, info.rect, generation);
  }

  /**
   * Does the port report this window on a different output than the one the engine last synced?
   *
   * Task 20, D6. Compared against `_windows`, which is the engine's last *synced* view, because the
   * whole point is to tell a commit that the port has outrun it -- so that `_layoutAndPublish`'s sync
   * loop runs and `_rehomeFloating` gets its chance. Deliberately not narrowed to floating windows: the
   * narrowing would be a cost guard worth one extra publish at the end of a cross-output tile move, and
   * `_rehomeFloating` already refuses anything but a floating window, so narrowing here would only add a
   * second, untested copy of that rule. Terminating either way -- the sync loop writes the new monitor
   * into `_windows`, so the next frame report sees no change.
   */
  private _crossedOutput(id: WindowId): boolean {
    const info = this._ports.windows.get(id);
    const old = this._windows.get(id);
    return info !== undefined && old !== undefined && old.monitor !== info.monitor;
  }

  /**
   * Accept a window as the selection -- the one funnel for "this window has the keyboard now", whether
   * that came from the compositor (`_acceptFocus`) or from a click on i3-shell's own chrome
   * (`focusWindow`).
   *
   * Task 19, D5: it moves the focused output too. `Tree.select`/`selectFloating` are structural
   * primitives that every intra-workspace focus command calls with the focused output already correct
   * -- and `moveIntoOutput` already has to *undo* one focusedOutput side effect (see `move` below), so
   * giving them another would multiply that fight. The policy belongs here, where a *native* focus
   * report is turned into tree state, and the layer-0 half of it is `Tree.outputShowing`.
   *
   * Only an output actually showing the window's workspace is taken: `activeWorkspace` is
   * `visible.get(focusedOutput)`, so pointing the focused output at a display that shows something else
   * would make every workspace-scoped command act on the wrong workspace. A focus report for a parked
   * window (Mutter can still send one) therefore leaves the focused output alone.
   *
   * D8: `claimOutput` false keeps the selection half and drops the focused-output half, for the one
   * caller that can tell the user's focus change from the compositor's own -- `_acceptFocus`, through
   * `_involuntaryFocus` below. Only a parameter, not a field read: `focusWindow` (a click on i3-shell's
   * own tab) and `_rehomeFloating` (the window the user is dragging) are the user acting, and they keep
   * the rule whole.
   */
  private _selectWindow(id: WindowId, claimOutput = true): void {
    const tree = this._tree;
    const location = tree?.location(id);
    if (!tree || !location) return;
    if (location.floating) tree.selectFloating(id);
    else { const leaf = tree.find(id); if (leaf) tree.select(leaf); }
    if (!claimOutput) return;
    const showing = tree.outputShowing(location.workspace);
    if (showing !== null) tree.focusedOutput = showing;
  }

  /**
   * D8, the defect a live session found after Phase 5 merged: arm, or disarm, the one-report suppression `_acceptFocus` spends. Called once per
   * drained change in `commit()`, with what each output was showing before that change ran.
   *
   * The defect: show an EMPTY workspace on an output and that output has no window to focus, so the
   * compositor's keyboard focus necessarily stays on -- or is reassigned to -- a window on another
   * display, and it says so with an ordinary focus report. D5 (`_selectWindow` above) then reads that
   * leftover as the user having moved there and hands the focused output to the display they just looked
   * away from; `$mod+d` opens the launcher there, which is how the user saw it. `onPointerOutput` cannot
   * correct it: `src/shell/pointer.ts` is edge-triggered on `_lastMonitor`, so a pointer standing still
   * emits nothing. The ruling: an explicit user action beats the compositor's involuntary pick. A
   * `workspace` switch, a `move workspace to output` and a reconfigure all set `focusedOutput`
   * deliberately, and a report that arrives as a consequence of one must not override it.
   *
   * Three things make this a suppression of exactly that report and not of D5:
   *
   * - **It is armed only by a change in `tree.visible`.** A report in a commit where the engine changed
   *   nothing about what is on screen -- a real click, or a sloppy-focus hover -- is D5's, and D5 is
   *   load-bearing. Comparing the map is what defines "the engine changed what a workspace shows"; it
   *   needs no bookkeeping at the places that write to `visible`, and a new one cannot forget it.
   * - **It records the output, not a flag.** The suppression lapses the moment anything else moves the
   *   focused output -- `focus output`, a pointer crossing onto another display (D4), a second switch.
   *   Those are the user, and after them the next report is the user's too. A flag would also swallow
   *   the report the parked-window guard in `_selectWindow` exists for, leaving that guard pinned by
   *   nothing at all.
   * - **Whether it suppresses anything is decided later, from live state.** This only records the
   *   output; `_involuntaryFocus` below asks the two questions that matter at the moment a report
   *   arrives, so a commit that changed visibility and took the keyboard for itself (an incoming
   *   workspace with a window in it) suppresses nothing, with no bookkeeping here.
   *
   * A tree being *born* (`before` null) is not such a change: nothing was on screen to displace, and the
   * commit that builds it accepts the compositor's focus itself, through `_layoutAndPublish`.
   */
  private _armInvoluntaryFocus(before: ReadonlyMap<MonitorId, number> | null): void {
    const tree = this._tree;
    if (!tree || !before) return;
    if (before.size === tree.visible.size &&
      [...tree.visible].every(([output, index]) => before.get(output) === index)) return;
    this._shownOnFocusedOutput = tree.focusedOutput;
  }

  /**
   * Is an inbound focus report the compositor's own doing rather than the user's? Round 2, and the whole
   * of the reason this is a condition re-derived from live state instead of the one-shot token the first
   * fix used.
   *
   * The native suite measured that token being too weak: Mutter does not send ONE notification for one
   * involuntary pick. It focuses its replacement, unsets the input focus while it hides the window being
   * parked, and focuses the replacement again -- so the first report spent the token and a later one
   * claimed the other display regardless. Nothing here is spent by a report; both clauses below are facts
   * about the tree as it is now, so they answer the same way however many reports arrive.
   *
   * Two clauses, both live, and each of them is also what *ends* the suppression:
   *
   * - **the focused output is still the one the engine pointed focus at.** Anything else that moves it
   *   is the user -- `focus output`, a pointer crossing onto another display (D4), a `focus` or `move`
   *   that crossed an output edge -- and after one of those the next report is theirs.
   * - **that output still has nothing to focus.** `activeWorkspace` is `visible.get(focusedOutput)`, so
   *   this reads what the output shows *now*: a second `workspace` switch, a `move workspace to output`
   *   or a window simply opening there all end the suppression, because the compositor then HAS a window
   *   on that display to focus and a report naming another one is informative again. This clause is the
   *   defect's premise and nothing more, which is why it needs no record of its own: the engine taking
   *   the keyboard for itself (an incoming workspace that had a window) is the same fact.
   *
   * A failed clause clears the record for good rather than merely answering false, so a focused output
   * that wanders away and comes back cannot resurrect a suppression the user has already overruled.
   */
  private _involuntaryFocus(): boolean {
    const tree = this._tree;
    if (this._shownOnFocusedOutput === null || !tree) return false;
    if (this._shownOnFocusedOutput === tree.focusedOutput && !tree.occupied(tree.activeWorkspace))
      return true;
    this._shownOnFocusedOutput = null;
    return false;
  }

  private _acceptFocus(id: WindowId | null): void {
    const expected = id !== null && this._expectedFocus.has(id);
    // Any native focus report resolves or supersedes the one pending request.
    this._expectedFocus.clear();
    const duplicate = id === this._lastFocus;
    this._lastFocus = id;
    if (id === null || !this._tree?.location(id)) return;
    if (expected || duplicate) return;
    const involuntary = this._involuntaryFocus();
    if (involuntary)
      // Logged, not silent: this is the one place the engine overrules the compositor about where the
      // user is, it fires only while the suppression holds, and the native suite reads the count out of
      // the journal the way the user read the storm (test/integration/phase5-checks.py, defect D8).
      this._ports.log.info(`involuntary focus: window ${id} focused while output ` +
        `${this._tree.focusedOutput} shows empty workspace ${this._tree.activeWorkspace}; ` +
        'leaving the focused output alone');
    this._selectWindow(id, !involuntary);
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

  /**
   * Puts window `id` on whichever native GNOME workspace its i3 workspace's own visibility says it
   * belongs on: LIVE if some output currently shows that i3 workspace, the attic otherwise. Warns
   * (naming the window) rather than throwing when Mutter refuses, in the same style as
   * `_showOnOutput`. Named and kept small so Task 16's `_reconcileParking` -- which generalises
   * exactly this over every workspace -- can call it rather than duplicate it.
   */
  private _parkOrShow(id: WindowId, workspace: number): void {
    const tree = this._tree;
    const native = tree && [...tree.visible.values()].includes(workspace) ? LIVE_WORKSPACE : ATTIC_WORKSPACE;
    if (!this._ports.windows.moveToWorkspace(id, native))
      this._ports.log.warn(`could not move window ${id} to workspace ${workspace + 1}; leaving it where it was`);
  }

  /**
   * After any tree reconfigure, every window's GNOME workspace must agree with the new visibility.
   *
   * A monitor change can make a workspace visible or parked without moving a single window between
   * workspaces, so the `Map<WindowId, number>` `reconfigure` returns is empty in exactly the case that
   * matters most -- a lid closing, a television sleeping -- and `_moveReconfigured` alone would leave
   * the lost output's windows rendered live on a workspace nothing shows (or, on the replug, stranded
   * in the attic). Reconciles through `_parkOrShow`, which owns the LIVE/attic decision and the
   * port-failure warning, rather than repeating either.
   */
  private _reconcileParking(tree: Tree): void {
    const visible = new Set(tree.visible.values());
    for (const index of tree.workspaces.keys()) {
      const target = visible.has(index) ? LIVE_WORKSPACE : ATTIC_WORKSPACE;
      for (const id of this._workspaceMembers(tree, index)) {
        // Mutter is asked only for a window that is not already there: a reconfigure touches every
        // workspace, and re-asserting the workspace of every window on every monitor change would be
        // one port call per window for no change at all.
        if (this._windows.get(id)?.workspace === target) continue;
        this._parkOrShow(id, index);
        if (this._disposed) return;
      }
    }
  }

  /**
   * Drives Mutter's real per-window workspace to match a tree-side move the engine already made.
   *
   * `destination` is the window's new i3 workspace, not a native GNOME one: GNOME has exactly two
   * now (live + attic), and whether this i3 workspace is currently shown by some output -- not the
   * index itself -- decides which of the two the window actually belongs on (see `_parkOrShow`).
   * Passing the i3 index straight through, as this method did before the attic, would park the
   * window when its i3 workspace happens to be visible, or move it onto GNOME's one native
   * workspace when the index is 1 and elsewhere fail silently for any higher index Mutter does not
   * have.
   */
  private _moveReconfigured(moves: ReadonlyMap<WindowId, number>): void {
    for (const [id, destination] of moves) {
      this._parkOrShow(id, destination);
      if (this._disposed) return;
    }
  }

  private _raiseChanged(): void {
    if (!this._tree) return;
    const active = new Set<number>();
    let raised = false;
    for (const ws of this._tree.workspaces.values()) {
      const root = ws.root;
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
    for (const id of this._raiseOrders.keys()) if (!active.has(id)) this._raiseOrders.delete(id);
    if (raised && this._lastFocus !== null && this._tree.location(this._lastFocus)?.floating)
      this._ports.windows.raise(this._lastFocus);
  }

  /**
   * The active i3 workspace: the tree's own answer once a tree exists (the coordinate system every
   * other reader of "active" uses -- pills, `focusedOutput`, `serializeTree`), never GNOME's raw index
   * once there is a tree to ask instead. Only reached before the tree exists, when there is nothing
   * better to report.
   */
  private _activeWorkspaceIndex(): number {
    return this._tree?.activeWorkspace ?? this._ports.workspaces.activeIndex;
  }

  state(): EngineState {
    const l = this._loaded;
    return {
      mode: this._mode,
      activeWorkspace: this._activeWorkspaceIndex(),
      // The tree's own count once one exists, never GNOME's raw count: GNOME's is pinned at two
      // (live + attic) under the attic, which would report 2 forever and say nothing useful.
      workspaceCount: this._tree ? this._tree.workspaces.size : this._workspaceCount,
      grabbed: this._ports.keys.grabbedCount,
      configSource: l.source,
      configPath: l.path,
      errors: l.diagnostics.filter(d => d.severity === 'error').length,
      warnings: l.diagnostics.filter(d => d.severity === 'warning').length,
      pills: this._copyFlatPills(),
      focusedOutput: this._tree?.focusedOutput ?? null,
    };
  }

  /**
   * The real, zero-based workspace index at `position` in `output`'s own ascending pill list -- the
   * inverse of how `_pillsByOutput` groups them. A bar now shows only its own output's pills (Task 8),
   * so a click on the pill at `position` no longer names the workspace by its position in one shared,
   * contiguous list; this is how the shell resolves a click back to the workspace it was built for
   * before turning it into a `workspace <n>` command, i3bar's own behaviour for a pill click. Null
   * before a tree exists, or if `position` is out of range for what `output` owns right now.
   */
  workspaceIndexOn(output: MonitorId, position: number): number | null {
    return this._tree?.workspacesOn(output)[position] ?? null;
  }

  /** A grabbed accelerator fired. */
  onBinding(binding: Binding, timestamp: number): void {
    const {commands, diagnostics} = parseCommands(binding.command);
    for (const d of diagnostics)
      this._ports.log.warn(`config line ${binding.line}: ${d}`);
    this.run(commands, timestamp);
  }

  /**
   * A touchpad swipe completed. `bindgesture`'s half of what `onBinding` is to `bindsym`.
   *
   * An unbound gesture is silent, not an error: the config is the user's real `~/.config/i3/config` and
   * most of them will never write a `bindgesture` line, so a bare swipe must cost nothing and say nothing.
   * Which direction means `workspace next` lives entirely in that config -- nothing here knows.
   *
   * The `_locked` guard is the one thing this does that `onBinding` does not need. `onLocked()` drops
   * every accelerator grab, so a binding physically cannot fire over a lock screen; the stage
   * subscription a swipe arrives on has no equivalent and stays live, which would otherwise make the lock
   * screen the one place where gestures still ran commands.
   */
  onSwipe(direction: 'left' | 'right', timestamp: number): void {
    if (this._locked) return;
    const gesture = this._config.gestures.get(`swipe:${direction}`);
    if (!gesture) return;
    const {commands, diagnostics} = parseCommands(gesture.command);
    for (const d of diagnostics)
      this._ports.log.warn(`config line ${gesture.line}: ${d}`);
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
    this._ports.launcher.close();
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

  private _copyFlatPills(): PillState[] {
    return this._flatPills.map(pill => ({...pill}));
  }

  private _copyPillsByOutput(): Map<MonitorId, PillState[]> {
    const copy = new Map<MonitorId, PillState[]>();
    for (const [output, list] of this._pillsByOutput) copy.set(output, list.map(pill => ({...pill})));
    return copy;
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
    // A config naming no workspace count falls back to the running i3 workspace count on reload (the
    // engine's own _workspaceCount) rather than to GNOME's, which is pinned at two (live + attic) and
    // would silently shrink the tree on every reload; before the tree exists, GNOME's native count is
    // the only sensible inheritance for a first enable, since _workspaceCount has no history yet.
    const count = config.workspaceCount || (this._tree ? this._workspaceCount : this._ports.workspaces.count);
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
        const outputs = this._topology.monitors.map(m => ({id: m.id, index: m.index}));
        const moves = this._tree.reconfigure(count, outputs, this._topology.primary, this._pinnedOutputs());
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

  /**
   * i3 workspace target → i3 workspace index, or null when it does not exist (§9).
   *
   * `count` and `current` are both read from the tree, not from GNOME: they are different coordinate
   * systems now (spec 2.6). `case 'workspace'` below no longer touches `ports.workspaces.activate()` at
   * all (Task 7) -- it drives `Tree.showWorkspace` directly -- so this never needs GNOME's numbers.
   */
  private _workspaceIndex(target: WorkspaceTarget): number | null {
    const count = this._tree?.workspaces.size ?? this._workspaceCount;
    const current = this._activeWorkspaceIndex();
    switch (target.kind) {
      case 'number':
        return target.number >= 1 && target.number <= count ? target.number - 1 : null;
      case 'name': {
        for (const [number, name] of this._config.workspaceNames) {
          if (name === target.name)
            return number >= 1 && number <= count ? number - 1 : null;
        }
        if (/^\d+$/.test(target.name)) {
          const number = parseInt(target.name, 10);
          return number >= 1 && number <= count ? number - 1 : null;
        }
        return null;
      }
      case 'next':
      case 'prev': {
        // i3's semantics, not numeric neighbours: cycle the workspaces that exist and wrap at both
        // ends. These used to be `current + 1` / `current - 1` with a null at each end, which dead-ended
        // on workspace 1 and on the config's last workspace and walked through empty workspaces nobody
        // had opened. `Tree.cycleMembers` says what "exists" means here; `cycleWorkspace` is the walk.
        // No tree means no cycle to walk -- and nothing on screen to walk it from.
        const tree = this._tree;
        return tree ? cycleWorkspace(tree.cycleMembers(), current, target.kind) : null;
      }
      case 'back_and_forth':
        return null;
    }
  }

  /**
   * The work area the launcher opens in: the focused output's, always -- one output, one workspace it
   * shows, so there is no selection to walk any more.
   */
  private _launcherArea(): Rect | null {
    const topology = this._topology;
    if (!topology || !this._tree) return null;
    // Stored state, not inferred from the selection. An output whose visible workspace is empty has
    // no selection to read, which is why the launcher used to open on the primary instead.
    return topology.workAreas.get(this._tree.focusedOutput)
      ?? topology.workAreas.get(topology.primary)
      ?? null;
  }

  /** Test-only entry point for `_launcherArea`, which has no production reader outside `_runOne`'s own `launcher` case. */
  launcherAreaForTest(): Rect | null {
    return this._launcherArea();
  }

  /**
   * Test-only entry point for `_warpToFocusedOutput`, whose production callers are `focus_output`
   * (Task 13) and, since this task, the `focus` and `move` commands' output-crossing branches -- never
   * rule 4 (`onPointerOutput`), where the pointer is already there.
   */
  warpToFocusedOutputForTest(): void {
    this._warpToFocusedOutput();
  }

  /**
   * The warp half of the pair `mouse_warping output` and rule 4 make: after rules 2 and 3 move the
   * focused output (never rule 4, where the pointer is already there -- warping it there again would
   * be a no-op at best and a fight with the user's own hand mid-drag at worst), the pointer follows, or
   * sloppy focus would immediately drag the focused output straight back to wherever the stationary
   * pointer sits. Skipped while the launcher holds its modal grab (fix round 1, C1: asked live via
   * `isOpen()`, never mirrored -- see the doc comment on `EnginePorts.launcher.isOpen`): moving the real
   * pointer out from under an open launcher would move it out from under the click the user is about to
   * make. Task 12 only defines this; Task 13 is its first production caller.
   */
  private _warpToFocusedOutput(): void {
    if (this._config.mouseWarping === 'none' || this._ports.launcher.isOpen()) return;
    const tree = this._tree;
    const topology = this._topology;
    if (!tree || !topology) return;
    const selection = tree.selection();
    const target = selection?.kind === 'tiled'
      ? this._containerRects.get(selection.con)
      : selection?.kind === 'floating'
        ? this._windows.get(selection.window)?.rect
        : undefined;
    // An empty workspace has no window to aim at, so the output's own centre is the only answer.
    const rect = target ?? topology.workAreas.get(tree.focusedOutput);
    if (rect) this._ports.pointer.warpTo(rect);
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
        const tree = this._tree;
        if (!tree) return 'workspace: not ready';
        const index = this._workspaceIndex(command.target);
        if (index === null)
          return 'workspace: no such workspace';
        // This snapshot is only for the message, which needs an answer now, synchronously -- never for
        // the switch itself. `commit()` queues on re-entry (a `for_window` rule's own command list runs
        // from inside the commit its matching 'added'/'title' event opened), so a `workspace` command
        // still queued from earlier in the same chain can leave this read stale by the time this one's
        // closure actually drains; `Tree.showWorkspace` re-reads `tree.visible` itself rather than
        // trusting it, so the workspace it parks is whatever is *actually* showing when it runs, not
        // whatever was showing when it was merely scheduled.
        if (tree.visible.get(tree.focusedOutput) === index) {
          // Task 19, D3: still push focus. This used to return without committing anything, so the one
          // key the user reaches for when sloppy focus has handed the keyboard to whatever the pointer
          // crossed (i3's `focus_follows_mouse yes` is GNOME's sloppy mode -- see overridePlan.ts) did
          // nothing at all. `return false` keeps the early return's cheapness: no park/show, no
          // relayout, no workspace moved, just the selection re-activated.
          this.commit(() => { this._activateSelection(0); return false; });
          return 'workspace: already active';
        }
        this.commit(() => {
          const before = tree.focusedOutput;
          // Task 19, D1: the outgoing workspace is whatever the *resolved* output was showing, which is
          // no longer necessarily the focused one -- an occupied workspace is shown on its own display,
          // a pinned one on its pin. Reading it off the focused output parked the wrong display's
          // windows and left the hidden ones on screen.
          // No `outgoing !== undefined` guard: a `swap` resolved an output through `_ordered`, every
          // ordered output has a `visible` entry, and `_parkAndShow` takes `number | undefined` anyway.
          const {swap, outgoing} = tree.showWorkspace(index);
          if (swap) this._parkAndShow(outgoing, index);
          else this._activateSelection(0);
          // The pointer follows a switch that crossed displays, the same way `focus output` and `move
          // workspace to output` below already make it follow, and for the same reason: with
          // `focus_follows_mouse yes` the pointer is left standing on the display the user just left, so
          // the next motion that carries it over a *window* there produces a GNOME focus report, and D5
          // hands the focused output straight back. (Round 1, I4: an earlier version of this comment
          // blamed rule 4 / `onPointerOutput` for that. It cannot do it -- `src/shell/pointer.ts`
          // debounces on `_lastMonitor`, so motion within the display the pointer is already on never
          // reaches the engine at all; only a real crossing does, and claiming the output the user has
          // deliberately crossed onto is correct.) `workspace N` could always cross displays via the
          // "already visible elsewhere" branch; D1's occupied and pinned rules make it routine.
          if (tree.focusedOutput !== before) this._warpToFocusedOutput();
          return true;
        });
        return `workspace ${index + 1}`;
      }
      case 'move_to_workspace': {
        if (command.target.kind === 'back_and_forth')
          return 'move container to workspace back_and_forth: not implemented until Phase 4';
        const index = this._workspaceIndex(command.target);
        if (index === null)
          return 'move container to workspace: no such workspace';
        if (index === this._activeWorkspaceIndex())
          return 'move container to workspace: already there';
        let moved = false;
        this.commit(() => {
          if (!this._tree) return false;
          const ids = this._tree.moveToWorkspace(index);
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
          // Crossing beats wrapping: try strictly inside this output first, with wrapping off. Only
          // once that finds nothing does a neighbour get a look, and only once there is no neighbour
          // either does the config's own focus_wrapping get to wrap inside this output -- get this
          // order backwards and wrapping would satisfy the move before the edge ever crosses.
          if (tree.focus(command.target, 'no')) {
            changed = true;
            this._activateSelection(timestamp);
            return true;
          }
          const neighbour = this._resolveOutput(command.target);
          if (neighbour !== null) {
            tree.enterOutput(neighbour, command.target);
            changed = true;
            this._activateSelection(timestamp);
            // The pointer follows only because this command itself just crossed an output, never from
            // a generic "focusedOutput changed" hook -- see `focus_output` above and
            // `_warpToFocusedOutput`'s own comment.
            this._warpToFocusedOutput();
            return true;
          }
          changed = tree.focus(command.target, this._config.focusWrapping) !== null;
          if (changed) this._activateSelection(timestamp);
          return changed;
        });
        return changed ? `focus ${command.target}` : `focus ${command.target}: no target`;
      }
      case 'focus_output': {
        const output = this._resolveOutput(command.target);
        // No neighbour beyond that edge is an ordinary edge, not an error: outputs are physical and
        // wrapping between them is never what a user means.
        if (output === null) return 'focus output: no such output';
        let changed = false;
        this.commit(() => {
          const tree = this._tree;
          if (!tree || tree.focusedOutput === output) return false;
          tree.focusedOutput = output;
          changed = true;
          this._activateSelection(timestamp);
          // The pointer follows only here, never from a generic "focusedOutput changed" hook: rule 4
          // (onPointerOutput) already puts the pointer where it is going to warp to, and warping again
          // there would be a no-op at best and a fight with the user's own hand at worst.
          this._warpToFocusedOutput();
          return true;
        });
        return changed ? 'focus output' : 'focus output: unchanged';
      }
      case 'move': {
        let moved = false;
        this.commit(() => {
          const tree = this._tree;
          if (!tree) return false;
          // Same order as `focus`: strictly inside this output first, a neighbour only once that
          // fails. `move` has no config-level wrapping fallback of its own -- the edge is either
          // crossed or the move is a no-op.
          if (tree.move(command.direction)) {
            moved = true;
            this._activateSelection(timestamp);
            return true;
          }
          const neighbour = this._resolveOutput(command.direction);
          if (neighbour === null) return false;
          moved = tree.moveIntoOutput(neighbour, command.direction).length > 0;
          if (moved) {
            this._activateSelection(timestamp);
            this._warpToFocusedOutput();
          }
          return moved;
        });
        return moved ? `move ${command.direction}` : `move ${command.direction}: no target`;
      }
      // The command this phase exists for: before it, no binding could move a window stranded on a
      // display nobody was looking at. Does not follow the window -- i3's behaviour, and
      // `move_to_workspace`'s -- so the output the user was looking at is put back after
      // `moveIntoOutput` changes it as a side effect.
      case 'move_container_to_output': {
        const output = this._resolveOutput(command.target);
        if (output === null) return 'move container to output: no such output';
        // `commit()` returns void, not the closure's boolean -- capture the outcome in a local, the
        // same way `move` and `move_to_workspace` above already do.
        let moved = false;
        this.commit(() => {
          const tree = this._tree;
          if (!tree) return false;
          // Captured inside the closure, not outside: a queued second command must not park against a
          // stale focused output (the same defect a `workspace` command hit earlier in this phase).
          const before = tree.focusedOutput;
          const direction = typeof command.target === 'string' && isDirection(command.target) ? command.target : null;
          const carried = tree.moveIntoOutput(output, direction);
          if (carried.length === 0) return false;
          // moveIntoOutput sets focusedOutput as a side effect of lifting the selection; put it back,
          // since this command does not move focus.
          tree.focusedOutput = before;
          // Defensive, not a no-op guarded against: `carried` left an already-visible workspace for
          // another already-visible one, so every id here should already be on LIVE_WORKSPACE -- but
          // nothing upstream guarantees that stays true, and the warn-on-refusal contract every other
          // moveToWorkspace call site in this file follows (_parkAndShow, _parkOrShow) applies here too.
          for (const id of carried)
            if (!this._ports.windows.moveToWorkspace(id, LIVE_WORKSPACE))
              this._ports.log.warn(`could not show window ${id}; leaving it parked`);
          // "Does not follow the window" has to mean the keyboard does not follow, not merely that
          // focusedOutput is restored: without this, real focus stays on the window that just left,
          // since the tree's selection is only ever reconciled inward from native focus reports.
          this._activateSelection(timestamp);
          moved = true;
          return true;
        });
        return moved ? 'move container to output' : 'move container to output: nothing moved';
      }
      // Unlike the container move above, the workspace the user was looking at goes with it, so focus
      // follows -- `moveWorkspaceToOutput` sets `focusedOutput` itself.
      case 'move_workspace_to_output': {
        const output = this._resolveOutput(command.target);
        if (output === null) return 'move workspace to output: no such output';
        // Same reason as above: commit() returns void, so the outcome is captured in a local.
        let moved = false;
        this.commit(() => {
          const tree = this._tree;
          if (!tree) return false;
          const before = tree.visible.get(output);
          const result = tree.moveWorkspaceToOutput(output);
          if (!result) return false;
          // Whatever the target output was showing is now on no output's screen.
          if (before !== undefined) for (const id of this._workspaceMembers(tree, before))
            if (!this._ports.windows.moveToWorkspace(id, ATTIC_WORKSPACE))
              this._ports.log.warn(`could not park window ${id}; leaving it on screen`);
          for (const id of this._workspaceMembers(tree, tree.activeWorkspace))
            if (!this._ports.windows.moveToWorkspace(id, LIVE_WORKSPACE))
              this._ports.log.warn(`could not show window ${id}; leaving it parked`);
          this._activateSelection(timestamp);
          this._warpToFocusedOutput();
          moved = true;
          return true;
        });
        return moved ? 'move workspace to output' : 'move workspace to output: unchanged';
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
        // The warn lives inside the closure, not after this.commit() returns:
        // commit() queues rather than running a nested call synchronously
        // (see _applyRules), so a warn keyed on `changed` read right after
        // this.commit() would fire before the closure -- which may yet
        // succeed -- has even run. Inside the closure it fires only once the
        // outcome, whichever call site triggered it, is actually known.
        let changed = false;
        const reject = () => ports.log.warn('resize set applies only to a tracked floating window');
        this.commit(() => {
          const floating = this._floatingFrame(commandFrames);
          if (!floating) { reject(); return false; }
          changed = this._queueFloatingFrame(floating.id, {
            ...floating.info.rect, width: command.width, height: command.height,
          }, commandFrames);
          if (!changed) reject();
          return changed;
        });
        return changed ? 'resize set' : 'resize set: no floating window';
      }
      case 'move_position': {
        // See resize_set above: the warn is inside the closure so it reflects
        // the outcome at the time the closure actually runs, not a read of
        // `changed` taken before a queued (nested) closure has run.
        let changed = false;
        const reject = () => ports.log.warn('move position applies only to a tracked floating window');
        this.commit(() => {
          const floating = this._floatingFrame(commandFrames);
          if (!floating || !this._topology) { reject(); return false; }
          let position: {x: number; y: number};
          if (command.position === 'center') {
            const monitor = floating.info.monitor ?? this._topology.primary;
            const area = this._topology.workAreas.get(monitor);
            if (!area) { reject(); return false; }
            position = {
              x: area.x + Math.round((area.width - floating.info.rect.width) / 2),
              y: area.y + Math.round((area.height - floating.info.rect.height) / 2),
            };
          } else position = command.position;
          changed = this._queueFloatingFrame(floating.id, {...floating.info.rect, ...position}, commandFrames);
          if (!changed) reject();
          return changed;
        });
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
          this._manualFloating.set(id, enabled);
          tree.setFloating(id, enabled);
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
        // Every targeted leaf must land in the same commit: writing the map
        // directly and committing once keeps a container selection's border
        // change, its layout/decoration recompute and its revision bump
        // atomic, instead of N separate top-level commits (N-1 of them
        // publishing an inconsistent, half-updated plan).
        for (const target of targets) {
          const width = command.style === 'toggle'
            ? (this._borderOverrides.get(target.window) ?? this._config.defaultBorder.width) > 0
              ? 0 : this._config.defaultBorder.width
            : command.style === 'none' ? 0 : command.width;
          this._borderOverrides.set(target.window, width);
        }
        this.commit();
        return `border ${command.style}`;
      }
      case 'mode':
        return this._enterMode(command.name) ? `mode ${command.name}` : `mode "${command.name}" is not defined`;
      case 'launcher': {
        if (this._locked) return 'launcher: refused while the session is locked';
        const area = this._launcherArea();
        if (!area) {
          this._ports.log.warn('launcher: no work area yet; not opening');
          return 'launcher: not ready';
        }
        this._ports.launcher.open({area, term: command.term});
        return 'launcher';
      }
      case 'reload':
        this._ports.launcher.close();
        return this._applyLoaded(ports.loadConfig('reload')) ? 'reloaded' : 'reload: config rejected, keeping previous';
      case 'restart':
        // Same reason as `reload` above: this rebuilds the tree and the
        // bindings, and a modal grab that outlives that rebuild holds the
        // keyboard with nothing listening behind it.
        this._ports.launcher.close();
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
