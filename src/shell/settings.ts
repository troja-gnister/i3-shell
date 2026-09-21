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
        const keep = current.filter(a => a === '' || !wanted.has(canonicalAccel(a)));
        if (keep.length === current.length)
          continue;
        this._remember(schemaId, key, type === 'as' ? current : current[0]);
        for (const a of current) {
          if (a !== '' && wanted.has(canonicalAccel(a)))
            cleared.push({schema: schemaId, key, accel: a});
        }
        if (type === 'as')
          settings.set_strv(key, keep);
        else
          settings.set_string(key, keep[0] ?? '');
      }
    }

    if (plan.workspaceCount > 0) {
      const mutter = this._settings(MUTTER);
      if (mutter) {
        this._remember(MUTTER, 'dynamic-workspaces', mutter.get_boolean('dynamic-workspaces'));
        mutter.set_boolean('dynamic-workspaces', false);
      }
      const prefs = this._settings(WM_PREFS);
      if (prefs) {
        this._remember(WM_PREFS, 'num-workspaces', prefs.get_int('num-workspaces'));
        prefs.set_int('num-workspaces', plan.workspaceCount);
        this._remember(WM_PREFS, 'workspace-names', prefs.get_strv('workspace-names'));
        prefs.set_strv('workspace-names', plan.workspaceNames);
      }
    }

    const prefs = this._settings(WM_PREFS);
    if (prefs && prefs.get_string('mouse-button-modifier') !== plan.mouseButtonModifier) {
      this._remember(WM_PREFS, 'mouse-button-modifier', prefs.get_string('mouse-button-modifier'));
      prefs.set_string('mouse-button-modifier', plan.mouseButtonModifier);
    }

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
        try {
          let restored: boolean;
          if (Array.isArray(value))
            restored = settings.set_strv(key, value);
          else if (typeof value === 'string')
            restored = settings.set_string(key, value);
          else if (typeof value === 'boolean')
            restored = settings.set_boolean(key, value);
          else
            restored = settings.set_int(key, value);
          if (restored)
            delete keys[key];
          else
            log.warn(`could not restore ${schemaId} ${key}; original kept for retry`);
        } catch (e) {
          log.error(`could not restore ${schemaId} ${key}`, e);
        }
      }
      if (Object.keys(keys).length === 0)
        delete this._snapshot[schemaId];
    }
    this._saveSnapshot();
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
