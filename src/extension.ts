import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import type {Command} from './commands/model';
import {DEFAULT_COLORS} from './config/model';
import type {Colors} from './config/model';
import {planOverrides} from './config/overridePlan';
import {Engine} from './engine';
import type {LoadedConfig} from './engine';
import type {PillState} from './runtime/model';
import {AppCatalogue} from './shell/appCatalogue';
import {MonitorBars} from './shell/bars';
import {ConfigLoader} from './shell/configLoader';
import {DBusControl, DebugObject} from './shell/control';
import {spawnShell} from './shell/exec';
import {ShellAccent} from './shell/accent';
import {Decorations} from './shell/decorations';
import {Indicator} from './shell/indicator';
import {KeyBinder} from './shell/keys';
import {Launcher} from './shell/launcher';
import type {RecencyStore} from './shell/launcher';
import {SettingsRecency} from './shell/recency';
import {log} from './shell/log';
import {notify} from './shell/notify';
import {measureRowHeight} from './shell/rowHeight';
import {SessionWatcher} from './shell/session';
import {SettingsOverrides} from './shell/settings';
import {ClosingGate, guard, SignalTracker} from './shell/util/signals';
import {ManagedWindows} from './shell/windows';
import {Geometry} from './shell/geometry';
import {Workspaces} from './shell/workspaces';

export default class I3ShellExtension extends Extension {
  private _tracker: SignalTracker | null = null;
  private _engine: Engine | null = null;
  private _keys: KeyBinder | null = null;
  private _indicator: Indicator | null = null;
  private _bars: MonitorBars | null = null;
  private _decorations: Decorations | null = null;
  private _accent: ShellAccent | null = null;
  private _dbus: DBusControl | null = null;
  private _windows: ManagedWindows | null = null;
  private _geometry: Geometry | null = null;
  private _catalogue: AppCatalogue | null = null;
  private _launcher: Launcher | null = null;
  private readonly _deferred = new Set<number>();

  enable(): void {
    try {
      this._enableInner();
    } catch (e) {
      log.error('enable failed; rolling back', e);
      this.disable();
      throw e;
    }
  }

  private _enableInner(): void {
    log.info('enable');
    const tracker = new SignalTracker();
    this._tracker = tracker;

    // GNOME tears its own windows and actors down underneath the extension
    // once the display reports closing, but the compositor signals below
    // keep firing regardless -- a full commit at that point can call
    // geometry on a window being destroyed or write to chrome the shell is
    // disposing. Every handler wired through `closing.unlessClosing` below
    // shares this one flag instead of guarding itself.
    //
    // ClosingGate alone only stops a handler's synchronous entry point: a
    // deferred frame-read queued before closing still resolves afterward
    // (engine.ts's 'frame' branch), and the accent subscription pushes
    // straight to the indicator/decorations ports outside any handler here
    // at all. Engine.onClosing() is the second, engine-level flag that
    // covers those -- see engine.ts's commit() and the accent.subscribe
    // callback in start().
    const closing = new ClosingGate();
    tracker.connect(global.display, 'closing', () => {
      closing.close();
      this._engine?.onClosing();
    });

    const settings: Gio.Settings = this.getSettings();
    const overrides = new SettingsOverrides(settings);
    const loader = new ConfigLoader(settings);
    const geometry = new Geometry(id => this._windows?.resolve(id));
    this._geometry = geometry;
    // Seed the stable monitor ids before any window is enumerated: ManagedWindows
    // resolves each window's monitor through geometry.monitorId(index), which is
    // empty until a topology has been read at least once.
    geometry.topology();
    const windows = new ManagedWindows(
      guard('window event', closing.unlessClosing(event => { this._engine?.onWindowEvent(event); })),
      index => geometry.monitorId(index));
    this._windows = windows;
    const workspaces = new Workspaces(tracker, closing.unlessClosing(() => this._engine?.onWorkspacesChanged()));

    const runNow = (command: Command): void => {
      this._engine?.run([command], global.get_current_time());
    };
    const activateWorkspace = (index: number): void => {
      runNow({type: 'workspace', target: {kind: 'number', number: index + 1, name: String(index + 1)}});
    };
    const indicator = new Indicator(DEFAULT_COLORS, activateWorkspace,
      direction => runNow({type: 'workspace', target: {kind: direction}}));
    this._indicator = indicator;
    // GNOME has exactly one panel and it lives on the primary monitor, so the
    // other monitors get their own copy of the same pills (spec 4.3).
    const bars = new MonitorBars(activateWorkspace);
    this._bars = bars;
    // The engine has one indicator port and two things that render it: every
    // call has to reach both, or the bars are built and stay blank forever.
    const chrome = {
      setMode: (name: string | null): void => { indicator.setMode(name); bars.setMode(name); },
      setColors: (colors: Colors): void => { indicator.setColors(colors); bars.setColors(colors); },
      setPills: (pills: PillState[]): void => { indicator.setPills(pills); bars.setPills(pills); },
      setVisible: (visible: boolean): void => { indicator.setVisible(visible); bars.setVisible(visible); },
    };

    const defer = (callback: () => void): number => {
      const token = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, guard('engine idle', () => {
        if (!this._deferred.delete(token)) return GLib.SOURCE_REMOVE;
        callback();
        return GLib.SOURCE_REMOVE;
      }));
      this._deferred.add(token);
      return token;
    };
    const decorations = new Decorations(DEFAULT_COLORS,
      // A tab click is a UI affordance, not an i3 command, so it goes straight
      // to the engine rather than through run(). A tab titles either one
      // window or a nested container, and the engine has a method for each.
      target => {
        if ('window' in target) this._engine?.focusWindow(target.window);
        else this._engine?.focusNode(target.node);
      },
      // WindowId is this extension's own counter, not Meta's: only the window
      // tracker can turn one back into a live window (see shell/decorations.ts).
      id => this._windows?.resolve(id),
      // Deferred so a click's own signal emission has returned before the
      // commit it triggers can destroy the button that is still emitting.
      callback => { defer(callback); });
    this._decorations = decorations;

    const catalogue = new AppCatalogue();
    this._catalogue = catalogue;
    const recency: RecencyStore = new SettingsRecency(settings);
    // The same `defer` the decorations use, and for the same reason: the
    // launcher closes itself out of signals Mutter is still emitting.
    const launcher = new Launcher(catalogue, recency, callback => { defer(callback); }, notify);
    this._launcher = launcher;

    const accent = new ShellAccent();
    this._accent = accent;

    const keys = new KeyBinder(tracker, (binding, timestamp) => this._engine?.onBinding(binding, timestamp));
    this._keys = keys;

    const engine = new Engine({
      keys,
      workspaces,
      windows,
      geometry,
      deferred: {
        defer,
        cancel: token => { if (this._deferred.delete(token)) GLib.source_remove(token); },
      },
      now: Date.now,
      indicator: chrome,
      settings: {
        apply: (config, workspaceCount) => { overrides.apply(planOverrides({...config, workspaceCount})); },
        restoreAll: () => overrides.restoreAll(),
      },
      accent,
      decorations,
      launcher,
      exec: spawnShell,
      notify,
      log,
      loadConfig: (mode): LoadedConfig => loader.load(mode),
    });
    this._engine = engine;

    const session = new SessionWatcher(tracker,
      closing.unlessClosing(() => { engine.onLocked(); }),
      closing.unlessClosing(() => { engine.onUnlocked(); indicator.hideActivities(); }));

    // Both handlers below run the same three steps in the same order --
    // re-measure the bars, re-measure the title row, then relayout -- because
    // both signals change the same two measurements and teaching two orders
    // for one job is how one of them ends up missing a step.
    //
    // The bars first: each one reserves a strut, so rebuilding them for the
    // new monitor set is what makes the work areas the engine then lays out
    // against correct -- and a bar left on a monitor that has gone away would
    // keep shrinking a work area that no longer exists. MonitorBars
    // re-measures whenever it renders, and a rebuild is its public way to be
    // told to: these signals are rare and a bar carries no state a rebuild
    // could lose.
    //
    // Then the title row. St scales every CSS pixel by the shell's scale
    // factor, and docking or undocking a display can change it, so a monitor
    // change re-measures the row for exactly the reason a font change does: a
    // stale row height either under-reports the band and clips the tabs, or
    // over-reports it and leaves a gap above the client. setRowHeight() is a
    // no-op when the number has not moved, so the common case costs nothing.
    const remeasure = (): void => {
      bars.monitorsChanged();
      engine.setRowHeight(measureRowHeight());
    };
    tracker.connect(Main.layoutManager, 'monitors-changed', closing.unlessClosing(() => {
      remeasure();
      engine.onMonitorsChanged();
    }));
    // A font change resizes a bar and a title row alike; nothing else about
    // the monitors moved, so there is no relayout to force beyond the one
    // setRowHeight() itself commits when the height actually changed.
    const stSettings = St.Settings.get();
    tracker.connect(stSettings, 'notify::font-name', closing.unlessClosing(remeasure));
    tracker.connect(global.display, 'workareas-changed', closing.unlessClosing(() => engine.relayout()));
    // Windows before the engine: start() enumerates the existing windows and
    // arms their first-frame watches, so engine.start() adopts them in its first
    // commit instead of one late arrival at a time.
    windows.start();
    // Before start(), so the very first commit already reserves the title rows
    // rather than laying every window out twice.
    engine.setRowHeight(measureRowHeight());
    engine.start(session.isLocked);
    // Off the critical path, and off the path that opens the launcher: the
    // first $PATH scan and the first read of every installed .desktop file
    // would otherwise both land on the keystroke the user is waiting on.
    defer(() => catalogue.prime());
    const debug = __I3SHELL_TEST__ ? new DebugObject(session, engine, launcher) : null;
    this._dbus = new DBusControl(engine, debug, notify);
    log.info(`ready: ${engine.state().grabbed} bindings grabbed, config from ${engine.lastLoad.source} (${engine.lastLoad.path})`);
  }

  disable(): void {
    log.info('disable');
    // First, before anything else can throw: an open launcher holds a modal
    // grab, and a grab left behind takes the keyboard away from the whole
    // session. close() releases it before it destroys the actor.
    this._launcher?.destroy();
    this._launcher = null;
    this._catalogue?.destroy();
    this._catalogue = null;
    this._dbus?.destroy();
    this._dbus = null;
    this._engine?.stop();
    this._engine = null;
    for (const token of this._deferred) GLib.source_remove(token);
    this._deferred.clear();
    this._windows?.destroy();
    this._windows = null;
    this._geometry?.destroy();
    this._geometry = null;
    this._keys?.destroy();
    this._keys = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._bars?.destroy();
    this._bars = null;
    this._decorations?.destroy();
    this._decorations = null;
    this._accent?.destroy();
    this._accent = null;
    this._tracker?.disconnectAll();
    this._tracker = null;
  }
}
