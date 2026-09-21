/** In-memory Gio.Settings subset: no session bus, dconf or host schemas. */
export type SettingValue = string[] | string | boolean | number;
export const schemas = new Map<string, FakeSettings>();
export const writes: Array<{schema: string; key: string; value: SettingValue}> = [];

export class FakeSettings {
  readonly failures = new Map<string, 'false' | 'throw'>();

  constructor(readonly id: string, readonly values: Record<string, SettingValue>) {
    schemas.set(id, this);
  }

  get settings_schema() {
    return {
      id: this.id,
      list_keys: () => Object.keys(this.values),
      get_key: (key: string) => ({get_value_type: () => ({dup_string: () => {
        const value = this.values[key];
        return Array.isArray(value) ? 'as' : typeof value === 'string' ? 's' : typeof value === 'boolean' ? 'b' : 'i';
      }})}),
    };
  }

  get_strv(key: string): string[] { return [...this.values[key] as string[]]; }
  get_string(key: string): string { return this.values[key] as string; }
  get_boolean(key: string): boolean { return this.values[key] as boolean; }
  get_int(key: string): number { return this.values[key] as number; }
  set_strv(key: string, value: string[]): boolean { return this._set(key, value); }
  set_string(key: string, value: string): boolean { return this._set(key, value); }
  set_boolean(key: string, value: boolean): boolean { return this._set(key, value); }
  set_int(key: string, value: number): boolean { return this._set(key, value); }

  private _set(key: string, value: SettingValue): boolean {
    const failure = this.failures.get(key);
    if (failure === 'throw')
      throw new Error(`cannot write ${this.id} ${key}`);
    if (failure === 'false')
      return false;
    this.values[key] = structuredClone(value);
    writes.push({schema: this.id, key, value: structuredClone(value)});
    return true;
  }
}

export const fakeGio = {
  SettingsSchemaSource: {get_default: () => ({
    lookup: (id: string) => schemas.get(id)?.settings_schema ?? null,
  })},
  Settings: class {
    constructor({settings_schema}: {settings_schema: {id: string}}) {
      const settings = schemas.get(settings_schema.id);
      if (!settings)
        throw new Error(`missing schema ${settings_schema.id}`);
      return settings;
    }
  },
};
