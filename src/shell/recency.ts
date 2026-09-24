import type Gio from 'gi://Gio';
import {promote} from '../launcher/recency';
import type {RecencyStore} from './launcher';

const LIMIT = 40;
const KEY = 'launcher-recency';

/** Recency persisted in the extension's own schema. */
export class SettingsRecency implements RecencyStore {
  constructor(private readonly _settings: Gio.Settings) {}

  read(): string[] {
    return this._settings.get_strv(KEY);
  }

  record(id: string): void {
    this._settings.set_strv(KEY, promote(this.read(), id, LIMIT));
  }
}
