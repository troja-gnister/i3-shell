/** In-memory Gio.Settings subset: no session bus, dconf or host schemas. */
export type SettingValue = string[] | string | boolean | number;
export const schemas = new Map<string, FakeSettings>();
export const writes: Array<{schema: string; key: string; value: SettingValue}> = [];
export let syncCalls = 0;

export function resetFakeSettings(): void {
  schemas.clear();
  writes.length = 0;
  syncCalls = 0;
}

function unpack(value: SettingValue): SettingValue {
  return structuredClone(value);
}

export class FakeSettings {
  readonly failures = new Map<string, 'false' | 'throw'>();
  readonly defaults: Record<string, SettingValue>;
  readonly userValues: Record<string, SettingValue> = {};

  constructor(readonly id: string, readonly values: Record<string, SettingValue>) {
    this.defaults = structuredClone(values);
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
  get_default_value(key: string) {
    return key in this.defaults ? {deep_unpack: () => unpack(this.defaults[key])} : null;
  }
  get_value(key: string) { return {deep_unpack: () => unpack(this.values[key])}; }
  get_user_value(key: string) {
    return key in this.userValues ? {deep_unpack: () => unpack(this.userValues[key])} : null;
  }
  set_strv(key: string, value: string[]): boolean { return this._set(key, value); }
  set_string(key: string, value: string): boolean { return this._set(key, value); }
  set_boolean(key: string, value: boolean): boolean { return this._set(key, value); }
  set_int(key: string, value: number): boolean { return this._set(key, value); }
  reset(key: string): void {
    const failure = this.failures.get(key);
    if (failure === 'throw')
      throw new Error(`cannot reset ${this.id} ${key}`);
    if (failure === 'false')
      return;
    this.values[key] = structuredClone(this.defaults[key]);
    delete this.userValues[key];
    writes.push({schema: this.id, key, value: structuredClone(this.values[key])});
  }

  private _set(key: string, value: SettingValue): boolean {
    const failure = this.failures.get(key);
    if (failure === 'throw')
      throw new Error(`cannot write ${this.id} ${key}`);
    if (failure === 'false')
      return false;
    this.values[key] = structuredClone(value);
    this.userValues[key] = structuredClone(value);
    writes.push({schema: this.id, key, value: structuredClone(value)});
    return true;
  }
}

export const fakeGio = {
  SettingsSchemaSource: {get_default: () => ({
    lookup: (id: string) => schemas.get(id)?.settings_schema ?? null,
  })},
  Settings: class {
    static sync(): void { syncCalls += 1; }
    constructor({settings_schema}: {settings_schema: {id: string}}) {
      const settings = schemas.get(settings_schema.id);
      if (!settings)
        throw new Error(`missing schema ${settings_schema.id}`);
      return settings;
    }
  },
};
