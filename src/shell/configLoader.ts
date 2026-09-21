import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {loadConfigText} from '../config';
import {FALLBACK_CONFIG} from '../config/defaultConfig';
import type {LoadedConfig} from '../engine';
import {log} from './log';

function readText(path: string): string | null {
  try {
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function writeText(path: string, text: string): void {
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    Gio.File.new_for_path(path).replace_contents(
      new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
  } catch (e) {
    log.error(`cannot write ${path}`, e);
  }
}

/** Reads ~/.config/i3/config; on rejection falls back to the cached last-good config, then to the built-in one (§6.1). */
export class ConfigLoader {
  constructor(private readonly _settings: Gio.Settings) {}

  get path(): string {
    const override = this._settings.get_string('config-path');
    return override !== '' ? override : GLib.build_filenamev([GLib.get_user_config_dir(), 'i3', 'config']);
  }

  get cachePath(): string {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'i3-shell', 'last-good.config']);
  }

  load(mode: 'initial' | 'reload'): LoadedConfig {
    const path = this.path;
    const text = readText(path);

    if (text === null) {
      // On reload keep the running config: report the missing file as a rejection instead of
      // silently swapping in the built-in fallback while the engine is already serving a config.
      if (mode === 'reload') {
        return {
          config: null,
          diagnostics: [{line: 0, severity: 'error', message: `${path} not found`}],
          source: 'file',
          path,
        };
      }
      log.warn(`config ${path} not found; using the built-in fallback`);
      return {
        config: loadConfigText(FALLBACK_CONFIG).config,
        diagnostics: [{line: 0, severity: 'warning', message: `${path} not found`}],
        source: 'fallback',
        path,
      };
    }

    const result = loadConfigText(text);
    if (result.config) {
      writeText(this.cachePath, text);
      return {config: result.config, diagnostics: result.diagnostics, source: 'file', path};
    }

    // Rejected. On reload the engine keeps what is running; on initial load we need something usable.
    if (mode === 'reload')
      return {config: null, diagnostics: result.diagnostics, source: 'file', path};

    const cached = readText(this.cachePath);
    if (cached !== null) {
      const cachedResult = loadConfigText(cached);
      if (cachedResult.config) {
        log.warn(`config ${path} rejected; using the last good config from ${this.cachePath}`);
        return {config: cachedResult.config, diagnostics: result.diagnostics, source: 'cache', path};
      }
    }
    log.warn(`config ${path} rejected and no usable cached config; using the built-in fallback`);
    return {config: loadConfigText(FALLBACK_CONFIG).config, diagnostics: result.diagnostics, source: 'fallback', path};
  }
}
