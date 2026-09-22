import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import type {Command} from './commands/model';
import {DEFAULT_COLORS} from './config/model';
import {planOverrides} from './config/overridePlan';
import {Engine} from './engine';
import type {LoadedConfig} from './engine';
import {ConfigLoader} from './shell/configLoader';
import {DBusControl, DebugObject} from './shell/control';
import {spawnShell} from './shell/exec';
import {Indicator} from './shell/indicator';
import {KeyBinder} from './shell/keys';
import {log} from './shell/log';
import {notify} from './shell/notify';
import {SessionWatcher} from './shell/session';
import {SettingsOverrides} from './shell/settings';
import {guard, SignalTracker} from './shell/util/signals';
import {ManagedWindows} from './shell/windows';
import {Geometry} from './shell/geometry';
import {Workspaces} from './shell/workspaces';

export default class I3ShellExtension extends Extension {
  private _tracker: SignalTracker | null = null;
  private _engine: Engine | null = null;
  private _keys: KeyBinder | null = null;
  private _indicator: Indicator | null = null;
  private _dbus: DBusControl | null = null;
  private _windows: ManagedWindows | null = null;
  private _geometry: Geometry | null = null;
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

    const settings: Gio.Settings = this.getSettings();
    const overrides = new SettingsOverrides(settings);
    const loader = new ConfigLoader(settings);
    const geometry = new Geometry(id => this._windows?.resolve(id));
    this._geometry = geometry;
    geometry.topology();
    const windows = new ManagedWindows(event => this._engine?.onWindowEvent(event), index => geometry.monitorId(index));
    this._windows = windows;
    const workspaces = new Workspaces(tracker, () => this._engine?.onWorkspacesChanged());

    const runNow = (command: Command): void => {
      this._engine?.run([command], global.get_current_time());
    };
    const indicator = new Indicator(DEFAULT_COLORS,
      index => runNow({type: 'workspace', target: {kind: 'number', number: index + 1, name: String(index + 1)}}),
      direction => runNow({type: 'workspace', target: {kind: direction}}));
    this._indicator = indicator;

    const keys = new KeyBinder(tracker, (binding, timestamp) => this._engine?.onBinding(binding, timestamp));
    this._keys = keys;

    const engine = new Engine({
      keys,
      workspaces,
      windows,
      geometry,
      deferred: {
        defer: callback => {
          const token = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, guard('engine idle', () => {
            if (!this._deferred.delete(token)) return GLib.SOURCE_REMOVE;
            callback();
            return GLib.SOURCE_REMOVE;
          }));
          this._deferred.add(token);
          return token;
        },
        cancel: token => { if (this._deferred.delete(token)) GLib.source_remove(token); },
      },
      now: Date.now,
      indicator,
      settings: {
        apply: (config, workspaceCount) => { overrides.apply(planOverrides({...config, workspaceCount})); },
        restoreAll: () => overrides.restoreAll(),
      },
      exec: spawnShell,
      notify,
      log,
      loadConfig: (mode): LoadedConfig => loader.load(mode),
    });
    this._engine = engine;

    const session = new SessionWatcher(tracker,
      () => { engine.onLocked(); },
      () => { engine.onUnlocked(); indicator.hideActivities(); });

    tracker.connect(Main.layoutManager, 'monitors-changed', () => engine.onMonitorsChanged());
    tracker.connect(global.display, 'workareas-changed', () => engine.relayout());
    windows.start();
    engine.start(session.isLocked);
    const debug = __I3SHELL_TEST__ ? new DebugObject(session) : null;
    this._dbus = new DBusControl(engine, debug);
    log.info(`ready: ${engine.state().grabbed} bindings grabbed, config from ${engine.lastLoad.source} (${engine.lastLoad.path})`);
  }

  disable(): void {
    log.info('disable');
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
    this._tracker?.disconnectAll();
    this._tracker = null;
  }
}
