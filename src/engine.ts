import {parseCommands} from './commands/parse';
import type {Command, WorkspaceTarget} from './commands/model';
import type {Binding, Colors, Config, Diagnostic} from './config/model';

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
  windows: {
    killFocused(timestamp: number): boolean;
    fullscreenFocused(action: 'toggle' | 'enable' | 'disable'): boolean;
    moveFocusedToWorkspace(index: number): boolean;
  };
  settings: {
    apply(config: Config): void;
    restoreAll(): void;
  };
  indicator: {
    setMode(name: string | null): void;
    setColors(colors: Colors): void;
  };
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
}

export class Engine {
  private _config!: Config;
  private _loaded!: LoadedConfig;
  private _mode = 'default';
  private _locked = false;

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

  start(): void {
    const loaded = this._ports.loadConfig('initial');
    if (!loaded.config)
      throw new Error('loadConfig("initial") must always provide a config');
    this._applyLoaded(loaded);
  }

  stop(): void {
    this._ports.keys.ungrabAll();
    this._ports.settings.restoreAll();
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
    const messages = commands.map(c => this._runOne(c, timestamp)).filter(m => m !== '');
    return messages.length > 0 ? messages.join('; ') : 'ok';
  }

  onLocked(): void {
    this._locked = true;
    this._enterMode('default');
    this._ports.keys.ungrabAll();
  }

  onUnlocked(): void {
    this._locked = false;
    this._ports.keys.setBindings(this._modeBindings('default'));
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

    this._loaded = loaded;
    this._config = loaded.config;
    this._ports.settings.restoreAll();
    this._ports.settings.apply(this._config);
    this._mode = 'default';
    if (!this._locked) {
      const report = this._ports.keys.setBindings(this._modeBindings('default'));
      if (report.failed.length > 0)
        this._ports.log.warn(`${report.failed.length} binding(s) could not be grabbed yet; retrying once`);
    }
    this._ports.indicator.setMode(null);
    this._ports.indicator.setColors(this._config.colors);

    if (warnings.length > 0)
      this._ports.notify('i3-shell', `${warnings.length} config warning(s) — see the shell log`);
    if (this._config.rules.length > 0)
      this._ports.log.info(`${this._config.rules.length} for_window rule(s) parsed; they are applied from Phase 4`);
    if (loaded.source === 'cache')
      this._ports.notify('i3-shell', 'using the last good config (the current file was rejected)');
    else if (loaded.source === 'fallback')
      this._ports.notify('i3-shell', 'using the built-in fallback config');
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

  private _runOne(command: Command, timestamp: number): string {
    const ports = this._ports;
    switch (command.type) {
      case 'exec':
        ports.exec(command.command);
        return `exec ${command.command}`;
      case 'kill':
        return ports.windows.killFocused(timestamp) ? 'kill' : 'kill: no focused window';
      case 'fullscreen':
        return ports.windows.fullscreenFocused(command.action) ? `fullscreen ${command.action}` : 'fullscreen: no focused window';
      case 'workspace': {
        if (command.target.kind === 'back_and_forth')
          return 'workspace back_and_forth: not implemented until Phase 4';
        const index = this._workspaceIndex(command.target);
        if (index === null)
          return 'workspace: no such workspace';
        if (index === ports.workspaces.activeIndex)
          return 'workspace: already active';
        ports.workspaces.activate(index, timestamp);
        return `workspace ${index + 1}`;
      }
      case 'move_to_workspace': {
        if (command.target.kind === 'back_and_forth')
          return 'move container to workspace back_and_forth: not implemented until Phase 4';
        const index = this._workspaceIndex(command.target);
        if (index === null)
          return 'move container to workspace: no such workspace';
        if (index === ports.workspaces.activeIndex)
          return 'move container to workspace: already there';
        return ports.windows.moveFocusedToWorkspace(index) ? `moved to workspace ${index + 1}` : 'move container to workspace: no focused window';
      }
      case 'mode':
        return this._enterMode(command.name) ? `mode ${command.name}` : `mode "${command.name}" is not defined`;
      case 'reload':
        return this._applyLoaded(ports.loadConfig('reload')) ? 'reloaded' : 'reload: config rejected, keeping previous';
      case 'restart':
        // Phase 2 adds the tree rebuild (§6.6); until then restart == reload.
        return this._applyLoaded(ports.loadConfig('reload')) ? 'restarted' : 'restart: config rejected, keeping previous';
      case 'nop':
        return 'nop';
      case 'unknown':
        ports.log.warn(`unknown command: ${command.text}`);
        return `unknown command: ${command.text}`;
      default:
        ports.log.info(`${command.type}: not implemented in Phase 1 (tiling arrives in Phase 2)`);
        return `${command.type}: not implemented yet`;
    }
  }
}
