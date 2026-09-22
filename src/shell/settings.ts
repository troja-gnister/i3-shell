import Gio from 'gi://Gio';
import {canonicalAccel} from '../config/accel';
import type {OverridePlan} from '../config/overridePlan';
import {log} from './log';

const KEYBINDING_SCHEMAS = [
  'org.gnome.desktop.wm.keybindings',
  'org.gnome.shell.keybindings',
  'org.gnome.mutter.keybindings',
  'org.gnome.mutter.wayland.keybindings',
  'org.gnome.settings-daemon.plugins.media-keys',
];
const WM_PREFS = 'org.gnome.desktop.wm.preferences';
const MUTTER = 'org.gnome.mutter';

type Saved = string[] | string | boolean | number;
/** {schemaId: {key: originalValue}} — persisted as JSON in the extension's `overridden-settings` key. */
type Snapshot = Record<string, Record<string, Saved>>;

export interface ClearedBinding {
  schema: string;
  key: string;
  accel: string;
}

export interface SettingsPort {
  apply(plan: OverridePlan): ClearedBinding[];
  restoreAll(): void;
}

export class SettingsOverrides implements SettingsPort {
  private _snapshot: Snapshot;
  private readonly _open = new Map<string, Gio.Settings | null>();

  constructor(private readonly _extensionSettings: Gio.Settings) {
    this._snapshot = this._loadSnapshot();
  }

  /** Clears colliding GNOME accelerators and applies workspace/mouse settings; returns what was cleared. */
  apply(plan: OverridePlan): ClearedBinding[] {
    const wanted = new Set(plan.accels.map(canonicalAccel));
    const cleared: ClearedBinding[] = [];

    for (const schemaId of KEYBINDING_SCHEMAS) {
      const settings = this._settings(schemaId);
      if (!settings)
        continue;
      const schema = settings.settings_schema;
      for (const key of schema.list_keys()) {
        const type = schema.get_key(key).get_value_type().dup_string();
        if (type !== 'as' && type !== 's')
          continue;
        const current = type === 'as' ? settings.get_strv(key) : [settings.get_string(key)];
        const saved = this._snapshot[schemaId]?.[key];
        const original = saved === undefined ? current : Array.isArray(saved) ? saved : [saved as string];
        const keep = original.filter(a => a === '' || !wanted.has(canonicalAccel(a)));
        if (keep.length === original.length) {
          if (saved !== undefined)
            this._restoreOne(schemaId, settings, key, saved);
          continue;
        }
        this._remember(schemaId, key, type === 'as' ? original : original[0]);
        for (const a of original) {
          if (a !== '' && wanted.has(canonicalAccel(a)))
            cleared.push({schema: schemaId, key, accel: a});
        }
        const desired = type === 'as' ? keep : keep[0] ?? '';
        if (!this._equal(type === 'as' ? current : current[0], desired)) {
          if (type === 'as')
            settings.set_strv(key, keep);
          else
            settings.set_string(key, desired as string);
        }
      }
    }

    if (plan.workspaceCount > 0) {
      const mutter = this._settings(MUTTER);
      if (mutter)
        this._applyValue(MUTTER, mutter, 'dynamic-workspaces', false);
      const prefs = this._settings(WM_PREFS);
      if (prefs) {
        this._applyValue(WM_PREFS, prefs, 'num-workspaces', plan.workspaceCount);
        this._applyValue(WM_PREFS, prefs, 'workspace-names', plan.workspaceNames);
      }
    } else {
      this._restoreSaved(MUTTER, 'dynamic-workspaces');
      this._restoreSaved(WM_PREFS, 'num-workspaces');
      this._restoreSaved(WM_PREFS, 'workspace-names');
    }

    const prefs = this._settings(WM_PREFS);
    if (prefs)
      this._applyValue(WM_PREFS, prefs, 'mouse-button-modifier', plan.mouseButtonModifier);

    this._saveSnapshot();
    for (const c of cleared)
      log.info(`cleared GNOME binding ${c.schema} ${c.key} = ${c.accel}`);
    return cleared;
  }

  /** Restores saved values; keeps failed or unavailable entries persisted for a later retry. */
  restoreAll(): void {
    for (const [schemaId, keys] of Object.entries(this._snapshot)) {
      const settings = this._settings(schemaId);
      if (!settings)
        continue;
      for (const [key, value] of Object.entries(keys)) {
        this._restoreOne(schemaId, settings, key, value);
      }
      if (Object.keys(keys).length === 0)
        delete this._snapshot[schemaId];
    }
    this._saveSnapshot();
    Gio.Settings.sync();
  }

  private _applyValue(schemaId: string, settings: Gio.Settings, key: string, desired: Saved): void {
    const current = settings.get_value(key).deep_unpack() as Saved;
    const saved = this._snapshot[schemaId]?.[key];
    if (saved !== undefined && this._equal(saved, desired)) {
      this._restoreOne(schemaId, settings, key, saved);
      return;
    }
    if (this._equal(current, desired))
      return;
    this._remember(schemaId, key, current);
    this._set(settings, key, desired);
  }

  private _restoreSaved(schemaId: string, key: string): void {
    const saved = this._snapshot[schemaId]?.[key];
    if (saved === undefined)
      return;
    const settings = this._settings(schemaId);
    if (settings)
      this._restoreOne(schemaId, settings, key, saved);
  }

  private _restoreOne(schemaId: string, settings: Gio.Settings, key: string, value: Saved): void {
    try {
      const defaultValue = settings.get_default_value(key)?.deep_unpack() as Saved | undefined;
      let restored: boolean;
      if (defaultValue !== undefined && this._equal(defaultValue, value)) {
        settings.reset(key);
        restored = settings.get_user_value(key) === null &&
          this._equal(settings.get_value(key).deep_unpack() as Saved, value);
      } else {
        restored = this._set(settings, key, value);
      }
      if (restored)
        delete this._snapshot[schemaId][key];
      else
        log.warn(`could not restore ${schemaId} ${key}; original kept for retry`);
    } catch (e) {
      log.error(`could not restore ${schemaId} ${key}`, e);
    }
    if (Object.keys(this._snapshot[schemaId] ?? {}).length === 0)
      delete this._snapshot[schemaId];
  }

  private _set(settings: Gio.Settings, key: string, value: Saved): boolean {
    if (Array.isArray(value))
      return settings.set_strv(key, value);
    if (typeof value === 'string')
      return settings.set_string(key, value);
    if (typeof value === 'boolean')
      return settings.set_boolean(key, value);
    return settings.set_int(key, value);
  }

  private _equal(left: Saved, right: Saved): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private _settings(schemaId: string): Gio.Settings | null {
    if (this._open.has(schemaId))
      return this._open.get(schemaId) ?? null;
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true) ?? null;
    const settings = schema ? new Gio.Settings({settings_schema: schema}) : null;
    if (!settings)
      log.warn(`schema ${schemaId} is not installed; skipping`);
    this._open.set(schemaId, settings);
    return settings;
  }

  /**
   * Records the original value once and persists it before the live setting is changed,
   * so a crash mid-apply cannot lose it. A value already in the snapshot (crash recovery)
   * is never overwritten.
   */
  private _remember(schemaId: string, key: string, value: Saved): void {
    const bucket = (this._snapshot[schemaId] ??= {});
    if (key in bucket)
      return;
    bucket[key] = value;
    this._saveSnapshot();
  }

  private _loadSnapshot(): Snapshot {
    try {
      const parsed: unknown = JSON.parse(this._extensionSettings.get_string('overridden-settings'));
      return parsed !== null && typeof parsed === 'object' ? parsed as Snapshot : {};
    } catch {
      return {};
    }
  }

  private _saveSnapshot(): void {
    this._extensionSettings.set_string('overridden-settings', JSON.stringify(this._snapshot));
  }
}
