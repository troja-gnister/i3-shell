import type Gio from 'gi://Gio';
import {promote} from '../launcher/recency';
import type {RecencyStore} from './launcher';
import {log} from './log';

const LIMIT = 40;
const KEY = 'launcher-recency';

/**
 * Recency persisted in the extension's own schema.
 *
 * Every access is gated on the key existing. GSettings does not raise a
 * catchable error for a key the compiled schema does not have -- it calls
 * `g_error()`, which aborts the process, and the process here is gnome-shell.
 * The schema is compiled at install time from `schemas/`, so a stale
 * `gschemas.compiled` left by an older build (or an install that never ran
 * `glib-compile-schemas`) is enough, and the first `$mod+d` of the session is
 * exactly where it would land: the user's whole desktop would go down on the
 * keystroke that opens a launcher.
 */
export class SettingsRecency implements RecencyStore {
  private _warned = false;

  constructor(private readonly _settings: Gio.Settings) {}

  read(): string[] {
    if (!this._usable()) return [];
    return this._settings.get_strv(KEY);
  }

  record(id: string): void {
    if (!this._usable()) return;
    this._settings.set_strv(KEY, promote(this._settings.get_strv(KEY), id, LIMIT));
  }

  /** Whether the compiled schema behind these settings actually has the key. */
  private _usable(): boolean {
    let present = false;
    try {
      present = this._settings.settings_schema.has_key(KEY);
    } catch (error) {
      log.error(`launcher: could not inspect the ${KEY} schema key`, error);
    }
    if (!present && !this._warned) {
      this._warned = true;
      log.warn(`launcher: no ${KEY} key in the compiled schema; recency is off for this session`);
    }
    return present;
  }
}
