import {parseCommands} from '../commands/parse';
import type {Engine} from '../engine';

export interface ControlLog {
  error(message: string, error: unknown): void;
}

export interface ShellState {
  actionMode: number;
  ready: boolean;
}

/** GI-free D-Bus method bodies; native export and input synthesis stay in control.ts. */
export class ControlObject {
  constructor(
    private readonly _engine: Engine,
    private readonly _timestamp: () => number,
    private readonly _shellState: () => ShellState,
    private readonly _log: ControlLog,
  ) {}

  Command(command: string): [boolean, string] {
    try {
      const {commands, diagnostics} = parseCommands(command);
      if (diagnostics.length > 0)
        return [false, diagnostics.join('; ')];
      return [true, this._engine.run(commands, this._timestamp())];
    } catch (error) {
      this._log.error(`Command "${command}" failed`, error);
      return [false, String(error)];
    }
  }

  GetState(): string {
    try {
      const shell = this._shellState();
      return JSON.stringify({
        ...this._engine.state(),
        actionMode: shell.actionMode,
        ready: shell.ready && this._engine.treeSnapshot().ready,
      });
    } catch (error) {
      return this._jsonError('GetState', error);
    }
  }

  GetConfigStatus(): string {
    try {
      const loaded = this._engine.lastLoad;
      return JSON.stringify({
        path: loaded.path,
        source: loaded.source,
        loadTime: this._engine.lastLoadTime,
        errors: loaded.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length,
        warnings: loaded.diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length,
        diagnostics: loaded.diagnostics,
      });
    } catch (error) {
      return this._jsonError('GetConfigStatus', error);
    }
  }

  GetTree(): string {
    try {
      return JSON.stringify(this._engine.treeSnapshot());
    } catch (error) {
      return this._jsonError('GetTree', error);
    }
  }

  GetWindows(): string {
    try {
      return JSON.stringify(this._engine.windowsSnapshot());
    } catch (error) {
      return this._jsonError('GetWindows', error);
    }
  }

  private _jsonError(method: string, error: unknown): string {
    this._log.error(`${method} failed`, error);
    return JSON.stringify({error: String(error)});
  }
}
