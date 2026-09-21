import type Gio from 'gi://Gio';
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
import type {PillState} from './shell/indicator';
import {KeyBinder} from './shell/keys';
import {log} from './shell/log';
import {notify} from './shell/notify';
import {SessionWatcher} from './shell/session';
import {SettingsOverrides} from './shell/settings';
import {SignalTracker} from './shell/util/signals';
import {Windows} from './shell/windows';
import {Workspaces} from './shell/workspaces';

export default class I3ShellExtension extends Extension {
  private _tracker: SignalTracker | null = null;
  private _engine: Engine | null = null;
  private _keys: KeyBinder | null = null;
  private _indicator: Indicator | null = null;
  private _workspaces: Workspaces | null = null;
  private _dbus: DBusControl | null = null;
  private _overrides: SettingsOverrides | null = null;
  private _started = false;

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
    const windows = new Windows();
    this._overrides = overrides;
    const workspaces = new Workspaces(tracker, () => {
      this._enforceWorkspaceCount();
      this._refreshPills();
    });
    this._workspaces = workspaces;

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
      indicator,
      settings: {
        apply: config => { overrides.apply(planOverrides(config)); },
        restoreAll: () => overrides.restoreAll(),
      },
      exec: spawnShell,
      notify,
      log,
      loadConfig: (mode): LoadedConfig => loader.load(mode),
    });
    this._engine = engine;

    const session = new SessionWatcher(tracker,
      () => { engine.onLocked(); indicator.hide(); },
      () => { engine.onUnlocked(); indicator.show(); indicator.hideActivities(); });

    engine.start();
    this._started = true;
    this._refreshPills();
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
    this._keys?.destroy();
    this._keys = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._tracker?.disconnectAll();
    this._tracker = null;
    this._workspaces = null;
    this._overrides = null;
    this._started = false;
  }

  /** §9: if something else changed the workspace count, put the config's count back. */
  private _enforceWorkspaceCount(): void {
    const engine = this._engine;
    const workspaces = this._workspaces;
    const overrides = this._overrides;
    if (!this._started || !engine || !workspaces || !overrides)
      return;
    const wanted = engine.config.workspaceCount;
    if (wanted > 0 && workspaces.count !== wanted)
      overrides.apply(planOverrides(engine.config));
  }

  private _refreshPills(): void {
    const engine = this._engine;
    const indicator = this._indicator;
    const workspaces = this._workspaces;
    if (!this._started || !engine || !indicator || !workspaces)
      return;
    const names = engine.config.workspaceNames;
    const states: PillState[] = [];
    for (let i = 0; i < workspaces.count; i++) {
      states.push({
        name: names.get(i + 1) ?? String(i + 1),
        active: i === workspaces.activeIndex,
        occupied: workspaces.isOccupied(i),
      });
    }
    indicator.setWorkspaces(states);
  }
}
